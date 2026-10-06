import { Tooltip } from './tooltip'
import { wPath } from '../../../shared/brand-w'
export { Tooltip }
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

const P: Record<string, ReactNode> = {
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.3 15.3 20 20" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>,
  apps: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5S9.5 6.1 12 3.5Z" /></>,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></>,
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>,
  down: <path d="M12 5v13M6.5 12.5 12 18l5.5-5.5" />,
  up: <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" />,
  chev: <path d="m7 10 5 5 5-5" />,
  shield: <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-2.5Z" />,
  warn: <><path d="M12 4 2.8 19.5h18.4L12 4Z" /><path d="M12 10v4.5M12 17.2v.1" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.1" /></>,
  // shared glyph family; .tint = the accent detail
  home: <><path d="M3.5 11 12 4l8.5 7M5.5 9.5V20h13V9.5" /><path className="tint" d="M10 20v-5h4v5" /></>,
  path: <><path d="M3 19.5h18M5.5 15l3-10M11 15l3-10" /><path className="tint" d="M17.5 5v10" /></>,
  plug: <path d="M9 3v4.5M15 3v4.5M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5V21" />,
  investigate: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /><circle className="tint-dot" cx="12" cy="12" r="1" /></>,
  settings: <><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2.5V6M12 18v3.5M2.5 12H6M18 12h3.5M5.3 5.3l2.5 2.5M16.2 16.2l2.5 2.5M5.3 18.7l2.5-2.5M16.2 7.8l2.5-2.5" /></>,
  subscription: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" /><path className="tint" d="M9 10.5h6M9 14h4" /></>,
  link: <><path d="M13.5 6.5l1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" /><path className="tint" d="M10.5 17.5l-1 1a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0" /></>,
  // no family QR glyph exists: drawn to the family rules (1.5 stroke, round joins, one accent detail)
  qr: <><rect x="4" y="4" width="6" height="6" rx="1.2" /><rect x="14" y="4" width="6" height="6" rx="1.2" /><rect x="4" y="14" width="6" height="6" rx="1.2" /><path d="M14 14h2.5M20 14v2.5M14 17.5V20h2.5" /><circle className="tint-dot" cx="18.5" cy="18.5" r="1.25" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  paste: <><rect x="6" y="5" width="12" height="15.5" rx="2" /><path d="M9.5 5V3.5h5V5" /></>,
  trash: <><path d="M5 7h14M10 7V4.5h4V7M7 7l.8 13h8.4L17 7" /></>,
  edit: <><path d="M4.5 19.5l1-4.5L15.8 4.7a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L9 18.5z" /><path className="tint" d="M13.8 6.7l3.5 3.5" /></>,
  bolt: <path d="M13 3 5.5 13H12l-1 8 7.5-10H12l1-8Z" />,
  folder: <path d="M3.5 6.5h6l2 2h9v10h-17z" />,
  min: <path d="M6 12h12" />,
  max: <rect x="6.5" y="6.5" width="11" height="11" rx="1" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  user: <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c1.2-3.8 4-5.6 7.5-5.6s6.3 1.8 7.5 5.6" /></>,
  server: <><rect x="4" y="3.5" width="16" height="7" rx="1.5" /><rect x="4" y="13.5" width="16" height="7" rx="1.5" /><circle className="dot" cx="7.5" cy="7" r=".9" /><circle className="dot" cx="7.5" cy="17" r=".9" /><path d="M11 7h5.5M11 17h5.5" /></>,
  chart: <path d="M4 19.5h16M6.5 16l3.5-5 3 3 4.5-7" />,
  doc: <><path d="M7 4.5h10v15H7z" /><path d="M9.5 8.5h5M9.5 12h5M9.5 15.5h3" /></>
}

export function Icon({ n, s = 16 }: { n: keyof typeof P | string; s?: number }) {
  return (
    <svg className="ic" width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{/* icon-ok: the one icon pack lives here */}
      {P[n]}
    </svg>
  )
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={'tg' + (on ? ' on' : '')} onClick={e => { e.stopPropagation(); onChange(!on) }}>
      <i />
    </button>
  )
}

export function Seg<T extends string>({ value, items, onChange, disabled }: { value: T; items: { v: T; label: string; n?: number }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="seg" role="group">
      {items.map(it => (
        <button key={it.v} disabled={disabled} aria-pressed={value === it.v} className={value === it.v ? 'on' : ''} onClick={() => onChange(it.v)}>
          {it.label}{it.n !== undefined && <span className="cnt">{it.n}</span>}
        </button>
      ))}
    </div>
  )
}

const W_MARK = wPath(24)
/** RC2 A: the Waarp mark is the wordmark w; open = accent */
export function Logo({ s = 18, open = false }: { s?: number; open?: boolean }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={'logo' + (open ? ' open' : '')}>{/* icon-ok: Waarp mark */}
      <path d={W_MARK} />
    </svg>
  )
}

export const fmtBytes = (n: number) => {
  if (n < 1024) return `${Math.round(n)} Б`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} КБ`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} МБ`
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`
}

export const fmtSpeed = (n: number) => {
  const b = n * 8
  if (b < 1000) return `${Math.round(b)} бит/с`
  if (b < 1e6) return `${(b / 1e3).toFixed(0)} Кбит/с`
  return `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} Мбит/с`
}

export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(x).padStart(2, '0')
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10, b = n % 100
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many
}

type BtnKind = 'default' | 'primary' | 'ghost' | 'danger'
export function Btn({ kind = 'default', sm, className = '', title, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; sm?: boolean }) {
  const k = kind === 'default' ? '' : kind === 'danger' ? ' ghost danger' : ' ' + kind
  const b = <button type="button" className={'btn' + k + (sm ? ' sm' : '') + (className ? ' ' + className : '')} {...p} />
  return title ? <Tooltip tip={title}>{b}</Tooltip> : b
}

export function Plain({ tip, tipSide, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tip?: string; tipSide?: 'top' | 'bottom' | 'right' }) {
  const b = <button type="button" {...p} />
  return tip ? <Tooltip tip={tip} side={tipSide}>{b}</Tooltip> : b
}

export function Field({ icon, bad, className = '', ...p }: InputHTMLAttributes<HTMLInputElement> & { icon?: string; bad?: boolean }) {
  return (
    <label className={'search' + (bad ? ' bad' : '') + (className ? ' ' + className : '')}>
      {icon && <Icon n={icon} />}
      <input {...p} />
    </label>
  )
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} />
}

export function Area(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} />
}
