#!/usr/bin/env node
// Drags a sidebar tab (by title substring) to a point in the window, screenshotting mid-drag.
// usage: node scripts/drag.mjs "<title>" <x> <y> <mid.png>
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = (...a) => execFileSync('node', [join(here, '../bin/drift.mjs'), ...a], { encoding: 'utf8' })
const send = (e) => cli('raw', 'debug.uiInput', JSON.stringify(e))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const [title, tx, ty, mid] = process.argv.slice(2)

const rect = JSON.parse(
  JSON.parse(
    cli('raw', 'debug.uiEval', JSON.stringify({
      js: `JSON.stringify((() => { const el = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes(${JSON.stringify(title)})); const r = el.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 } })())`,
    }), '--json'),
  ),
)
send({ type: 'mouseMove', x: rect.x, y: rect.y })
send({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
const steps = 12
for (let i = 1; i <= steps; i++) {
  const x = Math.round(rect.x + ((Number(tx) - rect.x) * i) / steps)
  const y = Math.round(rect.y + ((Number(ty) - rect.y) * i) / steps)
  send({ type: 'mouseMove', x, y, button: 'left' })
  await sleep(i === 1 ? 300 : 30)
}
await sleep(300)
if (mid) execFileSync(join(here, 'snap.sh'), [mid], { stdio: 'inherit' })
send({ type: 'mouseUp', x: Number(tx), y: Number(ty), button: 'left', clickCount: 1 })
