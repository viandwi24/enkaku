import type { AdbClient } from '@enkaku/adb'
import type { FrameMeta, Quality, SessionPhase } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { Logger } from './logger'
import { createSession, type CreateSessionDeps, type DeviceSession } from './session'
import type { DeviceSnapshotSource } from './types'
import { sameVideoNumbers, type VideoProfile } from './video-profile'

/** Legacy fallback when `idleTtlSec` is not supplied (node mode, tests) — the
 * quick-reconnect grace this manager always had before Plan 42 made it configurable. */
const DEFAULT_IDLE_TTL_SEC = 5

interface Entry {
  session: DeviceSession
  refcount: number
  frameSubscribers: Set<(chunk: Uint8Array, meta: FrameMeta) => void>
  closeTimer: ReturnType<typeof setTimeout> | null
  /** Unix ms when refcount last reached 0, or null while it has a subscriber. Drives LRU eviction (Plan 42 §4.4). */
  idleSince: number | null
  /**
   * The resolved profile this entry's session was built with (plan 92 §3.3,
   * §4.3) — whatever `deps.resolveProfile?.(deviceId, quality)` returned at
   * `createEntry` time, `null` when no resolver is wired. `videoStats()`'s
   * `profiles` array reads this directly, so it can never disagree with what
   * actually reached `makeScrcpy`.
   */
  videoProfile: VideoProfile | null
}

export interface SessionManager {
  /** Create or fetch the single session for a device and bump its refcount.
   * `quality` (Plan 42 §4.5) defaults to `control`; requesting `control`
   * against a session that came up at `wall` upgrades it (restart, never a
   * silent downgrade the other way). */
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void, quality?: Quality): Promise<DeviceSession>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  /**
   * Restart a device's OPEN session at `quality` with a freshly resolved
   * video profile, carrying its subscribers and refcount onto the fresh
   * entry (plan 92 §3.8 — the generalisation of the pre-plan-92
   * `upgradeToControl`, whose coalescing `upgrading` map and carry-over
   * behaviour this reuses verbatim rather than reimplementing). A no-op when
   * the device has no open entry — nothing to restart, and a plain `acquire`
   * builds the right thing directly. `detail` (plan 92 §3.8 rule 5) reaches
   * `onPhase` for every phase of the rebuild that does not supply its own,
   * so a restart the operator did not ask to watch still explains itself
   * (F17) instead of looking like an ordinary reconnect.
   *
   * Optional for the exact reason `activeDeviceIds`/`videoStats` below
   * already are: dozens of existing tests across `packages/session`/
   * `packages/core` build an ad-hoc object literal shaped like
   * `SessionManager` for scenarios that have nothing to do with video (job
   * runner, workflow executors, readiness — `readiness.test.ts`'s own
   * `fakeSessionManager()` is exactly such a fixture, typed directly as
   * `SessionManager` with no cast). `createSessionManager` (this file's
   * only PRODUCTION implementation) always returns one; every real caller
   * reads it through the same `?.` an absent method already gets.
   */
  restartAt?(deviceId: string, quality: Quality, detail?: string): Promise<void>
  /**
   * Restart every OPEN session whose resolved profile no longer matches the
   * one it was built with (plan 92 §3.8) — the "saved but never read" fix
   * for a video setting. Five rules, all enforced here:
   *   1. Compares RESOLVED numbers (`sameVideoNumbers`), never settings
   *      identity — a save that touched an unrelated field restarts nothing.
   *   2. Debouncing/coalescing is the CALLER's job (`daemon.ts`'s
   *      `settingsStore.onChange`, 500ms) — this function itself always
   *      runs one full pass, synchronously decided against the entries open
   *      at call time.
   *   3. Every restart goes through `restartAt`, which goes through the
   *      SAME build lane (§3.3) `createEntry` always queues behind — so
   *      reprofiling N live sessions is a queue, never a burst.
   *   4. NEVER mid-job: a `busy` device is reported in `skippedBusy` and
   *      never restarted — video keeps running while a device is busy
   *      (spec §10.1), and a settings save must not be the thing that
   *      interrupts a running script.
   *   5. Explains itself: every restart carries
   *      `detail: 'applying new video settings'`, rendered by `LiveView` (F17).
   * A no-op (everything reported `unchanged`) when no `resolveProfile`
   * accessor is wired (a test/fixture `SessionManager`, or the node
   * package's own mini-core) — there is nothing to compare an open
   * session's profile against. Optional for the same reason `restartAt`
   * above is.
   */
  reprofile?(reason: string): Promise<{ restarted: string[]; skippedBusy: string[]; unchanged: number }>
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
  /**
   * Force-closes every open session, active or idle alike (unlike
   * `idleSessions()`, which only ever sees the idle ones) — used both by an
   * ordinary core shutdown (`reason` defaults to `'shutdown'`) and by the adb
   * restart flow (plan 88 §3.10, §4.8), which drains with `'adb-server-restart'`
   * so the device log reads as an operator action rather than an unexplained
   * drop. Returns the number of sessions actually closed, for the restart
   * flow's own report (`AdbCycleReport.sessionsClosed`) — never a guess.
   */
  closeAll(reason?: string): Promise<number>
  /**
   * Device ids with a currently open session, active viewer or idle alike
   * (unlike `idleSessions()`, which only ever sees the idle ones) — a
   * non-destructive peek, for a live "N screens will stop" count in the adb
   * restart confirmation dialog (plan 88 §3.10) before anything actually
   * closes. Optional: only that one preview needs it, and every other
   * consumer of this interface already has `idleSessions()`.
   */
  activeDeviceIds?(): string[]
  /**
   * Live streams by quality plus the build lane's own occupancy (plan 92
   * §3.3, §4.3, §5 step 92.3, tests H1) — for `/api/adb/stats`'s `video`
   * block. `buildsRunning`/`buildQueueDepth` read the SAME counting
   * semaphore `createEntry` itself queues behind, so this is the actual
   * state of the lane, never a derived estimate. `profiles` reports the
   * resolved numbers each currently-open entry was built with (empty
   * `maxSize`/`maxFps`/`bitRate` never appear — an entry with no resolver
   * wired, e.g. `SessionManagerDeps.resolveProfile` omitted, is simply
   * absent from the array rather than reported with made-up numbers).
   *
   * Optional for the exact reason `activeDeviceIds` above is: dozens of
   * existing tests across `packages/session`/`packages/core` build an
   * ad-hoc object literal shaped like `SessionManager` for scenarios that
   * have nothing to do with video (job runner, workflow executors,
   * readiness) — making this required would force every one of those
   * unrelated fixtures to grow a `videoStats` stub in the same commit.
   * `createSessionManager` (this file's own factory, the only PRODUCTION
   * implementation) always returns one; `adb-stats.ts` reads it through the
   * same `?.` an absent method already gets.
   */
  videoStats?(): {
    streams: { control: number; wall: number }
    buildsRunning: number
    buildQueueDepth: number
    profiles: Array<{ deviceId: string; quality: Quality; maxSize: number; maxFps: number; bitRate: number }>
  }
}

export interface SessionManagerDeps {
  client: AdbClient
  devices: DeviceSnapshotSource
  log: Logger
  makeInspector?: CreateSessionDeps['makeInspector']
  makeScrcpy?: CreateSessionDeps['makeScrcpy']
  /**
   * Plan 90 §3.2, §4.5, §5 step 90.5 — a farm-wide factory for a device-scoped guest-agent client
   * runner, called once per `createEntry` (mirroring `makeInspector`/`makeScrcpy`'s own per-device
   * factory shape above) and handed straight to `createSession`'s own `withGuestAgentClient`.
   * `daemon.ts`'s `createSessionManager({...})` call site wires this to
   * `(deviceId) => (fn) => guestAgent.withGuestAgentClient(deviceId, fn)` (fixed
   * 2026-08-13 — `docs/plans/96-m61-hotfixes.md` §96.6; before that fix this was
   * declared and forwarded correctly here but never actually passed by the one
   * production caller, so `agentCapabilities` read `null` on every session in
   * every wired build and rung 1 of the text ladder, §3.3, was unreachable
   * regardless of hardware). Still `undefined` in a test/fixture `SessionManager`
   * that does not supply it — that case means no agent path exists for text
   * input on any device it manages, honestly reported via `agentCapabilities:
   * null`, never assumed to be reachable.
   */
  withGuestAgentClient?: (deviceId: string) => CreateSessionDeps['withGuestAgentClient']
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
  /**
   * Plan 91 §4.1, §4.5 — `coControl.queueWaitMs`/`coControl.maxQueueDepth`, the input arbiter's
   * bounded-queue budget. Forwarded VERBATIM (the accessor function itself, never resolved to a
   * number here) into `createSession`'s identically-named `CreateSessionDeps` fields, which in turn
   * hand them straight to `createInputArbiter` — `input-arbiter.ts`'s own `submit()` calls
   * `queueWaitMs()`/`maxQueueDepth()` fresh on every new action, so a farm setting change reaches
   * every already-open session's arbiter immediately, not only sessions opened after the change.
   * Undefined falls back to `session.ts`'s own hardcoded defaults, matching every other optional
   * accessor here. Wired by `daemon.ts`'s `createSessionManager({...})` call to `() =>
   * settingsStore.get().coControl.queueWaitMs` / `...maxQueueDepth` (fixed 2026-08-13 —
   * `docs/plans/96-m61-hotfixes.md` §96.13; before that fix `session.ts` already read these two
   * fields correctly from `CreateSessionDeps`, but `SessionManagerDeps` had no field to receive
   * them at all, so every session in every wired build ran the plan's own hardcoded stand-in
   * defaults — 5000ms / 32 — regardless of what an operator configured in Studio).
   */
  arbiterQueueWaitMs?: () => number
  arbiterMaxQueueDepth?: () => number
  /**
   * Plan 100 §4.3, step 100.6 — `FarmSettings.display.fallbackRetryCount`,
   * forwarded verbatim (the accessor itself, matching `arbiterQueueWaitMs`'s
   * own pattern above) into `createSession`'s identically-named
   * `CreateSessionDeps` field. Undefined falls back to `session.ts`'s own
   * `DEFAULT_FALLBACK_RETRY_COUNT`.
   */
  fallbackRetryCount?: () => number
  /**
   * Resolve this device's video profile at the requested quality (plan 92
   * §3.5, §4.2, §4.3) — farm settings plus any per-device override, read
   * fresh on every session build, the same freshness discipline
   * `idleTtlSec`/`maxIdleSessions` above already use. `createEntry` passes
   * the result straight into `CreateSessionOpts.videoProfile`, which is what
   * finally reaches `makeScrcpy` as concrete `max_size`/`max_fps`/
   * `video_bit_rate` numbers instead of a `Quality` string to look up.
   * Undefined (a test/fixture `SessionManager`, or the node package's own
   * mini-core, which carries no farm settings store) leaves
   * `CreateSessionOpts.videoProfile` unset — `createSession` then falls back
   * to its own schema-default resolution, which is byte-identical to the
   * pre-plan-92 constants.
   */
  resolveProfile?: (deviceId: string, quality: Quality) => VideoProfile
  /**
   * `session.maxConcurrentBuilds` (plan 92 §3.3, §4.3, §5 step 92.3, tests
   * H1) — the farm-wide build lane's cap, read fresh on every acquire (the
   * same freshness discipline `idleTtlSec`/`maxIdleSessions`/`resolveProfile`
   * above already use, so a setting saved mid-stampede takes effect on the
   * NEXT queued build rather than needing a restart). Undefined (a
   * test/fixture `SessionManager`, or the node package's own mini-core,
   * which carries no farm settings store) leaves the lane unbounded — the
   * pre-plan-92 behaviour (F9): concurrent builds ran with no farm-wide
   * bound at all, and a caller that wires no accessor gets that same
   * behaviour rather than an arbitrary default throttling it.
   */
  maxConcurrentBuilds?: () => number
}

/**
 * A plain counting semaphore around one async operation (plan 92 §3.3, §4.3
 * — the build lane). QUEUES rather than refuses: a caller past the cap
 * `await`s `run()` and it resolves once a permit frees up, so a wall opening
 * 100 tiles ends with 100 pictures, just more slowly — never a partial load
 * with some tiles erroring because the lane was full (the whole reason F9's
 * fix cannot be "reject when at capacity").
 *
 * The cap is read fresh on every `pump()` (not captured once at construction)
 * so a setting saved mid-queue take effect on the very next permit handed
 * out, the same freshness discipline every other accessor in this file uses.
 *
 * Release always runs through `finally`, so a `fn` that throws still frees
 * its permit — a leaked permit here would silently shrink the farm's build
 * capacity until a restart, and it would look like slowness, not a bug.
 */
function createBuildLane(maxConcurrent: () => number) {
  let running = 0
  const queue: Array<() => void> = []

  function pump(): void {
    const cap = Math.max(1, maxConcurrent())
    while (running < cap && queue.length > 0) {
      running++
      const startNext = queue.shift()!
      startNext()
    }
  }

  function acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      queue.push(resolve)
      pump()
    })
  }

  function release(): void {
    running--
    pump()
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },
    /** Permits currently in use — for `videoStats()`'s `buildsRunning`. */
    runningCount: () => running,
    /** Callers still waiting for a permit — for `videoStats()`'s `buildQueueDepth`. */
    queueDepth: () => queue.length,
  }
}

/**
 * One DisplaySource per device is shared across every viewer; the capture
 * loop only runs while there is at least one subscriber (saves device battery).
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const entries = new Map<string, Entry>()
  const idleTtlSec = deps.idleTtlSec ?? (() => DEFAULT_IDLE_TTL_SEC)
  const maxIdleSessions = deps.maxIdleSessions ?? (() => Infinity)
  // Unbounded when no accessor is wired (F9's pre-plan-92 behaviour) — see
  // `SessionManagerDeps.maxConcurrentBuilds`'s own comment for why.
  const buildLane = createBuildLane(deps.maxConcurrentBuilds ?? (() => Infinity))

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

  /**
   * Build one session for a device. Serialised by `inFlight` above.
   *
   * `restartDetail` (plan 92 §3.8 rule 5) is set only when this build is a
   * `restartAt`/`reprofile` restart, never a fresh `acquire` — it becomes the
   * fallback `detail` for every phase this build reports that does not
   * already carry its own, so a viewer sees WHY its picture just went dark
   * ("Starting video — applying new video settings") instead of a bare
   * reconnect.
   */
  async function createEntry(deviceId: string, quality: Quality, restartDetail?: string): Promise<Entry> {
    const row = deps.devices.get(deviceId)
    if (!row) throw new SessionError('device_not_found', `no such device: ${deviceId}`)
    if (row.status === 'offline') {
      throw new SessionError('device_not_ready', `device ${row.label} is offline`)
    }

    // Assigned as soon as createSession resolves; onDisplayError compares
    // against it to tell "my session died" from "some other session died".
    let created: DeviceSession | null = null
    const onPhase = deps.onPhase
      ? (phase: SessionPhase, detail?: string) => deps.onPhase!(deviceId, phase, detail ?? restartDetail)
      : undefined
    // Computed once so `createSession`'s opts and this entry's own
    // `videoProfile` (read by `videoStats()`, plan 92 §3.3, §4.3) can never
    // disagree about what was actually resolved.
    const videoProfile = deps.resolveProfile ? deps.resolveProfile(deviceId, quality) : null
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
        ...(row.rotation !== undefined ? { rotation: row.rotation } : {}),
        ...(row.textInput !== undefined ? { textInput: row.textInput } : {}),
        ...(row.tagTraffic !== undefined ? { tagTraffic: row.tagTraffic } : {}),
        screenW: row.screenW,
        screenH: row.screenH,
        quality,
        // plan 92 §3.5, §4.2, §4.3 — resolved once above (farm settings plus
        // this device's own override), so `createSession`/`makeScrcpy` never
        // need to look `quality` up in a table themselves.
        ...(videoProfile ? { videoProfile } : {}),
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
        ...(deps.withGuestAgentClient ? { withGuestAgentClient: deps.withGuestAgentClient(deviceId) } : {}),
        ...(deps.arbiterQueueWaitMs ? { arbiterQueueWaitMs: deps.arbiterQueueWaitMs } : {}),
        ...(deps.arbiterMaxQueueDepth ? { arbiterMaxQueueDepth: deps.arbiterMaxQueueDepth } : {}),
        ...(deps.fallbackRetryCount ? { fallbackRetryCount: deps.fallbackRetryCount } : {}),
        ...(onPhase ? { onPhase } : {}),
        onInputDegraded: (from, to, reason) => deps.onEvent?.(deviceId, 'session.degraded', { from, to, reason }),
      },
    )
    created = session
    // No subscribers and refcount 0: every caller of `acquire` attaches
    // itself once this resolves, including the one that started the work.
    const entry: Entry = { session, refcount: 0, frameSubscribers: new Set(), closeTimer: null, idleSince: null, videoProfile }
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
   * Restarts already running, keyed by device — the same coalescing reason
   * as `inFlight` above, so two restart requests arriving together for the
   * SAME device (a `control`-quality acquire racing a settings-driven
   * `reprofile`, say) restart the session exactly once. This map — and the
   * subscriber/refcount carry-over inside `restartAt` below — is the
   * pre-plan-92 `upgrading` map verbatim (plan 92 §3.8: "keeping its
   * coalescing map and its subscriber carry-over unchanged"); only the
   * mechanism it now drives (`restartAt`, general in `quality`) is new.
   */
  const upgrading = new Map<string, Promise<void>>()

  /**
   * Restart a device's OPEN session at `quality`, with a freshly resolved
   * profile, carrying subscribers and refcount onto the fresh entry (plan 92
   * §3.8 — the generalisation of the pre-plan-92 `upgradeToControl`, which
   * this function's body used to be, unconditionally, for exactly the
   * `wall → control` transition). A no-op when the device has no open entry
   * — nothing to restart, and a plain `acquire` builds the right thing
   * directly; this function never itself decides WHETHER a restart is
   * warranted, only how to carry one out safely — `upgradeToControl` below
   * and `reprofile` are the two callers that each own their own "should
   * this restart happen at all" rule.
   */
  async function restartAt(deviceId: string, quality: Quality, detail?: string): Promise<void> {
    if (!entries.has(deviceId)) return
    let pending = upgrading.get(deviceId)
    if (!pending) {
      pending = (async () => {
        const old = entries.get(deviceId)
        if (!old) return
        entries.delete(deviceId)
        if (old.closeTimer) clearTimeout(old.closeTimer)
        await old.session.close().catch((err) => deps.log.warn(`failed to close session ${deviceId}: ${String(err)}`))
        // `detail` is only ever set by a `reprofile` pass today (§3.8 rule
        // 5) — kept as a distinct reason from the plain wall→control
        // upgrade's `quality_upgrade` so a device event log reader can tell
        // "an operator watched Control" from "a settings save reprofiled
        // this session" without decoding `detail` text.
        deps.onEvent?.(deviceId, 'session.closed', { reason: detail ? 'video_reprofile' : 'quality_upgrade' })
        // Through the build lane (plan 92 §3.3) like every other new build —
        // a restart pushes a fresh jar and spawns a fresh scrcpy child
        // exactly like a brand-new session does, so it competes for the
        // same farm-wide permits.
        const fresh = await buildLane.run(() => createEntry(deviceId, quality, detail))
        // Carry the old entry's subscribers and refcount onto the fresh one —
        // an existing viewer (a wall tile, a device page) keeps receiving
        // frames through the restart; it just sees the picture change once
        // the new session is ready. This is the ENTIRE reason a restart
        // never has to be announced to a viewer separately from
        // `session.progress` (§4.5): the WS subscription itself survives.
        for (const sub of old.frameSubscribers) fresh.frameSubscribers.add(sub)
        fresh.refcount = old.refcount
        entries.set(deviceId, fresh)
      })()
      upgrading.set(deviceId, pending)
      void pending.finally(() => upgrading.delete(deviceId))
    }
    await pending
  }

  /**
   * Opening Control on a device streaming at `wall` quality upgrades it: the
   * session restarts at `control` quality (Plan 42 §3.5, §4.5). A
   * `wall`-quality entry is NEVER touched for a `wall` request, and a
   * `control`-quality entry is never restarted by this path: the guard below
   * is the ENTIRE "should this restart happen" decision — `restartAt` itself
   * (above) no longer makes it, now that it also serves `reprofile`.
   */
  async function upgradeToControl(deviceId: string): Promise<void> {
    const existing = entries.get(deviceId)
    if (!existing || existing.session.quality !== 'wall') return
    // The `detail` is not decoration. scrcpy's `max_size`/`video_bit_rate`/
    // `max_fps` are LAUNCH arguments, so raising a wall tile to Control can
    // only be done by tearing the session down and starting it again — the
    // operator sees a second "Waking the device" a moment after the first one
    // already finished, and without this line nothing on screen explains why.
    //
    // `reprofile` (the settings path) has passed a detail since plan 92 §3.8
    // rule 5; this call site — the one an operator crosses every single time
    // they click a wall tile open — did not, so F17 was closed for the rare
    // path and left open for the common one.
    await restartAt(deviceId, 'control', 'the wall streams at a lower quality — restarting this device at full quality for Control')
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
        // The build lane's permit wait happens INSIDE this promise (plan 92
        // §3.3, §4.3) — `inFlight.set` below runs synchronously, before the
        // permit is ever granted, so a second `acquire` for this SAME device
        // arriving while the first is still queued sees `inFlight` already
        // populated and joins this one promise rather than requesting a
        // permit of its own. The dedupe map and the farm-wide lane are
        // deliberately orthogonal: the map bounds builds PER DEVICE (one),
        // the lane bounds builds ACROSS THE FARM (`maxConcurrentBuilds()`) —
        // taking the permit inside the map's critical section instead would
        // make a queued build hold this device's dedupe slot while it waits,
        // and every later subscriber for the SAME device would then queue
        // behind the lane too instead of sharing the one build it should.
        pending = buildLane.run(() => createEntry(deviceId, quality))
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

    restartAt,

    async reprofile(reason) {
      const restarted: string[] = []
      const skippedBusy: string[] = []
      let unchanged = 0
      // Nothing to compare an open session's own profile against — a
      // no-op, not a guess (plan 92 §3.8's own reading of `resolveProfile`
      // being optional, mirroring `resolveProfile`'s own doc comment above).
      if (!deps.resolveProfile) return { restarted, skippedBusy, unchanged }
      const resolveProfile = deps.resolveProfile
      deps.log.info(`reprofile: ${reason}`)
      // Snapshot the candidate ids up front: `restartAt` replaces its own
      // entry (delete, then set, once the rebuild finishes) while this loop
      // runs, and a live `Map` must not be mutated out from under iteration.
      const restarts: Promise<void>[] = []
      for (const deviceId of [...entries.keys()]) {
        const entry = entries.get(deviceId)
        if (!entry) continue // closed by something else between the snapshot and here
        // Rule 4 (§3.8): never mid-job — video keeps running while a device
        // is busy (spec §10.1), and a settings save must not be the thing
        // that interrupts a running script.
        if (deps.devices.get(deviceId)?.status === 'busy') {
          skippedBusy.push(deviceId)
          continue
        }
        const quality = entry.session.quality
        // `entry.videoProfile` (not `entry.session.videoProfile`, which
        // exists purely for a fixture-typed `DeviceSession` and is typed
        // optional for that reason): the two are the SAME object whenever
        // `deps.resolveProfile` is wired (`createEntry` resolves it once and
        // hands it straight into `createSession`'s `opts.videoProfile`,
        // which `session.ts` stores back onto the session verbatim) — and
        // `deps.resolveProfile` being wired is exactly the condition this
        // function already checked above before it got here. `entry.videoProfile`
        // is `null` only when no resolver is wired, which cannot be true at
        // this point — the guard exists in the type, not in practice.
        if (!entry.videoProfile) continue
        const fresh = resolveProfile(deviceId, quality)
        // Rule 1: compare RESOLVED numbers, not settings identity — a save
        // that changed an unrelated field restarts nothing.
        if (sameVideoNumbers(entry.videoProfile, fresh)) {
          unchanged++
          continue
        }
        restarted.push(deviceId)
        // Rule 3: through `restartAt` → the SAME build lane every other
        // build queues behind, so this is dispatched (not awaited one at a
        // time) — the lane, not this loop, decides how many run at once.
        // Rule 5: `detail` is what makes the restart explain itself (F17).
        restarts.push(restartAt(deviceId, quality, 'applying new video settings'))
      }
      await Promise.all(restarts)
      return { restarted, skippedBusy, unchanged }
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

    async closeAll(reason = 'shutdown') {
      const ids = [...entries.keys()]
      await Promise.all(ids.map((id) => closeEntry(id, reason)))
      return ids.length
    },

    activeDeviceIds() {
      return [...entries.keys()]
    },

    videoStats() {
      let control = 0
      let wall = 0
      const profiles: { deviceId: string; quality: Quality; maxSize: number; maxFps: number; bitRate: number }[] = []
      for (const [deviceId, entry] of entries) {
        if (entry.session.quality === 'control') control++
        else wall++
        if (entry.videoProfile) {
          profiles.push({
            deviceId,
            quality: entry.session.quality,
            maxSize: entry.videoProfile.maxSize,
            maxFps: entry.videoProfile.maxFps,
            bitRate: entry.videoProfile.bitRate,
          })
        }
      }
      return {
        streams: { control, wall },
        buildsRunning: buildLane.runningCount(),
        buildQueueDepth: buildLane.queueDepth(),
        profiles,
      }
    },
  }
}
