// HOTFIX-RUNTIME-01 B: the pre-start work of the master button. Stopping the measuring core (no TUN, no adapter) and the
// read-only adapter/notice scan are independent, so they run together; the engine's own TUN preflight still runs fresh
// right before spawn. Either failing blocks the start; nothing here retries.
import type { Notice } from '../shared/types'

export interface PrepareDeps {
  /** stop the measuring core; false = it did not confirm the stop */
  stopChecker: () => Promise<boolean>
  /** fresh read-only notice scan (adapters, integrity, admin) */
  notices: () => Promise<Notice[]>
}

export type Prepared = { ok: true } | { ok: false; error: string }

export async function prepareStart(d: PrepareDeps): Promise<Prepared> {
  const [stopped, notices] = await Promise.all([d.stopChecker(), d.notices()])
  if (!stopped) return { ok: false, error: 'Проверочный движок не остановился; основной туннель не будет запущен' }
  const block = notices.find(x => x.level === 'block')
  return block ? { ok: false, error: block.title } : { ok: true }
}
