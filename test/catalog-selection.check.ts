import { localized } from '../src/shared/localization'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { Checker } from '../src/main/checker'
import { checkConfig } from '../src/main/awg'

// Exercise the actual IPC callbacks with only external Electron/native
// capabilities substituted. This covers the user-visible ON rejection, not a
// duplicate handwritten admission condition.
const source = ts.createSourceFile('index.ts', readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true)
function ipcCallback(channel: string, scope: Record<string, unknown>): (...args: unknown[]) => Promise<any> {
  const callbacks: ts.ArrowFunction[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['secureHandle', 'secureIntentHandle'].includes(node.expression.text) &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel &&
        node.arguments[1] && ts.isArrowFunction(node.arguments[1])) callbacks.push(node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(callbacks.length, 1)
  const executable = ts.transpileModule('const callback = ' + callbacks[0].getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  return runInNewContext(executable + '\ncallback', { ...scope, localized })
}

async function main() {
  for (const open of [false, true]) for (const phase of ['on', 'off']) {
    let checked = 0
    const verify = ipcCallback('catalog:verify', {
      engineIntegrity: true, runtimeRecovery: { ready: true }, master: { open }, engine: { status: { phase } },
      refreshCatalogNetwork: async () => undefined,
      catalog: { verify: async () => { checked++; return { readyCount: 1 } } }
    })
    const result = await verify()
    assert.equal(result.readyCount, 1); assert.equal(checked, 1, `${phase}/${open} permits an isolated public check`)
  }
  for (const phase of ['starting', 'stopping', 'error']) {
    const verify = ipcCallback('catalog:verify', {
      engineIntegrity: true, runtimeRecovery: { ready: true }, engine: { status: { phase } }, catalog: { state: { total: 1 } },
      refreshCatalogNetwork: () => { throw new Error('transitional state cannot start a check') }
    })
    assert((await verify()).error)
  }
  for (const success of [false, true]) {
    const calls: string[] = [], id = 'pub-' + 'a'.repeat(20)
    const store = { profiles: [] as unknown[], save: () => calls.push('save') }
    const add = ipcCallback('catalog:add', {
      engineIntegrity: true, runtimeRecovery: { ready: true }, master: { open: true, revision: 1 }, quitting: false,
      writeError: () => undefined, refreshCatalogNetwork: async () => undefined, store,
      catalog: { verifyNode: async (selected: string) => { assert.equal(selected, id); calls.push('verify'); return { ok: success, error: 'unreachable' } } },
      addPublic: (selected: string) => { assert.equal(selected, id); calls.push('add'); return selected },
      refreshNotices: async () => undefined, send: () => undefined, snapshot: () => ({})
    })
    const result = await add(undefined, id)
    assert.equal(result.ok, success)
    assert.deepEqual(calls, success ? ['verify', 'add', 'save'] : ['verify'])
  }
  {
    const master = { open: true, revision: 1 }
    const add = ipcCallback('catalog:add', {
      engineIntegrity: true, runtimeRecovery: { ready: true }, master, quitting: false,
      writeError: () => undefined, refreshCatalogNetwork: async () => undefined,
      catalog: { verifyNode: async () => { master.open = false; master.revision++; return { ok: true } } },
      addPublic: () => { throw new Error('obsolete selection must not import') }
    })
    assert.equal((await add(undefined, 'pub-' + 'a'.repeat(20))).ok, false, 'manual OFF wins over a pending selection')
  }

  // Real local controller requests exercise Checker.req/delay, bounded work,
  // fallback and cancellation. No public relays or native TUN are contacted.
  const dir = mkdtempSync(join(tmpdir(), 'waarp-catalog-probes-'))
  let cancel: Checker | undefined
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-secret')
    const url = new URL(request.url!, 'http://127.0.0.1')
    const target = new URL(url.searchParams.get('url')!).hostname
    requests.push(url.pathname + '|' + target)
    if (cancel && target === 'cp.cloudflare.com') await cancel.stop()
    const delay = url.pathname === '/proxies/p-a/delay' ? 12 :
      url.pathname === '/proxies/p-b/delay' && target === 'cp.cloudflare.com' ? 31 : undefined
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ delay }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); assert(address && typeof address !== 'string')
    const make = (ids: string[]) => {
      const checker = new Checker(process.execPath, dir)
      Object.assign(checker, { child: {}, api: { port: address.port, secret: 'synthetic-secret' }, ids })
      return checker
    }
    const checker = make(['a', 'b', 'c'])
    const results = await checker.pings()
    assert.deepEqual(results, { a: 12, b: 31, c: undefined })
    assert.equal(requests.length, 5, 'only failed primary targets receive a fallback request')
    assert(!requests.includes('/proxies/p-a/delay|cp.cloudflare.com'), 'a healthy primary is not checked twice')
    await checker.stop()
    cancel = make(['b'])
    assert.deepEqual(await cancel.pings(), {}, 'cancellation discards a late successful fallback')
    const config = checkConfig([], { port: 19091, secret: 'synthetic-secret' })
    assert.equal(config.route.auto_detect_interface, true, 'checker outbound is bound away from the main TUN')
    assert.equal('inbounds' in config, false, 'ordinary catalog checks cannot create a TUN inbound')
    console.log('catalog-selection: ON/OFF IPC admission, exact verified import, failed selection, manual OFF, actual local controller fallback and cancellation PASS')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
