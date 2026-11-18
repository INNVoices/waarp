import { useEffect, useLayoutEffect, useRef } from 'react'
import { Map as LibreMap, setWorkerUrl, type GeoJSONSource, type MapMouseEvent, type StyleSpecification } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { FeatureCollection, LineString, Point } from 'geojson'
import world from '../../../shared/atlas-world.json'
import { countryAnchor, type AtlasProjection } from '../../../shared/atlas'
import { Btn, Icon } from './kit'
import { s } from '../lib/i18n'
import type { AtlasRouteView } from './atlas'
import 'maplibre-gl/dist/maplibre-gl.css'

setWorkerUrl(workerUrl)
export interface AtlasCanvasProps {
  projection: AtlasProjection; country: string; onCountry: (country: string) => void; device: string
  route?: AtlasRouteView; onFailed: () => void
}
const empty = { type: 'FeatureCollection' as const, features: [] }
function points(props: AtlasCanvasProps): FeatureCollection<Point> {
  return { type: 'FeatureCollection', features: props.projection.countries.flatMap(item => {
    const anchor = countryAnchor(item.country)
    return anchor ? [{ type: 'Feature' as const, properties: { country: item.country, total: item.total, preview: item.country === props.country },
      geometry: { type: 'Point' as const, coordinates: [anchor.longitude, anchor.latitude] } }] : []
  }) }
}
function routes(props: AtlasCanvasProps): FeatureCollection<LineString> {
  const origin = countryAnchor(props.device)
  if (!origin) return empty
  return { type: 'FeatureCollection', features: (['active', 'pending'] as const).flatMap(kind => {
    const target = countryAnchor(props.route?.[kind]?.country)
    if (!target || target === origin) return []
    return [{ type: 'Feature' as const, properties: { kind }, geometry: { type: 'LineString' as const,
      coordinates: [[origin.longitude, origin.latitude], [target.longitude, target.latitude]] } }]
  }) }
}
function update(map: LibreMap, props: AtlasCanvasProps): void {
  map.getContainer().setAttribute('data-map-ready', 'false')
  ;(map.getSource('regions') as GeoJSONSource | undefined)?.setData(points(props))
  ;(map.getSource('routes') as GeoJSONSource | undefined)?.setData(routes(props))
  const origin = countryAnchor(props.device)
  ;(map.getSource('device') as GeoJSONSource | undefined)?.setData(origin ? { type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: [origin.longitude, origin.latitude] } } : empty)
  map.setFilter('selected-country', ['==', ['get', 'country'], props.country || ''])
}

/** Local assets and local fonts only. Removing this view disposes the GL map and workers. */
export function AtlasCanvas(props: AtlasCanvasProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LibreMap | undefined>(undefined)
  const loaded = useRef(false)
  const latest = useRef(props); latest.current = props
  // Health-only events do not change these layers. Compare their actual inputs
  // so a manual selection is immediate and cannot wait behind a busy catalogue.
  const frameKey = JSON.stringify([props.projection.countries.map(({ country, total }) => [country, total]),
    props.country, props.device, props.route?.active?.country, props.route?.pending?.country])
  useEffect(() => {
    if (!container.current) return
    let map: LibreMap | undefined
    let disposed = false
    let resize: ResizeObserver | undefined
    try {
      const style: StyleSpecification = {
        version: 8,
        sources: { world: { type: 'geojson', data: world as FeatureCollection }, regions: { type: 'geojson', data: empty },
          routes: { type: 'geojson', data: empty }, device: { type: 'geojson', data: empty } },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': '#141312' } },
          { id: 'land', type: 'fill', source: 'world', paint: { 'fill-color': '#292724', 'fill-opacity': 1 } },
          { id: 'borders', type: 'line', source: 'world', paint: { 'line-color': '#47423d', 'line-width': 0.65 } },
          { id: 'selected-country', type: 'fill', source: 'world', filter: ['==', ['get', 'country'], ''], paint: { 'fill-color': '#d97757', 'fill-opacity': 0.19 } },
          { id: 'active-route', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'active'], paint: { 'line-color': '#9bb06e', 'line-width': 2, 'line-opacity': 0.85 } },
          { id: 'pending-route', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'pending'], paint: { 'line-color': '#e3b040', 'line-width': 2, 'line-dasharray': [3, 3] } },
          { id: 'region-dots', type: 'circle', source: 'regions', paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'total'], 1, 11, 100, 17, 1000, 23, 10000, 28],
            'circle-color': ['case', ['get', 'preview'], '#d97757', '#37332f'], 'circle-opacity': 0.95,
            'circle-stroke-color': ['case', ['get', 'preview'], '#f0a98d', '#b09a89'], 'circle-stroke-width': 1.3 } },
          { id: 'region-labels', type: 'symbol', source: 'regions', layout: { 'text-field': ['to-string', ['get', 'total']],
            'text-font': ['Inter', 'sans-serif'], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true },
            paint: { 'text-color': '#e6e3de' } },
          { id: 'device-dot', type: 'circle', source: 'device', paint: { 'circle-radius': 6, 'circle-color': '#e6e3de', 'circle-stroke-color': '#141312', 'circle-stroke-width': 2 } }
        ]
      }
      map = new LibreMap({ container: container.current, style, center: [15, 25], zoom: 0.65, minZoom: 0, maxZoom: 5,
        attributionControl: false, maplibreLogo: false, renderWorldCopies: false, dragRotate: false, pitchWithRotate: false,
        touchPitch: false, scrollZoom: false, fadeDuration: 0, maxTileCacheSize: 32,
        transformRequest: url => {
          // A future style edit must not turn server browsing into a third-party lookup.
          if (/^https?:/i.test(url) && new URL(url).origin !== location.origin) throw new Error('Atlas uses local resources')
          return { url }
        } })
      mapRef.current = map
      map.touchZoomRotate.disableRotation()
      map.getCanvas().setAttribute('aria-label', s('atlas.canvas.label'))
      map.once('load', () => {
        if (!disposed && map) {
          loaded.current = true
          update(map, latest.current)
        }
      })
      map.on('idle', () => { if (!disposed && loaded.current) container.current?.setAttribute('data-map-ready', 'true') })
      map.on('error', () => { if (!disposed) latest.current.onFailed() })
      const choose = (event: MapMouseEvent) => {
        if (!map || !loaded.current) return
        const hit = map.queryRenderedFeatures(event.point, { layers: ['region-dots'] })[0]
        if (typeof hit?.properties?.country === 'string') latest.current.onCountry(hit.properties.country)
      }
      map.on('click', choose)
      map.on('mousemove', event => { if (map && loaded.current) map.getCanvas().style.cursor = map.queryRenderedFeatures(event.point, { layers: ['region-dots'] }).length ? 'pointer' : '' })
      resize = new ResizeObserver(() => { if (!disposed) map?.resize() })
      resize.observe(container.current)
    } catch { latest.current.onFailed() }
    return () => { disposed = true; loaded.current = false; resize?.disconnect(); mapRef.current = undefined; map?.remove() }
  }, [])
  useLayoutEffect(() => {
    const map = mapRef.current
    // Initial load reads latest.current. After that, even an update still being
    // processed by the worker must be superseded by the latest visible state.
    if (map && loaded.current) update(map, latest.current)
  }, [frameKey])
  return <>
    <div className="atlas-canvas" ref={container} />
    <div className="atlas-map-controls">
      <Btn kind="ghost" sm title={s('atlas.zoom.in')} aria-label={s('atlas.zoom.in')} onClick={() => mapRef.current?.zoomIn({ duration: 0 })}><Icon n="plus" s={14} /></Btn>
      <Btn kind="ghost" sm title={s('atlas.zoom.out')} aria-label={s('atlas.zoom.out')} onClick={() => mapRef.current?.zoomOut({ duration: 0 })}><Icon n="min" s={14} /></Btn>
      <Btn kind="ghost" sm onClick={() => mapRef.current?.jumpTo({ center: [15, 25], zoom: 0.65 })}><Icon n="globe" s={14} />{s('atlas.world')}</Btn>
    </div>
  </>
}
