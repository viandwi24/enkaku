import { join } from 'node:path'
import { AdbClient } from '@enkaku/adb'
import { ToolchainManager } from '@enkaku/toolchain'
import type { Server } from 'bun'
import type { CoreConfig } from './config'
import { openDb, runMigrations, type OpenedDb } from './db'
import { devices } from './db/schema'
import { createDeviceRegistry, rowToDeviceInfo, type DeviceRegistry } from './registry/device-registry'
import { createApp } from './server/http'
import { WsHub } from './server/ws'
import { createAdbSwapCoordinator } from './tools/adb-swap'
import { provisionRequiredTools, toolchainEventToMessage } from './tools/provision'
import { createToolInstallStore } from './tools/store'
import { createLogger } from './util/logger'

export const CORE_VERSION = '0.0.1'

/** Tool wajib M1: adb. M4.5 += ui-server; M6 += scrcpy-server. */
const REQUIRED_TOOLS = ['adb']

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

      // 3. HTTP + WS server naik DULU supaya client bisa lihat progress provision
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
        startedAt,
      })
      server = Bun.serve({
        hostname: cfg.host,
        port: cfg.port,
        fetch(req, srv) {
          const url = new URL(req.url)
          if (url.pathname === '/ws') {
            if (srv.upgrade(req, { data: null })) return undefined
            return new Response('upgrade gagal', { status: 400 })
          }
          return app.fetch(req, srv)
        },
        websocket: hub.handlers,
      })
      log.info(`enkaku core v${CORE_VERSION} listen http://${cfg.host}:${cfg.port}`)

      // 4. Provision tool wajib → baru subsistem adb boleh start (gate)
      try {
        await provisionRequiredTools({ manager: toolchain, hub, log: log.child('provision'), required: REQUIRED_TOOLS })
        const adbPath = await toolchain.resolveToolPath('adb')
        adb = new AdbClient({ adbPath, onLog: (level, msg) => log.child('adb')[level](msg) })
        await adb.ensureServer()
        const adbVersion = await adb.version()
        log.info(`adb server ok (version ${adbVersion}) via ${adbPath}`)

        registry = createDeviceRegistry({ client: adb, db, hub, log: log.child('registry') })
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
