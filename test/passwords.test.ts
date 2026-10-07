import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Cipher, generatePassword, PasswordStore } from '../src/main/passwords'

// Reversible stand-in for safeStorage: reverse the bytes, tag them.
function fakeCipher(on = true): Cipher & { on: boolean } {
  return {
    on,
    available() {
      return this.on
    },
    encrypt: (s) => Buffer.concat([Buffer.from('X:'), Buffer.from(s).reverse()]),
    decrypt: (b) => Buffer.from(b.subarray(2)).reverse().toString(),
  }
}

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drift-pw-'))
  file = join(dir, 'sub', 'passwords.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PasswordStore', () => {
  it('never writes plaintext and refuses without a cipher', () => {
    const c = fakeCipher(false)
    const s = new PasswordStore(file, c)
    expect(() => s.save('https://a.com', 'me', 'hunter2')).toThrow()
    expect(() => s.importMany([{ origin: 'https://a.com', signonRealm: 'https://a.com/', username: 'me', password: 'p' }])).toThrow()
    expect(existsSync(file)).toBe(false)

    c.on = true
    s.save('https://a.com', 'me', 'hunter2')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('hunter2')
    const [e] = JSON.parse(raw).entries
    expect(e).toMatchObject({ origin: 'https://a.com', signonRealm: 'https://a.com/', username: 'me', timesUsed: 0 })
    expect(Buffer.from(e.password, 'base64').toString()).toBe('X:2retnuh')
  })

  it('writes the file 0600 and leaves no tmp files', () => {
    new PasswordStore(file, fakeCipher()).save('https://a.com', 'me', 'pw')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBeTruthy()
    expect(readdirSync(join(dir, 'sub'))).toEqual(['passwords.json'])
  })

  it('upserts by origin + username', () => {
    const s = new PasswordStore(file, fakeCipher())
    expect(s.save('https://a.com', 'me', 'one')).toBe('added')
    expect(s.save('https://a.com', 'me', 'one')).toBe('unchanged')
    expect(s.save('https://a.com', 'me', 'two')).toBe('updated')
    expect(s.save('https://a.com', 'you', 'two')).toBe('added')
    expect(s.list().length).toBe(2)
    const id = s.forOrigin('https://a.com').find((e) => e.username === 'me')!.id
    expect(s.reveal(id)).toBe('two')
  })

  it('persists across instances and list() carries no secrets', () => {
    new PasswordStore(file, fakeCipher()).save('https://a.com', 'me', 'pw')
    const s = new PasswordStore(file, fakeCipher())
    const [e] = s.list()
    expect(Object.keys(e).sort()).toEqual(['id', 'lastUsed', 'origin', 'timesUsed', 'username'])
    expect(s.has('https://a.com', 'me')).toBe(true)
    expect(s.has('https://a.com', 'nope')).toBe(false)
  })

  it('reveal bumps usage; forOrigin sorts by lastUsed desc', async () => {
    const s = new PasswordStore(file, fakeCipher())
    s.save('https://a.com', 'first', '1')
    s.save('https://a.com', 'second', '2')
    const first = s.forOrigin('https://a.com').find((e) => e.username === 'first')!.id
    await new Promise((r) => setTimeout(r, 5))
    expect(s.reveal(first)).toBe('1')
    expect(s.forOrigin('https://a.com').map((e) => e.username)).toEqual(['first', 'second'])
    expect(s.list().find((e) => e.id === first)!.timesUsed).toBe(1)
    expect(new PasswordStore(file, fakeCipher()).list().find((e) => e.id === first)!.timesUsed).toBe(1)
    expect(() => s.reveal('missing')).toThrow()
  })

  it('matches origins strictly, www equal to bare', () => {
    const s = new PasswordStore(file, fakeCipher())
    s.save('https://accounts.google.com', 'g', 'p')
    s.save('https://www.x.com', 'x', 'p')
    s.save('http://x.com', 'insecure', 'p')
    s.importMany([{ origin: 'https://android.app', signonRealm: 'https://login.y.com/', username: 'y', password: 'p' }])
    expect(s.forOrigin('https://mail.google.com')).toEqual([])
    expect(s.forOrigin('https://accounts.google.com').map((e) => e.username)).toEqual(['g'])
    expect(s.forOrigin('https://x.com').map((e) => e.username)).toEqual(['x'])
    expect(s.forOrigin('https://www.x.com').map((e) => e.username)).toEqual(['x'])
    expect(s.forOrigin('https://login.y.com').map((e) => e.username)).toEqual(['y'])
    expect(s.save('https://x.com', 'x', 'p')).toBe('unchanged')
  })

  it('matches() compares without bumping usage', () => {
    const s = new PasswordStore(file, fakeCipher())
    s.save('https://a.com', 'me', 'pw')
    const { id, lastUsed } = s.list()[0]
    expect(s.matches(id, 'pw')).toBe(true)
    expect(s.matches(id, 'other')).toBe(false)
    expect(s.matches('missing', 'pw')).toBe(false)
    expect(s.list()[0]).toMatchObject({ lastUsed, timesUsed: 0 })
  })

  it('removes entries', () => {
    const s = new PasswordStore(file, fakeCipher())
    s.save('https://a.com', 'me', 'pw')
    s.remove(s.list()[0].id)
    expect(s.list()).toEqual([])
    expect(new PasswordStore(file, fakeCipher()).list()).toEqual([])
  })

  it('importMany skips existing pairs and counts added', () => {
    const s = new PasswordStore(file, fakeCipher())
    s.save('https://a.com', 'me', 'keep')
    const n = s.importMany([
      { origin: 'https://a.com', signonRealm: 'https://a.com/', username: 'me', password: 'new' },
      { origin: 'https://b.com', signonRealm: 'https://b.com/', username: 'me', password: 'b' },
      { origin: 'https://b.com', signonRealm: 'https://b.com/', username: 'me', password: 'dup' },
    ])
    expect(n).toBe(1)
    expect(s.reveal(s.forOrigin('https://a.com')[0].id)).toBe('keep')
    expect(s.reveal(s.forOrigin('https://b.com')[0].id)).toBe('b')
  })
})

describe('generatePassword', () => {
  it('has every class, no ambiguous chars, right length', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword()
      expect(p.length).toBe(20)
      expect(p).toMatch(/[A-Z]/)
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[0-9]/)
      expect(p).toMatch(/[-_.!@#%]/)
      expect(p).toMatch(/^[A-Za-z0-9\-_.!@#%]+$/)
      expect(p).not.toMatch(/[0O1lI]/)
    }
    expect(generatePassword(8).length).toBe(8)
  })

  it('is unique', () => {
    const set = new Set(Array.from({ length: 1000 }, () => generatePassword()))
    expect(set.size).toBe(1000)
  })
})
