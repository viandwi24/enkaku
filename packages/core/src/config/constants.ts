import { z } from 'zod'
import { SCAN_MAX_ADDRESSES as PROTOCOL_SCAN_MAX_ADDRESSES } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'

/**
 * Support overrides (MVP 12 §3). These are NOT settings: they do not differ
 * between farms in any way the product supports, and none of them appears in
 * Studio. Each exists so a support engineer can move one number on one farm
 * without a build, and every one is listed in `.env.example` under
 * "Support overrides".
 *
 * Read once, here, at module load. An invalid value fails the boot with
 * `E_BAD_CONFIG` rather than falling back silently - the same rule
 * `loadConfig()` follows for `enkaku.config.json`.
 */
const applied = new Map<string, string>()

function readEnv(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function parse<T>(name: string, raw: string, schema: z.ZodType<T>, coerce: (s: string) => unknown): T {
  const result = schema.safeParse(coerce(raw))
  if (!result.success) {
    throw new EnkakuError('E_BAD_CONFIG', `${name}: ${result.error.issues.map((i) => i.message).join('; ')}`)
  }
  applied.set(name, raw)
  return result.data
}

/** A number override, checked against the same bounds the old setting had. */
function num(name: string, fallback: number, schema: z.ZodType<number>): number {
  const raw = readEnv(name)
  return raw === undefined ? fallback : parse(name, raw, schema, Number)
}

/** A nullable number: an empty value means "unset"; the literal `none` means null. */
function numOrNull(name: string, fallback: number | null, schema: z.ZodType<number>): number | null {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  if (raw === 'none') {
    applied.set(name, raw)
    return null
  }
  return parse(name, raw, schema, Number)
}

function bool(name: string, fallback: boolean): boolean {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  return parse(name, raw, z.boolean(), (s) => (s === 'true' || s === '1' ? true : s === 'false' || s === '0' ? false : s))
}

function str(name: string, fallback: string, schema: z.ZodType<string> = z.string().min(1)): string {
  const raw = readEnv(name)
  return raw === undefined ? fallback : parse(name, raw, schema, (s) => s)
}

function strOrNull(name: string, fallback: string | null, schema: z.ZodType<string>): string | null {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  if (raw === 'none') {
    applied.set(name, raw)
    return null
  }
  return parse(name, raw, schema, (s) => s)
}

function pick<T extends string>(name: string, fallback: T, values: readonly [T, ...T[]]): T {
  const raw = readEnv(name)
  return raw === undefined ? fallback : (parse(name, raw, z.enum(values), (s) => s) as T)
}

function json<T>(name: string, fallback: T, schema: z.ZodType<T>): T {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  return parse(name, raw, schema, (s) => {
    try {
      return JSON.parse(s)
    } catch {
      throw new EnkakuError('E_BAD_CONFIG', `${name}: not valid JSON`)
    }
  })
}

/** Every override actually in effect, for the boot log and `bun run doctor`. */
export function appliedSupportOverrides(): ReadonlyMap<string, string> {
  return applied
}

// ── Touch profiles (replaces defaults.timing.*, D8–D15) ───────────────────────
const TouchProfileValuesSchema = z.object({
  tapHoldMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  betweenActionMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  coordJitterPx: z.number().min(0).max(20),
  gestureCurvature: z.number().min(0).max(0.5),
  gestureSampleIntervalMs: z.number().int().min(4).max(50),
  perCharMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
})
const TouchProfilesSchema = z.object({ precise: TouchProfileValuesSchema, natural: TouchProfileValuesSchema, slow: TouchProfileValuesSchema })
export type TouchProfileValues = z.infer<typeof TouchProfileValuesSchema>
export type TouchProfiles = z.infer<typeof TouchProfilesSchema>

/** The tuples behind `jobRunner.touchProfile`. `natural` is the pre-212 `defaults.timing` default, unchanged. */
const TOUCH_PROFILES_DEFAULT: TouchProfiles = {
  precise: { tapHoldMs: [40, 60], betweenActionMs: [150, 300], coordJitterPx: 0, gestureCurvature: 0, gestureSampleIntervalMs: 8, perCharMs: [20, 50] },
  natural: { tapHoldMs: [40, 120], betweenActionMs: [300, 900], coordJitterPx: 2, gestureCurvature: 0.08, gestureSampleIntervalMs: 8, perCharMs: [40, 140] },
  slow: { tapHoldMs: [80, 200], betweenActionMs: [700, 1800], coordJitterPx: 3, gestureCurvature: 0.12, gestureSampleIntervalMs: 8, perCharMs: [90, 220] },
}
export const TOUCH_PROFILES = json('ENKAKU_TOUCH_PROFILES', TOUCH_PROFILES_DEFAULT, TouchProfilesSchema)

// ── Device housekeeping (replaces defaults.prep.screenOffTimeoutMs, discovery.*, health.*, adbControl.*, battery.*, labelling.*) ──
export const DEVICE_SCREEN_OFF_TIMEOUT_MS = num('ENKAKU_DEVICE_SCREEN_OFF_TIMEOUT_MS', 1_800_000, z.number().int().min(0))
export const DEVICE_OFFLINE_GRACE_SEC = num('ENKAKU_DEVICE_OFFLINE_GRACE_SEC', 20, z.number().int().min(5).max(600))
export const DEVICE_RECOVERY_COOLDOWN_SEC = num('ENKAKU_DEVICE_RECOVERY_COOLDOWN_SEC', 120, z.number().int().min(30).max(3600))
export const DEVICE_RECOVERY_PROBE_INTERVAL_SEC = num('ENKAKU_DEVICE_RECOVERY_PROBE_INTERVAL_SEC', 60, z.number().int().min(10).max(3600))
export const DEVICE_ENDPOINTS_REMEMBERED = num('ENKAKU_DEVICE_ENDPOINTS_REMEMBERED', 4, z.number().int().min(1).max(16))
export const DEVICE_ENDPOINT_RETIRE_AFTER = num('ENKAKU_DEVICE_ENDPOINT_RETIRE_AFTER', 10, z.number().int().min(1).max(100))
export const DEVICE_CONNECT_SETTLE_MS = num('ENKAKU_DEVICE_CONNECT_SETTLE_MS', 3_000, z.number().int().min(500).max(30_000))
export const DEVICE_RESCAN_INTERVAL_SEC = num('ENKAKU_DEVICE_RESCAN_INTERVAL_SEC', 10, z.number().int().min(0).max(300))
export const DEVICE_AUTO_QUARANTINE = bool('ENKAKU_DEVICE_AUTO_QUARANTINE', true)
export const BATTERY_POLL_INTERVAL_SEC = num('ENKAKU_BATTERY_POLL_INTERVAL_SEC', 60, z.number().int().min(10))
export const DEVICE_LABEL_SURFACE = pick('ENKAKU_DEVICE_LABEL_SURFACE', 'lock-screen', ['lock-screen', 'wallpaper'] as const)
export const LABEL_WRITE_CONCURRENCY = num('ENKAKU_LABEL_WRITE_CONCURRENCY', 2, z.number().int().min(1).max(16))
export const CONTROL_IDLE_SEC = num('ENKAKU_CONTROL_IDLE_SEC', 30, z.number().int().min(5).max(600))

// ── adb transport and the shared server (replaces adb.*, adbControl.*, discovery.tcpPort) ──
export const ADB_TCP_PORT = num('ENKAKU_ADB_TCP_PORT', 5555, z.number().int().min(1024).max(65535))
export const ADB_MAX_STREAMS_PER_DEVICE = num('ENKAKU_ADB_MAX_STREAMS_PER_DEVICE', 4, z.number().int().min(1).max(8))
export const ADB_MAX_STREAMS_FARM = num('ENKAKU_ADB_MAX_STREAMS_FARM', 0, z.number().int().min(0).max(64))
export const ADB_MAX_HOST_PROCESSES = num('ENKAKU_ADB_MAX_HOST_PROCESSES', 4, z.number().int().min(1).max(32))
export const ADB_TIMEOUT_STORM_RATE = num('ENKAKU_ADB_TIMEOUT_STORM_RATE', 0.5, z.number().min(0).max(1))
export const ADB_RESTART_COOLDOWN_SEC = num('ENKAKU_ADB_RESTART_COOLDOWN_SEC', 60, z.number().int().min(10).max(3600))
export const ADB_DRAIN_TIMEOUT_MS = num('ENKAKU_ADB_DRAIN_TIMEOUT_MS', 30_000, z.number().int().min(5_000).max(300_000))

// ── Network sweep and cutover (replaces discovery.scan.*, discovery.cutover.*) ──
export const SCAN_MODE = pick('ENKAKU_SCAN_MODE', 'on-demand', ['off', 'on-demand'] as const)
export const SCAN_MAX_ADDRESSES = num('ENKAKU_SCAN_MAX_ADDRESSES', PROTOCOL_SCAN_MAX_ADDRESSES, z.number().int().min(64).max(4096))
export const SCAN_CONCURRENCY = num('ENKAKU_SCAN_CONCURRENCY', 32, z.number().int().min(1).max(256))
export const SCAN_PROBE_TIMEOUT_MS = num('ENKAKU_SCAN_PROBE_TIMEOUT_MS', 300, z.number().int().min(50).max(5_000))
export const CUTOVER_WINDOW_SEC = num('ENKAKU_CUTOVER_WINDOW_SEC', 180, z.number().int().min(30).max(900))
export const CUTOVER_POLL_SEC = num('ENKAKU_CUTOVER_POLL_SEC', 5, z.number().int().min(1).max(60))

// ── Guest agent and crash monitoring (replaces guestAgent.provision/recoveryRearmSec, monitor.crashWatch) ──
export const GUEST_AGENT_PROVISION = pick('ENKAKU_GUEST_AGENT_PROVISION', 'auto', ['auto', 'manual', 'off'] as const)
export const GUEST_AGENT_RECOVERY_REARM_SEC = num('ENKAKU_GUEST_AGENT_RECOVERY_REARM_SEC', 120, z.number().int().min(30).max(3600))
export const CRASH_WATCH = pick('ENKAKU_CRASH_WATCH', 'always', ['always', 'off'] as const)

// ── Job runtime (replaces job.* minus the two visible and the two advanced) ────
export const JOB_RESET_TIMEOUT_MS = num('ENKAKU_JOB_RESET_TIMEOUT_MS', 15_000, z.number().int().min(1_000).max(60_000))
export const JOB_RESET_STRICT = bool('ENKAKU_JOB_RESET_STRICT', false)
export const JOB_STARTUP_TIMEOUT_MS = num('ENKAKU_JOB_STARTUP_TIMEOUT_MS', 60_000, z.number().int().min(5_000).max(600_000))
export const JOB_MAX_TIMEOUT_MS = numOrNull('ENKAKU_JOB_MAX_TIMEOUT_MS', null, z.number().int().min(30_000).max(86_400_000))
export const JOB_MEMORY_MAX_BYTES = numOrNull('ENKAKU_JOB_MEMORY_MAX_BYTES', null, z.number().int().min(67_108_864).max(17_179_869_184))
export const JOB_MEMORY_ENFORCE = pick('ENKAKU_JOB_MEMORY_ENFORCE', 'kill', ['kill', 'warn', 'off'] as const)
export const JOB_MEMORY_SAMPLE_INTERVAL_MS = num('ENKAKU_JOB_MEMORY_SAMPLE_INTERVAL_MS', 2_000, z.number().int().min(250).max(30_000))
export const JOB_TRIGGER_MAX_DEPTH = num('ENKAKU_JOB_TRIGGER_MAX_DEPTH', 5, z.number().int().min(1).max(50))
export const JOB_TRIGGER_MAX_PER_CHAIN = num('ENKAKU_JOB_TRIGGER_MAX_PER_CHAIN', 200, z.number().int().min(1).max(10_000))
export const JOB_TRIGGER_MAX_PER_JOB = num('ENKAKU_JOB_TRIGGER_MAX_PER_JOB', 10, z.number().int().min(1).max(1_000))
export const JOB_MAX_RESULT_BYTES = num('ENKAKU_JOB_MAX_RESULT_BYTES', 65_536, z.number().int().min(1_024).max(1_048_576))
export const JOB_PROGRESS_INTERVAL_MS = num('ENKAKU_JOB_PROGRESS_INTERVAL_MS', 1_000, z.number().int().min(250).max(10_000))
export const JOB_RETRY_BACKOFF_MAX_MS = num('ENKAKU_JOB_RETRY_BACKOFF_MAX_MS', 30_000, z.number().int().min(1_000).max(300_000))
export const JOB_TIMEOUT_IS_INFRA = bool('ENKAKU_JOB_TIMEOUT_IS_INFRA', false)
export const JOB_REBIND_ON_INFRA = bool('ENKAKU_JOB_REBIND_ON_INFRA', true)
export const JOB_CRASH_POLICY = pick('ENKAKU_JOB_CRASH_POLICY', 'declared', ['ignore', 'declared', 'any'] as const)
export const WORKFLOW_MAX_TOTAL_MS = num('ENKAKU_WORKFLOW_MAX_TOTAL_MS', 21_600_000, z.number().int().min(60_000).max(604_800_000))

// ── Monitoring and retention the sweeper reads but nobody tunes (replaces retention.*) ──
export const INPUT_EVENT_RETENTION_DAYS = num('ENKAKU_INPUT_EVENT_RETENTION_DAYS', 3, z.number().int().min(1).max(365))
export const EVENT_MAX_ROWS_PER_DEVICE = num('ENKAKU_EVENT_MAX_ROWS_PER_DEVICE', 50_000, z.number().int().min(1_000))
export const BLOB_ORPHAN_GRACE_HOURS = num('ENKAKU_BLOB_ORPHAN_GRACE_HOURS', 24, z.number().int().min(1))
export const AUDIT_RETENTION_DAYS = num('ENKAKU_AUDIT_RETENTION_DAYS', 90, z.number().int().min(1).max(3_650))

// ── Device terminal and the temporary adb endpoint (replaces shell.* minus the visible switch) ──
export const SHELL_EXEC_TIMEOUT_MS = num('ENKAKU_SHELL_EXEC_TIMEOUT_MS', 15_000, z.number().int().min(1_000).max(120_000))
export const SHELL_MAX_OUTPUT_BYTES = num('ENKAKU_SHELL_MAX_OUTPUT_BYTES', 262_144, z.number().int().min(4_096).max(4_194_304))
export const ADB_ENDPOINT_ENABLED = bool('ENKAKU_ADB_ENDPOINT_ENABLED', false)
export const ADB_ENDPOINT_BIND = str('ENKAKU_ADB_ENDPOINT_BIND', '127.0.0.1')
export const ADB_ENDPOINT_IDLE_SEC = num('ENKAKU_ADB_ENDPOINT_IDLE_SEC', 300, z.number().int().min(30).max(3_600))
export const ADB_ENDPOINT_MAX_STREAMS = num('ENKAKU_ADB_ENDPOINT_MAX_STREAMS', 8, z.number().int().min(1).max(32))

// ── Input arbitration and display fallback (replaces the plan-205-deleted assist block's queue-wait/depth pair, display.fallbackRetryCount) ──
export const INPUT_WAIT_BUDGET_MS = num('ENKAKU_INPUT_WAIT_BUDGET_MS', 5_000, z.number().int().min(500).max(30_000))
export const INPUT_MAX_QUEUE_DEPTH = num('ENKAKU_INPUT_MAX_QUEUE_DEPTH', 32, z.number().int().min(1).max(256))
export const DISPLAY_FALLBACK_RETRIES = num('ENKAKU_DISPLAY_FALLBACK_RETRIES', 6, z.number().int().min(0).max(20))

// ── Screens view budgets (replaces wall.*, readiness.*) ───────────────────────
export const WALL_MAX_TILES = num('ENKAKU_WALL_MAX_TILES', 0, z.number().int().min(0).max(64))
export const WALL_RAMP_CONCURRENCY = num('ENKAKU_WALL_RAMP_CONCURRENCY', 2, z.number().int().min(1).max(8))
/** 24 is still plan 100 §7.3's unmeasured placeholder; plan 223 measures it (MVP 09 §7). */
export const WALL_DECODE_TILE_CEILING = num('ENKAKU_WALL_DECODE_TILE_CEILING', 24, z.number().int().min(4).max(64))
export const WALL_LAN_BANDWIDTH_BPS = num('ENKAKU_WALL_LAN_BANDWIDTH_BPS', 200_000_000, z.number().int().min(1_000_000).max(1_000_000_000))
export const WALL_TRANSPORT_OVERRIDE = pick('ENKAKU_WALL_TRANSPORT_OVERRIDE', 'auto', ['auto', 'loopback', 'lan', 'wan'] as const)
export const READINESS_MAX_HOT = num('ENKAKU_READINESS_MAX_HOT', 8, z.number().int().min(0).max(64))
export const READINESS_DEFAULT_DESIRED = pick('ENKAKU_READINESS_DEFAULT_DESIRED', 'awake', ['asleep', 'awake', 'hot'] as const)

// ── Transfer, workspace and KV limits (replaces transfer.enabled, workspace.*, kv.*) ──
export const TRANSFER_ENABLED = bool('ENKAKU_TRANSFER_ENABLED', true)
export const WORKSPACE_MAX_FILE_BYTES = num('ENKAKU_WORKSPACE_MAX_FILE_BYTES', 268_435_456, z.number().int().min(1))
export const WORKSPACE_MAX_FILES_PER_SCOPE = num('ENKAKU_WORKSPACE_MAX_FILES_PER_SCOPE', 1_000, z.number().int().min(1))
export const WORKSPACE_MAX_BYTES_PER_SCOPE = num('ENKAKU_WORKSPACE_MAX_BYTES_PER_SCOPE', 8_589_934_592, z.number().int().min(1))
export const WORKSPACE_INLINE_MAX_BYTES = num('ENKAKU_WORKSPACE_INLINE_MAX_BYTES', 65_536, z.number().int().min(0))
export const KV_MAX_VALUE_BYTES = num('ENKAKU_KV_MAX_VALUE_BYTES', 65_536, z.number().int().min(1))
export const KV_MAX_KEY_LENGTH = num('ENKAKU_KV_MAX_KEY_LENGTH', 256, z.number().int().min(1))
export const KV_MAX_ENTRIES_PER_NAMESPACE = num('ENKAKU_KV_MAX_ENTRIES_PER_NAMESPACE', 1_000, z.number().int().min(1))
export const KV_MAX_ENTRIES_PER_DEVICE = num('ENKAKU_KV_MAX_ENTRIES_PER_DEVICE', 5_000, z.number().int().min(1))

// ── Action recorder (parked by plan 210, bounds still enforced; replaces recording.*) ──
export const RECORDING_ANCHOR_QUIET_MS = num('ENKAKU_RECORDING_ANCHOR_QUIET_MS', 400, z.number().int().min(0).max(10_000))
export const RECORDING_ANCHOR_MIN_INTERVAL_MS = num('ENKAKU_RECORDING_ANCHOR_MIN_INTERVAL_MS', 1_500, z.number().int().min(0).max(60_000))
export const RECORDING_LONG_PRESS_MS = num('ENKAKU_RECORDING_LONG_PRESS_MS', 400, z.number().int().min(200).max(10_000))
export const RECORDING_MAX_STEPS = num('ENKAKU_RECORDING_MAX_STEPS', 500, z.number().int().min(1).max(2_000))
export const RECORDING_MAX_DURATION_SEC = num('ENKAKU_RECORDING_MAX_DURATION_SEC', 900, z.number().int().min(1).max(86_400))
export const RECORDING_CAPTURE_SCREENSHOTS = bool('ENKAKU_RECORDING_CAPTURE_SCREENSHOTS', true)

// ── Network geo verification (replaces network.geoProvider/geoIntervalSec) ────
export const GEO_PROVIDER_URL = strOrNull('ENKAKU_GEO_PROVIDER_URL', null, z.string().url())
export const GEO_RECHECK_INTERVAL_SEC = num('ENKAKU_GEO_RECHECK_INTERVAL_SEC', 300, z.number().int().min(30).max(86_400))
