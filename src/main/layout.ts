// Split tree for tiling tabs inside one workspace. Pure data, no Electron.

export type Dir = 'row' | 'col'
export type Side = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type Rect = { x: number; y: number; width: number; height: number }
export type Leaf = { kind: 'leaf'; tabId: string }
export type Split = { kind: 'split'; dir: Dir; children: Tree[]; sizes: number[] }
export type Tree = Leaf | Split
export type Divider = { path: number[]; index: number; dir: Dir; rect: Rect }

const MIN = 0.1

export const leaf = (tabId: string): Leaf => ({ kind: 'leaf', tabId })

export function tabIds(t: Tree): string[] {
  return t.kind === 'leaf' ? [t.tabId] : t.children.flatMap(tabIds)
}

export function contains(t: Tree, tabId: string): boolean {
  return tabIds(t).includes(tabId)
}

export function replace(t: Tree, from: string, to: string): Tree {
  if (t.kind === 'leaf') return t.tabId === from ? leaf(to) : t
  return { ...t, children: t.children.map((c) => replace(c, from, to)) }
}

export function insert(t: Tree, target: string, tabId: string, side: Side): Tree {
  if (side === 'center') return replace(t, target, tabId)
  const dir: Dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'top'

  if (t.kind === 'leaf') {
    if (t.tabId !== target) return t
    const kids = before ? [leaf(tabId), t] : [t, leaf(tabId)]
    return { kind: 'split', dir, children: kids, sizes: [0.5, 0.5] }
  }

  const i = t.children.findIndex((c) => c.kind === 'leaf' && c.tabId === target)
  if (i >= 0 && t.dir === dir) {
    // Same axis: split the target's share in half instead of nesting.
    const half = t.sizes[i] / 2
    const children = [...t.children]
    const sizes = [...t.sizes]
    children.splice(before ? i : i + 1, 0, leaf(tabId))
    sizes.splice(i, 1, half, half)
    return { ...t, children, sizes }
  }
  return { ...t, children: t.children.map((c) => insert(c, target, tabId, side)) }
}

export function remove(t: Tree, tabId: string): Tree | null {
  if (t.kind === 'leaf') return t.tabId === tabId ? null : t
  const children: Tree[] = []
  const sizes: number[] = []
  t.children.forEach((c, i) => {
    const r = remove(c, tabId)
    if (r) {
      children.push(r)
      sizes.push(t.sizes[i])
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const total = sizes.reduce((s, n) => s + n, 0)
  return { ...t, children, sizes: sizes.map((s) => s / total) }
}

export function resize(t: Tree, path: number[], index: number, delta: number): Tree {
  if (t.kind === 'leaf') return t
  if (path.length > 0) {
    const [head, ...rest] = path
    return { ...t, children: t.children.map((c, i) => (i === head ? resize(c, rest, index, delta) : c)) }
  }
  const sizes = [...t.sizes]
  const pair = sizes[index] + sizes[index + 1]
  const a = Math.min(Math.max(sizes[index] + delta, MIN), pair - MIN)
  sizes[index] = a
  sizes[index + 1] = pair - a
  return { ...t, sizes }
}

export function computeRects(t: Tree, box: Rect, gap: number) {
  const panes = new Map<string, Rect>()
  const dividers: Divider[] = []
  walk(t, box, gap, [], panes, dividers)
  return { panes, dividers }
}

function walk(t: Tree, box: Rect, gap: number, path: number[], panes: Map<string, Rect>, dividers: Divider[]) {
  if (t.kind === 'leaf') {
    panes.set(t.tabId, box)
    return
  }
  const row = t.dir === 'row'
  const span = row ? box.width : box.height
  const usable = span - gap * (t.children.length - 1)
  const base = row ? box.x : box.y
  let acc = 0
  t.children.forEach((c, i) => {
    const start = Math.round(base + acc * usable + i * gap)
    acc += t.sizes[i]
    const end = Math.round(base + acc * usable + i * gap)
    const r = row
      ? { x: start, y: box.y, width: end - start, height: box.height }
      : { x: box.x, y: start, width: box.width, height: end - start }
    walk(c, r, gap, [...path, i], panes, dividers)
    if (i < t.children.length - 1) {
      const d = row
        ? { x: end, y: box.y, width: gap, height: box.height }
        : { x: box.x, y: end, width: box.width, height: gap }
      dividers.push({ path, index: i, dir: t.dir, rect: d })
    }
  })
}

/** The box a node at `path` occupies; turns divider drags in px into size fractions. */
export function nodeBox(t: Tree, box: Rect, gap: number, path: number[]): Rect {
  if (path.length === 0 || t.kind === 'leaf') return box
  const [head, ...rest] = path
  const row = t.dir === 'row'
  const usable = (row ? box.width : box.height) - gap * (t.children.length - 1)
  const base = row ? box.x : box.y
  const acc = t.sizes.slice(0, head).reduce((s, n) => s + n, 0)
  const start = Math.round(base + acc * usable + head * gap)
  const end = Math.round(base + (acc + t.sizes[head]) * usable + head * gap)
  const r = row ? { x: start, y: box.y, width: end - start, height: box.height } : { x: box.x, y: start, width: box.width, height: end - start }
  return nodeBox(t.children[head], r, gap, rest)
}
