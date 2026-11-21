// Real portable-wrapper acceptance on a disposable Windows runner. No ASAR
// patches, renderer fixtures, product test hooks, VPN activation or UAC bypass.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const BUDGET_MS = 240_000
const PROFILE = { name: 'Portable lifecycle loopback', host: '127.0.0.1', port: 9, kind: 'vless' }
const UUID = '00000000-0000-4000-8000-000000000007'
const LINK = `vless://${UUID}@127.0.0.1:9?type=tcp&security=none&encryption=none#${encodeURIComponent(PROFILE.name)}`
const NOT_RUN = [
  { check: 'UAC consent / refusal', reason: 'No elevation is requested. A hosted runner can already be elevated; absence of a prompt proves neither consent nor refusal.' },
  { check: 'Different-version upgrade / migration / rollback', reason: 'The stopped EXE is replaced with the same candidate bytes; no version transition is exercised.' },
  { check: 'Sleep / resume / real network change / another VPN', reason: 'This bounded scenario does not control those environments.' },
  { check: 'VPN / TUN routing / public connectivity', reason: 'The master remains OFF. Existing native acceptance is separate; ordinary background probes may still run.' },
  { check: 'Installer uninstall / ordinary-user ACLs', reason: 'This is a portable wrapper on a disposable CI account, not an installer or a standard-user acceptance session.' }
].map(item => ({ ...item, status: 'NOT_RUN' }))

export const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase()
export function inside(root, path) {
  if (typeof path !== 'string' || !path) return false
  const relative = win32.relative(win32.resolve(root).toLowerCase(), win32.resolve(path).toLowerCase())
  return !!relative && !win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\')
}
export const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && a.started === b.started && samePath(a.exe, b.exe)
export function processTicks(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(value)
  assert(match, 'Process creation timestamp must be canonical UTC')
  const seconds = Date.parse(match[1] + 'Z')
  assert(Number.isFinite(seconds) && new Date(seconds).toISOString().slice(0, 19) === match[1], 'Invalid process creation timestamp')
  // Date.parse truncates sub-millisecond precision. Preserve all CIM/.NET
  // fractional digits before deciding whether a process can be a descendant.
  return BigInt(seconds) * 10_000n + BigInt((match[2] ?? '').padEnd(7, '0'))
}

// Never infer ownership from an executable name or a reused PID. Only the
// private directory, an exact previously observed identity, or a live parent
// identity can extend the set. Unrelated process details never enter the report.
export function ownedProcesses(rows, root, known = []) {
  const owned = new Map(rows.filter(p => inside(root, p.exe) || known.some(k => sameProcess(k, p))).map(p => [p.pid, p]))
  let changed = true
  while (changed) {
    changed = false
    for (const p of rows) {
      const parent = owned.get(p.ppid)
      if (!owned.has(p.pid) && parent && processTicks(p.started) >= processTicks(parent.started)) {
        owned.set(p.pid, p); changed = true
      }
    }
  }
  return [...owned.values()]
}

export function assertState(snap, expectedId) {
  assert.equal(snap.status.startup, 'ready', 'Startup recovery must be ready')
  assert.equal(snap.status.phase, 'off', 'VPN must remain OFF')
  assert.equal(snap.status.open, false, 'Master intent must remain OFF')
  assert.equal(snap.settings.autoConnect, false, 'Auto-connect must stay disabled')
  assert.equal(snap.settings.autostart, false, 'Autostart must stay disabled')
  assert.equal(snap.settings.rest, 'direct')
  assert.deepEqual(snap.settings.routes, [])
  assert.deepEqual(snap.settings.groups, [])
  assert(!snap.settings.serviceVia || snap.settings.serviceVia === 'direct')
  if (expectedId === undefined) assert.equal(snap.profiles.length, 0, 'First launch must have an empty profile store')
  else {
    assert.equal(snap.profiles.length, 1, 'Exactly one synthetic profile must survive')
    const p = snap.profiles[0]
    for (const [key, value] of Object.entries(PROFILE)) assert.equal(p[key], value, `Restored profile ${key}`)
    assert.equal(p.id, expectedId, 'Profile identity must survive restart')
    assert.equal(snap.settings.tray, false)
    assert.equal(snap.settings.notify, false)
  }
}

export function assertEncryptedStore(text) {
  const disk = JSON.parse(text)
  assert.equal(disk.profiles?.length, 1)
  assert.match(disk.profiles[0], /^e:[A-Za-z0-9+/]+={0,2}$/, 'Only the encrypted DPAPI envelope is accepted')
  assert(!text.includes(UUID) && !text.includes(PROFILE.name), 'Profile plaintext must not appear on disk')
  for (const name of ['tray', 'notify', 'autoConnect', 'autostart']) assert.equal(disk.settings[name], false, `Persisted ${name}`)
  return { profileCount: 1, encryptedEnvelope: true, plaintextSyntheticCredentialAbsent: true,
    settings: { tray: false, notify: false, autoConnect: false, autostart: false } }
}

export function assertIdentity(identity, paths, wrapper, rows) {
  assert.equal(identity.isPackaged, true, 'A packaged app must be running')
  assert.equal(identity.version, paths.version)
  assert.equal(identity.encryptionAvailable, true, 'Windows secure storage must be available')
  assert(samePath(identity.userData, paths.userData), 'Actual Electron userData must be isolated')
  assert(samePath(identity.portableFile, paths.portable), 'The shipped portable wrapper must own this app')
  assert(inside(paths.temp, identity.execPath), 'Extracted executable must remain in the private TEMP directory')
  assert(samePath(identity.appPath, win32.join(identity.resourcesPath, 'app.asar')), 'Only the packaged ASAR is accepted')
  assert(inside(paths.temp, identity.appPath), 'ASAR must be inside the private extraction directory')
  const main = rows.find(p => p.pid === identity.pid && samePath(p.exe, identity.execPath))
  assert(main, 'Main process must exist in the OS process inventory')
  const parent = rows.find(p => p.pid === main.ppid)
  assert(sameProcess(parent, wrapper), 'Main process must be a direct child of this portable wrapper')
  assert(processTicks(main.started) >= processTicks(wrapper.started))
  return main
}

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const psQuote = value => "'" + value.replaceAll("'", "''") + "'"
const processInventory = `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -and $_.ExecutablePath } | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId;
    started = $_.CreationDate.ToUniversalTime().ToString('o'); exe = $_.ExecutablePath }
})
ConvertTo-Json -InputObject $rows -Compress
`
async function powershell(code, timeout = 5000) {
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code],
    { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' })
  assert.equal(result.stderr.trim(), '', 'Process inventory must not return partial-error output')
  return result.stdout.trim()
}
async function inventory(timeout = 5000) {
  const rows = JSON.parse(await powershell(processInventory, timeout))
  assert(Array.isArray(rows) && rows.length <= 10_000, 'Process inventory must be complete and bounded')
  assert(rows.every(p => Number.isSafeInteger(p.pid) && Number.isSafeInteger(p.ppid) && typeof processTicks(p.started) === 'bigint' && typeof p.exe === 'string'))
  return rows
}
async function freePorts() {
  const servers = [createServer(), createServer()]
  try {
    // Hold both reservations until both numbers are known; sequential close /
    // reallocation can otherwise select the same ephemeral port twice.
    const results = await Promise.allSettled(servers.map(server => new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })))
    for (const result of results) if (result.status === 'rejected') throw result.reason
    return servers.map(server => server.address().port)
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise((yes, no) => server.close(error => error ? no(error) : yes()))))
  }
}
async function bounded(promise, ms, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function inspectIdentity(url, budget) {
  const until = Date.now() + budget
  const socket = new WebSocket(url)
  try {
    await bounded(new Promise((yes, no) => { socket.addEventListener('open', yes, { once: true }); socket.addEventListener('error', no, { once: true }) }), Math.min(5000, budget), 'Main inspector connection')
    // The inspector may listen before Electron has loaded its application. Wait
    // for app.ready without pausing execution or installing any code in the app.
    for (let id = 1; Date.now() < until; id++) {
      let onMessage
      const response = new Promise((yes, no) => {
        onMessage = event => { const msg = JSON.parse(event.data); if (msg.id === id) msg.error ? no(new Error(msg.error.message)) : yes(msg.result) }
        socket.addEventListener('message', onMessage)
      })
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { returnByValue: true,
        expression: `(() => { if (!process.mainModule) return { ready: false };
          const { app, safeStorage } = process.mainModule.require('electron');
          if (!app.isReady()) return { ready: false }; return { ready: true,
          pid: process.pid, execPath: process.execPath, resourcesPath: process.resourcesPath,
          portableFile: process.env.PORTABLE_EXECUTABLE_FILE, userData: app.getPath('userData'),
          appPath: app.getAppPath(), version: app.getVersion(), isPackaged: app.isPackaged,
          encryptionAvailable: safeStorage.isEncryptionAvailable() }; })()` } }))
      let result
      try { result = await bounded(response, Math.min(5000, until - Date.now()), 'Main identity read') }
      finally { socket.removeEventListener('message', onMessage) }
      assert(!result.exceptionDetails, 'Read-only main identity expression must succeed')
      if (result.result.value?.ready) return result.result.value
      await delay(100)
    }
    throw new Error('Main identity readiness timed out')
  } finally { socket.close() }
}

export async function run(args = process.argv.slice(2)) {
  const started = Date.now()
  const deadline = started + BUDGET_MS - 10_000 // Reserve cleanup time within the scenario budget.
  const output = resolve('out/validation/portable-lifecycle.json')
  const report = { schemaVersion: 1, task: 'REL-007', sourceCommit: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    platform: process.platform, startedAt: new Date(started).toISOString(), budgetMs: BUDGET_MS,
    status: 'NOT_RUN', passed: false, plannedLaunches: 3, launches: [], notRun: NOT_RUN,
    productHooks: false, changedApplicationBytes: false, vpnActivationRequested: false }
  let root, portable, current, browser
  const known = new Map()
  const remaining = (max = 10_000) => { const n = Math.min(max, deadline - Date.now()); assert(n > 0, 'Scenario deadline exceeded'); return n }
  const keep = rows => { for (const p of rows) known.set(`${p.pid}:${p.started}`, p); return rows }
  const owned = async (timeout = remaining(5000)) => keep(ownedProcesses(await inventory(timeout), root, [...known.values()]))
  const summarizeProcess = p => ({ pid: p.pid, parentPid: p.ppid, startedAt: p.started,
    executable: inside(root, p.exe) ? '$TEST/' + win32.relative(root, p.exe).replaceAll('\\', '/') : basename(p.exe) })
  const poll = async (label, read, accept, budget) => {
    const until = Math.min(deadline, Date.now() + budget)
    while (Date.now() < until) {
      const value = await bounded(read(), Math.min(10_000, until - Date.now()), label)
      if (accept(value)) return value
      await delay(Math.min(250, Math.max(0, until - Date.now())))
    }
    throw new Error(`${label} timed out`)
  }
  try {
    assert.equal(process.platform, 'win32', 'Windows portable runtime is NOT_RUN on this platform')
    assert(args.length === 1 && args[0] === '--disposable-windows', 'Requires --disposable-windows')
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Requires a disposable GitHub-hosted runner')
    report.status = 'FAIL'
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'))
    const validation = JSON.parse(readFileSync('out/validation/package-integrity.json', 'utf8'))
    const candidate = resolve(`dist/Waarp-${metadata.version}-portable.exe`)
    const unpackedAsar = resolve('dist/win-unpacked/resources/app.asar')
    assert(validation.passed === true && validation.commit === process.env.GITHUB_SHA && validation.version === metadata.version, 'Prior package verification must bind this source and version')
    assert(/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? ''), 'CI source SHA is required')
    assert(!lstatSync(candidate).isSymbolicLink() && lstatSync(candidate).isFile())
    assert(!lstatSync(unpackedAsar).isSymbolicLink() && lstatSync(unpackedAsar).isFile())
    const digest = sha256(candidate), asarDigest = sha256(unpackedAsar)
    assert.equal(digest, validation.portableSha256, 'Candidate must match package:verify')
    assert.equal(statSync(candidate).size, validation.portableBytes)
    assert.equal(statSync(unpackedAsar).size, validation.asarBytes)
    report.candidate = { version: metadata.version, portableSha256: digest, portableBytes: validation.portableBytes,
      asarSha256: asarDigest, asarBytes: validation.asarBytes, packageVerificationBound: true }
    root = realpathSync(mkdtempSync(join(tmpdir(), 'waarp-portable-acceptance-')))
    const temp = join(root, 'temp'), userData = join(root, 'user-data'), local = join(root, 'local')
    for (const path of [temp, userData, local]) mkdirSync(path)
    portable = join(root, 'Waarp-portable.exe')
    copyFileSync(candidate, portable)
    assert.equal(sha256(portable), digest)
    assert(!existsSync(join(userData, 'waarp.json')), 'Isolated data must start empty')
    const { chromium } = await import('playwright')
    let profileId
    for (const [index, name] of ['first-launch', 'restart', 'same-candidate-replacement'].entries()) {
      assert.deepEqual(await owned(), [], 'No prior owned processes may remain before a launch')
      if (index === 2) {
        const replacement = join(root, 'replacement.exe')
        copyFileSync(candidate, replacement)
        assert.equal(sha256(replacement), digest)
        renameSync(portable, join(root, 'previous.exe'))
        renameSync(replacement, portable)
        assert.equal(sha256(portable), digest)
        rmSync(join(root, 'previous.exe'))
        report.replacement = { stoppedProcessesVerified: true, sameCandidate: true, beforeSha256: digest, afterSha256: digest, completed: true }
      }
      const launch = { name, status: 'FAIL', startedAt: new Date().toISOString(), rendererErrors: [] }
      report.launches.push(launch)
      const [inspectPort, cdpPort] = await bounded(freePorts(), remaining(5000), 'Debug port reservation')
      assert.notEqual(inspectPort, cdpPort)
      const env = { ...process.env, TEMP: temp, TMP: temp, LOCALAPPDATA: local }
      for (const key of ['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR']) delete env[key]
      current = spawn(portable, [`--user-data-dir=${userData}`, `--inspect=127.0.0.1:${inspectPort}`, `--remote-debugging-port=${cdpPort}`],
        { cwd: root, env, stdio: 'ignore', windowsHide: false })
      let exit
      current.once('exit', (code, signal) => { exit = { code, signal, at: new Date().toISOString() } })
      await bounded(new Promise((yes, no) => { current.once('spawn', yes); current.once('error', no) }), remaining(10_000), 'Portable spawn')
      const wrapperRows = await inventory(remaining(5000))
      const wrapper = wrapperRows.find(p => p.pid === current.pid && samePath(p.exe, portable))
      assert(wrapper, 'Portable wrapper PID/path must be visible in the OS inventory')
      keep([wrapper])
      const targets = await poll('Main inspector startup', async () => {
        assert.equal(exit, undefined, 'Wrapper exited before startup')
        try { const r = await fetch(`http://127.0.0.1:${inspectPort}/json/list`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : [] }
        catch { return [] }
      }, list => list.length === 1 && typeof list[0].webSocketDebuggerUrl === 'string', 45_000)
      const inspectorUrl = new URL(targets[0].webSocketDebuggerUrl)
      assert(inspectorUrl.protocol === 'ws:' && inspectorUrl.hostname === '127.0.0.1' && inspectorUrl.port === String(inspectPort), 'Main inspector must remain on its assigned loopback port')
      const identity = await inspectIdentity(inspectorUrl.href, remaining(30_000))
      const rows = await inventory(remaining(5000))
      const main = assertIdentity(identity, { temp, userData, portable, version: metadata.version }, wrapper, rows)
      keep(ownedProcesses(rows, root, [...known.values()]))
      assert.equal(sha256(identity.appPath), asarDigest, 'Extracted ASAR must exactly match the verified package')
      launch.identity = { wrapper: summarizeProcess(wrapper), main: summarizeProcess(main), isolatedUserData: true,
        portableWrapperMatched: true, extractedAsarSha256: asarDigest, encryptionAvailable: true, packaged: true }
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: remaining(30_000) })
      const page = await poll('Packaged renderer startup', async () => browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('file:')), Boolean, 20_000)
      assert(samePath(fileURLToPath(page.url()), join(identity.appPath, 'out/renderer/index.html')), 'Renderer must load from the verified ASAR')
      page.setDefaultTimeout(remaining(10_000))
      page.on('pageerror', error => launch.rendererErrors.push(error.message.slice(0, 1000)))
      await page.locator('.shell').waitFor({ timeout: remaining() })
      const locale = await page.locator('html').getAttribute('lang', { timeout: remaining() })
      assert(/^(ru|en|de|fr|es|pt-BR|zh-Hans|zh-Hant|ja|ko|uk|it|pl|tr|ar|hi|id|vi|fa)$/.test(locale), 'Known UI locale is required')
      const strings = JSON.parse(readFileSync(locale === 'ru' ? 'src/shared/strings/ru.json' : `src/shared/strings/locales/${locale}.json`, 'utf8'))
      launch.locale = locale
      const snapshot = () => page.evaluate(() => window.api.snapshot()) // Existing read-only product IPC.
      const first = await poll('Startup recovery', snapshot, s => s.status.startup === 'ready' || s.status.startup === 'failed', 45_000)
      assertState(first, profileId)
      launch.initialProfileCount = first.profiles.length
      if (index === 0) {
        const dialog = page.getByRole('dialog', { name: strings['add.title'], exact: true })
        await dialog.getByText(strings['add.manual'], { exact: true }).click({ timeout: remaining() })
        await dialog.locator('textarea').fill(LINK, { timeout: remaining() })
        await dialog.getByRole('button', { name: strings['imp.add'], exact: true }).click({ timeout: remaining() })
        await dialog.waitFor({ state: 'hidden', timeout: remaining() })
        const imported = await poll('Synthetic profile import', snapshot, s => s.profiles.length === 1, 10_000)
        profileId = imported.profiles[0].id
        assert(typeof profileId === 'string' && profileId.length > 0)
        await page.getByRole('button', { name: strings['nav.settings'], exact: true }).click({ timeout: remaining() })
        for (const [setting, key] of [['tray', 'set.tray'], ['notify', 'set.notify.down']]) {
          await page.getByRole('checkbox', { name: strings[key], exact: true }).uncheck({ timeout: remaining() })
          await poll(`Persist ${setting}`, snapshot, s => s.settings[setting] === false, 10_000)
        }
        // The expected paths come from the pinned build dependency in this test
        // runner. Only ordinary UI navigation and DOM reads reach the packaged
        // file:// renderer; no module or replacement icon is injected into it.
        const icons = await import('simple-icons')
        const brands = [['YouTube', 'siYoutube'], ['Discord', 'siDiscord'], ['Telegram', 'siTelegram'],
          ['Claude', 'siClaude'], ['Gemini', 'siGooglegemini'], ['Instagram', 'siInstagram'],
          ['X', 'siX'], ['Spotify', 'siSpotify'], ['Dev', 'siGithub']]
        const beforeBrands = await bounded(snapshot(), remaining(10_000), 'State before brand navigation')
        assertState(beforeBrands, profileId)
        launch.brandIcons = { expectedIcons: brands.length, visibleIcons: 0, matchedPaths: 0, passed: false }
        await page.getByRole('button', { name: strings['nav.lib'], exact: true }).click({ timeout: remaining() })
        await page.locator('.page.lib').getByRole('button', { name: strings['route.add'], exact: true }).click({ timeout: remaining() })
        await page.locator('.page.lib .toolbar .seg').getByRole('button')
          .filter({ hasText: strings['lib.services'] }).click({ timeout: remaining() })
        const services = page.locator('section.lib-sec').filter({ has: page.getByRole('heading', { name: strings['lib.services'], exact: true }) })
        for (const [name, key] of brands) {
          const icon = services.locator('.tile').filter({ has: page.getByText(name, { exact: true }) }).locator('.brand-ic > svg')
          await icon.waitFor({ state: 'visible', timeout: remaining() })
          launch.brandIcons.visibleIcons++
          assert.equal(await icon.getAttribute('viewBox', { timeout: remaining() }), '0 0 24 24', `Packaged ${name} SVG geometry`)
          assert.equal(await icon.locator('path').getAttribute('d', { timeout: remaining() }), icons[key].path, `Packaged ${name} brand path`)
          launch.brandIcons.matchedPaths++
        }
        await page.getByRole('button', { name: strings['nav.settings'], exact: true }).click({ timeout: remaining() })
        const afterBrands = await bounded(snapshot(), remaining(10_000), 'State after brand navigation')
        assertState(afterBrands, profileId)
        assert.deepEqual(afterBrands.profiles, beforeBrands.profiles, 'Brand navigation must not change profiles')
        assert.deepEqual(afterBrands.settings, beforeBrands.settings, 'Brand navigation must not change settings or routes')
        Object.assign(launch.brandIcons, { profilesUnchanged: true, settingsUnchanged: true, masterOff: true, passed: true })
      }
      const restored = await bounded(snapshot(), remaining(10_000), 'Final snapshot')
      assertState(restored, profileId)
      launch.persisted = assertEncryptedStore(readFileSync(join(userData, 'waarp.json'), 'utf8'))
      launch.profile = { id: profileId, ...PROFILE }
      launch.masterOff = true
      launch.observedProcesses = (await owned()).map(summarizeProcess)
      assert.deepEqual(launch.rendererErrors, [])
      await page.getByRole('button', { name: strings['win.close'], exact: true }).click({ timeout: remaining() })
      await poll('Normal portable exit', async () => exit, Boolean, 25_000)
      assert.equal(exit.code, 0, 'Portable wrapper must exit successfully')
      assert.equal(exit.signal, null, 'Normal exit must not use a termination signal')
      await poll('Owned-process exit', owned, rows => rows.length === 0, 10_000)
      launch.exit = { ...exit, requestedBy: 'existing window close button with tray disabled', ownedProcessesRemaining: 0, forced: false }
      launch.status = 'PASS'
      current = undefined
      await bounded(browser.close(), remaining(5000), 'CDP disconnect after exit')
      browser = undefined
    }
    assert.equal(report.launches.length, 3)
    assert.equal(sha256(candidate), digest, 'Original build candidate must remain unchanged')
    assert.equal(sha256(unpackedAsar), asarDigest, 'Original build ASAR must remain unchanged')
    report.passed = true; report.status = 'PASS'
  } catch (error) {
    report.error = String(error?.message ?? error).slice(0, 2000)
  } finally {
    // A forced cleanup is evidence of failure, never a successful normal exit.
    if (root) {
      try {
        const cleanupTime = () => { const ms = Math.min(5000, started + BUDGET_MS - Date.now()); assert(ms > 0, 'Cleanup deadline exceeded'); return ms }
        const survivors = await owned(cleanupTime())
        report.cleanup = { observedSurvivors: survivors.map(summarizeProcess), forced: survivors.length > 0 }
        if (survivors.length) {
          report.passed = false; report.status = 'FAIL'
          // Pin a .NET process handle before checking creation time/path. Kill
          // through that object, never by image name or a subsequently reused PID.
          // CIM timestamps have microsecond precision; compare at that precision.
          const entries = survivors.sort((a, b) => processTicks(a.started) < processTicks(b.started) ? 1 : -1)
            .map(p => `@{ pid=${p.pid}; started=${psQuote(p.started)}; exe=${psQuote(p.exe)} }`).join(',')
          await powershell(`$ErrorActionPreference='Stop'; foreach ($entry in @(${entries})) {
            $p=Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
            if ($p) { try { $handle=$p.Handle
              if ($p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffff') -eq ([datetime]::Parse($entry.started).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffff')) -and $p.Path -ieq $entry.exe) { $p.Kill() }
            } finally { $p.Dispose() } }
          }`, cleanupTime())
        }
        const left = await owned(cleanupTime())
        report.cleanup.remaining = left.map(summarizeProcess)
        if (left.length) { report.passed = false; report.status = 'FAIL' }
        else rmSync(root, { recursive: true, force: true })
      } catch (error) { report.cleanupError = String(error.message).slice(0, 1000); report.passed = false; report.status = 'FAIL' }
    }
    if (browser) {
      const ms = Math.min(2000, started + BUDGET_MS - Date.now())
      if (ms > 0) {
        try { await bounded(browser.close(), ms, 'Failed-session CDP disconnect'); report.cdpDisconnected = true }
        catch { report.cdpDisconnected = false; report.passed = false; report.status = 'FAIL' }
      } else {
        // Do not wait past the deadline or label this cleanup complete. The CLI
        // exits after the synchronous receipt write, so a debug socket cannot
        // keep the harness alive after a failed cleanup budget.
        void browser.close().catch(() => {})
        report.cdpDisconnected = false; report.passed = false; report.status = 'FAIL'
      }
    }
    // Private paths are useful internally for ownership but are not exported.
    for (const key of ['error', 'cleanupError']) if (report[key] && root) report[key] = report[key].replaceAll(root, '$TEST')
    report.finishedAt = new Date().toISOString(); report.durationMs = Date.now() - started
    if (report.durationMs > BUDGET_MS) { report.status = 'FAIL'; report.passed = false; report.budgetExceeded = true }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(`Portable lifecycle: ${report.status}; ${report.launches.filter(x => x.status === 'PASS').length}/3 completed launches`)
  return report.passed ? 0 : 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exit(await run())
