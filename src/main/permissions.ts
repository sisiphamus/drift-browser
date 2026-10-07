// Remembered site permissions: one decision per origin and permission, with mic and camera kept apart.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

export type Decision = 'allow' | 'deny' | 'ask'
export type Grant = { origin: string; permission: string; allowed: boolean }

const DEVICES = ['audio', 'video']

/** Media requests split into one key per device; everything else is one key. */
function keys(permission: string, mediaTypes: string[]): string[] {
  if (permission !== 'media') return [permission]
  const devices = mediaTypes.filter((t) => DEVICES.includes(t))
  return (devices.length ? devices : DEVICES).map((d) => `media:${d}`)
}

export class PermissionStore {
  private grants: Record<string, Record<string, boolean>> = {}

  /** A null path keeps decisions in memory only (private spaces). */
  constructor(private path: string | null) {
    try {
      if (path && existsSync(path)) this.grants = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      this.grants = {}
    }
  }

  decide(origin: string, permission: string, mediaTypes: string[] = []): Decision {
    const site = this.grants[origin] ?? {}
    const answers = keys(permission, mediaTypes).map((k) => site[k])
    if (answers.some((a) => a === false)) return 'deny'
    if (answers.every((a) => a === true)) return 'allow'
    return 'ask'
  }

  record(origin: string, permission: string, mediaTypes: string[], allowed: boolean) {
    const site = (this.grants[origin] ??= {})
    for (const k of keys(permission, mediaTypes)) site[k] = allowed
    this.write()
  }

  list(): Grant[] {
    return Object.entries(this.grants)
      .flatMap(([origin, site]) => Object.entries(site).map(([permission, allowed]) => ({ origin, permission, allowed })))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission))
  }

  /** Forgets one decision, or every decision for a site. */
  reset(origin: string, permission?: string) {
    if (permission) delete this.grants[origin]?.[permission]
    if (!permission || !Object.keys(this.grants[origin] ?? {}).length) delete this.grants[origin]
    this.write()
  }

  private write() {
    if (!this.path) return
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.grants, null, 2))
    renameSync(tmp, this.path)
  }
}
