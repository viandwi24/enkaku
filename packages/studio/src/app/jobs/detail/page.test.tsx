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
    // What the job has already logged (`GET /api/jobs/:id/logs`) — empty by
    // default; the log tests below override it.
    '/api/jobs/job-1/logs': { body: { lines: [], truncated: false } },
  }
}

/** The logs tab, with a scripted backfill. */
function withBackfill(lines: { jobId: string; ts: number; level: string; source: string; msg: string }[], truncated = false) {
  return {
    ...baseResponses({ body: { job: { ...job, status: 'running', finishedAt: null } } }),
    '/api/jobs/job-1/logs': { body: { lines, truncated } },
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

/**
 * A RUNNING job never has a `job.log` artifact — the runner writes it once, in
 * its `finally` — so a panel that keys "loading" off `savedLogs` sat on
 * "Loading…" until a new line happened to arrive over the WS. That is the
 * exact bug the backfill fetch existed to fix, and it survived the first pass
 * because only the header label was updated, not the panel body.
 */
describe('JobDetailPage — the logs panel while a job is running', () => {
  test('shows what the job ALREADY logged, instead of Loading…', async () => {
    setSearchParams({ id: 'job-1', tab: 'logs' })
    renderWithApi(
      <JobDetailPage />,
      withBackfill([{ jobId: 'job-1', ts: 1_700_000_000_000, level: 'info', source: 'script', msg: 'opened chrome' }]),
    )
    await waitFor(() => expect(document.body.textContent).toContain('opened chrome'))
    expect(document.body.textContent).not.toContain('Loading…')
  })

  test('a running job that has logged NOTHING says so, rather than loading forever', async () => {
    setSearchParams({ id: 'job-1', tab: 'logs' })
    renderWithApi(<JobDetailPage />, withBackfill([]))
    await waitFor(() => expect(document.body.textContent).toContain('no log lines'))
    expect(document.body.textContent).not.toContain('Loading…')
  })

  test('dropped earlier lines are admitted, not silently skipped', async () => {
    setSearchParams({ id: 'job-1', tab: 'logs' })
    renderWithApi(
      <JobDetailPage />,
      withBackfill([{ jobId: 'job-1', ts: 1_700_000_000_000, level: 'info', source: 'script', msg: 'still here' }], true),
    )
    await waitFor(() => expect(document.body.textContent).toContain('earlier lines dropped'))
  })
})

/**
 * Information order = order of the user's questions (audit finding 2). The
 * result is what the run existed to produce; params are what it was given, and
 * are read second; phases and timing are reference and belong in the sidebar.
 * These pin the ORDER, which is the thing a later edit silently undoes.
 */
describe('JobDetailPage — hierarchy', () => {
  test('the result appears before the params it was given', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job: { ...job, status: 'success', finishedAt: 1_700_000_100, result: { ok: true } } } }))
    await waitFor(() => expect(document.body.textContent).toContain('returned'))
    const text = document.body.textContent ?? ''
    expect(text.indexOf('returned')).toBeLessThan(text.indexOf('started with'))
  })

  test('params start collapsed — reference material, not content', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job: { ...job, params: { url: 'https://example.test' } } } }))
    await waitFor(() => expect(document.body.textContent).toContain('started with'))
    const details = [...document.querySelectorAll('details')].find((d) => d.textContent?.includes('started with'))
    expect(details).toBeTruthy()
    expect(details?.hasAttribute('open')).toBe(false)
  })

  test('a findings-shaped result renders as a list with its severities, not a JSON blob', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      baseResponses({
        body: {
          job: {
            ...job,
            status: 'success',
            finishedAt: 1_700_000_100,
            result: { findings: [{ title: 'checkout button missing', severity: 'high', detail: 'not on screen' }] },
          },
        },
      }),
    )
    await waitFor(() => expect(document.body.textContent).toContain('checkout button missing'))
    expect(document.body.textContent).toContain('high')
    expect(document.body.textContent).toContain('view raw JSON')
  })

  test('a result that is not findings-shaped still renders raw, unchanged', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job: { ...job, status: 'success', finishedAt: 1_700_000_100, result: { exitIp: '1.2.3.4' } } } }))
    await waitFor(() => expect(document.body.textContent).toContain('exitIp'))
    expect(document.body.textContent).not.toContain('view raw JSON')
  })

  test('the verdict is in the header — run time and the three moments, without scrolling', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job } }))
    await waitFor(() => expect(document.body.textContent).toContain('queued'))
    expect(document.body.textContent).toContain('started')
  })
})
