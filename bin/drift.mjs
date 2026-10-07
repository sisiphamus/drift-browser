#!/usr/bin/env node
// drift: terminal control for the Drift browser. Talks NDJSON over a unix socket. Zero deps.

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SOCK = process.env.DRIFT_SOCKET || path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'drift.sock')
const TTY = process.stdout.isTTY
const VALUED = new Set(['-o', '--out', '--ws', '--split', '--timeout', '--primary-password'])

const USAGE = `drift <command> [args]          <tab> = id | active (default) | @N index

  open <url|query> [--bg] [--ws <name|id>] [--split right|left|top|bottom]
  launch                          start Drift if it is not running
  tabs [--all]                    list tabs
  focus <tab>     close [tab...]  reload [tab]  back [tab]  forward [tab]
  ws                              list workspaces
  ws new <name> | private [name] | go <name|id|next|prev> | rm <name|id> | rename <target> <name>
  split <tabA> <tabB> [right|left|top|bottom]      unsplit <tab>
  text [tab]  md [tab]  html [tab]  url [tab]
  shot [tab] [-o file.png] [--full]
  click [tab] <selector|text:Label>
  type [tab] <selector> <text> [--submit]
  eval [tab] <js|->               - reads js from stdin
  wait [tab] <selector|text:Label> [--timeout ms]
  scroll [tab] <px|top|bottom>
  stats   sleep <tab|all-idle>   wake <tab>
  adblock [on|off|status]
  import brave [--cookies] [--passwords]  logins come along with --cookies
  import brave --logins-only     just saved passwords and cookies
  import zen [--primary-password pw]  saved passwords and cookies from Zen
  ext list | load <dir|crx> | rm <id>
  bookmark [tab]   history <query>
  ask <task>                      hand a task to Claude, which works in the Agent space
  agents [stop|dismiss <id>]      Claude runs and their latest steps
  raw <method> [json]
  help

Global: --json prints raw JSON. DRIFT_SOCKET overrides ${SOCK}.`

class UsageError extends Error {}
const usage = (s) => {
  throw new UsageError(`usage: drift ${s}`)
}

function parse(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      pos.push(...argv.slice(i + 1))
      break
    }
    if (/^-\d/.test(a) || a === '-' || !a.startsWith('-')) {
      pos.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) flags[a.slice(0, eq)] = a.slice(eq + 1)
    else if (VALUED.has(a)) flags[a] = argv[++i]
    else flags[a] = true
  }
  return { pos, flags }
}

// Optional leading tab: if there are more positionals than `need`, the first is the tab.
function tabAnd(rest, need) {
  return rest.length > need ? [rest[0], rest.slice(1)] : ['active', rest]
}

const scrollTo = (v) => (/^-?\d+$/.test(v) ? Number(v) : v)

async function readStdin() {
  let s = ''
  for await (const c of process.stdin) s += c
  return s
}

// argv -> [method, params, post?]
async function route(cmd, rest, flags) {
  const tab = rest[0] ?? 'active'
  switch (cmd) {
    case 'open': {
      if (!rest.length) usage('open <url|query> [--bg] [--ws name] [--split side]')
      const p = { url: rest.join(' '), background: !!flags['--bg'] }
      if (flags['--ws']) p.workspace = flags['--ws']
      if (flags['--split']) p.split = flags['--split']
      return ['tabs.open', p]
    }
    case 'tabs':
      return ['tabs.list', flags['--all'] ? { all: true } : {}, 'tabs']
    case 'focus':
      if (!rest.length) usage('focus <tab>')
      return ['tabs.focus', { tab }]
    case 'close':
      return ['tabs.close', { tabs: rest.length ? rest : ['active'] }]
    case 'reload':
    case 'back':
    case 'forward':
      return [`tabs.${cmd}`, { tab }]
    case 'ws': {
      const [sub, a, b] = rest
      if (!sub) return ['ws.list', {}]
      if (sub === 'private') return ['ws.create', { private: true, ...(a ? { name: rest.slice(1).join(' ') } : {}) }]
      if (sub === 'new') return a ? ['ws.create', { name: rest.slice(1).join(' ') }] : usage('ws new <name>')
      if (sub === 'go') return a ? ['ws.switch', { target: a }] : usage('ws go <name|id|next|prev>')
      if (sub === 'rm') return a ? ['ws.remove', { target: a }] : usage('ws rm <name|id>')
      if (sub === 'rename') return a && b ? ['ws.rename', { target: a, name: rest.slice(2).join(' ') }] : usage('ws rename <target> <name>')
      if (sub === 'list' || sub === 'ls') return ['ws.list', {}]
      return usage('ws [new|go|rm|rename] ...')
    }
    case 'split':
      if (rest.length < 2) usage('split <tabA> <tabB> [right|left|top|bottom]')
      return ['split.add', { target: rest[0], tab: rest[1], side: rest[2] ?? 'right' }]
    case 'unsplit':
      return ['split.remove', { tab }]
    case 'text':
      return ['page.text', { tab }]
    case 'md':
    case 'markdown':
      return ['page.markdown', { tab }]
    case 'html':
      return ['page.html', { tab }]
    case 'url':
      return ['page.url', { tab }]
    case 'shot':
    case 'screenshot':
      return ['page.screenshot', { tab, full: !!flags['--full'] }, 'shot']
    case 'click': {
      if (!rest.length) usage('click [tab] <selector|text:Label>')
      const [t, [target]] = tabAnd(rest, 1)
      return ['page.click', { tab: t, target }]
    }
    case 'type': {
      if (rest.length < 2) usage('type [tab] <selector> <text> [--submit]')
      const [t, r] = rest.length > 2 ? [rest[0], rest.slice(1)] : ['active', rest]
      return ['page.type', { tab: t, selector: r[0], text: r.slice(1).join(' '), submit: !!flags['--submit'] }]
    }
    case 'eval': {
      if (!rest.length) usage('eval [tab] <js|->')
      const [t, r] = tabAnd(rest, 1)
      let js = r.join(' ')
      if (js === '-') js = await readStdin()
      return ['page.eval', { tab: t, js }]
    }
    case 'wait': {
      if (!rest.length) usage('wait [tab] <selector|text:Label> [--timeout ms]')
      const [t, [target]] = tabAnd(rest, 1)
      const p = { tab: t, target }
      if (flags['--timeout']) p.timeout = Number(flags['--timeout'])
      return ['page.wait', p]
    }
    case 'scroll': {
      if (!rest.length) usage('scroll [tab] <px|top|bottom>')
      const [t, [to]] = tabAnd(rest, 1)
      return ['page.scroll', { tab: t, to: scrollTo(to) }]
    }
    case 'stats':
      return ['stats', {}, 'stats']
    case 'sleep':
      return ['tabs.sleep', { tab }]
    case 'wake':
      return ['tabs.wake', { tab }]
    case 'adblock': {
      const s = rest[0] ?? 'status'
      if (s === 'status') return ['adblock.status', {}]
      if (s === 'on' || s === 'off') return ['adblock.set', { enabled: s === 'on' }]
      return usage('adblock [on|off|status]')
    }
    case 'import':
      if (rest[0] === 'zen') return ['import.zen', flags['--primary-password'] ? { primaryPassword: flags['--primary-password'] } : {}]
      if (rest[0] !== 'brave') usage('import brave [--cookies] [--logins-only] | import zen [--primary-password pw]')
      if (flags['--logins-only']) return ['import.brave', { loginsOnly: true }]
      return ['import.brave', { cookies: !!flags['--cookies'], passwords: !!flags['--passwords'] || !!flags['--cookies'] }]
    case 'ext': {
      const [sub, a] = rest
      if (!sub || sub === 'list' || sub === 'ls') return ['ext.list', {}]
      if (sub === 'load') return a ? ['ext.load', { path: path.resolve(a) }] : usage('ext load <dir|crx>')
      if (sub === 'rm') return a ? ['ext.remove', { id: a }] : usage('ext rm <id>')
      return usage('ext [list|load|rm]')
    }
    case 'passwords':
      return ['pw.list', {}]
    case 'bookmark':
      return ['bookmarks.add', { tab }]
    case 'history':
      return ['history.search', { q: rest.join(' ') }]
    case 'ask':
      return rest.length ? ['agent.ask', { prompt: rest.join(' ') }] : usage('ask <task>')
    case 'agents': {
      const [sub, id] = rest
      if (!sub) return ['agent.runs', {}]
      if ((sub === 'stop' || sub === 'dismiss') && id) return [`agent.${sub}`, { id }]
      return usage('agents [stop|dismiss <id>]')
    }
    case 'raw': {
      if (!rest[0]) usage('raw <method> [json]')
      let p = {}
      if (rest[1]) {
        try {
          p = JSON.parse(rest.slice(1).join(' '))
        } catch {
          usage('raw <method> [json]   (params must be valid JSON)')
        }
      }
      return [rest[0], p]
    }
  }
  throw new UsageError(`unknown command: ${cmd} (try drift help)`)
}

// --- transport ---

function connect(p = SOCK) {
  return new Promise((res, rej) => {
    const c = net.createConnection(p)
    c.once('connect', () => res(c))
    c.once('error', rej)
  })
}

function request(c, method, params) {
  return new Promise((res, rej) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString('utf8')
      const i = buf.indexOf('\n')
      if (i < 0) return
      const msg = JSON.parse(buf.slice(0, i))
      if ('error' in msg) rej(new Error(msg.error))
      else res(msg.result)
    })
    c.once('close', () => rej(new Error('drift closed the connection')))
    c.write(JSON.stringify({ id: 1, method, params }) + '\n')
  })
}

function projectDir() {
  return process.env.DRIFT_APP || path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))))
}

async function launch() {
  const dir = projectDir()
  const electron = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  const child = spawn(electron, [dir], { detached: true, stdio: 'ignore', cwd: dir, env: process.env })
  child.unref()
  const until = Date.now() + 10000
  while (Date.now() < until) {
    try {
      return await connect()
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  throw new Error(`Drift did not open its socket within 10s (${SOCK})`)
}

// --- output ---

const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s)
const cut = (s, n) => {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function table(rows, cols) {
  if (!rows.length) return dim('(none)')
  const cells = rows.map((r) => cols.map(([, f]) => String(f(r) ?? '')))
  const heads = cols.map(([h]) => h)
  const w = heads.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(w[i]))).join('  ').trimEnd()
  return [dim(line(heads)), ...cells.map(line)].join('\n')
}

const mb = (v) => (v == null ? '' : `${Math.round(v)}M`)
const tabFlags = (t) => [t.active && 'active', t.visible && !t.active && 'shown', t.sleeping && 'zz'].filter(Boolean).join(',')

function generic(v) {
  if (v == null) return 'ok'
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v)) {
    if (!v.length) return dim('(none)')
    if (v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const keys = [...new Set(v.flatMap((x) => Object.keys(x).filter((k) => x[k] == null || typeof x[k] !== 'object')))]
      return table(v, keys.map((k) => [k.toUpperCase(), (r) => cut(r[k], 60)]))
    }
    return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n')
  }
  const keys = Object.keys(v)
  const w = Math.max(...keys.map((k) => k.length))
  return keys.map((k) => `${dim(k.padEnd(w))}  ${typeof v[k] === 'object' && v[k] !== null ? JSON.stringify(v[k]) : v[k]}`).join('\n')
}

function render(kind, v, flags) {
  if (kind === 'tabs' && Array.isArray(v))
    return table(v, [
      ['ID', (t) => t.id],
      ['WS', (t) => cut(t.workspace, 14)],
      ['TITLE', (t) => cut(t.title, 44)],
      ['MEM', (t) => mb(t.memoryMB)],
      ['STATE', tabFlags],
      ['URL', (t) => cut(t.url, 70)],
    ])
  if (kind === 'stats' && v && Array.isArray(v.tabs))
    return [
      `total ${mb(v.totalMB)}   blocked ${v.blocked ?? 0}`,
      table(v.tabs, [
        ['ID', (t) => t.id],
        ['MEM', (t) => mb(t.memoryMB)],
        ['CPU', (t) => (t.cpu == null ? '' : `${Number(t.cpu).toFixed(1)}%`)],
        ['STATE', (t) => (t.sleeping ? 'zz' : '')],
        ['TITLE', (t) => cut(t.title, 60)],
      ]),
    ].join('\n')
  if (kind === 'shot' && v && v.$b64) {
    const out = path.resolve(flags['-o'] || flags['--out'] || `drift-${Date.now()}.png`)
    fs.writeFileSync(out, Buffer.from(v.$b64, 'base64'))
    return out
  }
  return generic(v)
}

// --- main ---

async function main() {
  const { pos, flags } = parse(process.argv.slice(2))
  const [cmd = 'help', ...rest] = pos
  const json = !!flags['--json']

  if (cmd === 'help' || flags['--help'] || flags['-h']) {
    let server = []
    try {
      const c = await connect()
      server = await request(c, 'help', {})
      c.end()
    } catch {}
    if (json) return console.log(JSON.stringify(server, null, 2))
    console.log(USAGE)
    if (server.length) {
      console.log('\nServer methods (drift raw <method> [json]):')
      console.log(table(server, [['METHOD', (m) => m.name], ['ARGS', (m) => m.args], ['HELP', (m) => m.help]]))
    }
    return
  }

  let c
  try {
    c = await connect()
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') throw e
    if (cmd !== 'open' && cmd !== 'launch') throw new Error(`Drift is not running (no socket at ${SOCK}). Start it with: drift launch`)
    // A custom socket means a test or second profile; launching here would open the default profile instead.
    if (process.env.DRIFT_SOCKET && !process.env.DRIFT_PROFILE) throw new Error(`Drift is not running at ${SOCK}; set DRIFT_PROFILE to launch a separate profile`)
    c = await launch()
  }
  if (cmd === 'launch') {
    c.end()
    return console.log(json ? JSON.stringify({ socket: SOCK }) : `drift running (${SOCK})`)
  }

  const [method, params, kind] = await route(cmd, rest, flags)
  const result = await request(c, method, params)
  c.end()
  if (json && kind !== 'shot') return console.log(JSON.stringify(result, null, 2))
  const out = render(kind, result, flags)
  console.log(json ? JSON.stringify({ path: out }) : out)
}

main().catch((e) => {
  process.stderr.write(`drift: ${e.message}\n`)
  process.exit(1)
})
