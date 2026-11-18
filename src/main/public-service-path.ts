import type { Adapter, Profile, Status } from '../shared/types'
import type { Checker } from './checker'
import type { Engine } from './engine'
import type { DiagnosticTransport } from './diagnostic-proxy'
import type { PublicServicePath } from './public-recovery'
import { untilCancelled } from './tun'

type OwnedChecker = Pick<Checker, 'acquire' | 'owns' | 'release' | 'ensure' | 'stop' | 'withHttpProxy'>
interface PathEnvironment {
  phase: () => Status['phase']
  open: () => boolean
  current: () => boolean
  live: Pick<Engine, 'withHttpProxy'>
  checker?: OwnedChecker
  adapters: (signal: AbortSignal) => Promise<Adapter[] | undefined>
  profile: (path: PublicServicePath, signal: AbortSignal) => Promise<Profile | undefined>
}

/** This error is terminal for a whole recovery batch. Never move to another
 * path when a checker process has not confirmed its own shutdown. */
export class PublicPathCleanupError extends Error {
  constructor() { super('Public catalog checker did not confirm shutdown') }
}

/** A public-list attempt has no capability to start/stop the main TUN. It can
 * borrow a loaded diagnostic outbound, or own one headless checker while OFF.
 * Cleanup finishes before the caller can ingest results or try another path. */
export async function withPublicServicePath<T>(path: PublicServicePath, env: PathEnvironment,
  signal: AbortSignal, budgetMs: number,
  work: (proxy: DiagnosticTransport | undefined, signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const owner = new AbortController(), transfer = new AbortController()
  const ownedSignal = AbortSignal.any([signal, owner.signal])
  const requestSignal = AbortSignal.any([ownedSignal, transfer.signal])
  const measured = env.checker
  let lease: symbol | undefined, cleanup: Promise<boolean> | undefined
  let transferring = false
  const stopOwned = () => {
    if (lease && measured?.owns(lease) && !cleanup) cleanup = measured.stop().catch(() => false)
  }
  ownedSignal.addEventListener('abort', stopOwned, { once: true })
  const timer = setTimeout(() => {
    // A transfer deadline can still return completed independent sources. Do
    // not invalidate the engine owner just because one HTTP request timed out.
    transfer.abort()
    if (!transferring) owner.abort()
  }, Math.max(0, Math.min(90_000, Number.isFinite(budgetMs) ? budgetMs : 0)))
  const current = () => !ownedSignal.aborted && env.current()
  const download = async (proxy?: DiagnosticTransport): Promise<T> => {
    if (!current()) throw new Error('cancelled')
    transferring = true
    return work(proxy, requestSignal)
  }
  try {
    if (!current()) throw new Error('cancelled')
    let result: T
    if (env.phase() === 'on') {
      // withHttpProxy rejects unknown/unloaded IDs; its selector is separate
      // from every application route and never edits the running plan.
      result = await env.live.withHttpProxy(path.id, ownedSignal, download)
    } else {
      if (env.phase() !== 'off') throw new Error('engine')
      if (!path.profile) {
        if (path.id !== 'direct') throw new Error('not_loaded')
        // The master can be open while no route needs a core (open-idle).
        // Explicit Direct still needs no checker, process or TUN transition.
        result = await download()
      } else {
        if (env.open() || !measured) throw new Error('engine')
        lease = measured.acquire(() => owner.abort())
        if (!lease) throw new Error('busy')
        const actual = await untilCancelled(env.profile(path, ownedSignal), ownedSignal)
        const list = actual && await untilCancelled(env.adapters(ownedSignal), ownedSignal)
        if (!actual || !list || !current() || !measured.owns(lease)) throw new Error('cancelled')
        if (!(await measured.ensure([actual], list)) || !current() || !measured.owns(lease)) throw new Error('engine')
        result = await measured.withHttpProxy(lease, path.id, ownedSignal, download)
      }
    }
    if (!current()) throw new Error('cancelled')
    return result
  } finally {
    clearTimeout(timer)
    stopOwned()
    const clean = cleanup ? await cleanup : true
    if (lease) measured?.release(lease)
    ownedSignal.removeEventListener('abort', stopOwned)
    if (!clean) throw new PublicPathCleanupError()
  }
}
