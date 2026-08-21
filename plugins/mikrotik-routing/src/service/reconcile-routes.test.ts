import { describe, expect, test } from 'bun:test'
import { registerReconcileRoutes, RECONCILE_ROUTES, RECONCILE_ROUTE_PERMISSIONS, type ReconcileRoutesHost } from './reconcile-routes'
import type { ReconcileResult } from './reconcile'

/**
 * `registerReconcileRoutes` — the one route's registration table (id,
 * method, permission) and that it answers via whatever `ReconcileLoop.
 * reconcileNow()` the caller hands in. `reconcile.ts`'s own tests already
 * cover every behaviour of the loop itself; this file only proves the
 * wiring — the same split `apply-routes.test.ts` draws for `registerApplyRoutes`.
 */

interface Registered {
  handler: (request: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; caller: { id: string; role: string } }, signal: AbortSignal) => unknown
  opts?: { permission?: string; methods?: readonly string[]; timeoutMs?: number; description?: string }
}

function fakeHost(): { host: ReconcileRoutesHost; registered: Map<string, Registered> } {
  const registered = new Map<string, Registered>()
  const host: ReconcileRoutesHost = {
    onRequest: (id, handler, opts) => {
      registered.set(id, { handler: handler as Registered['handler'], opts })
    },
  }
  return { host, registered }
}

const FAKE_REQUEST = { method: 'POST', path: '/', query: {}, headers: {}, body: null, caller: { id: 'u1', role: 'admin' } }

const OK_RESULT: ReconcileResult = { ok: true, drifts: [], newDrifts: [], autoRepaired: [], deviceLabels: {}, checkedAt: 1000, localException: { status: 'ok', message: '', uncoveredDevices: [], coreAddress: { kind: 'derived', address: '10.0.0.1' }, suggestedFixCommands: [] } }

describe('registerReconcileRoutes — registration table', () => {
  test('registers exactly one route, "reconcile", plugin.runtime, POST', () => {
    const { host, registered } = fakeHost()
    registerReconcileRoutes(host, { reconcileNow: async () => OK_RESULT, start: () => {}, stop: () => {} })
    expect([...registered.keys()]).toEqual(['reconcile'])
    expect(registered.get(RECONCILE_ROUTES.reconcile)?.opts?.permission).toBe(RECONCILE_ROUTE_PERMISSIONS.reconcile)
    expect(RECONCILE_ROUTE_PERMISSIONS.reconcile).toBe('plugin.runtime')
    expect(registered.get('reconcile')?.opts?.methods).toEqual(['POST'])
  })
})

describe('registerReconcileRoutes — the route answers via the given loop’s reconcileNow()', () => {
  test('forwards the loop’s own result verbatim', async () => {
    const { host, registered } = fakeHost()
    let calls = 0
    registerReconcileRoutes(host, {
      reconcileNow: async () => {
        calls += 1
        return OK_RESULT
      },
      start: () => {},
      stop: () => {},
    })
    const result = await registered.get('reconcile')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: OK_RESULT })
    expect(calls).toBe(1)
  })

  test('a failing tick’s refusal is forwarded the same way, not swallowed', async () => {
    const { host, registered } = fakeHost()
    const refusal: ReconcileResult = { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: 'No router connection has been saved yet.' }
    registerReconcileRoutes(host, { reconcileNow: async () => refusal, start: () => {}, stop: () => {} })
    const result = await registered.get('reconcile')?.handler(FAKE_REQUEST, new AbortController().signal)
    expect(result).toEqual({ body: refusal })
  })
})
