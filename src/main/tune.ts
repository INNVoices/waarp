import { createHash } from 'node:crypto'
import type { Profile } from '../shared/types'

export type TunePatch = { fp?: string; recordFragment?: boolean; jc?: number; jmin?: number; jmax?: number; mtu?: number }
export interface TuneVariant { label: string; patch: TunePatch }
export interface TuneEntry { net: string; sig: string; label: string; patch: TunePatch; at: number }
export type Tunes = Record<string, TuneEntry>

export const TUNE_TTL_MS = 14 * 24 * 3600_000
export const TUNE_MAX_VARIANTS = 6
const FPS = ['firefox', 'chrome', 'safari']

export const profileSig = (p: Profile) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16)

const tlsOf = (p: Profile): { fp?: string } | undefined => {
  if (p.kind === 'vless') return p.vless.security === 'none' ? undefined : { fp: p.vless.fp }
  if (p.kind === 'out') { const t = (p.outbound as { tls?: { enabled?: boolean; utls?: { fingerprint?: string } } }).tls; return t?.enabled ? { fp: t.utls?.fingerprint } : undefined }
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
    if (!o.tls?.enabled) return p
    const tls = { ...o.tls, ...(t.recordFragment ? { record_fragment: true } : {}), ...(t.fp ? { utls: { enabled: true, fingerprint: t.fp } } : {}) }
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
    const t = tunes[p.id]
    return t && t.net === net && t.sig === profileSig(p) && now - t.at < TUNE_TTL_MS ? applyTune(p, t.patch) : p
  })
}

export function pruneTunes(tunes: Tunes, profiles: Profile[], now: number): Tunes {
  const sig = new Map(profiles.map(p => [p.id, profileSig(p)]))
  return Object.fromEntries(Object.entries(tunes).filter(([id, t]) => sig.get(id) === t.sig && now - t.at < TUNE_TTL_MS))
}
