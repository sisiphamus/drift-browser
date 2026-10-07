#!/usr/bin/env node
// Stands in for `claude -p` in e2e: streams two steps and a result in Claude Code's stream-json shape.
const prompt = process.argv[process.argv.indexOf('-p') + 1]
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
out({ type: 'system', subtype: 'init' })
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__drift__drift_open', input: { url: 'https://example.com' } }] } })
setTimeout(() => {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__drift__drift_read', input: {} }] } })
  if (prompt === 'hang') return setTimeout(() => {}, 60_000)
  out({ type: 'result', subtype: 'success', is_error: false, result: `Did: ${prompt}` })
}, 300)
