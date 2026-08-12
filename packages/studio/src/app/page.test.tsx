import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { AuthContext, type AuthState } from '@/lib/auth'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * The fleet page (`app/page.tsx`) subscribes to `ws.on` on mount for live
 * device/job updates — no real `WebSocket` in `happy-dom`, so `@/lib/ws` is
 * replaced (also covers `coreBase()`, which every `fetch` on this page
 * reads through, directly or via `@/lib/api`'s helpers).
 */
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { default: Dashboard } = await import('./page')

afterEach(cleanup)

const device = {
  id: 'dev-1',
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06',
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
  connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
}

const baseResponses = {
  // `fetchAllPages` (`@/lib/api`) always appends `?limit=200[&cursor=...]` —
  // the wildcard has to start after the literal `?` so it does not also
  // swallow `/api/devices/discovered` below.
  '/api/devices?*': { body: { items: [device], nextCursor: null, total: 1 } },
  '/api/jobs*': { body: { items: [] } },
  '/api/clusters?*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/devices/discovered': { body: { discovered: [] } },
}

describe('Dashboard (fleet page)', () => {
  test('loaded: renders a card for each device', async () => {
    const { getByText } = renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
  })

  test('loading: shows the loading rows before the devices fetch resolves', () => {
    const { container } = renderWithApi(<Dashboard />, {}, { unmatched: 'pending' })
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed devices fetch shows a named error, not a blank page', async () => {
    // `fetchDevices` (`@/lib/api`, out of this plan's scope) throws a plain
    // `Error` on a non-OK response — not `api()`'s `{error:{code,message}}`
    // unwrapping — so that literal message is what the page's `ErrorState` shows.
    const { getByText } = renderWithApi(<Dashboard />, {
      ...baseResponses,
      '/api/devices?*': { status: 500 },
    })
    await waitFor(() => expect(getByText('GET /api/devices → 500')).toBeTruthy())
  })
})

/**
 * The connection filter (plan 88 §3.1, §4.1, F5) — beside the existing
 * status/tag/cluster/readiness filters, same client-side mechanism (this
 * page never sends any of those to the server either; see the type's own
 * comment on `page.tsx`). `network` is the coarse "everything not on USB"
 * bucket; `otg`/`wifi`/`tcp` are the exact badge values.
 */
describe('Dashboard — connection filter', () => {
  const usbDevice = { ...device, id: 'dev-usb', label: 'usb phone' }
  const otgDevice = {
    ...device,
    id: 'dev-otg',
    label: 'otg phone',
    serial: '10.20.0.37:5555',
    connection: { kind: 'tcp', medium: 'wired', mediumSource: 'network', address: '10.20.0.37', port: 5555, networkLabel: 'Chassis A' },
  }
  const wifiDevice = {
    ...device,
    id: 'dev-wifi',
    label: 'wifi phone',
    serial: '192.168.1.51:5555',
    connection: { kind: 'tcp', medium: 'wireless', mediumSource: 'declared', address: '192.168.1.51', port: 5555, networkLabel: null },
  }
  const responses = {
    ...baseResponses,
    '/api/devices?*': { body: { items: [usbDevice, otgDevice, wifiDevice], nextCursor: null, total: 3 } },
  }

  test('"On the network" keeps every non-USB device and drops the USB one', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('usb phone')).toBeTruthy())
    expect(screen.getByText('otg phone')).toBeTruthy()
    expect(screen.getByText('wifi phone')).toBeTruthy()

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by connection' }))
    fireEvent.click(await screen.findByRole('option', { name: 'On the network' }))

    await waitFor(() => expect(screen.queryByText('usb phone')).toBeNull())
    expect(screen.getByText('otg phone')).toBeTruthy()
    expect(screen.getByText('wifi phone')).toBeTruthy()
  })

  test('"OTG" narrows to exactly the wired-network device, not the Wi-Fi one', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('otg phone')).toBeTruthy())

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by connection' }))
    fireEvent.click(await screen.findByRole('option', { name: 'OTG' }))

    await waitFor(() => expect(screen.queryByText('wifi phone')).toBeNull())
    expect(screen.queryByText('usb phone')).toBeNull()
    expect(screen.getByText('otg phone')).toBeTruthy()
  })
})

/**
 * `device.quarantine` (`packages/core/src/auth/acl.ts`, admin-only) gates
 * `POST /:id/unquarantine` — wired here through `DeviceCard`'s
 * `canReleaseQuarantine` prop (see `DeviceCard.test.tsx` for that prop's own
 * unit tests). This is the integration point: does the dashboard actually
 * compute it from the signed-in user and pass it down.
 */
describe('Dashboard — "Return to queue" reflects device.quarantine (admin-only)', () => {
  const quarantined = { ...device, id: 'dev-2', label: 'quarantined phone', status: 'quarantined', quarantineReason: 'thermal:49.8C' }
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: [quarantined], nextCursor: null, total: 1 } } }

  function authValue(overrides: Partial<AuthState>): AuthState {
    return { user: null, authMode: 'server', setupNeeded: false, refresh: async () => {}, logout: async () => {}, ...overrides }
  }

  test('operator: the button is on screen but disabled', async () => {
    renderWithApi(
      <AuthContext.Provider value={authValue({ user: { id: 'u1', email: 'op@x.com', role: 'operator' } })}>
        <Dashboard />
      </AuthContext.Provider>,
      responses,
    )
    const button = (await waitFor(() => screen.getByRole('button', { name: /return to queue/i }))) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  test('admin: the button is enabled', async () => {
    renderWithApi(
      <AuthContext.Provider value={authValue({ user: { id: 'u1', email: 'admin@x.com', role: 'admin' } })}>
        <Dashboard />
      </AuthContext.Provider>,
      responses,
    )
    const button = (await waitFor(() => screen.getByRole('button', { name: /return to queue/i }))) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  test('local mode (implicit admin): unaffected', async () => {
    renderWithApi(
      <AuthContext.Provider value={authValue({ authMode: 'local', user: { id: 'local-admin', email: 'admin@localhost', role: 'admin' } })}>
        <Dashboard />
      </AuthContext.Provider>,
      responses,
    )
    const button = (await waitFor(() => screen.getByRole('button', { name: /return to queue/i }))) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })
})
