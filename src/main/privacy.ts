// Navigation hygiene: tracking-parameter stripping and HTTPS upgrades, both pure.

const TRACKING = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'igshid', 'mc_eid', 'mc_cid',
  '_hsenc', '_hsmi', 'mkt_tok', 'oly_enc_id', 'oly_anon_id', 'vero_id', 'vero_conv', '__s', 'srsltid', 'ref_src', 'ref_url',
])
// `si` is a share tracker on these sites and a real parameter elsewhere.
const SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|open\.spotify\.com|instagram\.com)$/

export function stripTracking(url: string): string {
  if (!/^https?:/i.test(url)) return url
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  let changed = false
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase()
    if (k.startsWith('utm_') || TRACKING.has(k) || (k === 'si' && SI_HOSTS.test(u.hostname))) {
      u.searchParams.delete(key)
      changed = true
    }
  }
  return changed ? u.href : url
}

const LOCAL = /^(localhost|\[::1\]|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$|\.(local|lan|home|internal|test|localhost)$/

/** http to https, except for local hosts and hosts that already failed over https this session. */
export function upgradeHttps(url: string, httpOk: Set<string>): string {
  if (!/^http:/i.test(url)) return url
  try {
    const u = new URL(url)
    if (LOCAL.test(u.hostname) || httpOk.has(u.hostname)) return url
    u.protocol = 'https:'
    return u.href
  } catch {
    return url
  }
}

/** The url a navigation should go to instead, or null to let it through unchanged. */
export function cleanNavigation(url: string, httpOk: Set<string>, opts = { https: true, strip: true }): string | null {
  const stripped = opts.strip ? stripTracking(url) : url
  const next = opts.https ? upgradeHttps(stripped, httpOk) : stripped
  return next === url ? null : next
}
