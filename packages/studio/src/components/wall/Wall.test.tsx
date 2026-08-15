import { afterEach, describe, expect, mock, test } from 'bun:test'
import { useEffect } from 'react'
import { fireEvent, waitFor } from '@testing-library/react'
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
    selectable,
    selected,
    onToggleSelect,
    focused,
    onFocus,
    live,
    rootRef,
  }: {
    device: DeviceInfo
    selectable?: boolean
    selected?: boolean
    onToggleSelect?: () => void
    focused?: boolean
    onFocus?: () => void
    live?: boolean
    rootRef?: (node: HTMLAnchorElement | null) => void
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
        data-selectable={String(!!selectable)}
        data-selected={String(!!selected)}
        data-focused={String(!!focused)}
        data-live={String(!!live)}
      >
        {device.label}
        <button type="button" aria-label={`toggle-${device.id}`} onClick={onToggleSelect} />
        <button type="button" aria-label={`focus-${device.id}`} onClick={onFocus} />
      </div>
    )
  },
}))
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { Wall } = await import('./Wall')

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

/** `DWELL_MS` (400ms) plus headroom — every test below that asserts a device is actually LIVE (not just rendered) has to wait at least this long, since `useLiveSet` never promotes a tile before it has been "visible" this long. */
const DWELL_WAIT_MS = 1500

afterEach(cleanup)

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
  test('renders a tile per device and reads the live-tile budget from /api/adb/stats', async () => {
    const { getByText, getByTestId } = renderWithApi(<Wall devices={[device]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(4),
    })
    // The real grid only replaces the loading skeleton once the budget
    // answers (Plan 92 §4.7 "settings unknown" — fixes F14's neighbour
    // finding), so the tile testid is not there on the very first render.
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    expect(getByText(/capped at 4 at once/)).toBeTruthy()
  })

  /**
   * The status strip's video-rate figure (plan 92 §5 step 92.9 — the piece
   * 92.6 deferred and 92.8 could not reach, `packages/studio/src/
   * components/wall/**` sitting outside its own file-ownership boundary).
   * Proves the number is READ, not invented: `2_500_000` bytes/s in the
   * fixture becomes `20.0 Mbit/s` via `formatMbps(bytesPerSec * 8)`, the
   * identical conversion the settings page's own `MeasuredBlock` uses
   * (`FarmVideoFields.tsx`), so the two readers can never disagree about
   * the arithmetic even though they poll independently.
   */
  test('the status strip reports the farm-wide measured video rate once /api/adb/stats answers', async () => {
    const { getByText } = renderWithApi(<Wall devices={[device]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(4, 2_500_000),
    })
    await waitFor(() => expect(getByText(/capped at 4 at once/)).toBeTruthy())
    await waitFor(() => expect(getByText('20.0 Mbit/s')).toBeTruthy())
    expect(getByText(/across the farm/)).toBeTruthy()
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
 * The status strip's blocked/budgeted breakdown (Plan 92 §4.7, §3.9, fixes
 * F16's sibling finding): "12 of 100 live" on its own does not say what the
 * other 88 are doing — the breakdown is what turns that into an honest
 * number instead of an implied "the rest failed".
 */
describe('Wall — the status strip breakdown (plan 92 §4.7, §3.9)', () => {
  const asleepDevice: DeviceInfo = {
    ...device,
    id: 'dev-2',
    label: 'asleep phone',
    readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 0 },
  }
  const offlineDevice: DeviceInfo = { ...device, id: 'dev-3', label: 'offline phone', status: 'offline' }
  const quarantinedDevice: DeviceInfo = {
    ...device,
    id: 'dev-4',
    label: 'quarantined phone',
    status: 'quarantined',
    quarantineReason: 'auto-battery',
  }

  test('a healthy farm with room under the cap shows no breakdown title', async () => {
    const { getByText } = renderWithApi(<Wall devices={[device]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(8),
    })
    // The device must DWELL (plan 92 §3.2 rule 2, `useLiveSet`'s `DWELL_MS`)
    // before the live-set policy promotes it — even though the fake
    // `IntersectionObserver` above reports it "visible" immediately.
    await waitFor(() => expect(getByText(/1 of 1 device live/)).toBeTruthy(), { timeout: DWELL_WAIT_MS })
    const strip = getByText(/1 of 1 device live/)
    expect(strip.getAttribute('title')).toBeNull()
  })

  test('asleep/offline/quarantined devices are neither live nor counted as budgeted, and appear in the hover breakdown', async () => {
    const { getByText } = renderWithApi(
      <Wall devices={[device, asleepDevice, offlineDevice, quarantinedDevice]} jobs={[]} />,
      { '/api/adb/stats': adbStatsBody(8) },
    )
    await waitFor(() => expect(getByText(/1 of 4 devices live/)).toBeTruthy(), { timeout: DWELL_WAIT_MS })
    const strip = getByText(/1 of 4 devices live/)
    expect(strip.getAttribute('title')).toBe('1 asleep · 1 offline · 1 quarantined')
  })

  test('devices outside the live cap are reported as "outside the live budget"', async () => {
    const other: DeviceInfo = { ...device, id: 'dev-5', label: 'second phone' }
    const { getByText } = renderWithApi(<Wall devices={[device, other]} jobs={[]} />, {
      '/api/adb/stats': adbStatsBody(1),
    })
    await waitFor(() => expect(getByText(/1 of 2 devices live/)).toBeTruthy(), { timeout: DWELL_WAIT_MS })
    const strip = getByText(/1 of 2 devices live/)
    expect(strip.getAttribute('title')).toBe('1 outside the live budget')
  })
})

/**
 * Group selection and the focused tile (plan 91 §3.11/§5 step 91.8, F11,
 * F12, F13) are state the PARENT page owns (`app/page.tsx`) — this proves
 * `Wall` actually threads them through to each `WallTile` rather than
 * dropping them, the seam this step added to the component.
 */
describe('Wall — selection and focus wiring (plan 91 §5 step 91.8)', () => {
  test('selectable/selected/focused reach the tile named by id, not every tile', async () => {
    const other: DeviceInfo = { ...device, id: 'dev-2', label: 'pixel 8' }
    const { getByTestId } = renderWithApi(
      <Wall
        devices={[device, other]}
        jobs={[]}
        selectable
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
    await waitFor(() => expect(getByTestId('tile-dev-1').dataset.selectable).toBe('true'))
    expect(getByTestId('tile-dev-1').dataset.selected).toBe('true')
    expect(getByTestId('tile-dev-1').dataset.focused).toBe('false')
    expect(getByTestId('tile-dev-2').dataset.selected).toBe('false')
    expect(getByTestId('tile-dev-2').dataset.focused).toBe('true')
  })

  test('a tile toggling selection calls onToggleSelect with its own id', async () => {
    let toggledId: string | null = null
    const { getByLabelText } = renderWithApi(
      <Wall devices={[device]} jobs={[]} selectable selectedIds={[]} onToggleSelect={(id) => (toggledId = id)} />,
      { '/api/adb/stats': adbStatsBody(8) },
    )
    const toggle = await waitFor(() => getByLabelText('toggle-dev-1'))
    fireEvent.click(toggle)
    expect(toggledId).toBe('dev-1')
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
})
