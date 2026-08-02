export type Settled<R> = { status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }

/**
 * Runs `fn` over `items` with at most `limit` in flight at once (plan 23
 * §4.5 — bounded parallelism for the battery poll, so one slow device does
 * not delay the thermal check on every other device behind it).
 *
 * Order of the returned array always matches `items`, regardless of which
 * item finishes first. One item throwing never aborts the run or the
 * scheduling of the rest — it settles as `{ status: 'rejected' }`, exactly
 * like `Promise.allSettled`, just concurrency-bounded.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  const results: Settled<R>[] = new Array(items.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        // Safe: `i` is only ever handed out while `i < items.length`.
        const value = await fn(items[i]!, i)
        results[i] = { status: 'fulfilled', value }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
