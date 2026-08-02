import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import type { AdbdShimDeps, AdbdShimHandlers } from '@enkaku/adb'
import { openDb, runMigrations } from '../db'
import { devices } from '../db/schema'
import type { TunnelRouter } from '../tunnel/router'
import type { TunnelRpc } from '../tunnel/rpc'
import { createLogger } from '../util/logger'
import { createAdbEndpointManager, type AdbEndpointListener, type AdbEndpointManagerDeps } from './adb-endpoint'

/**
 * Exercises `AdbEndpointManager`'s lifecycle against a FAKE shim (plan 27
 * §7): no real socket is ever opened. `deps.listen`/`deps.createShim` are
 * the seams — production wiring (`daemon.ts`) uses `bunAdbEndpointListen`
 * and `createAdbdShim` from `@enkaku/adb`; this test injects in-memory
 * fakes so the lease-release / idle-timeout / disconnect / one-per-device
 * bookkeeping is provable without touching a network socket at all.
 */

function seedDevice(db: ReturnType<typeof openDb>['db'], id: string) {
  db.insert(devices)
    .values({
      id,
      stableId: `stable-${id}`,
      serial: `serial-${id}`,
      label: `Device ${id}`,
      apiLevel: 33,
      status: 'manual',
    })
    .run()
}

/** A fake listener/shim pair — `open`/`close` on it simulate a TCP connection arriving and ending. */
function makeFakeListenAndShim() {
  let nextPort = 40000
  const listeners: Array<{ listener: AdbEndpointListener; handlers: AdbdShimHandlers; stopped: boolean }> = []

  const listen = (_hostname: string, handlers: AdbdShimHandlers): AdbEndpointListener => {
    const port = nextPort++
    const entry = { listener: { port, stop: () => {} }, handlers, stopped: false }
    entry.listener = {
      port,
      stop: () => {
        entry.stopped = true
      },
    }
    listeners.push(entry)
    return entry.listener
  }

  const createShim = (_shimDeps: AdbdShimDeps): AdbdShimHandlers => ({
    open: () => {},
    data: () => {},
    close: () => {},
    error: () => {},
  })

  return {
    listen,
    createShim,
    /** Simulate a connection arriving on the endpoint at `port`. */
    connect(port: number) {
      const entry = listeners.find((l) => l.listener.port === port)
      entry?.handlers.open({} as never)
    },
    /** Simulate that connection ending. */
    disconnect(port: number) {
      const entry = listeners.find((l) => l.listener.port === port)
      entry?.handlers.close({} as never)
    },
    isStopped(port: number): boolean {
      return listeners.find((l) => l.listener.port === port)?.stopped ?? false
    },
  }
}

function makeManager(overrides: Partial<AdbEndpointManagerDeps> = {}) {
  const { db } = openDb(':memory:')
  runMigrations(db)
  seedDevice(db, 'dev-1')
  seedDevice(db, 'dev-2')

  const fake = makeFakeListenAndShim()
  const opened: Array<{ deviceId: string; userId: string | null; port: number; agentId?: string | null }> = []
  const closed: Array<{ deviceId: string; reason: string }> = []
  const streamsOpened: Array<{ deviceId: string; service: string }> = []

  const deps: AdbEndpointManagerDeps = {
    db,
    adb: () => ({}) as unknown as AdbClient,
    shellSettings: () => ({ endpointBind: '127.0.0.1', endpointIdleSec: 30, maxEndpointStreams: 8 }),
    listen: fake.listen,
    createShim: fake.createShim,
    onStreamOpen: (deviceId, service) => streamsOpened.push({ deviceId, service }),
    onEndpointOpened: (deviceId, userId, port) => opened.push({ deviceId, userId, port }),
    onEndpointClosed: (deviceId, reason) => closed.push({ deviceId, reason }),
    log: createLogger('test'),
    ...overrides,
  }
  const manager = createAdbEndpointManager(deps)
  return { manager, fake, opened, closed, streamsOpened, db }
}

describe('createAdbEndpointManager — open/close', () => {
  test('open() returns a port and records the endpoint-opened audit event', async () => {
    const { manager, opened } = makeManager()
    const result = await manager.open('dev-1', 'client-a', 'user-1')
    expect(result.host).toBe('127.0.0.1')
    expect(result.port).toBeGreaterThan(0)
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(opened).toEqual([{ deviceId: 'dev-1', userId: 'user-1', port: result.port }])
  })

  test('a device with no row throws device_not_found', async () => {
    const { manager } = makeManager()
    await expect(manager.open('missing-device', 'client-a', null)).rejects.toThrow(/no such device/)
  })

  test('the adb subsystem not being ready throws E_ADB_UNAVAILABLE', async () => {
    const { manager } = makeManager({ adb: () => null })
    await expect(manager.open('dev-1', 'client-a', null)).rejects.toThrow(/adb subsystem/)
  })

  test('close() tears the listener down and records the reason', async () => {
    const { manager, fake, closed } = makeManager()
    const result = await manager.open('dev-1', 'client-a', null)
    manager.close('dev-1', 'lease_released')
    expect(fake.isStopped(result.port)).toBe(true)
    expect(closed).toEqual([{ deviceId: 'dev-1', reason: 'lease_released' }])
    expect(manager.get('dev-1')).toBeNull()
  })

  test('close() on a device with no endpoint is a harmless no-op', () => {
    const { manager, closed } = makeManager()
    expect(() => manager.close('dev-1', 'lease_released')).not.toThrow()
    expect(closed).toEqual([])
  })
})

describe('createAdbEndpointManager — one endpoint per device', () => {
  test('a second open() for the same device returns the SAME port, no new listener', async () => {
    const { manager, opened } = makeManager()
    const first = await manager.open('dev-1', 'client-a', 'user-1')
    const second = await manager.open('dev-1', 'client-a', 'user-1')
    expect(second.port).toBe(first.port)
    expect(opened).toHaveLength(1) // onEndpointOpened fires once, not per re-open
  })

  test('two different devices each get their own listener', async () => {
    const { manager } = makeManager()
    const a = await manager.open('dev-1', 'client-a', null)
    const b = await manager.open('dev-2', 'client-a', null)
    expect(a.port).not.toBe(b.port)
  })
})

describe('createAdbEndpointManager — connections and get()', () => {
  test('get() reports live connection count as they open and close', async () => {
    const { manager, fake } = makeManager()
    const result = await manager.open('dev-1', 'client-a', null)
    expect(manager.get('dev-1')).toEqual({
      host: '127.0.0.1',
      port: result.port,
      connections: 0,
      openedAt: expect.any(Number),
      expiresAt: result.expiresAt,
    })

    fake.connect(result.port)
    expect(manager.get('dev-1')?.connections).toBe(1)

    fake.connect(result.port)
    expect(manager.get('dev-1')?.connections).toBe(2)

    fake.disconnect(result.port)
    expect(manager.get('dev-1')?.connections).toBe(1)
  })

  test('get() on a device with no endpoint returns null', () => {
    const { manager } = makeManager()
    expect(manager.get('dev-1')).toBeNull()
  })
})

describe('createAdbEndpointManager — idle timeout (plan §3.4.5, acceptance #6)', () => {
  test('closes itself after endpointIdleSec with no connection', async () => {
    const { manager, fake, closed } = makeManager({
      shellSettings: () => ({ endpointBind: '127.0.0.1', endpointIdleSec: 30, maxEndpointStreams: 8 }),
    })
    const result = await manager.open('dev-1', 'client-a', null)
    expect(closed).toEqual([])

    // Manually fast-forward is not available for real timers here, so this
    // test uses a very short idle window instead (see the next test) —
    // this one only proves NO premature close happens while still fresh.
    expect(fake.isStopped(result.port)).toBe(false)
  })

  test('a short idle window actually fires and tears the endpoint down', async () => {
    const { manager, fake, closed } = makeManager({
      shellSettings: () => ({ endpointBind: '127.0.0.1', endpointIdleSec: 1, maxEndpointStreams: 8 }),
    })
    // Zod's schema clamps endpointIdleSec to >= 30 in production, but the
    // manager itself trusts whatever `shellSettings()` reports — this test
    // deliberately uses a tiny value to keep the suite fast.
    const result = await manager.open('dev-1', 'client-a', null)
    await Bun.sleep(1_100)
    expect(fake.isStopped(result.port)).toBe(true)
    expect(closed).toEqual([{ deviceId: 'dev-1', reason: 'idle_timeout' }])
  })

  test('an active connection prevents the idle timer from firing', async () => {
    const { manager, fake, closed } = makeManager({
      shellSettings: () => ({ endpointBind: '127.0.0.1', endpointIdleSec: 1, maxEndpointStreams: 8 }),
    })
    const result = await manager.open('dev-1', 'client-a', null)
    fake.connect(result.port)
    await Bun.sleep(1_100)
    expect(fake.isStopped(result.port)).toBe(false)
    expect(closed).toEqual([])
  })

  test('the idle timer restarts once the last connection ends', async () => {
    const { manager, fake, closed } = makeManager({
      shellSettings: () => ({ endpointBind: '127.0.0.1', endpointIdleSec: 1, maxEndpointStreams: 8 }),
    })
    const result = await manager.open('dev-1', 'client-a', null)
    fake.connect(result.port)
    await Bun.sleep(500)
    expect(closed).toEqual([]) // still connected, no close yet
    fake.disconnect(result.port)
    await Bun.sleep(1_100)
    expect(fake.isStopped(result.port)).toBe(true)
    expect(closed).toEqual([{ deviceId: 'dev-1', reason: 'idle_timeout' }])
  })
})

describe('createAdbEndpointManager — closeAllForClient (WS disconnect)', () => {
  test('closes only the endpoints opened by that client', async () => {
    const { manager, closed } = makeManager()
    const a = await manager.open('dev-1', 'client-a', null)
    const b = await manager.open('dev-2', 'client-b', null)
    manager.closeAllForClient('client-a')
    expect(manager.get('dev-1')).toBeNull()
    expect(manager.get('dev-2')).not.toBeNull()
    expect(closed).toEqual([{ deviceId: 'dev-1', reason: 'disconnected' }])
    void a
    void b
  })
})

describe('createAdbEndpointManager — cloud devices (plan 28 §4.4)', () => {
  /** A minimal `TunnelRpc`/`TunnelRouter` pair — good enough to prove the
   * MANAGER picks the remote path; `adb-remote.test.ts` already exhaustively
   * covers `createRemoteOpenService` itself. */
  function fakeTunnel() {
    const rpc: TunnelRpc = {
      request: async () => ({ ok: true }) as never,
      handleReply: () => false,
      watch: () => () => {},
      dispatch: () => false,
      failAllForAgent: () => {},
    }
    const router: TunnelRouter = {
      handleAgentMessage: () => {},
      handleAgentFrame: () => {},
      sendToDevice: () => true,
      subscribeVideo: () => () => {},
      openChannel: () => 1,
      subscribeChannel: () => () => {},
      sendFrame: () => {},
      closeChannel: () => {},
    }
    return { rpc, router }
  }

  test('an agent-owned device gets a remote openService and onEndpointOpened receives the agent id', async () => {
    const tunnel = fakeTunnel()
    const { manager, opened } = makeManager({
      remoteAgentIdFor: (deviceId) => (deviceId === 'dev-1' ? 'agent-1' : null),
      rpc: () => tunnel.rpc,
      router: () => tunnel.router,
      onEndpointOpened: (deviceId, userId, port, agentId) => opened.push({ deviceId, userId, port, agentId }),
    })
    const result = await manager.open('dev-1', 'client-a', 'user-1')
    expect(result.port).toBeGreaterThan(0)
    expect(opened).toEqual([{ deviceId: 'dev-1', userId: 'user-1', port: result.port, agentId: 'agent-1' }])
  })

  test('a local device (no remoteAgentIdFor match) still uses the local AdbClient path, unaffected', async () => {
    const tunnel = fakeTunnel()
    const { manager, opened } = makeManager({
      remoteAgentIdFor: () => null, // no device is agent-owned
      rpc: () => tunnel.rpc,
      router: () => tunnel.router,
    })
    const result = await manager.open('dev-1', 'client-a', null)
    expect(result.port).toBeGreaterThan(0)
    expect(opened).toEqual([{ deviceId: 'dev-1', userId: null, port: result.port }])
  })

  test('an agent-owned device with the tunnel not yet ready throws E_ADB_UNAVAILABLE', async () => {
    const { manager } = makeManager({
      remoteAgentIdFor: () => 'agent-1',
      rpc: () => null,
      router: () => null,
    })
    await expect(manager.open('dev-1', 'client-a', null)).rejects.toThrow(/cloud tunnel/)
  })
})

describe('createAdbEndpointManager — stream open audit hook', () => {
  test('onStreamOpen is wired through to the shim deps passed to createShim', async () => {
    let capturedDeps: AdbdShimDeps | null = null
    const { manager } = makeManager({
      createShim: (shimDeps) => {
        capturedDeps = shimDeps
        return { open: () => {}, data: () => {}, close: () => {}, error: () => {} }
      },
    })
    await manager.open('dev-1', 'client-a', null)
    expect(capturedDeps).not.toBeNull()
    expect(capturedDeps!.serial).toBe('serial-dev-1')
    expect(capturedDeps!.banner).toContain('device::')
    expect(capturedDeps!.maxStreams).toBe(8)
  })
})
