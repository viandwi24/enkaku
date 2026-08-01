/**
 * Kontrak logger minimal — host (core/agent) menyuntikkan implementasinya
 * sendiri, sehingga package ini tidak memaksakan format log.
 */
export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  child(subsystem: string): Logger
}
