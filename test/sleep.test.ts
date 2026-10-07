import { describe, it, expect } from 'vitest'
import { pickTabsToSleep, TabLoad, Trimmer } from '../src/main/sleep'

const MIN = 60_000
const tab = (id: string, o: Partial<TabLoad> = {}): TabLoad => ({
  id, lastActive: 0, sleeping: false, visible: false, audible: false, memoryMB: 100, ...o,
})

describe('pickTabsToSleep', () => {
  it('sleeps tabs idle past the threshold', () => {
    const r = pickTabsToSleep([tab('a', { lastActive: 0 }), tab('b', { lastActive: 50 * MIN })], { now: 60 * MIN, idleMs: 30 * MIN, capMB: 10_000 })
    expect(r).toEqual(['a'])
  })

  it('never sleeps visible, audible or already sleeping tabs', () => {
    const r = pickTabsToSleep(
      [tab('v', { visible: true }), tab('s', { audible: true }), tab('z', { sleeping: true })],
      { now: 99 * MIN, idleMs: MIN, capMB: 10_000 },
    )
    expect(r).toEqual([])
  })

  it('over the memory cap, sleeps least recently used first until under it', () => {
    const tabs = [
      tab('old', { lastActive: 1, memoryMB: 400 }),
      tab('mid', { lastActive: 2, memoryMB: 400 }),
      tab('new', { lastActive: 3, memoryMB: 400 }),
      tab('vis', { lastActive: 0, memoryMB: 400, visible: true }),
    ]
    const r = pickTabsToSleep(tabs, { now: 4, idleMs: 99 * MIN, capMB: 1000 })
    expect(r).toEqual(['old', 'mid'])
  })

  it('a zero idle threshold disables idle sleeping', () => {
    expect(pickTabsToSleep([tab('a')], { now: 99 * MIN, idleMs: 0, capMB: 10_000 })).toEqual([])
  })
})

describe('Trimmer', () => {
  const t = (id: string, visible = false, busy = false) => ({ id, visible, busy })

  it('trims a tab once it has been hidden long enough, and only once', () => {
    const tr = new Trimmer(30_000)
    expect(tr.due([t('a')], 0)).toEqual([])
    expect(tr.due([t('a')], 29_000)).toEqual([])
    expect(tr.due([t('a')], 30_000)).toEqual(['a'])
    expect(tr.due([t('a')], 90_000)).toEqual([])
  })

  it('starts over when the tab is shown again or navigates', () => {
    const tr = new Trimmer(30_000)
    tr.due([t('a'), t('b')], 0)
    expect(tr.due([t('a'), t('b')], 30_000)).toEqual(['a', 'b'])
    tr.due([t('a', true), t('b')], 40_000)
    tr.reset('b')
    expect(tr.due([t('a'), t('b')], 50_000)).toEqual([])
    expect(tr.due([t('a'), t('b')], 80_000)).toEqual(['a', 'b'])
  })

  it('leaves busy tabs (audio, agents) alone', () => {
    const tr = new Trimmer(30_000)
    tr.due([t('a', false, true)], 0)
    expect(tr.due([t('a', false, true)], 60_000)).toEqual([])
  })

  it('forgets closed tabs', () => {
    const tr = new Trimmer(30_000)
    tr.due([t('a')], 0)
    tr.due([], 10_000)
    expect(tr.due([t('a')], 30_000)).toEqual([])
  })
})
