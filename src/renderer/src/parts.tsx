import { useEffect, useRef, useState } from 'react'
import type { ProfileView, Route, Status, Via } from '../../shared/types'
import { PRESETS } from '../../shared/presets'
import { fmtDur, Icon, Plain, Tooltip } from './ui/kit'
import { Brand } from './ui/brand'
import { s } from './lib/i18n'
import { AUTO_ID, AUTO_LIVE_MAX, autoMembers } from '../../shared/groups'
import { hueOf } from './lib/routes'
import { Cat, Eggs, isNight, isWinter, useEggs } from './eggs'
import { orbPresentation } from './lib/master'

export function Orb({ status, disabled, why, onClick }: { status: Status; disabled: boolean; why?: string; onClick: () => void }) {
  const view = orbPresentation(status)
  // closed and can't open: say why right under the button, never "press to open"
  const locked = disabled && status.open !== true && status.phase === 'off' && !!why
  const title = locked ? s('orb.locked') : s(view.titleKey)
  const live = status.phase === 'on'
  const since = live && status.since ? fmtDur(Date.now() - status.since) : ''
  const { egg, k } = useEggs(live)
  const sub = locked ? why
    : status.phase === 'error' ? status.error ?? (view.subKey ? s(view.subKey) : '')
    : view.subKey ? s(view.subKey)
    : live ? status.error ?? since
    : ''
  return (
    <div className={`orb-wrap ph-${view.phaseClass}${isWinter() ? ' winter' : ''}`}>
      <Plain className="orb" disabled={disabled && status.phase === 'off'} onClick={onClick} aria-label={title}>
        <svg viewBox="0 0 200 200" className="ring">{/* icon-ok: orb progress ring */}
          <circle cx="100" cy="100" r="92" className="track" />
          <circle cx="100" cy="100" r="92" className="arc" pathLength="100" />
        </svg>
        <div className="core">
          <span className="dot" />
          <Eggs egg={egg} k={k} />
        </div>
        {isNight() && <Cat />}
      </Plain>
      <div className="orb-txt">
        <div className="orb-t">{title}</div>
        <div className="orb-s">{sub}</div>
      </div>
    </div>
  )
}

export function Mark({ profiles, via }: { profiles: ProfileView[]; via: Via }) {
  if (via === AUTO_ID) return <Tooltip tip={viaName(profiles, via)}><i className="mark auto" /></Tooltip>
  const hue = hueOf(profiles, via)
  const group = profiles.find(p => p.id === via)?.kind === 'group'
  return <Tooltip tip={viaName(profiles, via)}>{hue ? <i className={'mark' + (group ? ' grp' : '')} style={group ? { color: hue } : { background: hue }} /> : <i className="mark direct" />}</Tooltip>
}

/** R5: Auto hint; for a library larger than the live pool it says how many candidates the core holds and why */
export function AutoHint({ profiles, bare }: { profiles: ProfileView[]; bare?: boolean }) {
  const total = autoMembers(profiles).length
  const text = total > AUTO_LIVE_MAX ? s('via.auto.pool', { live: AUTO_LIVE_MAX, total }) : s('via.auto.hint')
  const title = total > AUTO_LIVE_MAX ? s('via.auto.pool.why') : undefined
  return bare ? <span title={title}>{text}</span> : <small title={title}>{text}</small>
}

export function viaName(profiles: ProfileView[], via: Via) {
  if (via === 'direct') return s('via.direct')
  if (via === AUTO_ID) return s('via.auto')
  const p = profiles.find(x => x.id === via)
  return !p ? s('via.gone') : p.revoked ? `${p.name} · ${s('via.revoked')}` : p.name
}

/** "нет ответа" only for a confirmed-down path; one missed probe is a neutral "проверяю" (W2 D) */
export function Ping({ ms, live, down }: { ms?: number; live: boolean; down?: boolean }) {
  if (!live) return null
  if (ms === undefined) return down ? <span className="ping bad">{s('ping.none')}</span> : <span className="ping m">{s('ping.check')}</span>
  return <span className={'ping' + (ms > 250 ? ' slow' : '')}>{s('meter.ms', { n: ms })}</span>
}

/** second line of a tunnel in lists: protocol and host, or the policy of a group */
export const subOf = (p?: ProfileView) => (!p ? '' : p.kind === 'group' ? `${s('srv.kind.group')} · ${s('grp.pol.' + p.policy)}` : `${p.version} · ${p.host}`)

export function ViaPicker({ profiles, via, pings, live, onChange, compact, noDirect, down }: {
  profiles: ProfileView[]; via: Via; pings: Record<string, number | undefined>; live: boolean; onChange: (v: Via) => void; compact?: boolean; noDirect?: boolean
  /** paths confirmed down (from tunnel health / effective state) */
  down?: (v: Via) => boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [open])
  // Auto first when the user has own connections to pick from (W2.3); public nodes never join Auto
  const opts: Via[] = [...(autoMembers(profiles).length ? [AUTO_ID] : []), ...(noDirect ? [] : ['direct']), ...profiles.map(p => p.id)]
  return (
    <div className={'via' + (compact ? ' compact' : '')} ref={ref} onClick={e => e.stopPropagation()}>
      <Plain className="via-btn" onClick={() => setOpen(!open)} aria-expanded={open} tip={s('via.tip')}>
        <Mark profiles={profiles} via={via} />
        <span className="via-name">{viaName(profiles, via)}</span>
        {/* a deleted / revoked path has no evidence to show, only its blocked name */}
        {via !== 'direct' && (via === AUTO_ID || profiles.some(p => p.id === via && !p.revoked)) && <Ping ms={pings[via]} live={live} down={down?.(via)} />}
        <Icon n="chev" s={14} />
      </Plain>
      {open && (
        <div className="menu via-menu">
          {opts.map(v => (
            <Plain key={v} className={'mi' + (v === via ? ' on' : '')} disabled={profiles.some(p => p.id === v && p.revoked)} onClick={() => { onChange(v); setOpen(false) }}>
              <Mark profiles={profiles} via={v} />
              <span>{viaName(profiles, v)}</span>
              {v === 'direct' ? <small>{s('via.direct.hint')}</small> : v === AUTO_ID ? <AutoHint profiles={profiles} /> : <Ping ms={pings[v]} live={live} down={down?.(v)} />}
            </Plain>
          ))}
        </div>
      )}
    </div>
  )
}

export function RouteIcon({ r, icon, size = 32 }: { r: Route; icon?: string; size?: number }) {
  const st = { width: size, height: size }
  if (r.kind === 'app') return icon ? <img src={icon} alt="" style={st} /> : <span className="ph-ic" style={st}>{r.name.slice(0, 1)}</span>
  if (r.kind === 'preset') {
    const p = PRESETS.find(x => x.id === r.preset)
    return <Brand brand={p?.brand} name={p?.name ?? r.name} color={p?.color ?? '#9a958f'} size={size} />
  }
  return <span className="ph-ic" style={st}><Icon n="pin" /></span>
}

export function kindLabel(r: Route) {
  return s(r.kind === 'app' ? (r.wholeDir === false ? 'kind.exe' : 'kind.app') : r.kind === 'preset' ? 'kind.preset' : 'kind.custom')
}
