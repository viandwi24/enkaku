import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
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

/**
 * Plan 114 F12, §3.4, acceptance criterion 1 — before step 114.7 this panel
 * gated the whole screen on `state === 'ready'`, so a phone that will never
 * run the guest agent had no proxy UI at all, not even the two HTTP rungs
 * which never needed it. These are the tests that hold that gate removed.
 */
describe('NetworkPanel — an agent-less phone still has a working proxy screen (plan 114 F12)', () => {
  const emptyNetwork = {
    engine: 'none',
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
    setBy: null,
  }

  test('not-installed + a preparation record of absent still renders all three modes, both sentences, and a usable HTTP rung', async () => {
    const { container, getByText, apiMock } = renderWithApi(<NetworkPanel deviceId="ag-1" canUse={true} />, {
      '/api/devices/ag-1/guest-agent': { body: { state: 'not-installed' } },
      '/api/devices/ag-1/network': { body: emptyNetwork },
      '/api/devices/ag-1/preparation': {
        body: { 'guest-agent': { state: 'absent', version: null, reason: null, checkedAt: null, attempts: 0, nextAttemptAt: null } },
      },
    })

    await waitFor(() => expect(getByText('HTTP proxy')).toBeTruthy())
    expect(getByText('Off')).toBeTruthy()
    expect(getByText('VPN')).toBeTruthy()
    expect(
      getByText(
        'Apps can ignore this. WebView and many HTTP libraries use it; an app with its own networking does not, and nothing on the phone stops it.',
      ),
    ).toBeTruthy()
    expect(getByText('Apps cannot opt out of this. Needs the Enkaku guest agent installed on the phone.')).toBeTruthy()

    fireEvent.click(container.querySelector('#mode-ag-1-http') as HTMLInputElement)
    await waitFor(() => expect(getByText('Proxy host')).toBeTruthy())
    expect(getByText('Proxy port')).toBeTruthy()
    expect(getByText('Set proxy')).toBeTruthy()

    // The HTTP rungs never needed the agent and now structurally cannot ask
    // about it — nothing on this path reads `devices.preparation`.
    expect(apiMock.calls.filter((c) => c.path.includes('/preparation'))).toHaveLength(0)
  })

  test('a failed GET /:id/guest-agent states the failure on its own row and leaves the mode selector on screen', async () => {
    const { getByText } = renderWithApi(<NetworkPanel deviceId="ag-2" canUse={true} />, {
      '/api/devices/ag-2/guest-agent': { status: 500 },
      '/api/devices/ag-2/network': { body: emptyNetwork },
    })
    await waitFor(() => expect(getByText('GET /api/devices/ag-2/guest-agent → 500')).toBeTruthy())
    // The old behaviour replaced the whole screen with this message.
    expect(getByText('Off')).toBeTruthy()
    expect(getByText('HTTP proxy')).toBeTruthy()
    expect(getByText('VPN')).toBeTruthy()
    expect(getByText('Check the agent again')).toBeTruthy()
  })
})
