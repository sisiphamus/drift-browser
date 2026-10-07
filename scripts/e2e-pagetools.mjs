#!/usr/bin/env node
// E2E for src/main/pagetools.ts: transpile with esbuild, drive a real headless Electron against a local page.
// Usage: node scripts/e2e-pagetools.mjs   (exit 0 = all checks passed)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const esbuild = createRequire(import.meta.url)(path.join(root, 'node_modules/esbuild'))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-e2e-'))

esbuild.buildSync({
  entryPoints: [path.join(root, 'src/main/pagetools.ts')],
  outfile: path.join(tmp, 'pagetools.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})

const page = `<!doctype html><html><head><title>Drift Test Page</title><style>body{font:14px sans-serif} .tall{height:2400px}</style></head><body>
<nav><a href="/nav-only">Nav link</a></nav>
<main>
  <h1>Test Page</h1>
  <p>Hello <strong>bold</strong> and <a href="docs/intro.html">relative link</a>.</p>
  <button id="inc" onclick="document.getElementById('count').textContent = +document.getElementById('count').textContent + 1">Increment</button>
  <span id="count">0</span>
  <div style="position:relative"><button id="under">Covered</button><div style="position:absolute;inset:0;background:transparent"></div></div>
  <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted:' + this.q.value">
    <input name="q" id="q" placeholder="search">
  </form>
  <div id="out"></div>
  <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
  <table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>apple</td><td>3</td></tr><tr><td>pear|x</td><td>5</td></tr></tbody></table>
  <pre><code class="language-js">const x = 1</code></pre>
  <blockquote>quoted text</blockquote>
  <img src="pic.png" alt="a pic">
  <script>window.trusted = null; document.getElementById('inc').addEventListener('click', (e) => { window.trusted = e.isTrusted })
  document.getElementById('under').addEventListener('click', () => { document.getElementById('out').dataset.covered = '1' })
  setTimeout(() => { const d = document.createElement('div'); d.className = 'late'; d.textContent = 'Arrived late'; document.querySelector('main').appendChild(d) }, 400)</script>
  <div class="tall">tall block</div>
</main>
<footer>footer junk</footer>
</body></html>`
fs.writeFileSync(path.join(tmp, 'page.html'), page)

const main = `
const { app, BrowserWindow } = require('electron')
const t = require('./pagetools.cjs')
const results = []
const check = (name, ok, info) => results.push({ name, ok: !!ok, info })
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: true, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true } })
  await win.loadFile(${JSON.stringify(path.join(tmp, 'page.html'))})
  win.setContentSize(900, 700) // headless ozone OSR starts at 1x1 otherwise
  const wc = win.webContents
  wc.on('console-message', (e) => process.stderr.write('[page] ' + e.message + '\\n'))
  try {
    const text = await t.pageText(wc)
    check('text', text.includes('Hello bold') && !/\\n{3,}/.test(text), text.slice(0, 80))

    const md = await t.pageMarkdown(wc)
    check('md heading', md.startsWith('# Test Page'), md.slice(0, 40))
    check('md abs link', /\\[relative link\\]\\(file:\\/\\/.*\\/docs\\/intro\\.html\\)/.test(md))
    check('md bold', md.includes('**bold**'))
    check('md table', md.includes('| Name | Qty |\\n| --- | --- |\\n| apple | 3 |\\n| pear\\\\|x | 5 |'), md)
    check('md list', md.includes('- one\\n- two\\n\\n  - nested') || md.includes('- one\\n- two\\n  - nested'), md)
    check('md code', md.includes('\`\`\`js\\nconst x = 1\\n\`\`\`'))
    check('md quote', md.includes('> quoted text'))
    check('md img', /!\\[a pic\\]\\(file:.*pic\\.png\\)/.test(md))
    check('md skips nav/footer/script', !md.includes('Nav link') && !md.includes('footer junk') && !md.includes('trusted'))

    const html = await t.pageHtml(wc)
    check('html', html.startsWith('<html') && html.includes('id="inc"'))

    const c1 = await t.click(wc, 'text:Increment')
    await new Promise((r) => setTimeout(r, 100))
    check('click text:', c1.tag === 'button' && (await t.evalJs(wc, 'document.getElementById("count").textContent')) === '1', c1)
    check('click trusted', (await t.evalJs(wc, 'window.trusted')) === true)
    await t.click(wc, '#inc')
    await new Promise((r) => setTimeout(r, 100))
    check('click selector', (await t.evalJs(wc, 'document.getElementById("count").textContent')) === '2')

    await t.click(wc, '#under')
    check('click covered falls back', (await t.evalJs(wc, 'document.getElementById("out").dataset.covered')) === '1')

    let err = ''
    try { await t.click(wc, 'text:Does Not Exist') } catch (e) { err = e.message }
    check('click missing errors', /no element matches/.test(err), err)

    await t.typeText(wc, '#q', 'hello drift', true)
    await new Promise((r) => setTimeout(r, 200))
    const out = await t.evalJs(wc, 'document.getElementById("out").textContent')
    check('type + submit', out === 'submitted:hello drift', out)

    const w = await t.waitFor(wc, '.late', 3000)
    check('wait', w.text === 'Arrived late', w)
    let werr = ''
    try { await t.waitFor(wc, '.never', 300) } catch (e) { werr = e.message }
    check('wait timeout', /timed out after 300ms/.test(werr))

    check('eval obj', JSON.stringify(await t.evalJs(wc, '({a: [1, 2], b: document.title})')) === '{"a":[1,2],"b":"Drift Test Page"}')
    check('eval undefined', (await t.evalJs(wc, 'void 0')) === null)
    check('eval promise', (await t.evalJs(wc, 'new Promise(r => setTimeout(() => r(42), 10))')) === 42)

    const s1 = await t.scroll(wc, 'bottom')
    const s2 = await t.scroll(wc, -100)
    const s3 = await t.scroll(wc, 'top')
    check('scroll', s1.y > 1000 && s2.y === s1.y - 100 && s3.y === 0, [s1, s2, s3])

    const png = await t.screenshot(wc, false)
    check('screenshot', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.length > 1000, png.length)
    const full = await t.screenshot(wc, true)
    const h = full.readUInt32BE(20)
    check('screenshot full', full.subarray(0, 4).toString('hex') === '89504e47' && h > 2000, { bytes: full.length, height: h })
    check('debugger detached', !wc.debugger.isAttached())
  } catch (e) {
    check('uncaught', false, e.stack)
  }
  process.stdout.write('RESULTS ' + JSON.stringify(results) + '\\n')
  app.exit(results.every((r) => r.ok) ? 0 : 1)
})
`
fs.writeFileSync(path.join(tmp, 'main.cjs'), main)

const electron = path.join(root, 'node_modules/.bin/electron')
const child = spawn(electron, ['--ozone-platform=headless', '--no-sandbox', path.join(tmp, 'main.cjs')], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d))
const timer = setTimeout(() => child.kill('SIGKILL'), 60000)

child.on('exit', (code) => {
  clearTimeout(timer)
  const line = out.split('\n').find((l) => l.startsWith('RESULTS '))
  if (!line) {
    console.error('no results; electron exited with', code, '\n', out)
    process.exit(1)
  }
  const results = JSON.parse(line.slice(8))
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '  ' + JSON.stringify(r.info)}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})
