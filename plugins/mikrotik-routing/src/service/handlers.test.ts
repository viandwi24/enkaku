import { describe, expect, test } from 'bun:test'
import { LOCAL_EXCEPTION_COMMENT } from '../shared'
import { MikrotikRestError } from './errors'
import { toRuleRow, registerRouterRoutes, ROUTER_ROUTE_PERMISSIONS, ROUTER_ROUTES, type HandlerHost } from './handlers'
import type { DoctorReport, RouterDriver, RouterInventory } from './router-driver'
import type { RouterRule } from './schemas'

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
    localException: { present: true, rule: null },
    managedRuleCount: 0,
    foreignRuleCount: 0,
    fixCommands: ['cmd1', 'cmd2', 'cmd3'],
    errors: [],
    ...overrides,
  }
}

/** A `RouterDriver` whose every method is swappable per test — the write three still reject, exactly like `MikrotikRestDriver`'s own (this step ships no write path). */
function fakeDriver(overrides: Partial<RouterDriver> = {}): RouterDriver {
  return {
    inventory: async () => emptyInventory(),
    listRules: async () => [],
    doctor: async () => okDoctorReport(),
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

function fakeHost(routerKv: unknown): { host: HandlerHost; registered: Map<string, Registered> } {
  const registered = new Map<string, Registered>()
  const host: HandlerHost = {
    storage: { global: { getRaw: async () => routerKv } },
    onRequest: (id, handler, opts) => {
      registered.set(id, { handler: handler as Registered['handler'], opts })
    },
  }
  return { host, registered }
}

const FAKE_REQUEST = { method: 'GET', path: '/', query: {}, headers: {}, body: null, caller: { id: 'u1', role: 'admin' } }

describe('registerRouterRoutes — registration table', () => {
  test('registers exactly inventory/rules/doctor, all on script.view (§4.10: onRequest defaults to it, and none of these three write)', () => {
    const { host, registered } = fakeHost(null)
    registerRouterRoutes(host)
    expect([...registered.keys()].sort()).toEqual(['doctor', 'inventory', 'rules'])
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
      paths: [{ id: 'via-modem1', table: 'via-modem1', gateway: '10.0.0.1', hasDefaultRoute: true }],
      interfaces: [],
      health: [{ pathId: 'via-modem1', up: true, checkedAt: 1000 }],
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

describe('registerRouterRoutes — doctor', () => {
  const routerKv = { baseUrl: '192.168.1.1', username: 'admin', password: 'x', tls: false, timeoutMs: 2000 }

  test('returns the driver’s report verbatim, wrapped in ok:true — never throws even on a "bad" report, since doctor() itself never throws', async () => {
    const report = okDoctorReport({ localException: { present: false, rule: null }, errors: ['could not read REST version'] })
    const { host, registered } = fakeHost(routerKv)
    registerRouterRoutes(host, { createDriver: () => fakeDriver({ doctor: async () => report }) })
    const result = await registered.get('doctor')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: { ok: true, ...report } })
  })
})

describe('toRuleRow', () => {
  test('carries srcAddress/table through as null when the router omitted them', () => {
    const row = toRuleRow(fakeRule({ comment: 'foreign' }))
    expect(row.srcAddress).toBeNull()
    expect(row.table).toBeNull()
  })
})
