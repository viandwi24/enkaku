import type { AdbClient } from '@enkaku/adb'
import type { FrameMeta } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { Logger } from './logger'
import { createSession, type CreateSessionDeps, type DeviceSession } from './session'
import type { DeviceSnapshotSource } from './types'

const GRACE_MS = 5000

interface Entry {
  session: DeviceSession
  refcount: number
  frameSubscribers: Set<(chunk: Uint8Array, meta: FrameMeta) => void>
  closeTimer: ReturnType<typeof setTimeout> | null
}

export interface SessionManager {
  /** Create or fetch the single session for a device and bump its refcount. */
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): Promise<DeviceSession>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): DeviceSession | null
  /** The device vanished from track-devices → force it closed. */
  closeDevice(deviceId: string): Promise<void>
  closeAll(): Promise<void>
}

/**
 * One DisplaySource per device is shared across every viewer; the capture
 * loop only runs while there is at least one subscriber (saves device battery).
 */
export function createSessionManager(deps: {
  client: AdbClient
  devices: DeviceSnapshotSource
  log: Logger
  makeInspector?: CreateSessionDeps['makeInspector']
  makeScrcpy?: CreateSessionDeps['makeScrcpy']
  /** The session died on its own (device unplugged, capture failed) — viewers need to know. */
  onSessionEnded?: (deviceId: string, reason: string) => void
}): SessionManager {
  const entries = new Map<string, Entry>()

  const dispatchFrame = (deviceId: string) => (chunk: Uint8Array, meta: FrameMeta) => {
    const entry = entries.get(deviceId)
    if (!entry) return
    for (const cb of entry.frameSubscribers) cb(chunk, meta)
  }

  async function closeEntry(deviceId: string): Promise<void> {
    const entry = entries.get(deviceId)
    if (!entry) return
    entries.delete(deviceId)
    if (entry.closeTimer) clearTimeout(entry.closeTimer)
    await entry.session.close().catch((err) => deps.log.warn(`failed to close session ${deviceId}: ${String(err)}`))
    deps.log.info(`session closed: ${deviceId}`)
  }

  return {
    async acquire(deviceId, onFrame) {
      const existing = entries.get(deviceId)
      if (existing) {
        if (existing.closeTimer) {
          clearTimeout(existing.closeTimer)
          existing.closeTimer = null
        }
        existing.refcount++
        existing.frameSubscribers.add(onFrame)
        return existing.session
      }

      const row = deps.devices.get(deviceId)
      if (!row) throw new SessionError('device_not_found', `no such device: ${deviceId}`)
      if (row.status === 'offline') {
        throw new SessionError('device_not_ready', `device ${row.label} is offline`)
      }

      const session = await createSession(
        {
          deviceId,
          serial: row.serial,
          stableId: row.stableId,
          transport: row.transport,
          display: row.display,
          input: row.input,
          inspection: row.inspection,
          apiLevel: row.apiLevel,
          preferredInputMode: row.preferredInputMode,
          ...(row.stayAwake !== undefined ? { stayAwake: row.stayAwake } : {}),
          screenW: row.screenW,
          screenH: row.screenH,
        },
        {
          client: deps.client,
          log: deps.log.child(`session:${row.label}`),
          onFrame: dispatchFrame(deviceId),
          onDisplayError: (err) => {
            deps.log.warn(`display error on ${deviceId}: ${String(err)} — closing the session`)
            deps.onSessionEnded?.(deviceId, err instanceof Error ? err.message : String(err))
            void closeEntry(deviceId)
          },
          ...(deps.makeInspector ? { makeInspector: deps.makeInspector } : {}),
          ...(deps.makeScrcpy ? { makeScrcpy: deps.makeScrcpy } : {}),
        },
      )
      const entry: Entry = { session, refcount: 1, frameSubscribers: new Set([onFrame]), closeTimer: null }
      entries.set(deviceId, entry)
      await session.display.start()
      deps.log.info(`session opened: ${row.label} (${deviceId})`)
      return session
    },

    release(deviceId, onFrame) {
      const entry = entries.get(deviceId)
      if (!entry) return
      entry.frameSubscribers.delete(onFrame)
      entry.refcount = Math.max(0, entry.refcount - 1)
      if (entry.refcount > 0) return
      // Grace period: a viewer that reconnects quickly does not restart the loop.
      entry.closeTimer = setTimeout(() => void closeEntry(deviceId), GRACE_MS)
    },

    get(deviceId) {
      return entries.get(deviceId)?.session ?? null
    },

    closeDevice: closeEntry,

    async closeAll() {
      await Promise.all([...entries.keys()].map(closeEntry))
    },
  }
}
