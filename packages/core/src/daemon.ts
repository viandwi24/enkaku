import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { AdbClient, createAdbdShim } from '@enkaku/adb'
import { UI_SERVER_PACKAGE } from '@enkaku/drivers'
import { ToolchainManager } from '@enkaku/toolchain'
import {
  DeviceSettingsSchema,
  type ArtifactInfo,
  type DeviceEvent,
  type DeviceStatus,
  type ShellResult,
  type Viewer,
} from '@enkaku/protocol'
import type { Server } from 'bun'
import { createNodeRoutes } from './api/nodes'
import { createNodeAuth } from './tunnel/node-auth'
import { createTunnelRegistry } from './tunnel/registry'
import { createTunnelRouter } from './tunnel/router'
import { createTunnelRpc, type TunnelRpc } from './tunnel/rpc'
import { createRemoteSessionManager, type RemoteSessionManager } from './tunnel/remote-sessions'
import { createRemoteJobBridge } from './jobs/executors/remote'
import { createJobLogBuffer } from './jobs/log-buffer'
import { createWebRtcRelay } from './relay/webrtc-relay'
import { createWeriftFactory } from './relay/werift-peer'
import { createAuditLogger } from './auth/audit'
import { createAuthRoutes } from './auth/routes'
import { createAuthService } from './auth/service'
import { createRetentionGc, type RetentionGc } from './maintenance/retention'
import { assertTlsPolicy, resolveAuthMode } from './config'
import { createArtifactRoutes } from './api/artifacts'
import { createDeviceRoutes } from './api/devices'
import { createDeviceIdentityRoutes } from './api/device-identity'
import { createGuestAgentRoutes, resolveGuestAgentApkPath } from './api/guest-agent'
import { createTagRoutes } from './api/tags'
import { createClusterRoutes } from './api/clusters'
import { createTopologyRoutes } from './api/topology'
import { createBatchRoutes } from './api/batches'
import { createScheduleRoutes } from './api/schedules'
import { recomputeBatchStatus } from './clusters/status'
import { createJobRoutes } from './api/jobs'
import { createSettingsRoutes } from './api/settings'
import { createBatteryMonitor, type BatteryMonitor } from './device/battery'
import { computeAutoConcurrency } from './device/adb-scaling'
import { createAdbMetricsStore } from './device/adb-metrics'
import { createDeviceHealth, type DeviceHealth } from './device/health'
import { createAdbStatsRoutes } from './api/adb-stats'
import { createDoctorRoutes } from './api/doctor'
import { createFarmSettingsStore } from './settings/farm-settings'
import { buildRegistryResponse } from './registry/engines'
import { createScriptRoutes } from './scripts/routes'
import { createScriptRegistry } from './scripts/registry'
import { createDevSlotStore } from './plugins/dev-slots'
import { createPluginRuntime } from './plugins/runtime'
import { seedEmbeddedPacks } from './plugins/seed-embedded'
import { embeddedAssets } from './embedded'
import { createPluginRoutes } from './api/plugins'
import { buildCoreCapabilityRegistry, type CapabilityContextDeps } from './capability'
import { createCapRoutes } from './api/cap'
import { buildOpenApiDocument } from './api/openapi'
import { createMcpServer } from './mcp/server'
import { createWorkspaceStore } from './workspace/store'
import { withAutoRebuild } from './plugins/auto-rebuild'
import { createKvStore } from './kv/store'
import { createKvRunnerPort } from './kv/runner-port'
import { createJobsRunnerPort } from './jobs/jobs-runner-port'
import { createKvRoutes } from './api/kv'
import { createAgentStore, type AgentStore } from './agent/agent-store'
import { createConnectorStore } from './agent/connector-store'
import { createModelListCache } from './agent/provider'
import { createAgentRoutes } from './api/agents'
import { createConnectorRoutes } from './api/connectors'
import { createThreadRoutes } from './api/threads'
import { createThreadStore } from './agent/thread/store'
import { createApprovalStore } from './agent/approval/store'
import { createTreeStore } from './agent/tree/store'
import { createAgentRunner } from './agent/runner'
import { createBlobStore } from './agent/blob/store'
import { createBlobRoutes } from './api/blobs'
import { createAgentWsHandler } from './server/ws-handlers-agent'
import { createNotificationStore, type CreateNotificationInput } from './notify/store'
import { createWebhookStore } from './notify/webhook-store'
import { createNotifyRateLimiter, createNotifyService } from './notify/service'
import { createNotificationRoutes } from './api/notifications'
import { createWebhookRoutes } from './api/webhooks'
import type { ScheduleAgentDispatch } from './schedules/runner'
import {
  createJobRunner,
  createSessionManager,
  createInspectorForSession,
  PortAllocator,
  parsePortRange,
  QUALITY_PROFILES,
  type SessionManager,
  type TransferPort,
} from '@enkaku/session'
import { createScriptExecutor } from './jobs/executors/script'
import type { CoreConfig } from './config'
import { openDb, runMigrations, runMigrationsUpTo, type OpenedDb } from './db'
import { materialiseClusters, DROP_CLUSTER_SELECTOR_COLUMNS_TAG } from './db/migrations/cluster-materialise'
import { backfillScheduleScriptRefs } from './db/migrations/backfill-schedule-refs'
import { backfillScheduleTargets } from './db/migrations/schedule-target-backfill'
import { migrateToolResultContentBlocks } from './db/migrations/tool-result-content-blocks'
import { devices } from './db/schema'
import { createDeviceStateMachine } from './device/state-machine'
import { createAdbEndpointManager, bunAdbEndpointListen, type AdbEndpointManager } from './device/adb-endpoint'
import { redactShellCommand } from './device/redact'
import { createTransferService, type TransferService } from './device/transfer'
import { runTransfer, type TransferBroadcast } from './device/transfer-dispatch'
import { createReadinessManager, staticReadinessFallback, type ReadinessManager } from './device/readiness'
import { createDeviceLifecycle } from './device/lifecycle'
import { createPairingService, type PairingService } from './enroll/pairing'
import { EnkakuError } from './util/errors'
import { ExecutorRegistry } from './jobs/executor'
import { createExecutorHost } from './jobs/executor-host'
import { classifyFailure } from './jobs/failure-class'
import { pickRebindDevice } from './clusters/dispatch'
import { sleepExecutor } from './jobs/executors/sleep'
import { createInstallExecutor } from './jobs/executors/install'
import { createLeaseManager } from './lease/lease-manager'
import { createJobStore } from './queue/job-store'
import { createExpiryReaper } from './queue/expiry'
import { createScheduler } from './queue/scheduler'
import { createScheduleRunner } from './schedules/runner'
import { validateScriptForRun } from './jobs/validate-script'
import { createDeviceRegistry, listDevicesWithTags, type DeviceRegistry } from './registry/device-registry'
import { createApp } from './server/http'
import { WsHub } from './server/ws'
import { createWsMessageHandler } from './server/ws-handlers'
import { createJobService } from './services/job-service'
import { startScrcpySession } from '@enkaku/scrcpy'
import { createDbArtifactSink, createDbDeviceSource } from './session/adapters'
import { saveForDevice } from './runner/artifact-store'
import { materializeBundle } from './scripts/bundle-cache'
import { createAdbSwapCoordinator } from './tools/adb-swap'
import { provisionRequiredTools, toolchainEventToMessage } from './tools/provision'
import { CRITICAL_TOOLS, REQUIRED_TOOLS } from './tools/required'
import { createToolInstallStore } from './tools/store'
import { createLogger } from './util/logger'
import { acquireDataDirLock, type DataDirLock } from './util/data-dir-lock'
import { createEventRecorder, type EventRecorder } from './events/recorder'

import pkg from '../package.json'

export const CORE_VERSION = pkg.version


export interface Daemon {
  start(): Promise<void>
  stop(): Promise<void>
  port: number
}

export function createDaemon(cfg: CoreConfig): Daemon {
  const log = createLogger('core')
  let server: Server<unknown> | null = null
  let opened: OpenedDb | null = null
  let adb: AdbClient | null = null
  let registry: DeviceRegistry | null = null
  let sessions: SessionManager | null = null
  let battery: BatteryMonitor | null = null
  let health: DeviceHealth | null = null
  let remoteSessions: RemoteSessionManager | null = null
  let tunnelRpc: TunnelRpc | null = null
  let webrtcRelayRef: ReturnType<typeof createWebRtcRelay> | null = null
  let retention: RetentionGc | null = null
  let recorder: EventRecorder | null = null
  let adbEndpointManager: AdbEndpointManager | null = null
  /** Device readiness (plan 43) — constructed once `leases` exists (below), used by every module below that reconciles or holds on it. */
  let readiness: ReadinessManager | null = null
  let stopScheduler: (() => void) | null = null
  let stopReaper: (() => void) | null = null
  let stopExpiryReaper: (() => void) | null = null
  let stopScheduleRunner: (() => void) | null = null
  let dataDirLock: DataDirLock | null = null
  let stopped = false
  let adbState = 'provisioning'

  return {
    port: cfg.port,

    async start() {
      const startedAt = Date.now()
      log.info(`data dir: ${cfg.dataDir}`)

      // Before anything opens the database or touches adb: one core per data
      // directory. Two cores here would silently fight over the same phones
      // (see `data-dir-lock.ts` for what that actually looked like).
      dataDirLock = acquireDataDirLock(cfg.dataDir, log)

      // 1. DB + migrasi
      opened = openDb(join(cfg.dataDir, 'enkaku.db'))
      // The cluster materialisation (plan 22.0 §3.4, §4.1) is a one-shot
      // TypeScript data step that has to run strictly between two generated
      // migrations: after `devices.cluster_id` exists, before
      // `clusters.tags`/`device_ids` are dropped. `runMigrationsUpTo` opens
      // that window; the trailing `runMigrations` applies the remainder
      // (idempotent either way — see `cluster-materialise.test.ts`).
      runMigrationsUpTo(opened.db, DROP_CLUSTER_SELECTOR_COLUMNS_TAG)
      materialiseClusters(opened.db, { dataDir: cfg.dataDir, log: log.child('cluster-materialise') })
      // `opened.sqlite` is passed so the runner can realign a poisoned
      // `__drizzle_migrations.created_at` watermark before drizzle reads it
      // (see `runMigrations`'s own note — plans 61/62's hand-written
      // migrations stamped synthetic timestamps that silently hid 0025–0036).
      runMigrations(opened.db, opened.sqlite)
      // `schedules.script_id` → `schedules.script_ref` (plan 62 §4.3): the
      // generated migration above only renames the COLUMN — every
      // pre-existing row still holds a raw `scripts.id` where a reference
      // belongs. This one-shot step converts each to the EXACT version it
      // was already pinned to, never to `@latest` (acceptance #9). No
      // "up to" window is needed here (unlike cluster materialisation):
      // nothing later drops data this step needs to read.
      backfillScheduleScriptRefs(opened.db, { log: log.child('schedule-ref-backfill') })
      // Plan 68 §4.1 — the `target` migration: every schedule already reads
      // as `{kind: 'script'}` via the new column's own default, this pass is
      // the explicit, auditable record of that (and a defensive
      // normalisation), same marker-guarded pattern as the two calls above.
      backfillScheduleTargets(opened.db, { log: log.child('schedule-target-backfill') })
      // Plan 70 §4.1 — every pre-existing `agent_messages.content` tool_result's `content: string`
      // becomes `[{type:'text', text}]`, lossless and marker-guarded, exactly like the two calls
      // above. Must run before anything reads a message through the new `AgentMessageSchema` (which
      // now requires `content` to be an array) — the very next line already does (`agentThreadStore`
      // etc., built below), so this stays right here in migration order.
      migrateToolResultContentBlocks(opened.db, { log: log.child('tool-result-content-blocks') })
      log.info('db ready (migrations applied)')
      const db = opened.db

      // 2. WS hub + Toolchain Manager (emit → broadcast)
      const hub = new WsHub(log.child('ws'))

      // Notifications and webhooks (plan 68 §3.4, §4.1, §4.4) — built early: farm-wide, minimal
      // deps (db, dataDir), and needed by both the capability registry (`notify.send`), the
      // schedule runner (spend-cap refusals), and the agent runner (auto-denied approvals), all
      // constructed later in this function. `notifyAndBroadcast` is the ONE place a notification is
      // ever created — every caller (the capability, a spend-cap refusal, an auto-denied approval)
      // goes through it, so `notification.created` is never forgotten for one of them.
      const notificationStore = createNotificationStore(db)
      const webhookStore = createWebhookStore({ db, dataDir: cfg.dataDir })
      const notifyRateLimiter = createNotifyRateLimiter()
      const notifyAndBroadcast = (input: CreateNotificationInput) => {
        const notification = notificationStore.create(input)
        hub.broadcast({ type: 'notification.created', payload: notification })
        return notification
      }
      const notifyService = createNotifyService({
        store: { ...notificationStore, create: notifyAndBroadcast },
        webhooks: webhookStore,
        rateLimiter: notifyRateLimiter,
        log: log.child('notify'),
      })

      const toolchain = new ToolchainManager({
        dataDir: cfg.dataDir,
        coreVersion: CORE_VERSION,
        store: createToolInstallStore(db),
        emit: (ev) => hub.broadcast(toolchainEventToMessage(ev)),
        onLog: (level, msg) => log.child('toolchain')[level](msg),
        remoteManifestUrl: process.env.ENKAKU_TOOLS_MANIFEST_URL,
        adbSwapHook: createAdbSwapCoordinator({
          getClient: () => adb,
          stopTracker: async () => {
            await registry?.stop()
          },
          startTracker: async () => {
            await registry?.start()
          },
          // drainSessions: a no-op in M1 — filled in by Plan 04 (draining live leases and sessions)
          log: log.child('adb-swap'),
        }),
      })
      await toolchain.init() // layout + manifest cache + reconcile (adopt pre-baked)

      // Resolved here, ahead of the farm settings store, ONLY because that
      // store needs it for the plan 26 §3.2 server-mode `shell.mode: 'off'`
      // default (a brand-new row only — see the comment there). Everything
      // else that used to read `authMode` below still does; this does not
      // move that logic, just the one function call it was already making.
      const authMode = resolveAuthMode(cfg)
      const settingsStore = createFarmSettingsStore(db, { authMode })

      // adb concurrency and health diagnostics (plan 23 §4.3, §4.6). Created
      // here (rather than inside the try-block below, once `adb` exists)
      // because `/api/adb/stats` is mounted in step 4, before adb is up.
      const adbMetrics = createAdbMetricsStore()
      let lastLoggedAdbConcurrency: number | null = null
      // The autoscaler (plan 23 §3.2, §4.3): recomputed whenever a device
      // appears, disappears, or changes status, and whenever `adb.maxConcurrent`
      // changes in settings. A non-zero setting always wins over the formula.
      // Logged once at info ONLY when the effective value actually changes —
      // this is called on every status broadcast, and a log line per battery
      // poll would make later performance reports unreadable (plan 23 §4.3).
      const recomputeAdbConcurrency = () => {
        if (!adb) return
        const cfg = settingsStore.get().adb
        const nonOfflineCount = db
          .select({ status: devices.status })
          .from(devices)
          .all()
          .filter((r) => (r.status ?? 'offline') !== 'offline').length
        const target = cfg.maxConcurrent > 0 ? cfg.maxConcurrent : computeAutoConcurrency(nonOfflineCount)
        adb.setMaxConcurrent(target)
        if (target !== lastLoggedAdbConcurrency) {
          lastLoggedAdbConcurrency = target
          log
            .child('adb')
            .info(
              cfg.maxConcurrent > 0
                ? `concurrency pinned to ${target} by adb.maxConcurrent`
                : `concurrency auto-scaled to ${target} (${nonOfflineCount} non-offline devices)`,
            )
        }
        // The streaming lane's budget (plan 24 §3.2, §4.2) — a completely
        // separate field from `maxConcurrent` above, applied here because
        // this is already "whenever adb.maxConcurrent-shaped settings
        // change, push them onto the live client".
        adb.setStreamLimits(cfg.maxStreamsPerDevice, cfg.maxStreams)
      }
      settingsStore.onChange(() => recomputeAdbConcurrency())

      // The device event log (plan 18 §4.3). `publish` is wired to the WS
      // router once it exists — the two reference each other, same forward-ref
      // pattern used below for the tunnel hooks.
      let publishDeviceEvent: ((deviceId: string, ev: DeviceEvent) => void) | null = null
      // Same forward-ref pattern as `publishDeviceEvent`: the lease manager
      // (below) and the device routes (further below) are both built before
      // the WS router exists, but both need to reach into it once it does
      // (plan 31 §4.2 — presence broadcast on lease revoke, and the
      // GET /:id/viewers route).
      let broadcastDeviceViewers: ((deviceId: string) => void) | null = null
      let viewersOfDevice: ((deviceId: string) => Viewer[]) | null = null
      // Same forward-ref pattern: a device going offline (below) must stop
      // its monitor streams (plan 24 §4.5) even with viewers still attached,
      // but the hub holding that state lives inside the WS router built
      // further down.
      let stopMonitorsForDevice: ((deviceId: string) => void) | null = null
      // Same forward-ref pattern: the terminal's emulated cwd (plan 26 §3.7,
      // §4.4) must reset to `/` whenever a manual lease is released — for
      // ANY reason, including the automatic ones (idle timeout, quarantine)
      // handled below in `onManualRevoked`, which fires before the WS router
      // exists.
      let releaseShellSession: ((deviceId: string) => void) | null = null
      // Same forward-ref pattern: a device going offline must clear its
      // Inspect tab ref-count bookkeeping (plan 56 §4.2 step 7) — the
      // inspector itself is already released as part of the session's own
      // `close()`, this only resets what the WS router tracks so a later
      // `inspect.attach` does not inherit a stale count.
      let resetInspectForDevice: ((deviceId: string) => void) | null = null
      // Same forward-ref pattern: a manual lease's readiness hold (plan 43
      // §5 step 43.7) must not outlive the lease however it ends either —
      // an explicit `lease.release`/WS disconnect already release it inline
      // in `ws-handlers.ts`; this covers the automatic paths (idle timeout,
      // quarantine) handled below in `onManualRevoked`.
      let releaseLeaseReadinessHold: ((deviceId: string) => void) | null = null
      // Same forward-ref pattern: a device going offline must mark its
      // `vpn-helper` network route's checks unknown (never tear the route
      // down — plan 52 §4.1 reverses plan 44 §5.7's lease-scoped teardown),
      // and a device coming back online must restore it, probe-first (plan
      // 52 §3.2, §5.3). `createGuestAgentRoutes` needs `leases` itself,
      // which does not exist until `createLeaseManager` below returns.
      // Resolved once `guestAgent` is built further down.
      let handleNetworkDeviceOffline: ((deviceId: string) => Promise<void>) | null = null
      let restoreNetworkRoute: ((deviceId: string) => Promise<void>) | null = null
      // Same forward-ref pattern: crash detection (plan 37 §3.3) starts when
      // a session opens and stops when it closes — both hooks fire from
      // `sessions = createSessionManager({ onEvent, ... })` below, well
      // before the WS router (which owns the actual `CrashWatcher`) exists.
      let watchCrashesForDevice: ((deviceId: string) => void) | null = null
      let unwatchCrashesForDevice: ((deviceId: string) => void) | null = null
      // Same forward-ref pattern: the shared reaper (`expiryReaper`, built well before the agent
      // runner exists) sweeps overdue agent approvals on its own cadence (plan 66 §4.3) instead of
      // a second scheduler.
      let sweepAgentApprovals: (() => void) | null = null
      // Same forward-ref pattern: the schedule runner (built well before the agent store/runner
      // exist, since it sits alongside the queue scheduler early in this function) needs to check
      // whether an agent exists and to launch/track scheduled agent runs (plan 68 §4.2). Resolved
      // once `agentStore`/`agentRunner` are built further down.
      let agentStoreRef: AgentStore | null = null
      let scheduledAgentRunnerRef: ReturnType<typeof createAgentRunner> | null = null
      // The `declared` crash policy's target-package registry (plan 37 §3.4,
      // §4.4): written by `JobRunnerDeps.onTargetPackages` as a job's script
      // declares (or launches) packages, read by the crash watcher when a
      // crash needs to be matched against a job, cleared once the job
      // settles (`onJobFinished` below).
      const targetPackagesByJob = new Map<string, string[]>()
      // What a RUNNING job has logged so far, so a detail page opened mid-run
      // is not blank until the job ends. `/ws` has no snapshot replay and the
      // `job.log` artifact is written once in the runner's `finally`, so
      // without this there was no way to read a line you were not already
      // listening for. Released in `onJobFinished`.
      const jobLogBuffer = createJobLogBuffer()
      recorder = createEventRecorder({
        db,
        publish: (deviceId, ev) => publishDeviceEvent?.(deviceId, ev),
      })
      // The lease-scoped adb endpoint (plan 27 §4.2, cloud devices plan 28
      // §4.4). Constructed unconditionally, even before adb or the tunnel
      // layer are ready — `deps.adb`/`deps.rpc`/`deps.router` all read their
      // outer variables fresh on every `open()` call (the same forward-ref
      // pattern as `adb: () => adb` itself: `tunnelRouter`/`tunnelRpc`/
      // `remoteSessions` below are not assigned until later in this same
      // function, but nothing calls into this manager before `start()`
      // finishes), so a request that arrives before the right subsystem is
      // up simply gets a correctly-coded `E_ADB_UNAVAILABLE` refusal rather
      // than the route not existing at all.
      adbEndpointManager = createAdbEndpointManager({
        db,
        adb: () => adb,
        remoteNodeIdFor: (deviceId) => remoteSessions?.nodeIdFor(deviceId) ?? null,
        rpc: () => tunnelRpc,
        router: () => tunnelRouter,
        shellSettings: () => settingsStore.get().shell,
        listen: bunAdbEndpointListen,
        createShim: createAdbdShim,
        // Readiness hold (plan 43 §5 step 43.7) — same forward-ref pattern as
        // `remoteNodeIdFor`/`rpc`/`router` above: `readiness` is not built
        // until later in this function, read fresh on every `open()`.
        holdFor: (deviceId) => readiness?.hold(deviceId, 'adb-endpoint') ?? Promise.resolve({ release() {} }),
        onStreamOpen: (deviceId, service) =>
          recorder?.record({ deviceId, stream: 'input', kind: 'adb.open', meta: { service: redactShellCommand(service) } }),
        onEndpointOpened: (deviceId, userId, port, nodeId) =>
          recorder?.record({
            deviceId,
            stream: 'main',
            kind: 'adb.endpoint.opened',
            actor: userId,
            meta: nodeId ? { port, nodeId } : { port },
          }),
        onEndpointClosed: (deviceId, reason) =>
          recorder?.record({ deviceId, stream: 'main', kind: 'adb.endpoint.closed', meta: { reason } }),
        log: log.child('adb-endpoint'),
      })
      // A shared port pool: ui-server (M4.5), scrcpy's session wiring (M6, by
      // way of the inspector factory), and the guest-agent's control-channel
      // forward (plan 44 §5.7). Constructed unconditionally, even before adb
      // is ready — `claim()`/`release()` themselves have no adb dependency —
      // so it can be handed to `guestAgent` below, which (like
      // `adbEndpointManager` above) is built before the adb subsystem comes up.
      const ports = new PortAllocator(parsePortRange(process.env.ENKAKU_UI_SERVER_PORT_RANGE))
      // Read fresh on every input.text (plan 18 §3.4) rather than cached, so a
      // setting flipped mid-session takes effect on the very next keystroke.
      const isLogInputTextEnabled = (deviceId: string): boolean => {
        const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
        const parsed = DeviceSettingsSchema.safeParse(row?.settings ?? {})
        return parsed.success ? parsed.data.logInputText : false
      }

      // `canUseDevice`'s device half (plan 34 §3.5, §4.4) — a minimal lookup
      // shared by every ownership check below (job enqueue, batch dispatch,
      // lease acquire, the Plan 27 adb endpoint) so there is one query shape,
      // not four.
      const getDeviceOwner = (deviceId: string): { ownerId: string | null } | null => {
        const row = db.select({ ownerId: devices.ownerId }).from(devices).where(eq(devices.id, deviceId)).get()
        return row ?? null
      }

      // Writes a crash trace as an artifact (plan 37 §3.6): job-scoped
      // (reusing the exact sink every other job artifact goes through, so it
      // shows up on the job detail page and broadcasts `job.artifact` like
      // any other) when a job lease was held, device-scoped via
      // `saveForDevice` (plan 24 §4.6) otherwise.
      const saveCrashTrace = async (opts: { deviceId: string; jobId: string | null; label: string; text: string }): Promise<ArtifactInfo> => {
        const data = new TextEncoder().encode(opts.text)
        if (opts.jobId) {
          const jobId = opts.jobId
          let saved: ArtifactInfo | undefined
          const sink = createDbArtifactSink({
            db,
            dataDir: cfg.dataDir,
            jobId,
            onSaved: (info) => {
              saved = info
              hub.broadcast({ type: 'job.artifact', payload: { jobId, artifact: info } })
            },
          })
          await sink.save({ kind: 'log', label: opts.label, data, ext: 'txt' })
          if (!saved) throw new Error('crash trace artifact save did not report onSaved')
          return saved
        }
        return saveForDevice({ db, dataDir: cfg.dataDir }, opts.deviceId, opts.label, data, 'txt')
      }

      // Auth and audit (M7). The effective mode follows the bind address
      // (spec §14) — `authMode` itself was resolved earlier, above.
      assertTlsPolicy(cfg, authMode)
      const auth = createAuthService({ db, sessionTtlHours: cfg.auth.sessionTtlHours })
      const nodeAuth = createNodeAuth(db)

      // Cloud mode (spec §5.3): the orchestrator holds no local devices;
      // devices arrive from nodes over their outbound tunnels.
      const isOrchestrator = process.env.ENKAKU_MODE === 'orchestrator'
      const tunnelRegistry = createTunnelRegistry({
        db,
        log: log.child('tunnel'),
        onDevicesChanged: () => scheduler?.kick(),
        onNodeGone: (nodeId) => {
          // The tunnel dropped → that node's remote sessions are no longer valid...
          remoteSessions?.dropNode(nodeId)
          // ...and neither is anything awaiting a reply from it (plan 25 §4.1,
          // acceptance #3/#4): pending shell.exec/stream requests reject
          // immediately, and any stream it owned ends with a reason rather
          // than stalling until a timeout.
          tunnelRpc?.failAllForNode(nodeId, 'the node disconnected')
        },
      })
      // Hook set after the remote manager and job bridge are built (a cyclic-construction wiring).
      let onSessionStarted: ((d: string, i: { codec: 'png' | 'h264'; width: number; height: number }) => void) | null =
        null
      let onSessionFailed: ((d: string, c: string, m: string) => void) | null = null
      let onJobProgress: ((p: never) => void) | null = null
      const tunnelRouter = createTunnelRouter({
        registry: tunnelRegistry,
        log: log.child('tunnel'),
        onSessionStarted: (d, i) => onSessionStarted?.(d, i),
        onSessionFailed: (d, c, m) => onSessionFailed?.(d, c, m),
        onJobProgress: (p) => onJobProgress?.(p as never),
        // The RPC layer needs the router; the router needs to call back into
        // it for replies and pushes — same forward-ref pattern as the hooks
        // above, resolved the moment `tunnelRpc` is constructed just below.
        onRpcReply: (msg) => tunnelRpc?.handleReply(msg),
        onShellStreamEnded: (streamId, payload) => tunnelRpc?.dispatch(streamId, payload),
        // `adb.ack`/`adb.close` (plan 28 §3.3, §4.2 point 5) are repeated
        // per-channel pushes, not replies to a pending request — dispatched
        // by the same `TunnelRpc.watch`/`dispatch` mechanism
        // `createRemoteOpenService` re-subscribes to on every write.
        onAdbAck: (channelId, bytes) => tunnelRpc?.dispatch(`adb:${channelId}:ack`, { bytes }),
        onAdbClose: (channelId, reason) => tunnelRpc?.dispatch(`adb:${channelId}:close`, { reason }),
      })
      tunnelRpc = createTunnelRpc({ router: tunnelRouter, registry: tunnelRegistry })

      // Pairing needs adb; in orchestrator mode enrollment happens on the node.
      let pairingService: PairingService = {
        async request() {
          throw new EnkakuError('not_supported_in_mode', 'wireless pairing happens on the node, not the control plane')
        },
        async submitCode() {
          return { success: false, message: 'wireless pairing happens on the node, not the control plane' }
        },
      }

      remoteSessions = createRemoteSessionManager({
        db,
        registry: tunnelRegistry,
        router: tunnelRouter,
        log: log.child('remote-session'),
      })
      onSessionStarted = (d, i) => remoteSessions?.onStarted(d, i)
      onSessionFailed = (d, c, m) => remoteSessions?.onFailed(d, c, m)
      const audit = createAuditLogger(db)
      if (authMode === 'local') auth.ensureLocalAdmin()
      log.info(
        `auth mode: ${authMode}${authMode === 'server' && !auth.hasAnyAdmin() ? ' (admin setup required)' : ''}`,
      )

      // 3. Queue / lease / scheduler (M3)
      const jobStore = createJobStore(db)
      const orphans = jobStore.failOrphanRunning()
      if (orphans > 0) log.warn(`recovery boot: ${orphans} job 'running' yatim ditandai failed (core restarted)`)

      const broadcastDeviceStatus = (deviceId: string, status?: DeviceStatus) => {
        const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
        if (!row) return
        hub.broadcast({
          type: 'device.status',
          payload: { id: row.id, stableId: row.stableId, status: status ?? ((row.status ?? 'offline') as DeviceStatus) },
        })
      }

      const states = createDeviceStateMachine({
        db,
        log: log.child('state'),
        onChange: (deviceId, status) => {
          broadcastDeviceStatus(deviceId, status)
          // Every status transition can change the non-offline device count
          // (plan 23 §4.3) — DEVICE_CONNECTED/DISCONNECTED most obviously,
          // but recomputing on all of them is cheap and simplest to reason about.
          recomputeAdbConcurrency()
          // An idle session must not survive a quarantine (Plan 42 §3.4,
          // §4.4) — a no-op when someone is actively watching (video keeps
          // streaming while a device is busy/quarantined, spec §10.1).
          if (status === 'quarantined') void sessions?.closeIfIdle(deviceId)
          // Every status transition can move readiness too (Plan 43 §5 step
          // 43.6): connect/disconnect and quarantine/unquarantine most
          // obviously, but also JOB_CLAIMED/JOB_FINISHED and manual
          // acquire/release, since any of them can change whether a standing
          // `desired: hot` device is still reachable. Cheap and idempotent —
          // reconciling on every transition is simplest to reason about.
          void readiness?.reconcile(deviceId)
        },
      })

      // File transfer and APK install (plan 39 §4.2, §4.4) — constructed
      // unconditionally, even before adb is ready, mirroring
      // `adbEndpointManager` above: `TransferService` reads `adb`/`settingsStore`
      // fresh on every call, so a request that arrives before the adb
      // subsystem is up simply gets a correctly-coded `E_ADB_UNAVAILABLE`
      // refusal rather than the route/executor not existing at all.
      const transferBroadcast: TransferBroadcast = {
        progress: (deviceId, transferId, kind, sent, total) =>
          hub.broadcast({ type: 'transfer.progress', payload: { deviceId, transferId, kind, sent, total } }),
        done: (deviceId, transferId, kind, ok, error, result) =>
          hub.broadcast({
            type: 'transfer.done',
            payload: { deviceId, transferId, kind, ok, ...(error !== undefined ? { error } : {}), ...(result !== undefined ? { result } : {}) },
          }),
      }
      const transferService = createTransferService({
        db,
        dataDir: cfg.dataDir,
        adb: () => adb,
        // Scoped to local devices for this plan (§9 open question) — a
        // node-owned device refuses with a clear `E_UNSUPPORTED` rather
        // than being silently attempted over a transport that does not
        // exist for it.
        isRemote: (deviceId) => (remoteSessions?.nodeIdFor(deviceId) ?? null) !== null,
        settings: () => settingsStore.get().transfer,
      })
      // The script API's `ctx.device.install`/`push`/`pull` (plan 39 §4.6) —
      // every call also broadcasts `transfer.progress`/`transfer.done`, the
      // same as a Studio-initiated transfer, so a second viewer of the
      // device sees a script's install just like any other (plan §4.4).
      // Readiness hold (plan 43 §3.7 table, §5 step 43.7) — same forward-ref
      // pattern as everything else in this function that is built before
      // `readiness` exists (read fresh on every transfer).
      const readinessHoldForTransfer = (deviceId: string) => readiness?.hold(deviceId, 'transfer') ?? Promise.resolve({ release() {} })
      const transferPortForScripts: TransferPort = {
        install: (deviceId, opts) =>
          runTransfer({
            transfer: transferService,
            broadcast: transferBroadcast,
            deviceId,
            kind: 'install',
            holdFor: readinessHoldForTransfer,
            op: (transferId, onProgress) =>
              transferService.install(deviceId, opts.artifactId, {
                transferId,
                onProgress,
                ...(opts.reinstall !== undefined ? { reinstall: opts.reinstall } : {}),
                ...(opts.grantPermissions !== undefined ? { grantPermissions: opts.grantPermissions } : {}),
                ...(opts.allowDowngrade !== undefined ? { allowDowngrade: opts.allowDowngrade } : {}),
              }),
          }),
        push: (deviceId, opts) =>
          runTransfer({
            transfer: transferService,
            broadcast: transferBroadcast,
            deviceId,
            kind: 'push',
            holdFor: readinessHoldForTransfer,
            op: (transferId, onProgress) => transferService.push(deviceId, opts.artifactId, opts.remotePath, { transferId, onProgress }),
          }),
        pull: (deviceId, opts) =>
          runTransfer({
            transfer: transferService,
            broadcast: transferBroadcast,
            deviceId,
            kind: 'pull',
            holdFor: readinessHoldForTransfer,
            op: (transferId, onProgress) => transferService.pull(deviceId, opts.remotePath, { transferId, onProgress }),
          }),
      }

      const executors = new ExecutorRegistry()
      executors.register('internal:sleep', sleepExecutor)
      executors.register('internal:install', createInstallExecutor({ transfer: transferService, broadcast: transferBroadcast }))

      // The script registry (plan 82 §3.3) — the merge point between persisted `scripts` rows
      // (standalone AND published plugin members, both ordinary rows) and in-memory dev slots.
      // Built early, alongside `executors`, since `findScript` right below and every
      // `resolveScriptRef` call site further down this function reads through it.
      const pluginDevSlots = createDevSlotStore()
      const scriptRegistry = createScriptRegistry({ db, dataDir: cfg.dataDir, devSlots: pluginDevSlots })

      // Check the `scripts` table for a non-built-in scriptId (M4) — shared by
      // the job service, batch dispatch and schedule dispatch (plans 04, 20, 21)
      // so an unknown/disabled script fails once, the same way, everywhere. Goes
      // through the registry (plan 82 §3.3) so a dev-origin scriptId (a job's
      // `scriptId` can be `dev:<plugin>/<script>`) resolves too, not just a
      // persisted row.
      const findScript = (scriptId: string): { enabled: boolean } | null => {
        const entry = scriptRegistry.get(scriptId)
        return entry ? { enabled: entry.enabled } : null
      }

      let scheduler: ReturnType<typeof createScheduler> | null = null
      let leaseManager: ReturnType<typeof createLeaseManager> | null = null
      let scheduleRunner: ReturnType<typeof createScheduleRunner> | null = null
      // A batch member job reached a terminal state (or was cancelled while
      // queued) → recompute the batch's cached status and broadcast it
      // (plan 20 §3.5, §4.5). One function, called from both places a job
      // can leave the queue.
      const onBatchChanged = (batchId: string) =>
        recomputeBatchStatus({ db, jobStore, broadcast: (msg) => hub.broadcast(msg) }, batchId)
      const host = createExecutorHost({
        registry: executors,
        jobStore,
        states,
        leases: () => leaseManager!,
        log: log.child('executor'),
        jobTtlSec: cfg.lease.jobTtlSec,
        heartbeatMs: cfg.lease.heartbeatMs,
        onJobStatus: (info) => hub.broadcast({ type: 'job.status', payload: info }),
        onFinished: () => scheduler?.kick(),
        onBatchChanged,
        onJobFinished: (deviceId, jobId, status, durationMs) => {
          recorder?.record({ deviceId, stream: 'main', kind: 'job.finished', actor: `job:${jobId}`, meta: { jobId, status, durationMs } })
          // The crash policy's target-package set does not outlive the job (plan 37 §4.4).
          targetPackagesByJob.delete(jobId)
          // Nor do the retained log lines: from here the `job.log` artifact is
          // the record, and `GET /api/jobs/:id/logs` falls through to it.
          jobLogBuffer.release(jobId)
          // Job claim/finish is one of the events readiness reconciles on
          // (plan 43 §5 step 43.6) — the job's own hold release (executor-host.ts)
          // already triggers this once its own count reaches zero, but a
          // second, cheap, idempotent call here covers the case where
          // `readinessHold` below was never wired (a host built without it,
          // e.g. some tests).
          void readiness?.reconcile(deviceId)
        },
        // Readiness hold (plan 43 §3.6, §5 step 43.7) — a job on a sleeping
        // device wakes it, then proceeds; never blocks a claim (§4.3
        // "pre-emption").
        readinessHold: (deviceId, reason) => readiness?.hold(deviceId, reason) ?? Promise.resolve({ id: 'noop', release() {} }),
        // Retry classification (plan 36 §3.2, §4.1, §4.3) — read fresh per
        // settle, the same pattern `adb.maxConcurrent` uses.
        timeoutIsInfra: () => settingsStore.get().job.retry.timeoutIsInfra,
        rebindOnInfra: () => settingsStore.get().job.retry.rebindOnInfra,
        // Lazy, like `leases` above — `health` is created later, once adb is ready.
        health: () => health,
        deviceSerial: (deviceId) => db.select({ serial: devices.serial }).from(devices).where(eq(devices.id, deviceId)).get()?.serial ?? null,
        pickRebindDevice: (job) => pickRebindDevice(db, job),
        onJobRebound: (deviceId, jobId, newDeviceId, code) =>
          recorder?.record({
            deviceId,
            stream: 'main',
            kind: 'job.retry',
            actor: `job:${jobId}`,
            meta: { jobId, class: 'infra', code, delayMs: 0, rebound: true, newDeviceId },
          }),
      })

      // Resolves a lease holder's id to a display label (plan 71 §3.3) — the
      // lease manager itself never learns about users, agents, or jobs
      // directly; this closure is the one place that does. `agentStoreRef`
      // is the same forward-ref pattern used throughout this function
      // (`agentStore` is not built until later, well below this point) — by
      // the time this is actually CALLED (a lease exists), boot has long
      // finished and the ref is populated. A holder id this cannot resolve
      // becomes a truthful, non-empty phrase — never an empty string, never
      // the raw id (plan 71 §3.3, criterion 14).
      const resolveLeaseLabel = (kind: 'user' | 'agent' | 'job', id: string): string => {
        if (kind === 'user') {
          const user = id ? auth.listUsers().find((u) => u.id === id) : null
          return user?.email ?? 'a signed-out client'
        }
        if (kind === 'agent') {
          const agent = agentStoreRef?.get(id)
          return agent?.name ?? 'a deleted agent'
        }
        const job = jobStore.get(id)
        if (!job) return 'a deleted job'
        const script = jobStore.scriptNames([job.scriptId]).get(job.scriptId)
        return script ? `${script.name}@${script.version}` : 'a job'
      }

      const leases = createLeaseManager({
        states,
        jobStore,
        config: {
          jobTtlSec: cfg.lease.jobTtlSec,
          manualIdleTimeoutSec: cfg.lease.manualIdleTimeoutSec,
          reaperIntervalMs: cfg.lease.reaperIntervalMs,
        },
        log: log.child('lease'),
        resolveLabel: resolveLeaseLabel,
        // Plan 36 §3.2: a force-expired job lease is the farm's problem, not
        // the script's — coded so it classifies infra rather than falling to
        // the (safer, but less specific) unknown-code default.
        onJobLeaseExpired: (jobId, reason) => host.finishExternally(jobId, 'failed', reason, 'LEASE_FORCE_RELEASED'),
        onManualRevoked: (deviceId, reason, holderUserId) => {
          hub.broadcast({ type: 'lease.revoked', payload: { deviceId, reason, takenBy: null } })
          // The holder learns why from lease.revoked; everyone else just needs
          // to know the device is free again.
          hub.broadcast({ type: 'lease.changed', payload: { deviceId, heldBy: null, expiresAt: null } })
          broadcastDeviceViewers?.(deviceId)
          recorder?.record({ deviceId, stream: 'main', kind: 'control.revoked', actor: holderUserId, meta: { reason } })
          // A forced release is security-relevant, not just a device fact
          // (plan 18 §3.2, §18.4) — it also lands in the audit trail.
          audit.record({ userId: holderUserId, action: 'device.control', target: deviceId, meta: { action: 'revoked', reason } })
          // The terminal's emulated cwd must not survive an automatic
          // revocation either (plan 26 §3.7, §4.4) — only an explicit
          // `lease.release` message is handled inline in `ws-handlers.ts`.
          releaseShellSession?.(deviceId)
          // Nor does the lease's readiness hold (plan 43 §5 step 43.7) — an
          // automatic revocation must let the device drift back toward its
          // `desired` readiness exactly like an explicit release does.
          releaseLeaseReadinessHold?.(deviceId)
          // Nor does an open adb endpoint (plan 27 §4.2, acceptance #5): the
          // endpoint is created by the lease holder and dies with the
          // lease, however the lease ends — idle timeout, disconnect, or
          // quarantine, not just the explicit release ws-handlers.ts handles.
          adbEndpointManager?.close(deviceId, reason)
          // A `vpn-helper` route is deliberately left ALONE here (plan 52
          // §0, §3.1, §4.1 — superseding plan 44 §5.7's lease-scoped
          // teardown): a route is a property of the device, not of whoever
          // held the lease, so an idle timeout, disconnect, or quarantine
          // must not tear it down. Turning a route off is now an explicit
          // act only (`/disable`, `DELETE /network`, agent uninstall).
        },
        // A takeover (plan 71 §3.4, §3.5) — the displaced holder is told (by
        // name, of who took it) and it is recorded. Mirrors `onManualRevoked`
        // above for every side effect that must not survive the lease ending,
        // regardless of WHY it ended.
        onManualTakenOver: ({ deviceId, from, toUserId, takenByLabel }) => {
          // `lease.changed` (naming the NEW holder) is broadcast by the
          // `lease.acquire` handler itself right after this call returns
          // (`server/ws-handlers.ts`) — the same one unconditional broadcast
          // a plain acquire already sends, so a takeover does not need a
          // second copy of it here. `lease.revoked` (naming the reason and
          // the taker) has no other sender, so it belongs here.
          hub.broadcast({ type: 'lease.revoked', payload: { deviceId, reason: 'taken-over', takenBy: takenByLabel } })
          broadcastDeviceViewers?.(deviceId)
          recorder?.record({ deviceId, stream: 'main', kind: 'control.revoked', actor: toUserId, meta: { reason: 'taken-over', from: from?.label ?? null, to: takenByLabel } })
          audit.record({
            userId: toUserId,
            action: 'device.control',
            target: deviceId,
            meta: { action: 'taken-over', from: from?.label ?? null, fromKind: from?.kind ?? null, to: takenByLabel },
          })
          releaseShellSession?.(deviceId)
          releaseLeaseReadinessHold?.(deviceId)
          adbEndpointManager?.close(deviceId, 'taken-over')
          // An agent whose lease was taken over does NOT get pushed a
          // notification here (plan 71 §3.5, §3.6): its next attempt to use
          // the device detects the loss itself (`agent/loop/run.ts`'s
          // `ensureControlLease` re-checks the real lease on every step) and
          // reports it as an error `tool_result` — the same "the loop
          // discovers it, nothing pushes it" shape plan 63's `invoke()` uses
          // for every other refusal.
        },
        onDeviceFreed: () => scheduler?.kick(),
      })
      leaseManager = leases

      // Device lifecycle — Forget and Block (plan 47 §4.3). Constructed
      // unconditionally, right beside `leaseManager` itself: it depends only
      // on `db` and `leases`, both of which exist in every mode, including
      // the orchestrator (this line runs before that mode's early return,
      // further below in this function).
      /**
       * Bound once `createGuestAgentRoutes` exists, further down this same
       * boot — the lifecycle is constructed well before it. Null until then,
       * which is correct rather than merely convenient: nothing can have a
       * route before the network subsystem is up, so there is nothing to take
       * down (plan 56 §3.6).
       */
      let revertNetworkForRemoval: ((deviceId: string, actor?: string | null) => Promise<void>) | null = null
      // The durable kv store (plan 79 §4.1) — constructed here, right beside
      // `deviceLifecycle` below (which needs it for its own teardown), and
      // well before the workspace/agent stores further down: it depends only
      // on `db` and `cfg.dataDir`, both available from the very top of this
      // function, in every mode.
      const kvStore = createKvStore(db, cfg.dataDir, () => settingsStore.get().kv)
      // The plugin runtime (plan 82 §4.3) — stage/verify/activate/rollback/disable/remove/
      // reload/restart, plus the dev slot lifecycle. Built right here: it needs `kvStore`
      // (a plugin's KV namespace, §3.10) and `scriptRegistry` (built earlier, alongside
      // `executors`), and nothing else — well before the workspace/agent stores further down.
      const pluginRuntime = createPluginRuntime({ db, dataDir: cfg.dataDir, registry: scriptRegistry, kv: kvStore, devSlots: pluginDevSlots })
      const kvRunnerPort = createKvRunnerPort({ db, store: kvStore })
      // `ctx.jobs` (plan 80 §4.2, extended by plan 81 §4.2 with `trigger`) —
      // needs only `db` and `jobStore`, both already constructed above;
      // built here, right beside `kvRunnerPort`, for the same reason: both
      // are `JobRunnerDeps` ports wired into `createJobRunner` far below,
      // well before the child process exists. `registry` is the same
      // `scriptRegistry` every other trigger-shaped caller (a schedule, an
      // ad-hoc run) resolves through; `triggerBudgets` is read fresh per
      // call, the same freshness pattern `resetPolicy`/`adb.maxConcurrent`
      // already use, so a Settings change reaches the very next trigger.
      const jobsRunnerPort = createJobsRunnerPort({
        db,
        jobStore,
        registry: scriptRegistry,
        triggerBudgets: () => settingsStore.get().job.trigger,
        onTriggered: (from, targetDeviceId, result) =>
          recorder?.record({
            deviceId: targetDeviceId,
            stream: 'main',
            kind: 'job.triggered',
            actor: `job:${from.id}`,
            meta: { fromJobId: from.id, toJobId: result.jobId, rootJobId: from.rootJobId ?? from.id, depth: (from.depth ?? 0) + 1 },
          }),
        log: log.child('jobs-runner-port'),
      })
      const deviceLifecycle = createDeviceLifecycle({
        db,
        leases,
        record: recorder!.record,
        log: log.child('device-lifecycle'),
        // An operator removing a device hands the phone its network back
        // (plan 56 §3.6). Deliberate acts only — a core that crashes or goes
        // quiet must still leave the tunnel HELD CLOSED, which is the device's
        // own dead-man's switch (plan 54) and is untouched by this.
        revertNetwork: (deviceId, actor) => revertNetworkForRemoval?.(deviceId, actor) ?? Promise.resolve(),
        // Forget deletes the device's kv values, in the same transaction (plan 79 §3.3, §4.6).
        kv: kvStore,
      })

      // Device readiness (plan 43): a second, orthogonal axis to
      // `DeviceStatus` (§3.1) — constructed here, once `leases` exists,
      // using the same lazy-accessor forward-ref pattern every other
      // adb-dependent module in this function already uses (`adb: () =>
      // adb`, `sessions: () => sessions`), since `sessions` itself is not
      // built until the adb subsystem comes up further below.
      readiness = createReadinessManager({
        db,
        client: () => adb,
        sessions: () => sessions,
        leases,
        maxHot: () => settingsStore.get().readiness.maxHot,
        // Cloud/node-owned devices are out of scope for this plan (§2, §9
        // open question #2) — never attempt a local wake/session acquire
        // against one.
        isRemote: (deviceId) => (remoteSessions?.nodeIdFor(deviceId) ?? null) !== null,
        broadcast: (deviceId, r) => hub.broadcast({ type: 'device.readiness', payload: { deviceId, readiness: r } }),
        record: (e) =>
          recorder?.record({ deviceId: e.deviceId, stream: 'main', kind: 'device.readiness', actor: e.actor, meta: { from: e.from, to: e.to } }),
        log: log.child('readiness'),
      })

      scheduler = createScheduler({
        jobStore,
        host,
        log: log.child('scheduler'),
        jobTtlSec: cfg.lease.jobTtlSec,
        fallbackIntervalMs: cfg.scheduler.fallbackIntervalMs,
        onJobStatus: (info) => hub.broadcast({ type: 'job.status', payload: info }),
        onDeviceBusy: (deviceId) => {
          broadcastDeviceStatus(deviceId, 'busy')
          // A job claiming a device closes its idle session immediately
          // (Plan 42 §3.4, §4.4, acceptance #8) — an idle TTL must never hold
          // a device away from the scheduler, and the job starts a fresh
          // `control`-quality session rather than inheriting a stale one.
          void sessions?.closeIfIdle(deviceId)
          // Job claim (plan 43 §5 step 43.6, acceptance #11) — never blocked
          // by readiness; this just keeps the broadcast readiness in step
          // with `busy`.
          void readiness?.reconcile(deviceId)
        },
        onJobStarted: (deviceId, jobId, scriptId) =>
          recorder?.record({ deviceId, stream: 'main', kind: 'job.started', actor: `job:${jobId}`, meta: { jobId, scriptId } }),
        // A job waits for the device to go quiet before claiming it (plan 71
        // §3.7) — both settings read fresh on every tick, the same pattern
        // `adb.maxConcurrent` and every other settings-derived accessor in
        // this function already uses.
        quiet: {
          quietPeriodSec: () => settingsStore.get().job.quietPeriodSec,
          maxWaitSec: () => settingsStore.get().job.maxWaitSec,
          lastManualReleaseAt: (deviceId) => leases.lastManualReleaseAt(deviceId),
          lastManualHolder: (deviceId) => leases.lastManualHolder(deviceId),
        },
        onJobWaiting: (info) => hub.broadcast({ type: 'job.waiting', payload: info }),
      })

      const jobService = createJobService({
        jobStore,
        registry: executors,
        scheduler,
        host,
        log: log.child('job'),
        onJobStatus: (info) => hub.broadcast({ type: 'job.status', payload: info }),
        findScript,
        onBatchChanged,
        // `canUseDevice` (plan 34 §3.5, §4.4).
        getDeviceOwner,
        // Plan 82 §3.4 — denormalises `jobs.scriptName`/`.scriptVersion` at enqueue.
        scriptNameOf: (scriptId) => scriptRegistry.get(scriptId),
      })

      // The expiry reaper (plan 21 §4.3): a `queued` job past its
      // `expiresAt` becomes `expired` instead of waiting forever. It runs on
      // the same cadence as the lease reaper but is its own module — a
      // `running` job stays governed entirely by the job lease.
      const expiryReaper = createExpiryReaper({
        jobStore,
        intervalMs: cfg.lease.reaperIntervalMs,
        log: log.child('expiry'),
        onJobStatus: (info) => hub.broadcast({ type: 'job.status', payload: info }),
        onBatchChanged,
        sweepApprovals: () => sweepAgentApprovals?.(),
      })

      // Plan 68 §4.2 — the agent side of schedule dispatch, read through the forward-refs above
      // (`agentStoreRef`/`scheduledAgentRunnerRef`): the schedule runner is built here, well before
      // `agentStore`/`agentRunner` exist further down this function.
      const scheduleAgentDispatch: ScheduleAgentDispatch = {
        agentExists: (agentId) => {
          const agent = agentStoreRef?.get(agentId)
          return !!agent && agent.enabled
        },
        runStatus: (runId) => scheduledAgentRunnerRef?.runStatus(runId) ?? null,
        cancelRun: (runId, cancelledBy) => scheduledAgentRunnerRef?.cancelRun(runId, cancelledBy),
        countActiveScheduledRuns: () => scheduledAgentRunnerRef?.countActiveScheduledRuns() ?? 0,
        spentOutputTokensSince: (windowStart) => scheduledAgentRunnerRef?.spentOutputTokensSince(windowStart) ?? 0,
        dispatch: (input) => {
          if (!scheduledAgentRunnerRef) throw new EnkakuError('E_INTERNAL', 'the agent runner is not ready yet')
          return scheduledAgentRunnerRef.runScheduledFiring(input)
        },
      }

      // The schedule runner (plan 21 §4.2) — separate from the queue
      // scheduler above: that one dispatches queued jobs to devices, this one
      // decides when work is created in the first place.
      scheduleRunner = createScheduleRunner({
        db,
        jobStore,
        scheduler,
        audit,
        log: log.child('schedule'),
        onJobStatus: (info) => hub.broadcast({ type: 'job.status', payload: info }),
        broadcastBatchStatus: (msg) => hub.broadcast(msg),
        broadcastFired: (msg) => hub.broadcast(msg),
        validateScript: (scriptId, params) => validateScriptForRun({ registry: executors, findScript }, scriptId, params),
        agentDispatch: scheduleAgentDispatch,
        scheduledAgentCeilings: () => settingsStore.get().scheduledAgents,
        notifySystem: (input) => {
          notifyAndBroadcast({ level: input.level, title: input.title, body: input.body ?? null, context: input.context ?? null, source: 'system' })
        },
        // Plan 82 §3.3, §3.5 — a schedule refuses a dev-only target (criterion 18) and resolves
        // a plugin's `@latest` to its ACTIVE version, not merely the highest published semver.
        registry: scriptRegistry,
      })

      // Remote jobs: a device owned by a node runs on that node (plan 12 §4.5).
      const remoteBridge = createRemoteJobBridge({
        db,
        registry: scriptRegistry,
        router: tunnelRouter,
        log: log.child('remote-job'),
        hooks: {
          onLog: (jobId, entry) => {
            // A node-owned job takes the same path: retained for a mid-run
            // fetch, then broadcast. See the local runner's own note below.
            const level = entry.level as 'debug' | 'info' | 'warn' | 'error'
            const source = entry.source as 'script' | 'stdout' | 'stderr' | 'runner'
            jobLogBuffer.append({ jobId, ts: entry.ts, level, source, msg: entry.msg })
            hub.broadcast({
              type: 'job.log',
              payload: {
                jobId,
                ts: entry.ts,
                level,
                source,
                msg: entry.msg,
              },
            })
          },
          onArtifact: (jobId, artifact) => hub.broadcast({ type: 'job.artifact', payload: { jobId, artifact } }),
          onPhase: (jobId, attempt, phase) => {
            const info = jobService.get(jobId)
            if (info) hub.broadcast({ type: 'job.status', payload: { ...info, ...(attempt ? { attempt } : {}), phase } })
          },
          heartbeat: (jobId) => jobStore.renewLease(jobId, cfg.lease.jobTtlSec),
        },
        saveArtifact: async (jobId, a) => {
          const sink = createDbArtifactSink({
            db,
            dataDir: cfg.dataDir,
            jobId,
            onSaved: () => {},
          })
          const saved = await sink.save({
            kind: a.kind as 'screenshot' | 'file' | 'log',
            label: a.label,
            data: a.data,
            ...(a.ext ? { ext: a.ext } : {}),
          })
          return {
            id: crypto.randomUUID(),
            jobId,
            deviceId: null,
            kind: a.kind as 'screenshot' | 'log' | 'file' | 'video',
            label: a.label,
            path: saved.path,
            sizeBytes: saved.sizeBytes,
            createdAt: Math.floor(Date.now() / 1000),
          }
        },
      })
      onJobProgress = (p) => remoteBridge.handleProgress(p)
      // Node-owned devices use the remote executor; local devices use the
      // in-process runner (registered once adb is ready).
      executors.setFallback(remoteBridge.executor)

      // The WebRTC relay serves node-owned devices (cloud mode). On a LAN,
      // Studio stays on the simpler WS + WebCodecs path.
      const webrtcRelay = createWebRtcRelay({
        factory: createWeriftFactory(),
        log: log.child('webrtc'),
        subscribeVideo: (deviceId, cb) =>
          tunnelRouter.subscribeVideo(deviceId, (payload) => cb(payload, BigInt(Date.now()) * 1000n)),
        requestKeyframe: (deviceId) => {
          // scrcpy 3.3.1: request a fresh IDR through the reset-video control message.
          tunnelRouter.sendToDevice(deviceId, {
            type: 'session.start',
            payload: { deviceId, engines: {} },
          } as never)
        },
      })

      webrtcRelayRef = webrtcRelay

      // Plan 44 §5.7/§5.8: `guestAgent` needs `leases` (built above) and
      // `ports` (built earlier, unconditionally) but must exist before `adb`
      // is ready, since it is mounted into `createApp` below — the same
      // "lazy, adb-not-ready-yet-safe deps" pattern `adbEndpointManager`/
      // `transferService` already use, for the same reason. `hostAdb`/`exec`
      // read the outer `adb` variable fresh on every call rather than
      // capturing it now, so a request that arrives before adb is up gets a
      // correctly-coded refusal instead of a route that does not exist.
      const guestAgentHostAdb = async (args: string[]): Promise<string> => {
        if (!adb) throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
        const proc = Bun.spawn([adb.binaryPath, ...args], { stdout: 'pipe', stderr: 'pipe' })
        const out = await new Response(proc.stdout).text()
        const exit = await proc.exited
        if (exit !== 0) throw new Error(`adb ${args.join(' ')} exit ${exit}: ${out.trim()}`)
        return out
      }
      const guestAgentExec = async (serial: string, cmd: string): Promise<ShellResult> => {
        if (!adb) throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
        // The whole result, not just `.stdout`: the launcher decides whether
        // the agent is installed from the exit code, and reads `am start`'s
        // failure off stderr (plan 53).
        return adb.exec(serial, cmd, { profile: 'appLifecycle' })
      }
      const guestAgent = createGuestAgentRoutes({
        db,
        hostAdb: guestAgentHostAdb,
        exec: guestAgentExec,
        apkPath: () =>
          resolveGuestAgentApkPath({
            toolchain,
            onLog: (level, msg) => log.child('guest-agent')[level](msg),
          }),
        ports,
        leases,
        dataDir: cfg.dataDir,
        record: recorder!.record,
        log: log.child('guest-agent'),
        // Plan 55 §3.2, §5.1 — read fresh on every call, same as every other `settingsStore.get()`
        // getter dep in this file.
        networkSettings: () => settingsStore.get().network,
      })
      handleNetworkDeviceOffline = guestAgent.handleDeviceOffline
      restoreNetworkRoute = guestAgent.restoreDeviceRoute
      // An operator removing a device now hands the phone its network back
      // (plan 56 §3.6). Deliberate acts only: a core that crashes or goes
      // quiet still leaves the tunnel held closed by the device's own
      // dead-man's switch, which nothing here touches.
      revertNetworkForRemoval = guestAgent.revertNetwork

      // Plan 58 §4.3, §5.3 — timezone/locale/GPS identity, a device-settings extension living
      // beside the network route rather than inside it (plan 58 §3.1). Reuses `guestAgentExec`
      // (the same adb-queue shell exec `guestAgent` itself uses) and `guestAgent.withGuestAgentClient`
      // so a GPS apply/clear shares the exact per-device session a network route already owns.
      const deviceIdentity = createDeviceIdentityRoutes({
        db,
        exec: guestAgentExec,
        leases,
        record: recorder!.record,
        log: log.child('identity'),
        withGuestAgentClient: guestAgent.withGuestAgentClient,
      })

      // The capability registry (plan 63 §4.2) — built once, at boot; a
      // duplicate id or an unconvertible schema throws here and the
      // process does not start (acceptance #1-3). `sessions`/`readiness`
      // are read lazily (`() => sessions`), the same forward-ref pattern
      // every other adb-dependent accessor in this function already uses,
      // since neither exists yet at this point in boot.
      const capabilityRegistry = buildCoreCapabilityRegistry()
      // The database-backed workspace (plan 64 §3.1, §4.1) — one store per
      // boot, quotas read fresh from settings on every call, the same
      // pattern every other settings-derived accessor in this function uses.
      const workspaceStore = withAutoRebuild(createWorkspaceStore(db, () => settingsStore.get().workspace), {
        devSlots: pluginDevSlots,
        runtime: pluginRuntime,
        log: log.child('plugins.dev'),
      })
      // AI agents and connectors (plan 65 §4.5) — `agentStore` validates an
      // agent's tools against the SAME registry built just above, so a
      // capability that does not exist can never be saved onto an agent.
      // `modelListCache` is one instance for the process, exactly like
      // `workspaceStore` above (a TTL cache over `GET /v1/models`, plan 65 §3.2).
      const agentStore = createAgentStore({ db, registry: capabilityRegistry })
      agentStoreRef = agentStore // plan 68 §4.2 — resolves the schedule runner's `agentDispatch.agentExists` forward-ref, built well before this point.
      const connectorStore = createConnectorStore({ db, dataDir: cfg.dataDir })
      const modelListCache = createModelListCache()
      const capContextDeps: CapabilityContextDeps = {
        db,
        leases,
        states,
        sessions: () => sessions,
        readiness: () => readiness,
        transfer: transferPortForScripts,
        jobService,
        workspace: workspaceStore,
        // Plan 68 §4.3 — `notify.send`'s one-line delegation. The SAME instance for every actor:
        // a human via REST/MCP and an agent via the loop both reach the identical service.
        notify: notifyService,
        // Plan 82 §3.3 — `ctx.resolveScriptRef` (used by `job.enqueue`'s `scriptRef` form,
        // `capability/job.ts`) resolves a plugin member the same as a standalone script.
        registry: scriptRegistry,
      }
      const openApiDocument = buildOpenApiDocument(capabilityRegistry, CORE_VERSION)

      // The agent loop (plan 66 §4.3, §4.4) — threads/runs/messages, approvals, and the
      // orchestrator that runs them. Built once, here, right after the pieces it depends on
      // (`capabilityRegistry`, `agentStore`, `connectorStore`, `modelListCache`, `capContextDeps`).
      // `agentWsHandler` and `agentRunner` reference each other (the handler needs to forward
      // `agent.run.cancel` to the runner; the runner needs to broadcast through the handler), so
      // the handler is built against the SAME forward-ref pattern used throughout this function.
      let agentRunnerRef: ReturnType<typeof createAgentRunner> | null = null
      const agentThreadStore = createThreadStore(db)
      const agentApprovalStore = createApprovalStore({ db })
      // Plan 67 §4.1 — the run tree's inbox and spawn grants, alongside the thread/approval stores.
      const agentTreeStore = createTreeStore(db)
      // Plan 70 §4.1 — content-addressed image storage, alongside the other agent-loop stores. One
      // instance for the whole boot: the loop (`executeRun`'s `blobs` dep) and the blob API
      // (`POST`/`GET /api/v1/blobs`) both read and write through this SAME store, never two.
      const agentBlobStore = createBlobStore(db)
      const agentWsHandler = createAgentWsHandler({ runner: { cancelRun: (runId, by) => agentRunnerRef?.cancelRun(runId, by) } })
      const agentRunner = createAgentRunner({
        threads: agentThreadStore,
        approvals: agentApprovalStore,
        agents: agentStore,
        connectors: connectorStore,
        registry: capabilityRegistry,
        capContextDeps,
        leases,
        settings: () => settingsStore.get(),
        modelListCache,
        tree: agentTreeStore,
        // Plan 70 §4.1, §4.4 — threaded straight through to every `executeRun` call.
        blobs: agentBlobStore,
        // Plan 67 §3.3, §4.4 — `agent.message.queued`/`agent.child.started`/`.finished` are
        // addressed to a DIFFERENT run's thread than the one whose execution produced them.
        publishToThread: (threadId, msg) => agentWsHandler.publishRaw(threadId, msg),
        audit,
        // Same role-resolution expression the WS router below builds for its own `roleOf` dep
        // (plan 26 §4.1, §4.3) — local mode's one implicit admin ignores the userId entirely.
        roleOf: authMode === 'local' ? () => 'admin' : (userId) => (userId ? (auth.listUsers().find((u) => u.id === userId)?.role ?? 'operator') : 'operator'),
        emit: (thread, run, event) => agentWsHandler.publish(thread, run, event),
        onRunStarted: (thread, run) => agentWsHandler.publishRunStarted(thread, run),
        onRunFinished: (thread, run) => agentWsHandler.publishRunFinished(thread, run),
        // Plan 68 §3.5 — the record of an auto-denied destructive call (never rate-limited; not a
        // `notify.send` capability call — a run does not choose whether this happens).
        notifyAutoDenied: (info) => {
          notifyAndBroadcast({
            level: 'warn',
            title: `${info.agent.name}: destructive capability auto-denied`,
            body: `"${info.capabilityId}" was not run — this thread auto-denies destructive capabilities instead of pausing for approval (onApprovalRequired: deny).`,
            context: { runId: info.run.id, threadId: info.thread.id, agentId: info.agent.id },
            source: 'system',
          })
        },
        log: log.child('agent'),
      })
      agentRunnerRef = agentRunner
      scheduledAgentRunnerRef = agentRunner // plan 68 §4.2 — resolves the schedule runner's agentDispatch forward-refs, built well before this point.
      // Restart recovery (plan 66 §4.3, criterion 9): a `running` row did not survive whatever
      // stopped the previous process — mark it `failed`/`interrupted` rather than leave it
      // claiming to be in progress forever. A `paused` row is untouched: that is exactly the
      // state an approval exists to survive.
      agentRunner.recoverAfterRestart()
      // The shared reaper cadence sweeps overdue approvals too (plan 66 §4.3) — wired via the
      // SAME forward-ref pattern as `publishDeviceEvent` and friends above: `expiryReaper` is
      // constructed long before `agentRunner` exists.
      sweepAgentApprovals = () => agentRunner.sweepExpiredApprovals()

      // 4. HTTP and WS come up FIRST so clients can watch provisioning progress
      const app = createApp({
        listDevices: () => listDevicesWithTags(db, undefined, (deviceId) => leases.getHolder(deviceId)),
        deviceCount: () => db.select().from(devices).all().length,
        log: log.child('http'),
        version: CORE_VERSION,
        adbServerVersion: async () => {
          if (!adb) return null
          return adb.version().catch(() => null)
        },
        adbState: () => adbState,
        toolchain,
        // `scriptRef` resolution (plan 62 §4.4) — resolved before the job row
        // is written, so `jobs.scriptId` is always concrete.
        jobRoutes: createJobRoutes(jobService, {
          log: log.child('jobs'),
          resolveScriptRef: (ref) => scriptRegistry.resolve(ref),
          logBuffer: jobLogBuffer,
        }),
        deviceRoutes: createDeviceRoutes({
          db,
          registry: () => buildRegistryResponse(toolchain),
          battery: () => battery,
          audit,
          dataDir: cfg.dataDir,
          record: recorder!.record,
          // Farm defaults now land at admission rather than at first sight
          // (plan 56 §4.3) — same accessors the registry is given below, so
          // the two cannot disagree about what a new device inherits.
          deviceDefaults: () => settingsStore.get().defaults,
          defaultDesiredReadiness: () => settingsStore.get().readiness.defaultDesired,
          // `registry` is assigned later in boot, so this reads it at call
          // time rather than capturing a null — admitting a device cannot
          // happen before the registry exists anyway.
          onAdmitted: (stableId) => registry?.admitted(stableId),
          // Presence's snapshot half (plan 31 §3.4): `/ws` has no replay, so a
          // client GETs the current list before subscribing to `device.viewers`.
          viewersOf: (deviceId) => viewersOfDevice?.(deviceId) ?? [],
          // Device readiness (plan 43 §4.5) — `readiness` is constructed
          // synchronously above, well before `createApp` is reached.
          readiness: readiness ?? undefined,
          // Who holds a device's manual lease (plan 71 §4.4) — `leases` is
          // constructed synchronously above too.
          heldByOf: (deviceId) => leases.getHolder(deviceId),
          // The lease-scoped adb endpoint (plan 27 §4.3) — `manager` is
          // constructed unconditionally above, before this point is reached.
          adbEndpoint: { manager: adbEndpointManager!, leases, shellSettings: () => settingsStore.get().shell },
          // File transfer and APK install (plan 39 §4.3, §4.4) —
          // `transferService`/`transferBroadcast` are constructed
          // unconditionally above too, the same reasoning as `adbEndpoint`.
          transfer: {
            transfer: transferService,
            leases,
            record: recorder!.record,
            shellSettings: () => settingsStore.get().shell,
            transferSettings: () => settingsStore.get().transfer,
            broadcast: transferBroadcast,
            holdFor: readinessHoldForTransfer,
          },
          // Device lifecycle — Forget and Block (plan 47 §4.4) — `deviceLifecycle`
          // is constructed unconditionally above, beside `leaseManager`.
          lifecycle: deviceLifecycle,
          broadcast: (msg) => hub.broadcast(msg),
        }),
        // Plan 44 §5.8 — built just above, before adb was ready.
        guestAgentRoutes: guestAgent.routes,
        // Plan 58 §5.3 — built just above, alongside `guestAgent`.
        deviceIdentityRoutes: deviceIdentity,
        tagRoutes: createTagRoutes({ db }),
        clusterRoutes: createClusterRoutes({ db, audit, heldByOf: (deviceId) => leases.getHolder(deviceId) }),
        topologyRoutes: createTopologyRoutes({
          db,
          readinessOf: (deviceId, row) => readiness?.get(deviceId) ?? staticReadinessFallback(row),
          heldByOf: (deviceId) => leases.getHolder(deviceId),
        }),
        batchRoutes: createBatchRoutes({
          db,
          jobStore,
          scheduler: scheduler!,
          audit,
          broadcastBatchStatus: (msg) => hub.broadcast(msg),
          scriptNames: (ids) => jobStore.scriptNames(ids),
          registry: executors,
          findScript,
        }),
        scheduleRoutes: createScheduleRoutes({
          db,
          jobStore,
          scheduler: scheduler!,
          audit,
          log: log.child('schedule-api'),
          runner: scheduleRunner!,
          registry: executors,
          findScript,
          scriptNames: (ids) => jobStore.scriptNames(ids),
          onJobStatus: (info) => hub.broadcast({ type: 'job.status', payload: info }),
          broadcastBatchStatus: (msg) => hub.broadcast(msg),
          broadcastFired: (msg) => hub.broadcast(msg),
          // Plan 68 §4.2 — agent-target schedules: `agentStore`/`agentRunner` are already built by
          // this point in the function (unlike `scheduleRunner`'s own construction, much earlier,
          // which needed the forward-ref pair above).
          agentDispatch: scheduleAgentDispatch,
          agentExists: (agentId) => {
            const agent = agentStore.get(agentId)
            return !!agent && agent.enabled
          },
          scheduledAgentCeilings: () => settingsStore.get().scheduledAgents,
          notifySystem: (input) => {
            notifyAndBroadcast({ level: input.level, title: input.title, body: input.body ?? null, context: input.context ?? null, source: 'system' })
          },
          // Plan 82 §3.3, §3.5 — see `scheduleRunner`'s own construction above for why.
          scriptRegistry,
        }),
        settingsRoutes: createSettingsRoutes(settingsStore),
        artifactRoutes: createArtifactRoutes({
          db,
          dataDir: cfg.dataDir,
          // The one way a file enters the artifact store from outside a job
          // (plan 39 §4.4) — gated by the same `device.files`/`shell.mode`
          // switch install/push/pull use, and audited.
          upload: { audit, shellSettings: () => settingsStore.get().shell },
        }),
        adbStatsRoutes: createAdbStatsRoutes({
          db,
          client: () => adb,
          metrics: adbMetrics,
          health: () => health,
          auto: () => settingsStore.get().adb.maxConcurrent === 0,
          sessions: () => sessions,
        }),
        doctorRoutes: createDoctorRoutes({
          dataDir: cfg.dataDir,
          coreProbe: async () => ({
            running: true,
            health: {
              version: CORE_VERSION,
              deviceCount: db.select().from(devices).all().length,
              uptimeMs: Date.now() - startedAt,
              mode: process.env.ENKAKU_MODE === 'orchestrator' ? 'orchestrator' : 'local',
            },
            quarantined: db
              .select()
              .from(devices)
              .where(eq(devices.status, 'quarantined'))
              .all()
              .map((row) => ({ deviceId: row.id, label: row.label, reason: row.quarantineReason ?? 'unknown' })),
          }),
        }),
        authRoutes: createAuthRoutes({
          auth,
          audit,
          mode: authMode,
          secureCookie: cfg.tls.mode !== 'off',
          maxAttempts: cfg.auth.loginMaxAttempts,
          lockoutSeconds: cfg.auth.loginLockoutSeconds,
        }),
        nodeRoutes: createNodeRoutes({ nodeAuth, db }),
        auth,
        authMode,
        scriptRoutes: createScriptRoutes({ db, ...(process.env.ENKAKU_PUBLISH_TOKEN ? { publishToken: process.env.ENKAKU_PUBLISH_TOKEN } : {}) }),
        pluginRoutes: createPluginRoutes({
          runtime: pluginRuntime,
          audit,
          workspace: workspaceStore,
          // `enkaku dev` (plan 82 §3.5 front-end B, §5 step 12) sends its own
          // `user@host` label so the Plugins page can say who owns a dev
          // slot without falling back to a bare user id — optional, so a
          // plain `POST /api/plugins/dev` (no header) still works exactly
          // as it did before this existed.
          devOwnerFromRequest: (c) => {
            const label = c.req.header('x-enkaku-dev-owner')
            return label ? { kind: 'cli', label } : null
          },
        }),
        // The capability registry's three generated surfaces (plan 63 §3.5,
        // §4.4, §4.5) — `capabilityRegistry`/`capContextDeps`/`openApiDocument`
        // are all built just above, before this call.
        capRoutes: createCapRoutes({ registry: capabilityRegistry, contextDeps: capContextDeps, audit }),
        openApiDocument,
        mcpRoutes: createMcpServer({ registry: capabilityRegistry, contextDeps: capContextDeps, audit, serverVersion: CORE_VERSION }),
        // AI agents and connectors (plan 65 §4.5) — `agentStore`/`connectorStore`/`modelListCache` are built just above.
        // `tree: agentTreeStore` (plan 67 §4.1) backs `/:id/spawn-grants`.
        agentRoutes: createAgentRoutes({ store: agentStore, tree: agentTreeStore, audit }),
        // The durable kv store's admin surface (plan 79 §4.3, step 4) — `kvStore` is built early,
        // alongside `deviceLifecycle`, since the job runner also needs it.
        kvRoutes: createKvRoutes({ store: kvStore, audit }),
        connectorRoutes: createConnectorRoutes({ store: connectorStore, audit, modelCache: modelListCache }),
        // The agent loop's REST surface (plan 66 §4.4) — `agentRunner`/`agentThreadStore`/`agentApprovalStore`/`agentWsHandler` are all built just above.
        threadRoutes: createThreadRoutes({ runner: agentRunner, threads: agentThreadStore, approvals: agentApprovalStore, agentWs: agentWsHandler, audit }),
        // Content-addressed image blobs (plan 70 §4.6) — `agentBlobStore` is built just above,
        // alongside the other agent-loop stores; the cap matches the farm's own per-image budget
        // (`agentDefaults.maxImageBytes`) so an upload and a stored screenshot are held to the same limit.
        blobRoutes: createBlobRoutes({ blobs: agentBlobStore, audit, maxUploadBytes: () => settingsStore.get().agentDefaults.maxImageBytes }),
        // Notifications and webhooks (plan 68 §4.5) — `notificationStore`/`webhookStore` are built early, alongside `hub`.
        notificationRoutes: createNotificationRoutes({ store: notificationStore }),
        webhookRoutes: createWebhookRoutes({ store: webhookStore, audit }),
        startedAt,
      })
      const tlsOptions =
        cfg.tls.mode === 'self' && cfg.tls.certPath && cfg.tls.keyPath
          ? { tls: { cert: Bun.file(cfg.tls.certPath), key: Bun.file(cfg.tls.keyPath) } }
          : {}

      server = Bun.serve({
        hostname: cfg.host,
        port: cfg.port,
        ...tlsOptions,
        async fetch(req, srv) {
          const url = new URL(req.url)
          // The node tunnel authenticates with the credential from enrollment.
          // `/agent/ws` is the pre-plan-61 path — accepted alongside `/node/ws`
          // for the same compatibility window as `agent.hello` (§3.3): a node
          // binary already deployed in the field has this URL hardcoded and
          // cannot be told to dial somewhere else.
          if (url.pathname === '/node/ws' || url.pathname === '/agent/ws') {
            const nodeId = await nodeAuth.verify(req.headers.get('authorization'))
            if (!nodeId) return new Response('unauthorized', { status: 401 })
            if (srv.upgrade(req, { data: { nodeId } })) return undefined
            return new Response('upgrade failed', { status: 400 })
          }
          if (url.pathname === '/ws') {
            // A WS handshake does not always carry cookies → support single-use tickets.
            // The resolved user rides along on `ws.data` (plan 18 §4.2, §18.4):
            // control.acquired/control.revoked and input events need an actor,
            // not just an anonymous per-connection clientId.
            let userId: string | null = null
            if (authMode === 'server') {
              const ticket = url.searchParams.get('ticket')
              const cookie = req.headers.get('cookie')?.match(/enkaku_session=([^;]+)/)?.[1]
              const user = ticket ? auth.consumeWsTicket(ticket) : cookie ? auth.validateSession(cookie) : null
              if (!user) return new Response('unauthorized', { status: 401 })
              userId = user.id
            } else {
              userId = auth.ensureLocalAdmin().id
            }
            if (srv.upgrade(req, { data: { userId } })) return undefined
            return new Response('upgrade failed', { status: 400 })
          }
          return app.fetch(req, srv)
        },
        websocket: {
          open: (ws) => {
            const nodeId = (ws.data as { nodeId?: string } | null)?.nodeId
            if (nodeId) {
              tunnelRegistry.attach(nodeId, ws)
              return
            }
            hub.handlers.open?.(ws)
          },
          close: (ws, code, reason) => {
            const nodeId = (ws.data as { nodeId?: string } | null)?.nodeId
            if (nodeId) {
              tunnelRegistry.detach(ws)
              return
            }
            hub.handlers.close?.(ws, code, reason)
          },
          message: (ws, message) => {
            const nodeId = (ws.data as { nodeId?: string } | null)?.nodeId
            if (nodeId) {
              if (typeof message === 'string') tunnelRouter.handleNodeMessage(ws, nodeId, message)
              else tunnelRouter.handleNodeFrame(nodeId, new Uint8Array(message))
              return
            }
            hub.handlers.message?.(ws, message)
          },
        },
      })
      const scheme = cfg.tls.mode === 'self' ? 'https' : 'http'
      log.info(`enkaku core v${CORE_VERSION} listen ${scheme}://${cfg.host}:${cfg.port}`)

      // The plugin packs carried inside a compiled binary (staged, not
      // activated). Deliberately after `listen` and deliberately not awaited:
      // it spawns a verify child per pack, and nothing about serving requests
      // depends on the outcome. Running from source embeds nothing, so this is
      // a no-op there.
      const embeddedPacks = embeddedAssets()?.packs ?? []
      if (embeddedPacks.length > 0) {
        void seedEmbeddedPacks({
          runtime: pluginRuntime,
          packs: embeddedPacks,
          dataDir: cfg.dataDir,
          log: log.child('packs'),
        })
      }

      // Artifact retention (spec §18) — the policy comes from farm settings.
      retention = createRetentionGc({
        db,
        dataDir: cfg.dataDir,
        settings: settingsStore,
        log: log.child('retention'),
        intervalMinutes: cfg.retention.sweepIntervalMinutes,
        onSwept: (r) => audit.record({ userId: null, action: 'retention.gc', meta: r }),
      })
      retention.start()

      leases.startReaper()
      stopReaper = () => leases.stopReaper()
      expiryReaper.start()
      stopExpiryReaper = () => expiryReaper.stop()
      scheduler.start()
      const sched = scheduler
      stopScheduler = () => sched.stop()
      scheduleRunner.start()
      const runner = scheduleRunner
      stopScheduleRunner = () => runner.stop()

      // The WS router is attached in EVERY mode. Under the orchestrator,
      // `sessions` is null and all device work is served through nodes —
      // without this, browser requests were silently ignored (the bug Plan 12 fixed).
      const attachWsRouter = (localSessions: SessionManager | null) => {
        const handler = createWsMessageHandler({
          sessions: localSessions,
          ...(remoteSessions ? { remote: remoteSessions } : {}),
          webrtc: webrtcRelay,
          pairing: pairingService,
          leases,
          jobs: jobService,
          // The Monitor tab (plan 24) works on node-owned devices too now
          // (plan 25): `adb` still serves local devices; `rpc`/`router` are
          // what let `shellPortFor` build the remote `ShellPort` for the rest.
          adb: () => adb,
          rpc: tunnelRpc ?? undefined,
          router: tunnelRouter,
          db,
          broadcast: (msg) => hub.broadcast(msg),
          recorder: recorder!,
          audit,
          isLogInputTextEnabled,
          // Local mode has one implicit admin (plan 31 §3.3) — null tells the
          // UI to fall back to the session id rather than print a meaningless
          // "local-admin" for every row. Server mode resolves the real email.
          userLabel:
            authMode === 'local'
              ? () => null
              : (userId) => (userId ? (auth.listUsers().find((u) => u.id === userId)?.email ?? null) : null),
          // `shell.exec`'s server-authoritative permission check (plan 26
          // §4.1, §4.3) — local mode's implicit admin always resolves to
          // `admin`; server mode looks the real role up, defaulting to the
          // least-privileged `operator` if a userId somehow does not resolve.
          roleOf:
            authMode === 'local'
              ? () => 'admin'
              : (userId) => (userId ? (auth.listUsers().find((u) => u.id === userId)?.role ?? 'operator') : 'operator'),
          // `canUseDevice` (plan 34 §3.5, §4.4) — `lease.acquire`'s ownership check.
          getDeviceOwner,
          shellSettings: () => settingsStore.get().shell,
          // The lease-scoped adb endpoint (plan 27 §4.2) — explicit
          // `lease.release` and WS-disconnect teardown both live in
          // `ws-handlers.ts` already (that is where the WS-level lease and
          // connection lifecycle already are); the automatic-revocation and
          // device-offline paths are wired directly above, outside the WS
          // router, since those originate in the lease manager and the
          // device registry rather than from a client message.
          adbEndpoint: adbEndpointManager!,
          // Device readiness (plan 43 §5 step 43.7) — `readiness` is
          // constructed unconditionally above, before this point is reached
          // (the same `leases`/`leaseManager` ordering this router already
          // depends on).
          readiness: readiness ?? undefined,
          // `transfer.cancel` (plan 39 §4.4, acceptance #9) — `transferService`
          // is constructed unconditionally above, the same as `adbEndpoint`.
          transfer: transferService,
          // Crash detection (plan 37 §4.3, §4.4) — `job.crashPolicy` is read
          // fresh per crash, the same pattern every other farm setting here
          // already uses; `onJobCrash` reaches the SAME `host` the scheduler
          // and the settle path use, so a crash-driven abort classifies and
          // records exactly like any other job failure.
          crashPolicy: () => settingsStore.get().job.crashPolicy,
          targetPackagesForJob: (jobId) => targetPackagesByJob.get(jobId) ?? [],
          saveCrashTrace,
          onJobCrash: (jobId, e) => host.notifyCrash(jobId, e),
          // The agent chat protocol's subscribe/unsubscribe/cancel half (plan 66 §4.4) — built
          // once, above, before `attachWsRouter` is even defined (it does not depend on `sessions`).
          agent: agentWsHandler,
          log: log.child('ws-handler'),
        })
        hub.setRouter(handler)
        // Device event live tail (plan 18 §3.6, §4.6) fans out through
        // whichever WS router is currently attached.
        publishDeviceEvent = handler.publishEvent
        broadcastDeviceViewers = handler.broadcastViewers
        viewersOfDevice = handler.viewersOf
        stopMonitorsForDevice = handler.stopMonitorsForDevice
        releaseShellSession = handler.releaseShellSession
        resetInspectForDevice = handler.resetInspectForDevice
        releaseLeaseReadinessHold = handler.releaseLeaseHold
        watchCrashesForDevice = handler.watchDevice
        unwatchCrashesForDevice = handler.unwatchDevice
      }

      if (isOrchestrator) {
        // The orchestrator never touches adb or a local device.
        adbState = 'orchestrator'
        attachWsRouter(null)
        log.info('mode orchestrator: waiting for a node to connect on /node/ws')
        return
      }

      // 5. Provision the required tools → only then may the adb subsystem start (a gate)
      try {
        await provisionRequiredTools({
          manager: toolchain,
          hub,
          log: log.child('provision'),
          required: REQUIRED_TOOLS,
          critical: CRITICAL_TOOLS,
        })
        const adbPath = await toolchain.resolveToolPath('adb')
        adb = new AdbClient({
          adbPath,
          onLog: (level, msg) => log.child('adb')[level](msg),
          // Plan 22.1 §22.6's hook, consumed here (plan 23 §4.4, §4.6): every
          // settled exec/execOut feeds both the diagnostics ring buffer and
          // the health tracker's consecutive-failure counter.
          onMetric: (m) => {
            adbMetrics.record(m)
            health?.note(m.serial, m.outcome, m.code)
          },
        })
        await adb.ensureServer()
        const adbVersion = await adb.version()
        log.info(`adb server ok (version ${adbVersion}) via ${adbPath}`)

        // `ports` is the one constructed unconditionally above, before adb
        // was ready — shared with the guest-agent network route (plan 44 §5.7).
        const adbClient = adb
        const inspectorLog = log.child('inspector')
        const scrcpyLog = log.child('scrcpy')
        const hostAdb = async (args: string[]) => {
          const proc = Bun.spawn([adbClient.binaryPath, ...args], { stdout: 'pipe', stderr: 'pipe' })
          const out = await new Response(proc.stdout).text()
          const exit = await proc.exited
          if (exit !== 0) throw new Error(`adb ${args.join(' ')} exit ${exit}: ${out.trim()}`)
          return out
        }

        sessions = createSessionManager({
          client: adb,
          devices: createDbDeviceSource(db),
          log: log.child('session'),
          onSessionEnded: (deviceId, reason) =>
            hub.broadcast({ type: 'stream.ended', payload: { deviceId, reason } }),
          // The wake-up progress panel (Plan 17 §3.3, §4.7): one broadcast per
          // start-up phase turns the dead time before the first frame into
          // something Studio can show instead of a black rectangle.
          onPhase: (deviceId, phase, detail) =>
            hub.broadcast({ type: 'session.progress', payload: { deviceId, phase, ...(detail ? { detail } : {}) } }),
          // Main-stream device events: session.opened / session.closed / session.degraded (plan 18 §4.2).
          onEvent: (deviceId, kind, meta) => {
            recorder?.record({ deviceId, stream: 'main', kind, meta })
            // Crash detection is always on for any device with an active
            // session, independent of jobs (plan 37 §3.3) — it starts and
            // stops with the session itself, the same lifecycle Plan 24's
            // monitor streams already stop on (`stopMonitorsForDevice`).
            if (kind === 'session.opened') watchCrashesForDevice?.(deviceId)
            else if (kind === 'session.closed') unwatchCrashesForDevice?.(deviceId)
            // Session open/close is one of the events readiness reconciles
            // on (plan 43 §5 step 43.6) — a session appearing (someone
            // else's hold, a viewer) or disappearing (Plan 42's idle TTL
            // finally firing) both change `actual`.
            if (kind === 'session.opened' || kind === 'session.closed') void readiness?.reconcile(deviceId)
          },
          // Idle session TTL (Plan 42 §4.4) — read fresh on every release, the
          // same pattern `resetPolicy`/`adb.maxConcurrent` already use.
          idleTtlSec: () => settingsStore.get().session.idleTtlSec,
          maxIdleSessions: () => settingsStore.get().session.maxIdleSessions,
          makeScrcpy: async (deviceId, transport, quality) => {
            // Jar di-manage Toolchain & versi dikunci ke core (spec §7.6).
            const jarPath = await toolchain.resolveToolPath('scrcpy-server').catch(() => null)
            if (!jarPath) {
              scrcpyLog.info('scrcpy-server is not provisioned — using the screencap-loop fallback')
              return null
            }
            // No port is claimed here on purpose: adb picks one (tcp:0) and the
            // scrcpy session verifies the binding belongs to this serial. The
            // old path claimed a port from the shared allocator and leaked it,
            // which is how a port could end up bound to the other device.
            const profile = QUALITY_PROFILES[quality]
            return startScrcpySession(
              { serial: transport.serial, exec: (cmd) => transport.exec(cmd, { profile: 'default' }).then((r) => r.stdout), hostAdb },
              {
                jarPath,
                maxSize: profile.maxSize,
                maxFps: profile.maxFps,
                bitRate: profile.bitRate,
                onLog: (level, msg) => scrcpyLog[level](msg),
              },
            )
          },
          makeInspector: (deviceId, transport, requested) =>
            createInspectorForSession(
              {
                toolchain,
                ports,
                log: inspectorLog,
                hostAdb: async (args) => {
                  const proc = Bun.spawn([adbClient.binaryPath, ...args], { stdout: 'pipe', stderr: 'pipe' })
                  const out = await new Response(proc.stdout).text()
                  const exit = await proc.exited
                  if (exit !== 0) throw new Error(`adb ${args.join(' ')} exit ${exit}: ${out.trim()}`)
                  return out
                },
                // The Plan 24 streaming lane, bound to this adb client (plan
                // 34 §4.1) — the ui-server instrumentation's `am instrument
                // -w` runs here instead of through the per-device queue.
                execStream: (serial, cmd, streamOpts) => adbClient.execStream(serial, cmd, streamOpts),
                onStatus: (deviceId, status) =>
                  hub.broadcast({
                    type: 'device.inspector.status',
                    payload: {
                      deviceId,
                      state: status.state,
                      ...('reason' in status ? { reason: status.reason } : {}),
                      ...('attempt' in status ? { attempt: status.attempt } : {}),
                    },
                  }),
                onFallback: (deviceId, from, to, reason) => {
                  hub.broadcast({ type: 'device.inspector.fallback', payload: { deviceId, from, to, reason } })
                  recorder?.record({ deviceId, stream: 'main', kind: 'session.degraded', meta: { from, to, reason } })
                },
                // A one-shot repair still left the ui-server APK mismatched
                // (plan 41 §3.3) — visible degradation, recorded once, never
                // retried automatically.
                onArtifactMismatch: (deviceId, info) =>
                  recorder?.record({
                    deviceId,
                    stream: 'main',
                    kind: 'device.artifact.mismatch',
                    meta: { package: UI_SERVER_PACKAGE, reason: info.reason, ...(info.observed ? { observed: info.observed } : {}) },
                  }),
              },
              { deviceId, transport, requested },
            ),
        })

        // The script executor (M4) needs SessionManager → registered once adb is ready.
        const runner = createJobRunner({
          logDir: cfg.dataDir,
          sessions,
          artifacts: (jobId) =>
            createDbArtifactSink({
              db,
              dataDir: cfg.dataDir,
              jobId,
              onSaved: (info) => hub.broadcast({ type: 'job.artifact', payload: { jobId, artifact: info } }),
            }),
          log: log.child('runner'),
          onLog: (entry) => {
            // Retained as well as broadcast: `/ws` has no snapshot replay, so a
            // page opened mid-run would otherwise see nothing that already
            // happened, and the `job.log` artifact does not exist until the
            // job ends. `GET /api/jobs/:id/logs` serves this.
            jobLogBuffer.append(entry)
            hub.broadcast({
              type: 'job.log',
              payload: {
                jobId: entry.jobId,
                ts: entry.ts,
                level: entry.level,
                source: entry.source,
                msg: entry.msg,
                ...(entry.fields ? { fields: entry.fields } : {}),
              },
            })
          },
          onArtifact: () => {
            // The sink already broadcast this when it wrote the DB row.
          },
          onPhase: (jobId, attempt, phase) => {
            const info = jobService.get(jobId)
            if (info) hub.broadcast({ type: 'job.status', payload: { ...info, attempt, phase } })
          },
          heartbeat: (jobId) => jobStore.renewLease(jobId, cfg.lease.jobTtlSec),
          // Read fresh per attempt, not captured here at daemon start (plan
          // 35 §4.4) — the same pattern `adb.maxConcurrent` uses (plan 23) —
          // so a Settings change applies to the very next job.
          resetPolicy: () => settingsStore.get().job,
          // One `job.reset` main-stream device event per pre-job reset (plan
          // 35 §3.5, §4.4).
          onReset: (jobId, deviceId, outcome, plan) =>
            recorder?.record({
              deviceId,
              stream: 'main',
              kind: 'job.reset',
              actor: `job:${jobId}`,
              meta: { policy: plan.policy, packages: plan.packages ?? [], applied: outcome.applied, warnings: outcome.warnings, durationMs: outcome.durationMs },
            }),
          // Retry classification (plan 36 §4.1, §4.3) — the same canonical
          // table `executor-host.ts` uses for the final settle, so a job's
          // per-attempt log lines and its eventual `jobs.failureClass` always
          // agree on why it failed.
          classify: (err) => classifyFailure(err, { timeoutIsInfra: settingsStore.get().job.retry.timeoutIsInfra }),
          // One `job.retry` main-stream device event per in-place retry
          // (plan 36 §4.4) — `rebound` is always false here; the host emits
          // its own `job.retry` event, with `rebound: true`, only when a
          // batch member actually moves to another device.
          onRetry: (jobId, info) => {
            const jinfo = jobService.get(jobId)
            if (!jinfo) return
            recorder?.record({
              deviceId: jinfo.deviceId,
              stream: 'main',
              kind: 'job.retry',
              actor: `job:${jobId}`,
              meta: { ...info, rebound: false },
            })
          },
          // The crash policy's `declared` target set (plan 37 §3.4, §4.4) —
          // read back by the crash watcher through `targetPackagesForJob`
          // below, wired into the WS router.
          onTargetPackages: (jobId, packages) => targetPackagesByJob.set(jobId, packages),
          // `ctx.device.install`/`push`/`pull` (plan 39 §4.6) — the same
          // `TransferService` every other path uses, wrapped once above.
          transfer: transferPortForScripts,
          // Timing realism (spec §9.3, plan 34 §3.3, §4.2) — read fresh per
          // attempt, the same pattern `resetPolicy` above already uses, so a
          // Settings change reaches the very next job with no restart.
          // `defaults` because `timing` is defined once, on `DeviceSettingsSchema`,
          // and reused verbatim by `FarmSettingsSchema.defaults` (settings.ts) —
          // there is no separate top-level `timing` field.
          timing: () => settingsStore.get().defaults.timing,
          // `ctx.kv` (plan 79 §4.4, §4.7) — the same store `deviceLifecycle` and
          // `kvRoutes` share; `call`/`redact` are the two things a job actually needs.
          kv: kvRunnerPort,
          // `ctx.jobs` (plan 80 §4.2) — a running script's own view of the queue.
          jobs: jobsRunnerPort,
        })
        const localExecutor = createScriptExecutor({ registry: scriptRegistry, runner })
        executors.setFallback({
          validateParams: (params) => localExecutor.validateParams(params),
          run: (job, ctx) => {
            // Node-owned device → run it on the node; otherwise run locally.
            const owner = remoteSessions?.nodeIdFor(job.deviceId) ?? null
            return owner ? remoteBridge.executor.run(job, ctx) : localExecutor.run(job, ctx)
          },
        })
        pairingService = createPairingService({ client: adb, log: log.child('pairing') })
        attachWsRouter(sessions)

        // Battery/thermal poll + auto-quarantine (M5, spec §15.2).
        battery = createBatteryMonitor({
          db,
          client: () => adb,
          states,
          settings: settingsStore,
          log: log.child('battery'),
          onBattery: (deviceId, state) =>
            hub.broadcast({ type: 'device.battery', payload: { deviceId, battery: state } }),
          record: recorder!.record,
        })
        battery.start()

        // Device health: auto-quarantine on repeated adb failure, with
        // automatic recovery for `adb:`-prefixed reasons only (plan 23 §3.5,
        // §4.4) — thermal quarantine above stays exactly as it was.
        health = createDeviceHealth({
          db,
          client: () => adb,
          states,
          settings: settingsStore,
          log: log.child('health'),
          record: recorder!.record,
        })
        health.start()

        registry = createDeviceRegistry({
          client: adb,
          db,
          hub,
          log: log.child('registry'),
          states,
          // A newly enrolled device inherits the farm defaults (spec §12).
          deviceDefaults: () => settingsStore.get().defaults,
          defaultDesiredReadiness: () => settingsStore.get().readiness.defaultDesired,
          record: recorder!.record,
          onDeviceGone: (deviceId) => {
            void sessions?.closeDevice(deviceId)
            // Any job running on that device → failed (spec §10.1).
            const running = jobStore.runningByDevice(deviceId)
            // Plan 36 §3.2: the canonical "the phone was unplugged mid-run" case — coded infra.
            if (running) host.finishExternally(running.id, 'failed', 'device disconnected', 'DEVICE_DISCONNECTED')
            recomputeAdbConcurrency()
            // A dropped device must not leave a logcat/top/thermal stream
            // running against a socket that no longer exists (plan 24 §4.5).
            stopMonitorsForDevice?.(deviceId)
            // Nor a stale emulated cwd for a lease the state machine just
            // force-dropped outside the lease manager's own bookkeeping
            // (plan 26 §3.7, §4.4) — harmless if there was none.
            releaseShellSession?.(deviceId)
            // Nor a stale Inspect tab ref count (plan 56 §4.2 step 7) — the
            // inspector engine itself already went down with the session.
            resetInspectForDevice?.(deviceId)
            // A device that just went offline cannot usefully carry an adb
            // endpoint either (plan 27 §4.2) — the smartsocket backend it
            // bridges to is gone regardless of whether the lease itself
            // survives the disconnect.
            adbEndpointManager?.close(deviceId, 'device_offline')
            // A `vpn-helper` route's stored config/enabled survives the
            // device going offline (plan 52 §4.1) — nothing is torn down on
            // the device, since there is nothing left to reach. Its checks
            // are marked `unknown` instead of continuing to report a
            // last-known `pass` this process can no longer confirm.
            void handleNetworkDeviceOffline?.(deviceId).catch((err) =>
              log.warn(`handleNetworkDeviceOffline failed for ${deviceId}, tolerated: ${String(err)}`),
            )
          },
          onDeviceReady: (deviceId) => {
            scheduler?.kick()
            recomputeAdbConcurrency()
            // The device just came online — restore any persisted `vpn-helper`
            // route (plan 52 §4.1, §5.3): probe first, never blindly re-apply.
            void restoreNetworkRoute?.(deviceId).catch((err) =>
              log.warn(`restoreNetworkRoute failed for ${deviceId} on device-online, tolerated: ${String(err)}`),
            )
          },
        })
        await registry.start()
        recomputeAdbConcurrency()
        adbState = 'ready'
        log.info(`adb subsystem ready (devices registered: ${db.select().from(devices).all().length})`)
      } catch (err) {
        adbState = 'error'
        // The core stays up: the tools API can still be used to retry the install.
        log.error(
          `adb subsystem failed to start: ${String(err)} — the core stays up, retry from the Tools page (POST /api/tools/repair)`,
        )
      }
    },

    async stop() {
      if (stopped) return
      stopped = true
      log.info('stopping...')
      server?.stop(true)
      server = null
      stopScheduler?.()
      stopReaper?.()
      stopExpiryReaper?.()
      stopScheduleRunner?.()
      battery?.stop()
      battery = null
      health?.stop()
      health = null
      retention?.stop()
      retention = null
      // Sessions close first: closing one emits `session.closed`, which the
      // recorder must still be alive to receive. Stopping it first made a
      // clean Ctrl-C crash with `null is not an object (recorder.record)`
      // and exit 1, after the work was already done.
      await sessions?.closeAll()
      sessions = null
      await recorder?.stop()
      recorder = null
      await remoteSessions?.closeAll()
      remoteSessions = null
      await webrtcRelayRef?.closeAll()
      webrtcRelayRef = null
      await registry?.stop()
      registry = null
      await adb?.dispose()
      adb = null
      opened?.sqlite.close()
      opened = null
      // Last, so nothing can claim this directory while we are still tearing
      // sessions and the database down.
      dataDirLock?.release()
      dataDirLock = null
      log.info('stopped')
    },
  }
}
