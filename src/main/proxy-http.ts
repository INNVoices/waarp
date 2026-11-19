import { localized } from '../shared/localization'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { isIP } from 'node:net'
import type { DiagnosticTransport } from './diagnostic-proxy'

export class TransferError extends Error {
  constructor(readonly code: 'cancelled' | 'network' | 'tls' | 'http' | 'size', readonly status?: number) { super(code) }
}
export function transferUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash ||
      (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) return undefined
    return url
  } catch { return undefined }
}

/** An authenticated CONNECT goes only to the local core. TLS authentication and
 * HTTP body framing stay end-to-end with the requested server. No redirects,
 * environment proxy, DNS resolution in Node, or Direct retry are used. */
export async function proxyRequest(proxy: DiagnosticTransport, url: URL,
  options: { body?: Buffer; maxBytes: number; headers?: Record<string, string>; method?: 'GET' | 'POST'; connectAddress?: string; allowStatus?: boolean } = { maxBytes: 262144 }
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  if (proxy.signal.aborted) throw new TransferError('cancelled')
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > 32 * 1024 * 1024) throw new TransferError('size')
  const host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port) || 443
  if (options.connectAddress !== undefined && !isIP(options.connectAddress)) throw new TransferError('network')
  const target = options.connectAddress ?? host
  const authority = (isIP(target) === 6 ? '[' + target + ']' : target) + ':' + port
  const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    const request = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority,
      headers: { Host: authority, 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64') },
      agent: false, maxHeaderSize: 8192, signal: proxy.signal })
    request.setTimeout(10000, () => request.destroy(new Error(localized("winInline.proxy-http.484122855d3a"))))
    request.once('error', () => reject(new TransferError(proxy.signal.aborted ? 'cancelled' : 'network')))
    request.once('connect', (response, connection, head) => {
      request.setTimeout(0)
      if (response.statusCode !== 200) { connection.destroy(); reject(new TransferError('http', response.statusCode)); return }
      if (proxy.signal.aborted) { connection.destroy(); reject(new TransferError('cancelled')); return }
      if (head.length) connection.unshift(head)
      resolve(connection)
    })
    request.end()
  })
  let secure: tls.TLSSocket | undefined
  let agent: https.Agent | undefined
  const cancel = () => { secure?.destroy(); socket.destroy() }
  proxy.signal.addEventListener('abort', cancel, { once: true })
  try {
    if (proxy.signal.aborted) throw new TransferError('cancelled')
    secure = tls.connect({ socket, host, ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: true, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'],
      checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert) })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { secure!.destroy(); reject(new TransferError('tls')) }, 10000)
      secure!.once('secureConnect', () => { clearTimeout(timeout); resolve() })
      secure!.once('error', () => { clearTimeout(timeout); reject(new TransferError(proxy.signal.aborted ? 'cancelled' : 'tls')) })
      secure!.once('close', () => { clearTimeout(timeout); reject(new TransferError(proxy.signal.aborted ? 'cancelled' : 'tls')) })
    })
    if (proxy.signal.aborted) throw new TransferError('cancelled')
    agent = new https.Agent({ keepAlive: false })
    agent.createConnection = () => secure!
    return await new Promise((resolve, reject) => {
      const request = https.request(url, { agent, method: options.method ?? (options.body ? 'POST' : 'GET'),
        signal: proxy.signal, maxHeaderSize: 16384, headers: {
          'Accept-Encoding': 'identity', 'User-Agent': 'Waarp/transfer-check', Connection: 'close',
          ...(options.body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(options.body.length) } : {}),
          ...options.headers
        } }, response => {
        const status = response.statusCode ?? 0
        if ((!options.allowStatus && status !== 200) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy(); reject(new TransferError('http', status)); return
        }
        const length = response.headers['content-length']
        if (length && (!/^\d+$/.test(length) || Number(length) > options.maxBytes)) {
          response.destroy(); reject(new TransferError('size')); return
        }
        const chunks: Buffer[] = []; let bytes = 0
        response.on('data', chunk => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += data.length
          if (bytes > options.maxBytes) { response.destroy(); reject(new TransferError('size')); return }
          chunks.push(data)
        })
        response.once('error', () => reject(new TransferError(proxy.signal.aborted ? 'cancelled' : 'network')))
        response.once('aborted', () => reject(new TransferError(proxy.signal.aborted ? 'cancelled' : 'network')))
        response.once('end', () => {
          if (!response.complete || (length && Number(length) !== bytes)) { reject(new TransferError('size')); return }
          resolve({ status, body: Buffer.concat(chunks, bytes), headers: response.headers })
        })
      })
      request.setTimeout(10000, () => request.destroy(new Error(localized("winInline.proxy-http.4dac6ca0b1cd"))))
      request.once('error', () => reject(new TransferError(proxy.signal.aborted ? 'cancelled' : 'network')))
      request.end(options.body)
    })
  } finally {
    proxy.signal.removeEventListener('abort', cancel)
    secure?.destroy(); socket.destroy(); agent?.destroy()
  }
}
