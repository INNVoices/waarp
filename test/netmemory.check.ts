// W3.3 per-network memory: bounded, expiring, reorder-only, never public / Direct, ambiguity teaches nothing
import { diagnosisSet, learn, MEM_MAX, MEM_TTL_MS, orderFor, type NetMemory } from '../src/shared/netmemory'
import { fingerprintFrom } from '../src/main/netid'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const E = ['a', 'b', 'c']
let m: NetMemory = {}
m = learn(m, 'home', 'yt.com', { kind: 'restricted_direct', layer: 'tls', via: ['c', 'pub'] }, E, 1000)
eq(m.home['yt.com'], { layer: 'tls', worked: ['c'], at: 1000 }, 'learns layer + own working paths, drops non-eligible (public)')
eq(orderFor(m, 'home', 'yt.com', E, 2000), ['c', 'a', 'b'], 'what worked here goes first, set unchanged')
eq(orderFor(m, 'work', 'yt.com', E, 2000), E, 'another network knows nothing')
eq(orderFor(m, 'home', 'yt.com', E, 1000 + MEM_TTL_MS), E, 'expired memory is ignored')
eq(orderFor(m, 'home', 'yt.com', ['a', 'b'], 2000), ['a', 'b'], 'a path no longer eligible is not brought back')

const before = m
eq(learn(m, 'home', 'yt.com', { kind: 'unclear', why: 'timeouts' }, E, 3000), before, 'unclear teaches nothing')
ok(!learn(m, 'home', 'yt.com', { kind: 'direct_ok' }, E, 3000).home['yt.com'], 'direct ok forgets the restriction')
eq(learn(m, 'home', 'x.com', { kind: 'path_only', via: ['pub'] }, E, 3000), m, 'nothing eligible worked: nothing learned')
ok(!JSON.stringify(learn(m, 'home', 'z.com', { kind: 'path_only', via: ['a'] }, E, 3000)).includes('direct'), 'Direct is never stored as a path')

let big: NetMemory = {}
for (let i = 0; i < MEM_MAX + 40; i++) big = learn(big, 'home', 'h' + i + '.com', { kind: 'path_only', via: ['a'] }, E, 10_000 + i)
eq(Object.keys(big.home).length, MEM_MAX, 'bounded per network')
ok(!big.home['h0.com'] && !!big.home['h' + (MEM_MAX + 39) + '.com'], 'least recent dropped first')

// W3.3b: bounded diagnosis set, memory orders checks only, no fingerprint = no memory
{
  const own = Array.from({ length: 100 }, (_, i) => 'p' + i)
  const used = new Set(['p50'])
  const plain = diagnosisSet(own, used, {}, 'home', 'yt.com', 1, 8)
  eq(plain.length, 8, '100-profile library -> diagnosis checks <= AUTO_BUDGET')
  eq(plain[0], 'p50', 'paths in use are checked first')
  let mm: NetMemory = learn({}, 'home', 'yt.com', { kind: 'restricted_direct', layer: 'tls', via: ['p77'] }, own, 1)
  eq(diagnosisSet(own, used, mm, 'home', 'yt.com', 2, 8).slice(0, 2), ['p77', 'p50'], 'memory puts the known-good path first')
  eq(diagnosisSet(own, used, mm, undefined, 'yt.com', 2, 8), plain, 'no network fingerprint -> memory ignored')
  const frozen = JSON.stringify(mm)
  diagnosisSet(own, used, mm, 'home', 'yt.com', 2, 8)
  eq(JSON.stringify(mm), frozen, 'ordering never mutates memory (and has no access to routes / Auto)')
  // fingerprint
  ok(fingerprintFrom('', 'Home', 's') === undefined, 'no gateway MAC -> no fingerprint (no shared unknown bucket)')
  ok(fingerprintFrom('00-00-00-00-00-00', undefined, 's') === undefined, 'zero MAC rejected')
  const f1 = fingerprintFrom('AA-BB-CC-DD-EE-01', 'Home', 's'), f2 = fingerprintFrom('aa:bb:cc:dd:ee:01', 'Home', 's')
  ok(!!f1 && f1 === f2 && /^[0-9a-f]{32}$/.test(f1), 'stable hash, MAC format normalised')
  ok(!f1!.includes('aa') || !f1!.includes('bb:cc'), 'raw MAC not present in the key')
  ok(fingerprintFrom('aa:bb:cc:dd:ee:01', 'Work', 's') !== f1 && fingerprintFrom('aa:bb:cc:dd:ee:01', 'Home', 't') !== f1, 'SSID and per-install salt change the key')
}

console.log(`netmemory.check: ${n} checks`)
if (fails) { console.error(`${fails} failed`); process.exit(1) }
