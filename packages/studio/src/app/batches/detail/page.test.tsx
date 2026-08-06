import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import BatchDetailPage from './page'

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
  counts: { total: 1, queued: 0, running: 1, success: 0, failed: 0, cancelled: 0 },
}

const job = {
  jobId: 'job-1',
  deviceId: 'device-1',
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  status: 'running',
  error: null,
  priority: 0,
  createdAt: 0,
  startedAt: 0,
  finishedAt: null,
  batchId: 'batch-1',
  batchSeq: 0,
}

describe('BatchDetailPage — smoke render', () => {
  test('loaded: shows the batch header and its job row', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { body: { batch, jobs: [job] } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the batch loads', () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed batch fetch shows a named error with a retry', async () => {
    setSearchParams({ id: 'batch-1' })
    renderWithApi(<BatchDetailPage />, {
      '/api/batches/batch-1': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'batch boom' } } },
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('batch boom')).toBeTruthy())
  })

  test('no id in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<BatchDetailPage />, {})
    expect(screen.getByText('The address is missing an id parameter.')).toBeTruthy()
  })
})
