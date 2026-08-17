import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AuthEnv } from '../auth/middleware'
import { createTransferRegistry } from '../device/transfer-registry'
import { createTransferRegistryRoutes } from './transfers'

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

/**
 * `GET /api/transfers` (plan 107 §3.1, §3.4, §4, step 107.2). Proves the
 * route reads the live registry, round-trips the exact `TransfersResponseSchema`
 * shape, and — matching `GET /api/jobs`/`GET /api/batches`/`GET /api/command-runs`
 * — needs no permission beyond being logged in.
 */
describe('GET /api/transfers (plan 107 §3.1, §3.4, §4, step 107.2)', () => {
  test('an empty registry returns an empty list, not a 404 or an error', async () => {
    const app = withUser('operator', createTransferRegistryRoutes({ registry: createTransferRegistry() }))
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { transfers: unknown[] }
    expect(body).toEqual({ transfers: [] })
  })

  test('an operator (no special permission, unlike POST .../install which needs canUseFiles) can read the list', async () => {
    const registry = createTransferRegistry()
    registry.progress('dev-1', 'transfer-1', 'install', 10, 100)
    const app = withUser('operator', createTransferRegistryRoutes({ registry }))
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { transfers: Array<{ transferId: string; deviceId: string; kind: string; state: string }> }
    expect(body.transfers).toHaveLength(1)
    expect(body.transfers[0]).toMatchObject({ transferId: 'transfer-1', deviceId: 'dev-1', kind: 'install', state: 'running' })
  })

  test('a running AND a finished transfer both appear, each shaped per TransferRecordSchema', async () => {
    const registry = createTransferRegistry()
    registry.progress('dev-1', 'transfer-running', 'push', 50, 200)
    registry.done('dev-2', 'transfer-done', 'pull', true)
    const app = withUser('admin', createTransferRegistryRoutes({ registry }))
    const res = await app.request('/')
    const body = (await res.json()) as {
      transfers: Array<{ transferId: string; state: string; ok: boolean | null; sent: number; total: number | null; startedAt: number; updatedAt: number }>
    }
    expect(body.transfers).toHaveLength(2)
    const byId = new Map(body.transfers.map((t) => [t.transferId, t]))
    expect(byId.get('transfer-running')).toMatchObject({ state: 'running', ok: null, sent: 50, total: 200 })
    expect(byId.get('transfer-done')).toMatchObject({ state: 'done', ok: true, sent: 0, total: null })
    for (const t of body.transfers) {
      expect(typeof t.startedAt).toBe('number')
      expect(typeof t.updatedAt).toBe('number')
    }
  })
})
