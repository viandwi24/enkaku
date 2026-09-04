import { describe, expect, test } from 'bun:test'
import type { UiServerClient } from './client'
import type { UiServerLauncher, UiServerStartHooks } from './launcher'
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

/**
 * Counts `start`/`stop` calls — `launcher.start()` is the one action a
 * restart cycle takes that this file can observe directly. `onStartHooks`
 * (plan 208 §4.4) lets a test invoke the hooks the REAL launcher would call
 * (`onFatal`/`onExit`) from inside a fake `start()`, driving the watchdog's
 * fail-fast path without a real instrumentation stream.
 */
function fakeLauncher(opts?: { onStartHooks?: (hooks?: UiServerStartHooks) => void }): {
  launcher: UiServerLauncher
  startCalls: () => number
  stopCalls: () => number
} {
  let starts = 0
  let stops = 0
  const launcher = {
    start: async (_localPort: number, hooks?: UiServerStartHooks) => {
      starts += 1
      opts?.onStartHooks?.(hooks)
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

  test('a device that degrades AFTER a healthy start: the idle PING TIMER (not reportFailure) detects it and drives the first restart cycle, and the breaker still trips', async () => {
    // Unlike the old test this replaces, the initial start here succeeds
    // (plan 129 §3.2: a failed START no longer spends a restart cycle at
    // all — see the dedicated describe block below). This test's job is to
    // prove the RUNTIME restart path is unaffected by that change: the idle
    // ping timer still notices degradation on its own and still spends a
    // breaker cycle when it does.
    const { launcher, startCalls } = fakeLauncher()
    let healthyPings = true
    const client = fakeClient(async () => healthyPings)
    const statuses: UiServerStatus[] = []
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      maxRestartsPerWindow: 2,
      restartWindowMs: 60_000,
      restartBackoffMs: [1, 1],
      startTimeoutMs: 5,
      idlePingMs: 5, // tight, so the timer fires fast without a real wait
      onStatus: (s) => statuses.push(s),
    })

    await watchdog.start()
    expect(startCalls()).toBe(1)
    expect(watchdog.isHealthy()).toBe(true)

    // The client goes down; nobody calls reportFailure() — only the idle
    // ping timer is watching, exactly like a device that quietly stops
    // answering between operator actions.
    healthyPings = false
    await waitUntil(() => startCalls() === 2) // the timer's own restart() call
    expect(watchdog.isDead()).toBe(false) // cycle 1 of 2 — exactly at budget
    const restarting = statuses.filter((s): s is Extract<UiServerStatus, { state: 'restarting' }> => s.state === 'restarting')
    expect(restarting.map((s) => s.attempt)).toEqual([1])

    // Once unhealthy the idle timer intentionally stops probing (the
    // `!healthy` guard) — exactly as before this change. Further
    // degradation is reported the way the real `call()` wrapper does it,
    // through `reportFailure()`. Let cycle 1 fully settle first (its own
    // failed `waitReady()` takes a poll interval to conclude), then spend
    // the session's last cycle.
    await waitUntil(() => startCalls() === 2)
    await Bun.sleep(300)
    watchdog.reportFailure('still down')
    await waitUntil(() => startCalls() === 3) // cycle 2 of 2 — exactly at budget
    await Bun.sleep(300)
    expect(watchdog.isDead()).toBe(false)

    // A 3rd cycle would exceed the budget of 2 — the breaker trips instead
    // of restarting again.
    watchdog.reportFailure('still down')
    await waitUntil(() => watchdog.isDead())
    expect(startCalls()).toBe(3) // no 3rd restart attempt
    expect(watchdog.isHealthy()).toBe(false)
  })
})

describe('createWatchdog — start() fails the start, and fails it once (plan 129 §3.2/§4.1, M94)', () => {
  test('a start whose ping never succeeds THROWS and leaves isDead() true, spending no restart cycle', async () => {
    const { launcher, startCalls } = fakeLauncher()
    const client = fakeClient(async () => false) // never becomes ready
    const statuses: UiServerStatus[] = []
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      maxRestartsPerWindow: 3,
      restartWindowMs: 60_000,
      startTimeoutMs: 5,
      idlePingMs: 100_000,
      onStatus: (s) => statuses.push(s),
    })

    await expect(watchdog.start()).rejects.toThrow('ui-server did not start: the server was not ready within the start timeout')

    // Exactly one launcher.start() call — the old code's swallowed restart
    // cycle inside start() (a second launcher.start + a second 15s wait)
    // must be gone entirely, per §3.2.
    expect(startCalls()).toBe(1)
    expect(watchdog.isDead()).toBe(true)
    expect(watchdog.isHealthy()).toBe(false)

    const dead = statuses.filter((s) => s.state === 'dead')
    expect(dead).toHaveLength(1)
    expect((dead[0] as Extract<UiServerStatus, { state: 'dead' }>).reason).toContain('start timeout')
    // No `restarting` status was ever emitted — the start path never enters
    // the restart cycle at all.
    expect(statuses.some((s) => s.state === 'restarting')).toBe(false)

    // A caller that (wrongly) ignores the rejection still observes death
    // through isDead(), and nothing resurrects it: further failure reports
    // are no-ops, and no further launcher.start() call is made.
    watchdog.reportFailure('still down')
    await Bun.sleep(30)
    expect(startCalls()).toBe(1)
    expect(watchdog.isDead()).toBe(true)
  })

  test('a start whose ping succeeds behaves exactly as before: healthy, no throw, ping timer runs', async () => {
    const { launcher, startCalls } = fakeLauncher()
    const client = fakeClient(async () => true)
    const statuses: UiServerStatus[] = []
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      startTimeoutMs: 200,
      idlePingMs: 100_000,
      onStatus: (s) => statuses.push(s),
    })

    await expect(watchdog.start()).resolves.toBeUndefined()
    try {
      expect(startCalls()).toBe(1)
      expect(watchdog.isHealthy()).toBe(true)
      expect(watchdog.isDead()).toBe(false)
      expect(statuses).toEqual([{ state: 'starting' }, { state: 'healthy' }])
    } finally {
      // A healthy start leaves the idle ping timer running (idlePingMs here
      // is 100s so it never actually fires during this test) — stop() so it
      // doesn't linger in the process for the rest of the suite.
      await watchdog.stop()
    }
  })
})

describe('createWatchdog — `dead` is terminal (plan 85 §3.5, fixes F17; plan 129 §3.2 updates how the FIRST death is reached)', () => {
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

    // (plan 129 §3.2) The failed start itself is now terminal — it throws
    // and sets `dead` directly, spending none of the restart-cycle budget.
    await expect(watchdog.start()).rejects.toThrow()
    expect(watchdog.isDead()).toBe(true)
    const callsAtBudget = startCalls()

    // Repeated failures, and the passage of several ping intervals, change nothing.
    watchdog.reportFailure('still down')
    watchdog.reportFailure('still down')
    await Bun.sleep(60)

    expect(watchdog.isDead()).toBe(true)
    expect(watchdog.isHealthy()).toBe(false)
    expect(startCalls()).toBe(callsAtBudget) // never a further restart attempt
    // The start path's own death does not go through `restart()`, so it
    // never logs "giving up" — that phrase is reserved for the breaker
    // tripping on the RUNTIME path (plan 85 §3.5), which never engages here.
    expect(logs.filter((l) => l.includes('giving up'))).toHaveLength(0)
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

    await expect(watchdog.start()).rejects.toThrow()
    expect(watchdog.isDead()).toBe(true)
    const callsAtDeath = startCalls()

    await watchdog.stop()

    expect(watchdog.isDead()).toBe(true)
    expect(watchdog.isHealthy()).toBe(false)
    expect(startCalls()).toBe(callsAtDeath)
  })
})

describe('createWatchdog — verdict-aware waitReady, onReady (plan 208 §3.3, §4.4)', () => {
  test('a fatal verdict 300 ms after start rejects in under 2 s with startTimeoutMs left at 15 s', async () => {
    const { launcher } = fakeLauncher({
      onStartHooks: (hooks) => {
        setTimeout(() => hooks?.onFatal?.('the stub class was not found: INSTRUMENTATION_STATUS: stack=...'), 300)
      },
    })
    const client = fakeClient(async () => false) // never pongs; only the fatal verdict should end this
    const statuses: UiServerStatus[] = []
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      // Left at the real 15s ceiling deliberately — the test proves the
      // fatal verdict ends the start well before it, not that the ceiling
      // itself was shrunk.
      idlePingMs: 100_000,
      onStatus: (s) => statuses.push(s),
    })

    const startedAt = Date.now()
    await expect(watchdog.start()).rejects.toThrow('the stub class was not found')
    expect(Date.now() - startedAt).toBeLessThan(2000)
    expect(watchdog.isDead()).toBe(true)
    const dead = statuses.filter((s) => s.state === 'dead')
    expect(dead).toHaveLength(1)
    expect((dead[0] as Extract<UiServerStatus, { state: 'dead' }>).reason).toContain('stub class was not found')
  })

  test('silence alone waits for startTimeoutMs and nothing less', async () => {
    const { launcher } = fakeLauncher() // never invokes onFatal — pure silence
    const client = fakeClient(async () => false)
    const watchdog = createWatchdog({ client, launcher, localPort: 1, startTimeoutMs: 50, idlePingMs: 100_000 })

    const startedAt = Date.now()
    await expect(watchdog.start()).rejects.toThrow('ui-server did not start: the server was not ready within the start timeout')
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(45) // close to the 50ms ceiling, never near-instant
  })

  test('onReady is awaited before healthy on start and on every restart', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient(async () => true)
    const readyCalls: number[] = []
    let counter = 0
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      maxRestartsPerWindow: 2,
      restartWindowMs: 60_000,
      restartBackoffMs: [1, 1],
      startTimeoutMs: 200,
      idlePingMs: 100_000,
      onReady: async () => {
        readyCalls.push(++counter)
      },
    })

    await watchdog.start()
    expect(readyCalls).toEqual([1])
    expect(watchdog.isHealthy()).toBe(true)

    watchdog.reportFailure('degraded')
    await waitUntil(() => readyCalls.length === 2)
    expect(readyCalls).toEqual([1, 2])
  })

  test('a rejecting onReady is logged, never fails the start', async () => {
    const { launcher } = fakeLauncher()
    const client = fakeClient(async () => true)
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      startTimeoutMs: 200,
      idlePingMs: 100_000,
      onReady: async () => {
        throw new Error('setConfigurator failed')
      },
    })

    await expect(watchdog.start()).resolves.toBeUndefined()
    expect(watchdog.isHealthy()).toBe(true)
    await watchdog.stop()
  })

  test('onExit from the launcher triggers a restart without waiting for two pings', async () => {
    let exitHook: ((reason: string) => void) | undefined
    const { launcher, startCalls } = fakeLauncher({
      onStartHooks: (hooks) => {
        exitHook = hooks?.onExit
      },
    })
    const client = fakeClient(async () => true)
    const watchdog = createWatchdog({
      client,
      launcher,
      localPort: 1,
      maxRestartsPerWindow: 2,
      restartWindowMs: 60_000,
      restartBackoffMs: [1, 1],
      startTimeoutMs: 200,
      idlePingMs: 100_000, // deliberately huge: only the exit hook should drive the restart
    })

    await watchdog.start()
    expect(startCalls()).toBe(1)

    exitHook?.('the instrumentation ended: closed')
    await waitUntil(() => startCalls() === 2)
    expect(watchdog.isDead()).toBe(false)
  })
})
