import { randomBytes } from 'node:crypto'
import type { Profile } from '../shared/types'
import { profileSig } from './tune'

export const DIAGNOSIS_TTL_MS = 5 * 60_000
export interface DiagnosisProof {
  token: string
  host: string
  net: string
  at: number
  context: string
  profiles: Record<string, string>
}

/** A result is a short-lived capability for the exact personal paths actually measured. */
export function diagnosisProof(host: string, paths: Record<string, number | null>, profiles: Profile[], net: string | undefined, at: number, context: string): DiagnosisProof | undefined {
  if (!net) return undefined
  const checked = profiles.filter(p => !p.revoked && p.source !== 'public' && typeof paths[p.id] === 'number' && Number.isFinite(paths[p.id]) && paths[p.id]! >= 0)
  if (!checked.length) return undefined
  return { token: randomBytes(16).toString('hex'), host, net, at, context, profiles: Object.fromEntries(checked.map(p => [p.id, profileSig(p)])) }
}

/** Renderer input never supplies the target or a replacement profile for an old result. */
export function diagnosisCurrent(proof: DiagnosisProof | undefined, token: unknown, via: unknown, profiles: Profile[], net: string | undefined, now: number, context: string): proof is DiagnosisProof {
  if (!proof || typeof token !== 'string' || token !== proof.token || typeof via !== 'string' || !net || net !== proof.net || context !== proof.context || now < proof.at || now - proof.at >= DIAGNOSIS_TTL_MS) return false
  const p = profiles.find(p => p.id === via && !p.revoked && p.source !== 'public')
  return !!p && proof.profiles[via] === profileSig(p)
}
