import { describe, expect, test } from 'bun:test'
import type { DeviceEvent } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { deviceEvents } from '../db/schema'
import { createEventRecorder } from './recorder'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/** Counts real `db.transaction()` calls so the batching claim is measured, not assumed. */
function countTransactions(db: Db): { count: () => number } {
  const original = db.transaction.bind(db)
  let calls = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.transaction = ((fn: any) => {
    calls++
    return original(fn)
  }) as typeof db.transaction
  return { count: () => calls }
}

describe('createEventRecorder', () => {
  test('500 record() calls flush in batches, not one transaction per row', async () => {
    const db = setUp()
    const spy = countTransactions(db)
    const published: DeviceEvent[] = []
    const recorder = createEventRecorder({
      db,
      publish: (_deviceId, ev) => published.push(ev),
      maxBufferedRows: 50,
      flushIntervalMs: 60_000, // never fires on its own during this test
    })

    for (let i = 0; i < 500; i++) {
      recorder.record({ deviceId: 'dev-1', stream: 'input', kind: 'input.tap', meta: { i } })
    }

    // Publish is synchronous and immediate — every caller sees its event
    // whether or not it has been written yet (plan 18 §3.5, §3.6).
    expect(published).toHaveLength(500)

    // 500 rows at a 50-row ceiling is exactly 10 full-buffer flushes; far
    // fewer than 500, which is the actual acceptance bar (plan 18 §18.3, #7).
    expect(spy.count()).toBe(10)
    expect(spy.count()).toBeLessThan(500)

    const rows = db.select().from(deviceEvents).all()
    expect(rows).toHaveLength(500)

    await recorder.stop()
  })

  test('stop() flushes whatever is still buffered — no loss', async () => {
    const db = setUp()
    const recorder = createEventRecorder({
      db,
      publish: () => {},
      maxBufferedRows: 1000,
      flushIntervalMs: 60_000,
    })

    for (let i = 0; i < 37; i++) {
      recorder.record({ deviceId: 'dev-1', stream: 'main', kind: 'device.online', meta: { i } })
    }

    // Nothing has been written yet — the buffer is well under its ceiling
    // and the timer has not fired.
    expect(db.select().from(deviceEvents).all()).toHaveLength(0)

    await recorder.stop()

    expect(db.select().from(deviceEvents).all()).toHaveLength(37)
  })

  test('a full buffer flushes immediately without waiting for the timer', () => {
    const db = setUp()
    const recorder = createEventRecorder({
      db,
      publish: () => {},
      maxBufferedRows: 5,
      flushIntervalMs: 60_000,
    })

    for (let i = 0; i < 5; i++) {
      recorder.record({ deviceId: 'dev-1', stream: 'input', kind: 'input.tap' })
    }

    // No await, no timer tick — the row ceiling alone triggered the flush.
    expect(db.select().from(deviceEvents).all()).toHaveLength(5)
  })

  /**
   * Acceptance criterion 7 (plan 18 §6, §7): "10 000 recorded input events do
   * not measurably slow input delivery." This is a timing check, not
   * something to assume — it measures the ws-handlers.ts input path with and
   * without the `recorder.record()` call inserted, simulating the real shape
   * of that code: a synchronous call followed by an awaited "device" call.
   */
  test('input-path timing: 10 000 taps, recorder.record() adds no measurable delay', async () => {
    const db = setUp()
    const recorder = createEventRecorder({ db, publish: () => {}, maxBufferedRows: 200, flushIntervalMs: 250 })
    const N = 10_000

    // Stands in for `await session.input.tap(...)` — a microtask, same as the
    // real await would cost if the device call itself were instant. Any
    // difference between the two loops below is therefore attributable to
    // `record()` alone, not to unrelated I/O noise.
    const simulatedDeviceCall = () => Promise.resolve()

    async function withoutRecording(): Promise<number> {
      const start = performance.now()
      for (let i = 0; i < N; i++) {
        await simulatedDeviceCall()
      }
      return performance.now() - start
    }

    async function withRecording(): Promise<number> {
      const start = performance.now()
      for (let i = 0; i < N; i++) {
        recorder.record({ deviceId: 'dev-1', stream: 'input', kind: 'input.tap', meta: { x: i, y: i, w: 1080, h: 2400 } })
        await simulatedDeviceCall()
      }
      return performance.now() - start
    }

    // Run each shape twice and take the second measurement, past JIT warm-up.
    await withoutRecording()
    await withRecording()
    const baselineMs = await withoutRecording()
    const recordedMs = await withRecording()
    await recorder.stop()

    const baselinePerCallUs = (baselineMs / N) * 1000
    const recordedPerCallUs = (recordedMs / N) * 1000
    const deltaPerCallUs = recordedPerCallUs - baselinePerCallUs

    // Printed, not just asserted — the report needs the actual numbers.
    console.log(
      `[timing] ${N} calls — baseline: ${baselineMs.toFixed(2)}ms (${baselinePerCallUs.toFixed(3)}µs/call), ` +
        `with recorder.record(): ${recordedMs.toFixed(2)}ms (${recordedPerCallUs.toFixed(3)}µs/call), ` +
        `delta: ${deltaPerCallUs.toFixed(3)}µs/call`,
    )

    // A real adb/scrcpy round trip is several MILLISECONDS. The added cost per
    // call must stay in the microseconds — two orders of magnitude below that
    // — for "no measurable slowdown" to mean anything.
    expect(deltaPerCallUs).toBeLessThan(200)
    expect(db.select().from(deviceEvents).all()).toHaveLength(N * 2) // both `withRecording()` runs landed
  })
})
