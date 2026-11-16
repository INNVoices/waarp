import { Health } from '../src/main/health'

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

console.log(`health.check: ${checked} checks`)
