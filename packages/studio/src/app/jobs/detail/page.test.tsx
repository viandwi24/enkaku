import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { FarmSettingsSchema } from '@enkaku/protocol'
import '@/lib/test/nav'
import { mockRouter, setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import JobDetailPage from './page'

/**
 * A real, schema-defaulted `settings` body for `GET /api/settings` (plan 98
 * §3.9 item 4, §5 step 98.8) — every field `FarmSettingsSchema` does not
 * mention here keeps its own default, exactly like `runtime-envelope.test.ts`'s
 * own `farmWith` helper, rather than a hand-typed partial object that would
 * fail `SettingsResponseSchema.safeParse` on the first field this schema
 * adds that the fixture forgot.
 */
function settingsResponse(memory: { defaultMaxRssBytes: number | null; maxRssBytes?: number | null }) {
  return {
    body: {
      settings: FarmSettingsSchema.parse({ job: { memory: { defaultMaxRssBytes: memory.defaultMaxRssBytes, maxRssBytes: memory.maxRssBytes ?? null } } }),
      schema: {},
      deviceSchema: {},
    },
  }
}

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(() => {
  cleanup()
  mockRouter.push.mockClear()
})

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

  test('an undeclared result (no resultSchema) renders raw, byte-identically, whatever its shape (plan 97 §5 step 97.6)', async () => {
    // F20's opportunistic `findings[]` guess is gone (plan 97 §3.6) — a
    // schema-less result of ANY shape, including one that used to trigger
    // the special-cased list, falls straight to the raw `<pre>`.
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
    expect(document.body.textContent).toContain('"severity": "high"')
    expect(document.body.textContent).not.toContain('view raw JSON')
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

/**
 * Plan 98 §3.9 item 4, §4.4, H1 — step 98.2, "measure before limiting": the
 * job row's `peakRssBytes` reaching Studio's Summary tab. No memory LIMIT
 * renders anywhere yet (that is a later step) — only the measurement.
 */
describe('JobDetailPage — peak memory (plan 98 §4.4, H1)', () => {
  test('a job with a recorded peak shows it, formatted', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      baseResponses({ body: { job: { ...job, status: 'success', finishedAt: 1_700_000_100, peakRssBytes: 209_715_200 } } }),
    )
    await waitFor(() => expect(screen.getByText('Peak memory')).toBeTruthy())
    expect(screen.getByText('200.0 MB')).toBeTruthy()
  })

  test('a job with no recorded peak shows a dash and says why, rather than a blank or a zero', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job } }))
    await waitFor(() => expect(screen.getByText('Peak memory')).toBeTruthy())
    expect(screen.getByText('not measured for this job')).toBeTruthy()
  })
})

/**
 * Plan 98 §3.9 item 4, §5 step 98.8 — "Peak memory 812 MB / 512 MB limit."
 * `resolveRuntime` is the ONLY place precedence is computed (§3.8 rule 1);
 * this page just renders the number it resolves to, off the farm's own
 * `job.memory.*` and the script's own declared `runtime.maxRssBytes`.
 */
describe('JobDetailPage — peak memory shows the resolved limit (plan 98 §3.9 item 4, §5 step 98.8)', () => {
  test('a limit resolves (farm default, no script declaration): the row reads "peak / limit"', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      {
        ...baseResponses({ body: { job: { ...job, status: 'success', finishedAt: 1_700_000_100, peakRssBytes: 209_715_200 } } }),
        '/api/settings': settingsResponse({ defaultMaxRssBytes: 536_870_912 }),
      },
    )
    await waitFor(() => expect(screen.getByText('200.0 MB / 512.0 MB limit')).toBeTruthy())
  })

  test("the SCRIPT's own declaration wins over the farm default, exactly like the runner (F5 closed by step 98.4)", async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      {
        ...baseResponses({ body: { job: { ...job, status: 'success', finishedAt: 1_700_000_100, peakRssBytes: 100_000_000 } } }),
        '/api/scripts/script-1': { body: { script: { source: null, runtime: { maxRssBytes: 268_435_456 } } } },
        '/api/settings': settingsResponse({ defaultMaxRssBytes: 536_870_912 }),
      },
    )
    await waitFor(() => expect(screen.getByText(/95\.4 MB \/ 256\.0 MB limit/)).toBeTruthy())
  })

  test('no limit configured anywhere: the row shows only the peak, no "/ limit" tacked onto nothing', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      {
        ...baseResponses({ body: { job: { ...job, status: 'success', finishedAt: 1_700_000_100, peakRssBytes: 209_715_200 } } }),
        '/api/settings': settingsResponse({ defaultMaxRssBytes: null }),
      },
    )
    await waitFor(() => expect(screen.getByText('Peak memory')).toBeTruthy())
    expect(screen.getByText('200.0 MB')).toBeTruthy()
    expect(screen.queryByText(/limit/)).toBeNull()
  })
})

/**
 * Plan 91 §1, §3.5, §5 step 91.5 — "a job that mysteriously succeeded
 * because someone tapped a modal is a lie in the history." `GET
 * /api/jobs/:id/assists` is the detail behind `jobs.assistCount`.
 */
describe('JobDetailPage — Assisted by (plan 91 §3.5, §5 step 91.5)', () => {
  test('an assisted job shows who and when, once the assists fetch resolves', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, {
      ...baseResponses({ body: { job: { ...job, assistCount: 2 } } }),
      '/api/jobs/job-1/assists': {
        body: {
          items: [
            { id: 'ev-1', deviceId: 'device-1', stream: 'input', kind: 'input.tap', actor: 'operator-1', meta: { assist: true, jobId: 'job-1' }, at: 500 },
            { id: 'ev-2', deviceId: 'device-1', stream: 'input', kind: 'input.key', actor: 'operator-1', meta: { assist: true, jobId: 'job-1' }, at: 600 },
          ],
        },
      },
    })
    await waitFor(() => expect(screen.getByText('assisted by 2 actions')).toBeTruthy())
    expect(screen.getAllByText(/operator-1/).length).toBeGreaterThan(0)
  })

  test('an un-assisted job (the common case) shows no "Assisted by" card at all', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, {
      ...baseResponses({ body: { job } }),
      '/api/jobs/job-1/assists': { body: { items: [] } },
    })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'checkout@1.0.0' })).toBeTruthy())
    expect(screen.queryByText(/assisted by/)).toBeNull()
  })
})

/**
 * The node timeline (plan 99 §3.5, §3.7, §4.9, §4.11, step 99.10) — the
 * step's own verifiable result: which node failed and why, without opening
 * the log. `workflowJob` reuses `script-1` as the (workflow) scriptId so
 * `baseResponses`' existing `/api/scripts/script-1` mock only needs
 * widening, not a second script id threaded through every test above.
 */
const workflowJob = { ...job, scriptId: 'script-1', scriptName: 'my-pipeline', status: 'failed', error: 'search1 failed', errorPhase: 'run', finishedAt: 50 }

const workflowDoc = {
  schema: 1,
  name: 'my-pipeline',
  version: '1.0.0',
  title: '',
  description: '',
  params: [],
  nodes: [
    { kind: 'script', id: 'scroll1', title: '', script: 'tiktok/auto-scroll@1.0.0', params: {}, onFailure: { go: 'fail' } },
    {
      kind: 'gate',
      id: 'enough-videos',
      title: '',
      when: { left: { from: 'scroll1', path: 'videos' }, op: 'gte', right: { const: 10 } },
      then: { go: 'continue' },
      else: { go: 'stop' },
      message: '',
    },
    { kind: 'script', id: 'search1', title: '', script: 'tiktok/search@1.0.0', params: {}, onFailure: { go: 'fail' } },
  ],
  maxSteps: 50,
}

function nodesResponses(extra: Record<string, unknown> = {}) {
  return {
    ...baseResponses({ body: { job: workflowJob } }),
    '/api/scripts/script-1': { body: { script: { source: null, workflow: workflowDoc } } },
    ...extra,
  }
}

describe('JobDetailPage — the node timeline (plan 99 §3.5, §3.7, §4.9, §4.11, step 99.10)', () => {
  test('renders one row per node execution: a gate verdict sentence, and which node failed and why', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      nodesResponses({
        '/api/jobs/job-1/nodes': {
          body: {
            items: [
              {
                seq: 0,
                nodeId: 'scroll1',
                kind: 'script',
                scriptId: 's1',
                scriptName: 'tiktok/auto-scroll',
                scriptVersion: '1.0.0',
                status: 'success',
                duration: { startedAt: 0, finishedAt: 10, elapsedMs: 10_000 },
                attempts: { current: 1, total: 3, lastError: null },
                output: { value: { videos: 12 }, truncated: null, error: null, verdict: null },
                resumedFromJobId: null,
                resumedFromNode: null,
              },
              {
                seq: 1,
                nodeId: 'enough-videos',
                kind: 'gate',
                scriptId: null,
                scriptName: null,
                scriptVersion: null,
                status: 'success',
                duration: { startedAt: 10, finishedAt: 10, elapsedMs: 0 },
                attempts: { current: 0, total: null, lastError: null },
                output: { value: null, truncated: null, error: null, verdict: { op: 'gte', left: 12, right: 10, value: true } },
                resumedFromJobId: null,
                resumedFromNode: null,
              },
              {
                seq: 2,
                nodeId: 'search1',
                kind: 'script',
                scriptId: 's2',
                scriptName: 'tiktok/search',
                scriptVersion: '1.0.0',
                status: 'failed',
                duration: { startedAt: 11, finishedAt: 12, elapsedMs: 1000 },
                attempts: { current: 3, total: 3, lastError: { code: 'E_TIMEOUT', message: 'no results within 30s' } },
                output: { value: null, truncated: null, error: { code: 'E_TIMEOUT', message: 'no results within 30s' }, verdict: null },
                resumedFromJobId: null,
                resumedFromNode: null,
              },
            ],
            finalized: true,
          },
        },
      }),
    )
    // The gate verdict, rendered as a sentence — plan 99 §3.7's own example shape.
    await waitFor(() => expect(screen.getByText('enough-videos — scroll1.videos (12) >= 10 → continue')).toBeTruthy())
    // Which node failed (by name) and why — WITHOUT opening the log.
    expect(screen.getByText('search1')).toBeTruthy()
    expect(screen.getByText('no results within 30s')).toBeTruthy()
  })

  test('skipped and skipped-on-resume render distinguishably — different words, not the same badge', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      nodesResponses({
        '/api/jobs/job-1/nodes': {
          body: {
            items: [
              {
                seq: 0,
                nodeId: 'scroll1',
                kind: 'script',
                scriptId: 's1',
                scriptName: 'tiktok/auto-scroll',
                scriptVersion: '1.0.0',
                status: 'skipped-on-resume',
                duration: { startedAt: null, finishedAt: null, elapsedMs: null },
                attempts: { current: 0, total: null, lastError: null },
                output: { value: { videos: 12 }, truncated: null, error: null, verdict: null },
                resumedFromJobId: 'original-job',
                resumedFromNode: 'search1',
              },
              {
                seq: 1,
                nodeId: 'enough-videos',
                kind: 'gate',
                scriptId: null,
                scriptName: null,
                scriptVersion: null,
                status: 'skipped',
                duration: { startedAt: null, finishedAt: null, elapsedMs: null },
                attempts: { current: 0, total: null, lastError: null },
                output: { value: null, truncated: null, error: null, verdict: null },
                resumedFromJobId: null,
                resumedFromNode: null,
              },
            ],
            finalized: false,
          },
        },
      }),
    )
    await waitFor(() => expect(screen.getByText('carried over')).toBeTruthy())
    expect(screen.getByText('skipped')).toBeTruthy()
    expect(document.body.textContent).toContain('Carried over from an earlier run — not re-executed this time.')
    expect(document.body.textContent).toContain('Never reached — a gate branched around it.')
    // A link back to the job it was carried over FROM.
    const original = screen.getByText('See the original job').closest('a')
    expect(original?.getAttribute('href')).toBe('/jobs/detail?id=original-job')
  })

  test('an ordinary (non-workflow) job shows no pipeline card at all', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, {
      ...baseResponses({ body: { job } }),
      '/api/jobs/job-1/nodes': { body: { items: [], finalized: false } },
    })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'checkout@1.0.0' })).toBeTruthy())
    expect(screen.queryByText('pipeline')).toBeNull()
  })

  test('Resume from here opens a confirmation naming every node that will not run again, and resuming navigates to the new job', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      nodesResponses({
        '/api/jobs/job-1/nodes': {
          body: {
            items: [
              {
                seq: 0,
                nodeId: 'scroll1',
                kind: 'script',
                scriptId: 's1',
                scriptName: 'tiktok/auto-scroll',
                scriptVersion: '1.0.0',
                status: 'success',
                duration: { startedAt: 0, finishedAt: 10, elapsedMs: 10_000 },
                attempts: { current: 1, total: 3, lastError: null },
                output: { value: { videos: 12 }, truncated: null, error: null, verdict: null },
                resumedFromJobId: null,
                resumedFromNode: null,
              },
              {
                seq: 2,
                nodeId: 'search1',
                kind: 'script',
                scriptId: 's2',
                scriptName: 'tiktok/search',
                scriptVersion: '1.0.0',
                status: 'failed',
                duration: { startedAt: 11, finishedAt: 12, elapsedMs: 1000 },
                attempts: { current: 3, total: 3, lastError: { code: 'E_TIMEOUT', message: 'no results within 30s' } },
                output: { value: null, truncated: null, error: { code: 'E_TIMEOUT', message: 'no results within 30s' }, verdict: null },
                resumedFromJobId: null,
                resumedFromNode: null,
              },
            ],
            finalized: true,
          },
        },
        '/api/jobs/job-1/resume': {
          body: {
            job: { ...job, jobId: 'job-2', scriptId: 'script-1', scriptName: 'my-pipeline', status: 'queued' },
          },
        },
      }),
    )
    await waitFor(() => expect(screen.getAllByText('Resume from here').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole('button', { name: /Resume from here/ })[1]!) // the failed node's own button
    // Names the node it resumes from, and the ones that will not run again —
    // never worded as restarting the original job.
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Resume from')
    // The DOCUMENT (not just this job's own rows) says what precedes
    // "search1" — `scroll1` AND the `enough-videos` gate between them, even
    // though this fixture's own `/nodes` response never wrote a row for the
    // gate (a realistic case too: a resumed-from-a-resume chain, or a job
    // still finalizing). Reading the document rather than only the rows is
    // what makes this accurate instead of an undercount.
    expect(dialog.textContent).toContain('2 nodes will not run again')
    expect(dialog.textContent).toContain('scroll1')
    expect(dialog.textContent).toContain('enough-videos')
    expect(dialog.textContent).toContain('is untouched and stays in its history exactly as it ran')

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/jobs/detail?id=job-2'))
  })
})

/**
 * Plan 128 §4.3, §4.6, step 128.8 — the Timeline tab and the Delete job
 * action. The tab's own behaviour is covered in
 * `components/jobs/trace/TracePanel.test.tsx`; what is asserted here is the
 * WIRING: the tab exists, the render branch mounts the panel, and the
 * destructive action is gated on the job being settled the same way
 * `DELETE /api/jobs/:id` itself is (`job_not_settled`).
 */
describe('JobDetailPage — the Timeline tab and Delete job (plan 128 §5 step 128.8)', () => {
  const settled = { ...job, status: 'success', finishedAt: 20 }

  test('the tab strip carries a Timeline entry', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job } }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Timeline' })).toBeTruthy())
  })

  test('?tab=trace mounts the timeline and fetches the trace', async () => {
    setSearchParams({ id: 'job-1', tab: 'trace' })
    renderWithApi(<JobDetailPage />, {
      ...baseResponses({ body: { job: settled } }),
      '/api/jobs/job-1/trace*': {
        body: {
          items: [
            {
              id: 'p1',
              jobId: 'job-1',
              seq: 1,
              atMs: 1_000,
              attempt: 1,
              phase: 'run',
              nodeId: null,
              kind: 'phase',
              name: 'start',
              durationMs: null,
              ok: null,
              errorCode: null,
              meta: { inspectorEngineId: 'ui-server', framePolicy: 'per-action' },
              frameHash: null,
              frameStatus: null,
              uiHash: null,
            },
          ],
          nextCursor: null,
          total: 1,
        },
      },
    })
    await waitFor(() => expect(screen.getByText('Frames: per action (ui-server)')).toBeTruthy())
  })

  test('Delete job is disabled while the job is still running', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job } }))
    const button = (await waitFor(() => screen.getByRole('button', { name: 'Delete job' }))) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('Cancel this job before deleting it')
  })

  test('a settled job can be deleted — the cascade is named, and the page leaves for /jobs', async () => {
    setSearchParams({ id: 'job-1' })
    const { apiMock } = renderWithApi(<JobDetailPage />, {
      ...baseResponses({ body: { job: settled } }),
      '/api/jobs/job-1': (req) =>
        req.method === 'DELETE'
          ? { body: { jobId: 'job-1', deleted: { jobs: 1, events: 12, artifacts: 2, nodes: 0, traceDirs: 1 } } }
          : { body: { job: settled } },
    })
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Delete job' })))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Delete job job-1')
    expect(dialog.textContent).toContain('every captured screenshot')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'DELETE' && c.path === '/api/jobs/job-1')).toBe(true))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/jobs'))
  })
})
