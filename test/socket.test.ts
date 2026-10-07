import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Rpc } from '../src/main/rpc'
import { startSocket, defaultSocketPath } from '../src/main/socket'

let dir: string
let sock: string

function client(p: string) {
  const c = net.createConnection(p)
  const pending = new Map<number, (v: unknown) => void>()
  let buf = ''
  c.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      pending.get(msg.id)?.(msg)
    }
  })
  let n = 0
  return {
    send: (method: string, params: unknown = {}) =>
      new Promise<any>((res) => {
        const id = ++n
        pending.set(id, res)
        c.write(JSON.stringify({ id, method, params }) + '\n')
      }),
    end: () => c.end(),
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-sock-'))
  sock = path.join(dir, 'drift.sock')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('socket', () => {
  it('round trips a call and sets mode 600', async () => {
    const rpc = new Rpc()
    rpc.register('echo', 'echo params', '', (p) => p)
    const s = await startSocket(rpc, sock)
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600)
    const c = client(sock)
    expect(await c.send('echo', { a: 1 })).toEqual({ id: 1, result: { a: 1 } })
    c.end()
    await s.close()
  })

  it('returns errors as messages', async () => {
    const rpc = new Rpc()
    rpc.register('boom', '', '', () => {
      throw new Error('nope')
    })
    const s = await startSocket(rpc, sock)
    const c = client(sock)
    expect(await c.send('boom')).toEqual({ id: 1, error: 'nope' })
    expect((await c.send('missing')).error).toMatch(/unknown command/)
    c.end()
    await s.close()
  })

  it('handles concurrent requests out of order', async () => {
    const rpc = new Rpc()
    rpc.register('wait', '', '', async (p) => {
      await new Promise((r) => setTimeout(r, p.ms as number))
      return p.ms
    })
    const s = await startSocket(rpc, sock)
    const c = client(sock)
    const order: number[] = []
    await Promise.all([
      c.send('wait', { ms: 60 }).then((r) => order.push(r.result)),
      c.send('wait', { ms: 5 }).then((r) => order.push(r.result)),
    ])
    expect(order).toEqual([5, 60])
    c.end()
    await s.close()
  })

  it('serves help from rpc.list', async () => {
    const rpc = new Rpc()
    rpc.register('tabs.list', 'list tabs', '[--all]', () => [])
    const s = await startSocket(rpc, sock)
    const c = client(sock)
    const r = await c.send('help')
    expect(r.result).toEqual([{ name: 'tabs.list', help: 'list tabs', args: '[--all]' }])
    c.end()
    await s.close()
  })

  it('replaces a stale socket file', async () => {
    fs.writeFileSync(sock, '')
    const rpc = new Rpc()
    rpc.register('ping', '', '', () => 'pong')
    const s = await startSocket(rpc, sock)
    const c = client(sock)
    expect((await c.send('ping')).result).toBe('pong')
    c.end()
    await s.close()
    expect(fs.existsSync(sock)).toBe(false)
  })

  it('refuses to start when another server is live', async () => {
    const s = await startSocket(new Rpc(), sock)
    await expect(startSocket(new Rpc(), sock)).rejects.toThrow(/already running/)
    await s.close()
  })

  it('reports bad json', async () => {
    const s = await startSocket(new Rpc(), sock)
    const c = net.createConnection(sock)
    const line = await new Promise<string>((res) => {
      c.on('data', (d) => res(d.toString()))
      c.write('not json\n')
    })
    expect(JSON.parse(line)).toEqual({ id: null, error: expect.stringMatching(/bad request/) })
    c.end()
    await s.close()
  })

  it('default path honours DRIFT_SOCKET then XDG_RUNTIME_DIR', () => {
    const old = { ...process.env }
    process.env.DRIFT_SOCKET = '/x/y.sock'
    expect(defaultSocketPath()).toBe('/x/y.sock')
    delete process.env.DRIFT_SOCKET
    process.env.XDG_RUNTIME_DIR = '/run/user/9'
    expect(defaultSocketPath()).toBe('/run/user/9/drift.sock')
    process.env = old
  })
})
