import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../../../shared/types'
import type { PayloadReply, PayloadReport, PayloadStage } from '../../../shared/payload'
import { Btn, Field, fmtBytes, Icon, Select } from '../ui/kit'
import { api } from '../bridge'
import { s } from '../lib/i18n'

export function PayloadCheck({ snap }: { snap: Snapshot }) {
  const profiles = snap.profiles.filter(p => p.kind !== 'group' && !p.revoked && !p.subscriptionMissing && p.source !== 'public')
  const [selected, setSelected] = useState(profiles[0]?.id ?? '')
  const [upload, setUpload] = useState('')
  const [report, setReport] = useState<PayloadReport>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0), running = useRef(false)
  useEffect(() => {
    let mounted = true
    void api.payloadLast().then(value => { if (mounted && value) setReport(value as PayloadReport) }).catch(() => {})
    return () => { mounted = false; generation.current++; if (running.current) void api.payloadCancel().catch(() => {}) }
  }, [])
  const path = profiles.some(p => p.id === selected) ? selected : profiles[0]?.id ?? ''
  const run = async () => {
    if (!path || running.current) return
    const mine = ++generation.current
    running.current = true; setBusy(true); setError('')
    try {
      const result = await api.payloadRun(path, upload.trim() || undefined) as PayloadReply
      if (generation.current !== mine) return
      if (result.report) setReport(result.report)
      else setError(result.error ?? 'engine')
    } catch { if (generation.current === mine) setError('engine') }
    finally { if (generation.current === mine) { running.current = false; setBusy(false) } }
  }
  const cancel = async () => {
    generation.current++
    try { await api.payloadCancel(); setError('cancelled') } catch { setError('engine') }
    finally { running.current = false; setBusy(false) }
  }
  const stageText = (stage: PayloadStage) => stage.state === 'pass'
    ? s('payload.pass', { bytes: fmtBytes(stage.bytes), seconds: (stage.ms / 1000).toFixed(1) })
    : s('payload.reason.' + (stage.reason ?? 'network'))
  return <section className="panel payload-check">
    <div className="ph-row"><h3>{s('payload.title')}</h3><span className="m">{s('payload.manual')}</span></div>
    <p className="hint">{s('payload.hint')}</p>
    <div className="addrow">
      <Select aria-label={s('payload.path')} value={path} disabled={busy || !profiles.length} onChange={event => setSelected(event.target.value)}>
        {!profiles.length && <option value="">{s('payload.empty')}</option>}
        {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      {busy ? <Btn onClick={() => void cancel()}>{s('payload.cancel')}</Btn>
        : <Btn kind="primary" onClick={() => void run()} disabled={!path}><Icon n="pulse" />{s('payload.run')}</Btn>}
    </div>
    <details className="hint"><summary>{s('payload.upload.options')}</summary>
      <p>{s('payload.upload.hint')}</p>
      <Field aria-label={s('payload.upload.url')} placeholder={s('payload.upload.url')} value={upload} disabled={busy} onChange={event => setUpload(event.target.value)} />
    </details>
    <div className="payload-result" aria-live="polite">
      {error && <p className="ferr">{s('payload.error.' + error)}</p>}
      {busy && <p className="hint"><Icon n="refresh" /> {s('payload.running')}</p>}
      {report ? <>
        <p className="hint">{s('payload.last', { name: snap.profiles.find(p => p.id === report.profileId)?.name ?? s('payload.deleted'), at: new Date(report.at).toLocaleString() })}</p>
        <div className="kv">
          <span className="m">{s('payload.download')}</span><span>{stageText(report.download)}</span>
          <span className="m">{s('payload.upload')}</span><span>{stageText(report.upload)}</span>
        </div>
      </> : !busy && !error && <p className="hint">{s('payload.no_result')}</p>}
    </div>
  </section>
}
