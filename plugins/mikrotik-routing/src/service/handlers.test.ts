import { describe, expect, test } from 'bun:test'
import { DeviceInfoSchema, type DeviceInfo } from '@enkaku/protocol'
import { LOCAL_EXCEPTION_COMMENT } from '../shared'
import type { CoreAddressResult } from './core-address'
import { MikrotikRestError } from './errors'
import { toRuleRow, registerRouterRoutes, ROUTER_ROUTE_PERMISSIONS, ROUTER_ROUTES, type HandlerHost } from './handlers'
import type { DoctorReport, RouterDriver, RouterInventory } from './router-driver'
import { RouterRuleListSchema, type RouterRule } from './schemas'

/**
 * The three read-only routes step 122.3 registers, against a fake host and a
 * fake `RouterDriver` — no HTTP, no real router (that is `rest-client.test.ts`
 * and `router-driver.test.ts`'s job, one layer down). Mirrors
 * `plugins/proxy-manager/src/service/handlers.test.ts`'s own shape: a
 * `FakeHost` that records every registration so a test can invoke a handler
 * directly and read its body.
 */

function fakeRule(overrides: Partial<RouterRule> = {}): RouterRule {
  return { '.id': '*1', comment: '', disabled: false, inactive: false, ...overrides }
}

function emptyInventory(): RouterInventory {
  return { paths: [], interfaces: [], health: [], leases: [] }
}

function okDoctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    reachable: true,
    authenticated: true,
    restVersion: '7.24 (stable)',
    rules: [],
    managedRuleCount: 0,
    foreignRuleCount: 0,
    errors: [],
    ...overrides,
  }
}

function makeDevice(id: string, address: string | null, extra: Partial<{ label: string; number: number }> = {}): DeviceInfo {
  return DeviceInfoSchema.parse({
    id,
    stableId: `stable-${id}`,
    serial: address ? `${address}:5555` : 'usbserial-1',
    label: extra.label ?? id,
    // Left out unless a test asks for one, so the schema's own `.default(null)`
    // keeps standing in for "this device has no number" (plan 124 criterion 7).
    ...(extra.number === undefined ? {} : { number: extra.number }),
    androidVersion: null,
    apiLevel: null,
    screenW: null,
    screenH: null,
    density: null,
    // `idle` was a device status until plan 205 shrank the column to what is
    // physically true (offline | online | quarantined). These fixtures kept
    // the old value and have been failing the plugin's own suite — and CI —
    // ever since; the same slip was fixed in `identity-bridge.test.ts` at the
    // R2 gate and missed here (2026-09-05).
    status: 'online',
    lastSeen: null,
    connection: address
      ? { kind: 'tcp', medium: 'wired', mediumSource: 'declared', address, port: 5555, networkLabel: null }
      : { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
  })
}

/** A `RouterDriver` whose every method is swappable per test — the write three still reject, exactly like `MikrotikRestDriver`'s own (this step ships no write path). */
function fakeDriver(overrides: Partial<RouterDriver> = {}): RouterDriver {
  return {
    inventory: async () => emptyInventory(),
    listRules: async () => [],
    doctor: async () => okDoctorReport(),
    // Plan 134 (M99) §4.4 — nothing in this file probes; a fake that returns `unknown` is the honest default for a driver nobody asked to measure anything.
    probeEgress: async () => ({ status: 'unknown' as const, message: 'not probed in this test' }),
    createRule: async () => {
      throw new Error('not implemented')
    },
    updateRule: async () => {
      throw new Error('not implemented')
    },
    deleteRule: async () => {
      throw new Error('not implemented')
    },
    ...overrides,
  }
}

interface Registered {
  handler: (request: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; caller: { id: string; role: string } }, signal: AbortSignal) => unknown
  opts?: { permission?: string; methods?: readonly string[]; timeoutMs?: number; description?: string }
}

function fakeHost(routerKv: unknown, devices: DeviceInfo[] = []): { host: HandlerHost; registered: Map<string, Registered> } {
  const registered = new Map<string, Registered>()
  const host: HandlerHost = {
    storage: { global: { getRaw: async () => routerKv } },
    farm: { call: async (_id, _input, schema) => schema.parse({ items: devices }) },
    onRequest: (id, handler, opts) => {
      registered.set(id, { handler: handler as Registered['handler'], opts })
    },
  }
  return { host, registered }
}

const FAKE_REQUEST = { method: 'GET', path: '/', query: {}, headers: {}, body: null, caller: { id: 'u1', role: 'admin' } }

describe('registerRouterRoutes — registration table', () => {
  test('registers exactly inventory/rules/doctor/probe-egress, all on script.view (§4.10: onRequest defaults to it, and none of these four write)', () => {
    const { host, registered } = fakeHost(null)
    registerRouterRoutes(host)
    // `probe-egress` (plan 134 §4.4) SENDS three ICMP packets and CHANGES
    // nothing — no router record written, no device touched — so it belongs
    // with the reads, not behind `plugin.runtime`.
    expect([...registered.keys()].sort()).toEqual(['doctor', 'inventory', 'probe-egress', 'rules'])
    for (const key of Object.keys(ROUTER_ROUTES) as (keyof typeof ROUTER_ROUTES)[]) {
      expect(registered.get(ROUTER_ROUTES[key])?.opts?.permission).toBe(ROUTER_ROUTE_PERMISSIONS[key])
    }
  })

  test('inventory and rules are GET, doctor is POST', () => {
    const { host, registered } = fakeHost(null)
    registerRouterRoutes(host)
    expect(registered.get('inventory')?.opts?.methods).toEqual(['GET'])
    expect(registered.get('rules')?.opts?.methods).toEqual(['GET'])
    expect(registered.get('doctor')?.opts?.methods).toEqual(['POST'])
  })
})

describe('registerRouterRoutes — no router saved', () => {
  test('inventory refuses E_ROUTER_NOT_CONFIGURED rather than throwing or building a driver', async () => {
    const { host, registered } = fakeHost(null)
    let built = false
    registerRouterRoutes(host, { createDriver: () => ((built = true), fakeDriver()) })
    const result = await registered.get('inventory')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: expect.stringContaining('No router connection') } })
    expect(built).toBe(false)
  })

  test('a saved-but-incomplete connection (e.g. no password) is refused the same way, never handed to a driver', async () => {
    const { host, registered } = fakeHost({ baseUrl: '192.168.1.1', username: 'admin', password: '', tls: false, timeoutMs: 2000 })
    let built = false
    registerRouterRoutes(host, { createDriver: () => ((built = true), fakeDriver()) })
    const result = await registered.get('doctor')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toMatchObject({ body: { ok: false, code: 'E_ROUTER_NOT_CONFIGURED' } })
    expect(built).toBe(false)
  })
})

describe('registerRouterRoutes — inventory', () => {
  const routerKv = { baseUrl: '192.168.1.1', username: 'admin', password: 'x', tls: false, timeoutMs: 2000 }

  test('returns the driver’s inventory verbatim, wrapped in ok:true', async () => {
    const inv: RouterInventory = {
      paths: [{ id: 'via-modem1', table: 'via-modem1', gateway: '10.0.0.1', hasDefaultRoute: true, wanInterface: null }],
      interfaces: [],
      health: [{ pathId: 'via-modem1', up: true, checkedAt: 1000, link: 'ok', gateway: 'ok', egress: 'unknown' }],
      leases: [],
    }
    const { host, registered } = fakeHost(routerKv)
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ inventory: async () => inv }) })
    const result = await registered.get('inventory')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: { ok: true, inventory: inv } })
  })

  test('a thrown MikrotikRestError becomes a coded ok:false refusal, never a throw out of the handler', async () => {
    const { host, registered } = fakeHost(routerKv)
    registerRouterRoutes(host, {
      createDriver: () =>
        fakeDriver({
          inventory: async () => {
            throw new MikrotikRestError('network', 'could not reach the router')
          },
        }),
    })
    const result = await registered.get('inventory')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_ROUTER_NETWORK', message: 'could not reach the router' } })
  })

  test('a genuinely unexpected throw (not a MikrotikRestError) is still reported, never crashes the handler', async () => {
    const { host, registered } = fakeHost(routerKv)
    registerRouterRoutes(host, {
      createDriver: () =>
        fakeDriver({
          inventory: async () => {
            throw new Error('bug')
          },
        }),
    })
    const result = await registered.get('inventory')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_ROUTER_UNKNOWN', message: 'bug' } })
  })
})

describe('registerRouterRoutes — rules, classified via parseMarker (§4.2)', () => {
  const routerKv = { baseUrl: '192.168.1.1', username: 'admin', password: 'x', tls: false, timeoutMs: 2000 }

  test('a well-formed managed rule, a foreign rule, and the local-exception rule are all classified correctly', async () => {
    const rules: RouterRule[] = [
      fakeRule({ '.id': '*1', comment: 'enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.215', 'src-address': '192.168.10.215/32', table: 'via-modem1' }),
      fakeRule({ '.id': '*2', comment: 'hand-added by an operator' }),
      fakeRule({ '.id': '*3', comment: LOCAL_EXCEPTION_COMMENT }),
    ]
    const { host, registered } = fakeHost(routerKv)
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ listRules: async () => rules }) })
    const result = (await registered.get('rules')?.handler(FAKE_REQUEST, new AbortController().signal)) as { body: { ok: true; items: unknown[] } }
    expect(result.body.ok).toBe(true)
    const items = result.body.items as ReturnType<typeof toRuleRow>[]
    expect(items).toHaveLength(3)

    const managed = items.find((r) => r.id === '*1')
    expect(managed?.managed).toBe(true)
    expect(managed?.marker).toEqual({ groupId: 'jadwal-1', endpointKey: '192.168.10.215' })
    expect(managed?.markerIssue).toBeNull()

    const foreign = items.find((r) => r.id === '*2')
    expect(foreign?.managed).toBe(false)
    expect(foreign?.marker).toBeNull()
    expect(foreign?.isLocalException).toBe(false)

    const exception = items.find((r) => r.id === '*3')
    expect(exception?.managed).toBe(false)
    expect(exception?.isLocalException).toBe(true)
  })

  test('a managed-but-malformed marker stays managed:true with a markerIssue, never reclassified as foreign (§4.2)', async () => {
    const rules: RouterRule[] = [fakeRule({ '.id': '*4', comment: 'enkaku:mikrotik-routing:v2:whatever' })]
    const { host, registered } = fakeHost(routerKv)
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ listRules: async () => rules }) })
    const result = (await registered.get('rules')?.handler(FAKE_REQUEST, new AbortController().signal)) as { body: { ok: true; items: ReturnType<typeof toRuleRow>[] } }
    expect(result.body.items[0]?.managed).toBe(true)
    expect(result.body.items[0]?.marker).toBeNull()
    expect(result.body.items[0]?.markerIssue).toContain('v2')
  })
})

describe('registerRouterRoutes — doctor (§5 step 122.12: local-exception is now composed here, per device, not inside the driver)', () => {
  const routerKv = { baseUrl: '192.168.1.1', username: 'admin', password: 'x', tls: false, timeoutMs: 2000 }
  const okCoreAddress: CoreAddressResult = { kind: 'derived', address: '10.0.0.5' }

  test('composes the driver report with a localException computed from device.list + the derived core address', async () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([
      { '.id': '*1', action: 'lookup', table: 'main', comment: 'x', 'src-address': '10.0.0.0/8', 'dst-address': '10.0.0.0/8', disabled: false, inactive: false },
    ])
    const report = okDoctorReport({ rules })
    const { host, registered } = fakeHost(routerKv, [makeDevice('d1', '10.0.0.20')])
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ doctor: async () => report }), deriveCoreAddress: async () => okCoreAddress })
    const result = (await registered.get('doctor')?.handler(FAKE_REQUEST, new AbortController().signal)) as {
      body: { ok: true; localException: { status: string; coreAddress: CoreAddressResult } }
    }
    expect(result.body.ok).toBe(true)
    expect(result.body.localException.status).toBe('ok')
    expect(result.body.localException.coreAddress).toEqual(okCoreAddress)
  })

  test('a device on adb-tcp NOT covered by the router\'s rule is named as uncovered — status partial, never silently ok', async () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([
      { '.id': '*1', action: 'lookup', table: 'main', comment: 'proxy: local exception', 'src-address': '192.168.50.0/24', 'dst-address': '192.168.0.0/16', disabled: false, inactive: false },
    ])
    const report = okDoctorReport({ rules })
    const { host, registered } = fakeHost(routerKv, [makeDevice('flip4-01', '192.168.10.15')])
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ doctor: async () => report }), deriveCoreAddress: async () => ({ kind: 'derived', address: '192.168.50.10' }) })
    const result = (await registered.get('doctor')?.handler(FAKE_REQUEST, new AbortController().signal)) as {
      body: { ok: true; localException: { status: string; uncoveredDevices: { id: string }[] } }
    }
    expect(result.body.localException.status).toBe('partial')
    expect(result.body.localException.uncoveredDevices.map((d) => d.id)).toEqual(['flip4-01'])
  })

  /**
   * Plan 124 §4.4 Group G. `local-exception.ts`'s own `describeUncovered`
   * records why this matters in the owner's own words: the farm printed
   * "SM-F721U1, SM-F721U1, SM-F721U1" into the Uncovered sentence. The
   * address it already appends says which rule must cover the device; the
   * number says which phone on the rack it is. Both are asserted here, along
   * with criterion 7 — a device with no number gets its bare label, never
   * `#null`.
   */
  test('an uncovered device is NAMED with its number beside its label, and a numberless one is not', async () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([
      { '.id': '*1', action: 'lookup', table: 'main', comment: 'proxy: local exception', 'src-address': '192.168.50.0/24', 'dst-address': '192.168.0.0/16', disabled: false, inactive: false },
    ])
    const report = okDoctorReport({ rules })
    const devices = [makeDevice('flip4-01', '192.168.10.15', { label: 'SM-F721U1', number: 7 }), makeDevice('flip4-02', '192.168.10.16', { label: 'SM-F721U1' })]
    const { host, registered } = fakeHost(routerKv, devices)
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ doctor: async () => report }), deriveCoreAddress: async () => ({ kind: 'derived', address: '192.168.50.10' }) })
    const result = (await registered.get('doctor')?.handler(FAKE_REQUEST, new AbortController().signal)) as {
      body: { ok: true; localException: { status: string; message: string; uncoveredDevices: { label: string }[] } }
    }
    expect(result.body.localException.uncoveredDevices.map((d) => d.label)).toEqual(['#7 SM-F721U1', 'SM-F721U1'])
    // And the composed sentence an operator actually reads, addresses intact.
    expect(result.body.localException.message).toContain('#7 SM-F721U1 (192.168.10.15)')
  })

  test('a USB device with no derivable address is excluded from the check entirely, never guessed at', async () => {
    const rules: RouterRule[] = RouterRuleListSchema.parse([
      { '.id': '*1', action: 'lookup', table: 'main', comment: 'x', 'src-address': '0.0.0.0/0', 'dst-address': '10.0.0.0/8', disabled: false, inactive: false },
    ])
    const report = okDoctorReport({ rules })
    const { host, registered } = fakeHost(routerKv, [makeDevice('usb-1', null)])
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ doctor: async () => report }), deriveCoreAddress: async () => okCoreAddress })
    const result = (await registered.get('doctor')?.handler(FAKE_REQUEST, new AbortController().signal)) as { body: { ok: true; localException: { status: string } } }
    // No devices with a known address at all ⇒ nothing to be uncovered ⇒ ok, not partial and not missing-because-of-the-USB-device.
    expect(result.body.localException.status).toBe('ok')
  })

  test('a device.list failure degrades to an empty device list plus an entry in `errors`, never a thrown handler', async () => {
    const report = okDoctorReport()
    const { registered } = fakeHost(routerKv)
    const host: HandlerHost = {
      storage: { global: { getRaw: async () => routerKv } },
      farm: {
        call: async () => {
          throw new Error('E_FORBIDDEN')
        },
      },
      onRequest: (id, handler, opts) => registered.set(id, { handler: handler as Registered['handler'], opts }),
    }
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ doctor: async () => report }), deriveCoreAddress: async () => okCoreAddress })
    const result = (await registered.get('doctor')?.handler(FAKE_REQUEST, new AbortController().signal)) as { body: { ok: true; errors: string[]; localException: { status: string } } }
    expect(result.body.errors.join(' ')).toContain('E_FORBIDDEN')
    // `okDoctorReport()`'s default `rules: []` has no candidate rule at all,
    // independent of the device-list failure — `missing` here proves the
    // check still ran rather than silently no-oping when devices could not
    // be read.
    expect(result.body.localException.status).toBe('missing')
  })

  test('never throws even when the driver\'s own report carries errors — doctor() itself never throws, and neither does this composition', async () => {
    const report = okDoctorReport({ errors: ['could not read REST version'] })
    const { host, registered } = fakeHost(routerKv)
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ doctor: async () => report }), deriveCoreAddress: async () => okCoreAddress })
    const result = (await registered.get('doctor')?.handler(FAKE_REQUEST, new AbortController().signal)) as { body: { ok: true; errors: string[] } }
    expect(result.body.errors).toContain('could not read REST version')
  })
})

describe('toRuleRow', () => {
  test('carries srcAddress/table through as null when the router omitted them', () => {
    const row = toRuleRow(fakeRule({ comment: 'foreign' }))
    expect(row.srcAddress).toBeNull()
    expect(row.table).toBeNull()
  })
})

/**
 * Plan 134 (M99) §4.4 — the probe route. The property under test throughout is
 * the plan's one rule: **a probe that could not run is `unknown`, never
 * `fail`.** Reporting `fail` would blame a modem nobody managed to ask.
 */
describe('probe-egress route (plan 134 §4.4)', () => {
  const ROUTER = { baseUrl: '10.0.0.1', username: 'admin', password: 'pw', tls: false, timeoutMs: 2000 }
  const coreAddress: CoreAddressResult = { kind: 'derived', address: '10.0.0.5' }

  async function callProbe(driver: Partial<RouterDriver>, body: unknown) {
    const { host, registered } = fakeHost(ROUTER)
    registerRouterRoutes(host, { createDriver: () => fakeDriver(driver), deriveCoreAddress: async () => coreAddress })
    const handler = registered.get('probe-egress')
    if (!handler) throw new Error('probe-egress was not registered')
    return (await handler.handler({ ...FAKE_REQUEST, method: 'POST', body }, new AbortController().signal)) as { body: Record<string, unknown> }
  }

  test('a successful probe is reported with the driver\'s own message', async () => {
    const response = await callProbe({ probeEgress: async () => ({ status: 'ok', message: '3/3 replies', packetLoss: 0 }) }, { wanInterface: 'wan-modem24-s2p6' })
    expect(response.body).toEqual({ ok: true, probe: { status: 'ok', message: '3/3 replies', packetLoss: 0 } })
  })

  test('a modem that answers the router but has no upstream comes back `fail` — the #20 case', async () => {
    const response = await callProbe({ probeEgress: async () => ({ status: 'fail', message: 'nothing came back', packetLoss: 100 }) }, { wanInterface: 'wan-modem40-s2p22' })
    expect((response.body.probe as { status: string }).status).toBe('fail')
  })

  test('a router that cannot run the probe answers `unknown`, and the route passes that through unchanged', async () => {
    const response = await callProbe({ probeEgress: async () => ({ status: 'unknown', message: 'this router does not serve /rest/ping' }) }, { wanInterface: 'wan-modem24-s2p6' })
    expect((response.body.probe as { status: string }).status).toBe('unknown')
    expect(response.body.ok).toBe(true)
  })

  test('a driver that breaks its never-throw contract degrades to a refusal, not a 500', async () => {
    const response = await callProbe(
      {
        probeEgress: async () => {
          throw new Error('boom')
        },
      },
      { wanInterface: 'wan-modem24-s2p6' },
    )
    expect(response.body.ok).toBe(false)
  })

  test('a request with no interface is refused rather than probing something guessed', async () => {
    const response = await callProbe({}, { wanInterface: '' })
    expect(response.body).toMatchObject({ ok: false, code: 'E_BAD_INPUT' })
  })

  test("the operator's target reaches the driver verbatim; omitting it leaves the default to the driver", async () => {
    const seen: [string, string | undefined][] = []
    const record: RouterDriver['probeEgress'] = async (iface, target) => {
      seen.push([iface, target])
      return { status: 'ok', message: 'ok' }
    }

    await callProbe({ probeEgress: record }, { wanInterface: 'wan-modem24-s2p6', target: '1.1.1.1' })
    await callProbe({ probeEgress: record }, { wanInterface: 'wan-modem24-s2p6' })

    // The default target lives in ONE place — the driver's own
    // `DEFAULT_PROBE_TARGET`. The route must not invent a second copy of it.
    expect(seen).toEqual([
      ['wan-modem24-s2p6', '1.1.1.1'],
      ['wan-modem24-s2p6', undefined],
    ])
  })
})
