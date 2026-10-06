import type { Status } from '../../../shared/types'

export type MasterPending = 'opening' | 'closing' | undefined
export type MasterMode = 'closed' | 'opening' | 'open' | 'idle' | 'applying' | 'closing' | 'error'

export interface MasterPresentation {
  mode: MasterMode
  pressed: boolean
  topKey: string
}

/**
 * Global Waarp intent is not the same thing as the core process phase.
 * Internal rule/DNS rebuilds may stop/start the core while the owner-facing
 * master remains open. Keep that distinction in one pure presentation helper.
 */
export function masterPresentation(status: Status, pending?: MasterPending): MasterPresentation {
  if (pending === 'opening') return { mode: 'opening', pressed: true, topKey: 'top.starting' }
  if (pending === 'closing') return { mode: 'closing', pressed: false, topKey: 'top.stopping' }

  if (status.open === true) {
    if (status.phase === 'off') return { mode: 'idle', pressed: true, topKey: 'top.idle' }
    if (status.phase === 'starting' || status.phase === 'stopping') return { mode: 'applying', pressed: true, topKey: 'top.applying' }
    if (status.phase === 'error') return { mode: 'error', pressed: true, topKey: 'top.on' }
    return { mode: 'open', pressed: true, topKey: 'top.on' }
  }

  if (status.phase === 'error') return { mode: 'error', pressed: false, topKey: 'top.off' }
  return { mode: 'closed', pressed: false, topKey: 'top.off' }
}

export interface OrbPresentation {
  phaseClass: Status['phase']
  titleKey: string
  subKey?: string
}

/** Same split for the Home hero. A core rebuild is "applying", not a global close/open cycle. */
export function orbPresentation(status: Status): OrbPresentation {
  if (status.open === true && status.phase === 'off')
    return { phaseClass: 'on', titleKey: 'orb.on', subKey: 'orb.idle.sub' }
  if (status.open === true && (status.phase === 'starting' || status.phase === 'stopping'))
    return { phaseClass: 'starting', titleKey: 'orb.applying', subKey: 'orb.applying.sub' }

  const normal: Record<Status['phase'], [string, string?]> = {
    off: ['orb.off', 'orb.off.sub'],
    starting: ['orb.starting', 'orb.starting.sub'],
    on: ['orb.on'],
    stopping: ['orb.stopping'],
    error: ['orb.error', 'orb.error.sub']
  }
  const [titleKey, subKey] = normal[status.phase]
  return { phaseClass: status.phase, titleKey, subKey }
}
