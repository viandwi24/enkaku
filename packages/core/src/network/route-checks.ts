import type { EgressProbeResult, GeoObservation, NetworkObservation, RouteCheck, Socks5RouteConfig } from '@enkaku/protocol'
import { matchGeoExpectation } from '@enkaku/protocol'

/**
 * Every named check a route reports, derived (plan 51 §4.1) — split out of
 * `route-service.ts` in step 114.3 for the reason plan 51 gave `buildChecks`
 * when it wrote it: **it is pure.** Every input is a plain value the caller
 * already holds on a route's in-memory entry, so the whole check-and-health
 * vocabulary is testable without a device, a session, a database or a Hono
 * app — and the two engines' tables sit side by side where the difference
 * between them can be read at a glance.
 *
 * There are two tables, not one, and that is the point of plan 114 §3.5:
 *
 * - `buildChecks` is `vpn-helper`'s. Every check in it is a question about a
 *   tunnel, and `egress` passing is the only thing that can ever lift
 *   `deriveHealth` to `ok`.
 * - `buildAdvisoryChecks` is `adb-proxy`'s and `adb-reverse-proxy`'s. Its
 *   `egress` is `skip` permanently, which pins those engines at `unverified`
 *   forever with no change to `deriveHealth` at all.
 *
 * `deriveHealth` itself lives in `@enkaku/protocol` and is deliberately NOT
 * touched by plan 114 (`docs/plans/114-m79-device-proxy.md` §3.5, F10).
 */

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
/**
 * Scrubs a check `detail` of two things, defensively: a `user:pass@` URL userinfo segment, and
 * any LITERAL occurrence of `secrets` — the route's own configured username/password. The latter
 * is the stronger guarantee: `RouteState.lastError()` is a Kotlin `String?` built from whatever
 * exception message the device happened to raise, with no contract that it never echoes back
 * something it was given. Acceptance criterion 8 (plan 51 §6) is a grep over every surface, and a
 * freeform string sourced from the device is exactly the kind of thing a future change could
 * carelessly widen. Secrets shorter than 3 characters are not scrubbed — too short to usefully
 * distinguish from ordinary text.
 */
export function safeCheckDetail(detail: string | undefined, secrets: readonly string[] = []): string | undefined {
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
 * "any check detail, API response, event log, or Studio view", not only the `checks` array.
 */
export function redactObservationForResponse(observed: NetworkObservation | null, secrets: readonly string[]): NetworkObservation | null {
  if (observed === null || observed.lastError === undefined) return observed
  return { ...observed, lastError: safeCheckDetail(observed.lastError, secrets) }
}

export interface ChecksInput {
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
 * Pulls a bare address out of whatever the probe endpoint returned. Endpoints differ — some
 * answer `{"ip":"1.2.3.4"}`, `packages/probe-server`'s own `/probe` answers `{"address":...}`,
 * some answer bare text — so this stays deliberately loose and simply reports nothing it cannot
 * recognise rather than guessing.
 */
export function parseEgressAddress(body: string | undefined): string | undefined {
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

/**
 * Builds `vpn-helper`'s named checks (plan 51 §4.1) from what this process currently knows about a
 * device's route. Pure — every input is a plain value already held on the route's
 * `NetworkRouteEntry`, so this is trivial to unit-test without a fake device at all.
 *
 * `adb-proxy`/`adb-reverse-proxy` do NOT come through here: `buildAdvisoryChecks` below is their
 * own table (plan 114 §3.5), because every one of these checks is a question about a tunnel that
 * those rungs never establish.
 */
export function buildChecks(input: ChecksInput): RouteCheck[] {
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
   * `fail` here, ahead of whatever a probe might otherwise say.
   */
  const heldDetail = safeCheckDetail(
    input.observed?.lastError ?? 'route is held closed on purpose — traffic is blocked, not leaking',
    input.secrets,
  )

  // upstream — only the probe's tunnelled leg can answer "did a SOCKS5 session reach and
  // authenticate with the proxy" (plan 51 §4.2).
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
        ? { ...(summariseEgress(leg.body) ? { detail: summariseEgress(leg.body)! } : {}) }
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

  // geo (plan 55 §4.2) — NEVER inferred from the username. `skip` unless an operator has stated an
  // expectation — acceptance criterion 1: no expectation means skip, forever, never a silent pass.
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
  // geo provider to attribute the resolver's and the exit's networks.
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

  // leak (plan 51 §4.5, §5.7) — asserted from the device's own `route.status`.
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

/**
 * The sentence plan 114 §3.5 fixes for both HTTP rungs and requires to be shown
 * rather than merely implied. It is the `egress` check's own `detail`, so it
 * reaches every surface that renders a check without any of them having to
 * remember to add it.
 */
export const ADVISORY_EGRESS_DETAIL =
  'a proxy is set on this phone, but nothing here can tell you which apps used it — the system proxy setting is advisory, and an app with its own networking ignores it. For traffic an app cannot escape, use VPN mode.'

export interface AdvisoryChecksInput {
  engine: 'adb-proxy' | 'adb-reverse-proxy'
  /** The exact `http_proxy` value this farm wrote, or would write, for the declared config — from `httpProxyValue()`, so this comparison and the engine's own write share one definition of the format. */
  declaredValue: string
  observed: NetworkObservation | null
  observedAt: number | null
  /** The route's current apply/observe failure, if any. */
  lastError: { code: string; message: string } | null
  /** Result of the host-side TCP dial (`runUpstreamCheck`) — null when it has never been attempted. */
  upstream: { ok: boolean; detail: string; at: number } | null
  /** Rung 2 only: whether the `adb reverse` entry is listed. Null when never checked. */
  reverse: { ok: boolean; detail: string; at: number } | null
}

/**
 * Plan 114 §3.5's per-engine check table for the two advisory rungs. Pure, for
 * the same reason `buildChecks` is.
 *
 * **`egress` is `skip` here permanently, and that is the answer rather than a
 * gap.** An egress probe has to run ON the device to say anything, and the only
 * probe vehicles a phone gives us are the shell (which has no HTTP client that
 * honours `global http_proxy` — the framework reads that setting, not a shell
 * binary) and the guest agent (which could be made to run a request through a
 * client configured to honour it, proving only that such a client CAN reach the
 * proxy, never that any app under test did). Reporting either as `egress: pass`
 * would promote `health` to `ok` and would be a false statement about the
 * device. So `deriveHealth` lands on `unverified` and stays there, with no
 * change to that function.
 *
 * `setting: pass` is what makes the readout worth showing anyway: it says the
 * device accepted the write and reports it back, which is real, non-trivial,
 * and strictly weaker than "this phone's traffic goes through that proxy".
 */
export function buildAdvisoryChecks(input: AdvisoryChecksInput): RouteCheck[] {
  const checks: RouteCheck[] = []
  const now = nowSeconds()

  checks.push({
    id: 'tunnel',
    state: 'skip',
    detail: 'this mode establishes no tunnel — it writes Android’s own system proxy setting',
    at: null,
  })

  // setting — the one check that can actually pass here. An apply/observe failure outranks a
  // stale observation, exactly as it does for `tunnel` on the VPN rung: "we don't know because
  // the last attempt to find out failed" is `fail`, not a leftover `pass` from before it.
  if (input.lastError) {
    checks.push({ id: 'setting', state: 'fail', detail: safeCheckDetail(input.lastError.message), at: now })
  } else if (input.declaredValue === '') {
    // Rung 2 only, and only before a device port has ever been allocated (rung 1's declared value
    // is `host:port` and can never be empty). Without this guard the comparison below would read
    // an unset `http_proxy` as EQUAL to an empty declaration and report `setting: pass` for a
    // route that has never been written to the phone at all — a pass built out of two absences
    // (plan 114 step 114.5).
    checks.push({
      id: 'setting',
      state: 'unknown',
      detail: 'this route has no device-side address yet — the tunnel to this machine has not been allocated, so nothing has been written to the phone',
      at: null,
    })
  } else if (input.observed === null) {
    checks.push({ id: 'setting', state: 'unknown', at: null })
  } else {
    const reported = input.observed.upstream ?? ''
    checks.push(
      reported === input.declaredValue
        ? { id: 'setting', state: 'pass', detail: `the device reports http_proxy ${reported}`, at: input.observedAt }
        : {
            id: 'setting',
            state: 'fail',
            detail: `the device reports http_proxy ${reported || '(unset)'}, not the ${input.declaredValue} this farm wrote`,
            at: input.observedAt,
          },
    )
  }

  if (input.engine === 'adb-proxy') {
    checks.push({ id: 'reverse', state: 'skip', detail: 'this mode dials the proxy directly — there is no adb reverse to check', at: null })
  } else if (input.reverse === null) {
    checks.push({ id: 'reverse', state: 'unknown', at: null })
  } else {
    checks.push({
      id: 'reverse',
      state: input.reverse.ok ? 'pass' : 'fail',
      detail: input.reverse.detail,
      at: input.reverse.at,
    })
  }

  // upstream — see `runUpstreamCheck` for exactly what a pass and a fail here mean. Deliberately
  // `unknown` rather than `skip` before the first attempt: it CAN run, it just has not yet.
  if (input.upstream === null) {
    checks.push({ id: 'upstream', state: 'unknown', at: null })
  } else {
    checks.push({
      id: 'upstream',
      state: input.upstream.ok ? 'pass' : 'fail',
      detail: input.upstream.detail,
      at: input.upstream.at,
    })
  }

  checks.push({ id: 'egress', state: 'skip', detail: ADVISORY_EGRESS_DETAIL, at: null })
  checks.push({ id: 'geo', state: 'skip', detail: 'a geo check compares an exit address, and this mode can never observe one (see the egress check)', at: null })
  checks.push({ id: 'dns', state: 'skip', detail: 'DNS-leak detection needs a tunnel to compare the resolver against; this mode establishes none', at: null })
  checks.push({ id: 'leak', state: 'skip', detail: 'IPv6 leak state is a property of the VPN’s own TUN; this mode establishes none', at: null })

  return checks
}
