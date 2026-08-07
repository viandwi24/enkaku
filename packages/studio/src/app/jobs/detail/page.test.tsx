import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import JobDetailPage from './page'

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
  result: null,
  // Sent by `rowToJobDetail` on every job — what the run was STARTED with,
  // beside what it returned. Required by `JobDetailSchema`, like `result`.
  params: null,
}

function baseResponses(jobResponse: { status?: number; body?: unknown }) {
  return {
    '/api/jobs/job-1': jobResponse,
    '/api/scripts/script-1': { body: { script: { source: null } } },
    '/api/devices/refs*': { body: { refs: {} } },
    '/api/artifacts*': { body: { items: [], nextCursor: null, total: 0 } },
    // Every other member of this job's trigger chain (plan 81 §4.5) —
    // empty by default, the common case: a job nothing triggered.
    '/api/jobs?*': { body: { items: [], nextCursor: null, total: 0 } },
  }
}

describe('JobDetailPage — smoke render', () => {
  test('loaded: shows the script name once the job loads', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job } }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'checkout@1.0.0' })).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the job loads', () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed job fetch shows a named error with a retry', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      baseResponses({ status: 500, body: { error: { code: 'E_INTERNAL', message: 'job boom' } } }),
    )
    await waitFor(() => expect(screen.getByText('job boom')).toBeTruthy())
  })

  test('no id in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<JobDetailPage />, {})
    expect(screen.getByText('The address is missing an id parameter.')).toBeTruthy()
  })
})

describe('JobDetailPage — lineage (plan 81 §4.5)', () => {
  test('a job with no lineage renders cleanly — no lineage panel at all', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job } }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'checkout@1.0.0' })).toBeTruthy())
    expect(screen.queryByText('lineage')).toBeNull()
    expect(screen.queryByText(/triggered by/)).toBeNull()
  })

  test('a triggered job shows who triggered it, the chain root, and its depth — named, not a raw id', async () => {
    setSearchParams({ id: 'job-1' })
    const triggered = { ...job, triggeredByJobId: 'root-1', rootJobId: 'root-1', depth: 1 }
    renderWithApi(<JobDetailPage />, {
      ...baseResponses({ body: { job: triggered } }),
      '/api/jobs/root-1': { body: { job: { ...job, jobId: 'root-1', scriptName: 'setup', scriptVersion: '2.0.0', status: 'success', result: null } } },
      '/api/jobs?*': {
        body: { items: [{ ...triggered, result: undefined }], nextCursor: null, total: 1 },
      },
    })
    await waitFor(() => expect(screen.getByText('lineage')).toBeTruthy())
    // Named by script, not printed as a bare id — "triggered by" and "root of
    // chain" both point at the same root here (depth 1), so the name appears
    // at least once and never as the raw "root-1" id.
    await waitFor(() => expect(screen.getAllByText('setup').length).toBeGreaterThan(0))
    expect(screen.queryByText('root-1')).toBeNull()
    expect(screen.getByText('2 jobs')).toBeTruthy() // root + this job
  })

  test('a job that triggered others lists them by name, and offers a descendant-aware cancel', async () => {
    setSearchParams({ id: 'job-1' })
    const child = {
      jobId: 'child-1',
      deviceId: 'device-1',
      scriptId: 'script-2',
      scriptName: 'notify',
      scriptVersion: '1.0.0',
      status: 'queued',
      error: null,
      priority: 0,
      createdAt: 1,
      startedAt: null,
      finishedAt: null,
      triggeredByJobId: 'job-1',
      rootJobId: 'job-1',
      depth: 1,
    }
    renderWithApi(<JobDetailPage />, {
      ...baseResponses({ body: { job } }),
      '/api/jobs?*': { body: { items: [child], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('triggered 1 job')).toBeTruthy())
    expect(screen.getByText('notify')).toBeTruthy()
    expect(screen.queryByText('child-1')).toBeNull()

    // The job is `running` (cancellable) with one QUEUED descendant — a
    // plain cancel must not fire silently; it must ask first (plan 81 §4.4).
    fireEvent.click(screen.getByRole('button', { name: 'Cancel job' }))
    expect(screen.getByText('Cancel this job and its queued descendants?')).toBeTruthy()
  })
})
