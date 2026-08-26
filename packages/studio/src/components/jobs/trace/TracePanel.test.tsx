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

/**
 * Plan 130 §0.3, §3.4, step 130.2 — the detail panel and the frame panel are
 * CSS Grid children of `TracePanel`'s `grid gap-3 xl:grid-cols-[22rem_1fr]`,
 * and a Grid item's default `min-width: auto` sizes it to fit its own
 * min-content. `TraceFrame`'s unconstrained `<img>` (no explicit width)
 * contributes the SCREENSHOT'S OWN intrinsic width to that sizing — which is
 * what pushed `seq`/`phase`/`attempt`/`duration` off past
 * `document.clientWidth` on the farm at 900 px (in the DOM, correct value,
 * unreachable) and blew the frame panel out to match.
 *
 * jsdom does not lay out (`getBoundingClientRect` returns zeroes), so a real
 * 900 px reflow cannot be reproduced here — these assert on the STRUCTURE
 * that CSS guarantees prevents it (`min-w-0` on every grid child, and the
 * grid row itself), not on computed pixels. §7's own test plan already says
 * criterion 4 needs re-measuring on the farm; that re-measurement is still
 * outstanding after this step.
 */
describe('Timeline tab — the detail panel and frame panel own their width, not the grid track (plan 130 §3.4, step 130.2)', () => {
  test('the grid row and both its children carry min-w-0', async () => {
    mount([
      uiServerPhase,
      ev({ id: 'a1', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', ok: true, frameHash: 'a'.repeat(64), frameStatus: 'ok' }),
    ])
    await waitFor(() => expect(screen.getByText('Frames: per action (ui-server)')).toBeTruthy())

    const framePanel = screen.getByTestId('trace-frame-panel')
    const eventDetail = screen.getByTestId('trace-event-detail')
    const lanesCard = screen.getByTestId('trace-lanes')
    for (const el of [framePanel, eventDetail, lanesCard]) {
      expect(el.className).toContain('min-w-0')
    }
    // The grid row that makes both panels share a track (`TracePanel.tsx`).
    expect(framePanel.parentElement?.className).toContain('grid')
    expect(framePanel.parentElement?.className).toContain('min-w-0')
    expect(framePanel.parentElement).toBe(eventDetail.parentElement)
  })

  test('every event-detail row can shrink instead of pushing its value past the panel edge', async () => {
    mount([
      uiServerPhase,
      ev({
        id: 'a1',
        seq: 42,
        atMs: 1_100,
        kind: 'action',
        name: 'tap',
        ok: true,
        durationMs: 12,
        frameHash: 'a'.repeat(64),
        frameStatus: 'ok',
      }),
    ])
    // A success job opens on the FIRST event (the phase `start`) — select the
    // action so the panel shows ITS `seq`, not the phase's.
    await waitFor(() => expect(screen.getByLabelText(/tap at/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText(/tap at/))

    await waitFor(() => expect(screen.getByText('42')).toBeTruthy()) // the `seq` row's value
    const seqRow = screen.getByText('42').closest('div')
    expect(seqRow?.className).toContain('min-w-0')
    const seqValue = screen.getByText('42')
    // `min-w-0 truncate` is what lets this value shrink to the panel's real
    // width instead of forcing the row (and the panel) wider than it.
    expect(seqValue.className).toContain('min-w-0')
    expect(seqValue.className).toContain('truncate')
  })

  test('the UI tree scrolls in its own box — not the page', async () => {
    const deepNode = {
      resourceId: 'com.example:id/very_deeply_nested_node_that_is_genuinely_wide',
      text: 'a long label that would otherwise force the panel wider',
      desc: '',
      className: 'android.widget.FrameLayout',
      packageName: 'com.example',
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      clickable: false,
      enabled: true,
      focused: false,
      index: 0,
      children: [
        {
          resourceId: 'com.example:id/child',
          text: 'child',
          desc: '',
          className: 'android.widget.TextView',
          packageName: 'com.example',
          bounds: { left: 10, top: 10, right: 200, bottom: 60 },
          clickable: true,
          enabled: true,
          focused: false,
          index: 0,
          children: [],
        },
      ],
    }
    renderWithApi(
      <TracePanel jobId="job-1" jobStatus="success" />,
      {
        '/api/jobs/job-1/trace/ui/*': { body: deepNode },
        '/api/jobs/job-1/trace*': {
          body: {
            items: [
              uiServerPhase,
              ev({ id: 'a1', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', ok: true, uiHash: 'b'.repeat(64) }),
            ],
            nextCursor: null,
            total: 2,
          },
        },
      },
    )
    // A success job opens on the phase `start` event; select the action that
    // carries the `uiHash` so the tree actually fetches and renders.
    await waitFor(() => expect(screen.getByLabelText(/tap at/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText(/tap at/))

    await waitFor(() => expect(screen.getByTestId('trace-ui-tree')).toBeTruthy())
    const tree = screen.getByTestId('trace-ui-tree')
    expect(tree.className).toContain('overflow-x-auto')
    expect(tree.className).toContain('min-w-0')
    // Each node's own line no longer `truncate`s (which would silently
    // absorb the overflow instead of widening this box) — it stays on one
    // line via `whitespace-nowrap` so a deep/long node makes THIS box
    // scroll sideways rather than the page.
    expect(screen.getByText('FrameLayout').closest('p')?.className).toContain('whitespace-nowrap')
    expect(screen.getByText('FrameLayout').closest('p')?.className).not.toContain('truncate')
  })

  test('the redacted-arguments dump gets its own horizontal scroller too', async () => {
    mount([
      uiServerPhase,
      ev({
        id: 'a1',
        seq: 2,
        atMs: 1_100,
        kind: 'action',
        name: 'tap',
        ok: true,
        meta: { args: { selector: { text: 'a very long selector value that could otherwise widen the panel' } } },
      }),
    ])
    // A success job opens on the phase `start` event, which has no `args`.
    await waitFor(() => expect(screen.getByLabelText(/tap at/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText(/tap at/))

    await waitFor(() => expect(screen.getByText('arguments')).toBeTruthy())
    const pre = document.querySelector('pre')
    expect(pre?.className).toContain('overflow-x-auto')
  })
})

/**
 * Plan 130 §0.4, §3.3, step 130.3 — a thumbnail measured 22×62 px on the
 * farm, decoded from a 1080×1920 PNG: legible only as a position marker,
 * not as a screen. `MIN_FRAME_WIDTH`/`MAX_FRAME_WIDTH` in `TraceTimeline.tsx`
 * are the enforced floor/ceiling; the two "film strip" buttons are the zoom
 * control. Real legibility (§7's criterion 5, "judged by eye on a
 * 100-frame trace") is a farm check, not something jsdom can confirm — these
 * assert the floor is enforced and that zoom actually changes rendered
 * width, which IS real DOM state (inline `style`), not computed layout.
 */
describe('Timeline tab — the film strip has a legible floor and a zoom control (plan 130 §3.3, step 130.3)', () => {
  const framesFixture = [
    uiServerPhase,
    ev({ id: 'ok', seq: 2, atMs: 1_100, kind: 'action', name: 'tap', ok: true, frameHash: 'a'.repeat(64), frameStatus: 'ok' }),
    ev({ id: 'busy', seq: 3, atMs: 1_200, kind: 'action', name: 'tap', ok: true, frameStatus: 'skipped-busy' }),
    ev({ id: 'bad', seq: 4, atMs: 1_300, kind: 'action', name: 'tap', ok: true, frameStatus: 'failed' }),
  ]

  test('a thumbnail never renders below the legible minimum, and the zoom-out button disables at the floor', async () => {
    mount(framesFixture)
    await waitFor(() => expect(screen.getByTestId('frame-thumb')).toBeTruthy())

    const zoomOut = screen.getByLabelText('Zoom film strip out')
    // Click far past what any reasonable zoom range would need — the floor
    // must hold regardless of how many times this is pressed.
    for (let i = 0; i < 10; i++) fireEvent.click(zoomOut)

    const thumb = screen.getByTestId('frame-thumb')
    const width = Number(thumb.style.width.replace('px', ''))
    expect(width).toBeGreaterThanOrEqual(96) // MIN_FRAME_WIDTH
    expect(screen.getByTestId('frame-zoom-value').textContent).toBe(`${width}px`)
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true)
  })

  test('zooming in widens both the thumbnail and the overall strip, up to a ceiling', async () => {
    // Enough frames that the strip's own required width (frames × thumbnail
    // width) genuinely exceeds the event-count-based floor — with only a
    // couple of frames the strip never needs to grow past that floor at any
    // zoom level, which would make this assertion trivially true rather than
    // a real check of the scaling behaviour.
    const manyFrames = [
      uiServerPhase,
      ...Array.from({ length: 60 }, (_, i) =>
        ev({ id: `f${i}`, seq: i + 2, atMs: 1_100 + i * 50, kind: 'action', name: 'tap', ok: true, frameHash: 'a'.repeat(64), frameStatus: 'ok' }),
      ),
    ]
    mount(manyFrames)
    await waitFor(() => expect(screen.getAllByTestId('frame-thumb').length).toBe(60))

    const lanesInner = screen.getByTestId('trace-lanes').firstElementChild as HTMLElement
    const widthBefore = Number(lanesInner.style.width.replace('px', ''))
    const thumbWidthBefore = Number(screen.getAllByTestId('frame-thumb')[0]!.style.width.replace('px', ''))

    const zoomIn = screen.getByLabelText('Zoom film strip in')
    fireEvent.click(zoomIn)

    const thumbWidthAfter = Number(screen.getAllByTestId('frame-thumb')[0]!.style.width.replace('px', ''))
    const widthAfter = Number((screen.getByTestId('trace-lanes').firstElementChild as HTMLElement).style.width.replace('px', ''))
    expect(thumbWidthAfter).toBeGreaterThan(thumbWidthBefore)
    expect(widthAfter).toBeGreaterThan(widthBefore)

    // Push to the ceiling; it must hold there too.
    for (let i = 0; i < 10; i++) fireEvent.click(zoomIn)
    const capped = Number(screen.getAllByTestId('frame-thumb')[0]!.style.width.replace('px', ''))
    expect(capped).toBeLessThanOrEqual(200) // MAX_FRAME_WIDTH
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true)
  })

  test('the skipped/failed frame-status markers survive zoom, still labelled and positioned', async () => {
    mount(framesFixture)
    await waitFor(() => expect(screen.getByTestId('frame-thumb')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Zoom film strip in'))

    const busy = screen.getAllByLabelText(/frame skipped — another capture was still in flight/)[0]!
    const failed = screen.getAllByLabelText(/frame capture failed/)[0]!
    expect(busy.getAttribute('data-frame-status')).toBe('skipped-busy')
    expect(failed.getAttribute('data-frame-status')).toBe('failed')
    // Marked cells scale with zoom exactly like ok frames do — no separate,
    // stuck-at-the-old-size code path for them.
    expect((busy as HTMLElement).style.width).toBe((screen.getByTestId('frame-thumb') as HTMLElement).style.width)
  })

  test('the frame image keeps lazy loading', async () => {
    mount(framesFixture)
    await waitFor(() => expect(screen.getByTestId('frame-thumb')).toBeTruthy())
    const img = screen.getByTestId('frame-thumb').querySelector('img')
    expect(img?.getAttribute('loading')).toBe('lazy')
  })
})
