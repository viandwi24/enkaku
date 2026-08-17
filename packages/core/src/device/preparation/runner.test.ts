import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { DevicePreparation } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../../db'
import { devices, type DeviceRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'
import { createLogger } from '../../util/logger'
import { createPreparationRunner, type PreparationRunnerDeps } from './runner'
import type { PreparationComponent, PreparationRunResult } from './types'

function makeDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, overrides: Partial<DeviceRow> = {}): void {
  db.insert(devices)
    .values({
      id: 'dev-1',
      stableId: 'stable-dev-1',
      serial: 'serial-dev-1',
      label: 'Test Phone',
      status: 'idle',
      apiLevel: 34,
      ...overrides,
    })
    .run()
}

function readPreparation(db: Db, id = 'dev-1'): DevicePreparation {
  const row = db.select().from(devices).where(eq(devices.id, id)).get()
  if (!row) throw new Error(`no such device: ${id}`)
  return (row.preparation as DevicePreparation | null) ?? {}
}

/** A scriptable component — one queued result per call, so a test can drive exactly the sequence it wants to observe (ready, then failed, then E_ADB_UNAVAILABLE, ...). */
function fakeComponent(
  id: string,
  opts: {
    applicable?: (row: DeviceRow) => boolean
    unsupportedReason?: string
    queue?: Array<PreparationRunResult | { throw: unknown }>
  } = {},
): { component: PreparationComponent; calls: DeviceRow[] } {
  const calls: DeviceRow[] = []
  const queue = [...(opts.queue ?? [])]
  const component: PreparationComponent = {
    id,
    label: id,
    applicable: opts.applicable ?? (() => true),
    unsupportedReason: () => opts.unsupportedReason ?? `${id} is not applicable`,
    async run(row) {
      calls.push(row)
      const next = queue.shift()
      if (!next) throw new Error(`fakeComponent(${id}): no queued result for call #${calls.length}`)
      if ('throw' in next) throw next.throw
      return next
    },
  }
  return { component, calls }
}

function makeRunner(db: Db, registry: PreparationComponent[], overrides: Partial<PreparationRunnerDeps> = {}) {
  let clock = 1_700_000_000_000
  const events: Array<{ deviceId: string; kind: string; meta?: Record<string, unknown> }> = []
  const runner = createPreparationRunner({
    db,
    registry,
    log: createLogger('test'),
    retryBackoffS: [5, 20, 60],
    now: () => clock,
    record: (e) => events.push({ deviceId: e.deviceId, kind: e.kind, meta: e.meta }),
    ...overrides,
  })
  return { runner, events, advance: (ms: number) => (clock += ms) }
}

describe('preparation runner — one component, applicable, ready (plan 106 §3.1)', () => {
  test('a successful pass persists ready with attempts reset and records one transition', async () => {
    const db = makeDb()
    seedDevice(db)
    const { component } = fakeComponent('ui-server', { queue: [{ state: 'ready', version: '2.3.3', reason: null }] })
    const { runner, events } = makeRunner(db, [component])

    const status = await runner.ensureComponent('dev-1', 'ui-server')
    expect(status.state).toBe('ready')
    expect(status.version).toBe('2.3.3')
    expect(status.attempts).toBe(0)
    expect(status.nextAttemptAt).toBeNull()
    expect(readPreparation(db)['ui-server']).toEqual(status)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ deviceId: 'dev-1', kind: 'device.preparation', meta: { componentId: 'ui-server', state: 'ready' } })
  })

  test('a second clean pass that changes nothing emits no second event', async () => {
    const db = makeDb()
    seedDevice(db)
    const { component } = fakeComponent('ui-server', {
      queue: [
        { state: 'ready', version: '2.3.3', reason: null },
        { state: 'ready', version: '2.3.3', reason: null },
      ],
    })
    const { runner, events } = makeRunner(db, [component])

    await runner.ensureComponent('dev-1', 'ui-server', { force: true })
    await runner.ensureComponent('dev-1', 'ui-server', { force: true })
    expect(events).toHaveLength(1)
  })
})

describe('preparation runner — unsupported vs failed (plan 106 §3.2)', () => {
  test('an inapplicable component resolves unsupported, never failed, and is never retried', async () => {
    const db = makeDb()
    seedDevice(db, { apiLevel: 21 })
    const { component, calls } = fakeComponent('future-thing', {
      applicable: (row) => (row.apiLevel ?? 0) >= 29,
      unsupportedReason: 'needs API 29+',
    })
    const { runner } = makeRunner(db, [component])

    const status = await runner.ensureComponent('dev-1', 'future-thing')
    expect(status.state).toBe('unsupported')
    expect(status.reason).toBe('needs API 29+')
    expect(status.attempts).toBe(0)
    expect(status.nextAttemptAt).toBeNull()
    expect(calls).toHaveLength(0) // run() is never even called — applicable() gates before any retry math
  })
})

describe('preparation runner — core-side vs device-side errors (plan 106 §3.3, §96.25)', () => {
  test('E_ADB_UNAVAILABLE defers: no write, no attempt consumed, no event', async () => {
    const db = makeDb()
    seedDevice(db)
    const { component } = fakeComponent('ui-server', {
      queue: [{ throw: new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet') }],
    })
    const { runner, events } = makeRunner(db, [component])

    const status = await runner.ensureComponent('dev-1', 'ui-server')
    expect(status.state).toBe('absent') // untouched prior (the default — never provisioned)
    expect(status.attempts).toBe(0)
    expect(readPreparation(db)['ui-server']).toBeUndefined() // nothing was ever written
    expect(events).toHaveLength(0)
  })

  test('a device-side failure DOES consume an attempt and schedules the next one', async () => {
    const db = makeDb()
    seedDevice(db)
    const { component } = fakeComponent('ui-server', { queue: [{ state: 'failed', version: null, reason: 'pm install exit 1' }] })
    const { runner } = makeRunner(db, [component])

    const status = await runner.ensureComponent('dev-1', 'ui-server')
    expect(status.state).toBe('failed')
    expect(status.attempts).toBe(1)
    expect(status.nextAttemptAt).not.toBeNull()
  })

  test('a bound that has been reached is clearable by an explicit (force) retry (plan 106 §3.3, §96.25)', async () => {
    const db = makeDb()
    seedDevice(db)
    const failure = (): PreparationRunResult => ({ state: 'failed', version: null, reason: 'bad artifact' })
    const { component, calls } = fakeComponent('ui-server', { queue: [failure(), failure(), failure()] })
    const { runner, advance } = makeRunner(db, [component])

    // Three automatic attempts, each past its own backoff window.
    await runner.ensureComponent('dev-1', 'ui-server')
    advance(100_000)
    await runner.ensureComponent('dev-1', 'ui-server')
    advance(100_000)
    let status = await runner.ensureComponent('dev-1', 'ui-server')
    expect(status.attempts).toBe(3)
    expect(status.nextAttemptAt).toBeNull() // the bound is reached
    expect(calls).toHaveLength(3)

    // A fourth AUTOMATIC call must not consume the component's `run()` at
    // all — it should short-circuit on the exhausted budget. The queue is
    // now empty, so a fourth real `run()` call would throw "no queued
    // result" — proof by construction that it was never invoked.
    status = await runner.ensureComponent('dev-1', 'ui-server')
    expect(status.attempts).toBe(3) // unchanged — no automatic attempt was spent
    expect(calls).toHaveLength(3) // run() was not called a fourth time

    // An explicit retry clears it.
    const { component: recovered } = fakeComponent('ui-server', { queue: [{ state: 'ready', version: '2.3.3', reason: null }] })
    const { runner: runner2 } = makeRunner(db, [recovered])
    status = await runner2.ensureComponent('dev-1', 'ui-server', { force: true })
    expect(status.state).toBe('ready')
    expect(status.attempts).toBe(0)
    expect(status.nextAttemptAt).toBeNull()
  })
})

describe('preparation runner — ensure() runs every registered component, keyed independently (plan 106 §3.1, §4)', () => {
  test('two components on the same device do not clobber each other in devices.preparation', async () => {
    const db = makeDb()
    seedDevice(db)
    const { component: a } = fakeComponent('component-a', { queue: [{ state: 'ready', version: 'a1', reason: null }] })
    const { component: b } = fakeComponent('component-b', { queue: [{ state: 'failed', version: null, reason: 'no artifact' }] })
    const { runner } = makeRunner(db, [a, b])

    const preparation = await runner.ensure('dev-1')
    expect(preparation['component-a']?.state).toBe('ready')
    expect(preparation['component-b']?.state).toBe('failed')
    expect(readPreparation(db)['component-a']?.state).toBe('ready')
    expect(readPreparation(db)['component-b']?.state).toBe('failed')
  })
})

describe('preparation runner — ensureAll (plan 106 §3.5)', () => {
  test('skips offline devices — unreachable by construction, nothing to verify', async () => {
    const db = makeDb()
    seedDevice(db, { id: 'dev-online', stableId: 's-online', serial: 'ser-online', status: 'idle' })
    seedDevice(db, { id: 'dev-offline', stableId: 's-offline', serial: 'ser-offline', status: 'offline' })
    const { component, calls } = fakeComponent('ui-server', {
      queue: [
        { state: 'ready', version: '1', reason: null },
        { state: 'ready', version: '1', reason: null },
      ],
    })
    const { runner } = makeRunner(db, [component])

    const report = await runner.ensureAll()
    expect(report.total).toBe(1)
    expect(calls.map((r) => r.id)).toEqual(['dev-online'])
  })
})

describe('preparation runner — status() never issues an adb call', () => {
  test('reads the persisted column only', async () => {
    const db = makeDb()
    seedDevice(db)
    const { component } = fakeComponent('ui-server', { queue: [{ state: 'ready', version: '1', reason: null }] })
    const { runner } = makeRunner(db, [component])
    await runner.ensureComponent('dev-1', 'ui-server')

    const preparation = await runner.status('dev-1')
    expect(preparation['ui-server']?.state).toBe('ready')
  })

  test('an unknown device throws device_not_found', async () => {
    const db = makeDb()
    const { runner } = makeRunner(db, [])
    await expect(runner.status('missing')).rejects.toThrow()
  })
})

describe('preparation runner — runningSince (plan 106 §5 step 106.7)', () => {
  test('reports a component in flight while its run() is pending, and clears once it settles', async () => {
    const db = makeDb()
    seedDevice(db)
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const component: PreparationComponent = {
      id: 'ui-server',
      label: 'ui-server',
      applicable: () => true,
      unsupportedReason: () => 'n/a',
      async run() {
        await gate
        return { state: 'ready', version: '1', reason: null }
      },
    }
    const { runner } = makeRunner(db, [component])

    expect(runner.runningSince('dev-1')).toEqual({})
    const pending = runner.ensureComponent('dev-1', 'ui-server')
    // Let the microtask queue turn so `ensureComponentImpl` reaches its
    // `runningSinceMap.set` before the gate is inspected.
    await Promise.resolve()
    await Promise.resolve()
    expect(runner.runningSince('dev-1')).toEqual({ 'ui-server': 1_700_000_000 })
    // Never leaks into another device's key space.
    expect(runner.runningSince('dev-2')).toEqual({})

    release!()
    const status = await pending
    expect(status.state).toBe('ready')
    expect(runner.runningSince('dev-1')).toEqual({})
  })

  test('clears on an E_ADB_UNAVAILABLE defer too — a deferred pass is not left looking in flight forever', async () => {
    const db = makeDb()
    seedDevice(db)
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const component: PreparationComponent = {
      id: 'ui-server',
      label: 'ui-server',
      applicable: () => true,
      unsupportedReason: () => 'n/a',
      async run() {
        await gate
        throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
      },
    }
    const { runner } = makeRunner(db, [component])

    const pending = runner.ensureComponent('dev-1', 'ui-server')
    await Promise.resolve()
    await Promise.resolve()
    expect(runner.runningSince('dev-1')).toEqual({ 'ui-server': 1_700_000_000 })

    release!()
    const status = await pending
    expect(status.state).toBe('absent') // deferred, untouched prior
    expect(runner.runningSince('dev-1')).toEqual({}) // never left stuck
  })
})
