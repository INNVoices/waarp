// Public candidates and recent successful observations are separate. Loading
// lists never needs a TUN restart; isolated verification remains an OFF action.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Icon, Plain, Tooltip } from '../ui/kit'
import { s, sp } from '../lib/i18n'
import { api } from '../bridge'

interface Node { id: string; name: string; proto: string; host: string; port: number; country: string; source?: string; ping?: number; status?: 'ready' | 'cached' | 'failed' | 'unverified'; checkedAt?: number; lastSuccessAt?: number }
interface State { updatedAt?: number; sources: { url: string; ok: boolean; count: number; error?: string }[]; total: number; readyCount?: number; cachedCount?: number; planned?: number; checked: number; alive: Node[]; cached?: Node[]; busy: boolean; cacheError?: string }

/** Windows has no flag emoji: the country is a small code badge; unknown -> globe icon */
const cc = (c: string) => (/^[A-Z]{2}$/.test(c) ? c : '')
const ago = (t?: number) => {
  if (!t) return s('pub.never')
  const minutes = Math.max(0, Math.floor((Date.now() - t) / 6e4))
  return minutes < 1 ? s('pub.now') : minutes < 60 ? sp('pub.min', minutes)
    : minutes < 1440 ? sp('pub.hour', Math.floor(minutes / 60)) : sp('pub.day', Math.floor(minutes / 1440))
}
/** the node name without its leading flag / country code, for a calm row */
const clean = (n: string) => {
  const t = n.replace(/[\u{1F1E6}-\u{1F1FF}]{2}\s*/gu, '').replace(/\[[^\]]*\]/g, '').replace(/#\d+/g, '').trim().replace(/^[A-Z]{2}\s*·\s*/, '')
  const city = t.includes('/') ? t.split('/').pop()!.trim() : t
  return city || t || n
}

type Region = 'eu' | 'asia' | 'americas' | 'other'
type PickMode = 'auto' | 'manual'
const REGION: Record<Region, Set<string>> = {
  eu: new Set('AL AT BE BG CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LT LU LV MD ME MK MT NL NO PL PT RO RS SE SI SK UA'.split(' ')),
  asia: new Set('AE AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KR KZ LA LB LK MM MN MO MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE'.split(' ')),
  americas: new Set('AR BO BR CA CL CO CR CU DO EC GT HN JM MX NI PA PE PR PY SV US UY VE'.split(' ')),
  other: new Set()
}
const regionOf = (country: string): Region => country === 'US' || country === 'CA' || REGION.americas.has(country) ? 'americas' : REGION.eu.has(country) ? 'eu' : REGION.asia.has(country) ? 'asia' : 'other'

export function PublicCatalog({ toast, used, onAdded, compact = false, disabled = false, refreshAllowed = true }: { toast: (x: string) => void; used: (id: string) => boolean; onAdded?: (id: string) => void; compact?: boolean; disabled?: boolean; refreshAllowed?: boolean }) {
  // Keep the parent's existing prop contract: it gates measurement, not list I/O.
  const probeAllowed = refreshAllowed
  const [st, setSt] = useState<State>()
  const [cachedOnly, setCachedOnly] = useState(false)
  const [all, setAll] = useState(false)
  const [mode, setMode] = useState<PickMode>()
  const [region, setRegion] = useState<Region>()
  const [error, setError] = useState('')
  const [action, setAction] = useState<string>()
  const actionLock = useRef(false)
  useEffect(() => {
    let mounted = true, pushed = false
    const unsubscribe = api.onCatalog((next: State) => { pushed = true; if (mounted) setSt(next) })
    void api.catalogGet().then((next: State) => { if (mounted && !pushed) setSt(next) }).catch(() => { if (mounted) setError(s('pub.error')) })
    return () => { mounted = false; unsubscribe() }
  }, [])
  const perform = async (key: string, work: () => Promise<void>) => {
    if (actionLock.current || disabled) return
    actionLock.current = true; setAction(key); setError('')
    try { await work() }
    catch { setError(s('pub.error')) }
    finally { actionLock.current = false; setAction(undefined) }
  }
  const refresh = () => perform('refresh', async () => {
    const result = await api.catalogRefresh()
    if (result?.error) setError(result.error)
    else if (result) setSt(result)
  })
  const verify = () => perform('verify', async () => {
    if (!probeAllowed) { setError(s('pub.refresh.stop')); return }
    const result = await api.catalogVerify()
    if (result?.error) setError(result.error)
    else if (result) setSt(result)
  })
  const best = () => perform('best', async () => {
    const r = await api.catalogBest()
    if (!r?.ok) { setError(r?.error ?? s('pub.error')); return }
    toast(s('pub.best.ok')); if (r.id) onAdded?.(r.id)
  })
  const add = (n: Node) => perform(n.id, async () => {
    const r = await api.catalogAdd(n.id)
    if (!r?.ok) { setError(r?.error ?? s('pub.error')); return }
    toast(s('pub.add.ok', { v: clean(n.name) })); if (r.id) onAdded?.(r.id)
  })
  const pending = disabled || !!action || st?.busy === true
  const alive = st?.alive ?? []
  const cached = st?.cached ?? []
  const nodes = cachedOnly ? cached : alive
  const regional = region ? nodes.filter(n => regionOf(n.country) === region) : []
  const shown = all ? regional : regional.slice(0, 10)
  const regions = useMemo(() => (['eu', 'asia', 'americas', 'other'] as Region[]).map(id => {
    const regionalNodes = nodes.filter(n => regionOf(n.country) === id)
    return { id, count: regionalNodes.length, ping: cachedOnly ? undefined : regionalNodes.reduce<number | undefined>((m, n) => n.ping === undefined ? m : m === undefined ? n.ping : Math.min(m, n.ping), undefined) }
  }).filter(x => x.count), [nodes, cachedOnly])
  return (
    <section className={'panel pub' + (compact ? ' compact' : '')} id="public-catalog">
      <div className="pub-head">
        <span className="wz-ic"><Icon n="globe" s={20} /></span>
        <div className="pub-t">
          <b>{s('pub.title')}</b>
          <span className="m">{st?.busy ? (st.planned ? s('pub.checking', { n: st.checked, t: st.planned }) : s('pub.fetching')) : st?.total ? s('pub.sum', { n: st.readyCount ?? alive.length, t: st.total, ago: ago(st.updatedAt) }) : s('pub.empty')}</span>
        </div>
        <div className="grow" />
        <Btn kind="ghost" onClick={() => void refresh()} disabled={pending} title={s('pub.refresh.tip')}><span className={st?.busy || action === 'refresh' ? 'spin' : ''}><Icon n="refresh" /></span>{s('pub.refresh')}</Btn>
        {!!st?.total && <Btn kind="ghost" onClick={() => void verify()} disabled={pending || !probeAllowed} title={s(probeAllowed ? 'pub.verify.tip' : 'pub.refresh.stop')}>{s('pub.verify')}</Btn>}
        {mode && <Btn kind="primary" onClick={best} disabled={!alive.length || pending}><Icon n="bolt" />{s('pub.best')}</Btn>}
      </div>
      {error && <p className="ferr" role="alert">{error}</p>}
      {st?.cacheError && <p className="ferr" role="alert">{st.cacheError}</p>}
      {!probeAllowed && <p className="hint">{s('pub.refresh.stop')}</p>}
      {!mode && <div className="pub-modes">
        <Plain className="pub-mode primary" disabled={!alive.length || pending} onClick={() => void best()}>
          <span className="wz-ic"><Icon n="bolt" /></span><span><b>{s('pub.auto')}</b><small>{s('pub.auto.hint')}</small></span><Icon n="down" />
        </Plain>
        <Plain className="pub-mode" disabled={(!alive.length && !cached.length) || pending} onClick={() => { setCachedOnly(!alive.length); setMode('manual') }}>
          <span className="wz-ic"><Icon n="globe" /></span><span><b>{s('pub.manual')}</b><small>{s('pub.manual.hint')}</small></span><Icon n="down" />
        </Plain>
      </div>}
      {mode === 'manual' && <div className="pub-foot">
        <Btn kind={cachedOnly ? 'ghost' : 'primary'} sm onClick={() => { setCachedOnly(false); setRegion(undefined); setAll(false) }}>{s('pub.ready.tab')}</Btn>
        <Btn kind={cachedOnly ? 'primary' : 'ghost'} sm onClick={() => { setCachedOnly(true); setRegion(undefined); setAll(false) }}>{s('pub.cached.tab')}</Btn>
      </div>}
      {mode === 'manual' && cachedOnly && <p className="hint">{s('pub.cached.hint', { n: cached.length, t: st?.cachedCount ?? st?.total ?? 0 })}</p>}
      {mode === 'manual' && !cachedOnly && !alive.length && <p className="hint">{s('pub.ready.empty')}</p>}
      {mode === 'manual' && !region && <Plain className="pick-back" onClick={() => setMode(undefined)}><Icon n="back" />{s('pub.mode.back')}</Plain>}
      {mode === 'manual' && !region && nodes.length > 0 && <div className="pub-regions">
        {regions.map(r => <Plain key={r.id} className="pub-region" onClick={() => { setRegion(r.id); setAll(false) }}>
          <span><b>{s(`pub.region.${r.id}`)}</b><small>{sp('pub.region.nodes', r.count)}</small></span>
          <span className="mono pub-ms">{r.ping === undefined ? '—' : s('meter.ms', { n: r.ping })}</span><Icon n="down" />
        </Plain>)}
      </div>}
      {mode === 'manual' && region && <Plain className="pick-back" onClick={() => setRegion(undefined)}><Icon n="back" />{s('pub.regions.back')}</Plain>}
      {mode === 'manual' && region && !shown.length && <p className="hint">{s('pub.region.empty')}</p>}
      {region && shown.length > 0 && (
        <div className="pub-list pick-table">
          <div className="pub-row pick-th">
            <Tooltip tip={s('pick.country.hint')}><span className="pub-th-hint" tabIndex={0} title={s('pick.country.hint')}>{s('pick.country')}</span></Tooltip>
            <span>{s('pick.name')}</span><span>{s('pick.address')}</span><span>{s('pick.protocol')}</span><span>{s('pick.source')}</span>
            <Tooltip tip={s('pick.ping.hint')}><span className="pub-th-hint" tabIndex={0} title={s('pick.ping.hint')}>{s('pick.ping')}</span></Tooltip>
            <span />
          </div>
          {shown.map(n => (
            <div key={n.id} className="pub-row">
              <span className="pub-cc">{cc(n.country) || <Icon n="globe" s={14} />}</span>
              <Tooltip tip={n.name}><span className="pub-n ell">{clean(n.name)}</span></Tooltip>
              <span className="mono ell">{`${n.host}:${n.port}`}</span>
              <span className="pub-proto">{n.proto.split(' · ')[0]}</span>
              <span className="m ell">{n.source ?? s('pick.public')}</span>
              <span className={cachedOnly ? 'm pub-node-state' : 'mono pub-ms'} title={s('pub.checked.at', { ago: ago(n.checkedAt) })}>{cachedOnly ? s(n.status === 'failed' ? 'pub.node.failed' : n.status === 'unverified' ? 'pub.node.unverified' : 'pub.node.cached') : n.ping !== undefined ? s('meter.ms', { n: n.ping }) : '—'}</span>
              {used(n.id) && !onAdded ? <Tooltip tip={s('pub.in')}><span className="pub-in"><Icon n="check" s={14} /></span></Tooltip> : <Btn kind={onAdded ? 'primary' : 'ghost'} sm className="pub-add" title={onAdded ? s('pick.use') : s('pub.add')} disabled={pending} onClick={() => void add(n)}>{onAdded ? s('pick.use') : <Icon n="plus" />}</Btn>}
            </div>
          ))}
        </div>
      )}
      <div className="pub-foot">
        <span className="hint"><Icon n="warn" s={12} />{s('pub.trust')}</span>
        <div className="grow" />
        {mode === 'manual' && region && regional.length > 10 && <Btn kind="ghost" onClick={() => setAll(!all)}>{all ? s('pub.less') : sp('pub.more', regional.length - 10)}</Btn>}
      </div>
      {st && st.sources.some(x => !x.ok) && <p className="hint">{s('pub.src.fail', { n: st.sources.filter(x => !x.ok).length })}</p>}
    </section>
  )
}
