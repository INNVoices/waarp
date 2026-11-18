import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Profile } from '../shared/types'
import { Checker } from './checker'
import { credentialKey } from './discovery'
import { preparePublicCandidate } from './catalog-endpoint'
import { pickPort } from './tun'
import type { RelayGraph, RelaySlot } from './relay-config'

/** Capacity is for concurrently selected late additions, not the whole public catalog. */
export const LIVE_OUTBOUND_SLOTS = 16
type Worker = Pick<Checker, 'ensure' | 'pings' | 'stop' | 'stopSync' | 'recover'>
type Entry = { slot: RelaySlot; profileId: string; profile: Profile; signature: string; worker: Worker; ready: boolean }
type WorkerFactory = (dir: string, current: () => boolean, slot?: RelaySlot, profileId?: string) => Worker

/** Keep the main native graph stable. Only an explicit new selection starts a
 * no-TUN worker; its authenticated SOCKS endpoint occupies an inert reserved slot. */
export class LiveOutbounds {
  private slots: RelaySlot[] = []
  private entries: Entry[] = []
  private epoch = 0
  private stopping?: Promise<boolean>
  private cleanupOk = true
  private preparations = new Set<AbortController>()
  lastError?: string
  private create: WorkerFactory

  constructor(exe: string, private dir: string, create?: WorkerFactory,
    private preparePublic: (profile: Profile, signal: AbortSignal) => Promise<Profile | undefined> = preparePublicCandidate) {
    this.create = create ?? ((path, current, slot, profileId) => new Checker(exe, path, current,
      slot && profileId ? { proxy: slot, profileId } : undefined))
  }

  get graph(): RelayGraph {
    return { slots: this.slots, bindings: Object.fromEntries(this.entries.map(entry => [entry.profileId, entry.slot.id])) }
  }
  tag(id: string): string | undefined { return this.entries.find(entry => entry.profileId === id)?.slot.id }
  profile(tag: string): string | undefined { return this.entries.find(entry => entry.slot.id === tag)?.profileId }
  ready(id: string): boolean { return this.entries.some(entry => entry.profileId === id && entry.ready) }

  private path(index: number): string { return join(this.dir, 'live-outbounds', String(index)) }

  async recover(): Promise<boolean> {
    const epoch = ++this.epoch
    if (this.stopping) await this.stopping
    const results = await Promise.all(Array.from({ length: LIVE_OUTBOUND_SLOTS }, (_, index) =>
      this.create(this.path(index), () => false).recover()))
    if (epoch !== this.epoch) return false
    this.cleanupOk = results.every(Boolean)
    if (this.cleanupOk) { this.entries = []; this.slots = []; this.lastError = undefined }
    else this.lastError = 'Не удалось восстановить процесс выбранного сервера'
    return this.cleanupOk
  }

  /** Reserving config slots opens no sockets and starts no remote connections. */
  async reserve(current: () => boolean, nextPort: () => Promise<number | undefined> = pickPort,
    excludedPorts: readonly number[] = []): Promise<boolean> {
    if (this.stopping && !(await this.stopping)) return false
    if (!this.cleanupOk || !current()) return false
    if (this.slots.length) return true
    const epoch = this.epoch, result: RelaySlot[] = [], ports = new Set(excludedPorts)
    for (let attempts = 0; result.length < LIVE_OUTBOUND_SLOTS && attempts < LIVE_OUTBOUND_SLOTS * 4; attempts++) {
      const port = await nextPort()
      if (epoch !== this.epoch || !current()) return false
      if (!port || ports.has(port)) continue
      ports.add(port)
      result.push({ id: 'waarp-live-' + result.length, port,
        username: randomBytes(12).toString('hex'), password: randomBytes(24).toString('hex') })
    }
    if (result.length !== LIVE_OUTBOUND_SLOTS) { this.lastError = 'Нет свободных локальных портов для выбора сервера'; return false }
    this.slots = result
    this.lastError = undefined
    return true
  }

  /** Old active slots cannot be replaced while a transaction still references them. */
  async ensure(profiles: Profile[], protectedIds: ReadonlySet<string>, current: () => boolean): Promise<boolean> {
    const epoch = this.epoch
    const live = () => epoch === this.epoch && current()
    const requested = new Set(profiles.map(profile => profile.id))
    this.lastError = undefined
    if (this.stopping || !this.cleanupOk) return false
    for (const profile of profiles) {
      if (!live()) return false
      // Identity includes the effective native definition and its private DNS,
      // not a mutable label, source timestamp or subscription display metadata.
      const signature = credentialKey(profile)
      let entry = this.entries.find(value => value.profileId === profile.id)
      if (entry && entry.signature !== signature && protectedIds.has(profile.id)) {
        this.lastError = 'Данные активного сервера изменились. Действующий маршрут сохранён'
        return false
      }
      let effective = entry?.signature === signature ? entry.profile : structuredClone(profile)
      if (profile.source === 'public' && (!entry?.ready || !protectedIds.has(profile.id))) {
        const controller = new AbortController()
        this.preparations.add(controller)
        try {
          const prepared = await this.preparePublic(profile, AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]))
          if (!live()) return false
          if (!prepared) { this.lastError = 'Не удалось подтвердить адрес публичного сервера. Действующий маршрут сохранён'; return false }
          effective = prepared
        } catch { this.lastError = 'Проверка адреса сервера не завершилась. Действующий маршрут сохранён'; return false }
        finally { this.preparations.delete(controller) }
      }
      if (!live()) return false
      if (!entry) {
        const free = this.slots.find(slot => !this.entries.some(value => value.slot.id === slot.id))
        const reusable = free ? undefined : this.entries.find(value => !protectedIds.has(value.profileId) && !requested.has(value.profileId))
        const slot = free ?? reusable?.slot
        if (!slot) { this.lastError = 'Все места для одновременных серверов заняты. Освободи неиспользуемый маршрут'; return false }
        if (reusable) {
          if (!(await reusable.worker.stop()) || !live()) { this.lastError = 'Предыдущий сервер ещё завершает работу'; return false }
          this.entries = this.entries.filter(value => value !== reusable)
        }
        const worker = this.create(this.path(this.slots.indexOf(slot)), live, slot, profile.id)
        entry = { slot, profileId: profile.id, profile: effective, signature, worker, ready: false }
        this.entries.push(entry)
      }
      if (!(await entry.worker.ensure([effective], [])) || !live()) {
        entry.ready = false
        this.lastError = 'Не удалось подготовить выбранный сервер. Действующий маршрут сохранён'
        return false
      }
      entry.profile = effective; entry.signature = signature
      if (profile.source === 'public' && !protectedIds.has(profile.id)) {
        const measured = await entry.worker.pings()
        if (!live()) return false
        if (typeof measured[profile.id] !== 'number' || !Number.isFinite(measured[profile.id])) {
          entry.ready = false
          await entry.worker.stop()
          this.lastError = 'Выбранный публичный сервер сейчас не отвечает. Действующий маршрут сохранён'
          return false
        }
      }
      entry.ready = true
    }
    return live()
  }

  async trim(keep: ReadonlySet<string>): Promise<boolean> {
    // Retain the slot identity so an inactive path never changes the native graph.
    const results = await Promise.allSettled(this.entries.filter(entry => !keep.has(entry.profileId)).map(async entry => {
      entry.ready = false
      return entry.worker.stop()
    }))
    return results.every(result => result.status === 'fulfilled' && result.value)
  }

  stop(): Promise<boolean> {
    this.epoch++
    for (const controller of this.preparations) controller.abort()
    if (this.stopping) return this.stopping
    const entries = this.entries
    for (const entry of entries) entry.ready = false
    const stopping = Promise.all(entries.map(async entry => entry.worker.stop())).then(results => {
      const clean = results.every(Boolean)
      if (clean && entries === this.entries) { this.entries = []; this.slots = [] }
      this.cleanupOk = clean
      if (!clean) this.lastError = 'Процесс выбранного сервера не подтвердил остановку'
      return clean
    }).catch(() => {
      this.cleanupOk = false
      this.lastError = 'Не удалось подтвердить остановку выбранного сервера'
      return false
    }).finally(() => { if (this.stopping === stopping) this.stopping = undefined })
    this.stopping = stopping
    return stopping
  }

  stopSync(): void {
    this.epoch++
    for (const controller of this.preparations) controller.abort()
    for (const entry of this.entries) entry.worker.stopSync()
  }
}
