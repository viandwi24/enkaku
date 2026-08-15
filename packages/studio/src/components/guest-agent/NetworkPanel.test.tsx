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
  // Plan 90 §5 step 90.6 — the agent's install/repair block moved OUT of
  // this panel and into the device page's own Agent tab; this panel keeps
  // only a one-line summary linking to it.
  test('not-installed state renders a one-line summary linking to the Agent tab, not an Install button', async () => {
    const { getByText, queryByText } = renderWithApi(<NetworkPanel deviceId="dev-1" canUse={true} />, {
      '/api/devices/dev-1/guest-agent': { body: { state: 'not-installed' } },
    })
    await waitFor(() => expect(getByText('not installed')).toBeTruthy())
    expect(queryByText('Install')).toBeNull()
    const link = getByText('not installed').closest('a')
    expect(link?.getAttribute('href')).toBe('/device?id=dev-1&tab=agent')
  })

  test('ready state renders the route form beneath the one-line summary', async () => {
    const { getByText } = renderWithApi(<NetworkPanel deviceId="dev-2" canUse={true} />, {
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
          recovery: null,
        },
      },
    })
    await waitFor(() => expect(getByText('socks5 upstream')).toBeTruthy())
  })

  // outdated/failed both parse (`packages/protocol/src/api/devices.test.ts`)
  // and must render here too, without throwing — this panel is on the
  // widened endpoint's read path just as much as `AgentPanel` is.
  test('outdated and failed both render the one-line summary without throwing', async () => {
    const outdated = renderWithApi(<NetworkPanel deviceId="dev-3" canUse={true} />, {
      '/api/devices/dev-3/guest-agent': { body: { state: 'outdated' } },
    })
    await waitFor(() => expect(outdated.getByText('update available')).toBeTruthy())
    cleanup()

    const failed = renderWithApi(<NetworkPanel deviceId="dev-4" canUse={true} />, {
      '/api/devices/dev-4/guest-agent': { body: { state: 'failed' } },
    })
    await waitFor(() => expect(failed.getByText('failed')).toBeTruthy())
  })

  test('a load failure surfaces as a named error, not a crash', async () => {
    // `fetchGuestAgentStatus` (`@/lib/api`, out of this plan's scope) throws
    // its own plain `Error` on a non-OK response — not `api()`'s
    // `{error:{code,message}}` unwrapping — so the panel's `ErrorState`
    // shows that literal message.
    const { getByText } = renderWithApi(<NetworkPanel deviceId="dev-5" canUse={true} />, {
      '/api/devices/dev-5/guest-agent': { status: 500 },
    })
    await waitFor(() => expect(getByText('GET /api/devices/dev-5/guest-agent → 500')).toBeTruthy())
  })
})
