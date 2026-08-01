import { z } from 'zod'
import { resolveDataDir } from './util/paths'
import { EnkakuError } from './util/errors'
import type { LogLevel } from './util/logger'

/**
 * Config core (plan 09 §4.1). Precedence: env > file > default.
 * Config invalid = boot gagal dengan pesan jelas, bukan diam-diam jalan.
 */

export const AuthConfigSchema = z.object({
  /** auto = local kalau bind loopback, server kalau tidak. */
  mode: z.enum(['auto', 'local', 'server']).default('auto'),
  sessionTtlHours: z.number().int().min(1).default(24 * 14),
  loginMaxAttempts: z.number().int().min(1).default(10),
  loginLockoutSeconds: z.number().int().min(1).default(300),
})

export const TlsConfigSchema = z.object({
  /** off | self (cert sendiri) | external (reverse proxy yang terminate TLS). */
  mode: z.enum(['off', 'self', 'external']).default('off'),
  certPath: z.string().optional(),
  keyPath: z.string().optional(),
})

export const RetentionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxAgeDays: z.number().int().min(1).default(30),
  maxTotalGb: z.number().min(0.1).default(20),
  sweepIntervalMinutes: z.number().int().min(1).default(60),
})

export const LeaseConfigSchema = z.object({
  jobTtlSec: z.number().int().min(10).default(60),
  heartbeatMs: z.number().int().min(1000).default(15_000),
  manualIdleTimeoutSec: z.number().int().min(10).default(300),
  reaperIntervalMs: z.number().int().min(500).default(5000),
})

export const EnkakuConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(7700),
  dataDir: z.string(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  auth: AuthConfigSchema.default(() => AuthConfigSchema.parse({})),
  tls: TlsConfigSchema.default(() => TlsConfigSchema.parse({})),
  retention: RetentionConfigSchema.default(() => RetentionConfigSchema.parse({})),
  lease: LeaseConfigSchema.default(() => LeaseConfigSchema.parse({})),
  scheduler: z
    .object({ fallbackIntervalMs: z.number().int().min(200).default(2000) })
    .default(() => ({ fallbackIntervalMs: 2000 })),
})
export type CoreConfig = z.infer<typeof EnkakuConfigSchema>

export type AuthMode = 'local' | 'server'

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export const isLoopback = (host: string): boolean => LOOPBACK.has(host)

/**
 * Mode auth efektif (plan 09 §4.1). `local` hanya sah saat bind loopback —
 * skip-login di alamat publik akan menyerahkan farm ke siapa pun (spec §14).
 */
export function resolveAuthMode(cfg: CoreConfig): AuthMode {
  const loopback = isLoopback(cfg.host)
  if (cfg.auth.mode === 'server') return 'server'
  if (cfg.auth.mode === 'local') {
    if (!loopback) {
      throw new EnkakuError(
        'E_INSECURE_BIND',
        `auth.mode 'local' hanya boleh saat bind loopback; bind saat ini ${cfg.host}`,
      )
    }
    return 'local'
  }
  return loopback ? 'local' : 'server'
}

/** TLS wajib di mode server (spec §14) kecuali ada opt-out eksplisit. */
export function assertTlsPolicy(cfg: CoreConfig, mode: AuthMode): void {
  if (mode !== 'server') return
  if (cfg.tls.mode === 'off') {
    if (process.env.ENKAKU_ALLOW_INSECURE === '1') {
      // Peringatan besar: ini persis kesalahan ws-scrcpy (spec §6.2).
      console.error(
        '\n!!! ENKAKU_ALLOW_INSECURE=1 — mode server tanpa TLS. Password dan token dikirim polos.\n' +
          '    Pakai hanya di jaringan tepercaya untuk pengujian.\n',
      )
      return
    }
    throw new EnkakuError(
      'E_TLS_REQUIRED',
      'mode server wajib TLS: set tls.mode "self" (+certPath/keyPath) atau "external" (reverse proxy)',
    )
  }
  if (cfg.tls.mode === 'self' && (!cfg.tls.certPath || !cfg.tls.keyPath)) {
    throw new EnkakuError('E_TLS_REQUIRED', 'tls.mode "self" butuh certPath dan keyPath')
  }
}

const intEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? fallback : n
}

export function loadConfig(): CoreConfig {
  const dataDir = resolveDataDir()
  const fileConfig = readConfigFile(dataDir)
  const merged = {
    ...fileConfig,
    dataDir,
    host: process.env.ENKAKU_BIND ?? (fileConfig.host as string | undefined) ?? '127.0.0.1',
    port: intEnv('ENKAKU_PORT', (fileConfig.port as number | undefined) ?? 7700),
    logLevel: (process.env.ENKAKU_LOG_LEVEL as LogLevel | undefined) ?? fileConfig.logLevel ?? 'info',
    auth: {
      ...((fileConfig.auth as object) ?? {}),
      ...(process.env.ENKAKU_AUTH_MODE ? { mode: process.env.ENKAKU_AUTH_MODE } : {}),
    },
    tls: {
      ...((fileConfig.tls as object) ?? {}),
      ...(process.env.ENKAKU_TLS_MODE ? { mode: process.env.ENKAKU_TLS_MODE } : {}),
      ...(process.env.ENKAKU_TLS_CERT ? { certPath: process.env.ENKAKU_TLS_CERT } : {}),
      ...(process.env.ENKAKU_TLS_KEY ? { keyPath: process.env.ENKAKU_TLS_KEY } : {}),
    },
    lease: {
      ...((fileConfig.lease as object) ?? {}),
      jobTtlSec: intEnv('ENKAKU_LEASE_JOB_TTL', 60),
      heartbeatMs: intEnv('ENKAKU_LEASE_HEARTBEAT_MS', 15_000),
      manualIdleTimeoutSec: intEnv('ENKAKU_LEASE_MANUAL_IDLE_TIMEOUT', 300),
      reaperIntervalMs: intEnv('ENKAKU_LEASE_REAPER_MS', 5000),
    },
    scheduler: { fallbackIntervalMs: intEnv('ENKAKU_SCHEDULER_INTERVAL_MS', 2000) },
  }
  const parsed = EnkakuConfigSchema.safeParse(merged)
  if (!parsed.success) {
    throw new EnkakuError(
      'E_BAD_CONFIG',
      `config tidak valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }
  return parsed.data
}

function readConfigFile(dataDir: string): Record<string, unknown> {
  const path = process.env.ENKAKU_CONFIG ?? `${dataDir}/enkaku.config.json`
  try {
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new EnkakuError('E_BAD_CONFIG', `gagal membaca ${path}: ${String(err)}`)
  }
}
