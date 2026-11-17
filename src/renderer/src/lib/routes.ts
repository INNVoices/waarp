import type { AppInfo, Conn, ProfileView, Route, Settings, Via } from '../../../shared/types'
import { PRESETS } from '../../../shared/presets'
import { routeHits } from '../../../shared/appmatch'

export const HUES = ['#d97757', '#6f9bd1', '#7cb59a', '#b39ad6', '#c9a86a', '#8fb6c4', '#c38fa8']

export const hueOf = (profiles: ProfileView[], via: Via) => {
  const i = profiles.findIndex(p => p.id === via)
  return i < 0 ? undefined : HUES[i % HUES.length]
}

export const firstServer = (profiles: ProfileView[]): Via => profiles[0]?.id ?? 'direct'

export function appRoute(a: AppInfo, via: Via): Route {
  return { id: 'app:' + a.id, kind: 'app', name: a.name, exe: a.exe, matchDir: a.matchDir, wholeDir: false, via, on: true }
}

export function presetRoute(id: string, via: Via): Route {
  const p = PRESETS.find(x => x.id === id)!
  return { id: 'preset:' + id, kind: 'preset', name: p.name, preset: id, via, on: true }
}

export function customRoute(value: string, via: Via): Route {
  return { id: 'custom:' + value, kind: 'custom', name: value, value, via, on: true }
}

export function upsert(s: Settings, r: Route): Route[] {
  const i = s.routes.findIndex(x => x.id === r.id)
  if (i < 0) return [...s.routes, r]
  const next = [...s.routes]
  next[i] = { ...next[i], ...r }
  return next
}

export const patchRoute = (s: Settings, id: string, p: Partial<Route>) => s.routes.map(r => (r.id === id ? { ...r, ...p } : r))
export const dropRoute = (s: Settings, id: string) => s.routes.filter(r => r.id !== id)

export function connsOf(r: Route, conns: Conn[]): Conn[] {
  return conns.filter(c => (c.route !== undefined ? c.route === r.id : routeHits(r, c)))
}

export function connRoute(c: Conn, routes: Route[]): Route | undefined {
  if (c.route !== undefined) return routes.find(r => r.id === c.route)
  const on = routes.filter(r => r.on)
  return on.find(r => r.kind === 'app' && routeHits(r, c)) ?? on.find(r => r.kind === 'custom' && routeHits(r, c)) ?? on.find(r => r.kind === 'preset' && routeHits(r, c))
}
