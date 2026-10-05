// A companion app asked to route its target through a concrete Waarp path and none is chosen yet. Main holds the
// validated target; the user picks the path here. Nothing is written until a choice, and choosing never opens the tunnel.
import type { Snapshot, Via } from '../../../shared/types'
import { pickOptions } from '../../../shared/companion'
import { Btn, Icon, Plain } from '../ui/kit'
import { Modal } from '../ui/modal'
import { s } from '../lib/i18n'
import { api } from '../bridge'
import { Mark, subOf, viaName } from '../parts'

export interface Pick { id: string; name: string }

export function CompanionPick({ snap, pick, toast, done, manage }: { snap: Snapshot; pick: Pick; toast: (t: string) => void; done: (routeId?: string) => void; manage: () => void }) {
  const opts: Via[] = pickOptions(snap.settings, snap.profiles)
  const choose = async (v: Via) => { const r = await api.companionChoose(pick.id, v); if (r.ok) done(pick.id); if (r.error) toast(r.error) }
  return (
    <Modal title={pick.name} onClose={() => done()}>
      <div className="wz-body">
        <p className="hint">{s('companion.pick.lead')}</p>
        {!opts.length && <div className="emptyst"><span>{s('companion.pick.none')}</span><Btn kind="primary" onClick={() => { done(); manage() }}><Icon n="plus" />{s('srv.add')}</Btn></div>}
        <div className="vgrid">
          {opts.map(v => (
            <Plain key={v} className="vopt" onClick={() => void choose(v)}>
              <span className="radio" />
              <span className="vo-t"><span className="vo-n"><Mark profiles={snap.profiles} via={v} />{viaName(snap.profiles, v)}</span>
                <small className="m ell">{subOf(snap.profiles.find(p => p.id === v))}</small></span>
            </Plain>
          ))}
        </div>
      </div>
    </Modal>
  )
}
