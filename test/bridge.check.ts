// Companion bridge: generic target descriptor, intents, trust boundary, safe responses, old clients unaffected
// (offline: local pipe, fake host; fixtures use reserved documentation names only)
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from '../src/main/bridge'
import { bridgeStatus, createPending, PICK_TTL, companionEditsOk, companionRoutesSafe, ensureIntent, listCompanion, parseTarget, pickOptions, routeOf, safeVia } from '../src/shared/companion'
import { checkedPatch } from '../src/main/validate'
import { AUTO_ID } from '../src/shared/groups'
import { DEFAULTS } from '../src/main/store-core'
import type { Route, Settings } from '../src/shared/types'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const own = [{ id: 'a' }, { id: 'b' }]
const pub = [{ id: 'p', source: 'public' }]
const S = (routes: Route[] = []): Settings => ({ ...DEFAULTS, routes })
const T = { id: 'ext:demo:app', name: 'Demo App', host: 'companion.example.com' }
const ID = T.id
const R = (via: string, extra: Partial<Route> = {}): Route => ({ id: ID, kind: 'custom', name: T.name, value: T.host, via, on: true, owner: 'companion', ...extra })

;(async () => {
  // ---- descriptor
  eq(parseTarget(T), T, 'a well-formed descriptor is accepted')
  for (const [bad, why] of [
    [{ ...T, id: 'demo:app' }, 'id outside ext:'], [{ ...T, id: 'ext:Demo:app' }, 'uppercase id'], [{ ...T, id: 'ext:demo:app:x' }, 'extra id segment'],
    [{ ...T, id: 'ext:' + 'a'.repeat(30) + ':x' }, 'long namespace'], [{ ...T, name: '' }, 'empty name'], [{ ...T, name: ' x' }, 'untrimmed name'],
    [{ ...T, name: 'a'.repeat(41) }, 'long name'], [{ ...T, name: 'a\nb' }, 'control char in name'],
    [{ ...T, host: 'https://companion.example.com' }, 'scheme'], [{ ...T, host: 'companion.example.com/path' }, 'path'],
    [{ ...T, host: 'user:pw@example.com' }, 'credentials'], [{ ...T, host: 'example.com:443' }, 'port'], [{ ...T, host: 'Example.COM' }, 'not normalized'],
    [{ ...T, host: '203.0.113.5' }, 'IP instead of FQDN'], [{ ...T, host: '*.example.com' }, 'wildcard'], [{ ...T, host: 'localhost' }, 'single label'],
    [{ ...T, exe: 'C:\\x.exe' }, 'unknown key'], ['ext:demo:app', 'plain string'], [null, 'null'], [[T], 'array'],
  ] as [unknown, string][]) eq(parseTarget(bad), undefined, 'descriptor rejected: ' + why)

  // ---- pure intent semantics
  eq(ensureIntent(S(), own, { ...T, host: 'x' }, 'auto'), { error: 'bad_target' }, 'malformed target rejected')
  eq(ensureIntent(S(), own, T, 'tunnel'), { error: 'bad_intent' }, 'bad intent rejected')
  const d = ensureIntent(S(), own, T, 'direct') as { settings: Settings }
  eq(routeOf(d.settings, ID), R('direct'), 'direct creates the companion route')
  const a = ensureIntent(S(), own, T, 'auto') as { settings: Settings }
  eq(routeOf(a.settings, ID)?.via, AUTO_ID, 'auto = g-auto')
  eq(ensureIntent(S(), pub, T, 'auto'), { error: 'no_auto' }, 'Auto with only public nodes: no_auto, never Direct / public')
  eq(ensureIntent(S(), [], T, 'auto'), { error: 'no_auto' }, 'Auto with nothing: no_auto')
  eq(a.settings.rest, DEFAULTS.rest, 'scope (rest) untouched')
  // an id is never redefined
  eq(ensureIntent(d.settings, own, { ...T, host: 'other.example.org' }, 'direct'), { error: 'conflict' }, 'same id, another host: conflict')
  eq(ensureIntent(d.settings, own, { ...T, name: 'Other' }, 'direct'), { error: 'conflict' }, 'same id, another name: conflict')
  eq(ensureIntent(S([{ ...R('a'), owner: undefined, id: ID }]), own, T, 'direct'), { error: 'conflict' }, 'a non-companion route under the id: conflict')
  eq(routeOf(d.settings, ID)?.value, T.host, '...and nothing was rewritten')
  // waarp
  const chosen = S([R('b', { on: false })])
  const w = ensureIntent(chosen, own, T, 'waarp') as { settings: Settings }
  eq([routeOf(w.settings, ID)?.via, routeOf(w.settings, ID)?.on], ['b', true], 'waarp keeps the concrete path the user chose')
  eq(ensureIntent(S(), own, T, 'waarp'), { error: 'needs_choice' }, 'waarp without a route: needs_choice')
  eq(ensureIntent(a.settings, own, T, 'waarp'), { error: 'needs_choice' }, 'waarp on Auto is not a concrete choice')
  eq(ensureIntent(d.settings, own, T, 'waarp'), { error: 'needs_choice' }, 'waarp on Direct is not a concrete choice')
  eq(ensureIntent(S([R('deleted')]), own, T, 'waarp'), { error: 'blocked' }, 'a deleted chosen path is blocked, not replaced')
  eq((ensureIntent(d.settings, own, T, 'direct') as { changed: boolean }).changed, false, 'same intent twice writes nothing')
  // list is safe
  const view = listCompanion(a.settings, { [ID]: { desired: AUTO_ID, effective: 'a', state: 'ok' } }, v => (v === 'a' ? 'Сервер 1' : undefined))
  eq(view, [{ id: ID, name: T.name, intent: 'auto', on: true, state: 'ok', via: 'Сервер 1' }], 'list = id + name + intent + state + display name')
  ok(!JSON.stringify(view).includes(T.host), 'list never echoes the host')
  eq(listCompanion(S(), undefined, () => 'x'), [], 'no companion routes yet')
  eq(listCompanion(S([{ id: 'u', kind: 'custom', name: 'mine', value: 'example.net', via: 'a', on: true }]), undefined, () => 'x'), [], 'user routes are not listed')

  // ---- safety policy for every companion route
  const prof = [{ id: 'a' }, { id: 'b' }, { id: 'p', source: 'public' }, { id: 'r', revoked: true }]
  const G = (id: string, members: string[]) => ({ id, name: id, policy: 'first' as const, members })
  const base = (via: string, extra: Partial<Route> = {}, groups: Settings['groups'] = []): Settings => ({ ...S([R(via, extra)]), groups })
  eq(ensureIntent(base('p'), prof, T, 'waarp'), { error: 'blocked' }, 'B: public concrete path -> waarp blocked, not replaced')
  eq(ensureIntent(base('g-mix', {}, [G('g-mix', ['a', 'p'])]), prof, T, 'waarp'), { error: 'blocked' }, 'B: group with one public member -> blocked')
  ok('settings' in ensureIntent(base('g-own', {}, [G('g-own', ['a', 'b'])]), prof, T, 'waarp'), 'B: own-only group accepted')
  ok(!safeVia('g-public', { groups: [G('g-public', ['p'])] }, prof), 'B: the public auto-group is never safe')
  ok(!safeVia('r', { groups: [] }, prof) && !safeVia('gone', { groups: [] }, prof), 'B: revoked / missing never safe')
  for (const intent of ['direct', 'auto'] as const) {
    const r = ensureIntent(base('a', { fallback: 'p' }), prof, T, intent) as { settings: Settings }
    eq(routeOf(r.settings, ID)?.fallback, undefined, 'B: stale public fallback cannot survive ' + intent + ' ensure')
  }
  ok(!companionRoutesSafe(base('a', { fallback: 'p' }), prof), 'B: main rejects a companion route with a public fallback')
  ok(!companionRoutesSafe(base('p'), prof), 'B: main rejects a companion route on a public path')
  ok(companionRoutesSafe(base('a', { fallback: 'b' }), prof), 'B: own fallback allowed')
  eq(pickOptions({ groups: [G('g-own', ['a']), G('g-mix', ['a', 'p'])] }, [...prof, { id: 'g-own', kind: 'group' }, { id: 'g-mix', kind: 'group' }, { id: AUTO_ID, kind: 'group' }]), ['a', 'b', 'g-own'], 'picker: own paths and own-only groups; no public / revoked / Auto / mixed group')

  // ---- correction B: every declared group member must be own, live, non-public, concrete
  const P2 = [{ id: 'a' }, { id: 'b' }, { id: 'p', source: 'public' }, { id: 'r', revoked: true }, { id: 'g-x', kind: 'group' }]
  const gs = (members: string[]) => ({ groups: [G('g-t', members)] })
  ok(!safeVia('g-t', gs(['a', 'missing']), P2), 'B2: own + missing member -> unsafe')
  ok(!safeVia('g-t', gs(['a', 'r']), P2), 'B2: own + revoked member -> unsafe')
  ok(!safeVia('g-t', gs(['a', 'p']), P2), 'B2: own + public member -> unsafe')
  ok(!safeVia('g-t', gs(['a', 'g-x']), P2), 'B2: a member that is itself a group -> unsafe')
  ok(!safeVia('g-t', gs([]), P2), 'B2: empty group -> unsafe')
  ok(safeVia('g-t', gs(['a', 'b']), P2), 'B2: all own live members -> safe')
  eq(ensureIntent({ ...S([R('g-t')]), ...gs(['a', 'r']) }, P2, T, 'waarp'), { error: 'blocked' }, 'B2: waarp on a group with a revoked member is blocked')

  // ---- correction A: the bridge status DTO
  eq(Object.keys(bridgeStatus('on', 'ok', '1.2.3', 5)), ['phase', 'mood', 'version', 'since'], 'A2: status DTO keys exactly')
  eq(bridgeStatus('off', 'ok', '1.2.3'), { phase: 'off', mood: 'ok', version: '1.2.3' }, 'A2: since omitted when unknown')
  const main = readFileSync('src/main/index.ts', 'utf8')
  ok(main.includes('status: () => bridgeStatus(') && !main.includes('status: () => ({ phase'), 'A2: Waarp main wires bridge status through the DTO')

  // ---- correction C: picker requests expire
  const pend = createPending(8, PICK_TTL)
  pend.put(T, 0)
  eq(pend.get(ID, PICK_TTL - 1)?.id, ID, 'C: a fresh request is found')
  eq(pend.get(ID, PICK_TTL), undefined, 'C: an expired request is gone')
  for (let i = 0; i < 9; i++) pend.put({ ...T, id: 'ext:demo:t' + i }, 1000)
  eq([pend.size, pend.get('ext:demo:t0', 1000), pend.get('ext:demo:t8', 1000)?.id], [8, undefined, 'ext:demo:t8'], 'C: bounded to 8, oldest dropped')
  pend.drop('ext:demo:t8'); eq(pend.get('ext:demo:t8', 1000), undefined, 'C: a completed request is removed')

  // ---- A: the renderer cannot forge or redefine a companion route
  const forge = (r: Record<string, unknown>) => checkedPatch({ routes: [{ id: 'x', kind: 'custom', name: 'x', value: 'evil.example.com', via: 'direct', on: true, ...r }] })
  eq(forge({ owner: 'other' }).ok, false, 'A: unknown owner rejected')
  eq(forge({ owner: 'companion' }).ok, false, 'A: owner companion on a non-ext id rejected')
  eq(forge({ id: 'ext:x' }).ok, false, 'A: malformed ext: id rejected')
  eq(forge({ id: ID }).ok, false, 'A: reserved ext: id without the owner rejected')
  const stored = [R('a')]
  ok(!companionEditsOk([{ ...R('direct'), id: 'ext:demo:new' }], stored), 'A: renderer cannot create a companion route')
  ok(!companionEditsOk([R('a', { value: 'evil.example.com' })], stored), 'A: renderer cannot change the host')
  ok(!companionEditsOk([R('a', { name: 'Renamed' })], stored), 'A: renderer cannot rename the target')
  ok(!companionEditsOk([R('a', { owner: undefined })], stored), 'A: renderer cannot drop the owner and keep the id')
  ok(companionEditsOk([R('direct', { on: false })], stored), 'A: path / on state edits of the stored route accepted')
  ok(companionEditsOk([], stored), 'A: deleting the route is the user\'s right')

  // ---- over the pipe
  const dir = mkdtempSync(join(tmpdir(), 'waarp-bridge-'))
  const pipe = '\\\\.\\pipe\\waarp-test-' + process.pid
  let settings = S()
  let connects = 0, navs: unknown[] = [], slow = false, inFlight = 0, maxInFlight = 0
  const secretish = { host: '203.0.113.10', key: 'PRIVATEKEY', token: 'should-not-leak' }
  const server = startBridge(dir, {
    version: '9.9.9',
    status: () => bridgeStatus('off', 'ok', '9.9.9'),
    log: () => ['line'],
    routes: {
      list: () => ({ routes: listCompanion(settings, undefined, v => (v === 'a' ? 'Сервер 1' : undefined)) }),
      ensure: async (t, i) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
        const snapshot = settings
        if (slow) await new Promise(r => setTimeout(r, 40))
        const r = ensureIntent(snapshot, own, t, i)
        if (!('error' in r)) settings = r.settings
        inFlight--
        return 'error' in r ? r : { ok: true, route: listCompanion(settings, undefined, () => undefined)[0] }
      },
      open: t => { const p = parseTarget(t); if (!p) return { error: 'bad_target' }; navs.push(p.id); return { ok: true } },
    },
  }, pipe)
  await new Promise(r => setTimeout(r, 100))
  const token = JSON.parse(readFileSync(join(dir, 'bridge.json'), 'utf8')).token as string
  const call = (method: string, params?: unknown, tok = token): Promise<any> => new Promise((res, rej) => {
    const s = connect(pipe); let buf = ''
    s.setEncoding('utf8'); s.on('data', c => { buf += c; const i = buf.indexOf('\n'); if (i >= 0) { s.destroy(); res(JSON.parse(buf.slice(0, i))) } }); s.on('error', rej)
    s.write(JSON.stringify({ id: 1, token: tok, method, params }) + '\n')
  })
  const hello = await call('hello')
  ok(['hello', 'status', 'log', 'routes.list', 'routes.ensure', 'routes.open'].every(m => hello.result.methods.includes(m)), 'hello advertises the route methods')
  ok(!hello.result.methods.includes('connect') && !hello.result.methods.includes('routes.remove'), 'no connect / disconnect / remove in v1')
  eq(hello.result.api, 1, 'API stays 1 (additive)')
  const st = await call('status')
  eq(st.result.phase, 'off', 'status works')
  const stj = JSON.stringify(st)
  ok(!stj.includes(secretish.host) && !stj.includes('Сервер 1') && !/servers|pings|health|engine|"routes"/.test(stj), 'A2: status has no server host / name / id, pings, health or engine keys')
  eq((await call('log')).result, ['line'], 'old client: log still works')
  eq((await call('connect')).error, 'not_implemented', 'connect stays not implemented')
  eq((await call('routes.ensure', { target: T, intent: 'auto' }, 'wrong')).error, 'unauthorized', 'token required')
  eq((await call('routes.ensure', { target: { ...T, host: 'https://evil.example.com/x' }, intent: 'auto' })).error, 'bad_target', 'bad target over the pipe')
  const en = await call('routes.ensure', { target: T, intent: 'direct' })
  eq([en.result.ok, settings.routes.length, connects], [true, 1, 0], 'direct saved while off, nothing connected')
  eq((await call('routes.ensure', { target: T, intent: 'waarp' })).error, 'needs_choice', 'waarp without a concrete path: needs_choice')
  eq(routeOf(settings, ID)?.via, 'direct', '...and wrote nothing')
  const before = JSON.stringify(settings)
  eq((await call('routes.open', { target: T })).result, { ok: true }, 'open accepts a valid descriptor')
  eq((await call('routes.open', { target: '../../evil' })).error, 'bad_target', 'open rejects anything else')
  eq([JSON.stringify(settings) === before, navs.length], [true, 1], 'open only navigates; no route / network change')
  const listed = JSON.stringify(await call('routes.list'))
  ok(!listed.includes(secretish.host) && !listed.includes(T.host) && !listed.includes('PRIVATE') && !listed.includes(token) && !/tag|outbound|endpoint/.test(listed), 'list has no host / key / token / engine tags')
  ok(!JSON.stringify(en).includes(token), 'responses never echo the token')

  // D: two concurrent ensures on one socket are serialized; each answer reflects its own completed write
  const s2 = connect(pipe); let buf2 = ''; const answers: any[] = []
  const done2 = new Promise<void>(res => { s2.setEncoding('utf8'); s2.on('data', c => { buf2 += c; let i: number; while ((i = buf2.indexOf('\n')) >= 0) { answers.push(JSON.parse(buf2.slice(0, i))); buf2 = buf2.slice(i + 1) } if (answers.length === 2) res() }) })
  slow = true
  s2.write(JSON.stringify({ id: 'A', token, method: 'routes.ensure', params: { target: T, intent: 'auto' } }) + '\n' + JSON.stringify({ id: 'B', token, method: 'routes.ensure', params: { target: T, intent: 'direct' } }) + '\n')
  await done2; s2.destroy(); slow = false
  const byId = Object.fromEntries(answers.map(x => [x.id, x.result.route.intent]))
  eq(byId, { A: 'auto', B: 'direct' }, 'D: each response describes its own mutation')
  eq([routeOf(settings, ID)?.via, maxInFlight], ['direct', 1], 'D: no overlap, last write wins in order')

  server.close()
  await new Promise(r => setTimeout(r, 50))
  rmSync(dir, { recursive: true, force: true })
  console.log(`bridge.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
