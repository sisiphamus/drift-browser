// Matugen colors (via the GTK overlay it renders) to UI tokens, with per-workspace hue shifts.

export type Palette = {
  accent: string
  onAccent: string
  fg: string
  bg: string
  surface: string
  border: string
  raised: string
}
export type Oklch = { l: number; c: number; h: number }

export const GTK_PATH = `${process.env.HOME}/.config/gtk-4.0/gtk.css`

export const FALLBACK: Palette = {
  accent: '#a8c7fa', onAccent: '#0a305f', fg: '#e3e2e6', bg: '#121316',
  surface: '#1e1f23', border: '#44474e', raised: '#292a2e',
}

const KEYS: Record<string, keyof Palette> = {
  accent_bg_color: 'accent',
  accent_fg_color: 'onAccent',
  window_fg_color: 'fg',
  view_bg_color: 'bg',
  headerbar_bg_color: 'surface',
  headerbar_border_color: 'border',
  popover_bg_color: 'raised',
}

export function parseGtk(css: string): Palette {
  const p = { ...FALLBACK }
  for (const m of css.matchAll(/@define-color\s+(\w+)\s+(#[0-9a-fA-F]{6})\s*;/g)) {
    const k = KEYS[m[1]]
    if (k) p[k] = m[2].toLowerCase()
  }
  return p
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function hexToOklch(hex: string): Oklch {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}

function oklchToRgb({ l: L, c, h }: Oklch): number[] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(fromLinear)
}

export function oklchToHex(color: Oklch): string {
  // Pull chroma in until the color fits sRGB instead of clipping channels.
  let c = color.c
  let rgb = oklchToRgb({ ...color, c })
  while (rgb.some((v) => v < -0.001 || v > 1.001) && c > 0) {
    c = Math.max(0, c - 0.002)
    rgb = oklchToRgb({ ...color, c })
  }
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
}

const shift = (hex: string, h: number | null, cap?: number): string => {
  const o = hexToOklch(hex)
  return oklchToHex({ l: o.l, c: cap === undefined ? o.c : Math.min(o.c, cap), h: h ?? o.h })
}

const mix = (a: string, b: string, t: number): string => {
  const x = hexToOklch(a)
  const y = hexToOklch(b)
  return oklchToHex({ l: x.l + (y.l - x.l) * t, c: x.c + (y.c - x.c) * t, h: x.c < 0.01 ? y.h : x.h })
}

/** CSS custom properties for the UI. `hue` comes from the workspace, null keeps matugen's. */
export function buildTokens(p: Palette, hue: number | null): Record<string, string> {
  const accent = shift(p.accent, hue)
  const a = hexToOklch(accent)
  const neutral = (hex: string) => (hue === null ? hex : shift(hex, hue, 0.03))
  const bg = neutral(p.bg)
  const fg = neutral(p.fg)
  return {
    '--accent': accent,
    '--on-accent': shift(p.onAccent, hue),
    '--bg': bg,
    '--fg': fg,
    '--fg-mute': mix(fg, bg, 0.28),
    '--fg-faint': mix(fg, bg, 0.46),
    '--surface': neutral(p.surface),
    '--raised': neutral(p.raised),
    '--border': neutral(p.border),
    '--tint': oklchToHex({ l: hexToOklch(bg).l + 0.05, c: Math.min(a.c, 0.06), h: a.h }),
  }
}
