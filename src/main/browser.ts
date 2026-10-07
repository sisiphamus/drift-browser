// Mirrors the Model onto a real window: one UI view plus a WebContentsView per awake tab.
import {
  app, BaseWindow, WebContentsView, WebContents, Session, Menu, MenuItemConstructorOptions,
  clipboard, shell, DownloadItem,
} from 'electron'
import { EventEmitter } from 'node:events'
import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Model, Tab } from './model'
import { computeRects, Rect, Side } from './layout'
import { pickTabsToSleep, Trimmer } from './sleep'
import { matchShortcut } from './keys'
import { searchUrl, toUrl, type Engine } from './search'
import type { HistoryStore } from './history'
import type { Adblock } from './adblock'
import { buildTokens, FALLBACK, Palette } from './theme'
import { cleanNavigation } from './privacy'
import { PermissionStore } from './permissions'
import { isGoogleSignIn, signInUA, type SignInMode } from './signin'

export const GAP = 8
const RADIUS = 10
export const SIDEBAR_W = 272
const FIND_H = 48

export type Settings = {
  idleMinutes: number
  memoryCapMB: number
  adblock: boolean
  sidebarPinned: boolean
  glass: boolean
  searchEngine: Engine
  httpsUpgrade: boolean
  stripTracking: boolean
  doh: boolean
  autofill: boolean
  googleSignIn: SignInMode
}
export const DEFAULT_SETTINGS: Settings = {
  idleMinutes: 20, memoryCapMB: 3000, adblock: true, sidebarPinned: false, glass: true,
  searchEngine: 'google', httpsUpgrade: true, stripTracking: true, doh: true, autofill: true, googleSignIn: 'firefox',
}

type Download = { id: string; name: string; path: string; received: number; total: number; state: string; item?: DownloadItem }
type PermissionPrompt = {
  id: string; origin: string; permission: string; label: string; mediaTypes: string[]; tabId: string | null
  store: PermissionStore; callbacks: ((ok: boolean) => void)[]
}
const QUIET = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'window-management', 'background-sync']
type Pane = { id: string; rect: Rect; snap: string | null }
type Transition = { id: number; kind: string; data: unknown; before: Pane[]; after: Pane[] }

const UI_ACTIONS = new Set(['bar.new', 'bar.edit', 'find.open', 'memory', 'settings', 'escape', 'ws.rename', 'ws.delete'])

export class Browser extends EventEmitter {
  win: BaseWindow
  ui: WebContentsView
  model: Model
  views = new Map<string, WebContentsView>()
  private byWc = new Map<number, string>()
  private loading = new Set<string>()
  private audible = new Set<string>()
  private crashed = new Set<string>()
  memory = new Map<string, { mb: number; cpu: number }>()
  private trimmer = new Trimmer(30_000)
  totalMB = 0
  private snaps = new Map<string, Buffer>() // last full-size JPEG of each tab, for transitions
  private thumbs = new Map<string, Buffer>() // small JPEG for the memory view
  private snapVersion = 0
  private overlay = false
  /** What the UI last asked for (its sidebar, bar or overlays); drags, transitions and popups hand back to this. */
  private uiWantsOverlay = false
  get isOverlay() {
    return this.overlay
  }
  private hidden = false // page views hidden while the UI animates snapshots
  private busy = false // a transition is running
  private lastSelected: string | null = null
  private httpOk = new Set<string>()
  private upgraded = new Map<number, string>()
  private transitionDone: { id: number; done: () => void } | null = null
  private transitionSeq = 0
  private freezeSeq = 0
  private findTab: string | null = null
  private find = { text: '', active: 0, total: 0 }
  private fullscreenTab: string | null = null
  private zoom = new Map<string, number>()
  downloads: Download[] = []
  private prompts: PermissionPrompt[] = []
  private pushTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  palette: Palette = FALLBACK
  savePrompt: { id: string; origin: string; username: string; update: boolean } | null = null
  /** When an agent last acted in each tab; the sidebar marks tabs an agent is working in. */
  agentTouched = new Map<string, number>()
  agentRuns: unknown[] = []
  /** A newer build of Drift is on disk; the sidebar offers a restart. */
  updateReady = false
  extensions: import('electron-chrome-extensions').ElectronChromeExtensions | null = null

  constructor(
    private session: Session,
    private opts: {
      uiUrl: string; uiPreload: string; statePath: string; settings: Settings; history: HistoryStore; adblock: Adblock
      privateSession: Session; permissions: PermissionStore
    },
  ) {
    super()
    this.model = this.restore()
    this.win = new BaseWindow({
      width: 1440, height: 900, minWidth: 640, minHeight: 420, frame: false,
      transparent: opts.settings.glass, backgroundColor: opts.settings.glass ? '#00000000' : '#121316',
      title: 'Drift', show: false,
    })
    this.ui = new WebContentsView({
      webPreferences: { session, preload: opts.uiPreload, sandbox: true, contextIsolation: true, spellcheck: false },
    })
    this.ui.setBackgroundColor('#00000000')
    this.win.contentView.addChildView(this.ui)
    this.ui.webContents.loadURL(opts.uiUrl)
    // A dropped link or file would otherwise navigate the UI view, and the page that loads
    // there would inherit the preload bridge and every command.
    const stay = (e: Electron.Event, url: string) => {
      if (url.startsWith(opts.uiUrl)) return
      e.preventDefault()
      console.warn('[drift] blocked UI navigation to', url)
    }
    this.ui.webContents.on('will-navigate', stay)
    this.ui.webContents.on('will-frame-navigate', (e) => stay(e, e.url))
    this.ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.ui.webContents.on('before-input-event', (e, input) => this.onKey(e, input, null))
    this.ui.webContents.once('did-finish-load', () => {
      this.layout()
      this.win.show()
    })
    for (const ev of ['resize', 'resized', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore', 'show'] as const) {
      this.win.on(ev as 'resize', () => this.relayoutIfResized())
    }
    // niri resizes tiled windows without Electron always emitting 'resize'; catch it here.
    setInterval(() => this.relayoutIfResized(), 250).unref()
    this.win.on('close', (e) => {
      // A popup's page closes asynchronously; tearing the window down under it crashes Chromium.
      if (this.popup) {
        e.preventDefault()
        void this.closePopupAndWait().then(() => this.win.close())
        return
      }
      this.shutdown()
    })
    this.win.on('focus', () => this.activePageFocus())
    for (const s of [session, opts.privateSession]) {
      s.on('will-download', (_e, item, wc) => this.onDownload(item, wc))
      s.setPermissionRequestHandler((wc, permission, cb, details) =>
        this.onPermission(wc, permission, cb, details.requestingUrl, (details as { mediaTypes?: string[] }).mediaTypes),
      )
      // Sites check permission state before asking; answer from what was decided so they don't re-ask.
      s.setPermissionCheckHandler((wc, permission, origin, details) => {
        if (process.env.DRIFT_DEBUG) console.warn('[drift] permission check', permission, origin, JSON.stringify(details))
        if (QUIET.includes(permission)) return true
        if (wc && wc.id === this.ui.webContents.id) return false
        const media = (details as { mediaType?: string }).mediaType
        const types = permission === 'media' && media && media !== 'unknown' ? [media] : []
        let site = origin
        try {
          site = new URL(origin).origin // Chromium passes it with a trailing slash
        } catch { /* keep raw */ }
        return this.storeFor(wc).decide(site, permission, types) === 'allow'
      })
    }
    setTimeout(() => this.tick(), 1500)
    setInterval(() => this.tick(), 10_000).unref()
  }

  /** The cleaned-up url for a navigation, per the privacy settings, or null. */
  clean(url: string): string | null {
    return cleanNavigation(url, this.httpOk, { https: this.settings.httpsUpgrade, strip: this.settings.stripTracking })
  }

  /** True only for the UI's own top frame on the UI's own page. */
  isUiSender(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    const f = e.senderFrame
    return e.sender.id === this.ui.webContents.id && !!f && f === e.sender.mainFrame && f.url.startsWith(this.opts.uiUrl)
  }

  get settings() {
    return this.opts.settings
  }

  // ---------- state ----------

  private restore(): Model {
    const deps = { id: () => randomUUID().slice(0, 8), now: () => Date.now() }
    try {
      if (existsSync(this.opts.statePath)) return Model.fromJSON(JSON.parse(readFileSync(this.opts.statePath, 'utf8')), deps)
    } catch (e) {
      console.warn('[drift] could not restore session', e)
    }
    return new Model(deps)
  }

  saveSoon() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), 800)
  }

  saveNow() {
    for (const [id, v] of this.views) this.captureHistory(id, v.webContents)
    const tmp = `${this.opts.statePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.model.toJSON()))
    renameSync(tmp, this.opts.statePath)
  }

  /** Save, then close every page before the window goes; Chromium aborts if views outlive it. */
  private shutDown = false
  /** History restores in flight; destroying a page mid-restore makes Chromium abort. */
  private restoring = new Set<Promise<unknown>>()

  /** Resolves once pending restores and any popup have settled, so quitting can't tear them down mid-flight. */
  async settle(maxMs = 1500): Promise<void> {
    const loading = [...this.views.values()]
      .map((v) => v.webContents)
      .filter((wc) => !wc.isDestroyed() && wc.isLoading())
      .map((wc) => new Promise<void>((r) => wc.once('did-stop-loading', () => r())))
    const work = Promise.all([...this.restoring, ...loading, this.popup ? this.closePopupAndWait() : Promise.resolve()])
    await Promise.race([work, new Promise((r) => setTimeout(r, maxMs))])
  }

  get unsettled(): boolean {
    return this.restoring.size > 0 || !!this.popup || [...this.views.values()].some((v) => !v.webContents.isDestroyed() && v.webContents.isLoading())
  }

  shutdown() {
    if (this.shutDown) return
    this.shutDown = true
    this.saveNow()
    this.closePopup()
    // Page views must go before the window or Chromium aborts on exit. The UI view must not: closing it
    // here raced its own teardown and aborted about one quit in five (found by test/e2e/lifecycle).
    for (const id of [...this.views.keys()]) this.destroyView(id)
  }

  private captureHistory(id: string, wc: WebContents) {
    const tab = this.model.tabs.get(id)
    if (!tab || wc.isDestroyed()) return
    const h = wc.navigationHistory
    const entries = h.getAllEntries().map((e) => ({ url: e.url, title: e.title }))
    if (entries.length) tab.history = { entries: entries.slice(-50), index: Math.min(h.getActiveIndex(), 49) }
  }

  /** Coalesces state pushes to one per frame. */
  push() {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send('state', this.snapshot())
    }, 16)
    this.saveSoon()
  }

  tabInfo(t: Tab) {
    const v = this.views.get(t.id)
    const wc = v?.webContents
    const blocked = wc ? this.opts.adblock.perTab.get(wc.id) ?? 0 : 0
    return {
      id: t.id, title: t.title, url: t.url, favicon: t.favicon, sleeping: !v, workspaceId: t.workspaceId,
      loading: this.loading.has(t.id), audible: this.audible.has(t.id), muted: wc?.isAudioMuted() ?? false,
      crashed: this.crashed.has(t.id), memoryMB: this.memory.get(t.id)?.mb ?? 0, blocked,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false, canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      lastActive: t.lastActive, bookmarked: this.opts.history.isBookmarked(t.url), zoom: this.zoom.get(t.id) ?? 1,
      agent: Date.now() - (this.agentTouched.get(t.id) ?? 0) < 20_000,
      thumb: this.thumbs.has(t.id) ? `drift://thumb/${t.id}?v=${this.snapVersion}` : null,
    }
  }

  snapshot() {
    if (this.win.isDestroyed()) return null
    const m = this.model
    return {
      workspaces: m.workspaces.map((w) => ({
        id: w.id, name: w.name, hue: w.hue, private: !!w.private, agent: !!w.agent, activeTabId: w.activeTabId, split: w.split, tokens: buildTokens(this.palette, w.hue),
        tabs: w.tabOrder.map((id) => this.tabInfo(m.tabs.get(id)!)),
      })),
      essentials: m.essentials.map((id) => this.tabInfo(m.tabs.get(id)!)),
      activeWorkspaceId: m.activeWorkspaceId,
      visible: this.panes().map(({ id, rect }) => ({ id, rect })),
      settings: this.settings,
      sidebarWidth: SIDEBAR_W,
      gap: GAP,
      find: this.findTab ? { tabId: this.findTab, ...this.find } : null,
      fullscreen: !!this.fullscreenTab,
      downloads: this.downloads.map(({ item: _i, ...d }) => d),
      prompt: this.prompts[0] ? { id: this.prompts[0].id, origin: this.prompts[0].origin, permission: this.prompts[0].label } : null,
      popup: this.popup && !this.popup.view.webContents.isDestroyed()
        ? { id: this.popup.id, rect: this.popupRect(), url: this.popup.view.webContents.getURL(), title: this.popup.view.webContents.getTitle(), header: Browser.POPUP_HEADER }
        : null,
      adblock: { enabled: this.opts.adblock.enabled, total: this.opts.adblock.total },
      savePrompt: this.savePrompt,
      agentRuns: this.agentRuns,
      updateReady: this.updateReady,
      totalMB: this.totalMB,
    }
  }

  // ---------- layout ----------

  pageArea(): Rect {
    if (this.win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const [W, H] = this.win.getContentSize()
    const left = this.settings.sidebarPinned ? SIDEBAR_W : GAP
    return { x: left, y: GAP, width: Math.max(0, W - left - GAP), height: Math.max(0, H - 2 * GAP) }
  }

  panes(): { id: string; rect: Rect }[] {
    const visible = this.model.visibleTabIds()
    const area = this.pageArea()
    const ws = this.model.activeWorkspace
    const rects = visible.length > 1 && ws.split ? computeRects(ws.split, area, GAP).panes : new Map([[visible[0], area]])
    return visible.map((id) => {
      const r = { ...rects.get(id)! }
      if (id === this.findTab) {
        r.y += FIND_H
        r.height -= FIND_H
      }
      return { id, rect: r }
    })
  }

  private laidOut = ''

  private relayoutIfResized() {
    if (this.win.isDestroyed()) return
    const size = this.win.getContentSize().join('x')
    if (size !== this.laidOut) this.layout()
  }

  layout() {
    const pr = this.popupRect()
    if (pr && this.popup) this.popup.view.setBounds(pr)
    const [W, H] = this.win.getContentSize()
    this.laidOut = `${W}x${H}`
    this.ui.setBounds({ x: 0, y: 0, width: W, height: H })
    if (this.fullscreenTab && this.views.has(this.fullscreenTab)) {
      for (const [id, v] of this.views) {
        v.setVisible(id === this.fullscreenTab)
        if (id === this.fullscreenTab) {
          v.setBounds({ x: 0, y: 0, width: W, height: H })
          v.setBorderRadius(0)
        }
      }
      return this.push()
    }
    const panes = this.panes()
    const shown = new Set(panes.map((p) => p.id))
    for (const p of panes) this.wake(p.id)
    for (const [id, v] of this.views) {
      const pane = panes.find((p) => p.id === id)
      if (pane && !this.hidden) {
        v.setBorderRadius(RADIUS)
        v.setBounds(pane.rect)
        v.setVisible(true)
      } else {
        if (shown.has(id) === false && v.getVisible()) this.stashSnapshot(id)
        v.setVisible(false)
      }
    }
    // Tell extensions about focus changes only; selectTab can call back into activate().
    const active = this.model.activeWorkspace.activeTabId
    if (active && active !== this.lastSelected && this.views.has(active)) {
      this.lastSelected = active
      const wc = this.views.get(active)!.webContents
      if (this.extOk(wc)) this.quietly(() => this.extensions?.selectTab(wc))
    }
    this.push()
  }

  /** The UI's own request. Kept so anything that raised the UI temporarily restores it, not just lowers it. */
  requestOverlay(on: boolean) {
    this.uiWantsOverlay = on
    this.setOverlay(on)
  }

  setOverlay(on: boolean) {
    // An open popup keeps the UI raised (it draws the card's frame and backdrop) with the popup above it.
    if (!on && this.popup) on = true
    if (on === this.overlay) return this.raisePopup()
    this.overlay = on
    this.win.contentView.addChildView(this.ui, on ? undefined : 0)
    this.raisePopup()
    if (this.popup) this.popup.view.webContents.focus()
    else if (on) this.ui.webContents.focus()
    else this.activePageFocus()
  }

  // ---------- popups ----------

  private popup: { id: string; view: WebContentsView } | null = null
  static POPUP_HEADER = 44

  private openPopup(existing?: WebContents, url?: string): WebContents {
    this.closePopup()
    const view = new WebContentsView(
      existing ? { webContents: existing } : { webPreferences: { session: this.session, sandbox: true, contextIsolation: true } },
    )
    view.setBorderRadius(0)
    const wc = view.webContents
    if (url && isGoogleSignIn(url)) wc.setUserAgent(this.uaFor(url))
    this.followSignIn(wc)
    this.watchHandBack(wc)
    this.popup = { id: randomUUID().slice(0, 8), view }
    this.win.contentView.addChildView(view)
    // Anything the popup opens in turn becomes a normal tab.
    wc.setWindowOpenHandler((d) => {
      this.open(d.url, { raw: true })
      return { action: 'deny' }
    })
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        e.preventDefault()
        this.closePopup()
      }
    })
    for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) wc.on(ev as 'did-navigate', () => this.push())
    wc.once('destroyed', () => {
      if (this.popup?.view === view) this.dropPopup()
    })
    this.setOverlay(true)
    this.layout()
    wc.focus()
    return wc
  }

  get popupView(): WebContentsView | null {
    return this.popup?.view ?? null
  }

  /** The user agent a page should load with: the sign-in identity on Google's account pages, else Drift's own. */
  uaFor(url: string): string {
    return isGoogleSignIn(url) ? signInUA(this.settings.googleSignIn, app.userAgentFallback, process.versions.electron) : app.userAgentFallback
  }

  /**
   * Sets the user agent natively as a page heads onto or off Google's account pages, so navigator.userAgent,
   * workers and frames all agree with the request headers.
   */
  private followSignIn(wc: WebContents) {
    const sync = (url: string) => {
      const ua = this.uaFor(url)
      if (wc.getUserAgent() !== ua) wc.setUserAgent(ua)
    }
    wc.on('did-start-navigation', (e) => e.isMainFrame && sync(e.url))
    wc.on('will-redirect', (e) => e.isMainFrame && sync(e.url))
  }

  /**
   * Google's sign-in hands the result back through window.opener. When the flow detours through its
   * verification pages, Google's own redirect severs that link, and the final page sits blank. The user is
   * signed in to Google by then, so a second "Continue with Google" goes straight through: say so.
   */
  private watchHandBack(wc: WebContents) {
    wc.on('did-finish-load', () => {
      let path = ''
      try {
        path = new URL(wc.getURL()).pathname
      } catch { /* not a url */ }
      if (!isGoogleSignIn(wc.getURL()) || path !== '/gsi/select') return
      setTimeout(async () => {
        if (wc.isDestroyed() || this.popup?.view.webContents !== wc) return
        const stuck = await wc
          .executeJavaScript('!window.opener && !(document.body && document.body.innerText.trim())')
          .catch(() => false)
        if (!stuck) return
        this.closePopup()
        this.ui.webContents.send('action', "toast:You're signed in to Google. Press Continue with Google once more to finish.")
      }, 2500)
    })
  }

  /** Native menu for UI items; the sidebar holds itself open until it closes. */
  showMenu(items: MenuItemConstructorOptions[]) {
    this.ui.webContents.send('action', 'menu.open')
    Menu.buildFromTemplate(items).popup({ callback: () => this.ui.webContents.send('action', 'menu.closed') })
  }

  private raisePopup() {
    if (this.popup) this.win.contentView.addChildView(this.popup.view)
  }

  popupRect(): Rect | null {
    if (!this.popup) return null
    const [W, H] = this.win.getContentSize()
    const width = Math.min(520, W - 48)
    const height = Math.min(700, H - 48 - Browser.POPUP_HEADER)
    return { x: Math.round((W - width) / 2), y: Math.round((H - height + Browser.POPUP_HEADER) / 2), width, height }
  }

  get hasPopup(): boolean {
    return !!this.popup
  }

  /** Closes the popup and resolves once its page is really gone. */
  closePopupAndWait(): Promise<void> {
    const p = this.popup
    if (!p || p.view.webContents.isDestroyed()) {
      this.dropPopup()
      return Promise.resolve()
    }
    return new Promise((done) => {
      const t = setTimeout(done, 1500)
      p.view.webContents.once('destroyed', () => {
        clearTimeout(t)
        // 'destroyed' fires before Chromium finishes tearing the popup's renderer down.
        setTimeout(done, 400)
      })
      this.closePopup()
    })
  }

  closePopup() {
    const p = this.popup
    if (!p) return
    if (!p.view.webContents.isDestroyed()) p.view.webContents.close()
    this.dropPopup()
  }

  private dropPopup() {
    const p = this.popup
    if (!p) return
    this.popup = null
    this.win.contentView.removeChildView(p.view)
    this.setOverlay(this.uiWantsOverlay)
    this.layout()
    this.push()
  }

  activePageFocus() {
    if (this.overlay) return this.ui.webContents.focus()
    const t = this.model.activeTab
    const v = t && this.views.get(t.id)
    if (v) v.webContents.focus()
    else this.ui.webContents.focus()
  }

  // ---------- snapshots + transitions ----------

  /**
   * Runs fn with a background tab composited, for screenshots: hidden views draw nothing. The tab is shown for the
   * moment of the capture directly beneath the user's visible tab and at its exact rect, so nothing changes on screen.
   */
  async withShown<T>(wc: WebContents, fn: () => Promise<T>): Promise<T> {
    const id = [...this.views].find(([, v]) => v.webContents === wc)?.[0]
    const v = id ? this.views.get(id) : undefined
    if (!id || !v || v.getVisible()) return fn()
    // Under the visible tab the compositor skips it as occluded, and fully off-window it is clipped; with one pixel
    // column inside the window's edge it draws its whole surface while staying effectively unseen.
    const area = this.pageArea()
    const [W] = this.win.getContentSize()
    this.win.contentView.addChildView(v)
    v.setBounds({ ...area, x: W - 1 })
    v.setVisible(true)
    try {
      wc.invalidate()
      // A view that has never been on screen needs a few frames before the compositor will hand one over.
      for (let i = 0; ; i++) {
        await new Promise((r) => setTimeout(r, 100))
        try {
          return await fn()
        } catch (e) {
          if (i >= 20) throw e
        }
      }
    } finally {
      if (!wc.isDestroyed() && !this.panes().some((p) => p.id === id)) {
        v.setVisible(false)
        v.setBounds(area)
      }
    }
  }

  private async stashSnapshot(id: string) {
    const v = this.views.get(id)
    if (!v || v.webContents.isDestroyed()) return
    try {
      const img = await v.webContents.capturePage()
      if (img.isEmpty()) return
      this.snaps.set(id, img.toJPEG(75))
      this.snapVersion++
      // The memory view's thumbnail can wait; transitions can't.
      setTimeout(() => this.thumbs.set(id, img.resize({ width: 480, quality: 'good' }).toJPEG(75)), 400)
    } catch {
      /* view went away mid-capture */
    }
  }

  /** Fresh thumbnails for tabs on screen, which otherwise only get one when they leave it. */
  async refreshThumbs() {
    await Promise.all(this.model.visibleTabIds().map((id) => this.stashSnapshot(id)))
    this.push()
  }

  snapData(kind: 'snap' | 'thumb', id: string): Buffer | null {
    return (kind === 'snap' ? this.snaps : this.thumbs).get(id) ?? null
  }

  private snapUrl(id: string) {
    return this.snaps.has(id) ? `drift://snap/${id}?v=${this.snapVersion}` : null
  }

  /**
   * Freezes the page views as snapshots, applies `mutate`, and lets the UI animate from the
   * old panes to the new ones before the live views come back.
   */
  async transition(kind: string, data: unknown, mutate: () => void) {
    if (this.busy || this.fullscreenTab) {
      mutate()
      // A drag froze the pages; with no animation to run, bring them straight back.
      if (!this.busy) this.thaw()
      return this.layout()
    }
    this.busy = true
    const id = ++this.transitionSeq
    try {
      const beforePanes = this.panes()
      // Frozen views (mid-drag) already have fresh snapshots; capturing them again can return blank frames.
      if (!this.hidden) await Promise.all(beforePanes.map((p) => this.stashSnapshot(p.id)))
      const before = beforePanes.map((p) => ({ ...p, snap: this.snapUrl(p.id) }))
      mutate()
      const after = this.panes().map((p) => ({ ...p, snap: this.snapUrl(p.id) }))
      this.hidden = true
      this.setOverlay(true)
      this.layout()
      const t: Transition = { id, kind, data, before, after }
      this.ui.webContents.send('transition', t)
      await new Promise<void>((done) => {
        this.transitionDone = { id, done }
        setTimeout(done, 1500)
      })
    } finally {
      this.transitionDone = null
      this.busy = false
      this.freezeSeq++
      this.hidden = false
      this.setOverlay(this.uiWantsOverlay)
      this.layout()
      this.ui.webContents.send('transitionEnd', id)
    }
  }

  endTransition(id: number) {
    if (this.transitionDone?.id === id) this.transitionDone.done()
  }

  /** Freezes pages for a drag so the UI can draw drop zones over them. */
  async freeze(): Promise<Pane[]> {
    const seq = ++this.freezeSeq
    const panes = this.panes()
    await Promise.all(panes.map((p) => this.stashSnapshot(p.id)))
    if (seq !== this.freezeSeq || this.busy) return []
    this.hidden = true
    this.setOverlay(true)
    this.layout()
    return panes.map((p) => ({ ...p, snap: this.snapUrl(p.id) }))
  }

  thaw() {
    this.freezeSeq++
    if (this.busy) return
    this.hidden = false
    this.setOverlay(this.uiWantsOverlay)
    this.layout()
  }

  // ---------- tabs ----------

  open(input: string, o: { background?: boolean; workspaceId?: string; split?: Side; afterActive?: boolean; raw?: boolean } = {}): Tab {
    const typed = o.raw ? input : toUrl(input) ?? searchUrl(input, this.settings.searchEngine)
    const url = o.raw ? typed : this.clean(typed) ?? typed
    const target = this.model.activeTab?.id
    const tab = this.model.addTab(url, { workspaceId: o.workspaceId, afterActive: o.afterActive ?? true, activate: !o.background || !!o.split })
    if (o.split && target) {
      void this.transition('split', null, () => this.model.split(target, tab.id, o.split!))
    } else if (o.background) {
      this.createView(tab)
      this.push()
    } else {
      this.layout()
    }
    return tab
  }

  activate(id: string) {
    const prevWs = this.model.activeWorkspaceId
    this.model.activateTab(id)
    if (this.model.activeWorkspaceId !== prevWs) {
      const target = this.model.activeWorkspaceId
      this.model.switchWorkspace(prevWs)
      return this.switchWorkspace(target)
    }
    if (this.findTab && this.findTab !== id) this.stopFind()
    this.layout()
    this.activePageFocus()
  }

  close(id: string) {
    const v = this.views.get(id)
    this.model.closeTab(id)
    if (v) this.destroyView(id)
    this.forget(id)
    this.layout()
    this.activePageFocus()
  }

  private forget(id: string) {
    this.snaps.delete(id)
    this.thumbs.delete(id)
    this.zoom.delete(id)
    if (this.findTab === id) this.findTab = null
    for (const p of this.prompts.filter((x) => x.tabId === id)) p.callbacks.forEach((cb) => cb(false))
    this.prompts = this.prompts.filter((x) => x.tabId !== id)
  }

  /** Removes a space and its tabs without waking any of them. */
  removeWorkspace(id: string) {
    if (this.model.workspaces.length <= 1) throw new Error("can't remove the only workspace")
    const ids = [...this.model.workspace(id).tabOrder]
    const wasPrivate = !!this.model.workspace(id).private
    this.model.removeWorkspace(id)
    if (wasPrivate && !this.model.workspaces.some((w) => w.private)) {
      void this.opts.privateSession.clearStorageData()
      void this.opts.privateSession.clearCache()
    }
    for (const t of ids) {
      this.destroyView(t)
      this.forget(t)
    }
    this.layout()
  }

  cycle(step: number) {
    const ws = this.model.activeWorkspace
    const order = [...this.model.essentials, ...ws.tabOrder]
    if (!order.length) return
    const i = order.indexOf(ws.activeTabId ?? '')
    this.activate(order[(((i + step) % order.length) + order.length) % order.length])
  }

  async switchWorkspace(id: string, dir?: number) {
    if (id === this.model.activeWorkspaceId) return
    const from = this.model.workspaces.findIndex((w) => w.id === this.model.activeWorkspaceId)
    const to = this.model.workspaces.findIndex((w) => w.id === id)
    if (this.findTab) this.stopFind()
    await this.transition('workspace', { dir: dir ?? Math.sign(to - from), from: this.model.activeWorkspaceId, to: id }, () =>
      this.model.switchWorkspace(id),
    )
  }

  wake(id: string, opts: { webContents?: WebContents } = {}): WebContentsView | null {
    if (this.views.has(id)) return this.views.get(id)!
    const tab = this.model.tabs.get(id)
    if (!tab) return null
    return this.createView(tab, opts.webContents)
  }

  sleep(id: string) {
    if (!this.views.has(id) || this.model.visibleTabIds().includes(id) || this.audible.has(id)) return false
    const v = this.views.get(id)!
    this.captureHistory(id, v.webContents)
    this.destroyView(id)
    this.push()
    return true
  }

  private createView(tab: Tab, existing?: WebContents): WebContentsView {
    const view = new WebContentsView(
      existing
        ? { webContents: existing }
        : { webPreferences: { session: this.model.isPrivate(tab.id) ? this.opts.privateSession : this.session, sandbox: true, contextIsolation: true, spellcheck: true } },
    )
    view.setBorderRadius(RADIUS)
    view.setVisible(false)
    // A tab that is never shown still needs a real viewport: agents read and click background tabs.
    view.setBounds(this.pageArea())
    this.win.contentView.addChildView(view, this.overlay ? this.win.contentView.children.length - 1 : undefined)
    const wc = view.webContents
    this.followSignIn(wc)
    this.views.set(tab.id, view)
    this.byWc.set(wc.id, tab.id)
    this.crashed.delete(tab.id)
    this.wire(tab.id, wc)
    if (this.extOk(wc)) {
      // Registering a tab makes the library mark it active when it knows of no other; keep that internal.
      this.quietly(() => this.extensions?.addTab(wc, this.win))
      const active = this.model.activeTab && this.views.get(this.model.activeTab.id)?.webContents
      if (active && active !== wc && this.extOk(active)) this.quietly(() => this.extensions?.selectTab(active))
    }
    if (!existing) void this.whenProtected().then(() => !wc.isDestroyed() && this.loadTab(tab, wc))
    const z = this.zoom.get(tab.id)
    if (z) wc.setZoomFactor(z)
    return view
  }

  /** Pages wait for the ad and tracker blocker to come up, at most 3s, so restored tabs never load unfiltered. */
  private whenProtected(): Promise<void> {
    return Promise.race([this.opts.adblock.ready, new Promise<void>((r) => setTimeout(r, 3000))])
  }

  private loadTab(tab: Tab, wc: WebContents) {
    if (tab.history?.entries.length) {
      const restoring = wc.navigationHistory
        .restore({ entries: tab.history.entries, index: tab.history.index })
        .catch(() => (wc.isDestroyed() ? undefined : wc.loadURL(tab.url).catch(() => {})))
        .finally(() => this.restoring.delete(restoring))
      this.restoring.add(restoring)
    } else {
      wc.loadURL(tab.url).catch(() => {})
    }
  }

  private destroyView(id: string) {
    const v = this.views.get(id)
    if (!v) return
    if (this.fullscreenTab === id) {
      this.fullscreenTab = null
      this.win.setFullScreen(false)
    }
    this.views.delete(id)
    this.byWc.delete(v.webContents.id)
    this.loading.delete(id)
    this.audible.delete(id)
    this.memory.delete(id)
    this.win.contentView.removeChildView(v)
    if (!v.webContents.isDestroyed()) {
      if (this.extOk(v.webContents)) this.extensions?.removeTab(v.webContents)
      v.webContents.close()
    }
  }

  /** Extensions live in the main session only; private tabs never see them. */
  private extOk(wc: WebContents): boolean {
    return wc.session === this.session
  }

  /** True while Drift itself is telling the extensions library about tabs; its select callbacks are echoes. */
  extQuiet = false

  private quietly(fn: () => void) {
    this.extQuiet = true
    try {
      fn()
    } finally {
      this.extQuiet = false
    }
  }

  tabFor(wc: WebContents): string | null {
    return this.byWc.get(wc.id) ?? null
  }

  private wire(id: string, wc: WebContents) {
    const tab = () => this.model.tabs.get(id)
    const record = (url: string, title: string) => !this.model.isPrivate(id) && this.opts.history.addVisit(url, title)
    // Local IPs stay private from WebRTC; only the public route is exposed.
    wc.setWebRTCIPHandlingPolicy('default_public_interface_only')
    // Link clicks: strip trackers and upgrade to https before the request leaves.
    wc.on('will-frame-navigate', (e) => {
      if (!e.isMainFrame) return
      const next = this.clean(e.url)
      if (!next) return
      e.preventDefault()
      if (next.startsWith('https:') && e.url.startsWith('http:')) this.upgraded.set(wc.id, e.url)
      void wc.loadURL(next).catch(() => {})
    })
    wc.on('page-title-updated', (_e, title) => {
      const t = tab()
      if (!t) return
      t.title = title
      if (!this.model.isPrivate(id)) this.opts.history.setTitle(t.url, title)
      this.push()
    })
    wc.on('page-favicon-updated', (_e, icons) => {
      const t = tab()
      if (t && icons[0]) t.favicon = icons[0]
      this.push()
    })
    wc.on('did-start-loading', () => {
      this.loading.add(id)
      this.push()
    })
    wc.on('did-stop-loading', () => {
      this.loading.delete(id)
      this.push()
    })
    wc.on('did-navigate', (_e, url) => {
      this.trimmer.reset(id)
      const t = tab()
      if (!t) return
      t.url = url
      this.opts.adblock.resetTab(wc.id)
      if (!url.startsWith('https:') || new URL(url).host !== new URL(this.upgraded.get(wc.id) ?? 'http://x').host) this.upgraded.delete(wc.id)
      record(url, t.title)
      this.push()
    })
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      const t = tab()
      if (!t || !isMain) return
      t.url = url
      record(url, t.title)
      this.push()
    })
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return
      // The https upgrade failed: remember the host and load the http page the link asked for.
      const original = this.upgraded.get(wc.id)
      if (original && new URL(original).host === new URL(url).host) {
        this.upgraded.delete(wc.id)
        this.httpOk.add(new URL(original).hostname)
        void wc.loadURL(original).catch(() => {})
        return
      }
      void wc.executeJavaScript(errorPage(code, desc, url, buildTokens(this.palette, this.model.activeWorkspace.hue))).catch(() => {})
    })
    wc.on('focus', () => {
      if (this.model.activeWorkspace.activeTabId !== id && this.model.visibleTabIds().includes(id)) {
        this.model.activateTab(id)
        this.push()
      }
    })
    wc.on('before-input-event', (e, input) => this.onKey(e, input, id))
    wc.on('context-menu', (_e, params) => this.contextMenu(id, wc, params))
    wc.on('found-in-page', (_e, r) => {
      this.find.active = r.activeMatchOrdinal
      this.find.total = r.matches
      this.push()
    })
    wc.on('enter-html-full-screen', () => {
      this.fullscreenTab = id
      this.win.setFullScreen(true)
      this.layout()
    })
    wc.on('leave-html-full-screen', () => {
      this.fullscreenTab = null
      this.win.setFullScreen(false)
      this.layout()
    })
    wc.on('audio-state-changed', (e) => {
      if (e.audible) this.audible.add(id)
      else this.audible.delete(id)
      this.push()
    })
    wc.on('render-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit') return
      this.crashed.add(id)
      this.push()
    })
    wc.on('zoom-changed', (_e, dir) => this.zoomBy(id, dir === 'in' ? 0.1 : -0.1))
    wc.setWindowOpenHandler((d) => {
      if (process.env.DRIFT_DEBUG) console.warn('[drift] window.open', d.disposition, JSON.stringify(d.features), d.url.slice(0, 100))
      const popup = d.disposition === 'new-window' && /width|height|popup/.test(d.features)
      if (popup) {
        // Sign-in and payment popups need window.opener, so they get the opener's real web contents,
        // shown as a card inside Drift rather than a loose window niri would tile somewhere else.
        return {
          action: 'allow',
          createWindow: (options) => {
            const existing = (options as { webContents?: WebContents }).webContents
            if (process.env.DRIFT_DEBUG) console.warn('[drift] popup created, opener contents provided:', !!existing, Object.keys(options).join(','))
            return this.openPopup(existing, d.url)
          },
        }
      }
      const background = d.disposition === 'background-tab'
      return {
        action: 'allow',
        createWindow: (options) => {
          const t = this.model.addTab(d.url, { afterActive: true, activate: !background, title: d.url })
          const view = this.createView(t, (options as { webContents?: WebContents }).webContents)
          setImmediate(() => this.layout())
          return view.webContents
        },
      }
    })
  }

  // ---------- input ----------

  private onKey(e: Electron.Event, input: Electron.Input, tabId: string | null) {
    const action = matchShortcut(input)
    if (!action) return
    if (action === 'escape') {
      if (this.fullscreenTab) {
        void this.views.get(this.fullscreenTab)?.webContents.executeJavaScript('document.exitFullscreen()').catch(() => {})
        return
      }
      if (this.findTab && tabId) {
        e.preventDefault()
        return this.stopFind()
      }
      return // the UI handles its own Escape
    }
    if (!this.canRun(action)) return
    e.preventDefault()
    this.run(action)
  }

  private canRun(action: string): boolean {
    const [name, arg] = action.split(':')
    if (name === 'tab.index') return Number(arg) < this.model.essentials.length + this.model.activeWorkspace.tabOrder.length
    if (name === 'ws.index') return Number(arg) < this.model.workspaces.length
    return true
  }

  run(action: string) {
    const t = this.model.activeTab
    const wc = t ? this.views.get(t.id)?.webContents : undefined
    const [name, arg] = action.split(':')
    if (UI_ACTIONS.has(name)) return this.ui.webContents.send('action', action)
    switch (name) {
      case 'tab.close': return t && this.close(t.id)
      case 'tab.reopen': {
        const r = this.model.reopenClosed()
        return r && this.layout()
      }
      case 'tab.next': return this.cycle(1)
      case 'tab.prev': return this.cycle(-1)
      case 'tab.index': {
        const ids = [...this.model.essentials, ...this.model.activeWorkspace.tabOrder]
        return ids[Number(arg)] && this.activate(ids[Number(arg)])
      }
      case 'tab.last': {
        const ids = this.model.activeWorkspace.tabOrder
        return ids.length && this.activate(ids[ids.length - 1])
      }
      case 'page.reload': return wc?.reload()
      case 'page.hardReload': return wc?.reloadIgnoringCache()
      case 'page.back': return wc?.navigationHistory.canGoBack() && wc.navigationHistory.goBack()
      case 'page.forward': return wc?.navigationHistory.canGoForward() && wc.navigationHistory.goForward()
      case 'zoom.in': return t && this.zoomBy(t.id, 0.1)
      case 'zoom.out': return t && this.zoomBy(t.id, -0.1)
      case 'zoom.reset': return t && this.zoomBy(t.id, 0)
      case 'devtools': return wc?.toggleDevTools()
      case 'bookmark': return t && this.toggleBookmark(t.id)
      case 'sidebar.toggle': return this.setSidebarPinned(!this.settings.sidebarPinned)
      case 'ws.next': return this.switchWorkspace(this.model.neighborWorkspace(1).id, 1)
      case 'ws.prev': return this.switchWorkspace(this.model.neighborWorkspace(-1).id, -1)
      case 'ws.index': {
        const ws = this.model.workspaces[Number(arg)]
        return ws && this.switchWorkspace(ws.id)
      }
      case 'split.recent': return this.splitRecent()
      case 'split.clear': {
        const ws = this.model.activeWorkspace
        return ws.split && this.transition('split', null, () => (ws.split = null))
      }
      case 'fullscreen': return this.win.setFullScreen(!this.win.isFullScreen())
      case 'quit': return app.quit()
    }
  }

  private splitRecent() {
    const ws = this.model.activeWorkspace
    const active = ws.activeTabId
    if (!active) return
    const shown = this.model.visibleTabIds()
    const other = ws.tabOrder
      .filter((id) => !shown.includes(id))
      .map((id) => this.model.tabs.get(id)!)
      .sort((a, b) => b.lastActive - a.lastActive)[0]
    if (!other) return
    return this.transition('split', null, () => this.model.split(active, other.id, 'right'))
  }

  setSidebarPinned(on: boolean) {
    return this.transition('sidebar', { pinned: on }, () => {
      this.settings.sidebarPinned = on
      this.emit('settings')
    })
  }

  zoomBy(id: string, delta: number) {
    const wc = this.views.get(id)?.webContents
    if (!wc) return
    const z = delta === 0 ? 1 : Math.min(3, Math.max(0.3, Math.round(((this.zoom.get(id) ?? 1) + delta) * 10) / 10))
    this.zoom.set(id, z)
    wc.setZoomFactor(z)
    this.push()
  }

  toggleBookmark(id: string) {
    const t = this.model.tabs.get(id)
    if (!t) return
    if (this.opts.history.isBookmarked(t.url)) this.opts.history.removeBookmark(t.url)
    else this.opts.history.addBookmark(t.url, t.title)
    this.push()
  }

  // ---------- find ----------

  startFind(text: string, forward = true, next = false) {
    const t = this.model.activeTab
    const wc = t && this.views.get(t.id)?.webContents
    if (!t || !wc) return
    if (this.findTab !== t.id) {
      this.findTab = t.id
      this.layout()
    }
    this.find.text = text
    if (!text) {
      wc.stopFindInPage('clearSelection')
      this.find.active = this.find.total = 0
      return this.push()
    }
    wc.findInPage(text, { forward, findNext: !next })
  }

  stopFind() {
    const v = this.findTab && this.views.get(this.findTab)
    if (v) v.webContents.stopFindInPage('keepSelection')
    this.findTab = null
    this.find = { text: '', active: 0, total: 0 }
    this.layout()
    this.activePageFocus()
  }

  // ---------- menus, downloads, permissions ----------

  private contextMenu(id: string, wc: WebContents, p: Electron.ContextMenuParams) {
    const items: MenuItemConstructorOptions[] = []
    const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' })
    if (p.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => this.open(p.linkURL, { background: true }) },
        { label: 'Open link in split', click: () => this.open(p.linkURL, { split: 'right' }) },
        { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) },
      )
      sep()
    }
    if (p.mediaType === 'image') {
      items.push(
        { label: 'Open image in new tab', click: () => this.open(p.srcURL, { background: true }) },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Save image', click: () => wc.downloadURL(p.srcURL) },
      )
      sep()
    }
    if (p.isEditable) {
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
      if (p.dictionarySuggestions.length) sep()
      items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' })
      sep()
    } else if (p.selectionText) {
      const q = p.selectionText.trim().slice(0, 60)
      items.push({ role: 'copy' }, { label: `Search Google for "${q}"`, click: () => this.open(p.selectionText, { background: false }) })
      sep()
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText) {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
      )
      sep()
    }
    const ext = this.extOk(wc) ? this.extensions?.getContextMenuItems(wc, p) ?? [] : []
    for (const item of ext) items.push(item as unknown as MenuItemConstructorOptions)
    if (ext.length) sep()
    items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) })
    void id
    Menu.buildFromTemplate(items).popup()
  }

  private onDownload(item: DownloadItem, _wc: WebContents) {
    const d: Download = { id: randomUUID().slice(0, 8), name: item.getFilename(), path: '', received: 0, total: item.getTotalBytes(), state: 'progressing', item }
    item.setSavePath(uniquePath(app.getPath('downloads'), item.getFilename()))
    d.path = item.getSavePath()
    this.downloads.unshift(d)
    this.downloads = this.downloads.slice(0, 20)
    item.on('updated', (_e, state) => {
      d.received = item.getReceivedBytes()
      d.total = item.getTotalBytes()
      d.state = state
      this.push()
    })
    item.once('done', (_e, state) => {
      d.state = state
      d.received = item.getReceivedBytes()
      d.item = undefined
      this.push()
    })
    this.push()
  }

  downloadAction(id: string, action: 'open' | 'show' | 'cancel' | 'dismiss') {
    const d = this.downloads.find((x) => x.id === id)
    if (!d) return
    if (action === 'open') void shell.openPath(d.path)
    if (action === 'show') shell.showItemInFolder(d.path)
    if (action === 'cancel') d.item?.cancel()
    if (action === 'dismiss') this.downloads = this.downloads.filter((x) => x.id !== id)
    this.push()
  }

  // Grants made in private spaces live only as long as the app does.
  private privatePermissions = new PermissionStore(null)

  private storeFor(wc: WebContents | null): PermissionStore {
    return wc && wc.session === this.opts.privateSession ? this.privatePermissions : this.opts.permissions
  }

  private onPermission(wc: WebContents | null, permission: string, cb: (ok: boolean) => void, url: string, mediaTypes: string[] = []) {
    if (QUIET.includes(permission)) return cb(true)
    if (wc && wc.id === this.ui.webContents.id) return cb(false)
    let origin = url
    try {
      origin = new URL(url).origin
    } catch { /* keep raw */ }
    const store = this.storeFor(wc)
    const decision = store.decide(origin, permission, mediaTypes)
    if (decision !== 'ask') return cb(decision === 'allow')
    // A site often asks several times in a row; fold them into the prompt already showing.
    const same = this.prompts.find((p) => p.origin === origin && p.permission === permission && p.store === store && p.mediaTypes.join() === [...mediaTypes].sort().join())
    if (same) return void same.callbacks.push(cb)
    const devices = mediaTypes.filter((t) => t === 'audio' || t === 'video').sort()
    const label = permission !== 'media' ? permission : devices.join() === 'audio' ? 'microphone' : devices.join() === 'video' ? 'camera' : 'camera and microphone'
    this.prompts.push({
      id: randomUUID().slice(0, 8), origin, permission, label, mediaTypes: [...mediaTypes].sort(),
      tabId: wc ? this.tabFor(wc) : null, store, callbacks: [cb],
    })
    this.push()
  }

  answerPrompt(id: string, ok: boolean) {
    const p = this.prompts.find((x) => x.id === id)
    if (!p) return
    this.prompts = this.prompts.filter((x) => x !== p)
    p.store.record(p.origin, p.permission, p.mediaTypes, ok)
    p.callbacks.forEach((cb) => cb(ok))
    this.push()
  }

  // ---------- memory ----------

  private tick() {
    const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m]))
    this.totalMB = Math.round([...byPid.values()].reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024)
    for (const [id, v] of this.views) {
      const m = byPid.get(v.webContents.getOSProcessId())
      if (m) this.memory.set(id, { mb: Math.round(m.memory.workingSetSize / 1024), cpu: m.cpu.percentCPUUsage })
    }
    const visible = new Set(this.model.visibleTabIds())
    const loads = [...this.views.keys()].map((id) => ({
      id, lastActive: this.model.tabs.get(id)?.lastActive ?? 0, sleeping: false, visible: visible.has(id),
      audible: this.audible.has(id), memoryMB: this.memory.get(id)?.mb ?? 0,
    }))
    const sleepy = pickTabsToSleep(loads, { now: Date.now(), idleMs: this.settings.idleMinutes * 60_000, capMB: this.settings.memoryCapMB })
    for (const id of sleepy) this.sleep(id)
    // A minute after an agent stops working in a tab, it is throttled like any other background tab again.
    for (const [id, t] of this.agentTouched) {
      if (Date.now() - t < 60_000) continue
      this.agentTouched.delete(id)
      const wc = this.views.get(id)?.webContents
      if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(true)
    }
    {
      const now = Date.now()
      const busy = (id: string) => this.audible.has(id) || now - (this.agentTouched.get(id) ?? 0) < 20_000 || this.loading.has(id)
      for (const id of this.trimmer.due(loads.map((l) => ({ id: l.id, visible: l.visible, busy: busy(l.id) })), now)) void this.trim(id)
    }
    this.push()
  }

  /** Drop a hidden tab's caches and garbage, the way Chromium does under memory pressure. */
  private async trim(id: string) {
    const wc = this.views.get(id)?.webContents
    if (!wc || wc.isDestroyed() || wc.debugger.isAttached()) return
    try {
      wc.debugger.attach('1.3')
      await wc.debugger.sendCommand('Memory.simulatePressureNotification', { level: 'critical' })
      await wc.debugger.sendCommand('HeapProfiler.collectGarbage')
    } catch {
      // the tab went away or navigated mid-trim
    } finally {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
    }
  }

  sleepIdle(): string[] {
    const visible = new Set(this.model.visibleTabIds())
    return [...this.views.keys()].filter((id) => !visible.has(id) && this.sleep(id))
  }
}

function uniquePath(dir: string, name: string): string {
  let p = `${dir}/${name}`
  const dot = name.lastIndexOf('.')
  for (let i = 1; existsSync(p); i++) p = dot > 0 ? `${dir}/${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${dir}/${name} (${i})`
  return p
}

function errorPage(code: number, desc: string, url: string, t: Record<string, string>): string {
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  const msg: Record<number, string> = {
    [-105]: `Couldn't find ${host}. Check the address.`,
    [-106]: 'You are offline.',
    [-102]: `${host} refused to connect.`,
    [-118]: `${host} took too long to respond.`,
    [-200]: `${host} has a certificate problem.`,
    [-20]: `Drift blocked ${host}. It is on a malware, phishing, or tracker list.`,
  }
  const html = `<style>html{background:${t['--bg'] ?? '#121316'};color:${t['--fg'] ?? '#e3e2e6'};font:15px/1.5 "PP Neue Montreal",system-ui,sans-serif;height:100%;display:grid;place-items:center}
main{max-width:520px;padding:32px}h1{font-size:28px;font-weight:500;margin:0 0 8px;letter-spacing:-.01em}p{margin:0 0 24px;opacity:.7}
button{font:inherit;background:${t['--accent'] ?? '#a8c7fa'};color:${t['--on-accent'] ?? '#0a305f'};border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
button:focus-visible{outline:2px solid ${t['--fg'] ?? '#fff'};outline-offset:2px}code{opacity:.5;font-size:12px}</style>
<main><h1>${msg[code] ?? "This page didn't load."}</h1><p>${desc} <code>${code}</code></p><button onclick="location.reload()">Try again</button></main>`
  return `document.open();document.write(${JSON.stringify(html)});document.close();document.title=${JSON.stringify(host)};`
}

