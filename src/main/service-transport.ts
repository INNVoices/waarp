import type { DiagnosticTransport } from './diagnostic-proxy'
import { proxyRequest, TransferError } from './proxy-http'
import type { PinnedHttpGet, PublicResolver } from './vless'
import { isIP } from 'node:net'

/** DNS uses the selected path too. A fixed public resolver address avoids local
 * poisoned DNS bootstrap; TLS authenticates its documented hostname. No system
 * resolver fallback. The caller still rejects private addresses before dialing.
 * https://developers.cloudflare.com/1.1.1.1/infrastructure/network-operators/
 * https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/ */
export function serviceResolver(proxy: DiagnosticTransport, request = proxyRequest): PublicResolver {
  const cache = new Map<string, ReturnType<PublicResolver>>()
  return (hostname, signal) => {
    const previous = cache.get(hostname)
    if (previous) return previous
    const work = (async () => {
      const combined = AbortSignal.any([proxy.signal, signal, AbortSignal.timeout(8000)])
      const answers = await Promise.all(([1, 28] as const).map(async type => {
        const url = new URL('https://cloudflare-dns.com/dns-query')
        url.searchParams.set('name', hostname); url.searchParams.set('type', String(type))
        const response = await request({ ...proxy, signal: combined }, url,
          { connectAddress: '1.1.1.1', maxBytes: 16384, headers: { Accept: 'application/dns-json' } })
        const data = JSON.parse(response.body.toString('utf8'))
        if (data?.Status !== 0 || data?.TC === true || (data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 128))) throw new TransferError('network')
        return (data.Answer ?? []).filter((record: any) => record?.type === type).map((record: any) => {
          const family = type === 1 ? 4 : 6
          if (typeof record.data !== 'string' || isIP(record.data) !== family) throw new TransferError('network')
          return { address: record.data as string, family }
        }) as { address: string; family: number }[]
      }))
      combined.throwIfAborted()
      return answers.flat()
    })()
    // A download batch lasts at most a minute. Cache only its bounded name set,
    // never carry potentially stale answers into a later profile/session.
    if (cache.size < 64) cache.set(hostname, work)
    return work
  }
}

/** Subscription/list/catalog requests retain the existing resolve-once public
 * address guard. A selected profile never falls back to a system HTTP socket. */
export function serviceTransport(proxy: DiagnosticTransport, request = proxyRequest): PinnedHttpGet {
  const get: PinnedHttpGet = async (url, addresses, signal, maxBytes) => {
    const combined = AbortSignal.any([proxy.signal, signal])
    let failure: unknown = new TransferError('network')
    // Try a bounded checked set through this same profile. CONNECT gets an IP;
    // TLS SNI, hostname validation and the HTTP Host stay the original hostname.
    for (const target of [...addresses].sort((a, b) => a.family - b.family).slice(0, 4)) {
      combined.throwIfAborted()
      try {
        const result = await request({ ...proxy, signal: combined }, url,
          { maxBytes, connectAddress: target.address, allowStatus: true,
            headers: { Accept: 'text/plain, application/octet-stream;q=0.9, */*;q=0.1', 'User-Agent': 'Waarp/service-download' } })
        const headers = new Headers()
        for (const [key, value] of Object.entries(result.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
        return new Response([204, 205, 304].includes(result.status) ? null : new Uint8Array(result.body), { status: result.status, headers })
      } catch (error) {
        failure = error
        if (!(error instanceof TransferError) || error.code !== 'network') throw error
      }
    }
    throw failure
  }
  get.resolve = serviceResolver(proxy, request)
  return get
}
