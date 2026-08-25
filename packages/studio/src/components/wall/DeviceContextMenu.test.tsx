import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@enkaku/ui'

/**
 * `DeviceContextMenu` (plan 101 §3.9, §5 step 101.5; rebuilt on `SidePanel`/
 * `ActionsList` by plan 103 §5 step 103.10 — see that component's own doc
 * comment for the full account). These tests cover what changed: the panel
 * now fetches a real device detail and renders panel 3's own card/tabs/
 * actions, so it needs the same `@/lib/ws` stub `ActionsList.test.tsx`
 * already uses (its own nested `AdbCommandDialog`/`AssistDialog` import it),
 * plus a mocked `/api/devices/:id`/`/api/settings` the old item-list version
 * never needed at all.
 */
mock.module('@/lib/ws', () => ({
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  ws: {
    on: () => () => {},
    onReconnected: () => () => {},
    onBinary: () => () => {},
    send: () => {},
    request: () => Promise.reject(new Error('ws not available in test')),
    getSessionId: () => 'test-session',
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { DeviceContextMenu } = await import('./DeviceContextMenu')

afterEach(cleanup)

const idleDevice = {
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
  heldBy: null,
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'adb-input',
  inspection: 'ui-server',
  settings: null,
  liveDisplay: null,
  nodeId: null,
  // No `connection` field — `DeviceConnectionSchema` (the real schema `api()`
  // validates the mocked response against) requires `medium`/`mediumSource`/
  // `networkLabel` alongside `kind`/`address`/`port`; omitting the key
  // entirely lets its own `.default()` supply a complete, valid object
  // (`kind: 'usb'`), the same fixture shape `DevicePopup.test.tsx`'s own
  // `idleDevice` already uses for the identical reason.
}

const other = { ...idleDevice, id: 'dev-2', label: 'moto g07' }

const settingsBody = { settings: {}, schema: {}, deviceSchema: {} }
const baseResponses = {
  '/api/devices/dev-1': { body: { device: idleDevice } },
  '/api/settings': { body: settingsBody },
}

function Menu(props: { deviceId: string; devices: { id: string; label: string }[]; selectedIds: string[]; onClose: () => void }) {
  return (
    <TooltipProvider>
      <DeviceContextMenu x={10} y={20} {...props} />
    </TooltipProvider>
  )
}

describe('DeviceContextMenu — renders panel 3, not a copy of it (plan 103 §5 step 103.10)', () => {
  test('shows a plausible loading state, then the device label as the header and the same action rows ActionsList renders alone', async () => {
    const { getByText, getAllByRole } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice]} selectedIds={['dev-1']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    const rows = [...getAllByRole('button'), ...getAllByRole('link')].filter((el) => el.getAttribute('aria-label') !== 'Close')
    // `idleDevice` has no `connection` field, so `DeviceConnectionSchema`'s
    // own default supplies `kind: 'usb'` — fourteen rows, matching
    // `ActionsList.test.tsx`'s own usb-device count (the fixed twelve, plus
    // "Move to the network (Wi-Fi/OTG)…" from plan 88 §5 / plan 96's hotfix,
    // plus "Set number as wallpaper" from plan 124 §4.6 step 124.6).
    //
    // This count is a SECOND, independent copy of `ActionsList.test.tsx`'s
    // (`:407`, `:426`) and that is exactly how it went stale: plan 124 added
    // its row, updated the counts in the file it owned, and this assertion —
    // in a different directory, owned by a different worker — kept asserting
    // the old number. Whoever adds row fifteen has to change BOTH. The
    // duplication is deliberate (this test's whole point is that the menu
    // renders panel 3 rather than a copy of it, so it must count for itself),
    // but the coupling is real and is worth this comment.
    expect(rows).toHaveLength(14)
  })

  test('with more than one device selected, the header reads "N devices selected" — the old menu\'s own rule', async () => {
    const { getByText } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice, other]} selectedIds={['dev-1', 'dev-2']} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: idleDevice } } },
    )
    await waitFor(() => expect(getByText('2 devices selected')).toBeTruthy())
  })

  test('the header and its region label both carry the device number (plan 124 §4.4 Group B, criterion 5)', async () => {
    // The whole point of this surface — a right-click on ONE tile in a rack
    // of physically identical phones. Two `moto g06`s are told apart by `#7`
    // and nothing else, so the number has to reach both the visible header
    // and the region's accessible name, not just one of them.
    const numbered = { ...idleDevice, number: 7 }
    const { getByText, getByRole } = renderWithApi(
      <Menu deviceId="dev-1" devices={[numbered]} selectedIds={['dev-1']} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: numbered } } },
    )
    await waitFor(() => expect(getByText('#7')).toBeTruthy())
    expect(getByText('moto g06')).toBeTruthy()
    expect(getByRole('region', { name: 'Device actions — #7 moto g06' })).toBeTruthy()
  })

  test('a device with no number renders the bare label — no `#`, no `#null` (plan 124 criterion 7)', async () => {
    // `idleDevice` omits `number` entirely, so `DeviceInfoSchema`'s own
    // `.default(null)` supplies it — the same path a device whose
    // reservation was explicitly released takes.
    const { getByText, getByRole, queryByText } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice]} selectedIds={['dev-1']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    expect(queryByText(/#/)).toBeNull()
    expect(getByRole('region', { name: 'Device actions — moto g06' })).toBeTruthy()
  })

  test('the Inspector tab is not reachable here — a stated decision, not a silently rendered subset (SidePanel\'s own tabs prop)', async () => {
    const { getByText, getAllByRole, queryByRole } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice]} selectedIds={['dev-1']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    expect(queryByRole('tab', { name: 'Inspector' })).toBeNull()
    expect(getAllByRole('tab').map((t) => t.textContent)).toEqual(['Actions'])
  })
})

describe('DeviceContextMenu — dismissal, unchanged from before this step', () => {
  test('Escape closes the menu when nothing else has claimed the key', async () => {
    let closed = false
    const { getByText } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice]} selectedIds={['dev-1']} onClose={() => (closed = true)} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closed).toBe(true)
  })

  test('Escape does NOT close the menu while a non-modal action dialog it opened is itself open (rule 1, same precedence DevicePopup documents)', async () => {
    let closed = false
    const { getByText, getByRole } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice]} selectedIds={['dev-1']} onClose={() => (closed = true)} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Run script' }))
    const dialog = await screen.findByRole('dialog')
    // Radix's `DismissableLayer` (capture phase, on `document`) dismisses
    // the topmost open layer and calls `preventDefault()` before this
    // panel's own bubble-phase `window` listener ever sees the event.
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(closed).toBe(false)
  })

  test('clicking the full-screen backdrop closes the menu', async () => {
    let closed = false
    const { getByText, container } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice]} selectedIds={['dev-1']} onClose={() => (closed = true)} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(closed).toBe(true)
  })

  test('the header\'s own Close button closes the menu', async () => {
    let closed = false
    const { getByText, getByRole } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice]} selectedIds={['dev-1']} onClose={() => (closed = true)} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Close' }))
    expect(closed).toBe(true)
  })
})

describe('DeviceContextMenu — never claims control on its own (plan 103 §5 step 103.10)', () => {
  test('Adb command opens a live-but-read-only terminal — no lease was claimed just by opening this menu', async () => {
    const { getByText, getByRole } = renderWithApi(
      <Menu deviceId="dev-1" devices={[idleDevice]} selectedIds={['dev-1']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Adb command' }))
    const dialog = await screen.findByRole('dialog')
    // `TerminalPane`'s own transcript renders regardless — `canType` is what
    // is false here (this surface never auto-claims a lease, unlike
    // `DevicePopup`), the same "watching, not holding" state the popup
    // itself shows for a device its own operator has not taken control of.
    await waitFor(() => expect(within(dialog).getByText('No commands run yet')).toBeTruthy())
  })
})
