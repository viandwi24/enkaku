import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

// `api()` reads `coreBase()` from `@/lib/ws` — see `BulkForgetDialog.test.tsx`'s
// identical comment for why this mock is needed even though this component
// never imports `@/lib/ws` itself.
import { mock } from 'bun:test'
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { BulkCutoverDialog } = await import('./BulkCutoverDialog')

afterEach(cleanup)

function makeDevice(id: string, label: string, overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id,
    stableId: id,
    serial: id,
    label,
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
    ...overrides,
  } as DeviceInfo
}

const usbDevice = (id: string, label: string) => makeDevice(id, label, { connection: { kind: 'usb' } } as Partial<DeviceInfo>)
const tcpDevice = (id: string, label: string) =>
  makeDevice(id, label, { connection: { kind: 'tcp', address: '10.0.0.5', port: 5555 } } as Partial<DeviceInfo>)

function cutoverBody(overrides: Record<string, unknown> = {}) {
  return {
    cutover: {
      deviceId: 'ignored',
      stableId: 'ignored',
      step: 'armed',
      detail: 'Flip the port on the chassis from USB to OTG now.',
      port: 5555,
      medium: 'wired',
      persistSurvivesReboot: null,
      triedAddresses: 0,
      answered: 0,
      startedAt: Date.now(),
      expiresAt: Date.now() + 180_000,
      connectedAddress: null,
      ...overrides,
    },
  }
}

describe('BulkCutoverDialog — eligibility (plan 88 §5, the bulk cutover request)', () => {
  test('a non-usb (already on the network) device is skipped with a stated reason, never sent a request', async () => {
    const usb = usbDevice('d1', 'Phone A')
    const tcp = tcpDevice('d2', 'Phone B')
    // No `allDevices` — see `InstallBatchDialog`'s identical convention:
    // omitting it means `usableCount` is `Infinity`, so this test is not
    // also exercising the unrelated fleet-wide typed-confirmation gate
    // (`useTargetSelection`'s own `fleetWide` — covered by
    // `BulkForgetDialog.test.tsx` already).
    const { getByText, apiMock } = renderWithApi(
      <BulkCutoverDialog devices={[usb, tcp]} open onOpenChange={() => {}} />,
      { '/api/devices/*/connection/cutover': () => ({ body: cutoverBody() }) },
    )
    fireEvent.click(getByText('Arm 2 devices'))
    await waitFor(() => expect(getByText(/Already on the network/)).toBeTruthy())
    // Only the eligible (USB) device is ever called.
    const calls = apiMock.calls.filter((c) => c.path.includes('/connection/cutover'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/api/devices/d1/connection/cutover')
  })

  test('an offline usb device is skipped with a stated reason, never sent a request', async () => {
    const offline = usbDevice('d1', 'Phone A')
    offline.status = 'offline'
    const { getByText, apiMock } = renderWithApi(
      <BulkCutoverDialog devices={[offline]} allDevices={[offline]} open onOpenChange={() => {}} />,
      { '/api/devices/*/connection/cutover': () => ({ body: cutoverBody() }) },
    )
    fireEvent.click(getByText('Arm 1 device'))
    await waitFor(() => expect(getByText(/Offline/)).toBeTruthy())
    expect(apiMock.calls.filter((c) => c.path.includes('/connection/cutover'))).toHaveLength(0)
  })

  test('an eligible usb device is armed, and the report names it', async () => {
    const usb = usbDevice('d1', 'Phone A')
    const { getByText } = renderWithApi(
      <BulkCutoverDialog devices={[usb]} allDevices={[usb]} open onOpenChange={() => {}} />,
      { '/api/devices/*/connection/cutover': () => ({ body: cutoverBody() }) },
    )
    fireEvent.click(getByText('Arm 1 device'))
    await waitFor(() => expect(getByText(/armed — flip each one's chassis port/)).toBeTruthy())
  })
})

describe('BulkCutoverDialog — one port applies to every targeted device (plan 88 §5)', () => {
  test('the same port is sent to every eligible device in the target', async () => {
    const a = usbDevice('d1', 'Phone A')
    const b = usbDevice('d2', 'Phone B')
    // No `allDevices` — see the identical comment above.
    const { getByText, getByLabelText, apiMock } = renderWithApi(
      <BulkCutoverDialog devices={[a, b]} open onOpenChange={() => {}} />,
      { '/api/devices/*/connection/cutover': () => ({ body: cutoverBody() }) },
    )
    fireEvent.change(getByLabelText('Port'), { target: { value: '6000' } })
    fireEvent.click(getByText('Arm 2 devices'))
    await waitFor(() => expect(apiMock.calls.filter((c) => c.path.includes('/connection/cutover'))).toHaveLength(2))
    const bodies = apiMock.calls.filter((c) => c.path.includes('/connection/cutover')).map((c) => c.body)
    expect(bodies).toEqual([
      { medium: 'wired', port: 6000 },
      { medium: 'wired', port: 6000 },
    ])
  })
})

describe('BulkCutoverDialog — a server-side refusal lands in Failed, not silently dropped', () => {
  test('a `failed` cutover step is reported by its own detail', async () => {
    const usb = usbDevice('d1', 'Phone A')
    const { getByText } = renderWithApi(
      <BulkCutoverDialog devices={[usb]} allDevices={[usb]} open onOpenChange={() => {}} />,
      { '/api/devices/*/connection/cutover': () => ({ body: cutoverBody({ step: 'failed', detail: 'could not enable TCP mode on port 5555: boom' }) }) },
    )
    fireEvent.click(getByText('Arm 1 device'))
    await waitFor(() => expect(getByText(/could not enable TCP mode/)).toBeTruthy())
  })
})
