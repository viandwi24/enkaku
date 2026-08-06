import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import NodesPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const node = { id: 'node-1', name: 'lab-jakarta', status: 'online', platform: 'linux', lastSeen: 0 }

describe('NodesPage — smoke render', () => {
  test('loaded: shows the node row', async () => {
    renderWithApi(<NodesPage />, {
      '/api/health': { body: { mode: 'orchestrator' } },
      '/api/nodes*': { body: { items: [node], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('lab-jakarta')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    renderWithApi(<NodesPage />, {
      '/api/health': { body: { mode: 'local' } },
      '/api/nodes*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('No nodes yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the node list loads', () => {
    renderWithApi(<NodesPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/nodes fetch shows a named error', async () => {
    renderWithApi(<NodesPage />, {
      '/api/health': { body: { mode: 'local' } },
      '/api/nodes*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'nodes boom' } } },
    })
    await waitFor(() => expect(screen.getByText('nodes boom')).toBeTruthy())
  })
})
