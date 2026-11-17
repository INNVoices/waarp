import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fetchSubscription, type FetchOpts } from './vless'

export interface ListSource { id: string; name: string; url: string; enabled: boolean; updatedAt?: number; checkedAt?: number; error?: string; domains: string[] }
export interface ListView { id: string; name: string; url: string; enabled: boolean; updatedAt?: number; checkedAt?: number; error?: string; count: number }

export const LIST_MAX = 50_000
export const LIST_BYTES = 4 * 1024 * 1024
export const LIST_SOURCES_MAX = 20
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/
export const LIST_ID = /^l-[a-z0-9]{8}$/

/** plain domain list: one per line, # or // comments, optional *. / . / domain: / full: prefixes; single labels refused */
export function parseDomainList(text: string): { domains: string[]; skipped: number } {
  const out = new Set<string>()
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(#|\/\/).*$/, '').trim().toLowerCase()
    if (!line) continue
    const d = line.replace(/^(domain:|full:)/, '').replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '')
    if (!HOST.test(d)) { skipped++; continue }
    out.add(d)
    if (out.size > LIST_MAX) throw new Error('too_big')
  }
  if (!out.size) throw new Error('empty')
  return { domains: [...out], skipped }
}

export class Lists {
  private file: string
  data: ListSource[] = []

  constructor(dir: string) {
    this.file = join(dir, 'lists.json')
    try { if (existsSync(this.file)) this.data = (JSON.parse(readFileSync(this.file, 'utf8')) as ListSource[]).filter(x => x && LIST_ID.test(x.id) && Array.isArray(x.domains)) } catch { this.data = [] }
  }

  save() {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data))
    renameSync(tmp, this.file)
  }

  views(): ListView[] {
    return this.data.map(({ domains, ...v }) => ({ ...v, count: domains.length }))
  }

  domains(id: string): string[] {
    const x = this.data.find(l => l.id === id)
    return x && x.enabled ? x.domains : []
  }

  add(name: string, url: string): ListSource {
    if (this.data.length >= LIST_SOURCES_MAX) throw new Error('limit')
    if (!/^https:\/\/\S+$/i.test(url)) throw new Error('url')
    const x: ListSource = { id: 'l-' + randomBytes(4).toString('hex'), name: name.trim().slice(0, 60) || url.slice(8, 48), url, enabled: true, domains: [] }
    this.data = [...this.data, x]
    return x
  }

  /** a failed or partial update never replaces the last good snapshot */
  async refresh(id: string, opts: FetchOpts = {}): Promise<boolean> {
    const x = this.data.find(l => l.id === id)
    if (!x) return false
    const now = Date.now()
    try {
      const text = await fetchSubscription(x.url, { maxBytes: LIST_BYTES, ...opts })
      const { domains } = parseDomainList(text)
      this.patch(id, { domains, updatedAt: now, checkedAt: now, error: undefined })
      return true
    } catch (e) {
      const code = (e as Error).message
      this.patch(id, { checkedAt: now, error: code === 'empty' || code === 'too_big' ? code : 'fetch' })
      return false
    }
  }

  patch(id: string, p: Partial<ListSource>) {
    this.data = this.data.map(l => (l.id === id ? { ...l, ...p } : l))
  }

  remove(id: string) { this.data = this.data.filter(l => l.id !== id) }
}
