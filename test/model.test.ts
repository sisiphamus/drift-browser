import { describe, it, expect, beforeEach } from 'vitest'
import { Model } from '../src/main/model'

let n = 0
const ids = () => `id${++n}`
let m: Model

beforeEach(() => {
  n = 0
  m = new Model({ id: ids, now: () => 1000 })
})

describe('model', () => {
  it('starts with one workspace and no tabs', () => {
    expect(m.workspaces).toHaveLength(1)
    expect(m.activeWorkspace.tabOrder).toEqual([])
  })

  it('adding a tab activates it in the active workspace', () => {
    const t = m.addTab('https://a.com')
    expect(m.activeWorkspace.activeTabId).toBe(t.id)
    expect(m.visibleTabIds()).toEqual([t.id])
  })

  it('new tabs open after the active tab when asked', () => {
    const a = m.addTab('https://a.com')
    m.addTab('https://b.com')
    m.activateTab(a.id)
    const c = m.addTab('https://c.com', { afterActive: true })
    expect(m.activeWorkspace.tabOrder.indexOf(c.id)).toBe(1)
  })

  it('closing the active tab activates the most recently used remaining tab', () => {
    let t = 1000
    m = new Model({ id: ids, now: () => t })
    const a = m.addTab('https://a.com')
    t = 2000
    const b = m.addTab('https://b.com')
    t = 3000
    m.activateTab(a.id)
    t = 4000
    const c = m.addTab('https://c.com')
    m.closeTab(c.id)
    expect(m.activeWorkspace.activeTabId).toBe(a.id)
    expect(m.tabs.has(b.id)).toBe(true)
  })

  it('remembers closed tabs for reopen', () => {
    const a = m.addTab('https://a.com')
    m.closeTab(a.id)
    const r = m.reopenClosed()!
    expect(r.url).toBe('https://a.com')
  })

  it('workspaces keep separate tab lists', () => {
    m.addTab('https://a.com')
    const ws = m.createWorkspace('Research')
    m.switchWorkspace(ws.id)
    m.addTab('https://b.com')
    expect(m.activeWorkspace.tabOrder).toHaveLength(1)
    expect(m.workspaces[0].tabOrder).toHaveLength(1)
  })

  it('splitting shows both tabs, activating a tab outside the split shows it alone', () => {
    const a = m.addTab('https://a.com')
    const b = m.addTab('https://b.com')
    const c = m.addTab('https://c.com')
    m.activateTab(a.id)
    m.split(a.id, b.id, 'right')
    expect(m.visibleTabIds()).toEqual([a.id, b.id])
    m.activateTab(c.id)
    expect(m.visibleTabIds()).toEqual([c.id])
    m.activateTab(b.id)
    expect(m.visibleTabIds()).toEqual([a.id, b.id])
  })

  it('closing a tab inside a split shrinks the split', () => {
    const a = m.addTab('https://a.com')
    const b = m.addTab('https://b.com')
    m.split(a.id, b.id, 'right')
    m.closeTab(b.id)
    expect(m.visibleTabIds()).toEqual([a.id])
  })

  it('moving a tab to another workspace removes it from splits', () => {
    const a = m.addTab('https://a.com')
    const b = m.addTab('https://b.com')
    m.split(a.id, b.id, 'right')
    const ws = m.createWorkspace('Other')
    m.moveTab(b.id, ws.id, 0)
    expect(m.visibleTabIds()).toEqual([a.id])
    expect(ws.tabOrder).toEqual([b.id])
    expect(m.tabs.get(b.id)!.workspaceId).toBe(ws.id)
  })

  it('reorders within a workspace', () => {
    const a = m.addTab('https://a.com')
    const b = m.addTab('https://b.com')
    m.moveTab(b.id, m.activeWorkspace.id, 0)
    expect(m.activeWorkspace.tabOrder).toEqual([b.id, a.id])
  })

  it('cycles workspaces with wraparound', () => {
    const w1 = m.activeWorkspace
    const w2 = m.createWorkspace('Two')
    expect(m.neighborWorkspace(1).id).toBe(w2.id)
    m.switchWorkspace(w2.id)
    expect(m.neighborWorkspace(1).id).toBe(w1.id)
  })

  it('removing a workspace closes its tabs and keeps at least one workspace', () => {
    const w2 = m.createWorkspace('Two')
    m.switchWorkspace(w2.id)
    const t = m.addTab('https://x.com')
    m.removeWorkspace(w2.id)
    expect(m.tabs.has(t.id)).toBe(false)
    expect(m.workspaces).toHaveLength(1)
    m.removeWorkspace(m.workspaces[0].id)
    expect(m.workspaces).toHaveLength(1)
  })

  it('essentials are shared across workspaces', () => {
    const a = m.addTab('https://mail.com')
    m.setEssential(a.id, true)
    const w2 = m.createWorkspace('Two')
    m.switchWorkspace(w2.id)
    expect(m.essentials).toEqual([a.id])
    m.activateTab(a.id)
    expect(m.visibleTabIds()).toEqual([a.id])
  })

  it('split ignores tabs that no longer exist', () => {
    const a = m.addTab('https://a.com')
    const b = m.addTab('https://b.com')
    m.closeTab(b.id)
    m.split(a.id, b.id, 'right')
    expect(m.activeWorkspace.split).toBeNull()
    expect(m.activeWorkspace.activeTabId).toBe(a.id)
  })

  it('restoring drops references to missing tabs', () => {
    const a = m.addTab('https://a.com')
    const b = m.addTab('https://b.com')
    m.split(a.id, b.id, 'right')
    const snap = JSON.parse(JSON.stringify(m.toJSON()))
    snap.tabs = snap.tabs.filter((t: { id: string }) => t.id !== b.id)
    const copy = Model.fromJSON(snap, { id: ids, now: () => 1 })
    expect(copy.activeWorkspace.tabOrder).toEqual([a.id])
    expect(copy.activeWorkspace.split).toBeNull()
    expect(copy.activeWorkspace.activeTabId).toBe(a.id)
  })

  it('pins a tab at the position it was dropped on', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((x) => m.addTab(`https://${x}.com`))
    m.setEssential(a.id, true)
    m.setEssential(b.id, true)
    m.setEssential(c.id, true, 0)
    expect(m.essentials).toEqual([c.id, a.id, b.id])
  })

  it('reorders essentials by dragging one onto a new slot', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((x) => m.addTab(`https://${x}.com`))
    for (const t of [a, b, c]) m.setEssential(t.id, true)
    m.setEssential(a.id, true, 3) // dropped after the last one (index counts the dragged pin itself)
    expect(m.essentials).toEqual([b.id, c.id, a.id])
    m.setEssential(a.id, true, 0)
    expect(m.essentials).toEqual([a.id, b.id, c.id])
    m.setEssential(c.id, true, 1)
    expect(m.essentials).toEqual([a.id, c.id, b.id])
  })

  it('unpinning a tab that is not an essential changes nothing', () => {
    const a = m.addTab('https://a.com')
    m.setEssential(a.id, false)
    expect(m.activeWorkspace.tabOrder).toEqual([a.id])
  })

  it('dragging a tab down within its workspace lands where it was dropped', () => {
    const a = m.addTab('https://a.com')
    const b = m.addTab('https://b.com')
    const c = m.addTab('https://c.com')
    const d = m.addTab('https://d.com')
    // Drop index counts rows before removal: "before d" is 3.
    m.moveTab(a.id, m.activeWorkspace.id, 3)
    expect(m.activeWorkspace.tabOrder).toEqual([b.id, c.id, a.id, d.id])
  })

  it('private spaces and their tabs are never saved', () => {
    m.addTab('https://keep.com')
    const p = m.createWorkspace('Private', 300, true)
    m.switchWorkspace(p.id)
    const secret = m.addTab('https://secret.com')
    expect(m.isPrivate(secret.id)).toBe(true)
    const snap = m.toJSON()
    expect(snap.workspaces.map((w) => w.id)).not.toContain(p.id)
    expect(snap.tabs.map((t) => t.url)).toEqual(['https://keep.com'])
    expect(m.workspaces.find((w) => w.id === snap.activeWorkspaceId)).toBeDefined()
    expect(snap.activeWorkspaceId).not.toBe(p.id)
  })

  it('reorders workspaces and clamps the index', () => {
    const w1 = m.activeWorkspace
    const w2 = m.createWorkspace('Two')
    const w3 = m.createWorkspace('Three')
    m.moveWorkspace(w3.id, 0)
    expect(m.workspaces.map((w) => w.id)).toEqual([w3.id, w1.id, w2.id])
    m.moveWorkspace(w3.id, 99)
    expect(m.workspaces.map((w) => w.id)).toEqual([w1.id, w2.id, w3.id])
    m.moveWorkspace(w1.id, -5)
    expect(m.workspaces[0].id).toBe(w1.id)
  })

  it('round-trips through JSON', () => {
    const a = m.addTab('https://a.com')
    const b = m.addTab('https://b.com')
    m.split(a.id, b.id, 'bottom')
    const copy = Model.fromJSON(JSON.parse(JSON.stringify(m.toJSON())), { id: ids, now: () => 1 })
    expect(copy.visibleTabIds()).toEqual(m.visibleTabIds())
    expect(copy.tabs.get(a.id)!.sleeping).toBe(true)
  })
})
