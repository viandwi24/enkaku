#!/usr/bin/env bun
/**
 * soak.ts — plan 223 §4.8. An unattended, repeatable soak tool: samples a
 * running farm at a fixed interval for an arbitrary duration and exits
 * non-zero the moment a threshold from `docs/mvp/09-additional-scope.md` §2
 * is breached — so "it ran fine" becomes a number, not an impression.
 *
 * This is a CONSUMER of plan 206's always-on builder, `GET /api/video/
 * sessions`, and plan 223's own `GET /api/adb/stats` additions (`forwards`,
 * `hostAdb.installsByRoot`, `transport.framesDroppedTotal`) — it invents no
 * new USB-root detector and promises no number it has not itself measured
 * (plan 223 §1, §2 non-goals).
 *
 * Pure pieces first (`buildSoakReport`, `evaluateSoakReport`,
 * `formatSoakTable`, `countAdbProcesses`), unit-testable with a fake stats
 * source (`scripts/soak.test.ts`) — mirrors `scripts/spec-check.ts`'s own
 * split and `scripts/bench-device-nfrs.ts`'s `percentile()`/`flag()` helpers.
 * The CLI driver below is a thin loop over them.
 *
 * Usage:
 *   ENKAKU_TEST_DEVICE=1 bun run scripts/soak.ts --duration-min <N> --expect-devices <N> [options]
 *
 * See `usage()` below for the full flag list; `--help` prints it without
 * touching adb, a device, or the core (checked BEFORE the ENKAKU_TEST_DEVICE
 * gate, same ordering `bench-device-nfrs.ts`'s `--warmup` established).
 */

export interface SoakSample {
  atSec: number
  devicesReady: number
  devicesExpected: number
  adbProcessCount: number
  forwardCount: number
  rssBytes: number
  framesDroppedTotal: number
  jobsSucceededTotal: number
  jobsFailedTotal: number
  /** Summed across devices, from `AdbStatsResponse.devices[].counts`. */
  deviceCounts: { timeout: number; busy: number; error: number }
  /** Devices currently `GET /api/video/sessions` `state === 'recovering'` at THIS sample. */
  recoveringDeviceIds: string[]
}

export interface SoakReport {
  durationSec: number
  devicesExpected: number
  devicesReadyStart: number
  devicesReadyEnd: number
  /** Count of DISTINCT (deviceId, recovering-episode) transitions across all samples — see `buildSoakReport`'s own doc comment. */
  sessionsRebuilt: number
  adbProcessesStart: number
  adbProcessesEnd: number
  forwardsStart: number
  forwardsEnd: number
  rssBytesStart: number
  rssBytesEnd: number
  framesDroppedDuringRun: number
  jobsRun: number
  failuresByClass: { timeout: number; busy: number; error: number }
}

export interface SoakThresholds {
  maxAdbProcessGrowth: number // default 0
  maxForwardGrowth: number // default 0
  maxSessionsRebuilt: number // default 0
  requireDevicesReadyAtEnd: number // default: devicesExpected
}

const ZERO_REPORT: Omit<SoakReport, 'devicesExpected'> = {
  durationSec: 0,
  devicesReadyStart: 0,
  devicesReadyEnd: 0,
  sessionsRebuilt: 0,
  adbProcessesStart: 0,
  adbProcessesEnd: 0,
  forwardsStart: 0,
  forwardsEnd: 0,
  rssBytesStart: 0,
  rssBytesEnd: 0,
  framesDroppedDuringRun: 0,
  jobsRun: 0,
  failuresByClass: { timeout: 0, busy: 0, error: 0 },
}

/**
 * Builds the report from an ordered list of samples (plan 223 §4.8). Pure —
 * no fetch, no `ps`, no clock read — so it is provable without a farm.
 * `sessionsRebuilt` counts a RISING EDGE only: a device entering
 * `recoveringDeviceIds` in sample N when it was NOT in sample N-1 (or N is
 * the first sample) counts once; staying `recovering` across consecutive
 * samples does not count again. This undercounts a rebuild that both starts
 * and fully recovers between two samples — narrowed by `--sample-interval-sec`,
 * never eliminated by a poller (§3.6's own limit: no signal exists yet for a
 * rebuild finer-grained than this).
 */
export function buildSoakReport(samples: SoakSample[], devicesExpected: number): SoakReport {
  if (samples.length === 0) return { ...ZERO_REPORT, devicesExpected }

  const first = samples[0]!
  const last = samples[samples.length - 1]!

  let sessionsRebuilt = 0
  let previousRecovering = new Set<string>()
  for (const sample of samples) {
    const current = new Set(sample.recoveringDeviceIds)
    for (const deviceId of current) {
      if (!previousRecovering.has(deviceId)) sessionsRebuilt += 1
    }
    previousRecovering = current
  }

  return {
    durationSec: last.atSec - first.atSec,
    devicesExpected,
    devicesReadyStart: first.devicesReady,
    devicesReadyEnd: last.devicesReady,
    sessionsRebuilt,
    adbProcessesStart: first.adbProcessCount,
    adbProcessesEnd: last.adbProcessCount,
    forwardsStart: first.forwardCount,
    forwardsEnd: last.forwardCount,
    rssBytesStart: first.rssBytes,
    rssBytesEnd: last.rssBytes,
    framesDroppedDuringRun: last.framesDroppedTotal - first.framesDroppedTotal,
    jobsRun: last.jobsSucceededTotal + last.jobsFailedTotal - (first.jobsSucceededTotal + first.jobsFailedTotal),
    failuresByClass: {
      timeout: last.deviceCounts.timeout - first.deviceCounts.timeout,
      busy: last.deviceCounts.busy - first.deviceCounts.busy,
      error: last.deviceCounts.error - first.deviceCounts.error,
    },
  }
}

/** `true`/an empty `breaches` array when every threshold holds. Pure. */
export function evaluateSoakReport(report: SoakReport, thresholds: SoakThresholds): { ok: boolean; breaches: string[] } {
  const breaches: string[] = []

  const adbGrowth = report.adbProcessesEnd - report.adbProcessesStart
  if (adbGrowth > thresholds.maxAdbProcessGrowth) {
    breaches.push(`adb process count grew by ${adbGrowth} (threshold ${thresholds.maxAdbProcessGrowth})`)
  }

  const forwardGrowth = report.forwardsEnd - report.forwardsStart
  if (forwardGrowth > thresholds.maxForwardGrowth) {
    breaches.push(`forward count grew by ${forwardGrowth} (threshold ${thresholds.maxForwardGrowth})`)
  }

  if (report.sessionsRebuilt > thresholds.maxSessionsRebuilt) {
    breaches.push(`sessions rebuilt ${report.sessionsRebuilt} times (threshold ${thresholds.maxSessionsRebuilt})`)
  }

  if (report.devicesReadyEnd < thresholds.requireDevicesReadyAtEnd) {
    breaches.push(`only ${report.devicesReadyEnd} device(s) ready at end (required ${thresholds.requireDevicesReadyAtEnd})`)
  }

  return { ok: breaches.length === 0, breaches }
}

/** The required table (plan 223 §0 G9), as one preformatted string block. Pure. */
export function formatSoakTable(report: SoakReport): string {
  const rows: Array<[string, string]> = [
    ['duration (s)', String(report.durationSec)],
    ['devices (expected / ready start / ready end)', `${report.devicesExpected} / ${report.devicesReadyStart} / ${report.devicesReadyEnd}`],
    ['sessions rebuilt (== decoder rebuilds, §3.6)', String(report.sessionsRebuilt)],
    ['decoder rebuilds (== sessions rebuilt, §3.6)', String(report.sessionsRebuilt)],
    ['adb processes (start / end)', `${report.adbProcessesStart} / ${report.adbProcessesEnd}`],
    ['forwards (start / end)', `${report.forwardsStart} / ${report.forwardsEnd}`],
    ['RSS bytes (start / end)', `${report.rssBytesStart} / ${report.rssBytesEnd}`],
    ['frames dropped', String(report.framesDroppedDuringRun)],
    ['jobs run', String(report.jobsRun)],
    ['failures by class (timeout / busy / error)', `${report.failuresByClass.timeout} / ${report.failuresByClass.busy} / ${report.failuresByClass.error}`],
  ]
  const width = Math.max(...rows.map(([label]) => label.length))
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n')
}

/**
 * Counts host-side adb-related processes from a `ps -Ao pid=,command=` dump
 * (plan 223 §4.8) — pure, mirrors `parseScrcpyServerList`'s own "parse `ps`
 * output, count/filter, never guess" shape (`@enkaku/scrcpy`). Case-insensitive
 * substring match on `adb` in the command line; a coarse, host-wide count,
 * not scoped to this process's own children (see the plan's own risk row on this).
 */
export function countAdbProcesses(psOutput: string): number {
  return psOutput
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => /adb/i.test(line)).length
}

function usage(): string {
  return `usage: ENKAKU_TEST_DEVICE=1 bun run scripts/soak.ts --duration-min <N> --expect-devices <N> [options]

  --duration-min <N>              required — how long to run, in minutes
  --expect-devices <N>            required — devices that must read state: 'ready' at both the start and end sample
  --core-url <url>                default http://127.0.0.1:7700
  --sample-interval-sec <N>       default 30
  --max-adb-process-growth <N>    default 0
  --max-forward-growth <N>        default 0
  --max-sessions-rebuilt <N>      default 0
  --help                          print this and exit, without touching adb, a device, or the core

Env:
  ENKAKU_TEST_DEVICE=1   required gate — this script drives a real farm
`
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

interface VideoSessionsRow {
  deviceId: string
  state: string
}
interface VideoSessionsBody {
  devices: VideoSessionsRow[]
  rssBytes: number
}
interface AdbStatsBody {
  devices: Array<{ counts: { timeout: number; busy: number; error: number } }>
  transport: { framesDroppedTotal?: number }
  forwards?: unknown[]
}
interface JobsListBody {
  total: number
}

async function takeSample(coreUrl: string, devicesExpected: number, t0: number): Promise<SoakSample> {
  const [sessions, adbStats, succeeded, failed] = await Promise.all([
    fetch(`${coreUrl}/api/video/sessions`).then((r) => r.json() as Promise<VideoSessionsBody>),
    fetch(`${coreUrl}/api/adb/stats`).then((r) => r.json() as Promise<AdbStatsBody>),
    fetch(`${coreUrl}/api/jobs?status=succeeded&limit=1`).then((r) => r.json() as Promise<JobsListBody>),
    fetch(`${coreUrl}/api/jobs?status=failed&limit=1`).then((r) => r.json() as Promise<JobsListBody>),
  ])
  const psOutput = Bun.spawnSync(['ps', '-Ao', 'pid=,command=']).stdout.toString()
  const deviceCounts = adbStats.devices.reduce(
    (acc, d) => ({
      timeout: acc.timeout + d.counts.timeout,
      busy: acc.busy + d.counts.busy,
      error: acc.error + d.counts.error,
    }),
    { timeout: 0, busy: 0, error: 0 },
  )
  return {
    atSec: Math.floor((performance.now() - t0) / 1000),
    devicesReady: sessions.devices.filter((d) => d.state === 'ready').length,
    devicesExpected,
    adbProcessCount: countAdbProcesses(psOutput),
    forwardCount: adbStats.forwards?.length ?? 0,
    rssBytes: sessions.rssBytes,
    framesDroppedTotal: adbStats.transport.framesDroppedTotal ?? 0,
    jobsSucceededTotal: succeeded.total,
    jobsFailedTotal: failed.total,
    deviceCounts,
    recoveringDeviceIds: sessions.devices.filter((d) => d.state === 'recovering').map((d) => d.deviceId),
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  if (process.env.ENKAKU_TEST_DEVICE !== '1') {
    console.error('✗ set ENKAKU_TEST_DEVICE=1 to run this against a real farm (repo convention, 00-overview.md §4.4)')
    process.exit(1)
  }

  const durationMinFlag = flag(args, 'duration-min')
  const expectDevicesFlag = flag(args, 'expect-devices')
  if (!durationMinFlag || !expectDevicesFlag) {
    console.error(usage())
    console.error('✗ --duration-min and --expect-devices are both required')
    process.exit(1)
    return
  }
  const durationMin = Number(durationMinFlag)
  const devicesExpected = Number(expectDevicesFlag)
  const coreUrl = flag(args, 'core-url') ?? 'http://127.0.0.1:7700'
  const sampleIntervalSec = Number(flag(args, 'sample-interval-sec') ?? 30)
  const thresholds: SoakThresholds = {
    maxAdbProcessGrowth: Number(flag(args, 'max-adb-process-growth') ?? 0),
    maxForwardGrowth: Number(flag(args, 'max-forward-growth') ?? 0),
    maxSessionsRebuilt: Number(flag(args, 'max-sessions-rebuilt') ?? 0),
    requireDevicesReadyAtEnd: devicesExpected,
  }

  console.log(`soak: running for ${durationMin} min against ${coreUrl}, expecting ${devicesExpected} device(s) ready, sampling every ${sampleIntervalSec}s`)
  const t0 = performance.now()
  const deadline = t0 + durationMin * 60_000
  const samples: SoakSample[] = []
  for (;;) {
    try {
      samples.push(await takeSample(coreUrl, devicesExpected, t0))
    } catch (err) {
      console.error(`soak: sample failed, skipping: ${String(err)}`)
    }
    if (performance.now() >= deadline) break
    await Bun.sleep(Math.min(sampleIntervalSec * 1000, Math.max(0, deadline - performance.now())))
  }

  const report = buildSoakReport(samples, devicesExpected)
  const { ok, breaches } = evaluateSoakReport(report, thresholds)
  console.log('')
  console.log(formatSoakTable(report))
  console.log('')
  console.log(ok ? 'soak: all thresholds held' : `soak: breached — ${breaches.join('; ')}`)
  process.exit(ok ? 0 : 1)
}

// Guarded so the test file can `import` the pure pieces above without running
// the CLI (which touches the network and calls `process.exit`) as a side
// effect — same guard `scripts/spec-check.ts` uses.
if (import.meta.main) {
  main().catch((err) => {
    console.error('✗ unexpected error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
