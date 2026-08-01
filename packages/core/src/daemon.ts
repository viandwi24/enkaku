import { join } from 'node:path'
import { AdbClient } from '@enkaku/adb'
import type { Server } from 'bun'
import type { CoreConfig } from './config'
import { openDb, runMigrations, type OpenedDb } from './db'
import { createDeviceRegistry, type DeviceRegistry } from './registry/device-registry'
import { createApp } from './server/http'
import { WsHub } from './server/ws'
import { createLogger } from './util/logger'
import { resolveToolPath } from './util/tools'

const CORE_VERSION = '0.0.1'

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

  return {
    port: cfg.port,

    async start() {
      const startedAt = Date.now()
      log.info(`data dir: ${cfg.dataDir}`)

      opened = openDb(join(cfg.dataDir, 'enkaku.db'))
      runMigrations(opened.db)
      log.info('db siap (migrasi ter-apply)')

      const adbPath = await resolveToolPath('adb')
      adb = new AdbClient({
        adbPath,
        onLog: (level, msg) => log.child('adb')[level](msg),
      })
      await adb.ensureServer()
      const adbVersion = await adb.version()
      log.info(`adb server ok (version ${adbVersion}) via ${adbPath}`)

      const hub = new WsHub(log.child('ws'))
      registry = createDeviceRegistry({ client: adb, db: opened.db, hub, log: log.child('registry') })
      await registry.start()

      const app = createApp({
        registry,
        log: log.child('http'),
        version: CORE_VERSION,
        adbServerVersion: () => adb!.version(),
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

      log.info(
        `enkaku core v${CORE_VERSION} listen http://${cfg.host}:${cfg.port} ` +
          `(devices terdaftar: ${registry.deviceCount()})`,
      )
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
