import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * The fleet page (`app/page.tsx`) subscribes to `ws.on` on mount for live
 * device/job updates — no real `WebSocket` in `happy-dom`, so `@/lib/ws` is
 * replaced (also covers `coreBase()`, which every `fetch` on this page
 * reads through, directly or via `@/lib/api`'s helpers).
 */
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { default: Dashboard } = await import('./page')

afterEach(cleanup)

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
  status: 'idle',
  lastSeen: 1,
  battery: null,
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
}

const baseResponses = {
  // `fetchAllPages` (`@/lib/api`) always appends `?limit=200[&cursor=...]` —
  // the wildcard has to start after the literal `?` so it does not also
  // swallow `/api/devices/discovered` below.
  '/api/devices?*': { body: { items: [device], nextCursor: null, total: 1 } },
  '/api/jobs*': { body: { items: [] } },
  '/api/clusters?*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/devices/discovered': { body: { discovered: [] } },
}

describe('Dashboard (fleet page)', () => {
  test('loaded: renders a card for each device', async () => {
    const { getByText } = renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
  })

  test('loading: shows the loading rows before the devices fetch resolves', () => {
    const { container } = renderWithApi(<Dashboard />, {}, { unmatched: 'pending' })
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed devices fetch shows a named error, not a blank page', async () => {
    // `fetchDevices` (`@/lib/api`, out of this plan's scope) throws a plain
    // `Error` on a non-OK response — not `api()`'s `{error:{code,message}}`
    // unwrapping — so that literal message is what the page's `ErrorState` shows.
    const { getByText } = renderWithApi(<Dashboard />, {
      ...baseResponses,
      '/api/devices?*': { status: 500 },
    })
    await waitFor(() => expect(getByText('GET /api/devices → 500')).toBeTruthy())
  })
})
