import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

// See `AdbEndpointCard.test.tsx` for why `@/lib/ws` needs mocking even
// though this component never imports it: `api()` reads `coreBase()` from
// there, and `happy-dom`'s default `location.origin` is the string `"null"`.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { DisconnectDeviceDialog } = await import('./DisconnectDeviceDialog')

afterEach(cleanup)

const device: DeviceInfo = {
  id: 'dev-1',
  stableId: 'stable-1',
  serial: '10.0.0.5:5555',
  number: 12,
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
  connection: { kind: 'tcp', medium: null, mediumSource: 'unknown', address: '10.0.0.5', port: 5555, networkLabel: null },
}

describe('DisconnectDeviceDialog (plan 88 §3.7, §3.8, §4.6, §5 step 88.4)', () => {
  test('states both halves: what changes (the adb link) and what does not (the record) — never Remove', () => {
    const { getByText } = renderWithApi(
      <DisconnectDeviceDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    // Plan 124 criterion 5, step 124.3 — `Disconnect …?` names the device with
    // its number, so the operator can tell which of three identical phones is
    // about to lose its adb link.
    expect(getByText('Disconnect #12 Pixel 7 Pro from the network?')).toBeTruthy()
    expect(getByText(/Enkaku drops its adb connection. The phone keeps running./)).toBeTruthy()
    expect(getByText(/This is not Remove/)).toBeTruthy()
    expect(getByText(/it shows as Offline, and it cannot be controlled or scheduled/)).toBeTruthy()
  })

  test('names the last known address it reconnects from', () => {
    const { getByText } = renderWithApi(
      <DisconnectDeviceDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    expect(getByText('10.0.0.5:5555')).toBeTruthy()
  })

  test('confirming posts to the disconnect route and reports success', async () => {
    const { getByRole, apiMock } = renderWithApi(
      <DisconnectDeviceDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      { '/api/devices/dev-1/connection/disconnect': { body: { result: 'disconnected' } } },
    )
    fireEvent.click(getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/devices/dev-1/connection/disconnect')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/devices/dev-1/connection/disconnect')
    expect(call?.method).toBe('POST')
    expect(call?.body).toEqual({ force: false })
  })

  test('a job_running refusal shows the server message and a force checkbox that unlocks the retry', async () => {
    const { getByRole, getByText, apiMock } = renderWithApi(
      <DisconnectDeviceDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {
        '/api/devices/dev-1/connection/disconnect': ({ body }) => {
          const forced = (body as { force?: boolean } | undefined)?.force
          if (forced) return { body: { result: 'disconnected' } }
          return {
            status: 409,
            body: { error: { code: 'job_running', message: '1 running job on Pixel 7 Pro (sleep-and-tap) would fail if disconnected now — pass force to disconnect anyway' } },
          }
        },
      },
    )
    fireEvent.click(getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(getByText(/would fail if disconnected now/)).toBeTruthy())

    const confirm = getByRole('button', { name: 'Disconnect' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(getByRole('checkbox', { name: /Disconnect anyway/ }))
    await waitFor(() => expect((getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(getByRole('button', { name: 'Disconnect' }))
    await waitFor(() =>
      expect(apiMock.calls.filter((c) => c.path === '/api/devices/dev-1/connection/disconnect')).toHaveLength(2),
    )
    const secondCall = apiMock.calls.filter((c) => c.path === '/api/devices/dev-1/connection/disconnect')[1]
    expect(secondCall?.body).toEqual({ force: true })
  })
})
