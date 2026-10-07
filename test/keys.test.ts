import { describe, it, expect } from 'vitest'
import { matchShortcut, KeyInput } from '../src/main/keys'

const k = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  type: 'keyDown', key, code: '', control: false, shift: false, alt: false, meta: false, ...mods,
})

describe('matchShortcut', () => {
  it.each<[KeyInput, string]>([
    [k('t', { control: true }), 'bar.new'],
    [k('l', { control: true }), 'bar.edit'],
    [k('F6'), 'bar.edit'],
    [k('w', { control: true }), 'tab.close'],
    [k('T', { control: true, shift: true }), 'tab.reopen'],
    [k('Tab', { control: true }), 'tab.next'],
    [k('Tab', { control: true, shift: true }), 'tab.prev'],
    [k('PageDown', { control: true }), 'tab.next'],
    [k('3', { control: true }), 'tab.index:2'],
    [k('9', { control: true }), 'tab.last'],
    [k('r', { control: true }), 'page.reload'],
    [k('R', { control: true, shift: true }), 'page.hardReload'],
    [k('F5'), 'page.reload'],
    [k('ArrowLeft', { alt: true }), 'page.back'],
    [k('ArrowRight', { alt: true }), 'page.forward'],
    [k('f', { control: true }), 'find.open'],
    [k('=', { control: true }), 'zoom.in'],
    [k('+', { control: true, shift: true }), 'zoom.in'],
    [k('-', { control: true }), 'zoom.out'],
    [k('0', { control: true }), 'zoom.reset'],
    [k('F12'), 'devtools'],
    [k('I', { control: true, shift: true }), 'devtools'],
    [k('d', { control: true }), 'bookmark'],
    [k('B', { control: true, shift: true }), 'sidebar.toggle'],
    [k('ArrowRight', { control: true, alt: true }), 'ws.next'],
    [k('ArrowLeft', { control: true, alt: true }), 'ws.prev'],
    [k('2', { alt: true }), 'ws.index:1'],
    [k('M', { control: true, shift: true }), 'memory'],
    [k('\\', { control: true, alt: true }), 'split.recent'],
    [k('u', { control: true, alt: true }), 'split.clear'],
    [k(',', { control: true }), 'settings'],
    [k('Escape'), 'escape'],
  ])('%o -> %s', (input, action) => expect(matchShortcut(input)).toBe(action))

  it('ignores plain typing and key-up events', () => {
    expect(matchShortcut(k('t'))).toBeNull()
    expect(matchShortcut(k('b', { control: true }))).toBeNull()
    expect(matchShortcut(k('U', { control: true, shift: true }))).toBeNull()
    expect(matchShortcut({ ...k('t', { control: true }), type: 'keyUp' })).toBeNull()
  })
})
