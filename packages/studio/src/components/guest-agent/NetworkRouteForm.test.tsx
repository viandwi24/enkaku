import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
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
})
