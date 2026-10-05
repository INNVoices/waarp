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
import { pickPort } from './tun'

export class Checker {
  private child?: ChildProcess
  private api = { port: 0, secret: '' }
  private key = ''
  private ids: string[] = []
  busy = new Set<string>()
  private journal: RuntimeJournal
  private recovered = false
  constructor(private exe: string, private dir: string) { this.journal = new RuntimeJournal(dir, exe, 'check.json') }

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
  async ensure(profiles: Profile[], list: Adapter[]): Promise<boolean> {
    if (!this.recovered) {
      if (!(await this.recover())) return false
    }
    this.busy = Checker.busyOf(profiles, list)
    const use = profiles.filter(p => !p.revoked && !this.busy.has(p.id))
    const key = createHash('sha256').update(JSON.stringify(use.map(p => p.id + ':' + JSON.stringify(p)))).digest('hex')
    if (this.child && key === this.key) return true
    if (!(await this.stop())) return false
    this.ids = use.map(p => p.id)
    if (!existsSync(this.exe)) return false
    mkdirSync(this.dir, { recursive: true })
    const port = await pickPort()
    if (!port) return false
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
    child.on('error', () => { if (this.child === child) { this.child = undefined; this.key = ''; this.journal.clear() } })
    if (!(await this.journal.record(child.pid)) || this.child !== child) {
      const stopped = await this.stop()
      try { rmSync(file, { force: true }) } catch {}
      if (!stopped) this.recovered = false
      return false
    }
    let ready = false
    for (let i = 0; i < 30 && this.child; i++) { if (await this.req('/version', 600)) { ready = true; break } await new Promise(r => setTimeout(r, 200)) }
    try { rmSync(file, { force: true }) } catch { /* keys never stay on disk */ }
    // C08: a process that never answered its controller is not a working checker
    if (!ready) { await this.stop(); return false }
    return true
  }

  private async req(path: string, timeout: number): Promise<any> {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout)
    try {
      const r = await fetch(`http://127.0.0.1:${this.api.port}${path}`, { headers: { Authorization: `Bearer ${this.api.secret}` }, signal: ac.signal })
      return r.ok ? await r.json() : undefined
    } catch { return undefined } finally { clearTimeout(t) }
  }

  private async delay(tag: string, url: string): Promise<number | undefined> {
    const r = await this.req(`/proxies/${tag}/delay?timeout=6000&url=` + encodeURIComponent(url), 8000)
    return typeof r?.delay === 'number' && r.delay > 0 ? r.delay : undefined
  }

  private async boundedDelays(url: string, failed: undefined | null, only?: string[]): Promise<Record<string, number | undefined | null>> {
    const out: Record<string, number | undefined | null> = {}
    const ids = only ? this.ids.filter(id => only.includes(id)) : this.ids
    let cursor = 0
    const worker = async () => {
      while (this.child) {
        const at = cursor++
        if (at >= ids.length) return
        const id = ids[at]
        out[id] = (await this.delay(tagOf(id), url)) ?? failed
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker))
    return out
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

  async stop(): Promise<boolean> {
    const c = this.child; this.child = undefined; this.key = ''
    if (!c) return true
    const exited = await new Promise<boolean>(resolve => {
      if (c.exitCode !== null || c.signalCode !== null) { resolve(true); return }
      const timer = setTimeout(() => resolve(false), 4000)
      c.once('exit', () => { clearTimeout(timer); resolve(true) })
      if (!c.killed) { try { c.kill() } catch { clearTimeout(timer); resolve(false) } }
    })
    if (exited) this.journal.clear()
    else this.recovered = false // a later ensure must reconcile the still-recorded process first
    return exited
  }
}
