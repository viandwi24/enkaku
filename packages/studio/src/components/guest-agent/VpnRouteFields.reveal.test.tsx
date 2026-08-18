import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { AuthContext, type AuthState } from '@/lib/auth'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { NetworkStatus } from '@/lib/api'

mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { VpnRouteFields } = await import('./VpnRouteFields')

afterEach(cleanup)

const READY = {
  'guest-agent': { state: 'ready', version: '1.0.0', reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null },
}

const SECRET = 'soax-password-9f2'

function auth(role: 'admin' | 'operator' | null): AuthState {
  return {
    user: role === null ? null : { id: 'u1', email: 'u@test', role },
    authMode: 'server',
    setupNeeded: false,
    refresh: async () => {},
    logout: async () => {},
  }
}

function vpnStatus(over: Record<string, unknown> = {}): NetworkStatus {
  return {
    engine: 'vpn-helper',
    config: {
      engine: 'vpn-helper',
      host: 'proxy.example.com',
      port: 1080,
      udpMode: 'udp',
      onGeoFail: 'report',
      credentialRef: 'soax-1',
      credentialUsername: 'package-123-sessionid-abc',
      ...over,
    } as NetworkStatus['config'],
    enabled: true,
    observed: null,
    drift: false,
    failClosed: true,
    health: 'unknown',
    checks: [],
    lastError: null,
    exitHistory: [],
    recovery: null,
    setBy: null,
  }
}

function renderAs(role: 'admin' | 'operator' | null, deviceId: string, status = vpnStatus()) {
  return renderWithApi(
    <AuthContext.Provider value={auth(role)}>
      <VpnRouteFields deviceId={deviceId} canUse={true} status={status} onApplied={() => {}} />
    </AuthContext.Provider>,
    {
      [`/api/devices/${deviceId}/preparation`]: { body: READY },
      [`/api/devices/${deviceId}/network`]: { body: { ...status, sessionId: null } },
      [`/api/devices/${deviceId}/network/credential/reveal`]: {
        body: { credentialRef: 'soax-1', username: 'package-123-sessionid-abc', password: SECRET, revealedAt: 1_760_000_000 },
      },
    },
  )
}

/**
 * The reveal (plan-less hotfix for the farm owner's own request: a stored
 * upstream credential has to be readable again). The three things worth
 * asserting are about ABSENCE and about the ACT, not about rendering a string:
 * the secret is not in the DOM until asked for, asking for it is a deliberate
 * POST that the panel's ordinary polling never makes, and there is a way back.
 */
describe('VpnRouteFields — revealing the stored credential', () => {
  test('the secret is absent from the DOM and un-fetched until the button is pressed', async () => {
    const { container, getByText, apiMock } = renderAs('admin', 'r1')
    await waitFor(() => expect(getByText('Show stored credential')).toBeTruthy())

    // Not "hidden" — not present. Nothing rendered it and nothing fetched it.
    expect(container.textContent).not.toContain(SECRET)
    expect(apiMock.calls.some((c) => c.path.includes('/credential/reveal'))).toBe(false)
    // The panel's own reads happened, and none of them was the reveal.
    expect(apiMock.calls.length).toBeGreaterThan(0)
  })

  test('pressing it POSTs once and shows the username and password', async () => {
    const { container, getByText, apiMock } = renderAs('admin', 'r2')
    await waitFor(() => expect(getByText('Show stored credential')).toBeTruthy())

    fireEvent.click(getByText('Show stored credential'))
    await waitFor(() => expect(container.textContent).toContain(SECRET))

    const reveals = apiMock.calls.filter((c) => c.path.includes('/credential/reveal'))
    expect(reveals).toHaveLength(1)
    expect(reveals[0]!.method).toBe('POST')
    expect(reveals[0]!.path).toBe('/api/devices/r2/network/credential/reveal')
    expect(container.textContent).toContain('package-123-sessionid-abc')
    // The operator is told, at the moment they can see it, that the farm wrote it down.
    expect(container.textContent).toContain('recorded in the audit log')
  })

  test('Hide takes it back out of the DOM', async () => {
    const { container, getByText } = renderAs('admin', 'r3')
    await waitFor(() => expect(getByText('Show stored credential')).toBeTruthy())
    fireEvent.click(getByText('Show stored credential'))
    await waitFor(() => expect(container.textContent).toContain(SECRET))

    fireEvent.click(getByText('Hide'))
    await waitFor(() => expect(container.textContent).not.toContain(SECRET))
    expect(getByText('Show stored credential')).toBeTruthy()
  })

  test('an operator sees the control, disabled, with the reason — never a silently missing button', async () => {
    const { container, getByText } = renderAs('operator', 'r4')
    await waitFor(() => expect(getByText('Show stored credential')).toBeTruthy())

    expect((getByText('Show stored credential').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(container.textContent).toContain('Only an admin can read a stored upstream password back')
    expect(container.textContent).not.toContain(SECRET)
  })

  test('a route with no stored credential offers no reveal at all', async () => {
    const status = vpnStatus({ credentialRef: undefined, credentialUsername: undefined })
    const { container } = renderAs('admin', 'r5', status)
    await waitFor(() => expect(container.textContent).toContain('connects to the upstream anonymously'))
    expect(container.textContent).not.toContain('Show stored credential')
  })
})

describe('the copy that used to be false', () => {
  test('"Never shown back" is gone, and what replaced it agrees with the button next to it', async () => {
    const { container, getByText } = renderAs('admin', 'r6')
    await waitFor(() => expect(getByText('Show stored credential')).toBeTruthy())
    expect(container.textContent).not.toContain('Never shown back')
    expect(container.textContent).toContain('Leave blank to keep the stored password')
  })

  test('the username is shown beside the credential name, so a route names its upstream identity', async () => {
    const { container, getByText } = renderAs('admin', 'r7')
    await waitFor(() => expect(getByText('soax-1')).toBeTruthy())
    expect(container.textContent).toContain('package-123-sessionid-abc')
  })
})
