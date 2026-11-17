import { useEffect, useRef, useState } from 'react'
import type { AppInfo, Conn, Notice, Settings, Snapshot, Status } from '../../shared/types'
import { Btn, fmtDur, fmtSpeed, Icon, Logo, Plain } from './ui/kit'
import { s } from './lib/i18n'
import { api } from './bridge'
import { logoClick } from './eggs'
import { Connections } from './pages/connections'
import { RoutePage } from './pages/route'
import { Library } from './pages/library'
import { addEntry, back, goTo, initialNav, mergeScannedApps, openRoute, showCatalog, showList, type Nav, type Page } from './lib/flow'
import { Servers } from './pages/servers'
import { AddTunnel, importNote } from './pages/addtunnel'
import { Analyzer } from './pages/analyzer'
import { SettingsPage } from './pages/settings'
import { CompanionPick, type Pick } from './pages/companionpick'
import { masterPresentation } from './lib/master'
import type { ToastKind } from './lib/actions'

// W1 IA (GPT 440a5c3): five permanent destinations. Adding a connection is an action inside
// Подключения; live flows are evidence inside Главная / Диагностика, never their own screen.
const RAIL: [Page, string][] = [['home', 'home'], ['lib', 'path'], ['servers', 'plug'], ['an', 'investigate']]

export function App() {
  const [snap, setSnapState] = useState<Snapshot>()
  const [status, setStatus] = useState<Status>()
  const [conns, setConns] = useState<Conn[]>([])
  const [apps, setApps] = useState<AppInfo[]>()
  const [scanning, setScanning] = useState(false)
  const [nav, setNav] = useState<Nav>(initialNav)
  const { page, routeId } = nav
  const [busy, setBusy] = useState(false)
  const [bootError, setBootError] = useState(false)
  const [bootAttempt, setBootAttempt] = useState(0)
  const masterAction = useRef<'opening' | 'closing' | 'recovering' | undefined>(undefined)
  const masterRequest = useRef(0)
  const scanLock = useRef(false)
  const snapshotVersion = useRef(0)
  const statusVersion = useRef(0)
  const [masterPending, setMasterPending] = useState<'opening' | 'closing'>()
  const [toast, setToastState] = useState<{ text: string; kind: ToastKind }>()
  const setToast = (text: string, kind: ToastKind = 'info') => setToastState({ text, kind })
  const [adding, setAdding] = useState(false)
  const [initialClip, setInitialClip] = useState(false)
  const [clipHint, setClipHint] = useState<{ kind: string; host?: string }>()
  const [pick, setPick] = useState<Pick>()
  const lastClip = useRef('')
  const hist = useRef<Record<string, (number | undefined)[]>>({})
  const historyProfiles = useRef<Set<string> | undefined>(undefined)
  const setSnap = (next: Snapshot) => {
    // Recovery can temporarily publish an incomplete startup view. Only an accepted
    // settled snapshot may retire profile history; the direct baseline always stays.
    if (next.status.startup !== 'recovering') {
      const ids = new Set(['direct', ...next.profiles.map(profile => profile.id)])
      historyProfiles.current = ids
      for (const id of Object.keys(hist.current)) if (!ids.has(id)) delete hist.current[id]
    }
    setSnapState(next)
  }
  const [, tick] = useState(0)

  // a failed scan must not leave the library as endless placeholders: show it empty and say why
  const rescan = async () => {
    if (scanLock.current) return
    scanLock.current = true; setScanning(true)
    try { const scanned: AppInfo[] = await api.scanApps(); setApps(current => mergeScannedApps(current, scanned)) }
    catch { setApps(a => a ?? []); setToast(s('lib.scan_failed'), 'error') }
    finally { scanLock.current = false; setScanning(false) }
  }

  useEffect(() => {
    let mounted = true
    setBootError(false)
    const sv = snapshotVersion.current, tv = statusVersion.current
    void api.snapshot().then((x: Snapshot) => {
      if (!mounted) return
      // A snapshot response may arrive after a newer push event. Do not roll back live state.
      if (snapshotVersion.current === sv) setSnap(x)
      if (statusVersion.current === tv) setStatus(x.status)
      if (snapshotVersion.current === sv && !x.profiles.length && localStorage.getItem('waarp-first-scan') !== 'done') setAdding(true)
    }).catch(() => { if (mounted) setBootError(true) })
    void rescan()
    const a = api.onSnapshot((x: Snapshot) => {
      snapshotVersion.current++; statusVersion.current++
      setSnap(x); setStatus(x.status); setBootError(false)
    })
    let lastRound: number | undefined
    const b = api.onStatus((x: Status) => {
      statusVersion.current++
      setStatus(x)
      if (x.phase === 'starting' || x.phase === 'stopping') { hist.current = {}; lastRound = undefined; return }
      if (x.pingRound !== undefined && x.pingRound !== lastRound) {
        lastRound = x.pingRound
        for (const [id, v] of Object.entries(x.pings)) {
          // A queued measurement from a deleted profile must not recreate its history.
          if (historyProfiles.current && !historyProfiles.current.has(id)) continue
          const h = (hist.current[id] ??= [])
          h.push(v); if (h.length > 120) h.shift()
        }
      }
    })
    const c = api.onConns((x: Conn[]) => setConns(x))
    const appsHydrated = api.onApps((x: AppInfo[]) => setApps(current => mergeScannedApps(current, x)))
    const d = api.onToast((x: string) => setToast(x))
    // a companion app asked Waarp (bridge routes.open) to show its route, or to pick a path for its target
    const e = api.onNav((x: { route?: string; pick?: { id?: unknown; name?: unknown } }) => {
      if (typeof x?.route === 'string') { const id = x.route; setNav(n => openRoute(n, id)) }
      else if (x?.pick && typeof x.pick.id === 'string' && typeof x.pick.name === 'string') setPick({ id: x.pick.id, name: x.pick.name })
    })
    return () => { mounted = false; a(); b(); c(); appsHydrated(); d(); e() }
  }, [bootAttempt])

  // The elapsed-time label needs a clock only while the tunnel is on. Keeping this timer alive
  // while idle rerendered the complete application every second for no visible change.
  useEffect(() => {
    if (status?.phase !== 'on') return
    const t = setInterval(() => tick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [status?.phase])

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToastState(undefined), 5000); return () => clearTimeout(t) }, [toast])

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

  if (!snap || !status) return <div className="boot"><div className="boot-content" role="status"><Logo s={28} />{bootError && <><p>{s('app.load.error')}</p><Btn onClick={() => setBootAttempt(n => n + 1)}><Icon n="refresh" />{s('app.load.retry')}</Btn></>}</div></div>

  const patch = async (p: Partial<Settings>): Promise<boolean> => {
    const sv = snapshotVersion.current, tv = statusVersion.current
    try {
      const next: Snapshot & { saved?: boolean } = await api.settings(p, snap.settings)
      if (snapshotVersion.current === sv) setSnap(next)
      if (statusVersion.current === tv) setStatus(next.status)
      return next.saved !== false
    } catch { setToast(s('set.save.error'), 'error'); return false }
  }
  const go = (p: Page) => setNav(n => goTo(n, p))
  const open = (id: string) => setNav(n => openRoute(n, id))
  const addApp = (a: AppInfo) => setApps(l => [a, ...(l ?? []).filter(x => x.id !== a.id)])
  const reconcileMaster = async (request: number) => {
    if (request !== masterRequest.current) return
    try {
      const sv = snapshotVersion.current, tv = statusVersion.current
      const fresh: Snapshot = await api.snapshot()
      if (request !== masterRequest.current) return
      if (snapshotVersion.current === sv) setSnap(fresh)
      if (statusVersion.current === tv) setStatus(fresh.status)
    } catch { if (request === masterRequest.current) setToast(s('top.state.error'), 'error') }
    finally {
      if (request === masterRequest.current) {
        masterAction.current = undefined
        setMasterPending(undefined)
        setBusy(false)
      }
    }
  }
  const toggle = async () => {
    const cancelOpening = masterAction.current === 'opening'
    if (masterAction.current && !cancelOpening) return
    const request = ++masterRequest.current
    const closing = cancelOpening || status.open === true || status.phase === 'on' || status.phase === 'starting'
    masterAction.current = closing ? 'closing' : 'opening'
    setMasterPending(closing ? 'closing' : 'opening')
    // OFF remains available while ON is waiting on Windows recovery or engine readiness.
    // An explicit disconnect also cancels before the main-process ON event reaches this renderer.
    setBusy(closing)
    try {
      const r = await (closing ? api.disconnect() : api.toggle())
      // The event stream is the fast path, but a failed native startup may stop and
      // exit in the same turn. Reconcile from the authoritative main-process state
      // so the switch can never remain visually open after the engine has failed.
      if (request === masterRequest.current && !r.ok && r.error) setToast(r.error, 'error')
    } catch { if (request === masterRequest.current) setToast(s('top.toggle.error'), 'error') }
    finally { await reconcileMaster(request) }
  }
  const recover = async () => {
    if (masterAction.current) return
    const request = ++masterRequest.current
    masterAction.current = 'recovering'
    setBusy(true)
    try {
      const r = await api.resetNet()
      if (request === masterRequest.current) setToast(r?.ok ? s('home.recovery.done') : r?.error ?? s('set.reset.error'), r?.ok ? 'success' : 'error')
    } catch { if (request === masterRequest.current) setToast(s('set.reset.error'), 'error') }
    finally { await reconcileMaster(request) }
  }
  // Renderer-only pending phase: acknowledge the click immediately without pretending the
  // main process has already changed its authoritative engine state.
  const controlStatus: Status = masterPending
    ? { ...status, open: false, phase: masterPending === 'opening' ? 'starting' : 'stopping' }
    : status
  const master = masterPresentation(status, masterPending)
  const engineOn = status.phase === 'on'
  const demandsTunnel = snap.settings.rest !== 'direct' || snap.settings.routes.some(r => r.on && r.via !== 'direct')
  // "Nothing to open" may disable OPEN, but must never disable OFF for an already-open master.
  const masterUnavailable = !master.pressed && !snap.profiles.length && !demandsTunnel
  const hasRouting = snap.profiles.length > 0 || snap.settings.routes.length > 0 || snap.settings.rest !== 'direct'
  const railOn = page === 'route' ? nav.from : page

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-logo" onClick={logoClick}><Logo s={20} open={master.pressed} /></div>
        {RAIL.map(([k, ic]) => (
          <Plain key={k} className={'rb' + (railOn === k ? ' on' : '')} onClick={() => go(k)} aria-label={s('nav.' + k)} tip={s('nav.' + k)} tipSide="right">
            <Icon n={ic} s={20} />
          </Plain>
        ))}
        <div className="grow" />
        <Plain className={'rb' + (page === 'settings' ? ' on' : '')} onClick={() => go('settings')} aria-label={s('nav.settings')} tip={s('nav.settings')} tipSide="right"><Icon n="settings" s={20} /></Plain>
      </aside>

      <header className="top">
        <Plain className="master" onClick={() => void toggle()} disabled={masterUnavailable || busy}
          aria-label={s('top.master')} aria-pressed={master.pressed}>
          <span className={'tg' + (master.pressed ? ' on' : '')} aria-hidden><i /></span>
          <b>{s(master.topKey)}</b>
          {engineOn && status.since && <span className="mono m">{fmtDur(Date.now() - status.since)}</span>}
        </Plain>
        {engineOn && <div className="top-speed mono"><Icon n="down" s={14} />{fmtSpeed(status.down)}<Icon n="up" s={14} />{fmtSpeed(status.up)}</div>}
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
        {page === 'home' && hasRouting && <Connections snap={snap} status={controlStatus} conns={conns} apps={apps ?? []} patch={patch} toast={setToast} toggle={toggle} recover={recover} busy={busy} open={open} add={() => setNav(addEntry)} />}
          {page === 'route' && routeId && <RoutePage key={routeId} snap={snap} status={status} conns={conns} apps={apps ?? []} id={routeId} patch={patch} toast={setToast} back={() => setNav(back)} />}
          {page === 'lib' && <Library snap={snap} status={status} conns={conns} apps={apps} loading={scanning} rescan={rescan} addApp={addApp} patch={patch} toast={setToast} open={open} mode={nav.libMode} setMode={m => setNav(m === 'catalog' ? showCatalog : showList)} />}
          {page === 'servers' && <Servers snap={snap} status={status} patch={patch} toast={setToast} />}
          {page === 'an' && <Analyzer snap={snap} status={status} hist={hist.current} />}
          {page === 'settings' && <SettingsPage snap={snap} patch={patch} toast={setToast} />}
      </main>
      {adding && <AddTunnel initialClip={initialClip} onDiscoveryDone={() => localStorage.setItem('waarp-first-scan', 'done')} onClose={() => { setAdding(false); setInitialClip(false) }} onAdded={r => { setToast(importNote(r)); if (!r.clientPublicKey) { setAdding(false); setInitialClip(false); setNav(n => snap.settings.routes.length ? goTo(n, 'lib') : addEntry(n)) } }}
        onPublic={() => { setAdding(false); setInitialClip(false); go('servers'); requestAnimationFrame(() => document.getElementById('public-catalog')?.scrollIntoView({ behavior: 'smooth' })) }} />}
      {clipHint && !adding && <div className="clip-hint" role="status"><span>{s('clip.found', { v: clipHint.host ?? s('add.clip.' + clipHint.kind) })}</span><Btn kind="primary" onClick={() => { setClipHint(undefined); setInitialClip(true); setAdding(true) }}>{s('imp.add')}</Btn><Plain aria-label={s('nav.close')} onClick={() => setClipHint(undefined)}><Icon n="x" s={14} /></Plain></div>}
      {pick && <CompanionPick snap={snap} pick={pick} toast={setToast} done={id => { setPick(undefined); if (id) open(id) }} manage={() => go('servers')} />}
      {toast && <div className={'toast ' + toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'}><Icon n={toast.kind === 'error' ? 'warn' : toast.kind === 'success' ? 'check' : 'info'} />{toast.text}</div>}
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
