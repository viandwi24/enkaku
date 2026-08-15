import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import BatchesPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const batch = {
  id: 'batch-1',
  clusterId: null,
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  params: {},
  concurrency: 0,
  order: 'as-listed',
  status: 'running',
  createdBy: null,
  createdAt: 0,
  finishedAt: null,
  counts: { total: 3, queued: 1, running: 1, success: 1, failed: 0, cancelled: 0 },
}

describe('BatchesPage — smoke render', () => {
  test('loaded: shows the batch row', async () => {
    renderWithApi(<BatchesPage />, {
      '/api/batches*': { body: { items: [batch], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    renderWithApi(<BatchesPage />, {
      '/api/batches*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('No batches yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the batch list loads', () => {
    renderWithApi(<BatchesPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/batches fetch shows a named error', async () => {
    renderWithApi(<BatchesPage />, {
      '/api/batches*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'batches boom' } } },
    })
    await waitFor(() => expect(screen.getByText('batches boom')).toBeTruthy())
  })

  // Plan 94 §3.9, §4.9, step 94.8 — `'stopping'` widened onto the wire; this
  // is the exhaustive `STATUS_TONE`/`BatchStatusBadge` map that would go
  // silently non-exhaustive (a TS error, per this file's own history) if a
  // status value were ever added without a matching row here.
  test('a "stopping" batch renders its own status badge, not a crash', async () => {
    renderWithApi(<BatchesPage />, {
      '/api/batches*': { body: { items: [{ ...batch, status: 'stopping' }], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('stopping')).toBeTruthy())
  })
})
