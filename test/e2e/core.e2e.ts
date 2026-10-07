import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { cleanExit, startDrift, fixtures, until, cleanup, type Drift } from './harness'

type Row = { id: string; url: string; title: string; active: boolean; visible: boolean; sleeping: boolean; workspace: string }
let site: Awaited<ReturnType<typeof fixtures>>
let d: Drift

beforeAll(async () => {
  site = await fixtures()
  d = await startDrift()
})
afterAll(async () => {
  await site.close()
  await d.stop()
  cleanup(d.profile)
})

const tabs = () => d.rpc<Row[]>('tabs.list', { all: true })

describe('tabs and session', () => {
  it('opens, navigates, and reads pages', async () => {
    const a = await d.rpc<Row>('tabs.open', { url: site.url('/a') })
    await until(async () => (await d.rpc<string>('page.text', { tab: a.id })).includes('alpha'), 'page A text')
    await d.rpc('page.click', { tab: a.id, target: '#next' })
    await until(async () => (await d.rpc<string>('page.url', { tab: a.id })).endsWith('/b'), 'navigated to B')
    await d.rpc('tabs.back', { tab: a.id })
    await until(async () => (await d.rpc<string>('page.url', { tab: a.id })).endsWith('/a'), 'back to A')
  })

  it('opens in the background without stealing focus', async () => {
    const before = (await tabs()).find((t) => t.active)!
    const opened = await d.rpc<Row>('tabs.open', { url: site.url('/c'), background: true })
    expect(opened.active).toBe(false)
    await until(async () => (await d.rpc<string>('page.text', { tab: opened.id })).includes('charlie'), 'background page loaded')
    const after = (await tabs()).find((t) => t.active)!
    expect({ id: after.id, url: after.url }).toEqual({ id: before.id, url: before.url })
  })

  it('closes and reopens a tab', async () => {
    const c = (await tabs()).find((t) => t.url.endsWith('/c'))!
    await d.rpc('tabs.close', { tabs: [c.id] })
    expect((await tabs()).some((t) => t.id === c.id)).toBe(false)
    const r = await d.rpc<Row>('tabs.reopen')
    expect(r.url).toMatch(/\/c$/)
  })

  it('splits two tabs and unsplits them', async () => {
    const all = await tabs()
    const [x, y] = all
    await d.rpc('split.add', { target: x.id, tab: y.id, side: 'right' })
    await until(async () => (await tabs()).filter((t) => t.visible).length === 2, 'two visible panes')
    await d.rpc('split.remove', { tab: y.id })
    await until(async () => (await tabs()).filter((t) => t.visible).length === 1, 'one visible pane')
  })

  it('sleeps hidden tabs and wakes them where they were', async () => {
    const r = await d.rpc<{ slept: string[] }>('tabs.sleep', { tab: 'all-idle' })
    expect(r.slept.length).toBeGreaterThan(0)
    const id = r.slept[0]
    expect((await tabs()).find((t) => t.id === id)!.sleeping).toBe(true)
    await d.rpc('tabs.wake', { tab: id })
    const t = (await tabs()).find((x) => x.id === id)!
    expect(t.sleeping).toBe(false)
  })

  it('restores tabs and spaces after a restart, and quits cleanly', async () => {
    await d.rpc('ws.create', { name: 'Kept', switch: false })
    const before = (await tabs()).map((t) => t.url).sort()
    expect(cleanExit(await d.stop(), d.log())).toBe(true)
    d = await startDrift({ profile: d.profile })
    expect((await tabs()).map((t) => t.url).sort()).toEqual(before)
    expect((await d.rpc<{ name: string }[]>('ws.list')).map((w) => w.name)).toContain('Kept')
  })
})

describe('overlay', () => {
  // The tucked sidebar draws in the UI view, which must stay above the pages while the UI asks for it.
  const uiOnTop = () => d.rpc<boolean>('debug.uiOnTop')
  const ui = (js: string) => d.rpc('debug.uiEval', { js })

  it('keeps the UI raised after a tab drag ends while the sidebar is still out', async () => {
    await d.rpc('tabs.open', { url: site.url('/a') })
    await ui('window.drift.overlay(true); 1')
    await until(uiOnTop, 'ui raised')
    await ui('window.drift.freeze().then(() => window.drift.thaw()); 1')
    await new Promise((r) => setTimeout(r, 500))
    expect(await uiOnTop()).toBe(true)
    await ui('window.drift.overlay(false); 1')
    await until(async () => !(await uiOnTop()), 'ui lowered')
  })

  it('lowers the UI after a drag when nothing else needs it', async () => {
    await ui('window.drift.freeze().then(() => window.drift.thaw()); 1')
    await new Promise((r) => setTimeout(r, 500))
    expect(await uiOnTop()).toBe(false)
  })
})

describe('spaces', () => {
  it('creates, renames, recolors, moves and deletes', async () => {
    const ws = await d.rpc<{ id: string }>('ws.create', { name: 'Temp', switch: false })
    await d.rpc('ws.rename', { target: ws.id, name: 'Renamed' })
    await d.rpc('ws.setHue', { target: ws.id, hue: 145 })
    await d.rpc('ws.move', { target: ws.id, index: 0 })
    const list = await d.rpc<{ id: string; name: string; hue: number }[]>('ws.list')
    expect(list[0]).toMatchObject({ id: ws.id, name: 'Renamed', hue: 145 })
    await d.rpc('ws.remove', { target: ws.id })
    expect((await d.rpc<{ id: string }[]>('ws.list')).some((w) => w.id === ws.id)).toBe(false)
  })

  it('refuses to delete the last space', async () => {
    const list = await d.rpc<{ id: string }[]>('ws.list')
    for (const w of list.slice(1)) await d.rpc('ws.remove', { target: w.id })
    await expect(d.rpc('ws.remove', { target: list[0].id })).rejects.toThrow(/only workspace/)
  })

  it('keeps private spaces out of history and the saved session', async () => {
    await d.rpc('ws.create', { private: true })
    await d.rpc('tabs.open', { url: site.url('/b') + '?private-marker' })
    await until(async () => (await d.rpc<string>('page.text')).includes('bravo'), 'private page')
    const hist = await d.rpc<unknown[]>('history.search', { q: 'private-marker' })
    expect(hist).toHaveLength(0)
    expect(cleanExit(await d.stop(), d.log())).toBe(true)
    d = await startDrift({ profile: d.profile })
    expect((await tabs()).some((t) => t.url.includes('private-marker'))).toBe(false)
  })
})
