import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@enkaku/ui'
import type { DeviceDetailInfo } from '@/components/device/DeviceHeader'

/**
 * `ActionsList` (plan 103 §4.2, §5 step 103.3) in isolation — the compact
 * twelve-row list, tested directly rather than only through `DevicePopup`
 * so each row's wiring (which dialog opens, which fires directly, which is
 * a genuinely disabled placeholder naming the step that fills it in) has
 * its own assertion.
 */
let wsSendCalls: { type: string; payload?: unknown }[] = []

/**
 * Plan 124 §4.6, step 124.6, acceptance criterion 9 — the wallpaper row's
 * whole point is that it reports the server's `state` VERBATIM, so the toast
 * copy has to be asserted, and toast copy is only visible from a spy:
 * `Toaster` is mounted by the app shell, never by a component test (the
 * convention `AdmitDeviceDialog.test.tsx`/`ActionRunner.test.tsx` established).
 *
 * `Toaster` is part of the stub because `@enkaku/ui` is a single barrel (plan
 * 111 step 111.1) — importing ANY component from it evaluates the wrapper that
 * re-exports sonner's `Toaster`, and a `toast`-only stub makes the whole module
 * graph fail to link rather than just these assertions.
 */
const toastSuccess = mock((_message: string, _opts?: { description?: string }) => {})
const toastWarning = mock((_message: string, _opts?: { description?: string }) => {})
const toastError = mock((_message: string, _opts?: { description?: string }) => {})
mock.module('sonner', () => ({
  toast: { success: toastSuccess, warning: toastWarning, error: toastError },
  Toaster: () => null,
}))

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
    send: (msg: { type: string; payload?: unknown }) => wsSendCalls.push(msg),
    request: () => Promise.reject(new Error('ws not available in test')),
    getSessionId: () => 'test-session',
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { ActionsList } = await import('./ActionsList')

afterEach(() => {
  cleanup()
  wsSendCalls = []
  toastSuccess.mockClear()
  toastWarning.mockClear()
  toastError.mockClear()
})

const usbDevice = {
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
  connection: { kind: 'usb', address: null, port: null },
} as unknown as DeviceDetailInfo

const tcpDevice = { ...usbDevice, connection: { kind: 'tcp', address: '10.0.0.5', port: 5555 } } as unknown as DeviceDetailInfo

const noop = () => {}

describe('ActionsList — Reconnect always reconnects, on USB and TCP alike (plan 88, plan 96 hotfix — the mislabeled row)', () => {
  test('a tcp device fires POST /connection/reconnect directly, no dialog', async () => {
    const { getByRole, apiMock } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={tcpDevice} devices={[tcpDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
      { '/api/devices/dev-1/connection/reconnect': { body: { result: 'connected', address: '10.0.0.5:5555' } } },
    )
    fireEvent.click(getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/devices/dev-1/connection/reconnect')).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // Before this fix, a USB device's "Reconnect" row silently opened the
  // Cutover wizard instead of reconnecting — the exact defect this session
  // found and this test now guards against.
  test('a usb device ALSO fires POST /connection/reconnect directly, no dialog — no longer doubles as the cutover trigger', async () => {
    const { getByRole, apiMock } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={usbDevice} devices={[usbDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
      { '/api/devices/dev-1/connection/reconnect': { body: { result: 'already-connected', serial: 'ZP2222RMBS' } } },
    )
    fireEvent.click(getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/devices/dev-1/connection/reconnect')).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('ActionsList — "Move to the network…" is its own row, reachable independently of Reconnect (plan 88 §5, plan 96 hotfix)', () => {
  test('usb: the row is present and opens the Cutover wizard', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={usbDevice} devices={[usbDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Move to the network (Wi-Fi/OTG)…' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText('Move moto g06 to the network')).toBeTruthy()
  })

  test('tcp: the row does not render at all — a device already on the network has nowhere left to move to', async () => {
    renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={tcpDevice} devices={[tcpDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Move to the network (Wi-Fi/OTG)…' })).toBeNull()
  })
})

describe('ActionsList — Disconnect is disabled with a reason on USB (plan 103 §4.2)', () => {
  test('usb: the row is disabled and names why', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={usbDevice} devices={[usbDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Disconnect' }))
    // No dialog opens — the click is intercepted by `preventDefault`.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('tcp: the row opens DisconnectDeviceDialog, non-modal', async () => {
    const { getByRole, baseElement } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={tcpDevice} devices={[tcpDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })
})

describe('ActionsList — Install apk opens InstallBatchDialog, non-modal (plan 103 §4.2)', () => {
  test('opens for exactly this one device by default, no live selection', async () => {
    const { getByRole, getByText, baseElement } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={usbDevice} devices={[usbDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Install apk' }))
    await waitFor(() => expect(getByText('Install on 1 device')).toBeTruthy())
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })

  test('with a live Wall selection behind the popup, opens pre-filled with it (plan 104 §3.2)', async () => {
    const other = { ...usbDevice, id: 'dev-2', label: 'moto g07' }
    const { getByRole, getByText } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice, other]}
          selectedIds={['dev-1', 'dev-2']}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
         
        />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Install apk' }))
    await waitFor(() => expect(getByText('Install on 2 devices')).toBeTruthy())
  })
})

describe('ActionsList — Run script opens RunScriptDialog, non-modal (plan 103 §4.2)', () => {
  test('opens defaulted to this device, single — but still editable, not locked (plan 104 §3.2)', async () => {
    const { getByRole, baseElement } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={usbDevice} devices={[usbDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
      {
        '/api/scripts*': {
          body: {
            items: [
              { id: 'script-1', name: 'checkout', version: '1.0.0', kind: 'script', paramsSchema: null, enabled: true, createdBy: null, createdAt: 0, hasResult: false },
            ],
            nextCursor: null,
          },
        },
        '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Run script' }))
    const dialog = await screen.findByRole('dialog')
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    // Plan 104 §3.2 — the popup's own focus device is the DEFAULT, not a
    // lock: the mode-switch tabs are present (the old `lockedDevice` path
    // rendered none of them), and Single device is the active one.
    expect(within(dialog).getByRole('tab', { name: 'Single device' })).toBeTruthy()
    expect(within(dialog).getByRole('tab', { name: 'Multiple devices' })).toBeTruthy()
  })

  test('with a live Wall selection behind the popup, opens pre-filled with it, still editable (plan 104 §3.2)', async () => {
    const other = { ...usbDevice, id: 'dev-2', label: 'moto g07' }
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice, other]}
          selectedIds={['dev-1', 'dev-2']}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
         
        />
      </TooltipProvider>,
      {
        '/api/scripts*': {
          body: {
            items: [
              { id: 'script-1', name: 'checkout', version: '1.0.0', kind: 'script', paramsSchema: null, enabled: true, createdBy: null, createdAt: 0, hasResult: false },
            ],
            nextCursor: null,
          },
        },
        '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Run script' }))
    const dialog = await screen.findByRole('dialog')
    // The resolved count is always visible (plan 104 §3.2) — both selected
    // devices, pre-filled without the operator touching the picker.
    await waitFor(() => expect(within(dialog).getByText('Targets 2 devices')).toBeTruthy())
  })
})

describe('ActionsList — Files, Jobs, Settings open their own popup (plan 103 §5 steps 103.4/103.6)', () => {
  test('Files opens FilesPopup, non-modal', async () => {
    const { getByRole, baseElement } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice]}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
         
        />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Files' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Files')).toBeTruthy()
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })

  test('Jobs opens JobsPopup, non-modal, with Jobs/Crashes/Logs tabs and no navigating job row', async () => {
    const { getByRole, baseElement } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice]}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
         
        />
      </TooltipProvider>,
      { '/api/jobs?deviceId=dev-1&limit=50': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    fireEvent.click(getByRole('button', { name: 'Jobs' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('tab', { name: 'Crashes' })).toBeTruthy()
    expect(within(dialog).getByRole('tab', { name: 'Logs' })).toBeTruthy()
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    // No `next/link` inside this popup's Jobs tab — a device row cannot
    // navigate away from the Wall this popup floats over (§5 step 103.4's
    // own verifiable result).
    expect(within(dialog).queryAllByRole('link')).toHaveLength(0)
  })

  test('Settings opens SettingsPopup, non-modal, sectioned General/Identity/KV/Network/Preparation/Agent/Video/Timing/Labelling/Tags', async () => {
    const { getByRole, baseElement } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice]}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}

        />
      </TooltipProvider>,
      {
        '/api/settings': { body: { settings: {}, schema: {}, deviceSchema: { properties: {} } } },
        '/api/devices/dev-1/preparation': { body: {} },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Settings' }))
    const dialog = await screen.findByRole('dialog')
    // Plan 103 §5, closing step 103.11's audit rows 17-19 — General, Video,
    // and Timing joined the original six. Plan 106 §5 step 106.3 — Preparation
    // is the tenth.
    for (const title of ['General', 'Identity', 'KV', 'Network', 'Preparation', 'Agent', 'Video', 'Timing', 'Labelling', 'Tags']) {
      expect(within(dialog).getByText(title)).toBeTruthy()
    }
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })
})

describe('ActionsList — Adb command opens AdbCommandDialog, non-modal (plan 103 §9 Q4, answered 2026-08-16)', () => {
  test('opens a non-modal dialog carrying a TargetPicker, defaulted to this device — the interactive terminal, not a fleet form', async () => {
    const { getByRole, baseElement } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice]}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
        />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Adb command' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Adb command')).toBeTruthy()
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    // `single` (the default with nothing else selected) renders TerminalPane
    // unchanged — the interactive session, not dropped, just relocated here
    // from the side panel's old Terminal tab.
    await waitFor(() => expect(within(dialog).getByText('No commands run yet')).toBeTruthy())
  })

  test('with a live Wall selection behind the popup, the picker defaults to Multiple devices, pre-filled (plan 104 §3.2)', async () => {
    const other = { ...usbDevice, id: 'dev-2', label: 'moto g07' }
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice, other]}
          selectedIds={['dev-1', 'dev-2']}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
        />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Adb command' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('tab', { name: 'Multiple devices' })).toBeTruthy()
    // The fan-out shape (a command input plus a Run button), not the
    // single-device TerminalPane — the resolved count is always visible
    // (plan 104 §3.2), matching what a submit would actually send.
    await waitFor(() => expect(within(dialog).getByText('Targets 2 devices')).toBeTruthy())
    expect(within(dialog).queryByText('No commands run yet')).toBeNull()
  })
})

describe('ActionsList — the row count fits without scrolling at a plausible panel width (plan 103 §4.2, §6; grows by one, deliberately, on USB — see the "Move to the network…" row\'s own comment)', () => {
  test('a usb device renders exactly thirteen rows plus the dialogs — the fixed twelve, plus "Move to the network…"', () => {
    const { getAllByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice]}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}

        />
      </TooltipProvider>,
    )
    const rows = [...getAllByRole('button'), ...getAllByRole('link')]
    // Plan 124 §3.6, step 124.6 — thirteen became fourteen when "Set number
    // as wallpaper" was added. The fit was measured, not assumed: see
    // `ActionsList.tsx`'s own file header for the arithmetic, and for the
    // stronger point that a USB device with a live multi-selection behind the
    // popup already rendered fourteen rows before this row existed.
    expect(rows).toHaveLength(14)
  })

  test('a tcp device renders exactly thirteen rows — no "Move to the network…" row, nothing left to move to', () => {
    const { getAllByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={tcpDevice}
          devices={[tcpDevice]}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
        />
      </TooltipProvider>,
    )
    const rows = [...getAllByRole('button'), ...getAllByRole('link')]
    expect(rows).toHaveLength(13)
  })
})

describe('ActionsList — Wake/Sleep and Forget act on the whole candidate set (plan 103 §5 step 103.10)', () => {
  const other = { ...usbDevice, id: 'dev-2', label: 'moto g07' }

  test('with more than one candidate, Wake/Sleep become two explicit rows instead of the single dynamic-label one', () => {
    const { getByRole, queryByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice, other]}
          selectedIds={['dev-1', 'dev-2']}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
        />
      </TooltipProvider>,
    )
    expect(getByRole('button', { name: 'Wake' })).toBeTruthy()
    expect(getByRole('button', { name: 'Sleep' })).toBeTruthy()
    // The single-candidate row this replaces would ALSO have been labelled
    // "Sleep" for this device's own readiness (`actual: 'awake'`) — proving
    // there are exactly two rows, not the dynamic one plus a duplicate.
    expect(queryByRole('button', { name: 'Wake' })).not.toBeNull()
  })

  test('clicking Sleep with two candidates selected sets readiness on BOTH, independently, and reports the outcome', async () => {
    const { getByRole, getByText, apiMock } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice, other]}
          selectedIds={['dev-1', 'dev-2']}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
        />
      </TooltipProvider>,
      {
        '/api/devices/dev-1/readiness': { body: { readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 0 } } },
        '/api/devices/dev-2/readiness': { body: { readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 0 } } },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Sleep' }))
    await waitFor(() => expect(apiMock.calls.filter((c) => c.method === 'PUT').length).toBe(2))
    expect(apiMock.calls.some((c) => c.path === '/api/devices/dev-1/readiness')).toBe(true)
    expect(apiMock.calls.some((c) => c.path === '/api/devices/dev-2/readiness')).toBe(true)
    // The same `OutcomeSummary`/`SkippedGroups` report shape `app/page.tsx`'s
    // own `wakeOrSleepSelected` already produces, moved here rather than
    // reinvented (this file's own doc comment).
    await waitFor(() => expect(getByText('Sleep — result')).toBeTruthy())
  })

  test('at exactly one candidate, Forget opens the single-device ForgetDeviceDialog, unchanged', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={usbDevice} devices={[usbDevice]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Forget' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Forget moto g06?')).toBeTruthy()
  })

  test('with more than one candidate, Forget opens BulkForgetDialog with a fleet-wide confirmation instead', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={usbDevice}
          devices={[usbDevice, other]}
          selectedIds={['dev-1', 'dev-2']}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
        />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Forget' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Forget 2 devices?')).toBeTruthy()
    // Non-modal, matching the single-device path's own `nonModal` (plan 103
    // §5 step 103.10) — the same row must not behave inconsistently only
    // because the candidate count changed.
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })
})

/**
 * "Set number as wallpaper" (plan 124 §0.4, §3.5, §4.6, step 124.6) — the
 * one-click way in to a mechanism that has worked end to end since plan 89
 * and until now cost six clicks through two nested dialogs.
 *
 * The load-bearing assertions in this block are the `partial` and
 * `unavailable` ones (acceptance criterion 9). The black wallpaper is a
 * PHYSICAL change to a phone an operator is not looking at; a toast that
 * rounds `unavailable` up to "Done" is worse than no row at all, because the
 * operator then walks to a rack believing forty-five phones are labelled.
 */
const labelled = {
  ...usbDevice,
  number: 7,
  agent: 'ready',
  // A real settings blob, because the single-device flow deliberately does NOT
  // re-fetch: the popup already holds `device.settings`, and the read-modify-
  // write goes against that copy (plan 124 §3.5). The `proxy` key is here to
  // prove it survives the whole-blob PATCH.
  settings: { proxy: { mode: 'off' }, labelling: { mode: 'off', showName: true } },
} as unknown as DeviceDetailInfo

/** A body that satisfies BOTH `DeviceDetailResponseSchema` (the GET) and `DeviceResponseSchema` (the PATCH) — Zod strips the extra keys for the narrower one. */
function detailBody(id: string, label: string) {
  return {
    device: {
      id,
      stableId: `stable-${id}`,
      serial: `serial-${id}`,
      label,
      androidVersion: '15',
      apiLevel: 35,
      screenW: 720,
      screenH: 1600,
      density: 280,
      status: 'idle',
      lastSeen: 1,
      number: 7,
      agent: 'ready',
      transport: 'adb-usb',
      display: 'scrcpy',
      liveDisplay: null,
      input: 'adb-input',
      inspection: 'ui-server',
      settings: { proxy: { mode: 'off' }, labelling: { mode: 'off', showName: true } },
      nodeId: null,
    },
  }
}

function labelState(state: string, reason: string | null) {
  return { mode: 'wallpaper', state, reason, fingerprint: 'fp', appliedAt: 1, originalCaptured: true, capturedLockScreen: null }
}

describe('ActionsList — Set number as wallpaper, single device (plan 124 §3.5, §4.6, step 124.6)', () => {
  test('one press sends the whole-blob PATCH and then the apply — and preserves every other settings key', async () => {
    const { getByRole, apiMock } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={labelled} devices={[labelled]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
      {
        '/api/devices/dev-1': { body: detailBody('dev-1', 'moto g06') },
        '/api/devices/dev-1/label/apply': { body: labelState('applied', null) },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/devices/dev-1/label/apply' && c.method === 'POST')).toBe(true))

    const patch = apiMock.calls.find((c) => c.method === 'PATCH')
    expect(patch).toBeTruthy()
    const settings = (patch?.body as { settings: Record<string, unknown> }).settings
    // `PATCH /api/devices/:id` REPLACES the whole blob — plan 124 §3.5's
    // reason the action is two requests at all. A patch body carrying only
    // `labelling` would silently wipe this device's proxy settings.
    expect(settings.proxy).toEqual({ mode: 'off' })
    expect(settings.labelling).toEqual({ mode: 'wallpaper', showName: true })
    // And no GET first — the popup already holds this device's settings, so a
    // re-fetch would be a request paid for nothing (§3.5).
    expect(apiMock.calls.some((c) => c.method === 'GET' && c.path === '/api/devices/dev-1')).toBe(false)
  })

  test('`applied` is a success toast naming the device with its number', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={labelled} devices={[labelled]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
      {
        '/api/devices/dev-1': { body: detailBody('dev-1', 'moto g06') },
        '/api/devices/dev-1/label/apply': { body: labelState('applied', null) },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(toastSuccess.mock.calls[0]?.[0]).toContain('#7 moto g06')
    expect(toastError).not.toHaveBeenCalled()
    expect(toastWarning).not.toHaveBeenCalled()
  })

  test('`partial` is a WARNING carrying the service’s own reason — never worded as success', async () => {
    const reason = 'only the home screen accepted the label — the other surface likely refused it (an OEM skin, plan 89 §0.2 H5)'
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={labelled} devices={[labelled]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
      {
        '/api/devices/dev-1': { body: detailBody('dev-1', 'moto g06') },
        '/api/devices/dev-1/label/apply': { body: labelState('partial', reason) },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    // Acceptance criterion 9: no state is rounded up.
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastWarning.mock.calls[0]?.[0]).toContain('#7 moto g06')
    // The reason is the SERVER's, verbatim — it is what names which surface took.
    expect(toastWarning.mock.calls[0]?.[1]?.description).toBe(reason)
  })

  test('`unavailable` is an ERROR carrying the reason — never worded as success', async () => {
    const reason = "this device's guest agent has no screen-label capability"
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={labelled} devices={[labelled]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
      {
        '/api/devices/dev-1': { body: detailBody('dev-1', 'moto g06') },
        '/api/devices/dev-1/label/apply': { body: labelState('unavailable', reason) },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError.mock.calls[0]?.[1]?.description).toBe(reason)
  })

  test('`stale` is reported as itself — neither success nor error', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={labelled} devices={[labelled]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
      {
        '/api/devices/dev-1': { body: detailBody('dev-1', 'moto g06') },
        '/api/devices/dev-1/label/apply': { body: labelState('stale', null) },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastWarning.mock.calls[0]?.[0]).toContain('stale')
  })
})

describe('ActionsList — Set number as wallpaper is disabled with a stated reason (plan 124 §4.6, criterion 10)', () => {
  // Every one of these is checked LOCALLY, before any request — a dead click
  // is worse than a stated refusal, and each of these facts is already in hand.
  const cases: Array<[string, DeviceDetailInfo]> = [
    ['no number', { ...usbDevice, number: null, agent: 'ready' } as unknown as DeviceDetailInfo],
    ['offline', { ...usbDevice, number: 7, agent: 'ready', status: 'offline' } as unknown as DeviceDetailInfo],
    ['no guest agent', { ...usbDevice, number: 7, agent: 'absent' } as unknown as DeviceDetailInfo],
  ]
  for (const [name, device] of cases) {
    test(`${name}: the row does not fire a request`, async () => {
      const { getByRole, apiMock } = renderWithApi(
        <TooltipProvider>
          <ActionsList deviceId="dev-1" device={device} devices={[device]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
        </TooltipProvider>,
      )
      fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
      // The click is intercepted by `preventDefault` (the `Row` component's
      // styling-only disabled path, kept so the tooltip explaining WHY still
      // fires) — nothing reaches the network.
      expect(apiMock.calls.some((c) => c.path.includes('label'))).toBe(false)
      expect(apiMock.calls.some((c) => c.method === 'PATCH')).toBe(false)
    })
  }

  test('a quarantined device is refused for the same reason an offline one is', () => {
    const quarantined = { ...usbDevice, number: 7, agent: 'ready', status: 'quarantined' } as unknown as DeviceDetailInfo
    const { getByRole, apiMock } = renderWithApi(
      <TooltipProvider>
        <ActionsList deviceId="dev-1" device={quarantined} devices={[quarantined]} assistState="unavailable" canUseLive onAssistSelect={noop} onDeviceReloaded={noop} onForgotten={noop} />
      </TooltipProvider>,
    )
    fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
    expect(apiMock.calls.some((c) => c.method === 'PATCH')).toBe(false)
  })
})

describe('ActionsList — Set number as wallpaper over the whole candidate set (plan 124 §4.6, criterion 11)', () => {
  const other = { ...labelled, id: 'dev-2', label: 'moto g07', number: 8 } as unknown as DeviceDetailInfo

  test('sets the mode on every candidate, applies ONCE, and groups the outcomes by state', async () => {
    const { getByRole, getByText, apiMock } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={labelled}
          devices={[labelled, other]}
          selectedIds={['dev-1', 'dev-2']}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
        />
      </TooltipProvider>,
      {
        '/api/devices/dev-1': { body: detailBody('dev-1', 'moto g06') },
        '/api/devices/dev-2': { body: detailBody('dev-2', 'moto g07') },
        '/api/devices/labels/apply': {
          body: {
            total: 2,
            results: [
              { deviceId: 'dev-1', state: labelState('applied', null), error: null },
              { deviceId: 'dev-2', state: labelState('unavailable', "this device's guest agent has no screen-label capability"), error: null },
            ],
          },
        },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
    await waitFor(() => expect(getByText('Set number as wallpaper — result')).toBeTruthy())

    // One PATCH per device, and exactly ONE fleet apply — never one apply per
    // device (plan 124 §4.6).
    expect(apiMock.calls.filter((c) => c.method === 'PATCH').length).toBe(2)
    expect(apiMock.calls.filter((c) => c.path === '/api/devices/labels/apply').length).toBe(1)

    // `applied` is the only ok. The refusal is named, with the server's own
    // words — never a flattened "1 failed".
    expect(getByText('1 ok · 0 failed · 1 skipped (2/2)')).toBeTruthy()
    expect(getByText("this device's guest agent has no screen-label capability")).toBeTruthy()
  })

  test('a device whose mode PATCH fails is reported as failed and is left out of the apply', async () => {
    const { getByRole, getByText, apiMock } = renderWithApi(
      <TooltipProvider>
        <ActionsList
          deviceId="dev-1"
          device={labelled}
          devices={[labelled, other]}
          selectedIds={['dev-1', 'dev-2']}
          assistState="unavailable"
          canUseLive
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
        />
      </TooltipProvider>,
      {
        '/api/devices/dev-1': { body: detailBody('dev-1', 'moto g06') },
        '/api/devices/dev-2': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'settings write failed' } } },
        '/api/devices/labels/apply': {
          body: { total: 1, results: [{ deviceId: 'dev-1', state: labelState('applied', null), error: null }] },
        },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Set number as wallpaper' }))
    await waitFor(() => expect(getByText('Set number as wallpaper — result')).toBeTruthy())

    const apply = apiMock.calls.find((c) => c.path === '/api/devices/labels/apply')
    expect((apply?.body as { deviceIds: string[] }).deviceIds).toEqual(['dev-1'])
    expect(getByText('1 ok · 1 failed · 0 skipped (2/2)')).toBeTruthy()
    expect(getByText('settings write failed')).toBeTruthy()
  })
})
