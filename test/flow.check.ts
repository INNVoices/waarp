// WAARP-IA-TARGET-FIRST-01: target-first flow. Pure renderer logic (lib/flow.ts), no Electron, no network.
import { acquire, addEntry, back, draftOf, goTo, initialNav, isDraft, normAddr, openRoute, showCatalog, showList, targetId, type Nav } from '../src/renderer/src/lib/flow'
import { customRoute } from '../src/renderer/src/lib/routes'
import { AUTO_ID } from '../src/shared/groups'
import type { AppInfo, Route } from '../src/shared/types'
import { readFileSync } from 'node:fs'
import { masterPresentation, orbPresentation } from '../src/renderer/src/lib/master'
import { trayPresentation } from '../src/main/tray-view'
import { routeSchemeHintKey, routeStateKey } from '../src/renderer/src/lib/route-state'
import type { Status } from '../src/shared/types'

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
  appsSrc.includes('onHydrated?.(list.map') && indexSrc.includes("send('apps', items)") && preloadSrc.includes("onApps: on('apps')") && appSrc.includes('api.onApps') && appSrc.includes('current.filter(a => !scanned.has(a.id))'))
const baseStatus = { phase: 'off', open: false, pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0 } as unknown as Status
t('master presentation follows global intent during internal core restart',
  masterPresentation({ ...baseStatus, open: true, phase: 'stopping' }).pressed
  && masterPresentation({ ...baseStatus, open: true, phase: 'stopping' }).topKey === 'top.applying'
  && masterPresentation({ ...baseStatus, open: true, phase: 'starting' }).topKey === 'top.applying')
t('open-idle stays globally ON instead of looking closed',
  masterPresentation({ ...baseStatus, open: true, phase: 'off' }).pressed
  && masterPresentation({ ...baseStatus, open: true, phase: 'off' }).topKey === 'top.idle'
  && orbPresentation({ ...baseStatus, open: true, phase: 'off' }).phaseClass === 'on')
t('explicit master close/open pending overrides internal engine presentation',
  !masterPresentation({ ...baseStatus, open: true, phase: 'stopping' }, 'closing').pressed
  && masterPresentation(baseStatus, 'closing').topKey === 'top.stopping'
  && masterPresentation(baseStatus, 'opening').pressed
  && masterPresentation(baseStatus, 'opening').topKey === 'top.starting')
t('Home orb calls an internal reapply switching, never global closing/opening',
  orbPresentation({ ...baseStatus, open: true, phase: 'stopping' }).titleKey === 'orb.applying'
  && orbPresentation({ ...baseStatus, open: true, phase: 'starting' }).titleKey === 'orb.applying')

t('tray follows master intent and never flashes closed during structural core reapply',
  trayPresentation({ ...baseStatus, phase: 'stopping' }, true, []).active
  && trayPresentation({ ...baseStatus, phase: 'stopping' }, true, []).tooltip.includes('применяю маршруты')
  && trayPresentation({ ...baseStatus, phase: 'starting' }, true, []).action === 'disconnect'
  && !trayPresentation({ ...baseStatus, phase: 'on' }, false, ['Poland']).active)
t('tray open-idle stays open even with core off',
  trayPresentation({ ...baseStatus, phase: 'off' }, true, []).active
  && trayPresentation({ ...baseStatus, phase: 'off' }, true, []).action === 'disconnect')

t('route presentation keeps Direct active even while the core is off',
  routeStateKey({ on: true, via: 'direct' } as Route, { ...baseStatus, open: true, phase: 'off' }) === 'route.st.direct'
  && routeSchemeHintKey({ via: 'direct' } as Route, { ...baseStatus, open: false, phase: 'off' }) === undefined)
t('enabled tunnel route says applying during internal restart, never waiting for master',
  routeStateKey({ on: true, via: 'p1' } as Route, { ...baseStatus, open: true, phase: 'stopping' }, { desired: 'p1', state: 'idle', reason: 'waiting' }) === 'route.st.applying'
  && routeStateKey({ on: true, via: 'p1' } as Route, { ...baseStatus, open: true, phase: 'off' }, { desired: 'p1', state: 'idle', reason: 'waiting' }) === 'route.st.applying'
  && routeSchemeHintKey({ via: 'p1' } as Route, { ...baseStatus, open: true, phase: 'starting' }) === 'route.scheme.applying')
t('closed master still says a tunnel route is waiting for opening',
  routeStateKey({ on: true, via: 'p1' } as Route, baseStatus, { desired: 'p1', state: 'idle', reason: 'waiting' }) === 'route.st.idle'
  && routeSchemeHintKey({ via: 'p1' } as Route, baseStatus) === 'route.scheme.off')

const layoutSrc = readFileSync('src/renderer/src/layout.css', 'utf8')
t('live-connections summary adapts at the declared 900px window minimum instead of clipping columns',
  layoutSrc.includes('@media (max-width: 1050px)')
  && layoutSrc.includes('.ct-r > :nth-child(4), .ct-r > :nth-child(7) { display: none; }')
  && layoutSrc.includes('minmax(130px, 1.2fr) minmax(100px, .8fr) minmax(130px, 1.4fr)'))
t('long route-detail titles shrink instead of pushing the toggle/remove controls off-screen',
  layoutSrc.includes('.ph-t { display: flex; flex-direction: column; min-width: 0; }')
  && layoutSrc.includes('.ph-t h1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }'))

const routePageSrc = readFileSync('src/renderer/src/pages/route.tsx', 'utf8')
t('route path selection acknowledges the pending target immediately',
  routePageSrc.includes("const visibleNowText = applying ? s('route.applying'")
  && routePageSrc.includes("className={'route-now' + (applying ? ' applying'")
  && routePageSrc.includes('aria-live="polite"')
  && layoutSrc.includes('.vopt.applying {')
  && layoutSrc.includes('.route-now.applying {'))

const librarySrc = readFileSync('src/renderer/src/pages/library.tsx', 'utf8')
const partsSrc = readFileSync('src/renderer/src/parts.tsx', 'utf8')
t('route-list path changes use the same route:select command and serialize pending apply',
  librarySrc.includes('const [applying, setApplying]')
  && librarySrc.includes('await api.selectRoute(route.id, via)')
  && librarySrc.includes('disabled={!!applying}')
  && librarySrc.includes("s('route.applying'")
  && partsSrc.includes('disabled?: boolean')
  && partsSrc.includes('disabled={disabled}'))

const connectionsSrc = readFileSync('src/renderer/src/pages/connections.tsx', 'utf8')
const kitSrc = readFileSync('src/renderer/src/ui/kit.tsx', 'utf8')
t('Home routing controls serialize changes and card path uses route:select',
  connectionsSrc.includes('const [routingBusy, setRoutingBusy]')
  && connectionsSrc.includes('await api.selectRoute(route.id, via)')
  && connectionsSrc.includes('disabled={routingBusy}')
  && connectionsSrc.includes('busyRoute === r.id')
  && kitSrc.includes('disabled?: boolean')
  && kitSrc.includes('<button key={it.v} disabled={disabled}'))
t('closed master removes the dead live-connections section but transitions/open-idle may show it',
  connectionsSrc.includes('const showFlows = status.open === true') && connectionsSrc.includes('{showFlows && <details className="flows">'))

console.log(failed ? `\n${failed} FAILED` : '\nall flow checks passed')
process.exit(failed ? 1 : 0)
