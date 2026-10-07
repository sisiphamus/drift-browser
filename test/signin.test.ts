import { describe, it, expect } from 'vitest'
import { isGoogleSignIn, signInHeaders, firefoxVersion, firefoxUA, signInUA, chromeUA } from '../src/main/signin'

describe('google sign-in identity', () => {
  it('only targets Google account pages', () => {
    expect(isGoogleSignIn('https://accounts.google.com/v3/signin/identifier?x=1')).toBe(true)
    expect(isGoogleSignIn('https://accounts.google.co.uk/ServiceLogin')).toBe(true)
    expect(isGoogleSignIn('https://accounts.youtube.com/accounts/SetSID')).toBe(true)
    expect(isGoogleSignIn('https://mail.google.com/')).toBe(false)
    expect(isGoogleSignIn('https://evil.com/accounts.google.com')).toBe(false)
    expect(isGoogleSignIn('https://accounts.google.com.evil.com/')).toBe(false)
    expect(isGoogleSignIn('not a url')).toBe(false)
  })

  it('strips Chromium client hints and sets the given user agent', () => {
    const out = signInHeaders(
      { 'User-Agent': 'Mozilla/5.0 Chrome/152', 'sec-ch-ua': '"Chromium";v="152"', 'Sec-CH-UA-Mobile': '?0', Accept: 'text/html' },
      'UA',
    )
    expect(out).toEqual({ 'User-Agent': 'UA', Accept: 'text/html' })
  })

  it('tracks the current Firefox release (every four weeks; 158 on 2026-10-09)', () => {
    expect(firefoxVersion(new Date('2026-10-09T12:00:00Z'))).toBe(158)
    expect(firefoxVersion(new Date('2026-10-07T12:00:00Z'))).toBe(157)
    expect(firefoxVersion(new Date('2026-11-06T12:00:00Z'))).toBe(159)
    expect(firefoxUA(new Date('2026-10-09T12:00:00Z'))).toBe('Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0')
  })

  it('chrome UA reports only the major version, like real Chrome', () => {
    expect(chromeUA('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36'))
      .toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36')
  })

  it('electron mode keeps the Chrome UA and adds the Electron token', () => {
    const base = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    expect(signInUA('electron', base, '44.6.0')).toBe(`${base} Electron/44.6.0`)
    expect(signInUA('firefox', base, '44.6.0')).toMatch(/Firefox\/\d+\.0$/)
  })
})
