import { describe, expect, test } from 'bun:test'
import { E_DEVICE_CONFLICT } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createActivityRegistry, type ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import type { DeviceNetworkPort } from '../network/route-service'
import { createLogger } from '../util/logger'
import type { CapabilityActor, CapabilityContext } from './context'
import { createDeviceNetworkService, DEVICE_NETWORK_CAPABILITIES, deviceNetworkClear, deviceNetworkGet, deviceNetworkSet } from './device-network'

/**
 * `device.network.get` / `.set` / `.clear` — plan 114 §3.3, step 114.9: the
 * plugin boundary, and the only way anything other than an HTTP request reaches
 * a device's route. Reworked for plan 205 §5 step 205.8: the old transient-hold
 * admission (acquire/release, refuse naming the holder) becomes the device
 * activity policy's `network-apply` row — nothing is ever acquired, a
 * `network-apply:<uuid>` marker wraps the write for its own duration, and
 * only a live `job`/`workflow-job`/`install` on the device forbids (never
 * an offline/quarantined status, never another human's `control` marker).
 *
 * The `DeviceNetworkPort` is faked here on purpose: what this file tests is
 * the ADMISSION around the door, not the door itself — that is
 * `network/route-service.test.ts`'s subject, through the real service.
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

function setUp(deviceStatus: 'online' | 'offline' = 'online'): {
  db: Db
  activities: ActivityRegistry
  controlSettings: () => ControlPolicySettings
  activityCalls: { start: number; end: number }
} {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(devices).values({ id: 'dev-1', stableId: 'stable-dev-1', serial: 'SER-1', label: 'Phone', status: deviceStatus }).run()
  const real = createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
  const activityCalls = { start: 0, end: 0 }
  const activities: ActivityRegistry = {
    ...real,
    start: (deviceId, input) => {
      activityCalls.start++
      return real.start(deviceId, input)
    },
    end: (deviceId, id) => {
      activityCalls.end++
      return real.end(deviceId, id)
    },
  }
  return { db, activities, controlSettings: () => ({ overControl: 'allow', idleSec: 30 }), activityCalls }
}

const actor = (id: string): CapabilityActor => ({ id, role: 'operator' })

describe("the network-apply marker (plan 205 §4.4, §5 step 205.8, applied to one device)", () => {
  test('a device with nothing else live: one call to the port, wrapped in a marker that starts and ends', async () => {
    const { activities, controlSettings, activityCalls } = setUp()
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, activities, controlSettings }, actor('u1'))

    await service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ op: 'set', deviceId: 'dev-1', actor: 'u1' })
    expect(activityCalls.start).toBe(1)
    expect(activityCalls.end).toBe(1)
    expect(activities.list('dev-1')).toEqual([])
  })

  test('the marker is ended even when the port throws', async () => {
    const { activities, controlSettings, activityCalls } = setUp()
    const { port } = fakePort({ setThrows: 'the device declined the setting' })
    const service = createDeviceNetworkService({ port, activities, controlSettings }, actor('u1'))

    await expect(service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })).rejects.toThrow('the device declined the setting')
    expect(activityCalls.start).toBe(1)
    expect(activityCalls.end).toBe(1)
    expect(activities.list('dev-1')).toEqual([])
  })

  test('two applies from unrelated actors both run — last-write-wins with attribution, never a lock', async () => {
    const { activities, controlSettings } = setUp()
    const { port, calls } = fakePort()
    const serviceA = createDeviceNetworkService({ port, activities, controlSettings }, actor('u1'))
    const serviceB = createDeviceNetworkService({ port, activities, controlSettings }, actor('plugin:proxy-manager'))

    await serviceA.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })
    await serviceB.set('dev-1', { engine: 'adb-proxy', host: 'h2', port: 9090 })
    expect(calls.map((c) => c.actor)).toEqual(['u1', 'plugin:proxy-manager'])
  })

  test('forbidden while a job is running on the device — a route change on a running automation is not safe', async () => {
    const { activities, controlSettings } = setUp()
    activities.start('dev-1', { id: 'job:j1', kind: 'job', label: 'Running tiktok/login (job #482)', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, activities, controlSettings }, actor('u1'))

    await expect(service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })).rejects.toMatchObject({ code: E_DEVICE_CONFLICT })
    expect(calls).toHaveLength(0)
  })

  test('allowed while a human is controlling the device — network-apply is not blocked by control', async () => {
    const { activities, controlSettings } = setUp()
    activities.touchControl('dev-1', 'user:u2', { kind: 'user', id: 'u2', label: 'u2' })
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, activities, controlSettings }, actor('u1'))

    await service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })
    expect(calls).toHaveLength(1)
  })

  /**
   * **The disarm direction, and the one thing this rework preserves.** A route
   * write/clear takes no online check at all anymore (`device-network.ts`'s own
   * doc comment on `deviceNetworkGet`/`Set`/`Clear`: no `activity` field, so
   * `invoke`'s generic online gate never runs) — a route is a property of the
   * DEVICE and survives it being offline, and the off switch must not be
   * unreachable on the phones that most need it.
   */
  test('an offline device still admits both an apply and a clear — nothing was ever a precondition to acquire', async () => {
    const { activities, controlSettings } = setUp('offline')
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, activities, controlSettings }, actor('plugin:proxy-manager'))

    await service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })
    await service.clear('dev-1')
    expect(calls.map((c) => c.op)).toEqual(['set', 'clear'])
  })

  test('a read takes no marker at all — seeing what a phone is set to must work while somebody else drives it', async () => {
    const { activities, controlSettings, activityCalls } = setUp()
    activities.touchControl('dev-1', 'user:u2', { kind: 'user', id: 'u2', label: 'u2' })
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, activities, controlSettings }, actor('u1'))

    await service.get('dev-1')
    expect(calls).toEqual([{ op: 'get', deviceId: 'dev-1' }])
    expect(activityCalls.start).toBe(0)
  })
})

describe('the principal (plan 109 §4.3, plan 114 §3.3)', () => {
  test('the actor id names a plugin (plugin:<name>) or a person, and the marker attributes accordingly', async () => {
    for (const principal of ['u1', 'plugin:proxy-manager'] as const) {
      const { activities, controlSettings } = setUp()
      const { port, calls } = fakePort()
      const service = createDeviceNetworkService({ port, activities, controlSettings }, actor(principal))
      await service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })
      // The route write is attributed with the FULL principal — `stampSetBy` is the one
      // place that decides whether it names a person or a plugin.
      expect(calls[0]?.actor, principal).toBe(principal)
    }
  })

  test('an actor-less context is E_FORBIDDEN — never an unattributed write, and never a marker started first', async () => {
    const { activities, controlSettings, activityCalls } = setUp()
    const { port, calls } = fakePort()
    const service = createDeviceNetworkService({ port, activities, controlSettings }, null)

    await expect(service.set('dev-1', { engine: 'adb-proxy', host: 'h', port: 8080 })).rejects.toMatchObject({ code: 'E_FORBIDDEN' })
    await expect(service.clear('dev-1')).rejects.toMatchObject({ code: 'E_FORBIDDEN' })
    expect(calls).toHaveLength(0)
    expect(activityCalls.start).toBe(0)
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

  test('every one declares device.network and no activity field — the admission moved into the handler, it was not dropped', () => {
    expect(DEVICE_NETWORK_CAPABILITIES.map((c) => c.id)).toEqual(['device.network.get', 'device.network.set', 'device.network.clear'])
    for (const cap of DEVICE_NETWORK_CAPABILITIES) {
      expect(cap.permission, cap.id).toBe('device.network')
      expect(cap.activity, cap.id).toBeUndefined()
    }
    expect(deviceNetworkGet.effect).toBe('read')
    expect(deviceNetworkSet.effect).toBe('write')
    expect(deviceNetworkClear.effect).toBe('write')
  })
})
