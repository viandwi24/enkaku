import type { AdbClient } from '@enkaku/adb'
import type { FrameMeta, SessionPhase } from '@enkaku/protocol'
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
  /** Session start-up phases, tagged with the device they belong to (Plan 17 §3.3, §4.3). */
  onPhase?: (deviceId: string, phase: SessionPhase, detail?: string) => void
  /** Device event log: session.opened / session.closed (Plan 18 §4.2). */
  onEvent?: (deviceId: string, kind: string, meta: Record<string, unknown>) => void
}): SessionManager {
  const entries = new Map<string, Entry>()

  const dispatchFrame = (deviceId: string) => (chunk: Uint8Array, meta: FrameMeta) => {
    const entry = entries.get(deviceId)
    if (!entry) return
    for (const cb of entry.frameSubscribers) cb(chunk, meta)
  }

  async function closeEntry(deviceId: string, reason = 'released'): Promise<void> {
    const entry = entries.get(deviceId)
    if (!entry) return
    entries.delete(deviceId)
    if (entry.closeTimer) clearTimeout(entry.closeTimer)
    await entry.session.close().catch((err) => deps.log.warn(`failed to close session ${deviceId}: ${String(err)}`))
    deps.onEvent?.(deviceId, 'session.closed', { reason })
    deps.log.info(`session closed: ${deviceId}`)
  }

  /** Build one session for a device. Serialised by `inFlight` above. */
  async function createEntry(deviceId: string): Promise<Entry> {
    const row = deps.devices.get(deviceId)
    if (!row) throw new SessionError('device_not_found', `no such device: ${deviceId}`)
    if (row.status === 'offline') {
      throw new SessionError('device_not_ready', `device ${row.label} is offline`)
    }

    // Assigned as soon as createSession resolves; onDisplayError compares
    // against it to tell "my session died" from "some other session died".
    let created: DeviceSession | null = null
    const onPhase = deps.onPhase
      ? (phase: SessionPhase, detail?: string) => deps.onPhase!(deviceId, phase, detail)
      : undefined
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
        ...(row.keepAwake !== undefined ? { keepAwake: row.keepAwake } : {}),
        ...(row.standbyScreenOff !== undefined ? { standbyScreenOff: row.standbyScreenOff } : {}),
        screenW: row.screenW,
        screenH: row.screenH,
      },
      {
        client: deps.client,
        log: deps.log.child(`session:${row.label}`),
        onFrame: dispatchFrame(deviceId),
        onDisplayError: (err) => {
          const reason = err instanceof Error ? err.message : String(err)
          // Only the session currently published may tear its entry down.
          //
          // Closing a session ends its sockets, which fires this callback a
          // moment later — by which time a replacement may already be serving
          // the device. Without this guard a routine close, or any session left
          // behind by an earlier race, takes the healthy one with it.
          const current = entries.get(deviceId)?.session
          if (current !== undefined && current !== created) {
            deps.log.debug(`ignoring a display error from a session no longer in use on ${deviceId}: ${reason}`)
            return
          }
          deps.log.warn(`display error on ${deviceId}: ${reason} — closing the session`)
          deps.onSessionEnded?.(deviceId, reason)
          void closeEntry(deviceId, reason)
        },
        ...(deps.makeInspector ? { makeInspector: deps.makeInspector } : {}),
        ...(deps.makeScrcpy ? { makeScrcpy: deps.makeScrcpy } : {}),
        ...(onPhase ? { onPhase } : {}),
        onInputDegraded: (from, to, reason) => deps.onEvent?.(deviceId, 'session.degraded', { from, to, reason }),
      },
    )
    created = session
    // No subscribers and refcount 0: every caller of `acquire` attaches
    // itself once this resolves, including the one that started the work.
    const entry: Entry = { session, refcount: 0, frameSubscribers: new Set(), closeTimer: null }
    entries.set(deviceId, entry)
    await session.display.start()
    // Sockets are up but no frame has arrived yet — the last phase before
    // `ready`, which session.ts emits itself from the first onFrame (§4.3).
    onPhase?.('waiting-frame')
    deps.onEvent?.(deviceId, 'session.opened', {
      display: session.displayEngineId,
      input: session.inputEngineId,
      // The requested engine, not the (possibly still-starting) effective
      // one — the inspector is lazy and this must not force it awake.
      inspection: row.inspection ?? 'ui-server',
    })
    deps.log.info(`session opened: ${row.label} (${deviceId})`)
    return entry
  }

  /**
   * Creations already running, keyed by device.
   *
   * Starting a session takes the better part of a second (push the jar, launch
   * scrcpy-server, connect two sockets). `acquire` used to check `entries` and
   * then await that work with nothing marking the device as busy, so two
   * `stream.start` messages arriving 50 ms apart both saw an empty map and both
   * built a session. The second `entries.set` orphaned the first — and when the
   * orphan's socket later closed, its `onDisplayError` tore down whichever entry
   * was current by then, killing a perfectly healthy session. The log read
   * `session opened` / `display error` / `session opened` / `display error`,
   * and the viewer never got a frame.
   */
  const inFlight = new Map<string, Promise<Entry>>()

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

      let pending = inFlight.get(deviceId)
      if (!pending) {
        pending = createEntry(deviceId)
        inFlight.set(deviceId, pending)
        void pending.catch(() => undefined).finally(() => inFlight.delete(deviceId))
      }
      // Every caller attaches itself, including the one that started the work:
      // `createEntry` deliberately returns an entry with no subscribers.
      const entry = await pending
      if (entry.closeTimer) {
        clearTimeout(entry.closeTimer)
        entry.closeTimer = null
      }
      entry.refcount++
      entry.frameSubscribers.add(onFrame)
      return entry.session
    },

    release(deviceId, onFrame) {
      const entry = entries.get(deviceId)
      if (!entry) return
      entry.frameSubscribers.delete(onFrame)
      entry.refcount = Math.max(0, entry.refcount - 1)
      if (entry.refcount > 0) return
      // Grace period: a viewer that reconnects quickly does not restart the loop.
      entry.closeTimer = setTimeout(() => void closeEntry(deviceId, 'no_viewers'), GRACE_MS)
    },

    get(deviceId) {
      return entries.get(deviceId)?.session ?? null
    },

    closeDevice: (deviceId) => closeEntry(deviceId, 'device_gone'),

    async closeAll() {
      await Promise.all([...entries.keys()].map((id) => closeEntry(id, 'shutdown')))
    },
  }
}
