// WRP-014: bounded, local-only discovery. Never reads another user's folders or follows reparse points.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Profile } from '../shared/types'
import { parseConf } from './awg'
import { linksInContainer, parseAny } from './links'
import { looksLikeOpenVpn, parseOpenVpn } from './openvpn'

export interface FoundTunnel { id: string; name: string; version: string; host: string; source: string }
const LIMIT_FILES = 500
const LIMIT_FILE_BYTES = 1024 * 1024
const LIMIT_TOTAL_BYTES = 16 * 1024 * 1024
const LIMIT_MS = 3000

async function readBounded(path: string, remaining: number): Promise<{ text: string; bytes: number } | null> {
  // O_NOFOLLOW is unavailable on Windows; compare the opened file with the current path as well.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    const current = await lstat(path)
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) return null
    const cap = Math.min(LIMIT_FILE_BYTES, remaining)
    if (!stat.isFile() || stat.size > cap) return null
    const buffer = Buffer.alloc(stat.size + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > cap) return null // file grew after stat
    return { text: buffer.toString('utf8', 0, used), bytes: used }
  } finally { await handle.close() }
}

export function credentialKey(p: Profile): string {
  if (p.kind === 'awg') return `awg|${p.privateKey}|${p.peer.host}|${p.peer.port}`
  if (p.kind === 'vless') return `vless|${p.vless.uuid}|${p.vless.server}|${p.vless.port}`
  if (p.kind === 'openvpn') return `openvpn|${p.host}|${p.port}|${JSON.stringify(p.endpoint)}`
  return `out|${p.outbound.type}|${p.outbound.uuid ?? p.outbound.password ?? ''}|${p.host}|${p.port}`
}

export class Discovery {
  private found = new Map<string, Profile>()

  profile(id: string): Profile | undefined { return this.found.get(id) }
  clear(): void { this.found.clear() }

  async scan(folders: { path: string; label: string; maxDepth?: number }[]): Promise<FoundTunnel[]> {
    this.found.clear()
    const out: FoundTunnel[] = []
    const seen = new Set<string>()
    const deadline = Date.now() + LIMIT_MS
    let files = 0, bytes = 0
    for (const folder of folders) {
      const root = resolve(folder.path)
      const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
      while (queue.length && files < LIMIT_FILES && bytes < LIMIT_TOTAL_BYTES && Date.now() < deadline) {
        const dir = queue.shift()!
        let entries
        try { entries = await readdir(dir.path, { withFileTypes: true }) } catch { continue }
        for (const entry of entries) {
          if (files >= LIMIT_FILES || bytes >= LIMIT_TOTAL_BYTES || Date.now() >= deadline) break
          if (entry.isSymbolicLink()) continue
          const path = resolve(dir.path, entry.name)
          if (path !== root && !path.startsWith(root + '\\')) continue
          if (entry.isDirectory()) {
            if (dir.depth < (folder.maxDepth ?? 1) && queue.length < 100) {
              try { const stat = await lstat(path); if (stat.isDirectory() && !stat.isSymbolicLink()) queue.push({ path, depth: dir.depth + 1 }) } catch { /* inaccessible folder */ }
            }
            continue
          }
          if (!entry.isFile() || !/\.(conf|ovpn|vpn|txt|json|ya?ml)$/i.test(entry.name)) continue
          files++
          try {
            const stat = await lstat(path)
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT_FILE_BYTES || stat.size > LIMIT_TOTAL_BYTES - bytes) continue
            const bounded = await readBounded(path, LIMIT_TOTAL_BYTES - bytes)
            if (!bounded) continue
            bytes += bounded.bytes
            const text = bounded.text
            const profiles: Profile[] = []
            if (looksLikeOpenVpn(text)) {
              try { profiles.push(parseOpenVpn(text, basename(entry.name).replace(/\.ovpn$/i, ''))) } catch { /* unsupported or unsafe OpenVPN profile */ }
            } else if (/\[Interface\]|^vpn:\/\//im.test(text)) {
              try { profiles.push(parseConf(text, basename(entry.name))) } catch { /* not a supported AWG/WG config */ }
            } else {
              // Plain subscriptions may be one base64 blob; JSON/YAML containers need link extraction first.
              // parseAny is bounded and does not execute or expand anything from the source file.
              const links = linksInContainer(text)
              profiles.push(...parseAny(links.length ? links.join('\n') : text, 128).items)
            }
            for (const p of profiles) {
              const identity = credentialKey(p)
              if (seen.has(identity)) continue
              seen.add(identity)
              const id = randomBytes(12).toString('hex')
              this.found.set(id, p)
              const host = p.kind === 'awg' ? p.peer.host : p.kind === 'vless' ? p.vless.server : p.host
              out.push({ id, name: p.name, version: p.version, host, source: `${folder.label} / ${entry.name}` })
            }
          } catch { /* unreadable file: skip; never retry or mutate the source */ }
        }
      }
    }
    return out
  }
}
