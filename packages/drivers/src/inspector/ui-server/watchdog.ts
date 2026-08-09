import type { UiServerClient } from './client'
import type { UiServerLauncher } from './launcher'

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
  const startTimeoutMs = opts.startTimeoutMs ?? 15_000
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

  async function waitReady(): Promise<boolean> {
    const deadline = Date.now() + startTimeoutMs
    while (Date.now() < deadline) {
      if (await opts.client.ping()) return true
      await Bun.sleep(250)
    }
    return false
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
        await opts.launcher.start(opts.localPort)
        if (await waitReady()) {
          healthy = true
          consecutiveFailures = 0
          setStatus({ state: 'healthy' })
          return
        }
        opts.onLog?.('warn', `restart cycle ${cycle}/${maxRestartsPerWindow} did not bring the server back up within the start timeout`)
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
      await opts.launcher.start(opts.localPort)
      if (await waitReady()) {
        healthy = true
        setStatus({ state: 'healthy' })
      } else {
        await restart('the server was not ready within the start timeout')
      }
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

    isHealthy: () => healthy,
    isDead: () => dead,
  }
}
