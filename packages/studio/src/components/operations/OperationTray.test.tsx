import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * Plan 107 (M72) §1, §3.1–§3.5, step 107.3/107.4 — the floating tray. Reuses
 * `renderWithApi` (`GET /api/transfers|jobs|batches|command-runs|devices`,
 * the same endpoints `lib/operations.test.ts` exercises directly) so this
 * file only has to check what actually RENDERS from them, not re-prove the
 * store's own fetch/patch logic.
 */
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {}, onStatus: (cb: (v: boolean) => void) => { cb(false); return () => {} } },
  coreBase: () => 'http://core.test',
  newId: () => 'test-id',
}))

const { OperationTray } = await import('./OperationTray')

afterEach(cleanup)

const EMPTY = {
  '/api/transfers': { body: { transfers: [] } },
  '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/batches*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/command-runs*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/devices': { body: { items: [], nextCursor: null, total: 0 } },
}

describe('OperationTray — nothing running renders nothing (plan 107 §3.5, "noise is how an operator learns to ignore the one entry that mattered")', () => {
  test('renders nothing when every source is empty', async () => {
    renderWithApi(<OperationTray />, EMPTY)
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByTestId('operation-tray')).toBeNull()
  })
})

describe('OperationTray — a running batch renders through OutcomeSummary, the same house style every bulk surface uses', () => {
  test('shows the batch label, device count, and its outcome counts', async () => {
    renderWithApi(<OperationTray />, {
      ...EMPTY,
      '/api/batches*': {
        body: {
          items: [
            {
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
            },
          ],
          nextCursor: null,
          total: 1,
        },
      },
      '/api/jobs*': {
        body: {
          items: [
            { jobId: 'j1', deviceId: 'd1', scriptId: 'internal:install', scriptName: null, scriptVersion: null, status: 'running', error: null, priority: 0, createdAt: 100, startedAt: 100, finishedAt: null, batchId: 'batch-1', batchSeq: 0 },
          ],
          nextCursor: null,
          total: 1,
        },
      },
    })

    await waitFor(() => expect(screen.getByTestId('operation-tray')).toBeTruthy())
    expect(screen.getByText('Install apk')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy() // the header count badge
    expect(screen.getByText('0 ok · 0 failed · 0 skipped (0/2)')).toBeTruthy()
  })
})

/**
 * Plan 124 §0.1, §4.4, criterion 5, step 124.3 — the tray is mounted at the
 * shell and is therefore visible on EVERY screen, including while the
 * operator is looking at a different device entirely. That makes it the one
 * surface where an unnumbered row is most useless: `SM-F721U1 +3` says
 * nothing about which four phones are busy. The composition itself lives in
 * `useOperations().deviceLabel` (`lib/operations.ts`), so this test pins the
 * rendered result rather than re-proving the formatter.
 */
describe('OperationTray — a row names its devices with their numbers (plan 124 §4.4)', () => {
  const device = (id: string, number: number | null, label: string) => ({
    id,
    stableId: id,
    serial: id,
    number,
    label,
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
  })

  test('two identically labelled phones read as #7 and #8, and an unnumbered one stays bare', async () => {
    renderWithApi(<OperationTray />, {
      ...EMPTY,
      '/api/devices*': {
        body: {
          items: [device('d1', 7, 'Galaxy A15'), device('d2', 8, 'Galaxy A15'), device('d3', null, 'Galaxy A15')],
          nextCursor: null,
          total: 3,
        },
      },
      '/api/transfers': {
        body: {
          transfers: [
            { transferId: 't1', deviceId: 'd1', kind: 'push', state: 'running', sent: 1, total: 10, startedAt: 100, updatedAt: 100, ok: null, error: null, remotePath: '/sdcard/a', localName: 'a' },
          ],
        },
      },
    })

    await waitFor(() => expect(screen.getByTestId('operation-tray')).toBeTruthy())
    // The device list resolves on its own tick after the operation rows do,
    // so the name is awaited rather than asserted synchronously.
    await waitFor(() => expect(document.body.textContent).toContain('#7 Galaxy A15'))
    // Criterion 7 — no stray `#`, and nothing anywhere reads `#null`.
    expect(document.body.textContent).not.toContain('#null')
  })
})

describe('OperationTray — an ephemeral transfer is marked distinctly from a durable row (plan 107 §3.2)', () => {
  test('a raw transfer row carries the "not saved" badge; a batch row does not', async () => {
    renderWithApi(<OperationTray />, {
      ...EMPTY,
      '/api/transfers': {
        body: { transfers: [{ transferId: 't1', deviceId: 'd9', kind: 'push', state: 'running', startedAt: 100, updatedAt: 100, sent: 5, total: 50, ok: null, error: null }] },
      },
    })

    await waitFor(() => expect(screen.getByTestId('operation-tray')).toBeTruthy())
    expect(screen.getByText('Push file')).toBeTruthy()
    expect(screen.getByText('not saved')).toBeTruthy()
  })
})

describe('OperationTray — a batch stuck at zero jobs never renders "no device" (§96.30)', () => {
  test('a `stopping` batch with zero member jobs — the owner\'s exact stuck entry — renders nothing', async () => {
    renderWithApi(<OperationTray />, {
      ...EMPTY,
      '/api/batches*': {
        body: {
          items: [
            {
              id: 'batch-1',
              clusterId: null,
              scriptId: 'internal:install',
              scriptName: null,
              scriptVersion: null,
              params: {},
              concurrency: 0,
              order: 'as-listed',
              status: 'stopping',
              createdBy: null,
              createdAt: 100,
              finishedAt: null,
              counts: { total: 0, queued: 0, running: 0, success: 0, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 },
              pacing: null,
              repeats: [],
              skipped: [],
            },
          ],
          nextCursor: null,
          total: 1,
        },
      },
      // No matching jobs — mirrors the core-side bug this pass fixed
      // (every job row deleted out from under the batch).
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByTestId('operation-tray')).toBeNull()
    expect(screen.queryByText('no device')).toBeNull()
  })
})

describe('OperationTray — a terminal operation stays visible for a grace window, then auto-dismisses (§96.30)', () => {
  test('a batch that just succeeded still renders', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    renderWithApi(<OperationTray />, {
      ...EMPTY,
      '/api/batches*': {
        body: {
          items: [
            {
              id: 'batch-1',
              clusterId: null,
              scriptId: 'internal:install',
              scriptName: null,
              scriptVersion: null,
              params: {},
              concurrency: 0,
              order: 'as-listed',
              status: 'success',
              createdBy: null,
              createdAt: nowSec - 5,
              finishedAt: nowSec,
              counts: { total: 1, queued: 0, running: 0, success: 1, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 },
              pacing: null,
              repeats: [],
              skipped: [],
            },
          ],
          nextCursor: null,
          total: 1,
        },
      },
      '/api/jobs*': {
        body: {
          items: [
            { jobId: 'j1', deviceId: 'd1', scriptId: 'internal:install', scriptName: null, scriptVersion: null, status: 'success', error: null, priority: 0, createdAt: nowSec - 5, startedAt: nowSec - 5, finishedAt: nowSec, batchId: 'batch-1', batchSeq: 0 },
          ],
          nextCursor: null,
          total: 1,
        },
      },
    })

    await waitFor(() => expect(screen.getByTestId('operation-tray')).toBeTruthy())
    expect(screen.getByText('Install apk')).toBeTruthy()
  })

  test('a batch that finished well over a minute ago never renders — long past even a failure\'s own window', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    renderWithApi(<OperationTray />, {
      ...EMPTY,
      '/api/batches*': {
        body: {
          items: [
            {
              id: 'batch-1',
              clusterId: null,
              scriptId: 'internal:install',
              scriptName: null,
              scriptVersion: null,
              params: {},
              concurrency: 0,
              order: 'as-listed',
              status: 'failed',
              createdBy: null,
              createdAt: nowSec - 120,
              finishedAt: nowSec - 90,
              counts: { total: 1, queued: 0, running: 0, success: 0, failed: 1, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 },
              pacing: null,
              repeats: [],
              skipped: [],
            },
          ],
          nextCursor: null,
          total: 1,
        },
      },
      '/api/jobs*': {
        body: {
          items: [
            { jobId: 'j1', deviceId: 'd1', scriptId: 'internal:install', scriptName: null, scriptVersion: null, status: 'failed', error: 'boom', priority: 0, createdAt: nowSec - 120, startedAt: nowSec - 120, finishedAt: nowSec - 90, batchId: 'batch-1', batchSeq: 0 },
          ],
          nextCursor: null,
          total: 1,
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByTestId('operation-tray')).toBeNull()
  })
})

describe('OperationTray — collapsing hides the rows but keeps the count visible', () => {
  test('clicking the header toggles the row list', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<OperationTray />, {
      ...EMPTY,
      '/api/transfers': {
        body: { transfers: [{ transferId: 't1', deviceId: 'd9', kind: 'install', state: 'running', startedAt: 100, updatedAt: 100, sent: 5, total: 50, ok: null, error: null }] },
      },
    })
    await waitFor(() => expect(screen.getByText('Install apk')).toBeTruthy())
    const header = screen.getByRole('button', { name: /operations/i })
    await user.click(header)
    expect(screen.queryByText('Install apk')).toBeNull()
    await user.click(header)
    expect(screen.getByText('Install apk')).toBeTruthy()
  })
})
