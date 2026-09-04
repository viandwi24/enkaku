import { Hono } from 'hono'
import type { AdbClient } from '@enkaku/adb'
import type { AgentStatus, ShellResult, TransportExecOptions } from '@enkaku/protocol'
import {
  GUEST_AGENT_PACKAGE,
  GuestAgentClientError,
  createGuestAgentClient,
  createGuestAgentLauncher,
  type GuestAgentClient,
  type GuestAgentClientOptions,
  type GuestAgentLauncher,
} from '@enkaku/drivers'
import type { PortAllocator } from '@enkaku/session'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import type { DeviceRow } from '../db/schema'
import type { EventRecorder } from '../events/recorder'
import type { ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import type { DeviceStateMachine } from '../device/state-machine'
import type { Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'
// Single source of truth for "is this device eligible for the guest agent"
// (plan 90 §3.8, 00-overview §4.3 "replace, never version") — this file used
// to keep its own copy of this same constant.
import { MIN_SUPPORTED_SDK } from '../device/agent-provisioner'
import {
  ERROR_STATUS,
  createRouteService,
  mustGetDevice,
  withNetworkAdmission,
  type DeviceNetworkPort,
  type DeviceSession,
  type DeviceSessionCallOpts,
  type RouteService,
} from '../network/route-service'
import type { ReverseRegistry } from '../network/reverse-registry'

/**
 * `GET/POST/DELETE /api/devices/:id/guest-agent` (plan 44 §5.7, §5.8) — the
 * guest agent's own install/uninstall/status surface, plus the per-device
 * `DeviceSession` that owns a device's ONE bootstrap token.
 *
 * **What this file no longer holds.** Step 114.3 moved the whole network-route
 * half — nine HTTP routes, the persisted-route read/write pair, the check and
 * health derivation, the heartbeat, bounded recovery, and the engine
 * construction — into `packages/core/src/network/route-service.ts`. This file
 * was 2610 lines before that move, and plan 114 adds two more engines to the
 * layer; the extraction is the sequencing that keeps the next plan from
 * inheriting a 3500-line module. `createGuestAgentRoutes` still returns one
 * handle covering both halves, and still mounts both under `/api/devices`, so
 * nothing outside this file had to learn about the split.
 *
 * **What stayed, and why it had to.** A device's guest agent holds exactly one
 * token in memory at a time, so every caller for that device — a route apply, a
 * status probe, the agent provisioner's `hello`, the session manager's IME
 * ladder — must share one `DeviceSession` or they invalidate each other's
 * clients (plan 44 §8b, "Bug 1"). That session, its launcher, and its port are
 * built here and handed to the route service as deps; the route service hands
 * back `activeSessionOf` so `withEphemeralSession` below can reuse a session a
 * live VPN route is already holding rather than minting a second token.
 *
 * A device's network route also cannot outlive its guest agent: uninstalling
 * the agent tears the route down first (`DELETE /:id/guest-agent` below), and
 * applying a VPN route installs the agent if needed (plan 44 §1, goal 2).
 */

/** GET's own status probe does not need a fresh-install budget — a handful of retries is enough to tell "not answering" from "still slow". `installAndProbe` uses the full budget (plan 44 §5.1's proven retry count) since a cold start right after `adb install` is slower. */
const STATUS_HANDSHAKE_RETRIES = 2
const INSTALL_HANDSHAKE_RETRIES = 8

/**
 * How many times a fresh session re-pushes its pairing token before giving up
 * (see `createDeviceSession`'s `bootstrap` for the mechanism). Three, not
 * more: each round already contains the client's own handshake ladder, so
 * three rounds is seconds of patience, and a token that is still refused
 * after three pushes is not a race any longer — it is a second writer, which
 * is a fact worth reporting rather than out-waiting.
 */
const PAIRING_ROUNDS = 3

/**
 * Plan 90 §4.7, docs/plans/96-m61-hotfixes.md's Gap 2 fix: widened
 * ADDITIVELY (never narrowed — `GuestAgentStatusResponseSchema`,
 * `packages/protocol/src/api/devices.ts`, is the wire contract this must
 * stay a subset of) to carry `outdated`/`failed`, the two states
 * `AgentProvisioner.status()` can report that the pre-plan-90 live
 * presence+hello check never produced.
 */
export type GuestAgentState = 'not-installed' | 'installed' | 'ready' | 'unreachable' | 'unsupported' | 'outdated' | 'failed' | 'consent-required'

export interface GuestAgentStatusResult {
  state: GuestAgentState
  appVersion?: string
  androidSdkInt?: number
  capabilities?: string[]
  reason?: string
  /**
   * Plan 90 §4.7, Gap 2 fix — populated only when this result came from
   * `AgentProvisioner.status()`; the legacy live-probe path (`statusOf`
   * below, still used when no `agentProvisioner.status` is wired) never sets
   * these.
   */
  versionCode?: number | null
  checkedAt?: number | null
  attempts?: number
  nextAttemptAt?: number | null
}

/**
 * Re-exported from `../network/route-service`, where step 114.3 moved the route
 * lifecycle. Kept on this module's surface because these are the response
 * shapes of endpoints this file still mounts, and every existing importer
 * reaches for them here.
 */
export type { NetworkRecoveryStatus, NetworkRouteConfigResponse, NetworkStatusResult } from '../network/route-service'

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
    toolchain?: { resolveToolPath(id: string): Promise<string>; ensureRequiredTools(ids: string[]): Promise<void> }
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
  //    path adb and the ui-server inspector take. `guest-agent` is deliberately NOT in
  //    REQUIRED_TOOLS (plan 43 §5.5 — installing it must never gate daemon boot), so nothing
  //    provisions it ahead of time; `ensureRequiredTools` here is what performs that provisioning
  //    on demand, the first time it is actually needed, installing+activating it if no active
  //    pointer exists yet (a no-op, fast, once it does).
  if (opts.toolchain) {
    try {
      await opts.toolchain.ensureRequiredTools(['guest-agent'])
      return await opts.toolchain.resolveToolPath('guest-agent')
    } catch (err) {
      // fall through to the error below, which says more than a bare provisioning failure would —
      // but log the real reason first, since "no APK available" alone hides e.g. a download/
      // checksum failure that has nothing to do with a missing local build.
      opts.onLog?.('warn', `provisioning the guest agent APK failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  throw new EnkakuError(
    'E_GUEST_AGENT_APK_MISSING',
    'No guest agent APK available. Build one with `bun run build:guest-agent`, or set ENKAKU_GUEST_AGENT_PATH to an existing APK.',
  )
}

export interface GuestAgentRoutesDeps {
  db: Db
  /**
   * CLI-level adb (install/uninstall) — the same helper the session/inspector wiring uses.
   * `forward`/`removeForward` no longer ride this (plan 119 §4.2) — see `adb` below.
   */
  hostAdb: (args: string[]) => Promise<string>
  /**
   * The direct-socket forward/list-forward/killForward trio (plan 119 §4.1, §4.2) — threaded
   * straight through to `createGuestAgentLauncher`'s own `adb` dep, so `hello()`'s reconnect path
   * (via `agentProvisioner`'s launcher) and this file's own launcher never spawn `adb.exe` for that
   * trio. See `GuestAgentLauncherDeps['adb']`'s doc comment for the inference caveat on two of the
   * three wire shapes.
   */
  adb: Pick<AdbClient, 'forward' | 'listForward' | 'killForward'>
  /**
   * Per-device shell exec, through the adb queue (the same shape `Transport.exec` uses).
   *
   * `opts` is passed through since step 114.3: the `adb-proxy` engine's `settings get/put` calls
   * ask for the `probe` profile, and forcing every one of them onto the launcher's own
   * `appLifecycle` budget would be a silently wrong timeout for a sub-second shell read. Optional,
   * so every existing caller that supplies a two-argument function keeps compiling.
   */
  exec: (serial: string, cmd: string, opts?: TransportExecOptions) => Promise<ShellResult>
  apkPath: () => Promise<string>
  ports: Pick<PortAllocator, 'claim' | 'release'>
  /** The device activity registry (plan 205 §4.2, §4.8) — the one admission door every mutating endpoint here and in `route-service.ts` takes. */
  activities: Pick<ActivityRegistry, 'list' | 'start' | 'end'>
  /** `control.overControl`/`control.idleSec`, read fresh on every admission check (plan 205 §4.5). */
  controlSettings: () => ControlPolicySettings
  states: Pick<DeviceStateMachine, 'current'>
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
   */
  routeTimings?: { applySettleTimeoutMs?: number; applySettleIntervalMs?: number; revertPollTimeoutMs?: number }
  /**
   * Plan 54 §3.2, §4.2 — the backoff (seconds) between bounded automatic-recovery attempts;
   * length is the attempt bound. Default `[5, 20, 60]`.
   */
  recoveryBackoffS?: number[]
  /** Raw override for the re-arm delay — takes priority over `guestAgentSettings().recoveryRearmSec` when set (plan 90 §3.7 rule 3). */
  recoveryRearmS?: number
  /** Plan 55 §3.2, §5.1 — the geo-lookup half of `FarmSettingsSchema.network`, read fresh on every call. */
  networkSettings?: () => { geoProvider?: string; geoIntervalSec: number }
  /** Plan 90 §3.7, §4.4 — `FarmSettingsSchema.guestAgent`'s recovery half, read fresh on every call. */
  guestAgentSettings?: () => { maxRecoveryCyclesPerHour: number; recoveryRearmSec: number }
  /**
   * Plan 90 §3.8, §4.7 — the "on demand, single device" provisioning hook.
   * Optional so every existing test/call site keeps constructing this router
   * unchanged. When set, `POST /:id/guest-agent` ALSO runs a full pass through
   * `AgentProvisioner.ensure({ force: true })` after its own existing
   * install+probe.
   *
   * `GET /:id/guest-agent` is different (docs/plans/96-m61-hotfixes.md's Gap 2
   * fix): when `status` below is wired, `GET` answers from
   * `AgentProvisioner.status()` — the SAME persisted `devices.agent` row
   * `DeviceInfoSchema.agent` reads — instead of running its own live
   * presence+hello probe. `remove` is that fix's own follow-on: an operator's
   * `DELETE` must clear the same persisted row, or a subsequent `GET` reports a
   * stale `ready` for a package that was just removed.
   */
  agentProvisioner?: {
    ensure: (deviceId: string, opts?: { force?: boolean }) => Promise<unknown>
    status?: (deviceId: string) => Promise<AgentStatus>
    remove?: (deviceId: string, actor: string | null) => Promise<unknown>
  }
  /**
   * Plan 114 §4.3, step 114.4 — `adb reverse` and the map that survives a
   * replug, forwarded to the route service for the `adb-reverse-proxy` rung.
   * Optional: a core without it refuses that engine by name rather than
   * applying it without its tunnel.
   */
  reverse?: ReverseRegistry
}

export interface GuestAgentRoutesHandle {
  routes: Hono<AuthEnv>
  /**
   * Tears down any applied network route for a device, idempotently.
   *
   * A route is a property of the DEVICE now, not of whoever is in control
   * (plan 52 §0, §3.1): this is called ONLY for an operator's explicit act —
   * `/disable`, `DELETE /network`, and `DELETE /guest-agent` (uninstall) —
   * never automatically on a control marker ending or a disconnect, and never
   * on the device going offline (see `handleDeviceOffline` for that case). `actor` is
   * `null` only for the uninstall path's own internal call.
   */
  revertNetwork: (deviceId: string, actor?: string | null) => Promise<void>
  /**
   * A device just came back online with a persisted `enabled: true` route
   * (plan 52 §4.1, §5.3) — probes it (never blindly re-applies, §3.2) and
   * reconciles in-memory state. A no-op for a device with no route, or one
   * whose route is disabled.
   */
  restoreDeviceRoute: (deviceId: string) => Promise<void>
  /**
   * A device just went offline (plan 52 §4.1). The stored route is left exactly
   * as it is, but any live session/port this process was holding for it is
   * released, and every check is marked `unknown` rather than left showing a
   * stale `pass`.
   */
  handleDeviceOffline: (deviceId: string) => Promise<void>
  /**
   * Restores every device with a persisted `enabled: true` route (plan 52 §4.1)
   * — run automatically, fire-and-forget, once at construction. Exposed here so
   * a test can await it deterministically instead of racing that call.
   */
  reconcileNetworkRoutes: () => Promise<void>
  /**
   * Plan 114 §4.3 — the reverse registry's `routeEnabled` veto. A route an
   * operator disabled while the phone was away must not come back just because
   * the phone did, and the registry deliberately does not read the database
   * itself.
   */
  isRouteEnabled: (deviceId: string) => boolean
  /**
   * Plan 58 §4.5, §5.5 — lets `device-identity.ts` run a guest-agent call
   * through the EXACT SAME per-device session a network route already owns,
   * instead of bootstrapping a second, independent one (plan 44 §8b's "Bug 1":
   * two independent bootstraps mint two tokens and invalidate each other).
   */
  withGuestAgentClient: <T>(deviceId: string, fn: (client: GuestAgentClient) => Promise<T>) => Promise<T>
  /**
   * Plan 114 §3.3, step 114.9 — the one door, for callers that are not HTTP
   * requests. `daemon.ts` threads it into `CapabilityContextDeps.network`, which
   * is what `device.network.get`/`.set`/`.clear` delegate to and therefore what
   * a plugin holding `device.network` reaches through `ctx.farm.call`.
   *
   * It is the SAME three functions the HTTP routes above call — not a parallel
   * implementation — so a plugin's route change takes the same activity
   * admission, the same lock, and writes the same attributed device event.
   */
  deviceNetwork: DeviceNetworkPort
  /** The `set-network` actions API verb's one door (plan 207 §4.2, §5 step 207.4) — the SAME five functions the HTTP routes above call. */
  routeActions: RouteService['actions']
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
        adb: deps.adb,
        apkPath: deps.apkPath,
        onLog: (level, msg) => deps.log[level](msg),
      }))
  const makeClient = deps.makeClient ?? createGuestAgentClient

  const mustGet = (id: string): DeviceRow => mustGetDevice(db, id)

  /**
   * The route half, extracted in step 114.3. Declared with `let` and assigned
   * below because the dependency runs both ways and neither direction can be
   * removed: the route service needs this file's session factories, and
   * `withEphemeralSession` here needs the route service's live-session map so a
   * status probe reuses a VPN route's session instead of minting a second
   * token. Everything that reads it does so at request time, long after
   * construction; the one exception is the route service's own fire-and-forget
   * boot reconcile, which is why that call was moved OUT of the service and
   * placed after the assignment below rather than left inside it.
   */
  let routeService: RouteService | null = null

  /**
   * A per-device guest-agent session: owns the token, the forwarded port, and the client, all
   * lazily created on first use and reused by EVERY operation on that device — `apply`, `observe`,
   * `revert`, a guest-agent status probe, the heartbeat. This is the fix for plan 44 §8b's "Bug 1"
   * (three independent call sites used to each mint their own token, invalidating each other's
   * live client).
   *
   * Mirrors `createGuestAgentSession` in
   * `packages/drivers/src/network/guest-agent/vpn-helper.ts` (kept here rather than imported:
   * `@enkaku/drivers`'s package `exports` map only exposes its `.` entry point, and that file's
   * own copy exists to be the driver layer's own tested, documented reference). If the two ever
   * drift, this one is the one actually wired into production.
   */
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
      // No longer fatal when the VPN app op will not take: `ensurePreGranted()` reports that as a
      // `GuestAgentVpnConsent` instead of throwing, because a phone that refuses `appops set` still
      // runs every other facet the agent has. The provisioner turns the same fact into the
      // `consent-required` device state; this session just carries on.
      await opts.launcher.ensurePreGranted()
      // Fresh on every (re-)bootstrap, never pre-emptively for a call that can just reuse the
      // already-live client (plan 44 §8b, "Bug 1").
      const token = crypto.randomUUID()
      if (port === null) port = await opts.claimPort()
      const newClient = opts.client({ port, token, ...callOpts })

      // The token handover is ASYNCHRONOUS and the agent is not idle while it happens.
      // `launcher.bootstrap()` runs `am start … --es token <t>` and returns as soon as `am` does;
      // the token only reaches `Pairing` once BootstrapActivity has run and
      // `startForegroundService` has delivered `onStartCommand` — ~500 ms on a moto g06 and on both
      // OPPOs, measured. In that window a ControlService that survived from an earlier session is
      // still holding the PREVIOUS token, so it answers `E_UNAUTHORISED` / "bad or missing token"
      // rather than "not paired". `client.hello()` already retries that on its own ladder, which
      // covers the ordinary case; what it cannot do is push the token again, and re-pushing is the
      // only thing that helps once some other pass has stomped it.
      //
      // So: re-push and re-hello, bounded, and never a loop. This is the self-healing half of a
      // token mismatch (`R9RL608MQTT` and `ZP2222T7K5` in the reference farm both sat at a
      // permanent `failed: bad or missing token` because one racy pass at admission was the only
      // pass they ever got). The re-push is `am start` with the SAME token this core just minted —
      // it never accepts a token from the device, so this cannot be turned into a downgrade.
      let lastErr: unknown
      for (let round = 1; round <= PAIRING_ROUNDS; round++) {
        await opts.launcher.bootstrap(token)
        // Round 1 only: a `E_UNAUTHORISED` answer is proof the forward is already carrying traffic
        // to the right device, so re-checking it on the later rounds buys nothing.
        if (round === 1) await opts.launcher.forward(port)
        try {
          // Refuse a protocol mismatch rather than degrade (CLAUDE.md, plan 44 §5.5's client.ts).
          await newClient.hello()
          if (round > 1) deps.log.info(`guest-agent session[${opts.deviceId}]: re-pairing round ${round} was accepted`)
          client = newClient
          return newClient
        } catch (err) {
          if (!(err instanceof GuestAgentClientError) || !REAUTH_CODES.has(err.code)) throw err
          lastErr = err
          if (round === PAIRING_ROUNDS) break
          deps.log.warn(
            `guest-agent session[${opts.deviceId}]: the agent answered ${err.code} to this session's token — re-pushing it (round ${round + 1}/${PAIRING_ROUNDS})`,
          )
        }
      }
      const code = lastErr instanceof GuestAgentClientError ? lastErr.code : 'E_UNAUTHORISED'
      throw new GuestAgentClientError(
        code,
        `the guest agent is installed, running and reachable on this device, but rejected this core's pairing token ` +
          `after ${PAIRING_ROUNDS} attempts (${code}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}). ` +
          'It is holding a token this core did not issue. The token is handed over by ' +
          '`am start dev.enkaku.guestagent/.BootstrapActivity --es token <token>`, which returns before ' +
          'ControlService has received it, so the usual cause is a second guest-agent session pairing the same ' +
          'device concurrently and overwriting this one.',
      )
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
          // nothing else already replaced it.
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

  /**
   * The set of `GuestAgentClientError` codes that mean "the agent forgot this token" (a genuine
   * on-device restart) rather than "the agent is unreachable" — the only codes a `DeviceSession`
   * treats as worth one re-bootstrap (plan 44 §8b, "Bug 1").
   */
  const REAUTH_CODES = new Set(['E_UNAUTHORISED', 'E_NOT_PAIRED'])

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
   * The ephemeral session a device currently has OPEN, with a reference count. See
   * `withEphemeralSession` below for why it exists at all.
   */
  const ephemeralSessions = new Map<string, { session: DeviceSession; refs: number }>()

  /**
   * Runs `fn` against `row`'s shared device session — reusing the one already backing an applied
   * network route (`routeService.activeSessionOf`) when there is one, exactly the fix for plan 44
   * §8b's "Bug 1": a guest-agent status probe or a cold network read must never mint a SEPARATE
   * token that rotates the live route's token out from under it. When no route is applied for this
   * device, a fresh session is built, used, and closed again — never held across calls for a
   * device with no applied route (the port-allocator contract).
   *
   * **Concurrent callers share that ephemeral session too**, reference-counted, which is the part
   * that used to be missing. A device holds exactly ONE pairing token at a time; two callers that
   * each built their own session each minted a token, and the second `am start` overwrote the
   * first, leaving the first caller retrying `E_UNAUTHORISED` against a token the agent had already
   * forgotten. That is plan 44 §8b's "Bug 1" again, in the branch where no VPN route happens to be
   * applied — and it is reachable on any ordinary admission, because `daemon.ts`'s `onDeviceReady`
   * fires `agentProvisioner.ensure`, `labelling.reconcile` and `preparationRunner.ensure` with no
   * `await` between them, and the session manager's IME ladder and `device-identity`'s GPS apply
   * can land in the same window. `DeviceSession.withClient` already coalesces concurrent
   * bootstraps onto one in-flight token; sharing the session is what puts every caller behind that
   * one coalescing point instead of beside it.
   *
   * The count is what preserves the old contract: the LAST caller out closes the session and
   * releases the forwarded port, so a device with no applied route still holds nothing between
   * calls. Reference counting rather than a queue on purpose — a queue would serialise a 30-second
   * egress probe in front of a status read, and would deadlock outright if a future caller ever
   * nested one guest-agent call inside another.
   */
  async function withEphemeralSession<T>(
    row: DeviceRow,
    fn: (client: GuestAgentClient) => Promise<T>,
    opts?: DeviceSessionCallOpts,
  ): Promise<T> {
    const shared = routeService?.activeSessionOf(row.id) ?? null
    if (shared) return shared.withClient(fn, opts)
    let holder = ephemeralSessions.get(row.id)
    if (!holder) {
      holder = { session: makeSession(row), refs: 0 }
      ephemeralSessions.set(row.id, holder)
    }
    holder.refs += 1
    try {
      return await holder.session.withClient(fn, opts)
    } finally {
      holder.refs -= 1
      if (holder.refs === 0 && ephemeralSessions.get(row.id) === holder) {
        ephemeralSessions.delete(row.id)
        await holder.session.close().catch((err: unknown) => {
          deps.log.warn(`guest-agent ephemeral session[${row.id}] close() failed, tolerated: ${String(err)}`)
        })
      }
    }
  }

  // ---- the route half (step 114.3) ----

  const service = createRouteService({
    db,
    exec: deps.exec,
    apkPath: deps.apkPath,
    activities: deps.activities,
    controlSettings: deps.controlSettings,
    states: deps.states,
    dataDir: deps.dataDir,
    log: deps.log,
    ...(deps.record ? { record: deps.record } : {}),
    makeLauncher,
    makeSession,
    withEphemeralSession,
    ...(deps.routeTimings ? { routeTimings: deps.routeTimings } : {}),
    ...(deps.recoveryBackoffS ? { recoveryBackoffS: deps.recoveryBackoffS } : {}),
    ...(deps.recoveryRearmS !== undefined ? { recoveryRearmS: deps.recoveryRearmS } : {}),
    ...(deps.networkSettings ? { networkSettings: deps.networkSettings } : {}),
    ...(deps.guestAgentSettings ? { guestAgentSettings: deps.guestAgentSettings } : {}),
    ...(deps.agentProvisioner ? { agentProvisioner: deps.agentProvisioner } : {}),
    ...(deps.reverse ? { reverse: deps.reverse } : {}),
  })
  routeService = service

  // ---- guest-agent status / install / uninstall ----

  function unsupportedResult(apiLevel: number): GuestAgentStatusResult {
    return {
      state: 'unsupported',
      reason: `Android API ${apiLevel} is below ${MIN_SUPPORTED_SDK} (Android 10) — the guest agent needs VpnService behaviour only proven from API ${MIN_SUPPORTED_SDK} onward (plan 44 §5.1)`,
    }
  }

  /**
   * Hello over `row`'s shared device session (plan 44 §8b, "Bug 1" — no bootstrap of its own
   * here). Distinguishes `installed` (something before the handshake failed — app-op, bootstrap,
   * or the forward's ownership check) from `unreachable` (the handshake itself, over an
   * established forward, did not succeed) by whether the failure is a `GuestAgentClientError` —
   * the only kind `client.hello()` ever throws.
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

  /**
   * Maps `AgentProvisioner.status()`'s persisted `AgentStatus` onto this endpoint's own response
   * shape (plan 90 §4.7, docs/plans/96-m61-hotfixes.md's Gap 2 fix) — additive per
   * `GuestAgentStatusResponseSchema`'s own doc comment: the pre-plan-90 five states plus
   * `outdated`/`failed`, never a narrowing. `provisioning` has no analogue in the pre-plan-90 enum
   * and is mapped to `installed` ("something is happening here, not yet confirmed ready") rather
   * than `not-installed`, so a future producer of that state degrades to the least-wrong existing
   * label instead of silently regressing to "nothing is here".
   */
  function agentStatusToResult(status: AgentStatus): GuestAgentStatusResult {
    // `?? undefined` (a presence check via nullish-coalescing, never a comparison operator) is
    // deliberate here, not a style choice: R2 (plan 90 §3.9, guarded workspace-wide by
    // `packages/drivers/src/network/guest-agent/version-skew-guard.test.ts`) forbids `appVersion`
    // next to ANY comparison operator, including a bare null check. This never gates behaviour on
    // the version string either way — it only decides whether to relay a value the provisioner
    // already computed.
    return {
      state: status.state === 'absent' ? 'not-installed' : status.state === 'provisioning' ? 'installed' : status.state,
      appVersion: status.appVersion ?? undefined,
      androidSdkInt: status.androidSdkInt ?? undefined,
      capabilities: status.capabilities,
      reason: status.reason ?? undefined,
      versionCode: status.versionCode,
      checkedAt: status.checkedAt,
      attempts: status.attempts,
      nextAttemptAt: status.nextAttemptAt,
    }
  }

  app.get('/:id/guest-agent', async (c) => {
    const row = mustGet(c.req.param('id'))
    if (deps.agentProvisioner?.status) {
      return c.json(agentStatusToResult(await deps.agentProvisioner.status(row.id)))
    }
    return c.json(await statusOf(row))
  })

  app.post('/:id/guest-agent', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const actor = c.get('user')?.id ?? null
    return c.json(
      await withNetworkAdmission(deps.activities, deps.controlSettings, deps.states, row.id, actor, async () => {
        const result = await installAndProbe(row)
        deps.record?.({ deviceId: row.id, stream: 'main', kind: 'guest-agent.installed', actor, meta: { state: result.state } })
        // Plan 90 §3.8, §4.7 — keeps `devices.agent`/the fleet summary in sync with an operator's
        // explicit Install/Repair click. Fire-and-forget and tolerant: a failure here must never turn
        // an otherwise-successful install+probe into a 500 for the operator who just watched it work.
        void deps.agentProvisioner
          ?.ensure(row.id, { force: true })
          .catch((err) => deps.log.warn(`agent-provisioner ensure() after POST /:id/guest-agent failed, tolerated: ${String(err)}`))
        return result
      }),
    )
  })

  app.delete('/:id/guest-agent', requirePermission('device.network'), async (c) => {
    const row = mustGet(c.req.param('id'))
    const actor = c.get('user')?.id ?? null
    return c.json(
      await withNetworkAdmission(deps.activities, deps.controlSettings, deps.states, row.id, actor, async () => {
        // Any active route is torn down first (Studio's own uninstall confirm dialog already says so)
        // — reinstalling later starts from scratch.
        await service.revertNetwork(row.id, actor)
        // Clear the PERSISTED route too, not just the live one — and stop the heartbeat if that was
        // the last enabled VPN route. See `RouteService.clearRoute`'s doc comment for the defect this
        // prevents.
        service.clearRoute(row.id)
        const launcher = makeLauncher(row)
        await launcher.stop().catch(() => undefined)
        await deps.hostAdb(['-s', row.serial, 'uninstall', GUEST_AGENT_PACKAGE]).catch(() => undefined)
        deps.record?.({ deviceId: row.id, stream: 'main', kind: 'guest-agent.uninstalled', actor, meta: {} })
        // Gap 2 fix's own follow-on: clears `devices.agent` so a GET right after this does not keep
        // reporting a stale ready/outdated/failed state.
        void deps.agentProvisioner
          ?.remove?.(row.id, actor)
          .catch((err) => deps.log.warn(`agent-provisioner remove() after DELETE /:id/guest-agent failed, tolerated: ${String(err)}`))
        return { ok: true }
      }),
    )
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  // Mounted at the same prefix this file's own routes are, so nothing outside had to learn about
  // the split. Registered LAST so `/:id/guest-agent` above keeps its own handler: the two apps
  // share no path, but the ordering makes that independent of Hono's matching rules rather than
  // dependent on them. The sub-app carries its own `onError` (Hono applies a routed app's error
  // handler to the routes it contributes), so a coded network failure keeps its status.
  app.route('/', service.routes)

  // Fire-and-forget at construction time — this IS "on boot" for the one real caller (`daemon.ts`
  // builds this exactly once at startup). Deliberately here rather than inside `createRouteService`:
  // the reconcile pass reaches `withEphemeralSession`, which reads `routeService`, and running it
  // from the service's own constructor would call it in the window before the assignment above.
  void service
    .reconcileNetworkRoutes()
    .catch((err) => deps.log.warn(`network boot reconciliation failed, tolerated: ${String(err)}`))

  return {
    routes: app,
    revertNetwork: service.revertNetwork,
    restoreDeviceRoute: service.restoreDeviceRoute,
    handleDeviceOffline: service.handleDeviceOffline,
    reconcileNetworkRoutes: service.reconcileNetworkRoutes,
    isRouteEnabled: service.isRouteEnabled,
    withGuestAgentClient: (deviceId, fn) => withEphemeralSession(mustGet(deviceId), fn),
    deviceNetwork: service.device,
    routeActions: service.actions,
  }
}
