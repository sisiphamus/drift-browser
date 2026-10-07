// History + bookmarks store on node:sqlite. Pure Node, no Electron.

import { DatabaseSync, type StatementSync } from 'node:sqlite'

export type HistoryRow = { url: string; title: string; visitCount: number; lastVisit: number }
export type Bookmark = { url: string; title: string; folder: string; created: number }
export type BookmarkInput = { url: string; title: string; folder?: string }

const HALF_LIFE = 30 * 86_400_000
const SKIP = /^(about|drift|data|chrome|devtools|blob|javascript):/i

const HIST_COLS = 'url, title, visit_count AS visitCount, last_visit AS lastVisit'

// Escape LIKE wildcards so '%' and '_' in queries match literally.
const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`
const tokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean)

export class HistoryStore {
  private db: DatabaseSync
  private q: Record<string, StatementSync>

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS urls (
        url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        visit_count INTEGER NOT NULL DEFAULT 0, last_visit INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS urls_last ON urls(last_visit DESC);
      CREATE TABLE IF NOT EXISTS bookmarks (
        url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        folder TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
    `)
    // Frecency: visits decayed by a 30 day half-life on the last visit.
    this.db.function('frecency', { deterministic: false }, (count, last) =>
      Math.max(1, Number(count)) * Math.pow(0.5, (Date.now() - Number(last)) / HALF_LIFE),
    )
    this.q = {
      visit: this.db.prepare(`
        INSERT INTO urls (url, title, visit_count, last_visit) VALUES (?, ?, 1, ?)
        ON CONFLICT(url) DO UPDATE SET visit_count = visit_count + 1,
          last_visit = max(last_visit, excluded.last_visit),
          title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END`),
      title: this.db.prepare(`UPDATE urls SET title = ? WHERE url = ?`),
      recent: this.db.prepare(`SELECT ${HIST_COLS} FROM urls ORDER BY last_visit DESC LIMIT ?`),
      import: this.db.prepare(`
        INSERT INTO urls (url, title, visit_count, last_visit) VALUES (?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET visit_count = max(visit_count, excluded.visit_count),
          last_visit = max(last_visit, excluded.last_visit),
          title = CASE WHEN title = '' THEN excluded.title ELSE title END`),
      addBm: this.db.prepare(`
        INSERT INTO bookmarks (url, title, folder, created) VALUES (?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET title = excluded.title, folder = excluded.folder`),
      importBm: this.db.prepare(`INSERT OR IGNORE INTO bookmarks (url, title, folder, created) VALUES (?, ?, ?, ?)`),
      rmBm: this.db.prepare(`DELETE FROM bookmarks WHERE url = ?`),
      hasBm: this.db.prepare(`SELECT 1 FROM bookmarks WHERE url = ?`),
      allBm: this.db.prepare(`SELECT url, title, folder, created FROM bookmarks ORDER BY folder, created`),
    }
  }

  addVisit(url: string, title: string, at = Date.now()): void {
    if (SKIP.test(url)) return
    this.q.visit.run(url, title ?? '', at)
  }

  setTitle(url: string, title: string): void {
    this.q.title.run(title, url)
  }

  search(q: string, limit = 8): HistoryRow[] {
    const ts = tokens(q)
    if (!ts.length) return []
    const where = ts.map(() => `(lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\')`).join(' AND ')
    const sql = `SELECT ${HIST_COLS} FROM urls WHERE ${where}
      ORDER BY frecency(visit_count, last_visit) DESC LIMIT ?`
    return this.db.prepare(sql).all(...ts.flatMap((t) => [like(t), like(t)]), limit) as HistoryRow[]
  }

  recent(limit = 50): HistoryRow[] {
    return this.q.recent.all(limit) as HistoryRow[]
  }

  importHistory(rows: HistoryRow[]): void {
    this.tx(() => {
      for (const r of rows) {
        if (SKIP.test(r.url)) continue
        this.q.import.run(r.url, r.title ?? '', r.visitCount, r.lastVisit)
      }
    })
  }

  addBookmark(url: string, title: string, folder = ''): void {
    this.q.addBm.run(url, title, folder, Date.now())
  }

  removeBookmark(url: string): void {
    this.q.rmBm.run(url)
  }

  isBookmarked(url: string): boolean {
    return this.q.hasBm.get(url) !== undefined
  }

  bookmarks(): Bookmark[] {
    return this.q.allBm.all() as Bookmark[]
  }

  importBookmarks(rows: BookmarkInput[]): void {
    const now = Date.now()
    this.tx(() => {
      for (const r of rows) this.q.importBm.run(r.url, r.title, r.folder ?? '', now)
    })
  }

  searchBookmarks(q: string, limit = 8): Bookmark[] {
    const ts = tokens(q)
    if (!ts.length) return []
    const where = ts
      .map(() => `(lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' OR lower(folder) LIKE ? ESCAPE '\\')`)
      .join(' AND ')
    const sql = `SELECT url, title, folder, created FROM bookmarks WHERE ${where} ORDER BY created DESC LIMIT ?`
    return this.db.prepare(sql).all(...ts.flatMap((t) => [like(t), like(t), like(t)]), limit) as Bookmark[]
  }

  clear(): void {
    this.db.exec('DELETE FROM urls')
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
