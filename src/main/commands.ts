// Every action the UI and the CLI can take, registered once on the shared Rpc.
import { app, clipboard, safeStorage, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'
import { Rpc } from './rpc'
import type { Browser } from './browser'
import type { HistoryStore } from './history'
import type { Adblock } from './adblock'
import type { Extensions } from './extensions'
import type { Side } from './layout'
import { rank, Candidate } from './search'
import * as page from './pagetools'
import * as brave from './brave'
import * as zen from './zen'
import type { PasswordStore } from './passwords'
import type { Autofill } from './autofill'
import type { PermissionStore } from './permissions'
import type { Agents } from './agent'

type P = Record<string, unknown>
const SEARCH_PAGE = /google\.[a-z.]+\/search|search\.brave\.com\/search|duckduckgo\.com\/\?|bing\.com\/search/
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))

export function registerCommands(
  rpc: Rpc,
  b: Browser,
  deps: {
    history: HistoryStore; adblock: Adblock; extensions: Extensions; session: Session; privateSession: Session
    saveSettings: () => void; passwords: PasswordStore; autofill: Autofill; applyDoh: (on: boolean) => void
    permissions: PermissionStore
    agents: Agents
  },
) {
  const { history, adblock, extensions, session } = deps
  const m = () => b.model

  /** 'active' | '@3' (1-based position) | id | unique title/url substring. */
  const resolveTab = (spec: unknown): string => {
    const s = str(spec) ?? 'active'
    if (s === 'active') {
      const id = m().activeWorkspace.activeTabId
      if (!id) throw new Error('no active tab')
      return id
    }
    if (/^@\d+$/.test(s)) {
      const order = [...m().essentials, ...m().activeWorkspace.tabOrder]
      const id = order[Number(s.slice(1)) - 1]
      if (!id) throw new Error(`no tab at ${s}`)
      return id
    }
    if (m().tabs.has(s)) return s
    const hits = [...m().tabs.values()].filter((t) => t.title.toLowerCase().includes(s.toLowerCase()) || t.url.includes(s))
    if (hits.length === 1) return hits[0].id
    throw new Error(hits.length ? `"${s}" matches ${hits.length} tabs, use an id` : `no tab ${s}`)
  }

  const resolveWs = (spec: unknown) => {
    const s = str(spec)
    if (!s) throw new Error('workspace required')
    if (s === 'next') return m().neighborWorkspace(1)
    if (s === 'prev') return m().neighborWorkspace(-1)
    const ws = m().workspaces.find((w) => w.id === s || w.name.toLowerCase() === s.toLowerCase())
    if (!ws) throw new Error(`no workspace ${s}`)
    return ws
  }

  /** Wakes a tab if needed and waits for its first load so page.* commands see real content. */
  const live = async (spec: unknown): Promise<WebContents> => {
    // 'popup' targets the sign-in popup card, so scripts can drive OAuth flows too.
    if (spec === 'popup') {
      const pv = b.popupView
      if (!pv || pv.webContents.isDestroyed()) throw new Error('no popup open')
      return pv.webContents
    }
    const id = resolveTab(spec)
    const v = b.wake(id)
    if (!v) throw new Error(`no tab ${id}`)
    const wc = v.webContents
    if (wc.isLoading() || wc.getURL() === '') {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 15_000)
        wc.once('did-stop-loading', () => {
          clearTimeout(t)
          res()
        })
      })
    }
    return wc
  }

  const tabRow = (id: string) => {
    const t = m().tabs.get(id)!
    const info = b.tabInfo(t)
    const ws = t.workspaceId ? m().workspace(t.workspaceId).name : 'essentials'
    return {
      id, title: t.title, url: t.url, workspace: ws, active: m().activeWorkspace.activeTabId === id,
      visible: m().visibleTabIds().includes(id), sleeping: info.sleeping, memoryMB: info.memoryMB, blocked: info.blocked,
    }
  }

  // ---- tabs
  rpc.register('tabs.open', 'Open a url or search', '<url|query> [--bg] [--ws name] [--split side]', (p: P) => {
    const ws = p.workspace ? resolveWs(p.workspace) : null
    if (ws && ws.id !== m().activeWorkspaceId && !p.background) m().switchWorkspace(ws.id)
    const t = b.open(String(p.url ?? ''), { background: !!p.background, workspaceId: ws?.id, split: str(p.split) as Side | undefined })
    return tabRow(t.id)
  })
  rpc.register('tabs.list', 'List tabs', '[--all]', (p: P) => {
    const ids = p.all ? [...m().tabs.keys()] : [...m().essentials, ...m().activeWorkspace.tabOrder]
    return ids.map(tabRow)
  })
  rpc.register('tabs.focus', 'Focus a tab', '<tab>', (p: P) => {
    b.activate(resolveTab(p.tab))
    return tabRow(resolveTab(p.tab))
  })
  rpc.register('tabs.close', 'Close tabs', '<tab...>', (p: P) => {
    const list = Array.isArray(p.tabs) ? p.tabs : [p.tabs ?? p.tab ?? 'active']
    const ids = list.map(resolveTab)
    ids.forEach((id) => b.close(id))
    return { closed: ids }
  })
  rpc.register('tabs.reload', 'Reload a tab', '<tab>', async (p: P) => (await live(p.tab)).reload())
  rpc.register('tabs.back', 'Go back', '<tab>', async (p: P) => (await live(p.tab)).navigationHistory.goBack())
  rpc.register('tabs.forward', 'Go forward', '<tab>', async (p: P) => (await live(p.tab)).navigationHistory.goForward())
  rpc.register('tabs.navigate', 'Load a url in a tab', '<tab> <url>', async (p: P) => {
    const id = resolveTab(p.tab)
    const wc = b.wake(id)!.webContents
    const { toUrl, searchUrl } = await import('./search')
    const input = String(p.url ?? '')
    const url = toUrl(input) ?? searchUrl(input, b.settings.searchEngine)
    await wc.loadURL(b.clean(url) ?? url).catch(() => {})
    return tabRow(id)
  })
  rpc.register('tabs.sleep', 'Sleep a tab or every hidden tab', '<tab|all-idle>', (p: P) => {
    if (p.tab === 'all-idle' || p.tab === 'all') return { slept: b.sleepIdle() }
    const id = resolveTab(p.tab)
    if (!b.sleep(id)) throw new Error('tab is visible, playing audio, or already asleep')
    return { slept: [id] }
  })
  rpc.register('tabs.wake', 'Wake a sleeping tab', '<tab>', async (p: P) => {
    await live(p.tab)
    return tabRow(resolveTab(p.tab))
  })
  rpc.register('tabs.move', 'Move a tab', '<tab> <workspace> <index>', (p: P) => {
    const id = resolveTab(p.tab)
    m().moveTab(id, resolveWs(p.workspace ?? m().activeWorkspaceId).id, Number(p.index ?? 0))
    b.layout()
  })
  rpc.register('tabs.essential', 'Pin a tab to essentials, optionally at a position', '<tab> <on> [index]', (p: P) => {
    m().setEssential(resolveTab(p.tab), p.on !== false, p.index === undefined ? undefined : Number(p.index))
    b.layout()
  })
  rpc.register('tabs.mute', 'Toggle mute', '<tab>', (p: P) => {
    const wc = b.views.get(resolveTab(p.tab))?.webContents
    if (wc) wc.setAudioMuted(!wc.isAudioMuted())
    b.push()
  })
  rpc.register('tabs.duplicate', 'Open a copy of a tab next to it', '<tab>', (p: P) => {
    const t = m().tabs.get(resolveTab(p.tab))!
    if (t.workspaceId && t.workspaceId !== m().activeWorkspaceId) m().switchWorkspace(t.workspaceId)
    if (m().activeWorkspace.activeTabId !== t.id) m().activateTab(t.id)
    return tabRow(b.open(t.url, { raw: true }).id)
  })
  rpc.register('tabs.closeOthers', 'Close every other tab in the space', '<tab>', (p: P) => {
    const id = resolveTab(p.tab)
    const ws = m().tabs.get(id)!.workspaceId ?? m().activeWorkspaceId
    const ids = m().workspace(ws).tabOrder.filter((x) => x !== id)
    ids.forEach((x) => b.close(x))
    return { closed: ids }
  })
  rpc.register('tabs.closeBelow', 'Close tabs below this one', '<tab>', (p: P) => {
    const id = resolveTab(p.tab)
    const order = m().workspace(m().tabs.get(id)!.workspaceId ?? m().activeWorkspaceId).tabOrder
    const ids = order.slice(order.indexOf(id) + 1)
    ids.forEach((x) => b.close(x))
    return { closed: ids }
  })
  rpc.register('tabs.menu', 'Show the right-click menu for a tab', '<tab>', (p: P) => {
    const id = resolveTab(p.tab)
    const t = m().tabs.get(id)!
    const ws = m().activeWorkspace
    const essential = m().essentials.includes(id)
    const wc = b.views.get(id)?.webContents
    const inSplit = !!ws.split && m().visibleTabIds().length > 1 && m().visibleTabIds().includes(id)
    const active = ws.activeTabId
    const run = (name: string, params: P = {}) => () => void rpc.call(name, { tab: id, ...params }).catch(() => {})
    const items: MenuItemConstructorOptions[] = [
      { label: 'Copy link', click: () => clipboard.writeText(t.url) },
      { label: 'Duplicate', click: run('tabs.duplicate') },
      { label: 'Reload', click: run('tabs.reload') },
    ]
    if (wc && (wc.isCurrentlyAudible() || wc.isAudioMuted())) items.push({ label: wc.isAudioMuted() ? 'Unmute' : 'Mute', click: run('tabs.mute') })
    items.push({ type: 'separator' }, { label: essential ? 'Unpin from Essentials' : 'Pin to Essentials', click: run('tabs.essential', { on: !essential }) })
    if (inSplit) {
      items.push({ label: 'Remove from split', click: run('split.remove') }, { label: 'Unsplit all', click: () => b.run('split.clear') })
    } else if (active && active !== id && !essential) {
      items.push({
        label: 'Open in split',
        submenu: (['right', 'left', 'bottom', 'top'] as Side[]).map((side) => ({
          label: side[0].toUpperCase() + side.slice(1),
          click: () => void rpc.call('split.add', { target: active, tab: id, side }).catch(() => {}),
        })),
      })
    }
    const others = m().workspaces.filter((w) => w.id !== t.workspaceId)
    items.push({
      label: 'Move to space',
      submenu: [
        ...others.map((w) => ({ label: w.name, click: () => { m().moveTab(id, w.id, 999); b.layout() } })),
        ...(others.length ? [{ type: 'separator' as const }] : []),
        {
          label: 'New space',
          click: () => {
            const w = m().createWorkspace(`Space ${m().workspaces.length + 1}`, null)
            m().moveTab(id, w.id, 0)
            b.layout()
          },
        },
      ],
    })
    items.push(
      { label: history.isBookmarked(t.url) ? 'Remove bookmark' : 'Bookmark', click: run('bookmarks.toggle') },
      b.views.has(id) ? { label: 'Sleep', enabled: !m().visibleTabIds().includes(id), click: run('tabs.sleep') } : { label: 'Wake', click: run('tabs.wake') },
      { type: 'separator' },
      { label: 'Close', click: () => b.close(id) },
    )
    if (!essential) items.push({ label: 'Close other tabs', click: run('tabs.closeOthers') }, { label: 'Close tabs below', click: run('tabs.closeBelow') })
    b.showMenu(items)
  })
  rpc.register('tabs.reopen', 'Reopen the last closed tab', '', () => {
    const t = m().reopenClosed()
    b.layout()
    return t && tabRow(t.id)
  })

  // ---- workspaces
  rpc.register('ws.list', 'List workspaces', '', () =>
    m().workspaces.map((w) => ({ id: w.id, name: w.name, tabs: w.tabOrder.length, active: w.id === m().activeWorkspaceId, hue: w.hue })),
  )
  rpc.register('ws.create', 'Create a workspace', '<name>', async (p: P) => {
    const used = m().workspaces.map((w) => w.hue).filter((h): h is number => h !== null)
    const hue = p.hue !== undefined ? Number(p.hue) : nextHue(used)
    const ws = m().createWorkspace(String(p.name ?? (p.private ? 'Private' : `Space ${m().workspaces.length + 1}`)), p.private ? 300 : hue, !!p.private)
    // Wait for the switch: anything opened next must land in the new space (a private one especially).
    if (p.switch !== false) await b.switchWorkspace(ws.id, 1)
    else b.push()
    return { id: ws.id, name: ws.name }
  })
  rpc.register('ws.switch', 'Switch workspace', '<name|id|next|prev>', async (p: P) => {
    const ws = resolveWs(p.target)
    const dir = p.target === 'prev' ? -1 : p.target === 'next' ? 1 : undefined
    await b.switchWorkspace(ws.id, dir)
    return { id: ws.id, name: ws.name }
  })
  rpc.register('ws.remove', 'Remove a workspace and its tabs', '<name|id>', (p: P) => {
    b.removeWorkspace(resolveWs(p.target).id)
  })
  rpc.register('ws.rename', 'Rename a workspace', '<target> <name>', (p: P) => {
    resolveWs(p.target).name = String(p.name)
    b.push()
  })
  rpc.register('ws.move', 'Move a workspace to a position', '<target> <index>', (p: P) => {
    m().moveWorkspace(resolveWs(p.target).id, Number(p.index ?? 0))
    b.push()
  })
  rpc.register('ws.menu', 'Show the right-click menu for a workspace', '<target>', (p: P) => {
    const ws = resolveWs(p.target)
    const i = m().workspaces.indexOf(ws)
    const n = m().workspaces.length
    const items: MenuItemConstructorOptions[] = [
      { label: 'Rename', click: () => b.run(`ws.rename:${ws.id}`) },
      {
        label: 'Color',
        submenu: HUES.map(([label, hue]) => ({
          label, type: 'radio' as const, checked: ws.hue === hue,
          click: () => { ws.hue = hue; b.push() },
        })),
      },
      { label: 'Move left', enabled: i > 0, click: () => { m().moveWorkspace(ws.id, i - 1); b.push() } },
      { label: 'Move right', enabled: i < n - 1, click: () => { m().moveWorkspace(ws.id, i + 1); b.push() } },
      { type: 'separator' },
      { label: 'New space', click: () => void rpc.call('ws.create', {}) },
      { label: 'New private space', click: () => void rpc.call('ws.create', { private: true }) },
      { type: 'separator' },
      { label: 'Delete space', enabled: n > 1, click: () => b.run(`ws.delete:${ws.id}`) },
    ]
    b.showMenu(items)
  })
  rpc.register('ws.setHue', 'Set a workspace hue (null = wallpaper)', '<target> <hue>', (p: P) => {
    resolveWs(p.target).hue = p.hue === null ? null : Number(p.hue)
    b.emit('theme')
  })

  // ---- split
  rpc.register('split.add', 'Tile a tab next to another', '<target> <tab> [side]', async (p: P) => {
    const target = resolveTab(p.target)
    const tab = resolveTab(p.tab)
    const tws = m().tabs.get(target)!.workspaceId
    if (tws && m().tabs.get(tab)!.workspaceId !== tws) m().moveTab(tab, tws, 999)
    await b.transition('split', null, () => {
      m().activateTab(target)
      m().split(target, tab, (str(p.side) ?? 'right') as Side)
    })
    return m().visibleTabIds()
  })
  rpc.register('split.remove', 'Take a tab out of the split', '<tab>', async (p: P) => {
    const id = resolveTab(p.tab)
    await b.transition('split', null, () => m().unsplit(id))
  })
  rpc.register('split.resize', 'Resize a split divider', '<path> <index> <delta>', async (p: P) => {
    const ws = m().activeWorkspace
    if (!ws.split) return
    const { resize } = await import('./layout')
    ws.split = resize(ws.split, (p.path as number[]) ?? [], Number(p.index ?? 0), Number(p.delta ?? 0))
    b.layout()
  })

  // ---- page
  rpc.register('page.url', 'Current url', '[tab]', async (p: P) => (await live(p.tab)).getURL())
  rpc.register('page.text', 'Visible text', '[tab]', async (p: P) => page.pageText(await live(p.tab)))
  rpc.register('page.html', 'Page HTML', '[tab]', async (p: P) => page.pageHtml(await live(p.tab)))
  rpc.register('page.markdown', 'Page as Markdown', '[tab]', async (p: P) => page.pageMarkdown(await live(p.tab)))
  rpc.register('page.screenshot', 'PNG screenshot', '[tab] [--full]', async (p: P) => {
    const wc = await live(p.tab)
    const buf = await b.withShown(wc, () => page.screenshot(wc, !!p.full))
    return { $b64: buf.toString('base64') }
  })
  rpc.register('page.click', 'Click a selector or text:Label', '<tab> <target>', async (p: P) => page.click(await live(p.tab), String(p.target)))
  rpc.register('page.type', 'Type into a field', '<tab> <selector> <text> [--submit]', async (p: P) =>
    page.typeText(await live(p.tab), String(p.selector), String(p.text ?? ''), !!p.submit),
  )
  rpc.register('page.eval', 'Run JavaScript', '<tab> <js> [--timeout ms]', async (p: P) =>
    page.evalJs(await live(p.tab), String(p.js), p.timeout ? Number(p.timeout) : undefined),
  )
  rpc.register('page.wait', 'Wait for a selector or text', '<tab> <target> [--timeout ms]', async (p: P) =>
    page.waitFor(await live(p.tab), String(p.target), p.timeout ? Number(p.timeout) : undefined),
  )
  rpc.register('page.scroll', 'Scroll to px, top, or bottom', '<tab> <to>', async (p: P) => page.scroll(await live(p.tab), String(p.to ?? 'bottom')))

  // ---- find, zoom, devtools
  rpc.register('find.query', 'Find in page', '<text> [forward]', (p: P) => b.startFind(String(p.text ?? ''), p.forward !== false, !!p.next))
  rpc.register('find.stop', 'Close find', '', () => b.stopFind())
  rpc.register('run', 'Run a shortcut action', '<action>', (p: P) => b.run(String(p.action)))
  rpc.register('debug.capture', 'Window layers for compositing a full screenshot', '', async () => {
    const [w, h] = b.win.getContentSize()
    const ui = await b.ui.webContents.capturePage()
    const panes = []
    for (const { id, rect } of b.panes()) {
      const v = b.views.get(id)
      if (!v || !v.getVisible()) continue
      panes.push({ rect, png: (await v.webContents.capturePage()).toPNG().toString('base64') })
    }
    const pv = b.popupView
    const popup = pv && !pv.webContents.isDestroyed() ? { rect: b.popupRect(), png: (await pv.webContents.capturePage()).toPNG().toString('base64') } : null
    return { width: w, height: h, ui: ui.toPNG().toString('base64'), panes, overlayOnTop: b.isOverlay, popup }
  })
  rpc.register('debug.uiType', 'Type into the browser UI', '<text>', async (p: P) => {
    b.ui.webContents.focus()
    await b.ui.webContents.insertText(String(p.text ?? ''))
  })
  rpc.register('debug.uiEval', 'Run JavaScript in the browser UI', '<js>', (p: P) => b.ui.webContents.executeJavaScript(String(p.js)))
  rpc.register('debug.uiInput', 'Send a raw input event to the browser UI', '<event>', (p: P) => {
    b.ui.webContents.sendInputEvent(p as unknown as Electron.MouseInputEvent)
  })
  rpc.register('debug.pageInput', 'Send a raw input event to a page', '<tab> <event>', async (p: P) => {
    const { tab, ...ev } = p
    ;(await live(tab)).sendInputEvent(ev as unknown as Electron.MouseInputEvent)
  })
  rpc.register('debug.uiKey', 'Press a key in the browser UI', '<key>', (p: P) => {
    const keyCode = String(p.key)
    b.ui.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    b.ui.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  })
  rpc.register('debug.cdpClick', 'Click at page coordinates through the DevTools protocol', '<tab> <x> <y>', async (p: P) => {
    const wc = await live(p.tab)
    const dbg = wc.debugger
    const mine = !dbg.isAttached()
    if (mine) dbg.attach('1.3')
    try {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: Number(p.x), y: Number(p.y), button: 'left', clickCount: 1 })
      }
    } finally {
      if (mine) dbg.detach()
    }
  })
  rpc.register('debug.uiPid', 'OS process id of the browser UI renderer', '', () => b.ui.webContents.getOSProcessId())
  rpc.register('debug.contents', 'Every web contents: type, url, and whether it is a tab', '', async () => {
    const { webContents } = await import('electron')
    return webContents.getAllWebContents().map((wc) => ({ id: wc.id, type: wc.getType(), tab: b.tabFor(wc), url: wc.getURL().slice(0, 120) }))
  })
  rpc.register('debug.uiOnTop', 'Whether the browser UI is stacked above the pages', '', () => {
    const kids = b.win.contentView.children
    return kids.indexOf(b.ui) > Math.max(-1, ...[...b.views.values()].map((v) => kids.indexOf(v)))
  })
  rpc.register('debug.resize', 'Resize the window', '<w> <h>', (p: P) => {
    b.win.setContentSize(Number(p.w), Number(p.h))
    b.layout()
  })

  // ---- stats + sleep settings
  rpc.register('stats', 'Memory and CPU per tab', '', () => ({
    totalMB: b.totalMB,
    blocked: adblock.total,
    processes: processBreakdown(),
    tabs: [...m().tabs.keys()].map((id) => ({ ...tabRow(id), cpu: Math.round((b.memory.get(id)?.cpu ?? 0) * 10) / 10 })),
  }))
  rpc.register('settings.get', 'Read settings', '', () => b.settings)
  rpc.register('settings.set', 'Change settings', '<key> <value>', (p: P) => {
    const allowed = Object.keys(b.settings)
    const changes = Object.fromEntries(Object.entries(p).filter(([k]) => allowed.includes(k)))
    const pinned = b.settings.sidebarPinned
    Object.assign(b.settings, changes, { sidebarPinned: pinned })
    deps.saveSettings()
    if ('adblock' in changes) adblock.set(!!changes.adblock)
    if ('doh' in changes) deps.applyDoh(!!changes.doh)
    if ('idleMinutes' in changes || 'memoryCapMB' in changes) b.emit('settings')
    if ('sidebarPinned' in changes && changes.sidebarPinned !== pinned) void b.setSidebarPinned(!!changes.sidebarPinned)
    b.push()
    return b.settings
  })

  // ---- adblock
  rpc.register('adblock.status', 'Adblock status', '', () => ({ enabled: adblock.enabled, blocked: adblock.total }))
  rpc.register('adblock.set', 'Turn adblock on or off', '<on|off>', (p: P) => {
    adblock.set(!!p.enabled)
    b.settings.adblock = !!p.enabled
    deps.saveSettings()
    b.push()
    return { enabled: adblock.enabled }
  })

  // ---- bookmarks + history
  rpc.register('bookmarks.add', 'Bookmark a tab', '[tab]', (p: P) => {
    const t = m().tabs.get(resolveTab(p.tab))!
    history.addBookmark(t.url, t.title)
    b.push()
    return { url: t.url }
  })
  rpc.register('bookmarks.toggle', 'Toggle bookmark', '[tab]', (p: P) => b.toggleBookmark(resolveTab(p.tab)))
  rpc.register('bookmarks.list', 'List bookmarks', '', () => history.bookmarks())
  rpc.register('history.search', 'Search history', '<query>', (p: P) => history.search(String(p.q ?? ''), Number(p.limit ?? 20)))
  rpc.register('history.recent', 'Recently visited pages, one per site', '[limit]', (p: P) => {
    const seen = new Set<string>()
    const open = new Set([...m().tabs.values()].map((t) => t.url))
    return history.recent(200).filter((h) => {
      let host = h.url
      try {
        host = new URL(h.url).host
      } catch { /* keep url */ }
      if (seen.has(host) || open.has(h.url) || SEARCH_PAGE.test(h.url)) return false
      seen.add(host)
      return true
    }).slice(0, Number(p.limit ?? 8))
  })
  rpc.register('tabs.thumbs', 'Refresh thumbnails of on-screen tabs', '', () => b.refreshThumbs())
  rpc.register('history.clear', 'Clear history', '', () => history.clear())

  // ---- command bar
  rpc.register('ui.search', 'Command bar results', '<q>', (p: P) => {
    const q = String(p.q ?? '')
    const c: Candidate[] = []
    for (const t of m().tabs.values()) {
      const visible = m().visibleTabIds().includes(t.id)
      c.push({ kind: 'tab', id: t.id, title: t.title, url: t.url, boost: visible ? -20 : 0 })
    }
    if (q) {
      for (const h of history.search(q, 8)) c.push({ kind: 'history', id: h.url, title: h.title || h.url, url: h.url, boost: Math.min(h.visitCount, 20) })
      for (const bm of history.searchBookmarks(q, 6)) c.push({ kind: 'bookmark', id: bm.url, title: bm.title || bm.url, url: bm.url, boost: 0 })
    }
    for (const cmd of COMMANDS) c.push({ kind: 'command', id: cmd.id, title: cmd.title, url: '', boost: 0 })
    return rank(q, c, q ? 9 : 12, b.settings.searchEngine)
  })

  // ---- downloads, permissions
  rpc.register('downloads.action', 'Open, show, cancel or dismiss a download', '<id> <action>', (p: P) =>
    b.downloadAction(String(p.id), String(p.action) as 'open'),
  )
  rpc.register('popup.close', 'Close the sign-in popup', '', () => b.closePopup())
  rpc.register('prompt.answer', 'Answer a permission prompt', '<id> <ok>', (p: P) => b.answerPrompt(String(p.id), !!p.ok))

  // ---- passwords (no command ever returns a secret over the socket)
  rpc.register('pw.list', 'Saved logins (sites and usernames only)', '', () => deps.passwords.list())
  rpc.register('pw.copy', 'Copy a password; the clipboard clears after 30s', '<id>', (p: P) => deps.autofill.copy(String(p.id)))
  rpc.register('pw.remove', 'Delete a saved login', '<id>', (p: P) => {
    deps.passwords.remove(String(p.id))
    b.push()
  })
  rpc.register('pw.answer', 'Save or skip the password Drift just saw', '<id> <save>', (p: P) => deps.autofill.answer(String(p.id), !!p.save))

  // ---- extensions
  rpc.register('ext.list', 'List extensions', '', () => extensions.list())
  rpc.register('ext.load', 'Load an extension dir, .crx, or Web Store id/url', '<path|id|url>', (p: P) => extensions.load(String(p.path)))
  rpc.register('ext.remove', 'Remove an extension', '<id|path>', (p: P) => {
    extensions.remove(String(p.id ?? p.path))
    b.push()
  })
  rpc.register('ext.enable', 'Turn an extension on or off', '<path> <on>', async (p: P) => {
    await extensions.setEnabled(String(p.path), p.on !== false)
    b.push()
  })
  rpc.register('ext.catalog', 'Extensions known to work in Drift', '', () => extensions.catalog())
  rpc.register('ext.options', "Open an extension's options page", '<url>', (p: P) => {
    const url = String(p.url)
    if (!url.startsWith('chrome-extension://')) throw new Error('not an extension page')
    return tabRow(b.open(url, { raw: true }).id)
  })

  // ---- agents
  rpc.register('agent.space', 'The Agent space (created on first use) where agents browse', '', () => {
    let ws = m().workspaces.find((w) => w.agent)
    if (!ws) {
      ws = m().createWorkspace('Agent', 195)
      ws.agent = true
      b.push()
    }
    return { id: ws.id, name: ws.name }
  })
  rpc.register('agent.touch', 'Mark a tab as being worked on by an agent', '<tab>', (p: P) => {
    const id = resolveTab(p.tab)
    b.agentTouched.set(id, Date.now())
    // Agents work in background tabs; Chromium would slow their timers to about one a second.
    b.views.get(id)?.webContents.setBackgroundThrottling(false)
    b.push()
    setTimeout(() => b.push(), 20_500)
  })
  rpc.register('agent.ask', 'Hand a task to Claude Code, which drives Drift', '<prompt>', (p: P) => {
    const prompt = String(p.prompt ?? '').trim()
    if (!prompt) throw new Error('empty task')
    const t = m().activeTab
    const run = deps.agents.start(prompt, { tab: t?.id ?? null, title: t?.title ?? '', url: t?.url ?? '' })
    return { id: run.id }
  })
  rpc.register('agent.stop', 'Stop an agent run', '<id>', (p: P) => deps.agents.stop(String(p.id)))
  rpc.register('agent.dismiss', 'Stop and remove an agent run', '<id>', (p: P) => deps.agents.dismiss(String(p.id)))
  rpc.register('agent.runs', 'Agent runs and their latest steps', '', () => deps.agents.runs)

  // ---- site permissions
  rpc.register('perm.list', 'Remembered site permissions', '', () => deps.permissions.list())
  rpc.register('perm.reset', 'Forget a site permission, or all of a site', '<origin> [permission]', (p: P) => {
    deps.permissions.reset(String(p.origin), p.permission ? String(p.permission) : undefined)
  })

  // ---- data + about
  rpc.register('data.clear', 'Clear history, cookies and site data, or cache', '[--history] [--cookies] [--cache]', async (p: P) => {
    if (p.history) history.clear()
    if (p.cookies) await session.clearStorageData()
    if (p.cache) await session.clearCache()
    b.push()
    return { cleared: Object.keys(p).filter((k) => p[k]) }
  })
  rpc.register('app.restart', 'Restart Drift, restoring the session', '', () => {
    app.relaunch()
    setTimeout(() => app.quit(), 50)
  })
  rpc.register('app.info', 'Versions and paths', '', () => ({
    drift: app.getVersion(),
    chromium: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
    profile: app.getPath('userData'),
    keyring: safeKeyring(),
  }))

  // ---- import
  /** Saved logins and cookies into Drift; returns counts only. Later imports win for the same cookie. */
  const importLogins = async (logins: () => brave.BraveLogin[], cookies: () => brave.BraveCookie[], out: { passwords: number; cookies: number; cookieErrors: number }) => {
    try {
      out.passwords = deps.passwords.importMany(logins())
    } catch (err) {
      console.warn('[drift] password import skipped:', (err as Error).message)
      throw err
    }
    const now = Date.now() / 1000
    for (const c of cookies()) {
      if (c.expirationDate && c.expirationDate < now) continue
      try {
        await session.cookies.set(c)
        out.cookies++
      } catch {
        out.cookieErrors++
      }
    }
    await session.cookies.flushStore()
  }

  rpc.register('import.zen', 'Import saved passwords and cookies from Zen', '[--primary-password pw]', async (p: P) => {
    const dir = zen.zenProfileDir()
    if (!dir) throw new Error('no Zen profile found')
    const out = { passwords: 0, cookies: 0, cookieErrors: 0 }
    await importLogins(() => zen.readZenLogins(dir, String(p.primaryPassword ?? '')), () => zen.readZenCookies(dir), out)
    b.push()
    return out
  })

  rpc.register('import.brave', 'Import bookmarks, history, extensions (and cookies) from Brave', '[--cookies] [--logins-only]', async (p: P) => {
    const dir = brave.braveProfileDir()
    if (!dir) throw new Error('no Brave profile found at ~/.config/BraveSoftware/Brave-Browser/Default')
    const out = { bookmarks: 0, history: 0, extensions: [] as string[], cookies: 0, cookieErrors: 0, passwords: 0 }
    if (p.loginsOnly) {
      const pw = brave.getKeyringPassword()
      await importLogins(() => brave.readLogins(dir, pw), () => brave.readCookies(dir, pw), out)
      b.push()
      return out
    }
    const bms = brave.readBookmarks(dir)
    history.importBookmarks(bms)
    out.bookmarks = bms.length
    const hist = brave.readHistory(dir, 20_000)
    history.importHistory(hist)
    out.history = hist.length
    const have = new Set(extensions.list().map((e) => e.name))
    for (const e of brave.listExtensions(dir)) {
      // Drift's own blocker covers uBlock, and its MV3 build can't start under Electron.
      if (have.has(e.name) || /ublock/i.test(e.name)) continue
      try {
        await extensions.adopt(e.path, e.id)
        out.extensions.push(e.name)
      } catch (err) {
        console.warn(`[drift] skipped extension ${e.name}: ${(err as Error).message}`)
      }
    }
    if (p.cookies || p.passwords) {
      try {
        out.passwords = deps.passwords.importMany(brave.readLogins(dir, brave.getKeyringPassword()))
      } catch (err) {
        console.warn('[drift] password import skipped:', (err as Error).message)
      }
    }
    if (p.cookies) {
      const pw = brave.getKeyringPassword()
      for (const c of brave.readCookies(dir, pw)) {
        try {
          await session.cookies.set(c)
          out.cookies++
        } catch {
          out.cookieErrors++
        }
      }
      await session.cookies.flushStore()
    }
    b.push()
    return out
  })
}

/** Workspace colors offered in menus and settings; null follows the wallpaper. */
export const HUES: [string, number | null][] = [
  ['Match wallpaper', null], ['Red', 25], ['Amber', 80], ['Green', 145], ['Teal', 195], ['Blue', 250], ['Purple', 300], ['Pink', 340],
]

export const COMMANDS = [
  { id: 'ws.new', title: 'New workspace' },
  { id: 'ws.private', title: 'New private space' },
  { id: 'ws.rename', title: 'Rename workspace' },
  { id: 'ws.delete', title: 'Delete workspace' },
  { id: 'sidebar.toggle', title: 'Toggle sidebar' },
  { id: 'memory', title: 'Tab memory' },
  { id: 'split.recent', title: 'Split with last tab' },
  { id: 'split.clear', title: 'Unsplit' },
  { id: 'tab.essential', title: 'Pin tab to essentials' },
  { id: 'sleep.idle', title: 'Sleep hidden tabs' },
  { id: 'adblock.toggle', title: 'Toggle ad blocking' },
  { id: 'bookmark', title: 'Bookmark this page' },
  { id: 'import.brave', title: 'Import from Brave' },
  { id: 'devtools', title: 'Developer tools' },
  { id: 'ext.install', title: 'Install extension' },
  { id: 'history.clear', title: 'Clear history' },
  { id: 'passwords', title: 'Passwords' },
  { id: 'settings', title: 'Settings' },
  { id: 'agent.ask', title: 'Ask Claude to do something' },
]

/** Memory by Chromium process kind, so the fixed cost of the shell is visible next to the tabs. */
function processBreakdown(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of app.getAppMetrics()) {
    const kind = m.type === 'Utility' ? `Utility (${m.serviceName ?? m.name ?? 'other'})` : m.type
    out[kind] = (out[kind] ?? 0) + Math.round(m.memory.workingSetSize / 1024)
  }
  return out
}

/** Spreads workspace hues around the wheel, starting opposite the ones already taken. */
function nextHue(used: number[]): number {
  const candidates = [250, 145, 25, 300, 195, 80, 340]
  return candidates.find((h) => used.every((u) => Math.abs(((h - u + 540) % 360) - 180) > 30)) ?? Math.floor(Math.random() * 360)
}

function safeKeyring(): string {
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch {
    return 'unknown'
  }
}
