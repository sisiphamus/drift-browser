import { describe, it, expect } from 'vitest'
import { urlsFromArgv } from '../src/main/argv'

const files = new Set(['/home/a/page.html', '/home/a/My Notes.html'])
const exists = (p: string) => files.has(p)

describe('urlsFromArgv', () => {
  it('keeps web and file urls, as the desktop file passes them', () => {
    expect(urlsFromArgv(['https://example.com/a?b=1', 'http://x.org', 'file:///tmp/x.html'], exists)).toEqual([
      'https://example.com/a?b=1', 'http://x.org', 'file:///tmp/x.html',
    ])
  })

  it('turns local file paths into file urls', () => {
    expect(urlsFromArgv(['/home/a/page.html', '/home/a/My Notes.html'], exists)).toEqual([
      'file:///home/a/page.html', 'file:///home/a/My%20Notes.html',
    ])
  })

  it('accepts bare domains', () => {
    expect(urlsFromArgv(['example.com'], exists)).toEqual(['example.com'])
  })

  it('ignores the app path, switches and missing files', () => {
    expect(urlsFromArgv(['/opt/drift', '--ozone-platform=headless', '--no-sandbox', '/nope.html'], exists)).toEqual([])
  })
})
