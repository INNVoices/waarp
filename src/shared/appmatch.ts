import type { Conn, Route } from './types'
import { PRESETS } from './presets'

const MSIX = /^[a-z]:\\program files\\windowsapps\\([^\\_]+)_[^\\]*__([a-z0-9]+)\\(.+)$/i

export const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface AppPatterns { exact: string[]; regex: string[] }

export function appPatterns(r: Pick<Route, 'exe' | 'matchDir' | 'wholeDir'>): AppPatterns {
  const exe = r.exe ?? ''
  const m = MSIX.exec(exe)
  if (m) {
    const [, name, pub, rest] = m
    const pkg = '^[a-z]:\\\\program files\\\\windowsapps\\\\' + reEsc(name) + '_[^\\\\]*__' + reEsc(pub) + '\\\\'
    if (r.wholeDir !== true) return { exact: [], regex: [pkg + reEsc(rest) + '$'] }
    const dot = name.indexOf('.')
    const local = dot > 0 && dot < name.length - 1 ? ['^[a-z]:\\\\users\\\\[^\\\\]+\\\\appdata\\\\local\\\\' + reEsc(name.slice(0, dot)) + '\\\\' + reEsc(name.slice(dot + 1)) + '\\\\'] : []
    return { exact: [], regex: [pkg, ...local] }
  }
  if (r.wholeDir === true && r.matchDir) return { exact: [], regex: ['^' + reEsc(r.matchDir) + '\\\\'] }
  return { exact: exe ? [exe] : [], regex: [] }
}

export function appKey(r: Pick<Route, 'exe'>): string {
  const exe = r.exe ?? ''
  const m = MSIX.exec(exe)
  return (m ? 'msix:' + m[1] + '__' + m[2] + '\\' + m[3] : exe).toLowerCase()
}

export function exeHits(p: AppPatterns, exe: string): boolean {
  if (!exe) return false
  const e = exe.toLowerCase()
  return p.exact.some(x => x.toLowerCase() === e) || p.regex.some(x => new RegExp(x, 'i').test(exe))
}

const host = (h: string) => h.toLowerCase().replace(/\.$/, '')

export function routeHits(r: Route, c: Pick<Conn, 'exe' | 'host'>): boolean {
  if (r.kind === 'app') return !!r.exe && exeHits(appPatterns(r), c.exe)
  if (r.kind === 'list') return false
  const doms = r.kind === 'preset' ? PRESETS.find(p => p.id === r.preset)?.domains ?? [] : [r.value ?? '']
  const h = host(c.host)
  return doms.some(d => d && (h === d || h.endsWith('.' + d)))
}

export function dedupeApps(routes: Route[]): Route[] {
  const first = new Map<string, number>()
  const out: Route[] = []
  for (const r of routes) {
    if (r.kind !== 'app' || !r.exe || !MSIX.test(r.exe)) { out.push(r); continue }
    const k = appKey(r)
    const at = first.get(k)
    if (at === undefined) { first.set(k, out.length); out.push(r); continue }
    out[at] = { ...out[at], exe: r.exe, matchDir: r.matchDir }
  }
  return out
}
