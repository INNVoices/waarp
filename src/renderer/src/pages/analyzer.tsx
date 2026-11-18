import { useEffect, useRef, useState } from 'react'
import type { Route, Snapshot, Status, Via } from '../../../shared/types'
import { provenPath } from '../../../shared/evidence'
import { connectionUse, routeEvidenceSignature, suggestedProbeTarget, type DiagnosisResult } from '../../../shared/connection-quality'
import { Btn, Field, Icon, Plain } from '../ui/kit'
import { s } from '../lib/i18n'
import { api } from '../bridge'
import { hueOf } from '../lib/routes'
import { Mark, viaName } from '../parts'
import { PayloadCheck } from './payload-check'
import './connection-quality.css'

export function Analyzer({ snap, status, hist, routeId, back }: { snap: Snapshot; status: Status; hist: Record<string, (number | undefined)[]>; routeId?: string; back?: () => void }) {
  const live = status.phase === 'on'
  const route = routeId ? snap.settings.routes.find(r => r.id === routeId) : undefined
  const ids: Via[] = ['direct', ...snap.profiles.map(p => p.id)].filter(id => hist[id]?.length)
  return (
    <div className="page">
      <div className="page-head">
        {routeId && <Plain className="back" aria-label={s('quality.back')} onClick={back}><Icon n="back" s={20} /></Plain>}
        <div className="ph-t"><h1>{route ? s('quality.for', { name: route.name }) : s('an.title')}</h1>{route && <span className="m">{s('quality.use.' + connectionUse(route.connectionUse))}</span>}</div>
      </div>
      {routeId && !route ? <p className="lead">{s('route.removed')}</p> : <Probe snap={snap} live={live} route={route} />}
      {!routeId && <PayloadCheck snap={snap} />}
      {!routeId && <section className="panel">
        <div className="ph-row"><h3>{s('an.live')}</h3><span className="m">{s('an.live.hint')}</span></div>
        {!live && ids.length > 0 && <p className="hint">{s('an.off_icmp')}</p>}
        {!ids.length ? <div className="emptyst"><Icon n="pulse" s={24} /><span>{s('an.wait')}</span></div> : <>
          <Chart snap={snap} ids={ids} hist={hist} />
          <div className="legend">
            {ids.map(id => {
              const v = hist[id].filter((x): x is number => x !== undefined)
              const avg = v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : undefined
              const loss = hist[id].length ? Math.round((hist[id].filter(x => x === undefined).length / hist[id].length) * 100) : 0
              return (
                <div key={id} className="lg">
                  <Mark profiles={snap.profiles} via={id} /><b title={id === 'direct' ? s('an.isp') : viaName(snap.profiles, id)}>{id === 'direct' ? s('an.isp') : viaName(snap.profiles, id)}</b>
                  <span className="lg-ms mono">{avg !== undefined ? s('meter.ms', { n: avg }) : '—'}</span>
                  <span className={'lg-loss' + (loss ? ' warn' : ' m')}>{s('an.loss', { n: loss })}</span>
                </div>
              )
            })}
          </div>
        </>}
      </section>}
    </div>
  )
}

function Chart({ snap, ids, hist }: { snap: Snapshot; ids: Via[]; hist: Record<string, (number | undefined)[]> }) {
  const W = 600, H = 160
  const all = ids.flatMap(id => hist[id].filter((x): x is number => x !== undefined))
  const max = Math.max(100, ...all) * 1.15
  const n = 40
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">{/* icon-ok: ping chart */}
      {[0.25, 0.5, 0.75].map(f => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="grid" />)}
      {ids.map(id => {
        const v = hist[id].slice(-n)
        const pts = v.map((x, i) => (x === undefined ? null : `${(i / (n - 1)) * W},${H - (x / max) * H}`)).filter(Boolean).join(' ')
        return <polyline key={id} points={pts} style={{ stroke: id === 'direct' ? 'var(--m)' : hueOf(snap.profiles, id) }} />
      })}
    </svg>
  )
}

const FRESH_MS = 5 * 60_000

/** W3.2 "Почему не открывается?": Direct layer by layer, own paths, then one observation line; never a fake cause */
function Probe({ snap, live, route }: { snap: Snapshot; live: boolean; route?: Route }) {
  const [t, setT] = useState(route ? suggestedProbeTarget(route) : 'youtube.com')
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [res, setRes] = useState<DiagnosisResult | null>()
  const [notice, setNotice] = useState<'cancelled' | 'stale' | 'applied' | 'saved' | 'pending'>()
  const checking = useRef(false)
  const applyingRef = useRef(false)
  const runId = useRef(0)
  const signature = route ? routeEvidenceSignature(route) : ''
  const lastSignature = useRef(signature)
  useEffect(() => {
    if (lastSignature.current === signature) return
    lastSignature.current = signature
    if (applyingRef.current) return
    runId.current++; checking.current = false; setBusy(false); setRes(undefined); setNotice('stale')
    void api.diagnoseCancel().catch(() => undefined)
  }, [signature])
  useEffect(() => () => { runId.current++; checking.current = false; void api.diagnoseCancel().catch(() => undefined) }, [])
  const run = async () => {
    if (!t.trim() || checking.current) return
    const id = ++runId.current
    checking.current = true; setBusy(true); setRes(undefined); setNotice(undefined)
    try {
      await api.diagnoseCancel()
      if (id !== runId.current) return
      const r = await api.diagnose(t, route?.id) as DiagnosisResult | null
      if (id === runId.current) {
        if (r?.stale || (route && r?.scope?.routeId !== route.id)) { setRes(undefined); setNotice('stale') }
        else setRes(r)
      }
    }
    catch { if (id === runId.current) setRes(null) }
    finally { if (id === runId.current) { checking.current = false; setBusy(false) } }
  }
  const cancel = () => {
    if (applyingRef.current) return
    runId.current++; checking.current = false; setBusy(false); setRes(undefined); setNotice('cancelled')
    void api.diagnoseCancel().catch(() => undefined)
  }
  const f = res?.finding
  const host = res?.host
  const card = route ?? (host ? snap.settings.routes.find(r => r.kind === 'custom' && r.value === host) : undefined)
  const stableProfiles = res?.samples ? snap.profiles.filter(p => res.samples![p.id]?.attempted >= 2 && res.samples![p.id].responded === res.samples![p.id].attempted) : snap.profiles
  const proposed = route ? res?.assessment?.recommendedVia : provenPath(f, stableProfiles)
  const best = proposed && stableProfiles.some(p => p.id === proposed && !p.revoked && p.source !== 'public' && p.kind !== 'group') ? proposed : undefined
  const apply = async () => {
    if (!res || !host || !best || !res.token || checking.current) return
    if (Date.now() < res.at || Date.now() - res.at >= FRESH_MS || !snap.profiles.some(p => p.id === best && !p.revoked)) { setNotice('stale'); setRes(undefined); return }
    const id = ++runId.current
    checking.current = true; applyingRef.current = true; setBusy(true); setApplying(true); setNotice(undefined)
    try {
      const result = await api.diagnoseApply(res.token, best)
      if (id !== runId.current) return
      if (!result.ok) {
        setRes(result.error === 'stale' ? undefined : null)
        if (result.error === 'stale') setNotice('stale')
      } else {
        if (route) lastSignature.current = routeEvidenceSignature({ ...route, via: best, on: true, fallback: undefined })
        setRes(undefined)
        setNotice(result.applied ? 'applied' : result.warning ? 'pending' : 'saved')
      }
    } catch { if (id === runId.current) setRes(null) }
    finally {
      applyingRef.current = false
      if (id === runId.current) { checking.current = false; setBusy(false); setApplying(false) }
    }
  }
  const words = (ids: string[]) => ids.slice(0, 2).map(id => viaName(snap.profiles, id)).join(', ')
  const verdict = !f ? '' : f.kind === 'restricted_direct' ? s('dg.v.layer.' + f.layer, { v: words(f.via) }) : f.kind === 'path_only' ? s('dg.v.path_only', { v: words(f.via) }) : f.kind === 'unclear' ? s('dg.v.unclear.' + f.why) : s('dg.v.' + f.kind)
  const layers: [string, { result: string; code?: string; status?: number; to?: string }][] = res ? [['dns', res.direct.dnsSystem], ['doh', res.direct.dnsDoh], ['tcp', res.direct.tcp], ['tls', res.direct.tls], ['http', res.direct.http]] : []
  const assess = res?.assessment
  const currentVia = res?.scope?.effectiveVia ?? route?.via
  const entries = res?.samples ? Object.entries(res.samples).map(([id, sample]) => [id, sample.responded ? sample.medianMs ?? null : null] as const) : Object.entries(res?.paths ?? {})
  return (
    <section className="panel">
      <div className="ph-row"><h3>{route ? s('quality.open') : s('an.probe')}</h3><span className="m">{s('quality.bound')}</span></div>
      {route && <p className="hint">{s('quality.target.hint')}</p>}
      <div className="addrow">
        <Field disabled={busy} icon="globe" aria-label={s('quality.target')} placeholder={s('an.probe.ph')} value={t} onChange={e => { setT(e.target.value); setRes(undefined); setNotice(undefined) }} onKeyDown={e => { if (e.key === 'Enter') void run() }} />
        <Btn kind="primary" onClick={run} disabled={busy || !t.trim()}><span className={busy ? 'spin' : ''}><Icon n={busy ? 'refresh' : 'bolt'} /></span>{s('an.probe.go')}</Btn>
        {busy && !applying && <Btn kind="ghost" onClick={cancel}>{s('quality.cancel')}</Btn>}
      </div>
      {busy && <p className="hint" role="status">{s(applying ? 'quality.applying' : 'quality.checking')}</p>}
      {!live && <p className="hint">{s('an.probe.off')}</p>}
      {notice && <p className={'quality-notice ' + notice} role="status">{s('quality.notice.' + notice)}</p>}
      {res === null && <div className="ferr">{s('dg.error')}</div>}
      {res && <>
        <div className="quality-result" role="status">
          <div className="quality-summary"><Icon n={assess?.current === 'responded' ? 'check' : 'info'} s={18} />
            <div className="grow"><b>{route && assess ? s('quality.result.' + assess.reason, { v: viaName(snap.profiles, best ?? currentVia ?? '') }) : verdict}</b>
              <p>{s('quality.coverage.' + connectionUse(route?.connectionUse))}</p>
            </div>
          </div>
          {host && best && res.token && (!card || card.via !== best || !card.on) && <Btn kind="primary" disabled={busy} onClick={() => void apply()}>
            {route ? s('quality.apply', { v: viaName(snap.profiles, best), name: route.name }) : card ? s('dg.route.card', { v: viaName(snap.profiles, best) }) : s('dg.route', { h: host, v: viaName(snap.profiles, best) })}
          </Btn>}
          <div className="quality-meta"><span>{res.target}</span><time dateTime={new Date(res.at).toISOString()}>{new Date(res.at).toLocaleTimeString('ru-RU')}</time></div>
        </div>
        <details className="quality-proof" open={!route || undefined}>
          <summary>{s('quality.why')}<Icon n="chev" s={14} /></summary>
          {route && verdict && <p className="hint">{verdict}</p>}
        <div className="dg">
          <div className="dg-col">
            <b className="dg-h">{s('quality.system')}</b>
            <span className="hint">{s('quality.system.hint')}</span>
            {layers.map(([k, o]) => (
              <div key={k} className={'dg-row ' + o.result}>
                <span className="m">{s('dg.l.' + k)}</span>
                <span>{o.result === 'ok' ? (k === 'http' && o.status ? (o.to ? s('dg.r.redirect', { n: o.status, to: o.to }) : s('dg.r.status', { n: o.status })) : s('dg.r.ok')) : o.result === 'skipped' ? '—' : o.result === 'na' ? s('dg.r.na') : k === 'http' && o.code === 'method' ? s('dg.r.method') : k === 'http' && o.status ? s('dg.r.status', { n: o.status }) : s('dg.r.' + o.result + (o.code ? '.' + o.code : ''))}</span>
              </div>
            ))}
            {res.direct.dnsDiffer && <span className="m">{s('dg.dns_differ')}</span>}
          </div>
          <div className="dg-col">
            <b className="dg-h">{s('dg.paths')}</b>
            {!entries.length && <span className="m">{s('dg.nopaths')}</span>}
            {entries.map(([id, ms]) => (
              <div key={id} className={'dg-row quality-path ' + (ms === null ? 'fail' : 'ok')}>
                <span className="dg-n"><Mark profiles={snap.profiles} via={id} /><span>{viaName(snap.profiles, id)}{id === currentVia && <small>{s('quality.current')}</small>}</span></span>
                <span className="quality-path-value"><span className="mono">{ms === null ? s('an.fail') : s('meter.ms', { n: ms })}</span>
                  {res.samples?.[id] && <small>{s('quality.responses', { n: res.samples[id].responded, total: res.samples[id].attempted })}</small>}
                </span>
              </div>
            ))}
          </div>
        </div>
        <p className="hint">{s('quality.samples.hint')}</p>
        </details>
      </>}
    </section>
  )
}
