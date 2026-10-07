#!/usr/bin/env node
// Drift as an MCP server (stdio, zero dependencies). Agents browse in Drift's own "Agent" space by default,
// in the background, with the user's logins, without taking focus from whatever the user is doing.
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'

const SOCK = process.env.DRIFT_SOCKET || `${process.env.XDG_RUNTIME_DIR || tmpdir()}/drift.sock`
const MAX_READ = 40_000

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const c = createConnection(SOCK)
    let buf = ''
    c.on('error', (e) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error('Drift is not running. Ask the user to start it (drift launch).') : e))
    c.on('close', () => reject(new Error(`Drift closed the connection during ${method}`)))
    c.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      c.end()
      const msg = JSON.parse(buf.slice(0, nl))
      msg.error ? reject(new Error(msg.error)) : resolve(msg.result)
    })
    c.write(JSON.stringify({ id: 1, method, params }) + '\n')
  })
}

// The tab this agent is working in; tools default to it.
let current = null

async function target(args) {
  const tab = args.tab ?? current
  if (!tab) throw new Error('No tab yet: call drift_open first, or drift_use_tab to work in one of the user’s tabs.')
  await rpc('agent.touch', { tab }).catch(() => {})
  return tab
}

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] })
const tabArg = { tab: { type: 'string', description: 'Tab id from drift_tabs or drift_open. Defaults to the tab this agent last opened or chose.' } }

const tools = [
  {
    name: 'drift_open',
    description:
      'Open a URL (or a search) in Drift. By default it opens in the background in Drift’s Agent space, so the user is never interrupted, and it uses their logins and cookies. The new tab becomes the default for the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL, bare domain, or search text' },
        where: { type: 'string', enum: ['agent', 'current'], description: 'agent (default): the Agent space, in the background. current: the user’s current space, in front.' },
      },
      required: ['url'],
    },
    run: async ({ url, where = 'agent' }) => {
      const params = { url, background: where === 'agent' }
      if (where === 'agent') params.workspace = (await rpc('agent.space')).id
      const t = await rpc('tabs.open', params)
      current = t.id
      await rpc('agent.touch', { tab: t.id }).catch(() => {})
      await rpc('page.wait', { tab: t.id, target: 'body', timeout: 15000 }).catch(() => {})
      const loaded = (await rpc('tabs.list', { all: true })).find((x) => x.id === t.id)
      return text({ tab: t.id, title: loaded?.title, url: loaded?.url, space: loaded?.workspace })
    },
  },
  {
    name: 'drift_tabs',
    description: 'List open tabs (all spaces) with ids, titles, urls, which one the user is looking at, and which are asleep.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => text((await rpc('tabs.list', { all: true })).map(({ id, title, url, workspace, active, visible, sleeping }) => ({ id, title, url, space: workspace, userIsViewing: visible, active, sleeping }))),
  },
  {
    name: 'drift_use_tab',
    description: 'Make an existing tab the default for the other tools, e.g. the page the user is looking at ("active").',
    inputSchema: { type: 'object', properties: { tab: { type: 'string', description: 'Tab id, or "active" for the user’s current tab' } }, required: ['tab'] },
    run: async ({ tab }) => {
      const id = tab === 'active' ? (await rpc('tabs.list')).find((t) => t.active)?.id : tab
      if (!id) throw new Error('no such tab')
      current = id
      await rpc('agent.touch', { tab: id }).catch(() => {})
      return text({ tab: id })
    },
  },
  {
    name: 'drift_read',
    description: 'Read a page as Markdown (default), plain text, or HTML. Long pages are truncated.',
    inputSchema: { type: 'object', properties: { ...tabArg, format: { type: 'string', enum: ['markdown', 'text', 'html'] } } },
    run: async (args) => {
      const tab = await target(args)
      const method = { markdown: 'page.markdown', text: 'page.text', html: 'page.html' }[args.format ?? 'markdown']
      const [body, url] = await Promise.all([rpc(method, { tab }), rpc('page.url', { tab })])
      const cut = body.length > MAX_READ ? `${body.slice(0, MAX_READ)}\n\n[truncated: ${body.length - MAX_READ} more characters]` : body
      return text(`URL: ${url}\n\n${cut}`)
    },
  },
  {
    name: 'drift_screenshot',
    description: 'Screenshot a page (the visible viewport, or the full page).',
    inputSchema: { type: 'object', properties: { ...tabArg, full: { type: 'boolean' } } },
    run: async (args) => {
      const tab = await target(args)
      const shot = await rpc('page.screenshot', { tab, full: !!args.full })
      return { content: [{ type: 'image', data: shot.$b64, mimeType: 'image/png' }] }
    },
  },
  {
    name: 'drift_click',
    description: 'Click an element: a CSS selector, or text:Visible label (finds the smallest visible element containing it). Real mouse input; works while Drift is in the background.',
    inputSchema: { type: 'object', properties: { ...tabArg, target: { type: 'string' } }, required: ['target'] },
    run: async (args) => text(await rpc('page.click', { tab: await target(args), target: args.target })),
  },
  {
    name: 'drift_type',
    description: 'Type into a field (CSS selector), optionally pressing Enter. Appends to existing text.',
    inputSchema: { type: 'object', properties: { ...tabArg, selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['selector', 'text'] },
    run: async (args) => text(await rpc('page.type', { tab: await target(args), selector: args.selector, text: args.text, submit: !!args.submit })),
  },
  {
    name: 'drift_eval',
    description: 'Run JavaScript in the page and return its (JSON-serializable) result.',
    inputSchema: { type: 'object', properties: { ...tabArg, js: { type: 'string' } }, required: ['js'] },
    run: async (args) => text({ result: await rpc('page.eval', { tab: await target(args), js: args.js }) }),
  },
  {
    name: 'drift_wait',
    description: 'Wait for a CSS selector or text:Label to appear.',
    inputSchema: { type: 'object', properties: { ...tabArg, target: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['target'] },
    run: async (args) => text(await rpc('page.wait', { tab: await target(args), target: args.target, timeout: args.timeoutMs ?? 10000 })),
  },
  {
    name: 'drift_scroll',
    description: 'Scroll by a number of pixels (negative goes up), or to "top" / "bottom".',
    inputSchema: { type: 'object', properties: { ...tabArg, to: { type: ['number', 'string'] } }, required: ['to'] },
    run: async (args) => text(await rpc('page.scroll', { tab: await target(args), to: args.to })),
  },
  {
    name: 'drift_go',
    description: 'Navigate a tab: load a new URL, or go back, forward, or reload.',
    inputSchema: { type: 'object', properties: { ...tabArg, url: { type: 'string' }, action: { type: 'string', enum: ['back', 'forward', 'reload'] } } },
    run: async (args) => {
      const tab = await target(args)
      if (args.url) await rpc('tabs.navigate', { tab, url: args.url })
      else await rpc(`tabs.${args.action ?? 'reload'}`, { tab })
      await rpc('page.wait', { tab, target: 'body', timeout: 15000 }).catch(() => {})
      return text({ tab, url: await rpc('page.url', { tab }) })
    },
  },
  {
    name: 'drift_show',
    description: 'Bring a tab in front of the user. This switches their view away from what they are doing, so only use it when they explicitly asked to be shown something.',
    inputSchema: { type: 'object', properties: { ...tabArg } },
    run: async (args) => text(await rpc('tabs.focus', { tab: await target(args) })),
  },
  {
    name: 'drift_close',
    description: 'Close a tab the agent no longer needs.',
    inputSchema: { type: 'object', properties: { ...tabArg } },
    run: async (args) => {
      const tab = await target(args)
      await rpc('tabs.close', { tabs: [tab] })
      if (current === tab) current = null
      return text({ closed: tab })
    },
  },
]

const byName = new Map(tools.map((t) => [t.name, t]))
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function handle(req) {
  const { id, method, params } = req
  if (id === undefined) return // notifications
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'drift', version: '0.1.0' },
          instructions:
            'Drift is the user’s browser. Prefer these tools over other browser automation: they use the user’s real logins and work in a separate Agent space without stealing focus. Open pages with drift_open, read them with drift_read, act with drift_click/drift_type, and use drift_show only to hand a page back to the user.',
        },
      })
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: tools.map(({ run: _run, ...t }) => t) } })
    if (method === 'tools/call') {
      const tool = byName.get(params?.name)
      if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } })
      try {
        return send({ jsonrpc: '2.0', id, result: await tool.run(params.arguments ?? {}) })
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } })
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
  }
  void handle(req)
})
