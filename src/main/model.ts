// Workspaces and tabs. Pure state; browser.ts mirrors it onto real views.
import { Tree, Side, leaf, insert, remove, contains, tabIds } from './layout'

export type NavEntry = { url: string; title: string }
export type Tab = {
  id: string
  url: string
  title: string
  favicon: string | null
  workspaceId: string | null // null for essentials
  lastActive: number
  sleeping: boolean
  history: { entries: NavEntry[]; index: number } | null
}
export type Workspace = {
  id: string
  name: string
  hue: number | null // override for the matugen accent hue
  private?: boolean // in-memory session, never saved
  agent?: boolean // where agents browse by default
  tabOrder: string[]
  activeTabId: string | null
  split: Tree | null
}
export type Deps = { id: () => string; now: () => number }
type Snapshot = {
  tabs: Tab[]
  workspaces: Workspace[]
  essentials: string[]
  activeWorkspaceId: string
}

const blankWorkspace = (id: string, name: string): Workspace => ({
  id, name, hue: null, tabOrder: [], activeTabId: null, split: null,
})

export class Model {
  tabs = new Map<string, Tab>()
  workspaces: Workspace[] = []
  essentials: string[] = []
  activeWorkspaceId: string
  closed: Tab[] = []

  constructor(private deps: Deps) {
    const ws = blankWorkspace(deps.id(), 'Home')
    this.workspaces.push(ws)
    this.activeWorkspaceId = ws.id
  }

  get activeWorkspace(): Workspace {
    return this.workspace(this.activeWorkspaceId)
  }

  workspace(id: string): Workspace {
    const ws = this.workspaces.find((w) => w.id === id)
    if (!ws) throw new Error(`no workspace ${id}`)
    return ws
  }

  get activeTab(): Tab | null {
    const id = this.activeWorkspace.activeTabId
    return id ? this.tabs.get(id) ?? null : null
  }

  /** Tabs currently on screen: the split if the active tab is in it, else the active tab. */
  visibleTabIds(ws = this.activeWorkspace): string[] {
    const active = ws.activeTabId
    if (!active) return []
    if (ws.split && contains(ws.split, active)) return tabIds(ws.split)
    return [active]
  }

  addTab(url: string, opts: { workspaceId?: string; afterActive?: boolean; activate?: boolean; title?: string } = {}): Tab {
    const ws = this.workspace(opts.workspaceId ?? this.activeWorkspaceId)
    const tab: Tab = {
      id: this.deps.id(), url, title: opts.title ?? url, favicon: null,
      workspaceId: ws.id, lastActive: this.deps.now(), sleeping: false, history: null,
    }
    this.tabs.set(tab.id, tab)
    const at = opts.afterActive && ws.activeTabId ? ws.tabOrder.indexOf(ws.activeTabId) + 1 : -1
    if (at > 0) ws.tabOrder.splice(at, 0, tab.id)
    else ws.tabOrder.push(tab.id)
    if (opts.activate !== false) {
      ws.activeTabId = tab.id
    }
    return tab
  }

  activateTab(id: string) {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (tab.workspaceId && tab.workspaceId !== this.activeWorkspaceId) this.activeWorkspaceId = tab.workspaceId
    this.activeWorkspace.activeTabId = id
    tab.lastActive = this.deps.now()
  }

  closeTab(id: string) {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.closed.push({ ...tab })
    if (this.closed.length > 25) this.closed.shift()
    this.tabs.delete(id)
    this.essentials = this.essentials.filter((e) => e !== id)
    for (const ws of this.workspaces) {
      ws.tabOrder = ws.tabOrder.filter((t) => t !== id)
      if (ws.split) ws.split = collapse(remove(ws.split, id))
      if (ws.activeTabId === id) ws.activeTabId = this.mostRecent(ws)
    }
  }

  reopenClosed(): Tab | null {
    const t = this.closed.pop()
    if (!t) return null
    const ws = this.workspaces.some((w) => w.id === t.workspaceId) ? t.workspaceId! : this.activeWorkspaceId
    const tab = this.addTab(t.url, { workspaceId: ws, title: t.title })
    tab.history = t.history
    tab.favicon = t.favicon
    return tab
  }

  mostRecent(ws: Workspace): string | null {
    const pool = ws.tabOrder.map((id) => this.tabs.get(id)!).filter(Boolean)
    pool.sort((a, b) => b.lastActive - a.lastActive)
    return pool[0]?.id ?? null
  }

  split(target: string, tabId: string, side: Side) {
    const ws = this.activeWorkspace
    if (target === tabId || !this.tabs.has(target) || !this.tabs.has(tabId)) return
    let tree = ws.split && contains(ws.split, target) ? ws.split : leaf(target)
    tree = collapse(remove(tree, tabId)) ?? leaf(target)
    ws.split = insert(tree, target, tabId, side)
    ws.activeTabId = tabId
    this.tabs.get(tabId)!.lastActive = this.deps.now()
  }

  unsplit(tabId: string) {
    const ws = this.activeWorkspace
    if (ws.split) ws.split = collapse(remove(ws.split, tabId))
  }

  moveTab(id: string, workspaceId: string, index: number) {
    const tab = this.tabs.get(id)
    if (!tab) return
    for (const ws of this.workspaces) {
      const was = ws.tabOrder.indexOf(id)
      if (was < 0) continue
      ws.tabOrder.splice(was, 1)
      // Drop indexes count the dragged row itself.
      if (ws.id === workspaceId && was < index) index--
      if (ws.id !== workspaceId) {
        if (ws.split) ws.split = collapse(remove(ws.split, id))
        if (ws.activeTabId === id) ws.activeTabId = this.mostRecent(ws)
      }
    }
    this.essentials = this.essentials.filter((e) => e !== id)
    const dest = this.workspace(workspaceId)
    dest.tabOrder.splice(Math.min(Math.max(index, 0), dest.tabOrder.length), 0, id)
    tab.workspaceId = workspaceId
  }

  /** Pins a tab, at index when given (drop indexes count the dragged pin itself, as in moveTab). */
  setEssential(id: string, on: boolean, index?: number) {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (on) {
      for (const ws of this.workspaces) {
        if (!ws.tabOrder.includes(id)) continue
        ws.tabOrder = ws.tabOrder.filter((t) => t !== id)
        if (ws.split) ws.split = collapse(remove(ws.split, id))
      }
      tab.workspaceId = null
      const was = this.essentials.indexOf(id)
      if (was >= 0 && index === undefined) return
      if (was >= 0) {
        this.essentials.splice(was, 1)
        if (was < index!) index!--
      }
      const at = index === undefined ? this.essentials.length : Math.min(Math.max(index, 0), this.essentials.length)
      this.essentials.splice(at, 0, id)
    } else {
      if (!this.essentials.includes(id)) return
      this.essentials = this.essentials.filter((e) => e !== id)
      tab.workspaceId = this.activeWorkspaceId
      this.activeWorkspace.tabOrder.unshift(id)
    }
  }

  createWorkspace(name: string, hue: number | null = null, isPrivate = false): Workspace {
    const ws = { ...blankWorkspace(this.deps.id(), name), hue, ...(isPrivate ? { private: true } : {}) }
    this.workspaces.push(ws)
    return ws
  }

  removeWorkspace(id: string) {
    if (this.workspaces.length <= 1) return
    const ws = this.workspace(id)
    for (const t of [...ws.tabOrder]) this.closeTab(t)
    this.workspaces = this.workspaces.filter((w) => w.id !== id)
    if (this.activeWorkspaceId === id) this.activeWorkspaceId = this.workspaces[0].id
  }

  moveWorkspace(id: string, index: number) {
    const ws = this.workspace(id)
    this.workspaces = this.workspaces.filter((w) => w !== ws)
    this.workspaces.splice(Math.min(Math.max(index, 0), this.workspaces.length), 0, ws)
  }

  switchWorkspace(id: string) {
    this.workspace(id)
    this.activeWorkspaceId = id
    const t = this.activeTab
    if (t) t.lastActive = this.deps.now()
  }

  neighborWorkspace(step: number): Workspace {
    const i = this.workspaces.findIndex((w) => w.id === this.activeWorkspaceId)
    const n = this.workspaces.length
    return this.workspaces[(((i + step) % n) + n) % n]
  }

  isPrivate(tabId: string): boolean {
    const ws = this.tabs.get(tabId)?.workspaceId
    return !!ws && !!this.workspaces.find((w) => w.id === ws)?.private
  }

  toJSON(): Snapshot {
    const workspaces = this.workspaces.filter((w) => !w.private)
    return {
      tabs: [...this.tabs.values()].filter((t) => !this.isPrivate(t.id)),
      workspaces,
      essentials: this.essentials,
      activeWorkspaceId: workspaces.some((w) => w.id === this.activeWorkspaceId) ? this.activeWorkspaceId : workspaces[0]?.id ?? this.activeWorkspaceId,
    }
  }

  static fromJSON(s: Snapshot, deps: Deps): Model {
    const m = new Model(deps)
    m.workspaces = s.workspaces.length ? s.workspaces : m.workspaces
    m.activeWorkspaceId = m.workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId : m.workspaces[0].id
    for (const t of s.tabs) m.tabs.set(t.id, { ...t, sleeping: true })
    m.essentials = s.essentials.filter((e) => m.tabs.has(e))
    // A crash mid-edit can leave references to tabs that were never saved.
    for (const ws of m.workspaces) {
      ws.tabOrder = ws.tabOrder.filter((id) => m.tabs.has(id))
      for (const id of tabIds(ws.split ?? leaf('')).filter((id) => !m.tabs.has(id))) ws.split = ws.split && collapse(remove(ws.split, id))
      if (ws.activeTabId && !m.tabs.has(ws.activeTabId)) ws.activeTabId = m.mostRecent(ws)
    }
    return m
  }
}

// A split with one pane is just a tab.
function collapse(t: Tree | null): Tree | null {
  return t && t.kind === 'leaf' ? null : t
}
