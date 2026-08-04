import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  PersistedNetworkRouteSchema,
  Socks5RouteConfigSchema,
  CreateNetworkCredentialRequestSchema,
  redactRouteConfig,
  renderStickyUsername,
  deriveHealth,
  type NetworkEngineId,
  type NetworkObservation,
  type PersistedNetworkRoute,
  type Socks5RouteConfig,
  type NetworkCredential,
  type RouteCheck,
  type EgressProbeResult,
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
  config: { host: string; port: number; credentialRef?: string; udpMode: 'udp' | 'tcp' } | null
  /** The operator's declared on/off intent — separate from `config` on purpose (plan 44 step 5.4): the default config is null, and with no config there is nothing to enable. */
  enabled: boolean
  observed: NetworkObservation | null
  drift: boolean
  /** The per-device sticky-session id (plan 52 §4.3), read-only — null until a route has been applied at least once. */
  sessionId: string | null
  /** Derived from `checks` via `deriveHealth()` (plan 51 §4.1) — never set directly. */
  health: 'ok' | 'unverified' | 'degraded' | 'unknown'
  /** The named facts `health` was derived from — always present, even when every check is `unknown` (plan 51 §4.1, §5.8). */
  checks: RouteCheck[]
  lastError: { code: string; message: string } | null
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

/** A per-device sticky-session id (plan 52 §4.3) — generated once, kept stable thereafter. Not a secret, so a short opaque token is enough; it only has to be unlikely to collide and safe to embed in a username. */
function generateSessionId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
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
}

/**
 * Builds the six named checks (plan 51 §4.1) from what this process currently knows about a
 * device's route. Pure — every input is a plain value already held on the route's
 * `NetworkRouteEntry`, so this is trivial to unit-test without a fake device at all.
 */
/**
 * Pulls a human-readable address out of whatever the probe endpoint returned. Endpoints differ —
 * some answer `{"ip":"1.2.3.4"}`, some answer bare text — so this stays deliberately loose and
 * simply reports nothing it cannot recognise rather than guessing.
 */
function summariseEgress(body: string | undefined): string | undefined {
  if (!body) return undefined
  const trimmed = body.trim().slice(0, 400)
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>
      const ip = rec.ip ?? rec.address ?? rec.origin
      if (typeof ip === 'string') return `exit address ${ip}`
    }
  } catch {
    // not JSON — fall through to the plain-text shape below
  }
  return /^[0-9a-f.:]+$/i.test(trimmed) ? `exit address ${trimmed}` : undefined
}

function buildChecks(input: ChecksInput): RouteCheck[] {
  const checks: RouteCheck[] = []
  const now = nowSeconds()

  // tunnel — the device's own TUN/worker-thread state. An apply/observe failure (we could not
  // even ASK the device) outranks a stale `observed`: the honest reading of "we don't know
  // because the last attempt to find out failed" is `fail`, not a leftover `pass` from before
  // the failure started.
  if (input.lastError) {
    checks.push({ id: 'tunnel', state: 'fail', detail: safeCheckDetail(input.lastError.message, input.secrets), at: now })
  } else if (input.observed === null) {
    checks.push({ id: 'tunnel', state: 'unknown', at: null })
  } else if (input.observed.up) {
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

  // upstream — only the probe's tunnelled leg can answer "did a SOCKS5 session reach and
  // authenticate with the proxy" (plan 51 §4.2): `tunnel` above only means the TUN and the
  // tunnel's worker thread started, never that any session completed a handshake.
  if (input.probe) {
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
  if (!probeConfigured) {
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

  // geo — NEVER inferred from the username (a provider like SOAX encodes targeting there, but
  // that is provider-specific and guessing from it would produce confident nonsense against any
  // other provider). Skip unless an operator has stated an expectation — this slice has no input
  // for that yet.
  checks.push({ id: 'geo', state: 'skip', detail: 'no expected region was configured for this upstream', at: null })

  // dns — needs the probe endpoint's own authoritative-resolver hook (plan 51 §4.3, §5.3), which
  // is not built in this pass. Always skip rather than guess.
  checks.push({
    id: 'dns',
    state: 'skip',
    detail: 'DNS-leak detection needs a self-hosted probe endpoint with an authoritative-resolver hook (plan 51 §5.3, not implemented)',
    at: null,
  })

  // leak — asserting IPv6 is blocked needs on-device detection (plan 51 §4.5, §5.7), which is not
  // built in this pass either. Always skip rather than assert something nobody checked.
  checks.push({
    id: 'leak',
    state: 'skip',
    detail: 'IPv6 leak assertion is not implemented in this build (plan 51 §5.7, not implemented)',
    at: null,
  })

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
  /** Per-device shell exec, through the adb queue (the same shape `Transport.exec` and the inspector launcher use). */
  exec: (serial: string, cmd: string) => Promise<string>
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
  }

  const networkStateByDevice = new Map<string, NetworkRouteEntry>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

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
        ...(status.upstream !== undefined ? { upstream: status.upstream } : {}),
        ...(status.stats !== undefined ? { stats: status.stats } : {}),
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
    if (!persisted?.enabled) return
    if (row.status === 'offline') {
      deps.log.info(`network restore: device ${deviceId} is offline, leaving its route enabled and unprobed`)
      return
    }
    await coldProbe(row, persisted.config)
    ensureHeartbeat()
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
      if (!persisted?.enabled) continue
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
          recomputeChecks(entry, persisted.config)
        } else {
          await coldProbe(row, persisted.config)
        }
      } catch (err) {
        // A heartbeat failure is always an OBSERVE failure — this loop only ever reads status
        // (`entry.route.observe()`) or cold-probes; it never calls `route.start` (plan 44 §8b,
        // "Bug 2").
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
      return { engine: 'none', config: null, enabled: false, observed: null, drift: false, sessionId: null, health: 'unknown', checks: [], lastError: null }
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

    return {
      engine: 'vpn-helper',
      config: toConfigResponse(persisted.config),
      enabled: persisted.enabled,
      observed: redactObservationForResponse(entry?.observed ?? null, secretsFor(persisted.config)),
      drift: computeDrift(persisted.config, persisted.enabled, entry?.observed ?? null),
      sessionId: persisted.sessionId ?? null,
      health: entry?.health ?? 'unknown',
      checks: entry?.checks ?? [],
      lastError: entry?.lastError ?? null,
    }
  }

  /** Tears down any LIVE or COLD in-memory state for a device's route — never touches the persisted config/enabled columns, which the caller decides separately (PUT/enable keep it, disable keeps it, DELETE clears it). */
  async function revertNetwork(deviceId: string, actor: string | null = null): Promise<void> {
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
  function resolveWireConfig(declared: Socks5RouteConfig, sessionId: string): Socks5RouteConfig {
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
      }
      networkStateByDevice.set(row.id, entry)
    }

    try {
      // Resolve `credentialRef` (or legacy inline creds) into the actual username/password the
      // device needs, with the sticky-session template applied on top (plan 52 §4.2, §4.3) —
      // done INSIDE the try so a missing credential surfaces as a normal apply failure
      // (`E_CREDENTIAL_NOT_FOUND`), not an unhandled throw.
      const resolved = resolveWireConfig(config, sessionId)
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
   * - Neither `credentialRef` nor inline credentials is valid too — an upstream that genuinely
   *   needs no authentication.
   */
  function normalizeDeclaredConfig(row: DeviceRow, submitted: Socks5RouteConfig, actor: string | null): Socks5RouteConfig {
    if (submitted.credentialRef) {
      if (!credentials.findByName(submitted.credentialRef)) {
        throw new EnkakuError('E_CREDENTIAL_NOT_FOUND', `no stored credential named "${submitted.credentialRef}"`)
      }
      return { host: submitted.host, port: submitted.port, udpMode: submitted.udpMode, credentialRef: submitted.credentialRef }
    }
    if (submitted.username === undefined && submitted.password === undefined) {
      return { host: submitted.host, port: submitted.port, udpMode: submitted.udpMode }
    }
    const name = `device-${row.id}`
    credentials.upsert({ name, username: submitted.username, secret: submitted.password ?? '', createdBy: actor })
    return { host: submitted.host, port: submitted.port, udpMode: submitted.udpMode, credentialRef: name }
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
    const config = normalizeDeclaredConfig(row, parsed.data, actor)

    // Saves AND enables in one action (the common path stays one action,
    // plan 44 step 5.4) — persisted BEFORE the apply attempt, so the config
    // survives even if the apply below fails or the core dies mid-request.
    // `failClosed` carries over from whatever was there before (plan 51
    // §4.4) — a config update is not an operator asking to reset it.
    const previous = readPersistedRoute(row)
    writePersistedRoute(row.id, { config, enabled: true, ...(previous?.failClosed !== undefined ? { failClosed: previous.failClosed } : {}) })
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
      ...(persisted.failClosed !== undefined ? { failClosed: persisted.failClosed } : {}),
      ...(persisted.sessionId !== undefined ? { sessionId: persisted.sessionId } : {}),
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
