import { describe, expect, test } from 'bun:test'
import type { UiServerClient } from './client'
import type { UiServerLauncher } from './launcher'
import { createWatchdog, DEFAULT_RESTART_BACKOFF_MS, restartCycleBackoffMs, type UiServerStatus } from './watchdog'

/**
 * The watchdog reaches `dead` through real `setInterval`/`Bun.sleep` timing,
 * so these tests drive it through `reportFailure()` (exactly what
 * `index.ts`'s `call()` wrapper does on a live `UI_SERVER_UNREACHABLE`)
 * rather than the periodic ping loop, and shrink `restartBackoffMs` to
 * single milliseconds so a full circuit-breaker trip still runs in well
 * under a second instead of the real 1s/3s/10s/30s ladder.
 */
async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await Bun.sleep(2)
  }
  throw new Error('condition was not met in time')
}

function fakeClient(ping: () => Promise<boolean>): UiServerClient {
  return { ping } as unknown as UiServerClient
}

/** Counts `start`/`stop` calls — `launcher.start()` is the one action a restart cycle takes that this file can observe directly. */
function fakeLauncher(): { launcher: UiServerLauncher; startCalls: () => number; stopCalls: () => number } {
  let starts = 0
  let stops = 0
  const launcher = {
    start: async () => {
      starts += 1
    },
    stop: async () => {
      stops += 1
    },
  } as unknown as UiServerLauncher
  return { launcher, startCalls: () => starts, stopCalls: () => stops }
}

describe('restartCycleBackoffMs — the inter-cycle backoff grows (plan 85 §3.5, fixes F17)', () => {
  test('matches the documented 1s, 3s, 10s, 30s ladder, and repeats the last entry past it', () => {
    expect([1, 2, 3, 4, 5, 6].map((cycle) => restartCycleBackoffMs(cycle))).toEqual([1000, 3000, 10_000, 30_000, 30_000, 30_000])
  })

  test('a cycle of 0 or negative behaves like cycle 1 (never a negative index)', () => {
    expect(restartCycleBackoffMs(0)).toBe(1000)
    expect(restartCycleBackoffMs(-5)).toBe(1000)
  })

  test('honours a custom table — this is how the tests below shrink real delays to run fast', () => {
    expect(restartCycleBackoffMs(1, [5, 50])).toBe(5)
    expect(restartCycleBackoffMs(2, [5, 50])).toBe(50)
    expect(restartCycleBackoffMs(3, [5, 50])).toBe(50) // past the table's length: repeats the last entry
  })

  test('DEFAULT_RESTART_BACKOFF_MS is exactly the documented values', () => {
    expect(DEFAULT_RESTART_BACKOFF_MS).toEqual([1000, 3000, 10_000, 30_000])
  })
})

describe('createWatchdog — the circuit breaker fires (plan 85 §3.5, fixes F17)', () => {
  test('a device that keeps degrading trips `dead` after maxRestartsPerWindow cycles — even though every cycle itself recovers first', async () => {
    // This is the exact F17 regression: the OLD watchdog reset its failure
    // counter on every restart that itself succeeded, so a device that
    // degrades, restarts, and degrades again churned forever. Here every
    // cycle below ends `healthy` (`client.ping` always resolves true), and
    // the breaker still fires — because it counts CYCLES, not consecutive
    // failures.
    const { launcher, startCalls } = fakeLauncher()
    const client = fakeClient(async () => true)
    const logs: string[] = []
    const statuses: UiServerStatus[] = []
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 12345,
      maxRestartsPerWindow: 3,
      restartWindowMs: 60_000,
      restartBackoffMs: [1, 1, 1, 1],
      startTimeoutMs: 200,
      idlePingMs: 100_000, // the periodic ping loop is not this test's concern — reportFailure() drives every cycle
      onLog: (level, msg) => logs.push(`${level}: ${msg}`),
      onStatus: (s) => statuses.push(s),
    })

    await watchdog.start()
    expect(startCalls()).toBe(1)
    expect(watchdog.isHealthy()).toBe(true)

    watchdog.reportFailure('degraded again (1)')
    await waitUntil(() => startCalls() === 2)
    expect(watchdog.isDead()).toBe(false)
    expect(watchdog.isHealthy()).toBe(true) // this cycle recovered, same as the field log's `restart attempt 1/2`

    watchdog.reportFailure('degraded again (2)')
    await waitUntil(() => startCalls() === 3)
    expect(watchdog.isDead()).toBe(false)

    watchdog.reportFailure('degraded again (3)')
    await waitUntil(() => startCalls() === 4)
    expect(watchdog.isDead()).toBe(false)

    // The 4th failure would be a 4th cycle — over the budget of 3 — so the
    // breaker fires INSTEAD of restarting again.
    watchdog.reportFailure('degraded again (4)')
    await waitUntil(() => watchdog.isDead())
    expect(startCalls()).toBe(4) // no 4th restart attempt
    expect(watchdog.isHealthy()).toBe(false)

    // Cycle numbers reported via `attempt` count up across the session, 1..3.
    const restarting = statuses.filter((s): s is Extract<UiServerStatus, { state: 'restarting' }> => s.state === 'restarting')
    expect(restarting.map((s) => s.attempt)).toEqual([1, 2, 3])

    // Exactly one explanatory warn, naming how many cycles were spent.
    const gaveUp = logs.filter((l) => l.includes('giving up'))
    expect(gaveUp).toHaveLength(1)
    expect(gaveUp[0]).toContain('3 restart cycle')
    expect(gaveUp[0]).toContain('uiautomator-dump')

    const deadStatuses = statuses.filter((s) => s.state === 'dead')
    expect(deadStatuses).toHaveLength(1)
  })

  test('a device that never comes back also trips the breaker, and the INITIAL start failure counts as its first cycle', async () => {
    const { launcher, startCalls } = fakeLauncher()
    const client = fakeClient(async () => false) // never recovers
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      maxRestartsPerWindow: 2,
      restartWindowMs: 60_000,
      restartBackoffMs: [1, 1],
      startTimeoutMs: 5,
      idlePingMs: 100_000,
    })

    // The initial `start()` itself spends cycle 1 (launcher.start once for
    // the initial attempt, once more for the resulting restart cycle) — and
    // is fully awaited, so by the time it resolves the cycle has genuinely
    // settled (unlike the fire-and-forget `reportFailure()` below).
    await watchdog.start()
    expect(startCalls()).toBe(2)
    expect(watchdog.isDead()).toBe(false) // exactly at budget (1 cycle used of 2), not yet exceeded
    expect(watchdog.isHealthy()).toBe(false)

    // Spends cycle 2 — still not dead, exactly at budget. `reportFailure` is
    // fire-and-forget, and `waitReady`'s own poll granularity (a fixed
    // 250ms sleep between ping attempts) means `startCalls()` alone is not
    // enough proof this cycle has fully settled — the settling wait must
    // outlast that poll, or the NEXT `reportFailure()` below can land while
    // this one is still `restarting` and get silently dropped, never
    // reaching the breaker.
    watchdog.reportFailure('still down')
    await waitUntil(() => startCalls() === 3)
    await Bun.sleep(300)
    expect(watchdog.isDead()).toBe(false)

    // A 3rd cycle would exceed the budget of 2.
    watchdog.reportFailure('still down')
    await waitUntil(() => watchdog.isDead())
    expect(startCalls()).toBe(3)
  })
})

describe('createWatchdog — `dead` is terminal (plan 85 §3.5, fixes F17)', () => {
  test('nothing resurrects it within the same session: no further restart attempts, from any entry point', async () => {
    const { launcher, startCalls } = fakeLauncher()
    const client = fakeClient(async () => false) // never recovers
    const logs: string[] = []
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      maxRestartsPerWindow: 1,
      restartWindowMs: 60_000,
      restartBackoffMs: [1],
      startTimeoutMs: 5,
      idlePingMs: 5, // deliberately tight: if the timer were still alive after death it would tick almost immediately
      onLog: (level, msg) => logs.push(`${level}: ${msg}`),
    })

    await watchdog.start() // spends the session's one allowed cycle — exactly at budget, not yet dead
    expect(watchdog.isDead()).toBe(false)
    const callsAtBudget = startCalls()

    watchdog.reportFailure('still down') // a 2nd cycle would exceed the budget of 1 -> dead
    await waitUntil(() => watchdog.isDead())
    expect(startCalls()).toBe(callsAtBudget)

    // Repeated failures, and the passage of several ping intervals, change nothing.
    watchdog.reportFailure('still down')
    watchdog.reportFailure('still down')
    await Bun.sleep(60)

    expect(watchdog.isDead()).toBe(true)
    expect(watchdog.isHealthy()).toBe(false)
    expect(startCalls()).toBe(callsAtBudget) // never a further restart attempt
    expect(logs.filter((l) => l.includes('giving up'))).toHaveLength(1) // exactly once, not once per extra reportFailure() call
  })

  test('stop() after death is a harmless no-op, not a resurrection', async () => {
    const { launcher, startCalls } = fakeLauncher()
    const client = fakeClient(async () => false)
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      maxRestartsPerWindow: 1,
      restartWindowMs: 60_000,
      restartBackoffMs: [1],
      startTimeoutMs: 5,
      idlePingMs: 100_000,
    })

    await watchdog.start()
    watchdog.reportFailure('still down')
    await waitUntil(() => watchdog.isDead())
    const callsAtDeath = startCalls()

    await watchdog.stop()

    expect(watchdog.isDead()).toBe(true)
    expect(watchdog.isHealthy()).toBe(false)
    expect(startCalls()).toBe(callsAtDeath)
  })
})
