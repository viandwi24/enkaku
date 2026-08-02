/**
 * A minimal logger contract — the host (core or agent) injects its own
 * its own, so this package imposes no log format.
 */
export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  child(subsystem: string): Logger
}
