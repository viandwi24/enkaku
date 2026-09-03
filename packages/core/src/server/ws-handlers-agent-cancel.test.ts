import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { ServerMessage } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { createActivityRegistry } from '../activity/registry'
import type { JobService } from '../services/job-service'
import { createLogger } from '../util/logger'
import type { AgentWsHandler } from './ws-handlers-agent'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * WS `agent.run.cancel` (sweep finding, not a permission gap): the HTTP
 * sibling (`POST /runs/:id/cancel`, `api/threads.ts`) has always recorded
 * `agent.run.cancel` in the audit trail; this WS message forwarded straight
 * to `deps.agent.cancelRun` and never called `audit.record` at all. Fixed to
 * match its sibling. No permission check is added here (and none is missing
 * relative to the HTTP route): `agent.run` is an OPERATOR permission, so
 * `requirePermission('agent.run')` already admits every authenticated actor
 * in this codebase's two-role model — the gap was purely in the audit trail.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function fakeConn(): { ws: ServerWebSocket<unknown>; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ws = {
    readyState: 1,
    data: { userId: 'u1' },
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

/** A real, empty registry — `agent.run.cancel` never touches it (see the doc comment above), so a fake-with-throws would be over-engineering here. */
function unusedActivityRegistry(): ReturnType<typeof createActivityRegistry> {
  return createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
}

function unusedJobService(): JobService {
  const unused = (name: string) => () => {
    throw new Error(`unexpected JobService.${name} call from an agent.run.cancel test`)
  }
  return { enqueue: unused('enqueue'), cancel: unused('cancel'), get: unused('get'), list: unused('list') } as unknown as JobService
}

function setUpHandler(): {
  handler: ReturnType<typeof createWsMessageHandler>
  cancelCalls: Array<{ runId: string; by: string | null }>
  auditCalls: Parameters<AuditLogger['record']>[0][]
} {
  const db = setUpDb()
  const log = createLogger('test')
  const cancelCalls: Array<{ runId: string; by: string | null }> = []
  const auditCalls: Parameters<AuditLogger['record']>[0][] = []
  const agent: AgentWsHandler = {
    subscribe: () => {},
    unsubscribe: () => {},
    cancelRun: (runId, cancelledBy) => cancelCalls.push({ runId, by: cancelledBy }),
    handleClose: () => {},
    publish: () => {},
    publishRunStarted: () => {},
    publishRunFinished: () => {},
    publishRaw: () => {},
  }
  const deps: WsHandlerDeps = {
    sessions: null,
    pairing: {
      request: async () => {
        throw new Error('not used')
      },
      submitCode: async () => {
        throw new Error('not used')
      },
    },
    activities: unusedActivityRegistry(),
    controlSettings: () => ({ overControl: 'allow', idleSec: 30 }),
    // `agent.run.cancel` never reads a device's status either — see the doc comment above.
    states: { current: () => null },
    jobs: unusedJobService(),
    adb: () => null,
    db,
    broadcast: () => {},
    recorder: { record: () => {}, stop: async () => {} },
    audit: { record: (input) => void auditCalls.push(input), list: () => [] },
    isLogInputTextEnabled: () => false,
    roleOf: () => 'operator',
    shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} } as unknown as WsHandlerDeps['adbEndpoint'],
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    log,
    agent,
  }
  return { handler: createWsMessageHandler(deps), cancelCalls, auditCalls }
}

describe('WS agent.run.cancel — audit parity with its HTTP sibling', () => {
  test('forwards to the agent handler AND records agent.run.cancel, matching POST /runs/:id/cancel', async () => {
    const { handler, cancelCalls, auditCalls } = setUpHandler()
    const conn = fakeConn()

    await handler.handleMessage(conn.ws, JSON.stringify({ type: 'agent.run.cancel', payload: { runId: 'run-1' } }))

    expect(cancelCalls).toEqual([{ runId: 'run-1', by: 'u1' }])
    expect(auditCalls).toEqual([{ userId: 'u1', action: 'agent.run.cancel', target: 'run-1', meta: {} }])
  })

  test('with no authenticated user (userId null), the audit entry still records a null actor rather than throwing', async () => {
    const { handler, auditCalls } = setUpHandler()
    const conn = fakeConn()
    conn.ws.data = { userId: null } as never

    await handler.handleMessage(conn.ws, JSON.stringify({ type: 'agent.run.cancel', payload: { runId: 'run-2' } }))

    expect(auditCalls).toEqual([{ userId: null, action: 'agent.run.cancel', target: 'run-2', meta: {} }])
  })
})
