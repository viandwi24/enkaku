import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { mockRouter } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import DevToolsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const job = {
  jobId: 'job-1',
  deviceId: 'device-1',
  scriptId: 'internal:sleep',
  scriptName: null,
  scriptVersion: null,
  status: 'queued',
  error: null,
  priority: 0,
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
}

describe('DevToolsPage — smoke render', () => {
  test('loaded: renders the form with its default values', () => {
    renderWithApi(<DevToolsPage />, {})
    expect(screen.getByText('Development tools')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Submit job' })).toBeTruthy()
  })

  test('submit: a successful POST /api/jobs navigates to the new job', async () => {
    renderWithApi(<DevToolsPage />, {
      '/api/jobs': { body: { job } },
    })
    fireEvent.change(screen.getByLabelText('Device id'), { target: { value: 'device-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit job' }))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/jobs/detail?id=job-1'))
  })

  test('submit: a failed POST /api/jobs does not crash the page (toast is out-of-tree, so this only pins "no throw")', async () => {
    renderWithApi(<DevToolsPage />, {
      '/api/jobs': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'submit boom' } } },
    })
    fireEvent.change(screen.getByLabelText('Device id'), { target: { value: 'device-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit job' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit job' })).toBeTruthy())
  })
})
