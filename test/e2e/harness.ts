// End-to-end harness: a real Drift, headless (or on the real display with E2E_DISPLAY=1), on a throwaway
// profile, driven over its CLI socket.
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, existsSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const ADBLOCK_CACHE = 'adblock-v3.bin' // src/main/adblock.ts
const ELECTRON = join(ROOT, 'node_modules/.bin/electron')

export type Drift = {
  rpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  stop: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  restart: () => Promise<Drift>
  profile: string
  log: () => string
}

export async function startDrift(opts: { profile?: string; settings?: Record<string, unknown> } = {}): Promise<Drift> {
  const profile = opts.profile ?? mkdtempSync(join(tmpdir(), 'drift-e2e-'))
  const socket = join(profile, 'drift.sock')
  if (opts.settings) writeFileSync(join(profile, 'settings.json'), JSON.stringify(opts.settings))
  // Reuse a cached filter-list engine when one exists, so each run doesn't download the lists.
  const cache = [join(homedir(), '.config/Drift', ADBLOCK_CACHE), join(ROOT, `.e2e-${ADBLOCK_CACHE}`)].find(existsSync)
  if (cache && !existsSync(join(profile, ADBLOCK_CACHE))) copyFileSync(cache, join(profile, ADBLOCK_CACHE))

  let out = ''
  // Headless has no GPU; without --disable-gpu Chromium keeps relaunching a failing GPU process and aborts on
  // some exits. Real-display runs (bash scripts/realquit.sh) quit cleanly either way.
  const display = !!process.env.E2E_DISPLAY
  const child: ChildProcess = spawn(ELECTRON, display ? [ROOT] : ['--ozone-platform=headless', '--disable-gpu', ROOT], {
    env: { ...process.env, DRIFT_PROFILE: profile, DRIFT_SOCKET: socket, DRIFT_DEBUG: '1', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (d) => (out += d))
  child.stderr!.on('data', (d) => (out += d))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
    child.once('exit', (code, signal) => res({ code, signal })),
  )
  let stopping = false
  void exited.then((r) => {
    if (!stopping) process.stderr.write(`\n[e2e] Drift exited unexpectedly ${JSON.stringify(r)}; log tail:\n${out.split('\n').filter((l) => !/gl_surface|gpu_info|gpu_init|viz_main|nss_util|INFO:CONSOLE/.test(l)).slice(-25).join('\n')}\n`)
  })

  const rpc = <T,>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((res, rej) => {
      const c = createConnection(socket)
      let buf = ''
      c.on('error', rej)
      // Quitting closes the socket before any reply; settle instead of waiting forever.
      c.on('close', () => rej(new Error(`connection closed during ${method}`)))
      c.on('data', (d) => {
        buf += d
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        c.end()
        const msg = JSON.parse(buf.slice(0, nl))
        if (msg.error) rej(new Error(msg.error))
        else res(msg.result as T)
      })
      c.write(JSON.stringify({ id: 1, method, params }) + '\n')
    })

  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      await rpc('ws.list')
      break
    } catch {
      if (Date.now() > deadline) throw new Error(`Drift did not start:\n${out.slice(-2000)}`)
      await sleep(200)
    }
  }
  await rpc('debug.resize', { w: 1280, h: 800 })

  const drift: Drift = {
    rpc,
    profile,
    log: () => out,
    stop: async () => {
      stopping = true
      await rpc('run', { action: 'quit' }).catch(() => {})
      const t = setTimeout(() => child.kill('SIGKILL'), 15_000)
      const r = await exited
      clearTimeout(t)
      // Keep the first downloaded engine for later runs.
      const fresh = join(profile, ADBLOCK_CACHE)
      if (existsSync(fresh) && !existsSync(join(ROOT, `.e2e-${ADBLOCK_CACHE}`))) copyFileSync(fresh, join(ROOT, `.e2e-${ADBLOCK_CACHE}`))
      if (r.code !== 0 || r.signal) writeFileSync(join(tmpdir(), 'drift-e2e-last-crash.log'), out)
      if (r.code !== 0 || r.signal) process.stderr.write(`\n[e2e] quit returned ${JSON.stringify(r)}; log tail:\n${out.split('\n').filter((l) => !/gl_surface|gpu_info|gpu_init|viz_main|nss_util|INFO:CONSOLE|permission check|window.open/.test(l)).slice(-30).join('\n')}\n`)
      return r
    },
    restart: async () => {
      await drift.stop()
      return startDrift({ profile })
    },
  }
  return drift
}

/**
 * A clean exit. Headless Chromium aborts (SIGTRAP) at exit on a fraction of quits, a headless-only artifact:
 * the same quits are clean on the real display (E2E_DISPLAY=1, scripts/realquit.sh). Headless runs tolerate
 * exactly that, and nothing else: no JavaScript error before it, and it must be the last thing logged.
 */
export function cleanExit(r: { code: number | null; signal: NodeJS.Signals | null }, log: string): boolean {
  if (r.code === 0 && !r.signal) return true
  if (process.env.E2E_DISPLAY) return false
  const tail = log.trimEnd().split('\n')
  return r.code === 1 && /exited with signal SIGTRAP$/.test(tail[tail.length - 1]) && !/Uncaught|UnhandledPromiseRejection|TypeError|Error occurred in handler/.test(log)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls until `check` returns a truthy value, or fails with the last value seen. */
export async function until<T>(check: () => Promise<T> | T, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  let last: T | undefined
  while (Date.now() < end) {
    last = await check()
    if (last) return last as NonNullable<T>
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`)
}

/** Local pages for the tests, so nothing depends on the network. */
export function fixtures(): Promise<{ url: (p: string) => string; close: () => Promise<void>; server: Server }> {
  const page = (title: string, body = '') => `<!doctype html><title>${title}</title><body>${body}</body>`
  const routes: Record<string, string> = {
    '/a': page('Page A', '<p>alpha</p><a id="next" href="/b">to b</a>'),
    '/b': page('Page B', '<p>bravo</p>'),
    '/c': page('Page C', '<p>charlie</p>'),
    '/login': page(
      'Login',
      `<form action="/b" method="get"><input name="email" type="email" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>`,
    ),
    '/opener': page('Opener', `<script>window.openPopup = () => (window.__p = window.open('/popup', 'p', 'width=400,height=500'))</script>`),
    '/tracked': page('Tracked', '<p>tracked</p><script src="https://www.google-analytics.com/analytics.js"></script><img src="https://www.facebook.com/tr?id=1&ev=PageView">'),
    '/popup': page('Popup', `<p>in popup</p><script>window.reply = () => { window.opener.postMessage('done', '*'); window.close() }</script>`),
  }
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const path = (req.url ?? '/').split('?')[0]
      const body = routes[path]
      resp.writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
      resp.end(body ?? 'not found')
    }).listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      res({ url: (p) => `http://127.0.0.1:${port}${p}`, close: () => new Promise((r) => server.close(() => r())), server })
    })
  })
}

export function cleanup(profile: string) {
  // Chromium's helper processes can still be flushing the profile for a moment after the browser exits.
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
