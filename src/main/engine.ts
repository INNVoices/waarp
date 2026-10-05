import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Conn, Profile, Settings, Status, TunnelHealth } from '../shared/types'
import { activeRoutes, buildConfig, fallbackGroups, redact, runtimeAutoLive, tagOf, usedProfiles, withoutAuto } from './awg'
import { AUTO_ID, autoMembers, autoSample, firstAlive, grpTag, liveGroups, stickyFastest, withAuto, type LiveGroup } from '../shared/groups'
import { FbTracker } from './fallback'
import { Health } from './health'
import { redactVless, vlessSecrets } from './vless'
import { outSecrets } from './links'
import { openVpnSecrets } from './openvpn'
import { RuntimeJournal } from './runtime-journal'
import { protectPrivateFile } from './private-file'
import { pickPort, START_BUDGET_MS, waitReady, type Preflight } from './tun'
import { ctrlBreak, waitExit } from './stop'

export class Engine extends EventEmitter {
  status: Status = { phase: 'off', pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0 }
  private ids: string[] = []
  private groups: LiveGroup[] = []
  private firstSelected = new Map<string, string>()
  private slowStreak = new Map<string, number>()
  /** Auto candidates no other route needs: probed by a rotating bounded sample, not every round */
  private autoOnly: string[] = []
  private autoCursor = 0
  private lastHealth: Record<string, TunnelHealth> = {}
  /** R5: the Auto member last selected in this process; kept first in the next live pool (no churn on restart/resume) */
  private lastAutoPick?: string
  private autoPool?: { live: number; total: number }
  conns: Conn[] = []
  private child?: ChildProcess
  private api = { port: 0, secret: '' }
  private timer?: NodeJS.Timeout
  private pingTimer?: NodeJS.Timeout
  private last?: { t: number; d: number; u: number }
  private stopping = false
  private secrets: string[] = []
  private fb = new FbTracker([])
  private fbRoutes = new Map<string, { id: string; name: string }[]>()
  private tail: string[] = []
  private journal: RuntimeJournal
  private recoveryOk = false
  private transition: Promise<void> = Promise.resolve()
  /** R1.4: read-only Windows check before a TUN start (set by main); absent in offline tests */
  preflight?: () => Promise<Preflight>
  /** pause between preflight re-checks right after our own stop (Windows may still be removing the adapter) */
  preflightGap = 1500
  /** R2: graceful signal for the owned core (CTRL_BREAK into its own hidden console); injectable for tests */
  breakSignal: (pid: number) => Promise<void> = pid => ctrlBreak(pid)
  gracefulMs = 5000
  killMs = 4000

  constructor(private exe: string, private dir: string, private selfExe: string) {
    super()
    mkdirSync(dir, { recursive: true })
    this.journal = new RuntimeJournal(dir, exe, 'run.json')
  }

  log(): string[] { return this.tail.slice(-300) }

  private set(s: Partial<Status>) {
    this.status = { ...this.status, ...s }
    this.emit('status', this.status)
  }

  private push(line: string) {
    for (const l of line.split(/\r?\n/)) {
      if (!l.trim()) continue
      this.tail.push(redactVless(redact(l.replace(/\x1b\[[0-9;]*m/g, '')), this.secrets))
    }
    if (this.tail.length > 600) this.tail.splice(0, this.tail.length - 600)
  }

  async killOrphans(otherRuntimesOk = true): Promise<boolean> {
    const ownRecovered = await this.journal.recover()
    this.recoveryOk = otherRuntimesOk && ownRecovered && await RuntimeJournal.noUntracked(this.exe)
    if (!this.recoveryOk) this.set({ phase: 'error', error: 'Не удалось подтвердить принадлежность прошлого процесса. Waarp не будет запускать новый туннель до восстановления.' })
    return this.recoveryOk
  }

  start(profiles: Profile[], s: Settings): Promise<void> {
    return this.serialize(() => this.startNow(profiles, s))
  }

  private async startNow(profiles: Profile[], s: Settings) {
    if (!this.recoveryOk) { this.set({ phase: 'error', error: 'Восстановление прошлого процесса не завершено' }); return }
    if (this.child && !(await this.stopNow())) return
    if (!existsSync(this.exe)) { this.set({ phase: 'error', error: 'Не найден движок engine\\sing-box.exe' }); return }
    this.stopping = false
    this.tail = []
    if (this.preflight) {
      let pf = await this.preflight()
      for (let i = 0; i < 2 && !pf.ok && pf.kind === 'tun_stale'; i++) { await new Promise(r => setTimeout(r, this.preflightGap)); pf = await this.preflight() }
      if (!pf.ok) { this.set({ phase: 'error', engine: 'down', since: undefined, error: pf.text, recovery: pf.kind }); return }
    }
    const port = await pickPort()
    if (!port) { this.set({ phase: 'error', error: 'Нет свободного локального порта для управления движком. Туннель не запущен', recovery: undefined }); return }
    this.api = { port, secret: randomBytes(16).toString('hex') }
    this.secrets = profiles.flatMap(p => (p.kind === 'vless' ? vlessSecrets(p) : p.kind === 'out' ? outSecrets(p) : p.kind === 'openvpn' ? openVpnSecrets(p) : []))
    let cfg: ReturnType<typeof buildConfig>
    // R5: the core gets a bounded Auto live pool; the plan/UI keep the full logical Auto membership
    const autoLive = runtimeAutoLive(s, profiles, this.lastAutoPick)
    const live = { autoLive }
    try { cfg = buildConfig(profiles, s, { api: this.api, selfExe: this.selfExe, autoLive }) }
    catch { this.set({ phase: 'error', error: 'Не удалось подготовить конфиг движка' }); return }
    this.ids = usedProfiles(s, profiles, live).map(p => p.id)
    this.groups = liveGroups(withAuto(s, profiles, autoLive), new Set(profiles.filter(p => !p.revoked).map(p => p.id)))
    this.firstSelected = new Map(this.groups.map(g => [g.id, g.members[0]]))
    this.slowStreak = new Map()
    const auto = this.groups.find(g => g.id === AUTO_ID)
    const explicit = usedProfiles(withoutAuto(s), profiles).map(p => p.id)
    this.autoOnly = auto ? auto.members.filter(m => !explicit.includes(m)) : []
    const total = autoMembers(profiles).length
    this.autoPool = auto ? { live: auto.members.length, total } : undefined
    this.autoCursor = 0
    this.lastHealth = {}
    const groups = fallbackGroups(profiles, s, live)
    this.fb = new FbTracker(groups)
    this.fbRoutes = new Map(groups.map(g => [g.tag, activeRoutes(s).filter(r => r.via === g.main && r.fallback === g.fb).map(r => ({ id: r.id, name: r.name }))]))
    const file = join(this.dir, 'run.json')
    try {
      writeFileSync(file, JSON.stringify(cfg, null, 1), { mode: 0o600 })
      protectPrivateFile(file)
    }
    catch {
      try { rmSync(file, { force: true }) } catch {}
      this.set({ phase: 'error', error: 'Не удалось записать временный конфиг движка' })
      return
    }
    this.set({ phase: 'starting', error: undefined, recovery: undefined, since: undefined, pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0 })
    const child = spawn(this.exe, ['run', '-c', file, '-D', this.dir, '--disable-color'], { windowsHide: true, cwd: this.dir })
    this.child = child
    child.stdout?.on('data', d => this.push(String(d)))
    child.stderr?.on('data', d => this.push(String(d)))
    child.on('exit', code => {
      if (this.child !== child) return
      this.journal.clear()
      this.child = undefined
      this.halt()
      // stopNow owns the final state while a deliberate stop is in progress.  Emitting
      // another `off` from this asynchronous handler can otherwise overwrite the
      // more useful startup error that startNow publishes immediately afterwards.
      if (this.stopping) return
      const fatal = this.tail.filter(l => /FATAL|ERROR/.test(l)).pop()
      this.set({ phase: 'error', engine: 'down', since: undefined, error: humanize(fatal) ?? `Движок завершился (код ${code})` })
      // R2.4: a crashed core may leave its adapter/routes behind; check read-only and block the next start if so
      void this.serialize(async () => { const r = await this.residue(); if (r && !this.child) this.set({ error: r.text, recovery: r.kind }) })
    })
    child.on('error', e => {
      if (this.child !== child) return
      this.journal.clear()
      this.child = undefined
      this.halt()
      this.set({ phase: 'error', engine: 'down', since: undefined, error: `Движок не запустился: ${e.message}` })
    })
    if (!(await this.journal.record(child.pid)) || this.child !== child) {
      const stopped = await this.stopNow()
      try { rmSync(file, { force: true }) } catch {}
      // A process without a verified lease must never be followed by another engine start.
      this.recoveryOk = false
      this.set({ phase: 'error', error: stopped
        ? 'Не удалось записать владельца процесса движка; запуск остановлен'
        : 'Не удалось подтвердить остановку движка без записи владельца; повторный запуск заблокирован' })
      return
    }
    // R1.2: give Windows the time to open Wintun (or the core to fail by itself); one start, no retry loop
    const ok = (await waitReady({ probe: async () => !!(await this.req('/version', 800)), alive: () => this.child === child, budget: START_BUDGET_MS })) === 'ready'
    try { rmSync(file, { force: true }) } catch {}
    if (!ok || !this.child) {
      if (this.child) await this.stopNow()
      if (this.status.phase !== 'error') {
        const diagnostic = this.tail.filter(l => /FATAL|ERROR|open interface take too much time/i.test(l)).pop()
        this.set({ phase: 'error', engine: 'down', since: undefined, error: humanize(diagnostic) ?? 'Движок не стартовал' })
      }
      return
    }
    this.timer = setInterval(() => void this.poll(), 1000)
    // Controller readiness is the start boundary. Health probes continue independently and must
    // not keep the whole UI in Starting for several seconds.
    this.set({ phase: 'on', since: Date.now(), engine: 'up' })
    // C08: 'on' = engine + controller up; tunnels carry their own health; the error line only when every tunnel is DOWN
    const health = new Health()
    let roundBusy = false
    const round = async (first: boolean) => {
      if (roundBusy || this.child !== child) return
      roundBusy = true
      try {
        const ids = this.probeIds()
        const pings = await this.pingAll(ids)
        if (this.child !== child) return
        const fallback = await this.fbStep(pings)
        if (this.child !== child) return
        // only probed ids get a verdict; an unsampled Auto candidate keeps its last evidence (or none)
        const h = { ...this.lastHealth, ...health.step(pings, ids) }
        this.lastHealth = h
        await this.groupStep(h, pings)
        if (this.child !== child) return
        const allDown = ids.length > 0 && ids.every(id => h[id] === 'down')
        const noneYet = first && ids.length > 0 && ids.every(id => h[id] !== 'ok')
        const error = allDown ? 'Серверы не отвечают (две проверки подряд). Движок работает, проблема на стороне туннелей' : noneYet ? 'Серверы пока не ответили, проверяю ещё раз' : undefined
        this.lastAutoPick = this.firstSelected.get(AUTO_ID) ?? this.lastAutoPick
        this.set({ engine: 'up', pings, health: h, fallback, error, picked: Object.fromEntries(this.firstSelected), autoPool: this.autoPool })
      } catch {
        if (this.child === child) this.set({ error: 'Не удалось обновить состояние туннелей; повторю проверку' })
      } finally { roundBusy = false }
    }
    void round(true)
    if (this.child === child) this.pingTimer = setInterval(() => void round(false), 15000)
  }

  private halt() {
    clearInterval(this.timer); clearInterval(this.pingTimer)
    this.timer = this.pingTimer = undefined
    this.last = undefined
    this.conns = []
    this.emit('conns', this.conns)
  }

  stop(): Promise<boolean> {
    return this.serialize(() => this.stopNow())
  }

  /** R2 (A + C): graceful CTRL_BREAK to the verified owned core, bounded wait; then a forced stop through our own
   *  child handle (it cannot hit a reused PID), bounded wait; then a read-only residue check. 'off' only when clean. */
  private async stopNow(): Promise<boolean> {
    const c = this.child
    if (!c) { this.set({ phase: 'off', engine: 'down', since: undefined }); return true }
    this.stopping = true
    this.set({ phase: 'stopping' })
    let exited = c.exitCode !== null || c.signalCode !== null
    if (!exited && c.pid && (await this.journal.owned(c.pid)) === 'same') {
      await this.breakSignal(c.pid)
      exited = await waitExit(c, this.gracefulMs)
    }
    if (!exited) {
      try { c.kill() } catch { /* the wait below decides */ }
      exited = await waitExit(c, this.killMs)
    }
    if (!exited) { this.set({ phase: 'error', error: 'Движок не подтвердил остановку. Новый туннель не будет запущен' }); return false }
    this.journal.clear()
    this.child = undefined
    this.halt()
    const zero = { pings: {}, fallback: {}, down: 0, up: 0 }
    const r = await this.residue()
    if (r) { this.set({ phase: 'error', engine: 'down', since: undefined, error: r.text, recovery: r.kind, ...zero }); return true }
    this.set({ phase: 'off', engine: 'down', since: undefined, error: undefined, recovery: undefined, ...zero })
    return true
  }

  /** R2.3: read-only check that our adapter / subnet routes are gone (Windows may need a moment after the core exits) */
  private async residue(): Promise<Extract<Preflight, { ok: false }> | undefined> {
    if (!this.preflight) return undefined
    let pf = await this.preflight()
    for (let i = 0; i < 2 && !pf.ok && pf.kind === 'tun_stale'; i++) { await new Promise(r => setTimeout(r, this.preflightGap)); pf = await this.preflight() }
    return pf.ok ? undefined : pf
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = this.transition.then(job, job)
    this.transition = run.then(() => undefined, () => undefined)
    return run
  }

  stopSync() {
    if (!this.child) return
    this.stopping = true
    try { this.child.kill() } catch {}
  }

  private async select(tag: string, to: string): Promise<boolean> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 3000)
    try {
      const r = await fetch(`http://127.0.0.1:${this.api.port}/proxies/${encodeURIComponent(tag)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${this.api.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: to }),
        signal: ctl.signal
      })
      return r.ok
    } catch { return false } finally { clearTimeout(t) }
  }

  private async fbStep(pings: Record<string, number | undefined>): Promise<Record<string, string>> {
    const done = await this.fb.step(pings, (g, toFb) => this.select(g.tag, tagOf(toFb ? g.fb : g.main)))
    for (const d of done) this.emit('fallback', { main: d.g.main, fb: d.g.fb, toFb: d.toFb, routes: (this.fbRoutes.get(d.g.tag) ?? []).map(r => r.name) })
    const out: Record<string, string> = {}
    for (const g of this.fb.active()) for (const r of this.fbRoutes.get(g.tag) ?? []) out[r.id] = g.fb
    return out
  }

  /** W2.2: Waarp, not sing-box, moves group selections: confirmed failure or a sustained clear speed gap only */
  private async groupStep(health: Record<string, TunnelHealth>, pings: Record<string, number | undefined>): Promise<void> {
    await Promise.all(this.groups.map(async g => {
      const current = this.firstSelected.get(g.id) ?? g.members[0]
      let next = current
      if (g.policy === 'first') next = firstAlive(g.members, current, health)
      else { const r = stickyFastest(g.members, current, health, pings, this.slowStreak.get(g.id) ?? 0); next = r.next; this.slowStreak.set(g.id, r.streak) }
      if (next !== current && await this.select(grpTag(g.id), tagOf(next))) this.firstSelected.set(g.id, next)
    }))
  }

  private async req(path: string, timeout = 3000): Promise<any> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeout)
    try {
      const r = await fetch(`http://127.0.0.1:${this.api.port}${path}`, { headers: { Authorization: `Bearer ${this.api.secret}` }, signal: ctl.signal })
      if (!r.ok) return undefined
      return await r.json()
    } catch { return undefined } finally { clearTimeout(t) }
  }

  private async delay(tag: string, url = 'https://www.gstatic.com/generate_204'): Promise<number | undefined> {
    const r = await this.req(`/proxies/${tag}/delay?timeout=6000&url=` + encodeURIComponent(url), 8000)
    return typeof r?.delay === 'number' && r.delay > 0 ? r.delay : undefined
  }

  private async bounded<T>(items: T[], fn: (item: T) => Promise<void>, limit = 8): Promise<void> {
    let cursor = 0
    const worker = async () => {
      while (this.child) {
        const at = cursor++
        if (at >= items.length) return
        await fn(items[at])
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  }

  async probe(target: string, only?: string[]) {
    const url = /^https?:\/\//.test(target) ? target : 'https://' + target
    const out: Record<string, number | null> = {}
    await this.bounded(['direct', ...(only ? this.ids.filter(id => only.includes(id)) : this.ids)], async id => {
      const ms = await this.delay(id === 'direct' ? 'direct' : tagOf(id), url)
      out[id] = ms ?? null
    })
    return out
  }

  /** W3 diagnosis: through the given own paths only; Direct is measured separately by the layered prober */
  async probePaths(target: string, ids: string[]): Promise<Record<string, number | null>> {
    const url = /^https?:\/\//.test(target) ? target : 'https://' + target
    const out: Record<string, number | null> = {}
    await this.bounded(this.ids.filter(id => ids.includes(id)), async id => { out[id] = (await this.delay(tagOf(id), url)) ?? null })
    return out
  }

  /** C08: two independent probe targets per round; one failed site never marks a tunnel broken */
  private async probe2(tag: string): Promise<number | undefined> {
    const a = await this.delay(tag)
    return a ?? (await this.delay(tag, 'https://cp.cloudflare.com/generate_204'))
  }

  /** every id other routes need, plus the bounded Auto sample (current member always included) */
  private probeIds(): string[] {
    if (!this.autoOnly.length) return this.ids
    const s = autoSample(this.autoOnly, this.firstSelected.get(AUTO_ID), this.autoCursor)
    this.autoCursor = s.cursor
    const skip = new Set(this.autoOnly)
    return [...this.ids.filter(id => !skip.has(id)), ...s.probe]
  }

  async pingAll(ids = this.ids) {
    const out: Record<string, number | undefined> = {}
    await this.bounded(['direct', ...ids], async id => { out[id] = id === 'direct' ? await this.delay('direct') : await this.probe2(tagOf(id)) })
    // A group's latency is the measured latency of its actually selected member.
    // Do not report the minimum of unrelated members as though it were the active route.
    await Promise.all(this.groups.map(async g => {
      const state = await this.req(`/proxies/${grpTag(g.id)}`)
      const selected = typeof state?.now === 'string' ? g.members.find(id => tagOf(id) === state.now) : undefined
      out[g.id] = selected ? out[selected] : undefined
    }))
    return out
  }

  private async poll() {
    const r = await this.req('/connections', 2000)
    if (!r) return
    const now = Date.now()
    const d = r.downloadTotal ?? 0, u = r.uploadTotal ?? 0
    if (this.last) {
      const dt = Math.max(0.2, (now - this.last.t) / 1000)
      this.set({ down: Math.max(0, (d - this.last.d) / dt), up: Math.max(0, (u - this.last.u) / dt), downTotal: d, upTotal: u })
    }
    this.last = { t: now, d, u }
    this.conns = (r.connections ?? []).map((c: any): Conn => {
      const m = c.metadata ?? {}
      const exe: string = m.processPath ?? ''
      const chain: string[] = c.chains ?? []
      return {
        id: c.id,
        app: exe ? exe.split('\\').pop()!.replace(/\.exe$/i, '') : (m.process || 'система'),
        exe,
        host: m.host || m.destinationIP || '',
        port: Number(m.destinationPort) || 0,
        net: m.network ?? '',
        via: chain.find(c => c.startsWith('p-'))?.slice(2) ?? 'direct',
        rule: c.rule ?? '',
        down: c.download ?? 0,
        up: c.upload ?? 0,
        start: Date.parse(c.start) || now
      }
    })
    this.emit('conns', this.conns)
  }

}

function humanize(line?: string): string | undefined {
  if (!line) return undefined
  if (/access is denied|operation not permitted|requires elevation|Отказано/i.test(line)) return 'Нужны права администратора, чтобы создать сетевой адаптер'
  if (/address already in use|bind:/i.test(line)) return 'Порт занят: похоже, ещё одна копия Waarp уже работает'
  if (/open interface take too much time/i.test(line)) return 'Windows не успел открыть адаптер Waarp. Туннель остановлен; чужие подключения не менялись'
  if (/configure tun|create tun|wintun/i.test(line)) return 'Не удалось создать адаптер. Закрой другие VPN и попробуй ещё раз'
  if (/decode|private key|public key|base64/i.test(line)) return 'Ключи в конфиге битые. Переимпортируй конфиг'
  return line.replace(/^.*?(FATAL|ERROR)\[\d+\]\s*/, '').slice(0, 220)
}
