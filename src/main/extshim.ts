// Electron gives extensions chrome.storage.local but not sync or managed, in content scripts and service
// workers alike, so extensions that save settings through sync break. Drift patches its own copy of each
// extension so a small shim runs first in those contexts and points sync and managed at local, which is what
// Chrome does with sync turned off. (Extension pages are covered by electron-chrome-extensions' preload.)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const COMPAT = '_drift/compat.js'
const WRAPPER = '_drift/sw.js'

const SHIM = `// Added by Drift: Electron has no storage.sync or .managed (their methods throw), so sync keeps its quota
// constants but stores locally, as Chrome does with sync off, and managed reports no policy.
(() => {
  const s = globalThis.chrome && globalThis.chrome.storage
  if (!s || !s.local || s.__drift) return
  const local = s.local
  const sync = {}
  for (const k of ['QUOTA_BYTES', 'QUOTA_BYTES_PER_ITEM', 'MAX_ITEMS', 'MAX_WRITE_OPERATIONS_PER_HOUR', 'MAX_WRITE_OPERATIONS_PER_MINUTE']) {
    try {
      if (s.sync && typeof s.sync[k] === 'number') sync[k] = s.sync[k]
    } catch {}
  }
  for (const k of ['get', 'set', 'remove', 'clear', 'getBytesInUse', 'getKeys', 'setAccessLevel']) {
    if (typeof local[k] === 'function') sync[k] = local[k].bind(local)
  }
  sync.onChanged = local.onChanged
  const none = (keys, cb) => (typeof keys === 'function' ? keys({}) : cb ? cb({}) : Promise.resolve({}))
  const managed = { get: none, getBytesInUse: (keys, cb) => (typeof keys === 'function' ? keys(0) : cb ? cb(0) : Promise.resolve(0)), onChanged: (s.managed && s.managed.onChanged) || local.onChanged }
  try {
    Object.defineProperty(s, 'sync', { value: sync, configurable: true, enumerable: true, writable: true })
    Object.defineProperty(s, 'managed', { value: managed, configurable: true, enumerable: true, writable: true })
    Object.defineProperty(s, '__drift', { value: true })
  } catch {}
})()
`

type Manifest = {
  background?: { service_worker?: string; type?: string; scripts?: string[] }
  content_scripts?: { js?: string[] }[]
}

export function shimExtension(dir: string) {
  const path = join(dir, 'manifest.json')
  const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  const before = JSON.stringify(m)
  let needed = false

  for (const cs of m.content_scripts ?? []) {
    if (!cs.js?.length) continue
    needed = true
    if (cs.js[0] !== COMPAT) cs.js.unshift(COMPAT)
  }
  if (m.background?.scripts?.length) {
    needed = true
    if (m.background.scripts[0] !== COMPAT) m.background.scripts.unshift(COMPAT)
  }
  const sw = m.background?.service_worker
  if (sw) {
    needed = true
    if (sw !== WRAPPER) {
      const orig = '/' + sw.replace(/^\.?\//, '')
      const body = m.background!.type === 'module' ? `import '/${COMPAT}'\nimport '${orig}'\n` : `importScripts('/${COMPAT}', '${orig}')\n`
      mkdirSync(join(dir, '_drift'), { recursive: true })
      writeFileSync(join(dir, WRAPPER), body)
      m.background!.service_worker = WRAPPER
    }
  }
  if (!needed) return
  mkdirSync(join(dir, '_drift'), { recursive: true })
  if (!existsSync(join(dir, COMPAT)) || readFileSync(join(dir, COMPAT), 'utf8') !== SHIM) writeFileSync(join(dir, COMPAT), SHIM)
  if (JSON.stringify(m) !== before) writeFileSync(path, JSON.stringify(m, null, 2))
}
