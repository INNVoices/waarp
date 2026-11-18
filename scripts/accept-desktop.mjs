// Acceptance of the packaged Windows application, its real IPC, public feeds
// and native checker. No renderer fixtures or substituted network responses.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'

assert.equal(process.platform, 'win32')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Requires a disposable Windows runner')
assert.equal(process.env.WAARP_DESKTOP_ACCEPTANCE, '1', 'Real public-network acceptance requires explicit opt-in')
const output = resolve('out/desktop-acceptance')
mkdirSync(output, { recursive: true })
const strings = JSON.parse(readFileSync('src/shared/strings/ru.json', 'utf8'))
const metadata = JSON.parse(readFileSync('package.json', 'utf8'))
const report = { schemaVersion: 1, sourceCommit: process.env.GITHUB_SHA, version: metadata.version,
  network: 'GitHub-hosted Windows runner', realPackagedApplication: true, fixtureResponses: false, passed: false, errors: [] }
let desktop, page
const poll = async (name, read, accept, budget) => {
  const until = Date.now() + budget
  let value
  while (Date.now() < until) {
    value = await read()
    if (accept(value)) return value
    await delay(1000)
  }
  throw new Error(name + ' timed out')
}
const catalog = () => page.evaluate(() => window.api.catalogGet())
const snapshot = () => page.evaluate(() => window.api.snapshot())
const summary = state => ({ candidates: state.total, ready: state.readyCount, checked: state.checkedCount,
  failed: state.failedCount, skipped: state.skippedCount, unchecked: state.uncheckedCount,
  issue: state.checkIssue, sources: state.sources.map(({ sourceId, ok, count, error }) => ({ sourceId, ok, count, error })) })
const capture = async name => {
  await page.evaluate(() => document.fonts.ready)
  await page.locator('.main').evaluate(element => { element.scrollTop = 0 })
  if (await page.locator('.atlas-canvas:visible').count()) await page.locator('.atlas-canvas[data-map-ready="true"]:visible').waitFor({ timeout: 15000 })
  await page.screenshot({ path: resolve(output, name), animations: 'disabled' })
}
const sizeWindow = async (width, height) => {
  await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
const mapGeometry = async label => {
  const frame = await page.locator('.atlas-map-frame:visible').boundingBox()
  const layout = await page.locator('.main').evaluate(element => ({ viewport: innerWidth, height: innerHeight,
    overflow: element.scrollWidth - element.clientWidth }))
  assert(frame && frame.width > 600, label + ': map must be visible and usable')
  assert(frame.height >= 480 && frame.width / frame.height < 3, label + ': map must not collapse to the previous shallow strip')
  assert(layout.overflow <= 1, label + ': no horizontal page overflow')
  return { ...layout, mapWidth: Math.round(frame.width), mapHeight: Math.round(frame.height) }
}
try {
  desktop = await _electron.launch({ executablePath: resolve('dist/win-unpacked/Waarp.exe'), timeout: 45000 })
  page = await desktop.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.locator('.shell').waitFor()
  report.icon = await desktop.evaluate(({ app, nativeImage, BrowserWindow }) => {
    const icon = nativeImage.createFromPath(app.getAppPath() + '/build/icon.png')
    const window = BrowserWindow.getAllWindows()[0]
    window.setPosition(0, 0); window.setSize(1920, 1080)
    return { loaded: !icon.isEmpty(), ...icon.getSize(), nativeWindow: window.getNativeWindowHandle().some(byte => byte !== 0) }
  })
  assert(report.icon.loaded && report.icon.nativeWindow && report.icon.width >= 256, 'Packaged taskbar icon must load at runtime')
  const initial = await poll('startup recovery', snapshot, snap => snap.status.startup === 'ready', 45000)
  assert(initial.admin, 'Disposable Windows native acceptance requires an elevated runner')
  assert.equal(initial.profiles.length, 0, 'Fresh acceptance installation must not contain saved servers')
  await page.getByRole('button', { name: strings['nav.servers'], exact: true }).click()
  await page.locator('.atlas-connections-toolbar .atlas-view-switch').getByRole('button', { name: strings['atlas.view.map'], exact: true }).click()
  await page.locator('.atlas-connections-toolbar').getByRole('button', { name: strings['server.public'], exact: true }).click()
  const started = Date.now()
  const first = await poll('automatic real public-node response', catalog, state => state.readyCount > 0, 300000)
  report.firstReadyMs = Date.now() - started
  report.beforeImport = summary(first)
  report.profilesBeforeImport = (await snapshot()).profiles.length
  assert.equal(report.profilesBeforeImport, 0, 'Automatic verification must not import servers')
  assert(first.checkedCount > 0 && first.sources.some(source => source.ok), 'A fresh native response and downloaded source are required')
  await page.locator('#public-catalog .server-ready-count').waitFor()
  await page.locator('#public-catalog .server-row-health.ready').first().waitFor()
  assert.equal(await page.getByRole('button', { name: strings['server.public.checkadd'], exact: true }).count(), 0, 'Candidates require no check-and-add action')
  assert.equal(await page.getByRole('button', { name: strings['server.public.verify'], exact: true }).count(), 0, 'Candidate search starts without a find-working action')
  report.layout = { public1920: await mapGeometry('1920px public map') }
  await capture('desktop-public-real-1920.png')
  await sizeWindow(1240, 900)
  report.layout.public1240 = await mapGeometry('1240px public map')
  await capture('desktop-public-real-1240.png')
  await sizeWindow(1920, 1080)
  const proposed = first.alive.find(node => node.country !== '??') ?? first.alive[0]
  const search = page.getByRole('searchbox', { name: strings['server.public.search'], exact: true })
  await search.fill(proposed.host)
  const chosenRow = page.locator('#public-catalog .server-row').filter({ has: page.getByTitle(proposed.name, { exact: true }) }).first()
  await chosenRow.locator('.server-row-health.ready').waitFor()
  await chosenRow.getByRole('button', { name: strings['pub.add'], exact: true }).click()
  const imported = await poll('save verified public row', snapshot, snap => snap.profiles.length === 1, 20000)
  const added = imported.profiles[0]
  const candidates = await page.evaluate(host => window.api.catalogPage({ query: host, readyOnly: true, pageSize: 100 }), proposed.host)
  const selected = candidates.items.find(node => node.id === added.id)
  assert(selected, 'The actual row saved by the UI must be a verified catalogue candidate')
  assert.equal(added.country, selected.country, 'Public country metadata must survive the visible Add action')
  report.response = { candidateId: selected.id, protocol: selected.proto, country: selected.country, httpResponseMs: selected.ping }
  report.savedThroughVisibleButton = true
  await search.fill('')
  const before = await snapshot()
  const route = { id: 'custom:example.com', kind: 'custom', name: 'Example website', value: 'example.com', via: added.id, on: true }
  const configured = await page.evaluate(async route => {
    const snap = await window.api.snapshot()
    return window.api.settings({ routes: [...snap.settings.routes, route] }, snap.settings)
  }, route)
  assert.notEqual(configured?.saved, false, 'Acceptance route must be saved')
  const opened = await page.evaluate(() => window.api.toggle())
  assert(opened?.ok, opened?.error ?? 'Native public route could not start')
  const on = await poll('native VPN ON', snapshot, snap => snap.status.phase === 'on', 45000)
  const atOn = await catalog()
  const progressed = await poll('automatic checks while VPN is ON', catalog,
    state => state.checkedCount > atOn.checkedCount, 90000)
  const after = await snapshot()
  assert.equal(after.status.phase, 'on')
  assert.equal(after.status.since, on.status.since, 'Catalog checking must preserve the running VPN session')
  assert.equal(after.settings.routes.find(item => item.id === route.id)?.via, added.id, 'Automatic checks must not change the selected route')
  assert.equal(after.profiles.length, before.profiles.length, 'Background checks must not add more profiles')
  report.whileOn = summary(progressed)
  report.checksAfterOn = progressed.checkedCount - atOn.checkedCount
  report.nativeSessionPreserved = true
  report.selectedRoutePreserved = true
  await capture('desktop-public-on-1920.png')
  await page.locator('.atlas-connections-toolbar').getByRole('button', { name: new RegExp('^' + strings['server.saved']) }).click()
  await poll('public-view automatic lease released', catalog, state => state.automatic === false, 10000)
  report.publicLeaseReleased = true
  const saved = (await snapshot()).profiles.find(profile => profile.id === added.id)
  assert.equal(saved?.country, selected.country, 'Public country metadata must survive import')
  report.layout.saved1920 = await mapGeometry('1920px saved map')
  await capture('desktop-saved-real-1920.png')
  await page.getByRole('button', { name: strings['nav.an'], exact: true }).click()
  await page.getByRole('textbox', { name: strings['quality.target'], exact: true }).fill('https://example.com')
  await page.locator('.quality-result').filter({ hasText: 'https://example.com' }).waitFor({ timeout: 60000 })
  assert.equal(await page.locator('.diagnostic-stage').count(), 4)
  assert(await page.locator('.diagnostic-next').innerText(), 'Investigation needs a next step')
  assert((await page.locator('.diagnostic-current').innerText()).includes('Example website'), 'Investigation must resolve the existing target route')
  report.diagnostics = { automaticTargetInvestigation: true, stages: 4, existingRouteResolved: true,
    verdict: await page.locator('.quality-summary').innerText(), nextStep: await page.locator('.diagnostic-next').innerText() }
  await sizeWindow(1240, 900)
  await capture('desktop-diagnostics-real-1240.png')
  assert.deepEqual(report.errors, [], 'Packaged UI must have no unhandled page errors')
  report.passed = true
} catch (error) {
  report.failure = error.message
  if (page && !page.isClosed()) {
    try { report.lastCatalog = summary(await catalog()); await capture('desktop-acceptance-failure.png') } catch { /* original failure remains authoritative */ }
  }
  process.exitCode = 1
} finally {
  if (page && !page.isClosed()) {
    try { await page.evaluate(() => window.api.disconnect()) } catch { /* Electron shutdown retains its own cleanup gate */ }
  }
  if (desktop) await desktop.close().catch(() => undefined)
  writeFileSync(resolve(output, 'public-catalog-windows.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('WAARP_DESKTOP_ACCEPTANCE ' + JSON.stringify(report))
}
