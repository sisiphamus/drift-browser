// Network + cosmetic blocking with Ghostery's engine (EasyList, EasyPrivacy, uBO lists), cached on disk.
import { ipcMain, type Session } from 'electron'
import { ElectronBlocker, adsAndTrackingLists, fullLists } from '@ghostery/adblocker-electron'

// Ads, trackers and cookie banners, like Brave's defaults. uBlock's "annoyances" list is left out: it hides
// things people want (chat widgets, share buttons) and uBlock itself ships it off.
/** Bumped whenever the list set changes, so profiles rebuild their engine. */
export const ADBLOCK_CACHE = 'adblock-v3.bin'
const DEFAULT_LISTS = [...adsAndTrackingLists, ...fullLists.filter((u) => /cookie/.test(u))]
import fetch from 'cross-fetch'
import { promises as fs } from 'node:fs'

const SECURITY_LISTS = [
  'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
  'https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt',
]

const SIGNIN_EXCEPTIONS = [
  '@@||accounts.google.com^',
  '@@||accounts.youtube.com^',
  '@@*$domain=accounts.google.com|accounts.youtube.com',
  '@@/browserinfo$domain=accounts.google.com',
]

export class Adblock {
  private blocker: ElectronBlocker | null = null
  enabled = true
  total = 0
  perTab = new Map<number, number>()
  private markReady!: () => void
  /** Resolves once filtering is active (or failed to start), so pages don't load unprotected. */
  ready = new Promise<void>((r) => (this.markReady = r))

  constructor(private session: Session, private cachePath: string, private onChange: () => void, private extra: Session[] = []) {}

  async init(enabled: boolean) {
    try {
      await this.load(enabled)
    } finally {
      this.markReady()
    }
  }

  private async load(enabled: boolean) {
    this.enabled = enabled
    // Ads + trackers, plus malware and phishing domains (stands in for Safe Browsing).
    this.blocker = await ElectronBlocker.fromLists(fetch, [...DEFAULT_LISTS, ...SECURITY_LISTS], { enableCompression: true, loadCosmeticFilters: true }, {
      path: this.cachePath,
      read: fs.readFile,
      write: fs.writeFile,
    })
    // Google's sign-in runs a browser check (/browserinfo and friends) that privacy lists block,
    // which makes Google reject the browser. Never filter on its account pages.
    this.blocker.updateFromDiff({ added: SIGNIN_EXCEPTIONS })
    this.blocker.on('request-blocked', (req) => {
      this.total++
      this.perTab.set(req.tabId, (this.perTab.get(req.tabId) ?? 0) + 1)
      this.onChange()
    })
    if (enabled) for (const s of this.sessions) this.enableIn(s)
  }

  private get sessions(): Session[] {
    return [this.session, ...this.extra]
  }

  set(enabled: boolean) {
    if (!this.blocker || enabled === this.enabled) {
      this.enabled = enabled
      return
    }
    this.enabled = enabled
    for (const s of this.sessions) {
      if (enabled) this.enableIn(s)
      else this.blocker.disableBlockingInSession(s)
    }
  }

  /**
   * Ghostery registers app-wide IPC handlers each time it enables a session, so a second session (private
   * spaces) throws and used to abort blocking entirely. The handlers don't depend on the session, so the
   * first registration serves every session; later ones are skipped.
   */
  private enableIn(s: Session) {
    const handle = ipcMain.handle
    ipcMain.handle = ((channel: string, listener: Parameters<typeof ipcMain.handle>[1]) => {
      try {
        handle.call(ipcMain, channel, listener)
      } catch {
        /* already registered by another session */
      }
    }) as typeof ipcMain.handle
    try {
      this.blocker!.enableBlockingInSession(s)
    } finally {
      ipcMain.handle = handle
    }
  }

  /** A navigation resets the page's counter. */
  resetTab(webContentsId: number) {
    this.perTab.delete(webContentsId)
  }
}
