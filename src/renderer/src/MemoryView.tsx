import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { State, Rect, drift, formatMB, host, spring } from './store'
import { Favicon } from './Sidebar'

export function MemoryView({ s, area, onClose }: { s: State; area: Rect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
    drift.rpc('tabs.thumbs')
  }, [])
  const tabs = s.workspaces.flatMap((w) => w.tabs.map((t) => ({ t, ws: w.name }))).concat(s.essentials.map((t) => ({ t, ws: 'Essentials' })))
  tabs.sort((a, b) => Number(a.t.sleeping) - Number(b.t.sleeping) || b.t.memoryMB - a.t.memoryMB || b.t.lastActive - a.t.lastActive)
  const awake = tabs.filter((x) => !x.t.sleeping)
  const max = Math.max(1, ...tabs.map((x) => x.t.memoryMB))
  const visible = new Set(s.visible.map((v) => v.id))

  const setNum = (key: 'idleMinutes' | 'memoryCapMB', v: string) => {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) drift.rpc('settings.set', { [key]: n })
  }

  return (
    <motion.div
      ref={ref}
      tabIndex={-1}
      className="memory"
      style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.15 } }}
      transition={spring}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <header>
        <h2>
          {formatMB(s.totalMB)}
          <small>{awake.length} awake · {tabs.length - awake.length} asleep</small>
        </h2>
        <div className="controls">
          <label>
            Sleep after
            <input defaultValue={s.settings.idleMinutes} onBlur={(e) => setNum('idleMinutes', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
            min
          </label>
          <label>
            Memory cap
            <input defaultValue={s.settings.memoryCapMB} onBlur={(e) => setNum('memoryCapMB', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
            MB
          </label>
          <button className="btn ghost" onClick={() => drift.rpc('tabs.sleep', { tab: 'all-idle' })}>Sleep hidden tabs</button>
          <button className="btn ghost" onClick={onClose}>Done</button>
        </div>
      </header>
      <div className="rows">
        <AnimatePresence initial={false}>
          {tabs.map(({ t, ws }) => (
            <motion.div layout="position" transition={spring} key={t.id} className={`mrow${t.sleeping ? ' asleep' : ''}`}>
              <button className="thumb" onClick={() => { drift.rpc('tabs.focus', { tab: t.id }); onClose() }} aria-label={`Open ${t.title}`}>
                {t.thumb ? <img className="shot" src={t.thumb} alt="" /> : <span className="icon"><Favicon tab={t} size={22} /></span>}
              </button>
              <div className="info">
                <b>{t.title || host(t.url)}</b>
                <span>{ws} · {host(t.url)}{visible.has(t.id) ? ' · on screen' : t.audible ? ' · playing' : ''}</span>
              </div>
              <div className="meter">
                <span>{t.sleeping ? 'Asleep' : t.memoryMB ? formatMB(t.memoryMB) : 'Measuring'}</span>
                {!t.sleeping && <span className="track"><motion.i initial={false} animate={{ width: `${(100 * t.memoryMB) / max}%` }} transition={spring} /></span>}
              </div>
              {t.sleeping ? (
                <button className="act" onClick={() => drift.rpc('tabs.wake', { tab: t.id })}>Wake</button>
              ) : visible.has(t.id) || t.audible ? (
                <span />
              ) : (
                <button className="act" onClick={() => drift.rpc('tabs.sleep', { tab: t.id })}>Sleep</button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
