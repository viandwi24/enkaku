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
  /*
    Creating no longer counts against the cap, because a created VM is
    `stopped` — it exists on disk and consumes nothing. The cap is about how
    many emulators RUN at once, so it is asserted where that is decided.
  */
  test('start at the cap throws E_VM_LIMIT, read live from maxConcurrent()', async () => {
    let cap = 1
    const { deps } = setUp({ maxConcurrent: () => cap, shell: async () => '1\n' })
    const manager = createVmManager(deps)
    const first = await manager.create(testSpec({ name: 'first' }))
    const second = await manager.create(testSpec({ name: 'second' }))
    await manager.start(first.id)

    let caught: unknown
    try {
      await manager.start(second.id)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_VM_LIMIT')

    // Raising the cap live (never captured once) lets the next start through.
    cap = 2
    const started = await manager.start(second.id)
    expect(started.state).toBe('running')
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

/*
  The owner stopped a virtual device on the Virtual devices page, the row read
  `stopped`, and the emulator went on running with adb still listing it in
  Devices (2026-09-06). `handles` is an in-memory Map, so an emulator that
  outlived the core that spawned it has none — and `stop` wrote `stopped`
  regardless of whether anything was actually killed.
*/
describe('VmManager.stop on an emulator this process did not spawn', () => {
  test('falls back to emu kill by console port, and settles at stopped once the port goes quiet', async () => {
    const ports: number[] = []
    // False while `create` allocates a port (every port would otherwise read
    // as taken), true once the VM is "running", false again after the kill.
    let alive = false
    const { deps, db } = setUp({
      killByConsolePort: async (port) => {
        ports.push(port)
        alive = false
      },
      probePort: async () => alive,
    })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec({ name: 'orphan' }))
    // Exactly what `adopt()` leaves behind after a core restart: running, no handle.
    db.update(virtualDevices).set({ state: 'running' }).where(eq(virtualDevices.id, created.id)).run()
    alive = true

    const stopped = await manager.stop(created.id)
    expect(ports).toEqual([created.consolePort])
    expect(stopped.state).toBe('stopped')
  })

  test('a stop that does not take is reported, never written as stopped', async () => {
    let alive = false
    const { deps, db } = setUp({
      // The kill is issued and the emulator ignores it — the port stays open.
      killByConsolePort: async () => {},
      probePort: async () => alive,
    })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec({ name: 'stubborn' }))
    db.update(virtualDevices).set({ state: 'running' }).where(eq(virtualDevices.id, created.id)).run()
    alive = true

    const after = await manager.stop(created.id)
    expect(after.state).toBe('running')
    expect(after.message).toContain('still answering on console port')
  })

  test('with no fallback wired at all, a stop that cannot kill still refuses to claim success', async () => {
    let alive = false
    const { deps, db } = setUp({ probePort: async () => alive })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec({ name: 'no-fallback' }))
    db.update(virtualDevices).set({ state: 'running' }).where(eq(virtualDevices.id, created.id)).run()
    alive = true

    const after = await manager.stop(created.id)
    expect(after.state).toBe('running')
  })
})

describe('VmManager.adopt reconciles a row that lied', () => {
  test('a stopped row whose console port still answers comes back as running', async () => {
    let alive = false
    const { deps, db } = setUp({ probePort: async () => alive })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec({ name: 'ghost' }))
    // The state the old `stop` left behind: written stopped, never killed.
    db.update(virtualDevices).set({ state: 'stopped' }).where(eq(virtualDevices.id, created.id)).run()
    alive = true

    await manager.adopt()
    const row = manager.list().find((v) => v.id === created.id)
    expect(row?.state).toBe('running')
    expect(row?.message).toContain('still running despite a stopped row')
  })

  test('a stopped row whose port is quiet is left exactly as it was', async () => {
    const { deps, db } = setUp({ probePort: async () => false })
    const manager = createVmManager(deps)
    const created = await manager.create(testSpec({ name: 'genuinely-stopped' }))
    db.update(virtualDevices).set({ state: 'stopped' }).where(eq(virtualDevices.id, created.id)).run()

    await manager.adopt()
    const row = manager.list().find((v) => v.id === created.id)
    expect(row?.state).toBe('stopped')
    expect(row?.message).toBeNull()
  })
})
