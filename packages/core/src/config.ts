import { resolveDataDir } from './util/paths'
import type { LogLevel } from './util/logger'

export interface CoreConfig {
  /** M0 bind localhost saja (spec §14 — aman by default). */
  host: string
  /** Default 7700 (placeholder — Open questions Q1 plan 01). */
  port: number
  dataDir: string
  logLevel: LogLevel
  lease: {
    /** TTL lease job; heartbeat memperpanjang (spec §10.2/§10.3). */
    jobTtlSec: number
    heartbeatMs: number
    manualIdleTimeoutSec: number
    reaperIntervalMs: number
  }
  scheduler: {
    fallbackIntervalMs: number
  }
}

const intEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? fallback : n
}

export function loadConfig(): CoreConfig {
  const rawLevel = (process.env.ENKAKU_LOG_LEVEL ?? 'info') as LogLevel
  return {
    host: '127.0.0.1',
    port: intEnv('ENKAKU_PORT', 7700),
    dataDir: resolveDataDir(),
    logLevel: rawLevel,
    lease: {
      jobTtlSec: intEnv('ENKAKU_LEASE_JOB_TTL', 60),
      heartbeatMs: intEnv('ENKAKU_LEASE_HEARTBEAT_MS', 15_000),
      manualIdleTimeoutSec: intEnv('ENKAKU_LEASE_MANUAL_IDLE_TIMEOUT', 300),
      reaperIntervalMs: intEnv('ENKAKU_LEASE_REAPER_MS', 5_000),
    },
    scheduler: {
      fallbackIntervalMs: intEnv('ENKAKU_SCHEDULER_INTERVAL_MS', 2_000),
    },
  }
}
