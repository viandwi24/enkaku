import { describe, expect, test } from 'bun:test'
import { DeviceInfoSchema, type DeviceInfo } from '@enkaku/protocol'
import { writeAssignment, type RouterConfig, type StoredAssignment } from '../shared'
import { applyNow, loadFleet, previewPlan, type ApplyHost } from './apply'
import type { CoreAddressResult } from './core-address'
import { MikrotikRestError } from './errors'
import type { DesiredRule, RouterDriver, RouterInventory } from './router-driver'
import type { RouterRule } from './schemas'

/**
 * Plan 122 §5 step 122.6, apply.ts — the safety gate (§3.2, acceptance
 * criterion 1), resolve-before-write reuse (`buildPlan`), and the row→driver
 * translation. This is service-level, against a fake `RouterDriver` and a
 * fake `ApplyHost` — no real router, no real HTTP, mirroring
 * `handlers.test.ts`'s own shape.
 */

const ROUTER_CONFIG: RouterConfig = { baseUrl: '192.168.1.1', username: 'admin', password: 'x', tls: false, timeoutMs: 2000 }

function makeDevice(id: string, address: string | null, extra: Partial<{ label: string }> = {}): DeviceInfo {
  return DeviceInfoSchema.parse({
    id,
    stableId: `stable-${id}`,
    serial: address ? `${address}:5555` : 'usbserial-1',
    label: extra.label ?? id,
    androidVersion: null,
    apiLevel: null,
    screenW: null,
    screenH: null,
    density: null,
    status: 'idle',
    lastSeen: null,
    connection: address
      ? { kind: 'tcp', medium: 'wired', mediumSource: 'declared', address, port: 5555, networkLabel: null }
      : { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
  })
}

function emptyInventory(overrides: Partial<RouterInventory> = {}): RouterInventory {
  return { paths: [{ id: 'via-modem1', table: 'via-modem1', gateway: '10.0.0.1', hasDefaultRoute: true }], interfaces: [], health: [{ pathId: 'via-modem1', up: true, checkedAt: 1000 }], leases: [], ...overrides }
}

interface DriverCalls {
  create: DesiredRule[]
  update: { id: string; patch: Partial<DesiredRule> }[]
  delete: string[]
}

function fakeDriver(overrides: Partial<RouterDriver> = {}): RouterDriver & { calls: DriverCalls } {
  const calls: DriverCalls = { create: [], update: [], delete: [] }
  return {
    inventory: async () => emptyInventory(),
    listRules: async () => [],
    doctor: async () => ({ reachable: true, authenticated: true, restVersion: null, rules: [], managedRuleCount: 0, foreignRuleCount: 0, errors: [] }),
    createRule: async (rule) => {
      calls.create.push(rule)
      return { id: '*100' }
    },
    updateRule: async (id, patch) => {
      calls.update.push({ id, patch })
    },
    deleteRule: async (id) => {
      calls.delete.push(id)
    },
    calls,
    ...overrides,
  }
}

function fakeHost(opts: { routerKv?: unknown; devices?: DeviceInfo[]; assignments?: Record<string, unknown> } = {}): { host: ApplyHost; forDeviceCalls: string[] } {
  const forDeviceCalls: string[] = []
  const assignmentsByDeviceId = opts.assignments ?? {}
  const host: ApplyHost = {
    storage: {
      global: { getRaw: async () => opts.routerKv },
      forDevice: (deviceId: string) => {
        forDeviceCalls.push(deviceId)
        return { getRaw: async () => assignmentsByDeviceId[deviceId] }
      },
    },
    farm: { call: async (_id, _input, schema) => schema.parse({ items: opts.devices ?? [] }) },
    log: { warn: () => {} },
  }
  return { host, forDeviceCalls }
}

function assignment(overrides: Partial<StoredAssignment> = {}): StoredAssignment {
  return { pathId: '', groupId: 'default', lanIp: '', lanIpSource: '', leaseKind: '', since: 0, ...overrides }
}

const OK_CORE_ADDRESS: CoreAddressResult = { kind: 'derived', address: '10.0.0.5' }

/** A local-exception rule covering any device address and the core address above, positioned first — so `classifyLocalException` reports `ok`. */
function protectingRule(): RouterRule {
  return { '.id': '*1', comment: 'farm: local exception', action: 'lookup', table: 'main', disabled: false, inactive: false, 'src-address': '0.0.0.0/0', 'dst-address': '10.0.0.0/8' }
}

describe('loadFleet', () => {
  test('no router saved → ok:false, never reaches the farm', async () => {
    const { host } = fakeHost({ routerKv: null })
    const result = await loadFleet(host, { createDriver: () => fakeDriver() })
    expect(result).toEqual({ ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: expect.stringContaining('No router connection') })
  })

  test('joins every device to its resolved LAN address and its stored assignment', async () => {
    const devices = [makeDevice('d1', '192.168.10.215'), makeDevice('d2', null)]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const result = await loadFleet(host, { createDriver: () => fakeDriver() })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.fleet.devices).toHaveLength(2)
    const d1 = result.fleet.devices.find((d) => d.deviceId === 'd1')
    expect(d1?.lan).toMatchObject({ state: 'resolved', lanIp: '192.168.10.215' })
    expect(d1?.assignment.pathId).toBe('via-modem1')
    const d2 = result.fleet.devices.find((d) => d.deviceId === 'd2')
    expect(d2?.lan).toMatchObject({ state: 'needs-address' })
    expect(d2?.assignment.pathId).toBe('') // never written → EMPTY_ASSIGNMENT
  })

  test('a driver failure (e.g. unreachable router) degrades to a named refusal, never a throw', async () => {
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices: [] })
    const result = await loadFleet(host, {
      createDriver: () =>
        fakeDriver({
          inventory: async () => {
            throw new MikrotikRestError('network', 'could not reach the router')
          },
        }),
    })
    expect(result).toEqual({ ok: false, code: 'E_ROUTER_NETWORK', message: 'could not reach the router' })
  })
})

describe('previewPlan', () => {
  test('a device with no noted path produces no desired entry and no blocked entry', async () => {
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: {} })
    const result = await previewPlan(host, { createDriver: () => fakeDriver({ listRules: async () => [protectingRule()] }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // The local-exception rule itself is a real, unmanaged router rule and
    // legitimately shows up as `foreign` (never touched) — only kinds other
    // than `foreign` are asserted empty here.
    expect(result.rows.filter((r) => r.kind !== 'foreign')).toEqual([])
    expect(result.blocked).toEqual([])
  })

  test('a noted path on a needs-address device is named in `blocked`, never guessed into a plan row', async () => {
    const devices = [makeDevice('usb-1', null)]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { 'usb-1': writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const result = await previewPlan(host, { createDriver: () => fakeDriver({ listRules: async () => [protectingRule()] }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.rows.filter((r) => r.kind !== 'foreign')).toEqual([])
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0]).toMatchObject({ deviceId: 'usb-1' })
  })

  test('a resolved device with a noted path yields exactly one create row', async () => {
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const result = await previewPlan(host, { createDriver: () => fakeDriver({ listRules: async () => [protectingRule()] }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.rows.filter((r) => r.kind !== 'foreign')).toEqual([{ kind: 'create', endpointKey: '192.168.10.215', pathId: 'via-modem1', groupId: 'default', groupName: 'Default' }])
  })

  test('carries the localException report through untouched — a preview never blocks itself on it', async () => {
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: {} })
    // No protecting rule at all — status should read `missing`, and the
    // preview must still return the (empty) plan rather than refusing.
    const result = await previewPlan(host, { createDriver: () => fakeDriver({ listRules: async () => [] }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.localException.status).toBe('missing')
  })
})

describe('applyNow — the safety gate (§3.2, acceptance criterion 1)', () => {
  test('refuses and calls NO write method while the local-exception check is `missing`', async () => {
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const driver = fakeDriver({ listRules: async () => [] }) // no protecting rule at all → missing
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('E_LOCAL_EXCEPTION_NOT_OK')
    expect(result.localException?.status).toBe('missing')
    expect(driver.calls).toEqual({ create: [], update: [], delete: [] })
  })

  test('refuses and calls NO write method while the local-exception check is `partial` — the dangerous state, not merely the missing one', async () => {
    const devices = [makeDevice('d1', '192.168.10.215'), makeDevice('d2', '192.168.20.9')]
    const { host } = fakeHost({
      routerKv: ROUTER_CONFIG,
      devices,
      assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })), d2: writeAssignment(assignment({ pathId: 'via-modem1' })) },
    })
    // Covers only d1's /32, not d2 — status must be `partial`, and apply must still refuse.
    const partialRule: RouterRule = { ...protectingRule(), 'src-address': '192.168.10.215/32' }
    const driver = fakeDriver({ listRules: async () => [partialRule] })
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.localException?.status).toBe('partial')
    expect(driver.calls).toEqual({ create: [], update: [], delete: [] })
  })
})

describe('applyNow — executing the plan once the gate is `ok`', () => {
  test('a brand-new desired assignment becomes exactly one createRule call, with the marker comment and the bare (no /32) address', async () => {
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const driver = fakeDriver({ listRules: async () => [protectingRule()] })
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driver.calls.create).toEqual([{ srcAddress: '192.168.10.215', table: 'via-modem1', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.215' }])
    expect(driver.calls.update).toEqual([])
    expect(driver.calls.delete).toEqual([])
    const createRow = result.rows[0]
    if (!createRow) throw new Error('expected a create row')
    expect(result.outcomes).toEqual([{ row: createRow, outcome: 'applied' }])
  })

  test('an existing managed rule pointing at a different path becomes exactly one updateRule call, carrying the FRESH marker comment', async () => {
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem9' })) } })
    const existing: RouterRule = { '.id': '*6', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.215', 'src-address': '192.168.10.215', table: 'via-modem1', disabled: false, inactive: false }
    const driver = fakeDriver({ listRules: async () => [protectingRule(), existing], inventory: async () => emptyInventory({ paths: [{ id: 'via-modem9', table: 'via-modem9', gateway: null, hasDefaultRoute: true }], health: [{ pathId: 'via-modem9', up: true, checkedAt: 1 }] }) })
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driver.calls.create).toEqual([])
    expect(driver.calls.update).toEqual([{ id: '*6', patch: { table: 'via-modem9', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.215' } }])
    expect(driver.calls.delete).toEqual([])
  })

  test('a managed rule for an endpoint no longer noted becomes exactly one deleteRule call', async () => {
    const devices: DeviceInfo[] = [] // the device that used to own this rule is gone from the fleet entirely
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: {} })
    const stale: RouterRule = { '.id': '*7', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.219', 'src-address': '192.168.10.219', table: 'via-modem4', disabled: false, inactive: false }
    const driver = fakeDriver({ listRules: async () => [protectingRule(), stale] })
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driver.calls.delete).toEqual(['*7'])
    expect(driver.calls.create).toEqual([])
    expect(driver.calls.update).toEqual([])
  })

  test('a foreign rule at the same address a device is noted for is NEVER created over, updated, or deleted (acceptance criterion 2)', async () => {
    const devices = [makeDevice('d1', '192.168.10.220')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const foreign: RouterRule = { '.id': '*9', comment: 'operator: static route for the printer', 'src-address': '192.168.10.220', table: 'via-modem9', disabled: false, inactive: false }
    const driver = fakeDriver({ listRules: async () => [protectingRule(), foreign] })
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // The desired entry still resolves to `create` (the foreign rule never counts — resolve.ts's own rule),
    // and the foreign rule itself is never touched.
    expect(driver.calls.create).toEqual([{ srcAddress: '192.168.10.220', table: 'via-modem1', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.220' }])
    expect(driver.calls.update).toEqual([])
    expect(driver.calls.delete).toEqual([])
  })

  test('two managed rules for one endpoint (duplicate drift) are never written to — skipped, never guessed at (§4.3, criterion 3)', async () => {
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const dup1: RouterRule = { '.id': '*3', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.215', 'src-address': '192.168.10.215', table: 'via-modem1', disabled: false, inactive: false }
    const dup2: RouterRule = { '.id': '*4', comment: 'enkaku:mikrotik-routing:v1:default:192.168.10.215', 'src-address': '192.168.10.215', table: 'via-modem2', disabled: false, inactive: false }
    const driver = fakeDriver({ listRules: async () => [protectingRule(), dup1, dup2] })
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driver.calls).toEqual({ create: [], update: [], delete: [] })
    expect(result.rows.find((r) => r.kind === 'skip' && 'reason' in r && r.reason === 'duplicate')).toBeDefined()
  })

  test('a path that is down yields a skip row and is never written silently (§4.5)', async () => {
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const driver = fakeDriver({ listRules: async () => [protectingRule()], inventory: async () => emptyInventory({ health: [{ pathId: 'via-modem1', up: false, checkedAt: 1 }] }) })
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driver.calls).toEqual({ create: [], update: [], delete: [] })
    expect(result.rows.filter((r) => r.kind !== 'foreign')).toEqual([{ kind: 'skip', endpointKey: '192.168.10.215', pathId: 'via-modem1', groupId: 'default', groupName: 'Default', reason: 'path-down' }])
  })

  test('one failing write is reported as an error outcome and does not abort the remaining rows', async () => {
    const devices = [makeDevice('d1', '192.168.10.215'), makeDevice('d2', '192.168.10.216')]
    const { host } = fakeHost({
      routerKv: ROUTER_CONFIG,
      devices,
      assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })), d2: writeAssignment(assignment({ pathId: 'via-modem1' })) },
    })
    let calls = 0
    const driver = fakeDriver({
      listRules: async () => [protectingRule()],
      createRule: async (rule) => {
        calls += 1
        if (rule.srcAddress === '192.168.10.215') throw new MikrotikRestError('http', 'the router refused this rule')
        return { id: '*200' }
      },
    })
    const result = await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(calls).toBe(2)
    const failed = result.outcomes.find((o) => o.row.kind === 'create' && 'endpointKey' in o.row && o.row.endpointKey === '192.168.10.215')
    const succeeded = result.outcomes.find((o) => o.row.kind === 'create' && 'endpointKey' in o.row && o.row.endpointKey === '192.168.10.216')
    expect(failed).toMatchObject({ outcome: 'error', message: 'the router refused this rule' })
    expect(succeeded).toMatchObject({ outcome: 'applied' })
  })

  test('never persists a router .id anywhere — ApplyHost’s device storage exposes only getRaw, never a write method', async () => {
    // The type of `ApplyHost.storage.forDevice(...)` declares only `getRaw` —
    // there is no `set`/`setIfVersion` in the interface at all, so nothing in
    // this file can write a router-derived id back to KV even if it tried.
    // This test exists to say that in code, not only in the type signature.
    const devices = [makeDevice('d1', '192.168.10.215')]
    const { host } = fakeHost({ routerKv: ROUTER_CONFIG, devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const driver = fakeDriver({ listRules: async () => [protectingRule()] })
    await applyNow(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(Object.keys(host.storage.forDevice('d1'))).toEqual(['getRaw'])
  })
})
