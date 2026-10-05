import { useState } from 'react'
import type { Settings, Snapshot } from '../../../shared/types'
import { Btn, Icon, Toggle } from '../ui/kit'
import { s } from '../lib/i18n'
import { api } from '../bridge'

export function SettingsPage({ snap, patch, toast }: { snap: Snapshot; patch: (p: Partial<Settings>) => void; toast: (x: string) => void }) {
  const st = snap.settings
  const [log, setLog] = useState<string[]>()
  const [resetting, setResetting] = useState(false)
  const opt = (k: keyof Settings, id: string, rec?: boolean) => (
    <div className="opt" onClick={() => patch({ [k]: !st[k] } as Partial<Settings>)}>
      <div><b>{s(id)}{rec && <em className="rec">{s('set.rec')}</em>}</b><p>{s(id + '.text')}</p></div>
      <Toggle on={!!st[k]} onChange={v => patch({ [k]: v } as Partial<Settings>)} label={s(id)} />
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
            {opt('dnsAll', 'set.dns')}
            {opt('lanDirect', 'set.lan', true)}
          </div>
        </section>
        <section className="panel">
          <h3>{s('set.fix')}</h3>
          <div className="opts">
            <div className="opt static">
              <div><b>{s('set.reset')}</b><p>{s('set.reset.text')}</p></div>
              <Btn disabled={resetting} onClick={async () => { if (resetting) return; setResetting(true); try { const r = await api.resetNet(); toast(r?.ok ? s('set.reset.done') : r?.error ?? s('set.reset.error')) } finally { setResetting(false) } }}><span className={resetting ? 'spin' : ''}><Icon n="refresh" /></span>{s('set.reset.go')}</Btn>
            </div>
            <div className="opt static">
              <div><b>{s('set.log')}</b><p>{s('set.log.text')}</p></div>
              <Btn onClick={async () => setLog(await api.log())}><Icon n="doc" />{s(log ? 'set.log.refresh' : 'set.log.show')}</Btn>
            </div>
          </div>
          {log && <pre className="log selectable">{log.length ? log.join('\n') : s('set.log.empty')}</pre>}
        </section>
        <section className="panel span2">
          <h3>{s('set.how')}</h3>
          <ul className="how">{[1, 2, 3, 4, 5].map(i => <li key={i}>{s(`set.how.${i}`)}</li>)}</ul>
        </section>
      </div>
    </div>
  )
}
