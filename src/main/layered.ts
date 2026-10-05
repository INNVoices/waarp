// W3.1 layered Direct prober: DNS (system + one fixed DoH), TCP connect, TLS handshake, HTTP HEAD — each its own
// observation with its own short timeout, done in main without any tunnel. Bounded: one target at a time, layers
// in order, each <= LAYER_MS. Network access is injected so tests run fully offline.
// W3 hardening: every layer gets an AbortSignal; when its deadline passes the signal fires and the real socket /
// request is destroyed, so a timed-out layer never keeps running in the background (system DNS is OS-owned).
import { lookup } from 'node:dns/promises'
import { connect as tcpConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import type { DirectObs, DnsObs, LayerResult } from '../shared/evidence'

export const LAYER_MS = 4000
/** one fixed provider, reached by fixed addresses so it never depends on the system resolver it is compared with */
export const DOH_HOST = 'cloudflare-dns.com', DOH_IPS = ['1.1.1.1', '1.0.0.1']

export interface Net {
  dnsSystem(host: string, signal: AbortSignal): Promise<string[]>
  dnsDoh(host: string, signal: AbortSignal): Promise<string[]>
  tcp(ip: string, port: number, signal: AbortSignal): Promise<void>
  tls(ip: string, host: string, signal: AbortSignal): Promise<void>
  head(url: string, signal: AbortSignal): Promise<number>
}

const timeoutErr = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
/** run one layer under a deadline; on the deadline (or when done) the layer's signal is aborted so it cleans up */
export function cancellable<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController()
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => { ac.abort(timeoutErr()); rej(timeoutErr()) }, ms)
    fn(ac.signal).then(v => { clearTimeout(t); res(v) }, e => { clearTimeout(t); rej(e) })
  }).finally(() => { if (!ac.signal.aborted) ac.abort() }) // losers (e.g. the second DoH address) stop too
}
const codeOf = (e: unknown): string => String((e as { code?: string })?.code ?? '')
const isTimeout = (e: unknown) => codeOf(e) === 'ETIMEDOUT'

async function dnsObs(fn: (s: AbortSignal) => Promise<string[]>, ms: number): Promise<DnsObs & { first?: string }> {
  try {
    const a = await cancellable(fn, ms)
    return a.length ? { result: 'ok', addrs: a.length, first: a[0] } : { result: 'fail', code: 'empty' }
  } catch (e) {
    if (isTimeout(e)) return { result: 'timeout' }
    const c = codeOf(e)
    return { result: 'fail', code: c === 'ENOTFOUND' ? 'nxdomain' : c === 'ECONNREFUSED' || c === 'EREFUSED' ? 'refused' : 'error' }
  }
}

/** probe one host layer by layer; later layers are `skipped` once an earlier one fails */
export async function probeLayers(target: string, net: Net = realNet, ms = LAYER_MS): Promise<DirectObs> {
  const host = target.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').toLowerCase()
  const [sys, doh] = await Promise.all([dnsObs(s => net.dnsSystem(host, s), ms), dnsObs(s => net.dnsDoh(host, s), ms)])
  const skip = { result: 'skipped' as LayerResult }
  const out: DirectObs = { dnsSystem: strip(sys), dnsDoh: strip(doh), tcp: skip, tls: skip, http: skip }
  // TCP/TLS use the system answer when it exists (that is what the browser would use), else the DoH answer
  const ip = sys.first ?? doh.first
  if (!ip) return out
  try { await cancellable(s => net.tcp(ip, 443, s), ms); out.tcp = { result: 'ok' } }
  catch (e) { out.tcp = isTimeout(e) ? { result: 'timeout' } : { result: 'fail', code: codeOf(e) === 'ECONNRESET' ? 'reset' : codeOf(e) === 'ECONNREFUSED' ? 'refused' : codeOf(e) === 'EHOSTUNREACH' || codeOf(e) === 'ENETUNREACH' ? 'unreachable' : 'error' }; return out }
  try { await cancellable(s => net.tls(ip, host, s), ms); out.tls = { result: 'ok' } }
  catch (e) {
    const c = codeOf(e)
    out.tls = isTimeout(e) ? { result: 'timeout' } : { result: 'fail', code: c === 'ECONNRESET' ? 'reset' : /CERT|ALTNAME|SELF_SIGNED/.test(c) ? 'cert' : /ALERT|SSL/.test(c) ? 'alert' : 'error' }
    return out
  }
  try { const st = await cancellable(s => net.head('https://' + host + '/', s), ms); out.http = st > 0 && st < 600 ? { result: 'ok', status: st } : { result: 'fail', status: st } }
  catch (e) { out.http = isTimeout(e) ? { result: 'timeout' } : { result: 'fail' } }
  return out
}
const strip = ({ first: _f, ...o }: DnsObs & { first?: string }): DnsObs => o

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
  tls: (ip, host, signal) => guarded<void>(signal, done => {
    const s = tlsConnect({ host: ip, servername: host, port: 443, ALPNProtocols: ['http/1.1'] })
    s.once('secureConnect', () => done(undefined)); s.once('error', e => done(e))
    return { destroy: () => s.destroy() }
  }),
  head: async (url, signal) => (await fetch(url, { method: 'HEAD', redirect: 'manual', signal })).status,
}
