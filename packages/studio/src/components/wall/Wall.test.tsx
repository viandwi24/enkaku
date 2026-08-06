import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

// `WallTile` mounts `LiveView` (a WebCodecs video decoder over a live WS
// stream) for every tile — none of that is this test's concern, which is
// only the wall SHELL's own data fetch (`GET /api/settings`, now
// `SettingsResponseSchema`, read for `.settings.wall.maxTiles`) and its
// loading/empty states. `@/lib/ws` is mocked too since `api()` reads
// `coreBase()` from there regardless of what actually renders.
mock.module('@/components/wall/WallTile', () => ({
  WallTile: ({ device }: { device: DeviceInfo }) => <div data-testid={`tile-${device.id}`}>{device.label}</div>,
}))
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { Wall } = await import('./Wall')

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

describe('Wall', () => {
  test('renders a tile per device and reads wall.maxTiles from settings', async () => {
    const { getByText, getByTestId } = renderWithApi(<Wall devices={[device]} jobs={[]} />, {
      '/api/settings': { body: { settings: { wall: { maxTiles: 4 } }, schema: {}, deviceSchema: {} } },
    })
    expect(getByTestId('tile-dev-1')).toBeTruthy()
    await waitFor(() => expect(getByText(/capped at 4 at once/)).toBeTruthy())
  })

  test('devices still loading renders the loading rows, not a crash', () => {
    const { container } = renderWithApi(<Wall devices={null} jobs={[]} />, {}, { unmatched: 'pending' })
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('no devices match renders the empty state', () => {
    const { getByText } = renderWithApi(<Wall devices={[]} jobs={[]} />, {}, { unmatched: 'pending' })
    expect(getByText('No devices match')).toBeTruthy()
  })
})
