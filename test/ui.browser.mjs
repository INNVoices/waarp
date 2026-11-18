// Real DOM regressions. `npm run test:ui` serves the built renderer; IPC is an injected, in-memory fixture.
// No engine starts and no host network settings change.
// WAARP_UI_URL=http://127.0.0.1:4173 WAARP_PLAYWRIGHT=/path/to/playwright/index.mjs
// WAARP_CHROMIUM=/path/to/chromium node test/ui.browser.mjs
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dependency = process.env.WAARP_PLAYWRIGHT
const playwright = await import(dependency ? pathToFileURL(resolve(dependency)).href : 'playwright')
const { chromium } = playwright.default ?? playwright
const strings = JSON.parse(readFileSync(new URL('../src/shared/strings/ru.json', import.meta.url), 'utf8'))
const url = process.env.WAARP_UI_URL ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch({ headless: true, ...(process.env.WAARP_CHROMIUM ? { executablePath: process.env.WAARP_CHROMIUM } : {}), args: ['--no-sandbox'] })
const errors = []
const pageConsoleErrors = new WeakMap()
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
    status: { phase: 'off', open: false, pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0,
      ...(options.startupFailed ? { phase: 'error', startup: 'failed', error: 'Восстановление прошлого процесса не завершено' } : {}),
      ...(options.startupRecovering ? { startup: 'recovering' } : {}) },
    profiles: [
      { kind: 'out', id: 'a', name: 'Personal A', host: '192.0.2.1', port: 443, version: 'Trojan', address: [], source: options.publicOnly ? 'public' : 'personal' },
      { kind: 'out', id: 'b', name: 'Personal B', host: '192.0.2.2', port: 443, version: 'Hysteria2', address: [], source: options.publicOnly ? 'public' : 'personal' }
    ],
    settings: { routes: [{ id: 'custom:example.com', kind: 'custom', name: 'Example', value: 'example.com', on: true, via: 'a' }], groups: [], rest: 'direct', ruDirect: true, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: true }
  }
  const count = key => state.calls[key] = (state.calls[key] ?? 0) + 1
  const snapshot = () => structuredClone({ admin: !options.adminPending, profiles: state.profiles, settings: state.settings, status: state.status, notices: [] })
  const push = () => emit('snapshot', snapshot())
  const catalog = { busy: false, total: 1, planned: 1, checked: 1, updatedAt: Date.now(), sources: [], alive: [{ id: 'pub-fixture', name: 'DE Example', host: '198.51.100.1', port: 443, country: 'DE', proto: 'Trojan', ping: 42 }] }
  if (options.staleCatalog) {
    catalog.readyCount = 0; catalog.cachedCount = 4000; catalog.total = 4000
    catalog.cached = [{ ...catalog.alive[0], status: 'cached', checkedAt: Date.now() - 3600_000, lastSuccessAt: Date.now() - 3600_000 }]
    catalog.alive = []
  }
  const listenerCounts = () => Object.fromEntries([...listeners].filter(([, group]) => group.size).map(([channel, group]) => [channel, group.size]))
  window.__waarpTest = { state, push, emit, snapshot, listenerCounts }
  window.api = {
    snapshot: async () => {
      count('snapshot')
      if (state.initialFailures-- > 0) throw new Error('fixture: unavailable')
      if (options.staleInitial && state.calls.snapshot === 1) { const old = snapshot(); return new Promise(resolve => { state.resolveInitial = () => resolve(old) }) }
      return snapshot()
    },
    toggle: async () => {
      count('toggle')
      if (options.stability) {
        state.status = { ...state.status, phase: 'starting', startup: 'recovering', open: true, error: undefined }; push()
        return new Promise(resolve => {
          state.resolveToggle = () => {
            const open = state.status.open === true
            state.status = { ...state.status, phase: open ? 'on' : 'off', startup: 'ready', open, since: open ? Date.now() : undefined }
            state.resolveToggle = undefined; push()
            resolve(open ? { ok: true } : { ok: false, error: 'fixture: cancelled opening' })
          }
        })
      }
      if (options.deferToggle) {
        state.status = { ...state.status, startup: 'recovering', open: true }; push()
        return new Promise(resolve => { state.resolveToggle = () => resolve({ ok: false, error: 'fixture: stale opening result' }) })
      }
      if (options.startupFailed) return { ok: false, error: state.status.error }
      throw new Error('fixture: toggle unavailable')
    },
    disconnect: async () => { count('disconnect'); state.status = { ...state.status, phase: 'off', open: false }; push(); return { ok: true } },
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
    catalogGet: async () => catalog,
    catalogRefresh: async () => { count('catalogRefresh'); return catalog },
    catalogVerify: async () => { count('catalogVerify'); return catalog },
    catalogBest: async () => ({ ok: true, id: 'g-public' }), catalogAdd: async id => { count('catalogAdd'); return { ok: true, id } },
    removeProfile: async id => { count('remove'); state.profiles = state.profiles.filter(profile => profile.id !== id); push(); return { ok: true } },
    renameProfile: async () => ({ ok: true }), replaceProfile: async () => ({ ok: true }), refreshSubscription: async () => ({ ok: true }),
    discoverScan: async () => ({ ok: true, items: [] }), discoverPickFolder: async () => ({ canceled: true }), discoverAdd: async () => ({ ok: false }),
    diagnose: async target => {
      count('diagnose')
      const host = new URL(target.includes('://') ? target : 'https://' + target).hostname.replace(/^\[|\]$/g, '')
      const diagnosis = { target, host, at: Date.now(), token: `diagnosis-${state.calls.diagnose}`,
        direct: { dnsSystem: { result: 'ok', addrs: 1 }, dnsDoh: { result: 'ok', addrs: 1 }, tcp: { result: 'ok' }, tls: { result: 'timeout' }, http: { result: 'skipped' } },
        paths: { a: null, b: 25 }, finding: { kind: 'path_only', via: ['b'] } }
      state.diagnosis = diagnosis
      if (options.deferDiagnose) return new Promise(resolve => { state.resolveDiagnose = () => resolve(diagnosis) })
      return diagnosis
    },
    diagnoseCancel: async () => { count('diagnoseCancel') },
    diagnoseApply: async (token, via) => {
      count('diagnoseApply'); state.lastDiagnosisApply = { token, via }
      if (state.rejectDiagnosisApply || token !== state.diagnosis?.token) return { ok: false, error: 'stale' }
      const id = 'custom:' + state.diagnosis.host
      const found = state.settings.routes.findIndex(route => route.id === id)
      const route = { id, kind: 'custom', name: state.diagnosis.host, value: state.diagnosis.host, via, on: true }
      if (found >= 0) state.settings.routes[found] = { ...state.settings.routes[found], via, on: true }
      else state.settings.routes.push(route)
      push(); return { ok: true, id }
    },
    profileConfig: async id => { count('profileConfig'); return { type: 'trojan', tag: 'p-' + id, server: '192.0.2.1', server_port: 443, password: '•••' } },
    payloadLast: async () => { count('payloadLast'); return state.payloadReport },
    payloadRun: async (profileId, uploadEndpoint) => {
      count('payloadRun'); state.lastPayloadRequest = { profileId, uploadEndpoint }
      const report = { profileId, at: Date.now(), target: 'rfc6455',
        download: { state: 'pass', bytes: 162067, ms: 200 },
        upload: { state: 'not_measured', bytes: 0, ms: 0, reason: 'no_endpoint' } }
      const finish = () => { state.payloadReport = report; return { report } }
      if (options.deferPayload) return new Promise(resolve => { state.resolvePayload = () => resolve(finish()) })
      return finish()
    },
    payloadCancel: async () => { count('payloadCancel'); return true },
    exportDiag: async () => { count('exportDiag'); return state.exportCanceled ? { ok: false } : { ok: true } },
    diagnosticHistory: async () => { count('diagnosticHistory'); return state.historyCleared ? {} : { lastSession: { phase: 'off', events: [{ category: 'network' }] } } },
    clearDiagnosticHistory: async () => { count('clearDiagnosticHistory'); state.historyCleared = true; state.payloadReport = undefined; return { ok: true } },
    log: async () => [],
    resetNet: async () => {
      count('resetNet')
      const finish = () => {
        const fail = options.failReset || state.failReset
        state.status = { ...state.status, startup: fail ? 'failed' : 'ready', phase: fail ? 'error' : 'off', open: false,
          error: fail ? 'Восстановление прошлого процесса не завершено' : undefined }
        push()
        return fail ? { ok: false, error: state.status.error } : { ok: true }
      }
      if (options.deferReset || options.stability) {
        state.status = { ...state.status, startup: 'recovering' }; push()
        return new Promise(resolve => { state.resolveReset = () => { state.resolveReset = undefined; resolve(finish()) } })
      }
      return finish()
    },
    win: () => {},
    onSnapshot: on('snapshot'), onStatus: on('status'), onApps: on('apps'), onConns: on('conns'), onToast: on('toast'), onNav: on('nav'), onCatalog: on('catalog')
  }
}

async function pageFor(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1240, height: 780 } })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const consoleErrors = []
  pageConsoleErrors.set(page, consoleErrors)
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.addInitScript(fixture, options)
  await page.goto(url)
  return page
}
const clickNav = (page, key) => page.getByRole('button', { name: strings['nav.' + key], exact: true }).click()
const ready = page => page.locator('.shell').waitFor()
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const capture = async (page, name) => {
  if (!screenshotDir) return
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: resolve(screenshotDir, name), animations: 'disabled' })
}
async function check(name, work) { await work(); passed++; console.log('PASS ', name) }

// Fixed before measurement. These bound retained renderer state and long-run regressions;
// they do not benchmark the native VPN, Electron IPC transport, Wintun, or the network.
const STABILITY_LIMITS = { warmupCycles: 10, measuredCycles: 100, elapsedMs: 90_000, heapGrowthBytes: 8 * 1024 * 1024, heapGrowthRatio: .25, domNodeGrowth: 200, domListenerGrowth: 8, documentGrowth: 1 }
async function rendererStability() {
  const pageErrorStart = errors.length
  const page = await pageFor({ stability: true })
  const consoleErrors = pageConsoleErrors.get(page), cycleMs = []
  const report = { scope: 'Production renderer in Chromium with injected in-memory IPC; no native engine, VPN, TUN or system routing.', sourceRevision: process.env.GITHUB_SHA ?? 'local', chromium: browser.version(), startedAt: new Date().toISOString(), limits: STABILITY_LIMITS, completedCycles: 0, result: 'running' }
  const directory = screenshotDir ?? resolve('out/ui')
  mkdirSync(directory, { recursive: true })
  const save = () => writeFileSync(resolve(directory, 'stability-metrics.json'), JSON.stringify(report, null, 2) + '\n')
  let session
  try {
    await ready(page)
    await page.evaluate(() => document.fonts.ready)
    session = await page.context().newCDPSession(page)
    const counters = async () => {
      await page.mouse.move(0, 0)
      await settle(page)
      await session.send('HeapProfiler.collectGarbage')
      const heap = await session.send('Runtime.getHeapUsage')
      const dom = await session.send('Memory.getDOMCounters')
      return { heapUsedBytes: heap.usedSize, ...dom, ipcListeners: await page.evaluate(() => window.__waarpTest.listenerCounts()) }
    }
    const idleMaster = () => page.locator('.master:not(:disabled)').waitFor()
    const cycle = async index => {
      const started = performance.now()
      const name = `Cycle ${index}`, tempName = `Temporary ${index}`, tempId = `stability-${index}`
      await page.locator('.master').click()
      await page.waitForFunction(() => typeof window.__waarpTest.state.resolveToggle === 'function')
      assert.equal(await page.locator('.master').getAttribute('aria-pressed'), 'true')
      if (index % 2 === 0) {
        await page.locator('.master').click()
        await idleMaster()
        await page.evaluate(() => window.__waarpTest.state.resolveToggle())
      } else {
        await page.evaluate(() => window.__waarpTest.state.resolveToggle())
        await page.waitForFunction(text => document.querySelector('.master b')?.textContent === text, strings['top.on'])
        await page.locator('.master').click()
      }
      await idleMaster()
      await page.waitForFunction(text => document.querySelector('.master b')?.textContent === text, strings['top.off'])
      await page.evaluate(index => {
        const f = window.__waarpTest
        f.state.failReset = index % 5 === 0
        f.state.status = { ...f.state.status, phase: 'error', open: false, startup: 'failed', error: 'fixture: recovery required' }
        f.push()
      }, index)
      const repair = async () => {
        await page.getByRole('button', { name: strings['home.recovery'], exact: true }).click()
        await page.waitForFunction(() => typeof window.__waarpTest.state.resolveReset === 'function')
        assert.equal(await page.locator('.master').isDisabled(), true)
        await page.evaluate(() => window.__waarpTest.state.resolveReset())
        await idleMaster()
      }
      await repair()
      if (index % 5 === 0) {
        assert.equal(await page.locator('.toast.error').count(), 1, 'failed repair is never a success toast')
        await page.evaluate(() => { window.__waarpTest.state.failReset = false })
        await repair()
      }
      assert.equal(await page.locator('.master').getAttribute('aria-pressed'), 'false')
      await page.evaluate(({ name, tempName, tempId }) => {
        const f = window.__waarpTest
        f.state.settings.routes[0].name = name
        f.state.profiles.push({ ...f.state.profiles[0], id: tempId, name: tempName })
        f.push()
        f.state.status.pingRound = (f.state.status.pingRound ?? 0) + 1
        f.emit('status', { ...f.state.status, pingAt: Date.now(), pings: { direct: 10, a: 20, [tempId]: 30 } })
      }, { name, tempName, tempId })
      const route = page.getByRole('switch', { name, exact: true })
      await route.click()
      await page.waitForFunction(name => { const button = [...document.querySelectorAll('[role="switch"]')].find(el => el.getAttribute('aria-label') === name); return button && !button.disabled && button.getAttribute('aria-checked') === 'false' }, name)
      await route.click()
      await page.waitForFunction(name => { const button = [...document.querySelectorAll('[role="switch"]')].find(el => el.getAttribute('aria-label') === name); return button && !button.disabled && button.getAttribute('aria-checked') === 'true' }, name)
      await clickNav(page, 'an')
      await page.locator('.legend').getByText(tempName, { exact: true }).waitFor()
      // A temporary empty startup view is not an authoritative profile deletion.
      await page.evaluate(() => {
        const f = window.__waarpTest
        f.emit('snapshot', { ...f.snapshot(), profiles: [], status: { ...f.state.status, startup: 'recovering' } })
        f.push()
      })
      await settle(page)
      assert.equal(await page.locator('.legend').getByText(tempName, { exact: true }).count(), 1, 'recovering snapshot preserves known history')
      await page.evaluate(tempId => {
        const f = window.__waarpTest, temporary = f.state.profiles.find(profile => profile.id === tempId)
        f.state.profiles = f.state.profiles.filter(profile => profile.id !== tempId); f.push()
        f.state.status.pingRound = (f.state.status.pingRound ?? 0) + 1
        f.emit('status', { ...f.state.status, pingAt: Date.now(), pings: { [tempId]: 999 } }) // late queued measurement after removal
        f.state.profiles.push(temporary); f.push()
      }, tempId)
      await settle(page)
      assert.equal(await page.locator('.legend').getByText(tempName, { exact: true }).count(), 0, 'deleted/readded profile has no stale history without a new measurement')
      assert.equal(await page.locator('.legend .lg').count(), 2, 'direct and retained profile history stay intact')
      await page.evaluate(tempId => { const f = window.__waarpTest; f.state.profiles = f.state.profiles.filter(profile => profile.id !== tempId); f.push() }, tempId)
      await clickNav(page, 'servers')
      await page.locator('#public-catalog').waitFor()
      await page.getByRole('button', { name: strings['grp.add'], exact: true }).click()
      await page.getByRole('dialog').waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await clickNav(page, 'home')
      await page.locator('.hero').waitFor()
      await settle(page)
      assert.equal(await page.getByRole('switch', { name, exact: true }).getAttribute('aria-checked'), 'true')
      return performance.now() - started
    }
    for (let i = 0; i < STABILITY_LIMITS.warmupCycles; i++) await cycle(i)
    report.baseline = await counters()
    const started = performance.now()
    for (let i = 0; i < STABILITY_LIMITS.measuredCycles; i++) {
      cycleMs.push(await cycle(i + STABILITY_LIMITS.warmupCycles))
      report.completedCycles++
      assert.deepEqual(await page.evaluate(() => window.__waarpTest.listenerCounts()), report.baseline.ipcListeners, 'IPC subscriptions return to the warmed baseline every cycle')
      assert.ok(performance.now() - started <= STABILITY_LIMITS.elapsedMs, '100 renderer cycles exceed the predeclared 90 s budget')
    }
    report.elapsedMs = performance.now() - started
    report.final = await counters()
    const sorted = [...cycleMs].sort((a, b) => a - b)
    report.cycleMs = { p50: sorted[Math.floor(sorted.length * .50)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) }
    report.growth = {
      heapUsedBytes: report.final.heapUsedBytes - report.baseline.heapUsedBytes,
      nodes: report.final.nodes - report.baseline.nodes,
      jsEventListeners: report.final.jsEventListeners - report.baseline.jsEventListeners,
      documents: report.final.documents - report.baseline.documents
    }
    report.consoleErrors = consoleErrors
    report.pageErrors = errors.slice(pageErrorStart)
    save()
    assert.deepEqual(consoleErrors, [], 'no renderer console errors during the stability run')
    assert.deepEqual(report.pageErrors, [], 'no renderer page errors or unhandled rejections during the stability run')
    assert.ok(report.growth.heapUsedBytes <= Math.max(STABILITY_LIMITS.heapGrowthBytes, report.baseline.heapUsedBytes * STABILITY_LIMITS.heapGrowthRatio), JSON.stringify(report.growth))
    assert.ok(report.growth.nodes <= STABILITY_LIMITS.domNodeGrowth, JSON.stringify(report.growth))
    assert.ok(report.growth.jsEventListeners <= STABILITY_LIMITS.domListenerGrowth, JSON.stringify(report.growth))
    assert.ok(report.growth.documents <= STABILITY_LIMITS.documentGrowth, JSON.stringify(report.growth))
    assert.deepEqual(report.final.ipcListeners, report.baseline.ipcListeners)
    report.result = 'passed'; save()
    await capture(page, 'stability-after-100-cycles.png')
  } catch (error) {
    report.result = 'failed'; report.error = String(error); report.consoleErrors = consoleErrors; report.pageErrors = errors.slice(pageErrorStart); save()
    await capture(page, 'stability-failed.png').catch(() => undefined)
    throw error
  } finally { if (session) await session.detach(); await page.context().close() }
}

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
  await check('startup recovery shows progress without claiming an open tunnel', async () => {
    const page = await pageFor({ startupRecovering: true, adminPending: true })
    await ready(page)
    assert.equal(await page.locator('.master').textContent(), strings['top.recovering'])
    assert.equal(await page.locator('.master').getAttribute('aria-pressed'), 'false')
    assert.equal(await page.locator('.master').isEnabled(), true, 'first-paint admin=false is pending evidence, not a blocker')
    assert.equal(await page.locator('.orb').isEnabled(), true)
    assert.equal(await page.locator('.orb-t').textContent(), strings['orb.recovering'])
    assert.equal(await page.locator('.orb-s').textContent(), strings['orb.recovering.sub'])
    assert.equal(await page.locator('.hero-actions').count(), 0)
    await capture(page, 'startup-recovering.png')
    await page.context().close()
  })
  await check('failed recovery exposes retry and repair, and failures never receive a success mark', async () => {
    const page = await pageFor({ startupFailed: true, failReset: true, deferReset: true })
    await ready(page)
    await page.getByRole('button', { name: strings['home.retry'], exact: true }).click()
    await page.locator('.toast.error[role="alert"]').waitFor()
    assert.equal(await page.locator('.toast.success').count(), 0)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.toggle), 1)
    await page.getByRole('button', { name: strings['home.recovery'], exact: true }).click()
    await page.waitForFunction(() => typeof window.__waarpTest.state.resolveReset === 'function')
    assert.equal(await page.locator('.master').isDisabled(), true)
    assert.equal(await page.locator('.orb').isDisabled(), true)
    await page.evaluate(() => window.__waarpTest.state.resolveReset())
    await page.getByRole('button', { name: strings['home.retry'], exact: true }).waitFor()
    assert.equal(await page.locator('.toast.error').textContent(), 'Восстановление прошлого процесса не завершено')
    assert.equal(await page.locator('.toast.success').count(), 0)
    assert.equal(await page.locator('.master').isEnabled(), true)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.resetNet), 1)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.settings.routes.length), 1)
    await page.setViewportSize({ width: 900, height: 600 })
    assert.ok(await page.evaluate(() => document.querySelector('.main').scrollWidth - document.querySelector('.main').clientWidth) <= 1)
    await capture(page, 'startup-recovery-failed.png')
    await page.context().close()
  })
  await check('recovery success keeps the master closed and preserves routes', async () => {
    const page = await pageFor({ startupFailed: true })
    await ready(page)
    const before = await page.evaluate(() => window.__waarpTest.state.settings.routes)
    await page.getByRole('button', { name: strings['home.recovery'], exact: true }).click()
    await page.locator('.toast.success').waitFor()
    assert.equal(await page.locator('.toast.success').textContent(), strings['home.recovery.done'])
    assert.equal(await page.locator('.master').getAttribute('aria-pressed'), 'false')
    assert.deepEqual(await page.evaluate(() => window.__waarpTest.state.settings.routes), before)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.toggle ?? 0), 0)
    await page.context().close()
  })
  await check('OFF cancels a pending ON and ignores its obsolete completion', async () => {
    const page = await pageFor({ deferToggle: true })
    await ready(page)
    await page.locator('.master').click()
    await page.waitForFunction(() => typeof window.__waarpTest.state.resolveToggle === 'function')
    assert.equal(await page.locator('.master').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('.master').isEnabled(), true)
    await page.locator('.master').click()
    await page.waitForFunction(() => window.__waarpTest.state.calls.disconnect === 1)
    assert.equal(await page.locator('.master').getAttribute('aria-pressed'), 'false')
    await page.evaluate(() => window.__waarpTest.state.resolveToggle())
    assert.equal(await page.locator('.toast').count(), 0)
    assert.equal(await page.locator('.master').isEnabled(), true)
    assert.equal(await page.locator('.master').getAttribute('aria-pressed'), 'false')
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.toggle), 1)
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
    await capture(page, 'connection-error.png')
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
    await capture(page, 'connections.png')
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
    await capture(page, 'import-error.png')
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
    await capture(page, 'group-save-error.png')
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
    assert.ok(overflow.table <= 1, 'public action and ping fit the supported 900px window')
    await page.evaluate(() => document.fonts.ready)
    const headingGap = await page.locator('.pub-row.pick-th').evaluate(row => {
      const country = document.createRange(), name = document.createRange()
      country.selectNodeContents(row.children[0]); name.selectNodeContents(row.children[1])
      return name.getBoundingClientRect().left - country.getBoundingClientRect().right
    })
    assert.ok(headingGap >= 4, `country and name captions need a visible gap, got ${headingGap}px`)
    const countryCaption = page.locator('.pub-row.pick-th .pub-th-hint').first()
    assert.equal(await countryCaption.textContent(), strings['pick.country'])
    assert.equal(await countryCaption.getAttribute('title'), strings['pick.country.hint'])
    await page.keyboard.press('Tab') // keyboard modality makes the existing Tooltip expose its focus description
    await countryCaption.focus()
    await page.getByRole('tooltip').getByText(strings['pick.country.hint'], { exact: true }).waitFor()
    await page.keyboard.press('Tab')
    await page.getByRole('tooltip').getByText(strings['pick.ping.hint'], { exact: true }).waitFor()
    assert.equal(await page.locator('.pub-row.pick-th .pub-th-hint').last().getAttribute('title'), strings['pick.ping.hint'])
    await page.keyboard.press('Tab')
    const visibleColumns = await page.locator('.pub-row:not(.pick-th)').first().evaluate(row => {
      const table = row.closest('.pick-table').getBoundingClientRect()
      return [...row.querySelectorAll('.pub-ms, .pub-add')].map(element => {
        const box = element.getBoundingClientRect()
        return box.left >= table.left && box.right <= table.right && box.width > 0
      })
    })
    assert.deepEqual(visibleColumns, [true, true], 'measured ping and action are wholly visible without horizontal scrolling')
    await page.locator('.pub-row:not(.pick-th) .pub-add').first().click()
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.catalogAdd), 1)
    assert.equal(await page.locator('.pub-list.pick-table').evaluate(table => table.scrollLeft), 0)
    await capture(page, 'public-min-width.png')
  })
  await page.context().close()
  await check('cached public candidates never display stale success and remain selectable', async () => {
    const page = await pageFor({ staleCatalog: true })
    await ready(page); await clickNav(page, 'servers')
    await page.setViewportSize({ width: 900, height: 600 })
    const panel = page.locator('#public-catalog')
    assert.equal(await panel.getByRole('button', { name: strings['pub.auto'], exact: false }).isEnabled(), false)
    await panel.getByText(strings['pub.manual'], { exact: true }).click()
    await panel.getByText(strings['pub.region.eu'], { exact: true }).click()
    await panel.getByText(strings['pub.node.cached'], { exact: true }).waitFor()
    assert.equal(await panel.locator('.pub-row:not(.pick-th) .pub-ms').count(), 0, 'historical latency is not presented as a current result')
    await panel.locator('.pub-row:not(.pick-th) .pub-add').click()
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.catalogAdd), 1)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.toggle ?? 0), 0)
    const overflow = await panel.evaluate(p => p.scrollWidth - p.clientWidth)
    assert.ok(overflow <= 1, 'cached status and controls fit at minimum width')
    await capture(page, 'public-cached-min-width.png')
    await page.context().close()
  })
  await check('public sources refresh while ON; candidate probing remains an explicit OFF action', async () => {
    const page = await pageFor({ staleCatalog: true })
    await ready(page); await clickNav(page, 'servers')
    await page.evaluate(() => { const f = window.__waarpTest; f.state.status = { ...f.state.status, phase: 'on', open: true }; f.push() })
    const panel = page.locator('#public-catalog')
    const refresh = panel.getByRole('button', { name: strings['pub.refresh'], exact: true })
    const verify = panel.getByRole('button', { name: strings['pub.verify'], exact: true })
    await settle(page)
    assert.equal(await refresh.isEnabled(), true)
    assert.equal(await verify.isEnabled(), false)
    await refresh.click()
    await page.waitForFunction(() => window.__waarpTest.state.calls.catalogRefresh === 1)
    assert.deepEqual(await page.evaluate(() => [window.__waarpTest.state.calls.toggle ?? 0, window.__waarpTest.state.calls.disconnect ?? 0]), [0, 0])
    await page.evaluate(() => { const f = window.__waarpTest; f.state.status = { ...f.state.status, phase: 'off', open: false }; f.push() })
    await verify.click()
    await page.waitForFunction(() => window.__waarpTest.state.calls.catalogVerify === 1)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.catalogRefresh), 1, 'rechecking cache does not require a source download')
    await capture(page, 'public-pool-controls.png')
    await page.context().close()
  })
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
  await check('history records real rounds once, including equal values and OFF measurements', async () => {
    const page = await pageFor()
    await ready(page); await clickNav(page, 'an')
    await page.evaluate(() => {
      const f = window.__waarpTest
      f.state.status = { ...f.state.status, phase: 'on', open: true, since: Date.now(), pings: { a: 42 }, pingRound: 1, pingAt: Date.now() }
      f.emit('status', f.state.status)
      for (let n = 0; n < 20; n++) f.emit('status', { ...f.state.status, down: n })
    })
    // A single sample has no line segment/bounding box yet; its coordinates are still real history.
    await page.locator('.chart polyline').waitFor({ state: 'attached' })
    await settle(page)
    const points = async () => (await page.locator('.chart polyline').getAttribute('points')).trim().split(/\s+/).filter(Boolean).length
    assert.equal(await points(), 1, 'traffic-only cloned status is not a new measurement')
    await page.evaluate(() => { const f = window.__waarpTest; f.state.status.pingRound++; f.emit('status', f.state.status) })
    await settle(page)
    assert.equal(await points(), 2, 'an independent identical ping is still a new measurement')
    await page.evaluate(() => { const f = window.__waarpTest; f.state.status.pingRound++; f.state.status.pings = { a: undefined }; f.emit('status', f.state.status) })
    await page.locator('.legend').getByText(strings['an.loss'].replace('{n}', '33'), { exact: true }).waitFor()
    await page.evaluate(() => {
      const f = window.__waarpTest
      f.emit('status', { ...f.state.status, phase: 'stopping' })
      f.state.status = { ...f.state.status, phase: 'off', open: false, pingRound: -1, pings: { a: 57 }, pingAt: Date.now() }
      f.emit('status', f.state.status); f.emit('status', f.state.status)
    })
    await settle(page)
    assert.equal(await points(), 1, 'OFF rounds work without treating a duplicate as a second sample')
    await page.context().close()
  })
  await check('payload diagnostics stay idle until requested and distinguish unmeasured upload', async () => {
    const page = await pageFor()
    await ready(page); await clickNav(page, 'an')
    const panel = page.locator('.payload-check')
    await panel.getByText(strings['payload.no_result'], { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.payloadLast), 1)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.payloadRun ?? 0), 0, 'opening diagnostics cannot initiate a transfer')
    await panel.getByRole('combobox', { name: strings['payload.path'], exact: true }).selectOption('b')
    await panel.getByRole('button', { name: strings['payload.run'], exact: true }).click()
    await panel.getByText(strings['payload.reason.no_endpoint'], { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.__waarpTest.state.lastPayloadRequest), { profileId: 'b', uploadEndpoint: undefined })
    assert.equal(await panel.locator('.kv > span').nth(1).textContent(), strings['payload.pass'].replace('{bytes}', '158 КБ').replace('{seconds}', '0.2'))
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.payloadRun), 1)
    await page.context().close()
  })
  await check('cancelled payload checks ignore a late response and restore the action', async () => {
    const page = await pageFor({ deferPayload: true })
    await ready(page); await clickNav(page, 'an')
    const panel = page.locator('.payload-check')
    await panel.getByRole('button', { name: strings['payload.run'], exact: true }).click()
    await page.waitForFunction(() => typeof window.__waarpTest.state.resolvePayload === 'function')
    await panel.getByRole('button', { name: strings['payload.cancel'], exact: true }).click()
    await panel.getByText(strings['payload.error.cancelled'], { exact: true }).waitFor()
    await page.evaluate(() => window.__waarpTest.state.resolvePayload())
    await settle(page)
    assert.equal(await panel.locator('.kv').count(), 0, 'the obsolete transfer cannot become a successful report')
    assert.equal(await panel.getByRole('button', { name: strings['payload.run'], exact: true }).isEnabled(), true)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.payloadCancel), 1)
    await page.context().close()
  })
  await check('diagnosis applies the proven profile through its token and refuses a stale result', async () => {
    const page = await pageFor()
    await ready(page); await clickNav(page, 'an')
    await page.getByPlaceholder(strings['an.probe.ph']).fill('https://example.com:8443/path?query=sample')
    await page.getByRole('button', { name: strings['an.probe.go'], exact: true }).click()
    const applyName = strings['dg.route.card'].replace('{v}', 'Personal B')
    await page.getByRole('button', { name: applyName, exact: true }).click()
    await page.waitForFunction(() => window.__waarpTest.state.settings.routes[0].via === 'b')
    assert.deepEqual(await page.evaluate(() => window.__waarpTest.state.lastDiagnosisApply), { token: 'diagnosis-1', via: 'b' })
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.settings ?? 0), 0, 'UI cannot bypass the main diagnosis guard with a generic settings patch')
    await page.evaluate(() => { const f = window.__waarpTest; f.state.settings.routes[0].via = 'a'; f.state.rejectDiagnosisApply = true; f.push() })
    await page.getByRole('button', { name: applyName, exact: true }).click()
    await page.waitForFunction(() => window.__waarpTest.state.calls.diagnose === 2)
    await page.getByRole('button', { name: applyName, exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__waarpTest.state.settings.routes[0].via), 'a', 'stale apply refreshes evidence without silently changing the route')
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.diagnoseApply), 2)
    await page.context().close()
  })
  await check('leaving diagnostics cancels the operation and ignores a late result', async () => {
    const page = await pageFor({ deferDiagnose: true })
    await ready(page); await clickNav(page, 'an')
    await page.getByRole('button', { name: strings['an.probe.go'], exact: true }).click()
    await page.waitForFunction(() => typeof window.__waarpTest.state.resolveDiagnose === 'function')
    const before = await page.evaluate(() => window.__waarpTest.state.calls.diagnoseCancel)
    await clickNav(page, 'servers')
    await page.waitForFunction(before => window.__waarpTest.state.calls.diagnoseCancel > before, before)
    await page.evaluate(() => window.__waarpTest.state.resolveDiagnose())
    await clickNav(page, 'an'); await settle(page)
    assert.equal(await page.locator('.dg').count(), 0, 'unmounted result never reappears in a new diagnostics page')
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.diagnoseApply ?? 0), 0)
    await page.context().close()
  })
  await check('technical details stay public and keyboard-accessible at 900px; export is explicit', async () => {
    const page = await pageFor()
    await ready(page); await page.setViewportSize({ width: 900, height: 600 })
    await page.evaluate(() => { const f = window.__waarpTest; f.state.profiles[0].tech = [['transport', 'xhttp'], ['fp', 'chrome']]; f.state.profiles[0].notApplied = ['unsupported-field']; f.push() })
    await clickNav(page, 'servers')
    const detail = page.locator('.srv-adv').first(), summary = detail.locator('summary')
    await summary.focus(); await page.keyboard.press('Enter')
    await detail.getByText('xhttp', { exact: true }).waitFor({ state: 'visible' })
    await detail.getByText('unsupported-field', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('button', { name: strings['tech.config'], exact: true }).count(), 0, 'ordinary technical facts do not require developer mode')
    assert.ok(await page.evaluate(() => document.querySelector('.main').scrollWidth - document.querySelector('.main').clientWidth) <= 1)
    await capture(page, 'technical-details-min-width.png')
    await clickNav(page, 'settings')
    const dev = page.getByRole('switch', { name: strings['set.dev'], exact: true })
    assert.equal(await dev.getAttribute('aria-checked'), 'false')
    const exportButton = page.getByRole('button', { name: strings['set.diag.go'], exact: true })
    await page.evaluate(() => { window.__waarpTest.state.exportCanceled = true })
    await exportButton.click()
    await settle(page)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.exportDiag), 1)
    assert.equal(await page.getByText(strings['set.diag.done'], { exact: true }).count(), 0, 'canceling a save dialog is not an exported file')
    await page.evaluate(() => { window.__waarpTest.state.exportCanceled = false })
    await exportButton.focus(); await page.keyboard.press('Enter')
    await page.getByText(strings['set.diag.done'], { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.exportDiag), 2)
    await page.getByRole('button', { name: strings['set.history.show'], exact: true }).click()
    await page.locator('pre.log').filter({ hasText: 'lastSession' }).waitFor()
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.diagnosticHistory), 1)
    await page.getByRole('button', { name: strings['set.history.clear'], exact: true }).click()
    await page.getByText(strings['set.history.cleared'], { exact: true }).waitFor()
    assert.equal(await page.locator('pre.log').count(), 0)
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.clearDiagnosticHistory), 1)
    await dev.focus(); await page.keyboard.press('Space')
    await clickNav(page, 'servers')
    await page.locator('.srv-adv').first().locator('summary').click()
    await page.getByRole('button', { name: strings['tech.config'], exact: true }).first().click()
    await page.locator('.srv-adv').first().locator('pre').waitFor()
    assert.ok((await page.locator('.srv-adv').first().locator('pre').textContent()).includes('•••'))
    await capture(page, 'technical-config-min-width.png')
    assert.deepEqual(pageConsoleErrors.get(page), [], 'technical details and developer actions log no renderer errors')
    await page.context().close()
  })
  await check('route and backup server pickers remain bounded, searchable and readable with 160 long names', async () => {
    const page = await pageFor()
    await ready(page)
    await page.evaluate(() => {
      const f = window.__waarpTest, seed = f.state.profiles[0]
      f.state.profiles = Array.from({ length: 160 }, (_, i) => ({
        ...seed, id: 'bulk-' + i,
        name: 'UnbreakableVeryLongImportedServerNameWithoutSeparators-' + i + '-AcrossEveryRegionAndProtocol',
        host: '192.0.2.' + (i % 200 + 1),
      }))
      f.state.settings.routes[0].via = 'bulk-159'
      f.state.status = { ...f.state.status, phase: 'on', open: true,
        pings: Object.fromEntries(f.state.profiles.map((p, i) => [p.id, 50 + i])) }
      f.push()
    })
    await page.locator('.rc-open').first().click()
    await page.locator('.route-choices').first().waitFor()
    const lists = page.locator('.route-choices')
    assert.equal(await lists.count(), 2, 'primary and backup options remain available')
    assert.equal(await lists.first().locator('.vopt').count(), 8, 'default primary choices are bounded')
    assert.equal(await lists.nth(1).locator('.vopt').count(), 8, 'default backup choices are bounded')
    assert.ok((await lists.first().locator('.vopt.on .vo-name').textContent()).includes('159'), 'selected path always remains visible')
    const search = page.getByRole('searchbox', { name: 'Поиск подключений' })
    await search.fill('-117-AcrossEvery')
    assert.equal(await lists.first().locator('.vopt').count(), 1)
    await search.fill('')
    await page.getByRole('button', { name: /^Показать ещё/ }).first().click()
    assert.equal(await lists.first().locator('.vopt').count(), 24)
    await page.getByRole('button', { name: /^Показать ещё/ }).first().click()
    assert.equal(await lists.first().locator('.vopt').count(), 40)
    const backupSearch = page.getByRole('searchbox', { name: 'Поиск резервных подключений' })
    await backupSearch.fill('-120-AcrossEvery')
    assert.equal(await lists.nth(1).locator('.vopt').count(), 1)
    await backupSearch.fill('')
    for (const width of [1240, 900, 720, 620]) {
      await page.setViewportSize({ width, height: 780 })
      await settle(page)
      const measures = await page.evaluate(() => {
        const main = document.querySelector('.main')
        const cards = [...document.querySelectorAll('.route-choices .vopt')].slice(0, 20)
        return { overflow: main.scrollWidth - main.clientWidth,
          cards: cards.map(card => {
            const name = card.querySelector('.vo-name'), metric = card.querySelector('.vo-metric')
            return { width: card.scrollWidth - card.clientWidth,
              name: name ? name.getBoundingClientRect().right - card.getBoundingClientRect().right : 0,
              metric: metric ? metric.getBoundingClientRect().right - card.getBoundingClientRect().right : 0 }
          }) }
      })
      assert.ok(measures.overflow <= 1, 'route page must not overflow main container at ' + width)
      assert.ok(measures.cards.every(card => card.width <= 1 && card.name <= 1 && card.metric <= 1),
        'labels and metrics must remain within their cards at ' + width + ': ' + JSON.stringify(measures.cards))
    }
    assert.equal(await page.evaluate(() => window.__waarpTest.state.calls.selectRoute ?? 0), 0,
      'search and expansion never change routing or toggle TUN')
    await capture(page, 'route-picker-long-labels.png')
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
  await check('100 production renderer cycles keep state, subscriptions and retained memory bounded', rendererStability)
  assert.deepEqual(errors, [], 'no unhandled promises or React rendering errors')
  console.log(`\n${passed} browser regressions passed; no engine or system routing was started.`)
} catch (error) {
  if (errors.length) console.error('Renderer errors observed before the failed assertion:', errors)
  if (screenshotDir) {
    let n = 0
    for (const context of browser.contexts()) for (const page of context.pages()) {
      await page.screenshot({ path: resolve(screenshotDir, `failure-${++n}.png`) }).catch(() => undefined)
    }
  }
  throw error
} finally { await browser.close() }
