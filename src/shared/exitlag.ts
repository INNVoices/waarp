/** External Windows client. This is NOT a sing-box proxy/outbound or an ExitLag API. */
export const EXITLAG_VIA = 'external:exitlag' as const

export interface ExitLagSelection {
  appId: number
  selectedServer: string
  country: string
  alias: string
  enabled: boolean
  automatic: boolean
}

export interface ExitLagSnapshot {
  installed: boolean
  running: boolean
  checkedAt: number
  selections: ExitLagSelection[]
  /** The local database contains saved selections, not a global provider catalog. */
  completeCatalog: false
  error?: string
}

export interface ExitLagVisibleCatalog {
  screenOpen: boolean
  region?: string
  names: string[]
  /** UI Automation exposes display names only, often duplicated, not server IDs. */
  complete: false
  error?: string
}
