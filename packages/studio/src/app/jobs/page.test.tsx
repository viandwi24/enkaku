import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cleanup, renderWithApi } from '@/lib/test/render'
import JobsPage from './page'

// `JobsPage` renders a `<Tooltip>` around the "created" timestamp, relying
// on the app-wide `<TooltipProvider>` from `app/layout.tsx` — absent here
// since the test mounts the page in isolation, so it is supplied locally.
function Wrapped() {
  return (
    <TooltipProvider>
      <JobsPage />
    </TooltipProvider>
  )
}

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

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
}

describe('JobsPage — smoke render', () => {
  test('loaded: shows the job row', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { body: { items: [job], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('No jobs yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the job list loads', () => {
    renderWithApi(<Wrapped />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/jobs fetch shows a named error', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'jobs boom' } } },
    })
    await waitFor(() => expect(screen.getByText('jobs boom')).toBeTruthy())
  })
})
