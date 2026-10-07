// "Restart to update": notices when Drift's own build output is replaced while it runs.
import { statSync } from 'node:fs'

const mtime = (file: string) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** Calls onNewer once, after the file has changed and then held still for one interval (the build finished). */
export function watchBuild(file: string, onNewer: () => void, every = 30_000): () => void {
  const boot = mtime(file)
  let last = boot
  const timer = setInterval(() => {
    const now = mtime(file)
    if (now !== null && now !== boot && now === last) {
      clearInterval(timer)
      onNewer()
    }
    last = now
  }, every)
  timer.unref?.()
  return () => clearInterval(timer)
}
