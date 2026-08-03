import { z } from 'zod'
import { Socks5RouteConfigSchema } from './network'

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
 */
export const GuestAgentCapabilitySchema = z.enum(['socks5-route', 'vpn-status', 'egress-probe'])
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

/** The full request union, discriminated on `method` — mirrors `Protocol.METHOD_*`. */
export const GuestAgentRequestSchema = z.discriminatedUnion('method', [
  HelloRequestSchema,
  PingRequestSchema,
  RouteStartRequestSchema,
  RouteStopRequestSchema,
  RouteStatusRequestSchema,
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
})
export type RouteStatusResult = z.infer<typeof RouteStatusResultSchema>

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
