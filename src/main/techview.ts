import type { Profile, ProfileView, Settings, Status } from '../shared/types'
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
    add('ports', list(o.server_ports))
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

const SECRET = /uuid|password|passwd|private|pre_?shared|secret|token|auth|encryption|header_protection|psk|cookie|username|short_id|(?:^|[_-])key$|^(?:path|service_name|client_certificate)$/i
const PUBLIC = /^(?:public_key|key_share)$/i

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => {
    // A credential can live in an arbitrary custom header name, not just Authorization.
    if (/^headers$/i.test(k) && x && typeof x === 'object' && !Array.isArray(x)) return [k, Object.fromEntries(Object.entries(x).map(([name, value]) => [name, /^host$/i.test(name) && typeof value === 'string' && /^[a-z0-9.:[\]_-]+$/i.test(value) ? value : '•••']))]
    return [k, SECRET.test(k) && !PUBLIC.test(k) ? '•••' : redact(x)]
  }))
}

export function configOf(p: Profile): unknown {
  const tag = tagOf(p.id)
  const raw = p.kind === 'vless' ? vlessOutbound(p, tag) : p.kind === 'out' ? { ...p.outbound, tag } : p.kind === 'openvpn' ? { ...p.endpoint, tag } : endpoint(p)
  return redact(raw)
}

/** Shareable diagnostics deliberately contain no arbitrary names, endpoints, paths or log text. */
export function diagnosticsOf({ app, integrity, at, status, profiles, settings, log }: {
  app: string; integrity: boolean; at: string; status: Status; profiles: ProfileView[]; settings: Settings; log: string[]
}) {
  const ids = new Map<string, string>([['direct', 'direct'], ['g-auto', 'auto']])
  profiles.forEach((p, i) => ids.set(p.id, `p${i + 1}`))
  settings.groups.forEach((g, i) => { if (!ids.has(g.id)) ids.set(g.id, `g${i + 1}`) })
  let unknown = 0
  const id = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined
    if (!ids.has(raw)) ids.set(raw, `missing${++unknown}`)
    return ids.get(raw)
  }
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  const choice = (v: unknown, choices: string[]) => typeof v === 'string' && choices.includes(v) ? v : undefined
  return {
    app, integrity, at,
    status: {
      phase: choice(status.phase, ['off', 'starting', 'on', 'stopping', 'error']),
      engine: choice(status.engine, ['up', 'down']),
      recovery: choice(status.recovery, ['tun_stale', 'tun_collision', 'tun_unknown']),
      startup: choice(status.startup, ['recovering', 'ready', 'failed']),
      open: status.open === true, hasError: !!status.error,
      since: number(status.since), pingRound: number(status.pingRound), pingAt: number(status.pingAt),
      down: number(status.down), up: number(status.up), downTotal: number(status.downTotal), upTotal: number(status.upTotal),
      directPing: number(status.pings.direct),
      autoPool: status.autoPool ? { live: number(status.autoPool.live), total: number(status.autoPool.total) } : undefined
    },
    profiles: profiles.map(p => ({
      id: id(p.id), kind: choice(p.kind, ['awg', 'vless', 'out', 'openvpn', 'group']),
      source: choice(p.source, ['personal', 'public', 'managed', 'warp']),
      revoked: p.revoked === true, subscription: p.subscription === true, subscriptionMissing: p.subscriptionMissing === true,
      health: choice(status.health?.[p.id], ['ok', 'degraded', 'down', 'busy', 'unknown']),
      ping: number(status.pings[p.id]), picked: id(status.picked?.[p.id]),
      notAppliedCount: p.notApplied?.length ?? 0
    })),
    routes: settings.routes.map((r, i) => ({
      id: `r${i + 1}`, kind: choice(r.kind, ['app', 'preset', 'custom', 'list']), on: r.on === true,
      via: id(r.via), fallback: id(r.fallback), activeFallback: id(status.fallback[r.id]),
      wholeDir: r.wholeDir === true, dpi: r.dpi === true,
      state: choice(status.routes?.[r.id]?.state, ['ok', 'fallback', 'retrying', 'blocked', 'direct', 'idle', 'off']),
      reason: choice(status.routes?.[r.id]?.reason, ['main_down', 'path_down', 'engine_down', 'missing', 'busy', 'waiting']),
      effective: id(status.routes?.[r.id]?.effective)
    })),
    settings: { rest: id(settings.rest), ruDirect: settings.ruDirect === true, lanDirect: settings.lanDirect === true,
      groups: settings.groups.map(g => ({ id: id(g.id), policy: choice(g.policy, ['fastest', 'first']), members: g.members.map(id) })) },
    log: { lines: log.length, errors: log.filter(line => /\b(?:ERROR|FATAL)\b/i.test(line)).length, warnings: log.filter(line => /\bWARN(?:ING)?\b/i.test(line)).length, textOmitted: true }
  }
}
