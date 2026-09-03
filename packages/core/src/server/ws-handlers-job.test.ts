import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { JobDetail, JobInfo, ServerMessage } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { Role } from '../auth/service'
import { openDb, runMigrations, type Db } from '../db'
import { createActivityRegistry } from '../activity/registry'
import type { JobService } from '../services/job-service'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * WS `job.cancel` (security fix, plan 09 §4.4): this message used to call
 * `deps.jobs.cancel` with no permission or ownership check at all, so any
 * authenticated operator could cancel any job on any device, farm-wide —
 * the same bug `api/jobs.ts`'s REST route had. The fix mirrors `shell.exec`
 * above it in `ws-handlers.ts`: resolve the role fresh, check before
 * anything else, server-authoritative (spec §10.1).
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
    data: { userId: null },
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

function fakeJobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    jobId: 'job-1',
    deviceId: 'dev-1',
    scriptId: 'internal:sleep',
    scriptName: null,
    scriptVersion: null,
    status: 'queued',
    error: null,
    failureClass: null,
    priority: 0,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    batchId: null,
    batchSeq: null,
    expiresAt: null,
    errorPhase: null,
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    peakRssBytes: null,
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    resultStatus: null,
    resultSummary: null,
    ...overrides,
  }
}

function fakeJobDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    ...fakeJobInfo(overrides),
    result: null,
    params: null,
    resultBytes: null,
    resultIssues: null,
    resultSchema: null,
    ...overrides,
  }
}

/** A real, empty registry — `job.cancel` never touches it, so a fake-with-throws would be over-engineering here. */
function unusedActivityRegistry(): ReturnType<typeof createActivityRegistry> {
  return createActivityRegistry({ log: createLogger('test'), controlIdleSec: () => 30, onChange: () => {} })
}

function setUpHandler(opts: {
  role?: Role
  getResult?: JobDetail | null
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
}): {
  handler: ReturnType<typeof createWsMessageHandler>
  cancelCalls: Array<{ jobId: string; opts?: { cancelDescendants?: boolean } }>
  auditCalls: Parameters<AuditLogger['record']>[0][]
} {
  const db = setUpDb()
  const log = createLogger('test')
  const cancelCalls: Array<{ jobId: string; opts?: { cancelDescendants?: boolean } }> = []
  const auditCalls: Parameters<AuditLogger['record']>[0][] = []
  const getResult = opts.getResult === undefined ? fakeJobDetail() : opts.getResult
  const jobs: JobService = {
    enqueue: () => {
      throw new Error('not used')
    },
    cancel: (jobId, cancelOpts) => {
      cancelCalls.push({ jobId, opts: cancelOpts })
      return { job: fakeJobInfo({ jobId }), cancelledDescendants: cancelOpts?.cancelDescendants ? 4 : 0 }
    },
    get: () => getResult,
    list: () => ({ jobs: [], nextCursor: null, total: 0 }),
    // Plan 99 §3.5, §4.9, step 99.8 — not exercised by these job-handler
    // tests; present only so this fixture keeps satisfying `JobService`.
    nodes: () => ({ items: [], finalized: false }),
    resume: () => {
      throw new Error('not used')
    },
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
    states: { current: () => null },
    jobs,
    adb: () => null,
    db,
    broadcast: () => {},
    recorder: { record: () => {}, stop: async () => {} },
    audit: { record: (input) => void auditCalls.push(input), list: () => [] },
    isLogInputTextEnabled: () => false,
    roleOf: () => opts.role ?? 'admin',
    ...(opts.getDeviceOwner ? { getDeviceOwner: opts.getDeviceOwner } : {}),
    shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} } as unknown as WsHandlerDeps['adbEndpoint'],
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    log,
  }
  return { handler: createWsMessageHandler(deps), cancelCalls, auditCalls }
}

describe('WS job.cancel — ownership/permission check (security fix, plan 09 §4.4)', () => {
  test('an operator without job.cancel.any is refused cancelling a job on a device owned by someone else', async () => {
    const { handler, cancelCalls, auditCalls } = setUpHandler({
      role: 'operator',
      getDeviceOwner: () => ({ ownerId: 'someone-else' }),
    })
    const a = fakeConn()
    a.ws.data = { userId: 'u1' } as never

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'job.cancel', id: 'c1', payload: { jobId: 'job-1' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('auth.forbidden')
    expect(cancelCalls).toHaveLength(0)
    expect(auditCalls).toHaveLength(0)
  })

  test('an operator CAN cancel a job on a device they own — ordinary operator work — and it is audited', async () => {
    const { handler, cancelCalls, auditCalls } = setUpHandler({
      role: 'operator',
      getDeviceOwner: () => ({ ownerId: 'u1' }),
    })
    const a = fakeConn()
    a.ws.data = { userId: 'u1' } as never

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'job.cancel', id: 'c1', payload: { jobId: 'job-1' } }))

    expect(a.sent.find((m) => m.type === 'error')).toBeUndefined()
    expect(cancelCalls).toEqual([{ jobId: 'job-1', opts: undefined }])
    expect(auditCalls).toEqual([{ userId: 'u1', action: 'job.cancel', target: 'job-1', meta: { deviceId: 'dev-1' } }])
    const status = a.sent.find((m) => m.type === 'job.status')
    expect(status).toBeDefined()
  })

  test('an operator CAN cancel a job on an unowned device (ownerId: null)', async () => {
    const { handler, cancelCalls } = setUpHandler({ role: 'operator', getDeviceOwner: () => ({ ownerId: null }) })
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'job.cancel', id: 'c1', payload: { jobId: 'job-1' } }))

    expect(a.sent.find((m) => m.type === 'error')).toBeUndefined()
    expect(cancelCalls).toHaveLength(1)
  })

  test('an admin can cancel any job regardless of device ownership (job.cancel.any)', async () => {
    const { handler, cancelCalls } = setUpHandler({ role: 'admin', getDeviceOwner: () => ({ ownerId: 'someone-else' }) })
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'job.cancel', id: 'c1', payload: { jobId: 'job-1' } }))

    expect(a.sent.find((m) => m.type === 'error')).toBeUndefined()
    expect(cancelCalls).toHaveLength(1)
  })

  test('a job that does not exist refuses with job_not_found and never reaches the service', async () => {
    const { handler, cancelCalls } = setUpHandler({ role: 'operator', getResult: null })
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'job.cancel', id: 'c1', payload: { jobId: 'nope' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('job_not_found')
    expect(cancelCalls).toHaveLength(0)
  })

  test('no `getDeviceOwner` wired (a test harness / host that has not wired auth) is permissive, the same default every optional ACL dep here uses', async () => {
    const { handler, cancelCalls } = setUpHandler({ role: 'operator' })
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'job.cancel', id: 'c1', payload: { jobId: 'job-1' } }))

    expect(a.sent.find((m) => m.type === 'error')).toBeUndefined()
    expect(cancelCalls).toHaveLength(1)
  })
})
