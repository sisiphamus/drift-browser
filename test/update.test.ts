import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchBuild } from '../src/main/update'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function built() {
  const dir = mkdtempSync(join(tmpdir(), 'drift-upd-'))
  dirs.push(dir)
  const file = join(dir, 'index.js')
  writeFileSync(file, 'a')
  utimesSync(file, 1000, 1000)
  return file
}

describe('watchBuild', () => {
  it('stays quiet while the build is unchanged', () => {
    vi.useFakeTimers()
    const seen = vi.fn()
    const stop = watchBuild(built(), seen, 1000)
    vi.advanceTimersByTime(5000)
    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('reports a newer build once it has settled, and only once', () => {
    vi.useFakeTimers()
    const file = built()
    const seen = vi.fn()
    const stop = watchBuild(file, seen, 1000)
    utimesSync(file, 2000, 2000)
    vi.advanceTimersByTime(1000)
    expect(seen).not.toHaveBeenCalled() // still being written
    vi.advanceTimersByTime(1000)
    expect(seen).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
  })

  it('survives the file vanishing mid-build', () => {
    vi.useFakeTimers()
    const file = built()
    const seen = vi.fn()
    const stop = watchBuild(file, seen, 1000)
    rmSync(file)
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow()
    expect(seen).not.toHaveBeenCalled()
    stop()
  })
})
