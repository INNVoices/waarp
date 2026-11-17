import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fetchSubscription, type FetchOpts } from './vless'

export interface ListSource { id: string; name: string; url: string; enabled: boolean; updatedAt?: number; checkedAt?: number; error?: string; domains: string[] }
export interface ListView { id: string; name: string; url: string; enabled: boolean; updatedAt?: number; checkedAt?: number; error?: string; count: number }
export interface ListRefresh { id: string; url: string; sequence: number; ok: boolean; patch: Pick<ListSource, 'checkedAt' | 'error'> & Partial<Pick<ListSource, 'domains' | 'updatedAt'>> }

export const LIST_MAX = 50_000
export const LIST_BYTES = 4 * 1024 * 1024
export const LIST_SOURCES_MAX = 20
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/
export const LIST_ID = /^l-[a-z0-9]{8}$/

function sourceUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (raw.length > 1000 || u.protocol !== 'https:' || u.username || u.password || !u.hostname) throw new Error('url')
    return u.toString()
  } catch { throw new Error('url') }
}

/** One domain suffix per line. Unsupported syntax rejects the whole update; full: must never become a suffix. */
export function parseDomainList(text: string): { domains: string[]; skipped: number } {
  if (Buffer.byteLength(text, 'utf8') > LIST_BYTES) throw new Error('too_big')
  const out = new Set<string>()
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(#|\/\/).*$/, '').trim().toLowerCase()
    if (!line) continue
    const d = line.replace(/^domain:/, '').replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '')
    if (!HOST.test(d)) { skipped++; continue }
    out.add(d)
    if (out.size > LIST_MAX) throw new Error('too_big')
  }
  if (!out.size) throw new Error('empty')
  if (skipped) throw new Error('invalid')
  return { domains: [...out], skipped }
}

export class Lists {
  private file: string
  private sequences = new Map<string, number>()
  data: ListSource[] = []

  constructor(dir: string) {
    this.file = join(dir, 'lists.json')
    try {
      if (existsSync(this.file)) {
        const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
        const seen = new Set<string>()
        if (Array.isArray(saved)) this.data = saved.filter((x): x is ListSource => {
          if (!x || !LIST_ID.test(x.id) || seen.has(x.id) || typeof x.name !== 'string' || typeof x.url !== 'string' || typeof x.enabled !== 'boolean' || !Array.isArray(x.domains) || x.domains.length > LIST_MAX || !x.domains.every((d: unknown) => typeof d === 'string' && HOST.test(d))) return false
          try { sourceUrl(x.url) } catch { return false }
          seen.add(x.id)
          return true
        }).slice(0, LIST_SOURCES_MAX).map(x => {
          const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Date.now() ? v : undefined
          return { id: x.id, name: x.name.slice(0, 60), url: sourceUrl(x.url), enabled: x.enabled, domains: [...new Set(x.domains)], updatedAt: time(x.updatedAt), checkedAt: time(x.checkedAt), error: ['fetch', 'empty', 'too_big', 'invalid'].includes(x.error ?? '') ? x.error : undefined }
        })
      }
    } catch { this.data = [] }
  }

  save(data = this.data) {
    const tmp = this.file + '.tmp'
    try { writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, this.file) }
    catch (error) { try { rmSync(tmp, { force: true }) } catch {}; throw error }
  }

  /** Commit the validated snapshot to disk before exposing it to route compilation. */
  replace(data: ListSource[]) {
    this.save(data)
    this.data = data
    for (const id of this.sequences.keys()) if (!data.some(l => l.id === id)) this.sequences.delete(id)
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
    url = sourceUrl(url)
    const x: ListSource = { id: 'l-' + randomBytes(4).toString('hex'), name: name.trim().slice(0, 60) || url.slice(8, 48), url, enabled: true, domains: [] }
    this.data = [...this.data, x]
    return x
  }

  /** a failed or partial update never replaces the last good snapshot */
  async refresh(id: string, opts: FetchOpts = {}): Promise<boolean> {
    const update = await this.download(id, opts)
    const next = update && this.updated(update)
    if (next) this.data = next
    return !!next && !!update?.ok
  }

  /** HTTP happens outside the routing-intent queue; it cannot change a working list. */
  async download(id: string, opts: FetchOpts = {}): Promise<ListRefresh | undefined> {
    const x = this.data.find(l => l.id === id)
    if (!x) return undefined
    const sequence = (this.sequences.get(id) ?? 0) + 1
    this.sequences.set(id, sequence)
    const result = { id, url: x.url, sequence }
    try {
      const text = await fetchSubscription(x.url, { ...opts, maxBytes: LIST_BYTES })
      const { domains } = parseDomainList(text)
      const now = Date.now()
      return { ...result, ok: true, patch: { domains, updatedAt: now, checkedAt: now, error: undefined } }
    } catch (e) {
      const code = (e as Error).message
      return { ...result, ok: false, patch: { checkedAt: Date.now(), error: ['empty', 'too_big', 'invalid'].includes(code) ? code : 'fetch' } }
    }
  }

  /** A late download cannot resurrect a removed source or overwrite a newer refresh/disabled state. */
  updated(update: ListRefresh): ListSource[] | undefined {
    if (this.sequences.get(update.id) !== update.sequence || !this.data.some(l => l.id === update.id && l.url === update.url)) return undefined
    return this.data.map(l => l.id === update.id ? { ...l, ...update.patch } : l)
  }

  patch(id: string, p: Partial<ListSource>) {
    this.data = this.data.map(l => (l.id === id ? { ...l, ...p } : l))
  }

  remove(id: string) { this.data = this.data.filter(l => l.id !== id) }
}
