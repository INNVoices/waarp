import { localized } from '../shared/localization'
// WRP-013 local checker: a second sing-box with NO inbound and NO TUN, userspace WireGuard, clash API on
// 127.0.0.1 only. Its caller admits isolated measurements during stable ON or OFF;
// it never creates an adapter or changes system routes. Outbound interface binding
// keeps its probe traffic from re-entering the main TUN.
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
import { validLatency } from './health'
import { DIAGNOSTIC_SELECTOR, type DiagnosticProxy, type DiagnosticTransport } from './diagnostic-proxy'
import type { ForwardProxy } from './relay-config'

export type CheckerFailureKind = 'missing-engine' | 'configuration' | 'launch' | 'controller' | 'cleanup'
export interface CheckerFailure { kind: CheckerFailureKind; message: string }
const CHECKER_FAILURES: Record<CheckerFailureKind, string> = {
  'missing-engine': localized("winInline.checker.c80398662818"),
  configuration: localized("winInline.checker.dc31939b7c7b"),
  launch: localized("winInline.checker.3c0a80824b04"),
  controller: localized("winInline.checker.5dd7f43607d3"),
  cleanup: localized("winInline.checker.2015c9213a7c")
}

export class Checker {
  private child?: ChildProcess
  private api = { port: 0, secret: '' }
  private diagnostic?: DiagnosticProxy
  private diagnosticOwner?: AbortController
  private key = ''
  private ids: string[] = []
  busy = new Set<string>()
  private journal: RuntimeJournal
  private recovered = false
  private cleanupOk = true
  private transition: Promise<void> = Promise.resolve()
  private stopVersion = 0
  private starting?: AbortController
  private requests = new Set<AbortController>()
  private owner?: symbol
  private cancelOwner?: () => void
  private failure?: CheckerFailure
  constructor(private exe: string, private dir: string, private allowStart: () => boolean = () => true,
    private forward?: ForwardProxy) { this.journal = new RuntimeJournal(dir, exe, 'check.json') }

  /** A caller owns the complete ensure → measurement sequence, not just process startup. */
  acquire(onCancel?: () => void): symbol | undefined {
    if (this.owner || !this.allowStart()) return undefined
    this.cancelOwner = onCancel
    return this.owner = Symbol('checker measurement')
  }

  owns(owner: symbol): boolean { return this.owner === owner }
  release(owner: symbol): void { if (this.owns(owner)) { this.owner = undefined; this.cancelOwner = undefined } }

  async recover(): Promise<boolean> {
    this.recovered = await this.journal.recover()
    this.cleanupOk = this.recovered
    return this.recovered
  }

  get recoveryError(): string | undefined { return this.journal.lastError }
  /** Fixed, credential-free classification. Native stderr never reaches IPC. */
  get lastFailure(): CheckerFailure | undefined { return this.failure && { ...this.failure } }
  private fail(kind: CheckerFailureKind): void { this.failure = { kind, message: CHECKER_FAILURES[kind] } }

  private clearJournal(): boolean {
    this.cleanupOk = this.journal.clear() !== false
    if (!this.cleanupOk) this.recovered = false
    return this.cleanupOk
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
    this.failure = undefined
    if (!this.recovered) {
      if (!(await this.recover())) { this.fail('cleanup'); return false }
    }
    if (!allowed()) return false
    this.busy = Checker.busyOf(profiles, list)
    const use = profiles.filter(p => !p.revoked && !this.busy.has(p.id))
    const key = createHash('sha256').update(JSON.stringify(use.map(p => p.id + ':' + JSON.stringify(p)))).digest('hex')
    if (this.child && key === this.key) return true
    if (!(await this.stopNow())) { this.fail('cleanup'); return false }
    if (!allowed() || !use.length) return false
    this.ids = use.map(p => p.id)
    if (!existsSync(this.exe)) { this.fail('missing-engine'); return false }
    mkdirSync(this.dir, { recursive: true })
    let port = await untilCancelled(pickPort(), signal)
    if (port === this.forward?.proxy.port) port = await untilCancelled(pickPort(), signal)
    if (!port || port === this.forward?.proxy.port || !allowed()) return false
    this.api = { port, secret: randomBytes(16).toString('hex') }
    let proxyPort = this.forward?.proxy.port ?? await untilCancelled(pickPort(), signal)
    if (proxyPort === port) proxyPort = await untilCancelled(pickPort(), signal)
    if (!proxyPort || proxyPort === port || !allowed()) return false
    this.diagnostic = this.forward?.proxy ?? { port: proxyPort, username: randomBytes(12).toString('hex'), password: randomBytes(24).toString('hex') }
    const file = join(this.dir, 'check.json')
    try {
      writeFileSync(file, JSON.stringify(checkConfig(use, this.api, this.forward ? undefined : this.diagnostic, this.forward)), { mode: 0o600 })
      protectPrivateFile(file)
    }
    catch { this.fail('configuration'); try { rmSync(file, { force: true }) } catch {}; return false }
    const child = spawn(this.exe, ['run', '-c', file, '-D', this.dir, '--disable-color'], { windowsHide: true, cwd: this.dir })
    this.child = child
    // Keep only a bounded startup tail for classification, then immediately
    // discard it. Never expose native lines (which can contain credentials).
    let startup = true, startupTail = ''
    child.stdout?.resume()
    child.stderr?.on('data', chunk => { if (startup) startupTail = (startupTail + String(chunk)).slice(-8192) })
    this.key = key
    child.on('exit', () => {
      if (startup && allowed()) this.fail(/(?:decode|parse) config|(?:initialize|create) (?:outbound|endpoint)|unknown (?:field|transport|outbound)|(?:outbound|endpoint)\[/i.test(startupTail) ? 'configuration' : 'launch')
      startupTail = ''
      if (this.child === child) { this.child = undefined; this.key = ''; this.clearJournal() }
    })
    child.on('error', () => {
      if (startup && allowed()) this.fail('launch')
      startupTail = ''
      if (this.child === child && (!child.pid || child.exitCode !== null || child.signalCode !== null)) { this.child = undefined; this.key = ''; this.clearJournal() }
    })
    if (!(await this.journal.record(child.pid)) || this.child !== child) {
      const stopped = await this.stopNow()
      if (stopped) this.clearJournal()
      try { rmSync(file, { force: true }) } catch {}
      if (!stopped) this.recovered = false
      if (allowed() && !this.failure) this.fail(stopped ? 'launch' : 'cleanup')
      startup = false; startupTail = ''
      return false
    }
    const ready = await waitReady({ probe: async () => !!(await this.req('/version', 600)), alive: () => this.child === child && allowed(), signal, budget: 12_000, every: 200 })
    startup = false; startupTail = ''
    try { rmSync(file, { force: true }) } catch { /* keys never stay on disk */ }
    // A cancelled or superseded checker must stop before the system tunnel is allowed to start.
    if (ready !== 'ready' || !allowed() || this.child !== child) {
      if (allowed() && !this.failure) this.fail('controller')
      if (!(await this.stopNow()) && allowed()) this.fail('cleanup')
      return false
    }
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
    return validLatency(r?.delay) ? r.delay : undefined
  }

  private async boundedDelays(url: string, failed: undefined | null, only?: string[]): Promise<Record<string, number | undefined | null>> {
    const out: Record<string, number | undefined | null> = {}
    const ids = only ? [...new Set(only.filter(id => id === 'direct' || this.ids.includes(id)))] : this.ids
    let cursor = 0
    const child = this.child, version = this.stopVersion
    const worker = async () => {
      while (child && this.child === child && this.stopVersion === version) {
        const at = cursor++
        if (at >= ids.length) return
        const id = ids[at]
        const ms = await this.delay(id === 'direct' ? 'direct' : tagOf(id), url)
        if (this.child !== child || this.stopVersion !== version) return
        out[id] = ms ?? failed
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker))
    return this.child === child && this.stopVersion === version ? out : {}
  }

  /** Measure HTTPS through the relay, with the same independent fallback as
   * the main engine. One blocked Google endpoint is not a dead server. */
  async pings(): Promise<Record<string, number | undefined>> {
    if (!this.child) return {}
    const child = this.child, version = this.stopVersion
    const first = await this.boundedDelays('https://www.gstatic.com/generate_204', undefined) as Record<string, number | undefined>
    if (this.child !== child || this.stopVersion !== version) return {}
    const retry = Object.keys(first).filter(id => !validLatency(first[id]))
    if (!retry.length) return first
    const second = await this.boundedDelays('https://cp.cloudflare.com/generate_204', undefined, retry) as Record<string, number | undefined>
    return this.child === child && this.stopVersion === version ? { ...first, ...second } : {}
  }

  /** site reachability through every checked tunnel (null = failed) */
  async probe(target: string, only?: string[]): Promise<Record<string, number | null>> {
    const url = /^https?:\/\//.test(target) ? target : 'https://' + target
    if (!this.child) return {}
    return await this.boundedDelays(url, null, only) as Record<string, number | null>
  }

  /** Caller must own ensure -> transfer -> cleanup as one checker operation. */
  async withHttpProxy<T>(owner: symbol, profileId: string, signal: AbortSignal,
    work: (proxy: DiagnosticTransport) => Promise<T>): Promise<T> {
    if (!this.owns(owner) || this.diagnosticOwner) throw new Error('busy')
    const child = this.child, version = this.stopVersion, proxy = this.diagnostic, api = this.api
    if (!child || !proxy || !this.allowStart()) throw new Error('engine')
    if (profileId !== 'direct' && !this.ids.includes(profileId)) throw new Error('not_loaded')
    const controller = new AbortController()
    this.diagnosticOwner = controller
    const linked = AbortSignal.any([signal, controller.signal])
    const current = () => this.owns(owner) && !linked.aborted && this.child === child &&
      this.stopVersion === version && this.allowStart()
    try {
      if (!current()) throw new Error('cancelled')
      const selected = profileId === 'direct' ? 'direct' : tagOf(profileId)
      const selectionSignal = AbortSignal.any([linked, AbortSignal.timeout(3000)])
      const response = await fetch(`http://127.0.0.1:${api.port}/proxies/${DIAGNOSTIC_SELECTOR}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${api.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selected }), signal: selectionSignal
      })
      if (!response.ok || !current()) throw new Error('engine')
      const confirmed = await fetch(`http://127.0.0.1:${api.port}/proxies/${DIAGNOSTIC_SELECTOR}`, {
        headers: { Authorization: `Bearer ${api.secret}` }, signal: selectionSignal
      })
      const selection = confirmed.ok ? await confirmed.json() : undefined
      if (selection?.now !== selected || !current()) throw new Error('engine')
      const result = await work({ ...proxy, host: '127.0.0.1', signal: linked })
      if (!current()) throw new Error('cancelled')
      return result
    } finally {
      controller.abort()
      if (this.diagnosticOwner === controller) this.diagnosticOwner = undefined
    }
  }

  stop(): Promise<boolean> {
    const cancelOwner = this.cancelOwner
    this.owner = undefined
    this.cancelOwner = undefined
    cancelOwner?.()
    this.stopVersion++
    this.starting?.abort()
    this.abortRequests()
    return this.serialize(() => this.stopNow())
  }

  /** Last-chance app shutdown still signals only this retained child handle. */
  stopSync(): void {
    this.stopVersion++
    this.starting?.abort()
    this.abortRequests()
    try { this.child?.kill() } catch {}
  }

  private abortRequests() {
    for (const controller of this.requests) controller.abort()
    this.requests.clear()
    this.diagnosticOwner?.abort()
  }

  private async stopNow(): Promise<boolean> {
    this.abortRequests()
    const c = this.child
    this.key = ''
    this.diagnostic = undefined
    if (!c) return this.cleanupOk
    // Failed spawn has no PID and emits error/close, never exit. There is no process to wait four seconds for.
    if (!c.pid) {
      if (this.child === c) this.child = undefined
      const clean = this.clearJournal()
      this.ids = []
      return clean
    }
    // Retain the exact handle and lease until exit is confirmed. Concurrent stops share the FIFO.
    if (c.exitCode === null && c.signalCode === null) { try { c.kill() } catch {} }
    const exited = await waitExit(c, 4000)
    if (exited) {
      if (this.child === c) this.child = undefined
      const clean = this.clearJournal()
      this.ids = []
      return clean
    } else this.recovered = false
    return exited
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.transition.then(work, work)
    this.transition = next.then(() => undefined, () => undefined)
    return next
  }
}
