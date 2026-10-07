import { describe, it, expect } from 'vitest'
import { leaf, insert, remove, computeRects, resize, tabIds, replace, nodeBox } from '../src/main/layout'

const box = { x: 0, y: 0, width: 1000, height: 600 }

describe('layout tree', () => {
  it('a single leaf fills the box', () => {
    const { panes } = computeRects(leaf('a'), box, 8)
    expect(panes.get('a')).toEqual(box)
  })

  it('inserting right splits into a row with a gap', () => {
    const t = insert(leaf('a'), 'a', 'b', 'right')
    const { panes } = computeRects(t, box, 8)
    expect(panes.get('a')).toEqual({ x: 0, y: 0, width: 496, height: 600 })
    expect(panes.get('b')).toEqual({ x: 504, y: 0, width: 496, height: 600 })
  })

  it('inserting left puts the new tab first', () => {
    const t = insert(leaf('a'), 'a', 'b', 'left')
    expect(tabIds(t)).toEqual(['b', 'a'])
  })

  it('inserting along the same axis adds a sibling instead of nesting', () => {
    let t = insert(leaf('a'), 'a', 'b', 'right')
    t = insert(t, 'b', 'c', 'right')
    expect(t.kind).toBe('split')
    if (t.kind === 'split') {
      expect(t.children).toHaveLength(3)
      expect(t.sizes.reduce((s, n) => s + n, 0)).toBeCloseTo(1)
    }
  })

  it('inserting bottom nests a column inside a row', () => {
    let t = insert(leaf('a'), 'a', 'b', 'right')
    t = insert(t, 'b', 'c', 'bottom')
    const { panes } = computeRects(t, box, 8)
    expect(panes.get('b')).toEqual({ x: 504, y: 0, width: 496, height: 296 })
    expect(panes.get('c')).toEqual({ x: 504, y: 304, width: 496, height: 296 })
  })

  it('center replaces the target tab', () => {
    const t = insert(insert(leaf('a'), 'a', 'b', 'right'), 'a', 'c', 'center')
    expect(tabIds(t)).toEqual(['c', 'b'])
  })

  it('removing collapses single-child splits', () => {
    let t = insert(leaf('a'), 'a', 'b', 'right')
    t = insert(t, 'b', 'c', 'bottom')
    const r = remove(t, 'c')!
    expect(r).toEqual(insert(leaf('a'), 'a', 'b', 'right'))
    expect(remove(leaf('a'), 'a')).toBeNull()
  })

  it('removing renormalizes sizes', () => {
    let t = insert(leaf('a'), 'a', 'b', 'right')
    t = insert(t, 'b', 'c', 'right')
    const r = remove(t, 'a')!
    expect(r.kind === 'split' && r.sizes.reduce((s, n) => s + n, 0)).toBeCloseTo(1)
  })

  it('reports divider handles and resize moves them', () => {
    const t = insert(leaf('a'), 'a', 'b', 'right')
    const { dividers } = computeRects(t, box, 8)
    expect(dividers).toHaveLength(1)
    expect(dividers[0]).toMatchObject({ path: [], index: 0, dir: 'row' })
    const r = resize(t, [], 0, 0.1)
    const { panes } = computeRects(r, box, 8)
    expect(panes.get('a')!.width).toBeGreaterThan(550)
  })

  it('resize clamps so no pane goes below 10%', () => {
    const t = insert(leaf('a'), 'a', 'b', 'right')
    const r = resize(t, [], 0, 5)
    expect(r.kind === 'split' && r.sizes[1]).toBeCloseTo(0.1)
  })

  it('nodeBox finds the box of a nested split', () => {
    let t = insert(leaf('a'), 'a', 'b', 'right')
    t = insert(t, 'b', 'c', 'bottom')
    expect(nodeBox(t, box, 8, [])).toEqual(box)
    expect(nodeBox(t, box, 8, [1])).toEqual({ x: 504, y: 0, width: 496, height: 600 })
  })

  it('replace swaps a tab id in place', () => {
    const t = replace(insert(leaf('a'), 'a', 'b', 'right'), 'b', 'z')
    expect(tabIds(t)).toEqual(['a', 'z'])
  })
})
