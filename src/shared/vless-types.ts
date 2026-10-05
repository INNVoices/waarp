export type VlessSecurity = 'reality' | 'tls' | 'none'
export type VlessNetwork = 'xhttp' | 'tcp' | 'ws' | 'grpc'

export interface VlessXhttpExtra {
  xPaddingBytes?: string
  xmux?: Partial<Record<'maxConcurrency' | 'maxConnections' | 'cMaxReuseTimes' | 'hMaxRequestTimes' | 'hMaxReusableSecs', string>> & { hKeepAlivePeriod?: number }
  headers?: Record<string, string>
}

export interface VlessFields {
  server: string
  port: number
  uuid: string
  flow?: string
  encryption?: string
  security: VlessSecurity
  sni?: string
  fp: string
  pbk?: string
  sid?: string
  spx?: string
  alpn?: string[]
  network: VlessNetwork
  path?: string
  host?: string
  mode?: string
  serviceName?: string
  extra?: VlessXhttpExtra
  notApplied: string[]
}

export interface VlessProfile {
  kind: 'vless'
  id: string
  name: string
  version: string
  addedAt: number
  vless: VlessFields
  sub?: string
  /** stable subscription entry identity; never exposed to renderer */
  subKey?: string
  /** last successful subscription response did not contain this entry; kept as last-good pending user action */
  subMissing?: boolean
  source?: 'personal' | 'public' | 'managed'
  revoked?: boolean
}
