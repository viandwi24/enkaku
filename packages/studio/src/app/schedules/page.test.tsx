import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { TooltipProvider } from '@enkaku/ui'
import { cleanup, renderWithApi } from '@/lib/test/render'
import SchedulesPage from './page'

// `SchedulesPage` renders a `<Tooltip>` around the paramsCompatible badge
// (plan 95 §4.4, §4.8), relying on the app-wide `<TooltipProvider>` from
// `app/layout.tsx` — absent here since the test mounts the page in
// isolation, so it is supplied locally (same pattern as `jobs/page.test.tsx`).
function Wrapped() {
  return (
    <TooltipProvider>
      <SchedulesPage />
    </TooltipProvider>
  )
}

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

describe('SchedulesPage — smoke render', () => {
  test('loaded: shows the schedule row', async () => {
    renderWithApi(<SchedulesPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/schedules*': { body: { items: [schedule], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('Nightly smoke')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    renderWithApi(<SchedulesPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/schedules*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the schedule list loads', () => {
    renderWithApi(<SchedulesPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/schedules fetch shows a named error', async () => {
    renderWithApi(<SchedulesPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/schedules*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'schedules boom' } } },
    })
    await waitFor(() => expect(screen.getByText('schedules boom')).toBeTruthy())
  })
})

/**
 * Plan 95 §4.4, §4.8, §5 step 95.7 — a schedule the SERVER reports as
 * incompatible is badged the moment its row loads, with no firing involved
 * anywhere in this test: `GET /api/schedules` is the only endpoint touched.
 */
describe('SchedulesPage — the paramsCompatible badge (plan 95 §4.4, §4.8)', () => {
  test('a compatible schedule shows no badge', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/schedules*': { body: { items: [{ ...schedule, paramsCompatible: true, paramsFindingCount: 0 }], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('Nightly smoke')).toBeTruthy())
    expect(screen.queryByText('1')).toBeNull()
  })

  test('an incompatible schedule shows the finding count as a badge', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/schedules*': { body: { items: [{ ...schedule, paramsCompatible: false, paramsFindingCount: 2 }], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('Nightly smoke')).toBeTruthy())
    expect(screen.getByText('2')).toBeTruthy()
  })
})
