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

  test('the whole run takes roughly the slowest item, not the sum, when one item is artificially slow', async () => {
    const items = [5, 5, 5, 5, 200]
    const start = Date.now()
    await mapWithConcurrency(items, 8, async (ms) => {
      await sleep(ms)
    })
    const elapsed = Date.now() - start
    // Sum would be ~220ms; bounded parallelism should land close to 200ms.
    expect(elapsed).toBeLessThan(220)
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
