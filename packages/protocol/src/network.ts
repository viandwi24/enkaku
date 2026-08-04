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
 * `up` alone cannot tell "held closed on purpose" (plan 54 §3.1's fail-closed fix) apart from
 * "nothing configured at all" — both used to read `up: false` identically, which is exactly why a
 * held route could not be told apart from a torn-down one anywhere upstream of the device. `state`
 * carries that distinction; `up` (on `RouteStatusResultSchema` in `guest-agent.ts`, and on
 * `NetworkObservationSchema` below) is kept alongside it for compatibility with every existing
 * reader, and is always exactly `state === 'up'` on the Kotlin side (`RouteState.isUp()`).
 */
export const RouteLifecycleStateSchema = z.enum(['up', 'held', 'down'])
export type RouteLifecycleState = z.infer<typeof RouteLifecycleStateSchema>

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
 * Where an operator expects a route's exit to be (plan 55 §3.1, §4.1). Only `country` is
 * required — required because it is the field that ENABLES the `geo` check at all (acceptance
 * criterion 1: no expectation, not even a bare country, means `skip`, forever). Everything else
 * is optional, and the check only ever compares fields actually declared here (plan 55 §3.3,
 * "match at the narrowest level the operator declared") — declaring only a country is not failed
 * by a city change, but the observed city still appears in the check's `detail` either way.
 */
export const GeoExpectationSchema = z.object({
  country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. "JP"').meta({ title: 'Country' }),
  region: z.string().min(1).optional().describe('State/province/region name, as the geo provider reports it').meta({ title: 'Region' }),
  city: z.string().min(1).optional().describe('City name, as the geo provider reports it').meta({ title: 'City' }),
  asn: z.number().int().positive().optional().describe('Autonomous system number, without the "AS" prefix').meta({ title: 'ASN' }),
  isp: z.string().min(1).optional().describe('ISP/organisation name, as the geo provider reports it').meta({ title: 'ISP' }),
})
export type GeoExpectation = z.infer<typeof GeoExpectationSchema>

/**
 * What a geo lookup actually reported for one exit address (plan 55 §4.1) — every field but
 * `address`/`at` is nullable, not optional, because a lookup that SUCCEEDED but could not
 * attribute a particular field (e.g. no ASN in the provider's data for this address) is a
 * different fact than a field the provider's response shape never carries at all;
 * `GeoProviderResponseSchema` below is what a `network.geoProvider` endpoint is actually expected
 * to answer with, and this schema is that response plus the address it was looked up for and when.
 */
export const GeoObservationSchema = z.object({
  address: z.string(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  asn: z.number().int().nullable(),
  isp: z.string().nullable(),
  /** Unix epoch seconds this observation was made. */
  at: z.number().int(),
})
export type GeoObservation = z.infer<typeof GeoObservationSchema>

/**
 * The documented response shape a `network.geoProvider` endpoint (plan 55 §3.2, §5.2) must
 * answer `GET <geoProvider>?ip=<address>` with — every field nullable so an honest "I don't know
 * this one" never has to be faked as a wrong guess. The self-hosted probe endpoint
 * (`packages/probe-server`, Plan 51 §5.3) implements this exact shape at its own `/geo` route,
 * as the reference implementation Plan 55 §3.2 calls for — but ANY service answering this shape
 * is a valid `network.geoProvider`, which is the whole point of the setting being a plain URL
 * rather than a hardcoded vendor SDK.
 */
export const GeoProviderResponseSchema = GeoObservationSchema.omit({ address: true, at: true })
export type GeoProviderResponse = z.infer<typeof GeoProviderResponseSchema>

/**
 * Which declared field of a `GeoExpectation` a comparison disagreed on (plan 55 §4.2: "fail,
 * `detail` names WHICH field and both values") — checked in this order (broadest first) so a
 * country-level mismatch is reported as the country being wrong, not buried under a coincidental
 * city difference.
 */
const GEO_FIELD_ORDER = ['country', 'region', 'city', 'asn', 'isp'] as const

export interface GeoMatchResult {
  matches: boolean
  /** Set only when `matches` is false — the first declared field (in `GEO_FIELD_ORDER`) that disagreed. */
  field?: (typeof GEO_FIELD_ORDER)[number]
  expected?: string
  observed?: string
}

/** Case-insensitive, trimmed string compare — a geo provider's casing/whitespace is not a signal worth failing on. */
function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Compares a declared `GeoExpectation` against an observed `GeoObservation` (plan 55 §4.2, §3.3).
 * Only fields the operator actually declared are ever checked — "match at the narrowest level
 * declared" falls directly out of iterating `expect`'s own keys rather than every field
 * `GeoObservation` could carry. An observed `null` for a DECLARED field counts as a mismatch: the
 * operator asked this to be verified, and "the provider has no answer for it" is not evidence
 * that it matches.
 */
export function matchGeoExpectation(expect: GeoExpectation, observed: GeoObservation): GeoMatchResult {
  for (const field of GEO_FIELD_ORDER) {
    const wanted = expect[field]
    if (wanted === undefined) continue
    const got = observed[field]
    const isMatch = field === 'asn' ? got === wanted : typeof got === 'string' && typeof wanted === 'string' && sameText(got, wanted)
    if (!isMatch) {
      return { matches: false, field, expected: String(wanted), observed: got === null ? 'unknown' : String(got) }
    }
  }
  return { matches: true }
}

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
  /**
   * Plan 54 §4.2, §5.6 — whether a failure on this route should hold the device's TUN closed
   * (default, the safe reading: "the safe default is the one that does not leak") rather than
   * tear it down, which is what happens when this is explicitly `false` — preserved for an
   * operator debugging by hand. Absent on the DECLARED shape (`PersistedNetworkRoute.config`):
   * the single source of truth is the wrapper's own `PersistedNetworkRoute.failClosed`
   * (`resolveFailClosed()` in `packages/core/src/api/guest-agent.ts`), which `PUT /network`
   * reads this same field off of and `applyRoute()` re-populates onto the RESOLVED wire object
   * right before `route.apply()` — mirroring how `credentialRef` resolves into `username`/
   * `password` on that same resolved object.
   */
  failClosed: z.boolean().optional().describe('Hold the device closed on failure instead of falling back to its real address').meta({ title: 'Fail closed' }),
  /**
   * REQUEST-ONLY, and the only way to turn an authenticated route into an anonymous one.
   *
   * A `PUT /network` carrying neither inline credentials nor a `credentialRef` used to mean
   * "this upstream needs no authentication", so re-saving host/port alone silently dropped the
   * credential the route already had. Against a provider that also accepts IP-whitelist auth
   * that does not fail — it connects anonymously and serves a DEFAULT pool exit, so every check
   * passes and `health` reads `ok` while the targeting the operator actually asked for is gone.
   * A silent wrong answer, which is the failure mode plans 51/52/54 exist to prevent.
   *
   * So an absent credential now CARRIES OVER the previous one, exactly as `failClosed` does, and
   * dropping it has to be asked for. Dropped from the DECLARED and RESOLVED shapes alike.
   */
  clearCredential: z.boolean().optional().describe('Drop the stored credential and connect to this upstream anonymously').meta({ title: 'No authentication' }),
  /**
   * Plan 55 §3.1, §4.1 — where this route's exit is EXPECTED to be, typed by the operator and
   * never inferred from the credential username (Plan 51 §4.1 and Plan 55 §3.1 both refuse that:
   * SOAX-style targeting syntax is one vendor's convention, and since Plan 52 the username is
   * encrypted at rest and the API deliberately never returns it — the UI could not read it back
   * even if it wanted to). Absent means "no expectation stated", which keeps the `geo` check at
   * `skip` forever (acceptance criterion 1) — never inferred, never defaulted. HOST-ONLY: dropped
   * from the RESOLVED wire object the same way `credentialRef`/`clearCredential` are — the device
   * has no notion of where it is "supposed" to be, only the host compares an observation against
   * this.
   */
  expect: GeoExpectationSchema.optional().describe('Where this route is expected to exit, for the geo check to compare against').meta({ title: 'Expected exit' }),
  /**
   * Plan 55 §3.5, §4.1, §5.6 — what a FAILED `geo` check should do to the route. `'report'` (the
   * default) only surfaces the failure through `health`/`checks`, same as any other failing
   * check; `'hold'` additionally forces the device into Plan 54's `held` state (traffic blocked,
   * TUN left up) via the `route.hold` control method, on the theory that a route whose exit left
   * its declared region is arguably worse than one merely down — it is actively presenting the
   * wrong identity while otherwise reporting success. Defaulting this to `'hold'` would strand a
   * device the first time a residential pool drifts one city over, so it stays opt-in. HOST-ONLY,
   * same reasoning as `expect` above — dropped from the resolved wire object.
   *
   * `.optional()` rather than `.default('report')` ON PURPOSE, mirroring `failClosed` above: a
   * Zod default makes the OUTPUT type non-optional, which would force every hand-built
   * `Socks5RouteConfig` object literal in this codebase (there are several, in both production
   * code and tests) to spell out `onGeoFail` even where it is irrelevant. `resolveOnGeoFail()` in
   * `packages/core/src/api/guest-agent.ts` is the one place `undefined` becomes the concrete
   * `'report'` default, the same treatment `resolveFailClosed()` gives `failClosed`.
   */
  onGeoFail: z.enum(['report', 'hold']).optional().describe('What a failed geo check should do: only report it, or hold the device closed too').meta({ title: 'On geo mismatch' }),
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
   * Plan 51 §4.4 introduced this field inert; plan 54 §4.2, §5.6 makes it real, WITHOUT the
   * always-on-VPN-plus-lockdown mechanism plan 51 §4.4 originally described — that mechanism is
   * still gated on plan 51 §5.1 (unverified), and does not need to be settled for this to work:
   * §3.1's fix is that the app-level `RouteVpnService` itself holds the TUN established and only
   * stops forwarding, which needs no special Android permission at all. `true` (the default this
   * plan writes for a newly-created route — `resolveFailClosed()` in
   * `packages/core/src/api/guest-agent.ts`) tells the agent to hold closed on any failure; `false`
   * preserves the pre-plan-54 tear-down, for an operator debugging by hand. `.optional()` rather
   * than `.default(true)` on purpose — every `PersistedNetworkRoute` predating this plan lacks it,
   * and `resolveFailClosed()` is the one place that turns "absent" into a concrete boolean rather
   * than every reader guessing its own default.
   */
  failClosed: z.boolean().optional(),
  /**
   * A small bounded ring of past exit observations (plan 55 §3.4, §4.3) — three different
   * residential-pool addresses in one afternoon is itself the signal an operator needs, and a
   * single "current" reading throws that history away the moment the pool rotates again.
   * Newest first, capped at `EXIT_HISTORY_LIMIT` by `pushExitHistory()` below; appended to on
   * every fresh `geo`/egress observation, never on a lookup failure (nothing new was actually
   * learned then). Optional, matching `sessionId`/`failClosed` above: every route predating plan
   * 55 lacks it.
   */
  exitHistory: z.array(GeoObservationSchema).optional(),
})
export type PersistedNetworkRoute = z.infer<typeof PersistedNetworkRouteSchema>

/** How many past exit observations `pushExitHistory()` keeps — "a short list, not a chart" (plan 55 §4.4). */
export const EXIT_HISTORY_LIMIT = 20

/**
 * Appends a fresh `GeoObservation` to a route's exit history ring, newest first, capped at
 * `EXIT_HISTORY_LIMIT` (plan 55 §4.3, §5.5). A pure function — the caller (`guest-agent.ts`) owns
 * reading the previous value and persisting the result, same as every other `PersistedNetworkRoute`
 * mutation in this codebase.
 */
export function pushExitHistory(history: GeoObservation[] | undefined, observation: GeoObservation): GeoObservation[] {
  return [observation, ...(history ?? [])].slice(0, EXIT_HISTORY_LIMIT)
}

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
  /** Plan 54 §4.1 — see `RouteLifecycleStateSchema`'s doc comment. Optional: an older agent build never sends it, and `up` alone is the fallback reading in that case. */
  state: RouteLifecycleStateSchema.optional(),
  upstream: z.string().optional().describe('The upstream the device reports routing through, "host:port"'),
  /** [txPackets, txBytes, rxPackets, rxBytes]. */
  stats: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]).optional(),
  /** The device's own account of why the route is not working — e.g. the dead-man switch's reason. */
  lastError: z.string().optional(),
  /** Plan 51 §4.5, §5.7 — see `RouteStatusResultSchema.ipv6Blocked` (`guest-agent.ts`) for the full doc comment; carried through unchanged. */
  ipv6Blocked: z.boolean().optional(),
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
