import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { PreparationComponentStatus, PreparationState } from '@enkaku/protocol'
import type { NetworkStatus } from '@/lib/api'
import type { AgentReadiness } from './VpnAgentPrecondition'

mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { VpnAgentPrecondition, agentBlocksVpn, vpnBlockedReason } = await import('./VpnAgentPrecondition')
const { VpnRouteFields } = await import('./VpnRouteFields')
const { NetworkRouteForm } = await import('./NetworkRouteForm')

afterEach(cleanup)

function component(state: PreparationState, over: Partial<PreparationComponentStatus> = {}): PreparationComponentStatus {
  return { state, version: null, reason: null, checkedAt: null, attempts: 0, nextAttemptAt: null, ...over }
}

function readiness(over: Partial<AgentReadiness> = {}): AgentReadiness {
  return {
    status: null,
    state: null,
    neverChecked: false,
    loading: false,
    loadError: null,
    reload: () => {},
    patch: () => {},
    ...over,
  }
}

function withState(state: PreparationState, over: Partial<PreparationComponentStatus> = {}): AgentReadiness {
  const status = component(state, over)
  return readiness({ status, state })
}

const baseStatus: NetworkStatus = {
  engine: 'none',
  config: null,
  enabled: false,
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

function networkBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...baseStatus, sessionId: null, ...over }
}

const HTTP_CONFIG = { engine: 'adb-proxy', host: 'proxy.example.com', port: 8080 }
const VPN_CONFIG = { engine: 'vpn-helper', host: 'proxy.example.com', port: 1080, udpMode: 'udp', onGeoFail: 'report' }

/**
 * Plan 114 §3.4 — the owner asked for this path by name. Each state gets its
 * own heading, its own fix, and (for two of them) deliberately no fix at all:
 * offering Retry on `unsupported` is how a phone ends up permanently reporting
 * an error nobody can clear (plan 106's own distinction — an old phone is not
 * a broken one).
 */
describe('VpnAgentPrecondition — one state, one heading, one fix (plan 114 §3.4)', () => {
  test('absent names the phone’s real state and offers Install', () => {
    const { getByText } = renderWithApi(
      <VpnAgentPrecondition deviceId="p1" canUse={true} agent={withState('absent')} unsavedSelection={false} />,
      {},
    )
    expect(getByText('This phone does not have the Enkaku guest agent yet')).toBeTruthy()
    expect(getByText('Install')).toBeTruthy()
  })

  test('provisioning offers no action button, and shows elapsed time rather than a fabricated percentage', () => {
    const startedAt = Math.floor(Date.now() / 1000) - 90
    const { container, getByText } = renderWithApi(
      <VpnAgentPrecondition
        deviceId="p2"
        canUse={true}
        agent={withState('provisioning', { checkedAt: startedAt })}
        unsavedSelection={false}
      />,
      {},
    )
    expect(getByText('Installing the guest agent…')).toBeTruthy()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.textContent).toContain('Running for')
    expect(container.textContent).toContain('no progress percentage is available for this install')
  })

  test('outdated offers Update agent', () => {
    const { getByText } = renderWithApi(
      <VpnAgentPrecondition deviceId="p3" canUse={true} agent={withState('outdated')} unsavedSelection={false} />,
      {},
    )
    expect(getByText('The installed agent is older than this farm’s')).toBeTruthy()
    expect(getByText('Update agent')).toBeTruthy()
  })

  test('failed shows the reason verbatim and offers Retry', () => {
    const reason = 'INSTALL_FAILED_INSUFFICIENT_STORAGE while pushing enkaku-guest-agent.apk'
    const { getByText } = renderWithApi(
      <VpnAgentPrecondition
        deviceId="p4"
        canUse={true}
        agent={withState('failed', { reason })}
        unsavedSelection={false}
      />,
      {},
    )
    expect(getByText('The guest agent could not be prepared on this phone')).toBeTruthy()
    expect(getByText(reason)).toBeTruthy()
    expect(getByText('Retry')).toBeTruthy()
  })

  test('unsupported offers no button at all — an old phone is not a broken one', () => {
    const { container, getByText } = renderWithApi(
      <VpnAgentPrecondition
        deviceId="p5"
        canUse={true}
        agent={withState('unsupported', { reason: 'Android 6 (API 23) is below the agent’s floor' })}
        unsavedSelection={false}
      />,
      {},
    )
    expect(getByText('This phone cannot run the Enkaku guest agent')).toBeTruthy()
    expect(getByText('Android 6 (API 23) is below the agent’s floor')).toBeTruthy()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  /**
   * Plan 114 §3.4's own distinction: a record with no `guest-agent` key at all
   * means the farm has not looked, which is not the same claim as "this phone
   * does not have it".
   */
  test('a preparation record with no guest-agent key says it has not been checked, not that it is missing', async () => {
    const { getByText, queryByText } = renderWithApi(
      <VpnRouteFields deviceId="p6" canUse={true} status={baseStatus} onApplied={() => {}} />,
      { '/api/devices/p6/preparation': { body: {} }, '/api/devices/p6/network': { body: networkBody() } },
    )
    await waitFor(() => expect(getByText('The guest agent has not been checked on this phone yet')).toBeTruthy())
    expect(queryByText('This phone does not have the Enkaku guest agent yet')).toBeNull()
    expect(getByText('Install and check')).toBeTruthy()
  })
})

describe('VpnAgentPrecondition — the fixes reach exactly one endpoint each (plan 114 §3.4 rule 3)', () => {
  test('Install on absent posts once to the agent endpoint, and never to the preparation retry path', async () => {
    const { getByText, apiMock } = renderWithApi(
      <VpnAgentPrecondition deviceId="p7" canUse={true} agent={withState('absent')} unsavedSelection={false} />,
      { '/api/devices/p7/guest-agent': { body: { state: 'ready' } } },
    )
    fireEvent.click(getByText('Install'))
    await waitFor(() =>
      expect(apiMock.calls.filter((c) => c.method === 'POST' && c.path === '/api/devices/p7/guest-agent')).toHaveLength(1),
    )
    expect(apiMock.calls.filter((c) => c.path.includes('/preparation'))).toHaveLength(0)
  })

  test('Retry on failed posts once to the preparation retry path, and never installs a second way', async () => {
    const { getByText, apiMock } = renderWithApi(
      <VpnAgentPrecondition
        deviceId="p8"
        canUse={true}
        agent={withState('failed', { reason: 'adb: device offline' })}
        unsavedSelection={false}
      />,
      { '/api/devices/p8/preparation/guest-agent/retry': { body: component('ready') } },
    )
    fireEvent.click(getByText('Retry'))
    await waitFor(() =>
      expect(
        apiMock.calls.filter((c) => c.method === 'POST' && c.path === '/api/devices/p8/preparation/guest-agent/retry'),
      ).toHaveLength(1),
    )
    expect(apiMock.calls.filter((c) => c.path === '/api/devices/p8/guest-agent')).toHaveLength(0)
  })
})

/**
 * Plan 114 §3.4 rule 4, and the single worst failure this step could ship.
 * Picking VPN on a phone that cannot run it must save nothing at all — never
 * the advisory rung instead, which would read as "proxy on" either way while
 * an app walked straight past it.
 */
describe('never a silent downgrade (plan 114 §3.4 rule 4)', () => {
  test('picking VPN on an agent-less phone writes nothing, and switches mode only on an explicit click', async () => {
    const { container, getByText, apiMock } = renderWithApi(<NetworkRouteForm deviceId="p9" canUse={true} />, {
      '/api/devices/p9/network': { body: networkBody() },
      '/api/devices/p9/preparation': { body: { 'guest-agent': component('absent') } },
    })
    await waitFor(() => expect(getByText('VPN')).toBeTruthy())
    fireEvent.click(container.querySelector('#mode-p9-vpn') as HTMLInputElement)
    await waitFor(() => expect(getByText('This phone does not have the Enkaku guest agent yet')).toBeTruthy())

    // Nothing was written, and in particular nothing named the advisory rung.
    expect(apiMock.calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    expect(apiMock.calls.some((c) => JSON.stringify(c.body ?? null).includes('adb-proxy'))).toBe(false)

    // The second choice is a deliberate click, never a fallback.
    fireEvent.click(getByText('Use HTTP proxy instead'))
    await waitFor(() => expect(getByText('Set proxy')).toBeTruthy())
    expect(apiMock.calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  test('the unsaved notice appears over a non-VPN applied route, and "Keep the current setting" restores the selector', async () => {
    const { container, getByText, queryByText } = renderWithApi(<NetworkRouteForm deviceId="p10" canUse={true} />, {
      '/api/devices/p10/network': { body: networkBody({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true }) },
      '/api/devices/p10/preparation': { body: { 'guest-agent': component('absent') } },
    })
    await waitFor(() => expect(getByText('http proxy')).toBeTruthy())
    fireEvent.click(container.querySelector('#mode-p10-vpn') as HTMLInputElement)
    await waitFor(() => expect(getByText('Nothing has been applied.')).toBeTruthy())

    fireEvent.click(getByText('Keep the current setting'))
    await waitFor(() => expect(getByText('http proxy')).toBeTruthy())
    expect(queryByText('Nothing has been applied.')).toBeNull()
    expect((container.querySelector('#mode-p10-http') as HTMLInputElement).checked).toBe(true)
  })

  test('no unsaved notice when the applied route already IS the VPN', async () => {
    const { getByText, queryByText } = renderWithApi(<NetworkRouteForm deviceId="p11" canUse={true} />, {
      '/api/devices/p11/network': { body: networkBody({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: true }) },
      '/api/devices/p11/preparation': { body: { 'guest-agent': component('absent') } },
    })
    await waitFor(() => expect(getByText('This phone does not have the Enkaku guest agent yet')).toBeTruthy())
    expect(queryByText('Nothing has been applied.')).toBeNull()
  })
})

describe('the Apply gate (plan 114 §3.4, `agentBlocksVpn`)', () => {
  test('every non-ready state blocks, `ready` does not, and an unreadable state does NOT block', () => {
    for (const state of ['absent', 'provisioning', 'outdated', 'failed', 'unsupported'] as PreparationState[]) {
      expect(agentBlocksVpn(withState(state))).toBe(true)
      expect(vpnBlockedReason(withState(state))).not.toBeNull()
    }
    expect(agentBlocksVpn(withState('ready'))).toBe(false)
    expect(vpnBlockedReason(withState('ready'))).toBeNull()
    // A read that failed is not a claim about the phone — refusing a device
    // whose agent is fine costs more than one honest server error.
    expect(agentBlocksVpn(readiness({ loadError: 'GET /preparation → 500' }))).toBe(false)
    expect(vpnBlockedReason(readiness({ loadError: 'GET /preparation → 500' }))).toBeNull()
  })

  test('a blocked state disables Apply and states the reason beside it', async () => {
    const { getByText } = renderWithApi(
      <VpnRouteFields deviceId="p12" canUse={true} status={baseStatus} onApplied={() => {}} />,
      {
        '/api/devices/p12/preparation': { body: { 'guest-agent': component('absent') } },
        '/api/devices/p12/network': { body: networkBody() },
      },
    )
    await waitFor(() => expect(getByText('This phone does not have the Enkaku guest agent yet')).toBeTruthy())
    expect((getByText('Apply route').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(getByText('This phone does not have the Enkaku guest agent yet, and VPN mode needs it.')).toBeTruthy()
  })

  test('a ready agent enables Apply once the route itself is valid', async () => {
    const { getByLabelText, getByText, queryByText } = renderWithApi(
      <VpnRouteFields deviceId="p13" canUse={true} status={baseStatus} onApplied={() => {}} />,
      {
        '/api/devices/p13/preparation': { body: { 'guest-agent': component('ready') } },
        '/api/devices/p13/network': { body: networkBody() },
      },
    )
    await waitFor(() => expect(getByText('socks5 upstream')).toBeTruthy())
    // A ready agent renders no precondition at all.
    expect(queryByText('This phone does not have the Enkaku guest agent yet')).toBeNull()
    fireEvent.change(getByLabelText('Host'), { target: { value: 'proxy.example.com' } })
    fireEvent.change(getByLabelText('Port'), { target: { value: '1080' } })
    expect((getByText('Apply route').closest('button') as HTMLButtonElement).disabled).toBe(false)
  })

  test('a preparation read that FAILED leaves Apply usable — a false block refuses a working phone', async () => {
    const { getByLabelText, getByText } = renderWithApi(
      <VpnRouteFields deviceId="p14" canUse={true} status={baseStatus} onApplied={() => {}} />,
      {
        '/api/devices/p14/preparation': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'boom' } } },
        '/api/devices/p14/network': { body: networkBody() },
      },
    )
    await waitFor(() => expect(getByText('Could not read this phone’s guest-agent state')).toBeTruthy())
    fireEvent.change(getByLabelText('Host'), { target: { value: 'proxy.example.com' } })
    fireEvent.change(getByLabelText('Port'), { target: { value: '1080' } })
    expect((getByText('Apply route').closest('button') as HTMLButtonElement).disabled).toBe(false)
  })
})
