import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { BulkProxyDialog } = await import('./BulkProxyDialog')

afterEach(cleanup)

function makeDevice(id: string, label: string): DeviceInfo {
  return {
    id,
    stableId: id,
    serial: id,
    label,
    androidVersion: '15',
    apiLevel: 35,
    screenW: 720,
    screenH: 1600,
    density: 280,
    status: 'idle',
    lastSeen: 1,
    battery: null,
    quarantineReason: null,
    tags: [],
    cluster: null,
    lastCrashAt: null,
    readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
  }
}

/** A `status` that parses through `DeviceNetworkStatusResponseSchema` — `unverified` is the normal HTTP-rung terminal state, not a failure. */
function appliedStatus(health: 'ok' | 'unverified'): Record<string, unknown> {
  return {
    engine: 'adb-proxy',
    config: { engine: 'adb-proxy', host: 'proxy.example.com', port: 8080 },
    enabled: true,
    observed: null,
    drift: false,
    sessionId: null,
    failClosed: true,
    health,
    checks: [{ id: 'setting', state: 'pass', at: 1 }],
    lastError: null,
    exitHistory: [],
    recovery: null,
    setBy: null,
  }
}

const applied = (deviceId: string, health: 'ok' | 'unverified' = 'unverified') => ({
  deviceId,
  status: appliedStatus(health),
  skip: null,
  error: null,
})
const failedWith = (deviceId: string, code: string, message: string) => ({
  deviceId,
  status: null,
  skip: null,
  error: { code, message },
})
const skippedWith = (deviceId: string, code: string, message: string) => ({
  deviceId,
  status: null,
  skip: { code, message },
  error: null,
})

function fillDirectProxy(r: { getByLabelText: (t: string) => HTMLElement }): void {
  fireEvent.change(r.getByLabelText('Proxy host'), { target: { value: 'proxy.example.com' } })
  fireEvent.change(r.getByLabelText('Proxy port'), { target: { value: '8080' } })
}

/**
 * Plan 114 §3.9, step 114.8 — the report is the point of the step.
 * `docs/design.md`: *"a number that cannot be expanded into a device list is
 * not a real report — it is a rumour."*
 */
describe('BulkProxyDialog — the report (plan 114 §3.9)', () => {
  test('forty devices with three distinct reasons render as three groups, failures first, each expanding to named devices', async () => {
    const devices = Array.from({ length: 40 }, (_, i) => makeDevice(`d${i + 1}`, `Phone ${String(i + 1).padStart(2, '0')}`))
    const results = [
      ...['d1', 'd2', 'd3'].map((id) =>
        failedWith(id, 'E_SETTING_NOT_ACCEPTED', 'the device reads back :0 rather than proxy.example.com:8080'),
      ),
      ...['d4', 'd5'].map((id) => skippedWith(id, 'E_DEVICE_OFFLINE', 'the phone is not reachable; the route is saved')),
      skippedWith('d6', 'E_AGENT_NOT_READY', 'the guest agent is absent on this phone'),
      ...devices.slice(6).map((d) => applied(d.id, 'ok')),
    ]

    const r = renderWithApi(<BulkProxyDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/devices/network/apply': { body: { total: results.length, results } },
    })

    fillDirectProxy(r)
    fireEvent.click(r.getByText('Apply to 40 devices'))

    await waitFor(() => expect(r.getByText('34 ok · 3 failed · 3 skipped (40/40)')).toBeTruthy())

    const groups = Array.from(r.baseElement.querySelectorAll('[data-testid="skipped-groups"] > li'))
    expect(groups).toHaveLength(3)
    // Failures first — `SkippedGroups` renders `failed` before `skipped`.
    // `capitalize` is a CSS class — the DOM text is the raw kind.
    expect(groups[0]?.textContent).toContain('failed')
    expect(groups[0]?.textContent).toContain('The phone declined the setting')
    expect(groups[1]?.textContent).toContain('skipped')
    expect(groups[1]?.textContent).toContain('Offline')
    expect(groups[2]?.textContent).toContain('skipped')
    expect(groups[2]?.textContent).toContain('Guest agent not ready')

    // Every count expands into the devices behind it.
    expect(r.queryAllByText('Phone 01')).toHaveLength(0)
    fireEvent.click(groups[0]?.querySelector('button') as HTMLButtonElement)
    await waitFor(() => expect(r.getByText('Phone 01')).toBeTruthy())
    expect(r.getByText('Phone 02')).toBeTruthy()
    expect(r.getByText('Phone 03')).toBeTruthy()
  })

  test('an applied-but-unverified device is not a failure, and the report says what was and was not proven', async () => {
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    const results = [applied('d1', 'unverified'), applied('d2', 'unverified')]

    const r = renderWithApi(<BulkProxyDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/devices/network/apply': { body: { total: 2, results } },
    })
    fillDirectProxy(r)
    fireEvent.click(r.getByText('Apply to 2 devices'))

    await waitFor(() => expect(r.getByText('2 ok · 0 failed · 0 skipped (2/2)')).toBeTruthy())
    const text = r.baseElement.textContent ?? ''
    expect(text).toContain('applied, not confirmed')
    expect(text).toContain('which is not a failure')
    expect(text).toContain(
      'A proxy is set on this phone. Apps that honour the system proxy will use it; an app with its own networking can ignore it, and nothing here can tell you which did. For traffic an app cannot escape, use VPN mode.',
    )
    // Nothing landed in the failed column.
    expect(r.baseElement.querySelector('[data-testid="skipped-groups"]')).toBeNull()
  })
})

describe('BulkProxyDialog — the wording (plan 114 §3.1 rule 1, risk 1)', () => {
  test('both mode sentences render verbatim, about N devices, from the one shared source', () => {
    const devices = [makeDevice('d1', 'Phone A')]
    const { getByText } = renderWithApi(<BulkProxyDialog open devices={devices} onOpenChange={() => {}} />, {})
    expect(
      getByText(
        'Apps can ignore this. WebView and many HTTP libraries use it; an app with its own networking does not, and nothing on the phone stops it.',
      ),
    ).toBeTruthy()
    expect(getByText('Apps cannot opt out of this. Needs the Enkaku guest agent installed on the phone.')).toBeTruthy()
  })

  test('the advisory sentence is on screen before anything is applied', () => {
    const devices = [makeDevice('d1', 'Phone A')]
    const { getByText } = renderWithApi(<BulkProxyDialog open devices={devices} onOpenChange={() => {}} />, {})
    expect(
      getByText(
        'A proxy is set on this phone. Apps that honour the system proxy will use it; an app with its own networking can ignore it, and nothing here can tell you which did. For traffic an app cannot escape, use VPN mode.',
      ),
    ).toBeTruthy()
  })

  test('choosing VPN states that an agent-less phone is skipped and named, never given an HTTP proxy instead', () => {
    const devices = [makeDevice('d1', 'Phone A')]
    const { baseElement } = renderWithApi(<BulkProxyDialog open devices={devices} onOpenChange={() => {}} />, {})
    fireEvent.click(baseElement.querySelector('#bulk-proxy-mode-vpn') as HTMLInputElement)
    const text = baseElement.textContent ?? ''
    expect(text).toContain('VPN mode needs the Enkaku guest agent on each phone.')
    expect(text).toContain('skipped and named below')
    expect(text).toContain('it is never given an HTTP proxy instead')
  })
})

describe('BulkProxyDialog — the paste parser refuses a credential here too (plan 114 §3.8)', () => {
  test('http://user:pass@host:8080 is refused, and the refusal names the farm rung and VPN mode', () => {
    const devices = [makeDevice('d1', 'Phone A')]
    const { getByLabelText, getByText } = renderWithApi(
      <BulkProxyDialog open devices={devices} onOpenChange={() => {}} />,
      {},
    )
    fireEvent.change(getByLabelText('Paste an http://host:port address to fill the fields below'), {
      target: { value: 'http://user:pass@proxy.example.com:8080' },
    })
    fireEvent.click(getByText('Fill fields'))
    expect(
      getByText(
        'That address carries a username and password. Android’s system proxy setting is host:port — there is nowhere to put an account, and every app on the phone can read it. To use a proxy that needs an account, run it on this farm’s machine, or use VPN mode.',
      ),
    ).toBeTruthy()
  })

  test('a refused paste fills nothing — the host and port fields stay as the operator left them', () => {
    const devices = [makeDevice('d1', 'Phone A')]
    const r = renderWithApi(<BulkProxyDialog open devices={devices} onOpenChange={() => {}} />, {})
    fillDirectProxy(r)
    fireEvent.change(r.getByLabelText('Paste an http://host:port address to fill the fields below'), {
      target: { value: 'http://user:pass@other.example.com:3128' },
    })
    fireEvent.click(r.getByText('Fill fields'))
    expect((r.getByLabelText('Proxy host') as HTMLInputElement).value).toBe('proxy.example.com')
    expect((r.getByLabelText('Proxy port') as HTMLInputElement).value).toBe('8080')
  })
})
