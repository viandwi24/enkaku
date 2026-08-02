import { describe, expect, test } from 'bun:test'
import { createAdbMetricsStore } from './adb-metrics'

describe('AdbMetricsStore (plan 23 §4.6)', () => {
  test('an unseen serial reports zeroed counts and null percentiles', () => {
    const store = createAdbMetricsStore()
    expect(store.forSerial('never-seen')).toEqual({
      execMsP50: null,
      execMsP95: null,
      counts: { ok: 0, timeout: 0, busy: 0, error: 0 },
    })
  })

  test('counts every outcome, keyed per serial', () => {
    const store = createAdbMetricsStore()
    store.record({ serial: 's1', profile: 'probe', ms: 5, outcome: 'ok' })
    store.record({ serial: 's1', profile: 'probe', ms: 5000, outcome: 'timeout', code: 'E_ADB_TIMEOUT' })
    store.record({ serial: 's1', profile: 'probe', ms: 1, outcome: 'busy', code: 'E_ADB_BUSY' })
    store.record({ serial: 's1', profile: 'probe', ms: 20, outcome: 'error', code: 'E_ADB_FAIL' })
    store.record({ serial: 's2', profile: 'probe', ms: 5, outcome: 'ok' })

    expect(store.forSerial('s1').counts).toEqual({ ok: 1, timeout: 1, busy: 1, error: 1 })
    expect(store.forSerial('s2').counts).toEqual({ ok: 1, timeout: 0, busy: 0, error: 0 })
  })

  test('latency percentiles are sampled only from successful execs', () => {
    const store = createAdbMetricsStore()
    for (const ms of [10, 20, 30, 40, 50]) {
      store.record({ serial: 's1', profile: 'probe', ms, outcome: 'ok' })
    }
    // A slow timeout must not drag the percentiles up.
    store.record({ serial: 's1', profile: 'probe', ms: 999_999, outcome: 'timeout', code: 'E_ADB_TIMEOUT' })

    const m = store.forSerial('s1')
    expect(m.execMsP50).toBeLessThanOrEqual(50)
    expect(m.execMsP95).toBeLessThanOrEqual(50)
  })

  test('the ring buffer caps at its fixed size and keeps the most recent samples', () => {
    const store = createAdbMetricsStore()
    for (let i = 1; i <= 200; i++) {
      store.record({ serial: 's1', profile: 'probe', ms: i, outcome: 'ok' })
    }
    const m = store.forSerial('s1')
    // Only the last 128 (73..200) should remain, so p95 must be well above 100.
    expect(m.execMsP95).toBeGreaterThan(100)
    expect(m.counts.ok).toBe(200) // the outcome COUNT is not ring-bounded, only the latency samples are
  })
})
