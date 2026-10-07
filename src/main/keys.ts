// Chrome-style shortcuts, matched in before-input-event so they work while a page has focus.

export type KeyInput = {
  type: string
  key: string
  code: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

type Combo = { ctrl?: boolean; shift?: boolean; alt?: boolean }
const table: [Combo, string[], string][] = [
  [{ ctrl: true }, ['t'], 'bar.new'],
  [{ ctrl: true }, ['l'], 'bar.edit'],
  [{ alt: true }, ['d'], 'bar.edit'],
  [{}, ['F6'], 'bar.edit'],
  [{ ctrl: true }, ['w', 'F4'], 'tab.close'],
  [{ ctrl: true, shift: true }, ['t'], 'tab.reopen'],
  [{ ctrl: true }, ['Tab', 'PageDown'], 'tab.next'],
  [{ ctrl: true, shift: true }, ['Tab'], 'tab.prev'],
  [{ ctrl: true }, ['PageUp'], 'tab.prev'],
  [{ ctrl: true }, ['9'], 'tab.last'],
  [{ ctrl: true }, ['r'], 'page.reload'],
  [{}, ['F5'], 'page.reload'],
  [{ ctrl: true, shift: true }, ['r'], 'page.hardReload'],
  [{ shift: true }, ['F5'], 'page.hardReload'],
  [{ alt: true }, ['ArrowLeft'], 'page.back'],
  [{ alt: true }, ['ArrowRight'], 'page.forward'],
  [{ ctrl: true }, ['f'], 'find.open'],
  [{ ctrl: true }, ['=', '+'], 'zoom.in'],
  [{ ctrl: true, shift: true }, ['+', '='], 'zoom.in'],
  [{ ctrl: true }, ['-'], 'zoom.out'],
  [{ ctrl: true }, ['0'], 'zoom.reset'],
  [{}, ['F12'], 'devtools'],
  [{ ctrl: true, shift: true }, ['i'], 'devtools'],
  [{ ctrl: true }, ['d'], 'bookmark'],
  [{ ctrl: true, shift: true }, ['b'], 'sidebar.toggle'],
  [{ ctrl: true, alt: true }, ['ArrowRight'], 'ws.next'],
  [{ ctrl: true, alt: true }, ['ArrowLeft'], 'ws.prev'],
  [{ ctrl: true, shift: true }, ['m'], 'memory'],
  [{ ctrl: true, alt: true }, ['\\'], 'split.recent'],
  [{ ctrl: true, alt: true }, ['u'], 'split.clear'],
  [{ ctrl: true, shift: true }, ['q'], 'quit'],
  [{}, ['F11'], 'fullscreen'],
  [{ ctrl: true }, [','], 'settings'],
  [{}, ['Escape'], 'escape'],
]

export function matchShortcut(i: KeyInput): string | null {
  if (i.type !== 'keyDown' || i.meta) return null
  const key = i.key.length === 1 ? i.key.toLowerCase() : i.key
  if (i.control && !i.alt && !i.shift && /^[1-8]$/.test(key)) return `tab.index:${Number(key) - 1}`
  if (i.alt && !i.control && !i.shift && /^[1-9]$/.test(key)) return `ws.index:${Number(key) - 1}`
  for (const [c, keys, action] of table) {
    if (!!c.ctrl !== i.control || !!c.alt !== i.alt) continue
    // Shift is part of producing '+' on most layouts, so only enforce it when the combo names it.
    if (!!c.shift !== i.shift && key !== '+') continue
    if (keys.includes(key)) return action
  }
  return null
}
