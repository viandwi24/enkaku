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

const { ForgetDeviceDialog } = await import('./ForgetDeviceDialog')

afterEach(cleanup)

const device: DeviceInfo = {
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
}

describe('ForgetDeviceDialog', () => {
  test('renders the confirm copy for a given device', () => {
    const { getByText } = renderWithApi(
      <ForgetDeviceDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    expect(getByText('Forget moto g06?')).toBeTruthy()
  })

  test('"also delete history" fetches and shows the real counts', async () => {
    const { getByText, getByLabelText, queryByText } = renderWithApi(
      <ForgetDeviceDialog device={device} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      { '/api/devices/dev-1/history-counts': { body: { counts: { jobs: 4, artifacts: 2, events: 11 } } } },
    )
    fireEvent.click(getByLabelText('Also delete history'))
    expect(getByText('Counting what would be deleted…')).toBeTruthy()
    await waitFor(() => expect(queryByText('Counting what would be deleted…')).toBeNull())
    // Radix's `Dialog` renders into a portal on `document.body`, not inside
    // the local render container — `document.body.textContent` is where the
    // real counts actually landed.
    expect(document.body.textContent).toContain('This deletes 4 job')
    expect(document.body.textContent).toContain('2 artifact')
    expect(document.body.textContent).toContain('11 event')
  })
})
