import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { DeviceDetailInfo } from './DeviceHeader'
import { DeviceNumberField } from './DeviceNumberField'

// `api()` builds its URL from `coreBase()` (`@/lib/ws`) — unset, it does not
// resolve to something `installApiMock`'s path-stripping regex recognises,
// the same env var `DeviceCard.test.tsx` and friends already set.
process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const device: DeviceDetailInfo = {
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
  connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'adb-input',
  inspection: 'ui-server',
  settings: null,
  liveDisplay: null,
  nodeId: null,
  number: 7,
}

/**
 * `DeviceNumberField` (plan 89 §3.2, §4.2, §4.3, §5 step 89.3) — the one
 * hand-authored field on the device settings panel: `number` lives in its
 * own `device_numbers` table, never on `DeviceSettingsSchema`, so it cannot
 * be schema-driven (`deviceSections`'s own derivation).
 */
describe('DeviceNumberField', () => {
  test('shows no Release button for a device with no number', () => {
    const { queryByText } = renderWithApi(<DeviceNumberField device={{ ...device, number: null }} onSaved={() => {}} />)
    expect(queryByText('Release number')).toBeNull()
  })

  test('a manual set calls PATCH with the parsed number and reports the new value', async () => {
    const onSaved = mock(() => {})
    const { getByLabelText, getByText } = renderWithApi(
      <DeviceNumberField device={device} onSaved={onSaved} />,
      {
        '/api/devices/dev-1': { body: { device: { ...device, number: 12 } } },
      },
    )
    fireEvent.change(getByLabelText('Device number'), { target: { value: '12' } })
    fireEvent.click(getByText('Save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ number: 12 }))
  })

  test('a 409 collision shows the server message INLINE, naming the holder (plan 89 §4.2)', async () => {
    const { getByLabelText, getByText, findByText } = renderWithApi(
      <DeviceNumberField device={device} onSaved={() => {}} />,
      {
        '/api/devices/dev-1': {
          status: 409,
          body: { error: { code: 'E_NUMBER_TAKEN', message: '#3 is already assigned to some-other-stable-id' } },
        },
      },
    )
    fireEvent.change(getByLabelText('Device number'), { target: { value: '3' } })
    fireEvent.click(getByText('Save'))
    expect(await findByText('#3 is already assigned to some-other-stable-id')).toBeTruthy()
  })

  test('Release number calls DELETE on /numbers/:stableId and clears the field', async () => {
    const onSaved = mock(() => {})
    const { getByText } = renderWithApi(
      <DeviceNumberField device={device} onSaved={onSaved} />,
      {
        '/api/devices/numbers/ZP2222RMBS': { body: { ok: true } },
      },
    )
    fireEvent.click(getByText('Release number'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ number: null }))
  })

  test('Save is disabled until the draft actually changes', () => {
    const { getByText } = renderWithApi(<DeviceNumberField device={device} onSaved={() => {}} />)
    expect((getByText('Save') as HTMLButtonElement).disabled).toBe(true)
  })

  test('a non-positive draft is refused inline before any request is made', () => {
    const { getByLabelText, getByText } = renderWithApi(<DeviceNumberField device={device} onSaved={() => {}} />)
    fireEvent.change(getByLabelText('Device number'), { target: { value: '0' } })
    expect(getByText('Must be a positive whole number.')).toBeTruthy()
    expect((getByText('Save') as HTMLButtonElement).disabled).toBe(true)
  })
})
