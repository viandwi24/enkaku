import { z } from '@enkaku/ui'
import { readProxyRecord, writeProxyRecord, type ProxyRecord } from '../../shared'

/**
 * The farm, from the browser (plan 111 §3.4).
 *
 * There is no bridge and no RPC: a tier-C plugin's `fetch` reaches the core
 * with the operator's own session, exactly as Studio's own code does.
 *
 * **This file used to carry its own `fetch`.** When 111.7 built this pack,
 * `@enkaku/ui` was the 28 components and `cn`, so the pack wrote a `farm()`
 * helper, its own error unwrapping, and its own `CORE_ORIGIN` derived from
 * `new URL(import.meta.url).origin` — about thirty lines that every tier-C
 * plugin after it would have written again, slightly differently. All three
 * are now in `@enkaku/ui`:
 *
 * - **`api(path, schema, init?)`** — the same helper Studio's own screens
 *   call. It unwraps the farm's `{error: {code, message}}` envelope, defaults
 *   to POST when a `json` body is present, sends `credentials: 'include'` so
 *   a cross-origin dev setup still carries the session, and validates the
 *   response instead of casting it.
 * - **`coreBase()`**, which `api()` uses — the "where is the core" question
 *   this file used to answer alone with `new URL(import.meta.url).origin`.
 *   `@enkaku/ui` is external, so this resolves to STUDIO's copy, and Studio's
 *   answer is the right one for this pack in both deployments: served by the
 *   core it is the page's origin, and under `bun run dev:studio` it is the
 *   configured :7700 — which is where this very module was served from.
 * - **`z`** — the host's Zod, so a schema costs this bundle nothing.
 *
 * What is left here is what genuinely belongs to this pack: the shapes it
 * reads and the two functions that read and write a proxy record.
 *
 * Paths below are relative, because `api()` resolves them against the core.
 */

/** This plugin's own doors: its KV namespace and its assets. The namespace is taken from this path server-side and can never be another plugin's. */
export const PLUGIN_API = '/api/plugins/proxy-manager'

/** The rest of the farm — the jobs list, for the Runs tab. */
export const FARM_API = '/api'

// ---------------------------------------------------------------------------
// The wire shapes this screen reads
// ---------------------------------------------------------------------------

/**
 * Declared here rather than imported from `@enkaku/protocol`, which does
 * define all three (`PluginDataListResponseSchema`,
 * `PluginDataScanResponseSchema`). That package is not external to a plugin's
 * build, so importing its barrel would pull its whole schema catalogue into
 * this pack's `ui/index.js`. A plugin narrows the wire to the fields its
 * screen actually draws; that is the tier-C trade, and it is why these are
 * loose objects — an unknown field the core adds later is ignored, not an
 * error in an operator's face.
 */
const KvEntrySchema = z.looseObject({
  key: z.string(),
  value: z.unknown(),
  secret: z.boolean(),
  version: z.number(),
  updatedAt: z.number(),
})

/** One row of this plugin's KV namespace, as `GET /api/plugins/:name/data` returns it. */
export type KvEntry = z.infer<typeof KvEntrySchema>

export const KvPageSchema = z.looseObject({ items: z.array(KvEntrySchema), nextCursor: z.string().nullable() })
export type KvPage = z.infer<typeof KvPageSchema>

/** One device, as `GET /api/plugins/:name/data/scan?key=…` returns it — the device plus whether it holds that key. */
const ScanRowSchema = z.looseObject({
  stableId: z.string(),
  label: z.string().nullable(),
  status: z.string().nullable(),
  entry: KvEntrySchema.nullable(),
})
export type ScanRow = z.infer<typeof ScanRowSchema>

export const ScanPageSchema = z.looseObject({ items: z.array(ScanRowSchema), nextCursor: z.string().nullable() })
export type ScanPage = z.infer<typeof ScanPageSchema>

/** One job, narrowed to the fields the Runs tab shows. `GET /api/jobs` returns a good deal more. */
const JobRowSchema = z.looseObject({
  jobId: z.string(),
  scriptName: z.string().nullable(),
  scriptVersion: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
})
export type JobRow = z.infer<typeof JobRowSchema>

export const JobsPageSchema = z.looseObject({ items: z.array(JobRowSchema) })
export type JobsPage = z.infer<typeof JobsPageSchema>

/**
 * The schema for a write whose body this screen does not read. `api()` makes
 * the schema required on purpose — an optional one is one a caller forgets —
 * so "I do not care what came back" is written down rather than defaulted
 * into.
 */
export const IgnoredSchema = z.unknown()

// ---------------------------------------------------------------------------
// Reading a stored value without trusting it
// ---------------------------------------------------------------------------

/**
 * A proxy record as this screen renders one — re-exported from `shared.ts`,
 * which is where the shape and the reader now live (plan 112 step 112.3).
 *
 * **The funnel did not move; its implementation did.** `readProxy` and
 * `writeProxy` are still the one pair every read and every write on this
 * screen goes through, and `index.test.ts` still runs a value through both and
 * parses the result against `ProxyRecordSchema`. What changed is that the
 * service — which runs in the core's process and cannot import anything from
 * `@enkaku/ui` — reads the same records. Two implementations of "what a stored
 * proxy means", one in the browser and one in the core, would be exactly the
 * drift this pair exists to prevent, so the body lives in `shared.ts` (which
 * imports nothing) and both sides call it.
 *
 * It is still read defensively, and not because the core is untrusted: a KV
 * namespace is a plugin's own scratch space, an earlier version of this pack
 * wrote a different shape (which is migrated on read, plan 112 §4.3), and an
 * operator with `kv.manage` can put anything at all under `proxy:`. A missing
 * field renders as blank rather than throwing inside a table row and taking
 * the tab down.
 */
export type { ProxyRecord } from '../../shared'

/** A stored value → a record the table can draw, upgrading the older shape on the way. */
export function readProxy(value: unknown): ProxyRecord {
  return readProxyRecord(value)
}

/** The exact object a record is STORED as — the write half of `readProxy`. */
export function writeProxy(record: ProxyRecord): Record<string, unknown> {
  return writeProxyRecord(record)
}

/** The device-scoped assignment note: which catalogue key a device is meant to use. */
export function readAssignment(value: unknown): string {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const proxy = source.proxy
  return typeof proxy === 'string' ? proxy : ''
}
