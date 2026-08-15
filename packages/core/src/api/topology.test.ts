import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { clusters, devices, jobs, scripts } from '../db/schema'
import { buildTopology, createTopologyRoutes } from './topology'
import { createDeviceStateMachine } from '../device/state-machine'
import { createLeaseManager } from '../lease/lease-manager'
import { createCoControlManager } from '../lease/co-control'
import { createLogger } from '../util/logger'

function seedDevice(db: Db, id: string, opts: { clusterId?: string | null; status?: string } = {}): void {
  db.insert(devices)
    .values({
      id,
      stableId: `stable-${id}`,
      serial: `serial-${id}`,
      label: `Phone ${id}`,
      status: opts.status ?? 'idle',
      clusterId: opts.clusterId ?? null,
    })
    .run()
}

function seedCluster(db: Db, id: string, name: string): void {
  db.insert(clusters).values({ id, name, description: null, createdAt: new Date() }).run()
}

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

describe('buildTopology', () => {
  test('a device belongs to at most one cluster (plan 22.0 §1) and never appears in ungrouped', () => {
    const db = setUp()
    seedCluster(db, 'cl-smoke', 'smoke')
    seedDevice(db, 'a', { clusterId: 'cl-smoke' })

    const topo = buildTopology(db)
    const smoke = topo.clusters.find((c) => c.id === 'cl-smoke')
    expect(smoke?.deviceIds).toContain('a')
    expect(topo.ungroupedDeviceIds).not.toContain('a')
  })

  test('an offline device still belongs to the cluster it is assigned to', () => {
    const db = setUp()
    seedCluster(db, 'cl-smoke', 'smoke')
    seedDevice(db, 'offline-1', { clusterId: 'cl-smoke', status: 'offline' })

    const topo = buildTopology(db)
    const smoke = topo.clusters.find((c) => c.id === 'cl-smoke')
    // The map shows set membership, not runnability (plan 32 §3.2) — an
    // offline member still belongs on its cluster's section (as an offline
    // tile), unlike a batch dispatch which would skip it.
    expect(smoke?.deviceIds).toContain('offline-1')
    expect(topo.ungroupedDeviceIds).not.toContain('offline-1')
  })

  test('a device in no cluster appears only in ungroupedDeviceIds', () => {
    const db = setUp()
    seedCluster(db, 'cl-smoke', 'smoke')
    seedDevice(db, 'lonely')

    const topo = buildTopology(db)
    expect(topo.ungroupedDeviceIds).toContain('lonely')
    for (const cluster of topo.clusters) expect(cluster.deviceIds).not.toContain('lonely')
  })

  test('a cluster with no members resolves to an empty deviceIds array, not an error', () => {
    const db = setUp()
    seedCluster(db, 'cl-empty', 'empty')
    seedDevice(db, 'a')

    const topo = buildTopology(db)
    const empty = topo.clusters.find((c) => c.id === 'cl-empty')
    expect(empty?.deviceIds).toEqual([])
  })

  test('the ungrouped set plus every cluster set together cover every device exactly once each', () => {
    const db = setUp()
    seedCluster(db, 'cl-smoke', 'smoke')
    seedCluster(db, 'cl-15', 'android 15')
    seedDevice(db, 'a', { clusterId: 'cl-smoke' })
    seedDevice(db, 'b', { clusterId: 'cl-smoke' })
    seedDevice(db, 'c') // ungrouped
    seedDevice(db, 'd', { clusterId: 'cl-15', status: 'quarantined' }) // unusable, still a member

    const topo = buildTopology(db)
    expect(topo.devices.map((d) => d.id).sort()).toEqual(['a', 'b', 'c', 'd'])

    const coveredByClusters = new Set(topo.clusters.flatMap((c) => c.deviceIds))
    const union = new Set([...coveredByClusters, ...topo.ungroupedDeviceIds])
    // Every device appears somewhere.
    expect([...union].sort()).toEqual(['a', 'b', 'c', 'd'])
    // Nothing is both ungrouped and in a cluster.
    for (const id of topo.ungroupedDeviceIds) expect(coveredByClusters.has(id)).toBe(false)
    // Only the ungrouped device is ungrouped.
    expect(topo.ungroupedDeviceIds).toEqual(['c'])
    // Membership is exclusive — no device appears in more than one section.
    const smoke = topo.clusters.find((c) => c.id === 'cl-smoke')
    const fifteen = topo.clusters.find((c) => c.id === 'cl-15')
    expect(smoke?.deviceIds.sort()).toEqual(['a', 'b'])
    expect(fifteen?.deviceIds.sort()).toEqual(['d'])
  })

  test('activeJobs lists only running jobs, with the script name resolved', () => {
    const db = setUp()
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    db.insert(scripts)
      .values({ id: 'scr-1', name: 'tap-tap', version: '1.0.0', bundle: '', enabled: true, createdAt: new Date() })
      .run()
    const now = new Date()
    db.insert(jobs)
      .values({ id: 'job-running', scriptId: 'scr-1', deviceId: 'a', status: 'running', createdAt: now, startedAt: now })
      .run()
    db.insert(jobs)
      .values({ id: 'job-queued', scriptId: 'scr-1', deviceId: 'b', status: 'queued', createdAt: now })
      .run()

    const topo = buildTopology(db)
    expect(topo.activeJobs).toEqual([
      { deviceId: 'a', jobId: 'job-running', scriptName: 'tap-tap', startedAt: Math.floor(now.getTime() / 1000) },
    ])
  })
})

describe('GET /api/topology', () => {
  test('returns the whole farm in one call', async () => {
    const db = setUp()
    seedCluster(db, 'cl-smoke', 'smoke')
    seedDevice(db, 'a', { clusterId: 'cl-smoke' })
    const app = createTopologyRoutes({ db })

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      clusters: Array<{ id: string; deviceIds: string[] }>
      devices: Array<{ id: string }>
      ungroupedDeviceIds: string[]
      activeJobs: unknown[]
    }
    expect(body.devices.map((d) => d.id)).toEqual(['a'])
    expect(body.clusters.find((c) => c.id === 'cl-smoke')?.deviceIds).toEqual(['a'])
    expect(body.ungroupedDeviceIds).toEqual([])
    expect(body.activeJobs).toEqual([])
  })

  /**
   * Plan 88 §3.6, §4.1, §5 step 88.5 — without threading `networks` through,
   * the fleet map would badge every TCP device `TCP`, never `OTG`/`WI-FI`,
   * disagreeing with `GET /api/devices` right next to it (the coordinator's
   * own "found by the 88.10 worker" note: three steps that each passed their
   * own tests and produced nothing together).
   */
  test('a device on a configured wired network reads back medium: wired, mediumSource: network — not just from deriveConnection in isolation', async () => {
    const db = setUp()
    seedDevice(db, 'a')
    db.update(devices).set({ serial: '10.0.0.5:5555' }).where(eq(devices.id, 'a')).run()
    const app = createTopologyRoutes({
      db,
      networks: () => [{ cidr: '10.0.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }],
    })

    const res = await app.request('/')
    const body = (await res.json()) as {
      devices: Array<{ id: string; connection: { medium: string | null; mediumSource: string; networkLabel: string | null } }>
    }
    expect(body.devices.find((d) => d.id === 'a')?.connection).toMatchObject({
      medium: 'wired',
      mediumSource: 'network',
      networkLabel: 'Chassis A',
    })
  })

  /**
   * Plan 91 §3.4 item 4, §4.4 — the producer gap step 91.4 flagged and left
   * open: `assistedByOf` reaches `GET /api/topology` too, not only `GET
   * /api/devices`. Proven through the real HTTP route, the same discipline
   * the `connection.medium` test just above already established.
   */
  test('a device with an active assist grant reports assistedBy; an unassisted one reports []', async () => {
    const db = setUp()
    seedDevice(db, 'a')
    seedDevice(db, 'b')
    const assistHolder = { kind: 'user' as const, id: 'u-assist', label: 'operator@enkaku', runId: null, takeable: false, acquiredAt: 100, expiresAt: 200 }
    const app = createTopologyRoutes({
      db,
      assistedByOf: (deviceId) => (deviceId === 'a' ? [assistHolder] : []),
    })

    const res = await app.request('/')
    const body = (await res.json()) as { devices: Array<{ id: string; assistedBy: unknown }> }
    expect(body.devices.find((d) => d.id === 'a')?.assistedBy).toEqual([assistHolder])
    expect(body.devices.find((d) => d.id === 'b')?.assistedBy).toEqual([])
  })

  test('an omitted assistedByOf dep falls back to [] rather than throwing or guessing', async () => {
    const db = setUp()
    seedDevice(db, 'a')
    const app = createTopologyRoutes({ db })

    const res = await app.request('/')
    const body = (await res.json()) as { devices: Array<{ id: string; assistedBy: unknown }> }
    expect(body.devices.find((d) => d.id === 'a')?.assistedBy).toEqual([])
  })

  /**
   * docs/plans/96-m61-hotfixes.md §96.10, daemon.ts's own residual — the
   * tests above prove `createTopologyRoutes` correctly THREADS whatever
   * `assistedByOf` it is handed; they do not prove the real production
   * expression (`(deviceId) => coControl.assistedBy(deviceId)`, wired into
   * `daemon.ts`'s `createTopologyRoutes({...})` call) behaves correctly end
   * to end. This test builds a REAL `CoControlManager` — the same
   * `leases`-then-`coControl` construction order `daemon.ts` uses — grants a
   * real assist through it, and passes the identical accessor expression
   * `daemon.ts` now contains, so the mechanism under test is the production
   * wiring itself, not a hand-rolled fake array.
   */
  test('a REAL CoControlManager, wired with `assistedByOf: (deviceId) => coControl.assistedBy(deviceId)` — the exact daemon.ts expression — reports the granted assist through GET /api/topology', async () => {
    const db = setUp()
    seedDevice(db, 'a')
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    let coControlRef: ReturnType<typeof createCoControlManager> | null = null
    const leases = createLeaseManager({
      states,
      jobStore: { expiredRunning: () => [] } as never,
      config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
      log: createLogger('test'),
      onJobLeaseExpired: () => {},
      onPrimaryEnded: (deviceId) => coControlRef?.onPrimaryEnded(deviceId),
      onManualTakenOver: ({ deviceId }) => coControlRef?.onPrimaryEnded(deviceId),
    })
    const coControl = createCoControlManager({
      leases,
      config: { grantTtlSec: () => 300, maxConcurrentPerDevice: () => 1 },
      log: createLogger('test'),
    })
    coControlRef = coControl

    // The device must be HELD before an assist can be granted (co-control.ts:
    // `device_not_held` otherwise) — a manual take, exactly like an operator's.
    leases.acquireManual('a', 'primary-client', 'primary-user')
    coControl.grant('a', 'assist-client', 'assisting-user')

    const app = createTopologyRoutes({ db, assistedByOf: (deviceId) => coControl.assistedBy(deviceId) })
    const res = await app.request('/')
    const body = (await res.json()) as { devices: Array<{ id: string; assistedBy: Array<{ kind: string; id: string }> }> }
    const assistedBy = body.devices.find((d) => d.id === 'a')?.assistedBy
    expect(assistedBy).toHaveLength(1)
    expect(assistedBy?.[0]).toMatchObject({ kind: 'user', id: 'assisting-user' })
  })
})
