// Two-finger horizontal swipe -> next/previous space. Shared by the sidebar and every page (pure, no DOM).
export type SwipeDir = 'next' | 'prev'

export class SwipeTracker {
  private dx = 0
  private last = -Infinity
  private quietUntil = -Infinity

  constructor(private threshold = 140, private gap = 400, private cooldown = 700) {}

  /** One wheel event; returns a direction when a swipe completes. */
  feed(deltaX: number, deltaY: number, now: number): SwipeDir | null {
    if (Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return null
    if (now - this.last > this.gap) this.dx = 0
    this.last = now
    // The rest of a gesture that already switched spaces keeps arriving; let it run out.
    if (now < this.quietUntil) {
      this.quietUntil = now + this.gap
      return null
    }
    this.dx += deltaX
    if (Math.abs(this.dx) < this.threshold) return null
    const dir = this.dx > 0 ? 'next' : 'prev'
    this.dx = 0
    this.quietUntil = now + this.cooldown
    return dir
  }
}
