import type { UiServerClient } from './client'
import type { UiServerLauncher } from './launcher'

export type UiServerStatus =
  | { state: 'starting' }
  | { state: 'healthy' }
  | { state: 'restarting'; attempt: number; reason: string }
  /** Watchdog menyerah → session manager menjalankan fallback. */
  | { state: 'dead'; reason: string }

export interface WatchdogOptions {
  client: UiServerClient
  launcher: UiServerLauncher
  localPort: number
  onStatus?: (s: UiServerStatus) => void
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
  /** Ping berkala saat idle (default 5000ms). */
  idlePingMs?: number
  /** Timeout menunggu server siap (default 15000ms). */
  startTimeoutMs?: number
  maxRestartAttempts?: number
}

export interface Watchdog {
  start(): Promise<void>
  stop(): Promise<void>
  /** Dipanggil saat call gagal — memicu restart lebih cepat dari ping. */
  reportFailure(reason: string): void
  isHealthy(): boolean
  isDead(): boolean
}

/**
 * State machine: idle → starting → healthy ⇄ restarting(n) → dead.
 * Instrumentation gampang mati (low-memory killer, battery optimization,
 * atau tool lain yang merebut UiAutomation — termasuk `uiautomator dump`).
 */
export function createWatchdog(opts: WatchdogOptions): Watchdog {
  const idlePingMs = opts.idlePingMs ?? 5000
  const startTimeoutMs = opts.startTimeoutMs ?? 15_000
  const maxAttempts = opts.maxRestartAttempts ?? 2

  let timer: ReturnType<typeof setInterval> | null = null
  let healthy = false
  let dead = false
  let restarting = false
  let consecutiveFailures = 0

  const setStatus = (s: UiServerStatus) => opts.onStatus?.(s)

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
    restarting = true
    healthy = false
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        setStatus({ state: 'restarting', attempt, reason })
        opts.onLog?.('warn', `ui-server restart attempt ${attempt}/${maxAttempts}: ${reason}`)
        await opts.launcher.stop(opts.localPort).catch(() => undefined)
        await Bun.sleep(attempt === 1 ? 1000 : 3000)
        try {
          await opts.launcher.start(opts.localPort)
          if (await waitReady()) {
            healthy = true
            consecutiveFailures = 0
            setStatus({ state: 'healthy' })
            return
          }
        } catch (err) {
          opts.onLog?.('warn', `restart gagal: ${String(err)}`)
        }
      }
      dead = true
      setStatus({ state: 'dead', reason })
      opts.onLog?.('warn', `ui-server menyerah setelah ${maxAttempts} attempt — fallback ke uiautomator-dump`)
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
        await restart('server tidak siap dalam batas waktu start')
      }
      if (!timer) {
        timer = setInterval(() => {
          if (dead || restarting || !healthy) return
          void opts.client.ping().then((ok) => {
            if (ok) {
              consecutiveFailures = 0
              return
            }
            consecutiveFailures += 1
            // Dua kegagalan beruntun = bukan sekadar hiccup.
            if (consecutiveFailures >= 2) void restart('ping gagal 2× beruntun')
          })
        }, idlePingMs)
      }
    },

    async stop() {
      if (timer) clearInterval(timer)
      timer = null
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
