import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { asc, desc } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { openDb, type Db } from '../db'
import { EnkakuError } from '../util/errors'
import { decodeCursor, decodeStringCursor, encodeCursor, keysetWhere, parsePageQuery } from './pagination'

// A tiny standalone table, purely to exercise `keysetWhere` against a real
// SQLite connection without depending on any of the app's own tables.
const rows = sqliteTable('rows_test', {
  id: text('id').primaryKey(),
  at: integer('at', { mode: 'timestamp' }).notNull(),
  label: text('label').notNull(),
})

function seedDb(): Db {
  const { db, sqlite } = openDb(':memory:')
  sqlite.exec(`CREATE TABLE rows_test (id TEXT PRIMARY KEY, at INTEGER NOT NULL, label TEXT NOT NULL)`)
  return db
}

async function ctxWith(query: Record<string, string | undefined>) {
  const app = new Hono()
  let captured: unknown
  app.get('/', (c) => {
    captured = parsePageQuery(c)
    return c.json({ ok: true })
  })
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][])
  await app.request(`/?${qs.toString()}`)
  return captured
}

describe('parsePageQuery', () => {
  test('defaults to limit 50 with no cursor', async () => {
    const q = await ctxWith({})
    expect(q).toEqual({ cursor: null, limit: 50 })
  })

  test('clamps a limit above the cap rather than honouring it', async () => {
    const q = await ctxWith({ limit: '999999' })
    expect(q).toEqual({ cursor: null, limit: 200 })
  })

  test('passes a small limit and cursor through unchanged', async () => {
    const q = await ctxWith({ limit: '2', cursor: 'abc' })
    expect(q).toEqual({ cursor: 'abc', limit: 2 })
  })

  test('rejects a non-numeric or non-positive limit', async () => {
    const app = new Hono()
    app.get('/', (c) => {
      parsePageQuery(c)
      return c.json({ ok: true })
    })
    app.onError((err, c) => {
      if (err instanceof EnkakuError) return c.json(err.toJSON(), 400)
      throw err
    })
    for (const bad of ['abc', '0', '-5']) {
      const res = await app.request(`/?limit=${bad}`)
      expect(res.status).toBe(400)
    }
  })
})

describe('cursor codec', () => {
  test('round-trips a numeric sort value', () => {
    const encoded = encodeCursor(1_700_000_000, 'job-123')
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ sortValue: 1_700_000_000, id: 'job-123' })
  })

  test('round-trips a string sort value (the devices label case)', () => {
    const encoded = encodeCursor('pixel-7', 'device-abc')
    const decoded = decodeStringCursor(encoded)
    expect(decoded).toEqual({ sortValue: 'pixel-7', id: 'device-abc' })
  })

  test('a null cursor decodes to null (first page)', () => {
    expect(decodeCursor(null)).toBeNull()
    expect(decodeStringCursor(null)).toBeNull()
  })

  test('an empty-string cursor decodes to null', () => {
    expect(decodeCursor('')).toBeNull()
  })

  test('rejects invalid base64 rather than silently ignoring it', () => {
    expect(() => decodeCursor('not-valid-base64!!!')).toThrow(EnkakuError)
  })

  test('rejects a decoded value with no colon separator', () => {
    const bogus = btoa('no-separator-here')
    expect(() => decodeCursor(bogus)).toThrow(EnkakuError)
  })

  test('rejects an empty sortValue or an empty id', () => {
    expect(() => decodeCursor(btoa(':only-an-id'))).toThrow(EnkakuError)
    expect(() => decodeCursor(btoa('123:'))).toThrow(EnkakuError)
  })

  test('rejects a non-numeric sortValue on the numeric decoder', () => {
    expect(() => decodeCursor(btoa('not-a-number:some-id'))).toThrow(EnkakuError)
  })

  test('a bad cursor throws, distinguishable as E_BAD_REQUEST', () => {
    try {
      decodeCursor('!!!')
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('E_BAD_REQUEST')
    }
  })
})

describe('keysetWhere', () => {
  function seed(db: Db, n: number) {
    for (let i = 0; i < n; i++) {
      db.insert(rows)
        .values({ id: `id-${String(i).padStart(3, '0')}`, at: new Date((1000 + i) * 1000), label: `row-${i}` })
        .run()
    }
  }

  test('pages through a table ordered (at DESC, id DESC) with no repeats or skips', () => {
    const db = seedDb()
    seed(db, 23)

    const seen = new Set<string>()
    let cursor: { value: Date; id: string } | null = null
    let pages = 0
    for (;;) {
      const where = keysetWhere(cursor, rows.at, rows.id, 'desc')
      const page = db.select().from(rows).where(where).orderBy(desc(rows.at), desc(rows.id)).limit(5).all()
      if (page.length === 0) break
      for (const r of page) {
        expect(seen.has(r.id)).toBe(false)
        seen.add(r.id)
      }
      const last = page[page.length - 1]!
      cursor = { value: last.at, id: last.id }
      pages++
      expect(pages).toBeLessThan(20)
    }
    expect(seen.size).toBe(23)
  })

  test('ties on the sort column are broken by id, never duplicated or dropped', () => {
    const db = seedDb()
    // Every row shares the exact same `at` — only `id` can order them.
    const sameAt = new Date(5000 * 1000)
    for (let i = 0; i < 12; i++) {
      db.insert(rows)
        .values({ id: `tie-${String(i).padStart(2, '0')}`, at: sameAt, label: `row-${i}` })
        .run()
    }

    const seen: string[] = []
    let cursor: { value: Date; id: string } | null = null
    for (;;) {
      const where = keysetWhere(cursor, rows.at, rows.id, 'desc')
      const page = db.select().from(rows).where(where).orderBy(desc(rows.at), desc(rows.id)).limit(3).all()
      if (page.length === 0) break
      seen.push(...page.map((r) => r.id))
      const last = page[page.length - 1]!
      cursor = { value: last.at, id: last.id }
      expect(seen.length).toBeLessThanOrEqual(12)
    }
    expect(new Set(seen).size).toBe(12)
    // Strictly descending by id, since `at` never changes across the set.
    expect(seen).toEqual([...seen].sort().reverse())
  })

  test('ascending order (the devices label case) also has no repeats or skips', () => {
    const db = seedDb()
    for (let i = 0; i < 17; i++) {
      db.insert(rows)
        .values({ id: `id-${String(i).padStart(3, '0')}`, at: new Date(i * 1000), label: `label-${String(i).padStart(3, '0')}` })
        .run()
    }

    const seen = new Set<string>()
    let cursor: { value: string; id: string } | null = null
    for (;;) {
      const where = keysetWhere(cursor, rows.label, rows.id, 'asc')
      const page = db.select().from(rows).where(where).orderBy(asc(rows.label), asc(rows.id)).limit(4).all()
      if (page.length === 0) break
      for (const r of page) {
        expect(seen.has(r.id)).toBe(false)
        seen.add(r.id)
      }
      const last = page[page.length - 1]!
      cursor = { value: last.label, id: last.id }
    }
    expect(seen.size).toBe(17)
  })

  test('a row inserted mid-paging (older than the cursor) is never skipped or repeated', () => {
    const db = seedDb()
    seed(db, 10)

    const where1 = keysetWhere(null, rows.at, rows.id, 'desc')
    const page1 = db.select().from(rows).where(where1).orderBy(desc(rows.at), desc(rows.id)).limit(4).all()
    expect(page1).toHaveLength(4)
    const cursor1 = { value: page1[page1.length - 1]!.at, id: page1[page1.length - 1]!.id }

    // Insert a brand-new row that is newer than everything (simulates a
    // concurrent write while the operator sits on page 1) — it must not
    // appear on page 2, and nothing already on page 1 should shift.
    db.insert(rows).values({ id: 'zzz-new', at: new Date(9999 * 1000), label: 'new' }).run()

    const where2 = keysetWhere(cursor1, rows.at, rows.id, 'desc')
    const page2 = db.select().from(rows).where(where2).orderBy(desc(rows.at), desc(rows.id)).limit(4).all()
    const ids2 = page2.map((r) => r.id)
    expect(ids2).not.toContain('zzz-new')
    expect(ids2.some((id) => page1.map((r) => r.id).includes(id))).toBe(false)
  })
})
