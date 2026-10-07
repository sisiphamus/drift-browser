import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startDrift, until, cleanup, type Drift } from './harness'

let d: Drift
let srv: Server
let base = ''
const pages: Record<string, string> = {
  '/plain': '<title>Plain</title><p style="height:2000px">tall, nothing wide</p>',
  '/carousel':
    '<title>Carousel</title><div id="c" style="overflow-x:auto;width:600px;height:300px;margin-top:100px"><div style="width:3000px;height:280px;background:linear-gradient(90deg,#eee,#999)"></div></div>',
}

const active = async () => (await d.rpc<{ name: string; active: boolean }[]>('ws.list')).find((w) => w.active)?.name
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** A two-finger swipe as wheel input on the page itself. Electron's wheel delta sign is the reverse of the DOM's. */
async function swipe(tab: string, x: number, y: number, dir: 'next' | 'prev') {
  for (let i = 0; i < 12; i++) {
    await d.rpc('debug.pageInput', { tab, type: 'mouseWheel', x, y, deltaX: dir === 'next' ? -30 : 30, deltaY: 0, hasPreciseScrollingDeltas: true, canScroll: true })
    await sleep(16)
  }
  await sleep(800)
}

beforeAll(async () => {
  srv = createServer((q, s) => s.end(pages[q.url ?? ''] ?? '')).listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  d = await startDrift()
  await d.rpc('ws.create', { name: 'Two' })
  await d.rpc('ws.switch', { target: 'Home' })
})
afterAll(async () => {
  srv.close()
  await d.stop()
  cleanup(d.profile)
})

describe('two-finger swipe over a page', () => {
  it('switches to the next space, then back', async () => {
    const t = await d.rpc<{ id: string }>('tabs.open', { url: `${base}/plain` })
    await until(async () => (await d.rpc<string>('page.url')).endsWith('/plain'), 'plain loaded')
    await swipe(t.id, 400, 300, 'next')
    await until(async () => (await active()) === 'Two', 'switched to Two')
    await d.rpc('ws.switch', { target: 'Home' })
    await sleep(800)
    await swipe(t.id, 400, 300, 'prev')
    await until(async () => (await active()) === 'Two', 'wrapped back to Two') // two spaces: prev from Home wraps
  })

  it('leaves sideways scrolling to the page when something can scroll', async () => {
    await d.rpc('ws.switch', { target: 'Home' })
    await sleep(800)
    const t = await d.rpc<{ id: string }>('tabs.open', { url: `${base}/carousel` })
    await until(async () => (await d.rpc<string>('page.url')).endsWith('/carousel'), 'carousel loaded')
    await sleep(500)
    await swipe(t.id, 300, 250, 'next')
    expect(await active()).toBe('Home')
    expect(await d.rpc<number>('page.eval', { js: 'document.getElementById("c").scrollLeft' })).toBeGreaterThan(0)
  })
})
