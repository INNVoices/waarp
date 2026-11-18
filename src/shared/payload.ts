export type PayloadState = 'pass' | 'fail' | 'not_measured'
export type PayloadReason = 'timeout' | 'cancelled' | 'network' | 'tls' | 'http' | 'size' | 'digest' | 'reply' | 'no_endpoint'
export interface PayloadStage {
  state: PayloadState
  bytes: number
  ms: number
  reason?: PayloadReason
  status?: number
}
export interface PayloadReport {
  profileId: string
  at: number
  download: PayloadStage
  upload: PayloadStage
  /** Measurement proves this exact transfer, not every site/protocol or a sustained link speed. */
  target: 'rfc6455'
}
export interface PayloadReply { report?: PayloadReport; error?: 'busy' | 'gone' | 'not_loaded' | 'engine' | 'cancelled' | 'endpoint' }

export const PAYLOAD_DOWNLOAD = {
  url: 'https://www.rfc-editor.org/rfc/rfc6455.txt',
  bytes: 162067,
  sha256: '765775326aee0ecca9b04bde3fd1f52932d498e33e34e428bd61b8a24da0fa3b'
} as const
export const PAYLOAD_UPLOAD_BYTES = 65536
