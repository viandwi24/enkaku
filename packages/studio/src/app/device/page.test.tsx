import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * The device page mounts almost everything it renders unconditionally —
 * `TabPanel` (this file's own helper) keeps a tab's subtree mounted and
 * only toggles `hidden`, so the Jobs table, the Terminal pane, the adb
 * endpoint card, Files, Network, Identity, Logs, and the Settings form ALL
 * mount on first render regardless of which tab is active (Plan 42 §3.1
 * kept the panels alive across a tab switch — the side effect for this test
 * is that there is no "only mount what Control needs" shortcut). Two things
 * are mocked as a result:
 *
 * - `@/components/device/ScreenCard` — pulls in `LiveView` (a WebCodecs
 *   video decoder wired to a live WS binary stream) and `InspectorPanel`,
 *   neither of which is this test's concern (the plan explicitly calls out
 *   mocking exactly this kind of child). Replaced with a trivial stand-in.
 * - `@/lib/ws` — no real `WebSocket` in `happy-dom`; every child panel
 *   above (Terminal, Files, Logs, Network's guest-agent poll, ...) either
 *   subscribes through it directly or reaches it transitively via `api()`'s
 *   `coreBase()`. A single comprehensive mock covers all of them.
 *
 * Every OTHER child (TagEditor, NetworkPanel, IdentityPanel, PaginatedTable
 * for the Jobs tab, the schema-driven Settings form, ...) is left real: this
 * is what proves the page shell does not crash when eleven children mount
 * at once, which is exactly the class of bug (plan 72 §3.1's Tools-tab
 * crash) this plan exists to catch. Their own endpoints are deliberately
 * left unmocked (falling through to the harness's 404 default) — each
 * already degrades to its own `ErrorState`/empty default rather than
 * throwing, and asserting that is these components' OWN test's job
 * (`NetworkPanel.test.tsx`, `TagEditor.test.tsx`, `AdbEndpointCard.test.tsx`,
 * ...), not this page shell smoke test's.
 */
mock.module('@/components/device/ScreenCard', () => ({
  ScreenCard: () => <div data-testid="screen-card-stub" />,
}))
mock.module('@/lib/ws', () => ({
  // `TakeControlDialog.tsx` (out of this plan's scope, rendered from
  // `DeviceHeader`) imports `WsRequestError` for an `instanceof` check —
  // needs a real class here, not just a stub value, or that import throws.
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  ws: {
    on: () => () => {},
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(false)
      return () => {}
    },
    onReconnected: () => () => {},
    getSessionId: () => 's1',
    isConnected: () => false,
    send: () => {},
    request: () => Promise.reject(new Error('ws not available in test')),
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { default: DevicePage } = await import('./page')

afterEach(cleanup)

const device = {
  id: 'dev-1',
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06 — rack 1',
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
  heldBy: null,
  // `DeviceDetailSchema`-only fields (plan 72's `DeviceDetailResponseSchema`).
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'adb-input',
  inspection: 'ui-server',
  settings: null,
  nodeId: null,
}

// A minimal but real `SettingsResponseSchema` body — every field on
// `FarmSettingsSchema` carries its own default (see `Wall.test.tsx`), so an
// empty `settings`/`deviceSchema` object still parses.
const settingsBody = { settings: {}, schema: {}, deviceSchema: {} }

const baseResponses = {
  '/api/devices/dev-1': { body: { device } },
  '/api/settings': { body: settingsBody },
  '/api/devices/dev-1/viewers': { body: { viewers: [] } },
  '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
}

describe('DevicePage', () => {
  test('loaded: renders the header and the (stubbed) screen', async () => {
    setSearchParams({ id: 'dev-1' })
    const { getByText, getByTestId } = renderWithApi(<DevicePage />, baseResponses)
    await waitFor(() => expect(getByText('moto g06 — rack 1')).toBeTruthy())
    expect(getByTestId('screen-card-stub')).toBeTruthy()
  })

  test('loading: shows the loading rows before the device fetch resolves', () => {
    setSearchParams({ id: 'dev-1' })
    const { container } = renderWithApi(<DevicePage />, {}, { unmatched: 'pending' })
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a device fetch failure shows a named error, not a blank page', async () => {
    setSearchParams({ id: 'dev-1' })
    const { getByText } = renderWithApi(<DevicePage />, {
      ...baseResponses,
      '/api/devices/dev-1': { status: 500, body: { error: { code: 'boom', message: 'the core is unavailable' } } },
      // `ForgetDeviceDialog.tsx`'s device-refs fallback (plan 47 §3.4) — this
      // page also tries to resolve a deleted-device label on a failed fetch.
      '/api/devices/refs*': { body: { refs: {} } },
    })
    await waitFor(() => expect(getByText('the core is unavailable')).toBeTruthy())
  })

  test('a missing ?id= param renders a named error rather than crashing', () => {
    setSearchParams({})
    const { getByText } = renderWithApi(<DevicePage />, {}, { unmatched: 'pending' })
    expect(getByText('The address is missing an id parameter.')).toBeTruthy()
  })
})
