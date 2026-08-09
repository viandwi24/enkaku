import type { ArtifactInfo, MonitorEndReason, MonitorKind } from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import { createCrashParser, type CrashEvent } from './crash-parser'

export type CrashPolicy = 'ignore' | 'declared' | 'any'

/**
 * The slice of `MonitorHub` the watcher actually needs (plan 37 §4.3) — a
 * narrowed structural type rather than importing the concrete `MonitorHub`
 * interface, so a test can hand it a minimal fake without implementing
 * `releaseClient`/`stopForDevice` too. The REAL dependency passed in
 * production (`ws-handlers.ts`) is the exact same `MonitorHub` instance a
 * human viewer's `monitor.start` goes through — that shared instance is what
 * makes acceptance #8 (one stream, two watchers) true; this interface does
 * not need to know that to be correct.
 */
export interface CrashWatcherHub {
  subscribe(clientId: string, deviceId: string, kind: MonitorKind, options: unknown): Promise<{ streamId: string; backlog: string[] }>
  unsubscribe(clientId: string, streamId: string): void
}

export interface CrashWatcherDeps {
  hub: CrashWatcherHub
  /** The internal client id (plan 37 §4.3) — always `'internal:crash'` in production; overridable for tests. */
  clientId?: string
  /** `EventRecorder.record` — buffered, fire-and-forget, exactly like every other device event (plan 18 §3.5). */
  record: (e: { deviceId: string; stream: 'main' | 'input'; kind: string; actor?: string | null; meta?: Record<string, unknown> }) => void
  /**
   * Writes the trace (plan 37 §3.6): job-scoped when `jobId` is non-null (a
   * job lease was held when the crash arrived), device-scoped otherwise —
   * the caller (`ws-handlers.ts`/`daemon.ts`) decides which artifact store
   * that maps to; the watcher only knows "attach to this job, or just this
   * device".
   */
  saveTrace: (opts: { deviceId: string; jobId: string | null; label: string; text: string }) => Promise<ArtifactInfo>
  /** The device's current JOB lease, if any (plan 37 §3.3) — a manual lease means no attribution. */
  getJobLease: (deviceId: string) => { jobId: string } | null
  /** Read fresh per crash (same pattern as every other farm setting, e.g. `adb.maxConcurrent`). */
  crashPolicy: () => CrashPolicy
  /** The `declared` policy's target package set for a running job (plan 37 §3.4, §4.4). */
  targetPackagesForJob: (jobId: string) => string[]
  log: Logger
  /** Forwarded to `createCrashParser` — overridable for tests only. */
  idleMs?: number
  maxLines?: number
  /** Crashes/minute/device beyond this are logged once and dropped (plan 37 §8 risks). */
  maxPerMinutePerDevice?: number
  /**
   * The farm-wide switch (plan 85 §3.2, §5 step 85.4, `monitor.crashWatch` in
   * `packages/protocol/src/settings.ts`) — read fresh on every `watch()` call
   * and before every resubscribe attempt, the same freshness guarantee
   * `crashPolicy` already gives `job.crashPolicy`. Omitted (or returning
   * `'always'`) keeps today's behaviour: a farm that never wires this setting
   * through never notices it exists. `'off'` trades the always-on detection
   * for the stream slot it costs per device — `watch()` becomes a no-op and
   * any in-flight resubscribe loop stops instead of retrying.
   */
  crashWatch?: () => 'always' | 'off'
  /**
   * Test-only override for the resubscribe backoff (plan 85 §3.2, §5 step
   * 85.4) — production always uses 2 s → 60 s. Kept as an explicit escape
   * hatch rather than a real setting because the schedule itself is not a
   * farm policy, only its existence is.
   */
  restartBackoffMs?: { initialMs: number; maxMs: number }
}

export interface CrashWatcher {
  /** Subscribes the shared crash stream for a device (idempotent — plan 37 §4.3). */
  watch(deviceId: string): Promise<void>
  unwatch(deviceId: string): void
  /** Jobs register interest; the watcher calls back only once it has already decided the crash policy matches (plan 37 §4.3). */
  onJobCrash(cb: (deviceId: string, jobId: string, e: CrashEvent) => void): void
  /**
   * Fed by the shared hub's own `onData`/`onEnded` (plan 37 §4.3) — the
   * watcher is not itself a `MonitorHub` subscriber callback (the hub's
   * `onData`/`onEnded` are set once at construction, not per-`subscribe()`
   * call), so `ws-handlers.ts` routes matching lines here explicitly. Not
   * part of the plan's illustrative `CrashWatcher` sketch; documented as a
   * deliberate addition in the plan-37 report.
   */
  handleStreamData(streamId: string, lines: string[]): void
  handleStreamEnded(streamId: string, reason: MonitorEndReason): void
}

const DEFAULT_MAX_PER_MINUTE = 20
/** The resubscribe backoff's floor and ceiling (plan 85 §3.2, §5 step 85.4) — 2 s → 60 s, doubling. */
const DEFAULT_RESTART_INITIAL_MS = 2_000
const DEFAULT_RESTART_MAX_MS = 60_000

interface Watch {
  deviceId: string
  streamId: string
  feed: (line: string) => void
  rateWindowStart: number
  rateCount: number
}

/** A backoff-driven resubscribe waiting to fire for one device (plan 85 §3.2). */
interface Restart {
  /** 0-based: how many consecutive resubscribe attempts have already failed since the last live stream. */
  attempt: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * Always-on crash detection (plan 37 §3.3, §4.3): one instance shares its
 * `hub` with every human Monitor tab, subscribing as `internal:crash` so a
 * device with both a watcher and an open viewer still runs exactly one
 * `logcat` process (acceptance #8). Detection never depends on a job being
 * active; job attribution is a second, independent step done per crash, by
 * checking whether a JOB lease (not a manual one) is currently held.
 */
export function createCrashWatcher(deps: CrashWatcherDeps): CrashWatcher {
  const clientId = deps.clientId ?? 'internal:crash'
  const maxPerMinute = deps.maxPerMinutePerDevice ?? DEFAULT_MAX_PER_MINUTE
  const restartInitialMs = deps.restartBackoffMs?.initialMs ?? DEFAULT_RESTART_INITIAL_MS
  const restartMaxMs = deps.restartBackoffMs?.maxMs ?? DEFAULT_RESTART_MAX_MS

  const byDevice = new Map<string, Watch>()
  const byStream = new Map<string, Watch>()
  /** Subscriptions already in flight — makes `watch()` safe to call twice back-to-back (plan 24's `MonitorHub.inFlight` precedent). */
  const pending = new Map<string, Promise<void>>()
  const jobCrashCallbacks: Array<(deviceId: string, jobId: string, e: CrashEvent) => void> = []
  /**
   * Devices whose session is still open (plan 85 §3.2, §5 step 85.4) — set by
   * `watch()`, cleared by `unwatch()`. This is the single source of truth for
   * "should a dead stream come back": `handleStreamEnded` only schedules a
   * resubscribe while the device is still in this set, and `unwatch()`
   * removing it is what makes "stop cleanly when the session closes" true
   * even while a backoff timer is mid-wait.
   */
  const desired = new Set<string>()
  /** A pending (or in-flight) backoff-driven resubscribe, keyed by deviceId. Present only between an unexpected end and its next resubscribe attempt. */
  const restarting = new Map<string, Restart>()

  function crashWatchEnabled(): boolean {
    return (deps.crashWatch?.() ?? 'always') !== 'off'
  }

  function clearRestart(deviceId: string): void {
    const r = restarting.get(deviceId)
    if (!r) return
    clearTimeout(r.timer)
    restarting.delete(deviceId)
  }

  /**
   * One warn per restart (plan 85 §5 step 85.4 verifiable result: "a forced
   * stream kill produces exactly one warn plus one resubscribe — not
   * silence"). `attempt` is 0 for the FIRST resubscribe after a stream that
   * was actually running; a resubscribe attempt that itself fails schedules
   * the next one at `attempt + 1`, growing the delay instead of resetting it
   * — the delay only resets to `restartInitialMs` once a stream genuinely
   * comes back up.
   */
  function scheduleRestart(deviceId: string, reason: string, attempt: number): void {
    if (!desired.has(deviceId)) return // the session closed under us — nothing to restart for
    if (!crashWatchEnabled()) return // the farm traded detection for the stream slot (plan 85 §3.2) — do not fight that choice
    const delayMs = Math.min(restartMaxMs, restartInitialMs * 2 ** attempt)
    deps.log.warn(`crash watch on ${deviceId} ended (${reason}) — resubscribing in ${delayMs}ms (attempt ${attempt + 1})`)
    const timer = setTimeout(() => {
      restarting.delete(deviceId)
      if (!desired.has(deviceId)) return // closed while we were waiting
      if (!crashWatchEnabled()) return
      void startWatch(deviceId).catch((err) => {
        scheduleRestart(deviceId, `resubscribe failed: ${String(err)}`, attempt + 1)
      })
    }, delayMs)
    restarting.set(deviceId, { attempt, timer })
  }

  function rateLimited(w: Watch): boolean {
    const now = Date.now()
    if (now - w.rateWindowStart >= 60_000) {
      w.rateWindowStart = now
      w.rateCount = 0
    }
    w.rateCount += 1
    if (w.rateCount > maxPerMinute) {
      if (w.rateCount === maxPerMinute + 1) {
        deps.log.warn(`device ${w.deviceId}: more than ${maxPerMinute} crashes/min — dropping further events this window (plan 37 §8 risks)`)
      }
      return true
    }
    return false
  }

  function shouldFailJob(policy: CrashPolicy, e: CrashEvent, targets: string[]): boolean {
    if (policy === 'ignore') return false
    if (policy === 'any') return !e.system
    // 'declared': only the script's own target package(s) — plan 37 §3.4.
    return targets.includes(e.package)
  }

  async function onEvent(deviceId: string, e: CrashEvent): Promise<void> {
    const w = byDevice.get(deviceId)
    if (w && rateLimited(w)) return

    const lease = deps.getJobLease(deviceId)
    const jobId = lease?.jobId ?? null

    // The trace is written BEFORE the event is recorded (not after, in
    // parallel) so the event's `meta.artifactId` can point straight at it —
    // Studio's Crashes panel (plan 37 §4.5) then needs no second query to
    // link "this crash" to "its trace". A failed save must not lose the
    // crash record itself, so this is best-effort: `artifact` stays null and
    // the event is recorded regardless (plan 37 §3.6 is about capture, not a
    // reason to hide that the crash happened).
    let artifact: ArtifactInfo | null = null
    try {
      artifact = await deps.saveTrace({ deviceId, jobId, label: `${e.kind}-${e.package}`, text: e.trace })
    } catch (err) {
      deps.log.warn(`failed to save the crash trace for ${deviceId}: ${String(err)}`)
    }

    // Always recorded — a crash is an event first, a job failure second
    // (plan 37 §3.3, acceptance #1, #3, #7).
    deps.record({
      deviceId,
      stream: 'main',
      kind: 'app.crashed',
      meta: {
        kind: e.kind,
        package: e.package,
        process: e.process,
        exception: e.exception,
        message: e.message,
        system: e.system,
        truncated: e.truncated,
        ...(artifact ? { artifactId: artifact.id } : {}),
        ...(jobId ? { jobId } : {}),
      },
    })

    // Job attribution requires a JOB lease specifically (plan 37 §3.3, §8
    // risks) — a manual lease at the moment the crash arrives means the
    // event above was recorded, full stop; there is no job to fail.
    if (!jobId) return
    const policy = deps.crashPolicy()
    const targets = deps.targetPackagesForJob(jobId)
    if (!shouldFailJob(policy, e, targets)) return
    for (const cb of jobCrashCallbacks) cb(deviceId, jobId, e)
  }

  async function startWatch(deviceId: string): Promise<void> {
    const { streamId } = await deps.hub.subscribe(clientId, deviceId, 'crash', {})
    const feed = createCrashParser((e) => void onEvent(deviceId, e), { idleMs: deps.idleMs, maxLines: deps.maxLines })
    const w: Watch = { deviceId, streamId, feed, rateWindowStart: Date.now(), rateCount: 0 }
    byDevice.set(deviceId, w)
    byStream.set(streamId, w)
  }

  return {
    async watch(deviceId) {
      desired.add(deviceId)
      if (byDevice.has(deviceId)) return // idempotent (plan 37 §4.3)
      if (restarting.has(deviceId)) return // a backoff-driven resubscribe is already pending — let it run, do not race it
      if (!crashWatchEnabled()) return // monitor.crashWatch: 'off' (plan 85 §3.2) — trade detection for the stream slot
      let inFlight = pending.get(deviceId)
      if (!inFlight) {
        inFlight = startWatch(deviceId)
        pending.set(deviceId, inFlight)
        void inFlight.catch(() => undefined).finally(() => pending.delete(deviceId))
      }
      await inFlight
    },

    unwatch(deviceId) {
      // The session closed (or the device did) — this is what makes a
      // backoff timer mid-wait stop cleanly instead of leaking (plan 85 §3.2,
      // §5 step 85.4): removing `deviceId` from `desired` first means the
      // timer's own `desired.has` check, and any `scheduleRestart` call
      // racing with this one, both see "no longer wanted".
      desired.delete(deviceId)
      clearRestart(deviceId)
      const w = byDevice.get(deviceId)
      if (!w) return
      byDevice.delete(deviceId)
      byStream.delete(w.streamId)
      deps.hub.unsubscribe(clientId, w.streamId)
    },

    onJobCrash(cb) {
      jobCrashCallbacks.push(cb)
    },

    handleStreamData(streamId, lines) {
      const w = byStream.get(streamId)
      if (!w) return
      for (const line of lines) w.feed(line)
    },

    handleStreamEnded(streamId, reason) {
      // If `unwatch()` already ran for this device (the common case — the
      // session-lifecycle hooks in daemon.ts call it on session close), it
      // already deleted this bookkeeping synchronously, so `w` is undefined
      // here and there is nothing to restart: a deliberate stop must never
      // trigger a resubscribe.
      //
      // Otherwise the stream ended for a reason outside this watcher's
      // control — device offline, the 32 MiB byte cap (`monitor-hub.ts`'s
      // per-kind override takes the idle/absolute clocks off the table for
      // `crash`, so bytes and genuine errors are what remain), or the
      // underlying adb transport just dying (plan 24 §4.2). Plan 85 §3.2's
      // whole point is that this must not be silent death: the crash feed
      // resubscribes with backoff instead of just dropping its bookkeeping
      // (fixes F6).
      const w = byStream.get(streamId)
      if (!w) return
      byStream.delete(streamId)
      byDevice.delete(w.deviceId)
      scheduleRestart(w.deviceId, reason, 0)
    },
  }
}
