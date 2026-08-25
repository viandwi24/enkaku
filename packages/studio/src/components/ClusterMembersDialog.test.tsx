import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ClusterMembersDialog } from './ClusterMembersDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const cluster = { id: 'cluster-1', name: 'Jakarta' }

const member = {
  id: 'device-1',
  stableId: 'stable-1',
  serial: 'serial-1',
  number: 7,
  label: 'Pixel 7',
  androidVersion: '14',
  apiLevel: 34,
  screenW: 1080,
  screenH: 2400,
  density: 420,
  status: 'online',
  lastSeen: 0,
  tags: [],
  cluster: null,
}

describe('ClusterMembersDialog — smoke render', () => {
  test('loaded: shows the current member', async () => {
    renderWithApi(
      <ClusterMembersDialog cluster={cluster} allDevices={[member]} onClose={() => {}} onChanged={() => {}} />,
      { '/api/clusters/cluster-1/devices*': { body: { items: [member], nextCursor: null, total: 1 } } },
    )
    await waitFor(() => expect(screen.getByText('Pixel 7')).toBeTruthy())
  })

  test('loading: shows the loading placeholder before members resolve', () => {
    renderWithApi(
      <ClusterMembersDialog cluster={cluster} allDevices={[member]} onClose={() => {}} onChanged={() => {}} />,
      {},
      { unmatched: 'pending' },
    )
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  test('loaded: an empty membership shows the empty message', async () => {
    renderWithApi(
      <ClusterMembersDialog cluster={cluster} allDevices={[member]} onClose={() => {}} onChanged={() => {}} />,
      { '/api/clusters/cluster-1/devices*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    await waitFor(() => expect(screen.getByText('No devices yet — add some from the right.')).toBeTruthy())
  })

  test('closed: renders nothing', () => {
    renderWithApi(
      <ClusterMembersDialog cluster={null} allDevices={[member]} onClose={() => {}} onChanged={() => {}} />,
      {},
    )
    expect(screen.queryByText('members')).toBeNull()
  })
})

/**
 * Plan 124 §4.5, criterion 1, step 124.3 — the left "current members" pane's
 * own search box. The right-hand pane has been a `DevicePicker` (search box
 * AND number) since plan 22.0; the left pane listed every member unfiltered.
 * That asymmetry was the bug, and these tests pin the fix rather than the
 * styling: the box filters, it matches the NUMBER both bare and `#`-prefixed,
 * it reports a live count, and an empty result never reads as "this cluster
 * is empty".
 */
describe('ClusterMembersDialog — the members pane names and filters (plan 124 §4.4, §4.5)', () => {
  // Two phones with the SAME label and no digits in it — the rack this plan
  // was written for. The label carries no digit deliberately: a bare `7` also
  // matches a LABEL containing `7` (substring, by design in
  // `matchesDeviceQuery`), and that would mask the number match this asserts.
  const first = { ...member, id: 'device-1', stableId: 'stable-a', number: 7, label: 'Galaxy Fold' }
  const second = { ...member, id: 'device-2', stableId: 'stable-b', number: 12, label: 'Galaxy Fold' }

  const renderTwo = () =>
    renderWithApi(
      <ClusterMembersDialog cluster={cluster} allDevices={[first, second]} onClose={() => {}} onChanged={() => {}} />,
      { '/api/clusters/cluster-1/devices*': { body: { items: [first, second], nextCursor: null, total: 2 } } },
    )

  test('two identically labelled members are distinguishable by their numbers (criterion 6)', async () => {
    renderTwo()
    await waitFor(() => expect(screen.getByText('#7')).toBeTruthy())
    expect(screen.getByText('#12')).toBeTruthy()
  })

  test('typing a bare number filters to that one member, and the count says so', async () => {
    renderTwo()
    const box = await waitFor(() => screen.getByLabelText('Search current members'))
    fireEvent.change(box, { target: { value: '7' } })
    expect(screen.getByText('1 of 2')).toBeTruthy()
    expect(screen.getByText('#7')).toBeTruthy()
    // `7` matches `#7` EXACTLY — never `#12` and never every device whose
    // label happens to contain a 7 (`@enkaku/ui`'s `matchesDeviceQuery`).
    expect(screen.queryByText('#12')).toBeNull()
  })

  test('the `#`-prefixed form finds the same member', async () => {
    renderTwo()
    const box = await waitFor(() => screen.getByLabelText('Search current members'))
    fireEvent.change(box, { target: { value: '#12' } })
    expect(screen.getByText('1 of 2')).toBeTruthy()
    expect(screen.getByText('#12')).toBeTruthy()
  })

  test('a query that matches nothing says so — never "no devices yet"', async () => {
    renderTwo()
    const box = await waitFor(() => screen.getByLabelText('Search current members'))
    fireEvent.change(box, { target: { value: 'nothing-matches-this' } })
    expect(screen.getByText(/No member matches/)).toBeTruthy()
    expect(screen.queryByText('No devices yet — add some from the right.')).toBeNull()
  })

  test('a single-member cluster gets no search box — a filter over one row is noise (§3.3)', async () => {
    renderWithApi(
      <ClusterMembersDialog cluster={cluster} allDevices={[member]} onClose={() => {}} onChanged={() => {}} />,
      { '/api/clusters/cluster-1/devices*': { body: { items: [member], nextCursor: null, total: 1 } } },
    )
    await waitFor(() => expect(screen.getByText('Pixel 7')).toBeTruthy())
    expect(screen.queryByLabelText('Search current members')).toBeNull()
  })
})
