import { shellQuote } from '@enkaku/adb'
import type { DeviceMediaItem, DeviceMediaKind, DeviceMediaListResult } from '@enkaku/protocol'

/**
 * Reading MediaStore over the shell — the counterpart to `transfer.ts`'s
 * `runMediaScan`, and built the same way for the same reason: the shell user
 * is not subject to scoped storage, so `content query` answers without an APK
 * or a guest-agent capability (plan 90 §3.1).
 *
 * The parser is separated from the adb call on purpose. `content`'s output
 * format is the fragile part — it is a debug-shaped dump, not a documented
 * wire format — so it is a pure function over a string, tested against real
 * captures, and the transport around it holds no parsing logic at all.
 */

/** One `content://media/external/<segment>/media` URI per kind. Closed, so a caller can never name a URI. */
const VOLUME_SEGMENT: Record<DeviceMediaKind, string> = {
  image: 'images',
  video: 'video',
  audio: 'audio',
}

/**
 * Asked for in this order, and `content` echoes columns in projection order.
 * `duration` is deliberately absent for images: on several builds MediaStore's
 * images volume has no such column and the whole query fails with
 * "no such column" rather than returning rows with a null — one missing field
 * would otherwise cost the entire answer.
 */
const BASE_COLUMNS = ['_id', '_display_name', '_data', 'date_added', '_size', 'mime_type'] as const
const columnsFor = (kind: DeviceMediaKind): string[] =>
  kind === 'image' ? [...BASE_COLUMNS] : [...BASE_COLUMNS, 'duration']

/**
 * Splits one `Row:` line into its columns.
 *
 * `content` separates columns with `", "` and does NOT quote or escape values,
 * so a display name containing a comma-space — `"clip, final.mp4"`, which a
 * phone will happily hold — makes a naive `split(', ')` produce garbage
 * columns and silently corrupt the row next to it. Splitting only where the
 * separator is followed by a column name we actually asked for removes that
 * whole class of bug: the boundaries come from the projection, not from the
 * data.
 *
 * A column absent from the row (older builds simply omit one they cannot
 * supply, rather than emitting `NULL`) is reported as null, never as the
 * empty string — "the device did not say" and "the device said nothing" are
 * different answers.
 */
export function parseContentRow(line: string, columns: readonly string[]): Record<string, string | null> {
  const body = line.replace(/^Row:\s*\d+\s*/, '')
  const boundary = new RegExp(`,\\s+(?=(?:${columns.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})=)`)
  const out: Record<string, string | null> = Object.fromEntries(columns.map((c) => [c, null]))
  for (const part of body.split(boundary)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    if (!columns.includes(key)) continue
    const raw = part.slice(eq + 1)
    // `content` prints a SQL NULL as the bare token `NULL`. A file genuinely
    // named "NULL" is not distinguishable here and is not worth the ambiguity.
    out[key] = raw === 'NULL' ? null : raw
  }
  return out
}

/** `content` prints this, not an empty string, when a query matches nothing. */
const NO_RESULT = /^\s*No result found\.?\s*$/im

export function parseContentQuery(stdout: string, columns: readonly string[]): Record<string, string | null>[] {
  if (NO_RESULT.test(stdout)) return []
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('Row:'))
    .map((l) => parseContentRow(l.trimEnd(), columns))
}

const int = (v: string | null): number | null => {
  if (v === null) return null
  const n = Number.parseInt(v, 10)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** One parsed row → the wire shape. Returns null for a row with no usable identity, which is never worth surfacing. */
export function rowToMediaItem(row: Record<string, string | null>, kind: DeviceMediaKind): DeviceMediaItem | null {
  // `?? null` on every read: a column absent from the projection reads back as
  // `undefined`, and the wire shape distinguishes only "a value" from "null".
  const id = row._id ?? null
  if (id === null || id === '') return null
  const path = row._data ?? null
  return {
    id,
    kind,
    // A row can genuinely lack `_display_name`; the filename off `_data` is the
    // same string the gallery would show, so it is a derivation, not a guess.
    displayName: row._display_name ?? path?.split('/').pop() ?? id,
    path,
    addedAt: int(row.date_added ?? null) ?? 0,
    sizeBytes: int(row._size ?? null),
    durationMs: kind === 'image' ? null : int(row.duration ?? null),
    mimeType: row.mime_type ?? null,
  }
}

export interface MediaQueryBackend {
  exec(cmd: string): Promise<{ exitCode: number | null; stdout: string } | null>
}

/**
 * Newest first. The sort is pushed to the device (`date_added DESC`) rather
 * than done here because the output cap, not the row count, is the real
 * ceiling: a phone with ten thousand photos would have its oldest rows
 * truncated by the adb output budget before this process ever saw them, and
 * sorting host-side would then return the wrong "newest".
 *
 * `LIMIT` is appended to the sort clause — the only way `content` exposes one
 * — and a build that rejects it (stricter SQL validation on newer API levels)
 * falls back to the bare sort with host-side truncation. Both paths return the
 * same answer for the head of the list, which is the part any caller uses.
 */
export async function queryDeviceMedia(
  backend: MediaQueryBackend,
  args: { kind: DeviceMediaKind; limit: number; underPath?: string },
): Promise<DeviceMediaListResult> {
  const columns = columnsFor(args.kind)
  const uri = `content://media/external/${VOLUME_SEGMENT[args.kind]}/media`
  const base = `content query --uri ${uri} --projection ${columns.join(':')}`
  // One extra row is requested so `truncated` is a fact about the device's own
  // row count, not an inference from "we happened to fill the window".
  const probe = args.limit + 1

  let res = await backend.exec(`${base} --sort ${shellQuote(`date_added DESC LIMIT ${probe}`)}`)
  if (!res || res.exitCode !== 0) {
    res = await backend.exec(`${base} --sort ${shellQuote('date_added DESC')}`)
  }
  if (!res || res.exitCode !== 0) return { items: [], truncated: false }

  let items = parseContentQuery(res.stdout, columns)
    .map((r) => rowToMediaItem(r, args.kind))
    .filter((i): i is DeviceMediaItem => i !== null)

  if (args.underPath !== undefined) {
    const prefix = args.underPath.endsWith('/') ? args.underPath : `${args.underPath}/`
    // `path === null` is dropped rather than kept: a row whose location is
    // unknown cannot be asserted to be under the requested one.
    items = items.filter((i) => i.path !== null && (i.path === args.underPath || i.path.startsWith(prefix)))
  }

  // The LIMIT path may be ignored by the device; sorting is already done, so
  // this is a window, never a re-order.
  const truncated = items.length > args.limit
  return { items: truncated ? items.slice(0, args.limit) : items, truncated }
}

/**
 * The MediaStore `_id` for one exact on-device path, or null when it cannot be
 * known. Used right after a scan to turn "MediaStore was told" into "MediaStore
 * has this row" (`MediaScanResult.mediaId`).
 *
 * Queries the volume by `_data` rather than listing and matching host-side:
 * the row is looked up by the identity we actually have, so a concurrent
 * capture landing in the same millisecond cannot be mistaken for it.
 */
export async function findMediaIdForPath(
  backend: MediaQueryBackend,
  kind: DeviceMediaKind,
  remotePath: string,
): Promise<string | null> {
  const uri = `content://media/external/${VOLUME_SEGMENT[kind]}/media`
  const res = await backend.exec(
    `content query --uri ${uri} --projection _id:_data --where ${shellQuote(`_data=${sqlQuote(remotePath)}`)}`,
  )
  if (!res || res.exitCode !== 0) return null
  const rows = parseContentQuery(res.stdout, ['_id', '_data'])
  // Exactly one row is expected; more than one means the volume holds
  // duplicates for this path and no single id is the honest answer.
  if (rows.length !== 1) return null
  const id = rows[0]?._id
  return id === null || id === undefined || id === '' ? null : id
}

/**
 * Quotes a value for the SQL `--where` clause, which sits INSIDE the shell
 * quoting `shellQuote` applies — two different escapes, in two different
 * languages, and collapsing them into one is how an injection gets in. SQL
 * string literals escape a single quote by doubling it.
 */
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
