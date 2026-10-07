import { useSyncExternalStore } from 'react'

export type Rect = { x: number; y: number; width: number; height: number }
export type TabInfo = {
  id: string; title: string; url: string; favicon: string | null; sleeping: boolean; workspaceId: string | null
  loading: boolean; audible: boolean; muted: boolean; crashed: boolean; memoryMB: number; blocked: number
  canGoBack: boolean; canGoForward: boolean; lastActive: number; bookmarked: boolean; zoom: number; thumb: string | null; agent: boolean
}
export type Tree = { kind: 'leaf'; tabId: string } | { kind: 'split'; dir: 'row' | 'col'; children: Tree[]; sizes: number[] }
export type WorkspaceInfo = {
  id: string; name: string; hue: number | null; private: boolean; agent: boolean; activeTabId: string | null; split: Tree | null
  tabs: TabInfo[]; tokens: Record<string, string>
}
export type Download = { id: string; name: string; path: string; received: number; total: number; state: string }
export type State = {
  workspaces: WorkspaceInfo[]
  essentials: TabInfo[]
  activeWorkspaceId: string
  visible: { id: string; rect: Rect }[]
  settings: {
    idleMinutes: number; memoryCapMB: number; adblock: boolean; sidebarPinned: boolean; glass: boolean
    searchEngine: string; httpsUpgrade: boolean; stripTracking: boolean; doh: boolean; autofill: boolean; googleSignIn: string
  }
  sidebarWidth: number
  gap: number
  find: { tabId: string; text: string; active: number; total: number } | null
  fullscreen: boolean
  downloads: Download[]
  prompt: { id: string; origin: string; permission: string } | null
  adblock: { enabled: boolean; total: number }
  savePrompt: { id: string; origin: string; username: string; update: boolean } | null
  popup: { id: string; rect: Rect; url: string; title: string; header: number } | null
  agentRuns: AgentRun[]
  updateReady: boolean
  totalMB: number
}
export type AgentRun = { id: string; prompt: string; status: 'running' | 'done' | 'failed' | 'stopped'; steps: string[]; result: string | null; started: number }
export type Pane = { id: string; rect: Rect; snap: string | null }
export type Transition = { id: number; kind: string; data: any; before: Pane[]; after: Pane[] }
export type SearchResult = { kind: string; id: string; title: string; url: string; score: number }

type Api = {
  rpc: <T = unknown>(name: string, params?: Record<string, unknown>) => Promise<T>
  state: () => Promise<State>
  onState: (cb: (s: State) => void) => () => void
  onAction: (cb: (a: string) => void) => () => void
  onTransition: (cb: (t: Transition) => void) => () => void
  onTransitionEnd: (cb: (id: number) => void) => () => void
  overlay: (on: boolean) => void
  freeze: () => Promise<Pane[]>
  thaw: () => void
  transitionDone: (id: number) => void
  focusPage: () => void
  focusUi: () => void
}

export const drift: Api = (window as unknown as { drift: Api }).drift

let current: State | null = null
const subs = new Set<() => void>()
drift.onState((s) => {
  current = s
  subs.forEach((f) => f())
})
drift.state().then((s) => {
  if (!current) {
    current = s
    subs.forEach((f) => f())
  }
})

export function useDrift(): State | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => current,
  )
}

export const activeWs = (s: State) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)!

export function findTab(s: State, id: string | null): TabInfo | undefined {
  if (!id) return undefined
  return s.essentials.find((t) => t.id === id) ?? s.workspaces.flatMap((w) => w.tabs).find((t) => t.id === id)
}

export function host(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' ? u.pathname.split('/').pop() || 'file' : u.host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function formatMB(mb: number): string {
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Fast expo-out: motion that starts at full speed and settles without overshoot. */
const out = [0.16, 1, 0.3, 1] as const
export const spring = { type: 'tween', duration: 0.2, ease: out } as const
export const swipeSpring = { type: 'tween', duration: 0.26, ease: out } as const
