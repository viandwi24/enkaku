import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ApprovalsInboxPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

describe('ApprovalsInboxPage — smoke render', () => {
  test('loaded: no agents means nothing pending', async () => {
    renderWithApi(<ApprovalsInboxPage />, { '/api/agents': { body: { agents: [] } } })
    await waitFor(() => expect(screen.getByText('Nothing pending')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the composition resolves', () => {
    renderWithApi(<ApprovalsInboxPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/agents fetch shows a named error', async () => {
    renderWithApi(<ApprovalsInboxPage />, {
      '/api/agents': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'approvals boom' } } },
    })
    await waitFor(() => expect(screen.getByText('approvals boom')).toBeTruthy())
  })
})
