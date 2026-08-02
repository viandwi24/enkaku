import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { AdbClient } from '@enkaku/adb'
import { ToolchainManager } from '@enkaku/toolchain'
import type { DeviceStatus } from '@enkaku/protocol'
import type { Server } from 'bun'
import { createAgentRoutes } from './api/agents'
import { createAgentAuth } from './tunnel/agent-auth'
import { createTunnelRegistry } from './tunnel/registry'
import { createTunnelRouter } from './tunnel/router'
import { createRemoteSessionManager, type RemoteSessionManager } from './tunnel/remote-sessions'
import { createRemoteJobBridge } from './jobs/executors/remote'
import { createWebRtcRelay } from './relay/webrtc-relay'
import { createWeriftFactory } from './relay/werift-peer'
import { createAuditLogger } from './auth/audit'
import { createAuthRoutes } from './auth/routes'
import { createAuthService } from './auth/service'
import { createRetentionGc, type RetentionGc } from './maintenance/retention'
import { assertTlsPolicy, resolveAuthMode } from './config'
import { createArtifactRoutes } from './api/artifacts'
import { createDeviceRoutes } from './api/devices'
import { createJobRoutes } from './api/jobs'
import { createSettingsRoutes } from './api/settings'
import { createBatteryMonitor, type BatteryMonitor } from './device/battery'
import { createFarmSettingsStore } from './settings/farm-settings'
import { buildRegistryResponse } from './registry/engines'
import { createScriptRoutes } from './scripts/routes'
import { createJobRunner, createSessionManager, createInspectorForSession, PortAllocator, parsePortRange, type SessionManager } from '@enkaku/session'
import { createScriptExecutor } from './jobs/executors/script'
import type { CoreConfig } from './config'
import { openDb, runMigrations, type OpenedDb } from './db'
import { devices, scripts } from './db/schema'
import { createDeviceStateMachine } from './device/state-machine'
import { createPairingService, type PairingService } from './enroll/pairing'
import { EnkakuError } from './util/errors'
import { ExecutorRegistry } from './jobs/executor'
import { createExecutorHost } from './jobs/executor-host'
import { sleepExecutor } from './jobs/executors/sleep'
import { createLeaseManager } from './lease/lease-manager'
import { createJobStore } from './queue/job-store'
import { createScheduler } from './queue/scheduler'
import { createDeviceRegistry, rowToDeviceInfo, type DeviceRegistry } from './registry/device-registry'
import { createApp } from './server/http'
import { WsHub } from './server/ws'
import { createWsMessageHandler } from './server/ws-handlers'
import { createJobService } from './services/job-service'
import { startScrcpySession } from '@enkaku/scrcpy'
import { createDbArtifactSink, createDbDeviceSource } from './session/adapters'
import { materializeBundle } from './scripts/bundle-cache'
import { createAdbSwapCoordinator } from './tools/adb-swap'
import { provisionRequiredTools, toolchainEventToMessage } from './tools/provision'
import { createToolInstallStore } from './tools/store'
import { createLogger } from './util/logger'

import pkg from '../package.json'

export const CORE_VERSION = pkg.version

/** Required tools: adb (M1) and the on-device inspector APKs (M4.5). M6 adds scrcpy-server. */
const REQUIRED_TOOLS = ['adb', 'ui-server', 'ui-server-test', 'scrcpy-server']

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
  let remoteSessions: RemoteSessionManager | null = null
  let webrtcRelayRef: ReturnType<typeof createWebRtcRelay> | null = null
  let retention: RetentionGc | null = null
  let stopScheduler: (() => void) | null = null
  let stopReaper: (() => void) | null = null
  let stopped = false
  let adbState = 'provisioning'

  return {
    port: cfg.port,

    async start() {
      const startedAt = Date.now()
      log.info(`data dir: ${cfg.dataDir}`)

      // 1. DB + migrasi
      opened = openDb(join(cfg.dataDir, 'enkaku.db'))
      runMigrations(opened.db)
      log.info('db ready (migrations applied)')
      const db = opened.db

      // 2. WS hub + Toolchain Manager (emit → broadcast)
      const hub = new WsHub(log.child('ws'))
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

      const settingsStore = createFarmSettingsStore(db)

      // Auth and audit (M7). The effective mode follows the bind address (spec §14).
      const authMode = resolveAuthMode(cfg)
      assertTlsPolicy(cfg, authMode)
      const auth = createAuthService({ db, sessionTtlHours: cfg.auth.sessionTtlHours })
      const agentAuth = createAgentAuth(db)

      // Cloud mode (spec §5.3): the orchestrator holds no local devices;
      // devices arrive from agents over their outbound tunnels.
      const isOrchestrator = process.env.ENKAKU_MODE === 'orchestrator'
      const tunnelRegistry = createTunnelRegistry({
        db,
        log: log.child('tunnel'),
        onDevicesChanged: () => scheduler?.kick(),
        // The tunnel dropped → that agent's remote sessions are no longer valid.
        onAgentGone: (agentId) => remoteSessions?.dropAgent(agentId),
      })
      // Hook di-set setelah remote manager & job bridge dibuat (siklus wiring).
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
      })

      // Pairing needs adb; in orchestrator mode enrollment happens on the agent.
      let pairingService: PairingService = {
        async request() {
          throw new EnkakuError('not_supported_in_mode', 'wireless pairing happens on the agent, not the control plane')
        },
        async submitCode() {
          return { success: false, message: 'wireless pairing happens on the agent, not the control plane' }
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
        onChange: broadcastDeviceStatus,
      })

      const executors = new ExecutorRegistry()
      executors.register('internal:sleep', sleepExecutor)

      let scheduler: ReturnType<typeof createScheduler> | null = null
      let leaseManager: ReturnType<typeof createLeaseManager> | null = null
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
      })

      const leases = createLeaseManager({
        states,
        jobStore,
        config: {
          jobTtlSec: cfg.lease.jobTtlSec,
          manualIdleTimeoutSec: cfg.lease.manualIdleTimeoutSec,
          reaperIntervalMs: cfg.lease.reaperIntervalMs,
        },
        log: log.child('lease'),
        onJobLeaseExpired: (jobId, reason) => host.finishExternally(jobId, 'failed', reason),
        onManualRevoked: (deviceId, reason) => {
          hub.broadcast({ type: 'lease.revoked', payload: { deviceId, reason } })
          // The holder learns why from lease.revoked; everyone else just needs
          // to know the device is free again.
          hub.broadcast({ type: 'lease.changed', payload: { deviceId, held: false, expiresAt: null } })
        },
        onDeviceFreed: () => scheduler?.kick(),
      })
      leaseManager = leases

      scheduler = createScheduler({
        jobStore,
        host,
        log: log.child('scheduler'),
        jobTtlSec: cfg.lease.jobTtlSec,
        fallbackIntervalMs: cfg.scheduler.fallbackIntervalMs,
        onJobStatus: (info) => hub.broadcast({ type: 'job.status', payload: info }),
        onDeviceBusy: (deviceId) => broadcastDeviceStatus(deviceId, 'busy'),
      })

      const jobService = createJobService({
        jobStore,
        registry: executors,
        scheduler,
        host,
        log: log.child('job'),
        onJobStatus: (info) => hub.broadcast({ type: 'job.status', payload: info }),
        findScript: (scriptId) => {
          const row = db.select().from(scripts).where(eq(scripts.id, scriptId)).get()
          return row ? { enabled: row.enabled ?? true } : null
        },
      })

      // Remote jobs: a device owned by an agent runs on that agent (plan 12 §4.5).
      const remoteBridge = createRemoteJobBridge({
        db,
        router: tunnelRouter,
        log: log.child('remote-job'),
        hooks: {
          onLog: (jobId, entry) =>
            hub.broadcast({
              type: 'job.log',
              payload: {
                jobId,
                ts: entry.ts,
                level: entry.level as 'debug' | 'info' | 'warn' | 'error',
                source: entry.source as 'script' | 'stdout' | 'stderr' | 'runner',
                msg: entry.msg,
              },
            }),
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
            kind: a.kind as 'screenshot' | 'log' | 'file' | 'video',
            label: a.label,
            path: saved.path,
            sizeBytes: saved.sizeBytes,
            createdAt: Math.floor(Date.now() / 1000),
          }
        },
      })
      onJobProgress = (p) => remoteBridge.handleProgress(p)
      // Agent-owned devices use the remote executor; local devices use the
      // in-process runner (registered once adb is ready).
      executors.setFallback(remoteBridge.executor)

      // The WebRTC relay serves agent-owned devices (cloud mode). On a LAN,
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

      // 4. HTTP and WS come up FIRST so clients can watch provisioning progress
      const app = createApp({
        listDevices: () => db.select().from(devices).all().map(rowToDeviceInfo),
        deviceCount: () => db.select().from(devices).all().length,
        log: log.child('http'),
        version: CORE_VERSION,
        adbServerVersion: async () => {
          if (!adb) return null
          return adb.version().catch(() => null)
        },
        adbState: () => adbState,
        toolchain,
        jobRoutes: createJobRoutes(jobService),
        deviceRoutes: createDeviceRoutes({
          db,
          registry: () => buildRegistryResponse(toolchain),
          battery: () => battery,
        }),
        settingsRoutes: createSettingsRoutes(settingsStore),
        artifactRoutes: createArtifactRoutes({ db, dataDir: cfg.dataDir }),
        authRoutes: createAuthRoutes({
          auth,
          audit,
          mode: authMode,
          secureCookie: cfg.tls.mode !== 'off',
          maxAttempts: cfg.auth.loginMaxAttempts,
          lockoutSeconds: cfg.auth.loginLockoutSeconds,
        }),
        agentRoutes: createAgentRoutes({ agentAuth }),
        auth,
        authMode,
        scriptRoutes: createScriptRoutes({ db, ...(process.env.ENKAKU_PUBLISH_TOKEN ? { publishToken: process.env.ENKAKU_PUBLISH_TOKEN } : {}) }),
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
          // The agent tunnel authenticates with the credential from enrollment.
          if (url.pathname === '/agent/ws') {
            const agentId = await agentAuth.verify(req.headers.get('authorization'))
            if (!agentId) return new Response('unauthorized', { status: 401 })
            if (srv.upgrade(req, { data: { agentId } })) return undefined
            return new Response('upgrade failed', { status: 400 })
          }
          if (url.pathname === '/ws') {
            // A WS handshake does not always carry cookies → support single-use tickets.
            if (authMode === 'server') {
              const ticket = url.searchParams.get('ticket')
              const cookie = req.headers.get('cookie')?.match(/enkaku_session=([^;]+)/)?.[1]
              const user = ticket ? auth.consumeWsTicket(ticket) : cookie ? auth.validateSession(cookie) : null
              if (!user) return new Response('unauthorized', { status: 401 })
            }
            if (srv.upgrade(req, { data: null })) return undefined
            return new Response('upgrade failed', { status: 400 })
          }
          return app.fetch(req, srv)
        },
        websocket: {
          open: (ws) => {
            const agentId = (ws.data as { agentId?: string } | null)?.agentId
            if (agentId) {
              tunnelRegistry.attach(agentId, ws)
              return
            }
            hub.handlers.open?.(ws)
          },
          close: (ws, code, reason) => {
            const agentId = (ws.data as { agentId?: string } | null)?.agentId
            if (agentId) {
              tunnelRegistry.detach(ws)
              return
            }
            hub.handlers.close?.(ws, code, reason)
          },
          message: (ws, message) => {
            const agentId = (ws.data as { agentId?: string } | null)?.agentId
            if (agentId) {
              if (typeof message === 'string') tunnelRouter.handleAgentMessage(ws, agentId, message)
              else tunnelRouter.handleAgentFrame(agentId, new Uint8Array(message))
              return
            }
            hub.handlers.message?.(ws, message)
          },
        },
      })
      const scheme = cfg.tls.mode === 'self' ? 'https' : 'http'
      log.info(`enkaku core v${CORE_VERSION} listen ${scheme}://${cfg.host}:${cfg.port}`)

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
      scheduler.start()
      const sched = scheduler
      stopScheduler = () => sched.stop()

      // The WS router is attached in EVERY mode. Under the orchestrator,
      // `sessions` is null and all device work is served through agents —
      // without this, browser requests were silently ignored (the bug Plan 12 fixed).
      const attachWsRouter = (localSessions: SessionManager | null) =>
        hub.setRouter(
          createWsMessageHandler({
            sessions: localSessions,
            ...(remoteSessions ? { remote: remoteSessions } : {}),
            webrtc: webrtcRelay,
            pairing: pairingService,
            leases,
            jobs: jobService,
            broadcast: (msg) => hub.broadcast(msg),
            log: log.child('ws-handler'),
          }),
        )

      if (isOrchestrator) {
        // The orchestrator never touches adb or a local device.
        adbState = 'orchestrator'
        attachWsRouter(null)
        log.info('mode orchestrator: menunggu agent connect di /agent/ws')
        return
      }

      // 5. Provision the required tools → only then may the adb subsystem start (a gate)
      try {
        await provisionRequiredTools({ manager: toolchain, hub, log: log.child('provision'), required: REQUIRED_TOOLS })
        const adbPath = await toolchain.resolveToolPath('adb')
        adb = new AdbClient({ adbPath, onLog: (level, msg) => log.child('adb')[level](msg) })
        await adb.ensureServer()
        const adbVersion = await adb.version()
        log.info(`adb server ok (version ${adbVersion}) via ${adbPath}`)

        // A shared port pool: ui-server (M4.5) and scrcpy (M6).
        const ports = new PortAllocator(parsePortRange(process.env.ENKAKU_UI_SERVER_PORT_RANGE))
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
          makeScrcpy: async (deviceId, transport) => {
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
            return startScrcpySession(
              { serial: transport.serial, exec: (cmd) => transport.exec(cmd), hostAdb },
              { jarPath, onLog: (level, msg) => scrcpyLog[level](msg) },
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
                onFallback: (deviceId, from, to, reason) =>
                  hub.broadcast({ type: 'device.inspector.fallback', payload: { deviceId, from, to, reason } }),
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
          onLog: (entry) =>
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
            }),
          onArtifact: () => {
            // The sink already broadcast this when it wrote the DB row.
          },
          onPhase: (jobId, attempt, phase) => {
            const info = jobService.get(jobId)
            if (info) hub.broadcast({ type: 'job.status', payload: { ...info, attempt, phase } })
          },
          heartbeat: (jobId) => jobStore.renewLease(jobId, cfg.lease.jobTtlSec),
        })
        const localExecutor = createScriptExecutor({ db, dataDir: cfg.dataDir, runner })
        executors.setFallback({
          validateParams: (params) => localExecutor.validateParams(params),
          run: (job, ctx) => {
            // Agent-owned device → run it on the agent; otherwise run locally.
            const owner = remoteSessions?.agentIdFor(job.deviceId) ?? null
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
        })
        battery.start()

        registry = createDeviceRegistry({
          client: adb,
          db,
          hub,
          log: log.child('registry'),
          states,
          // A newly enrolled device inherits the farm defaults (spec §12).
          deviceDefaults: () => settingsStore.get().defaults,
          onDeviceGone: (deviceId) => {
            void sessions?.closeDevice(deviceId)
            // Any job running on that device → failed (spec §10.1).
            const running = jobStore.runningByDevice(deviceId)
            if (running) host.finishExternally(running.id, 'failed', 'device disconnected')
          },
          onDeviceReady: () => scheduler?.kick(),
        })
        await registry.start()
        adbState = 'ready'
        log.info(`adb subsystem ready (devices registered: ${db.select().from(devices).all().length})`)
      } catch (err) {
        adbState = 'error'
        // The core stays up: the tools API can still be used to retry the install.
        log.error(`adb subsystem failed to start: ${String(err)} — the core stays up, retry via /api/tools`)
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
      battery?.stop()
      battery = null
      retention?.stop()
      retention = null
      await sessions?.closeAll()
      sessions = null
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
      log.info('stopped')
    },
  }
}
