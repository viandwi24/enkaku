import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { NetworkStatus } from '@/lib/api'

// `api()` reads `coreBase()` from `@/lib/ws` — mocked so the fetch stub below
// actually matches the URL the component builds.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { HttpProxyFields, parseHttpProxyUrl } = await import('./HttpProxyFields')

afterEach(cleanup)

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
  pendingClear: null,
}

function statusWith(config: NetworkStatus['config']): NetworkStatus {
  return { ...baseStatus, config, engine: config?.engine ?? 'none', enabled: config !== null }
}

/**
 * Plan 114 §3.8, goal 8, acceptance criterion 8 — the paste parser is the
 * first of the two places a credential is refused (the API is the second).
 * The whole table is asserted because each row is a real string an operator
 * holds: a provider's dashboard hands out exactly these shapes.
 */
describe('parseHttpProxyUrl (plan 114 §3.8)', () => {
  test('the thirteen shapes an operator actually pastes', () => {
    // Accepted — `host:port` and nothing else, which is all Android's setting holds.
    expect(parseHttpProxyUrl('http://proxy.example.com:8080')).toEqual({ ok: true, host: 'proxy.example.com', port: 8080 })
    expect(parseHttpProxyUrl('https://proxy.example.com:3128')).toEqual({ ok: true, host: 'proxy.example.com', port: 3128 })
    expect(parseHttpProxyUrl('proxy.example.com:8080')).toEqual({ ok: true, host: 'proxy.example.com', port: 8080 })
    expect(parseHttpProxyUrl('   http://proxy.example.com:8080   ')).toEqual({
      ok: true,
      host: 'proxy.example.com',
      port: 8080,
    })
    expect(parseHttpProxyUrl('10.0.0.5:3128')).toEqual({ ok: true, host: '10.0.0.5', port: 3128 })

    // Refused for carrying an account — the value is world-readable on-device.
    expect(parseHttpProxyUrl('http://user:pass@host:8080')).toEqual({ ok: false, reason: 'userinfo' })
    // Schemeless, and the reason this one matters: `@` is checked BEFORE the
    // host/port split, so the account can never be parsed away as a hostname.
    expect(parseHttpProxyUrl('user:pass@host:8080')).toEqual({ ok: false, reason: 'userinfo' })
    expect(parseHttpProxyUrl('http://user@host:8080')).toEqual({ ok: false, reason: 'userinfo' })

    // SOCKS is answered by naming the mode that CAN carry it, not only by saying no.
    expect(parseHttpProxyUrl('socks5://host:1080')).toEqual({ ok: false, reason: 'socks', hasAuth: false })
    expect(parseHttpProxyUrl('socks5://user:pass@host:1080')).toEqual({ ok: false, reason: 'socks', hasAuth: true })
    expect(parseHttpProxyUrl('socks5h://user:pass@host:1080')).toEqual({ ok: false, reason: 'socks', hasAuth: true })

    // Malformed.
    expect(parseHttpProxyUrl('http://proxy.example.com')).toEqual({ ok: false, reason: 'shape' })
    expect(parseHttpProxyUrl('ftp://host:21')).toEqual({ ok: false, reason: 'shape' })
    expect(parseHttpProxyUrl('proxy.example.com')).toEqual({ ok: false, reason: 'shape' })
    expect(parseHttpProxyUrl('host:0')).toEqual({ ok: false, reason: 'shape' })
    expect(parseHttpProxyUrl('')).toEqual({ ok: false, reason: 'shape' })
  })
})

describe('HttpProxyFields — the userinfo refusal (plan 114 §3.8, risk 2)', () => {
  function renderFields(overrides: Partial<Parameters<typeof HttpProxyFields>[0]> = {}) {
    return renderWithApi(
      <HttpProxyFields
        deviceId="d1"
        canUse={true}
        status={baseStatus}
        onApplied={() => {}}
        onChooseVpn={() => {}}
        {...overrides}
      />,
      { '/api/devices/d1/network': { body: {} } },
    )
  }

  test('a credentialled paste is refused by name, and the refusal says where the account does go', () => {
    const { getByLabelText, getByText } = renderFields()
    fireEvent.change(getByLabelText('Paste an http://host:port address to fill the fields below'), {
      target: { value: 'http://user:pass@proxy.example.com:8080' },
    })
    fireEvent.click(getByText('Fill fields'))
    expect(
      getByText(
        'That address carries a username and password. Android’s system proxy setting is host:port — there is nowhere to put an account, and every app on the phone can read the value, so the farm will not write one there. To use a proxy that needs an account, run it on this farm’s machine: the phone dials it over the adb connection and the account never reaches the phone.',
      ),
    ).toBeTruthy()
  })

  test('the refusal’s own button switches to the farm rung, which is the one that can carry an account', () => {
    const { getByLabelText, getByText } = renderFields()
    fireEvent.change(getByLabelText('Paste an http://host:port address to fill the fields below'), {
      target: { value: 'http://user:pass@proxy.example.com:8080' },
    })
    fireEvent.click(getByText('Fill fields'))
    fireEvent.click(getByText('Use a proxy on this farm’s machine'))
    expect(getByLabelText('Port on this machine')).toBeTruthy()
  })

  test('a SOCKS5 paste WITH an account offers VPN mode, and the button actually calls onChooseVpn', () => {
    let chosen = 0
    const { getByLabelText, getByText } = renderFields({ onChooseVpn: () => (chosen += 1) })
    fireEvent.change(getByLabelText('Paste an http://host:port address to fill the fields below'), {
      target: { value: 'socks5://user:pass@proxy.soax.com:5000' },
    })
    fireEvent.click(getByText('Fill fields'))
    expect(
      getByText(
        'That is a SOCKS5 address with an account on it. Android’s system proxy setting carries an HTTP proxy only, and has nowhere to put a username or password. VPN mode is what carries a SOCKS5 upstream, and it keeps the account off the phone.',
      ),
    ).toBeTruthy()
    fireEvent.click(getByText('Switch to VPN mode'))
    expect(chosen).toBe(1)
  })

  test('a refused paste leaves host and port exactly as they were — nothing is silently dropped in', () => {
    const { getByLabelText, getByText } = renderFields()
    const host = getByLabelText('Proxy host') as HTMLInputElement
    const port = getByLabelText('Proxy port') as HTMLInputElement
    fireEvent.change(host, { target: { value: 'kept.example.com' } })
    fireEvent.change(port, { target: { value: '3128' } })

    fireEvent.change(getByLabelText('Paste an http://host:port address to fill the fields below'), {
      target: { value: 'http://user:pass@other.example.com:8080' },
    })
    fireEvent.click(getByText('Fill fields'))

    expect(host.value).toBe('kept.example.com')
    expect(port.value).toBe('3128')
  })
})

describe('HttpProxyFields — what the PUT actually carries (plan 114 §4.1)', () => {
  test('the direct rung sends engine adb-proxy with host and port', async () => {
    const { getByLabelText, getByText, apiMock } = renderWithApi(
      <HttpProxyFields deviceId="d2" canUse={true} status={baseStatus} onApplied={() => {}} onChooseVpn={() => {}} />,
      {
        '/api/devices/d2/network': {
          body: {
            engine: 'adb-proxy',
            config: { engine: 'adb-proxy', host: 'proxy.example.com', port: 8080 },
            enabled: true,
            observed: null,
            drift: false,
            sessionId: null,
            failClosed: true,
            health: 'unverified',
            checks: [],
            lastError: null,
            exitHistory: [],
            recovery: null,
            setBy: null,
          },
        },
      },
    )
    fireEvent.change(getByLabelText('Proxy host'), { target: { value: 'proxy.example.com' } })
    fireEvent.change(getByLabelText('Proxy port'), { target: { value: '8080' } })
    fireEvent.click(getByText('Set proxy'))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = apiMock.calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ engine: 'adb-proxy', host: 'proxy.example.com', port: 8080 })
  })

  test('the farm rung sends engine adb-reverse-proxy with a hostPort and never a host', async () => {
    const { container, getByLabelText, getByText, apiMock } = renderWithApi(
      <HttpProxyFields deviceId="d3" canUse={true} status={baseStatus} onApplied={() => {}} onChooseVpn={() => {}} />,
      {
        '/api/devices/d3/network': {
          body: {
            engine: 'adb-reverse-proxy',
            config: { engine: 'adb-reverse-proxy', hostPort: 9902, devicePort: null },
            enabled: true,
            observed: null,
            drift: false,
            sessionId: null,
            failClosed: true,
            health: 'unverified',
            checks: [],
            lastError: null,
            exitHistory: [],
            recovery: null,
            setBy: null,
          },
        },
      },
    )
    fireEvent.click(container.querySelector('#placement-d3-farm') as HTMLInputElement)
    fireEvent.change(getByLabelText('Port on this machine'), { target: { value: '9902' } })
    fireEvent.click(getByText('Set proxy'))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = apiMock.calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ engine: 'adb-reverse-proxy', hostPort: 9902 })
    expect(Object.keys(put?.body as object)).not.toContain('host')
  })
})

describe('HttpProxyFields — no credential field exists at all (plan 114 §3.8, F6)', () => {
  test('neither rung renders a password input or a Username/Password label', () => {
    const { container, queryByText, queryByLabelText } = renderWithApi(
      <HttpProxyFields deviceId="d4" canUse={true} status={baseStatus} onApplied={() => {}} onChooseVpn={() => {}} />,
      {},
    )
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(queryByText('Username')).toBeNull()
    expect(queryByText('Password')).toBeNull()
    expect(queryByLabelText('Username')).toBeNull()
    expect(queryByLabelText('Password')).toBeNull()

    fireEvent.click(container.querySelector('#placement-d4-farm') as HTMLInputElement)
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(queryByText('Username')).toBeNull()
    expect(queryByText('Password')).toBeNull()
  })
})

describe('HttpProxyFields — the permanent advisory sentence (plan 114 §3.5, §3.1 rule 3)', () => {
  test('renders with nothing applied and health unknown — it is not a failure banner', () => {
    const { getByText } = renderWithApi(
      <HttpProxyFields deviceId="d5" canUse={true} status={baseStatus} onApplied={() => {}} onChooseVpn={() => {}} />,
      {},
    )
    expect(
      getByText(
        'A proxy is set on this phone. Apps that honour the system proxy will use it; an app with its own networking can ignore it, and nothing here can tell you which did. For traffic an app cannot escape, use VPN mode.',
      ),
    ).toBeTruthy()
  })
})

describe('HttpProxyFields — seeding and the apply gate', () => {
  test('an applied adb-proxy route seeds host and port, and the button reads Update proxy', () => {
    const { getByLabelText, getByText } = renderWithApi(
      <HttpProxyFields
        deviceId="d6"
        canUse={true}
        status={statusWith({ engine: 'adb-proxy', host: 'seeded.example.com', port: 8888 })}
        onApplied={() => {}}
        onChooseVpn={() => {}}
      />,
      {},
    )
    expect((getByLabelText('Proxy host') as HTMLInputElement).value).toBe('seeded.example.com')
    expect((getByLabelText('Proxy port') as HTMLInputElement).value).toBe('8888')
    expect(getByText('Update proxy')).toBeTruthy()
  })

  test('an applied adb-reverse-proxy route seeds the farm rung and its port', () => {
    const { container, getByLabelText } = renderWithApi(
      <HttpProxyFields
        deviceId="d7"
        canUse={true}
        status={statusWith({ engine: 'adb-reverse-proxy', hostPort: 9902, devicePort: 9902 })}
        onApplied={() => {}}
        onChooseVpn={() => {}}
      />,
      {},
    )
    expect((container.querySelector('#placement-d7-farm') as HTMLInputElement).checked).toBe(true)
    expect((getByLabelText('Port on this machine') as HTMLInputElement).value).toBe('9902')
  })

  /**
   * Seeding is once, not on every status change. The status object is replaced
   * the moment an apply resolves (`onApplied`), and re-seeding then would wipe
   * whatever the operator had already typed for their next change.
   */
  test('a second status does not stomp an in-progress edit', () => {
    const { getByLabelText, rerender } = renderWithApi(
      <HttpProxyFields
        deviceId="d8"
        canUse={true}
        status={statusWith({ engine: 'adb-proxy', host: 'first.example.com', port: 8080 })}
        onApplied={() => {}}
        onChooseVpn={() => {}}
      />,
      {},
    )
    const host = getByLabelText('Proxy host') as HTMLInputElement
    expect(host.value).toBe('first.example.com')
    fireEvent.change(host, { target: { value: 'operator-typed.example.com' } })

    rerender(
      <HttpProxyFields
        deviceId="d8"
        canUse={true}
        status={statusWith({ engine: 'adb-proxy', host: 'first.example.com', port: 8080 })}
        onApplied={() => {}}
        onChooseVpn={() => {}}
      />,
    )
    expect((getByLabelText('Proxy host') as HTMLInputElement).value).toBe('operator-typed.example.com')
  })

  test('apply is disabled until the port validates', () => {
    const { getByLabelText, getByText } = renderWithApi(
      <HttpProxyFields deviceId="d9" canUse={true} status={baseStatus} onApplied={() => {}} onChooseVpn={() => {}} />,
      {},
    )
    const button = getByText('Set proxy').closest('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)

    fireEvent.change(getByLabelText('Proxy host'), { target: { value: 'proxy.example.com' } })
    expect(button.disabled).toBe(true)

    fireEvent.change(getByLabelText('Proxy port'), { target: { value: '70000' } })
    expect(button.disabled).toBe(true)

    fireEvent.change(getByLabelText('Proxy port'), { target: { value: '8080' } })
    expect(button.disabled).toBe(false)
  })
})
