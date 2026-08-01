import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { AdbClient } from '@enkaku/adb'
import { ToolchainManager } from '@enkaku/toolchain'
import type { DeviceStatus } from '@enkaku/protocol'
import type { Server } from 'bun'
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
import { createJobRunner } from './runner/job-runner'
import { createScriptExecutor } from './jobs/executors/script'
import type { CoreConfig } from './config'
import { openDb, runMigrations, type OpenedDb } from './db'
import { devices, scripts } from './db/schema'
import { createDeviceStateMachine } from './device/state-machine'
import { createPairingService } from './enroll/pairing'
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
import { createSessionManager, type SessionManager } from './session/manager'
import { createInspectorForSession } from './session/inspector-factory'
import { PortAllocator, parsePortRange } from './session/port-allocator'
import { createAdbSwapCoordinator } from './tools/adb-swap'
import { provisionRequiredTools, toolchainEventToMessage } from './tools/provision'
import { createToolInstallStore } from './tools/store'
import { createLogger } from './util/logger'

export const CORE_VERSION = '0.0.1'

/** Tool wajib: adb (M1) + APK inspector on-device (M4.5). M6 += scrcpy-server. */
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
      log.info('db siap (migrasi ter-apply)')
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
          // drainSessions: no-op di M1 — diisi Plan 04 (drain lease/session hidup)
          log: log.child('adb-swap'),
        }),
      })
      await toolchain.init() // layout + manifest cache + reconcile (adopt pre-baked)

      const settingsStore = createFarmSettingsStore(db)

      // Auth & audit (M7). Mode efektif ditentukan bind address (spec §14).
      const authMode = resolveAuthMode(cfg)
      assertTlsPolicy(cfg, authMode)
      const auth = createAuthService({ db, sessionTtlHours: cfg.auth.sessionTtlHours })
      const audit = createAuditLogger(db)
      if (authMode === 'local') auth.ensureLocalAdmin()
      log.info(
        `auth mode: ${authMode}${authMode === 'server' && !auth.hasAnyAdmin() ? ' (setup admin dibutuhkan)' : ''}`,
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
        onManualRevoked: (deviceId, reason) => hub.broadcast({ type: 'lease.revoked', payload: { deviceId, reason } }),
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

      // 4. HTTP + WS server naik DULU supaya client bisa lihat progress provision
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
        fetch(req, srv) {
          const url = new URL(req.url)
          if (url.pathname === '/ws') {
            // WS tidak selalu membawa cookie → dukung ticket sekali-pakai.
            if (authMode === 'server') {
              const ticket = url.searchParams.get('ticket')
              const cookie = req.headers.get('cookie')?.match(/enkaku_session=([^;]+)/)?.[1]
              const user = ticket ? auth.consumeWsTicket(ticket) : cookie ? auth.validateSession(cookie) : null
              if (!user) return new Response('unauthorized', { status: 401 })
            }
            if (srv.upgrade(req, { data: null })) return undefined
            return new Response('upgrade gagal', { status: 400 })
          }
          return app.fetch(req, srv)
        },
        websocket: hub.handlers,
      })
      const scheme = cfg.tls.mode === 'self' ? 'https' : 'http'
      log.info(`enkaku core v${CORE_VERSION} listen ${scheme}://${cfg.host}:${cfg.port}`)

      // Retention artifact (spec §18) — kebijakan dari farm settings.
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

      // 5. Provision tool wajib → baru subsistem adb boleh start (gate)
      try {
        await provisionRequiredTools({ manager: toolchain, hub, log: log.child('provision'), required: REQUIRED_TOOLS })
        const adbPath = await toolchain.resolveToolPath('adb')
        adb = new AdbClient({ adbPath, onLog: (level, msg) => log.child('adb')[level](msg) })
        await adb.ensureServer()
        const adbVersion = await adb.version()
        log.info(`adb server ok (version ${adbVersion}) via ${adbPath}`)

        // Port pool bersama: ui-server (M4.5) & scrcpy (M6).
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
          db,
          log: log.child('session'),
          makeScrcpy: async (deviceId, transport) => {
            // Jar di-manage Toolchain & versi dikunci ke core (spec §7.6).
            const jarPath = await toolchain.resolveToolPath('scrcpy-server').catch(() => null)
            if (!jarPath) {
              scrcpyLog.info('scrcpy-server belum ter-provision — memakai fallback screencap-loop')
              return null
            }
            const port = await ports.claim(`scrcpy:${deviceId}`)
            return startScrcpySession(
              { serial: transport.serial, exec: (cmd) => transport.exec(cmd), hostAdb },
              { jarPath, port, onLog: (level, msg) => scrcpyLog[level](msg) },
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

        // Script executor (M4) butuh SessionManager → didaftarkan setelah adb siap.
        const runner = createJobRunner({
          db,
          dataDir: cfg.dataDir,
          sessions,
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
          onArtifact: (jobId, artifact) => hub.broadcast({ type: 'job.artifact', payload: { jobId, artifact } }),
          onPhase: (jobId, attempt, phase) => {
            const info = jobService.get(jobId)
            if (info) hub.broadcast({ type: 'job.status', payload: { ...info, attempt, phase } })
          },
          heartbeat: (jobId) => jobStore.renewLease(jobId, cfg.lease.jobTtlSec),
        })
        executors.setFallback(createScriptExecutor({ db, runner }))
        hub.setRouter(
          createWsMessageHandler({
            sessions,
            pairing: createPairingService({ client: adb, log: log.child('pairing') }),
            leases,
            jobs: jobService,
            log: log.child('ws-handler'),
          }),
        )

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
          onDeviceGone: (deviceId) => {
            void sessions?.closeDevice(deviceId)
            // Job yang sedang jalan di device itu → failed (spec §10.1).
            const running = jobStore.runningByDevice(deviceId)
            if (running) host.finishExternally(running.id, 'failed', 'device disconnected')
          },
          onDeviceReady: () => scheduler?.kick(),
        })
        await registry.start()
        adbState = 'ready'
        log.info(`subsistem adb siap (devices terdaftar: ${db.select().from(devices).all().length})`)
      } catch (err) {
        adbState = 'error'
        // Core tetap hidup: API tools masih bisa dipakai untuk retry install.
        log.error(`subsistem adb gagal start: ${String(err)} — core tetap hidup, retry via /api/tools`)
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
