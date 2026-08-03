import type { AdbClient } from '@enkaku/adb'
import type { FrameMeta, Quality, SessionPhase } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { Logger } from './logger'
import { createSession, type CreateSessionDeps, type DeviceSession } from './session'
import type { DeviceSnapshotSource } from './types'

/** Legacy fallback when `idleTtlSec` is not supplied (agent mode, tests) — the
 * quick-reconnect grace this manager always had before Plan 42 made it configurable. */
const DEFAULT_IDLE_TTL_SEC = 5

interface Entry {
  session: DeviceSession
  refcount: number
  frameSubscribers: Set<(chunk: Uint8Array, meta: FrameMeta) => void>
  closeTimer: ReturnType<typeof setTimeout> | null
  /** Unix ms when refcount last reached 0, or null while it has a subscriber. Drives LRU eviction (Plan 42 §4.4). */
  idleSince: number | null
}

export interface SessionManager {
  /** Create or fetch the single session for a device and bump its refcount.
   * `quality` (Plan 42 §4.5) defaults to `control`; requesting `control`
   * against a session that came up at `wall` upgrades it (restart, never a
   * silent downgrade the other way). */
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void, quality?: Quality): Promise<DeviceSession>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): DeviceSession | null
  /** The device vanished from track-devices → force it closed. */
  closeDevice(deviceId: string): Promise<void>
  /**
   * A job is about to claim this device, or it just went quarantined (Plan 42
   * §3.4, §6.8) — close the session NOW if it is currently idle (no
   * subscriber), so a scheduler claim is never left waiting on an idle TTL,
   * and the job starts a fresh session rather than inheriting a stale
   * `wall`-quality one. A no-op when the device has an active viewer: video
   * keeps streaming while a device is busy (spec §10.1), so a live session is
   * never torn down out from under a watcher.
   */
  closeIfIdle(deviceId: string): Promise<void>
  /** Idle sessions currently held open, oldest first — for `/api/adb/stats` (Plan 42 §4.4). */
  idleSessions(): { deviceId: string; idleSince: number }[]
  closeAll(): Promise<void>
}

export interface SessionManagerDeps {
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
  /** Seconds a session stays alive with no subscriber (Plan 42 §4.4). 0 closes it immediately. Read fresh on every release. */
  idleTtlSec?: () => number
  /** How many idle sessions may be held open across the farm before the least-recently-idle is evicted (Plan 42 §4.4). Read fresh on every release. Omitted/Infinity = no cap. */
  maxIdleSessions?: () => number
}

/**
 * One DisplaySource per device is shared across every viewer; the capture
 * loop only runs while there is at least one subscriber (saves device battery).
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const entries = new Map<string, Entry>()
  const idleTtlSec = deps.idleTtlSec ?? (() => DEFAULT_IDLE_TTL_SEC)
  const maxIdleSessions = deps.maxIdleSessions ?? (() => Infinity)

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

  /**
   * Enforce `maxIdleSessions` (Plan 42 §4.4, acceptance #9): once the number
   * of entries currently idle (no subscriber, sitting on their TTL timer)
   * exceeds the cap, the least-recently-idle ones are closed immediately —
   * not merely scheduled — so the farm never holds more idle sessions than
   * the setting allows, even for the instant between two releases.
   */
  function enforceIdleCap(): void {
    const cap = maxIdleSessions()
    if (!Number.isFinite(cap)) return
    const idle = [...entries.entries()]
      .filter(([, e]) => e.idleSince !== null)
      .sort(([, a], [, b]) => (a.idleSince as number) - (b.idleSince as number))
    while (idle.length > cap) {
      const [deviceId] = idle.shift()!
      void closeEntry(deviceId, 'idle_evicted')
    }
  }

  /** Build one session for a device. Serialised by `inFlight` above. */
  async function createEntry(deviceId: string, quality: Quality): Promise<Entry> {
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
        quality,
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
    const entry: Entry = { session, refcount: 0, frameSubscribers: new Set(), closeTimer: null, idleSince: null }
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
      quality: session.quality,
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

  /**
   * Upgrades already running, keyed by device — the same coalescing reason as
   * `inFlight` above, so two `control`-quality acquires arriving together
   * against a `wall`-quality entry restart the session exactly once.
   */
  const upgrading = new Map<string, Promise<void>>()

  /**
   * Opening Control on a device streaming at `wall` quality upgrades it: the
   * session restarts at `control` quality (Plan 42 §3.5, §4.5). Existing
   * subscribers (e.g. a wall tile still watching) are carried over onto the
   * new entry rather than dropped — they simply see the picture sharpen.
   * A `wall`-quality entry is NEVER touched for a `wall` request, and a
   * `control`-quality entry is never restarted for anything: this is the one
   * and only path that closes a healthy, in-use session.
   */
  async function upgradeToControl(deviceId: string): Promise<void> {
    const existing = entries.get(deviceId)
    if (!existing || existing.session.quality !== 'wall') return
    let pending = upgrading.get(deviceId)
    if (!pending) {
      pending = (async () => {
        const old = entries.get(deviceId)
        if (!old || old.session.quality !== 'wall') return
        entries.delete(deviceId)
        if (old.closeTimer) clearTimeout(old.closeTimer)
        await old.session.close().catch((err) => deps.log.warn(`failed to close session ${deviceId}: ${String(err)}`))
        deps.onEvent?.(deviceId, 'session.closed', { reason: 'quality_upgrade' })
        const fresh = await createEntry(deviceId, 'control')
        // Carry the old entry's subscribers and refcount onto the fresh one —
        // an existing wall tile keeps receiving frames through the restart,
        // it just gets the sharper picture once the new session is ready.
        for (const sub of old.frameSubscribers) fresh.frameSubscribers.add(sub)
        fresh.refcount = old.refcount
        entries.set(deviceId, fresh)
      })()
      upgrading.set(deviceId, pending)
      void pending.finally(() => upgrading.delete(deviceId))
    }
    await pending
  }

  return {
    async acquire(deviceId, onFrame, quality = 'control') {
      if (quality === 'control') await upgradeToControl(deviceId)

      const existing = entries.get(deviceId)
      if (existing) {
        if (existing.closeTimer) {
          clearTimeout(existing.closeTimer)
          existing.closeTimer = null
        }
        existing.idleSince = null
        existing.refcount++
        existing.frameSubscribers.add(onFrame)
        return existing.session
      }

      let pending = inFlight.get(deviceId)
      if (!pending) {
        pending = createEntry(deviceId, quality)
        inFlight.set(deviceId, pending)
        void pending.catch(() => undefined).finally(() => inFlight.delete(deviceId))
      }
      // Every caller attaches itself, including the one that started the work:
      // `createEntry` deliberately returns an entry with no subscribers.
      await pending
      // A concurrent `wall`-first request may have created the entry at `wall`
      // quality while THIS caller wanted `control` — upgrade before attaching.
      // (A `wall` caller racing the SAME window can, in principle, still end
      // up attached to the pre-upgrade entry; this is bounded to the single
      // instant a brand-new session is first created under mixed-quality
      // concurrent requests, and self-heals on the next `acquire` either way.)
      if (quality === 'control') await upgradeToControl(deviceId)
      const entry = entries.get(deviceId)
      if (!entry) throw new SessionError('device_not_ready', `session for ${deviceId} disappeared during acquire`)
      if (entry.closeTimer) {
        clearTimeout(entry.closeTimer)
        entry.closeTimer = null
      }
      entry.idleSince = null
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
      entry.idleSince = Date.now()
      const ttlSec = idleTtlSec()
      // 0 closes it immediately — the pre-plan-42 behaviour, exactly (Plan 42 §4.4, acceptance #10).
      if (ttlSec <= 0) {
        void closeEntry(deviceId, 'no_viewers')
        return
      }
      // A viewer that reconnects quickly re-attaches to a live session
      // (Plan 42 §3.4) instead of paying the full session start-up again.
      entry.closeTimer = setTimeout(() => void closeEntry(deviceId, 'idle_timeout'), ttlSec * 1000)
      enforceIdleCap()
    },

    get(deviceId) {
      return entries.get(deviceId)?.session ?? null
    },

    closeDevice: (deviceId) => closeEntry(deviceId, 'device_gone'),

    async closeIfIdle(deviceId) {
      const entry = entries.get(deviceId)
      if (!entry || entry.refcount > 0) return
      await closeEntry(deviceId, 'claimed')
    },

    idleSessions() {
      return [...entries.entries()]
        .filter(([, e]) => e.idleSince !== null)
        .map(([deviceId, e]) => ({ deviceId, idleSince: e.idleSince as number }))
        .sort((a, b) => a.idleSince - b.idleSince)
    },

    async closeAll() {
      await Promise.all([...entries.keys()].map((id) => closeEntry(id, 'shutdown')))
    },
  }
}
