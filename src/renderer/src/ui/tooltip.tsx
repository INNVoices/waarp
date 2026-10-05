import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type At = { x: number; y: number; up: boolean }
type Handlers = {
  onPointerEnter?(e: React.PointerEvent<HTMLElement>): void
  onPointerLeave?(e: React.PointerEvent<HTMLElement>): void
  onPointerDown?(e: React.PointerEvent<HTMLElement>): void
  onFocus?(e: React.FocusEvent<HTMLElement>): void
  onBlur?(e: React.FocusEvent<HTMLElement>): void
  'aria-describedby'?: string
}

let current: { hide(): void } | null = null
let warmUntil = 0

export function tooltipDx(left: number, right: number, width: number, viewport: number): number {
  if (width > viewport - 16) return 8 - left
  if (left < 8) return 8 - left
  if (right > viewport - 8) return viewport - 8 - right
  return 0
}

export function Tooltip({ tip, side, children }: { tip: ReactNode; side?: 'top' | 'bottom' | 'right'; children: ReactElement<Handlers> }) {
  const id = useId()
  const [at, setAt] = useState<At | null>(null)
  const [dx, setDx] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const me = useRef({ hide: (): void => undefined })
  const hide = () => {
    clearTimeout(timer.current)
    if (at) warmUntil = Date.now() + 300
    setAt(null)
    if (current === me.current) current = null
  }
  me.current.hide = hide
  const show = (el: HTMLElement) => {
    if (!tip) return
    if (current && current !== me.current) current.hide()
    current = me.current
    clearTimeout(timer.current)
    const go = () => {
      if (!el.isConnected) return
      const r = el.getBoundingClientRect()
      setDx(0)
      if (side === 'right') { setAt({ x: r.right + 8, y: r.top + r.height / 2, up: false }); return }
      const up = side === 'top' ? r.top > 44 : side !== 'bottom' && r.bottom + 44 > innerHeight && r.top > 44
      setAt({ x: r.left + r.width / 2, y: up ? r.top - 6 : r.bottom + 6, up })
    }
    if (Date.now() < warmUntil) go(); else timer.current = window.setTimeout(go, 400)
  }
  useEffect(() => () => { clearTimeout(timer.current); if (current === me.current) current = null }, [])
  useLayoutEffect(() => {
    const b = box.current?.getBoundingClientRect()
    if (!b || side === 'right') return
    const d = tooltipDx(b.left - dx, b.right - dx, b.width, document.documentElement.clientWidth || innerWidth)
    if (d !== dx) setDx(d)
  }, [at])
  const p = children.props
  const child = cloneElement(children, {
    'aria-describedby': at ? id : p['aria-describedby'],
    onPointerEnter: e => { p.onPointerEnter?.(e); if (e.pointerType !== 'touch') show(e.currentTarget) },
    onPointerLeave: e => { p.onPointerLeave?.(e); hide() },
    onPointerDown: e => { p.onPointerDown?.(e); hide() },
    onFocus: e => { p.onFocus?.(e); if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget) },
    onBlur: e => { p.onBlur?.(e); hide() }
  })
  return (
    <>
      {child}
      {at && createPortal(
        <div ref={box} id={id} role="tooltip" className={'tip' + (at.up ? ' up' : '') + (side === 'right' ? ' right' : '')} style={{ left: at.x + dx, top: at.y }}>{tip}</div>,
        document.body
      )}
    </>
  )
}
