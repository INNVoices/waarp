import { isIP } from 'node:net'
import type { DiagnosticTransport } from './diagnostic-proxy'
import { proxyRequest, TransferError } from './proxy-http'
import { serviceTransport } from './service-transport'
import { resolvedPublic, type PinnedHttpGet, type PublicResolver } from './vless'

const RESOLVERS = [
  { url: 'https://cloudflare-dns.com/dns-query', address: '1.1.1.1' },
  { url: 'https://dns.google/resolve', address: '8.8.8.8' }
] as const
const RESOLVER_TIMEOUT_MS = 3000

function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new TransferError('cancelled')) }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** Public-catalog DNS only. Both providers use the SAME selected local proxy;
 * fixed anycast bootstrap addresses avoid another resolver dependency, while
 * proxyRequest preserves the documented HTTPS hostname and validates its TLS.
 * Google JSON endpoint/SNI and anycast address documentation:
 * https://developers.google.com/speed/public-dns/docs/doh/json
 * https://developers.google.com/speed/public-dns/docs/secure-transports
 * https://security.googleblog.com/2019/06/google-public-dns-over-https-doh.html
 * The private service resolver's policy is intentionally unchanged. */
function publicResolver(proxy: DiagnosticTransport, request: typeof proxyRequest): PublicResolver {
  const cache = new Map<string, Awaited<ReturnType<PublicResolver>>>()
  return async (hostname, signal) => {
    const active = AbortSignal.any([proxy.signal, signal])
    active.throwIfAborted()
    const cached = cache.get(hostname)
    if (cached) return cached.map(answer => ({ ...answer }))
    for (const resolver of RESOLVERS) {
      active.throwIfAborted()
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), RESOLVER_TIMEOUT_MS)
      const scoped = AbortSignal.any([active, timeout.signal])
      try {
        const parts = await untilAbort(Promise.all(([1, 28] as const).map(async type => {
          const url = new URL(resolver.url)
          url.searchParams.set('name', hostname); url.searchParams.set('type', String(type))
          if (url.hostname === 'dns.google') url.searchParams.set('edns_client_subnet', '0.0.0.0/0')
          const response = await request({ ...proxy, signal: scoped }, url, {
            connectAddress: resolver.address, maxBytes: 16384, headers: { Accept: 'application/dns-json' }
          })
          if (response.status !== 200 || response.body.length > 16384) throw new TransferError('network')
          const data = JSON.parse(response.body.toString('utf8'))
          if (data?.Status !== 0 || (data.TC !== undefined && data.TC !== false) ||
            (data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 128))) throw new TransferError('network')
          return (data.Answer ?? []).filter((record: any) => record?.type === type).map((record: any) => {
            const family = type === 1 ? 4 : 6
            if (typeof record.data !== 'string' || isIP(record.data) !== family) throw new TransferError('network')
            return { address: record.data as string, family }
          }) as Awaited<ReturnType<PublicResolver>>
        })), scoped)
        active.throwIfAborted()
        // Reuse the common all-addresses guard before accepting or caching any
        // provider response, including mixed public/private DNS answers.
        const answers = await resolvedPublic(new URL('https://' + hostname), scoped, async () => parts.flat())
        active.throwIfAborted()
        if (cache.size < 64) cache.set(hostname, answers)
        return answers.map(answer => ({ ...answer }))
      } catch {
        active.throwIfAborted()
        // A provider timeout/invalid response does not abort the session or use
        // system DNS. The next provider is reached through this same proxy.
      } finally { clearTimeout(timer); timeout.abort() }
    }
    throw new TransferError('network')
  }
}

export function publicServiceTransport(proxy: DiagnosticTransport, request = proxyRequest): PinnedHttpGet {
  const transport = serviceTransport(proxy, request)
  transport.resolve = publicResolver(proxy, request)
  return transport
}
