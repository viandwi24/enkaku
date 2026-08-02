export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  child(subsystem: string): Logger
}

function currentLevel(): LogLevel {
  const env = (process.env.ENKAKU_LOG_LEVEL ?? 'info').toLowerCase()
  return env === 'debug' || env === 'info' || env === 'warn' || env === 'error' ? env : 'info'
}

const useJson = (): boolean => process.env.ENKAKU_LOG_JSON === '1'

/**
 * The core's only logging entry point (00-overview §4.2) — no stray
 * console.log anywhere outside this file.
 */
export function createLogger(subsystem: string): Logger {
  const emit = (level: LogLevel, msg: string, extra?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return
    const at = new Date().toISOString()
    if (useJson()) {
      console.error(JSON.stringify({ at, level, subsystem, msg, ...extra }))
    } else {
      const extraStr = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ''
      console.error(`${at} [${level.padEnd(5)}] ${subsystem}: ${msg}${extraStr}`)
    }
  }
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    child: (sub) => createLogger(`${subsystem}.${sub}`),
  }
}
