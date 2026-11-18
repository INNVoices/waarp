import { randomBytes } from 'node:crypto'
import type { Profile, Route, Settings } from '../shared/types'
import { profileSig } from './tune'
import { selectVia } from './apply'
import { routeEvidenceSignature } from '../shared/connection-quality'
import { autoMembers } from '../shared/groups'

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

/** Compare a card's actual path first. Public paths are measured only when the
 * card already uses that loaded outbound; they never enter the alternative pool. */
export function diagnosisPaths(profiles: readonly Profile[], current: string | undefined,
  candidates: readonly string[], limit: number, loaded?: readonly string[]): string[] {
  const usable = profiles.filter(p => !p.revoked && !('subMissing' in p && p.subMissing))
  const own = new Set(autoMembers(usable))
  const selected = usable.find(p => p.id === current)
  const primary = current === 'direct' || (current && (own.has(current) ||
    selected?.source === 'public' && loaded?.includes(current))) ? current : undefined
  return [...new Set([...(primary ? [primary] : []), ...candidates.filter(id => own.has(id))])].slice(0, limit)
}

/** Main-owned identity before the asynchronous physical-network read. Never log this key. */
export function diagnosisRequestScope(target: string, context: string, profiles: readonly Profile[], route?: Route): string {
  return JSON.stringify([target, context, route ? diagnosisRouteSignature(route) : null, profiles.map(p => [p.id, profileSig(p)])])
}

interface DiagnosisFlight<T> {
  net: string | undefined
  result: Promise<T | null>
  /** Only subscribers already admitted before completion may receive the completed operation. */
  completedThrough?: number
}

/** Shares the existing diagnosis owner, not a new scheduler or persistent result cache. */
export class DiagnosisRequests<T> {
  private scope?: string
  private generation = 0
  private requested = 0
  private accepted = 0
  private flight?: DiagnosisFlight<T>
  private reads = new Set<AbortController>()
  private sessionIds = new WeakMap<object, number>()
  private nextSession = 0

  constructor(private stop: () => Promise<boolean>) {}

  /** Engine tokens are opaque ChildProcess objects or OFF generations; never serialize a child. */
  sessionKey(token: object | number): string {
    if (typeof token === 'number') return 'off:' + token
    let id = this.sessionIds.get(token)
    if (id === undefined) { id = ++this.nextSession; this.sessionIds.set(token, id) }
    return 'on:' + id
  }

  cancel(): Promise<boolean> {
    this.generation++
    this.scope = undefined
    this.flight = undefined
    for (const read of this.reads) read.abort()
    this.reads.clear()
    return this.stop()
  }

  async request(scope: string, readNetwork: (signal: AbortSignal) => Promise<string | undefined>,
    current: () => boolean, measure: (net: string | undefined) => Promise<T | null>): Promise<T | null> {
    // A changed target/card/runtime cancels immediately, even while its new fingerprint is being read.
    if (this.scope !== scope) { void this.cancel(); this.scope = scope }
    const generation = this.generation, request = ++this.requested, read = new AbortController()
    this.reads.add(read)
    let net: string | undefined
    try { net = await readNetwork(read.signal) }
    finally { this.reads.delete(read) }
    if (read.signal.aborted || generation !== this.generation || !current()) return null
    const prior = this.flight
    // An unknown network is not a shared bucket. Its ordinary diagnostic may still run without an apply proof.
    if (net && prior?.net === net && (prior.completedThrough === undefined || request <= prior.completedThrough)) {
      this.accepted = Math.max(this.accepted, request)
      return prior.result
    }
    // A slower fingerprint from an older request cannot displace a newer network's measurement.
    if (request < this.accepted) return null
    this.accepted = request
    const stopped = this.stop()
    const flight: DiagnosisFlight<T> = { net, result: Promise.resolve(null) }
    this.flight = flight
    const owns = () => this.flight === flight && generation === this.generation && current()
    flight.result = (async () => {
      await stopped
      if (!owns()) return null
      const result = await measure(net)
      return owns() ? result : null
    })().finally(() => { flight.completedThrough = this.requested })
    return flight.result
  }
}

/** A result is a short-lived capability for the exact personal paths actually measured. */
export function diagnosisProof(host: string, paths: Record<string, number | null>, profiles: Profile[], net: string | undefined, at: number, context: string, route?: Route): DiagnosisProof | undefined {
  if (!net) return undefined
  const checked = profiles.filter(p => !p.revoked && !('subMissing' in p && p.subMissing) && p.source !== 'public' && typeof paths[p.id] === 'number' && Number.isFinite(paths[p.id]) && paths[p.id]! >= 0)
  if (!checked.length) return undefined
  return { token: randomBytes(16).toString('hex'), host, net, at, context, profiles: Object.fromEntries(checked.map(p => [p.id, profileSig(p)])),
    ...(route ? { route: { id: route.id, signature: diagnosisRouteSignature(route) } } : {}) }
}

/** Renderer input never supplies the target or a replacement profile for an old result. */
export function diagnosisCurrent(proof: DiagnosisProof | undefined, token: unknown, via: unknown, profiles: Profile[], net: string | undefined, now: number, context: string, routes?: readonly Route[]): proof is DiagnosisProof {
  if (!proof || typeof token !== 'string' || token !== proof.token || typeof via !== 'string' || !net || net !== proof.net || context !== proof.context || now < proof.at || now - proof.at >= DIAGNOSIS_TTL_MS) return false
  const p = profiles.find(p => p.id === via && !p.revoked && !('subMissing' in p && p.subMissing) && p.source !== 'public')
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
