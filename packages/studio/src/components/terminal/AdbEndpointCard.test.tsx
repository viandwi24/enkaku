import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `AdbEndpointCard` never touches `ws` directly, but `api()` (`@/lib/actions`)
 * reads its base URL from `coreBase()` in `@/lib/ws` — and `happy-dom`'s
 * default document is `about:blank`, whose `location.origin` is the literal
 * string `"null"`. Left alone, every request this component makes goes to
 * `null/api/...`, which `installApiMock`'s path-matching never matches (it
 * expects an `http(s)://` prefix or a bare `/api/...` path), so every mock
 * below would silently miss and fall through to the unmatched-404 branch —
 * indistinguishable from the component's own default state, which is
 * exactly why the loaded case needs a real DOM assertion, not just "did not
 * throw". Bun's `mock.module` intercepts by resolved file, so mocking
 * `@/lib/ws` here also covers `actions.ts`'s own `import { coreBase } from
 * './ws'`.
 */
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { AdbEndpointCard } = await import('./AdbEndpointCard')

afterEach(cleanup)

describe('AdbEndpointCard', () => {
  test('with no endpoint open, offers "Open endpoint"', async () => {
    const { getByText } = renderWithApi(<AdbEndpointCard deviceId="dev-1" clientId="c1" canOpen={true} />, {
      '/api/devices/dev-1/adb-endpoint*': { body: { endpoint: null } },
    })
    await waitFor(() => expect(getByText('Open endpoint')).toBeTruthy())
  })

  test('with an endpoint already open, shows the connect command', async () => {
    const { getByText } = renderWithApi(<AdbEndpointCard deviceId="dev-1" clientId="c1" canOpen={true} />, {
      '/api/devices/dev-1/adb-endpoint*': {
        body: { endpoint: { host: '10.0.0.5', port: 5555, connections: 1, openedAt: 1000, expiresAt: 2000 } },
      },
    })
    await waitFor(() => expect(getByText('adb connect 10.0.0.5:5555')).toBeTruthy())
  })

  test('while control is not held, the controls are disabled with a reason', async () => {
    const { getByText } = renderWithApi(<AdbEndpointCard deviceId="dev-1" clientId="c1" canOpen={false} />, {
      '/api/devices/dev-1/adb-endpoint*': { body: { endpoint: null } },
    })
    await waitFor(() => expect(getByText('Take control of this device to open an adb endpoint.')).toBeTruthy())
  })
})
