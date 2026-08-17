import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { AdbClient, createAdbdShim, Semaphore } from '@enkaku/adb'
import { UI_SERVER_PACKAGE, UI_SERVER_DEVICE_PORT } from '@enkaku/drivers'
import { ToolchainManager } from '@enkaku/toolchain'
import {
  DEFAULT_AGENT_STATUS,
  DeviceSettingsSchema,
  type ArtifactInfo,
  type DeviceEvent,
  type DeviceStatus,
  type ServerMessage,
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
import { createBlobGc, type BlobGc } from './agent/blob/gc'
import { assertTlsPolicy, resolveAuthMode } from './config'
import { createArtifactRoutes } from './api/artifacts'
import { createDeviceRoutes } from './api/devices'
import { createDeviceIdentityRoutes } from './api/device-identity'
import { createGuestAgentRoutes, resolveGuestAgentApkPath } from './api/guest-agent'
import { createTagRoutes } from './api/tags'
import { createClusterRoutes } from './api/clusters'
import { createTopologyRoutes } from './api/topology'
import { createBatchRoutes, createBatchDispatchDeps } from './api/batches'
import { createScheduleRoutes } from './api/schedules'
import { recomputeBatchStatus } from './clusters/status'
import { createJobRoutes } from './api/jobs'
import { createSettingsRoutes } from './api/settings'
import { createBatteryMonitor, type BatteryMonitor } from './device/battery'
import { computeAutoConcurrency, computeAutoStreams } from './device/adb-scaling'
import { createAdbMetricsStore } from './device/adb-metrics'
import { createHostAdb, type HostAdb } from './device/host-adb'
import { createDeviceHealth, type DeviceHealth } from './device/health'
import { createAdbServerHealth, type AdbServerHealthMonitor } from './device/adb-health'
import { createAgentProvisioner, createAgentProvisionerRoutes, type AgentProvisioner } from './device/agent-provisioner'
import { createPreparationRunner, type PreparationRunner } from './device/preparation/runner'
import { createPreparationRegistry } from './device/preparation/registry'
import { createDevicePreparationRoutes } from './api/device-preparation'
import { createLabellingService, type LabellingService } from './device/labelling'
import { createAdbStatsRoutes } from './api/adb-stats'
import { createVideoRoutes } from './api/video'
import { createDoctorRoutes } from './api/doctor'
import { createFarmSettingsStore } from './settings/farm-settings'
import { buildRegistryResponse } from './registry/engines'
import { createScriptRoutes } from './scripts/routes'
import { createWorkflowRoutes } from './api/workflows'
import { createRecordingRoutes } from './api/recordings'
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
import { createRecordingService } from './recording/service'
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
  resolveVideoProfile,
  computeAutoTiles,
  resolveWallTransport,
  resolveWallBandwidthBps,
  type SessionManager,
  type TransferPort,
} from '@enkaku/session'
import { createScriptExecutor } from './jobs/executors/script'
import { createWorkflowExecutor } from './jobs/executors/workflow'
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
import { createLocalShellPort, createRemoteShellPort, type ShellPort } from './device/shell-port'
import { createTransferService, type TransferService } from './device/transfer'
import { runTransfer, type TransferBroadcast } from './device/transfer-dispatch'
import { createTransferRegistry } from './device/transfer-registry'
import { createTransferRegistryRoutes } from './api/transfers'
import { createReadinessManager, staticReadinessFallback, type ReadinessManager } from './device/readiness'
import { createDeviceLifecycle } from './device/lifecycle'
import { createPairingService, type PairingService } from './enroll/pairing'
import { EnkakuError } from './util/errors'
import { ExecutorRegistry } from './jobs/executor'
import { createExecutorHost } from './jobs/executor-host'
import { classifyFailure } from './jobs/failure-class'
import { pickRebindDevice } from './clusters/dispatch'
import { createBatchPacer, replanAfterRestart, type BatchPacer } from './clusters/pacer'
import { sleepExecutor } from './jobs/executors/sleep'
import { createInstallExecutor } from './jobs/executors/install'
import { createPushExecutor } from './jobs/executors/push'
import { createPullExecutor } from './jobs/executors/pull'
import { createLeaseManager } from './lease/lease-manager'
import { createCoControlManager, type CoControlManager } from './lease/co-control'
import { createCommandRunStore } from './command-console/store'
import { createCommandRunner, resolveCommandTarget, type CommandRunner, type CommandRunnerEvent } from './command-console/runner'
import { createCommandRunRoutes } from './api/command-runs'
import { createSavedCommandRoutes } from './api/saved-commands'
import { createJobStore } from './queue/job-store'
import { createExpiryReaper } from './queue/expiry'
import { createScheduler } from './queue/scheduler'
import { createScheduleRunner } from './schedules/runner'
import { validateScriptForRun } from './jobs/validate-script'
import { createDeviceRegistry, listDevicesWithTags, loadDeclaredMedia, type DeviceRegistry } from './registry/device-registry'
import { createDeviceReconciler, type DeviceReconciler } from './registry/reconcile'
import { createEndpointStore, type EndpointStore } from './registry/endpoints'
import { createDeviceReconnector, type DeviceReconnector } from './registry/reconnect'
import { createCutoverManager, type CutoverManager } from './registry/cutover'
import { formatDeviceLabel, loadDeviceNumbers } from './registry/device-number'
import { createApp } from './server/http'
import { WsHub } from './server/ws'
import { createWsMessageHandler, type InputStatsBlock } from './server/ws-handlers'
import type { TransportSnapshot } from './server/transport-metrics'
import { createJobService } from './services/job-service'
import { startScrcpySession, sweepStrayScrcpyServers } from '@enkaku/scrcpy'
import { createDbArtifactSink, createDbDeviceSource } from './session/adapters'
import { saveForDevice, createJobNodeTracker } from './runner/artifact-store'
import { materializeBundle } from './scripts/bundle-cache'
import { createAdbSwapCoordinator } from './tools/adb-swap'
import { createAdbServerControl, type AdbServerControl } from './tools/adb-server-control'
import { provisionRequiredTools, toolchainEventToMessage } from './tools/provision'
import { CRITICAL_TOOLS, REQUIRED_TOOLS } from './tools/required'
import { createToolInstallStore } from './tools/store'
import { createLogger } from './util/logger'
import { acquireDataDirLock, type DataDirLock } from './util/data-dir-lock'
import { createEventRecorder, type EventRecorder } from './events/recorder'
import { findPortHolder } from './doctor/context'

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
  /** The discovery reconciler (plan 85 §3.3, §4.4, fixes F8/F9/F10) — null until the adb subsystem comes up (or in orchestrator mode, where it never does), and stopped/cleared in `stop()`. */
  let reconciler: DeviceReconciler | null = null
  /** The reconnect ladder (plan 88 §3.3, §4.4, fixes F8/F10/F13) — null until the adb subsystem comes up (mirrors `reconciler` above), cleared in `stop()`. Used by the restart flow's reattach step and (once step 88.4 lands) per-device connect/reconnect routes. */
  let reconnector: DeviceReconnector | null = null
  /** The USB → network cutover wizard (plan 88 §3.4, §4.6, §5 step 88.5) — null until `reconnector` exists (it reuses that SAME ladder to watch), mirrors `reconnector` above, cleared in `stop()`. */
  let cutoverManager: CutoverManager | null = null
  let sessions: SessionManager | null = null
  let battery: BatteryMonitor | null = null
  let health: DeviceHealth | null = null
  /** "Is adb stuck?" (plan 88 §3.9, §4.7, fixes F21/F23) — null until the adb subsystem comes up (mirrors `health` above), stopped/cleared in `stop()`. Read-only: it never touches the adb server itself. */
  let adbHealthMonitor: AdbServerHealthMonitor | null = null
  let remoteSessions: RemoteSessionManager | null = null
  let tunnelRpc: TunnelRpc | null = null
  let webrtcRelayRef: ReturnType<typeof createWebRtcRelay> | null = null
  let retention: RetentionGc | null = null
let blobGc: BlobGc | null = null
  let recorder: EventRecorder | null = null
  let adbEndpointManager: AdbEndpointManager | null = null
  /** The one bounded adb CLI helper (plan 85 §3.4, §4.5) — `null` only before `start()` builds it and after `stop()` tears it down; `killAll()` is called from `stop()` below. */
  let hostAdb: HostAdb | null = null
  /**
   * The agent provisioner (plan 90 §3.8, §4.3) — `null` until it is built, just after `guestAgent`
   * (it needs `guestAgent.withGuestAgentClient`, the shared-session seam plan 44 §8b's "Bug 1" fix
   * established). Read through the forward-ref closure `createGuestAgentRoutes` is given above, the
   * same pattern `onAdmitted`/`rescan` already use for a dep assigned later in this same function.
   */
  let agentProvisionerRef: AgentProvisioner | null = null
  /**
   * Device preparation's runner (plan 106 §3.3, §3.5) — `null` until it is
   * built, right after `agentProvisioner` (same file, same reasoning: no
   * circular dependency of its own, but read through the SAME forward-ref
   * closure shape `onDeviceReady`/`agentProvisionerRef` already use, for
   * consistency and so a future reordering of this function cannot
   * silently resurrect §96.25's own race).
   */
  let preparationRunnerRef: PreparationRunner | null = null
  /**
   * The labelling service (plan 89 §4.6, §5 step 89.6) — `null` until it is
   * built, right after `guestAgent` (same reason `agentProvisionerRef`
   * above is: it needs `guestAgent.withGuestAgentClient`, never a second,
   * independent session bootstrap). Read through the SAME forward-ref
   * closure shape `onDeviceReady` already uses for `agentProvisionerRef`.
   */
  let labellingRef: LabellingService | null = null
  /** Device readiness (plan 43) — constructed once `leases` exists (below), used by every module below that reconciles or holds on it. */
  let readiness: ReadinessManager | null = null
  /** The command console's runner (plan 93 §4.5, §5 step 93.3) — constructed right after `leases`, since `admitMember`'s lease policy needs it. `stop()` drains it before `recorder` (its own `record` dep) is torn down. */
  let commandRunner: CommandRunner | null = null
  let stopScheduler: (() => void) | null = null
  /** The batch pacer's dynamic timer (plan 94 §3.8, §4.8, step 94.7) — cleared in `stop()` like every other periodic timer here (`00-overview.md` §7 item 7). */
  let stopPacer: (() => void) | null = null
  let stopReaper: (() => void) | null = null
  /** The co-control grant TTL reaper (plan 91 §4.2, §5 step 91.2) — stopped in `stop()` like every other periodic timer here (`00-overview.md` §7 item 7). */
  let stopCoControlReaper: (() => void) | null = null
  let stopExpiryReaper: (() => void) | null = null
  let stopScheduleRunner: (() => void) | null = null
  let dataDirLock: DataDirLock | null = null
  /** The 15s application-level `heartbeat` broadcast (plan 85 §3.6, §4.6, §5 85.7a) — cleared in `stop()` like every other periodic timer here. */
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null
  /**
   * The debounced `reprofile` pass (plan 92 §3.8 rule 2, §5 step 92.2) —
   * cleared in `stop()` like every other timer here, so a settings save made
   * just before shutdown never fires a restart against a torn-down
   * `sessions`.
   */
  let reprofileDebounceTimer: ReturnType<typeof setTimeout> | null = null
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
      //
      // `portCheck` (plan 85 §4.7, §5 85.6, fixes F14) — closes the gap the
      // field log showed directly: `taking over a stale lock from pid 19964
      // (no such process)` immediately followed by `Failed to start server.
      // Is port 7700 in use?`. Those two lines only look contradictory
      // because `process.kill(pid, 0)` (what makes a lock "stale") answers
      // "is that pid alive", never "is the port free" — this probes the
      // port too, at the moment the log was actively implying it was free.
      dataDirLock = acquireDataDirLock(cfg.dataDir, log, { host: cfg.host, port: cfg.port })

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

      // The shared adb server control (plan 88 §3.10, §4.8, fixes F19) — the
      // ONE function in the workspace that runs `kill-server` (spec §10.4).
      // Both the Toolchain Manager's version swap (wired into `toolchain`
      // immediately below) and the operator's Restart adb server button
      // (`tools/routes.ts`, mounted much further down) call THIS SAME
      // instance's `cycle()`, so the two share one mutex and can never
      // interleave.
      //
      // Every dependency below is a forward reference — the same pattern
      // `stopTracker`/`startTracker` already used for `registry` two lines
      // down. `sessions`, `leases`, `jobStore`, `host`, `reconnector`,
      // `reconciler` and `endpoints` do not exist yet at this point in
      // `start()`; `cycle()` itself is never CALLED until long after every
      // one of them does, because a version swap or a restart can only ever
      // be triggered by an HTTP request arriving after `start()` finishes.
      const adbServerControl: AdbServerControl = createAdbServerControl({
        getClient: () => adb,
        stopTracker: async () => {
          await registry?.stop()
        },
        startTracker: async () => {
          await registry?.start()
        },
        // F19: `drainSessions` was an unwired optional dep since M1 ("a
        // no-op in M1 — filled in by Plan 04"). Plan 04 shipped long ago;
        // the hook was never filled until now. Sessions and manual leases
        // are always drained; a running JOB is force-failed only when the
        // caller already decided to proceed despite it (`force` — see the
        // route's own `E_ADB_BUSY_FARM` guard, which runs BEFORE `cycle()`
        // is ever called).
        drainSessions: async ({ force }) => {
          const sessionsClosed = (await sessions?.closeAll('adb-server-restart')) ?? 0
          const leasesReleased = leases.releaseAll?.({ reason: 'adb-server-restart' }) ?? 0
          const jobsFailed: string[] = []
          if (force) {
            const running = jobStore.list({ status: 'running', limit: 1000 })
            for (const job of running.rows) {
              host.finishExternally(job.id, 'failed', 'the adb server restarted', 'ADB_SERVER_RESTARTED')
              jobsFailed.push(job.id)
            }
          }
          return { sessionsClosed, leasesReleased, jobsFailed }
        },
        // Reattach every remembered network address (plan 88 §3.2, §3.10) —
        // after a stop, adb's transport table is empty and it will not go
        // looking (F10); without this a 20-device OTG chassis would come
        // back as 20 offline rows. Bounded concurrency: dialling twenty
        // phones one at a time would blow well past "usually takes 5-15
        // seconds" (§3.10); dialling all twenty at once would hammer the
        // adb server the instant it comes back up.
        reattachEndpoints: async () => {
          if (!reconnector) return { attempted: 0, succeeded: 0, failed: [] }
          const reconnectorRef = reconnector
          const targets = endpoints.allWithEndpoints()
          const labelFor = (stableId: string): string =>
            db.select({ label: devices.label }).from(devices).where(eq(devices.stableId, stableId)).get()?.label ?? stableId
          let succeeded = 0
          const failed: Array<{ stableId: string; label: string }> = []
          const REATTACH_CONCURRENCY = 6
          const queue = [...targets]
          async function worker(): Promise<void> {
            for (;;) {
              const next = queue.shift()
              if (!next) return
              const outcome = await reconnectorRef
                .reconnect(next.stableId)
                .catch((err): { result: 'not-found' } => {
                  log.child('adb-server-control').warn(`reattach: ${next.stableId} threw, treating as not-found: ${String(err)}`)
                  return { result: 'not-found' }
                })
              if (outcome.result === 'connected' || outcome.result === 'already-connected') succeeded += 1
              else failed.push({ stableId: next.stableId, label: labelFor(next.stableId) })
            }
          }
          await Promise.all(Array.from({ length: Math.min(REATTACH_CONCURRENCY, targets.length) }, () => worker()))
          return { attempted: targets.length, succeeded, failed }
        },
        reconcileOnce: async () => {
          await reconciler?.runOnce()
        },
        onPhase: (phase, reason, detail) => hub.broadcast({ type: 'adb.server.phase', payload: { phase, reason, detail } }),
        log: log.child('adb-server-control'),
        // `adbControl.drainTimeoutMs` (plan 88 §4.2, promoted to a real
        // setting in step 88.9) — a forward reference to `settingsStore`,
        // declared a few lines below this object literal but only ever READ
        // once a request actually calls `cycle()`, long after `start()` has
        // finished building it. Same pattern as `registry`/`sessions`/etc.
        // elsewhere in this function, just against a `const` rather than a
        // nullable `let` — read fresh on every call, never captured.
        drainTimeoutMs: () => settingsStore.get().adbControl.drainTimeoutMs,
      })

      const toolchain = new ToolchainManager({
        dataDir: cfg.dataDir,
        coreVersion: CORE_VERSION,
        store: createToolInstallStore(db),
        emit: (ev) => hub.broadcast(toolchainEventToMessage(ev)),
        onLog: (level, msg) => log.child('toolchain')[level](msg),
        remoteManifestUrl: process.env.ENKAKU_TOOLS_MANIFEST_URL,
        adbSwapHook: createAdbSwapCoordinator(adbServerControl),
      })
      await toolchain.init() // layout + manifest cache + reconcile (adopt pre-baked)

      // Resolved here, ahead of the farm settings store, ONLY because that
      // store needs it for the plan 26 §3.2 server-mode `shell.mode: 'off'`
      // default (a brand-new row only — see the comment there). Everything
      // else that used to read `authMode` below still does; this does not
      // move that logic, just the one function call it was already making.
      const authMode = resolveAuthMode(cfg)
      const settingsStore = createFarmSettingsStore(db, { authMode })

      // The address book (plan 88 §3.2, §4.3, fixes F10) — read-only about
      // adb itself, so it can be built here, well before the adb subsystem
      // exists: `observe`/`declare`/`candidates` only ever touch `db` and
      // `settingsStore`. Passed into `createDeviceRegistry` below (its
      // successful-probe path calls `endpoints.observe`) and into
      // `adbServerControl`'s `reattachEndpoints` above (via forward ref).
      const endpoints: EndpointStore = createEndpointStore({
        db,
        settings: () => settingsStore.get().discovery,
      })

      // The ONE bounded adb CLI helper (plan 85 §3.4, §4.5, fixes F11/F12) —
      // built here, unconditionally, before `adb` exists, mirroring every
      // other "adb might not be ready yet" dep in this function
      // (`guestAgentHostAdb`/`transferService` used to have their own
      // separate copies of this same lazy-read pattern; `hostAdb` below
      // replaces every one of them). `binaryPath` reads the outer `adb`
      // variable fresh on every call, so a request that arrives before adb
      // is up gets a correctly-coded `E_ADB_UNAVAILABLE` refusal instead of
      // spawning against an undefined path. `killAll()` is called from
      // `stop()` below — nothing this instance spawns can outlive the core.
      //
      // `hostAdbHandle` is a narrowed, non-nullable const alias — the same
      // `adbClient = adb` trick used further down this function — so every
      // closure below (`guestAgent`, `makeScrcpy`, `makeInspector`) can call
      // `.run`/`.spawnLongLived` without TS widening it back to `HostAdb |
      // null` just because the outer `let hostAdb` is also reassigned in
      // `stop()`.
      const hostAdbHandle = createHostAdb({
        binaryPath: () => {
          if (!adb) throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
          return adb.binaryPath
        },
        settings: () => settingsStore.get().adb,
        onLog: (level, msg) => log.child('host-adb')[level](msg),
      })
      hostAdb = hostAdbHandle

      // adb concurrency and health diagnostics (plan 23 §4.3, §4.6). Created
      // here (rather than inside the try-block below, once `adb` exists)
      // because `/api/adb/stats` is mounted in step 4, before adb is up.
      const adbMetrics = createAdbMetricsStore()
      let lastLoggedAdbConcurrency: number | null = null
      let lastLoggedAdbStreams: number | null = null
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
        // The streaming lane's budget (plan 24 §3.2, §4.2; auto-scaled by
        // plan 85 §3.1, §4.2) — a completely separate field from
        // `maxConcurrent` above, applied here because this is already
        // "whenever adb.maxConcurrent-shaped settings change, push them
        // onto the live client". Same "a non-zero setting always wins" rule
        // and "log only when the effective value changes" discipline as the
        // `maxConcurrent` branch above, and the same non-offline device
        // count.
        const streamsTarget = cfg.maxStreams > 0 ? cfg.maxStreams : computeAutoStreams(nonOfflineCount)
        adb.setStreamLimits(cfg.maxStreamsPerDevice, streamsTarget)
        if (streamsTarget !== lastLoggedAdbStreams) {
          lastLoggedAdbStreams = streamsTarget
          log
            .child('adb')
            .info(
              cfg.maxStreams > 0
                ? `stream budget pinned to ${streamsTarget} by adb.maxStreams`
                : `stream budget auto-scaled to ${streamsTarget} (${nonOfflineCount} non-offline devices)`,
            )
        }
      }
      settingsStore.onChange(() => recomputeAdbConcurrency())

      /**
       * plan 92 §3.8 rule 2, §5 step 92.2 — "changing a video setting must
       * change the picture, or it is a lie" (F5, F6, F17). `settingsStore.onChange`
       * fires on EVERY farm settings PATCH, not only a video one, and can fire
       * several times in a row as an operator edits a form field by field
       * (`resolve.ts`'s per-field PATCH pattern, `SchemaForm`). Restarting a
       * farm's video on every one of those would be worse than not honouring
       * the setting at all (§3.8's own words) — so this waits 500ms after the
       * LAST change before running one pass, the same order of magnitude as
       * every other "settle, then act" debounce in this codebase (plan 42's
       * `enforceIdleCap` is deliberately immediate instead, because closing an
       * idle session has no user-visible interruption risk; a video restart
       * does, which is exactly why THIS one debounces and that one does not).
       * `reprofile` itself is a no-op for a device that turns out not to need
       * restarting (rule 1) or is `busy` (rule 4), so debouncing only changes
       * how OFTEN the farm re-checks, never what it does once it checks.
       */
      const VIDEO_REPROFILE_DEBOUNCE_MS = 500
      const scheduleReprofile = (reason: string) => {
        if (reprofileDebounceTimer) clearTimeout(reprofileDebounceTimer)
        reprofileDebounceTimer = setTimeout(() => {
          reprofileDebounceTimer = null
          const pending = sessions?.reprofile?.(reason)
          if (!pending) return
          void pending
            .then((result) => {
              log
                .child('session')
                .info(
                  `reprofile (${reason}): ${result.restarted.length} restarted, ${result.skippedBusy.length} skipped busy (running a job), ${result.unchanged} unchanged`,
                )
            })
            .catch((err) => log.child('session').warn(`reprofile (${reason}) failed: ${String(err)}`))
        }, VIDEO_REPROFILE_DEBOUNCE_MS)
      }
      settingsStore.onChange(() => scheduleReprofile('farm video settings changed'))

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
      // Same forward-ref pattern: an open recording (plan 94 §4.6) must not
      // outlive the manual lease it was made under either — an explicit
      // `lease.release`/WS disconnect already call `deps.recording?.stopForLeaseLost`
      // inline in `ws-handlers.ts`; this covers the automatic paths (idle
      // timeout, quarantine, a takeover) handled below in `onManualRevoked`/
      // `onManualTakenOver`, which fire before the WS router exists. Without
      // this, a recording started under one holder keeps capturing whatever
      // the NEXT holder does after an automatic revoke, with no record of
      // where the handover happened.
      let stopRecordingForLeaseLost: ((deviceId: string) => void) | null = null
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
      // Same forward-ref pattern: a job finishing must re-resolve any mirror
      // group the job's device was skipped from (plan 91 §3.9, §4.7, §5 step
      // 91.7) — F27's re-admit, most notably: an `internal:install` job
      // ending is what lets that device rejoin a mirror it was `skipped:
      // installing` from. `host`'s `onJobFinished` (below) fires long before
      // `attachWsRouter` — the mirror manager it needs to re-resolve against
      // lives inside the WS router — ever runs.
      let reconcileMirrorForDevice: ((deviceId: string) => void) | null = null
      // Same forward-ref pattern: `/api/adb/stats`'s `transport` block (plan
      // 85 §3.6, §4.6) lives on the WS router's own connection bookkeeping,
      // but `createAdbStatsRoutes` is built (below, in step 4) before
      // `attachWsRouter` ever runs.
      let transportStats: (() => TransportSnapshot) | null = null
      // Same forward-ref pattern: `/api/adb/stats`'s `input` block (plan 91
      // §4.10, §5 step 91.10) lives on the WS router's own arbiter/mirror/
      // co-control bookkeeping, but `createAdbStatsRoutes` is built (below,
      // in step 4) before `attachWsRouter` ever runs.
      let inputStats: (() => InputStatsBlock) | null = null
      // Same forward-ref pattern: the command runner (plan 93 §3.17, §4.5,
      // §5 step 93.4) is constructed right after `leases`, well before
      // `attachWsRouter` runs — but its `broadcast` dep needs
      // `commandTargets(runId)`'s subscriber bookkeeping, which lives on the
      // WS router's own connection state. Resolved once `attachWsRouter`
      // runs, same as `transportStats`/`inputStats` immediately above.
      let broadcastCommandEvent: ((runId: string, msg: CommandRunnerEvent) => void) | null = null
      // Same forward-ref pattern (plan 93 §4.6, §5 step 93.9 — closes F27):
      // `transferBroadcast` (below, in step 3) is constructed well before
      // `attachWsRouter` runs, but scoping `transfer.progress`/`transfer.done`
      // to viewers of the device (matching `shell.result`) needs
      // `deviceTargets(deviceId)`'s connection bookkeeping, which lives on
      // the WS router. Resolved once `attachWsRouter` runs, same as
      // `broadcastCommandEvent` immediately above.
      let broadcastTransferEvent: ((deviceId: string, msg: ServerMessage) => void) | null = null
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
      // Subscriber-scoped (plan 93 §4.6, §5 step 93.9 — closes F27) — the
      // forward-ref into `ws-handlers.ts`'s `deviceTargets(deviceId)`/
      // `broadcastTransfer`, resolved once `attachWsRouter` runs (the SAME
      // pattern `broadcastCommandEvent` above uses). Never `hub.broadcast`:
      // a farm-wide broadcast put every open tab on every device's progress
      // ticks, both a wire-cost bug and a privacy one at 100 devices. Falls
      // back to a debug log before `attachWsRouter` has run.
      //
      // `transferRegistry` (plan 107 §3.1, §3.4, §5 step 107.2) is fed from
      // THIS one object, not threaded through `runTransfer`'s nine call
      // sites — see `device/transfer-registry.ts`'s own doc comment for why
      // that is deliberate. `GET /api/transfers` (below, `transferRegistryRoutes`)
      // is what makes the transfer plan 107 §3.1 found undiscoverable (G2)
      // discoverable from cold.
      const transferRegistry = createTransferRegistry()
      const transferBroadcast: TransferBroadcast = {
        // `origin` (plan 106 §5 step 106.8) is forwarded only to the registry
        // (`GET /api/transfers`, farm-wide, polled) — NEVER onto the WS
        // payload below, which stays byte-for-byte the same shape it always
        // was. F27 (transfer events scoped to viewers of the device) governs
        // that live per-chunk channel, not this snapshot list, so this is not
        // a widening of it.
        progress: (deviceId, transferId, kind, sent, total, origin) => {
          transferRegistry.progress(deviceId, transferId, kind, sent, total, origin)
          return (
            broadcastTransferEvent?.(deviceId, { type: 'transfer.progress', payload: { deviceId, transferId, kind, sent, total } }) ??
            log.child('transfer').debug(`transfer.progress dropped for ${deviceId} — attachWsRouter has not run yet`)
          )
        },
        done: (deviceId, transferId, kind, ok, error, result, origin) => {
          transferRegistry.done(deviceId, transferId, kind, ok, error, origin)
          return (
            broadcastTransferEvent?.(deviceId, {
              type: 'transfer.done',
              payload: { deviceId, transferId, kind, ok, ...(error !== undefined ? { error } : {}), ...(result !== undefined ? { result } : {}) },
            }) ?? log.child('transfer').debug(`transfer.done dropped for ${deviceId} — attachWsRouter has not run yet`)
          )
        },
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
            op: (transferId, onProgress) =>
              transferService.push(deviceId, opts.artifactId, opts.remotePath, { transferId, onProgress, mediaScan: opts.mediaScan }),
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
      // Plan 93 §4.6, §5 step 93.9 — near-copies of `internal:install`,
      // registered beside it so a batch push/pull reuses the SAME
      // concurrency/ordering/reporting/cancel machinery with no new
      // orchestration.
      executors.register('internal:push', createPushExecutor({ transfer: transferService, broadcast: transferBroadcast }))
      executors.register('internal:pull', createPullExecutor({ transfer: transferService, broadcast: transferBroadcast }))

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
      // Plan 91 §4.2, §5 step 91.2 — same forward-ref pattern as `leaseManager`
      // just above: `createLeaseManager`'s own `onPrimaryEnded` hook (below)
      // needs to call into the co-control grant store, but that store is not
      // constructed until right after `leases` itself is (it reads `leases`
      // back via `leases.getLease`), which is a few hundred lines further
      // down this same function. Read fresh, so the wiring is correct the
      // instant both sides exist, in either construction order.
      let coControlRef: CoControlManager | null = null
      // Plan 94 §3.8, §4.8, step 94.7 — same forward-ref pattern as
      // `leaseManager`/`coControlRef` above: `onBatchChanged` (below) needs
      // to call into the pacer, which is not constructed until right after
      // `scheduler` itself is, a few hundred lines further down this same
      // function (it needs `scheduler.kick`).
      let pacerRef: BatchPacer | null = null
      // A batch member job reached a terminal state (or was cancelled while
      // queued) → recompute the batch's cached status and broadcast it
      // (plan 20 §3.5, §4.5). One function, called from every place a job
      // can leave the queue. `deviceId` (plan 94 §3.8, §4.8, step 94.7) is
      // the ONE hook into the pacer (F32) — see `onBatchChanged`'s own
      // `ExecutorHostDeps` comment for exactly which callers pass it.
      const onBatchChanged = (batchId: string, deviceId?: string) =>
        recomputeBatchStatus({ db, jobStore, broadcast: (msg) => hub.broadcast(msg), pacer: pacerRef ?? undefined }, batchId, deviceId)
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
          // F27's re-admit (plan 91 §3.9, §4.7, §5 step 91.7): a device
          // running `internal:install` is `skipped: installing` in every
          // mirror group that requested it — this is what lets it rejoin on
          // its own the instant that job (or any other) settles, with no
          // client asking. A harmless no-op for a device that belongs to no
          // group, or before `attachWsRouter` has run.
          reconcileMirrorForDevice?.(deviceId)
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
        // Plan 97 §3.4, §4.5, §5 step 97.4 — `job.maxResultBytes`, read fresh
        // per settle, the same "read fresh" pattern `timeoutIsInfra`/
        // `rebindOnInfra` just above already use. Without this the default
        // (65_536, `RESULT_LIMITS.defaultMaxResultBytes`) is still correct
        // out of the box (97.3's own note) but not live-tunable from Studio.
        maxResultBytes: () => settingsStore.get().job.maxResultBytes,
        // `scripts.result_schema` has no producer yet — publish-time storage
        // and serving are plan 97 step 97.2's own remaining items, out of
        // this file's `packages/core/src/scripts/**` reach — so this always
        // answers `[]` today, the exact fallback `ExecutorHostDeps.resultSummaryFields`
        // already uses when left unwired. Wired anyway rather than left
        // absent, so the seam is explicit and goes live the moment that
        // producer lands, with no second daemon.ts edit required.
        resultSummaryFields: () => [],
        // Plan 97 §3.7, §4.6, §5 step 97.7 — the ONLY thing this does is
        // broadcast; `ExecutorHost.progress` already did the size check and
        // the one-warn-per-job rule before ever calling this. No DB write
        // anywhere on this path (§3.7 — progress is live state, not
        // history).
        onProgress: (jobId, deviceId, value) => hub.broadcast({ type: 'job.progress', payload: { jobId, deviceId, value } }),
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
          // Nor does an open recording (plan 94 §4.6) — an automatic
          // revocation (idle timeout, quarantine) must end it exactly like
          // `lease.release`/WS-close already do inline in `ws-handlers.ts`;
          // otherwise it keeps capturing whatever the NEXT holder does,
          // with no record of where the handover happened.
          stopRecordingForLeaseLost?.(deviceId)
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
          // Nor does an open recording (plan 94 §4.6) survive a takeover —
          // the displaced holder's in-progress recording must not go on
          // capturing the NEW holder's actions (see `onManualRevoked` above
          // for why this matters).
          stopRecordingForLeaseLost?.(deviceId)
          adbEndpointManager?.close(deviceId, 'taken-over')
          // An agent whose lease was taken over does NOT get pushed a
          // notification here (plan 71 §3.5, §3.6): its next attempt to use
          // the device detects the loss itself (`agent/loop/run.ts`'s
          // `ensureControlLease` re-checks the real lease on every step) and
          // reports it as an error `tool_result` — the same "the loop
          // discovers it, nothing pushes it" shape plan 63's `invoke()` uses
          // for every other refusal.
          //
          // Plan 91 §3.2, §4.2 — a takeover never calls `release()` (it is
          // an atomic revoke-then-acquire, `lease-manager.ts`'s own comment
          // on this branch explains why), so it is the one way a manual
          // hold can end that the `onPrimaryEnded` hook below never sees.
          // Called directly here instead: any grant that was subordinate to
          // the DISPLACED holder must not survive them being displaced.
          coControlRef?.onPrimaryEnded(deviceId)
        },
        onDeviceFreed: () => scheduler?.kick(),
        // Plan 91 §3.2, §4.2, §5 step 91.2 — a co-control grant "may only
        // exist while somebody else holds the device"; this is the single
        // wiring point that keeps that true for every OTHER way a manual or
        // job hold can end (voluntary release, idle timeout, disconnect,
        // quarantine, adb-server-restart, and `clearJobLease`) — fired
        // unconditionally from inside `lease-manager.ts`'s own `release()`
        // and `clearJobLease()`, regardless of whether a `reason` was given
        // (unlike `onManualRevoked` above, which stays silent on a plain
        // voluntary release because that hook's job is different: telling
        // the ex-holder something was taken from them, not asking).
        onPrimaryEnded: (deviceId) => coControlRef?.onPrimaryEnded(deviceId),
      })
      leaseManager = leases

      // The command console's runner (plan 93 §3.5-§3.8, §4.5, §5 step 93.3)
      // — built right here, immediately after `leases`, because `admitMember`'s
      // lease policy needs a live `LeaseManager` and nothing else below this
      // point does. `sweepOrphans()` is called right away, one line down:
      // the same boot-recovery phase ("3. Queue / lease / scheduler", above)
      // `jobStore.failOrphanRunning()` already opened for jobs — a command
      // run left `running`/`awaiting-continue` by a previous process's crash
      // is exactly the same kind of orphan (plan 93 §3.7, mirroring F29), it
      // is just discovered one step later in this file because it needs a
      // lease manager to exist first and `jobStore`'s own sweep does not.
      const commandRunStore = createCommandRunStore(db)
      // The SAME local-vs-remote decision `ws-handlers.ts`'s own (module-
      // private, unexported) `shellPortFor` makes (plan 25 §3.4, §4.3),
      // duplicated here rather than imported because that closure cannot be
      // imported and `ws-handlers.ts` is held by a concurrent worker this
      // step must not touch (plan 93 step 93.3's own brief). Reads
      // `adb`/`remoteSessions`/`tunnelRpc`/`tunnelRouter` fresh on every
      // call — the same forward-ref pattern `adbEndpointManager` above
      // already relies on (none of the four is assigned yet at the point
      // this closure is BUILT; only at the point it is CALLED, well after
      // `start()` finishes booting).
      const commandShellPortFor = (deviceId: string): ShellPort => {
        const remoteNode = remoteSessions?.nodeIdFor(deviceId) ?? null
        if (remoteNode) {
          if (!tunnelRpc || !tunnelRouter) {
            throw new EnkakuError('node_offline', 'the node that owns this device is currently disconnected')
          }
          return createRemoteShellPort({ rpc: tunnelRpc, router: tunnelRouter, deviceId })
        }
        if (!adb) throw new EnkakuError('E_ADB_UNAVAILABLE', 'the adb subsystem is not ready')
        const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
        if (!row) throw new EnkakuError('device_not_found', 'no such device')
        return createLocalShellPort({ client: adb, serial: row.serial })
      }
      commandRunner = createCommandRunner({
        db,
        store: commandRunStore,
        leases,
        shellPortFor: commandShellPortFor,
        resolve: (target) => resolveCommandTarget(db, target),
        settings: () => settingsStore.get().shell,
        recorder: (e) => recorder?.record(e),
        audit,
        // Subscriber-scoped (plan 93 §3.17, §4.3, F27, step 93.4) — the
        // forward-ref into `ws-handlers.ts`'s `commandTargets(runId)`/
        // `broadcastCommand`, resolved once `attachWsRouter` runs (same
        // pattern `transportStats`/`inputStats` above use). Never
        // `hub.broadcast`: a fleet command's output must not reach every
        // open tab — `transfer.progress`/`transfer.done` (F27) got the same
        // fix, below, in step 93.9. Falls back to a debug log before
        // `attachWsRouter` has run (boot's own `sweepOrphans()` call below
        // never broadcasts, so this only matters if something else calls
        // `start()` implausibly early).
        broadcast: (runId, msg) =>
          broadcastCommandEvent?.(runId, msg) ?? log.child('command-console').debug(`command run event (WS router not attached yet): ${runId} ${msg.type}`),
        // Same role-resolution expression the WS router below builds for its
        // own `roleOf` dep (plan 26 §4.1, §4.3) — local mode's one implicit
        // admin ignores the userId entirely.
        roleOf: authMode === 'local' ? () => 'admin' : (userId) => (userId ? (auth.listUsers().find((u) => u.id === userId)?.role ?? 'operator') : 'operator'),
        // `canUseDevice` (plan 34 §3.5, §4.4) — the SAME device-ownership
        // lookup every other ownership gate in this file already shares.
        getDevice: getDeviceOwner,
        log: log.child('command-console'),
      })
      const orphanedCommandRuns = commandRunner.sweepOrphans()
      if (orphanedCommandRuns > 0) {
        log.warn(`recovery boot: ${orphanedCommandRuns} command run(s) orphaned by the previous process, marked cancelled`)
      }

      // The co-control grant store (plan 91 §3.2, §4.2, §5 step 91.2) — the
      // subordinate, short-lived authorisation that lets a second party
      // touch a device someone/something else already holds, without ever
      // moving the hold itself. Built right after `leases`, which it only
      // ever READS (`leases.getLease`, to snapshot the primary holder a new
      // grant is subordinate to) — it never acquires, releases, or otherwise
      // mutates a lease. `resolveLeaseLabel` is the SAME resolver `leases`
      // itself uses (built above, before `leases`), so an assisting
      // operator's label and a lease holder's label are worded identically
      // for the same id, never two different phrases for one person.
      const coControl = createCoControlManager({
        leases,
        config: {
          grantTtlSec: () => settingsStore.get().coControl.grantTtlSec,
          maxConcurrentPerDevice: () => settingsStore.get().coControl.maxConcurrentPerDevice,
          mode: () => settingsStore.get().coControl.mode,
        },
        log: log.child('co-control'),
        resolveLabel: resolveLeaseLabel,
        // Plan 91 §3.4 item 4, §4.2, §5 step 91.4 — "everyone else sees it":
        // every viewer of a device needs to know who is assisting it, live,
        // with no polling (F25), the exact broadcast shape `lease.changed`
        // already gets from `onManualRevoked`/`onManualTakenOver` above.
        // Wired HERE, at construction (through `hub.broadcast`, already in
        // scope at this point in boot), rather than only inside
        // `assist.start`/`assist.stop` in `ws-handlers.ts`, so EVERY
        // termination path broadcasts — TTL expiry, a WS disconnect
        // (`releaseAllForClient`), the primary hold ending
        // (`onPrimaryEnded`) — not only the two explicit WS messages.
        // `coControlRef` (not `coControl`) is used inside the closures
        // because `onGranted`/`onReleased` are never invoked synchronously
        // during this very construction call — only later, once `grant()`/
        // `release()` run — by which time `coControlRef` below has already
        // been assigned, the same forward-ref safety `onManualTakenOver`
        // above already relies on for the same variable.
        onGranted: (grant) =>
          hub.broadcast({ type: 'assist.changed', payload: { deviceId: grant.deviceId, assistedBy: coControlRef?.assistedBy(grant.deviceId) ?? [] } }),
        onReleased: (grant) =>
          hub.broadcast({ type: 'assist.changed', payload: { deviceId: grant.deviceId, assistedBy: coControlRef?.assistedBy(grant.deviceId) ?? [] } }),
      })
      coControlRef = coControl

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
        // Best-effort clear of a device's physical label before its row is
        // deleted (plan 89 §3.7 point 4, §5 step 89.9) — same forward-ref
        // pattern as `revertNetwork` just above: `labellingRef` is not
        // assigned until the labelling service is built, later in this same
        // boot path, so this closure reads it lazily rather than capturing
        // `null`. `restoreOriginal: false` — forget/block are not "turn
        // labelling off", they are the device leaving the farm entirely, so
        // there is no operator decision here to restore vs. leave the
        // system default; the label is simply gone with the device.
        clearLabel: (deviceId, actor) =>
          labellingRef?.clear(deviceId, { restoreOriginal: false, actor }).then(() => undefined) ?? Promise.resolve(),
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

      // Plan 94 §3.8, §4.8, step 94.7 — needs `scheduler.kick`, so built
      // right after it, same as `host` above needs it. Populates the
      // forward-ref `pacerRef` `onBatchChanged` (above) already closes over.
      const pacer = createBatchPacer({ db, scheduler, log: log.child('pacer') })
      pacerRef = pacer

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
        // Plan 98 §3.7, §3.8, §4.1, §4.6, §4.7, steps 98.5/98.7 — the same
        // accessor `createBatchRoutes`'s own `farmJobSettings` below reads,
        // so a single job's `runtimeOverride` ceiling check binds against
        // the farm's REAL `job` settings, not the built-in "no ceiling"
        // default `resolveJobRuntime` falls back to when this is absent.
        farmJobSettings: () => settingsStore.get().job,
        // Plan 93 §3.12, §4.6, step 93.8 — closes F10's "POST /api/jobs
        // checks no permission at all": `internal:install`'s declared
        // `requires` gate is now evaluated against the farm's REAL
        // `shell.mode`/`transfer.enabled`, the same live accessors
        // `api/transfer.ts`'s own REST install/push/pull already read.
        shellMode: () => settingsStore.get().shell.mode,
        transferEnabled: () => settingsStore.get().transfer.enabled,
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
        // Plan 93 §3.12, §4.6, step 93.8 — no `actorRole`: a schedule firing
        // at cron time has no interactive actor (the same reasoning
        // `schedules/runner.ts`'s own `assertDeviceAllowed`/`canCancelJob`
        // omissions already state at this exact call site — "farm-wide
        // authority to fire a schedule at all"), so the ROLE half of
        // `JobExecutor.requires` is not evaluated here. `shellMode`/
        // `transferEnabled` still are: a farm switch binds regardless of who
        // (or what clock) triggered the dispatch.
        validateScript: (scriptId, params) =>
          validateScriptForRun(
            { registry: executors, findScript, shellMode: () => settingsStore.get().shell.mode, transferEnabled: () => settingsStore.get().transfer.enabled },
            scriptId,
            params,
          ),
        agentDispatch: scheduleAgentDispatch,
        scheduledAgentCeilings: () => settingsStore.get().scheduledAgents,
        notifySystem: (input) => {
          notifyAndBroadcast({ level: input.level, title: input.title, body: input.body ?? null, context: input.context ?? null, source: 'system' })
        },
        // Plan 82 §3.3, §3.5 — a schedule refuses a dev-only target (criterion 18) and resolves
        // a plugin's `@latest` to its ACTIVE version, not merely the highest published semver.
        registry: scriptRegistry,
        // Plan 94 §3.9, §4.9, step 94.8 — `onOverlap: 'cancel-previous'`'s
        // abort path for a running member, the SAME instance `batchRoutes`
        // gets (no second one — `stopBatch`'s own "no second abort path").
        jobService,
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
      // `transferService` already use, for the same reason. `exec` reads the
      // outer `adb` variable fresh on every call rather than capturing it
      // now, so a request that arrives before adb is up gets a
      // correctly-coded refusal instead of a route that does not exist.
      // `hostAdb` is the ONE shared bounded helper built above (plan 85
      // §3.4, §4.5) — this used to be its own third inline copy of the
      // undrained-stderr, no-timeout, no-bound F11 defect.
      const guestAgentExec = async (serial: string, cmd: string): Promise<ShellResult> => {
        if (!adb) throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
        // The whole result, not just `.stdout`: the launcher decides whether
        // the agent is installed from the exit code, and reads `am start`'s
        // failure off stderr (plan 53).
        return adb.exec(serial, cmd, { profile: 'appLifecycle' })
      }
      const guestAgent = createGuestAgentRoutes({
        db,
        hostAdb: hostAdbHandle.run,
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
        // Plan 90 §3.7, §4.4 — the residual gap 90.4's own status note flagged: `maxRecoveryCyclesPerHour`/
        // `recoveryRearmSec` are fully wired inside `guest-agent.ts` (proven by that step's own tests),
        // but until THIS line existed an operator changing them in Studio had no effect on a running
        // core — the getter fell back to the schema's own defaults regardless of what was saved.
        guestAgentSettings: () => settingsStore.get().guestAgent,
        // Plan 90 §3.8, §4.7 — the "on demand, single device" provisioning hook: forward-ref, same
        // pattern as `onAdmitted`/`rescan` elsewhere in this function, because `agentProvisioner`
        // (built just below, since IT needs `guestAgent.withGuestAgentClient`) does not exist yet at
        // this point in boot.
        agentProvisioner: {
          ensure: (deviceId, opts) => agentProvisionerRef?.ensure(deviceId, opts) ?? Promise.resolve(undefined),
          // docs/plans/96-m61-hotfixes.md's Gap 2 fix — GET /:id/guest-agent's producer. Falls back
          // to the schema's own "never provisioned" default in the same vanishingly short window
          // `ensure` above already tolerates (between `guestAgent` and `agentProvisionerRef` being set).
          status: (deviceId) => agentProvisionerRef?.status(deviceId) ?? Promise.resolve(DEFAULT_AGENT_STATUS),
          // The same fix's own necessary follow-on — DELETE clears the persisted row too.
          remove: (deviceId, actor) => agentProvisionerRef?.remove(deviceId, actor) ?? Promise.resolve(undefined),
        },
      })
      handleNetworkDeviceOffline = guestAgent.handleDeviceOffline
      restoreNetworkRoute = guestAgent.restoreDeviceRoute
      // An operator removing a device now hands the phone its network back
      // (plan 56 §3.6). Deliberate acts only: a core that crashes or goes
      // quiet still leaves the tunnel held closed by the device's own
      // dead-man's switch, which nothing here touches.
      revertNetworkForRemoval = guestAgent.revertNetwork

      // The agent provisioner (plan 90 §3.8, §4.3) — built right after
      // `guestAgent`, since `hello` reuses the EXACT same per-device session
      // a network route already owns (`guestAgent.withGuestAgentClient`,
      // plan 44 §8b's "Bug 1" fix), never a second, independent bootstrap
      // that would rotate a live route's token out from under it.
      const agentProvisioner = createAgentProvisioner({
        db,
        exec: guestAgentExec,
        hostAdb: hostAdbHandle.run,
        apkPath: () =>
          resolveGuestAgentApkPath({
            toolchain,
            onLog: (level, msg) => log.child('agent-provisioner')[level](msg),
          }),
        expectedArtifact: () => toolchain.deviceArtifactExpectation('guest-agent'),
        hello: (deviceId) => guestAgent.withGuestAgentClient(deviceId, (client) => client.hello()),
        provision: () => settingsStore.get().guestAgent.provision,
        record: recorder!.record,
        log: log.child('agent-provisioner'),
      })
      agentProvisionerRef = agentProvisioner
      // 96.25 fix 1 (docs/plans/96-m61-hotfixes.md §96.25): the boot-time
      // `ensureAll()` sweep used to fire right here — but `agentProvisioner`
      // is built well BEFORE `adb` (below, inside the try-block that ends
      // with "adb subsystem ready") is ever assigned, so every device this
      // sweep touched got `E_ADB_UNAVAILABLE` from `guestAgentExec`/
      // `hostAdbHandle`'s own null-check — a core-side race, not a device
      // fault, that used to burn a slot of the device's bounded retry
      // budget before the adb subsystem had even come up. The sweep itself
      // now runs later, right after `adbState = 'ready'` is logged, below.

      // Device preparation's runner and registry (plan 106 §3.2, §3.3, §4)
      // — built right after `agentProvisioner`, with no circular dependency
      // of its own (unlike `agentProvisioner`, no component registered here
      // needs a live guest-agent session). `preparationExec` mirrors
      // `guestAgentExec` exactly — same `E_ADB_UNAVAILABLE` contract, same
      // §96.25 fix 2 reasoning: a core-side "adb isn't ready" must be
      // rethrown so the runner can defer the whole pass rather than score
      // it as a device failure — but with `profile: 'default'`, matching
      // the SAME profile a real ui-server session's own exec already uses
      // (`makeScrcpy`'s sibling inspector wiring, a few hundred lines below).
      const preparationExec = async (serial: string, cmd: string): Promise<ShellResult> => {
        if (!adb) throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
        return adb.exec(serial, cmd, { profile: 'default' })
      }
      // Plan 106 §5 step 106.8 (§9 Q5's own recommendation, built): routes
      // the ui-server app/test APK installs through the SAME transfer
      // machinery `POST /api/devices/:id/install` uses (`runTransfer`, G6),
      // in place of one opaque `hostAdb install` call with nothing reported
      // until it resolves — the owner's own failing phone sat on that call
      // for 45.2s with zero progress. `transferService`/`transferBroadcast`/
      // `readinessHoldForTransfer` are the SAME instances the script API and
      // `internal:install` already share (built earlier in this function) —
      // no second transfer path. `origin: 'preparation'` (plan 106 §5 step
      // 106.8, plan 107 §3.5) marks the resulting `GET /api/transfers` row
      // distinctly from an operator's own install, so `OperationTray` labels
      // it "Device preparation — Install apk" instead of a bare "Install
      // apk" (`toTransferOperation`, `packages/studio/src/lib/operations.ts`).
      // The guest agent's OWN install is deliberately NOT converted this
      // pass — see `agent-provisioner.ts`'s own comment, just above its
      // `install()` call inside `runOnePass`, and plan 106 §9 Q5 for the
      // stated reason.
      //
      // `preparationInstallSem` (plan 106 §5 step 106.8, H2 re-examined): the
      // OLD `hostAdb(['install', ...], { lane: 'install' })` path this
      // replaces was bounded by `adb.maxInstallConcurrent` — `host-adb.ts`'s
      // own `installSem`. `TransferService.installFromLocalApk`'s streaming
      // lane (`AdbBackend.openRaw`/`execStream`) has NO comparable farm-wide
      // cap of its own (verified by reading `packages/adb/src/client.ts`:
      // `openRaw` bypasses every lane/semaphore entirely, by design, so a
      // single push never queues behind video/input — see its own doc
      // comment). Silently losing the pre-existing bound would reopen
      // exactly the "twenty phones, one install storm" failure mode §3.3
      // names, on a NEW, unattended code path (the boot sweep / admission
      // hook) an operator did not choose to fire. This semaphore restores
      // the SAME bound, read from the SAME `adb.maxInstallConcurrent`
      // setting `host-adb.ts` already uses (so there is one farm-wide knob
      // for "how many installs at once," not two to keep in sync), resized
      // lazily on every acquire exactly like `host-adb.ts`'s own
      // `syncLimits()`. Deliberately scoped to PREPARATION installs only —
      // an operator's own `POST /:id/install`/`internal:install` already had
      // no comparable cap on this lane before this step and still does not;
      // widening that is a separate, pre-existing condition this step does
      // not take on (plan 106 §9 Q5's own status note names it explicitly).
      const preparationInstallSem = new Semaphore(Math.max(1, settingsStore.get().adb.maxInstallConcurrent))
      const preparationInstallApk = (deviceId: string, localPath: string, label: 'app' | 'test'): Promise<void> => {
        const wanted = Math.max(1, settingsStore.get().adb.maxInstallConcurrent)
        if (wanted !== preparationInstallSem.max) preparationInstallSem.resize(wanted)
        return preparationInstallSem.acquire().then((release) =>
          runTransfer({
            transfer: transferService,
            broadcast: transferBroadcast,
            deviceId,
            kind: 'install',
            origin: 'preparation',
            holdFor: readinessHoldForTransfer,
            op: (transferId, onProgress) => transferService.installFromLocalApk(deviceId, localPath, { transferId, onProgress }),
          })
            .then(() => {
              log.child('preparation').debug(`ui-server ${label} apk installed on device ${deviceId} via the transfer machinery`)
            })
            .finally(release),
        )
      }
      const preparationRunner = createPreparationRunner({
        db,
        registry: createPreparationRegistry({
          exec: preparationExec,
          hostAdb: hostAdbHandle.run,
          installApk: preparationInstallApk,
          uiServerApkPaths: async () => ({
            app: await toolchain.resolveToolPath('ui-server'),
            test: await toolchain.resolveToolPath('ui-server-test'),
          }),
          uiServerExpectedArtifact: () => toolchain.deviceArtifactExpectation('ui-server'),
          log: log.child('preparation'),
        }),
        record: recorder!.record,
        log: log.child('preparation'),
      })
      preparationRunnerRef = preparationRunner
      // Same boot-ordering rule as `agentProvisioner` just above (§96.25 fix
      // 1): the boot-time `ensureAll()` sweep runs later, right after
      // `adbState = 'ready'` is logged, never here.

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

      // The labelling service (plan 89 §4.6, §5 step 89.6) — built right
      // after `deviceIdentity`, for the identical reason: it reuses the SAME
      // per-device guest-agent session a network route already owns
      // (`guestAgent.withGuestAgentClient`) rather than a second,
      // independent bootstrap. `client: () => adb` mirrors every other
      // adb-not-ready-yet-safe accessor in this function (readiness.ts's
      // `transportFor` uses the identical shape for the same reason).
      const labelling = createLabellingService({
        db,
        client: () => adb,
        withGuestAgentClient: guestAgent.withGuestAgentClient,
        maxConcurrent: () => settingsStore.get().labelling.maxConcurrent,
        record: recorder!.record,
        log: log.child('labelling'),
      })
      labellingRef = labelling

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
        // Plan 88 §3.6, §4.1, §5 step 88.5 — the SAME two accessors
        // `deviceRoutes`/`topologyRoutes` get below, so an agent script's
        // `ctx.listDevices()`/`ctx.getDevice()` badges a device identically
        // to `GET /api/devices` and the fleet map, never disagreeing about
        // whether a phone reads OTG/WI-FI/TCP.
        networks: () => settingsStore.get().discovery.networks,
        declaredMedia: () => loadDeclaredMedia(endpoints),
        // Who is currently assisting a device (plan 91 §3.4 item 4, §4.4, §5 step
        // 91.4; residual closed per docs/plans/96-m61-hotfixes.md §96.10) — same
        // accessor `deviceRoutes`/`clusterRoutes`/`topologyRoutes` already get,
        // so an agent script's `ctx.listDevices()`/`ctx.getDevice()` reports an
        // assisting holder the same as every other surface.
        assistedByOf: (deviceId) => coControl.assistedBy(deviceId),
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
      // The action recorder (plan 94 §4.6, §5 step 94.3) — one instance for the whole
      // boot, alongside the other per-farm services built here. Screenshots/anchors go
      // through the SAME content-addressed blob store `agentBlobStore` above already is
      // (F16: never a second store), and `recording` settings are read fresh on every
      // start/anchor/bound check, the same freshness discipline every other farm-settings
      // accessor in this function already uses.
      const recordingService = createRecordingService({
        settings: () => settingsStore.get().recording,
        blobs: agentBlobStore,
        log: log.child('recording'),
      })
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
        // Plan 88 §3.6, §4.1, §5 step 88.5 — same accessors every other `listDevicesWithTags` call in this function gets.
        listDevices: () =>
          listDevicesWithTags(db, undefined, (deviceId) => leases.getHolder(deviceId), settingsStore.get().discovery.networks, loadDeclaredMedia(endpoints)),
        deviceCount: () => db.select().from(devices).all().length,
        log: log.child('http'),
        audit,
        version: CORE_VERSION,
        adbServerVersion: async () => {
          if (!adb) return null
          return adb.version().catch(() => null)
        },
        adbState: () => adbState,
        toolchain,
        // The "Restart adb server" button's deps (plan 88 §3.10, §4.8, §5
        // step 88.8) — every closure below is a forward reference exactly
        // like `adbServerControl`'s own deps above; none of it is invoked
        // until an operator's click arrives, long after boot finishes.
        adbControl: {
          control: adbServerControl,
          binaryPath: () => adb?.binaryPath ?? null,
          preview: () => ({
            devicesTotal: db.select().from(devices).all().length,
            sessionsActive: sessions?.activeDeviceIds?.().length ?? 0,
            networkDevicesWithEndpoint: endpoints.allWithEndpoints().length,
          }),
          busyFarm: () => {
            const running = jobStore.list({ status: 'running', limit: 1000 })
            const numbers = loadDeviceNumbers(db)
            const deviceRows = new Map(
              db
                .select({ id: devices.id, label: devices.label, stableId: devices.stableId })
                .from(devices)
                .all()
                .map((d) => [d.id, d] as const),
            )
            // The number (plan 89 §1, §5 step 89.4) — this preview is exactly
            // "match a browser row to a phone in their hand" (a job about to
            // be interrupted by a server restart), so it reads by the SAME
            // `#7 Pixel 5` composition every other operator-facing surface
            // uses, not the bare label.
            const deviceLabels = new Map(
              [...deviceRows.entries()].map(([id, d]) => [id, formatDeviceLabel(numbers.get(d.stableId) ?? null, d.label)] as const),
            )
            const runningJobs = running.rows.map((j) => ({
              id: j.id,
              label: `${j.scriptName ?? 'a script'} on ${deviceLabels.get(j.deviceId) ?? j.deviceId}`,
            }))
            const heldDevices = db
              .select({ id: devices.id, label: devices.label, stableId: devices.stableId })
              .from(devices)
              .where(eq(devices.status, 'manual'))
              .all()
              .map((d) => ({ deviceId: d.id, label: formatDeviceLabel(numbers.get(d.stableId) ?? null, d.label) }))
            return { runningJobs, heldDevices }
          },
          // `adbControl.restartCooldownSec` (plan 88 §4.2, promoted to a real
          // setting in step 88.9) — read fresh on every call, same as every
          // other "settings, read live" dep in this codebase.
          restartCooldownSec: () => settingsStore.get().adbControl.restartCooldownSec,
        },
        // `scriptRef` resolution (plan 62 §4.4) — resolved before the job row
        // is written, so `jobs.scriptId` is always concrete.
        jobRoutes: createJobRoutes(jobService, {
          log: log.child('jobs'),
          resolveScriptRef: (ref) => scriptRegistry.resolve(ref),
          logBuffer: jobLogBuffer,
          // `canCancelJob`'s ownership half (`auth/acl.ts`) — the same
          // `getDeviceOwner` closure `jobService`'s own `enqueue` check,
          // `lease.acquire`, batch dispatch, and the adb endpoint already
          // share, so `POST /:id/cancel` gets the identical ownership answer
          // the WS `job.cancel` path (wired below) gets.
          getDeviceOwner,
          audit,
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
          // `POST /:id/../rescan` (plan 85 §4.6, §5 step 85.2) — same
          // forward-ref pattern as `onAdmitted` above: `reconciler` is
          // assigned later in boot (or never, in orchestrator mode / if the
          // adb subsystem failed to start), so this reads it fresh at call
          // time rather than capturing a null.
          rescan: () => reconciler?.runOnce() ?? null,
          // Presence's snapshot half (plan 31 §3.4): `/ws` has no replay, so a
          // client GETs the current list before subscribing to `device.viewers`.
          viewersOf: (deviceId) => viewersOfDevice?.(deviceId) ?? [],
          // Device readiness (plan 43 §4.5) — `readiness` is constructed
          // synchronously above, well before `createApp` is reached.
          readiness: readiness ?? undefined,
          // Who holds a device's manual lease (plan 71 §4.4) — `leases` is
          // constructed synchronously above too.
          heldByOf: (deviceId) => leases.getHolder(deviceId),
          // Who is currently assisting a device (plan 91 §3.4 item 4, §4.4,
          // §5 step 91.4) — `coControl` is constructed synchronously above
          // too, right after `leases`.
          assistedByOf: (deviceId) => coControl.assistedBy(deviceId),
          // Per-device disconnect/reconnect (plan 88 §3.7, §4.6, §5 step
          // 88.4) — `leases`/`endpoints`/`jobStore` are constructed
          // synchronously above, the same reasoning as `heldByOf` just above.
          // `reconnector`/`sessions` are forward-refs: both are assigned
          // later in boot (or never, in orchestrator mode / if the adb
          // subsystem failed to start), same pattern as `rescan`/`onAdmitted`.
          leases,
          jobStore,
          connection: {
            reconnector: () => reconnector,
            sessions: () => sessions,
          },
          // The USB → network cutover wizard (plan 88 §3.4, §4.6, §5 step
          // 88.5) — same forward-ref pattern as `connection` just above:
          // `cutoverManager` is assigned later in boot (or never, in
          // orchestrator mode / if the adb subsystem failed to start).
          cutover: () => cutoverManager,
          endpoints,
          // Farm networks (plan 88 §3.6, §4.1, §5 step 88.5) — read fresh
          // from the settings store on every call, same as every other
          // settings-derived accessor in this function. Without this,
          // `deriveConnection` never sees a network to match a `tcp`
          // device's address against, and `mediumSource` could only ever
          // read `'declared'` or `'unknown'`.
          networks: () => settingsStore.get().discovery.networks,
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
          // Physical labelling (plan 89 §4.3, §4.6, §5 step 89.6's own noted
          // gap, closed here) — `labelling` is constructed unconditionally
          // above (within this same code path), well before this point.
          labelling,
        }),
        // `GET /api/transfers` (plan 107 §3.1, §3.4, §5 step 107.2) — the
        // registry `transferBroadcast` (constructed unconditionally above,
        // beside `transferService`) already keeps up to date on every
        // install/push/pull, regardless of which of its nine call sites
        // started it.
        transferRegistryRoutes: createTransferRegistryRoutes({ registry: transferRegistry }),
        // Plan 44 §5.8 — built just above, before adb was ready.
        guestAgentRoutes: guestAgent.routes,
        // Plan 90 §3.8, §4.7 — the fleet-wide "on demand" hook, mounted at
        // its own `/api/guest-agent` prefix (`server/http.ts`), NOT
        // `/api/devices` like every other guest-agent route above.
        agentProvisionerRoutes: createAgentProvisionerRoutes({ provisioner: agentProvisioner, db }).routes,
        // Plan 58 §5.3 — built just above, alongside `guestAgent`.
        deviceIdentityRoutes: deviceIdentity,
        // Plan 106 §3.3, §4 — built just above, alongside `agentProvisioner`.
        // `agentProvisioner` bridges the guest agent's own specialised
        // retry/whole-device-pass engine into this same unified surface
        // (plan 106 §5 step 106.5 — see `DevicePreparationRoutesDeps.agentProvisioner`'s
        // own doc comment for why it is bridged rather than registered).
        devicePreparationRoutes: createDevicePreparationRoutes({ db, runner: preparationRunner, agentProvisioner }).routes,
        tagRoutes: createTagRoutes({ db }),
        clusterRoutes: createClusterRoutes({
          db,
          audit,
          heldByOf: (deviceId) => leases.getHolder(deviceId),
          // Plan 88 §3.6, §4.1, residual gap closed by plan 90 (also recorded at
          // docs/plans/96-m61-hotfixes.md §96.5): `createClusterRoutes` itself has carried
          // `networks`/`declaredMedia` since that entry's fix — only THIS call site never
          // threaded them through, so a device's connection badge on its own device page
          // could read `OTG` while the identical row, viewed through its cluster's device
          // list, read the honest-but-incomplete `TCP`. Same accessors `deviceRoutes`/
          // `topologyRoutes` already get, a few lines away in this same function.
          networks: () => settingsStore.get().discovery.networks,
          declaredMedia: () => loadDeclaredMedia(endpoints),
          // Who is currently assisting a device (plan 91 §3.4 item 4, §4.4, §5 step
          // 91.4; residual closed per docs/plans/96-m61-hotfixes.md §96.10) — same
          // accessor `deviceRoutes` above already gets; `coControl` is constructed
          // synchronously above, well before this object literal.
          assistedByOf: (deviceId) => coControl.assistedBy(deviceId),
        }),
        topologyRoutes: createTopologyRoutes({
          db,
          readinessOf: (deviceId, row) => readiness?.get(deviceId) ?? staticReadinessFallback(row),
          heldByOf: (deviceId) => leases.getHolder(deviceId),
          // Plan 88 §3.6, §4.1, §5 step 88.5 — same accessors `deviceRoutes` above gets, so the
          // fleet map's badges never disagree with the device list's.
          networks: () => settingsStore.get().discovery.networks,
          declaredMedia: () => loadDeclaredMedia(endpoints),
          // Who is currently assisting a device (plan 91 §3.4 item 4, §4.4, §5 step
          // 91.4; residual closed per docs/plans/96-m61-hotfixes.md §96.10) — same
          // accessor `deviceRoutes` above already gets.
          assistedByOf: (deviceId) => coControl.assistedBy(deviceId),
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
          // Plan 95 §5 step 95.7 — rerun-failed's params-schema lookup; see
          // `scheduleRoutes`'s own `scriptRegistry` wiring below for why.
          scriptRegistry,
          // docs/plans/96-m61-hotfixes.md §96.18 — the same accessor
          // `resetPolicy` below reads from, so a batch's `runtimeOverride`
          // ceiling check binds against the farm's REAL `job` settings
          // instead of always resolving to "no ceiling".
          farmJobSettings: () => settingsStore.get().job,
          // Plan 94 §3.7, §3.8, §4.8, §4.9, step 94.7 — a batch created
          // through this route can now carry a `pacing` block.
          pacer,
          // Plan 94 §3.9, §4.9, step 94.8 — `POST /:id/stop`'s ONLY abort
          // path for a running member: the SAME `jobService` instance built
          // above for `createJobRoutes`, never a second one (§3.9 rule 3,
          // "no second abort path").
          jobService,
          // Plan 93 §3.12, §4.6, step 93.8 — closes F10: `internal:install`
          // dispatched through a batch used to require only `job.run`,
          // no `device.files`, no `transfer.enabled`. The SAME live
          // accessors `createJobService` above and `scheduleRoutes` below
          // both read.
          shellMode: () => settingsStore.get().shell.mode,
          transferEnabled: () => settingsStore.get().transfer.enabled,
          // Plan 93 §3.13, §4.4, §4.7, step 93.10 — `GET /:id/artifacts.zip`
          // resolves each collected file's stored relative path against
          // app-data, the same root `artifactRoutes` below is given.
          dataDir: cfg.dataDir,
          // Same live `transfer` settings `transferEnabled` above reads,
          // just the one extra field the archive route's pre-flight cap
          // needs.
          archiveSettings: () => settingsStore.get().transfer,
        }),
        // The fleet command console's REST surface (plan 93 §4.4, step
        // 93.4) — `commandRunStore`/`commandRunner` are both constructed
        // unconditionally above, right after `leases`.
        commandRunRoutes: createCommandRunRoutes({
          db,
          store: commandRunStore,
          runner: commandRunner!,
          settings: () => settingsStore.get().shell,
          // The SAME role-resolution expression `commandRunner`'s own
          // construction above uses — an operator's fleet-command
          // permission must agree between the REST gate and the runner's
          // defense-in-depth re-check of it.
          roleOf:
            authMode === 'local'
              ? () => 'admin'
              : (userId) => (userId ? (auth.listUsers().find((u) => u.id === userId)?.role ?? 'operator') : 'operator'),
          getDeviceOwner,
        }),
        // Saved commands (plan 93 §3.10, §4.4, step 93.6) — the SAME
        // role-resolution expression `commandRunRoutes` above uses, so a
        // saved command's owner-or-admin edit/delete gate agrees with the
        // fleet command console's own permission model.
        savedCommandRoutes: createSavedCommandRoutes({
          db,
          settings: () => settingsStore.get().shell,
          roleOf:
            authMode === 'local'
              ? () => 'admin'
              : (userId) => (userId ? (auth.listUsers().find((u) => u.id === userId)?.role ?? 'operator') : 'operator'),
          audit,
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
          // Plan 93 §3.12, §4.6, step 93.8 — the same pair `batchRoutes`
          // above and `scheduleRunner`'s own construction get, so a
          // schedule's `internal:install` is gated identically whether it
          // fires at create/edit time, `run-now`, or on its own cron.
          shellMode: () => settingsStore.get().shell.mode,
          transferEnabled: () => settingsStore.get().transfer.enabled,
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
          // `hostAdbHandle` is unconditional and non-null from construction
          // (see its own comment above); `transportStats` is the forward-ref
          // resolved once `attachWsRouter` runs.
          transport: () => transportStats?.() ?? null,
          hostAdb: () => hostAdbHandle.stats(),
          adbHealth: () => adbHealthMonitor?.current() ?? null,
          // `inputStats` is the forward-ref resolved once `attachWsRouter`
          // runs (plan 91 §4.10, §5 step 91.10), same pattern as `transport`.
          input: () => inputStats?.() ?? null,
          // Plan 93 §5 step 93.12 — `commandRunner` is constructed
          // unconditionally above (right after `leases`, same as
          // `batchRoutes`'s own `commandRunRoutes` wiring reads), well
          // before this call. Without this line `GET /api/adb/stats`
          // reports the whole `commandConsole` block zero-filled forever,
          // even while command runs are genuinely in flight
          // (`adb-stats-command-console-wiring.test.ts`, the self-detecting
          // gap step 93.12 could not close on its own file list).
          commandConsole: () => commandRunner?.stats() ?? null,
          // plan 92 §3.3, §3.7, §4.5, §5 step 92.3 — the build lane's
          // farm-wide settings. `maxTiles` reports `wall.maxTiles` AS
          // ACTUALLY APPLIED: the derived count (`computeAutoTiles`) when
          // the stored setting is `0` (auto), the stored value otherwise —
          // never the raw `0` — so this agrees with what the Wall itself
          // will compute (§4.6). The resolved wall bitrate is the FARM's
          // own (no per-device override — `maxTiles` is a farm-wide
          // budget, not a per-device one), via `resolveVideoProfile` with
          // no device override.
          //
          // Plan 100 §3.1/§4.1/§4.1, step 100.3 — `computeAutoTiles` combines
          // a decode bound (`wall.decodeTileCeiling`) with a bandwidth bound
          // that is now transport-aware: `resolveWallTransport` classifies
          // the deployment the same way auth mode already is (CLAUDE.md:
          // "auth mode derives from the bind address") — orchestrator/cloud
          // reads as `wan`, everything else as `loopback`, unless
          // `wall.transportOverride` names one explicitly — and
          // `resolveWallBandwidthBps` hard-pins the WAN branch to
          // `WALL_VIDEO_BUDGET_BPS` (byte-identical to pre-plan-100 cloud
          // behaviour, §3.6) while loopback/LAN use the farm's own generous
          // `wall.bandwidthBps` instead, so the decode bound is what actually
          // governs a local wall rather than a WAN-shaped constant it never
          // needed.
          video: () => {
            const wallMaxTiles = settingsStore.get().wall.maxTiles
            const maxTilesAuto = wallMaxTiles === 0
            const wallSettings = settingsStore.get().wall
            const transport = resolveWallTransport(process.env.ENKAKU_MODE === 'orchestrator', wallSettings.transportOverride)
            return {
              maxConcurrentBuilds: settingsStore.get().session.maxConcurrentBuilds,
              maxTiles: maxTilesAuto
                ? computeAutoTiles(resolveVideoProfile(settingsStore.get().video, null, 'wall').bitRate, {
                    decodeTileCeiling: wallSettings.decodeTileCeiling,
                    bandwidthBps: resolveWallBandwidthBps(transport, wallSettings.bandwidthBps),
                  })
                : wallMaxTiles,
              maxTilesAuto,
              transport,
            }
          },
        }),
        // `POST /api/video/reprofile` (plan 92 §3.8, §4.5, §5 step 92.2) —
        // the manual "apply now" the settings section's own button (and
        // anyone with `settings.manage` from curl) calls; the automatic
        // debounced path above calls the exact same `sessions.reprofile()`.
        videoRoutes: createVideoRoutes({ sessions: () => sessions }),
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
        scriptRoutes: createScriptRoutes({ db, audit, ...(process.env.ENKAKU_PUBLISH_TOKEN ? { publishToken: process.env.ENKAKU_PUBLISH_TOKEN } : {}) }),
        // Plan 99 §4.5, §4.9, §5 step 99.6 — `daemon.ts` was held by a concurrent worker
        // for that step's whole duration, so `HttpDeps.workflowRoutes` stayed optional
        // and `/api/workflows/*` 404'd through `server/http.ts`'s catch-all in every real
        // build (docs/plans/96-m61-hotfixes.md §96.11). `scriptRegistry` is the SAME
        // instance every other resolver in this file already shares (F17: one door).
        //
        // `settings: () => settingsStore.get().workflow` (docs/settings-audit.md #3,
        // `docs/plans/96-m61-hotfixes.md`) — without this, `checkWorkflow`'s
        // publish-time `E_WORKFLOW_BUDGET_IMPOSSIBLE` check always fell back to
        // `workflow.maxTotalMs`'s hardcoded SCHEMA default (`api/workflows.ts`'s own
        // `budgetFor`), silently disagreeing with the LIVE value the workflow
        // executor's runtime clock already enforced (the `createWorkflowExecutor`
        // call below, wired since plan 99 §5 items 1-2). Guarded by
        // `daemon-wiring.test.ts`'s workflow-routes describe block.
        workflowRoutes: createWorkflowRoutes({ db, registry: scriptRegistry, audit, settings: () => settingsStore.get().workflow }),
        // Plan 94 §4.9, §5 step 94.5 — `workspaceStore` and `recordingService` are the
        // SAME instances every other route/service in this file already shares (one
        // workspace, one recorder — F16/F11's own "never a second store/bundler").
        recordingRoutes: createRecordingRoutes({ db, workspace: workspaceStore, recording: recordingService, audit }),
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
          // The five `/:name/data/*` routes (plan 108 §4.5, step 108.4) —
          // one plugin's own KV namespace, forced from the `:name` path
          // segment. The SAME `kvStore` `/api/kv`'s admin surface and the
          // job runner's own KV port already share; the namespace is never
          // a caller input, so there is nothing here to gate beyond it.
          data: { db, kv: kvStore },
          // `POST /:name/action/:actionId` (plan 108 §4.5, step 108.5) —
          // absent this key the route is not registered at all, so a plugin
          // screen's buttons 404 in a real boot. Every dependency is the
          // instance the equivalent hand-made request already goes through:
          // `scriptRegistry` resolves the declared `ScriptRef` exactly as
          // `POST /api/jobs` does, `jobService` is the one enqueue path, and
          // `batch` is `api/batches.ts`'s OWN dispatch-deps factory — the
          // same closures `POST /api/batches` builds, so a batch dispatched
          // from a plugin screen cannot be gated differently from one
          // dispatched from the Batches page (its host bag is the same set
          // of live accessors `batchRoutes` above is given).
          actions: {
            registry: scriptRegistry,
            kv: kvStore,
            jobService,
            batch: (actor) =>
              createBatchDispatchDeps(
                {
                  db,
                  scheduler: scheduler!,
                  audit,
                  registry: executors,
                  findScript,
                  scriptRegistry,
                  farmJobSettings: () => settingsStore.get().job,
                  pacer,
                  shellMode: () => settingsStore.get().shell.mode,
                  transferEnabled: () => settingsStore.get().transfer.enabled,
                },
                actor,
              ),
            getDeviceOwner,
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

      try {
        server = Bun.serve({
          hostname: cfg.host,
          port: cfg.port,
          ...tlsOptions,
          async fetch(req, srv) {
            const url = new URL(req.url)
            // The node tunnel authenticates with the credential from enrollment.
            if (url.pathname === '/node/ws') {
              const nodeId = await nodeAuth.verify(req.headers.get('authorization'))
              if (!nodeId) return new Response('unauthorized', { status: 401 })
              if (srv.upgrade(req, { data: { nodeId } })) return undefined
              return new Response('upgrade failed', { status: 400 })
            }
            // `/agent/ws` was the pre-plan-61 path, accepted alongside `/node/ws`
            // for one release (§3.3) so a node binary already deployed in the
            // field — which has this URL hardcoded and cannot be told to dial
            // somewhere else — could survive the upgrade. That window closed at
            // v0.1.7 (00-overview.md §9, now past). Answered explicitly here,
            // rather than left to fall through to the Studio SPA's 200
            // catch-all: an old node's WS handshake would otherwise see a plain
            // HTTP 200 with an HTML body, which is a confusing non-upgrade, not
            // a legible refusal. `410 Gone` plus a warn naming the path gives
            // an operator watching the core's logs the actual reason.
            if (url.pathname === '/agent/ws') {
              log.warn(`rejected a pre-rename node dialing the removed /agent/ws path — it must be upgraded past plan 61 (see docs/plans/00-overview.md §9)`)
              return new Response(
                'this control plane no longer accepts the pre-plan-61 /agent/ws tunnel path (removed at v0.1.7) — upgrade this node binary and re-enroll if needed',
                { status: 410 },
              )
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
            // Set explicitly rather than inherited (plan 85 §3.6, §4.6, §5
            // 85.7a) — Bun's own defaults happen to already be 120s/true, but
            // a value nobody wrote down is not a value anyone can review.
            // `sendPings` is Bun's OWN protocol-level WebSocket ping/pong,
            // invisible to browser JS; the 15s `heartbeat` broadcast below is
            // the separate, APPLICATION-level beat the Studio client's watchdog
            // actually reads (a browser cannot observe the protocol-level one).
            idleTimeout: 120,
            sendPings: true,
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
      } catch (err) {
        // Bun re-throws the bare libuv/OS error on a bind failure (plan 85
        // §4.7, §5 85.6, fixes F13/F14) — `Failed to start server. Is port
        // 7700 in use?`, with no hint of WHO is holding it. On Windows that
        // question used to be unanswerable at all (`findPortHolderWindows`
        // returned `null` unconditionally); now it names the pid and image,
        // the same lookup `enkaku doctor` itself uses.
        if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'EADDRINUSE') {
          const holder = await findPortHolder(cfg.port)
          const holderText = holder ? `pid ${holder.pid} (${holder.processName})` : 'another process'
          throw new EnkakuError(
            'E_PORT_IN_USE',
            `port ${cfg.port} is already held by ${holderText}, which is not an Enkaku core.\n` +
              `        Stop it, or set ENKAKU_PORT to a free port. \`enkaku doctor\` explains more.`,
          )
        }
        throw err
      }
      const scheme = cfg.tls.mode === 'self' ? 'https' : 'http'
      log.info(`enkaku core v${CORE_VERSION} listen ${scheme}://${cfg.host}:${cfg.port}`)

      // The application-level heartbeat (plan 85 §3.6, §4.2, §4.6, §5
      // 85.7a, tests H2) — every 15s, so the Studio client's 45s silence
      // watchdog always has three chances to see traffic before it decides
      // the socket is dead rather than merely idle. Distinct from
      // `sendPings` above: that is Bun's protocol-level ping/pong, which a
      // browser's WebSocket API cannot observe at all.
      heartbeatInterval = setInterval(() => {
        hub.broadcast({ type: 'heartbeat', payload: { t: Date.now() } })
      }, 15_000)

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

      // Orphaned agent screenshot blobs (plan 87). These live INSIDE enkaku.db
      // as full-resolution bytes, so an unswept farm grows the database file
      // itself — the fastest-growing unbounded thing the MVP audit found. The
      // sweep only ever deletes blobs no `agent_messages` row still references,
      // so it can share `retention`'s interval without sharing its opt-in.
      blobGc = createBlobGc({
        db,
        settings: settingsStore,
        log: log.child('blob-gc'),
        intervalMinutes: cfg.retention.sweepIntervalMinutes,
      })
      blobGc.start()

      leases.startReaper()
      stopReaper = () => leases.stopReaper()
      coControl.startReaper()
      stopCoControlReaper = () => coControl.stopReaper()
      expiryReaper.start()
      stopExpiryReaper = () => expiryReaper.stop()
      scheduler.start()
      const sched = scheduler
      stopScheduler = () => sched.stop()
      // Plan 94 §3.8, §4.8, step 94.7 — "Restart safety": re-plans anything
      // a crash interrupted mid-repetition and arms the pacer's own timer.
      // No in-memory plan to lose (the decision is derived entirely from
      // `jobs` rows) — this is idempotent for every batch that lost nothing.
      // `jobStore`/`broadcast`/`log` wired (step 94.11) so the same sweep
      // also closes a paced batch left `queued`/`running` with zero live
      // jobs after a crash — see `clusters/pacer.ts`'s own doc comment on
      // `replanAfterRestart` for why this is a real gap and not merely
      // belt-and-braces.
      replanAfterRestart({ db, pacer, jobStore, broadcast: (msg) => hub.broadcast(msg), log: log.child('pacer') })
      stopPacer = () => pacer.stop()
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
          // Co-control — Assist (plan 91 §3.2, §4.6, §5 step 91.4): the
          // `input.*` fallback and the `assist.start`/`assist.stop` handlers
          // both live in `ws-handlers.ts`; `coControl` itself was constructed
          // right after `leases`, above, and its reaper is already started/
          // stopped alongside `leases.startReaper()`/`stopReaper()`.
          coControl,
          coControlMode: () => settingsStore.get().coControl.mode,
          // `/api/adb/stats`'s `input.queueWaitMs` (plan 91 §4.10, §5 step
          // 91.10) — the co-control doctor check's budget, read fresh like
          // every other farm setting accessor here.
          coControlQueueWaitMs: () => settingsStore.get().coControl.queueWaitMs,
          // Mirror groups (plan 91 §3.9, §4.7, §5 step 91.7) — `states` is
          // the SAME `DeviceStateMachine` `leases`/`host` above already
          // read; `mirrorSettings` is read fresh, the same freshness
          // discipline `shellSettings`/`crashPolicy` already give their own
          // farm settings blocks.
          states,
          mirrorSettings: () => settingsStore.get().mirror,
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
          // Plan 93 §3.3, §3.17, §5 step 93.5 — `shell.exec` records through
          // the SAME store the fan-out runner writes to (`commandRunStore`,
          // built right after `leases`, above), so `/console`'s History has
          // one mechanism for both, not two. This is the store only; the
          // runner itself (`commandRunner`) is unrelated to `shell.exec` and
          // stays wired only into `commandRunRoutes` below.
          commandRunStore,
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
          // `monitor.crashWatch` (plan 85 §3.2) — read fresh for the same
          // reason `crashPolicy` is, so an operator who turns crash detection
          // off on a large farm does not have to restart the core.
          crashWatch: () => settingsStore.get().monitor.crashWatch,
          targetPackagesForJob: (jobId) => targetPackagesByJob.get(jobId) ?? [],
          saveCrashTrace,
          onJobCrash: (jobId, e) => host.notifyCrash(jobId, e),
          // Plan 91 §3.6, §4.8, §5 step 91.5/91.10 — the last line of the
          // assist→child notification chain (`WsHandlerDeps.onAssist` →
          // `ExecutorHost.notifyAssist` → the runner's IPC → `ctx.onAssist`).
          // Shaped identically to `onJobCrash` right above: a running
          // script's `ctx.onAssist` was fully built and unit-tested in
          // isolation by step 91.5 but structurally unreachable in a real
          // boot until this line existed.
          onAssist: (jobId, e) => host.notifyAssist(jobId, e),
          // The agent chat protocol's subscribe/unsubscribe/cancel half (plan 66 §4.4) — built
          // once, above, before `attachWsRouter` is even defined (it does not depend on `sessions`).
          agent: agentWsHandler,
          // The action recorder (plan 94 §4.6, §5 step 94.3) — built once, above, alongside
          // the other agent-loop services. Without this, `recording.*` refuses E_NOT_SUPPORTED
          // and the `input.*` tee is a harmless no-op in every real boot.
          recording: recordingService,
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
        stopRecordingForLeaseLost = handler.stopRecordingForLeaseLost
        watchCrashesForDevice = handler.watchDevice
        unwatchCrashesForDevice = handler.unwatchDevice
        reconcileMirrorForDevice = handler.reconcileMirror
        transportStats = handler.transportStats
        inputStats = handler.inputStats
        broadcastCommandEvent = handler.broadcastCommand
        broadcastTransferEvent = handler.broadcastTransfer
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

        // Boot-time forward cleanup (plan 85 §4.8, §5 85.6, fixes F20) —
        // `adb forward` entries live in the adb SERVER, not in this process,
        // so they survive a crash and accumulate across restarts. Every
        // entry whose LOCAL port falls inside the configured ui-server range
        // and whose REMOTE is `tcp:9008` is ours by construction — nothing
        // else binds that exact pair — so it is safe to remove
        // unconditionally. scrcpy's own forwards are deliberately left
        // alone: they use `tcp:0` (a random local port) and are therefore
        // both harmless leftovers and indistinguishable from another tool's,
        // so reaching into the shared adb server to remove one would be
        // guessing, not cleanup.
        try {
          const { rangeStart, rangeEnd } = parsePortRange(process.env.ENKAKU_UI_SERVER_PORT_RANGE)
          const list = await hostAdbHandle.run(['forward', '--list'])
          let removed = 0
          for (const rawLine of list.split('\n')) {
            const fields = rawLine.trim().split(/\s+/)
            const serial = fields[0]
            const local = fields[1]
            const remote = fields[2]
            if (!serial || !local || !remote || remote !== `tcp:${UI_SERVER_DEVICE_PORT}`) continue
            const portMatch = /^tcp:(\d+)$/.exec(local)
            if (!portMatch) continue
            const port = Number.parseInt(portMatch[1]!, 10)
            if (port < rangeStart || port > rangeEnd) continue
            try {
              // `-s serial`, matching `launcher.ts`'s own `forward --remove`
              // call — the removal is scoped to the exact (serial, local)
              // pair the listing reported, never a bare port number.
              await hostAdbHandle.run(['-s', serial, 'forward', '--remove', local])
              removed += 1
            } catch (err) {
              log.warn(`boot-time forward cleanup: failed to remove ${local} (${serial}): ${String(err)}`)
            }
          }
          if (removed > 0) {
            log.info(
              `boot-time cleanup: removed ${removed} leaked ui-server adb forward(s) (range ${rangeStart}-${rangeEnd}, remote tcp:${UI_SERVER_DEVICE_PORT})`,
            )
          }
        } catch (err) {
          log.warn(`boot-time forward cleanup: could not list adb forwards, skipping: ${String(err)}`)
        }

        // `ports` is the one constructed unconditionally above, before adb
        // was ready — shared with the guest-agent network route (plan 44 §5.7).
        const adbClient = adb
        const inspectorLog = log.child('inspector')
        const scrcpyLog = log.child('scrcpy')
        // Named so `resolveProfile` below can read a device's own video
        // override at the same seam `devices:` already reads everything
        // else (plan 92 §3.5, §4.4) — one instance, not a second read path.
        const deviceSource = createDbDeviceSource(db)

        // Boot-time stray scrcpy sweep (96.23's own prerequisite for plan
        // 100's two-session design, §3.5, step 100.1) — run BEFORE `sessions`
        // is built, so nothing in this process has opened a session yet:
        // `knownScids` is correctly empty, and every device-side scrcpy
        // process `ps` still finds on an attached phone at this point is, by
        // definition, an orphan left by a prior crash or an ungraceful
        // shutdown (the exact accumulation 96.23 recorded — "every failed
        // session leaves another. Nothing sweeps them"). Mirrors the
        // boot-time `adb forward` cleanup just above: best-effort, one
        // device's failure logged and skipped rather than failing boot.
        for (const tracked of await adbClient.listDevices().catch((err) => {
          log.warn(`boot-time scrcpy sweep: could not list devices, skipping: ${String(err)}`)
          return []
        })) {
          if (tracked.state !== 'device') continue
          try {
            const { killedScids } = await sweepStrayScrcpyServers(
              (cmd) => adbClient.exec(tracked.serial, cmd, { profile: 'default' }).then((r) => r.stdout),
              new Set(),
            )
            if (killedScids.length > 0) {
              scrcpyLog.info(
                `boot-time sweep: killed ${killedScids.length} orphaned scrcpy process(es) on ${tracked.serial} (scid ${killedScids.join(', ')})`,
              )
            }
          } catch (err) {
            scrcpyLog.warn(`boot-time scrcpy sweep: ${tracked.serial}: ${String(err)}`)
          }
        }

        sessions = createSessionManager({
          client: adb,
          devices: deviceSource,
          log: log.child('session'),
          // Plan 90 §3.2, §4.5, §5 step 90.5 (docs/plans/96-m61-hotfixes.md): rung 1 of the text
          // ladder (`resolveTextRoute`'s `agent-ime`) needs `SessionManagerDeps.withGuestAgentClient`
          // to be wired, or `applyTextInput` always sees `agentCapabilities: null` and the ladder
          // can never pick anything but rung 2 or below — the entire on-device IME goes dark. This
          // was the one production call site that never passed it (the exact defect class named in
          // this repo's own hotfix log). `guestAgent` is a plain top-level `const` built well above
          // (`createGuestAgentRoutes(...)`, around line 1308) and is fully constructed — including
          // `withGuestAgentClient` — long before this `try` block runs; the only forward-ref hazard
          // near its own construction is `agentProvisionerRef` (built AFTER `guestAgent`, so
          // `guestAgent`'s OWN deps object reads it through a closure), which does not apply here.
          // `guestAgent.withGuestAgentClient` is the SAME per-device session seam the agent
          // provisioner's `hello` and `deviceIdentity` already share (plan 44 §8b's "Bug 1": two
          // independent bootstraps mint two tokens and invalidate each other) — `SessionManagerDeps`
          // wants a curried `(deviceId) => GuestAgentClientRunner`, so this is the adapter; `opts`
          // (`handshakeRetries`) is dropped because the public seam does not accept it either (only
          // `guest-agent.ts`'s own internal `probeReachability` gets that knob).
          withGuestAgentClient: (deviceId) => (fn) => guestAgent.withGuestAgentClient(deviceId, fn),
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
          // plan 92 §3.5, §4.2, §4.3 — farm video settings plus this
          // device's own override, read fresh on every session build (the
          // same freshness discipline as the two accessors right above).
          resolveProfile: (deviceId, quality) => resolveVideoProfile(settingsStore.get().video, deviceSource.get(deviceId)?.video ?? null, quality),
          // plan 92 §3.3, §4.3, §5 step 92.3 (fixes F9, tests H1) — the
          // farm-wide build lane's cap, read fresh on every acquire like
          // every other accessor above.
          maxConcurrentBuilds: () => settingsStore.get().session.maxConcurrentBuilds,
          // Plan 91 §4.1, §4.5 — the input arbiter's bounded-queue budget, read fresh on every
          // submission (docs/plans/96-m61-hotfixes.md §96.13: before this fix `SessionManagerDeps`
          // had no field to receive these at all, so every session ran the plan's own hardcoded
          // stand-in defaults regardless of what an operator configured in Studio).
          arbiterQueueWaitMs: () => settingsStore.get().coControl.queueWaitMs,
          arbiterMaxQueueDepth: () => settingsStore.get().coControl.maxQueueDepth,
          // Plan 100 §4.3, step 100.6 — the screencap-loop fallback's background
          // retry budget, read fresh like every other settings accessor above.
          fallbackRetryCount: () => settingsStore.get().display.fallbackRetryCount,
          makeScrcpy: async (deviceId, transport, profile) => {
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
            //
            // `profile` (plan 92 §3.5, §4.2) is already resolved — farm video
            // settings plus this device's own override — by `resolveProfile`
            // above, threaded through `createSession`'s `opts.videoProfile`.
            // There is no `QUALITY_PROFILES[quality]` lookup left here.
            return startScrcpySession(
              {
                serial: transport.serial,
                exec: (cmd) => transport.exec(cmd, { profile: 'default' }).then((r) => r.stdout),
                hostAdb: hostAdbHandle.run,
                spawnLongLived: hostAdbHandle.spawnLongLived,
              },
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
                hostAdb: hostAdbHandle.run,
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

        // Plan 99 §3.2, §4.6, §4.7 — which workflow node is CURRENTLY
        // executing, per jobId. Read by the `artifacts` factory below (so a
        // node script's `ctx.artifact.save()` — untouched at the child
        // boundary — lands with `artifacts.node_id` stamped) and by the
        // `onPhase` hook just below it (so `job_nodes.attempts` has an
        // honest number). The workflow executor (`jobs/executors/workflow.ts`,
        // constructed further down once `runner`/`sessions` both exist)
        // calls `begin`/`end` around each node's `runner.execute()` call —
        // see `runner/artifact-store.ts`'s own doc comment for the full
        // mechanism. A standalone (non-workflow) job never touches this
        // tracker, so its artifacts and attempts read back exactly as they
        // did before this plan.
        const jobNodeTracker = createJobNodeTracker()

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
              nodeId: () => jobNodeTracker.current(jobId),
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
            // Plan 99 §4.6, §4.7 — `job_nodes.attempts`'s only source: this
            // fires on every attempt of every execution, and `attempt` resets
            // to 1 at the top of every `runner.execute()` call, so the
            // highest value seen between a workflow node's own `begin`/`end`
            // pair is exactly how many attempts THAT node execution spent.
            // A no-op for every non-workflow job (no `begin` was ever called
            // for its jobId).
            jobNodeTracker.noteAttempt(jobId, attempt)
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
          // Plan 97 §3.7, §4.3, §5 step 97.7 — forwarded VERBATIM to the
          // host, which owns the size check and the one-warn-per-job rule
          // (`ExecutorHost.progress`'s own doc comment); this runner does
          // not measure, drop, or write anything itself.
          onProgress: (jobId, value) => host.progress(jobId, value),
        })
        const localExecutor = createScriptExecutor({ registry: scriptRegistry, runner })
        executors.setFallback({
          // `scriptId` forwarded through (plan 95 §5 step 95.6) — the local
          // script executor is the SAME instance for every non-built-in
          // scriptId and needs it to look up which script's `paramsSchema`
          // to validate against; validity does not depend on which device
          // (local or node-owned) ends up running the job.
          validateParams: (params, scriptId) => localExecutor.validateParams(params, scriptId),
          run: (job, ctx) => {
            // Node-owned device → run it on the node; otherwise run locally.
            const owner = remoteSessions?.nodeIdFor(job.deviceId) ?? null
            return owner ? remoteBridge.executor.run(job, ctx) : localExecutor.run(job, ctx)
          },
        })

        // The workflow executor (plan 99 §3.1, §4.7, step 99.7) — registered
        // as the `kind: 'workflow'` fallback, beside the script executor's
        // `kind: 'script'` fallback immediately above. It reuses the SAME
        // `runner`/`sessions`/`scriptRegistry` every standalone job already
        // shares — a node is a script child, not a job (§3.4) — and drives
        // `jobNodeTracker` (built above, alongside `runner`) so a node's
        // artifacts and attempts are attributed correctly with zero changes
        // to `@enkaku/session` or the child boundary.
        //
        // KNOWN GAP, reported rather than silently unbuilt: unlike the
        // script fallback immediately above, this does NOT branch on
        // `remoteSessions?.nodeIdFor(job.deviceId)` — a workflow job on a
        // node-owned (cloud) device would try to run through the LOCAL
        // `runner` regardless and fail. Nothing in plan 99 §3–§5 asks for
        // cloud-device workflow support in this step, and building the
        // remote-bridge equivalent of this executor is its own undertaking
        // (`jobs/executors/remote.ts` is a comparably sized subsystem) — left
        // for a follow-up rather than half-built here silently.
        //
        // `settings: () => settingsStore.get().workflow` reads the live farm
        // setting (`packages/protocol/src/settings.ts`'s `workflow` group),
        // read fresh on every check — never captured — matching every other
        // farm-wide knob in this file. `WorkflowSettings` is structurally
        // `{ maxTotalMs: number }`, exactly what `settingsStore.get().workflow`
        // already is once `settings.ts` carries the field. `checkWorkflow`'s
        // publish-time arithmetic reads the same setting through
        // `api/workflows.ts`'s own `deps.settings`; this is the runtime
        // clock's matching wire (`jobs/executors/workflow.ts`'s own module
        // doc has the history).
        const workflowExecutor = createWorkflowExecutor({
          db,
          registry: scriptRegistry,
          runner,
          sessions,
          nodeTracker: jobNodeTracker,
          settings: () => settingsStore.get().workflow,
          log: log.child('workflow'),
          onNode: (jobId, node) => {
            const info = jobService.get(jobId)
            if (info) hub.broadcast({ type: 'job.status', payload: { ...info, node } })
          },
        })
        executors.setFallback(workflowExecutor, 'workflow')

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
          // The address book's write path (plan 88 §3.2, §4.3, fixes F10) —
          // a successful probe calls `endpoints.observe`, free and
          // automatic, on a path that already ran.
          endpoints,
          // A newly enrolled device inherits the farm defaults (spec §12).
          deviceDefaults: () => settingsStore.get().defaults,
          defaultDesiredReadiness: () => settingsStore.get().readiness.defaultDesired,
          record: recorder!.record,
          // Plan 88 §3.6, §4.1, residual gap closed by plan 90 (also
          // recorded at docs/plans/96-m61-hotfixes.md §96.5): without this,
          // THIS registry's own `device.added` broadcast (the "new device
          // registered" branch of `onOnline`) and its `listDevices()` could
          // only ever read `mediumSource: 'unknown'`/`'declared'`, never
          // `'network'` — a device admitted on a configured wired network
          // badged the honest-but-incomplete `TCP` on the very broadcast
          // every connected Studio tab renders immediately, then silently
          // flipped to `OTG`/`WI-FI` the next ordinary `GET /api/devices`.
          // Same accessor `deviceRoutes`/`topologyRoutes`/`clusterRoutes`
          // already get, a few lines away in this same function.
          networks: () => settingsStore.get().discovery.networks,
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
            // Plan 90 §3.8's second hook — "device online" — the SAME hook
            // `restoreNetworkRoute` above already uses for exactly this
            // purpose ("otomatis deteksi pas reconnect"). This also covers
            // the "admission" hook's connected-right-now case: `onAdmitted`
            // → `registry.admitted()` → this SAME `onOnline` → this SAME
            // `onDeviceReady`, so a freshly admitted, currently-plugged-in
            // phone reaches the provisioner on its very first callback, with
            // no second, redundant call needed here.
            void agentProvisionerRef?.ensure(deviceId).catch((err) =>
              log.warn(`agent-provisioner ensure() failed for ${deviceId} on device-online, tolerated: ${String(err)}`),
            )
            // Plan 89 §3.7 point 1 — the SAME hook `restoreNetworkRoute` and
            // the agent provisioner above already use. Probe-first
            // (`reconcile`, never `apply`): a device already showing the
            // right label costs one cheap round trip and no render.
            // `labelling.mode: 'off'` (the default) costs nothing at all
            // (§3.8) — `reconcile` itself is the thing that enforces that,
            // not this call site.
            void labellingRef?.reconcile(deviceId).catch((err) =>
              log.warn(`labelling reconcile() failed for ${deviceId} on device-online, tolerated: ${String(err)}`),
            )
            // Plan 106 §3.5's first two hooks — "admission" and "reconnect"
            // — both resolve to this SAME `onOnline` → `onDeviceReady`
            // callback, exactly like `agentProvisionerRef`/`labellingRef`
            // above; see `agentProvisionerRef`'s own comment for why no
            // second, admission-specific call site is needed.
            void preparationRunnerRef?.ensure(deviceId).catch((err) =>
              log.warn(`preparation-runner ensure() failed for ${deviceId} on device-online, tolerated: ${String(err)}`),
            )
          },
        })
        await registry.start()

        // The reconnect ladder (plan 88 §3.3, §4.4, fixes F8/F10/F13) —
        // built right after `registry` exists, since it needs `onOnline` to
        // adopt a device it successfully reconnects exactly like a live
        // tracker `add` event would. Only the ladder through remembered
        // addresses (step 88.2's own deliverable): no sweep branch yet
        // (step 88.3's), so an exhausted ladder always reports `not-found`
        // rather than ever scanning a subnet.
        reconnector = createDeviceReconnector({
          client: adb,
          db,
          endpoints,
          registry,
          settings: () => ({
            connectSettleMs: settingsStore.get().discovery.connectSettleMs,
            probeTimeoutMs: settingsStore.get().discovery.scan.probeTimeoutMs,
          }),
          log: log.child('reconnect'),
        })

        // The USB → network cutover wizard (plan 88 §3.4, §4.6, §5 step
        // 88.5) — built right after `reconnector`, since "watch" is that
        // SAME ladder polled on a timer, not a second implementation of it.
        // `hostAdbHandle.run` is H1's own documented fallback for
        // `AdbClient.tcpip` (the device-service path) — bounded, drained,
        // deadline-enforced, exactly like every other CLI spawn in this
        // function.
        cutoverManager = createCutoverManager({
          client: adb,
          hostAdb: hostAdbHandle,
          endpoints,
          reconnector,
          settings: () => ({
            tcpPort: settingsStore.get().discovery.tcpPort,
            armWindowSec: settingsStore.get().discovery.cutover.armWindowSec,
            armPollSec: settingsStore.get().discovery.cutover.armPollSec,
          }),
          broadcast: (msg) => hub.broadcast(msg),
          log: log.child('cutover'),
        })

        // The discovery reconciler (plan 85 §3.3, §4.4, §5 step 85.2, fixes
        // F8/F9/F10) — `host:track-devices` speaks on change only, so this
        // is the generalisation of the comment already on
        // `DeviceRegistry.admitted`: every serial `host:devices-l` reports
        // gets re-derived and reconciled on its own cadence, independent of
        // whether the tracker's event stream ever caught it. `runOnce()`
        // right after the tracker starts (rather than waiting a full
        // `scanIntervalSec`) is what makes five phones already plugged in
        // at boot converge immediately instead of up to one interval late.
        reconciler = createDeviceReconciler({
          client: adb,
          registry,
          settings: () => settingsStore.get().discovery,
          log: log.child('discovery'),
          broadcast: (msg) => hub.broadcast(msg),
        })
        try {
          const bootReport = await reconciler.runOnce()
          if (bootReport.adopted.length > 0 || bootReport.dropped.length > 0 || bootReport.offline.length > 0) {
            log.child('discovery').info(
              `boot reconcile: seen ${bootReport.seen}, adopted ${bootReport.adopted.length}, dropped ${bootReport.dropped.length}, offline ${bootReport.offline.length}`,
            )
          }
        } catch (err) {
          log.child('discovery').warn(`boot reconcile pass failed, the periodic scan will retry: ${String(err)}`)
        }
        reconciler.start()

        // "Is adb stuck?" (plan 88 §3.9, §4.7, fixes F21/F23) — built once
        // `reconciler` exists, since it reads that same object's
        // `nudgeCounts()`/`offlineSerials()` bookkeeping rather than keeping
        // a second copy of either. Read-only: this never touches the adb
        // server itself (F21's rule) — the restart action lives in plan 88
        // §5 step 88.8's `tools/adb-server-control.ts`, an entirely
        // different file.
        const reconcilerRef = reconciler
        adbHealthMonitor = createAdbServerHealth({
          client: () => adb,
          metrics: adbMetrics,
          nudgeCounts: () => reconcilerRef.nudgeCounts(),
          offlineSerials: () => reconcilerRef.offlineSerials(),
          settings: () => settingsStore.get().adbControl,
          onTransition: (h) => hub.broadcast({ type: 'adb.health', payload: h }),
          log: log.child('adb-health'),
        })
        adbHealthMonitor.start()

        recomputeAdbConcurrency()
        adbState = 'ready'
        log.info(`adb subsystem ready (devices registered: ${db.select().from(devices).all().length})`)

        // 96.25 fix 1's own relocation (see `agentProvisionerRef = agentProvisioner`
        // above for why this moved here): only now is `adb` actually assigned and
        // the device registry has finished its initial admission pass, so
        // `guestAgentExec`/`hostAdbHandle` will not see `adb === null`. Still
        // fire-and-forget and tolerated (plan 90 §3.8's third hook) — a boot-time
        // provisioning sweep must never delay, or be delayed by, the core coming up.
        void agentProvisioner
          .ensureAll()
          .catch((err) => log.warn(`agent-provisioner boot sweep failed, tolerated: ${String(err)}`))
        // Plan 106 §3.5's boot-ordering rule, carried over identically from
        // §96.25 fix 1 above: only now is `adb` genuinely non-null, so this
        // sweep's own `E_ADB_UNAVAILABLE` window is closed the same way.
        void preparationRunner
          .ensureAll()
          .catch((err) => log.warn(`preparation-runner boot sweep failed, tolerated: ${String(err)}`))
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
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      heartbeatInterval = null
      if (reprofileDebounceTimer) clearTimeout(reprofileDebounceTimer)
      reprofileDebounceTimer = null
      server?.stop(true)
      server = null
      stopScheduler?.()
      stopPacer?.()
      stopReaper?.()
      stopCoControlReaper?.()
      stopExpiryReaper?.()
      stopScheduleRunner?.()
      // Plan 93 §5 step 93.3, `00-overview.md` §7 — every active fan-out run's
      // pending members are cancelled, in-flight execs aborted, and every
      // timer cleared, BEFORE `recorder` (its own `record` dep) is torn down
      // a few lines below.
      commandRunner?.stop()
      commandRunner = null
      battery?.stop()
      battery = null
      health?.stop()
      health = null
      adbHealthMonitor?.stop()
      adbHealthMonitor = null
      retention?.stop()
      retention = null
      blobGc?.stop()
      blobGc = null
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
      // Stopped before the registry it depends on (plan 85 §5 step 85.2) —
      // a pending reconcile pass calling into a torn-down registry would be
      // the exact kind of "process left running past stop()" 00-overview §7
      // exists to catch.
      reconciler?.stop()
      reconciler = null
      // No `.stop()` of its own — the ladder holds only an in-memory
      // per-`stableId` mutex map, nothing that outlives the process.
      reconnector = null
      // Unlike the ladder above, an armed cutover DOES hold a live poll
      // timer (plan 88 §3.4, §5 step 88.5) — `stopAll()` clears every one
      // before the hub it would otherwise broadcast into is torn down.
      cutoverManager?.stopAll()
      cutoverManager = null
      await registry?.stop()
      registry = null
      // Plan 85 §3.4, §4.5, §5 step 85.3 (fixes F12) — the backstop. Every
      // scrcpy session's long-lived shell child should already be dead from
      // `sessions?.closeAll()` above calling `ScrcpySession.close()`, but
      // this is what makes that a GUARANTEE rather than a hope: any adb CLI
      // child this instance ever spawned (a still-running install/push, or a
      // long-lived child that missed a clean `close()`) dies here too.
      // Never touches a process it did not itself spawn (see `killAll`'s own
      // doc comment in `host-adb.ts`).
      hostAdb?.killAll()
      hostAdb = null
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
