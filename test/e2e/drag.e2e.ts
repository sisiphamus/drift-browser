import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startDrift, fixtures, until, cleanup, type Drift } from './harness'

let site: Awaited<ReturnType<typeof fixtures>>
let d: Drift

type Info = { id: string; title: string }
type State = { essentials: Info[]; workspaces: { id: string; tabs: Info[] }[]; activeWorkspaceId: string }
const state = () => d.rpc<State>('debug.uiEval', { js: 'window.drift.state()' })
const titles = async () => {
  const s = await state()
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!.tabs.map((t) => t.title)
}
const pins = async () => (await state()).essentials.map((t) => t.title)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Centre of the first element matching a selector in the browser UI. */
async function at(selector: string): Promise<{ x: number; y: number; w: number; h: number }> {
  return until(
    () =>
      d.rpc<{ x: number; y: number; w: number; h: number } | null>('debug.uiEval', {
        js: `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } })()`,
      }),
    selector,
  )
}

/** A real mouse drag through the UI: press, move in steps (past the 6px threshold), release. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  const ev = (type: string, x: number, y: number) =>
    d.rpc('debug.uiInput', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  await ev('mouseMove', from.x, from.y)
  await ev('mouseDown', from.x, from.y)
  for (let i = 1; i <= 8; i++) {
    await ev('mouseMove', from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8)
    await sleep(30)
  }
  await sleep(250) // the drag freezes pages and re-renders targets
  await ev('mouseMove', to.x, to.y)
  await sleep(100)
  await ev('mouseUp', to.x, to.y)
  await sleep(500)
}

beforeAll(async () => {
  site = await fixtures()
  d = await startDrift({ settings: { sidebarPinned: true } })
  for (const p of ['/a', '/b', '/c']) await d.rpc('tabs.open', { url: site.url(p) })
  await until(async () => (await titles()).join() === 'Page A,Page B,Page C', 'three tabs')
})
afterAll(async () => {
  await site.close()
  await d.stop()
  cleanup(d.profile)
})

const row = (n: number) => `[data-tablist] [data-index="${n}"]`

describe('dragging tabs in the sidebar', () => {
  it('moves a tab down below another', async () => {
    const a = await at(row(0))
    const c = await at(row(2))
    await drag(a, { x: c.x, y: c.y + c.h * 0.4 })
    await until(async () => (await titles()).join() === 'Page B,Page C,Page A', 'A at the bottom')
  })

  it('moves a tab up above another', async () => {
    const a = await at(row(2))
    const b = await at(row(0))
    await drag(a, { x: b.x, y: b.y - b.h * 0.4 })
    await until(async () => (await titles()).join() === 'Page A,Page B,Page C', 'A back on top')
  })

  it('pins a tab by dropping it on the pinned row, at the slot it was dropped on', async () => {
    await d.rpc('tabs.essential', { tab: (await state()).workspaces[0].tabs[2].id, on: true }) // C
    await until(async () => (await pins()).join() === 'Page C', 'C pinned')
    const c = await at('[data-pin="0"]')
    const a = await at(row(0))
    await drag(a, { x: c.x - c.w * 0.4, y: c.y })
    await until(async () => (await pins()).join() === 'Page A,Page C', 'A pinned before C')
    expect(await titles()).toEqual(['Page B'])
  })

  it('reorders pinned tabs', async () => {
    const first = await at('[data-pin="0"]')
    const second = await at('[data-pin="1"]')
    await drag(first, { x: second.x + second.w * 0.4, y: second.y })
    await until(async () => (await pins()).join() === 'Page C,Page A', 'pins swapped')
  })

  it('unpins a tab by dragging it back into the list', async () => {
    const pin = await at('[data-pin="0"]')
    const b = await at(row(0))
    await drag(pin, { x: b.x, y: b.y + b.h * 0.4 })
    await until(async () => (await titles()).join() === 'Page B,Page C', 'C back in the list')
    expect(await pins()).toEqual(['Page A'])
  })

  it('reorders in the tucked sidebar too, and the sidebar stays usable after the drop', async () => {
    await d.rpc('settings.set', { sidebarPinned: false })
    await sleep(400)
    const open = async () => {
      await d.rpc('debug.uiInput', { type: 'mouseMove', x: 300, y: 300 })
      await d.rpc('debug.uiInput', { type: 'mouseMove', x: 2, y: 300 })
      await until(() => d.rpc<boolean>('debug.uiEval', { js: "!!document.querySelector('.sidebar.floating [data-index]')" }), 'tucked sidebar out')
      await sleep(400) // slide-in
    }
    await open()
    expect(await titles()).toEqual(['Page B', 'Page C'])
    const b = await at(row(0))
    const c = await at(row(1))
    await drag(b, { x: c.x, y: c.y + c.h * 0.4 })
    await until(async () => (await titles()).join() === 'Page C,Page B', 'B below C')
    expect(await d.rpc<boolean>('debug.uiOnTop')).toBe(true) // still showing, not hidden behind the page
  })
})
