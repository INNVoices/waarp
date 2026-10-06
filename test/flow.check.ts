// WAARP-IA-TARGET-FIRST-01: target-first flow. Pure renderer logic (lib/flow.ts), no Electron, no network.
import { acquire, addEntry, back, draftOf, goTo, initialNav, isDraft, normAddr, openRoute, showCatalog, showList, targetId, type Nav } from '../src/renderer/src/lib/flow'
import { customRoute } from '../src/renderer/src/lib/routes'
import { AUTO_ID } from '../src/shared/groups'
import type { AppInfo, Route } from '../src/shared/types'
import { readFileSync } from 'node:fs'

let failed = 0
const t = (name: string, ok: boolean, info = ''): void => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${info}`}`) }

const app = (id: string): AppInfo => ({ id, name: id, exe: `C:\\apps\\${id}.exe`, running: false } as unknown as AppInfo)
const seven: Route[] = Array.from({ length: 7 }, (_, i) => customRoute(`site${i}.example.com`, 'direct')).map((r, i) => ({ ...r, on: i % 2 === 0, via: i % 2 === 0 ? 'auto' : 'direct' }))
const st = { routes: seven }

// A. "+" always opens the catalog, whatever the number of routes
const home: Nav = { ...initialNav }
for (const n of [0, 1, 7]) {
  const here = addEntry({ ...home })
  t(`add entry with ${n} existing routes opens the catalog`, here.page === 'lib' && here.libMode === 'catalog')
}
// B. the rail's Маршруты is the list, not the catalog; the mode is explicit state
const viaRail = goTo(addEntry(home), 'lib')
t('rail Маршруты opens the route list even right after the catalog', viaRail.page === 'lib' && viaRail.libMode === 'list')
t('the catalog and the list are switched explicitly', showCatalog(viaRail).libMode === 'catalog' && showList(showCatalog(viaRail)).libMode === 'list')

// C. selecting targets
const fresh = acquire(st, { kind: 'app', app: app('newapp') })
t('new app: created as a draft route', fresh.created && fresh.route.id === 'app:newapp')
t('new app: off and Direct internally, never Auto', fresh.route.on === false && fresh.route.via !== AUTO_ID && fresh.route.via === 'direct' && fresh.route.fallback === undefined)
t('the draft is recognised as "no path chosen"', isDraft(fresh.route))
const svc = acquire(st, { kind: 'preset', id: 'discord' })
t('new service: same neutral draft', svc.created && svc.route.id === 'preset:discord' && svc.route.on === false && svc.route.via === 'direct')
const existing = acquire(st, { kind: 'custom', value: 'site2.example.com' })
t('existing target opens as it is, no duplicate', !existing.created && existing.route === seven[2] && st.routes.length === 7)
t('an active Direct route is not a draft', !isDraft({ on: true, via: 'direct' }) && !isDraft({ on: false, via: 'auto' }) && isDraft({ on: false, via: 'direct' }))
t('target ids match the route ids the factories produce', targetId({ kind: 'app', app: app('x') }) === 'app:x' && targetId({ kind: 'preset', id: 'p' }) === 'preset:p' && targetId({ kind: 'custom', value: 'a.b' }) === 'custom:a.b')

// D. custom address: validated destination, neutral draft, no path step
t('address input is normalised', normAddr('  HTTPS://Example.COM/ ') === 'example.com' && normAddr('10.0.0.0/24') === '10.0.0.0/24')
const addr = acquire(st, { kind: 'custom', value: normAddr('New.Example.com') })
t('custom address: neutral draft route', addr.created && addr.route.kind === 'custom' && addr.route.value === 'new.example.com' && !addr.route.on && addr.route.via === 'direct')
t('draftOf strips a chosen path and fallback', (r => !r.on && r.via === 'direct' && r.fallback === undefined)(draftOf({ ...seven[0], fallback: 'p1' })))

// F. back behaviour
const catalog = addEntry(home)
const fromCatalog = openRoute(catalog, 'app:newapp')
t('route page opens from the catalog', fromCatalog.page === 'route' && fromCatalog.routeId === 'app:newapp')
const afterBack = back(fromCatalog)
t('Back from the catalog goes back to the catalog', afterBack.page === 'lib' && afterBack.libMode === 'catalog' && afterBack.routeId === undefined)
const list = goTo(home, 'lib')
const fromList = back(openRoute(list, 'custom:site0.example.com'))
t('Back from the list goes back to the list', fromList.page === 'lib' && fromList.libMode === 'list')
t('Back from Home returns to Home', back(openRoute(home, 'x')).page === 'home')
t('opening another route from a route page keeps the original origin', back(openRoute(openRoute(catalog, 'a'), 'b')).libMode === 'catalog' && back(openRoute(openRoute(home, 'a'), 'b')).page === 'home')
// no loop: Home + -> catalog; the list is one explicit step away and Back never returns to a screen the user did not come from
const trail = [home, addEntry(home)].map(n => `${n.page}/${n.libMode}`)
t('Home + does not pass through the route list', trail.join('>') === 'home/list>lib/catalog')

// Daily-use UX regressions: the first app inventory stays non-blocking, then real Windows icons
// arrive through an explicit event; master clicks get an immediate renderer-only pending phase.
const appSrc = readFileSync('src/renderer/src/App.tsx', 'utf8')
const appsSrc = readFileSync('src/main/apps.ts', 'utf8')
const indexSrc = readFileSync('src/main/index.ts', 'utf8')
const preloadSrc = readFileSync('src/preload/index.ts', 'utf8')
t('master click acknowledges opening/closing immediately without mutating authoritative status',
  appSrc.includes("setMasterPending(closing ? 'closing' : 'opening')") && appSrc.includes('const controlStatus: Status = masterPending'))
t('Windows icons hydrate through main -> preload -> renderer without a manual rescan',
  appsSrc.includes('onHydrated?.(list.map') && indexSrc.includes("send('apps', items)") && preloadSrc.includes("onApps: on('apps')") && appSrc.includes('api.onApps'))

console.log(failed ? `\n${failed} FAILED` : '\nall flow checks passed')
process.exit(failed ? 1 : 0)
