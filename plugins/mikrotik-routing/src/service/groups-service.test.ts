import { describe, expect, test } from 'bun:test'
import { DeviceInfoSchema, type DeviceInfo } from '@enkaku/protocol'
import { readAssignment, writeAssignment, type RouterConfig } from '../shared'
import { activateGroup, deactivateGroup, deleteGroup, previewActivateGroup, saveGroup, type GroupsHost } from './groups-service'
import { GROUP_KEY_PREFIX, groupKeyFor, readGroup, writeGroup, type Group } from './groups'
import type { CoreAddressResult } from './core-address'
import { serialiseMarker } from './marker'
import type { DesiredRule, RouterDriver, RouterInventory } from './router-driver'
import type { RouterRule } from './schemas'

/**
 * `groups-service.ts` — plan 122 §5 step 122.8. The five behaviours that
 * step's own test list names: activation writes exactly the group's rules
 * and nothing else; deactivation under each `onDeactivate` policy
 * removes/disables exactly its own rules and leaves foreign and other-group
 * rules untouched; a duplicate device in one group is refused at save time;
 * a conflicting activation without `force` refuses naming the overlap; with
 * `force` it deactivates the conflicting groups in the same operation.
 *
 * Service-level, against a fake `RouterDriver` and a fake `GroupsHost` (an
 * in-memory KV) — no real router, no real HTTP, mirroring `apply.test.ts`'s
 * own shape.
 */

const ROUTER_CONFIG: RouterConfig = { baseUrl: '192.168.1.1', username: 'admin', password: 'x', tls: false, timeoutMs: 2000 }
const OK_CORE_ADDRESS: CoreAddressResult = { kind: 'derived', address: '10.0.0.5' }

function marker(groupId: string, endpointKey: string): string {
  const m = serialiseMarker(groupId, endpointKey)
  if (!m.ok) throw new Error('bad test fixture marker')
  return m.comment
}

function protectingRule(): RouterRule {
  return { '.id': '*1', comment: 'farm: local exception', action: 'lookup', table: 'main', disabled: false, inactive: false, 'src-address': '0.0.0.0/0', 'dst-address': '10.0.0.0/8' }
}

function makeDevice(id: string, address: string): DeviceInfo {
  return DeviceInfoSchema.parse({
    id,
    stableId: `stable-${id}`,
    serial: `${address}:5555`,
    label: id,
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

function emptyInventory(overrides: Partial<RouterInventory> = {}): RouterInventory {
  return {
    paths: [
      { id: 'via-modem1', table: 'via-modem1', gateway: '10.0.0.1', hasDefaultRoute: true, wanInterface: null },
      { id: 'via-modem2', table: 'via-modem2', gateway: '10.0.0.2', hasDefaultRoute: true, wanInterface: null },
    ],
    interfaces: [],
    health: [
      { pathId: 'via-modem1', up: true, checkedAt: 1, link: 'ok', gateway: 'ok', egress: 'unknown' },
      { pathId: 'via-modem2', up: true, checkedAt: 1, link: 'ok', gateway: 'ok', egress: 'unknown' },
    ],
    leases: [],
    ...overrides,
  }
}

interface DriverCalls {
  create: DesiredRule[]
  update: { id: string; patch: Partial<DesiredRule> }[]
  delete: string[]
}

/** A fake `RouterDriver` that actually keeps its rule list in sync with create/update/delete — needed here (unlike `apply.test.ts`'s fake) because a group test activates, then deactivates, and later assertions must see the router's OWN resulting state, not just the calls made to reach it. */
function fakeDriver(initialRules: RouterRule[]): RouterDriver & { calls: DriverCalls } {
  const calls: DriverCalls = { create: [], update: [], delete: [] }
  let rules = [...initialRules]
  let nextId = 100
  return {
    inventory: async () => emptyInventory(),
    listRules: async () => rules,
    doctor: async () => ({ reachable: true, authenticated: true, restVersion: null, rules, managedRuleCount: 0, foreignRuleCount: 0, errors: [] }),
    probeEgress: async () => ({ status: 'unknown' as const, message: 'not probed in this test' }),
    createRule: async (rule) => {
      calls.create.push(rule)
      const id = `*${nextId++}`
      rules = [...rules, { '.id': id, comment: rule.comment, action: 'lookup-only-in-table', table: rule.table, disabled: rule.disabled ?? false, inactive: false, 'src-address': `${rule.srcAddress}/32` }]
      return { id }
    },
    updateRule: async (id, patch) => {
      calls.update.push({ id, patch })
      rules = rules.map((r) =>
        r['.id'] === id
          ? { ...r, ...(patch.table !== undefined ? { table: patch.table } : {}), ...(patch.comment !== undefined ? { comment: patch.comment } : {}), ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}) }
          : r,
      )
    },
    deleteRule: async (id) => {
      calls.delete.push(id)
      rules = rules.filter((r) => r['.id'] !== id)
    },
    calls,
  }
}

function fakeHost(opts: { devices?: DeviceInfo[]; groups?: Group[] } = {}): GroupsHost {
  const globalStore = new Map<string, unknown>()
  globalStore.set('router', ROUTER_CONFIG)
  for (const g of opts.groups ?? []) globalStore.set(groupKeyFor(g.id), writeGroup(g))
  const deviceStore = new Map<string, Map<string, unknown>>()

  function deviceMap(id: string): Map<string, unknown> {
    let m = deviceStore.get(id)
    if (!m) {
      m = new Map()
      deviceStore.set(id, m)
    }
    return m
  }

  return {
    storage: {
      global: {
        getRaw: async (key) => (globalStore.has(key) ? globalStore.get(key) : null),
        set: async (key, value) => {
          globalStore.set(key, value)
          return { version: 1 }
        },
        list: async (listOpts) => {
          const prefix = listOpts?.prefix ?? ''
          const items = [...globalStore.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }))
          return { items, nextCursor: null }
        },
        delete: async (key) => globalStore.delete(key),
      },
      forDevice: (deviceId: string) => {
        const m = deviceMap(deviceId)
        return {
          getRaw: async (key) => (m.has(key) ? m.get(key) : null),
          set: async (key, value) => {
            m.set(key, value)
            return { version: 1 }
          },
          delete: async (key) => m.delete(key),
        }
      },
    },
    farm: { call: async (_id, _input, schema) => schema.parse({ items: opts.devices ?? [] }) },
    log: { warn: () => {} },
  }
}

function groupFixture(overrides: Partial<Group> = {}): Group {
  return { id: 'jadwal-1', name: 'Jadwal-1', note: '', entries: [], active: false, onDeactivate: 'remove-rules', failoverPolicy: 'none', updatedAt: 0, ...overrides }
}

const deps = { createDriver: (_: RouterConfig) => driverRef, deriveCoreAddress: async () => OK_CORE_ADDRESS }
// `driverRef` is assigned per-test right before use — `deps` above closes over
// a mutable binding so every test can supply its own fake driver without
// redeclaring the whole `deps` object.
let driverRef!: ReturnType<typeof fakeDriver>

describe('saveGroup — acceptance criterion 12', () => {
  test('a duplicate device inside one group is refused at save time, and nothing is written', async () => {
    const host = fakeHost()
    const result = await saveGroup(host, {
      id: '',
      name: 'Jadwal-1',
      note: '',
      entries: [
        { deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' },
        { deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem2' },
      ],
      onDeactivate: 'remove-rules',
      failoverPolicy: 'none',
    })
    expect(result).toEqual({ ok: false, code: 'E_GROUP_DUPLICATE_DEVICE', message: expect.stringContaining('d1') })
    const raw = await host.storage.global.getRaw('group:jadwal-1')
    expect(raw).toBeNull()
  })

  test('a clean group is saved with a slug id minted from its name', async () => {
    const host = fakeHost()
    const result = await saveGroup(host, { id: '', name: 'Jadwal 1', note: '', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }], onDeactivate: 'remove-rules', failoverPolicy: 'none' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.group.id).toBe('jadwal-1')
    expect(result.group.active).toBe(false)
  })
})

describe('deleteGroup', () => {
  test('refuses to delete an active group', async () => {
    const host = fakeHost({ groups: [groupFixture({ active: true })] })
    const result = await deleteGroup(host, 'jadwal-1')
    expect(result).toEqual({ ok: false, code: 'E_GROUP_ACTIVE', message: expect.stringContaining('active') })
  })

  test('deletes an inactive group', async () => {
    const host = fakeHost({ groups: [groupFixture({ active: false })] })
    const result = await deleteGroup(host, 'jadwal-1')
    expect(result).toEqual({ ok: true })
    expect(await host.storage.global.getRaw('group:jadwal-1')).toBeNull()
  })
})

describe('activateGroup — writes exactly the group’s rules and nothing else', () => {
  test('a create for the group’s own device, and neither the foreign rule nor another active group’s rule are ever touched', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const d9 = makeDevice('d9', '192.168.10.240')
    const otherGroup = groupFixture({ id: 'jadwal-9', name: 'Jadwal-9', entries: [{ deviceId: 'd9', lanIp: '192.168.10.240', pathId: 'via-modem2' }], active: true })
    const candidate = groupFixture({ id: 'jadwal-1', name: 'Jadwal-1', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }] })

    const foreignRule: RouterRule = { '.id': '*5', comment: 'operator: static route', table: 'via-modem2', disabled: false, inactive: false, 'src-address': '192.168.10.230' }
    const otherGroupRule: RouterRule = { '.id': '*6', comment: marker('jadwal-9', '192.168.10.240'), table: 'via-modem2', disabled: false, inactive: false, 'src-address': '192.168.10.240' }

    const host = fakeHost({ devices: [d1, d9], groups: [otherGroup, candidate] })
    await host.storage.forDevice('d9').set('assignment', writeAssignment({ pathId: 'via-modem2', groupId: 'jadwal-9', lanIp: '192.168.10.240', lanIpSource: 'manual', leaseKind: '', since: 0 }))

    driverRef = fakeDriver([protectingRule(), foreignRule, otherGroupRule])
    const result = await activateGroup(host, 'jadwal-1', false, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driverRef.calls.create).toEqual([{ srcAddress: '192.168.10.215', table: 'via-modem1', comment: marker('jadwal-1', '192.168.10.215') }])
    expect(driverRef.calls.update).toEqual([])
    expect(driverRef.calls.delete).toEqual([])

    // The candidate is marked active, and d1's own assignment note now
    // reflects it.
    const saved = readGroup('jadwal-1', await host.storage.global.getRaw('group:jadwal-1'))
    expect(saved.active).toBe(true)
    const d1Assignment = readAssignment(await host.storage.forDevice('d1').getRaw('assignment'))
    expect(d1Assignment).toMatchObject({ pathId: 'via-modem1', groupId: 'jadwal-1' })

    // Neither the foreign rule nor the other active group's rule were touched.
    const finalRules = await driverRef.listRules()
    expect(finalRules.find((r) => r['.id'] === '*5')).toEqual(foreignRule)
    expect(finalRules.find((r) => r['.id'] === '*6')).toEqual(otherGroupRule)
  })

  test('refused while the local-exception check is not ok — zero driver calls', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const candidate = groupFixture({ entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }] })
    const host = fakeHost({ devices: [d1], groups: [candidate] })
    driverRef = fakeDriver([]) // no local-exception rule at all — 'missing'

    const result = await activateGroup(host, 'jadwal-1', false, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('E_LOCAL_EXCEPTION_NOT_OK')
    expect(driverRef.calls).toEqual({ create: [], update: [], delete: [] })
    const saved = readGroup('jadwal-1', await host.storage.global.getRaw('group:jadwal-1'))
    expect(saved.active).toBe(false)
  })
})

describe('activateGroup — conflict, no force', () => {
  test('refuses, naming the overlapping devices, and touches nothing', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const active = groupFixture({ id: 'jadwal-1', name: 'Jadwal-1', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }], active: true })
    const candidate = groupFixture({ id: 'jadwal-2', name: 'Jadwal-2', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem2' }] })
    const host = fakeHost({ devices: [d1], groups: [active, candidate] })
    const existingRule: RouterRule = { '.id': '*7', comment: marker('jadwal-1', '192.168.10.215'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.215' }
    driverRef = fakeDriver([protectingRule(), existingRule])

    const result = await activateGroup(host, 'jadwal-2', false, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('E_GROUP_CONFLICT')
    expect(result.message).toContain('Jadwal-2')
    expect(result.message).toContain('Jadwal-1')
    expect(result.message).toContain('d1')
    if (!('conflicts' in result)) throw new Error('expected a conflicts array')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.overlappingDeviceIds).toEqual(['d1'])

    // Nothing was attempted — this is a refusal, not a partial apply.
    expect(driverRef.calls).toEqual({ create: [], update: [], delete: [] })
    const savedCandidate = readGroup('jadwal-2', await host.storage.global.getRaw('group:jadwal-2'))
    expect(savedCandidate.active).toBe(false)
    const savedActive = readGroup('jadwal-1', await host.storage.global.getRaw('group:jadwal-1'))
    expect(savedActive.active).toBe(true)
  })

  test('two groups with disjoint device sets can both be active — no conflict', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const d2 = makeDevice('d2', '192.168.10.216')
    const active = groupFixture({ id: 'jadwal-1', name: 'Jadwal-1', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }], active: true })
    const candidate = groupFixture({ id: 'jadwal-2', name: 'Jadwal-2', entries: [{ deviceId: 'd2', lanIp: '192.168.10.216', pathId: 'via-modem2' }] })
    const host = fakeHost({ devices: [d1, d2], groups: [active, candidate] })
    // The device-scoped `assignment` note is the actual source of truth
    // `applyNow` reads (`apply.ts`'s own header) — a previously-active
    // group's own activation would already have written this; seeded here
    // to match that.
    await host.storage.forDevice('d1').set('assignment', writeAssignment({ pathId: 'via-modem1', groupId: 'jadwal-1', lanIp: '192.168.10.215', lanIpSource: 'manual', leaseKind: '', since: 0 }))
    const existingRule: RouterRule = { '.id': '*7', comment: marker('jadwal-1', '192.168.10.215'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.215' }
    driverRef = fakeDriver([protectingRule(), existingRule])

    const result = await activateGroup(host, 'jadwal-2', false, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driverRef.calls.create).toEqual([{ srcAddress: '192.168.10.216', table: 'via-modem2', comment: marker('jadwal-2', '192.168.10.216') }])
    expect(driverRef.calls.update).toEqual([])
    expect(driverRef.calls.delete).toEqual([])
  })
})

describe('activateGroup — force, the same operation, no window with no assignment', () => {
  test('deactivates the whole conflicting group, but the OVERLAPPING device becomes exactly one update, never delete-then-create', async () => {
    const d1 = makeDevice('d1', '192.168.10.215') // overlaps
    const d2 = makeDevice('d2', '192.168.10.216') // only in jadwal-1, does not overlap
    const jadwal1 = groupFixture({
      id: 'jadwal-1',
      name: 'Jadwal-1',
      entries: [
        { deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' },
        { deviceId: 'd2', lanIp: '192.168.10.216', pathId: 'via-modem1' },
      ],
      active: true,
    })
    const jadwal2 = groupFixture({ id: 'jadwal-2', name: 'Jadwal-2', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem2' }] })
    const host = fakeHost({ devices: [d1, d2], groups: [jadwal1, jadwal2] })
    await host.storage.forDevice('d1').set('assignment', writeAssignment({ pathId: 'via-modem1', groupId: 'jadwal-1', lanIp: '192.168.10.215', lanIpSource: 'manual', leaseKind: '', since: 0 }))
    await host.storage.forDevice('d2').set('assignment', writeAssignment({ pathId: 'via-modem1', groupId: 'jadwal-1', lanIp: '192.168.10.216', lanIpSource: 'manual', leaseKind: '', since: 0 }))

    const d1Rule: RouterRule = { '.id': '*10', comment: marker('jadwal-1', '192.168.10.215'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.215' }
    const d2Rule: RouterRule = { '.id': '*11', comment: marker('jadwal-1', '192.168.10.216'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.216' }
    driverRef = fakeDriver([protectingRule(), d1Rule, d2Rule])

    const result = await activateGroup(host, 'jadwal-2', true, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // d2 (non-overlapping) — jadwal-1's own deactivation removed it outright.
    expect(driverRef.calls.delete).toEqual(['*11'])
    // d1 (overlapping) — ONE update on the SAME rule id, never a delete
    // followed by a separate create (§4.6: never a window with no
    // assignment at all).
    expect(driverRef.calls.update).toEqual([{ id: '*10', patch: { table: 'via-modem2', comment: marker('jadwal-2', '192.168.10.215'), disabled: false } }])
    expect(driverRef.calls.create).toEqual([])

    const finalRules = await driverRef.listRules()
    expect(finalRules.find((r) => r['.id'] === '*11')).toBeUndefined()
    expect(finalRules.find((r) => r['.id'] === '*10')).toMatchObject({ table: 'via-modem2', comment: marker('jadwal-2', '192.168.10.215') })

    const savedJadwal1 = readGroup('jadwal-1', await host.storage.global.getRaw('group:jadwal-1'))
    expect(savedJadwal1.active).toBe(false)
    const savedJadwal2 = readGroup('jadwal-2', await host.storage.global.getRaw('group:jadwal-2'))
    expect(savedJadwal2.active).toBe(true)

    // d2's own note was cleared by the deactivation; d1's now belongs to jadwal-2.
    expect(await host.storage.forDevice('d2').getRaw('assignment')).toBeNull()
    const d1Assignment = readAssignment(await host.storage.forDevice('d1').getRaw('assignment'))
    expect(d1Assignment).toMatchObject({ pathId: 'via-modem2', groupId: 'jadwal-2' })
  })
})

describe('previewActivateGroup — a true non-mutating preview (gap fix, 2026-08-21)', () => {
  test('clean activation: decision:clean, the candidate’s own create row, and ZERO driver calls / ZERO KV writes', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const candidate = groupFixture({ id: 'jadwal-1', name: 'Jadwal-1', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }] })
    const host = fakeHost({ devices: [d1], groups: [candidate] })
    driverRef = fakeDriver([protectingRule()])

    const result = await previewActivateGroup(host, 'jadwal-1', false, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.decision).toEqual({ kind: 'clean' })
    expect(result.plan.filter((r) => r.kind !== 'foreign')).toEqual([expect.objectContaining({ kind: 'create', endpointKey: '192.168.10.215', pathId: 'via-modem1' })])
    expect(result.localException.status).toBe('ok')

    // The proof this fix exists for: not one write method was called, and
    // nothing in KV moved — a preview really is a preview.
    expect(driverRef.calls).toEqual({ create: [], update: [], delete: [] })
    const saved = readGroup('jadwal-1', await host.storage.global.getRaw('group:jadwal-1'))
    expect(saved.active).toBe(false)
    expect(await host.storage.forDevice('d1').getRaw('assignment')).toBeNull()
  })

  test('surfaces the §3.2 local-exception block before anything is written, with zero driver calls', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const candidate = groupFixture({ entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }] })
    const host = fakeHost({ devices: [d1], groups: [candidate] })
    driverRef = fakeDriver([]) // no local-exception rule at all — 'missing'

    const result = await previewActivateGroup(host, 'jadwal-1', false, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.localException.status).toBe('missing')
    expect(driverRef.calls).toEqual({ create: [], update: [], delete: [] })
  })

  test('conflict, no force: decision:refuse names the overlap, and the plan shows what WOULD change — zero driver calls', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const active = groupFixture({ id: 'jadwal-1', name: 'Jadwal-1', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }], active: true })
    const candidate = groupFixture({ id: 'jadwal-2', name: 'Jadwal-2', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem2' }] })
    const host = fakeHost({ devices: [d1], groups: [active, candidate] })
    await host.storage.forDevice('d1').set('assignment', writeAssignment({ pathId: 'via-modem1', groupId: 'jadwal-1', lanIp: '192.168.10.215', lanIpSource: 'manual', leaseKind: '', since: 0 }))
    const existingRule: RouterRule = { '.id': '*7', comment: marker('jadwal-1', '192.168.10.215'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.215' }
    driverRef = fakeDriver([protectingRule(), existingRule])

    const result = await previewActivateGroup(host, 'jadwal-2', false, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    if (result.decision.kind !== 'refuse') throw new Error('expected a refuse decision')
    expect(result.decision.conflicts).toHaveLength(1)
    expect(result.decision.conflicts[0]?.group.id).toBe('jadwal-1')
    expect(result.decision.conflicts[0]?.overlappingDeviceIds).toEqual(['d1'])
    expect(result.plan.filter((r) => r.kind !== 'foreign')).toEqual([expect.objectContaining({ kind: 'update', endpointKey: '192.168.10.215', fromPathId: 'via-modem1', toPathId: 'via-modem2' })])

    expect(driverRef.calls).toEqual({ create: [], update: [], delete: [] })
    expect(readGroup('jadwal-2', await host.storage.global.getRaw('group:jadwal-2')).active).toBe(false)
  })

  test('force: decision:force names exactly which group/devices would be deactivated first, the overlapping device previews as one update — zero driver calls', async () => {
    const d1 = makeDevice('d1', '192.168.10.215') // overlaps
    const d2 = makeDevice('d2', '192.168.10.216') // only in jadwal-1, does not overlap
    const jadwal1 = groupFixture({
      id: 'jadwal-1',
      name: 'Jadwal-1',
      entries: [
        { deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' },
        { deviceId: 'd2', lanIp: '192.168.10.216', pathId: 'via-modem1' },
      ],
      active: true,
    })
    const jadwal2 = groupFixture({ id: 'jadwal-2', name: 'Jadwal-2', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem2' }] })
    const host = fakeHost({ devices: [d1, d2], groups: [jadwal1, jadwal2] })
    await host.storage.forDevice('d1').set('assignment', writeAssignment({ pathId: 'via-modem1', groupId: 'jadwal-1', lanIp: '192.168.10.215', lanIpSource: 'manual', leaseKind: '', since: 0 }))
    await host.storage.forDevice('d2').set('assignment', writeAssignment({ pathId: 'via-modem1', groupId: 'jadwal-1', lanIp: '192.168.10.216', lanIpSource: 'manual', leaseKind: '', since: 0 }))

    const d1Rule: RouterRule = { '.id': '*10', comment: marker('jadwal-1', '192.168.10.215'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.215' }
    const d2Rule: RouterRule = { '.id': '*11', comment: marker('jadwal-1', '192.168.10.216'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.216' }
    driverRef = fakeDriver([protectingRule(), d1Rule, d2Rule])

    const result = await previewActivateGroup(host, 'jadwal-2', true, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    if (result.decision.kind !== 'force') throw new Error('expected a force decision')
    expect(result.decision.toDeactivate).toHaveLength(1)
    expect(result.decision.toDeactivate[0]?.group.id).toBe('jadwal-1')
    expect(result.decision.toDeactivate[0]?.overlappingDeviceIds).toEqual(['d1'])

    // d1 (overlapping, already in the candidate's own entries) previews as
    // ONE update. d2 (non-overlapping) is NOT reflected as a delete here —
    // documented scope limit (this function's own header): only the
    // candidate's own entries are overridden, never a conflicting group's
    // OTHER devices, so this preview never becomes a second, parallel
    // multi-group plan simulation. `decision.toDeactivate` still names the
    // group so the operator knows jadwal-1 as a whole is affected.
    expect(result.plan.filter((r) => r.kind !== 'foreign')).toEqual([expect.objectContaining({ kind: 'update', endpointKey: '192.168.10.215', fromPathId: 'via-modem1', toPathId: 'via-modem2' })])

    // The proof this fix exists for, under the riskiest path (force, real
    // conflicts): not one write method was called.
    expect(driverRef.calls).toEqual({ create: [], update: [], delete: [] })
    expect(readGroup('jadwal-1', await host.storage.global.getRaw('group:jadwal-1')).active).toBe(true)
    expect(readGroup('jadwal-2', await host.storage.global.getRaw('group:jadwal-2')).active).toBe(false)
    expect(await host.storage.forDevice('d1').getRaw('assignment')).not.toBeNull()
    const d1Assignment = readAssignment(await host.storage.forDevice('d1').getRaw('assignment'))
    expect(d1Assignment).toMatchObject({ pathId: 'via-modem1', groupId: 'jadwal-1' }) // UNCHANGED — preview never writes
  })

  test('a duplicate device inside the group is refused, matching saveGroup’s own message, before any router read', async () => {
    const host = fakeHost({ groups: [groupFixture({ entries: [{ deviceId: 'd1', lanIp: '1.2.3.4', pathId: 'via-modem1' }] })] })
    // Hand-edit the stored row directly (bypassing saveGroup's own guard) to
    // simulate a row that reached this defensively, same as activateGroup's
    // own defensive check.
    await host.storage.global.set('group:jadwal-1', {
      id: 'jadwal-1',
      name: 'Jadwal-1',
      note: '',
      entries: [
        { deviceId: 'd1', lanIp: '1.2.3.4', pathId: 'via-modem1' },
        { deviceId: 'd1', lanIp: '1.2.3.4', pathId: 'via-modem2' },
      ],
      active: false,
      onDeactivate: 'remove-rules',
      failoverPolicy: 'none',
      updatedAt: 0,
    })
    const result = await previewActivateGroup(host, 'jadwal-1', false, deps)
    expect(result).toEqual({ ok: false, code: 'E_GROUP_DUPLICATE_DEVICE', message: expect.stringContaining('d1') })
  })
})

describe('deactivateGroup — onDeactivate policies, own rules only', () => {
  test('remove-rules (default) deletes exactly its own rule and clears its own assignment note, leaving a foreign rule and another group’s rule alone', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const group = groupFixture({ entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }], active: true, onDeactivate: 'remove-rules' })
    const host = fakeHost({ devices: [d1], groups: [group] })
    await host.storage.forDevice('d1').set('assignment', writeAssignment({ pathId: 'via-modem1', groupId: 'jadwal-1', lanIp: '192.168.10.215', lanIpSource: 'manual', leaseKind: '', since: 0 }))

    const ownRule: RouterRule = { '.id': '*20', comment: marker('jadwal-1', '192.168.10.215'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.215' }
    const foreignRule: RouterRule = { '.id': '*21', comment: 'operator: static route', table: 'via-modem2', disabled: false, inactive: false, 'src-address': '192.168.10.230' }
    const otherGroupRule: RouterRule = { '.id': '*22', comment: marker('jadwal-9', '192.168.10.240'), table: 'via-modem2', disabled: false, inactive: false, 'src-address': '192.168.10.240' }
    driverRef = fakeDriver([protectingRule(), ownRule, foreignRule, otherGroupRule])

    const result = await deactivateGroup(host, 'jadwal-1', deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driverRef.calls.delete).toEqual(['*20'])
    expect(driverRef.calls.update).toEqual([])
    expect(driverRef.calls.create).toEqual([])

    const finalRules = await driverRef.listRules()
    expect(finalRules.find((r) => r['.id'] === '*21')).toEqual(foreignRule)
    expect(finalRules.find((r) => r['.id'] === '*22')).toEqual(otherGroupRule)

    expect(result.group.active).toBe(false)
    expect(await host.storage.forDevice('d1').getRaw('assignment')).toBeNull()
  })

  test('disable-rules keeps the rule (disabled: true), never deletes it, and still clears the assignment note', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const group = groupFixture({ entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }], active: true, onDeactivate: 'disable-rules' })
    const host = fakeHost({ devices: [d1], groups: [group] })
    await host.storage.forDevice('d1').set('assignment', writeAssignment({ pathId: 'via-modem1', groupId: 'jadwal-1', lanIp: '192.168.10.215', lanIpSource: 'manual', leaseKind: '', since: 0 }))

    const ownRule: RouterRule = { '.id': '*30', comment: marker('jadwal-1', '192.168.10.215'), table: 'via-modem1', disabled: false, inactive: false, 'src-address': '192.168.10.215' }
    const foreignRule: RouterRule = { '.id': '*31', comment: 'operator: static route', table: 'via-modem2', disabled: false, inactive: false, 'src-address': '192.168.10.230' }
    driverRef = fakeDriver([protectingRule(), ownRule, foreignRule])

    const result = await deactivateGroup(host, 'jadwal-1', deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driverRef.calls.update).toEqual([{ id: '*30', patch: { disabled: true } }])
    expect(driverRef.calls.delete).toEqual([])
    expect(driverRef.calls.create).toEqual([])

    const finalRules = await driverRef.listRules()
    expect(finalRules.find((r) => r['.id'] === '*30')).toMatchObject({ disabled: true })
    expect(finalRules.find((r) => r['.id'] === '*31')).toEqual(foreignRule)

    expect(await host.storage.forDevice('d1').getRaw('assignment')).toBeNull()
  })

  test('an entry with no matching rule on the router is left alone rather than guessed at', async () => {
    const d1 = makeDevice('d1', '192.168.10.215')
    const group = groupFixture({ entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }], active: true })
    const host = fakeHost({ devices: [d1], groups: [group] })
    driverRef = fakeDriver([protectingRule()])

    const result = await deactivateGroup(host, 'jadwal-1', deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(driverRef.calls).toEqual({ create: [], update: [], delete: [] })
    expect(result.outcomes).toEqual([{ deviceId: 'd1', action: 'left-alone', reason: 'no matching rule on the router' }])
  })
})
