import assert from 'node:assert/strict'
import { buildRuntime, planSlots, setListResolver } from '../src/main/awg'
import type { OutProfile, Route, Settings } from '../src/shared/types'

const profiles: OutProfile[] = ['first-import', 'second-import'].map(id => ({ kind: 'out', id, name: id,
  host: 'example.org', port: 443, version: 'Trojan', addedAt: 1,
  outbound: { type: 'trojan', server: 'example.org', server_port: 443, password: 'fixture', tls: { enabled: true } } }))
const route = (id: string, value: string, via: string): Route => ({ id, kind: 'custom', name: id, value, via, on: true })
const common: Settings = { rest: 'direct', routes: [], groups: [], ruDirect: false, lanDirect: false,
  dnsAll: false, tray: true, autoConnect: false, autostart: false, notify: false }

// Evaluate the small documented headless-rule grammar in the generated DNS
// files, independently of the compiler's bucket construction. Native schema /
// watcher acceptance is covered by slots.check and the Windows TUN fixture.
function matches(rule: any, host: string, exe: string): boolean {
  let result: boolean
  if (rule.type === 'logical') result = rule.mode === 'and'
    ? rule.rules.every((child: any) => matches(child, host, exe))
    : rule.rules.some((child: any) => matches(child, host, exe))
  else {
    const fields: boolean[] = []
    if (rule.domain_suffix) fields.push(rule.domain_suffix.some((suffix: string) => host === suffix || host.endsWith('.' + suffix)))
    if (rule.domain_regex) fields.push(rule.domain_regex.some((pattern: string) => new RegExp(pattern).test(host)))
    if (rule.process_path) fields.push(rule.process_path.includes(exe))
    if (rule.process_path_regex) fields.push(rule.process_path_regex.some((pattern: string) => new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i').test(exe)))
    result = fields.length > 0 && fields.every(Boolean)
  }
  return rule.invert ? !result : result
}
function resolve(routes: Route[], host: string, exe = '', reversedLibrary = false): string {
  const settings = { ...common, routes }
  const runtime = buildRuntime(reversedLibrary ? [...profiles].reverse() : profiles, settings,
    { api: { port: 1, secret: 'fixture' }, selectors: true, slots: planSlots(settings), preload: profiles.map(p => p.id) })
  for (const rule of runtime.cfg.dns.rules as any[]) {
    const tag = rule.rule_set?.[0]
    if (!tag || !(tag.startsWith('dn-') || tag.startsWith('rest-dns-'))) continue
    if (JSON.parse(runtime.files[tag]).rules.some((entry: any) => matches(entry, host, exe))) return rule.action === 'reject' ? 'blocked' : rule.server
  }
  return runtime.cfg.dns.final
}
const broad = route('broad', 'example.org', 'second-import')
const narrow = route('narrow', 'sub.example.org', 'first-import')
for (const reverseLibrary of [false, true]) {
  assert.equal(resolve([broad, narrow], 'sub.example.org', '', reverseLibrary), 'dns-second-import')
  assert.equal(resolve([narrow, broad], 'sub.example.org', '', reverseLibrary), 'dns-first-import')
  assert.equal(resolve([narrow, broad], 'other.example.org', '', reverseLibrary), 'dns-second-import')
  assert.equal(resolve([{ ...narrow, via: 'missing' }, broad], 'sub.example.org', '', reverseLibrary), 'blocked')
  assert.equal(resolve([{ ...narrow, via: 'direct' }, broad], 'sub.example.org', '', reverseLibrary), 'local')
}
const app: Route = { id: 'app', kind: 'app', name: 'App', exe: 'C:\\App\\app.exe', on: true, via: 'first-import' }
assert.equal(resolve([broad, app], 'sub.example.org', app.exe), 'dns-first-import', 'app policy precedes domain policy')
assert.equal(resolve([broad, { ...app, on: false }], 'sub.example.org', app.exe), 'dns-second-import')
const overlapping = [route('deep', 'deep.sub.example.org', 'direct'), narrow, broad,
  route('other', 'other.example.org', 'missing'), route('same', 'sub.example.org', 'second-import')]
for (let i = 0; i < overlapping.length; i++) {
  const order = [...overlapping.slice(i), ...overlapping.slice(0, i)]
  for (const host of ['example.org', 'sub.example.org', 'deep.sub.example.org', 'other.example.org', 'x.other.example.org']) {
    const first = order.find(r => host === r.value || host.endsWith('.' + r.value))!
    assert.equal(resolve(order, host), first.via === 'missing' ? 'blocked' : first.via === 'direct' ? 'local' : 'dns-' + first.via)
  }
}
const large = Array.from({ length: 50000 }, (_, i) => `n${i}.large.example`)
setListResolver(id => id === 'l-large000' ? large : [`${id}.small.example`])
try {
  const routes: Route[] = [{ id: 'large', kind: 'list', list: 'l-large000', name: 'Large', on: true, via: 'first-import' },
    ...Array.from({ length: 200 }, (_, i): Route => ({ id: 'small' + i, kind: 'list', list: 'l-small' + String(i % 19).padStart(3, '0'), name: 'Small', on: true, via: 'second-import' }))]
  const settings = { ...common, routes }, began = performance.now()
  const runtime = buildRuntime(profiles, settings, { api: { port: 1, secret: 'fixture' }, selectors: true, slots: planSlots(settings) })
  const bytes = Object.values(runtime.files).reduce((total, body) => total + Buffer.byteLength(body), 0)
  assert(bytes < 6 * 1024 * 1024, 'a 50k list must not be copied into every later unrelated DNS rule')
  assert(!runtime.files['dn-p-second-import'].includes('large.example'), 'unrelated suffixes need no exclusions')
  console.log(`routing-dns-priority: 37 semantic decisions PASS; 50k-domain + 200-card runtime ${bytes} bytes, ${Math.round(performance.now() - began)}ms`)
} finally { setListResolver(() => []) }
