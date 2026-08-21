import { z } from '@enkaku/ui'
import {
  PROXY_LOGS_DEFAULT_LIMIT,
  PROXY_PROBE_KEY_PREFIX,
  PROXY_STATE_LABELS as SHARED_PROXY_STATE_LABELS,
  readProxyProbe,
  readProxyRecord,
  writeProxyRecord,
  type ProxyProbeResult,
  type ProxyRecord,
} from '../../shared'

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

/**
 * This pack's OWN service handlers (`ctx.onRequest`, plan 109 step 109.6),
 * mounted by the core at `/api/plugins/proxy-manager/http/*` with the core's
 * auth, TLS, CORS, rate limiting and audit applying unchanged.
 *
 * **Nothing here opens a port to serve a UI** — plan 109 §3.7 names that as the
 * trap, and a `Bun.listen` of the plugin's own would inherit none of those five.
 *
 * CRUD does NOT live here: creating, editing and deleting a record stays on
 * `PUT`/`DELETE …/data/entry`, the operator-facing `plugin.data` door that
 * already audits every write and takes the namespace from the URL server-side.
 * A second write path would be the weaker parallel one 00-overview §4.3 forbids
 * (plan 112 §4.6).
 */
export const PROXY_HTTP_API = `${PLUGIN_API}/http`

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

/**
 * What `POST /api/plugins/proxy-manager/http/apply` answers (plan 114 step
 * 114.9) — this pack's own service handler, not a farm endpoint.
 *
 * Both outcomes are `200`. A refusal is an ordinary product outcome the screen
 * words differently per `kind` (plan 59: a precondition is not a failure), not
 * an HTTP error; a real fault throws inside the handler and the host answers
 * `502` naming the plugin, which `api()` surfaces as a thrown error.
 */
export const ApplyResultSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    deviceId: z.string(),
    proxy: z.string(),
    /**
     * Which mode actually landed, echoed by the handler.
     *
     * The screen words the outcome from THIS rather than from the dropdown on
     * the row: the dropdown is live and an operator can move it while the
     * request is in flight, and a success line that said "VPN" over a route the
     * farm applied as an HTTP proxy would be the exact confusion the two modes
     * are kept apart to prevent.
     */
    mode: z.string(),
    engine: z.string(),
    health: z.string(),
    setBy: z.object({ kind: z.string(), id: z.string(), at: z.number() }).nullable(),
  }),
  z.looseObject({ ok: z.literal(false), mode: z.string().optional(), code: z.string(), kind: z.string(), message: z.string() }),
])
export type ApplyResult = z.infer<typeof ApplyResultSchema>

/** The device-scoped assignment note: which catalogue key a device is meant to use. */
export function readAssignment(value: unknown): string {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const proxy = source.proxy
  return typeof proxy === 'string' ? proxy : ''
}

// ---------------------------------------------------------------------------
// What a bridge is DOING — the supervisor's observation (plan 112 §3.5, §3.7)
// ---------------------------------------------------------------------------

/**
 * The five words a bridge can be in, plus the one this screen adds.
 *
 * The five are the supervisor's own (`src/service/supervisor.ts`), which are in
 * turn plan 109's service vocabulary, with plan 109's own rule: **`starting` is
 * never worded as `running`**, and a row mid-drain is `stopping` rather than
 * either. `docs/design.md` states it generally — *a degraded or partial state
 * is never worded as the full one* — and a proxy is exactly where breaking it
 * costs something: an operator who reads "stopped" on a bridge that is still
 * carrying a download will pull the port out from under it.
 *
 * **`unknown` is this screen's, and it is not a sixth state.** It means the
 * farm did not tell us — the service is not running, the route answered an
 * error, or it answered a word this build does not know. A missing observation
 * rendered as `stopped` would be a claim nobody made.
 *
 * The five supervisor states now come from `shared.ts` — one declaration both
 * halves read, so a renamed state cannot mean two things (the second copy that
 * used to live here is gone). `unknown` is added HERE and only here, because it
 * is not a supervisor state at all: it means the runtime read failed, which is
 * a fact about the farm's answer rather than about the bridge.
 */
export const PROXY_STATE_LABELS = {
  ...SHARED_PROXY_STATE_LABELS,
  unknown: 'Unknown',
} as const

export type ProxyState = keyof typeof PROXY_STATE_LABELS

/** What each word means, in the plain sentence the row shows under it. */
export const PROXY_STATE_MEANING: Record<ProxyState, string> = {
  stopped: 'Nothing is listening on this record’s port.',
  starting: 'The listener is being bound. It is not accepting connections yet.',
  running: 'The listener is bound and accepting connections.',
  stopping: 'The port is already released and no new connection is accepted; the tunnels still open are being given until the drain runs out.',
  failed: 'The last start did not bind. The reason is on this row.',
  unknown: 'The farm did not report a state for this record — the service may not be running.',
}

function isProxyState(value: unknown): value is ProxyState {
  return typeof value === 'string' && value in PROXY_STATE_LABELS
}

/**
 * One row of `GET /api/plugins/proxy-manager/http/proxies`: the persisted
 * record joined with what the supervisor observes about it.
 *
 * **None of this is stored anywhere** (plan 112 §3.5). It lives in the
 * supervisor's memory and is gone when the core restarts — which is correct,
 * because the listener is gone then too. A persisted `running` that survived a
 * crash would be a lie the moment it was read. What IS persisted is the
 * record's `enabled` flag, which is intent, and the two are shown as separate
 * columns for exactly that reason.
 */
export interface ProxyStatus {
  /** The same id the start/stop/restart routes take — a storage key without its `proxy:` prefix. */
  id: string
  /** The storage key, when the farm reported one, so a row can be matched either way. */
  key: string | null
  state: ProxyState
  /** The word the farm actually answered with, kept for the row that says `unknown` because it was something else. */
  rawState: string
  /** Unix MILLISECONDS the current state was entered (the supervisor's own unit), or null. */
  since: number | null
  /** How long this bridge has been up, in ms — `null` unless it is running, because an uptime for something that is not up reads as a lie. */
  uptimeMs: number | null
  /** The port actually bound, which is not necessarily the port the record names. */
  port: number | null
  liveConnections: number
  totalConnections: number
  refusedConnections: number
  bytesUp: number
  bytesDown: number
  lastError: { code: string; message: string } | null
  /** This record's failover state (plan 121 §4.5, step 121.6) — `null` when nothing is running, since there is no failover state for a record with no live listener. */
  failover: ProxyFailoverSnapshot | null
}

/**
 * What `ProxyRow.failover` (`service/handlers.ts`) narrows a record's
 * failover state down to — `activeIndex` (`0` = primary, `1..n` =
 * `fallbackUpstreams[i-1]`, the same addressing `failover.ts`'s own
 * `FailoverState` uses) and `history`, most-recent-first, for the chip's
 * detail popover.
 */
export interface ProxyFailoverSnapshot {
  activeIndex: number
  history: { at: number; from: number; to: number; reason: string }[]
}

function readFailoverSnapshot(value: unknown): ProxyFailoverSnapshot | null {
  const source = asObject(value)
  if (typeof source.activeIndex !== 'number') return null
  const rawHistory = Array.isArray(source.history) ? source.history : []
  const history = rawHistory
    .map((raw) => asObject(raw))
    .filter((h) => typeof h.at === 'number' && typeof h.from === 'number' && typeof h.to === 'number')
    .map((h) => ({ at: h.at as number, from: h.from as number, to: h.to as number, reason: typeof h.reason === 'string' ? h.reason : '' }))
  return { activeIndex: source.activeIndex, history }
}

/**
 * The envelope, and only the envelope.
 *
 * `{ items: [...] }` is what every other list this screen reads answers with —
 * the KV page, the device scan, the jobs list — so it is what this one asks
 * for. A bare array is accepted too because the handler is being built beside
 * this file and a screen that throws on the shape rather than reading it would
 * be the worse failure of the two.
 *
 * The ROWS are read by hand below rather than parsed, for the same reason
 * `readProxyRecord` is a hand reader: a field this screen does not draw must
 * never be able to fail the page it is on.
 */
export const ProxyStatusPageSchema = z.union([z.looseObject({ items: z.array(z.unknown()) }), z.array(z.unknown())])

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function num(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableNum(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * One row → a `ProxyStatus`, tolerating both the flat shape and one that nests
 * the observation under `runtime` (which is what the supervisor's own
 * `ProxyRuntime` is called in the service).
 */
function readProxyStatus(value: unknown): ProxyStatus | null {
  const source = asObject(value)
  const runtime = source.runtime === undefined ? source : asObject(source.runtime)
  const id = typeof source.id === 'string' ? source.id : typeof runtime.id === 'string' ? runtime.id : null
  const key = typeof source.key === 'string' ? source.key : null
  if (id === null && key === null) return null
  const rawState = typeof runtime.state === 'string' ? runtime.state : ''
  const error = asObject(runtime.lastError)
  return {
    id: id ?? (key as string),
    key,
    state: isProxyState(rawState) ? rawState : 'unknown',
    rawState,
    since: nullableNum(runtime, 'since'),
    uptimeMs: nullableNum(runtime, 'uptimeMs'),
    port: nullableNum(runtime, 'port'),
    liveConnections: num(runtime, 'liveConnections', 0),
    totalConnections: num(runtime, 'totalConnections', 0),
    refusedConnections: num(runtime, 'refusedConnections', 0),
    bytesUp: num(runtime, 'bytesUp', 0),
    bytesDown: num(runtime, 'bytesDown', 0),
    lastError: typeof error.code === 'string' || typeof error.message === 'string' ? { code: String(error.code ?? ''), message: String(error.message ?? '') } : null,
    failover: readFailoverSnapshot(runtime.failover),
  }
}

/** Every row the farm answered with, keyed by BOTH its id and its storage key so a caller can look one up either way. */
export function readProxyStatuses(page: z.infer<typeof ProxyStatusPageSchema>): Map<string, ProxyStatus> {
  const rows = Array.isArray(page) ? page : page.items
  const byId = new Map<string, ProxyStatus>()
  for (const raw of rows) {
    const status = readProxyStatus(raw)
    if (!status) continue
    byId.set(status.id, status)
    if (status.key) byId.set(status.key, status)
  }
  return byId
}

// ---------------------------------------------------------------------------
// What was actually observed leaving — the probe (plan 117 §3.7, §4.5)
// ---------------------------------------------------------------------------

/** Re-exported for the same reason `ProxyRecord` above is: one shape, read by both `catalogue.tsx` and this file. */
export type { ProxyProbeResult } from '../../shared'

/**
 * Every `proxy-probe:<id>` row the KV store answered with, keyed by id — this
 * screen's own read of what `service/probe.ts` last wrote for each record.
 *
 * A page of ordinary KV entries, the same shape `readProxy` and the credential
 * read in `catalogue.tsx` already parse, so this reuses `KvPage` rather than
 * declaring a fourth wire shape: `readProxyProbe` (`shared.ts`) is what turns
 * one entry's `value` into a `ProxyProbeResult`, defensively, the same
 * discipline `readProxy` already applies to a record.
 */
export function readProxyProbes(page: KvPage): Map<string, ProxyProbeResult> {
  const byId = new Map<string, ProxyProbeResult>()
  for (const entry of page.items) {
    if (!entry.key.startsWith(PROXY_PROBE_KEY_PREFIX)) continue
    const probe = readProxyProbe(entry.value)
    if (probe) byId.set(entry.key.slice(PROXY_PROBE_KEY_PREFIX.length), probe)
  }
  return byId
}

// ---------------------------------------------------------------------------
// The log — one stream, filtered (plan 112 §3.8)
// ---------------------------------------------------------------------------

/**
 * A page of this plugin's own service log, as
 * `GET /api/plugins/proxy-manager/http/logs` serves it — the same shape
 * `ctx.logs.page()` answers with (`PluginLogPageSchema` in `@enkaku/protocol`),
 * declared here rather than imported because importing that barrel would pull
 * the farm's whole schema catalogue into a module the browser downloads.
 *
 * **`truncated` is the honest flag and it means one specific thing**: lines
 * this reader will never see were dropped from the ring. It is not "the plugin
 * has been quiet" and it is not "there is more to fetch" — `nextSeq` is that.
 * There is ONE ring for this whole plugin, so a busy proxy evicts a quiet one's
 * lines, and without this flag that reads as a proxy that did nothing.
 *
 * `level` is a plain string rather than an enum: a level this build has not
 * heard of must render as itself, not fail the page it arrived on.
 */
export const LogLineSchema = z.looseObject({
  seq: z.number(),
  /** Unix MILLISECONDS — the core stamps `Date.now()` (`plugins/runtime-logs.ts`). */
  ts: z.number(),
  level: z.string(),
  /** What inside the plugin this line is about — this pack tags a bridge's lines with the record's id. `null` for a line that belongs to no single proxy. */
  subject: z.string().nullable().default(null),
  msg: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
})
export type LogLine = z.infer<typeof LogLineSchema>

export const LogPageSchema = z.looseObject({
  lines: z.array(LogLineSchema),
  truncated: z.boolean().default(false),
  nextSeq: z.number().default(0),
  /** The tag the farm filtered on (`proxy:<id>`, clamped), echoed so a client can tell a filtered page from an unfiltered one — see `LogsTab`, which checks it rather than trusting the request. */
  subject: z.string().nullable().default(null),
  /** The id this pack's own handler was asked for, echoed beside the farm's tag so the screen never has to re-derive one. */
  proxy: z.string().nullable().default(null),
})
export type LogPage = z.infer<typeof LogPageSchema>

/**
 * Where a proxy's log lines are asked for.
 *
 * **`?proxy=` carries the record's ID and the FARM does the filtering.** The
 * handler turns that id into the tag its own lines carry — the storage key,
 * clamped to the 64 characters the core stores — and passes it to
 * `ctx.logs.page({ subject })`. Sending the tag from here would mean two places
 * deriving one string, and the failure when they drift is silent in the worst
 * way: no line matches, and a proxy with a long key has a log view that is
 * permanently and honestly empty.
 *
 * There is deliberately no client-side predicate over a fetched page. It would
 * look identical and be wrong: the page it filtered has already had this
 * proxy's lines evicted by a busier one, and it would report neither.
 */
export function logsPath(opts: { proxy: string | null; cursor: number | null; limit?: number }): string {
  const params = new URLSearchParams()
  if (opts.cursor !== null) params.set('cursor', String(opts.cursor))
  if (opts.proxy !== null) params.set('proxy', opts.proxy)
  params.set('limit', String(opts.limit ?? PROXY_LOGS_DEFAULT_LIMIT))
  return `${PROXY_HTTP_API}/logs?${params.toString()}`
}

/**
 * One of the three verbs, on one proxy.
 *
 * `…/http/<verb>/<id>`, **not** `…/http/proxies/<id>/<verb>` — the core takes
 * the first path segment after `/http/` as the handler id, so the list and the
 * three actions cannot be one registration without also being one permission
 * (the list is `script.view`; acting is `plugin.runtime`). The audit log is the
 * other half of the reason: `plugin.http` records the handler id and the method
 * and never the sub-path, so a single handler would leave every start, stop and
 * force stop as one indistinguishable row.
 */
export function proxyActionPath(verb: 'start' | 'stop' | 'restart' | 'reset-failover', id: string): string {
  return `${PROXY_HTTP_API}/${verb}/${encodeURIComponent(id)}`
}
