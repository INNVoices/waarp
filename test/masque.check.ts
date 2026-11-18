import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { masqueNode, parseMasque } from '../src/main/masque'
import { parseAny, linksInContainer, outSecrets } from '../src/main/links'
import { peekClip } from '../src/main/clip'
import { configOf } from '../src/main/techview'
import { activeTune, applyTune, profileSig, provenTune, tuned, variants } from '../src/main/tune'
import { normalizeProfile, readDisk, DEFAULTS } from '../src/main/store-core'

const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const privateKey = key.privateKey.export({ format: 'der', type: 'sec1' }).toString('base64')
const publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const original = { type: 'masque', tag: 'Own WARP export', server: '192.0.2.1', server_port: 443, profile: 'cloudflare',
  private_key: privateKey, public_key: publicKey, ip: '172.16.0.2', ipv6: '2606:4700:110:1234::2',
  uri: 'https://cloudflareaccess.com/fixture-token', tls: { enabled: true, server_name: 'www.cloudflare.com' } }
const p = masqueNode(original)
assert.equal(p.outbound.vhttp, 'auto')
assert.equal(p.outbound.ip, '172.16.0.2/32')
assert.equal(p.outbound.ipv6, '2606:4700:110:1234::2/128')
assert.equal(p.source, 'personal', 'own imported WARP keys remain user-replaceable')
assert.equal(p.outbound.private_key, privateKey)
assert.equal(p.outbound.public_key, publicKey)
assert.equal(p.outbound.tag, undefined)
const disk = JSON.stringify({ settings: DEFAULTS, profiles: [JSON.stringify(p)] })
assert.deepEqual(readDisk(disk, value => value).profiles[0], p, 'MASQUE survives encrypted-store decode and normalization')
assert.throws(() => normalizeProfile({ ...p, outbound: { ...p.outbound, tls: { insecure: true } } }), /MASQUE:/,
  'persistence cannot bypass native import security')
assert.throws(() => normalizeProfile({ ...p, outbound: { ...p.outbound, detour: 'direct' } }), /MASQUE:/)
for (const mode of ['auto', 'h2', 'h3']) assert.equal(masqueNode({ ...original, vhttp: mode }).outbound.vhttp, mode)
const plain = { type: 'masque', server: 'connect.example.test', server_port: 443, profile: 'standard', ip: '10.5.0.2', uri: 'https://connect.example.test/.well-known/masque/ip/*/*/' }
assert.equal(masqueNode(plain).outbound.vhttp, 'h3')
for (const shape of [original, [original], { outbounds: [original] }]) {
  const imported = parseAny(JSON.stringify(shape)).items
  assert.equal(imported.length, 1)
  assert.equal(imported[0].kind === 'out' && imported[0].outbound.private_key, privateKey)
  assert.equal(peekClip(JSON.stringify(shape)).kind, 'other')
}
assert.equal(parseMasque(JSON.stringify([original, original]), 1)?.skipped, 1)
assert.equal(parseMasque(JSON.stringify(original), 0)?.items.length, 0)
assert.equal(parseMasque('trojan://secret@host.example:443', 1), undefined)
assert.deepEqual(linksInContainer(JSON.stringify({ ...original, detour: 'trojan://secret@host.example:443' })), [])
for (const mutation of [
  { private_key: 'invalid-private-secret' }, { private_key: key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') },
  { public_key: privateKey }, { ip: '10.0.0.2/33' }, { ip: 'not-an-ip' }, { ipv6: '10.0.0.1' },
  { server: 'invalid host' }, { server_port: 65536 }, { server_port: '443' }, { profile: 'custom' },
  { vhttp: 'http3' }, { network: 'h3' }, { detour: 'direct' }, { connect_timeout: 'infinite' },
  { mtu: 1279 }, { mtu: 9001 }, { tls: { enabled: false } }, { tls: { insecure: true } },
  { tls: { insecure: 'false' } }, { tls: { certificate_path: '/private/file' } },
  { tls: { utls: { enabled: true, fingerprint: 'chrome' } } }, { tls: { alpn: ['h3'] } },
  { vhttp: 'h3', tls: { record_fragment: true } }, { uri: 'http://host.example/' },
  { uri: 'https://user:secret@host.example/' }, { uri: 'https://host.example/#secret' },
  { network_list: ['icmp'] }, { network_list: ['tcp', 'tcp'] }, { udp_fragment: 'true' }, { idle_timeout: '25h' },
]) assert.throws(() => masqueNode({ ...original, ...mutation }), /MASQUE:/)
assert.throws(() => masqueNode({ ...plain, uri: undefined }), /MASQUE:/)
for (const mode of ['auto', 'h2']) assert.throws(() => masqueNode({ ...plain, vhttp: mode }), /MASQUE:/)
for (const field of ['inbounds', 'route', 'dns', 'experimental']) {
  const text = JSON.stringify({ outbounds: [original], [field]: {} })
  assert.throws(() => parseAny(text), /MASQUE:/)
  assert.equal(peekClip(text).kind, 'none', 'invalid clipboard preview never throws or partially imports')
}
const redacted = JSON.stringify(configOf(p))
assert(!redacted.includes(privateKey) && !redacted.includes('fixture-token'))
assert(outSecrets(p).includes(privateKey) && outSecrets(p).includes(String(p.outbound.uri)))
assert.equal(JSON.stringify(original).includes('172.16.0.2/32'), false, 'import never mutates input')
assert.deepEqual(variants(masqueNode(plain)), [], 'standard has no fake HTTP/2 fallback')
const choices = variants(p)
assert.deepEqual(choices.map(v => v.patch.vhttp), ['h3', 'h2'])
for (const ineligible of [{ ...p, source: 'public' as const }, { ...p, source: 'managed' as const }, { ...p, revoked: true }, { ...p, subMissing: true }])
  assert.deepEqual(variants(ineligible), [], 'managed, public or unavailable profiles are not tuned')
for (const choice of choices) {
  const changed = applyTune(p, choice.patch)
  assert(changed.kind === 'out')
  assert.equal(changed.outbound.private_key, privateKey)
  assert.equal(changed.outbound.public_key, publicKey)
  assert.equal(changed.outbound.server, original.server)
  assert.equal(changed.outbound.uri, original.uri)
}
const saved = { net: 'network-a', sig: profileSig(p), label: choices[0].label, patch: choices[0].patch, at: 1000 }
assert(activeTune(p, saved, 'network-a', 2000))
assert.equal(tuned([p], { [p.id]: saved }, 'network-b', 2000)[0], p)
assert.equal(provenTune({ id: p.id, net: 'network-a', sig: saved.sig, at: 1000,
  results: [{ label: '', ms: 20 }, { label: choices[0].label, ms: 10 }] }, p, 'network-a', choices[0].label, 2000), undefined)

const binary = process.env.WAARP_NATIVE_CHECK || (process.platform === 'win32' ? join(process.cwd(), 'engine/sing-box.exe') : '')
if (binary && existsSync(binary)) {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-masque-'))
  try {
    for (const node of [...['auto', 'h2', 'h3'].map(vhttp => masqueNode({ ...original, vhttp })), masqueNode(plain)]) {
      const path = join(dir, 'config.json')
      writeFileSync(path, JSON.stringify({ outbounds: [{ ...node.outbound, tag: 'masque-test' }] }))
      const result = spawnSync(binary, ['check', '-c', path], { encoding: 'utf8', timeout: 15_000 })
      assert.equal(result.status, 0, `pinned MASQUE ${node.outbound.profile}/${node.outbound.vhttp}: ${result.stderr.slice(-500)}`)
    }
    console.log('masque.check: four pinned native schemas accepted; network/enrollment NOT_RUN')
  } finally { rmSync(dir, { recursive: true, force: true }) }
} else console.log('[SKIP] MASQUE pinned native schema: set WAARP_NATIVE_CHECK or run with the verified Windows engine')
console.log('masque.check: import, rejection, secret redaction, immutable variants and stale evidence passed')
