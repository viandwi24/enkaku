import { AdbSocket, type AdbClient } from '@enkaku/adb'
import type { AdbServerHealth, AdbStuckSymptom } from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import type { AdbMetricsStore } from './adb-metrics'

const ADB_HOST = '127.0.0.1'
const ADB_PORT = 5037
/** Plan 88 §3.9's own table: "the socket connects, host:version does not answer within 2 s". */
const PROBE_TIMEOUT_MS = 2_000
/** "...twice in a row". */
const UNRESPONSIVE_STREAK = 2
/** "...whose last 3 execs all timed out". */
const WEDGED_TIMEOUT_STREAK = 3
/** "≥2 serials" — one wedged device is a phone, several at once is the server. */
const WEDGED_MIN_SERIALS = 2
/** "≥3 host:reconnect-offline nudges across ≥3 cooldown windows". */
const RECONNECT_INEFFECTIVE_NUDGES = 3
/** Ten 60s buckets — mirrors `adb-metrics.ts`'s own ring depth. */
const WINDOW_SECONDS = 600
/** "...over ≥20 execs" — below this the rate is too noisy to act on (2 timeouts in 4 tries is not a storm). */
const MIN_WINDOW_EXECS = 20

export type AdbVersionProbeResult = { ok: true; rttMs: number } | { ok: false; reason: 'unreachable' | 'unresponsive' }

/**
 * The real `host:version` probe (plan 88 §3.9, §4.7) — a raw socket,
 * exactly like `doctor/context.ts`'s `checkAdbServer`, deliberately NOT
 * going through `AdbClient`: this must never touch the per-device queue or
 * the streaming lane (F16's `openRaw` precedent — a host service bypasses
 * both), and needs its own fixed 2 s deadline independent of whatever
 * `AdbClient`'s internal defaults happen to be. Exported so tests (and
 * `createAdbServerHealth`'s default) can call it directly.
 */
export async function probeAdbVersion(
  host: string = ADB_HOST,
  port: number = ADB_PORT,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<AdbVersionProbeResult> {
  const start = Date.now()
  let socket: AdbSocket
  try {
    socket = await AdbSocket.connect(host, port, { connectTimeoutMs: timeoutMs })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  try {
    socket.send('host:version')
    await socket.readStatus({ timeoutMs })
    await socket.readBlock({ timeoutMs })
    socket.close()
    return { ok: true, rttMs: Date.now() - start }
  } catch {
    socket.close(true)
    return { ok: false, reason: 'unresponsive' }
  }
}

/** The neutral "never checked yet" snapshot `current()` returns before the first tick completes. */
const ZERO_HEALTH: AdbServerHealth = {
  status: 'ok',
  versionRttMs: null,
  lastCheckedAt: 0,
  window: { seconds: 0, execs: 0, timeouts: 0, timeoutRate: 0 },
  wedged: [],
  stuckOffline: [],
  symptoms: [],
  restartAdvised: false,
}

export interface AdbServerHealthDeps {
  client: () => AdbClient | null
  metrics: AdbMetricsStore
  /** `DeviceReconciler.nudgeCounts()` (plan 88 §4.7) — no second counter. */
  nudgeCounts: () => Map<string, number>
  /** `DeviceReconciler.offlineSerials()` — the same bookkeeping `runOnce`'s grace-period gate already keeps. */
  offlineSerials: () => Map<string, number>
  settings: () => { healthIntervalSec: number; stuckTimeoutRate: number }
  /** Fires only when `status` CHANGES (plan 88 §4.7 — "adb.health transition-only broadcast"), never on every tick. */
  onTransition?: (health: AdbServerHealth) => void
  log: Logger
  /** Overridable for tests; defaults to `probeAdbVersion()` above. */
  probeVersion?: () => Promise<AdbVersionProbeResult>
}

export interface AdbServerHealthMonitor {
  /** The latest computed verdict — `ZERO_HEALTH`-shaped (status 'ok', `lastCheckedAt: 0`) until the first tick completes. */
  current(): AdbServerHealth
  start(): void
  stop(): void
}

/**
 * "Is adb stuck?" (plan 88 §3.9, §0.1 F21/F23) — a continuous, READ-ONLY
 * monitor. It probes, counts, and reports; it never starts, stops, or
 * restarts the adb server. That is the whole point of F21's header comment
 * on the doctor's adb check, carried forward here: "a diagnostic that
 * resets someone else's adb server is not a diagnostic". The action half
 * (restarting adb) is plan 88 §5 step 88.8, wired in a completely different
 * file (`tools/adb-server-control.ts`) — keeping that split clean is why
 * this file has no dependency on anything that can stop adb.
 *
 * Five symptoms, because "stuck" is not one condition (plan 88 §3.9):
 *   - `server-unreachable` — the socket is refused. Restart does NOT help:
 *     `AdbClient.ensureServer()` already self-heals a truly dead server on
 *     the farm's next command (F22) — this just names what is happening.
 *   - `server-unresponsive` — it connects but `host:version` does not
 *     answer twice in a row. This is the case the restart button exists for.
 *   - `transports-wedged` — several serials, not just one, have a streak of
 *     consecutive timeouts. Probably the server; one alone is just a phone.
 *   - `reconnect-ineffective` — a serial has outlasted several automatic
 *     reconnect nudges while still offline. Maybe the server, but a
 *     per-device Reconnect is the cheaper thing to try first.
 *   - `timeout-storm` — a farm-wide spike in the timeout rate. Sometimes
 *     the server, sometimes a saturated USB controller — the remedy must
 *     name both rather than pick one.
 */
export function createAdbServerHealth(deps: AdbServerHealthDeps): AdbServerHealthMonitor {
  const probeVersion = deps.probeVersion ?? (() => probeAdbVersion())
  let current: AdbServerHealth = ZERO_HEALTH
  let consecutiveUnresponsive = 0
  /** symptom → when it first appeared, CONTINUOUSLY — cleared the moment it stops holding, so `since` never claims a longer streak than actually happened. */
  const symptomSince = new Map<AdbStuckSymptom, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  function sinceFor(symptom: AdbStuckSymptom, nowMs: number): number {
    const existing = symptomSince.get(symptom)
    if (existing !== undefined) return existing
    symptomSince.set(symptom, nowMs)
    return nowMs
  }

  async function tick(): Promise<void> {
    const client = deps.client()
    if (!client) return // adb subsystem not up (yet, or ever, e.g. orchestrator mode) — leave `current` as it was
    const nowMs = Date.now()
    const cfg = deps.settings()

    const probe = await probeVersion()
    let versionRttMs: number | null = null
    if (probe.ok) {
      versionRttMs = probe.rttMs
      consecutiveUnresponsive = 0
    } else if (probe.reason === 'unresponsive') {
      consecutiveUnresponsive += 1
    } else {
      consecutiveUnresponsive = 0
    }

    const list = await client.listDevices().catch(() => [])
    const stateBySerial = new Map(list.map((d) => [d.serial, d.state] as const))
    const wedged = list
      .filter((d) => d.state === 'device')
      .map((d) => ({ serial: d.serial, consecutiveTimeouts: deps.metrics.forSerial(d.serial).consecutiveTimeouts, adbState: d.state }))
      .filter((w) => w.consecutiveTimeouts >= WEDGED_TIMEOUT_STREAK)

    const nudges = deps.nudgeCounts()
    const stuckOffline = Array.from(deps.offlineSerials(), ([serial, sinceMs]) => ({
      serial,
      state: stateBySerial.get(serial) ?? 'offline',
      sinceSec: Math.max(0, Math.round((nowMs - sinceMs) / 1000)),
      nudges: nudges.get(serial) ?? 0,
    }))
    const ineffective = stuckOffline.filter((o) => o.nudges >= RECONNECT_INEFFECTIVE_NUDGES)

    const windowStats = deps.metrics.window(WINDOW_SECONDS)

    const symptoms: Array<{ symptom: AdbStuckSymptom; detail: string }> = []
    if (!probe.ok && probe.reason === 'unreachable') {
      symptoms.push({ symptom: 'server-unreachable', detail: `no adb server answered on ${ADB_HOST}:${ADB_PORT}` })
    }
    if (consecutiveUnresponsive >= UNRESPONSIVE_STREAK) {
      symptoms.push({
        symptom: 'server-unresponsive',
        detail: `host:version has not answered within ${PROBE_TIMEOUT_MS}ms across ${consecutiveUnresponsive} consecutive probes`,
      })
    }
    if (wedged.length >= WEDGED_MIN_SERIALS) {
      symptoms.push({
        symptom: 'transports-wedged',
        detail: `${wedged.length} device(s) have ${WEDGED_TIMEOUT_STREAK}+ consecutive adb timeouts: ${wedged.map((w) => w.serial).join(', ')}`,
      })
    }
    if (ineffective.length > 0) {
      symptoms.push({
        symptom: 'reconnect-ineffective',
        detail: `still offline despite automatic reconnect attempts: ${ineffective.map((o) => `${o.serial} (${o.nudges} nudges)`).join(', ')}`,
      })
    }
    if (windowStats.execs >= MIN_WINDOW_EXECS && windowStats.timeoutRate >= cfg.stuckTimeoutRate) {
      symptoms.push({
        symptom: 'timeout-storm',
        detail: `${Math.round(windowStats.timeoutRate * 100)}% of the last ${windowStats.execs} adb commands timed out over ${windowStats.seconds}s`,
      })
    }

    const stuckSymptoms = new Set<AdbStuckSymptom>(['server-unresponsive', 'transports-wedged'])
    const hasStuck = symptoms.some((s) => stuckSymptoms.has(s.symptom))
    const status: AdbServerHealth['status'] = hasStuck ? 'stuck' : symptoms.length > 0 ? 'degraded' : 'ok'

    const next: AdbServerHealth = {
      status,
      versionRttMs,
      lastCheckedAt: nowMs,
      window: windowStats,
      wedged,
      stuckOffline,
      symptoms: symptoms.map((s) => ({ ...s, since: sinceFor(s.symptom, nowMs) })),
      restartAdvised: hasStuck,
    }
    // A symptom that did not fire this tick did not carry over from a previous one either.
    for (const symptom of symptomSince.keys()) {
      if (!symptoms.some((s) => s.symptom === symptom)) symptomSince.delete(symptom)
    }

    const prevStatus = current.status
    current = next
    if (prevStatus !== next.status) deps.onTransition?.(next)
  }

  function scheduleNext(): void {
    if (!running) return
    const intervalMs = Math.max(1, deps.settings().healthIntervalSec * 1000)
    timer = setTimeout(() => {
      void tick()
        .catch((err) => deps.log.warn(`adb health probe failed, will retry next tick: ${String(err)}`))
        .finally(scheduleNext)
    }, intervalMs)
  }

  return {
    current: () => current,
    start() {
      if (running) return
      running = true
      void tick().catch((err) => deps.log.warn(`adb health probe failed, will retry next tick: ${String(err)}`))
      scheduleNext()
    },
    stop() {
      running = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
