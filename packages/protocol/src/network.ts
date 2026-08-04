import { z } from 'zod'

/**
 * The device-facing network layer (spec §7.9), reduced from Plan 33 §4.1 to
 * exactly what a SOCKS5 route needs for plan 44's end-to-end slice.
 *
 * `adb-proxy` and `adb-reverse-proxy` — the other two rungs on Plan 33's
 * ladder — are deliberately NOT modelled here. They are deferred by plan 44
 * §2 to Plan 33 §5.5 and live nowhere in this file.
 */
export const NetworkEngineIdSchema = z.enum(['none', 'vpn-helper'])
export type NetworkEngineId = z.infer<typeof NetworkEngineIdSchema>

/**
 * What an engine can actually do, advertised by its descriptor rather than
 * assumed by a caller (spec §9.5 pattern, Plan 33 §3.2). `probe` stays
 * `false` for `vpn-helper` until an egress check exists (plan 44 §4.3) —
 * claiming a capability the engine does not have is the exact failure mode
 * this schema exists to prevent.
 */
export const NetworkCapabilitiesSchema = z.object({
  auth: z.boolean().describe('Upstream credentials (username/password) are supported').meta({ title: 'Authentication' }),
  enforcing: z.boolean().describe('Apps cannot opt out of the route (VpnService/iptables), unlike an advisory system setting').meta({ title: 'Enforcing' }),
  udp: z.boolean().describe('UDP and DNS traffic are carried through the route, not just TCP').meta({ title: 'UDP' }),
  probe: z.boolean().describe('An egress check is available to confirm the route is actually live').meta({ title: 'Egress probe' }),
})
export type NetworkCapabilities = z.infer<typeof NetworkCapabilitiesSchema>

/**
 * A SOCKS5 upstream a `vpn-helper` route can be pointed at (plan 44 §4.2) —
 * the exact shape carried in a `route.start` request's `config` field on the
 * guest-agent wire (see `guest-agent.ts`), which is why `username`/`password`
 * stay on this schema even after plan 52's credential store: the DEVICE has
 * no notion of a named credential, only ever a literal username/password to
 * authenticate the SOCKS5 handshake with.
 *
 * What changed in plan 52 §4.2, §5.1 is what ever POPULATES those two
 * fields: `packages/core/src/api/guest-agent.ts`'s `PUT /network` handler
 * resolves a request's `credentialRef` (or, for one inline request, mints a
 * new named credential from `username`/`password` on the spot) into a
 * `network_credentials` row, and only a `credentialRef` — never a raw
 * secret — is ever written to `devices.network_route`. `username`/`password`
 * inline on THIS schema are populated exactly once, in memory, right before
 * `NetworkRoute.apply()`/`route.start` — the "resolved" wire object — and
 * are never persisted or returned from an API response carrying that value.
 */
export const Socks5RouteConfigSchema = z.object({
  host: z.string().min(1).describe('SOCKS5 upstream host').meta({ title: 'Host' }),
  port: z.number().int().min(1).max(65535).describe('SOCKS5 upstream port').meta({ title: 'Port' }),
  username: z.string().optional().describe('Upstream username, if the proxy requires authentication').meta({ title: 'Username' }),
  password: z.string().optional().describe('Upstream password, if the proxy requires authentication').meta({ title: 'Password' }),
  /**
   * Names a row in `network_credentials` (plan 52 §4.2) to resolve
   * `username`/`password` from. Set on a `PUT /network` REQUEST to reuse an
   * existing credential across devices (acceptance criterion 5); absent on
   * the RESOLVED object handed to `route.apply()`, which carries the
   * literal `username`/`password` instead and drops this field — the
   * device has nothing to do with a name that only exists in this farm's
   * own database.
   */
  credentialRef: z.string().min(1).optional().describe('Name of a stored credential to authenticate with, instead of typing the upstream password again.').meta({ title: 'Credential' }),
  udpMode: z
    .enum(['udp', 'tcp'])
    .default('udp')
    .describe('Carry UDP natively through the tunnel, or fall back to TCP-only')
    .meta({ title: 'UDP mode' }),
})
export type Socks5RouteConfig = z.infer<typeof Socks5RouteConfigSchema>

/**
 * A named, reusable upstream credential (plan 52 §4.2) — never carries the
 * secret itself; that only ever exists encrypted in `network_credentials`
 * or decrypted in memory for the length of one `route.apply()` call. What
 * `GET /network-credentials` returns, and what Studio ever sees.
 */
export const NetworkCredentialSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  username: z.string().optional(),
  createdAt: z.number().int(),
  createdBy: z.string().nullable(),
})
export type NetworkCredential = z.infer<typeof NetworkCredentialSchema>

/** The body of `POST /network-credentials` — the one place a secret is ever accepted for the credential store itself. */
export const CreateNetworkCredentialRequestSchema = z.object({
  name: z.string().min(1).max(100).describe('A short name to reference this credential by, e.g. "soax-jp".').meta({ title: 'Name' }),
  username: z.string().optional().describe('Upstream username, if the proxy requires authentication').meta({ title: 'Username' }),
  secret: z.string().min(1).describe('Upstream password. Stored encrypted, never returned by any endpoint afterward.').meta({ title: 'Password' }),
})
export type CreateNetworkCredentialRequest = z.infer<typeof CreateNetworkCredentialRequestSchema>

/**
 * The named facts `health` used to collapse into one opaque enum (plan 51 §3.1, §4.1). Each ran
 * independently and answers one question:
 *
 * - `tunnel` — the device reports a TUN is established.
 * - `upstream` — a SOCKS5 session reaches the proxy and completes its handshake.
 * - `egress` — a probe through the tunnel returns an address.
 * - `geo` — that address matches what the upstream was asked for.
 * - `dns` — the resolver that looked us up belongs to the upstream's network.
 * - `leak` — IPv6 blocked; lockdown active when required.
 */
export const RouteCheckIdSchema = z.enum(['tunnel', 'upstream', 'egress', 'geo', 'dns', 'leak'])
export type RouteCheckId = z.infer<typeof RouteCheckIdSchema>

/**
 * One named check's outcome (plan 51 §4.1). `skip` and `unknown` are deliberately distinct:
 * `skip` means the check cannot run at all right now (no probe endpoint configured, an
 * unsupported agent build, no stated geo expectation) and is excluded from health's "every
 * check passed" requirement; `unknown` means it simply has not run yet and health cannot yet
 * call it either way. Collapsing the two would let a farm with no probe endpoint configured
 * read as "waiting to confirm" instead of the honest "cannot confirm" (plan 51 §4.3).
 *
 * `detail` must NEVER carry a credential — acceptance criterion 8 (plan 51 §6) is a grep over
 * every surface a check reaches, including this one.
 */
export const RouteCheckSchema = z.object({
  id: RouteCheckIdSchema,
  state: z.enum(['pass', 'fail', 'skip', 'unknown']),
  /** Never a credential. */
  detail: z.string().optional(),
  /** Unix epoch seconds this check last actually ran, or null if it never has. */
  at: z.number().int().nullable(),
})
export type RouteCheck = z.infer<typeof RouteCheckSchema>

/**
 * `health` is derived from `checks`, never stored (plan 51 §4.1) — this is the one place that
 * mapping happens, so every caller (the core's status assembly, a future Studio computation, a
 * test) reads the same rule rather than each guessing at it independently.
 *
 * - `unknown` — nothing has run yet (an empty list, or every check still `unknown`).
 * - `degraded` — at least one check genuinely failed.
 * - `unverified` — no failures, but `egress` has not passed (never run, still unknown, or
 *   skipped because no probe endpoint is configured) — this is the ONLY way `ok` stays
 *   unreachable, matching plan 44's original promise that a successful `apply()` alone can never
 *   report `ok`.
 * - `ok` — every non-skipped check passed, `egress` among them.
 *
 * A `fail` always wins over "egress hasn't run yet": a route with a failing `tunnel` check and
 * an `egress` check that simply never ran is `degraded`, not `unverified` — there is already a
 * concrete problem to report, so downgrading to the softer "not yet confirmed" reading would
 * bury it.
 */
export function deriveHealth(checks: RouteCheck[]): 'ok' | 'degraded' | 'unverified' | 'unknown' {
  if (checks.length === 0 || checks.every((c) => c.state === 'unknown')) return 'unknown'
  if (checks.some((c) => c.state === 'fail')) return 'degraded'
  const egress = checks.find((c) => c.id === 'egress')
  if (!egress || egress.state !== 'pass') return 'unverified'
  return 'ok'
}

/**
 * What survives in `devices.network_route` (plan 44 step 5.4, fixing the
 * defect recorded in plan 44 §8b — a route with no durable record cannot
 * come back after a core restart, and the operator had to retype the
 * upstream, password included, every time). `config.credentialRef` names a
 * `network_credentials` row (plan 52 §4.2, §5.1) rather than carrying the
 * upstream password itself — this column no longer holds a secret at rest.
 * That is a "not readable by grepping the database" claim, not a stronger
 * one: see `network_credentials`'s own schema comment for the honest
 * boundary of what the credential store's encryption actually buys. A
 * pre-migration row can still have inline `username`/`password` on
 * `config` until `createGuestAgentRoutes`'s boot-time migration rewrites
 * it into a named credential — never assume `config` is already clean.
 * `enabled` is the operator's declared on/off intent, tracked separately
 * from `config` on purpose: the default config is null, and with no config
 * there is nothing to enable — `enabled: true` alongside `config: null`
 * must never occur. Nothing that reads this value may hand it to a client
 * without first running `config` through `redactRouteConfig()`.
 */
export const PersistedNetworkRouteSchema = z.object({
  config: Socks5RouteConfigSchema,
  enabled: z.boolean(),
  /**
   * A per-device sticky-session identity (plan 52 §3.3, §4.3): generated
   * once, the first time a route is applied, and stable thereafter —
   * regenerated only when an operator explicitly asks for a fresh one.
   * On its own this changes nothing; `renderStickyUsername()` below is
   * what actually injects it into the resolved upstream username, and only
   * when a farm-level session template is configured. STICKY IS A REQUEST,
   * NOT A GUARANTEE — a residential proxy provider can expire or rotate the
   * underlying session at any time regardless of what this farm asks for;
   * plan 51's `geo` check is what actually reports whether the exit moved
   * anyway. Optional, matching `failClosed` below: every existing
   * `PersistedNetworkRoute` predates this field.
   */
  sessionId: z.string().optional(),
  /**
   * Plan 51 §4.4 / §5.6 — inert plumbing only in this build. The setting is meant to make
   * provisioning also set always-on VPN with lockdown, so a dead tunnel sends nothing rather
   * than silently falling back to the device's real address. That enforcement mechanism is
   * NOT implemented here: plan 51 §5.1 (does `settings put secure always_on_vpn_app` +
   * `always_on_vpn_lockdown` actually take effect, or is device-owner required?) has not been
   * run, and building the enforcement on an unverified mechanism would produce exactly the
   * "confident nonsense" this plan warns against elsewhere. `.optional()` rather than
   * `.default(false)` on purpose — every existing `PersistedNetworkRoute` object literal in
   * this codebase predates this field, and a default would make it non-optional in the
   * inferred type, forcing every one of those call sites to supply it for no behavioural
   * gain yet.
   */
  failClosed: z.boolean().optional(),
})
export type PersistedNetworkRoute = z.infer<typeof PersistedNetworkRouteSchema>

/**
 * Replace `password` with a fixed mask. This exists because a config this
 * shape flows through more places than any one author is likely to keep
 * track of by hand — the device event log, `GET`/`PUT` API responses, and
 * Studio's own display of the current route — and plan 44 §4.5 and acceptance
 * criterion 8 require the raw secret to appear in NONE of them. Routing every
 * one of those call sites through a single helper turns "did we redact this"
 * into a question answerable by grepping for the helper's name, rather than
 * an audit of every place a `Socks5RouteConfig` is ever touched.
 */
const REDACTED_PASSWORD = '••••••••'
export function redactRouteConfig(config: Socks5RouteConfig): Socks5RouteConfig {
  if (config.password === undefined) return config
  return { ...config, password: REDACTED_PASSWORD }
}

/**
 * Renders a sticky-session upstream username (plan 52 §3.3, §4.3) by
 * APPENDING a farm-level template to `username` — never a full replacement,
 * so one template only has to describe the suffix a given provider expects
 * (e.g. `-sessionid-{id}`), not the whole username format. `{id}` in the
 * template is replaced with `sessionId`; an empty/unset template means no
 * stickiness (the default) and returns `username` unchanged. A template
 * that happens not to mention `{id}` at all is still appended verbatim
 * rather than rejected — sticky-session syntax is entirely provider-
 * specific, and this function has no basis for assuming every provider
 * needs a literal `{id}` placeholder to key a session off of.
 */
export function renderStickyUsername(username: string, sessionId: string, template: string): string {
  if (!template) return username
  return username + template.split('{id}').join(sessionId)
}

/**
 * What the device reported back for the current route, verbatim from the
 * guest agent's `route.status` result — a subset of `RouteStatusResult` in
 * `guest-agent.ts` deliberately duplicated rather than imported, so this
 * file's host-side model of "what was observed" stays decoupled from the
 * wire envelope shape.
 */
export const NetworkObservationSchema = z.object({
  prepared: z.boolean().describe('Whether VPN consent has been granted to the agent on the device'),
  up: z.boolean().describe('Whether the route is currently up, per the device'),
  upstream: z.string().optional().describe('The upstream the device reports routing through, "host:port"'),
  /** [txPackets, txBytes, rxPackets, rxBytes]. */
  stats: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]).optional(),
  /** The device's own account of why the route is not working — e.g. the dead-man switch's reason. */
  lastError: z.string().optional(),
})
export type NetworkObservation = z.infer<typeof NetworkObservationSchema>

/**
 * The status payload for a device's network route (Plan 33 §3.2, §4.1,
 * reduced by plan 44 §4.2). `declared` and `observed` are kept as two
 * separate fields, never merged, for the same reason declared and observed
 * device state stay distinct everywhere else in this codebase: a request
 * that was sent says nothing about what the device actually did, and
 * collapsing them would let a farm report success while routing nothing.
 *
 * `health` is now DERIVED from `checks` via `deriveHealth()` (plan 51 §4.1), never stored — it
 * can ONLY become `'ok'` once an egress probe exists and passes. A successful `apply()` — the
 * device answering `{ started: true }` — must never by itself set `health` to `'ok'`; it is
 * evidence the request was accepted, not evidence traffic is actually leaving through the
 * proxy. `checks` is always returned alongside `health` so a caller (Studio, in particular) can
 * say WHICH fact is missing rather than just that something is.
 */
export const NetworkStatusSchema = z.object({
  engine: NetworkEngineIdSchema,
  capabilities: NetworkCapabilitiesSchema,
  /** What we asked for, lease-scoped — null when no route has been declared. */
  declared: Socks5RouteConfigSchema.nullable(),
  /**
   * The operator's declared on/off intent (plan 44 step 5.4), persisted
   * alongside `declared` and kept separate from it on purpose — the default
   * config is null, and with no config there is nothing to enable. A route
   * that was enabled but has since died reads `enabled: true` together with
   * `observed.up: false` and `drift: true`; it is never quietly folded into
   * "off" just because it stopped working.
   */
  enabled: z.boolean(),
  /** What the device reported back — null before the first observation. */
  observed: NetworkObservationSchema.nullable(),
  /** True when `declared` and `observed` disagree. */
  drift: z.boolean(),
  health: z.enum(['ok', 'unverified', 'degraded', 'unknown']),
  /** The named facts `health` above was derived from (plan 51 §4.1) — always present, even when every check is `unknown`. */
  checks: z.array(RouteCheckSchema),
  leaseId: z.string().nullable(),
  /** Unix epoch seconds, or null before any apply has succeeded. */
  appliedAt: z.number().int().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type NetworkStatus = z.infer<typeof NetworkStatusSchema>
