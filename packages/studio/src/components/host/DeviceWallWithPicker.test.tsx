import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `DeviceWallWithPicker` (plan 129 §5 step 129.6) wraps `Wall`, which wraps
 * `WallTile` — and `WallTile` pulls in `LiveView` (a WebCodecs video decoder
 * over a live WS stream) just by being imported, before any tile actually
 * streams. This file is about THIS component's own contract — the
 * `/api/devices` fetch, the optional `filter`, the starting selection from
 * `value`, and accumulating/confirming a selection — not about `WallTile`'s
 * own rendering, which `WallTile.test.tsx`/`WallTile.quarantine.test.tsx`
 * already cover in full. So `WallTile` is replaced with the same minimal
 * stand-in `Wall.test.tsx` already uses for its own shell-level tests, and
 * `@/lib/ws` is stubbed the same way `WallTile.quarantine.test.tsx` does,
 * for the identical reason named there: the import still runs even though a
 * mocked `WallTile` never touches it.
 */
mock.module('@/lib/ws', () => ({
  ws: {
    on: () => () => {},
    send: () => {},
    onReconnected: () => () => {},
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

mock.module('@/components/wall/WallTile', () => ({
  WallTile: ({
    device,
    selected,
    onToggleSelect,
  }: {
    device: DeviceInfo
    selected?: boolean
    onToggleSelect?: () => void
  }) => (
    <div data-testid={`tile-${device.id}`} data-selected={String(!!selected)}>
      {device.label}
      <button type="button" aria-label={`toggle-${device.id}`} onClick={onToggleSelect} />
    </div>
  ),
}))

const { DeviceWallWithPicker } = await import('./DeviceWallWithPicker')

afterEach(cleanup)

function makeDevice(over: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
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
    ...over,
  } as DeviceInfo
}

/** `fetchDevices` reads `GET /api/devices` through `fetchAllPages`'s `{ items, nextCursor }` page shape. */
function devicesPage(devices: DeviceInfo[]) {
  return { body: { items: devices, nextCursor: null } }
}

describe('DeviceWallWithPicker', () => {
  test('renders a tile for every device /api/devices returns', async () => {
    const devices = [makeDevice({ id: 'dev-1', label: 'a' }), makeDevice({ id: 'dev-2', label: 'b' })]
    const { getByTestId } = renderWithApi(<DeviceWallWithPicker open value={[]} onConfirm={() => {}} onOpenChange={() => {}} />, {
      '/api/devices*': devicesPage(devices),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    expect(getByTestId('tile-dev-2')).toBeTruthy()
  })

  test('a device already in value starts selected; one not in value does not', async () => {
    const devices = [makeDevice({ id: 'dev-1' }), makeDevice({ id: 'dev-2' })]
    const { getByTestId } = renderWithApi(<DeviceWallWithPicker open value={['dev-2']} onConfirm={() => {}} onOpenChange={() => {}} />, {
      '/api/devices*': devicesPage(devices),
    })
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    expect(getByTestId('tile-dev-1').dataset.selected).toBe('false')
    expect(getByTestId('tile-dev-2').dataset.selected).toBe('true')
  })

  test('selection accumulates across tiles, and onConfirm returns exactly what was picked', async () => {
    const devices = [makeDevice({ id: 'dev-1' }), makeDevice({ id: 'dev-2' }), makeDevice({ id: 'dev-3' })]
    let confirmed: string[] | null = null
    const { getByTestId, getByLabelText, getByRole } = renderWithApi(
      <DeviceWallWithPicker open value={[]} onConfirm={(ids) => (confirmed = ids)} onOpenChange={() => {}} />,
      { '/api/devices*': devicesPage(devices) },
    )
    await waitFor(() => expect(getByTestId('tile-dev-1')).toBeTruthy())
    fireEvent.click(getByLabelText('toggle-dev-1'))
    fireEvent.click(getByLabelText('toggle-dev-3'))
    expect(getByTestId('tile-dev-1').dataset.selected).toBe('true')
    expect(getByTestId('tile-dev-2').dataset.selected).toBe('false')
    expect(getByTestId('tile-dev-3').dataset.selected).toBe('true')
    fireEvent.click(getByRole('button', { name: /add 2 devices/i }))
    expect(confirmed).toEqual(['dev-1', 'dev-3'])
  })

  test('deselecting a device that started selected removes it from what onConfirm returns', async () => {
    const devices = [makeDevice({ id: 'dev-1' })]
    let confirmed: string[] | null = null
    const { getByTestId, getByLabelText, getByRole } = renderWithApi(
      <DeviceWallWithPicker open value={['dev-1']} onConfirm={(ids) => (confirmed = ids)} onOpenChange={() => {}} />,
      { '/api/devices*': devicesPage(devices) },
    )
    await waitFor(() => expect(getByTestId('tile-dev-1').dataset.selected).toBe('true'))
    fireEvent.click(getByLabelText('toggle-dev-1'))
    expect(getByTestId('tile-dev-1').dataset.selected).toBe('false')
    fireEvent.click(getByRole('button', { name: /add 0 devices/i }))
    expect(confirmed).toEqual([])
  })

  test('filter is honoured: a filtered-out device never reaches the wall at all', async () => {
    const devices = [makeDevice({ id: 'dev-1', tags: ['assigned'] }), makeDevice({ id: 'dev-2', tags: [] })]
    const { getByTestId, queryByTestId } = renderWithApi(
      <DeviceWallWithPicker
        open
        value={[]}
        onConfirm={() => {}}
        onOpenChange={() => {}}
        filter={(d) => !d.tags.includes('assigned')}
      />,
      { '/api/devices*': devicesPage(devices) },
    )
    await waitFor(() => expect(getByTestId('tile-dev-2')).toBeTruthy())
    expect(queryByTestId('tile-dev-1')).toBeNull()
  })
})
