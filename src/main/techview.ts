import type { Profile } from '../shared/types'
import { endpoint, tagOf } from './awg'
import { vlessOutbound } from './vless'

export type Tech = [string, string][]

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : undefined)

export function techOf(p: Profile): { tech: Tech; notApplied?: string[] } {
  const out: Tech = []
  const add = (k: string, v: string | number | undefined) => { if (v !== undefined && v !== '') out.push([k, String(v)]) }
  if (p.kind === 'vless') {
    const v = p.vless
    add('security', v.security)
    add('transport', v.network + (v.mode ? ' · ' + v.mode : ''))
    add('sni', v.sni)
    add('fp', v.fp)
    add('flow', v.flow)
    add('alpn', v.alpn?.join(', '))
    add('encryption', v.encryption ? 'on' : undefined)
    add('padding', v.extra?.xPaddingBytes)
    return { tech: out, ...(v.notApplied.length ? { notApplied: v.notApplied } : {}) }
  }
  if (p.kind === 'out') {
    const o = p.outbound as Record<string, any>
    add('type', str(o.type))
    add('transport', str(o.transport?.type))
    add('sni', str(o.tls?.server_name))
    add('fp', str(o.tls?.utls?.fingerprint))
    add('alpn', list(o.tls?.alpn))
    add('obfs', str(o.obfs?.type))
    return { tech: out }
  }
  if (p.kind === 'awg') {
    add('mtu', p.mtu ?? 1280)
    add('keepalive', p.peer.keepalive || undefined)
    add('routes', !p.peer.allowedIPs || p.peer.allowedIPs.some(a => a === '0.0.0.0/0' || a === '::/0') ? 'full' : 'split')
    add('dns', p.dns.join(', ') || undefined)
    const a = p.awg
    add('junk', a.jc !== undefined ? `Jc ${a.jc} · ${a.jmin ?? '?'}–${a.jmax ?? '?'}` : undefined)
    add('mimic', [a.i1, a.i2, a.i3, a.i4, a.i5].filter(Boolean).length || undefined)
    return { tech: out }
  }
  return { tech: out }
}

const SECRET = /uuid|password|passwd|private|pre_?shared|secret|token|auth|encryption|header_protection|psk|^key$|_key$/i
const PUBLIC = /public_key|key_share/i

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET.test(k) && !PUBLIC.test(k) ? '•••' : redact(x)]))
}

export function configOf(p: Profile): unknown {
  const tag = tagOf(p.id)
  const raw = p.kind === 'vless' ? vlessOutbound(p, tag) : p.kind === 'out' ? { ...p.outbound, tag } : p.kind === 'openvpn' ? { ...p.endpoint, tag } : endpoint(p)
  return redact(raw)
}
