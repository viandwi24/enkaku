import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { ServerMessage } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createLeaseManager } from '../lease/lease-manager'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * `handler.broadcastTransfer`/`deviceTargets` (plan 93 §4.6, §5 step 93.9,
 * closing F27) — proving the property the plan calls out explicitly: a
 * viewer of device A does NOT receive device B's transfer progress. Before
 * this step, `transfer.progress`/`transfer.done` went through
 * `hub.broadcast` and reached every connected tab regardless of what it was
 * looking at; this is the same subscriber-scoping `ws-handlers-command.test.ts`
 * already proves for `broadcastCommand`, applied to the transfer surface.
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

function setUpHandler(db: Db) {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const leases = createLeaseManager({
    states,
    jobStore,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
    log,
    onJobLeaseExpired: () => {},
  })
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
    leases,
    jobs: {
      enqueue: () => {
        throw new Error('not used')
      },
      cancel: () => {
        throw new Error('not used')
      },
      get: () => null,
      list: () => ({ jobs: [], nextCursor: null, total: 0 }),
      assists: () => [],
      nodes: () => ({ items: [], finalized: false }),
      resume: () => {
        throw new Error('not used')
      },
    },
    broadcast: () => {},
    recorder: { record: () => {}, stop: async () => {} },
    audit: { record: () => {}, list: () => [] },
    isLogInputTextEnabled: () => false,
    roleOf: () => 'admin',
    shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
    adb: () => null as unknown as AdbClient,
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    db,
    log,
  }
  return createWsMessageHandler(deps)
}

describe('broadcastTransfer — subscriber-scoped fan-out (plan 93 §4.6, §5 step 93.9, F27)', () => {
  test('a viewer of the device (log.subscribe presence) receives transfer.progress and transfer.done', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const viewer = fakeConn()
    await handler.handleMessage(viewer.ws, JSON.stringify({ type: 'log.subscribe', payload: { deviceId: 'dev-1', streams: ['input'] } }))

    handler.broadcastTransfer('dev-1', { type: 'transfer.progress', payload: { deviceId: 'dev-1', transferId: 't1', kind: 'pull', sent: 5, total: 10 } })
    handler.broadcastTransfer('dev-1', { type: 'transfer.done', payload: { deviceId: 'dev-1', transferId: 't1', kind: 'pull', ok: true } })

    expect(viewer.sent.some((m) => m.type === 'transfer.progress')).toBe(true)
    expect(viewer.sent.some((m) => m.type === 'transfer.done')).toBe(true)
  })

  test('a viewer of device A does NOT receive device B\'s transfer progress — the exact property this step must prove', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const viewerA = fakeConn()
    const viewerB = fakeConn()
    await handler.handleMessage(viewerA.ws, JSON.stringify({ type: 'log.subscribe', payload: { deviceId: 'dev-a', streams: ['input'] } }))
    await handler.handleMessage(viewerB.ws, JSON.stringify({ type: 'log.subscribe', payload: { deviceId: 'dev-b', streams: ['input'] } }))

    handler.broadcastTransfer('dev-a', { type: 'transfer.progress', payload: { deviceId: 'dev-a', transferId: 't1', kind: 'push', sent: 1, total: 100 } })

    expect(viewerA.sent.some((m) => m.type === 'transfer.progress')).toBe(true)
    expect(viewerB.sent.some((m) => m.type === 'transfer.progress')).toBe(false)
  })

  test('a connection with no presence on the device receives nothing — no farm-wide broadcast', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const bystander = fakeConn()

    handler.broadcastTransfer('dev-1', { type: 'transfer.progress', payload: { deviceId: 'dev-1', transferId: 't1', kind: 'pull', sent: 1, total: null } })

    expect(bystander.sent.length).toBe(0)
  })

  test('WS close clears presence — a dropped tab does not silently keep "receiving" forever', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const viewer = fakeConn()
    await handler.handleMessage(viewer.ws, JSON.stringify({ type: 'log.subscribe', payload: { deviceId: 'dev-1', streams: ['input'] } }))
    handler.handleClose(viewer.ws)

    handler.broadcastTransfer('dev-1', { type: 'transfer.progress', payload: { deviceId: 'dev-1', transferId: 't1', kind: 'pull', sent: 1, total: null } })

    expect(viewer.sent.length).toBe(0)
  })
})
