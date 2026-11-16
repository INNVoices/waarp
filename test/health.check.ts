import { Health } from '../src/main/health'
import { Engine } from '../src/main/engine'
import { Checker } from '../src/main/checker'
import { FbTracker } from '../src/main/fallback'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let checked = 0
const eq = (actual: unknown, expected: unknown, label: string) => {
  checked++
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

const h = new Health()
eq(h.step({ a: 12 }, ['a']).a, 'ok', 'finite latency is healthy')
eq(h.step({ a: 0 }, ['a']).a, 'ok', 'zero latency is valid')
eq(h.step({ a: Number.NaN }, ['a']).a, 'degraded', 'NaN is a failure')
eq(h.step({ a: Number.POSITIVE_INFINITY }, ['a']).a, 'down', 'infinity is not healthy')
eq(h.step({ a: 5 }, ['a']).a, 'ok', 'valid response resets failures')
eq(h.step({ a: -2 }, ['a']).a, 'degraded', 'negative latency is a failure')
eq(h.step({ a: -1 }, ['a']).a, 'down', 'second invalid probe is down')
eq(h.step({}, ['a'], new Set(['a'])).a, 'busy', 'busy does not count a failure')
eq(h.step({ a: 2 }, ['a']).a, 'ok', 'recovery after busy')
eq(h.step({}, ['a']).a, 'degraded', 'first missing probe degrades')
h.step({}, [])
eq(h.step({}, ['a']).a, 'degraded', 'removed ID loses old failures')
eq(h.step({}, ['a']).a, 'down', 'second failure still marks down')
h.reset()
eq(h.step({}, ['a']).a, 'degraded', 'reset clears failures')

// Auto / off-state checks rotate through a bounded batch. A member skipped for
// one round is not removed from the library and must retain its last failure.
const rotating = new Health()
const members = ['a', 'b']
eq(rotating.step({}, ['a'], undefined, members).a, 'degraded', 'first measured failure in rotating batch')
eq(rotating.step({ b: 10 }, ['b'], undefined, members).b, 'ok', 'next batch measures another member')
eq(rotating.step({}, ['a'], undefined, members).a, 'down', 'second actual failure survives a skipped batch')
rotating.step({}, [], undefined, ['b'])
eq(rotating.step({}, ['a'], undefined, members).a, 'degraded', 'actual deletion clears history before re-add')
rotating.step({}, [], undefined, members)
eq(rotating.step({}, ['a'], undefined, members).a, 'down', 'unavailable checker creates no measured round')
eq(Object.keys(rotating.step({ removed: 1 }, ['removed'], undefined, members)).length, 0, 'removed member cannot regain health from a stale result')

;(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-health-'))
  try {
    const engine = new Engine(process.execPath, join(dir, 'engine'), process.execPath)
    const checker = new Checker(process.execPath, join(dir, 'checker'))
    for (const raw of [0, 8, -1, Number.NaN, Infinity, undefined, null, '12']) {
      // The actual controller response readers, with only the transport replaced.
      // No core or network is started by these checks.
      ;(engine as any).req = async () => ({ delay: raw })
      ;(checker as any).req = async () => ({ delay: raw })
      const expected = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined
      eq(await (engine as any).delay('synthetic'), expected, `engine accepts only valid raw delay ${String(raw)}`)
      eq(await (checker as any).delay('synthetic', 'https://example.invalid'), expected, `checker accepts only valid raw delay ${String(raw)}`)
    }

    const fallback = new FbTracker([{ tag: 'pair', main: 'a', fb: 'b' }], 1)
    let switches = 0
    const apply = async () => { switches++; return true }
    for (const invalid of [Number.NaN, Infinity, -1]) {
      await fallback.step({ a: undefined, b: invalid }, apply)
    }
    eq(switches, 0, 'invalid fallback latency never authorizes a switch')
    await fallback.step({ a: undefined, b: 0 }, apply)
    eq(fallback.active().length, 1, 'zero millisecond response is a working fallback')
    for (const invalid of [Number.NaN, Infinity, -1]) {
      await fallback.step({ a: invalid, b: 0 }, apply)
    }
    eq(switches, 1, 'invalid primary latency never authorizes return')
    await fallback.step({ a: 0, b: 10 }, apply)
    eq(fallback.active().length, 0, 'zero millisecond response recovers primary')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  console.log(`health.check: ${checked} checks`)
})().catch(error => { console.error(error); process.exitCode = 1 })
