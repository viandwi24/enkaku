import { z } from 'zod'
import { RouteLifecycleStateSchema, Socks5RouteConfigSchema } from './network'

/**
 * The wire contract between the farm host and the Enkaku guest agent APK
 * (plan 44 §4.2). Mirrors
 * `apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/control/Protocol.kt`
 * exactly — both sides change together, and `GUEST_AGENT_PROTOCOL` is bumped
 * whenever a message shape changes, so a mismatch is refused with a coded
 * error rather than degraded into silently talking past each other.
 *
 * No message-type string from this contract belongs anywhere outside this
 * package (CLAUDE.md): every method name and error code is a value exported
 * from here, never a literal typed again at a call site.
 */

/**
 * The abstract-namespace socket name the host reaches with
 * `adb forward localabstract:<name>`. Abstract rather than a TCP port: no
 * INTERNET permission needed, no device-side port collision between phones,
 * unreachable from any network interface, nothing left on disk.
 */
export const GUEST_AGENT_SOCKET = 'enkaku-guest-agent'

/**
 * The protocol major version. A host that speaks a different major refuses
 * to proceed rather than guessing at compatibility (plan 44 §4.4's `client.ts`
 * checks this on `hello`, before anything else).
 */
export const GUEST_AGENT_PROTOCOL = 1

/**
 * What a build of the agent can actually do, advertised rather than assumed
 * — the same pattern the driver registry uses for engine capabilities.
 * `egress-probe` is part of the enum because the wire format must already be
 * able to carry it, but no build advertises it today: it arrives once the
 * probe runs on a socket protected out of the agent's own tunnel, since a
 * probe measured from inside the tunnel would only ever answer its own
 * question (Protocol.kt's `CAPABILITIES` comment, plan 44 §2).
 *
 * `route-hold` (plan 55 §3.5, §4.1, §5.6) — an older build has no `route.hold` handler and
 * answers `E_UNKNOWN_METHOD`; the host gates on this the same way it gates `egress.probe` on
 * `egress-probe`, rather than finding out from a failed call.
 */
export const GuestAgentCapabilitySchema = z.enum(['socks5-route', 'vpn-status', 'egress-probe', 'route-hold'])
export type GuestAgentCapability = z.infer<typeof GuestAgentCapabilitySchema>

/** Mirrors Protocol.kt's `ERR_*` constants. Failures are matched on `code`, never on message text. */
export const GuestAgentErrorCodeSchema = z.enum([
  'E_UNAUTHORISED',
  'E_BAD_REQUEST',
  'E_UNKNOWN_METHOD',
  'E_NOT_PAIRED',
  'E_NOT_PREPARED',
])
export type GuestAgentErrorCode = z.infer<typeof GuestAgentErrorCodeSchema>

// ---- requests (host -> agent) ----

/**
 * Every request carries `id` (for response correlation over the
 * one-connection-many-requests channel) and `token` (the pairing token —
 * authorisation lives in the payload, not in a component permission, because
 * `adb shell am` and this socket both need to reach the agent unsigned; see
 * `ControlService.handle`).
 */
const GuestAgentRequestBaseSchema = z.object({
  id: z.string(),
  token: z.string(),
})

export const HelloRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('hello'),
})
export type HelloRequest = z.infer<typeof HelloRequestSchema>

export const PingRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ping'),
})
export type PingRequest = z.infer<typeof PingRequestSchema>

export const RouteStartRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('route.start'),
  config: Socks5RouteConfigSchema,
})
export type RouteStartRequest = z.infer<typeof RouteStartRequestSchema>

export const RouteStopRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('route.stop'),
})
export type RouteStopRequest = z.infer<typeof RouteStopRequestSchema>

export const RouteStatusRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('route.status'),
})
export type RouteStatusRequest = z.infer<typeof RouteStatusRequestSchema>

/**
 * Plan 51 §4.2, §5.4 — measures whether the world is actually reachable, from the device, through
 * the tunnel. Only meaningful once the agent advertises the `egress-probe` capability (§5.4:
 * advertised ONLY once this is implemented) — an older build answers `E_UNKNOWN_METHOD`, which the
 * host-side engine checks (`packages/core/src/api/guest-agent.ts`) treat as "cannot run this check"
 * rather than a route failure.
 */
export const EgressProbeRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('egress.probe'),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(60_000),
})
export type EgressProbeRequest = z.infer<typeof EgressProbeRequestSchema>

/**
 * Plan 55 §3.5, §4.1, §5.6 — forces the SAME hold-closed transition Plan 54's dead-man's switch
 * reaches internally (`RouteVpnService.hold()`), but reachable from the HOST: a `geo` check
 * disagreeing with `Socks5RouteConfig.onGeoFail: 'hold'` is decided on the HOST (only the host
 * runs the geo lookup and the comparison), so unlike every other hold trigger — which are all
 * on-device conditions the agent notices about itself — this one has to be told. `reason` is
 * plain language, shown back through `route.status`'s `lastError`, same as any other hold.
 */
export const RouteHoldRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('route.hold'),
  reason: z.string().min(1),
})
export type RouteHoldRequest = z.infer<typeof RouteHoldRequestSchema>

/** The full request union, discriminated on `method` — mirrors `Protocol.METHOD_*`. */
export const GuestAgentRequestSchema = z.discriminatedUnion('method', [
  HelloRequestSchema,
  PingRequestSchema,
  RouteStartRequestSchema,
  RouteStopRequestSchema,
  RouteStatusRequestSchema,
  EgressProbeRequestSchema,
  RouteHoldRequestSchema,
])
export type GuestAgentRequest = z.infer<typeof GuestAgentRequestSchema>

// ---- per-method results ----

export const HelloResultSchema = z.object({
  protocol: z.number().int(),
  appVersion: z.string(),
  androidSdkInt: z.number().int(),
  capabilities: z.array(GuestAgentCapabilitySchema),
})
export type HelloResult = z.infer<typeof HelloResultSchema>

export const PingResultSchema = z.object({
  pong: z.literal(true),
})
export type PingResult = z.infer<typeof PingResultSchema>

export const RouteStartResultSchema = z.object({
  started: z.literal(true),
})
export type RouteStartResult = z.infer<typeof RouteStartResultSchema>

export const RouteStopResultSchema = z.object({
  stopped: z.literal(true),
})
export type RouteStopResult = z.infer<typeof RouteStopResultSchema>

/** Plan 55 §3.5, §4.1, §5.6. Mirrors `RouteStartResultSchema`'s shape — a plain acknowledgement, since `route.status` is where the resulting state is actually read back. */
export const RouteHoldResultSchema = z.object({
  held: z.literal(true),
})
export type RouteHoldResult = z.infer<typeof RouteHoldResultSchema>

/**
 * `upstream`, `stats`, and `lastError` are ABSENT from the frame when there
 * is nothing to report, not `null` — `ControlService.handle` builds this with
 * `org.json.JSONObject`, whose `put(key, value)` removes the key outright on
 * a `null` value rather than emitting a JSON `null`. Modelled as optional,
 * never nullable, so a captured frame like
 * `{"prepared":true,"up":false}` (route down) parses without a `.nullable()`
 * anywhere pretending a `null` could show up instead.
 */
export const RouteStatusResultSchema = z.object({
  prepared: z.boolean(),
  up: z.boolean(),
  /** Plan 54 §4.1, §5.3 — see `RouteLifecycleStateSchema`'s doc comment. */
  state: RouteLifecycleStateSchema.optional(),
  upstream: z.string().optional(),
  /** [txPackets, txBytes, rxPackets, rxBytes]. */
  stats: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]).optional(),
  /**
   * A plain message, not a coded error: the device has no error codes, it reports what went wrong
   * (`RouteState.lastError()` is a `String?` in Kotlin). Modelling it as `{code, message}` by
   * analogy with the host-side `NetworkStatus.lastError` made every status frame carrying an error
   * fail validation — and it went unnoticed because the captured frames the schema was written
   * against had never errored, so no test covered it.
   */
  lastError: z.string().optional(),
  /**
   * Plan 51 §4.5, §5.7 — asserts IPv6 is actually blocked rather than the host assuming a
   * `Builder.addRoute("::", 0)` call that returned a non-null descriptor did exactly what was
   * asked (`Ipv6Leak.isBlocked()` on the Kotlin side reads back `LinkProperties` rather than
   * trusting the request). Absent on an older agent build that predates the check, and whenever
   * `ConnectivityManager` cannot currently find the VPN network to ask (nothing established yet)
   * — both map to the `leak` check reading `skip`/`unknown` rather than a guessed answer, never a
   * silent `pass`.
   */
  ipv6Blocked: z.boolean().optional(),
})
export type RouteStatusResult = z.infer<typeof RouteStatusResultSchema>

/**
 * One measurement leg of an egress probe (plan 51 §4.2). `stage` says WHERE a failed leg died —
 * `'connect'` covers the TCP/TLS connect and, for the tunnelled leg, the SOCKS5 handshake itself;
 * `'fetch'` covers the HTTP request/response to the probe target once a connection exists. This is
 * what lets the host-side engine tell "could not reach or authenticate with the SOCKS5 upstream"
 * (an `upstream` check failure) apart from "reached the upstream fine but the probe target itself
 * did not answer" (an `egress` check failure) without parsing `error` text. Absent on a successful
 * leg. `error` and every other field here must never carry a credential — nothing in this shape is
 * built from the upstream's username/password on the Kotlin side (`EgressProbe.kt`).
 */
export const EgressProbeLegSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  /** Truncated to a few KB on the device side — never assume this is the whole body. */
  body: z.string().optional(),
  ms: z.number().int(),
  error: z.string().optional(),
  stage: z.enum(['connect', 'fetch']).optional(),
})
export type EgressProbeLeg = z.infer<typeof EgressProbeLegSchema>

/**
 * `tunnelled` is measured by proxying through the route's own configured SOCKS5 upstream — the
 * app's own uid is excluded from its own TUN (`RouteVpnService.start()`'s
 * `addDisallowedApplication`), so a plain socket from this process can never be captured by the
 * tunnel to prove anything about it; `direct` uses `RouteVpnService.protectOutbound()` so it
 * leaves on the underlying network. Comparing the two in one call is what proves the tunnel is
 * actually carrying traffic rather than the device merely having internet some other way (plan 51
 * §3.2, §4.2).
 */
export const EgressProbeResultSchema = z.object({
  tunnelled: EgressProbeLegSchema,
  direct: EgressProbeLegSchema,
})
export type EgressProbeResult = z.infer<typeof EgressProbeResultSchema>

// ---- response envelope (agent -> host) ----

/** `{ id?, ok: true, result }` — `id` is absent when the request line itself failed to parse (`handle`'s catch path had no `id` to echo back). */
export const GuestAgentOkResponseSchema = z.object({
  id: z.string().optional(),
  ok: z.literal(true),
  result: z.union([
    HelloResultSchema,
    PingResultSchema,
    RouteStartResultSchema,
    RouteStopResultSchema,
    RouteStatusResultSchema,
    EgressProbeResultSchema,
    RouteHoldResultSchema,
  ]),
})
export type GuestAgentOkResponse = z.infer<typeof GuestAgentOkResponseSchema>

/** `{ id?, ok: false, error: { code, message } }`. */
export const GuestAgentErrorResponseSchema = z.object({
  id: z.string().optional(),
  ok: z.literal(false),
  error: z.object({
    code: GuestAgentErrorCodeSchema,
    message: z.string(),
  }),
})
export type GuestAgentErrorResponse = z.infer<typeof GuestAgentErrorResponseSchema>

/**
 * The full response envelope, discriminated on `ok` so a caller narrows with
 * a plain `if (response.ok)` and gets `result` or `error` typed accordingly
 * — no separate type guard needed.
 */
export const GuestAgentResponseSchema = z.discriminatedUnion('ok', [
  GuestAgentOkResponseSchema,
  GuestAgentErrorResponseSchema,
])
export type GuestAgentResponse = z.infer<typeof GuestAgentResponseSchema>
