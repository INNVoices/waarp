export interface RuntimeChangeState {
  open: boolean
  revision: number
  phase: string
  session: object | number
}

/** Consent belongs to one master intent and one native session, including idle.
 * A successful answer from an obsolete dialog must never authorize new work. */
export async function confirmRuntimeChange(
  state: () => RuntimeChangeState,
  ask: (before: RuntimeChangeState) => Promise<boolean>
): Promise<boolean> {
  const before = state()
  if (!before.open || (before.phase !== 'on' && before.phase !== 'off')) return false
  try { if (!await ask(before)) return false }
  catch { return false }
  const after = state()
  return after.open && after.revision === before.revision &&
    after.phase === before.phase && after.session === before.session
}
