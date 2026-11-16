import type { Settings } from '../../../shared/types'

/** A failed save stays in the current flow; callers must not navigate as though it succeeded. */
export type SettingsPatch = (patch: Partial<Settings>) => Promise<boolean>

/** Untyped main-process messages stay informational; only an explicit success gets a checkmark. */
export type ToastKind = 'info' | 'success' | 'error'
export type Toast = (text: string, kind?: ToastKind) => void
