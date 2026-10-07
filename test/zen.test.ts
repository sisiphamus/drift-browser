import { describe, it, expect, afterEach } from 'vitest'
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readZenLogins, readZenCookies, zenProfileDir } from '../src/main/zen'

// --- a minimal DER encoder, enough to build what Firefox writes ---
const len = (n: number) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]))
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body])
const seq = (...kids: Buffer[]) => tlv(0x30, Buffer.concat(kids))
const oct = (b: Buffer) => tlv(0x04, b)
const int = (n: number) => {
  const bytes: number[] = []
  do {
    bytes.unshift(n & 255)
    n = Math.floor(n / 256)
  } while (n > 0)
  if (bytes[0] & 0x80) bytes.unshift(0)
  return tlv(0x02, Buffer.from(bytes))
}
const oid = (s: string) => {
  const [a, b, ...rest] = s.split('.').map(Number)
  const out = [a * 40 + b]
  for (const n of rest) {
    const parts = [n & 127]
    let v = Math.floor(n / 128)
    while (v > 0) {
      parts.unshift((v & 127) | 128)
      v = Math.floor(v / 128)
    }
    out.push(...parts)
  }
  return tlv(0x06, Buffer.from(out))
}
const pad = (b: Buffer, block: number) => {
  const n = block - (b.length % block)
  return Buffer.concat([b, Buffer.alloc(n, n)])
}
const aes = (key: Buffer, iv: Buffer, plain: Buffer) => {
  const c = createCipheriv('aes-256-cbc', key, iv)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(pad(plain, 16)), c.final()])
}

// PBES2 (PBKDF2-HMAC-SHA256 + AES-256-CBC), as key4.db stores the check value and the master key.
function pbes2(plain: Buffer, globalSalt: Buffer, primary: string) {
  const entrySalt = randomBytes(32)
  const iv14 = randomBytes(14)
  const k = createHash('sha1').update(Buffer.concat([globalSalt, Buffer.from(primary)])).digest()
  const key = pbkdf2Sync(k, entrySalt, 1000, 32, 'sha256')
  const ct = aes(key, Buffer.concat([Buffer.from([4, 14]), iv14]), plain)
  return seq(
    seq(
      oid('1.2.840.113549.1.5.13'),
      seq(
        seq(oid('1.2.840.113549.1.5.12'), seq(oct(entrySalt), int(1000), int(32), seq(oid('1.2.840.113549.2.9')))),
        seq(oid('2.16.840.1.101.3.4.1.42'), oct(iv14)),
      ),
    ),
    oct(ct),
  )
}
const CKA_ID = Buffer.from('f8000000000000000000000000000001', 'hex')
const loginField = (master: Buffer, text: string) => {
  const iv = randomBytes(16)
  return seq(oct(CKA_ID), seq(oid('2.16.840.1.101.3.4.1.42'), oct(iv)), oct(aes(master, iv, Buffer.from(text)))).toString('base64')
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function profile(primary = '') {
  const dir = mkdtempSync(join(tmpdir(), 'drift-zen-'))
  dirs.push(dir)
  const globalSalt = randomBytes(20)
  const master = randomBytes(32)
  const db = new DatabaseSync(join(dir, 'key4.db'))
  db.exec('CREATE TABLE metaData (id TEXT PRIMARY KEY, item1, item2); CREATE TABLE nssPrivate (id INTEGER PRIMARY KEY, a11, a102)')
  db.prepare('INSERT INTO metaData VALUES (?, ?, ?)').run('password', globalSalt, pbes2(Buffer.from('password-check'), globalSalt, primary))
  db.prepare('INSERT INTO nssPrivate (a11, a102) VALUES (?, ?)').run(pbes2(master, globalSalt, primary), CKA_ID)
  db.close()
  const login = (hostname: string, u: string, p: string, extra = {}) => ({
    hostname, formSubmitURL: hostname, httpRealm: null, encryptedUsername: loginField(master, u), encryptedPassword: loginField(master, p), ...extra,
  })
  writeFileSync(
    join(dir, 'logins.json'),
    JSON.stringify({
      logins: [
        login('https://github.com', 'adam', 'hunter2'),
        login('https://accounts.example.org', '', 'pin-only'),
        login('https://router.local', 'admin', 'x', { formSubmitURL: null, httpRealm: 'Router' }),
      ],
    }),
  )
  return dir
}

describe('readZenLogins', () => {
  it('decrypts form logins from key4.db + logins.json', () => {
    const rows = readZenLogins(profile())
    expect(rows).toEqual([
      { origin: 'https://github.com', signonRealm: 'https://github.com/', username: 'adam', password: 'hunter2' },
      { origin: 'https://accounts.example.org', signonRealm: 'https://accounts.example.org/', username: '', password: 'pin-only' },
    ])
  })

  it('needs the primary password when one is set', () => {
    const dir = profile('s3cret')
    expect(() => readZenLogins(dir)).toThrow(/primary password/)
    expect(readZenLogins(dir, 's3cret')).toHaveLength(2)
  })

  it('returns nothing for a profile without saved logins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-zen-'))
    dirs.push(dir)
    expect(readZenLogins(dir)).toEqual([])
  })
})

describe('readZenCookies', () => {
  it('maps moz_cookies to Electron cookies, skipping containers and partitioned cookies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-zen-'))
    dirs.push(dir)
    const db = new DatabaseSync(join(dir, 'cookies.sqlite'))
    db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT,
      path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)`)
    const add = db.prepare('INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    add.run('', 'sid', 'abc', '.github.com', '/', 1900000000, 1, 1, 1)
    add.run('', 'pref', 'dark', 'news.ycombinator.com', '/', 1900000000000, 0, 0, 0) // newer Firefox: milliseconds
    add.run('', 'NID', 'g', '.google.com', '/', 1900000000, 1, 0, 0)
    add.run('^userContextId=2', 'work', 'w', '.github.com', '/', 1900000000, 1, 0, 0)
    add.run('^partitionKey=%28https%2Cexample.com%29', 'p', 'p', '.cdn.net', '/', 1900000000, 1, 0, 0)
    db.close()
    expect(readZenCookies(dir)).toEqual([
      { url: 'https://github.com/', name: 'sid', value: 'abc', domain: '.github.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 1900000000 },
      { url: 'http://news.ycombinator.com/', name: 'pref', value: 'dark', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', expirationDate: 1900000000 },
      { url: 'https://google.com/', name: 'NID', value: 'g', domain: '.google.com', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction', expirationDate: 1900000000 },
    ])
  })
})

describe('zenProfileDir', () => {
  it('follows the install default in profiles.ini (Flatpak or native)', () => {
    const home = mkdtempSync(join(tmpdir(), 'drift-home-'))
    dirs.push(home)
    const root = join(home, '.var/app/app.zen_browser.zen/.zen')
    mkdirSync(join(root, 'aaa.Default Profile'), { recursive: true })
    mkdirSync(join(root, 'bbb.Default (release)'), { recursive: true })
    writeFileSync(
      join(root, 'profiles.ini'),
      '[Profile1]\nName=Default Profile\nIsRelative=1\nPath=aaa.Default Profile\n\n[Profile0]\nName=Default (release)\nIsRelative=1\nPath=bbb.Default (release)\nDefault=1\n\n[Install123]\nDefault=bbb.Default (release)\nLocked=1\n',
    )
    expect(zenProfileDir(home)).toBe(join(root, 'bbb.Default (release)'))
  })

  it('is null without Zen', () => {
    const home = mkdtempSync(join(tmpdir(), 'drift-home-'))
    dirs.push(home)
    expect(zenProfileDir(home)).toBeNull()
  })
})
