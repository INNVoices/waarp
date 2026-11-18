/** A short reject barrier protects edited paths while independent native watchers
 * load their rule files. It never closes a connection or changes user routing. */
export function routeEditGuard(
  before: Record<string, string>, after: Record<string, string>, switches: readonly { tag: string }[]
): string {
  const changed = Object.keys(after).filter(tag => tag !== 'apply-guard' && before[tag] !== after[tag])
  const slots = new Set<string>()
  for (const tag of changed) {
    const slot = /^[rxfv]([ad]\d+)$/.exec(tag)
    if (slot) slots.add(slot[1])
  }
  for (const change of switches) {
    const slot = /^rt-([ad]\d+)$/.exec(change.tag)
    if (slot) slots.add(slot[1])
  }
  const rules: Record<string, unknown>[] = []
  const read = (files: Record<string, string>, tag: string) => {
    if (files[tag]) rules.push(...JSON.parse(files[tag]).rules)
  }
  for (const slot of slots) for (const files of [before, after]) for (const prefix of ['r', 'x']) read(files, prefix + slot)
  if (changed.includes('bypass-ru')) for (const files of [before, after]) read(files, 'bypass-ru')
  if (switches.some(change => change.tag === 'rest-sel') || changed.some(tag => tag.startsWith('rest-'))) {
    // Global-route changes affect otherwise unmatched traffic. Existing streams
    // continue; this barrier applies only while a new routing decision is made.
    rules.push({ network: ['tcp', 'udp'] }, { domain_regex: ['.*'] })
  }
  return JSON.stringify({ version: 3, rules: [...new Map(rules.map(rule => [JSON.stringify(rule), rule])).values()] })
}
