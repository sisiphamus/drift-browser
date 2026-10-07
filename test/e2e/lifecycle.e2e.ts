import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { cleanExit, startDrift, cleanup, fixtures, until } from './harness'

let site: Awaited<ReturnType<typeof fixtures>>
beforeAll(async () => {
  site = await fixtures()
})
afterAll(() => site.close())

describe('lifecycle', () => {
  it('quits cleanly immediately after starting, every time', async () => {
    for (let i = 0; i < 6; i++) {
      const d = await startDrift({ settings: process.env.E2E_NO_ADBLOCK ? { adblock: false } : undefined })
      const exit = await d.stop()
      const ok = cleanExit(exit, d.log())
      cleanup(d.profile)
      expect(ok, `attempt ${i + 1}: ${JSON.stringify(exit)}`).toBe(true)
    }
  })

  it('quits cleanly right after restoring a session with tabs, every time', async () => {
    let d = await startDrift()
    for (const p of ['/a', '/b', '/c']) await d.rpc('tabs.open', { url: site.url(p) })
    await until(async () => (await d.rpc<string>('page.text')).includes('charlie'), 'last page')
    expect(cleanExit(await d.stop(), d.log())).toBe(true)
    for (let i = 0; i < 6; i++) {
      d = await startDrift({ profile: d.profile })
      expect(cleanExit(await d.stop(), d.log()), `attempt ${i + 1}`).toBe(true)
    }
    cleanup(d.profile)
  })
})
