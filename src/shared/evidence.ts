// W3.1 anti-block evidence: what we actually observed on Direct, layer by layer, plus what each path answered.
// classify() turns observations into a cautious finding. It never claims a cause it did not see: a "Direct fails,
// a path works" contrast without a failing layer stays `path_only`, and thin / mixed evidence is `unclear`.
// Credential state (busy / revoked) is not evidence here and never enters this module.

export type LayerResult = 'ok' | 'fail' | 'timeout' | 'skipped'
export interface DnsObs { result: LayerResult; code?: 'nxdomain' | 'empty' | 'refused' | 'error'; addrs?: number }
export interface DirectObs {
  dnsSystem: DnsObs
  /** the same name through one fixed DoH resolver over HTTPS; only to spot a missing / empty system answer */
  dnsDoh: DnsObs
  tcp: { result: LayerResult; code?: 'refused' | 'reset' | 'unreachable' | 'error' }
  tls: { result: LayerResult; code?: 'reset' | 'cert' | 'alert' | 'error' }
  http: { result: LayerResult; status?: number }
}
/** per path: ms, or null when the path did not answer */
export type PathObs = Record<string, number | null>

export type Layer = 'dns' | 'tcp' | 'tls' | 'http'
export type Finding =
  | { kind: 'direct_ok' }
  | { kind: 'site_down' }
  | { kind: 'restricted_direct'; layer: Layer; via: string[] }
  | { kind: 'path_only'; via: string[] }
  | { kind: 'unclear'; why: 'no_paths' | 'timeouts' | 'mixed' }

const bad = (r: LayerResult) => r === 'fail' || r === 'timeout'

/** the first Direct layer that failed, if the failure is specific enough to name */
export function failingLayer(d: DirectObs): Layer | undefined {
  // system resolver empty / NX while DoH answers: the name is fine, the local answer is not
  if (bad(d.dnsSystem.result) && d.dnsDoh.result === 'ok') return 'dns'
  if (bad(d.dnsSystem.result)) return undefined // both resolvers failing: could be the site, not a restriction
  if (d.tcp.result === 'fail' && (d.tcp.code === 'reset' || d.tcp.code === 'refused')) return 'tcp'
  if (d.tcp.result === 'ok' && d.tls.result === 'fail' && (d.tls.code === 'reset' || d.tls.code === 'alert')) return 'tls'
  if (d.tcp.result === 'ok' && d.tls.result === 'ok' && d.http.result === 'fail') return 'http'
  return undefined
}

/** Direct works the way a browser would use it: the system resolver answered and HTTPS completed */
export const directWorks = (d: DirectObs): boolean => d.dnsSystem.result === 'ok' && (d.http.result === 'ok' || (d.tls.result === 'ok' && d.http.result === 'skipped'))
const onlyTimeouts = (d: DirectObs): boolean =>
  [d.dnsSystem.result, d.tcp.result, d.tls.result, d.http.result].some(r => r === 'timeout') &&
  ![d.dnsSystem.result, d.tcp.result, d.tls.result, d.http.result].some(r => r === 'fail')

export function classify(d: DirectObs, paths: PathObs): Finding {
  if (directWorks(d)) return { kind: 'direct_ok' }
  const ids = Object.keys(paths)
  const via = ids.filter(id => paths[id] !== null).sort((a, b) => paths[a]! - paths[b]!)
  if (!ids.length) return { kind: 'unclear', why: 'no_paths' }
  if (!via.length) {
    // nothing answers anywhere: the site itself is the likely problem, unless Direct only timed out
    return onlyTimeouts(d) ? { kind: 'unclear', why: 'timeouts' } : { kind: 'site_down' }
  }
  const layer = failingLayer(d)
  if (layer) return { kind: 'restricted_direct', layer, via }
  // a timeout-only Direct next to a working path is still a contrast, but we cannot name a layer
  return { kind: 'path_only', via }
}
