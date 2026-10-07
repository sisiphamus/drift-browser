import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HistoryStore } from '../src/main/history'

let dir: string
let h: HistoryStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drift-hist-'))
  h = new HistoryStore(join(dir, 'history.db'))
})
afterEach(() => {
  h.close()
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000

describe('HistoryStore', () => {
  it('upserts visits and bumps the count', () => {
    h.addVisit('https://a.com/', 'A', 1000)
    h.addVisit('https://a.com/', '', 2000)
    expect(h.recent(10)).toEqual([{ url: 'https://a.com/', title: 'A', visitCount: 2, lastVisit: 2000 }])
  })

  it('ignores internal urls', () => {
    h.addVisit('about:blank', 'x')
    h.addVisit('drift://newtab', 'x')
    h.addVisit('data:text/html,hi', 'x')
    expect(h.recent(10)).toEqual([])
  })

  it('sets titles', () => {
    h.addVisit('https://a.com/', '')
    h.setTitle('https://a.com/', 'Alpha')
    expect(h.recent(1)[0].title).toBe('Alpha')
  })

  it('orders recent by last visit', () => {
    h.addVisit('https://a.com/', 'A', 1)
    h.addVisit('https://b.com/', 'B', 3)
    h.addVisit('https://c.com/', 'C', 2)
    expect(h.recent(2).map((r) => r.url)).toEqual(['https://b.com/', 'https://c.com/'])
  })

  it('searches every token in url or title, case-insensitive', () => {
    h.addVisit('https://github.com/drift', 'Drift repo')
    h.addVisit('https://github.com/other', 'Other')
    h.addVisit('https://news.com/', 'Drift news')
    expect(h.search('GIT drift').map((r) => r.url)).toEqual(['https://github.com/drift'])
    expect(h.search('drift').length).toBe(2)
    expect(h.search('  ')).toEqual([])
  })

  it('treats LIKE wildcards literally', () => {
    h.addVisit('https://a.com/100%', 'pct')
    h.addVisit('https://b.com/', 'nope')
    expect(h.search('%').map((r) => r.url)).toEqual(['https://a.com/100%'])
  })

  it('ranks by frecency', () => {
    const now = Date.now()
    h.importHistory([
      { url: 'https://old.com/x', title: 'x', visitCount: 50, lastVisit: now - 365 * DAY },
      { url: 'https://hot.com/x', title: 'x', visitCount: 20, lastVisit: now - DAY },
      { url: 'https://new.com/x', title: 'x', visitCount: 1, lastVisit: now },
    ])
    expect(h.search('x', 3).map((r) => r.url)).toEqual(['https://hot.com/x', 'https://new.com/x', 'https://old.com/x'])
    expect(h.search('x', 1)[0].url).toBe('https://hot.com/x')
  })

  it('merges imports with max count and max last visit', () => {
    h.addVisit('https://a.com/', 'Mine', 5000)
    h.importHistory([
      { url: 'https://a.com/', title: 'Theirs', visitCount: 9, lastVisit: 100 },
      { url: 'https://b.com/', title: 'B', visitCount: 2, lastVisit: 200 },
    ])
    const a = h.recent(10).find((r) => r.url === 'https://a.com/')!
    expect(a).toEqual({ url: 'https://a.com/', title: 'Mine', visitCount: 9, lastVisit: 5000 })
    expect(h.recent(10).length).toBe(2)
  })

  // 1.5s leaves room for a loaded machine running the whole suite in parallel; a regression is 10x, not 2x.
  it('imports 10k rows in well under two seconds', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      url: `https://site${i}.com/page`,
      title: `Page ${i}`,
      visitCount: i % 7,
      lastVisit: i,
    }))
    const t = performance.now()
    h.importHistory(rows)
    expect(performance.now() - t).toBeLessThan(1500)
    expect(h.search('site9999').length).toBe(1)
  })

  it('manages bookmarks', () => {
    h.addBookmark('https://a.com/', 'A', 'Work')
    h.addBookmark('https://b.com/', 'Bee')
    expect(h.isBookmarked('https://a.com/')).toBe(true)
    expect(h.bookmarks().map((b) => b.url).sort()).toEqual(['https://a.com/', 'https://b.com/'])
    expect(h.bookmarks().find((b) => b.url === 'https://a.com/')!.folder).toBe('Work')
    expect(h.searchBookmarks('bee', 5).map((b) => b.url)).toEqual(['https://b.com/'])
    h.removeBookmark('https://a.com/')
    expect(h.isBookmarked('https://a.com/')).toBe(false)
  })

  it('imports bookmarks without duplicating', () => {
    h.addBookmark('https://a.com/', 'A')
    h.importBookmarks([
      { url: 'https://a.com/', title: 'A2', folder: 'Bar' },
      { url: 'https://c.com/', title: 'C', folder: 'Bar/Sub' },
    ])
    expect(h.bookmarks().length).toBe(2)
    expect(h.bookmarks().find((b) => b.url === 'https://a.com/')!.title).toBe('A')
  })

  it('clears history but keeps bookmarks', () => {
    h.addVisit('https://a.com/', 'A')
    h.addBookmark('https://a.com/', 'A')
    h.clear()
    expect(h.recent(10)).toEqual([])
    expect(h.isBookmarked('https://a.com/')).toBe(true)
  })

  it('persists across reopen', () => {
    h.addVisit('https://a.com/', 'A', 1)
    h.close()
    h = new HistoryStore(join(dir, 'history.db'))
    expect(h.recent(1)[0].url).toBe('https://a.com/')
  })
})
