// Real MapLibre canvas + real DOM, using the same isolated IPC fixture as the UI suite.
// No real tunnel or host routing is involved. WebGL availability is a gate, not a skipped assertion.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const strings = JSON.parse(readFileSync(new URL('../src/shared/strings/ru.json', import.meta.url), 'utf8'))
const anchors = JSON.parse(readFileSync(new URL('../src/shared/atlas-countries.json', import.meta.url), 'utf8'))
const actionCalls = page => page.evaluate(() => {
  const c = window.__waarpTest.state.calls
  return ['settings', 'selectRoute', 'toggle', 'disconnect', 'catalogAdd', 'catalogVerify', 'catalogRefresh', 'diagnose', 'ping'].map(key => c[key] ?? 0)
})
const mapReady = page => page.locator('.atlas-canvas[data-map-ready="true"]').waitFor()
const worldPoint = (anchor, size) => {
  const mercatorY = latitude => (1 - Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / Math.PI) / 2
  // The application fits the local world bounds with 24px padding. MapLibre's
  // one-world constraint can raise the resulting zoom to fill the viewport.
  const minX = (-170 + 180) / 360, maxX = 1
  const minY = mercatorY(76), maxY = mercatorY(-55)
  const fittedWorld = Math.min((size.width - 48) / (maxX - minX), (size.height - 48) / (maxY - minY))
  const world = Math.max(512, fittedWorld, size.width, size.height)
  const clamp = (value, half) => Math.max(half, Math.min(1 - half, value))
  const centerX = clamp((minX + maxX) / 2, size.width / world / 2)
  const centerY = clamp((minY + maxY) / 2, size.height / world / 2)
  return { x: size.width / 2 + ((anchor.longitude + 180) / 360 - centerX) * world,
    y: size.height / 2 + (mercatorY(anchor.latitude) - centerY) * world }
}

export async function runAtlasChecks({ browser, url, fileUrl, screenshotDir, fixture }) {
  const errors = []
  const make = async (fallback = false, destination = url) => {
    const context = await browser.newContext({ viewport: { width: 1240, height: 900 } })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    const external = []
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(destination).origin) external.push(request.url()) })
    await page.addInitScript(fixture, { atlas: true, largeCatalog: true })
    await page.addInitScript(disabled => {
      window.__atlasWorkers = 0
      window.__atlasWorkerSources = []
      const WorkerClass = window.Worker
      window.Worker = class extends WorkerClass {
        constructor(...args) { super(...args); window.__atlasWorkers++; window.__atlasWorkerSources.push(String(args[0]).slice(0, 48)); this.finished = false }
        terminate() { if (!this.finished) { this.finished = true; window.__atlasWorkers-- }; return super.terminate() }
      }
      if (disabled) {
        const original = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return /webgl/.test(kind) ? null : original.call(this, kind, ...args) }
      }
    }, fallback)
    await page.goto(destination)
    await page.locator('.shell').waitFor()
    return { page, external }
  }
  const capture = async (page, name) => {
    if (!screenshotDir) return
    if (await page.locator('.atlas-canvas').count()) await mapReady(page)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: resolve(screenshotDir, name), animations: 'disabled' })
  }
  const clickView = (page, view) => page.locator('.atlas-view-switch').getByRole('button', { name: strings['atlas.view.' + view], exact: true }).click()
  {
    assert.equal(new URL(fileUrl).protocol, 'file:', 'file-origin smoke must use the actual production file URL')
    const { page, external } = await make(false, fileUrl)
    await page.locator('.rc-open').first().click()
    const before = await actionCalls(page)
    await clickView(page, 'map')
    // This signal is set only after the real sources have loaded and the GL map reached idle.
    await mapReady(page)
    const runtime = await page.evaluate(() => ({ protocol: location.protocol, origin: globalThis.origin,
      workers: window.__atlasWorkers, sources: window.__atlasWorkerSources }))
    assert.equal(runtime.protocol, 'file:')
    assert.ok(runtime.workers > 0, 'production file page starts a real MapLibre worker under its CSP')
    if (runtime.origin === 'null') assert.ok(runtime.sources.some(source => source.startsWith('data:')), 'opaque file origin uses the local-code data worker')
    assert.equal(await page.locator('.maplibregl-canvas').count(), 1)
    assert.equal(await page.getByText(strings['atlas.unavailable'], { exact: true }).count(), 0, 'file-origin worker does not fall back to List')
    assert.equal(await page.locator('.saved-server-list .server-row').filter({ hasText: 'Personal A' }).locator('.server-row-health').innerText(),
      strings['srv.ping.unmeasured'], 'acknowledged active path without measurements is never called unused')
    assert.deepEqual(external, [], 'production file map makes no HTTP requests')
    assert.deepEqual(await actionCalls(page), before, 'file-origin map starts no route control or network check')
    await capture(page, 'atlas-file-origin.png')
    await page.context().close()
    console.log('PASS  Atlas production file origin, local worker, CSP and actual WebGL source/render')
  }
  {
    const { page, external } = await make()
    await page.locator('.rc-open').first().click()
    const before = await actionCalls(page)
    assert.equal(await page.locator('.atlas-canvas').count(), 0, 'List opens without a GL map')
    await clickView(page, 'map')
    await mapReady(page)
    assert.equal(await page.locator('.maplibregl-canvas').count(), 1, 'actual MapLibre WebGL canvas is present')
    assert.ok(await page.evaluate(() => window.__atlasWorkers > 0), 'the real renderer has a local worker')
    await page.locator('.atlas-device-unknown').waitFor()
    await page.locator('.atlas-route-status').getByText('Personal A', { exact: true }).waitFor()
    await page.getByRole('combobox', { name: strings['atlas.device.region'], exact: true }).selectOption('FR')
    const canvas = page.locator('.maplibregl-canvas')
    const size = await canvas.boundingBox()
    assert.ok(size)
    // Interact with the actual rendered regional circle, not a test-only map API.
    const position = worldPoint(anchors.JP, size)
    await canvas.hover({ position })
    assert.equal(await canvas.evaluate(element => element.style.cursor), 'pointer', 'the physical pointer hits a rendered country marker')
    await canvas.click({ position })
    await page.waitForFunction(() => document.querySelector('.atlas-region-filter select')?.value === 'JP')
    assert.equal(await page.locator('.saved-server-list .server-row').count(), 1)
    await page.locator('.saved-server-list').getByText('Personal B', { exact: true }).waitFor()
    assert.equal(await page.locator('.atlas-route-status').textContent().then(text => text.includes('Personal B')), false, 'preview is not the effective route')
    assert.deepEqual(await actionCalls(page), before, 'map, device region and marker browsing do not call the control plane')
    await capture(page, 'atlas-picker-active-preview-1240.png')
    await page.setViewportSize({ width: 900, height: 1200 })
    await page.locator('.server-picker').scrollIntoViewIfNeeded()
    assert.ok(await page.locator('.main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'map and row action fit 900 px')
    await page.locator('.server-row-action').scrollIntoViewIfNeeded()
    const rowAction = await page.locator('.server-row-action').boundingBox()
    assert.ok(rowAction && rowAction.x >= 0 && rowAction.x + rowAction.width <= 900)
    await capture(page, 'atlas-picker-900.png')
    await clickView(page, 'list')
    assert.equal(await page.locator('.atlas-canvas').count(), 0)
    await page.waitForFunction(() => window.__atlasWorkers === 0)
    assert.equal(await page.locator('.saved-server-list .server-row').count(), 1, 'List preserves the chosen country')
    await clickView(page, 'map')
    await mapReady(page)
    assert.equal(await page.getByRole('combobox', { name: strings['atlas.device.region'], exact: true }).inputValue(), 'FR', 'manual device region remains local and persistent')
    await page.getByRole('combobox', { name: strings['atlas.region.filter'], exact: true }).selectOption('??')
    await page.locator('.saved-server-list').getByText('Private region unknown', { exact: true }).waitFor()
    assert.deepEqual(await actionCalls(page), before, 'unknown geography remains selectable without mutation')
    assert.deepEqual(external, [], 'map makes no third-party requests')
    await page.context().close()
    console.log('PASS  Atlas real canvas selection, current/preview separation, unknown geography, 900 px and worker disposal')
  }
  {
    const { page, external } = await make()
    await page.locator('.rc-open').first().click()
    await page.locator('.server-source-tabs').getByRole('button', { name: strings['server.public'], exact: true }).click()
    const rows = page.locator('.public-server-list .server-row')
    await rows.nth(11).waitFor()
    await page.getByRole('button', { name: strings['pages.next'], exact: true }).click()
    await rows.filter({ hasText: 'Public server 012' }).waitFor()
    const before = await actionCalls(page)
    await clickView(page, 'map')
    await mapReady(page)
    assert.equal(await rows.filter({ hasText: 'Public server 012' }).count(), 1, 'map keeps page two')
    assert.ok((await page.locator('.atlas-total').textContent()).includes('257'), 'all filtered catalogue candidates contribute, not just the page')
    await clickView(page, 'list')
    await rows.filter({ hasText: 'Public server 012' }).waitFor()
    await clickView(page, 'map')
    await mapReady(page)
    await page.getByRole('combobox', { name: strings['atlas.region.filter'], exact: true }).selectOption('JP')
    await rows.filter({ hasText: 'Public server 001' }).waitFor()
    assert.equal(await page.getByRole('button', { name: strings['pages.previous'], exact: true }).isEnabled(), false, 'country choice resets to the first page')
    await page.getByRole('searchbox', { name: strings['server.public.search'], exact: true }).fill('node-253.')
    await rows.filter({ hasText: 'Public server 253' }).waitFor()
    assert.equal(await rows.count(), 1)
    await clickView(page, 'list')
    assert.equal(await page.getByRole('searchbox', { name: strings['server.public.search'], exact: true }).inputValue(), 'node-253.')
    await page.getByRole('button', { name: strings['atlas.region.reset'], exact: true }).click()
    await rows.filter({ hasText: 'Public server 253' }).waitFor()
    assert.equal(await rows.count(), 1, 'resetting country preserves the typed query')
    await page.getByRole('searchbox', { name: strings['server.public.search'], exact: true }).fill('')
    await rows.nth(11).waitFor()
    await clickView(page, 'map')
    await mapReady(page)
    await page.getByRole('combobox', { name: strings['atlas.region.filter'], exact: true }).selectOption('??')
    await rows.filter({ hasText: 'Public server 256' }).waitFor()
    assert.equal(await rows.count(), 1, 'unknown-country rows beyond the old preview remain available')
    assert.deepEqual(await actionCalls(page), before, 'list/map/filter changes do not import, save routes or toggle the VPN')
    await page.waitForFunction(() => window.__waarpTest.state.lastPublicAutoIds.includes('pool-256'))
    assert.deepEqual(external, [])
    await capture(page, 'atlas-public-full-pool-unknown.png')
    await page.context().close()
    console.log('PASS  Atlas public full-pool counts, paging, query and region persistence')
  }
  {
    const { page } = await make(true)
    await page.locator('.rc-open').first().click()
    const before = await actionCalls(page)
    await clickView(page, 'map')
    await page.getByText(strings['atlas.unavailable'], { exact: true }).waitFor()
    assert.equal(await page.locator('.saved-server-list .server-row').count(), 3, 'renderer failure retains the working server list')
    await page.getByRole('combobox', { name: strings['atlas.region.filter'], exact: true }).selectOption('??')
    await page.locator('.saved-server-list').getByText('Private region unknown', { exact: true }).waitFor()
    await page.locator('.atlas-unavailable').getByRole('button', { name: strings['atlas.view.list'], exact: true }).click()
    assert.equal(await page.locator('.atlas-canvas').count(), 0)
    assert.deepEqual(await actionCalls(page), before)
    await capture(page, 'atlas-fallback-list.png')
    await page.context().close()
    console.log('PASS  Atlas unavailable WebGL preserves the selectable list and filters')
  }
  {
    const { page } = await make()
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.evaluate(() => {
      const f = window.__waarpTest
      f.state.profiles = [
        { ...f.state.profiles[0], name: 'DE Germany, Frankfurt am Main', country: undefined, source: 'public' },
        { ...f.state.profiles[1], name: 'MY Malaysia, Kuala Lumpur', country: undefined, source: 'public' },
        f.state.profiles[2]
      ]
      f.state.status.pings = { a: 83 }; f.push()
    })
    await page.getByRole('button', { name: strings['nav.servers'], exact: true }).click()
    await page.locator('.atlas-connections-toolbar').getByRole('button', { name: strings['atlas.view.map'], exact: true }).click()
    await mapReady(page)
    const map = await page.locator('.atlas-map-frame').boundingBox()
    assert.ok(map && map.height >= 540 && map.width / map.height < 3, 'desktop map uses the available height instead of a 340px strip')
    const regions = page.getByRole('combobox', { name: strings['atlas.region.filter'], exact: true })
    assert.equal(await regions.locator('option[value="DE"]').count(), 1, 'legacy public Germany name restores its region without editing')
    assert.equal(await regions.locator('option[value="MY"]').count(), 1, 'Malaysia source name restores its valid region')
    assert.ok((await regions.locator('option[value="??"]').innerText()).includes('1'), 'unlabelled private profile keeps an honest unknown region')
    await page.getByRole('combobox', { name: strings['atlas.device.region'], exact: true }).selectOption('FR')
    await capture(page, 'atlas-saved-desktop-1920.png')
    await page.locator('.atlas-connections-toolbar').getByRole('button', { name: strings['server.public'], exact: true }).click()
    await mapReady(page)
    // The stat is one span containing both its <b> count and the text label;
    // an exact text-only locator cannot match that combined DOM text.
    const readyStat = page.locator('#public-catalog .atlas-summary .atlas-stat.ready')
    await page.waitForFunction(() => document.querySelector('#public-catalog .atlas-summary .atlas-stat.ready b')?.textContent === '257')
    assert.equal(await readyStat.locator('b').innerText(), '257', 'public map summary includes every fresh fixture response')
    assert.ok((await readyStat.innerText()).includes(strings['atlas.summary.ready']), 'the measured count retains its availability label')
    assert.ok((await page.locator('.atlas-total').innerText()).includes('257'))
    await capture(page, 'atlas-public-desktop-1920.png')
    await page.context().close()
    console.log('PASS  Atlas 1920px height, legacy DE/MY source names, unknown truth and live region summary')
  }
  assert.deepEqual(errors, [], 'Atlas has no unhandled renderer errors')
}
