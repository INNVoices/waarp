// W3.1 layered Direct prober: DNS (system + one fixed DoH), TCP connect, TLS handshake, HTTP HEAD — each its own
// observation with its own short timeout, done in main without any tunnel. Bounded: one target at a time, layers
// in order, each <= LAYER_MS. Network access is injected so tests run fully offline.
// W3 hardening: every layer gets an AbortSignal; when its deadline passes the signal fires and the real socket /
// request is destroyed, so a timed-out layer never keeps running in the background (system DNS is OS-owned).
import { lookup } from 'node:dns/promises'
import { connect as tcpConnect, isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import type { DirectObs, DnsObs, LayerResult } from '../shared/evidence'

export const LAYER_MS = 4000
export const HTTP_BYTES = 64 * 1024
/** one fixed provider, reached by fixed addresses so it never depends on the system resolver it is compared with */
export const DOH_HOST = 'cloudflare-dns.com', DOH_IPS = ['1.1.1.1', '1.0.0.1']

export interface Net {
  dnsSystem(host: string, signal: AbortSignal): Promise<string[]>
  dnsDoh(host: string, signal: AbortSignal): Promise<string[]>
  tcp(ip: string, port: number, signal: AbortSignal): Promise<void>
  tls(ip: string, host: string, port: number, signal: AbortSignal): Promise<void>
  http(url: string, method: 'HEAD' | 'GET', signal: AbortSignal): Promise<{ status: number; location?: string }>
}

export interface ProbeUrl { url: string; scheme: 'http' | 'https'; host: string; port: number; ip: boolean; shown: string }

export function parseProbe(target: string): ProbeUrl | undefined {
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(target) && !/^https?:\/\//i.test(target)) return undefined
    const u = new URL(/^https?:\/\//i.test(target) ? target : 'https://' + target)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    const scheme = u.protocol === 'http:' ? 'http' : 'https'
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!host) return undefined
    const port = u.port ? Number(u.port) : scheme === 'http' ? 80 : 443
    u.username = ''; u.password = ''; u.hash = ''
    return { url: u.toString(), scheme, host, port, ip: isIP(host) !== 0, shown: u.origin + u.pathname }
  } catch { return undefined }
}

const timeoutErr = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
/** run one layer under a deadline; on the deadline (or when done) the layer's signal is aborted so it cleans up */
export function cancellable<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  const ac = new AbortController()
  return new Promise<T>((res, rej) => {
    let settled = false
    const finish = (error?: unknown, value?: T) => {
      if (settled) return
      settled = true; clearTimeout(t); signal?.removeEventListener('abort', abort)
      if (error) rej(error); else res(value as T)
    }
    const abort = () => { const error = signal?.reason ?? timeoutErr(); ac.abort(error); finish(error) }
    const t = setTimeout(() => { const error = timeoutErr(); ac.abort(error); finish(error) }, Math.max(0, ms))
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { if (ac.signal.aborted) throw ac.signal.reason; return fn(ac.signal) }).then(v => finish(undefined, v), e => finish(e))
  }).finally(() => { if (!ac.signal.aborted) ac.abort() }) // losers (e.g. the second DoH address) stop too
}
const codeOf = (e: unknown): string => String((e as { code?: string })?.code ?? '')
const isTimeout = (e: unknown) => codeOf(e) === 'ETIMEDOUT'
function agreedFailure(error: unknown): unknown {
  if (error instanceof AggregateError && error.errors.length) {
    const first = error.errors[0]
    if (codeOf(first) && error.errors.every(item => codeOf(item) === codeOf(first))) return first
  }
  return error
}

/** Give both address families a chance within the same stage deadline. A broken
 * first IPv6 address must not become a false site failure when IPv4 responds. */
function probeAddresses(addresses: readonly string[]): string[] {
  const unique = [...new Set(addresses)].filter(address => isIP(address) !== 0)
  const first = unique[0], other = unique.find(address => isIP(address) !== isIP(first ?? ''))
  return [...new Set([first, other, ...unique].filter((address): address is string => !!address))].slice(0, 4)
}
async function anyAddress(addresses: readonly string[], check: (ip: string) => Promise<void>): Promise<string> {
  try { return await Promise.any(addresses.map(async ip => { await check(ip); return ip })) }
  // Preserve a specific refusal/certificate verdict only when all attempts agree.
  catch (error) { throw agreedFailure(error) }
}

async function dnsObs(fn: (s: AbortSignal) => Promise<string[]>, ms: number, signal?: AbortSignal): Promise<DnsObs & { first?: string; all?: string[] }> {
  try {
    const a = await cancellable(fn, ms, signal)
    return a.length ? { result: 'ok', addrs: a.length, first: a[0], all: a } : { result: 'fail', code: 'empty' }
  } catch (e) {
    const reason = agreedFailure(e)
    if (isTimeout(reason)) return { result: 'timeout' }
    const c = codeOf(reason)
    return { result: 'fail', code: c === 'ENOTFOUND' ? 'nxdomain' : c === 'ECONNREFUSED' || c === 'EREFUSED' ? 'refused' : 'error' }
  }
}

/** probe one URL layer by layer; later layers are `skipped` once an earlier one fails */
export async function probeLayers(target: string, net: Net = realNet, ms = LAYER_MS, signal?: AbortSignal): Promise<DirectObs> {
  const t = parseProbe(target)
  const skip = { result: 'skipped' as LayerResult }, na = { result: 'na' as LayerResult }
  if (!t) return { dnsSystem: { result: 'fail', code: 'error' }, dnsDoh: skip, tcp: skip, tls: skip, http: skip }
  const [sys, doh] = t.ip ? [{ result: 'na' as LayerResult, first: t.host }, { result: 'na' as LayerResult }] as const
    : await Promise.all([dnsObs(s => net.dnsSystem(t.host, s), ms, signal), dnsObs(s => net.dnsDoh(t.host, s), ms, signal)])
  const out: DirectObs = { dnsSystem: strip(sys), dnsDoh: strip(doh), tcp: skip, tls: t.scheme === 'http' ? na : skip, http: skip }
  if ('all' in sys && 'all' in doh && sys.all && doh.all && !sys.all.some(a => doh.all!.includes(a))) out.dnsDiffer = true
  // Use the system answer when it exists (as the browser does), otherwise DoH.
  // All attempts share one bounded deadline and the winning stage cancels losers.
  const addresses = probeAddresses('all' in sys && sys.all?.length ? sys.all : sys.first ? [sys.first] : 'all' in doh ? doh.all ?? [] : [])
  if (!addresses.length) return out
  let connected: string
  try { connected = await cancellable(s => anyAddress(addresses, ip => net.tcp(ip, t.port, s)), ms, signal); out.tcp = { result: 'ok' } }
  catch (e) { out.tcp = isTimeout(e) ? { result: 'timeout' } : { result: 'fail', code: codeOf(e) === 'ECONNRESET' ? 'reset' : codeOf(e) === 'ECONNREFUSED' ? 'refused' : codeOf(e) === 'EHOSTUNREACH' || codeOf(e) === 'ENETUNREACH' ? 'unreachable' : 'error' }; return out }
  if (t.scheme === 'https') {
    try { await cancellable(s => anyAddress([connected, ...addresses.filter(ip => ip !== connected)], ip => net.tls(ip, t.ip ? '' : t.host, t.port, s)), ms, signal); out.tls = { result: 'ok' } }
    catch (e) {
      const c = codeOf(e)
      out.tls = isTimeout(e) ? { result: 'timeout' } : { result: 'fail', code: c === 'ECONNRESET' ? 'reset' : /CERT|ALTNAME|SELF_SIGNED/.test(c) ? 'cert' : /ALERT|SSL/.test(c) ? 'alert' : 'error' }
      return out
    }
  }
  const httpDeadline = Date.now() + ms
  const ask = async (method: 'HEAD' | 'GET') => {
    const remaining = httpDeadline - Date.now()
    if (remaining <= 0) throw timeoutErr()
    return cancellable(s => net.http(t.url, method, s), remaining, signal)
  }
  try {
    let r = await ask('HEAD')
    if (r.status === 405 || r.status === 501) {
      r = await ask('GET')
      if (r.status === 405 || r.status === 501) { out.http = { result: 'fail', status: r.status, code: 'method' }; return out }
    }
    const to = r.status >= 300 && r.status < 400 && r.location ? redirectHost(r.location, t) : undefined
    out.http = r.status >= 200 && r.status < 400 ? { result: 'ok', status: r.status, ...(to ? { to } : {}) } : { result: 'fail', status: r.status }
  } catch (e) { out.http = isTimeout(e) ? { result: 'timeout' } : { result: 'fail' } }
  return out
}

function redirectHost(location: string, t: ProbeUrl): string | undefined {
  try { const u = new URL(location, t.url); return u.host.toLowerCase() === new URL(t.url).host.toLowerCase() ? u.pathname : u.host.toLowerCase() } catch { return undefined }
}
const strip = ({ first: _f, all: _a, ...o }: DnsObs & { first?: string; all?: string[] }): DnsObs => o

/** settle once; an abort destroys the socket/request and rejects */
function guarded<T>(signal: AbortSignal, start: (done: (e: unknown, v?: T) => void) => { destroy(): void }): Promise<T> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(timeoutErr())
    let settled = false
    const h = start((e, v) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', onAbort); h.destroy()
      if (e) rej(e); else res(v as T)
    })
    const onAbort = () => { if (!settled) { settled = true; h.destroy(); rej(timeoutErr()) } }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function dohVia(ip: string, name: string, signal: AbortSignal): Promise<string[]> {
  return guarded<string[]>(signal, done => {
    const req = httpsRequest({ host: ip, servername: DOH_HOST, path: '/dns-query?name=' + encodeURIComponent(name) + '&type=A', headers: { host: DOH_HOST, accept: 'application/dns-json' } }, r => {
      let body = ''
      r.setEncoding('utf8'); r.on('data', c => { if (body.length < 65536) body += c }); r.on('end', () => {
        try {
          const j = JSON.parse(body) as { Status?: number; Answer?: { type: number; data: string }[] }
          if (j.Status === 3) return done(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }))
          done(undefined, (j.Answer ?? []).filter(a => a.type === 1).map(a => a.data))
        } catch (e) { done(e) }
      })
    })
    req.on('error', e => done(e)); req.end()
    return { destroy: () => req.destroy() }
  })
}

export const realNet: Net = {
  dnsSystem: async h => (await lookup(h, { all: true })).map(a => a.address), // OS-owned; cannot be cancelled
  // both transport addresses race under the caller's one deadline; the loser is aborted when the race settles
  dnsDoh: (h, signal) => Promise.any(DOH_IPS.map(ip => dohVia(ip, h, signal))),
  tcp: (ip, port, signal) => guarded<void>(signal, done => {
    const s = tcpConnect({ host: ip, port })
    s.once('connect', () => done(undefined)); s.once('error', e => done(e))
    return { destroy: () => s.destroy() }
  }),
  tls: (ip, host, port, signal) => guarded<void>(signal, done => {
    const s = tlsConnect({ host: ip, ...(host ? { servername: host } : {}), port, ALPNProtocols: ['http/1.1'] })
    s.once('secureConnect', () => done(undefined)); s.once('error', e => done(e))
    return { destroy: () => s.destroy() }
  }),
  http: async (url, method, signal) => {
    const r = await fetch(url, { method, redirect: 'manual', signal })
    const location = r.headers.get('location') ?? undefined
    if (method === 'GET' && r.body) {
      const reader = r.body.getReader()
      let got = 0
      try { while (got < HTTP_BYTES) { const c = await reader.read(); if (c.done) break; got += c.value.byteLength } } finally { void reader.cancel().catch(() => undefined) }
    }
    return { status: r.status, ...(location ? { location } : {}) }
  },
}
