// Unix socket front door for the CLI. Newline-delimited JSON, one request per line.

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Rpc } from './rpc'

export function defaultSocketPath(): string {
  return process.env.DRIFT_SOCKET || path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'drift.sock')
}

// True if something answers on the path; a dead file means a crashed previous run.
function alive(p: string): Promise<boolean> {
  return new Promise((res) => {
    const c = net.createConnection(p)
    c.once('connect', () => (c.end(), res(true)))
    c.once('error', () => res(false))
  })
}

async function dispatch(rpc: Rpc, line: string): Promise<string> {
  let req: { id?: unknown; method?: unknown; params?: unknown }
  try {
    req = JSON.parse(line)
  } catch {
    return JSON.stringify({ id: null, error: 'bad request: invalid json' })
  }
  const id = req.id ?? null
  if (typeof req.method !== 'string') return JSON.stringify({ id, error: 'bad request: method required' })
  try {
    const params = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {}
    const result = req.method === 'help' && !rpc.has('help') ? rpc.list() : await rpc.call(req.method, params)
    return JSON.stringify({ id, result: result ?? null })
  } catch (e) {
    if (process.env.DRIFT_DEBUG) console.warn('[drift] rpc', req.method, e instanceof Error ? e.stack : e)
    return JSON.stringify({ id, error: e instanceof Error ? e.message : String(e) })
  }
}

export async function startSocket(rpc: Rpc, p = defaultSocketPath()) {
  if (fs.existsSync(p)) {
    if (await alive(p)) throw new Error(`drift already running on ${p}`)
    fs.rmSync(p, { force: true })
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })

  const conns = new Set<net.Socket>()
  const server = net.createServer((c) => {
    conns.add(c)
    c.on('close', () => conns.delete(c))
    c.on('error', () => {})
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        // Concurrent: each line resolves on its own, replies may come back out of order.
        void dispatch(rpc, line).then((out) => {
          if (!c.destroyed) c.write(out + '\n')
        })
      }
    })
  })

  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(p, () => (server.off('error', rej), res()))
  })
  fs.chmodSync(p, 0o600)

  return {
    path: p,
    close: () =>
      new Promise<void>((res) => {
        for (const c of conns) c.destroy()
        server.close(() => {
          fs.rmSync(p, { force: true })
          res()
        })
      }),
  }
}
