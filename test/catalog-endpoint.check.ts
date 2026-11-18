// Endpoint admission/pinning only; resolvers are fixtures and no native core runs.
import type { OpenVpnProfile, Profile } from '../src/shared/types'
import { preparePublicCandidate, publicCandidateEndpointsAllowed, publicCandidateHasPinnedEndpoints, publicCandidateHostAllowed } from '../src/main/catalog-endpoint'
import { CatalogPool } from '../src/main/catalog-pool'
import { parseLink } from '../src/main/links'
import { credentialKey } from '../src/main/discovery'

let failures = 0, checks = 0
const ok = (value: unknown, name: string) => { checks++; if (!value) { failures++; console.error('FAIL', name) } }
const eq = (actual: unknown, expected: unknown, name: string) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
const signal = () => new AbortController().signal
const vpn = (hosts: string[], identity = true): OpenVpnProfile => ({
  id: 'fixture-vpn', kind: 'openvpn', name: 'OpenVPN fixture', host: hosts[0], port: 443, version: 'OpenVPN', addedAt: 0, source: 'public',
  endpoint: { type: 'openvpn-client', mode: 'tls', servers: hosts.map(server => ({ server, server_port: 443 })),
    tls: { certificate: ['fixture-ca'], ...(identity ? { server_name: 'fixture server subject', server_name_type: 'subject' } : {}) } }
})

;(async () => {
  for (const host of ['localhost', 'localhost.', 'router', 'host.local', 'router.home.arpa', '127.0.0.1', '127.1', '2130706433',
    '0x7f000001', '0177.0.0.1', '10.0.0.2', '172.16.1.1', '192.168.1.1', '100.64.0.1', '169.254.1.1', '0.0.0.0',
    '224.1.1.1', '255.255.255.255', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', 'fe80::1', 'fc00::1',
    'public.example@127.0.0.1', 'public.example/path', 'fe80::1%eth0']) {
    eq(publicCandidateHostAllowed(host), false, `untrusted source endpoint rejects ${host}`)
  }
  for (const host of ['relay.example', '1.1.1.1', '2606:4700:4700::1111']) eq(publicCandidateHostAllowed(host), true, `public endpoint admitted for checked DNS: ${host}`)
  {
    const pool = new CatalogPool()
    pool.ingest(['127.0.0.1', '10.0.0.1', 'relay.example'].map(host => ({ profile: parseLink(`trojan://fixture@${host}:443`)! as Profile, source: 'https://fixtures.example/list' })))
    eq(pool.size, 1, 'ingestion never stores literal private relay endpoints')
    eq(publicCandidateEndpointsAllowed(vpn(['1.1.1.1', '192.168.0.1'])), false, 'a secondary OpenVPN remote cannot hide a LAN destination')
    eq(publicCandidateHasPinnedEndpoints(vpn(['1.1.1.1', '8.8.8.8'])), true, 'all-literal public OpenVPN is eligible in an already running core')
    eq(publicCandidateHasPinnedEndpoints(vpn(['1.1.1.1', 'relay.example'])), false, 'one unresolved secondary hostname disqualifies the loaded-core automatic path')
  }
  {
    const input = parseLink('trojan://fixture@relay.example:443?sni=tls.example#Fixture')!
    const before = JSON.stringify(input), identity = credentialKey(input)
    let lookups = 0
    const pinned = await preparePublicCandidate(input, signal(), async () => { lookups++; return [{ address: '1.1.1.1', family: 4 }] })
    ok(pinned?.kind === 'out', 'a public DNS answer creates a temporary candidate')
    if (pinned?.kind === 'out') {
      eq([pinned.host, pinned.outbound.server, (pinned.outbound.tls as any).server_name], ['1.1.1.1', '1.1.1.1', 'tls.example'], 'dial address is pinned while TLS identity is preserved')
      eq(pinned.id, input.id, 'temporary native configuration retains the catalog ID')
      eq(publicCandidateHasPinnedEndpoints(pinned), true, 'temporary candidate cannot trigger a second native DNS lookup')
    }
    eq(lookups, 1, 'candidate hostname is resolved once per attempt')
    eq(JSON.stringify(input), before, 'pinning never rewrites the saved/public profile')
    eq(credentialKey(input), identity, 'saved effective identity stays unchanged')
    const unsafe = await preparePublicCandidate(input, signal(), async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.1.1.1', family: 4 }])
    eq(unsafe, undefined, 'one private DNS answer rejects the entire set before a native dial')
    eq(await preparePublicCandidate(input, signal(), async () => [{ address: '::ffff:7f00:1', family: 6 }]), undefined, 'mapped IPv6 cannot bypass DNS-private rejection')
  }
  {
    const bare = parseLink('vless://00000000-0000-4000-8000-000000000001@relay.example:443?security=tls&type=tcp')!
    const pinned = await preparePublicCandidate(bare, signal(), async () => [{ address: '8.8.8.8', family: 4 }])
    ok(pinned?.kind === 'vless' && pinned.vless.server === '8.8.8.8' && pinned.vless.sni === 'relay.example', 'VLESS default TLS hostname is made explicit before pinning the dial IP')
    const ws = parseLink('trojan://fixture@relay.example:443?type=ws&host=authority.example&path=%2Fsocket')!
    const pinnedWs = await preparePublicCandidate(ws, signal(), async () => [{ address: '8.8.8.8', family: 4 }])
    ok(pinnedWs?.kind === 'out' && (pinnedWs.outbound.transport as any).headers.Host === 'authority.example', 'explicit WebSocket Host survives pinning')
    const h2 = parseLink('trojan://fixture@relay.example:443?type=h2&host=authority.example')!
    const pinnedH2 = await preparePublicCandidate(h2, signal(), async () => [{ address: '8.8.8.8', family: 4 }])
    ok(pinnedH2?.kind === 'out' && (pinnedH2.outbound.transport as any).host[0] === 'authority.example', 'explicit HTTP/2 authority survives pinning')
    let lookedUp = false
    for (const type of ['ws', 'grpc', 'h2', 'httpupgrade']) {
      const implicit = parseLink(`trojan://fixture@relay.example:443?type=${type}`)!
      eq(await preparePublicCandidate(implicit, signal(), async () => { lookedUp = true; return [{ address: '8.8.8.8', family: 4 }] }), undefined, `implicit ${type} authority is skipped instead of guessed`)
    }
    eq(lookedUp, false, 'unsupported implicit identity causes no resolver request or native probe')
  }
  {
    const input = vpn(['first.example', 'second.example'])
    const pinned = await preparePublicCandidate(input, signal(), async host => [{ address: host === 'first.example' ? '1.1.1.1' : '8.8.8.8', family: 4 }])
    ok(pinned?.kind === 'openvpn', 'multi-remote OpenVPN can be prepared when identity is explicit')
    if (pinned?.kind === 'openvpn') {
      eq((pinned.endpoint.servers as any[]).map(remote => remote.server), ['1.1.1.1', '8.8.8.8'], 'every OpenVPN dial remote is pinned')
      eq((pinned.endpoint.tls as any).server_name, 'fixture server subject', 'OpenVPN verify-name identity is not replaced with an IP')
    }
    eq(await preparePublicCandidate(vpn(['first.example', 'second.example']), signal(), async host => [{ address: host === 'first.example' ? '1.1.1.1' : '10.0.0.1', family: 4 }]), undefined, 'private answer on a secondary remote rejects the whole candidate')
    eq(await preparePublicCandidate(vpn(['relay.example'], false), signal(), async () => [{ address: '1.1.1.1', family: 4 }]), undefined, 'implicit OpenVPN domain verification is not changed by guessing')
  }
  {
    const controller = new AbortController()
    controller.abort()
    let cancelled = false, lookedUp = false
    try { await preparePublicCandidate(parseLink('trojan://fixture@relay.example:443')!, controller.signal, async () => { lookedUp = true; return [{ address: '1.1.1.1', family: 4 }] }) }
    catch { cancelled = true }
    eq([cancelled, lookedUp], [true, false], 'cancelled preparation never reaches DNS or the native checker')
  }
  console.log(`catalog-endpoint.check: ${checks} checks`)
  if (failures) { console.error(`${failures} failed`); process.exit(1) }
})().catch(error => { console.error(error); process.exit(1) })
