import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Rect, drift, host, spring } from './store'

type Login = { id: string; origin: string; username: string; lastUsed: number; timesUsed: number }

export function PasswordsView({ area, onClose, toast }: { area: Rect; onClose: () => void; toast: (m: string) => void }) {
  const [logins, setLogins] = useState<Login[]>([])
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const load = () => drift.rpc<Login[]>('pw.list').then(setLogins)
  useEffect(() => {
    drift.focusUi()
    input.current?.focus()
    load()
  }, [])
  const shown = logins
    .filter((l) => `${l.origin} ${l.username}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => host(a.origin).localeCompare(host(b.origin)))

  return (
    <motion.div
      className="memory passwords"
      style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.12 } }}
      transition={spring}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <header>
        <h2>
          Passwords<small>{logins.length} saved, encrypted with your system keyring</small>
        </h2>
        <div className="controls">
          <label>
            <input ref={input} className="filter" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button className="btn ghost" onClick={onClose}>Done</button>
        </div>
      </header>
      <div className="rows">
        {logins.length === 0 && <p className="none">Nothing saved yet. Drift offers to save a password when you sign in, or run Import from Brave.</p>}
        <AnimatePresence initial={false}>
          {shown.map((l) => (
            <motion.div layout="position" transition={spring} key={l.id} className="prow" exit={{ opacity: 0, x: -12 }}>
              <div className="info">
                <b>{host(l.origin)}</b>
                <span>{l.username || 'No username'}</span>
              </div>
              <button
                className="act"
                onClick={async () => {
                  await drift.rpc('pw.copy', { id: l.id })
                  toast(`Copied. The clipboard clears in 30 seconds.`)
                }}
              >
                Copy password
              </button>
              <button
                className="act danger"
                onClick={async () => {
                  await drift.rpc('pw.remove', { id: l.id })
                  load()
                }}
              >
                Delete
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
