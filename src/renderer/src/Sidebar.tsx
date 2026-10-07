import { useState, useRef, useEffect, Fragment } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { State, WorkspaceInfo, TabInfo, drift, findTab, host, formatMB, spring } from './store'

// Only heavy tabs show their memory in the list; the memory view has the rest.
const HEAVY_MB = 300

export type DragStart = (tab: TabInfo, e: React.PointerEvent) => void
type Props = {
  s: State
  ws: WorkspaceInfo
  live: boolean
  floating?: boolean
  onBar?: (mode: 'new' | 'edit') => void
  onMemory?: () => void
  onDragStart?: DragStart
  drop?: { index: number; wsId: string | null; essential: boolean } | null
  onLeave?: () => void
  barOpen?: boolean
}

export function Favicon({ tab, size = 16 }: { tab: Pick<TabInfo, 'favicon' | 'title' | 'url'>; size?: number }) {
  const [broken, setBroken] = useState(false)
  if (tab.favicon && !broken) return <img src={tab.favicon} width={size} height={size} alt="" draggable={false} onError={() => setBroken(true)} />
  const ch = (host(tab.url) || tab.title || '?').replace(/^www\./, '')[0]?.toUpperCase() ?? '?'
  return <span className="letter" style={{ width: size, height: size }}>{ch}</span>
}

export function Sidebar({ s, ws, live, floating, onBar, onMemory, onDragStart, drop, onLeave, barOpen }: Props) {
  const active = findTab(s, ws.activeTabId)
  const visible = new Set(s.visible.map((v) => v.id))
  const splitIds = new Set(ws.split ? leafIds(ws.split) : [])
  const [renaming, setRenaming] = useState(false)
  const dead = !live

  const tabRow = (t: TabInfo, i: number) => (
    <Fragment key={t.id}>
      {drop && !drop.essential && drop.wsId === ws.id && drop.index === i && <div className="dropline" />}
      <motion.div
        layout={live ? 'position' : false}
        transition={spring}
        initial={live ? { opacity: 0, x: -12 } : false}
        animate={{ opacity: 1, x: 0, scale: t.sleeping ? 0.985 : 1 }}
        exit={{ opacity: 0, x: -16, transition: { duration: 0.16 } }}
        className={`tab${t.id === ws.activeTabId ? ' active' : ''}${visible.has(t.id) ? ' visible' : ''}${t.sleeping ? ' sleeping' : ''}`}
        data-tab={t.id}
        data-index={i}
        role="button"
        tabIndex={dead ? -1 : 0}
        title={`${t.title}\n${t.url}${t.memoryMB ? `\n${formatMB(t.memoryMB)}` : t.sleeping ? '\nAsleep' : ''}`}
        onPointerDown={(e) => {
          if (dead || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
          onDragStart?.(t, e)
        }}
        onAuxClick={(e) => e.button === 1 && drift.rpc('tabs.close', { tabs: [t.id] })}
        onContextMenu={(e) => {
          e.preventDefault()
          if (!dead) drift.rpc('tabs.menu', { tab: t.id })
        }}
        onKeyDown={(e) => e.key === 'Enter' && drift.rpc('tabs.focus', { tab: t.id })}
      >
        <span className="fav"><Favicon tab={t} /></span>
        <span className="title">{t.title || host(t.url)}</span>
        {t.agent ? (
          <span className="agentmark" title="Claude is working in this tab">Claude</span>
        ) : t.audible || t.muted ? (
          <button className="audio" onClick={() => drift.rpc('tabs.mute', { tab: t.id })}>{t.muted ? 'Muted' : 'Playing'}</button>
        ) : t.crashed ? (
          <span className="meta">Crashed</span>
        ) : !t.sleeping && t.memoryMB >= HEAVY_MB ? (
          <span className="meta">{formatMB(t.memoryMB)}</span>
        ) : null}
        <button className="close" aria-label={`Close ${t.title}`} onClick={() => drift.rpc('tabs.close', { tabs: [t.id] })}>×</button>
        {t.loading && <span className="loadbar" />}
      </motion.div>
    </Fragment>
  )

  // Tabs in the current split render as one joined group, in tab order.
  const rows: React.ReactNode[] = []
  const members = ws.tabs.map((t, i) => [t, i] as const).filter(([t]) => splitIds.has(t.id))
  ws.tabs.forEach((t, i) => {
    if (members.length > 1 && splitIds.has(t.id)) {
      if (members[0][0].id === t.id) {
        rows.push(
          <motion.div layout={live ? 'position' : false} transition={spring} className="splitgroup" key="splitgroup">
            {members.map(([m, mi]) => tabRow(m, mi))}
          </motion.div>,
        )
      }
    } else {
      rows.push(tabRow(t, i))
    }
  })

  const secure = active ? /^https:|^drift:|^file:|^about:/.test(active.url) : true
  const [installing, setInstalling] = useState(false)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [added, setAdded] = useState<string[]>([])
  const storeMatch = active?.url.match(/^https:\/\/chromewebstore\.google\.com\/detail\/[^/]*\/([a-p]{32})/)
  const storeId = storeMatch && !added.includes(storeMatch[1]) ? storeMatch[1] : null
  useEffect(() => {
    if (!storeId || !live) return
    void drift.rpc<{ storeId: string | null }[]>('ext.list').then((list) => {
      if (list.some((e) => e.storeId === storeId)) setAdded((a) => [...a, storeId])
    })
  }, [storeId, live])
  const storeName = active?.title.replace(/\s*[-|]\s*Chrome Web Store\s*$/i, '') || 'this extension'

  return (
    <div className={`sidebar${floating ? ' floating' : ''}`} onMouseLeave={onLeave} data-ws={ws.id}>
      <div className="drag-region" />
      {barOpen ? (
        <div className="urlpill" style={{ visibility: 'hidden' }} />
      ) : live && onBar ? (
        <motion.button layoutId="omnibar" transition={spring} className="urlpill" style={{ borderRadius: 10 }} onClick={() => onBar('edit')} disabled={!live}>
          {active ? (
            <>
              {!secure && <span className="insecure">Not secure</span>}
              <span className="host">{host(active.url)}</span>
              {active.zoom !== 1 && <span className="zoom">{Math.round(active.zoom * 100)}%</span>}
            </>
          ) : (
            <span className="path">Search or enter address</span>
          )}
        </motion.button>
      ) : (
        <div className="urlpill"><span className="host">{active ? host(active.url) : ''}</span></div>
      )}

      <AnimatePresence>
        {live && s.prompt && (
          <motion.div
            key={s.prompt.id}
            className="prompt"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
          >
            <p><b>{s.prompt.origin.replace(/^https?:\/\//, '')}</b> wants to {PERMISSION_TEXT[s.prompt.permission] ?? `use ${s.prompt.permission}`}.</p>
            <div className="row">
              <button className="btn ghost" onClick={() => drift.rpc('prompt.answer', { id: s.prompt!.id, ok: false })}>Block</button>
              <button className="btn" onClick={() => drift.rpc('prompt.answer', { id: s.prompt!.id, ok: true })}>Allow</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {live &&
          (s.agentRuns ?? []).map((r) => (
            <motion.div key={r.id} className={`run ${r.status}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
              <div className="runhead">
                <b>{r.status === 'running' ? 'Claude is working' : r.status === 'done' ? 'Claude finished' : r.status === 'stopped' ? 'Stopped' : 'Claude couldn’t finish'}</b>
                {r.status === 'running' ? (
                  <button className="btn ghost small" onClick={() => drift.rpc('agent.stop', { id: r.id })}>Stop</button>
                ) : (
                  <button className="btn ghost small" onClick={() => drift.rpc('agent.dismiss', { id: r.id })}>Dismiss</button>
                )}
              </div>
              <p className="task">{r.prompt}</p>
              <p
                className={`step${openRun === r.id ? ' open' : ''}`}
                title={openRun === r.id ? 'Show less' : 'Show all'}
                onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
              >
                {r.status === 'running' ? r.steps[r.steps.length - 1] ?? 'Starting' : openRun === r.id ? r.result : r.result?.replace(/\n{2,}/g, '\n')}
              </p>
            </motion.div>
          ))}
      </AnimatePresence>

      <AnimatePresence>
        {live && s.updateReady && (
          <motion.div key="update" className="prompt" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <p>A new version of Drift is ready. Your tabs come back after a restart.</p>
            <div className="row">
              <button className="btn" onClick={() => drift.rpc('app.restart')}>Restart</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {live && s.savePrompt && (
          <motion.div key={s.savePrompt.id} className="prompt" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <p>
              {s.savePrompt.update ? 'Update' : 'Save'} password for <b>{host(s.savePrompt.origin)}</b>
              {s.savePrompt.username && <> as <b>{s.savePrompt.username}</b></>}?
            </p>
            <div className="row">
              <button className="btn ghost" onClick={() => drift.rpc('pw.answer', { id: s.savePrompt!.id, save: false })}>Not now</button>
              <button className="btn" onClick={() => drift.rpc('pw.answer', { id: s.savePrompt!.id, save: true })}>{s.savePrompt.update ? 'Update' : 'Save'}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {live && storeId && (
          <motion.div key={storeId} className="prompt" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <p>Add <b>{storeName}</b> to Drift?</p>
            <div className="row">
              <button
                className="btn"
                disabled={installing}
                onClick={async () => {
                  setInstalling(true)
                  try {
                    await drift.rpc('ext.load', { path: storeId })
                    setAdded((a) => [...a, storeId])
                  } finally {
                    setInstalling(false)
                  }
                }}
              >
                {installing ? 'Installing' : 'Add to Drift'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {(s.essentials.length > 0 || (drop?.essential ?? false)) && (
        <div className="essentials" data-essentials>
          {s.essentials.map((t, i) => (
            <Fragment key={t.id}>
            <button
              data-pin={i}
              // The drop marker is drawn beside a pin, never as a slot: a slot shifts the pins under the pointer.
              className={`essential${t.id === ws.activeTabId ? ' active' : ''}${t.sleeping ? ' sleeping' : ''}${
                drop?.essential && drop.index === i ? ' dropbefore' : ''
              }${drop?.essential && i === s.essentials.length - 1 && drop.index >= s.essentials.length ? ' dropafter' : ''}`}
              title={t.title}
              tabIndex={dead ? -1 : 0}
              onPointerDown={(e) => !dead && e.button === 0 && onDragStart?.(t, e)}
              onAuxClick={(e) => e.button === 1 && drift.rpc('tabs.essential', { tab: t.id, on: false })}
              onContextMenu={(e) => {
                e.preventDefault()
                if (!dead) drift.rpc('tabs.menu', { tab: t.id })
              }}
            >
              <Favicon tab={t} size={20} />
            </button>
            </Fragment>
          ))}
          {drop?.essential && s.essentials.length === 0 && <div className="essential slot" />}
        </div>
      )}

      <div className="wshead">
        {renaming && live ? (
          <span className="wsname">
            <input
              autoFocus
              defaultValue={ws.name}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  drift.rpc('ws.rename', { target: ws.id, name: e.currentTarget.value.trim() || ws.name })
                  setRenaming(false)
                }
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          </span>
        ) : (
          <button className="wsname" tabIndex={dead ? -1 : 0} onDoubleClick={() => setRenaming(true)} title="Double-click to rename">{ws.name}</button>
        )}
      </div>

      <button className="newtab" tabIndex={dead ? -1 : 0} title="New tab (Ctrl T)" onClick={() => onBar?.('new')}>
        <span className="plus">+</span> New tab
      </button>

      <div className="tablist" data-tablist={ws.id}>
        <AnimatePresence initial={false}>{rows}</AnimatePresence>
        {drop && !drop.essential && drop.wsId === ws.id && drop.index >= ws.tabs.length && <div className="dropline" />}
      </div>

      <Footer s={s} ws={ws} live={live} onMemory={onMemory} drop={drop} />
    </div>
  )
}

function Footer({ s, ws, live, onMemory, drop }: { s: State; ws: WorkspaceInfo; live: boolean; onMemory?: () => void; drop?: Props['drop'] }) {
  const awake = s.workspaces.flatMap((w) => w.tabs).concat(s.essentials).filter((t) => !t.sleeping).length
  const actionsRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div className="footer">
      {s.downloads.length > 0 && (
        <div className="downloads">
          {s.downloads.slice(0, 3).map((d) => (
            <div className="download" key={d.id}>
              <span className="name" title={d.path}>{d.name}</span>
              <span className="acts">
                {d.state === 'completed' ? (
                  <>
                    <button onClick={() => drift.rpc('downloads.action', { id: d.id, action: 'open' })}>Open</button>
                    <button onClick={() => drift.rpc('downloads.action', { id: d.id, action: 'show' })}>Show</button>
                  </>
                ) : d.state === 'progressing' ? (
                  <button onClick={() => drift.rpc('downloads.action', { id: d.id, action: 'cancel' })}>Cancel</button>
                ) : (
                  <span>{d.state === 'cancelled' ? 'Cancelled' : 'Failed'}</span>
                )}
                <button aria-label="Dismiss" onClick={() => drift.rpc('downloads.action', { id: d.id, action: 'dismiss' })}>×</button>
              </span>
              {d.state === 'progressing' && (
                <span className="bar"><i style={{ width: d.total ? `${(100 * d.received) / d.total}%` : '30%' }} /></span>
              )}
            </div>
          ))}
        </div>
      )}
      {live && <div ref={actionsRef}><browser-action-list partition="persist:drift" alignment="top right" /></div>}
      <div className="wsbar" data-wsbar>
        {s.workspaces.map((w) => (
          <button
            key={w.id}
            data-wschip={w.id}
            tabIndex={live ? 0 : -1}
            className={`wschip${w.id === ws.id ? ' active' : ''}${drop && drop.wsId === w.id && w.id !== ws.id ? ' droptarget' : ''}`}
            onClick={() => live && editing !== w.id && drift.rpc('ws.switch', { target: w.id })}
            onDoubleClick={() => live && setEditing(w.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              if (live) drift.rpc('ws.menu', { target: w.id })
            }}
            title={`${w.name} · ${w.tabs.length} tabs. Double-click to rename, right-click for more.`}
          >
            {w.id === ws.id && live && <motion.span layoutId="wschip-bg" className="bg" transition={spring} />}
            {w.id === ws.id && !live && <span className="bg" />}
            {editing === w.id ? (
              <input
                className="n chipedit"
                autoFocus
                defaultValue={w.name}
                size={Math.max(4, w.name.length)}
                onFocus={(e) => {
                  drift.focusUi()
                  e.currentTarget.select()
                }}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim()
                  if (name && name !== w.name) drift.rpc('ws.rename', { target: w.id, name })
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    e.currentTarget.value = w.name
                    e.currentTarget.blur()
                  }
                }}
              />
            ) : (
              <span className="n">{w.name}</span>
            )}
          </button>
        ))}
        <button className="wsadd" aria-label="New workspace" tabIndex={live ? 0 : -1} onClick={() => drift.rpc('ws.create', { name: `Space ${s.workspaces.length + 1}` })}>+</button>
      </div>
      <div className="ledger">
        <button onClick={onMemory} tabIndex={live ? 0 : -1}>{formatMB(s.totalMB)} · {awake} awake</button>
        <button onClick={() => drift.rpc('adblock.set', { enabled: !s.adblock.enabled })} tabIndex={live ? 0 : -1} title="Toggle ad and tracker blocking">
          {s.adblock.enabled ? `${s.adblock.total.toLocaleString()} blocked` : 'Blocking off'}
        </button>
      </div>
    </div>
  )
}

const PERMISSION_TEXT: Record<string, string> = {
  media: 'use your camera or microphone',
  microphone: 'use your microphone',
  camera: 'use your camera',
  'camera and microphone': 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
  'clipboard-read': 'read your clipboard',
  openExternal: 'open an external app',
  'display-capture': 'share your screen',
  hid: 'use HID devices',
  serial: 'use serial ports',
  usb: 'use USB devices',
}

function leafIds(t: NonNullable<WorkspaceInfo['split']>): string[] {
  return t.kind === 'leaf' ? [t.tabId] : t.children.flatMap(leafIds)
}

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'browser-action-list': { partition?: string; alignment?: string; tab?: string }
    }
  }
}
