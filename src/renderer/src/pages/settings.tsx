import { useRef, useState } from 'react'
import type { Settings, Snapshot } from '../../../shared/types'
import { Btn, Icon, Toggle } from '../ui/kit'
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
        <section className="panel span2">
          <h3>{s('set.how')}</h3>
          <ul className="how">{[1, 2, 3, 4, 5].map(i => <li key={i}>{s(`set.how.${i}`)}</li>)}</ul>
        </section>
      </div>
    </div>
  )
}
