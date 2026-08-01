import { resolveDataDir } from './util/paths'
import type { LogLevel } from './util/logger'

export interface CoreConfig {
  /** M0 bind localhost saja (spec §14 — aman by default). */
  host: string
  /** Default 7700 (placeholder — Open questions Q1 plan 01). */
  port: number
  dataDir: string
  logLevel: LogLevel
}

export function loadConfig(): CoreConfig {
  const rawPort = process.env.ENKAKU_PORT
  const port = rawPort ? Number.parseInt(rawPort, 10) : 7700
  const rawLevel = (process.env.ENKAKU_LOG_LEVEL ?? 'info') as LogLevel
  return {
    host: '127.0.0.1',
    port: Number.isNaN(port) ? 7700 : port,
    dataDir: resolveDataDir(),
    logLevel: rawLevel,
  }
}
