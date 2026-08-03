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
 * guest-agent wire (see `guest-agent.ts`), and also what a device page form
 * collects. `credentialRef` is intentionally absent: plan 44 §4.5 leaves
 * credential storage unanswered and has the operator type the upstream into
 * the form for the lifetime of the route only, rather than pretending a
 * reference indirection exists that this slice does not build.
 */
export const Socks5RouteConfigSchema = z.object({
  host: z.string().min(1).describe('SOCKS5 upstream host').meta({ title: 'Host' }),
  port: z.number().int().min(1).max(65535).describe('SOCKS5 upstream port').meta({ title: 'Port' }),
  username: z.string().optional().describe('Upstream username, if the proxy requires authentication').meta({ title: 'Username' }),
  password: z.string().optional().describe('Upstream password, if the proxy requires authentication').meta({ title: 'Password' }),
  udpMode: z
    .enum(['udp', 'tcp'])
    .default('udp')
    .describe('Carry UDP natively through the tunnel, or fall back to TCP-only')
    .meta({ title: 'UDP mode' }),
})
export type Socks5RouteConfig = z.infer<typeof Socks5RouteConfigSchema>

/**
 * What survives in `devices.network_route` (plan 44 step 5.4, fixing the
 * defect recorded in plan 44 §8b — a route with no durable record cannot
 * come back after a core restart, and the operator had to retype the
 * upstream, password included, every time). `config` carries the password
 * in PLAINTEXT: there is no secret store yet (plan 33 §9 Q2 is still open),
 * and this is a stated compromise rather than a hidden one — a real secret
 * store is future work, not a promise this column makes. `enabled` is the
 * operator's declared on/off intent, tracked separately from `config` on
 * purpose: the default config is null, and with no config there is nothing
 * to enable — `enabled: true` alongside `config: null` must never occur.
 * Nothing that reads this value may hand it to a client without first
 * running `config` through `redactRouteConfig()`.
 */
export const PersistedNetworkRouteSchema = z.object({
  config: Socks5RouteConfigSchema,
  enabled: z.boolean(),
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
 * `health` starts at `'unverified'` and can ONLY become `'ok'` once an
 * egress probe exists and passes (plan 44 §2, §4.3 — `probe()` is not built
 * in this slice). A successful `apply()` — the device answering
 * `{ started: true }` — must never by itself set `health` to `'ok'`; it is
 * evidence the request was accepted, not evidence traffic is actually
 * leaving through the proxy.
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
  leaseId: z.string().nullable(),
  /** Unix epoch seconds, or null before any apply has succeeded. */
  appliedAt: z.number().int().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type NetworkStatus = z.infer<typeof NetworkStatusSchema>
