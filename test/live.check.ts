// Public runtime smoke checks for the daily-use routing contract.
// Pure/offline: no real tunnel, adapter, process or network activity.
import { createApply, onRoutingPatch } from '../src/main/apply'
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
  check('closed routing patch stays closed', onRoutingPatch('off', false) === 'none')
  check('running routing patch reapplies without changing master intent', onRoutingPatch('on', false) === 'start')
  check('hard block stops a running core', onRoutingPatch('on', true) === 'stop')

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
    live: async () => false,
    stop: async () => { stops++; phase = 'off' },
    changed: () => undefined
  })

  const enabled = await apply(settings(true))
  check('master-open idle state starts core when a route needs it', enabled.saved && enabled.applied && starts === 1 && phase === 'on')

  const disabled = await apply(settings(false))
  check('turning last routed card off stops only the core', disabled.saved && stops === 1 && phase === 'off')

  console.log(`live.check: ${total - failed}/${total} passed`)
  if (failed) process.exit(1)
})()
