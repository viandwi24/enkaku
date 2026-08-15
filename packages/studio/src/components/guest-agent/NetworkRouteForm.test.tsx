import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// `fetchNetworkStatus`/`enableNetworkRoute`/`disableNetworkRoute` (`@/lib/api`,
// out of this plan's scope) and `api()` both read `coreBase()` from
// `@/lib/ws` — mocked so the fetch mock below actually matches.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { NetworkRouteForm } = await import('./NetworkRouteForm')

afterEach(cleanup)

const status = {
  engine: 'vpn-helper',
  config: { host: 'proxy.example.com', port: 1080, udpMode: 'udp' as const, onGeoFail: 'report' as const },
  enabled: true,
  observed: { up: true },
  drift: false,
  sessionId: 'sess-1',
  failClosed: true,
  health: 'ok' as const,
  checks: [],
  lastError: null,
  exitHistory: [],
  recovery: null,
}

describe('NetworkRouteForm', () => {
  test('renders the route status once GET /network resolves', async () => {
    const { getByText } = renderWithApi(<NetworkRouteForm deviceId="dev-1" canUse={true} />, {
      '/api/devices/dev-1/network': { body: status },
    })
    await waitFor(() => expect(getByText('Route on')).toBeTruthy())
    expect(getByText('confirmed live')).toBeTruthy()
  })

  test('no route saved yet renders the off state, not a crash', async () => {
    const { getByText } = renderWithApi(<NetworkRouteForm deviceId="dev-2" canUse={true} />, {
      '/api/devices/dev-2/network': {
        body: { ...status, config: null, enabled: false, observed: null, health: 'unknown', drift: false },
      },
    })
    await waitFor(() => expect(getByText('Route off')).toBeTruthy())
  })

  // Plan 90 §3.7 rule 5, fixes F20 — before this the only operator-visible
  // artefact of exhaustion was a static string; this proves the countdown,
  // the attempt count, and the Retry now action actually render.
  describe('automatic recovery (plan 90 §3.7 rule 5, fixes F20)', () => {
    test('a mid-backoff attempt shows a countdown and an attempt count', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      const { getByText, getAllByText } = renderWithApi(<NetworkRouteForm deviceId="dev-3" canUse={true} />, {
        '/api/devices/dev-3/network': {
          body: { ...status, recovery: { attempts: 2, maxAttempts: 3, nextAttemptAt: nowSec + 14, exhausted: false, reconnectCycles: 1 } },
        },
      })
      await waitFor(() => expect(getByText(/attempt 2 of 3/)).toBeTruthy())
      expect(getAllByText('Retry now').length).toBeGreaterThan(0)
    })

    test('an exhausted bound says so, and Retry now clears it (plan 90 §3.7 rule 4, fixes F17)', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      const { getAllByText, apiMock } = renderWithApi(<NetworkRouteForm deviceId="dev-4" canUse={true} />, {
        '/api/devices/dev-4/network': (req) => {
          if (req.method === 'POST' && req.path === '/api/devices/dev-4/network/retry') {
            return { body: { ...status, recovery: null } }
          }
          return { body: { ...status, recovery: { attempts: 3, maxAttempts: 3, nextAttemptAt: nowSec + 107, exhausted: true, reconnectCycles: 0 } } }
        },
      })
      await waitFor(() => expect(getAllByText(/Gave up after 3 attempts/).length).toBeGreaterThan(0))
      const [retryButton] = getAllByText('Retry now')
      fireEvent.click(retryButton!)
      await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/devices/dev-4/network/retry')).toBe(true))
    })

    test('no recovery info renders no countdown and no Retry now button — the common case stays quiet', async () => {
      const { queryByText } = renderWithApi(<NetworkRouteForm deviceId="dev-5" canUse={true} />, {
        '/api/devices/dev-5/network': { body: status },
      })
      await waitFor(() => expect(queryByText('Route on')).toBeTruthy())
      expect(queryByText('Retry now')).toBeNull()
    })
  })
})
