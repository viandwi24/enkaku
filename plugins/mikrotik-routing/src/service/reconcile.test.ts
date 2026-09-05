import { describe, expect, test } from 'bun:test'
import { DeviceInfoSchema, type DeviceInfo } from '@enkaku/protocol'
import { CONFIG_KEY, ROUTER_KEY, writeAssignment, type RouterConfig, type StoredAssignment } from '../shared'
import type { CoreAddressResult } from './core-address'
import type { Drift } from './drift'
import { groupKeyFor, writeGroup, type Group } from './groups'
import { serialiseMarker } from './marker'
import { computeReconcileTick, createReconcileLoop, describeDrift, driftSignature, type ReconcileHost, type ReconcileResult } from './reconcile'
import type { DesiredRule, RouterDriver, RouterInventory } from './router-driver'
import type { RouterRule } from './schemas'

/**
 * Plan 122 §5 step 122.9, `reconcile.ts` — drift classification wiring
 * (`classifyDrift` reused, including §3.5's `stale-owner`), the auto-repair
 * decision (missing-rule/wrong-path only, gated on §3.2), the newly-detected
 * notify dedup, and the self-rescheduling loop's overlap guard and teardown.
 * Service-level, against a fake `RouterDriver` and a fake `ReconcileHost` —
 * no real router, no real timer resolution beyond small real `setTimeout`s
 * for the loop-mechanics tests, mirroring `apply.test.ts`'s own shape.
 */

const ROUTER_CONFIG: RouterConfig = { baseUrl: '192.168.1.1', username: 'admin', password: 'x', tls: false, timeoutMs: 2000 }
const OK_CORE_ADDRESS: CoreAddressResult = { kind: 'derived', address: '10.0.0.5' }

function makeDevice(id: string, address: string, label?: string): DeviceInfo {
  return DeviceInfoSchema.parse({
    id,
    stableId: `stable-${id}`,
    serial: `${address}:5555`,
    label: label ?? id,
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
    connection: { kind: 'tcp', medium: 'wired', mediumSource: 'declared', address, port: 5555, networkLabel: null },
  })
}

function assignment(overrides: Partial<StoredAssignment> = {}): StoredAssignment {
  return { pathId: '', groupId: 'default', lanIp: '', lanIpSource: '', leaseKind: '', since: 0, ...overrides }
}

/** A local-exception rule covering any device address and the core address above, positioned first — so `classifyLocalException` reports `ok` (mirrors `apply.test.ts`'s own `protectingRule`). */
function protectingRule(): RouterRule {
  return { '.id': '*1', comment: 'farm: local exception', action: 'lookup', table: 'main', disabled: false, inactive: false, 'src-address': '0.0.0.0/0', 'dst-address': '10.0.0.0/8' }
}

/** One managed rule, comment built through the real `serialiseMarker` — never a hand-typed comment string. */
function managedRule(id: string, groupId: string, endpointKey: string, table: string, extra: Partial<RouterRule> = {}): RouterRule {
  const marker = serialiseMarker(groupId, endpointKey)
  if (!marker.ok) throw new Error(`bad fixture marker: ${marker.reason}`)
  return { '.id': id, comment: marker.comment, action: 'lookup-only-in-table', table, disabled: false, inactive: false, 'src-address': `${endpointKey}/32`, ...extra }
}

function emptyInventory(overrides: Partial<RouterInventory> = {}): RouterInventory {
  return { paths: [{ id: 'via-modem1', table: 'via-modem1', gateway: '10.0.0.1', hasDefaultRoute: true, wanInterface: null }], interfaces: [], health: [{ pathId: 'via-modem1', up: true, checkedAt: 1000, link: 'ok', gateway: 'ok', egress: 'unknown' }], leases: [], ...overrides }
}

interface DriverCalls {
  create: DesiredRule[]
  update: { id: string; patch: Partial<DesiredRule> }[]
  delete: string[]
}

function fakeDriver(overrides: Partial<RouterDriver> & { calls?: DriverCalls } = {}): RouterDriver & { calls: DriverCalls } {
  const calls: DriverCalls = overrides.calls ?? { create: [], update: [], delete: [] }
  return {
    inventory: async () => emptyInventory(),
    listRules: async () => [],
    doctor: async () => ({ reachable: true, authenticated: true, restVersion: null, rules: [], managedRuleCount: 0, foreignRuleCount: 0, errors: [] }),
    probeEgress: async () => ({ status: 'unknown' as const, message: 'not probed in this test' }),
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
    ...overrides,
    calls,
  }
}

interface HostState {
  routerKv: unknown
  configKv: unknown
  devices: DeviceInfo[]
  assignments: Record<string, unknown>
  groups: Record<string, unknown>
  notifyCalls: unknown[]
}

function emptyState(overrides: Partial<HostState> = {}): HostState {
  return { routerKv: ROUTER_CONFIG, configKv: undefined, devices: [], assignments: {}, groups: {}, notifyCalls: [], ...overrides }
}

function fakeHost(state: HostState): ReconcileHost {
  return {
    storage: {
      global: {
        getRaw: async (key: string) => {
          if (key === ROUTER_KEY) return state.routerKv
          if (key === CONFIG_KEY) return state.configKv
          return undefined
        },
        list: async (opts) => {
          const prefix = opts?.prefix ?? ''
          const items = Object.entries(state.groups)
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value }))
          return { items, nextCursor: null }
        },
      },
      forDevice: (deviceId: string) => ({
        getRaw: async () => state.assignments[deviceId],
      }),
    },
    farm: {
      call: async (id, input, schema) => {
        if (id === 'device.list') return schema.parse({ items: state.devices })
        if (id === 'notify.send') {
          state.notifyCalls.push(input)
          return schema.parse({ notificationId: `n${state.notifyCalls.length}`, delivered: [], failed: [] })
        }
        throw new Error(`fakeHost: unexpected capability call "${id}"`)
      },
    },
    log: { warn: () => {}, info: () => {} },
  }
}

function saveGroup(state: HostState, group: Group): void {
  state.groups[groupKeyFor(group.id)] = writeGroup(group)
}

function group(overrides: Partial<Group> = {}): Group {
  return { id: 'g1', name: 'G1', note: '', entries: [], active: true, onDeactivate: 'remove-rules', failoverPolicy: 'none', updatedAt: 0, ...overrides }
}

function driftOfKind<K extends Drift['kind']>(drifts: readonly Drift[], kind: K): Extract<Drift, { kind: K }> | undefined {
  return drifts.find((d): d is Extract<Drift, { kind: K }> => d.kind === kind)
}

// ---------------------------------------------------------------------------

describe('driftSignature', () => {
  const desired = { groupId: 'g1', endpointKey: '192.168.10.11', deviceId: 'd1', pathId: 'via-modem1' }

  test('never depends on a router rule’s own .id (§3.3: not stable across a reboot)', () => {
    const rule = managedRule('*1', 'g1', '192.168.10.11', 'via-modem2')
    const wrongPath: Drift = { kind: 'wrong-path', desired, rule, actualTable: 'via-modem2' }
    const sameDriftDifferentRuleId: Drift = { kind: 'wrong-path', desired, rule: { ...rule, '.id': '*999' }, actualTable: 'via-modem2' }
    expect(driftSignature(wrongPath)).toBe(driftSignature(sameDriftDifferentRuleId))
    const staleOwner: Drift = { kind: 'stale-owner', desired, rule }
    const staleOwnerOtherId: Drift = { kind: 'stale-owner', desired, rule: { ...rule, '.id': '*999' } }
    expect(driftSignature(staleOwner)).toBe(driftSignature(staleOwnerOtherId))
  })

  test('every kind produces a distinct signature for distinct inputs', () => {
    const rule = managedRule('*1', 'g1', '192.168.10.11', 'via-modem2')
    const items: Drift[] = [
      { kind: 'missing-rule', desired },
      { kind: 'wrong-path', desired, rule, actualTable: 'via-modem2' },
      { kind: 'path-missing', desired: { ...desired, pathId: 'ghost' } },
      { kind: 'stale-owner', desired, rule },
      { kind: 'duplicate', endpointKey: '192.168.10.11', rules: [rule, { ...rule, '.id': '*2' }] },
      { kind: 'unexpected-managed-rule', rule, groupId: 'g1', endpointKey: '192.168.10.11' },
    ]
    const signatures = items.map(driftSignature)
    expect(new Set(signatures).size).toBe(signatures.length)
  })

  test('an unparseable-marker orphan signs by comment text, not by .id', () => {
    const rule: RouterRule = { '.id': '*1', comment: 'enkaku:mikrotik-routing:v2:whatever', action: 'lookup-only-in-table', table: 't', disabled: false, inactive: false }
    const a: Drift = { kind: 'unexpected-managed-rule', rule, groupId: null, endpointKey: null }
    const b: Drift = { kind: 'unexpected-managed-rule', rule: { ...rule, '.id': '*2' }, groupId: null, endpointKey: null }
    expect(driftSignature(a)).toBe(driftSignature(b))
  })
})

describe('describeDrift', () => {
  const labelOf = (id: string): string => `Device ${id}`

  test('every kind produces a non-empty, operator-facing line naming the device label where relevant', () => {
    const desired = { groupId: 'g1', endpointKey: '192.168.10.11', deviceId: 'd1', pathId: 'via-modem1' }
    const rule = managedRule('*1', 'g1', '192.168.10.11', 'via-modem2')
    const items: Drift[] = [
      { kind: 'missing-rule', desired },
      { kind: 'wrong-path', desired, rule, actualTable: 'via-modem2' },
      { kind: 'path-missing', desired },
      { kind: 'stale-owner', desired, rule },
      { kind: 'duplicate', endpointKey: '192.168.10.11', rules: [rule] },
      { kind: 'unexpected-managed-rule', rule, groupId: null, endpointKey: null },
    ]
    for (const d of items) {
      const line = describeDrift(d, labelOf)
      expect(line.length).toBeGreaterThan(0)
    }
    expect(describeDrift(items[0]!, labelOf)).toContain('Device d1')
  })
})

describe('computeReconcileTick — configuration and no-drift baseline', () => {
  test('no router saved → E_ROUTER_NOT_CONFIGURED, never reaches the farm', async () => {
    const host = fakeHost(emptyState({ routerKv: null }))
    const result = await computeReconcileTick(host, { createDriver: () => fakeDriver() })
    expect(result).toEqual({ ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: expect.stringContaining('No router connection') })
  })

  test('a fleet with nothing assigned and no managed rules produces zero drift', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const host = fakeHost(emptyState({ devices }))
    const result = await computeReconcileTick(host, { createDriver: () => fakeDriver({ listRules: async () => [protectingRule()] }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.drifts).toEqual([])
    expect(result.localException.status).toBe('ok')
  })
})

describe('computeReconcileTick — the six drift classes, via classifyDrift (never reimplemented here)', () => {
  test('missing-rule: an assigned device with no router rule at all', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const host = fakeHost(emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } }))
    const result = await computeReconcileTick(host, { createDriver: () => fakeDriver({ listRules: async () => [protectingRule()] }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const d = driftOfKind(result.drifts, 'missing-rule')
    expect(d?.desired.deviceId).toBe('d1')
  })

  test('wrong-path: a managed rule exists but points at a different table', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const rules = [protectingRule(), managedRule('*5', 'default', '192.168.10.11', 'via-modem-old')]
    const host = fakeHost(emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } }))
    const result = await computeReconcileTick(host, {
      createDriver: () => fakeDriver({ listRules: async () => rules, inventory: async () => emptyInventory({ paths: [{ id: 'via-modem1', table: 'via-modem1', gateway: null, hasDefaultRoute: true, wanInterface: null }, { id: 'via-modem-old', table: 'via-modem-old', gateway: null, hasDefaultRoute: true, wanInterface: null }] }) }),
      deriveCoreAddress: async () => OK_CORE_ADDRESS,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const d = driftOfKind(result.drifts, 'wrong-path')
    expect(d?.actualTable).toBe('via-modem-old')
    expect(d?.desired.pathId).toBe('via-modem1')
  })

  test('path-missing: the assigned path no longer exists on the router', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const host = fakeHost(emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem-ghost' })) } }))
    const result = await computeReconcileTick(host, { createDriver: () => fakeDriver({ listRules: async () => [protectingRule()] }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const d = driftOfKind(result.drifts, 'path-missing')
    expect(d?.desired.pathId).toBe('via-modem-ghost')
  })

  test('duplicate: two managed rules share one endpoint — reported, never a guess at which to keep', async () => {
    const rules = [protectingRule(), managedRule('*5', 'default', '192.168.10.20', 'via-modem1'), managedRule('*6', 'default', '192.168.10.20', 'via-modem2')]
    const host = fakeHost(emptyState({ devices: [] }))
    const result = await computeReconcileTick(host, { createDriver: () => fakeDriver({ listRules: async () => rules }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const d = driftOfKind(result.drifts, 'duplicate')
    expect(d?.endpointKey).toBe('192.168.10.20')
    expect(d?.rules).toHaveLength(2)
  })

  test('unexpected-managed-rule: a managed rule with no claiming assignment at all — an orphan', async () => {
    const rules = [protectingRule(), managedRule('*5', 'default', '192.168.10.30', 'via-modem1')]
    const host = fakeHost(emptyState({ devices: [] }))
    const result = await computeReconcileTick(host, { createDriver: () => fakeDriver({ listRules: async () => rules }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const d = driftOfKind(result.drifts, 'unexpected-managed-rule')
    expect(d?.endpointKey).toBe('192.168.10.30')
  })

  test('stale-owner: a device blocked (gone from device.list) but still named in an ACTIVE group’s own entries, with a live rule', async () => {
    // §3.5: Block deletes the `devices` row (so `dGone` never appears in
    // `device.list`) but never touches `group:<id>` KV — the group's own
    // `entries` array is this file's only way to still see it.
    const state = emptyState({ devices: [] })
    saveGroup(state, group({ id: 'g1', active: true, entries: [{ deviceId: 'dGone', lanIp: '192.168.10.50', pathId: 'via-modem1' }] }))
    const rules = [protectingRule(), managedRule('*9', 'g1', '192.168.10.50', 'via-modem1')]
    const host = fakeHost(state)
    const result = await computeReconcileTick(host, { createDriver: () => fakeDriver({ listRules: async () => rules }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const d = driftOfKind(result.drifts, 'stale-owner')
    expect(d?.desired.deviceId).toBe('dGone')
    expect(d?.desired.groupId).toBe('g1')
  })

  test('a device still in the fleet is never mistaken for stale-owner even if it also appears, stale, in an active group’s entries', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const state = emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    // A stale copy of d1 in a group's entries at a DIFFERENT (old) address —
    // the live per-device read must win over the group's own memory.
    saveGroup(state, group({ id: 'g1', active: true, entries: [{ deviceId: 'd1', lanIp: '192.168.10.old', pathId: 'via-modem1' }] }))
    const rules = [protectingRule(), managedRule('*9', 'default', '192.168.10.11', 'via-modem1')]
    const host = fakeHost(state)
    const result = await computeReconcileTick(host, { createDriver: () => fakeDriver({ listRules: async () => rules }), deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driftOfKind(result.drifts, 'stale-owner')).toBeUndefined()
    expect(result.drifts).toEqual([])
  })
})

describe('computeReconcileTick — autoRepair, opt-in, missing-rule/wrong-path only', () => {
  test('autoRepair off (default): drift is reported, nothing is written', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const host = fakeHost(emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } }))
    const driver = fakeDriver({ listRules: async () => [protectingRule()] })
    const result = await computeReconcileTick(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driftOfKind(result.drifts, 'missing-rule')).toBeDefined()
    expect(result.autoRepaired).toEqual([])
    expect(driver.calls.create).toEqual([])
  })

  test('autoRepair on + local-exception ok: missing-rule is repaired via createRule', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const host = fakeHost(emptyState({ devices, configKv: { autoRepair: true }, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } }))
    const driver = fakeDriver({ listRules: async () => [protectingRule()] })
    const result = await computeReconcileTick(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.autoRepaired).toHaveLength(1)
    expect(result.autoRepaired[0]?.outcome).toBe('repaired')
    expect(driver.calls.create).toEqual([{ srcAddress: '192.168.10.11', table: 'via-modem1', comment: expect.stringContaining('default:192.168.10.11') }])
  })

  test('autoRepair on + wrong-path: repaired via updateRule, table/comment/disabled:false', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const rules = [protectingRule(), managedRule('*5', 'default', '192.168.10.11', 'via-modem-old')]
    const host = fakeHost(
      emptyState({
        devices,
        configKv: { autoRepair: true },
        assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) },
      }),
    )
    const driver = fakeDriver({
      listRules: async () => rules,
      inventory: async () => emptyInventory({ paths: [{ id: 'via-modem1', table: 'via-modem1', gateway: null, hasDefaultRoute: true, wanInterface: null }, { id: 'via-modem-old', table: 'via-modem-old', gateway: null, hasDefaultRoute: true, wanInterface: null }] }),
    })
    const result = await computeReconcileTick(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.autoRepaired).toHaveLength(1)
    expect(driver.calls.update).toEqual([{ id: '*5', patch: { table: 'via-modem1', comment: expect.stringContaining('default:192.168.10.11'), disabled: false } }])
  })

  test('autoRepair on + local-exception NOT ok: repair is skipped entirely, drift is still reported', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const host = fakeHost(emptyState({ devices, configKv: { autoRepair: true }, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } }))
    // No protecting rule at all → localException.status === 'missing'.
    const driver = fakeDriver({ listRules: async () => [] })
    const result = await computeReconcileTick(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.localException.status).not.toBe('ok')
    expect(driftOfKind(result.drifts, 'missing-rule')).toBeDefined()
    expect(result.autoRepaired).toEqual([])
    expect(driver.calls.create).toEqual([])
  })

  // The guard test CLAUDE.md's own rule asks for: prove auto-repair actually
  // NEVER touches the four kinds it must never touch, by constructing a tick
  // whose ONLY drift is one of them, with autoRepair on — if the repairable
  // filter were ever loosened to include these, this is exactly the test
  // that would catch it (each of these kinds lacks a `desired`/`pathId` pair
  // `repairOne` could even act on without producing nonsense, so a broken
  // filter would show up here as a wrong write, not just a missing one).
  test('autoRepair on: duplicate, unexpected-managed-rule, path-missing and stale-owner are NEVER auto-fixed', async () => {
    const state = emptyState({ devices: [], configKv: { autoRepair: true } })
    saveGroup(state, group({ id: 'g1', active: true, entries: [{ deviceId: 'dGone', lanIp: '192.168.10.50', pathId: 'via-modem1' }] }))
    const rules = [
      protectingRule(),
      managedRule('*10', 'default', '192.168.10.20', 'via-modem1'), // duplicate, half 1
      managedRule('*11', 'default', '192.168.10.20', 'via-modem2'), // duplicate, half 2
      managedRule('*12', 'default', '192.168.10.30', 'via-modem1'), // orphan — no claiming assignment
      managedRule('*13', 'g1', '192.168.10.50', 'via-modem1'), // stale-owner — dGone is blocked
    ]
    const host = fakeHost(state)
    const driver = fakeDriver({ listRules: async () => rules })
    const result = await computeReconcileTick(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driftOfKind(result.drifts, 'duplicate')).toBeDefined()
    expect(driftOfKind(result.drifts, 'unexpected-managed-rule')).toBeDefined()
    expect(driftOfKind(result.drifts, 'stale-owner')).toBeDefined()
    expect(result.autoRepaired).toEqual([])
    expect(driver.calls.create).toEqual([])
    expect(driver.calls.update).toEqual([])
    expect(driver.calls.delete).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The loop — overlap prevention, teardown, and notify dedup.
// ---------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('createReconcileLoop — overlap prevention', () => {
  test('reconcileNow() called twice before the first settles returns the SAME promise, and the driver is only asked once', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const host = fakeHost(emptyState({ devices }))
    const gate = deferred<void>()
    let listRulesCalls = 0
    const driver = fakeDriver({
      listRules: async () => {
        listRulesCalls += 1
        await gate.promise
        return [protectingRule()]
      },
    })
    const loop = createReconcileLoop(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS, intervalMsOverride: 5 })

    const p1 = loop.reconcileNow()
    const p2 = loop.reconcileNow()
    expect(p1).toBe(p2) // single-flight, checked before anything has had a chance to settle

    // Let the pending microtasks (loadRouterConfig's read, the config read,
    // then the Promise.all that invokes the driver) actually run up to the
    // point where `listRules` blocks on the gate — a few turns of the event
    // loop, not real time.
    await wait(0)
    expect(listRulesCalls).toBe(1) // only ONE call reached the driver, for both reconcileNow() calls combined

    gate.resolve()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(r1.ok).toBe(true)
    expect(listRulesCalls).toBe(1)
  })

  test('a tick still in flight when the scheduled interval elapses does not start a second pass', async () => {
    const host = fakeHost(emptyState({ devices: [] }))
    const gate = deferred<void>()
    let listRulesCalls = 0
    const driver = fakeDriver({
      listRules: async () => {
        listRulesCalls += 1
        await gate.promise
        return [protectingRule()]
      },
    })
    const loop = createReconcileLoop(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS, intervalMsOverride: 5 })
    loop.start()

    // Several would-be 5ms intervals elapse while the first tick is stuck on
    // the gate — the SCHEDULE must not arm a second tick until the first has
    // settled (this file's own header, point 1: structural prevention).
    await wait(40)
    expect(listRulesCalls).toBe(1)

    gate.resolve()
    await wait(30)
    // Now that the first tick has settled and rescheduled, a second (and
    // possibly more, since ticks now resolve immediately) tick fires.
    expect(listRulesCalls).toBeGreaterThan(1)
    loop.stop()
  })
})

describe('createReconcileLoop — ctx.onStop wiring: the timer is cleared and does not fire afterward', () => {
  test('stop() called immediately after start() prevents the timer from ever arming', async () => {
    const host = fakeHost(emptyState({ devices: [] }))
    let listRulesCalls = 0
    const driver = fakeDriver({ listRules: async () => { listRulesCalls += 1; return [protectingRule()] } })
    const loop = createReconcileLoop(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS, intervalMsOverride: 5 })
    loop.start()
    loop.stop() // before the async interval read (`readIntervalMs`) has even resolved
    await wait(40)
    expect(listRulesCalls).toBe(0)
  })

  test('stop() after one or more ticks have already fired stops further ticks from firing', async () => {
    const host = fakeHost(emptyState({ devices: [] }))
    let listRulesCalls = 0
    const driver = fakeDriver({ listRules: async () => { listRulesCalls += 1; return [protectingRule()] } })
    const loop = createReconcileLoop(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS, intervalMsOverride: 5 })
    loop.start()
    await wait(25)
    const callsAtStop = listRulesCalls
    expect(callsAtStop).toBeGreaterThan(0)
    loop.stop()
    await wait(30)
    expect(listRulesCalls).toBe(callsAtStop)
  })
})

describe('createReconcileLoop — notify.send on newly-detected drift only', () => {
  test('standing drift across two ticks notifies once, not twice', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const state = emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const host = fakeHost(state)
    const driver = fakeDriver({ listRules: async () => [protectingRule()] })
    const loop = createReconcileLoop(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS, intervalMsOverride: 5 })

    const r1 = (await loop.reconcileNow()) as ReconcileResult & { ok: true }
    expect(r1.ok).toBe(true)
    expect(r1.newDrifts).toHaveLength(1)
    expect(state.notifyCalls).toHaveLength(1)

    const r2 = (await loop.reconcileNow()) as ReconcileResult & { ok: true }
    expect(r2.ok).toBe(true)
    expect(r2.drifts).toHaveLength(1) // the SAME drift is still standing
    expect(r2.newDrifts).toHaveLength(0) // but it is not "new" any more
    expect(state.notifyCalls).toHaveLength(1) // no second notification
  })

  test('a genuinely new drift item on a later tick notifies again, for only the new item', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const state = emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const host = fakeHost(state)
    const driver = fakeDriver({ listRules: async () => [protectingRule()] })
    const loop = createReconcileLoop(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS, intervalMsOverride: 5 })

    await loop.reconcileNow()
    expect(state.notifyCalls).toHaveLength(1)

    // A second device appears with its own missing-rule drift.
    state.devices.push(makeDevice('d2', '192.168.10.12'))
    state.assignments.d2 = writeAssignment(assignment({ pathId: 'via-modem1' }))

    const r3 = (await loop.reconcileNow()) as ReconcileResult & { ok: true }
    expect(r3.drifts).toHaveLength(2)
    expect(r3.newDrifts).toHaveLength(1)
    expect(r3.newDrifts[0]?.kind).toBe('missing-rule')
    if (r3.newDrifts[0]?.kind === 'missing-rule') expect(r3.newDrifts[0].desired.deviceId).toBe('d2')
    expect(state.notifyCalls).toHaveLength(2)
  })

  test('a drift item that disappears and later reappears is treated as newly-detected again', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const state = emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const host = fakeHost(state)
    let rules: RouterRule[] = [protectingRule()]
    const driver = fakeDriver({ listRules: async () => rules })
    const loop = createReconcileLoop(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS, intervalMsOverride: 5 })

    await loop.reconcileNow() // tick 1: missing-rule, notified
    expect(state.notifyCalls).toHaveLength(1)

    // "Fixed" by hand — the rule now exists.
    rules = [protectingRule(), managedRule('*7', 'default', '192.168.10.11', 'via-modem1')]
    const r2 = (await loop.reconcileNow()) as ReconcileResult & { ok: true }
    expect(r2.drifts).toHaveLength(0)
    expect(state.notifyCalls).toHaveLength(1) // nothing new to notify

    // Broken again by hand — the rule is removed.
    rules = [protectingRule()]
    const r3 = (await loop.reconcileNow()) as ReconcileResult & { ok: true }
    expect(r3.newDrifts).toHaveLength(1)
    expect(state.notifyCalls).toHaveLength(2) // notified again — it is new again
  })

  test('a tick that fails outright never touches the dedup memory — a transient failure does not erase standing drift', async () => {
    const devices = [makeDevice('d1', '192.168.10.11')]
    const state = emptyState({ devices, assignments: { d1: writeAssignment(assignment({ pathId: 'via-modem1' })) } })
    const host = fakeHost(state)
    let fail = false
    const driver = fakeDriver({
      listRules: async () => {
        if (fail) throw new Error('router unreachable')
        return [protectingRule()]
      },
    })
    const loop = createReconcileLoop(host, { createDriver: () => driver, deriveCoreAddress: async () => OK_CORE_ADDRESS, intervalMsOverride: 5 })

    await loop.reconcileNow() // notified once
    expect(state.notifyCalls).toHaveLength(1)

    fail = true
    const failed = await loop.reconcileNow()
    expect(failed.ok).toBe(false)

    fail = false
    const r3 = (await loop.reconcileNow()) as ReconcileResult & { ok: true }
    expect(r3.newDrifts).toHaveLength(0) // the SAME standing drift, not re-flagged as new
    expect(state.notifyCalls).toHaveLength(1)
  })
})
