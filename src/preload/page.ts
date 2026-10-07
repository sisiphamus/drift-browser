// Runs in every page frame (isolated world).
import { contextBridge, ipcRenderer } from 'electron'
import { SwipeTracker } from '../main/swipe'
import { installAutofill } from './autofill'
import { presentAsFirefox, ACCOUNTS } from '../main/signin'

installAutofill()

// Two-finger swipe switches spaces, unless the page wants the gesture: it handled the wheel itself, or something
// under the pointer can still scroll that way (carousels, maps, sheets, wide tables).
function canScrollX(from: EventTarget | null, dir: number): boolean {
  for (let el = from instanceof Element ? from : null; el; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue
    const root = el === document.scrollingElement || el === document.body
    if (!root && !/auto|scroll|overlay/.test(getComputedStyle(el).overflowX)) continue
    if (dir > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true
  }
  return false
}
const swipe = new SwipeTracker()
window.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.defaultPrevented || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return
    if (canScrollX(e.target, Math.sign(e.deltaX))) return
    const dir = swipe.feed(e.deltaX, e.deltaY, e.timeStamp)
    if (dir) ipcRenderer.send('page:swipe', dir)
  },
  { passive: true },
)

// executeInMainWorld runs synchronously, before any of the page's own scripts. Its return value crosses
// worlds, so these return nothing; and a failure here must never take the rest of the preload down.
function inMainWorld(func: (...args: string[]) => void, args: string[] = []) {
  try {
    contextBridge.executeInMainWorld({ func, args })
  } catch (e) {
    console.warn('[drift] main-world script failed:', e)
  }
}

// Global Privacy Control, matching the Sec-GPC header the session sends.
inMainWorld(() => {
  Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true })
})
inMainWorld(presentAsFirefox, [ACCOUNTS.source])

if (window.top === window) {
  // Mouse back/forward buttons (Electron doesn't surface them on Linux).
  window.addEventListener(
    'mouseup',
    (e) => {
      if (e.button === 3) history.back()
      else if (e.button === 4) history.forward()
      else return
      e.preventDefault()
    },
    true,
  )
}
