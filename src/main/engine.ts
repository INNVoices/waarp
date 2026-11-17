import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isIP } from 'node:net'
import type { Conn, Profile, Route, Settings, Status, TunnelHealth } from '../shared/types'
import { activeRoutes, buildConfig, buildRuntime, CANARY, CANARY_IP, canaryFile, fallbackGroups, liveSwitches, loadedOf, loadedSets, planSlots, redact, ruleFileOf, runtimeAutoLive, tagOf, usedProfiles, withoutAuto, type Loaded } from './awg'
import { routeHits } from '../shared/appmatch'
import { AUTO_ID, autoMembers, autoSample, firstAlive, grpTag, liveGroups, stickyFastest, withAuto, type LiveGroup } from '../shared/groups'
import { FbTracker } from './fallback'
import { Health, validLatency } from './health'
import { redactVless, vlessSecrets } from './vless'
import { outSecrets } from './links'
import { openVpnSecrets } from './openvpn'
import { RuntimeJournal, type ProcessIdentity } from './runtime-journal'
import { protectPrivateFile } from './private-file'
import { pickPort, START_BUDGET_MS, untilCancelled, waitReady, type Preflight } from './tun'
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
  private recoveryError?: string
  private transition: Promise<void> = Promise.resolve()
  /** OFF cancels both the active startup and starts already queued before that command. */
  private stopVersion = 0
  private starting?: AbortController
  private requests = new Set<AbortController>()
  private polling?: object
  private pollFailures = 0
  /** HOTFIX-RUNTIME-01: the running core's config, what it loaded and its Auto pool; set on a ready start, cleared on halt */
  private run?: { cfg: ReturnType<typeof buildConfig>; loaded: Loaded; autoLive: string[]; files: Record<string, string>; settings: Settings; hostV6?: boolean }
  /** count of live route applies in this process (tests, log) */
  liveApplies = 0
  private pingSeq = 0
  /** R1.4: read-only Windows check before a TUN start (set by main); absent in offline tests */
  preflight?: () => Promise<Preflight>
  /** pause between preflight re-checks right after our own stop (Windows may still be removing the adapter) */
  preflightGap = 1500
  /** R2: best-effort CTRL_BREAK for the owned core if it has an isolated console; injectable for tests */
  breakSignal: (pid: number, identity: ProcessIdentity) => Promise<boolean> = (pid, identity) => ctrlBreak(pid, identity)
  gracefulMs = 5000
  killMs = 4000
  hostV6?: () => Promise<boolean | undefined>
  sink?: (lines: string[]) => void
  clearGhost?: () => Promise<string>

  constructor(private exe: string, private dir: string, private selfExe: string) {
    super()
    this.journal = new RuntimeJournal(dir, exe, 'run.json')
  }

  log(): string[] { return this.tail.slice(-300) }
  get recoveryReady(): boolean { return this.recoveryOk }

  private set(s: Partial<Status>) {
    const prev = this.status
    this.status = { ...this.status, ...s }
    if (s.phase && s.phase !== prev.phase) this.push(`[phase] ${prev.phase} -> ${s.phase}${this.status.error ? ' | ' + this.status.error : ''}`)
    else if (s.error && s.error !== prev.error) this.push(`[error] ${s.error}`)
    this.emit('status', this.status)
  }

  private push(line: string) {
    const added: string[] = []
    for (const l of line.split(/\r?\n/)) {
      if (!l.trim()) continue
      added.push(redactVless(redact(l.replace(/\x1b\[[0-9;]*m/g, '')), this.secrets))
    }
    this.tail.push(...added)
    if (this.tail.length > 600) this.tail.splice(0, this.tail.length - 600)
    if (added.length) try { this.sink?.(added) } catch {}
  }

  private clearJournal(): boolean {
    if (this.journal.clear() !== false) return true
    this.recoveryOk = false
    this.recoveryError = this.journal.lastError ?? 'Процесс закрыт, но его временные файлы не удалены. Повтори восстановление'
    this.push(`[recovery:cleanup] ${this.recoveryError}`)
    return false
  }

  killOrphans(otherRuntimesOk = true, otherError?: string): Promise<boolean> {
    return this.serialize(async () => {
      const previousError = this.recoveryError
      this.recoveryOk = false
      let error: string | undefined
      try {
        // Recovery reconciles a previous run. It must never terminate a core started by
        // this instance while a late bootstrap/reset callback was waiting in the queue.
        if (this.child) error = 'Движок ещё работает. Сначала закрой Waarp, затем повтори восстановление'
        else if (!(await this.journal.recover())) error = this.journal.lastError ?? 'Не удалось восстановить прошлый процесс движка. Повтори восстановление'
        else if (!otherRuntimesOk) error = otherError ?? 'Проверочный движок не подтвердил остановку. Повтори восстановление'
        else {
          const inspected = await RuntimeJournal.inspectUntracked(this.exe)
          if (!inspected.ok) error = inspected.error
        }
      } catch {
        error = 'Не удалось проверить прошлые процессы Waarp. Повтори восстановление; подробности доступны в диагностике'
      }
      this.recoveryError = error
      this.recoveryOk = !error
      if (error) {
        this.push(`[recovery:engine] ${error}`)
        this.set({ phase: 'error', error })
      } else {
        this.push('[recovery:engine] Предыдущие процессы проверены; запуск разрешён')
        if (previousError && this.status.error === previousError) this.set({ phase: 'off', engine: 'down', since: undefined, error: undefined })
      }
      return this.recoveryOk
    })
  }

  start(profiles: Profile[], s: Settings): Promise<void> {
    const version = this.stopVersion
    return this.serialize(async () => {
      if (version !== this.stopVersion) return
      const controller = new AbortController()
      this.starting = controller
      try { await this.startNow(profiles, s, controller.signal) }
      finally { if (this.starting === controller) this.starting = undefined }
    })
  }

  /** HOTFIX-RUNTIME-01: a routing change the running core can already serve, as selector switches (no stop, no spawn, no
   *  Windows scan). false = not applicable now; the caller then takes its normal path (scan + one restart). `start` itself
   *  always restarts, so resume / explicit restarts keep their meaning. */
  applyLive(profiles: Profile[], s: Settings): Promise<boolean> {
    const version = this.stopVersion
    return this.serialize(async () => (version === this.stopVersion && this.child && this.status.phase === 'on' && this.run ? this.liveApply(profiles, s) : false))
  }

  private async startNow(profiles: Profile[], s: Settings, signal: AbortSignal, retry = true): Promise<void> {
    if (!this.recoveryOk) {
      this.set({ phase: 'error', error: this.recoveryError ?? 'Проверка прошлых процессов ещё не завершена. Дождись восстановления и повтори запуск' })
      return
    }
    const began = Date.now()
    let clean = false
    if (this.child) { if (!(await this.stopNow())) return; clean = true }
    if (signal.aborted) return
    if (!existsSync(this.exe)) { this.set({ phase: 'error', error: 'Не найден движок engine\\sing-box.exe' }); return }
    this.stopping = false
    this.tail = []
    // HOTFIX-RUNTIME-01 B: the local port pick does not depend on the Windows check, so both run together;
    // the preflight itself is still a fresh read just before spawn, with the same stale-adapter re-checks
    const fresh = async (): Promise<Preflight> => {
      if (!this.preflight || clean) return { ok: true }
      let pf = await this.preflight()
      for (let i = 0; i < 2 && !signal.aborted && !pf.ok && pf.kind === 'tun_stale'; i++) { await untilCancelled(new Promise(r => setTimeout(r, this.preflightGap)), signal); if (!signal.aborted) pf = await this.preflight() }
      return pf
    }
    const v6 = async () => { try { return await this.hostV6?.() } catch { return undefined } }
    const ghost = async () => {
      const state = await this.clearGhost?.().catch(() => 'unknown')
      if (state === 'removed') this.push('[start] removed a leftover Waarp adapter left by a previous engine')
      else if (state === 'left') this.push('[start] a leftover Waarp adapter is still being removed by Windows')
    }
    const prepared = await untilCancelled(Promise.all([fresh(), pickPort(), v6(), ghost()]), signal)
    if (!prepared || signal.aborted) return
    const [pf, port, hostV6] = prepared
    if (!pf.ok) { this.set({ phase: 'error', engine: 'down', since: undefined, error: pf.text, recovery: pf.kind }); return }
    if (!port) { this.set({ phase: 'error', error: 'Нет свободного локального порта для управления движком. Туннель не запущен', recovery: undefined }); return }
    this.api = { port, secret: randomBytes(16).toString('hex') }
    this.secrets = profiles.flatMap(p => (p.kind === 'vless' ? vlessSecrets(p) : p.kind === 'out' ? outSecrets(p) : p.kind === 'openvpn' ? openVpnSecrets(p) : []))
    let cfg: ReturnType<typeof buildConfig>
    let files: Record<string, string>
    // R5: the core gets a bounded Auto live pool; the plan/UI keep the full logical Auto membership
    const autoLive = runtimeAutoLive(s, profiles, this.lastAutoPick)
    const live = { autoLive }
    const preload = profiles.filter(p => !p.revoked && p.kind !== 'openvpn' && (p as { source?: string }).source !== 'public' && (p.kind !== 'awg' || isIP(p.peer.host) !== 0)).slice(0, 8).map(p => p.id)
    const slots = planSlots(s)!
    const ruleDir = join(this.dir, 'rules')
    try { ({ cfg, files } = buildRuntime(profiles, s, { api: this.api, selfExe: this.selfExe, autoLive, selectors: true, slots, ruleDir, hostV6, preload })) }
    catch { this.set({ phase: 'error', error: 'Не удалось подготовить конфиг движка' }); return }
    try {
      mkdirSync(ruleDir, { recursive: true })
      for (const [tag, body] of Object.entries(files)) writeFileSync(join(ruleDir, ruleFileOf(tag)), body)
      writeFileSync(join(ruleDir, ruleFileOf(CANARY)), canaryFile('start.waarp.invalid'))
    } catch { this.set({ phase: 'error', error: 'Не удалось записать временный конфиг движка' }); return }
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
      mkdirSync(this.dir, { recursive: true })
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
    child.stdout?.on('data', d => { if (this.child === child) this.push(String(d)) })
    child.stderr?.on('data', d => { if (this.child === child) this.push(String(d)) })
    child.on('exit', code => {
      if (this.child !== child) return
      this.clearJournal()
      this.child = undefined
      this.halt()
      // stopNow owns the final state while a deliberate stop is in progress.  Emitting
      // another `off` from this asynchronous handler can otherwise overwrite the
      // more useful startup error that startNow publishes immediately afterwards.
      if (this.stopping) return
      const fatal = this.tail.filter(l => /FATAL|ERROR/.test(l)).pop()
      if (retry && ADAPTER_CLASH.test(fatal ?? '')) return
      this.set({ phase: 'error', engine: 'down', since: undefined, error: humanize(fatal) ?? `Движок завершился (код ${code})` })
      // R2.4: a crashed core may leave its adapter/routes behind; check read-only and block the next start if so
      void this.serialize(async () => { const r = await this.residue(); if (r && !this.child) this.set({ error: r.text, recovery: r.kind }) })
    })
    child.on('error', e => {
      if (this.child !== child) return
      // ChildProcess also emits error when signalling fails. Keep the live handle/lease until exit is proved.
      if (child.pid && child.exitCode === null && child.signalCode === null) { this.set({ phase: 'error', error: `Ошибка процесса движка: ${e.message}` }); return }
      this.clearJournal()
      this.child = undefined
      this.halt()
      this.set({ phase: 'error', engine: 'down', since: undefined, error: `Движок не запустился: ${e.message}` })
    })
    // A failed OS spawn emits `error`, not `exit`. Wait for that diagnostic instead
    // of trying to journal/stop an absent PID and waiting for an exit that cannot fire.
    if (!child.pid) { await new Promise<void>(resolve => child.once('error', () => resolve())); return }
    const recorded = await this.journal.record(child.pid)
    if (!recorded || this.child !== child) {
      // A fast spawn/config failure can exit while PowerShell is still obtaining the
      // identity. Keep the actual startup error; a dead child is not an orphan.
      if (this.child !== child) {
        this.clearJournal()
        return
      }
      const recordError = this.journal.lastError
      const stopped = await this.stopNow()
      // A live unverified child may still be reading this config. Retain it with the
      // lease until cleanup can prove that exact child has stopped.
      if (!this.child) { try { rmSync(file, { force: true }) } catch {} }
      // A process without a verified lease must never be followed by another engine start.
      this.recoveryOk = false
      this.recoveryError = stopped
        ? `Не удалось записать владельца процесса движка; запуск остановлен. ${recordError ?? 'Повтори запуск, чтобы проверить восстановление'}`
        : 'Не удалось подтвердить остановку движка без записи владельца. Нажми «Восстановить» перед повторным запуском'
      this.push(`[recovery:record] ${this.recoveryError}`)
      this.set({ phase: 'error', error: this.recoveryError })
      return
    }
    // R1.2: give Windows the time to open Wintun (or the core to fail by itself); one start, no retry loop
    const ok = (await waitReady({ probe: async () => !!(await this.req('/version', 800)), alive: () => this.child === child, signal, budget: START_BUDGET_MS })) === 'ready'
    try { rmSync(file, { force: true }) } catch {}
    if (signal.aborted) { await this.stopNow(); return }
    if (!ok || this.child !== child) {
      if (this.child) await this.stopNow()
      if (retry && !signal.aborted && this.tail.some(l => ADAPTER_CLASH.test(l))) {
        this.push('[start] Windows still held the previous Waarp adapter; clearing it and starting again')
        return this.startNow(profiles, s, signal, false)
      }
      if (this.status.phase !== 'error') {
        const diagnostic = this.tail.filter(l => /FATAL|ERROR|open interface take too much time/i.test(l)).pop()
        this.set({ phase: 'error', engine: 'down', since: undefined, error: humanize(diagnostic) ?? 'Движок не стартовал' })
      }
      return
    }
    this.run = { cfg, loaded: { ...loadedOf(loadedSets(profiles, s, { ...live, preload })), slots }, autoLive, files, settings: s, hostV6 }
    this.push(`[start] ready in ${Date.now() - began} ms; card slots ${slots.app.length}+${slots.dom.length}; host IPv6 ${hostV6 === undefined ? 'unknown' : hostV6 ? 'yes' : 'no'}`)
    this.timer = setInterval(() => void this.poll(), 1000)
    // Controller readiness is the start boundary. Health probes continue independently and must
    // not keep the whole UI in Starting for several seconds.
    this.set({ phase: 'on', since: Date.now(), engine: 'up' })
    // C08: 'on' = engine + controller up; tunnels carry their own health; the error line only when every tunnel is DOWN
    const health = new Health()
    let roundBusy = false
    const round = async (first: boolean) => {
      if (roundBusy || this.child !== child || this.stopping || this.pollFailures >= 2) return
      roundBusy = true
      try {
        const ids = this.probeIds()
        const pings = await this.pingAll(ids)
        if (this.child !== child || this.stopping || this.pollFailures >= 2) return
        const fallback = await this.fbStep(pings)
        if (this.child !== child || this.stopping || this.pollFailures >= 2) return
        // only probed ids get a verdict; an unsampled Auto candidate keeps its last evidence (or none)
        const h = { ...this.lastHealth, ...health.step(pings, ids, undefined, this.ids) }
        this.lastHealth = h
        await this.groupStep(h, pings)
        if (this.child !== child || this.stopping || this.pollFailures >= 2) return
        // A failed rotating batch is not proof that every loaded path is down.
        // Unmeasured members and older successful evidence prevent that claim.
        const allDown = this.ids.length > 0 && this.ids.every(id => h[id] === 'down')
        const noneYet = first && ids.length > 0 && ids.every(id => h[id] !== 'ok')
        const error = allDown ? 'Туннели не ответили на две проверки подряд. Проверь сеть или смени подключение' : noneYet ? 'Серверы пока не ответили, проверяю ещё раз' : undefined
        this.lastAutoPick = this.firstSelected.get(AUTO_ID) ?? this.lastAutoPick
        this.set({ engine: 'up', pings, pingRound: ++this.pingSeq, pingAt: Date.now(), health: h, fallback, error, picked: Object.fromEntries(this.firstSelected), autoPool: this.autoPool })
      } catch {
        if (this.child === child && !this.stopping && this.pollFailures < 2) this.set({ error: 'Не удалось обновить состояние туннелей; повторю проверку' })
      } finally { roundBusy = false }
    }
    void round(true)
    if (this.child === child) this.pingTimer = setInterval(() => void round(false), 15000)
  }

  /** HOTFIX-RUNTIME-01: switch route selectors in the running core when the new settings need nothing it has not loaded.
   *  false = not live-applicable (or a switch failed): the caller does the one controlled restart. Keeps Auto pool, groups,
   *  fallback pairs and loaded paths exactly as running; DNS of each route follows its own selector. */
  private async liveApply(profiles: Profile[], s: Settings): Promise<boolean> {
    const run = this.run!, child = this.child, version = this.stopVersion
    const current = () => this.child === child && this.stopVersion === version && !this.stopping
    const slots = planSlots(s, run.loaded.slots)
    if (!slots) { this.push('[apply] no free card slot; restarting the core once'); return false }
    let next: ReturnType<typeof buildRuntime>
    try { next = buildRuntime(profiles, s, { api: this.api, selfExe: this.selfExe, autoLive: run.autoLive, selectors: true, keep: run.loaded, slots, ruleDir: join(this.dir, 'rules'), hostV6: run.hostV6 }) }
    catch { return false }
    const switches = liveSwitches(run.cfg, next.cfg)
    if (!switches) { this.push('[apply] the change needs a new tunnel or core setting; restarting the core once'); return false }
    for (const x of switches) {
      if (!current() || !(await this.select(x.tag, x.to))) { this.push(`live route apply failed at ${x.tag}; restarting the core once`); return false }
    }
    const changed = Object.keys(next.files).filter(k => next.files[k] !== run.files[k])
    if (changed.length && !(await this.writeRules(changed, next.files, current))) { this.push('[apply] the core did not confirm the new card rules; restarting the core once'); return false }
    if (!current()) return false
    this.run = { ...run, cfg: next.cfg, files: next.files, loaded: { ...run.loaded, slots }, settings: s }
    this.fbRoutes = new Map(run.loaded.fbs.map(g => [g.tag, activeRoutes(s).filter(r => r.via === g.main && r.fallback === g.fb).map(r => ({ id: r.id, name: r.name }))]))
    this.liveApplies++
    const closed = await this.closeTouched(run.settings.routes, s.routes)
    this.push(`live route apply: ${switches.length} selector switch(es), ${changed.length} rule file(s) written, canary confirmed; connections closed ${closed.closed}/${closed.tried}; core and TUN kept`)
    this.set({ error: undefined })
    return true
  }

  private async writeRules(names: string[], files: Record<string, string>, current: () => boolean): Promise<boolean> {
    const dir = join(this.dir, 'rules')
    const put = async (name: string, body: string) => {
      const file = join(dir, name), tmp = file + '.tmp'
      writeFileSync(tmp, body)
      for (let i = 0; i < 5; i++) {
        try { renameSync(tmp, file); return } catch { await new Promise(r => setTimeout(r, 40)) }
      }
      writeFileSync(file, body)
      try { rmSync(tmp, { force: true }) } catch {}
    }
    try {
      mkdirSync(dir, { recursive: true })
      for (const n of names) await put(ruleFileOf(n), files[n])
    } catch { return false }
    const probe = randomBytes(6).toString('hex') + '.waarp.invalid'
    try { await put(ruleFileOf(CANARY), canaryFile(probe)) } catch { return false }
    const end = Date.now() + 3000
    while (Date.now() < end && current()) {
      const r = await this.req(`/dns/query?name=${probe}&type=A`, 1000)
      if (JSON.stringify(r ?? '').includes(CANARY_IP)) return true
      await new Promise(res => setTimeout(res, 100))
    }
    return false
  }

  private async closeTouched(before: Route[], after: Route[]): Promise<{ tried: number; closed: number }> {
    const key = (r: Route) => JSON.stringify([r.on, r.kind, r.exe, r.matchDir, r.wholeDir, r.preset, r.value])
    const was = new Map(before.map(r => [r.id, r]))
    const now = new Map(after.map(r => [r.id, r]))
    const touched: Route[] = []
    for (const r of after) { const o = was.get(r.id); if (!o ? r.on : key(o) !== key(r)) touched.push(r, ...(o ? [o] : [])) }
    for (const o of before) if (!now.has(o.id) && o.on) touched.push(o)
    const kept = after.filter(r => was.has(r.id)).map(r => r.id)
    const prior = before.filter(r => now.has(r.id)).map(r => r.id)
    kept.forEach((id, i) => { if (prior[i] !== id) touched.push(now.get(id)!, was.get(id)!) })
    if (!touched.length) return { tried: 0, closed: 0 }
    const ids = this.conns.filter(c => touched.some(r => routeHits(r, c))).map(c => c.id)
    let closed = 0
    await this.bounded(ids, async id => { if (await this.drop(id)) closed++ })
    return { tried: ids.length, closed }
  }

  private async drop(id: string): Promise<boolean> {
    const child = this.child, api = this.api
    if (!child || this.stopping) return false
    const ctl = new AbortController()
    this.requests.add(ctl)
    const t = setTimeout(() => ctl.abort(), 2000)
    try { return (await fetch(`http://127.0.0.1:${api.port}/connections/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${api.secret}` }, signal: ctl.signal })).ok }
    catch { return false } finally { clearTimeout(t); this.requests.delete(ctl) }
  }

  private abortRequests() {
    for (const controller of this.requests) controller.abort()
    this.requests.clear()
  }

  private halt() {
    this.abortRequests()
    this.polling = undefined
    this.pollFailures = 0
    this.run = undefined
    clearInterval(this.timer); clearInterval(this.pingTimer)
    this.timer = this.pingTimer = undefined
    this.last = undefined
    this.conns = []
    this.emit('conns', this.conns)
  }

  stop(): Promise<boolean> {
    this.stopVersion++
    this.starting?.abort()
    this.abortRequests()
    return this.serialize(() => this.stopNow())
  }

  /** R2 (A + C): try CTRL_BREAK to the verified owned core, wait only if sent; then a forced stop through our own
   *  child handle (it cannot hit a reused PID), bounded wait; then a read-only residue check. 'off' only when clean. */
  private async stopNow(): Promise<boolean> {
    const c = this.child
    if (!c) {
      // A second stop after a crash/residue failure must not turn an unclean state into a successful reset.
      const r = this.status.recovery ? await this.residue() : undefined
      if (r) { this.set({ phase: 'error', engine: 'down', since: undefined, error: r.text, recovery: r.kind }); return false }
      this.halt()
      const error = !this.recoveryOk ? this.recoveryError : undefined
      this.set({ phase: error ? 'error' : 'off', engine: 'down', since: undefined, error, recovery: undefined, pings: {}, health: {}, picked: {}, fallback: {}, autoPool: undefined, down: 0, up: 0 })
      return true
    }
    this.stopping = true
    this.abortRequests()
    this.set({ phase: 'stopping' })
    let exited = c.exitCode !== null || c.signalCode !== null
    if (!exited && c.pid && (await this.journal.owned(c.pid)) === 'same') {
      const identity = this.journal.recordedIdentity(c.pid)
      if (identity) {
        if (await this.breakSignal(c.pid, identity)) exited = await waitExit(c, this.gracefulMs)
        else this.push('[stop] CTRL_BREAK не отправлен: нет подтверждённой отдельной консоли. Закрываю собственный процесс по сохранённому дескриптору')
      }
    }
    if (!exited) {
      try { c.kill() } catch { /* the wait below decides */ }
      exited = await waitExit(c, this.killMs)
    }
    if (!exited) { this.set({ phase: 'error', error: 'Движок не подтвердил остановку. Новый туннель не будет запущен' }); return false }
    const cleaned = this.clearJournal()
    this.child = undefined
    this.halt()
    const zero = { pings: {}, health: {}, picked: {}, fallback: {}, autoPool: undefined, down: 0, up: 0 }
    const r = await this.residue()
    if (r) {
      this.set({ phase: 'error', engine: 'down', since: undefined, error: r.text, recovery: r.kind, ...zero })
      // The process is gone, but the network state is not clean. Callers such as net:reset
      // must not report success while a stale adapter/route is still present.
      return false
    }
    if (!cleaned) { this.set({ phase: 'error', engine: 'down', since: undefined, error: this.recoveryError, ...zero }); return false }
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
    this.stopVersion++
    this.starting?.abort()
    this.abortRequests()
    if (!this.child) return
    this.stopping = true
    try { this.child.kill() } catch {}
  }

  private async select(tag: string, to: string): Promise<boolean> {
    const child = this.child, api = this.api, version = this.stopVersion
    if (!child || this.stopping) return false
    const ctl = new AbortController()
    this.requests.add(ctl)
    const t = setTimeout(() => ctl.abort(), 3000)
    try {
      const r = await fetch(`http://127.0.0.1:${api.port}/proxies/${encodeURIComponent(tag)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${api.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: to }),
        signal: ctl.signal
      })
      return r.ok && this.child === child && this.api === api && this.stopVersion === version && !this.stopping
    } catch { return false } finally { clearTimeout(t); this.requests.delete(ctl) }
  }

  private async fbStep(pings: Record<string, number | undefined>): Promise<Record<string, string>> {
    const child = this.child, tracker = this.fb
    const done = await tracker.step(pings, (g, toFb) => this.child === child && !this.stopping ? this.select(g.tag, tagOf(toFb ? g.fb : g.main)) : Promise.resolve(false))
    if (this.child !== child || this.stopping) return {}
    for (const d of done) this.emit('fallback', { main: d.g.main, fb: d.g.fb, toFb: d.toFb, routes: (this.fbRoutes.get(d.g.tag) ?? []).map(r => r.name) })
    const out: Record<string, string> = {}
    for (const g of this.fb.active()) for (const r of this.fbRoutes.get(g.tag) ?? []) out[r.id] = g.fb
    return out
  }

  /** W2.2: Waarp, not sing-box, moves group selections: confirmed failure or a sustained clear speed gap only */
  private async groupStep(health: Record<string, TunnelHealth>, pings: Record<string, number | undefined>): Promise<void> {
    const child = this.child
    await Promise.all(this.groups.map(async g => {
      const current = this.firstSelected.get(g.id) ?? g.members[0]
      let next = current
      if (g.policy === 'first') next = firstAlive(g.members, current, health)
      else { const r = stickyFastest(g.members, current, health, pings, this.slowStreak.get(g.id) ?? 0, this.conns.some(c => c.via === current)); next = r.next; this.slowStreak.set(g.id, r.streak) }
      if (next !== current && await this.select(grpTag(g.id), tagOf(next)) && this.child === child && !this.stopping) this.firstSelected.set(g.id, next)
    }))
  }

  private async req(path: string, timeout = 3000): Promise<any> {
    const child = this.child, api = this.api, version = this.stopVersion
    if (!child || this.stopping) return undefined
    const ctl = new AbortController()
    this.requests.add(ctl)
    const t = setTimeout(() => ctl.abort(), timeout)
    try {
      const r = await fetch(`http://127.0.0.1:${api.port}${path}`, { headers: { Authorization: `Bearer ${api.secret}` }, signal: ctl.signal })
      if (!r.ok) return undefined
      const value = await r.json()
      return this.child === child && this.api === api && this.stopVersion === version && !this.stopping ? value : undefined
    } catch { return undefined } finally { clearTimeout(t); this.requests.delete(ctl) }
  }

  private async delay(tag: string, url = 'https://www.gstatic.com/generate_204'): Promise<number | undefined> {
    const r = await this.req(`/proxies/${tag}/delay?timeout=6000&url=` + encodeURIComponent(url), 8000)
    return validLatency(r?.delay) ? r.delay : undefined
  }

  private async bounded<T>(items: T[], fn: (item: T) => Promise<void>, limit = 8): Promise<void> {
    let cursor = 0
    const child = this.child, version = this.stopVersion
    const worker = async () => {
      while (child && this.child === child && this.stopVersion === version && !this.stopping) {
        const at = cursor++
        if (at >= items.length) return
        await fn(items[at])
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  }

  async probe(target: string, only?: string[]) {
    const child = this.child, version = this.stopVersion
    const url = /^https?:\/\//.test(target) ? target : 'https://' + target
    const out: Record<string, number | null> = {}
    await this.bounded(['direct', ...(only ? this.ids.filter(id => only.includes(id)) : this.ids)], async id => {
      const ms = await this.delay(id === 'direct' ? 'direct' : tagOf(id), url)
      out[id] = ms ?? null
    })
    return this.child === child && this.stopVersion === version ? out : {}
  }

  /** W3 diagnosis: through the given own paths only; Direct is measured separately by the layered prober */
  async probePaths(target: string, ids: string[]): Promise<Record<string, number | null>> {
    const child = this.child, version = this.stopVersion
    const url = /^https?:\/\//.test(target) ? target : 'https://' + target
    const out: Record<string, number | null> = {}
    await this.bounded(this.ids.filter(id => ids.includes(id)), async id => { out[id] = (await this.delay(tagOf(id), url)) ?? null })
    return this.child === child && this.stopVersion === version ? out : {}
  }

  /** C08: two independent probe targets per round; one failed site never marks a tunnel broken */
  private async probe2(tag: string): Promise<number | undefined> {
    const child = this.child, version = this.stopVersion
    const a = await this.delay(tag)
    return a ?? (this.child === child && this.stopVersion === version ? await this.delay(tag, 'https://cp.cloudflare.com/generate_204') : undefined)
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
    const child = this.child, version = this.stopVersion
    const out: Record<string, number | undefined> = {}
    await this.bounded(['direct', ...ids], async id => { out[id] = id === 'direct' ? await this.delay('direct') : await this.probe2(tagOf(id)) })
    if (this.child !== child || this.stopVersion !== version) return {}
    // A group's latency is the measured latency of its actually selected member.
    // Do not report the minimum of unrelated members as though it were the active route.
    await Promise.all(this.groups.map(async g => {
      const state = await this.req(`/proxies/${grpTag(g.id)}`)
      const selected = typeof state?.now === 'string' ? g.members.find(id => tagOf(id) === state.now) : undefined
      out[g.id] = selected ? out[selected] : undefined
    }))
    return this.child === child && this.stopVersion === version ? out : {}
  }

  private async poll() {
    const child = this.child, version = this.stopVersion
    if (!child || this.polling || this.stopping) return
    const polling = {}
    this.polling = polling
    try {
      const r = await this.req('/connections', 2000)
      if (this.child !== child || this.stopVersion !== version || this.stopping) return
      if (!r) {
        this.pollFailures++
        if (this.pollFailures >= 2) this.set({ engine: 'down', error: 'Движок не отвечает на локальные запросы. Попробуй отключить и снова включить Waarp' })
        return
      }
      const recovered = this.pollFailures >= 2
      this.pollFailures = 0
      if (recovered) this.set({ engine: 'up', error: undefined })
      const now = Date.now()
      const d = r.downloadTotal ?? 0, u = r.uploadTotal ?? 0
      if (this.last) {
        const dt = Math.max(0.2, (now - this.last.t) / 1000)
        this.set({ down: Math.max(0, (d - this.last.d) / dt), up: Math.max(0, (u - this.last.u) / dt), downTotal: d, upTotal: u })
      }
      this.last = { t: now, d, u }
      const slots = this.run?.loaded.slots
      this.conns = (r.connections ?? []).map((c: any): Conn => {
        const m = c.metadata ?? {}
        const exe: string = m.processPath ?? ''
        const chain: string[] = c.chains ?? []
        const slot = chain.map(x => /^rt-([ad])(\d+)$/.exec(x)).find(Boolean)
        return {
          id: c.id,
          app: exe ? exe.split('\\').pop()!.replace(/\.exe$/i, '') : (m.process || 'система'),
          exe,
          host: m.host || m.destinationIP || '',
          port: Number(m.destinationPort) || 0,
          net: m.network ?? '',
          via: chain.find(c => c.startsWith('p-'))?.slice(2) ?? 'direct',
          rule: c.rule ?? '',
          ...(slots ? { route: slot ? (slot[1] === 'a' ? slots.app : slots.dom)[Number(slot[2])] ?? '' : '' } : {}),
          down: c.download ?? 0,
          up: c.upload ?? 0,
          start: Date.parse(c.start) || now
        }
      })
      this.emit('conns', this.conns)
    } finally { if (this.polling === polling) this.polling = undefined }
  }

}

const ADAPTER_CLASH = /create adapter:.*open existing adapter:/i

function humanize(line?: string): string | undefined {
  if (!line) return undefined
  if (ADAPTER_CLASH.test(line)) return 'Windows ещё не освободил прошлый адаптер Waarp. Включи Waarp ещё раз через несколько секунд'
  if (/access is denied|operation not permitted|requires elevation|Отказано/i.test(line)) return 'Нужны права администратора, чтобы создать сетевой адаптер'
  if (/address already in use|bind:/i.test(line)) return 'Порт занят: похоже, ещё одна копия Waarp уже работает'
  if (/open interface take too much time/i.test(line)) return 'Windows не успел открыть адаптер Waarp. Туннель остановлен; чужие подключения не менялись'
  if (/configure tun|create tun|wintun/i.test(line)) return 'Не удалось создать адаптер. Закрой другие VPN и попробуй ещё раз'
  if (/decode|private key|public key|base64/i.test(line)) return 'Ключи в конфиге битые. Переимпортируй конфиг'
  return line.replace(/^.*?(FATAL|ERROR)\[\d+\]\s*/, '').slice(0, 220)
}
