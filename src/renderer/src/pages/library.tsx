// Маршруты (W1, GPT 440a5c3; target-first IA): the library has two explicit modes. The catalog ("+") is target acquisition
// (running apps first, then installed apps, services, one address); the list is the summary "target -> where it goes".
// Choosing a target never picks a path: a new target becomes a neutral draft and opens its own route page.
import { useMemo, useState } from 'react'
import type { AppInfo, Conn, Route, Settings, Snapshot, Status } from '../../../shared/types'
import { PRESETS } from '../../../shared/presets'
import { Btn, Field, fmtBytes, Icon, Plain, Seg, Toggle, Tooltip } from '../ui/kit'
import { Modal } from '../ui/modal'
import { s, sp } from '../lib/i18n'
import { api } from '../bridge'
import { connsOf, HUES, patchRoute, upsert } from '../lib/routes'
import { acquire, isDraft, normAddr, type LibMode, type Target } from '../lib/flow'
import { routeStateKey } from '../lib/route-state'
import { kindLabel, Mark, RouteIcon, viaName, ViaPicker } from '../parts'
import { Brand } from '../ui/brand'

type Filter = 'all' | 'run' | 'apps' | 'services' | 'custom'

interface P {
  snap: Snapshot; status: Status; conns: Conn[]; apps?: AppInfo[]; loading: boolean
  rescan: () => void; addApp: (a: AppInfo) => void
  patch: (p: Partial<Settings>) => void | Promise<void>; open: (id: string) => void; mode: LibMode; setMode: (m: LibMode) => void
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
    <Plain className={'tile' + (route && !isDraft(route) ? ' on' : '')} onClick={onClick} tip={tip}>
      <Well>{children}{running && <i className="run" />}</Well>
      <span className="t-n">{name}</span>
      {route && !isDraft(route) && <span className="t-via"><Icon n="check" s={12} /><Mark profiles={profiles} via={route.via} /></span>}
    </Plain>
  )
}

export function Library({ snap, status, conns, apps, loading, rescan, addApp, patch, open, mode, setMode }: P) {
  const [q, setQ] = useState('')
  const [f, setF] = useState<Filter>('all')
  const [askAddr, setAskAddr] = useState(false)
  const [addr, setAddr] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const st = snap.settings
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

  // target first: an existing target opens as it is; a new one is saved as a neutral draft (off, no path chosen) and its page opens.
  const take = async (t: Target) => {
    const { route, created } = acquire(st, t)
    if (created) await patch({ routes: upsert(st, route) })
    open(route.id)
  }
  const pickExe = async () => {
    const a: AppInfo | null = await api.pickApp()
    if (!a) return
    addApp(a)
    await take({ kind: 'app', app: a })
  }
  const closeAddr = () => { setAskAddr(false); setAddr(''); setErr(null) }
  const createAddr = async () => {
    const x = normAddr(addr)
    const e = x ? await api.validate(x) : s('pick.addr.empty')
    if (e) { setErr(e); return }
    closeAddr()
    await take({ kind: 'custom', value: x })
  }
  const anyShown = (show('run') && running.length) || (show('apps') && installed.length) || (show('services') && services.length) || (show('custom') && customs.length)

  const appTile = (a: AppInfo) => {
    const r = routed.get('app:' + a.id)
    return (
      <Tile key={a.id} name={a.name} tip={a.running ? `${a.name} · ${s('tile.running')}\n${a.exe}` : a.exe} route={r} profiles={snap.profiles} running={a.running} onClick={() => void take({ kind: 'app', app: a })}>
        {a.icon ? <img src={a.icon} alt="" /> : <Mono name={a.name} />}
      </Tile>
    )
  }

  if (mode === 'list') return <RouteList snap={snap} status={status} conns={conns} apps={apps ?? []} patch={patch} open={open} add={() => setMode('catalog')} />

  return (
    <div className="page lib">
      <div className="page-head">
        <Btn kind="ghost" onClick={() => setMode('list')} aria-label={s('nav.back')}><Icon n="back" /></Btn>
        <h1>{s('route.add.title')}</h1>
        <div className="grow" />
        <Btn kind="ghost" onClick={rescan} disabled={loading} title={s('apps.refresh')}><span className={loading ? 'spin' : ''}><Icon n="refresh" /></span></Btn>
        <Btn onClick={pickExe}><Icon n="folder" />{s('apps.add')}</Btn>
        <Btn onClick={() => setAskAddr(true)}><Icon n="pin" />{s('pick.addr.add')}</Btn>
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
            <Tile key={p.id} name={p.name} tip={p.domains.slice(0, 4).join(', ') + '…'} route={routed.get('preset:' + p.id)} profiles={snap.profiles} onClick={() => void take({ kind: 'preset', id: p.id })}>
              <Brand brand={p.brand} name={p.name} color={p.color} size={40} />
            </Tile>
          ))}
        </Section>
      )}
      {show('custom') && customs.length > 0 && (
        <Section title={s('lib.custom')} n={customs.length}>
          {customs.map(r => <Tile key={r.id} name={r.name} tip={r.value ?? r.name} route={r} profiles={snap.profiles} onClick={() => open(r.id)}><span className="ph-ic"><Icon n="pin" s={20} /></span></Tile>)}
        </Section>
      )}
      {apps && !anyShown && (
        <div className="panel emptyst"><Icon n="search" s={24} /><span>{s('apps.none')}</span>{(q || f !== 'all') && <Btn onClick={() => { setQ(''); setF('all') }}>{s('lib.reset')}</Btn>}</div>
      )}

      {askAddr && (
        <Modal title={s('pick.addr.title')} onClose={closeAddr}>
          <div className="wz-body">
            <div className="addrow">
              <Field icon="pin" bad={!!err} autoFocus placeholder={s('sites.input1')} value={addr} onChange={e => { setAddr(e.target.value); setErr(null) }} onKeyDown={e => { if (e.key === 'Enter' && addr.trim()) void createAddr() }} />
              <Btn kind="primary" disabled={!addr.trim()} onClick={() => void createAddr()}><Icon n="plus" />{s('pick.addr.go')}</Btn>
            </div>
            {err && <div className="ferr">{err}</div>}
          </div>
        </Modal>
      )}
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
                {!r.on ? <span className="m">{s(routeStateKey(r, status, e, isDraft(r)))}</span>
                  : fb ? <Tooltip tip={s('conn.fb.tip', { v: viaName(snap.profiles, fb) })}><span className="warn-t"><Icon n="refresh" s={12} />{s('route.st.fb')}</span></Tooltip>
                  : e?.state === 'retrying' ? <span className="warn-t">{s(routeStateKey(r, status, e))}</span>
                  : e?.state === 'blocked' ? <span className="err-t">{s(routeStateKey(r, status, e))}</span>
                  : <span className={routeStateKey(r, status, e) === 'route.st.ok' ? '' : 'm'}>{s(routeStateKey(r, status, e))}</span>}
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
