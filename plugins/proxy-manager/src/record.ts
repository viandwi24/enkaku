import { z } from 'zod'
import {
  DEFAULT_BIND_HOST,
  DEFAULT_DRAIN_MS,
  DEFAULT_MAX_CONNECTIONS,
  LISTEN_PROTOS,
  PROXY_KEY_PREFIX,
  PROXY_KINDS,
  PROXY_SECRET_KEY_PREFIX,
} from './shared'

/**
 * What one proxy IS, as this plugin stores it — the single authoritative
 * declaration of the record shape, in Zod, with its bounds.
 *
 * ## What changed when the screen became React (plan 111 step 111.7)
 *
 * On tier A this file did three jobs: `z.toJSONSchema(AddFormSchema)` drew the
 * Add and Edit dialogs, its keys were the table's columns, and a test parsed a
 * sample against it. The Add/Edit JSON Schemas are **gone** — the screen draws
 * its own dialog now, and keeping a declared form beside a hand-written one
 * would be exactly the weaker parallel path 00-overview §4.3 forbids.
 *
 * The drift risk they were guarding against did NOT go away, so the guard
 * moved rather than being dropped. A screen that writes `{ hostname }` into a
 * reader that looks for `{ host }` shows blank cells forever: the write
 * succeeds, the schema is valid, and nothing reports a fault. The React half
 * therefore funnels every write through one function (`writeProxy` in
 * `src/ui/parts/api.ts`) and every read through its mirror (`readProxy`), and
 * `index.test.ts` runs a value through both and parses the result **against
 * this object**. Two halves compiled by two different bundlers are held to one
 * shape by a test that actually executes both.
 *
 * ## What changed in plan 112 step 112.3
 *
 * Three things, and the third is the one to know about.
 *
 * 1. **The record grew a listen side, an upstream side, and an intent flag.**
 *    `kind` became `upstream.proto` and keeps `PROXY_KINDS` unchanged as its
 *    vocabulary, which is what lets every shipped row migrate without
 *    interpretation (§4.3).
 * 2. **`ui()` metadata is gone.** Nothing renders it: a tier-C screen draws its
 *    own dialog, so a declared title/label set beside a hand-written form is a
 *    second, weaker description of the same field. `.describe()` stays, because
 *    it documents the field for a person reading this file.
 * 3. **This module IS now bundled into the pack the core runs.** It used to be
 *    a declaration and a test anchor only. The service parses what it reads out
 *    of KV through `ProxyRecordSchema` before it opens a socket on the strength
 *    of it, so the schema has to be in the bundle. The *logic* — the migration
 *    and the coded refusals — deliberately is not here: it lives in
 *    `shared.ts`, which imports nothing, so the browser half runs the same code
 *    the service does instead of a second copy of it. This file re-exports both
 *    so an existing reader of `./record` is unaffected.
 *
 * ## What changed in plan 117 step 117.1
 *
 * `upstream` grew `bindAddress` and `resolveThroughEgress`, and the record
 * itself grew `capacity`, `exclusive` and `listenerAuth` — five fields, all
 * additive, all defaulted so a row written before this plan still parses to
 * exactly what it parsed to before (`readProxyRecord` in `shared.ts` is where
 * the defaulting actually happens; the schema here only bounds the shape).
 * `PROXY_KINDS` grew a fourth value, `direct`, which is why `upstream.host`,
 * `.port` and `.username` are now each documented as "ignored when proto is
 * direct" rather than unconditionally required.
 *
 * ## What changed in plan 117 steps 117.7–117.8
 *
 * `bindHost`'s field comment and `listenerAuth`'s no longer say "nothing
 * checks this yet" — `validateProxyRecord`'s loopback rule is now conditional
 * on a saved listener credential rather than unconditional (§3.5), and
 * `vpnRouteForRecord` (`shared.ts`) grew a `direct` branch that points VPN
 * mode's route at this record's own `listen.bindHost`/`.port` instead of an
 * upstream it does not have (§3.6). Nothing here in `record.ts` changed shape
 * — both steps are logic in `shared.ts`, which this file only re-exports.
 *
 * ## What changed in plan 121 step 121.1
 *
 * The record grew `fallbackUpstreams` (an ordered array of the same
 * `ProxyUpstreamSchema` shape the primary `upstream` already uses) and
 * `failover` (`failureThreshold`/`autoFailback`) — additive, defaulted the
 * same way plan 117's five fields were: a row written before this plan has
 * neither key, and `readProxyRecord` in `shared.ts` fills both in on read.
 * `ProxyUpstream` itself is still a plain interface, not a discriminated
 * union — `fallbackUpstreams` is simply an array of it, the same shape
 * `upstream` already is, just more than one.
 *
 * ## What changed in plan 121 step 121.4
 *
 * No schema shape changed here — `ProxyUpstream` still carries no password
 * field of its own. What widened is the SECRET key scheme in `shared.ts`:
 * `proxySecretKeyFor(id)` (one password per record) stays as the read-time
 * fallback for slot 0, and `proxySecretSlotKeyFor(id, slot)` is the new,
 * per-upstream-slot key a fallback's own credential is stored and read
 * under. See that function's own comment for the addressing and the
 * backward-compatibility rule.
 */

export { PROXY_KEY_PREFIX, PROXY_KINDS, PROXY_SECRET_KEY_PREFIX, PROXY_AUTH_KEY_PREFIX, PROXY_KEY_HINT, LISTEN_PROTOS } from './shared'
export type { ProxyKind, ListenProto, ProxyRecord as ProxyRecordShape, ProxySecret, ProxyProblem, ProxyProblemCode } from './shared'
export {
  readProxyRecord,
  writeProxyRecord,
  validateProxyRecord,
  isStartableRecord,
  isStorableRecord,
  proxyIdFromKey,
  proxyKeyFor,
  proxySecretKeyFor,
  proxySecretSlotKeyFor,
  proxyAuthKeyFor,
  PROXY_PROBLEM_CODES,
} from './shared'

export const ProxyListenSchema = z.object({
  /** `https` is accepted by the enum and refused by `validateProxyRecord` — see plan 112 §3.4. */
  proto: z.enum(LISTEN_PROTOS).default('http').describe('What this bridge speaks to whatever dials it. HTTPS is accepted here and refused at validation: terminating TLS needs a certificate the farm cannot issue for a plugin.'),
  /**
   * Loopback only, unless the record has a listener credential saved (plan
   * 117 §3.5). Otherwise → `E_PROXY_LISTENER_AUTH_REQUIRED`; `listenerAuth`
   * on with no saved credential → `E_PROXY_LISTENER_AUTH_MISSING`.
   */
  bindHost: z.string().max(64).default(DEFAULT_BIND_HOST).describe('The address the listener binds. Loopback unless a listener credential is saved for this record: an unauthenticated proxy reachable off-host is an open relay billed to your upstream account.'),
  /**
   * **Nullable, and that is a state rather than a gap** (§4.3 property 3). A
   * record migrated from the shipped shape named an upstream port and no local
   * one. There is no correct guess, so the row says "needs a local port" and
   * cannot start — a precondition, not an error.
   */
  port: z.number().int().min(1).max(65_535).nullable().default(null).describe('The local TCP port this bridge listens on. Null on a record migrated from the older shape, which named no local port.'),
})

export const ProxyUpstreamSchema = z.object({
  /** Reuses `PROXY_KINDS` unchanged, so every shipped row migrates without interpretation. `direct` (plan 117 §3.1) names no remote proxy at all. */
  proto: z.enum(PROXY_KINDS).default('socks5').describe('The transport the upstream proxy speaks. HTTPS is accepted here and refused at validation. "direct" dials the destination itself and ignores host, port and username.'),
  host: z.string().max(200).default('').describe('Hostname or IP address of the upstream proxy, without a scheme and without a port. Ignored when proto is "direct".'),
  port: z.number().int().min(0).max(65_535).default(0).describe('The upstream proxy’s TCP port. Zero means it was never filled in. Ignored when proto is "direct".'),
  /** In the clear, deliberately, and questioned in plan 112 §9 Q1. The password is the other key. */
  username: z
    .string()
    .max(200)
    .default('')
    .describe('The account this bridge authenticates to the upstream as. Stored in the clear so the catalogue can say which account a proxy uses; the password is stored separately and encrypted. Ignored when proto is "direct".'),
  /**
   * Plan 117 §3.1 — `net.connect`'s own `localAddress`, meaningful only for
   * `proto: 'direct'`. Empty means "dial out however this host normally
   * would", which is what makes `direct` useful with no proxy account at all.
   */
  bindAddress: z.string().max(64).default('').describe('The local address to bind outgoing connections to, for a "direct" upstream. Empty means the host’s normal default route. Ignored for every other proto.'),
  /**
   * Plan 117 §3.4 — default on. Meaningless with an empty `bindAddress`, and
   * meaningless for every proto other than `direct`.
   */
  resolveThroughEgress: z
    .boolean()
    .default(true)
    .describe('For a "direct" upstream with a bindAddress: whether DNS lookups are resolved through that same address rather than the host’s default resolver. A resolver failure never falls back to the default resolver.'),
})

/**
 * The failover behaviour a record declares for itself (plan 121 §4.1). No
 * separate "enabled" flag — see `ProxyRecordSchema.fallbackUpstreams`'s own
 * comment.
 */
export const ProxyFailoverSchema = z.object({
  failureThreshold: z
    .number()
    .int()
    .min(1)
    .default(3)
    .describe('Consecutive dial failures against the currently active upstream before a confirmation probe runs. No upper bound — a large, varied fleet has no one right ceiling.'),
  autoFailback: z
    .boolean()
    .default(true)
    .describe('Whether a healthy primary, confirmed by a background re-probe, is switched back to automatically. When off, the background probe still runs and only the manual reset action switches back.'),
})

export const ProxyRecordSchema = z.object({
  label: z.string().max(80).default('').describe('What you call this proxy. Shown in the table and used to name the row in a confirmation.'),
  // Spelled out rather than `.default({})`: Zod 4's `.default()` takes the
  // schema's OUTPUT, so an empty object is a type error here even though every
  // field inside has a default of its own (the same trap plan 109 §9 Q18
  // records for `z.input` vs the inferred type).
  listen: ProxyListenSchema.default({ proto: 'http', bindHost: DEFAULT_BIND_HOST, port: null }),
  upstream: ProxyUpstreamSchema.default({ proto: 'socks5', host: '', port: 0, username: '', bindAddress: '', resolveThroughEgress: true }),
  /** Plan 121 §4.1. Any existing `ProxyUpstream` shape — another local egress via `direct`, or a third-party rotating proxy via `http`/`socks5`. Empty leaves failover provably inert; there is no separate on/off switch. */
  fallbackUpstreams: z.array(ProxyUpstreamSchema).default([]).describe('Backup upstreams this record fails over to, in order, when the primary proves unreachable and a confirmation probe through it also fails.'),
  /** Plan 121 §4.1. Always present, even with `fallbackUpstreams` empty. */
  failover: ProxyFailoverSchema.default({ failureThreshold: 3, autoFailback: true }),
  /**
   * INTENT, not observation (§3.5). The supervisor starts every enabled record
   * when the plugin loads. Nothing about a RUNNING proxy — its state, uptime,
   * connection count or last error — is ever written to storage: a persisted
   * `running` that survived a crash is a lie the moment it is read.
   */
  enabled: z.boolean().default(false).describe('Whether this proxy SHOULD be listening. The farm starts every enabled record when the plugin loads. It is what the operator asked for, never what is observed.'),
  logDestinations: z.boolean().default(false).describe('Whether a log line may name the host a connection was for. Off by default: a proxy that logs every destination becomes a browsing record of every device that used it.'),
  maxConnections: z.number().int().min(1).max(10_000).default(DEFAULT_MAX_CONNECTIONS).describe('How many tunnels this one proxy may carry at once. A bridge shares the farm’s event loop, so an unbounded one can starve the rest of it.'),
  drainMs: z.number().int().min(0).max(120_000).default(DEFAULT_DRAIN_MS).describe('How long a stop lets live tunnels finish before destroying them. The port is released immediately either way.'),
  /** Plan 117 §3.8. `0` = unlimited. Enforced in `apply.ts` (step 117.10) rather than by this schema, which only bounds the number. */
  capacity: z.number().int().min(0).max(1000).default(0).describe('How many devices may hold this record at once, counted through the device-scoped "assigned" key. Zero means unlimited.'),
  /** Plan 117 §3.8, `capacity`’s stricter sibling — refused outright rather than counted. Enforced in `apply.ts`, as `capacity` is. */
  exclusive: z.boolean().default(false).describe('Whether this record refuses a second concurrent assignment outright, rather than counting against capacity.'),
  /**
   * Plan 117 §3.5 — intent that a `proxy-auth:<id>` credential row exists.
   * On with no such row → `E_PROXY_LISTENER_AUTH_MISSING`; off is also what
   * keeps a non-loopback `bindHost` refused (`E_PROXY_LISTENER_AUTH_REQUIRED`,
   * step 117.7).
   */
  listenerAuth: z.boolean().default(false).describe('Whether this bridge should require a listener credential. The credential itself is a separate, secret KV row — this only records the intent.'),
  notes: z.string().max(300).default('').describe('Anything a person needs to know about this entry — who it belongs to, when it expires.'),
})

export type ProxyRecord = z.infer<typeof ProxyRecordSchema>

/**
 * The other key: `proxy-secret:<id>`, written with `secret: true`, read only
 * in-process by the service (plan 112 §3.6, §3.10).
 *
 * **An object with one field, and it must stay an object.** The store hints a
 * secret row from the JSON when the value is not a string, so `{"password":…}`
 * leaks the JSON's own punctuation and two or three characters of the
 * password; a bare string would leak its first seven and last four. That is a
 * mitigation of the gap step 112.2 closes, not a substitute for it — see
 * `secretHintLeak` in `shared.ts` and the test that fails when 112.2 lands.
 */
export const ProxySecretSchema = z.object({
  password: z.string().max(400).describe('The upstream proxy’s password. Never logged, never returned to a browser, never interpolated into an error message.'),
})

export type ProxySecretRecord = z.infer<typeof ProxySecretSchema>

/**
 * `proxy-secret:` must never be picked up by a list of `proxy:` — a property
 * of the two strings rather than of a filter someone has to remember to write.
 * Asserted in `index.test.ts`; stated here so a future rename of either
 * constant has to walk past it.
 */
export const SECRET_PREFIX_IS_DISJOINT = !PROXY_SECRET_KEY_PREFIX.startsWith(PROXY_KEY_PREFIX)
