// Group = several tunnels used as one. No text: pick members by clicking, pick the policy, the name is made for you.
import { useState } from 'react'
import type { Group, GroupPolicy, ProfileView } from '../../../shared/types'
import { groupName, newGroupId, POLICIES } from '../../../shared/groups'
import { Btn, Icon, Plain, Seg } from '../ui/kit'
import { Modal } from '../ui/modal'
import { s } from '../lib/i18n'
import { Mark } from '../parts'

export function GroupDialog({ tunnels, groups, edit, onSave, onClose }: {
  tunnels: ProfileView[]; groups: Group[]; edit?: Group; onSave: (g: Group) => void; onClose: () => void
}) {
  const [members, setMembers] = useState<string[]>(edit?.members.filter(m => tunnels.some(t => t.id === m)) ?? [])
  const [policy, setPolicy] = useState<GroupPolicy>(edit?.policy ?? 'fastest')
  const toggle = (id: string) => setMembers(m => (m.includes(id) ? m.filter(x => x !== id) : [...m, id]))
  const ready = members.length >= 2
  return (
    <Modal title={s(edit ? 'grp.edit' : 'grp.new')} onClose={onClose}>
      <div className="wz-body">
        <div className="vgrid one">
          {tunnels.map(t => {
            const i = members.indexOf(t.id)
            return (
              <Plain key={t.id} className={'vopt' + (i >= 0 ? ' on' : '')} onClick={() => toggle(t.id)} aria-pressed={i >= 0}>
                <span className={'check' + (i >= 0 ? ' on' : '')}>{i >= 0 && (policy === 'first' ? <b>{i + 1}</b> : <Icon n="check" s={12} />)}</span>
                <span className="vo-t"><span className="vo-n"><Mark profiles={tunnels} via={t.id} /><span className="ell">{t.name}</span></span><small className="m ell">{`${t.version} · ${t.host}`}</small></span>
              </Plain>
            )
          })}
        </div>
        <div className="grp-pol">
          <Seg<GroupPolicy> value={policy} items={POLICIES.map(p => ({ v: p, label: s('grp.pol.' + p) }))} onChange={setPolicy} />
          <span className="hint">{s('grp.pol.' + policy + '.hint')}</span>
        </div>
        <div className="wz-foot">
          <Btn kind="ghost" onClick={onClose}>{s('set.cancel')}</Btn>
          <div className="grow" />
          {!ready && <span className="hint">{s('grp.need')}</span>}
          <Btn kind="primary" disabled={!ready} onClick={() => { onSave({ id: edit?.id ?? newGroupId(), name: edit?.name ?? groupName(groups), policy, members }); onClose() }}><Icon n="check" />{s(edit ? 'grp.save' : 'grp.create')}</Btn>
        </div>
      </div>
    </Modal>
  )
}
