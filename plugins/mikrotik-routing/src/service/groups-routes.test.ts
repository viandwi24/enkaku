import { describe, expect, test } from 'bun:test'
import { registerGroupRoutes, GROUP_ROUTES, GROUP_ROUTE_PERMISSIONS, type GroupsRoutesHost } from './groups-routes'

/**
 * `registerGroupRoutes` — the five routes' registration table (id, method,
 * permission) and that each answers via the corresponding `groups-service.ts`
 * function. `groups-service.test.ts` already covers every behaviour those
 * functions have; this file only proves the wiring — the same split
 * `apply-routes.test.ts` draws for `registerApplyRoutes`.
 */

interface Registered {
  handler: (request: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; caller: { id: string; role: string } }, signal: AbortSignal) => unknown
  opts?: { permission?: string; methods?: readonly string[]; timeoutMs?: number; description?: string }
}

function fakeHost(): { host: GroupsRoutesHost; registered: Map<string, Registered> } {
  const registered = new Map<string, Registered>()
  const globalStore = new Map<string, unknown>()
  const host: GroupsRoutesHost = {
    storage: {
      global: {
        getRaw: async (key) => (globalStore.has(key) ? globalStore.get(key) : null),
        set: async (key, value) => {
          globalStore.set(key, value)
          return { version: 1 }
        },
        list: async () => ({ items: [], nextCursor: null }),
        delete: async (key) => globalStore.delete(key),
      },
      forDevice: () => ({ getRaw: async () => undefined, set: async () => ({ version: 1 }), delete: async () => true }),
    },
    farm: { call: async (_id, _input, schema) => schema.parse({ items: [] }) },
    log: { warn: () => {} },
    onRequest: (id, handler, opts) => {
      registered.set(id, { handler: handler as Registered['handler'], opts })
    },
  }
  return { host, registered }
}

const FAKE_GET = { method: 'GET', path: '/', query: {}, headers: {}, body: null, caller: { id: 'u1', role: 'admin' } }
const FAKE_DELETE = { method: 'DELETE', path: '/', query: { id: 'jadwal-1' }, headers: {}, body: null, caller: { id: 'u1', role: 'admin' } }
const FAKE_POST = (body: unknown) => ({ method: 'POST', path: '/', query: {}, headers: {}, body, caller: { id: 'u1', role: 'admin' } })

describe('registerGroupRoutes — registration table', () => {
  test('registers exactly the six ids, on the permissions this file documents', () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    expect([...registered.keys()].sort()).toEqual(['group-activate', 'group-activate-preview', 'group-deactivate', 'group-delete', 'group-save', 'groups'])
    for (const key of Object.keys(GROUP_ROUTES) as (keyof typeof GROUP_ROUTES)[]) {
      expect(registered.get(GROUP_ROUTES[key])?.opts?.permission).toBe(GROUP_ROUTE_PERMISSIONS[key])
    }
  })

  test('list and the activation preview are script.view; save/delete are plugin.data; activate/deactivate are plugin.runtime', () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    expect(registered.get('groups')?.opts?.permission).toBe('script.view')
    expect(registered.get('group-activate-preview')?.opts?.permission).toBe('script.view')
    expect(registered.get('group-save')?.opts?.permission).toBe('plugin.data')
    expect(registered.get('group-delete')?.opts?.permission).toBe('plugin.data')
    expect(registered.get('group-activate')?.opts?.permission).toBe('plugin.runtime')
    expect(registered.get('group-deactivate')?.opts?.permission).toBe('plugin.runtime')
  })

  test('methods: groups GET, group-save PUT, group-delete DELETE, preview/activate/deactivate POST', () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    expect(registered.get('groups')?.opts?.methods).toEqual(['GET'])
    expect(registered.get('group-save')?.opts?.methods).toEqual(['PUT'])
    expect(registered.get('group-delete')?.opts?.methods).toEqual(['DELETE'])
    expect(registered.get('group-activate-preview')?.opts?.methods).toEqual(['POST'])
    expect(registered.get('group-activate')?.opts?.methods).toEqual(['POST'])
    expect(registered.get('group-deactivate')?.opts?.methods).toEqual(['POST'])
  })
})

describe('registerGroupRoutes — each route answers via the matching groups-service.ts function', () => {
  test('groups, with none saved, answers an empty list', async () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    const result = await registered.get('groups')?.handler(FAKE_GET, new AbortController().signal)
    expect(result).toEqual({ body: { ok: true, items: [] } })
  })

  test('group-save with a bad body (no name) answers a shaped E_BAD_REQUEST, never throws', async () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    const result = await registered.get('group-save')?.handler(FAKE_POST({}), new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_BAD_REQUEST', message: expect.any(String) } })
  })

  test('group-save with a duplicate device is refused, exactly the groups-service.ts refusal', async () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    const body = {
      name: 'Jadwal-1',
      entries: [
        { deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' },
        { deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem2' },
      ],
    }
    const result = await registered.get('group-save')?.handler(FAKE_POST(body), new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_GROUP_DUPLICATE_DEVICE', message: expect.stringContaining('d1') } })
  })

  test('group-delete for an id that was never saved answers E_GROUP_NOT_FOUND', async () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    const result = await registered.get('group-delete')?.handler(FAKE_DELETE, new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_GROUP_NOT_FOUND', message: expect.stringContaining('jadwal-1') } })
  })

  test('group-activate-preview for an id that was never saved answers E_GROUP_NOT_FOUND, never reaching the router', async () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    const result = await registered.get('group-activate-preview')?.handler(FAKE_POST({ id: 'jadwal-1' }), new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_GROUP_NOT_FOUND', message: expect.stringContaining('jadwal-1') } })
  })

  test('group-activate for an id that was never saved answers E_GROUP_NOT_FOUND, never reaching the router', async () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    const result = await registered.get('group-activate')?.handler(FAKE_POST({ id: 'jadwal-1' }), new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_GROUP_NOT_FOUND', message: expect.stringContaining('jadwal-1') } })
  })

  test('group-deactivate for an id that was never saved answers E_GROUP_NOT_FOUND', async () => {
    const { host, registered } = fakeHost()
    registerGroupRoutes(host)
    const result = await registered.get('group-deactivate')?.handler(FAKE_POST({ id: 'jadwal-1' }), new AbortController().signal)
    expect(result).toEqual({ body: { ok: false, code: 'E_GROUP_NOT_FOUND', message: expect.stringContaining('jadwal-1') } })
  })
})
