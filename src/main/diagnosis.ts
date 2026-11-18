import { randomBytes } from 'node:crypto'
import type { Profile, Route, Settings } from '../shared/types'
import { profileSig } from './tune'
import { selectVia } from './apply'
import { routeEvidenceSignature } from '../shared/connection-quality'

export const DIAGNOSIS_TTL_MS = 5 * 60_000
export interface DiagnosisProof {
  token: string
  host: string
  net: string
  at: number
  context: string
  profiles: Record<string, string>
  route?: { id: string; signature: string }
}

/** Match and policy are Main-owned. A changed/removed/replaced card invalidates its old result. */
export function diagnosisRouteSignature(route: Route): string {
  return routeEvidenceSignature(route)
}

/** A result is a short-lived capability for the exact personal paths actually measured. */
export function diagnosisProof(host: string, paths: Record<string, number | null>, profiles: Profile[], net: string | undefined, at: number, context: string, route?: Route): DiagnosisProof | undefined {
  if (!net) return undefined
  const checked = profiles.filter(p => !p.revoked && p.source !== 'public' && typeof paths[p.id] === 'number' && Number.isFinite(paths[p.id]) && paths[p.id]! >= 0)
  if (!checked.length) return undefined
  return { token: randomBytes(16).toString('hex'), host, net, at, context, profiles: Object.fromEntries(checked.map(p => [p.id, profileSig(p)])),
    ...(route ? { route: { id: route.id, signature: diagnosisRouteSignature(route) } } : {}) }
}

/** Renderer input never supplies the target or a replacement profile for an old result. */
export function diagnosisCurrent(proof: DiagnosisProof | undefined, token: unknown, via: unknown, profiles: Profile[], net: string | undefined, now: number, context: string, routes?: readonly Route[]): proof is DiagnosisProof {
  if (!proof || typeof token !== 'string' || token !== proof.token || typeof via !== 'string' || !net || net !== proof.net || context !== proof.context || now < proof.at || now - proof.at >= DIAGNOSIS_TTL_MS) return false
  const p = profiles.find(p => p.id === via && !p.revoked && p.source !== 'public')
  if (proof.route) {
    const route = routes?.find(r => r.id === proof.route!.id)
    if (!route || diagnosisRouteSignature(route) !== proof.route.signature) return false
  }
  return !!p && proof.profiles[via] === profileSig(p)
}

/** The destination is taken only from the trusted proof, never from renderer apply arguments. */
export function diagnosisSettings(proof: DiagnosisProof, via: string, settings: Settings): Settings | undefined {
  if (proof.route) {
    const at = settings.routes.findIndex(r => r.id === proof.route!.id)
    if (at < 0 || diagnosisRouteSignature(settings.routes[at]) !== proof.route.signature) return undefined
    return selectVia(settings, at, via)
  }
  const old = settings.routes.find(r => r.kind === 'custom' && r.value === proof.host)
  const route: Route = old ? { ...old, via, on: true, fallback: undefined }
    : { id: 'custom:' + proof.host, kind: 'custom', name: proof.host.slice(0, 80), value: proof.host, via, on: true }
  return { ...settings, routes: old ? settings.routes.map(r => r.id === old.id ? route : r) : [...settings.routes, route] }
}
