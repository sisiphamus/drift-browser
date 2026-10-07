import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { State, SearchResult, drift, findTab, activeWs, spring, Rect } from './store'
import { Favicon } from './Sidebar'

export type BarMode = 'new' | 'edit' | 'rename' | 'ext' | 'confirm-delete' | 'ask'
type Props = { s: State; mode: BarMode; area: Rect; onClose: () => void; onMode: (m: BarMode) => void; toast: (msg: string) => void; onMemory: () => void; onPasswords: () => void; onSettings: () => void; targetWs?: string | null }

const KIND_LABEL: Record<string, string> = { url: 'Go to', tab: 'Switch to tab', history: 'History', bookmark: 'Bookmark', command: 'Command', search: 'Search Google' }
const PLACEHOLDER: Record<BarMode, string> = {
  new: 'Search or enter address',
  edit: 'Search or enter address',
  rename: 'Workspace name',
  ext: 'Web Store link or id, .crx file, or unpacked folder',
  ask: 'Ask Claude to do something in Drift',
  'confirm-delete': '',
}

export function CommandBar({ s, mode, area, onClose, onMode, toast, onMemory, onPasswords, onSettings, targetWs }: Props) {
  // Rename and delete act on the space they were asked for, else the current one.
  const ws = s.workspaces.find((w) => w.id === targetWs) ?? activeWs(s)
  const active = findTab(s, ws.activeTabId)
  const initial = mode === 'edit' ? active?.url ?? '' : mode === 'rename' ? ws.name : ''
  const [q, setQ] = useState(initial)
  const [results, setResults] = useState<SearchResult[]>([])
  const [sel, setSel] = useState(0)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const typed = useRef(false)
  const searching = mode === 'new' || mode === 'edit'

  useEffect(() => {
    input.current?.focus()
    if (mode === 'edit' || mode === 'rename') input.current?.select()
  }, [mode])

  useEffect(() => {
    if (!searching) return
    let stale = false
    // In edit mode the prefilled url shouldn't search until the user types.
    const query = mode === 'edit' && !typed.current ? '' : q
    drift.rpc<SearchResult[]>('ui.search', { q: query }).then((r) => {
      if (stale) return
      setResults(mode === 'edit' && !typed.current ? r.filter((x) => x.kind !== 'tab' || x.id !== active?.id) : r)
      setSel(0)
    })
    return () => {
      stale = true
    }
  }, [q, mode, searching, active?.id])

  const runCommand = async (id: string) => {
    switch (id) {
      case 'ws.new': return void drift.rpc('ws.create', {}).then(onClose)
      case 'ws.private': return void drift.rpc('ws.create', { private: true }).then(onClose)
      case 'agent.ask': return onMode('ask')
      case 'ws.rename': return onMode('rename')
      case 'ws.delete': return onMode('confirm-delete')
      case 'ext.install': return onMode('ext')
      case 'memory': onClose(); return onMemory()
      case 'passwords': onClose(); return onPasswords()
      case 'settings': onClose(); return onSettings()
      case 'tab.essential': if (active) await drift.rpc('tabs.essential', { tab: active.id, on: true }); return onClose()
      case 'sleep.idle': {
        const r = await drift.rpc<{ slept: string[] }>('tabs.sleep', { tab: 'all-idle' })
        toast(r.slept.length ? `${r.slept.length} ${r.slept.length === 1 ? 'tab' : 'tabs'} asleep` : 'Nothing to sleep')
        return onClose()
      }
      case 'adblock.toggle': await drift.rpc('adblock.set', { enabled: !s.adblock.enabled }); return onClose()
      case 'history.clear': await drift.rpc('history.clear'); toast('History cleared'); return onClose()
      case 'import.brave': {
        setBusy(true)
        try {
          const r = await drift.rpc<{ bookmarks: number; history: number; extensions: string[]; cookies: number; passwords: number }>('import.brave', { cookies: true, passwords: true })
          toast(`Imported ${r.bookmarks} bookmarks, ${r.history} history entries, ${r.passwords} passwords, ${r.cookies} cookies, ${r.extensions.length} extensions`)
        } catch (e) {
          toast(String((e as Error).message).replace(/^Error invoking remote method 'rpc': Error: /, ''))
        }
        setBusy(false)
        return onClose()
      }
      default: onClose(); return drift.rpc('run', { action: id })
    }
  }

  const go = async (r: SearchResult | undefined, e: { shiftKey: boolean; altKey: boolean }) => {
    if (!r) return
    if (r.kind === 'command') return runCommand(r.id)
    if (r.kind === 'tab') {
      if (e.shiftKey && active && r.id !== active.id) await drift.rpc('split.add', { target: active.id, tab: r.id, side: 'right' })
      else await drift.rpc('tabs.focus', { tab: r.id })
      return onClose()
    }
    onClose()
    if (e.shiftKey && active) return drift.rpc('tabs.open', { url: r.url, split: 'right' })
    if (e.altKey) return drift.rpc('tabs.open', { url: r.url, background: true })
    if (mode === 'edit' && active) return drift.rpc('tabs.navigate', { tab: active.id, url: r.url })
    return drift.rpc('tabs.open', { url: r.url })
  }

  const ask = async (task: string) => {
    if (!task.trim() || busy) return
    setBusy(true)
    try {
      await drift.rpc('agent.ask', { prompt: task.trim() })
      onClose()
    } catch (err) {
      toast(String((err as Error).message).replace(/^Error invoking remote method 'rpc': Error: /, ''))
      setBusy(false)
    }
  }
  const asking = mode === 'ask' || (searching && q.startsWith('?'))

  const submitOther = async () => {
    if (mode === 'rename') {
      await drift.rpc('ws.rename', { target: ws.id, name: q.trim() || ws.name })
      return onClose()
    }
    if (mode === 'ask') return ask(q)
    if (mode === 'confirm-delete') {
      await drift.rpc('ws.remove', { target: ws.id })
      return onClose()
    }
    if (mode === 'ext') {
      setBusy(true)
      try {
        const e = await drift.rpc<{ name: string }>('ext.load', { path: q.trim() })
        toast(`Installed ${e.name}`)
        onClose()
      } catch (err) {
        toast(String((err as Error).message).replace(/^Error invoking remote method 'rpc': Error: /, ''))
      }
      setBusy(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      return onClose()
    }
    if (!searching) {
      if (e.key === 'Enter') submitOther()
      return
    }
    if (e.key === 'Enter' && q.startsWith('?')) {
      e.preventDefault()
      void ask(q.slice(1))
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(results[sel], e)
    }
  }

  const width = Math.min(680, area.width - 48)
  const left = area.x + (area.width - width) / 2
  const top = area.y + Math.max(24, Math.round(area.height * 0.14))
  const deleteCount = ws.tabs.length

  return (
    <>
      <motion.div className="bar-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onMouseDown={onClose} />
      <motion.div
        layoutId="omnibar"
        className="bar"
        transition={spring}
        style={{ left, top, width, borderRadius: 16, maxHeight: area.height - (top - area.y) - 24 }}
        initial={{ opacity: 0, scale: 0.98, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.14 } }}
      >
        <div className="field">
          {mode === 'confirm-delete' ? (
            <span style={{ fontSize: 18, flex: 1 }}>
              Delete {ws.name}{deleteCount ? ` and close its ${deleteCount} ${deleteCount === 1 ? 'tab' : 'tabs'}` : ''}?
            </span>
          ) : (
            <input
              ref={input}
              value={q}
              placeholder={PLACEHOLDER[mode]}
              spellCheck={false}
              onChange={(e) => {
                typed.current = true
                setQ(e.target.value)
              }}
              onKeyDown={onKey}
            />
          )}
          {mode === 'confirm-delete' && (
            <span style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={onClose} onKeyDown={onKey}>Cancel</button>
              <button className="btn" autoFocus onClick={submitOther} onKeyDown={onKey}>Delete</button>
            </span>
          )}
          {busy && <span className="mode">Working</span>}
          {mode === 'edit' && !busy && <span className="mode">Enter to load here</span>}
        </div>
        {asking && (
          <div className="asking">
            <b>Claude</b> works on this in the Agent space while you keep browsing. Progress shows in the sidebar.
          </div>
        )}
        {searching && !asking && results.length > 0 && (
          <div className="results" role="listbox">
            {results.map((r, i) => (
              <button
                key={`${r.kind}:${r.id}`}
                className="result"
                role="option"
                aria-selected={i === sel}
                onMouseMove={() => setSel(i)}
                onClick={(e) => go(r, e)}
              >
                {i === sel && <motion.span layoutId="result-hl" className="hl" transition={{ type: 'tween', duration: 0.1, ease: [0.16, 1, 0.3, 1] }} />}
                <span className="fav">
                  {r.kind === 'command' ? <span className="letter">/</span> : <Favicon tab={{ favicon: faviconFor(s, r), title: r.title, url: r.url }} size={18} />}
                </span>
                <span className="t">
                  <b>{r.kind === 'search' ? r.title : r.title}</b>
                  {r.kind !== 'search' && r.kind !== 'command' && r.url !== r.title && <span>{r.url.replace(/^https?:\/\/(www\.)?/, '')}</span>}
                </span>
                <span className="kind">{KIND_LABEL[r.kind]}</span>
              </button>
            ))}
          </div>
        )}
        <AnimatePresence>
          {searching && (
            <div className="hints">
              <span><b>Shift Enter</b> open in split</span>
              <span><b>Alt Enter</b> background tab</span>
              <span><b>?</b> ask Claude</span>
            </div>
          )}
        </AnimatePresence>
      </motion.div>
    </>
  )
}

function faviconFor(s: State, r: SearchResult): string | null {
  if (r.kind === 'tab') return findTab(s, r.id)?.favicon ?? null
  const all = s.workspaces.flatMap((w) => w.tabs).concat(s.essentials)
  try {
    const h = new URL(r.url).host
    return all.find((t) => t.favicon && t.url.includes(h))?.favicon ?? null
  } catch {
    return null
  }
}
