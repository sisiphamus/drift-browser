import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { cleanExit, startDrift, fixtures, until, cleanup, type Drift } from './harness'

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

type State = {
  popup: { url: string } | null
  prompt: { id: string; permission: string } | null
  savePrompt: { id: string; username: string } | null
}
const state = () => d.rpc<State>('debug.uiEval', { js: 'window.drift.state()' })

describe('popups', () => {
  it('opens window.open popups as an in-window card that keeps its opener', async () => {
    await d.rpc('tabs.open', { url: site.url('/opener') })
    await until(async () => (await d.rpc<string>('page.url')).endsWith('/opener'), 'opener page')
    await d.rpc('page.eval', { js: 'window.openPopup(); 1' })
    await until(async () => (await state()).popup, 'popup card')
    await until(async () => (await d.rpc<string>('page.text', { tab: 'popup' })).includes('in popup'), 'popup content')
    expect(await d.rpc('page.eval', { tab: 'popup', js: '!!window.opener' })).toBe(true)
  })

  it('closes the card when the popup closes itself, after messaging its opener', async () => {
    await d.rpc('page.eval', { js: "window.__got = null; addEventListener('message', (e) => (window.__got = e.data)); 1" })
    await d.rpc('page.eval', { tab: 'popup', js: 'setTimeout(() => window.reply(), 50); 1' })
    await until(async () => !(await state()).popup, 'popup closed')
    expect(await d.rpc('page.eval', { js: 'window.__got' })).toBe('done')
  })

  it('quits cleanly with a popup open', async () => {
    await d.rpc('page.eval', { js: 'window.openPopup(); 1' })
    await until(async () => (await state()).popup, 'popup card')
    expect(cleanExit(await d.stop(), d.log())).toBe(true)
    d = await startDrift({ profile: d.profile })
  })
})

describe('permissions', () => {
  it('asks once for a burst of requests and remembers the answer across restarts', async () => {
    await d.rpc('tabs.open', { url: site.url('/a') })
    await until(async () => (await d.rpc<string>('page.text')).includes('alpha'), 'page')
    await d.rpc('page.eval', { js: "Notification.requestPermission().then(r => (window.__a = r)); Notification.requestPermission().then(r => (window.__b = r)); 1" })
    const p = await until(async () => (await state()).prompt, 'permission prompt')
    expect(p.permission).toBe('notifications')
    await d.rpc('prompt.answer', { id: p.id, ok: true })
    await until(async () => (await d.rpc('page.eval', { js: "window.__a + '/' + window.__b" })) === 'granted/granted', 'both granted')

    expect(cleanExit(await d.stop(), d.log())).toBe(true)
    d = await startDrift({ profile: d.profile })
    await d.rpc('tabs.open', { url: site.url('/a') })
    await until(async () => (await d.rpc<string>('page.text')).includes('alpha'), 'page after restart')
    expect(await d.rpc('page.eval', { js: 'Notification.permission' })).toBe('granted')
    expect((await state()).prompt).toBeNull()
  })

  it('resetting a decision makes the site ask again', async () => {
    await d.rpc('perm.reset', { origin: new URL(site.url('/')).origin, permission: 'notifications' })
    await d.rpc('page.eval', { js: 'Notification.requestPermission(); 1' })
    const p = await until(async () => (await state()).prompt, 'prompt again')
    await d.rpc('prompt.answer', { id: p.id, ok: false })
  })
})

describe('passwords', () => {
  it('offers to save a submitted login and stores it encrypted', async () => {
    await d.rpc('tabs.open', { url: site.url('/login') })
    await until(async () => (await d.rpc<string>('page.url')).endsWith('/login'), 'login page')
    await d.rpc('page.type', { selector: 'input[name=email]', text: 'e2e@example.test' })
    await d.rpc('page.type', { selector: 'input[name=password]', text: 'hunter2-e2e', submit: true })
    const sp = await until(async () => (await state()).savePrompt, 'save prompt')
    expect(sp.username).toBe('e2e@example.test')
    expect(await d.rpc('pw.answer', { id: sp.id, save: true })).toBe('added')
    const list = await d.rpc<{ origin: string; username: string }[]>('pw.list')
    expect(list).toEqual([expect.objectContaining({ username: 'e2e@example.test' })])
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(`${d.profile}/passwords.json`, 'utf8')).not.toContain('hunter2-e2e')
  })
})

describe('ad and tracker blocking', () => {
  type Row = { id: string; blocked: number }
  const blockedOn = async (id: string) => (await d.rpc<Row[]>('tabs.list', { all: true })).find((t) => t.id === id)?.blocked ?? 0

  it('blocks known trackers in a normal space', async () => {
    const t = await d.rpc<Row>('tabs.open', { url: site.url('/tracked') })
    await until(async () => (await blockedOn(t.id)) >= 1, 'tracker blocked', 20_000)
  })

  it('blocks them in a private space too', async () => {
    await d.rpc('ws.create', { private: true })
    const t = await d.rpc<Row>('tabs.open', { url: site.url('/tracked') })
    await until(async () => (await blockedOn(t.id)) >= 1, 'tracker blocked in private', 20_000)
    const list = await d.rpc<{ id: string }[]>('ws.list')
    await d.rpc('ws.switch', { target: list[0].id })
  })
})

describe('privacy', () => {
  it('strips tracking parameters from navigations', async () => {
    const t = await d.rpc<{ url: string }>('tabs.open', { url: site.url('/b') + '?utm_source=x&keep=1&fbclid=y' })
    expect(t.url).toBe(site.url('/b') + '?keep=1')
  })

  it('sends Global Privacy Control', async () => {
    expect(await d.rpc('page.eval', { js: 'navigator.globalPrivacyControl' })).toBe(true)
  })
})

describe('page tools never hang', () => {
  it('fails a page script that never settles at its deadline', async () => {
    await d.rpc('tabs.open', { url: site.url('/a') })
    await until(async () => (await d.rpc<string>('page.url')).endsWith('/a'), 'page a')
    const t = Date.now()
    await expect(d.rpc('page.eval', { js: 'new Promise(() => {})', timeout: 1000 })).rejects.toThrow(/timed out/)
    expect(Date.now() - t).toBeLessThan(5000)
  })
})

describe('settings', () => {
  it('persist across restarts and drive behavior', async () => {
    await d.rpc('settings.set', { searchEngine: 'duckduckgo', idleMinutes: 7 })
    expect(cleanExit(await d.stop(), d.log())).toBe(true)
    d = await startDrift({ profile: d.profile })
    expect(await d.rpc('settings.get')).toMatchObject({ searchEngine: 'duckduckgo', idleMinutes: 7 })
    const r = await d.rpc<{ kind: string; url: string }[]>('ui.search', { q: 'two words' })
    expect(r.at(-1)).toMatchObject({ kind: 'search', url: 'https://duckduckgo.com/?q=two%20words' })
  })

  it('ignores unknown settings keys', async () => {
    await d.rpc('settings.set', { notASetting: 1 })
    expect(await d.rpc('settings.get')).not.toHaveProperty('notASetting')
  })

  it('quits cleanly at the end', async () => {
    expect(cleanExit(await d.stop(), d.log())).toBe(true)
    d = await startDrift({ profile: d.profile })
  })
})
