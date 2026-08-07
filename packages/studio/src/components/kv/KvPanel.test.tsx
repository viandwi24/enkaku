import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { KvPanel } from './KvPanel'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const SECRET_PLAINTEXT = 'sk-this-is-the-real-secret-value-do-not-render-me'

async function browse(namespace = 'tiktok') {
  const input = screen.getByLabelText('Namespace')
  fireEvent.change(input, { target: { value: namespace } })
  fireEvent.click(screen.getByRole('button', { name: /browse/i }))
}

describe('KvPanel — a secret\'s plaintext never reaches the rendered output (plan 79 §3.4)', () => {
  test('a secret entry renders its hint and a "secret" marker, and the plaintext appears NOWHERE in the DOM — even if the server response carried it (defense in depth, not trust in the network)', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, {
      '/api/kv*': {
        body: {
          items: [
            // A real server always redacts `value` to null for a secret row
            // (`redactEntry`, core `api/kv.ts`) — this mock deliberately does
            // NOT, to prove the component itself never reads `.value` for a
            // secret entry, rather than merely trusting the network never to
            // send it. If this test ever fails because the component started
            // rendering `.value` unconditionally, that is exactly the bug it
            // exists to catch.
            { key: 'token', value: SECRET_PLAINTEXT, secret: true, hint: 'sk-…7Xq2', version: 1, expiresAt: null, updatedAt: 0 },
            { key: 'plain-counter', value: 42, secret: false, hint: null, version: 1, expiresAt: null, updatedAt: 0 },
          ],
          nextCursor: null,
        },
      },
    })

    await browse()
    await waitFor(() => expect(screen.getByText('token')).toBeTruthy())

    // The hint and the "secret" marker ARE shown.
    expect(screen.getByText(/secret · sk-…7Xq2/)).toBeTruthy()
    // The non-secret value renders normally.
    expect(screen.getByText('42')).toBeTruthy()

    // The plaintext is NOWHERE in the rendered document — not in a text
    // node, not in an attribute (title/alt/aria-label), not in a hidden
    // element. `document.body.innerHTML` covers all of the above.
    expect(document.body.innerHTML).not.toContain(SECRET_PLAINTEXT)
  })

  test('a device-scoped panel queries with the device\'s stableId, not its row id', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'device', stableId: 'stable-abc' }} />, {
      '/api/kv*': { body: { items: [], nextCursor: null } },
    })
    await browse('tiktok')
    await waitFor(() => expect(apiMock.calls.some((c) => c.path.includes('stableId=stable-abc'))).toBe(true))
  })
})

describe('KvPanel — loading, loaded, and error states', () => {
  test('before a namespace is browsed, shows the prompt state, not a spinner', () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, {})
    expect(screen.getByText('Enter a namespace to browse')).toBeTruthy()
  })

  test('loading: shows a busy skeleton while the browse request is in flight', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, {}, { unmatched: 'pending' })
    await browse()
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy())
  })

  test('loaded: an empty namespace shows the empty state', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, {
      '/api/kv*': { body: { items: [], nextCursor: null } },
    })
    await browse()
    await waitFor(() => expect(screen.getByText('No values under this namespace yet')).toBeTruthy())
  })

  test('error: a failed /api/kv fetch shows a named error', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, {
      '/api/kv*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'kv boom' } } },
    })
    await browse()
    await waitFor(() => expect(screen.getByText('kv boom')).toBeTruthy())
  })
})
