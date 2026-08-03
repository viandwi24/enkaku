import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  PersistedNetworkRouteSchema,
  Socks5RouteConfigSchema,
  redactRouteConfig,
  type NetworkEngineId,
  type NetworkObservation,
  type PersistedNetworkRoute,
  type Socks5RouteConfig,
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
  /** Persisted route config, redacted — NEVER a password. Null when nothing has ever been declared. */
  config: { host: string; port: number; username?: string; udpMode: 'udp' | 'tcp' } | null
  /** The operator's declared on/off intent — separate from `config` on purpose (plan 44 step 5.4): the default config is null, and with no config there is nothing to enable. */
  enabled: boolean
  observed: NetworkObservation | null
  drift: boolean
  health: 'ok' | 'unverified' | 'degraded' | 'unknown'
  lastError: { code: string; message: string } | null
}

/** How often the daemon-wide heartbeat pings every device with an enabled route (plan 44 step 5.4) — the core's half of the dead-man's-switch pair described in plan 44 §8b; the agent's own half tears the route down after 90s of silence. */
const NETWORK_HEARTBEAT_INTERVAL_MS = 20_000

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
   * Tears down any applied network route for a device, idempotently — the
   * one piece of this file daemon.ts calls directly rather than through
   * HTTP, from the lease-teardown sites plan 33 §4.5 names (there is no
   * generic cleanup-hook registry, see plan 44 §5.7): `onManualRevoked` and
   * the device-offline path. `actor` is `null` for those automatic calls —
   * the device event log's own convention for "the core did this, not a user".
   */
  revertNetwork: (deviceId: string, actor?: string | null) => Promise<void>
  /**
   * Probes every device with a persisted `enabled: true` route and
   * reconciles in-memory state accordingly (plan 44 step 5.4) — run
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
    health: 'ok' | 'unverified' | 'degraded' | 'unknown'
    lastError: { code: string; message: string } | null
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

  function toConfigResponse(config: Socks5RouteConfig): NetworkStatusResult['config'] {
    return {
      host: config.host,
      port: config.port,
      ...(config.username !== undefined ? { username: config.username } : {}),
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
    let lastError: { code: string; message: string } | null = null
    let health: NetworkRouteEntry['health'] = 'unverified'
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
      health = observed.up ? 'unverified' : 'degraded'
    } catch (err) {
      // A cold read failing is an OBSERVE failure, never an apply failure (plan 44 §8b, "Bug 2") —
      // nothing here ever calls `route.start`.
      lastError = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
      health = 'degraded'
    }

    networkStateByDevice.set(row.id, { route: null, session: null, observed, health, lastError })
    if (observed) {
      deps.log.info(
        `network reconcile: device ${row.id} reports up=${observed.up}${observed.upstream ? ` via ${observed.upstream}` : ''} against the persisted upstream ${config.host}:${config.port}`,
      )
    } else {
      deps.log.warn(`network reconcile: device ${row.id} unreachable (${lastError?.code}), route stays enabled — will retry on the next heartbeat`)
    }
  }

  /**
   * On boot, a device may still be carrying a route applied by a PREVIOUS
   * core process (plan 44 step 5.4, fixing the "route outlived the farm"
   * defect in plan 44 §8b). Rather than blindly reapplying — which would
   * spin up a fresh tunnel even over one the operator already turned off
   * from Android Settings, or double-apply on top of one still healthy —
   * this probes every device with a persisted `enabled: true` route and
   * records what it finds. Exposed on the handle so a test can await it
   * deterministically instead of racing the fire-and-forget call below.
   */
  async function reconcileNetworkRoutes(): Promise<void> {
    const rows = db.select().from(devices).all()
    let anyEnabled = false
    for (const row of rows) {
      const persisted = readPersistedRoute(row)
      if (!persisted?.enabled) continue
      anyEnabled = true
      if (row.status === 'offline') {
        deps.log.info(`network reconcile: device ${row.id} is offline, leaving its route enabled and unprobed`)
        continue
      }
      await coldProbe(row, persisted.config)
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
          entry.lastError = null
          entry.health = observed.up ? 'unverified' : 'degraded'
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
          entry.health = 'degraded'
        }
        deps.log.warn(`network heartbeat: device ${row.id} failed, tolerated: ${coded.message}`)
      }
    }
  }

  /**
   * Re-reads the device's own `route.status` before answering, so a VPN an
   * operator switched off from Android Settings shows up as drift within one
   * poll (plan 44 acceptance #5) rather than continuing to claim a route
   * that no longer exists. `health` never reaches `'ok'` here — only an
   * egress probe could, and none exists in this slice (plan 44 §2, §4.3).
   */
  async function currentNetworkStatus(row: DeviceRow): Promise<NetworkStatusResult> {
    const persisted = readPersistedRoute(row)
    if (!persisted) {
      return { engine: 'none', config: null, enabled: false, observed: null, drift: false, health: 'unknown', lastError: null }
    }

    const entry = networkStateByDevice.get(row.id)
    if (entry?.route) {
      try {
        const observed = await entry.route.observe()
        entry.observed = observed
        entry.lastError = null
        entry.health = observed.up ? 'unverified' : 'degraded'
      } catch (err) {
        // A status re-read failing is an OBSERVE failure, never an apply failure (plan 44 §8b,
        // "Bug 2") — this device's route may well still be healthy; only this ONE read did not
        // succeed.
        entry.lastError = toCodedError(err, 'E_NETWORK_OBSERVE_FAILED')
        entry.health = 'degraded'
      }
    }

    return {
      engine: 'vpn-helper',
      config: toConfigResponse(persisted.config),
      enabled: persisted.enabled,
      observed: entry?.observed ?? null,
      drift: computeDrift(persisted.config, persisted.enabled, entry?.observed ?? null),
      health: entry?.health ?? 'unknown',
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
   * Applies `config` to `row`, creating a live route if none is held yet
   * (adopting a "cold" entry the same way) or reusing one already applied
   * this process. Shared by `PUT` (a fresh config) and `/enable` (the
   * config already on file) — both end up doing exactly this.
   */
  async function applyRoute(row: DeviceRow, config: Socks5RouteConfig, actor: string | null): Promise<void> {
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
      entry = { route, session, observed: null, health: 'unverified', lastError: null }
      networkStateByDevice.set(row.id, entry)
    }

    try {
      // `apply()` walks install → grant → bootstrap → forward → handshake →
      // route.start itself (plan 44 §4.4) — pressing apply installs the
      // agent if needed, exactly plan 44 §1 goal 2.
      await route.apply(config)
      entry.lastError = null
      entry.health = 'unverified'
      try {
        entry.observed = await route.observe()
      } catch {
        // Best-effort: apply() already succeeded, so a status read failing
        // right after does not invalidate that — `observed` simply stays
        // whatever it last was (null on a first apply), matching the
        // schema's "null before the first observation" contract.
      }
    } catch (err) {
      const coded = toCodedError(err, 'E_NETWORK_APPLY_FAILED')
      entry.lastError = coded
      entry.health = 'degraded'
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
    const config = parsed.data
    const actor = c.get('user')?.id ?? null

    // Saves AND enables in one action (the common path stays one action,
    // plan 44 step 5.4) — persisted BEFORE the apply attempt, so the config
    // (password included) survives even if the apply below fails or the
    // core dies mid-request.
    writePersistedRoute(row.id, { config, enabled: true })
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
    writePersistedRoute(row.id, { config: persisted.config, enabled: true })
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
      // Tears the route down but KEEPS the config, so it can be switched
      // back on without retyping the upstream (or its password).
      writePersistedRoute(row.id, { config: persisted.config, enabled: false })
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

  return { routes: app, revertNetwork, reconcileNetworkRoutes }
}
