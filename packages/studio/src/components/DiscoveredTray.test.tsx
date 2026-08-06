import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// See `AdbEndpointCard.test.tsx` for why `@/lib/ws` needs mocking even
// though this component never imports it: `api()` reads `coreBase()` from
// there, and `happy-dom`'s default `location.origin` is the string `"null"`.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { DiscoveredTray } = await import('./DiscoveredTray')

afterEach(cleanup)

const entry = {
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06',
  androidVersion: '15',
  firstSeen: 1,
  lastSeen: 1,
}

describe('DiscoveredTray', () => {
  test('renders a row per discovered device', () => {
    const { getByText } = renderWithApi(
      <DiscoveredTray discovered={[entry]} clusters={[]} open={true} onOpenChange={() => {}} onChanged={() => {}} />,
      {},
    )
    expect(getByText('moto g06')).toBeTruthy()
  })

  test('empty tray shows the empty state', () => {
    const { getByText } = renderWithApi(
      <DiscoveredTray discovered={[]} clusters={[]} open={true} onOpenChange={() => {}} onChanged={() => {}} />,
      {},
    )
    expect(getByText('Nothing waiting')).toBeTruthy()
  })

  /**
   * Plan 72's own migration missed this file (it was not in any delegated
   * agent's list — found and fixed during final reconciliation): `DELETE
   * /api/devices/discovered/:stableId` used to be called as
   * `api(path, {method: 'DELETE'})`, passing the request init as if it
   * were the schema argument — a TYPECHECK FAILURE under the new
   * required-schema `api()` signature. This is the regression pin: a
   * successful dismiss must actually call `onChanged`, not throw.
   */
  test('Dismiss succeeds against the real DELETE response shape and calls onChanged', async () => {
    let changed = false
    const { getByLabelText } = renderWithApi(
      <DiscoveredTray
        discovered={[entry]}
        clusters={[]}
        open={true}
        onOpenChange={() => {}}
        onChanged={() => {
          changed = true
        }}
      />,
      { '/api/devices/discovered/ZP2222RMBS': { body: { ok: true } } },
    )
    fireEvent.click(getByLabelText('Dismiss moto g06'))
    await waitFor(() => expect(changed).toBe(true))
  })
})
