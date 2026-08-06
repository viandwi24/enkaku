import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `TagEditor` never imports `ws`, but `api()` (`@/lib/actions`) reads its
 * base URL through `coreBase()` in `@/lib/ws`, and `happy-dom`'s default
 * `location.origin` is the literal string `"null"` — see
 * `AdbEndpointCard.test.tsx` for the full explanation. Mocking `@/lib/ws`
 * here (even though this component never imports it) is what makes the
 * mocked `fetch` calls actually match.
 */
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { TagEditor } = await import('./TagEditor')

afterEach(cleanup)

describe('TagEditor', () => {
  test('renders the current tags plus suggestions from GET /api/tags', async () => {
    const { getByText } = renderWithApi(<TagEditor deviceId="dev-1" tags={['pool:smoke']} />, {
      '/api/tags': { body: { tags: [{ tag: 'pool:smoke', count: 3 }, { tag: 'rack:1', count: 1 }] } },
    })
    expect(getByText('pool:smoke')).toBeTruthy()
    // `rack:1` is a suggestion, not yet applied — only shows up once `/api/tags` resolves.
    await waitFor(() => expect(getByText('rack:1')).toBeTruthy())
  })

  test('no tags yet renders the empty copy, not a crash', () => {
    const { getByText } = renderWithApi(<TagEditor deviceId="dev-2" tags={[]} />, {
      '/api/tags': { body: { tags: [] } },
    })
    expect(getByText('No tags yet.')).toBeTruthy()
  })
})
