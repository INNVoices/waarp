import { useEffect, useRef, type ReactNode } from 'react'
import { Icon, Plain } from './kit'
import { s } from '../lib/i18n'

const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

export function Modal({ title, onClose, children, wide, busy = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const restore = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
  const close = useRef(onClose)
  const pending = useRef(busy)
  close.current = onClose
  pending.current = busy
  useEffect(() => {
    const dialog = ref.current!
    const previous = restore.current
    const top = () => [...document.querySelectorAll('[role="dialog"]')].at(-1) === dialog
    const items = () => [...dialog.querySelectorAll<HTMLElement>(focusable)].filter(el => el.getClientRects().length > 0)
    const focusFirst = () => { const controls = items(); (controls.find(el => el.hasAttribute('autofocus')) ?? controls[0] ?? dialog).focus() }
    // React autofocus may already have focused a field. Do not replace that useful choice.
    if (!dialog.contains(document.activeElement)) focusFirst()
    const key = (e: KeyboardEvent) => {
      if (!top() || e.defaultPrevented) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        if (!pending.current) close.current()
      } else if (e.key === 'Tab') {
        const controls = items(), first = controls[0], last = controls.at(-1)
        if (!first) { e.preventDefault(); dialog.focus(); return }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last!.focus() }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { e.preventDefault(); first.focus() }
      }
    }
    const keepFocus = (e: FocusEvent) => { if (top() && !dialog.contains(e.target as Node)) focusFirst() }
    document.addEventListener('keydown', key)
    document.addEventListener('focusin', keepFocus)
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('focusin', keepFocus)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return (
    <div className="modal-back" onMouseDown={e => { if (!busy && e.target === e.currentTarget) onClose() }}>
      <div ref={ref} tabIndex={-1} className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy}>
        <div className="modal-h">
          <h2>{title}</h2>
          {busy && <span className="spin" role="status" aria-label={s('common.working')}><Icon n="refresh" s={16} /></span>}
          <Plain className="back" disabled={busy} aria-label={s('nav.close')} onClick={onClose}><Icon n="x" s={16} /></Plain>
        </div>
        {children}
      </div>
    </div>
  )
}
