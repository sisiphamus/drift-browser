import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { startDrift, fixtures, until, cleanup, type Drift } from './harness'

const ROOT = resolve(__dirname, '../..')
let site: Awaited<ReturnType<typeof fixtures>>
let d: Drift
let mcp: ChildProcess
let nextId = 1
const pending = new Map<number, (m: { result?: any; error?: { message: string } }) => void>()

function call(method: string, params: Record<string, unknown> = {}) {
  const id = nextId++
  return new Promise<any>((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call('tools/call', { name, arguments: args })
  if (r.isError) throw new Error(r.content[0].text)
  if (r.content[0].type !== 'text') return r.content[0]
  try {
    return JSON.parse(r.content[0].text)
  } catch {
    return r.content[0].text
  }
}

type Tab = { id: string; workspace: string; visible: boolean; active: boolean }
type State = { agentRuns: { id: string; prompt: string; status: string; steps: string[]; result: string | null }[]; workspaces: { name: string; agent: boolean }[] }
const state = () => d.rpc<State>('debug.uiEval', { js: 'window.drift.state()' })

beforeAll(async () => {
  site = await fixtures()
  process.env.DRIFT_CLAUDE = join(ROOT, 'test/e2e/bin/fake-claude.mjs')
  d = await startDrift()
  mcp = spawn('node', [join(ROOT, 'bin/drift-mcp.mjs')], { env: { ...process.env, DRIFT_SOCKET: join(d.profile, 'drift.sock') }, stdio: ['pipe', 'pipe', 'inherit'] })
  createInterface({ input: mcp.stdout! }).on('line', (l) => {
    const m = JSON.parse(l)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
})
afterAll(async () => {
  mcp?.kill()
  await site.close()
  await d.stop()
  cleanup(d.profile)
})

describe('Drift MCP server', () => {
  it('speaks MCP and lists the drift tools', async () => {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } })
    expect(init.serverInfo.name).toBe('drift')
    const { tools } = await call('tools/list')
    expect(tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['drift_open', 'drift_read', 'drift_click', 'drift_type', 'drift_screenshot']))
  })

  it('opens pages in the Agent space without taking the user’s view', async () => {
    const mine = await d.rpc<{ id: string }>('tabs.open', { url: site.url('/c') })
    await until(async () => (await d.rpc<string>('page.url')).endsWith('/c'), 'user tab')
    const opened = await tool('drift_open', { url: site.url('/a') })
    expect(opened.title).toBe('Page A')
    expect(opened.space).not.toBe('Home')
    const tabs = await d.rpc<Tab[]>('tabs.list', { all: true })
    expect(tabs.find((t) => t.id === mine.id)!.visible).toBe(true)
    expect(tabs.find((t) => t.id === opened.tab)!.visible).toBe(false)
    expect((await state()).workspaces.find((w) => w.agent)?.name).toBe('Agent')
  })

  it('reads and clicks in the background tab', async () => {
    expect(JSON.stringify(await tool('drift_read'))).toContain('alpha')
    await tool('drift_click', { target: '#next' })
    await until(async () => JSON.stringify(await tool('drift_read')).includes('bravo'), 'navigated to b')
    const shot = await tool('drift_screenshot')
    expect(shot.type).toBe('image')
    expect(shot.data.length).toBeGreaterThan(1000)
    expect((await d.rpc<string>('page.url')).endsWith('/c')).toBe(true) // the user never moved
  })

  it('runs page timers at full speed in a background agent tab, without moving the user', async () => {
    // Chromium slows timers in hidden tabs to about one per second; an agent's page script must not crawl.
    const ms = await d.rpc<number>('page.eval', {
      tab: (await tool('drift_tabs')).find((t: { url: string }) => t.url.endsWith('/b')).id,
      js: 'new Promise((r) => { const t = performance.now(); let n = 0; const tick = () => (++n < 20 ? setTimeout(tick, 0) : r(Math.round(performance.now() - t))); tick() })',
    })
    expect(ms).toBeLessThan(1000)
    expect((await d.rpc<string>('page.url')).endsWith('/c')).toBe(true)
  })

  it('marks tabs an agent is working in', async () => {
    const tabs = await d.rpc<{ id: string; agent: boolean }[]>('debug.uiEval', { js: 'window.drift.state().then((s) => s.workspaces.flatMap((w) => w.tabs))' })
    expect(tabs.filter((t) => t.agent).length).toBe(1)
  })

  it('reuses one Agent space', async () => {
    await tool('drift_open', { url: site.url('/c') })
    expect((await state()).workspaces.filter((w) => w.agent).length).toBe(1)
  })
})

describe('Ask Claude', () => {
  it('streams a run’s steps and result to the sidebar', async () => {
    const { id } = await d.rpc<{ id: string }>('agent.ask', { prompt: 'summarize this' })
    await until(async () => (await state()).agentRuns.find((r) => r.id === id)?.status === 'done', 'run done')
    const run = (await state()).agentRuns.find((r) => r.id === id)!
    expect(run.steps).toEqual(['Opening example.com', 'Reading the page'])
    expect(run.result).toBe('Did: summarize this')
    await d.rpc('agent.dismiss', { id })
    expect((await state()).agentRuns.find((r) => r.id === id)).toBeUndefined()
  })

  it('stops a run', async () => {
    const { id } = await d.rpc<{ id: string }>('agent.ask', { prompt: 'hang' })
    await until(async () => (await state()).agentRuns.find((r) => r.id === id)?.steps.length === 2, 'run going')
    await d.rpc('agent.stop', { id })
    await until(async () => (await state()).agentRuns.find((r) => r.id === id)?.status === 'stopped', 'stopped')
  })

  it('rejects an empty task', async () => {
    await expect(d.rpc('agent.ask', { prompt: '  ' })).rejects.toThrow('empty task')
  })
})
