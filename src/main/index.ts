import { prepareStart } from './connect'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, powerMonitor, screen, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import type { Notice, Profile, Settings, Snapshot, Status } from '../shared/types'
import { compilePlan } from '../shared/plan'
import { ConfError, createWireGuardProfile, parseConf, usedProfiles, validateCustom, withoutAuto } from './awg'
import { fetchSubscription, isSubscriptionUrl, looksLikeVless, vlessKey } from './vless'
import { describeExe, scanApps, trayImage } from './apps'
import { directProbe, icmp } from './offline'
import { Checker } from './checker'
import { checkedPatch, importRequest, MAX_IMPORT_BYTES, probeTarget, profileName } from './validate'
import { linksInContainer, parseAny } from './links'
import { Catalog } from './catalog'
import { credentialKey, Discovery } from './discovery'
import { looksLikeOpenVpn, parseOpenVpn } from './openvpn'
import { Health } from './health'
import { Engine } from './engine'
import { peekClip } from './clip'
import { adapters, conflicts } from './guard'
import { isAdmin, POWERSHELL } from './ps'
import { Store } from './store'
import { dropServer } from './store-core'
import { startBridge } from './bridge'
import { createApply, onRoutingPatch, selectVia, type ApplyResult } from './apply'
import { defaultRoutes, tunPreflight, tunSnapshot } from './tun'
import { bounded } from './stop'
import { createResume, underlayReady } from './resume'
import { scanScreenQr } from './qr'
import { verifyEngine } from './integrity'
import { subscriptionCredentialKey, subscriptionEntryKey } from './subscription'
import { trayPresentation } from './tray-view'
import { effectiveRoutes, moodOf } from '../shared/effective'
import { bridgeStatus, companionEditsOk, companionRoutesSafe, createPending, ensureIntent, listCompanion, parseTarget, routeFor, routeOf, safeVia, sameTarget } from '../shared/companion'
import { AUTO_BUDGET, AUTO_ID, autoMembers, checkSample } from '../shared/groups'
import { classify } from '../shared/evidence'
import { probeLayers } from './layered'
import { activeIds, diagnosisSet, learn, type NetMemory } from '../shared/netmemory'
import { loadMem, saveMem } from './netmem-store'
import { networkFingerprint } from './netid'
import { SerialGate } from './serial'

// one copy only: a second launch (also from the tray-hidden state) just brings the running window up (second-instance -> show)
if (!app.requestSingleInstanceLock()) app.exit(0)

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
let notices: Notice[] = []
let bridgeError = false
let engineIntegrity = false
let relaunching = false
let bridgeServer: ReturnType<typeof startBridge> | undefined
const qrImports = new Map<string, { text: string; expires: number }>()
/** Settings/routing intent crosses renderer IPC and the local companion bridge. Keep those mutations FIFO across awaits. */
const intentWrites = new SerialGate()

const engineExe = app.isPackaged
  ? join(process.resourcesPath, 'engine', 'sing-box.exe')
  : join(app.getAppPath(), 'engine', 'sing-box.exe')

let store: Store
let engine: Engine

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
  return { admin, profiles: store.views(), settings: store.settings, status: statusView(engine.status), notices }
}

/** HOTFIX-RUNTIME-01 E: the master switch's intent, owned here. Only the master (and a hard block / quit) changes it;
 *  card toggles only decide whether the core is needed right now. */
let masterOpen = false
function setMaster(open: boolean) {
  if (masterOpen === open) return
  masterOpen = open
  send('status', statusView(engine.status)); updateTray()
}
const statusView = (s: Status) => ({ ...withRoutes(s), open: masterOpen })

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
  const view = trayPresentation(engine.status, masterOpen, used.map(x => x.name))
  tray.setImage(trayImage(view.active))
  tray.setToolTip(view.tooltip)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: view.action === 'disconnect' ? 'Отключить Waarp' : 'Подключить Waarp', enabled: (store.profiles.length > 0 || demandsTunnel(store.settings)) && admin, click: () => void intentWrites.run(() => toggle()) },
    { label: 'Показать окно', click: show },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit() } }
  ]))
}

async function refreshNotices() {
  const list = await adapters()
  // A full-route VPN may be the underlay for app-only Waarp routes. It is unsafe only when
  // Waarp also owns the default route. Address collisions are still blocked for profiles
  // actually selected by an enabled route; unused profiles never participate here.
  const plan = compilePlan(store.settings, store.profiles)
  const required = new Set(plan.requiredProfiles)
  // A conflicting backup must not block an unrelated healthy primary. Guard only the
  // credentials that the compiled plan needs now; standby health is reported beside the route.
  notices = conflicts(
    store.profiles.filter(p => required.has(p.id)),
    list.filter(a => a.name !== 'Waarp'),
    'Waarp',
    plan.scope === 'cards'
  )
  if (bridgeError) notices.unshift({ level: 'warn', title: 'Связь с приложениями отключена', text: 'Windows не подтвердил закрытый доступ к токену локального моста. Waarp продолжает работать самостоятельно.' })
  if (!engineIntegrity) notices.unshift({ level: 'block', title: 'Движок Waarp повреждён', text: 'Контрольная сумма sing-box или его библиотеки не совпадает со сборкой. Переустанови Waarp; запуск туннеля заблокирован.' })
  if (store.secureOff) notices.unshift({ level: 'warn', title: 'Ключи не сохраняются', text: 'Защищённое хранилище Windows сейчас недоступно, поэтому Waarp держит туннели только до закрытия и ничего не пишет на диск открытым текстом.' })
  if (store.unreadable) notices.unshift({ level: 'warn', title: 'Старые настройки не прочитались', text: store.unreadableCopy ? `Копия: ${basename(store.unreadable)}. Исходный файл не изменён; новые настройки пока не сохраняются. Восстанови файл перед продолжением.` : 'Копию создать не удалось. Исходный файл не изменён; новые настройки пока не сохраняются. Проверь доступ к диску и восстанови файл.' })
  if (!admin) notices.unshift({ level: 'block', title: 'Нужны права администратора', text: 'Чтобы создать свой сетевой адаптер, Waarp нужны права админа. Нажми «Перезапустить как админ».', action: 'relaunch-admin' })
  send('snapshot', snapshot())
  return notices
}

async function connect() {
  if (!demandsTunnel(store.settings)) return { ok: false, error: store.profiles.length ? 'Ни одна карточка не идёт через сервер. Выбери сервер хотя бы для одной' : 'Сначала добавь конфиг' }
  if (engine.status.phase === 'on' || engine.status.phase === 'starting') return { ok: true }
  const ready = await prepareStart({ stopChecker: () => (checker ? checker.stop() : Promise.resolve(true)), notices: refreshNotices })
  if (!ready.ok) return ready
  await engine.start(store.profiles, store.settings)
  const up = (engine.status as Status).phase === 'on'
  if (up) setMaster(true)
  return up ? { ok: true } : { ok: false, error: engine.status.error }
}

async function toggle() {
  if (engine.status.phase === 'on' || engine.status.phase === 'starting') { setMaster(false); return (await engine.stop()) ? { ok: true } : { ok: false, error: engine.status.error } }
  if (masterOpen) { setMaster(false); return { ok: true } }
  return connect()
}

let watchBusy = false
async function watch() {
  if (engine.status.phase !== 'on') return
  if (watchBusy) return
  watchBusy = true
  try {
    const n = await refreshNotices()
    const block = n.find(x => x.level === 'block')
    if (!block || engine.status.phase !== 'on') return
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
  const args = process.argv.slice(1).map(a => `'${a.replace(/'/g, "''")}'`).join(',')
  const exe = process.execPath.replace(/'/g, "''")
  const cmd = `Start-Process -FilePath '${exe}' ${args ? `-ArgumentList ${args}` : ''} -Verb RunAs`
  // The elevated copy must be able to acquire the single-instance mutex. Release it before
  // Windows starts the new process; reacquire it if UAC is cancelled or launching fails.
  app.releaseSingleInstanceLock()
  execFile(POWERSHELL, ['-NoProfile', '-Command', cmd], { windowsHide: true }, err => {
    if (!err) { quitting = true; app.exit(0); return }
    app.requestSingleInstanceLock()
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
  secureIntentHandle('toggle', () => toggle())
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
  const addProfiles = (fresh: Profile[], routeFirst = false): boolean => {
    const previousProfiles = store.profiles, previousSettings = store.settings
    const first = routeFirst && previousProfiles.length === 0
    store.profiles = [...previousProfiles, ...fresh]
    if (first) store.settings = { ...store.settings, routes: store.settings.routes.map(r => r.via === 'direct' ? r : { ...r, via: fresh[0].id }) }
    try { store.save(); send('snapshot', snapshot()); return true }
    catch { store.profiles = previousProfiles; store.settings = previousSettings; return false }
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
  secureHandle('discover:add', async (_e, raw: unknown) => {
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
    if (engine.status.phase !== 'off') return { ...catalog?.state, error: 'Обновление продолжится после отключения Waarp' }
    return await catalog?.refresh()
  })
  secureHandle('catalog:add', async (_e, id: unknown) => {
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
    const gid = 'g-public'
    store.settings = { ...store.settings, groups: [...(store.settings.groups ?? []).filter(g => g.id !== gid), { id: gid, name: 'Публичный · авто', policy: 'fastest', members: top }] }
    try { store.save() }
    catch { store.profiles = previousProfiles; store.settings = previousSettings; return { ok: false, error: 'Не удалось сохранить группу публичных узлов' } }
    await refreshNotices(); send('snapshot', snapshot())
    return { ok: true, id: gid }
  })
  secureIntentHandle('settings', async (_e, raw: unknown) => {
    const blocked = writeError(); if (blocked) { send('toast', blocked); return snapshot() }
    const checked = checkedPatch(raw)
    if (!checked.ok) { send('toast', checked.error); return snapshot() }
    const patch = checked.patch // C09: reject malformed IPC instead of silently dropping fields
    // companion routes: never created or redefined by the renderer, never a public / unsafe path or fallback
    if (patch.routes && !companionEditsOk(patch.routes, store.settings.routes)) { send('toast', 'Маршрут приложения нельзя создать или переопределить вручную'); return snapshot() }
    if (('routes' in patch || 'groups' in patch) && !companionRoutesSafe({ routes: patch.routes ?? store.settings.routes, groups: patch.groups ?? store.settings.groups }, store.profiles)) { send('toast', COMPANION_SAFE); return snapshot() }
    const routing = ['rest', 'routes', 'ruDirect', 'dnsAll', 'lanDirect', 'groups'].some(k => k in patch)
    const previous = store.settings
    store.settings = { ...store.settings, ...patch }
    if ('autostart' in patch && !(await setAutostart(!!patch.autostart))) {
      store.settings = previous
      send('toast', 'Не удалось изменить автозапуск Windows')
      return snapshot()
    }
    try { store.save() }
    catch {
      store.settings = previous
      if ('autostart' in patch) void setAutostart(previous.autostart)
      send('toast', 'Не удалось сохранить настройки'); return snapshot()
    }
    if (routing) {
      if (engine.status.phase === 'on' && demandsTunnel(store.settings) && (await engine.applyLive(store.profiles, store.settings))) { updateTray(); return snapshot() }
      const currentNotices = await refreshNotices()
      const action = onRoutingPatch(engine.status.phase, currentNotices.some(n => n.level === 'block'))
      if (action === 'stop') await engine.stop()
      else if (action === 'start') await engine.start(store.profiles, store.settings)
      else if (masterOpen && demandsTunnel(store.settings) && !currentNotices.some(n => n.level === 'block')) await engine.start(store.profiles, store.settings)
    }
    updateTray()
    if (!routing) send('snapshot', snapshot())
    return snapshot()
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
  secureHandle('profile:import', async (_e, raw: unknown) => {
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
        if (!addProfiles([p], true)) return { ok: false, error: 'Не удалось сохранить конфиг' }
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
        if (!addProfiles(fresh, true)) return { ok: false, error: 'Не удалось сохранить серверы' }
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
      if (!addProfiles([p], true)) return { ok: false, error: 'Не удалось сохранить конфиг' }
      await refreshNotices()
      updateTray()
      return { ok: true, added: 1, id: p.id, ids: [p.id], name: p.name, skipped: 0, notApplied: [] as string[] }
    } catch (e) {
      return { ok: false, error: e instanceof ConfError ? e.message : 'Не получилось прочитать конфиг' }
    }
  })
  secureHandle('profile:create-wg', async (_e, raw: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Неверные данные сервера' }
    const values = raw as Record<string, unknown>
    if (!['name', 'address', 'endpoint', 'serverPublicKey'].every(k => typeof values[k] === 'string')) return { ok: false, error: 'Неверные данные сервера' }
    const name = profileName(values.name)
    if (!name) return { ok: false, error: 'Неверное имя туннеля' }
    try {
      const { profile, clientPublicKey } = createWireGuardProfile({ ...(values as { name: string; address: string; endpoint: string; serverPublicKey: string }), name })
      if (!addProfiles([profile], true)) return { ok: false, error: 'Не удалось сохранить конфиг' }
      await refreshNotices(); updateTray()
      return { ok: true, added: 1, id: profile.id, ids: [profile.id], name: profile.name, clientPublicKey }
    } catch (e) { return { ok: false, error: e instanceof ConfError ? e.message : 'Не удалось создать конфиг' } }
  })
  secureHandle('profile:refresh-sub', async (_e, id: unknown) => {
    const blocked = writeError(); if (blocked) return { ok: false, error: blocked }
    if (typeof id !== 'string' || id.length > 80) return { ok: false, error: 'Подписка не найдена' }
    if (engine.status.phase !== 'off') return { ok: false, error: 'Отключи Waarp перед обновлением подписки' }
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
      const byEntry = new Map(incoming.map(p => [subscriptionEntryKey(p), p]))
      const byCredential = new Map<string, typeof incoming>()
      for (const p of incoming) {
        const key = subscriptionCredentialKey(p)
        byCredential.set(key, [...(byCredential.get(key) ?? []), p])
      }
      const usedIncoming = new Set<string>()
      let updated = 0, missing = 0
      const next = oldProfiles.map(p => {
        if (!((p.kind === 'vless' || p.kind === 'out') && p.sub === sub)) return p
        const key = p.subKey ?? subscriptionEntryKey(p)
        const legacyCandidates = p.subKey ? [] : byCredential.get(subscriptionCredentialKey(p)) ?? []
        const fresh = byEntry.get(key) ?? (legacyCandidates.length === 1 ? legacyCandidates[0] : undefined)
        if (!fresh) { missing++; return { ...p, subMissing: true } }
        const freshKey = subscriptionEntryKey(fresh)
        usedIncoming.add(freshKey); updated++
        return { ...fresh, id: p.id, name: p.name, addedAt: p.addedAt, source: p.source, revoked: p.revoked, sub, subKey: freshKey, subMissing: false } as Profile
      })
      const identities = new Set(next.map(credentialKey))
      const added: Profile[] = []
      for (const p of incoming) {
        const key = subscriptionEntryKey(p)
        if (usedIncoming.has(key) || identities.has(credentialKey(p))) continue
        p.sub = sub; p.subKey = key; p.subMissing = false; identities.add(credentialKey(p)); added.push(p)
      }
      store.profiles = [...next, ...added]
      try { store.save() }
      catch { store.profiles = oldProfiles; return { ok: false, error: 'Не удалось сохранить обновление; прежний список оставлен без изменений' } }
      await refreshNotices(); updateTray(); send('snapshot', snapshot())
      return { ok: true, updated, added: added.length, missing, skipped: parsed.skipped }
    } catch (e) {
      return { ok: false, error: e instanceof ConfError ? e.message : 'Не удалось обновить подписку; прежний список сохранён' }
    }
  })
  secureHandle('profile:replace', async (_e, id: unknown, raw: unknown) => {
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
    if (checker && !(await checker.stop())) return { ok: false, error: 'Проверочный движок не остановился; конфиг не изменён' }
    const wasOn = engine.status.phase === 'on'
    if (wasOn && !(await engine.stop())) return { ok: false, error: 'Туннель не удалось остановить; конфиг не изменён' }
    store.profiles[index] = { ...fresh, id: old.id, name: old.name, addedAt: old.addedAt, source: old.source, revoked: old.revoked } as Profile
    try { store.save() }
    catch {
      store.profiles[index] = old
      if (wasOn) void connect()
      return { ok: false, error: 'Не удалось сохранить конфиг; прежний туннель восстановлен' }
    }
    await refreshNotices()
    updateTray()
    if (wasOn) {
      const result = await connect()
      if (!result.ok) {
        await engine.stop()
        store.profiles[index] = old
        try { store.save() }
        catch { return { ok: false, error: 'Новый конфиг не запустился, а прежний не удалось записать обратно. Туннель остановлен; восстанови конфиг из источника.' } }
        const restored = await connect()
        if (restored.ok) return { ok: false, error: 'Новый конфиг не запустился. Waarp восстановил прежний рабочий конфиг.' }
        return { ok: false, error: 'Новый конфиг не запустился. Прежний конфиг восстановлен на диске, но его запуск тоже не удался.' }
      }
    }
    return { ok: true }
  })
  secureHandle('profile:rename', (_e, id: unknown, rawName: unknown) => {
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
    const ok = typeof replace === 'string' && replace !== id && store.views().some(v => v.id === replace)
    const previousProfiles = store.profiles, previousSettings = store.settings
    if (checker && !(await checker.stop())) return { ok: false, error: 'Проверочный движок не остановился; туннель не удалён' }
    const wasOn = engine.status.phase === 'on'
    if (wasOn && !(await engine.stop())) return { ok: false, error: 'Туннель не удалось остановить; профиль не удалён' }
    store.profiles = store.profiles.filter(x => x.id !== id)
    store.settings = dropServer(store.settings, id, ok ? (replace as string) : undefined)
    try { store.save() }
    catch {
      store.profiles = previousProfiles; store.settings = previousSettings
      if (wasOn) void connect()
      return { ok: false, error: 'Не удалось сохранить удаление; туннель оставлен без изменений' }
    }
    await refreshNotices()
    updateTray()
    if (wasOn && demandsTunnel(store.settings)) {
      const result = await connect()
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
    const [direct, via] = await Promise.all([directProbe(target), checker && subset.length && (await checker.ensure(subset, await adapters())) ? checker.probe(target, pick.ids) : Promise.resolve({} as Record<string, number | null>)])
    return { direct, ...via }
  })
  /** W3.2: layered Direct evidence + own eligible paths (bounded, never public) -> a cautious finding */
  secureHandle('diagnose', async (_e, t: unknown) => {
    const target = probeTarget(t)
    if (!target) return null
    // "in use" = carrying traffic now (required, picked, effective), not every Auto standby candidate
    const st = withRoutes(engine.status)
    const used = activeIds(compilePlan(store.settings, store.profiles).requiredProfiles, st.picked, Object.values(st.routes ?? {}).map(e => e.effective), new Set(store.profiles.map(p => p.id)))
    const host = target.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').toLowerCase()
    const net = await networkFingerprint(netMem.salt)
    const now = Date.now()
    // memory only orders which own paths this diagnosis checks; it never touches routes or runtime Auto
    const eligible = diagnosisSet(autoMembers(store.profiles), used, netMem.data, net, host, now, AUTO_BUDGET)
    const viaPaths = async (): Promise<Record<string, number | null>> => {
      if (!eligible.length) return {}
      if (engine.status.phase === 'on') return engine.probePaths(target, eligible)
      // the checker is built from the bounded set only, never the whole library
      const subset = store.profiles.filter(p => eligible.includes(p.id))
      return checker && (await checker.ensure(subset, await adapters())) ? checker.probe(target, eligible) : {}
    }
    const [direct, all] = await Promise.all([probeLayers(target), viaPaths()])
    const paths: Record<string, number | null> = {}
    for (const id of eligible) if (id in all) paths[id] = all[id]
    const finding = classify(direct, paths)
    if (net) { netMem.data = learn(netMem.data, net, host, finding, autoMembers(store.profiles), now); saveNetMem() }
    return { target, direct, paths, finding }
  })
  secureHandle('log', () => engine.log())
  secureHandle('net:reset', async () => {
    const checkerStopped = (await checker?.stop()) !== false
    const engineStopped = await engine.stop()
    const checkerRecovered = (await checker?.recover()) !== false
    const catalogRecovered = (await catalog?.recover()) !== false
    const related = checkerStopped && checkerRecovered && catalogRecovered
    const recovered = await engine.killOrphans(related); await refreshNotices()
    return engineStopped && recovered
      ? { ok: true }
      : { ok: false, error: 'Не всё удалось закрыть безопасно. Перезапусти Waarp; чужие сетевые настройки не изменялись.' }
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
  store = new Store(app.getPath('userData'))
  loadNetMem(app.getPath('userData'))
  engineIntegrity = verifyEngine(engineExe)
  engine = new Engine(engineExe, join(app.getPath('userData'), 'engine'), process.execPath)
  // R1.4: read-only check for a leftover Waarp adapter or a taken service subnet before every TUN start
  engine.preflight = async () => tunPreflight(await tunSnapshot())
  checker = engineIntegrity ? new Checker(engineExe, join(app.getPath('userData'), 'check')) : undefined
  catalog = new Catalog(join(app.getPath('userData'), 'catalog'), engineExe, s => send('catalog', s))
  discovery = new Discovery()
  // Public catalog refreshes in the background; a failure leaves the last usable snapshot intact.
  const refreshCatalog = () => {
    if (engineIntegrity && engine.status.phase === 'off' && !powerMonitor.isOnBatteryPower()) void catalog?.refresh().catch(() => undefined)
  }
  if (!catalog.state.updatedAt || Date.now() - catalog.state.updatedAt > 30 * 60 * 1000) { const t = setTimeout(refreshCatalog, 3000); t.unref() }
  const catalogTimer = setInterval(refreshCatalog, 30 * 60 * 1000); catalogTimer.unref()
  // Showing the shell must not wait for PowerShell, orphan recovery, or network-related cleanup.
  // Those checks finish immediately after first paint and update the same snapshot.
  const adminReady = isAdmin()
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
  admin = await adminReady
  const checkerRecovered = (await checker?.recover()) !== false
  const catalogRecovered = await catalog.recover()
  const relatedRecovered = checkerRecovered && catalogRecovered
  await engine.killOrphans(relatedRecovered)
  void refreshNotices()
  if (store.settings.autoConnect && admin && demandsTunnel(store.settings)) void connect()
  // R4: one restart per resume, after a usable network is back; never overlapping, never a churn loop
  const sleepWake = createResume({
    isOn: () => masterOpen && (engine.status.phase === 'on' || engine.status.phase === 'starting'),
    netReady: async () => underlayReady(net.isOnline(), await defaultRoutes()),
    restart: () => intentWrites.run(async () => {
      // The owner may have closed Waarp during the settle/network-wait window. Never resurrect it afterwards.
      if (!masterOpen) return true
      const n = await refreshNotices()
      if (n.some(x => x.level === 'block') || !demandsTunnel(store.settings)) { await engine.stop(); return true }
      await engine.start(store.profiles, store.settings)
      return engine.status.phase === 'on'
    }),
    fail: why => intentWrites.run(async () => {
      // A deliberate close while resume was waiting wins over the stale wake intent and needs no error toast.
      if (!masterOpen) return
      if (engine.status.phase !== 'error') await engine.stop()
      setMaster(false)
      const msg = why === 'no_network' ? 'После сна сеть не вернулась. Waarp закрыт, включи его, когда интернет появится' : 'После сна Waarp не смог переподключиться и закрыт'
      send('toast', msg); notify(msg)
    }),
  })
  powerMonitor.on('suspend', () => sleepWake.suspend())
  powerMonitor.on('resume', () => sleepWake.resume())
  const watchTimer = setInterval(watch, 15000); watchTimer.unref()
  // tunnel off: bounded rotating checks plus a public resolver, so the analyzer stays useful without a probe storm
  const offHealth = new Health()
  let offPingBusy = false
  let offPingCursor = 0
  const offPing = async (): Promise<void> => {
    if (engine.status.phase !== 'off' || offPingBusy || catalog?.state.busy || !win?.isVisible()) return
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
      const ok = !!checker && selected.length > 0 && (await checker.ensure(selected, await adapters()))
      const via = ok && checker ? await checker.pings() : {}
      await Promise.all([...profiles.map(async p => { pings[p.id] = via[p.id] ?? (checker?.busy.has(p.id) ? undefined : await icmp(p.host)) }), (async () => { pings.direct = await icmp('1.1.1.1') })()])
      const health = offHealth.step(via, profiles.map(p => p.id), checker?.busy)
      if (engine.status.phase === 'off') send('status', withRoutes({ ...engine.status, engine: 'down', pings, health: ok ? health : undefined, offline: true, busy: checker ? [...checker.busy] : [] }))
      else void checker?.stop()
    } finally { offPingBusy = false }
  }
  void offPing(); const offPingTimer = setInterval(() => void offPing(), 30000); offPingTimer.unref()
})

/** R2.2: quit waits for the verified stop (graceful core close, residue check), with a hard bound; never hangs */
const SHUTDOWN_MS = 15_000
let shutdown: Promise<void> | undefined
let shutdownDone = false
const tunnelActive = (): boolean => !!engine && ['on', 'starting', 'stopping'].includes(engine.status.phase)
function shutdownGate(): Promise<void> {
  shutdown ??= (async () => {
    const r = await bounded((async () => { await checker?.stop(); await engine?.stop() })(), SHUTDOWN_MS)
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
/** R5: rotation cursor for tunnel-closed probes (bounded checker set) */
let probeCursor = 0
const viewName = (v: string): string | undefined => store.views().find(p => p.id === v)?.name ?? (v === AUTO_ID ? 'Авто' : undefined)

/** save routing settings like route:select does: a running engine restarts with the plan, a closed one stays closed */
const applyRouting = createApply({
  get: () => store.settings,
  set: s => { store.settings = s },
  save: () => store.save(),
  phase: () => engine.status.phase,
  open: () => masterOpen,
  blocked: async () => (await refreshNotices(), notices.some(n => n.level === 'block')),
  demandsTunnel,
  start: s => engine.start(store.profiles, s),
  live: s => engine.applyLive(store.profiles, s),
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
