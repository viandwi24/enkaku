import type { z } from 'zod'
import {
  PluginServiceDeclarationSchema,
  type PluginCaller,
  type PluginResetReport,
  type PluginHttpMethod,
  type PluginListenerProto,
  type PluginQueryResult,
  type PluginLogPage,
  type PluginServiceDeclaration,
  type PluginWebhookInfo,
  type ReportedListener,
  type ServerMessage,
} from '@enkaku/protocol'
import type { KvApi, ScriptLogger } from './types'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.1. **One context, many entry
 * points** (§3.1, the owner's own framing): there is no separate "script API"
 * and "runtime API". A plugin's own helper function takes a `PluginContext`
 * and can be called from a script handler, an HTTP handler, a WebSocket
 * handler, an event handler or a query handler without changing a character —
 * that is acceptance criterion 2, and it is proved by a fixture called from
 * both ends rather than asserted here.
 *
 * The types in this file are the AUTHOR's half of that contract. The
 * assembler that turns a host's ports into one of these objects lives in
 * `@enkaku/session` (`plugin-context.ts`) and is shared by both hosts — see
 * that file's header for why it cannot live here.
 */

/**
 * A plugin's key/value store, scoped (plan 79's `KvApi`, unchanged and
 * deliberately not re-declared — a second definition of the same seven
 * methods is exactly the drift this step exists to prevent). The namespace is
 * always the plugin's own id, injected by the host; a plugin never types it.
 */
export type PluginKv = KvApi

/**
 * `ctx.storage` (plan 109 §3.1, plan 108 §3.1) — the same `kv_entries` table a
 * script already writes, reached through the same client code.
 *
 * The three accessors exist because a device scope needs a device, and only
 * ONE of the entry points has an ambient one:
 *
 * | accessor | script handler | core-side handler |
 * |---|---|---|
 * | `global` | the farm | the farm |
 * | `device` | the job's own device | **rejects `E_NO_DEVICE_SCOPE`** — there is no ambient device in an HTTP handler |
 * | `forDevice(id)` | the job's own device; **rejects `E_FOREIGN_DEVICE_SCOPE`** for any other (plan 108 §3.1 G4) | that device |
 *
 * Plan 109 §4.7's sketch spelled this as an extra `{ deviceId }` option on
 * every `set`/`get` call instead. That does not survive contact with the
 * shipped `KvApi`: `get(key, schema)` and `getRaw(key)` take no options
 * object at all, so the option would have been silently ignored on exactly
 * the calls a plugin reads its own per-device state with. `forDevice` names
 * the device once and returns the same seven methods.
 */
export interface PluginStorage {
  /** Farm-wide. Present and usable from every entry point. */
  global: PluginKv
  /**
   * The context's ambient device. A script handler always has one (its job's);
   * a core-side handler built without one rejects every call with
   * `E_NO_DEVICE_SCOPE` naming `forDevice` as the way to say which device.
   */
  device: PluginKv
  /** A named device's scope. The only device accessor that means the same thing from both ends. */
  forDevice(deviceId: string): PluginKv
}

/**
 * `ctx.farm` (plan 109 §3.1, §4.3) — the farm's own capabilities, reached
 * through the capability broker. Every call is checked twice: against the
 * permissions the plugin's manifest declared (**before** `invoke()` is
 * reached), then by the real `invoke()` against the real ACL, bound to a
 * `plugin:<name>` principal, and audited.
 *
 * **The gate is real as of step 109.3.** A capability absent from your
 * `defineService({ permissions })` list is refused with `E_FARM_UNDECLARED`
 * before the capability runs at all — the list is exhaustive, because it is
 * what the operator was shown and consented to at install. A capability that
 * IS declared can still be refused (`E_FORBIDDEN`, `E_NO_GRANT`,
 * `E_NEEDS_LEASE`, `E_DEVICE_OFFLINE`): declaring something is necessary,
 * never sufficient — the farm's own ACL decides, under a `plugin:<name>`
 * principal, and every call is audited under it.
 *
 * A host that has not wired a broker at all refuses every call with
 * `E_FARM_UNAVAILABLE` — the same fail-closed shape `ctx.kv`'s own
 * `E_KV_UNAVAILABLE` uses when a host has not wired a store. A standalone
 * script (one published outside a plugin) is refused `E_FARM_NO_PLUGIN`: it
 * has no manifest to declare anything in.
 *
 * `call`/`callRaw` mirror `KvApi`'s own `get`/`getRaw` split deliberately: a
 * caller that knows the output shape validates it against its OWN schema at
 * this boundary, because the farm's output schema can change under a plugin
 * that was published months ago. The plan spelled this `ctx.farm.<capability>(input)`;
 * capability ids are dotted (`device.list`, `job.run`) and there is no
 * `CapabilityId` union anywhere in the workspace to generate members from, so
 * a property per capability would have had to be a `Proxy` — which also
 * defeats criterion 11's assertion over the context object's own shape, and
 * turns an undeclared capability into `TypeError: not a function` instead of
 * a coded refusal.
 */
export interface FarmApi {
  /**
   * Invoke a capability and validate its output against `schema` — throws,
   * naming the capability, when the farm answered a shape this plugin does
   * not understand. Rejects with a coded error (`E_FARM_UNDECLARED`,
   * `E_FORBIDDEN`, `E_FARM_UNAVAILABLE`, or whatever `invoke()` itself
   * refused with) on every other failure.
   */
  call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T>
  /** The same call, unvalidated — for a caller that genuinely wants `unknown`. */
  callRaw(id: string, input?: unknown): Promise<unknown>
}

/**
 * The context every plugin entry point receives (plan 109 §3.1).
 *
 * **The one honest asymmetry, stated rather than smoothed over** (§3.1): a
 * script handler runs in a job child process, per job, per device; every
 * other handler runs in the core process. `storage`/`log`/`farm` are
 * identical across both because each already crosses a function or an IPC
 * boundary anyway. `device`/`params`/`job`/`artifact`/`jobs` cannot exist
 * outside a job and are on `ScriptContext` alone — that is not a gap to
 * close: a job child must stay independently killable on timeout without
 * taking anything else with it.
 *
 * `ScriptContext` extends this interface, so the compiler — not a convention
 * — is what guarantees a helper typed against `PluginContext` accepts a
 * script's context.
 */
export interface PluginContext {
  /** Plan 108 §3.1's KV, scoped. See `PluginStorage`. */
  storage: PluginStorage
  /**
   * Plan 109 §4.5's logger. In a script handler these lines join the job log;
   * in a core handler, the plugin's runtime log — one ring, one rotated file
   * at `<dataDir>/plugins/<you>/runtime.log`, and a `plugin.log` broadcast.
   *
   * **Two things about the service side are worth knowing before you write a
   * log line** (step 109.8):
   *
   * 1. **`fields.subject` is a tag, not just a field.** Pass a short string
   *    naming what inside your plugin the line is about
   *    (`ctx.log.info('accepted', { subject: 'proxy:abc', conn: 12 })`) and the
   *    farm lifts it onto the line itself, so "show me only this proxy" is a
   *    filter over the one stream rather than a second stream. Anything else in
   *    `fields` is carried through untouched.
   * 2. **Redaction is real but it is not a licence.** Every line — message and
   *    fields — is passed through the same value-based redactor the job logger
   *    uses, over the secrets in your own KV namespace plus the secrets the
   *    farm generated for your webhooks. It is a substring replace over values
   *    it can see: it cannot see a secret you never stored, one shorter than
   *    eight characters, or one you split across two lines. Do not pass a
   *    credential to a log call and rely on this.
   */
  log: ScriptLogger
  /** Plan 109 §4.3's capability broker. See `FarmApi`. */
  farm: FarmApi
}

/**
 * What a plugin's SERVICE receives, on top of the three members every entry
 * point shares (plan 109 §3.1, §3.3).
 *
 * A service is the only entry point with a lifetime of its own, so it is the
 * only one with anything to tear down. `PluginContext` deliberately stays the
 * genuinely shared part — §3.1's table listed `onStop`/`isPortFree`/
 * `exposeToDevice` in the shared block, which does not survive contact with
 * the two hosts: a script handler runs in a job child that has no service to
 * stop and cannot register a socket in the core's process, so making those
 * shared would mean the child supplying ports that mean nothing. A helper
 * typed against `PluginContext` still works from both ends, unchanged, which
 * is what criterion 2 actually asks for.
 *
 * 109.6–109.7 and 109.9–109.11 add `onRequest`, `onSocket`, `onQuery` and
 * `exposeToDevice` here. `onStop`, `isPortFree`, `reportListener` (109.4) and
 * `onEvent` (109.5) are below.
 */
export interface PluginServiceContext extends PluginContext {
  /**
   * Register a disposer. The host calls every one of them — in reverse
   * registration order, so a teardown mirrors its setup — before reload,
   * disable, remove and shutdown, and waits up to 5 s in total.
   *
   * **This is the one genuinely mechanical problem with in-process loading**
   * (plan 109 §3.3): replacing a plugin's module leaves whatever the old
   * instance bound still bound, with no handle left to close it, and the new
   * instance then fails to bind its OWN port — the plugin is broken until the
   * core restarts. The disposer is the plugin closing its own socket; the host
   * only ever says when. It never force-closes a socket it does not own.
   *
   * A disposer that throws is caught and logged, and the remaining disposers
   * still run: one broken teardown must not strand the rest.
   */
  onStop(fn: () => void | Promise<void>): void

  /**
   * Is `port` bindable on loopback right now? (plan 109 §3.3, R5 — the
   * bind test `PortAllocator` already uses, lent rather than reimplemented.)
   *
   * **This is advice, not a reservation, and the distinction is the whole
   * design.** §3.3 is the owner's ruling: *the plugin owns its listener, picks
   * its own port, and a collision is the plugin's own problem.* The core does
   * not allocate, reserve, or arbitrate. Between this answering `true` and
   * your `Bun.listen` succeeding, anything on the machine may take the port —
   * so handle the bind throwing anyway.
   *
   * It binds `127.0.0.1`, so a listener on some other interface is invisible
   * to it and it will answer `true` for a port genuinely in use there.
   */
  isPortFree(port: number, proto?: PluginListenerProto): Promise<boolean>

  /**
   * Tell the farm about a port you have opened (plan 109 §3.3).
   *
   * **Pure observability. Reporting is not control** — nothing here binds,
   * claims, or protects the port, and not reporting one does not stop it
   * working. What it buys is that a port open on the operator's machine is
   * visible in the product instead of only in `lsof`, and that the unload
   * backstop has something to bind-test.
   *
   * Reporting the same `id` twice replaces the earlier report. Every report is
   * validated (`ReportedListenerSchema`), and the one combination that is
   * refused is `{ proto: 'udp', deviceReachable: true }`: `adb reverse` has no
   * UDP form, so that flag would be a promise the mechanism cannot keep
   * (criterion 17).
   *
   * The refusal throws — it rejects the CLAIM, never the socket, which is
   * yours and stays open either way.
   */
  reportListener(listener: {
    id: string
    port: number
    proto?: PluginListenerProto
    deviceReachable?: boolean
    description?: string
  }): ReportedListener

  /**
   * Subscribe to a farm event (plan 109 §3.5, §4.7).
   *
   * **Observation only, and this is not a soft rule** (plan 109 §2, §3.5,
   * criterion 12): your handler cannot veto, delay, or rewrite the event. It
   * is invoked *after* the broadcast has already reached every subscriber, and
   * *detached* from the broadcast's own frame, so what it does — throw, hang,
   * take a minute — changes nothing about the event anyone else saw. A plugin
   * able to gate a job start would become load-bearing for core correctness,
   * and one hung handler would hang every job. If you need to gate something,
   * own the action rather than intercepting it.
   *
   * `type` must appear in your `defineService({ events })` list — the list the
   * operator was shown at install — or this throws `E_PLUGIN_EVENT_UNDECLARED`,
   * exactly as `ctx.farm` refuses an undeclared capability.
   *
   * Delivery is best-effort: no replay for events broadcast before you
   * started, no queue, no ordering guarantee across types. Reconcile from
   * `ctx.storage` in `setup` if you need to survive a core restart.
   *
   * Each delivery runs through the host's containment funnel: it has a
   * deadline, a failure is charged to your plugin, and enough failures trip
   * the error budget and stop your service — an event handler that always
   * throws is disabled like any other misbehaviour rather than spinning
   * forever.
   *
   * **There is no `device.connected`/`device.disconnected`.** A device
   * connecting or disconnecting arrives as `device.status`
   * (`payload.status === 'offline'` is disconnected, anything else is
   * connected); joining or leaving the registry arrives as `device.added` /
   * `device.removed`. Those are the names the core really broadcasts, and
   * plan 109 §9 Q1's rule is to use the real name rather than invent a
   * friendlier one that maps onto nothing.
   */
  onEvent<T extends FarmEventType>(
    type: T,
    handler: (event: Extract<ServerMessage, { type: T }>, signal: AbortSignal) => void | Promise<void>,
    opts?: { timeoutMs?: number },
  ): void

  /**
   * Serve HTTP at `/api/plugins/<you>/http/<id>` and everything under it
   * (plan 109 §3.7 row 1, §4.6, step 109.6).
   *
   * **This is the way to be reached from a browser, and the trap §3.7 names is
   * opening a raw port to serve a UI instead.** A handler here inherits the
   * core's own auth, TLS, CORS, rate limiting and audit unchanged; a
   * `Bun.listen` of your own inherits none of them.
   *
   * `permission` is an ACL permission the caller must hold — a real one, or
   * this throws `E_PLUGIN_PERMISSION_UNKNOWN` at registration rather than
   * silently gating on a typo nobody has. It defaults to `script.view`, the
   * same permission that already had to be true for an operator to open your
   * screen. **There is no way to say "no authentication"**: plan 109 §9 Q2
   * settled that as no for v1, and the legitimate unauthenticated case is a
   * webhook with its own secret.
   *
   * Every invocation goes through the host's containment funnel — a deadline,
   * a `try`/`catch`, and a failure charged to your error budget. A handler that
   * throws answers `502` with a coded body naming your plugin; one that
   * overruns answers `504`. Neither takes anything else down.
   *
   * Registering the same `id` twice replaces the first registration, and every
   * registration is dropped when your service stops — which is why a request
   * to a stopped service is refused as *not running* rather than *not found*.
   */
  onRequest(
    id: string,
    handler: PluginRequestHandler,
    opts?: { permission?: string; methods?: readonly PluginHttpMethod[]; timeoutMs?: number; description?: string },
  ): void

  /**
   * Serve a WebSocket at `/api/plugins/<you>/socket/<id>` (plan 109 §4.6).
   *
   * **This is not `ctx.onEvent`, and the two are not variations on each
   * other.** `onEvent` is a read-only tap on the farm's own broadcast: the core
   * decides what is sent, you cannot answer, and you cannot delay it. This is a
   * private, bidirectional connection between one browser and your code,
   * carrying whatever bytes you write, with no `ServerMessage` envelope and no
   * relation to the farm's `/ws` at all.
   *
   * `handler` is called once per CONNECTION, when it opens, and returns the
   * `message`/`close` callbacks for the rest of that connection's life. The
   * open, each message and the close all go through the containment funnel, so
   * a handler that throws closes that one socket and charges your budget.
   *
   * Same `permission` rules as `onRequest`, checked BEFORE the upgrade — a
   * caller who may not reach it gets a `403` on the handshake, never an open
   * socket that closes a moment later.
   */
  onSocket(id: string, handler: PluginSocketHandler, opts?: { permission?: string; timeoutMs?: number; description?: string }): void

  /**
   * Answer `GET /api/plugins/<you>/query/<id>` with rows (plan 109 §3.1, §4.6).
   *
   * This is what plan 108's `{ kind: 'handler', name }` data source calls, and
   * it exists for the table a `kv.scan` cannot produce: one that joins your
   * stored data with live farm state, which has no single place to read from.
   * The rows you return go through the SAME renderer a `kv.scan` table does —
   * `value` holds the row's own fields, and `device`/`entry` are what a
   * `$device.label` or `$entry.updatedAt` column reads.
   *
   * The permission is fixed at `plugin.data` and is not yours to choose: this
   * route is the read half of a plugin's own data surface, and
   * `GET /api/plugins/:name/data` — the route it sits beside — is gated on
   * exactly that. A query that needs a different gate is an `onRequest`
   * handler.
   *
   * **A view whose query handler is down is not an empty table.** Studio names
   * your plugin, says which of "not started yet", "still starting", "failed",
   * and "disabled by the error budget" it is, and offers Restart. An empty
   * table would tell the operator their data was gone.
   */
  onQuery(id: string, handler: PluginQueryHandler, opts?: { timeoutMs?: number; description?: string }): void

  /**
   * Answer `POST /api/plugins/<you>/webhook/<id>` — the one door into your
   * plugin that a system with **no farm account** can knock on (plan 109 §3.7
   * row 2, §4.6, step 109.7).
   *
   * `id` must appear in your `defineService({ webhooks })` list, or this throws
   * `E_PLUGIN_WEBHOOK_UNDECLARED` — the same exhaustive-declaration rule
   * `ctx.onEvent` applies to `events`, for the same reason: the list is what
   * the operator consented to at install, and an inbound door nobody was shown
   * is the one you least want to be a surprise.
   *
   * **The signature is the authorisation, and the farm has already checked it
   * before you are entered.** Every request carries
   * `x-enkaku-signature: t=<unix seconds>,v1=<hex hmac>` over
   * `` `${t}.${rawBody}` ``, HMAC-SHA256 under this webhook's own generated
   * secret, compared in constant time — the same scheme, and the same helper,
   * this farm's OUTBOUND webhooks already sign with. A missing, malformed,
   * stale, or wrong signature never reaches you. Neither does an oversized
   * body, a body that is not JSON, or one your declared `body` schema refuses.
   *
   * There is no `caller`: there is no operator behind the request, and
   * inventing one would be the lie. What you are told instead is `delivery` —
   * which secret verified, and when.
   *
   * Everything else is a normal handler: the containment funnel, the deadline,
   * the error budget. A throw answers `502`, an overrun `504`, and both are
   * charged to you.
   */
  onWebhook(id: string, handler: PluginWebhookHandler, opts?: { timeoutMs?: number; description?: string }): void

  /**
   * Your own inbound webhooks: what their addresses are, what their secrets
   * are, and how to change one (plan 109 §3.7, step 109.7, criterion 13).
   *
   * **Why a plugin may read its own webhook secret at all.** It is not a
   * sandbox (plan 109 §2, §3.2): your code runs in the core's process and can
   * open the farm database — and the key file beside it — directly, so a farm
   * that refused you the plaintext would be performing a boundary it does not
   * have. What this method buys over that is that the read goes through a
   * named door and is **audited**, so "plugin `x` revealed webhook `y`'s
   * secret" is a row rather than an inference.
   *
   * It exists because the secret has to reach a human: someone has to paste it
   * into GitHub, or Stripe, or the box in the corner. Your own screen — a
   * `ctx.onRequest` handler behind the core's auth — is the natural place to
   * show it.
   */
  webhooks: PluginWebhookApi

  /**
   * Your own service log, as the farm retained it (plan 109 §4.5, step 109.8).
   *
   * This is the read half of the lines `ctx.log.*` writes: a bounded ring, in
   * the core, already redacted, with an honest `truncated` flag. It exists so a
   * plugin's own screen can show its own log through an ordinary `ctx.onRequest`
   * handler — behind the core's auth, TLS and audit — instead of the farm having
   * to be the only place a plugin's log can be read from.
   *
   * **`subject` is why this is one stream and not several.** Tag your lines
   * (`ctx.log.info(msg, { subject: 'proxy:abc' })`) and filter on the same value
   * here; the farm keeps ONE ring per plugin and applies a predicate. Do not
   * build a ring per thing you manage: core memory that scales with a list an
   * operator edits is not yours to spend, and a deleted subject would take its
   * own history with it at exactly the moment somebody wanted it.
   */
  logs: PluginLogApi
}

/**
 * `ctx.logs` (plan 109 step 109.8). One method, because a log is a page and a
 * page is a cursor plus a filter.
 *
 * On a host with no log store wired every call rejects
 * `E_PLUGIN_LOGS_UNAVAILABLE` — fail-closed, never an empty page, which would
 * read as "your service has logged nothing".
 */
export interface PluginLogApi {
  page(opts?: {
    /** The last `seq` you already have; omit for the oldest retained line. */
    cursor?: number | null
    /** Only lines tagged with exactly this `fields.subject`; omit for every line, tagged or not. */
    subject?: string | null
    limit?: number
  }): Promise<PluginLogPage>
}

/**
 * `ctx.webhooks` (plan 109 step 109.7).
 *
 * Present on every service context. On a host with no webhook store wired,
 * every method rejects `E_PLUGIN_WEBHOOK_UNAVAILABLE` — fail-closed, the same
 * shape `ctx.farm`'s `E_FARM_UNAVAILABLE` uses, never a silent empty list that
 * reads as "you have no webhooks".
 */
export interface PluginWebhookApi {
  /** Every webhook you declared, with its address and its delivery counters. Never a secret and never a hint of one. */
  list(): Promise<PluginWebhookInfo[]>
  /**
   * The plaintext secret a sender must sign with. Audited (`plugin.webhook`,
   * verb `reveal`). Generates one on first call, so a webhook is never in a
   * half-configured state where its URL exists and its secret does not.
   */
  secret(id: string): Promise<string>
  /**
   * Mint a new secret. **The old one keeps verifying for `graceSec` (24 hours
   * by default), and that is the deliberate part** — the sender is a third
   * party you cannot restart, so an instant cutover makes every rotation a
   * guaranteed outage of unknown length, and the habit that produces is "never
   * rotate". Pass `graceSec: 0` when the old secret is *compromised*: that is
   * the case where an overlap is exactly wrong, and it revokes immediately.
   *
   * At most one previous secret is ever live: rotating twice inside the window
   * drops the older one at once, so this can never grow into a set of keys
   * nobody can account for.
   *
   * Returns the new plaintext **once**. Nothing reads it back afterwards
   * except `secret()`.
   */
  rotate(id: string, opts?: { graceSec?: number }): Promise<{ secret: string; previousValidUntil: number | null }>
}

/**
 * One inbound webhook delivery, as a handler sees it (plan 109 §3.7, step
 * 109.7).
 *
 * **There is no `caller`, and its absence is the honest part.** Every other
 * handler kind is reached by a farm user and is told `{ id, role }`. This one
 * is reached by whoever holds the secret, and the farm knows nothing else
 * about them — not a user, not a role, not an IP it would be willing to
 * believe (`x-forwarded-*` is forgeable and is dropped with every other header
 * outside `PLUGIN_REQUEST_HEADER_ALLOWLIST`). Manufacturing a `caller` here
 * would put a name on the one request that genuinely has none.
 */
export interface PluginWebhookRequest {
  /** The webhook this arrived on — the same id you registered. */
  webhookId: string
  /** The query string, flattened. A repeated key keeps its LAST value. */
  query: Record<string, string>
  /** Only `PLUGIN_REQUEST_HEADER_ALLOWLIST`, lower-cased. The signature header is not among them: the farm already spent it. */
  headers: Record<string, string>
  /** The parsed JSON body, already validated against your declared `body` schema when you declared one. */
  body: unknown
  /** The exact bytes that were signed, as text — for a sender whose own scheme needs the raw form (a nested signature, a canonical hash). */
  rawBody: string
  delivery: {
    /** Random per delivery. Yours to record if you need idempotency; the farm does not deduplicate for you. */
    id: string
    /** The signed timestamp, unix seconds — the sender's clock, already checked against this webhook's freshness window. */
    at: number
    /**
     * Which of your secrets verified this. `'previous'` means the sender is
     * still using the secret you rotated away from and is only working because
     * the overlap window has not closed — worth surfacing rather than
     * discovering when it stops.
     */
    secret: 'current' | 'previous'
  }
}

export type PluginWebhookHandler = (request: PluginWebhookRequest, signal: AbortSignal) => PluginResponse | void | Promise<PluginResponse | void>

/**
 * One HTTP request, as a plugin handler sees it (plan 109 §3.7 row 1, §4.6,
 * step 109.6).
 *
 * **What is deliberately NOT here, and why.** No `Request`, no raw headers, no
 * cookies, no `Authorization`. Not because a plugin could not otherwise reach
 * the farm — it runs inside the core's process and can reach far past any
 * header — but because a bearer credential is the one thing that can LEAVE the
 * process: written to `ctx.storage`, printed by `ctx.log`, posted to a webhook,
 * replayed later as that operator from another machine. Identity is data;
 * a session cookie is authority you can carry away, and the two are handed out
 * on different terms. `caller` gives you the first, `PLUGIN_REQUEST_HEADER_ALLOWLIST`
 * is what is left of the second.
 *
 * **`caller` is not a principal either.** Anything this handler does through
 * `ctx.farm` is still checked against YOUR manifest and audited as
 * `plugin:<name>` under your publisher's role — being invoked by an admin does
 * not widen a plugin, and being invoked at all is recorded as its own
 * `plugin.http` audit row naming the human. Do not treat `caller.role` as
 * permission to do something the farm would otherwise refuse you; treat it as
 * "who is looking at this screen".
 */
export interface PluginRequest {
  method: PluginHttpMethod
  /**
   * Whatever followed your handler's id in the path, always starting with `/`
   * (`'/'` when the request named your handler and nothing more). A handler
   * registered as `reports` answers `/api/plugins/<you>/http/reports` with
   * `path: '/'` and `/api/plugins/<you>/http/reports/2026/q1` with
   * `path: '/2026/q1'`.
   */
  path: string
  /** The query string, flattened. A repeated key keeps its LAST value, the same rule Hono's own `c.req.query()` applies. */
  query: Record<string, string>
  /** Only `PLUGIN_REQUEST_HEADER_ALLOWLIST`, lower-cased. Everything else was dropped before you were entered. */
  headers: Record<string, string>
  /** The parsed JSON body, or `null` — for a body that is absent, empty, or not JSON. A plugin route is a JSON route. */
  body: unknown
  caller: PluginCaller
}

/**
 * What an HTTP handler answers with. Returning nothing at all is `204`.
 *
 * `headers` is filtered to `PLUGIN_RESPONSE_HEADER_ALLOWLIST`. `set-cookie` is
 * absent from it deliberately: a plugin able to set a cookie on the farm's own
 * origin could overwrite the session cookie the core authenticates with.
 */
export interface PluginResponse {
  /** 200 by default. Clamped to 200–599; a handler that wants to refuse says so with a status, not by throwing. */
  status?: number
  /** Serialised as JSON. */
  body?: unknown
  headers?: Record<string, string>
}

export type PluginRequestHandler = (request: PluginRequest, signal: AbortSignal) => PluginResponse | void | Promise<PluginResponse | void>

/** One live WebSocket connection to a `ctx.onSocket` handler. */
export interface PluginSocket {
  /** Unique per CONNECTION, not per handler — a handler with four browsers open sees four of these. */
  readonly connectionId: string
  readonly caller: PluginCaller
  readonly query: Record<string, string>
  /** `false` once the peer has gone or you have closed it. Sending on a closed socket is a no-op, never a throw. */
  readonly open: boolean
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

/** What a socket handler returns: the two callbacks for the rest of that connection's life. Both optional — a push-only socket needs neither. */
export interface PluginSocketHandlers {
  message?(data: string | Uint8Array): void | Promise<void>
  close?(code: number, reason: string): void | Promise<void>
}

export type PluginSocketHandler = (socket: PluginSocket, signal: AbortSignal) => PluginSocketHandlers | void | Promise<PluginSocketHandlers | void>

/** What a `ctx.onQuery` handler is asked. There is no `input` beyond the URL's own query string: a declarative view has nowhere to get one from. */
export interface PluginQueryRequest {
  query: Record<string, string>
  /** The page the caller is asking for — whatever your last `nextCursor` was, or `null` for the first page. */
  cursor: string | null
  caller: PluginCaller
}

export type PluginQueryHandler = (request: PluginQueryRequest, signal: AbortSignal) => PluginQueryResult | Promise<PluginQueryResult>

/** Every farm event type a plugin can subscribe to — the core's own server→client message vocabulary, unchanged (plan 109 §3.5, R2). */
export type FarmEventType = ServerMessage['type']
/** The event a `ctx.onEvent` handler receives: the farm's own message, verbatim. */
export type FarmEvent = ServerMessage

/**
 * Narrow a farm event to one type.
 *
 * Exported because the host needs it and a plugin author will too: it is what
 * lets `ctx.onEvent('device.status', (e) => e.payload.status)` typecheck
 * without an `as`-cast anywhere. A generic `Extract<ServerMessage, { type: T }>`
 * cannot be proven by a plain `event.type === type` comparison — TypeScript
 * will not narrow a discriminated union against a value of generic literal
 * type — and the honest way to close that gap is a user-defined type guard
 * whose body is exactly that one comparison, rather than an assertion that
 * hides it.
 */
export function isFarmEventOfType<T extends FarmEventType>(event: ServerMessage, type: T): event is Extract<ServerMessage, { type: T }> {
  return event.type === type
}

/**
 * A plugin's long-lived entry point (plan 109 §3.1, §4.1). Called once when
 * the plugin is activated, and again after every reload; whatever it
 * registered is torn down before the next call.
 *
 * **Read this before writing one. It is not a sandbox** (plan 109 §2, §3.2;
 * spec §11.3 keeps the same discipline for job isolation). Your code is
 * loaded into the core process. A thrown or rejected handler, and a handler
 * that overruns its deadline, are caught, charged to your plugin, and
 * reported. These are **not** caught, by any amount of `try`/`catch`, and
 * each one takes the whole farm down with it:
 *
 * - a synchronous infinite loop (`while (true) {}`) — the event loop stops;
 * - running out of memory;
 * - `process.exit()` anywhere in your code;
 * - a native crash inside an npm dependency you imported.
 *
 * That is the price of in-process execution, and it was chosen deliberately:
 * a plugin is written by the farm operator, there is no marketplace and no
 * third-party distribution. `isolation: 'process'` is reserved for the day
 * that stops being true.
 */
export type ServiceSetup = (ctx: PluginServiceContext) => void | Promise<void>

/**
 * **Reset data** — what your plugin does about the outside world, one moment
 * before the farm deletes everything your plugin stored.
 *
 * An ordinary lifecycle handler beside `setup`, receiving the same
 * `PluginServiceContext`, so `ctx.storage`, `ctx.log` and `ctx.farm` are the
 * same three things they are everywhere else and a helper you already wrote
 * works here unchanged.
 *
 * ## Four rules, and none of them is optional
 *
 * 1. **You run BEFORE the delete.** Your data is still there — that is the
 *    whole point, because your data is the only record of what you did. Read
 *    it, undo what it describes, and report.
 * 2. **The handler itself is optional.** A plugin without one still resets; it
 *    just has nothing to undo, and the farm says so rather than pretending a
 *    cleanup ran.
 * 3. **Be idempotent and re-runnable.** A reset that half-completes leaves your
 *    data in place (see below), and an operator will press the button again.
 *    Pressing it twice must be safe, and the second press must be able to
 *    finish what the first one started.
 * 4. **Report per thing, honestly.** Return `{ items: [...] }` — one entry per
 *    device or resource you touched. `failed` means the undo did not happen and
 *    nobody is holding the obligation; `pending` means it did not happen *and*
 *    the farm has recorded the debt somewhere that outlives your data. Do not
 *    report `pending` on a hope.
 *
 * ## What your report decides
 *
 * | your items | the farm | your data |
 * |---|---|---|
 * | all `cleared`/`unchanged` | *"Reset."* | deleted |
 * | any `pending`, none `failed` | *"Reset — with N debts, named."* | deleted (the record moved, it did not vanish) |
 * | **any `failed`** | *"Blocked. Nothing was deleted."* | **kept, in full** |
 *
 * Throwing has the same effect as a `failed` item: nothing is deleted, and the
 * error is shown verbatim. So a handler that cannot reach one phone should
 * report that one phone, not throw — throwing discards the twelve it did clean
 * up from the operator's view of what happened.
 *
 * ## The extra authority, and its edges
 *
 * `defineService({ resetData: { permissions: [...] } })` lists capabilities the
 * handler may call **that the running service may not**. They are live only
 * while an operator-initiated pass is open, and only through the context object
 * this handler is called with — stash that `ctx` and use it a minute later and
 * the extra capabilities are refused again, exactly as if they had never been
 * declared. Everything else about a farm call is unchanged: the real ACL, the
 * lease admission and the audit row all still apply.
 */
export type ServiceResetData = (ctx: PluginServiceContext) => PluginResetReport | void | Promise<PluginResetReport | void>

/**
 * What an author passes to `defineService`.
 *
 * The declaration half is the schema's **input** type, not its output.
 * `Partial<PluginServiceDeclaration>` — what step 109.2 wrote, when every
 * default in the schema was a top-level key — only makes the TOP level
 * optional, so the moment a defaulted field lives inside a nested object
 * (`listeners[].proto`, `listeners[].deviceReachable`, step 109.4) an author
 * is forced to spell out values the schema exists to supply. `z.input` is what
 * "before the defaults are applied" is actually called.
 */
export type PluginServiceInput = Partial<z.input<typeof PluginServiceDeclarationSchema>> & {
  setup: ServiceSetup
  /**
   * The **Reset data** cleanup hook — see `ServiceResetData`. Optional; a plugin
   * without one still resets.
   *
   * It is a sibling of `setup` rather than a member of the `resetData`
   * declaration block for the same reason `setup` is not inside the
   * declaration: what crosses to the farm is JSON, and a function nested in a
   * declared object is a `JSON.stringify` that silently drops it. Declaring
   * `resetData` without one is refused below — a borrowed capability with no
   * handler to use it is a grant an operator consented to for nothing.
   */
  onResetData?: ServiceResetData
}

/**
 * What `defineService` returns, and what `PluginDefinition.service` holds —
 * the declaration and the code in ONE object.
 *
 * Plan 109 §4.1 split them: a manifest block naming `entry: 'runtime'`, and a
 * separate module the host would load. Nothing in the shipped pipeline can do
 * that — verification imports exactly one bundle per plugin
 * (`verify-child.ts`), and a second entry would mean a second bundle, a second
 * verify, and two live module instances of the same plugin with two copies of
 * its module state. Keeping them together also removes a whole failure class:
 * a manifest cannot declare permissions the entry does not have, because there
 * is only one place to write them.
 */
export interface PluginService extends PluginServiceDeclaration {
  /** A brand, so a host can recognise one without importing this package at run time. */
  readonly kind: 'enkaku.service'
  setup: ServiceSetup
  /**
   * The Reset data hook, when this plugin has one. Present exactly when the
   * `resetData` declaration above is non-null — `defineService` keeps the two
   * in step, so the manifest's `resetData` is a reliable answer to "does this
   * plugin have anything to undo" without importing the bundle.
   */
  onResetData?: ServiceResetData
}

/**
 * Declares a plugin's service. Validates on the AUTHOR's machine, at import
 * time — the same discipline `definePlugin` and `foldRuntimeEnvelope` already
 * apply — so a mistake here is a stack trace in the editor rather than a
 * `failed` plugin on the farm.
 *
 * ```ts
 * export default definePlugin({
 *   id: 'bridge',
 *   version: '1.0.0',
 *   scripts: [ … ],                       // each may carry plan 98's own `runtime` envelope
 *   service: defineService({
 *     permissions: ['device.list'],
 *     setup: async (ctx) => {
 *       const server = Bun.listen({ hostname: '127.0.0.1', port: 1080, socket: { … } })
 *       ctx.onStop(() => server.stop(true))
 *     },
 *   }),
 * })
 * ```
 *
 * `isolation` is validated but NOT refused here: the manifest vocabulary
 * accepts `'process'` so that reserving it costs nothing later, and the FARM
 * is what refuses it, at verify, naming it as unimplemented (criterion 7). An
 * author who could not even write the value would have no way to discover
 * that the mode is planned.
 */
export function defineService(input: PluginServiceInput): PluginService {
  if (!input || typeof input !== 'object') {
    throw new Error('defineService(input): expected an object with a `setup` function')
  }
  if (typeof input.setup !== 'function') {
    throw new Error('defineService({ setup }): `setup` must be a function that receives the plugin service context')
  }
  if (input.onResetData !== undefined && typeof input.onResetData !== 'function') {
    throw new Error('defineService({ onResetData }): `onResetData`, when present, must be a function that receives the plugin service context')
  }
  const { setup, onResetData, ...declared } = input
  /**
   * The two halves of Reset data are kept in step HERE, on the author's own
   * machine, so neither can exist without the other on a farm.
   *
   * - A handler with no `resetData` block gets an empty one: the declaration
   *   is what tells the farm a cleanup hook exists at all, and a plugin that
   *   wrote `onResetData` and nothing else must not have its handler silently
   *   skipped because the manifest said `resetData: null`.
   * - A `resetData` block with no handler is refused rather than normalised
   *   away. Its `permissions` are authority an operator is shown and consents
   *   to at install; consenting to a grant nothing can use is consent spent
   *   for nothing, and the likeliest cause is a handler the author forgot to
   *   wire.
   */
  if (declared.resetData !== undefined && declared.resetData !== null && onResetData === undefined) {
    throw new Error(
      'defineService({ resetData }): a `resetData` block was declared but there is no `onResetData` handler to use it — ' +
        'the block exists to describe (and to borrow authority for) a cleanup hook, so declaring one without the hook ' +
        'asks the operator to consent to a grant nothing can spend. Add `onResetData`, or remove `resetData`.',
    )
  }
  const parsed = PluginServiceDeclarationSchema.safeParse(
    onResetData !== undefined && (declared.resetData === undefined || declared.resetData === null) ? { ...declared, resetData: {} } : declared,
  )
  if (!parsed.success) {
    throw new Error(`defineService: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  }
  return Object.freeze({ kind: 'enkaku.service' as const, ...parsed.data, setup, ...(onResetData !== undefined ? { onResetData } : {}) })
}

/** Whether a value is a `defineService()` result. */
export function isService(value: unknown): value is PluginService {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'enkaku.service' &&
    typeof (value as { setup?: unknown }).setup === 'function'
  )
}

export type { PluginServiceDeclaration }
