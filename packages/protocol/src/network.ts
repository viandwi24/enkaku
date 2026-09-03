import { z } from 'zod'

/**
 * The device-facing network layer (spec §7.9) — Plan 33 §4.1's three-rung
 * ladder, all of it now modelled here after plan 114 §3.2.
 *
 * The three rungs are NOT equals and this file is the first place that has to
 * say so, because everything downstream reads its vocabulary from here:
 *
 * - `adb-proxy` — `settings put global http_proxy host:port`. **Advisory**: an
 *   app with its own networking ignores it and nothing on the device stops it.
 *   Android's value carries no credential field and is world-readable by every
 *   app on the phone, so one is never written there (spec §7.9, plan 114 §3.8
 *   and its `E_HTTP_PROXY_NO_AUTH`).
 * - `adb-reverse-proxy` — the same advisory setting, pointed at `127.0.0.1` on
 *   the device side of an `adb reverse`, so the proxy (and therefore its
 *   account) lives on the farm's own machine and never on the phone.
 * - `vpn-helper` — a SOCKS5 full tunnel through the guest agent. The only
 *   **enforcing** rung: apps cannot opt out of it.
 *
 * Both HTTP rungs advertise every `NetworkCapabilities` field as `false` and
 * their `egress` check is permanently `skip`, which is what keeps
 * `deriveHealth` at `unverified` for them forever (plan 114 §3.5). That is the
 * correct answer, not a gap: an egress probe run from the host proves the proxy
 * works for the host, and a probe run on the device through a client that
 * honours the setting proves only that such a client can reach it — never that
 * any app under test did. `deriveHealth` is deliberately NOT touched by plan
 * 114; the engines simply cannot reach its top state.
 */
export const NetworkEngineIdSchema = z.enum(['none', 'adb-proxy', 'adb-reverse-proxy', 'vpn-helper'])
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
  /**
   * Plan 114 §4.1 — the discriminator that lets this shape join
   * `NetworkRouteConfigSchema` beside the two HTTP rungs.
   *
   * `.default('vpn-helper')` rather than a bare required literal, and the
   * distinction is load-bearing in two directions:
   *
   * - **Input stays optional**, so every producer that predates plan 114 keeps
   *   working unchanged — the `PUT /api/devices/:id/network` body Studio sends
   *   today, `scripts/smoke-guest-agent.ts`'s hand-built configs, and any row
   *   already on disk. A required literal would have turned all three into a
   *   400 or a throw the moment this file landed, days before the UI that
   *   sends the tag exists.
   * - **Output is required**, so a consumer switching on `config.engine` gets
   *   an exhaustive union with no `undefined` arm to remember. That is the
   *   whole point of making this a discriminated union rather than an
   *   optional flag people branch on by hand.
   *
   * Note what `.default()` does NOT do: `z.discriminatedUnion` builds a map
   * from discriminator VALUE to member and an absent key matches no entry, so
   * a default on the literal does not make the union accept an untagged
   * object. `tagUntaggedRouteConfig()` below is what does that, deliberately
   * and visibly, on the two read paths that can meet a pre-plan-114 value.
   *
   * On the guest-agent wire (`RouteStartRequestSchema.config` in
   * `guest-agent.ts`) this rides along as one extra key the agent ignores:
   * `ControlService.handle` reads `config` field by field off a `JSONObject`
   * (`optString`/`optInt`), so an unknown key is not an error there.
   */
  engine: z.literal('vpn-helper').default('vpn-helper'),
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
 * Rung 1 of spec §7.9's ladder (plan 33 §5, plan 114 §3.2, §4.1) — the phone is
 * ASKED to send its traffic through `host:port` by way of
 * `settings put global http_proxy`.
 *
 * **There is no credential field and there deliberately never will be.**
 * Android's system proxy value is `host:port` plus an exclusion list and has
 * nowhere to put a username or password; worse, the value is world-readable by
 * every app on the device, so spec §7.9 forbids putting one there in writing.
 * A request carrying a `username`/`password`, or a pasted URL with a userinfo
 * component, is refused with `E_HTTP_PROXY_NO_AUTH` and pointed at
 * `adb-reverse-proxy` instead, where the account stays on the farm's machine
 * (plan 114 §3.8).
 *
 * Nothing here is enforcing. The whole justification for the guest agent APK is
 * that this rung cannot be: an app using raw sockets, its own resolver, or a
 * pinned client ignores this setting and the device does not care.
 */
export const HttpProxyRouteConfigSchema = z.object({
  engine: z.literal('adb-proxy'),
  host: z.string().min(1).describe('Host of a proxy the phone itself can reach').meta({ title: 'Proxy host' }),
  port: z.number().int().min(1).max(65535).describe('Port of a proxy the phone itself can reach').meta({ title: 'Proxy port' }),
  /**
   * Written to `global_http_proxy_exclusion_list`. Optional and operator-supplied — plan 114 §9 Q4
   * asks whether the farm has any address of its own that must always be excluded, and until that
   * is answered nothing is defaulted in: silently exempting traffic somebody wanted proxied is a
   * worse failure than an empty list.
   */
  exclusions: z.array(z.string()).optional().describe('Hosts the phone should reach directly, bypassing the proxy').meta({ title: 'Exclusions' }),
})
export type HttpProxyRouteConfig = z.infer<typeof HttpProxyRouteConfigSchema>

/**
 * Rung 2 (plan 33 §5, plan 114 §3.2, §4.1) — the same advisory setting, pointed
 * at the device's own loopback, with `adb reverse` carrying the connection back
 * to a proxy listening on THIS farm's machine.
 *
 * This is the rung on which an authenticated upstream is possible at all,
 * because the account lives in the host-side listener and the phone only ever
 * dials `127.0.0.1`. The engine itself still advertises `auth: false` — the
 * credential is somebody else's (plan 112's proxy manager, or whatever the
 * operator runs on the machine), and claiming a capability the engine does not
 * have is exactly what `NetworkCapabilitiesSchema` exists to prevent.
 *
 * `hostPort` is where the proxy listens ON THE FARM. The device-side port is
 * allocated per device by the reverse registry (plan 114 §4.3) and is never
 * chosen by the operator, which is why it is absent from this schema.
 */
export const ReverseProxyRouteConfigSchema = z.object({
  engine: z.literal('adb-reverse-proxy'),
  hostPort: z.number().int().min(1).max(65535).describe('Port the proxy listens on, on this farm’s own machine').meta({ title: 'Port on this machine' }),
  /** Same field, same reasoning, as `HttpProxyRouteConfigSchema.exclusions`. */
  exclusions: z.array(z.string()).optional().describe('Hosts the phone should reach directly, bypassing the proxy').meta({ title: 'Exclusions' }),
})
export type ReverseProxyRouteConfig = z.infer<typeof ReverseProxyRouteConfigSchema>

/**
 * Every shape a declared route can take (plan 114 §4.1), discriminated on
 * `engine`.
 *
 * **Why a discriminated union and not `z.union`.** `z.union` tries its members
 * in order and takes the first that parses, which is how plan 108 §4.2 got a
 * list silently keyed by index into a map — `z.record` was listed before
 * `z.array` and happily accepted the array. `z.discriminatedUnion` does not try
 * anything: it reads one key, looks the value up in a map built from the
 * members' literals, and runs exactly that member or fails. Order is therefore
 * not a correctness input here at all, and no shape ambiguity between the three
 * members can produce a wrong match. The members are nonetheless listed
 * narrowest-first (`adb-proxy`, `adb-reverse-proxy`, then the much larger
 * `vpn-helper`) so that the ordering is still the safe one if this is ever
 * refactored into a plain union by someone who does not read this comment.
 *
 * `none` is NOT a member. It is an engine id — the answer to "which engine is
 * this device running" when the answer is "no route" — not a config shape; a
 * device with no route carries `config: null`, and has since plan 44.
 */
export const NetworkRouteConfigSchema = z.discriminatedUnion('engine', [
  HttpProxyRouteConfigSchema,
  ReverseProxyRouteConfigSchema,
  Socks5RouteConfigSchema,
])
export type NetworkRouteConfig = z.infer<typeof NetworkRouteConfigSchema>

/**
 * The read-time migration (plan 114 §4.1). A `devices.network_route.config`
 * written before plan 114 — or a `GET /api/devices/:id/network` answered by a
 * core that predates it — carries no `engine` key, and an untagged object
 * matches no arm of a discriminated union (see `Socks5RouteConfigSchema.engine`
 * for why a Zod `.default()` does not cover this). This is what tags it.
 *
 * An untagged config is a `vpn-helper` config **by construction, not by
 * guess**: `vpn-helper` was the only engine that existed, so it is the only
 * thing that could have written one. That is the same discipline
 * `failClosed`/`sessionId`/`exitHistory` already follow on
 * `PersistedNetworkRouteSchema` — an absent field means "predates the plan",
 * never a defaulted value chosen for convenience — and it is why this is a
 * migration rather than a compatibility shim: the tag is written back on the
 * next save and the untagged form stops existing.
 *
 * Deliberately narrow about what it will touch. Only a plain, non-array object
 * with no `engine` key of its own is tagged; `null`, `undefined`, arrays,
 * primitives and anything already carrying an `engine` are returned untouched
 * so the union's own error is what the caller sees. The array exclusion is not
 * hypothetical caution — spreading an array into an object literal is precisely
 * how plan 108 §4.2 turned a list into an index-keyed map.
 */
export function tagUntaggedRouteConfig(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  if ('engine' in value) return value
  return { ...(value as Record<string, unknown>), engine: 'vpn-helper' }
}

/**
 * `NetworkRouteConfigSchema` with the read-time migration in front of it — the
 * shape to parse a STORED or RECEIVED route config with, as opposed to one this
 * process just built. Anything reading `devices.network_route` or a `/network`
 * response wants this one; a handler validating a fresh request body wants the
 * bare union, because a body arriving untagged from a client built after plan
 * 114 is a client bug and should be refused rather than guessed at.
 *
 * Wired to `PersistedNetworkRouteSchema.config` by step 114.3 — see that
 * field's own comment.
 */
export const StoredNetworkRouteConfigSchema = z.preprocess(tagUntaggedRouteConfig, NetworkRouteConfigSchema)

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
 * - `setting` — the device's own `settings get global http_proxy` reads back what we wrote.
 * - `reverse` — the `adb reverse` entry is live and the host-side listener answers on it.
 * - `upstream` — a SOCKS5 session reaches the proxy and completes its handshake.
 * - `egress` — a probe through the tunnel returns an address.
 * - `geo` — that address matches what the upstream was asked for.
 * - `dns` — the resolver that looked us up belongs to the upstream's network.
 * - `leak` — IPv6 blocked; lockdown active when required.
 *
 * `setting` and `reverse` are plan 114 §3.5's two additions, and they are
 * additive in the strict sense: every existing reader treats a check id as
 * data (an id, a state, a detail string) rather than branching on it, so
 * nothing has to learn them to keep working. Which ids an engine reports is
 * the engine's own business — `vpn-helper` skips both of these, and both HTTP
 * rungs skip `tunnel`/`geo`/`dns`/`leak` and skip `egress` PERMANENTLY, which
 * is what pins their `deriveHealth` at `unverified`.
 *
 * `setting: pass` is worth showing and is not success. It says the device
 * accepted the write and reports it back — a real, non-trivial fact, and a
 * strictly weaker one than "this phone's traffic goes through that proxy".
 */
export const RouteCheckIdSchema = z.enum(['tunnel', 'setting', 'reverse', 'upstream', 'egress', 'geo', 'dns', 'leak'])
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
  /**
   * A row written before plan 114 has no `engine` key at all, and it still
   * parses — as `vpn-helper`, via `tagUntaggedRouteConfig()` in front of the
   * union (`StoredNetworkRouteConfigSchema`). That is the compatibility hinge
   * and it is load bearing: `readPersistedRoute`
   * (`packages/core/src/network/route-service.ts`) treats a parse failure as
   * "no route" rather than throwing, so a broken migration would not surface
   * as an error anyone could follow back here — it would surface as every
   * existing device's saved route quietly vanishing.
   *
   * **Step 114.3 flipped this from `Socks5RouteConfigSchema` to the stored
   * union.** 114.1 shipped the vocabulary deliberately unspent, because a union
   * here immediately requires the engine-aware route lifecycle that 114.3
   * builds — every site reading `persisted.config.host`/`.udpMode`/
   * `.credentialRef` and handing it to a VPN-only helper has to narrow on
   * `config.engine` first. The preprocess takes over from
   * `Socks5RouteConfigSchema.engine`'s own `.default()` at this point, and that
   * is what makes an `adb-proxy` row readable at all.
   */
  config: StoredNetworkRouteConfigSchema,
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
  /**
   * Plan 114 §3.6 — the device's own proxy settings as they were BEFORE this
   * farm ever wrote one, so turning a route off restores what was found rather
   * than a hard-coded reset. Plan 33 §5's original prescription
   * (`settings put global http_proxy :0`) is the asymmetric one: it leaves the
   * literal string `:0` where a pristine device had `null`. This copies
   * `packages/session/src/screen-label.ts`, which solved exactly this for
   * `secure` keys — read the prior value, normalise Android's literal string
   * `null` to `''`, and restore it verbatim on revert.
   *
   * Captured **once**, on the first apply for a device, and never overwritten
   * by a later re-apply — otherwise a farm-set value becomes the "original"
   * the second time round and the real one is gone for good. Values are the
   * raw strings the four `settings get global` reads returned, already
   * normalised; `at` is unix epoch seconds.
   *
   * Absent means "nothing was ever captured" — a route that predates plan 114,
   * or a capture that failed because the device was unreachable. That is a
   * DIFFERENT case from an empty capture and revert must not conflate them: it
   * clears the four keys to Android's default and the UI says it cleared
   * rather than restored (§3.6 rule 4).
   */
  captured: z
    .object({
      httpProxy: z.string(),
      host: z.string(),
      port: z.string(),
      exclusionList: z.string(),
      at: z.number().int(),
    })
    .optional(),
  /**
   * Plan 114 §4.3, and the gap step 114.4 raised on its way out: **the
   * `adb-reverse-proxy` rung's device-side port is bookkeeping, not intent, and
   * it has to be on disk anyway.**
   *
   * `ReverseProxyRouteConfigSchema` carries only `hostPort` — the operator says
   * where the proxy listens on the farm, and the device-side port is allocated
   * by the reverse registry. But after a core restart the phone is still
   * carrying `http_proxy 127.0.0.1:<devicePort>`, and the registry is an
   * in-memory map that did not survive. Without this field, nothing on disk
   * records which port that was, and the reconcile pass would have to either
   * re-read the setting off the device and trust it (a value the farm did not
   * write is not a value the farm may reallocate against) or allocate a fresh
   * port and leave the phone pointed at a dead one. So it is persisted, and
   * `ReverseRegistry.establish(deviceId, { hostPort, devicePort })` honours a
   * supplied port exactly and never walks the range — that contract exists for
   * this field.
   *
   * On `PersistedNetworkRoute` rather than on the config union deliberately,
   * exactly like `sessionId` and `captured`: `config` is what the operator
   * asked for and is echoed back to them; this is what the farm allocated on
   * their behalf. Absent for every engine but `adb-reverse-proxy`, and absent
   * for that one until step 114.5 builds the engine that populates it.
   */
  reverse: z
    .object({
      /** The port ON THE PHONE that `http_proxy` points at. Sticky for the life of the route. */
      devicePort: z.number().int().min(1).max(65535),
      /** The port on the farm's own machine the reverse forwards to — a copy of `config.hostPort` at the time of the allocation, so a re-established reverse can be compared against what the config now says. */
      hostPort: z.number().int().min(1).max(65535),
      /** Unix epoch seconds the allocation was made. */
      at: z.number().int(),
    })
    .optional(),
  /**
   * Plan 114 §3.3 — who set this route. A person and a plugin can both reach
   * `PUT /api/devices/:id/network`, and the resolution between them is
   * last-write-wins with attribution, never a lock: a lock between an operator
   * and a plugin produces a device nobody can fix, which is why plan 52 §3.1
   * chose ownership plus audit over teardown for the adjacent problem.
   *
   * `id` is the actor — a user id, or the plugin id. `at` is unix epoch
   * seconds. Optional only because routes written before plan 114 have no such
   * record; never absent on a route written after it.
   */
  setBy: z
    .object({
      kind: z.enum(['user', 'plugin']),
      id: z.string(),
      at: z.number().int(),
    })
    .optional(),
  /**
   * **A teardown this farm owes a device it could not reach.**
   *
   * The measured incident: a phone was turned off in the farm while it was
   * unplugged, and every engine's `revert()` swallows an unreachable device by
   * contract (`http-proxy.ts`'s `restoreAll` tolerates each failed write;
   * `vpn-helper.ts`'s says nothing at all over a session that was never
   * active). So the row was cleared, the screen read "no route", and the phone
   * kept `http_proxy 127.0.0.1:28100` — pointing at a farm the record no
   * longer believed in. When it came back the reverse came back with it and
   * the phone's traffic went out through a metered residential proxy nobody
   * had asked for since the day before.
   *
   * The intent to clear must therefore outlive the attempt, the same way
   * `enabled` outlives an apply that failed: `revertNetwork` writes this
   * whenever the teardown could not be confirmed ON THE DEVICE, and
   * `restoreDeviceRoute` settles it on the next admission. Until it is settled
   * the row STAYS — with `enabled: false` — even for `DELETE /network`, which
   * would otherwise erase the `captured` values the revert still has to
   * restore and the `reverse.devicePort` it still has to remove.
   *
   * `forget` is what the caller asked for and is honoured once the device is
   * finally reached: `true` erases the row (DELETE), `false` keeps the
   * disabled config (`/disable`, an engine switch).
   */
  pendingClear: z
    .object({
      /** The engine the DEVICE is still carrying — not necessarily what `config` will say by then. */
      engine: NetworkEngineIdSchema,
      /** The reverse's device-side port, when the owed teardown includes removing one. */
      devicePort: z.number().int().min(1).max(65535).optional(),
      /** Erase the whole row once the device is finally reverted (`DELETE`), rather than keep a disabled config. */
      forget: z.boolean(),
      /** Why the teardown could not be confirmed — an operator-readable sentence, carried onto the device event. */
      reason: z.string(),
      /** Unix epoch seconds the debt was first recorded. Not refreshed by a later failed attempt: how long a phone has been carrying it is the point. */
      since: z.number().int(),
    })
    .optional(),
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
 *
 * Plan 114 widened the parameter to the whole `NetworkRouteConfig` union while
 * keeping the caller's own narrower type on the way out (hence the generic
 * rather than a plain union parameter — a caller handing in a
 * `Socks5RouteConfig` must not get a union back and have to re-narrow it).
 * Neither HTTP rung has anything to redact: the whole point of §3.8 is that no
 * credential is ever written into a device setting, so those configs carry no
 * secret and pass through untouched.
 */
const REDACTED_PASSWORD = '••••••••'
export function redactRouteConfig<T extends NetworkRouteConfig>(config: T): T {
  if (config.engine !== 'vpn-helper') return config
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
  /**
   * What we asked for, activity-scoped — null when no route has been declared.
   * Still the SOCKS5 shape for the same reason, and with the same one-line
   * flip pending, as `PersistedNetworkRouteSchema.config` above: this is the
   * core↔node tunnel shape and its producer is the same VPN-only route
   * lifecycle 114.3 rewrote.
   */
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
  /** The `network-apply` activity id the route was last applied under, or null (plan 205, MVP 04). */
  activityId: z.string().nullable(),
  /** Unix epoch seconds, or null before any apply has succeeded. */
  appliedAt: z.number().int().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type NetworkStatus = z.infer<typeof NetworkStatusSchema>
