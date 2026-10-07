import { describe, it, expect } from 'vitest'
import { toUrl, fuzzyScore, rank, searchUrl, Candidate } from '../src/main/search'

describe('toUrl', () => {
  it.each([
    ['github.com', 'https://github.com/'],
    ['https://x.com/a', 'https://x.com/a'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['file:///tmp/a.html', 'file:///tmp/a.html'],
    ['chrome-extension://abc/options.html', 'chrome-extension://abc/options.html'],
    ['news.ycombinator.com/item?id=1', 'https://news.ycombinator.com/item?id=1'],
  ])('%s is a url', (q, url) => expect(toUrl(q)).toBe(url))

  it.each(['how to cook rice', 'react', 'what is 2.5', 'a.b c'])('%s is a search', (q) => expect(toUrl(q)).toBeNull())
})

describe('searchUrl', () => {
  it.each([
    ['google', 'https://www.google.com/search?q=a%20b'],
    ['brave', 'https://search.brave.com/search?q=a%20b'],
    ['duckduckgo', 'https://duckduckgo.com/?q=a%20b'],
    ['kagi', 'https://kagi.com/search?q=a%20b'],
  ] as const)('%s', (engine, url) => expect(searchUrl('a b', engine)).toBe(url))

  it('defaults to google and the search row uses the chosen engine', () => {
    expect(searchUrl('x')).toBe('https://www.google.com/search?q=x')
    expect(rank('two words', [], 9, 'duckduckgo').at(-1)).toMatchObject({ kind: 'search', url: 'https://duckduckgo.com/?q=two%20words' })
  })
})

describe('fuzzyScore', () => {
  it('prefers prefix and word-start matches', () => {
    expect(fuzzyScore('git', 'GitHub')).toBeGreaterThan(fuzzyScore('git', 'Digital'))
    expect(fuzzyScore('gh', 'GitHub')).toBeGreaterThan(0)
    expect(fuzzyScore('xyz', 'GitHub')).toBe(0)
  })
})

describe('rank', () => {
  const c = (kind: Candidate['kind'], title: string, url = '', boost = 0): Candidate => ({ kind, title, url, boost, id: title })

  it('puts an open tab above history for the same match', () => {
    const r = rank('git', [c('history', 'GitHub', 'https://github.com'), c('tab', 'GitHub', 'https://github.com')])
    expect(r[0].kind).toBe('tab')
  })

  it('always offers a search row and a go-to row for urls', () => {
    expect(rank('react hooks', []).map((r) => r.kind)).toEqual(['search'])
    expect(rank('github.com', [])[0]).toMatchObject({ kind: 'url', url: 'https://github.com/' })
  })

  it('drops duplicates by url keeping the best kind', () => {
    const r = rank('git', [c('history', 'GitHub', 'https://github.com'), c('bookmark', 'GitHub', 'https://github.com')])
    expect(r.filter((x) => x.url === 'https://github.com')).toHaveLength(1)
  })

  it('empty query lists tabs and commands without a search row', () => {
    const r = rank('', [c('tab', 'A', 'https://a.com'), c('command', 'New workspace')])
    expect(r.map((x) => x.kind)).toEqual(['tab', 'command'])
  })
})
