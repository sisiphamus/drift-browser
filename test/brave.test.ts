import { createCipheriv, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { braveProfileDir, listExtensions, readBookmarks, readCookies, readHistory, readLogins } from '../src/main/brave'
import { deriveKey } from '../src/main/cookies'

// Chrome time: microseconds since 1601-01-01.
const EPOCH_DELTA_US = 11_644_473_600_000_000n
const chromeTime = (unixMs: number) => BigInt(unixMs) * 1000n + EPOCH_DELTA_US

let home: string
let profile: string

function enc(prefix: string, password: string, host: string, value: string): Buffer {
  const c = createCipheriv('aes-128-cbc', deriveKey(password), Buffer.alloc(16, ' '))
  const plain = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
  return Buffer.concat([Buffer.from(prefix), c.update(plain), c.final()])
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'drift-brave-'))
  profile = join(home, '.config/BraveSoftware/Brave-Browser/Default')
  mkdirSync(profile, { recursive: true })

  writeFileSync(
    join(profile, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: 'Bookmarks bar',
          children: [
            { type: 'url', name: 'Top', url: 'https://top.com/' },
            { type: 'folder', name: 'Work', children: [{ type: 'url', name: 'Jira', url: 'https://jira.com/' }] },
          ],
        },
        other: { type: 'folder', name: 'Other bookmarks', children: [{ type: 'url', name: 'O', url: 'https://o.com/' }] },
        synced: { type: 'folder', name: 'Mobile bookmarks', children: [] },
      },
    }),
  )

  const hist = new DatabaseSync(join(profile, 'History'))
  hist.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
    visit_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL)`)
  const ins = hist.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)')
  ins.run('https://old.com/', 'Old', 3, chromeTime(1_600_000_000_000))
  ins.run('https://new.com/', 'New', 7, chromeTime(1_700_000_000_123))
  ins.run('https://mid.com/', 'Mid', 1, chromeTime(1_650_000_000_000))
  hist.close()

  const ck = new DatabaseSync(join(profile, 'Cookies'))
  ck.exec(`CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, samesite INTEGER NOT NULL DEFAULT -1)`)
  const c = ck.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  c.run('.x.com', 'sid', '', enc('v11', 'ring', '.x.com', 'abc'), '/', chromeTime(1_900_000_000_000), 1, 1, 2)
  c.run('y.com', 'pref', '', enc('v10', 'peanuts', 'y.com', 'dark'), '/app', 0, 0, 0, -1)
  c.run('z.com', 'plain', 'raw', Buffer.alloc(0), '/', 0, 0, 0, 0)
  c.run('bad.com', 'junk', '', enc('v11', 'other', 'bad.com', 'zzz'), '/', 0, 0, 0, 1)
  ck.close()

  // Login Data: same os_crypt scheme, no host hash prefix.
  const encPw = (prefix: string, password: string, value: string) => {
    const c = createCipheriv('aes-128-cbc', deriveKey(password), Buffer.alloc(16, ' '))
    return Buffer.concat([Buffer.from(prefix), c.update(value), c.final()])
  }
  const ld = new DatabaseSync(join(profile, 'Login Data'))
  ld.exec(`CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta VALUES ('version', '40');
    CREATE TABLE logins (origin_url VARCHAR NOT NULL, signon_realm VARCHAR NOT NULL, username_value VARCHAR,
      password_value BLOB, blacklisted_by_user INTEGER NOT NULL, scheme INTEGER NOT NULL)`)
  const l = ld.prepare('INSERT INTO logins VALUES (?, ?, ?, ?, ?, ?)')
  l.run('https://a.com/login?next=/', 'https://a.com/', 'ann', encPw('v11', 'ring', 's3cret'), 0, 0)
  l.run('http://b.com:8080/', 'http://b.com:8080/', 'bob', encPw('v10', 'peanuts', 'pw'), 0, 0)
  l.run('https://never.com/', 'https://never.com/', '', Buffer.alloc(0), 1, 0)
  l.run('https://basic.com/', 'https://basic.com/Realm', 'u', encPw('v10', 'peanuts', 'x'), 0, 1)
  l.run('https://empty.com/', 'https://empty.com/', 'e', encPw('v10', 'peanuts', ''), 0, 0)
  l.run('https://bad.com/', 'https://bad.com/', 'b', encPw('v11', 'other', 'zzz'), 0, 0)
  l.run('not a url', 'x', 'n', encPw('v10', 'peanuts', 'y'), 0, 0)
  ld.close()

  const ext = join(profile, 'Extensions')
  const ub = join(ext, 'cjpalhdlnbpafiamejdnhcphjbkeiagm', '1.60.0_0')
  mkdirSync(join(ub, '_locales/en'), { recursive: true })
  writeFileSync(join(ub, 'manifest.json'), JSON.stringify({ name: '__MSG_extName__', version: '1.60.0', default_locale: 'en' }))
  writeFileSync(join(ub, '_locales/en/messages.json'), JSON.stringify({ extname: { message: 'uBlock Origin' } }))
  const pl = join(ext, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2.0_0')
  mkdirSync(pl, { recursive: true })
  writeFileSync(join(pl, 'manifest.json'), JSON.stringify({ name: 'Plain', version: '2.0' }))
  mkdirSync(join(ext, 'Temp', 'scratch'), { recursive: true })
})

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('brave import', () => {
  it('finds the profile dir', () => {
    expect(braveProfileDir(home)).toBe(profile)
    expect(braveProfileDir(join(home, 'nope'))).toBeNull()
  })

  it('reads bookmarks with folder paths', () => {
    expect(readBookmarks(profile)).toEqual([
      { title: 'Top', url: 'https://top.com/', folder: 'Bookmarks bar' },
      { title: 'Jira', url: 'https://jira.com/', folder: 'Bookmarks bar/Work' },
      { title: 'O', url: 'https://o.com/', folder: 'Other bookmarks' },
    ])
  })

  it('reads history newest first in unix ms', () => {
    expect(readHistory(profile)).toEqual([
      { url: 'https://new.com/', title: 'New', visitCount: 7, lastVisit: 1_700_000_000_123 },
      { url: 'https://mid.com/', title: 'Mid', visitCount: 1, lastVisit: 1_650_000_000_000 },
      { url: 'https://old.com/', title: 'Old', visitCount: 3, lastVisit: 1_600_000_000_000 },
    ])
    expect(readHistory(profile, 1).length).toBe(1)
  })

  it('reads cookies shaped for session.cookies.set', () => {
    const cookies = readCookies(profile, 'ring')
    expect(cookies).toEqual([
      {
        url: 'https://x.com/', name: 'sid', value: 'abc', domain: '.x.com', path: '/',
        secure: true, httpOnly: true, expirationDate: 1_900_000_000, sameSite: 'strict',
      },
      { url: 'http://y.com/app', name: 'pref', value: 'dark', path: '/app', secure: false, httpOnly: false, sameSite: 'unspecified' },
      { url: 'http://z.com/', name: 'plain', value: 'raw', path: '/', secure: false, httpOnly: false, sameSite: 'no_restriction' },
    ])
  })

  it('skips v11 cookies without a keyring password', () => {
    expect(readCookies(profile, null).map((c) => c.name)).toEqual(['pref', 'plain'])
  })

  it('reads saved logins, skipping blocked, non-HTML, empty and undecryptable rows', () => {
    expect(readLogins(profile, 'ring')).toEqual([
      { origin: 'https://a.com', signonRealm: 'https://a.com/', username: 'ann', password: 's3cret' },
      { origin: 'http://b.com:8080', signonRealm: 'http://b.com:8080/', username: 'bob', password: 'pw' },
    ])
    expect(readLogins(profile, null).map((r) => r.username)).toEqual(['bob'])
    expect(readLogins(join(home, 'nope'), null)).toEqual([])
  })

  it('lists extensions with localized names', () => {
    const exts = listExtensions(profile).sort((a, b) => a.name.localeCompare(b.name))
    expect(exts.map(({ id, name, version }) => ({ id, name, version }))).toEqual([
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Plain', version: '2.0' },
      { id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm', name: 'uBlock Origin', version: '1.60.0' },
    ])
    expect(exts[1].path).toBe(join(profile, 'Extensions/cjpalhdlnbpafiamejdnhcphjbkeiagm/1.60.0_0'))
  })
})
