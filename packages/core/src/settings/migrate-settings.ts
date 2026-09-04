import { FarmSettingsSchema, type FarmSettings } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

/** A value out of the new schema's range, clamped, with the fact recorded. */
interface Clamp {
  path: string
  from: unknown
  to: unknown
}

const RESET_POLICY: Record<string, 'never' | 'always' | 'on-failure'> = {
  none: 'never',
  home: 'always',
  declared: 'always',
  aggressive: 'always',
  never: 'never',
  always: 'always',
  'on-failure': 'on-failure',
}

function n(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function clampTo(lo: number, hi: number, v: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function get(o: unknown, ...path: string[]): unknown {
  let cur: unknown = o
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/**
 * Map a settings blob written by ANY earlier schema onto the nine-key one
 * (plan 212 §4.8). Three rules, in this order:
 *   1. a renamed key is mapped;
 *   2. an unknown key is dropped (Zod's own strip mode does this; nothing
 *      here has to);
 *   3. a value outside the new bounds is clamped, and every clamp is logged
 *      on its own line - never silently.
 * Returns a value that is then parsed; if the parse still fails, the caller
 * logs and falls back to defaults, which is the only path that loses data.
 */
export function migrateFarmSettings(raw: unknown, log: Logger): FarmSettings {
  const clamps: Clamp[] = []
  const clamp = (path: string, lo: number, hi: number, v: number): number => {
    const out = clampTo(lo, hi, v)
    if (out !== v) clamps.push({ path, from: v, to: out })
    return out
  }

  // Already the new shape (nine keys, `general` present): parse as-is.
  if (get(raw, 'general') !== undefined) {
    const parsed = FarmSettingsSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  }

  const labelMode = get(raw, 'defaults', 'labelling', 'mode')
  const showName = get(raw, 'defaults', 'labelling', 'showName')
  if (labelMode === 'wallpaper') {
    log.warn('settings: the wallpaper label surface is now the env var ENKAKU_DEVICE_LABEL_SURFACE=wallpaper; the stored mode is dropped')
  }

  const shellMode = get(raw, 'shell', 'mode')
  const oldTouch = get(raw, 'defaults', 'timing', 'profile')
  const oldReset = get(raw, 'job', 'resetPolicy')

  // Report every constant path whose stored value differs from the default
  // it replaced (plan 212 §8 risk R6) - a farm that tuned one of these loses
  // the ability to change it here; the log line names the env var that
  // restores it.
  const warnConstantDrift = (path: string, storedValue: unknown, defaultValue: unknown, envVar: string): void => {
    if (storedValue === undefined) return
    if (storedValue === defaultValue) return
    log.warn(`settings: ${path} was ${JSON.stringify(storedValue)}, which is now the constant ${envVar} (default ${JSON.stringify(defaultValue)}); set ${envVar} to restore it`)
  }
  warnConstantDrift('adb.maxStreamsPerDevice', n(get(raw, 'adb', 'maxStreamsPerDevice')), 4, 'ENKAKU_ADB_MAX_STREAMS_PER_DEVICE')
  warnConstantDrift('discovery.scanIntervalSec', n(get(raw, 'discovery', 'scanIntervalSec')), 10, 'ENKAKU_DEVICE_RESCAN_INTERVAL_SEC')
  warnConstantDrift('wall.decodeTileCeiling', n(get(raw, 'wall', 'decodeTileCeiling')), 24, 'ENKAKU_WALL_DECODE_TILE_CEILING')

  const next = {
    general: {
      name: str(get(raw, 'general', 'name')) ?? 'Enkaku farm',
      deviceLabel: labelMode === 'off' || labelMode === undefined ? 'off' : showName === false ? 'number' : 'number-and-name',
    },
    hostDaemon: { egressProbeUrl: process.env.ENKAKU_NETWORK_PROBE_URL?.trim() ?? '' },
    networkScan: { networks: Array.isArray(get(raw, 'discovery', 'networks')) ? get(raw, 'discovery', 'networks') : [] },
    jobRunner: {
      defaultTimeoutMs: clamp('jobRunner.defaultTimeoutMs', 30_000, 86_400_000, n(get(raw, 'job', 'defaultTimeoutMs')) ?? 3_600_000),
      resetPolicy: RESET_POLICY[String(oldReset)] ?? 'always',
      touchProfile: oldTouch === 'instant' ? 'precise' : 'natural',
    },
    capture: {
      controlQuality: get(raw, 'video', 'controlPreset') ?? 'sharp',
      wallQuality: get(raw, 'video', 'wallPreset') ?? 'balanced',
    },
    storage: {
      historyDays: clamp('storage.historyDays', 1, 3_650, n(get(raw, 'retention', 'eventMainDays')) ?? 30),
      traceDays: clamp('storage.traceDays', 1, 3_650, n(get(raw, 'retention', 'traceDays')) ?? 7),
      artifacts: {
        maxAgeDays: clamp('storage.artifacts.maxAgeDays', 1, 3_650, n(get(raw, 'retention', 'maxAgeDays')) ?? 30),
        maxTotalGb: clamp('storage.artifacts.maxTotalGb', 0.1, 10_000, n(get(raw, 'retention', 'maxTotalGb')) ?? 20),
      },
    },
    devices: { tempThresholdC: clamp('devices.tempThresholdC', 20, 90, n(get(raw, 'battery', 'tempThresholdC')) ?? 45) },
    privacy: {
      overControl: get(raw, 'control', 'overControl') ?? 'allow',
      adbCommand: shellMode === undefined ? true : shellMode !== 'off',
    },
    advanced: {
      adbMaxConcurrent: clamp('advanced.adbMaxConcurrent', 0, 24, n(get(raw, 'adb', 'maxConcurrent')) ?? 0),
      installsPerUsbRoot: clamp('advanced.installsPerUsbRoot', 1, 16, n(get(raw, 'adb', 'maxInstallConcurrent')) ?? 1),
      sessionBuildsPerUsbRoot: clamp('advanced.sessionBuildsPerUsbRoot', 1, 16, n(get(raw, 'session', 'buildsPerUsbRoot')) ?? 4),
      infraRetry: {
        attempts: clamp('advanced.infraRetry.attempts', 0, 10, n(get(raw, 'job', 'retry', 'maxInfraAttempts')) ?? 3),
        backoffBaseMs: clamp('advanced.infraRetry.backoffBaseMs', 100, 60_000, n(get(raw, 'job', 'retry', 'backoffBaseMs')) ?? 1_000),
      },
      jobMemoryLimitBytes: clamp(
        'advanced.jobMemoryLimitBytes',
        67_108_864,
        17_179_869_184,
        n(get(raw, 'job', 'memory', 'defaultMaxRssBytes')) ?? 268_435_456,
      ),
      transferCaps: {
        maxPushBytes: n(get(raw, 'transfer', 'maxPushBytes')) ?? 536_870_912,
        maxPullBytes: n(get(raw, 'transfer', 'maxPullBytes')) ?? 536_870_912,
        maxArchiveBytes: clamp(
          'advanced.transferCaps.maxArchiveBytes',
          1_048_576,
          4_294_967_295,
          n(get(raw, 'transfer', 'maxArchiveBytes')) ?? 2_147_483_648,
        ),
      },
      installTimeoutMs: clamp('advanced.installTimeoutMs', 10_000, 1_800_000, n(get(raw, 'transfer', 'installTimeoutMs')) ?? 120_000),
      adbHealthIntervalSec: clamp('advanced.adbHealthIntervalSec', 5, 300, n(get(raw, 'adbControl', 'healthIntervalSec')) ?? 30),
      failuresBeforeQuarantine: clamp('advanced.failuresBeforeQuarantine', 1, 20, n(get(raw, 'health', 'consecutiveFailures')) ?? 5),
      wallWanBandwidthBps: 20_000_000,
      recoveryResetsPerHour: clamp('advanced.recoveryResetsPerHour', 1, 20, n(get(raw, 'guestAgent', 'maxRecoveryCyclesPerHour')) ?? 6),
    },
  }

  for (const c of clamps) log.warn(`settings: ${c.path} was ${String(c.from)}, outside the new range; clamped to ${String(c.to)}`)

  const parsed = FarmSettingsSchema.safeParse(next)
  if (parsed.success) return parsed.data
  log.warn(
    `settings: the stored row could not be migrated (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}); starting from defaults`,
  )
  return FarmSettingsSchema.parse({})
}
