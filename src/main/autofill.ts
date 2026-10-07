// Password autofill bridge between page frames and the encrypted store.
// Origins always come from Chromium's view of the sending frame, never from the page.
import { ipcMain, clipboard, type IpcMainInvokeEvent, type IpcMainEvent, type WebFrameMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { PasswordStore, generatePassword } from './passwords'
import type { Browser } from './browser'

export type SavePrompt = { id: string; origin: string; username: string; update: boolean }

export class Autofill {
  private pending = new Map<string, { origin: string; username: string; password: string; tabId: string }>()
  private clearTimer: NodeJS.Timeout | null = null

  constructor(private store: PasswordStore, private b: Browser) {
    ipcMain.handle('pw:query', (e) => {
      const origin = this.trustedOrigin(e)
      if (!origin || !this.b.settings.autofill) return { logins: [] }
      return { logins: this.store.forOrigin(origin) }
    })
    ipcMain.handle('pw:fill', (e, id: string) => {
      const origin = this.trustedOrigin(e)
      if (!origin || !this.store.forOrigin(origin).some((l) => l.id === id)) return null
      return this.store.reveal(id)
    })
    ipcMain.handle('pw:generate', (e) => (this.trustedOrigin(e) ? generatePassword() : null))
    ipcMain.on('pw:submitted', (e, form: { username?: unknown; password?: unknown }) => this.onSubmit(e, form))
  }

  /** The sending frame's origin, if it is a tab's top frame or same-origin with it. */
  private trustedOrigin(e: IpcMainInvokeEvent | IpcMainEvent): string | null {
    const frame: WebFrameMain | null = e.senderFrame
    const tabId = this.b.tabFor(e.sender)
    if (!frame || !tabId) return null
    const origin = frame.origin
    if (!/^https?:\/\//.test(origin)) return null
    if (frame !== e.sender.mainFrame && e.sender.mainFrame.origin !== origin) return null
    return origin
  }

  private onSubmit(e: IpcMainEvent, form: { username?: unknown; password?: unknown }) {
    const origin = this.trustedOrigin(e)
    const tabId = this.b.tabFor(e.sender)
    const password = typeof form.password === 'string' ? form.password : ''
    const username = typeof form.username === 'string' ? form.username.slice(0, 256) : ''
    if (!origin || !tabId || !password || password.length > 512 || this.b.model.isPrivate(tabId) || !this.b.settings.autofill) return
    const existing = this.store.forOrigin(origin).find((l) => l.username === username)
    if (existing && this.store.matches(existing.id, password)) return
    const id = randomUUID().slice(0, 8)
    this.pending.clear()
    this.pending.set(id, { origin, username, password, tabId })
    this.b.savePrompt = { id, origin, username, update: !!existing }
    this.b.push()
  }

  answer(id: string, save: boolean): string | null {
    const p = this.pending.get(id)
    this.pending.delete(id)
    this.b.savePrompt = null
    this.b.push()
    if (!p || !save) return null
    return this.store.save(p.origin, p.username, p.password)
  }

  /** Copies a password and wipes the clipboard 30s later if it still holds it. */
  copy(id: string) {
    const secret = this.store.reveal(id)
    clipboard.writeText(secret)
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(async () => {
      // Electron 44 made clipboard reads async.
      if ((await clipboard.readText()) === secret) clipboard.clear()
    }, 30_000)
  }
}
