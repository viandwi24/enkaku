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
  /** Is this device owned by an agent? (null means local — handle it normally) */
  agentIdFor(deviceId: string): string | null
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): Promise<RemoteSession>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): RemoteSession | null
  /** Called by the router on receiving session.started from an agent. */
  onStarted(deviceId: string, info: { codec: 'png' | 'h264'; width: number; height: number }): void
  onFailed(deviceId: string, code: string, message: string): void
  /** An agent's tunnel dropped → every session for its devices is void. */
  dropAgent(agentId: string): void
  closeAll(): Promise<void>
}

const START_TIMEOUT_MS = 20_000

/**
 * Manages remote device sessions in the control plane. Its API deliberately
 * mirrors the local `SessionManager`, so callers pick one or the other rather
 * than writing two different flows.
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
          throw new EnkakuError('agent_offline', 'the agent that owns this device is currently disconnected')
        }
        session = createDeviceProxy({ router: deps.router, deviceId })
        sessions.set(deviceId, session)

        // Wait for the agent to report readiness; without it we do not know the
        // codec or dimensions, and the viewer would get undecodable frames.
        const started = new Promise<void>((resolve, reject) => {
          pending.set(deviceId, { resolve, reject })
          setTimeout(() => {
            if (pending.delete(deviceId)) reject(new EnkakuError('session_failed', 'the agent did not respond to session.start'))
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
      deps.log.info(`remote session ready: ${deviceId} (${info.codec} ${info.width}×${info.height})`)
    },

    onFailed(deviceId, code, message) {
      deps.log.warn(`remote session failed: ${deviceId} — ${code}: ${message}`)
      pending.get(deviceId)?.reject(new EnkakuError(code, message))
      pending.delete(deviceId)
      sessions.delete(deviceId)
    },

    dropAgent(agentId) {
      for (const deviceId of [...sessions.keys()]) {
        const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
        if (row?.agentId !== agentId) continue
        deps.log.info(`remote session cancelled because agent ${agentId} disconnected: ${deviceId}`)
        sessions.delete(deviceId)
        unsubs.delete(deviceId)
        pending.get(deviceId)?.reject(new EnkakuError('agent_offline', 'the agent disconnected while the session was being created'))
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
