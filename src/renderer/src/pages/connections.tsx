import { useState } from 'react'
import type { AppInfo, Conn, Route, Settings, Snapshot, Status } from '../../../shared/types'
import { Btn, fmtBytes, fmtSpeed, Icon, Plain, Seg, Toggle, Tooltip } from '../ui/kit'
import { s, sp } from '../lib/i18n'
import { moodOf, REST_ID } from '../../../shared/effective'
import { connRoute, connsOf, dropRoute, patchRoute } from '../lib/routes'
import { kindLabel, Mark, Orb, Ping, RouteIcon, viaName, ViaPicker } from '../parts'

interface P {
  snap: Snapshot; status: Status; conns: Conn[]; apps: AppInfo[]
  patch: (p: Partial<Settings>) => void
  toggle: () => void
  open: (id: string) => void
  add: () => void
}

export function Connections({ snap, status, conns, apps, patch, toggle, open, add }: P) {
  const st = snap.settings
  const live = status.phase === 'on'
  const icon = (r: Route) => apps.find(a => 'app:' + a.id === r.id)?.icon
  const block = snap.notices.find(n => n.level === 'block')
  const blocked = !!block
  const demandsTunnel = st.rest !== 'direct' || st.routes.some(r => r.on && r.via !== 'direct')
  const why = block ? block.title : !snap.profiles.length && !demandsTunnel ? s('orb.noserver') : undefined
  const available = snap.profiles.filter(p => !p.revoked)
  const measured = available.filter(p => status.pings[p.id] !== undefined).sort((a, b) => status.pings[a.id]! - status.pings[b.id]!)
  const allPick = st.allVia && available.some(p => p.id === st.allVia) ? st.allVia : measured[0]?.id ?? available[0]?.id ?? 'direct'
  return (
    <div className="page">
      <section className="hero">
        {/* the window orb is the product character and the one primary action (GPT 36caa9f) */}
        <Orb status={status} disabled={(!snap.profiles.length && !demandsTunnel) || blocked} why={why} onClick={toggle} />
        <div className="hero-side">
          <State snap={snap} status={status} disabled={(!snap.profiles.length && !demandsTunnel) || blocked} why={why} />
          <div className="rest">
        <Tooltip tip={s('rest.tip')}><span className="lbl help">{s('home.scope')}</span></Tooltip>
        <Seg<'cards' | 'all'> value={st.rest === 'direct' ? 'cards' : 'all'} onChange={m => patch(m === 'all' ? { rest: allPick, allVia: allPick } : { rest: 'direct', allVia: st.rest !== 'direct' ? st.rest : st.allVia })}
          items={[{ v: 'cards', label: s('home.scope.cards') }, { v: 'all', label: s('home.scope.all') }]} />
        {st.rest !== 'direct' && <ViaPicker noDirect profiles={snap.profiles} via={st.rest} pings={status.pings} live={live} down={v => v === st.rest ? status.routes?.[REST_ID]?.reason === 'path_down' : status.health?.[v] === 'down'} onChange={v => patch({ rest: v, allVia: v })} />}
          </div>
        </div>
      </section>

      <div className="sec-head">
        <h2>{s('conn.title')}</h2>
        <span className="m">{sp('conn.count', st.routes.length)}</span>
      </div>
      <p className="lead">{s('conn.lead')}</p>
      <div className="cards">
        {st.routes.map(r => {
          const cs = live ? connsOf(r, conns) : []
          const tr = cs.reduce((a, c) => a + c.down + c.up, 0)
          return (
            <div key={r.id} className={'rcard' + (r.on ? ' on' : '')} onClick={() => open(r.id)}>
              <Plain className="rc-x" aria-label={s('conn.remove')} onClick={e => { e.stopPropagation(); patch({ routes: dropRoute(st, r.id) }) }}><Icon n="x" s={12} /></Plain>
              <div className="rc-top">
                <div className="rc-ic"><RouteIcon r={r} icon={icon(r)} /></div>
                <div className="rc-t">
                  <div className="rc-n">{r.name}</div>
                  <div className="rc-k">{kindLabel(r)}{tr > 0 && <small className="m mono">{` · ${fmtBytes(tr)}`}</small>}{live && status.fallback[r.id] && <Tooltip tip={s('conn.fb.tip', { v: viaName(snap.profiles, status.fallback[r.id]) })}><span className="fb-mark"><Icon n="refresh" s={12} /></span></Tooltip>}</div>
                </div>
                <Tooltip tip={s(r.on ? 'conn.on.tip' : 'conn.off.tip')}><span><Toggle on={r.on} onChange={v => patch({ routes: patchRoute(st, r.id, { on: v }) })} label={r.name} /></span></Tooltip>
              </div>
              <ViaPicker compact profiles={snap.profiles} via={r.via} pings={status.pings} live={live} down={v => v === r.via ? status.routes?.[r.id]?.reason === 'path_down' : status.health?.[v] === 'down'} onChange={v => patch({ routes: patchRoute(st, r.id, { via: v }) })} />
            </div>
          )
        })}
        <Plain className="rcard add" onClick={add} aria-label={s('conn.add')}><Icon n="plus" s={20} /><span>{s('conn.add')}</span></Plain>
      </div>

      {/* live flows are evidence, not the screen: collapsed until asked for */}
      <details className="flows">
        <summary className="sec-head"><h2>{s('conns.title')}</h2>{live && <span className="m">{sp('conns.count', conns.length)}</span>}<Icon n="chev" s={14} /></summary>
        <Stats status={status} />
        <ConnTable snap={snap} status={status} conns={conns} apps={apps} />
      </details>
      <p className="hint">{s('safety.crash')}</p>
    </div>
  )
}

type Mood = 'on' | 'recovering' | 'attention' | 'off' | 'busy' | 'error'
/** beside the orb: is it working, where does traffic go, is anything degraded */
function State({ snap, status, disabled, why }: { snap: Snapshot; status: Status; disabled: boolean; why?: string }) {
  const st = snap.settings
  // W2.1: main ships the effective state per route; mood = effective impact only (a sick spare never shows here)
  const eff = Object.values(status.routes ?? {})
  const fb = eff.filter(e => e.state === 'fallback').length
  const bad = eff.filter(e => e.reason === 'path_down').length
  const engineOut = eff.some(e => e.reason === 'engine_down')
  const m = moodOf(status.routes ?? {}), stuck = eff.filter(e => e.state === 'blocked').length
  const mood: Mood = status.phase === 'on' ? (m === 'ok' ? 'on' : m)
    : status.phase === 'starting' || status.phase === 'stopping' ? 'busy' : status.phase === 'error' ? 'error' : 'off'
  const exit = st.rest === 'direct' ? s('home.exit.cards', { n: st.routes.filter(r => r.on && r.via !== 'direct').length }) : s('home.exit.all', { v: viaName(snap.profiles, st.rest) })
  const rec = fb ? s('home.sub.recovering', { n: fb }) : engineOut ? s('home.sub.engine') : s('home.sub.pathdown', { n: bad })
  const sub = mood === 'recovering' ? rec : mood === 'attention' ? s('home.sub.attention', { n: stuck }) : mood === 'error' ? status.error ?? s('orb.error.sub') : mood === 'off' && disabled && why ? why : exit
  return (
    <section className={'state m-' + mood} aria-live="polite">
      <span className="st-dot" aria-hidden />
      <div className="grow">
        <div className="st-t">{s('home.mood.' + mood)}</div>
        <div className="st-s">{sub}</div>
      </div>
    </section>
  )
}

function Stats({ status }: { status: Status }) {
  const on = status.phase === 'on'
  const dash = '—'
  return (
    <div className={'stats' + (on ? '' : ' dim')}>
      <div><Icon n="down" s={14} /><b>{on ? fmtSpeed(status.down) : dash}</b><small>{on ? fmtBytes(status.downTotal) : s('meter.down')}</small></div>
      <div><Icon n="up" s={14} /><b>{on ? fmtSpeed(status.up) : dash}</b><small>{on ? fmtBytes(status.upTotal) : s('meter.up')}</small></div>
      <div><Icon n="bolt" s={14} /><b>{status.pings.direct ? s('meter.ms', { n: status.pings.direct }) : dash}</b><small>{s('meter.isp')}</small></div>
    </div>
  )
}

interface Group { key: string; name: string; exe: string; via: string; conns: Conn[]; down: number; up: number; routed?: Route }

function ConnTable({ snap, status, conns, apps }: { snap: Snapshot; status: Status; conns: Conn[]; apps: AppInfo[] }) {
  const [openKey, setOpenKey] = useState<string>()
  const [f, setF] = useState<'all' | 'vpn' | 'direct'>('all')
  const live = status.phase === 'on'
  if (!live) return <div className="panel emptyst"><Icon n="pulse" s={24} /><span>{s('conns.idle')}</span></div>
  const groups = new Map<string, Group>()
  for (const c of conns) {
    if (f === 'vpn' && c.via === 'direct') continue
    if (f === 'direct' && c.via !== 'direct') continue
    const key = (c.exe || c.app) + '|' + c.via
    const g = groups.get(key) ?? { key, name: c.app || s('conns.system'), exe: c.exe, via: c.via, conns: [], down: 0, up: 0, routed: connRoute(c, snap.settings.routes) }
    g.conns.push(c); g.down += c.down; g.up += c.up
    groups.set(key, g)
  }
  const list = [...groups.values()].sort((a, b) => b.down + b.up - (a.down + a.up))
  const iconOf = (exe: string) => apps.find(a => a.exe.toLowerCase() === exe.toLowerCase())?.icon
  return (
    <div className="panel">
      <div className="ptools">
        {(['all', 'vpn', 'direct'] as const).map(k => (
          <Btn key={k} sm kind={f === k ? 'default' : 'ghost'} onClick={() => setF(k)}>{s('conns.' + k)}</Btn>
        ))}
      </div>
      <div className="ct">
        <div className="ct-r th">
          <span>{s('conns.h.app')}</span><span>{s('conns.h.via')}</span><span>{s('conns.h.host')}</span><span>{s('conns.h.proto')}</span>
          <span className="r">{s('conns.h.up')}</span><span className="r">{s('conns.h.down')}</span><span className="r">{s('conns.h.ping')}</span><span />
        </div>
        {list.slice(0, 120).map(g => {
          const top = g.conns[0]
          const isOpen = openKey === g.key
          return (
            <div key={g.key} className={'ct-g' + (isOpen ? ' open' : '')}>
              <div className="ct-r" onClick={() => setOpenKey(isOpen ? undefined : g.key)}>
                <span className="ct-app">
                  {iconOf(g.exe) ? <img src={iconOf(g.exe)} alt="" /> : <i className="ph-ic sm">{g.name.slice(0, 1)}</i>}
                  <b className="ell">{g.name}</b><em className="badge">{g.conns.length}</em>
                </span>
                <span className="ct-via"><Mark profiles={snap.profiles} via={g.via} /><span className="ell">{viaName(snap.profiles, g.via)}</span></span>
                <span className="ell mono">{`${top.host}:${top.port}`}</span>
                <span className="mono m">{top.net.toUpperCase()}</span>
                <span className="r mono">{fmtBytes(g.up)}</span>
                <span className="r mono">{fmtBytes(g.down)}</span>
                <span className="r">{g.via === 'direct' ? <Ping ms={status.pings.direct} live /> : <Ping ms={status.pings[g.via]} live down={status.health?.[g.via] === 'down'} />}</span>
                <span className="r m"><span className={'chev' + (isOpen ? ' up' : '')}><Icon n="chev" s={14} /></span></span>
              </div>
              {isOpen && (
                <div className="ct-more">
                  <div className="why">
                    <Icon n="info" s={14} />
                    <span>{g.routed ? s('why.route', { n: g.routed.name, v: viaName(snap.profiles, g.via) }) : s('why.rest', { v: viaName(snap.profiles, g.via) })}</span>
                  </div>
                  {g.conns.slice(0, 40).map(c => (
                    <div key={c.id} className="ct-sub mono">
                      <span className="ell">{c.host}</span><span className="m">{`:${c.port} ${c.net}`}</span>
                      <span className="r">{`↑ ${fmtBytes(c.up)}`}</span><span className="r">{`↓ ${fmtBytes(c.down)}`}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {!list.length && <div className="emptyst"><span>{s('conns.quiet')}</span></div>}
      </div>
    </div>
  )
}
