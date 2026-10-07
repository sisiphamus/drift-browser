import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { utimesSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { startDrift, until, cleanup, type Drift } from './harness'

const BUILD = resolve(__dirname, '../../out/renderer/index.html')
let d: Drift

beforeAll(async () => {
  process.env.DRIFT_UPDATE_POLL_MS = '200'
  d = await startDrift()
})
afterAll(async () => {
  delete process.env.DRIFT_UPDATE_POLL_MS
  await d.stop()
  cleanup(d.profile)
})

describe('restart to update', () => {
  it('offers a restart once a newer build lands', async () => {
    const ready = () => d.rpc<boolean>('debug.uiEval', { js: 'window.drift.state().then((s) => s.updateReady)' })
    await new Promise((r) => setTimeout(r, 600))
    expect(await ready()).toBe(false)
    const now = new Date()
    utimesSync(BUILD, now, now)
    expect(statSync(BUILD).mtimeMs).toBeGreaterThan(0)
    await until(ready, 'update card')
    await d.rpc('settings.set', { sidebarPinned: true })
    const card = () => d.rpc<string>('debug.uiEval', { js: "[...document.querySelectorAll('.prompt p')].map((p) => p.textContent).join(' ')" })
    await until(async () => (await card()).includes('new version of Drift'), 'restart card shown')
  })
})
