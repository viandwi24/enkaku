import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, blockedDevices, clusters, deletedDevices, deviceEvents, deviceTags, devices, discoveredDevices, jobs } from '../db/schema'
import { createJobStore } from '../queue/job-store'
import { createKvStore } from '../kv/store'
import { createLeaseManager, type LeaseManager } from '../lease/lease-manager'
import { EnkakuError } from '../util/errors'
import { createLogger } from '../util/logger'
import { createDeviceStateMachine } from './state-machine'
import { checkRemovable, createDeviceLifecycle, type DeviceLifecycle } from './lifecycle'

interface Recorded {
  deviceId: string
  kind: string
  meta?: unknown
}

function setUp(): { db: Db; lifecycle: DeviceLifecycle; leases: LeaseManager; events: Recorded[] } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const leases = createLeaseManager({
    states,
    jobStore,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
    log,
    onJobLeaseExpired: () => {},
  })
  const events: Recorded[] = []
  const lifecycle = createDeviceLifecycle({
    db,
    leases,
    record: (e) => events.push({ deviceId: e.deviceId, kind: e.kind, meta: e.meta }),
    log,
  })
  return { db, lifecycle, leases, events }
}

function seedDevice(db: Db, id: string, status: string, clusterId: string | null = null): void {
  db.insert(devices)
    .values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: `Phone ${id}`, status, clusterId })
    .run()
}

describe('checkRemovable — the §3.5 safety matrix', () => {
  test('device busy (a job is running): refused for forget AND block', () => {
    const { db, leases } = setUp()
    seedDevice(db, 'd1', 'busy')
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    expect(checkRemovable('forget', row, leases)).toEqual({
      ok: false,
      code: 'device_busy',
      message: expect.stringContaining('running a job'),
    })
    expect(checkRemovable('block', row, leases).ok).toBe(false)
  })

  test('an active manual lease: refused for forget AND block', () => {
    const { db, leases } = setUp()
    seedDevice(db, 'd1', 'idle')
    leases.acquireManual('d1', 'client-1')
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    expect(row.status).toBe('manual')
    expect(checkRemovable('forget', row, leases)).toEqual({
      ok: false,
      code: 'device_in_use',
      message: expect.stringContaining('manual lease'),
    })
    expect(checkRemovable('block', row, leases).ok).toBe(false)
  })

  test('device online, idle: BOTH forget and block are allowed (plan 56 §3.2)', () => {
    // This used to refuse forget and offer block instead, because the registry
    // would have re-enrolled the device immediately. Plan 56 removed that
    // premise — an unadmitted phone falls into the Discovered tray — so an
    // operator who wants a device out of the farm no longer has to declare it
    // permanently unwelcome to get there.
    const { db, leases } = setUp()
    seedDevice(db, 'd1', 'idle')
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    expect(checkRemovable('forget', row, leases)).toEqual({ ok: true })
    expect(checkRemovable('block', row, leases)).toEqual({ ok: true })
  })

  test('device offline: both allowed', () => {
    const { db, leases } = setUp()
    seedDevice(db, 'd1', 'offline')
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    expect(checkRemovable('forget', row, leases)).toEqual({ ok: true })
    expect(checkRemovable('block', row, leases)).toEqual({ ok: true })
  })

  test('device quarantined: both allowed', () => {
    const { db, leases } = setUp()
    seedDevice(db, 'd1', 'quarantined')
    const row = db.select().from(devices).where(eq(devices.id, 'd1')).get()!
    expect(checkRemovable('forget', row, leases)).toEqual({ ok: true })
    expect(checkRemovable('block', row, leases)).toEqual({ ok: true })
  })
})

describe('forget (plan 47 §4.3, §4.4)', () => {
  test('an offline device is forgotten: the row, its tags, and its cluster membership are gone; history is kept', async () => {
    const { db, lifecycle, events } = setUp()
    db.insert(clusters).values({ id: 'c1', name: 'Jakarta', description: null, createdAt: new Date() }).run()
    seedDevice(db, 'd1', 'offline', 'c1')
    db.insert(deviceTags).values({ deviceId: 'd1', tag: 'smoke', at: new Date() }).run()
    db.insert(jobs).values({ id: 'j1', scriptId: 'internal:sleep', deviceId: 'd1', status: 'success', createdAt: new Date() }).run()
    db.insert(deviceEvents).values({ id: 'e1', deviceId: 'd1', stream: 'main', kind: 'device.online', at: new Date() }).run()

    const result = await lifecycle.forget('d1', { deleteHistory: false, actor: { userId: 'u1' } })
    // `kvDeleted: 0` — this `setUp()` wires no `kv` dependency (plan 79 §3.3, §4.6); a host with
    // one wired is covered by the dedicated kv-deletion test below.
    expect(result).toEqual({ deviceId: 'd1', stableId: 'stable-d1', historyDeleted: false, counts: null, kvDeleted: 0 })

    expect(db.select().from(devices).where(eq(devices.id, 'd1')).get()).toBeUndefined()
    expect(db.select().from(deviceTags).where(eq(deviceTags.deviceId, 'd1')).all()).toEqual([])

    // History kept, exactly (plan 47 §3.4, acceptance #5).
    expect(db.select().from(jobs).where(eq(jobs.deviceId, 'd1')).all()).toHaveLength(1)
    expect(db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, 'd1')).all()).toHaveLength(1)

    // The dangling-reference label exists from the same transaction.
    const deleted = db.select().from(deletedDevices).where(eq(deletedDevices.id, 'd1')).get()
    expect(deleted?.stableId).toBe('stable-d1')
    expect(deleted?.label).toBe('Phone d1')

    expect(events).toContainEqual(
      expect.objectContaining({ deviceId: 'd1', kind: 'device.forgotten', meta: expect.objectContaining({ deleteHistory: false }) }),
    )
  })

  test('forgetting an online device returns it to the tray instead of demanding a block (plan 56 §3.2)', async () => {
    const { db, lifecycle } = setUp()
    seedDevice(db, 'd1', 'idle')

    await lifecycle.forget('d1', { deleteHistory: false, actor: { userId: null } })

    // Out of the farm...
    expect(db.select().from(devices).where(eq(devices.id, 'd1')).get()).toBeUndefined()
    // ...and waiting to be admitted again, immediately — not invisible until
    // someone unplugs and replugs the phone.
    const pending = db.select().from(discoveredDevices).all()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.stableId).toBe('stable-d1')
    // And emphatically NOT blocked: forget and block stay different sentences.
    expect(db.select().from(blockedDevices).all()).toHaveLength(0)
  })

  test('forgetting an OFFLINE device does not put it in the tray — nothing is connected to discover', async () => {
    const { db, lifecycle } = setUp()
    seedDevice(db, 'd1', 'offline')

    await lifecycle.forget('d1', { deleteHistory: false, actor: { userId: null } })

    expect(db.select().from(devices).all()).toHaveLength(0)
    expect(db.select().from(discoveredDevices).all()).toHaveLength(0)
  })

  test('removing a device takes its network route down first, while the row still exists', async () => {
    // Ordering is the whole fix: everything that knows how to reach the phone
    // is keyed on the device row. Deleting it first is what stranded a tunnel
    // on a phone with no record of who put it there.
    const calls: Array<{ deviceId: string; rowStillThere: boolean }> = []
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const leases = createLeaseManager({
      states,
      jobStore: createJobStore(db),
      config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const lifecycle = createDeviceLifecycle({
      db,
      leases,
      log,
      revertNetwork: async (deviceId) => {
        calls.push({ deviceId, rowStillThere: db.select().from(devices).where(eq(devices.id, deviceId)).get() !== undefined })
      },
    })
    seedDevice(db, 'd1', 'idle')

    await lifecycle.forget('d1', { deleteHistory: false, actor: { userId: 'u1' } })

    expect(calls).toEqual([{ deviceId: 'd1', rowStillThere: true }])
  })

  test('block takes the route down too — a blocked phone never comes back to be cleaned up later', async () => {
    const calls: string[] = []
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const leases = createLeaseManager({
      states,
      jobStore: createJobStore(db),
      config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const lifecycle = createDeviceLifecycle({ db, leases, log, revertNetwork: async (id) => void calls.push(id) })
    seedDevice(db, 'd1', 'idle')

    await lifecycle.block('d1', { actor: { userId: 'u1' } })

    expect(calls).toEqual(['d1'])
  })

  test('a teardown that fails still removes the device, and says so — blocked-and-noisy beats leaking quietly', async () => {
    // Refusing here would rebuild the trap this work removed: an operator
    // unable to get a device out of the farm. And the failure is safe on its
    // own — a route that could not be torn down stays held closed by the
    // device's own dead-man's switch (verified on hardware), so the phone
    // blocks traffic rather than leaking it.
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const leases = createLeaseManager({
      states,
      jobStore: createJobStore(db),
      config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const events: Recorded[] = []
    const lifecycle = createDeviceLifecycle({
      db,
      leases,
      log,
      record: (e) => events.push({ deviceId: e.deviceId, kind: e.kind, meta: e.meta }),
      revertNetwork: async () => {
        throw new Error('device unreachable')
      },
    })
    seedDevice(db, 'd1', 'idle')

    await lifecycle.forget('d1', { deleteHistory: false, actor: { userId: 'u1' } })

    expect(db.select().from(devices).where(eq(devices.id, 'd1')).get()).toBeUndefined()
    // Not silent: the stranded route is answerable later instead of invisible.
    expect(events).toContainEqual(expect.objectContaining({ deviceId: 'd1', kind: 'network.orphaned' }))
  })

  test('forgetting a busy device is refused', async () => {
    const { db, lifecycle } = setUp()
    seedDevice(db, 'd1', 'busy')
    await expect(lifecycle.forget('d1', { deleteHistory: false, actor: { userId: null } })).rejects.toMatchObject({
      code: 'device_busy',
    })
    expect(db.select().from(devices).where(eq(devices.id, 'd1')).get()).toBeTruthy()
  })

  test('forgetting a device with an active manual lease is refused', async () => {
    const { db, lifecycle, leases } = setUp()
    seedDevice(db, 'd1', 'idle')
    leases.acquireManual('d1', 'client-1')
    await expect(lifecycle.forget('d1', { deleteHistory: false, actor: { userId: null } })).rejects.toMatchObject({
      code: 'device_in_use',
    })
  })

  test('an unknown device id is refused with device_not_found', async () => {
    const { lifecycle } = setUp()
    await expect(lifecycle.forget('ghost', { deleteHistory: false, actor: { userId: null } })).rejects.toBeInstanceOf(EnkakuError)
  })

  test('historyCounts matches exactly what "delete history" removes — including a job\'s own artifacts', async () => {
    const { db, lifecycle } = setUp()
    seedDevice(db, 'd1', 'offline')
    db.insert(jobs)
      .values([
        { id: 'j1', scriptId: 'internal:sleep', deviceId: 'd1', status: 'success', createdAt: new Date() },
        { id: 'j2', scriptId: 'internal:sleep', deviceId: 'd1', status: 'failed', createdAt: new Date() },
      ])
      .run()
    // A job-scoped artifact (deviceId null, jobId set) ...
    db.insert(artifacts).values({ id: 'a1', jobId: 'j1', deviceId: null, kind: 'screenshot', label: 'shot', path: 'x', createdAt: new Date() }).run()
    // ...and a device-scoped one (the Monitor tab's "save last N lines", plan 24 §4.6).
    db.insert(artifacts).values({ id: 'a2', jobId: null, deviceId: 'd1', kind: 'log', label: 'monitor', path: 'y', createdAt: new Date() }).run()
    for (let i = 0; i < 3; i++) {
      db.insert(deviceEvents).values({ id: `e${i}`, deviceId: 'd1', stream: 'main', kind: 'device.online', at: new Date() }).run()
    }

    const counts = await lifecycle.historyCounts('d1')
    expect(counts).toEqual({ jobs: 2, artifacts: 2, events: 3 })

    const result = await lifecycle.forget('d1', { deleteHistory: true, actor: { userId: 'u1' } })
    expect(result.historyDeleted).toBe(true)
    expect(result.counts).toEqual(counts)

    expect(db.select().from(jobs).where(eq(jobs.deviceId, 'd1')).all()).toEqual([])
    expect(db.select().from(artifacts).where(eq(artifacts.jobId, 'j1')).all()).toEqual([])
    expect(db.select().from(artifacts).where(eq(artifacts.deviceId, 'd1')).all()).toEqual([])
    expect(db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, 'd1')).all()).toEqual([])
  })

  // Criterion 9 (plan 79): forgetting a device deletes its kv values, and the summary counts them
  // — UNCONDITIONALLY, even when `deleteHistory` is false, because a kv value is live state
  // (often a login session), not a historical record.
  test('forget deletes the device\'s kv-store values and reports the count, even with deleteHistory: false', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const log = createLogger('test')
    const states = createDeviceStateMachine({ db, log })
    const jobStore = createJobStore(db)
    const leases = createLeaseManager({
      states,
      jobStore,
      config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
      log,
      onJobLeaseExpired: () => {},
    })
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-lifecycle-kv-'))
    const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
    const lifecycle = createDeviceLifecycle({ db, leases, log, kv })

    seedDevice(db, 'd1', 'offline')
    kv.set({ kind: 'device', stableId: 'stable-d1' }, 'tiktok-login', 'session', { userId: 'u1' })
    kv.set({ kind: 'device', stableId: 'stable-d1' }, 'tiktok-login', 'token', 'sk-secret', { secret: true })
    // A different device's value must survive.
    seedDevice(db, 'd2', 'offline')
    kv.set({ kind: 'device', stableId: 'stable-d2' }, 'tiktok-login', 'session', { userId: 'u2' })

    const result = await lifecycle.forget('d1', { deleteHistory: false, actor: { userId: 'u1' } })
    expect(result.kvDeleted).toBe(2)
    expect(kv.get({ kind: 'device', stableId: 'stable-d1' }, 'tiktok-login', 'session')).toBeNull()
    expect(kv.get({ kind: 'device', stableId: 'stable-d1' }, 'tiktok-login', 'token')).toBeNull()
    expect(kv.get({ kind: 'device', stableId: 'stable-d2' }, 'tiktok-login', 'session')?.value).toEqual({ userId: 'u2' })

    rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('block (plan 47 §4.3, §4.4)', () => {
  test('blocking a connected device removes it from the fleet and lists it as blocked', async () => {
    const { db, lifecycle } = setUp()
    seedDevice(db, 'd1', 'idle')
    const blocked = await lifecycle.block('d1', { reason: 'retired', actor: { userId: 'admin1' } })
    expect(blocked).toMatchObject({ stableId: 'stable-d1', label: 'Phone d1', reason: 'retired', blockedBy: 'admin1' })

    expect(db.select().from(devices).where(eq(devices.id, 'd1')).get()).toBeUndefined()
    const listed = await lifecycle.listBlocked()
    expect(listed.map((b) => b.stableId)).toEqual(['stable-d1'])
  })

  test('block is refused for a busy device or an active manual lease, same rules as forget', async () => {
    const { db, lifecycle, leases } = setUp()
    seedDevice(db, 'd1', 'busy')
    await expect(lifecycle.block('d1', { actor: { userId: null } })).rejects.toMatchObject({ code: 'device_busy' })

    seedDevice(db, 'd2', 'idle')
    leases.acquireManual('d2', 'client-1')
    await expect(lifecycle.block('d2', { actor: { userId: null } })).rejects.toMatchObject({ code: 'device_in_use' })

    // Neither attempt touched its row.
    expect(db.select().from(devices).where(eq(devices.id, 'd1')).get()).toBeTruthy()
    expect(db.select().from(devices).where(eq(devices.id, 'd2')).get()).toBeTruthy()
  })

  test('unblock removes it from the blocked list', async () => {
    const { db, lifecycle } = setUp()
    seedDevice(db, 'd1', 'offline')
    await lifecycle.block('d1', { actor: { userId: null } })
    expect(await lifecycle.listBlocked()).toHaveLength(1)

    await lifecycle.unblock('stable-d1', { userId: 'admin1' })
    expect(await lifecycle.listBlocked()).toHaveLength(0)
  })

  test('unblocking an unknown stableId is refused', async () => {
    const { lifecycle } = setUp()
    await expect(lifecycle.unblock('ghost', { userId: null })).rejects.toBeInstanceOf(EnkakuError)
  })
})
