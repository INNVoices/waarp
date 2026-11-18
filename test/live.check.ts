// Public runtime smoke checks for the daily-use routing contract.
// Pure/offline: no real tunnel, adapter, process or network activity.
import { createApply } from '../src/main/apply'
import { prepareStart } from '../src/main/connect'
import { DEFAULTS } from '../src/main/store-core'
import type { Notice, Route, Settings } from '../src/shared/types'

let failed = 0
let total = 0
const check = (name: string, ok: boolean): void => {
  total++
  if (!ok) { failed++; console.error('FAIL', name) }
}

const route = (on: boolean): Route => ({
  id: 'site:test.example',
  kind: 'custom',
  name: 'test.example',
  value: 'test.example',
  via: 'path-a',
  on
})

const settings = (on: boolean): Settings => ({ ...DEFAULTS, routes: [route(on)] })

;(async () => {

  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const prepared = prepareStart({
    stopChecker: async () => { order.push('stop'); await gate; return true },
    notices: async () => { order.push('notices'); return [] }
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  check('pre-start checker stop and notice scan run in parallel', order.includes('stop') && order.includes('notices'))
  release()
  check('clean pre-start is accepted', (await prepared).ok)

  const blocker: Notice = { level: 'block', title: 'blocked', text: '' }
  const blocked = await prepareStart({ stopChecker: async () => true, notices: async () => [blocker] })
  check('blocking notice prevents start', !blocked.ok)

  for (const failed of ['stop', 'scan']) {
    const ready = await prepareStart({
      stopChecker: async () => { if (failed === 'stop') throw new Error('checker failed'); return true },
      notices: async () => { if (failed === 'scan') throw new Error('scan failed'); return [] }
    })
    check(`pre-start ${failed} exception is a reported refusal`, !ready.ok)
  }

  let current = settings(false)
  let phase = 'off'
  let starts = 0
  let stops = 0
  const apply = createApply({
    get: () => current,
    set: next => { current = next },
    save: () => undefined,
    phase: () => phase,
    open: () => true,
    blocked: async () => false,
    demandsTunnel: next => next.routes.some(r => r.on && r.via !== 'direct'),
    start: async () => { starts++; phase = 'on' },
    live: async () => phase === 'on',
    stop: async () => { stops++; phase = 'off' },
    changed: () => undefined
  })

  const enabled = await apply(settings(true))
  check('already-open idle master applies the first selected route without a second ON decision', enabled.saved && enabled.applied && starts === 1 && phase === 'on')

  // The last card can be disabled without revoking the separate master ON intent.
  const disabled = await apply(settings(false))
  check('turning last routed card off changes routing but leaves manually opened TUN up',
    disabled.saved && disabled.applied && starts === 1 && stops === 0 && phase === 'on')

  console.log(`live.check: ${total - failed}/${total} passed`)
  if (failed) process.exit(1)
})()
