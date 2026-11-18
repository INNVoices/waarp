import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { BlockList, isIP } from 'node:net'
import type { Conn, Profile, Route, Settings, Status, TunnelHealth } from '../shared/types'
import { activeRoutes, buildConfig, buildRuntime, CANARY_ZONE, CANARY_IP, fallbackGroups, liveSwitches, loadedOf, loadedSets, planSlots, redact, ruleFileOf, ruleFileWithWitness, runtimeAutoLive, tagOf, usedProfiles, withoutAuto, type Loaded, type Slots } from './awg'
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
import { runtimePreload } from './runtime-pool'
import { sameEffectiveRouting } from '../shared/routing-edit'
import { routeEditGuard } from './live-routing'
import { DIAGNOSTIC_SELECTOR, type DiagnosticProxy, type DiagnosticTransport } from './diagnostic-proxy'
import { LiveOutbounds } from './live-outbound'
import { FlowActivity } from './continuity'

interface CardRuleFiles { slots?: Slots; files: Record<string, string> }

/** Only the flat match forms buildRuntime emits for cards, not a second router. */
function cardRuleMatcher(bodies: string[]): (c: Conn) => boolean {
  const matches: ((c: Conn) => boolean)[] = []
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  for (const body of bodies) {
    const rules: Record<string, unknown>[] = JSON.parse(body).rules ?? []
    for (const rule of rules) {
      const exes = new Set(strings(rule.process_path).map(path => path.toLowerCase()))
      const patterns = strings(rule.process_path_regex).map(pattern => new RegExp(pattern.replace(/^\(\?i\)/, ''), pattern.startsWith('(?i)') ? 'i' : ''))
      if (exes.size || patterns.length) matches.push(c => exes.has(c.exe.toLowerCase()) || patterns.some(pattern => pattern.test(c.exe)))
      const exact = new Set(strings(rule.domain).map(domain => domain.toLowerCase().replace(/\.$/, '')))
      const suffixes = new Set(strings(rule.domain_suffix).map(domain => domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '')))
      if (exact.size || suffixes.size) matches.push(c => {
        let name = c.host.toLowerCase().replace(/\.$/, '')
        if (exact.has(name)) return true
        for (;;) {
          if (suffixes.has(name)) return true
          const dot = name.indexOf('.')
          if (dot < 0) return false
          name = name.slice(dot + 1)
        }
      })
      const cidrs = strings(rule.ip_cidr)
      if (cidrs.length) {
        const ranges = new BlockList()
        for (const cidr of cidrs) {
          const [address, bits] = cidr.split('/')
          ranges.addSubnet(address, Number(bits), isIP(address) === 6 ? 'ipv6' : 'ipv4')
        }
        matches.push(c => {
          const address = c.ip || c.host, family = isIP(address)
          return !!family && ranges.check(address, family === 6 ? 'ipv6' : 'ipv4')
        })
      }
    }
  }
  return c => matches.some(match => match(c))
}

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
  private diagnostic?: DiagnosticProxy
  private diagnosticOwner?: AbortController
  private timer?: NodeJS.Timeout
  private pingTimer?: NodeJS.Timeout
  private last?: { t: number; d: number; u: number }
  private stopping = false
  private secrets: string[] = []
  private fb = new FbTracker([])
  private fbRoutes = new Map<string, { id: string; name: string }[]>()
  private tail: string[] = []
  private journal: RuntimeJournal
  private relays: LiveOutbounds
  private recoveryOk = false
  private recoveryError?: string
  private transition: Promise<void> = Promise.resolve()
  /** OFF cancels both the active startup and starts already queued before that command. */
  private stopVersion = 0
  private starting?: AbortController
  private requests = new Set<AbortController>()
  private polling?: object
  private pollFailures = 0
  private flowActivity = new FlowActivity()
  /** HOTFIX-RUNTIME-01: the running core's config, what it loaded and its Auto pool; set on a ready start, cleared on halt */
  private run?: { cfg: ReturnType<typeof buildConfig>; loaded: Loaded; autoLive: string[]; files: Record<string, string>; settings: Settings; hostV6?: boolean; nativeProfiles?: string[] }
  /** count of live route applies in this process (tests, log) */
  liveApplies = 0
  /** A failed live transaction is not a request to recreate TUN. Keep the last
   * acknowledged session and, when rollback cannot be confirmed, its edit guard. */
  private liveProblem?: string
  private pendingLive?: { guard: string; files: Record<string, string>; selectors: { tag: string; to: string }[] }
  get liveApplyFailure(): string | undefined { return this.liveProblem }
  get acknowledgedSettings(): Settings | undefined { return this.run?.settings }
  /** Opaque native-session identity for restart consent; OFF cancellation also invalidates idle consent. */
  get sessionToken(): object | number { return this.child ?? this.stopVersion }
  /** Read-only capabilities for service downloads; never infer loaded paths
   * from settings which may have pending, unapplied edits. */
  get loadedProfileIds(): readonly string[] {
    return (this.run?.loaded.profiles ?? []).filter(id => !this.relays.tag(id) || this.relays.ready(id))
  }
  get routingGuarded(): boolean { return !!this.pendingLive }
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
    this.relays = new LiveOutbounds(exe, dir)
  }

  log(): string[] { return this.tail.slice(-300) }
  get recoveryReady(): boolean { return this.recoveryOk }
  /** True includes prewarmed profiles: removing credentials still owned by the core needs its normal reconciliation. */
  isProfileLoaded(id: string): boolean { return this.run ? this.loadedProfileIds.includes(id) : this.ids.includes(id) }

  /** OFF checker samples share the same sequence as running-core health rounds. */
  recordIdlePings(pings: Status['pings'], health?: Status['health']): void {
    if (this.status.phase !== 'off') return
    this.set({ engine: 'down', pings, health, pingRound: ++this.pingSeq, pingAt: Date.now() })
  }

  private set(s: Partial<Status>) {
    const prev = this.status
    if (this.liveProblem && (s.phase ?? prev.phase) === 'on') s = { ...s, error: this.liveProblem }
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
        else if (!(await this.relays.recover())) error = this.relays.lastError ?? 'Не удалось восстановить процессы выбранных серверов'
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

  start(profiles: Profile[], s: Settings, current: () => boolean = () => true, began: () => void = () => {}): Promise<void> {
    const version = this.stopVersion
    return this.serialize(async () => {
      if (version !== this.stopVersion || !current()) return
      began()
      const controller = new AbortController()
      this.starting = controller
      try { await this.startNow(profiles, s, controller.signal) }
      finally { if (this.starting === controller) this.starting = undefined }
    })
  }

  /** HOTFIX-RUNTIME-01: a routing change the running core can already serve, as selector switches (no stop, no spawn, no
   *  Windows scan). A false result preserves the prior route; card writes never recreate TUN. `start` itself
   *  always restarts, so resume / explicit restarts keep their meaning. */
  applyLive(profiles: Profile[], s: Settings): Promise<boolean> {
    const version = this.stopVersion
    return this.serialize(async () => {
      this.liveProblem = undefined
      return version === this.stopVersion && this.child && this.status.phase === 'on' && this.run ? this.liveApply(profiles, s) : false
    })
  }

  private async startNow(profiles: Profile[], s: Settings, signal: AbortSignal, retry = true): Promise<void> {
    if (!this.recoveryOk) {
      this.set({ phase: 'error', error: this.recoveryError ?? 'Проверка прошлых процессов ещё не завершена. Дождись восстановления и повтори запуск' })
      return
    }
    const began = Date.now()
    let clean = false
    if (this.child) { if (!(await this.stopNow())) return; clean = true }
    // An unexpected main-core exit can leave asynchronous worker cleanup in
    // flight. Finish it before allocating a new generation of fixed slots.
    if (!(await this.relays.stop())) { this.set({ phase: 'error', error: this.relays.lastError }); return }
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
    // Select a distinct loopback port. The random credentials remain in this main
    // process and the private native configuration, never in the renderer.
    let proxyPort = await untilCancelled(pickPort(), signal)
    if (proxyPort === port) proxyPort = await untilCancelled(pickPort(), signal)
    if (signal.aborted) return
    if (!proxyPort || proxyPort === port) { this.set({ phase: 'error', error: 'Нет свободного локального порта для проверки соединения' }); return }
    this.diagnostic = { port: proxyPort, username: randomBytes(12).toString('hex'), password: randomBytes(24).toString('hex') }
    this.secrets = [this.api.secret, this.diagnostic.username, this.diagnostic.password,
      ...profiles.flatMap(p => (p.kind === 'vless' ? vlessSecrets(p) : p.kind === 'out' ? outSecrets(p) : p.kind === 'openvpn' ? openVpnSecrets(p) : []))]
    let cfg: ReturnType<typeof buildConfig>
    let files: Record<string, string>
    // R5: the core gets a bounded Auto live pool; the plan/UI keep the full logical Auto membership
    const autoLive = runtimeAutoLive(s, profiles, this.lastAutoPick)
    if (!(await this.relays.reserve(() => !signal.aborted, pickPort, [this.api.port, this.diagnostic.port]))) {
      if (!signal.aborted) this.set({ phase: 'error', error: this.relays.lastError ?? 'Не удалось подготовить выбор серверов' })
      return
    }
    this.secrets.push(...this.relays.graph.slots.flatMap(slot => [slot.username, slot.password]))
    const live = { autoLive }
    const preload = runtimePreload(profiles, s, usedProfiles(s, profiles, live).map(p => p.id))
    const slots = planSlots(s)!
    const ruleDir = join(this.dir, 'rules')
    try { ({ cfg, files } = buildRuntime(profiles, s, { api: this.api, selfExe: this.selfExe, autoLive, selectors: true, slots, ruleDir, hostV6, preload, preloadGroups: true, diagnostic: this.diagnostic, relays: this.relays.graph })) }
    catch { this.set({ phase: 'error', error: 'Не удалось подготовить конфиг движка' }); return }
    try {
      mkdirSync(ruleDir, { recursive: true })
      const generation = randomBytes(12).toString('hex')
      Object.entries(files).forEach(([tag, body], i) => writeFileSync(join(ruleDir, ruleFileOf(tag)), ruleFileWithWitness(body, `${generation}.${i}.${CANARY_ZONE}`)))
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
    this.run = { cfg: structuredClone(cfg), loaded: { ...loadedOf(loadedSets(profiles, s, { ...live, preload, preloadGroups: true })), slots }, autoLive, files, settings: structuredClone(s), hostV6,
      nativeProfiles: loadedOf(loadedSets(profiles, s, { ...live, preload, preloadGroups: true })).profiles }
    this.push(`[start] ready in ${Date.now() - began} ms; card slots ${slots.app.length}+${slots.dom.length}; host IPv6 ${hostV6 === undefined ? 'unknown' : hostV6 ? 'yes' : 'no'}`)
    this.timer = setInterval(() => void this.poll(), 1000)
    // Controller readiness is the start boundary. Health probes continue independently and must
    // not keep the whole UI in Starting for several seconds.
    this.set({ phase: 'on', since: Date.now(), engine: 'up' })
    // C08: 'on' = engine + controller up; tunnels carry their own health; the error line only when every tunnel is DOWN
    const health = new Health()
    const roundVersion = this.stopVersion
    const roundCurrent = () => this.child === child && this.stopVersion === roundVersion && !this.stopping
    let roundBusy = false
    const round = async (first: boolean) => {
      if (roundBusy || !roundCurrent() || this.pollFailures >= 2) return
      roundBusy = true
      try {
        const snapshot = this.run
        const ids = this.probeIds()
        const pings = await this.pingAll(ids)
        if (!roundCurrent() || this.pollFailures >= 2) return
        // Automatic selection and explicit live edits share the existing owner.
        // Results collected before an acknowledged edit cannot select its paths.
        await this.serialize(async () => {
          if (!roundCurrent() || this.pollFailures >= 2 || this.run !== snapshot || this.pendingLive) return
          const h = { ...this.lastHealth, ...health.step(pings, ids, undefined, this.ids) }
          const fallback = await this.fbStep(pings, h)
          if (!roundCurrent() || this.pollFailures >= 2) return
          // only probed ids get a verdict; an unsampled Auto candidate keeps its last evidence (or none)
          this.lastHealth = h
          await this.groupStep(h, pings)
          if (!roundCurrent() || this.pollFailures >= 2) return
          // A failed rotating batch is not proof that every loaded path is down.
          // Unmeasured members and older successful evidence prevent that claim.
          const allDown = this.ids.length > 0 && this.ids.every(id => h[id] === 'down')
          const noneYet = first && ids.length > 0 && ids.every(id => h[id] !== 'ok')
          const error = allDown ? 'Туннели не ответили на две проверки подряд. Проверь сеть или смени подключение' : noneYet ? 'Серверы пока не ответили, проверяю ещё раз' : undefined
          this.lastAutoPick = this.firstSelected.get(AUTO_ID) ?? this.lastAutoPick
          this.set({ engine: 'up', pings, pingRound: ++this.pingSeq, pingAt: Date.now(), health: h, fallback, error, picked: Object.fromEntries(this.firstSelected), autoPool: this.autoPool })
        })
      } catch {
        if (roundCurrent() && this.pollFailures < 2) this.set({ error: 'Не удалось обновить состояние туннелей; повторю проверку' })
      } finally { roundBusy = false }
    }
    void round(true)
    if (this.child === child) this.pingTimer = setInterval(() => void round(false), 15000)
  }

  /** Switch already loaded routes without rebuilding TUN. A structural miss
   * returns false; an operational failure additionally sets liveApplyFailure so
   * callers preserve this session instead of turning an ACK timeout into a restart. */
  private async liveApply(profiles: Profile[], s: Settings): Promise<boolean> {
    const run = this.run!, child = this.child, version = this.stopVersion
    const current = () => this.child === child && this.stopVersion === version && !this.stopping
    const protectedIds = new Set([...usedProfiles(run.settings, profiles, { autoLive: run.autoLive }).map(profile => profile.id),
      ...(run.settings.serviceVia ? [run.settings.serviceVia] : [])])
    const failed = async (stage: string): Promise<false> => {
      if (!current()) return false
      const restored = await this.restoreLive(current)
      if (!current()) return false
      this.liveProblem = restored
        ? 'Не удалось применить изменение. Прежние маршруты восстановлены; повтори действие'
        : 'Состояние изменяемых маршрутов ещё не подтверждено. Сессия VPN сохранена; повтори действие'
      this.push(`[apply] ${stage}; ${restored ? 'previous routing restored' : 'edit barrier reconciliation pending'}; core and TUN kept`)
      this.set({ error: this.liveProblem })
      if (restored) await this.relays.trim(protectedIds)
      return false
    }
    // A retry must first reconcile a possibly half-applied native state, even if
    // the desired settings now happen to equal the last acknowledged snapshot.
    if (this.pendingLive && !(await this.restoreLive(current))) return failed('previous edit still unconfirmed')
    if (!current()) return false
    // Disabled/library metadata must not exhaust or reshuffle a running slot pool.
    // The comparison uses the last acknowledged runtime, not an intent on disk.
    const slots = sameEffectiveRouting(run.settings, s) && run.loaded.slots
      ? run.loaded.slots : planSlots(s, run.loaded.slots)
    if (!slots) {
      this.liveProblem = 'Достигнут предел одновременных маршрутов. Действующие соединения сохранены'
      this.set({ error: this.liveProblem }); return false
    }
    const needed = usedProfiles(s, profiles, { autoLive: run.autoLive })
    const nativeProfiles = new Set(run.nativeProfiles ?? run.loaded.profiles)
    const late = needed.filter(profile => !nativeProfiles.has(profile.id))
    if (late.some(candidate => candidate.kind === 'awg' && profiles.some(loaded => nativeProfiles.has(loaded.id) &&
      loaded.kind === 'awg' && loaded.privateKey === candidate.privateKey && loaded.peer.publicKey === candidate.peer.publicKey))) {
      this.liveProblem = 'Эти ключи WireGuard уже используются текущей сессией. Выбери существующее подключение с этими ключами'
      this.set({ error: this.liveProblem }); return false
    }
    if (!(await this.relays.ensure(late, protectedIds, current))) {
      if (current()) { this.liveProblem = this.relays.lastError ?? 'Не удалось применить выбранный сервер. Действующий маршрут сохранён'; this.set({ error: this.liveProblem }); await this.relays.trim(protectedIds) }
      return false
    }
    const relayGraph = this.relays.graph
    const kept = { ...run.loaded, profiles: run.loaded.profiles.filter(id => nativeProfiles.has(id) || relayGraph.bindings[id]) }
    let next: ReturnType<typeof buildRuntime>
    try { next = buildRuntime(profiles, s, { api: this.api, selfExe: this.selfExe, autoLive: run.autoLive, selectors: true, keep: kept, slots, ruleDir: join(this.dir, 'rules'), hostV6: run.hostV6, diagnostic: this.diagnostic, relays: relayGraph }) }
    catch { return failed('route preparation failed') }
    const switches = liveSwitches(run.cfg, next.cfg)
    if (!switches) {
      const sections = Object.keys(run.cfg).filter(key => JSON.stringify((run.cfg as any)[key]) !== JSON.stringify((next.cfg as any)[key]))
      this.liveProblem = 'Это изменение системных настроек нельзя применить к текущей сессии. Действующие маршруты сохранены'
      this.push('[apply] structural change in ' + sections.join(', ') + '; current core and TUN kept')
      this.set({ error: this.liveProblem }); await this.relays.trim(protectedIds); return false
    }
    const changed = Object.keys(next.files).filter(k => next.files[k] !== run.files[k])
    const guarded = !!(switches.length || changed.length)
    if (guarded) {
      this.pendingLive = { guard: routeEditGuard(run.files, next.files, switches),
        files: Object.fromEntries(changed.map(name => [name, run.files[name]])),
        selectors: liveSwitches(next.cfg, run.cfg)! }
      if (!(await this.writeRules(['apply-guard'], { 'apply-guard': this.pendingLive.guard }, current))) return failed('edit barrier ACK failed')
    }
    for (const x of switches) {
      if (!current() || !(await this.select(x.tag, x.to))) return failed(`selector ${x.tag} failed`)
    }
    if (changed.length && !(await this.writeRules(changed, next.files, current))) return failed('card rules ACK failed')
    if (!current()) return false
    const closed = await this.closeTouched(run.settings.routes, s.routes,
      { slots: run.loaded.slots, files: run.files }, { slots, files: next.files })
    if (!current()) return false
    if (closed.closed !== closed.tried) {
      return failed('edited connections did not confirm close')
    }
    if (guarded && !(await this.writeRules(['apply-guard'], next.files, current))) {
      return failed('edit barrier release ACK failed')
    }
    if (!current()) return false
    this.pendingLive = undefined
    this.liveProblem = undefined
    const loaded = { ...loadedOf(loadedSets(profiles, s, { autoLive: run.autoLive, keep: kept })), slots }
    this.run = { ...run, cfg: structuredClone(next.cfg), files: next.files, loaded, settings: structuredClone(s) }
    this.fbRoutes = new Map(run.loaded.fbs.map(g => [g.tag, activeRoutes(s).filter(r => r.via === g.main && r.fallback === g.fb).map(r => ({ id: r.id, name: r.name }))]))
    // The loaded pool and the active routing set are different. A newly chosen warm
    // path must join health checks immediately; an unused path must stop being probed.
    this.ids = usedProfiles(s, profiles, { autoLive: run.autoLive }).map(p => p.id)
    this.groups = liveGroups(withAuto(s, profiles, run.autoLive), new Set(loaded.profiles))
    this.firstSelected = new Map(run.loaded.groups.map(g => [g.id,
      g.members.includes(this.firstSelected.get(g.id) ?? '') ? this.firstSelected.get(g.id)! : g.members[0]]))
    this.slowStreak = new Map(run.loaded.groups.map(g => [g.id, this.slowStreak.get(g.id) ?? 0]))
    const activeAuto = this.groups.find(g => g.id === AUTO_ID)
    const explicit = new Set(usedProfiles(withoutAuto(s), profiles).map(p => p.id))
    this.autoOnly = activeAuto ? activeAuto.members.filter(id => !explicit.has(id)) : []
    this.autoPool = activeAuto ? { live: activeAuto.members.length, total: autoMembers(profiles).length } : undefined
    this.lastHealth = Object.fromEntries(Object.entries(this.lastHealth).filter(([id]) => this.ids.includes(id)))
    this.liveApplies++
    const written = changed.length ? `${changed.length} rule file(s) written, each reload confirmed` : 'no rule file changes'
    this.push(`live route apply: ${switches.length} selector switch(es), ${written}; connections closed ${closed.closed}/${closed.tried}; core and TUN kept`)
    this.set({ error: undefined })
    if (!(await this.relays.trim(new Set([...needed.map(profile => profile.id), ...(s.serviceVia ? [s.serviceVia] : [])]))))
      this.push('[apply] inactive server cleanup is pending; owner journal retained')
    return true
  }

  /** Restore only the edited decision surface; never stop the process, clear all
   * connections, or release the barrier on an unacknowledged rollback. */
  private async restoreLive(current: () => boolean): Promise<boolean> {
    const pending = this.pendingLive
    if (!pending) return current()
    if (!current() || !(await this.writeRules(['apply-guard'], { 'apply-guard': pending.guard }, current))) return false
    for (const item of pending.selectors) if (!current() || !(await this.select(item.tag, item.to))) return false
    const names = Object.keys(pending.files)
    if (names.length && !(await this.writeRules(names, pending.files, current))) return false
    if (!current() || !(await this.writeRules(['apply-guard'], this.run!.files, current))) return false
    if (!current()) return false
    this.pendingLive = undefined
    return true
  }

  private async writeRules(names: string[], files: Record<string, string>, current: () => boolean): Promise<boolean> {
    if (!current()) return false
    const end = Date.now() + 3000
    const active = () => current() && Date.now() < end
    const dir = join(this.dir, 'rules')
    const put = async (name: string, body: string) => {
      const file = join(dir, name), tmp = file + '.tmp'
      try {
        if (!active()) throw new Error('rule apply cancelled or timed out')
        writeFileSync(tmp, body)
        for (let i = 0; i < 5; i++) {
          if (!active()) throw new Error('rule apply cancelled or timed out')
          try { renameSync(tmp, file); return }
          catch (error) {
            // Never truncate a watched file after an atomic replacement fails:
            // the existing restart path can load a complete configuration safely.
            if (i === 4) throw error
            await new Promise(r => setTimeout(r, Math.min(40, Math.max(0, end - Date.now()))))
          }
        }
      } finally {
        try { rmSync(tmp, { force: true }) } catch {}
      }
    }
    const generation = randomBytes(12).toString('hex')
    const pending = new Set(names.map((_, i) => `${generation}.${i}.${CANARY_ZONE}`))
    try {
      mkdirSync(dir, { recursive: true })
      for (const [i, name] of names.entries()) await put(ruleFileOf(name), ruleFileWithWitness(files[name], `${generation}.${i}.${CANARY_ZONE}`))
    } catch { return false }
    while (pending.size && active()) {
      await this.bounded([...pending], async probe => {
        if (!active()) return
        const r = await this.req(`/dns/query?name=${probe}&type=A`, Math.min(1000, end - Date.now()))
        if (active() && r?.Status === 0 && Array.isArray(r.Answer) && r.Answer.some((answer: { data?: unknown; type?: unknown }) => answer?.type === 1 && answer.data === CANARY_IP)) pending.delete(probe)
      })
      if (pending.size && active()) await new Promise(res => setTimeout(res, Math.min(100, end - Date.now())))
    }
    return pending.size === 0 && active()
  }

  private async closeTouched(before: Route[], after: Route[], previous?: CardRuleFiles, next?: CardRuleFiles): Promise<{ tried: number; closed: number }> {
    // Match only the forms emitted by our card compiler, using both immutable
    // snapshots: the list resolver may already contain the newly downloaded list.
    const compiled = (routes: Route[], state?: CardRuleFiles) =>
      (['app', 'custom', 'list', 'preset'] as const).flatMap(kind => routes.filter(r => r.on && r.kind === kind)).map(route => {
        const pool = route.kind === 'app' ? state?.slots?.app : state?.slots?.dom
        const index = pool?.indexOf(route.id) ?? -1
        const slot = (route.kind === 'app' ? 'a' : 'd') + index
        const bodies = state && index >= 0 ? [state.files['r' + slot], state.files['x' + slot]].filter((body): body is string => typeof body === 'string') : undefined
        return { route, matches: bodies ? cardRuleMatcher(bodies) : (c: Conn) => routeHits(route, c) }
      })
    const oldCards = compiled(before, previous), newCards = compiled(after, next)
    const bypassChanged = previous?.files['bypass-ru'] !== next?.files['bypass-ru']
    const newBypass = next?.files['bypass-ru'] ? cardRuleMatcher([next.files['bypass-ru']]) : () => false
    const was = new Map(before.map(r => [r.id, r]))
    const forwarding = (r?: Route) => r ? JSON.stringify([r.via, r.fallback, r.via === 'direct' && r.dpi === true]) : ''
    const ids = this.conns.filter(c => {
      if (bypassChanged) {
        // The core tells us which early global rule owned a connection. Preserve
        // LAN/self exemptions; only a removed RU bypass or a newly bypassed card
        // / final route needs a new connection under the changed policy.
        if (c.rule?.includes('bypass-ru') && !newBypass(c)) return true
        if (newBypass(c) && !c.rule?.includes('bypass-ru') && (c.route || c.rule === 'final')) return true
      }
      const oldMatch = oldCards.find(card => card.matches(c))?.route
      // A core-attributed global/LAN bypass beats the card rules. Do not interrupt
      // that session just because a broader domain card also happens to match it.
      if (c.route === '' && oldMatch) return false
      const oldRoute = c.route === undefined ? oldMatch : was.get(c.route)
      const newRoute = newCards.find(card => card.matches(c))?.route
      return oldRoute?.id !== newRoute?.id || forwarding(oldRoute) !== forwarding(newRoute)
    }).map(c => c.id)
    let closed = 0
    await this.bounded(ids, async id => { if (await this.drop(id)) closed++ })
    return { tried: ids.length, closed }
  }

  private async drop(id: string): Promise<boolean> {
    const child = this.child, api = this.api, version = this.stopVersion
    if (!child || this.stopping) return false
    const ctl = new AbortController()
    this.requests.add(ctl)
    const t = setTimeout(() => ctl.abort(), 2000)
    try {
      const r = await fetch(`http://127.0.0.1:${api.port}/connections/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${api.secret}` }, signal: ctl.signal })
      return r.ok && this.child === child && this.api === api && this.stopVersion === version && !this.stopping
    }
    catch { return false } finally { clearTimeout(t); this.requests.delete(ctl) }
  }

  private abortRequests() {
    for (const controller of this.requests) controller.abort()
    this.requests.clear()
    this.diagnosticOwner?.abort()
  }

  private halt() {
    void this.relays.stop()
    this.abortRequests()
    this.polling = undefined
    this.pollFailures = 0
    this.flowActivity.reset()
    this.run = undefined
    this.liveProblem = undefined
    this.pendingLive = undefined
    this.diagnostic = undefined
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
    const workers = this.relays.stop()
    return this.serialize(async () => { const stopped = await this.stopNow(); return await workers && stopped })
  }

  /** R2 (A + C): try CTRL_BREAK to the verified owned core, wait only if sent; then a forced stop through our own
   *  child handle (it cannot hit a reused PID), bounded wait; then a read-only residue check. 'off' only when clean. */
  private async stopNow(): Promise<boolean> {
    const workers = this.relays.stop()
    const c = this.child
    if (!c) {
      // A second stop after a crash/residue failure must not turn an unclean state into a successful reset.
      const r = this.status.recovery ? await this.residue() : undefined
      if (r) { this.set({ phase: 'error', engine: 'down', since: undefined, error: r.text, recovery: r.kind }); return false }
      if (!(await workers)) {
        this.set({ phase: 'error', engine: 'down', since: undefined, error: this.relays.lastError ?? 'Процесс выбранного сервера ещё работает' })
        return false
      }
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
    if (!(await workers)) { this.set({ phase: 'error', engine: 'down', since: undefined, error: this.relays.lastError, ...zero }); return false }
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
    this.relays.stopSync()
    this.stopVersion++
    this.starting?.abort()
    this.abortRequests()
    if (!this.child) return
    this.stopping = true
    try { this.child.kill() } catch {}
  }

  private profileTag(id: string): string { return this.relays.tag(id) ?? tagOf(id) }

  private async select(tag: string, to: string, signal?: AbortSignal): Promise<boolean> {
    const child = this.child, api = this.api, version = this.stopVersion
    if (!child || this.stopping || signal?.aborted) return false
    const ctl = new AbortController()
    this.requests.add(ctl)
    const t = setTimeout(() => ctl.abort(), 3000)
    const requestSignal = signal ? AbortSignal.any([ctl.signal, signal]) : ctl.signal
    try {
      const r = await fetch(`http://127.0.0.1:${api.port}/proxies/${encodeURIComponent(tag)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${api.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: to }),
        signal: requestSignal
      })
      if (!r.ok || this.child !== child || this.api !== api || this.stopVersion !== version || this.stopping) return false
      const confirmed = await fetch(`http://127.0.0.1:${api.port}/proxies/${encodeURIComponent(tag)}`, {
        headers: { Authorization: `Bearer ${api.secret}` }, signal: requestSignal
      })
      const selection = confirmed.ok ? await confirmed.json() : undefined
      return selection?.now === to && this.child === child && this.api === api && this.stopVersion === version && !this.stopping
    } catch { return false } finally { clearTimeout(t); this.requests.delete(ctl) }
  }

  private pathIdle(path: string): boolean {
    const group = this.groups.find(value => value.id === path)
    const paths = group ? [this.firstSelected.get(path) ?? group.members[0]].filter(Boolean) : [path]
    return this.flowActivity.idle(paths)
  }

  private async fbStep(pings: Record<string, number | undefined>, health: Record<string, TunnelHealth> = {}): Promise<Record<string, string>> {
    const child = this.child, tracker = this.fb, version = this.stopVersion
    const current = () => this.child === child && this.stopVersion === version && !this.stopping && !this.pendingLive
    const done = await tracker.step(pings, async (g, toFb) => {
      if (!current()) return Promise.resolve(false)
      // Returning to a recovered primary is optional while the reserve works.
      // Unknown telemetry holds it too; a confirmed failed reserve may recover.
      if (!toFb && health[g.fb] !== 'down' && health[g.fb] !== 'busy' && !this.pathIdle(g.fb)) return Promise.resolve(false)
      return await this.select(g.tag, this.profileTag(toFb ? g.fb : g.main)) && current()
    })
    if (!current()) return {}
    for (const d of done) this.emit('fallback', { main: d.g.main, fb: d.g.fb, toFb: d.toFb, routes: (this.fbRoutes.get(d.g.tag) ?? []).map(r => r.name) })
    const out: Record<string, string> = {}
    for (const g of this.fb.active()) for (const r of this.fbRoutes.get(g.tag) ?? []) out[r.id] = g.fb
    return out
  }

  /** W2.2: Waarp, not sing-box, moves group selections: confirmed failure or a sustained clear speed gap only */
  private async groupStep(health: Record<string, TunnelHealth>, pings: Record<string, number | undefined>): Promise<void> {
    const child = this.child, version = this.stopVersion
    const stillCurrent = () => this.child === child && this.stopVersion === version && !this.stopping && !this.pendingLive
    await Promise.all(this.groups.map(async g => {
      if (!stillCurrent()) return
      const current = this.firstSelected.get(g.id) ?? g.members[0]
      const activeOrUnknown = !this.pathIdle(current)
      const currentAllowed = g.members.includes(current)
      let next = current
      if (g.policy === 'first') next = currentAllowed && activeOrUnknown && health[current] !== 'down' && health[current] !== 'busy'
        ? current : firstAlive(g.members, current, health)
      else {
        const r = stickyFastest(g.members, current, health, pings, this.slowStreak.get(g.id) ?? 0, activeOrUnknown)
        next = currentAllowed && activeOrUnknown && health[current] !== 'down' && health[current] !== 'busy' ? current : r.next
        this.slowStreak.set(g.id, activeOrUnknown ? 0 : r.streak)
      }
      if (next !== current && await this.select(grpTag(g.id), this.profileTag(next)) && stillCurrent()) this.firstSelected.set(g.id, next)
    }))
  }

  private async req(path: string, timeout = 3000, signal?: AbortSignal): Promise<any> {
    const child = this.child, api = this.api, version = this.stopVersion
    if (!child || this.stopping || signal?.aborted) return undefined
    const ctl = new AbortController()
    this.requests.add(ctl)
    const t = setTimeout(() => ctl.abort(), timeout)
    try {
      const r = await fetch(`http://127.0.0.1:${api.port}${path}`, { headers: { Authorization: `Bearer ${api.secret}` }, signal: signal ? AbortSignal.any([ctl.signal, signal]) : ctl.signal })
      if (!r.ok) return undefined
      const value = await r.json()
      return this.child === child && this.api === api && this.stopVersion === version && !this.stopping && !signal?.aborted ? value : undefined
    } catch { return undefined } finally { clearTimeout(t); this.requests.delete(ctl) }
  }

  private async delay(tag: string, url = 'https://www.gstatic.com/generate_204', signal?: AbortSignal): Promise<number | undefined> {
    const r = await this.req(`/proxies/${tag}/delay?timeout=6000&url=` + encodeURIComponent(url), 8000, signal)
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
      const ms = await this.delay(id === 'direct' ? 'direct' : this.profileTag(id), url)
      out[id] = ms ?? null
    })
    return this.child === child && this.stopVersion === version ? out : {}
  }

  /** Read payload through one already loaded path. No new core, global selector
   * or OS proxy is used. OFF/reconfiguration cancels the caller's sockets too. */
  async withHttpProxy<T>(profileId: string, signal: AbortSignal,
    work: (proxy: DiagnosticTransport) => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error('cancelled')
    if (this.diagnosticOwner) throw new Error('busy')
    const child = this.child, version = this.stopVersion, proxy = this.diagnostic
    if (!child || !proxy || this.status.phase !== 'on' || this.stopping) throw new Error('engine')
    if (profileId !== 'direct' && !this.loadedProfileIds.includes(profileId)) throw new Error('not_loaded')
    const owner = new AbortController()
    this.diagnosticOwner = owner
    const linked = AbortSignal.any([signal, owner.signal])
    const current = () => !linked.aborted && this.child === child && this.stopVersion === version && !this.stopping
    try {
      if (!(await this.select(DIAGNOSTIC_SELECTOR, profileId === 'direct' ? 'direct' : this.profileTag(profileId), linked)) || !current()) throw new Error('cancelled')
      const result = await work({ ...proxy, host: '127.0.0.1', signal: linked })
      if (!current()) throw new Error('cancelled')
      return result
    } finally {
      owner.abort()
      if (this.diagnosticOwner === owner) this.diagnosticOwner = undefined
    }
  }

  /** Diagnosis uses explicit native outbound tags. Direct is included only when
   * requested; system-socket layers do not prove a Direct path while TUN is on. */
  async probePaths(target: string, ids: string[], signal?: AbortSignal): Promise<Record<string, number | null>> {
    if (signal?.aborted) return {}
    const child = this.child, version = this.stopVersion
    const url = /^https?:\/\//.test(target) ? target : 'https://' + target
    const out: Record<string, number | null> = {}
    const paths = [...new Set(ids)].filter(id => id === 'direct' || this.ids.includes(id))
    await this.bounded(paths, async id => {
      if (signal?.aborted) return
      const delay = await this.delay(id === 'direct' ? 'direct' : this.profileTag(id), url, signal)
      if (!signal?.aborted) out[id] = delay ?? null
    })
    return this.child === child && this.stopVersion === version && !signal?.aborted ? out : {}
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
    await this.bounded(['direct', ...ids], async id => { out[id] = id === 'direct' ? await this.delay('direct') : await this.probe2(this.profileTag(id)) })
    if (this.child !== child || this.stopVersion !== version) return {}
    // A group's latency is the measured latency of its actually selected member.
    // Do not report the minimum of unrelated members as though it were the active route.
    await Promise.all(this.groups.map(async g => {
      const state = await this.req(`/proxies/${grpTag(g.id)}`)
      const selected = typeof state?.now === 'string' ? g.members.find(id => this.profileTag(id) === state.now) : undefined
      out[g.id] = selected ? out[selected] : undefined
    }))
    return this.child === child && this.stopVersion === version ? out : {}
  }

  private async poll() {
    const child = this.child, version = this.stopVersion
    if (!child || this.polling || this.stopping) return
    const polling = {}
    this.polling = polling
    const current = () => this.child === child && this.stopVersion === version && !this.stopping
    const failed = () => {
      if (!current()) return
      this.flowActivity.invalidate()
      this.pollFailures++
      if (this.pollFailures >= 2) this.set({ engine: 'down', error: 'Движок не отвечает на локальные запросы. Попробуй отключить и снова включить Waarp' })
    }
    try {
      const r = await this.req('/connections', 2000)
      if (!current()) return
      if (!r || !Object.hasOwn(r, 'connections') || (r.connections !== null && !Array.isArray(r.connections))) {
        failed(); return
      }
      const now = Date.now()
      const slots = this.run?.loaded.slots
      const loaded = new Set(['direct', ...this.loadedProfileIds])
      let attributed = true
      // Validate and project before publishing or resetting the failed-sample count.
      // An unknown chain must never masquerade as Direct or permit an idle switch.
      const conns = (r.connections ?? []).map((c: any): Conn => {
        if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id ||
          !c.metadata || typeof c.metadata !== 'object' || Array.isArray(c.metadata) ||
          (c.chains !== undefined && (!Array.isArray(c.chains) || c.chains.some((tag: unknown) => typeof tag !== 'string'))))
          throw new Error('Invalid connection snapshot')
        const m = c.metadata
        if (['processPath', 'process', 'host', 'destinationIP', 'network'].some(key => m[key] !== undefined && typeof m[key] !== 'string'))
          throw new Error('Invalid connection metadata')
        const exe: string = m.processPath ?? ''
        const chain: string[] = c.chains ?? []
        const slot = chain.map(x => /^rt-([ad])(\d+)$/.exec(x)).find(Boolean)
        const via = chain.map(tag => this.relays.profile(tag)).find(Boolean) ?? chain.find(tag => tag.startsWith('p-'))?.slice(2) ?? (chain.includes('direct') ? 'direct' : '')
        if (!via || !loaded.has(via)) attributed = false
        return {
          id: c.id,
          app: exe ? exe.split('\\').pop()!.replace(/\.exe$/i, '') : (m.process || 'система'),
          exe,
          host: m.host || m.destinationIP || '',
          ip: typeof m.destinationIP === 'string' ? m.destinationIP : undefined,
          port: Number(m.destinationPort) || 0,
          net: m.network ?? '',
          via,
          rule: typeof c.rule === 'string' ? c.rule : '',
          ...(slots ? { route: slot ? (slot[1] === 'a' ? slots.app : slots.dom)[Number(slot[2])] ?? '' : '' } : {}),
          down: Number.isFinite(c.download) && c.download >= 0 ? c.download : 0,
          up: Number.isFinite(c.upload) && c.upload >= 0 ? c.upload : 0,
          start: typeof c.start === 'string' ? Date.parse(c.start) || now : now
        }
      })
      const recovered = this.pollFailures >= 2
      this.pollFailures = 0
      if (recovered) this.set({ engine: 'up', error: undefined })
      const d = Number.isFinite(r.downloadTotal) && r.downloadTotal >= 0 ? r.downloadTotal : 0
      const u = Number.isFinite(r.uploadTotal) && r.uploadTotal >= 0 ? r.uploadTotal : 0
      if (this.last) {
        const dt = Math.max(0.2, (now - this.last.t) / 1000)
        this.set({ down: Math.max(0, (d - this.last.d) / dt), up: Math.max(0, (u - this.last.u) / dt), downTotal: d, upTotal: u })
      }
      this.last = { t: now, d, u }
      this.conns = conns
      if (attributed) this.flowActivity.observe(this.conns, loaded)
      else this.flowActivity.invalidate()
      this.emit('conns', this.conns)
    } catch { failed() }
    finally { if (this.polling === polling) this.polling = undefined }
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
