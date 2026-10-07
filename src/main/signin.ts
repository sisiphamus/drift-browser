// Google refuses sign-in from browsers it takes for embedded webviews ("This browser or app may not be
// secure"). There is no reliable fix for Electron; these raise the odds. On Google's account pages only,
// Drift either presents as current Firefox (default) or keeps an Electron token, which Google answers
// with its lighter "web lite" sign-in. Everything else sees plain Chromium.

export type SignInMode = 'firefox' | 'electron'

// google.com plus country domains (google.de, google.co.uk, google.com.br), and YouTube's account host.
export const ACCOUNTS = /^accounts\.(google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|youtube\.com)$/

export function isGoogleSignIn(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && ACCOUNTS.test(u.hostname)
  } catch {
    return false
  }
}

/** Firefox ships every four weeks; Google only supports the latest two versions. 158 ships 2026-10-09. */
export function firefoxVersion(now = new Date()): number {
  const anchor = Date.UTC(2026, 9, 9)
  return 158 + Math.floor((now.getTime() - anchor) / (28 * 24 * 3600 * 1000))
}

export function firefoxUA(now = new Date()): string {
  const v = firefoxVersion(now)
  return `Mozilla/5.0 (X11; Linux x86_64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`
}

/** Real Chrome reports only its major version (Chrome/152.0.0.0); Electron reports the full build. */
export function chromeUA(ua: string): string {
  return ua.replace(/Chrome\/(\d+)\.\d+\.\d+\.\d+/, 'Chrome/$1.0.0.0')
}

export function signInUA(mode: SignInMode, chrome: string, electronVersion: string): string {
  return mode === 'electron' ? `${chrome} Electron/${electronVersion}` : firefoxUA()
}

/** Request headers for Google's sign-in: the chosen user agent, and none of Chromium's client hints. */
export function signInHeaders(headers: Record<string, string>, ua: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (/^sec-ch-ua/i.test(k)) continue
    out[k] = /^user-agent$/i.test(k) ? ua : v
  }
  return out
}

/**
 * Runs in the page's main world before its scripts. The user agent itself is set natively (setUserAgent);
 * this only removes the Chromium-only surfaces Firefox doesn't have. Self-contained: it is serialized.
 */
export function presentAsFirefox(hosts: string) {
  if (location.protocol !== 'https:' || !new RegExp(hosts).test(location.hostname)) return
  if (!/Firefox\//.test(navigator.userAgent)) return
  const nav = Navigator.prototype
  const def = (k: string, v: string) => Object.defineProperty(nav, k, { get: () => v, configurable: true })
  def('vendor', '')
  def('oscpu', 'Linux x86_64')
  def('productSub', '20100101')
  delete (nav as unknown as Record<string, unknown>).userAgentData
  try {
    delete (window as unknown as Record<string, unknown>).chrome
  } catch {
    /* non-configurable in some builds */
  }
}
