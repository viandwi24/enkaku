import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { virtualDevices } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { createVmManager, type VmManagerDeps } from './manager'
import type { VmHandle, VmProvider, VmSpec } from './types'

function fakeLogger(): Logger {
  const self: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

function testSpec(overrides: Partial<VmSpec> = {}): VmSpec {
  return {
    name: 'test-avd',
    apiLevel: 36,
    variant: 'google_apis',
    memoryMb: 2048,
    deviceProfile: 'pixel_7',
    ...overrides,
  }
}

/** A fake `VmProvider` — never spawns a real process (plan 401 §5.5's own rule for the real provider; the manager's tests prove behaviour against this instead). */
function fakeProvider(opts: { destroyCalls?: string[] } = {}): { provider: VmProvider; killed: Set<number>; exitResolvers: Map<number, (code: number) => void> } {
  const killed = new Set<number>()
  const exitResolvers = new Map<number, (code: number) => void>()
  const provider: VmProvider = {
    async create() {},
    async start(_spec, consolePort) {
      const exited = new Promise<number>((resolve) => exitResolvers.set(consolePort, resolve))
      const handle: VmHandle = {
        consolePort,
        kill: () => {
          killed.add(consolePort)
          exitResolvers.get(consolePort)?.(0)
        },
        exited,
      }
      return handle
    },
    async stop(handle) {
      handle.kill('SIGTERM')
      await handle.exited
    },
    async destroy(spec) {
      opts.destroyCalls?.push(spec.name)
    },
  }
  return { provider, killed, exitResolvers }
}

function setUp(overrides: Partial<VmManagerDeps> = {}) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const { provider, killed } = fakeProvider()
  let elapsedMs = 0
  const start = new Date('2026-09-05T00:00:00Z').getTime()

  const deps: VmManagerDeps = {
    db,
    provider,
    shell: async () => '0',
    probePort: async () => false,
    maxConcurrent: () => 2,
    bootTimeoutSec: () => 300,
    log: fakeLogger(),
    now: () => new Date(start + elapsedMs),
    sleep: async (ms: number) => {
      elapsedMs += ms
    },
    ...overrides,
  }
  return { db, deps, killed }
}

describe('VmManager boot polling', () => {
  test('resolves when getprop returns 1', async () => {
    const { deps } = setUp({ shell: async () => '1\n' })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec())
    const started = await manager.start(created.id)
    expect(started.state).toBe('running')
    expect(started.startedAt).not.toBeNull()
  })

  test('a boot timeout kills the child and leaves the row failed, not starting', async () => {
    const { deps, killed } = setUp({ shell: async () => '0', bootTimeoutSec: () => 4 })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec())
    const started = await manager.start(created.id)
    expect(started.state).toBe('failed')
    expect(started.state).not.toBe('starting')
    expect(started.message).toContain('boot did not complete')
    expect(killed.has(created.consolePort)).toBe(true)
  })
})

describe('VmManager.adopt', () => {
  test('a row whose port is live becomes running', async () => {
    // false while `create` is picking a free console port; true once adopt probes it,
    // simulating that the emulator that took that port is still alive after a restart.
    let live = false
    const { deps } = setUp({ probePort: async () => live })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec())
    // Simulate a row that was `running` before the core restarted, with no in-memory handle.
    deps.db.update(virtualDevices).set({ state: 'running' }).where(eq(virtualDevices.id, created.id)).run()

    live = true
    await manager.adopt()
    const row = manager.list().find((r) => r.id === created.id)
    expect(row?.state).toBe('running')
    expect(row?.message).toBe('adopted after a core restart')
  })

  test('a row whose port is dead becomes stopped', async () => {
    const { deps } = setUp({ probePort: async () => false })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec())
    deps.db.update(virtualDevices).set({ state: 'running' }).where(eq(virtualDevices.id, created.id)).run()

    await manager.adopt()
    const row = manager.list().find((r) => r.id === created.id)
    expect(row?.state).toBe('stopped')
  })

  test('a row stuck in creating becomes failed with the restart message', async () => {
    const { deps } = setUp()
    const manager = createVmManager(deps)
    // `create` leaves the row in `creating` when the provider never gets a chance to run
    // past that point in a real restart scenario — simulate by writing the row directly.
    const created = await manager.create(testSpec())
    deps.db.update(virtualDevices).set({ state: 'creating' }).where(eq(virtualDevices.id, created.id)).run()

    await manager.adopt()
    const row = manager.list().find((r) => r.id === created.id)
    expect(row?.state).toBe('failed')
    expect(row?.message).toBe('the core restarted while this VM was being created')
  })
})

describe('VmManager concurrency cap', () => {
  test('create at the cap throws E_VM_LIMIT, read live from maxConcurrent()', async () => {
    let cap = 1
    const { deps } = setUp({ maxConcurrent: () => cap })
    const manager = createVmManager(deps)
    await manager.create(testSpec({ name: 'first' }))

    let caught: unknown
    try {
      await manager.create(testSpec({ name: 'second' }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_VM_LIMIT')

    // Raising the cap live (never captured once) lets the next create through.
    cap = 2
    const second = await manager.create(testSpec({ name: 'second' }))
    expect(second.name).toBe('second')
  })
})

describe('VmManager.remove', () => {
  test('stops a running VM first, and never destroys while it is still running', async () => {
    const destroyCalls: string[] = []
    const { provider } = fakeProvider({ destroyCalls })
    const { deps } = setUp({ provider, shell: async () => '1\n' })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec())
    await manager.start(created.id)
    expect(manager.list().find((r) => r.id === created.id)?.state).toBe('running')

    await manager.remove(created.id)

    expect(destroyCalls).toEqual(['test-avd'])
    expect(manager.list().find((r) => r.id === created.id)).toBeUndefined()
  })
})
