// Hardening R4: sleep / resume (the core follows ordinary interface changes itself). One coalesced restart per resume,
// only after a usable physical network is back (bounded, read-only), never overlapping, never a churn loop. Another VPN or adapter is never touched.
export interface ResumeDeps {
  /** was the tunnel up (so a restart is wanted at all) */
  isOn: () => boolean
  /** owner intent independent of a core that may have crashed while asleep */
  isOpen?: () => boolean
  revision?: () => number
  /** read-only: a usable non-Waarp network is present */
  netReady: () => Promise<boolean>
  /** one restart; resolves true when the tunnel is up again */
  restart: () => Promise<boolean>
  /** the restart failed or the network never came back: stop and say why (no retry) */
  fail: (why: 'no_network' | 'restart_failed') => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  /** quiet period that coalesces a resume + Wi-Fi reconnect storm into one run */
  settleMs?: number
  /** how long to wait for a usable network */
  budgetMs?: number
  everyMs?: number
}

export function createResume(d: ResumeDeps) {
  const now = d.now ?? Date.now
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const setT = d.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms))
  const clearT = d.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout))
  let suspended = false, wanted = false, timer: unknown, running: Promise<void> | undefined, runs = 0, generation = 0
  let wantedRevision: number | undefined

  const run = async () => {
    timer = undefined
    if (running || !wanted || suspended) return
    wanted = false
    const ticket = generation, revision = wantedRevision
    const current = () => ticket === generation && !suspended && (!d.isOpen || d.isOpen()) && (!d.revision || d.revision() === revision)
    if (!current()) return
    running = (async () => {
      runs++
      const end = now() + (d.budgetMs ?? 30_000)
      const readNetwork = async () => { try { return await d.netReady() } catch { return false } }
      let ready = await readNetwork()
      while (current() && !ready && now() < end) {
        await sleep(Math.min(d.everyMs ?? 1000, Math.max(0, end - now())))
        if (!current()) return
        ready = await readNetwork()
      }
      if (!current()) return
      if (!ready) { await d.fail('no_network'); return }
      let restarted = false
      try { restarted = await d.restart() } catch { /* report the failed restart once below */ }
      if (current() && !restarted) await d.fail('restart_failed')
    })().catch(() => undefined).finally(() => {
      running = undefined
      // A second sleep/wake may have cancelled the old network wait. Preserve the new wake request.
      if (wanted && !suspended && timer === undefined) schedule()
    })
    await running
  }
  const schedule = () => {
    if (timer !== undefined) clearT(timer)
    timer = setT(() => void run(), d.settleMs ?? 2000)
  }
  const cancel = () => {
    generation++
    wanted = false
    if (timer !== undefined) { clearT(timer); timer = undefined }
  }

  return {
    /** Windows is going to sleep: invalidate an earlier wake and remember the current owner intent. */
    suspend() { cancel(); suspended = true; wanted = d.isOn(); wantedRevision = d.revision?.() },
    /** back from sleep: one restart after the network settles */
    resume() {
      if (!suspended && !running) { wanted = d.isOn(); wantedRevision = d.revision?.() }
      suspended = false
      if (wanted && !running) schedule()
    },
    cancel,
    get busy() { return !!running || timer !== undefined },
    get runs() { return runs },
  }
}

/** one IPv4 default route as Windows reports it (read-only snapshot) */
export interface DefaultRoute { alias: string; nextHop: string; up: boolean }
/** a usable underlay/default-gateway network: an UP non-Waarp interface with a real IPv4 default gateway. On-link
 *  default routes (next hop 0.0.0.0, typical for VPN adapters) and gateway-less virtual NICs (WSL / Hyper-V) do not count.
 *  Undefined snapshot (unreadable) = not ready. */
export function underlayReady(online: boolean, routes: DefaultRoute[] | undefined, own = 'Waarp'): boolean {
  if (!online || !routes) return false
  return routes.some(r => r.up && r.alias !== own && /^\d{1,3}(\.\d{1,3}){3}$/.test(r.nextHop) && r.nextHop !== '0.0.0.0')
}
