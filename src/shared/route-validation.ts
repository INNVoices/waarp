import { localized } from './localization'
/** Strict IP/CIDR validation shared with persisted profiles, with no Node dependency. */
export function validIpPrefix(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const match = /^([^/%]+)\/(\d+)$/.exec(raw)
  if (!match) return false
  const ip = match[1], bits = Number(match[2])
  if (ip.includes(':')) {
    if (!/^[0-9a-f:.]+$/i.test(ip) || bits > 128) return false
    try { return new URL(`http://[${ip}]/`).hostname.includes(':') } catch { return false }
  }
  const octets = ip.split('.')
  return bits <= 32 && octets.length === 4 && octets.every(o => /^(?:0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)
}

/** Browser/main-safe validation for user-entered domain and network selectors. */
export function validateCustom(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!v) return localized("winInline.route-validation.e4dfc491079a")
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v)) {
    const [ip, bits] = v.split('/')
    if (ip.split('.').some(o => Number(o) > 255)) return localized("winInline.route-validation.38d10c86da48")
    if (bits && Number(bits) > 32) return localized("winInline.route-validation.be1802b9d87e")
    return null
  }
  if (v.includes(':')) {
    const slash = v.lastIndexOf('/')
    const ip = slash >= 0 ? v.slice(0, slash) : v
    const bits = slash >= 0 ? v.slice(slash + 1) : undefined
    try {
      const parsed = new URL(`http://[${ip}]/`)
      if (!parsed.hostname.includes(':')) return localized("winInline.route-validation.143049e33ab6")
    } catch { return localized("winInline.route-validation.143049e33ab6") }
    if (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > 128)) return localized("winInline.route-validation.bed1cf2bdf79")
    return null
  }
  if (/^(\*\.)?([a-z0-9а-яё-]+\.)+[a-zа-яё0-9-]{2,}$/i.test(v)) return null
  return localized("winInline.route-validation.53ab6c899cd9")
}
