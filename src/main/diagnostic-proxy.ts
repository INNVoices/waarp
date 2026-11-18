/** Process-local transport. Credentials never belong in an IPC response or report. */
export interface DiagnosticProxy { port: number; username: string; password: string }
export interface DiagnosticTransport extends DiagnosticProxy { host: '127.0.0.1'; signal: AbortSignal }
export const DIAGNOSTIC_INBOUND = 'waarp-diagnostic-in'
export const DIAGNOSTIC_SELECTOR = 'waarp-diagnostic-egress'

export function diagnosticConfig(proxy: DiagnosticProxy | undefined, targets: string[]) {
  if (!proxy) return { inbounds: [], outbounds: [], rules: [] }
  return {
    inbounds: [{ type: 'http', tag: DIAGNOSTIC_INBOUND, listen: '127.0.0.1', listen_port: proxy.port,
      users: [{ username: proxy.username, password: proxy.password }] }],
    outbounds: [{ type: 'selector', tag: DIAGNOSTIC_SELECTOR, outbounds: targets, default: targets[0],
      interrupt_exist_connections: true }],
    rules: [{ inbound: [DIAGNOSTIC_INBOUND], outbound: DIAGNOSTIC_SELECTOR }]
  }
}
