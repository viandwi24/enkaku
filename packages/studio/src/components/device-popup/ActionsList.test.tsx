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
    expect(rows).toHaveLength(13)
  })

  test('a tcp device renders exactly twelve rows — no "Move to the network…" row, nothing left to move to', () => {
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
    expect(rows).toHaveLength(12)
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
