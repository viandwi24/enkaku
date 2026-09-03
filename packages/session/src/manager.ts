import type { AdbClient } from '@enkaku/adb'
import type { FrameMeta, Quality, RotationMode, SessionPhase } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { Logger } from './logger'
import type { RotationOutcome } from './orientation'
import { createSession, type CreateSessionDeps, type DeviceSession } from './session'
import type { DeviceSnapshotSource } from './types'
import { createVideoLatencyTracker, type VideoLatencySnapshot, type VideoLatencyTracker } from './video-latency'
import { sameVideoNumbers, type VideoProfile } from './video-profile'

/** Legacy fallback when `idleTtlSec` is not supplied (node mode, tests) — the
 * quick-reconnect grace this manager always had before Plan 42 made it configurable. */
const DEFAULT_IDLE_TTL_SEC = 5

interface Entry {
  /**
   * Plan 100 §4.2, §5 step 100.4 — the `entries` map is now keyed by
   * `entryKey(deviceId, quality)`, not `deviceId` alone (a device can hold
   * a `wall` entry and a `control` entry at once). `deviceId`/`quality`
   * are kept on the entry itself too so every iteration site (`closeDevice`,
   * `closeIfIdle`, `videoStats`, `idleSessions`, `activeDeviceIds`,
   * `reprofile`) can read them directly rather than re-parsing the key
   * string or trusting `entry.session.quality` (a fixture-typed
   * `DeviceSession` may not set it).
   */
  deviceId: string
  quality: Quality
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
  /**
   * Whether THIS entry ran the full device-prep sequence (plan 100 §4.2) —
   * false only for a fast-path `control` build, which skipped it because an
   * open `wall` entry had already done it.
   *
   * `setRotation` below needs it: the prep-owning entry is the one holding
   * the capture of what the device's rotation looked like before the farm
   * touched it, so a live re-lock must be applied through THAT entry's lock
   * whenever both are open. Applying it through the fast-path entry instead
   * would make that entry capture the wall entry's already-applied lock as
   * "the device's original state".
   */
  ownsDevicePrep: boolean
  /** Plan 203 §4.5 — per-entry PTS statistics, fed by every dispatched frame. */
  latency: VideoLatencyTracker
}

export interface SessionManager {
  /**
   * Create or fetch the session for `(deviceId, quality)` and bump its
   * refcount (plan 100 §4.2, §5 step 100.4 — `entries` is now keyed by the
   * PAIR, not `deviceId` alone, so a `wall` entry and a `control` entry for
   * the SAME device coexist independently). `quality` defaults to
   * `control`, unchanged.
   *
   * Acquiring `control` while a `wall` entry for the same device is already
   * open takes a FAST path: the open wall entry is live proof the device is
   * already awake, rotated, tagged, and has its keyboard set, so the new
   * `control` entry's build skips re-deriving any of that and goes straight
   * to a second, independent scrcpy session (§3.2's option 3, confirmed
   * feasible on real hardware — G12). The wall entry itself is never
   * touched: no restart, no phase events, no build-count increment on it.
   * `upgradeToControl` — the pre-100.4 `wall → control` RESTART — no longer
   * exists; there is nothing left to upgrade, only a second slot to fill.
   *
   * When that fast build cannot produce a real second scrcpy session
   * (`makeScrcpy` rejects, or the device's own configured engine is not
   * scrcpy — H2), this throws `SessionError('E_CONTROL_SESSION_UNAVAILABLE',
   * ...)` rather than silently falling back to screencap-loop or handing
   * back the wall entry disguised as control (§3.7, §4.4) — the caller
   * (`ws-handlers.ts`'s `stream.start`) decides whether to substitute the
   * wall entry's own frames, and says so on the wire.
   *
   * A `control` acquire against a device with no open `wall` entry, and
   * every `wall` acquire regardless, build the ordinary way — unchanged
   * from before this plan.
   */
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void, quality?: Quality): Promise<DeviceSession>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  /**
   * Plan 100 §4.2 — the highest-quality open entry for THIS specific
   * `quality` slot, never the other one. Added because `get(deviceId)`
   * below now means "whichever entry is more specific" (highest-quality
   * wins), which is the wrong answer for a caller that just acquired a
   * SPECIFIC quality and needs to read back exactly that entry (e.g. a
   * WS viewer reading `videoConfig`/`requestKeyframe` for the stream IT is
   * showing, not whichever entry happens to be "more control-y" right now).
   * Optional for the same fixture-compatibility reason every other method
   * here already is.
   */
  getByQuality?(deviceId: string, quality: Quality): DeviceSession | null
  /**
   * Restart a device's OPEN session AT `quality` — that one slot only,
   * never crossing quality (plan 100 §3.2: the pre-100.4 `wall → control`
   * restart is gone; this remains exactly what plan 92 §3.8 built it for —
   * a same-quality requality, e.g. an operator changing `wall.wallPreset`
   * restarting every open `wall` entry in place). Carries its subscribers
   * and refcount onto the fresh entry. A no-op when the device has no open
   * entry at that quality — nothing to restart, and a plain `acquire`
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
   * Re-lock a device's screen orientation on the session it is running RIGHT
   * NOW (plan 85 §3.7) — the fix for the setting being apply-once.
   *
   * `DeviceSettings.prep.rotation` used to reach a device only at session
   * creation, so an operator watching a wall tile could set "Lock portrait",
   * get a success toast, and watch nothing happen: the tile's session was
   * already open, and nothing ever re-read the setting. On a wall that stays
   * up for hours there is no "next session" to wait for. `PATCH
   * /api/devices/:id` calls this the moment the setting changes.
   *
   * Applied through ONE entry even when a device holds both a `wall` and a
   * `control` entry — there is one physical screen, and the two entries would
   * write identical values. The `wall` entry (the one that ran device prep,
   * `Entry.ownsDevicePrep`) is preferred, because it holds the capture of the
   * device's pre-farm rotation that `close()` restores.
   *
   * Returns `null` when the device has no open session at all: nothing to
   * change live, and the stored setting will be picked up by the next session
   * exactly as it always was. That is deliberately NOT reported as a failure —
   * the caller words the two differently.
   *
   * Optional for the same fixture-compatibility reason `restartAt` above is.
   */
  setRotation?(deviceId: string, mode: RotationMode): Promise<RotationOutcome | null>
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
  /**
   * Plan 203 §4.5: per-entry PTS statistics for `GET /api/video/latency`.
   * Optional for the same fixture-compatibility reason `videoStats` is.
   */
  videoLatency?(deviceId: string): Array<{ quality: Quality; viewers: number } & VideoLatencySnapshot>
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
  /**
   * Whether a job is currently running on this device (plan 205 §4.6, §5
   * step 205.10) — `devices.status` no longer has a "busy" value to read
   * (that fact now lives in the activity registry). Wired in `daemon.ts` to
   * `jobStore.runningByDevice(deviceId) !== null`. Optional so a test/fixture
   * `SessionManager` that never wires it never blocks a reprofile.
   */
  hasRunningJob?: (deviceId: string) => boolean
  /** Session start-up phases, tagged with the device they belong to (Plan 17 §3.3, §4.3). */
  onPhase?: (deviceId: string, phase: SessionPhase, detail?: string) => void
  /** Device event log: session.opened / session.closed (Plan 18 §4.2). */
  onEvent?: (deviceId: string, kind: string, meta: Record<string, unknown>) => void
  /** Seconds a session stays alive with no subscriber (Plan 42 §4.4). 0 closes it immediately. Read fresh on every release. */
  idleTtlSec?: () => number
  /** How many idle sessions may be held open across the farm before the least-recently-idle is evicted (Plan 42 §4.4). Read fresh on every release. Omitted/Infinity = no cap. */
  maxIdleSessions?: () => number
  /**
   * The input arbiter's bounded-queue budget. Forwarded VERBATIM (the
   * accessor function itself, never resolved to a number here) into
   * `createSession`'s identically-named `CreateSessionDeps` fields, which in
   * turn hand them straight to `createInputArbiter` — `input-arbiter.ts`'s
   * own `submit()` calls `queueWaitMs()`/`maxQueueDepth()` fresh on every
   * new action, so a farm setting change reaches every already-open
   * session's arbiter immediately, not only sessions opened after the
   * change. Undefined falls back to `session.ts`'s own hardcoded defaults,
   * matching every other optional accessor here.
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
  /**
   * Is this device's screen already being held awake by something OUTSIDE this
   * session build? (plan 125 §3.7, §4.5, §5 step 125.7 — "one wake per session
   * start, and the readiness manager is the authority".)
   *
   * Read fresh at the moment the build lane actually grants a permit — the
   * same freshness discipline every accessor above uses, and it matters more
   * here than for most: a build queued behind the farm-wide lane may sit for a
   * while, and the answer that decides whether to skip a 1422 ms `svc power
   * stayon` has to be the one true when the build runs, not when it was
   * requested.
   *
   * `daemon.ts`'s `createSessionManager({...})` wires it to the readiness
   * manager, written the long way on purpose:
   * `(deviceId) => (readiness ? readiness.actual(deviceId) !== 'asleep' : false)`.
   * **Not** `readiness?.actual(deviceId) !== 'asleep'` — with no readiness
   * manager wired that reads `undefined !== 'asleep'`, i.e. `true`, and would
   * skip the wake on precisely the builds that most need it.
   * `readiness.actual` is `hot` when a session is open and `awake` when the
   * readiness manager has itself run `wakeDevice` for the device (the
   * `keepAwakeApplied` set, `packages/core/src/device/readiness.ts`) — so it
   * is precisely "the wake already happened, and something is still holding
   * it". `stream.start` calls `readiness.hold(deviceId, 'viewer')` immediately
   * before `acquire`, which is what made the duplicate wake plan 125 §0.7
   * measured (≈3.2 s of a ≈4.3 s cold start) and what makes this accessor
   * true by the time the build runs.
   *
   * Undefined — a test/fixture `SessionManager`, or the node package's own
   * mini-core, neither of which runs a readiness manager — means every build
   * wakes exactly as it did before this plan. That is the safe default in the
   * only direction that matters: an unnecessary wake costs a second, a missing
   * one costs a phone in a sealed box its screen (§0.2).
   */
  deviceIsAwake?: (deviceId: string) => boolean
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
 * Plan 100 §4.2, §5 step 100.4 — the composite map key: `entries` now holds
 * at most one entry per `(deviceId, quality)` pair rather than one per
 * device, so a `wall` entry and a `control` entry for the SAME device
 * coexist as two independent map entries.
 */
function entryKey(deviceId: string, quality: Quality): string {
  return `${deviceId}:${quality}`
}

/**
 * One DisplaySource per device is shared across every viewer; the capture
 * loop only runs while there is at least one subscriber (saves device battery).
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const entries = new Map<string, Entry>()
  /**
   * Plan 100 §4.2 — `release(deviceId, onFrame)`'s signature stays bare
   * (unchanged from before this plan), but the manager now needs to know
   * WHICH of a device's up-to-two open entries a given subscriber belongs
   * to. A subscriber is only ever registered against one `acquire` call, so
   * this is a plain inverted index kept in lockstep with each entry's own
   * `frameSubscribers` set (set on attach, deleted on release AND on
   * `closeEntry`, so a subscriber orphaned by a force-close is never left
   * pointing at a key that no longer resolves to anything) — never trusting
   * a caller to re-supply the right quality, which is exactly how "a
   * subscriber released against the wrong slot silently detaches the wrong
   * stream" would happen.
   */
  const subscriberEntry = new Map<(chunk: Uint8Array, meta: FrameMeta) => void, string>()
  const idleTtlSec = deps.idleTtlSec ?? (() => DEFAULT_IDLE_TTL_SEC)
  const maxIdleSessions = deps.maxIdleSessions ?? (() => Infinity)
  // Unbounded when no accessor is wired (F9's pre-plan-92 behaviour) — see
  // `SessionManagerDeps.maxConcurrentBuilds`'s own comment for why.
  const buildLane = createBuildLane(deps.maxConcurrentBuilds ?? (() => Infinity))

  const dispatchFrame = (key: string) => (chunk: Uint8Array, meta: FrameMeta) => {
    const entry = entries.get(key)
    if (!entry) return
    entry.latency.record(meta)
    for (const cb of entry.frameSubscribers) cb(chunk, meta)
  }

  /** Attach a subscriber to an already-resolved entry — the shared tail of
   * every `acquire` branch below (existing entry, or a freshly built one). */
  function attach(key: string, entry: Entry, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void {
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer)
      entry.closeTimer = null
    }
    entry.idleSince = null
    entry.refcount++
    entry.frameSubscribers.add(onFrame)
    subscriberEntry.set(onFrame, key)
  }

  async function closeEntry(key: string, reason = 'released'): Promise<void> {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    if (entry.closeTimer) clearTimeout(entry.closeTimer)
    for (const sub of entry.frameSubscribers) subscriberEntry.delete(sub)
    await entry.session.close().catch((err) => deps.log.warn(`failed to close session ${entry.deviceId}: ${String(err)}`))
    deps.onEvent?.(entry.deviceId, 'session.closed', { reason })
    deps.log.info(`session closed: ${entry.deviceId} (${entry.quality})`)
  }

  /**
   * Enforce `maxIdleSessions` (Plan 42 §4.4, acceptance #9): once the number
   * of entries currently idle (no subscriber, sitting on their TTL timer)
   * exceeds the cap, the least-recently-idle ones are closed immediately —
   * not merely scheduled — so the farm never holds more idle sessions than
   * the setting allows, even for the instant between two releases. Plan 100
   * §4.2/G17: a device holding both a `wall` and a `control` entry counts
   * as up to two idle entries here, exactly as it should — this cap already
   * governs total idle sessions farm-wide, unchanged by this plan.
   */
  function enforceIdleCap(): void {
    const cap = maxIdleSessions()
    if (!Number.isFinite(cap)) return
    const idle = [...entries.entries()]
      .filter(([, e]) => e.idleSince !== null)
      .sort(([, a], [, b]) => (a.idleSince as number) - (b.idleSince as number))
    while (idle.length > cap) {
      const [key] = idle.shift()!
      void closeEntry(key, 'idle_evicted')
    }
  }

  /**
   * Build one session for `(deviceId, quality)`. Serialised by `inFlight`
   * above (keyed by `entryKey`, plan 100 §4.2).
   *
   * `restartDetail` (plan 92 §3.8 rule 5) is set only when this build is a
   * `restartAt`/`reprofile` restart, never a fresh `acquire` — it becomes the
   * fallback `detail` for every phase this build reports that does not
   * already carry its own, so a viewer sees WHY its picture just went dark
   * ("Starting video — applying new video settings") instead of a bare
   * reconnect.
   *
   * `fastOpts` (plan 100 §3.2, §4.2, §5 step 100.4) is set ONLY by the
   * `control`-quality fast path below, when an already-open `wall` entry for
   * the same device is live proof this device is already awake, rotated,
   * tagged, and keyboard-set: `skipDevicePrep` skips re-deriving any of
   * that, and `requireScrcpy` makes a failed second scrcpy build a hard
   * failure rather than a silent screencap-loop degrade (§3.7, §4.4). Never
   * set for an ordinary acquire, a restart, or a wall build.
   */
  async function createEntry(
    deviceId: string,
    quality: Quality,
    restartDetail?: string,
    fastOpts?: { skipDevicePrep?: boolean; requireScrcpy?: boolean },
  ): Promise<Entry> {
    const row = deps.devices.get(deviceId)
    if (!row) throw new SessionError('device_not_found', `no such device: ${deviceId}`)
    if (row.status === 'offline') {
      throw new SessionError('device_not_ready', `device ${row.label} is offline`)
    }

    const key = entryKey(deviceId, quality)
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
        // plan 125 §3.7, §4.5, §5 step 125.7 — asked HERE, not at `acquire`
        // time, so a build that waited behind the farm-wide lane decides on
        // the device's state as it is now. Only ever set to `true`: the
        // absence of a `deviceIsAwake` accessor must leave the wake exactly
        // where it was, never skip it (see the dep's own doc comment).
        ...(deps.deviceIsAwake?.(deviceId) ? { skipWake: true } : {}),
        // plan 100 §3.2, §4.2, §5 step 100.4 — see this function's own doc
        // comment above for what these two do and when they are set.
        ...(fastOpts?.skipDevicePrep ? { skipDevicePrep: true } : {}),
        ...(fastOpts?.requireScrcpy ? { requireScrcpy: true } : {}),
      },
      {
        client: deps.client,
        log: deps.log.child(`session:${row.label}`),
        onFrame: dispatchFrame(key),
        onDisplayError: (err) => {
          const reason = err instanceof Error ? err.message : String(err)
          // Only the session currently published may tear its entry down.
          //
          // Closing a session ends its sockets, which fires this callback a
          // moment later — by which time a replacement may already be serving
          // the device. Without this guard a routine close, or any session left
          // behind by an earlier race, takes the healthy one with it.
          const current = entries.get(key)?.session
          if (current !== undefined && current !== created) {
            deps.log.debug(`ignoring a display error from a session no longer in use on ${deviceId} (${quality}): ${reason}`)
            return
          }
          deps.log.warn(`display error on ${deviceId} (${quality}): ${reason} — closing the session`)
          deps.onSessionEnded?.(deviceId, reason)
          void closeEntry(key, reason)
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
    const entry: Entry = {
      deviceId,
      quality,
      session,
      refcount: 0,
      frameSubscribers: new Set(),
      closeTimer: null,
      idleSince: null,
      videoProfile,
      ownsDevicePrep: !fastOpts?.skipDevicePrep,
      latency: createVideoLatencyTracker({ startedAt: Date.now() }),
    }
    entries.set(key, entry)
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
    // Plan 85 §3.7 — a rotation lock that was ASKED FOR and did not take is
    // reported to the device's own event log, not left at `warn` in a log
    // file nobody has open. The success case is deliberately silent: a wall
    // of forty tiles rebuilding would otherwise write forty rows saying
    // nothing happened. `session.rotation` is absent only on a fixture
    // session (see `DeviceSession.rotation`).
    const rotationOutcome = session.rotation?.outcome
    if (rotationOutcome && !rotationOutcome.applied) {
      deps.onEvent?.(deviceId, 'device.rotation', {
        mode: rotationOutcome.mode,
        applied: false,
        reason: rotationOutcome.reason ?? 'the device did not accept the rotation lock',
        quality,
      })
    }
    deps.log.info(`session opened: ${row.label} (${deviceId}) at ${quality}`)
    return entry
  }

  /**
   * Plan 100 §3.2, §4.2, §5 step 100.4 — decides whether THIS build gets the
   * fast path, then builds it. A `control` request against a device with an
   * already-open `wall` entry takes the fast path (skips wake/rotate/
   * text-input/farm-tag, requires a real second scrcpy session or throws);
   * every other request — `wall`, or `control` with no open `wall` entry —
   * builds the ordinary, unchanged way. Checked fresh at the moment the
   * build lane actually grants a permit (not at `acquire` call time), so a
   * build queued behind the farm-wide lane sees the wall entry's true state
   * at build time, not a stale snapshot from when it was first requested.
   *
   * A `wall` entry appearing or disappearing in the narrow window between
   * `acquire` checking `entries` and this function running is a real but
   * bounded race (the same shape the pre-100.4 `acquire` already documented
   * for a concurrent wall-first request): the affected build simply takes
   * whichever path was true a moment earlier, and self-heals on the next
   * `acquire` either way — it never produces a wrong or missing entry.
   */
  async function buildEntry(deviceId: string, quality: Quality): Promise<Entry> {
    if (quality === 'control') {
      const wallEntry = entries.get(entryKey(deviceId, 'wall'))
      if (wallEntry) {
        return createEntry(deviceId, quality, undefined, { skipDevicePrep: true, requireScrcpy: true })
      }
    }
    return createEntry(deviceId, quality)
  }

  /**
   * Creations already running, keyed by `entryKey` (plan 100 §4.2) — a
   * `wall` build and a `control` build for the SAME device are independent
   * and must never coalesce into one promise.
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
   * Restarts already running, keyed by `entryKey` — the same coalescing
   * reason as `inFlight` above, so two restart requests arriving together
   * for the SAME `(deviceId, quality)` (e.g. two `reprofile` passes racing)
   * restart the session exactly once. This map — and the subscriber/
   * refcount carry-over inside `restartAt` below — is the pre-plan-92
   * `upgrading` map verbatim (plan 92 §3.8: "keeping its coalescing map and
   * its subscriber carry-over unchanged"); only the mechanism it now drives
   * (`restartAt`, general in `quality`) is new.
   */
  const upgrading = new Map<string, Promise<void>>()

  /**
   * Restart a device's OPEN session AT `quality` — that one slot only, with
   * a freshly resolved profile, carrying subscribers and refcount onto the
   * fresh entry. Plan 100 §3.2: the pre-100.4 `wall → control` restart
   * (`upgradeToControl`, which this function's body used to unconditionally
   * BE) is gone — that transition is now "open a second entry" (§4.2's
   * `buildEntry` fast path), never a same-slot rebuild. This function keeps
   * doing exactly what it did for `reprofile` (plan 92 §3.8): a same-quality
   * requality of an entry that is unambiguously still open. A no-op when
   * the device has no open entry at `quality` — nothing to restart, and a
   * plain `acquire` builds the right thing directly.
   */
  async function restartAt(deviceId: string, quality: Quality, detail?: string): Promise<void> {
    const key = entryKey(deviceId, quality)
    if (!entries.has(key)) return
    let pending = upgrading.get(key)
    if (!pending) {
      pending = (async () => {
        const old = entries.get(key)
        if (!old) return
        entries.delete(key)
        if (old.closeTimer) clearTimeout(old.closeTimer)
        await old.session.close().catch((err) => deps.log.warn(`failed to close session ${deviceId}: ${String(err)}`))
        // `detail` is always set by `reprofile` today (§3.8 rule 5) — the
        // only remaining caller of `restartAt` since `upgradeToControl` was
        // deleted (plan 100 §3.2). The `quality_upgrade` reason kept below
        // is a defensive fallback for any future caller of this general
        // primitive that restarts with no detail, not a live path today.
        deps.onEvent?.(deviceId, 'session.closed', { reason: detail ? 'video_reprofile' : 'quality_upgrade' })
        // Through the build lane (plan 92 §3.3) like every other new build —
        // a restart pushes a fresh jar and spawns a fresh scrcpy child
        // exactly like a brand-new session does, so it competes for the
        // same farm-wide permits. Never the fast path (`fastOpts` omitted):
        // a same-quality restart still needs the full wake/rotate/text/tag
        // sequence — see 96.24/§4.5's own reasoning for why this plan does
        // not change that.
        const fresh = await buildLane.run(() => createEntry(deviceId, quality, detail))
        // Carry the old entry's subscribers and refcount onto the fresh one —
        // an existing viewer (a wall tile, a device page) keeps receiving
        // frames through the restart; it just sees the picture change once
        // the new session is ready. This is the ENTIRE reason a restart
        // never has to be announced to a viewer separately from
        // `session.progress` (§4.5): the WS subscription itself survives.
        for (const sub of old.frameSubscribers) {
          fresh.frameSubscribers.add(sub)
          subscriberEntry.set(sub, key) // same key string (quality unchanged) — kept in sync regardless
        }
        fresh.refcount = old.refcount
        entries.set(key, fresh)
      })()
      upgrading.set(key, pending)
      void pending.finally(() => upgrading.delete(key))
    }
    await pending
  }

  return {
    async acquire(deviceId, onFrame, quality = 'control') {
      const key = entryKey(deviceId, quality)
      const existing = entries.get(key)
      if (existing) {
        attach(key, existing, onFrame)
        return existing.session
      }

      let pending = inFlight.get(key)
      if (!pending) {
        // The build lane's permit wait happens INSIDE this promise (plan 92
        // §3.3, §4.3) — `inFlight.set` below runs synchronously, before the
        // permit is ever granted, so a second `acquire` for this SAME
        // `(deviceId, quality)` arriving while the first is still queued
        // sees `inFlight` already populated and joins this one promise
        // rather than requesting a permit of its own. The dedupe map and
        // the farm-wide lane are deliberately orthogonal: the map bounds
        // builds PER ENTRY (one), the lane bounds builds ACROSS THE FARM
        // (`maxConcurrentBuilds()`) — taking the permit inside the map's
        // critical section instead would make a queued build hold this
        // entry's dedupe slot while it waits, and every later subscriber
        // for the SAME entry would then queue behind the lane too instead
        // of sharing the one build it should. `buildEntry` (plan 100 §4.2)
        // is what decides fast-path vs ordinary at the moment the permit is
        // actually granted.
        pending = buildLane.run(() => buildEntry(deviceId, quality))
        inFlight.set(key, pending)
        void pending.catch(() => undefined).finally(() => inFlight.delete(key))
      }
      // Every caller attaches itself, including the one that started the work:
      // `createEntry` deliberately returns an entry with no subscribers. A
      // rejected `pending` (e.g. the fast path's `E_CONTROL_SESSION_UNAVAILABLE`)
      // propagates straight out of this `await` — no entry was ever set, so
      // there is nothing here to clean up.
      await pending
      const entry = entries.get(key)
      if (!entry) throw new SessionError('device_not_ready', `session for ${deviceId} disappeared during acquire`)
      attach(key, entry, onFrame)
      return entry.session
    },

    release(deviceId, onFrame) {
      // `deviceId` is kept for signature compatibility (plan 100 §4.2's own
      // "keep every public method signature unchanged" rule) but is not
      // needed to find the entry: `subscriberEntry` already knows exactly
      // which slot THIS subscriber belongs to, which is what makes this
      // safe against a caller that mismatches deviceId/quality — a bug that
      // would otherwise silently detach the wrong stream.
      const key = subscriberEntry.get(onFrame)
      const entry = key ? entries.get(key) : undefined
      if (!key || !entry) return
      subscriberEntry.delete(onFrame)
      entry.frameSubscribers.delete(onFrame)
      entry.refcount = Math.max(0, entry.refcount - 1)
      if (entry.refcount > 0) return
      entry.idleSince = Date.now()
      const ttlSec = idleTtlSec()
      // 0 closes it immediately — the pre-plan-42 behaviour, exactly (Plan 42 §4.4, acceptance #10).
      if (ttlSec <= 0) {
        void closeEntry(key, 'no_viewers')
        return
      }
      // A viewer that reconnects quickly re-attaches to a live session
      // (Plan 42 §3.4) instead of paying the full session start-up again.
      entry.closeTimer = setTimeout(() => void closeEntry(key, 'idle_timeout'), ttlSec * 1000)
      enforceIdleCap()
    },

    get(deviceId) {
      // Plan 100 §4.2 — highest-quality wins: `control` if that entry is
      // open, else `wall`, else null. Every pre-100.4 caller of bare
      // `get(deviceId)` wants "what am I actually showing this device as",
      // and Control is always the more specific answer when both exist.
      // `getByQuality` below is for the few callers that need a SPECIFIC
      // slot rather than this resolution.
      return entries.get(entryKey(deviceId, 'control'))?.session ?? entries.get(entryKey(deviceId, 'wall'))?.session ?? null
    },

    getByQuality(deviceId, quality) {
      return entries.get(entryKey(deviceId, quality))?.session ?? null
    },

    restartAt,

    // Plan 85 §3.7 — see `SessionManager.setRotation`'s own doc comment.
    async setRotation(deviceId, mode) {
      const open = [...entries.values()].filter((e) => e.deviceId === deviceId)
      // One physical screen: the prep-owning entry first (it holds the
      // capture that `close()` restores), otherwise whichever entry exists.
      const entry = open.find((e) => e.ownsDevicePrep) ?? open[0]
      const lock = entry?.session.rotation
      if (!entry || !lock) return null
      const outcome = await lock.set(mode)
      if (!outcome.applied) {
        deps.onEvent?.(deviceId, 'device.rotation', {
          mode,
          applied: false,
          reason: outcome.reason ?? 'the device did not accept the rotation lock',
          quality: entry.quality,
        })
      }
      return outcome
    },

    async reprofile(reason) {
      // Deduped by device id (plan 100 §4.2): a device can now have both a
      // `wall` and a `control` entry restart in the same pass (distinct
      // settings changes touching both preset tables at once is rare but
      // possible), and the Studio toast this feeds
      // (`buildReprofileToast`, `packages/studio/src/components/video/
      // video-quality.ts`) reports "applied to N DEVICES" — counting the
      // same device twice would overstate that.
      const restartedIds = new Set<string>()
      const skippedBusyIds = new Set<string>()
      let unchanged = 0
      // Nothing to compare an open session's own profile against — a
      // no-op, not a guess (plan 92 §3.8's own reading of `resolveProfile`
      // being optional, mirroring `resolveProfile`'s own doc comment above).
      if (!deps.resolveProfile) return { restarted: [], skippedBusy: [], unchanged }
      const resolveProfile = deps.resolveProfile
      deps.log.info(`reprofile: ${reason}`)
      // Snapshot the candidate keys up front: `restartAt` replaces its own
      // entry (delete, then set, once the rebuild finishes) while this loop
      // runs, and a live `Map` must not be mutated out from under iteration.
      const restarts: Promise<void>[] = []
      for (const key of [...entries.keys()]) {
        const entry = entries.get(key)
        if (!entry) continue // closed by something else between the snapshot and here
        const deviceId = entry.deviceId
        // Rule 4 (§3.8): never mid-job — video keeps running while a job is
        // running (spec §10.1, plan 205 §4.6 — "busy" is derived from the
        // activity list, never stored), and a settings save must not be the
        // thing that interrupts a running script.
        if (deps.hasRunningJob?.(deviceId)) {
          skippedBusyIds.add(deviceId)
          continue
        }
        const quality = entry.quality
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
        restartedIds.add(deviceId)
        // Rule 3: through `restartAt` → the SAME build lane every other
        // build queues behind, so this is dispatched (not awaited one at a
        // time) — the lane, not this loop, decides how many run at once.
        // Rule 5: `detail` is what makes the restart explain itself (F17).
        restarts.push(restartAt(deviceId, quality, 'applying new video settings'))
      }
      await Promise.all(restarts)
      return { restarted: [...restartedIds], skippedBusy: [...skippedBusyIds], unchanged }
    },

    // Plan 100 §4.2 — the device vanished; every entry it holds (both `wall`
    // and `control`, when both are open) must go, not just one.
    async closeDevice(deviceId) {
      const keys = [...entries.entries()].filter(([, e]) => e.deviceId === deviceId).map(([key]) => key)
      await Promise.all(keys.map((key) => closeEntry(key, 'device_gone')))
    },

    // Plan 100 §4.2 — close every IDLE entry this device holds (both `wall`
    // and `control`, when both are open and idle), so a job claim never
    // inherits a stale entry at EITHER slot.
    async closeIfIdle(deviceId) {
      const idle = [...entries.entries()].filter(([, e]) => e.deviceId === deviceId && e.refcount === 0).map(([key]) => key)
      await Promise.all(idle.map((key) => closeEntry(key, 'claimed')))
    },

    idleSessions() {
      return [...entries.values()]
        .filter((e) => e.idleSince !== null)
        .map((e) => ({ deviceId: e.deviceId, idleSince: e.idleSince as number }))
        .sort((a, b) => a.idleSince - b.idleSince)
    },

    async closeAll(reason = 'shutdown') {
      const keys = [...entries.keys()]
      await Promise.all(keys.map((key) => closeEntry(key, reason)))
      return keys.length
    },

    activeDeviceIds() {
      // Deduped (plan 100 §4.2): this reports DEVICES with an open session,
      // not sessions — a device holding both a `wall` and a `control` entry
      // still counts once, matching what every pre-100.4 caller (the adb
      // restart confirmation's "N screens will stop" preview) already means
      // by "device ids".
      return [...new Set([...entries.values()].map((e) => e.deviceId))]
    },

    videoStats() {
      let control = 0
      let wall = 0
      const profiles: { deviceId: string; quality: Quality; maxSize: number; maxFps: number; bitRate: number }[] = []
      for (const entry of entries.values()) {
        if (entry.quality === 'control') control++
        else wall++
        if (entry.videoProfile) {
          profiles.push({
            deviceId: entry.deviceId,
            quality: entry.quality,
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

    videoLatency(deviceId) {
      const rows: Array<{ quality: Quality; viewers: number } & VideoLatencySnapshot> = []
      for (const entry of entries.values()) {
        if (entry.deviceId !== deviceId) continue
        rows.push({ quality: entry.quality, viewers: entry.refcount, ...entry.latency.snapshot() })
      }
      return rows
    },
  }
}
