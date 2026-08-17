import { afterEach, describe, expect, mock, test } from 'bun:test'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DeviceDetailInfo } from '@/components/device/DeviceHeader'

/**
 * `SidePanel`'s own `tabs` prop (plan 103 §5 step 103.10) — which of
 * `Actions | Inspector` a caller wants, defaulting to both (`DevicePopup`'s
 * own long-standing shape, covered end-to-end by `DevicePopup.test.tsx`
 * already). These two tests cover the restriction itself in isolation:
 * `components/wall/DeviceContextMenu.tsx` is the one caller that passes
 * `['actions']`, and its own test file proves that end-to-end — this file
 * proves the prop's contract directly, at the component that owns it.
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

const { SidePanel } = await import('./SidePanel')

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

const noop = () => {}

describe('SidePanel — tabs prop (plan 103 §5 step 103.10, extended by step 103.11)', () => {
  test('defaults to Actions, Inspector, and Record — DevicePopup\'s own unchanged shape', () => {
    const { getAllByRole } = renderWithApi(
      <TooltipProvider>
        <SidePanel
          deviceId="dev-1"
          device={device}
          devices={[device]}
          assistState="unavailable"
          canUseLive
          takeControlDisabledReason={null}
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
          onClaimControl={noop}
        />
      </TooltipProvider>,
    )
    expect(getAllByRole('tab').map((t) => t.textContent)).toEqual(['Actions', 'Inspector', 'Record'])
  })

  test('tabs={["actions"]} renders Actions only — a stated restriction, not a copy of the component', () => {
    const { getAllByRole, queryByRole } = renderWithApi(
      <TooltipProvider>
        <SidePanel
          deviceId="dev-1"
          device={device}
          devices={[device]}
          assistState="unavailable"
          canUseLive={false}
          onAssistSelect={noop}
          onDeviceReloaded={noop}
          onForgotten={noop}
          tabs={['actions']}
        />
      </TooltipProvider>,
    )
    expect(getAllByRole('tab').map((t) => t.textContent)).toEqual(['Actions'])
    expect(queryByRole('tab', { name: 'Inspector' })).toBeNull()
  })
})
