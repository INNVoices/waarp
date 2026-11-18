import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { Profile, Status } from '../src/shared/types'
import { Catalog } from '../src/main/catalog'
import { Checker } from '../src/main/checker'
import { ConfError } from '../src/main/conf-error'
import { publicServicePaths, recoverPublicSources } from '../src/main/public-recovery'
import { PublicPathCleanupError, withPublicServicePath } from '../src/main/public-service-path'
import { preparePublicCandidate, publicCandidateHasPinnedEndpoints } from '../src/main/catalog-endpoint'
import { profileSig, tuned } from '../src/main/tune'
import { untilCancelled } from '../src/main/tun'
import { DEFAULTS } from '../src/main/store-core'
import { stub } from './stubs/electron'

// Execute the actual index integration function, selected with the TS parser.
// Importing all of Electron main would initialize the app and unrelated IPC.
// No production logic is copied into this fixture; all external capabilities
// are injected, while Catalog, recovery and path ownership are the real modules.
const sourceFile = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = sourceFile.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'fetchPublicCatalog')
assert(declaration && ts.isFunctionDeclaration(declaration), 'production public catalog integration must exist')
const executable = ts.transpileModule(declaration.getText(sourceFile), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const bestCallbacks: ts.ArrowFunction[] = []
function findBestCallback(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'secureIntentHandle' &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'catalog:best' &&
      node.arguments[1] && ts.isArrowFunction(node.arguments[1])) bestCallbacks.push(node.arguments[1])
  ts.forEachChild(node, findBestCallback)
}
findBestCallback(sourceFile)
assert.equal(bestCallbacks.length, 1, 'exactly one production catalog:best handler must exist')
const bestExecutable = ts.transpileModule('const catalogBest = ' + bestCallbacks[0].getText(sourceFile),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const source = 'https://raw.githubusercontent.com/example/offline-fixture/main/public.txt'
const body = 'trojan://synthetic-fixture@8.8.8.8:443#Fixture'
const own: Profile = { kind: 'out', id: 'own-fixture', name: 'Own', version: 'Trojan', host: 'personal.example', port: 443,
  addedAt: 1, outbound: { type: 'trojan', server: 'personal.example', server_port: 443, password: 'synthetic-own' } }
const directories: string[] = []

function fixture() {
  let lease: symbol | undefined, ownerCancel: (() => void) | undefined
  let seed = true
  const control = { clean: true, download: false, link: true, probes: true }
  const stats = { acquire: 0, stop: 0, live: 0, fetches: [] as string[] }
  const scope: Record<string, any> = {
    AbortController, AbortSignal, Date, ConfError,
    publicServicePaths, recoverPublicSources, PublicPathCleanupError, withPublicServicePath,
    publicCandidateHasPinnedEndpoints, preparePublicCandidate, profileSig, tuned, untilCancelled,
    quitting: false, publicCleanupBlocked: false, serviceTask: undefined, recentPublicPath: undefined,
    master: { revision: 1, open: false }, store: { profiles: [structuredClone(own)], settings: { serviceVia: own.id } },
    tunes: {}, netCache: undefined,
    send: () => undefined, statusView: (status: unknown) => status,
    adapters: async () => [], catalogLinkCurrent: () => control.link,
    publicServiceTransport: (proxy: { username: string }) => ({ path: proxy.username }),
    fetchCatalogSources: async (sources: string[], signal: AbortSignal, transport?: { path: string }) => {
      signal.throwIfAborted(); stats.fetches.push(transport?.path ?? 'direct')
      return sources.map(url => control.download ? { url, body } : { url, error: 'synthetic blocked source' })
    }
  }
  const proxy = (id: string, signal: AbortSignal) => ({ host: '127.0.0.1' as const, port: 1, username: id, password: 'synthetic-local', signal })
  scope.engine = {
    status: { phase: 'off' as Status['phase'], since: undefined as number | undefined }, loadedProfileIds: [own.id],
    async withHttpProxy(id: string, signal: AbortSignal, work: (proxy: unknown) => Promise<unknown>) {
      stats.live++; assert(scope.engine.loadedProfileIds.includes(id) || id === 'direct')
      return work(proxy(id, signal))
    }
  }
  scope.checker = {
    acquire(cancel: () => void) { assert(!lease); stats.acquire++; ownerCancel = cancel; return lease = Symbol('owned fixture') },
    owns(token: symbol) { return lease === token },
    release(token: symbol) { if (lease === token) { lease = undefined; ownerCancel = undefined } },
    async ensure() { return true },
    stop() { stats.stop++; const cancel = ownerCancel; lease = undefined; ownerCancel = undefined; cancel?.(); return Promise.resolve(control.clean) },
    async withHttpProxy(token: symbol, id: string, signal: AbortSignal, work: (proxy: unknown) => Promise<unknown>) {
      assert.equal(token, lease); signal.throwIfAborted()
      const result = await work(proxy(id, signal))
      signal.throwIfAborted(); return result
    }
  }
  const invoke = runInNewContext(executable + '\nfetchPublicCatalog', scope) as (sources: string[], signal: AbortSignal) => Promise<any[]>
  const directory = mkdtempSync(join(tmpdir(), 'waarp-public-integration-')); directories.push(directory)
  const catalog = new Catalog(directory, join(directory, 'missing-engine.exe'), () => undefined, () => control.probes && control.link,
    (sources, signal) => seed ? Promise.resolve(sources.map(url => ({ url, body }))) : invoke(sources, signal))
  scope.catalog = catalog
  return { catalog, control, stats, scope, async seed() { await catalog.refresh([source], { probe: false }); seed = false } }
}

function bestFixture() {
  let finish!: () => void
  const networkRead = new Promise<void>(resolve => { finish = resolve })
  const stats = { saves: 0, added: 0, readyReads: 0, starts: 0, stops: 0 }
  const store = { profiles: [] as Profile[], settings: structuredClone(DEFAULTS), save: () => { stats.saves++ } }
  const master = { open: false, revision: 1, current(revision: number) { return this.open && this.revision === revision } }
  const engine = { status: { phase: 'off' as Status['phase'] },
    start: () => { stats.starts++; throw new Error('catalog must not start TUN') },
    stop: () => { stats.stops++; throw new Error('catalog must not stop TUN') } }
  const scope = {
    store, master, engine, writeError: () => undefined, refreshCatalogNetwork: () => networkRead,
    catalog: { bestReady: (limit: number) => { assert.equal(limit, 5); stats.readyReads++; return [{ id: 'public-fixture' }] } },
    addPublic: (id: string) => { stats.added++; store.profiles.push({ ...own, id }); return id },
    randomBytes: () => Buffer.from([1, 2, 3, 4]), refreshNotices: async () => [], send: () => {}, snapshot: () => ({})
  }
  const invoke = runInNewContext(bestExecutable + '\ncatalogBest', scope) as () => Promise<{ ok: boolean; id?: string; error?: string }>
  return { invoke, finish, stats, store, master, engine }
}

async function main() {
  const original = { ensure: Checker.prototype.ensure, stop: Checker.prototype.stop, secure: stub.secure }
  let catalogChecks = 0
  Checker.prototype.ensure = async () => { catalogChecks++; return false }
  Checker.prototype.stop = async () => true
  stub.secure = false
  try {
    {
      const f = fixture(); await f.seed(); f.control.clean = false
      const before = catalogChecks
      const result = await f.catalog.refresh([source])
      assert.equal(f.stats.acquire, 1); assert.equal(f.stats.stop, 1)
      assert.equal(f.stats.fetches.length, 1, 'terminal loader cleanup must not try another recovery path')
      assert.equal(f.scope.publicCleanupBlocked, true, 'index closes the runtime recovery gate after unconfirmed cleanup')
      assert.equal(f.scope.serviceTask, undefined, 'service task is released only after its awaited cleanup outcome')
      assert.equal(catalogChecks, before, 'Catalog must not start a separate probe checker after a fatal loader cleanup')
      assert.equal(result.total, 1); assert.equal(result.readyCount, 0)
      assert(result.sources.some(item => /не подтвердил остановку/.test(item.error ?? '')), 'terminal error type survives index → recovery → Catalog')
    }
    {
      const f = fixture(); await f.seed()
      const before = catalogChecks
      await f.catalog.refresh([source])
      assert(f.stats.fetches.length >= 2, 'ordinary source failure can try the saved public reserve')
      assert(!f.stats.fetches.includes('direct'), 'a personal preferred path never silently falls back to Direct')
      assert.equal(f.scope.publicCleanupBlocked, false)
      assert(catalogChecks > before, 'ordinary blocked sources still allow independent verification of cached candidates')
    }
    {
      const f = fixture(); await f.seed(); f.control.download = true
      f.scope.engine.status.phase = 'on'; f.scope.engine.status.since = 100; f.scope.master.open = true
      const before = catalogChecks
      const result = await f.catalog.refresh([source], { probe: false })
      assert.equal(result.total, 1); assert.equal(f.stats.live, 1)
      assert.equal(f.stats.acquire, 0); assert.equal(f.stats.stop, 0); assert.equal(catalogChecks, before)
      assert.equal(f.scope.recentPublicPath, own.id)
      assert.equal(f.scope.serviceTask, undefined)
    }
    {
      const f = bestFixture(), beforeRoutes = JSON.stringify(f.store.settings.routes)
      const pending = f.invoke(); f.finish()
      const result = await pending
      assert.equal(result.ok, true, 'a stable OFF master may save a verified public group')
      assert.equal(f.stats.saves, 1); assert.equal(f.stats.added, 1)
      assert.equal(f.store.settings.groups.length, 1)
      assert.equal(f.store.settings.groups[0].id, result.id)
      assert.equal(f.store.settings.groups[0].members.join(','), 'public-fixture')
      assert.equal(JSON.stringify(f.store.settings.routes), beforeRoutes, 'creating a group cannot retarget any card')
      assert.deepEqual([f.master.open, f.engine.status.phase, f.stats.starts, f.stats.stops], [false, 'off', 0, 0])
    }
    for (const changed of ['revision', 'phase'] as const) {
      const f = bestFixture(), pending = f.invoke()
      if (changed === 'revision') f.master.revision++
      else f.engine.status.phase = 'on'
      f.finish()
      const result = await pending
      assert.equal(result.ok, false, changed + ' changing during network refresh invalidates group creation')
      assert.deepEqual([f.stats.saves, f.stats.added, f.stats.readyReads, f.stats.starts, f.stats.stops], [0, 0, 0, 0, 0],
        'stale group creation must stop before any profile/settings write or native transition')
      assert.equal(f.store.settings.groups.length, 0); assert.equal(f.store.profiles.length, 0)
    }
    console.log('public-catalog-integration: production function and IPC callback, terminal cleanup, recovery gate, cached verification, ON without another checker, stable OFF group creation and stale revision/phase rejection PASS')
  } finally {
    Checker.prototype.ensure = original.ensure; Checker.prototype.stop = original.stop; stub.secure = original.secure
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
