import { describe, expect, test } from 'bun:test'
import type { AgentStatus, DeviceActivity, PreparationComponentStatus } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { busyWith, componentsToUpdate, createDeviceUpdates, type LatestBuilds } from './device-updates'

const LATEST: LatestBuilds = { uiServer: 7, guestAgent: { versionCode: 40, apkSha256: null } }

function ui(version: string | null, state: PreparationComponentStatus['state'] = 'ready'): PreparationComponentStatus {
  return { state, version, reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null }
}

function agent(versionCode: number | null, state: AgentStatus['state'] = 'ready', apkSha256: string | null = null) {
  return { state, appVersion: versionCode === null ? null : `0.${versionCode}`, versionCode, apkSha256 }
}

describe('componentsToUpdate', () => {
  test('a phone on the shipped builds needs nothing', () => {
    expect(componentsToUpdate({ uiServer: ui('7'), agent: agent(40), latest: LATEST })).toEqual([])
  })

  test('an older build of each is listed with both versions', () => {
    expect(componentsToUpdate({ uiServer: ui('6'), agent: agent(39), latest: LATEST })).toEqual([
      { id: 'ui-server', label: 'UI inspector (ui-server)', installed: '6', latest: '7' },
      { id: 'guest-agent', label: 'Guest agent', installed: '0.39', latest: '40' },
    ])
  })

  test('nothing installed yet is preparation\'s job, not an update', () => {
    expect(componentsToUpdate({ uiServer: undefined, agent: agent(null, 'absent'), latest: LATEST })).toEqual([])
  })

  test('an agent too old to answer this core is listed even with no version read', () => {
    expect(componentsToUpdate({ uiServer: ui('7'), agent: agent(null, 'outdated'), latest: LATEST }).map((c) => c.id)).toEqual(['guest-agent'])
  })

  test('a local build is compared by its hash', () => {
    const local: LatestBuilds = { uiServer: null, guestAgent: { versionCode: null, apkSha256: 'abcdef0123' } }
    expect(componentsToUpdate({ uiServer: ui('6'), agent: agent(40, 'ready', 'abcdef0123'), latest: local })).toEqual([])
    expect(componentsToUpdate({ uiServer: ui('6'), agent: agent(40, 'ready', 'ffff'), latest: local })[0]?.latest).toBe('local build abcdef01')
  })
})

function activity(kind: DeviceActivity['kind'], label: string): DeviceActivity {
  return { id: `${kind}:1`, kind, label, actor: { kind: 'system', id: 'core', label: 'Scheduler' }, startedAt: 1, updatedAt: 1 } as DeviceActivity
}

test('busyWith waits for a job, not for somebody watching', () => {
  expect(busyWith([activity('control', 'Viewing')])).toBeNull()
  expect(busyWith([activity('prep', 'Preparing'), activity('job', 'auto-scroll')])?.label).toBe('auto-scroll')
})

function makeDb(n: number): Db {
  const { db } = openDb(':memory:')
  runMigrations(db)
  for (let i = 1; i <= n; i++) {
    db.insert(devices).values({ id: `dev-${i}`, stableId: `s-${i}`, serial: `serial-${i}`, label: `Phone ${i}`, status: 'idle', apiLevel: 34, preparation: { 'ui-server': ui('6') } }).run()
  }
  return db
}

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log } } as never

describe('the update queue', () => {
  test('never runs more than the cap at once, and runs them all', async () => {
    const db = makeDb(5)
    let live = 0
    let peak = 0
    const releases: Array<() => void> = []
    const updates = createDeviceUpdates({
      db,
      log,
      concurrency: 2,
      latest: async () => LATEST,
      agent: { status: async () => ({ ...agent(40), androidSdkInt: 34, capabilities: [], reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null }) as AgentStatus, ensure: async () => { throw new Error('not listed') } },
      runner: {
        ensureComponent: () =>
          new Promise((resolve) => {
            live++
            peak = Math.max(peak, live)
            releases.push(() => {
              live--
              resolve(ui('7'))
            })
          }),
      },
      activities: () => [],
    })
    expect(await updates.start()).toBe(5)
    let snapshot = await updates.list()
    expect(snapshot.running).toBe(2)
    expect(snapshot.queued).toBe(3)
    while (releases.length > 0) {
      releases.shift()!()
      await Bun.sleep(0)
    }
    await Bun.sleep(0)
    expect(peak).toBe(2)
    // Every ui-server was reported 6 before the (fake) update; mark them 7 so the list agrees.
    db.update(devices).set({ preparation: { 'ui-server': ui('7') } }).run()
    snapshot = await updates.list()
    expect(snapshot.devices.map((d) => d.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
    updates.stop()
  })

  test('a phone in the middle of a job waits, and one offline is not listed', async () => {
    const db = makeDb(2)
    const { eq } = await import('drizzle-orm')
    db.update(devices).set({ status: 'offline' }).where(eq(devices.id, 'dev-2')).run()
    let busy = true
    const ran: string[] = []
    const updates = createDeviceUpdates({
      db,
      log,
      concurrency: 2,
      retryMs: 5,
      latest: async () => LATEST,
      agent: { status: async () => ({ ...agent(40) }) as AgentStatus, ensure: async () => { throw new Error('unused') } },
      runner: { ensureComponent: async (id) => { ran.push(id); return ui('7') } },
      activities: () => (busy ? [activity('job', 'auto-scroll')] : []),
    })
    expect(await updates.start()).toBe(1)
    expect((await updates.list()).devices[0]).toMatchObject({ deviceId: 'dev-1', state: 'queued', message: 'Waiting for the job on this phone to finish' })
    busy = false
    await Bun.sleep(30)
    expect(ran).toEqual(['dev-1'])
    updates.stop()
  })
})
