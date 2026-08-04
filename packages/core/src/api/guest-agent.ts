import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  PersistedNetworkRouteSchema,
  Socks5RouteConfigSchema,
  CreateNetworkCredentialRequestSchema,
  GeoProviderResponseSchema,
  redactRouteConfig,
  renderStickyUsername,
  deriveHealth,
  matchGeoExpectation,
  pushExitHistory,
  type NetworkEngineId,
  type NetworkObservation,
  type PersistedNetworkRoute,
  type Socks5RouteConfig,
  type NetworkCredential,
  type RouteCheck,
  type EgressProbeResult,
  type GeoObservation,
  type ShellResult,
} from '@enkaku/protocol'
import {
  GUEST_AGENT_PACKAGE,
  GuestAgentClientError,
  createGuestAgentClient,
  createGuestAgentLauncher,
  createVpnHelperRoute,
  type GuestAgentClient,
  type GuestAgentClientOptions,
  type GuestAgentLauncher,
  type NetworkRoute,
} from '@enkaku/drivers'
import type { PortAllocator } from '@enkaku/session'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { EventRecorder } from '../events/recorder'
import type { LeaseManager } from '../lease/lease-manager'
import type { Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'
import { createCredentialStore } from '../network/credential-store'

/**
 * `GET/POST/DELETE /api/devices/:id/guest-agent` and
 * `GET/PUT/DELETE /api/devices/:id/network` (plan 44 §5.7, §5.8) — the link
 * between Studio's per-device Network tab
 * (`packages/studio/src/components/guest-agent/NetworkPanel.tsx`) and the
 * `vpn-helper` engine (`packages/drivers/src/network/guest-agent/`).
 *
 * Both endpoint groups live in this one file because they share every
 * dependency (the launcher, the client, the port pool) and a device's
 * network route cannot outlive its guest agent — uninstalling the agent
 * tears the route down first, and applying a route installs the agent if
 * needed (plan 44 §1, goal 2).
 */

/** Android 10 (API 29) is the floor the design leans on — VpnService behaviour below it is not proven (plan 44 §4.1, docs/research/android-guest-agent.md). */
const MIN_SUPPORTED_SDK = 29

/** GET's own status probe does not need a fresh-install budget — a handful of retries is enough to tell "not answering" from "still slow". `installAndProbe` uses the full budget (plan 44 §5.1's proven retry count) since a cold start right after `adb install` is slower. */
const STATUS_HANDSHAKE_RETRIES = 2
const INSTALL_HANDSHAKE_RETRIES = 8

export type GuestAgentState = 'not-installed' | 'installed' | 'ready' | 'unreachable' | 'unsupported'

export interface GuestAgentStatusResult {
  state: GuestAgentState
  appVersion?: string
  androidSdkInt?: number
  capabilities?: string[]
  reason?: string
}

export interface NetworkStatusResult {
  engine: NetworkEngineId
  /** Persisted route config — `credentialRef` names a stored credential (plan 52 §4.2); never a username/password. Null when nothing has ever been declared. */
  config:
    | {
        host: string
        port: number
        credentialRef?: string
        udpMode: 'udp' | 'tcp'
        /** Plan 55 §3.1, §4.1 — undefined means no expectation stated; `geo` stays `skip` forever. */
        expect?: Socks5RouteConfig['expect']
        /** Plan 55 §3.5, §4.1 — always concrete here (`resolveOnGeoFail()`), never `undefined`, so Studio never has to guess a default of its own. */
        onGeoFail: 'report' | 'hold'
      }
    | null
  /** The operator's declared on/off intent — separate from `config` on purpose (plan 44 step 5.4): the default config is null, and with no config there is nothing to enable. */
  enabled: boolean
  observed: NetworkObservation | null
  drift: boolean
  /** The per-device sticky-session id (plan 52 §4.3), read-only — null until a route has been applied at least once. */
  sessionId: string | null
  /** Plan 54 §4.2, §5.6 — whether a failure holds the device closed (`true`, the default even for a route created before this field existed — `resolveFailClosed()`) or tears down (`false`, explicit opt-out). Always a concrete boolean here, never `undefined`, so Studio never has to guess a default of its own. */
  failClosed: boolean
  /** Derived from `checks` via `deriveHealth()` (plan 51 §4.1) — never set directly. */
  health: 'ok' | 'unverified' | 'degraded' | 'unknown'
  /** The named facts `health` was derived from — always present, even when every check is `unknown` (plan 51 §4.1, §5.8). */
  checks: RouteCheck[]
  lastError: { code: string; message: string } | null
  /** Plan 55 §4.3, §5.5 — the last `EXIT_HISTORY_LIMIT` geo observations, newest first, so a rotating pool is visible as a sequence rather than one current value. Always present (possibly empty) once a route exists. */
  exitHistory: GeoObservation[]
}

/** How often the daemon-wide heartbeat pings every device with an enabled route (plan 44 step 5.4) — the core's half of the dead-man's-switch pair described in plan 44 §8b; the agent's own half tears the route down after 90s of silence. */
const NETWORK_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * Plan 51 §4.3, §5.5 — the self-hosted probe endpoint's URL. `network.probeUrl` was specified as a
 * per-farm SETTING; it is read from an env var here instead of `FarmSettingsSchema`
 * (`packages/protocol/src/settings.ts`) as a deliberate scope decision for this pass — that file
 * is outside this change's file allowlist and other work was landing in it concurrently. Wiring
 * this into real farm settings (so it is configurable from Studio, not just at process start) is
 * follow-up work; until then this is the ONE place a farm operator sets it.
 *
 * When unset, `egress`/`dns`/`geo` stay `skip` and `health` can never reach `ok` (plan 51 §4.3,
 * acceptance criterion 3) — never a silent `ok`.
 *
 * Read on every call, not cached at module load — mirrors `resolveGuestAgentApkPath`'s own
 * treatment of `ENKAKU_GUEST_AGENT_PATH`, and for the same reason: a module-level constant would
 * freeze whatever the env var held at import time, which is both wrong for a long-running daemon
 * and untestable (a test cannot un-import this module to change it).
 */
function probeUrl(): string | null {
  return process.env.ENKAKU_NETWORK_PROBE_URL?.trim() || null
}

/** Per-leg budget handed to the device for each `egress.probe` call. */
const PROBE_TIMEOUT_MS = 8_000

/**
 * Plan 52 §3.3, §4.3 — the farm-level sticky-session template, describing where a per-device
 * `sessionId` gets injected into the resolved upstream username. Read from an env var rather than
 * `FarmSettingsSchema` for the SAME reason `probeUrl()` above is (`packages/protocol/src/
 * settings.ts` is outside this pass's file allowlist, and other work is landing there
 * concurrently) — wiring this into real farm settings is follow-up work; until then this is the
 * one place an operator sets it. Empty/unset means no stickiness — `renderStickyUsername()`
 * returns the username unchanged in that case.
 */
function sessionTemplate(): string {
  return process.env.ENKAKU_NETWORK_SESSION_TEMPLATE?.trim() ?? ''
}

/**
 * Plan 51 §4.3, §5.3 — the zone this farm's probe endpoint (`packages/probe-server`) is
 * authoritative for, e.g. `dns.probe.example.com`. Read from an env var, the SAME scope decision
 * `probeUrl()` above documents (and for the same reason `sessionTemplate()` is): this and
 * `network.probeUrl` are one feature's two halves, and only `network.geoProvider` (Plan 55 §5.1)
 * was worth moving into real `FarmSettingsSchema` settings for this pass. Unset means the `dns`
 * check stays `skip`, naming this variable — never a guessed `pass`.
 */
function probeDnsZone(): string | null {
  return process.env.ENKAKU_NETWORK_PROBE_DNS_ZONE?.trim().toLowerCase() || null
}

/**
 * Plan 55 §3.5, §4.1, §5.6 — turns a possibly-absent `Socks5RouteConfig.onGeoFail` into a
 * concrete value, in exactly ONE place, mirroring `resolveFailClosed()` immediately below.
 * `undefined` resolves to `'report'` — the safe default per §3.5: defaulting to `'hold'` would
 * strand a device the first time a residential pool drifts one city over.
 */
function resolveOnGeoFail(config: Pick<Socks5RouteConfig, 'onGeoFail'> | undefined): 'report' | 'hold' {
  return config?.onGeoFail ?? 'report'
}

/** Budget for one `GET <geoProvider>?ip=<address>` call — a farm's own infrastructure, but still a network call this process must not hang on. */
const GEO_LOOKUP_TIMEOUT_MS = 5_000

/**
 * Calls a `network.geoProvider` endpoint for `address` and turns its response into a
 * `GeoObservation` (Plan 55 §3.2, §5.2). Returns `null` on ANY failure — unreachable provider,
 * non-200, a body that fails `GeoProviderResponseSchema` — never a guess; the caller
 * (`maybeRunGeoAndDns`) is what turns a null into the `geo`/`dns` checks' own `unknown` state.
 */
async function lookupGeo(geoProvider: string, address: string): Promise<GeoObservation | null> {
  try {
    const url = new URL(geoProvider)
    url.searchParams.set('ip', address)
    const res = await fetch(url, { signal: AbortSignal.timeout(GEO_LOOKUP_TIMEOUT_MS) })
    if (!res.ok) return null
    const parsed = GeoProviderResponseSchema.safeParse(await res.json())
    if (!parsed.success) return null
    return { address, at: nowSeconds(), ...parsed.data }
  } catch {
    return null
  }
}

/** A per-device sticky-session id (plan 52 §4.3) — generated once, kept stable thereafter. Not a secret, so a short opaque token is enough; it only has to be unlikely to collide and safe to embed in a username. */
function generateSessionId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

/**
 * Plan 54 §4.2, §5.6 — turns a possibly-absent `PersistedNetworkRoute.failClosed` into a concrete
 * boolean, in exactly ONE place, so every reader (the PUT handler persisting a value, `applyRoute`
 * resolving the wire object, the UI default Studio shows) agrees. `undefined` resolves to `true`
 * — "the safe default is the one that does not leak" (plan 54 §3.1) — for every route regardless
 * of age: a route created before this plan shipped gets the safer behaviour the next time it is
 * actually applied, not just a brand-new one, since a silent leak on an old route is exactly as
 * bad as one on a new route. An operator who wants the old tear-down behaviour back sets it to
 * `false` explicitly (`PUT /network`'s body).
 */
function resolveFailClosed(persisted: Pick<PersistedNetworkRoute, 'failClosed'> | null): boolean {
  return persisted?.failClosed ?? true
}

/**
 * Re-running an egress probe is real device network traffic, and plan 51 §9 open question 1
 * ("how often should checks re-run?") is explicitly UNRESOLVED — probing on every 20s heartbeat
 * tick was flagged there as possibly too much at fleet scale. Throttled to a multiple of the
 * heartbeat interval as a deliberate, conservative default until that question is settled;
 * `applyRoute()` always forces one fresh probe regardless (an operator who just pressed "apply"
 * should not wait out this window for a first answer).
 */
const PROBE_INTERVAL_S = 60

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Scrubs a check `detail` of two things, defensively: a `user:pass@` URL userinfo segment, and
 * any LITERAL occurrence of `secrets` — the route's own configured username/password. The latter
 * is the stronger guarantee: `RouteState.lastError()` is a Kotlin `String?` built from whatever
 * exception message the device happened to raise, with no contract that it never echoes back
 * something it was given (an upstream library could, in principle, embed connection details in
 * its own error text). Every detail built by `buildChecks()` below SHOULD already be free of one —
 * nothing on this file's own probe-error path embeds a secret, and `RouteState.describeUpstream()`
 * is host:port only — but acceptance criterion 8 (plan 51 §6) is a grep over every surface, and a
 * freeform string sourced from the device is exactly the kind of thing a future change could
 * carelessly widen. Secrets shorter than 3 characters are not scrubbed — too short to usefully
 * distinguish from ordinary text, and matching them would make ordinary details unreadable.
 */
function safeCheckDetail(detail: string | undefined, secrets: readonly string[] = []): string | undefined {
  if (detail === undefined) return undefined
  let out = detail.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//<redacted>@')
  for (const secret of secrets) {
    if (secret.length < 3) continue
    out = out.split(secret).join('<redacted>')
  }
  return out
}

/**
 * `observed.lastError` is the SAME kind of device-reported freeform string as a check `detail`
 * (`RouteState.lastError()`, a Kotlin `String?`) — acceptance criterion 8 (plan 51 §6) covers
 * "any check detail, API response, event log, or Studio view", not only the `checks` array, so
 * this scrubs it with the same `secrets` before it ever leaves `currentNetworkStatus()`.
 */
function redactObservationForResponse(observed: NetworkObservation | null, secrets: readonly string[]): NetworkObservation | null {
  if (observed === null || observed.lastError === undefined) return observed
  return { ...observed, lastError: safeCheckDetail(observed.lastError, secrets) }
}

interface ChecksInput {
  observed: NetworkObservation | null
  observedAt: number | null
  /** The entry's current apply/observe failure, if any — see `buildChecks()`'s `tunnel` handling for why this outranks `observed`. */
  lastError: { code: string; message: string } | null
  probe: EgressProbeResult | null
  probeAt: number | null
  /** A failure of the `egress.probe` WIRE CALL itself (e.g. `E_TIMEOUT` reaching the agent) — distinct from either leg inside `probe` failing, which the agent always reports as a normal (non-throwing) result. */
  probeError: { code: string; message: string } | null
  probeUrl: string | null
  /** From the device's own `hello().capabilities` — null until fetched at least once. */
  agentCapabilities: string[] | null
  /** The route's own username/password, if any — every `detail` string below is scrubbed of a literal occurrence of either (acceptance criterion 8, plan 51 §6). */
  secrets: readonly string[]
  /** Plan 55 §3.1, §4.1 — the operator's declared expectation, if any. `geo` stays `skip` forever without one (acceptance criterion 1). */
  expect: Socks5RouteConfig['expect']
  /** Plan 55 §3.2 — `network.geoProvider`, or undefined when unset. */
  geoProviderConfigured: boolean
  /** The most recent lookup for the CURRENT egress address, or null if none has run yet. */
  geoObservation: GeoObservation | null
  /** A lookup that ran and failed (unreachable provider, bad response) — distinct from never having run. */
  geoError: { code: string; message: string } | null
  /** Plan 51 §4.3, §5.3 — `network.probeDnsZone` (`ENKAKU_NETWORK_PROBE_DNS_ZONE`) configured. */
  probeDnsZoneConfigured: boolean
  /** Set by `maybeRunGeoAndDns()` once a dns check attempt has completed — `null` before the first attempt. */
  dnsResult: { state: 'pass' | 'fail' | 'unknown'; detail?: string; at: number } | null
  /** Plan 51 §4.5, §5.7 — read back from the device's own `route.status` (`Ipv6Leak.isBlocked()` on the Kotlin side). Undefined on an older agent build, or when no VPN network could be found to ask. */
  ipv6Blocked: boolean | undefined
}

/**
 * Builds the six named checks (plan 51 §4.1) from what this process currently knows about a
 * device's route. Pure — every input is a plain value already held on the route's
 * `NetworkRouteEntry`, so this is trivial to unit-test without a fake device at all.
 */
/**
 * Pulls a bare address out of whatever the probe endpoint returned. Endpoints differ — some
 * answer `{"ip":"1.2.3.4"}`, `packages/probe-server`'s own `/probe` answers `{"address":...}`,
 * some answer bare text — so this stays deliberately loose and simply reports nothing it cannot
 * recognise rather than guessing. Shared by `summariseEgress()` (a display string for the
 * `egress` check's `detail`) and `maybeRunGeoAndDns()` (the actual value handed to a geo lookup),
 * so the two never disagree about what address a probe body means.
 */
function parseEgressAddress(body: string | undefined): string | undefined {
  if (!body) return undefined
  const trimmed = body.trim().slice(0, 400)
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>
      const ip = rec.ip ?? rec.address ?? rec.origin
      if (typeof ip === 'string') return ip
    }
  } catch {
    // not JSON — fall through to the plain-text shape below
  }
  return /^[0-9a-f.:]+$/i.test(trimmed) ? trimmed : undefined
}

/** A human-readable form for the `egress` check's own `detail` — see `parseEgressAddress()` for the parsing this wraps. */
function summariseEgress(body: string | undefined): string | undefined {
  const address = parseEgressAddress(body)
  return address ? `exit address ${address}` : undefined
}

/** Renders a `GeoObservation` for a check `detail` — every field the provider could attribute, `—` for what it could not. */
function describeLocation(observed: GeoObservation): string {
  const parts = [observed.city, observed.region, observed.country].filter((v): v is string => v !== null)
  const place = parts.length > 0 ? parts.join(', ') : '—'
  const network = observed.isp ?? (observed.asn !== null ? `AS${observed.asn}` : '—')
  return `${place} (${network})`
}

function buildChecks(input: ChecksInput): RouteCheck[] {
  const checks: RouteCheck[] = []
  const now = nowSeconds()

  // Fail-closed (plan 54 §3.1, §4.1): the TUN is still established on purpose. This is NOT the
  // same fact as `tunnel: fail` (which reads as "broken") — held is reported honestly below, on
  // `upstream` and `egress`, not here. An apply/observe failure that couldn't even ask the device
  // takes priority over a stale `held` from before it, same as it already does over a stale `up`.
  const held = input.lastError === null && input.observed?.state === 'held'

  // tunnel — the device's own TUN/worker-thread state. An apply/observe failure (we could not
  // even ASK the device) outranks a stale `observed`: the honest reading of "we don't know
  // because the last attempt to find out failed" is `fail`, not a leftover `pass` from before
  // the failure started.
  if (input.lastError) {
    checks.push({ id: 'tunnel', state: 'fail', detail: safeCheckDetail(input.lastError.message, input.secrets), at: now })
  } else if (input.observed === null) {
    checks.push({ id: 'tunnel', state: 'unknown', at: null })
  } else if (held || input.observed.up) {
    checks.push({ id: 'tunnel', state: 'pass', at: input.observedAt })
  } else {
    checks.push({
      id: 'tunnel',
      state: 'fail',
      detail: safeCheckDetail(input.observed.lastError ?? 'device reports the route is not up', input.secrets),
      at: input.observedAt,
    })
  }

  const probeConfigured = input.probeUrl !== null
  const capabilitiesKnown = input.agentCapabilities !== null
  const agentSupportsProbe = input.agentCapabilities?.includes('egress-probe') ?? false
  // The `egress.probe` WIRE CALL never reached a result at all (couldn't even reach the agent) —
  // distinct from a leg inside a successful call reporting its own failure.
  const probeTransportFailed = input.probe === null && input.probeError !== null

  /**
   * Plan 54 §4.3 — a held route must never read as healthy: `upstream`/`egress` are FORCED to
   * `fail` here, ahead of whatever a probe might otherwise say. This matters because
   * `EgressProbe`'s tunnelled leg dials a FRESH SOCKS5 connection through `currentUpstream()`
   * (Kotlin), independent of the forwarding this route stopped — it could well succeed even while
   * held, and reporting that as `pass` would be exactly the "looks healthy" failure §4.3 forbids.
   */
  const heldDetail = safeCheckDetail(
    input.observed?.lastError ?? 'route is held closed on purpose — traffic is blocked, not leaking',
    input.secrets,
  )

  // upstream — only the probe's tunnelled leg can answer "did a SOCKS5 session reach and
  // authenticate with the proxy" (plan 51 §4.2): `tunnel` above only means the TUN and the
  // tunnel's worker thread started, never that any session completed a handshake.
  if (held) {
    checks.push({ id: 'upstream', state: 'fail', detail: heldDetail, at: input.observedAt })
  } else if (input.probe) {
    const leg = input.probe.tunnelled
    const failedAtConnect = !leg.ok && leg.stage === 'connect'
    checks.push({
      id: 'upstream',
      state: failedAtConnect ? 'fail' : 'pass',
      ...(failedAtConnect ? { detail: safeCheckDetail(leg.error, input.secrets) } : {}),
      at: input.probeAt,
    })
  } else if (probeTransportFailed) {
    checks.push({
      id: 'upstream',
      state: 'fail',
      detail: safeCheckDetail(input.probeError?.message, input.secrets),
      at: input.probeAt,
    })
  } else {
    checks.push({ id: 'upstream', state: 'unknown', at: null })
  }

  // egress — did the probe target answer, reached through the tunnel.
  if (held) {
    checks.push({ id: 'egress', state: 'fail', detail: heldDetail, at: input.observedAt })
  } else if (!probeConfigured) {
    checks.push({
      id: 'egress',
      state: 'skip',
      detail: 'no probe endpoint is configured (ENKAKU_NETWORK_PROBE_URL)',
      at: null,
    })
  } else if (!capabilitiesKnown) {
    checks.push({ id: 'egress', state: 'unknown', at: null })
  } else if (!agentSupportsProbe) {
    checks.push({
      id: 'egress',
      state: 'skip',
      detail: 'the installed guest agent build does not advertise the egress-probe capability',
      at: null,
    })
  } else if (input.probe) {
    const leg = input.probe.tunnelled
    checks.push({
      id: 'egress',
      state: leg.ok ? 'pass' : 'fail',
      ...(leg.ok
        ? // A bare "pass" answers the wrong question. The operator wants to know *which* address
          // the world saw, because that is the whole point of attaching a proxy — and until the
          // `geo` check exists it is the only thing that distinguishes "the tunnel works" from
          // "the tunnel works and exits where I asked". Cheap to carry, and it is what makes the
          // status page worth looking at.
          { ...(summariseEgress(leg.body) ? { detail: summariseEgress(leg.body)! } : {}) }
        : {
            detail: safeCheckDetail(
              leg.error ?? (leg.status !== undefined ? `probe target responded ${leg.status}` : 'probe target did not answer'),
              input.secrets,
            ),
          }),
      at: input.probeAt,
    })
  } else if (probeTransportFailed) {
    checks.push({
      id: 'egress',
      state: 'fail',
      detail: safeCheckDetail(input.probeError?.message, input.secrets),
      at: input.probeAt,
    })
  } else {
    checks.push({ id: 'egress', state: 'unknown', at: null })
  }

  // geo (plan 55 §4.2) — NEVER inferred from the username (a provider like SOAX encodes targeting
  // there, but that is provider-specific and guessing from it would produce confident nonsense
  // against any other provider). `skip` unless an operator has stated an expectation — acceptance
  // criterion 1: no expectation means skip, forever, never a silent pass.
  if (!input.expect) {
    checks.push({ id: 'geo', state: 'skip', detail: 'no expected region was configured for this upstream', at: null })
  } else if (held) {
    checks.push({ id: 'geo', state: 'fail', detail: heldDetail, at: input.observedAt })
  } else if (!input.geoProviderConfigured) {
    checks.push({ id: 'geo', state: 'skip', detail: 'no geo lookup provider is configured (Settings → Network → geo lookup provider URL)', at: null })
  } else if (input.geoError) {
    // Acceptance criterion 5: a failed lookup is `unknown`, never `pass`.
    checks.push({ id: 'geo', state: 'unknown', detail: safeCheckDetail(input.geoError.message, input.secrets), at: now })
  } else if (!input.geoObservation) {
    checks.push({ id: 'geo', state: 'unknown', at: null })
  } else {
    const result = matchGeoExpectation(input.expect, input.geoObservation)
    // A geo provider's fields (city/region/country/ISP) never legitimately contain a route
    // credential, but every OTHER detail string in this function is scrubbed regardless
    // (acceptance criterion 8 is a grep over every surface) — this is that same discipline
    // applied defensively rather than an admission that it could.
    const rawLocation = describeLocation(input.geoObservation)
    const locationDetail = safeCheckDetail(rawLocation, input.secrets) ?? rawLocation
    checks.push({
      id: 'geo',
      state: result.matches ? 'pass' : 'fail',
      detail: result.matches ? locationDetail : `${result.field} expected ${result.expected}, observed ${result.observed} — ${locationDetail}`,
      at: input.geoObservation.at,
    })
  }

  // dns (plan 51 §4.3, §5.3) — needs the probe endpoint's own authoritative-resolver hook AND a
  // geo provider to attribute the resolver's and the exit's networks (`maybeRunGeoAndDns()` is
  // where the actual lookups happen; this only ever reads back what it found). Held is NOT forced
  // to fail here the way `upstream`/`egress` are: DNS-leak-blocking is a property of the route's
  // OWN config (never inferred from live traffic), so a held route's last known answer is still
  // meaningful — unlike egress, there is no "looks healthy while blocked" risk to guard against.
  if (!input.probeUrl) {
    checks.push({ id: 'dns', state: 'skip', detail: 'no probe endpoint is configured (ENKAKU_NETWORK_PROBE_URL)', at: null })
  } else if (!input.probeDnsZoneConfigured) {
    checks.push({
      id: 'dns',
      state: 'skip',
      detail: 'DNS-leak detection needs a delegated zone (ENKAKU_NETWORK_PROBE_DNS_ZONE) — see packages/probe-server/README.md',
      at: null,
    })
  } else if (!input.geoProviderConfigured) {
    checks.push({
      id: 'dns',
      state: 'skip',
      detail: 'DNS-leak detection needs a geo lookup provider to attribute the resolver and exit addresses to a network (Settings → Network)',
      at: null,
    })
  } else if (!capabilitiesKnown) {
    checks.push({ id: 'dns', state: 'unknown', at: null })
  } else if (!agentSupportsProbe) {
    checks.push({
      id: 'dns',
      state: 'skip',
      detail: 'the installed guest agent build does not advertise the egress-probe capability',
      at: null,
    })
  } else if (input.dnsResult) {
    checks.push({
      id: 'dns',
      state: input.dnsResult.state,
      ...(input.dnsResult.detail ? { detail: safeCheckDetail(input.dnsResult.detail, input.secrets) } : {}),
      at: input.dnsResult.at,
    })
  } else {
    checks.push({ id: 'dns', state: 'unknown', at: null })
  }

  // leak (plan 51 §4.5, §5.7) — asserted from the device's own `route.status` (`Ipv6Leak.isBlocked()`
  // reads back `LinkProperties` rather than trusting the `Builder.addRoute("::", 0)` request).
  if (input.observed === null) {
    checks.push({ id: 'leak', state: 'unknown', at: null })
  } else if (input.ipv6Blocked === undefined) {
    checks.push({
      id: 'leak',
      state: 'skip',
      detail: 'the installed guest agent build does not report IPv6 leak status',
      at: null,
    })
  } else if (input.ipv6Blocked) {
    checks.push({ id: 'leak', state: 'pass', at: input.observedAt })
  } else {
    checks.push({ id: 'leak', state: 'fail', detail: 'IPv6 is not blocked — an app could leak traffic over IPv6', at: input.observedAt })
  }

  return checks
}

const ERROR_STATUS: Record<string, number> = {
  device_not_found: 404,
  E_BAD_REQUEST: 400,
  no_lease: 409,
  not_lease_holder: 409,
  device_busy: 409,
  device_unavailable: 409,
  E_GUEST_AGENT_APK_MISSING: 503,
  E_PORT_RANGE_EXHAUSTED: 503,
  E_TIMEOUT: 504,
  E_TRANSPORT: 502,
  E_PROTOCOL_MISMATCH: 409,
  E_UNEXPECTED_RESPONSE: 502,
  E_UNAUTHORISED: 502,
  E_UNKNOWN_METHOD: 502,
  E_NOT_PAIRED: 409,
  E_NOT_PREPARED: 409,
  E_NETWORK_APPLY_FAILED: 500,
  // A read (observe/status probe) that fails is NOT an apply failure — conflating the two would
  // make a perfectly healthy device that just failed one status poll look like a broken apply
  // (plan 44 §8b, this bugfix's "Bug 2"). `toCodedError`'s `fallbackCode` picks between this and
  // `E_NETWORK_APPLY_FAILED` depending on which kind of operation actually failed.
  E_NETWORK_OBSERVE_FAILED: 502,
  E_NO_ROUTE_CONFIG: 409,
  // Plan 54 §3.2, §4.2 — bounded automatic recovery gave up; never thrown over HTTP (it only ever
  // lands on `entry.lastError`), but coded like every other failure this file reports so it fits
  // the same `toCodedError`/`ERROR_STATUS` machinery if that ever changes.
  E_NETWORK_RECOVERY_EXHAUSTED: 503,
  // The credential store (plan 52 §4.2).
  E_CREDENTIAL_NOT_FOUND: 404,
  E_CREDENTIAL_NAME_TAKEN: 409,
  E_CREDENTIAL_IN_USE: 409,
  E_CREDENTIAL_CORRUPT: 500,
  E_CREDENTIAL_KEY_CORRUPT: 500,
}

/**
 * Where a checkout leaves its Gradle output. Tried in this order so a release build wins over a
 * stale debug one when both exist.
 */
const LOCAL_BUILD_PATHS = [
  'apps/guest-agent/app/build/outputs/apk/release/app-release.apk',
  'apps/guest-agent/app/build/outputs/apk/debug/app-debug.apk',
]

export async function resolveGuestAgentApkPath(
  opts: {
    toolchain?: { resolveToolPath(id: string): Promise<string> }
    onLog?: (level: 'warn', msg: string) => void
    /**
     * Test seam. Tier 2 scans the working directory, so a test asserting "nothing is available"
     * would otherwise pass or fail depending on whether the checkout happens to hold a Gradle
     * build — which it does the moment anyone runs `bun run build:guest-agent`.
     */
    localBuildPaths?: readonly string[]
  } = {},
): Promise<string> {
  // 1. An explicit override always wins — this is how you point a farm at a one-off build.
  const override = process.env.ENKAKU_GUEST_AGENT_PATH
  if (override) return override

  // 2. A local Gradle build, when running from a checkout. This is what makes `bun run dev` work
  //    with no configuration at all after `bun run build:guest-agent`. It cannot fire on a client
  //    server, where the compiled binary has no `apps/` directory beside it.
  //    Deliberately NOT auto-building: Gradle needs a JDK and the Android SDK and takes minutes,
  //    so having `bun run dev` silently trigger it would be worse than a clear error.
  for (const candidate of opts.localBuildPaths ?? LOCAL_BUILD_PATHS) {
    if (await Bun.file(candidate).exists()) {
      // Warn, because a stale local build silently beating a provisioned release is exactly the
      // kind of thing that wastes an afternoon.
      opts.onLog?.('warn', `using the local guest agent build at ${candidate} (dev only)`)
      return candidate
    }
  }

  // 3. The provisioned artifact: downloaded from a pinned release and sha256-verified, the same
  //    path adb and the ui-server inspector take. This is the production answer, and it becomes
  //    live once the `guest-agent` manifest entry lands (plan 43 §5.5, deferred by plan 44 §2).
  if (opts.toolchain) {
    try {
      return await opts.toolchain.resolveToolPath('guest-agent')
    } catch {
      // fall through to the error below, which says more than a provisioning failure would
    }
  }

  throw new EnkakuError(
    'E_GUEST_AGENT_APK_MISSING',
    'No guest agent APK available. Build one with `bun run build:guest-agent`, or set ENKAKU_GUEST_AGENT_PATH to an existing APK.',
  )
}

export interface GuestAgentRoutesDeps {
  db: Db
  /** CLI-level adb (install/forward/uninstall) — the same helper the session/inspector wiring uses. */
  hostAdb: (args: string[]) => Promise<string>
  /** Per-device shell exec, through the adb queue (the same shape `Transport.exec` uses). */
  exec: (serial: string, cmd: string) => Promise<ShellResult>
  apkPath: () => Promise<string>
  ports: Pick<PortAllocator, 'claim' | 'release'>
  leases: LeaseManager
  /** Where the credential store's encryption key lives (plan 52 §4.2) — `<dataDir>/network-credentials.key`, created on first use with mode 0600. */
  dataDir: string
  /** Main-stream device events: guest-agent.installed/uninstalled, network.applied/reverted. */
  record?: EventRecorder['record']
  log: Logger
  /** Test seam — defaults to the real `createGuestAgentLauncher`. */
  makeLauncher?: (row: DeviceRow) => GuestAgentLauncher
  /** Test seam — defaults to the real `createGuestAgentClient`. */
  makeClient?: (opts: GuestAgentClientOptions) => GuestAgentClient
  /**
   * Test seam. `apply()` waits for the device to confirm the route is carrying traffic, and
   * `revert()` waits for it to confirm the route is down — both real budgets measured in seconds.
   * Tests drive fakes and must not sit out either one.
   */
  routeTimings?: { applySettleTimeoutMs?: number; applySettleIntervalMs?: number; revertPollTimeoutMs?: number }
  /**
   * Plan 54 §3.2, §4.2 — the backoff (seconds) between bounded automatic-recovery attempts;
   * length is the attempt bound. Default `[5, 20, 60]` (three attempts, matching the plan's own
   * suggestion). Test seam so a test proving "gives up after N attempts" does not have to sit out
   * real wall-clock minutes.
   */
  recoveryBackoffS?: number[]
  /**
   * Plan 55 §3.2, §5.1 — the geo-lookup half of `FarmSettingsSchema.network`, read fresh on every
   * call (mirrors `settingsStore.get()`'s own always-current contract — this is a getter, not a
   * snapshot). Optional so every existing test/call site that has no opinion keeps compiling
   * unchanged; defaults internally to `{ geoIntervalSec: 300 }` (no provider configured), the
   * same "unset means the check stays skip" reading `probeUrl()` gives an absent env var.
   */
  networkSettings?: () => { geoProvider?: string; geoIntervalSec: number }
}

export interface GuestAgentRoutesHandle {
  routes: Hono<AuthEnv>
  /**
   * Tears down any applied network route for a device, idempotently.
   *
   * A route is a property of the DEVICE now, not of whoever holds the lease
   * (plan 52 §0, §3.1 — superseding plan 44 §5.7's lease-scoped teardown):
   * this is called ONLY for an operator's explicit act — `/disable`,
   * `DELETE /network`, and `DELETE /guest-agent` (uninstall) — never
   * automatically on lease release/expiry/disconnect, and never on the
   * device going offline (see `handleDeviceOffline` below for that case).
   * `actor` is `null` only for the uninstall path's own internal call,
   * matching the device event log's convention for "the core did this, not
   * a user" — every other caller passes the real actor.
   */
  revertNetwork: (deviceId: string, actor?: string | null) => Promise<void>
  /**
   * A device just came back online with a persisted `enabled: true` route
   * (plan 52 §4.1, §5.3) — probes it (never blindly re-applies, §3.2) and
   * reconciles in-memory state. A no-op for a device with no route, or one
   * whose route is disabled. Also what `reconcileNetworkRoutes` below calls
   * per-row for "core start" restoration.
   */
  restoreDeviceRoute: (deviceId: string) => Promise<void>
  /**
   * A device just went offline (plan 52 §4.1). The stored route is left
   * exactly as it is — nothing is torn down on the device, because nothing
   * can be reached to tear down — but any live session/port this process
   * was holding for it is released (it is now talking to nothing), and
   * every check is marked `unknown` rather than left showing a stale `pass`
   * from before the disconnect.
   */
  handleDeviceOffline: (deviceId: string) => Promise<void>
  /**
   * Restores every device with a persisted `enabled: true` route (plan 52
   * §4.1: "core start | restore for every device with a route") — run
   * automatically, fire-and-forget, once at construction (this IS "on
   * boot", since `daemon.ts` builds this exactly once at startup). Exposed
   * here so a test can await it deterministically instead of racing that
   * fire-and-forget call.
   */
  reconcileNetworkRoutes: () => Promise<void>
}

export function createGuestAgentRoutes(deps: GuestAgentRoutesDeps): GuestAgentRoutesHandle {
  const app = new Hono<AuthEnv>()
  const { db } = deps
  /** The named-credential store (plan 52 §4.2) — every route below that touches a secret goes through this, never the raw DB row. */
  const credentials = createCredentialStore({ db, dataDir: deps.dataDir })
  /** See `GuestAgentRoutesDeps.networkSettings`'s doc comment for the default's meaning. */
  const networkSettings: () => { geoProvider?: string; geoIntervalSec: number } = deps.networkSettings ?? (() => ({ geoIntervalSec: 300 }))

  const makeLauncher =
    deps.makeLauncher ??
    ((row: DeviceRow): GuestAgentLauncher =>
      createGuestAgentLauncher({
        serial: row.serial,
        exec: (cmd) => deps.exec(row.serial, cmd),
        hostAdb: deps.hostAdb,
        apkPath: deps.apkPath,
        onLog: (level, msg) => deps.log[level](msg),
      }))
  const makeClient = deps.makeClient ?? createGuestAgentClient

  const mustGet = (id: string): DeviceRow => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
    return row
  }

  /**
   * There is no HTTP-native notion of "which browser tab is calling" here —
   * unlike `adb-endpoint.ts`/`transfer.ts`, the Studio Guest Agents page
   * (already built, plan 44 §4.6) calls these exact endpoints with no
   * `clientId` in the body. Passing the CURRENT lease's own holder through
   * `checkInputAllowed` reuses its device-status and "a manual lease is
   * genuinely held" checks (the same gate input and shell use) without
   * inventing a parallel policy — it can never fail on "wrong holder" since
   * the holder passed through is whatever is already on record.
   */
  function requireHeldLease(deviceId: string): void {
    const lease = deps.leases.getLease(deviceId)
    const allowed = deps.leases.checkInputAllowed(deviceId, lease?.holder ?? '')
    if (!allowed.ok) throw new EnkakuError(allowed.code, allowed.message)
  }

  /**
   * `fallbackCode` lets each call site say what KIND of operation failed (apply vs. observe) for
   * an error this file cannot otherwise put a code on — a `GuestAgentClientError` or `EnkakuError`
   * always carries its own code regardless of `fallbackCode` (plan 44 §8b, "Bug 2": a read that
   * fails must never be reported as an apply failure).
   */
  function toCodedError(err: unknown, fallbackCode: string): { code: string; message: string } {
    if (err instanceof GuestAgentClientError) return { code: err.code, message: err.message }
    if (err instanceof EnkakuError) return { code: err.code, message: err.message }
    if (err instanceof Error) return { code: fallbackCode, message: err.message }
    return { code: fallbackCode, message: String(err) }
  }

  /**
   * The set of `GuestAgentClientError` codes that mean "the agent forgot this token" (a genuine
   * on-device restart) rather than "the agent is unreachable" — the only codes a `DeviceSession`
   * treats as worth one re-bootstrap (plan 44 §8b, "Bug 1").
   */
  const REAUTH_CODES = new Set(['E_UNAUTHORISED', 'E_NOT_PAIRED'])

  /**
   * A per-device guest-agent session: owns the token, the forwarded port, and the client, all
   * lazily created on first use and reused by EVERY operation on that device — `apply`, `observe`,
   * `revert`, a guest-agent status probe, the heartbeat. This is the fix for plan 44 §8b's "Bug 1"
   * (three independent call sites used to each mint their own token, invalidating each other's
   * live client) — every path in this file now goes through `getOrCreateSession`/
   * `withEphemeralSession` below instead of calling `launcher.bootstrap()` directly.
   *
   * Mirrors `createGuestAgentSession` in
   * `packages/drivers/src/network/guest-agent/vpn-helper.ts` (kept here rather than imported:
   * `@enkaku/drivers`'s package `exports` map only exposes its `.` entry point, and that file's
   * own copy exists to be the driver layer's own tested, documented reference — see its doc
   * comment). If the two ever drift, this one is the one actually wired into production, since
   * `createVpnHelperRoute` below is only ever given a session built by `makeSession`.
   */
  interface DeviceSessionCallOpts {
    handshakeRetries?: number
    handshakeRetryDelayMs?: number
  }

  interface DeviceSession {
    withClient<T>(fn: (client: GuestAgentClient) => Promise<T>, opts?: DeviceSessionCallOpts): Promise<T>
    readonly active: boolean
    close(): Promise<void>
  }

  function createDeviceSession(opts: {
    launcher: GuestAgentLauncher
    client: (o: { port: number; token: string } & DeviceSessionCallOpts) => GuestAgentClient
    claimPort: () => Promise<number>
    releasePort: (port: number) => void
    deviceId: string
  }): DeviceSession {
    let port: number | null = null
    let client: GuestAgentClient | null = null
    // Coalesces concurrent first-use (or concurrent re-auth) calls onto ONE in-flight bootstrap —
    // without this, two callers racing `withClient()` before either has set `client` would each
    // start their OWN bootstrap and mint TWO tokens, reintroducing the exact race plan 44 §8b's
    // "Bug 1" is about.
    let inFlight: Promise<GuestAgentClient> | null = null

    async function bootstrap(callOpts: DeviceSessionCallOpts | undefined): Promise<GuestAgentClient> {
      await opts.launcher.ensurePreGranted()
      // Fresh on every (re-)bootstrap, never pre-emptively for a call that can just reuse the
      // already-live client (plan 44 §8b, "Bug 1").
      const token = crypto.randomUUID()
      if (port === null) port = await opts.claimPort()
      await opts.launcher.bootstrap(token)
      await opts.launcher.forward(port)
      const newClient = opts.client({ port, token, ...callOpts })
      // Refuse a protocol mismatch rather than degrade (CLAUDE.md, plan 44 §5.5's client.ts).
      await newClient.hello()
      client = newClient
      return newClient
    }

    /**
     * Synchronous on purpose (not `async`): the `client`/`inFlight` check-and-set below must run
     * to completion before this returns control to the event loop, or two calls issued
     * back-to-back would each see both still null and each start their own bootstrap.
     */
    function ensureClient(callOpts: DeviceSessionCallOpts | undefined): Promise<GuestAgentClient> {
      if (client) return Promise.resolve(client)
      if (!inFlight) {
        inFlight = bootstrap(callOpts).finally(() => {
          inFlight = null
        })
      }
      return inFlight
    }

    return {
      get active() {
        return client !== null
      },
      async withClient(fn, callOpts) {
        const current = await ensureClient(callOpts)
        try {
          return await fn(current)
        } catch (err) {
          if (!(err instanceof GuestAgentClientError) || !REAUTH_CODES.has(err.code)) throw err
          // The agent answered but does not recognise this token — the on-device process
          // genuinely restarted (crash, force-stop, reboot). Rotate exactly once here, never
          // pre-emptively, so every other caller sharing this session sees the SAME re-bootstrap
          // instead of racing to mint its own (plan 44 §8b, "Bug 1"). Only clear `client` if
          // nothing else already replaced it — a concurrent caller may have already rotated onto
          // a fresh one while this call was awaiting `fn`.
          if (client === current) {
            deps.log.warn(
              `guest-agent session[${opts.deviceId}]: ${err.code} — the agent forgot this token, re-bootstrapping once`,
            )
            client = null
          }
          const fresh = await ensureClient(callOpts)
          return await fn(fresh)
        }
      },
      async close() {
        client = null
        const held = port
        port = null
        if (held === null) return
        try {
          await opts.launcher.removeForward(held)
        } catch (err) {
          deps.log.warn(`guest-agent session[${opts.deviceId}] close(): removeForward failed, tolerated: ${String(err)}`)
        }
        opts.releasePort(held)
      },
    }
  }

  /** Builds a fresh `DeviceSession` for `row`, sharing `launcher` if the caller already has one (avoids constructing a second, functionally-identical launcher instance). */
  function makeSession(row: DeviceRow, launcher: GuestAgentLauncher = makeLauncher(row)): DeviceSession {
    return createDeviceSession({
      launcher,
      client: (o) => makeClient({ ...o, onLog: (level, msg) => deps.log[level](msg) }),
      claimPort: async () => {
        try {
          return await deps.ports.claim(row.id)
        } catch (err) {
          throw new EnkakuError('E_PORT_RANGE_EXHAUSTED', err instanceof Error ? err.message : String(err))
        }
      },
      releasePort: (port) => deps.ports.release(port),
      deviceId: row.id,
    })
  }

  /**
   * Runs `fn` against `row`'s shared device session — reusing the one already backing an applied
   * network route (`networkStateByDevice.get(row.id)?.session`) when there is one, exactly the fix
   * for plan 44 §8b's "Bug 1": a guest-agent status probe or a cold network read must never mint a
   * SEPARATE token that rotates the live route's token out from under it. When no route is applied
   * for this device, a fresh session is built, used once, and closed again — never held across
   * calls for a device with no applied route (this file's own port-allocator contract).
   */
  async function withEphemeralSession<T>(
    row: DeviceRow,
    fn: (client: GuestAgentClient) => Promise<T>,
    opts?: DeviceSessionCallOpts,
  ): Promise<T> {
    const shared = networkStateByDevice.get(row.id)?.session
    if (shared) return shared.withClient(fn, opts)
    const session = makeSession(row)
    try {
      return await session.withClient(fn, opts)
    } finally {
      await session.close()
    }
  }

  // ---- guest-agent status / install / uninstall ----

  function unsupportedResult(apiLevel: number): GuestAgentStatusResult {
    return {
      state: 'unsupported',
      reason: `Android API ${apiLevel} is below ${MIN_SUPPORTED_SDK} (Android 10) — the guest agent needs VpnService behaviour only proven from API ${MIN_SUPPORTED_SDK} onward (plan 44 §5.1)`,
    }
  }

  /**
   * Hello over `row`'s shared device session (plan 44 §8b, "Bug 1" — no bootstrap of its own
   * here). Reuses the session already backing an applied network route when there is one;
   * otherwise builds an ephemeral one that is closed again right after, never held between
   * requests (only an APPLIED NETWORK ROUTE keeps a session/port alive across calls — see
   * `NetworkRouteEntry` below). Distinguishes `installed` (something before the handshake failed
   * — app-op, bootstrap, or the forward's ownership check) from `unreachable` (the handshake
   * itself, over an established forward, did not succeed) by whether the failure is a
   * `GuestAgentClientError` — the only kind `client.hello()` ever throws.
   */
  async function probeReachability(row: DeviceRow, handshakeRetries: number): Promise<GuestAgentStatusResult> {
    try {
      const hello = await withEphemeralSession(row, (client) => client.hello(), {
        handshakeRetries,
        handshakeRetryDelayMs: 300,
      })
      return { state: 'ready', appVersion: hello.appVersion, androidSdkInt: hello.androidSdkInt, capabilities: hello.capabilities }
    } catch (err) {
      if (err instanceof GuestAgentClientError) return { state: 'unreachable', reason: err.message }
      // A coded host-side failure (e.g. `E_PORT_RANGE_EXHAUSTED` from `claimPort`) is a genuine
      // error, not "the app-op grant/bootstrap silently failed" — let it propagate so `app.onError`
      // maps it to the right status, rather than mislabelling it `installed`.
      if (err instanceof EnkakuError) throw err
      return { state: 'installed' }
    }
  }

  async function installAndProbe(row: DeviceRow): Promise<GuestAgentStatusResult> {
    if (row.apiLevel !== null && row.apiLevel < MIN_SUPPORTED_SDK) return unsupportedResult(row.apiLevel)
    const launcher = makeLauncher(row)
    await launcher.ensureInstalled()
    return probeReachability(row, INSTALL_HANDSHAKE_RETRIES)
  }

  async function statusOf(row: DeviceRow): Promise<GuestAgentStatusResult> {
    if (row.apiLevel !== null && row.apiLevel < MIN_SUPPORTED_SDK) return unsupportedResult(row.apiLevel)
    const launcher = makeLauncher(row)
    if (!(await launcher.isInstalled())) return { state: 'not-installed' }
    return probeReachability(row, STATUS_HANDSHAKE_RETRIES)
  }

  app.get('/:id/guest-agent', async (c) => {
    const row = mustGet(c.req.param('id'))
    return c.json(await statusOf(row))
  })

  app.post('/:id/guest-agent', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireHeldLease(row.id)
    const result = await installAndProbe(row)
    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'guest-agent.installed',
      actor: c.get('user')?.id ?? null,
      meta: { state: result.state },
    })
    return c.json(result)
  })

  app.delete('/:id/guest-agent', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireHeldLease(row.id)
    const actor = c.get('user')?.id ?? null
    // Any active route is torn down first (Studio's own uninstall confirm
    // dialog already says so) — reinstalling later starts from scratch.
    await revertNetwork(row.id, actor)
    // Clear the PERSISTED route too, not just the live one. Leaving `enabled: true` pointed at a
    // package that no longer exists is incoherent, and it actively fights the operator: the
    // reconcile/heartbeat loop keeps trying to reach an agent that is gone, and the provisioning
    // path puts it back — so the app reappears on screen seconds after an uninstall, the VPN key
    // icon returns, and the device stays without usable internet. Observed exactly that way.
    writePersistedRoute(row.id, null)
    maybeStopHeartbeat()
    const launcher = makeLauncher(row)
    await launcher.stop().catch(() => undefined)
    await deps.hostAdb(['-s', row.serial, 'uninstall', GUEST_AGENT_PACKAGE]).catch(() => undefined)
    deps.record?.({ deviceId: row.id, stream: 'main', kind: 'guest-agent.uninstalled', actor, meta: {} })
    return c.json({ ok: true })
  })

  // ---- named credentials (plan 52 §4.2, §5.1) ----
  //
  // Mounted under `/api/devices` (same as everything else in this file) rather than a dedicated
  // top-level prefix — `packages/core/src/server/http.ts`, which owns route mounting, is outside
  // this pass's file allowlist. `/network/credentials` cannot collide with the `/:id/...`
  // device-scoped routes below: no device route has a literal second path segment of
  // `credentials`.

  app.get('/network/credentials', requirePermission('device.network'), (c) => {
    return c.json(credentials.list())
  })

  app.post('/network/credentials', requirePermission('device.network'), async (c) => {
    const parsed = CreateNetworkCredentialRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const actor = c.get('user')?.id ?? null
    const created: NetworkCredential = credentials.create({
      name: parsed.data.name,
      username: parsed.data.username,
      secret: parsed.data.secret,
      createdBy: actor,
    })
    return c.json(created, 201)
  })

  app.delete('/network/credentials/:name', requirePermission('device.network'), (c) => {
    credentials.remove(c.req.param('name'))
    return c.json({ ok: true })
  })

  // ---- network route ----

  /**
   * One device's in-memory record of a `vpn-helper` route (plan 44 step 5.4).
   * The durable source of truth for `config`/`enabled` is now
   * `devices.network_route` (`readPersistedRoute`/`writePersistedRoute`
   * below) — this map only holds what cannot survive a restart: the live
   * driver object, its backing session, and the last thing it reported.
   */
  interface NetworkRouteEntry {
    /**
     * The live `NetworkRoute` for a route this PROCESS itself applied (via
     * PUT or `/enable`) — null for a "cold" entry adopted from persisted
     * state without calling `apply()` (boot reconciliation, or a heartbeat
     * probe for a route this process never itself brought up). `apply()`
     * always calls `route.start`, so reusing it here would silently reapply
     * a route the operator may have turned off from Android Settings — see
     * `coldProbe`'s doc comment.
     */
    route: NetworkRoute | null
    /**
     * The `DeviceSession` backing `route` — non-null exactly when `route` is (they are always set
     * together). `withEphemeralSession` reuses THIS session for a guest-agent status probe or a
     * cold network read on the same device (plan 44 §8b, "Bug 1"), instead of minting a second,
     * conflicting token. Null for a cold entry, which claims and releases its own ephemeral
     * session per probe instead (same as `probeReachability` above), so a device with no applied
     * route never holds a port between calls.
     */
    session: DeviceSession | null
    observed: NetworkObservation | null
    /** Unix seconds `observed` was last actually refreshed — feeds `tunnel`'s `at` (plan 51 §4.1). */
    observedAt: number | null
    health: 'ok' | 'unverified' | 'degraded' | 'unknown'
    /** The named facts `health` was derived from — recomputed by `recomputeChecks()` every time `observed`/`probeResult`/`lastError` changes. */
    checks: RouteCheck[]
    lastError: { code: string; message: string } | null
    /** Result of the most recent `egress.probe` wire call, or null if one has never completed. */
    probeResult: EgressProbeResult | null
    /** Unix seconds `probeResult` (or `probeError`) was last set. */
    probeAt: number | null
    /** The most recent `egress.probe` WIRE CALL failure (agent unreachable, timed out) — distinct from a leg inside `probeResult` reporting its own failure, which is never an error the agent throws. */
    probeError: { code: string; message: string } | null
    /** From the device's own `hello().capabilities`, refreshed opportunistically — null until fetched at least once. */
    agentCapabilities: string[] | null
    /** Plan 55 §3.2, §4.2, §5.3 — the most recent geo lookup for the CURRENT egress address, or null if none has run yet (no geo provider configured, or no successful probe to look up). */
    geoObservation: GeoObservation | null
    /** Unix seconds `geoObservation` (or `geoError`) was last set. */
    geoAt: number | null
    /** A geo lookup that ran and failed — distinct from never having run (plan 55 §4.2: "lookup failed → unknown, never pass"). */
    geoError: { code: string; message: string } | null
    /** Plan 51 §4.3, §5.3 — the `dns` check's own most recent result, computed by `maybeRunGeoAndDns()`. Null before the first attempt. */
    dnsResult: { state: 'pass' | 'fail' | 'unknown'; detail?: string; at: number } | null
  }

  const networkStateByDevice = new Map<string, NetworkRouteEntry>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // ---- bounded recovery (plan 54 §3.2, §4.2) ----
  //
  // Deliberately NOT stored on `NetworkRouteEntry`: `coldProbe()` below replaces that object
  // wholesale on every call (a fresh cold probe every heartbeat tick, for a device this process
  // holds no live route for), which would silently reset any counter kept on it. This map is the
  // one thing that survives across those replacements, and it is the ONLY place either
  // `restoreDeviceRoute` or `heartbeatTick` may attempt a recovery apply from — "one owner, one
  // counter" (plan 54 §4.2) means both call the SAME `maybeRecoverRoute` against the SAME entry
  // here, never their own independent retry loop.
  const recoveryBackoffS = deps.recoveryBackoffS ?? [5, 20, 60]
  const RECOVERY_MAX_ATTEMPTS = recoveryBackoffS.length
  /** `recoveryBackoffS[i]`, clamped to the last entry (or 0 for a caller-supplied empty schedule) — `noUncheckedIndexedAccess` requires this even though `i` is always in bounds for every call site below. */
  function backoffAt(i: number): number {
    return recoveryBackoffS[i] ?? recoveryBackoffS[recoveryBackoffS.length - 1] ?? 0
  }

  interface RecoveryState {
    attempts: number
    /** Unix seconds; an attempt before this time is skipped (the backoff between attempts). */
    nextAttemptAt: number
    /** The bound was reached without success — stop retrying, and a check now says why (plan 54 §3.2 "bound it": silent infinite retry against a broken proxy is its own failure mode). */
    exhausted: boolean
    /** Set alongside `exhausted` — re-applied to the entry on every subsequent tick (see below), since a cold probe would otherwise overwrite it with its own `lastError: null` before the next `maybeRecoverRoute` call ever runs. */
    exhaustedMessage: string | null
    /** True while an attempt is actually in flight — guards against `restoreDeviceRoute` and `heartbeatTick` racing onto two concurrent applies for the same device. */
    pending: boolean
  }
  const recoveryByDevice = new Map<string, RecoveryState>()

  function resetRecovery(deviceId: string): boolean {
    return recoveryByDevice.delete(deviceId)
  }

  /**
   * The one place either `restoreDeviceRoute` or `heartbeatTick` may attempt a recovery apply
   * (plan 54 §4.2) — `entry` must already reflect this tick's own probe/observe, since this never
   * probes on its own. A no-op when the device already carries its route (probed and left alone,
   * plan 52 §3.2 / plan 54 acceptance #6), when a bound-reached device is still cooling down, or
   * when another call already has an attempt in flight for this device.
   */
  async function maybeRecoverRoute(row: DeviceRow, persisted: PersistedNetworkRoute, entry: NetworkRouteEntry): Promise<void> {
    const deviceId = row.id
    if (entry.observed?.up === true) {
      // Already carrying its route — never re-applied (plan 52 §3.2, plan 54 acceptance #6).
      if (resetRecovery(deviceId)) deps.log.info(`network restore: device ${deviceId} recovered`)
      else deps.log.info(`network restore: device ${deviceId} already carries its route — probed and left alone`)
      return
    }

    const now = nowSeconds()
    let r = recoveryByDevice.get(deviceId)
    if (!r) {
      // Waits `recoveryBackoffS[0]` before the FIRST attempt too, not just between retries — a
      // device that just reconnected may still be settling (the same reasoning `applySettleTimeoutMs`
      // already applies to a fresh apply), and hammering it the instant it is noticed down serves
      // nobody.
      r = { attempts: 0, nextAttemptAt: now + backoffAt(0), exhausted: false, exhaustedMessage: null, pending: false }
      recoveryByDevice.set(deviceId, r)
    }
    if (r.exhausted) {
      // `entry` reflects THIS tick's own fresh probe/observe (a cold probe's own successful read
      // sets `lastError: null`), which would silently erase the "gave up" answer the very next
      // tick if this did not re-apply it — acceptance criterion 5 ("says why") means this stays
      // visible for as long as the bound stays reached, not just the one tick it was first hit.
      if (r.exhaustedMessage) {
        entry.lastError = { code: 'E_NETWORK_RECOVERY_EXHAUSTED', message: r.exhaustedMessage }
        recomputeChecks(entry, persisted.config)
      }
      return
    }
    if (r.pending) return
    if (now < r.nextAttemptAt) return

    r.pending = true
    r.attempts += 1
    const attempt = r.attempts
    deps.log.info(
      `network restore: device ${deviceId} is not carrying its route (attempt ${attempt}/${RECOVERY_MAX_ATTEMPTS}) — applying`,
    )
    try {
      // `actor: null` — this is the core acting on its own, not a user (matches `revertNetwork`'s
      // own convention for its internal uninstall call).
      await applyRoute(row, persisted.config, null)
      // `applyRoute`/`vpn-helper.ts`'s `apply()` does NOT throw just because the device never
      // reaches `up` within its own settle window — it "gives up quietly rather than failing an
      // apply that may yet succeed" (that file's own doc comment) — so a bare absence-of-throw
      // here is NOT proof of recovery. Confirming `observed.up` is what stops a permanently-held
      // device from being declared "recovered" forever while still not carrying traffic
      // (acceptance criterion 5: the bound must hold even when `route.start` keeps being
      // accepted).
      const settled = networkStateByDevice.get(deviceId)
      if (settled?.observed?.up !== true) {
        throw new EnkakuError('E_NETWORK_APPLY_FAILED', 'applied, but the device still does not report the route up')
      }
      recoveryByDevice.delete(deviceId)
      deps.log.info(`network restore: device ${deviceId} recovered on attempt ${attempt}`)
    } catch (err) {
      if (attempt >= RECOVERY_MAX_ATTEMPTS) {
        r.exhausted = true
        r.exhaustedMessage = `automatic recovery gave up after ${RECOVERY_MAX_ATTEMPTS} attempts; the route stays enabled — apply manually once the upstream is reachable`
        deps.log.warn(`network restore: device ${deviceId}: ${r.exhaustedMessage} (${err instanceof Error ? err.message : String(err)})`)
        // `applyRoute` already set its own entry's `lastError` to the raw apply failure — this
        // OVERWRITES it with the "gave up" message, since that is now the more honest answer to
        // "why isn't this routed": not just that the last attempt failed, but that no more will be
        // made without an operator. Re-fetched rather than using the `entry` this function was
        // called with: `applyRoute` may have replaced `networkStateByDevice`'s value with a fresh
        // entry (a cold entry adopting a live `route` for the first time), and writing to a stale
        // reference would land on an object nothing reads any more.
        const live = networkStateByDevice.get(deviceId)
        if (live) {
          live.lastError = { code: 'E_NETWORK_RECOVERY_EXHAUSTED', message: r.exhaustedMessage }
          recomputeChecks(live, persisted.config)
        }
      } else {
        // `backoffAt(attempt)`, not `(attempt - 1)` — index 0 already paid for the wait before
        // THIS attempt; the wait before the NEXT one is the following entry in the schedule
        // (attempt 1 failing schedules attempt 2 after index 1, i.e. 20s of the suggested
        // 5s/20s/60s).
        const delayS = backoffAt(attempt)
        r.nextAttemptAt = nowSeconds() + delayS
        deps.log.warn(`network restore: device ${deviceId} attempt ${attempt} failed, retrying in ${delayS}s: ${String(err)}`)
      }
    } finally {
      r.pending = false
    }
  }

  /**
   * Reads `devices.network_route`, Zod-validated (CLAUDE.md: never trust a
   * JSON DB column). A row that fails validation is treated as "no route"
   * rather than thrown — an old/corrupt value must not 500 every `GET`.
   */
  function readPersistedRoute(row: DeviceRow): PersistedNetworkRoute | null {
    if (row.networkRoute === null || row.networkRoute === undefined) return null
    const parsed = PersistedNetworkRouteSchema.safeParse(row.networkRoute)
    if (!parsed.success) {
      deps.log.warn(`device ${row.id}: stored network route failed validation, treating as none: ${parsed.error.message}`)
      return null
    }
    return parsed.data
  }

  function writePersistedRoute(deviceId: string, value: PersistedNetworkRoute | null): void {
    db.update(devices).set({ networkRoute: value }).where(eq(devices.id, deviceId)).run()
  }

  /**
   * Moves every device's inline `username`/`password` (plan 44's original, pre-credential-store
   * shape) into a named credential, rewriting `config` to reference it by `credentialRef` instead
   * (plan 52 §4.2, §5.1's migration — "nothing is lost"). Runs SYNCHRONOUSLY, once, at
   * construction, before anything else in this module ever reads a persisted route — the
   * fire-and-forget boot reconciliation below included — so no code path can observe a
   * pre-migration row with a raw password sitting in `config`.
   *
   * Idempotent: a row with no inline `username`/`password` (either because it never had any, or
   * because a previous run of this exact migration already rewrote it) is left untouched.
   */
  function migrateInlineCredentials(): void {
    const rows = db.select().from(devices).all()
    for (const row of rows) {
      const persisted = readPersistedRoute(row)
      if (!persisted) continue
      const { config } = persisted
      if (config.credentialRef || (config.username === undefined && config.password === undefined)) continue
      const name = credentials.uniqueName(`migrated-${row.id}`)
      credentials.create({ name, username: config.username, secret: config.password ?? '', createdBy: null })
      writePersistedRoute(row.id, {
        ...persisted,
        config: { host: config.host, port: config.port, udpMode: config.udpMode, credentialRef: name },
      })
      deps.log.info(`network: migrated device ${row.id}'s inline credentials into a named credential ("${name}")`)
    }
  }
  migrateInlineCredentials()

  function toConfigResponse(config: Socks5RouteConfig): NetworkStatusResult['config'] {
    return {
      host: config.host,
      port: config.port,
      // `credentialRef` names a stored credential (plan 52 §4.2) — never a username or password.
      // A pre-migration row can still carry inline `username` until the boot-time migration
      // rewrites it; deliberately NOT surfaced here even then; `migrateInlineCredentials()` runs
      // before this can ever be reached in practice, and this is the belt to its braces.
      ...(config.credentialRef !== undefined ? { credentialRef: config.credentialRef } : {}),
      udpMode: config.udpMode,
      // Plan 55 §4.1, §4.4 — no credential to redact in either field, unlike everything above.
      ...(config.expect !== undefined ? { expect: config.expect } : {}),
      onGeoFail: resolveOnGeoFail(config),
    }
  }

  /** `config` and `observed` disagree while the route is meant to be on — the whole point of keeping `enabled`/`observed` separate (plan 44 §4.6, step 5.4). Never true while `enabled` is false: a route the operator turned off is not "drifting" just because it is down. */
  function computeDrift(config: Socks5RouteConfig, enabled: boolean, observed: NetworkObservation | null): boolean {
    if (!enabled) return false
    if (!observed) return false
    if (!observed.up) return true
    if (observed.upstream && observed.upstream !== `${config.host}:${config.port}`) return true
    return false
  }

  /**
   * The literal secret strings a check `detail` must never contain (acceptance criterion 8, plan
   * 51 §6; plan 52 §4.2 for the credential-store path). `config` may be the DECLARED shape
   * (`credentialRef`, no inline password — the normal case since plan 52) or, for a pre-migration
   * row this process has not yet rewritten, the legacy inline shape — both are covered. Resolving
   * `credentialRef` is a local decrypt, not a network call, so doing it here (on every
   * `recomputeChecks`) is cheap; a lookup failure (the credential vanished) is tolerated — a
   * missing credential is `applyRoute`'s problem to fail loudly, not this function's.
   */
  function secretsFor(config?: Socks5RouteConfig): string[] {
    if (!config) return []
    if (config.credentialRef) {
      try {
        const cred = credentials.resolve(config.credentialRef)
        return [cred.username, cred.password].filter((s): s is string => s !== undefined)
      } catch {
        return []
      }
    }
    return [config.username, config.password].filter((s): s is string => s !== undefined)
  }

  /**
   * Recomputes `entry.checks`/`entry.health` from whatever the entry currently holds
   * (`observed`, `lastError`, `probeResult`, `probeError`, `agentCapabilities`) — the ONE place
   * `health` is ever set (plan 51 §4.1: derived, never stored directly). Call this after
   * mutating any of those fields, not before.
   *
   * `config` is the route's CURRENT persisted config (undefined for a cold entry with none) —
   * `secretsFor()` above is what `buildChecks()` scrubs from every `detail` string with.
   */
  function recomputeChecks(entry: NetworkRouteEntry, config?: Socks5RouteConfig): void {
    entry.checks = buildChecks({
      observed: entry.observed,
      observedAt: entry.observedAt,
      lastError: entry.lastError,
      probe: entry.probeResult,
      probeAt: entry.probeAt,
      probeError: entry.probeError,
      probeUrl: probeUrl(),
      agentCapabilities: entry.agentCapabilities,
      secrets: secretsFor(config),
      expect: config?.expect,
      geoProviderConfigured: networkSettings().geoProvider !== undefined,
      geoObservation: entry.geoObservation,
      geoError: entry.geoError,
      probeDnsZoneConfigured: probeDnsZone() !== null,
      dnsResult: entry.dnsResult,
      ipv6Blocked: entry.observed?.ipv6Blocked,
    })
    entry.health = deriveHealth(entry.checks)
  }

  /** Best-effort: a capability refresh failing must never fail the caller (`applyRoute`/`heartbeatTick`) — a later `observe()`/`probe()` call on the same session will surface a genuine transport failure on its own. */
  async function refreshAgentCapabilities(entry: NetworkRouteEntry): Promise<void> {
    if (!entry.session) return
    try {
      const hello = await entry.session.withClient((client) => client.hello())
      entry.agentCapabilities = hello.capabilities
    } catch {
      // best-effort — see doc comment above
    }
  }

  /**
   * Runs an egress probe for `entry` if a probe endpoint is configured (`probeUrl()`) and the
   * device's agent build advertises the capability, throttled to `PROBE_INTERVAL_S` unless
   * `force` — see `PROBE_INTERVAL_S`'s doc comment for why re-running on every heartbeat tick is
   * not the default. Never throws: a probe call that cannot even reach the agent is recorded on
   * `entry.probeError`, which `buildChecks()` turns into a `fail` on `upstream`/`egress` rather
   * than propagating and failing whatever unrelated operation triggered this.
   */
  async function maybeRunProbe(entry: NetworkRouteEntry, route: NetworkRoute, force: boolean): Promise<void> {
    const url = probeUrl()
    if (!url || !route.probe) return
    if (entry.agentCapabilities === null) await refreshAgentCapabilities(entry)
    if (!entry.agentCapabilities?.includes('egress-probe')) return
    const now = nowSeconds()
    if (!force && entry.probeAt !== null && now - entry.probeAt < PROBE_INTERVAL_S) return
    try {
      entry.probeResult = await route.probe(url, PROBE_TIMEOUT_MS)
      entry.probeError = null
    } catch (err) {
      entry.probeError = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
      // The previous result (if any) is now stale evidence of a route that may have changed —
      // clear it rather than let `buildChecks()` keep reporting an egress `pass` from before
      // this failure started.
      entry.probeResult = null
    }
    entry.probeAt = nowSeconds()
  }

  /**
   * Plan 55 §3.4, §4.2, §4.3, §5.3, §5.4, §5.6 — the `geo`/`dns` checks' own I/O, sharing
   * `maybeRunProbe`'s throttle-and-force pattern but on `network.geoIntervalSec`'s own slower
   * cadence ("a residential pool moves... an egress probe every 20s per device is real traffic
   * and cost at fleet scale" — Plan 51 §9 Q1, Plan 55 §3.4). Called AFTER `maybeRunProbe` at
   * every one of its call sites, so it always has that tick's freshest egress address to work
   * from. Never throws — every failure lands on `entry.geoError`/`entry.dnsResult`, which
   * `buildChecks()` turns into `unknown`, never a false `pass`.
   */
  async function maybeRunGeoAndDns(row: DeviceRow, config: Socks5RouteConfig, entry: NetworkRouteEntry, route: NetworkRoute, force: boolean): Promise<void> {
    const net = networkSettings()
    const now = nowSeconds()
    if (!force && entry.geoAt !== null && now - entry.geoAt < net.geoIntervalSec) return

    // Nothing to look up without BOTH a provider and a fresh egress address — leave whatever
    // `entry.geoObservation` already holds untouched rather than clearing it (a momentary probe
    // miss should not erase the last confirmed sighting), and never advance `geoAt` so the next
    // tick tries again promptly instead of waiting out the full interval.
    const address = parseEgressAddress(entry.probeResult?.tunnelled.body)
    if (!net.geoProvider || !address) return

    const observation = await lookupGeo(net.geoProvider, address)
    if (observation) {
      entry.geoObservation = observation
      entry.geoError = null
      // Plan 55 §3.4, §4.3 — the history ring is appended to for EVERY fresh observation,
      // whether or not an `expect` is declared: "three addresses in an afternoon is itself the
      // signal", and an operator watching a pool before deciding what to declare still benefits.
      // Re-read FRESH from the DB rather than trusting `row` — the caller's own `row` parameter
      // is frequently a snapshot taken BEFORE that same caller's own `writePersistedRoute` call
      // (every HTTP handler in this file reads `row` once at the top, then writes `config`
      // before ever reaching `applyRoute`), so `readPersistedRoute(row)` would silently miss
      // that write and, on a device's very FIRST apply, read `null` and drop the observation
      // entirely — exactly the kind of "saved but never actually appended to" bug this comment
      // exists to prevent happening again.
      const persisted = readPersistedRoute(mustGet(row.id))
      if (persisted) {
        writePersistedRoute(row.id, { ...persisted, exitHistory: pushExitHistory(persisted.exitHistory, observation) })
      }
    } else {
      entry.geoError = { code: 'E_NETWORK_GEO_LOOKUP_FAILED', message: `geo lookup for ${address} failed or returned an unparseable response` }
    }
    entry.geoAt = now

    // dns (Plan 51 §4.3, §5.3) — needs the delegated zone, the SAME geo provider (to attribute
    // the resolver's network), and the agent's egress-probe capability (already confirmed live by
    // the time `maybeRunProbe` populated `entry.probeResult` above, but re-checked defensively).
    const zone = probeDnsZone()
    const base = probeUrl()
    if (zone && base && net.geoProvider && entry.agentCapabilities?.includes('egress-probe') && route.probe) {
      const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      try {
        const probed = await route.probe(`http://${nonce}.${zone}/probe`, PROBE_TIMEOUT_MS)
        if (!probed.tunnelled.ok) {
          entry.dnsResult = {
            state: 'unknown',
            detail: probed.tunnelled.error ?? 'the DNS-check probe target did not answer',
            at: now,
          }
        } else {
          const resolverRes = await fetch(new URL(`/resolver/${nonce}`, base), { signal: AbortSignal.timeout(GEO_LOOKUP_TIMEOUT_MS) }).catch(() => null)
          const sighting = resolverRes?.ok ? ((await resolverRes.json().catch(() => null)) as { seenFrom?: string | null } | null) : null
          if (!sighting?.seenFrom) {
            entry.dnsResult = { state: 'unknown', detail: 'no resolver was observed querying for the probe subdomain', at: now }
          } else {
            const resolverGeo = await lookupGeo(net.geoProvider, sighting.seenFrom)
            const exitGeo = entry.geoObservation
            if (!resolverGeo || !exitGeo) {
              entry.dnsResult = { state: 'unknown', detail: 'could not attribute the resolver or exit address to a network', at: now }
            } else {
              // ASN first — far more stable and less ambiguous than an ISP display name; ISP name
              // is the fallback when either side's provider does not return one.
              const matches =
                resolverGeo.asn !== null && exitGeo.asn !== null
                  ? resolverGeo.asn === exitGeo.asn
                  : resolverGeo.isp !== null && exitGeo.isp !== null
                    ? resolverGeo.isp.trim().toLowerCase() === exitGeo.isp.trim().toLowerCase()
                    : null
              entry.dnsResult =
                matches === null
                  ? { state: 'unknown', detail: 'neither the resolver nor the exit address could be attributed to a network to compare', at: now }
                  : matches
                    ? { state: 'pass', detail: `resolved by ${resolverGeo.isp ?? `AS${resolverGeo.asn}`}, matching the upstream's own network`, at: now }
                    : {
                        state: 'fail',
                        detail: `resolved by ${resolverGeo.isp ?? (resolverGeo.asn !== null ? `AS${resolverGeo.asn}` : sighting.seenFrom)}, not the upstream's network (${exitGeo.isp ?? (exitGeo.asn !== null ? `AS${exitGeo.asn}` : 'unknown')})`,
                        at: now,
                      }
            }
          }
        }
      } catch (err) {
        entry.dnsResult = { state: 'unknown', detail: err instanceof Error ? err.message : String(err), at: now }
      }
    }

    // Plan 55 §3.5, §4.1, §5.6 — a geo MISMATCH with `onGeoFail: 'hold'` forces the device into
    // Plan 54's `held` state. Decided here, not in `buildChecks()` (which is pure and must stay
    // that way): this is the one place with both the fresh comparison AND a live `route` to act
    // through. Best-effort — a hold that could not be delivered is not this function's failure to
    // report; the `geo` check itself already says the exit drifted.
    if (config.expect && entry.geoObservation && resolveOnGeoFail(config) === 'hold' && route.hold && entry.agentCapabilities?.includes('route-hold')) {
      const result = matchGeoExpectation(config.expect, entry.geoObservation)
      if (!result.matches) {
        await route
          .hold(`geo check failed: ${result.field} expected ${result.expected}, observed ${result.observed}`)
          .catch((err) => deps.log.warn(`network: device ${row.id}: onGeoFail=hold could not force a hold, tolerated: ${String(err)}`))
      }
    }
  }

  function countEnabledPersistedRoutes(): number {
    return db
      .select()
      .from(devices)
      .all()
      .filter((row) => readPersistedRoute(row)?.enabled === true).length
  }

  /** Starts the one daemon-wide heartbeat timer, if it is not already running — never one per device. Idempotent, so every call site that turns a route on can call it unconditionally. */
  function ensureHeartbeat(): void {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(() => {
      void heartbeatTick().catch((err) => deps.log.warn(`network heartbeat tick failed, tolerated: ${String(err)}`))
    }, NETWORK_HEARTBEAT_INTERVAL_MS)
    // Never let a timer alone keep the process alive (relevant in tests and
    // short-lived scripts; harmless in the long-running daemon) — same
    // pattern as `tunnel/rpc.ts`.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
  }

  /** Stops the heartbeat once no device has an enabled route left — "do not add a heartbeat when no route is enabled" applies just as much to keeping one running. */
  function maybeStopHeartbeat(): void {
    if (heartbeatTimer && countEnabledPersistedRoutes() === 0) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /**
   * An ephemeral, un-persisted status read for a device with no live route
   * in THIS process — goes through `withEphemeralSession` (claims a session/port, asks
   * `route.status`, then releases everything), never holding a port between calls (mirrors
   * `probeReachability` above, and shares its session with it — plan 44 §8b, "Bug 1"). Used by
   * boot reconciliation and by the heartbeat for a route this process never itself applied.
   * Deliberately does NOT call `route.start`: apply()-ing here would silently reapply a
   * route the operator may have switched off from Android Settings, or double-start one that is
   * already healthy — the whole reason plan 44 §8b calls blind reapply out as the wrong fix.
   */
  async function coldProbe(row: DeviceRow, config: Socks5RouteConfig): Promise<void> {
    let observed: NetworkObservation | null = null
    let observedAt: number | null = null
    let lastError: { code: string; message: string } | null = null
    try {
      // `withEphemeralSession`'s bootstrap hellos first — protocol-version check before anything
      // else, refuse a mismatch rather than degrade (CLAUDE.md) — then this asks `route.status`.
      const status = await withEphemeralSession(row, (client) => client.routeStatus(), {
        handshakeRetries: STATUS_HANDSHAKE_RETRIES,
        handshakeRetryDelayMs: 300,
      })
      observed = {
        prepared: status.prepared,
        up: status.up,
        // Plan 54 §4.1 — carries `held` through a cold read, the same way `vpn-helper.ts`'s
        // `observe()` already does for a route this process itself applied. `lastError` too:
        // previously dropped here even though the device sends it, which meant a held route
        // probed cold could only ever get the generic "held closed on purpose" detail, never the
        // device's own specific reason (e.g. the dead-man's-switch timeout).
        ...(status.state !== undefined ? { state: status.state } : {}),
        ...(status.upstream !== undefined ? { upstream: status.upstream } : {}),
        ...(status.stats !== undefined ? { stats: status.stats } : {}),
        ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
        // Plan 51 §4.5, §5.7 — same treatment as every other optional field here.
        ...(status.ipv6Blocked !== undefined ? { ipv6Blocked: status.ipv6Blocked } : {}),
      }
      observedAt = nowSeconds()
    } catch (err) {
      // A cold read failing is an OBSERVE failure, never an apply failure (plan 44 §8b, "Bug 2") —
      // nothing here ever calls `route.start`. No probe is ever attempted from a cold entry
      // either — see `NetworkRouteEntry.route`'s doc comment for why probing is reserved for a
      // route this process actively applied.
      lastError = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
    }

    const entry: NetworkRouteEntry = {
      route: null,
      session: null,
      observed,
      observedAt,
      health: 'unknown',
      checks: [],
      lastError,
      probeResult: null,
      probeAt: null,
      probeError: null,
      agentCapabilities: null,
      geoObservation: null,
      geoAt: null,
      geoError: null,
      dnsResult: null,
    }
    recomputeChecks(entry, config)
    networkStateByDevice.set(row.id, entry)
    if (observed) {
      deps.log.info(
        `network reconcile: device ${row.id} reports up=${observed.up}${observed.upstream ? ` via ${observed.upstream}` : ''} against the persisted upstream ${config.host}:${config.port}`,
      )
    } else {
      deps.log.warn(`network reconcile: device ${row.id} unreachable (${lastError?.code}), route stays enabled — will retry on the next heartbeat`)
    }
  }

  /**
   * A device may be carrying a route applied by a PREVIOUS core process, or
   * one this process itself dropped its live state for when the device went
   * offline (`handleDeviceOffline` below) — either way, the persisted
   * config says "this should be routed" and nothing in memory currently
   * confirms it is. Rather than blindly reapplying — which would spin up a
   * fresh tunnel even over one the operator already turned off from Android
   * Settings, or double-apply on top of one still healthy (plan 44 step
   * 5.4, fixing the "route outlived the farm" defect in plan 44 §8b; plan
   * 52 §3.2 restates the same rule as the whole point of this plan) — this
   * probes the device and records what it finds. A no-op when the device
   * has no route, the route is disabled, or the device is offline (nothing
   * to probe; the next `device online` transition will call this again).
   *
   * This is BOTH plan 52's "device online" restore (called with one
   * `deviceId` from `daemon.ts`'s `onDeviceReady` hook) and its "core
   * start" restore (`reconcileNetworkRoutes` below calls it per-row) — the
   * decision table in plan 52 §4.1 is the same probe-first rule either way.
   */
  async function restoreDeviceRoute(deviceId: string): Promise<void> {
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
    if (!row) return
    const persisted = readPersistedRoute(row)
    if (!persisted?.enabled) {
      resetRecovery(deviceId)
      return
    }
    if (row.status === 'offline') {
      deps.log.info(`network restore: device ${deviceId} is offline, leaving its route enabled and unprobed`)
      return
    }
    await coldProbe(row, persisted.config)
    ensureHeartbeat()
    // Plan 54 §3.2, §4.2: probe first (just did, above) — only apply when the device reports no
    // route. `coldProbe` always (re)creates this device's entry, so it is always found here.
    const entry = networkStateByDevice.get(deviceId)
    if (entry) await maybeRecoverRoute(row, persisted, entry)
  }

  /**
   * The device just went offline (plan 52 §4.1's "device offline" row —
   * "keep the stored route; mark checks unknown"). This is deliberately NOT
   * `revertNetwork`: the persisted config/enabled columns are untouched,
   * and `route.revert()` (which sends `route.stop` to the device) is never
   * called — there is nothing to send it to, and more to the point nobody
   * asked the DEVICE to stop carrying the route, only this process's view
   * of it going stale. Any live session/port this process held is released
   * (best-effort — it is now forwarding to nothing, and holding onto it
   * would leak a port-allocator slot until the next restore), and every
   * check that depended on live observation reverts to `unknown` rather
   * than keep reporting a last-known `pass` this process can no longer
   * confirm. `restoreDeviceRoute` above is the inverse of this, called when
   * the device reconnects.
   */
  async function handleDeviceOffline(deviceId: string): Promise<void> {
    const entry = networkStateByDevice.get(deviceId)
    if (!entry) return
    if (entry.session) {
      await entry.session.close().catch((err) => deps.log.warn(`guest-agent session[${deviceId}] close on device-offline failed, tolerated: ${String(err)}`))
    }
    entry.route = null
    entry.session = null
    entry.observed = null
    entry.observedAt = null
    entry.lastError = null
    entry.probeResult = null
    entry.probeError = null
    // Plan 55 — same treatment as `probeResult`/`probeError`: a `geo`/`dns` verdict from before
    // the disconnect is not something this process can still stand behind.
    entry.geoObservation = null
    entry.geoError = null
    entry.dnsResult = null
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
    recomputeChecks(entry, row ? (readPersistedRoute(row)?.config ?? undefined) : undefined)
    deps.log.info(`network: device ${deviceId} went offline — route config kept, live state cleared, checks now unknown`)
  }

  /**
   * On boot, every device may still be carrying a route applied by a
   * PREVIOUS core process (plan 52 §4.1: "core start | restore for every
   * device with a route"). Loops every device with a persisted
   * `enabled: true` route and restores it via `restoreDeviceRoute` above.
   * Exposed on the handle so a test can await it deterministically instead
   * of racing the fire-and-forget call below.
   */
  async function reconcileNetworkRoutes(): Promise<void> {
    const rows = db.select().from(devices).all()
    let anyEnabled = false
    for (const row of rows) {
      const persisted = readPersistedRoute(row)
      if (!persisted?.enabled) continue
      anyEnabled = true
      await restoreDeviceRoute(row.id)
    }
    if (anyEnabled) ensureHeartbeat()
  }
  // Fire-and-forget at construction time — this IS "on boot" for the one
  // real caller (`daemon.ts` builds this exactly once at startup).
  void reconcileNetworkRoutes().catch((err) => deps.log.warn(`network boot reconciliation failed, tolerated: ${String(err)}`))

  /**
   * The core's half of the dead-man's-switch pair (plan 44 step 5.4, §8b):
   * the agent tears its OWN route down after 90s of silence from the core,
   * so this pings every enabled, online device at most every 20s to keep a
   * live core's routes alive. One timer for the whole daemon, not one per
   * device. Never throws into the event loop — every failure is caught,
   * logged, and recorded on the device's entry as `degraded`/`lastError`
   * rather than propagated.
   */
  async function heartbeatTick(): Promise<void> {
    const rows = db.select().from(devices).all()
    for (const row of rows) {
      const persisted = readPersistedRoute(row)
      if (!persisted?.enabled) {
        resetRecovery(row.id)
        continue
      }
      if (row.status === 'offline') continue // nothing to keep alive
      const entry = networkStateByDevice.get(row.id)
      try {
        if (entry?.route) {
          // Reuse the client already authenticated by the last apply() —
          // re-bootstrapping here would rotate the token out from under a
          // route THIS process is managing and break its next
          // revert()/observe() (the reverse of the token-rotation defect
          // fixed in plan 44 §8b).
          const observed = await entry.route.observe()
          entry.observed = observed
          entry.observedAt = nowSeconds()
          entry.lastError = null
          // Best-effort, throttled (plan 51 §9 open question 1) — never allowed to fail this
          // tick; a probe transport failure lands on `entry.probeError`, not here.
          await maybeRunProbe(entry, entry.route, false)
          // Plan 55 §3.4, §5.4 — its own, slower throttle; shares this tick rather than a second timer.
          await maybeRunGeoAndDns(row, persisted.config, entry, entry.route, false)
          recomputeChecks(entry, persisted.config)
        } else {
          await coldProbe(row, persisted.config)
        }
        // Plan 54 §4.2, §5.5: the heartbeat is the OTHER caller of the same bounded recovery
        // `restoreDeviceRoute` uses — "one owner, one counter" means both go through
        // `maybeRecoverRoute` against the SAME `recoveryByDevice` entry, never their own retry
        // loop. A device that just dropped to `held`/`down` while enabled is exactly the case
        // this catches without waiting for a reconnect event to fire `restoreDeviceRoute`.
        const current = networkStateByDevice.get(row.id)
        if (current) await maybeRecoverRoute(row, persisted, current)
      } catch (err) {
        // A heartbeat failure is always an OBSERVE failure — this loop only ever reads status
        // (`entry.route.observe()`) or cold-probes; it never calls `route.start` (plan 44 §8b,
        // "Bug 2"). `maybeRecoverRoute` above catches its OWN apply failures internally and never
        // throws, so reaching this catch still means an observe/probe step failed, not a recovery
        // attempt.
        const coded = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
        if (entry) {
          entry.lastError = coded
          recomputeChecks(entry, persisted.config)
        }
        deps.log.warn(`network heartbeat: device ${row.id} failed, tolerated: ${coded.message}`)
      }
    }
  }

  /**
   * Re-reads the device's own `route.status` before answering, so a VPN an
   * operator switched off from Android Settings shows up as drift within one
   * poll (plan 44 acceptance #5) rather than continuing to claim a route
   * that no longer exists. Does NOT trigger a fresh egress probe (plan 51 §9
   * open question 1 is unresolved, and a GET must stay cheap) — `checks`
   * reflects the entry's last probe result, refreshed by `applyRoute()` or
   * the heartbeat, not by this read.
   */
  async function currentNetworkStatus(row: DeviceRow): Promise<NetworkStatusResult> {
    const persisted = readPersistedRoute(row)
    if (!persisted) {
      return {
        engine: 'none',
        config: null,
        enabled: false,
        observed: null,
        drift: false,
        sessionId: null,
        failClosed: resolveFailClosed(null),
        health: 'unknown',
        checks: [],
        lastError: null,
        exitHistory: [],
      }
    }

    const entry = networkStateByDevice.get(row.id)
    if (entry?.route) {
      try {
        const observed = await entry.route.observe()
        entry.observed = observed
        entry.observedAt = nowSeconds()
        entry.lastError = null
      } catch (err) {
        // A status re-read failing is an OBSERVE failure, never an apply failure (plan 44 §8b,
        // "Bug 2") — this device's route may well still be healthy; only this ONE read did not
        // succeed.
        entry.lastError = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
      }
      recomputeChecks(entry, persisted.config)
    }

    // Plan 54 §3.2 acceptance #5 ("says why", and keeps saying why): the re-observe above just
    // unconditionally reset `entry.lastError` to whatever THIS read found, which would silently
    // erase a "gave up after N attempts" account on the very next GET otherwise — a bound that
    // stops retrying but cannot explain itself past one poll is not meaningfully different from
    // one that never explained itself at all. Re-applied here, AFTER the observe above, so it
    // always wins for as long as `recoveryByDevice` still considers this device exhausted —
    // regardless of how many times `entry` itself gets replaced by a cold probe in between.
    const recovery = recoveryByDevice.get(row.id)
    if (entry && recovery?.exhausted && recovery.exhaustedMessage) {
      entry.lastError = { code: 'E_NETWORK_RECOVERY_EXHAUSTED', message: recovery.exhaustedMessage }
      recomputeChecks(entry, persisted.config)
    }

    return {
      engine: 'vpn-helper',
      config: toConfigResponse(persisted.config),
      enabled: persisted.enabled,
      observed: redactObservationForResponse(entry?.observed ?? null, secretsFor(persisted.config)),
      drift: computeDrift(persisted.config, persisted.enabled, entry?.observed ?? null),
      sessionId: persisted.sessionId ?? null,
      failClosed: resolveFailClosed(persisted),
      health: entry?.health ?? 'unknown',
      checks: entry?.checks ?? [],
      lastError: entry?.lastError ?? null,
      exitHistory: persisted.exitHistory ?? [],
    }
  }

  /** Tears down any LIVE or COLD in-memory state for a device's route — never touches the persisted config/enabled columns, which the caller decides separately (PUT/enable keep it, disable keeps it, DELETE clears it). */
  async function revertNetwork(deviceId: string, actor: string | null = null): Promise<void> {
    // An operator explicitly turning a route off (or removing/uninstalling it) ends any recovery
    // cycle in progress — there is nothing left to recover once the route is gone (plan 54 §4.2).
    resetRecovery(deviceId)
    const entry = networkStateByDevice.get(deviceId)
    if (!entry) return
    // Removed up front so a concurrent/repeated call (e.g. the DELETE route
    // AND a lease-teardown site racing) has nothing left to act on — the
    // same idempotence `NetworkRoute.revert()` itself already promises.
    networkStateByDevice.delete(deviceId)
    // `route.revert()` never throws and closes its own session (releasing the port) as its very
    // last step — nothing left to release out here. A cold entry (`route: null`) never held a
    // session/port in the first place.
    if (entry.route) await entry.route.revert()
    deps.record?.({ deviceId, stream: 'main', kind: 'network.reverted', actor, meta: {} })
  }

  /**
   * Resolves a DECLARED config — `credentialRef`, or (only for a pre-migration row this process
   * has not yet rewritten) legacy inline `username`/`password` — into the RESOLVED wire object
   * `route.apply()` hands to `route.start` (plan 52 §4.2). Applies the sticky-session template on
   * top of whatever username results (plan 52 §3.3, §4.3); never on a config with no username at
   * all, since there is nothing to make sticky. `credentialRef` is dropped from the result — the
   * device has no notion of a name that only exists in this farm's own database. Throws
   * `E_CREDENTIAL_NOT_FOUND` (via `credentials.resolve`) if the name no longer exists.
   */
  function resolveWireConfig(declared: Socks5RouteConfig, sessionId: string, failClosed: boolean): Socks5RouteConfig {
    let username = declared.username
    let password = declared.password
    if (declared.credentialRef) {
      const cred = credentials.resolve(declared.credentialRef)
      username = cred.username
      password = cred.password
    }
    const template = sessionTemplate()
    if (username !== undefined && template) username = renderStickyUsername(username, sessionId, template)
    return {
      host: declared.host,
      port: declared.port,
      udpMode: declared.udpMode,
      // Plan 54 §4.2, §5.6 — tells the agent whether to hold closed or tear down on failure. Never
      // absent on the RESOLVED object: the device has no notion of "unspecified", only true/false,
      // so `resolveFailClosed()` at the call site has already turned any `undefined` into the safe
      // default before this function ever runs.
      failClosed,
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    }
  }

  /**
   * Applies `config` to `row`, creating a live route if none is held yet
   * (adopting a "cold" entry the same way) or reusing one already applied
   * this process. Shared by `PUT` (a fresh config) and `/enable` (the
   * config already on file) — both end up doing exactly this.
   */
  async function applyRoute(row: DeviceRow, config: Socks5RouteConfig, actor: string | null): Promise<void> {
    // A stable sessionId (plan 52 §3.3, §4.3): generated once, on first apply, and kept from then
    // on — writing it BEFORE the apply attempt below, same reasoning as persisting `config`/
    // `enabled` before it (plan 44 step 5.4): it must survive even if this apply fails or the
    // core dies mid-request. `currentPersisted` deliberately re-reads rather than trusting a
    // value the caller (PUT/`/enable`) may have written moments ago without a sessionId of its
    // own — those callers spread it through, but reading fresh here is the one place that must
    // be right regardless of what any future caller does.
    const currentPersisted = readPersistedRoute(mustGet(row.id))
    const sessionId = currentPersisted?.sessionId ?? generateSessionId()
    if (!currentPersisted?.sessionId) {
      writePersistedRoute(row.id, {
        config: currentPersisted?.config ?? config,
        enabled: currentPersisted?.enabled ?? true,
        ...(currentPersisted?.failClosed !== undefined ? { failClosed: currentPersisted.failClosed } : {}),
        ...(currentPersisted?.exitHistory ? { exitHistory: currentPersisted.exitHistory } : {}),
        sessionId,
      })
    }

    const existing = networkStateByDevice.get(row.id)
    let entry: NetworkRouteEntry
    let route: NetworkRoute
    if (existing?.route) {
      entry = existing
      route = existing.route
    } else {
      // One launcher, one session, shared between this route AND every ephemeral probe that
      // reuses it via `withEphemeralSession` (plan 44 §8b, "Bug 1") — a port is claimed lazily,
      // the first time the session actually needs one.
      const launcher = makeLauncher(row)
      const session = makeSession(row, launcher)
      route = createVpnHelperRoute({
        launcher,
        session,
        apkPath: deps.apkPath,
        deviceId: row.id,
        onLog: (level, msg) => deps.log[level](msg),
        ...deps.routeTimings,
      })
      entry = {
        route,
        session,
        observed: null,
        observedAt: null,
        health: 'unknown',
        checks: [],
        lastError: null,
        probeResult: null,
        probeAt: null,
        probeError: null,
        agentCapabilities: null,
        geoObservation: null,
        geoAt: null,
        geoError: null,
        dnsResult: null,
      }
      networkStateByDevice.set(row.id, entry)
    }

    try {
      // Resolve `credentialRef` (or legacy inline creds) into the actual username/password the
      // device needs, with the sticky-session template applied on top (plan 52 §4.2, §4.3) —
      // done INSIDE the try so a missing credential surfaces as a normal apply failure
      // (`E_CREDENTIAL_NOT_FOUND`), not an unhandled throw.
      const resolved = resolveWireConfig(config, sessionId, resolveFailClosed(currentPersisted))
      // `apply()` walks install → grant → bootstrap → forward → handshake →
      // route.start itself (plan 44 §4.4) — pressing apply installs the
      // agent if needed, exactly plan 44 §1 goal 2.
      await route.apply(resolved)
      entry.lastError = null
      try {
        entry.observed = await route.observe()
        entry.observedAt = nowSeconds()
      } catch {
        // Best-effort: apply() already succeeded, so a status read failing
        // right after does not invalidate that — `observed` simply stays
        // whatever it last was (null on a first apply), matching the
        // schema's "null before the first observation" contract.
      }
      // Forced, not throttled — an operator who just pressed "apply" should see a fresh answer,
      // not wait out `PROBE_INTERVAL_S`. Best-effort: a probe failure lands on
      // `entry.probeError`/the `egress`/`upstream` checks, never on this apply.
      await maybeRunProbe(entry, route, true)
      // Plan 55 §3.4, §5.4 — "plus on every apply", forced for the same reason the probe above is.
      await maybeRunGeoAndDns(row, config, entry, route, true)
      recomputeChecks(entry, config)
    } catch (err) {
      const coded = toCodedError(err, 'E_NETWORK_APPLY_FAILED')
      entry.lastError = coded
      recomputeChecks(entry, config)
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'network.applied',
        actor,
        meta: { config: redactRouteConfig(config), ok: false, error: coded },
      })
      throw new EnkakuError(coded.code, coded.message)
    }

    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'network.applied',
      actor,
      meta: { config: redactRouteConfig(config), ok: true },
    })
  }

  /**
   * Turns a `PUT /network` request into a DECLARED config that never carries a raw secret (plan
   * 52 §4.2, §5.1) — the ONE place a client-supplied secret is ever accepted, and it never
   * reaches `devices.network_route` as plaintext:
   *
   * - `credentialRef` is used as-is, after confirming it actually exists (failing the request
   *   beats silently persisting a route with a dangling reference).
   * - Inline `username`/`password` are moved into this device's OWN named credential
   *   (`device-<id>`), upserted rather than always-created — re-submitting inline credentials for
   *   the same device updates its one private entry instead of accumulating a fresh orphan on
   *   every PUT, and the deterministic name cannot collide with an operator's own named
   *   credential (which would have to guess a device's UUID to collide).
   * - Neither `credentialRef` nor inline credentials CARRIES OVER `previous`'s credential rather
   *   than dropping it. The API never returns a username (§4.2 — only `credentialRef`), so Studio
   *   cannot re-send one it was never given; treating that absence as "this upstream needs no
   *   authentication" silently downgraded an authenticated route to an anonymous one on any
   *   re-save. Against a provider that also accepts IP-whitelist auth that connects fine and
   *   serves a default-pool exit, so every check passes while the requested targeting is gone.
   *   `clearCredential` is how an operator asks for a genuinely anonymous upstream.
   */
  /**
   * Plan 55 §4.1, §5.1 — `expect`/`onGeoFail` carry over from `previous` exactly like
   * `failClosed` does at the PUT handler below: an explicit value on THIS request wins, but a
   * config update alone (e.g. changing the port) is not an operator asking to drop a declared
   * expectation. Shared by every `normalizeDeclaredConfig` return branch.
   */
  function carryGeoFields(submitted: Socks5RouteConfig, previous: PersistedNetworkRoute | null): Pick<Socks5RouteConfig, 'expect' | 'onGeoFail'> {
    const expect = submitted.expect ?? previous?.config?.expect
    const onGeoFail = submitted.onGeoFail ?? previous?.config?.onGeoFail
    return { ...(expect ? { expect } : {}), ...(onGeoFail ? { onGeoFail } : {}) }
  }

  function normalizeDeclaredConfig(
    row: DeviceRow,
    submitted: Socks5RouteConfig,
    previous: PersistedNetworkRoute | null,
    actor: string | null,
  ): Socks5RouteConfig {
    const geo = carryGeoFields(submitted, previous)
    if (submitted.credentialRef) {
      if (!credentials.findByName(submitted.credentialRef)) {
        throw new EnkakuError('E_CREDENTIAL_NOT_FOUND', `no stored credential named "${submitted.credentialRef}"`)
      }
      return { host: submitted.host, port: submitted.port, udpMode: submitted.udpMode, credentialRef: submitted.credentialRef, ...geo }
    }
    if (submitted.username === undefined && submitted.password === undefined) {
      const carried = submitted.clearCredential ? undefined : previous?.config?.credentialRef
      // A carried-over name whose credential has since been deleted is dropped rather than
      // persisted as a dangling reference — the same rule the explicit branch above enforces.
      return {
        host: submitted.host,
        port: submitted.port,
        udpMode: submitted.udpMode,
        ...(carried && credentials.findByName(carried) ? { credentialRef: carried } : {}),
        ...geo,
      }
    }
    const name = `device-${row.id}`
    credentials.upsert({ name, username: submitted.username, secret: submitted.password ?? '', createdBy: actor })
    return { host: submitted.host, port: submitted.port, udpMode: submitted.udpMode, credentialRef: name, ...geo }
  }

  app.get('/:id/network', async (c) => {
    const row = mustGet(c.req.param('id'))
    return c.json(await currentNetworkStatus(row))
  })

  app.put('/:id/network', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireHeldLease(row.id)
    const parsed = Socks5RouteConfigSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const actor = c.get('user')?.id ?? null
    const previous = readPersistedRoute(row)
    const config = normalizeDeclaredConfig(row, parsed.data, previous, actor)

    // Saves AND enables in one action (the common path stays one action,
    // plan 44 step 5.4) — persisted BEFORE the apply attempt, so the config
    // survives even if the apply below fails or the core dies mid-request.
    // `failClosed`: an explicit value on THIS request wins (plan 54 §4.2, §5.6 — Studio's route
    // form can set it); otherwise it carries over from whatever was there before (a config update
    // alone is not an operator asking to change it); `resolveFailClosed()` supplies the safe
    // default (`true`) for a route that has never had an opinion on it, new or pre-existing alike.
    const failClosed = parsed.data.failClosed ?? resolveFailClosed(previous)
    // `exitHistory` carries over exactly like `sessionId`/`failClosed` below do — a config update
    // is not an operator asking to forget the drift history observed so far (plan 55 §4.3).
    writePersistedRoute(row.id, { config, enabled: true, failClosed, ...(previous?.exitHistory ? { exitHistory: previous.exitHistory } : {}) })
    ensureHeartbeat()

    await applyRoute(row, config, actor)

    return c.json(await currentNetworkStatus(mustGet(row.id)))
  })

  app.post('/:id/network/enable', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireHeldLease(row.id)
    const persisted = readPersistedRoute(row)
    if (!persisted) {
      // Hard server-side refusal (plan 44 step 5.4) — the default config is
      // null, and with nothing stored there is nothing to enable. Not a UI
      // affordance: this is enforced here regardless of what sent the request.
      throw new EnkakuError('E_NO_ROUTE_CONFIG', 'no route config is stored for this device — PUT one first')
    }
    const actor = c.get('user')?.id ?? null
    // The SAME already-declared config/session is turning back on — every field but `enabled`
    // carries over unchanged (plan 52 §4.3: sessionId is stable across a disable/enable cycle,
    // not just across a lease).
    writePersistedRoute(row.id, {
      config: persisted.config,
      enabled: true,
      failClosed: resolveFailClosed(persisted),
      ...(persisted.sessionId !== undefined ? { sessionId: persisted.sessionId } : {}),
      ...(persisted.exitHistory ? { exitHistory: persisted.exitHistory } : {}),
    })
    ensureHeartbeat()
    await applyRoute(row, persisted.config, actor)
    return c.json(await currentNetworkStatus(mustGet(row.id)))
  })

  app.post('/:id/network/disable', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireHeldLease(row.id)
    const persisted = readPersistedRoute(row)
    const actor = c.get('user')?.id ?? null
    if (persisted) {
      await revertNetwork(row.id, actor)
      // Tears the route down but KEEPS the config AND the session id, so it
      // can be switched back on without retyping the upstream or getting a
      // fresh exit address for no reason (plan 52 §4.1, §4.3).
      writePersistedRoute(row.id, {
        config: persisted.config,
        enabled: false,
        ...(persisted.failClosed !== undefined ? { failClosed: persisted.failClosed } : {}),
        ...(persisted.sessionId !== undefined ? { sessionId: persisted.sessionId } : {}),
        ...(persisted.exitHistory ? { exitHistory: persisted.exitHistory } : {}),
      })
      maybeStopHeartbeat()
    }
    return c.json(await currentNetworkStatus(mustGet(row.id)))
  })

  app.delete('/:id/network', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireHeldLease(row.id)
    await revertNetwork(row.id, c.get('user')?.id ?? null)
    // Disables first (above), THEN clears the stored config entirely —
    // unlike `/disable`, nothing is left to switch back on.
    writePersistedRoute(row.id, null)
    maybeStopHeartbeat()
    return c.json(await currentNetworkStatus(mustGet(row.id)))
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return { routes: app, revertNetwork, restoreDeviceRoute, handleDeviceOffline, reconcileNetworkRoutes }
}
