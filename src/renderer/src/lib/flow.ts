// Target-first configuration (WAARP-IA-TARGET-FIRST-01). Pure helpers, no React: what "+" opens, how a chosen target becomes a
// neutral draft route, and where Back goes. The path is chosen only on the route page; acquiring a target never picks one.
import type { AppInfo, Route, Settings } from '../../../shared/types'
import { appRoute, customRoute, presetRoute } from './routes'

export type Page = 'home' | 'lib' | 'servers' | 'an' | 'settings' | 'route'
export type LibMode = 'catalog' | 'list'
export interface Nav { page: Page; libMode: LibMode; routeId?: string; from: Exclude<Page, 'route'> }

export const initialNav: Nav = { page: 'home', libMode: 'list', from: 'home' }

/** the rail: Маршруты is the summary list, never the catalog */
export const goTo = (n: Nav, page: Page): Nav => ({ ...n, page, routeId: undefined, libMode: page === 'lib' ? 'list' : n.libMode, from: page === 'route' ? n.from : page })
/** Home "+" / "Добавить": always target acquisition, whatever the number of existing routes */
export const addEntry = (n: Nav): Nav => ({ ...n, page: 'lib', libMode: 'catalog', routeId: undefined, from: 'lib' })
export const showCatalog = (n: Nav): Nav => ({ ...n, libMode: 'catalog' })
export const showList = (n: Nav): Nav => ({ ...n, libMode: 'list' })
/** the route page remembers the screen it was opened from (the library keeps its catalog/list mode) */
export const openRoute = (n: Nav, id: string): Nav => ({ ...n, page: 'route', routeId: id, from: n.page === 'route' ? n.from : n.page })
export const back = (n: Nav): Nav => ({ ...n, page: n.from, routeId: undefined })

/** a freshly acquired target has no path yet: off + direct, rendered as "not set up" until a path is chosen on its page */
export const isDraft = (r: Pick<Route, 'on' | 'via'>): boolean => !r.on && r.via === 'direct'
export const draftOf = (r: Route): Route => ({ ...r, on: false, via: 'direct', fallback: undefined })

export type Target = { kind: 'app'; app: AppInfo } | { kind: 'preset'; id: string } | { kind: 'custom'; value: string }
export const targetId = (t: Target): string => t.kind === 'app' ? 'app:' + t.app.id : t.kind === 'preset' ? 'preset:' + t.id : 'custom:' + t.value

/** an existing target opens as it is (no duplicate); a new one becomes a neutral draft route */
export function acquire(st: Pick<Settings, 'routes'>, t: Target): { route: Route; created: boolean } {
  const cur = st.routes.find(r => r.id === targetId(t))
  if (cur) return { route: cur, created: false }
  const base = t.kind === 'app' ? appRoute(t.app, 'direct') : t.kind === 'preset' ? presetRoute(t.id, 'direct') : customRoute(t.value, 'direct')
  return { route: draftOf(base), created: true }
}

export const normAddr = (raw: string): string => raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
