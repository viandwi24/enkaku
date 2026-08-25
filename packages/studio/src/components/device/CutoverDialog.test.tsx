import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `device.cutover` broadcasts are how a completed/failed cutover reaches an
 * already-open dialog (plan 88 §3.4, §4.6, §5 step 88.5) — `ws.on`'s
 * callback is captured here so a test can fire one manually, the same way
 * `AdbEndpointCard.test.tsx`/`EnrollmentDialog` tests simulate a live push
 * without a real socket.
 */
let wsCallback: ((m: { type: string; payload: unknown }) => void) | null = null
mock.module('@/lib/ws', () => ({
  ws: {
    on: (cb: (m: { type: string; payload: unknown }) => void) => {
      wsCallback = cb
      return () => {
        wsCallback = null
      }
    },
    send: () => {},
    onReconnected: () => () => {},
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { CutoverDialog } = await import('./CutoverDialog')

afterEach(cleanup)

const device: DeviceInfo = {
  id: 'dev-1',
  stableId: 'stable-1',
  serial: 'ZP2222RMBS',
  number: 3,
  label: 'Pixel 7 Pro',
  androidVersion: '15',
  apiLevel: 35,
  screenW: 1080,
  screenH: 2400,
  density: 420,
  status: 'idle',
  lastSeen: 1,
  battery: null,
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
}

const armedState = {
  deviceId: 'dev-1',
  stableId: 'stable-1',
  step: 'armed' as const,
  // Deliberately NOT the same words as the dialog's own hardcoded "Flip the
  // port…" instruction — the two are shown as separate paragraphs (the
  // instruction is fixed UI copy, `detail` is the server's own live status),
  // and a fixture that duplicates the instruction's wording would make
  // `getByText` match two elements and fail with "multiple elements found".
  detail: 'watching for the phone on the network — 0 address(es) tried so far',
  port: 5555,
  medium: 'wired' as const,
  persistSurvivesReboot: true,
  triedAddresses: 0,
  answered: 0,
  startedAt: Date.now(),
  expiresAt: Date.now() + 180_000,
  connectedAddress: null,
}

describe('CutoverDialog (plan 88 §3.4, §4.6, §5 step 88.5)', () => {
  test('the Check screen names the physical chassis flip and offers port/medium/address fields', () => {
    const { getByText, getByLabelText } = renderWithApi(
      <CutoverDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    // Plan 124 §4.4, criterion 5, step 124.3 — a cutover is a physical action
    // on ONE chassis port, so the wizard's title has to name the phone the
    // operator is about to walk over to, not the model it happens to be.
    expect(getByText('Move #3 Pixel 7 Pro to the network')).toBeTruthy()
    expect(getByText(/no software can press it for you/)).toBeTruthy()
    expect(getByLabelText('Port')).toBeTruthy()
    expect(getByLabelText('Medium')).toBeTruthy()
    expect(getByLabelText(/Address/)).toBeTruthy()
  })

  test('Enable & arm posts { medium, port, address } and shows the armed screen from the response — not a second round trip', async () => {
    const { getByRole, getByLabelText, getByText, apiMock } = renderWithApi(
      <CutoverDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      { '/api/devices/dev-1/connection/cutover': { body: { cutover: armedState } } },
    )
    fireEvent.change(getByLabelText('Port'), { target: { value: '5599' } })
    fireEvent.change(getByLabelText(/Address/), { target: { value: '10.20.0.9:5555' } })
    fireEvent.click(getByRole('button', { name: /Enable & arm/ }))

    await waitFor(() => expect(getByText(/Flip the port on the chassis/)).toBeTruthy())
    const call = apiMock.calls.find((c) => c.path === '/api/devices/dev-1/connection/cutover' && c.method === 'POST')
    expect(call?.body).toEqual({ medium: 'wired', port: 5599, address: '10.20.0.9:5555' })
  })

  test('a refused start (already on the network) shows the coded refusal message, not a generic failure', async () => {
    const { getByRole, getByText } = renderWithApi(
      <CutoverDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {
        '/api/devices/dev-1/connection/cutover': {
          status: 409,
          body: { error: { code: 'E_ALREADY_ON_NETWORK', message: 'Pixel 7 Pro is already on the network — use Disconnect/Reconnect instead.' } },
        },
      },
    )
    fireEvent.click(getByRole('button', { name: /Enable & arm/ }))
    await waitFor(() => expect(getByText(/already on the network/)).toBeTruthy())
  })

  test('a failed arm (the server refused a bad read-back) shows the failure detail and offers Try again, which returns to the Check screen', async () => {
    const failedState = { ...armedState, step: 'failed' as const, detail: 'refusing to arm — service.adb.tcp.port reads "", not 5555.', expiresAt: null }
    const { getByRole, getByText, getByLabelText } = renderWithApi(
      <CutoverDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      { '/api/devices/dev-1/connection/cutover': { body: { cutover: failedState } } },
    )
    fireEvent.click(getByRole('button', { name: /Enable & arm/ }))
    await waitFor(() => expect(getByText(/refusing to arm/)).toBeTruthy())

    fireEvent.click(getByRole('button', { name: 'Try again' }))
    expect(getByLabelText('Port')).toBeTruthy() // back on the Check screen
  })

  test('cancelling while armed calls DELETE and closes the dialog', async () => {
    let openState = true
    const onOpenChange = (v: boolean) => {
      openState = v
    }
    const { getByRole, getByText, apiMock } = renderWithApi(
      <CutoverDialog device={device} open={true} onOpenChange={onOpenChange} onDone={() => {}} />,
      {
        '/api/devices/dev-1/connection/cutover': (req) => (req.method === 'POST' ? { body: { cutover: armedState } } : { body: { ok: true } }),
      },
    )
    fireEvent.click(getByRole('button', { name: /Enable & arm/ }))
    await waitFor(() => expect(getByText(/Flip the port on the chassis/)).toBeTruthy())

    fireEvent.click(getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(openState).toBe(false))
  })

  test('a device.cutover broadcast reaching "done" shows the new badge and calls onDone', async () => {
    let doneCalled = false
    renderWithApi(<CutoverDialog device={device} open={true} onOpenChange={() => {}} onDone={() => (doneCalled = true)} />, {})

    expect(wsCallback).not.toBeNull()
    act(() => {
      wsCallback?.({
        type: 'device.cutover',
        payload: {
          state: {
            ...armedState,
            step: 'done',
            detail: 'Connected at 10.20.0.9:5555 over OTG.',
            connectedAddress: '10.20.0.9:5555',
            expiresAt: null,
          },
        },
      })
    })

    await waitFor(() => expect(doneCalled).toBe(true))
  })

  test('a device.cutover broadcast for a DIFFERENT stableId is ignored', () => {
    const { queryByText } = renderWithApi(<CutoverDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />, {})
    act(() => {
      wsCallback?.({
        type: 'device.cutover',
        payload: { state: { ...armedState, stableId: 'some-other-device', step: 'done', detail: 'Connected at 1.2.3.4:5555 over OTG.' } },
      })
    })
    expect(queryByText(/Connected at 1.2.3.4/)).toBeNull()
  })
})
