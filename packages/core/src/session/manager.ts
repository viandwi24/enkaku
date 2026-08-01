import type { AdbClient } from '@enkaku/adb'
import type { FrameMeta } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { createSession, type CreateSessionDeps, type DeviceSession } from './session'

const GRACE_MS = 5000

interface Entry {
  session: DeviceSession
  refcount: number
  frameSubscribers: Set<(chunk: Uint8Array, meta: FrameMeta) => void>
  closeTimer: ReturnType<typeof setTimeout> | null
}

export interface SessionManager {
  /** Buat/ambil sesi tunggal per device + naikkan refcount. */
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): Promise<DeviceSession>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): DeviceSession | null
  /** Device hilang dari track-devices → tutup paksa. */
  closeDevice(deviceId: string): Promise<void>
  closeAll(): Promise<void>
}

/**
 * Satu DisplaySource per device di-share ke semua viewer; loop capture
 * hidup hanya saat subscriber > 0 (hemat baterai device).
 */
export function createSessionManager(deps: {
  client: AdbClient
  db: Db
  log: Logger
  makeInspector?: CreateSessionDeps['makeInspector']
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
    await entry.session.close().catch((err) => deps.log.warn(`gagal menutup sesi ${deviceId}: ${String(err)}`))
    deps.log.info(`sesi ditutup: ${deviceId}`)
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

      const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
      if (!row) throw new EnkakuError('E_DEVICE_NOT_FOUND', `device tidak ada: ${deviceId}`)
      if (row.status === 'offline') {
        throw new EnkakuError('E_DEVICE_NOT_READY', `device ${row.label} sedang offline`)
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
          screenW: row.screenW,
          screenH: row.screenH,
        },
        {
          client: deps.client,
          log: deps.log.child(`session:${row.label}`),
          onFrame: dispatchFrame(deviceId),
          onDisplayError: (err) => {
            deps.log.warn(`display error ${deviceId}: ${String(err)} — menutup sesi`)
            void closeEntry(deviceId)
          },
          ...(deps.makeInspector ? { makeInspector: deps.makeInspector } : {}),
        },
      )
      const entry: Entry = { session, refcount: 1, frameSubscribers: new Set([onFrame]), closeTimer: null }
      entries.set(deviceId, entry)
      await session.display.start()
      deps.log.info(`sesi dibuka: ${row.label} (${deviceId})`)
      return session
    },

    release(deviceId, onFrame) {
      const entry = entries.get(deviceId)
      if (!entry) return
      entry.frameSubscribers.delete(onFrame)
      entry.refcount = Math.max(0, entry.refcount - 1)
      if (entry.refcount > 0) return
      // Grace: viewer yang reconnect cepat tidak memicu restart loop.
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
