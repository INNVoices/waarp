// Public feed endpoints are untrusted too. Source-URL validation alone does
// not prevent an advertised relay from pointing a native probe into the LAN.
import { BlockList, isIP } from 'node:net'
import type { Profile } from '../shared/types'
import type { PublicProfile } from './catalog-pool'
import { resolvedPublic, type PublicResolver } from './vless'

const PRIVATE = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const) PRIVATE.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(address, prefix, 'ipv6')
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|lan|home|home\.arpa)$/i
const OUTBOUNDS = new Set(['vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic'])
const port = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** URL normalization also catches legacy numeric IPv4 notations such as
 * 127.1, 2130706433 and 0x7f000001 before a DNS lookup can reinterpret them. */
function hostUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\s/@\\?#%]/.test(value)) return undefined
  const host = value.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  try {
    const url = new URL('https://' + (host.includes(':') ? `[${host}]` : host) + '/')
    if (url.username || url.password || url.port) return undefined
    return url
  } catch { return undefined }
}
const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '')
const literalPublic = (host: string): boolean => {
  const family = isIP(host)
  return family !== 0 && !PRIVATE.check(host, family === 4 ? 'ipv4' : 'ipv6')
}

/** Synchronous ingest guard. Hostnames still require checked DNS immediately
 * before a native automatic probe/recovery attempt. Personal profiles bypass it. */
export function publicCandidateHostAllowed(host: unknown): boolean {
  const url = hostUrl(host)
  if (!url) return false
  const normalized = hostOf(url)
  return isIP(normalized) ? literalPublic(normalized) : normalized.includes('.') && !LOCAL_NAME.test(normalized)
}

function targets(profile: Profile): string[] | undefined {
  if (profile.kind === 'awg') return undefined
  if (profile.kind === 'vless') return port(profile.vless?.port) && typeof profile.vless?.server === 'string' ? [profile.vless.server] : undefined
  if (!port(profile.port) || typeof profile.host !== 'string') return undefined
  if (profile.kind === 'out') {
    const outbound = profile.outbound
    if (!record(outbound) || !OUTBOUNDS.has(String(outbound.type)) || !port(outbound.server_port) || outbound.server_port !== profile.port ||
      typeof outbound.server !== 'string' || hostUrl(outbound.server)?.hostname !== hostUrl(profile.host)?.hostname) return undefined
    return [outbound.server]
  }
  const endpoint = profile.endpoint
  if (!record(endpoint)) return undefined
  const remotes = endpoint.servers
  if (remotes !== undefined) {
    if (!Array.isArray(remotes) || !remotes.length || remotes.length > 16 || endpoint.server !== undefined) return undefined
    if (remotes.some(remote => !record(remote) || typeof remote.server !== 'string' || !port(remote.server_port))) return undefined
    if (hostUrl(remotes[0].server)?.hostname !== hostUrl(profile.host)?.hostname || remotes[0].server_port !== profile.port) return undefined
    return remotes.map(remote => remote.server as string)
  }
  return typeof endpoint.server === 'string' && port(endpoint.server_port) && endpoint.server_port === profile.port &&
    hostUrl(endpoint.server)?.hostname === hostUrl(profile.host)?.hostname ? [endpoint.server] : undefined
}

export function publicCandidateEndpointsAllowed(profile: Profile): boolean {
  const hosts = targets(profile)
  return !!hosts?.length && hosts.every(publicCandidateHostAllowed)
}

/** An already-running core cannot be reconfigured for an automatic download.
 * Only an all-literal public configuration avoids its unchecked second DNS. */
export function publicCandidateHasPinnedEndpoints(profile: Profile): boolean {
  const hosts = targets(profile)
  return !!hosts?.length && hosts.every(host => {
    const url = hostUrl(host)
    // Require actual literals in the original native config, not an alternative
    // numeric notation which only WHATWG URL normalizes to a literal.
    return !!isIP(host.replace(/^\[|\]$/g, '')) && !!url && literalPublic(hostOf(url))
  })
}

/** The pinned engine's transport defaults are made explicit before replacing
 * the dial hostname. This preserves virtual hosting instead of excluding most
 * hostname-based WS/XHTTP/gRPC candidates from automatic verification.
 * Source: Leadaxe/sing-box-lx@3d3d3db, transport/v2ray{websocket,xhttp,grpc,http,httpupgrade}/client.go. */
function canPinIdentity(profile: PublicProfile, hosts: string[]): boolean {
  if (hosts.every(host => !!isIP(hostOf(hostUrl(host)!)))) return true
  if (profile.kind === 'vless') {
    return profile.vless.network !== 'grpc' || profile.vless.security !== 'none'
  }
  if (profile.kind === 'openvpn') {
    const tls = profile.endpoint.tls
    return record(tls) && (typeof tls.server_name === 'string' && !!tls.server_name || Array.isArray(tls.peer_fingerprint) && !!tls.peer_fingerprint.length)
  }
  const transport = profile.outbound.transport
  if (transport === undefined) return true
  if (!record(transport)) return false
  if (['ws', 'http', 'httpupgrade'].includes(String(transport.type))) return true
  if (transport.type === 'grpc') return record(profile.outbound.tls) && profile.outbound.tls.enabled === true
  return false // No gRPC authority option exists for plaintext hostname targets.
}

export type PublicCandidatePreparation = { profile: PublicProfile; problem?: never } |
  { profile?: never; problem: 'unsafe' | 'unsupported' | 'dns' }

/** Resolve every remote once, reject the entire DNS set if any answer is
 * private, and pin only this temporary native config to the checked addresses.
 * The stored hostname, credentials and stable ID remain untouched. A preflight
 * followed by the original hostname would still permit DNS rebinding. */
export async function preparePublicCandidate(profile: Profile, signal: AbortSignal, resolver?: PublicResolver): Promise<PublicProfile | undefined> {
  return (await preparePublicCandidateResult(profile, signal, resolver)).profile
}

/** A skipped DNS/transport preparation is not a failed relay measurement. */
export async function preparePublicCandidateResult(profile: Profile, signal: AbortSignal, resolver?: PublicResolver): Promise<PublicCandidatePreparation> {
  signal.throwIfAborted()
  if (profile.kind === 'awg' || !publicCandidateEndpointsAllowed(profile)) return { problem: 'unsafe' }
  const hosts = targets(profile)!
  if (!canPinIdentity(profile, hosts)) return { problem: 'unsupported' }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(4000)])
  try {
    bounded.throwIfAborted()
    const addresses = new Map<string, string>()
    await Promise.all([...new Set(hosts)].map(async host => {
      const url = hostUrl(host)!
      const resolved = await resolvedPublic(url, bounded, resolver)
      // Apply the same literal guard to all responses, including IPv4-mapped
      // IPv6 and IPv4-compatible forms, before picking one checked dial IP.
      if (!resolved.length || resolved.some(answer => !literalPublic(answer.address))) throw new Error('non-public endpoint')
      // The checker uses ipv4_only DNS for target names. Pinning a first AAAA
      // response here used to bypass that policy and break dual-stack relays
      // on networks with no working IPv6 underlay.
      addresses.set(host, (resolved.find(answer => answer.family === 4) ?? resolved[0]).address)
    }))
    bounded.throwIfAborted()
    const copy = structuredClone(profile)
    const originalHost = hostOf(hostUrl(hosts[0])!)
    const authority = `${originalHost.includes(':') ? '[' + originalHost + ']' : originalHost}:${copy.kind === 'vless' ? copy.vless.port : copy.port}`
    if (copy.kind === 'vless') {
      if (copy.vless.security !== 'none' && !copy.vless.sni) copy.vless.sni = originalHost
      if (copy.vless.network === 'ws' && !copy.vless.host) copy.vless.host = authority
      if (copy.vless.network === 'xhttp' && !copy.vless.host) copy.vless.host = copy.vless.sni || authority
      copy.vless.server = addresses.get(hosts[0])!
    } else if (copy.kind === 'out') {
      const tls = copy.outbound.tls
      if (record(tls) && tls.enabled && !tls.server_name) tls.server_name = originalHost
      const transport = copy.outbound.transport
      if (record(transport)) {
        if (transport.type === 'ws') {
          const headers = record(transport.headers) ? transport.headers : {}
          if (!Object.keys(headers).some(key => key.toLowerCase() === 'host' && !!headers[key])) headers.Host = authority
          transport.headers = headers
        } else if (transport.type === 'http' && (!Array.isArray(transport.host) || !transport.host.length)) {
          transport.host = [record(tls) && tls.enabled ? 'www.example.com' : originalHost]
        } else if (transport.type === 'httpupgrade' && !transport.host) {
          transport.host = record(tls) && tls.enabled && typeof tls.server_name === 'string' ? tls.server_name : authority
        }
      }
      copy.host = addresses.get(hosts[0])!
      copy.outbound.server = copy.host
    } else {
      copy.host = addresses.get(hosts[0])!
      if (Array.isArray(copy.endpoint.servers)) {
        copy.endpoint.servers = copy.endpoint.servers.map(remote => ({ ...remote, server: addresses.get(remote.server)! }))
      } else copy.endpoint.server = copy.host
    }
    return { profile: copy }
  } catch {
    if (signal.aborted) signal.throwIfAborted()
    return { problem: 'dns' } // a rejected DNS/path is not evidence of a working relay
  }
}
