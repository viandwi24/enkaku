import type { DataSource, KvEntry, PluginDataScanRow, PluginQueryRow } from '@enkaku/protocol'
import { getAtPath } from '../schema-form/resolve'

/**
 * Plan 108 §4.2, §4.3, §5 step 108.7 — what a ROW is, for a tier-A view.
 *
 * Pure and DOM-free, split out of `ViewRenderer` for two reasons: the
 * flattening rule is the one piece of that component worth testing without a
 * fetch, and `ActionRunner` needs `readRowField`/`rowPayload` too — importing
 * them from here rather than from the component keeps the two files acyclic.
 *
 * `$device` and `$entry` are real keys on the POSTed row, not a parallel
 * lookup table, because `action-executor.ts`'s `RowEnvelopeSchema` lifts them
 * straight back out of it server-side. One shape, written once, read on both
 * sides of the wire.
 */

/** The six allowlisted device fields of plan §3.6, as a row carries them. */
export interface RowDevice {
  id: string
  stableId: string
  label: string | null
  status: string | null
  groupId: string | null
  /** The short human-facing number (plan 89 §3.1); `null` when none is allocated, which renders as an empty cell. */
  number: number | null
}

/** KV entry METADATA — never the value, which is reached through `$row`. */
export interface RowEntry {
  key: string
  version: number
  updatedAt: number
}

export interface PluginViewRow {
  /** React key and selection key. Unique within one load; never sent anywhere. */
  id: string
  /** The row's own value — the entry's value, or one element of `itemsAt`. Read by every non-`$` column field. */
  value: unknown
  device: RowDevice | null
  entry: RowEntry | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * One column's (or one binding's) value. `$device.*` and `$entry.*` read from
 * the row's CONTEXT; everything else is a dot path into the row's own value
 * — plan §4.3's worked example mixes all three in one table.
 *
 * A `$`-prefixed field naming neither context is `undefined` rather than a
 * lookup into the value: an author who typed `$devcie.label` gets an empty
 * cell they can see, not a silent read of a key that happens to exist.
 */
export function readRowField(row: PluginViewRow, field: string): unknown {
  if (field === '$device') return row.device
  if (field === '$entry') return row.entry
  if (field.startsWith('$device.')) return getAtPath(row.device, field.slice('$device.'.length))
  if (field.startsWith('$entry.')) return getAtPath(row.entry, field.slice('$entry.'.length))
  if (field.startsWith('$')) return undefined
  return getAtPath(row.value, field)
}

/** What `POST /:name/action/:actionId` receives as `row` — the row's own
 *  fields with `$device`/`$entry` alongside them, exactly the shape
 *  `RowEnvelopeSchema` parses. Context wins over a same-named value key. */
export function rowPayload(row: PluginViewRow): Record<string, unknown> {
  return { ...(isPlainObject(row.value) ? row.value : {}), $device: row.device, $entry: row.entry }
}

function entryOf(entry: KvEntry | null): RowEntry | null {
  return entry ? { key: entry.key, version: entry.version, updatedAt: entry.updatedAt } : null
}

/**
 * `kv.scan` → rows.
 *
 * `includeMissing` is applied HERE, not by the route: `GET /:name/data/scan`
 * is a LEFT JOIN and always answers one row per device (`entry: null` for a
 * device that has never stored the key), because that shape is what makes
 * "never synced" visible at all. Dropping those rows when an author asked for
 * `includeMissing: false` is a rendering decision, and this is the renderer's
 * pure half.
 *
 * `rows: 'items'` over a device whose entry is missing, whose `itemsAt` path
 * resolves to nothing, or whose array is empty still yields ONE row (with no
 * value) whenever `includeMissing` is on — that is the entire point of the
 * flag (§4.2: "so 'never synced' is visible rather than absent"), and
 * dropping the device the moment it has zero items would make the flag mean
 * nothing in the one mode the plan's own worked example uses.
 */
export function rowsFromScan(items: PluginDataScanRow[], source: Extract<DataSource, { kind: 'kv.scan' }>): PluginViewRow[] {
  const rows: PluginViewRow[] = []
  for (const item of items) {
    if (!source.includeMissing && item.entry === null) continue
    const device: RowDevice = {
      id: item.deviceId,
      stableId: item.stableId,
      label: item.label,
      status: item.status,
      clusterId: item.clusterId,
      number: item.number,
    }
    const entry = entryOf(item.entry)

    if (source.rows === 'entry') {
      rows.push({ id: `${item.stableId}#entry`, value: item.entry?.value, device, entry })
      continue
    }

    const at = source.itemsAt === '' ? item.entry?.value : getAtPath(item.entry?.value, source.itemsAt)
    const list = Array.isArray(at) ? at : []
    if (list.length === 0) {
      if (source.includeMissing) rows.push({ id: `${item.stableId}#empty`, value: undefined, device, entry })
      continue
    }
    list.forEach((element, index) => {
      rows.push({ id: `${item.stableId}#${index}`, value: element, device, entry })
    })
  }
  return rows
}

/** `kv.list` → rows. One global entry each; no device context exists to carry. */
export function rowsFromList(items: KvEntry[]): PluginViewRow[] {
  return items.map((item) => ({ id: `global#${item.key}`, value: item.value, device: null, entry: entryOf(item) }))
}

/**
 * `{ kind: 'handler' }` → rows (plan 109 §4.6, step 109.6).
 *
 * A near-identity, and that is the whole point of the wire shape. A query
 * handler answers `{ value, device?, entry?, id? }` — the same three things a
 * `kv.scan` row carries — so a handler-backed table goes through the SAME
 * `readRowField`/`planColumn` path as a scanned one. `$device.label` means one
 * thing on this screen whether the core joined the device row or the plugin
 * filled it in, and `rowPayload` hands `POST /:name/action/:actionId` the same
 * envelope either way.
 *
 * `id` is prefixed rather than used raw so a handler's own `"1"` cannot collide
 * with a `kv.scan` row key if a view ever shows both.
 */
export function rowsFromQuery(items: PluginQueryRow[]): PluginViewRow[] {
  return items.map((item, index) => ({
    id: `handler#${item.id ?? index}`,
    value: item.value,
    device: item.device ?? null,
    entry: item.entry ?? null,
  }))
}
