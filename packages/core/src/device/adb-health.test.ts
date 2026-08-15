import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import type { AdbServerHealth } from '@enkaku/protocol'
import { createLogger } from '../util/logger'
import { createAdbMetricsStore } from './adb-metrics'
import { createAdbServerHealth, type AdbServerHealthDeps, type AdbServerHealthMonitor, type AdbVersionProbeResult } from './adb-health'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Waits for `n` DISTINCT `lastCheckedAt` values to have been observed on
 * `monitor.current()` — i.e. `n` full ticks have completed and been
 * committed. Polling `probeVersion`'s own call count is deliberately NOT
 * used for this: that counter increments synchronously the instant `tick()`
 * calls it, well before the rest of that tick's `await`ed work (and the
 * `current` update it produces) has actually run.
 */
async function waitForTicks(monitor: AdbServerHealthMonitor, n: number, timeoutMs = 3_000): Promise<void> {
  const seen = new Set<number>()
  const start = Date.now()
  for (;;) {
    const t = monitor.current().lastCheckedAt
    if (t > 0) seen.add(t)
    if (seen.size >= n) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${n} tick(s) (saw ${seen.size})`)
    await sleep(3)
  }
}

function fakeClient(list: TrackedDevice[] = []): AdbClient {
  return { listDevices: async () => list } as unknown as AdbClient
}

/** A monitor wired with fast, controllable fakes — no real socket, no real adb server. */
function setUp(opts: {
  list?: TrackedDevice[]
  probeVersion?: () => Promise<AdbVersionProbeResult>
  nudgeCounts?: Map<string, number>
  offlineSerials?: Map<string, number>
  healthIntervalSec?: number
  stuckTimeoutRate?: number
  onTransition?: (h: AdbServerHealth) => void
}) {
  const metrics = createAdbMetricsStore()
  const deps: AdbServerHealthDeps = {
    client: () => fakeClient(opts.list ?? []),
    metrics,
    nudgeCounts: () => opts.nudgeCounts ?? new Map(),
    offlineSerials: () => opts.offlineSerials ?? new Map(),
    settings: () => ({ healthIntervalSec: opts.healthIntervalSec ?? 3600, stuckTimeoutRate: opts.stuckTimeoutRate ?? 0.5 }),
    onTransition: opts.onTransition,
    log: createLogger('test'),
    probeVersion: opts.probeVersion ?? (async () => ({ ok: true, rttMs: 3 })),
  }
  return createAdbServerHealth(deps)
}

describe('AdbServerHealth — current() before the first tick (plan 88 §3.9, §4.7)', () => {
  test('reports a neutral, never-checked snapshot', () => {
    const monitor = setUp({})
    expect(monitor.current()).toEqual({
      status: 'ok',
      versionRttMs: null,
      lastCheckedAt: 0,
      window: { seconds: 0, execs: 0, timeouts: 0, timeoutRate: 0 },
      wedged: [],
      stuckOffline: [],
      symptoms: [],
      restartAdvised: false,
    })
  })
})

describe('AdbServerHealth — a healthy farm (plan 88 §3.9)', () => {
  test('status ok, no symptoms, restart not advised, RTT recorded', async () => {
    const monitor = setUp({ list: [{ serial: 'SER1', state: 'device' }] })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    const h = monitor.current()
    expect(h.status).toBe('ok')
    expect(h.symptoms).toEqual([])
    expect(h.restartAdvised).toBe(false)
    expect(h.versionRttMs).toBe(3)
  })
})

describe('AdbServerHealth — server-unreachable (plan 88 §3.9 table)', () => {
  test('reports the symptom but never advises a restart — ensureServer() self-heals this (F22)', async () => {
    const monitor = setUp({ probeVersion: async () => ({ ok: false, reason: 'unreachable' }) })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    const h = monitor.current()
    expect(h.status).toBe('degraded')
    expect(h.symptoms.map((s) => s.symptom)).toEqual(['server-unreachable'])
    expect(h.restartAdvised).toBe(false)
    expect(h.versionRttMs).toBeNull()
  })
})

describe('AdbServerHealth — server-unresponsive (plan 88 §3.9 table: "twice in a row")', () => {
  test('one unresponsive probe alone is not yet the symptom', async () => {
    const monitor = setUp({ probeVersion: async () => ({ ok: false, reason: 'unresponsive' }), healthIntervalSec: 3600 })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    expect(monitor.current().status).not.toBe('stuck')
    expect(monitor.current().symptoms).toEqual([])
  })

  test('two unresponsive probes in a row report the symptom, status stuck, restart advised', async () => {
    const monitor = setUp({ probeVersion: async () => ({ ok: false, reason: 'unresponsive' }), healthIntervalSec: 0.02 })
    monitor.start()
    await waitForTicks(monitor, 2)
    monitor.stop()
    const h = monitor.current()
    expect(h.status).toBe('stuck')
    expect(h.restartAdvised).toBe(true)
    expect(h.symptoms.map((s) => s.symptom)).toContain('server-unresponsive')
  })

  test('a successful probe resets the streak — never two unresponsive IN A ROW', async () => {
    let calls = 0
    const monitor = setUp({
      probeVersion: async () => {
        calls++
        return calls === 2 ? { ok: true, rttMs: 1 } : { ok: false, reason: 'unresponsive' }
      },
      healthIntervalSec: 0.02,
    })
    monitor.start()
    await waitForTicks(monitor, 3)
    monitor.stop()
    expect(monitor.current().symptoms.map((s) => s.symptom)).not.toContain('server-unresponsive')
  })
})

describe('AdbServerHealth — transports-wedged (plan 88 §3.9 table: "≥2 serials")', () => {
  test('one device with 3+ consecutive timeouts is not yet the symptom — that is just a phone', async () => {
    const metrics = createAdbMetricsStore()
    for (let i = 0; i < 3; i++) metrics.record({ serial: 'SER1', profile: 'probe', ms: 5000, outcome: 'timeout', code: 'E_ADB_TIMEOUT' })
    const monitor = createAdbServerHealth({
      client: () => fakeClient([{ serial: 'SER1', state: 'device' }]),
      metrics,
      nudgeCounts: () => new Map(),
      offlineSerials: () => new Map(),
      settings: () => ({ healthIntervalSec: 3600, stuckTimeoutRate: 0.5 }),
      log: createLogger('test'),
      probeVersion: async () => ({ ok: true, rttMs: 1 }),
    })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    const h = monitor.current()
    expect(h.wedged).toEqual([{ serial: 'SER1', consecutiveTimeouts: 3, adbState: 'device' }])
    expect(h.symptoms.map((s) => s.symptom)).not.toContain('transports-wedged')
    expect(h.status).not.toBe('stuck')
  })

  test('two or more wedged devices IS the symptom — status stuck, restart advised', async () => {
    const metrics = createAdbMetricsStore()
    for (const serial of ['SER1', 'SER2']) {
      for (let i = 0; i < 3; i++) metrics.record({ serial, profile: 'probe', ms: 5000, outcome: 'timeout', code: 'E_ADB_TIMEOUT' })
    }
    const monitor = createAdbServerHealth({
      client: () =>
        fakeClient([
          { serial: 'SER1', state: 'device' },
          { serial: 'SER2', state: 'device' },
        ]),
      metrics,
      nudgeCounts: () => new Map(),
      offlineSerials: () => new Map(),
      settings: () => ({ healthIntervalSec: 3600, stuckTimeoutRate: 0.5 }),
      log: createLogger('test'),
      probeVersion: async () => ({ ok: true, rttMs: 1 }),
    })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    const h = monitor.current()
    expect(h.wedged.map((w) => w.serial).sort()).toEqual(['SER1', 'SER2'])
    expect(h.symptoms.map((s) => s.symptom)).toContain('transports-wedged')
    expect(h.status).toBe('stuck')
    expect(h.restartAdvised).toBe(true)
  })

  test('a device not currently in adb state "device" is never counted as wedged, however bad its history', async () => {
    const metrics = createAdbMetricsStore()
    for (let i = 0; i < 5; i++) metrics.record({ serial: 'SER1', profile: 'probe', ms: 5000, outcome: 'timeout', code: 'E_ADB_TIMEOUT' })
    const monitor = createAdbServerHealth({
      client: () => fakeClient([{ serial: 'SER1', state: 'offline' }]),
      metrics,
      nudgeCounts: () => new Map(),
      offlineSerials: () => new Map(),
      settings: () => ({ healthIntervalSec: 3600, stuckTimeoutRate: 0.5 }),
      log: createLogger('test'),
      probeVersion: async () => ({ ok: true, rttMs: 1 }),
    })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    expect(monitor.current().wedged).toEqual([])
  })
})

describe('AdbServerHealth — reconnect-ineffective (plan 88 §3.9 table: "≥3 nudges, still offline")', () => {
  test('fewer than 3 nudges is not yet the symptom', async () => {
    const offline = new Map([['SER1', Date.now() - 5_000]])
    const nudges = new Map([['SER1', 2]])
    const monitor = setUp({ offlineSerials: offline, nudgeCounts: nudges })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    const h = monitor.current()
    expect(h.stuckOffline).toEqual([{ serial: 'SER1', state: 'offline', sinceSec: 5, nudges: 2 }])
    expect(h.symptoms.map((s) => s.symptom)).not.toContain('reconnect-ineffective')
  })

  test('3 or more nudges while still offline IS the symptom, but restart is only "maybe" (not advised)', async () => {
    const offline = new Map([['SER1', Date.now() - 60_000]])
    const nudges = new Map([['SER1', 3]])
    const monitor = setUp({ offlineSerials: offline, nudgeCounts: nudges })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    const h = monitor.current()
    expect(h.status).toBe('degraded')
    expect(h.symptoms.map((s) => s.symptom)).toContain('reconnect-ineffective')
    expect(h.restartAdvised).toBe(false)
  })
})

describe('AdbServerHealth — timeout-storm (plan 88 §3.9 table: "rate ≥ stuckTimeoutRate over ≥20 execs")', () => {
  test('a high rate below the minimum exec count is not yet the symptom', async () => {
    const metrics = createAdbMetricsStore()
    for (let i = 0; i < 4; i++) metrics.record({ serial: 'SER1', profile: 'probe', ms: 5000, outcome: 'timeout', code: 'E_ADB_TIMEOUT' })
    const monitor = createAdbServerHealth({
      client: () => fakeClient(),
      metrics,
      nudgeCounts: () => new Map(),
      offlineSerials: () => new Map(),
      settings: () => ({ healthIntervalSec: 3600, stuckTimeoutRate: 0.5 }),
      log: createLogger('test'),
      probeVersion: async () => ({ ok: true, rttMs: 1 }),
    })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    expect(monitor.current().symptoms.map((s) => s.symptom)).not.toContain('timeout-storm')
  })

  test('a rate at or above the configured threshold over enough execs IS the symptom — restart not advised outright ("sometimes" helps)', async () => {
    const metrics = createAdbMetricsStore()
    for (let i = 0; i < 15; i++) metrics.record({ serial: 'SER1', profile: 'probe', ms: 5, outcome: 'ok' })
    for (let i = 0; i < 15; i++) metrics.record({ serial: 'SER1', profile: 'probe', ms: 5000, outcome: 'timeout', code: 'E_ADB_TIMEOUT' })
    const monitor = createAdbServerHealth({
      client: () => fakeClient(),
      metrics,
      nudgeCounts: () => new Map(),
      offlineSerials: () => new Map(),
      settings: () => ({ healthIntervalSec: 3600, stuckTimeoutRate: 0.5 }),
      log: createLogger('test'),
      probeVersion: async () => ({ ok: true, rttMs: 1 }),
    })
    monitor.start()
    await waitForTicks(monitor, 1)
    monitor.stop()
    const h = monitor.current()
    expect(h.symptoms.map((s) => s.symptom)).toContain('timeout-storm')
    expect(h.status).toBe('degraded')
    expect(h.restartAdvised).toBe(false)
  })
})

describe('AdbServerHealth — onTransition fires on status change ONLY (plan 88 §4.7 — "transition-only")', () => {
  test('a steady stream of healthy ticks never fires the callback', async () => {
    const transitions: AdbServerHealth[] = []
    const monitor = setUp({ healthIntervalSec: 0.02, onTransition: (h) => transitions.push(h) })
    monitor.start()
    await waitForTicks(monitor, 4)
    monitor.stop()
    expect(transitions).toEqual([])
  })

  test('flipping from ok to stuck and back fires exactly twice, naming the new status each time', async () => {
    const transitions: AdbServerHealth[] = []
    let calls = 0
    const monitor = setUp({
      healthIntervalSec: 0.02,
      onTransition: (h) => transitions.push(h),
      probeVersion: async () => {
        calls++
        // tick1: ok. tick2, tick3: unresponsive twice in a row (→ stuck). tick4: ok again (→ ok).
        if (calls === 1) return { ok: true, rttMs: 1 }
        if (calls <= 3) return { ok: false, reason: 'unresponsive' }
        return { ok: true, rttMs: 1 }
      },
    })
    monitor.start()
    await waitForTicks(monitor, 4)
    monitor.stop()
    expect(transitions.map((t) => t.status)).toEqual(['stuck', 'ok'])
  })
})

describe('AdbServerHealth — read-only by contract (plan 88 §3.9)', () => {
  test('the fake AdbClient this whole file drives has no kill/restart method for the monitor to have called', () => {
    expect('killServer' in fakeClient()).toBe(false)
    expect('restart' in fakeClient()).toBe(false)
  })
})
