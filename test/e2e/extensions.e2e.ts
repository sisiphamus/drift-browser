import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve } from 'node:path'
import { startDrift, fixtures, until, cleanup, type Drift } from './harness'

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

describe('extension compatibility', () => {
  it('gives service workers and content scripts a working chrome.storage.sync', async () => {
    await d.rpc('ext.load', { path: resolve(__dirname, 'ext-sync') })
    await d.rpc('tabs.open', { url: site.url('/a') })
    let got = ''
    await until(async () => {
      // Reload until the service worker has had its first run.
      got = await d.rpc<string>('page.eval', { js: 'document.documentElement.dataset.sync ?? ""' })
      if (got && got !== 'from-sw|ok') await d.rpc('tabs.reload')
      return got === 'from-sw|ok'
    }, 'storage.sync round trip', 15_000).catch(() => {})
    expect(got).toBe('from-sw|ok')
  })
})
