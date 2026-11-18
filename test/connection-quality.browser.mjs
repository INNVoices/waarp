import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function fixture(options) {
  const listeners = new Map()
  const on = name => callback => {
    const group = listeners.get(name) ?? new Set(); group.add(callback); listeners.set(name, group)
    return () => group.delete(callback)
  }
  const state = {
    calls: {}, requests: [], mode: options.mode ?? 'candidate', deferApply: options.deferApply === true,
    settings: { rest: 'g-auto', groups: [], ruDirect: true, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: true,
      routes: [
        { id: 'app:game', kind: 'app', name: options.longName ? 'Игровой клиент с длинным названием и отдельным профилем соединения для проверки компоновки' : 'Игровой клиент', exe: 'C:\\Games\\game.exe', on: true, via: 'a', connectionUse: 'game' },
        { id: 'custom:control.example', kind: 'custom', name: 'Отдельный сайт', value: 'control.example', on: true, via: 'a' }
      ] },
    profiles: [
      { id: 'a', kind: 'out', source: 'personal', name: 'Основной', host: '192.0.2.1', port: 443, address: [], version: 'Trojan' },
      { id: 'b', kind: 'out', source: 'personal', name: options.longName ? 'Резервное личное подключение с длинным названием Frankfurt — TCP/TLS' : 'Резервный', host: '192.0.2.2', port: 443, address: [], version: 'Trojan' }
    ],
    status: { phase: options.on ? 'on' : 'off', open: options.on === true, pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0,
      routes: { 'app:game': { desired: 'a', effective: 'a', state: options.on ? 'ok' : 'off' } } }
  }
  const count = name => state.calls[name] = (state.calls[name] ?? 0) + 1
  const snapshot = () => structuredClone({ admin: true, settings: state.settings, profiles: state.profiles, status: state.status, notices: [] })
  const push = () => { for (const callback of listeners.get('snapshot') ?? []) callback(snapshot()) }
  const result = (target, routeId) => {
    const route = state.settings.routes.find(r => r.id === routeId || !routeId && r.kind === 'custom' && target.includes(r.value))
    const healthy = state.mode === 'healthy'
    const ok = { result: 'ok' }, skipped = { result: 'skipped' }
    const failed = { attempted: 2, responded: 0, noResponse: 2 }
    const answered = ms => ({ attempted: 2, responded: 2, noResponse: 0, medianMs: ms, spreadMs: 2 })
    state.proof = { routeId, token: 'fixture-' + state.calls.diagnose }
    return {
      target, host: new URL(target.includes('://') ? target : 'https://' + target).hostname, at: Date.now(), token: state.proof.token, systemPath: true,
      currentVia: 'a',
      direct: { dnsSystem: ok, dnsDoh: ok, tcp: { result: 'fail', code: 'reset' }, tls: skipped, http: skipped },
      paths: { a: healthy ? 180 : null, b: 40 }, samples: { a: healthy ? answered(180) : failed, b: answered(40) },
      finding: { kind: 'restricted_direct', layer: 'tcp', via: ['b'] },
      scope: route ? { routeId: route.id, routeName: route.name, selectedVia: route.via, effectiveVia: route.via, connectionUse: route.connectionUse ?? 'general' } : undefined,
      assessment: { current: healthy ? 'responded' : 'failed', reason: healthy ? 'current-responded' : 'alternative-responded', ...(healthy ? {} : { recommendedVia: 'b' }), coverage: 'http-response', applicationVerified: false, missing: ['udp-response', 'packet-loss', 'jitter', 'application-session'] }
    }
  }
  window.__quality = { state, push }
  window.api = {
    snapshot: async () => snapshot(), scanApps: async () => [], clipPeek: async () => ({ kind: 'none' }),
    onSnapshot: on('snapshot'), onStatus: on('status'), onConns: on('conns'), onApps: on('apps'), onToast: on('toast'), onNav: on('nav'), onCatalog: on('catalog'),
    catalogGet: async () => ({ busy: false, total: 0, readyCount: 0, alive: [], sources: [] }),
    catalogPage: async () => ({ items: [], total: 0, page: 1, pages: 1, pageSize: 12, regions: [] }),
    toggle: async () => { count('toggle'); throw new Error('No VPN mutation allowed in this fixture') },
    disconnect: async () => { count('disconnect'); throw new Error('No VPN mutation allowed in this fixture') },
    selectRoute: async () => { count('selectRoute'); throw new Error('Recommendation must use the trusted diagnosis proof') },
    settings: async patch => { count('settings'); Object.assign(state.settings, structuredClone(patch)); push(); return { ...snapshot(), saved: true } },
    diagnose: async (target, routeId) => {
      count('diagnose'); state.requests.push({ target, routeId })
      const reply = result(target, routeId)
      if (state.mode === 'slow') return new Promise(resolve => { state.resolveProbe = () => resolve(reply) })
      return reply
    },
    diagnoseCancel: async () => { count('cancel'); return true },
    diagnoseApply: async (token, via) => {
      count('apply')
      if (state.proof?.token !== token || via !== 'b') return { ok: false, error: 'stale' }
      const finish = () => {
        state.settings.routes = state.settings.routes.map(route => route.id === state.proof.routeId ? { ...route, via, on: true, fallback: undefined } : route)
        state.status.routes['app:game'] = { desired: via, effective: via, state: state.status.phase === 'on' ? 'ok' : 'off' }
        push()
        return { ok: true, id: state.proof.routeId, applied: state.status.phase === 'on' }
      }
      if (state.deferApply) return new Promise(resolve => { state.resolveApply = () => resolve(finish()) })
      return finish()
    },
    payloadLast: async () => undefined, win: () => undefined
  }
}

export async function runConnectionQualityChecks({ browser, url, screenshotDir }) {
  const strings = JSON.parse(readFileSync(new URL('../src/shared/strings/ru.json', import.meta.url), 'utf8'))
  const failures = []
  let passed = 0
  const run = async (name, options, work) => {
    const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: options.width ?? 1240, height: 900 } })
    page.setDefaultTimeout(7000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(fixture, options)
    try {
      await page.goto(url)
      if (options.main) await page.getByRole('button', { name: strings['nav.an'], exact: true }).click()
      else await page.locator('.rc-open').first().click()
      await work(page)
      assert.deepEqual(errors, [])
      const calls = await page.evaluate(() => window.__quality.state.calls)
      assert.equal(calls.toggle ?? 0, 0); assert.equal(calls.disconnect ?? 0, 0); assert.equal(calls.selectRoute ?? 0, 0)
      console.log('PASS quality UI: ' + name); passed++
    } catch (error) { failures.push(name + ': ' + error.message) }
    finally { await page.close() }
  }
  const open = async page => { await page.getByRole('button', { name: strings['quality.open'], exact: true }).click(); await page.getByRole('textbox', { name: strings['quality.target'] }).waitFor() }
  const probe = async page => { await page.getByRole('textbox', { name: strings['quality.target'] }).fill('https://control.example/'); await page.getByRole('button', { name: strings['an.probe.go'], exact: true }).click() }

  await run('unknown app has no guessed endpoint; cancel rejects late result; Back returns to card', { mode: 'slow' }, async page => {
    await open(page)
    assert.equal(await page.getByRole('textbox', { name: strings['quality.target'] }).inputValue(), '')
    assert.equal(await page.evaluate(() => window.__quality.state.calls.diagnose ?? 0), 0)
    await probe(page)
    await page.getByRole('button', { name: strings['quality.cancel'], exact: true }).click()
    await page.getByText(strings['quality.notice.cancelled'], { exact: true }).waitFor()
    await page.evaluate(() => window.__quality.state.resolveProbe())
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.quality-result').count(), 0)
    assert.equal(await page.evaluate(() => window.__quality.state.calls.apply ?? 0), 0)
    await page.getByRole('button', { name: strings['quality.back'], exact: true }).click()
    await page.getByRole('heading', { name: 'Игровой клиент', exact: true }).waitFor()
  })

  await run('candidate applies only to the inspected app; native ACK determines success', { on: true, deferApply: true }, async page => {
    await open(page); await probe(page)
    await page.getByText(strings['quality.coverage.game'], { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Использовать Резервный для «Игровой клиент»', exact: true }).click()
    await page.getByText(strings['quality.applying'], { exact: true }).waitFor()
    assert.equal(await page.getByText(strings['quality.notice.applied'], { exact: true }).count(), 0)
    await page.evaluate(() => window.__quality.state.resolveApply())
    await page.getByText(strings['quality.notice.applied'], { exact: true }).waitFor()
    const state = await page.evaluate(() => ({ routes: window.__quality.state.settings.routes, rest: window.__quality.state.settings.rest, requests: window.__quality.state.requests, apply: window.__quality.state.calls.apply }))
    assert.equal(state.apply, 1); assert.equal(state.routes[0].via, 'b'); assert.equal(state.routes[1].via, 'a'); assert.equal(state.rest, 'g-auto')
    assert.deepEqual(state.requests, [{ target: 'https://control.example/', routeId: 'app:game' }])
  })

  await run('responding current path is retained even when another HTTP timing is lower', { mode: 'healthy' }, async page => {
    await open(page); await probe(page)
    await page.getByText(strings['quality.result.current-responded'], { exact: true }).waitFor()
    await page.getByText(strings['diag.next.keep'], { exact: true }).waitFor()
    assert.equal(await page.locator('.quality-result .btn').count(), 0)
    await page.locator('.quality-proof > summary').click()
    await page.getByText(strings['quality.system.hint'], { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__quality.state.calls.apply ?? 0), 0)
  })

  await run('route changes invalidate visible evidence; purpose saves as metadata', { on: true }, async page => {
    await page.locator('.route-details > summary').click()
    await page.getByRole('combobox', { name: strings['quality.use'], exact: true }).selectOption('interactive')
    assert.equal(await page.evaluate(() => window.__quality.state.settings.routes[0].connectionUse), 'interactive')
    await open(page); await probe(page)
    await page.getByText(strings['quality.coverage.interactive'], { exact: true }).waitFor()
    await page.evaluate(() => { window.__quality.state.settings.routes[0].exe = 'C:\\Games\\different.exe'; window.__quality.push() })
    await page.getByText(strings['quality.notice.stale'], { exact: true }).waitFor()
    assert.equal(await page.locator('.quality-result').count(), 0)
  })

  for (const width of [900, 1240, 1600]) await run('long names and proof layout at ' + width + ' px', { width, longName: true }, async page => {
    await open(page); await probe(page)
    await page.locator('.quality-result').waitFor()
    await page.locator('.quality-proof > summary').click()
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.main')
      const box = main.getBoundingClientRect()
      return { root: document.documentElement.scrollWidth > innerWidth + 1, main: main.scrollWidth > main.clientWidth + 1,
        bad: [...document.querySelectorAll('.quality-result, .quality-result .btn, .quality-proof, .quality-path')].filter(el => el.getBoundingClientRect().right > box.right + 1).length }
    })
    assert.deepEqual(overflow, { root: false, main: false, bad: 0 })
    if (screenshotDir) { mkdirSync(screenshotDir, { recursive: true }); await page.screenshot({ path: resolve(screenshotDir, `quality-context-${width}.png`), fullPage: true }) }
  })
  for (const width of [900, 1240]) await run('main diagnostics investigates automatically and explains the next step at ' + width + ' px', { width, main: true, on: true }, async page => {
    await page.locator('.quality-result').waitFor()
    assert.deepEqual(await page.evaluate(() => window.__quality.state.requests), [{ target: 'youtube.com', routeId: undefined }])
    assert.equal(await page.locator('.diagnostic-stages .diagnostic-stage').count(), 4)
    await page.getByText(strings['diag.detail.tcp-refused'], { exact: true }).waitFor()
    await page.getByText(strings['diag.next.tcp-refused'], { exact: true }).waitFor()
    assert.equal(await page.locator('.payload-check').count(), 0, 'unrequested transfer tools do not dominate the investigation')
    await page.getByRole('textbox', { name: strings['quality.target'] }).fill('https://control.example/')
    await page.waitForFunction(() => window.__quality.state.calls.diagnose === 2)
    await page.getByRole('button', { name: 'Использовать Резервный для «Отдельный сайт»', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__quality.state.calls.apply ?? 0), 0, 'a diagnosis never applies its suggestion automatically')
    await page.waitForTimeout(750)
    assert.equal(await page.evaluate(() => window.__quality.state.calls.diagnose), 2, 'a completed target is not probed in a render loop')
    const overflow = await page.evaluate(() => ({ root: document.documentElement.scrollWidth > innerWidth + 1,
      main: document.querySelector('.main').scrollWidth > document.querySelector('.main').clientWidth + 1 }))
    assert.deepEqual(overflow, { root: false, main: false })
    if (screenshotDir) { mkdirSync(screenshotDir, { recursive: true }); await page.screenshot({ path: resolve(screenshotDir, `diagnostics-main-${width}.png`), fullPage: true }) }
    if (width === 1240) {
      await page.evaluate(() => { window.__quality.state.mode = 'healthy' })
      await page.getByRole('textbox', { name: strings['quality.target'] }).fill('https://another.example/')
      await page.getByText(strings['quality.result.current-responded'], { exact: true }).waitFor()
      await page.getByText(strings['diag.next.keep'], { exact: true }).waitFor()
      assert.equal(await page.locator('.quality-result .btn').count(), 0, 'a responding default path is retained even without a matching route scope and despite system TCP failure')
    }
  })
  if (failures.length) throw new Error('Connection quality browser regressions:\n' + failures.join('\n'))
  console.log(`Connection quality browser checks: ${passed} passed`)
  return passed
}
