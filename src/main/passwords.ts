// Saved logins. Only the password is encrypted, via an injected cipher (safeStorage in main). No Electron.

import { randomInt, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Cipher = { encrypt(plain: string): Buffer; decrypt(buf: Buffer): string; available(): boolean }
export type Login = { origin: string; signonRealm: string; username: string; password: string }
export type LoginSummary = { id: string; origin: string; username: string; lastUsed: number; timesUsed: number }
type Entry = {
  id: string
  origin: string
  signonRealm: string
  username: string
  password: string // base64 ciphertext
  created: number
  lastUsed: number
  timesUsed: number
}

// Strict: scheme + host + port must match; only www. is folded.
function norm(origin: string): string | null {
  try {
    const u = new URL(origin)
    if (u.origin === 'null') return null
    u.hostname = u.hostname.replace(/^www\./, '')
    return u.origin
  } catch {
    return null
  }
}

export class PasswordStore {
  private entries: Entry[] = []

  constructor(
    private path: string,
    private cipher: Cipher,
  ) {
    if (existsSync(path)) this.entries = JSON.parse(readFileSync(path, 'utf8')).entries ?? []
  }

  list(): LoginSummary[] {
    return this.entries.map(({ id, origin, username, lastUsed, timesUsed }) => ({ id, origin, username, lastUsed, timesUsed }))
  }

  forOrigin(origin: string): { id: string; username: string }[] {
    const want = norm(origin)
    if (!want) return []
    return this.entries
      .filter((e) => norm(e.origin) === want || norm(e.signonRealm) === want)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map(({ id, username }) => ({ id, username }))
  }

  reveal(id: string): string {
    const e = this.entries.find((x) => x.id === id)
    if (!e) throw new Error(`no login ${id}`)
    const plain = this.cipher.decrypt(Buffer.from(e.password, 'base64'))
    e.lastUsed = Date.now()
    e.timesUsed++
    this.write()
    return plain
  }

  // Compare without counting as a use.
  matches(id: string, password: string): boolean {
    const e = this.entries.find((x) => x.id === id)
    return !!e && this.cipher.decrypt(Buffer.from(e.password, 'base64')) === password
  }

  has(origin: string, username: string): boolean {
    return !!this.find(origin, username)
  }

  save(origin: string, username: string, password: string, signonRealm = `${origin}/`): 'added' | 'updated' | 'unchanged' {
    this.guard()
    const e = this.find(origin, username)
    if (e) {
      if (this.cipher.decrypt(Buffer.from(e.password, 'base64')) === password) return 'unchanged'
      e.password = this.seal(password)
      this.write()
      return 'updated'
    }
    this.entries.push(this.entry({ origin, signonRealm, username, password }))
    this.write()
    return 'added'
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.write()
  }

  importMany(rows: Login[]): number {
    this.guard()
    let n = 0
    for (const r of rows) {
      if (this.find(r.origin, r.username)) continue
      this.entries.push(this.entry(r))
      n++
    }
    if (n) this.write()
    return n
  }

  private find(origin: string, username: string): Entry | undefined {
    const o = norm(origin) ?? origin
    return this.entries.find((e) => e.username === username && (norm(e.origin) ?? e.origin) === o)
  }

  private entry(r: Login): Entry {
    const now = Date.now()
    const { origin, signonRealm, username } = r
    return { id: randomUUID(), origin, signonRealm, username, password: this.seal(r.password), created: now, lastUsed: now, timesUsed: 0 }
  }

  private guard() {
    if (!this.cipher.available()) throw new Error('encryption unavailable; refusing to store passwords')
  }

  private seal(plain: string): string {
    this.guard()
    return this.cipher.encrypt(plain).toString('base64')
  }

  // tmp + rename so a crash never leaves a torn file.
  private write() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }), { mode: 0o600 })
    chmodSync(tmp, 0o600) // umask-proof
    renameSync(tmp, this.path)
  }
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGIT = '23456789'
const SYMBOL = '-_.!@#%'
const ALL = UPPER + LOWER + DIGIT + SYMBOL

export function generatePassword(length = 20): string {
  const pick = (s: string) => s[randomInt(s.length)]
  const chars = [UPPER, LOWER, DIGIT, SYMBOL].map(pick)
  while (chars.length < length) chars.push(pick(ALL))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.slice(0, Math.max(length, 4)).join('')
}
