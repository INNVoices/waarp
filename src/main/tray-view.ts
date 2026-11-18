import { localized } from '../shared/localization'
import type { Status } from '../shared/types'

export interface TrayPresentation {
  active: boolean
  tooltip: string
  action: 'connect' | 'disconnect'
}

/**
 * Tray represents the owner's Waarp master intent, not transient core lifecycle.
 * Structural route rebuilds may stop/start the core while master remains open.
 */
export function trayPresentation(status: Status, masterOpen: boolean, usedNames: string[]): TrayPresentation {
  if (!masterOpen) return { active: false, tooltip: localized("winInline.tray-view.fcf61dd47cec"), action: 'connect' }

  if (status.phase === 'on') {
    const tooltip = usedNames.length
      ? localized("winInline.tray-view.cb209e14312e", usedNames.join(', '))
      : localized("winInline.tray-view.30fba34a1d98")
    return { active: true, tooltip, action: 'disconnect' }
  }

  if (status.phase === 'starting' || status.phase === 'stopping')
    return { active: true, tooltip: localized("winInline.tray-view.38b85ce1094f"), action: 'disconnect' }

  if (status.phase === 'error')
    return { active: true, tooltip: localized("winInline.tray-view.f60b76ac4e3f", status.error ?? localized("winInline.tray-view.b4dab46db24d")), action: 'disconnect' }

  return { active: true, tooltip: localized("winInline.tray-view.2b2c330a523d"), action: 'disconnect' }
}
