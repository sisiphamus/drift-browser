#!/usr/bin/env node
// Memory and CPU benchmark: Drift vs Brave, same pages, same machine, fresh warmed profiles.
//   node scripts/bench.mjs drift|brave [--display] [--rounds 1]
// Memory is PSS summed over the browser's whole process tree (shared pages split fairly between processes).
// CPU is the tree's user+system time over an idle window after the pages settle.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdirSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const which = process.argv[2]
const display = process.argv.includes('--display')
const URLS = [
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://github.com/electron/electron',
  'https://news.ycombinator.com/',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.reddit.com/r/linux/',
  'https://www.bbc.com/news',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://stackoverflow.com/questions',
]
const SETTLE_MS = 25_000
const IDLE_MS = 20_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function tree(root) {
  const kids = new Map()
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid).push(Number(d))
    } catch {}
  }
  const out = []
  const walk = (p) => {
    out.push(p)
    for (const k of kids.get(p) ?? []) walk(k)
  }
  walk(root)
  return out
}

function pssKB(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB/m)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

function cpuTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(f[11]) + Number(f[12])
  } catch {
    return 0
  }
}

const measure = (root) => {
  const pids = tree(root)
  return { pids, pssMB: Math.round(pids.reduce((s, p) => s + pssKB(p), 0) / 1024), ticks: pids.reduce((s, p) => s + cpuTicks(p), 0) }
}

async function runDrift() {
  const profile = '/tmp/drift-bench-profile'
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  // Keep filter-list engines between runs so every run starts with blocking ready.
  const keep = '/tmp/drift-bench-cache'
  mkdirSync(keep, { recursive: true })
  if (!existsSync(join(keep, 'adblock-v3.bin')) && existsSync(join(homedir(), '.config/Drift/adblock-v3.bin')))
    copyFileSync(join(homedir(), '.config/Drift/adblock-v3.bin'), join(keep, 'adblock-v3.bin'))
  for (const f of readdirSync(keep)) copyFileSync(join(keep, f), join(profile, f))
  process.on('exit', () => {
    for (const f of readdirSync(profile).filter((f) => f.endsWith('.bin'))) copyFileSync(join(profile, f), join(keep, f))
  })
  const socket = join(profile, 'drift.sock')
  const args = display ? [ROOT] : ['--ozone-platform=headless', '--disable-gpu', ROOT]
  const child = spawn(join(ROOT, 'node_modules/.bin/electron'), args, {
    env: { ...process.env, DRIFT_PROFILE: profile, DRIFT_SOCKET: socket },
    stdio: 'ignore',
  })
  const rpc = (method, params = {}) =>
    new Promise((res, rej) => {
      const c = createConnection(socket)
      let buf = ''
      c.on('error', rej)
      c.on('close', () => rej(new Error('closed')))
      c.on('data', (d) => {
        buf += d
        if (!buf.includes('\n')) return
        c.end()
        const m = JSON.parse(buf)
        m.error ? rej(new Error(m.error)) : res(m.result)
      })
      c.write(JSON.stringify({ id: 1, method, params }) + '\n')
    })
  for (let i = 0; ; i++) {
    try {
      await rpc('ws.list')
      break
    } catch {
      if (i > 150) throw new Error('drift did not start')
      await sleep(200)
    }
  }
  await rpc('debug.resize', { w: 1440, h: 900 })
  for (const u of URLS) {
    await rpc('tabs.open', { url: u })
    await sleep(5000)
  }
  const titles = async () => (await rpc('tabs.list', { all: true })).map((t) => t.title)
  return { root: child.pid, rpc, titles, stop: () => rpc('run', { action: 'quit' }).catch(() => {}) }
}

async function runBrave() {
  const profile = '/tmp/brave-bench-profile'
  const warm = existsSync(join(profile, 'Default'))
  mkdirSync(profile, { recursive: true })
  const port = 9444 // 9333 is brave-bridge's
  const args = ['run', 'com.brave.Browser', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--window-size=1440,900']
  if (!display) args.push('--headless=new', '--disable-gpu')
  const child = spawn('flatpak', [...args, 'about:blank'], { stdio: 'ignore' })
  const http = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json()
  for (let i = 0; ; i++) {
    try {
      await http('/json/version')
      break
    } catch {
      if (i > 150) throw new Error('brave did not start')
      await sleep(200)
    }
  }
  if (!warm) {
    // First run: give Brave Shields time to download its filter lists, as Drift's are already cached.
    console.error('warming Brave profile (filter lists)...')
    await sleep(60_000)
  }
  for (const u of URLS) {
    await http(`/json/new?${encodeURIComponent(u)}`, 'PUT')
    await sleep(5000)
  }
  // flatpak's own pid has the browser tree under it.
  return {
    root: child.pid,
    titles: async () => (await http('/json/list')).filter((t) => t.type === 'page').map((t) => t.title),
    stop: async () => {
      const v = await http('/json/version').catch(() => null)
      if (v?.webSocketDebuggerUrl) {
        const ws = new WebSocket(v.webSocketDebuggerUrl)
        await new Promise((r) => ws.addEventListener('open', r))
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        await sleep(1500)
      }
      // Only the tree this script launched; the user's own Brave is untouched.
      for (const pid of tree(child.pid).reverse()) {
        try {
          process.kill(pid)
        } catch {}
      }
    },
  }
}

const b = which === 'brave' ? await runBrave() : await runDrift()
await sleep(SETTLE_MS)
const m1 = measure(b.root)
await sleep(IDLE_MS)
const m2 = measure(b.root)
const hz = Number(execFileSync('getconf', ['CLK_TCK']).toString())
// Per-process breakdown by Chromium process type (from the command line).
const kinds = {}
for (const pid of m2.pids) {
  let cmd = ''
  try {
    cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
  } catch {}
  const type = cmd.match(/--type=(\S+)/)?.[1] ?? (/bwrap|flatpak/.test(cmd) ? 'sandbox' : cmd ? 'browser' : 'gone')
  const sub = cmd.match(/--utility-sub-type=(\S+)/)?.[1]?.split('.').pop()
  const extra = type === 'renderer' && /--extension-process/.test(cmd) ? '(ext)' : ''
  const key = sub ? `utility:${sub}` : type + extra
  kinds[key] ??= { n: 0, mb: 0 }
  kinds[key].n++
  kinds[key].mb += Math.round(pssKB(pid) / 1024)
}
// A run only counts when every page actually loaded (a real title, not an address or an error page).
const loaded = (await b.titles()).filter((t) => t && !/^https?:|^about:|^$|not available|can.t be reached|error/i.test(t)).length
const result = {
  valid: loaded >= URLS.length,
  loaded,
  browser: which,
  mode: display ? 'display' : 'headless',
  tabs: URLS.length,
  processes: m2.pids.length,
  pssMB: m2.pssMB,
  idleCpuPct: Math.round(((m2.ticks - m1.ticks) / hz / (IDLE_MS / 1000)) * 1000) / 10,
  breakdown: kinds,
  uiMB: b.rpc ? Math.round(pssKB(await b.rpc('debug.uiPid')) / 1024) : undefined,
}
console.log(JSON.stringify(result))
await b.stop()
await sleep(2000)
