import { useEffect, type ReactNode } from 'react'
import { Icon, Plain } from './kit'
import { s } from '../lib/i18n'

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h">
          <h2>{title}</h2>
          <Plain className="back" aria-label={s('nav.close')} onClick={onClose}><Icon n="x" s={16} /></Plain>
        </div>
        {children}
      </div>
    </div>
  )
}
