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

interface Watch {
  deviceId: string
  streamId: string
  feed: (line: string) => void
  rateWindowStart: number
  rateCount: number
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

  const byDevice = new Map<string, Watch>()
  const byStream = new Map<string, Watch>()
  /** Subscriptions already in flight — makes `watch()` safe to call twice back-to-back (plan 24's `MonitorHub.inFlight` precedent). */
  const pending = new Map<string, Promise<void>>()
  const jobCrashCallbacks: Array<(deviceId: string, jobId: string, e: CrashEvent) => void> = []

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
      if (byDevice.has(deviceId)) return // idempotent (plan 37 §4.3)
      let inFlight = pending.get(deviceId)
      if (!inFlight) {
        inFlight = startWatch(deviceId)
        pending.set(deviceId, inFlight)
        void inFlight.catch(() => undefined).finally(() => pending.delete(deviceId))
      }
      await inFlight
    },

    unwatch(deviceId) {
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

    handleStreamEnded(streamId) {
      // The stream ended for a reason outside this watcher's control (device
      // offline, idle/absolute timeout, byte cap — plan 24 §4.2). The
      // session-lifecycle hooks in daemon.ts already call `unwatch` on
      // session close, which is the common case; this just drops the
      // now-dead bookkeeping so a later `watch()` for the same device starts
      // a genuinely fresh subscription rather than resolving instantly
      // against a stream that no longer exists.
      const w = byStream.get(streamId)
      if (!w) return
      byStream.delete(streamId)
      byDevice.delete(w.deviceId)
    },
  }
}
