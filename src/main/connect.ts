import { localized } from '../shared/localization'
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
  const [stopResult, noticeResult] = await Promise.allSettled([d.stopChecker(), d.notices()])
  if (stopResult.status === 'rejected' || noticeResult.status === 'rejected') return { ok: false, error: localized("winInline.connect.1e4d817d7fd3") }
  const stopped = stopResult.value, notices = noticeResult.value
  if (!stopped) return { ok: false, error: localized("winInline.connect.9e8ce7766d03") }
  const block = notices.find(x => x.level === 'block')
  return block ? { ok: false, error: block.title } : { ok: true }
}
