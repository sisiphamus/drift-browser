import { app, session as sessions, protocol, ipcMain, net, safeStorage } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, watch, existsSync } from 'node:fs'
import { Browser, DEFAULT_SETTINGS, Settings } from './browser'
import { HistoryStore } from './history'
import { Adblock } from './adblock'
import { Extensions } from './extensions'
import { Rpc } from './rpc'
import { registerCommands } from './commands'
import { startSocket } from './socket'
import { GTK_PATH, parseGtk, FALLBACK, Palette } from './theme'
import { PasswordStore, type Cipher } from './passwords'
import { Autofill } from './autofill'
import { PermissionStore } from './permissions'
import { Agents } from './agent'
import { defaultSocketPath } from './socket'
import { watchBuild } from './update'
import { urlsFromArgv } from './argv'
import { ADBLOCK_CACHE } from './adblock'
import { isGoogleSignIn, signInHeaders, signInUA, chromeUA } from './signin'

const here = dirname(fileURLToPath(import.meta.url))

app.setName('Drift')
app.setPath('userData', join(app.getPath('appData'), 'Drift'))
if (process.env.DRIFT_PROFILE) app.setPath('userData', process.env.DRIFT_PROFILE)
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
// niri isn't a desktop Chromium recognizes, so name the keyring or secrets fall back to plain text.
app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecodeLinuxGL,VaapiVideoDecoder,WaylandWindowDecorations,BackForwardCache')
// FedCm: Electron has no account chooser behind it, so sign-in buttons hang instead of falling back to a popup.
app.commandLine.appendSwitch('disable-features', 'MediaRouter,FedCm')
// Sites gate features on looking like Chrome; drop the Electron and app tokens.
app.userAgentFallback = chromeUA(app.userAgentFallback.replace(/\s(Electron|Drift|drift)\/\S+/g, ''))

protocol.registerSchemesAsPrivileged([
  { scheme: 'drift', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(boot)
}

function loadSettings(path: string): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function readPalette(): Palette {
  try {
    return parseGtk(readFileSync(GTK_PATH, 'utf8'))
  } catch {
    return FALLBACK
  }
}

async function boot() {
  const userData = app.getPath('userData')
  const settingsPath = join(userData, 'settings.json')
  const settings = loadSettings(settingsPath)
  const saveSettings = () => writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  const session = sessions.fromPartition('persist:drift')
  session.setUserAgent(app.userAgentFallback)
  session.registerPreloadScript({ type: 'frame', filePath: join(here, '../preload/page.cjs') })
  // Private spaces: an in-memory partition, wiped when the last private space closes.
  const privateSession = sessions.fromPartition('drift-private')
  privateSession.setUserAgent(app.userAgentFallback)
  privateSession.registerPreloadScript({ type: 'frame', filePath: join(here, '../preload/page.cjs') })
  for (const s of [session, privateSession]) {
    // Global Privacy Control: a legal opt-out of sale/sharing in several US states.
    s.webRequest.onBeforeSendHeaders((d, cb) => {
      // Google's sign-in pages, and everything they load, see Firefox (see signin.ts).
      const page = d.frame?.url ?? d.webContents?.getURL() ?? ''
      let headers = d.requestHeaders
      if (isGoogleSignIn(d.url) || isGoogleSignIn(page)) {
        const ua = signInUA(settings.googleSignIn, app.userAgentFallback, process.versions.electron)
        // Firefox doesn't send client hints; the Electron mode is Chrome plus a token, so its hints stay.
        headers = settings.googleSignIn === 'firefox' ? signInHeaders(headers, ua) : { ...headers, 'User-Agent': ua }
      }
      cb({ requestHeaders: { ...headers, 'Sec-GPC': '1' } })
    })
  }
  // DNS over HTTPS, falling back to the system resolver on networks that block it.
  const applyDoh = (on: boolean) =>
    app.configureHostResolver(
      on
        ? { secureDnsMode: 'automatic', secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.quad9.net/dns-query'] }
        : { secureDnsMode: 'off' },
    )
  applyDoh(settings.doh)

  const history = new HistoryStore(join(userData, 'history.db'))
  let browser: Browser | null = null
  const adblock = new Adblock(session, join(userData, ADBLOCK_CACHE), () => browser?.push(), [privateSession])

  const uiDir = join(here, '../renderer')
  session.protocol.handle('drift', async (req) => {
    const u = new URL(req.url)
    if (u.host === 'snap' || u.host === 'thumb') {
      const buf = browser?.snapData(u.host, u.pathname.slice(1))
      return buf ? new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/jpeg' } }) : new Response(null, { status: 404 })
    }
    if (u.host === 'ui') {
      const file = join(uiDir, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname))
      if (!file.startsWith(uiDir) || !existsSync(file)) return new Response(null, { status: 404 })
      return net.fetch(pathToFileURL(file).href)
    }
    return new Response(null, { status: 404 })
  })

  const extensions = new Extensions(session, userData, process.versions.chrome)
  const permissions = new PermissionStore(join(userData, 'permissions.json'))
  const uiUrl = process.env.ELECTRON_RENDERER_URL ?? 'drift://ui/'
  browser = new Browser(session, {
    uiUrl,
    uiPreload: join(here, '../preload/ui.cjs'),
    statePath: join(userData, 'session.json'),
    settings,
    history,
    adblock,
    privateSession,
    permissions,
  })
  const b = browser
  b.palette = readPalette()
  b.on('settings', saveSettings)

  // Matugen rewrites the file on every wallpaper change; watch the folder so replacement is seen.
  let themeTimer: NodeJS.Timeout | null = null
  try {
    watch(dirname(GTK_PATH), () => {
      if (themeTimer) clearTimeout(themeTimer)
      themeTimer = setTimeout(() => {
        b.palette = readPalette()
        b.push()
      }, 150)
    })
  } catch {
    /* no gtk dir: keep fallback */
  }
  b.on('theme', () => b.push())

  const exts = process.env.DRIFT_X_NO_EXT ? null : new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session,
    createTab: async (details) => {
      const t = b.open(details.url ?? 'about:blank', { background: details.active === false, raw: true })
      const v = b.wake(t.id)!
      return [v.webContents, b.win]
    },
    selectTab: (wc) => {
      // Only extensions asking to switch tabs (chrome.tabs.update) should move focus.
      if (b.extQuiet) return
      const id = b.tabFor(wc)
      if (id && id !== b.model.activeWorkspace.activeTabId) b.activate(id)
    },
    removeTab: (wc) => {
      const id = b.tabFor(wc)
      if (id) b.close(id)
    },
    createWindow: async (details) => {
      const urls = Array.isArray(details.url) ? details.url : details.url ? [details.url] : []
      for (const u of urls) b.open(u, { raw: true })
      return b.win
    },
  })
  if (exts) ElectronChromeExtensions.handleCRXProtocol(session)
  b.extensions = exts
  await extensions.restore()

  // Passwords are encrypted with a key held in the GNOME keyring; without it nothing is stored.
  const cipher: Cipher = {
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (buf) => safeStorage.decryptString(buf),
    available: () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== 'basic_text',
  }
  const passwords = new PasswordStore(join(userData, 'passwords.json'), cipher)
  const autofill = new Autofill(passwords, b)
  // The renderer bundle is written last, so its change means the whole build is done.
  watchBuild(join(here, '../renderer/index.html'), () => {
    b.updateReady = true
    b.push()
  }, Number(process.env.DRIFT_UPDATE_POLL_MS) || 30_000)
  const agents = new Agents({
    userData,
    mcpScript: join(here, '../../bin/drift-mcp.mjs'),
    socket: defaultSocketPath(),
    onChange: () => {
      b.agentRuns = agents.runs
      b.push()
    },
  })

  const rpc = new Rpc()
  registerCommands(rpc, b, { history, adblock, extensions, session, privateSession, saveSettings, passwords, autofill, applyDoh, permissions, agents })

  const fromUi = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => b.isUiSender(e)
  ipcMain.handle('rpc', (e, name: string, params: Record<string, unknown>) => {
    if (!fromUi(e)) throw new Error('forbidden')
    return rpc.call(name, params)
  })
  // A page reports a swipe it didn't use; only the tab the user is looking at may switch spaces.
  let lastSwipe = 0
  ipcMain.on('page:swipe', (e, dir: unknown) => {
    if ((dir !== 'next' && dir !== 'prev') || Date.now() - lastSwipe < 700) return
    const tab = b.tabFor(e.sender)
    if (!tab || !b.panes().some((p) => p.id === tab)) return
    lastSwipe = Date.now()
    void rpc.call('ws.switch', { target: dir }).catch(() => {})
  })
  ipcMain.on('ui:overlay', (e, on: boolean) => fromUi(e) && b.requestOverlay(on))
  ipcMain.handle('ui:freeze', (e) => (fromUi(e) ? b.freeze() : []))
  ipcMain.on('ui:thaw', (e) => fromUi(e) && b.thaw())
  ipcMain.on('ui:transitionDone', (e, id: number) => fromUi(e) && b.endTransition(id))
  ipcMain.on('ui:focusPage', (e) => fromUi(e) && b.activePageFocus())
  ipcMain.on('ui:focusUi', (e) => fromUi(e) && b.ui.webContents.focus())
  ipcMain.handle('ui:state', (e) => (fromUi(e) ? b.snapshot() : null))

  const sock = await startSocket(rpc).catch((e) => {
    console.warn('[drift] CLI socket failed:', e.message)
    return null
  })

  const openArgs = (argv: string[]) => urlsFromArgv(argv).forEach((u) => b.open(u))
  openArgs(process.argv.slice(app.isPackaged ? 1 : 2))
  app.on('second-instance', (_e, argv) => {
    openArgs(argv.slice(1))
    b.win.focus()
  })

  adblock.init(settings.adblock).catch((e) => console.warn('[drift] adblock lists failed to load:', e.message))

  app.on('before-quit', (e) => {
    if (b.unsettled) {
      e.preventDefault()
      void b.settle().then(() => app.quit())
      return
    }
    agents.stopAll()
    b.shutdown()
    history.close()
    void sock?.close()
  })
  app.on('window-all-closed', () => app.quit())
}
