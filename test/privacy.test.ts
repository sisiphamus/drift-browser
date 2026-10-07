import { describe, it, expect } from 'vitest'
import { stripTracking, upgradeHttps, cleanNavigation } from '../src/main/privacy'

describe('stripTracking', () => {
  it('drops known tracking params and keeps the rest', () => {
    expect(stripTracking('https://a.com/p?utm_source=x&id=7&fbclid=abc&utm_medium=y')).toBe('https://a.com/p?id=7')
    expect(stripTracking('https://a.com/?gclid=1&msclkid=2&mc_eid=3')).toBe('https://a.com/')
  })
  it('only strips si on the sites that use it for tracking', () => {
    expect(stripTracking('https://youtu.be/abc?si=xyz&t=30')).toBe('https://youtu.be/abc?t=30')
    expect(stripTracking('https://example.com/?si=keep')).toBe('https://example.com/?si=keep')
  })
  it('leaves urls without tracking untouched, hash included', () => {
    expect(stripTracking('https://a.com/p?q=1#top')).toBe('https://a.com/p?q=1#top')
  })
  it('returns non-http input as is', () => {
    expect(stripTracking('drift://ui/')).toBe('drift://ui/')
  })
})

describe('upgradeHttps', () => {
  it('upgrades public http hosts', () => {
    expect(upgradeHttps('http://example.com/a', new Set())).toBe('https://example.com/a')
  })
  it('keeps http for local hosts and for hosts that failed over https', () => {
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.4/', 'http://printer.local/', 'http://box.lan/', 'http://10.0.0.2:8080/']) {
      expect(upgradeHttps(u, new Set())).toBe(u)
    }
    expect(upgradeHttps('http://old.example/', new Set(['old.example']))).toBe('http://old.example/')
  })
})

describe('cleanNavigation', () => {
  it('returns null when nothing changes so callers can let the navigation through', () => {
    expect(cleanNavigation('https://a.com/', new Set())).toBeNull()
    expect(cleanNavigation('http://a.com/?utm_source=x', new Set())).toBe('https://a.com/')
  })

  it('honors each setting being turned off', () => {
    expect(cleanNavigation('http://a.com/?utm_source=x', new Set(), { https: false, strip: true })).toBe('http://a.com/')
    expect(cleanNavigation('http://a.com/?utm_source=x', new Set(), { https: true, strip: false })).toBe('https://a.com/?utm_source=x')
    expect(cleanNavigation('http://a.com/?utm_source=x', new Set(), { https: false, strip: false })).toBeNull()
  })
})
