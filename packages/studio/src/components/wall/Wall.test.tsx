import { afterEach, describe, expect, mock, test } from 'bun:test'
import { useEffect } from 'react'
import { act, fireEvent, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

// `WallTile` mounts `LiveView` (a WebCodecs video decoder over a live WS
// stream) for every tile — none of that is this test's concern, which is
// only the wall SHELL's own data fetch (`GET /api/adb/stats`, read for
// `.video.maxTiles` — plan 92 §5 step 92.3 changed this from
// `/api/settings` so the number is the one ACTUALLY APPLIED, already
// resolved server-side when `wall.maxTiles` is `0`/auto) and its
// loading/empty states. `@/lib/ws` is mocked too since `api()` reads
// `coreBase()` from there regardless of what actually renders.
//
// `rootRef` (plan 92 §5 step 92.4's `useLiveSet.tileRef`) is forwarded to a
// throwaway `<a>` exactly as the real `WallTile` forwards it to its own root
// `next/link` — this is what lets the tests below that assert on ACTUAL
// liveness (not just presence) drive the fake `IntersectionObserver`
// installed below and get a real answer out of the live-set policy, rather
// than asserting against a component that never talks to it.
mock.module('@/components/wall/WallTile', () => ({
  WallTile: ({
    device,
    selected,
    onToggleSelect,
    focused,
    onFocus,
    live,
    rootRef,
    streamError,
  }: {
    device: DeviceInfo
    selected?: boolean
    onToggleSelect?: () => void
    focused?: boolean
    onFocus?: () => void
    live?: boolean
    rootRef?: (node: HTMLAnchorElement | null) => void
    streamError?: string | null
  }) => {
    useEffect(() => {
      const el = document.createElement('a')
      rootRef?.(el)
      return () => rootRef?.(null)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [device.id])
    return (
      <div
        data-testid={`tile-${device.id}`}
        data-selectable={String(!!onToggleSelect)}
        data-selected={String(!!selected)}
        data-focused={String(!!focused)}
        data-live={String(!!live)}
        // Plan 125 §4.3 — `Wall` owns the ONE `stream.ended` subscription
        // for the whole grid and hands each tile its own latched reason;
        // this is where the tests below read it back out.
        data-stream-error={streamError ?? ''}
      >
        {device.label}
        <button type="button" aria-label={`toggle-${device.id}`} onClick={onToggleSelect} />
        <button type="button" aria-label={`focus-${device.id}`} onClick={onFocus} />
      </div>
    )
  },
}))
/**
 * Plan 125 §4.3 — `Wall` now subscribes to `stream.ended` itself (one
 * handler for the whole grid, never one per tile), so this mock records the
 * handler instead of throwing it away: `emitWs` below is how the tests
 * deliver the message the core would broadcast after a display error.
 */
const wsHandlers: Array<(msg: unknown) => void> = []
mock.module('@/lib/ws', () => ({
  ws: {
    on: (cb: (msg: unknown) => void) => {
      wsHandlers.push(cb)
      return () => {
        const i = wsHandlers.indexOf(cb)
        if (i >= 0) wsHandlers.splice(i, 1)
      }
    },
    send: () => {},
    onReconnected: () => () => {},
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))
/** `act` because the handler sets state on `Wall` — without it React logs the "not wrapped in act(...)" warning for every message a test delivers. */
function emitWs(msg: unknown) {
  act(() => {
    for (const cb of [...wsHandlers]) cb(msg)
  })
}

const { Wall, wallWakeTarget } = await import('./Wall')

/**
 * happy-dom's own `IntersectionObserver` never fires a callback (there is
 * no real layout engine underneath it — see `useLiveSet.test.ts`'s own
 * header for the same note), so `useLiveSet`'s dwell mechanism would never
 * see anything as visible in this file's tests otherwise. This fake reports
 * "visible" the instant a tile registers — these are shell-level tests
 * about the STATUS STRIP's counts (plan 92 §4.7, §3.9), not about scroll
 * timing (`useLiveSet.test.ts` owns dwell/ramp/eviction), so every device
 * here is trivially "on screen".
 */
class AutoVisibleIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  private readonly cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
  }
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this))
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
globalThis.IntersectionObserver = AutoVisibleIntersectionObserver as unknown as typeof IntersectionObserver

afterEach(() => {
  cleanup()
  wsHandlers.length = 0
})

const device: DeviceInfo = {
  id: 'dev-1',
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06',
  androidVersion: '15',
  apiLevel: 35,
  screenW: 720,
  screenH: 1600,
  density: 280,
  status: 'idle',
  lastSeen: 1,
  battery: null,
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
}

/**
 * A minimal, schema-valid `/api/adb/stats` body — `Wall` reads `video.maxTiles`
 * from it (plan 92 §5 step 92.3: the number AS ACTUALLY APPLIED, already
 * resolved server-side when `wall.maxTiles` is `0`/auto), the same shape
 * `AdbServerCard.test.tsx`'s own `statsBody()` fixture already establishes
 * for the required top-level fields.
 */
function adbStatsBody(maxTiles: number, videoBytesPerSec = 0) {
  return {
    body: {
      global: { maxConcurrent: 4, auto: true, inFlight: 0, waiting: 0 },
      streams: { maxStreams: 4, maxStreamsPerDevice: 1, active: 0, perDevice: {} },
      idleSessions: [],
      devices: [],
      // Required by `AdbStatsResponseSchema` (unlike `input`/`video` below,
      // which are `.optional()`) — same minimal shape
      // `AdbServerCard.test.tsx`'s own `statsBody()` fixture already uses.
      transport: { connections: 0, bufferedBytesMax: 0, bufferedBytesP95: 0, videoBytesPerSec, controlReplyMsP50: 0, controlReplyMsP95: 0, watchdogReconnects: 0 },
      hostAdb: { running: 0, maxConcurrent: 4, installsRunning: 0, longLived: 0 },
      adbHealth: {
        status: 'ok',
        versionRttMs: 4,
        lastCheckedAt: 0,
        window: { seconds: 600, execs: 0, timeouts: 0, timeoutRate: 0 },
        wedged: [],
        stuckOffline: [],
        symptoms: [],
        restartAdvised: false,
      },
      video: {
        controlStreams: 0,
        wallStreams: 0,
        buildsRunning: 0,
        buildQueueDepth: 0,
        maxConcurrentBuilds: 2,
        maxTiles,
        maxTilesAuto: false,
        transport: 'loopback',
      },
    },
  }
}

describe('Wall', () => {
  test('renders a tile per device once the live-tile budget answers from /api/adb/stats', async () => {
    const { getByTestId } = renderWithApi(<Wall devices={[device]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(4),
    })
    // The real grid only replaces the loading skeleton once the budget
    // answers (Plan 92 §4.7 "settings unknown" — fixes F14's neighbour
    // finding), so the tile testid is not there on the very first render.
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
  })

  /**
   * Plan 101 §5 step 101.8 (owner-specified, 2026-08-16): the farm-wide
   * status strip ("N of M devices live · capped at X at once · Y Mbit/s
   * across the farm") that used to sit above this grid is gone — the
   * owner's own words: *"gausah ada bilah shorcut kaya '2 total' atau '0
   * ready' atau gimana."* `refs/ui`'s own Devices screen has no farm-wide
   * count anywhere near the grid either.
   */
  test('no farm-wide status strip renders above the grid', async () => {
    const { getByTestId, queryByText } = renderWithApi(<Wall devices={[device]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(4, 2_500_000),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    expect(queryByText(/devices? live/)).toBeNull()
    expect(queryByText(/capped at/)).toBeNull()
    expect(queryByText(/Mbit\/s/)).toBeNull()
    expect(queryByText(/across the farm/)).toBeNull()
  })

  /**
   * Tile size (plan 92 §3.11, §4.9, step 92.5) — the page's S/M/L control
   * maps to a pixel width via `TILE_SIZE_PX` (`@/lib/prefs`) and passes it
   * down as `minTileWidthPx`; `Wall` forwards it verbatim to `TileGrid`
   * rather than the hardcoded `180` this component used before (F15).
   * Checked while the budget is still loading (`unmatched: 'pending'`,
   * i.e. `/api/adb/stats` never answers): `TileSkeleton` renders through the
   * SAME `TileGrid`, at the SAME width, so the layout does not jump once the
   * real tiles land (§4.7) — this assertion holds for the skeleton grid too.
   */
  test('minTileWidthPx reaches TileGrid, defaulting to 180 when the caller does not pass one', () => {
    const { container } = renderWithApi(<Wall devices={[device]} jobs={[]} />, {}, { unmatched: 'pending' })
    const grid = container.querySelector('.grid') as HTMLElement
    expect(grid.style.gridTemplateColumns).toContain('180px')
  })

  test('a caller-supplied minTileWidthPx (e.g. the Large tile size, 260px) overrides the default', () => {
    const { container } = renderWithApi(<Wall devices={[device]} jobs={[]} minTileWidthPx={260} />, {}, { unmatched: 'pending' })
    const grid = container.querySelector('.grid') as HTMLElement
    expect(grid.style.gridTemplateColumns).toContain('260px')
  })

  test('devices still loading renders the tile skeleton (Plan 92 §4.7), not a crash', () => {
    const { container } = renderWithApi(<Wall devices={null} jobs={[]} />, {}, { unmatched: 'pending' })
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  /**
   * Plan 92 §4.7's second loading row: devices are known, the real live-tile
   * budget is not. The skeleton stays up rather than starting streams against
   * a default that might be wrong (F14) — proven here by devices being
   * present (unlike the test above) while `/api/adb/stats` never answers.
   */
  test('devices known but the live-tile budget still loading renders the tile skeleton too, not the real tiles', () => {
    const { container, queryByTestId } = renderWithApi(<Wall devices={[device]} jobs={[]} />, {}, { unmatched: 'pending' })
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(queryByTestId('tile-dev-1')).toBeNull()
  })

  test('no devices match renders the empty state without waiting on settings', () => {
    const { getByText } = renderWithApi(<Wall devices={[]} jobs={[]} />, {}, { unmatched: 'pending' })
    expect(getByText('No devices match')).toBeTruthy()
  })
})

/**
 * Group selection and the focused tile (plan 91 §3.11/§5 step 91.8, F11,
 * F12, F13) are state the PARENT page owns (`app/page.tsx`) — this proves
 * `Wall` actually threads them through to each `WallTile` rather than
 * dropping them, the seam this step added to the component.
 */
describe('Wall — selection and focus wiring (plan 91 §5 step 91.8; no more `selectable` prop, plan 101 §5 step 101.7)', () => {
  test('onToggleSelect/selected/focused reach the tile named by id, not every tile', async () => {
    const other: DeviceInfo = { ...device, id: 'dev-2', label: 'pixel 8' }
    const { getByTestId } = renderWithApi(
      <Wall
        devices={[device, other]}
        jobs={[]}
        selectedIds={['dev-1']}
        onToggleSelect={() => {}}
        focusId="dev-2"
        onFocus={() => {}}
      />,
      // Real tiles only replace the loading skeleton once `/api/adb/stats`
      // answers (Plan 92 §4.7) — the wiring this test proves does not exist
      // until then.
      { '/api/adb/stats': adbStatsBody(8) },
    )
    // `data-selectable` here is the mock's own stand-in for "did this tile
    // receive an `onToggleSelect`" (plan 101 §5 step 101.7 — `WallTile` no
    // longer has a `selectable` prop; a click toggles whenever
    // `onToggleSelect` is present at all).
    await waitFor(() => expect(getByTestId('tile-dev-1').dataset.selectable).toBe('true'))
    expect(getByTestId('tile-dev-1').dataset.selected).toBe('true')
    expect(getByTestId('tile-dev-1').dataset.focused).toBe('false')
    expect(getByTestId('tile-dev-2').dataset.selected).toBe('false')
    expect(getByTestId('tile-dev-2').dataset.focused).toBe('true')
  })

  test('a tile toggling selection calls onToggleSelect with its own id', async () => {
    let toggledId: string | null = null
    const { getByLabelText } = renderWithApi(
      <Wall devices={[device]} jobs={[]} selectedIds={[]} onToggleSelect={(id) => (toggledId = id)} />,
      { '/api/adb/stats': adbStatsBody(8) },
    )
    const toggle = await waitFor(() => getByLabelText('toggle-dev-1'))
    fireEvent.click(toggle)
    expect(toggledId).toBe('dev-1')
  })

  /**
   * Plan 101 §5 step 101.7 — when the parent supplies no `onToggleSelect` at
   * all, `Wall` must not invent one: `WallTile` reads its OWN
   * `onToggleSelect` prop's presence to decide whether a click toggles or
   * falls back to navigating, so an always-present wrapper function here
   * would silently make every click toggle even for a caller with no
   * selection concept.
   */
  test('with no onToggleSelect at all, the tile receives none either (not a wrapped no-op)', async () => {
    const { getByTestId } = renderWithApi(<Wall devices={[device]} jobs={[]} />, { '/api/adb/stats': adbStatsBody(8) })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    expect(getByTestId('tile-dev-1').dataset.selectable).toBe('false')
  })

  test('a tile calling onFocus reports its own id', async () => {
    let focusedId: string | null = null
    const { getByLabelText } = renderWithApi(
      <Wall devices={[device]} jobs={[]} onFocus={(id) => (focusedId = id)} />,
      { '/api/adb/stats': adbStatsBody(8) },
    )
    const focusBtn = await waitFor(() => getByLabelText('focus-dev-1'))
    fireEvent.click(focusBtn)
    expect(focusedId).toBe('dev-1')
  })

  /**
   * The right-click context menu (plan 101 §3.9, §5 step 101.5, G15) — Wall
   * wraps each `WallTile` in a plain `data-device-id` div carrying
   * `onContextMenu`, WITHOUT editing `WallTile.tsx` itself (out of this
   * step's remit; see `Wall.tsx`'s own comment on the prop). This proves
   * both halves: the wrapper attribute `useDragSelect` looks for exists,
   * and right-clicking anywhere on the tile reaches the callback with the
   * tile's own device id — not the whole list, not another tile's.
   */
  test('the data-device-id wrapper exists on each tile — what useDragSelect intersects against', async () => {
    const other: DeviceInfo = { ...device, id: 'dev-2', label: 'pixel 8' }
    const { container, getByTestId } = renderWithApi(<Wall devices={[device, other]} jobs={[]} />, { '/api/adb/stats': adbStatsBody(8) })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    expect(container.querySelector('[data-device-id="dev-1"]')).toBeTruthy()
    expect(container.querySelector('[data-device-id="dev-2"]')).toBeTruthy()
  })

  test('right-clicking a tile calls onDeviceContextMenu with THAT tile\'s own id, not another one\'s', async () => {
    const other: DeviceInfo = { ...device, id: 'dev-2', label: 'pixel 8' }
    let reportedId: string | null = null
    const { getByTestId } = renderWithApi(
      <Wall devices={[device, other]} jobs={[]} onDeviceContextMenu={(id) => (reportedId = id)} />,
      { '/api/adb/stats': adbStatsBody(8) },
    )
    const tile2 = await waitFor(() => getByTestId('tile-dev-2'))
    fireEvent.contextMenu(tile2)
    expect(reportedId).toBe('dev-2')
  })

  test('a Wall with no onDeviceContextMenu wired never throws on a right-click', async () => {
    const { getByTestId } = renderWithApi(<Wall devices={[device]} jobs={[]} />, { '/api/adb/stats': adbStatsBody(8) })
    const tile = await waitFor(() => getByTestId('tile-dev-1'))
    expect(() => fireEvent.contextMenu(tile)).not.toThrow()
  })
})

/**
 * **Plan 92 §9 Q2, answered by plan 125 §3.5** — *"Should the wall offer
 * 'Wake all visible'?"*, open since plan 92 and settled here as an explicit,
 * labelled action that states its own count. That question's own hesitation
 * was that *"the default view can wake twenty phones with one click, which
 * is either convenient or alarming depending on whose farm it is"* — so what
 * these tests pin is precisely the part that makes it not alarming: the count
 * is in the label, the action is absent when there is nothing to wake, and
 * the set it submits is the set it counted.
 *
 * The field report behind it (plan 125 §0.1 report 1, owner, on a real
 * 12-device farm): *"Do I really have to trigger a wake-up one by one? That
 * takes forever."*
 */
describe('Wall — Wake all visible (plan 125 §3.5, §4.3; answers plan 92 §9 Q2)', () => {
  const asleep = (id: string, number: number, label: string): DeviceInfo => ({
    ...device,
    id,
    number,
    label,
    readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 0 },
  })

  /** `device` itself is `dev-1`, so every asleep fixture here takes an id of its own — two children with the same key is a React warning, not a passing test. */
  const awakeOther: DeviceInfo = { ...device, id: 'dev-9', number: 9, label: 'z' }

  test('the label names the count, not a bare "Wake all"', async () => {
    const { getByRole } = renderWithApi(
      <Wall devices={[asleep('dev-1', 1, 'a'), asleep('dev-2', 2, 'b'), awakeOther]} jobs={[]} onWakeVisible={() => {}} />,
      { '/api/adb/stats': adbStatsBody(8) },
    )
    await waitFor(() => expect(getByRole('button', { name: /Wake 2 devices/ })).toBeTruthy())
  })

  test('one asleep device reads "Wake 1 device", singular', async () => {
    const { getByRole } = renderWithApi(<Wall devices={[asleep('dev-1', 1, 'a'), awakeOther]} jobs={[]} onWakeVisible={() => {}} />, {
      '/api/adb/stats': adbStatsBody(8),
    })
    await waitFor(() => expect(getByRole('button', { name: /Wake 1 device/ })).toBeTruthy())
  })

  /** Never automatic, and never a permanent strip: a farm with nothing asleep sees a bare grid, exactly as plan 101 §5 step 101.8 left it. */
  test('no action at all when nothing on the wall is asleep', async () => {
    const { getByTestId, queryAllByRole } = renderWithApi(<Wall devices={[device]} jobs={[]} onWakeVisible={() => {}} />, {
      '/api/adb/stats': adbStatsBody(8),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    // Counts, never nodes — a failing `toBeNull()` inside a retrying matcher
    // serialises a whole happy-dom element into the failure report.
    expect(queryAllByRole('button', { name: /^Wake / }).length).toBe(0)
  })

  /** A caller with no way to run the wake must not be offered an action that silently does nothing. */
  test('no action when the parent wired no onWakeVisible', async () => {
    const { getByTestId, queryAllByRole } = renderWithApi(<Wall devices={[asleep('dev-1', 1, 'a')]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(8),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    expect(queryAllByRole('button', { name: /^Wake / }).length).toBe(0)
  })

  test('clicking submits exactly the devices the label counted, and the un-wakeable ones as named skips', async () => {
    const offline: DeviceInfo = { ...asleep('dev-3', 3, 'c'), status: 'offline' }
    let submitted: { wake: string[]; skipped: Array<{ id: string; reason: string }> } | null = null
    const { getByRole } = renderWithApi(
      <Wall
        devices={[asleep('dev-1', 1, 'a'), offline, asleep('dev-2', 2, 'b'), awakeOther]}
        jobs={[]}
        onWakeVisible={(t) =>
          (submitted = { wake: t.wake.map((d) => d.id), skipped: t.skipped.map((s) => ({ id: s.device.id, reason: s.reason })) })
        }
      />,
      { '/api/adb/stats': adbStatsBody(8) },
    )
    const button = await waitFor(() => getByRole('button', { name: /Wake 2 devices/ }))
    fireEvent.click(button)
    expect(submitted).toEqual({
      wake: ['dev-1', 'dev-2'],
      // `docs/design.md`'s "no count without names": a device the wall
      // refuses up front is REPORTED with its reason, never quietly dropped.
      skipped: [{ id: 'dev-3', reason: 'the device is offline' }],
    })
  })

  describe('wallWakeTarget — the pure half', () => {
    test('already-awake devices are not "skipped", they were never in scope', () => {
      const t = wallWakeTarget([awakeOther, asleep('dev-2', 2, 'b')])
      expect(t.wake.map((d) => d.id)).toEqual(['dev-2'])
      expect(t.skipped).toEqual([])
    })

    test('offline and quarantined asleep devices are split out with the reason a human reads', () => {
      const t = wallWakeTarget([
        { ...asleep('dev-1', 1, 'a'), status: 'offline' },
        { ...asleep('dev-2', 2, 'b'), status: 'quarantined' },
        asleep('dev-3', 3, 'c'),
      ])
      expect(t.wake.map((d) => d.id)).toEqual(['dev-3'])
      expect(t.skipped.map((s) => s.reason)).toEqual(['the device is offline', 'the device is quarantined'])
    })
  })
})

/**
 * The stream-error latch (plan 125 §0.5, §4.3). `Wall` holds ONE
 * `stream.ended` subscription for the whole grid — a 40-tile wall must not
 * register 40 handlers for a message that concerns one device — and hands
 * each tile its own reason so `WallTile` can keep `LiveView`'s retry overlay
 * open instead of swapping it for an inert "Screen off".
 */
describe('Wall — the stream-error latch (plan 125 §4.3)', () => {
  const hot = (d: DeviceInfo): DeviceInfo => ({ ...d, readiness: { desired: 'awake', actual: 'hot', blocked: null, since: 0 } })

  test('exactly one WS subscription, whatever the tile count', async () => {
    const { getByTestId } = renderWithApi(
      <Wall devices={[device, { ...device, id: 'dev-2' }, { ...device, id: 'dev-3' }]} jobs={[]} />,
      { '/api/adb/stats': adbStatsBody(8) },
    )
    await waitFor(() => expect(getByTestId('tile-dev-3')).toBeTruthy())
    expect(wsHandlers.length).toBe(1)
  })

  test('stream.ended reaches only the tile it names', async () => {
    const { getByTestId } = renderWithApi(<Wall devices={[device, { ...device, id: 'dev-2' }]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(8),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    emitWs({ type: 'stream.ended', payload: { deviceId: 'dev-1', reason: 'display error' } })
    await waitFor(() => expect(getByTestId('tile-dev-1').getAttribute('data-stream-error')).toBe('display error'))
    expect(getByTestId('tile-dev-2').getAttribute('data-stream-error')).toBe('')
  })

  /**
   * The clear has to be the RISING EDGE of `hot`, never the level: at the
   * instant a display error is reported the device is usually still `hot`,
   * so clearing on the level would wipe the latch in the same commit it was
   * set — restoring the exact defect this step fixes.
   */
  test('a device that was already hot when its stream died keeps the latch', async () => {
    const { getByTestId, rerender } = renderWithApi(<Wall devices={[hot(device)]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(8),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    emitWs({ type: 'stream.ended', payload: { deviceId: 'dev-1', reason: 'display error' } })
    await waitFor(() => expect(getByTestId('tile-dev-1').getAttribute('data-stream-error')).toBe('display error'))
    // The devices list updates (readiness reconciled down to asleep) — the
    // latch must survive it, or the tile goes dark again.
    rerender(<Wall devices={[{ ...device, readiness: { desired: 'awake', actual: 'asleep', blocked: null, since: 0 } }]} jobs={[]} />)
    expect(getByTestId('tile-dev-1').getAttribute('data-stream-error')).toBe('display error')
  })

  test('a session opening again (actual rising into hot) clears the latch', async () => {
    const asleepAgain: DeviceInfo = { ...device, readiness: { desired: 'awake', actual: 'asleep', blocked: null, since: 0 } }
    const { getByTestId, rerender } = renderWithApi(<Wall devices={[asleepAgain]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(8),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    emitWs({ type: 'stream.ended', payload: { deviceId: 'dev-1', reason: 'display error' } })
    await waitFor(() => expect(getByTestId('tile-dev-1').getAttribute('data-stream-error')).toBe('display error'))
    rerender(<Wall devices={[hot(device)]} jobs={[]} />)
    await waitFor(() => expect(getByTestId('tile-dev-1').getAttribute('data-stream-error')).toBe(''))
  })

  /**
   * A latch left on an offline device would be waiting to re-mount
   * `LiveView` — and so start a session on a possibly-sleeping phone — the
   * moment it came back. `WallTile`'s own guard already refuses that; this
   * keeps the state honest as well as harmless.
   */
  test('going offline clears the latch', async () => {
    const { getByTestId, rerender } = renderWithApi(<Wall devices={[hot(device)]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(8),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    emitWs({ type: 'stream.ended', payload: { deviceId: 'dev-1', reason: 'display error' } })
    await waitFor(() => expect(getByTestId('tile-dev-1').getAttribute('data-stream-error')).toBe('display error'))
    rerender(<Wall devices={[{ ...device, status: 'offline' }]} jobs={[]} />)
    await waitFor(() => expect(getByTestId('tile-dev-1').getAttribute('data-stream-error')).toBe(''))
  })
})
