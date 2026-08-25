import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

// Plan 94 §3.7, §4.9, F25, step 94.10 — a live `job.waiting` push has no
// real `WebSocket` to arrive over in a test, so `@/lib/ws` is mocked the
// same way `app/console/page.test.tsx` already does it: `ws.on` just
// records callbacks, and `emit` below drives them directly. The page's
// static import is replaced by a dynamic one (`await import('./page')`,
// below) so this mock is in place BEFORE the page module — and its own
// `ws.on` call — first evaluates.
type Handler = (msg: unknown) => void
let handlers: Handler[] = []

mock.module('@/lib/ws', () => ({
  ws: {
    on: (cb: Handler) => {
      handlers.push(cb)
      return () => {
        handlers = handlers.filter((h) => h !== cb)
      }
    },
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(true)
      return () => {}
    },
    onReconnected: () => () => {},
    getSessionId: () => 'session-1',
    isConnected: () => true,
    send: () => {},
    request: () => Promise.reject(new Error('ws.request not used by the batch detail page')),
  },
  coreBase: () => 'http://core.test',
  newId: (() => {
    let n = 0
    return () => `test-id-${n++}`
  })(),
}))

function emit(msg: { type: string; payload?: unknown }): void {
  for (const h of handlers) h(msg)
}

const { default: BatchDetailPage } = await import('./page')

afterEach(() => {
  handlers = []
  cleanup()
})

const batch = {
  id: 'batch-1',
  clusterId: null,
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  params: {},
  concurrency: 0,
  order: 'as-listed',
  status: 'running',
  createdBy: null,
  createdAt: 0,
  finishedAt: null,
  counts: { total: 1, queued: 0, running: 1, success: 0, failed: 0, cancelled: 0 },
}

const job = {
  jobId: 'job-1',
  deviceId: 'device-1',
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  status: 'running',
  error: null,
  priority: 0,
  createdAt: 0,
  startedAt: 0,
  finishedAt: null,
  batchId: 'batch-1',
  batchSeq: 0,
}

describe('BatchDetailPage — smoke render', () => {
  test('loaded: shows the batch header and its job row', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the batch loads', () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed batch fetch shows a named error with a retry', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'batch boom' } } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('batch boom')).toBeTruthy())
  })

  test('no id in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<BatchDetailPage />, {})
    expect(screen.getByText('The address is missing an id parameter.')).toBeTruthy()
  })
})

/**
 * Plan 94 §3.9, §4.9, step 94.8 — "Stop" replaces "Cancel", with a dialog
 * naming what happens to running members before it sends `POST
 * /api/batches/:id/stop`.
 */
describe('BatchDetailPage — Stop (plan 94 §3.9, §4.9, step 94.8)', () => {
  test('a running batch shows Stop; confirming it calls POST /stop and reports the result', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'batch-1' })
    let stopCalled = false
    renderWithApi(
      <BatchDetailPage />,
      {
        '/api/batches/batch-1': { body: { batch, jobs: [job] } },
        '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
        '/api/batches/batch-1/stop': (req) => {
          stopCalled = req.method === 'POST'
          return { body: { cancelled: 0, aborted: 1, refused: 0, refusedDeviceIds: [] } }
        },
      },
    )
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Stop batch' }))
    const dialog = await screen.findByRole('alertdialog')
    // Names what happens to running members, not just "are you sure" (the task's own requirement).
    expect(within(dialog).getByText(/aborted/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Stop batch' }))

    await waitFor(() => expect(stopCalled).toBe(true))
  })

  test('a paced batch names that pacing stops too, in the confirmation dialog', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'batch-1' })
    const pacedBatch = {
      ...batch,
      pacing: { repeatCount: 4, intervalMinMs: 1000, intervalMaxMs: 2000, deviceIntervalMs: 0 },
      repeats: [{ deviceId: 'device-1', completed: 1, planned: 4 }],
    }
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: pacedBatch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Stop batch' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/No further repetition is planned/)).toBeTruthy()
  })

  test('a "stopping" batch shows the stopping badge and no Stop control', async () => {
    setSearchParams({ id: 'batch-1' })
    const stoppingBatch = { ...batch, status: 'stopping' }
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: stoppingBatch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('stopping')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Stop batch' })).toBeNull()
  })

  test('a stopped/terminal batch shows no Stop control', async () => {
    setSearchParams({ id: 'batch-1' })
    const doneBatch = { ...batch, status: 'success', counts: { total: 1, queued: 0, running: 0, success: 1, failed: 0, cancelled: 0 } }
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: doneBatch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Stop batch' })).toBeNull()
  })
})

/**
 * Plan 94 §3.7, §4.10, step 94.10 — "Repeat pacing" aside: the config the
 * batch was actually created with, per-device repetition progress, and the
 * delay/next-start each device shows — "makes §3.7's promise visible rather
 * than merely true".
 */
describe('BatchDetailPage — Repeat pacing aside (plan 94 §3.7, §4.10, step 94.10)', () => {
  const pacedBatch = {
    ...batch,
    pacing: { repeatCount: 4, intervalMinMs: 180_000, intervalMaxMs: 480_000, deviceIntervalMs: 30_000 },
    repeats: [{ deviceId: 'device-1', completed: 1, planned: 4 }],
  }

  test('an unpaced batch shows no Repeat pacing aside', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
    expect(screen.queryByText('repeat pacing')).toBeNull()
  })

  test('a paced batch shows its config and per-device progress', async () => {
    setSearchParams({ id: 'batch-1' })
    const nextJob = { ...job, jobId: 'job-2', status: 'queued', batchRepeat: 1, notBefore: Math.floor(Date.now() / 1000) + 42 }
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: pacedBatch, jobs: [{ ...job, batchRepeat: 0, pacedDelayMs: 30_000 }, nextJob] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
    expect(screen.getByText('repeat pacing')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy() // repetitions
    expect(screen.getByText('3–8 min')).toBeTruthy() // interval
    expect(screen.getByText('30 s')).toBeTruthy() // stagger
    expect(screen.getByText('1/4')).toBeTruthy() // completed/planned for device-1
  })

  test('a live job.waiting push with reason "paced" renders on the row (F25)', async () => {
    setSearchParams({ id: 'batch-1' })
    const queuedJob = { ...job, jobId: 'job-2', status: 'queued', batchRepeat: 1, notBefore: null }
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: pacedBatch, jobs: [queuedJob] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())

    emit({
      type: 'job.waiting',
      payload: { jobId: 'job-2', deviceId: 'device-1', waiting: true, reason: 'paced', heldBy: null, remainingSec: 4 },
    })
    await waitFor(() => expect(screen.getByText(/waiting — next repetition in 4s/)).toBeTruthy())
  })
})

// Plan 93 §3.12, §3.15, §4.8, F11, F15, H3, step 93.11 — the same
// three-part `OutcomeSummary`/`SkippedGroups` report every other bulk
// surface in this plan shows, and "Retry skipped" using the `?only=skipped`
// route step 93.8 already built.
describe('BatchDetailPage — outcome, skipped, and retry (plan 93 step 93.11)', () => {
  const skippedBatch = {
    ...batch,
    status: 'success',
    counts: { total: 1, queued: 0, running: 0, success: 0, failed: 1, cancelled: 0 },
    skipped: [{ deviceId: 'device-2', reason: 'offline' }],
  }
  const failedJob = { ...job, status: 'failed', error: 'exit 1' }

  test('shows the outcome summary and names every skipped device by reason', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: skippedBatch, jobs: [failedJob] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
    // 0 ok, 1 failed, 1 skipped, out of 2 total (1 job + 1 skipped device — F11: skipped never counted in `counts.total`).
    expect(screen.getByText('0 ok · 1 failed · 1 skipped (2/2)')).toBeTruthy()
    expect(screen.getByText('offline')).toBeTruthy()
    expect(screen.getByText('exit 1')).toBeTruthy()
    // The header action names the exact count behind it, per H3.
    expect(screen.getByText('Retry skipped (1)')).toBeTruthy()
  })

  test('Retry skipped posts POST .../rerun?only=skipped and navigates to the new batch', async () => {
    setSearchParams({ id: 'batch-1' })
    let rerunQuery: string | null = null
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: skippedBatch, jobs: [failedJob] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/batches/batch-1/rerun*': (req) => {
        rerunQuery = req.path.split('?')[1] ?? null
        return { body: { batch: { ...skippedBatch, id: 'batch-2' } } }
      },
    })
    await waitFor(() => expect(screen.getByText('Retry skipped (1)')).toBeTruthy())
    screen.getByText('Retry skipped (1)').click()
    await waitFor(() => expect(rerunQuery).toBe('only=skipped'))
  })

  test('a non-pull batch shows no collected-files table', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
    expect(screen.queryByText('collected files')).toBeNull()
  })

  test('a pull batch shows the collected-files table with Download all', async () => {
    setSearchParams({ id: 'batch-1' })
    const pullBatch = { ...batch, scriptId: 'internal:pull', scriptName: null, scriptVersion: null }
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: pullBatch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/batches/batch-1/artifacts': {
        body: {
          items: [
            {
              artifactId: 'art-1',
              jobId: 'job-1',
              deviceId: 'device-1',
              deviceLabel: 'Pixel 6',
              stableId: 'stable-1',
              filename: 'report.txt',
              sizeBytes: 128,
              createdAt: 0,
              contentUrl: '/api/artifacts/art-1/content',
            },
          ],
        },
      },
    })
    await waitFor(() => expect(screen.getByText('collected files')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('report.txt')).toBeTruthy())
    expect(screen.getByText('Pixel 6')).toBeTruthy()
    const downloadAll = screen.getByText('Download all').closest('a')
    expect(downloadAll?.getAttribute('href')).toBe('http://core.test/api/batches/batch-1/artifacts.zip')
  })

  test('a pull batch with nothing collected yet shows an honest empty state, not a broken table', async () => {
    setSearchParams({ id: 'batch-1' })
    const pullBatch = { ...batch, scriptId: 'internal:pull', scriptName: null, scriptVersion: null }
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: pullBatch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/batches/batch-1/artifacts': { body: { items: [] } },
    })
    await waitFor(() => expect(screen.getByText('No files collected yet.')).toBeTruthy())
    expect(screen.queryByText('Download all')).toBeNull()
  })
})

/**
 * Plan 124 §3.7, §4.4 Group D, step 124.4 — this page names a device in three
 * places and each takes a different form of the rule, which is the whole
 * reason it resolves through one `deviceNameOf` helper:
 *
 * - the jobs table's device cell, `<DeviceName>`'s two spans (§3.2);
 * - `SkippedGroups`, which takes `{ number, label }` apart because
 *   `NamedOutcome` composes them itself (step 124.3);
 * - the artifacts table, whose `deviceLabel` arrives ALREADY composed from
 *   `api/batches.ts` (step 124.5) and must therefore be rendered verbatim.
 *
 * That last one is the trap this file pins: wrapping it again reads
 * `#7 #7 Galaxy A15`.
 */
describe('BatchDetail — the device number (plan 124 §4.4 Group D)', () => {
  const devices = [
    { id: 'device-1', label: 'Galaxy A15', stableId: 'stable-1', status: 'idle', tags: [], number: 7 },
  ]

  test('the jobs table names the device with its number, as two nodes', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch, jobs: [job] } },
      '/api/devices*': { body: { items: devices, nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('Galaxy A15')).toBeTruthy())
    expect(screen.getAllByText('#7').length).toBe(1)
  })

  test('an artifact row renders the SERVER-composed label verbatim — never "#7 #7 …"', async () => {
    setSearchParams({ id: 'batch-1' })
    const pullBatch = { ...batch, scriptId: 'internal:pull', scriptName: null, scriptVersion: null }
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch: pullBatch, jobs: [job] } },
      '/api/devices*': { body: { items: devices, nextCursor: null, total: 1 } },
      '/api/batches/batch-1/artifacts': {
        body: {
          items: [
            {
              artifactId: 'art-1',
              jobId: 'job-1',
              deviceId: 'device-1',
              // Exactly what `formatDeviceLabel` puts on the wire.
              deviceLabel: '#7 Galaxy A15',
              stableId: 'stable-1',
              filename: 'report.txt',
              sizeBytes: 128,
              createdAt: 0,
              contentUrl: '/api/artifacts/art-1/content',
            },
          ],
        },
      },
    })
    await waitFor(() => expect(screen.getByText('report.txt')).toBeTruthy())
    expect(screen.getByText('#7 Galaxy A15')).toBeTruthy()
    expect(screen.queryAllByText(/#7 #7/).length).toBe(0)
  })

  test('a device with no number renders its bare label — no stray "#" (criterion 7)', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch, jobs: [job] } },
      '/api/devices*': { body: { items: [{ ...devices[0], number: null }], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('Galaxy A15')).toBeTruthy())
    // `/^#\d/`, not `/^#/`: a batch's jobs table opts into the `seq` column,
    // whose HEADER is the literal `#`. That is a column title, not a device
    // number, and it is there whether or not any device has one.
    expect(screen.queryAllByText(/^#\d/).length).toBe(0)
  })
})
