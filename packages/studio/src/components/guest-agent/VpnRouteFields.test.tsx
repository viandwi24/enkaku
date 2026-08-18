import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { NetworkStatus } from '@/lib/api'

mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { VpnRouteFields, parseSocks5Url } = await import('./VpnRouteFields')
const { parseHttpProxyUrl } = await import('./HttpProxyFields')

afterEach(cleanup)

const READY = {
  'guest-agent': { state: 'ready', version: '1.0.0', reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null },
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

function vpnStatus(over: Partial<NonNullable<NetworkStatus['config']>> = {}): NetworkStatus {
  return {
    ...baseStatus,
    engine: 'vpn-helper',
    enabled: true,
    config: { engine: 'vpn-helper', host: 'proxy.example.com', port: 1080, udpMode: 'udp', onGeoFail: 'report', ...over },
  }
}

/**
 * Plan 114 §3.8 — the asymmetry between the two paste parsers is the point,
 * not an oversight. This rung can carry an account (encrypted into
 * `network_credentials`, never written to the phone); the HTTP rung cannot,
 * because Android's system proxy value has nowhere to put one and every app
 * on the device can read it.
 */
describe('parseSocks5Url keeps the userinfo the HTTP parser refuses (plan 114 §3.8)', () => {
  test('a credentialled SOCKS5 URL keeps its username and password', () => {
    expect(parseSocks5Url('socks5://user:pass@proxy.example.com:1080')).toEqual({
      host: 'proxy.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    })
  })

  test('percent-encoded credentials are decoded rather than passed through raw', () => {
    expect(parseSocks5Url('socks5://us%40er:p%3Ass@proxy.example.com:1080')).toEqual({
      host: 'proxy.example.com',
      port: 1080,
      username: 'us@er',
      password: 'p:ss',
    })
  })

  test('the same string that this parser accepts is refused by the HTTP one', () => {
    const url = 'socks5://user:pass@proxy.example.com:1080'
    expect(parseSocks5Url(url)).not.toBeNull()
    expect(parseHttpProxyUrl(url)).toEqual({ ok: false, reason: 'socks', hasAuth: true })
  })

  test('anything that is not a socks5 URL with an explicit port is null', () => {
    expect(parseSocks5Url('http://proxy.example.com:8080')).toBeNull()
    expect(parseSocks5Url('socks5://proxy.example.com')).toBeNull()
    expect(parseSocks5Url('not a url')).toBeNull()
  })
})

describe('VpnRouteFields — the PUT body (plan 114 §4.1)', () => {
  test('carries the vpn-helper discriminator explicitly', async () => {
    const { getByLabelText, getByText, apiMock } = renderWithApi(
      <VpnRouteFields deviceId="v1" canUse={true} status={baseStatus} onApplied={() => {}} />,
      {
        '/api/devices/v1/preparation': { body: READY },
        '/api/devices/v1/network': { body: { ...vpnStatus(), sessionId: null } },
      },
    )
    await waitFor(() => expect(getByText('socks5 upstream')).toBeTruthy())
    fireEvent.change(getByLabelText('Host'), { target: { value: 'proxy.example.com' } })
    fireEvent.change(getByLabelText('Port'), { target: { value: '1080' } })
    fireEvent.click(getByText('Apply route'))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = apiMock.calls.find((c) => c.method === 'PUT')
    const body = put?.body as Record<string, unknown>
    expect(body.engine).toBe('vpn-helper')
    expect(body.host).toBe('proxy.example.com')
    expect(body.port).toBe(1080)
    expect(body.udpMode).toBe('udp')
    expect(body.failClosed).toBe(true)
    // Never sent unless the operator asked for it — plan 44 §4.6 point 4.
    expect(body.clearCredential).toBeUndefined()
  })

  test('a stored credential is named, and "Use no authentication" is what sends clearCredential', async () => {
    const status = vpnStatus({ credentialRef: 'cred-1' } as never)
    const { getByText, apiMock } = renderWithApi(
      <VpnRouteFields deviceId="v2" canUse={true} status={status} onApplied={() => {}} />,
      {
        '/api/devices/v2/preparation': { body: READY },
        '/api/devices/v2/network': { body: { ...status, sessionId: null } },
      },
    )
    await waitFor(() => expect(getByText('cred-1')).toBeTruthy())

    fireEvent.click(getByText('Use no authentication'))
    expect(
      getByText('Saving will drop the stored credential and connect with no authentication.', { exact: false }),
    ).toBeTruthy()

    fireEvent.click(getByText('Update route'))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PUT')).toBe(true))
    const body = apiMock.calls.find((c) => c.method === 'PUT')?.body as Record<string, unknown>
    expect(body.clearCredential).toBe(true)
    expect(body.engine).toBe('vpn-helper')
  })

  test('"Keep it" puts the stored credential back and the next apply sends no clearCredential', async () => {
    const status = vpnStatus({ credentialRef: 'cred-2' } as never)
    const { getByText, apiMock } = renderWithApi(
      <VpnRouteFields deviceId="v3" canUse={true} status={status} onApplied={() => {}} />,
      {
        '/api/devices/v3/preparation': { body: READY },
        '/api/devices/v3/network': { body: { ...status, sessionId: null } },
      },
    )
    await waitFor(() => expect(getByText('cred-2')).toBeTruthy())
    fireEvent.click(getByText('Use no authentication'))
    fireEvent.click(getByText('Keep it'))

    fireEvent.click(getByText('Update route'))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PUT')).toBe(true))
    const body = apiMock.calls.find((c) => c.method === 'PUT')?.body as Record<string, unknown>
    expect(body.clearCredential).toBeUndefined()
  })
})
