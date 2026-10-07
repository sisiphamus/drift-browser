// Tab sleeping policy: idle timeout plus a memory ceiling, least recently used first.

export type TabLoad = {
  id: string
  lastActive: number
  sleeping: boolean
  visible: boolean
  audible: boolean
  memoryMB: number
}
export type SleepRules = { now: number; idleMs: number; capMB: number }

export function pickTabsToSleep(tabs: TabLoad[], rules: SleepRules): string[] {
  const candidates = tabs.filter((t) => !t.sleeping && !t.visible && !t.audible)
  const out = new Set<string>()
  if (rules.idleMs > 0) {
    for (const t of candidates) if (rules.now - t.lastActive >= rules.idleMs) out.add(t.id)
  }
  let total = tabs.filter((t) => !t.sleeping && !out.has(t.id)).reduce((s, t) => s + t.memoryMB, 0)
  const lru = candidates.filter((t) => !out.has(t.id)).sort((a, b) => a.lastActive - b.lastActive)
  for (const t of lru) {
    if (total <= rules.capMB) break
    out.add(t.id)
    total -= t.memoryMB
  }
  return [...out]
}

/**
 * Hidden tabs keep their caches warm forever in Chromium. Once a tab has been out of sight for a while, Drift
 * asks its renderer to drop caches and collect garbage (what Chromium does under memory pressure), once per
 * stretch of being hidden. Showing or navigating the tab starts the clock again.
 */
export class Trimmer {
  private hiddenSince = new Map<string, number>()
  private done = new Set<string>()

  constructor(private afterMs = 30_000) {}

  due(tabs: { id: string; visible: boolean; busy: boolean }[], now: number): string[] {
    const live = new Set(tabs.map((t) => t.id))
    for (const id of this.hiddenSince.keys()) if (!live.has(id)) this.reset(id)
    const out: string[] = []
    for (const t of tabs) {
      if (t.visible || t.busy) {
        this.reset(t.id)
        continue
      }
      const since = this.hiddenSince.get(t.id)
      if (since === undefined) this.hiddenSince.set(t.id, now)
      else if (now - since >= this.afterMs && !this.done.has(t.id)) {
        this.done.add(t.id)
        out.push(t.id)
      }
    }
    return out
  }

  reset(id: string) {
    this.hiddenSince.delete(id)
    this.done.delete(id)
  }
}
