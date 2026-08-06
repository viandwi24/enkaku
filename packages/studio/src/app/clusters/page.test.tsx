import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ClustersPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const cluster = {
  id: 'cluster-1',
  name: 'Jakarta',
  description: null,
  createdAt: 0,
  deviceCount: 3,
  usableCount: 2,
}

describe('ClustersPage — smoke render', () => {
  test('loaded: shows the cluster row', async () => {
    renderWithApi(<ClustersPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/clusters*': { body: { items: [cluster], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('Jakarta')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    renderWithApi(<ClustersPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('No clusters yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the cluster list loads', () => {
    renderWithApi(<ClustersPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/clusters fetch shows a named error', async () => {
    renderWithApi(<ClustersPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/clusters*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'clusters boom' } } },
    })
    await waitFor(() => expect(screen.getByText('clusters boom')).toBeTruthy())
  })
})
