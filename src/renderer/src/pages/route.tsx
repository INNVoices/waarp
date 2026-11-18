import { useRef, useState } from 'react'
import type { AppInfo, Conn, Route, Snapshot, Status, Via } from '../../../shared/types'
import { PRESETS } from '../../../shared/presets'
import { Btn, fmtBytes, Icon, Plain, Select, Toggle } from '../ui/kit'
import { s } from '../lib/i18n'
import { connsOf, dropRoute, hueOf, patchRoute } from '../lib/routes'
import { isDraft } from '../lib/flow'
import { kindLabel, Mark, RouteIcon, viaName } from '../parts'
import { ServerPicker } from './server-picker'
import { api } from '../bridge'
import type { SettingsPatch } from '../lib/actions'
import { safeVia } from '../../../shared/companion'
import { routeSchemeHintKey, routeStateKey } from '../lib/route-state'

interface P { snap: Snapshot; status: Status; conns: Conn[]; apps: AppInfo[]; id: string; patch: SettingsPatch; toast: (text: string) => void; back: () => void }

export function RoutePage({ snap, status, conns, apps, id, patch, toast, back }: P) {
  const [applying, setApplying] = useState<Via>()
  const [saving, setSaving] = useState(false)
  const [checkingServer, setCheckingServer] = useState(false)
  const changing = useRef(false)
  const st = snap.settings
  const r = st.routes.find(x => x.id === id)
  // Hooks must survive a snapshot that removes the route currently being inspected.
  if (!r) return <div className="page"><p className="lead">{s('route.removed')}</p><Btn kind="ghost" onClick={back}><Icon n="back" />{s('nav.back')}</Btn></div>
  const live = status.phase === 'on'
  const draft = isDraft(r) // new target: off, no path chosen yet
  const locked = saving || !!applying || checkingServer
  const set = async (p: Partial<Route>) => {
    if (changing.current) return
    changing.current = true; setSaving(true)
    try { await patch({ routes: patchRoute(st, r.id, p) }) }
    finally { changing.current = false; setSaving(false) }
  }
  const remove = async () => {
    if (changing.current) return
    changing.current = true; setSaving(true)
    try { if (await patch({ routes: dropRoute(st, r.id) })) back() }
    finally { changing.current = false; setSaving(false) }
  }
  const select = async (via: Via) => {
    if (changing.current) return
    changing.current = true
    setApplying(via)
    try {
      const result = await api.selectRoute(r.id, via)
      if (!result?.ok || result.error) toast(result?.error ?? s('route.apply.error'))
    } catch { toast(s('route.apply.error')) }
    finally { changing.current = false; setApplying(undefined) }
  }
  const icon = apps.find(a => 'app:' + a.id === r.id)?.icon
  const cs = live ? connsOf(r, conns) : []
  const forCompanion = r.owner === 'companion'
  const safe = (v: Via) => !forCompanion || safeVia(v, st, snap.profiles)
  const e = status.routes?.[r.id]
  const nowText = !e ? '' : e.state === 'ok' ? (e.effective && e.effective !== r.via ? s('route.now.picked', { a: viaName(snap.profiles, r.via), v: viaName(snap.profiles, e.effective) }) : s('route.now.ok', { v: viaName(snap.profiles, r.via) }))
    : e.state === 'fallback' ? s('route.now.fallback', { v: viaName(snap.profiles, e.effective ?? '') })
    : e.state === 'direct' ? s('route.now.direct') : s(routeStateKey(r, status, e, draft))
  const visibleNowText = applying ? s('route.applying', { v: viaName(snap.profiles, applying) }) : nowText
  const schemeHint = routeSchemeHintKey(r, status)
  const preset = r.kind === 'preset' ? PRESETS.find(p => p.id === r.preset) : undefined
  const dest = cs[0]?.host
  const eff = (live && status.fallback[r.id]) || r.via
  const onFb = eff !== r.via
  const fbOpts = snap.profiles.filter(p => !p.revoked && p.id !== r.via && p.kind !== 'group').map(p => p.id).filter(safe)
  return (
    <div className="page">
      <div className="page-head">
        <Plain className="back" aria-label={s('nav.back')} onClick={back}><Icon n="back" s={20} /></Plain>
        <div className="rc-ic big"><RouteIcon r={r} icon={icon} size={40} /></div>
        <div className="ph-t"><h1 title={r.name}>{r.name}</h1><span className="m">{kindLabel(r)}</span></div>
        <div className="grow" />
        <Toggle on={r.on} disabled={draft || locked} onChange={v => set({ on: v })} label={r.name} />
        <Btn kind="danger" disabled={locked} onClick={() => void remove()}><Icon n="trash" />{s('conn.remove')}</Btn>
      </div>

      {draft && <div className="route-now" role="status"><span className="st-dot" aria-hidden /><span className="grow">{s('route.draft')}</span></div>}
      {!draft && visibleNowText && <div className={'route-now' + (applying ? ' applying' : e?.state === 'fallback' || e?.state === 'retrying' ? ' warn' : e?.state === 'blocked' ? ' err' : '')} role="status" aria-live="polite">
        <span className="st-dot" aria-hidden /><span className="grow">{visibleNowText}</span>
        {!applying && (e?.state === 'retrying' && e.reason !== 'waiting' || e?.state === 'fallback') && <span className="m">{s('route.now.why')}</span>}
      </div>}
      <ServerPicker snap={snap} status={status} route={r} applying={applying} disabled={locked} onSelect={select} onBusyChange={setCheckingServer} toast={toast} />

      <details className="route-details">
        <summary><Icon n="gear" /><span>{s('server.details')}</span><Icon n="chev" /></summary>
        <div className="route-details-body">
          {!draft && r.via !== 'direct' && snap.profiles.find(p => p.id === r.via)?.kind !== 'group' && fbOpts.length > 0 && <section className="panel">
            <h3>{s('route.fb')}</h3><p className="hint">{s('route.fb.hint')}</p>
            <Select disabled={locked} value={r.fallback ?? ''} onChange={event => void set({ fallback: event.target.value || undefined })} aria-label={s('route.fb')}>
              <option value="">{s('route.fb.none')}</option>
              {fbOpts.map(v => <option key={v} value={v}>{viaName(snap.profiles, v)}</option>)}
            </Select>
          </section>}

      <section className="panel">
        <div className="ph-row"><h3>{s('route.scheme')}</h3>{schemeHint && <span className="m">{s(schemeHint)}</span>}</div>
        <div className={"scheme" + (eff === "direct" ? " short" : "")} style={{ '--hue': hueOf(snap.profiles, eff) ?? 'var(--line-2)' } as React.CSSProperties}>
          <div className="node you"><span className="nd-ic"><Icon n="user" s={20} /></span><b>{s('route.you')}</b><small className="m">{s('route.isp')}</small></div>
          <div className="link"><span className="lk-ms">{live && status.pings.direct !== undefined ? s('meter.ms', { n: status.pings.direct }) : '—'}</span></div>
          {eff !== 'direct' && <>
            <div className="node srv"><span className="nd-ic"><Mark profiles={snap.profiles} via={eff} /></span><b>{viaName(snap.profiles, eff)}</b><small className="m mono">{snap.profiles.find(p => p.id === eff)?.host}</small></div>
            <div className="link"><span className="lk-ms">{live && status.pings[eff] !== undefined ? s('meter.ms', { n: status.pings[eff]! }) : '—'}</span></div>
          </>}
          <div className="node dst"><span className="nd-ic"><RouteIcon r={r} icon={icon} size={28} /></span><b className="ell">{dest ?? r.name}</b><small className="m">{s('route.dest')}</small></div>
        </div>
        {onFb && <p className="hint warn">{s('route.fb.on', { a: viaName(snap.profiles, r.via), b: viaName(snap.profiles, eff) })}</p>}
        {live && <p className="hint">{cs.length ? s('route.live', { n: cs.length, t: fmtBytes(cs.reduce((a, c) => a + c.down + c.up, 0)) }) : s('route.idle')}</p>}
      </section>

      <section className="panel">
        <h3>{s('route.more')}</h3>
        <Row title={s('route.dpi')} text={r.via === 'direct' ? s('route.dpi.text') : s('route.dpi.off')}>
          <Toggle on={r.via === 'direct' && r.dpi === true} disabled={locked || r.via !== 'direct'} onChange={v => set({ dpi: v })} label={s('route.dpi')} />
        </Row>
        {r.kind === 'app' && <>
          <Row title={s('route.dir')} text={r.matchDir ? s('route.dir.text', { d: r.matchDir }) : s('route.dir.none')}>
            <Toggle on={!!r.matchDir && r.wholeDir === true} disabled={locked || !r.matchDir} onChange={v => set({ wholeDir: v })} label={s('route.dir')} />
          </Row>
          <div className="path mono selectable">{r.exe}</div>
        </>}
        {preset && <div className="chips">{[...preset.domains, ...(preset.cidrs ?? [])].map(d => <span key={d} className="chip mono">{d}</span>)}</div>}
        {r.kind === 'list' && (() => { const l = snap.lists?.find(x => x.id === r.list); return <p className="hint">{l ? s('lists.route', { n: l.count, name: l.name }) + (l.enabled ? '' : ' · ' + s('lists.disabled')) : s('lists.gone')}</p> })()}
        {r.kind === 'custom' && <>
          <div className="path mono selectable">{r.value}</div>
          <p className="hint">{s('custom.dest.note')}</p>
        </>}
      </section>
        </div>
      </details>
    </div>
  )
}

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return <div className="opt"><div><b>{title}</b><p>{text}</p></div>{children}</div>
}
