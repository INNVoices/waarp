import type { AppInfo, Conn, ProfileView, Route, Settings, Via } from '../../../shared/types'
import { PRESETS } from '../../../shared/presets'

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

const host = (h: string) => h.toLowerCase().replace(/\.$/, '')

export function connsOf(r: Route, conns: Conn[]): Conn[] {
  if (r.kind === 'app' && r.exe) {
    const exe = r.exe.toLowerCase()
    const dir = r.wholeDir === false ? undefined : r.matchDir?.toLowerCase()
    return conns.filter(c => c.exe && (c.exe.toLowerCase() === exe || (dir && c.exe.toLowerCase().startsWith(dir + '\\'))))
  }
  const doms = r.kind === 'preset' ? PRESETS.find(p => p.id === r.preset)?.domains ?? [] : [r.value ?? '']
  return conns.filter(c => { const h = host(c.host); return doms.some(d => d && (h === d || h.endsWith('.' + d))) })
}

export function connRoute(c: Conn, routes: Route[]): Route | undefined {
  const on = routes.filter(r => r.on)
  return on.find(r => r.kind !== 'app' && connsOf(r, [c]).length) ?? on.find(r => r.kind === 'app' && connsOf(r, [c]).length)
}
