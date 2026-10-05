/** Browser/main-safe validation for user-entered domain and network selectors. */
export function validateCustom(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!v) return 'Пусто'
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v)) {
    const [ip, bits] = v.split('/')
    if (ip.split('.').some(o => Number(o) > 255)) return 'Неверный IP'
    if (bits && Number(bits) > 32) return 'Маска больше 32'
    return null
  }
  if (v.includes(':')) {
    const slash = v.lastIndexOf('/')
    const ip = slash >= 0 ? v.slice(0, slash) : v
    const bits = slash >= 0 ? v.slice(slash + 1) : undefined
    try {
      const parsed = new URL(`http://[${ip}]/`)
      if (!parsed.hostname.includes(':')) return 'Неверный IPv6'
    } catch { return 'Неверный IPv6' }
    if (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > 128)) return 'Маска IPv6 больше 128'
    return null
  }
  if (/^(\*\.)?([a-z0-9а-яё-]+\.)+[a-zа-яё0-9-]{2,}$/i.test(v)) return null
  return 'Нужен домен (example.com) или IP/подсеть (1.2.3.0/24)'
}
