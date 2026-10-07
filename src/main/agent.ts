// "Ask Claude": runs Claude Code headless with only Drift's MCP tools, and streams its steps to the sidebar.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type StreamEvent = { kind: 'step'; text: string } | { kind: 'result'; text: string; ok: boolean }
export type AgentRun = {
  id: string
  prompt: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  steps: string[]
  result: string | null
  started: number
}

const host = (url: unknown) => {
  try {
    return new URL(String(url)).host.replace(/^www\./, '')
  } catch {
    return String(url ?? '')
  }
}

/** Plain words for a tool call, shown as the run's current step. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const tool = name.replace(/^mcp__drift__/, '').replace(/^mcp__[^_]+__/, '')
  const label = (t: unknown) => String(t ?? '').replace(/^text:/, '')
  switch (tool) {
    case 'drift_open': return `Opening ${host(input.url) || input.url}`
    case 'drift_go': return input.url ? `Going to ${host(input.url)}` : `Going ${input.action ?? 'reload'}`
    case 'drift_read': return 'Reading the page'
    case 'drift_screenshot': return 'Looking at the page'
    case 'drift_click': return `Clicking “${label(input.target)}”`
    case 'drift_type': return `Typing into ${input.selector}`
    case 'drift_wait': return `Waiting for “${label(input.target)}”`
    case 'drift_scroll': return 'Scrolling'
    case 'drift_eval': return 'Running a script on the page'
    case 'drift_tabs': return 'Checking open tabs'
    case 'drift_use_tab': return 'Switching tabs'
    case 'drift_show': return 'Showing you the result'
    case 'drift_close': return 'Closing a tab'
    default: return `Using ${tool.replace(/^drift_/, '')}`
  }
}

/** The sidebar shows plain text: drop markdown emphasis, code ticks, headings and list bullets. */
export function plain(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .trim()
}

// Claude Code's own housekeeping, not something the user needs to watch.
const HIDDEN_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])

/** One line of `claude --output-format stream-json` into the events the sidebar shows. */
export function parseStreamLine(line: string): StreamEvent[] {
  let msg: { type?: string; subtype?: string; is_error?: boolean; result?: string; message?: { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] } }
  try {
    msg = JSON.parse(line)
  } catch {
    return []
  }
  if (msg.type === 'assistant') {
    const out: StreamEvent[] = []
    for (const c of msg.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'step', text: plain(c.text) })
      if (c.type === 'tool_use' && c.name && !HIDDEN_TOOLS.has(c.name)) out.push({ kind: 'step', text: describeTool(c.name, c.input ?? {}) })
    }
    return out
  }
  if (msg.type === 'result') {
    const ok = !msg.is_error && msg.subtype === 'success'
    return [{ kind: 'result', text: plain(msg.result ?? '') || `Stopped: ${msg.subtype ?? 'unknown'}`, ok }]
  }
  return []
}

function claudeBinary(): string {
  if (process.env.DRIFT_CLAUDE) return process.env.DRIFT_CLAUDE
  const local = join(homedir(), '.local/bin/claude')
  return existsSync(local) ? local : 'claude'
}

export class Agents {
  runs: AgentRun[] = []
  private procs = new Map<string, ChildProcess>()

  constructor(private opts: { userData: string; mcpScript: string; socket: string; onChange: () => void }) {}

  start(prompt: string, context: { tab: string | null; title: string; url: string }): AgentRun {
    const cfg = join(this.opts.userData, 'agent-mcp.json')
    writeFileSync(cfg, JSON.stringify({ mcpServers: { drift: { command: 'node', args: [this.opts.mcpScript], env: { DRIFT_SOCKET: this.opts.socket } } } }))
    const system = [
      'You are operating Drift, the user’s web browser, through the drift_* tools. They use the user’s real logins.',
      'Work in the Agent space (drift_open’s default) so the user is not interrupted, unless the task is about the page they are on.',
      'Never move the user’s view: do not call drift_show unless the task asks to show them something. Say which tab holds the result instead.',
      context.tab ? `The page the user is looking at: tab ${context.tab}, “${context.title}”, ${context.url}. Use drift_use_tab with that id to work on it.` : '',
      'Assume the user is away from the computer: finish the task yourself instead of handing it back. Read text CAPTCHAs from the image, sign drawn-signature fields on forms the task asks you to complete, find why a form will not submit (check each field with checkValidity and fix the format), and confirm the site actually accepted it.',
      'Stop only for a code from the user’s phone, a puzzle CAPTCHA that needs a human, or bank or card numbers you were not given; leave everything else filled so their part is one action.',
      'Never close the user’s own tabs. Do not make payments or send messages to people unless the task explicitly asks.',
      'Finish with a two-sentence summary, in plain text without markdown, of what you did and anything the user still needs to do.',
    ].filter(Boolean).join(' ')
    const run: AgentRun = { id: randomUUID().slice(0, 8), prompt, status: 'running', steps: [], result: null, started: Date.now() }
    this.runs.unshift(run)
    this.runs = this.runs.slice(0, 5)
    const child = spawn(
      claudeBinary(),
      ['-p', prompt, '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__drift', '--append-system-prompt', system, '--output-format', 'stream-json', '--verbose'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    )
    this.procs.set(run.id, child)
    let buf = ''
    child.stdout!.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        for (const ev of parseStreamLine(buf.slice(0, nl))) {
          if (ev.kind === 'step') run.steps = [...run.steps, ev.text].slice(-6)
          else {
            run.result = ev.text
            run.status = ev.ok ? 'done' : 'failed'
          }
        }
        buf = buf.slice(nl + 1)
        this.opts.onChange()
      }
    })
    let err = ''
    child.stderr!.on('data', (d) => (err += d))
    child.on('error', (e) => {
      run.status = 'failed'
      run.result = `Couldn't start Claude Code: ${e.message}`
      this.opts.onChange()
    })
    child.on('exit', (code) => {
      this.procs.delete(run.id)
      if (run.status === 'running') {
        run.status = code === 0 ? 'done' : 'failed'
        run.result ??= err.trim().split('\n').slice(-2).join(' ') || `Claude Code exited with code ${code}`
      }
      this.opts.onChange()
    })
    this.opts.onChange()
    return run
  }

  stop(id: string) {
    const run = this.runs.find((r) => r.id === id)
    this.procs.get(id)?.kill('SIGTERM')
    if (run && run.status === 'running') run.status = 'stopped'
    this.opts.onChange()
  }

  dismiss(id: string) {
    this.stop(id)
    this.runs = this.runs.filter((r) => r.id !== id)
    this.opts.onChange()
  }

  stopAll() {
    for (const p of this.procs.values()) p.kill('SIGTERM')
  }
}
