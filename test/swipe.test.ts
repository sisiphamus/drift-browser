import { describe, it, expect } from 'vitest'
import { SwipeTracker } from '../src/main/swipe'

const run = (s: SwipeTracker, events: [number, number, number][]) => events.map(([dx, dy, t]) => s.feed(dx, dy, t)).filter(Boolean)

describe('SwipeTracker', () => {
  it('fires once a horizontal swipe passes the threshold', () => {
    const s = new SwipeTracker()
    expect(run(s, [[40, 0, 0], [40, 2, 16], [40, 0, 32], [40, 0, 48]])).toEqual(['next'])
  })

  it('reads the other direction as previous', () => {
    expect(run(new SwipeTracker(), [[-50, 0, 0], [-50, 0, 16], [-50, 0, 32]])).toEqual(['prev'])
  })

  it('ignores mostly vertical scrolling', () => {
    expect(run(new SwipeTracker(), Array.from({ length: 20 }, (_, i) => [30, 40, i * 16] as [number, number, number]))).toEqual([])
  })

  it('forgets a slow drift after a pause', () => {
    expect(run(new SwipeTracker(), [[70, 0, 0], [70, 0, 600]])).toEqual([])
  })

  it('fires only once per gesture, then allows the next one', () => {
    const s = new SwipeTracker()
    const gesture = (t0: number) => Array.from({ length: 12 }, (_, i) => [40, 0, t0 + i * 16] as [number, number, number])
    expect(run(s, gesture(0))).toEqual(['next'])
    expect(run(s, gesture(1500))).toEqual(['next'])
  })
})
