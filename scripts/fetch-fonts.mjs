// Downloads Switzer (Fontshare, ITF Free Font License) into the renderer's public folder at install time,
// so the repo doesn't redistribute the font files. Without them Drift falls back to system fonts.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/public/fonts')
const weights = [400, 500, 600]

try {
  if (weights.every((w) => existsSync(join(out, `switzer-${w}.woff2`)))) process.exit(0)
  mkdirSync(out, { recursive: true })
  const css = await (await fetch(`https://api.fontshare.com/v2/css?f[]=switzer@${weights.join(',')}&display=swap`)).text()
  for (const block of css.split('@font-face').slice(1)) {
    const weight = block.match(/font-weight:\s*(\d+)/)?.[1]
    const url = block.match(/url\('([^']+\.woff2)'\)/)?.[1]
    if (!weight || !url || !weights.includes(Number(weight))) continue
    const res = await fetch(url.startsWith('//') ? `https:${url}` : url)
    if (!res.ok) throw new Error(`${res.status} for weight ${weight}`)
    writeFileSync(join(out, `switzer-${weight}.woff2`), Buffer.from(await res.arrayBuffer()))
  }
  console.log('drift: fonts ready')
} catch (e) {
  console.warn(`drift: could not fetch Switzer (${e.message}); the UI will use system fonts`)
}
