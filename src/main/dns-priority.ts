interface Prefix { children: Map<string, Prefix>; owner?: { suffix: string; target: string } }

/** A domain suffix owns its entire subtree for later cards. Keep only overlapping
 * exclusions; copying a 50k source into every later unrelated rule is unnecessary
 * and can make an otherwise small route edit allocate hundreds of megabytes. */
export class DnsPriority {
  private root: Prefix = { children: new Map() }
  claim(domains: readonly string[], target: string): { domains: string[]; excludes: string[] } {
    const accepted: string[] = [], excluded = new Set<string>()
    const earlierOther = (node: Prefix) => {
      if (node.owner && node.owner.target !== target) { excluded.add(node.owner.suffix); return }
      for (const child of node.children.values()) earlierOther(child)
    }
    for (const value of domains) {
      const suffix = value.toLowerCase().replace(/^\./, '').replace(/\.$/, '')
      let node = this.root, covered = false
      for (const label of suffix.split('.').reverse()) {
        if (node.owner) { covered = true; break }
        let child = node.children.get(label)
        if (!child) { child = { children: new Map() }; node.children.set(label, child) }
        node = child
      }
      if (covered || node.owner) continue
      earlierOther(node)
      node.owner = { suffix, target }
      accepted.push(suffix)
    }
    return { domains: accepted, excludes: [...excluded] }
  }
}
