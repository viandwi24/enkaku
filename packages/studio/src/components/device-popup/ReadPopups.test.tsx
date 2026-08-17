import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * `JobsPopup`'s in-place job detail (plan 103 §9 Q2, answered 2026-08-16,
 * closing step 103.11's audit row 4 — "the Jobs popup lists jobs and stops
 * there"). Tested directly here rather than only through `ActionsList.test.tsx`
 * because this popup now has real state of its own worth exercising: which
 * job (if any) is selected, and whether "Back" returns to the list.
 */
mock.module('@/lib/ws', () => ({
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  ws: {
    on: () => () => {},
    onReconnected: () => () => {},
    send: () => {},
    request: () => Promise.reject(new Error('ws not available in test')),
    getSessionId: () => 'test-session',
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { JobsPopup } = await import('./ReadPopups')

afterEach(cleanup)

const jobRow = {
  jobId: 'job-1',
  deviceId: 'dev-1',
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  status: 'success',
  error: null,
  failureClass: null,
  priority: 0,
  createdAt: 0,
  startedAt: 0,
  finishedAt: 10,
  batchId: null,
  batchSeq: null,
  expiresAt: null,
  errorPhase: null,
  triggeredByJobId: null,
  rootJobId: null,
  depth: 0,
  peakRssBytes: null,
  assistCount: 0,
  notBefore: null,
  batchRepeat: null,
  pacedDelayMs: null,
  resultStatus: 'undeclared',
  resultSummary: null,
}

const jobDetail = {
  ...jobRow,
  result: 'exit 0',
  params: null,
  resultBytes: null,
  resultIssues: null,
  resultSchema: null,
}

const responses = {
  '/api/jobs?deviceId=dev-1&limit=50': { body: { items: [jobRow], nextCursor: null, total: 1 } },
  '/api/jobs/job-1': { body: { job: jobDetail } },
  '/api/scripts/script-1': { body: { script: { source: null, workflow: null, runtime: null } } },
  '/api/artifacts*': { body: { items: [], nextCursor: null } },
  '/api/jobs/job-1/logs': { body: { lines: [], truncated: false } },
}

describe('JobsPopup — a job row drills into JobDetailPanel in place (plan 103 §9 Q2)', () => {
  test('clicking the job opens its detail — result, params, logs, artifacts — with no navigation', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <JobsPopup deviceId="dev-1" deviceLabel="moto g06" deviceOffline={false} open onOpenChange={() => {}} />
      </TooltipProvider>,
      responses,
    )
    const dialog = await screen.findByRole('dialog')
    const row = await within(dialog).findByRole('button', { name: 'checkout@1.0.0' })
    fireEvent.click(row)

    // In place: a back affordance, never a `next/link` to a different route.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Back to jobs/ })).toBeTruthy())
    expect(within(dialog).queryAllByRole('link')).toHaveLength(0)

    // The same result view/params/logs/artifacts `/jobs/detail` renders —
    // reused through `lib/use-job-detail.ts` and `components/jobs/`, not a
    // thinner re-derivation.
    await waitFor(() => expect(within(dialog).getByText('exit 0')).toBeTruthy())
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: /Artifacts/ }))
    await waitFor(() => expect(within(dialog).getByText('No artifacts')).toBeTruthy())
  })

  test('"Back to jobs" returns to the Jobs·Crashes·Logs tab strip', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <JobsPopup deviceId="dev-1" deviceLabel="moto g06" deviceOffline={false} open onOpenChange={() => {}} />
      </TooltipProvider>,
      responses,
    )
    const dialog = await screen.findByRole('dialog')
    const row = await within(dialog).findByRole('button', { name: 'checkout@1.0.0' })
    fireEvent.click(row)
    const back = await within(dialog).findByRole('button', { name: /Back to jobs/ })
    fireEvent.click(back)
    await waitFor(() => expect(within(dialog).getByRole('tab', { name: 'Crashes' })).toBeTruthy())
    expect(within(dialog).queryByRole('button', { name: /Back to jobs/ })).toBeNull()
  })
})
