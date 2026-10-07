import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Rpc } from '../src/main/rpc'
import { startSocket } from '../src/main/socket'

const BIN = path.resolve(__dirname, '../bin/drift.mjs')

// Echoes every call back as {method, params}; a few methods return shaped data.
class FakeRpc extends Rpc {
  async call(method: string, params: Record<string, unknown> = {}) {
    if (method === 'fail') throw new Error('kaboom')
    if (method === 'page.screenshot') return { $b64: Buffer.from('\x89PNGfake', 'latin1').toString('base64') }
    if (method === 'tabs.list')
      return [
        { id: 't1', title: 'Hello', url: 'https://a.com', workspace: 'main', active: true, visible: true, sleeping: false, memoryMB: 120 },
        { id: 't22', title: 'World', url: 'https://b.com', workspace: 'main', active: false, visible: false, sleeping: true, memoryMB: 0 },
      ]
    if (method === 'page.text') return 'plain page text'
    return { method, params }
  }
}

let dir: string
let sock: string
let server: Awaited<ReturnType<typeof startSocket>>

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-cli-'))
  sock = path.join(dir, 'drift.sock')
  server = await startSocket(new FakeRpc(), sock)
})
afterAll(async () => {
  await server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFile(process.execPath, [BIN, ...args], { cwd: dir, env: { ...process.env, DRIFT_SOCKET: sock, ...env } }, (err, stdout, stderr) =>
      res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    )
  })
}

async function call(...args: string[]) {
  const r = await run(['--json', ...args])
  expect(r.stderr).toBe('')
  return JSON.parse(r.stdout)
}

describe('drift cli', () => {
  it.each([
    [['open', 'example.com', '--bg', '--ws', 'work', '--split', 'right'], 'tabs.open', { url: 'example.com', background: true, workspace: 'work', split: 'right' }],
    [['open', 'rust', 'lifetimes'], 'tabs.open', { url: 'rust lifetimes', background: false }],
    [['focus', '@3'], 'tabs.focus', { tab: '@3' }],
    [['close', 't1', 't2'], 'tabs.close', { tabs: ['t1', 't2'] }],
    [['close'], 'tabs.close', { tabs: ['active'] }],
    [['reload'], 'tabs.reload', { tab: 'active' }],
    [['back', 't9'], 'tabs.back', { tab: 't9' }],
    [['ws'], 'ws.list', {}],
    [['ws', 'new', 'research'], 'ws.create', { name: 'research' }],
    [['ws', 'go', 'next'], 'ws.switch', { target: 'next' }],
    [['ws', 'rm', 'old'], 'ws.remove', { target: 'old' }],
    [['ws', 'rename', 'old', 'new'], 'ws.rename', { target: 'old', name: 'new' }],
    [['split', 't1', 't2', 'bottom'], 'split.add', { target: 't1', tab: 't2', side: 'bottom' }],
    [['split', 't1', 't2'], 'split.add', { target: 't1', tab: 't2', side: 'right' }],
    [['unsplit', 't2'], 'split.remove', { tab: 't2' }],
    [['md'], 'page.markdown', { tab: 'active' }],
    [['html', '@2'], 'page.html', { tab: '@2' }],
    [['url'], 'page.url', { tab: 'active' }],
    [['click', 't1', 'text:Sign in'], 'page.click', { tab: 't1', target: 'text:Sign in' }],
    [['click', '#go'], 'page.click', { tab: 'active', target: '#go' }],
    [['type', 't1', 'input[name=q]', 'hello world', '--submit'], 'page.type', { tab: 't1', selector: 'input[name=q]', text: 'hello world', submit: true }],
    [['eval', 't1', 'document.title'], 'page.eval', { tab: 't1', js: 'document.title' }],
    [['wait', 't1', '.done', '--timeout', '500'], 'page.wait', { tab: 't1', target: '.done', timeout: 500 }],
    [['scroll', 't1', 'bottom'], 'page.scroll', { tab: 't1', to: 'bottom' }],
    [['scroll', 't1', '-300'], 'page.scroll', { tab: 't1', to: -300 }],
    [['stats'], 'stats', {}],
    [['sleep', 'all-idle'], 'tabs.sleep', { tab: 'all-idle' }],
    [['wake', 't1'], 'tabs.wake', { tab: 't1' }],
    [['adblock', 'off'], 'adblock.set', { enabled: false }],
    [['adblock'], 'adblock.status', {}],
    [['import', 'brave', '--cookies'], 'import.brave', { cookies: true, passwords: true }],
    [['import', 'brave', '--logins-only'], 'import.brave', { loginsOnly: true }],
    [['import', 'zen'], 'import.zen', {}],
    [['import', 'zen', '--primary-password', 'pw'], 'import.zen', { primaryPassword: 'pw' }],
    [['ext', 'list'], 'ext.list', {}],
    [['ext', 'load', './ublock'], 'ext.load', {}],
    [['ext', 'rm', 'abc'], 'ext.remove', { id: 'abc' }],
    [['bookmark'], 'bookmarks.add', { tab: 'active' }],
    [['history', 'rust', 'book'], 'history.search', { q: 'rust book' }],
    [['raw', 'custom.thing', '{"a":1}'], 'custom.thing', { a: 1 }],
    [['ask', 'find', 'me', 'a', 'flight'], 'agent.ask', { prompt: 'find me a flight' }],
    [['agents'], 'agent.runs', {}],
    [['agents', 'stop', 'r1'], 'agent.stop', { id: 'r1' }],
    [['agents', 'dismiss', 'r1'], 'agent.dismiss', { id: 'r1' }],
  ])('%j -> %s', async (args, method, params) => {
    const r = await call(...(args as string[]))
    expect(r.method).toBe(method)
    if (method === 'ext.load') expect(r.params.path).toBe(path.join(dir, 'ublock'))
    else expect(r.params).toEqual(params)
  })

  it('prints tabs as an aligned table', async () => {
    const r = await run(['tabs'])
    expect(r.code).toBe(0)
    const lines = r.stdout.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^ID\s+WS\s+TITLE/)
    expect(lines).toHaveLength(3)
    expect(lines[1].indexOf('Hello')).toBe(lines[2].indexOf('World'))
    expect(r.stdout).not.toMatch(/\x1b\[/)
  })

  it('passes --all through for tabs', async () => {
    const r = await run(['tabs', '--all', '--json'])
    expect(JSON.parse(r.stdout)).toHaveLength(2)
  })

  it('prints strings raw', async () => {
    expect((await run(['text'])).stdout).toBe('plain page text\n')
  })

  it('writes screenshots to -o and prints the path', async () => {
    const r = await run(['shot', 't1', '-o', 'out.png', '--full'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe(path.join(dir, 'out.png'))
    expect(fs.readFileSync(path.join(dir, 'out.png')).subarray(0, 4).toString('latin1')).toBe('\x89PNG')
  })

  it('exits 1 with the error on stderr', async () => {
    const r = await run(['raw', 'fail'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/kaboom/)
  })

  it('errors on unknown commands and missing args', async () => {
    expect((await run(['frobnicate'])).code).toBe(1)
    const r = await run(['ws', 'new'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/usage/i)
  })

  it('says drift is not running when the socket is missing', async () => {
    const r = await run(['tabs'], { DRIFT_SOCKET: path.join(dir, 'nope.sock') })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/not running/)
  })

  it('help lists local usage', async () => {
    const r = await run(['help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/open <url\|query>/)
  })
})
