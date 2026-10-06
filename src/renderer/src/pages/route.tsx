import { useState } from 'react'
import type { AppInfo, Conn, Route, Settings, Snapshot, Status, Via } from '../../../shared/types'
import { PRESETS } from '../../../shared/presets'
import { Btn, fmtBytes, Icon, Plain, Toggle } from '../ui/kit'
import { s } from '../lib/i18n'
import { connsOf, dropRoute, hueOf, patchRoute } from '../lib/routes'
import { isDraft } from '../lib/flow'
import { kindLabel, Mark, Ping, RouteIcon, subOf, viaName, AutoHint } from '../parts'
import { PublicCatalog } from './publiccat'
import { api } from '../bridge'
import { AUTO_ID, autoMembers } from '../../../shared/groups'
import { safeVia } from '../../../shared/companion'
import { routeSchemeHintKey, routeStateKey } from '../lib/route-state'

interface P { snap: Snapshot; status: Status; conns: Conn[]; apps: AppInfo[]; id: string; patch: (p: Partial<Settings>) => void | Promise<void>; toast: (text: string) => void; back: () => void }

export function RoutePage({ snap, status, conns, apps, id, patch, toast, back }: P) {
  const st = snap.settings
  const r = st.routes.find(x => x.id === id)
  if (!r) return <div className="page"><Btn kind="ghost" onClick={back}><Icon n="back" />{s('nav.back')}</Btn></div>
  const live = status.phase === 'on'
  const draft = isDraft(r) // new target: off, no path chosen yet
  const set = (p: Partial<Route>) => patch({ routes: patchRoute(st, r.id, p) })
  const [applying, setApplying] = useState<Via>()
  const select = async (via: Via) => {
    if (applying) return
    setApplying(via)
    try {
      const result = await api.selectRoute(r.id, via)
      if (!result?.ok || result.error) toast(result?.error ?? 'Не удалось применить маршрут')
    } catch { toast('Не удалось применить маршрут') }
    finally { setApplying(undefined) }
  }
  const icon = apps.find(a => 'app:' + a.id === r.id)?.icon
  const cs = live ? connsOf(r, conns) : []
  const forCompanion = r.owner === 'companion'
  const safe = (v: Via) => !forCompanion || safeVia(v, st, snap.profiles)
  const opts: Via[] = [...(autoMembers(snap.profiles).length ? [AUTO_ID] : []), 'direct', ...snap.profiles.filter(p => !p.revoked).map(p => p.id)].filter(safe)
  const e = status.routes?.[r.id]
  const nowText = !e ? '' : e.state === 'ok' ? (e.effective && e.effective !== r.via ? s('route.now.picked', { a: viaName(snap.profiles, r.via), v: viaName(snap.profiles, e.effective) }) : s('route.now.ok', { v: viaName(snap.profiles, r.via) }))
    : e.state === 'fallback' ? s('route.now.fallback', { v: viaName(snap.profiles, e.effective ?? '') })
    : e.state === 'direct' ? s('route.now.direct') : s(routeStateKey(r, status, e, draft))
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
        <div className="ph-t"><h1>{r.name}</h1><span className="m">{kindLabel(r)}</span></div>
        <div className="grow" />
        <Toggle on={r.on} disabled={draft} onChange={v => set({ on: v })} label={r.name} />
        <Btn kind="danger" onClick={() => { patch({ routes: dropRoute(st, r.id) }); back() }}><Icon n="trash" />{s('conn.remove')}</Btn>
      </div>

      {draft && <div className="route-now warn" role="status"><span className="st-dot" aria-hidden /><span className="grow">{s('route.draft')}</span></div>}
      {!draft && nowText && <div className={'route-now' + (e?.state === 'fallback' || e?.state === 'retrying' ? ' warn' : e?.state === 'blocked' ? ' err' : '')} role="status">
        <span className="st-dot" aria-hidden /><span className="grow">{nowText}</span>
        {(e?.state === 'retrying' || e?.state === 'fallback') && <span className="m">{s('route.now.why')}</span>}
      </div>}
      <section className="panel">
        <h3>{s('route.server')}</h3>
        <div className="vgrid">
          {opts.map(v => {
            const on = !draft && r.via === v
            const p = snap.profiles.find(x => x.id === v)
            return (
              <Plain key={v} disabled={!!applying} aria-busy={applying === v} className={'vopt' + (on ? ' on' : '') + (applying === v ? ' applying' : '')} onClick={() => void select(v)}>
                <span className="radio" />
                <span className="vo-t"><span className="vo-n"><Mark profiles={snap.profiles} via={v} />{viaName(snap.profiles, v)}</span>
                  <small className="m ell">{v === 'direct' ? s('via.direct.hint') : v === AUTO_ID ? <AutoHint profiles={snap.profiles} bare /> : subOf(p)}</small></span>
                <Ping ms={status.pings[v]} live={live} down={v === r.via ? e?.reason === 'path_down' : status.health?.[v] === 'down'} />
              </Plain>
            )
          })}
        </div>
        {!snap.profiles.length && <p className="hint">{s('route.noservers')}</p>}
      </section>

      {/* public nodes are a low-trust extra source, never in the main flow (GPT 35816ee C) */}
      {!forCompanion && <details className="pub-more"><summary>{s('route.pub.more')}</summary>
        <PublicCatalog compact toast={toast} used={pid => snap.profiles.some(p => p.id === pid)} onAdded={pid => void select(pid)} />
      </details>}

      {!draft && r.via !== 'direct' && snap.profiles.find(p => p.id === r.via)?.kind !== 'group' && fbOpts.length > 0 && (
        <section className="panel">
          <h3>{s('route.fb')}</h3>
          <p className="hint">{s('route.fb.hint')}</p>
          <div className="vgrid">
            {[undefined, ...fbOpts].map(v => {
              const on = r.fallback === v
              const p = snap.profiles.find(x => x.id === v)
              return (
                <Plain key={v ?? 'none'} className={'vopt' + (on ? ' on' : '')} onClick={() => set({ fallback: v })}>
                  <span className="radio" />
                  <span className="vo-t"><span className="vo-n">{v ? <><Mark profiles={snap.profiles} via={v} />{viaName(snap.profiles, v)}</> : s('route.fb.none')}</span>
                    <small className="m ell">{v ? subOf(p) : s('route.fb.none.hint')}</small></span>
                  {v && <Ping ms={status.pings[v]} live={live} down={status.health?.[v] === 'down'} />}
                </Plain>
              )
            })}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="ph-row"><h3>{s('route.scheme')}</h3>{schemeHint && <span className="m">{s(schemeHint)}</span>}</div>
        <div className={"scheme" + (eff === "direct" ? " short" : "")} style={{ '--hue': hueOf(snap.profiles, eff) ?? 'var(--line-2)' } as React.CSSProperties}>
          <div className="node you"><span className="nd-ic"><Icon n="user" s={20} /></span><b>{s('route.you')}</b><small className="m">{s('route.isp')}</small></div>
          <div className="link"><span className="lk-ms">{live && status.pings.direct ? s('meter.ms', { n: status.pings.direct }) : '—'}</span></div>
          {eff !== 'direct' && <>
            <div className="node srv"><span className="nd-ic"><Mark profiles={snap.profiles} via={eff} /></span><b>{viaName(snap.profiles, eff)}</b><small className="m mono">{snap.profiles.find(p => p.id === eff)?.host}</small></div>
            <div className="link"><span className="lk-ms">{live && status.pings[eff] ? s('meter.ms', { n: status.pings[eff]! }) : '—'}</span></div>
          </>}
          <div className="node dst"><span className="nd-ic"><RouteIcon r={r} icon={icon} size={28} /></span><b className="ell">{dest ?? r.name}</b><small className="m">{s('route.dest')}</small></div>
        </div>
        {onFb && <p className="hint warn">{s('route.fb.on', { a: viaName(snap.profiles, r.via), b: viaName(snap.profiles, eff) })}</p>}
        {live && <p className="hint">{cs.length ? s('route.live', { n: cs.length, t: fmtBytes(cs.reduce((a, c) => a + c.down + c.up, 0)) }) : s('route.idle')}</p>}
      </section>

      <section className="panel">
        <h3>{s('route.more')}</h3>
        {r.kind === 'app' && <>
          <Row title={s('route.dir')} text={r.matchDir ? s('route.dir.text', { d: r.matchDir }) : s('route.dir.none')}>
            <Toggle on={!!r.matchDir && r.wholeDir === true} disabled={!r.matchDir} onChange={v => set({ wholeDir: v })} label={s('route.dir')} />
          </Row>
          <div className="path mono selectable">{r.exe}</div>
        </>}
        {preset && <div className="chips">{[...preset.domains, ...(preset.cidrs ?? [])].map(d => <span key={d} className="chip mono">{d}</span>)}</div>}
        {r.kind === 'custom' && <>
          <div className="path mono selectable">{r.value}</div>
          <p className="hint">{s('custom.dest.note')}</p>
        </>}
      </section>
    </div>
  )
}

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return <div className="opt"><div><b>{title}</b><p>{text}</p></div>{children}</div>
}
