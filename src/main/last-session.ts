import { existsSync, readFileSync, statSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Status } from '../shared/types'
import { protectPrivateFileAsync } from './private-file'
import { readPayloadReport } from './payload-check'

const MAX_BYTES = 65_536, MAX_EVENTS = 48
const PHASES = ['off', 'starting', 'on', 'stopping', 'error']
const CATEGORIES = ['none', 'timeout', 'dns', 'tls', 'socket', 'permission', 'handshake', 'unknown']
const number = (v: unknown, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isSafeInteger(v) ? Math.max(0, Math.min(max, v)) : 0
export function errorCategory(message: unknown): string {
  if (typeof message !== 'string' || !message.trim()) return 'none'
  if (/timeout|deadline|тайм|время ожидания/i.test(message)) return 'timeout'
  if (/dns/i.test(message)) return 'dns'
  if (/tls|certificate|сертификат/i.test(message)) return 'tls'
  if (/socket|network is unreachable|connection reset/i.test(message)) return 'socket'
  if (/permission|разреш|отозва/i.test(message)) return 'permission'
  if (/handshake/i.test(message)) return 'handshake'
  return 'unknown'
}

/** Both persistence and export go through this allowlist, including files from old releases. */
export function safeSessionEvent(value: unknown) {
  const v = value && typeof value === 'object' ? value as Record<string, any> : {}
  return { at: number(v.at), phase: PHASES.includes(v.phase) ? v.phase : '', since: number(v.since),
    downBytes: number(v.downBytes), upBytes: number(v.upBytes), open: v.open === true,
    errorClass: CATEGORIES.includes(v.errorClass) ? v.errorClass : '',
    errors: Object.fromEntries(CATEGORIES.map(c => [c, number(v.errors?.[c], 500)])) }
}

/** Profile identifiers and user-supplied endpoints do not belong in a shared report. */
export function lastTransferEvidence(file: string, current?: unknown) {
  const report = readPayloadReport(current) ?? readSavedPayloadReport(file)
  if (!report) return undefined
  return { at: report.at, target: report.target, download: report.download, upload: report.upload }
}

export function readSavedPayloadReport(file: string) {
  try {
    if (statSync(file).size > 16_384) return undefined
    return readPayloadReport(JSON.parse(readFileSync(file, 'utf8')))
  } catch { return undefined }
}

/** Attempt both removals; a partial failure must be shown, never reported as a complete clear. */
export async function clearDiagnosticEvidence(evidence: LastSessionEvidence, payloadFile: string): Promise<boolean> {
  const session = await evidence.clear()
  try { await fs.rm(payloadFile, { force: true }); return session } catch { return false }
}

export class LastSessionEvidence {
  private phase?: string
  private writtenAt = 0
  private pending: Promise<boolean> = Promise.resolve(true)
  constructor(private file: string, private now: () => number = Date.now) {}

  read(): { schema: 1; available: boolean; events: ReturnType<typeof safeSessionEvent>[] } {
    try {
      if (!existsSync(this.file)) return { schema: 1, available: true, events: [] }
      if (statSync(this.file).size > MAX_BYTES) throw new Error('size')
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed.schema !== 1 || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS) throw new Error('schema')
      return { schema: 1, available: true, events: parsed.events.map(safeSessionEvent) }
    } catch { return { schema: 1, available: false, events: [] } }
  }

  record(status: Status, log: string[]): Promise<boolean> {
    const at = this.now()
    if (this.phase === undefined && status.phase === 'off') { this.phase = 'off'; return Promise.resolve(true) }
    if (this.phase === status.phase && at - this.writtenAt >= 0 && at - this.writtenAt < 15_000) return Promise.resolve(true)
    const errors: Record<string, number> = {}
    for (const line of log.slice(-500)) if (/error|fatal|panic|warn|ошибк/i.test(line)) {
      const key = errorCategory(line); errors[key] = (errors[key] ?? 0) + 1
    }
    const event = safeSessionEvent({ at, phase: status.phase, since: status.since,
      downBytes: status.downTotal, upBytes: status.upTotal, open: status.open, errorClass: errorCategory(status.error), errors })
    this.phase = status.phase; this.writtenAt = at
    this.pending = this.pending.then(async () => {
      const temp = this.file + '.tmp'
      try {
        let events: ReturnType<typeof safeSessionEvent>[] = []
        try {
          if ((await fs.stat(this.file)).size > MAX_BYTES) throw new Error('size')
          const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
          if (parsed.schema === 1 && Array.isArray(parsed.events) && parsed.events.length <= MAX_EVENTS) events = parsed.events.map(safeSessionEvent)
        } catch { /* The new sanitized event can recover a missing or damaged evidence file. */ }
        const body = JSON.stringify({ schema: 1, events: [...events, event].slice(-MAX_EVENTS) })
        if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('size')
        await fs.mkdir(dirname(this.file), { recursive: true })
        await fs.writeFile(temp, body, { mode: 0o600 })
        await protectPrivateFileAsync(temp)
        await fs.rename(temp, this.file)
        return true
      } catch { try { await fs.rm(temp, { force: true }) } catch {} return false }
    })
    return this.pending
  }

  clear(): Promise<boolean> {
    this.phase = undefined; this.writtenAt = 0
    this.pending = this.pending.then(async () => { try { await fs.rm(this.file, { force: true }); return true } catch { return false } })
    return this.pending
  }
  flush(): Promise<boolean> { return this.pending }
}
