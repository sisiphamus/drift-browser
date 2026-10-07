import { describe, it, expect } from 'vitest'
import { parseStreamLine, describeTool } from '../src/main/agent'

describe('claude stream-json parsing', () => {
  it('turns assistant text into a step', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Opening the page now.' }] } })
    expect(parseStreamLine(line)).toEqual([{ kind: 'step', text: 'Opening the page now.' }])
  })

  it('describes tool calls in plain words', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__drift__drift_open', input: { url: 'https://example.com/a?b=1' } }] },
    })
    expect(parseStreamLine(line)).toEqual([{ kind: 'step', text: 'Opening example.com' }])
  })

  it('reports the final result and whether it succeeded', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done: filled the form.' }))).toEqual([
      { kind: 'result', text: 'Done: filled the form.', ok: true },
    ])
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }))).toEqual([
      { kind: 'result', text: 'Stopped: error_max_turns', ok: false },
    ])
  })

  it('ignores noise and junk', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([])
    expect(parseStreamLine('not json')).toEqual([])
  })

  it('has readable names for every drift tool', () => {
    expect(describeTool('mcp__drift__drift_click', { target: 'text:Sign in' })).toBe('Clicking “Sign in”')
    expect(describeTool('mcp__drift__drift_type', { selector: '#q', text: 'hello' })).toBe('Typing into #q')
    expect(describeTool('mcp__drift__drift_read', {})).toBe('Reading the page')
    expect(describeTool('mcp__other__thing', {})).toBe('Using thing')
  })

  it('hides Claude Code’s own housekeeping tools', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ToolSearch', input: {} }, { type: 'tool_use', name: 'mcp__drift__drift_read', input: {} }] } })
    expect(parseStreamLine(line)).toEqual([{ kind: 'step', text: 'Reading the page' }])
  })

  it('strips markdown from text the sidebar shows', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'The heading is **"Example Domain"**.\n\n- one\n`code`' })
    expect(parseStreamLine(line)).toEqual([{ kind: 'result', text: 'The heading is "Example Domain".\n\none\ncode', ok: true }])
  })
})
