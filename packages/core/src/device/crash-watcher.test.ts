import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { ArtifactInfo } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createLogger } from '../util/logger'
import { createMonitorHub } from './monitor-hub'
import { createCrashWatcher, type CrashPolicy, type CrashWatcherHub } from './crash-watcher'
import type { ShellPort } from './shell-port'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  jobLease: { jobId: string } | null
  policy: CrashPolicy
  targets: string[]
}

function setup(opts: { policy?: CrashPolicy; targets?: string[]; jobLease?: { jobId: string } | null; maxPerMinutePerDevice?: number } = {}): Harness {
  const hub = createFakeHub()
  const records: Harness['records'] = []
  const traces: Harness['traces'] = []
  const jobCrashes: Harness['jobCrashes'] = []
  const h: Harness = {
    hub,
    records,
    traces,
    jobCrashes,
    jobLease: opts.jobLease ?? null,
    policy: opts.policy ?? 'declared',
    targets: opts.targets ?? [],
    watcher: null as never,
  }
  h.watcher = createCrashWatcher({
    hub: hub.hub,
    record: (e) => records.push({ deviceId: e.deviceId, kind: e.kind, meta: e.meta }),
    saveTrace: async (opts2) => {
      traces.push(opts2)
      return { id: 'artifact-1', jobId: opts2.jobId, deviceId: opts2.jobId ? null : opts2.deviceId, kind: 'log', label: opts2.label, path: 'x', sizeBytes: opts2.text.length, createdAt: 0 } satisfies ArtifactInfo
    },
    getJobLease: () => h.jobLease,
    crashPolicy: () => h.policy,
    targetPackagesForJob: () => h.targets,
    log: createLogger('test'),
    idleMs: 30,
    ...(opts.maxPerMinutePerDevice !== undefined ? { maxPerMinutePerDevice: opts.maxPerMinutePerDevice } : {}),
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

describe('createCrashWatcher — a crash is an event first, a job failure second (plan 37 §3.3, acceptance #1, #7)', () => {
  test('with no job running, the event is recorded and the trace saved device-scoped — no job callback fires', async () => {
    const h = setup({ jobLease: null })
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

  test('with a job lease held, the trace is job-scoped and the job callback can fire', async () => {
    const h = setup({ jobLease: { jobId: 'job-1' }, policy: 'declared', targets: ['com.example.app'] })
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
    const h = setup({ jobLease: { jobId: 'job-1' }, policy: 'declared', targets: ['com.example.app'] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.app'), CLOSER])
    await sleep(10)
    expect(h.jobCrashes).toHaveLength(1)
  })

  test('declared: an unrelated background app never fails the job', async () => {
    const h = setup({ jobLease: { jobId: 'job-1' }, policy: 'declared', targets: ['com.example.app'] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.other'), CLOSER])
    await sleep(10)
    // Still recorded and traced — just never attributed as a job failure.
    expect(h.records).toHaveLength(1)
    expect(h.jobCrashes).toHaveLength(0)
  })

  test('any: the same unrelated crash DOES fail the job (unless it is a system package)', async () => {
    const h = setup({ jobLease: { jobId: 'job-1' }, policy: 'any', targets: ['com.example.app'] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.example.other'), CLOSER])
    await sleep(10)
    expect(h.jobCrashes).toHaveLength(1)
  })

  test('any: a system package crash is excluded even under "any"', async () => {
    const h = setup({ jobLease: { jobId: 'job-1' }, policy: 'any', targets: [] })
    await h.watcher.watch('dev-1')
    h.watcher.handleStreamData('dev-1:crash', [...crashLines('com.android.systemui'), CLOSER])
    await sleep(10)
    expect(h.records).toHaveLength(1) // still recorded
    expect(h.jobCrashes).toHaveLength(0) // never attributed
  })

  test('ignore: no job is ever failed, but the event is still recorded (acceptance #6)', async () => {
    const h = setup({ jobLease: { jobId: 'job-1' }, policy: 'ignore', targets: ['com.example.app'] })
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
      getJobLease: () => null,
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
