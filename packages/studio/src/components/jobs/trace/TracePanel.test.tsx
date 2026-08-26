import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { JobTraceEvent } from '@enkaku/protocol'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TracePanel } from './TracePanel'

/**
 * The Timeline tab (plan 128 §4.6, step 128.8). The claims under test are
 * the step's own list: it renders from a fixture trace, the playhead reaches
 * an event, a failed job opens on the failing one, the capture-policy line
 * reads correctly for BOTH engines, an empty action lane is explained in
 * words rather than left blank, and a `skipped-busy`/`failed` capture is
 * visibly marked instead of leaving a gap.
 *
 * `useJobTrace` walks every page through `fetchAllPages`, which appends its
 * own `?limit=200` — hence the wildcard on the trace mock. The `/trace/ui/*`
 * key sits FIRST because `installApiMock` takes the first matching key in
 * insertion order, and `/api/jobs/job-1/trace*` would otherwise swallow it.
 */

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

function ev(over: Partial<JobTraceEvent>): JobTraceEvent {
  return {
    id: 'e',
    jobId: 'job-1',
    seq: 1,
    atMs: 1_000,
    attempt: 1,
    phase: 'run',
    nodeId: null,
    kind: 'log',
    name: 'info',
    durationMs: null,
    ok: null,
    errorCode: null,
    meta: null,
    frameHash: null,
    frameStatus: null,
    uiHash: null,
    ...over,
  }
}

function mount(items: JobTraceEvent[], jobStatus: 'running' | 'success' | 'failed' = 'success') {
  return renderWithApi(<TracePanel jobId="job-1" jobStatus={jobStatus} />, {
    '/api/jobs/job-1/trace/ui/*': { status: 404, body: { error: { code: 'ui_snapshot_not_found', message: 'no such ui snapshot' } } },
    '/api/jobs/job-1/trace*': { body: { items, nextCursor: null, total: items.length } },
  })
}

const uiServerPhase = ev({
  id: 'p1',
  seq: 1,
  atMs: 1_000,
  kind: 'phase',
  name: 'start',
  phase: 'run',
  meta: { inspectorEngineId: 'ui-server', framePolicy: 'per-action' },
})

describe('Timeline tab — renders from a fixture trace', () => {
  test('the lanes, the scrubber and the event detail all appear', async () => {
    mount([
      uiServerPhase,
      ev({ id: 'a1', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', durationMs: 42, ok: true, frameHash: 'a'.repeat(64), frameStatus: 'ok', meta: { args: { x: 10, y: 20 } } }),
      ev({ id: 'l1', seq: 3, atMs: 1_150, kind: 'log', name: 'info', meta: { source: 'script', msg: 'tapped' } }),
    ])
    await waitFor(() => expect(screen.getByText('Frames: per action (ui-server)')).toBeTruthy())
    expect(screen.getByRole('slider', { name: 'Trace playhead' })).toBeTruthy()
    expect(screen.getByText('3 events · 1 frame')).toBeTruthy()
    // The four lanes, by their own labels. `getAllByText` for `phase`
    // deliberately: the event detail panel has a `phase` row of its own.
    for (const lane of ['phase', 'actions', 'logs', 'frames']) {
      expect(screen.getAllByText(lane).length).toBeGreaterThan(0)
    }
  })

  test('a job with no trace at all shows an explanation, never a blank tab', async () => {
    mount([])
    await waitFor(() => expect(screen.getByText('Nothing recorded for this job')).toBeTruthy())
  })
})

describe('Timeline tab — the capture-policy line, for both engines (plan 128 §3.4)', () => {
  test('ui-server', async () => {
    mount([uiServerPhase])
    await waitFor(() => expect(screen.getByText('Frames: per action (ui-server)')).toBeTruthy())
  })

  test('uiautomator-dump', async () => {
    mount([
      ev({
        id: 'p1',
        seq: 1,
        atMs: 1_000,
        kind: 'phase',
        name: 'start',
        phase: 'run',
        meta: { inspectorEngineId: 'uiautomator-dump', framePolicy: 'on-failure' },
      }),
    ])
    await waitFor(() => expect(screen.getByText('Frames: on failure only (uiautomator-dump)')).toBeTruthy())
  })

  /**
   * §10 item 2's own case: a job that failed in `prepare` has zero action
   * events, so the line cannot come from `frameStatus`. It still reads.
   */
  test('a job that failed before it ever touched the device still gets the line', async () => {
    mount(
      [
        ev({
          id: 'p1',
          seq: 1,
          atMs: 1_000,
          kind: 'phase',
          name: 'start',
          phase: 'prepare',
          meta: { inspectorEngineId: 'ui-server', framePolicy: 'per-action' },
        }),
        ev({ id: 'l1', seq: 2, atMs: 1_010, kind: 'log', name: 'error', phase: 'prepare', meta: { source: 'runner', msg: 'apk missing' } }),
      ],
      'failed',
    )
    await waitFor(() => expect(screen.getByText('Frames: per action (ui-server)')).toBeTruthy())
  })
})

describe('Timeline tab — an empty action lane is explained (goal 4)', () => {
  test('a node-owned (cloud) job says why, rather than showing a blank lane', async () => {
    mount([
      ev({ id: 'p1', seq: 1, atMs: 1_000, kind: 'phase', name: 'start', phase: 'run', meta: { remote: true } }),
      ev({ id: 'l1', seq: 2, atMs: 1_020, kind: 'log', name: 'info', meta: { source: 'script', msg: 'hello' } }),
    ])
    // Two separate sentences say it, deliberately: the capture-policy line
    // ("Frames: none — …") and the empty-lane explanation beside it.
    await waitFor(() => expect(screen.getAllByText(/ran on a cloud node/).length).toBe(2))
    expect(screen.getByText('no device actions recorded')).toBeTruthy()
    expect(screen.getByText(/^Frames: none — this job ran on a cloud node/)).toBeTruthy()
    expect(screen.getByText(/action tee lives in the local runner/)).toBeTruthy()
  })
})

describe('Timeline tab — a skipped or failed capture is visible, never a gap (goal 6)', () => {
  const events = [
    uiServerPhase,
    ev({ id: 'ok', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', ok: true, frameHash: 'a'.repeat(64), frameStatus: 'ok' }),
    ev({ id: 'busy', seq: 3, atMs: 1_200, kind: 'action', name: 'tap', ok: true, frameStatus: 'skipped-busy' }),
    ev({ id: 'bad', seq: 4, atMs: 1_300, kind: 'action', name: 'tap', ok: true, frameStatus: 'failed' }),
  ]

  test('both are marked in the film-strip lane and counted in the header', async () => {
    mount(events)
    await waitFor(() => expect(screen.getByText('Frames: per action (ui-server)')).toBeTruthy())
    expect(screen.getByText(/1 skipped while busy/)).toBeTruthy()
    expect(screen.getByText(/1 capture failed/)).toBeTruthy()
    expect(screen.getAllByLabelText(/frame skipped — another capture was still in flight/).length).toBeGreaterThan(0)
    expect(screen.getAllByLabelText(/frame capture failed/).length).toBeGreaterThan(0)
  })

  test('selecting the skipped action states the reason beside the frame panel', async () => {
    mount(events)
    await waitFor(() => expect(screen.getByText('Frames: per action (ui-server)')).toBeTruthy())
    fireEvent.click(screen.getAllByLabelText(/frame skipped — another capture was still in flight/)[0]!)
    await waitFor(() =>
      expect(document.querySelector('p[data-frame-status="skipped-busy"]')?.textContent).toContain('still in flight'),
    )
  })
})

describe('Timeline tab — the playhead', () => {
  const events = [
    uiServerPhase,
    ev({ id: 'a1', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', ok: true }),
    ev({ id: 'a2', seq: 3, atMs: 1_200, kind: 'action', name: 'find', ok: true }),
  ]

  test('← → step one event, Home / End jump to the ends', async () => {
    mount(events)
    const slider = await waitFor(() => screen.getByRole('slider', { name: 'Trace playhead' }))
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(slider.getAttribute('aria-valuenow')).toBe('1'))
    fireEvent.keyDown(slider, { key: 'End' })
    await waitFor(() => expect(slider.getAttribute('aria-valuenow')).toBe('2'))
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    await waitFor(() => expect(slider.getAttribute('aria-valuenow')).toBe('1'))
    fireEvent.keyDown(slider, { key: 'Home' })
    await waitFor(() => expect(slider.getAttribute('aria-valuenow')).toBe('0'))
  })

  /**
   * The `(atMs, seq)` rule, end to end through the rendered tab (plan §4.3,
   * §10 item 4). The action HAPPENED first (`atMs` 1000) and ARRIVED last
   * (`seq` 9), because it was held until its screenshot settled. `Home` must
   * land on it, not on the log line that merely arrived earlier.
   */
  test('the trace renders in (atMs, seq) order, not seq order', async () => {
    mount([
      ev({ id: 'l1', seq: 7, atMs: 1_050, kind: 'log', name: 'info', meta: { source: 'script', msg: 'during' } }),
      ev({ id: 'l2', seq: 8, atMs: 1_120, kind: 'log', name: 'info', meta: { source: 'script', msg: 'after' } }),
      ev({ id: 'a1', seq: 9, atMs: 1_000, kind: 'action', name: 'tap', ok: true }),
    ])
    const slider = await waitFor(() => screen.getByRole('slider', { name: 'Trace playhead' }))
    fireEvent.keyDown(slider, { key: 'Home' })
    await waitFor(() => expect(slider.getAttribute('aria-valuetext')).toContain('action tap'))
    fireEvent.keyDown(slider, { key: 'End' })
    await waitFor(() => expect(slider.getAttribute('aria-valuetext')).toContain('log info'))
  })

  test('a FAILED job opens with the playhead already on the failing event', async () => {
    mount(
      [
        uiServerPhase,
        ev({ id: 'a1', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', ok: true }),
        ev({
          id: 'a2',
          seq: 3,
          atMs: 1_200,
          kind: 'action',
          name: 'find',
          ok: false,
          errorCode: 'not-found',
          durationMs: 5_000,
          meta: { args: { sel: { text: 'Post' } }, message: 'find refused: not-found' },
        }),
        ev({ id: 'l1', seq: 4, atMs: 1_300, kind: 'log', name: 'error', meta: { source: 'runner', msg: 'job failed' } }),
      ],
      'failed',
    )
    const slider = await waitFor(() => screen.getByRole('slider', { name: 'Trace playhead' }))
    expect(slider.getAttribute('aria-valuenow')).toBe('2')
    expect(slider.getAttribute('aria-valuetext')).toContain('action find')
    // …and the detail panel is showing that event, not the first one.
    expect(screen.getByText('not-found')).toBeTruthy()
    expect(screen.getByText('find refused: not-found')).toBeTruthy()
  })

  test('a job that succeeded opens at the start of the trace instead', async () => {
    mount(events, 'success')
    const slider = await waitFor(() => screen.getByRole('slider', { name: 'Trace playhead' }))
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
  })
})

/**
 * Plan 128 goal 6 says the timeline never omits silently — and the loudest
 * way to break that is not a missing frame but a missing TAIL. `useJobTrace`
 * walks pages through a helper that stops after 25 of them and returns what
 * it has, so a run longer than that used to render its first stretch and
 * simply stop, indistinguishable from a job that ended there. Plan §3.4
 * records one event per device call with no cap by design, so this is
 * reachable on any long run rather than being a corner case.
 */
describe('Timeline tab — a truncated fetch says so (plan 128 §10 item 9)', () => {
  test('a page that still has a cursor after the ceiling is reported, not rendered as complete', async () => {
    const items = [uiServerPhase, ev({ id: 'a1', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', ok: true })]
    // Every page answers with a cursor, so the walk never runs out of pages
    // and hits the ceiling instead — exactly the shape of a very long run.
    renderWithApi(<TracePanel jobId="job-1" jobStatus="success" />, {
      '/api/jobs/job-1/trace/ui/*': { status: 404, body: { error: { code: 'ui_snapshot_not_found', message: 'no such ui snapshot' } } },
      '/api/jobs/job-1/trace*': { body: { items, nextCursor: 'more', total: 99_999 } },
    })
    await waitFor(() => expect(screen.getByText('This timeline is incomplete.')).toBeTruthy())
    expect(screen.getByText(/it is\s+not where the job stopped/)).toBeTruthy()
  })

  test('a complete fetch shows no such warning', async () => {
    mount([uiServerPhase, ev({ id: 'a1', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', ok: true })])
    await waitFor(() => expect(screen.getByText('Frames: per action (ui-server)')).toBeTruthy())
    expect(screen.queryByText('This timeline is incomplete.')).toBeNull()
  })
})
