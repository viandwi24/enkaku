import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createAuditLogger, type AuditLogger } from '../auth/audit'
import type { Role } from '../auth/service'
import { buildCapabilityRegistry } from '../capability/registry'
import { defineCapability } from '../capability/types'
import type { CapabilityContextDeps } from '../capability/context'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createLeaseManager } from '../lease/lease-manager'
import type { Logger } from '../util/logger'
import { createFarmBroker, createFarmRunnerPort, pluginNameFromPrincipal, type BrokerPlugins, type FarmBroker } from './farm-broker'
import type { PluginRow } from '../db/schema'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.3 — **the capability broker.**
 *
 * Two acceptance criteria live here, and one of them has a half that is easy
 * to pass by accident:
 *
 * - **10.** `ctx.farm` refuses any capability absent from the manifest
 *   **before** `invoke()` is called, and every accepted call writes exactly one
 *   audit row.
 * - (criterion 11 — no `Db`/`KvStore`/registry reachable from `ctx` — is
 *   asserted over the context object's own shape in `plugin-context.test.ts`,
 *   which this step extended to cover everything the broker adds.)
 *
 * "Before `invoke()` is called" is proven twice over, because "it refused" and
 * "it refused without doing the thing" are different claims:
 *
 * 1. every capability below records whether its handler RAN, so a
 *    called-then-rolled-back implementation fails these tests; and
 * 2. `invoke()` writes exactly one `capability.invoke` audit row on **every**
 *    path it can take, including its own `E_BAD_INPUT` — so the absence of that
 *    row is independent proof the function was never entered, and does not
 *    depend on the fixture's own bookkeeping being right.
 *
 * Everything under test is the real thing: the real `buildCapabilityRegistry`,
 * the real `invoke()`, the real `createCapabilityContext`, and the real
 * `createAuditLogger` writing to a real (in-memory) database. Only the plugin
 * REGISTRY is a fake, and only because the alternative — staging, verifying and
 * activating a bundle — is `runtime-host.test.ts`'s job and would prove nothing
 * extra about a gate that reads two accessors.
 */

interface Ran {
  read: number
  admin: number
  device: number
}

function buildRegistry(ran: Ran) {
  const read = defineCapability({
    id: 'test.read',
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    // In the OPERATOR set — a plugin published by an operator may call it.
    permission: 'script.view',
    lease: 'none',
    deadline: 1_000,
    effect: 'read',
    description: 'a capability that records whether it ran',
    handler: async (_ctx, input) => {
      ran.read++
      return { n: input.n * 2 }
    },
  })
  const adminOnly = defineCapability({
    id: 'test.admin',
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
    // NOT in the OPERATOR set (see `auth/acl.ts`) — admin only.
    permission: 'kv.manage',
    lease: 'none',
    deadline: 1_000,
    effect: 'destructive',
    description: 'an admin-only capability that records whether it ran',
    handler: async () => {
      ran.admin++
      return { ok: true as const }
    },
  })
  const onDevice = defineCapability({
    id: 'test.device',
    input: z.object({ deviceId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
    permission: 'script.view',
    lease: 'none',
    deadline: 1_000,
    effect: 'read',
    description: 'a capability that names a device, so invoke checks the grant',
    handler: async () => {
      ran.device++
      return { ok: true as const }
    },
  })
  return buildCapabilityRegistry([
    { cap: read, file: 'farm-broker.test.ts' },
    { cap: adminOnly, file: 'farm-broker.test.ts' },
    { cap: onDevice, file: 'farm-broker.test.ts' },
  ])
}

function silentLog(): Logger {
  const self: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

/** A plugin row with only the two fields the broker reads. The rest is never touched. */
function pluginRow(name: string, createdBy: string | null): PluginRow {
  return {
    id: `row-${name}`,
    name,
    version: '1.0.0',
    title: null,
    description: null,
    bundle: '',
    source: null,
    bundleHash: '',
    status: 'active',
    verifiedAt: null,
    verifyError: null,
    verifyErrorCode: null,
    manifest: null,
    resetPackages: null,
    createdBy,
    createdAt: new Date(),
  }
}

interface Harness {
  db: Db
  broker: FarmBroker
  audit: AuditLogger
  ran: Ran
  /** Set the declared permission list for `bridge`. `null` = the plugin declares no service at all. */
  declare(permissions: string[] | null): void
  /** Set who published `bridge`, and their role — resolved LIVE on every call. */
  publishedBy(userId: string | null, role?: Role): void
  rows(): ReturnType<AuditLogger['list']>
}

function setUp(opts?: { audit?: boolean }): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  db.insert(devices).values({ id: 'free', stableId: 's-free', serial: 'S1', label: 'Free', status: 'idle', ownerId: null }).run()
  db.insert(devices).values({ id: 'owned', stableId: 's-owned', serial: 'S2', label: 'Owned', status: 'idle', ownerId: 'someone-else' }).run()

  const ran: Ran = { read: 0, admin: 0, device: 0 }
  const audit = createAuditLogger(db)
  const states = createDeviceStateMachine({ db, log: silentLog(), onChange: () => {} })
  const leases = createLeaseManager({
    states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
    log: silentLog(),
    onJobLeaseExpired: () => {},
  })
  const contextDeps: CapabilityContextDeps = {
    db,
    leases,
    states,
    sessions: () => null,
    readiness: () => null,
    transfer: null,
    jobService: {} as never,
    workspace: {} as never,
  }

  let declared: string[] | null = ['test.read']
  let publisher: string | null = null
  const roles = new Map<string, Role>()

  const plugins: BrokerPlugins = {
    active: (name) => (name === 'bridge' ? pluginRow('bridge', publisher) : null),
    service: (name) => (name === 'bridge' && declared ? { permissions: declared, isolation: 'in-process', listeners: [], events: [], webhooks: [] } : null),
  }

  const broker = createFarmBroker({
    registry: buildRegistry(ran),
    contextDeps,
    plugins,
    ...(opts?.audit === false ? {} : { audit }),
    roleOf: (userId) => (userId ? (roles.get(userId) ?? 'operator') : null),
    log: silentLog(),
  })

  return {
    db,
    broker,
    audit,
    ran,
    declare: (permissions) => {
      declared = permissions
    },
    publishedBy: (userId, role) => {
      publisher = userId
      if (userId && role) roles.set(userId, role)
    },
    rows: () => audit.list(50),
  }
}

const serviceCall = (broker: FarmBroker, capability: string, input?: unknown) =>
  broker.call({ pluginId: 'bridge', capability, ...(input !== undefined ? { input } : {}), via: 'service' })

describe('criterion 10 — the manifest gate fires BEFORE invoke()', () => {
  test('an undeclared capability is refused, and its handler never ran', async () => {
    const h = setUp()
    h.declare(['test.device'])

    await expect(serviceCall(h.broker, 'test.read', { n: 21 })).rejects.toMatchObject({ code: 'E_FARM_UNDECLARED' })

    // The claim that matters: not "it was refused", but "it was refused
    // without the capability doing anything".
    expect(h.ran.read).toBe(0)

    const rows = h.rows()
    expect(rows.map((r) => r.action)).toEqual(['plugin.capability'])
    // The independent witness. `invoke()` audits on every path it takes, so no
    // `capability.invoke` row means `invoke()` was never entered — this does
    // not rely on the fixture's own counter above being correct.
    expect(rows.some((r) => r.action === 'capability.invoke')).toBe(false)
  })

  test('the refusal is upstream of invoke`s own input parse — bad input on an undeclared capability still reads UNDECLARED', async () => {
    const h = setUp()
    h.declare([])

    // `{ n: 'not a number' }` would fail `test.read`'s input schema. If the
    // broker handed the call to `invoke()` and filtered afterwards, this would
    // come back E_BAD_INPUT and there would be a `capability.invoke` row.
    await expect(serviceCall(h.broker, 'test.read', { n: 'not a number' })).rejects.toMatchObject({ code: 'E_FARM_UNDECLARED' })
    expect(h.ran.read).toBe(0)
    expect(h.rows().map((r) => r.action)).toEqual(['plugin.capability'])
  })

  test('a plugin that declares no service at all has declared nothing — not everything', async () => {
    const h = setUp()
    h.declare(null)
    await expect(serviceCall(h.broker, 'test.read', { n: 1 })).rejects.toMatchObject({ code: 'E_FARM_UNDECLARED' })
    expect(h.ran.read).toBe(0)
    expect(h.rows()[0]?.meta).toMatchObject({ declared: [] })
  })

  test('a namespace that is not an active plugin is refused by name — there is no manifest to check it against', async () => {
    const h = setUp()
    await expect(h.broker.call({ pluginId: 'not-installed', capability: 'test.read', input: { n: 1 }, via: 'script', jobId: 'j1' })).rejects.toMatchObject({
      code: 'E_FARM_NO_PLUGIN',
    })
    expect(h.ran.read).toBe(0)
    expect(h.rows()[0]).toMatchObject({ userId: 'plugin:not-installed', action: 'plugin.capability' })
  })

  test('a capability the manifest declares but the farm does not have is refused as unknown, not as undeclared', async () => {
    const h = setUp()
    h.declare(['test.typo'])
    await expect(serviceCall(h.broker, 'test.typo')).rejects.toMatchObject({ code: 'E_FARM_UNKNOWN_CAPABILITY' })
    expect(h.rows().map((r) => r.action)).toEqual(['plugin.capability'])
  })

  test('a malformed call is refused at the broker`s own Zod boundary, before anything is looked up', async () => {
    const h = setUp()
    await expect(serviceCall(h.broker, '')).rejects.toMatchObject({ code: 'E_BAD_INPUT' })
    expect(h.rows().map((r) => r.action)).toEqual(['plugin.capability'])
  })
})

describe('criterion 10 — exactly one audit row per accepted call', () => {
  test('an accepted call runs, returns the capability`s output, and writes ONE row', async () => {
    const h = setUp()
    h.declare(['test.read'])

    expect(await serviceCall(h.broker, 'test.read', { n: 21 })).toEqual({ n: 42 })
    expect(h.ran.read).toBe(1)

    const rows = h.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'capability.invoke', userId: 'plugin:bridge', target: 'test.read' })
    expect(rows[0]?.meta).toMatchObject({ outcome: 'ok', code: null })
    // The row is filterable back to the plugin without a join.
    expect(pluginNameFromPrincipal(rows[0]?.userId ?? '')).toBe('bridge')
  })

  test('two calls, two rows — never a coalesced or dropped one', async () => {
    const h = setUp()
    await serviceCall(h.broker, 'test.read', { n: 1 })
    await serviceCall(h.broker, 'test.read', { n: 2 })
    expect(h.rows()).toHaveLength(2)
  })

  test('a broker refusal writes one row and names the plugin, the capability, and what the manifest DID declare', async () => {
    const h = setUp()
    h.declare(['test.device', 'test.admin'])
    await expect(serviceCall(h.broker, 'test.read', { n: 1 })).rejects.toMatchObject({ code: 'E_FARM_UNDECLARED' })

    const rows = h.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'plugin.capability', userId: 'plugin:bridge', target: 'test.read' })
    expect(rows[0]?.meta).toMatchObject({
      plugin: 'bridge',
      capability: 'test.read',
      outcome: 'refused',
      code: 'E_FARM_UNDECLARED',
      via: 'service',
      // Recorded at the moment of the refusal rather than left to be looked
      // up later: a manifest changes on reload, and the row should say what
      // was true when the plugin was told no.
      declared: ['test.device', 'test.admin'],
    })
  })

  test('the input is never recorded — a capability input can carry a secret', async () => {
    const h = setUp()
    h.declare([])
    await expect(serviceCall(h.broker, 'test.read', { n: 1, token: 'hunter2' })).rejects.toMatchObject({ code: 'E_FARM_UNDECLARED' })
    expect(JSON.stringify(h.rows())).not.toContain('hunter2')
  })
})

describe('the second gate — invoke() still checks the real ACL under the plugin principal', () => {
  test('a capability the manifest declares is STILL refused when the plugin`s principal may not hold it', async () => {
    const h = setUp()
    // The manifest is not authority: declaring it is necessary, never sufficient.
    h.declare(['test.admin'])
    h.publishedBy('operator-1', 'operator')

    await expect(serviceCall(h.broker, 'test.admin', {})).rejects.toMatchObject({ code: 'E_FORBIDDEN' })
    expect(h.ran.admin).toBe(0)

    // …and that refusal came from `invoke()`, which is what the row proves.
    const rows = h.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'capability.invoke', userId: 'plugin:bridge' })
    expect(rows[0]?.meta).toMatchObject({ outcome: 'refused', code: 'E_FORBIDDEN' })
  })

  test('the principal`s role comes from the publisher and is resolved LIVE — demoting them narrows the plugin at once', async () => {
    const h = setUp()
    h.declare(['test.admin'])
    h.publishedBy('admin-1', 'admin')

    expect(await serviceCall(h.broker, 'test.admin', {})).toEqual({ ok: true })
    expect(h.broker.actorFor('bridge')).toEqual({ id: 'plugin:bridge', role: 'admin' })

    h.publishedBy('admin-1', 'operator')
    await expect(serviceCall(h.broker, 'test.admin', {})).rejects.toMatchObject({ code: 'E_FORBIDDEN' })
    expect(h.ran.admin).toBe(1)
  })

  test('an unknown or absent publisher gets the NARROWER role, never the wider one', () => {
    const h = setUp()
    expect(h.broker.actorFor('bridge')).toEqual({ id: 'plugin:bridge', role: 'operator' })
    h.publishedBy('ghost-user')
    expect(h.broker.actorFor('bridge')).toEqual({ id: 'plugin:bridge', role: 'operator' })
  })

  test('the device grant is checked too — an operator-role plugin cannot reach a device someone else owns', async () => {
    const h = setUp()
    h.declare(['test.device'])

    expect(await serviceCall(h.broker, 'test.device', { deviceId: 'free' })).toEqual({ ok: true })
    await expect(serviceCall(h.broker, 'test.device', { deviceId: 'owned' })).rejects.toMatchObject({ code: 'E_NO_GRANT' })
    expect(h.ran.device).toBe(1)
  })
})

describe('the script side reaches the same broker (criterion 2)', () => {
  test('a member script`s farm.call is checked against the same manifest and audited under the same principal', async () => {
    const h = setUp()
    h.declare(['test.read'])
    const port = createFarmRunnerPort(h.broker)

    expect(await port.call({ jobId: 'job-7', deviceId: 'free', pluginId: 'bridge' }, { capability: 'test.read', input: { n: 4 } })).toEqual({ n: 8 })
    expect(h.rows()[0]).toMatchObject({ action: 'capability.invoke', userId: 'plugin:bridge' })
  })

  test('a refusal from the script side records the job it came from, so an operator can tell it from the service`s own calls', async () => {
    const h = setUp()
    h.declare([])
    const port = createFarmRunnerPort(h.broker)

    await expect(port.call({ jobId: 'job-7', deviceId: 'free', pluginId: 'bridge' }, { capability: 'test.read' })).rejects.toMatchObject({
      code: 'E_FARM_UNDECLARED',
    })
    expect(h.rows()[0]?.meta).toMatchObject({ via: 'script', jobId: 'job-7', jobDeviceId: 'free' })
  })
})

describe('a host with no audit logger still refuses — the gate is not a side effect of auditing', () => {
  test('the refusal happens with `audit` absent', async () => {
    const h = setUp({ audit: false })
    h.declare([])
    await expect(serviceCall(h.broker, 'test.read', { n: 1 })).rejects.toMatchObject({ code: 'E_FARM_UNDECLARED' })
    expect(h.ran.read).toBe(0)
    // Nothing was written, because nothing was wired — the point is that the
    // ANSWER did not change. `daemon.ts` always wires one.
    expect(h.rows()).toEqual([])
  })
})
