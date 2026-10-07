// What to open from a launch command line: links handed over by xdg-open (Drift as the default browser),
// local files, and bare domains. The app path and Chromium switches are skipped.
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const isFile = (p: string) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function urlsFromArgv(argv: string[], exists: (path: string) => boolean = isFile): string[] {
  const out: string[] = []
  for (const a of argv) {
    if (a.startsWith('-')) continue
    if (/^(https?|file):/i.test(a)) out.push(a)
    else if (isAbsolute(a)) {
      if (exists(a)) out.push(pathToFileURL(a).href)
    } else if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(a)) out.push(a)
  }
  return out
}
