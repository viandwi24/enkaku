import { describe, expect, test } from 'bun:test'
import { mapWithConcurrency } from './concurrency'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapWithConcurrency (plan 23 §4.5)', () => {
  test('respects the limit: never more than `limit` tasks in flight at once', async () => {
    let active = 0
    let maxActive = 0
    const items = Array.from({ length: 10 }, (_, i) => i)

    await mapWithConcurrency(items, 3, async (i) => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(10)
      active--
      return i * 2
    })

    expect(maxActive).toBeLessThanOrEqual(3)
  })

  test('preserves result order regardless of completion order', async () => {
    const items = [30, 10, 20, 5]
    const results = await mapWithConcurrency(items, 4, async (ms) => {
      await sleep(ms)
      return ms
    })
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20, 5])
  })

  test('isolates rejections: one item throwing does not abort the run or the others', async () => {
    const items = [1, 2, 3, 4, 5]
    const results = await mapWithConcurrency(items, 2, async (i) => {
      if (i === 3) throw new Error(`boom ${i}`)
      return i
    })
    expect(results).toHaveLength(5)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(results[1]).toEqual({ status: 'fulfilled', value: 2 })
    expect(results[2]?.status).toBe('rejected')
    expect((results[2] as { status: 'rejected'; reason: unknown }).reason).toBeInstanceOf(Error)
    expect(results[3]).toEqual({ status: 'fulfilled', value: 4 })
    expect(results[4]).toEqual({ status: 'fulfilled', value: 5 })
  })

  /*
    The property is PARALLELISM, and it used to be measured with a stopwatch
    that had no room in it: items `[5,5,5,5,200]` make the serial total 220ms
    and the parallel total 200ms, so `elapsed < 220` allowed twenty
    milliseconds of scheduling for the whole run. Windows' default timer
    resolution alone is about 15.6ms, and a loaded CI runner spends more than
    that just waking a timer — `check-windows` failed here (owner,
    2026-09-07).

    So the concurrency is counted directly, which is the thing under test and
    needs no clock at all. The wall clock stays only as a coarse sanity
    check, with a gap wide enough that it can only fail if the work really did
    run one item at a time.
  */
  test('runs items concurrently up to the limit, rather than one at a time', async () => {
    const items = [80, 80, 80, 80]
    let inFlight = 0
    let peak = 0
    const start = Date.now()
    await mapWithConcurrency(items, 4, async (ms) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(ms)
      inFlight--
    })
    const elapsed = Date.now() - start
    expect(peak).toBe(4)
    // Serial would be 320ms. Anything under 240 had to overlap, and leaves
    // 160ms of slack over the 80ms the parallel run actually needs.
    expect(elapsed).toBeLessThan(240)
  })

  test('an empty items array resolves to an empty array without spawning any workers', async () => {
    let called = false
    const results = await mapWithConcurrency([], 4, async () => {
      called = true
      return 1
    })
    expect(results).toEqual([])
    expect(called).toBe(false)
  })

  test('limit larger than the item count does not error and still runs everything', async () => {
    const items = [1, 2, 3]
    const results = await mapWithConcurrency(items, 100, async (i) => i)
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([1, 2, 3])
  })
})
