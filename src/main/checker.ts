// WRP-013 local checker: a second sing-box with NO inbound and NO TUN, userspace WireGuard, clash API on
// 127.0.0.1 only. It measures tunnels while the system tunnel is closed: ping through each tunnel and "where is the
// site cut" through each one. Proven safe in the WRP-003 run (no adapter, no routes, nothing reaches the system).
// Conservatively skip an AWG profile whose address appears on another adapter.
// Equal addresses are a conflict clue, not proof of key identity; absence is not proof a key is free.
import { ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Adapter, Profile } from '../shared/types'
import { checkConfig, tagOf } from './awg'
import { RuntimeJournal } from './runtime-journal'
import { protectPrivateFile } from './private-file'
import { pickPort, untilCancelled, waitReady } from './tun'
import { waitExit } from './stop'

export class Checker {
  private child?: ChildProcess
  private api = { port: 0, secret: '' }
  private key = ''
  private ids: string[] = []
  busy = new Set<string>()
  private journal: RuntimeJournal
  private recovered = false
  private transition: Promise<void> = Promise.resolve()
  private stopVersion = 0
  private starting?: AbortController
  private requests = new Set<AbortController>()
  constructor(private exe: string, private dir: string, private allowStart: () => boolean = () => true) { this.journal = new RuntimeJournal(dir, exe, 'check.json') }

  async recover(): Promise<boolean> {
    this.recovered = await this.journal.recover()
    return this.recovered
  }

  /** profiles whose AWG address is already live on someone else's adapter */
  static busyOf(profiles: Profile[], list: Adapter[]): Set<string> {
    const up = new Set(list.filter(a => a.name !== 'Waarp').flatMap(a => a.ipv4))
    return new Set(profiles.filter(p => p.kind === 'awg' && p.address.some(x => up.has(x.split('/')[0]))).map(p => p.id))
  }

  /** (re)start for this set of profiles; returns false when the engine is missing or nothing can be checked */
  ensure(profiles: Profile[], list: Adapter[]): Promise<boolean> {
    const version = this.stopVersion
    return this.serialize(async () => {
      if (version !== this.stopVersion || !this.allowStart()) return false
      const controller = new AbortController()
      this.starting = controller
      try { return await this.ensureNow(profiles, list, controller.signal) }
      finally { if (this.starting === controller) this.starting = undefined }
    })
  }

  private async ensureNow(profiles: Profile[], list: Adapter[], signal: AbortSignal): Promise<boolean> {
    const allowed = () => !signal.aborted && this.allowStart()
    if (!this.recovered) {
      if (!(await this.recover())) return false
    }
    if (!allowed()) return false
    this.busy = Checker.busyOf(profiles, list)
    const use = profiles.filter(p => !p.revoked && !this.busy.has(p.id))
    const key = createHash('sha256').update(JSON.stringify(use.map(p => p.id + ':' + JSON.stringify(p)))).digest('hex')
    if (this.child && key === this.key) return true
    if (!(await this.stopNow()) || !allowed() || !use.length) return false
    this.ids = use.map(p => p.id)
    if (!existsSync(this.exe)) return false
    mkdirSync(this.dir, { recursive: true })
    const port = await untilCancelled(pickPort(), signal)
    if (!port || !allowed()) return false
    this.api = { port, secret: randomBytes(16).toString('hex') }
    const file = join(this.dir, 'check.json')
    try {
      writeFileSync(file, JSON.stringify(checkConfig(use, this.api)), { mode: 0o600 })
      protectPrivateFile(file)
    }
    catch { try { rmSync(file, { force: true }) } catch {}; return false }
    const child = spawn(this.exe, ['run', '-c', file, '-D', this.dir, '--disable-color'], { windowsHide: true, cwd: this.dir })
    this.child = child
    this.key = key
    child.on('exit', () => { if (this.child === child) { this.child = undefined; this.key = ''; this.journal.clear() } })
    child.on('error', () => { if (this.child === child && (!child.pid || child.exitCode !== null || child.signalCode !== null)) { this.child = undefined; this.key = ''; this.journal.clear() } })
    if (!(await this.journal.record(child.pid)) || this.child !== child) {
      const stopped = await this.stopNow()
      try { rmSync(file, { force: true }) } catch {}
      if (!stopped) this.recovered = false
      return false
    }
    const ready = await waitReady({ probe: async () => !!(await this.req('/version', 600)), alive: () => this.child === child && allowed(), signal, budget: 12_000, every: 200 })
    try { rmSync(file, { force: true }) } catch { /* keys never stay on disk */ }
    // A cancelled or superseded checker must stop before the system tunnel is allowed to start.
    if (ready !== 'ready' || !allowed() || this.child !== child) { await this.stopNow(); return false }
    return true
  }

  private async req(path: string, timeout: number): Promise<any> {
    const child = this.child, api = this.api, version = this.stopVersion
    if (!child) return undefined
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout)
    this.requests.add(ac)
    try {
      const r = await fetch(`http://127.0.0.1:${api.port}${path}`, { headers: { Authorization: `Bearer ${api.secret}` }, signal: ac.signal })
      const value = r.ok ? await r.json() : undefined
      return this.child === child && this.api === api && this.stopVersion === version ? value : undefined
    } catch { return undefined } finally { clearTimeout(t); this.requests.delete(ac) }
  }

  private async delay(tag: string, url: string): Promise<number | undefined> {
    const r = await this.req(`/proxies/${tag}/delay?timeout=6000&url=` + encodeURIComponent(url), 8000)
    return typeof r?.delay === 'number' && r.delay > 0 ? r.delay : undefined
  }

  private async boundedDelays(url: string, failed: undefined | null, only?: string[]): Promise<Record<string, number | undefined | null>> {
    const out: Record<string, number | undefined | null> = {}
    const ids = only ? this.ids.filter(id => only.includes(id)) : this.ids
    let cursor = 0
    const child = this.child, version = this.stopVersion
    const worker = async () => {
      while (child && this.child === child && this.stopVersion === version) {
        const at = cursor++
        if (at >= ids.length) return
        const id = ids[at]
        const ms = await this.delay(tagOf(id), url)
        if (this.child !== child || this.stopVersion !== version) return
        out[id] = ms ?? failed
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker))
    return this.child === child && this.stopVersion === version ? out : {}
  }

  /** latency through every checked tunnel to a 204 endpoint */
  async pings(): Promise<Record<string, number | undefined>> {
    if (!this.child) return {}
    return await this.boundedDelays('https://www.gstatic.com/generate_204', undefined) as Record<string, number | undefined>
  }

  /** site reachability through every checked tunnel (null = failed) */
  async probe(target: string, only?: string[]): Promise<Record<string, number | null>> {
    const url = /^https?:\/\//.test(target) ? target : 'https://' + target
    if (!this.child) return {}
    return await this.boundedDelays(url, null, only) as Record<string, number | null>
  }

  stop(): Promise<boolean> {
    this.stopVersion++
    this.starting?.abort()
    this.abortRequests()
    return this.serialize(() => this.stopNow())
  }

  private abortRequests() {
    for (const controller of this.requests) controller.abort()
    this.requests.clear()
  }

  private async stopNow(): Promise<boolean> {
    this.abortRequests()
    const c = this.child
    this.key = ''
    if (!c) return true
    // Retain the exact handle and lease until exit is confirmed. Concurrent stops share the FIFO.
    if (c.exitCode === null && c.signalCode === null) { try { c.kill() } catch {} }
    const exited = await waitExit(c, 4000)
    if (exited) {
      if (this.child === c) this.child = undefined
      this.journal.clear()
      this.ids = []
    } else this.recovered = false
    return exited
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.transition.then(work, work)
    this.transition = next.then(() => undefined, () => undefined)
    return next
  }
}
