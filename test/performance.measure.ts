// Bounded performance baseline for the production configuration compiler.
// Synthetic profiles only. No engine, sockets, system routes or private configuration.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildConfig, parseConf, runtimeAutoLive } from '../src/main/awg'
import { DEFAULTS } from '../src/main/store-core'
import { AUTO_ID, AUTO_LIVE_MAX } from '../src/shared/groups'
import type { Profile, Route, Settings } from '../src/shared/types'

const budgets = { samples: 30, warmup: 5, p95Ms: 500, maximumMs: 2000, retainedHeapBytes: 16 * 1024 * 1024, configBytes: 2 * 1024 * 1024 }
const keys = generateKeyPairSync('x25519')
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64')
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const base = parseConf(`[Interface]\nPrivateKey=${privateKey}\nAddress=10.77.0.2/32\n[Peer]\nPublicKey=${publicKey}\nAllowedIPs=0.0.0.0/0\nEndpoint=192.0.2.1:51820\n`, 'Synthetic')
const profiles: Profile[] = Array.from({ length: 1000 }, (_, index) => ({ ...base, id: `perf-${index}`, name: `Synthetic ${index}` }))
const routes: Route[] = Array.from({ length: 200 }, (_, index) => ({ id: `route-${index}`, kind: 'custom', name: `Route ${index}`, value: `route-${index}.example`, via: AUTO_ID, on: true }))
routes.push({ id: 'explicit', kind: 'custom', name: 'Explicit', value: 'explicit.example', via: 'perf-999', on: true })
const settings: Settings = { ...DEFAULTS, routes, groups: [], rest: 'direct' }

function compile() {
  const autoLive = runtimeAutoLive(settings, profiles)
  const config = buildConfig(profiles, settings, { api: { port: 19001, secret: 'synthetic-only' }, autoLive, selectors: true })
  const bytes = Buffer.byteLength(JSON.stringify(config))
  assert.ok(config.endpoints.length <= AUTO_LIVE_MAX + 1, 'Auto-only endpoints must stay bounded')
  assert.ok(config.endpoints.some(endpoint => endpoint.tag === 'p-perf-999'), 'The explicit profile must remain loaded')
  assert.ok(bytes <= budgets.configBytes, 'Generated configuration exceeded the size budget')
  return { endpoints: config.endpoints.length, bytes }
}

async function collect() {
  assert.equal(typeof global.gc, 'function', 'Run through scripts/test-performance.mjs to enable explicit GC')
  global.gc!()
  await new Promise<void>(resolve => setImmediate(resolve))
  global.gc!()
  return process.memoryUsage().heapUsed
}

async function main() {
  const started = new Date().toISOString()
  for (let i = 0; i < budgets.warmup; i++) compile()
  const before = await collect()
  const samples: number[] = []
  let output = { endpoints: 0, bytes: 0 }
  for (let i = 0; i < budgets.samples; i++) {
    const at = performance.now()
    output = compile()
    samples.push(performance.now() - at)
  }
  const after = await collect()
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]
  const metrics = { p50Ms: percentile(0.5), p95Ms: percentile(0.95), maximumMs: sorted.at(-1)!, retainedHeapBytes: Math.max(0, after - before), generatedConfigBytes: output.bytes, loadedEndpoints: output.endpoints }
  const passed = metrics.p95Ms <= budgets.p95Ms && metrics.maximumMs <= budgets.maximumMs && metrics.retainedHeapBytes <= budgets.retainedHeapBytes
  const report = { scope: 'production config compiler; synthetic inputs; no engine or network', started, platform: process.platform, node: process.version, commit: process.env.GITHUB_SHA ?? null, profiles: profiles.length, routes: routes.length, budgets, metrics, samplesMs: samples, passed }
  const file = resolve(process.env.WAARP_PERF_REPORT ?? 'out/validation/compiler-performance.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (!passed) process.exitCode = 1
}

main().catch(() => { console.error('Configuration performance check failed; no input data is logged.'); process.exitCode = 1 })
