import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createLeaseManager, type LeaseManager } from '../lease/lease-manager'
import type { DeviceNetworkPort } from '../network/route-service'
import type { Logger } from '../util/logger'
import type { CapabilityActor, CapabilityContext } from './context'
import { createDeviceNetworkService, DEVICE_NETWORK_CAPABILITIES, deviceNetworkClear, deviceNetworkGet, deviceNetworkSet } from './device-network'

/**
 * `device.network.get` / `.set` / `.clear` — plan 114 §3.3, step 114.9: the
 * plugin boundary, and the only way anything other than an HTTP request reaches
 * a device's route.
 *
 * The `DeviceNetworkPort` is faked here on purpose: what this file tests is the
 * ADMISSION around the door (a transient lease taken and given back, a refusal
 * that names who holds the phone, an actor-less caller refused outright), not
 * the door itself — that is `network/route-service.test.ts`'s subject, through
 * the real service.
 */

interface PortCalls {
  port: DeviceNetworkPort
  calls: Array<{ op: 'get' | 'set' | 'clear'; deviceId: string; actor?: string | null; route?: unknown }>
}

function fakePort(behaviour: { setThrows?: string } = {}): PortCalls {
  const calls: PortCalls['calls'] = []
  const port: DeviceNetworkPort = {
    get: async (deviceId) => {
      calls.push({ op: 'get', deviceId })
      return { engine: 'none' } as never
    },
    set: async (deviceId, route, actor) => {
      calls.push({ op: 'set', deviceId, actor, route })
      if (behaviour.setThrows) throw new Error(behaviour.setThrows)
      return { engine: 'adb-proxy' } as never
    },
    clear: async (deviceId, actor) => {
      calls.push({ op: 'clear', deviceId, actor })
      return { engine: 'none' } as never
    },
  }
  return { port, calls }
}

interface AcquireCall {
  deviceId: string
  clientId: string
  userId: string | null | undefined
}

function setUp(deviceStatus: 'idle' | 'offline' = 'idle'): {
  db: Db
  leases: LeaseManager
  acquires: AcquireCall[]
  releases: Array<{ deviceId: string; clientId: string }>
} {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log }
  db.insert(devices).values({ id: 'dev-1', stableId: 'stable-dev-1', serial: 'SER-1', label: 'Phone', status: deviceStatus }).run()
  const states = createDeviceStateMachine({ db, log, onChange: () => {} })
  const real = createLeaseManager({
    states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 600, reaperIntervalMs: 1_000_000 },
    log,
    onJobLeaseExpired: () => {},
  })
  const acquires: AcquireCall[] = []
  const releases: Array<{ deviceId: string; clientId: string }> = []
  const leases: LeaseManager = {
    ...real,
    acquireManual: (deviceId, clientId, userId, opts) => {
      acquires.push({ deviceId, clientId, userId })
      return real.acquireManual(deviceId, clientId, userId, opts)
    },
    releaseManual: (deviceId, clientId, reason) => {
      releases.push({ deviceId, clientId })
      return real.releaseManual(deviceId, clientId, reason)
    },
  }
  return { db, leases, acquires, releases }
}

const actor = (id: string): CapabilityActor => ({ id, role: 'operator' })

describe('the transient hold (plan 93 §3.8’s admitMember, applied to one device)', () => {
  test('an idle device: acquire, one call to the port, release', async () => {
    const { leases, acquires, releases } = setUp()
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, leases }, actor('u1'))

    await service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ op: 'set', deviceId: 'dev-1', actor: 'u1' })
    expect(acquires).toHaveLength(1)
    expect(releases).toEqual([{ deviceId: 'dev-1', clientId: 'u1' }])
    expect(leases.getHolder('dev-1')).toBeNull()
  })

  test('the hold is given back even when the port throws', async () => {
    const { leases, releases } = setUp()
    const { port } = fakePort({ setThrows: 'the device declined the setting' })
    const service = createDeviceNetworkService({ port, leases }, actor('u1'))

    await expect(service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })).rejects.toThrow('the device declined the setting')
    expect(releases).toEqual([{ deviceId: 'dev-1', clientId: 'u1' }])
    expect(leases.getHolder('dev-1')).toBeNull()
  })

  test('a device the caller already holds runs and releases NOTHING — it was not this call’s hold to give back', async () => {
    const { leases, acquires, releases } = setUp()
    leases.acquireManual('dev-1', 'u1', 'u1')
    acquires.length = 0
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, leases }, actor('u1'))

    await service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })
    expect(calls).toHaveLength(1)
    expect(acquires).toHaveLength(0)
    expect(releases).toHaveLength(0)
    expect(leases.getHolder('dev-1')?.id).toBe('u1')
  })

  test('a device held by somebody else is refused with not_lease_holder verbatim, and the port is never called', async () => {
    const { leases, releases } = setUp()
    leases.acquireManual('dev-1', 'someone-else', 'u2')
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, leases }, actor('u1'))

    await expect(service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })).rejects.toMatchObject({
      code: 'not_lease_holder',
      message: 'another client is controlling this device',
    })
    expect(calls).toHaveLength(0)
    expect(releases).toHaveLength(0)
    // Untouched: whoever was driving the phone still is.
    expect(leases.getHolder('dev-1')?.id).toBe('u2')
  })

  test('an unreachable device is refused with device_unavailable rather than silently applied', async () => {
    const { leases } = setUp('offline')
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, leases }, actor('u1'))
    await expect(service.clear('dev-1')).rejects.toMatchObject({ code: 'device_unavailable' })
    expect(calls).toHaveLength(0)
  })

  test('a read takes no lease at all — seeing what a phone is set to must work while somebody else drives it', async () => {
    const { leases, acquires } = setUp()
    leases.acquireManual('dev-1', 'someone-else', 'u2')
    acquires.length = 0
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, leases }, actor('u1'))

    await service.get('dev-1')
    expect(calls).toEqual([{ op: 'get', deviceId: 'dev-1' }])
    expect(acquires).toHaveLength(0)
  })
})

describe('the principal (plan 109 §4.3, plan 114 §3.3)', () => {
  test('userId is null for a plugin principal and the id for a person; clientId is the full principal in both cases', async () => {
    for (const [principal, expectedUserId] of [
      ['u1', 'u1'],
      ['plugin:proxy-manager', null],
    ] as const) {
      const { leases, acquires } = setUp()
      const { port, calls } = fakePort()
      const service = createDeviceNetworkService({ port, leases }, actor(principal))
      await service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })
      expect(acquires, principal).toEqual([{ deviceId: 'dev-1', clientId: principal, userId: expectedUserId }])
      // The route write is attributed with the FULL principal — `stampSetBy` is the one
      // place that decides whether it names a person or a plugin.
      expect(calls[0]?.actor, principal).toBe(principal)
    }
  })

  test('an actor-less context is E_FORBIDDEN — never an unattributed write, and never a lease taken first', async () => {
    const { leases, acquires } = setUp()
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, leases }, null)

    await expect(service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })).rejects.toMatchObject({ code: 'E_FORBIDDEN' })
    await expect(service.clear('dev-1')).rejects.toMatchObject({ code: 'E_FORBIDDEN' })
    expect(calls).toHaveLength(0)
    expect(acquires).toHaveLength(0)
  })
})

describe('the capability declarations', () => {
  test('all three refuse E_NOT_SUPPORTED on a host with no device networking (orchestrator mode)', async () => {
    const ctx = {} as CapabilityContext
    // `mustNetwork` throws synchronously out of the handler, which `invoke`'s own
    // `new Promise(...)` executor turns into a rejection — wrapped here so the test
    // asserts the code either way rather than depending on which it is.
    const run = (fn: () => unknown): Promise<unknown> => Promise.resolve().then(fn)
    await expect(run(() => deviceNetworkGet.handler(ctx, { deviceId: 'dev-1' }))).rejects.toMatchObject({ code: 'E_NOT_SUPPORTED' })
    await expect(run(() => deviceNetworkSet.handler(ctx, { deviceId: 'dev-1', route: {} }))).rejects.toMatchObject({ code: 'E_NOT_SUPPORTED' })
    await expect(run(() => deviceNetworkClear.handler(ctx, { deviceId: 'dev-1' }))).rejects.toMatchObject({ code: 'E_NOT_SUPPORTED' })
  })

  /**
   * The input schema is LOOSE for one reason: `NetworkRouteConfigSchema` strips
   * unknown keys, and one of the keys it would strip is `password` — precisely
   * the key `assertNoHttpProxyAuth` exists to refuse by name. Parsing the union
   * here would silently delete the credential and apply a route that looks
   * clean, turning a coded refusal into quiet data loss.
   */
  test('the input schema does NOT strip a password, so E_HTTP_PROXY_NO_AUTH can still fire at the door', () => {
    const parsed = deviceNetworkSet.input.parse({
      deviceId: 'dev-1',
      route: { engine: 'adb-proxy', host: 'h', port: 8080, username: 'sam', password: 'hunter2', credentialRef: 'soax' },
    }) as { route: Record<string, unknown> }
    expect(parsed.route.password).toBe('hunter2')
    expect(parsed.route.username).toBe('sam')
    expect(parsed.route.credentialRef).toBe('soax')
  })

  test('an untagged route body still reaches the door, which tags it as vpn-helper by construction', () => {
    const parsed = deviceNetworkSet.input.parse({ deviceId: 'dev-1', route: { host: 'proxy.example', port: 1080, udpMode: 'udp' } }) as { route: Record<string, unknown> }
    expect(parsed.route.engine).toBeUndefined()
    expect(parsed.route.host).toBe('proxy.example')
  })

  test('every one declares device.network and lease: none — the admission moved into the handler, it was not dropped', () => {
    expect(DEVICE_NETWORK_CAPABILITIES.map((c) => c.id)).toEqual(['device.network.get', 'device.network.set', 'device.network.clear'])
    for (const cap of DEVICE_NETWORK_CAPABILITIES) {
      expect(cap.permission, cap.id).toBe('device.network')
      expect(cap.lease, cap.id).toBe('none')
    }
    expect(deviceNetworkGet.effect).toBe('read')
    expect(deviceNetworkSet.effect).toBe('write')
    expect(deviceNetworkClear.effect).toBe('write')
  })
})
