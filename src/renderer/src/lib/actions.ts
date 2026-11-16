import type { Settings } from '../../../shared/types'

/** A failed save stays in the current flow; callers must not navigate as though it succeeded. */
export type SettingsPatch = (patch: Partial<Settings>) => Promise<boolean>
