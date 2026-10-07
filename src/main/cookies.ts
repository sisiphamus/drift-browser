// Chromium Linux cookie crypto (os_crypt v10/v11). Pure Node, no Electron.

import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'

export type CookieKeys = { v10: Buffer; v11: Buffer | null }

const IV = Buffer.alloc(16, ' ')

export function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')
}

export function decryptCookie(encrypted: Buffer, keys: CookieKeys, hostKey: string, dbVersion: number): string | null {
  const prefix = encrypted.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') return encrypted.toString('utf8')
  const key = prefix === 'v10' ? keys.v10 : keys.v11
  if (!key) return null
  try {
    const d = createDecipheriv('aes-128-cbc', key, IV) // final() strips + checks PKCS7
    let plain = Buffer.concat([d.update(encrypted.subarray(3)), d.final()])
    if (dbVersion >= 24) {
      const hash = createHash('sha256').update(hostKey).digest()
      if (plain.length < 32 || !plain.subarray(0, 32).equals(hash)) return null
      plain = plain.subarray(32)
    }
    const s = plain.toString('utf8')
    return s.includes('�') ? null : s // wrong key can pass padding by chance
  } catch {
    return null
  }
}
