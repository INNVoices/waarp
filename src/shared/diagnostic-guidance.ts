import type { DirectObs, LayerResult } from './evidence'

export type DiagnosticStage = 'dns' | 'tcp' | 'tls' | 'http'
export type DiagnosticExplanation =
  | 'dns-system' | 'dns-missing' | 'dns-unreachable' | 'network-unreachable'
  | 'tcp-refused' | 'tcp-timeout' | 'tcp-failed' | 'tls-certificate' | 'tls-failed'
  | 'http-method' | 'http-redirect' | 'http-denied' | 'http-server' | 'http-status'
  | 'http-ok' | 'http-timeout' | 'http-failed' | 'incomplete'
export interface DiagnosticGuidance {
  explanation: DiagnosticExplanation
  stage?: DiagnosticStage
  /** An HTTP error or redirect is still a response from the destination. */
  destinationResponded: boolean
}
const failed = (result: LayerResult) => result === 'fail' || result === 'timeout'

/** Describe the first observed failure, without inferring an ISP block, a dead
 * server, or broken application from one target's system-socket trace. */
export function diagnosticGuidance(direct: DirectObs): DiagnosticGuidance {
  const answer = (explanation: DiagnosticExplanation, stage?: DiagnosticStage): DiagnosticGuidance => ({
    explanation, stage, destinationResponded: typeof direct.http.status === 'number'
  })
  if (failed(direct.dnsSystem.result)) {
    if (direct.dnsDoh.result === 'ok') return answer('dns-system', 'dns')
    if (direct.dnsSystem.code === 'nxdomain' && direct.dnsDoh.code === 'nxdomain') return answer('dns-missing', 'dns')
    return answer('dns-unreachable', 'dns')
  }
  if (failed(direct.tcp.result)) {
    if (direct.tcp.code === 'unreachable') return answer('network-unreachable', 'tcp')
    if (direct.tcp.code === 'refused' || direct.tcp.code === 'reset') return answer('tcp-refused', 'tcp')
    return answer(direct.tcp.result === 'timeout' ? 'tcp-timeout' : 'tcp-failed', 'tcp')
  }
  if (failed(direct.tls.result)) return answer(direct.tls.code === 'cert' ? 'tls-certificate' : 'tls-failed', 'tls')
  const http = direct.http
  if (http.code === 'method') return answer('http-method', 'http')
  if (http.status !== undefined) {
    if (http.status >= 200 && http.status < 300) return answer('http-ok', 'http')
    if (http.status >= 300 && http.status < 400) return answer('http-redirect', 'http')
    if ([401, 403, 429].includes(http.status)) return answer('http-denied', 'http')
    if (http.status >= 500) return answer('http-server', 'http')
    if (http.status >= 400) return answer('http-status', 'http')
  }
  if (failed(http.result)) return answer(http.result === 'timeout' ? 'http-timeout' : 'http-failed', 'http')
  return answer('incomplete')
}
