import { useEffect, useRef, useState } from 'react'
import type { Route, Snapshot, Status, Via } from '../../../shared/types'
import { provenPath } from '../../../shared/evidence'
import { connectionUse, routeEvidenceSignature, suggestedProbeTarget, type DiagnosisResult } from '../../../shared/connection-quality'
import { diagnosticGuidance } from '../../../shared/diagnostic-guidance'
import { Btn, Field, Icon, Plain } from '../ui/kit'
import { s } from '../lib/i18n'
import { api } from '../bridge'
import { hueOf } from '../lib/routes'
import { Mark, viaName } from '../parts'
import { PayloadCheck } from './payload-check'
import './connection-quality.css'

export function Analyzer({ snap, status, hist, routeId, back }: { snap: Snapshot; status: Status; hist: Record<string, (number | undefined)[]>; routeId?: string; back?: () => void }) {
  const live = status.phase === 'on'
  const [inspectedId, setInspectedId] = useState<string | undefined>(() => snap.settings.routes.find(item => item.on &&
    ['blocked', 'retrying', 'fallback'].includes(status.routes?.[item.id]?.state ?? '') && suggestedProbeTarget(item))?.id)
  const [extras, setExtras] = useState(false)
  const route = snap.settings.routes.find(r => r.id === (routeId ?? inspectedId))
  const ids: Via[] = ['direct', ...snap.profiles.map(p => p.id)].filter(id => hist[id]?.length)
  return (
    <div className="page diagnostic-page">
      <div className="page-head">
        {routeId && <Plain className="back" aria-label={s('quality.back')} onClick={back}><Icon n="back" s={20} /></Plain>}
        <div className="ph-t"><h1>{routeId && route ? s('quality.for', { name: route.name }) : s('an.title')}</h1><span className="m">{routeId && route ? s('quality.use.' + connectionUse(route.connectionUse)) : s('diag.auto.hint')}</span></div>
      </div>
      {!routeId && <NetworkContext snap={snap} status={status} inspect={setInspectedId} />}
      {!routeId && route && <div className="diagnostic-context-choice"><span>{s('quality.for', { name: route.name })}</span><Btn sm kind="ghost" onClick={() => setInspectedId(undefined)}><Icon n="x" s={13} />{s('diag.any.target')}</Btn></div>}
      {routeId && !route ? <p className="lead">{s('route.removed')}</p> : <Probe key={route?.id ?? 'general'} snap={snap} live={live} route={route} auto={!routeId} runtime={`${status.phase}:${status.since ?? ''}`} />}
      {!routeId && <details className="diagnostic-extras" onToggle={event => setExtras(event.currentTarget.open)}>
        <summary><Icon n="pulse" />{s('diag.extra')}<Icon n="chev" s={14} /></summary>
        <p className="hint">{s('diag.extra.hint')}</p>
        {extras && <><PayloadCheck snap={snap} /><section className="panel">
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
        </section></>}
      </details>}
    </div>
  )
}

function NetworkContext({ snap, status, inspect }: { snap: Snapshot; status: Status; inspect: (id: string) => void }) {
  const issues = Object.entries(status.routes ?? {}).filter(([, state]) => ['blocked', 'retrying', 'fallback'].includes(state.state))
  const state = status.phase === 'error' || status.engine === 'down' ? 'error' : status.phase === 'on' ? 'on' : status.phase === 'off' ? 'off' : 'changing'
  const notices = snap.notices.filter(notice => notice.level === 'block')
  return <section className={'panel diagnostic-context ' + state} aria-label={s('diag.network')}>
    <div className="diagnostic-context-head"><Icon n={state === 'error' ? 'warn' : state === 'on' ? 'check' : 'info'} s={18} /><div className="grow"><b>{s('diag.engine.' + state)}</b><p className="hint">{status.error || s('diag.engine.' + state + '.hint')}</p></div><span className="m">{s('diag.routes', { n: snap.settings.routes.filter(route => route.on).length })}</span></div>
    {!!notices.length && <div className="diagnostic-issues">{notices.map(notice => <p key={notice.title}><b>{notice.title}</b><span>{notice.text}</span></p>)}</div>}
    {!!issues.length && state === 'on' && <div className="diagnostic-issues">{issues.slice(0, 4).map(([id, effective]) => {
      const route = snap.settings.routes.find(item => item.id === id)
      return <div className="diagnostic-issue" key={id}><Icon n={effective.state === 'blocked' ? 'warn' : 'info'} s={15} /><div className="grow"><b>{route?.name ?? s('diag.rest')}</b><span>{s('diag.reason.' + (effective.reason ?? 'waiting'), { v: viaName(snap.profiles, effective.effective ?? effective.desired) })}</span></div>{route && <Btn sm kind="ghost" onClick={() => inspect(id)}>{s('diag.inspect')}</Btn>}</div>
    })}{issues.length > 4 && <p className="hint">{s('diag.more.issues', { n: issues.length - 4 })}</p>}</div>}
  </section>
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
function Probe({ snap, live, route, auto = false, runtime }: { snap: Snapshot; live: boolean; route?: Route; auto?: boolean; runtime: string }) {
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
  const lastAuto = useRef('')
  const lastRuntime = useRef(runtime)
  useEffect(() => {
    if (lastSignature.current === signature) return
    lastSignature.current = signature
    if (applyingRef.current) return
    runId.current++; checking.current = false; setBusy(false); setRes(undefined); setNotice('stale')
    void api.diagnoseCancel().catch(() => undefined)
  }, [signature])
  useEffect(() => {
    if (lastRuntime.current === runtime) return
    lastRuntime.current = runtime
    if (applyingRef.current) return
    runId.current++; checking.current = false; setBusy(false); setRes(undefined); setNotice(undefined)
    void api.diagnoseCancel().catch(() => undefined)
  }, [runtime])
  useEffect(() => () => { runId.current++; checking.current = false; void api.diagnoseCancel().catch(() => undefined) }, [])
  const run = async () => {
    if (!t.trim() || checking.current) return
    lastAuto.current = `${runtime}:${t.trim()}`
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
  useEffect(() => {
    if (!auto || !t.trim() || runtime.startsWith('starting:') || runtime.startsWith('stopping:')) return
    const key = `${runtime}:${t.trim()}`
    if (lastAuto.current === key) return
    const timer = setTimeout(() => { if (lastAuto.current !== key && !checking.current && !applyingRef.current) void run() }, 600)
    return () => clearTimeout(timer)
  }, [auto, t, runtime, busy])
  const cancel = () => {
    if (applyingRef.current) return
    runId.current++; checking.current = false; setBusy(false); setRes(undefined); setNotice('cancelled')
    void api.diagnoseCancel().catch(() => undefined)
  }
  const f = res?.finding
  const host = res?.host
  const inspectedRoute = route ?? snap.settings.routes.find(item => item.id === res?.scope?.routeId)
  const card = inspectedRoute ?? (host ? snap.settings.routes.find(r => r.kind === 'custom' && r.value === host) : undefined)
  const stableProfiles = res?.samples ? snap.profiles.filter(p => res.samples![p.id]?.attempted >= 2 && res.samples![p.id].responded === res.samples![p.id].attempted) : snap.profiles
  const proposed = res?.assessment ? res.assessment.recommendedVia : provenPath(f, stableProfiles)
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
  const currentVia = res?.currentVia ?? res?.scope?.effectiveVia ?? route?.via
  const currentSample = currentVia ? res?.samples?.[currentVia] : undefined
  const keepCurrent = assess?.current === 'responded'
  const assessmentHeadline = assess && (assess.reason !== 'incomplete' || route)
  const guidance = res ? diagnosticGuidance(res.direct) : undefined
  const entries = res?.samples ? Object.entries(res.samples).map(([id, sample]) => [id, sample.responded ? sample.medianMs ?? null : null] as const) : Object.entries(res?.paths ?? {})
  return (
    <section className="panel diagnostic-investigation">
      <div className="ph-row"><h3>{route ? s('quality.open') : s('an.probe')}</h3><span className="m">{auto ? s('diag.auto') : s('quality.bound')}</span></div>
      {route && <p className="hint">{s('quality.target.hint')}</p>}
      <div className="addrow">
        <Field disabled={applying || (!auto && busy)} icon="globe" aria-label={s('quality.target')} placeholder={s('an.probe.ph')} value={t} onChange={e => { if (checking.current) cancel(); setT(e.target.value); setRes(undefined); setNotice(undefined) }} onKeyDown={e => { if (e.key === 'Enter') void run() }} />
        <Btn kind="primary" onClick={run} disabled={busy || !t.trim()}><span className={busy ? 'spin' : ''}><Icon n={busy ? 'refresh' : 'bolt'} /></span>{s('an.probe.go')}</Btn>
        {busy && !applying && <Btn kind="ghost" onClick={cancel}>{s('quality.cancel')}</Btn>}
      </div>
      {busy && <p className="hint" role="status">{s(applying ? 'quality.applying' : 'quality.checking')}</p>}
      {!live && <p className="hint">{s('an.probe.off')}</p>}
      {notice && <p className={'quality-notice ' + notice} role="status">{s('quality.notice.' + notice)}</p>}
      {res === null && <div className="ferr">{s('dg.error')}</div>}
      {res && guidance && <>
        <div className="quality-result" role="status">
          <div className="quality-summary"><Icon n={assess?.current === 'responded' ? 'check' : 'info'} s={18} />
            <div className="grow"><b>{assessmentHeadline && assess ? s('quality.result.' + assess.reason, { v: viaName(snap.profiles, best ?? currentVia ?? '') }) : s('diag.result.' + guidance.explanation, { n: res.direct.http.status ?? '', to: res.direct.http.to ?? '' })}</b>
              <p>{keepCurrent && currentSample ? s('diag.current.responded', { v: viaName(snap.profiles, currentVia ?? ''), n: currentSample.responded, total: currentSample.attempted }) : s('diag.detail.' + guidance.explanation, { n: res.direct.http.status ?? '', to: res.direct.http.to ?? s('diag.redirect.unknown') })}</p>
            </div>
          </div>
          <div className="diagnostic-next"><b>{s('diag.next')}</b><p>{s(keepCurrent ? 'diag.next.keep' : 'diag.next.' + guidance.explanation)}</p></div>
          {currentVia && <p className="hint diagnostic-current"><Mark profiles={snap.profiles} via={currentVia} />{s('diag.current', { v: viaName(snap.profiles, currentVia) })}{res.scope && <span>{s('diag.for.route', { name: res.scope.routeName })}</span>}</p>}
          {host && best && res.token && (!card || card.via !== best || !card.on) && <Btn kind="primary" disabled={busy} onClick={() => void apply()}>
            {inspectedRoute ? s('quality.apply', { v: viaName(snap.profiles, best), name: inspectedRoute.name }) : card ? s('dg.route.card', { v: viaName(snap.profiles, best) }) : s('dg.route', { h: host, v: viaName(snap.profiles, best) })}
          </Btn>}
          <div className="quality-meta"><span>{res.target}</span><time dateTime={new Date(res.at).toISOString()}>{new Date(res.at).toLocaleTimeString('ru-RU')}</time></div>
        </div>
        <div className="diagnostic-stage-heading"><b>{s('diag.stages')}</b><span className="hint">{s('diag.stages.hint')}</span></div>
        <div className="diagnostic-stages" aria-label={s('diag.stages')}>
          {layers.filter(([key]) => key !== 'doh').map(([key, value], index) => <div key={key} className={'diagnostic-stage ' + value.result}>
            <span className="diagnostic-stage-label"><span>{index + 1}</span>{s('dg.l.' + key)}</span>
            <b>{key === 'http' && value.status ? s('dg.r.status', { n: value.status }) : s(value.result === 'ok' ? 'diag.stage.ok' : value.result === 'skipped' ? 'diag.stage.skipped' : value.result === 'na' ? 'dg.r.na' : value.result === 'timeout' ? 'dg.r.timeout' : 'diag.stage.failed')}</b>
          </div>)}
        </div>
        <p className="hint">{s('quality.coverage.' + connectionUse(inspectedRoute?.connectionUse))}</p>
        <details className="quality-proof" open={auto || !route || undefined}>
          <summary>{s('quality.why')}<Icon n="chev" s={14} /></summary>
          {verdict && <p className="hint">{keepCurrent && currentSample
            ? s('diag.current.responded', { v: viaName(snap.profiles, currentVia ?? ''), n: currentSample.responded, total: currentSample.attempted })
            : guidance.destinationResponded && res.direct.http.status ? s('dg.r.status', { n: res.direct.http.status }) : verdict}</p>}
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
