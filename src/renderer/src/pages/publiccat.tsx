// WRP-015 public VPN catalog panel: create a group from the 5 fastest alive nodes,
// alive nodes by country with protocol and ping, refresh with live progress. Public = untrusted, said once, calmly.
import { useEffect, useMemo, useState } from 'react'
import { Btn, Icon, Plain, Tooltip } from '../ui/kit'
import { s, sp } from '../lib/i18n'
import { api } from '../bridge'

interface Node { id: string; name: string; proto: string; host: string; port: number; country: string; source?: string; ping?: number }
interface State { updatedAt?: number; sources: { url: string; ok: boolean; count: number; error?: string }[]; total: number; planned?: number; checked: number; alive: Node[]; busy: boolean }

/** Windows has no flag emoji: the country is a small code badge; unknown -> globe icon */
const cc = (c: string) => (/^[A-Z]{2}$/.test(c) ? c : '')
const ago = (t?: number) => (!t ? s('pub.never') : Date.now() - t < 6e4 ? s('pub.now') : sp('pub.min', Math.round((Date.now() - t) / 6e4)))
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

export function PublicCatalog({ toast, used, onAdded, compact = false }: { toast: (x: string) => void; used: (id: string) => boolean; onAdded?: (id: string) => void; compact?: boolean }) {
  const [st, setSt] = useState<State>()
  const [all, setAll] = useState(false)
  const [mode, setMode] = useState<PickMode>()
  const [region, setRegion] = useState<Region>()
  useEffect(() => { void api.catalogGet().then(setSt); return api.onCatalog(setSt) }, [])
  const refresh = async () => {
    const result = await api.catalogRefresh()
    if (result?.error) toast(result.error)
    else if (result) setSt(result)
  }
  const best = async () => { const r = await api.catalogBest(); toast(r.ok ? s('pub.best.ok') : r.error); if (r.ok && r.id) onAdded?.(r.id) }
  const add = async (n: Node) => { const r = await api.catalogAdd(n.id); toast(r.ok ? s('pub.add.ok', { v: clean(n.name) }) : r.error); if (r.ok && r.id) onAdded?.(r.id) }
  const alive = st?.alive ?? []
  const regional = region ? alive.filter(n => regionOf(n.country) === region) : []
  const shown = all ? regional : regional.slice(0, 10)
  const regions = useMemo(() => (['eu', 'asia', 'americas', 'other'] as Region[]).map(id => {
    const nodes = alive.filter(n => regionOf(n.country) === id)
    return { id, count: nodes.length, ping: nodes.reduce<number | undefined>((m, n) => n.ping === undefined ? m : m === undefined ? n.ping : Math.min(m, n.ping), undefined) }
  }).filter(x => x.count), [alive])
  return (
    <section className={'panel pub' + (compact ? ' compact' : '')} id="public-catalog">
      <div className="pub-head">
        <span className="wz-ic"><Icon n="globe" s={20} /></span>
        <div className="pub-t">
          <b>{s('pub.title')}</b>
          <span className="m">{st?.busy ? s('pub.checking', { n: st.checked, t: st.planned ?? Math.min(st.total, 64) }) : alive.length ? s('pub.sum', { n: alive.length, t: st?.total ?? 0, ago: ago(st?.updatedAt) }) : s('pub.empty')}</span>
        </div>
        <div className="grow" />
        <Btn kind="ghost" onClick={() => void refresh()} disabled={st?.busy} title={s('pub.refresh.tip')}><span className={st?.busy ? 'spin' : ''}><Icon n="refresh" /></span>{s('pub.refresh')}</Btn>
        {mode && <Btn kind="primary" onClick={best} disabled={!alive.length || st?.busy}><Icon n="bolt" />{s('pub.best')}</Btn>}
      </div>
      {!mode && <div className="pub-modes">
        <Plain className="pub-mode primary" disabled={!alive.length || st?.busy} onClick={() => void best()}>
          <span className="wz-ic"><Icon n="bolt" /></span><span><b>{s('pub.auto')}</b><small>{s('pub.auto.hint')}</small></span><Icon n="down" />
        </Plain>
        <Plain className="pub-mode" disabled={!alive.length} onClick={() => setMode('manual')}>
          <span className="wz-ic"><Icon n="globe" /></span><span><b>{s('pub.manual')}</b><small>{s('pub.manual.hint')}</small></span><Icon n="down" />
        </Plain>
      </div>}
      {mode === 'manual' && !region && <Plain className="pick-back" onClick={() => setMode(undefined)}><Icon n="back" />{s('pub.mode.back')}</Plain>}
      {mode === 'manual' && !region && alive.length > 0 && <div className="pub-regions">
        {regions.map(r => <Plain key={r.id} className="pub-region" onClick={() => { setRegion(r.id); setAll(false) }}>
          <span><b>{s(`pub.region.${r.id}`)}</b><small>{sp('pub.region.nodes', r.count)}</small></span>
          <span className="mono pub-ms">{r.ping === undefined ? '—' : s('meter.ms', { n: r.ping })}</span><Icon n="down" />
        </Plain>)}
      </div>}
      {mode === 'manual' && region && <Plain className="pick-back" onClick={() => setRegion(undefined)}><Icon n="back" />{s('pub.regions.back')}</Plain>}
      {region && shown.length > 0 && (
        <div className="pub-list pick-table">
          <div className="pub-row pick-th"><span>{s('pick.country')}</span><span>{s('pick.name')}</span><span>{s('pick.address')}</span><span>{s('pick.protocol')}</span><span>{s('pick.source')}</span><span>{s('pick.ping')}</span><span /></div>
          {shown.map(n => (
            <div key={n.id} className="pub-row">
              <span className="pub-cc">{cc(n.country) || <Icon n="globe" s={14} />}</span>
              <Tooltip tip={n.name}><span className="pub-n ell">{clean(n.name)}</span></Tooltip>
              <span className="mono ell">{`${n.host}:${n.port}`}</span>
              <span className="pub-proto">{n.proto.split(' · ')[0]}</span>
              <span className="m ell">{n.source ?? s('pick.public')}</span>
              <span className="mono pub-ms">{n.ping !== undefined ? s('meter.ms', { n: n.ping }) : '—'}</span>
              {used(n.id) && !onAdded ? <Tooltip tip={s('pub.in')}><span className="pub-in"><Icon n="check" s={14} /></span></Tooltip> : <Btn kind={onAdded ? 'primary' : 'ghost'} sm className="pub-add" title={onAdded ? s('pick.use') : s('pub.add')} disabled={st?.busy} onClick={() => void add(n)}>{onAdded ? s('pick.use') : <Icon n="plus" />}</Btn>}
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
