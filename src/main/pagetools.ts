// Page automation over a WebContents: read (text/html/markdown), act (click/type/scroll), see (screenshot).
// In-page code is plain JS strings so bundlers can't inject helpers into executeJavaScript.

import type { WebContents } from 'electron'

export type Found = { tag: string; text: string }

// (target) => Element | null. `text:Label` matches visible text/aria-label/value, prefers controls, then smallest.
const FIND = `(target) => {
  const visible = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  if (!target.startsWith('text:')) {
    const all = [...document.querySelectorAll(target)]
    return all.find(visible) || all[0] || null
  }
  const want = target.slice(5).trim().toLowerCase()
  const CONTROL = 'a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button],summary,label,[onclick]'
  const label = (el) => ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.tagName === 'INPUT' ? el.value : '')).toLowerCase()
  let best = null, bestScore = Infinity
  for (const el of document.body.querySelectorAll('*')) {
    const t = label(el)
    if (!t.includes(want) || !visible(el)) continue
    const score = (el.matches(CONTROL) ? 0 : 1e6) + t.length
    if (score < bestScore) best = el, bestScore = score
  }
  if (best && !best.matches(CONTROL)) best = best.closest(CONTROL) || best
  return best
}`

const describe = `(el) => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120) })`

/** executeJavaScript can stay pending forever (a page mid-navigation, a script that never resolves); never wait past ms. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p,
    new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms ${what}`)), ms))),
  ]).finally(() => clearTimeout(timer))
}

function inPage<T>(wc: WebContents, body: string, gesture = false, ms = 15_000): Promise<T> {
  return deadline(wc.executeJavaScript(`(async () => { ${body} })()`, gesture), ms, 'running in the page')
}

export async function pageText(wc: WebContents): Promise<string> {
  const t = await inPage<string>(wc, `return document.body ? document.body.innerText : ''`)
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function pageHtml(wc: WebContents): Promise<string> {
  return inPage<string>(wc, `return document.documentElement.outerHTML`)
}

// Self-contained HTML -> GFM. Runs in the page so links resolve against the live document.
const MARKDOWN = `
const SKIP = new Set(['SCRIPT','STYLE','NAV','FOOTER','ASIDE','NOSCRIPT','SVG','TEMPLATE','IFRAME','CANVAS','DIALOG','HEAD','BUTTON','SELECT','OPTION'])
const BLOCK = new Set(['P','DIV','SECTION','ARTICLE','MAIN','HEADER','FIGURE','FIGCAPTION','DL','DT','DD','DETAILS','SUMMARY','FORM','FIELDSET','ADDRESS','CENTER'])
const hidden = (el) => el.checkVisibility ? !el.checkVisibility({ checkVisibilityCSS: true }) : el.hidden
const pick = () => {
  const main = document.querySelector('main, [role=main]')
  if (main && main.innerText.trim().length > 200) return main
  const arts = [...document.querySelectorAll('article')].sort((a, b) => b.innerText.length - a.innerText.length)
  if (arts[0] && arts[0].innerText.trim().length > 200) return arts[0]
  return main || document.body
}
const cell = (el) => inline(el).replace(/\\|/g, '\\\\|').replace(/\\s*\\n\\s*/g, ' ').trim()
const inline = (el) => kids(el).replace(/\\n{2,}/g, '\\n').trim()
const kids = (el) => [...el.childNodes].map(conv).join('')
const indent = (s, pad) => s.split('\\n').map((l, i) => (i && l ? pad + l : l)).join('\\n')
function list(el) {
  let i = Number(el.getAttribute('start') || 1)
  const out = []
  for (const li of el.children) {
    if (li.tagName !== 'LI' || hidden(li)) continue
    const mark = el.tagName === 'OL' ? (i++) + '. ' : '- '
    out.push(mark + indent(kids(li).replace(/\\n{3,}/g, '\\n\\n').trim(), ' '.repeat(mark.length)))
  }
  return '\\n\\n' + out.join('\\n') + '\\n\\n'
}
function table(el) {
  const rows = [...el.rows].filter((r) => !hidden(r)).map((r) => [...r.cells].map(cell))
  if (!rows.length) return ''
  const n = Math.max(...rows.map((r) => r.length))
  const line = (r) => '| ' + Array.from({ length: n }, (_, i) => r[i] || '').join(' | ') + ' |'
  return '\\n\\n' + [line(rows[0]), '| ' + Array(n).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\\n') + '\\n\\n'
}
function conv(node) {
  if (node.nodeType === 3) return node.parentElement && node.parentElement.closest('pre') ? node.data : node.data.replace(/\\s+/g, ' ')
  if (node.nodeType !== 1) return ''
  const el = node, tag = el.tagName
  if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true' || hidden(el)) return ''
  if (/^H[1-6]$/.test(tag)) return '\\n\\n' + '#'.repeat(+tag[1]) + ' ' + inline(el) + '\\n\\n'
  switch (tag) {
    case 'BR': return '\\n'
    case 'HR': return '\\n\\n---\\n\\n'
    case 'A': {
      const t = inline(el)
      const href = el.href
      if (!t) return ''
      return !href || href.startsWith('javascript:') ? t : '[' + t + '](' + href + ')'
    }
    case 'IMG': {
      const src = el.currentSrc || el.src
      if (!src || (src.startsWith('data:') && !el.alt)) return ''
      return '![' + (el.alt || '').trim() + '](' + (src.startsWith('data:') ? '' : src) + ')'
    }
    case 'STRONG': case 'B': { const t = inline(el); return t ? '**' + t + '**' : '' }
    case 'EM': case 'I': { const t = inline(el); return t ? '*' + t + '*' : '' }
    case 'DEL': case 'S': { const t = inline(el); return t ? '~~' + t + '~~' : '' }
    case 'CODE': return el.closest('pre') ? el.textContent : '\\x60' + el.textContent + '\\x60'
    case 'PRE': {
      const c = el.querySelector('code')
      const lang = ((c || el).className.match(/(?:language|lang)-([\\w+-]+)/) || [])[1] || ''
      return '\\n\\n\\x60\\x60\\x60' + lang + '\\n' + el.textContent.replace(/\\n$/, '') + '\\n\\x60\\x60\\x60\\n\\n'
    }
    case 'BLOCKQUOTE': return '\\n\\n' + kids(el).trim().replace(/\\n{3,}/g, '\\n\\n').split('\\n').map((l) => '> ' + l).join('\\n') + '\\n\\n'
    case 'UL': case 'OL': return list(el)
    case 'TABLE': return table(el)
    case 'LI': return '\\n- ' + inline(el) + '\\n'
    case 'INPUT': return ''
  }
  const s = kids(el)
  return BLOCK.has(tag) ? '\\n\\n' + s + '\\n\\n' : s
}
const root = pick()
let md = conv(root).split('\\n').map((l) => l.replace(/\\s+$/, '')).join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
if (!/^# /m.test(md) && document.title) md = '# ' + document.title.trim() + '\\n\\n' + md
return md
`

export function pageMarkdown(wc: WebContents): Promise<string> {
  return inPage<string>(wc, MARKDOWN)
}

type Hit = Found & { x: number; y: number; covered: boolean; hidden: boolean }

async function locate(wc: WebContents, target: string): Promise<Hit | null> {
  return inPage<Hit | null>(
    wc,
    `const el = (${FIND})(${JSON.stringify(target)})
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return { ...(${describe})(el), x, y, covered: !top || !(el === top || el.contains(top) || top.contains(el)), hidden: document.visibilityState === 'hidden' }`,
  )
}

function notFound(target: string): Error {
  return new Error(`no element matches ${JSON.stringify(target)}`)
}

/**
 * Input through the DevTools protocol: trusted events that reach the page whether or not Drift's window
 * has focus (Electron's sendInputEvent is dropped while another app is focused, which is exactly when an
 * agent drives Drift). Attaches only for the call unless something else already holds the debugger.
 */
async function withInput<T>(wc: WebContents, fn: (send: (method: string, params: object) => Promise<unknown>) => Promise<T>): Promise<T> {
  const dbg = wc.debugger
  const mine = !dbg.isAttached()
  if (mine) dbg.attach('1.3')
  try {
    return await fn((method, params) => dbg.sendCommand(method, params))
  } finally {
    if (mine && dbg.isAttached()) dbg.detach()
  }
}

// Real (trusted) mouse click at the element's centre. Covered elements, and tabs that are out of sight (a hidden
// view does not hit-test mouse input, which is where agents work), get the pointer sequence from script instead.
export async function click(wc: WebContents, target: string): Promise<Found> {
  const hit = await locate(wc, target)
  if (!hit) throw notFound(target)
  if (hit.covered || hit.hidden) {
    await inPage(
      wc,
      `const el = (${FIND})(${JSON.stringify(target)})
      const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: ${hit.x}, clientY: ${hit.y}, button: 0 }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true }))
      el.dispatchEvent(new MouseEvent('mousedown', at))
      el.focus?.()
      el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }))
      el.dispatchEvent(new MouseEvent('mouseup', at))
      el.click()`,
      true,
    )
    return { tag: hit.tag, text: hit.text }
  }
  const z = wc.getZoomFactor()
  const x = hit.x * z
  const y = hit.y * z
  await withInput(wc, async (send) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  })
  return { tag: hit.tag, text: hit.text }
}

export async function typeText(wc: WebContents, selector: string, text: string, submit = false): Promise<Found> {
  const found = await click(wc, selector)
  // Clicking a label or covered input may not move focus; make sure the target has it.
  await inPage(wc, `const el = (${FIND})(${JSON.stringify(selector)}); if (el && document.activeElement !== el) el.focus()`)
  await withInput(wc, async (send) => {
    await send('Input.insertText', { text })
    if (submit) {
      const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
    }
  })
  return found
}

export async function evalJs(wc: WebContents, js: string, timeoutMs = 30_000): Promise<unknown> {
  let v: unknown
  try {
    v = await deadline(wc.executeJavaScript(js, true), timeoutMs, 'waiting for the script')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(/could not be cloned/.test(msg) ? 'result is not serializable (DOM node or function?); return plain data' : msg)
  }
  return v === undefined ? null : JSON.parse(JSON.stringify(v) ?? 'null')
}

export async function waitFor(wc: WebContents, target: string, timeoutMs = 10000): Promise<Found & { ms: number }> {
  const start = Date.now()
  const probe = `const el = (${FIND})(${JSON.stringify(target)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? (${describe})(el) : null`
  for (;;) {
    const left = Math.max(250, timeoutMs - (Date.now() - start))
    const hit = await inPage<Found | null>(wc, probe, false, Math.min(left, 2000)).catch(() => null)
    if (hit) return { ...hit, ms: Date.now() - start }
    if (Date.now() - start >= timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${JSON.stringify(target)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

// Number scrolls by that many px; 'top'/'bottom' jump. Returns the new scroll position.
export async function scroll(wc: WebContents, to: number | string): Promise<{ y: number; height: number }> {
  let step: string
  if (to === 'top') step = `window.scrollTo(0, 0)`
  else if (to === 'bottom') step = `window.scrollTo(0, document.documentElement.scrollHeight)`
  else if (Number.isFinite(Number(to))) step = `window.scrollBy(0, ${Number(to)})`
  else throw new Error(`scroll: expected px, top or bottom, got ${JSON.stringify(to)}`)
  return inPage(
    wc,
    `${step}; await new Promise((r) => requestAnimationFrame(() => r()))
    return { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight }`,
  )
}

export async function screenshot(wc: WebContents, full = false): Promise<Buffer> {
  if (!full) {
    const img = await wc.capturePage()
    if (img.isEmpty()) throw new Error('the page has not drawn anything yet')
    return img.toPNG()
  }
  const dbg = wc.debugger
  const mine = !dbg.isAttached()
  if (mine) dbg.attach('1.3')
  try {
    const m = await dbg.sendCommand('Page.getLayoutMetrics')
    const size = m.cssContentSize || m.contentSize
    const r = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 },
    })
    return Buffer.from(r.data, 'base64')
  } finally {
    if (mine && dbg.isAttached()) dbg.detach()
  }
}
