import { describe, expect, test } from 'bun:test'
import { registerApplyRoutes, APPLY_ROUTES, APPLY_ROUTE_PERMISSIONS, type ApplyRoutesHost } from './apply-routes'

/**
 * `registerApplyRoutes` — the three routes' registration table (id, method,
 * permission) and that each answers via the corresponding `apply.ts`
 * function. `apply.ts`'s own tests already cover every behaviour those
 * functions have; this file only proves the wiring — the same split
 * `handlers.test.ts` draws for `registerRouterRoutes`.
 */

interface Registered {
  handler: (request: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; caller: { id: string; role: string } }, signal: AbortSignal) => unknown
  opts?: { permission?: string; methods?: readonly string[]; timeoutMs?: number; description?: string }
}

function fakeHost(routerKv: unknown): { host: ApplyRoutesHost; registered: Map<string, Registered> } {
  const registered = new Map<string, Registered>()
  const host: ApplyRoutesHost = {
    storage: {
      global: { getRaw: async () => routerKv },
      forDevice: () => ({ getRaw: async () => undefined }),
    },
    farm: { call: async (_id, _input, schema) => schema.parse({ items: [] }) },
    log: { warn: () => {} },
    onRequest: (id, handler, opts) => {
      registered.set(id, { handler: handler as Registered['handler'], opts })
    },
  }
  return { host, registered }
}

const FAKE_REQUEST = { method: 'GET', path: '/', query: {}, headers: {}, body: null, caller: { id: 'u1', role: 'admin' } }

describe('registerApplyRoutes — registration table', () => {
  test('registers exactly fleet/plan/apply, on the permissions §4.10/proxy-manager precedent calls for', () => {
    const { host, registered } = fakeHost(null)
    registerApplyRoutes(host)
    expect([...registered.keys()].sort()).toEqual(['apply', 'fleet', 'plan'])
    for (const key of Object.keys(APPLY_ROUTES) as (keyof typeof APPLY_ROUTES)[]) {
      expect(registered.get(APPLY_ROUTES[key])?.opts?.permission).toBe(APPLY_ROUTE_PERMISSIONS[key])
    }
  })

  test('fleet and plan are script.view; apply is plugin.runtime — the write route is gated more strictly', () => {
    const { host, registered } = fakeHost(null)
    registerApplyRoutes(host)
    expect(registered.get('fleet')?.opts?.permission).toBe('script.view')
    expect(registered.get('plan')?.opts?.permission).toBe('script.view')
    expect(registered.get('apply')?.opts?.permission).toBe('plugin.runtime')
  })

  test('fleet is GET; plan and apply are POST', () => {
    const { host, registered } = fakeHost(null)
    registerApplyRoutes(host)
    expect(registered.get('fleet')?.opts?.methods).toEqual(['GET'])
    expect(registered.get('plan')?.opts?.methods).toEqual(['POST'])
    expect(registered.get('apply')?.opts?.methods).toEqual(['POST'])
  })
})

describe('registerApplyRoutes — each route answers via the matching apply.ts function', () => {
  test('fleet, with no router saved, answers the same not-configured refusal loadFleet produces', async () => {
    const { host, registered } = fakeHost(null)
    registerApplyRoutes(host)
    const result = await registered.get('fleet')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: expect.stringContaining('No router connection') } })
  })

  test('plan, with no router saved, answers the same refusal previewPlan produces', async () => {
    const { host, registered } = fakeHost(null)
    registerApplyRoutes(host)
    const result = await registered.get('plan')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: expect.stringContaining('No router connection') } })
  })

  test('apply, with no router saved, answers the same refusal applyNow produces — never reaching the local-exception gate', async () => {
    const { host, registered } = fakeHost(null)
    registerApplyRoutes(host)
    const result = await registered.get('apply')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: expect.stringContaining('No router connection') } })
  })
})
