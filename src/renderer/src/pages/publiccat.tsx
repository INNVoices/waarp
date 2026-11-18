// The catalogue is a server browser. Every candidate can be checked and selected
// from the same row; a running VPN never turns browsing into an OFF-only action.
import { useEffect, useRef, useState } from 'react'
import { Btn, Field, Icon, Select, Tooltip } from '../ui/kit'
import { Pagination } from '../ui/pagination'
import { s, sp } from '../lib/i18n'
import { api } from '../bridge'

interface Node { id: string; name: string; proto: string; host: string; port: number; country: string; source?: string; ping?: number; status?: 'ready' | 'cached' | 'failed' | 'unverified'; checkedAt?: number; lastSuccessAt?: number }
interface State { updatedAt?: number; sources: { url: string; ok: boolean; count: number; error?: string }[]; total: number; readyCount?: number; cachedCount?: number; planned?: number; checked: number; alive: Node[]; cached?: Node[]; busy: boolean; cacheError?: string }
interface Page { items: Node[]; total: number; page: number; pageSize: number; pages: number; regions: { id: string; name: string; total: number; ready: number }[] }
const PAGE_SIZE = 12
const cc = (country: string) => /^[A-Z]{2}$/.test(country) ? country : ''
const ago = (at?: number) => {
  if (!at) return s('pub.never')
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 6e4))
  return minutes < 1 ? s('pub.now') : minutes < 60 ? sp('pub.min', minutes)
    : minutes < 1440 ? sp('pub.hour', Math.floor(minutes / 60)) : sp('pub.day', Math.floor(minutes / 1440))
}
const clean = (name: string) => name.replace(/[\u{1F1E6}-\u{1F1FF}]{2}\s*/gu, '').replace(/\[[^\]]*\]/g, '').replace(/#\d+/g, '').trim().replace(/^[A-Z]{2}\s*·\s*/, '') || name

export function PublicCatalog({ toast, used, onAdded, selectedId, onBusyChange, compact = false, disabled = false }: {
  toast: (text: string) => void; used: (id: string) => boolean; onAdded?: (id: string) => void; selectedId?: string
  compact?: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void
}) {
  const [st, setSt] = useState<State>()
  const [result, setResult] = useState<Page>()
  const [resultKey, setResultKey] = useState('')
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState('')
  const [readyOnly, setReadyOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [operation, setOperation] = useState<string>()
  const [selecting, setSelecting] = useState<string>()
  const mounted = useRef(true)
  const selectionLock = useRef(false)
  const toolbarLock = useRef(false)
  const autoStarted = useRef(false)
  const initialFilterChosen = useRef(false)
  const request = useRef(0)
  const queryKey = JSON.stringify([query.trim(), region, readyOnly, page])

  useEffect(() => {
    let active = true, pushed = false
    mounted.current = true
    const accept = (next: State) => {
      if (!active || !next) return
      if (!initialFilterChosen.current) {
        initialFilterChosen.current = true
        setReadyOnly((next.readyCount ?? next.alive.length) > 0)
      }
      setSt(next); setRevision(n => n + 1)
    }
    const unsubscribe = api.onCatalog((next: State) => { pushed = true; accept(next) })
    void api.catalogGet().then((next: State) => { if (!pushed) accept(next) }).catch(() => { if (active) setError(s('pub.error')) })
    return () => { active = false; mounted.current = false; onBusyChange?.(false); unsubscribe() }
  }, [])

  useEffect(() => {
    const sequence = ++request.current
    // A short debounce lets typing and probe progress coalesce without loading
    // thousands of rows or replacing the user's current page on every result.
    const timer = setTimeout(() => {
      void api.catalogPage({ query: query.trim(), region: region || undefined, readyOnly, page, pageSize: PAGE_SIZE }).then((next: Page) => {
        if (request.current !== sequence) return
        setResult(next)
        setResultKey(JSON.stringify([query.trim(), region, readyOnly, next.page]))
        if (next.page !== page) setPage(next.page)
      }).catch(() => { if (request.current === sequence) setError(s('pub.error')) })
    }, 120)
    return () => { clearTimeout(timer); if (request.current === sequence) request.current++ }
  }, [query, region, readyOnly, page, revision])

  // Entering this explicit public-server surface starts one bounded search.
  // It never loops on failure, and selecting a row can preempt the pool round.
  useEffect(() => {
    if (!st || autoStarted.current || disabled) return
    autoStarted.current = true
    if (st.busy || (st.readyCount ?? st.alive.length) > 0) return
    void (st.total ? api.catalogVerify() : api.catalogRefresh()).then((next: State & { error?: string }) => {
      if (next?.error) setError(next.error)
      else if (next) { setSt(next); setRevision(n => n + 1) }
    }).catch(() => setError(s('pub.error')))
  }, [st, disabled])

  const run = async (key: string, work: () => Promise<State | undefined>) => {
    if (toolbarLock.current || disabled) return
    toolbarLock.current = true; setOperation(key); setError('')
    try {
      const next = await work() as State & { error?: string } | undefined
      if (next?.error) setError(next.error)
      else if (next) { setSt(next); setRevision(n => n + 1) }
    } catch { setError(s('pub.error')) }
    finally { toolbarLock.current = false; setOperation(undefined) }
  }
  const add = async (node: Node) => {
    if (selectionLock.current || disabled) return
    selectionLock.current = true; onBusyChange?.(true); setSelecting(node.id); setError('')
    try {
      const next = await api.catalogAdd(node.id)
      if (!mounted.current) return
      if (!next?.ok) { setError(next?.error ?? s('pub.error')); return }
      if (!onAdded) toast(s('pub.add.ok', { v: clean(node.name) }))
      if (next.id) onAdded?.(next.id)
    } catch { setError(s('pub.error')) }
    finally { selectionLock.current = false; if (mounted.current) { onBusyChange?.(false); setSelecting(undefined); setRevision(n => n + 1) } }
  }
  const best = async () => {
    if (selectionLock.current || disabled) return
    selectionLock.current = true; onBusyChange?.(true); setSelecting('best'); setError('')
    try {
      const next = await api.catalogBest()
      if (!mounted.current) return
      if (!next?.ok) { setError(next?.error ?? s('pub.error')); return }
      toast(s('pub.best.ok')); if (next.id) onAdded?.(next.id)
    } catch { setError(s('pub.error')) }
    finally { selectionLock.current = false; if (mounted.current) { onBusyChange?.(false); setSelecting(undefined) } }
  }
  const current = resultKey === queryKey ? result : undefined
  const readyCount = st?.readyCount ?? st?.alive.length ?? 0
  const checking = st?.busy || !!operation
  const checkError = !checking && !readyCount ? st?.sources.find(source => source.url === 'local checker')?.error : undefined
  const chooseLabel = (node: Node) => {
    if (selecting === node.id) return s('server.public.checking')
    if (selectedId === node.id) return s('server.current')
    if (node.status === 'ready') return onAdded ? s('pick.use') : s('pub.add')
    if (node.status === 'failed') return s('server.public.recheck')
    return s(onAdded ? 'server.public.checkuse' : 'server.public.checkadd')
  }

  return <section className={'panel pub server-catalog' + (compact ? ' compact' : '')} id="public-catalog">
    <div className="pub-head">
      <div className="pub-t">
        <b className={readyCount ? 'server-ready-count' : ''}>{s('server.public.available', { n: readyCount })}</b>
        <span className="m">{st?.busy ? (st.planned ? s('pub.checking', { n: st.checked, t: st.planned }) : s('pub.fetching')) : s('server.public.stored', { count: sp('server.public.candidates', st?.total ?? 0), ago: ago(st?.updatedAt) })}</span>
      </div>
      <div className="grow" />
      <Btn kind="ghost" onClick={() => void run('refresh', () => api.catalogRefresh())} disabled={disabled || checking} title={s('pub.refresh.tip')}><span className={checking ? 'spin' : ''}><Icon n="refresh" /></span>{s('pub.refresh')}</Btn>
      <Btn kind="ghost" onClick={() => void run('verify', () => api.catalogVerify())} disabled={disabled || checking || !st?.total} title={s('server.public.verify.hint')}><Icon n="pulse" />{s('server.public.verify')}</Btn>
    </div>
    <div className="server-filters">
      <Field icon="search" type="search" value={query} onChange={event => { initialFilterChosen.current = true; setQuery(event.target.value); setPage(1) }} placeholder={s('server.public.search')} aria-label={s('server.public.search')} />
      <Select value={region} onChange={event => { initialFilterChosen.current = true; setRegion(event.target.value); setPage(1) }} aria-label={s('server.region.label')}>
        <option value="">{s('server.region.all')}</option>
        {(result?.regions ?? []).map(item => <option value={item.id} key={item.id}>{s('pub.region.' + item.id)}{` · ${readyOnly ? item.ready : item.total}`}</option>)}
      </Select>
      <Select value={readyOnly ? 'ready' : 'all'} onChange={event => { initialFilterChosen.current = true; setReadyOnly(event.target.value === 'ready'); setPage(1) }} aria-label={s('server.filter.label')}>
        <option value="all">{s('server.filter.all')}</option><option value="ready">{s('server.filter.ready')}</option>
      </Select>
    </div>
    {error && <p className="ferr" role="alert">{error}</p>}
    {checkError && checkError !== error && <p className="ferr" role="status">{checkError}</p>}
    {st?.cacheError && <p className="ferr" role="alert">{st.cacheError}</p>}
    {!!st?.total && !readyCount && <p className="server-catalog-note" role="status"><Icon n="info" s={14} />{s('server.public.none')}</p>}
    {!current ? <div className="server-list-empty" role="status">{error || s('server.public.loading')}</div> : !current.items.length ? <div className="server-list-empty">{s(st?.total ? 'server.public.noresults' : 'server.public.empty')}</div> :
      <div className="server-list public-server-list">
        <div className="server-list-head"><span>{s('pick.country')}</span><span>{s('pick.name')}</span><Tooltip tip={s('pick.ping.hint')}><span>{s('pick.ping')}</span></Tooltip><span /></div>
        {current.items.map(node => {
          const selected = selectedId === node.id
          const busy = selecting === node.id
          return <div key={node.id} className={'server-row' + (selected ? ' on' : '') + (busy ? ' applying' : '')}>
            <span className="pub-cc" title={s('pick.country.hint')}>{cc(node.country) || <Icon n="globe" s={14} />}</span>
            <div className="server-row-name"><b className="ell" title={node.name}>{clean(node.name)}</b><span className="m ell" title={`${node.host}:${node.port} · ${node.source ?? ''}`}>{node.proto}{' · '}{node.host}:{node.port}</span></div>
            <div className={'server-row-health' + (node.status === 'ready' ? ' ready' : node.status === 'failed' ? ' failed' : '')} title={s('pub.checked.at', { ago: ago(node.checkedAt) })}>
              {busy ? <span className="spin"><Icon n="refresh" s={14} /></span> : node.status === 'ready' ? <><span className="mono">{node.ping === undefined ? s('server.public.ready') : s('meter.ms', { n: node.ping })}</span><small>{s('server.public.ready')}</small></> : <span>{s(node.status === 'failed' ? 'pub.node.failed' : node.status === 'unverified' ? 'server.public.unchecked' : 'server.public.stale')}</span>}
            </div>
            {used(node.id) && !onAdded ? <span className="server-row-action saved"><Icon n="check" s={14} />{s('pub.in')}</span> : <Btn kind={selected ? 'ghost' : 'default'} sm className="server-row-action" disabled={disabled || !!selecting || selected} aria-busy={busy} onClick={() => void add(node)}>{selected && <Icon n="check" s={14} />}{chooseLabel(node)}</Btn>}
          </div>
        })}
      </div>}
    {current && <Pagination page={current.page} total={current.total} pageSize={current.pageSize} onChange={next => { initialFilterChosen.current = true; setPage(next) }} />}
    <p className="hint server-catalog-trust"><Icon n="info" s={13} />{s('server.public.trust')}</p>
    <details className="server-catalog-info"><summary>{s('server.public.moreinfo')}</summary>
      <p className="hint">{s('pub.trust')}</p>
      <p className="hint">{s('pick.ping.hint')}</p>
      {st && st.sources.some(source => !source.ok) && <p className="hint">{s('pub.src.fail', { n: st.sources.filter(source => !source.ok).length })}</p>}
      <Btn kind="ghost" sm disabled={!readyCount || disabled || !!selecting} onClick={() => void best()}><Icon n="bolt" />{s('pub.best')}</Btn>
    </details>
  </section>
}
