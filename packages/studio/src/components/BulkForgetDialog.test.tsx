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

const { BulkForgetDialog } = await import('./BulkForgetDialog')

afterEach(cleanup)

function makeDevice(id: string, label: string): DeviceInfo {
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
    status: 'offline',
    lastSeen: 1,
    battery: null,
    quarantineReason: null,
    tags: [],
    cluster: null,
    lastCrashAt: null,
    readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
  }
}

describe('BulkForgetDialog', () => {
  test('renders the confirm copy for the selected devices', () => {
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    const { getByText } = renderWithApi(
      <BulkForgetDialog devices={devices} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    expect(getByText('Forget 2 devices?')).toBeTruthy()
  })

  /**
   * Plan 72's own migration missed this file (it was not in any delegated
   * agent's list — found and fixed during final reconciliation): `DELETE
   * /api/devices/:id` used to be called as `api(path, {method: 'DELETE'})`,
   * passing the request init as if it were the schema argument — a
   * TYPECHECK FAILURE under the new required-schema `api()` signature, not
   * merely a stale claim. This is the regression pin: a successful forget
   * must actually resolve `ok: true`, not throw.
   */
  test('"Forget selected" succeeds against the real DELETE response shape', async () => {
    const devices = [makeDevice('d1', 'Phone A')]
    const { getByText } = renderWithApi(
      <BulkForgetDialog devices={devices} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      { '/api/devices/d1*': { body: { forgotten: { deviceId: 'd1', stableId: 'd1', historyDeleted: false } } } },
    )
    fireEvent.click(getByText('Forget selected'))
    await waitFor(() => expect(getByText('forgotten')).toBeTruthy())
  })
})
