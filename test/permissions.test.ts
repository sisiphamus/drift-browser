import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionStore } from '../src/main/permissions'

let path: string
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'perm-')), 'permissions.json')
})

describe('PermissionStore', () => {
  it('asks until a decision is recorded, then remembers it across restarts', () => {
    const p = new PermissionStore(path)
    expect(p.decide('https://meet.google.com', 'notifications')).toBe('ask')
    p.record('https://meet.google.com', 'notifications', [], true)
    expect(new PermissionStore(path).decide('https://meet.google.com', 'notifications')).toBe('allow')
  })

  it('remembers blocks too', () => {
    const p = new PermissionStore(path)
    p.record('https://a.com', 'geolocation', [], false)
    expect(new PermissionStore(path).decide('https://a.com', 'geolocation')).toBe('deny')
  })

  it('grants microphone and camera separately so a later combined request needs no prompt', () => {
    const p = new PermissionStore(path)
    p.record('https://meet.google.com', 'media', ['audio'], true)
    expect(p.decide('https://meet.google.com', 'media', ['audio'])).toBe('allow')
    expect(p.decide('https://meet.google.com', 'media', ['audio', 'video'])).toBe('ask')
    p.record('https://meet.google.com', 'media', ['video'], true)
    expect(p.decide('https://meet.google.com', 'media', ['video', 'audio'])).toBe('allow')
  })

  it('a block on either device denies a combined request', () => {
    const p = new PermissionStore(path)
    p.record('https://x.com', 'media', ['audio'], true)
    p.record('https://x.com', 'media', ['video'], false)
    expect(p.decide('https://x.com', 'media', ['audio', 'video'])).toBe('deny')
  })

  it('media with no listed devices covers both', () => {
    const p = new PermissionStore(path)
    p.record('https://x.com', 'media', [], true)
    expect(p.decide('https://x.com', 'media', ['audio', 'video'])).toBe('allow')
  })

  it('decisions are per origin', () => {
    const p = new PermissionStore(path)
    p.record('https://a.com', 'notifications', [], true)
    expect(p.decide('https://b.com', 'notifications')).toBe('ask')
  })

  it('lists and resets decisions', () => {
    const p = new PermissionStore(path)
    p.record('https://a.com', 'notifications', [], true)
    p.record('https://a.com', 'media', ['audio'], false)
    p.record('https://b.com', 'geolocation', [], true)
    expect(p.list()).toEqual([
      { origin: 'https://a.com', permission: 'media:audio', allowed: false },
      { origin: 'https://a.com', permission: 'notifications', allowed: true },
      { origin: 'https://b.com', permission: 'geolocation', allowed: true },
    ])
    p.reset('https://a.com', 'notifications')
    expect(p.decide('https://a.com', 'notifications')).toBe('ask')
    p.reset('https://a.com')
    expect(new PermissionStore(path).list()).toEqual([{ origin: 'https://b.com', permission: 'geolocation', allowed: true }])
  })
})
