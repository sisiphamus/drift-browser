// Command bar: decide url vs search, score candidates, merge sources.

export type Kind = 'url' | 'tab' | 'bookmark' | 'history' | 'command' | 'search'
export type Candidate = { kind: Kind; id: string; title: string; url: string; boost: number }
export type Result = Candidate & { score: number }

const KIND_WEIGHT: Record<Kind, number> = { url: 100, tab: 30, bookmark: 20, command: 18, history: 10, search: 0 }
const TLD = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i

export function toUrl(q: string): string | null {
  const s = q.trim()
  if (!s || /\s/.test(s)) return null
  if (/^(https?|file|about|chrome|chrome-extension|devtools|blob|data|view-source):/i.test(s)) return s
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(s)) return new URL(`http://${s}`).href
  if (TLD.test(s)) return new URL(`https://${s}`).href
  return null
}

export type Engine = 'google' | 'brave' | 'duckduckgo' | 'kagi'
const ENGINES: Record<Engine, string> = {
  google: 'https://www.google.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  kagi: 'https://kagi.com/search?q=',
}
export const searchUrl = (q: string, engine: Engine = 'google') => `${ENGINES[engine] ?? ENGINES.google}${encodeURIComponent(q)}`

/** Subsequence match with bonuses for prefix, word starts and runs. 0 = no match. */
export function fuzzyScore(q: string, text: string): number {
  const needle = q.toLowerCase()
  const hay = text.toLowerCase()
  if (!needle) return 1
  const at = hay.indexOf(needle)
  if (at === 0) return 100 + needle.length
  if (at > 0) return (/[\s/._-]/.test(hay[at - 1]) ? 80 : 50) + needle.length
  let score = 0
  let j = 0
  let run = 0
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] !== needle[j]) {
      run = 0
      continue
    }
    const wordStart = i === 0 || /[\s/._-]/.test(hay[i - 1]) || (text[i] >= 'A' && text[i] <= 'Z')
    score += 1 + (wordStart ? 4 : 0) + run * 2
    run++
    j++
  }
  return j === needle.length ? score : 0
}

export function rank(query: string, candidates: Candidate[], limit = 9, engine: Engine = 'google'): Result[] {
  const q = query.trim()
  const scored: Result[] = []
  for (const c of candidates) {
    const s = Math.max(fuzzyScore(q, c.title), fuzzyScore(q, c.url.replace(/^https?:\/\/(www\.)?/, '')) * 0.9)
    if (s > 0) scored.push({ ...c, score: s + KIND_WEIGHT[c.kind] + c.boost })
  }
  scored.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  const out: Result[] = []
  const url = toUrl(q)
  if (url) {
    out.push({ kind: 'url', id: `url:${url}`, title: url, url, boost: 0, score: Infinity })
    seen.add(url)
  }
  for (const r of scored) {
    const key = r.url || `${r.kind}:${r.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  const top = out.slice(0, limit - (q && !url ? 1 : 0))
  if (q && !url) top.push({ kind: 'search', id: `search:${q}`, title: q, url: searchUrl(q, engine), boost: 0, score: 0 })
  return top
}
