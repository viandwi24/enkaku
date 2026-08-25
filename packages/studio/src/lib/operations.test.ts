import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import '../../happydom'
import type { BatchInfo, CommandRunSummary, DeviceInfo, JobInfo, TransferRecord } from '@enkaku/protocol'

/**
 * Plan 107 (M72) §3.1–§3.4, step 107.3 — `lib/operations.ts`'s pure
 * builders (no network, no store) plus the shared store's lifecycle,
 * mocked the same way `useRecording.test.ts` mocks `@/lib/ws` (a real
 * `WsClient` would try to open an actual `WebSocket` in happy-dom).
 * `@/lib/actions`/`@/lib/api` are ALSO mocked here (unlike `useRecording`)
 * because this store's whole point is reading `GET /api/transfers|jobs|
 * batches|command-runs|devices` — the fetch layer is the thing under test,
 * not incidental plumbing.
 */

type Handler = (msg: unknown) => void
let handlers: Set<Handler> = new Set()
const sendCalls: unknown[] = []

function emit(msg: unknown): void {
  for (const cb of [...handlers]) cb(msg)
}

mock.module('@/lib/ws', () => ({
  coreBase: () => 'http://core.test',
  ws: {
    send: (msg: unknown) => {
      sendCalls.push(msg)
    },
    on: (cb: Handler) => {
      handlers.add(cb)
      return () => handlers.delete(cb)
    },
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(false)
      return () => {}
    },
    onReconnected: () => () => {},
    isConnected: () => false,
    getSessionId: () => null,
    request: () => Promise.reject(new Error('not mocked')),
    connect: () => {},
  },
  newId: () => 'test-id',
}))

let apiResponses: Record<string, unknown> = {}
/**
 * `api()` moved to `@enkaku/ui` (plan 111 §3.3), so the mock follows it. The
 * replacement module is `{ api }` and nothing else, which is safe **only**
 * because the module under test is a lib: `operations.ts` imports exactly one
 * name from `@enkaku/ui`. A component test must never stub the whole package
 * this way — it would take all 30 components with it.
 */
mock.module('@enkaku/ui', () => ({
  api: (path: string) => {
    const body = apiResponses[path]
    if (body === undefined) return Promise.reject(new Error(`no mock for ${path}`))
    return Promise.resolve(body)
  },
  // Plan 124 step 124.3 — `useOperations().deviceLabel` composes the device
  // number now, so this module mock has to carry the real formatter. Copied
  // (three lines) rather than re-exported from `@enkaku/ui`, because the whole
  // point of the mock is that the real module is never loaded here: importing
  // it to fill one field would drag in the React component tree this test
  // deliberately avoids.
  formatDeviceName: (number: number | null | undefined, label: string) => (number == null ? label : `#${number} ${label}`),
}))

let devicesResponse: DeviceInfo[] = []
mock.module('@/lib/api', () => ({
  fetchDevices: () => Promise.resolve(devicesResponse),
}))

const {
  buildOperations,
  visibleTransfers,
  wantedTransferSubscriptions,
  resolveTargetDeviceIds,
  findReattach,
  operationMatchesAction,
  OperationsStore,
  useOperations,
  EMPTY_RAW,
} = await import('./operations')

afterEach(() => {
  cleanup()
  handlers = new Set()
  sendCalls.length = 0
  apiResponses = {}
  devicesResponse = []
})

function device(id: string, extra: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id,
    stableId: id,
    serial: id,
    label: id,
    androidVersion: '15',
    apiLevel: 35,
    screenW: 720,
    screenH: 1600,
    density: 280,
    status: 'idle',
    lastSeen: 1,
    battery: null,
    quarantineReason: null,
    tags: [],
    cluster: null,
    lastCrashAt: null,
    readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
    agent: 'absent',
    ...extra,
  } as DeviceInfo
}

function job(overrides: Partial<JobInfo>): JobInfo {
  return {
    jobId: 'job-1',
    deviceId: 'd1',
    scriptId: 'internal:install',
    scriptName: null,
    scriptVersion: null,
    status: 'running',
    error: null,
    priority: 0,
    createdAt: 100,
    startedAt: 100,
    finishedAt: null,
    batchId: null,
    batchSeq: null,
    ...overrides,
  } as JobInfo
}

function batch(overrides: Partial<BatchInfo>): BatchInfo {
  return {
    id: 'batch-1',
    clusterId: null,
    scriptId: 'internal:install',
    scriptName: null,
    scriptVersion: null,
    params: {},
    concurrency: 0,
    order: 'as-listed',
    status: 'running',
    createdBy: null,
    createdAt: 100,
    finishedAt: null,
    counts: { total: 2, queued: 0, running: 2, success: 0, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 },
    pacing: null,
    repeats: [],
    skipped: [],
    ...overrides,
  } as BatchInfo
}

function transfer(overrides: Partial<TransferRecord>): TransferRecord {
  return {
    transferId: 't1',
    deviceId: 'd1',
    kind: 'install',
    state: 'running',
    startedAt: 100,
    updatedAt: 100,
    origin: 'operator',
    sent: 10,
    total: 100,
    ok: null,
    error: null,
    ...overrides,
  } as TransferRecord
}

function commandRun(overrides: Partial<CommandRunSummary>): CommandRunSummary {
  return {
    id: 'run-1',
    cmd: 'getprop ro.build.version.release',
    target: { deviceIds: ['d1'] },
    savedCommandId: null,
    stageFirstN: 0,
    stage: 0,
    concurrency: 0,
    status: 'running',
    acknowledged: false,
    createdBy: null,
    startedAt: 100,
    finishedAt: null,
    counts: { total: 1, pending: 0, running: 1, ok: 0, failed: 0, skipped: 0, cancelled: 0 },
    ...overrides,
  } as CommandRunSummary
}

describe('buildOperations — the four durable/ephemeral kinds (plan 107 §3.2, §3.5)', () => {
  test('a non-terminal batch becomes one operation carrying its member device ids', () => {
    const raw = {
      ...EMPTY_RAW,
      batches: [batch({})],
      jobs: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1' }), job({ jobId: 'j2', deviceId: 'd2', batchId: 'batch-1' })],
    }
    const ops = buildOperations(raw, [])
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ key: 'batch:batch-1', kind: 'batch', durable: true, deviceIds: ['d1', 'd2'], actionScriptId: 'internal:install' })
  })

  test('a terminal batch (success/failed/cancelled) with no `finishedAt` to judge recency from never appears (§96.30)', () => {
    const raw = { ...EMPTY_RAW, batches: [batch({ status: 'success' })] }
    expect(buildOperations(raw, [])).toHaveLength(0)
  })

  test('a `queued` batch never appears, even with real member jobs — "minimal yang lagi progress" (§96.30, plan 107 §5 step 107.7)', () => {
    const raw = {
      ...EMPTY_RAW,
      batches: [batch({ status: 'queued' })],
      jobs: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1', status: 'queued' })],
    }
    expect(buildOperations(raw, [])).toHaveLength(0)
  })

  test('a batch with zero member device ids never appears, whatever its status — reproduces the owner\'s exact stuck tray entry (§96.30)', () => {
    // The core-side bug this pass fixed: a batch stuck `stopping` after
    // every one of its job rows was deleted (a forgotten device). Even if
    // this row's status were somehow still non-terminal by the time Studio
    // reads it, an operation with no target must never render "no device".
    const raw = { ...EMPTY_RAW, batches: [batch({ id: 'batch-1', status: 'stopping' })], jobs: [] }
    expect(buildOperations(raw, [])).toHaveLength(0)
  })

  test('a standalone job (batchId null, running/queued) is its own operation; a batch member job is not counted twice', () => {
    const raw = {
      ...EMPTY_RAW,
      jobs: [job({ jobId: 'standalone', deviceId: 'd3', batchId: null, status: 'queued' }), job({ jobId: 'member', deviceId: 'd1', batchId: 'batch-1' })],
      batches: [batch({})],
    }
    const ops = buildOperations(raw, [])
    const keys = ops.map((o) => o.key)
    expect(keys).toContain('job:standalone')
    expect(keys).not.toContain('job:member')
  })

  test('a finished standalone job (success/failed/cancelled/expired) with no `finishedAt` to judge recency from never appears', () => {
    const raw = { ...EMPTY_RAW, jobs: [job({ jobId: 'j1', batchId: null, status: 'success' })] }
    expect(buildOperations(raw, [])).toHaveLength(0)
  })

  test('a running/awaiting-continue command run becomes one operation; ok/failed/cancelled with no `finishedAt` do not', () => {
    const raw = { ...EMPTY_RAW, commandRuns: [commandRun({ id: 'r1', status: 'running' }), commandRun({ id: 'r2', status: 'ok' })] }
    const ops = buildOperations(raw, [])
    expect(ops.map((o) => o.key)).toEqual(['command-run:r1'])
  })

  test('a device with agent "provisioning" gets a preparation entry; every other agent state does not', () => {
    const devices = [device('d1', { agent: 'provisioning' }), device('d2', { agent: 'ready' })]
    const ops = buildOperations(EMPTY_RAW, devices)
    expect(ops.map((o) => o.key)).toEqual(['preparation:d1'])
    expect(ops[0]?.durable).toBe(true)
  })

  test('a raw ephemeral transfer is `durable: false` and carries its byte progress', () => {
    const raw = { ...EMPTY_RAW, transfers: [transfer({ sent: 40, total: 100 })] }
    const ops = buildOperations(raw, [])
    expect(ops[0]).toMatchObject({ kind: 'transfer', durable: false, transfer: { sent: 40, total: 100 } })
  })

  describe('a preparation-origin transfer (plan 106 §5 step 106.8)', () => {
    test('is labelled "Device preparation — <kind>" — distinct from an operator-origin row of the same kind', () => {
      const raw = { ...EMPTY_RAW, transfers: [transfer({ transferId: 'op1', origin: 'operator', kind: 'install' }), transfer({ transferId: 'prep1', origin: 'preparation', kind: 'install' })] }
      const ops = buildOperations(raw, [])
      const opLabels = Object.fromEntries(ops.map((o) => [o.key, o.label]))
      expect(opLabels['transfer:op1']).toBe('Install apk')
      expect(opLabels['transfer:prep1']).toBe('Device preparation — Install apk')
    })

    test('has actionScriptId: null — it must never satisfy an operator\'s own install/push/pull re-attach check (§3.6)', () => {
      const raw = { ...EMPTY_RAW, transfers: [transfer({ transferId: 'prep1', origin: 'preparation', kind: 'install' })] }
      const ops = buildOperations(raw, [])
      expect(ops[0]?.actionScriptId).toBeNull()
      expect(operationMatchesAction(ops[0]!, 'install')).toBe(false)
    })

    test('an operator-origin (or absent-origin, the default) transfer keeps its ordinary actionScriptId and DOES match', () => {
      const raw = { ...EMPTY_RAW, transfers: [transfer({ transferId: 'op1', kind: 'install' })] }
      const ops = buildOperations(raw, [])
      expect(operationMatchesAction(ops[0]!, 'install')).toBe(true)
    })
  })
})

/**
 * The owner's own second ask: *"pas sukses/fail... beberapa detik setelahnya
 * otomatis hilang"* (on success/fail, a few seconds later it disappears on
 * its own). `nowMs` is passed explicitly throughout so these tests never
 * race the real clock.
 */
describe('buildOperations — a terminal operation stays visible for a grace window, then auto-dismisses (§96.30)', () => {
  const T0 = 1_000_000 // an arbitrary wall-clock instant, in seconds

  test('a batch that just succeeded is still shown; the same batch, well past its grace window, is not', () => {
    const raw = { ...EMPTY_RAW, batches: [batch({ status: 'success', finishedAt: T0 })], jobs: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1' })] }
    expect(buildOperations(raw, [], T0 * 1000 + 1000).map((o) => o.key)).toEqual(['batch:batch-1'])
    expect(buildOperations(raw, [], T0 * 1000 + 20_000)).toHaveLength(0)
  })

  test('a failed batch is shown three times longer than a success — the owner\'s own reading time matters more for a failure', () => {
    const raw = { ...EMPTY_RAW, batches: [batch({ status: 'failed', finishedAt: T0 })], jobs: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1' })] }
    // Past a clean success's own window, but still within a failure's.
    expect(buildOperations(raw, [], T0 * 1000 + 10_000).map((o) => o.key)).toEqual(['batch:batch-1'])
    expect(buildOperations(raw, [], T0 * 1000 + 20_000)).toHaveLength(0)
  })

  test('a cancelled batch gets the same longer window as a failure, not the shorter success one', () => {
    const raw = { ...EMPTY_RAW, batches: [batch({ status: 'cancelled', finishedAt: T0 })], jobs: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1' })] }
    expect(buildOperations(raw, [], T0 * 1000 + 10_000).map((o) => o.key)).toEqual(['batch:batch-1'])
  })

  test('a finished standalone job follows the identical rule', () => {
    const raw = { ...EMPTY_RAW, jobs: [job({ jobId: 'j1', batchId: null, status: 'success', finishedAt: T0 })] }
    expect(buildOperations(raw, [], T0 * 1000 + 1000).map((o) => o.key)).toEqual(['job:j1'])
    expect(buildOperations(raw, [], T0 * 1000 + 20_000)).toHaveLength(0)
  })

  test('a settled command run follows the identical rule', () => {
    const raw = { ...EMPTY_RAW, commandRuns: [commandRun({ id: 'r1', status: 'ok', finishedAt: T0 })] }
    expect(buildOperations(raw, [], T0 * 1000 + 1000).map((o) => o.key)).toEqual(['command-run:r1'])
    expect(buildOperations(raw, [], T0 * 1000 + 20_000)).toHaveLength(0)
  })

  test('a done transfer follows the identical rule, keyed on its own `ok`', () => {
    const raw = { ...EMPTY_RAW, transfers: [transfer({ transferId: 't1', state: 'done', ok: true, updatedAt: T0 })] }
    expect(buildOperations(raw, [], T0 * 1000 + 1000).map((o) => o.key)).toEqual(['transfer:t1'])
    expect(buildOperations(raw, [], T0 * 1000 + 20_000)).toHaveLength(0)
  })

  test('a still-progressing operation (running/queued-job/awaiting-continue/preparation) is never subject to the grace window at all', () => {
    const raw = { ...EMPTY_RAW, jobs: [job({ jobId: 'j1', batchId: null, status: 'running', finishedAt: null })] }
    // An absurdly large `nowMs` would expire any grace window — a
    // non-terminal operation must be unaffected by it.
    expect(buildOperations(raw, [], Number.MAX_SAFE_INTEGER).map((o) => o.key)).toEqual(['job:j1'])
  })
})

describe('visibleTransfers — a batch-driven install must not also show as a redundant per-device transfer row (plan 107 §3.5)', () => {
  test('a transfer covered by a non-terminal batch of the same action on the same device is hidden', () => {
    const raw = {
      transfers: [transfer({ transferId: 't1', deviceId: 'd1', kind: 'install' })],
      jobs: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1' })],
      batches: [batch({ scriptId: 'internal:install' })],
      commandRuns: [],
    }
    expect(visibleTransfers(raw)).toHaveLength(0)
    expect(buildOperations(raw, []).map((o) => o.kind)).toEqual(['batch'])
  })

  test('a transfer on a device NOT covered by any batch stays visible', () => {
    const raw = { ...EMPTY_RAW, transfers: [transfer({ transferId: 't1', deviceId: 'd9' })] }
    expect(visibleTransfers(raw)).toHaveLength(1)
  })

  test('a transfer covered by a batch of a DIFFERENT action stays visible (install batch does not hide a push transfer)', () => {
    const raw = {
      transfers: [transfer({ transferId: 't1', deviceId: 'd1', kind: 'push' })],
      jobs: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1' })],
      batches: [batch({ scriptId: 'internal:install' })],
      commandRuns: [],
    }
    expect(visibleTransfers(raw)).toHaveLength(1)
  })
})

describe('wantedTransferSubscriptions — only devices with a visible, running transfer', () => {
  test('a done transfer is not subscribed', () => {
    const raw = { ...EMPTY_RAW, transfers: [transfer({ deviceId: 'd1', state: 'done', ok: true })] }
    expect(wantedTransferSubscriptions(raw)).toEqual(new Set())
  })

  test('a running, batch-covered transfer is not subscribed either — the batch already gives coarse progress', () => {
    const raw = {
      transfers: [transfer({ transferId: 't1', deviceId: 'd1', state: 'running' })],
      jobs: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1' })],
      batches: [batch({ scriptId: 'internal:install' })],
      commandRuns: [],
    }
    expect(wantedTransferSubscriptions(raw)).toEqual(new Set())
  })

  test('a running, uncovered transfer IS subscribed', () => {
    const raw = { ...EMPTY_RAW, transfers: [transfer({ deviceId: 'd7', state: 'running' })] }
    expect(wantedTransferSubscriptions(raw)).toEqual(new Set(['d7']))
  })
})

describe('resolveTargetDeviceIds', () => {
  const pool = [{ id: 'd1', cluster: { id: 'c1' } }, { id: 'd2', cluster: { id: 'c1' } }, { id: 'd3', cluster: null }]

  test('single', () => expect(resolveTargetDeviceIds({ target: 'single', deviceId: 'd3', deviceIds: [], clusterId: '' }, pool)).toEqual(['d3']))
  test('single with no device chosen yet', () => expect(resolveTargetDeviceIds({ target: 'single', deviceId: '', deviceIds: [], clusterId: '' }, pool)).toEqual([]))
  test('devices', () => expect(resolveTargetDeviceIds({ target: 'devices', deviceId: '', deviceIds: ['d1', 'd3'], clusterId: '' }, pool)).toEqual(['d1', 'd3']))
  test('cluster reads current membership from the pool', () =>
    expect(resolveTargetDeviceIds({ target: 'cluster', deviceId: '', deviceIds: [], clusterId: 'c1' }, pool)).toEqual(['d1', 'd2']))
})

describe('operationMatchesAction', () => {
  test('matches only the exact internal:* scriptId for the given action', () => {
    const op = { actionScriptId: 'internal:push' } as Parameters<typeof operationMatchesAction>[0]
    expect(operationMatchesAction(op, 'push')).toBe(true)
    expect(operationMatchesAction(op, 'install')).toBe(false)
  })
})

describe('findReattach (plan 107 §3.6, step 107.5 — "partial overlap must be stated, never merged silently")', () => {
  const opInstallD1D2 = { key: 'batch:b1', kind: 'batch', durable: true, label: 'Install apk', deviceIds: ['d1', 'd2'], status: 'running', startedAt: 0, finishedAt: null, href: null, actionScriptId: 'internal:install' } as const

  test('no overlap → none, and the caller is free to submit', () => {
    expect(findReattach([opInstallD1D2], 'install', ['d9'])).toEqual({ overlap: 'none', operation: null, overlapping: [] })
  })

  test('empty target → none (nothing resolved yet, e.g. no device chosen)', () => {
    expect(findReattach([opInstallD1D2], 'install', [])).toEqual({ overlap: 'none', operation: null, overlapping: [] })
  })

  test('exact full overlap with ONE operation → silently re-attachable', () => {
    const r = findReattach([opInstallD1D2], 'install', ['d1', 'd2'])
    expect(r.overlap).toBe('full')
    expect(r.operation).toBe(opInstallD1D2)
  })

  test('partial overlap → named, never merged, operation stays null (the caller must not guess which one)', () => {
    const r = findReattach([opInstallD1D2], 'install', ['d1', 'd9'])
    expect(r.overlap).toBe('partial')
    expect(r.operation).toBeNull()
    expect(r.overlapping).toEqual([opInstallD1D2])
  })

  test('full overlap covered by TWO separate operations → full, but no single operation to point at', () => {
    const opA = { ...opInstallD1D2, key: 'batch:a', deviceIds: ['d1'] }
    const opB = { ...opInstallD1D2, key: 'batch:b', deviceIds: ['d2'] }
    const r = findReattach([opA, opB], 'install', ['d1', 'd2'])
    expect(r.overlap).toBe('full')
    expect(r.operation).toBeNull()
    expect(r.overlapping).toHaveLength(2)
  })

  test('a terminal (success) operation of the same action is never treated as running', () => {
    const done = { ...opInstallD1D2, status: 'success' }
    expect(findReattach([done], 'install', ['d1', 'd2']).overlap).toBe('none')
  })

  test('a different action (push) on the same devices does not count as an install overlap', () => {
    expect(findReattach([opInstallD1D2], 'push', ['d1', 'd2']).overlap).toBe('none')
  })
})

describe('OperationsStore / useOperations — fetch on mount, follow WS events, never a farm-wide per-chunk subscription (plan 107 §3.1, §3.3)', () => {
  test('mounts empty, then reflects a running batch fetched from the endpoints', async () => {
    apiResponses['/api/transfers'] = { transfers: [] }
    apiResponses['/api/jobs?limit=200'] = { items: [job({ jobId: 'j1', deviceId: 'd1', batchId: 'batch-1' })], nextCursor: null, total: 1 }
    apiResponses['/api/batches?limit=50'] = { items: [batch({})], nextCursor: null, total: 1 }
    apiResponses['/api/command-runs?limit=50'] = { items: [], nextCursor: null, total: 0 }
    devicesResponse = [device('d1', { number: 7, label: 'Galaxy A15' }), device('d2')]

    const store = new OperationsStore()
    const { result } = renderHook(() => useOperations(store))
    expect(result.current.operations).toEqual([])

    await waitFor(() => expect(result.current.operations).toHaveLength(1))
    expect(result.current.operations[0]?.key).toBe('batch:batch-1')
    expect(result.current.deviceLabel('d1')).toBe('#7 Galaxy A15')
    // Criterion 7 — a device with no number renders its bare label, never `#null`.
    expect(result.current.deviceLabel('d2')).toBe('d2')
    // Plan 124 §4.4, step 124.3 — the tray is visible on every screen, so its
    // rows have to name the phone, not the model. A device WITH a number
    // composes it; an id that is not in the snapshot at all stays bare rather
    // than inventing a `#` for a device the store cannot see.
    expect(result.current.deviceLabel('nope')).toBe('nope')
  })

  test('a running transfer on an uncovered device sends log.subscribe for THAT device only — never a farm-wide subscription', async () => {
    apiResponses['/api/transfers'] = { transfers: [transfer({ transferId: 't1', deviceId: 'd5', state: 'running' })] }
    apiResponses['/api/jobs?limit=200'] = { items: [], nextCursor: null, total: 0 }
    apiResponses['/api/batches?limit=50'] = { items: [], nextCursor: null, total: 0 }
    apiResponses['/api/command-runs?limit=50'] = { items: [], nextCursor: null, total: 0 }
    devicesResponse = []

    const store = new OperationsStore()
    renderHook(() => useOperations(store))

    await waitFor(() => expect(sendCalls).toContainEqual({ type: 'log.subscribe', payload: { deviceId: 'd5', streams: ['input'] } }))
    expect(sendCalls.filter((m) => (m as { type: string }).type === 'log.subscribe')).toHaveLength(1)
  })

  test('transfer.progress for a subscribed device patches sent/total live, with no extra fetch', async () => {
    apiResponses['/api/transfers'] = { transfers: [transfer({ transferId: 't1', deviceId: 'd5', state: 'running', sent: 1, total: 100 })] }
    apiResponses['/api/jobs?limit=200'] = { items: [], nextCursor: null, total: 0 }
    apiResponses['/api/batches?limit=50'] = { items: [], nextCursor: null, total: 0 }
    apiResponses['/api/command-runs?limit=50'] = { items: [], nextCursor: null, total: 0 }
    devicesResponse = []

    const store = new OperationsStore()
    const { result } = renderHook(() => useOperations(store))
    await waitFor(() => expect(result.current.operations).toHaveLength(1))

    act(() => emit({ type: 'transfer.progress', payload: { deviceId: 'd5', transferId: 't1', kind: 'install', sent: 55, total: 100 } }))
    expect(result.current.operations[0]?.transfer).toMatchObject({ sent: 55, total: 100 })

    act(() => emit({ type: 'transfer.done', payload: { deviceId: 'd5', transferId: 't1', kind: 'install', ok: true } }))
    expect(result.current.operations[0]?.status).toBe('success')
    // Finished — the store should have unsubscribed this device immediately rather than waiting on the next poll.
    expect(sendCalls).toContainEqual({ type: 'log.unsubscribe', payload: { deviceId: 'd5' } })
  })

  test('the last subscriber leaving unsubscribes every device and resets to empty', async () => {
    apiResponses['/api/transfers'] = { transfers: [transfer({ transferId: 't1', deviceId: 'd5', state: 'running' })] }
    apiResponses['/api/jobs?limit=200'] = { items: [], nextCursor: null, total: 0 }
    apiResponses['/api/batches?limit=50'] = { items: [], nextCursor: null, total: 0 }
    apiResponses['/api/command-runs?limit=50'] = { items: [], nextCursor: null, total: 0 }
    devicesResponse = []

    const store = new OperationsStore()
    const { result, unmount } = renderHook(() => useOperations(store))
    await waitFor(() => expect(result.current.operations).toHaveLength(1))

    unmount()
    expect(sendCalls).toContainEqual({ type: 'log.unsubscribe', payload: { deviceId: 'd5' } })

    const { result: second } = renderHook(() => useOperations(store))
    expect(second.current.operations).toEqual([])
  })

  test('two simultaneous callers share one underlying subscription (no duplicate fetches beyond the initial one each)', async () => {
    apiResponses['/api/transfers'] = { transfers: [] }
    apiResponses['/api/jobs?limit=200'] = { items: [], nextCursor: null, total: 0 }
    apiResponses['/api/batches?limit=50'] = { items: [], nextCursor: null, total: 0 }
    apiResponses['/api/command-runs?limit=50'] = { items: [], nextCursor: null, total: 0 }
    devicesResponse = []

    const store = new OperationsStore()
    const a = renderHook(() => useOperations(store))
    const b = renderHook(() => useOperations(store))
    await waitFor(() => expect(a.result.current.loading).toBe(false))
    expect(b.result.current.loading).toBe(false)
    a.unmount()
    b.unmount()
  })
})
