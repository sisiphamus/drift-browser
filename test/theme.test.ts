import { describe, it, expect } from 'vitest'
import { parseGtk, hexToOklch, oklchToHex, buildTokens, FALLBACK } from '../src/main/theme'

const css = `
@define-color accent_bg_color #ffb3b2;
@define-color accent_fg_color #561d1f;
@define-color window_bg_color rgba(0, 0, 0, 0);
@define-color window_fg_color #f0dedd;
@define-color view_bg_color #1a1111;
@define-color headerbar_bg_color #271d1d;
@define-color headerbar_border_color #524343;
@define-color popover_bg_color #322827;
`

describe('theme', () => {
  it('reads matugen colors from the GTK overlay', () => {
    const p = parseGtk(css)
    expect(p).toEqual({
      accent: '#ffb3b2', onAccent: '#561d1f', fg: '#f0dedd', bg: '#1a1111',
      surface: '#271d1d', border: '#524343', raised: '#322827',
    })
  })

  it('falls back field by field when colors are missing', () => {
    expect(parseGtk('').accent).toBe(FALLBACK.accent)
  })

  it('round-trips hex through OKLCH', () => {
    for (const hex of ['#ffb3b2', '#1a1111', '#7aa2f7', '#000000', '#ffffff']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex)
    }
  })

  it('a workspace hue rotates the accent but keeps its lightness', () => {
    const p = parseGtk(css)
    const base = buildTokens(p, null)
    const blue = buildTokens(p, 250)
    expect(blue['--accent']).not.toBe(base['--accent'])
    expect(hexToOklch(blue['--accent']).l).toBeCloseTo(hexToOklch(base['--accent']).l, 1)
    expect(Math.round(hexToOklch(blue['--accent']).h)).toBeGreaterThan(240)
  })

  it('emits every token the UI uses', () => {
    const t = buildTokens(parseGtk(css), null)
    for (const k of ['--accent', '--on-accent', '--bg', '--fg', '--fg-mute', '--surface', '--raised', '--border', '--tint']) {
      expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
