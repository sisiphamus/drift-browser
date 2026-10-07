import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useDrift, drift, activeWs, State, Transition, Pane, Rect, TabInfo, spring, host } from './store'
import { Sidebar } from './Sidebar'
import { CommandBar, BarMode } from './CommandBar'
import { Stage, DragPanes, EmptyHint, emptyArea, sideAt, DropSide } from './Stage'
import { MemoryView } from './MemoryView'
import { PasswordsView } from './PasswordsView'
import { SettingsView } from './SettingsView'
import { computeRects, nodeBox } from '../../main/layout'
import { SwipeTracker } from '../../main/swipe'

type Drag = {
  tab: TabInfo
  x: number
  y: number
  panes: Pane[] | null
  pane: { id: string; side: DropSide } | null
  list: { index: number; wsId: string | null; essential: boolean } | null
}

const FIND_H = 48

export function App() {
  const s = useDrift()
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [bar, setBar] = useState<BarMode | null>(null)
  const [barWs, setBarWs] = useState<string | null>(null)
  const [memory, setMemory] = useState(false)
  const [passwords, setPasswords] = useState(false)
  const [settings, setSettings] = useState(false)
  const [hover, setHover] = useState(false)
  // A native menu takes the pointer; the tucked sidebar must not read that as the mouse leaving.
  const menuOpen = useRef(false)
  const [transition, setTransition] = useState<Transition | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number>(0)
  const pending = useRef<{ tab: TabInfo; x: number; y: number } | null>(null)

  const say = useCallback((msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3200)
  }, [])

  useEffect(() => {
    const r = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', r)
    return () => window.removeEventListener('resize', r)
  }, [])

  // Shortcuts that land in the UI.
  useEffect(
    () =>
      drift.onAction((a) => {
        const [name, arg] = a.split(':')
        if (name === 'ws.rename' || name === 'ws.delete') {
          setBarWs(arg ?? null)
          return setBar(name === 'ws.rename' ? 'rename' : 'confirm-delete')
        }
        if (a.startsWith('toast:')) return say(a.slice(6))
        if (a === 'menu.open') return void (menuOpen.current = true)
        if (a === 'menu.closed') return void (menuOpen.current = false)
        if (a === 'bar.new') return setBar('new')
        if (a === 'bar.edit') return setBar('edit')
        if (a === 'memory') return setMemory((m) => !m)
        if (a === 'settings') return setSettings((v) => !v)
        if (a === 'find.open') {
          drift.rpc('find.query', { text: '' })
          return setTimeout(() => document.querySelector<HTMLInputElement>('.findbar input')?.focus(), 30)
        }
        if (a === 'escape') {
          setBar(null)
          setMemory(false)
          setPasswords(false)
          setSettings(false)
          setHover(false)
        }
      }),
    [],
  )

  useEffect(() => drift.onTransition((t) => setTransition(t as Transition)), [])
  // Main always announces the end, so a missed animation callback can't leave the UI stuck.
  const [overlayNonce, setOverlayNonce] = useState(0)
  useEffect(
    () =>
      drift.onTransitionEnd((id) => {
        setTransition((t) => (t && t.id === id ? null : t))
        setOverlayNonce((n) => n + 1)
      }),
    [],
  )

  const needOverlay = !!bar || memory || passwords || settings || hover || !!drag?.panes || !!s?.popup
  // Permission prompts live in the sidebar; reveal it when it is tucked away.
  useEffect(() => {
    if (s?.prompt && !s.settings.sidebarPinned) setHover(true)
  }, [s?.prompt?.id, s?.settings.sidebarPinned])
  useEffect(() => {
    if (!transition) drift.overlay(needOverlay)
  }, [needOverlay, transition, overlayNonce])

  // ---- drag a tab: reorder, move between spaces, pin, or tile onto the page
  const onDragStart = useCallback((tab: TabInfo, e: React.PointerEvent) => {
    pending.current = { tab, x: e.clientX, y: e.clientY }
  }, [])

  useEffect(() => {
    const move = async (e: PointerEvent) => {
      const p = pending.current
      if (p && !drag) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return
        pending.current = null
        setDrag({ tab: p.tab, x: e.clientX, y: e.clientY, panes: null, pane: null, list: null })
        const panes = await drift.freeze()
        setDrag((d) => d && { ...d, panes })
        return
      }
      if (!drag) return
      setDrag((d) => d && { ...d, x: e.clientX, y: e.clientY, ...targetsAt(e.clientX, e.clientY, d) })
    }
    const up = async (e: PointerEvent) => {
      const p = pending.current
      pending.current = null
      if (p && !drag) {
        if (e.button === 0) drift.rpc('tabs.focus', { tab: p.tab.id })
        return
      }
      if (!drag) return
      const d = { ...drag, ...targetsAt(e.clientX, e.clientY, drag) }
      setDrag(null)
      const ws = s && activeWs(s)
      try {
        if (d.pane && ws) {
          const alone = d.panes?.length === 1 && d.panes[0].id === d.tab.id
          if (!alone && d.pane.id !== d.tab.id) {
            if (d.pane.side === 'center') await drift.rpc('tabs.focus', { tab: d.tab.id })
            else await drift.rpc('split.add', { target: d.pane.id, tab: d.tab.id, side: d.pane.side })
          }
        } else if (d.list?.essential) {
          await drift.rpc('tabs.essential', { tab: d.tab.id, on: true, index: d.list.index })
        } else if (d.list) {
          await drift.rpc('tabs.move', { tab: d.tab.id, workspace: d.list.wsId, index: d.list.index })
        }
      } catch (err) {
        say((err as Error).message)
      }
      drift.thaw()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, s, say])

  // ---- trackpad swipe over the sidebar switches spaces
  const swipe = useRef(new SwipeTracker())
  const onWheel = (e: React.WheelEvent) => {
    const dir = swipe.current.feed(e.deltaX, e.deltaY, performance.now())
    if (dir) drift.rpc('ws.switch', { target: dir })
  }

  if (!s) return null
  const ws = activeWs(s)
  const pinned = s.settings.sidebarPinned
  const area = emptyArea(s, size.w, size.h)
  const findPane = s.find && s.visible.find((v) => v.id === s.find!.tabId)
  const dividers = ws.split && s.visible.length > 1 && !transition && !drag ? computeRects(ws.split, area, s.gap).dividers : []

  return (
    <div
      className={`app${s.settings.glass ? ' glass' : ''}`}
      style={{ ...(ws.tokens as React.CSSProperties), ['--sbw' as string]: `${s.sidebarWidth}px` }}
      onMouseMove={(e) => {
        if (!pinned && !hover && !drag && e.clientX <= s.gap + 2 && !transition) setHover(true)
      }}
    >
      {/* Holes where live pages sit, so raising the UI above them never hides them. */}
      <div className="ground" style={{ clipPath: !transition && !drag?.panes && !s.fullscreen ? holes(size.w, size.h, s.visible.map((v) => v.rect)) : undefined }}>
        <div className="backdrop" />
        <div className="tint" />
      </div>

      {!transition && (
        <>
          {s.visible.length === 0 && !s.fullscreen && <EmptyHint name={ws.name} area={area} onOpen={() => setBar('new')} />}

          {pinned && !s.fullscreen && (
            <div onWheel={onWheel}>
              <Sidebar s={s} ws={ws} live onBar={setBar} onMemory={() => setMemory(true)} onDragStart={onDragStart} drop={drag?.list ?? null} barOpen={!!bar} />
            </div>
          )}
          <AnimatePresence onExitComplete={() => drift.focusPage()}>
            {!pinned && (hover || (drag && !drag.panes)) && (
              <motion.div
                key="float"
                style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                initial={{ x: -s.sidebarWidth - 20 }}
                animate={{ x: 0 }}
                exit={{ x: -s.sidebarWidth - 20 }}
                transition={spring}
                onWheel={onWheel}
              >
                <div style={{ pointerEvents: 'auto' }}>
                  <Sidebar s={s} ws={ws} live floating onBar={setBar} onMemory={() => setMemory(true)} onDragStart={onDragStart} drop={drag?.list ?? null} barOpen={!!bar} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {hover && !pinned && (
            <div
              style={{ position: 'absolute', inset: 0, zIndex: 5 }}
              onMouseDown={() => setHover(false)}
              // Close only once the pointer is clearly past the panel, never while it slides in under the cursor.
              onMouseMove={(e) => !menuOpen.current && !drag && e.clientX > s.sidebarWidth + 24 && setHover(false)}
            />
          )}

          {dividers.map((d) => (
            <Divider key={`${d.path.join('.')}-${d.index}`} d={d} onDrag={(px) => {
              const parent = nodeBox(ws.split!, area, s.gap, d.path)
              const span = (d.dir === 'row' ? parent.width : parent.height) - s.gap
              drift.rpc('split.resize', { path: d.path, index: d.index, delta: px / span })
            }} />
          ))}

          {s.find && findPane && (
            <FindBar s={s} rect={{ x: findPane.rect.x, y: findPane.rect.y - FIND_H, width: findPane.rect.width, height: FIND_H }} />
          )}
        </>
      )}

      {drag?.panes && <DragPanes s={s} panes={drag.panes} target={drag.pane} />}
      {drag && (
        <div className="dragchip" style={{ left: Math.min(drag.x + 12, size.w - 268), top: Math.min(drag.y - 18, size.h - 44) }}>
          {drag.tab.favicon && <img src={drag.tab.favicon} alt="" />}
          <span>{drag.tab.title}</span>
        </div>
      )}

      {transition && (
        <Stage
          s={s}
          t={transition}
          width={size.w}
          onDone={() => {
            setTransition(null)
            drift.transitionDone(transition.id)
          }}
        />
      )}

      <AnimatePresence>
        {bar && !transition && (
          <CommandBar key="bar" s={s} mode={bar} area={area} onClose={() => { setBar(null); setBarWs(null) }} onMode={setBar} toast={say} onMemory={() => setMemory(true)} onPasswords={() => setPasswords(true)} onSettings={() => setSettings(true)} targetWs={barWs} />
        )}
      </AnimatePresence>
      <AnimatePresence>{memory && !transition && <MemoryView key="mem" s={s} area={area} onClose={() => setMemory(false)} />}</AnimatePresence>
      <AnimatePresence>{passwords && !transition && <PasswordsView key="pw" area={area} onClose={() => setPasswords(false)} toast={say} />}</AnimatePresence>
      <AnimatePresence>
        {settings && !transition && (
          <SettingsView key="settings" s={s} area={area} onClose={() => setSettings(false)} toast={say} onPasswords={() => setPasswords(true)} onMemory={() => setMemory(true)} />
        )}
      </AnimatePresence>


      <AnimatePresence>
        {s.popup && (
          <motion.div key={s.popup.id} className="popup-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            <div className="popup-dim" onMouseDown={() => drift.rpc('popup.close')} />
            <motion.div
              className="popup-card"
              style={{ left: s.popup.rect.x, top: s.popup.rect.y - s.popup.header, width: s.popup.rect.width, height: s.popup.rect.height + s.popup.header }}
              initial={{ scale: 0.97, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              transition={spring}
            >
              <div className="popup-head" style={{ height: s.popup.header }}>
                <span className="lock">{s.popup.url.startsWith('https:') ? '' : 'Not secure '}</span>
                <b>{host(s.popup.url)}</b>
                <span className="t">{s.popup.title}</span>
                <button className="btn ghost small" onClick={() => drift.rpc('popup.close')}>Close</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div className="toast" key={toast} initial={{ opacity: 0, y: 10, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 6, x: '-50%' }} transition={spring}>
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )

  function targetsAt(x: number, y: number, d: Drag): Pick<Drag, 'pane' | 'list'> {
    const el = document.elementsFromPoint(x, y)
    const chip = el.find((n) => (n as HTMLElement).dataset?.wschip) as HTMLElement | undefined
    if (chip) return { pane: null, list: { index: 999, wsId: chip.dataset.wschip!, essential: false } }
    const pins = el.find((n) => (n as HTMLElement).dataset?.essentials !== undefined) as HTMLElement | undefined
    if (pins) {
      // Pins flow in rows: the slot is before the first pin whose centre is past the pointer on this row.
      const buttons = [...pins.querySelectorAll<HTMLElement>('[data-pin]')]
      let index = buttons.length
      for (const [i, p] of buttons.entries()) {
        const r = p.getBoundingClientRect()
        if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) {
          index = i
          break
        }
      }
      return { pane: null, list: { index, wsId: null, essential: true } }
    }
    const list = el.find((n) => (n as HTMLElement).dataset?.tablist) as HTMLElement | undefined
    if (list) {
      const rows = [...list.querySelectorAll<HTMLElement>('[data-index]')]
      let index = rows.length
      for (const r of rows) {
        const b = r.getBoundingClientRect()
        if (y < b.top + b.height / 2) {
          index = Number(r.dataset.index)
          break
        }
      }
      return { pane: null, list: { index, wsId: list.dataset.tablist!, essential: false } }
    }
    const pane = d.panes?.find((p) => x >= p.rect.x && x <= p.rect.x + p.rect.width && y >= p.rect.y && y <= p.rect.y + p.rect.height)
    if (pane) return { pane: { id: pane.id, side: sideAt(pane.rect, x, y) }, list: null }
    return { pane: null, list: null }
  }
}

function holes(w: number, h: number, rects: Rect[], r = 10): string | undefined {
  if (!rects.length) return undefined
  const cut = rects
    .map(({ x, y, width: rw, height: rh }) =>
      `M${x + r} ${y}H${x + rw - r}A${r} ${r} 0 0 1 ${x + rw} ${y + r}V${y + rh - r}A${r} ${r} 0 0 1 ${x + rw - r} ${y + rh}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + rh - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`,
    )
    .join('')
  return `path(evenodd, "M0 0H${w}V${h}H0Z${cut}")`
}


function Divider({ d, onDrag }: { d: { dir: 'row' | 'col'; rect: Rect }; onDrag: (px: number) => void }) {
  const last = useRef(0)
  const frame = useRef(0)
  const acc = useRef(0)
  return (
    <div
      className={`divider ${d.dir}`}
      style={{ left: d.rect.x, top: d.rect.y, width: d.rect.width, height: d.rect.height }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        last.current = d.dir === 'row' ? e.clientX : e.clientY
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const pos = d.dir === 'row' ? e.clientX : e.clientY
        acc.current += pos - last.current
        last.current = pos
        if (frame.current) return
        frame.current = requestAnimationFrame(() => {
          frame.current = 0
          onDrag(acc.current)
          acc.current = 0
        })
      }}
    />
  )
}

function FindBar({ s, rect }: { s: State; rect: Rect }) {
  const f = s.find!
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    drift.focusUi()
    ref.current?.focus()
  }, [])
  return (
    <div className="findbar" style={{ left: rect.x, top: rect.y + 4, width: rect.width }}>
      <input
        ref={ref}
        placeholder="Find in page"
        defaultValue={f.text}
        onChange={(e) => drift.rpc('find.query', { text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') drift.rpc('find.query', { text: e.currentTarget.value, forward: !e.shiftKey, next: true })
          if (e.key === 'Escape') drift.rpc('find.stop')
        }}
      />
      {f.text && <span className="count">{f.total ? `${f.active} of ${f.total}` : 'No matches'}</span>}
      <button onClick={() => drift.rpc('find.query', { text: f.text, forward: false, next: true })}>Previous</button>
      <button onClick={() => drift.rpc('find.query', { text: f.text, forward: true, next: true })}>Next</button>
      <button onClick={() => drift.rpc('find.stop')}>Done</button>
    </div>
  )
}
