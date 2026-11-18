// ExitLag is an externally managed per-app route, not a public proxy list.
import { useEffect, useState } from 'react'
import type { ExitLagSnapshot, ExitLagVisibleCatalog } from '../../../shared/exitlag'
import { api } from '../bridge'
import { Btn, Icon } from '../ui/kit'
import { s } from '../lib/i18n'

const LABELS: Record<number, string> = { 106: 'Discord', 1227: 'Telegram' } // observed app IDs, not a universal catalog

export function ExitLagCatalog() {
  const [st, setSt] = useState<ExitLagSnapshot>()
  const [visible, setVisible] = useState<ExitLagVisibleCatalog>()
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [show, setShow] = useState(false)
  const refresh = async () => {
    if (busy) return
    setBusy(true)
    try { setSt(await api.exitLagGet()) } finally { setBusy(false) }
  }
  useEffect(() => {
    let alive = true
    void api.exitLagGet().then(x => { if (alive) setSt(x) }).catch(() => {})
    return () => { alive = false }
  }, [])
  const scanVisible = async () => {
    if (scanning) return
    setScanning(true)
    try { setVisible(await api.exitLagVisible()) } finally { setScanning(false) }
  }
  return <section className="panel pub" id="exitlag-catalog">
    <div className="pub-head">
      <span className="wz-ic"><Icon n="server" s={20} /></span>
      <div className="pub-t"><b>{s('exitlag.title')}</b>
        <span className="m">{!st ? s('exitlag.checking') : !st.installed ? s('exitlag.absent') : st.running ? s('exitlag.running') : s('exitlag.stopped')}</span>
      </div>
      <div className="grow" />
      <Btn kind="ghost" disabled={busy} onClick={() => void refresh()}><Icon n="refresh" />{s('exitlag.read')}</Btn>
      <Btn disabled={!st?.installed} onClick={() => void api.exitLagOpen()}>{s('exitlag.open')}</Btn>
    </div>
    <p className="hint">{s('exitlag.explain')}</p>
    {st?.error && <p className="ferr" role="alert">{st.error}</p>}
    {!!st?.selections.length && <>
      <div className="chips">
        {st.selections.map(v => <span key={v.appId} className="chip" title={v.alias || undefined}>
          <b>{LABELS[v.appId] ?? 'ExitLag #' + v.appId}</b> · {v.selectedServer || s('exitlag.unknown')}
          {v.automatic ? ' · Auto' : ''} · {v.enabled ? s('exitlag.on') : s('exitlag.off')}
        </span>)}
      </div>
      <p className="hint">{s('exitlag.selections')}</p>
    </>}
    <div className="pub-foot">
      <span className="hint">{s('exitlag.note')}</span>
      <div className="grow" />
      <Btn kind="ghost" onClick={() => setShow(v => !v)}>{show ? s('exitlag.hide') : s('exitlag.show')}</Btn>
    </div>
    {show && <>
      <p className="hint">{s('exitlag.visible.note')}</p>
      <Btn disabled={scanning || !st?.running} onClick={() => void scanVisible()}><Icon n="search" />{s('exitlag.visible.read')}</Btn>
      {visible?.error && <p className="ferr">{visible.error}</p>}
      {visible && !visible.error && <p className="hint">{visible.screenOpen ? s('exitlag.visible.partial') : s('exitlag.visible.closed')}</p>}
      {visible?.screenOpen && <div className="chips">
        {visible.names.map((name, i) => <span key={i} className="chip">{name}</span>)}
      </div>}
    </>}
  </section>
}
