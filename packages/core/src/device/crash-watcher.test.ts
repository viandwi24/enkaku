import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { ArtifactInfo } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createLogger, type Logger } from '../util/logger'
import { createMonitorHub } from './monitor-hub'
import { createCrashWatcher, type CrashPolicy, type CrashWatcherHub } from './crash-watcher'
import type { ShellPort } from './shell-port'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Captures `warn` calls instead of printing them — lets a test assert "exactly one warn per restart" (plan 85 §5 step 85.4) precisely. */
function createFakeLogger(): { log: Logger; warns: string[] } {
  const warns: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warns.push(msg)
    },
    error: () => {},
    child: () => log,
  }
  return { log, warns }
}

/** A minimal, deterministic crash for `pkg` — enough for the parser to emit one CrashEvent. */
function crashLines(pkg: string): string[] {
  return [
    '08-03 12:00:00.000   100   100 E AndroidRuntime: FATAL EXCEPTION: main',
    `08-03 12:00:00.000   100   100 E AndroidRuntime: Process: ${pkg}, PID: 100`,
    '08-03 12:00:00.000   100   100 E AndroidRuntime: java.lang.NullPointerException: boom',
  ]
}
/** A different tag closes the open block immediately (plan 37 §4.2). */
const CLOSER = '08-03 12:00:00.100   200   200 I ActivityManager: unrelated, closes the block'

function createFakeHub(): {
  hub: CrashWatcherHub
  subscribeCalls: Array<{ clientId: string; deviceId: string; kind: string }>
  unsubscribeCalls: Array<{ clientId: string; streamId: string }>
} {
  const subscribeCalls: Array<{ clientId: string; deviceId: string; kind: string }> = []
  const unsubscribeCalls: Array<{ clientId: string; streamId: string }> = []
  const hub: CrashWatcherHub = {
    async subscribe(clientId, deviceId, kind) {
      subscribeCalls.push({ clientId, deviceId, kind })
      return { streamId: `${deviceId}:${kind}`, backlog: [] }
    },
    unsubscribe(clientId, streamId) {
      unsubscribeCalls.push({ clientId, streamId })
    },
  }
  return { hub, subscribeCalls, unsubscribeCalls }
}

interface Harness {
  watcher: ReturnType<typeof createCrashWatcher>
  hub: ReturnType<typeof createFakeHub>
  records: Array<{ deviceId: string; kind: string; meta?: Record<string, unknown> }>
  traces: Array<{ deviceId: string; jobId: string | null; label: string; text: string }>
  jobCrashes: Array<{ deviceId: string; jobId: string; e: { package: string; exception: string } }>
  runningJob: { jobId: string } | null
  policy: CrashPolicy
  targets: string[]
  /** `warn` calls captured in order — the whole point of the restart tests below (plan 85 §5 step 85.4). */
  warns: string[]
  /** Mutable so a test can flip `monitor.crashWatch` mid-run and observe the effect on the next read (plan 85 §3.2). */
  crashWatchMode: 'always' | 'off'
}

function setup(
  opts: {
    policy?: CrashPolicy
    targets?: string[]
    runningJob?: { jobId: string } | null
    maxPerMinutePerDevice?: number
    /** Production is 2 s → 60 s; tests use milliseconds so the suite stays fast. */
    restartBackoffMs?: { initialMs: number; maxMs: number }
  } = {},
): Harness {
  const hub = createFakeHub()
  const records: Harness['records'] = []
  const traces: Harness['traces'] = []
  const jobCrashes: Harness['jobCrashes'] = []
  const { log, warns } = createFakeLogger()
  const h: Harness = {
    hub,
    records,
    traces,
    jobCrashes,
    warns,
    runningJob: opts.runningJob ?? null,
    policy: opts.policy ?? 'declared',
    targets: opts.targets ?? [],
    crashWatchMode: 'always',
    watcher: null as never,
  }
  h.watcher = createCrashWatcher({
    hub: hub.hub,
    record: (e) => records.push({ deviceId: e.deviceId, kind: e.kind, meta: e.meta }),
    saveTrace: async (opts2) => {
      traces.push(opts2)
      return { id: 'artifact-1', jobId: opts2.jobId, deviceId: opts2.jobId ? null : opts2.deviceId, kind: 'log', label: opts2.label, path: 'x', sizeBytes: opts2.text.length, createdAt: 0 } satisfies ArtifactInfo
    },
    runningJobOf: () => h.runningJob,
    crashPolicy: () => h.policy,
    targetPackagesForJob: () => h.targets,
    log,
    idleMs: 30,
    crashWatch: () => h.crashWatchMode,
    ...(opts.maxPerMinutePerDevice !== undefined ? { maxPerMinutePerDevice: opts.maxPerMinutePerDevice } : {}),
    ...(opts.restartBackoffMs ? { restartBackoffMs: opts.restartBackoffMs } : {}),
  })
  h.watcher.onJobCrash((deviceId, jobId, e) => jobCrashes.push({ deviceId, jobId, e: { package: e.package, exception: e.exception } }))
  return h
}

describe('createCrashWatcher — subscribes as an internal client (plan 37 §4.3)', () => {
  test('watch() subscribes through the hub with clientId internal:crash and kind "crash"', async () => {
    const h = setup()
    await h.watcher.watch('dev-1')
    expect(h.hub.subscribeCalls).toEqual([{ clientId: 'internal:crash', deviceId: 'dev-1', kind: 'crash' }])
  })

  test('watch() is idempotent — a second call for the same device does not subscribe again', async () => {
    const h = setup()
    await h.watcher.watch('dev-1')
    await h.watcher.watch('dev-1')
    expect(h.hub.subscribeCalls).toHaveLength(1)
  })

  test('unwatch() unsubscribes and stops routing further lines', async () => {
    const h = setup()
    await h.watcher.watch('dev-1')
    h.watcher.unwatch('dev-1')
    expect(h.hub.unsubscribeCalls).toEqual([{ clientId: 'internal:crash', streamId: 'dev-1:crash' }])
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.app'), CLOSER])
    await sleep(10)
    expect(h.records).toHaveLength(0)
  })
})

describe('createCrashWatcher — an unexpected end resubscribes instead of dying silently (plan 85 §3.2, §5 step 85.4, fixes F6)', () => {
  test('an unexpected end does NOT resubscribe immediately — it waits out the backoff first', async () => {
    const h = setup({ restartBackoffMs: { initialMs: 30, maxMs: 200 } })
    await h.watcher.watch('dev-1')
    expect(h.hub.subscribeCalls).toHaveLength(1)

    h.watcher.handleStreamEnded('dev-1:crash', 'bytes')
    // Still just the one subscribe — the backoff has not elapsed yet. This is
    // the "not silence, but not instant either" middle ground the plan asks
    // for: an immediate resubscribe storm would be its own failure mode.
    expect(h.hub.subscribeCalls).toHaveLength(1)
    await sleep(10)
    expect(h.hub.subscribeCalls).toHaveLength(1)
  })

  test('after the backoff elapses, it resubscribes to the SAME device and kind, and logs exactly one warn naming the reason', async () => {
    const h = setup({ restartBackoffMs: { initialMs: 15, maxMs: 200 } })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamEnded('dev-1:crash', 'bytes')

    await sleep(60) // well past the 15ms backoff
    expect(h.hub.subscribeCalls).toEqual([
      { clientId: 'internal:crash', deviceId: 'dev-1', kind: 'crash' },
      { clientId: 'internal:crash', deviceId: 'dev-1', kind: 'crash' },
    ])
    expect(h.warns).toHaveLength(1)
    expect(h.warns[0]).toContain('dev-1')
    expect(h.warns[0]).toContain('bytes')
  })

  test('the resubscribed stream is live again — data on the new streamId is routed normally', async () => {
    const h = setup({ restartBackoffMs: { initialMs: 10, maxMs: 200 } })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamEnded('dev-1:crash', 'closed')
    await sleep(40)

    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.app'), CLOSER])
    await sleep(10)
    expect(h.records).toHaveLength(1)
  })

  test('a resubscribe attempt that itself fails keeps growing the backoff and logs one warn per attempt', async () => {
    // The fake hub's own `subscribe` fails on the 2nd and 3rd call (the
    // watcher's first two resubscribe attempts) and succeeds on the 4th.
    let calls = 0
    const subscribeAt: number[] = []
    const hub: CrashWatcherHub = {
      async subscribe(_clientId, deviceId, kind) {
        calls += 1
        subscribeAt.push(Date.now())
        if (calls === 2 || calls === 3) throw new Error(`boom-${calls}`)
        return { streamId: `${deviceId}:${kind}:${calls}`, backlog: [] }
      },
      unsubscribe() {},
    }
    const { log, warns } = createFakeLogger()
    const watcher = createCrashWatcher({
      hub,
      record: () => {},
      saveTrace: async (o) => ({ id: 'a', jobId: o.jobId, deviceId: o.deviceId, kind: 'log', label: o.label, path: 'x', sizeBytes: 0, createdAt: 0 }),
      runningJobOf: () => null,
      crashPolicy: () => 'declared',
      targetPackagesForJob: () => [],
      log,
      restartBackoffMs: { initialMs: 10, maxMs: 40 },
    })

    await watcher.watch('dev-1')
    expect(calls).toBe(1)
    watcher.handleStreamEnded('dev-1:crash:1', 'error')

    await sleep(150) // 10ms + 20ms + 40ms of backoff, comfortably covered
    expect(calls).toBe(4) // 1 initial + 2 failed resubscribes + 1 that finally succeeded
    expect(warns).toHaveLength(3) // one per restart: the original end, plus each failed resubscribe
    expect(warns[0]).toContain('error')
    expect(warns[1]).toContain('boom-2')
    expect(warns[2]).toContain('boom-3')

    // The delay grew each time rather than resetting to the floor.
    const gaps = [subscribeAt[1]! - subscribeAt[0]!, subscribeAt[2]! - subscribeAt[1]!, subscribeAt[3]! - subscribeAt[2]!]
    expect(gaps[0]).toBeGreaterThanOrEqual(8) // ~10ms
    expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0]! - 2) // ~20ms, grew
    expect(gaps[2]).toBeGreaterThanOrEqual(gaps[1]! - 2) // ~40ms (capped), grew again
  })

  test('unwatch() during the backoff wait stops the restart cleanly — no leaked timer, no resubscribe', async () => {
    const h = setup({ restartBackoffMs: { initialMs: 15, maxMs: 200 } })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamEnded('dev-1:crash', 'idle')
    h.watcher.unwatch('dev-1') // session closed before the backoff elapsed

    await sleep(60) // well past where the resubscribe would have fired
    expect(h.hub.subscribeCalls).toHaveLength(1) // never resubscribed
    expect(h.warns).toHaveLength(1) // the one warn for the original end — nothing after unwatch

    // A fresh watch() afterwards starts genuinely clean, not tangled up with
    // the now-cancelled backoff.
    await h.watcher.watch('dev-1')
    expect(h.hub.subscribeCalls).toHaveLength(2)
  })

  test('a deliberate stop (unwatch, then the stream\'s own async onEnd arrives) is not treated as unexpected — no restart', async () => {
    const h = setup({ restartBackoffMs: { initialMs: 10, maxMs: 50 } })
    await h.watcher.watch('dev-1')
    h.watcher.unwatch('dev-1') // the common path: session closed
    // The underlying stream's onEnd('stopped') arrives asynchronously after
    // the fact, exactly as it does through the real MonitorHub.
    h.watcher.handleStreamEnded('dev-1:crash', 'stopped')

    await sleep(40)
    expect(h.hub.subscribeCalls).toHaveLength(1) // no restart — this was a deliberate close
    expect(h.warns).toHaveLength(0)
  })

  test('monitor.crashWatch: "off" — watch() never subscribes, so there is nothing to restart', async () => {
    const h = setup({ restartBackoffMs: { initialMs: 10, maxMs: 50 } })
    h.crashWatchMode = 'off'
    await h.watcher.watch('dev-1')
    expect(h.hub.subscribeCalls).toHaveLength(0)
  })

  test('monitor.crashWatch flipping to "off" mid-backoff cancels the pending resubscribe', async () => {
    const h = setup({ restartBackoffMs: { initialMs: 15, maxMs: 200 } })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamEnded('dev-1:crash', 'bytes')
    h.crashWatchMode = 'off' // the farm setting flips before the backoff elapses

    await sleep(60)
    expect(h.hub.subscribeCalls).toHaveLength(1) // the scheduled resubscribe backed off
  })
})

describe('createCrashWatcher — a crash is an event first, a job failure second (plan 37 §3.3, acceptance #1, #7)', () => {
  test('with no job running, the event is recorded and the trace saved device-scoped — no job callback fires', async () => {
    const h = setup({ runningJob: null })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.app'), CLOSER])
    await sleep(10)

    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({ deviceId: 'dev-1', kind: 'app.crashed', meta: { package: 'com.example.app', exception: 'java.lang.NullPointerException' } })
    expect(h.traces).toHaveLength(1)
    expect(h.traces[0]?.jobId).toBeNull()
    expect(h.traces[0]?.deviceId).toBe('dev-1')
    expect(h.jobCrashes).toHaveLength(0)
  })

  test('with a job running, the trace is job-scoped and the job callback can fire', async () => {
    const h = setup({ runningJob: { jobId: 'job-1' }, policy: 'declared', targets: ['com.example.app'] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.app'), CLOSER])
    await sleep(10)

    expect(h.traces[0]?.jobId).toBe('job-1')
    expect(h.jobCrashes).toEqual([{ deviceId: 'dev-1', jobId: 'job-1', e: { package: 'com.example.app', exception: 'java.lang.NullPointerException' } }])
    // The event carries the jobId so Studio's job detail page can show the
    // crash as the failure cause without a second query (plan 37 §4.5).
    expect(h.records[0]?.meta?.jobId).toBe('job-1')
  })

  test('the recorded event points at the trace artifact (plan 37 §2, §4.5)', async () => {
    const h = setup()
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.app'), CLOSER])
    await sleep(10)
    expect(h.records[0]?.meta?.artifactId).toBe('artifact-1')
  })
})

describe('createCrashWatcher — crash policy (plan 37 §3.4, acceptance #4, #5, #6)', () => {
  test('declared: the script\'s own target package fails the job', async () => {
    const h = setup({ runningJob: { jobId: 'job-1' }, policy: 'declared', targets: ['com.example.app'] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.app'), CLOSER])
    await sleep(10)
    expect(h.jobCrashes).toHaveLength(1)
  })

  test('declared: an unrelated background app never fails the job', async () => {
    const h = setup({ runningJob: { jobId: 'job-1' }, policy: 'declared', targets: ['com.example.app'] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.other'), CLOSER])
    await sleep(10)
    // Still recorded and traced — just never attributed as a job failure.
    expect(h.records).toHaveLength(1)
    expect(h.jobCrashes).toHaveLength(0)
  })

  test('any: the same unrelated crash DOES fail the job (unless it is a system package)', async () => {
    const h = setup({ runningJob: { jobId: 'job-1' }, policy: 'any', targets: ['com.example.app'] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.other'), CLOSER])
    await sleep(10)
    expect(h.jobCrashes).toHaveLength(1)
  })

  test('any: a system package crash is excluded even under "any"', async () => {
    const h = setup({ runningJob: { jobId: 'job-1' }, policy: 'any', targets: [] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.android.systemui'), CLOSER])
    await sleep(10)
    expect(h.records).toHaveLength(1) // still recorded
    expect(h.jobCrashes).toHaveLength(0) // never attributed
  })

  test('ignore: no job is ever failed, but the event is still recorded (acceptance #6)', async () => {
    const h = setup({ runningJob: { jobId: 'job-1' }, policy: 'ignore', targets: ['com.example.app'] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.app'), CLOSER])
    await sleep(10)
    expect(h.records).toHaveLength(1)
    expect(h.traces).toHaveLength(1)
    expect(h.jobCrashes).toHaveLength(0)
  })
})

describe('createCrashWatcher — a per-device rate cap (plan 37 §8 risks)', () => {
  test('crashes beyond the per-minute cap are dropped (not recorded)', async () => {
    const h = setup({ maxPerMinutePerDevice: 2 })
    await h.watcher.watch('dev-1')
    for (let i = 0; i < 5; i++) {
      h.watcher.handleStreamData('dev-1:crash', [...crashLines(`com.example.app${i}`), CLOSER])
    }
    await sleep(20)
    expect(h.records).toHaveLength(2)
  })
})

describe('createCrashWatcher — shares one adb stream with a human Monitor viewer (plan 37 §4.3, acceptance #8)', () => {
  function seedDevice(db: Db, id: string, serial: string): void {
    db.insert(devices).values({ id, stableId: `stable-${id}`, serial, label: `Phone ${id}`, status: 'idle' }).run()
  }

  test('the watcher subscribing and a human viewer subscribing to the SAME kind resolve to one hub entry — one logcat process', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    seedDevice(db, 'dev-1', 'SER1')

    const streamStarts: Array<{ serial: string; cmd: string }> = []
    const shellPort = (deviceId: string): ShellPort => {
      const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
      if (!row) throw new Error('no such device')
      return {
        async exec() {
          throw new Error('not used by this test')
        },
        async stream(cmd, opts) {
          streamStarts.push({ serial: row.serial, cmd })
          return { streamId: `${row.serial}-stream`, stop: async () => opts.onEnd('stopped') }
        },
      }
    }

    const hub = createMonitorHub({
      shellPort,
      log: createLogger('test'),
      onData: () => {},
      onEnded: () => {},
      onSubscribersChanged: () => {},
    })

    const watcher = createCrashWatcher({
      hub,
      record: () => {},
      saveTrace: async (o) => ({ id: 'a', jobId: o.jobId, deviceId: o.deviceId, kind: 'log', label: o.label, path: 'x', sizeBytes: 0, createdAt: 0 }),
      runningJobOf: () => null,
      crashPolicy: () => 'declared',
      targetPackagesForJob: () => [],
      log: createLogger('test'),
    })

    // The always-on watcher subscribes first (as a session would start it)...
    await watcher.watch('dev-1')
    // ...then a human opens the Monitor tab on the SAME kind. Real Studio
    // wiring resolves `kind: 'crash'` to the identical fixed command
    // (`monitors.ts`), so this is exactly the (deviceId, kind, options)
    // match `MonitorHub` fans out on (plan 24 §3.5) — nothing crash-specific
    // is required for the sharing to happen.
    const human = await hub.subscribe('human-client', 'dev-1', 'crash', {})

    expect(streamStarts).toHaveLength(1) // ONE logcat process for both watchers
    expect(streamStarts[0]?.cmd).toBe('logcat -b crash,main -v threadtime -T 1')

    // The last one out stops it — the watcher and the human are independent subscribers.
    hub.unsubscribe('human-client', human.streamId)
    watcher.unwatch('dev-1')
  })
})
