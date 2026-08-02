import { and, eq, gt, lt, or, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Context } from 'hono'
import { EnkakuError } from '../util/errors'

/**
 * One keyset envelope for every list endpoint (plan 30 §4.1, §3.3).
 *
 * The cursor is opaque to the client: base64 of `${sortValue}:${id}`. That
 * keeps the sort key free to change later without breaking a bookmarked
 * page, and it keeps `id` as a mandatory tiebreaker — unix-second timestamps
 * collide constantly (a batch stamps one `now` across every job in it), so
 * ordering by the sort column alone would skip or repeat rows across a page
 * boundary (plan 30 §3.2).
 */

export interface PageQuery {
  cursor: string | null
  limit: number
}

export interface Page<T> {
  items: T[]
  /** Pass back as `?cursor=` for the next page. Null when this is the last one. */
  nextCursor: string | null
  /** Total matching rows, when cheap to count. Null when the query cannot say. */
  total: number | null
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Parse and clamp `?cursor=&limit=`; limit defaults to 50, max 200. */
export function parsePageQuery(c: Context): PageQuery {
  const limitParam = c.req.query('limit')
  let limit = DEFAULT_LIMIT
  if (limitParam !== undefined) {
    const n = Number.parseInt(limitParam, 10)
    if (!Number.isFinite(n) || n < 1) {
      throw new EnkakuError('E_BAD_REQUEST', "'limit' must be a positive integer")
    }
    // Clamped, not honoured (plan 30 acceptance #3) — a caller asking for
    // 100000 rows gets the cap silently, not an error and not everything.
    limit = Math.min(n, MAX_LIMIT)
  }
  const cursor = c.req.query('cursor') ?? null
  return { cursor, limit }
}

/** Encode the opaque `${sortValue}:${id}` cursor. */
export function encodeCursor(sortValue: number | string, id: string): string {
  return btoa(`${sortValue}:${id}`)
}

function rawDecode(raw: string | null): { sortValue: string; id: string } | null {
  if (raw === null || raw === '') return null
  let decoded: string
  try {
    decoded = atob(raw)
  } catch {
    throw new EnkakuError('E_BAD_REQUEST', 'malformed cursor')
  }
  const idx = decoded.indexOf(':')
  // idx <= 0: no colon, or an empty sortValue. idx === length-1: an empty id.
  // A malformed cursor must return 400, not be silently ignored (plan 30 rule).
  if (idx <= 0 || idx === decoded.length - 1) {
    throw new EnkakuError('E_BAD_REQUEST', 'malformed cursor')
  }
  return { sortValue: decoded.slice(0, idx), id: decoded.slice(idx + 1) }
}

/**
 * Decode into a numeric-sort cursor — the common case (`createdAt`, `dueAt`,
 * every timestamp-ordered list in §4.2 but one).
 */
export function decodeCursor(raw: string | null): { sortValue: number; id: string } | null {
  const parsed = rawDecode(raw)
  if (!parsed) return null
  const sortValue = Number(parsed.sortValue)
  if (!Number.isFinite(sortValue)) throw new EnkakuError('E_BAD_REQUEST', 'malformed cursor')
  return { sortValue, id: parsed.id }
}

/**
 * Decode into a string-sort cursor — `/api/devices` is the odd one (plan 30
 * §4.2): it sorts by `label` ASC, not a timestamp.
 */
export function decodeStringCursor(raw: string | null): { sortValue: string; id: string } | null {
  return rawDecode(raw)
}

/**
 * Build the keyset predicate for `ORDER BY <col> DESC, id DESC` (or ASC for
 * the one browse list that sorts ascending). `cursor.value` must already be
 * in the column's own mapped type — a `Date` for a `{ mode: 'timestamp' }`
 * column, a plain string for a text column like `devices.label` — because
 * that mapping differs per endpoint and only the caller knows it.
 */
export function keysetWhere(
  cursor: { value: Date | number | string; id: string } | null,
  col: SQLiteColumn,
  idCol: SQLiteColumn,
  dir: 'asc' | 'desc' = 'desc',
): SQL | undefined {
  if (!cursor) return undefined
  const cmp = dir === 'desc' ? lt : gt
  // The column's mapped type varies per call site (Date vs string); Drizzle's
  // column-level typing can't express that generically here, so the value is
  // passed through as given — the caller is responsible for matching it to
  // `col`'s own type.
  const value = cursor.value as never
  const idValue = cursor.id as never
  return or(cmp(col, value), and(eq(col, value), cmp(idCol, idValue)))
}
