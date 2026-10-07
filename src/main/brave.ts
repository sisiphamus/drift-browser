// Read a Brave profile: bookmarks, history, cookies, extensions. Pure Node, no Electron.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decryptCookie, deriveKey } from './cookies'

export type BraveBookmark = { title: string; url: string; folder: string }
export type BraveHistory = { url: string; title: string; visitCount: number; lastVisit: number }
export type SameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'
// domain only for leading-dot (domain) cookies; omitted keeps host-only cookies host-only.
export type BraveCookie = {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: SameSite
}
export type BraveLogin = { origin: string; signonRealm: string; username: string; password: string }
export type BraveExtension ={ id: string; name: string; version: string; path: string }

// Chrome time is microseconds since 1601-01-01. Done in SQL: values exceed 2^53.
const UNIX_MS = (col: string) => `(${col} / 1000 - 11644473600000)`
const UNIX_S = (col: string) => `(${col} / 1000000 - 11644473600)`
const SAMESITE: Record<number, SameSite> = { [-1]: 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' }

export function braveProfileDir(home = homedir()): string | null {
  const roots = ['.config', '.var/app/com.brave.Browser/config'] // native, flatpak
  for (const r of roots) {
    const dir = join(home, r, 'BraveSoftware/Brave-Browser/Default')
    if (existsSync(dir)) return dir
  }
  return null
}

type Node = { type: string; name?: string; url?: string; children?: Node[] }

export function readBookmarks(profileDir: string): BraveBookmark[] {
  const file = join(profileDir, 'Bookmarks')
  if (!existsSync(file)) return []
  const roots = JSON.parse(readFileSync(file, 'utf8')).roots ?? {}
  const out: BraveBookmark[] = []
  const walk = (n: Node, path: string) => {
    if (n.type === 'url' && n.url) out.push({ title: n.name ?? '', url: n.url, folder: path })
    for (const c of n.children ?? []) walk(c, c.type === 'folder' ? `${path}/${c.name ?? ''}` : path)
  }
  for (const key of ['bookmark_bar', 'other', 'synced']) if (roots[key]) walk(roots[key], roots[key].name ?? key)
  return out
}

// Brave holds a lock on its databases; read a private copy (plus journal/WAL).
export function withCopy<T>(src: string, fn: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'drift-brave-'))
  const dst = join(dir, 'db')
  try {
    copyFileSync(src, dst)
    for (const ext of ['-wal', '-journal']) if (existsSync(src + ext)) copyFileSync(src + ext, dst + ext)
    const db = new DatabaseSync(dst)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function readHistory(profileDir: string, limit = 5000): BraveHistory[] {
  const file = join(profileDir, 'History')
  if (!existsSync(file)) return []
  return withCopy(file, (db) =>
    db
      .prepare(
        `SELECT url, title, visit_count AS visitCount, ${UNIX_MS('last_visit_time')} AS lastVisit
         FROM urls ORDER BY last_visit_time DESC LIMIT ?`,
      )
      .all(limit),
  ) as BraveHistory[]
}

type CookieRow = {
  host_key: string
  name: string
  value: string
  encrypted_value: Uint8Array
  path: string
  expires: number
  is_secure: number
  is_httponly: number
  samesite: number
}

export function readCookies(profileDir: string, keyringPassword: string | null): BraveCookie[] {
  const file = [join(profileDir, 'Network/Cookies'), join(profileDir, 'Cookies')].find(existsSync)
  if (!file) return []
  const keys = { v10: deriveKey('peanuts'), v11: keyringPassword === null ? null : deriveKey(keyringPassword) }
  return withCopy(file, (db) => {
    const meta = db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get() as { value: string } | undefined
    const version = Number(meta?.value ?? 0)
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, is_secure, is_httponly, samesite,
           CASE WHEN expires_utc = 0 THEN 0 ELSE ${UNIX_S('expires_utc')} END AS expires
         FROM cookies`,
      )
      .all() as CookieRow[]
    const out: BraveCookie[] = []
    for (const r of rows) {
      const enc = Buffer.from(r.encrypted_value ?? [])
      const value = enc.length ? decryptCookie(enc, keys, r.host_key, version) : r.value
      if (value === null) continue
      const secure = r.is_secure === 1
      const dot = r.host_key.startsWith('.')
      const c: BraveCookie = {
        url: `http${secure ? 's' : ''}://${dot ? r.host_key.slice(1) : r.host_key}${r.path}`,
        name: r.name,
        value,
        ...(dot ? { domain: r.host_key } : {}),
        path: r.path,
        secure,
        httpOnly: r.is_httponly === 1,
        sameSite: SAMESITE[r.samesite] ?? 'unspecified',
      }
      if (r.expires) c.expirationDate = r.expires
      out.push(c)
    }
    return out
  })
}

type LoginRow = { origin_url: string; signon_realm: string; username_value: string; password_value: Uint8Array | null }

// Same os_crypt as cookies, minus the host hash (dbVersion 0). Never logs values.
export function readLogins(profileDir: string, keyringPassword: string | null): BraveLogin[] {
  const file = join(profileDir, 'Login Data')
  if (!existsSync(file)) return []
  const keys = { v10: deriveKey('peanuts'), v11: keyringPassword === null ? null : deriveKey(keyringPassword) }
  return withCopy(file, (db) => {
    const rows = db
      .prepare(
        `SELECT origin_url, signon_realm, username_value, password_value FROM logins
         WHERE blacklisted_by_user = 0 AND scheme = 0`, // 0 = HTML form
      )
      .all() as LoginRow[]
    const out: BraveLogin[] = []
    for (const r of rows) {
      const enc = Buffer.from(r.password_value ?? [])
      const password = enc.length ? decryptCookie(enc, keys, '', 0) : null
      if (!password) continue
      let origin: string
      try {
        origin = new URL(r.origin_url).origin
      } catch {
        continue
      }
      if (origin === 'null') continue
      out.push({ origin, signonRealm: r.signon_realm, username: r.username_value ?? '', password })
    }
    return out
  })
}

const KEYRING_PY = `
import sys, gi
gi.require_version('Secret', '1')
from gi.repository import Secret
for name in ('chrome_libsecret_os_crypt_password_v2', 'chrome_libsecret_os_crypt_password_v1'):
    s = Secret.Schema.new(name, Secret.SchemaFlags.NONE, {'application': Secret.SchemaAttributeType.STRING})
    pw = Secret.password_lookup_sync(s, {'application': 'brave'}, None)
    if pw:
        sys.stdout.write(pw); sys.exit(0)
svc = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS, None)
for col in svc.get_collections() or []:
    for item in col.get_items() or []:
        if item.get_label() == 'Brave Safe Storage':
            item.load_secret_sync(None)
            sys.stdout.write(item.get_secret().get_text()); sys.exit(0)
sys.exit(1)
`

export function getKeyringPassword(): string | null {
  try {
    const out = execFileSync('python3', ['-c', KEYRING_PY], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out || null
  } catch {
    return null
  }
}

const EXT_ID = /^[a-p]{32}$/

function localize(name: string, dir: string, locale: string | undefined): string {
  const m = /^__MSG_(\w+)__$/.exec(name)
  if (!m || !locale) return name
  try {
    const msgs = JSON.parse(readFileSync(join(dir, '_locales', locale, 'messages.json'), 'utf8'))
    const key = Object.keys(msgs).find((k) => k.toLowerCase() === m[1].toLowerCase())
    return key ? msgs[key].message : name
  } catch {
    return name
  }
}

export function listExtensions(profileDir: string): BraveExtension[] {
  const root = join(profileDir, 'Extensions')
  if (!existsSync(root)) return []
  const out: BraveExtension[] = []
  for (const id of readdirSync(root)) {
    if (!EXT_ID.test(id)) continue // skips Temp and other scratch dirs
    const versions = readdirSync(join(root, id)).filter((v) => statSync(join(root, id, v)).isDirectory())
    const latest = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    if (!latest) continue
    const dir = join(root, id, latest)
    try {
      const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
      out.push({ id, name: localize(mf.name ?? id, dir, mf.default_locale), version: mf.version ?? '', path: dir })
    } catch {
      continue
    }
  }
  return out
}
