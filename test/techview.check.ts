import { configOf, diagnosticsOf, redact } from '../src/main/techview'
import { parseVless } from '../src/main/vless'
import { DEFAULTS } from '../src/main/store-core'
import type { ProfileView, Settings, Status } from '../src/shared/types'

let count = 0
function ok(value: unknown, message: string) { count++; if (!value) throw new Error(message) }

const uuid = '11111111-2222-4333-8444-555555555555'
const p = parseVless(`vless://${uuid}@private.example:443?type=xhttp&security=tls&path=%2Fcredential-path%3Ftoken%3Dsecret-query`)
p.vless.extra = { headers: { Host: 'front.example', Cookie: 'session-cookie', 'X-Custom': 'custom-credential', Authorization: 'Bearer access-secret' } }
const config = JSON.stringify(configOf(p))
for (const secret of [uuid, 'credential-path', 'secret-query', 'session-cookie', 'custom-credential', 'access-secret']) ok(!config.includes(secret), `developer config leaked ${secret}`)
ok(config.includes('front.example') && config.includes('private.example'), 'local config retains nonsecret endpoint/Host information')
const nested = JSON.stringify(redact({ username: 'private-login', tls: { public_key: 'visible-public-key', public_key_password: 'hidden-password', key_share: 'hybrid', short_id: 'hidden-short-id', client_certificate: 'identity-certificate' }, transport: { service_name: 'hidden-service-path', headers: { Host: 'front.example?token=hidden-host-query' } } }))
for (const secret of ['private-login', 'hidden-password', 'hidden-short-id', 'identity-certificate', 'hidden-service-path', 'hidden-host-query']) ok(!nested.includes(secret), `redacted config leaked ${secret}`)
ok(nested.includes('visible-public-key') && nested.includes('hybrid'), 'exact public-key/key-share fields remain visible')

const privateId = 'profile-secret-identity'
const routeId = 'app:C:\\Users\\PersonalName\\Client.exe'
const profile: ProfileView = { kind: 'vless', id: privateId, name: 'Private customer', host: 'private.example', port: 443, address: ['10.20.30.40'], version: 'secret version field', source: 'personal', clientPublicKey: 'key-material', tech: [['sni', 'private-sni.example']], notApplied: ['private-query-name'] }
const settings: Settings = { ...DEFAULTS, rest: privateId, groups: [{ id: 'g-secret', name: 'Private group', policy: 'first', members: [privateId] }], routes: [{ id: routeId, kind: 'app', name: 'Private application', exe: 'C:\\Users\\PersonalName\\Client.exe', via: privateId, fallback: 'g-secret', on: true }] }
const status: Status = { phase: 'on', open: true, engine: 'up', error: 'secret runtime URL https://private.example/access-key', pings: { [privateId]: 37, direct: 5 }, health: { [privateId]: 'ok' }, fallback: { [routeId]: privateId }, picked: { 'g-secret': privateId }, down: 1024, up: 512, downTotal: 8192, upTotal: 4096, pingAt: 100, routes: { [routeId]: { desired: privateId, effective: privateId, state: 'ok' } } }
const report = diagnosticsOf({ app: '0.4.1', integrity: true, at: '2026-11-17T12:00:00Z', status, profiles: [profile], settings, log: ['ERROR secret-log-password at private.example', 'WARN C:\\Users\\PersonalName\\Client.exe'] })
const text = JSON.stringify(report)
for (const secret of [privateId, 'Private customer', 'private.example', '10.20.30.40', 'secret version', 'key-material', 'private-sni', 'private-query-name', 'Private group', 'Private application', 'PersonalName', 'access-key', 'secret-log-password', 'g-secret']) ok(!text.includes(secret), `shareable diagnostics leaked ${secret}`)
ok(report.profiles[0].ping === 37 && report.status.directPing === 5 && report.status.down === 1024, 'useful measurements remain in the report')
ok(report.routes[0].via === report.profiles[0].id && report.settings.groups[0].members[0] === report.profiles[0].id, 'anonymous IDs retain route/group relationships')
ok(report.log.errors === 1 && report.log.warnings === 1 && report.log.textOmitted && report.status.hasError, 'errors remain observable without arbitrary log text')
ok(profile.name === 'Private customer' && p.vless.path?.includes('credential-path'), 'diagnostics and config previews never alter the original profile')
console.log(`techview.check: ${count} checks`)
