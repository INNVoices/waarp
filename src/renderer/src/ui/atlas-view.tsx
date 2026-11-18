import { useState } from 'react'
import { Btn, Icon } from './kit'
import { s } from '../lib/i18n'

export type AtlasView = 'list' | 'map'

/** Presentation preference only; it contains no profiles, endpoints or route mutations. */
export function useAtlasView(place: string): [AtlasView, (view: AtlasView) => void] {
  const key = `waarp.atlas.view.${place}`
  const [view, setView] = useState<AtlasView>(() => {
    try { return localStorage.getItem(key) === 'map' ? 'map' : 'list' } catch { return 'list' }
  })
  return [view, next => { setView(next); try { localStorage.setItem(key, next) } catch { /* view still works */ } }]
}

export function AtlasViewSwitch({ value, onChange }: { value: AtlasView; onChange: (view: AtlasView) => void }) {
  return <div className="atlas-view-switch" role="group" aria-label={s('atlas.view.label')}>
    <Btn kind="ghost" sm aria-pressed={value === 'list'} onClick={() => onChange('list')}><Icon n="server" s={14} />{s('atlas.view.list')}</Btn>
    <Btn kind="ghost" sm aria-pressed={value === 'map'} onClick={() => onChange('map')}><Icon n="globe" s={14} />{s('atlas.view.map')}</Btn>
  </div>
}
