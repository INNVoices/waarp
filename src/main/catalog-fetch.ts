import { localized } from '../shared/localization'
import { request } from 'node:https'
import { Readable } from 'node:stream'
import { publicSourceForUrl, type PublicSourceFormat } from '../shared/public-sources'
import { parseLink } from './links'
import { parseVpnGateCsv } from './vpngate'
import { fetchSubscription, pinnedAddressLookup, resolvedPublic, type PinnedHttpGet } from './vless'

export type CatalogFetchTransport = PinnedHttpGet
export interface CatalogSourceAttempt {
  url: string
  outcome: 'ok' | 'invalid-format' | 'unavailable' | 'cancelled'
}
export interface CatalogSourceText {
  /** Logical source URL, independent of the mirror that answered. */
  url: string
  body?: string
  error?: string
  sourceId?: string
  selectedUrl?: string
  format?: PublicSourceFormat
  attempts?: CatalogSourceAttempt[]
}

export const CATALOG_FETCH_LIMITS = {
  maxSources: 10,
  concurrency: 3,
  maxMirrors: 3,
  maxBytes: 16 * 1024 * 1024,
  attemptTimeoutMs: 8000,
  sourceTimeoutMs: 32000,
  maxRedirects: 3,
  validationLines: 5000
} as const

const LEGACY_HOSTS = new Set(['raw.githubusercontent.com', 'www.vpngate.net', 'vpngate.net'])
const URI_START = /^[a-z][a-z0-9+.-]*:\/\//i
const SUPPORTED_URI = /^(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\//i

function permittedUrl(url: URL, hosts: ReadonlySet<string>): void {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hosts.has(url.hostname.toLowerCase())) {
    throw new Error(localized("winInline.catalog-fetch.313991c058d5"))
  }
}

/** Use the same checked-address lookup as subscription downloads, including
 * Node's dual-stack lookup contract. This is never the global fetch path and
 * never performs a second, unchecked DNS lookup when connecting. */
const directGet: PinnedHttpGet = async (url, addresses, signal) => {
  signal.throwIfAborted()
  return new Promise<Response>((resolve, reject) => {
    const req = request({
      protocol: 'https:', hostname: url.hostname, port: 443,
      path: url.pathname + url.search, servername: url.hostname, method: 'GET', signal,
      lookup: pinnedAddressLookup(addresses),
      headers: { Accept: 'text/plain, application/octet-stream;q=0.9, */*;q=0.1', 'User-Agent': 'Waarp/catalog' }
    }, res => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
      }
      const status = res.statusCode ?? 500
      if ([204, 205, 304].includes(status)) {
        res.resume()
        resolve(new Response(null, { status, headers }))
      } else resolve(new Response(Readable.toWeb(res) as ReadableStream, { status, headers }))
    })
    req.once('error', reject)
    req.end()
  })
}

/** Format validation runs before an HTTP success can win a mirror race. Only
 * share-link data survives normalization; a source cannot install its own
 * routing, DNS, scripts or other full-client configuration. */
function supportedBody(input: string, format: PublicSourceFormat): string | undefined {
  let body = input.replace(/^\uFEFF/, '').trim()
  if (!body || /<(?:!doctype|html|head|body|script|iframe)\b/i.test(body)) return undefined
  if (format === 'vpngate-csv') {
    if (!/^#?HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,.*OpenVPN_ConfigData_Base64\s*$/m.test(body)) return undefined
    return parseVpnGateCsv(body, 1).length ? body : undefined
  }
  if (!/:\/\//.test(body)) {
    const compact = body.replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.length % 4 === 1) return undefined
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(compact, 'base64')).trim() }
    catch { return undefined }
  }
  // Reject HTML (even with embedded links), whole JSON/YAML and arbitrary
  // containers instead of treating a link inside them as a valid subscription.
  if (/<(?:!doctype|html|head|body|script|iframe)\b/i.test(body)) return undefined
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (!lines.length || !URI_START.test(lines[0])) return undefined
  if (lines.some(line => !URI_START.test(line))) return undefined
  const links = lines.filter(line => SUPPORTED_URI.test(line))
  let valid = false
  for (const line of links.slice(0, CATALOG_FETCH_LIMITS.validationLines)) {
    try { if (parseLink(line)) { valid = true; break } } catch { /* try the next candidate, not a relay */ }
  }
  return valid ? links.join('\n') : undefined
}

async function loadSource(requested: string, cancel: AbortSignal, transport?: PinnedHttpGet): Promise<CatalogSourceText> {
  const known = publicSourceForUrl(requested)
  const url = known?.url ?? requested
  const format = known?.format ?? (/^https:\/\/(?:www\.)?vpngate\.net\/api\/iphone\/?$/i.test(url) ? 'vpngate-csv' : 'uri-or-base64')
  const result: CatalogSourceText = { url, ...(known ? { sourceId: known.id } : {}), format, attempts: [] }
  const endpoints = known ? [known.url, ...known.mirrors.slice(0, CATALOG_FETCH_LIMITS.maxMirrors)] : [requested]
  const hosts = known ? new Set(endpoints.map(endpoint => new URL(endpoint).hostname.toLowerCase())) : LEGACY_HOSTS
  if (known?.id === 'vpngate') hosts.add('vpngate.net')
  const sourceAbort = new AbortController()
  const timer = setTimeout(() => sourceAbort.abort(), CATALOG_FETCH_LIMITS.sourceTimeoutMs)
  const signal = AbortSignal.any([cancel, sourceAbort.signal])
  try {
    for (const endpoint of endpoints) {
      if (signal.aborted) break
      let selectedUrl = endpoint
      let responseWasInvalid = false
      try {
        permittedUrl(new URL(endpoint), hosts)
        const upstream = transport ?? directGet
        const guarded: PinnedHttpGet = async (current, addresses, requestSignal, maxBytes) => {
          permittedUrl(current, hosts)
          selectedUrl = current.href
          return upstream(current, addresses, requestSignal, maxBytes)
        }
        // Check redirect hostnames before DNS, then resolve through exactly the
        // requested path. A failed selected-profile download has no Direct retry.
        guarded.resolve = async (hostname, requestSignal) => {
          const current = new URL('https://' + hostname)
          permittedUrl(current, hosts)
          return resolvedPublic(current, requestSignal, upstream.resolve)
        }
        const text = await fetchSubscription(endpoint, {
          transport: guarded, signal, timeoutMs: CATALOG_FETCH_LIMITS.attemptTimeoutMs,
          maxBytes: CATALOG_FETCH_LIMITS.maxBytes, maxRedirects: CATALOG_FETCH_LIMITS.maxRedirects
        })
        signal.throwIfAborted()
        const body = supportedBody(text, format)
        if (!body) { responseWasInvalid = true; throw new Error(localized("winInline.catalog-fetch.a6a75db01b20")) }
        result.attempts!.push({ url: endpoint, outcome: 'ok' })
        return { ...result, body, selectedUrl }
      } catch {
        result.attempts!.push({ url: endpoint, outcome: signal.aborted ? 'cancelled' : responseWasInvalid ? 'invalid-format' : 'unavailable' })
      }
    }
    return { ...result, error: cancel.aborted ? localized("winInline.catalog-fetch.6bfc3ba3be97") : localized("winInline.catalog-fetch.2a8d893315f2") }
  } finally { clearTimeout(timer) }
}

/** A bounded number of independent sources; each source tries its documented
 * mirrors in order. Download health is separate from relay health: no result
 * here marks a node alive or makes it part of application routing. */
export async function fetchCatalogSources(sources: string[], signal: AbortSignal, transport?: PinnedHttpGet): Promise<CatalogSourceText[]> {
  const selected = [...new Set(sources.map(url => publicSourceForUrl(url)?.url ?? url))].slice(0, CATALOG_FETCH_LIMITS.maxSources)
  const results: CatalogSourceText[] = new Array(selected.length)
  let next = 0
  const worker = async () => {
    while (next < selected.length) {
      const index = next++
      results[index] = await loadSource(selected[index], signal, transport)
    }
  }
  await Promise.all(Array.from({ length: Math.min(selected.length, CATALOG_FETCH_LIMITS.concurrency) }, worker))
  return results
}
