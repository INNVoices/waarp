import assert from 'node:assert/strict'
import { diagnosisTarget } from '../src/main/diagnosis-target'
import { setListResolver } from '../src/main/awg'
import { DEFAULTS } from '../src/main/store-core'
import type { Settings } from '../src/shared/types'

const settings: Settings = { ...structuredClone(DEFAULTS), rest: 'public-rest', ruDirect: false, lanDirect: true, routes: [
  { id: 'app', kind: 'app', name: 'Browser', exe: 'C:\\browser.exe', via: 'app-only', on: true },
  { id: 'off', kind: 'custom', name: 'Disabled', value: 'youtube.com', via: 'off', on: false },
  { id: 'site', kind: 'preset', preset: 'youtube', name: 'YouTube', via: 'public-current', on: true },
  { id: 'ip', kind: 'custom', name: 'Network', value: '8.8.8.0/24', via: 'ip-path', on: true },
  { id: 'list', kind: 'list', name: 'List', list: 'fixture', via: 'listed', on: true }
] }
setListResolver(id => id === 'fixture' ? ['example.org'] : [])
assert.equal(diagnosisTarget('www.youtube.com', settings).route?.id, 'site')
assert.equal(diagnosisTarget('www.youtube.com', settings).via, 'public-current')
assert.equal(diagnosisTarget('8.8.8.8', settings).route?.id, 'ip')
assert.equal(diagnosisTarget('a.example.org', settings).via, 'listed')
assert.deepEqual(diagnosisTarget('unmatched.example', settings), { via: 'public-rest' })
assert.deepEqual(diagnosisTarget('192.168.1.1', settings), { via: 'direct' })
assert.deepEqual(diagnosisTarget('vk.com', { ...settings, ruDirect: true }), { via: 'direct' })
assert.equal(diagnosisTarget('notyoutube.com', settings).via, 'public-rest')
setListResolver(() => [])
console.log('diagnosis-target: domain/list/CIDR route, bypasses and no process guessing PASS')
