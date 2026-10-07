// Chrome extensions: unpacked dirs, .crx files, Web Store ids, and Brave's installed set.
import type { Session } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { shimExtension } from './extshim'
import { join, resolve, basename } from 'node:path'

export type ExtInfo = {
  id: string
  name: string
  version: string
  path: string
  enabled: boolean
  description: string
  storeId: string | null
  options: string | null
}
type Saved = { path: string; enabled: boolean }

/** Extensions confirmed working under Drift (Electron's extension layer), keyed by Web Store id. */
export const CATALOG = [
  { storeId: 'mnjggcdmjocbbbhaepdhchncahnbgone', name: 'SponsorBlock', blurb: 'Skips sponsor reads, intros and reminders in YouTube videos.' },
  { storeId: 'gebbhagfogifgggkldgodflihgfeippi', name: 'Return YouTube Dislike', blurb: 'Shows dislike counts on YouTube again.' },
  { storeId: 'khncfooichmfjbepaaaebmommgaepoid', name: 'Unhook', blurb: 'Hides YouTube recommendations, Shorts, comments and the home feed.' },
  { storeId: 'edibdbjcniadpccecjdfdjjppcpchdlm', name: "I still don't care about cookies", blurb: 'Dismisses cookie consent banners.' },
  { storeId: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', name: 'Dark Reader', blurb: 'Dark mode for every site.' },
]

const STORE_ID = /(?:^|\/)([a-p]{32})(?:[/?#]|$)/

export class Extensions {
  private listPath: string
  private dir: string

  constructor(private session: Session, userData: string, private chromeVersion: string) {
    this.dir = join(userData, 'extensions')
    this.listPath = join(userData, 'extensions.json')
    mkdirSync(this.dir, { recursive: true })
  }

  private saved(): Saved[] {
    try {
      // Older profiles stored bare paths.
      return (JSON.parse(readFileSync(this.listPath, 'utf8')) as (string | Saved)[]).map((e) => (typeof e === 'string' ? { path: e, enabled: true } : e))
    } catch {
      return []
    }
  }

  private save(list: Saved[]) {
    const byPath = new Map(list.map((e) => [e.path, e]))
    writeFileSync(this.listPath, JSON.stringify([...byPath.values()], null, 2))
  }

  async restore() {
    for (const e of this.saved()) {
      if (!e.enabled) continue
      try {
        this.prepare(e.path)
        await this.session.extensions.loadExtension(e.path, { allowFileAccess: true })
      } catch (err) {
        console.warn(`[drift] extension failed to load: ${e.path}: ${(err as Error).message}`)
      }
    }
  }

  private describe(path: string, loaded?: Electron.Extension): ExtInfo | null {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))
    } catch {
      return null
    }
    const msg = (v: unknown) => localize(path, m, String(v ?? ''))
    const optionsPage = (m.options_ui as { page?: string } | undefined)?.page ?? (m.options_page as string | undefined) ?? null
    return {
      id: loaded?.id ?? '',
      name: loaded?.name ?? msg(m.name),
      version: String(m.version ?? ''),
      path,
      enabled: !!loaded,
      description: msg(m.description).slice(0, 160),
      storeId: path.match(STORE_ID)?.[1] ?? null,
      options: loaded && optionsPage ? `chrome-extension://${loaded.id}/${optionsPage}` : null,
    }
  }

  list(): ExtInfo[] {
    const loaded = new Map(this.session.extensions.getAllExtensions().map((e) => [resolve(e.path), e]))
    const out: ExtInfo[] = []
    for (const s of this.saved()) {
      const info = this.describe(s.path, loaded.get(resolve(s.path)))
      if (info) out.push(info)
      loaded.delete(resolve(s.path))
    }
    for (const e of loaded.values()) {
      const info = this.describe(e.path, e)
      if (info) out.push(info)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  catalog() {
    const installed = new Set(this.list().map((e) => e.storeId))
    return CATALOG.map((c) => ({ ...c, installed: installed.has(c.storeId) }))
  }

  /** Accepts an unpacked dir, a .crx path, a Web Store id, or a Web Store URL. */
  async load(input: string): Promise<ExtInfo> {
    let dir: string
    const storeId = input.match(STORE_ID)?.[1]
    if (existsSync(input) && !input.endsWith('.crx')) {
      dir = resolve(input)
      // Drift patches extensions for compatibility, so it works on its own copy, never the user's folder.
      if (!dir.startsWith(this.dir + '/')) return this.adopt(dir, `unpacked-${basename(dir).replace(/[^\w.-]/g, '_')}`)
    } else if (input.endsWith('.crx') && existsSync(input)) {
      dir = this.unpackCrx(readFileSync(input), `crx-${Date.now()}`)
    } else if (storeId) {
      dir = this.unpackCrx(await this.download(storeId), storeId)
    } else {
      throw new Error(`not an extension folder, .crx file, or Web Store link: ${input}`)
    }
    const already = this.session.extensions.getAllExtensions().find((e) => resolve(e.path) === dir)
    if (already) this.session.extensions.removeExtension(already.id)
    this.prepare(dir)
    const ext = await this.session.extensions.loadExtension(dir, { allowFileAccess: true })
    this.save([...this.saved().filter((e) => e.path !== dir), { path: dir, enabled: true }])
    return this.describe(dir, ext)!
  }

  /** Copies an already-unpacked extension (e.g. from Brave) into Drift's own folder, then loads it. */
  async adopt(src: string, id: string): Promise<ExtInfo> {
    const dest = join(this.dir, id)
    rmSync(dest, { recursive: true, force: true })
    cpSync(src, dest, { recursive: true })
    // Chrome writes _metadata with hashes Electron rejects.
    rmSync(join(dest, '_metadata'), { recursive: true, force: true })
    return this.load(dest)
  }

  /** Electron has no disable: unload it and remember it as off. */
  async setEnabled(path: string, on: boolean) {
    const list = this.saved()
    const entry = list.find((e) => resolve(e.path) === resolve(path))
    if (!entry) throw new Error('not an installed extension')
    entry.enabled = on
    this.save(list)
    const loaded = this.session.extensions.getAllExtensions().find((e) => resolve(e.path) === resolve(path))
    if (on && !loaded) {
      this.prepare(entry.path)
      await this.session.extensions.loadExtension(entry.path, { allowFileAccess: true })
    }
    if (!on && loaded) this.session.extensions.removeExtension(loaded.id)
  }

  /** Removes by extension id or install path; deletes Drift's own copy of the files. */
  remove(idOrPath: string) {
    const loaded = this.session.extensions.getAllExtensions().find((e) => e.id === idOrPath || resolve(e.path) === resolve(idOrPath))
    const path = loaded ? resolve(loaded.path) : resolve(idOrPath)
    if (loaded) this.session.extensions.removeExtension(loaded.id)
    this.save(this.saved().filter((e) => resolve(e.path) !== path))
    if (path.startsWith(this.dir)) rmSync(path, { recursive: true, force: true })
  }

  /** Compatibility patches, only ever on Drift's own copies. */
  private prepare(path: string) {
    if (!resolve(path).startsWith(this.dir + '/')) return
    try {
      shimExtension(path)
    } catch (err) {
      console.warn(`[drift] could not patch extension ${path}: ${(err as Error).message}`)
    }
  }

  private async download(id: string): Promise<Buffer> {
    const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${this.chromeVersion}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Web Store download failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  private unpackCrx(buf: Buffer, name: string): string {
    if (buf.toString('ascii', 0, 4) !== 'Cr24') throw new Error('not a crx file')
    const version = buf.readUInt32LE(4)
    const zipStart = version === 3 ? 12 + buf.readUInt32LE(8) : 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12)
    const dest = join(this.dir, name)
    const zip = `${dest}.zip`
    rmSync(dest, { recursive: true, force: true })
    writeFileSync(zip, buf.subarray(zipStart))
    try {
      execFileSync('unzip', ['-q', '-o', zip, '-d', dest])
    } catch (e) {
      // unzip exits 1 on warnings (e.g. extra bytes) but still extracts.
      if (!existsSync(join(dest, 'manifest.json'))) throw e
    } finally {
      rmSync(zip, { force: true })
    }
    rmSync(join(dest, '_metadata'), { recursive: true, force: true })
    return dest
  }
}

/** Resolves __MSG_key__ strings from the extension's default locale. */
function localize(path: string, manifest: Record<string, unknown>, value: string): string {
  const m = value.match(/^__MSG_(\w+)__$/)
  if (!m) return value
  for (const loc of [manifest.default_locale, 'en', 'en_US']) {
    if (!loc) continue
    try {
      const messages = JSON.parse(readFileSync(join(path, '_locales', String(loc), 'messages.json'), 'utf8'))
      const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === m[1].toLowerCase()) as [string, { message: string }] | undefined
      if (hit) return hit[1].message
    } catch {
      /* try the next locale */
    }
  }
  return value
}
