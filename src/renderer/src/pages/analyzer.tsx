import { useState } from 'react'
import type { Settings, Snapshot, Status, Via } from '../../../shared/types'
import type { DirectObs, Finding } from '../../../shared/evidence'
import { AUTO_ID, autoMembers } from '../../../shared/groups'
import { Btn, Field, Icon } from '../ui/kit'
import { s } from '../lib/i18n'
import { api } from '../bridge'
import { customRoute, hueOf, upsert } from '../lib/routes'
import { Mark, viaName } from '../parts'

export function Analyzer({ snap, status, hist, patch }: { snap: Snapshot; status: Status; hist: Record<string, (number | undefined)[]>; patch: (p: Partial<Settings>) => void | Promise<void> }) {
  const live = status.phase === 'on'
  const ids: Via[] = ['direct', ...snap.profiles.map(p => p.id)].filter(id => hist[id]?.length)
  return (
    <div className="page">
      <div className="page-head"><h1>{s('an.title')}</h1></div>
      <Probe snap={snap} live={live} patch={patch} />
      <section className="panel">
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
                  <Mark profiles={snap.profiles} via={id} /><b>{id === 'direct' ? s('an.isp') : viaName(snap.profiles, id)}</b>
                  <span className="mono">{avg !== undefined ? s('meter.ms', { n: avg }) : '—'}</span>
                  <span className={'mono' + (loss ? ' warn' : ' m')}>{s('an.loss', { n: loss })}</span>
                </div>
              )
            })}
          </div>
        </>}
      </section>
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

interface Diag { target: string; direct: DirectObs; paths: Record<string, number | null>; finding: Finding }

/** W3.2 "Почему не открывается?": Direct layer by layer, own paths, then one observation line; never a fake cause */
function Probe({ snap, live, patch }: { snap: Snapshot; live: boolean; patch: (p: Partial<Settings>) => void | Promise<void> }) {
  const [t, setT] = useState('youtube.com')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<Diag | null>()
  const run = async () => {
    if (!t.trim()) return
    setBusy(true)
    try { setRes(await api.diagnose(t)) } catch { setRes(null) } finally { setBusy(false) }
  }
  const f = res?.finding
  const host = res?.target.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
  const routed = !!host && snap.settings.routes.some(r => r.kind === 'custom' && r.value === host)
  const def: Via = autoMembers(snap.profiles).length ? AUTO_ID : 'direct'
  const words = (ids: string[]) => ids.slice(0, 2).map(id => viaName(snap.profiles, id)).join(', ')
  const verdict = !f ? '' : f.kind === 'restricted_direct' ? s('dg.v.layer.' + f.layer, { v: words(f.via) }) : f.kind === 'path_only' ? s('dg.v.path_only', { v: words(f.via) }) : f.kind === 'unclear' ? s('dg.v.unclear.' + f.why) : s('dg.v.' + f.kind)
  const layers: [string, { result: string; code?: string; status?: number }][] = res ? [['dns', res.direct.dnsSystem], ['doh', res.direct.dnsDoh], ['tcp', res.direct.tcp], ['tls', res.direct.tls], ['http', res.direct.http]] : []
  return (
    <section className="panel">
      <div className="ph-row"><h3>{s('an.probe')}</h3><span className="m">{s('an.probe.hint')}</span></div>
      <div className="addrow">
        <Field icon="globe" placeholder={s('an.probe.ph')} value={t} onChange={e => setT(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void run() }} />
        <Btn kind="primary" onClick={run} disabled={busy || !t.trim()}><span className={busy ? 'spin' : ''}><Icon n={busy ? 'refresh' : 'bolt'} /></span>{s('an.probe.go')}</Btn>
      </div>
      {!live && <p className="hint">{s('an.probe.off')}</p>}
      {res === null && <div className="ferr">{s('dg.error')}</div>}
      {res && <>
        <div className="dg">
          <div className="dg-col">
            <b className="dg-h">{s('via.direct')}</b>
            {layers.map(([k, o]) => (
              <div key={k} className={'dg-row ' + o.result}>
                <span className="m">{s('dg.l.' + k)}</span>
                <span>{o.result === 'ok' ? (k === 'http' && o.status ? s('dg.r.status', { n: o.status }) : s('dg.r.ok')) : o.result === 'skipped' ? '—' : s('dg.r.' + o.result + (o.code ? '.' + o.code : ''))}</span>
              </div>
            ))}
          </div>
          <div className="dg-col">
            <b className="dg-h">{s('dg.paths')}</b>
            {!Object.keys(res.paths).length && <span className="m">{s('dg.nopaths')}</span>}
            {Object.entries(res.paths).map(([id, ms]) => (
              <div key={id} className={'dg-row ' + (ms === null ? 'fail' : 'ok')}>
                <span className="dg-n"><Mark profiles={snap.profiles} via={id} />{viaName(snap.profiles, id)}</span>
                <span className="mono">{ms === null ? s('an.fail') : s('meter.ms', { n: ms })}</span>
              </div>
            ))}
          </div>
        </div>
        {verdict && <div className={'verdict ' + (f?.kind === 'direct_ok' ? 'open' : f?.kind === 'unclear' ? '' : 'blocked')}>
          <Icon n={f?.kind === 'direct_ok' ? 'check' : 'info'} s={14} /><span className="grow">{verdict}</span>
          {(f?.kind === 'restricted_direct' || f?.kind === 'path_only') && host && !routed && def !== 'direct' &&
            <Btn sm onClick={() => void patch({ routes: upsert(snap.settings, customRoute(host, def)) })}>{s('dg.route', { v: viaName(snap.profiles, def) })}</Btn>}
          {f?.kind === 'unclear' && <Btn sm kind="ghost" onClick={() => void run()}>{s('dg.again')}</Btn>}
        </div>}
      </>}
    </section>
  )
}
