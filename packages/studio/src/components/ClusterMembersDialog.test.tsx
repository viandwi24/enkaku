import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ClusterMembersDialog } from './ClusterMembersDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const cluster = { id: 'cluster-1', name: 'Jakarta' }

const member = {
  id: 'device-1',
  stableId: 'stable-1',
  serial: 'serial-1',
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
