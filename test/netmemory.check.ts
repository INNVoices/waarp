// W3.3 per-network memory: bounded, expiring, reorder-only, never public / Direct, ambiguity teaches nothing
import { diagnosisSet, learn, MEM_MAX, MEM_TTL_MS, orderFor, type NetMemory } from '../src/shared/netmemory'
import { execFileSync } from 'node:child_process'
import { fingerprintFrom, GATEWAY_MAC_PS } from '../src/main/netid'
import { diagnosisCurrent, diagnosisProof, DIAGNOSIS_TTL_MS } from '../src/main/diagnosis'
import type { OutProfile, Profile } from '../src/shared/types'

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

// Execute the production PowerShell selection with fixture cmdlets: no host network is inspected or changed.
if (process.platform === 'win32') {
  const script = `
function Get-NetRoute { [CmdletBinding()] param($AddressFamily, $DestinationPrefix, $PolicyStore) $script:routeFixture }
function Get-NetIPInterface { [CmdletBinding()] param($AddressFamily) $script:interfaceFixture }
function Get-NetNeighbor {
  [CmdletBinding()] param($AddressFamily, $InterfaceIndex, $IPAddress, $PolicyStore)
  $script:neighborFixture | Where-Object { $_.IPAddress -eq $IPAddress -and ($null -eq $InterfaceIndex -or $_.InterfaceIndex -eq $InterfaceIndex) }
}
function Read-Gateway { ${GATEWAY_MAC_PS} }
$script:routeFixture = @(
  [pscustomobject]@{ InterfaceIndex = 9; NextHop = '0.0.0.0'; RouteMetric = 0 },
  [pscustomobject]@{ InterfaceIndex = 11; NextHop = '192.168.1.1'; RouteMetric = 1 },
  [pscustomobject]@{ InterfaceIndex = 22; NextHop = '192.168.1.1'; RouteMetric = 10 }
)
$script:interfaceFixture = @(
  [pscustomobject]@{ InterfaceIndex = 11; InterfaceMetric = 100 },
  [pscustomobject]@{ InterfaceIndex = 22; InterfaceMetric = 5 }
)
$script:neighborFixture = @(
  [pscustomobject]@{ InterfaceIndex = 11; IPAddress = '192.168.1.1'; LinkLayerAddress = 'AA-BB-CC-DD-EE-11' },
  [pscustomobject]@{ InterfaceIndex = 22; IPAddress = '192.168.1.1'; LinkLayerAddress = 'AA-BB-CC-DD-EE-22' }
)
$results = [ordered]@{}
$results['combined'] = @(Read-Gateway) -join ''
$script:neighborFixture = @($script:neighborFixture[0])
$results['missingNeighbor'] = @(Read-Gateway) -join ''
$script:interfaceFixture[1].InterfaceMetric = $null
$results['unknownMetric'] = @(Read-Gateway) -join ''
$script:interfaceFixture[1].InterfaceMetric = 91
$results['ambiguous'] = @(Read-Gateway) -join ''
ConvertTo-Json -InputObject $results -Compress
`
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()) as Record<string, unknown>
  eq(Object.keys(result).sort(), ['ambiguous', 'combined', 'missingNeighbor', 'unknownMetric'], 'all four gateway observations survive PowerShell serialization')
  eq(result.combined, 'AA-BB-CC-DD-EE-22', 'combined metric selects the real default NIC and its own same-IP neighbor')
  eq(result.missingNeighbor, '', 'missing neighbor on the selected NIC never borrows another NIC MAC')
  eq(result.unknownMetric, '', 'unknown interface metric cannot silently become zero')
  eq(result.ambiguous, '', 'equally preferred different gateways do not create a guessed fingerprint')
} else console.log('[SKIP] netmemory.check: Windows gateway-command fixture NOT_RUN on this platform')

// Applying an observation is bound to the measured profile/network, not a renderer-selected label.
{
  const p: OutProfile = { id: 'own-a', kind: 'out', name: 'Private', host: 'example.org', port: 443, version: 'Trojan', addedAt: 1, outbound: { type: 'trojan', server: 'example.org', server_port: 443, password: 'synthetic-password' } }
  const publicP: OutProfile = { ...p, id: 'public-a', source: 'public' }
  const proof = diagnosisProof('target.example', { 'own-a': 10, 'public-a': 5, unknown: 1 }, [p, publicP], 'home', 100, 'runtime-a')!
  ok(!!proof, 'successful personal path creates a bounded diagnosis proof')
  ok(diagnosisCurrent(proof, proof.token, p.id, [structuredClone(p)], 'home', 101, 'runtime-a'), 'unchanged independently read profile can apply its own result')
  for (const [label, token, via, profiles, net, now, context] of [
    ['forged token', 'wrong', p.id, [p], 'home', 101, 'runtime-a'],
    ['unmeasured path', proof.token, 'other', [p], 'home', 101, 'runtime-a'],
    ['public path', proof.token, publicP.id, [p, publicP], 'home', 101, 'runtime-a'],
    ['removed profile', proof.token, p.id, [], 'home', 101, 'runtime-a'],
    ['changed profile', proof.token, p.id, [{ ...p, outbound: { ...p.outbound, password: 'rotated' } }], 'home', 101, 'runtime-a'],
    ['revoked profile', proof.token, p.id, [{ ...p, revoked: true }], 'home', 101, 'runtime-a'],
    ['changed network', proof.token, p.id, [p], 'work', 101, 'runtime-a'],
    ['unknown network', proof.token, p.id, [p], undefined, 101, 'runtime-a'],
    ['expired result', proof.token, p.id, [p], 'home', 100 + DIAGNOSIS_TTL_MS, 'runtime-a'],
    ['future result', proof.token, p.id, [p], 'home', 99, 'runtime-a'],
    ['changed runtime/tune', proof.token, p.id, [p], 'home', 101, 'runtime-b']
  ] as [string, unknown, unknown, Profile[], string | undefined, number, string][]) ok(!diagnosisCurrent(proof, token, via, profiles, net, now, context), `${label} cannot mutate a route using old evidence`)
  eq(diagnosisProof('target.example', { 'own-a': null }, [p], 'home', 100, ''), undefined, 'failed probe does not grant apply')
  eq(diagnosisProof('target.example', { 'own-a': Infinity }, [p], 'home', 100, ''), undefined, 'invalid latency does not grant apply')
  eq(diagnosisProof('target.example', { 'own-a': 1 }, [p], undefined, 100, ''), undefined, 'unidentified network does not grant a transferable result')
}

console.log(`netmemory.check: ${n} checks`)
if (fails) { console.error(`${fails} failed`); process.exit(1) }
