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
  const world = 512 * 2 ** .65
  return { x: size.width / 2 + (anchor.longitude - 15) / 360 * world,
    y: size.height / 2 + (mercatorY(anchor.latitude) - mercatorY(25)) * world }
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
    await canvas.click({ position: worldPoint(anchors.JP, size) })
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
    assert.deepEqual(await actionCalls(page), before, 'list/map/filter changes add no scans, route calls or toggle calls')
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
  assert.deepEqual(errors, [], 'Atlas has no unhandled renderer errors')
}
