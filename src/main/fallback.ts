import type { FbGroup } from './awg'

export const FB_N = 3

export interface FbState { g: FbGroup; on: boolean; fail: number; ok: number }
export interface FbSwitch { g: FbGroup; toFb: boolean }

export class FbTracker {
  states: FbState[]

  constructor(groups: FbGroup[], private n = FB_N) {
    this.states = groups.map(g => ({ g, on: false, fail: 0, ok: 0 }))
  }

  async step(pings: Record<string, number | undefined>, apply: (g: FbGroup, toFb: boolean) => Promise<boolean>): Promise<FbSwitch[]> {
    const done: FbSwitch[] = []
    for (const st of this.states) {
      const mainUp = pings[st.g.main] !== undefined
      const fbUp = pings[st.g.fb] !== undefined
      if (!st.on) {
        st.fail = mainUp ? 0 : st.fail + 1
        if (st.fail >= this.n && fbUp && (await apply(st.g, true))) { st.on = true; st.ok = 0; done.push({ g: st.g, toFb: true }) }
      } else {
        st.ok = mainUp ? st.ok + 1 : 0
        if (st.ok >= this.n && (await apply(st.g, false))) { st.on = false; st.fail = 0; done.push({ g: st.g, toFb: false }) }
      }
    }
    return done
  }

  active(): FbGroup[] {
    return this.states.filter(x => x.on).map(x => x.g)
  }
}
