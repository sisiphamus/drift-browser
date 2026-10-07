// Read a Zen (Firefox) profile: saved logins (NSS key4.db + logins.json) and cookies. Pure Node, no Electron.
// Never logs values.
import { createDecipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withCopy, type BraveCookie, type BraveLogin } from './brave'

export function zenProfileDir(home = homedir()): string | null {
  for (const root of [join(home, '.var/app/app.zen_browser.zen/.zen'), join(home, '.zen')]) {
    const ini = join(root, 'profiles.ini')
    if (!existsSync(ini)) continue
    const sections = readFileSync(ini, 'utf8').split(/^\[/m).map((s) => {
      const [head, ...lines] = s.split('\n')
      const kv = Object.fromEntries(lines.map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join('=').trim()]))
      return { head: head.replace(/\]\s*$/, ''), kv }
    })
    const pick =
      sections.find((s) => s.head.startsWith('Install') && s.kv.Default)?.kv.Default ??
      sections.find((s) => s.kv.Default === '1' && s.kv.Path)?.kv.Path ??
      sections.find((s) => s.kv.Path)?.kv.Path
    if (pick) {
      const dir = pick.startsWith('/') ? pick : join(root, pick)
      if (existsSync(dir)) return dir
    }
  }
  return null
}

// ---- DER, just enough for NSS ----
type Node = { tag: number; data: Buffer; kids: Node[] }
function der(buf: Buffer): Node[] {
  const out: Node[] = []
  let i = 0
  while (i < buf.length) {
    const tag = buf[i++]
    let n = buf[i++]
    if (n & 0x80) {
      const bytes = n & 0x7f
      n = 0
      for (let k = 0; k < bytes; k++) n = n * 256 + buf[i++]
    }
    const data = buf.subarray(i, i + n)
    i += n
    out.push({ tag, data, kids: tag & 0x20 ? der(data) : [] })
  }
  return out
}
function oid(b: Buffer): string {
  const parts = [Math.floor(b[0] / 40), b[0] % 40]
  let v = 0
  for (const byte of b.subarray(1)) {
    v = v * 128 + (byte & 0x7f)
    if (!(byte & 0x80)) {
      parts.push(v)
      v = 0
    }
  }
  return parts.join('.')
}
const int = (b: Buffer) => b.reduce((n, x) => n * 256 + x, 0)
function unpad(b: Buffer): Buffer {
  const n = b[b.length - 1]
  return n > 0 && n <= 16 ? b.subarray(0, b.length - n) : b
}
function decrypt(alg: string, key: Buffer, iv: Buffer, ct: Buffer): Buffer {
  const d = createDecipheriv(alg, key, iv)
  d.setAutoPadding(false)
  return unpad(Buffer.concat([d.update(ct), d.final()]))
}

const PBES2 = '1.2.840.113549.1.5.13'
const PBE_SHA1_3DES = '1.2.840.113549.1.12.5.1.3'
const AES256_CBC = '2.16.840.1.101.3.4.1.42'
const DES3_CBC = '1.2.840.113549.3.7'

/** A key4.db encrypted item: SEQUENCE { AlgorithmIdentifier, OCTET STRING ciphertext }. */
function pbeDecrypt(item: Buffer, globalSalt: Buffer, primary: string): Buffer {
  const [algo, ct] = der(item)[0].kids
  const kind = oid(algo.kids[0].data)
  const hp = createHash('sha1').update(Buffer.concat([globalSalt, Buffer.from(primary)])).digest()
  if (kind === PBES2) {
    const [kdf, cipher] = algo.kids[1].kids
    const [salt, iters, keyLen] = kdf.kids[1].kids
    const key = pbkdf2Sync(hp, salt.data, int(iters.data), keyLen?.tag === 0x02 ? int(keyLen.data) : 32, 'sha256')
    const iv = Buffer.concat([Buffer.from([4, 14]), cipher.kids[1].data])
    return decrypt('aes-256-cbc', key, iv, ct.data)
  }
  if (kind === PBE_SHA1_3DES) {
    // Older profiles: NSS's own PBE (sha1 + HMAC) into 3DES.
    const salt = algo.kids[1].kids[0].data
    const pes = Buffer.concat([salt, Buffer.alloc(Math.max(0, 20 - salt.length))])
    const chp = createHash('sha1').update(Buffer.concat([hp, salt])).digest()
    const k1 = createHmac('sha1', chp).update(Buffer.concat([pes, salt])).digest()
    const tk = createHmac('sha1', chp).update(pes).digest()
    const k2 = createHmac('sha1', chp).update(Buffer.concat([tk, salt])).digest()
    const k = Buffer.concat([k1, k2])
    return decrypt('des-ede3-cbc', k.subarray(0, 24), k.subarray(k.length - 8), ct.data)
  }
  throw new Error(`unsupported key4.db encryption ${kind}`)
}

function masterKey(profileDir: string, primary: string): Buffer {
  const db = new DatabaseSync(join(profileDir, 'key4.db'), { readOnly: true })
  try {
    const meta = db.prepare(`SELECT item1, item2 FROM metaData WHERE id = 'password'`).get() as { item1: Uint8Array; item2: Uint8Array } | undefined
    if (!meta) throw new Error('key4.db has no password entry')
    const salt = Buffer.from(meta.item1)
    let check: Buffer
    try {
      check = pbeDecrypt(Buffer.from(meta.item2), salt, primary)
    } catch {
      check = Buffer.alloc(0)
    }
    if (!check.toString('latin1').startsWith('password-check')) throw new Error('Zen has a primary password set; pass it to import logins')
    const CKA_ID = 'f8000000000000000000000000000001'
    for (const r of db.prepare('SELECT a11, a102 FROM nssPrivate').all() as { a11: Uint8Array; a102: Uint8Array }[]) {
      if (Buffer.from(r.a102).toString('hex') === CKA_ID) return pbeDecrypt(Buffer.from(r.a11), salt, primary)
    }
    throw new Error('key4.db has no login key')
  } finally {
    db.close()
  }
}

function decryptField(b64: string, master: Buffer): string {
  const [, algo, ct] = der(Buffer.from(b64, 'base64'))[0].kids
  const kind = oid(algo.kids[0].data)
  const iv = algo.kids[1].data
  if (kind === AES256_CBC) return decrypt('aes-256-cbc', master.subarray(0, 32), iv, ct.data).toString('utf8')
  if (kind === DES3_CBC) return decrypt('des-ede3-cbc', master.subarray(0, 24), iv, ct.data).toString('utf8')
  throw new Error(`unsupported login encryption ${kind}`)
}

type ZenLogin = { hostname: string; httpRealm: string | null; encryptedUsername: string; encryptedPassword: string }

/** Saved web form logins (HTTP-auth entries are skipped, as with Brave). */
export function readZenLogins(profileDir: string, primary = ''): BraveLogin[] {
  const file = join(profileDir, 'logins.json')
  if (!existsSync(file) || !existsSync(join(profileDir, 'key4.db'))) return []
  const logins = (JSON.parse(readFileSync(file, 'utf8')).logins ?? []) as ZenLogin[]
  if (!logins.length) return []
  const master = masterKey(profileDir, primary)
  const out: BraveLogin[] = []
  for (const l of logins) {
    if (l.httpRealm) continue
    let origin: string
    try {
      origin = new URL(l.hostname).origin
    } catch {
      continue
    }
    if (origin === 'null') continue
    try {
      const password = decryptField(l.encryptedPassword, master)
      if (!password) continue
      out.push({ origin, signonRealm: `${origin}/`, username: decryptField(l.encryptedUsername, master), password })
    } catch {
      // one unreadable entry shouldn't stop the rest
    }
  }
  return out
}

type CookieRow = { host: string; name: string; value: string; path: string; expiry: number; isSecure: number; isHttpOnly: number; sameSite: number }

/** Default-container, unpartitioned cookies (containers and partitioned cookies have no Drift equivalent). */
export function readZenCookies(profileDir: string): BraveCookie[] {
  const file = join(profileDir, 'cookies.sqlite')
  if (!existsSync(file)) return []
  return withCopy(file, (db) => {
    const rows = db
      .prepare(`SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies WHERE originAttributes = ''`)
      .all() as CookieRow[]
    return rows.map((r) => {
      const secure = r.isSecure === 1
      const dot = r.host.startsWith('.')
      // Newer Firefox stores expiry in milliseconds.
      const expiry = r.expiry > 1e11 ? Math.round(r.expiry / 1000) : r.expiry
      const sameSite = r.sameSite === 1 ? 'lax' : r.sameSite === 2 ? 'strict' : secure ? 'no_restriction' : 'unspecified'
      const c: BraveCookie = {
        url: `http${secure ? 's' : ''}://${dot ? r.host.slice(1) : r.host}${r.path}`,
        name: r.name,
        value: r.value,
        ...(dot ? { domain: r.host } : {}),
        path: r.path,
        secure,
        httpOnly: r.isHttpOnly === 1,
        sameSite,
      }
      if (expiry) c.expirationDate = expiry
      return c
    })
  })
}
