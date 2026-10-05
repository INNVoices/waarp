// C09: types are not an IPC boundary. Main validates every settings patch from the renderer by shape and
// drops anything unknown or malformed (the renderer can never inject raw engine config or odd values).
import type { Group, Route, Settings, Via } from '../shared/types'
import { validateCustom } from '../shared/route-validation'
import { PRESETS } from '../shared/presets'
import { reservedOk } from '../shared/companion'

const str = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length <= max
const via = (v: unknown): v is Via => str(v, 80) && /^[\w:.-]+$/.test(v)
const bool = (v: unknown): v is boolean => typeof v === 'boolean'

function route(r: any): Route | null {
  if (!r || typeof r !== 'object' || !str(r.id, 400) || !str(r.name, 200) || !via(r.via) || !bool(r.on)) return null
  if (!['app', 'preset', 'custom'].includes(r.kind)) return null
  const out: any = { id: r.id, kind: r.kind, name: r.name, via: r.via, on: r.on }
  for (const k of ['exe', 'matchDir', 'preset', 'value', 'icon'] as const) if (r[k] !== undefined) {
    if (!str(r[k], k === 'icon' ? 200000 : 1000)) return null
    if (k === 'icon' && r[k] !== '' && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r[k])) return null
    out[k] = r[k]
  }
  if (r.wholeDir !== undefined) { if (!bool(r.wholeDir)) return null; out.wholeDir = r.wholeDir }
  if (r.fallback !== undefined) { if (!via(r.fallback)) return null; out.fallback = r.fallback }
  if (r.owner !== undefined) { if (r.owner !== 'companion') return null; out.owner = r.owner }
  // a reserved ext: id or an owner must be a well-formed companion route; main checks it against the stored one
  if (!reservedOk(out)) return null
  if (r.kind === 'custom' && (typeof out.value !== 'string' || validateCustom(out.value))) return null
  if (r.kind === 'preset' && (typeof out.preset !== 'string' || !PRESETS.some(p => p.id === out.preset))) return null
  if (r.kind === 'app' && (typeof out.exe !== 'string' || !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\).+\.exe$/i.test(out.exe))) return null
  return out as Route
}

function group(g: any): Group | null {
  if (!g || typeof g !== 'object' || !via(g.id) || !g.id.startsWith('g-') || g.id === 'g-auto' || !str(g.name, 60) || !['fastest', 'first'].includes(g.policy)) return null
  if (!Array.isArray(g.members) || !g.members.length || g.members.length > 32 || !g.members.every((x: unknown) => via(x) && x !== 'direct' && !x.startsWith('g-'))) return null
  return { id: g.id, name: g.name, policy: g.policy, members: [...new Set(g.members)] } as Group
}

/** the accepted part of a patch; anything that fails its check is left out */
export function cleanPatch(p: unknown): Partial<Settings> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {}
  const x = p as Record<string, unknown>
  const out: Partial<Settings> = {}
  if ('rest' in x && via(x.rest)) out.rest = x.rest
  if ('allVia' in x && (x.allVia === undefined || via(x.allVia))) out.allVia = x.allVia as Via | undefined
  for (const k of ['ruDirect', 'dnsAll', 'lanDirect', 'tray', 'autoConnect', 'autostart', 'notify'] as const) if (k in x && bool(x[k])) out[k] = x[k] as boolean
  if ('routes' in x && Array.isArray(x.routes) && x.routes.length <= 500) {
    const r = x.routes.map(route)
    if (r.every(Boolean) && new Set((r as Route[]).map(v => v.id)).size === r.length) out.routes = r as Route[]
  }
  if ('groups' in x && Array.isArray(x.groups) && x.groups.length <= 50) {
    const g = x.groups.map(group)
    if (g.every(Boolean) && new Set((g as Group[]).map(v => v.id)).size === g.length) out.groups = g as Group[]
  }
  return out
}

const SETTINGS_KEYS = new Set(['rest', 'allVia', 'ruDirect', 'dnsAll', 'lanDirect', 'tray', 'autoConnect', 'autostart', 'notify', 'routes', 'groups'])

export function checkedPatch(p: unknown): { ok: true; patch: Partial<Settings> } | { ok: false; error: string } {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'Неверный формат настроек' }
  const input = p as Record<string, unknown>
  const patch = cleanPatch(input)
  const invalid = Object.keys(input).find(k => !SETTINGS_KEYS.has(k) || !Object.prototype.hasOwnProperty.call(patch, k))
  return invalid ? { ok: false, error: `Неверное поле настроек: ${invalid}` } : { ok: true, patch }
}

export const MAX_IMPORT_BYTES = 1024 * 1024

export interface ImportRequest { text?: string; file?: boolean; clipboard?: boolean; qrToken?: string; name?: string }

/** IPC data is untrusted even when the preload declares a TypeScript type. */
export function importRequest(raw: unknown): ImportRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const x = raw as Record<string, unknown>
  if (x.text !== undefined && (!str(x.text, MAX_IMPORT_BYTES) || !x.text.trim())) return null
  if (x.name !== undefined && (!str(x.name, 80) || !x.name.trim())) return null
  if (x.file !== undefined && !bool(x.file)) return null
  if (x.clipboard !== undefined && !bool(x.clipboard)) return null
  if (x.qrToken !== undefined && (!str(x.qrToken, 64) || !/^[0-9a-f]{32}$/.test(x.qrToken))) return null
  const count = Number(x.file === true) + Number(x.clipboard === true) + Number(typeof x.text === 'string') + Number(typeof x.qrToken === 'string')
  if (count !== 1) return null
  return { text: x.text as string | undefined, name: x.name as string | undefined, file: x.file === true, clipboard: x.clipboard === true, qrToken: x.qrToken as string | undefined }
}

export function profileName(raw: unknown): string | null {
  if (!str(raw, 80)) return null
  return raw.trim().slice(0, 40) || null
}

export function probeTarget(raw: unknown): string | null {
  if (!str(raw, 200)) return null
  const value = raw.trim()
  if (!value || /[\s\\]/.test(value)) return null
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    return url.toString()
  } catch { return null }
}
