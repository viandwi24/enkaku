import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ScriptDetailPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const script = {
  id: 'script-1',
  name: 'checkout',
  version: '1.0.0',
  paramsSchema: null,
  enabled: true,
  createdBy: null,
  source: null,
  createdAt: 0,
}

function baseResponses(scriptResponse: { status?: number; body?: unknown }) {
  return {
    '/api/scripts/script-1': scriptResponse,
    '/api/scripts/checkout/versions': { body: { items: [] } },
    '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
  }
}

describe('ScriptDetailPage — smoke render', () => {
  test('loaded: shows the script name', async () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(<ScriptDetailPage />, baseResponses({ body: { script } }))
    await waitFor(() => expect(screen.getByText('checkout')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the script loads', () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(<ScriptDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed script fetch shows a named error with a retry', async () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(
      <ScriptDetailPage />,
      baseResponses({ status: 500, body: { error: { code: 'E_INTERNAL', message: 'script boom' } } }),
    )
    await waitFor(() => expect(screen.getByText('script boom')).toBeTruthy())
  })

  test('no id in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<ScriptDetailPage />, {})
    expect(screen.getByText('The address is missing an id parameter.')).toBeTruthy()
  })
})
