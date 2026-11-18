import type { Route } from './types'
import type { DirectObs, Finding, PathObs } from './evidence'
import { PRESETS } from './presets'

/** A task describes the evidence we still need. It never changes a transport by itself. */
export const CONNECTION_USES = ['general', 'web', 'interactive', 'game'] as const
export type ConnectionUse = typeof CONNECTION_USES[number]
export const isConnectionUse = (value: unknown): value is ConnectionUse => CONNECTION_USES.includes(value as ConnectionUse)
export const connectionUse = (value: unknown): ConnectionUse => isConnectionUse(value) ? value : 'general'

export function routeEvidenceSignature(route: Route): string {
  return JSON.stringify([route.id, route.kind, route.exe, route.matchDir, route.wholeDir, route.preset,
    route.value, route.list, route.owner, route.on, route.via, route.fallback, route.dpi, route.connectionUse ?? 'general'])
}

export interface PathCheckSummary {
  attempted: number
  responded: number
  noResponse: number
  /** HTTP probe timing; neither application latency nor packet RTT. */
  medianMs?: number
  spreadMs?: number
}

export interface DiagnosisScope {
  routeId: string
  routeName: string
  connectionUse: ConnectionUse
  selectedVia: string
  effectiveVia?: string
}

export interface ConnectionAssessment {
  current: 'responded' | 'failed' | 'not-checked'
  reason: 'current-responded' | 'alternative-responded' | 'incomplete' | 'no-alternative'
  recommendedVia?: string
  /** These are coverage descriptions, not a score inferred from one HTTP request. */
  coverage: 'http-response'
  applicationVerified: false
  missing: ('udp-response' | 'packet-loss' | 'jitter' | 'application-session')[]
}

export interface DiagnosisResult {
  target: string
  host: string
  direct: DirectObs
  paths: PathObs
  finding: Finding
  at: number
  stale?: boolean
  token?: string
  scope?: DiagnosisScope
  samples?: Record<string, PathCheckSummary>
  assessment?: ConnectionAssessment
  /** Layered system sockets can follow an existing OS VPN; they are not proof of a native Direct outbound. */
  systemPath?: true
}

const timing = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Omitted/cancelled checks do not become failed attempts. */
export function summarizeChecks(rounds: readonly PathObs[]): Record<string, PathCheckSummary> {
  const values = new Map<string, (number | null)[]>()
  for (const round of rounds) for (const [id, value] of Object.entries(round)) {
    if (value !== null && !timing(value)) continue
    const samples = values.get(id) ?? []
    samples.push(value); values.set(id, samples)
  }
  return Object.fromEntries([...values].map(([id, values]) => {
    const good = values.filter(timing).sort((a, b) => a - b)
    const middle = Math.floor(good.length / 2)
    return [id, { attempted: values.length, responded: good.length, noResponse: values.length - good.length,
      ...(good.length ? { medianMs: Math.round(good.length % 2 ? good[middle] : (good[middle - 1] + good[middle]) / 2), spreadMs: good.at(-1)! - good[0] } : {}) }]
  }))
}

export function summarizedPaths(samples: Record<string, PathCheckSummary>): PathObs {
  return Object.fromEntries(Object.entries(samples).filter(([, sample]) => sample.attempted > 0)
    .map(([id, sample]) => [id, sample.responded > 0 && timing(sample.medianMs) ? sample.medianMs : null]))
}

/** Preserve a responding current path. A lower one-off timing is not evidence to move an application. */
export function assessConnection(use: ConnectionUse, currentVia: string | undefined, samples: Record<string, PathCheckSummary>, candidates: readonly string[]): ConnectionAssessment {
  const current = currentVia ? samples[currentVia] : undefined
  const missing: ConnectionAssessment['missing'] = use === 'interactive' || use === 'game'
    ? ['udp-response', 'packet-loss', 'jitter', 'application-session'] : ['application-session']
  const base = { coverage: 'http-response' as const, applicationVerified: false as const, missing }
  if (current?.responded) return { ...base, current: 'responded', reason: 'current-responded' }
  if (!current || current.attempted < 2) return { ...base, current: 'not-checked', reason: 'incomplete' }
  const good = candidates.filter(id => id !== currentVia && samples[id]?.attempted >= 2 && samples[id].responded === samples[id].attempted)
  // Preserve the trusted candidate order. Sorting a tiny sample by a few milliseconds creates false certainty.
  return good.length ? { ...base, current: 'failed', reason: 'alternative-responded', recommendedVia: good[0] }
    : { ...base, current: 'failed', reason: 'no-alternative' }
}

/** Only explicit route addresses and existing curated presets suggest a test target. Process names are not domains. */
export function suggestedProbeTarget(route: Route | undefined): string {
  if (!route) return ''
  if (route.kind === 'preset') return PRESETS.find(p => p.id === route.preset)?.domains[0] ?? ''
  if (route.kind !== 'custom' || !route.value || route.value.includes('/') || route.value.startsWith('*.')) return ''
  return route.value.includes(':') ? `[${route.value}]` : route.value
}
