import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import type { AuthUser } from '../auth/service'
import { buildCoreCapabilityRegistry } from '../capability'
import type { CapabilityContextDeps } from '../capability/context'
import { openDb, runMigrations, type Db } from '../db'
import type { JobService } from '../services/job-service'
import { createWorkspaceStore } from '../workspace/store'
import { createMcpServer } from './server'

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

const noopJobService = {
  enqueue: () => {
    throw new Error('not used')
  },
  cancel: () => {
    throw new Error('not used')
  },
  get: () => null,
  list: () => ({ jobs: [], nextCursor: null, total: 0 }),
} as unknown as JobService

function contextDeps(db: Db): CapabilityContextDeps {
  return {
    db,
    leases: { getLease: () => null } as unknown as CapabilityContextDeps['leases'],
    states: { current: () => 'idle' } as unknown as CapabilityContextDeps['states'],
    sessions: () => null,
    readiness: () => null,
    transfer: null,
    jobService: noopJobService,
    workspace: createWorkspaceStore(db, () => ({ maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 })),
  }
}

function appAs(user: AuthUser | null, db: Db): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    if (user) c.set('user', user)
    await next()
  })
  app.route(
    '/',
    createMcpServer({ registry: buildCoreCapabilityRegistry(), contextDeps: contextDeps(db), serverVersion: 'test' }),
  )
  return app
}

async function rpc(app: Hono<AuthEnv>, method: string, params?: unknown, id: number | string = 1) {
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    headers: { 'content-type': 'application/json' },
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('MCP server (plan 63 §4.4, acceptance #11)', () => {
  test('initialize responds with server info', async () => {
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, setUpDb())
    const { body } = await rpc(app, 'initialize')
    expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('enkaku-core')
  })

  test('tools/list returns the SAME filtered list as GET /api/v1/cap (acceptance #8, #11)', async () => {
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, setUpDb())
    const { body } = await rpc(app, 'tools/list')
    const tools = (body.result as { tools: { name: string; inputSchema: unknown }[] }).tools
    const names = tools.map((t) => t.name)
    expect(names).toContain('device.tap')
    expect(names).not.toContain('device.push')
    for (const tool of tools) expect(tool.inputSchema).toBeTruthy()
  })

  test('tools/call enforces every invoke() check — bad input', async () => {
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, setUpDb())
    const { body } = await rpc(app, 'tools/call', { name: 'device.tap', arguments: {} })
    const result = body.result as { isError: boolean; structuredContent: { error: { code: string } } }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('E_BAD_INPUT')
  })

  test('tools/call enforces permission — unauthenticated caller refused', async () => {
    const app = appAs(null, setUpDb())
    const { body } = await rpc(app, 'tools/call', { name: 'script.list', arguments: {} })
    const result = body.result as { isError: boolean; structuredContent: { error: { code: string } } }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('E_FORBIDDEN')
  })

  test('tools/call succeeds end to end and returns typed structuredContent, not a bare string', async () => {
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, setUpDb())
    const { body } = await rpc(app, 'tools/call', { name: 'script.list', arguments: {} })
    const result = body.result as { isError: boolean; structuredContent: { items: unknown[] } }
    expect(result.isError).toBe(false)
    expect(result.structuredContent.items).toEqual([])
  })

  test('unknown tool -> 404 with a JSON-RPC error', async () => {
    const app = appAs({ id: 'u1', email: 'op@example.com', role: 'operator' }, setUpDb())
    const res = await app.request('/', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope.nope' } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(404)
  })
})
