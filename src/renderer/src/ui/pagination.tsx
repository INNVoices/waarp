import { Btn, Icon } from './kit'
import { s } from '../lib/i18n'

/** A bounded page navigator: first/last and neighbours remain reachable even for large pools. */
export function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(1, page), pages)
  const numbers = [...new Set([1, pages, ...Array.from({ length: 5 }, (_, n) => current + n - 2)])].filter(n => n > 0 && n <= pages).sort((a, b) => a - b)
  const range = total ? s('pages.range', { from: (current - 1) * pageSize + 1, to: Math.min(current * pageSize, total), total }) : s('pages.empty')
  return <div className="server-pagination">
    <span className="hint" aria-live="polite">{range}</span>
    {pages > 1 && <nav className="server-page-buttons" aria-label={s('pages.label')}>
      <Btn kind="ghost" sm aria-label={s('pages.previous')} disabled={current <= 1} onClick={() => onChange(current - 1)}><Icon n="back" s={14} /></Btn>
      {numbers.map((n, index) => <span className="server-page-item" key={n}>
        {index > 0 && n > numbers[index - 1] + 1 && <span className="m" aria-hidden>…</span>}
        <Btn kind={n === current ? 'primary' : 'ghost'} sm aria-current={n === current ? 'page' : undefined} aria-label={s('pages.number', { n })} onClick={() => onChange(n)}>{n}</Btn>
      </span>)}
      <Btn kind="ghost" sm aria-label={s('pages.next')} disabled={current >= pages} onClick={() => onChange(current + 1)}><span className="page-next"><Icon n="back" s={14} /></span></Btn>
    </nav>}
  </div>
}
