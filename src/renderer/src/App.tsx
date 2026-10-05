import { useEffect, useRef, useState } from 'react'
import type { AppInfo, Conn, Notice, Settings, Snapshot, Status } from '../../shared/types'
import { Btn, fmtDur, fmtSpeed, Icon, Logo, Plain } from './ui/kit'
import { s } from './lib/i18n'
import { api } from './bridge'
import { logoClick } from './eggs'
import { Connections } from './pages/connections'
import { RoutePage } from './pages/route'
import { Library } from './pages/library'
import type { Source } from './pages/library'
import { Servers } from './pages/servers'
import { AddTunnel, importNote } from './pages/addtunnel'
import { Analyzer } from './pages/analyzer'
import { SettingsPage } from './pages/settings'
import { CompanionPick, type Pick } from './pages/companionpick'

type Page = 'home' | 'lib' | 'servers' | 'an' | 'settings' | 'route'

// W1 IA (GPT 440a5c3): five permanent destinations. Adding a connection is an action inside
// Подключения; live flows are evidence inside Главная / Диагностика, never their own screen.
const RAIL: [Page, string][] = [['home', 'home'], ['lib', 'path'], ['servers', 'plug'], ['an', 'investigate']]

export function App() {
  const [snap, setSnap] = useState<Snapshot>()
  const [status, setStatus] = useState<Status>()
  const [conns, setConns] = useState<Conn[]>([])
  const [apps, setApps] = useState<AppInfo[]>()
  const [scanning, setScanning] = useState(false)
  const [page, setPage] = useState<Page>('home')
  const [routeId, setRouteId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [autoFind, setAutoFind] = useState(false)
  const [initialClip, setInitialClip] = useState(false)
  const [clipHint, setClipHint] = useState<{ kind: string; host?: string }>()
  const [librarySource, setLibrarySource] = useState<Source>('mine')
  const [pick, setPick] = useState<Pick>()
  const lastClip = useRef('')
  const hist = useRef<Record<string, (number | undefined)[]>>({})
  const [, tick] = useState(0)

  // a failed scan must not leave the library as endless placeholders: show it empty and say why
  const rescan = async () => { setScanning(true); try { setApps(await api.scanApps()) } catch { setApps(a => a ?? []); setToast(s('lib.scan_failed')) } finally { setScanning(false) } }

  useEffect(() => {
    void api.snapshot().then((x: Snapshot) => {
      setSnap(x); setStatus(x.status)
      if (!x.profiles.length && localStorage.getItem('waarp-first-scan') !== 'done') {
        // Offer discovery on first launch, but do not inspect local folders before the user
        // explicitly chooses the search action in the add dialog.
        setAdding(true)
      }
    })
    void rescan()
    const a = api.onSnapshot((x: Snapshot) => { setSnap(x); setStatus(x.status) })
    let lastPing: Status['pings'] | undefined
    const b = api.onStatus((x: Status) => {
      setStatus(x)
      if (x.phase === 'starting' || x.phase === 'stopping') { hist.current = {}; lastPing = undefined; return }
      if (x.pings !== lastPing) {
        lastPing = x.pings
        for (const [id, v] of Object.entries(x.pings)) {
          const h = (hist.current[id] ??= [])
          h.push(v); if (h.length > 120) h.shift()
        }
      }
    })
    const c = api.onConns((x: Conn[]) => setConns(x))
    const d = api.onToast((x: string) => setToast(x))
    // a companion app asked Waarp (bridge routes.open) to show its route, or to pick a path for its target
    const e = api.onNav((x: { route?: string; pick?: { id?: unknown; name?: unknown } }) => {
      if (typeof x?.route === 'string') { setRouteId(x.route); setPage('route') }
      else if (x?.pick && typeof x.pick.id === 'string' && typeof x.pick.name === 'string') setPick({ id: x.pick.id, name: x.pick.name })
    })
    return () => { a(); b(); c(); d(); e() }
  }, [])

  // The elapsed-time label needs a clock only while the tunnel is on. Keeping this timer alive
  // while idle rerendered the complete application every second for no visible change.
  useEffect(() => {
    if (status?.phase !== 'on') return
    const t = setInterval(() => tick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [status?.phase])

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(undefined), 5000); return () => clearTimeout(t) }, [toast])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const focus = () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        if (document.querySelector('[role="dialog"]')) return
        try {
          const peek = await api.clipPeek()
          if (peek.kind === 'none') { setClipHint(undefined); return }
          const key = peek.fingerprint ?? [peek.kind, peek.host, peek.name, peek.count].join('|')
          if (lastClip.current !== key) { lastClip.current = key; setClipHint({ kind: peek.kind, host: peek.host }) }
        } catch { /* clipboard is optional */ }
      }, 300)
    }
    window.addEventListener('focus', focus)
    return () => { window.removeEventListener('focus', focus); clearTimeout(timer) }
  }, [])

  if (!snap || !status) return <div className="boot"><Logo s={28} /></div>

  const patch = async (p: Partial<Settings>) => {
    try { setSnap(await api.settings(p)) }
    catch { setToast(s('set.save.error')) }
  }
  const go = (p: Page) => { setPage(p); setRouteId(undefined) }
  const open = (id: string) => { setRouteId(id); setPage('route') }
  const addApp = (a: AppInfo) => setApps(l => [a, ...(l ?? []).filter(x => x.id !== a.id)])
  const toggle = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.toggle()
      // The event stream is the fast path, but a failed native startup may stop and
      // exit in the same turn. Reconcile from the authoritative main-process state
      // so the switch can never remain visually open after the engine has failed.
      const fresh = await api.snapshot()
      setSnap(fresh)
      setStatus(fresh.status)
      if (!r.ok && r.error) setToast(r.error)
    } finally { setBusy(false) }
  }
  const on = status.phase === 'on'
  const hasRouting = snap.profiles.length > 0 || snap.settings.routes.length > 0 || snap.settings.rest !== 'direct'
  const demandsTunnel = snap.settings.rest !== 'direct' || snap.settings.routes.some(r => r.on && r.via !== 'direct')
  const railOn = page === 'route' ? 'home' : page

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-logo" onClick={logoClick}><Logo s={20} open={on} /></div>
        {RAIL.map(([k, ic]) => (
          <Plain key={k} className={'rb' + (railOn === k ? ' on' : '')} onClick={() => go(k)} aria-label={s('nav.' + k)} tip={s('nav.' + k)} tipSide="right">
            <Icon n={ic} s={20} />
          </Plain>
        ))}
        <div className="grow" />
        <Plain className={'rb' + (page === 'settings' ? ' on' : '')} onClick={() => go('settings')} aria-label={s('nav.settings')} tip={s('nav.settings')} tipSide="right"><Icon n="settings" s={20} /></Plain>
      </aside>

      <header className="top">
        <Plain className="master" onClick={() => void toggle()} disabled={!snap.profiles.length && !demandsTunnel}
          aria-label={s('top.master')} aria-pressed={on || status.phase === 'starting'}>
          <span className={'tg' + (on || status.phase === 'starting' ? ' on' : '')} aria-hidden><i /></span>
          <b>{s(on ? 'top.on' : status.phase === 'starting' ? 'top.starting' : 'top.off')}</b>
          {on && status.since && <span className="mono m">{fmtDur(Date.now() - status.since)}</span>}
        </Plain>
        {on && <div className="top-speed mono"><Icon n="down" s={14} />{fmtSpeed(status.down)}<Icon n="up" s={14} />{fmtSpeed(status.up)}</div>}
        <div className="grow drag" />
        <div className="wbtn">
          <Plain aria-label={s('win.min')} onClick={() => api.win('min')}><Icon n="min" s={14} /></Plain>
          <Plain aria-label={s('win.max')} onClick={() => api.win('max')}><Icon n="max" s={12} /></Plain>
          <Plain aria-label={s('win.close')} className="close" onClick={() => api.win('close')}><Icon n="x" s={14} /></Plain>
        </div>
      </header>

      <main className="main">
        <Notices list={snap.notices} admin={snap.admin} />
        {page === 'home' && !hasRouting && <Welcome onAdd={() => setAdding(true)} />}
        {page === 'home' && hasRouting && <Connections snap={snap} status={status} conns={conns} apps={apps ?? []} patch={patch} toggle={toggle} open={open} add={() => go('lib')} />}
          {page === 'route' && routeId && <RoutePage snap={snap} status={status} conns={conns} apps={apps ?? []} id={routeId} patch={patch} toast={setToast} back={() => go('home')} />}
          {page === 'lib' && <Library snap={snap} status={status} conns={conns} apps={apps} loading={scanning} rescan={rescan} addApp={addApp} patch={patch} open={open} manage={() => go('servers')} toast={setToast} initialSource={librarySource} />}
          {page === 'servers' && <Servers snap={snap} status={status} patch={patch} toast={setToast} />}
          {page === 'an' && <Analyzer snap={snap} status={status} hist={hist.current} patch={patch} />}
          {page === 'settings' && <SettingsPage snap={snap} patch={patch} toast={setToast} />}
      </main>
      {adding && <AddTunnel autoFind={autoFind} initialClip={initialClip} onAutoFindDone={() => localStorage.setItem('waarp-first-scan', 'done')} onClose={() => { setAdding(false); setAutoFind(false); setInitialClip(false) }} onAdded={r => { setToast(importNote(r)); if (!r.clientPublicKey) { setAdding(false); setAutoFind(false); setInitialClip(false); setLibrarySource('mine'); go('lib') } }}
        onPublic={() => { setAdding(false); setAutoFind(false); setInitialClip(false); setLibrarySource('public'); go('lib') }} />}
      {clipHint && !adding && <div className="clip-hint" role="status"><span>{s('clip.found', { v: clipHint.host ?? s('add.clip.' + clipHint.kind) })}</span><Btn kind="primary" onClick={() => { setClipHint(undefined); setInitialClip(true); setAdding(true) }}>{s('imp.add')}</Btn><Plain aria-label={s('nav.close')} onClick={() => setClipHint(undefined)}><Icon n="x" s={14} /></Plain></div>}
      {pick && <CompanionPick snap={snap} pick={pick} toast={setToast} done={id => { setPick(undefined); if (id) open(id) }} manage={() => go('servers')} />}
      {toast && <div className="toast" role="status"><Icon n={/не удал|ошиб|не вышл|нельзя|не найд|занят|не подход/i.test(toast) ? 'warn' : 'check'} />{toast}</div>}
    </div>
  )
}

function Notices({ list, admin }: { list: Notice[]; admin: boolean }) {
  const shown = list.filter(n => n.level !== 'info')
  if (!shown.length) return null
  return (
    <div className="notices">
      {shown.map((n, i) => n.level === 'warn' ? (
        <details key={i} className="notice warn compact">
          <summary><Icon n="warn" s={16} /><b>{n.title}</b><Icon n="chev" s={14} /></summary>
          <p>{n.text}</p>
        </details>
      ) : (
        <div key={i} className="notice block">
          <Icon n="warn" s={16} />
          <div className="grow"><b>{n.title}</b><p>{n.text}</p></div>
          {!admin && n.action === 'relaunch-admin' && <Plain className="btn sm primary" onClick={() => api.relaunchAdmin()}>{s('notice.relaunch')}</Plain>}
        </div>
      ))}
    </div>
  )
}

function Welcome({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="page welcome">
      <div className="w-head">
        <Logo s={40} open />
        <h1>{s('wel.title')}</h1>
        <p>{s('wel.text')}</p>
      </div>
      <ol className="steps">
        {[1, 2, 3].map(i => <li key={i}><b>{s(`wel.${i}.b`)}</b>{` ${s(`wel.${i}`)}`}</li>)}
      </ol>
      <div><Btn kind="primary" onClick={onAdd}><Icon n="plus" />{s('srv.add')}</Btn></div>
    </div>
  )
}
