import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { State, Transition, Pane, Rect, TabInfo, findTab, spring, swipeSpring, drift, host } from './store'
import { Sidebar, Favicon } from './Sidebar'

export type DropSide = 'left' | 'right' | 'top' | 'bottom' | 'center'

/** A pane drawn from its snapshot, or a calm placeholder when there is none yet. */
export function PaneCard({ pane, tab, className = '' }: { pane: Pane; tab?: TabInfo; className?: string }) {
  return (
    <div className={`pane ${className}`} style={{ position: 'absolute', inset: 0 }}>
      {pane.snap ? (
        <img className="snap" src={pane.snap} alt="" draggable={false} />
      ) : (
        <div className="waiting">
          {tab && (
            <div className="card">
              <Favicon tab={tab} size={24} />
              <span>{tab.title}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const box = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height })

/** Plays a main-process transition, then hands control back. */
export function Stage({ s, t, width, onDone }: { s: State; t: Transition; width: number; onDone: () => void }) {
  if (t.kind === 'workspace') return <Swipe s={s} t={t} width={width} onDone={onDone} />
  return <Morph s={s} t={t} onDone={onDone} />
}

function Swipe({ s, t, width, onDone }: { s: State; t: Transition; width: number; onDone: () => void }) {
  const dir: number = t.data?.dir || 1
  const from = s.workspaces.find((w) => w.id === t.data.from)
  const to = s.workspaces.find((w) => w.id === t.data.to)
  const pinned = s.settings.sidebarPinned
  const scene = (wsId: string | undefined, panes: Pane[], role: 'from' | 'to') => {
    const ws = s.workspaces.find((w) => w.id === wsId)
    if (!ws) return null
    const vars = ws.tokens as React.CSSProperties
    return (
      <motion.div
        className="scene"
        style={{ ...vars, color: 'var(--fg)' }}
        initial={{ x: role === 'from' ? 0 : dir * width }}
        animate={{ x: role === 'from' ? -dir * width : 0 }}
        transition={swipeSpring}
        onAnimationComplete={role === 'to' ? onDone : undefined}
      >
        {pinned && <Sidebar s={{ ...s, visible: panes.map(({ id, rect }) => ({ id, rect })) }} ws={ws} live={false} />}
        {panes.map((p) => (
          <motion.div
            key={p.id}
            style={{ position: 'absolute', ...box(p.rect), borderRadius: 10, overflow: 'hidden' }}
            initial={{ scale: role === 'to' ? 0.97 : 1 }}
            animate={{ scale: role === 'from' ? 0.97 : 1 }}
            transition={swipeSpring}
          >
            <PaneCard pane={p} tab={findTab(s, p.id)} />
          </motion.div>
        ))}
        {panes.length === 0 && <EmptyHint name={ws.name} area={emptyArea(s, width)} />}
      </motion.div>
    )
  }
  return (
    <div className="stage">
      {scene(from?.id, t.before, 'from')}
      {scene(to?.id, t.after, 'to')}
    </div>
  )
}

function Morph({ s, t, onDone }: { s: State; t: Transition; onDone: () => void }) {
  const before = new Map(t.before.map((p) => [p.id, p]))
  const pinnedAfter = s.settings.sidebarPinned
  // State pushes re-render this mid-animation; the ref keeps completion to exactly one call.
  const done = useRef(false)
  const finish = () => {
    if (done.current) return
    done.current = true
    onDone()
  }
  useEffect(() => {
    if (t.after.length > 0) return
    const timer = setTimeout(finish, 200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id])
  return (
    <div className="stage">
      {t.kind === 'sidebar' && (
        <motion.div
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          initial={{ x: pinnedAfter ? -s.sidebarWidth : 0, opacity: pinnedAfter ? 0 : 1 }}
          animate={{ x: pinnedAfter ? 0 : -s.sidebarWidth, opacity: pinnedAfter ? 1 : 0 }}
          transition={spring}
        >
          <Sidebar s={s} ws={s.workspaces.find((w) => w.id === s.activeWorkspaceId)!} live={false} />
        </motion.div>
      )}
      <AnimatePresence>
        {t.before.filter((p) => !t.after.some((a) => a.id === p.id)).map((p) => (
          <motion.div
            key={`out-${p.id}`}
            style={{ position: 'absolute', ...box(p.rect), borderRadius: 10, overflow: 'hidden' }}
            initial={{ opacity: 1, scale: 1 }}
            animate={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
          >
            <PaneCard pane={p} tab={findTab(s, p.id)} />
          </motion.div>
        ))}
      </AnimatePresence>
      {t.after.map((p, i) => {
        const was = before.get(p.id)
        const from = was ? box(was.rect) : { ...box(p.rect) }
        return (
          <motion.div
            key={p.id}
            style={{ position: 'absolute', borderRadius: 10, overflow: 'hidden' }}
            initial={{ ...from, opacity: was ? 1 : 0, scale: was ? 1 : 0.9 }}
            animate={{ ...box(p.rect), opacity: 1, scale: 1 }}
            transition={spring}
            onAnimationComplete={i === 0 ? finish : undefined}
          >
            <PaneCard pane={was?.snap && !p.snap ? was : p} tab={findTab(s, p.id)} />
          </motion.div>
        )
      })}
    </div>
  )
}

type Recent = { url: string; title: string }

export function EmptyHint({ name, area, onOpen }: { name: string; area: Rect; onOpen?: () => void }) {
  const [recent, setRecent] = useState<Recent[]>([])
  useEffect(() => {
    if (onOpen) drift.rpc<Recent[]>('history.recent', { limit: 8 }).then(setRecent)
  }, [onOpen])
  return (
    <div className="empty" style={box(area)}>
      <div className="inner">
        <h1>{name}</h1>
        {onOpen && recent.length === 0 && (
          <button className="btn" onClick={onOpen}>
            Open a page <span className="k">Ctrl T</span>
          </button>
        )}
        {recent.length > 0 && (
          <div className="recent">
            {recent.map((r, i) => (
              <motion.button
                key={r.url}
                className="recentrow"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring, delay: 0.03 * i }}
                onClick={() => drift.rpc('tabs.open', { url: r.url })}
              >
                <b>{r.title || host(r.url)}</b>
                <span>{host(r.url)}</span>
              </motion.button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function emptyArea(s: State, width: number, height = window.innerHeight): Rect {
  const left = s.settings.sidebarPinned ? s.sidebarWidth : s.gap
  return { x: left, y: s.gap, width: width - left - s.gap, height: height - 2 * s.gap }
}

/** Drop zones shown over frozen panes while a tab is dragged. */
export function DragPanes({ s, panes, target }: { s: State; panes: Pane[]; target: { id: string; side: DropSide } | null }) {
  return (
    <div className="stage" style={{ pointerEvents: 'none' }}>
      {panes.map((p) => (
        <div key={p.id} style={{ position: 'absolute', ...box(p.rect) }}>
          <PaneCard pane={p} tab={findTab(s, p.id)} className={target?.id === p.id ? `drop-${target.side}` : ''} />
        </div>
      ))}
    </div>
  )
}

export function sideAt(r: Rect, x: number, y: number): DropSide {
  const fx = (x - r.x) / r.width
  const fy = (y - r.y) / r.height
  const edges: [DropSide, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]]
  edges.sort((a, b) => a[1] - b[1])
  return edges[0][1] < 0.3 ? edges[0][0] : 'center'
}
