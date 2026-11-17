import { createHash } from 'node:crypto'
import type { Profile } from '../shared/types'

export type TunePatch = { fp?: string; recordFragment?: boolean; jc?: number; jmin?: number; jmax?: number; mtu?: number }
export interface TuneVariant { label: string; patch: TunePatch }
export interface TuneEntry { net: string; sig: string; label: string; patch: TunePatch; at: number }
export type Tunes = Record<string, TuneEntry>
export interface TuneResult { id: string; net: string; sig: string; at: number; results: { label: string; ms: number | null }[] }

export const TUNE_TTL_MS = 14 * 24 * 3600_000
export const TUNE_MAX_VARIANTS = 6
export const TUNE_RESULT_TTL_MS = 5 * 60_000
// Single-segment hellos (ios, edge) first: a mobile DPI drops the second segment of the larger ones.
const FPS = ['ios', 'edge', 'firefox', 'chrome', 'safari']

export const profileSig = (p: Profile) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16)

const tlsOf = (p: Profile): { fp?: string } | undefined => {
  if (p.kind === 'vless') return p.vless.security === 'none' ? undefined : { fp: p.vless.fp }
  // QUIC transports (Hysteria2/TUIC) cannot use TCP TLS record fragmentation or uTLS.
  if (p.kind === 'out' && ['vmess', 'trojan'].includes(String(p.outbound.type))) { const t = (p.outbound as { tls?: { enabled?: boolean; utls?: { fingerprint?: string } } }).tls; return t?.enabled ? { fp: t.utls?.fingerprint } : undefined }
  return undefined
}

export function variants(p: Profile): TuneVariant[] {
  const out: TuneVariant[] = []
  const tls = tlsOf(p)
  if (tls) {
    for (const fp of FPS) if (fp !== tls.fp) out.push({ label: 'fp ' + fp, patch: { fp } })
    out.push({ label: 'TLS record fragment', patch: { recordFragment: true } })
    for (const fp of FPS) if (fp !== tls.fp && out.length < TUNE_MAX_VARIANTS) out.push({ label: `fp ${fp} + fragment`, patch: { fp, recordFragment: true } })
  }
  if (p.kind === 'awg') {
    const a = p.awg
    const junk = [{ jc: 4, jmin: 8, jmax: 80 }, { jc: 8, jmin: 50, jmax: 1000 }].filter(j => j.jc !== a.jc || j.jmin !== a.jmin || j.jmax !== a.jmax)
    for (const j of junk) out.push({ label: `junk Jc ${j.jc} ${j.jmin}–${j.jmax}`, patch: j })
    for (const mtu of [1200, 1360]) if (mtu !== (p.mtu ?? 1280)) out.push({ label: 'MTU ' + mtu, patch: { mtu } })
  }
  return out.slice(0, TUNE_MAX_VARIANTS)
}

export function applyTune(p: Profile, t: TunePatch): Profile {
  if (p.kind === 'vless') return { ...p, vless: { ...p.vless, ...(t.fp ? { fp: t.fp } : {}), ...(t.recordFragment ? { recordFragment: true } : {}) } }
  if (p.kind === 'out') {
    const o = p.outbound as Record<string, any>
    if (!tlsOf(p)) return p
    const tls = { ...o.tls, ...(t.recordFragment ? { record_fragment: true } : {}), ...(t.fp ? { utls: { ...o.tls.utls, enabled: true, fingerprint: t.fp } } : {}) }
    return { ...p, outbound: { ...o, tls } }
  }
  if (p.kind === 'awg') {
    const awg = { ...p.awg, ...(t.jc !== undefined ? { jc: t.jc, jmin: t.jmin, jmax: t.jmax } : {}) }
    return { ...p, awg, ...(t.mtu ? { mtu: t.mtu } : {}) }
  }
  return p
}

/** a stored tune applies only on the same network, to the unchanged profile, while fresh */
export function tuned(profiles: Profile[], tunes: Tunes, net: string | undefined, now: number): Profile[] {
  if (!net) return profiles
  return profiles.map(p => {
    const t = activeTune(p, tunes[p.id], net, now)
    return t ? applyTune(p, t.patch) : p
  })
}

const fresh = (at: unknown, now: number, ttl: number): boolean => typeof at === 'number' && Number.isFinite(at) && at <= now && now - at < ttl
const patchKey = (patch: unknown): string => patch && typeof patch === 'object' && !Array.isArray(patch) ? JSON.stringify(Object.entries(patch).sort(([a], [b]) => a.localeCompare(b))) : ''

/** Disk data must still describe one of the bounded, compatible variants for this profile. */
export function activeTune(p: Profile, value: unknown, net: string | undefined, now: number): TuneEntry | undefined {
  if (!value || typeof value !== 'object' || !net || p.revoked) return undefined
  const t = value as TuneEntry
  if (t.net !== net || t.sig !== profileSig(p) || !fresh(t.at, now, TUNE_TTL_MS)) return undefined
  return variants(p).some(v => v.label === t.label && patchKey(v.patch) === patchKey(t.patch)) ? t : undefined
}

export function pruneTunes(tunes: unknown, profiles: Profile[], now: number): Tunes {
  if (!tunes || typeof tunes !== 'object' || Array.isArray(tunes)) return {}
  return Object.fromEntries(profiles.flatMap(p => {
    const t = (tunes as Tunes)[p.id]
    const valid = activeTune(p, t, typeof t?.net === 'string' ? t.net : undefined, now)
    return valid ? [[p.id, valid]] : []
  }))
}

/** Apply only a successful result, measured for this exact profile/network while the original failed. */
export function provenTune(result: TuneResult | undefined, p: Profile, net: string | undefined, label: string, now: number): TuneVariant | undefined {
  if (!result || !net || p.revoked || result.id !== p.id || result.net !== net || result.sig !== profileSig(p) || !fresh(result.at, now, TUNE_RESULT_TTL_MS)) return undefined
  const base = result.results.find(r => r.label === '')
  const measured = result.results.find(r => r.label === label)
  if (!base || base.ms !== null || !measured || measured.ms === null || !Number.isFinite(measured.ms) || measured.ms < 0) return undefined
  return variants(p).find(v => v.label === label)
}
