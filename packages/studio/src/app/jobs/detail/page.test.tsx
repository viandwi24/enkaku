import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import JobDetailPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

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
  result: null,
}

function baseResponses(jobResponse: { status?: number; body?: unknown }) {
  return {
    '/api/jobs/job-1': jobResponse,
    '/api/scripts/script-1': { body: { script: { source: null } } },
    '/api/devices/refs*': { body: { refs: {} } },
    '/api/artifacts*': { body: { items: [], nextCursor: null, total: 0 } },
  }
}

describe('JobDetailPage — smoke render', () => {
  test('loaded: shows the script name once the job loads', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, baseResponses({ body: { job } }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'checkout@1.0.0' })).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the job loads', () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(<JobDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed job fetch shows a named error with a retry', async () => {
    setSearchParams({ id: 'job-1' })
    renderWithApi(
      <JobDetailPage />,
      baseResponses({ status: 500, body: { error: { code: 'E_INTERNAL', message: 'job boom' } } }),
    )
    await waitFor(() => expect(screen.getByText('job boom')).toBeTruthy())
  })

  test('no id in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<JobDetailPage />, {})
    expect(screen.getByText('The address is missing an id parameter.')).toBeTruthy()
  })
})
