import { safeStorage } from 'electron'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Profile, ProfileView, Settings } from '../shared/types'
import { Bounds, DEFAULTS, Disk, readDisk } from './store-core'
import { protectPrivateFile } from './private-file'

export type { Bounds }

export class Store {
  settings: Settings = { ...DEFAULTS }
  profiles: Profile[] = []
  private file: string
  private boundsFile: string
  private win?: Bounds
  /** C02: Windows secure storage (DPAPI) unavailable -> nothing with secrets is written; the UI says why */
  secureOff = false
  /** C02: the store on disk could not be read; it was copied aside before anything new is written */
  unreadable?: string
  unreadableCopy = false

  constructor(dir: string) {
    this.file = join(dir, 'waarp.json')
    this.boundsFile = join(dir, 'window.json')
    this.load()
    this.loadBounds()
    this.canSave()
  }

  private load() {
    if (!existsSync(this.file)) return
    const src = this.file
    try {
      const d = readDisk(readFileSync(src, 'utf8'), s => this.open(s))
      this.profiles = d.profiles
      this.settings = d.settings
      this.win = d.bounds
    } catch {
      // never overwrite an unreadable store with an empty one: keep a copy next to it, then start clean
      const aside = `${src}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try { copyFileSync(src, aside); this.unreadable = aside; this.unreadableCopy = true } catch { this.unreadable = src }
    }
  }

  /** DPAPI only; there is no plaintext fallback (C02). Old 'p:' entries are still readable and get sealed on the next save */
  private seal(s: string) {
    return 'e:' + safeStorage.encryptString(s).toString('base64')
  }

  private open(s: string) {
    if (s.startsWith('e:')) return safeStorage.decryptString(Buffer.from(s.slice(2), 'base64'))
    if (s.startsWith('p:')) return s.slice(2) // legacy plaintext is read only; next successful save seals it
    throw new Error('Unknown profile encoding')
  }

  canSave(): boolean {
    this.secureOff = !safeStorage.isEncryptionAvailable()
    return !this.secureOff && !this.unreadable
  }

  save() {
    if (!this.canSave()) return // no plaintext fallback and never overwrite unreadable source
    const d: Disk = { settings: this.settings, profiles: this.profiles.map(p => this.seal(JSON.stringify(p))) }
    const tmp = this.file + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 })
      protectPrivateFile(tmp)
      renameSync(tmp, this.file)
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch { /* preserve the original error */ }
      throw error
    }
  }

  private loadBounds() {
    try {
      if (!existsSync(this.boundsFile)) return
      const b = JSON.parse(readFileSync(this.boundsFile, 'utf8')) as Bounds
      if ([b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 720 && b.height >= 520) this.win = b
    } catch { /* window placement is optional */ }
  }

  bounds() { return this.win }

  saveBounds(b: Bounds) {
    this.win = b
    const tmp = this.boundsFile + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(b))
      protectPrivateFile(tmp)
      renameSync(tmp, this.boundsFile)
    } catch { try { rmSync(tmp, { force: true }) } catch {} }
  }

  views(): ProfileView[] {
    const have = new Set(this.profiles.filter(p => !p.revoked).map(p => p.id))
    const own = this.profiles.map((p): ProfileView => p.kind === 'vless'
      ? { kind: 'vless', id: p.id, name: p.name, host: p.vless.server, port: p.vless.port, address: [], version: p.version, source: p.source, revoked: p.revoked, subscription: !!p.sub, subscriptionMissing: p.subMissing }
      : p.kind === 'out'
        ? { kind: 'out', id: p.id, name: p.name, host: p.host, port: p.port, address: [], version: p.version, source: p.source, country: p.country, revoked: p.revoked, subscription: !!p.sub, subscriptionMissing: p.subMissing }
        : p.kind === 'openvpn'
          ? { kind: 'openvpn', id: p.id, name: p.name, host: p.host, port: p.port, address: [], version: p.version, source: p.source, revoked: p.revoked }
        : { kind: 'awg', id: p.id, name: p.name, host: p.peer.host, port: p.peer.port, address: p.address, clientPublicKey: p.clientPublicKey, version: p.version, source: p.source, revoked: p.revoked })
    const groups = (this.settings.groups ?? []).filter(g => g.members.some(m => have.has(m))).map((g): ProfileView => ({ kind: 'group', id: g.id, name: g.name, host: '', port: 0, address: [], version: g.policy, policy: g.policy, members: g.members.filter(m => have.has(m)) }))
    return [...own, ...groups]
  }
}
