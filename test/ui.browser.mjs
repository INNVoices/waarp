// Real DOM regressions. Serve the built renderer first; all IPC is an injected, in-memory fixture.
// No engine starts and no host network settings change.
// WAARP_UI_URL=http://127.0.0.1:4173 WAARP_PLAYWRIGHT=/path/to/playwright/index.mjs
// WAARP_CHROMIUM=/path/to/chromium node test/ui.browser.mjs
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dependency = process.env.WAARP_PLAYWRIGHT
const playwright = await import(dependency ? pathToFileURL(resolve(dependency)).href : 'playwright')
const { chromium } = playwright.default ?? playwright
const strings = JSON.parse(readFileSync(new URL('../src/shared/strings/ru.json', import.meta.url), 'utf8'))
const url = process.env.WAARP_UI_URL ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch({ headless: true, ...(process.env.WAARP_CHROMIUM ? { executablePath: process.env.WAARP_CHROMIUM } : {}), args: ['--no-sandbox'] })
const errors = []
let passed = 0
const screenshotDir = process.env.WAARP_UI_SCREENSHOTS
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true })

function fixture(options) {
  const listeners = new Map()
  const on = channel => callback => {
    const group = listeners.get(channel) ?? new Set(); group.add(callback); listeners.set(channel, group)
    return () => group.delete(callback)
  }
  const emit = (channel, value) => { for (const fn of listeners.get(channel) ?? []) fn(structuredClone(value)) }
  const state = {
    calls: {}, failSettings: false, initialFailures: options.failInitial ? 1 : 0,
    status: { phase: 'off', open: false, pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0 },
    profiles: [
      { kind: 'out', id: 'a', name: 'Personal A', host: '192.0.2.1', port: 443, version: 'Trojan', address: [], source: options.publicOnly ? 'public' : 'personal' },
      { kind: 'out', id: 'b', name: 'Personal B', host: '192.0.2.2', port: 443, version: 'Hysteria2', address: [], source: options.publicOnly ? 'public' : 'personal' }
    ],
    settings: { routes: [{ id: 'custom:example.com', kind: 'custom', name: 'Example', value: 'example.com', on: true, via: 'a' }], groups: [], rest: 'direct', ruDirect: true, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: true }
  }
  const count = key => state.calls[key] = (state.calls[key] ?? 0) + 1
  const snapshot = () => structuredClone({ admin: true, profiles: state.profiles, settings: state.settings, status: state.status, notices: [] })
  const push = () => emit('snapshot', snapshot())
  const catalog = { busy: false, total: 1, planned: 1, checked: 1, updatedAt: Date.now(), sources: [], alive: [{ id: 'pub-fixture', name: 'DE Example', host: '198.51.100.1', port: 443, country: 'DE', proto: 'Trojan', ping: 42 }] }
  window.__waarpTest = { state, push, emit, snapshot }
  window.api = {
    snapshot: async () => {
      count('snapshot')
      if (state.initialFailures-- > 0) throw new Error('fixture: unavailable')
      if (options.staleInitial && state.calls.snapshot === 1) { const old = snapshot(); return new Promise(resolve => { state.resolveInitial = () => resolve(old) }) }
      return snapshot()
    },
    toggle: async () => { count('toggle'); throw new Error('fixture: toggle unavailable') },
    settings: async patch => {
      count('settings')
      if (state.failSettings) { emit('toast', 'fixture: save refused'); return { ...snapshot(), saved: false } }
      state.settings = { ...state.settings, ...patch }; push(); return { ...snapshot(), saved: true }
    },
    selectRoute: async (id, via) => { count('selectRoute'); state.settings.routes = state.settings.routes.map(route => route.id === id ? { ...route, via, on: true } : route); push(); return { ok: true } },
    scanApps: async () => [],
    pickApp: async () => { count('pickApp'); return options.deferPickApp ? new Promise(resolve => { state.resolvePickApp = resolve }) : null },
    validate: async () => null,
    companionChoose: async (id, via) => {
      count('companionChoose')
      state.settings.routes = [...state.settings.routes, { id, kind: 'custom', name: 'Companion test', value: 'companion.example', on: true, via, owner: 'companion' }]
      push()
      return { ok: true, saved: true, applied: !options.companionApplyFailure, ...(options.companionApplyFailure ? { error: 'fixture: saved, tunnel did not apply' } : {}) }
    },
    clipPeek: async () => ({ kind: 'none' }),
    importProfile: () => { count('import'); return new Promise((resolve, reject) => { state.resolveImport = resolve; state.rejectImport = reject }) },
    catalogGet: async () => catalog, catalogRefresh: async () => catalog,
    catalogBest: async () => ({ ok: true, id: 'g-public' }), catalogAdd: async id => ({ ok: true, id }),
    removeProfile: async id => { count('remove'); state.profiles = state.profiles.filter(profile => profile.id !== id); push(); return { ok: true } },
    renameProfile: async () => ({ ok: true }), replaceProfile: async () => ({ ok: true }), refreshSubscription: async () => ({ ok: true }),
    discoverScan: async () => ({ ok: true, items: [] }), discoverPickFolder: async () => ({ canceled: true }), discoverAdd: async () => ({ ok: false }),
    log: async () => [], resetNet: async () => ({ ok: true }), win: () => {},
    onSnapshot: on('snapshot'), onStatus: on('status'), onApps: on('apps'), onConns: on('conns'), onToast: on('toast'), onNav: on('nav'), onCatalog: on('catalog')
  }
}

async function pageFor(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1240, height: 780 } })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(fixture, options)
  await page.goto(url)
  return page
}
const clickNav = (page, key) => page.getByRole('button', { name: strings['nav.' + key], exact: true }).click()
const ready = page => page.locator('.shell').waitFor()
async function check(name, work) { await work(); passed++; console.log('PASS ', name) }

try {
  await check('initial IPC failure is recoverable instead of an endless splash', async () => {
    const page = await pageFor({ failInitial: true })
    await page.getByRole('button', { name: strings['app.load.retry'], exact: true }).click()
    await ready(page)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.snapshot), 2)
    await page.context().close()
  })
  await check('a late initial snapshot cannot overwrite a newer pushed snapshot', async () => {
    const page = await pageFor({ staleInitial: true })
    await page.waitForFunction(() => typeof window.__waarpTest?.state.resolveInitial === 'function')
    await page.evaluate(() => { const f = window.__waarpTest; f.state.settings.routes[0].name = 'New route name'; f.push(); f.state.resolveInitial() })
    await page.getByRole('button', { name: 'New route name', exact: true }).waitFor()
    assert.equal(await page.locator('.rc-n').textContent(), 'New route name')
    await page.context().close()
  })
  await check('finishing the EXE picker preserves routes added or edited while it was open', async () => {
    const page = await pageFor({ deferPickApp: true })
    await ready(page)
    await page.getByRole('button', { name: strings['conn.add'], exact: true }).click()
    await page.getByRole('button', { name: strings['apps.add'], exact: true }).click()
    await page.waitForFunction(() => typeof window.__waarpTest.state.resolvePickApp === 'function')
    await page.evaluate(() => {
      const f = window.__waarpTest
      f.state.settings.routes[0] = { ...f.state.settings.routes[0], name: 'Edited while picker', via: 'b' }
      f.state.settings.routes.push({ id: 'ext:test:concurrent', kind: 'custom', name: 'Concurrent companion', value: 'concurrent.example', on: true, via: 'a', owner: 'companion' })
      f.push()
    })
    await page.getByText('Concurrent companion', { exact: true }).waitFor()
    await page.evaluate(() => window.__waarpTest.state.resolvePickApp({ id: 'picked-app', name: 'Picked app', exe: 'C:\\Example\\app.exe', source: 'manual' }))
    await page.getByRole('heading', { name: 'Picked app', exact: true }).waitFor()
    const routes = await page.evaluate(() => window.__waarpTest.state.settings.routes)
    assert.deepEqual(routes.map(route => route.id), ['custom:example.com', 'ext:test:concurrent', 'app:picked-app'])
    assert.equal(routes[0].name, 'Edited while picker')
    assert.equal(routes[0].via, 'b')
    await page.context().close()
  })
  await check('a saved companion choice still reports a tunnel apply failure', async () => {
    const page = await pageFor({ companionApplyFailure: true })
    await ready(page)
    await page.evaluate(() => window.__waarpTest.emit('nav', { pick: { id: 'ext:test:choose', name: 'Companion test' } }))
    const modal = page.getByRole('dialog', { name: 'Companion test', exact: true })
    await modal.getByRole('button', { name: /Personal A/ }).click()
    await page.getByText('fixture: saved, tunnel did not apply', { exact: true }).waitFor()
    await modal.waitFor({ state: 'hidden' })
    await page.getByRole('heading', { name: 'Companion test', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__waarpTest.state.settings.routes.find(route => route.id === 'ext:test:choose')?.via), 'a')
    await page.context().close()
  })
  const page = await pageFor()
  await ready(page)
  await check('master IPC rejection restores usable controls and reports the error', async () => {
    await page.locator('.master').click()
    await page.getByText(strings['top.toggle.error'], { exact: true }).waitFor()
    assert.equal(await page.locator('.master').isEnabled(), true)
    assert.equal(await page.locator('.master').getAttribute('aria-pressed'), 'false')
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, 'connection-error.png') })
  })
  await check('deleting the route being viewed does not break React hooks', async () => {
    await page.getByRole('button', { name: 'Example', exact: true }).click()
    await page.getByRole('heading', { name: 'Example', exact: true }).waitFor()
    await page.evaluate(() => { const f = window.__waarpTest; f.state.settings.routes = []; f.push() })
    await page.getByText(strings['route.removed'], { exact: true }).waitFor()
    await clickNav(page, 'servers')
  })
  await check('the Add public-nodes action reaches the actual public catalog', async () => {
    await page.getByRole('button', { name: strings['srv.add'], exact: true }).click()
    await page.getByRole('dialog').getByText(strings['add.public'], { exact: true }).click()
    await page.locator('#public-catalog').waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('dialog').count(), 0)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, 'connections.png') })
  })
  await check('import has one pending request, keeps modal focus, and reports rejected IPC', async () => {
    const opener = page.getByRole('button', { name: strings['srv.add'], exact: true })
    await opener.click()
    const modal = page.getByRole('dialog')
    await modal.getByText(strings['add.sub'], { exact: true }).click()
    const field = modal.getByPlaceholder(strings['add.sub.ph'])
    await field.fill('https://example.invalid/subscription')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.import), 1)
    await page.keyboard.press('Escape')
    assert.equal(await modal.count(), 1, 'pending save stays visible')
    await page.evaluate(() => window.__waarpTest.state.rejectImport(new Error('fixture: import rejected')))
    await modal.getByText(strings['imp.error'], { exact: true }).waitFor()
    await modal.getByRole('button', { name: strings['nav.close'], exact: true }).focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true)
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, 'import-error.png') })
    await page.keyboard.press('Escape')
    assert.equal(await modal.count(), 0)
    assert.equal(await opener.evaluate(element => element === document.activeElement), true)
  })
  await check('a rejected settings write keeps the group editor and selections', async () => {
    await page.evaluate(() => { window.__waarpTest.state.failSettings = true })
    await page.getByRole('button', { name: strings['grp.add'], exact: true }).click()
    const modal = page.getByRole('dialog')
    await modal.locator('.vopt').nth(0).click()
    await modal.locator('.vopt').nth(1).click()
    await modal.getByRole('button', { name: strings['grp.create'], exact: true }).click()
    await page.getByText('fixture: save refused', { exact: true }).waitFor()
    assert.equal(await modal.count(), 1)
    assert.equal(await modal.locator('.vopt[aria-pressed="true"]').count(), 2)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, 'group-save-error.png') })
    await page.keyboard.press('Escape')
  })
  await check('the public list stays within the minimum supported window', async () => {
    await page.setViewportSize({ width: 900, height: 600 })
    await page.locator('#public-catalog').getByText(strings['pub.manual'], { exact: true }).click()
    await page.locator('#public-catalog').getByText(strings['pub.region.eu'], { exact: true }).click()
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.main'), table = document.querySelector('.pub-list.pick-table')
      return { main: main.scrollWidth - main.clientWidth, table: table.scrollWidth - table.clientWidth }
    })
    assert.ok(overflow.main <= 1, JSON.stringify(overflow))
    assert.ok(overflow.table > 0, 'wide public columns scroll inside their table')
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, 'public-min-width.png') })
  })
  await page.context().close()
  await check('whole-computer mode cannot silently select an untrusted public path', async () => {
    const page = await pageFor({ publicOnly: true })
    await ready(page)
    await page.getByRole('button', { name: strings['home.scope.all'], exact: true }).click()
    const modal = page.getByRole('dialog', { name: strings['home.scope.choose'] })
    await modal.waitFor()
    assert.equal(await page.evaluate(() => window.__waarpTest.state.settings.rest), 'direct')
    await modal.getByRole('button', { name: 'Personal A', exact: true }).click()
    await modal.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.__waarpTest.state.settings.rest), 'a')
    await page.context().close()
  })
  // This specifically uses the production bundle. Do not run this check against the browser-only dev demo.
  await check('production without preload cannot pretend the VPN is working', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await page.getByRole('button', { name: strings['app.load.retry'], exact: true }).waitFor()
    assert.equal(await page.locator('.shell').count(), 0)
    await context.close()
  })
  assert.deepEqual(errors, [], 'no unhandled promises or React rendering errors')
  console.log(`\n${passed} browser regressions passed; no engine or system routing was started.`)
} finally { await browser.close() }
