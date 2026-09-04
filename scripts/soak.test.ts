import { describe, expect, test } from 'bun:test'
import { buildSoakReport, evaluateSoakReport, formatSoakTable, countAdbProcesses, type SoakSample, type SoakThresholds } from './soak'

/**
 * Plan 223 §5 step 223.8 — every test here constructs `SoakSample[]`/`ps`
 * text fixtures directly; none spawns a real `ps` or fetches a real core,
 * the same discipline `spec-check.test.ts` already established for this
 * directory.
 */

function sample(overrides: Partial<SoakSample> = {}): SoakSample {
  return {
    atSec: 0,
    devicesReady: 20,
    devicesExpected: 20,
    adbProcessCount: 5,
    forwardCount: 20,
    rssBytes: 100_000_000,
    framesDroppedTotal: 0,
    jobsSucceededTotal: 0,
    jobsFailedTotal: 0,
    deviceCounts: { timeout: 0, busy: 0, error: 0 },
    recoveringDeviceIds: [],
    ...overrides,
  }
}

describe('buildSoakReport', () => {
  test('sessionsRebuilt counts a rising edge once, not every sample a device stays recovering', () => {
    const samples = [
      sample({ atSec: 0, recoveringDeviceIds: [] }),
      sample({ atSec: 30, recoveringDeviceIds: ['dev-1'] }),
      sample({ atSec: 60, recoveringDeviceIds: ['dev-1'] }), // still recovering — no second count
      sample({ atSec: 90, recoveringDeviceIds: [] }), // recovered
      sample({ atSec: 120, recoveringDeviceIds: ['dev-1'] }), // recovering again — a second episode
    ]
    const report = buildSoakReport(samples, 20)
    expect(report.sessionsRebuilt).toBe(2)
  })

  test('devicesReadyStart/End read the first and last sample', () => {
    const samples = [sample({ devicesReady: 18 }), sample({ devicesReady: 19 }), sample({ devicesReady: 20 })]
    const report = buildSoakReport(samples, 20)
    expect(report.devicesReadyStart).toBe(18)
    expect(report.devicesReadyEnd).toBe(20)
  })

  test('jobsRun is the succeeded+failed total delta', () => {
    const samples = [
      sample({ jobsSucceededTotal: 10, jobsFailedTotal: 2 }),
      sample({ jobsSucceededTotal: 45, jobsFailedTotal: 5 }),
    ]
    const report = buildSoakReport(samples, 20)
    expect(report.jobsRun).toBe(45 + 5 - (10 + 2))
  })

  test('failuresByClass is the summed counts delta', () => {
    const samples = [
      sample({ deviceCounts: { timeout: 1, busy: 2, error: 0 } }),
      sample({ deviceCounts: { timeout: 4, busy: 2, error: 3 } }),
    ]
    const report = buildSoakReport(samples, 20)
    expect(report.failuresByClass).toEqual({ timeout: 3, busy: 0, error: 3 })
  })
})

describe('evaluateSoakReport', () => {
  const holdingThresholds: SoakThresholds = { maxAdbProcessGrowth: 0, maxForwardGrowth: 0, maxSessionsRebuilt: 0, requireDevicesReadyAtEnd: 20 }

  test('returns ok:true and no breaches when every threshold holds', () => {
    const samples = [sample({ adbProcessCount: 5, forwardCount: 20, devicesReady: 20 }), sample({ adbProcessCount: 5, forwardCount: 20, devicesReady: 20 })]
    const report = buildSoakReport(samples, 20)
    expect(evaluateSoakReport(report, holdingThresholds)).toEqual({ ok: true, breaches: [] })
  })

  test('returns a breach for adb process growth over the threshold', () => {
    const samples = [sample({ adbProcessCount: 5 }), sample({ adbProcessCount: 8 })]
    const report = buildSoakReport(samples, 20)
    const result = evaluateSoakReport(report, holdingThresholds)
    expect(result.ok).toBe(false)
    expect(result.breaches.some((b) => b.includes('adb process'))).toBe(true)
  })

  test('returns a breach for forward growth over the threshold', () => {
    const samples = [sample({ forwardCount: 20 }), sample({ forwardCount: 23 })]
    const report = buildSoakReport(samples, 20)
    const result = evaluateSoakReport(report, holdingThresholds)
    expect(result.ok).toBe(false)
    expect(result.breaches.some((b) => b.includes('forward'))).toBe(true)
  })

  test('returns a breach for sessionsRebuilt over the threshold', () => {
    const samples = [sample({ recoveringDeviceIds: [] }), sample({ recoveringDeviceIds: ['dev-1'] })]
    const report = buildSoakReport(samples, 20)
    const result = evaluateSoakReport(report, holdingThresholds)
    expect(result.ok).toBe(false)
    expect(result.breaches.some((b) => b.includes('rebuilt'))).toBe(true)
  })

  test('returns a breach when devicesReadyEnd is under the expected count', () => {
    const samples = [sample({ devicesReady: 20 }), sample({ devicesReady: 19 })]
    const report = buildSoakReport(samples, 20)
    const result = evaluateSoakReport(report, holdingThresholds)
    expect(result.ok).toBe(false)
    expect(result.breaches.some((b) => b.includes('ready'))).toBe(true)
  })
})

describe('formatSoakTable', () => {
  test('includes every required column', () => {
    const samples = [sample(), sample({ atSec: 3600 })]
    const report = buildSoakReport(samples, 20)
    const table = formatSoakTable(report)
    expect(table).toContain('duration')
    expect(table).toContain('devices')
    expect(table).toContain('sessions rebuilt')
    expect(table).toContain('adb processes')
    expect(table).toContain('forwards')
    expect(table).toContain('RSS')
    expect(table).toContain('decoder rebuilds')
    expect(table).toContain('frames dropped')
    expect(table).toContain('jobs run')
    expect(table).toContain('failures by class')
  })
})

describe('countAdbProcesses', () => {
  test('counts case-insensitive adb matches in a ps dump', () => {
    const psOutput = [
      '  100 /usr/bin/adb -s SERIAL1 shell',
      '  101 CLASSPATH=/tmp/scrcpy-server.jar app_process',
      '  102 /usr/bin/ADB start-server',
      '  103 some/other/process --unrelated-flag',
    ].join('\n')
    expect(countAdbProcesses(psOutput)).toBe(2)
  })

  test('returns 0 for an empty dump', () => {
    expect(countAdbProcesses('')).toBe(0)
  })
})
