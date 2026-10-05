// W3 final hardening: timeouts really stop work, "in use" means active, Engine diagnosis is paths-only,
// memory file is private or absent, TTL and validation hold on load.
import { cancellable, probeLayers, type Net } from '../src/main/layered'
import { activeIds, diagnosisSet, parseMem, pruneMem, MEM_TTL_MS, type NetMemory } from '../src/shared/netmemory'
import { loadMem, saveMem, type MemIo } from '../src/main/netmem-store'
import { Engine } from '../src/main/engine'
import { AUTO_BUDGET } from '../src/shared/groups'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

;(async () => {
  // ---- 1 timeout cleanup
  let aborted = false
  await cancellable(s => new Promise<void>(() => { s.addEventListener('abort', () => { aborted = true }) }), 20).catch(() => undefined)
  ok(aborted, 'a layer past its deadline gets its abort signal (socket destroyed)')
  let loserAborted = false
  await cancellable(s => Promise.any([Promise.resolve(['1.1.1.1']), new Promise<string[]>(() => { s.addEventListener('abort', () => { loserAborted = true }) })]), 1000)
  ok(loserAborted, 'when the DoH race settles, the losing request is aborted too')
  const live = new Set<string>()
  const hang = (name: string) => (..._a: unknown[]) => new Promise<never>((_r, _j) => { live.add(name); (_a[_a.length - 1] as AbortSignal).addEventListener('abort', () => live.delete(name)) })
  const net: Net = { dnsSystem: async () => ['1.2.3.4'], dnsDoh: async () => ['1.2.3.4'], tcp: async () => {}, tls: hang('tls') as Net['tls'], head: async () => 200 }
  const r = await probeLayers('x.org', net, 20)
  await sleep(5)
  eq([r.tls.result, live.size], ['timeout', 0], 'after a timeout no layer is left running')

  // ---- 2 active ids: current Auto member deep in a 100-member library stays in the bounded set
  const own = Array.from({ length: 100 }, (_, i) => 'p' + i)
  const ids = new Set(own)
  const used = activeIds([], { 'g-auto': 'p97' }, ['g-auto', undefined], ids)
  eq([...used], ['p97'], 'Auto standby candidates are not "in use"; the picked member is')
  const set = diagnosisSet(own, used, {}, 'net', 'x.org', 1, AUTO_BUDGET)
  ok(set.length <= AUTO_BUDGET && set[0] === 'p97', 'current Auto member near the end is inside the bounded diagnosis set')
  eq([...activeIds(['p3'], undefined, ['p5', 'direct'], ids)].sort(), ['p3', 'p5'], 'required + effective profile ids only')

  // ---- 3 Engine diagnosis probes paths only
  const e = new Engine('x.exe', '.', 'self') as any
  const tags: string[] = []
  e.child = {}; e.ids = ['a', 'b', 'c']; e.delay = async (tag: string) => { tags.push(tag); return 50 }
  const res = await e.probePaths('example.org', ['b', 'zz'])
  eq([res, tags.includes('direct'), tags.length], [{ b: 50 }, false, 1], 'paths only, no Direct request, unknown ids ignored')

  // ---- 4 memory file private or absent; TTL and validation
  const files = new Map<string, string>()
  const io = (protectFails: boolean): MemIo => ({
    write: (f, t) => { files.set(f, t) }, read: f => { const v = files.get(f); if (v === undefined) throw new Error('no'); return v },
    remove: f => { files.delete(f) }, protect: () => { if (protectFails) throw new Error('acl') },
  })
  const net1 = 'a'.repeat(32), net2 = 'b'.repeat(32)
  const mem: NetMemory = { [net1]: { 'old.com': { worked: ['p1'], at: 0 }, 'new.com': { worked: ['p2'], at: MEM_TTL_MS } }, [net2]: { 'gone.com': { worked: ['p1'], at: 0 } } }
  eq([saveMem('m.json', 'c'.repeat(32), mem, MEM_TTL_MS + 10, io(true)), files.has('m.json')], [false, false], 'ACL failure -> file removed, RAM only')
  eq(saveMem('m.json', 'c'.repeat(32), mem, MEM_TTL_MS + 10, io(false)), true, 'private file kept')
  const disk = JSON.parse(files.get('m.json')!)
  eq(disk.data, { [net1]: { 'new.com': { worked: ['p2'], at: MEM_TTL_MS } } }, 'expired entries pruned in every network bucket on save')
  eq(pruneMem(mem, MEM_TTL_MS + 10)[net2], undefined, 'a never-revisited network ages out completely')
  files.set('bad.json', JSON.stringify({ salt: 'd'.repeat(32), data: { [net1]: { 'ok.com': { worked: ['p1'], at: MEM_TTL_MS }, 'x': 5, 'BAD HOST': { worked: ['p1'], at: 1 } }, 'not-a-hash': { 'a.com': { worked: ['p'], at: 1 } } } }))
  const loaded = loadMem('bad.json', MEM_TTL_MS + 10, io(false))
  eq([loaded.salt, loaded.data], ['d'.repeat(32), { [net1]: { 'ok.com': { worked: ['p1'], at: MEM_TTL_MS } } }], 'malformed entries / raw keys ignored, valid kept')
  eq(parseMem({ [net1]: { 'a.com': { worked: ['direct'], at: 1 } } }), {}, 'Direct is never accepted as a learned path')
  files.set('junk.json', 'not json')
  ok(/^[0-9a-f]{32}$/.test(loadMem('junk.json', 1, io(false)).salt) && Object.keys(loadMem('junk.json', 1, io(false)).data).length === 0, 'unreadable file -> fresh empty memory')

  console.log(`hardening.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
