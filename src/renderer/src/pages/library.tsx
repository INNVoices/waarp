// Маршруты (W1, GPT 440a5c3): the screen is the list "target -> where it goes". One + opens the catalog (running apps first,
// then installed apps, services and addresses, one search); a click on a tile asks "through what?" in a small dialog.
import { useMemo, useState } from 'react'
import type { AppInfo, Conn, Route, Settings, Snapshot, Status, Via } from '../../../shared/types'
import { PRESETS } from '../../../shared/presets'
import { Btn, Field, fmtBytes, Icon, Plain, Seg, Toggle, Tooltip } from '../ui/kit'
import { Modal } from '../ui/modal'
import { s, sp } from '../lib/i18n'
import { api } from '../bridge'
import { appRoute, connsOf, customRoute, HUES, patchRoute, presetRoute, dropRoute, upsert } from '../lib/routes'
import { kindLabel, Mark, Ping, RouteIcon, subOf, viaName, ViaPicker, AutoHint } from '../parts'
import { Brand } from '../ui/brand'
import { AUTO_ID, autoMembers } from '../../../shared/groups'
import { PublicCatalog } from './publiccat'
import { AddTunnel, importNote, type ImportResult } from './addtunnel'

type Filter = 'all' | 'run' | 'apps' | 'services' | 'custom'
type Pop = { kind: 'app'; app: AppInfo } | { kind: 'preset'; id: string } | { kind: 'route'; id: string } | { kind: 'new' }
export type Source = 'mine' | 'groups' | 'public'

interface P {
  snap: Snapshot; status: Status; conns: Conn[]; apps?: AppInfo[]; loading: boolean
  rescan: () => void; addApp: (a: AppInfo) => void
  patch: (p: Partial<Settings>) => void | Promise<void>; open: (id: string) => void; manage: () => void; toast: (text: string) => void; initialSource?: Source
}

const hueOfName = (n: string) => HUES[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length]

function Well({ children }: { children: React.ReactNode }) {
  return <span className="t-ic">{children}</span>
}

function Mono({ name }: { name: string }) {
  const h = hueOfName(name)
  return <span className="mono-ic" style={{ color: h, borderColor: `color-mix(in oklab, ${h} 40%, transparent)`, background: `color-mix(in oklab, ${h} 10%, transparent)` }}>{(name.trim()[0] ?? '?').toUpperCase()}</span>
}

function Tile({ name, tip, route, profiles, running, children, onClick }: {
  name: string; tip: string; route?: Route; profiles: Snapshot['profiles']; running?: boolean; children: React.ReactNode; onClick: () => void
}) {
  return (
    <Plain className={'tile' + (route ? ' on' : '')} onClick={onClick} tip={tip}>
      <Well>{children}{running && <i className="run" />}</Well>
      <span className="t-n">{name}</span>
      {route && <span className="t-via"><Icon n="check" s={12} /><Mark profiles={profiles} via={route.via} /></span>}
    </Plain>
  )
}

function Pick({ title, snap, status, conns, route, current, initialSource, onSource, onPick, onRemove, onMore, onManage, onAdd, onClose, head, blocked, toast }: {
  title: string; snap: Snapshot; status: Status; conns: Conn[]; route?: Route; current?: Via; onPick: (v: Via) => void; onRemove?: () => void; onMore?: () => void; onManage: () => void; onAdd: () => void; onClose: () => void; head?: React.ReactNode; blocked?: string; toast: (text: string) => void
  initialSource: Source; onSource: (source: Source) => void
}) {
  const live = status.phase === 'on'
  const [source, setSource] = useState<Source | 'root'>('root')
  const [checking, setChecking] = useState(false)
  const [probe, setProbe] = useState<Record<string, number | null>>()
  const profiles = snap.profiles.filter(p => !p.revoked)
  const opts: Via[] = source === 'groups'
    ? profiles.filter(p => p.kind === 'group').map(p => p.id)
    : [...(autoMembers(profiles).length ? [AUTO_ID] : []), 'direct', ...profiles.filter(p => p.kind !== 'group' && p.source !== 'public').map(p => p.id)]
  const traffic = route && live ? connsOf(route, conns) : []
  const test = async () => {
    setChecking(true)
    try { setProbe(await api.probe('https://www.gstatic.com/generate_204')) }
    catch { toast(s('pick.test.error')) }
    finally { setChecking(false) }
  }
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="wz-body">
        {head}
        <div className="pick-summary">
          <div><b>{s('pick.lead')}</b><span className="hint">{route ? s('pick.current', { v: viaName(snap.profiles, route.via) }) : s('pick.new')}</span></div>
          {route && <div className="pick-stats"><span>{s('pick.connections', { n: traffic.length })}</span><span>{s('pick.traffic', { n: fmtBytes(traffic.reduce((sum, c) => sum + c.down + c.up, 0)) })}</span></div>}
          <Btn kind="ghost" disabled={checking} onClick={() => void test()}><span className={checking ? 'spin' : ''}><Icon n="pulse" /></span>{s('pick.test')}</Btn>
        </div>
        {source === 'root' && <div className="pick-paths">
          <Plain className="pick-path" onClick={() => { setSource('mine'); onSource('mine') }}><span className="wz-ic"><Icon n="server" /></span><span><b>{s('pick.mine')}</b><small>{s('pick.mine.hint')}</small></span><em>{profiles.filter(p => p.kind !== 'group' && p.source !== 'public').length}</em><Icon n="down" /></Plain>
          <Plain className="pick-path" onClick={() => { setSource('public'); onSource('public') }}><span className="wz-ic"><Icon n="globe" /></span><span><b>{s('pick.public')}</b><small>{s('pick.public.hint')}</small></span><Icon n="down" /></Plain>
          <Plain className="pick-path" onClick={() => { setSource('groups'); onSource('groups') }}><span className="wz-ic"><Icon n="apps" /></span><span><b>{s('pick.groups')}</b><small>{s('pick.groups.hint')}</small></span><em>{profiles.filter(p => p.kind === 'group').length}</em><Icon n="down" /></Plain>
        </div>}
        {source !== 'root' && <Plain className="pick-back" onClick={() => setSource('root')}><Icon n="back" />{s('pick.back')}</Plain>}
        {source !== 'root' && source !== 'public' && <div className="pick-table personal-list">
          <div className="pick-row pick-th"><span>{s('pick.name')}</span><span>{s('pick.address')}</span><span>{s('pick.protocol')}</span><span>{s('pick.source')}</span><span>{s('pick.ping')}</span><span /></div>
          {opts.map(v => {
            const p = snap.profiles.find(x => x.id === v)
            const measured = probe?.[v] ?? status.pings[v]
            return (
              <div key={v} className={'pick-row' + (current === v ? ' on' : '')}>
                <span className="pick-name"><Mark profiles={snap.profiles} via={v} /><b className="ell">{viaName(snap.profiles, v)}</b></span>
                <span className="mono ell">{v === 'direct' || v === AUTO_ID ? '—' : p?.host ? `${p.host}:${p.port}` : '—'}</span>
                <span>{v === 'direct' ? s('via.direct') : v === AUTO_ID ? <AutoHint profiles={snap.profiles} bare /> : p?.version ?? '—'}</span>
                <span className="m">{v === 'direct' ? s('pick.local') : p?.kind === 'group' ? s('pick.groups') : p?.source === 'managed' ? s('srv.managed') : s('pick.mine')}</span>
                {measured === null ? <span className="ping bad">{s('an.fail')}</span> : measured !== undefined ? <span className="ping">{s('meter.ms', { n: measured })}</span> : <Ping ms={status.pings[v]} live={live} down={status.health?.[v] === 'down'} />}
                <Btn kind={current === v ? 'default' : 'primary'} sm onClick={() => onPick(v)}>{current === v ? s('pick.selected') : s('pick.use')}</Btn>
              </div>
            )
          })}
          {!opts.length && <div className="emptyst"><span>{s(source === 'groups' ? 'pick.groups.empty' : 'route.noservers')}</span></div>}
          <Plain className="pick-row add-via" onClick={onAdd}><span className="pick-name"><span className="wz-ic"><Icon n="plus" /></span><b>{s('srv.add')}</b></span><span className="m pick-add-hint">{s('pick.add.hint')}</span></Plain>
        </div>}
        {source === 'public' && <PublicCatalog compact toast={toast} used={id => snap.profiles.some(p => p.id === id)} onAdded={onPick} />}
        {blocked && <div className="ferr">{blocked}</div>}
        <div className="wz-foot">
            {onRemove && <Btn kind="danger" onClick={onRemove}><Icon n="trash" />{s('conn.remove')}</Btn>}
            <div className="grow" />
            <Btn kind="ghost" onClick={onManage}><Icon n="server" />{s('pick.manage')}</Btn>
            {onMore && <Btn kind="ghost" onClick={onMore}>{s('pick.more')}</Btn>}
        </div>
      </div>
    </Modal>
  )
}

export function Library({ snap, status, conns, apps, loading, rescan, addApp, patch, open, manage, toast, initialSource = 'mine' }: P) {
  const [q, setQ] = useState('')
  const [f, setF] = useState<Filter>('all')
  const [pop, setPop] = useState<Pop>()
  const [addr, setAddr] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [preferredSource, setPreferredSource] = useState<Source>(initialSource)
  const st = snap.settings
  const [catalog, setCatalog] = useState(!st.routes.length)
  // W2 C: a new target starts on Auto when Auto has an own connection to use, otherwise Direct. Adding never opens the tunnel.
  const defaultVia: Via = autoMembers(snap.profiles).length ? AUTO_ID : 'direct'
  const routed = new Map(st.routes.map(r => [r.id, r]))
  const ql = q.trim().toLowerCase()
  const match = (n: string, extra = '') => !ql || n.toLowerCase().includes(ql) || extra.toLowerCase().includes(ql)

  const { running, installed } = useMemo(() => {
    const list = (apps ?? []).filter(a => match(a.name, a.exe)).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    return { running: list.filter(a => a.running), installed: list.filter(a => !a.running) }
  }, [apps, ql]) // eslint-disable-line react-hooks/exhaustive-deps
  const services = PRESETS.filter(p => match(p.name, p.domains.join(' ')))
  const customs = st.routes.filter(r => r.kind === 'custom' && match(r.name, r.value ?? ''))
  const show = (k: Filter) => f === 'all' || f === k

  const pickExe = async () => {
    const a: AppInfo | null = await api.pickApp()
    if (!a) return
    addApp(a)
    // same rule as catalog tiles: default path (Auto when eligible, else Direct), then its route page
    const next = appRoute(a, defaultVia)
    await patch({ routes: upsert(st, next) })
    open(next.id)
  }
  const choose = async (v: Via) => {
    if (!pop) return
    // Choosing a primary route is a complete choice. A stale backup from the previous
    // primary must never silently start a second credential or block the new connection.
    if (pop.kind === 'route') await patch({ routes: patchRoute(st, pop.id, { via: v, on: true, fallback: undefined }) })
    else if (pop.kind === 'app') await patch({ routes: upsert(st, { ...appRoute(pop.app, v) }) })
    else if (pop.kind === 'preset') await patch({ routes: upsert(st, presetRoute(pop.id, v)) })
    else {
      const x = addr.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
      const e = x ? await api.validate(x) : s('pick.addr.empty')
      if (e) { setErr(e); return }
      const next = customRoute(x, v)
      await patch({ routes: upsert(st, next) })
      setAddr(''); setErr(null); setPop(undefined)
      open(next.id)
      return
    }
    // configuring a route never opens Waarp: closed stays closed until the orb (W2 final)
    setErr(null); setPop(undefined)
  }
  const close = () => { setPop(undefined); setErr(null); setAddr('') }
  const cur = pop?.kind === 'route' ? routed.get(pop.id) : pop?.kind === 'app' ? routed.get('app:' + pop.app.id) : pop?.kind === 'preset' ? routed.get('preset:' + pop.id) : undefined
  const popTitle = pop?.kind === 'app' ? pop.app.name : pop?.kind === 'preset' ? PRESETS.find(p => p.id === pop.id)?.name ?? '' : pop?.kind === 'route' ? routed.get(pop.id)?.name ?? '' : s('pick.addr.title')
  const anyShown = (show('run') && running.length) || (show('apps') && installed.length) || (show('services') && services.length) || (show('custom') && customs.length)

  const appTile = (a: AppInfo) => {
    const r = routed.get('app:' + a.id)
    return (
      <Tile key={a.id} name={a.name} tip={a.running ? `${a.name} · ${s('tile.running')}\n${a.exe}` : a.exe} route={r} profiles={snap.profiles} running={a.running} onClick={() => {
        if (r) { open(r.id); return }
        const next = appRoute(a, defaultVia)
        void Promise.resolve(patch({ routes: upsert(st, next) })).then(() => open(next.id))
      }}>
        {a.icon ? <img src={a.icon} alt="" /> : <Mono name={a.name} />}
      </Tile>
    )
  }

  if (!catalog) return <RouteList snap={snap} status={status} conns={conns} apps={apps ?? []} patch={patch} open={open} add={() => setCatalog(true)} />

  return (
    <div className="page lib">
      <div className="page-head">
        {st.routes.length > 0 && <Btn kind="ghost" onClick={() => setCatalog(false)} aria-label={s('nav.back')}><Icon n="back" /></Btn>}
        <h1>{s('route.add.title')}</h1>
        <div className="grow" />
        <Btn kind="ghost" onClick={rescan} disabled={loading} title={s('apps.refresh')}><span className={loading ? 'spin' : ''}><Icon n="refresh" /></span></Btn>
        <Btn onClick={pickExe}><Icon n="folder" />{s('apps.add')}</Btn>
        <Btn onClick={() => setPop({ kind: 'new' })}><Icon n="pin" />{s('pick.addr.add')}</Btn>
      </div>
      <div className="toolbar">
        <Field icon="search" placeholder={s('apps.search')} value={q} onChange={e => setQ(e.target.value)} />
        <Seg<Filter> value={f} onChange={setF} items={[
          { v: 'all', label: s('lib.f.all') }, { v: 'run', label: s('lib.f.run'), n: running.length }, { v: 'apps', label: s('lib.apps'), n: installed.length },
          { v: 'services', label: s('lib.services'), n: services.length }, { v: 'custom', label: s('lib.custom'), n: customs.length }]} />
      </div>
      {!apps && <div className="tiles">{Array.from({ length: 18 }, (_, i) => <div key={i} className="tile skel" />)}</div>}
      {show('run') && running.length > 0 && <Section title={s('lib.f.run')} n={running.length}>{running.map(appTile)}</Section>}
      {show('apps') && installed.length > 0 && <Section title={s('lib.apps')} n={installed.length}>{installed.map(appTile)}</Section>}
      {show('services') && services.length > 0 && (
        <Section title={s('lib.services')} n={services.length}>
          {services.map(p => (
            <Tile key={p.id} name={p.name} tip={p.domains.slice(0, 4).join(', ') + '…'} route={routed.get('preset:' + p.id)} profiles={snap.profiles} onClick={() => {
              const current = routed.get('preset:' + p.id)
              if (current) { open(current.id); return }
              const next = presetRoute(p.id, defaultVia)
              void Promise.resolve(patch({ routes: upsert(st, next) })).then(() => open(next.id))
            }}>
              <Brand brand={p.brand} name={p.name} color={p.color} size={40} />
            </Tile>
          ))}
        </Section>
      )}
      {show('custom') && customs.length > 0 && (
        <Section title={s('lib.custom')} n={customs.length}>
          {customs.map(r => <Tile key={r.id} name={r.name} tip={r.value ?? r.name} route={r} profiles={snap.profiles} onClick={() => setPop({ kind: 'route', id: r.id })}><span className="ph-ic"><Icon n="pin" s={20} /></span></Tile>)}
        </Section>
      )}
      {apps && !anyShown && (
        <div className="panel emptyst"><Icon n="search" s={24} /><span>{s('apps.none')}</span>{(q || f !== 'all') && <Btn onClick={() => { setQ(''); setF('all') }}>{s('lib.reset')}</Btn>}</div>
      )}

      {pop && !adding && (
        <Pick title={popTitle} snap={snap} status={status} conns={conns} route={cur} current={cur?.via} initialSource={preferredSource} onSource={setPreferredSource} onPick={v => void choose(v)} onAdd={() => setAdding(true)} onManage={() => { close(); manage() }} onClose={close} blocked={err ?? undefined} toast={toast}
          head={pop.kind === 'new' ? <div className="addrow">
            <Field icon="pin" bad={!!err} autoFocus placeholder={s('sites.input1')} value={addr} onChange={e => { setAddr(e.target.value); setErr(null) }} onKeyDown={e => { if (e.key === 'Enter' && addr.trim()) void choose(defaultVia) }} />
            <Btn kind="primary" disabled={!addr.trim()} onClick={() => void choose(defaultVia)}><Icon n="plus" />{s('pick.addr.create', { v: viaName(snap.profiles, defaultVia) })}</Btn>
          </div> : undefined}
          onRemove={cur ? () => { patch({ routes: dropRoute(st, cur.id) }); close() } : undefined}
          onMore={cur ? () => { open(cur.id); close() } : undefined} />
      )}
      {adding && <AddTunnel onClose={() => setAdding(false)} onAdded={(r: ImportResult) => { toast(importNote(r)); setAdding(false); if (r.id) void choose(r.id); else setPreferredSource('mine') }} onPublic={() => { setAdding(false); setPreferredSource('public') }} />}
    </div>
  )
}

/** the human model: target -> effective path -> state; bytes are tertiary */
function RouteList({ snap, status, conns, apps, patch, open, add }: { snap: Snapshot; status: Status; conns: Conn[]; apps: AppInfo[]; patch: P['patch']; open: (id: string) => void; add: () => void }) {
  const st = snap.settings, live = status.phase === 'on'
  const icon = (r: Route) => apps.find(a => 'app:' + a.id === r.id)?.icon
  return (
    <div className="page lib">
      <div className="page-head">
        <h1>{s('lib.title')}</h1>
        <span className="m">{sp('conn.count', st.routes.length)}</span>
        <div className="grow" />
        <Btn kind="primary" onClick={add}><Icon n="plus" />{s('route.add')}</Btn>
      </div>
      <p className="lead">{s('route.lead')}</p>
      <div className="rlist">
        {st.routes.map(r => {
          const e = status.routes?.[r.id]
          const fb = e?.state === 'fallback' ? e.effective : undefined
          const cs = live ? connsOf(r, conns) : []
          const tr = cs.reduce((a, c) => a + c.down + c.up, 0)
          return (
            <div key={r.id} className={'rrow' + (r.on ? '' : ' off')}>
              <Plain className="rr-t" onClick={() => open(r.id)} aria-label={r.name}>
                <RouteIcon r={r} icon={icon(r)} size={28} />
                <span className="rr-n"><b className="ell">{r.name}</b><small>{kindLabel(r)}</small></span>
              </Plain>
              <Icon n="chev" s={14} />
              <div className="rr-via"><ViaPicker compact profiles={snap.profiles} via={r.via} pings={status.pings} live={live} down={v => v === r.via ? e?.reason === 'path_down' : status.health?.[v] === 'down'} onChange={v => void patch({ routes: patchRoute(st, r.id, { via: v }) })} /></div>
              <span className="rr-st">
                {!r.on ? <span className="m">{s('route.st.off')}</span>
                  : fb ? <Tooltip tip={s('conn.fb.tip', { v: viaName(snap.profiles, fb) })}><span className="warn-t"><Icon n="refresh" s={12} />{s('route.st.fb')}</span></Tooltip>
                  : !live ? <span className="m">{s('route.st.idle')}</span>
                  : r.via === 'direct' ? <span className="m">{s('route.st.direct')}</span>
                  : e?.state === 'retrying' ? <span className="warn-t">{s('route.st.' + e.reason)}</span>
                  : e?.state === 'blocked' ? <span className="err-t">{s('route.st.' + e.reason)}</span>
                  : <span>{s('route.st.ok')}</span>}
                {tr > 0 && <small className="m mono">{fmtBytes(tr)}</small>}
              </span>
              <Toggle on={r.on} onChange={v => void patch({ routes: patchRoute(st, r.id, { on: v }) })} label={r.name} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Section({ title, n, children }: { title: string; n: number; children: React.ReactNode }) {
  return (
    <section className="lib-sec">
      <div className="sec-head"><h2>{title}</h2><span className="m">{sp('lib.count', n)}</span></div>
      <div className="tiles">{children}</div>
    </section>
  )
}
