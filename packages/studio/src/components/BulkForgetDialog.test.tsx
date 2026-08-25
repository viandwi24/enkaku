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
    number: Number(id.replace(/\D/g, '')) || null,
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
    // Plan 124 §4.4, step 124.3 — the per-device result row names the phone
    // with its number, since that row is the ONLY place a bulk forget says
    // which of several identical handsets actually left the fleet.
    expect(getByText('#1')).toBeTruthy()
    expect(getByText('Phone A')).toBeTruthy()
  })
})

/**
 * Plan 104 (M69) §3.4 — `devices` is a pre-filled default, not a lock: the
 * picker lets the operator narrow or widen the set before confirming, and
 * Forget keeps its fleet-wide typed confirmation (irreversible).
 */
describe('BulkForgetDialog — the target is a default, not a lock (plan 104 §3.4)', () => {
  test('a two-device pre-fill can be narrowed to a single device via the picker', () => {
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    const { getByText, getByRole } = renderWithApi(
      <BulkForgetDialog devices={devices} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    expect(getByText('Forget 2 devices?')).toBeTruthy()
    fireEvent.mouseDown(getByRole('tab', { name: 'Single device' }))
    fireEvent.click(getByText('Phone A'))
    expect(getByText('Forget 1 device?')).toBeTruthy()
  })

  test('picking every usable device in the fleet requires the typed confirmation before "Forget selected" is enabled', () => {
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    const { getByText, getByRole, getByLabelText } = renderWithApi(
      <BulkForgetDialog devices={devices} allDevices={devices} open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    expect(getByText('This targets every usable device on the farm')).toBeTruthy()
    expect((getByRole('button', { name: 'Forget selected' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(getByLabelText('Type the device count to confirm'), { target: { value: '2' } })
    expect((getByRole('button', { name: 'Forget selected' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
