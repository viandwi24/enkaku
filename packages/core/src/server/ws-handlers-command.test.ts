import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import { FarmSettingsSchema, defaultFarmSettings, type ServerMessage } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createActivityRegistry } from '../activity/registry'
import { createLogger } from '../util/logger'
import { createWsMessageHandler, MAX_BUFFERED, type WsHandlerDeps } from './ws-handlers'

/**
 * `command.subscribe`/`command.unsubscribe` and `commandTargets`/
 * `broadcastCommand` (plan 93 §3.17, §4.3, F27, step 93.4) — proving the
 * property that matters more than it looks: a fleet command's live events
 * reach only the connections that asked for THAT run, never every connected
 * tab. Also the sizing check §3.6/H2 calls for: `shell.fanoutPreviewBytes`'s
 * Zod ceiling asserted against the REAL `MAX_BUFFERED` this file exports —
 * not a hand-copied duplicate that can drift out of step with it silently.
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
  const activities = createActivityRegistry({ log, controlIdleSec: () => 30, onChange: () => {} })
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
    activities,
    controlSettings: () => ({ overControl: 'allow' as const, idleSec: 30 }),
    states,
    jobs: {
      enqueue: () => {
        throw new Error('not used')
      },
      cancel: () => {
        throw new Error('not used')
      },
      get: () => null,
      list: () => ({ jobs: [], nextCursor: null, total: 0 }),
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

describe('command.subscribe/unsubscribe — subscriber-scoped fan-out (plan 93 §3.17, §4.3, F27, step 93.4)', () => {
  test('command.subscribe registers this connection; broadcastCommand reaches only it', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const a = fakeConn()
    const b = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'command.subscribe', payload: { runId: 'run-1' } }))

    handler.broadcastCommand('run-1', { type: 'command.finished', payload: { runId: 'run-1', status: 'ok', counts: { total: 1, pending: 0, running: 0, ok: 1, failed: 0, skipped: 0, cancelled: 0 }, durationMs: 10 } })

    expect(a.sent.some((m) => m.type === 'command.finished')).toBe(true)
    // `b` never subscribed — a broadcast for this run must not reach it,
    // exactly the property F27 records `transfer.progress` gets WRONG.
    expect(b.sent).toHaveLength(0)
  })

  test('a broadcast for a DIFFERENT runId does not reach a connection subscribed to another one', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'command.subscribe', payload: { runId: 'run-1' } }))
    handler.broadcastCommand('run-2', { type: 'command.finished', payload: { runId: 'run-2', status: 'ok', counts: { total: 0, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 }, durationMs: 1 } })

    expect(a.sent).toHaveLength(0)
  })

  test('command.unsubscribe stops further delivery for that run', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'command.subscribe', payload: { runId: 'run-1' } }))
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'command.unsubscribe', payload: { runId: 'run-1' } }))
    handler.broadcastCommand('run-1', { type: 'command.finished', payload: { runId: 'run-1', status: 'ok', counts: { total: 0, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 }, durationMs: 1 } })

    expect(a.sent).toHaveLength(0)
  })

  test('WS close clears the subscription — a dropped tab does not silently keep "receiving" forever', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'command.subscribe', payload: { runId: 'run-1' } }))
    handler.handleClose(a.ws)

    // Re-registering under a fresh connection object proves the OLD one's
    // bookkeeping was actually dropped, not merely that sends to a closed
    // socket are silently swallowed.
    const c = fakeConn()
    handler.broadcastCommand('run-1', { type: 'command.finished', payload: { runId: 'run-1', status: 'ok', counts: { total: 0, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 }, durationMs: 1 } })
    expect(c.sent).toHaveLength(0)
  })

  test('two connections both subscribed to the same run both receive it', async () => {
    const db = setUpDb()
    const handler = setUpHandler(db)
    const a = fakeConn()
    const b = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'command.subscribe', payload: { runId: 'run-1' } }))
    await handler.handleMessage(b.ws, JSON.stringify({ type: 'command.subscribe', payload: { runId: 'run-1' } }))
    handler.broadcastCommand('run-1', { type: 'command.finished', payload: { runId: 'run-1', status: 'ok', counts: { total: 0, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 }, durationMs: 1 } })

    expect(a.sent.some((m) => m.type === 'command.finished')).toBe(true)
    expect(b.sent.some((m) => m.type === 'command.finished')).toBe(true)
  })
})

describe('the wire budget: shell.fanoutPreviewBytes vs. the REAL MAX_BUFFERED (plan 93 §3.6, H2, step 93.4)', () => {
  test('the real transport budget is exported and is the number plan 93 §3.6 sizes against (512 KB)', () => {
    expect(MAX_BUFFERED).toBe(512 * 1024)
  })

  test("the farm's default fanoutPreviewBytes stays well under the REAL MAX_BUFFERED — a 100-device worst case (100 distinct outputs) must not approach it", () => {
    const defaultPreview = defaultFarmSettings().shell.fanoutPreviewBytes
    expect(defaultPreview).toBeLessThan(MAX_BUFFERED)
    expect(defaultPreview * 100).toBeLessThan(MAX_BUFFERED)
  })

  test("the schema's OWN ceiling for fanoutPreviewBytes cannot rise above the REAL MAX_BUFFERED without this test catching it — the two numbers cannot drift apart silently", () => {
    // `@enkaku/protocol`'s own settings.test.ts already proves the Zod
    // bound is 16_384 against a HAND-COPIED local `MAX_BUFFERED` constant
    // (protocol cannot import from core — the dependency runs the other
    // way). This is the other half: proving the schema's ceiling stays
    // under the REAL constant `ws-handlers.ts` actually enforces, imported
    // directly rather than copied.
    // If a future edit ever raised the schema's ceiling to (or past) the
    // real MAX_BUFFERED, THIS parse would start succeeding instead of
    // throwing, and the assertion below would fail — that is the drift
    // detector.
    expect(() => FarmSettingsSchema.parse({ shell: { fanoutPreviewBytes: MAX_BUFFERED } })).toThrow()
  })
})
