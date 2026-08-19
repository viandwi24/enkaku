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

// ---- plan 114 (M79) fixtures and helpers ----

/**
 * A `GET /:id/network` body that actually parses through
 * `DeviceNetworkStatusResponseSchema` — `fetchNetworkStatus` parses rather
 * than casts (step 114.6), so a fixture that skips a required field fails as
 * an `ErrorState` rather than as the assertion the test meant to make.
 */
function makeStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...over,
  }
}

const HTTP_CONFIG = { engine: 'adb-proxy', host: 'proxy.example.com', port: 8080 }
const REVERSE_CONFIG = { engine: 'adb-reverse-proxy', hostPort: 9902, devicePort: 9902 }
const VPN_CONFIG = { engine: 'vpn-helper', host: 'proxy.example.com', port: 1080, udpMode: 'udp', onGeoFail: 'report' }

/** The `Row` component renders `<dt>label</dt><dd>value</dd>` — read the value the operator actually sees. */
function rowValue(container: HTMLElement, label: string): string | null {
  const dt = Array.from(container.querySelectorAll('dt')).find((d) => d.textContent === label)
  return dt ? (dt.nextElementSibling?.textContent ?? null) : null
}

function radio(container: HTMLElement, id: string): HTMLInputElement {
  const el = container.querySelector(`#${id}`)
  if (!el) throw new Error(`no radio #${id}`)
  return el as HTMLInputElement
}

// The two sentences of plan 114 §3.1 rule 1, written out rather than imported
// from `proxy-copy` — acceptance criterion 2 asks for a literal-string test,
// and a test that imports the constant it is checking would pass unchanged
// through exactly the quiet softening it exists to catch.
const HTTP_SENTENCE =
  'Apps can ignore this. WebView and many HTTP libraries use it; an app with its own networking does not, and nothing on the phone stops it.'
const VPN_SENTENCE = 'Apps cannot opt out of this. Needs the Enkaku guest agent installed on the phone.'

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

/**
 * Plan 114 §3.1, §3.10, acceptance criteria 2 and 4.
 *
 * The whole feature turns on an operator NOT believing that HTTP proxy mode
 * captures their traffic. Several assertions below are literal strings on
 * purpose: the copy IS the feature, and a paraphrase that drifts is a
 * regression, not a wording preference.
 */
describe('NetworkRouteForm — the mode selector (plan 114 §3.1, §3.10)', () => {
  test('all three modes render on a device with no route at all, with both §3.1 sentences verbatim (criterion 2)', async () => {
    const { getByText } = renderWithApi(<NetworkRouteForm deviceId="m-1" canUse={true} />, {
      '/api/devices/m-1/network': { body: makeStatus() },
    })
    await waitFor(() => expect(getByText('Off')).toBeTruthy())
    expect(getByText('HTTP proxy')).toBeTruthy()
    expect(getByText('VPN')).toBeTruthy()
    expect(getByText(HTTP_SENTENCE)).toBeTruthy()
    expect(getByText(VPN_SENTENCE)).toBeTruthy()
  })

  test('the same three modes and the same two sentences render on a device that already has an HTTP route', async () => {
    const { getByText } = renderWithApi(<NetworkRouteForm deviceId="m-2" canUse={true} />, {
      '/api/devices/m-2/network': { body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true }) },
    })
    await waitFor(() => expect(getByText(HTTP_SENTENCE)).toBeTruthy())
    expect(getByText(VPN_SENTENCE)).toBeTruthy()
    expect(getByText('Off')).toBeTruthy()
  })

  /**
   * Acceptance criterion 4, as a grep over the rendered DOM rather than over
   * the source: `routed`, a bare `ok`/`success`, or an `enabled: yes` in HTTP
   * mode would each say the farm knows something it structurally cannot know.
   */
  test('no forbidden word appears anywhere in the HTTP-mode DOM (criterion 4)', async () => {
    const { container, getByText } = renderWithApi(<NetworkRouteForm deviceId="m-3" canUse={true} />, {
      '/api/devices/m-3/network': {
        body: makeStatus({
          engine: 'adb-proxy',
          config: HTTP_CONFIG,
          enabled: true,
          health: 'unverified',
          checks: [
            { id: 'setting', state: 'pass', detail: 'the device reads back proxy.example.com:8080', at: 1 },
            { id: 'egress', state: 'skip', detail: 'this mode can never confirm egress', at: null },
          ],
        }),
      },
    })
    await waitFor(() => expect(getByText('http proxy')).toBeTruthy())
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\brouted\b/i)
    expect(text).not.toMatch(/\bok\b/i)
    expect(text).not.toMatch(/\bsuccess\b/i)
    // The `enabled` row itself, which is the one that would say `yes`.
    expect(rowValue(container, 'enabled')).toBe('asked')
  })

  test('`enabled` reads `asked` for both HTTP engines and `yes` for the VPN', async () => {
    const direct = renderWithApi(<NetworkRouteForm deviceId="m-4" canUse={true} />, {
      '/api/devices/m-4/network': { body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true }) },
    })
    await waitFor(() => expect(rowValue(direct.container, 'enabled')).toBe('asked'))
    cleanup()

    const farm = renderWithApi(<NetworkRouteForm deviceId="m-5" canUse={true} />, {
      '/api/devices/m-5/network': {
        body: makeStatus({ engine: 'adb-reverse-proxy', config: REVERSE_CONFIG, enabled: true }),
      },
    })
    await waitFor(() => expect(rowValue(farm.container, 'enabled')).toBe('asked'))
    cleanup()

    const vpn = renderWithApi(<NetworkRouteForm deviceId="m-6" canUse={true} />, {
      '/api/devices/m-6/network': { body: makeStatus({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: true }) },
      '/api/devices/m-6/preparation': { body: {} },
    })
    await waitFor(() => expect(rowValue(vpn.container, 'enabled')).toBe('yes'))
  })

  test('the `mode` row names the rung, not just the family, for all four engine values', async () => {
    const off = renderWithApi(<NetworkRouteForm deviceId="m-7" canUse={true} />, {
      '/api/devices/m-7/network': { body: makeStatus() },
    })
    await waitFor(() => expect(rowValue(off.container, 'mode')).toBe('off'))
    cleanup()

    const direct = renderWithApi(<NetworkRouteForm deviceId="m-8" canUse={true} />, {
      '/api/devices/m-8/network': { body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true }) },
    })
    await waitFor(() => expect(rowValue(direct.container, 'mode')).toBe('HTTP proxy · a proxy the phone can reach'))
    cleanup()

    const farm = renderWithApi(<NetworkRouteForm deviceId="m-9" canUse={true} />, {
      '/api/devices/m-9/network': {
        body: makeStatus({ engine: 'adb-reverse-proxy', config: REVERSE_CONFIG, enabled: true }),
      },
    })
    await waitFor(() => expect(rowValue(farm.container, 'mode')).toBe('HTTP proxy · a proxy on this machine'))
    cleanup()

    const vpn = renderWithApi(<NetworkRouteForm deviceId="m-10" canUse={true} />, {
      '/api/devices/m-10/network': { body: makeStatus({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: true }) },
      '/api/devices/m-10/preparation': { body: {} },
    })
    await waitFor(() => expect(rowValue(vpn.container, 'mode')).toBe('VPN'))
  })

  test('`setting confirmed on the device` maps every check state, and never claims more than the check state says', async () => {
    const cases: Array<[string, string, string]> = [
      ['m-11', 'pass', 'yes'],
      ['m-12', 'fail', 'no'],
      ['m-13', 'skip', 'not checked'],
      ['m-14', 'unknown', 'not checked yet'],
    ]
    for (const [id, state, expected] of cases) {
      const r = renderWithApi(<NetworkRouteForm deviceId={id} canUse={true} />, {
        [`/api/devices/${id}/network`]: {
          body: makeStatus({
            engine: 'adb-proxy',
            config: HTTP_CONFIG,
            enabled: true,
            checks: [{ id: 'setting', state, at: null }],
          }),
        },
      })
      await waitFor(() => expect(rowValue(r.container, 'setting confirmed on the device')).toBe(expected))
      cleanup()
    }
  })

  test('`setting confirmed on the device` is absent in VPN mode — the VPN writes no setting', async () => {
    const { container, getByText } = renderWithApi(<NetworkRouteForm deviceId="m-15" canUse={true} />, {
      '/api/devices/m-15/network': { body: makeStatus({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: true }) },
      '/api/devices/m-15/preparation': { body: {} },
    })
    await waitFor(() => expect(getByText('route status')).toBeTruthy())
    expect(rowValue(container, 'setting confirmed on the device')).toBeNull()
  })

  /**
   * `fail closed` is a property of a TUN that can be held shut. An advisory
   * `settings put` has no tunnel to hold and an app that ignored the setting
   * was never inside anything — so showing the row in HTTP mode would read as
   * a promise this rung cannot make.
   */
  test('`fail closed` is absent in HTTP mode and present in VPN mode', async () => {
    const http = renderWithApi(<NetworkRouteForm deviceId="m-16" canUse={true} />, {
      '/api/devices/m-16/network': { body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true }) },
    })
    await waitFor(() => expect(rowValue(http.container, 'mode')).toBe('HTTP proxy · a proxy the phone can reach'))
    expect(rowValue(http.container, 'fail closed')).toBeNull()
    cleanup()

    const vpn = renderWithApi(<NetworkRouteForm deviceId="m-17" canUse={true} />, {
      '/api/devices/m-17/network': {
        body: makeStatus({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: true, failClosed: true }),
      },
      '/api/devices/m-17/preparation': { body: {} },
    })
    await waitFor(() => expect(rowValue(vpn.container, 'fail closed')).toBe('yes'))
  })

  /**
   * Plan 114 §4.1's read-time migration, from Studio's side: a core that
   * predates the union answers with a `config` carrying no `engine` key at
   * all. It is a `vpn-helper` config by construction — reading it as Off would
   * show an operator "no proxy" on a phone that has one.
   */
  test('an untagged config from a pre-114 core renders as VPN mode, not Off', async () => {
    const { container, getByText } = renderWithApi(<NetworkRouteForm deviceId="m-18" canUse={true} />, {
      '/api/devices/m-18/network': {
        body: makeStatus({
          engine: 'vpn-helper',
          // No `engine` key — exactly what a pre-114 core sends.
          config: { host: 'proxy.example.com', port: 1080, udpMode: 'udp', onGeoFail: 'report' },
          enabled: true,
        }),
      },
      '/api/devices/m-18/preparation': { body: {} },
    })
    await waitFor(() => expect(rowValue(container, 'mode')).toBe('VPN'))
    expect(radio(container, 'mode-m-18-vpn').checked).toBe(true)
    expect(radio(container, 'mode-m-18-off').checked).toBe(false)
    // The VPN body, not the Off body.
    expect(getByText('socks5 upstream')).toBeTruthy()
  })

  test('picking a mode issues no PUT — only the body’s own button applies anything', async () => {
    const { container, apiMock, getByText } = renderWithApi(<NetworkRouteForm deviceId="m-19" canUse={true} />, {
      '/api/devices/m-19/network': { body: makeStatus({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: true }) },
      '/api/devices/m-19/preparation': { body: { 'guest-agent': { state: 'ready', version: null, reason: null, checkedAt: null, attempts: 0, nextAttemptAt: null } } },
    })
    await waitFor(() => expect(getByText('socks5 upstream')).toBeTruthy())

    fireEvent.click(radio(container, 'mode-m-19-http'))
    await waitFor(() => expect(getByText('http proxy')).toBeTruthy())
    fireEvent.click(radio(container, 'mode-m-19-off'))
    await waitFor(() => expect(getByText('off')).toBeTruthy())

    expect(apiMock.calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    expect(apiMock.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })
})

describe('NetworkRouteForm — Off (plan 114 §3.6)', () => {
  test('Off with a saved route offers "Turn off and restore", and confirming issues a DELETE', async () => {
    const { container, getByText, findByText, apiMock } = renderWithApi(
      <NetworkRouteForm deviceId="m-20" canUse={true} />,
      {
        '/api/devices/m-20/network': (req) => {
          if (req.method === 'DELETE') return { body: makeStatus() }
          return { body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true }) }
        },
      },
    )
    await waitFor(() => expect(getByText('http proxy')).toBeTruthy())
    fireEvent.click(radio(container, 'mode-m-20-off'))

    const trigger = await findByText('Turn off and restore')
    fireEvent.click(trigger)
    const confirm = await findByText('Turn off')
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(apiMock.calls.some((c) => c.method === 'DELETE' && c.path === '/api/devices/m-20/network')).toBe(true),
    )
  })

  test('Off with no saved route says so in a sentence and offers no button at all', async () => {
    const { container, getByText, queryByText } = renderWithApi(<NetworkRouteForm deviceId="m-21" canUse={true} />, {
      '/api/devices/m-21/network': { body: makeStatus() },
    })
    await waitFor(() =>
      expect(getByText('No proxy is set on this phone. It reaches the network on its own address.')).toBeTruthy(),
    )
    expect(radio(container, 'mode-m-21-off').checked).toBe(true)
    expect(queryByText('Turn off and restore')).toBeNull()
  })
})

describe('NetworkRouteForm — the `unverified` note and `set by` (plan 114 §3.3, §3.5)', () => {
  test('the unverified note names the missing fact differently per mode family', async () => {
    const http = renderWithApi(<NetworkRouteForm deviceId="m-22" canUse={true} />, {
      '/api/devices/m-22/network': {
        body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true, health: 'unverified' }),
      },
    })
    await waitFor(() =>
      expect(
        http.getByText(
          'This is the normal, permanent state for an HTTP proxy: the setting is on the phone, and no check can confirm an app actually used it.',
        ),
      ).toBeTruthy(),
    )
    cleanup()

    const vpn = renderWithApi(<NetworkRouteForm deviceId="m-23" canUse={true} />, {
      '/api/devices/m-23/network': {
        body: makeStatus({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: true, health: 'unverified' }),
      },
      '/api/devices/m-23/preparation': { body: {} },
    })
    await waitFor(() =>
      expect(
        vpn.getByText(
          'The route was applied and the device accepted it, but no egress check has confirmed traffic is actually leaving through this proxy yet.',
        ),
      ).toBeTruthy(),
    )
  })

  test('a plugin-set route names the plugin; a route nobody claimed says so rather than showing a dash', async () => {
    const now = Math.floor(Date.now() / 1000)
    const plugin = renderWithApi(<NetworkRouteForm deviceId="m-24" canUse={true} />, {
      '/api/devices/m-24/network': {
        body: makeStatus({
          engine: 'adb-proxy',
          config: HTTP_CONFIG,
          enabled: true,
          setBy: { kind: 'plugin', id: 'proxy-manager', at: now },
        }),
      },
    })
    await waitFor(() => expect(rowValue(plugin.container, 'set by')).toContain('proxy-manager (plugin)'))
    // The panel never claims a person it cannot identify (`setByReadout`).
    expect(rowValue(plugin.container, 'set by')).not.toMatch(/\byou\b/i)
    cleanup()

    const user = renderWithApi(<NetworkRouteForm deviceId="m-25" canUse={true} />, {
      '/api/devices/m-25/network': {
        body: makeStatus({
          engine: 'adb-proxy',
          config: HTTP_CONFIG,
          enabled: true,
          setBy: { kind: 'user', id: 'operator@example.com', at: now },
        }),
      },
    })
    await waitFor(() => expect(rowValue(user.container, 'set by')).toContain('operator@example.com'))
    expect(rowValue(user.container, 'set by')).not.toContain('(plugin)')
    expect(rowValue(user.container, 'set by')).not.toMatch(/\byou\b/i)
    cleanup()

    const unclaimed = renderWithApi(<NetworkRouteForm deviceId="m-26" canUse={true} />, {
      '/api/devices/m-26/network': {
        body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true, setBy: null }),
      },
    })
    await waitFor(() =>
      expect(rowValue(unclaimed.container, 'set by')).toBe('the farm — no operator or plugin claimed this route'),
    )
    expect(rowValue(unclaimed.container, 'set by')).not.toBe('—')
    expect(rowValue(unclaimed.container, 'set by')).not.toMatch(/\byou\b/i)
  })

  /**
   * Acceptance criterion 6 / plan 114 §3.6 rule 4 — the assertion that could
   * not be written until step 114.10's close-out, because the response schema
   * did not declare `captured` and a plain `z.object` strips an undeclared key
   * **silently**. The core had emitted it since 114.3; it vanished at the parse,
   * and the panel hedged about both outcomes at once.
   *
   * Restoring a captured value and clearing the keys are different things to do
   * to somebody's phone, and the operator is deciding whether to press the
   * button. Each branch is asserted to say ONE of them and explicitly not the
   * other, so a revert to the old both-cases prose fails here.
   */
  test('turning off says whether this phone will be RESTORED or CLEARED, never both', async () => {
    const now = Math.floor(Date.now() / 1000)

    const restores = renderWithApi(<NetworkRouteForm deviceId="m-40" canUse={true} />, {
      '/api/devices/m-40/network': {
        body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true, captured: { at: now } }),
      },
    })
    await waitFor(() => expect(restores.container.querySelector('#mode-m-40-off')).toBeTruthy())
    fireEvent.click(radio(restores.container, 'mode-m-40-off'))
    await waitFor(() => expect(restores.container.textContent).toMatch(/back to what the farm found on it/i))
    expect(restores.container.textContent).not.toMatch(/never captured an original value/i)
    expect(restores.container.textContent).not.toMatch(/cannot be shown here/i)
    cleanup()

    const clears = renderWithApi(<NetworkRouteForm deviceId="m-41" canUse={true} />, {
      '/api/devices/m-41/network': {
        body: makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true, captured: null }),
      },
    })
    await waitFor(() => expect(clears.container.querySelector('#mode-m-41-off')).toBeTruthy())
    fireEvent.click(radio(clears.container, 'mode-m-41-off'))
    await waitFor(() => expect(clears.container.textContent).toMatch(/never captured an original value/i))
    expect(clears.container.textContent).toMatch(/not the same as restoring/i)
    expect(clears.container.textContent).not.toMatch(/back to what the farm found on it/i)
    cleanup()

    // A core older than the field answers without it. "We cannot say" is a
    // third answer and is worded as one — rounding it down to "cleared" would
    // be a claim about the phone made from the absence of a key.
    const older = makeStatus({ engine: 'adb-proxy', config: HTTP_CONFIG, enabled: true }) as Record<string, unknown>
    delete older.captured
    const unknown = renderWithApi(<NetworkRouteForm deviceId="m-42" canUse={true} />, {
      '/api/devices/m-42/network': { body: older },
    })
    await waitFor(() => expect(unknown.container.querySelector('#mode-m-42-off')).toBeTruthy())
    fireEvent.click(radio(unknown.container, 'mode-m-42-off'))
    await waitFor(() => expect(unknown.container.textContent).toMatch(/cannot be shown here/i))
    expect(unknown.container.textContent).not.toMatch(/never captured an original value/i)
  })

  test('the `set by` row is absent entirely when there is no route to attribute', async () => {
    const { container, getByText } = renderWithApi(<NetworkRouteForm deviceId="m-27" canUse={true} />, {
      '/api/devices/m-27/network': { body: makeStatus() },
    })
    await waitFor(() => expect(getByText('route status')).toBeTruthy())
    expect(rowValue(container, 'set by')).toBeNull()
  })
})

/**
 * **A teardown the farm owes a phone it could not reach** — the state that
 * arrives on the wire the moment `DELETE /:id/network` or
 * `POST /:id/network/disable` is accepted for an OFFLINE device
 * (`requireDisarmAdmission`, `packages/core/src/network/route-service.ts`).
 *
 * Everything here was on the wire and nothing rendered it: the panel showed a
 * route that is `enabled: false` yet still fully described, whose config — after
 * a `DELETE` — exists only until the phone comes back. These fixtures are the
 * measured bodies, `reason` strings included verbatim, so a reworded core and a
 * reworded panel cannot drift into agreement by both being wrong.
 */
describe('NetworkRouteForm — an owed teardown (`pendingClear`)', () => {
  const HOUR_AGO = Math.floor(Date.now() / 1000) - 3600

  /** The measured `DELETE` on an offline device carrying the reverse rung. */
  const REVERSE_DEBT = {
    engine: 'adb-reverse-proxy',
    devicePort: 28700,
    forget: true,
    reason: 'the device was offline, so its proxy setting was never cleared',
    since: HOUR_AGO,
  }

  /** The same door, reached by `/disable` on an offline device carrying a VPN. */
  const VPN_DEBT = {
    engine: 'vpn-helper',
    forget: false,
    reason: 'the device was offline, so it was never told to stop',
    since: HOUR_AGO,
  }

  test('says what is true now, why, since when, and that nothing is required', async () => {
    const { container, getByText } = renderWithApi(<NetworkRouteForm deviceId="pc-1" canUse={true} />, {
      '/api/devices/pc-1/network': {
        body: makeStatus({
          engine: 'adb-reverse-proxy',
          config: REVERSE_CONFIG,
          enabled: false,
          pendingClear: REVERSE_DEBT,
        }),
      },
    })
    // 1. What is true right now — the subject is the phone, not the record.
    await waitFor(() => expect(getByText('The phone is still carrying this proxy')).toBeTruthy())
    // ...and the cost of that is stated, not implied.
    expect(container.textContent).toMatch(/traffic still goes out through that proxy/i)
    expect(container.textContent).toMatch(/metered/i)
    // 2. Why — the server's own sentence, verbatim and unparsed.
    expect(getByText('the device was offline, so its proxy setting was never cleared')).toBeTruthy()
    // 3. Since when — relative, the way every other time on this panel reads.
    expect(container.textContent).toMatch(/owed since/i)
    expect(container.textContent).toContain('1h ago')
    // 4. What happens next, and that the answer is "nothing".
    expect(getByText('Nothing is required of you.')).toBeTruthy()
    expect(container.textContent).toMatch(/next time the device is admitted/i)
    // The loopback the phone still dials, so a hand-run `settings get` is recognisable.
    expect(container.textContent).toContain('127.0.0.1:28700')
  })

  test('a DELETE says the saved route goes; a /disable says it stays — never the same sentence', async () => {
    const forgets = renderWithApi(<NetworkRouteForm deviceId="pc-2" canUse={true} />, {
      '/api/devices/pc-2/network': {
        body: makeStatus({ engine: 'adb-reverse-proxy', config: REVERSE_CONFIG, enabled: false, pendingClear: REVERSE_DEBT }),
      },
    })
    await waitFor(() => expect(forgets.container.textContent).toMatch(/The saved route goes with it/i))
    expect(forgets.container.textContent).toMatch(/erased once the phone has been told/i)
    expect(forgets.container.textContent).not.toMatch(/The saved route stays\./i)
    cleanup()

    const keeps = renderWithApi(<NetworkRouteForm deviceId="pc-3" canUse={true} />, {
      '/api/devices/pc-3/network': {
        body: makeStatus({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: false, pendingClear: VPN_DEBT }),
      },
      '/api/devices/pc-3/preparation': { body: {} },
    })
    await waitFor(() => expect(keeps.container.textContent).toMatch(/The saved route stays\./i))
    expect(keeps.container.textContent).toMatch(/without retyping them/i)
    expect(keeps.container.textContent).not.toMatch(/The saved route goes with it/i)
  })

  test('a VPN debt is worded as a tunnel that was never told to stop, not as a proxy setting', async () => {
    const { container, getByText } = renderWithApi(<NetworkRouteForm deviceId="pc-4" canUse={true} />, {
      '/api/devices/pc-4/network': {
        body: makeStatus({ engine: 'vpn-helper', config: VPN_CONFIG, enabled: false, pendingClear: VPN_DEBT }),
      },
      '/api/devices/pc-4/preparation': { body: {} },
    })
    await waitFor(() => expect(getByText('The phone is still carrying this tunnel')).toBeTruthy())
    expect(getByText('the device was offline, so it was never told to stop')).toBeTruthy()
    expect(container.textContent).toMatch(/through that tunnel/i)
  })

  /**
   * The tone decision, asserted rather than left to review: this is a pending,
   * self-resolving state — closer to "queued" than to "broken" — and
   * `led-danger` elsewhere in this product means a phone is actually cut off.
   * Spending it here trains an operator to ignore it there.
   */
  test('is warned, never alarmed — no led-danger anywhere in the notice', async () => {
    const { getByText } = renderWithApi(<NetworkRouteForm deviceId="pc-5" canUse={true} />, {
      '/api/devices/pc-5/network': {
        body: makeStatus({ engine: 'adb-reverse-proxy', config: REVERSE_CONFIG, enabled: false, pendingClear: REVERSE_DEBT }),
      },
    })
    await waitFor(() => expect(getByText('The phone is still carrying this proxy')).toBeTruthy())
    const notice = getByText('The phone is still carrying this proxy').closest('div.rounded-lg')
    expect(notice).toBeTruthy()
    expect(notice?.className).toContain('led-warn')
    expect(notice?.outerHTML).not.toContain('led-danger')
    // The reason is server text and can carry an unbreakable token — the same
    // `wrap-anywhere` every other server string on this panel has, never
    // `break-words` (which does not lower min-content width, and is what put a
    // horizontal scrollbar under this panel once).
    const reason = getByText('the device was offline, so its proxy setting was never cleared')
    expect(reason.className).toContain('wrap-anywhere')
    expect(notice?.outerHTML).not.toContain('break-words')
  })

  test('the on/off banner stops saying a flat "off" while a teardown is owed', async () => {
    const owed = renderWithApi(<NetworkRouteForm deviceId="pc-6" canUse={true} />, {
      '/api/devices/pc-6/network': {
        body: makeStatus({ engine: 'adb-reverse-proxy', config: REVERSE_CONFIG, enabled: false, pendingClear: REVERSE_DEBT }),
      },
    })
    await waitFor(() => expect(owed.getByText('Proxy off here — the phone has not been told')).toBeTruthy())
    expect(owed.queryByText('Proxy off')).toBeNull()
    cleanup()

    // The common case stays exactly as quiet as it was: no notice, and the
    // ordinary off banner back.
    const clean = renderWithApi(<NetworkRouteForm deviceId="pc-7" canUse={true} />, {
      '/api/devices/pc-7/network': {
        body: makeStatus({ engine: 'adb-reverse-proxy', config: REVERSE_CONFIG, enabled: false }),
      },
    })
    await waitFor(() => expect(clean.getByText('Proxy off')).toBeTruthy())
    expect(clean.queryByText('The phone is still carrying this proxy')).toBeNull()
    expect(clean.container.textContent).not.toMatch(/Nothing is required of you/i)
  })
})
