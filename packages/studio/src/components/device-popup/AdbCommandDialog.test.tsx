import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DeviceInfo } from '@enkaku/protocol'

/**
 * `AdbCommandDialog` (plan 103 §9 Q4, answered 2026-08-16) in isolation —
 * the modal `ActionsList.test.tsx`'s own "Adb command" tests already prove
 * opens and defaults correctly; this file exercises the fan-out shape
 * itself (starting a run, `RunReport` rendering the initial members) since
 * that is new wiring this pass added, not a reuse of something already
 * tested elsewhere.
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

const { AdbCommandDialog } = await import('./AdbCommandDialog')

afterEach(() => {
  cleanup()
  wsSendCalls = []
})

const baseDevice = {
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
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
  assistedBy: [],
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'adb-input',
  inspection: 'ui-server',
  settings: null,
  liveDisplay: null,
  nodeId: null,
  connection: { kind: 'usb', address: null, port: null },
}
const device1 = { ...baseDevice, id: 'dev-1', label: 'moto g06' } as unknown as DeviceInfo
const device2 = { ...baseDevice, id: 'dev-2', label: 'moto g07' } as unknown as DeviceInfo
// A THIRD, unselected device — so targeting the two selected ones is not
// "every usable device on the farm" (plan 94 §9 Q4's fleet-wide gate,
// carried over unchanged by `useTargetSelection`), which would otherwise
// force typing a confirmation count before Run even becomes clickable —
// a real, separate behaviour this test is not about.
const device3 = { ...baseDevice, id: 'dev-3', label: 'moto g08' } as unknown as DeviceInfo

describe('AdbCommandDialog — single device renders the interactive TerminalPane (plan 103 §9 Q4)', () => {
  test('default target is this device, single, and shows the terminal transcript, not a command form', async () => {
    const { getByRole } = renderWithApi(
      <TooltipProvider>
        <AdbCommandDialog deviceId="dev-1" devices={[device1]} canUseLive open onOpenChange={() => {}} />
      </TooltipProvider>,
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Adb command')).toBeTruthy()
    await waitFor(() => expect(within(dialog).getByText('No commands run yet')).toBeTruthy())
    // The fan-out form's own controls — unique to `cluster`/`devices` mode —
    // are absent: this is the interactive session, not a one-shot command
    // form (`TerminalPane` has its own "Run" button for its transcript,
    // which IS expected here and is not what this assertion is about).
    expect(within(dialog).queryByText('Run on the first N first')).toBeNull()
  })
})

describe('AdbCommandDialog — multiple devices fan out through the fleet console pieces (plan 103 §9 Q4)', () => {
  test('starting a run POSTs /api/command-runs and RunReport shows the initial members', async () => {
    const { getByRole, getByPlaceholderText, apiMock } = renderWithApi(
      <TooltipProvider>
        <AdbCommandDialog
          deviceId="dev-1"
          devices={[device1, device2, device3]}
          selectedIds={['dev-1', 'dev-2']}
          canUseLive
          open
          onOpenChange={() => {}}
        />
      </TooltipProvider>,
      {
        '/api/command-runs': {
          body: {
            run: {
              id: 'run-1',
              cmd: 'getprop ro.build.version.release',
              target: { deviceIds: ['dev-1', 'dev-2'] },
              savedCommandId: null,
              stageFirstN: 0,
              stage: 0,
              concurrency: 0,
              status: 'running',
              acknowledged: false,
              createdBy: null,
              startedAt: 0,
              finishedAt: null,
              counts: { total: 2, pending: 2, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 },
            },
            members: [
              { deviceId: 'dev-1', seq: 0, stageIndex: 0, status: 'pending', exitCode: null, durationMs: null, outputHash: null, truncated: false, skip: null, error: null },
              { deviceId: 'dev-2', seq: 1, stageIndex: 0, status: 'pending', exitCode: null, durationMs: null, outputHash: null, truncated: false, skip: null, error: null },
            ],
            skipped: [],
          },
        },
      },
    )
    const dialog = await screen.findByRole('dialog')
    // Two devices selected on the Wall behind this popup → the picker
    // defaults to Multiple devices, pre-filled (plan 104 §3.2).
    expect(within(dialog).getByRole('tab', { name: 'Multiple devices' })).toBeTruthy()
    await waitFor(() => expect(within(dialog).getByText('Targets 2 devices')).toBeTruthy())

    fireEvent.change(getByPlaceholderText('getprop ro.build.version.release'), { target: { value: 'getprop ro.build.version.release' } })
    fireEvent.click(getByRole('button', { name: /^Run$/ }))

    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/command-runs' && c.method === 'POST')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/command-runs')
    expect((call?.body as { target?: unknown })?.target).toEqual({ deviceIds: ['dev-1', 'dev-2'] })

    // The fleet console's own `RunReport` — the same per-device, outcome-
    // grouped shape `/console` uses (docs/design.md's "Multi-device reports").
    await waitFor(() => expect(within(dialog).getByTestId('run-report')).toBeTruthy())
    expect(within(dialog).getByText(/2 pending/)).toBeTruthy()
  })
})
