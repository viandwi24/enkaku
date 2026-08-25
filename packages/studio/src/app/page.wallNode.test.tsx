import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * The end-to-end proof for plan 99 §4.9, §4.11, step 99.10's own reported
 * gap: `page.tsx`'s `job.status` handler used to call `load()` (a
 * `GET /api/jobs?status=running` refetch validated against `JobInfoSchema`,
 * which has NO `node` field), silently stripping the workflow node counter
 * the Wall's "node 2/4" badge needs — even though `WallTile.test.tsx` already
 * had a passing unit test for that badge, because that test hands `WallTile`
 * the `node`-bearing job as a PROP directly, sidestepping the exact page
 * wiring that dropped it in production. This file renders the real
 * `Dashboard` (`app/page.tsx`), the real `Wall`, and the real `WallTile` —
 * nothing in that chain is mocked — and asserts the caption text actually
 * lands in the DOM after a live `job.status` WS push, so a regression back
 * to the `load()`-refetch behaviour (or any other break in the chain) fails
 * this test the same way it broke the product.
 *
 * `LiveView` (a WebCodecs/WS video decoder) is the one exception, mocked out
 * for the same reason `WallTile.test.tsx`/`DevicePopup.test.tsx` mock it out
 * of their own tests — standing up a real decoder in happy-dom is not needed
 * to prove the caption text sitting beside it, and `WallTile`'s caption does
 * not depend on `LiveView` having mounted successfully.
 */
mock.module('@/components/LiveView', () => ({
  LiveView: () => <div data-testid="live-view-stub" />,
  // `WallTile` and `DevicePopup` both import this named binding (plan 125
  // §4.7, step 125.11 — the click→first-paint mark), and both are in this
  // file's real module graph, so the mock has to export it or the dynamic
  // `import('./page')` below fails to link. A no-op: nothing here measures.
  markLiveViewIntent: () => {},
}))

/**
 * A SET, not a single slot. The real `ws.on` fans every message out to every
 * registered handler, and as of plan 125 §4.3 this page has two of them:
 * `page.tsx`'s own, and `Wall.tsx`'s `stream.ended` latch.
 *
 * The single-slot double this file used to keep silently broke the moment the
 * second subscriber appeared — the later `ws.on` overwrote the earlier
 * listener, so `emit()` reached only `Wall`'s handler (which ignores every
 * type but `stream.ended`) and the page's own `job.status` handler was never
 * called. The production code was right; the double was too simple, and it
 * failed in the one direction a test double must never fail: quietly, and
 * looking like a product bug.
 */
const wsListeners = new Set<(m: { type: string; payload: unknown }) => void>()
mock.module('@/lib/ws', () => ({
  // `page.tsx` also statically imports `DevicePopup`, which imports
  // `AssistDialog` (`instanceof` check in its own catch branch) — the whole
  // module graph is loaded even though this file never opens the device
  // popup, so the mock still has to export this named binding or the
  // dynamic `import('./page')` below fails to link. Same precedent
  // `DevicePopup.test.tsx` already set for itself.
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  ws: {
    on: (cb: (m: { type: string; payload: unknown }) => void) => {
      wsListeners.add(cb)
      // Unsubscribe removes ONLY this handler — the real `ws.on`'s contract.
      return () => {
        wsListeners.delete(cb)
      }
    },
    send: () => {},
    request: () => Promise.reject(new Error('ws.request not available in this test')),
    onReconnected: () => () => {},
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

/** Delivers a fake `ws` message to EVERY listener currently registered, wrapped in `act` (same pattern `page.test.tsx` uses). */
function emit(msg: { type: string; payload: unknown }): void {
  act(() => {
    for (const listener of [...wsListeners]) listener(msg)
  })
}

const { default: Dashboard } = await import('./page')

afterEach(() => {
  cleanup()
  // Unmounting runs every effect cleanup, so the set should already be empty;
  // clearing it anyway keeps one test's leaked subscriber from reaching the
  // next one's `emit`.
  wsListeners.clear()
})

const device = {
  id: 'dev-1',
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06',
  androidVersion: '15',
  apiLevel: 35,
  screenW: 720,
  screenH: 1600,
  density: 280,
  // Busy is required for `WallTile`'s caption strip to show at all
  // (`showCaption = device.status === 'busy' && !!runningJob?.scriptName`).
  status: 'busy',
  lastSeen: 1,
  battery: null,
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
  connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
}

const baseResponses = {
  '/api/devices?*': { body: { items: [device], nextCursor: null, total: 1 } },
  '/api/jobs*': { body: { items: [] } },
  '/api/clusters?*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/devices/discovered': { body: { discovered: [] } },
  // `Wall`'s own mount effect (`GET /api/settings`, read for `.settings.wall.maxTiles`).
  '/api/settings': { body: { settings: { wall: { maxTiles: 8 } }, schema: {}, deviceSchema: {} } },
}

describe('Dashboard — a job.status node push renders through Wall -> WallTile as "node 2/4" (plan 99 §4.9, §4.11, step 99.10)', () => {
  test('a job.status message carrying a node block shows "node 2/4" in the rendered Wall tile', async () => {
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Wall' }))
    await waitFor(() => expect(screen.getByRole('link', { name: /moto g06/ })).toBeTruthy())
    // No node info pushed yet, and no running job either — the caption strip
    // (gated on `runningJob?.scriptName`) has nothing to show yet.
    expect(screen.queryByText(/node \d\/\d/)).toBeNull()

    emit({
      type: 'job.status',
      payload: {
        jobId: 'job-1',
        deviceId: 'dev-1',
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
        // `seq` is 0-based (plan 99 §4.9) — `WallTile` renders `seq + 1`, so
        // `seq: 1` of `total: 4` is the "2/4" an operator actually reads.
        node: { id: 'search1', seq: 1, total: 4, kind: 'script', script: 'tiktok/search@1.0.0', status: 'running' },
      },
    })

    await waitFor(() => expect(screen.getByText('my-pipeline · node 2/4')).toBeTruthy())
  })
})
