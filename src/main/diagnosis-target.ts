import { BlockList, isIP } from 'node:net'
import type { Route, Settings } from '../shared/types'
import { PRIVATE, RU_DIRECT, routeTargets } from './awg'

const suffix = (host: string, domain: string) => host === domain || host.endsWith('.' + domain)
const inNetworks = (host: string, cidrs: readonly string[]) => {
  const family = isIP(host)
  if (!family) return false
  const list = new BlockList()
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/')
    if (isIP(address) !== family) continue
    try { list.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6') } catch { /* invalid saved input is not a match */ }
  }
  return list.check(host, family === 4 ? 'ipv4' : 'ipv6')
}

/** A domain investigation has no application identity. Match the existing
 * domain/list rule order and global bypasses, without guessing process rules. */
export function diagnosisTarget(host: string, settings: Settings): { route?: Route; via: string } {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (settings.lanDirect && inNetworks(normalized, PRIVATE) || settings.ruDirect && RU_DIRECT.some(domain => suffix(normalized, domain))) return { via: 'direct' }
  const route = settings.routes.find(route => {
    if (!route.on || route.kind === 'app') return false
    const targets = routeTargets(route)
    return targets.domains.some(domain => suffix(normalized, domain)) || inNetworks(normalized, targets.cidrs)
  })
  return { ...(route ? { route } : {}), via: route?.via ?? settings.rest }
}
