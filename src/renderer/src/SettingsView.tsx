import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { State, Rect, drift, spring } from './store'

type Ext = { id: string; name: string; version: string; path: string; enabled: boolean; description: string; storeId: string | null; options: string | null }
type CatalogItem = { storeId: string; name: string; blurb: string; installed: boolean }
type Info = { drift: string; chromium: string; electron: string; profile: string; keyring: string }

const SECTIONS = ['General', 'Spaces', 'Tabs and memory', 'Privacy and security', 'Passwords', 'Extensions', 'Import', 'Shortcuts', 'About'] as const
type Section = (typeof SECTIONS)[number]

const ENGINES = [
  ['google', 'Google'],
  ['brave', 'Brave Search'],
  ['duckduckgo', 'DuckDuckGo'],
  ['kagi', 'Kagi'],
] as const

const SHORTCUTS: [string, string][] = [
  ['Ctrl T', 'New tab'], ['Ctrl L', 'Edit address'], ['Ctrl W', 'Close tab'], ['Ctrl Shift T', 'Reopen closed tab'],
  ['Ctrl Tab', 'Next tab'], ['Ctrl 1 to 9', 'Jump to tab'], ['Ctrl Alt Left/Right', 'Switch space'], ['Alt 1 to 9', 'Jump to space'],
  ['Ctrl Alt \\', 'Split with last tab'], ['Ctrl Alt U', 'Unsplit'], ['Ctrl Shift B', 'Pin or hide sidebar'], ['Ctrl Shift M', 'Tab memory'],
  ['Ctrl ,', 'Settings'], ['Ctrl F', 'Find in page'], ['Ctrl D', 'Bookmark'], ['F12', 'Developer tools'], ['Ctrl Shift Q', 'Quit'],
]

const set = (patch: Record<string, unknown>) => drift.rpc('settings.set', patch)
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method 'rpc': (Error: )?/, '')

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <motion.i layout transition={{ type: 'tween', duration: 0.16, ease: [0.16, 1, 0.3, 1] }} />
    </button>
  )
}

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="srow">
      <div className="stext">
        <b>{title}</b>
        {detail && <span>{detail}</span>}
      </div>
      <div className="sctl">{children}</div>
    </div>
  )
}

export function SettingsView({ s, area, onClose, toast, onPasswords, onMemory, initial }: {
  s: State; area: Rect; onClose: () => void; toast: (m: string) => void; onPasswords: () => void; onMemory: () => void; initial?: Section
}) {
  const [section, setSection] = useState<Section>(initial ?? 'General')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    drift.focusUi()
    ref.current?.focus()
  }, [])
  const st = s.settings

  return (
    <motion.div
      ref={ref}
      tabIndex={-1}
      className="settings"
      style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.12 } }}
      transition={spring}
      onKeyDown={(e) => e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && onClose()}
    >
      <nav>
        <h2>Settings</h2>
        {SECTIONS.map((x) => (
          <button key={x} className={x === section ? 'active' : ''} onClick={() => setSection(x)}>
            {x === section && <motion.span layoutId="settings-nav" className="navbg" transition={spring} />}
            <span className="label">{x}</span>
          </button>
        ))}
        <button className="btn ghost done" onClick={onClose}>Done</button>
      </nav>
      <div className="spage" key={section}>
        <h3>{section}</h3>
        {section === 'General' && (
          <>
            <Row title="Search engine" detail="Used for anything you type that isn't an address.">
              <div className="seg">
                {ENGINES.map(([id, name]) => (
                  <button key={id} className={st.searchEngine === id ? 'on' : ''} onClick={() => set({ searchEngine: id })}>{name}</button>
                ))}
              </div>
            </Row>
            <Row title="Keep the sidebar open" detail="Off: it tucks away and slides in when you touch the left edge. Ctrl Shift B toggles it.">
              <Toggle label="Keep the sidebar open" on={st.sidebarPinned} onChange={(v) => set({ sidebarPinned: v })} />
            </Row>
            <Row title="See the wallpaper through the window" detail="Glass behind the sidebar. Takes effect after a restart.">
              <Toggle label="Glass window" on={st.glass} onChange={(v) => set({ glass: v })} />
            </Row>
          </>
        )}
        {section === 'Tabs and memory' && (
          <>
            <Row title="Sleep hidden tabs after" detail="A sleeping tab frees its memory and reloads where you left it. Tabs on screen or playing audio never sleep.">
              <NumberField value={st.idleMinutes} unit="min" onSave={(n) => set({ idleMinutes: n })} />
            </Row>
            <Row title="Memory cap" detail="Past this total, the least recently used hidden tabs sleep first.">
              <NumberField value={st.memoryCapMB} unit="MB" onSave={(n) => set({ memoryCapMB: n })} />
            </Row>
            <Row title="Tab memory" detail="See what each tab costs and sleep or wake them.">
              <button className="btn ghost" onClick={() => { onClose(); onMemory() }}>Open</button>
            </Row>
          </>
        )}
        {section === 'Spaces' && <Spaces s={s} />}
        {section === 'Privacy and security' && <Privacy s={s} toast={toast} />}
        {section === 'Passwords' && <Passwords s={s} onPasswords={() => { onClose(); onPasswords() }} />}
        {section === 'Extensions' && <Extensions toast={toast} />}
        {section === 'Import' && <Import toast={toast} />}
        {section === 'Shortcuts' && (
          <div className="keys">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k} className="krow"><kbd>{k}</kbd><span>{d}</span></div>
            ))}
          </div>
        )}
        {section === 'About' && <About />}
      </div>
    </motion.div>
  )
}

const HUES: [string, number | null][] = [
  ['Match wallpaper', null], ['Red', 25], ['Amber', 80], ['Green', 145], ['Teal', 195], ['Blue', 250], ['Purple', 300], ['Pink', 340],
]

function Spaces({ s }: { s: State }) {
  const [confirm, setConfirm] = useState<string | null>(null)
  return (
    <>
      <div className="spaces">
        {s.workspaces.map((w, i) => (
          <div className="space" key={w.id} style={w.tokens as React.CSSProperties}>
            <div className="sname">
              <input
                defaultValue={w.name}
                key={w.name}
                aria-label="Space name"
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim()
                  if (name && name !== w.name) drift.rpc('ws.rename', { target: w.id, name })
                  else e.currentTarget.value = w.name
                }}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <span>
                {w.tabs.length} {w.tabs.length === 1 ? 'tab' : 'tabs'}
                {w.private ? ', private' : ''}
                {w.id === s.activeWorkspaceId ? ', current' : ''}
              </span>
            </div>
            <div className="hues" role="radiogroup" aria-label="Color">
              {HUES.map(([label, hue]) => (
                <button
                  key={label}
                  role="radio"
                  aria-checked={w.hue === hue}
                  title={label}
                  className={`hue${w.hue === hue ? ' on' : ''}${hue === null ? ' wall' : ''}`}
                  style={hue === null ? undefined : { background: `oklch(0.78 0.12 ${hue})` }}
                  onClick={() => drift.rpc('ws.setHue', { target: w.id, hue })}
                />
              ))}
            </div>
            <div className="sctl">
              <button className="btn ghost small" disabled={i === 0} onClick={() => drift.rpc('ws.move', { target: w.id, index: i - 1 })}>Up</button>
              <button className="btn ghost small" disabled={i === s.workspaces.length - 1} onClick={() => drift.rpc('ws.move', { target: w.id, index: i + 1 })}>Down</button>
              {confirm === w.id ? (
                <>
                  <button className="btn small danger" onClick={() => { drift.rpc('ws.remove', { target: w.id }); setConfirm(null) }}>
                    Delete{w.tabs.length ? ` and close ${w.tabs.length}` : ''}
                  </button>
                  <button className="btn ghost small" onClick={() => setConfirm(null)}>Keep</button>
                </>
              ) : (
                <button className="btn ghost small" disabled={s.workspaces.length < 2} onClick={() => setConfirm(w.id)}>Delete</button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="addext">
        <button className="btn ghost" onClick={() => drift.rpc('ws.create', { switch: false })}>New space</button>
        <button className="btn ghost" onClick={() => drift.rpc('ws.create', { private: true, switch: false })}>New private space</button>
      </div>
      <p className="note">You can also double-click a space in the sidebar to rename it, or right-click it for everything here.</p>
    </>
  )
}

function NumberField({ value, unit, onSave }: { value: number; unit: string; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) onSave(Math.round(n))
    else setV(String(value))
  }
  return (
    <label className="num">
      <input value={v} inputMode="numeric" onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      {unit}
    </label>
  )
}

function Privacy({ s, toast }: { s: State; toast: (m: string) => void }) {
  const st = s.settings
  const [what, setWhat] = useState({ history: true, cookies: false, cache: true })
  return (
    <>
      <Row title="Block ads, trackers, malware and phishing" detail={`EasyList, EasyPrivacy, uBlock filters and URLhaus. ${s.adblock.total.toLocaleString()} requests blocked this session.`}>
        <Toggle label="Blocking" on={st.adblock} onChange={(v) => drift.rpc('adblock.set', { enabled: v })} />
      </Row>
      <Row title="Upgrade links to HTTPS" detail="Falls back to HTTP only for sites that have no secure version.">
        <Toggle label="HTTPS upgrade" on={st.httpsUpgrade} onChange={(v) => set({ httpsUpgrade: v })} />
      </Row>
      <Row title="Strip tracking parameters" detail="Removes utm_*, fbclid, gclid and similar from links before they load.">
        <Toggle label="Strip tracking" on={st.stripTracking} onChange={(v) => set({ stripTracking: v })} />
      </Row>
      <Row title="Encrypted DNS" detail="DNS over HTTPS through Cloudflare and Quad9, falling back to your network's DNS if blocked.">
        <Toggle label="Encrypted DNS" on={st.doh} onChange={(v) => set({ doh: v })} />
      </Row>
      <Row
        title="Google sign-in"
        detail="Google blocks sign-in from browsers it doesn't recognize. On Google's sign-in pages only, Drift can present as Firefox, or as an Electron app, which Google gives a simpler sign-in. If one is rejected, switch and try again."
      >
        <div className="seg">
          {([['firefox', 'Firefox'], ['electron', 'Electron lite']] as const).map(([id, name]) => (
            <button key={id} className={st.googleSignIn === id ? 'on' : ''} onClick={() => set({ googleSignIn: id })}>{name}</button>
          ))}
        </div>
      </Row>
      <Row title="Private space" detail="Cookies and storage live in memory, nothing goes to history, no extensions run, and it all goes when the space closes.">
        <button className="btn ghost" onClick={() => drift.rpc('ws.create', { private: true })}>New private space</button>
      </Row>
      <Row title="Clear browsing data" detail="Cookies and site data signs you out of websites.">
        <div className="checks">
          {(['history', 'cookies', 'cache'] as const).map((k) => (
            <label key={k}>
              <input type="checkbox" checked={what[k]} onChange={(e) => setWhat({ ...what, [k]: e.target.checked })} />
              {k === 'cookies' ? 'Cookies and site data' : k === 'cache' ? 'Cached files' : 'History'}
            </label>
          ))}
          <button
            className="btn"
            disabled={!what.history && !what.cookies && !what.cache}
            onClick={async () => {
              await drift.rpc('data.clear', what)
              toast('Cleared')
            }}
          >
            Clear
          </button>
        </div>
      </Row>
      <SitePermissions />
    </>
  )
}

type Grant = { origin: string; permission: string; allowed: boolean }
const PERM_NAMES: Record<string, string> = {
  'media:audio': 'Microphone', 'media:video': 'Camera', notifications: 'Notifications', geolocation: 'Location',
  'clipboard-read': 'Clipboard', midi: 'MIDI', midiSysex: 'MIDI', 'display-capture': 'Screen sharing', openExternal: 'Open apps',
  hid: 'HID devices', serial: 'Serial ports', usb: 'USB devices',
}

function SitePermissions() {
  const [grants, setGrants] = useState<Grant[]>([])
  const load = () => drift.rpc<Grant[]>('perm.list').then(setGrants)
  useEffect(() => void load(), [])
  const sites = [...new Set(grants.map((g) => g.origin))]
  return (
    <>
      <h4>Site permissions</h4>
      {sites.length === 0 && <p className="none">No site has asked yet. When one does, your answer is remembered here.</p>}
      {sites.map((o) => (
        <div className="srow" key={o}>
          <div className="stext">
            <b>{o.replace(/^https?:\/\//, '')}</b>
            <span>
              {grants.filter((g) => g.origin === o).map((g) => `${PERM_NAMES[g.permission] ?? g.permission} ${g.allowed ? 'allowed' : 'blocked'}`).join(', ')}
            </span>
          </div>
          <div className="sctl">
            {grants.filter((g) => g.origin === o).map((g) => (
              <button key={g.permission} className="btn ghost small" title="Forget this answer; the site will ask again" onClick={async () => { await drift.rpc('perm.reset', { origin: o, permission: g.permission }); load() }}>
                Reset {(PERM_NAMES[g.permission] ?? g.permission).toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

function Passwords({ s, onPasswords }: { s: State; onPasswords: () => void }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    drift.rpc<Info>('app.info').then(setInfo)
    drift.rpc<unknown[]>('pw.list').then((l) => setCount(l.length))
  }, [])
  const secure = info && info.keyring !== 'basic_text' && info.keyring !== 'unknown'
  return (
    <>
      <Row title="Offer to save and fill passwords" detail="Logins are only offered to the site they were saved on.">
        <Toggle label="Autofill" on={s.settings.autofill} onChange={(v) => set({ autofill: v })} />
      </Row>
      <Row title="Saved passwords" detail={count === null ? '' : `${count} saved`}>
        <button className="btn ghost" onClick={onPasswords}>Manage</button>
      </Row>
      <Row title="Encryption" detail={info ? (secure ? `Encrypted with a key in your system keyring (${info.keyring}).` : 'No system keyring found, so Drift will not store passwords.') : ''}>
        <span className={`pill${secure ? ' good' : ''}`}>{info ? (secure ? 'Keyring' : 'Unavailable') : ''}</span>
      </Row>
    </>
  )
}

function Extensions({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<Ext[]>([])
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => {
    drift.rpc<Ext[]>('ext.list').then(setList)
    drift.rpc<CatalogItem[]>('ext.catalog').then(setCatalog)
  }
  useEffect(load, [])

  const install = async (what: string) => {
    setBusy(what)
    try {
      const e = await drift.rpc<Ext>('ext.load', { path: what })
      toast(`Installed ${e.name}`)
      setLink('')
    } catch (err) {
      toast(clean(err))
    }
    setBusy(null)
    load()
  }

  return (
    <>
      <div className="addext">
        <input
          placeholder="Paste a Chrome Web Store link or extension id"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && link.trim() && install(link.trim())}
        />
        <button className="btn" disabled={!link.trim() || !!busy} onClick={() => install(link.trim())}>{busy === link.trim() ? 'Installing' : 'Install'}</button>
        <button className="btn ghost" onClick={() => drift.rpc('tabs.open', { url: 'https://chromewebstore.google.com/' })}>Browse the Web Store</button>
      </div>

      <h4>Installed</h4>
      {list.length === 0 && <p className="none">No extensions yet.</p>}
      <div className="extlist">
        {list.map((e) => (
          <div className={`ext${e.enabled ? '' : ' off'}`} key={e.path}>
            <div className="exticon">
              {e.enabled && e.id ? <img src={`crx://extension-icon/${e.id}/32/2`} alt="" onError={(ev) => ((ev.target as HTMLImageElement).style.display = 'none')} /> : <span>{e.name[0]}</span>}
            </div>
            <div className="stext">
              <b>{e.name} <em>{e.version}</em></b>
              <span>{e.description}</span>
            </div>
            <div className="sctl">
              {e.options && <button className="btn ghost small" onClick={() => drift.rpc('ext.options', { url: e.options })}>Options</button>}
              <button className="btn ghost small" onClick={async () => { await drift.rpc('ext.remove', { path: e.path }); toast(`Removed ${e.name}`); load() }}>Remove</button>
              <Toggle label={`Enable ${e.name}`} on={e.enabled} onChange={async (v) => { await drift.rpc('ext.enable', { path: e.path, on: v }); load() }} />
            </div>
          </div>
        ))}
      </div>

      <h4>Works well in Drift</h4>
      <div className="gallery">
        {catalog.map((c) => (
          <div className="card" key={c.storeId}>
            <b>{c.name}</b>
            <span>{c.blurb}</span>
            <button className={`btn${c.installed ? ' ghost' : ''} small`} disabled={c.installed || !!busy} onClick={() => install(c.storeId)}>
              {c.installed ? 'Installed' : busy === c.storeId ? 'Installing' : 'Install'}
            </button>
          </div>
        ))}
      </div>
      <p className="note">Drift runs Chrome extensions through Electron, which supports most content features but not everything. Extensions that rely on Chrome sync or deep browser APIs may not work.</p>
    </>
  )
}

function Import({ toast }: { toast: (m: string) => void }) {
  const [opts, setOpts] = useState({ passwords: true, cookies: false })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  return (
    <>
      <Row title="Import from Brave" detail="Bookmarks, history and extensions always come along. Passwords and cookies are optional.">
        <div className="checks">
          <label><input type="checkbox" checked={opts.passwords} onChange={(e) => setOpts({ ...opts, passwords: e.target.checked })} />Passwords</label>
          <label><input type="checkbox" checked={opts.cookies} onChange={(e) => setOpts({ ...opts, cookies: e.target.checked })} />Cookies (stay signed in)</label>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await drift.rpc<{ bookmarks: number; history: number; extensions: string[]; cookies: number; passwords: number }>('import.brave', opts)
                setResult(`${r.bookmarks} bookmarks, ${r.history.toLocaleString()} history entries, ${r.passwords} passwords, ${r.cookies} cookies, ${r.extensions.length} extensions`)
              } catch (err) {
                toast(clean(err))
              }
              setBusy(false)
            }}
          >
            {busy ? 'Importing' : 'Import'}
          </button>
        </div>
      </Row>
      {result && <p className="note">Imported {result}.</p>}
    </>
  )
}

function About() {
  const [info, setInfo] = useState<Info | null>(null)
  useEffect(() => void drift.rpc<Info>('app.info').then(setInfo), [])
  if (!info) return null
  return (
    <div className="about">
      <Row title="Drift" detail={`Version ${info.drift}`}><span /></Row>
      <Row title="Engine" detail={`Chromium ${info.chromium}, Electron ${info.electron}`}><span /></Row>
      <Row title="Profile" detail={info.profile}><span /></Row>
      <Row title="Command line" detail="Everything here is scriptable: run drift help in a terminal."><span /></Row>
    </div>
  )
}
