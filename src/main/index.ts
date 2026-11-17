import { prepareStart } from './connect'
import { ConnectionControl } from './connection-control'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, powerMonitor, screen, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Notice, Profile, Settings, Snapshot, Status } from '../shared/types'
import { compilePlan } from '../shared/plan'
import { ConfError, createWireGuardProfile, parseConf, usedProfiles, validateCustom, withoutAuto } from './awg'
import { fetchSubscription, isSubscriptionUrl, looksLikeVless } from './vless'
import { describeExe, scanApps, trayImage } from './apps'
import { directProbe, icmp } from './offline'
import { Checker } from './checker'
import { checkedPatch, importRequest, MAX_IMPORT_BYTES, probeTarget, profileName, settingsPatchCurrent } from './validate'
import { linksInContainer, parseAny } from './links'
import { Catalog } from './catalog'
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
import { createApply, onRoutingPatch, selectVia, type ApplyResult } from './apply'
import { defaultRoutes, TUN, tunPreflight, tunSnapshot } from './tun'
import { isIP } from 'node:net'
import { LogFile } from './logfile'
import { configOf } from './techview'
import { applyTune, profileSig, pruneTunes, tuned, variants, type Tunes } from './tune'
import { dedupeApps } from '../shared/appmatch'
import { bounded } from './stop'
import { createResume, underlayReady } from './resume'
import { scanScreenQr } from './qr'
import { stableEngine, verifyEngine } from './integrity'
import { reconcileSubscription, subscriptionEntryKey } from './subscription'
import { trayPresentation } from './tray-view'
import { effectiveRoutes, moodOf } from '../shared/effective'
import { bridgeStatus, companionEditsOk, companionPatchSafe, createPending, ensureIntent, listCompanion, parseTarget, routeFor, routeOf, safeVia, sameTarget } from '../shared/companion'
import { AUTO_BUDGET, AUTO_ID, autoMembers, checkSample } from '../shared/groups'
import { classify } from '../shared/evidence'
import { parseProbe, probeLayers } from './layered'
import { activeIds, diagnosisSet, learn, type NetMemory } from '../shared/netmemory'
import { loadMem, saveMem } from './netmem-store'
import { networkFingerprint } from './netid'
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
  ready: () => !!engine && engine.recoveryReady,
  recover: recoverRuntimes,
  changed: () => { send('status', statusView(engine.status)); updateTray() }
})

const demandsTunnel = (s: Settings): boolean => s.rest !== 'direct' || s.routes.some(r => r.on && r.via !== 'direct')

function writeError(): string | undefined {
  if (store.canSave()) return undefined
  void refreshNotices()
  return store.unreadable ? 'Настройки не прочитались; восстанови исходный файл перед изменениями' : 'Защищённое хранилище Windows недоступно; изменения не будут сохранены'
}

async function chooseConfig(): Promise<{ text: string; name: string } | { error: string } | null> {
  const chosen = await dialog.showOpenDialog(win!, { title: 'Конфиг сервера', filters: [{ name: 'Конфиг', extensions: ['conf', 'ovpn', 'txt', 'vpn', 'json', 'yaml', 'yml'] }], properties: ['openFile'] })
  if (chosen.canceled || !chosen.filePaths[0]) return null
  const path = chosen.filePaths[0]
  const fs = await import('node:fs')
  try {
    const fd = fs.openSync(path, 'r')
    try {
      if (fs.fstatSync(fd).size > MAX_IMPORT_BYTES) return { error: 'Конфиг слишком большой (максимум 1 МБ)' }
      const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1)
      let used = 0
      while (used < buffer.length) {
        const n = fs.readSync(fd, buffer, used, buffer.length - used, used)
        if (!n) break
        used += n
      }
      if (used > MAX_IMPORT_BYTES) return { error: 'Конфиг слишком большой (максимум 1 МБ)' }
      return { text: buffer.toString('utf8', 0, used), name: basename(path).replace(/\.(conf|ovpn|txt|vpn|json|ya?ml)$/i, '') }
    } finally { fs.closeSync(fd) }
  } catch { return { error: 'Не удалось прочитать выбранный файл' } }
}

function snapshot(): Snapshot {
  return { admin, profiles: store.views().map(v => (tunes[v.id] ? { ...v, tune: tunes[v.id].label } : v)), settings: store.settings, status: statusView(engine.status), notices }
}

/** HOTFIX-RUNTIME-01 E: the master switch's intent, owned here. Only the master (and a hard block / quit) changes it;
 *  card toggles only decide whether the core is needed right now. */
const master = new ConnectionControl({
  phase: () => engine.status.phase,
  error: () => engine.status.error,
  demandsTunnel: () => demandsTunnel(store.settings),
  prepare: prepareConnection,
  start: async () => engine.start(await runtimeProfiles(), store.settings),
  stop: () => engine.stop(),
  serial: work => intentWrites.run(work),
  changed: () => { send('status', statusView(engine.status)); updateTray() }
})
const setMaster = (open: boolean) => master.set(open)
const statusView = (s: Status) => ({ ...withRoutes(s), open: master.open, startup: runtimeRecovery.state })
async function pauseMeasurements(): Promise<boolean> {
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
    ? `Проверка личных подключений: ${checker?.recoveryError ?? 'не удалось восстановить прошлый процесс'}`
    : !catalogRecovered
      ? `Проверка каталога: ${catalog?.recoveryError ?? 'не удалось восстановить прошлый процесс'}`
      : !stopped ? 'Проверочный движок не подтвердил остановку. Повтори восстановление.'
        : !engineStopped ? 'Основной движок не подтвердил остановку. Повтори восстановление.' : undefined
  return engine.killOrphans(stopped && engineStopped && checkerRecovered && catalogRecovered, relatedError)
}

async function prepareConnection() {
  admin = await (adminReady = checkAdmin())
  if (quitting) return { ok: false as const, error: 'Waarp закрывается' }
  const stopped = await pauseMeasurements()
  // A later failed lease or stuck checker must not poison all future ON attempts for this app session.
  if (!(await runtimeRecovery.ensure(!stopped))) return { ok: false as const, error: engine.status.error ?? 'Не удалось восстановить прошлый процесс. Повтори восстановление.' }
  if (quitting) return { ok: false as const, error: 'Waarp закрывается' }
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
    { label: view.action === 'disconnect' ? 'Отключить Waarp' : 'Подключить Waarp', enabled: master.open || ((store.profiles.length > 0 || demandsTunnel(store.settings)) && admin), click: () => void toggle() },
    { label: 'Показать окно', click: show },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit() } }
  ]))
}

async function refreshNotices(beforeStart = false) {
  // An unreadable OS snapshot is unknown, never an empty list of conflicts. The
  // periodic watch warns without destroying a healthy session; a new start must
  // obtain a complete snapshot before it may create another system tunnel.
  const [scan, elevated] = await Promise.all([adapters().then(list => ({ list }), () => ({ list: undefined })), adminReady = checkAdmin()])
  admin = elevated
  // A full-route VPN may be the underlay for app-only Waarp routes. It is unsafe only when
  // Waarp also owns the default route. Address collisions are still blocked for profiles
  // actually selected by an enabled route; unused profiles never participate here.
  const plan = compilePlan(store.settings, store.profiles)
  const required = new Set(plan.requiredProfiles)
  // A conflicting backup must not block an unrelated healthy primary. Guard only the
  // credentials that the compiled plan needs now; standby health is reported beside the route.
  notices = scan.list ? conflicts(
    store.profiles.filter(p => required.has(p.id)),
    scan.list.filter(a => a.name !== 'Waarp'),
    'Waarp',
    plan.scope === 'cards'
  ) : [adapterInspectionNotice(!beforeStart && engine.status.phase === 'on')]
  if (bridgeError) notices.unshift({ level: 'warn', title: 'Связь с приложениями отключена', text: 'Windows не подтвердил закрытый доступ к токену локального моста. Waarp продолжает работать самостоятельно.' })
  if (!engineIntegrity) notices.unshift({ level: 'block', title: 'Движок Waarp повреждён', text: 'Контрольная сумма sing-box или его библиотеки не совпадает со сборкой. Переустанови Waarp; запуск туннеля заблокирован.' })
  if (store.secureOff) notices.unshift({ level: 'warn', title: 'Ключи не сохраняются', text: 'Защищённое хранилище Windows сейчас недоступно, поэтому Waarp держит туннели только до закрытия и ничего не пишет на диск открытым текстом.' })
  if (store.unreadable) notices.unshift({ level: 'warn', title: 'Старые настройки не прочитались', text: store.unreadableCopy ? `Копия: ${basename(store.unreadable)}. Исходный файл не изменён; новые настройки пока не сохраняются. Восстанови файл перед продолжением.` : 'Копию создать не удалось. Исходный файл не изменён; новые настройки пока не сохраняются. Проверь доступ к диску и восстанови файл.' })
  if (!admin) notices.unshift({ level: 'block', title: 'Нужны права администратора', text: 'Чтобы создать свой сетевой адаптер, Waarp нужны права админа. Нажми «Перезапустить как админ».', action: 'relaunch-admin' })
  send('snapshot', snapshot())
  return notices
}

const connect = () => master.connect()
const toggle = () => { connectionAction++; return master.toggle() }
const disconnect = () => { connectionAction++; return master.disconnect() }

let watchBusy = false
async function watch() {
  if (engine.status.phase !== 'on') return
  if (watchBusy) return
  watchBusy = true
  const revision = master.revision
  try {
    const n = await refreshNotices()
    const block = n.find(x => x.level === 'block')
    if (!block || !master.current(revision) || engine.status.phase !== 'on') return
    setMaster(false)
    await engine.stop()
    const msg = `Waarp закрылся: ${block.title.toLowerCase()}`
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
    if (dead && !downSet.has(p.id)) { downSet.add(p.id); notify(`Сервер «${p.name}» не отвечает. Его программы ждут, в обход ничего не идёт`) }
    if (state === 'ok' && downSet.has(p.id)) { downSet.delete(p.id); notify(`Сервер «${p.name}» снова на связи`) }
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
    send('toast', 'Перезапуск с правами администратора отменён')
  })
}

type IpcHandler = Parameters<typeof ipcMain.handle>[1]

function secureHandle(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Unauthorized IPC sender')
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
    const r = await dialog.showOpenDialog(win!, { title: 'Выбери программу', filters: [{ name: 'Программы', extensions: ['exe'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return null
    return describeExe(r.filePaths[0])
  })
  // WRP-015 public catalog: nodes enter routing only when the user picks them; labelled public, untrusted
  const addPublic = (id: string): string | undefined => {
    const p = catalog?.node(id); if (!p) return undefined
    const key = credentialKey(p)
    const have = store.profiles.find(x => x.id === p.id || credentialKey(x) === key); if (have) return have.id
    const copy = { ...p, source: 'public' } as Profile
    store.profiles.push(copy); return copy.id
  }
  const addProfiles = (fresh: Profile[]): boolean => {
    const previousProfiles = store.profiles
    // Import adds choices. Missing/deleted targets keep their blocked intent until explicitly reassigned.
    store.profiles = [...previousProfiles, ...fresh]
    try { store.save(); send('snapshot', snapshot()); return true }
    catch { store.profiles = previousProfiles; return false }
  }
  secureHandle('catalog:get', () => catalog?.state)
  secureHandle('discover:scan', async () => {
    if (!discovery || discoveryBusy) return { ok: false, error: 'Поиск уже идёт' }
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
        { path: app.getPath('downloads'), label: 'Загрузки' },
        { path: app.getPath('desktop'), label: 'Рабочий стол' },
        { path: app.getPath('documents'), label: 'Документы' }
      ])
      return { ok: true, items }
    } catch { return { ok: false, error: 'Не удалось выполнить поиск файлов' } }
    finally { discoveryBusy = false }
  })
  secureHandle('discover:pick-folder', async () => {
    if (!discovery || discoveryBusy) return { ok: false, error: 'Поиск уже идёт' }
    const chosen = await dialog.showOpenDialog(win!, { title: 'Папка с конфигами VPN', properties: ['openDirectory'] })
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, canceled: true }
    discoveryBusy = true
    try { return { ok: true, items: await discovery.scan([{ path: chosen.filePaths[0], label: basename(chosen.filePaths[0]) }]) } }
    catch { return { ok: false, error: 'Не удалось прочитать выбранную папку' } }
    finally { discoveryBusy = false }
  })
  secureIntentHandle('discover:add', async (_e, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (!Array.isArray(raw) || raw.length > 500 || !raw.every(id => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id))) return { ok: false, error: 'Неверный список туннелей' }
    const have = new Set(store.profiles.map(credentialKey))
    const fresh = raw.map(id => discovery?.profile(id)).filter((p): p is Profile => !!p && !have.has(credentialKey(p)) && !!have.add(credentialKey(p)))
    if (!fresh.length) return { ok: false, error: 'Новых туннелей нет' }
    if (!addProfiles(fresh)) return { ok: false, error: 'Не удалось сохранить найденные туннели' }
    await refreshNotices(); updateTray(); send('snapshot', snapshot())
    discovery?.clear()
    return { ok: true, added: fresh.length, id: fresh.length === 1 ? fresh[0].id : undefined, ids: fresh.map(p => p.id) }
  })
  secureHandle('catalog:refresh', async () => {
    if (!engineIntegrity) return { ok: false, error: 'Движок Waarp повреждён. Обновление и проверка каталога заблокированы.' }
    if (!runtimeRecovery.ready) return { ...catalog?.state, error: 'Дождись восстановления Waarp перед проверкой каталога' }
    if (master.open || engine.status.phase !== 'off') return { ...catalog?.state, error: 'Обновление продолжится после отключения Waarp' }
    return await catalog?.refresh()
  })
  secureIntentHandle('catalog:add', async (_e, id: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || !/^pub-[0-9a-f]{20}$/.test(id)) return { ok: false, error: 'Неверный узел каталога' }
    const previousProfiles = store.profiles.slice()
    const pid = addPublic(id); if (!pid) return { ok: false, error: 'Узел пропал из списка, обнови каталог' }
    try { store.save() }
    catch { store.profiles = previousProfiles; return { ok: false, error: 'Не удалось сохранить публичный узел' } }
    await refreshNotices(); send('snapshot', snapshot()); return { ok: true, id: pid }
  })
  // The five fastest alive nodes become a selectable group; creating it never changes routing by surprise.
  secureIntentHandle('catalog:best', async () => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    const previousProfiles = store.profiles.slice(), previousSettings = store.settings
    const top = [...new Set((catalog?.state.alive ?? []).slice(0, 5).map(n => addPublic(n.id)).filter((x): x is string => !!x))]
    if (!top.length) return { ok: false, error: 'Живых публичных узлов пока нет. Обнови каталог' }
    const existing = store.settings.groups.find(g => g.id.startsWith('g-public') && g.policy === 'fastest' && g.members.length === top.length && g.members.every((id, i) => id === top[i]))
    if (existing) return { ok: true, id: existing.id }
    if (store.settings.groups.length >= 50) { store.profiles = previousProfiles; return { ok: false, error: 'Достигнут предел в 50 групп. Удали ненужную группу перед добавлением.' } }
    // Rebuilding the catalog must not silently retarget routes already using an earlier public group.
    const gid = 'g-public-' + randomBytes(4).toString('hex')
    store.settings = { ...store.settings, groups: [...store.settings.groups, { id: gid, name: 'Публичные узлы', policy: 'fastest', members: top }] }
    try { store.save() }
    catch { store.profiles = previousProfiles; store.settings = previousSettings; return { ok: false, error: 'Не удалось сохранить группу публичных узлов' } }
    await refreshNotices(); send('snapshot', snapshot())
    return { ok: true, id: gid }
  })
  secureIntentHandle('settings', async (_e, raw: unknown, base: unknown) => {
    const blocked = writeError(); if (blocked) { send('toast', blocked); return { ...snapshot(), saved: false } }
    const checked = checkedPatch(raw)
    if (!checked.ok) { send('toast', checked.error); return { ...snapshot(), saved: false } }
    const patch = checked.patch // C09: reject malformed IPC instead of silently dropping fields
    if (!settingsPatchCurrent(patch, base, store.settings)) { send('toast', 'Настройки уже изменились. Список обновлён — повтори действие.'); return { ...snapshot(), saved: false } }
    // companion routes: never created or redefined by the renderer, never a public / unsafe path or fallback
    if (patch.routes && !companionEditsOk(patch.routes, store.settings.routes)) { send('toast', 'Маршрут приложения нельзя создать или переопределить вручную'); return { ...snapshot(), saved: false } }
    if (patch.routes) patch.routes = dedupeApps(patch.routes)
    if (('routes' in patch || 'groups' in patch) && !companionPatchSafe({ routes: patch.routes ?? store.settings.routes, groups: patch.groups ?? store.settings.groups }, store.settings, store.profiles)) { send('toast', COMPANION_SAFE); return { ...snapshot(), saved: false } }
    const routing = ['rest', 'routes', 'ruDirect', 'dnsAll', 'lanDirect', 'groups'].some(k => k in patch)
    const previous = store.settings
    store.settings = { ...store.settings, ...patch }
    if ('autostart' in patch && !(await setAutostart(!!patch.autostart))) {
      store.settings = previous
      send('toast', 'Не удалось изменить автозапуск Windows')
      return { ...snapshot(), saved: false }
    }
    try { store.save() }
    catch {
      store.settings = previous
      if ('autostart' in patch) void setAutostart(previous.autostart)
      send('toast', 'Не удалось сохранить настройки'); return { ...snapshot(), saved: false }
    }
    if (routing) {
      const revision = master.revision
      // Owner OFF wins immediately even if this settings write entered the FIFO earlier/later.
      // Save the new intent, but leave engine shutdown to the master toggle and apply it on the next open.
      if (!master.open) { updateTray(); send('snapshot', snapshot()); return { ...snapshot(), saved: true } }
      if (engine.status.phase === 'on' && demandsTunnel(store.settings) && (await engine.applyLive(await runtimeProfiles(), store.settings))) { updateTray(); send('snapshot', snapshot()); return { ...snapshot(), saved: true } }
      const currentNotices = await refreshNotices()
      if (!master.current(revision)) return { ...snapshot(), saved: true }
      const action = onRoutingPatch(engine.status.phase, currentNotices.some(n => n.level === 'block'))
      if (action === 'stop') { setMaster(false); await engine.stop() }
      else if (!demandsTunnel(store.settings)) await engine.stop()
      else if (action === 'start' || !currentNotices.some(n => n.level === 'block')) {
        const result = await master.reconnect(revision, { restart: true })
        if (!result.ok && master.revision === revision) send('toast', result.error)
      }
    }
    updateTray()
    send('snapshot', snapshot())
    return { ...snapshot(), saved: true }
  })
  secureIntentHandle('route:select', async (_e, routeId: unknown, via: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof routeId !== 'string' || routeId.length > 400 || typeof via !== 'string' || via.length > 80 || !/^[\w:.-]+$/.test(via)) return { ok: false, error: 'Неверный маршрут' }
    const known = via === 'direct' || (via === AUTO_ID && autoMembers(store.profiles).length > 0) || store.profiles.some(p => !p.revoked && p.id === via) || store.settings.groups.some(g => g.id === via && g.members.some(id => store.profiles.some(p => !p.revoked && p.id === id)))
    if (!known) return { ok: false, error: 'Подключение больше недоступно. Выбери другое' }
    const at = store.settings.routes.findIndex(r => r.id === routeId)
    if (at < 0) return { ok: false, error: 'Карточка больше не существует' }
    if (store.settings.routes[at].owner === 'companion' && !safeVia(via, store.settings, store.profiles)) return { ok: false, error: COMPANION_SAFE }
    // RC2 B: one card changes its own path only; the whole-computer intent (rest) is never touched here
    const r = await applyRouting(selectVia(store.settings, at, via))
    // closed stays closed: choosing a path only saves it; the orb is the one explicit way to open Waarp (W2 final)
    return { ok: r.saved, saved: r.saved, applied: r.applied, error: applyText(r) }
  })
  // the picker opened by bridge routes.open: main holds the validated target, the renderer only names a path for it
  secureIntentHandle('companion:choose', async (_e, id: unknown, via: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    const t = typeof id === 'string' ? pendingPicks.get(id, Date.now()) : undefined
    if (!t) return { ok: false, error: 'Запрос приложения устарел. Повтори его из приложения' }
    if (typeof via !== 'string' || via === 'direct' || via === AUTO_ID || !store.profiles.some(p => p.id === via || store.settings.groups.some(g => g.id === via)) || !safeVia(via, store.settings, store.profiles)) return { ok: false, error: COMPANION_SAFE }
    const cur = routeOf(store.settings, t.id)
    if (cur && !sameTarget(cur, t)) return { ok: false, error: 'Маршрут приложения нельзя переопределить' }
    const next = routeFor(t, via)
    const r = await applyRouting({ ...store.settings, routes: cur ? store.settings.routes.map(x => (x.id === t.id ? next : x)) : [...store.settings.routes, next] })
    if (!r.saved) return { ok: false, error: applyText(r) }
    pendingPicks.drop(t.id)
    return { ok: true, id: t.id, saved: true, applied: r.applied, error: applyText(r) }
  })
  secureHandle('custom:validate', (_e, v: unknown) => typeof v === 'string' && v.length <= 1000 ? validateCustom(v) : 'Неверный адрес')
  secureHandle('clip:peek', async () => peekClip(await clipboard.readText()))
  secureHandle('qr:scan', async () => {
    try {
      const text = await scanScreenQr()
      if (!text) return { ok: false, error: 'QR-код на экране не найден' }
      const peek = peekClip(text)
      if (peek.kind === 'none') return { ok: false, error: 'В QR-коде нет поддерживаемого конфига или ссылки' }
      const token = randomBytes(16).toString('hex')
      const now = Date.now()
      for (const [id, item] of qrImports) if (item.expires <= now) qrImports.delete(id)
      qrImports.set(token, { text, expires: now + 60_000 })
      const expiry = setTimeout(() => qrImports.delete(token), 60_000)
      expiry.unref()
      return { ok: true, token, peek }
    } catch { return { ok: false, error: 'Не удалось прочитать изображение экрана' } }
  })
  secureIntentHandle('profile:import', async (_e, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    const from = importRequest(raw)
    if (!from) return { ok: false, error: 'Неверные данные импорта' }
    let text = from.clipboard ? await clipboard.readText() : from.text ?? ''
    if (from.qrToken) {
      const pending = qrImports.get(from.qrToken)
      qrImports.delete(from.qrToken) // one attempt only, successful or not
      if (!pending || pending.expires <= Date.now()) return { ok: false, error: 'QR-код устарел, отсканируй его ещё раз' }
      text = pending.text
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) return { ok: false, error: 'Конфиг слишком большой (максимум 1 МБ)' }
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
      const body = sub ? await fetchSubscription(sub) : link
      if (looksLikeOpenVpn(body)) {
        const p = parseOpenVpn(body, name || `OpenVPN ${store.profiles.length + 1}`)
        const key = credentialKey(p)
        const dup = store.profiles.find(x => credentialKey(x) === key)
        if (dup) return { ok: false, error: `Этот конфиг уже есть: «${dup.name}»` }
        if (!addProfiles([p])) return { ok: false, error: 'Не удалось сохранить конфиг' }
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
        if (!fresh.length) return { ok: false, error: 'Все эти серверы уже есть в списке' }
        if (!addProfiles(fresh)) return { ok: false, error: 'Не удалось сохранить серверы' }
        await refreshNotices(); updateTray()
        const notApplied = [...new Set(fresh.flatMap(x => x.kind === 'vless' ? x.vless.notApplied : []))]
        return { ok: true, added: fresh.length, id: fresh.length === 1 ? fresh[0].id : undefined, ids: fresh.map(p => p.id), name: fresh[0].name, skipped: res.skipped + res.items.length - fresh.length, notApplied }
      }
      if (sub || looksLikeVless(link) || /(?:vmess|trojan|ss|hysteria2|hy2|tuic):\/\//i.test(body)) {
        return { ok: false, error: 'Не нашёл ни одной поддерживаемой ссылки в подписке' }
      }
      const p = parseConf(text, name || `Сервер ${store.profiles.length + 1}`)
      const dup = store.profiles.find(x => x.kind === 'awg' && x.privateKey === p.privateKey)
      if (dup) return { ok: false, error: `Этот конфиг уже есть: «${dup.name}»` }
      if (!addProfiles([p])) return { ok: false, error: 'Не удалось сохранить конфиг' }
      await refreshNotices()
      updateTray()
      return { ok: true, added: 1, id: p.id, ids: [p.id], name: p.name, skipped: 0, notApplied: [] as string[] }
    } catch (e) {
      return { ok: false, error: e instanceof ConfError ? e.message : 'Не получилось прочитать конфиг' }
    }
  })
  secureIntentHandle('profile:create-wg', async (_e, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Неверные данные сервера' }
    const values = raw as Record<string, unknown>
    if (!['name', 'address', 'endpoint', 'serverPublicKey'].every(k => typeof values[k] === 'string')) return { ok: false, error: 'Неверные данные сервера' }
    const name = profileName(values.name)
    if (!name) return { ok: false, error: 'Неверное имя туннеля' }
    try {
      const { profile, clientPublicKey } = createWireGuardProfile({ ...(values as { name: string; address: string; endpoint: string; serverPublicKey: string }), name })
      if (!addProfiles([profile])) return { ok: false, error: 'Не удалось сохранить конфиг' }
      await refreshNotices(); updateTray()
      return { ok: true, added: 1, id: profile.id, ids: [profile.id], name: profile.name, clientPublicKey }
    } catch (e) { return { ok: false, error: e instanceof ConfError ? e.message : 'Не удалось создать конфиг' } }
  })
  secureIntentHandle('profile:refresh-sub', async (_e, id: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || id.length > 80) return { ok: false, error: 'Подписка не найдена' }
    if (master.open || engine.status.phase !== 'off') return { ok: false, error: 'Отключи Waarp перед обновлением подписки' }
    const selected = store.profiles.find(p => p.id === id)
    const sub = selected && (selected.kind === 'vless' || selected.kind === 'out') ? selected.sub : undefined
    if (!sub) return { ok: false, error: 'Этот туннель не связан с подпиской' }
    try {
      const body = await fetchSubscription(sub)
      const embedded = linksInContainer(body, 1000)
      const parsed = parseAny(embedded.length ? embedded.join('\n') : body, 1000)
      const incoming = parsed.items.filter((p): p is Extract<Profile, { kind: 'vless' | 'out' }> => p.kind === 'vless' || p.kind === 'out')
      if (!incoming.length) return { ok: false, error: 'Подписка не вернула поддерживаемых серверов; прежний список сохранён' }
      const oldProfiles = store.profiles
      const reconciled = reconcileSubscription(oldProfiles, incoming, sub)
      store.profiles = reconciled.profiles
      try { store.save() }
      catch { store.profiles = oldProfiles; return { ok: false, error: 'Не удалось сохранить обновление; прежний список оставлен без изменений' } }
      await refreshNotices(); updateTray(); send('snapshot', snapshot())
      return { ok: true, updated: reconciled.updated, added: reconciled.added, missing: reconciled.missing, skipped: parsed.skipped }
    } catch (e) {
      return { ok: false, error: e instanceof ConfError ? e.message : 'Не удалось обновить подписку; прежний список сохранён' }
    }
  })
  secureIntentHandle('profile:replace', async (_e, id: unknown, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || id.length > 80) return { ok: false, error: 'Туннель не найден' }
    const index = store.profiles.findIndex(p => p.id === id)
    const old = store.profiles[index]
    if (!old) return { ok: false, error: 'Туннель не найден' }
    if (old.source === 'managed' || old.source === 'public' || old.source === 'warp') return { ok: false, error: 'Этим туннелем управляет источник; изменить его здесь нельзя' }
    if ((old.kind === 'vless' || old.kind === 'out') && old.sub) return { ok: false, error: 'Этот туннель обновляется вместе с подпиской' }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Неверные данные конфига' }
    const request = raw as { file?: unknown; text?: unknown }
    if (request.file !== undefined && request.file !== true) return { ok: false, error: 'Неверные данные конфига' }
    if (request.text !== undefined && typeof request.text !== 'string') return { ok: false, error: 'Неверные данные конфига' }
    if (!request.file && !request.text?.trim()) return { ok: false, error: 'Вставь конфиг или выбери файл' }
    let text = request.text ?? ''
    if (request.file) {
      const picked = await chooseConfig()
      if (!picked) return { ok: false, canceled: true }
      if ('error' in picked) return { ok: false, error: picked.error }
      text = picked.text
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) return { ok: false, error: 'Конфиг слишком большой (максимум 1 МБ)' }
    let fresh: Profile
    try {
      if (old.kind === 'awg') fresh = parseConf(text, old.name)
      else if (old.kind === 'openvpn') fresh = parseOpenVpn(text, old.name)
      else {
        const parsed = parseAny(text, 2)
        if (parsed.items.length !== 1 || parsed.skipped) return { ok: false, error: 'Для обновления нужна одна ссылка на сервер, не список или подписка' }
        fresh = parsed.items[0]
        if (fresh.kind === 'awg') return { ok: false, error: 'Для этого туннеля нужна ссылка на сервер' }
      }
    }
    catch (e) { return { ok: false, error: e instanceof ConfError ? e.message : 'Не получилось прочитать конфиг' } }
    const identity = (p: Profile) => credentialKey(p)
    const dup = store.profiles.find(p => p.id !== id && identity(p) === identity(fresh))
    if (dup) return { ok: false, error: `Этот конфиг уже есть: «${dup.name}»` }
    // The stable ID keeps cards and groups attached. The old engine must stop before the key changes.
    if (engine.status.phase === 'starting' || engine.status.phase === 'stopping') return { ok: false, error: 'Дождись завершения подключения или остановки' }
    if (!(await pauseMeasurements())) return { ok: false, error: 'Проверочный движок не остановился; конфиг не изменён' }
    const revision = master.revision
    const wasOn = engine.status.phase === 'on'
    // An error phase may still own a stuck child. Do not rotate credentials until it is gone.
    if (engine.status.phase !== 'off' && !(await engine.stop())) return { ok: false, error: 'Туннель не удалось остановить; конфиг не изменён' }
    store.profiles[index] = { ...fresh, id: old.id, name: old.name, addedAt: old.addedAt, source: old.source, revoked: old.revoked } as Profile
    try { store.save() }
    catch {
      store.profiles[index] = old
      send('snapshot', snapshot())
      if (wasOn && master.current(revision)) await master.reconnect(revision)
      return { ok: false, error: 'Не удалось сохранить конфиг; прежний туннель восстановлен' }
    }
    await refreshNotices()
    updateTray()
    if (wasOn && master.current(revision)) {
      const result = await master.reconnect(revision, { preserveIntent: true })
      if (!master.current(revision)) return { ok: true }
      if (!result.ok) {
        await engine.stop()
        store.profiles[index] = old
        send('snapshot', snapshot())
        try { store.save() }
        catch { setMaster(false); return { ok: false, error: 'Новый конфиг не запустился, а прежний не удалось записать обратно. Туннель остановлен; восстанови конфиг из источника.' } }
        if (!master.current(revision)) return { ok: false, error: 'Новый конфиг не запустился. Прежний конфиг восстановлен на диске; Waarp оставлен закрытым по команде пользователя.' }
        const restored = await master.reconnect(revision)
        if (restored.ok) return { ok: false, error: 'Новый конфиг не запустился. Waarp восстановил прежний рабочий конфиг.' }
        return { ok: false, error: 'Новый конфиг не запустился. Прежний конфиг восстановлен на диске, но его запуск тоже не удался.' }
      }
    }
    return { ok: true }
  })
  secureIntentHandle('profile:rename', (_e, id: unknown, rawName: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    const name = profileName(rawName)
    if (typeof id !== 'string' || id.length > 80 || !name) return { ok: false, error: 'Неверное имя туннеля' }
    const p = store.profiles.find(x => x.id === id)
    if (p?.source === 'managed' || p?.source === 'public') return { ok: false, error: 'Этим туннелем управляет источник; переименовать его здесь нельзя' }
    if (!p) return { ok: false, error: 'Туннель не найден' }
    const previous = p.name
    p.name = name
    try { store.save() }
    catch { p.name = previous; return { ok: false, error: 'Не удалось сохранить имя туннеля' } }
    updateTray()
    send('snapshot', snapshot())
    return { ok: true }
  })
  secureIntentHandle('profile:remove', async (_e, id: unknown, replace?: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || !store.profiles.some(x => x.id === id)) return { ok: false, error: 'Туннель не найден' }
    if (store.profiles.some(x => x.id === id && x.source === 'managed')) return { ok: false, error: 'Туннелем управляет команда; удалить его здесь нельзя' }
    if (engine.status.phase === 'starting' || engine.status.phase === 'stopping') return { ok: false, error: 'Дождись завершения подключения или остановки' }
    // Only another existing tunnel/group is a replacement; absent or forged choices leave affected cards blocked.
    const remaining = store.profiles.filter(x => x.id !== id)
    const remainingSettings = dropServer(store.settings, id)
    const ok = typeof replace === 'string' && replace !== id && (remaining.some(p => p.id === replace && !p.revoked) || remainingSettings.groups.some(g => g.id === replace && g.members.some(m => remaining.some(p => p.id === m && !p.revoked))))
    if (replace !== undefined && !ok) return { ok: false, error: 'Выбранная замена больше недоступна. Выбери другое подключение.' }
    const nextSettings = dropServer(store.settings, id, ok ? replace as string : undefined)
    // Missing companion targets may stay blocked. A replacement must never turn one into a public route.
    const unsafeReplacement = ok && nextSettings.routes.some((r, i) => r.owner === 'companion' && r.via !== store.settings.routes[i]?.via && !safeVia(r.via, nextSettings, remaining))
    if (unsafeReplacement) return { ok: false, error: COMPANION_SAFE }
    const previousProfiles = store.profiles, previousSettings = store.settings
    if (!(await pauseMeasurements())) return { ok: false, error: 'Проверочный движок не остановился; туннель не удалён' }
    const revision = master.revision
    const wasOn = engine.status.phase === 'on'
    if (engine.status.phase !== 'off' && !(await engine.stop())) return { ok: false, error: 'Туннель не удалось остановить; профиль не удалён' }
    store.profiles = remaining
    store.settings = nextSettings
    try { store.save() }
    catch {
      store.profiles = previousProfiles; store.settings = previousSettings
      if (wasOn && master.current(revision)) await master.reconnect(revision)
      return { ok: false, error: 'Не удалось сохранить удаление; туннель оставлен без изменений' }
    }
    await refreshNotices()
    updateTray()
    send('snapshot', snapshot())
    if (wasOn && master.current(revision) && demandsTunnel(store.settings)) {
      const result = await master.reconnect(revision)
      if (!result.ok) return { ok: true, warning: 'Профиль удалён, но оставшиеся маршруты не запустились: ' + (result.error ?? 'проверь подключение') }
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
      // A failed adapter scan gives no permission to reuse a possibly live AWG
      // address. Skip this measurement; it is not evidence that a server failed.
      try { return await checker.ensure(subset, await adapters()) ? checker.probe(target, pick.ids) : {} }
      catch { return {} }
    }
    const [direct, via] = await Promise.all([directProbe(target), viaPaths()])
    return { direct, ...via }
  })
  /** W3.2: layered Direct evidence + own eligible paths (bounded, never public) -> a cautious finding */
  secureHandle('diagnose', async (_e, t: unknown) => {
    const target = probeTarget(t)
    const parsed = target ? parseProbe(target) : undefined
    if (!target || !parsed) return null
    const run = ++diagnoseRun
    // "in use" = carrying traffic now (required, picked, effective), not every Auto standby candidate
    const st = withRoutes(engine.status)
    const used = activeIds(compilePlan(store.settings, store.profiles).requiredProfiles, st.picked, Object.values(st.routes ?? {}).map(e => e.effective), new Set(store.profiles.map(p => p.id)))
    const host = parsed.host
    const net = await networkFingerprint(netMem.salt)
    const now = Date.now()
    // memory only orders which own paths this diagnosis checks; it never touches routes or runtime Auto
    const eligible = diagnosisSet(autoMembers(store.profiles), used, netMem.data, net, host, now, AUTO_BUDGET)
    const viaPaths = async (): Promise<Record<string, number | null>> => {
      if (!eligible.length) return {}
      if (engine.status.phase === 'on') return engine.probePaths(target, eligible)
      // the checker is built from the bounded set only, never the whole library
      const subset = store.profiles.filter(p => eligible.includes(p.id))
      try { return checker && (await checker.ensure(subset, await adapters())) ? checker.probe(target, eligible) : {} }
      catch { return {} }
    }
    const checked = store.profiles.filter(p => eligible.includes(p.id))
    const deadline = new Promise<Record<string, number | null>>(r => setTimeout(() => r({}), DIAGNOSE_MS))
    const [direct, all] = await Promise.all([probeLayers(target), Promise.race([viaPaths(), deadline])])
    const paths: Record<string, number | null> = {}
    for (const id of eligible) if (id in all) paths[id] = all[id]
    const finding = classify(direct, paths)
    const stale = run !== diagnoseRun || checked.some(p => !store.profiles.includes(p)) || (await networkFingerprint(netMem.salt)) !== net
    if (net && !stale) { netMem.data = learn(netMem.data, net, host, finding, autoMembers(store.profiles), now); saveNetMem() }
    return { target: parsed.shown, host, direct, paths, finding, at: now, stale }
  })
  secureHandle('log', () => engine.log())
  secureHandle('tune:run', async (_e, id: unknown) => {
    const p = typeof id === 'string' ? store.profiles.find(x => x.id === id && !x.revoked) : undefined
    if (!p) return { error: 'gone' }
    if (engine.status.phase !== 'off' || master.open) return { error: 'open' }
    if (!checker) return { error: 'engine' }
    const run = ++tuneRun
    const end = Date.now() + TUNE_MS
    const list = [{ label: '', patch: {} }, ...variants(p)]
    const results: { label: string; ms: number | null }[] = []
    for (const v of list) {
      if (run !== tuneRun || Date.now() > end) break
      const probe = applyTune(p, v.patch)
      try {
        const ok = await checker.ensure([probe], await adapters())
        const r = ok ? await checker.probe(TUNE_URL, [p.id]) : {}
        results.push({ label: v.label, ms: r[p.id] ?? null })
      } catch { results.push({ label: v.label, ms: null }) }
    }
    void checker.stop()
    if (run !== tuneRun) return { error: 'canceled' }
    return { results, complete: results.length === list.length }
  })
  secureHandle('tune:cancel', () => { tuneRun++; return true })
  secureIntentHandle('tune:apply', async (_e, id: unknown, label: unknown) => {
    const p = typeof id === 'string' ? store.profiles.find(x => x.id === id && !x.revoked) : undefined
    const v = p && typeof label === 'string' ? variants(p).find(x => x.label === label) : undefined
    if (!p || !v) return { ok: false, error: 'gone' }
    netCache = undefined
    const net = await currentNet()
    if (!net) return { ok: false, error: 'net' }
    tunes = { ...tunes, [p.id]: { net, sig: profileSig(p), label: v.label, patch: v.patch, at: Date.now() } }
    saveTunes()
    if (engine.status.phase === 'on') { const r = await master.reconnect(master.revision, { restart: true }); if (!r.ok) send('toast', r.error) }
    send('snapshot', snapshot())
    return { ok: true }
  })
  secureIntentHandle('tune:reset', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !tunes[id]) return { ok: false }
    const { [id]: _gone, ...rest } = tunes
    tunes = rest
    saveTunes()
    if (engine.status.phase === 'on') { const r = await master.reconnect(master.revision, { restart: true }); if (!r.ok) send('toast', r.error) }
    send('snapshot', snapshot())
    return { ok: true }
  })
  secureHandle('profile:config', (_e, id: unknown) => {
    const p = typeof id === 'string' ? store.profiles.find(x => x.id === id) : undefined
    return p ? configOf(p) : null
  })
  secureHandle('diag:export', async () => {
    const st = engine.status
    const report = {
      app: app.getVersion(), engine: engineExe, integrity: engineIntegrity, at: new Date().toISOString(),
      status: { phase: st.phase, engine: st.engine, error: st.error, health: st.health, pings: st.pings, pingAt: st.pingAt, picked: st.picked, fallback: st.fallback },
      profiles: store.views().map(({ clientPublicKey: _k, ...v }) => v),
      routes: store.settings.routes.map(r => ({ name: r.name, kind: r.kind, on: r.on, via: r.via, fallback: r.fallback, exe: r.exe, wholeDir: r.wholeDir, preset: r.preset, value: r.value })),
      settings: { rest: store.settings.rest, ruDirect: store.settings.ruDirect, lanDirect: store.settings.lanDirect, groups: store.settings.groups },
      log: engine.log()
    }
    const r = await dialog.showSaveDialog({ defaultPath: `waarp-diagnostics-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return { ok: false }
    try { writeFileSync(r.filePath, JSON.stringify(report, null, 1)); return { ok: true } } catch { return { ok: false, error: true } }
  })
  secureHandle('net:reset', () => {
    connectionAction++
    setMaster(false)
    const stop = engine.stop() // invalidate a pending start immediately, outside the queue
    return intentWrites.run(async () => {
      await stop.catch(() => false)
      const recovered = await runtimeRecovery.ensure(true)
      await refreshNotices()
      return recovered
        ? { ok: true }
        : { ok: false, error: engine.status.error ?? 'Не всё удалось закрыть безопасно. Повтори восстановление.' }
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
  // An elevated replacement waits read-only for the parent's bounded cleanup,
  // then acquires the mutex. Shared writers start only after both conditions hold.
  if (!(await waitForRelaunchParent(process.argv))) {
    dialog.showErrorBox('Waarp не перезапустился', 'Предыдущая копия Waarp ещё не закрылась или Windows не дала проверить её завершение. Закрой её и повтори запуск. Настройки и процессы не изменены.')
    app.quit()
    return
  }
  if (waitingForParent && !app.requestSingleInstanceLock()) { app.quit(); return }
  store = new Store(app.getPath('userData'))
  loadNetMem(app.getPath('userData'))
  loadTunes(app.getPath('userData'))
  const logFile = new LogFile(join(app.getPath('userData'), 'logs'))
  const portable = process.env.PORTABLE_EXECUTABLE_FILE && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Waarp', 'engine') : undefined
  engineExe = stableEngine(engineExe, portable)
  engineIntegrity = verifyEngine(engineExe)
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
  catalog = new Catalog(join(app.getPath('userData'), 'catalog'), engineExe, s => send('catalog', s), allowMeasurements)
  discovery = new Discovery()
  // Public checks are explicit. Opening Waarp must not contact third-party nodes or race their checker with TUN.
  // Showing the shell must not wait for PowerShell, orphan recovery, or network-related cleanup.
  // Those checks finish immediately after first paint and update the same snapshot.
  adminReady = checkAdmin()
  const startupAction = connectionAction, startupRevision = master.revision
  // Reserve the queue before IPC becomes callable. A first-paint ON cannot run before orphan recovery,
  // and a delayed bootstrap pass cannot subsequently kill a core that ON has just launched.
  const startupRecovery = intentWrites.run(() => runtimeRecovery.ensure())
  engine.on('status', s => { send('status', statusView(s)); updateTray(); watchPings(s) })
  engine.on('fallback', (e: { main: string; fb: string; toFb: boolean; routes: string[] }) => {
    const name = (id: string) => store.profiles.find(p => p.id === id)?.name ?? '?'
    const what = e.routes.slice(0, 2).map(x => `«${x}»`).join(', ') + (e.routes.length > 2 ? ` и ещё ${e.routes.length - 2}` : '')
    const msg = e.toFb
      ? `Сервер «${name(e.main)}» не отвечает, ${what} ушёл на «${name(e.fb)}»`
      : `Сервер «${name(e.main)}» вернулся, ${what} снова на нём`
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
      const msg = why === 'no_network' ? 'После сна сеть не вернулась. Waarp закрыт, включи его, когда интернет появится' : 'После сна Waarp не смог переподключиться и закрыт'
      send('toast', msg); notify(msg)
      })
    },
  })
  powerMonitor.on('suspend', () => sleepWake.suspend())
  powerMonitor.on('resume', () => sleepWake.resume())
  const watchTimer = setInterval(watch, 15000); watchTimer.unref()
  // tunnel off: bounded rotating checks plus a public resolver, so the analyzer stays useful without a probe storm
  const offHealth = new Health()
  let offPingBusy = false
  let offPingCursor = 0
  const offPing = async (): Promise<void> => {
    if (!allowMeasurements() || offPingBusy || catalog?.state.busy || !win?.isVisible()) return
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
      if (!allowMeasurements() || revision !== master.revision) return
      const ok = !!checker && selected.length > 0 && (await checker.ensure(selected, list))
      const via = ok && checker ? await checker.pings() : {}
      await Promise.all([...profiles.map(async p => { pings[p.id] = via[p.id] ?? (checker?.busy.has(p.id) ? undefined : await icmp(p.host)) }), (async () => { pings.direct = await icmp('1.1.1.1') })()])
      const health = offHealth.step(via, ok ? profiles.map(p => p.id) : [], checker?.busy, store.profiles.filter(p => !p.revoked).map(p => p.id))
      if (allowMeasurements() && revision === master.revision) send('status', statusView({ ...engine.status, engine: 'down', pings, health: ok ? health : undefined }))
      else void checker?.stop()
    } catch { /* a background measurement failure must not escape the timer or alter owner intent */ }
    finally { offPingBusy = false }
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
    const r = await bounded(Promise.all([pauseMeasurements(), engine?.stop(), runtimeRecovery.settled()]), SHUTDOWN_MS)
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

const COMPANION_SAFE = 'Для маршрута приложения можно выбрать только свои подключения, Авто или Напрямую'
/** companion targets waiting for a path chosen in the picker (bridge routes.open); bounded, in memory only */
const pendingPicks = createPending()
let diagnoseRun = 0
let tunes: Tunes = {}
let tuneFile = ''
let tuneRun = 0
let netCache: { at: number; net?: string } | undefined
const TUNE_URL = 'https://www.gstatic.com/generate_204'
const TUNE_MS = 60_000
async function currentNet(): Promise<string | undefined> {
  if (netCache && Date.now() - netCache.at < 60_000) return netCache.net
  const net = await networkFingerprint(netMem.salt)
  netCache = { at: Date.now(), net }
  return net
}
/** the profiles the core runs: stored ones, with a tune applied only on the network it was chosen for */
async function runtimeProfiles() {
  if (!Object.keys(tunes).length) return store.profiles
  return tuned(store.profiles, tunes, await currentNet(), Date.now())
}
function loadTunes(dir: string) {
  tuneFile = join(dir, 'tune.json')
  try { tunes = existsSync(tuneFile) ? JSON.parse(readFileSync(tuneFile, 'utf8')) as Tunes : {} } catch { tunes = {} }
}
function saveTunes() {
  tunes = pruneTunes(tunes, store.profiles, Date.now())
  try { writeFileSync(tuneFile, JSON.stringify(tunes)) } catch {}
}
const DIAGNOSE_MS = 20_000
/** R5: rotation cursor for tunnel-closed probes (bounded checker set) */
let probeCursor = 0
const viewName = (v: string): string | undefined => store.views().find(p => p.id === v)?.name ?? (v === AUTO_ID ? 'Авто' : undefined)

/** save routing settings like route:select does: a running engine restarts with the plan, a closed one stays closed */
const applyRouting = createApply({
  get: () => store.settings,
  set: s => { store.settings = s },
  save: () => store.save(),
  phase: () => engine.status.phase,
  open: () => master.open,
  revision: () => master.revision,
  blocked: async () => (await refreshNotices(), notices.some(n => n.level === 'block')),
  demandsTunnel,
  start: async s => {
    const revision = master.revision
    const stopped = await pauseMeasurements()
    if (!master.current(revision) || quitting || !(await runtimeRecovery.ensure(!stopped))) return
    if (master.current(revision) && !quitting) await engine.start(await runtimeProfiles(), s)
  },
  live: async s => engine.applyLive(await runtimeProfiles(), s),
  stop: () => engine.stop(),
  changed: () => send('snapshot', snapshot())
})
/** user-facing text for a routing write that was saved but not applied (or not saved) */
function applyText(r: ApplyResult): string | undefined {
  if (!r.saved) return 'Не удалось сохранить маршрут'
  if (r.code === 'block') return (notices.find(n => n.level === 'block')?.title ?? 'Запуск заблокирован') + '. Маршрут сохранён, туннель остановлен'
  if (r.code === 'start') return 'Маршрут сохранён, но текущее состояние туннеля не применило изменение'
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
  return { ...s, routes: effectiveRoutes(store.settings, store.profiles, s) }
}
