import { isIP } from 'node:net'
import type { Profile, Settings } from '../shared/types'

/** Warm only a bounded set of private, lazy paths. No public catalog sweep or eager OpenVPN sessions. */
export const WARM_PROFILES = 64, WARM_ENDPOINTS = 16
export function runtimePreload(profiles: Profile[], settings: Settings, required: readonly string[]): string[] {
  const requiredSet = new Set(required)
  const result = new Set(required)
  const refs = new Set([settings.rest, settings.serviceVia ?? '', ...settings.routes.flatMap(r => [r.via, r.fallback ?? '']),
    ...settings.groups.flatMap(g => g.members)])
  const usable = profiles.filter(p => !p.revoked && !(p as { subMissing?: boolean }).subMissing)
  const wgKeys = new Set(usable.filter(p => requiredSet.has(p.id) && p.kind === 'awg')
    .map(p => p.kind === 'awg' ? p.privateKey + ':' + p.peer.publicKey : ''))
  let endpoints = usable.filter(p => requiredSet.has(p.id) && (p.kind === 'awg' || p.kind === 'openvpn')).length
  for (const p of [...usable.filter(p => refs.has(p.id)), ...usable]) {
    if (result.has(p.id) || result.size >= WARM_PROFILES || p.source === 'public' || p.kind === 'openvpn') continue
    if (p.kind === 'awg') {
      const identity = p.privateKey + ':' + p.peer.publicKey
      // DNS/bootstrap and an explicitly configured keepalive can wake an unused peer.
      // Those endpoints are loaded only when actually requested, not as hidden background work.
      if (!isIP(p.peer.host) || (p.peer.keepalive ?? 0) > 0 || endpoints >= WARM_ENDPOINTS || wgKeys.has(identity)) continue
      endpoints++; wgKeys.add(identity)
    }
    result.add(p.id)
  }
  return [...result]
}
