import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  CreateNetworkCredentialRequestSchema,
  DeviceNetworkApplyBodySchema,
  GeoProviderResponseSchema,
  NetworkRouteConfigSchema,
  PersistedNetworkRouteSchema,
  deriveHealth,
  matchGeoExpectation,
  pushExitHistory,
  redactRouteConfig,
  renderStickyUsername,
  tagUntaggedRouteConfig,
  type DeviceNetworkApplyResult,
  type EgressProbeResult,
  type GeoObservation,
  type HttpProxyRouteConfig,
  type NetworkCredential,
  type NetworkEngineId,
  type NetworkObservation,
  type NetworkRouteConfig,
  type PersistedNetworkRoute,
  type ReverseProxyRouteConfig,
  type RouteCheck,
  type ShellResult,
  type Socks5RouteConfig,
  type Transport,
  type TransportExecOptions,
} from '@enkaku/protocol'
import {
  GuestAgentClientError,
  createHttpProxyRoute,
  createReverseProxyRoute,
  createVpnHelperRoute,
  httpProxyValue,
  reverseProxyValue,
  type GuestAgentClient,
  type GuestAgentLauncher,
  type NetworkRoute,
} from '@enkaku/drivers'
import { createAuditLogger, type AuditLogger } from '../auth/audit'
import { can } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { deriveGuestAgentPreparation } from '../device/preparation/guest-agent-status'
import type { EventRecorder } from '../events/recorder'
import type { LeaseManager } from '../lease/lease-manager'
import { pluginNameFromPrincipal } from '../plugins/principal'
import type { Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'
import { defaultTcpPreProbe } from '../registry/reconnect'
import { createCredentialStore } from './credential-store'
import {
  buildAdvisoryChecks,
  buildChecks,
  nowSeconds,
  parseEgressAddress,
  redactObservationForResponse,
  safeCheckDetail,
} from './route-checks'
import type { ReverseRegistry } from './reverse-registry'

/**
 * The device network route's whole lifecycle (plan 114 step 114.3), extracted
 * out of `packages/core/src/api/guest-agent.ts` — which was 2610 lines before
 * this step and would have been well past 3500 with three engines in it.
 *
 * **What moved, and what deliberately did not.** Everything that reads or
 * writes `devices.network_route` moved here verbatim: the persisted-route
 * read/write pair and its boot-time credential migration, the per-device
 * in-memory `NetworkRouteEntry` map, the bounded-recovery state machine
 * (plan 54/90), `buildChecks` and the whole check/health derivation, the
 * heartbeat, the reconcile/restore/offline hooks, and the nine HTTP routes.
 * What stayed in `guest-agent.ts` is the guest agent itself: the
 * install/uninstall/status endpoints, the `DeviceSession` implementation that
 * owns a device's one bootstrap token, and the launcher/client factories.
 * This module receives those as deps (`makeLauncher`, `makeSession`,
 * `withEphemeralSession`) rather than rebuilding them, because a second
 * bootstrap for a device is exactly the defect plan 44 §8b's "Bug 1" fixed.
 *
 * **`vpn-helper`'s construction is carried across unchanged.** It is a live
 * feature with real devices attached to it; a behaviour change smuggled into a
 * move is the hardest kind of regression to find. Every VPN path below —
 * `applyVpnRoute`, `coldProbe`, `maybeRecoverRoute`, `resolveWireConfig`,
 * `normalizeDeclaredConfig`, the heartbeat — is the pre-114 code with `deps.`
 * prefixes and an `engine === 'vpn-helper'` narrowing in front of it, nothing
 * else.
 *
 * **What is new (plan 114 §3.5, §3.6, §4.4).** `buildEngine` is the one switch
 * on `config.engine`; `assertLockFree` makes the registry's own
 * `locks: ['network-route']` real by reverting an incumbent route of a
 * different engine before a new one is applied; the capture-once rule persists
 * the device's pre-farm proxy settings so turning a route off restores what was
 * found rather than a hard-coded `:0`; and `buildAdvisoryChecks` is §3.5's
 * per-engine check table for the two HTTP rungs, whose `egress` is permanently
 * `skip` and whose `health` is therefore permanently `unverified`.
 */

/** How often the daemon-wide heartbeat pings every device with an enabled route (plan 44 step 5.4) — the core's half of the dead-man's-switch pair described in plan 44 §8b; the agent's own half tears the route down after 90s of silence. Only `vpn-helper` routes are pinged: the advisory rungs have no dead-man's switch to feed, and four `settings get` calls per device per 20s would be real adb traffic bought for nothing. */
const NETWORK_HEARTBEAT_INTERVAL_MS = 20_000

/** Per-leg budget handed to the device for each `egress.probe` call. */
const PROBE_TIMEOUT_MS = 8_000

/** Budget for one `GET <geoProvider>?ip=<address>` call — a farm's own infrastructure, but still a network call this process must not hang on. */
const GEO_LOOKUP_TIMEOUT_MS = 5_000

/**
 * Re-running an egress probe is real device network traffic, and plan 51 §9 open question 1
 * ("how often should checks re-run?") is explicitly UNRESOLVED — probing on every 20s heartbeat
 * tick was flagged there as possibly too much at fleet scale. Throttled to a multiple of the
 * heartbeat interval as a deliberate, conservative default until that question is settled;
 * `applyRoute()` always forces one fresh probe regardless (an operator who just pressed "apply"
 * should not wait out this window for a first answer).
 */
const PROBE_INTERVAL_S = 60

/**
 * Budget for the advisory rungs' `upstream` check (plan 114 §3.5) — a plain TCP
 * dial from THIS machine, deliberately short. See `runUpstreamCheck` for what
 * it does and does not prove.
 */
const UPSTREAM_PROBE_TIMEOUT_MS = 4_000

/**
 * How long an advisory rung's `settings get` read-back is reused before a
 * client-driven `GET /:id/network` dials the device again (plan 114 §3.5).
 * Short, because the whole point of the `setting` check is to notice an
 * operator clearing the proxy from Android's own UI; bounded, because Studio's
 * Network panel polls and four adb round trips per poll per device is the same
 * fleet-scale cost `PROBE_INTERVAL_S` exists to avoid on the VPN side.
 */
const ADVISORY_OBSERVE_INTERVAL_S = 10

/**
 * Plan 51 §4.3, §5.5 — the self-hosted probe endpoint's URL. `network.probeUrl` was specified as a
 * per-farm SETTING; it is read from an env var here instead of `FarmSettingsSchema`
 * (`packages/protocol/src/settings.ts`) as a deliberate scope decision — wiring this into real farm
 * settings (so it is configurable from Studio, not just at process start) is follow-up work; until
 * then this is the ONE place a farm operator sets it.
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

/**
 * Plan 52 §3.3, §4.3 — the farm-level sticky-session template, describing where a per-device
 * `sessionId` gets injected into the resolved upstream username. Read from an env var rather than
 * `FarmSettingsSchema` for the SAME reason `probeUrl()` above is. Empty/unset means no stickiness —
 * `renderStickyUsername()` returns the username unchanged in that case.
 */
function sessionTemplate(): string {
  return process.env.ENKAKU_NETWORK_SESSION_TEMPLATE?.trim() ?? ''
}

/**
 * Plan 51 §4.3, §5.3 — the zone this farm's probe endpoint (`packages/probe-server`) is
 * authoritative for, e.g. `dns.probe.example.com`. Read from an env var, the SAME scope decision
 * `probeUrl()` above documents. Unset means the `dns` check stays `skip`, naming this variable —
 * never a guessed `pass`.
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

/**
 * Plan 54 §4.2, §5.6 — turns a possibly-absent `PersistedNetworkRoute.failClosed` into a concrete
 * boolean, in exactly ONE place, so every reader (the PUT handler persisting a value, `applyRoute`
 * resolving the wire object, the UI default Studio shows) agrees. `undefined` resolves to `true`
 * — "the safe default is the one that does not leak" (plan 54 §3.1) — for every route regardless
 * of age. An operator who wants the old tear-down behaviour back sets it to `false` explicitly.
 */
function resolveFailClosed(persisted: Pick<PersistedNetworkRoute, 'failClosed'> | null): boolean {
  return persisted?.failClosed ?? true
}

/**
 * Calls a `network.geoProvider` endpoint for `address` and turns its response into a
 * `GeoObservation` (Plan 55 §3.2, §5.2). Returns `null` on ANY failure — unreachable provider,
 * non-200, a body that fails `GeoProviderResponseSchema` — never a guess.
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
 * Every coded failure this subsystem can raise, mapped to an HTTP status.
 * Exported because `guest-agent.ts` registers the identical `onError` over its
 * own install/uninstall/status routes — the two Hono apps are mounted at the
 * same prefix and answering the same code with two different statuses depending
 * on which one happened to handle the request would be a genuinely confusing
 * bug to chase.
 */
export const ERROR_STATUS: Record<string, number> = {
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
  // (plan 44 §8b, "Bug 2").
  E_NETWORK_OBSERVE_FAILED: 502,
  E_NO_ROUTE_CONFIG: 409,
  // Plan 54 §3.2, §4.2 — bounded automatic recovery gave up.
  E_NETWORK_RECOVERY_EXHAUSTED: 503,
  // The credential store (plan 52 §4.2).
  E_CREDENTIAL_NOT_FOUND: 404,
  E_CREDENTIAL_NAME_TAKEN: 409,
  E_CREDENTIAL_IN_USE: 409,
  E_CREDENTIAL_CORRUPT: 500,
  E_CREDENTIAL_KEY_CORRUPT: 500,
  // Plan 114 §3.8 — a credential in a device setting is refused, not warned about. 400 rather
  // than 422: the request is malformed for this engine in a way no retry can fix.
  E_HTTP_PROXY_NO_AUTH: 400,
  // Plan 114 §4.4 — the `network-route` lock. 409, because the device is in a state that has to
  // change first, and the request is fine on its own terms.
  E_ROUTE_LOCK_HELD: 409,
  // Plan 114 §4.5 — `/retry` against an advisory rung (there is no recovery loop to clear), and
  // `adb-reverse-proxy` asked of a core built without the reverse registry.
  E_NOT_SUPPORTED: 409,
  // No engine raises this since step 114.5 built the last one. Kept because it is the honest
  // answer for any FUTURE engine id that reaches `buildEngine` before its construction does, and
  // because deleting a status mapping is how a later 500 loses its meaning.
  E_ENGINE_NOT_BUILT: 501,
  // Plan 114 §3.9's classification, raised by `@enkaku/drivers`' `HttpProxyError` and by the
  // reverse registry. `E_SETTING_NOT_ACCEPTED` is 502 rather than 500: the device declined, which
  // is an upstream refusal from this process's point of view, not an internal fault.
  E_SETTING_READ_FAILED: 502,
  E_SETTING_WRITE_FAILED: 502,
  E_SETTING_NOT_ACCEPTED: 502,
  E_REVERSE_FAILED: 502,
}

/** `NetworkStatusResult.recovery` — see that field's own doc comment. */
export interface NetworkRecoveryStatus {
  /** Automatic recovery attempts made since the last full reset (an explicit operator act, or a genuine reconnect past the exhausted bound). */
  attempts: number
  /** The configured bound (`recoveryBackoffS.length`) — 3 by default. */
  maxAttempts: number
  /** Unix seconds of the next automatic attempt — the re-arm point once `exhausted` is true. Null while no attempt is scheduled. */
  nextAttemptAt: number | null
  /** The bound was reached and automatic attempts have stopped until the re-arm. */
  exhausted: boolean
  /** Genuine reconnect-triggered resets still inside the last hour (plan 90 §3.7 rule 2). */
  reconnectCycles: number
}

/**
 * The route config as an API response, per engine (plan 114 §4.1). Every arm is
 * tagged, so a client switches on `engine` rather than sniffing for fields —
 * and Studio's own hand-written mirror is replaced by this shape in step 114.6.
 *
 * `vpn-helper`'s arm is byte-for-byte what this endpoint answered before plan
 * 114 plus the tag, so nothing that reads `config.host`/`config.udpMode` today
 * has to change to keep working.
 */
export type NetworkRouteConfigResponse =
  | { engine: 'adb-proxy'; host: string; port: number; exclusions?: string[] }
  | {
      engine: 'adb-reverse-proxy'
      hostPort: number
      /** Allocated by the reverse registry, never chosen by the operator (plan 114 §4.3). Null until a reverse has been established for this route. */
      devicePort: number | null
      exclusions?: string[]
    }
  | {
      engine: 'vpn-helper'
      host: string
      port: number
      /** Names a stored credential (plan 52 §4.2) — never the password. */
      credentialRef?: string
      /**
       * The username stored ALONGSIDE that credential, resolved from
       * `network_credentials` on the way out. Not the password, and never near
       * it: a username is the session string that says WHICH upstream identity
       * this phone is on (`package-…-sessionid-…` for a rotating residential
       * pool), which is the fact an operator needs to read a route rather than
       * a secret to protect. The password has its own deliberate, audited route
       * and appears nowhere in this shape.
       */
      credentialUsername?: string
      udpMode: 'udp' | 'tcp'
      /** Plan 55 §3.1, §4.1 — undefined means no expectation stated; `geo` stays `skip` forever. */
      expect?: Socks5RouteConfig['expect']
      /** Plan 55 §3.5, §4.1 — always concrete here, never `undefined`, so Studio never has to guess a default of its own. */
      onGeoFail: 'report' | 'hold'
    }

export interface NetworkStatusResult {
  engine: NetworkEngineId
  /** Persisted route config, tagged by engine — null when nothing has ever been declared. */
  config: NetworkRouteConfigResponse | null
  /** The operator's declared on/off intent — separate from `config` on purpose (plan 44 step 5.4): the default config is null, and with no config there is nothing to enable. */
  enabled: boolean
  observed: NetworkObservation | null
  drift: boolean
  /** The per-device sticky-session id (plan 52 §4.3), read-only — null until a route has been applied at least once. Always null for the advisory rungs, which have no upstream session to be sticky about. */
  sessionId: string | null
  /** Plan 54 §4.2, §5.6 — whether a failure holds the device closed. Always a concrete boolean here. Meaningless for the advisory rungs (there is nothing to hold closed) and reported as its default there rather than omitted, so the response shape stays one shape. */
  failClosed: boolean
  /** Derived from `checks` via `deriveHealth()` (plan 51 §4.1) — never set directly. Structurally `unverified` at best for both advisory rungs (plan 114 §3.5). */
  health: 'ok' | 'unverified' | 'degraded' | 'unknown'
  /** The named facts `health` was derived from — always present, even when every check is `unknown`. */
  checks: RouteCheck[]
  lastError: { code: string; message: string } | null
  /** Plan 55 §4.3, §5.5 — the last `EXIT_HISTORY_LIMIT` geo observations, newest first. */
  exitHistory: GeoObservation[]
  /** Plan 90 §3.7 rule 5 — bounded automatic recovery's own live state. Always null for the advisory rungs: plan 114 §4.4 keeps the recovery machinery VPN-only, because a settings write either reads back or it does not and retrying one on a backoff would be theatre. */
  recovery: NetworkRecoveryStatus | null
  /**
   * Plan 114 §3.6 — whether this farm holds the device's own pre-farm proxy
   * settings. Only the timestamp is exposed: the UI needs to know whether
   * turning the route off will RESTORE something or merely CLEAR the keys,
   * because those are different outcomes it is required to word differently,
   * and it does not need the values to say so.
   */
  captured: { at: number } | null
  /** Plan 114 §3.3 — who set this route, a person or a plugin. Null on a route written before plan 114, or applied by the core itself (a reconnect re-apply is not somebody setting a route). */
  setBy: { kind: 'user' | 'plugin'; id: string; at: number } | null
  /**
   * A teardown this farm owes the DEVICE (`PersistedNetworkRoute.pendingClear`).
   * Non-null means the record says off and the phone has not been told —
   * settled on the next admission, and the only field on this object that says
   * the device may still be carrying something.
   *
   * `forget` is why the rest of this object may still describe a whole route
   * after a `DELETE`: the row is being held open only to carry the `captured`
   * values and the reverse's device port the teardown still owes the phone, and
   * it goes the moment the debt is settled. Without it a client that just
   * called `DELETE` on an absent phone and got a route back has no way to tell
   * "the delete did not happen" from "the delete is owed".
   */
  pendingClear: { engine: NetworkEngineId; devicePort?: number; forget: boolean; reason: string; since: number } | null
}

/**
 * One row of `POST /network/apply`'s report (plan 114 §3.9, step 114.8).
 *
 * `DeviceNetworkApplyResultSchema` with its `status` swapped for this module's
 * own `NetworkStatusResult`, rather than the protocol's response type. The two
 * describe the same object from opposite ends of the wire — this side carries
 * `captured`, which the response schema does not declare and therefore strips
 * on parse — and re-shaping a status here purely to satisfy a type would mean
 * writing a second, silently-diverging serialiser for the one thing
 * `GET /:id/network` already answers with. The bulk endpoint hands back exactly
 * what a single `PUT` does, per device.
 */
export type BulkApplyResult = Omit<DeviceNetworkApplyResult, 'status'> & { status: NetworkStatusResult | null }

/** Optional per-call knobs for a guest-agent client call — see `guest-agent.ts`'s `createDeviceSession`. */
export interface DeviceSessionCallOpts {
  handshakeRetries?: number
  handshakeRetryDelayMs?: number
}

/**
 * A per-device guest-agent session: owns the token, the forwarded port, and the
 * client. Implemented in `packages/core/src/api/guest-agent.ts` and declared
 * here because this module is what holds one alive for the length of a
 * `vpn-helper` route. The agent holds exactly ONE token at a time, so a device
 * has exactly one of these (plan 44 §8b's "Bug 1").
 */
export interface DeviceSession {
  withClient<T>(fn: (client: GuestAgentClient) => Promise<T>, opts?: DeviceSessionCallOpts): Promise<T>
  readonly active: boolean
  close(): Promise<void>
}

export interface RouteServiceDeps {
  db: Db
  /** Per-device shell exec, through the adb queue (the same shape `Transport.exec` uses). */
  exec: (serial: string, cmd: string, opts?: TransportExecOptions) => Promise<ShellResult>
  apkPath: () => Promise<string>
  leases: LeaseManager
  /** Where the credential store's encryption key lives (plan 52 §4.2). */
  dataDir: string
  log: Logger
  /** Main-stream device events: network.applied/reverted, network.recovery.*. */
  record?: EventRecorder['record']
  /**
   * The farm's audit log — the accountability half of the credential reveal
   * route (`POST /:id/network/credential/reveal`).
   *
   * Optional, and the default is **not** a no-op: it is `createAuditLogger(db)`
   * over this service's own database, i.e. the same rows in the same table the
   * daemon's own logger writes. That matters more here than the usual
   * dependency-injection tidiness does — a missing dep on any other feature
   * costs a log line, and a missing dep on this one would silently turn "every
   * reveal is recorded" into "reveals are recorded when somebody remembered to
   * wire it", which is the one property the feature is built around. Injectable
   * anyway so `daemon.ts` can hand over its own instance (and a test can watch
   * one) without this module ever being able to end up with none.
   */
  audit?: AuditLogger
  /**
   * `vpn-helper`'s two construction seams, owned by `guest-agent.ts` — a route
   * shares the device's ONE bootstrap token with the guest-agent status probe
   * and the agent provisioner, and building a second launcher/session here
   * would reintroduce the token-rotation defect plan 44 §8b fixed.
   */
  makeLauncher: (row: DeviceRow) => GuestAgentLauncher
  makeSession: (row: DeviceRow, launcher?: GuestAgentLauncher) => DeviceSession
  /** Runs `fn` against `row`'s shared session, or a fresh one closed straight afterwards. Also owned by `guest-agent.ts`, for the same reason. */
  withEphemeralSession: <T>(row: DeviceRow, fn: (client: GuestAgentClient) => Promise<T>, opts?: DeviceSessionCallOpts) => Promise<T>
  /** Test seam — real budgets are measured in seconds and tests drive fakes. */
  routeTimings?: { applySettleTimeoutMs?: number; applySettleIntervalMs?: number; revertPollTimeoutMs?: number }
  /** Plan 54 §3.2, §4.2 — the backoff (seconds) between bounded automatic-recovery attempts; length is the attempt bound. Default `[5, 20, 60]`. */
  recoveryBackoffS?: number[]
  /** Raw override for the re-arm delay — takes priority over `guestAgentSettings().recoveryRearmSec`. */
  recoveryRearmS?: number
  /** Plan 55 §3.2, §5.1 — read fresh on every call. */
  networkSettings?: () => { geoProvider?: string; geoIntervalSec: number }
  /** Plan 90 §3.7, §4.4 — read fresh on every call. */
  guestAgentSettings?: () => { maxRecoveryCyclesPerHour: number; recoveryRearmSec: number }
  /** Plan 90 §3.8 — used only to clear a stale `failed` agent badge once a route proves the agent alive. */
  agentProvisioner?: {
    ensure: (deviceId: string, opts?: { force?: boolean }) => Promise<unknown>
    status?: (deviceId: string) => Promise<{ state: string }>
  }
  /**
   * Plan 114 §4.3, step 114.4 — `adb reverse` and the map that survives a
   * replug. Optional so every existing test that has no opinion about rung 2
   * keeps constructing this service unchanged; when absent, an
   * `adb-reverse-proxy` route is refused rather than silently applied without
   * its tunnel.
   */
  reverse?: ReverseRegistry
}

/**
 * The one door, as three functions (plan 114 §3.3, step 114.9).
 *
 * Everything that is not an HTTP request reaches a device's route through
 * exactly this — today that is `device.network.get`/`.set`/`.clear`
 * (`packages/core/src/capability/device-network.ts`), which is how a plugin
 * with `device.network` gets there. It is deliberately not wider than the HTTP
 * surface it mirrors, and deliberately not narrower: `set` runs the SAME lease
 * admission, the SAME credential refusal, the SAME `network-route` lock and
 * writes the SAME attributed device event that `PUT /api/devices/:id/network`
 * does, because it IS that handler's body.
 *
 * `actor` is a principal string: a user id, or plan 109's `plugin:<name>`.
 * `null` means the core acting on its own and stamps no `setBy` at all — see
 * `stampSetBy`.
 */
export interface DeviceNetworkPort {
  get(deviceId: string): Promise<NetworkStatusResult>
  /** `raw` is an unparsed `NetworkRouteConfig` body — parsed, tagged and refused inside, exactly as an HTTP body is. */
  set(deviceId: string, raw: unknown, actor: string | null): Promise<NetworkStatusResult>
  clear(deviceId: string, actor: string | null): Promise<NetworkStatusResult>
}

export interface RouteService {
  /** `GET/PUT/DELETE /:id/network`, `/:id/network/{enable,disable,retry}`, and the named-credential routes. Mounted by `createGuestAgentRoutes` under the same `/api/devices` prefix. */
  routes: Hono<AuthEnv>
  /** The same three operations the HTTP routes above expose, for callers that are not HTTP requests (step 114.9). */
  device: DeviceNetworkPort
  revertNetwork: (deviceId: string, actor?: string | null) => Promise<void>
  restoreDeviceRoute: (deviceId: string) => Promise<void>
  handleDeviceOffline: (deviceId: string) => Promise<void>
  reconcileNetworkRoutes: () => Promise<void>
  /**
   * The persisted on/off intent for a device, for the reverse registry's
   * `routeEnabled` veto (plan 114 §4.3): a route an operator disabled while the
   * phone was away must not come back just because the phone did.
   */
  isRouteEnabled: (deviceId: string) => boolean
  /**
   * Clears a device's persisted route entirely and stops the heartbeat if that
   * was the last enabled VPN route. `DELETE /:id/guest-agent` (uninstall)
   * calls it after its own `revertNetwork`: leaving `enabled: true` pointed at
   * a package that no longer exists is incoherent, and it actively fights the
   * operator — the reconcile/heartbeat loop keeps trying to reach an agent that
   * is gone and the provisioning path puts it back, so the app reappears on
   * screen seconds after an uninstall. Observed exactly that way.
   */
  clearRoute: (deviceId: string) => void
  /** The live `DeviceSession` a `vpn-helper` route is holding for this device, if any — `guest-agent.ts`'s `withEphemeralSession` consults this so a status probe never mints a second token. */
  activeSessionOf: (deviceId: string) => DeviceSession | null
}

/** The lease admission check every mutating network/guest-agent endpoint takes (plan 44 §5.7). Exported so `guest-agent.ts`'s own install/uninstall endpoints take the identical one rather than a second, drifting copy. */
export function requireHeldLease(leases: LeaseManager, deviceId: string): void {
  const lease = leases.getLease(deviceId)
  const allowed = leases.checkInputAllowed(deviceId, lease?.holder ?? '')
  if (!allowed.ok) throw new EnkakuError(allowed.code, allowed.message)
}

/**
 * **The DISARM direction's admission — the one place `device_unavailable` is
 * not the end of the request.**
 *
 * `requireHeldLease` above refuses an offline device outright, because every
 * endpoint it guards writes something to a phone. That is the right rule for
 * turning a route ON: applying a route to a phone you cannot reach is a promise
 * you cannot keep, and `/enable`, `PUT` and `/retry` keep taking it unchanged.
 *
 * It is the WRONG rule for turning one off, and offline is exactly the case
 * where turning it off matters most. The measured shape of the problem: two
 * phones sat at another location carrying enabled routes — one an
 * `adb-reverse-proxy` pointed at a metered upstream, one a `failClosed`
 * `vpn-helper` — and `DELETE /network` and `/network/disable` both answered
 * `409 device_unavailable`. The operator's only option was to wait for the
 * phone to come back, let the route re-arm on admission, and turn it off
 * afterwards. For the fail-closed one that is the shape of an incident this
 * farm has already had: a `RouteVpnService` armed with a kill switch and no
 * farm connection left a phone with no internet at all.
 *
 * A lease is not merely unheld for such a device, it is **unobtainable**:
 * `acquireManual` refuses any status but `idle`/`manual` with this same code.
 * So the gate is not "take control first", it is "you may never turn this off".
 *
 * What makes widening it safe is that the machinery for "we could not reach the
 * phone" already exists and predates nothing: `revertNetwork` records the
 * teardown as a `pendingClear` debt on the row instead of claiming an off that
 * did not happen, and `clearOrphanedRoute` settles it — with a real teardown,
 * not a bookkeeping-only clear — on the device's next admission. The gate was
 * refusing the request *before* the machinery built for it could run.
 *
 * **Exactly one code is let through, and nothing else about the check changes:**
 *
 * - `device_unavailable` (`offline`, and `quarantined`) — allowed. Both are
 *   states in which no lease can be taken, so the off button is unreachable for
 *   the same reason; and a quarantined phone still carrying a farm route
 *   through somebody's paid upstream is the same hazard as an offline one. A
 *   quarantined device is often still reachable over adb, in which case the
 *   teardown below simply lands and no debt is recorded at all.
 * - `device_busy` — still refused. A job is driving that phone right now, and
 *   pulling its route out from under it is not a disarm, it is a collision.
 * - `no_lease` / `not_lease_holder` — still refused. The device is ONLINE and
 *   takeable; "take control first" is a real instruction there, and somebody
 *   else may be driving it.
 * - `device_not_found` — still refused, obviously.
 */
export function requireDisarmAdmission(leases: LeaseManager, deviceId: string): void {
  const lease = leases.getLease(deviceId)
  const allowed = leases.checkInputAllowed(deviceId, lease?.holder ?? '')
  if (allowed.ok) return
  if (allowed.code === 'device_unavailable') return
  throw new EnkakuError(allowed.code, allowed.message)
}

/** Reads a device row or throws `device_not_found`. Exported for the same reason `requireHeldLease` is. */
export function mustGetDevice(db: Db, id: string): DeviceRow {
  const row = db.select().from(devices).where(eq(devices.id, id)).get()
  if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
  return row
}

/**
 * `fallbackCode` lets each call site say what KIND of operation failed (apply vs. observe) for
 * an error this file cannot otherwise put a code on — a `GuestAgentClientError` or `EnkakuError`
 * always carries its own code regardless of `fallbackCode` (plan 44 §8b, "Bug 2": a read that
 * fails must never be reported as an apply failure). A `HttpProxyError` from `@enkaku/drivers`
 * carries a `.code` field of its own too, and is matched structurally rather than by `instanceof`
 * so a duplicated module instance in a test cannot silently downgrade it to the fallback.
 */
export function toCodedError(err: unknown, fallbackCode: string): { code: string; message: string } {
  if (err instanceof GuestAgentClientError) return { code: err.code, message: err.message }
  if (err instanceof EnkakuError) return { code: err.code, message: err.message }
  if (err instanceof Error) {
    const coded = (err as { code?: unknown }).code
    if (typeof coded === 'string' && coded.startsWith('E_')) return { code: coded, message: err.message }
    return { code: fallbackCode, message: err.message }
  }
  return { code: fallbackCode, message: String(err) }
}

/**
 * Plan 114 §3.8 — a device setting is never a place for a credential, and the
 * refusal is by name and by code, not a warning.
 *
 * Runs against the RAW request body, before the union parses it, and that is
 * load bearing: a Zod object strips unknown keys by default, so
 * `{ engine: 'adb-proxy', host, port, username: 'x' }` would otherwise parse
 * cleanly with the username silently dropped — the operator would be told their
 * authenticated proxy was applied, and it would not be.
 *
 * Three triggers, all of them things an operator actually does: a `username`/
 * `password` field; a `credentialRef` naming a stored credential (there is
 * nowhere on the device to spend it); and a host carrying a URL userinfo
 * component, which is what pasting `http://user:pass@host:8080` into a host box
 * produces. Studio refuses the last one in its own paste parser (step 114.6);
 * this is the same refusal for a client that skipped it.
 */
export function assertNoHttpProxyAuth(raw: unknown, engine: NetworkEngineId): void {
  if (engine !== 'adb-proxy' && engine !== 'adb-reverse-proxy') return
  const refuse = (what: string): never => {
    throw new EnkakuError(
      'E_HTTP_PROXY_NO_AUTH',
      `${what} cannot be used with this proxy mode. Android's system proxy setting has no place for a username or password, and every app on the phone can read it. To use a proxy that needs an account, run it on this farm's machine — the phone dials it over the adb connection and the account never reaches the phone.`,
    )
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const body = raw as Record<string, unknown>
  if (typeof body.username === 'string' && body.username.length > 0) refuse('a username')
  if (typeof body.password === 'string' && body.password.length > 0) refuse('a password')
  if (typeof body.credentialRef === 'string' && body.credentialRef.length > 0) refuse('a stored credential')
  // `//user:pass@host` and the bare `user:pass@host` a paste box produces once the scheme has been
  // stripped. Only a userinfo segment is refused — a bare `@` (an IPv6 zone id, say) is not a
  // credential and refusing it would be a guess.
  for (const key of ['host', 'url', 'proxyUrl']) {
    const value = body[key]
    if (typeof value !== 'string') continue
    if (/(^|\/\/)[^/@\s:]+:[^/@\s]*@/.test(value)) refuse('a proxy URL carrying a username and password')
  }
}

/**
 * The advisory rungs' `upstream` check (plan 114 §3.5), and a deliberately
 * narrow one.
 *
 * **What a pass means:** THIS machine opened a TCP connection to the declared
 * `host:port`. That is a real fact and it is the one an operator most often
 * needs (a typo'd port, a proxy that is not running).
 *
 * **What it does not do:** it does not attempt an HTTP `CONNECT` handshake, so
 * it cannot tell an HTTP proxy from anything else listening on that port. §3.5
 * asks for the handshake too; it needs a target host to CONNECT to, which is a
 * second decision (whose host? the probe endpoint's?) that this step does not
 * make on the operator's behalf. The check's own `detail` says which of the two
 * it did, so nobody reads more into a pass than it carries.
 *
 * **What a fail means, and why it is still a fail.** The host is not the phone:
 * a proxy on the phone's own LAN that this farm cannot see fails here while
 * working perfectly on the device. Plan 114 §3.7's "upstream dies" row
 * nonetheless calls for `upstream: fail` and the `degraded` health that follows
 * from it, because something measurably did not answer and the operator should
 * look. The detail says, in the response, that the dial ran from the farm and
 * not from the device, so the reading is never left to be inferred.
 */
async function runUpstreamCheck(host: string, port: number): Promise<{ ok: boolean; detail: string; at: number }> {
  const outcome = await defaultTcpPreProbe(host, port, UPSTREAM_PROBE_TIMEOUT_MS)
  const at = nowSeconds()
  if (outcome === 'accepted') {
    return { ok: true, detail: `this machine opened a TCP connection to ${host}:${port} (no proxy CONNECT was attempted)`, at }
  }
  return {
    ok: false,
    detail: `this machine could not reach ${host}:${port} (${outcome}) — the check runs from the farm, not from the device, so a phone on a different network may still reach it`,
    at,
  }
}

export function createRouteService(deps: RouteServiceDeps): RouteService {
  const app = new Hono<AuthEnv>()
  const { db } = deps
  /** The named-credential store (plan 52 §4.2) — every route below that touches a secret goes through this, never the raw DB row. */
  const credentials = createCredentialStore({ db, dataDir: deps.dataDir })
  /** See `RouteServiceDeps.audit` for why the fallback is a real logger over the same database rather than a no-op. */
  const audit: AuditLogger = deps.audit ?? createAuditLogger(db)
  /** See `RouteServiceDeps.networkSettings`'s doc comment for the default's meaning. */
  const networkSettings: () => { geoProvider?: string; geoIntervalSec: number } = deps.networkSettings ?? (() => ({ geoIntervalSec: 300 }))
  /** See `RouteServiceDeps.guestAgentSettings`'s doc comment for the default's meaning. */
  const guestAgentSettings: () => { maxRecoveryCyclesPerHour: number; recoveryRearmSec: number } =
    deps.guestAgentSettings ?? (() => ({ maxRecoveryCyclesPerHour: 4, recoveryRearmSec: 120 }))

  const mustGet = (id: string): DeviceRow => mustGetDevice(db, id)

  // ---- named credentials (plan 52 §4.2, §5.1) ----
  //
  // Mounted under `/api/devices` (same as everything else this service and `guest-agent.ts`
  // serve). `/network/credentials` cannot collide with the `/:id/...` device-scoped routes below:
  // no device route has a literal second path segment of `credentials`.

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
   * One device's in-memory record of a route (plan 44 step 5.4). The durable
   * source of truth for `config`/`enabled` is `devices.network_route`
   * (`readPersistedRoute`/`writePersistedRoute` below) — this map only holds
   * what cannot survive a restart: the live driver object, its backing session,
   * and the last thing it reported.
   */
  interface NetworkRouteEntry {
    /**
     * The live `NetworkRoute` for a route this PROCESS itself applied — null
     * for a "cold" entry adopted from persisted state without calling
     * `apply()`. Typed against the whole union so one map can hold either
     * engine's route; `buildEngine` is the only thing that puts one here.
     */
    route: NetworkRoute<NetworkRouteConfig> | null
    /** The `DeviceSession` backing `route` — non-null exactly when a `vpn-helper` route is live. The advisory rungs need no session at all: a settings write is one `adb shell` call (plan 114 F8). */
    session: DeviceSession | null
    observed: NetworkObservation | null
    /** Unix seconds `observed` was last actually refreshed — feeds `tunnel`'s/`setting`'s `at` (plan 51 §4.1). */
    observedAt: number | null
    health: 'ok' | 'unverified' | 'degraded' | 'unknown'
    /** The named facts `health` was derived from. */
    checks: RouteCheck[]
    lastError: { code: string; message: string } | null
    /** Result of the most recent `egress.probe` wire call, or null if one has never completed. `vpn-helper` only. */
    probeResult: EgressProbeResult | null
    /** Unix seconds `probeResult` (or `probeError`) was last set. */
    probeAt: number | null
    /** The most recent `egress.probe` WIRE CALL failure. `vpn-helper` only. */
    probeError: { code: string; message: string } | null
    /** From the device's own `hello().capabilities` — null until fetched at least once. */
    agentCapabilities: string[] | null
    /** Plan 55 §3.2, §4.2, §5.3 — the most recent geo lookup for the CURRENT egress address. `vpn-helper` only. */
    geoObservation: GeoObservation | null
    /** Unix seconds `geoObservation` (or `geoError`) was last set. */
    geoAt: number | null
    /** A geo lookup that ran and failed — distinct from never having run. */
    geoError: { code: string; message: string } | null
    /** Plan 51 §4.3, §5.3 — the `dns` check's own most recent result. */
    dnsResult: { state: 'pass' | 'fail' | 'unknown'; detail?: string; at: number } | null
    /** Plan 114 §3.5 — the advisory rungs' host-side `upstream` dial. Null until one has run. */
    upstreamCheck: { ok: boolean; detail: string; at: number } | null
    /** Plan 114 §3.5 — rung 2's `reverse` check. Null until one has run. */
    reverseCheck: { ok: boolean; detail: string; at: number } | null
  }

  function emptyEntry(): NetworkRouteEntry {
    return {
      route: null,
      session: null,
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
      upstreamCheck: null,
      reverseCheck: null,
    }
  }

  const networkStateByDevice = new Map<string, NetworkRouteEntry>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // ---- bounded recovery (plan 54 §3.2, §4.2) ----
  //
  // Deliberately NOT stored on `NetworkRouteEntry`: `coldProbe()` below replaces that object
  // wholesale on every call, which would silently reset any counter kept on it. This map is the
  // one thing that survives across those replacements, and it is the ONLY place either
  // `restoreDeviceRoute` or `heartbeatTick` may attempt a recovery apply from — "one owner, one
  // counter" (plan 54 §4.2).
  //
  // Plan 114 §4.4 keeps every line of this VPN-only. There is nothing to recover in an advisory
  // mode: the setting either reads back or it does not, and retrying a settings write on a
  // backoff would be theatre.
  const recoveryBackoffS = deps.recoveryBackoffS ?? [5, 20, 60]
  const RECOVERY_MAX_ATTEMPTS = recoveryBackoffS.length
  /** `recoveryBackoffS[i]`, clamped to the last entry — `noUncheckedIndexedAccess` requires this even though `i` is always in bounds for every call site below. */
  function backoffAt(i: number): number {
    return recoveryBackoffS[i] ?? recoveryBackoffS[recoveryBackoffS.length - 1] ?? 0
  }

  interface RecoveryState {
    attempts: number
    /** Unix seconds; an attempt before this time is skipped (the backoff between attempts). */
    nextAttemptAt: number
    /** The bound was reached without success — stop retrying, and a check now says why (plan 54 §3.2). */
    exhausted: boolean
    /** Set alongside `exhausted` — re-applied to the entry on every subsequent tick, since a cold probe would otherwise overwrite it with its own `lastError: null`. */
    exhaustedMessage: string | null
    /** Unix seconds the bound was reached, so it can be re-armed after `recoveryRearmS()`. */
    exhaustedAt: number
    /** True while an attempt is actually in flight — guards against `restoreDeviceRoute` and `heartbeatTick` racing onto two concurrent applies for the same device. */
    pending: boolean
    /** Unix seconds of the last time `handleDeviceOffline` saw this device go offline (plan 90 §3.7 rule 1). */
    offlineAt: number
    /** Unix-second timestamps of resets `resetRecoveryOnReconnect` has granted, still inside the rolling one-hour window (plan 90 §3.7 rule 2). */
    reconnectCycles: number[]
    /** True once the breaker has already logged its one `warn` for the current run of engagement. */
    breakerWarned: boolean
  }
  /**
   * How long an exhausted bound stays exhausted before the schedule re-arms and recovery is tried
   * again from scratch (plan 54 §9 open question 2). `exhausted` used to be permanent for as long
   * as the process lived — a device hit the bound against a transient failure, gave up, and was
   * still sitting there six hours later. Reads `guestAgent.recoveryRearmSec` fresh on every call
   * (plan 90 §3.7 rule 3, fixes F15).
   */
  function recoveryRearmS(): number {
    return deps.recoveryRearmS ?? guestAgentSettings().recoveryRearmSec
  }
  /** `guestAgent.maxRecoveryCyclesPerHour`, read fresh on every call. */
  function maxRecoveryCyclesPerHour(): number {
    return guestAgentSettings().maxRecoveryCyclesPerHour
  }
  /** The breaker's own rolling window (plan 90 §3.7 rule 2) — fixed at one hour; only the threshold is a setting. */
  const RECONNECT_CYCLE_WINDOW_S = 3600
  const recoveryByDevice = new Map<string, RecoveryState>()

  function resetRecovery(deviceId: string): boolean {
    return recoveryByDevice.delete(deviceId)
  }

  /**
   * 96.25 fix 3: a route just proved live traffic THROUGH the guest agent —
   * direct evidence the agent is alive, arriving over a completely different
   * path than the provisioner's own bounded retry schedule. Deliberately gated
   * on the cached state actually being `failed`.
   */
  function clearStaleAgentFailure(deviceId: string): void {
    if (!deps.agentProvisioner?.status) return
    void deps.agentProvisioner
      .status(deviceId)
      .then((status) => {
        if (status.state !== 'failed') return
        return deps.agentProvisioner?.ensure(deviceId, { force: true })
      })
      .catch((err) => deps.log.warn(`clearStaleAgentFailure(${deviceId}) failed, tolerated: ${String(err)}`))
  }

  /**
   * The fix for F16 (plan 90 §3.7 rules 1–2): called ONLY from `restoreDeviceRoute`'s enabled
   * branch, i.e. only on an actual reconnect, never from `heartbeatTick`'s routine polling — a
   * heartbeat tick that merely finds the route still down must never look like new information.
   */
  function resetRecoveryOnReconnect(deviceId: string): void {
    const r = recoveryByDevice.get(deviceId)
    if (!r) return
    if (!(r.offlineAt > r.exhaustedAt)) return

    const now = nowSeconds()
    const cutoff = now - RECONNECT_CYCLE_WINDOW_S
    r.reconnectCycles = r.reconnectCycles.filter((t) => t > cutoff)

    const max = maxRecoveryCyclesPerHour()
    if (r.reconnectCycles.length >= max) {
      if (!r.breakerWarned) {
        r.breakerWarned = true
        deps.log.warn(
          `network restore: device ${deviceId} reconnected ${r.reconnectCycles.length} time(s) in the last hour — the reconnect-cycle breaker is engaged, no more automatic resets until it decays; the ${recoveryRearmS()}s re-arm clock is what retries next`,
        )
      }
      return
    }

    r.reconnectCycles.push(now)
    r.breakerWarned = false
    r.attempts = 0
    r.exhausted = false
    r.exhaustedMessage = null
    r.nextAttemptAt = now + backoffAt(0)
    deps.log.info(
      `network restore: device ${deviceId} reconnected after the recovery bound was reached — resetting for a fresh attempt (reconnect cycle ${r.reconnectCycles.length}/${max} this hour)`,
    )
  }

  /**
   * The one place either `restoreDeviceRoute` or `heartbeatTick` may attempt a recovery apply
   * (plan 54 §4.2) — `entry` must already reflect this tick's own probe/observe, since this never
   * probes on its own. `vpn-helper` only (plan 114 §4.4): the callers narrow before reaching here.
   */
  async function maybeRecoverRoute(row: DeviceRow, persisted: PersistedNetworkRoute, config: Socks5RouteConfig, entry: NetworkRouteEntry): Promise<void> {
    const deviceId = row.id
    if (entry.observed?.up === true) {
      // Already carrying its route — never re-applied (plan 52 §3.2, plan 54 acceptance #6).
      const hadState = recoveryByDevice.get(deviceId)
      if (resetRecovery(deviceId)) {
        deps.log.info(`network restore: device ${deviceId} recovered`)
        clearStaleAgentFailure(deviceId)
        // Plan 90 §3.7 rule 5 — only worth an event when this device genuinely needed recovery.
        // `exhaustedAt > 0`, not `hadState.exhausted`: `resetRecoveryOnReconnect` clears
        // `attempts`/`exhausted` the moment a genuine reconnect resets the bound, and
        // `exhaustedAt` is what still remembers this device needed recovery a moment ago.
        if (hadState && (hadState.attempts > 0 || hadState.exhausted || hadState.exhaustedAt > 0)) {
          deps.record?.({
            deviceId,
            stream: 'main',
            kind: 'network.recovery.recovered',
            actor: null,
            meta: { attempts: hadState.attempts, wasExhausted: hadState.exhausted || hadState.exhaustedAt > 0 },
          })
        }
      } else {
        deps.log.info(`network restore: device ${deviceId} already carries its route — probed and left alone`)
      }
      return
    }

    const now = nowSeconds()
    let r = recoveryByDevice.get(deviceId)
    if (!r) {
      // Waits `recoveryBackoffS[0]` before the FIRST attempt too, not just between retries — a
      // device that just reconnected may still be settling.
      r = {
        attempts: 0,
        nextAttemptAt: now + backoffAt(0),
        exhausted: false,
        exhaustedMessage: null,
        exhaustedAt: 0,
        pending: false,
        offlineAt: 0,
        reconnectCycles: [],
        breakerWarned: false,
      }
      recoveryByDevice.set(deviceId, r)
    }
    if (r.exhausted && now - r.exhaustedAt >= recoveryRearmS()) {
      // Re-arm rather than stay given-up forever (see `recoveryRearmS()`). The message is left in
      // place until an attempt actually succeeds.
      r.attempts = 0
      r.exhausted = false
      r.nextAttemptAt = now + backoffAt(0)
      deps.log.info(`network restore: device ${deviceId} — retry window re-armed after ${recoveryRearmS()}s`)
    }
    if (r.exhausted) {
      // `entry` reflects THIS tick's own fresh probe/observe, which would silently erase the
      // "gave up" answer the very next tick if this did not re-apply it.
      if (r.exhaustedMessage) {
        entry.lastError = { code: 'E_NETWORK_RECOVERY_EXHAUSTED', message: r.exhaustedMessage }
        recomputeChecks(entry, config)
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
      // `actor: null` — this is the core acting on its own, not a user.
      await applyVpnRoute(row, config, null)
      // `applyVpnRoute`/`vpn-helper.ts`'s `apply()` does NOT throw just because the device never
      // reaches `up` within its own settle window, so a bare absence-of-throw here is NOT proof of
      // recovery. Confirming `observed.up` is what stops a permanently-held device from being
      // declared "recovered" forever while still not carrying traffic.
      const settled = networkStateByDevice.get(deviceId)
      if (settled?.observed?.up !== true) {
        throw new EnkakuError('E_NETWORK_APPLY_FAILED', 'applied, but the device still does not report the route up')
      }
      recoveryByDevice.delete(deviceId)
      deps.log.info(`network restore: device ${deviceId} recovered on attempt ${attempt}`)
      clearStaleAgentFailure(deviceId)
      deps.record?.({
        deviceId,
        stream: 'main',
        kind: 'network.recovery.recovered',
        actor: null,
        meta: { attempts: attempt },
      })
    } catch (err) {
      if (attempt >= RECOVERY_MAX_ATTEMPTS) {
        r.exhausted = true
        r.exhaustedAt = nowSeconds()
        r.exhaustedMessage = `automatic recovery gave up after ${RECOVERY_MAX_ATTEMPTS} attempts; the route stays enabled and will be retried in ${recoveryRearmS()}s — apply manually to try sooner`
        deps.log.warn(`network restore: device ${deviceId}: ${r.exhaustedMessage} (${err instanceof Error ? err.message : String(err)})`)
        deps.record?.({
          deviceId,
          stream: 'main',
          kind: 'network.recovery.exhausted',
          actor: null,
          meta: { attempts: RECOVERY_MAX_ATTEMPTS, message: r.exhaustedMessage },
        })
        // `applyVpnRoute` already set its own entry's `lastError` to the raw apply failure — this
        // OVERWRITES it with the "gave up" message. Re-fetched rather than using the `entry` this
        // function was called with: the apply may have replaced `networkStateByDevice`'s value.
        const live = networkStateByDevice.get(deviceId)
        if (live) {
          live.lastError = { code: 'E_NETWORK_RECOVERY_EXHAUSTED', message: r.exhaustedMessage }
          recomputeChecks(live, config)
        }
      } else {
        // `backoffAt(attempt)`, not `(attempt - 1)` — index 0 already paid for the wait before
        // THIS attempt.
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
   *
   * Since plan 114 `config` is the discriminated union behind
   * `tagUntaggedRouteConfig`, so a row written before this plan — which has no
   * `engine` key at all — still parses, as `vpn-helper`, by construction rather
   * than by guess: it is the only engine that could have written one.
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

  /** The persisted route for a device id, or null — used by every path that starts from an id rather than a row. */
  function persistedFor(deviceId: string): { row: DeviceRow; persisted: PersistedNetworkRoute } | null {
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
    if (!row) return null
    const persisted = readPersistedRoute(row)
    return persisted ? { row, persisted } : null
  }

  /**
   * Moves every device's inline `username`/`password` (plan 44's original, pre-credential-store
   * shape) into a named credential, rewriting `config` to reference it by `credentialRef` instead
   * (plan 52 §4.2, §5.1's migration — "nothing is lost"). Runs SYNCHRONOUSLY, once, at
   * construction, before anything else in this module ever reads a persisted route.
   *
   * Idempotent, and now also engine-aware: only a `vpn-helper` config can carry inline
   * credentials at all — the advisory rungs refuse one by construction (plan 114 §3.8).
   */
  function migrateInlineCredentials(): void {
    const rows = db.select().from(devices).all()
    for (const row of rows) {
      const persisted = readPersistedRoute(row)
      if (!persisted) continue
      const { config } = persisted
      if (config.engine !== 'vpn-helper') continue
      if (config.credentialRef || (config.username === undefined && config.password === undefined)) continue
      const name = credentials.uniqueName(`migrated-${row.id}`)
      credentials.create({ name, username: config.username, secret: config.password ?? '', createdBy: null })
      writePersistedRoute(row.id, {
        ...persisted,
        config: { engine: 'vpn-helper', host: config.host, port: config.port, udpMode: config.udpMode, credentialRef: name },
      })
      deps.log.info(`network: migrated device ${row.id}'s inline credentials into a named credential ("${name}")`)
    }
  }
  migrateInlineCredentials()

  /**
   * The username a `vpn-helper` route authenticates as, or null when it
   * authenticates anonymously — the non-secret half of the credential, and the
   * only half `GET /:id/network` ever carries.
   *
   * Reads `.username` off the row and nothing else. `findByName` hands back the
   * whole `network_credentials` row, encrypted `secret` field included, so a
   * spread of that row is precisely how a ciphertext would leak into a response
   * a panel polls; naming the one field is what stops that from ever being a
   * one-character mistake.
   *
   * A credential named by a route that has since been deleted resolves to null
   * rather than throwing: the route is already broken and `GET /:id/network` is
   * how an operator finds out, so failing the whole status read would hide the
   * very thing they came to look at.
   */
  function credentialUsernameFor(config: Socks5RouteConfig): string | null {
    if (config.credentialRef !== undefined) {
      return credentials.findByName(config.credentialRef)?.username ?? null
    }
    // A row written before plan 52's migration ran still carries its username inline. Same fact,
    // same route — hiding it would make an unmigrated device the one device whose upstream
    // identity is unreadable.
    return config.username ?? null
  }

  function toConfigResponse(deviceId: string, persisted: PersistedNetworkRoute): NetworkRouteConfigResponse {
    const config = persisted.config
    if (config.engine === 'adb-proxy') {
      return { engine: 'adb-proxy', host: config.host, port: config.port, ...(config.exclusions ? { exclusions: config.exclusions } : {}) }
    }
    if (config.engine === 'adb-reverse-proxy') {
      return {
        engine: 'adb-reverse-proxy',
        hostPort: config.hostPort,
        devicePort: reverseDevicePort(deviceId, persisted),
        ...(config.exclusions ? { exclusions: config.exclusions } : {}),
      }
    }
    const vpnUsername = credentialUsernameFor(config)
    return {
      engine: 'vpn-helper',
      host: config.host,
      port: config.port,
      // `credentialRef` names a stored credential (plan 52 §4.2) — never the password.
      ...(config.credentialRef !== undefined ? { credentialRef: config.credentialRef } : {}),
      // The USERNAME half — see `credentialUsernameFor` for what it does and does not read.
      ...(vpnUsername !== null ? { credentialUsername: vpnUsername } : {}),
      udpMode: config.udpMode,
      // Plan 55 §4.1, §4.4 — no credential to redact in either field, unlike everything above.
      ...(config.expect !== undefined ? { expect: config.expect } : {}),
      onGeoFail: resolveOnGeoFail(config),
    }
  }

  /**
   * The `http_proxy` value an advisory route declares — one definition, shared
   * by the write (`@enkaku/drivers`' `httpProxyValue`), the `setting` check's
   * comparison, and `computeDrift`. Rung 2's value points at the device's own
   * loopback and the port the reverse registry allocated, which is why it needs
   * the persisted allocation rather than the config alone.
   */
  function advisoryDeclaredValue(deviceId: string, persisted: PersistedNetworkRoute): string {
    const config = persisted.config
    if (config.engine === 'adb-proxy') return httpProxyValue(config)
    if (config.engine === 'adb-reverse-proxy') {
      const devicePort = reverseDevicePort(deviceId, persisted)
      // `reverseProxyValue` rather than a literal: the engine that WRITES this value and the
      // check that compares the device's answer against it share one definition of the format
      // (plan 114 §3.5), exactly as `httpProxyValue` does for rung 1.
      return devicePort === null ? '' : reverseProxyValue(devicePort)
    }
    return ''
  }

  /**
   * Rung 2's device-side port: the live registry first, then the persisted
   * allocation (plan 114 §4.3). A running core knows the truth; a core that has
   * just restarted knows what it allocated last time and has to honour it
   * exactly, because the phone's own `http_proxy` is still pointing at it.
   */
  function reverseDevicePort(deviceId: string, persisted: PersistedNetworkRoute): number | null {
    return deps.reverse?.get(deviceId)?.devicePort ?? persisted.reverse?.devicePort ?? null
  }

  /** `config` and `observed` disagree while the route is meant to be on. Never true while `enabled` is false: a route the operator turned off is not "drifting" just because it is down. */
  function computeDrift(deviceId: string, persisted: PersistedNetworkRoute, observed: NetworkObservation | null): boolean {
    if (!persisted.enabled) return false
    if (!observed) return false
    if (persisted.config.engine !== 'vpn-helper') {
      const declared = advisoryDeclaredValue(deviceId, persisted)
      return (observed.upstream ?? '') !== declared
    }
    if (!observed.up) return true
    if (observed.upstream && observed.upstream !== `${persisted.config.host}:${persisted.config.port}`) return true
    return false
  }

  /**
   * The literal secret strings a check `detail` must never contain (acceptance criterion 8, plan
   * 51 §6; plan 52 §4.2 for the credential-store path). Only a `vpn-helper` config can have one:
   * plan 114 §3.8 refuses a credential on both advisory rungs, so there is nothing to scrub there.
   */
  function secretsFor(config?: NetworkRouteConfig): string[] {
    if (!config || config.engine !== 'vpn-helper') return []
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
   * Recomputes `entry.checks`/`entry.health` for a `vpn-helper` route from whatever the entry
   * currently holds — the ONE place `health` is ever set for that engine (plan 51 §4.1: derived,
   * never stored directly). Call this after mutating any of those fields, not before.
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

  /** The advisory rungs' half of `recomputeChecks` — plan 114 §3.5's own table. `health` is structurally never better than `unverified` here. */
  function recomputeAdvisoryChecks(deviceId: string, entry: NetworkRouteEntry, persisted: PersistedNetworkRoute): void {
    const engine = persisted.config.engine
    if (engine === 'vpn-helper') return
    entry.checks = buildAdvisoryChecks({
      engine,
      declaredValue: advisoryDeclaredValue(deviceId, persisted),
      observed: entry.observed,
      observedAt: entry.observedAt,
      lastError: entry.lastError,
      upstream: entry.upstreamCheck,
      reverse: entry.reverseCheck,
    })
    entry.health = deriveHealth(entry.checks)
  }

  /** Best-effort: a capability refresh failing must never fail the caller. */
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
   * `force`. Never throws.
   */
  async function maybeRunProbe(entry: NetworkRouteEntry, route: NetworkRoute<NetworkRouteConfig>, force: boolean): Promise<void> {
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
      // The previous result (if any) is now stale evidence of a route that may have changed.
      entry.probeResult = null
    }
    entry.probeAt = nowSeconds()
  }

  /**
   * Plan 55 §3.4, §4.2, §4.3, §5.3, §5.4, §5.6 — the `geo`/`dns` checks' own I/O, sharing
   * `maybeRunProbe`'s throttle-and-force pattern but on `network.geoIntervalSec`'s own slower
   * cadence. Called AFTER `maybeRunProbe` at every one of its call sites. Never throws.
   */
  async function maybeRunGeoAndDns(
    row: DeviceRow,
    config: Socks5RouteConfig,
    entry: NetworkRouteEntry,
    route: NetworkRoute<NetworkRouteConfig>,
    force: boolean,
  ): Promise<void> {
    const net = networkSettings()
    const now = nowSeconds()
    if (!force && entry.geoAt !== null && now - entry.geoAt < net.geoIntervalSec) return

    // Nothing to look up without BOTH a provider and a fresh egress address — leave whatever
    // `entry.geoObservation` already holds untouched, and never advance `geoAt`.
    const address = parseEgressAddress(entry.probeResult?.tunnelled.body)
    if (!net.geoProvider || !address) return

    const observation = await lookupGeo(net.geoProvider, address)
    if (observation) {
      entry.geoObservation = observation
      entry.geoError = null
      // Plan 55 §3.4, §4.3 — the history ring is appended to for EVERY fresh observation, whether
      // or not an `expect` is declared. Re-read FRESH from the DB rather than trusting `row`: the
      // caller's `row` is frequently a snapshot taken BEFORE that same caller's own
      // `writePersistedRoute` call.
      const persisted = readPersistedRoute(mustGet(row.id))
      if (persisted) {
        writePersistedRoute(row.id, { ...persisted, exitHistory: pushExitHistory(persisted.exitHistory, observation) })
      }
    } else {
      entry.geoError = { code: 'E_NETWORK_GEO_LOOKUP_FAILED', message: `geo lookup for ${address} failed or returned an unparseable response` }
    }
    entry.geoAt = now

    // dns (Plan 51 §4.3, §5.3) — needs the delegated zone, the SAME geo provider, and the agent's
    // egress-probe capability.
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
              // ASN first — far more stable and less ambiguous than an ISP display name.
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
    // that way). Best-effort.
    if (config.expect && entry.geoObservation && resolveOnGeoFail(config) === 'hold' && route.hold && entry.agentCapabilities?.includes('route-hold')) {
      const result = matchGeoExpectation(config.expect, entry.geoObservation)
      if (!result.matches) {
        await route
          .hold(`geo check failed: ${result.field} expected ${result.expected}, observed ${result.observed}`)
          .catch((err) => deps.log.warn(`network: device ${row.id}: onGeoFail=hold could not force a hold, tolerated: ${String(err)}`))
      }
    }
  }

  /** Only `vpn-helper` routes need the heartbeat — see `NETWORK_HEARTBEAT_INTERVAL_MS`. */
  function countEnabledVpnRoutes(): number {
    return db
      .select()
      .from(devices)
      .all()
      .filter((row) => {
        const persisted = readPersistedRoute(row)
        return persisted?.enabled === true && persisted.config.engine === 'vpn-helper'
      }).length
  }

  /** Starts the one daemon-wide heartbeat timer, if it is not already running — never one per device. Idempotent. */
  function ensureHeartbeat(): void {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(() => {
      void heartbeatTick().catch((err) => deps.log.warn(`network heartbeat tick failed, tolerated: ${String(err)}`))
    }, NETWORK_HEARTBEAT_INTERVAL_MS)
    // Never let a timer alone keep the process alive.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
  }

  /** Stops the heartbeat once no device has an enabled VPN route left. */
  function maybeStopHeartbeat(): void {
    if (heartbeatTimer && countEnabledVpnRoutes() === 0) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  // ---- engines (plan 114 §4.2, §4.4) ----

  /**
   * A `Transport` over this service's per-device `exec`, for an engine that
   * needs nothing more than a shell (plan 114 F8: "a device-scoped settings
   * write needs no session and no lease-bound machinery"). Only `exec` is
   * implemented, because only `exec` is used — `connect`/`disconnect` are
   * no-ops (the adb queue owns the transport's lifetime, not this object), and
   * `execOut` refuses rather than pretending, so a future engine that reaches
   * for binary stdout gets a coded error instead of a silent wrong answer.
   */
  function transportFor(row: DeviceRow): Transport {
    return {
      id: `route-service:${row.id}`,
      serial: row.serial,
      stableId: row.stableId,
      connect: async () => {},
      disconnect: async () => {},
      exec: (cmd, opts) => deps.exec(row.serial, cmd, opts),
      execOut: async () => {
        throw new EnkakuError('E_NOT_SUPPORTED', 'the route service’s transport is shell-only — execOut is not available here')
      },
    }
  }

  /**
   * Reads and writes `devices.network_route.captured` for the `adb-proxy`
   * engine (plan 114 §3.6 rule 1, §4.2).
   *
   * **Captured once, and enforced twice on purpose.** The engine's own
   * `captureOnce` skips when `read()` answers non-null, and `write()` below
   * refuses to overwrite an existing capture regardless. The failure this
   * guards against is the one that cannot be undone: a second apply recording
   * the FARM's value as "the original", after which the device's real prior
   * proxy is gone for good. One guard in the engine and one at the store is
   * cheap; a lost capture is permanent.
   *
   * A capture arriving for a device with no persisted route is dropped rather
   * than creating one: there would be nothing to attach it to, and inventing a
   * route row here would make `enabled: true` alongside `config: null`
   * reachable.
   */
  function captureStoreFor(deviceId: string) {
    return {
      read: () => persistedFor(deviceId)?.persisted.captured ?? null,
      write: (captured: NonNullable<PersistedNetworkRoute['captured']>) => {
        const found = persistedFor(deviceId)
        if (!found) {
          deps.log.warn(`network: device ${deviceId} produced a proxy capture with no route row to hold it — dropped`)
          return
        }
        if (found.persisted.captured) return
        writePersistedRoute(deviceId, { ...found.persisted, captured })
      },
    }
  }

  /**
   * Reads and writes `devices.network_route.reverse` for the
   * `adb-reverse-proxy` engine (plan 114 §4.3, step 114.5) — what the FARM
   * allocated, as opposed to `config`, which is what the operator asked for.
   *
   * **Not write-once, unlike the capture, and the difference is the point.**
   * `hostPort` changes whenever the operator points the route at a different
   * listener on this machine, so every write records the current pair. What
   * must never change silently is `devicePort` — the phone's own `http_proxy`
   * contains that number — and it is kept stable by PINNING it on
   * `ReverseRegistry.establish`, which honours a supplied port exactly and
   * never walks. A store that refused to update would instead leave the row
   * disagreeing with the tunnel it describes.
   *
   * As with `captureStoreFor`, an allocation arriving for a device with no
   * persisted route is dropped rather than creating one.
   */
  function reverseAllocationStoreFor(deviceId: string) {
    return {
      read: () => persistedFor(deviceId)?.persisted.reverse ?? null,
      write: (reverse: NonNullable<PersistedNetworkRoute['reverse']>) => {
        const found = persistedFor(deviceId)
        if (!found) {
          deps.log.warn(`network: device ${deviceId} allocated a reverse device port with no route row to hold it — dropped`)
          return
        }
        writePersistedRoute(deviceId, { ...found.persisted, reverse })
      },
    }
  }

  /**
   * **The one switch** (plan 114 §4.4). Returns `NetworkRoute<NetworkRouteConfig>`
   * for every engine, which is what lets one map, one revert path and one
   * lock check hold either kind: `apply` is declared with method syntax on
   * `NetworkRoute`, so it is bivariant and an engine accepting one arm of the
   * union is assignable to a route accepting the union. No cast, and no
   * parallel switch anywhere else.
   *
   * `session` is non-null only for `vpn-helper`, whose route and session are
   * always created together and torn down together. The advisory rungs hold
   * neither a session nor a port.
   */
  function buildEngine(row: DeviceRow, config: NetworkRouteConfig): { route: NetworkRoute<NetworkRouteConfig>; session: DeviceSession | null } {
    switch (config.engine) {
      case 'vpn-helper': {
        // Carried across from `guest-agent.ts` unchanged: one launcher, one session, shared
        // between this route AND every ephemeral probe that reuses it via `withEphemeralSession`
        // (plan 44 §8b, "Bug 1") — a port is claimed lazily, the first time the session needs one.
        const launcher = deps.makeLauncher(row)
        const session = deps.makeSession(row, launcher)
        const route = createVpnHelperRoute({
          launcher,
          session,
          apkPath: deps.apkPath,
          deviceId: row.id,
          onLog: (level, msg) => deps.log[level](msg),
          ...deps.routeTimings,
        })
        return { route, session }
      }
      case 'adb-proxy': {
        const route = createHttpProxyRoute({
          transport: transportFor(row),
          deviceId: row.id,
          capture: captureStoreFor(row.id),
          onLog: (level, msg) => deps.log[level](msg),
        })
        return { route, session: null }
      }
      case 'adb-reverse-proxy': {
        // Step 114.5: 114.2's settings writer composed with 114.4's reverse. Refused by name when
        // this core has no reverse registry, rather than silently degraded to `adb-proxy` — that
        // would point the phone at a `127.0.0.1` port nothing is listening on and report it
        // applied, which is the one outcome this rung must never produce.
        const registry = deps.reverse
        if (!registry) {
          throw new EnkakuError(
            'E_NOT_SUPPORTED',
            'this core was built without the adb reverse registry, so a proxy on this machine cannot be reached from the phone — use a proxy the phone can reach, or VPN mode',
          )
        }
        const route = createReverseProxyRoute({
          transport: transportFor(row),
          deviceId: row.id,
          reverse: registry,
          allocation: reverseAllocationStoreFor(row.id),
          // The SAME device-scoped capture rung 1 uses: the phone's pre-farm proxy settings are a
          // fact about the device, not about a particular route, so a device moved between the two
          // rungs still restores what was originally found (plan 114 §3.6).
          capture: captureStoreFor(row.id),
          onLog: (level, msg) => deps.log[level](msg),
        })
        return { route, session: null }
      }
    }
  }

  /**
   * Plan 114 §4.4 — what makes `locks: ['network-route']` real rather than a
   * label on a descriptor.
   *
   * All three engines declare that lock, and nothing at the OS level stops a
   * device from holding a VPN route AND an `http_proxy` at once: both would
   * "apply", traffic would follow the TUN, and the http setting would sit there
   * as a stale lie. So switching a device from one engine to another **reverts
   * the incumbent first, in the same request**, and a failure to revert refuses
   * the new apply rather than leaving two half-applied routes. Never "apply the
   * new one and hope".
   *
   * A no-op when the device has no route, or when the incoming engine is the
   * one already on file (a re-apply, an `/enable`, a recovery attempt).
   */
  async function assertLockFree(row: DeviceRow, previous: PersistedNetworkRoute | null, incoming: NetworkEngineId, actor: string | null): Promise<void> {
    if (!previous) return
    if (previous.config.engine === incoming) return
    deps.log.info(
      `network: device ${row.id} holds a ${previous.config.engine} route and is being switched to ${incoming} — reverting the incumbent first (plan 114 §4.4)`,
    )
    try {
      // A VPN route this process never applied — one left by a PREVIOUS core process — has no
      // live `NetworkRoute` for `revertNetwork` to go through, and `revertNetwork` deliberately
      // does not build one (see its own doc comment: probing, not blind teardown, is how a VPN
      // route survives a restart). That reasoning does not carry to an engine SWITCH: the
      // operator has explicitly asked for a different route, and leaving the phone tunnelling
      // through an agent while it also advertises an http_proxy is exactly the state the
      // `network-route` lock exists to make unreachable. So this one path does build a cold
      // engine and revert through it.
      // The cold-VPN special case that used to live here is gone: `revertNetwork`
      // now builds a cold engine for EVERY engine, so doing it again here was a
      // second teardown and a second `network.reverted` for one operator action.
      // Only the reason travels, so the event still says why the incumbent went.
      await revertNetwork(row.id, actor, { meta: { engine: previous.config.engine, reason: 'engine-switch' }, strict: true })
    } catch (err) {
      throw new EnkakuError(
        'E_ROUTE_LOCK_HELD',
        `this device still holds a ${previous.config.engine} route and it could not be turned off, so the new ${incoming} route was not applied: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  /**
   * An ephemeral, un-persisted status read for a `vpn-helper` route with no
   * live route in THIS process — goes through `withEphemeralSession`, never
   * holding a port between calls. Deliberately does NOT call `route.start`.
   */
  async function coldProbe(row: DeviceRow, config: Socks5RouteConfig): Promise<void> {
    let observed: NetworkObservation | null = null
    let observedAt: number | null = null
    let lastError: { code: string; message: string } | null = null
    try {
      // `withEphemeralSession`'s bootstrap hellos first — protocol-version check before anything
      // else, refuse a mismatch rather than degrade (CLAUDE.md) — then this asks `route.status`.
      const status = await deps.withEphemeralSession(row, (client) => client.routeStatus(), {
        handshakeRetries: 2,
        handshakeRetryDelayMs: 300,
      })
      observed = {
        prepared: status.prepared,
        up: status.up,
        ...(status.state !== undefined ? { state: status.state } : {}),
        ...(status.upstream !== undefined ? { upstream: status.upstream } : {}),
        ...(status.stats !== undefined ? { stats: status.stats } : {}),
        ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
        ...(status.ipv6Blocked !== undefined ? { ipv6Blocked: status.ipv6Blocked } : {}),
      }
      observedAt = nowSeconds()
    } catch (err) {
      // A cold read failing is an OBSERVE failure, never an apply failure (plan 44 §8b, "Bug 2").
      lastError = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
    }

    const entry: NetworkRouteEntry = { ...emptyEntry(), observed, observedAt, lastError }
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
   * Rung 2's `reverse` check (plan 114 §3.5, §3.7, step 114.5, acceptance
   * criterion 10) — **is the tunnel from the phone to this machine actually
   * live right now?**
   *
   * This is the fact `observe()` structurally cannot carry. A reverse dies with
   * a replug and leaves the phone's `http_proxy` perfectly intact, pointing at a
   * loopback port that answers nothing: the `setting` check passes, the device
   * looks configured, and every app using the proxy fails to connect. Plan 114
   * §3.7 calls that window "the honest cost of rung 2" and requires it to be
   * visible rather than inferred.
   *
   * Three sources, cheapest and most decisive first:
   *
   * 1. **No registry / no entry** — nothing was ever established, or it was
   *    released. `fail`, and no adb call is made to discover it.
   * 2. **`establishedAt === null`** — the registry's own "known intent, known
   *    NOT live" marker, set when the device goes offline and when a re-issue
   *    fails. This is what makes criterion 10's window report `fail` rather than
   *    `unknown`, and it costs nothing to read, so it is read BEFORE the adb
   *    round trip below.
   * 3. **`verify()`** — `adb reverse --list`, asked of the adb server itself, so
   *    a reverse this process believes in but the server has forgotten is
   *    caught. Never throws: an unreadable listing answers `false`, which is the
   *    honest reading (we could not confirm it), and the detail says so.
   */
  async function runReverseCheck(deviceId: string): Promise<{ ok: boolean; detail: string; at: number }> {
    const at = nowSeconds()
    const registry = deps.reverse
    if (!registry) {
      return { ok: false, detail: 'this core has no adb reverse registry, so the tunnel from the phone to this machine cannot be established or checked', at }
    }
    const entry = registry.get(deviceId)
    if (!entry) {
      return { ok: false, detail: 'no adb reverse is registered for this device — the tunnel from the phone to this machine has not been established', at }
    }
    if (entry.establishedAt === null) {
      return {
        ok: false,
        detail: `the tunnel from the phone’s tcp:${entry.devicePort} to this machine’s tcp:${entry.hostPort} is not live — it is rebuilt when the phone reconnects, and apps using the proxy fail to connect until it is`,
        at,
      }
    }
    const listed = await registry.verify(deviceId)
    return listed
      ? { ok: true, detail: `the adb server lists a reverse from the phone’s tcp:${entry.devicePort} to this machine’s tcp:${entry.hostPort}`, at }
      : {
          ok: false,
          detail: `the adb server lists no reverse from the phone’s tcp:${entry.devicePort} to this machine’s tcp:${entry.hostPort}, so the address the phone is pointed at answers nothing`,
          at,
        }
  }

  /**
   * The advisory rungs' equivalent of `coldProbe`: read the four settings keys
   * back off the device and record what they say. No session, no port, no
   * `apply` — the caller decides whether the answer warrants a re-apply.
   *
   * For rung 2 the `reverse` check runs here too, and it has to: the setting
   * surviving a replug while the tunnel behind it does not is precisely the
   * state this rung fails into, and a check that only ran on apply would report
   * `unknown` for exactly as long as the problem lasted.
   */
  async function coldObserveAdvisory(row: DeviceRow, persisted: PersistedNetworkRoute): Promise<NetworkRouteEntry> {
    const entry: NetworkRouteEntry = { ...emptyEntry() }
    try {
      const { route } = buildEngine(row, persisted.config)
      entry.observed = await route.observe()
      entry.observedAt = nowSeconds()
    } catch (err) {
      entry.lastError = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
    }
    // After the observe and before the checks are built: an unreachable device still has a
    // knowable reverse state (the registry is host-side), and reporting it is strictly more than
    // reporting nothing.
    if (persisted.config.engine === 'adb-reverse-proxy') entry.reverseCheck = await runReverseCheck(row.id)
    recomputeAdvisoryChecks(row.id, entry, persisted)
    networkStateByDevice.set(row.id, entry)
    return entry
  }

  /**
   * `coldObserveAdvisory` behind a short throttle, for the read paths a client
   * drives (`GET /:id/network`). An offline device is never dialled at all —
   * whatever this process last saw is the honest answer, and the checks it
   * produced were already reset to `unknown` by `handleDeviceOffline`.
   */
  async function observeAdvisoryThrottled(row: DeviceRow, persisted: PersistedNetworkRoute): Promise<NetworkRouteEntry> {
    const cached = networkStateByDevice.get(row.id)
    if (row.status === 'offline') return cached ?? emptyEntry()
    if (cached && cached.observedAt !== null && nowSeconds() - cached.observedAt < ADVISORY_OBSERVE_INTERVAL_S) {
      // The checks are still rebuilt from the cached observation: the DECLARED side can have
      // changed since (a re-established reverse moves rung 2's device port), and a stale
      // comparison is a wrong answer even when the observation behind it is fine.
      recomputeAdvisoryChecks(row.id, cached, persisted)
      return cached
    }
    return coldObserveAdvisory(row, persisted)
  }

  // ---- lifecycle ----

  /**
   * A device may be carrying a route applied by a PREVIOUS core process, or one
   * this process itself dropped its live state for when the device went offline
   * — either way, the persisted config says "this should be routed" and nothing
   * in memory currently confirms it is. Rather than blindly reapplying, this
   * probes the device and records what it finds (plan 52 §3.2). A no-op when
   * the device has no route, the route is disabled, or the device is offline.
   *
   * This is BOTH plan 52's "device online" restore and its "core start"
   * restore. Plan 114 §3.7 gives the three engines genuinely different physics
   * from here on, so the two branches below are stated rather than averaged.
   */
  async function restoreDeviceRoute(deviceId: string): Promise<void> {
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
    if (!row) return
    const persisted = readPersistedRoute(row)
    if (!persisted?.enabled) {
      resetRecovery(deviceId)
      // **Admission converges in BOTH directions.** Restoring what the record
      // wants is only half of it; a device that comes back carrying something
      // the record does NOT want has to be taken back, or the two stores
      // disagree forever with only the phone knowing (see `clearOrphanedRoute`).
      await clearOrphanedRoute(row, persisted)
      return
    }
    if (row.status === 'offline') {
      deps.log.info(`network restore: device ${deviceId} is offline, leaving its route enabled and unprobed`)
      return
    }

    if (persisted.config.engine !== 'vpn-helper') {
      await restoreAdvisoryRoute(row, persisted)
      return
    }

    // Plan 90 §3.7 rules 1–2, fixes F16: THIS is the reconnect path. Runs before the probe below
    // so a genuine reconnect gets a fresh attempt budget in time for THIS tick's own attempt.
    resetRecoveryOnReconnect(deviceId)
    await coldProbe(row, persisted.config)
    ensureHeartbeat()
    // Plan 54 §3.2, §4.2: probe first (just did, above) — only apply when the device reports no
    // route. `coldProbe` always (re)creates this device's entry, so it is always found here.
    const entry = networkStateByDevice.get(deviceId)
    if (entry) await maybeRecoverRoute(row, persisted, persisted.config, entry)
  }

  /**
   * Plan 114 §3.7's advisory-rung row, in code: **read it back, and re-apply
   * only if it does not match.**
   *
   * This is not the bounded recovery machinery and must not become it. A
   * settings write either reads back or it does not; there is no upstream to
   * wait for and no backoff that would help. One read, one conditional write,
   * and the `setting` check carries whatever the device says either way.
   *
   * For rung 2 the reverse is re-established FIRST, because the phone's own
   * setting points at a loopback port that answers nothing until it is — plan
   * 114 §3.7's "the honest cost of rung 2".
   */
  async function restoreAdvisoryRoute(row: DeviceRow, persisted: PersistedNetworkRoute): Promise<void> {
    const config = persisted.config
    // Narrowed once, here, rather than re-asserted at each use: this function is only ever reached
    // from `restoreDeviceRoute`'s own `engine !== 'vpn-helper'` branch.
    if (config.engine === 'vpn-helper') return
    if (config.engine === 'adb-reverse-proxy') await reestablishReverse(row.id, persisted)

    const entry = await coldObserveAdvisory(row, persisted)
    const declared = advisoryDeclaredValue(row.id, persisted)
    const reported = entry.observed?.upstream ?? ''
    if (config.engine === 'adb-reverse-proxy' && declared === '') {
      // An enabled rung-2 route with no device port at all: the only way to reach this is an apply
      // whose `adb reverse` failed AFTER the PUT handler had already persisted `enabled: true`.
      // Left alone it would compare an unset setting against an empty declaration and look
      // settled forever, so this is the one advisory case that re-applies without a comparison —
      // applying is what allocates the port in the first place.
      deps.log.info(`network restore: device ${row.id} has an enabled reverse-proxy route with no device port allocated — applying to allocate one`)
      await applyAdvisoryRoute(row, config, null).catch((err) =>
        deps.log.warn(`network restore: device ${row.id}: allocating the reverse and applying the proxy setting failed, tolerated: ${String(err)}`),
      )
      return
    }
    if (entry.observed === null) {
      deps.log.warn(`network restore: device ${row.id} could not be read (${entry.lastError?.code}) — its ${persisted.config.engine} route stays enabled and unverified`)
      return
    }
    if (reported === declared) {
      deps.log.info(`network restore: device ${row.id} already carries its ${persisted.config.engine} proxy setting (${declared}) — read back and left alone`)
      return
    }
    deps.log.info(
      `network restore: device ${row.id} reports http_proxy ${reported || '(unset)'} where ${declared} was declared — re-applying (plan 114 §3.7)`,
    )
    await applyAdvisoryRoute(row, config, null).catch((err) =>
      deps.log.warn(`network restore: device ${row.id}: re-applying the proxy setting failed, tolerated: ${String(err)}`),
    )
  }

  /**
   * Re-seeds the reverse registry from the persisted allocation (plan 114 §4.3,
   * and the gap step 114.4 raised). The registry is in-memory and gone after a
   * restart; the phone's setting is not, so the SAME device port has to come
   * back — `establish` honours a supplied port exactly and never walks, which
   * is the contract this relies on.
   */
  async function reestablishReverse(deviceId: string, persisted: PersistedNetworkRoute): Promise<void> {
    if (persisted.config.engine !== 'adb-reverse-proxy') return
    const registry = deps.reverse
    if (!registry) return
    const devicePort = persisted.reverse?.devicePort
    if (devicePort === undefined) return
    try {
      await registry.establish(deviceId, { hostPort: persisted.config.hostPort, devicePort })
    } catch (err) {
      deps.log.warn(`network restore: device ${deviceId}: re-establishing the reverse on device tcp:${devicePort} failed: ${String(err)}`)
    }
  }

  /**
   * The device just went offline (plan 52 §4.1's "device offline" row). This is
   * deliberately NOT `revertNetwork`: the persisted config/enabled columns are
   * untouched, and `route.revert()` is never called — there is nothing to send
   * it to. Any live session/port is released, and every check that depended on
   * live observation reverts to `unknown` rather than keep reporting a
   * last-known `pass` this process can no longer confirm.
   */
  async function handleDeviceOffline(deviceId: string): Promise<void> {
    // Plan 90 §3.7 rule 1, fixes F16: stamps the "genuine offline transition"
    // `resetRecoveryOnReconnect` needs — deliberately independent of whether this process still
    // holds a live network entry, and deliberately NEVER deletes the recovery state itself.
    const recovery = recoveryByDevice.get(deviceId)
    if (recovery) recovery.offlineAt = nowSeconds()

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
    // Plan 55 — same treatment as `probeResult`/`probeError`.
    entry.geoObservation = null
    entry.geoError = null
    entry.dnsResult = null
    // Plan 114 §3.5 — and the same treatment for the advisory rungs' own two checks. An
    // `upstream` dial from before the disconnect is not a fact about now, and rung 2's reverse is
    // certainly gone with the transport.
    entry.upstreamCheck = null
    entry.reverseCheck = null
    const found = persistedFor(deviceId)
    if (found && found.persisted.config.engine !== 'vpn-helper') recomputeAdvisoryChecks(deviceId, entry, found.persisted)
    else recomputeChecks(entry, found?.persisted.config.engine === 'vpn-helper' ? found.persisted.config : undefined)
    deps.log.info(`network: device ${deviceId} went offline — route config kept, live state cleared, checks now unknown`)
  }

  /**
   * On boot, every device may still be carrying a route applied by a PREVIOUS
   * core process (plan 52 §4.1: "core start | restore for every device with a
   * route"). Exposed on the handle so a test can await it deterministically
   * instead of racing the fire-and-forget call the constructor makes.
   */
  async function reconcileNetworkRoutes(): Promise<void> {
    const rows = db.select().from(devices).all()
    let anyVpnEnabled = false
    for (const row of rows) {
      const persisted = readPersistedRoute(row)
      // A teardown this farm owes a device outlives the process that owed it: the phone is still
      // carrying the route, so a core restart may not be what forgets about it. `restoreDeviceRoute`
      // is the one door for both directions and decides which applies.
      if (!persisted?.enabled && !persisted?.pendingClear) continue
      if (persisted.enabled && persisted.config.engine === 'vpn-helper') anyVpnEnabled = true
      await restoreDeviceRoute(row.id)
    }
    if (anyVpnEnabled) ensureHeartbeat()
  }

  /**
   * The core's half of the dead-man's-switch pair (plan 44 step 5.4, §8b): the
   * agent tears its OWN route down after 90s of silence from the core, so this
   * pings every enabled, online device at most every 20s. One timer for the
   * whole daemon. Never throws into the event loop.
   *
   * Advisory routes are skipped outright (plan 114 §4.4): there is no
   * dead-man's switch on the other end to feed, and four `settings get` calls
   * per device per 20 s would be real adb traffic bought for nothing. Their
   * observation is refreshed where it is actually wanted — on device-online,
   * and on every `GET /:id/network`.
   */
  async function heartbeatTick(): Promise<void> {
    const rows = db.select().from(devices).all()
    for (const row of rows) {
      const persisted = readPersistedRoute(row)
      if (!persisted?.enabled) {
        resetRecovery(row.id)
        continue
      }
      if (persisted.config.engine !== 'vpn-helper') continue
      if (row.status === 'offline') continue // nothing to keep alive
      const config = persisted.config
      const entry = networkStateByDevice.get(row.id)
      try {
        if (entry?.route) {
          // Reuse the client already authenticated by the last apply() — re-bootstrapping here
          // would rotate the token out from under a route THIS process is managing.
          const observed = await entry.route.observe()
          entry.observed = observed
          entry.observedAt = nowSeconds()
          entry.lastError = null
          // Best-effort, throttled (plan 51 §9 open question 1).
          await maybeRunProbe(entry, entry.route, false)
          // Plan 55 §3.4, §5.4 — its own, slower throttle; shares this tick rather than a second timer.
          await maybeRunGeoAndDns(row, config, entry, entry.route, false)
          recomputeChecks(entry, config)
        } else {
          await coldProbe(row, config)
        }
        // Plan 54 §4.2, §5.5: the heartbeat is the OTHER caller of the same bounded recovery
        // `restoreDeviceRoute` uses — "one owner, one counter".
        const current = networkStateByDevice.get(row.id)
        if (current) await maybeRecoverRoute(row, persisted, config, current)
      } catch (err) {
        // A heartbeat failure is always an OBSERVE failure — this loop only ever reads status or
        // cold-probes; it never calls `route.start` (plan 44 §8b, "Bug 2").
        const coded = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
        if (entry) {
          entry.lastError = coded
          recomputeChecks(entry, config)
        }
        deps.log.warn(`network heartbeat: device ${row.id} failed, tolerated: ${coded.message}`)
      }
    }
  }

  /**
   * Re-reads the device's own state before answering, so a route an operator
   * switched off from Android Settings shows up as drift within one poll (plan
   * 44 acceptance #5) rather than continuing to claim a route that no longer
   * exists. Does NOT trigger a fresh egress probe (plan 51 §9 open question 1
   * is unresolved, and a GET must stay cheap).
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
        recovery: null,
        captured: null,
        setBy: null,
        pendingClear: null,
      }
    }

    const common = {
      config: toConfigResponse(row.id, persisted),
      enabled: persisted.enabled,
      exitHistory: persisted.exitHistory ?? [],
      captured: persisted.captured ? { at: persisted.captured.at } : null,
      setBy: persisted.setBy ?? null,
      // The one field that describes the DEVICE's leftovers rather than the farm's intent.
      pendingClear: persisted.pendingClear
        ? {
            engine: persisted.pendingClear.engine,
            ...(persisted.pendingClear.devicePort !== undefined ? { devicePort: persisted.pendingClear.devicePort } : {}),
            // On the wire as well as on disk: it is the difference between "this config is being
            // kept so it can be switched back on" and "this config only still exists because the
            // phone has not been told yet, and it goes when it is".
            forget: persisted.pendingClear.forget,
            reason: persisted.pendingClear.reason,
            since: persisted.pendingClear.since,
          }
        : null,
    }

    if (persisted.config.engine !== 'vpn-helper') {
      // The advisory rungs' GET does the read the heartbeat deliberately does not: four
      // `settings get` calls on demand, when somebody is actually looking. Throttled, because
      // Studio's Network panel polls and four adb round trips per poll per device is exactly the
      // fleet-scale cost `PROBE_INTERVAL_S` exists to avoid on the VPN side — a system proxy
      // setting does not change between two polls a few seconds apart.
      const entry = await observeAdvisoryThrottled(row, persisted)
      return {
        ...common,
        engine: persisted.config.engine,
        observed: entry.observed,
        drift: computeDrift(row.id, persisted, entry.observed),
        sessionId: null,
        failClosed: resolveFailClosed(persisted),
        health: entry.health,
        checks: entry.checks,
        lastError: entry.lastError,
        // Plan 114 §4.4 — the recovery machinery stays VPN-only, and `null` is already this
        // field's "nothing has ever needed recovery" reading.
        recovery: null,
      }
    }

    const config = persisted.config
    const entry = networkStateByDevice.get(row.id)
    if (entry?.route) {
      try {
        const observed = await entry.route.observe()
        entry.observed = observed
        entry.observedAt = nowSeconds()
        entry.lastError = null
      } catch (err) {
        // A status re-read failing is an OBSERVE failure, never an apply failure (plan 44 §8b).
        entry.lastError = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
      }
      recomputeChecks(entry, config)
    }

    // Plan 54 §3.2 acceptance #5 ("says why", and keeps saying why): the re-observe above just
    // unconditionally reset `entry.lastError`, which would silently erase a "gave up after N
    // attempts" account on the very next GET otherwise.
    const recovery = recoveryByDevice.get(row.id)
    if (entry && recovery?.exhausted && recovery.exhaustedMessage) {
      entry.lastError = { code: 'E_NETWORK_RECOVERY_EXHAUSTED', message: recovery.exhaustedMessage }
      recomputeChecks(entry, config)
    }

    return {
      ...common,
      engine: 'vpn-helper',
      observed: redactObservationForResponse(entry?.observed ?? null, secretsFor(config)),
      drift: computeDrift(row.id, persisted, entry?.observed ?? null),
      sessionId: persisted.sessionId ?? null,
      failClosed: resolveFailClosed(persisted),
      health: entry?.health ?? 'unknown',
      checks: entry?.checks ?? [],
      lastError: entry?.lastError ?? null,
      // `nextAttemptAt` is recomputed rather than trusting the raw field once exhausted: the raw
      // value freezes at whatever it was when the LAST attempt ran.
      recovery: recovery
        ? {
            attempts: recovery.attempts,
            maxAttempts: RECOVERY_MAX_ATTEMPTS,
            nextAttemptAt: recovery.exhausted ? recovery.exhaustedAt + recoveryRearmS() : recovery.nextAttemptAt,
            exhausted: recovery.exhausted,
            reconnectCycles: recovery.reconnectCycles.length,
          }
        : null,
    }
  }

  /**
   * Tears down any LIVE or COLD in-memory state for a device's route — never
   * touches the persisted config/enabled columns, which the caller decides
   * separately (PUT/enable keep it, disable keeps it, DELETE clears it).
   *
   * **The advisory rungs need a cold revert and `vpn-helper` deliberately does
   * not get one.** For `vpn-helper` this is exactly the pre-114 function: with
   * no live route in this process it returns having done nothing, because
   * reverting a VPN means telling the device to stop, and a route applied by a
   * previous core process is reconciled by probing rather than by being torn
   * down blind. For `adb-proxy`/`adb-reverse-proxy` the opposite is true and
   * the difference is not a matter of taste: the revert is what restores the
   * device's own captured proxy settings, the capture lives on the row that
   * `DELETE /network` is about to erase, and a no-op here would leave a phone
   * carrying the farm's proxy forever with nothing left on disk that remembers
   * what was there before.
   */
  async function revertNetwork(
    deviceId: string,
    actor: string | null = null,
    opts: {
      /** Extra `network.reverted` meta — e.g. why an incumbent went during an engine switch. */
      meta?: Record<string, unknown>
      /**
       * Whether a failed teardown must propagate.
       *
       * `false` (the default) is right for uninstall / forget / `DELETE`: those
       * must not be blocked by a phone that cannot be reached to be tidied up,
       * and the row is going away regardless.
       *
       * `true` is right for an engine SWITCH, and the difference is not
       * cosmetic — if the incumbent could not be torn down and we apply the new
       * route anyway, the device ends up holding both, which is the exact state
       * the `network-route` lock exists to make unreachable. `assertLockFree`
       * turns this on and converts the throw into `E_ROUTE_LOCK_HELD`.
       */
      strict?: boolean
      /**
       * The caller wants the ROW gone once the device has actually been
       * reverted (`DELETE /network`, `device.network.clear`), rather than kept
       * as a disabled config.
       *
       * It is recorded on `pendingClear` rather than acted on here, because a
       * row erased before the phone was reached takes the `captured` values the
       * revert still owes it — and the device port the reverse still has to be
       * removed from — with it. The caller erases the row itself when this
       * function comes back with no debt written; admission erases it when the
       * debt is finally settled.
       */
      forget?: boolean
    } = {},
  ): Promise<void> {
    const meta = opts.meta ?? {}
    // An operator explicitly turning a route off ends any recovery cycle in progress (plan 54 §4.2).
    resetRecovery(deviceId)
    const found = persistedFor(deviceId)
    const entry = networkStateByDevice.get(deviceId)

    if (entry) {
      // Removed up front so a concurrent/repeated call has nothing left to act on — the same
      // idempotence `NetworkRoute.revert()` itself already promises.
      networkStateByDevice.delete(deviceId)
    }

    /**
     * Null while the teardown is known to have reached the phone; otherwise the
     * operator-readable reason it did not. NEVER left null on a guess: every
     * engine's `revert()` is contractually silent about a device it could not
     * reach, so "it did not throw" is not evidence of anything.
     */
    let unreached: string | null = null

    if (entry?.route) {
      // `route.revert()` never throws and closes its own session (releasing the port) as its very
      // last step — nothing left to release out here.
      await entry.route.revert()
      if (found) unreached = await revertUnreachedReason(found.row, found.persisted)
    } else if (found) {
      // COLD REVERT, for every engine including `vpn-helper`.
      //
      // This branch used to exclude `vpn-helper`, on the reasoning that a VPN
      // should survive a core restart by being probed rather than blindly torn
      // down. That reasoning is right and it belongs to `restoreDeviceRoute` —
      // NOT here. All three callers of this function are explicit operator
      // actions: an engine switch, `DELETE /network`, and
      // `POST /network/disable`. There is no reconcile path in the list.
      //
      // What the exclusion actually produced, observed on real hardware:
      // the core restarts (so `networkStateByDevice` is empty), the operator
      // presses "turn off", the row is cleared, the screen reads `engine:
      // none, enabled: false` — and **the phone is never told**. Its
      // `RouteVpnService` stays up with no working tunnel, and because the
      // route was `failClosed: true` the device blocks all of its own traffic.
      // The phone had no internet at all until the service was force-stopped
      // by hand; `ip link` showed no tun, `always_on_vpn_app` was null, and
      // the farm believed the route was long gone.
      //
      // Fail-closed was not misbehaving — it is meant to hold when a tunnel
      // breaks unexpectedly, which is exactly what a device losing its route
      // looks like from the phone's side. It was simply never told to stand
      // down, because the farm's own "off" never left the process. An operator
      // pressing a button is not an unexpected event, and the teardown has to
      // reach the device that is enforcing the promise.
      try {
        // `session` is closed in a `finally`: a cold `vpn-helper` revert builds a
        // real guest-agent session to reach the phone, and dropping it on the
        // floor would leak it on the one path that runs on every teardown.
        const built = buildEngine(found.row, found.persisted.config)
        try {
          // **The cold VPN teardown has to WAKE the session before it can say
          // anything.** `vpn-helper.revert()` only talks to the device when
          // `session.active`, and a session that was just built is not — so the
          // "cold revert for every engine" fix above, on its own, still closed an
          // unused session, recorded `network.reverted`, and left the phone
          // holding itself closed. One `observe()` establishes the session so the
          // `route.stop` that follows is a real one, and its failure is exactly
          // the reachability answer this function has to record.
          if (found.persisted.config.engine === 'vpn-helper') unreached = await wakeForColdVpnRevert(built.route, found.row)
          await built.route.revert()
          if (!unreached) unreached = await revertUnreachedReason(found.row, found.persisted)
        } finally {
          await built.session?.close()
        }
      } catch (err) {
        // An unreachable device lands here, as does a rung-2 route on a core with no reverse
        // registry (`E_NOT_SUPPORTED`, which cannot revert what it could never have applied).
        if (opts.strict) throw err
        // Tolerated on every other path:
        // this runs from teardown paths (uninstall, forget, DELETE) that must not be blocked by a
        // phone that cannot be reached to be tidied up.
        deps.log.warn(`network: cold revert for device ${deviceId} failed, tolerated: ${String(err)}`)
        unreached = `the teardown could not be carried out (${toCodedError(err, 'E_NETWORK_REVERT_FAILED').code})`
      }
    } else if (!entry) {
      // Nothing live AND nothing persisted — there is genuinely no route to
      // tear down, so there is nothing to tell the device and no event to
      // record. (Before the fix above this branch also swallowed every cold
      // `vpn-helper` route, which is the case that left a phone cut off.)
      return
    }

    // An engine SWITCH may not proceed on an unconfirmed teardown: the whole point of the
    // `network-route` lock is that a device never holds two routes at once, and a phone that was
    // never told to drop the incumbent is exactly that state. Raised BEFORE the release below, so
    // a refused switch leaves the incumbent exactly as it was found. No debt is recorded either —
    // the request is refused, so the incumbent stays on record as the enabled route it still is,
    // and a row that is both `enabled` and owed a teardown would be a contradiction nothing could
    // act on.
    if (unreached && found && opts.strict) {
      throw new EnkakuError(
        'E_NETWORK_REVERT_UNCONFIRMED',
        `the incumbent ${found.persisted.config.engine} route could not be turned off on the device — ${unreached}`,
      )
    }

    // Rung 2's tunnel goes with the route. Idempotent and never throws, so it is safe on every
    // path including the ones where no reverse ever existed. The registry is host-side
    // bookkeeping: dropping the entry here is what stops `handleDeviceOnline` from re-issuing a
    // reverse for a route the record no longer wants.
    await deps.reverse?.release(deviceId)

    // The intent to clear outlives the attempt (`PersistedNetworkRoute.pendingClear`). Written
    // BEFORE the event, so a caller that re-reads the row after this returns — `/disable` and
    // `DELETE`, both of which decide the row's fate from what they find — sees the debt.
    if (unreached && found) {
      const devicePort = reverseDevicePort(deviceId, found.persisted)
      const current = readPersistedRoute(mustGet(deviceId)) ?? found.persisted
      writePersistedRoute(deviceId, {
        ...current,
        pendingClear: {
          engine: found.persisted.config.engine,
          ...(devicePort !== null ? { devicePort } : {}),
          forget: opts.forget === true,
          reason: unreached,
          // First recorded wins: how long a phone has been carrying a route nobody wants is the
          // fact worth keeping, and a retry that fails again does not make it younger.
          since: current.pendingClear?.since ?? nowSeconds(),
        },
      })
      deps.log.warn(
        `network: device ${deviceId} was turned off in the farm but ${unreached} — the teardown is owed and will be settled the next time the device is admitted`,
      )
    } else if (found?.persisted.pendingClear) {
      // A debt from an earlier attempt, settled by this one: the phone has now been read back
      // clean, so the row must stop claiming otherwise.
      const current = readPersistedRoute(mustGet(deviceId))
      if (current?.pendingClear) {
        const { pendingClear: _settled, ...rest } = current
        writePersistedRoute(deviceId, rest)
      }
    }

    deps.record?.({
      deviceId,
      stream: 'main',
      kind: 'network.reverted',
      actor,
      // `ok` rides along for the same reason it does on `network.applied`: "reverted" recorded for
      // a phone that was never told is the honest-state rule broken in the direction nobody
      // notices, which is how a device kept a proxy for a day with every screen reading "off".
      meta: { ...meta, ok: unreached === null, ...(unreached ? { pendingClear: true, reason: unreached } : {}) },
    })
  }

  /**
   * Wakes a COLD `vpn-helper` session so the `revert()` that follows is a real
   * one, and answers whether the phone could be reached at all.
   *
   * `vpn-helper.revert()` deliberately says nothing over an inactive session,
   * and a freshly built session is inactive — so without this, a cold VPN
   * teardown is one `session.close()` and a device event. That is the incident
   * `revertNetwork`'s own doc comment describes, still reachable after the fix
   * that comment describes: an armed, fail-closed `RouteVpnService` that was
   * never told to stand down blocks every packet the phone tries to send.
   *
   * Returns null when the agent answered, and the reason it did not otherwise.
   * Never throws — an unreachable phone is an outcome to record, not an error
   * to propagate out of a teardown.
   */
  async function wakeForColdVpnRevert(route: NetworkRoute<NetworkRouteConfig>, row: DeviceRow): Promise<string | null> {
    if (row.status === 'offline') return 'the device was offline, so it was never told to stop'
    try {
      await route.observe()
      return null
    } catch (err) {
      return `the guest agent could not be reached to be told to stop (${toCodedError(err, 'E_NETWORK_OBSERVE_FAILED').code})`
    }
  }

  /**
   * **Did the teardown actually reach the phone?** Null when it did; the reason
   * it did not otherwise.
   *
   * This exists because `NetworkRoute.revert()` may not throw, by contract, and
   * all three engines honour that by swallowing an unreachable device:
   * `http-proxy.ts`'s `restoreAll` puts every one of its four writes behind a
   * `.catch()` that logs at `warn`, and the VPN's stop/poll pair tolerates a
   * gone device and breaks out. A successful restore and a phone that was never
   * spoken to therefore produce byte-identical silence at this seam, and the
   * farm recorded both as `network.reverted`.
   *
   * The advisory rungs get a real read-back — one `settings get`, on a path
   * that runs once per operator action, against a device the operator believes
   * they just changed. `vpn-helper` is answered by whether the session could be
   * woken at all (see `wakeForColdVpnRevert`); asking the agent a second time
   * after `revert()` closed the session would mint a token for nothing.
   */
  async function revertUnreachedReason(row: DeviceRow, persisted: PersistedNetworkRoute): Promise<string | null> {
    // **The offline check comes FIRST, ahead of the `vpn-helper` early return, and the order is
    // load-bearing.** A VPN route whose live entry this process still holds — a device the farm
    // has marked offline without `handleDeviceOffline` having cleared the entry, which is exactly
    // what a reconciler-driven transition looks like — took the early return and reported a clean
    // off for a phone that is not there. That is "an off that did not happen, recorded as done",
    // and it is now reachable by an operator on purpose, because `requireDisarmAdmission` lets the
    // disarm doors through for an offline device. The wording matches each engine's own teardown:
    // the advisory rungs clear a setting, the VPN is told to stop.
    if (row.status === 'offline') {
      return persisted.config.engine === 'vpn-helper'
        ? 'the device was offline, so it was never told to stop'
        : 'the device was offline, so its proxy setting was never cleared'
    }
    if (persisted.config.engine === 'vpn-helper') return null
    const declared = advisoryDeclaredValue(row.id, persisted)
    try {
      const { route } = buildEngine(row, persisted.config)
      const reported = (await route.observe()).upstream ?? ''
      // Nothing was ever declared (an enabled rung-2 route whose allocation never happened): there
      // is no value to find still standing, and a read that succeeded is proof enough of reach.
      if (declared === '') return null
      if (reported === declared) return `the phone still reports the proxy this farm wrote (${declared})`
      return null
    } catch (err) {
      return `the phone could not be read back after the teardown (${toCodedError(err, 'E_NETWORK_OBSERVE_FAILED').code})`
    }
  }

  /**
   * **Admission's other direction: tear down what nobody wants.**
   *
   * `restoreDeviceRoute` puts back the route the record asks for. Reconciling
   * only in that direction is what produced the incident this function exists
   * for — a phone came back carrying `http_proxy 127.0.0.1:28100`, its
   * `adb reverse` was re-issued with it, and its traffic left through a metered
   * residential proxy while every screen read "no route", because nothing ever
   * compared the DEVICE against the record in the direction where the record
   * says less than the device does.
   *
   * Two kinds of leftovers are settled here, and both are evidence-based —
   * nothing is torn down on suspicion:
   *
   * 1. **A debt this farm recorded** (`pendingClear`): an operator pressed off
   *    while the phone was away, and the write never landed. The row was kept
   *    alive precisely to hold the capture and the device port needed now.
   * 2. **A disabled advisory route the phone is still carrying**: no debt was
   *    recorded (the row predates this mechanism, or the core died between the
   *    revert and the write), but the device reports EXACTLY the value this
   *    farm's own route declares. A value the farm wrote is a value the farm
   *    may take back; anything else is the operator's own and is left alone.
   * 3. **A reverse this machine is still holding open** for a route that no
   *    longer exists on the record. Host-side only, so it can strand nothing,
   *    and it is the half that turns a leftover setting into a live tunnel.
   *
   * A route that is enabled is never touched here — the legitimate restore is
   * not the bug, orphans are.
   */
  async function clearOrphanedRoute(row: DeviceRow, persisted: PersistedNetworkRoute | null): Promise<void> {
    if (row.status === 'offline') return
    if (persisted?.enabled) return

    const debt = persisted?.pendingClear ?? null
    // What the reverse registry still holds for a device whose record wants nothing. Host-side
    // bookkeeping that outlived its record is an orphan by definition — there is no second store
    // entitled to an opinion here, and a reverse is exactly what turns a leftover `http_proxy`
    // into a working tunnel to somebody's paid upstream.
    const strayReverse = deps.reverse?.get(row.id)?.devicePort ?? null
    let reason = debt?.reason ?? null
    /** Whether the PHONE has to be talked to, as opposed to only this machine's bookkeeping. */
    let deviceCarriesRoute = debt !== null
    if (!debt && persisted?.captured && persisted.config.engine !== 'vpn-helper') {
      // No recorded debt — the row predates this mechanism, or the core died between the revert
      // and the write. LOOK before touching anything, and only where there is reason to:
      // `captured` is proof this farm once wrote to this device's proxy settings, so a route that
      // was declared and never applied costs no adb traffic at admission at all. A phone
      // reporting the exact value this farm's own route declares is carrying the farm's write;
      // anything else is the operator's own proxy and is none of this function's business.
      const declared = advisoryDeclaredValue(row.id, persisted)
      let reported: string | null = null
      if (declared !== '') {
        try {
          reported = (await buildEngine(row, persisted.config).route.observe()).upstream ?? ''
        } catch {
          // Unreadable is not evidence. Nothing is torn down on a failed read.
          reported = null
        }
      }
      if (reported !== null && reported === declared) {
        deviceCarriesRoute = true
        reason = `it was admitted still carrying the ${declared} proxy this farm wrote, and no route on record wants it`
      }
    }
    if (!reason && strayReverse !== null) {
      // Nothing on the phone to undo, but this machine was still holding a tunnel open for a route
      // that no longer exists. Removing it is host-side only and can strand nothing.
      reason = `an adb reverse from the phone's tcp:${strayReverse} was still registered with no route on record behind it`
    }
    if (reason === null) return

    const devicePort = debt?.devicePort ?? strayReverse
    /** Null once the phone itself has been confirmed clean; the reason it has not otherwise. */
    let unreached: string | null = deviceCarriesRoute ? 'the teardown never ran' : null
    if (persisted && deviceCarriesRoute) {
      try {
        const built = buildEngine(row, persisted.config)
        try {
          if (persisted.config.engine === 'vpn-helper') unreached = await wakeForColdVpnRevert(built.route, row)
          else unreached = null
          await built.route.revert()
          if (!unreached) unreached = await revertUnreachedReason(row, persisted)
        } finally {
          await built.session?.close()
        }
      } catch (err) {
        unreached = `settling the owed teardown failed (${toCodedError(err, 'E_NETWORK_REVERT_FAILED').code})`
        deps.log.warn(`network: device ${row.id}: ${unreached}: ${String(err)}`)
      }
    }
    // Last, and unconditionally: the setting is cleared before the tunnel under it goes, so the
    // phone is never pointed at a port that has just stopped answering (plan 114 §3.6's order).
    await deps.reverse?.release(row.id)

    if (unreached) {
      deps.log.warn(
        `network: device ${row.id} was admitted with a route nobody wants and it could not be taken back yet (${unreached}) — the teardown stays owed`,
      )
      return
    }

    const forget = debt?.forget === true
    const after = readPersistedRoute(mustGet(row.id))
    if (!after) {
      // Nothing on disk to settle — a stray reverse with no row at all.
    } else if (forget) {
      writePersistedRoute(row.id, null)
    } else {
      const { pendingClear: _settled, ...rest } = after
      writePersistedRoute(row.id, { ...rest, enabled: false })
    }
    maybeStopHeartbeat()
    networkStateByDevice.delete(row.id)

    deps.log.info(`network: device ${row.id} was admitted carrying a route nobody wants — taken back: ${reason}`)
    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'network.orphan.cleared',
      // The farm did this by itself, on admission. Stamping an operator on it would claim somebody
      // touched a device they never opened (the same rule `setBy: null` follows).
      actor: null,
      meta: {
        engine: debt?.engine ?? persisted?.config.engine ?? 'none',
        reason,
        ...(devicePort !== null ? { devicePort } : {}),
        // Which of the three outcomes the phone actually got — restoring what was there before
        // and clearing the keys are different results the UI and the log are required to word
        // differently (plan 114 §3.6 rule 4), and `none` is the host-only case where nothing on
        // the device was touched at all.
        restored: !deviceCarriesRoute ? 'none' : persisted?.captured ? 'captured' : 'cleared',
        forgot: forget,
      },
    })
  }

  // ---- apply ----

  /**
   * Resolves a DECLARED config — `credentialRef`, or (only for a pre-migration
   * row this process has not yet rewritten) legacy inline `username`/`password`
   * — into the RESOLVED wire object `route.apply()` hands to `route.start`
   * (plan 52 §4.2). Applies the sticky-session template on top of whatever
   * username results. `credentialRef` is dropped from the result — the device
   * has no notion of a name that only exists in this farm's own database.
   *
   * **`engine: 'vpn-helper'` stays on the wire object, deliberately** (plan 114
   * §4.1's own open point). Two facts decide it. First, it is inert: the Kotlin
   * `ControlService.handle` reads `config` field by field off a `JSONObject`
   * with `optString`/`optInt`, so an unknown key is not an error there and
   * never will be for a build that predates the tag. Second, removing it is not
   * free — `NetworkRoute<Socks5RouteConfig>.apply` takes the full config type,
   * whose `engine` is required on OUTPUT (that is the whole point of
   * `.default()` on the literal), so stripping it means widening that signature
   * in `packages/drivers`. The tag is also a TRUE statement about the object
   * being sent, unlike `credentialRef`/`expect`/`onGeoFail`, which are dropped
   * because they are facts about this farm and not about the device. When
   * `NetworkRoute` finally moves into `packages/protocol/src/driver.ts` (plan
   * 44 §5.6, still open), that is the moment to introduce a separate wire type
   * and drop the tag with it.
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
      engine: 'vpn-helper',
      host: declared.host,
      port: declared.port,
      udpMode: declared.udpMode,
      // Plan 54 §4.2, §5.6 — never absent on the RESOLVED object: the device has no notion of
      // "unspecified", only true/false.
      failClosed,
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    }
  }

  /**
   * Applies `config` to `row`, creating a live route if none is held yet
   * (adopting a "cold" entry the same way) or reusing one already applied this
   * process. Carried across from `guest-agent.ts` unchanged.
   */
  async function applyVpnRoute(row: DeviceRow, config: Socks5RouteConfig, actor: string | null): Promise<void> {
    // A stable sessionId (plan 52 §3.3, §4.3): generated once, on first apply, and kept from then
    // on — writing it BEFORE the apply attempt below, same reasoning as persisting `config`/
    // `enabled` before it: it must survive even if this apply fails or the core dies mid-request.
    const currentPersisted = readPersistedRoute(mustGet(row.id))
    const sessionId = currentPersisted?.sessionId ?? generateSessionId()
    if (!currentPersisted?.sessionId) {
      writePersistedRoute(row.id, {
        config: currentPersisted?.config ?? config,
        enabled: currentPersisted?.enabled ?? true,
        ...(currentPersisted?.failClosed !== undefined ? { failClosed: currentPersisted.failClosed } : {}),
        ...(currentPersisted?.exitHistory ? { exitHistory: currentPersisted.exitHistory } : {}),
        ...(currentPersisted?.captured ? { captured: currentPersisted.captured } : {}),
        ...(currentPersisted?.setBy ? { setBy: currentPersisted.setBy } : {}),
        sessionId,
      })
    }

    const existing = networkStateByDevice.get(row.id)
    let entry: NetworkRouteEntry
    let route: NetworkRoute<NetworkRouteConfig>
    if (existing?.route) {
      entry = existing
      route = existing.route
    } else {
      const built = buildEngine(row, config)
      route = built.route
      entry = { ...emptyEntry(), route, session: built.session }
      networkStateByDevice.set(row.id, entry)
    }

    try {
      // Resolve `credentialRef` (or legacy inline creds) into the actual username/password the
      // device needs, with the sticky-session template applied on top — done INSIDE the try so a
      // missing credential surfaces as a normal apply failure (`E_CREDENTIAL_NOT_FOUND`).
      const resolved = resolveWireConfig(config, sessionId, resolveFailClosed(currentPersisted))
      // `apply()` walks install → grant → bootstrap → forward → handshake → route.start itself
      // (plan 44 §4.4) — pressing apply installs the agent if needed.
      await route.apply(resolved)
      entry.lastError = null
      try {
        entry.observed = await route.observe()
        entry.observedAt = nowSeconds()
      } catch {
        // Best-effort: apply() already succeeded, so a status read failing right after does not
        // invalidate that.
      }
      // Forced, not throttled — an operator who just pressed "apply" should see a fresh answer.
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
        meta: { engine: 'vpn-helper', config: redactRouteConfig(config), ok: false, error: coded },
      })
      throw new EnkakuError(coded.code, coded.message)
    }

    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'network.applied',
      actor,
      meta: { engine: 'vpn-helper', config: redactRouteConfig(config), ok: true },
    })
  }

  /**
   * The advisory rungs' apply (plan 114 §3.6, §3.9). Capture → write → read
   * back → compare all happen inside the engine; what this function owns is the
   * classification of the outcome and the checks that follow it.
   *
   * `HttpProxyError`'s `E_SETTING_NOT_ACCEPTED` is what makes §3.9's "failed"
   * versus "applied, unverified" distinction reachable at all: a write the
   * device declined throws and is reported as a FAILED apply, never as
   * applied-but-unverified. The normal terminal state here — write accepted,
   * read-back matched, `health: 'unverified'` because `egress` is permanently
   * `skip` — is a SUCCESS and must not be counted as a failure anywhere
   * downstream.
   */
  async function applyAdvisoryRoute(row: DeviceRow, config: HttpProxyRouteConfig | ReverseProxyRouteConfig, actor: string | null): Promise<void> {
    const persistedBefore = readPersistedRoute(mustGet(row.id))
    const entry: NetworkRouteEntry = { ...emptyEntry() }
    networkStateByDevice.set(row.id, entry)

    let route: NetworkRoute<NetworkRouteConfig>
    try {
      route = buildEngine(row, config).route
    } catch (err) {
      const coded = toCodedError(err, 'E_NETWORK_APPLY_FAILED')
      entry.lastError = coded
      if (persistedBefore) recomputeAdvisoryChecks(row.id, entry, persistedBefore)
      throw new EnkakuError(coded.code, coded.message)
    }
    entry.route = route

    try {
      await route.apply(config)
      entry.lastError = null
      try {
        entry.observed = await route.observe()
        entry.observedAt = nowSeconds()
      } catch {
        // Best-effort, exactly as on the VPN path: the write was accepted and read back inside
        // `apply()` already; a second read failing right afterwards does not undo that.
      }
    } catch (err) {
      const coded = toCodedError(err, 'E_NETWORK_APPLY_FAILED')
      entry.lastError = coded
      // The route object is dropped: an apply that failed leaves nothing live to observe or
      // revert through, and keeping it would make the next `GET` look like a healthy route.
      entry.route = null
      const current = readPersistedRoute(mustGet(row.id))
      if (current) recomputeAdvisoryChecks(row.id, entry, current)
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'network.applied',
        actor,
        meta: { engine: config.engine, config: redactRouteConfig(config), ok: false, error: coded },
      })
      throw new EnkakuError(coded.code, coded.message)
    }

    // The `upstream` check, forced on apply for the same reason the VPN path forces its egress
    // probe: an operator who just pressed apply should get a fresh answer, not the previous one.
    if (config.engine === 'adb-proxy') {
      entry.upstreamCheck = await runUpstreamCheck(config.host, config.port)
    } else {
      // The listener is on THIS machine and the phone reaches it over the adb connection, so the
      // upstream dial is a loopback dial: unlike rung 1's, a failure here is unambiguous — the
      // farm's own proxy is not listening on the port the operator named.
      entry.upstreamCheck = await runUpstreamCheck('127.0.0.1', config.hostPort)
      entry.reverseCheck = await runReverseCheck(row.id)
    }

    const current = readPersistedRoute(mustGet(row.id))
    if (current) recomputeAdvisoryChecks(row.id, entry, current)

    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'network.applied',
      actor,
      // `health` rides along on purpose: `ok: true` for an advisory rung means the device took the
      // write, and the event log must not let that be read as "this device's traffic is proxied".
      meta: { engine: config.engine, config: redactRouteConfig(config), ok: true, health: entry.health },
    })
  }

  /** The one dispatch every caller goes through (plan 114 §4.4's pseudocode). */
  async function applyRoute(row: DeviceRow, config: NetworkRouteConfig, actor: string | null): Promise<void> {
    if (config.engine === 'vpn-helper') return applyVpnRoute(row, config, actor)
    return applyAdvisoryRoute(row, config, actor)
  }

  /**
   * Plan 55 §4.1, §5.1 — `expect`/`onGeoFail` carry over from `previous` exactly like `failClosed`
   * does at the PUT handler below: an explicit value on THIS request wins, but a config update
   * alone (e.g. changing the port) is not an operator asking to drop a declared expectation.
   */
  function carryGeoFields(submitted: Socks5RouteConfig, previous: PersistedNetworkRoute | null): Pick<Socks5RouteConfig, 'expect' | 'onGeoFail'> {
    const previousVpn = previous?.config.engine === 'vpn-helper' ? previous.config : undefined
    const expect = submitted.expect ?? previousVpn?.expect
    const onGeoFail = submitted.onGeoFail ?? previousVpn?.onGeoFail
    return { ...(expect ? { expect } : {}), ...(onGeoFail ? { onGeoFail } : {}) }
  }

  /**
   * Turns a `PUT /network` request into a DECLARED config that never carries a raw secret (plan
   * 52 §4.2, §5.1) — the ONE place a client-supplied secret is ever accepted, and it never
   * reaches `devices.network_route` as plaintext.
   *
   * `vpn-helper` only, and that is the whole shape of plan 114 §3.8: the advisory rungs have no
   * credential path to normalise because they are refused a credential outright, so their config
   * is persisted exactly as the operator declared it.
   */
  function normalizeDeclaredConfig(
    row: DeviceRow,
    submitted: Socks5RouteConfig,
    previous: PersistedNetworkRoute | null,
    actor: string | null,
  ): Socks5RouteConfig {
    const previousVpn = previous?.config.engine === 'vpn-helper' ? previous.config : undefined
    const geo = carryGeoFields(submitted, previous)
    if (submitted.credentialRef) {
      if (!credentials.findByName(submitted.credentialRef)) {
        throw new EnkakuError('E_CREDENTIAL_NOT_FOUND', `no stored credential named "${submitted.credentialRef}"`)
      }
      return { engine: 'vpn-helper', host: submitted.host, port: submitted.port, udpMode: submitted.udpMode, credentialRef: submitted.credentialRef, ...geo }
    }
    if (submitted.username === undefined && submitted.password === undefined) {
      const carried = submitted.clearCredential ? undefined : previousVpn?.credentialRef
      // A carried-over name whose credential has since been deleted is dropped rather than
      // persisted as a dangling reference.
      return {
        engine: 'vpn-helper',
        host: submitted.host,
        port: submitted.port,
        udpMode: submitted.udpMode,
        ...(carried && credentials.findByName(carried) ? { credentialRef: carried } : {}),
        ...geo,
      }
    }
    const name = `device-${row.id}`
    credentials.upsert({ name, username: submitted.username, secret: submitted.password ?? '', createdBy: actor })
    return { engine: 'vpn-helper', host: submitted.host, port: submitted.port, udpMode: submitted.udpMode, credentialRef: name, ...geo }
  }

  /**
   * Plan 114 §3.3 — every write through this door is attributed, because the
   * resolution between a person and a plugin both setting the same device is
   * last-write-wins WITH attribution, never a lock (a lock there produces a
   * device nobody can fix).
   *
   * `null` for the core acting on its own: a reconnect re-apply is not somebody
   * setting a route, and stamping one would make the panel claim an operator
   * touched a device they never opened. That third case is not a gap in the
   * attribution — it is the answer the panel needs most, because a device
   * showing a proxy nobody remembers setting is exactly the confusion `setBy`
   * exists to prevent, and "the farm put this back after the phone reconnected"
   * is a truthful thing to be told.
   *
   * `kind` is read off the actor string rather than passed alongside it (step
   * 114.9). Plan 109 §4.3 already made `plugin:<name>` the one unambiguous
   * principal namespace — every capability a plugin invokes is audited under it
   * — so a route write whose actor is a plugin principal IS a plugin write, and
   * a second parameter saying so could only ever disagree with the string it
   * travelled beside. `pluginNameFromPrincipal` is that rule's one
   * implementation, imported rather than re-spelled here.
   *
   * The stored `id` is the plugin's own name, not the prefixed principal: the
   * panel renders "set by proxy-manager", and re-deriving the display name from
   * a prefixed string in Studio would be the same rule a third time.
   */
  function stampSetBy(actor: string | null): Pick<PersistedNetworkRoute, 'setBy'> {
    if (actor === null) return {}
    const plugin = pluginNameFromPrincipal(actor)
    return { setBy: { kind: plugin === null ? 'user' : 'plugin', id: plugin ?? actor, at: nowSeconds() } }
  }

  // ---- the one door ----

  /**
   * `PUT /api/devices/:id/network`, as a function (plan 114 §3.3, step 114.9).
   *
   * **This is the door, and the HTTP route is one caller of it, not the door
   * itself.** The other caller is `device.network.set`
   * (`packages/core/src/capability/device-network.ts`), which is how a plugin
   * reaches a device's route: through the capability broker, under the
   * `plugin:<name>` principal, checked against the plugin's own manifest before
   * `invoke()` is ever entered. Both callers therefore take the SAME lease
   * admission check, the SAME `E_HTTP_PROXY_NO_AUTH` refusal, the SAME
   * `network-route` lock, and write the SAME `network.applied` device event
   * with an actor on it.
   *
   * A plugin writing `settings put global http_proxy` itself would be a second
   * door with a different set of checks behind it, which is how two subsystems
   * end up disagreeing about what a phone is doing. There is deliberately no
   * private path into this service for the plugin runtime: `RouteService.device`
   * below hands out exactly these three functions and nothing narrower.
   *
   * `actor` is a bare principal string, exactly as the HTTP route reads it off
   * the session — `stampSetBy` is what decides whether it names a person or a
   * plugin, and it is the only place that decides.
   *
   * `opts.admission` (plan 114 §3.9, step 114.8) is the ONE thing a caller may
   * vary, and it does not widen what this function does — it names which
   * admission check has already been taken:
   *
   * - `'lease'` (the default, and what every existing caller gets by omitting
   *   it) takes `requireHeldLease` right here, unchanged.
   * - `'bulk'` means the caller has already taken a **strictly stronger** check
   *   of its own: `applyRouteInBulk` below reads the device's real holder, skips
   *   any device somebody else is driving instead of taking it over (§9 Q2), and
   *   holds a transient manual lease of its own for the length of the call on
   *   every device that can take one. It exists because `requireHeldLease`
   *   refuses an OFFLINE device outright, and §3.9 requires a bulk apply to
   *   *save* an offline device's route so it lands when the phone comes back —
   *   which is this function's own persist-before-apply order (see below), not a
   *   second write path. Everything else the door does — the union parse, the
   *   credential refusal, `assertLockFree`, the capture, the attributed device
   *   event — is unchanged and unskippable in both modes.
   */
  async function setRouteFromRequest(
    deviceId: string,
    raw: unknown,
    actor: string | null,
    opts?: { admission?: 'lease' | 'bulk' },
  ): Promise<NetworkStatusResult> {
    const row = mustGet(deviceId)
    if ((opts?.admission ?? 'lease') === 'lease') requireHeldLease(deps.leases, row.id)
    /**
     * `tagUntaggedRouteConfig` in front of the bare union, and the reason is a real constraint
     * rather than caution: a Zod discriminated union builds a map from the discriminator VALUE to
     * a member, so an object with NO `engine` key matches no entry and fails — even though
     * `Socks5RouteConfigSchema.engine` carries `.default('vpn-helper')`, because the default is
     * applied by the member, and the union never reaches a member to apply it.
     *
     * That matters today, not hypothetically: Studio sends an untagged SOCKS5 body until step
     * 114.6 lands, and `scripts/smoke-guest-agent.ts` builds one by hand. An untagged body is a
     * `vpn-helper` body by construction — it is the only engine that existed to write one — which
     * is exactly the same reading `readPersistedRoute` gives a pre-114 row on disk, and the same
     * function makes it in both places rather than two copies of the rule drifting apart.
     */
    const parsed = NetworkRouteConfigSchema.safeParse(tagUntaggedRouteConfig(raw))
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    // Plan 114 §3.8 — refused against the RAW body, before the union strips the offending key.
    assertNoHttpProxyAuth(raw, parsed.data.engine)

    const previous = readPersistedRoute(row)

    // Plan 114 §4.4 — the `network-route` lock. Runs BEFORE anything is persisted, because the
    // incumbent it has to revert is the one still on disk.
    await assertLockFree(row, previous, parsed.data.engine, actor)
    // Re-read: `assertLockFree` may have gone through `revertNetwork`, which for an advisory
    // incumbent restores the device's captured settings and leaves the row otherwise intact.
    const current = readPersistedRoute(mustGet(row.id))

    if (parsed.data.engine !== 'vpn-helper') {
      const config = parsed.data
      // Saves AND enables in one action, persisted BEFORE the apply attempt so the config survives
      // even if the apply below fails or the core dies mid-request (plan 44 step 5.4).
      writePersistedRoute(row.id, {
        config,
        enabled: true,
        // The capture is the device's own pre-farm state and belongs to the DEVICE, not to a
        // particular route: it survives a config change, an engine switch, and a disable, and is
        // only ever forgotten when `DELETE /network` clears the row after restoring it.
        ...(current?.captured ? { captured: current.captured } : {}),
        ...(current?.reverse ? { reverse: current.reverse } : {}),
        ...stampSetBy(actor),
      })
      await applyRoute(row, config, actor)
      return currentNetworkStatus(mustGet(row.id))
    }

    const config = normalizeDeclaredConfig(row, parsed.data, current, actor)
    // `failClosed`: an explicit value on THIS request wins (plan 54 §4.2, §5.6); otherwise it
    // carries over from whatever was there before; `resolveFailClosed()` supplies the safe default.
    const failClosed = parsed.data.failClosed ?? resolveFailClosed(current)
    // `exitHistory` carries over exactly like `sessionId`/`failClosed` do — a config update is not
    // an operator asking to forget the drift history observed so far (plan 55 §4.3).
    writePersistedRoute(row.id, {
      config,
      enabled: true,
      failClosed,
      ...(current?.exitHistory ? { exitHistory: current.exitHistory } : {}),
      ...(current?.captured ? { captured: current.captured } : {}),
      ...stampSetBy(actor),
    })
    ensureHeartbeat()

    await applyRoute(row, config, actor)

    return currentNetworkStatus(mustGet(row.id))
  }

  /**
   * `DELETE /api/devices/:id/network`, as a function — the other half of the
   * one door (step 114.9), and the one `device.network.clear` calls.
   *
   * Reverts FIRST — for an advisory route that is what restores the device's
   * captured settings, and the capture lives on the very row the next line
   * erases.
   */
  async function clearRouteFromRequest(deviceId: string, actor: string | null): Promise<NetworkStatusResult> {
    const row = mustGet(deviceId)
    // The disarm direction, same as `/network/disable` — `requireDisarmAdmission` carries the whole
    // argument. The plugin path into this function (`device.network.clear`) is NOT widened by this:
    // `createDeviceNetworkService`'s `withDevice` takes its own `admitMember` hold first and still
    // refuses an unreachable device with `device_unavailable` before it ever gets here.
    requireDisarmAdmission(deps.leases, row.id)
    await revertNetwork(row.id, actor, { forget: true })
    // **The row only goes when the phone was actually told.** Erasing it on a teardown that never
    // reached the device throws away the capture the revert still owes it and the device port the
    // reverse still has to be removed from — and leaves a phone carrying a proxy that nothing on
    // disk remembers writing. `revertNetwork` records that debt as `pendingClear`; admission
    // settles it and erases the row then, because `forget` travelled with it.
    const after = readPersistedRoute(mustGet(row.id))
    if (after?.pendingClear) writePersistedRoute(row.id, { ...after, enabled: false })
    else writePersistedRoute(row.id, null)
    maybeStopHeartbeat()
    return currentNetworkStatus(mustGet(row.id))
  }

  // ---- bulk (plan 114 §3.9, step 114.8) ----

  /**
   * The transient lease holder a bulk apply acquires under. A constant, not a
   * per-request id, so a lease this path somehow failed to release is
   * recognisable in `getHolder()`'s output rather than looking like an
   * anonymous client.
   */
  const BULK_LEASE_CLIENT = 'bulk:network-apply'

  /**
   * §3.9's classification, on the way OUT of a thrown error.
   *
   * Only lease-admission and reachability codes become skips. Everything else
   * keeps its own code and becomes a failure, which is what keeps
   * `E_SETTING_NOT_ACCEPTED` (the phone declined the write) apart from
   * `E_REVERSE_FAILED` (the tunnel never came up) apart from `E_ROUTE_LOCK_HELD`
   * (an incumbent route could not be turned off first). Three different problems
   * with three different next actions; flattening them into "3 failed" is the
   * exact thing this step exists to not do.
   */
  const BULK_SKIP_FOR_CODE: Record<string, string> = {
    // `checkInputAllowed`'s offline/quarantined answer, and `acquireManual`'s.
    device_unavailable: 'E_DEVICE_OFFLINE',
    // Someone else is driving the phone. Bulk names them and moves on; it never
    // takes a device over from a live session (plan 114 §9 Q2 — a route change
    // on a phone somebody is actively driving is exactly the change they will
    // not notice).
    device_held_by_other: 'E_DEVICE_HELD',
    lease_holder_changed: 'E_DEVICE_HELD',
    not_lease_holder: 'E_DEVICE_HELD',
    // A job holds the device. Still "someone else holds control" from the
    // operator's side, and the message that travels with it says which.
    device_busy_job: 'E_DEVICE_HELD',
    device_busy: 'E_DEVICE_HELD',
  }

  /**
   * VPN mode's per-device precondition, server side (plan 114 §3.4, §3.9).
   *
   * **This is where "never silently downgrade" is enforced in bulk.** Step
   * 114.7 built the single-device version of the rule; a bulk path that quietly
   * gave an agent-less phone an HTTP proxy instead would undo it forty times at
   * once, invisibly — the report would read "40 applied" and twenty of those
   * phones would be running a proxy an app can ignore while the operator
   * believed they were tunnelled.
   *
   * Reads `devices.preparation['guest-agent']`, which is authoritative since
   * plan 106 step 106.5 — the same record `VpnAgentPrecondition` reads in
   * Studio, not the parallel `GET /:id/guest-agent` vocabulary.
   *
   * `unsupported` is `E_UNSUPPORTED`, not `E_AGENT_NOT_READY`: plan 106's own
   * distinction is that an old phone is not a broken one, and a report that
   * files it under "not ready yet" invites an operator to keep retrying
   * something that can never work.
   */
  function vpnPrecondition(row: DeviceRow): { code: string; message: string } | null {
    const prep = deriveGuestAgentPreparation(row, deps.log)
    switch (prep.state) {
      case 'ready':
        return null
      case 'unsupported':
        return {
          code: 'E_UNSUPPORTED',
          message: `this phone cannot run the Enkaku guest agent${prep.reason ? `: ${prep.reason}` : ''}`,
        }
      case 'absent':
        return { code: 'E_AGENT_NOT_READY', message: 'the Enkaku guest agent is not installed on this phone, and VPN mode needs it' }
      case 'provisioning':
        return { code: 'E_AGENT_NOT_READY', message: 'the guest agent is still installing on this phone' }
      case 'outdated':
        return { code: 'E_AGENT_NOT_READY', message: 'the installed guest agent is older than this farm’s and has to be updated first' }
      case 'consent-required':
        // The one state where the agent itself is fine and only THIS layer is
        // blocked — so it refuses by name rather than borrowing `failed`'s
        // wording, and carries the provisioner's verbatim reason, which names
        // the dialog a human has to accept on the phone.
        return {
          code: 'E_AGENT_NOT_READY',
          message: `this phone has not granted Android VPN consent to the guest agent, so a VPN route cannot be applied${prep.reason ? `: ${prep.reason}` : ''}`,
        }
      case 'failed':
        // Verbatim, so twenty phones that failed for the same reason collapse
        // into one row and a twenty-first that failed differently stays visible.
        return { code: 'E_AGENT_NOT_READY', message: `the guest agent could not be prepared on this phone${prep.reason ? `: ${prep.reason}` : ''}` }
    }
  }

  /**
   * One device's worth of a bulk apply. Returns a row of §3.9's envelope; it
   * throws nothing, because a bulk report's job is to say what happened to every
   * device rather than to stop at the first one that did not work.
   *
   * The order below is the classification, and each step exists because the case
   * it catches actually happens across forty phones:
   *
   * 1. the device id does not resolve — a **failure**, not a skip: nothing about
   *    the phone is wrong, the request named something that is not there.
   * 2. VPN asked for on a phone whose agent is not ready — **skipped**, named,
   *    never downgraded.
   * 3. the phone is offline — **skipped**, but the route is *saved* first, so it
   *    lands when the phone comes back (`restoreAdvisoryRoute`/`restoreDeviceRoute`
   *    is the mechanism, unchanged). It goes through the same door, which is why
   *    an offline phone holding a DIFFERENT engine's route still gets refused by
   *    `assertLockFree` rather than silently overwritten.
   * 4. somebody else is driving it — **skipped**, naming them.
   * 5. otherwise, a transient lease, the door, and the lease released again.
   */
  async function applyRouteInBulk(
    deviceId: string,
    raw: unknown,
    engine: NetworkEngineId,
    actor: string | null,
  ): Promise<BulkApplyResult> {
    const skipped = (code: string, message: string): BulkApplyResult => ({ deviceId, status: null, skip: { code, message }, error: null })
    const failed = (err: unknown): BulkApplyResult => {
      const coded = toCodedError(err, 'E_NETWORK_APPLY_FAILED')
      const skipCode = BULK_SKIP_FOR_CODE[coded.code]
      if (skipCode) return skipped(skipCode, coded.message)
      return { deviceId, status: null, skip: null, error: coded }
    }

    let row: DeviceRow
    try {
      row = mustGet(deviceId)
    } catch (err) {
      return failed(err)
    }

    if (engine === 'vpn-helper') {
      const blocked = vpnPrecondition(row)
      if (blocked) return skipped(blocked.code, blocked.message)
    }

    // `row.status` is the same signal `restoreDeviceRoute` trusts for "leave it
    // alone, it is not there". A device that comes back between this read and
    // the apply below simply applies successfully, which is the harmless
    // direction for this race to go.
    if (row.status === 'offline' || row.status === 'quarantined') {
      try {
        const status = await setRouteFromRequest(deviceId, raw, actor, { admission: 'bulk' })
        return { deviceId, status, skip: null, error: null }
      } catch (err) {
        // Did the door get as far as persisting the intent? `setRouteFromRequest`
        // writes the route BEFORE attempting the apply precisely so a config
        // survives a failed attempt, so this is a fact on disk rather than a
        // guess about which line threw.
        const after = readPersistedRoute(mustGet(deviceId))
        if (after?.enabled && after.config.engine === engine) {
          return skipped(
            'E_DEVICE_OFFLINE',
            'the phone is not reachable — the route was saved and the farm applies it when the phone comes back',
          )
        }
        // Nothing was persisted, so the phone being offline is NOT what stopped
        // this — `assertLockFree` refused the switch (`E_ROUTE_LOCK_HELD`), or a
        // named credential was missing, or the device row vanished. Reporting
        // any of those as "offline" would send an operator to look at a phone
        // when the problem is on this side, so each keeps its own code.
        return failed(err)
      }
    }

    const holder = deps.leases.getHolder(row.id)
    if (holder) {
      // The operator's own hold is not somebody else's. `holderUserId` is only
      // comparable when this request is authenticated at all — in a local farm
      // with no login there is no id to match, so the honest answer is that we
      // cannot tell whose session it is, and the message says exactly that
      // rather than claiming the device is held by a stranger.
      const mine = actor !== null && holder.kind === 'user' && holder.id === actor
      if (!mine) {
        return skipped(
          'E_DEVICE_HELD',
          `${holder.label} is using this device — a bulk apply never takes a device over from a live session, so nothing was changed`,
        )
      }
      try {
        const status = await setRouteFromRequest(deviceId, raw, actor)
        return { deviceId, status, skip: null, error: null }
      } catch (err) {
        return failed(err)
      }
    }

    try {
      deps.leases.acquireManual(row.id, BULK_LEASE_CLIENT, actor)
    } catch (err) {
      return failed(err)
    }
    try {
      const status = await setRouteFromRequest(deviceId, raw, actor, { admission: 'bulk' })
      return { deviceId, status, skip: null, error: null }
    } catch (err) {
      return failed(err)
    } finally {
      // No reason passed: a transient hold ending is not a revocation anybody
      // needs to be told about, and `onManualRevoked` is how operators get told.
      deps.leases.releaseManual(row.id, BULK_LEASE_CLIENT)
    }
  }

  /**
   * `POST /api/devices/network/apply` (plan 114 §3.9, §4.5) — one route across a
   * selection, synchronously, in `POST /labels/apply`'s envelope (F19).
   *
   * A static route, registered before every `/:id/...` route below for the same
   * shadowing reason `/network/credentials` above is — and, like it, it cannot
   * actually collide, because no device-scoped route here has a literal second
   * segment of `apply`.
   *
   * **Not a batch and not a tray operation** (F20, §2). A settings write is
   * sub-second; minting a job row and a tray entry for something that finishes
   * before the dialog repaints is how a tray becomes noise. §3.9 names the
   * escape hatch if measurement ever contradicts that: mint a batch and inherit
   * cancel, concurrency and the tray for free.
   *
   * Serial, not concurrent. Forty parallel `settings put`s would contend on the
   * one adb server this farm shares with everything else on the machine, and the
   * per-device work here is a shell round trip, not a wait.
   */
  app.post('/network/apply', requirePermission('device.network'), async (c) => {
    const body = DeviceNetworkApplyBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', `a body of { deviceIds: string[], route: {...} } is required — ${body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    }
    // Validated ONCE for the whole request, against the RAW route object: a
    // malformed route, or one carrying a credential, is a defect in the request
    // and not forty identical per-device outcomes. The door re-parses and
    // re-refuses the same body per device — deliberately, because the door is
    // what every other caller goes through and it does not get to trust this one.
    const raw = body.data.route
    const parsed = NetworkRouteConfigSchema.safeParse(tagUntaggedRouteConfig(raw))
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `route.${i.path.join('.')}: ${i.message}`).join('; '))
    }
    assertNoHttpProxyAuth(raw, parsed.data.engine)

    const actor = c.get('user')?.id ?? null
    // Deduped: a selection that names the same device twice is an operator
    // mistake, not an instruction to apply twice, and a duplicate row in the
    // report would inflate every count under it.
    const deviceIds = [...new Set(body.data.deviceIds)]
    const results: BulkApplyResult[] = []
    for (const deviceId of deviceIds) {
      results.push(await applyRouteInBulk(deviceId, raw, parsed.data.engine, actor))
    }
    return c.json({ total: results.length, results })
  })

  // ---- endpoints ----

  app.get('/:id/network', async (c) => {
    const row = mustGet(c.req.param('id'))
    return c.json(await currentNetworkStatus(row))
  })

  app.put('/:id/network', requirePermission('device.network'), async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return c.json(await setRouteFromRequest(c.req.param('id'), raw, c.get('user')?.id ?? null))
  })

  app.post('/:id/network/enable', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireHeldLease(deps.leases, row.id)
    const persisted = readPersistedRoute(row)
    if (!persisted) {
      // Hard server-side refusal (plan 44 step 5.4) — the default config is null, and with
      // nothing stored there is nothing to enable.
      throw new EnkakuError('E_NO_ROUTE_CONFIG', 'no route config is stored for this device — PUT one first')
    }
    const actor = c.get('user')?.id ?? null
    // The SAME already-declared config/session is turning back on — every field but `enabled`
    // carries over unchanged (plan 52 §4.3). `pendingClear` is the one exception: an owed
    // teardown describes the route being turned back on right now, and the apply below either
    // lands (nothing is owed) or fails with its own error. Carrying it would leave admission
    // trying to take back a route the operator has just asked for.
    const { pendingClear: _superseded, ...carried } = persisted
    writePersistedRoute(row.id, {
      ...carried,
      enabled: true,
      failClosed: resolveFailClosed(persisted),
      ...stampSetBy(actor),
    })
    if (persisted.config.engine === 'vpn-helper') ensureHeartbeat()
    await applyRoute(row, persisted.config, actor)
    return c.json(await currentNetworkStatus(mustGet(row.id)))
  })

  app.post('/:id/network/disable', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    // The disarm direction — see `requireDisarmAdmission` for why this one endpoint and `DELETE`
    // accept a device no lease can be taken on, and why `/enable`, `PUT` and `/retry` do not.
    requireDisarmAdmission(deps.leases, row.id)
    const persisted = readPersistedRoute(row)
    const actor = c.get('user')?.id ?? null
    if (persisted) {
      await revertNetwork(row.id, actor)
      // Tears the route down but KEEPS the config, the session id and the capture, so it can be
      // switched back on without retyping the upstream (plan 52 §4.1, §4.3) — and, for an
      // advisory route, without losing the device's own original proxy settings.
      //
      // Re-read rather than reusing `persisted`: the revert above may have just recorded a
      // `pendingClear` on this row, and spreading the pre-revert copy over it would erase the one
      // record that says the phone was never told.
      const after = readPersistedRoute(mustGet(row.id)) ?? persisted
      writePersistedRoute(row.id, { ...after, enabled: false, ...stampSetBy(actor) })
      maybeStopHeartbeat()
    }
    return c.json(await currentNetworkStatus(mustGet(row.id)))
  })

  /**
   * Plan 90 §3.7 rule 4 — the honest version of the disable-then-enable workaround (F17): clears
   * the recovery bound unconditionally and applies once, immediately.
   *
   * Refused on the advisory rungs (plan 114 §4.5). There is no recovery loop to clear there and
   * nothing a retry would do that a plain re-apply does not, so answering "retried" would be a
   * word with no mechanism behind it.
   */
  app.post('/:id/network/retry', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireHeldLease(deps.leases, row.id)
    const persisted = readPersistedRoute(row)
    if (!persisted?.enabled) {
      throw new EnkakuError('E_NO_ROUTE_CONFIG', 'no enabled route for this device — enable one first')
    }
    if (persisted.config.engine !== 'vpn-helper') {
      throw new EnkakuError(
        'E_NOT_SUPPORTED',
        'this proxy mode has no automatic recovery to retry — the setting either reads back or it does not. Save the route again to re-apply it.',
      )
    }
    const actor = c.get('user')?.id ?? null
    resetRecovery(row.id)
    ensureHeartbeat()
    await applyRoute(row, persisted.config, actor)
    return c.json(await currentNetworkStatus(mustGet(row.id)))
  })

  app.delete('/:id/network', requirePermission('device.network'), async (c) => {
    return c.json(await clearRouteFromRequest(c.req.param('id'), c.get('user')?.id ?? null))
  })

  /**
   * `POST /api/devices/:id/network/credential/reveal` — reads a device's stored
   * upstream password back in plaintext, once, on request.
   *
   * **This reverses a stated posture, and the reversal is the point.** Until it
   * existed the panel said "Never shown back — type it again to change the
   * route", and an operator who could not remember which SOAX session a phone
   * was on had no way to find out, hand it to a colleague, or rotate it — the
   * farm had swallowed it. The credential was always *stored* (encrypted under
   * the `'network'` namespace since plan 52 §4.2); what changed is that there is
   * now a door, and the door is named, gated, and counted.
   *
   * **Why POST, and why a route of its own.** Not `GET /:id/network`: that is
   * what the device panel polls, so a password on it would travel to every open
   * browser continuously, whether anyone asked or not, and "who read this
   * password" would have no answer worth writing down. Not a `GET` of its own
   * either — a GET's URL lands in access logs, proxy logs, browser history and
   * `Referer` headers, is prefetchable and revalidatable, and reads as safe to
   * repeat. A POST is a deliberate act with a side effect, which is exactly what
   * this is: the side effect is the audit row.
   *
   * **The caller never names the credential.** There is no `credentialRef` in
   * the request; the credential is whichever one THIS device's persisted route
   * references. So this route cannot be used to walk the farm's credential
   * store — structurally, not by policy. Same narrowing `plugin.data` draws
   * against `kv.manage` in `auth/acl.ts`.
   *
   * **The gate: `device.network` AND the admin role**, checked inside the
   * handler rather than by `requirePermission` middleware.
   *
   * - `device.network` because this is authority over THIS device's route, and
   *   an actor with no business setting a phone's proxy has none reading its
   *   account either.
   * - The admin role on top of it, because `device.network` sits in the
   *   OPERATOR set and reading a stored proxy password is not the same authority
   *   as configuring a route. Setting a credential writes a secret INTO the
   *   farm; reading one back takes it OUT — the upstream account then works
   *   from anywhere, on any machine, with nothing about it scoped to this farm
   *   any more. `auth/acl.ts` already records exactly this reasoning for
   *   `kv.manage`, the farm's other "plaintext secret readable through this
   *   route" surface, and its answer is admin-only. This one lands in the same
   *   place by the same argument rather than a new one.
   * - **Inside the handler, not as middleware**, because `requirePermission`
   *   answers 403 before any handler body runs — and a refusal that leaves no
   *   trace is the half of the log that matters most. Every request through
   *   here writes exactly one row.
   *
   * **No lease is required, deliberately.** Every other mutating route in this
   * file takes `requireHeldLease`, because it touches the phone. This one never
   * goes near the phone — it reads a row and decrypts it. Demanding a lease
   * would mean an admin could not read a credential to hand to a colleague
   * while a job was running on that device, which is one of the situations the
   * feature exists for.
   *
   * **The plaintext exists in this response body and nowhere else.** It is not
   * logged (not at any level, not in a failure path), not put in an error
   * message, not stored on `NetworkRouteEntry`, and not cached — `Cache-Control:
   * no-store` says so to every hop in between. Plan 112 §0's measured hazard is
   * the standing reminder: the `socks` library hangs a plaintext password off
   * `err.options`, so an error object from anywhere near a credential must never
   * be re-thrown wholesale or serialised. Nothing below re-throws a raw error;
   * the decrypt failure path answers with its own coded message.
   */
  app.post('/:id/network/credential/reveal', async (c) => {
    const deviceId = c.req.param('id')
    const user = c.get('user')
    const actor = user?.id ?? null
    const at = nowSeconds()

    /**
     * One row per request, whatever happened. `meta` names the outcome, the
     * credential's NAME and whether it had a username — never the password,
     * never the username's value, and nothing derived from either (no hint, no
     * length, no prefix). An audit row is read by more people than the response
     * body ever is.
     */
    const recordAttempt = (outcome: string, meta: Record<string, unknown> = {}): void => {
      audit.record({
        userId: actor,
        action: 'device.network.credential.reveal',
        target: deviceId,
        meta: { outcome, role: user?.role ?? null, ...meta },
      })
    }

    if (!user || !can(user.role, 'device.network') || user.role !== 'admin') {
      recordAttempt('forbidden')
      return c.json(
        {
          error: {
            code: 'auth.forbidden',
            message:
              'reading a stored upstream password back requires an admin. Setting a route is operator work; taking its account out of the farm is not — ask an admin, who will leave an audit row naming themselves.',
          },
        },
        403,
      )
    }

    try {
      const row = mustGet(deviceId)
      const persisted = readPersistedRoute(row)
      if (!persisted) {
        recordAttempt('no-route')
        throw new EnkakuError('E_NO_ROUTE_CONFIG', 'no route config is stored for this device — there is no credential to show')
      }
      if (persisted.config.engine !== 'vpn-helper') {
        recordAttempt('wrong-engine', { engine: persisted.config.engine })
        throw new EnkakuError(
          'E_NOT_SUPPORTED',
          'this proxy mode stores no credential at all — Android’s system proxy setting has nowhere to put an account, so there is nothing to show',
        )
      }
      const credentialRef = persisted.config.credentialRef
      if (credentialRef === undefined) {
        recordAttempt('no-credential')
        throw new EnkakuError('E_CREDENTIAL_NOT_FOUND', 'this route connects to its upstream anonymously — it has no stored credential')
      }

      let resolved: { username?: string; password: string }
      try {
        resolved = credentials.resolve(credentialRef)
      } catch (err) {
        // The CODE is kept (a missing row and an undecryptable one are different problems with
        // different fixes) and the message is this file's own. Nothing from the crypto or store
        // layer is re-thrown or serialised — plan 112 §0's rule, applied to the one handler here
        // that has a plaintext anywhere near it.
        const code = err instanceof EnkakuError ? err.code : 'E_CREDENTIAL_CORRUPT'
        recordAttempt('unreadable', { credentialRef, code })
        throw new EnkakuError(
          code,
          code === 'E_CREDENTIAL_NOT_FOUND'
            ? `this route names a stored credential ("${credentialRef}") that no longer exists — save the route again with a username and password to replace it`
            : `the stored credential ("${credentialRef}") could not be decrypted with this farm’s key — save the route again with a username and password to replace it`,
        )
      }

      // Recorded BEFORE the body is serialised, and deliberately not in a `finally`: if the audit
      // insert throws, this request fails and the plaintext is never returned. An unaudited reveal
      // is not a degraded success, it is the one outcome this route must not have.
      recordAttempt('revealed', { credentialRef, hasUsername: resolved.username !== undefined })

      // `no-store`, not `no-cache`: the difference is that `no-cache` permits storing the body and
      // revalidating it, which for this body means writing a password to a disk cache.
      c.header('Cache-Control', 'no-store')
      c.header('Pragma', 'no-cache')
      return c.json({
        credentialRef,
        username: resolved.username ?? null,
        password: resolved.password,
        revealedAt: at,
      })
    } catch (err) {
      // Anything not already accounted for above — a device that does not exist, most of all.
      // `EnkakuError`s raised in the block above have written their own row already.
      if (!(err instanceof EnkakuError)) recordAttempt('error')
      else if (err.code === 'device_not_found') recordAttempt('device-not-found')
      throw err
    }
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return {
    routes: app,
    revertNetwork,
    restoreDeviceRoute,
    handleDeviceOffline,
    reconcileNetworkRoutes,
    isRouteEnabled: (deviceId) => persistedFor(deviceId)?.persisted.enabled === true,
    clearRoute: (deviceId) => {
      // The row survives a teardown the phone never heard, for the same reason `DELETE /network`'s
      // does: erasing it would throw away the capture the revert still owes the device and the
      // device port its reverse still has to be removed from. `enabled: false` alongside the debt
      // is the honest pair — nobody wants this route, and the phone has not been told yet.
      const owed = persistedFor(deviceId)?.persisted ?? null
      if (owed?.pendingClear) writePersistedRoute(deviceId, { ...owed, enabled: false })
      else writePersistedRoute(deviceId, null)
      maybeStopHeartbeat()
    },
    activeSessionOf: (deviceId) => networkStateByDevice.get(deviceId)?.session ?? null,
    device: {
      get: async (deviceId) => currentNetworkStatus(mustGet(deviceId)),
      set: setRouteFromRequest,
      clear: clearRouteFromRequest,
    },
  }
}
