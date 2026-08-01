import type { FrameMeta } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { createDeviceProxy, type RemoteSession } from './device-proxy'
import type { TunnelRegistry } from './registry'
import type { TunnelRouter } from './router'

export interface RemoteSessionManager {
  /** Device milik agent? (null = device lokal, tangani seperti biasa) */
  agentIdFor(deviceId: string): string | null
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): Promise<RemoteSession>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): RemoteSession | null
  /** Dipanggil router saat menerima session.started dari agent. */
  onStarted(deviceId: string, info: { codec: 'png' | 'h264'; width: number; height: number }): void
  onFailed(deviceId: string, code: string, message: string): void
  /** Tunnel agent putus → semua sesi device-nya tidak lagi sah. */
  dropAgent(agentId: string): void
  closeAll(): Promise<void>
}

const START_TIMEOUT_MS = 20_000

/**
 * Pengelola sesi device jarak jauh di control plane. Bentuk API-nya sengaja
 * mengikuti `SessionManager` lokal supaya pemanggil hanya perlu memilih
 * salah satu, bukan menulis dua alur berbeda.
 */
export function createRemoteSessionManager(deps: {
  db: Db
  registry: TunnelRegistry
  router: TunnelRouter
  log: Logger
}): RemoteSessionManager {
  const sessions = new Map<string, RemoteSession>()
  const unsubs = new Map<string, Map<unknown, () => void>>()
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()

  return {
    agentIdFor(deviceId) {
      const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
      return row?.agentId ?? null
    },

    async acquire(deviceId, onFrame) {
      let session = sessions.get(deviceId)
      if (!session) {
        if (!deps.registry.forDevice(deviceId)) {
          throw new EnkakuError('agent_offline', 'agent pemilik device sedang tidak terhubung')
        }
        session = createDeviceProxy({ router: deps.router, deviceId })
        sessions.set(deviceId, session)

        // Tunggu agent mengabarkan sesi siap; tanpa ini kita tidak tahu
        // codec & dimensi, dan viewer akan menerima frame yang tak terbaca.
        const started = new Promise<void>((resolve, reject) => {
          pending.set(deviceId, { resolve, reject })
          setTimeout(() => {
            if (pending.delete(deviceId)) reject(new EnkakuError('session_failed', 'agent tidak merespons session.start'))
          }, START_TIMEOUT_MS)
        })
        deps.router.sendToDevice(deviceId, {
          type: 'session.start',
          payload: { deviceId, engines: {} },
        } as never)
        try {
          await started
        } catch (err) {
          sessions.delete(deviceId)
          throw err
        }
      }

      const off = session.onFrame(onFrame)
      const perDevice = unsubs.get(deviceId) ?? new Map()
      perDevice.set(onFrame, off)
      unsubs.set(deviceId, perDevice)
      return session
    },

    release(deviceId, onFrame) {
      const perDevice = unsubs.get(deviceId)
      perDevice?.get(onFrame)?.()
      perDevice?.delete(onFrame)
      if (perDevice && perDevice.size === 0) {
        unsubs.delete(deviceId)
        void sessions.get(deviceId)?.close()
        sessions.delete(deviceId)
      }
    },

    get: (deviceId) => sessions.get(deviceId) ?? null,

    onStarted(deviceId, info) {
      sessions.get(deviceId)?.applyStarted(info)
      pending.get(deviceId)?.resolve()
      pending.delete(deviceId)
      deps.log.info(`sesi remote siap: ${deviceId} (${info.codec} ${info.width}×${info.height})`)
    },

    onFailed(deviceId, code, message) {
      deps.log.warn(`sesi remote gagal: ${deviceId} — ${code}: ${message}`)
      pending.get(deviceId)?.reject(new EnkakuError(code, message))
      pending.delete(deviceId)
      sessions.delete(deviceId)
    },

    dropAgent(agentId) {
      for (const deviceId of [...sessions.keys()]) {
        const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
        if (row?.agentId !== agentId) continue
        deps.log.info(`sesi remote dibatalkan karena agent ${agentId} terputus: ${deviceId}`)
        sessions.delete(deviceId)
        unsubs.delete(deviceId)
        pending.get(deviceId)?.reject(new EnkakuError('agent_offline', 'agent terputus saat sesi dibuat'))
        pending.delete(deviceId)
      }
    },

    async closeAll() {
      for (const session of sessions.values()) await session.close().catch(() => undefined)
      sessions.clear()
      unsubs.clear()
    },
  }
}
