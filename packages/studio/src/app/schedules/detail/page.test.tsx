import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
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
