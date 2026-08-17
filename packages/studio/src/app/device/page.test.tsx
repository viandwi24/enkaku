import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@enkaku/ui'

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
/**
 * `ScreenCard` is mocked to a stub for the same reason the file header
 * above gives (`LiveView`'s decoder is not this file's concern) — but the
 * stub now CAPTURES its own props (plan 91 §5 step 91.6) so the Assist
 * tests below can assert exactly what `device/page.tsx` computed for
 * `inputEnabled`/`jobRunning`/`assistPrimaryLabel`, and fires `onAssist`
 * through a plain button standing in for the real one (`ScreenCard`'s own
 * Assist button is proven for real in `ScreenCard.test.tsx`).
 */
let lastScreenCardProps: Record<string, unknown> | null = null
mock.module('@/components/device/ScreenCard', () => ({
  ScreenCard: (props: Record<string, unknown>) => {
    lastScreenCardProps = props
    return (
      <div data-testid="screen-card-stub">
        {typeof props.onAssist === 'function' && (
          <button type="button" onClick={props.onAssist as () => void}>
            stub-open-assist
          </button>
        )}
      </div>
    )
  },
}))
// The Assist tests below reconfigure `request` per-test; every OTHER test
// in this file never calls it, so the default keeps rejecting exactly like
// before this plan.
let wsRequestImpl: (msg: unknown) => Promise<unknown> = () => Promise.reject(new Error('ws not available in test'))
const wsSendCalls: unknown[] = []
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
    send: (msg: unknown) => wsSendCalls.push(msg),
    request: (msg: unknown) => wsRequestImpl(msg),
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
  liveDisplay: null,
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

/**
 * Plan 92 §5 step 92.8, acceptance criterion 3 — the device page's Settings
 * tab Video section, reached through the REAL page (`deviceSections` →
 * `DeviceVideoFields`), not the standalone component test in
 * `components/video/DeviceVideoFields.test.tsx`.
 */
describe('DevicePage — Settings tab, Video section (plan 92 §5 step 92.8)', () => {
  test('an empty device override reads "the farm" in the readout, sourced from the SAME /api/settings fetch the other Settings sub-sections already use', async () => {
    setSearchParams({ id: 'dev-1', tab: 'settings', section: 'video' })
    renderWithApi(<DevicePage />, {
      ...baseResponses,
      '/api/settings': {
        body: {
          settings: {
            shell: { mode: 'admin' },
            transfer: { enabled: true },
            coControl: { mode: 'operator', grantTtlSec: 300 },
            video: { controlPreset: 'sharp', controlMaxSize: 1600, controlMaxFps: 30, controlBitRate: 4_000_000, wallPreset: 'balanced', wallMaxSize: 480, wallMaxFps: 5, wallBitRate: 800_000 },
          },
          schema: {},
          deviceSchema: {
            type: 'object',
            properties: {
              video: {
                type: 'object',
                'x-enkaku': { group: 'Video' },
                properties: {
                  controlPreset: { type: 'string', enum: ['sharp', 'balanced', 'light'], title: 'Device page picture' },
                  controlMaxSize: { type: 'integer', minimum: 480, maximum: 2560, title: 'Device page size (px)' },
                  controlMaxFps: { type: 'integer', minimum: 5, maximum: 60, title: 'Device page frame rate' },
                  controlBitRate: { type: 'integer', minimum: 500_000, maximum: 20_000_000, title: 'Device page bitrate' },
                  wallPreset: { type: 'string', enum: ['detailed', 'balanced', 'light', 'minimal'], title: 'Wall tile picture' },
                  wallMaxSize: { type: 'integer', minimum: 160, maximum: 1080, title: 'Wall tile size (px)' },
                  wallMaxFps: { type: 'integer', minimum: 1, maximum: 30, title: 'Wall tile frame rate' },
                  wallBitRate: { type: 'integer', minimum: 100_000, maximum: 8_000_000, title: 'Wall tile bitrate' },
                },
              },
            },
          },
        },
      },
    })
    await waitFor(() => expect(screen.getByText('Device page picture')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByText('the farm').length).toBe(6))
  })
})

/**
 * Assist (plan 91 §3.2, §3.4, §3.12, §5 step 91.6) — the acceptance the
 * plan's step names verbatim: "with a job running, the device page offers
 * Assist, the dialog names `checkout@1.4.2`, and after confirming, a tap
 * reaches the phone" (proven here as `inputEnabled` flipping to `true`,
 * since a real tap needs real hardware — see the plan's own pending-manual
 * section) "while the job's lease countdown in the header keeps running
 * unchanged" (proven here as `heldBy`/`expiresAt` — the ONLY state the
 * header's own countdown reads — never being touched by any part of this
 * flow: `AssistDialog` sends `assist.start`, never `lease.acquire`/
 * `lease.release`).
 */
const jobHolder = { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }
const busyDevice = { ...device, status: 'busy', heldBy: jobHolder }
const busyResponses = { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } }

describe('DevicePage — Assist (plan 91 §3.2, §3.4, §3.12, §5 step 91.6)', () => {
  afterEach(() => {
    wsRequestImpl = () => Promise.reject(new Error('ws not available in test'))
    wsSendCalls.length = 0
  })

  test('a job running: ScreenCard is wired with jobRunning, the script name, and input OFF', async () => {
    setSearchParams({ id: 'dev-1' })
    // A job hold is never takeable (plan 71 §3.4) — the header's disabled
    // "Take control" button wraps in a `<Tooltip>`, which needs the app-wide
    // `<TooltipProvider>` from `app/layout.tsx`, absent here since this test
    // mounts the page in isolation (same pattern `DeviceCard.test.tsx` uses).
    renderWithApi(
      <TooltipProvider>
        <DevicePage />
      </TooltipProvider>,
      busyResponses,
    )
    await waitFor(() => expect(lastScreenCardProps).not.toBeNull())
    await waitFor(() => expect(lastScreenCardProps?.assistPrimaryLabel).toBe('checkout@1.4.2'))
    expect(lastScreenCardProps?.jobRunning).toBe(true)
    expect(lastScreenCardProps?.inputEnabled).toBe(false)
    expect(typeof lastScreenCardProps?.onAssist).toBe('function')
  })

  test('confirming Assist flips inputEnabled to true, without touching the lease (heldBy/expiresAt untouched, no lease.* sent)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    wsRequestImpl = (msg) => {
      const m = msg as { type: string }
      if (m.type === 'assist.start') {
        return Promise.resolve({
          type: 'assist.started',
          payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300, primary: jobHolder },
        })
      }
      return Promise.reject(new Error(`unexpected request in test: ${m.type}`))
    }
    setSearchParams({ id: 'dev-1' })
    renderWithApi(
      <TooltipProvider>
        <DevicePage />
      </TooltipProvider>,
      busyResponses,
    )
    await waitFor(() => expect(lastScreenCardProps?.inputEnabled).toBe(false))

    // The stub's own trigger stands in for `ScreenCard`'s real Assist button
    // (proven for real in `ScreenCard.test.tsx`) — this test's own concern is
    // what `device/page.tsx` DOES once the dialog reports success.
    await user.click(screen.getByText('stub-open-assist'))
    // `AssistDialog` itself is NOT mocked — it must name the script (§3.12).
    // Scoped to the dialog itself: the header's own `HolderBadge` ALSO says
    // "checkout@1.4.2" (F25 — "everyone else sees it"), so a bare
    // `getByText` here would find two.
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText(/checkout@1\.4\.2/)).toBeTruthy())
    await user.click(within(dialog).getByRole('button', { name: 'Assist' }))

    await waitFor(() => expect(lastScreenCardProps?.inputEnabled).toBe(true))
    expect(lastScreenCardProps?.jobRunning).toBe(true)
    expect(lastScreenCardProps?.assisting).toEqual({ secondsLeft: expect.any(Number) })

    // The job's own hold is untouched (plan 91 §3.2's table: `heldBy` and its
    // `expiresAt` never move because of an assist grant) — nothing in this
    // flow sent a `lease.*` message at all.
    expect(wsSendCalls.some((m) => (m as { type: string }).type.startsWith('lease.'))).toBe(false)
  })

  test('the farm switch off disables the button with a reason, rather than hiding Assist entirely', async () => {
    setSearchParams({ id: 'dev-1' })
    renderWithApi(
      <TooltipProvider>
        <DevicePage />
      </TooltipProvider>,
      {
        ...busyResponses,
        '/api/settings': { body: { settings: { coControl: { mode: 'off' } }, schema: {}, deviceSchema: {} } },
      },
    )
    await waitFor(() => expect(lastScreenCardProps?.assistDisabledReason).toBe('Assisting is turned off for this farm.'))
  })

  test('an idle device (no job) never offers Assist', async () => {
    setSearchParams({ id: 'dev-1' })
    renderWithApi(<DevicePage />, baseResponses)
    await waitFor(() => expect(lastScreenCardProps).not.toBeNull())
    expect(lastScreenCardProps?.jobRunning).toBe(false)
    expect(lastScreenCardProps?.assisting).toBeFalsy()
  })
})
