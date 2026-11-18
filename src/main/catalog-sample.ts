/** Preserve each source's order while sharing a bounded check budget across sources and protocols. */
export function roundRobin<T>(groups: readonly (readonly T[])[]): T[] {
  const out: T[] = []
  const offset = groups.map(() => 0)
  let left = groups.reduce((n, g) => n + g.length, 0)
  while (left > 0) {
    for (let i = 0; i < groups.length; i++) {
      if (offset[i] >= groups[i].length) continue
      out.push(groups[i][offset[i]++]); left--
    }
  }
  return out
}

/** Pick independent hosts before repeating one endpoint, then prefer a new
 * protocol/source. Input order breaks ties (usually measured latency). These
 * are observable failure domains, not a claim that hostnames imply unique ASNs. */
export function diverseSample<T>(items: readonly T[], limit: number,
  identity: (item: T) => { host: string; protocol: string; source: string }): T[] {
  const remaining = items.map(item => ({ item, keys: identity(item) }))
  const hosts = new Set<string>(), protocols = new Set<string>(), sources = new Set<string>()
  const out: T[] = []
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  while (out.length < maximum && remaining.length) {
    let selected = 0, best = -1
    for (let index = 0; index < remaining.length; index++) {
      const { host, protocol, source } = remaining[index].keys
      const score = (hosts.has(host) ? 0 : 4) + (protocols.has(protocol) ? 0 : 2) + (sources.has(source) ? 0 : 1)
      if (score > best) { selected = index; best = score }
    }
    const { item, keys } = remaining.splice(selected, 1)[0]
    out.push(item); hosts.add(keys.host); protocols.add(keys.protocol); sources.add(keys.source)
  }
  return out
}

/** Keep a real node name; replace a source credit that is not useful after import. */
export function catalogLabel(name: string, country: string, host: string): string {
  const clean = name.trim()
  if (clean && !/^(?:by\s+ebrasha|ebrasha)(?:\s*[-#|]\s*\d+)?$/i.test(clean)) return clean.slice(0, 100)
  return (country === '??' ? host : `${country} · ${host}`).slice(0, 100)
}

/** Short, stable provenance shown next to every public node. */
export function sourceLabel(url: string): string {
  if (url.includes('vpngate.net')) return 'VPN Gate'
  if (url.includes('awesome-vpn')) return 'Awesome VPN'
  if (url.includes('mrdevmohamed')) return 'V2Ray Configs'
  if (url.includes('Epodonios')) return 'Epodonios'
  if (url.includes('igareck')) return 'Russia checked'
  try { return new URL(url).hostname } catch { return 'Источник' }
}
