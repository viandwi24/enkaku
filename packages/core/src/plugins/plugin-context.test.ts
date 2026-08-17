import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  ChildToParentSchema,
  FarmCallSchema,
  KvCallSchema,
  createChildPluginContext,
  type FarmCall,
  type KvCall,
} from '@enkaku/session'
import { defineService, isService, type PluginContext } from '@enkaku/sdk'
import { createAuditLogger } from '../auth/audit'
import { createCapabilityContext, type CapabilityContextDeps } from '../capability/context'
import { buildCapabilityRegistry } from '../capability/registry'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createKvStore, type KvQuotas, type KvStore } from '../kv/store'
import { createKvRunnerPort } from '../kv/runner-port'
import { createLeaseManager } from '../lease/lease-manager'
import { createLogger } from '../util/logger'
import { createFarmBroker } from './farm-broker'
import { createPluginContext } from './plugin-context'
import { recordRun } from './plugin-context.fixture'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.1.
 *
 * The claim under test is criterion 2: *"a plugin helper function calling
 * `ctx.storage`/`ctx.log`/`ctx.farm` works unchanged from a script handler
 * and from an HTTP handler"*. Both contexts below are built by the code that
 * really builds them — `createChildPluginContext` is what
 * `runner/child-entry.ts` calls, `createPluginContext` is the core's own door
 * — and the script side's storage and farm calls cross the real IPC schemas
 * on the way, so this is the path a job takes, not a re-creation of it.
 */

const QUOTAS: KvQuotas = { maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }
const PLUGIN = 'bridge'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Harness {
  db: Db
  store: KvStore
  /** Every log line either context emitted, in order, tagged with which one emitted it. */
  logs: Array<{ where: 'core' | 'child'; level: string; msg: string }>
  /** Every capability id the fake broker was asked for, in order. */
  farmCalls: string[]
  /** The context a core-side handler (HTTP, WS, event, query) receives. */
  core: PluginContext
  /** The context a script handler receives, over the real IPC schemas. */
  child: PluginContext
}

function setUp(opts?: { coreDeviceId?: string; farm?: (id: string, input: unknown) => Promise<unknown> }): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-ctx-'))
  tmpDirs.push(dataDir)
  const db = opened.db
  const store = createKvStore(db, dataDir, () => QUOTAS)
  db.insert(devices).values({ id: 'dev-1', stableId: 'stable-1', serial: 'ser-1', label: 'Pixel', status: 'idle' }).run()
  db.insert(devices).values({ id: 'dev-2', stableId: 'stable-2', serial: 'ser-2', label: 'Moto', status: 'idle' }).run()

  const logs: Harness['logs'] = []
  const farmCalls: string[] = []
  const broker =
    opts?.farm ??
    (async (id: string) => {
      farmCalls.push(id)
      return [{ id: 'dev-1' }, { id: 'dev-2' }]
    })

  const core = createPluginContext({
    pluginId: PLUGIN,
    store,
    resolveStableId: (deviceId) => db.select({ s: devices.stableId }).from(devices).where(eq(devices.id, deviceId)).get()?.s ?? null,
    ...(opts?.coreDeviceId !== undefined ? { deviceId: opts.coreDeviceId } : {}),
    farm: broker,
    emitLog: (level, msg) => logs.push({ where: 'core', level, msg }),
  })

  // The script side. `kvRequest`/`farmRequest` are the child's own transports,
  // reproduced here exactly as `job-runner.ts` services them: the message is
  // validated by `ChildToParentSchema` (the real IPC envelope), then by the
  // call's own schema, then handed to the very same parent-side port a real
  // job uses.
  const kvPort = createKvRunnerPort({ db, store })
  const kvRequest = async (call: KvCall): Promise<unknown> => {
    const envelope = ChildToParentSchema.parse({ t: 'kv.call', callId: 'c1', ...call })
    const parsed = KvCallSchema.parse(envelope)
    return kvPort.call({ jobId: 'job-1', deviceId: 'dev-1', namespace: PLUGIN }, parsed)
  }
  const farmRequest = async (capability: string, input: unknown): Promise<unknown> => {
    const envelope = ChildToParentSchema.parse({ t: 'farm.call', callId: 'c1', capability, ...(input !== undefined ? { input } : {}) })
    const parsed: FarmCall = FarmCallSchema.parse(envelope)
    return broker(parsed.capability, parsed.input)
  }
  const child = createChildPluginContext({
    deviceId: 'dev-1',
    kvRequest,
    farmRequest,
    emitLog: (level, msg) => logs.push({ where: 'child', level, msg }),
  })

  return { db, store, logs, farmCalls, core, child }
}

describe('criterion 2 — one helper, called from a script handler and from an HTTP handler', () => {
  test('the same fixture function returns the same thing from both, and both wrote to the same rows', async () => {
    const h = setUp()

    // The "script handler" call. `recordRun` does not know it is one.
    const fromScript = await recordRun(h.child, 'dev-1')
    // The "HTTP handler" call, into the same store, through a different host.
    const fromHttp = await recordRun(h.core, 'dev-1')

    expect(fromScript).toEqual({ runs: 1, total: 1, devices: ['dev-1', 'dev-2'] })
    // Not a fresh 1: the second call read what the first one wrote, which is
    // what "the same storage" means.
    expect(fromHttp).toEqual({ runs: 2, total: 2, devices: ['dev-1', 'dev-2'] })

    // One row, one namespace, one device scope — not two parallel stores.
    expect(h.store.get({ kind: 'device', stableId: 'stable-1' }, PLUGIN, 'counter')?.value).toEqual({ runs: 2 })
    expect(h.store.get({ kind: 'global' }, PLUGIN, 'total')?.value).toBe(2)

    // Same log lines, same levels, same order, from both.
    expect(h.logs.filter((l) => l.where === 'child').map((l) => `${l.level} ${l.msg}`)).toEqual([
      'info recording a run',
      'debug recorded',
    ])
    expect(h.logs.filter((l) => l.where === 'core').map((l) => `${l.level} ${l.msg}`)).toEqual([
      'info recording a run',
      'debug recorded',
    ])

    expect(h.farmCalls).toEqual(['device.list', 'device.list'])
  })

  test('the two contexts are structurally the same object shape', () => {
    const h = setUp()
    expect(Object.keys(h.core).sort()).toEqual(['farm', 'log', 'storage'])
    expect(Object.keys(h.child).sort()).toEqual(Object.keys(h.core).sort())
    expect(Object.keys(h.core.storage).sort()).toEqual(['device', 'forDevice', 'global'])
    expect(Object.keys(h.child.storage).sort()).toEqual(Object.keys(h.core.storage).sort())
    expect(Object.keys(h.core.farm).sort()).toEqual(Object.keys(h.child.farm).sort())
    expect(Object.keys(h.core.log).sort()).toEqual(['debug', 'error', 'info', 'warn'])
  })
})

describe('the device scope — the one thing the two entry points cannot mean identically', () => {
  test('a script handler`s ambient device scope is its own job`s device', async () => {
    const h = setUp()
    await h.child.storage.device.set('via-ambient', 1)
    expect(h.store.get({ kind: 'device', stableId: 'stable-1' }, PLUGIN, 'via-ambient')?.value).toBe(1)
  })

  test('a core handler with no device refuses the ambient scope by name, rather than silently reading the farm scope', async () => {
    const h = setUp()
    await expect(h.core.storage.device.getRaw('anything')).rejects.toMatchObject({ code: 'E_NO_DEVICE_SCOPE' })
    await expect(h.core.storage.device.set('anything', 1)).rejects.toMatchObject({ code: 'E_NO_DEVICE_SCOPE' })
    // …and the farm scope, which is always meaningful, still works.
    await h.core.storage.global.set('anything', 1)
    expect(h.store.get({ kind: 'global' }, PLUGIN, 'anything')?.value).toBe(1)
  })

  test('a core handler bound to a device (an event handler) has an ambient scope, and it is that device', async () => {
    const h = setUp({ coreDeviceId: 'dev-2' })
    await h.core.storage.device.set('bound', 'yes')
    expect(h.store.get({ kind: 'device', stableId: 'stable-2' }, PLUGIN, 'bound')?.value).toBe('yes')
  })

  test('a script may only ever reach its own device`s scope (plan 108 §3.1 G4)', async () => {
    const h = setUp()
    await expect(h.child.storage.forDevice('dev-2').getRaw('x')).rejects.toMatchObject({ code: 'E_FOREIGN_DEVICE_SCOPE' })
    // Its own device, named explicitly, is the ambient scope by another name.
    await h.child.storage.forDevice('dev-1').set('x', 7)
    expect(await h.child.storage.device.getRaw('x')).toBe(7)
  })

  test('a core handler naming a device that does not exist is refused, not defaulted', async () => {
    const h = setUp()
    await expect(h.core.storage.forDevice('nope').getRaw('x')).rejects.toMatchObject({ code: 'E_DEVICE_NOT_FOUND' })
  })
})

describe('ctx.farm', () => {
  test('validates the output against the caller`s own schema, naming the capability when it does not match', async () => {
    const h = setUp({ farm: async () => ({ not: 'an array' }) })
    await expect(recordRun(h.core, 'dev-1')).rejects.toMatchObject({ code: 'E_FARM_SCHEMA_MISMATCH' })
    await expect(recordRun(h.child, 'dev-1')).rejects.toMatchObject({ code: 'E_FARM_SCHEMA_MISMATCH' })
  })

  test('callRaw hands back whatever the farm answered, unvalidated', async () => {
    const h = setUp({ farm: async (id, input) => ({ id, input }) })
    expect(await h.core.farm.callRaw('job.run', { script: 'x' })).toEqual({ id: 'job.run', input: { script: 'x' } })
    expect(await h.child.farm.callRaw('job.run', { script: 'x' })).toEqual({ id: 'job.run', input: { script: 'x' } })
  })

  test('a host with no broker wired refuses fail-closed, never a silent success', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-ctx-'))
    tmpDirs.push(dataDir)
    const ctx = createPluginContext({
      pluginId: PLUGIN,
      store: createKvStore(opened.db, dataDir, () => QUOTAS),
      resolveStableId: () => null,
      emitLog: () => {},
    })
    await expect(ctx.farm.callRaw('device.list')).rejects.toMatchObject({ code: 'E_FARM_UNAVAILABLE' })
  })
})

describe('criterion 11 — no Db, KvStore, or capability registry is reachable from ctx', () => {
  /** Every own enumerable value reachable from `root`, depth-capped, functions included. */
  function reachable(root: object): unknown[] {
    const seen = new Set<unknown>()
    const out: unknown[] = []
    const walk = (v: unknown, depth: number): void => {
      if (depth > 6) return
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return
      if (seen.has(v)) return
      seen.add(v)
      out.push(v)
      if (typeof v === 'object') for (const child of Object.values(v as Record<string, unknown>)) walk(child, depth + 1)
    }
    walk(root, 0)
    return out
  }

  /**
   * A fingerprint per forbidden object: **every** named method must be
   * present for a value to be one of them. Any-one-of would fire on `KvApi`
   * itself, which legitimately has `get`, `list` and `delete` — the point is
   * not to ban method names, it is to prove the objects themselves never
   * leave the closures they are captured in.
   *
   * Step 109.3 extended this list with everything the capability broker adds
   * to the core side — and fixed one of the original three. The `a capability
   * registry` row read `['list', 'get', 'ids']`, which is not the shape of
   * anything in this workspace: `CapabilityRegistry` is `{ all, get,
   * visibleTo }` (`capability/registry.ts`), so that row could never have
   * fired and the criterion's most important half was asserted against an
   * invented shape. The `every entry has a real control` test below is what
   * makes repeating that impossible.
   */
  const FORBIDDEN: Array<{ what: string; methods: string[] }> = [
    { what: 'KvStore', methods: ['deleteNamespace', 'deleteDevice', 'setIfVersion'] },
    { what: 'Db (drizzle)', methods: ['select', 'insert', 'update', 'delete'] },
    { what: 'a capability registry', methods: ['all', 'get', 'visibleTo'] },
    // Step 109.3's additions. Each is something the broker holds and the
    // context must never be able to reach back into.
    { what: 'a CapabilityContext', methods: ['hasPermission', 'canReachDevice', 'deviceCall', 'workspaceScope'] },
    { what: 'the audit logger', methods: ['record', 'list'] },
    { what: 'the farm broker itself', methods: ['call', 'actorFor'] },
  ]

  const fingerprintOf = (value: object): string | null => {
    for (const { what, methods } of FORBIDDEN) {
      if (methods.every((m) => typeof (value as Record<string, unknown>)[m] === 'function')) return what
    }
    return null
  }

  /** The real objects the broker is built from and closes over — the controls, and the third context's ports. */
  function brokerHarness(db: Db) {
    const audit = createAuditLogger(db)
    const registry = buildCapabilityRegistry([])
    const states = createDeviceStateMachine({ db, log: createLogger('test'), onChange: () => {} })
    const contextDeps: CapabilityContextDeps = {
      db,
      leases: createLeaseManager({
        states,
        jobStore: { expiredRunning: () => [] } as never,
        config: { jobTtlSec: 60, manualIdleTimeoutSec: 60, reaperIntervalMs: 1_000_000 },
        log: createLogger('test'),
        onJobLeaseExpired: () => {},
      }),
      states,
      sessions: () => null,
      readiness: () => null,
      transfer: null,
      jobService: {} as never,
      workspace: {} as never,
    }
    const broker = createFarmBroker({
      registry,
      contextDeps,
      plugins: { active: () => null, service: () => null },
      audit,
      log: createLogger('test'),
    })
    const capCtx = createCapabilityContext(contextDeps, { id: 'plugin:bridge', role: 'operator' })
    return { audit, registry, contextDeps, broker, capCtx }
  }

  test.each([
    ['a script handler', 'child'],
    ['a core handler', 'core'],
  ] as const)('%s exposes none of them', (_name, which) => {
    const h = setUp({ coreDeviceId: 'dev-1' })
    const ctx = which === 'core' ? h.core : h.child
    const values = reachable(ctx)
    // Sanity: the walk actually reached something, so a passing assertion below is not vacuous.
    expect(values.length).toBeGreaterThan(10)

    const found = values.filter((v): v is object => typeof v === 'object' && v !== null).map(fingerprintOf).filter((f) => f !== null)
    expect(found).toEqual([])
  })

  test('a core handler with the REAL broker wired exposes none of them either (step 109.3)', () => {
    const h = setUp({ coreDeviceId: 'dev-1' })
    const { broker } = brokerHarness(h.db)
    // Exactly how `runtime-host.ts` builds it: the broker reaches the context
    // as ONE `(id, input) => Promise<unknown>` closure and nothing else, which
    // is why the walk below cannot find its way back to the registry, the
    // audit logger, or the capability context the broker constructs per call.
    const ctx = createPluginContext({
      pluginId: PLUGIN,
      store: h.store,
      resolveStableId: () => 'stable-1',
      deviceId: 'dev-1',
      farm: (id, input) => broker.call({ pluginId: PLUGIN, capability: id, input, via: 'service' }),
      emitLog: () => {},
    })

    const values = reachable(ctx)
    expect(values.length).toBeGreaterThan(10)
    const found = values.filter((v): v is object => typeof v === 'object' && v !== null).map(fingerprintOf).filter((f) => f !== null)
    expect(found).toEqual([])
    // …and the context is still exactly three members: a broker that had to be
    // hung off `ctx` to be reachable would show up here first.
    expect(Object.keys(ctx).sort()).toEqual(['farm', 'log', 'storage'])
  })

  test('the walk itself would catch a leak — a context with the broker hung off it is found', () => {
    const h = setUp()
    const { broker, registry } = brokerHarness(h.db)
    // The other half of a non-vacuous control: the fingerprints match real
    // objects (below), AND the WALK finds them when they are genuinely
    // reachable. Without this, a walk that quietly stopped at depth 0 would
    // pass every assertion above.
    const leaky = { ...h.core, oops: { broker, registry, store: h.store } }
    const found = reachable(leaky)
      .filter((v): v is object => typeof v === 'object' && v !== null)
      .map(fingerprintOf)
      .filter((f) => f !== null)
      .sort()
    expect(found).toEqual(['KvStore', 'a capability registry', 'the farm broker itself'])
  })

  test('every fingerprint is real — each one matches an object this harness actually built', () => {
    const h = setUp()
    const { audit, registry, broker, capCtx } = brokerHarness(h.db)
    // The control, and the reason this test is table-driven rather than a list
    // of hand-written assertions: a fingerprint that matches nothing makes the
    // walk above pass for free, which is precisely how the original
    // `['list','get','ids']` registry row survived. Adding a row to FORBIDDEN
    // without a real object to match it now fails here.
    const controls: Record<string, object> = {
      KvStore: h.store,
      'Db (drizzle)': h.db,
      'a capability registry': registry,
      'a CapabilityContext': capCtx,
      'the audit logger': audit,
      'the farm broker itself': broker,
    }
    expect(Object.keys(controls).sort()).toEqual(FORBIDDEN.map((f) => f.what).sort())
    for (const { what } of FORBIDDEN) expect(fingerprintOf(controls[what]!)).toBe(what)
  })
})

/**
 * Renamed from `defineRuntime` by step 109.2 (plan 109 §9 Q7, settled by the
 * owner): `PluginDefinition.service`, not `.runtime`, because a plugin MEMBER's
 * `runtime` is already plan 98's `RuntimeEnvelope`.
 */
describe('defineService', () => {
  test('brands the declaration so a host can recognise it without importing this package at run time', () => {
    const service = defineService({ setup: async () => {} })
    expect(service.kind).toBe('enkaku.service')
    expect(isService(service)).toBe(true)
    expect(isService({ kind: 'enkaku.service' })).toBe(false)
    expect(isService(() => {})).toBe(false)
    expect(isService(null)).toBe(false)
  })

  test('defaults the declaration a manifest carries', () => {
    const service = defineService({ setup: () => {} })
    expect(service.permissions).toEqual([])
    expect(service.isolation).toBe('in-process')
  })

  test('accepts `isolation: "process"` — the manifest reserves it; the FARM refuses it at verify (criterion 7)', () => {
    expect(defineService({ isolation: 'process', setup: () => {} }).isolation).toBe('process')
  })

  test('refuses a non-function on the author`s own machine, at import time', () => {
    // @ts-expect-error — the whole point: a caller that ignores the type is still refused.
    expect(() => defineService({ setup: undefined })).toThrow(/must be a function/)
  })

  test('the setup function receives a context a plugin helper accepts unchanged', async () => {
    const h = setUp()
    let record: unknown
    const service = defineService({
      setup: async (ctx) => {
        record = await recordRun(ctx, 'dev-1')
      },
    })
    // A `PluginServiceContext` is a `PluginContext` plus the service-only
    // surface (`onStop`, step 109.4/109.5's `isPortFree`/`reportListener`/
    // `onEvent`, and step 109.6's three handler families); the helper takes the
    // narrower type and neither knows nor cares — which is criterion 2 restated
    // as a compiler check. Spelling every member out here is deliberate: the
    // object literal is what fails to compile when the service surface grows,
    // which is the reminder that a helper must stay typed against
    // `PluginContext` and not against this.
    await service.setup({
      ...h.core,
      onStop: () => {},
      isPortFree: async () => true,
      reportListener: (listener) => ({ proto: 'tcp', deviceReachable: false, ...listener }),
      onEvent: () => {},
      onRequest: () => {},
      onSocket: () => {},
      onQuery: () => {},
      onWebhook: () => {},
      webhooks: {
        list: async () => [],
        secret: async () => 'not-a-real-secret',
        rotate: async () => ({ secret: 'not-a-real-secret', previousValidUntil: null }),
      },
      logs: { page: async () => ({ plugin: 'p', lines: [], truncated: false, nextSeq: 0, subject: null }) },
    })
    expect(record).toEqual({ runs: 1, total: 1, devices: ['dev-1', 'dev-2'] })
  })
})

describe('the storage member is plan 79`s store, not a second one', () => {
  test('a value written through ctx.storage is readable through the same job`s ctx.kv alias shape', async () => {
    const h = setUp()
    await h.child.storage.global.set('shared', { a: 1 })
    // `child-entry.ts` sets `ctx.kv = ctx.storage` — the same object, so this
    // is an identity check, not a round trip.
    expect(await h.child.storage.global.get('shared', z.object({ a: z.number() }))).toEqual({ a: 1 })
  })
})
