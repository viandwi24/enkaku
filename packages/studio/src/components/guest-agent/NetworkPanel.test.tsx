import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// `fetchGuestAgentStatus` (`@/lib/api`) and `api()` both read `coreBase()`
// from `@/lib/ws` — mocked so the fetch mock below actually matches (see
// `AdbEndpointCard.test.tsx`).
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { NetworkPanel } = await import('./NetworkPanel')

afterEach(cleanup)

describe('NetworkPanel', () => {
  test('not-installed state offers Install', async () => {
    const { getByText } = renderWithApi(<NetworkPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-1/guest-agent': { body: { state: 'not-installed' } },
    })
    await waitFor(() => expect(getByText('Install')).toBeTruthy())
  })

  test('ready state renders the route form beneath the agent status', async () => {
    const { getByText } = renderWithApi(<NetworkPanel deviceId="dev-2" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-2/guest-agent': { body: { state: 'ready' } },
      '/api/devices/dev-2/network': {
        body: {
          engine: 'vpn-helper',
          config: null,
          enabled: false,
          observed: null,
          drift: false,
          sessionId: null,
          failClosed: true,
          health: 'unknown',
          checks: [],
          lastError: null,
          exitHistory: [],
        },
      },
    })
    await waitFor(() => expect(getByText('socks5 upstream')).toBeTruthy())
  })

  test('a load failure surfaces as a named error, not a crash', async () => {
    // `fetchGuestAgentStatus` (`@/lib/api`, out of this plan's scope) throws
    // its own plain `Error` on a non-OK response — not `api()`'s
    // `{error:{code,message}}` unwrapping — so the panel's `ErrorState`
    // shows that literal message.
    const { getByText } = renderWithApi(<NetworkPanel deviceId="dev-3" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-3/guest-agent': { status: 500 },
    })
    await waitFor(() => expect(getByText('GET /api/devices/dev-3/guest-agent → 500')).toBeTruthy())
  })
})
