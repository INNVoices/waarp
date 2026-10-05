// "+ Туннель": one dialog of big choices; the only text box lives under "Вручную". Clipboard is read when it opens and
// previewed as name + host + protocol (never a key). Tiles for sources that do not exist yet say "скоро" and what is coming.
import { useEffect, useState } from 'react'
import { Area, Btn, Icon, Input, Plain, Seg, Toggle, Field } from '../ui/kit'
import { Modal } from '../ui/modal'
import { s } from '../lib/i18n'
import { api } from '../bridge'

export interface ImportResult { ok: boolean; error?: string; added?: number; id?: string; ids?: string[]; name?: string; skipped?: number; notApplied?: string[]; clientPublicKey?: string }
interface Peek { kind: 'awg' | 'openvpn' | 'vless' | 'sub' | 'other' | 'none'; name?: string; host?: string; version?: string; count?: number }

interface Found { id: string; name: string; version: string; host: string; source: string }
type Step = 'pick' | 'found' | 'clip' | 'manual' | 'sub' | 'create' | 'done'
const SOON = ['warp', 'own'] as const
const SOON_ICON: Record<(typeof SOON)[number], string> = { warp: 'bolt', own: 'server' }

export function importNote(r?: ImportResult) {
  const base = r && ((r.added ?? 0) > 1 || r.skipped) ? s('imp.sub.done', { a: r.added ?? 0, b: r.skipped ?? 0 }) : s('imp.done')
  return r?.notApplied?.length ? base + ' · ' + s('imp.note', { v: r.notApplied.join(', ') }) : base
}

export function AddTunnel({ onClose, onAdded, onPublic, onAutoFindDone, autoFind = false, initialClip = false }: { onClose: () => void; onAdded: (r: ImportResult) => void; onPublic: () => void; onAutoFindDone?: () => void; autoFind?: boolean; initialClip?: boolean }) {
  const [step, setStep] = useState<Step>(initialClip ? 'clip' : 'pick')
  const [peek, setPeek] = useState<Peek>()
  const [text, setText] = useState('')
  const [wg, setWg] = useState({ name: '', address: '', endpoint: '', serverPublicKey: '' })
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ImportResult>()
  const [found, setFound] = useState<Found[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => { void api.clipPeek().then((p: Peek) => setPeek(p)).catch(() => setPeek({ kind: 'none' })) }, [])

  const run = async (from: { text?: string; file?: boolean; clipboard?: boolean }) => {
    setErr(undefined); setBusy(true)
    try {
      const r: ImportResult = await api.importProfile(from)
      if (r.ok) { setRes(r); setStep('done'); onAdded(r) } else if (r.error) setErr(r.error)
    } finally { setBusy(false) }
  }
  const create = async () => {
    setErr(undefined); setBusy(true)
    try {
      const r: ImportResult = await api.createWireGuard(wg)
      if (r.ok) { setRes(r); setStep('done'); onAdded(r) } else setErr(r.error)
    } catch { setErr(s('add.find.error')) }
    finally { setBusy(false) }
  }
  const scanQr = async () => {
    setErr(undefined); setBusy(true)
    try {
      const r = await api.scanQr()
      if (!r.ok || !r.token) { setErr(r.error ?? s('add.qr.error')); return }
      const added: ImportResult = await api.importProfile({ qrToken: r.token })
      if (added.ok) { setRes(added); setStep('done'); onAdded(added) } else setErr(added.error)
    } catch { setErr(s('add.qr.error')) }
    finally { setBusy(false) }
  }

  const find = async () => {
    setErr(undefined); setBusy(true)
    try {
      const r = await api.discoverScan()
      if (!r.ok) { setErr(r.error); return }
      // A first-run scan is complete only after main returned a successful, bounded result.
      // Closing the dialog while it is still running (or after an error) must offer it again next launch.
      onAutoFindDone?.()
      setFound(r.items ?? []); setSelected(new Set((r.items ?? []).map((x: Found) => x.id))); setStep('found')
    } catch { setErr(s('add.find.error')) } finally { setBusy(false) }
  }
  const pickFolder = async () => {
    setErr(undefined); setBusy(true)
    try {
      const r = await api.discoverPickFolder()
      if (r.canceled) return
      if (!r.ok) { setErr(r.error ?? s('add.find.error')); return }
      setFound(r.items ?? []); setSelected(new Set((r.items ?? []).map((x: Found) => x.id))); setStep('found')
    } catch { setErr(s('add.find.error')) }
    finally { setBusy(false) }
  }
  const addFound = async () => {
    setErr(undefined); setBusy(true)
    try {
      const r: ImportResult = await api.discoverAdd([...selected])
      if (r.ok) { setRes(r); setStep('done'); onAdded(r) } else setErr(r.error)
    } catch { setErr(s('add.find.error')) } finally { setBusy(false) }
  }
  useEffect(() => { if (autoFind) void find() }, [])

  const clipOk = !!peek && peek.kind !== 'none'
  const clipSub = !peek ? s('add.clip.wait') : clipOk ? [s('add.clip.' + peek.kind), peek.host].filter(Boolean).join(' · ') : s('add.clip.none')

  return (
    <Modal title={s(step === 'done' ? 'add.done.title' : step === 'sub' ? 'add.sub' : 'add.title')} onClose={onClose} wide={step === 'pick' || step === 'found'}>
      {step === 'pick' && (
        <div className="wz-body">
        {/* W1 one Add flow (GPT 440a5c3): Буфер / Файл / QR / Подписка / Найти на ПК / Вручную; low-trust sources apart */}
        <div className="wz-grid">
          <Plain className={'wz-tile' + (clipOk ? ' hot' : '')} disabled={!clipOk} onClick={() => setStep('clip')}>
            <span className="wz-ic"><Icon n="paste" s={20} /></span><b>{s('add.clip')}</b><small>{clipSub}</small>
          </Plain>
          <Plain className="wz-tile" disabled={busy} onClick={() => void run({ file: true })}><span className="wz-ic"><Icon n="file" s={20} /></span><b>{s('add.file')}</b><small>{s('add.file.sub')}</small></Plain>
          <Plain className="wz-tile" disabled={busy} onClick={() => void scanQr()}><span className="wz-ic"><Icon n="qr" s={20} /></span><b>{s('add.qr')}</b><small>{s('add.qr.sub')}</small></Plain>
          <Plain className="wz-tile" onClick={() => { setText(''); setStep('sub') }}><span className="wz-ic"><Icon n="subscription" s={20} /></span><b>{s('add.sub')}</b><small>{s('add.sub.sub')}</small></Plain>
          <Plain className="wz-tile" disabled={busy} onClick={() => void find()}><span className="wz-ic"><Icon n="search" s={20} /></span><b>{s('add.find')}</b><small>{s('add.find.sub')}</small></Plain>
          <Plain className="wz-tile" onClick={() => setStep('manual')}><span className="wz-ic"><Icon n="edit" s={20} /></span><b>{s('add.manual')}</b><small>{s('add.manual.sub')}</small></Plain>
        </div>
        <div className="sec-head"><h3>{s('add.other')}</h3></div>
        <div className="wz-grid other">
          <Plain className="wz-tile" onClick={onPublic}><span className="wz-ic"><Icon n="globe" s={20} /></span><b>{s('add.public')}</b><small>{s('add.public.sub')}</small></Plain>
          {SOON.map(k => (
            <Plain key={k} className="wz-tile soon" disabled tip={s('add.soon.' + k)}><span className="wz-ic"><Icon n={SOON_ICON[k]} s={20} /></span><b>{s('add.' + k)}</b><small>{s('add.soon')}</small></Plain>
          ))}
        </div>
        </div>
      )}
      {step === 'pick' && err && <div className="ferr">{err}</div>}

      {step === 'found' && <div className="wz-body">
        <p className="hint">{s('add.find.note')}</p>
        {found.length ? <div className="wz-results">{found.map(item => (
          <div className="wz-prev" key={item.id}>
            <Toggle on={selected.has(item.id)} label={item.name} onChange={on => setSelected(prev => { const next = new Set(prev); if (on) next.add(item.id); else next.delete(item.id); return next })} />
            <div className="wz-pt"><b className="ell">{item.name}</b><span className="m ell">{item.version} · {item.host} · {item.source}</span></div>
          </div>
        ))}</div> : <p className="lead">{s('add.find.empty')}</p>}
        {err && <div className="ferr">{err}</div>}
          <div className="wz-foot"><Btn kind="ghost" onClick={() => setStep('pick')}><Icon n="back" />{s('nav.back')}</Btn><div className="grow" /><Btn kind="ghost" disabled={busy} onClick={() => void pickFolder()}><Icon n="folder" />{s('add.find.folder')}</Btn><Btn kind="ghost" disabled={busy} onClick={() => void find()}><Icon n="refresh" />{s('add.find.again')}</Btn><Btn kind="primary" disabled={busy || !selected.size} onClick={() => void addFound()}><Icon n="check" />{s('add.find.all')}</Btn></div>
      </div>}

      {step === 'clip' && peek && (
        <div className="wz-body">
          <div className="wz-prev">
            <span className="wz-ic"><Icon n={peek.kind === 'sub' ? 'globe' : 'server'} s={20} /></span>
            <div className="wz-pt">
              <b className="ell">{peek.kind === 'sub' ? s('add.clip.sub') : (peek.name ?? '')}</b>
              <span className="m ell mono">{[peek.host, peek.version].filter(Boolean).join(' · ')}</span>
              {(peek.count ?? 0) > 1 && <span className="m">{s('add.clip.count', { n: peek.count ?? 0 })}</span>}
            </div>
          </div>
          <p className="hint">{s('add.clip.note')}</p>
          {err && <div className="ferr">{err}</div>}
          <div className="wz-foot">
            <Btn kind="ghost" onClick={() => { setStep('pick'); setErr(undefined) }}><Icon n="back" />{s('nav.back')}</Btn>
            <div className="grow" />
            <Btn kind="primary" disabled={busy} onClick={() => void run({ clipboard: true })}><Icon n="check" />{s('imp.add')}</Btn>
          </div>
        </div>
      )}

      {step === 'sub' && (
        <div className="wz-body">
          {/* same importer as Вручную; its own intent: one link that keeps the list updated */}
          <p className="hint">{s('add.sub.hint')}</p>
          <Field icon="subscription" autoFocus spellCheck={false} placeholder={s('add.sub.ph')} value={text} onChange={e => { setText(e.target.value); setErr(undefined) }} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) void run({ text }) }} />
          {err && <div className="ferr">{err}</div>}
          <div className="wz-foot">
            <Btn kind="ghost" onClick={() => { setStep('pick'); setErr(undefined) }}><Icon n="back" />{s('nav.back')}</Btn>
            <div className="grow" />
            <Btn kind="primary" disabled={!text.trim() || busy} onClick={() => void run({ text })}><Icon n="check" />{s('imp.add')}</Btn>
          </div>
        </div>
      )}
      {step === 'manual' && (
        <div className="wz-body">
          <Seg value="paste" items={[{ v: 'paste', label: s('add.manual.paste') }, { v: 'create', label: s('add.manual.create') }]} onChange={v => { if (v === 'create') { setStep('create'); setErr(undefined) } }} />
          <Area className="selectable mono wz-area" spellCheck={false} placeholder={s('imp.placeholder')} value={text} onChange={e => { setText(e.target.value); setErr(undefined) }} />
          {err && <div className="ferr">{err}</div>}
          <div className="wz-foot">
            <Btn kind="ghost" onClick={() => { setStep('pick'); setErr(undefined) }}><Icon n="back" />{s('nav.back')}</Btn>
            <div className="grow" />
            {!text.trim() && <span className="hint">{s('add.manual.empty')}</span>}
            <Btn kind="primary" disabled={!text.trim() || busy} onClick={() => void run({ text })}><Icon n="check" />{s('imp.add')}</Btn>
          </div>
        </div>
      )}

      {step === 'create' && <div className="wz-body">
        <Seg value="create" items={[{ v: 'paste', label: s('add.manual.paste') }, { v: 'create', label: s('add.manual.create') }]} onChange={v => { if (v === 'paste') { setStep('manual'); setErr(undefined) } }} />
        <p className="hint">{s('add.create.note')}</p>
        {(['name', 'address', 'endpoint', 'serverPublicKey'] as const).map(k => <label key={k} className="wz-field">
          <span>{s('add.create.' + k)}</span>
          <Input className="inp mono" autoComplete="off" spellCheck={false} value={wg[k]} placeholder={s('add.create.ph.' + k)} onChange={e => { setWg({ ...wg, [k]: e.target.value }); setErr(undefined) }} />
        </label>)}
        {err && <div className="ferr">{err}</div>}
        <div className="wz-foot"><Btn kind="ghost" onClick={() => setStep('pick')}><Icon n="back" />{s('nav.back')}</Btn><div className="grow" /><Btn kind="primary" disabled={busy || Object.values(wg).some(v => !v.trim())} onClick={() => void create()}><Icon n="check" />{s('add.create.go')}</Btn></div>
      </div>}

      {step === 'done' && (
        <div className="wz-body wz-done">
          <span className="wz-ok"><Icon n="check" s={28} /></span>
          <b>{res?.name ?? s('imp.done')}</b>
          <span className="m">{importNote(res)}</span>
          {res?.clientPublicKey && <label className="wz-field"><span>{s('add.create.clientKey')}</span><Input className="inp mono selectable" readOnly value={res.clientPublicKey} onFocus={e => e.target.select()} /><small className="hint">{s('add.create.clientKey.note')}</small></label>}
          <Btn kind="primary" onClick={onClose}>{s('add.done.btn')}</Btn>
        </div>
      )}
    </Modal>
  )
}
