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
  return new URL(url).hostname
}
