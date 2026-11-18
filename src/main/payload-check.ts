import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { PAYLOAD_DOWNLOAD, PAYLOAD_UPLOAD_BYTES, type PayloadReport, type PayloadStage } from '../shared/payload'
import type { DiagnosticTransport } from './diagnostic-proxy'
import { proxyRequest, transferUrl, TransferError } from './proxy-http'

const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex')
export const uploadPayload = () => Buffer.from('waarp-payload-v1\n'.repeat(Math.ceil(PAYLOAD_UPLOAD_BYTES / 17)).slice(0, PAYLOAD_UPLOAD_BYTES))
export function verifyDownload(body: Buffer): PayloadStage['reason'] | undefined {
  if (body.length !== PAYLOAD_DOWNLOAD.bytes) return 'size'
  return digest(body) === PAYLOAD_DOWNLOAD.sha256 ? undefined : 'digest'
}
export function verifyUploadReply(body: Buffer, sent: Buffer): boolean {
  if (body.length > 4096) return false
  try { const data = JSON.parse(body.toString('utf8')); return data?.bytes === sent.length && data?.sha256 === digest(sent) }
  catch { return false }
}

/** Persist only a compact redacted result; never an endpoint URL or response body. */
export function readPayloadReport(value: unknown): PayloadReport | undefined {
  if (!value || typeof value !== 'object') return undefined
  const report = value as PayloadReport
  if (report.target !== 'rfc6455' || typeof report.profileId !== 'string' || report.profileId.length > 80 ||
    !Number.isSafeInteger(report.at) || report.at < 0 || report.at > Date.now() + 60000) return undefined
  const reasons = ['timeout', 'cancelled', 'network', 'tls', 'http', 'size', 'digest', 'reply', 'no_endpoint']
  const stage = (v: PayloadStage): PayloadStage | undefined => {
    if (!v || !['pass', 'fail', 'not_measured'].includes(v.state) || !Number.isSafeInteger(v.bytes) || v.bytes < 0 || v.bytes > 262144 ||
      !Number.isSafeInteger(v.ms) || v.ms < 0 || v.ms > 120000 || (v.reason && !reasons.includes(v.reason)) ||
      (v.status !== undefined && (!Number.isInteger(v.status) || v.status < 100 || v.status > 599))) return undefined
    return { state: v.state, bytes: v.bytes, ms: v.ms, ...(v.reason ? { reason: v.reason } : {}), ...(v.status ? { status: v.status } : {}) }
  }
  const download = stage(report.download), upload = stage(report.upload)
  return download && upload ? { profileId: report.profileId, at: report.at, target: 'rfc6455', download, upload } : undefined
}

export async function checkPayload(profileId: string, proxy: DiagnosticTransport, uploadEndpoint?: string,
  request: typeof proxyRequest = proxyRequest): Promise<PayloadReport> {
  const endpoint = uploadEndpoint ? transferUrl(uploadEndpoint) : undefined
  if (uploadEndpoint && !endpoint) throw new Error('endpoint')
  const stage = async (work: () => Promise<{ body: Buffer; reason?: PayloadStage['reason'] }>): Promise<PayloadStage> => {
    const start = performance.now()
    try {
      const result = await work()
      return { state: result.reason ? 'fail' : 'pass', bytes: result.body.length,
        ms: Math.max(1, Math.round(performance.now() - start)), ...(result.reason ? { reason: result.reason } : {}) }
    } catch (error) {
      const reason = proxy.signal.aborted ? (proxy.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled')
        : error instanceof TransferError ? error.code : 'network'
      return { state: 'fail', bytes: 0, ms: Math.max(1, Math.round(performance.now() - start)), reason,
        ...(error instanceof TransferError && error.status ? { status: error.status } : {}) }
    }
  }
  const download = await stage(async () => {
    const { body } = await request(proxy, new URL(PAYLOAD_DOWNLOAD.url), { maxBytes: 262144 })
    return { body, reason: verifyDownload(body) }
  })
  let upload: PayloadStage = { state: 'not_measured', bytes: 0, ms: 0, reason: 'no_endpoint' }
  if (endpoint && !proxy.signal.aborted) upload = await stage(async () => {
    const sent = uploadPayload()
    const { body } = await request(proxy, endpoint, { body: sent, maxBytes: 4096 })
    return { body: sent, ...(verifyUploadReply(body, sent) ? {} : { reason: 'reply' as const }) }
  })
  else if (endpoint) upload = { state: 'not_measured', bytes: 0, ms: 0, reason: 'cancelled' }
  return { profileId, at: Date.now(), target: 'rfc6455', download, upload }
}
