import type { Logger } from './logger'

/**
 * A `warn` for anything slower than `thresholdMs`, rate-limited to once per
 * `key` per `windowMs` (plan 85 §3.6, §4.6, §5 85.7a) — a farm under real
 * load produces many slow requests for the SAME underlying cause, and a line
 * per occurrence would make the log unreadable exactly when it matters most.
 * One line every `windowMs` per path/command says "this is still happening"
 * without becoming noise.
 *
 * Shared between `server/http.ts` (HTTP requests, 1s) and
 * `server/ws-handlers.ts` (WS commands, 2s) so both use the SAME rate-limit
 * bookkeeping shape rather than two slightly different implementations.
 */
export function createSlowLogger(log: Logger, opts: { thresholdMs: number; label: string; windowMs?: number }): (key: string, elapsedMs: number) => void {
  const windowMs = opts.windowMs ?? 10_000
  const lastLoggedAt = new Map<string, number>()

  return (key: string, elapsedMs: number): void => {
    if (elapsedMs < opts.thresholdMs) return
    const now = Date.now()
    const last = lastLoggedAt.get(key) ?? 0
    if (now - last < windowMs) return
    lastLoggedAt.set(key, now)
    log.warn(`slow ${opts.label}: ${key} took ${Math.round(elapsedMs)}ms`)
  }
}
