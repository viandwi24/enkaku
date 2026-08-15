import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { JobsList, type JobsListProps } from './JobsList'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

// `TableCell`/`Tooltip` render inside a `<table>`; `JobsList` uses
// `<Tooltip>` for the "created" column, which throws without an ancestor
// `<TooltipProvider>` outside a real `app/layout.tsx` mount — the same
// wrapper `app/jobs/page.test.tsx` already uses for the same reason.
function Wrapped(props: JobsListProps) {
  return (
    <TooltipProvider>
      <JobsList {...props} />
    </TooltipProvider>
  )
}

const job = {
  jobId: 'job-1',
  deviceId: 'device-1',
  scriptId: 'wf-1',
  scriptName: 'my-pipeline',
  scriptVersion: '1.0.0',
  status: 'running',
  error: null,
  priority: 0,
  createdAt: 0,
  startedAt: 0,
  finishedAt: null,
  batchId: null,
  batchSeq: null,
  expiresAt: null,
  errorPhase: null,
  failureClass: null,
  triggeredByJobId: null,
  rootJobId: null,
  depth: 0,
  peakRssBytes: null,
  assistCount: 0,
}

/**
 * Plan 99 §4.9, §4.11, step 99.10 — "node 2/4" from `job.status`'s own
 * `node` block. `GET /api/jobs`'s REST response never carries this field
 * (`JobInfoSchema` has none, and the endpoint's own schema strips unknown
 * keys) — it only ever arrives on a row a LIVE `job.status` WS push has
 * touched (`app/jobs/page.tsx`'s own `pushLive(m.payload as Job)`, no
 * re-parse). Exercised here through the `fetchPage` prop override (the same
 * seam a batch/device view already uses), which — unlike the component's
 * own default REST fetch — returns whatever JS object the test hands it,
 * `node` included, matching what a live-pushed row really looks like.
 */
describe('JobsList — the live node counter (plan 99 §4.9, §4.11, step 99.10)', () => {
  test('an ordinary job (no live node) shows no counter', async () => {
    renderWithApi(
      <Wrapped empty={{ title: 'none', description: '' }} fetchPage={async () => ({ items: [job], nextCursor: null, total: 1 })} />,
      {},
    )
    await waitFor(() => expect(screen.getByText('my-pipeline@1.0.0')).toBeTruthy())
    expect(screen.queryByText(/node \d\/\d/)).toBeNull()
  })

  test('a workflow job a live push has touched shows "node 2/4"', async () => {
    const withNode = {
      ...job,
      node: { id: 'search1', seq: 1, total: 4, kind: 'script', script: 'tiktok/search@1.0.0', status: 'running' },
    }
    renderWithApi(
      <Wrapped
        empty={{ title: 'none', description: '' }}
        fetchPage={async () => ({ items: [withNode as unknown as typeof job], nextCursor: null, total: 1 })}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText('node 2/4')).toBeTruthy())
  })
})

/**
 * Plan 94 §3.7, §4.9, §4.10, F25, step 94.10 — the opt-in `pacing` column:
 * `batchRepeat`/`pacedDelayMs`/`notBefore` (94.7's own wire additions) and a
 * live `job.waiting` push (94.6's), unrendered until this step per this
 * plan's own brief. Off by default (`DEFAULT_COLUMNS` unchanged), so every
 * caller that never opts in — the plain Jobs page, a device's Jobs tab — is
 * untouched, proven by the very first test below.
 */
describe('JobsList — the pacing column (plan 94 §3.7, §4.9, §4.10, F25, step 94.10)', () => {
  test('off by default: no Pacing header even for a job that carries pacing fields', async () => {
    const paced = { ...job, batchRepeat: 2, pacedDelayMs: 12_000, notBefore: null }
    renderWithApi(
      <Wrapped empty={{ title: 'none', description: '' }} fetchPage={async () => ({ items: [paced], nextCursor: null, total: 1 })} />,
      {},
    )
    await waitFor(() => expect(screen.getByText('my-pipeline@1.0.0')).toBeTruthy())
    expect(screen.queryByText('Pacing')).toBeNull()
  })

  test('a settled repetition shows its repetition number and the delay it actually waited', async () => {
    const settled = { ...job, status: 'success', batchRepeat: 2, pacedDelayMs: 252_000, notBefore: null }
    renderWithApi(
      <Wrapped
        empty={{ title: 'none', description: '' }}
        columns={{ pacing: true }}
        fetchPage={async () => ({ items: [settled], nextCursor: null, total: 1 })}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText('Pacing')).toBeTruthy())
    expect(screen.getByText('rep 3')).toBeTruthy() // batchRepeat is 0-based
    expect(screen.getByText(/waited 4 min 12 s/)).toBeTruthy()
  })

  test('a queued repetition with no live push shows its static notBefore countdown', async () => {
    const queued = { ...job, status: 'queued', batchRepeat: 1, pacedDelayMs: null, notBefore: Math.floor(Date.now() / 1000) + 30 }
    renderWithApi(
      <Wrapped
        empty={{ title: 'none', description: '' }}
        columns={{ pacing: true }}
        fetchPage={async () => ({ items: [queued], nextCursor: null, total: 1 })}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText(/starts in ~/)).toBeTruthy())
  })

  test('a live job.waiting push with reason "paced" beats the static notBefore fallback (F25)', async () => {
    const queued = { ...job, status: 'queued', batchRepeat: 1, pacedDelayMs: null, notBefore: Math.floor(Date.now() / 1000) + 999 }
    renderWithApi(
      <Wrapped
        empty={{ title: 'none', description: '' }}
        columns={{ pacing: true }}
        waiting={{ 'job-1': { reason: 'paced', remainingSec: 4 } }}
        fetchPage={async () => ({ items: [queued], nextCursor: null, total: 1 })}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText(/waiting — next repetition in 4s/)).toBeTruthy())
  })
})
