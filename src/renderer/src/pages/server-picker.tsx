import { useEffect, useState } from 'react'
import type { ProfileView, Route, Snapshot, Status, Via } from '../../../shared/types'
import { AUTO_ID, AUTO_LIVE_MAX, autoMembers } from '../../../shared/groups'
import { safeVia } from '../../../shared/companion'
import { Btn, Field, Icon, Plain, Seg } from '../ui/kit'
import { Pagination } from '../ui/pagination'
import { AutoHint, Mark, Ping, subOf, viaName } from '../parts'
import { s } from '../lib/i18n'
import { PublicCatalog } from './publiccat'

const PAGE_SIZE = 10
type Mode = 'auto' | 'manual' | 'direct'
const initialMode = (route: Route): Mode => route.via === AUTO_ID ? 'auto' : route.via === 'direct' && route.on ? 'direct' : 'manual'

/** One destination after picking an app: choose how, then choose a server. */
export function ServerPicker({ snap, status, route, applying, disabled, onSelect, onBusyChange, toast }: {
  snap: Snapshot; status: Status; route: Route; applying?: Via; disabled: boolean
  onSelect: (via: Via) => Promise<void>; onBusyChange: (busy: boolean) => void; toast: (text: string) => void
}) {
  const [mode, setMode] = useState<Mode>(() => initialMode(route))
  const [source, setSource] = useState<'saved' | 'public'>(snap.profiles.some(p => !p.revoked) ? 'saved' : 'public')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const ownIds = autoMembers(snap.profiles)
  const canAuto = ownIds.length > 0 && (route.owner !== 'companion' || safeVia(AUTO_ID, snap.settings, snap.profiles))
  const isCompanion = route.owner === 'companion'
  const saved = snap.profiles.filter(profile => !profile.revoked && profile.id !== AUTO_ID && (!isCompanion || safeVia(profile.id, snap.settings, snap.profiles)))
  const term = query.trim().toLocaleLowerCase()
  const matches = saved.filter(profile => !term || `${profile.name} ${subOf(profile)}`.toLocaleLowerCase().includes(term))
  const sorted = [...matches.filter(profile => profile.id === route.via), ...matches.filter(profile => profile.id !== route.via)]
  const currentPage = Math.min(page, Math.max(1, Math.ceil(sorted.length / PAGE_SIZE)))
  const visible = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const live = status.phase === 'on'
  useEffect(() => {
    setMode(initialMode(route)); setQuery(''); setPage(1)
  }, [route.id])
  const chooseMode = (next: Mode) => {
    setMode(next); setPage(1)
    if (next === 'auto' && canAuto && (route.via !== AUTO_ID || !route.on)) void onSelect(AUTO_ID)
    if (next === 'direct' && (route.via !== 'direct' || !route.on)) void onSelect('direct')
  }
  const select = async (id: Via) => { await onSelect(id) }
  const health = (profile: ProfileView) => {
    const measured = status.pings[profile.id]
    if (measured !== undefined || live && status.health?.[profile.id] === 'down') return <Ping ms={measured} live down={status.health?.[profile.id] === 'down'} />
    return <span className="m">{s(live && status.health?.[profile.id] === 'unknown' ? 'ping.check' : live ? 'srv.ping.unused' : 'srv.ping.closed')}</span>
  }

  return <section className="server-picker" aria-label={s('server.title')}>
    <aside className="server-picker-modes">
      <span className="lbl">{s('server.title')}</span>
      <Plain className={'server-mode' + (mode === 'auto' ? ' on' : '')} aria-pressed={mode === 'auto'} disabled={disabled} onClick={() => chooseMode('auto')}>
        <span className="radio" /><span><b>{s('server.mode.auto')}</b><small>{s('server.mode.auto.hint')}</small></span>{route.on && route.via === AUTO_ID && <Icon n="check" s={14} />}
      </Plain>
      <Plain className={'server-mode' + (mode === 'manual' ? ' on' : '')} aria-pressed={mode === 'manual'} disabled={disabled} onClick={() => chooseMode('manual')}>
        <span className="radio" /><span><b>{s('server.mode.manual')}</b><small>{s('server.mode.manual.hint')}</small></span>{route.on && !['direct', AUTO_ID].includes(route.via) && <Icon n="check" s={14} />}
      </Plain>
      <Plain className={'server-mode direct' + (mode === 'direct' ? ' on' : '')} aria-pressed={mode === 'direct'} disabled={disabled} onClick={() => chooseMode('direct')}>
        <span className="radio" /><span><b>{s('via.direct')}</b><small>{s('server.mode.direct.hint')}</small></span>{route.on && route.via === 'direct' && <Icon n="check" s={14} />}
      </Plain>
    </aside>
    <div className="server-picker-content">
      {mode === 'auto' && <div className="server-mode-content">
        <div className="server-mode-intro"><span className="wz-ic"><Icon n="bolt" s={24} /></span><div><h3>{s('server.auto.title')}</h3><p className="hint">{s(canAuto ? 'server.auto.note' : 'server.auto.empty')}</p></div></div>
        {canAuto && <>
          <div className="server-auto-members">
            {saved.filter(profile => ownIds.includes(profile.id)).slice((Math.min(page, Math.max(1, Math.ceil(ownIds.length / PAGE_SIZE))) - 1) * PAGE_SIZE, Math.min(page, Math.max(1, Math.ceil(ownIds.length / PAGE_SIZE))) * PAGE_SIZE).map(profile => <div className="server-auto-member" key={profile.id}>
              <Mark profiles={snap.profiles} via={profile.id} /><span className="ell" title={profile.name}>{profile.name}</span><span>{health(profile)}</span>
            </div>)}
          </div>
          <Pagination page={page} total={ownIds.length} pageSize={PAGE_SIZE} onChange={setPage} />
          {ownIds.length > AUTO_LIVE_MAX && <span className="hint"><AutoHint profiles={snap.profiles} bare /></span>}
          <Btn kind={route.via === AUTO_ID && route.on ? 'ghost' : 'primary'} disabled={disabled || route.via === AUTO_ID && route.on} onClick={() => void select(AUTO_ID)}><Icon n="check" />{s(applying === AUTO_ID ? 'server.applying' : route.via === AUTO_ID && route.on ? 'server.current' : 'server.auto.use')}</Btn>
        </>}
        {!canAuto && !isCompanion && <Btn onClick={() => { setMode('manual'); setSource('public') }}><Icon n="globe" />{s('server.public')}</Btn>}
      </div>}
      {mode === 'direct' && <div className="server-mode-content">
        <div className="server-mode-intro"><span className="wz-ic"><Icon n="path" s={24} /></span><div><h3>{s('server.direct.title')}</h3><p className="hint">{s('server.direct.note')}</p></div></div>
        <Btn kind={route.via === 'direct' && route.on ? 'ghost' : 'primary'} disabled={disabled || route.via === 'direct' && route.on} onClick={() => void select('direct')}><Icon n="check" />{s(applying === 'direct' ? 'server.applying' : route.via === 'direct' && route.on ? 'server.current' : 'server.direct.use')}</Btn>
      </div>}
      {mode === 'manual' && <>
        <div className="server-source-tabs">
          <Seg value={isCompanion ? 'saved' : source} items={[{ v: 'saved', label: s('server.saved'), n: saved.length }, ...(!isCompanion ? [{ v: 'public' as const, label: s('server.public') }] : [])]} onChange={setSource} />
          {!applying && route.on && route.via !== 'direct' && route.via !== AUTO_ID && <span className="server-current ell" title={viaName(snap.profiles, route.via)}><Icon n="check" s={13} />{viaName(snap.profiles, route.via)}</span>}
        </div>
        {(source === 'saved' || isCompanion) ? <>
          <Field icon="search" type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} placeholder={s('server.search')} aria-label={s('server.search')} />
          {!visible.length ? <div className="server-list-empty"><p>{s(saved.length ? 'route.picker.notfound' : 'server.saved.empty')}</p>{!saved.length && !isCompanion && <Btn onClick={() => setSource('public')}><Icon n="globe" />{s('server.public')}</Btn>}</div> :
            <div className="server-list saved-server-list">
              <div className="server-list-head"><span /><span>{s('pick.name')}</span><span>{s('pick.ping')}</span><span /></div>
              {visible.map(profile => {
                const selected = route.on && route.via === profile.id
                return <div className={'server-row' + (selected ? ' on' : '') + (applying === profile.id ? ' applying' : '')} key={profile.id}>
                  <Mark profiles={snap.profiles} via={profile.id} />
                  <div className="server-row-name"><b className="ell" title={profile.name}>{profile.name}</b><span className="m ell" title={subOf(profile)}>{subOf(profile)}</span></div>
                  <div className="server-row-health">{health(profile)}</div>
                  <Btn className="server-row-action" kind={selected ? 'ghost' : 'default'} sm disabled={disabled || selected} aria-busy={applying === profile.id} onClick={() => void select(profile.id)}>{selected && <Icon n="check" s={14} />}{s(applying === profile.id ? 'server.applying' : selected ? 'server.current' : 'pick.use')}</Btn>
                </div>
              })}
            </div>}
          <Pagination page={currentPage} total={sorted.length} pageSize={PAGE_SIZE} onChange={setPage} />
        </> : <PublicCatalog compact toast={toast} onBusyChange={onBusyChange} disabled={disabled} selectedId={route.on ? route.via : undefined} used={id => snap.profiles.some(profile => profile.id === id)} onAdded={id => void select(id)} />}
      </>}
    </div>
  </section>
}
