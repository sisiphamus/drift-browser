import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shimExtension } from '../src/main/extshim'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function ext(manifest: object) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-ext-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return dir
}
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))

describe('shimExtension', () => {
  it('runs the compat shim before every content script', () => {
    const dir = ext({ manifest_version: 3, content_scripts: [{ matches: ['<all_urls>'], js: ['a.js', 'b.js'] }, { matches: ['x'], css: ['c.css'] }] })
    shimExtension(dir)
    const m = manifest(dir)
    expect(m.content_scripts[0].js).toEqual(['_drift/compat.js', 'a.js', 'b.js'])
    expect(m.content_scripts[1].js).toBeUndefined()
    expect(readFileSync(join(dir, '_drift/compat.js'), 'utf8')).toContain('storage')
  })

  it('wraps a classic MV3 service worker with importScripts', () => {
    const dir = ext({ manifest_version: 3, background: { service_worker: 'bg/sw.js' } })
    shimExtension(dir)
    expect(manifest(dir).background.service_worker).toBe('_drift/sw.js')
    expect(readFileSync(join(dir, '_drift/sw.js'), 'utf8')).toBe("importScripts('/_drift/compat.js', '/bg/sw.js')\n")
  })

  it('wraps a module service worker with imports', () => {
    const dir = ext({ manifest_version: 3, background: { service_worker: 'sw.js', type: 'module' } })
    shimExtension(dir)
    expect(readFileSync(join(dir, '_drift/sw.js'), 'utf8')).toBe("import '/_drift/compat.js'\nimport '/sw.js'\n")
  })

  it('prepends to MV2 background scripts', () => {
    const dir = ext({ manifest_version: 2, background: { scripts: ['bg.js'] } })
    shimExtension(dir)
    expect(manifest(dir).background.scripts).toEqual(['_drift/compat.js', 'bg.js'])
  })

  it('is idempotent', () => {
    const dir = ext({ manifest_version: 3, background: { service_worker: 'sw.js' }, content_scripts: [{ matches: ['x'], js: ['a.js'] }] })
    shimExtension(dir)
    const once = manifest(dir)
    shimExtension(dir)
    expect(manifest(dir)).toEqual(once)
    expect(readFileSync(join(dir, '_drift/sw.js'), 'utf8')).toContain("'/sw.js'")
  })

  it('leaves extensions without scripts untouched', () => {
    const dir = ext({ manifest_version: 3, name: 'theme' })
    shimExtension(dir)
    expect(manifest(dir)).toEqual({ manifest_version: 3, name: 'theme' })
    expect(existsSync(join(dir, '_drift'))).toBe(false)
  })
})
