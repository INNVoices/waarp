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
  if (!masterOpen) return { active: false, tooltip: 'Waarp: закрыт', action: 'connect' }

  if (status.phase === 'on') {
    const tooltip = usedNames.length
      ? `Waarp: открыт · ${usedNames.join(', ')}`
      : 'Waarp: открыт · отсутствующие маршруты заблокированы'
    return { active: true, tooltip, action: 'disconnect' }
  }

  if (status.phase === 'starting' || status.phase === 'stopping')
    return { active: true, tooltip: 'Waarp: открыт · применяю маршруты', action: 'disconnect' }

  if (status.phase === 'error')
    return { active: true, tooltip: `Waarp: открыт · ${status.error ?? 'ошибка движка'}`, action: 'disconnect' }

  return { active: true, tooltip: 'Waarp: открыт · сейчас ни одна карточка не идёт через сервер', action: 'disconnect' }
}
