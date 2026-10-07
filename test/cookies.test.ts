import { createCipheriv, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptCookie, deriveKey } from '../src/main/cookies'

const IV = Buffer.alloc(16, ' ')
const v10 = deriveKey('peanuts')
const v11 = deriveKey('keyring-secret')

function enc(prefix: string, key: Buffer, plain: Buffer): Buffer {
  const c = createCipheriv('aes-128-cbc', key, IV)
  return Buffer.concat([Buffer.from(prefix), c.update(plain), c.final()])
}

describe('cookies', () => {
  it('derives a 16 byte key', () => {
    expect(v10.length).toBe(16)
    expect(v10.toString('hex')).toBe('fd621fe5a2b402539dfa147ca9272778')
  })

  it('decrypts v10 and v11', () => {
    const keys = { v10, v11 }
    expect(decryptCookie(enc('v10', v10, Buffer.from('hello')), keys, '.x.com', 0)).toBe('hello')
    expect(decryptCookie(enc('v11', v11, Buffer.from('world')), keys, '.x.com', 0)).toBe('world')
  })

  it('verifies and strips the host hash on db >= 24', () => {
    const hash = createHash('sha256').update('.x.com').digest()
    const blob = enc('v10', v10, Buffer.concat([hash, Buffer.from('tok')]))
    expect(decryptCookie(blob, { v10, v11: null }, '.x.com', 24)).toBe('tok')
    expect(decryptCookie(blob, { v10, v11: null }, '.y.com', 24)).toBeNull()
  })

  it('returns null on wrong key or missing v11 key', () => {
    const blob = enc('v11', v11, Buffer.from('secret'))
    expect(decryptCookie(blob, { v10, v11: null }, 'a', 0)).toBeNull()
    expect(decryptCookie(blob, { v10, v11: deriveKey('nope') }, 'a', 0)).toBeNull()
  })

  it('treats unprefixed values as plaintext', () => {
    expect(decryptCookie(Buffer.from('plain'), { v10, v11: null }, 'a', 24)).toBe('plain')
  })
})
