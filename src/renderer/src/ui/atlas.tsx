import { useEffect, useState, type ComponentType } from 'react'
import { ATLAS_UNKNOWN, atlasCountry, countryAnchor, countryCodes, type AtlasProjection } from '../../../shared/atlas'
import { Btn, Icon, Select } from './kit'
import { s, sp } from '../lib/i18n'
import type { AtlasCanvasProps } from './atlas-canvas'
import './atlas.css'

const regionNames = new Intl.DisplayNames(['ru'], { type: 'region' })
export const atlasCountryName = (country: string): string => country === ATLAS_UNKNOWN ? s('atlas.region.unknown')
  : regionNames.of(country) ?? countryAnchor(country)?.name ?? country
const deviceKey = 'waarp.atlas.device-region'
export interface AtlasRouteView { active?: { country?: string; name: string }; pending?: { country?: string; name: string } }

/** The only actions exposed by the map are presentation/filter actions. */
export function Atlas({ projection, country, onCountry, onList, route }: {
  projection: AtlasProjection; country: string; onCountry: (country: string) => void; onList: () => void; route?: AtlasRouteView
}) {
  const [Canvas, setCanvas] = useState<ComponentType<AtlasCanvasProps>>()
  const [failed, setFailed] = useState(false)
  const [device, setDevice] = useState(() => {
    try { const stored = localStorage.getItem(deviceKey); return countryAnchor(stored) ? atlasCountry(stored) : '' } catch { return '' }
  })
  useEffect(() => {
    let mounted = true
    void import('./atlas-canvas').then(module => { if (mounted) setCanvas(() => module.AtlasCanvas) }).catch(() => { if (mounted) setFailed(true) })
    return () => { mounted = false }
  }, [])
  const chooseDevice = (next: string) => {
    setDevice(next)
    try { if (next) localStorage.setItem(deviceKey, next); else localStorage.removeItem(deviceKey) } catch { /* optional local preference */ }
  }
  const regions = projection.countries.filter(item => item.country !== ATLAS_UNKNOWN)
    .sort((a, b) => atlasCountryName(a.country).localeCompare(atlasCountryName(b.country), 'ru'))
  const selected = projection.countries.find(item => item.country === country)
  const summary = country ? selected ? [selected] : [] : projection.countries
  const ready = summary.reduce((total, item) => total + item.ready, 0)
  const failedCount = summary.reduce((total, item) => total + item.failed, 0)
  const total = summary.reduce((count, item) => count + item.total, 0)
  const bestPing = Math.min(...summary.map(item => item.bestPing ?? Infinity))
  return <section className="atlas" aria-label={s('atlas.title')}>
    <div className="atlas-toolbar">
      <label className="atlas-device"><Icon n="user" s={14} /><span>{s('atlas.device.region')}</span>
        <Select value={device} onChange={event => chooseDevice(event.target.value)} aria-label={s('atlas.device.region')} title={s('atlas.device.note')}>
          <option value="">{s('atlas.device.unset')}</option>
          {countryCodes().sort((a, b) => atlasCountryName(a).localeCompare(atlasCountryName(b), 'ru')).map(code => <option key={code} value={code}>{atlasCountryName(code)}</option>)}
        </Select>
      </label>
      <span className="atlas-total m">{sp('atlas.count', projection.total)}<span>{s('atlas.regions', { n: regions.length })}</span></span>
    </div>
    <div className="atlas-map-frame">
      {failed ? <div className="atlas-unavailable" role="status"><Icon n="globe" s={24} /><p>{s('atlas.unavailable')}</p><Btn onClick={onList}>{s('atlas.view.list')}</Btn></div>
        : Canvas ? <Canvas projection={projection} country={country} onCountry={onCountry} device={device} route={route} onFailed={() => setFailed(true)} />
          : <div className="atlas-unavailable" role="status">{s('atlas.loading')}</div>}
      {!device && !failed && <div className="atlas-device-unknown"><Icon n="user" s={14} /><span>{s('atlas.device')}<small>{s('atlas.device.no-location')}</small></span></div>}
    </div>
    <div className="atlas-summary" aria-live="polite">
      <div className="atlas-summary-title"><b>{country ? atlasCountryName(country) : s('atlas.summary.all')}</b><span>{country ? sp('atlas.count', total) : s('atlas.summary.choose')}</span></div>
      <span className="atlas-stat ready"><i /><b>{ready}</b>{s('atlas.summary.ready')}</span>
      <span className="atlas-stat"><i /><b>{Math.max(0, total - ready - failedCount)}</b>{s('atlas.summary.unchecked')}</span>
      <span className="atlas-stat failed"><i /><b>{failedCount}</b>{s('atlas.summary.failed')}</span>
      {Number.isFinite(bestPing) && <span className="atlas-stat"><b>{s('meter.ms', { n: Math.round(bestPing) })}</b>{s('atlas.summary.response')}</span>}
    </div>
    <div className="atlas-region-filter">
      <Select aria-label={s('atlas.region.filter')} value={country} onChange={event => onCountry(event.target.value)}>
        <option value="">{s('atlas.region.all')}</option>
        {regions.map(item => <option key={item.country} value={item.country}>{atlasCountryName(item.country)} · {item.total}</option>)}
        {projection.unknown > 0 && <option value={ATLAS_UNKNOWN}>{s('atlas.region.unknown')} · {projection.unknown}</option>}
        {!!country && !projection.countries.some(item => item.country === country) && <option value={country}>{atlasCountryName(country)} · 0</option>}
      </Select>
      {!!country && <Btn kind="ghost" sm onClick={() => onCountry('')}><Icon n="x" s={14} />{s('atlas.region.reset')}</Btn>}
      {projection.unknown > 0 && country !== ATLAS_UNKNOWN && <Btn kind="ghost" sm onClick={() => onCountry(ATLAS_UNKNOWN)}>{s('atlas.unknown', { n: projection.unknown })}</Btn>}
    </div>
    {(route?.active || route?.pending) && <div className="atlas-route-status" aria-live="polite">
      {route.active && <span><i className="atlas-key active" />{s('atlas.route.active')}<b className="ell" title={route.active.name}>{route.active.name}</b>{!countryAnchor(route.active.country) && <small>{s('atlas.region.unknown')}</small>}</span>}
      {route.pending && <span><i className="atlas-key pending" />{s('atlas.route.pending')}<b className="ell" title={route.pending.name}>{route.pending.name}</b></span>}
    </div>}
    <p className="atlas-caption"><Icon n="info" s={13} /><span>{s('atlas.region.source')}{route?.active && device && countryAnchor(route.active.country) ? ` ${s('atlas.logical')}` : ''}</span><span className="atlas-attribution">{s('atlas.attribution')}</span></p>
  </section>
}
