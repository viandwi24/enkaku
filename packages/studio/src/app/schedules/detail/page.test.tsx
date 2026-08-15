import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ScheduleDetailPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const schedule = {
  id: 'sched-1',
  name: 'Nightly smoke',
  enabled: true,
  cron: '0 2 * * *',
  timezone: 'UTC',
  target: { kind: 'script', ref: 'checkout@latest' },
  scriptRef: 'checkout@latest',
  params: null,
  clusterId: null,
  deviceIds: ['device-1'],
  concurrency: 0,
  order: 'as-listed',
  onOverlap: 'skip',
  queueTimeoutSec: null,
  catchUp: 'skip',
  jitterSec: 0,
  priority: 0,
  threadMode: 'new',
  threadId: null,
  onApprovalRequired: 'deny',
  lastFiredAt: null,
  lastBatchId: null,
  lastAgentRunId: null,
  createdBy: null,
  createdAt: 0,
  nextFireAt: null,
}

function baseResponses(scheduleResponse: { status?: number; body?: unknown }) {
  return {
    '/api/schedules/sched-1': scheduleResponse,
    '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    '/api/schedules/validate': { body: { valid: true, nextFires: [1000] } },
  }
}

describe('ScheduleDetailPage — smoke render', () => {
  test('loaded: shows the schedule name', async () => {
    setSearchParams({ id: 'sched-1' })
    renderWithApi(<ScheduleDetailPage />, baseResponses({ body: { schedule, resolvesTo: null } }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nightly smoke' })).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the schedule loads', () => {
    setSearchParams({ id: 'sched-1' })
    renderWithApi(<ScheduleDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed schedule fetch shows a named error with a retry', async () => {
    setSearchParams({ id: 'sched-1' })
    renderWithApi(
      <ScheduleDetailPage />,
      baseResponses({ status: 500, body: { error: { code: 'E_INTERNAL', message: 'schedule boom' } } }),
    )
    await waitFor(() => expect(screen.getByText('schedule boom')).toBeTruthy())
  })

  test('no id in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<ScheduleDetailPage />, {})
    expect(screen.getByText('The address is missing an id parameter.')).toBeTruthy()
  })
})

/**
 * Plan 94 §3.9, §4.9, step 94.8 — "Stop" on the schedule's last run, with the
 * same naming-what-happens dialog `/batches/detail` uses.
 */
describe('ScheduleDetailPage — Stop the last run (plan 94 §3.9, §4.9, step 94.8)', () => {
  const runningBatch = {
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
    counts: { total: 2, queued: 1, running: 1, success: 0, failed: 0, cancelled: 0 },
  }

  test('an active last run shows a Stop control; confirming it calls POST /api/batches/:id/stop', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'sched-1' })
    let stopCalled = false
    renderWithApi(<ScheduleDetailPage />, {
      ...baseResponses({ body: { schedule: { ...schedule, lastBatchId: 'batch-1' }, resolvesTo: null } }),
      '/api/batches/batch-1': { body: { batch: runningBatch } },
      '/api/batches/batch-1/stop': (req) => {
        stopCalled = req.method === 'POST'
        return { body: { cancelled: 1, aborted: 1, refused: 0, refusedDeviceIds: [] } }
      },
    })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nightly smoke' })).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Last run')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Stop last run' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/aborted/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Stop run' }))

    await waitFor(() => expect(stopCalled).toBe(true))
  })

  test('a finished last run shows no Stop control', async () => {
    setSearchParams({ id: 'sched-1' })
    const doneBatch = { ...runningBatch, status: 'success', counts: { total: 2, queued: 0, running: 0, success: 2, failed: 0, cancelled: 0 } }
    renderWithApi(<ScheduleDetailPage />, {
      ...baseResponses({ body: { schedule: { ...schedule, lastBatchId: 'batch-1' }, resolvesTo: null } }),
      '/api/batches/batch-1': { body: { batch: doneBatch } },
    })
    await waitFor(() => expect(screen.getByText('Last run')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Stop last run' })).toBeNull()
  })

  test('no last run yet: no "Last run" card at all', async () => {
    setSearchParams({ id: 'sched-1' })
    renderWithApi(<ScheduleDetailPage />, baseResponses({ body: { schedule, resolvesTo: null } }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nightly smoke' })).toBeTruthy())
    expect(screen.queryByText('Last run')).toBeNull()
  })
})
