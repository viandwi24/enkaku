import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { DiscoveredDevice } from '@/lib/api'
import { cleanup, renderWithApi } from '@/lib/test/render'

// See `AdbEndpointCard.test.tsx` for why `@/lib/ws` needs mocking even
// though this component never imports it.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { AdmitDeviceDialog } = await import('./AdmitDeviceDialog')

afterEach(cleanup)

const entry: DiscoveredDevice = {
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06',
  androidVersion: '15',
  firstSeen: 1,
  lastSeen: 1,
}

describe('AdmitDeviceDialog', () => {
  test('renders the probed facts for the entry', () => {
    const { getByText } = renderWithApi(
      <AdmitDeviceDialog entry={entry} clusters={[]} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    expect(getByText('Add moto g06 to the farm')).toBeTruthy()
  })

  test('Add to farm posts the admit request and reports success', async () => {
    const onDone = mock(() => {})
    const { getByText } = renderWithApi(
      <AdmitDeviceDialog entry={entry} clusters={[]} open={true} onOpenChange={() => {}} onDone={onDone} />,
      {
        '/api/devices/discovered/ZP2222RMBS/admit': {
          body: { device: { id: 'dev-1', label: 'moto g06', stableId: 'ZP2222RMBS', serial: 'ZP2222RMBS', androidVersion: '15', apiLevel: 35, screenW: 720, screenH: 1600, density: 280, status: 'idle', lastSeen: 1, battery: null, quarantineReason: null, tags: [], cluster: null, lastCrashAt: null, readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 } } },
        },
      },
    )
    fireEvent.click(getByText('Add to farm'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })
})
