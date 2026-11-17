import { useRef, useState } from 'react'
import type { Settings, Snapshot } from '../../../shared/types'
import { Btn, Icon, Input, Toggle } from '../ui/kit'
import { firstServer } from '../lib/routes'
import { s } from '../lib/i18n'
import { api } from '../bridge'
import type { SettingsPatch, Toast } from '../lib/actions'
import { useDev, writeDev } from '../lib/dev'

export function SettingsPage({ snap, patch, toast }: { snap: Snapshot; patch: SettingsPatch; toast: Toast }) {
  const dev = useDev()
  const st = snap.settings
  const [log, setLog] = useState<string[]>()
  const [resetting, setResetting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [logging, setLogging] = useState(false)
  const action = useRef(false)
  const logAction = useRef(false)
  const resetAction = useRef(false)
  const save = async (k: keyof Settings, value: boolean) => {
    if (action.current) return
    action.current = true; setSaving(true)
    try { await patch({ [k]: value } as Partial<Settings>) }
    finally { action.current = false; setSaving(false) }
  }
  const readLog = async () => {
    if (logAction.current) return
    logAction.current = true; setLogging(true)
    try { setLog(await api.log()) }
    catch { toast(s('set.log.error'), 'error') }
    finally { logAction.current = false; setLogging(false) }
  }
  const reset = async () => {
    if (resetAction.current) return
    resetAction.current = true; setResetting(true)
    try { const r = await api.resetNet(); toast(r?.ok ? s('set.reset.done') : r?.error ?? s('set.reset.error'), r?.ok ? 'success' : 'error') }
    catch { toast(s('set.reset.error'), 'error') }
    finally { resetAction.current = false; setResetting(false) }
  }
  const opt = (k: keyof Settings, id: string, rec?: boolean) => (
    <div className="opt" onClick={() => void save(k, !st[k])}>
      <div><b>{s(id)}{rec && <em className="rec">{s('set.rec')}</em>}</b><p>{s(id + '.text')}</p></div>
      <Toggle disabled={saving} on={!!st[k]} onChange={v => void save(k, v)} label={s(id)} />
    </div>
  )
  return (
    <div className="page">
      <div className="page-head"><h1>{s('set.title')}</h1></div>
      <div className="set-grid">
        <section className="panel">
          <h3>{s('set.app')}</h3>
          <div className="opts">
            {opt('autostart', 'set.autostart')}
            {opt('autoConnect', 'set.auto')}
            {opt('tray', 'set.tray', true)}
          </div>
        </section>
        <section className="panel">
          <h3>{s('set.notify')}</h3>
          <div className="opts">
            {opt('notify', 'set.notify.down', true)}
          </div>
        </section>
        <section className="panel">
          <h3>{s('set.net')}</h3>
          <div className="opts">
            {opt('ruDirect', 'set.ru', true)}
            {opt('lanDirect', 'set.lan', true)}
          </div>
          <p className="hint">{s('set.dns.behavior')}</p>
        </section>
        <section className="panel">
          <h3>{s('set.fix')}</h3>
          <div className="opts">
            <div className="opt static">
              <div><b>{s('set.reset')}</b><p>{s('set.reset.text')}</p></div>
              <Btn disabled={resetting} onClick={() => void reset()}><span className={resetting ? 'spin' : ''}><Icon n="refresh" /></span>{s('set.reset.go')}</Btn>
            </div>
            <div className="opt static">
              <div><b>{s('set.log')}</b><p>{s('set.log.text')}</p></div>
              <Btn disabled={logging} onClick={() => void readLog()}><Icon n="doc" />{s(log ? 'set.log.refresh' : 'set.log.show')}</Btn>
            </div>
          </div>
          {log && <pre className="log selectable">{log.length ? log.join('\n') : s('set.log.empty')}</pre>}
          <div className="opts">
            <div className="opt static">
              <div><b>{s('set.dev')}</b><p>{s('set.dev.text')}</p></div>
              <Toggle on={dev} onChange={v => writeDev(v)} label={s('set.dev')} />
            </div>
            {dev && <div className="opt static">
              <div><b>{s('set.diag')}</b><p>{s('set.diag.text')}</p></div>
              <Btn onClick={async () => { try { const r = await api.exportDiag(); if (r.ok) toast(s('set.diag.done')); else if (r.error) toast(s('set.diag.error'), 'error') } catch { toast(s('set.diag.error'), 'error') } }}><Icon n="doc" />{s('set.diag.go')}</Btn>
            </div>}
          </div>
        </section>
        <ListsPanel snap={snap} patch={patch} toast={toast} />
        <section className="panel span2">
          <h3>{s('set.how')}</h3>
          <ul className="how">{[1, 2, 3, 4, 5].map(i => <li key={i}>{s(`set.how.${i}`)}</li>)}</ul>
        </section>
      </div>
    </div>
  )
}

/** domain lists are data: added by address, kept as the last good snapshot; a card uses one only when the user makes it */
function ListsPanel({ snap, patch, toast }: { snap: Snapshot; patch: SettingsPatch; toast: Toast }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState('')
  const lists = snap.lists ?? []
  const act = async (key: string, f: () => Promise<{ ok: boolean; error?: string }>, fail: string) => {
    setBusy(key)
    try { const r = await f(); if (!r.ok) toast(s(r.error ? 'lists.err.' + r.error : fail), 'error') } catch { toast(s(fail), 'error') } finally { setBusy('') }
  }
  const used = (id: string) => snap.settings.routes.some(r => r.kind === 'list' && r.list === id)
  const card = (id: string, n: string) => void patch({ routes: [...snap.settings.routes, { id: 'list:' + id, kind: 'list', name: n, list: id, via: firstServer(snap.profiles), on: true }] })
  return (
    <section className="panel span2">
      <h3>{s('lists.title')}</h3>
      <p className="hint">{s('lists.text')}</p>
      <div className="addrow">
        <Input className="inp" value={name} placeholder={s('lists.name')} onChange={e => setName(e.target.value)} />
        <Input className="inp" value={url} placeholder={s('lists.url')} onChange={e => setUrl(e.target.value)} />
        <Btn kind="primary" disabled={!!busy || !url.trim()} onClick={() => void act('add', async () => { const r = await api.listAdd(name, url.trim()); if (r.ok) { setName(''); setUrl('') } return r }, 'lists.err.url')}><Icon n="plus" />{s('lists.add')}</Btn>
      </div>
      <div className="opts">
        {lists.map(l => (
          <div key={l.id} className="opt static">
            <div>
              <b>{l.name}</b>
              <p className="mono ell">{l.url}</p>
              <p className={l.error ? 'warn' : 'm'}>{l.count ? s('lists.count', { n: l.count, t: l.updatedAt ? new Date(l.updatedAt).toLocaleString() : '—' }) : s('lists.never')}{l.error ? ' · ' + s('lists.err.' + l.error) : ''}</p>
            </div>
            <Toggle on={l.enabled} disabled={!!busy} onChange={v => void act(l.id, () => api.listToggle(l.id, v), 'lists.err.save')} label={l.name} />
            <Btn kind="ghost" disabled={!!busy} title={s('lists.refresh')} onClick={() => void act(l.id, () => api.listRefresh(l.id), 'lists.err.fetch')}><span className={busy === l.id ? 'spin' : ''}><Icon n="refresh" /></span></Btn>
            {!used(l.id) && l.count > 0 && <Btn kind="ghost" onClick={() => card(l.id, l.name)}><Icon n="plus" />{s('lists.card')}</Btn>}
            <Btn kind="danger" disabled={!!busy || used(l.id)} title={used(l.id) ? s('lists.err.used') : s('set.remove')} onClick={() => void act(l.id, () => api.listRemove(l.id), 'lists.err.save')}><Icon n="trash" /></Btn>
          </div>
        ))}
      </div>
    </section>
  )
}
