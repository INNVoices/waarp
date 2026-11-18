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
import { stub } from './stubs/electron'

// Execute the actual index integration function, selected with the TS parser.
// Importing all of Electron main would initialize the app and unrelated IPC.
// No production logic is copied into this fixture; all external capabilities
// are injected, while Catalog, recovery and path ownership are the real modules.
const sourceFile = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = sourceFile.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'fetchPublicCatalog')
assert(declaration && ts.isFunctionDeclaration(declaration), 'production public catalog integration must exist')
const executable = ts.transpileModule(declaration.getText(sourceFile), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
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
    console.log('public-catalog-integration: production index function, typed terminal cleanup across Catalog, runtime recovery gate, ordinary cached verification, no silent Direct and ON without another checker PASS')
  } finally {
    Checker.prototype.ensure = original.ensure; Checker.prototype.stop = original.stop; stub.secure = original.secure
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
