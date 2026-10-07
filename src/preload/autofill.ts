// Login autofill inside pages. Runs in the isolated world; the dropdown lives in a closed shadow root
// so page scripts and styles can't read or restyle it. Secrets only arrive after a trusted click.
import { ipcRenderer } from 'electron'

type Login = { id: string; username: string }

const isPassword = (el: Element | null): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'password'
const isUserField = (el: Element | null): el is HTMLInputElement =>
  el instanceof HTMLInputElement && ['text', 'email', 'tel', ''].includes(el.type) && /user|login|email|name|account|id/i.test(`${el.name} ${el.id} ${el.autocomplete} ${el.type}`)

function scope(el: HTMLElement): ParentNode {
  return el.closest('form') ?? el.ownerDocument
}
function passwordIn(el: HTMLElement): HTMLInputElement | null {
  return [...scope(el).querySelectorAll('input[type=password]')].find((p) => (p as HTMLInputElement).offsetParent !== null) as HTMLInputElement ?? null
}
function userFor(pw: HTMLInputElement): HTMLInputElement | null {
  const inputs = [...scope(pw).querySelectorAll('input')] as HTMLInputElement[]
  const before = inputs.slice(0, inputs.indexOf(pw)).reverse()
  return before.find((i) => isUserField(i) && i.offsetParent !== null) ?? before.find((i) => ['text', 'email'].includes(i.type) && i.offsetParent !== null) ?? null
}
function setValue(el: HTMLInputElement, value: string) {
  // The native setter, so React and friends see the change.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

let host: HTMLElement | null = null
let root: ShadowRoot | null = null
let anchor: HTMLInputElement | null = null

function hide() {
  host?.remove()
  host = root = anchor = null
}

function place() {
  if (!host || !anchor) return
  const r = anchor.getBoundingClientRect()
  host.style.left = `${Math.max(4, r.left)}px`
  host.style.top = `${r.bottom + 4}px`
  host.style.width = `${Math.max(240, r.width)}px`
}

function show(field: HTMLInputElement, logins: Login[], offerNew: boolean) {
  hide()
  if (!logins.length && !offerNew) return
  anchor = field
  host = document.createElement('div')
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647'
  root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `<style>
    .box{font:13px/1.3 system-ui,sans-serif;background:#1e1f23;color:#e3e2e6;border:1px solid #44474e;border-radius:10px;
      box-shadow:0 12px 32px -8px rgb(0 0 0/.5);padding:4px;display:flex;flex-direction:column;gap:2px}
    button{all:unset;cursor:pointer;padding:8px 10px;border-radius:6px;display:flex;flex-direction:column;gap:2px}
    button:hover,button:focus-visible{background:#2f3036}
    small{color:#a8a8ae;font-size:11.5px}
  </style><div class="box"></div>`
  const box = root.querySelector('.box')!
  for (const l of logins) {
    const b = document.createElement('button')
    b.innerHTML = `<span></span><small>Saved password</small>`
    b.querySelector('span')!.textContent = l.username || '(no username)'
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', async (e) => {
      if (!e.isTrusted) return
      const pw = isPassword(field) ? field : passwordIn(field)
      const secret: string | null = await ipcRenderer.invoke('pw:fill', l.id)
      if (!secret || !pw) return hide()
      const user = userFor(pw)
      if (user && l.username) setValue(user, l.username)
      setValue(pw, secret)
      hide()
    })
    box.appendChild(b)
  }
  if (offerNew && isPassword(field)) {
    const b = document.createElement('button')
    b.innerHTML = `<span>Use a strong password</span><small>Drift will save it when you submit</small>`
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', async (e) => {
      if (!e.isTrusted) return
      const secret: string | null = await ipcRenderer.invoke('pw:generate')
      if (!secret) return hide()
      for (const p of scope(field).querySelectorAll('input[type=password]')) setValue(p as HTMLInputElement, secret)
      hide()
    })
    box.appendChild(b)
  }
  document.documentElement.appendChild(host)
  place()
}

async function onFocus(e: FocusEvent) {
  const el = e.target as Element
  if (!isPassword(el) && !(isUserField(el) && passwordIn(el as HTMLElement))) return
  const { logins } = (await ipcRenderer.invoke('pw:query')) as { logins: Login[] }
  if (document.activeElement !== el) return
  const pw = isPassword(el) ? el : passwordIn(el as HTMLElement)
  const signup = !!pw && (pw.autocomplete === 'new-password' || scope(pw).querySelectorAll('input[type=password]').length > 1)
  show(el as HTMLInputElement, logins, signup)
}

let lastSent = ''
function capture(from: Element | null) {
  const pw = from && (isPassword(from) ? from : passwordIn(from as HTMLElement))
  if (!pw || !pw.value) return
  const user = userFor(pw)
  const key = `${user?.value ?? ''}\u0000${pw.value}`
  if (key === lastSent) return
  lastSent = key
  ipcRenderer.send('pw:submitted', { username: user?.value ?? '', password: pw.value })
}

export function installAutofill() {
  document.addEventListener('focusin', (e) => void onFocus(e), true)
  document.addEventListener('focusout', () => setTimeout(() => {
    if (anchor && document.activeElement !== anchor) hide()
  }, 150), true)
  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide()
    if (e.key === 'Enter' && isPassword(e.target as Element)) capture(e.target as Element)
  }, true)
  document.addEventListener('submit', (e) => capture((e.target as HTMLFormElement).querySelector('input[type=password]')), true)
  // Sites that log in with a button and fetch() never fire submit.
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest?.('button, input[type=submit], [role=button]')
    if (btn) capture(btn.closest('form') ?? document.activeElement)
  }, true)
}
