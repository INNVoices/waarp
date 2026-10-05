// Туннели: own tunnels, groups, and the sources that are coming ("скоро", never pretending to work). No text boxes:
// tunnels come in through "+ Туннель", groups are made by picking tunnels.
import { useState } from 'react'
import type { Group, ProfileView, Settings, Snapshot, Status } from '../../../shared/types'
import { dropGroup, usersOf } from '../../../main/store-core'
import { Modal } from '../ui/modal'
import { Area, Btn, Icon, Input, Plain, Tooltip } from '../ui/kit'
import { s, sp } from '../lib/i18n'
import { api } from '../bridge'
import { Mark, Ping } from '../parts'
import { AddTunnel, importNote, type ImportResult } from './addtunnel'
import { GroupDialog } from './groupdlg'

const COMING = ['warp'] as const

export function Servers({ snap, status, patch, toast }: { snap: Snapshot; status: Status; patch: (p: Partial<Settings>) => void; toast: (x: string) => void }) {
  const [edit, setEdit] = useState<string>()
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [grp, setGrp] = useState<{ edit?: Group }>()
  const [del, setDel] = useState<ProfileView>()
  const [replacing, setReplacing] = useState<ProfileView>()
  const [replacement, setReplacement] = useState('')
  const [replaceError, setReplaceError] = useState('')
  const [replaceBusy, setReplaceBusy] = useState(false)
  const [subBusy, setSubBusy] = useState<string>()
  const [visibleOwn, setVisibleOwn] = useState(24)
  const [query, setQuery] = useState('')
  const live = status.phase === 'on'
  const st = snap.settings
  const own = snap.profiles.filter(p => p.kind !== 'group')
  const filteredOwn = query.trim() ? own.filter(p => `${p.name} ${p.host} ${p.version}`.toLowerCase().includes(query.trim().toLowerCase())) : own
  const available = own.filter(p => !p.revoked)
  const groups = snap.profiles.filter(p => p.kind === 'group')
  const uses = (id: string) => st.routes.filter(r => r.via === id).length + (st.rest === id ? 1 : 0)
  const nameOf = (id: string) => own.find(p => p.id === id)?.name ?? s('via.gone')
  const rename = async (p: ProfileView) => {
    if (p.kind === 'group') { const n = name.trim().slice(0, 40); if (n) patch({ groups: st.groups.map(g => (g.id === p.id ? { ...g, name: n } : g)) }) }
    else {
      try { const result = await api.renameProfile(p.id, name); if (result?.error) toast(result.error) }
      catch { toast(s('srv.save.error')) }
    }
    setEdit(undefined)
  }
  const nameCell = (p: ProfileView) => edit === p.id
    ? <Input autoFocus className="inp" value={name} onChange={e => setName(e.target.value)} onBlur={() => void rename(p)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEdit(undefined) }} />
    : <Tooltip tip={p.name}><b className="srv-n ell">{p.name}</b></Tooltip>
  // C08: tunnel health is its own fact (ok / degraded / down / busy), measured by the tunnel or the local checker
  const ping = (p: ProfileView) => {
    if (p.revoked) return <span className="health down">{s('via.revoked')}</span>
    const h = status.health?.[p.id]
    if (h && h !== 'unknown') return <Tooltip tip={s('health.' + h + '.tip')}><span className={'health ' + h}>{h === 'ok' && status.pings[p.id] !== undefined ? s('meter.ms', { n: status.pings[p.id]! }) : s('health.' + h)}</span></Tooltip>
    return live && uses(p.id) > 0 ? <Ping ms={status.pings[p.id]} live down={status.health?.[p.id] === 'down'} /> : <span className="m">{live ? s('srv.ping.unused') : s('srv.ping.closed')}</span>
  }
  const foot = (p: ProfileView, onEdit?: () => void) => (
    <div className="srv-foot">
      <span className="m">{uses(p.id) ? sp('srv.uses', uses(p.id)) : s('srv.unused')}</span>
      <div className="grow" />
      {onEdit && <Btn kind="ghost" title={s('grp.edit')} onClick={onEdit}><Icon n="apps" /></Btn>}
      {p.subscription && <Btn kind="ghost" disabled={live || !!subBusy} title={live ? s('srv.sub.stop') : s('srv.sub.refresh')} onClick={async () => {
        setSubBusy(p.id)
        try {
          const r = await api.refreshSubscription(p.id)
          toast(r.ok ? s('srv.sub.done', { u: r.updated ?? 0, a: r.added ?? 0, m: r.missing ?? 0 }) : r.error)
        } catch { toast(s('srv.sub.error')) }
        finally { setSubBusy(undefined) }
      }}><span className={subBusy === p.id ? 'spin' : ''}><Icon n="refresh" /></span></Btn>}
      {p.kind !== 'group' && !p.subscription && p.source !== 'managed' && p.source !== 'public' && p.source !== 'warp' && <Btn kind="ghost" title={s('srv.replace')} onClick={() => { setReplacing(p); setReplacement(''); setReplaceError('') }}><Icon n="refresh" /></Btn>}
      <Btn kind="ghost" title={p.source === 'managed' ? s('srv.managed.locked') : p.source === 'public' ? s('srv.public.locked') : s('set.rename')} disabled={p.source === 'managed' || p.source === 'public'} onClick={() => { setEdit(p.id); setName(p.name) }}><Icon n="edit" /></Btn>
      <Btn kind="danger" title={p.source === 'managed' ? s('srv.managed.locked') : s('set.remove')} disabled={p.source === 'managed'} onClick={() => setDel(p)}><Icon n="trash" /></Btn>
    </div>
  )
  // C03: deleting a used tunnel shows its cards first; they get a replacement or stay blocked, never silently direct
  const remove = async (p: ProfileView, replace?: string) => {
    if (p.kind === 'group') patch(dropGroup(st, p.id, replace))
    else {
      try {
        const result = await api.removeProfile(p.id, replace)
        if (result?.error) { toast(result.error); return }
        if (result?.warning) toast(result.warning)
      }
      catch { toast(s('srv.save.error')); return }
    }
    setDel(undefined)
  }
  const delDlg = del && (() => {
    const u = usersOf(st, del.id)
    const others = snap.profiles.filter(x => !x.revoked && x.id !== del.id && !(x.kind === 'group' && x.members?.includes(del.id) && x.members.length === 1))
    const n = u.cards.length + (u.rest ? 1 : 0) + (u.all ? 1 : 0)
    return (
      <Modal title={s('del.title', { v: del.name })} onClose={() => setDel(undefined)}>
        {n === 0 ? <p className="lead">{s('del.unused')}</p> : <>
          <p className="lead">{sp('del.used', n)}</p>
          <ul className="del-list">{u.cards.map(c => <li key={c} className="ell">{c}</li>)}{u.rest && <li>{s('rest.label')}</li>}{u.all && <li>{s('del.all')}</li>}</ul>
          <p className="hint">{s('del.how')}</p>
          <div className="del-opts">
            {others.map(o => <Btn key={o.id} onClick={() => void remove(del, o.id)}><Mark profiles={snap.profiles} via={o.id} />{s('del.to', { v: o.name })}</Btn>)}
          </div>
        </>}
        <div className="modal-foot">
          <Btn onClick={() => setDel(undefined)}>{s('del.cancel')}</Btn>
          <Btn kind="danger" onClick={() => void remove(del)}><Icon n="trash" />{n ? s('del.block') : s('set.remove')}</Btn>
        </div>
      </Modal>
    )
  })()
  const replace = async (file: boolean) => {
    if (!replacing || replaceBusy) return
    setReplaceBusy(true); setReplaceError('')
    try {
      const result: { ok: boolean; error?: string; warning?: string; canceled?: boolean } = await api.replaceProfile(replacing.id, file ? { file: true } : { text: replacement })
      if (result.ok) { setReplacing(undefined); setReplacement(''); toast(result.warning ?? s('srv.replace.done')) }
      else if (!result.canceled) setReplaceError(result.error ?? s('add.find.error'))
    } catch { setReplaceError(s('add.find.error')) }
    finally { setReplaceBusy(false) }
  }
  return (
    <div className="page">
      {delDlg}
      {replacing && <Modal title={s('srv.replace')} onClose={() => { if (!replaceBusy) setReplacing(undefined) }}>
        <p className="lead">{replacing.name}</p>
        <p className="hint">{s('srv.replace.note')}</p>
        <Area className="selectable mono wz-area" spellCheck={false} placeholder={s(replacing.kind === 'awg' ? 'srv.replace.awg' : replacing.kind === 'openvpn' ? 'srv.replace.openvpn' : 'srv.replace.link')} value={replacement} onChange={e => { setReplacement(e.target.value); setReplaceError('') }} />
        {replaceError && <div className="ferr">{replaceError}</div>}
        <div className="wz-foot">
          <Btn disabled={replaceBusy} onClick={() => void replace(true)}><Icon n="file" />{s('srv.replace.file')}</Btn>
          <div className="grow" />
          <Btn kind="primary" disabled={replaceBusy || !replacement.trim()} onClick={() => void replace(false)}><Icon n="check" />{s('srv.replace.paste')}</Btn>
        </div>
      </Modal>}
      <div className="page-head">
        <h1>{s('srv.title')}</h1>
        <div className="grow" />
        {available.length < 2 && <span className="hint">{s('grp.need.tunnels')}</span>}
        <Btn disabled={available.length < 2} onClick={() => setGrp({})}><Icon n="apps" />{s('grp.add')}</Btn>
        <Btn kind="primary" onClick={() => setAdding(true)}><Icon n="plus" />{s('srv.add')}</Btn>
      </div>
      <p className="lead">{s('srv.lead')}</p>

      <div className="sec-head"><h2>{s('srv.mine')}</h2><span className="m">{own.length}</span><div className="grow" />{own.length > 24 && <Input className="inp srv-search" value={query} placeholder={s('srv.search')} onChange={e => { setQuery(e.target.value); setVisibleOwn(24) }} />}</div>
      {!own.length && (
        <div className="panel emptyst"><Icon n="server" s={24} /><span>{s('srv.empty')}</span><Btn kind="primary" onClick={() => setAdding(true)}><Icon n="plus" />{s('srv.add')}</Btn></div>
      )}
      <div className="srv-grid">
        {filteredOwn.slice(0, visibleOwn).map(p => (
          <div key={p.id} className="panel srv">
            <div className="srv-top">
              <Mark profiles={snap.profiles} via={p.id} />
              {nameCell(p)}
              {p.source === 'managed' && <i className="badge">{s('srv.managed')}</i>}
              {p.subscriptionMissing && <i className="badge warn">{s('srv.sub.missing')}</i>}
              <div className="grow" />
            </div>
            {/* name -> protocol -> live state; raw endpoint fields only under Подробнее (GPT 440a5c3) */}
            <div className="srv-proto">{p.version || s('srv.kind.' + p.kind)}</div>
            <div className="srv-state">{ping(p)}</div>
            <details className="srv-adv"><summary>{s('srv.adv')}</summary><div className="kv mono">
              <span className="m">{s('srv.host')}</span><span className="selectable ell">{`${p.host}:${p.port}`}</span>
              {p.address.length > 0 && <><span className="m">{s('srv.addr')}</span><span className="selectable ell">{p.address.join(', ')}</span></>}
              {p.clientPublicKey && <><span className="m">{s('add.create.clientKey')}</span><Tooltip tip={p.clientPublicKey}><span className="selectable ell mono">{p.clientPublicKey}</span></Tooltip></>}
              <span className="m">{s('srv.proto')}</span><span>{p.version}</span>
            </div></details>
            {foot(p)}
          </div>
        ))}
      </div>
      {!!own.length && !filteredOwn.length && <div className="panel emptyst"><Icon n="search" s={20} /><span>{s('srv.search.empty')}</span></div>}
      {visibleOwn < filteredOwn.length && <div className="srv-more"><Btn kind="ghost" onClick={() => setVisibleOwn(n => n + 24)}>{s('srv.more', { n: Math.min(24, filteredOwn.length - visibleOwn) })}</Btn></div>}

      {groups.length > 0 && <>
        <div className="sec-head"><h2>{s('srv.groups')}</h2><span className="m">{groups.length}</span></div>
        <div className="srv-grid">
          {groups.map(p => (
            <div key={p.id} className="panel srv">
              <div className="srv-top">
                <Mark profiles={snap.profiles} via={p.id} />
                {nameCell(p)}
                <i className="badge">{s('grp.pol.' + p.policy)}</i>
                <div className="grow" />
              </div>
              <div className="kv mono"><span className="m">{s('srv.ping')}</span><span>{ping(p)}</span></div>
              <div className="chips">{(p.members ?? []).map((m, i) => <span key={m} className="chip">{p.policy === 'first' ? `${i + 1}. ` : ''}{nameOf(m)}</span>)}</div>
              {foot(p, () => setGrp({ edit: st.groups.find(g => g.id === p.id) }))}
            </div>
          ))}
        </div>
      </>}

      <div className="sec-head"><h2>{s('srv.soon')}</h2></div>
      <div className="srv-grid">
        {COMING.map(k => (
          <Plain key={k} className="panel srv soon" disabled tip={s('add.soon.' + k)}>
            <div className="srv-top"><span className="wz-ic"><Icon n="bolt" s={20} /></span><b className="srv-n">{s('add.' + k)}</b><div className="grow" /><i className="badge">{s('add.soon')}</i></div>
            <span className="hint">{s('srv.soon.' + k)}</span>
          </Plain>
        ))}
      </div>

      {adding && <AddTunnel onClose={() => setAdding(false)} onAdded={(r: ImportResult) => toast(importNote(r))}
        onPublic={() => { setAdding(false); requestAnimationFrame(() => document.getElementById('public-catalog')?.scrollIntoView({ behavior: 'smooth' })) }} />}
      {grp && <GroupDialog tunnels={available} groups={st.groups} edit={grp.edit} onClose={() => setGrp(undefined)}
        onSave={g => patch({ groups: st.groups.some(x => x.id === g.id) ? st.groups.map(x => (x.id === g.id ? g : x)) : [...st.groups, g] })} />}
    </div>
  )
}
