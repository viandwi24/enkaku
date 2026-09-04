import type { UiServerClient } from './client'
import type { UiServerLauncher, UiServerStartHooks } from './launcher'

export type UiServerStatus =
  | { state: 'starting' }
  | { state: 'healthy' }
  | { state: 'restarting'; attempt: number; reason: string }
  /** The watchdog gave up → the session manager runs the fallback. */
  | { state: 'dead'; reason: string }

/**
 * Inter-cycle backoff (plan 85 §3.5, fixes F17): grows with every restart
 * CYCLE spent inside the circuit breaker's window, replacing the old flat
 * 1s / 3s that applied per internal attempt. The last entry repeats for any
 * cycle past its length (only reachable when `maxRestartsPerWindow` is
 * raised above the array's length).
 */
export const DEFAULT_RESTART_BACKOFF_MS = [1000, 3000, 10_000, 30_000]

/**
 * The budget for a start that prints nothing (plan 208 §3.3, §4.4). Kept
 * equal to `lifecycle.ts`'s `INSTRUMENTATION_START_SILENCE_MS` by value, not
 * by import: `lifecycle.ts` already imports `createWatchdog` from this
 * module, and a value import back from here would make the two modules
 * genuinely circular (a real risk with `const` — the module that evaluates
 * second would read the other's export before it exists). Both constants
 * are `15_000`; a future change to either must change both.
 */
export const DEFAULT_START_TIMEOUT_MS = 15_000

/**
 * `cycle` is 1-based — the first restart cycle in the window uses
 * `restartCycleBackoffMs(1, ...)`. Exported as a pure function (same shape
 * as `@enkaku/session`'s `backoffDelayMs`) so "the backoff grows" is a fast,
 * deterministic unit test instead of a real wait through 1s/3s/10s/30s.
 */
export function restartCycleBackoffMs(cycle: number, table: number[] = DEFAULT_RESTART_BACKOFF_MS): number {
  const idx = Math.min(Math.max(cycle, 1) - 1, table.length - 1)
  return table[idx] ?? 0
}

export interface WatchdogOptions {
  client: UiServerClient
  launcher: UiServerLauncher
  localPort: number
  onStatus?: (s: UiServerStatus) => void
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
  /** Periodic ping while idle (defaults to 5000ms). */
  idlePingMs?: number
  /** How long to wait for the server to become ready (defaults to 15000ms). */
  startTimeoutMs?: number
  /**
   * Circuit breaker (plan 85 §3.5, fixes F17): more than this many restart
   * CYCLES within `restartWindowMs` moves the watchdog to a terminal `dead`
   * state — even when every individual cycle nominally brought the server
   * back up for a while, because a device that needs a full restart every
   * ~35 seconds is not "healthy" in any useful sense. Defaults to 3.
   */
  maxRestartsPerWindow?: number
  /** The circuit breaker's rolling window. Defaults to 10 minutes. */
  restartWindowMs?: number
  /** Overrides `DEFAULT_RESTART_BACKOFF_MS` — exposed so tests can shrink the real delays instead of waiting through them. */
  restartBackoffMs?: number[]
  /**
   * Awaited after every successful `waitReady` (start and restart), BEFORE
   * `healthy` is reported (plan 208 §4.4) — this is where the lifecycle
   * applies the openatx configurator. Errors are the hook's to log; they
   * never fail the start.
   */
  onReady?: () => Promise<void>
}

export interface Watchdog {
  start(): Promise<void>
  stop(): Promise<void>
  /** Called when a call fails — triggers a restart sooner than the ping would. */
  reportFailure(reason: string): void
  isHealthy(): boolean
  isDead(): boolean
}

/**
 * State machine: idle → starting → healthy ⇄ restarting(cycle) → dead.
 * Instrumentation dies easily (the low-memory killer, battery optimisation,
 * or another tool seizing UiAutomation — `uiautomator dump` included).
 *
 * `dead` is a circuit breaker (plan 85 §3.5, fixes F17), not a per-cycle
 * outcome. The old design reset its failure counter on every restart that
 * itself succeeded, so a device that degrades, restarts, and degrades again
 * every ~35 seconds churned forever without ever tripping it — the field
 * log showed `restart attempt 1/2` three times in 70 seconds and never
 * `gave up`. Here every call to `restart()` spends one cycle from a budget
 * (`maxRestartsPerWindow` per `restartWindowMs`) regardless of whether that
 * particular cycle went on to succeed, and exhausting the budget is
 * terminal for the rest of the session: no code path ever resets `dead`
 * back to `false`, and the ping timer is torn down the moment it fires so
 * nothing keeps polling a server this watchdog has given up on.
 */
export function createWatchdog(opts: WatchdogOptions): Watchdog {
  const idlePingMs = opts.idlePingMs ?? 5000
  const startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const maxRestartsPerWindow = opts.maxRestartsPerWindow ?? 3
  const restartWindowMs = opts.restartWindowMs ?? 10 * 60 * 1000
  const restartBackoffMs = opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS

  let timer: ReturnType<typeof setInterval> | null = null
  let healthy = false
  let dead = false
  let restarting = false
  let consecutiveFailures = 0
  /** Start times (ms) of restart cycles still inside the rolling window. */
  let cycleTimestamps: number[] = []

  const setStatus = (s: UiServerStatus) => opts.onStatus?.(s)

  const clearTimer = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  /**
   * Consults the launcher's fail-fast verdict on every tick BEFORE pinging
   * (plan 208 §3.3, §4.4): a fatal line or an early stream exit rejects
   * within ~250ms of being reported, instead of paying the full silence
   * ceiling. Silence alone — nothing fatal reported, no pong either — still
   * pays the whole `startTimeoutMs` budget, which is what it always claimed
   * to be: the budget for a server that says nothing.
   */
  async function waitReady(verdict: { fatal: string | null }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const deadline = Date.now() + startTimeoutMs
    for (;;) {
      if (verdict.fatal !== null) return { ok: false, reason: verdict.fatal }
      if (await opts.client.ping()) return { ok: true }
      if (Date.now() >= deadline) break
      await Bun.sleep(250)
    }
    if (verdict.fatal !== null) return { ok: false, reason: verdict.fatal }
    return { ok: false, reason: `no ping answered within the ${startTimeoutMs}ms silence ceiling` }
  }

  /** `reportFailure`'s own guard, reused by the launcher's `onExit` hook (plan 208 §4.4). */
  function reportFailureFromExit(reason: string): void {
    if (dead || restarting || !healthy) return
    void restart(reason)
  }

  async function restart(reason: string): Promise<void> {
    if (restarting || dead) return

    // Prune to the rolling window, then decide whether there is still
    // budget for one more cycle BEFORE spending it — this is the whole
    // circuit breaker, and it fires at most once: the moment `dead` is set
    // every other entry point (`restart` itself, `reportFailure`, and the
    // ping timer once cleared) refuses to call in here again.
    const now = Date.now()
    const cutoff = now - restartWindowMs
    cycleTimestamps = cycleTimestamps.filter((t) => t > cutoff)

    if (cycleTimestamps.length >= maxRestartsPerWindow) {
      dead = true
      healthy = false
      clearTimer()
      setStatus({ state: 'dead', reason })
      opts.onLog?.(
        'warn',
        `ui-server spent ${cycleTimestamps.length} restart cycle(s) in the last ${Math.round(restartWindowMs / 1000)}s — giving up for this session and falling back to uiautomator-dump (${reason})`,
      )
      return
    }

    cycleTimestamps.push(now)
    const cycle = cycleTimestamps.length
    restarting = true
    healthy = false
    try {
      setStatus({ state: 'restarting', attempt: cycle, reason })
      opts.onLog?.('warn', `ui-server restart attempt ${cycle}/${maxRestartsPerWindow}: ${reason}`)
      await opts.launcher.stop(opts.localPort).catch(() => undefined)
      await Bun.sleep(restartCycleBackoffMs(cycle, restartBackoffMs))
      try {
        const verdict: { fatal: string | null } = { fatal: null }
        await opts.launcher.start(opts.localPort, {
          onFatal: (r) => {
            verdict.fatal = r
          },
          onExit: (r) => reportFailureFromExit(r),
        })
        const ready = await waitReady(verdict)
        if (ready.ok) {
          await opts.onReady?.().catch(() => undefined)
          healthy = true
          consecutiveFailures = 0
          setStatus({ state: 'healthy' })
          return
        }
        opts.onLog?.('warn', `restart cycle ${cycle}/${maxRestartsPerWindow} did not bring the server back up: ${ready.reason}`)
      } catch (err) {
        opts.onLog?.('warn', `restart failed: ${String(err)}`)
      }
    } finally {
      restarting = false
    }
  }

  return {
    async start() {
      setStatus({ state: 'starting' })
      const verdict: { fatal: string | null } = { fatal: null }
      const hooks: UiServerStartHooks = {
        onFatal: (r) => {
          verdict.fatal = r
        },
        onExit: (r) => reportFailureFromExit(r),
      }
      await opts.launcher.start(opts.localPort, hooks)
      const ready = await waitReady(verdict)
      if (!ready.ok) {
        // (plan 129 §3.2/§4.1, M94) No restart cycle here, deliberately. The
        // old code called `restart()` and never checked its outcome, so a
        // start that never became ready was still reported `healthy` to
        // every caller — measured on the farm as a 32s attach that answered
        // `ready` for a ui-server nothing was listening on. The breaker's
        // budget belongs to RUNTIME recovery (a server that dies later); a
        // second 15s wait on the start path has never once turned into a
        // healthy server here, and only delays the fallback the factory
        // already has ready to use.
        //
        // Plan 208 §3.3, §4.4: `ready.reason` is now one of several — a
        // fatal instrumentation line (often well under 2s), an early stream
        // exit, or the silence ceiling — instead of always the same one
        // sentence regardless of which of those actually happened.
        dead = true
        healthy = false
        setStatus({ state: 'dead', reason: ready.reason })
        throw new Error(`ui-server did not start: ${ready.reason}`)
      }
      await opts.onReady?.().catch(() => undefined)
      healthy = true
      setStatus({ state: 'healthy' })
      // Guarded on `dead` too: a first attempt that already exhausts the
      // breaker (a tiny `maxRestartsPerWindow`, or a window carried over —
      // neither happens in practice today, but nothing should rely on
      // that) must not leave a ping timer running for a watchdog that has
      // already given up.
      if (!timer && !dead) {
        timer = setInterval(() => {
          if (dead || restarting || !healthy) return
          void opts.client.ping().then((ok) => {
            if (ok) {
              consecutiveFailures = 0
              return
            }
            consecutiveFailures += 1
            // Two failures in a row is more than a hiccup.
            if (consecutiveFailures >= 2) void restart('two consecutive ping failures')
          })
        }, idlePingMs)
      }
    },

    async stop() {
      clearTimer()
      healthy = false
      await opts.launcher.stop(opts.localPort).catch(() => undefined)
    },

    reportFailure(reason) {
      if (dead || restarting) return
      void restart(reason)
    },
    // Note: `reportFailureFromExit` above uses `!healthy` in its guard too
    // (dropping a fatal-during-restart exit that races the restart itself);
    // `reportFailure` keeps its original, slightly looser guard unchanged —
    // it is called by `UiServerInspector.call()` only while a real request
    // just failed, which already implies the watchdog believed itself healthy.

    isHealthy: () => healthy,
    isDead: () => dead,
  }
}
