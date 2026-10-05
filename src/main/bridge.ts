import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { protectPrivateFile } from './private-file'

export const PIPE = '\\\\.\\pipe\\waarp'
export const BRIDGE_API = 1

export interface BridgeHost {
  version: string
  status: () => unknown
  /** companion route control. Inputs are untrusted; the host validates the target descriptor and the intent. */
  routes?: {
    list: () => unknown
    ensure: (target: unknown, intent: unknown) => Promise<unknown>
    open: (target: unknown) => unknown
  }
  /** Redacted in Engine before it reaches the bridge. Read-only diagnostics for local support. */
  log?: () => string[]
  failed?: () => void
}

type Req = { id?: unknown; token?: string; method?: string; params?: unknown }
/** RC2 H: a request id is a safe integer-or-finite number, a string up to 128 chars, null or absent */
export const okId = (id: unknown): boolean => id === undefined || id === null || (typeof id === 'number' && Number.isFinite(id) && Math.abs(id) <= Number.MAX_SAFE_INTEGER) || (typeof id === 'string' && id.length <= 128)

const PLANNED = new Set(['connect', 'disconnect', 'routes.list', 'routes.ensure', 'routes.remove', 'probe'])
const ROUTES = ['routes.list', 'routes.ensure', 'routes.open']
const param = (p: unknown, k: string): unknown => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>)[k] : undefined)

export function startBridge(dir: string, host: BridgeHost, pipe = PIPE): Server {
  const token = randomBytes(24).toString('hex')
  const tokenFile = join(dir, 'bridge.json')
  writeFileSync(tokenFile, JSON.stringify({ pipe, token, api: BRIDGE_API, pid: process.pid }, null, 1), { mode: 0o600 })
  try { protectPrivateFile(tokenFile) }
  catch {
    try { rmSync(tokenFile, { force: true }) } catch { /* the bridge still stays closed */ }
    throw new Error('Bridge token ACL could not be applied')
  }

  // D: route writes run one at a time; list / open / status do not wait
  let writes: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const run = writes.then(fn, fn); writes = run.catch(() => undefined); return run }
  const methods = ['hello', 'status', ...(host.log ? ['log'] : []), ...(host.routes ? ROUTES : [])]
  const answer = async (r: Req): Promise<Record<string, unknown>> => {
    if (r.token !== token) return { error: 'unauthorized' }
    if (r.method === 'hello') return { result: { app: 'waarp', version: host.version, api: BRIDGE_API, methods, planned: [...PLANNED].filter(m => !methods.includes(m)) } }
    if (r.method === 'status') return { result: host.status() }
    if (r.method === 'log' && host.log) return { result: host.log().slice(-300) }
    if (host.routes && r.method === 'routes.list') return { result: host.routes.list() }
    if (host.routes && r.method === 'routes.ensure') return wrap(await serial(() => host.routes!.ensure(param(r.params, 'target'), param(r.params, 'intent'))))
    if (host.routes && r.method === 'routes.open') return wrap(host.routes.open(param(r.params, 'target')))
    if (r.method && PLANNED.has(r.method)) return { error: 'not_implemented' }
    return { error: 'unknown_method' }
  }
  const wrap = (v: unknown) => (v && typeof v === 'object' && 'error' in v ? { error: (v as { error: unknown }).error } : { result: v })

  let clients = 0
  const server = createServer((sock: Socket) => {
    if (clients >= 32) { sock.destroy(); return }
    clients++
    sock.once('close', () => { clients-- })
    sock.setTimeout(30_000, () => sock.destroy())
    let buf = ''
    let requests = 0
    sock.setEncoding('utf8')
    sock.on('data', chunk => {
      buf += chunk
      if (buf.length > 64 * 1024) { sock.destroy(); return }
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        if (++requests > 100 || line.length > 64 * 1024) { sock.destroy(); return }
        let req: Req
        try { req = JSON.parse(line) } catch { sock.write(JSON.stringify({ error: 'bad_json' }) + '\n'); continue }
        if (!req || typeof req !== 'object' || Array.isArray(req) || (req.token !== undefined && (typeof req.token !== 'string' || req.token.length > 128)) || typeof req.method !== 'string' || req.method.length > 80 || !okId(req.id)) {
          sock.write(JSON.stringify({ error: 'bad_request' }) + '\n'); continue
        }
        void answer(req).then(a => { if (!sock.destroyed) sock.write(JSON.stringify({ id: req.id ?? null, ...a }) + '\n') }, () => { if (!sock.destroyed) sock.write(JSON.stringify({ id: req.id ?? null, error: 'internal' }) + '\n') })
      }
    })
    sock.on('error', () => undefined)
  })
  server.on('error', () => {
    try { rmSync(tokenFile, { force: true }) } catch { /* an unusable token must not be advertised */ }
    host.failed?.()
  })
  server.on('close', () => { try { rmSync(tokenFile, { force: true }) } catch { /* stale ACL-protected token is replaced on next start */ } })
  server.listen(pipe)
  return server
}
