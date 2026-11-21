import { loadLocale, localized } from '../shared/localization'
import { prepareStart } from './connect'
import { ConnectionControl } from './connection-control'
import { confirmRuntimeChange } from './restart-consent'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, powerMonitor, screen, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import type { Notice, Profile, Snapshot, Status } from '../shared/types'
import { compilePlan, requiresCore } from '../shared/plan'
import { profileCountry } from '../shared/atlas'
import { sameEffectiveRouting } from '../shared/routing-edit'
import { ConfError, createWireGuardProfile, parseConf, usedProfiles, validateCustom, withoutAuto } from './awg'
import { fetchSubscription, isSubscriptionUrl, looksLikeVless, type PinnedHttpGet } from './vless'
import { describeExe, scanApps, trayImage } from './apps'
import { directProbe, icmp } from './offline'
import { Checker } from './checker'
import { checkedPatch, importRequest, MAX_IMPORT_BYTES, probeTarget, profileName, settingsPatchCurrent } from './validate'
import { linksInContainer, parseAny } from './links'
import { Catalog, fetchCatalogSources } from './catalog'
import { preparePublicCandidate, publicCandidateHasPinnedEndpoints } from './catalog-endpoint'
import { publicServicePaths, recoverPublicSources, type PublicServicePath } from './public-recovery'
import { publicServiceTransport } from './public-service-transport'
import { PublicPathCleanupError, withPublicServicePath } from './public-service-path'
import { credentialKey, Discovery } from './discovery'
import { looksLikeOpenVpn, parseOpenVpn } from './openvpn'
import { Health } from './health'
import { Engine } from './engine'
import { peekClip } from './clip'
import { adapters, adapterInspectionNotice, conflicts } from './guard'
import { createAdminCheck, POWERSHELL } from './ps'
import { Store } from './store'
import { dropServer } from './store-core'
import { startBridge } from './bridge'
import { createApply, selectVia, type ApplyResult } from './apply'
import { defaultRoutes, TUN, tunPreflight, tunSnapshot, untilCancelled } from './tun'
import { isIP } from 'node:net'
import { LogFile } from './logfile'
import { configOf, diagnosticsOf } from './techview'
import { LastSessionEvidence, clearDiagnosticEvidence, lastTransferEvidence, readSavedPayloadReport } from './last-session'
import { Lists } from './lists'
import { setListResolver } from './awg'
import { activeTune, applyTune, profileSig, provenTune, pruneTunes, tuned, variants, type TuneResult, type Tunes } from './tune'
import { dedupeApps } from '../shared/appmatch'
import { bounded } from './stop'
import { createResume, underlayReady } from './resume'
import { scanScreenQr } from './qr'
import { stableEngine, verifyEngine } from './integrity'
import { reconcileSubscription, subscriptionEntryKey } from './subscription'
import { trayPresentation } from './tray-view'
import { confirmedRoutes, moodOf } from '../shared/effective'
import { bridgeStatus, companionEditsOk, companionPatchSafe, createPending, ensureIntent, listCompanion, parseTarget, routeFor, routeOf, safeVia, sameTarget } from '../shared/companion'
import { companionSafetyMessage } from './companion-view'
import { AUTO_BUDGET, AUTO_ID, autoMembers, checkSample } from '../shared/groups'
import { classify } from '../shared/evidence'
import { parseProbe, probeLayers } from './layered'
import { activeIds, diagnosisSet, learn, type NetMemory } from '../shared/netmemory'
import { loadMem, saveMem } from './netmem-store'
import { networkFingerprint } from './netid'
import { DiagnosisRequests, diagnosisCurrent, diagnosisPaths, diagnosisProof, diagnosisRequestScope, diagnosisSettings, type DiagnosisProof } from './diagnosis'
import { diagnosisTarget } from './diagnosis-target'
import { assessConnection, connectionUse, summarizeChecks, summarizedPaths, type DiagnosisResult, type DiagnosisScope } from '../shared/connection-quality'
import { checkPayload, verifyDownload } from './payload-check'
import { proxyRequest, transferUrl } from './proxy-http'
import { serviceTransport } from './service-transport'
import { PAYLOAD_DOWNLOAD, type PayloadReport, type PayloadReply } from '../shared/payload'
import { protectPrivateFile } from './private-file'
import { SerialGate } from './serial'
import { RuntimeRecovery } from './runtime-recovery'
import { relaunchArgs, relaunchParent, waitForRelaunchParent } from './relaunch'

// Ordinary launches acquire the lock immediately. An elevated replacement waits
// for its parent first; the old app keeps the lock throughout the UAC prompt and
// cleanup, so a third ordinary launch cannot enter the shared state in between.
let waitingForParent = false
try { waitingForParent = relaunchParent(process.argv) !== undefined } catch { app.exit(1) }
if (!waitingForParent && !app.requestSingleInstanceLock()) app.exit(0)

app.setAppUserModelId('local.waarp')

let win: BrowserWindow | undefined
let showPending = false
let checker: Checker | undefined
let catalog: Catalog | undefined
const catalogAutoRequests = new Map<string, symbol>()
let discovery: Discovery | undefined
let discoveryBusy = false
let tray: Tray | undefined
let quitting = false
let admin = false
let adminReady: Promise<boolean> = Promise.resolve(false)
const checkAdmin = createAdminCheck()
/** Explicit user actions during first paint supersede the saved auto-connect preference. */
let connectionAction = 0
let notices: Notice[] = []
let bridgeError = false
let engineIntegrity = false
let publicCleanupBlocked = false
let relaunching = false
let bridgeServer: ReturnType<typeof startBridge> | undefined
const qrImports = new Map<string, { text: string; expires: number }>()
/** Settings/routing intent crosses renderer IPC and the local companion bridge. Keep those mutations FIFO across awaits. */
const intentWrites = new SerialGate()

let engineExe = app.isPackaged
  ? join(process.resourcesPath, 'engine', 'sing-box.exe')
  : join(app.getAppPath(), 'engine', 'sing-box.exe')

let store: Store
let engine: Engine

const runtimeRecovery = new RuntimeRecovery({
  ready: () => !!engine && engine.recoveryReady && !publicCleanupBlocked,
  recover: recoverRuntimes,
  changed: () => { send('status', statusView(engine.status)); updateTray() }
})

const demandsTunnel = requiresCore

function writeError(): string | undefined {
  if (store.canSave()) return undefined
  void refreshNotices()
  return store.unreadable ? localized("winInline.index.ae1a713bfc53") : localized("winInline.index.1f98275fc2dd")
}

async function chooseConfig(): Promise<{ text: string; name: string } | { error: string } | null> {
  const chosen = await dialog.showOpenDialog(win!, { title: localized("winInline.index.daef869262d5"), filters: [{ name: localized("winInline.index.de997c6bad2d"), extensions: ['conf', 'ovpn', 'txt', 'vpn', 'json', 'yaml', 'yml'] }], properties: ['openFile'] })
  if (chosen.canceled || !chosen.filePaths[0]) return null
  const path = chosen.filePaths[0]
  const fs = await import('node:fs')
  try {
    const fd = fs.openSync(path, 'r')
    try {
      if (fs.fstatSync(fd).size > MAX_IMPORT_BYTES) return { error: localized("winInline.index.823ac3d84734") }
      const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1)
      let used = 0
      while (used < buffer.length) {
        const n = fs.readSync(fd, buffer, used, buffer.length - used, used)
        if (!n) break
        used += n
      }
      if (used > MAX_IMPORT_BYTES) return { error: localized("winInline.index.823ac3d84734") }
      return { text: buffer.toString('utf8', 0, used), name: basename(path).replace(/\.(conf|ovpn|txt|vpn|json|ya?ml)$/i, '') }
    } finally { fs.closeSync(fd) }
  } catch { return { error: localized("winInline.index.739330009034") } }
}

function snapshot(): Snapshot {
  const byId = new Map(store.profiles.map(p => [p.id, p]))
  return { admin, profiles: store.views().map(v => {
    const p = byId.get(v.id)
    const t = p && engine.status.phase === 'on' && runtimeTuneIds.has(v.id) && activeTune(p, tunes[v.id], netCache && Date.now() - netCache.at < 60_000 ? netCache.net : undefined, Date.now())
    return { ...v, ...(tunes[v.id] ? { tuneStored: true } : {}), ...(t ? { tune: t.label } : {}) }
  }), settings: store.settings, status: statusView(engine.status), notices, lists: lists?.views() ?? [] }
}

/** HOTFIX-RUNTIME-01 E: the master switch's intent, owned here. Only the master (and a hard block / quit) changes it;
 *  card toggles only decide whether the core is needed right now. */
const master = new ConnectionControl({
  phase: () => engine.status.phase,
  error: () => engine.status.error,
  demandsTunnel: () => demandsTunnel(store.settings),
  prepare: prepareConnection,
  start: async (current, began) => {
    const profiles = await runtimeProfiles()
    // Network-dependent tuning reads may finish after the owner's OFF. Check
    // again before enqueueing a native start (whose cancellation token is new).
    if (current() && !quitting) {
      await engine.start(profiles, store.settings, current, began)
    }
  },
  stop: () => engine.stop(),
  serial: work => intentWrites.run(work),
  changed: () => { void cancelDiagnosis(); void cancelPayloadCheck(); cancelServiceDownload(); send('status', statusView(engine.status)); updateTray() }
})
const setMaster = (open: boolean) => master.set(open)

/** Native, explicit confirmation for edits that would recreate TUN. Invisible
 * automation and external companions cannot approve a restart. */
async function confirmTunRestart(reason: string): Promise<boolean> {
  if (!win || win.isDestroyed() || !win.isVisible() || !master.open) return false
  const ownerWindow = win
  return confirmRuntimeChange(
    () => ({ open: master.open && !quitting, revision: master.revision, phase: engine.status.phase, session: engine.sessionToken }),
    async ({ phase }) => {
      const restarting = phase === 'on'
      const result = await dialog.showMessageBox(ownerWindow, {
        type: 'warning',
        title: restarting ? localized("winInline.index.b59866ac4edf") : localized("winInline.index.316f9655cc8a"),
        message: restarting ? localized("winInline.index.59fd9eeb629f") : localized("winInline.index.11ade50f329b"),
        detail: reason + (restarting
          ? localized("winInline.index.d11479dcb548")
          : localized("winInline.index.9c0f7107c27c")),
        buttons: [localized("winInline.index.a849bd3d4896"), restarting ? localized("winInline.index.d3021f5850a2") : localized("winInline.index.cffd9bfb6b53")],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return result.response === 1
    }
  )
}
/** After an approved profile/tuning edit, bind all remaining preflight reads to
 * this exact session. A deliberate profile stop consumes the original approval. */
function reconnectEditedSession(revision: number, restart = false) {
  const session = engine.sessionToken, phase = engine.status.phase
  if (phase !== 'on' && phase !== 'off') return Promise.resolve({ ok: false, error: localized("winInline.index.a9eb237a0b6e") })
  return master.reconnect(revision, { restart, retainCore: true, preserveIntent: true,
    beforeStart: () => engine.sessionToken === session && engine.status.phase === phase })
}
const statusView = (s: Status) => ({ ...withRoutes(s), open: master.open, startup: runtimeRecovery.state })
async function pauseMeasurements(): Promise<boolean> {
  void cancelDiagnosis()
  void cancelPayloadCheck()
  cancelServiceDownload()
  const stopped = await Promise.all([checker?.stop() ?? true, catalog?.pause() ?? true])
  return stopped.every(Boolean)
}

/** Called inside the intent queue, with the recovery gate preventing new measurement processes. */
async function recoverRuntimes(): Promise<boolean> {
  if (quitting) return false
  const [measurementStop, engineStop] = await Promise.allSettled([pauseMeasurements(), engine.stop()])
  const measurementsStopped = measurementStop.status === 'fulfilled' && measurementStop.value
  const engineStopped = engineStop.status === 'fulfilled' && engineStop.value
  if (quitting) return false
  const [checkerResult, catalogResult] = await Promise.allSettled([checker?.recover() ?? true, catalog?.recover() ?? true])
  if (quitting) return false
  const checkerRecovered = checkerResult.status === 'fulfilled' && checkerResult.value
  const catalogRecovered = catalogResult.status === 'fulfilled' && catalogResult.value
  // A verified journal recovery can finish a checker that did not exit within the initial stop budget.
  const stopped = measurementsStopped || (checkerRecovered && catalogRecovered && await pauseMeasurements().catch(() => false))
  const relatedError = !checkerRecovered
    ? localized("winInline.index.d4a2107f0a26", checker?.recoveryError ?? localized("winInline.index.d0d2174e03bf"))
    : !catalogRecovered
      ? localized("winInline.index.c6d56cea2aca", catalog?.recoveryError ?? localized("winInline.index.d0d2174e03bf"))
      : !stopped ? localized("winInline.index.39223a0a9dcd")
        : !engineStopped ? localized("winInline.index.dd2c69e219a7") : undefined
  const recovered = await engine.killOrphans(stopped && engineStopped && checkerRecovered && catalogRecovered, relatedError)
  if (recovered) publicCleanupBlocked = false
  return recovered
}

async function prepareConnection(current: () => boolean = () => true) {
  admin = await (adminReady = checkAdmin())
  if (!current() || quitting) return { ok: false as const, error: localized("winInline.index.e1c831ec971a") }
  const stopped = await pauseMeasurements()
  if (!current() || quitting) return { ok: false as const, error: localized("winInline.index.e1c831ec971a") }
  // A failed checker stop/recovery gate cannot dismantle a healthy TUN during
  // an edit's preflight. The user can explicitly disconnect and recover it.
  if (engine.status.phase === 'on' && (!stopped || !runtimeRecovery.ready))
    return { ok: false as const, error: localized("winInline.index.4e1913b158cd") }
  // A later failed lease or stuck checker must not poison all future ON attempts for this app session.
  if (!(await runtimeRecovery.ensure(!stopped))) return { ok: false as const, error: engine.status.error ?? localized("winInline.index.085ae51ed5b8") }
  if (!current() || quitting) return { ok: false as const, error: localized("winInline.index.e1c831ec971a") }
  return prepareStart({ stopChecker: async () => true, notices: () => refreshNotices(true) })
}

function send(ch: string, data: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data)
}

function createWindow() {
  const b = store.bounds()
  const fit = b && screen.getAllDisplays().some(d => b.x < d.workArea.x + d.workArea.width - 80 && b.x + b.width > d.workArea.x + 80 && b.y >= d.workArea.y - 8 && b.y < d.workArea.y + d.workArea.height - 80)
  win = new BrowserWindow({
    ...(fit ? b : { width: 1240, height: 780 }), minWidth: 900, minHeight: 600,
    backgroundColor: '#141312', show: false, frame: false, title: 'Waarp',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.once('ready-to-show', () => { if (fit && b?.max) win?.maximize(); win?.show() })
  const keep = () => { if (!win || win.isMinimized()) return; store.saveBounds({ ...(win.isMaximized() ? store.bounds() ?? win.getNormalBounds() : win.getBounds()), max: win.isMaximized() }) }
  let kt: NodeJS.Timeout | undefined
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(ev as 'resize', () => { clearTimeout(kt); kt = setTimeout(keep, 400) })
  // R2.2: Windows logoff/shutdown runs the same bounded network cleanup; session-end is last-chance only
  win.on('query-session-end', e => { if (tunnelActive()) { e.preventDefault(); void shutdownGate().then(() => app.quit()) } })
  win.on('session-end', () => { if (!shutdownDone) engine?.stopSync() })
  win.on('close', e => {
    if (!quitting && store.settings.tray) { e.preventDefault(); win?.hide() }
  })
  win.on('closed', () => { win = undefined })
  // Renderer content has no reason to open arbitrary external origins. Add a narrow, reviewed
  // allowlist together with a concrete product link if that capability is introduced later.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function show() {
  if (!store) { showPending = true; return }
  if (!win || win.isDestroyed()) createWindow()
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
}

function updateTray() {
  if (!tray) return
  const used = usedProfiles(store.settings, store.profiles)
  const view = trayPresentation(engine.status, master.open, used.map(x => x.name))
  tray.setImage(trayImage(view.active))
  tray.setToolTip(view.tooltip)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: view.action === 'disconnect' ? localized("winInline.index.7d3da26e69e7") : localized("winInline.index.7e131c3f2192"), enabled: master.open || ((store.profiles.length > 0 || demandsTunnel(store.settings)) && admin), click: () => void toggle() },
    { label: localized("winInline.index.2f93c75b9eae"), click: show },
    { type: 'separator' },
    { label: localized("winInline.index.7517f0a97535"), click: () => { quitting = true; app.quit() } }
  ]))
}

async function refreshNotices(beforeStart = false, settings = store.settings) {
  // An unreadable OS snapshot is unknown, never an empty list of conflicts. The
  // periodic watch warns without destroying a healthy session; a new start must
  // obtain a complete snapshot before it may create another system tunnel.
  const [scan, elevated] = await Promise.all([adapters().then(list => ({ list }), () => ({ list: undefined })), adminReady = checkAdmin()])
  admin = elevated
  // A full-route VPN may be the underlay for app-only Waarp routes. It is unsafe only when
  // Waarp also owns the default route. Address collisions are still blocked for profiles
  // actually selected by an enabled route; unused profiles never participate here.
  const plan = compilePlan(settings, store.profiles)
  const required = new Set(plan.requiredProfiles)
  // A conflicting backup must not block an unrelated healthy primary. Guard only the
  // credentials that the compiled plan needs now; standby health is reported beside the route.
  notices = scan.list ? conflicts(
    store.profiles.filter(p => required.has(p.id)),
    scan.list.filter(a => a.name !== 'Waarp'),
    'Waarp',
    plan.scope === 'cards'
  ) : [adapterInspectionNotice(!beforeStart && engine.status.phase === 'on')]
  if (bridgeError) notices.unshift({ level: 'warn', title: localized("winInline.index.d5f87400d402"), text: localized("winInline.index.0fb093cbec40") })
  if (!engineIntegrity) notices.unshift({ level: 'block', title: localized("winInline.index.e0484695f8e1"), text: localized("winInline.index.b1a2eacb3e9b") })
  if (store.secureOff) notices.unshift({ level: 'warn', title: localized("winInline.index.d41b28db1edc"), text: localized("winInline.index.2fe64d0e8dfc") })
  if (store.unreadable) notices.unshift({ level: 'warn', title: localized("winInline.index.f392aa6c92e8"), text: store.unreadableCopy ? localized("winInline.index.8cfc3ab9ec1b", basename(store.unreadable)) : localized("winInline.index.853288e2f786") })
  if (!admin) notices.unshift({ level: 'block', title: localized("winInline.index.1329d072fcdb"), text: localized("winInline.index.8f138d4687ea"), action: 'relaunch-admin' })
  send('snapshot', snapshot())
  return notices
}

const connect = () => master.connect()
const toggle = () => { connectionAction++; return master.toggle() }
const disconnect = () => { connectionAction++; return master.disconnect() }

let watchBusy = false
let pendingTuneRestartNotice = false
async function watch() {
  if (engine.status.phase !== 'on') return
  if (watchBusy) return
  watchBusy = true
  const revision = master.revision
  const acknowledged = engine.acknowledgedSettings
  const session = engine.sessionToken
  try {
    // A pending edit is already persisted while its dialog or native ACK is
    // outstanding. Safety must inspect the acknowledged route, not that intent.
    const n = await refreshNotices(false, acknowledged ?? store.settings)
    const block = n.find(x => x.level === 'block')
    if (!master.current(revision) || engine.status.phase !== 'on' ||
        engine.sessionToken !== session || engine.acknowledgedSettings !== acknowledged) return
    if (!block) {
      // Network changes may invalidate an optional tuning overlay, but must not
      // silently recycle TUN. The current acknowledged path remains active.
      if (await refreshTuneNetwork()) {
        if (!pendingTuneRestartNotice) {
          pendingTuneRestartNotice = true
          send('toast', localized("winInline.index.f26e51989da0"))
        }
      } else pendingTuneRestartNotice = false
      return
    }
    setMaster(false)
    await engine.stop()
    const msg = localized("winInline.index.159f97a2ec3e", block.title.toLowerCase())
    send('toast', msg)
    notify(msg)
  } finally { watchBusy = false }
}

function notify(body: string) {
  if (!store.settings.notify || !Notification.isSupported()) return
  new Notification({ title: 'Waarp', body, silent: false }).show()
}

function covered(id: string) {
  const mine = store.settings.routes.filter(r => r.on && r.via === id)
  return mine.length > 0 && mine.every(r => r.fallback && r.fallback !== id && r.fallback !== 'direct')
}

let downSet = new Set<string>()
function watchPings(st: Status) {
  if (st.phase !== 'on') { downSet = new Set(); return }
  for (const p of usedProfiles(store.settings, store.profiles)) {
    // Health already applies the two-round failure threshold. Raw missing ping would notify on the
    // first transient probe failure and contradict the state shown in the UI.
    const state = st.health?.[p.id]
    const dead = state === 'down'
    if (dead && covered(p.id)) continue
    if (dead && !downSet.has(p.id)) { downSet.add(p.id); notify(localized("winInline.index.0a6cd3d4e33f", p.name)) }
    if (state === 'ok' && downSet.has(p.id)) { downSet.delete(p.id); notify(localized("winInline.index.54982a3f254b", p.name)) }
  }
}

function setAutostart(on: boolean): Promise<boolean> {
  const sch = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe')
  // electron-builder portable runs the inner executable from a temporary extraction directory.
  // Schedule the stable launcher supplied by the wrapper, never that disposable inner path.
  const launchExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  const run = `"${launchExe}"` + (app.isPackaged ? '' : ` "${app.getAppPath()}"`) + ' --hidden'
  const args = on
    ? ['/Create', '/F', '/TN', 'Waarp', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/TR', run]
    : ['/Delete', '/F', '/TN', 'Waarp']
  return new Promise(resolve => execFile(sch, args, { windowsHide: true }, err => {
    if (on) {
      resolve(!err)
      return
    }
    // `/Delete` also fails when the task is already absent. Query the resulting state so access-denied
    // and a genuinely absent task are not both reported as success.
    execFile(sch, ['/Query', '/TN', 'Waarp'], { windowsHide: true }, queryErr => resolve(!!queryErr))
  }))
}

function relaunchAdmin() {
  if (relaunching) return
  relaunching = true
  // Portable wrappers remove the extracted app when it closes. Elevate the stable wrapper itself.
  const launchExe = (app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE) || process.execPath
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`
  // Start-Process joins an ArgumentList array, so pass one command line with each Windows argument quoted.
  const argument = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"'
  const args = relaunchArgs(process.argv.slice(1), process.pid).map(argument).join(' ')
  const cmd = `$ErrorActionPreference='Stop';Start-Process -FilePath ${literal(launchExe)} ${args ? `-ArgumentList ${literal(args)}` : ''} -Verb RunAs -ErrorAction Stop`
  const encoded = Buffer.from(cmd, 'utf16le').toString('base64')
  // Keep the single-instance lock until the old app actually exits. The marked
  // replacement waits read-only, then acquires the lock before opening shared files.
  execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 60_000 }, err => {
    if (!err) { quitting = true; void shutdownGate().then(() => app.quit()); return }
    relaunching = false
    send('toast', localized("winInline.index.a42fbec2b269"))
  })
}

type IpcHandler = Parameters<typeof ipcMain.handle>[1]

function secureHandle(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error(localized("winInline.index.f0ecb47385e3"))
    }
    return handler(event, ...args)
  })
}

/** Same sender guard plus one FIFO for settings/routing writes. UI busy states are UX only; correctness lives here. */
function secureIntentHandle(channel: string, handler: IpcHandler): void {
  secureHandle(channel, (event, ...args) => intentWrites.run(() => handler(event, ...args)))
}

function ipc() {
  secureHandle('snapshot', () => snapshot())
  secureHandle('toggle', () => toggle())
  secureHandle('disconnect', () => disconnect())
  secureHandle('apps:scan', () => scanApps(items => send('apps', items)))
  secureHandle('apps:pick', async () => {
    const r = await dialog.showOpenDialog(win!, { title: localized("winInline.index.be4137d82bac"), filters: [{ name: localized("winInline.index.7136255f33a5"), extensions: ['exe'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return null
    return describeExe(r.filePaths[0])
  })
  // WRP-015 public catalog: nodes enter routing only when the user picks them; labelled public, untrusted
  const addPublic = (id: string): string | undefined => {
    const p = catalog?.node(id); if (!p) return undefined
    const key = credentialKey(p)
    const have = store.profiles.find(x => credentialKey(x) === key); if (have) return have.id
    // A legacy catalog id can survive a lost cache or reordered source. Never retarget its saved profile.
    const copyId = store.profiles.some(x => x.id === p.id) ? 'pub-' + createHash('sha256').update(key).digest('hex').slice(0, 20) : p.id
    if (store.profiles.some(x => x.id === copyId)) return undefined
    const copy = { ...p, id: copyId, source: 'public', country: profileCountry(p) } as Profile
    store.profiles.push(copy); return copy.id
  }
  const addProfiles = (fresh: Profile[]): boolean => {
    const previousProfiles = store.profiles
    // Import adds choices. Missing/deleted targets keep their blocked intent until explicitly reassigned.
    store.profiles = [...previousProfiles, ...fresh]
    try { store.save(); send('snapshot', snapshot()); return true }
    catch { store.profiles = previousProfiles; return false }
  }
  secureHandle('catalog:get', () => { checkCatalogLink(); return catalog?.state })
  secureHandle('catalog:page', (_e, query: unknown) => { checkCatalogLink(); return catalog?.page(query) })
  secureHandle('catalog:auto', async (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return catalog?.state
    const input = raw as Record<string, unknown>
    if (typeof input.owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.owner) || typeof input.active !== 'boolean') return catalog?.state
    if (!input.active) { catalogAutoRequests.delete(input.owner); return catalog?.automatic(input.owner, false) }
    if (!Array.isArray(input.ids) || input.ids.length > 100 || !input.ids.every(id => typeof id === 'string' && /^pub-[0-9a-f]{20}$/.test(id))) return catalog?.state
    if (!engineIntegrity || !runtimeRecovery.ready) return { ...catalog?.state, error: localized("winInline.index.a811e52afb8e") }
    if (!['on', 'off'].includes(engine.status.phase)) return catalog?.state
    const request = Symbol('catalog surface')
    catalogAutoRequests.set(input.owner, request)
    if (catalogAutoRequests.size > 100) catalogAutoRequests.delete(catalogAutoRequests.keys().next().value!)
    await refreshCatalogNetwork()
    if (catalogAutoRequests.get(input.owner) !== request || quitting) return catalog?.state
    return catalog?.automatic(input.owner, true, input.ids as string[])
  })
  secureHandle('discover:scan', async () => {
    if (!discovery || discoveryBusy) return { ok: false, error: localized("winInline.index.2ab6596252b7") }
    discoveryBusy = true
    try {
      const roaming = app.getPath('appData')
      const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
      // Known clients first: broad user folders must not consume the bounded scan budget before them.
      const known = [
        ['AmneziaVPN', join(roaming, 'AmneziaVPN')],
        ['v2rayN', join(roaming, 'v2rayN')],
        ['v2rayN', join(local, 'v2rayN')],
        ['NekoBox', join(roaming, 'NekoBox')],
        ['NekoRay', join(roaming, 'nekoray')],
        ['Hiddify', join(roaming, 'Hiddify')],
        ['Hiddify Next', join(roaming, 'HiddifyNext')],
        ['Clash Verge', join(roaming, 'clash-verge')],
        ['Clash Verge Rev', join(roaming, 'io.github.clash-verge-rev.clash-verge-rev')]
      ].map(([label, path]) => ({ label, path, maxDepth: 3 }))
      const items = await discovery.scan([
        ...known,
        { path: app.getPath('downloads'), label: localized("winInline.index.6fa33baffa12") },
        { path: app.getPath('desktop'), label: localized("winInline.index.4e26e76b11ea") },
        { path: app.getPath('documents'), label: localized("winInline.index.c89b3e12d7e1") }
      ])
      return { ok: true, items }
    } catch { return { ok: false, error: localized("winInline.index.f64331d9c6f7") } }
    finally { discoveryBusy = false }
  })
  secureHandle('discover:pick-folder', async () => {
    if (!discovery || discoveryBusy) return { ok: false, error: localized("winInline.index.2ab6596252b7") }
    const chosen = await dialog.showOpenDialog(win!, { title: localized("winInline.index.d10b507223b2"), properties: ['openDirectory'] })
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, canceled: true }
    discoveryBusy = true
    try { return { ok: true, items: await discovery.scan([{ path: chosen.filePaths[0], label: basename(chosen.filePaths[0]) }]) } }
    catch { return { ok: false, error: localized("winInline.index.756e3485fe9a") } }
    finally { discoveryBusy = false }
  })
  secureIntentHandle('discover:add', async (_e, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (!Array.isArray(raw) || raw.length > 500 || !raw.every(id => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id))) return { ok: false, error: localized("winInline.index.e3d3fa24032f") }
    const have = new Set(store.profiles.map(credentialKey))
    const fresh = raw.map(id => discovery?.profile(id)).filter((p): p is Profile => !!p && !have.has(credentialKey(p)) && !!have.add(credentialKey(p)))
    if (!fresh.length) return { ok: false, error: localized("winInline.index.5f775d7c383c") }
    if (!addProfiles(fresh)) return { ok: false, error: localized("winInline.index.c09e882f5f43") }
    await refreshNotices(); updateTray(); send('snapshot', snapshot())
    discovery?.clear()
    return { ok: true, added: fresh.length, id: fresh.length === 1 ? fresh[0].id : undefined, ids: fresh.map(p => p.id) }
  })
  secureHandle('catalog:refresh', async () => {
    if (!engineIntegrity) return { ok: false, error: localized("winInline.index.4143deeef267") }
    if (!runtimeRecovery.ready) return { ...catalog?.state, error: localized("winInline.index.e4e0d8321d5c") }
    if (!['on', 'off'].includes(engine.status.phase)) return { ...catalog?.state, error: localized("winInline.index.f8c735a6e8d8") }
    await refreshCatalogNetwork(true)
    // Catalog checks own an isolated userspace core with no TUN. They can
    // verify new servers while the application's routes keep running.
    return await catalog?.refresh()
  })
  secureHandle('catalog:verify', async () => {
    if (!engineIntegrity || !runtimeRecovery.ready) return { ...catalog?.state, error: localized("winInline.index.43b1074e3fc3") }
    if (!['on', 'off'].includes(engine.status.phase)) return { ...catalog?.state, error: localized("winInline.index.512915a50d25") }
    await refreshCatalogNetwork(true)
    return await catalog?.verify()
  })
  secureIntentHandle('catalog:add', async (_e, id: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || !/^pub-[0-9a-f]{20}$/.test(id)) return { ok: false, error: localized("winInline.index.b779463e7c42") }
    if (!engineIntegrity || !runtimeRecovery.ready) return { ok: false, error: localized("winInline.index.a811e52afb8e") }
    const revision = master.revision
    await refreshCatalogNetwork(true)
    const verified = await catalog?.verifyNode(id)
    if (revision !== master.revision || quitting) return { ok: false, error: localized("winInline.index.ed42cd60a8e7") }
    if (!verified?.ok) return { ok: false, error: verified?.error ?? localized("winInline.index.f7719ab5de4f") }
    const previousProfiles = store.profiles.slice()
    const pid = addPublic(id); if (!pid) return { ok: false, error: localized("winInline.index.8f60ca03a2ab") }
    try { store.save() }
    catch { store.profiles = previousProfiles; return { ok: false, error: localized("winInline.index.f4a840a32bea") } }
    await refreshNotices(); send('snapshot', snapshot()); return { ok: true, id: pid }
  })
  // Fresh, diverse candidates become a selectable group; creating it never changes routes.
  secureIntentHandle('catalog:best', async () => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    const revision = master.revision, phase = engine.status.phase
    // Interface addresses can stay the same after switching Wi-Fi/gateways.
    // Re-read that context before promoting observations into a saved group.
    await refreshCatalogNetwork(true)
    if (master.revision !== revision || engine.status.phase !== phase) return { ok: false, error: localized("winInline.index.6d2c131c3427") }
    const previousProfiles = store.profiles.slice(), previousSettings = store.settings
    const top = [...new Set((catalog?.bestReady(5) ?? []).map(n => addPublic(n.id)).filter((x): x is string => !!x))]
    if (!top.length) return { ok: false, error: localized("winInline.index.da8e321910fa") }
    const existing = store.settings.groups.find(g => g.id.startsWith('g-public') && g.policy === 'fastest' && g.members.length === top.length && g.members.every((id, i) => id === top[i]))
    if (existing) return { ok: true, id: existing.id }
    if (store.settings.groups.length >= 50) { store.profiles = previousProfiles; return { ok: false, error: localized("winInline.index.40cca33647db") } }
    // Rebuilding the catalog must not silently retarget routes already using an earlier public group.
    const gid = 'g-public-' + randomBytes(4).toString('hex')
    store.settings = { ...store.settings, groups: [...store.settings.groups, { id: gid, name: localized("winInline.index.e591b3826bf6"), policy: 'fastest', members: top }] }
    try { store.save() }
    catch { store.profiles = previousProfiles; store.settings = previousSettings; return { ok: false, error: localized("winInline.index.44f469b56edd") } }
    await refreshNotices(); send('snapshot', snapshot())
    return { ok: true, id: gid }
  })
  secureIntentHandle('settings', async (_e, raw: unknown, base: unknown) => {
    const blocked = writeError(); if (blocked) { send('toast', blocked); return { ...snapshot(), saved: false } }
    const checked = checkedPatch(raw)
    if (!checked.ok) { send('toast', checked.error); return { ...snapshot(), saved: false } }
    const patch = checked.patch // C09: reject malformed IPC instead of silently dropping fields
    if (patch.serviceVia && patch.serviceVia !== 'direct' && !store.profiles.some(p => p.id === patch.serviceVia && !p.revoked && p.source !== 'public' && !('subMissing' in p && p.subMissing))) {
      send('toast', localized("winInline.index.6bb1d95f0058")); return { ...snapshot(), saved: false }
    }
    if (!settingsPatchCurrent(patch, base, store.settings)) { send('toast', localized("winInline.index.2e948c259f54")); return { ...snapshot(), saved: false } }
    // companion routes: never created or redefined by the renderer, never a public / unsafe path or fallback
    if (patch.routes && !companionEditsOk(patch.routes, store.settings.routes)) { send('toast', localized("winInline.index.c2186ff7d321")); return { ...snapshot(), saved: false } }
    if (patch.routes) patch.routes = dedupeApps(patch.routes)
    if (('routes' in patch || 'groups' in patch) && !companionPatchSafe({ routes: patch.routes ?? store.settings.routes, groups: patch.groups ?? store.settings.groups }, store.settings, store.profiles)) { send('toast', companionSafetyMessage()); return { ...snapshot(), saved: false } }
    const routing = ['rest', 'routes', 'ruDirect', 'dnsAll', 'lanDirect', 'groups'].some(k => k in patch)
    const previous = store.settings
    const next = { ...previous, ...patch }
    if ('autostart' in patch && !(await setAutostart(!!patch.autostart))) {
      send('toast', localized("winInline.index.c8dd1e5dea84"))
      return { ...snapshot(), saved: false }
    }
    if (routing) {
      // Card toggles, group edits and route selection share the same transaction,
      // including restart consent, rollback, owner cancellation and runtime ACK.
      const result = await applyRouting(next)
      if (!result.saved && 'autostart' in patch) void setAutostart(previous.autostart)
      if (result.saved && previous.serviceVia !== store.settings.serviceVia) cancelServiceDownload()
      const message = applyText(result)
      if (message) send('toast', message)
      updateTray()
      return { ...snapshot(), saved: result.saved }
    }
    store.settings = next
    try { store.save() }
    catch {
      store.settings = previous
      if ('autostart' in patch) void setAutostart(previous.autostart)
      send('toast', localized("winInline.index.8dc63da88667")); return { ...snapshot(), saved: false }
    }
    if ('serviceVia' in patch && previous.serviceVia !== store.settings.serviceVia) cancelServiceDownload()
    updateTray()
    send('snapshot', snapshot())
    return { ...snapshot(), saved: true }
  })
  secureIntentHandle('route:select', async (_e, routeId: unknown, via: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof routeId !== 'string' || routeId.length > 400 || typeof via !== 'string' || via.length > 80 || !/^[\w:.-]+$/.test(via)) return { ok: false, error: localized("winInline.index.0395f6f9568b") }
    const known = via === 'direct' || (via === AUTO_ID && autoMembers(store.profiles).length > 0) || store.profiles.some(p => !p.revoked && p.id === via) || store.settings.groups.some(g => g.id === via && g.members.some(id => store.profiles.some(p => !p.revoked && p.id === id)))
    if (!known) return { ok: false, error: localized("winInline.index.835ab93fd6b4") }
    const at = store.settings.routes.findIndex(r => r.id === routeId)
    if (at < 0) return { ok: false, error: localized("winInline.index.3839b2a99351") }
    if (store.settings.routes[at].owner === 'companion' && !safeVia(via, store.settings, store.profiles)) return { ok: false, error: companionSafetyMessage() }
    // RC2 B: one card changes its own path only; the whole-computer intent (rest) is never touched here
    const r = await applyRouting(selectVia(store.settings, at, via))
    // closed stays closed: choosing a path only saves it; the orb is the one explicit way to open Waarp (W2 final)
    return { ok: r.saved, saved: r.saved, applied: r.applied, error: applyText(r) }
  })
  // the picker opened by bridge routes.open: main holds the validated target, the renderer only names a path for it
  secureIntentHandle('companion:choose', async (_e, id: unknown, via: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    const t = typeof id === 'string' ? pendingPicks.get(id, Date.now()) : undefined
    if (!t) return { ok: false, error: localized("winInline.index.bc96a1542e61") }
    if (typeof via !== 'string' || via === 'direct' || via === AUTO_ID || !store.profiles.some(p => p.id === via || store.settings.groups.some(g => g.id === via)) || !safeVia(via, store.settings, store.profiles)) return { ok: false, error: companionSafetyMessage() }
    const cur = routeOf(store.settings, t.id)
    if (cur && !sameTarget(cur, t)) return { ok: false, error: localized("winInline.index.cb03144fdc84") }
    const next = routeFor(t, via)
    const r = await applyRouting({ ...store.settings, routes: cur ? store.settings.routes.map(x => (x.id === t.id ? next : x)) : [...store.settings.routes, next] })
    if (!r.saved) return { ok: false, error: applyText(r) }
    pendingPicks.drop(t.id)
    return { ok: true, id: t.id, saved: true, applied: r.applied, error: applyText(r) }
  })
  secureHandle('custom:validate', (_e, v: unknown) => typeof v === 'string' && v.length <= 1000 ? validateCustom(v) : localized("winInline.index.4c6be0b77233"))
  secureHandle('clip:peek', async () => peekClip(await clipboard.readText()))
  secureHandle('qr:scan', async () => {
    try {
      const text = await scanScreenQr()
      if (!text) return { ok: false, error: localized("winInline.index.80fb5847111c") }
      const peek = peekClip(text)
      if (peek.kind === 'none') return { ok: false, error: localized("winInline.index.890f457c6533") }
      const token = randomBytes(16).toString('hex')
      const now = Date.now()
      for (const [id, item] of qrImports) if (item.expires <= now) qrImports.delete(id)
      qrImports.set(token, { text, expires: now + 60_000 })
      const expiry = setTimeout(() => qrImports.delete(token), 60_000)
      expiry.unref()
      return { ok: true, token, peek }
    } catch { return { ok: false, error: localized("winInline.index.1e1a136d1612") } }
  })
  secureIntentHandle('profile:import', async (_e, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    const from = importRequest(raw)
    if (!from) return { ok: false, error: localized("winInline.index.1151137c7da2") }
    let text = from.clipboard ? await clipboard.readText() : from.text ?? ''
    if (from.qrToken) {
      const pending = qrImports.get(from.qrToken)
      qrImports.delete(from.qrToken) // one attempt only, successful or not
      if (!pending || pending.expires <= Date.now()) return { ok: false, error: localized("winInline.index.3ab8acd62765") }
      text = pending.text
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) return { ok: false, error: localized("winInline.index.823ac3d84734") }
    let name = from.name
    if (from.file) {
      const picked = await chooseConfig()
      if (!picked) return { ok: false }
      if ('error' in picked) return { ok: false, error: picked.error }
      text = picked.text
      name ??= picked.name
    }
    try {
      const link = text.trim()
      const sub = isSubscriptionUrl(link) ? link : undefined
      const body = sub ? await withServiceTransport((transport, signal) => fetchSubscription(sub, { transport, signal })) : link
      if (looksLikeOpenVpn(body)) {
        const p = parseOpenVpn(body, name || `OpenVPN ${store.profiles.length + 1}`)
        const key = credentialKey(p)
        const dup = store.profiles.find(x => credentialKey(x) === key)
        if (dup) return { ok: false, error: localized("winInline.index.f861f45428af", dup.name) }
        if (!addProfiles([p])) return { ok: false, error: localized("winInline.index.a3e487107c82") }
        await refreshNotices(); updateTray()
        return { ok: true, added: 1, id: p.id, ids: [p.id], name: p.name, skipped: 0, notApplied: [] as string[] }
      }
      // One path for plain links, mixed/base64 subscriptions, and JSON/YAML containers.
      // AWG/WG falls through to parseConf when no supported share link is present.
      const embedded = linksInContainer(body, 1000)
      const res = parseAny(embedded.length ? embedded.join('\n') : body, 1000)
      if (res.items.length) {
        const keys = new Set(store.profiles.map(credentialKey))
        const fresh = res.items.filter(x => !keys.has(credentialKey(x)) && keys.add(credentialKey(x)))
        for (const x of fresh) if (sub && (x.kind === 'vless' || x.kind === 'out')) {
          x.sub = sub
          x.subKey = subscriptionEntryKey(x)
        }
        if (!fresh.length) return { ok: false, error: localized("winInline.index.31ed871052ba") }
        if (!addProfiles(fresh)) return { ok: false, error: localized("winInline.index.aca24b420bd3") }
        await refreshNotices(); updateTray()
        const notApplied = [...new Set(fresh.flatMap(x => x.kind === 'vless' ? x.vless.notApplied : []))]
        return { ok: true, added: fresh.length, id: fresh.length === 1 ? fresh[0].id : undefined, ids: fresh.map(p => p.id), name: fresh[0].name, skipped: res.skipped + res.items.length - fresh.length, notApplied }
      }
      if (sub || looksLikeVless(link) || /(?:vmess|trojan|ss|hysteria2|hy2|tuic):\/\//i.test(body)) {
        return { ok: false, error: localized("winInline.index.f17ec850e08b") }
      }
      const p = parseConf(text, name || localized("winInline.index.c8d08c8bcf2c", store.profiles.length + 1))
      const dup = store.profiles.find(x => x.kind === 'awg' && x.privateKey === p.privateKey)
      if (dup) return { ok: false, error: localized("winInline.index.f861f45428af", dup.name) }
      if (!addProfiles([p])) return { ok: false, error: localized("winInline.index.a3e487107c82") }
      await refreshNotices()
      updateTray()
      return { ok: true, added: 1, id: p.id, ids: [p.id], name: p.name, skipped: 0, notApplied: [] as string[] }
    } catch (e) {
      return { ok: false, error: e instanceof ConfError ? e.message : localized("winInline.index.a11555da2196") }
    }
  })
  secureIntentHandle('profile:create-wg', async (_e, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: localized("winInline.index.804faff33c86") }
    const values = raw as Record<string, unknown>
    if (!['name', 'address', 'endpoint', 'serverPublicKey'].every(k => typeof values[k] === 'string')) return { ok: false, error: localized("winInline.index.804faff33c86") }
    const name = profileName(values.name)
    if (!name) return { ok: false, error: localized("winInline.index.7e679c933f70") }
    try {
      const { profile, clientPublicKey } = createWireGuardProfile({ ...(values as { name: string; address: string; endpoint: string; serverPublicKey: string }), name })
      if (!addProfiles([profile])) return { ok: false, error: localized("winInline.index.a3e487107c82") }
      await refreshNotices(); updateTray()
      return { ok: true, added: 1, id: profile.id, ids: [profile.id], name: profile.name, clientPublicKey }
    } catch (e) { return { ok: false, error: e instanceof ConfError ? e.message : localized("winInline.index.6f3cc4c32d99") } }
  })
  secureIntentHandle('profile:refresh-sub', async (_e, id: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || id.length > 80) return { ok: false, error: localized("winInline.index.7744159e6518") }
    if (master.open || engine.status.phase !== 'off') return { ok: false, error: localized("winInline.index.eda04c4820b9") }
    const selected = store.profiles.find(p => p.id === id)
    const sub = selected && (selected.kind === 'vless' || selected.kind === 'out') ? selected.sub : undefined
    if (!sub) return { ok: false, error: localized("winInline.index.91504ac8947b") }
    try {
      const body = await withServiceTransport((transport, signal) => fetchSubscription(sub, { transport, signal }))
      const embedded = linksInContainer(body, 1000)
      const parsed = parseAny(embedded.length ? embedded.join('\n') : body, 1000)
      const incoming = parsed.items.filter((p): p is Extract<Profile, { kind: 'vless' | 'out' }> => p.kind === 'vless' || p.kind === 'out')
      if (!incoming.length) return { ok: false, error: localized("winInline.index.a580ee197a7c") }
      const oldProfiles = store.profiles
      const reconciled = reconcileSubscription(oldProfiles, incoming, sub)
      store.profiles = reconciled.profiles
      try { store.save() }
      catch { store.profiles = oldProfiles; return { ok: false, error: localized("winInline.index.247814a4ab6b") } }
      await refreshNotices(); updateTray(); send('snapshot', snapshot())
      return { ok: true, updated: reconciled.updated, added: reconciled.added, missing: reconciled.missing, skipped: parsed.skipped }
    } catch (e) {
      return { ok: false, error: e instanceof ConfError ? e.message : localized("winInline.index.dbec2f817bca") }
    }
  })
  secureIntentHandle('profile:replace', async (_e, id: unknown, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || id.length > 80) return { ok: false, error: localized("winInline.index.1e6e668de2aa") }
    const index = store.profiles.findIndex(p => p.id === id)
    const old = store.profiles[index]
    if (!old) return { ok: false, error: localized("winInline.index.1e6e668de2aa") }
    if (old.source === 'managed' || old.source === 'public' || old.source === 'warp') return { ok: false, error: localized("winInline.index.efe1fe3e788e") }
    if ((old.kind === 'vless' || old.kind === 'out') && old.sub) return { ok: false, error: localized("winInline.index.829437d6d299") }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: localized("winInline.index.a71e4f822efa") }
    const request = raw as { file?: unknown; text?: unknown }
    if (request.file !== undefined && request.file !== true) return { ok: false, error: localized("winInline.index.a71e4f822efa") }
    if (request.text !== undefined && typeof request.text !== 'string') return { ok: false, error: localized("winInline.index.a71e4f822efa") }
    if (!request.file && !request.text?.trim()) return { ok: false, error: localized("winInline.index.42a2526f5e52") }
    let text = request.text ?? ''
    if (request.file) {
      const picked = await chooseConfig()
      if (!picked) return { ok: false, canceled: true }
      if ('error' in picked) return { ok: false, error: picked.error }
      text = picked.text
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) return { ok: false, error: localized("winInline.index.823ac3d84734") }
    let fresh: Profile
    try {
      if (old.kind === 'awg') fresh = parseConf(text, old.name)
      else if (old.kind === 'openvpn') fresh = parseOpenVpn(text, old.name)
      else {
        const parsed = parseAny(text, 2)
        if (parsed.items.length !== 1 || parsed.skipped) return { ok: false, error: localized("winInline.index.3dbadc3f9e5f") }
        fresh = parsed.items[0]
        if (fresh.kind === 'awg') return { ok: false, error: localized("winInline.index.32be8e9e8b44") }
      }
    }
    catch (e) { return { ok: false, error: e instanceof ConfError ? e.message : localized("winInline.index.a11555da2196") } }
    const identity = (p: Profile) => credentialKey(p)
    const dup = store.profiles.find(p => p.id !== id && identity(p) === identity(fresh))
    if (dup) return { ok: false, error: localized("winInline.index.f861f45428af", dup.name) }
    // The stable ID keeps cards and groups attached. The old engine must stop before the key changes.
    if (engine.status.phase !== 'on' && engine.status.phase !== 'off') return { ok: false, error: localized("winInline.index.00ffe0861415") }
    const revision = master.revision
    const wasOn = engine.status.phase === 'on'
    const session = engine.sessionToken
    const needsRestart = wasOn && engine.isProfileLoaded(id)
    if (needsRestart && !await confirmTunRestart(localized("winInline.index.e4530b036ebc"))) return { ok: false, error: localized("winInline.index.558930c34697") }
    if (!(await pauseMeasurements())) return { ok: false, error: localized("winInline.index.c77402722e1d") }
    if (master.revision !== revision || engine.sessionToken !== session || engine.status.phase !== (wasOn ? 'on' : 'off'))
      return { ok: false, error: localized("winInline.index.31922eb60bd7") }
    // An unloaded library entry cannot affect the current native definition.
    if (needsRestart && !(await engine.stop())) return { ok: false, error: localized("winInline.index.806d30ec5913") }
    if (master.revision !== revision) return { ok: false, error: localized("winInline.index.31922eb60bd7") }
    store.profiles[index] = { ...fresh, id: old.id, name: old.name, addedAt: old.addedAt, source: old.source, revoked: old.revoked } as Profile
    try { store.save() }
    catch {
      store.profiles[index] = old
      send('snapshot', snapshot())
      if (needsRestart && master.current(revision)) await reconnectEditedSession(revision)
      return { ok: false, error: localized("winInline.index.bdb2f09af276") }
    }
    await refreshNotices()
    updateTray()
    if (needsRestart && master.current(revision)) {
      const result = await reconnectEditedSession(revision)
      if (!master.current(revision)) return { ok: true }
      if (!result.ok) {
        if (!(await engine.stop())) return { ok: false, error: localized("winInline.index.32f95685aa6f") }
        store.profiles[index] = old
        send('snapshot', snapshot())
        try { store.save() }
        catch { return { ok: false, error: localized("winInline.index.81bb02bf4caa") } }
        if (!master.current(revision)) return { ok: false, error: localized("winInline.index.14be12f6761e") }
        const restored = await reconnectEditedSession(revision)
        if (restored.ok) return { ok: false, error: localized("winInline.index.5ea047026b67") }
        return { ok: false, error: localized("winInline.index.dc75b7929ebe") }
      }
    }
    return { ok: true }
  })
  secureIntentHandle('profile:rename', (_e, id: unknown, rawName: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    const name = profileName(rawName)
    if (typeof id !== 'string' || id.length > 80 || !name) return { ok: false, error: localized("winInline.index.7e679c933f70") }
    const p = store.profiles.find(x => x.id === id)
    if (p?.source === 'managed' || p?.source === 'public') return { ok: false, error: localized("winInline.index.8df70c6405a4") }
    if (!p) return { ok: false, error: localized("winInline.index.1e6e668de2aa") }
    const previous = p.name
    p.name = name
    try { store.save() }
    catch { p.name = previous; return { ok: false, error: localized("winInline.index.dafb2f77a88b") } }
    updateTray()
    send('snapshot', snapshot())
    return { ok: true }
  })
  secureIntentHandle('profile:remove', async (_e, id: unknown, replace?: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || !store.profiles.some(x => x.id === id)) return { ok: false, error: localized("winInline.index.1e6e668de2aa") }
    if (store.profiles.some(x => x.id === id && x.source === 'managed')) return { ok: false, error: localized("winInline.index.68175d037b0a") }
    if (engine.status.phase !== 'on' && engine.status.phase !== 'off') return { ok: false, error: localized("winInline.index.ac1a9ea28439") }
    // Only another existing tunnel/group is a replacement; absent or forged choices leave affected cards blocked.
    const remaining = store.profiles.filter(x => x.id !== id)
    const remainingSettings = dropServer(store.settings, id)
    const ok = typeof replace === 'string' && replace !== id && (remaining.some(p => p.id === replace && !p.revoked) || remainingSettings.groups.some(g => g.id === replace && g.members.some(m => remaining.some(p => p.id === m && !p.revoked))))
    if (replace !== undefined && !ok) return { ok: false, error: localized("winInline.index.38c8bf0f5cd0") }
    const nextSettings = dropServer(store.settings, id, ok ? replace as string : undefined)
    if (store.settings.serviceVia === id && ok && !remaining.some(p => p.id === replace && !p.revoked && p.source !== 'public' && !('subMissing' in p && p.subMissing))) {
      return { ok: false, error: localized("winInline.index.a2d8f81719a6") }
    }
    // Missing companion targets may stay blocked. A replacement must never turn one into a public route.
    const unsafeReplacement = ok && nextSettings.routes.some((r, i) => r.owner === 'companion' && r.via !== store.settings.routes[i]?.via && !safeVia(r.via, nextSettings, remaining))
    if (unsafeReplacement) return { ok: false, error: companionSafetyMessage() }
    const previousProfiles = store.profiles, previousSettings = store.settings
    const revision = master.revision
    const wasOn = engine.status.phase === 'on'
    const session = engine.sessionToken
    if (!(await pauseMeasurements())) return { ok: false, error: localized("winInline.index.c0a2cdb6bf56") }
    if (master.revision !== revision || engine.sessionToken !== session || engine.status.phase !== (wasOn ? 'on' : 'off'))
      return { ok: false, error: localized("winInline.index.110a1a6b7bbf") }
    const inertRemoval = wasOn && !engine.isProfileLoaded(id) && sameEffectiveRouting(previousSettings, nextSettings)
    if (wasOn && !inertRemoval && !await confirmTunRestart(localized("winInline.index.1238a8ae82e1"))) return { ok: false, error: localized("winInline.index.bcc3a9ab9256") }
    if (wasOn && !inertRemoval && !(await engine.stop())) return { ok: false, error: localized("winInline.index.aa0442627b42") }
    if (master.revision !== revision) return { ok: false, error: localized("winInline.index.110a1a6b7bbf") }
    store.profiles = remaining
    store.settings = nextSettings
    try { store.save() }
    catch {
      store.profiles = previousProfiles; store.settings = previousSettings
      if (wasOn && !inertRemoval && master.current(revision)) await reconnectEditedSession(revision)
      return { ok: false, error: localized("winInline.index.f762a6e3054b") }
    }
    await refreshNotices()
    updateTray()
    send('snapshot', snapshot())
    if (wasOn && !inertRemoval && master.current(revision)) {
      const result = await reconnectEditedSession(revision)
      if (!result.ok) return { ok: true, warning: localized("winInline.index.0fdb84572865") + (result.error ?? localized("winInline.index.10bace58acc0")) }
    }
    return { ok: true }
  })
  secureHandle('notices', () => refreshNotices())
  // tunnel on: direct + through every server; tunnel off: direct only (over whatever routes the PC has), servers marked as needing the tunnel
  secureHandle('probe', async (_e, t: unknown) => {
    const target = probeTarget(t)
    if (!target) return {}
    if (engine.status.phase === 'on') return engine.probe(target)
    // tunnel closed: direct over the normal network + through a bounded set of tunnels via the local checker (no TUN);
    // R5: never the whole library at once; unloaded profiles stay unmeasured, not failed
    const pick = checkSample(usedProfiles(withoutAuto(store.settings), store.profiles).map(p => p.id), store.profiles.filter(p => !p.revoked).map(p => p.id), probeCursor)
    probeCursor = pick.cursor
    const subset = store.profiles.filter(p => pick.ids.includes(p.id))
    const viaPaths = async (): Promise<Record<string, number | null>> => {
      if (!checker || !subset.length) return {}
      const measured = checker, lease = measured.acquire()
      if (!lease) return {}
      // A failed adapter scan gives no permission to reuse a possibly live AWG
      // address. Skip this measurement; it is not evidence that a server failed.
      try {
        const list = await adapters()
        if (!measured.owns(lease) || master.open || engine.status.phase !== 'off') return {}
        if (!(await measured.ensure(subset, list)) || !measured.owns(lease)) return {}
        const result = await measured.probe(target, pick.ids)
        return measured.owns(lease) ? result : {}
      }
      catch { return {} }
      finally { measured.release(lease) }
    }
    const [direct, via] = await Promise.all([directProbe(target), viaPaths()])
    return { direct, ...via }
  })
  /** Bounded system-layer evidence and personal alternatives; an already loaded public current path may also be measured. */
  secureHandle('diagnose', async (_e, t: unknown, routeId?: unknown) => {
    const target = probeTarget(t)
    const parsed = target ? parseProbe(target) : undefined
    if (!target || !parsed) return null
    if (routeId !== undefined && (typeof routeId !== 'string' || routeId.length > 400)) return null
    const targetPath = diagnosisTarget(parsed.host, store.settings)
    const route = routeId === undefined ? targetPath.route : store.settings.routes.find(r => r.id === routeId)
    if (routeId !== undefined && !route) return null
    const context = diagnosisContext(route?.id), deadline = Date.now() + DIAGNOSE_MS
    const requestScope = diagnosisRequestScope(parsed.url, context, store.profiles, route)
    const requestCurrent = () => !quitting && Date.now() < deadline && requestScope === diagnosisRequestScope(parsed.url,
      diagnosisContext(route?.id), store.profiles, route ? store.settings.routes.find(r => r.id === route.id) : undefined)
    return diagnosisRequests.request(requestScope,
      signal => networkFingerprint(netMem.salt, AbortSignal.any([signal, AbortSignal.timeout(DIAGNOSE_MS)])), requestCurrent, async net => {
      const run = diagnoseRun, ac = new AbortController()
      diagnosisAbort = ac
      const measured = checker
      let lease: symbol | undefined
      let checkerReady = false
      let cleanup: Promise<boolean> | undefined
      const stopOwned = () => {
        if (lease && measured?.owns(lease)) cleanup = diagnosisCleanup = measured.stop()
      }
      ac.signal.addEventListener('abort', stopOwned, { once: true })
      const timer = setTimeout(() => ac.abort(), Math.max(0, deadline - Date.now()))
      const current = () => !ac.signal.aborted && run === diagnoseRun && requestCurrent()
      try {
        const st = withRoutes(engine.status)
        const selected = route?.via
        const effective = route ? st.routes?.[route.id]?.effective ?? st.picked?.[route.via] ?? (!route.via.startsWith('g-') ? route.via : undefined)
          : targetPath.via === 'direct' ? 'direct' : st.routes?.['*rest']?.effective ?? st.picked?.[targetPath.via] ?? (!targetPath.via.startsWith('g-') ? targetPath.via : undefined)
        const scope: DiagnosisScope | undefined = route ? { routeId: route.id, routeName: route.name, connectionUse: connectionUse(route.connectionUse), selectedVia: selected!, effectiveVia: effective } : undefined
        const used = activeIds(compilePlan(store.settings, store.profiles).requiredProfiles, st.picked, Object.values(st.routes ?? {}).map(e => e.effective), new Set(store.profiles.map(p => p.id)))
        const host = parsed.host
        if (!current()) return null
        // Two checks per candidate share the existing eight-check budget. The inspected card goes first.
        const candidates = diagnosisSet(autoMembers(store.profiles), used, netMem.data, net, host, Date.now(), AUTO_BUDGET)
        const eligible = diagnosisPaths(store.profiles, effective, candidates, Math.floor(AUTO_BUDGET / 2),
          engine.status.phase === 'on' ? engine.loadedProfileIds : undefined)
        const checked = store.profiles.filter(p => eligible.includes(p.id))
        const signatures = new Map(checked.map(p => [p.id, profileSig(p)]))
        const viaPaths = async (): Promise<Record<string, number | null>> => {
          if (!eligible.length || !current()) return {}
          if (engine.status.phase === 'on') return engine.probePaths(parsed.url, eligible, ac.signal)
          if (!measured || master.open || engine.status.phase !== 'off') return {}
          lease ??= measured.acquire(() => ac.abort())
          if (!lease) return {}
          try {
            if (!checkerReady) {
              const list = await untilCancelled(adapters(), ac.signal)
              if (!list || !current() || !measured.owns(lease)) return {}
              if (!checked.length || !(await measured.ensure(checked, list)) || !current() || !measured.owns(lease)) return {}
              checkerReady = true
            }
            if (!current() || !measured.owns(lease)) return {}
            const result = await measured.probe(parsed.url, eligible)
            return current() && measured.owns(lease) ? result : {}
          } catch { return {} }
        }
        const rounds = async () => {
          const out: Record<string, number | null>[] = []
          for (let i = 0; i < 2 && current(); i++) out.push(await viaPaths())
          return out
        }
        const [direct, observations] = await Promise.all([probeLayers(parsed.url, undefined, undefined, ac.signal), rounds()])
        if (!current()) return null
        const samples = summarizeChecks(observations)
        const paths = Object.fromEntries(Object.entries(summarizedPaths(samples)).filter(([id]) => id !== 'direct'))
        const finding = classify(direct, paths)
        const assessment = scope || effective !== undefined ? assessConnection(scope?.connectionUse ?? 'general', effective, samples, eligible.filter(id => id !== 'direct')) : undefined
        const latestNet = await networkFingerprint(netMem.salt, ac.signal)
        const stale = !current() || latestNet !== net || checked.some(p => signatures.get(p.id) !== profileSig(store.profiles.find(x => x.id === p.id) ?? p) || !store.profiles.some(x => x.id === p.id && !x.revoked))
        const at = Date.now()
        // The layer trace uses system sockets. With our TUN up it cannot independently prove Direct restrictions.
        if (net && !stale && engine.status.phase === 'off' && !master.open) { netMem.data = learn(netMem.data, net, host, finding, autoMembers(store.profiles), at); saveNetMem() }
        const stable = Object.fromEntries(Object.entries(paths).filter(([id]) => samples[id]?.attempted >= 2 && samples[id].responded === samples[id].attempted))
        const allowed = assessment ? (assessment.recommendedVia ? { [assessment.recommendedVia]: stable[assessment.recommendedVia] } : {}) : stable
        const proof = !stale && (assessment ? !!assessment.recommendedVia : finding.kind === 'restricted_direct' || finding.kind === 'path_only')
          ? diagnosisProof(host, allowed, checked, net, at, context, route) : undefined
        if (run === diagnoseRun) lastDiagnosis = proof
        return { target: parsed.shown, host, direct, paths, finding, at, stale, token: proof?.token, samples, scope, assessment, currentVia: effective, systemPath: true }
      } finally {
        clearTimeout(timer)
        stopOwned()
        if (cleanup) await cleanup
        if (lease) measured?.release(lease)
        ac.signal.removeEventListener('abort', stopOwned)
        if (diagnosisAbort === ac) diagnosisAbort = undefined
      }
    })
  })
  secureHandle('diagnose:cancel', () => cancelDiagnosis())
  secureHandle('payload:last', () => {
    if (lastPayloadReport) return lastPayloadReport
    lastPayloadReport = readSavedPayloadReport(join(app.getPath('userData'), 'payload-last.json'))
    return lastPayloadReport
  })
  secureHandle('payload:cancel', () => cancelPayloadCheck())
  secureHandle('payload:run', async (_e, id: unknown, upload: unknown): Promise<PayloadReply> => {
    if (payloadTask || quitting) return { error: 'busy' }
    if (typeof id !== 'string' || id.length > 80) return { error: 'gone' }
    const p = store.profiles.find(profile => profile.id === id && !profile.revoked && profile.source !== 'public' && !('subMissing' in profile && profile.subMissing))
    if (!p) return { error: 'gone' }
    const endpoint = typeof upload === 'string' && upload.trim() ? upload.trim() : undefined
    if ((upload !== undefined && typeof upload !== 'string') || (endpoint && !transferUrl(endpoint))) return { error: 'endpoint' }
    const task = new AbortController(), signal = AbortSignal.any([task.signal, AbortSignal.timeout(60000)])
    const revision = master.revision, signature = profileSig(p)
    payloadTask = task
    const measured = checker
    let lease: symbol | undefined, cleanup: Promise<boolean> | undefined
    const stopOwned = () => { if (lease && measured?.owns(lease)) cleanup = payloadCleanup = measured.stop() }
    signal.addEventListener('abort', stopOwned, { once: true })
    const current = () => !signal.aborted && payloadTask === task && !quitting && master.revision === revision &&
      store.profiles.some(profile => profile.id === id && !profile.revoked && profileSig(profile) === signature)
    try {
      let report: PayloadReport
      if (engine.status.phase === 'on') report = await engine.withHttpProxy(id, signal, proxy => checkPayload(id, proxy, endpoint))
      else {
        if (!measured || master.open || engine.status.phase !== 'off') return { error: 'engine' }
        lease = measured.acquire(() => task.abort())
        if (!lease) return { error: 'busy' }
        const list = await untilCancelled(adapters(), signal)
        if (!list || !current() || !measured.owns(lease)) return { error: 'cancelled' }
        const actual = (await runtimeProfiles()).find(profile => profile.id === id)
        if (!actual || !current() || !(await measured.ensure([actual], list)) || !measured.owns(lease)) return { error: 'engine' }
        report = await measured.withHttpProxy(lease, id, signal, proxy => checkPayload(id, proxy, endpoint))
      }
      if (!current()) return { error: 'cancelled' }
      lastPayloadReport = report
      const file = join(app.getPath('userData'), 'payload-last.json'), temporary = file + '.tmp'
      try {
        writeFileSync(temporary, JSON.stringify(report), { mode: 0o600 })
        protectPrivateFile(temporary)
        renameSync(temporary, file)
      } catch { try { rmSync(temporary, { force: true }) } catch {}; send('toast', localized("winInline.index.19e1e2053ed2")) }
      return { report }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      return { error: signal.aborted ? 'cancelled' : code === 'busy' || code === 'not_loaded' ? code : 'engine' }
    } finally {
      stopOwned()
      const clean = cleanup ? await cleanup : true
      if (lease) measured?.release(lease)
      signal.removeEventListener('abort', stopOwned)
      if (payloadTask === task) payloadTask = undefined
      if (!clean) { send('toast', localized("winInline.index.22c5a6d8943b")); return { error: 'engine' } }
    }
  })
  secureIntentHandle('diagnose:apply', async (_e, token: unknown, via: unknown) => {
    const proof = lastDiagnosis
    if (!proof || typeof via !== 'string' || proof.token !== token) return { ok: false, error: 'stale' }
    const net = await networkFingerprint(netMem.salt, AbortSignal.timeout(8000))
    if (proof !== lastDiagnosis || !diagnosisCurrent(proof, token, via, store.profiles, net, Date.now(), diagnosisContext(proof.route?.id), store.settings.routes)) return { ok: false, error: 'stale' }
    if (writeError()) return { ok: false, error: 'save' }
    const next = diagnosisSettings(proof, via, store.settings)
    if (!next) return { ok: false, error: 'stale' }
    const routes = next.routes
    const route = proof.route ? routes.find(r => r.id === proof.route!.id)! : routes.find(r => r.kind === 'custom' && r.value === proof.host)!
    if (!checkedPatch({ routes }).ok || !companionPatchSafe({ routes, groups: store.settings.groups }, store.settings, store.profiles)) return { ok: false, error: 'invalid' }
    const applied = await applyRouting(next)
    if (applied.saved) lastDiagnosis = undefined
    const message = applyText(applied)
    if (message) send('toast', message)
    return { ok: applied.saved, id: route.id, applied: applied.applied, ...(applied.code ? { warning: applied.code, error: applied.code === 'save' ? 'save' : undefined } : {}) }
  })
  secureHandle('log', () => engine.log())
  /** a list change reaches the core through the same confirmed live apply as a card edit */
  const reapplyLists = async (id: string): Promise<boolean> => {
    const revision = master.revision
    try {
      if (!master.current(revision) || engine.status.phase !== 'on' || !store.settings.routes.some(r => r.kind === 'list' && r.list === id && r.on)) return true
      if (await engine.applyLive(await runtimeProfiles(false), store.settings)) return true
      if (engine.liveApplyFailure) { send('toast', engine.liveApplyFailure); return false }
      if (!master.current(revision)) return true // OFF supersedes a pending apply.
      send('toast', localized("winInline.index.f03b69beeddb"))
      return false
    } catch { return false }
    finally { send('snapshot', snapshot()) }
  }
  type ListReply = { ok: boolean; error?: string; warning?: string }
  const listRefreshes = new Map<string, Promise<ListReply>>()
  const listAttempts = new Map<string, number>()
  const refreshList = (id: string): Promise<ListReply> => {
    if (!lists?.data.some(l => l.id === id)) return Promise.resolve({ ok: false, error: 'gone' })
    const pending = listRefreshes.get(id)
    if (pending) return pending
    listAttempts.set(id, Date.now())
    const task = (async (): Promise<ListReply> => {
      const update = await withServiceTransport((transport, signal) => lists!.download(id, { transport, signal })).catch(() => undefined)
      if (!update) return { ok: false, error: 'fetch' }
      return intentWrites.run(async () => {
        const next = update && lists?.updated(update)
        if (!lists || !next || !update || quitting) return { ok: false, error: 'gone' }
        try { lists.replace(next) } catch { return { ok: false, error: 'save' } }
        if (!update.ok) { send('snapshot', snapshot()); return { ok: false, error: update.patch.error } }
        return await reapplyLists(id) ? { ok: true } : { ok: true, warning: 'apply' }
      })
    })().finally(() => listRefreshes.delete(id))
    listRefreshes.set(id, task)
    return task
  }
  secureHandle('lists:add', async (_e, name: unknown, url: unknown) => {
    if (!lists || typeof url !== 'string' || url.length > 1000 || (name !== undefined && typeof name !== 'string')) return { ok: false, error: 'url' }
    const added = await intentWrites.run(() => {
      const before = lists!.data
      let id: string
      try { id = lists!.add(typeof name === 'string' ? name : '', url.trim()).id } catch (e) { return { error: (e as Error).message === 'limit' ? 'limit' : 'url' } }
      const next = lists!.data
      lists!.data = before
      try { lists!.replace(next) } catch { return { error: 'save' } }
      send('snapshot', snapshot())
      return { id }
    })
    if (!added.id) return { ok: false, error: added.error }
    const refreshed = await refreshList(added.id)
    return { ok: true, id: added.id, warning: refreshed.error ?? refreshed.warning }
  })
  secureHandle('lists:refresh', async (_e, id: unknown) => typeof id === 'string' ? refreshList(id) : { ok: false, error: 'gone' })
  secureIntentHandle('lists:toggle', async (_e, id: unknown, on: unknown) => {
    if (!lists || typeof id !== 'string' || typeof on !== 'boolean' || !lists.data.some(l => l.id === id)) return { ok: false, error: 'gone' }
    try { lists.replace(lists.data.map(l => l.id === id ? { ...l, enabled: on } : l)) } catch { return { ok: false, error: 'save' } }
    return await reapplyLists(id) ? { ok: true } : { ok: true, warning: 'apply' }
  })
  secureIntentHandle('lists:remove', async (_e, id: unknown) => {
    if (!lists || typeof id !== 'string' || !lists.data.some(l => l.id === id)) return { ok: false, error: 'gone' }
    if (store.settings.routes.some(r => r.kind === 'list' && r.list === id)) return { ok: false, error: 'used' }
    try { lists.replace(lists.data.filter(l => l.id !== id)) } catch { return { ok: false, error: 'save' } }
    listAttempts.delete(id)
    send('snapshot', snapshot())
    return { ok: true }
  })
  let listSweepBusy = false
  const refreshStaleLists = async () => {
    if (listSweepBusy || quitting) return
    listSweepBusy = true
    try {
      for (const id of (lists?.data ?? []).map(l => l.id)) {
        const l = lists?.data.find(l => l.id === id)
        if (!quitting && l?.enabled && Date.now() - Math.max(l.checkedAt ?? 0, listAttempts.get(id) ?? 0) >= LIST_STALE_MS) await refreshList(id)
      }
    }
    finally { listSweepBusy = false }
  }
  void refreshStaleLists()
  const listTimer = setInterval(() => void refreshStaleLists(), 60_000); listTimer.unref()
  secureHandle('tune:run', async (_e, id: unknown) => {
    const p = typeof id === 'string' ? store.profiles.find(x => x.id === id && !x.revoked) : undefined
    if (!p) return { error: 'gone' }
    if (engine.status.phase !== 'off' || master.open) return { error: 'open' }
    const measuring = checker
    if (!measuring || !runtimeRecovery.ready) return { error: 'engine' }
    const choices = variants(p)
    if (!choices.length) return { error: 'unsupported' }
    const controller = new AbortController()
    const owner = measuring.acquire(() => controller.abort())
    if (!owner) return { error: 'busy' }
    const run = ++tuneRun
    const revision = master.revision
    tuneResult = undefined
    const sig = profileSig(p)
    let timedOut = false, cleanup: Promise<boolean> | undefined
    const stopOwned = () => cleanup ??= measuring.owns(owner) ? measuring.stop() : Promise.resolve(true)
    const cancel = () => { if (run === tuneRun) tuneRun++; controller.abort(); return stopOwned() }
    const task = { id: p.id, cancel }
    tuneTask = task
    const timer = setTimeout(() => { timedOut = true; void cancel() }, TUNE_MS)
    const current = () => run === tuneRun && revision === master.revision && !controller.signal.aborted && !master.open && engine.status.phase === 'off' && !quitting && store.profiles.some(x => x.id === p.id && !x.revoked && profileSig(x) === sig)
    const active = () => current() && measuring.owns(owner)
    const list = [{ label: '', patch: {} }, ...choices]
    const results: { label: string; ms: number | null }[] = []
    try {
      const net = await untilCancelled(currentNet(controller.signal), controller.signal)
      if (!active()) return { error: timedOut ? 'timeout' : 'canceled' }
      if (!net) return { error: 'net' }
      for (const v of list) {
        const observation = await untilCancelled(Promise.all([currentNet(controller.signal), adapters()]), controller.signal)
        if (!active()) return { error: timedOut ? 'timeout' : 'canceled' }
        if (!observation || observation[0] !== net) return { error: 'stale' }
        const ready = await measuring.ensure([applyTune(p, v.patch)], observation[1])
        if (!active()) return { error: timedOut ? 'timeout' : 'canceled' }
        if (!ready) return { error: 'engine' } // inability to measure is not evidence that the original failed.
        // A TLS handshake or tiny 204 is not a working channel. Every accepted
        // variant must transfer and verify the same bounded public document.
        const began = Date.now()
        let ms: number | null = null
        try {
          ms = await measuring.withHttpProxy(owner, p.id,
            AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), async proxy => {
              const result = await proxyRequest(proxy, new URL(PAYLOAD_DOWNLOAD.url), { maxBytes: 262144 })
              return verifyDownload(result.body) ? null : Math.max(1, Date.now() - began)
            })
        } catch { /* a failed bounded transfer cannot qualify a variant */ }
        if (!active()) return { error: timedOut ? 'timeout' : 'canceled' }
        results.push({ label: v.label, ms })
        if (!v.label && ms !== null) break
      }
      const finalNet = await untilCancelled(currentNet(controller.signal), controller.signal)
      if (!active()) return { error: timedOut ? 'timeout' : 'canceled' }
      if (finalNet !== net) return { error: 'stale' }
      // Normal completion releases the cancellation hook before its own confirmed shutdown.
      measuring.release(owner)
      cleanup = measuring.stop()
      if (!(await cleanup)) return { error: 'engine' }
      if (!current()) return { error: timedOut ? 'timeout' : 'canceled' }
      tuneResult = { id: p.id, sig, net, at: Date.now(), results, revision }
      return { results, complete: results[0]?.ms !== null || results.length === list.length }
    } catch { return { error: timedOut ? 'timeout' : 'engine' } }
    finally {
      clearTimeout(timer)
      await stopOwned()
      measuring.release(owner)
      if (tuneTask === task) tuneTask = undefined
    }
  })
  secureHandle('tune:cancel', async (_e, id: unknown) => {
    if (typeof id !== 'string') return false
    if (tuneResult?.id === id) tuneResult = undefined
    return tuneTask?.id === id ? tuneTask.cancel() : true
  })
  secureIntentHandle('tune:apply', async (_e, id: unknown, label: unknown) => {
    const revision = master.revision
    const p = typeof id === 'string' ? store.profiles.find(x => x.id === id && !x.revoked) : undefined
    if (!p || typeof label !== 'string') return { ok: false, error: 'gone' }
    const net = await currentNet()
    if (!net) return { ok: false, error: 'net' }
    const v = tuneResult?.revision === master.revision ? provenTune(tuneResult, p, net, label, Date.now()) : undefined
    if (!v || !store.profiles.includes(p) || master.revision !== revision) return { ok: false, error: 'stale' }
    if (engine.status.phase !== 'on' && engine.status.phase !== 'off') return { ok: false, error: localized("winInline.index.d2f7c6c38017") }
    const needsRestart = engine.status.phase === 'on' && engine.isProfileLoaded(p.id)
    if (needsRestart && !await confirmTunRestart(localized("winInline.index.7fbe6793d0f0"))) return { ok: false, error: localized("winInline.index.07fd62fe7859") }
    if (!saveTunes({ ...tunes, [p.id]: { net, sig: profileSig(p), label: v.label, patch: v.patch, at: Date.now() } })) return { ok: false, error: 'save' }
    tuneResult = undefined
    let applied = true
    if (needsRestart) applied = (await reconnectEditedSession(revision, true)).ok
    send('snapshot', snapshot())
    return { ok: true, ...(!applied ? { warning: 'apply' } : {}) }
  })
  secureIntentHandle('tune:reset', async (_e, id: unknown) => {
    const revision = master.revision
    if (typeof id !== 'string' || !tunes[id]) return { ok: false, error: 'gone' }
    const p = store.profiles.find(x => x.id === id)
    const wasActive = runtimeTuneIds.has(id) || (!!p && !!activeTune(p, tunes[id], await currentNet(), Date.now()))
    if (master.revision !== revision) return { ok: false, error: 'stale' }
    if (engine.status.phase !== 'on' && engine.status.phase !== 'off') return { ok: false, error: localized("winInline.index.d2f7c6c38017") }
    const needsRestart = wasActive && engine.status.phase === 'on' && engine.isProfileLoaded(id)
    if (needsRestart && !await confirmTunRestart(localized("winInline.index.89e9f43b2d66"))) return { ok: false, error: localized("winInline.index.b61cd566e13c") }
    const { [id]: _gone, ...rest } = tunes
    if (!saveTunes(rest)) return { ok: false, error: 'save' }
    let applied = true
    if (needsRestart) applied = (await reconnectEditedSession(revision, true)).ok
    send('snapshot', snapshot())
    return { ok: true, ...(!applied ? { warning: 'apply' } : {}) }
  })
  secureHandle('profile:config', (_e, id: unknown) => {
    const p = typeof id === 'string' ? store.profiles.find(x => x.id === id) : undefined
    return p ? configOf(p) : null
  })
  secureHandle('diag:export', async () => {
    const report = { ...diagnosticsOf({ app: app.getVersion(), integrity: engineIntegrity, at: new Date().toISOString(), status: statusView(engine.status), profiles: store.views(), settings: store.settings, log: engine.log() }),
      previousSessions: sessionEvidence.read(),
      lastTransfer: lastTransferEvidence(join(app.getPath('userData'), 'payload-last.json'), lastPayloadReport) }
    const r = await dialog.showSaveDialog({ defaultPath: `waarp-diagnostics-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return { ok: false }
    try { writeFileSync(r.filePath, JSON.stringify(report, null, 1)); return { ok: true } } catch { return { ok: false, error: true } }
  })
  secureHandle('diag:history', () => sessionEvidence.read())
  secureHandle('diag:clear', async () => {
    cancelPayloadCheck(); lastPayloadReport = undefined
    return { ok: await clearDiagnosticEvidence(sessionEvidence, join(app.getPath('userData'), 'payload-last.json')) }
  })
  secureHandle('net:reset', () => {
    // Recovery is a separate command, not a second hidden global OFF control.
    // Require an explicit master disconnect before recycling a live session.
    if (master.open || engine.status.phase === 'on' || engine.status.phase === 'starting')
      return Promise.resolve({ ok: false, error: localized("winInline.index.6d60c7eefb5b") })
    connectionAction++
    setMaster(false)
    const stop = engine.stop() // invalidate a pending start immediately, outside the queue
    return intentWrites.run(async () => {
      await stop.catch(() => false)
      const recovered = await runtimeRecovery.ensure(true)
      await refreshNotices()
      return recovered
        ? { ok: true }
        : { ok: false, error: engine.status.error ?? localized("winInline.index.eaf8a15b3b05") }
    })
  })
  secureHandle('admin:relaunch', () => relaunchAdmin())
  ipcMain.on('win', (event, a: unknown) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
    if (a === 'min') win.minimize()
    else if (a === 'max') win.isMaximized() ? win.unmaximize() : win.maximize()
    else win.close()
  })
}

app.on('second-instance', show)

app.whenReady().then(async () => {
  await loadLocale(app.getPreferredSystemLanguages())
  // An elevated replacement waits read-only for the parent's bounded cleanup,
  // then acquires the mutex. Shared writers start only after both conditions hold.
  if (!(await waitForRelaunchParent(process.argv))) {
    dialog.showErrorBox(localized("winInline.index.f8841a0acbcd"), localized("winInline.index.4eaa42806cb5"))
    app.quit()
    return
  }
  if (waitingForParent && !app.requestSingleInstanceLock()) { app.quit(); return }
  store = new Store(app.getPath('userData'))
  loadNetMem(app.getPath('userData'))
  loadTunes(app.getPath('userData'))
  lists = new Lists(app.getPath('userData'))
  setListResolver(id => lists?.domains(id) ?? [])
  const logFile = new LogFile(join(app.getPath('userData'), 'logs'))
  const portable = process.env.PORTABLE_EXECUTABLE_FILE && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Waarp', 'engine') : undefined
  const bundledEngine = engineExe
  engineExe = stableEngine(bundledEngine, portable)
  engineIntegrity = verifyEngine(engineExe, bundledEngine)
  logFile.write([`[app] Waarp ${app.getVersion()} started; engine ${engineExe}; integrity ${engineIntegrity ? 'ok' : 'failed'}`])
  engine = new Engine(engineExe, join(app.getPath('userData'), 'engine'), process.execPath)
  engine.sink = lines => logFile.write(lines)
  // Automatic PnP removal stays disconnected until TZ-NEXT-2026-11 E0.3 proves
  // ownership, inspection failures and cancellation. Keep the read-only preflight.
  engine.hostV6 = async () => {
    const routes = await defaultRoutes()
    return routes ? routes.some(r => r.up && isIP(r.nextHop.split('%')[0]) === 6 && r.alias.toLowerCase() !== TUN.name.toLowerCase() && !/teredo|isatap|6to4/i.test(r.alias)) : undefined
  }
  // R1.4: read-only check for a leftover Waarp adapter or a taken service subnet before every TUN start
  engine.preflight = async () => tunPreflight(await tunSnapshot())
  const allowMeasurements = () => runtimeRecovery.ready && !quitting && !master.open && engine.status.phase === 'off'
  checker = engineIntegrity ? new Checker(engineExe, join(app.getPath('userData'), 'check'), allowMeasurements) : undefined
  catalog = new Catalog(join(app.getPath('userData'), 'catalog'), engineExe, s => send('catalog', s),
    () => engineIntegrity && runtimeRecovery.ready && !quitting && ['on', 'off'].includes(engine.status.phase) && catalogLinkCurrent(), fetchPublicCatalog)
  discovery = new Discovery()
  // An open public-server surface renews a bounded automatic-check lease.
  // Its checker owns no TUN and cannot change application routing.
  // Showing the shell must not wait for PowerShell, orphan recovery, or network-related cleanup.
  // Those checks finish immediately after first paint and update the same snapshot.
  adminReady = checkAdmin()
  const startupAction = connectionAction, startupRevision = master.revision
  // Reserve the queue before IPC becomes callable. A first-paint ON cannot run before orphan recovery,
  // and a delayed bootstrap pass cannot subsequently kill a core that ON has just launched.
  const startupRecovery = intentWrites.run(() => runtimeRecovery.ensure())
  sessionEvidence = new LastSessionEvidence(join(app.getPath('userData'), 'last-vpn-session.json'))
  engine.on('status', s => { void sessionEvidence.record(statusView(s), engine.log()); send('status', statusView(s)); updateTray(); watchPings(s) })
  engine.on('fallback', (e: { main: string; fb: string; toFb: boolean; routes: string[] }) => {
    const name = (id: string) => store.profiles.find(p => p.id === id)?.name ?? '?'
    const what = e.routes.slice(0, 2).map(x => `«${x}»`).join(', ') + (e.routes.length > 2 ? localized("winInline.index.50abc7ede69b", e.routes.length - 2) : '')
    const msg = e.toFb
      ? localized("winInline.index.82cd3006fd69", name(e.main), what, name(e.fb))
      : localized("winInline.index.874986ad58f1", name(e.main), what)
    send('toast', msg)
    notify(msg)
  })
  engine.on('conns', c => send('conns', c))
  ipc()
  try {
    bridgeServer = startBridge(app.getPath('userData'), {
      version: app.getVersion(),
      // companions get a sanitized DTO only: no servers, ids, hosts, pings, health internals or engine text
      status: () => bridgeStatus(engine.status.phase, moodOf(withRoutes(engine.status).routes ?? {}), app.getVersion(), engine.status.since),
      routes: {
        list: () => ({ routes: listCompanion(store.settings, withRoutes(engine.status).routes, viewName) }),
        ensure: (target, intent) => intentWrites.run(async () => {
          if (writeError()) return { error: 'blocked' }
          const r = ensureIntent(store.settings, store.profiles, target, intent)
          if ('error' in r) return r
          const a = r.changed ? await applyRouting(r.settings) : undefined
          if (a && !a.saved) return { error: 'not_saved' }
          return { ok: true, saved: true, applied: a ? a.applied : engine.status.phase === 'on', ...(a?.code ? { warning: a.code === 'block' ? 'blocked' : 'not_applied' } : {}), route: listCompanion(store.settings, withRoutes(engine.status).routes, viewName).find(x => x.id === parseTarget(target)?.id) }
        }),
        // only a navigation request: never writes a route, never connects
        open: raw => {
          const t = parseTarget(raw)
          if (!t) return { error: 'bad_target' }
          const r = routeOf(store.settings, t.id)
          if (r && !sameTarget(r, t)) return { error: 'conflict' }
          show()
          if (r) send('nav', { route: r.id })
          else { pendingPicks.put(t, Date.now()); send('nav', { pick: { id: t.id, name: t.name } }) }
          return { ok: true }
        },
      },
      log: () => engine.log(),
      failed: () => { bridgeError = true; void refreshNotices() }
    })
  } catch { bridgeError = true }
  if (!process.argv.includes('--hidden') || showPending) {
    showPending = false
    createWindow()
  }
  tray = new Tray(trayImage(false))
  tray.on('click', show)
  updateTray()
  const [elevated] = await Promise.all([adminReady, startupRecovery])
  admin = elevated
  void refreshNotices()
  if (!quitting && connectionAction === startupAction && master.revision === startupRevision && !master.open && store.settings.autoConnect && admin && demandsTunnel(store.settings)) void connect()
  // R4: one restart per resume, after a usable network is back; never overlapping, never a churn loop
  const sleepWake = createResume({
    isOn: () => master.open && (engine.status.phase === 'on' || engine.status.phase === 'starting'),
    isOpen: () => master.open && !quitting,
    revision: () => master.revision,
    netReady: async () => underlayReady(net.isOnline(), await defaultRoutes()),
    restart: () => {
      const revision = master.revision
      return intentWrites.run(async () => {
      // The owner may have closed Waarp during the settle/network-wait window. Never resurrect it afterwards.
      if (!master.current(revision)) return true
      const result = await master.reconnect(revision, { restart: true, preserveIntent: true })
      return result.ok
      })
    },
    fail: why => {
      const revision = master.revision
      return intentWrites.run(async () => {
      // A deliberate close while resume was waiting wins over the stale wake intent and needs no error toast.
      if (!master.current(revision)) return
      if (engine.status.phase !== 'error') await engine.stop()
      if (!master.current(revision)) return
      setMaster(false)
      const msg = why === 'no_network' ? localized("winInline.index.7ebc71696964") : localized("winInline.index.465e438adfa2")
      send('toast', msg); notify(msg)
      })
    },
  })
  powerMonitor.on('suspend', () => { resetCatalogNetwork(); sleepWake.suspend() })
  powerMonitor.on('resume', () => { resetCatalogNetwork(); sleepWake.resume() })
  const watchTimer = setInterval(watch, 15000); watchTimer.unref()
  // Read-only network context checks; public probing requires a live UI lease.
  const catalogNetworkTimer = setInterval(() => void refreshCatalogNetwork().catch(() => undefined), 15000); catalogNetworkTimer.unref()
  // tunnel off: bounded rotating checks plus a public resolver, so the analyzer stays useful without a probe storm
  const offHealth = new Health()
  let offPingBusy = false
  let offPingCursor = 0
  const offPing = async (): Promise<void> => {
    if (!allowMeasurements() || offPingBusy || catalog?.state.busy || !win?.isVisible()) return
    const measured = checker, lease = measured?.acquire()
    if (measured && !lease) return
    const revision = master.revision
    offPingBusy = true
    try {
      const pings: Record<string, number | undefined> = {}
      // Prioritize tunnels used by active rules, then rotate through the library. This prevents a large
      // subscription from opening hundreds of checks every 15 seconds while every profile is still sampled.
      // R5: required = explicit routing only (Auto standby is not "in use"), so the idle part really rotates
      const pick = checkSample(usedProfiles(withoutAuto(store.settings), store.profiles).map(p => p.id), store.profiles.filter(p => !p.revoked).map(p => p.id), offPingCursor)
      offPingCursor = pick.cursor
      const selected = store.profiles.filter(p => pick.ids.includes(p.id))
      const selectedIds = new Set(selected.map(p => p.id))
      const profiles = store.views().filter(p => p.kind !== 'group' && selectedIds.has(p.id))
      // through each selected tunnel via the checker (real latency over the tunnel); ICMP to the host when the checker can't
      const list = await adapters()
      if (!allowMeasurements() || revision !== master.revision || (lease && !measured?.owns(lease))) return
      const ok = !!measured && selected.length > 0 && (await measured.ensure(selected, list))
      if (lease && !measured?.owns(lease)) return
      const via = ok && measured ? await measured.pings() : {}
      await Promise.all([...profiles.map(async p => { pings[p.id] = via[p.id] ?? (checker?.busy.has(p.id) ? undefined : await icmp(p.host)) }), (async () => { pings.direct = await icmp('1.1.1.1') })()])
      const health = offHealth.step(via, ok ? profiles.map(p => p.id) : [], checker?.busy, store.profiles.filter(p => !p.revoked).map(p => p.id))
      if (allowMeasurements() && revision === master.revision && (!lease || measured?.owns(lease))) engine.recordIdlePings(pings, ok ? health : undefined)
      else if (lease && measured?.owns(lease)) await measured.stop()
    } catch { /* a background measurement failure must not escape the timer or alter owner intent */ }
    finally { if (lease) measured?.release(lease); offPingBusy = false }
  }
  void offPing(); const offPingTimer = setInterval(() => void offPing(), 30000); offPingTimer.unref()
})

/** R2.2: quit waits for the verified stop (graceful core close, residue check), with a hard bound; never hangs */
const SHUTDOWN_MS = 15_000
let shutdown: Promise<void> | undefined
let shutdownDone = false
const tunnelActive = (): boolean => !!engine && ['on', 'starting', 'stopping'].includes(engine.status.phase)
function shutdownGate(): Promise<void> {
  quitting = true
  setMaster(false)
  shutdown ??= (async () => {
    const stopAndSave = async () => { const stopped = await engine?.stop(); await sessionEvidence?.flush(); return stopped }
    const r = await bounded(Promise.all([pauseMeasurements(), stopAndSave(), runtimeRecovery.settled()]), SHUTDOWN_MS)
    // past the bound: last resort; the ownership journal stays and the next launch recovers by exact identity
    if (r === 'timeout') engine?.stopSync()
  })().finally(() => { shutdownDone = true })
  return shutdown
}
app.on('before-quit', e => {
  quitting = true; qrImports.clear()
  if (bridgeServer?.listening) bridgeServer.close()
  if (shutdownDone || !engine) return
  e.preventDefault()
  void shutdownGate().then(() => app.quit())
})
app.on('window-all-closed', () => { if (!store?.settings.tray) app.quit() })

/** companion targets waiting for a path chosen in the picker (bridge routes.open); bounded, in memory only */
const pendingPicks = createPending()
let diagnoseRun = 0
let diagnosisAbort: AbortController | undefined
let diagnosisCleanup: Promise<boolean> = Promise.resolve(true)
let lastDiagnosis: DiagnosisProof | undefined
const diagnosisRequests = new DiagnosisRequests<DiagnosisResult>(stopDiagnosis)
let lastPayloadReport: PayloadReport | undefined
let sessionEvidence: LastSessionEvidence
let payloadTask: AbortController | undefined
let payloadCleanup = Promise.resolve(true)
async function cancelPayloadCheck(): Promise<boolean> { payloadTask?.abort(); return payloadCleanup }
let serviceTask: AbortController | undefined
function cancelServiceDownload(): void { serviceTask?.abort() }

let recentPublicPath: string | undefined
/** Only public list URLs may try this reserve. Private subscriptions and list
 * downloads keep their original, explicitly selected single-path policy. */
async function fetchPublicCatalog(sources: string[], cancel: AbortSignal) {
  if (serviceTask || quitting) throw new ConfError(localized("winInline.index.74fe90c75cc1"))
  const task = new AbortController(), signal = AbortSignal.any([task.signal, cancel])
  const revision = master.revision, preferred = store.settings.serviceVia ?? 'direct'
  const phase = engine.status.phase, since = engine.status.since
  const current = () => !signal.aborted && !quitting && serviceTask === task && master.revision === revision &&
    (store.settings.serviceVia ?? 'direct') === preferred && engine.status.phase === phase && engine.status.since === since && catalogLinkCurrent()
  const publicSafeWhenLoaded = (p: Profile) => p.source !== 'public' || publicCandidateHasPinnedEndpoints(p)
  const paths = publicServicePaths({
    profiles: phase === 'on' ? store.profiles.filter(publicSafeWhenLoaded) : store.profiles,
    cached: phase === 'on' ? [] : catalog?.recoveryCandidates(8) ?? [],
    preferred, recent: recentPublicPath, ...(phase === 'on' ? { loaded: engine.loadedProfileIds } : {})
  })
  const candidateCurrent = (path: PublicServicePath) => {
    if (!current()) return false
    if (!path.profile) return path.id === 'direct'
    const now = path.cached ? catalog?.node(path.id) : store.profiles.find(p => p.id === path.id)
    return !!now && !now.revoked && !('subMissing' in now && now.subMissing) && profileSig(now) === profileSig(path.profile)
  }
  serviceTask = task
  try {
    return await recoverPublicSources(sources, paths, async (path, remaining, scoped, budgetMs) => {
      if (!candidateCurrent(path)) throw new Error('cancelled')
      try {
        return await withPublicServicePath(path, {
          phase: () => engine.status.phase, open: () => master.open,
          current: () => candidateCurrent(path), live: engine, checker,
          adapters: s => untilCancelled(adapters(), s),
          profile: async (candidate, s) => {
            const actual = candidate.cached ? catalog?.node(candidate.id)
              : tuned(store.profiles, tunes, netCache?.net, Date.now()).find(p => p.id === candidate.id)
            if (!actual || !candidateCurrent(candidate)) return undefined
            // Public endpoint DNS is checked and pinned only in this temporary
            // checker config. Saved names/credentials are never rewritten.
            return actual.source === 'public' ? preparePublicCandidate(actual, s) : actual
          }
        }, scoped, budgetMs, (proxy, requests) => fetchCatalogSources(remaining, requests, proxy ? publicServiceTransport(proxy) : undefined))
      } catch (error) {
        if (error instanceof PublicPathCleanupError) {
          publicCleanupBlocked = true
          task.abort(error)
          send('status', statusView(engine.status))
        }
        throw error
      }
    }, signal, { onSuccess: id => { if (current()) recentPublicPath = id } })
  } finally { if (serviceTask === task) serviceTask = undefined }
}

/** One selected path owns the complete download batch. Reuse the live core, or
 * lease the existing headless checker while OFF; never create a competing core
 * or silently retry subscription credentials over Direct. */
async function withServiceTransport<T>(work: (transport: PinnedHttpGet | undefined, signal: AbortSignal) => Promise<T>, cancel?: AbortSignal): Promise<T> {
  if (serviceTask || quitting) throw new ConfError(localized("winInline.index.74fe90c75cc1"))
  const id = store.settings.serviceVia ?? 'direct'
  const profile = id === 'direct' ? undefined : store.profiles.find(p => p.id === id && !p.revoked && p.source !== 'public' && !('subMissing' in p && p.subMissing))
  if (id !== 'direct' && !profile) throw new ConfError(localized("winInline.index.aab4282d1191"))
  const task = new AbortController(), signal = AbortSignal.any([task.signal, AbortSignal.timeout(60000), ...(cancel ? [cancel] : [])])
  const revision = master.revision, signature = profile && profileSig(profile)
  const measured = checker
  let lease: symbol | undefined, cleanup: Promise<boolean> | undefined
  serviceTask = task
  const stopOwned = () => { if (lease && measured?.owns(lease) && !cleanup) cleanup = measured.stop() }
  signal.addEventListener('abort', stopOwned, { once: true })
  const current = () => !signal.aborted && !quitting && serviceTask === task && master.revision === revision &&
    (store.settings.serviceVia ?? 'direct') === id && (!profile || store.profiles.some(p => p.id === id && !p.revoked && profileSig(p) === signature))
  try {
    let result: T
    if (!profile) result = await work(undefined, signal)
    else if (engine.status.phase === 'on') result = await engine.withHttpProxy(id, signal, proxy => work(serviceTransport(proxy), signal))
    else {
      if (!measured || master.open || engine.status.phase !== 'off') throw new Error('engine')
      lease = measured.acquire(() => task.abort())
      if (!lease) throw new Error('busy')
      const list = await untilCancelled(adapters(), signal)
      if (!list || !current() || !measured.owns(lease)) throw new Error('cancelled')
      const actual = (await runtimeProfiles()).find(p => p.id === id)
      if (!actual || !current() || !(await measured.ensure([actual], list)) || !measured.owns(lease)) throw new Error('engine')
      result = await measured.withHttpProxy(lease, id, signal, proxy => work(serviceTransport(proxy), signal))
    }
    if (!current()) throw new Error('cancelled')
    return result
  } catch (error) {
    if (error instanceof ConfError) throw error
    const code = error instanceof Error ? error.message : ''
    throw new ConfError(signal.aborted || code === 'cancelled' ? localized("winInline.index.312fafb43cd3")
      : code === 'busy' ? localized("winInline.index.361f0ff796c4")
        : code === 'not_loaded' ? localized("winInline.index.a536b2c4118a")
          : localized("winInline.index.60a239e230fc"))
  } finally {
    stopOwned()
    const clean = cleanup ? await cleanup : true
    if (lease) measured?.release(lease)
    signal.removeEventListener('abort', stopOwned)
    if (serviceTask === task) serviceTask = undefined
    if (!clean) throw new ConfError(localized("winInline.index.33df41e713b7"))
  }
}
const diagnosisContext = (routeId?: string) => {
  const route = routeId ? store.settings.routes.find(r => r.id === routeId) : undefined
  const st = withRoutes(engine.status)
  const via = route?.via ?? store.settings.rest
  const effective = st.routes?.[route?.id ?? '*rest']?.effective ?? st.picked?.[via] ?? (!via.startsWith('g-') ? via : undefined)
  return JSON.stringify([master.revision, diagnosisRequests.sessionKey(engine.sessionToken), engine.status.phase, engine.status.since, tunes, effective])
}
function cancelDiagnosis(): Promise<boolean> { return diagnosisRequests.cancel() }
async function stopDiagnosis(): Promise<boolean> {
  diagnoseRun++
  lastDiagnosis = undefined
  diagnosisAbort?.abort()
  return diagnosisCleanup
}
let tunes: Tunes = {}
let lists: Lists | undefined
const LIST_STALE_MS = 24 * 3600_000
let tuneFile = ''
let tuneRun = 0
let tuneTask: { id: string; cancel: () => Promise<boolean> } | undefined
let tuneResult: (TuneResult & { revision: number }) | undefined
let netCache: { at: number; net?: string } | undefined
let netRead = 0
let runtimeTuneSignature = '[]'
let runtimeTuneIds = new Set<string>()
let runtimeNet: string | undefined
const TUNE_MS = 60_000

let catalogLink: string | undefined
let catalogNetworkRead: Promise<void> | undefined
let catalogNetworkAt = 0
/** Hash only in memory: neither adapter addresses nor SSIDs leave this process.
 * Ignore our TUN so opening it is not mistaken for a physical network change. */
function catalogLinkStamp(): string {
  const links = Object.entries(networkInterfaces()).filter(([name]) => name.toLowerCase() !== TUN.name.toLowerCase())
    .flatMap(([name, addresses]) => (addresses ?? []).filter(address => !address.internal)
      .map(address => [name, address.address, address.netmask, address.mac].join('|'))).sort()
  return createHash('sha256').update(JSON.stringify(links)).digest('hex')
}
function catalogLinkCurrent(): boolean { return catalogLink !== undefined && catalogLink === catalogLinkStamp() }
function resetCatalogNetwork(): void {
  catalogLink = undefined; catalogNetworkAt = 0; recentPublicPath = undefined
  catalog?.invalidateNetwork(); cancelServiceDownload()
}
function checkCatalogLink(): boolean {
  const stamp = catalogLinkStamp()
  if (catalogLink === stamp) return false
  catalogLink = stamp; catalogNetworkAt = 0; recentPublicPath = undefined
  catalog?.invalidateNetwork(); cancelServiceDownload()
  return true
}
async function refreshCatalogNetwork(force = false): Promise<void> {
  if (!catalog || quitting || (!force && !catalog.state.total)) return
  checkCatalogLink()
  if (catalogNetworkRead) return catalogNetworkRead
  if (!force && Date.now() - catalogNetworkAt < 60_000) return
  const stamp = catalogLink
  catalogNetworkRead = (async () => {
    const net = await currentNet()
    if (catalogLink !== stamp || !catalogLinkCurrent()) { checkCatalogLink(); return }
    catalogNetworkAt = Date.now()
    if (catalog?.invalidateNetwork(stamp + '|' + (net ?? 'unidentified'))) {
      recentPublicPath = undefined; cancelServiceDownload()
    }
  })().finally(() => { catalogNetworkRead = undefined })
  return catalogNetworkRead
}
async function currentNet(signal?: AbortSignal): Promise<string | undefined> {
  const read = ++netRead
  const net = await networkFingerprint(netMem.salt, signal)
  if (read === netRead && !signal?.aborted) netCache = { at: Date.now(), net }
  return net
}
const tuneSignature = (net: string | undefined) => JSON.stringify(store.profiles.flatMap(p => {
  const t = activeTune(p, tunes[p.id], net, Date.now())
  return t ? [[p.id, t.patch]] : []
}).sort(([a], [b]) => String(a).localeCompare(String(b))))

/** Called by the existing network watch. Reconnect only when the effective overlay differs. */
async function refreshTuneNetwork(): Promise<boolean> {
  if (!Object.keys(pruneTunes(tunes, store.profiles, Date.now())).length) return runtimeTuneSignature !== '[]'
  const net = await currentNet()
  return tuneSignature(net) !== runtimeTuneSignature
}
/** the profiles the core runs: stored ones, with a tune applied only on the network it was chosen for */
async function runtimeProfiles(refresh = true) {
  // Card-only live applies keep the running overlay; the existing network watch owns network changes.
  if (!refresh) return tuned(store.profiles, tunes, runtimeNet, Date.now())
  const net = Object.keys(pruneTunes(tunes, store.profiles, Date.now())).length ? await currentNet() : undefined
  runtimeNet = net
  runtimeTuneSignature = tuneSignature(net)
  runtimeTuneIds = new Set(store.profiles.filter(p => activeTune(p, tunes[p.id], net, Date.now())).map(p => p.id))
  return tuned(store.profiles, tunes, net, Date.now())
}
function loadTunes(dir: string) {
  tuneFile = join(dir, 'tune.json')
  try { tunes = pruneTunes(existsSync(tuneFile) ? JSON.parse(readFileSync(tuneFile, 'utf8')) : {}, store.profiles, Date.now()) } catch { tunes = {} }
}
function saveTunes(next: Tunes): boolean {
  const valid = pruneTunes(next, store.profiles, Date.now()), tmp = tuneFile + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(valid))
    renameSync(tmp, tuneFile)
    tunes = valid
    return true
  } catch { try { rmSync(tmp, { force: true }) } catch {}; return false }
}
const DIAGNOSE_MS = 20_000
/** R5: rotation cursor for tunnel-closed probes (bounded checker set) */
let probeCursor = 0
const viewName = (v: string): string | undefined => store.views().find(p => p.id === v)?.name ?? (v === AUTO_ID ? localized("winInline.index.50cbd4fb7749") : undefined)

/** Card choices apply to the current session; only the master owns TUN lifecycle. */
const applyRouting = createApply({
  get: () => store.settings,
  set: s => { store.settings = s },
  save: () => store.save(),
  phase: () => engine.status.phase,
  open: () => master.open,
  revision: () => master.revision,
  session: () => engine.sessionToken,
  blocked: async () => (await refreshNotices()).some(n => n.level === 'block'),
  demandsTunnel,
  validateLive: async s => {
    const acknowledged = engine.acknowledgedSettings
    // Ordinary card picks keep the same scope and stay on the fast live path.
    // Taking over the whole computer must pass conflict policy before any write.
    if (!acknowledged || compilePlan(acknowledged, store.profiles).scope !== 'cards' ||
        compilePlan(s, store.profiles).scope === 'cards') return true
    return !(await refreshNotices(true, s)).some(n => n.level === 'block')
  },
  start: async (_settings, current) => {
    const revision = master.revision
    // The master is already ON: the first selected route fulfills that intent.
    // Keep it if preflight/native start fails, and retain an open Direct-only TUN.
    const result = await master.reconnect(revision, { restart: true, retainCore: true, preserveIntent: true, beforeStart: current })
    if (!result.ok) throw new Error(result.error ?? localized("winInline.index.98786557f434"))
  },
  live: async s => engine.applyLive(await runtimeProfiles(false), s),
  liveFailure: () => engine.liveApplyFailure,
  stop: () => engine.stop(),
  changed: () => send('snapshot', snapshot())
})
/** user-facing text for a routing write that was saved but not applied (or not saved) */
function applyText(r: ApplyResult): string | undefined {
  if (r.code === 'rollback') return localized("winInline.index.1701837f78e6")
  if (r.code === 'block') return (notices.find(n => n.level === 'block')?.title ?? localized("winInline.index.ac6834984ce9")) + localized("winInline.index.f4986d046e32")
  if (r.code === 'restart') return localized("winInline.index.2fbb02fe9fff")
  if (r.code === 'start') return engine.liveApplyFailure ?? (r.saved
    ? localized("winInline.index.038c2206e0e7")
    : localized("winInline.index.cbf390c5a541"))
  if (!r.saved) return localized("winInline.index.0f8a0795f9c8")
  return undefined
}

/** W2.1: every status that leaves main carries the effective per-route state; the renderer never re-derives it */
/** W3.3b per-network memory: local file, hashed network keys only, salt per install */
const netMem: { file: string; salt: string; data: NetMemory; disk: boolean } = { file: '', salt: '', data: {}, disk: true }
function loadNetMem(dir: string): void {
  netMem.file = join(dir, 'netmem.json')
  Object.assign(netMem, loadMem(netMem.file, Date.now()))
}
/** private or nothing: if the file cannot be made private it is removed and memory stays RAM-only for this run */
function saveNetMem(): void {
  if (netMem.disk) netMem.disk = saveMem(netMem.file, netMem.salt, netMem.data, Date.now())
}

function withRoutes<T extends Status>(s: T): T {
  return { ...s, routes: confirmedRoutes(store.settings, store.profiles, s, engine.acknowledgedSettings, engine.routingGuarded) }
}
