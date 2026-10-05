import type { AwgProfile, Group, Profile, Route, Settings, Via } from '../shared/types'
import { PRESETS } from '../shared/presets'
import { validateCustom } from '../shared/route-validation'

export interface Bounds { x: number; y: number; width: number; height: number; max?: boolean }
export interface Disk { settings: Settings; profiles: string[]; bounds?: Bounds }

export const DEFAULTS: Settings = {
  rest: 'direct',
  groups: [],
  routes: [],
  ruDirect: true,
  dnsAll: false,
  lanDirect: true,
  tray: true,
  autoConnect: false,
  autostart: false,
  notify: true
}

export function migrate(raw: any, firstProfile?: string): Settings {
  if (Array.isArray(raw?.routes)) {
    const via = (v: unknown): v is Via => typeof v === 'string' && v.length > 0 && v.length <= 80 && /^[\w:.-]+$/.test(v)
    const route = (r: any): r is Route => {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 400 || typeof r.name !== 'string' || r.name.length > 200 || !via(r.via) || typeof r.on !== 'boolean' || (r.fallback !== undefined && !via(r.fallback))) return false
      if (r.kind === 'app') return typeof r.exe === 'string' && /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\).+\.exe$/i.test(r.exe)
      if (r.kind === 'preset') return typeof r.preset === 'string' && PRESETS.some(p => p.id === r.preset)
      if (r.kind === 'custom') return typeof r.value === 'string' && !validateCustom(r.value)
      return false
    }
    // The persisted file is data, not a trusted IPC peer. Apply the same semantic limits as live patches.
    const unique = <T extends { id: string }>(items: T[]): T[] => { const seen = new Set<string>(); return items.filter(x => !seen.has(x.id) && !!seen.add(x.id)) }
    const routes = unique<Route>(raw.routes.slice(0, 500).filter(route) as Route[]).map(r => r.kind === 'app' && r.matchDir && r.wholeDir === undefined ? { ...r, wholeDir: true } : r)
    const groups = Array.isArray(raw.groups) ? unique<Group>(raw.groups.slice(0, 50).filter((g: any) => g && typeof g.id === 'string' && g.id.startsWith('g-') && via(g.id) && typeof g.name === 'string' && g.name.length <= 60 && ['fastest', 'first'].includes(g.policy) && Array.isArray(g.members) && g.members.length > 0 && g.members.length <= 32 && g.members.every((m: unknown) => via(m) && m !== 'direct' && !m.startsWith('g-'))).map((g: any): Group => ({ id: g.id, name: g.name, policy: g.policy, members: [...new Set(g.members)] as string[] }))) : []
    return {
      ...DEFAULTS,
      rest: via(raw.rest) ? raw.rest : 'direct',
      allVia: raw.allVia === undefined || via(raw.allVia) ? raw.allVia : undefined,
      groups,
      routes,
      ruDirect: typeof raw.ruDirect === 'boolean' ? raw.ruDirect : DEFAULTS.ruDirect,
      dnsAll: typeof raw.dnsAll === 'boolean' ? raw.dnsAll : DEFAULTS.dnsAll,
      lanDirect: typeof raw.lanDirect === 'boolean' ? raw.lanDirect : DEFAULTS.lanDirect,
      tray: typeof raw.tray === 'boolean' ? raw.tray : DEFAULTS.tray,
      autoConnect: typeof raw.autoConnect === 'boolean' ? raw.autoConnect : DEFAULTS.autoConnect,
      autostart: typeof raw.autostart === 'boolean' ? raw.autostart : DEFAULTS.autostart,
      notify: typeof raw.notify === 'boolean' ? raw.notify : DEFAULTS.notify
    }
  }
  const only = (raw?.mode ?? 'only') === 'only'
  const server = raw?.profileId ?? firstProfile ?? 'direct'
  const via = only ? server : 'direct'
  const routes: Route[] = [
    ...(raw?.apps ?? []).map((a: any) => ({ id: 'app:' + a.id, kind: 'app', name: a.name, exe: a.exe, matchDir: a.matchDir, wholeDir: !!a.matchDir, via, on: true })),
    ...(raw?.presets ?? []).map((p: any) => ({ id: 'preset:' + p, kind: 'preset', name: p, preset: p, via: server, on: true })),
    ...(raw?.custom ?? []).map((c: any) => ({ id: 'custom:' + c, kind: 'custom', name: c, value: c, via: server, on: true }))
  ]
  return { ...DEFAULTS, rest: only ? 'direct' : server, routes, dnsAll: !!raw?.dnsAll, tray: raw?.tray ?? true, autoConnect: !!raw?.autoConnect }
}

export function normalizeProfile(p: Profile): Profile {
  const value = p.kind ? p : { ...(p as AwgProfile), kind: 'awg' as const }
  const base = value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 80 && typeof value.name === 'string' && value.name.length <= 80 && typeof value.addedAt === 'number'
  if (!base) throw new Error('Invalid stored profile')
  if (value.kind === 'awg') {
    if (!Array.isArray(value.address) || typeof value.privateKey !== 'string' || !value.peer || typeof value.peer.host !== 'string' || !Number.isInteger(value.peer.port) || value.peer.port < 1 || value.peer.port > 65535) throw new Error('Invalid stored WireGuard profile')
  } else if (value.kind === 'vless') {
    if (!value.vless || typeof value.vless.server !== 'string' || !Number.isInteger(value.vless.port) || value.vless.port < 1 || value.vless.port > 65535 || typeof value.vless.uuid !== 'string') throw new Error('Invalid stored VLESS profile')
  } else if (value.kind === 'out') {
    const allowed = new Set(['vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic'])
    if (typeof value.host !== 'string' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !value.outbound || typeof value.outbound !== 'object' || !allowed.has(String(value.outbound.type)) || value.outbound.server !== value.host || value.outbound.server_port !== value.port) throw new Error('Invalid stored outbound profile')
  } else if (value.kind === 'openvpn') {
    if (typeof value.host !== 'string' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !value.endpoint || value.endpoint.type !== 'openvpn-client') throw new Error('Invalid stored OpenVPN profile')
  } else throw new Error('Unknown stored profile kind')
  return value
}

export function readDisk(raw: string, open: (sealed: string) => string): { profiles: Profile[]; settings: Settings; bounds?: Bounds } {
  const d = JSON.parse(raw) as Disk
  const profiles = (d.profiles ?? []).map(s => normalizeProfile(JSON.parse(open(s)) as Profile))
  return { profiles, settings: migrate(d.settings, profiles[0]?.id), bounds: d.bounds }
}

/** a tunnel or group is gone (C03): its cards get the chosen replacement, or keep pointing at the
 *  missing id -> the config compiles that to BLOCK (never silently direct). A fallback to it is cleared. */
function dropVia(s: Settings, id: string, replace?: Via): Settings {
  const to = (v: Via) => (v === id && replace ? replace : v)
  return {
    ...s,
    rest: to(s.rest),
    routes: s.routes.map(r => {
      const { fallback, ...rest } = r
      const keep = fallback && fallback !== id ? { fallback } : {}
      return { ...rest, via: to(r.via), ...keep }
    }),
    allVia: s.allVia === id ? (replace && replace !== 'direct' ? replace : undefined) : s.allVia
  }
}

/** cards / "rest" that use this tunnel or group: shown before deleting it */
export function usersOf(s: Settings, id: string): { cards: string[]; rest: boolean; all: boolean } {
  return { cards: s.routes.filter(r => r.via === id || r.fallback === id).map(r => r.name), rest: s.rest === id, all: s.allVia === id }
}

/** a tunnel is removed: it leaves every group, a group left without members is removed too */
export function dropServer(s: Settings, id: string, replace?: Via): Settings {
  const groups = (s.groups ?? []).map(g => ({ ...g, members: g.members.filter(m => m !== id) }))
  let out: Settings = { ...dropVia(s, id, replace), groups: groups.filter(g => g.members.length > 0) }
  for (const g of groups.filter(g => g.members.length === 0)) out = dropVia(out, g.id, replace)
  return out
}

export function dropGroup(s: Settings, id: string, replace?: Via): Settings {
  return { ...dropVia(s, id, replace), groups: (s.groups ?? []).filter(g => g.id !== id) }
}
