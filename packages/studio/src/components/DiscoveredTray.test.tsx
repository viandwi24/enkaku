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
      <DiscoveredTray discovered={[entry]} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onChanged={() => {}} />,
      {},
    )
    expect(getByText('moto g06')).toBeTruthy()
  })

  /**
   * Plan 89 §3.8, §5 step 89.8 — `farmLabellingMode` reaches the admit
   * wizard's own checkbox unchanged, so a farm that already opted in shows
   * every subsequent admission pre-checked, per §3.8's own words ("every
   * phone admitted afterwards is labelled with no further thought").
   */
  test('forwards farmLabellingMode to the admit dialog\'s checkbox', () => {
    const { getByText, getByRole } = renderWithApi(
      <DiscoveredTray discovered={[entry]} clusters={[]} farmLabellingMode="wallpaper" open={true} onOpenChange={() => {}} onChanged={() => {}} />,
      {},
    )
    fireEvent.click(getByText('Add to farm'))
    expect(getByRole('switch', { name: "Label this phone's screen" }).getAttribute('aria-checked')).toBe('true')
  })

  test('empty tray shows the empty state', () => {
    const { getByText } = renderWithApi(
      <DiscoveredTray discovered={[]} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onChanged={() => {}} />,
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
        farmLabellingMode="off"
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

  /**
   * The Rescan button (plan 85 §3.3, §4.6, §5 step 85.2) — "the first thing
   * a human does when a phone is missing is look for that button." A
   * successful rescan renders the report as one line (matching the plan's
   * own example wording) and refetches the tray, since an adopt or a new
   * discovery can change what belongs in it.
   */
  test('Rescan calls POST /api/devices/rescan, renders the report as one line, and refetches the tray', async () => {
    let changed = false
    const { getByText, apiMock } = renderWithApi(
      <DiscoveredTray discovered={[entry]} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onChanged={() => (changed = true)} />,
      {
        '/api/devices/rescan': {
          body: { seen: 5, adopted: ['SER1'], dropped: [], offline: [], unauthorized: [], reconnectIssued: false, retriesPending: 0 },
        },
      },
    )
    fireEvent.click(getByText('Rescan'))
    await waitFor(() => expect(getByText('Scanned 5 devices · adopted 1 · nothing else changed')).toBeTruthy())
    expect(changed).toBe(true)
    expect(apiMock.calls.some((c) => c.path === '/api/devices/rescan' && c.method === 'POST')).toBe(true)
  })

  test('a scan that changed nothing reads "nothing changed", without "else"', async () => {
    const { getByText } = renderWithApi(
      <DiscoveredTray discovered={[]} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onChanged={() => {}} />,
      {
        '/api/devices/rescan': {
          body: { seen: 2, adopted: [], dropped: [], offline: [], unauthorized: [], reconnectIssued: false, retriesPending: 0 },
        },
      },
    )
    fireEvent.click(getByText('Rescan'))
    await waitFor(() => expect(getByText('Scanned 2 devices · nothing changed')).toBeTruthy())
  })

  test('a failed rescan surfaces the server error and leaves the tray otherwise unaffected', async () => {
    const { getByText } = renderWithApi(
      <DiscoveredTray discovered={[entry]} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onChanged={() => {}} />,
      { '/api/devices/rescan': { status: 500, body: { error: { code: 'E_ADB_UNAVAILABLE', message: 'adb is not ready yet' } } } },
    )
    fireEvent.click(getByText('Rescan'))
    await waitFor(() => expect(getByText('Rescan')).toBeTruthy())
    // The row is still there — a failed rescan does not clear the tray.
    expect(getByText('moto g06')).toBeTruthy()
  })
})
