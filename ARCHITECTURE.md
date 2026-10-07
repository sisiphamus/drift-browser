# Architecture

Drift is an Electron 44 (Chromium 152) shell for Linux. The main process owns all state; the browser UI is one React view; every awake tab is its own `WebContentsView`.

## Window model
- `BaseWindow`, frameless and transparent so the compositor can show the wallpaper through it.
- `ui` view covers the window and draws the background, sidebar, command bar and overlays. It sits below the pages, with holes cut where pages are, and is raised above them only while an overlay needs it (tucked sidebar, command bar, drag, popups). Drags and transitions remember what the UI asked for and hand back to it.
- One view per awake tab, inset by an 8px gap with rounded corners, placed by the space's split tree. Transitions animate captured snapshots, then swap the real views back in.
- Popups (OAuth, `window.open`) open as an in-window card that keeps `window.opener`.

## Main process (`src/main`)
| file | job | tested |
|---|---|---|
| `model.ts` | spaces, tabs, Essentials (pinned), order, split tree per space, closed-tab stack, (de)serialization | unit |
| `layout.ts` | split tree: insert, remove, resize, rects | unit |
| `browser.ts` | mirrors the model onto real views: layout, overlay, snapshots, sleeping, popups, permissions, downloads | e2e |
| `commands.ts` | every command (UI, keyboard and CLI share one registry in `rpc.ts`) | e2e |
| `socket.ts` | newline-JSON over `$XDG_RUNTIME_DIR/drift.sock` | unit + e2e |
| `sleep.ts` | which tabs to sleep (idle time, memory cap); `Trimmer` drops caches of tabs hidden 30s | unit |
| `adblock.ts` | Ghostery engine: ads, trackers, cookie banners, URLhaus malware/phishing; pages wait for it | e2e |
| `privacy.ts` | https upgrade with per-host fallback, tracking-parameter stripping | unit |
| `passwords.ts`, `autofill.ts` | logins sealed with the OS keyring (libsecret), origin-checked autofill | unit + e2e |
| `permissions.ts` | remembered per-site permission decisions | unit |
| `extensions.ts`, `extshim.ts` | Chrome extensions (folder, .crx, Web Store); a shim gives content scripts and MV3 workers a working `chrome.storage.sync` | unit + e2e |
| `brave.ts`, `zen.ts`, `cookies.ts` | import from Brave (Chromium os_crypt) and Zen/Firefox (NSS `key4.db`) | unit |
| `signin.ts` | Google sign-in compatibility (Firefox UA on accounts pages only) | unit |
| `search.ts`, `history.ts` | command bar ranking; `node:sqlite` history and bookmarks | unit |
| `pagetools.ts` | read (text/markdown/html), click, type, eval, wait, scroll, screenshot; works on background tabs | e2e |
| `agent.ts` | "Ask Claude": runs Claude Code headless with Drift's MCP tools, streams steps to the sidebar | unit + e2e |
| `swipe.ts` | two-finger swipe detection, shared by the sidebar and every page | unit + e2e |
| `theme.ts` | matugen/GTK colors into tokens, per-space hue | unit |
| `update.ts`, `argv.ts`, `keys.ts` | restart-to-update, links from `xdg-open`, shortcuts | unit |

## Preloads (`src/preload`)
- `ui.ts`: the browser UI's bridge to the main process.
- `page.ts`: every page frame, isolated world. Autofill, Global Privacy Control, mouse back/forward, swipe reporting.

## Outside the app
- `bin/drift.mjs`: the CLI, zero dependencies.
- `bin/drift-mcp.mjs`: MCP server (stdio, zero dependencies) so any agent can drive Drift.
- `scripts/bench.mjs`: memory and idle-CPU benchmark against Brave.

## Tests
`npm test` runs the unit tests (vitest). `npm run e2e` builds and runs a real headless Drift on a throwaway profile, driven over its socket: tabs, spaces, splits, drags with real mouse events, swipes, popups, ad blocking, extensions, the MCP server and quitting cleanly.
