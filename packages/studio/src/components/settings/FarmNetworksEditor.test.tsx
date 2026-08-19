import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

/**
 * `useAction`'s built-in failure toast (`packages/ui/src/lib/actions.ts`) is
 * how `E_SCAN_BUSY`/`E_SCAN_UNAVAILABLE` reach the operator — captured here
 * so the "Scan network" tests below can assert the two refusals actually
 * read differently, not just that something red appeared. Same pattern
 * `AdmitDeviceDialog.test.tsx` already established for capturing `sonner`.
 */
const toastErrorCalls: Array<{ title: string; description?: string }> = []
mock.module('sonner', () => ({
  toast: {
    success: () => {},
    error: (title: string, opts?: { description?: string }) => toastErrorCalls.push({ title, description: opts?.description }),
    warning: () => {},
  },
  Toaster: () => null,
}))

const { FarmNetworksEditor } = await import('./FarmNetworksEditor')

afterEach(() => {
  cleanup()
  toastErrorCalls.length = 0
})

const DISCOVERY_BASE = {
  scanIntervalSec: 10,
  offlineGraceSec: 20,
  recoveryCooldownSec: 120,
  tcpPort: 5555,
  endpointsPerDevice: 4,
  endpointRetireAfter: 10,
  connectSettleMs: 3_000,
  scan: { mode: 'on-demand' as const, maxAddresses: 1024, concurrency: 32, probeTimeoutMs: 300 },
}

function settingsGet(networks: Array<{ cidr: string; label: string; medium: 'wired' | 'wireless'; scan: boolean }>, maxAddresses = 1024) {
  return {
    settings: { discovery: { ...DISCOVERY_BASE, networks, scan: { ...DISCOVERY_BASE.scan, maxAddresses } } },
    schema: {},
    deviceSchema: {},
  }
}

describe('FarmNetworksEditor — loading, error (plan 88 §5 step 88.6)', () => {
  test('loading: shows a busy skeleton while /api/settings is in flight', () => {
    renderWithApi(<FarmNetworksEditor />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed fetch shows a named, retryable error', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'settings boom' } } },
    })
    await waitFor(() => expect(screen.getByText('settings boom')).toBeTruthy())
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
  })
})

describe('FarmNetworksEditor — empty state (the case that matters most)', () => {
  test('no networks configured: says the sweep cannot run, not just "no rows"', async () => {
    renderWithApi(<FarmNetworksEditor />, { '/api/settings': { body: settingsGet([]) } })
    await waitFor(() => expect(screen.getByText(/the sweep cannot run/i)).toBeTruthy())
    expect(screen.getByText(/10\.20\.0\.0\/24/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /add a network/i })).toBeTruthy()
    // No table is rendered in the empty state.
    expect(screen.queryByRole('table')).toBeNull()
  })

  test('the medium claim is stated plainly, not just implied by the column header', async () => {
    renderWithApi(<FarmNetworksEditor />, { '/api/settings': { body: settingsGet([]) } })
    await waitFor(() => expect(screen.getByText(/the sweep cannot run/i)).toBeTruthy())
    expect(screen.getByText(/a claim you are making, not something enkaku measured/i)).toBeTruthy()
    expect(screen.getByText(/adb cannot tell a switch port from a radio/i)).toBeTruthy()
  })

  test('clicking "Add a network" from the empty state opens one editable row', async () => {
    renderWithApi(<FarmNetworksEditor />, { '/api/settings': { body: settingsGet([]) } })
    await waitFor(() => expect(screen.getByText(/the sweep cannot run/i)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add a network/i }))
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
    expect(screen.getByLabelText('Network 1 CIDR')).toBeTruthy()
  })
})

describe('FarmNetworksEditor — live per-row count and running total', () => {
  test('a configured /24 shows its address count (256, including network+broadcast — the same figure the ceiling counts, per addressCount())', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
    })
    await waitFor(() => expect(screen.getByLabelText('Network 1 CIDR')).toBeTruthy())
    expect(screen.getByText('256')).toBeTruthy()
    expect(screen.getByText(/256 \/ 1,024 addresses in the sweep/)).toBeTruthy()
  })

  test('typing an invalid CIDR shows the inline error and dims the count, without waiting for Save', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: '', medium: 'wired', scan: true }]) },
    })
    const cidrInput = await screen.findByLabelText('Network 1 CIDR')
    fireEvent.change(cidrInput, { target: { value: 'not-a-cidr' } })
    await waitFor(() => expect(screen.getByText(/must be an IPv4 CIDR/)).toBeTruthy())
    // Save is disabled while a row is invalid. `toBeDisabled()` (jest-dom) is
    // not wired up for this workspace's test setup — read the DOM property.
    expect((screen.getByRole('button', { name: 'Save networks' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('four /24s ticked for scan sum to exactly 1,024 — the ceiling default', async () => {
    const networks = Array.from({ length: 4 }, (_, i) => ({ cidr: `10.${i}.0.0/24`, label: '', medium: 'wired' as const, scan: true }))
    renderWithApi(<FarmNetworksEditor />, { '/api/settings': { body: settingsGet(networks) } })
    await waitFor(() => expect(screen.getByText(/1,024 \/ 1,024 addresses in the sweep/)).toBeTruthy())
  })

  test('a network with "Include in a sweep" off does not count toward the total', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/16', label: '', medium: 'wired', scan: false }]) },
    })
    await waitFor(() => expect(screen.getByText(/0 \/ 1,024 addresses in the sweep/)).toBeTruthy())
  })

  test('over the ceiling: the total turns to the danger state, names what to do, and disables Save', async () => {
    // Seeded at exactly the ceiling (four /24s = 1,024, itself a VALID saved
    // state — `FarmSettingsSchema`'s own cross-field refinement would reject
    // anything already over it, so a mock GET response cannot represent an
    // over-ceiling state; only a fifth row added live, client-side, can.
    const networks = Array.from({ length: 4 }, (_, i) => ({ cidr: `10.${i}.0.0/24`, label: '', medium: 'wired' as const, scan: true }))
    renderWithApi(<FarmNetworksEditor />, { '/api/settings': { body: settingsGet(networks) } })
    await waitFor(() => expect(screen.getByText(/1,024 \/ 1,024 addresses in the sweep/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Add a network' }))
    const fifthCidr = await screen.findByLabelText('Network 5 CIDR')
    fireEvent.change(fifthCidr, { target: { value: '10.4.0.0/24' } })

    await waitFor(() => expect(screen.getByText(/1,280 \/ 1,024 addresses in the sweep/)).toBeTruthy())
    expect(screen.getByText(/over the limit/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save networks' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('FarmNetworksEditor — editing and saving', () => {
  test('Save PATCHes only discovery.networks, trimmed, and reloads from the response', async () => {
    const { apiMock } = renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': ({ method }) =>
        method === 'PATCH'
          ? { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]).settings }
          : { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
    })
    const cidrInput = await screen.findByLabelText('Network 1 CIDR')
    // A saved value is already schema-valid (trimmed) — surrounding
    // whitespace only ever enters through what an operator TYPES, so that is
    // simulated here rather than in the mocked GET response.
    fireEvent.change(cidrInput, { target: { value: '10.20.0.0/24 ' } })
    fireEvent.change(screen.getByLabelText('Network 1 label'), { target: { value: ' Chassis A ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save networks' }))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PATCH' && c.path === '/api/settings')).toBe(true))
    const patch = apiMock.calls.find((c) => c.method === 'PATCH' && c.path === '/api/settings')
    expect(patch?.body).toEqual({ discovery: { networks: [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }] } })
  })

  test('removing the only row goes back to the empty state', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: '', medium: 'wired', scan: true }]) },
    })
    await waitFor(() => expect(screen.getByLabelText('Network 1 CIDR')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Remove network 1' }))
    await waitFor(() => expect(screen.getByText(/the sweep cannot run/i)).toBeTruthy())
  })

  test('changing a row\'s medium to Wi-Fi updates the select without touching other rows', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: '', medium: 'wired', scan: true }]) },
    })
    await waitFor(() => expect(screen.getByLabelText('Network 1 CIDR')).toBeTruthy())
    fireEvent.click(screen.getByRole('combobox', { name: 'Network 1 medium' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Wi-Fi' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Network 1 medium' }).textContent).toContain('Wi-Fi'))
  })
})

/**
 * "Scan network" (plan 88 §3.5, §4.5, §4.6, §5 step 88.12) — this closes the
 * real gap the plan's own step 88.3/88.4 status notes incorrectly claimed
 * was already closed: `POST /api/devices/scan` (the bounded subnet sweep)
 * had no Studio call site at all until this button. Shares
 * `packages/studio/src/lib/network-scan.ts` with the Devices page's own
 * fleet-menu "Scan network" item — see `page.test.tsx`'s sibling describe
 * block for that one.
 */
describe('FarmNetworksEditor — Scan network (plan 88 §5 step 88.12)', () => {
  test('no networks configured: the button is visibly disabled with the same reason as the empty state, not a click that fails afterward', async () => {
    renderWithApi(<FarmNetworksEditor />, { '/api/settings': { body: settingsGet([]) } })
    await waitFor(() => expect(screen.getByText(/the sweep cannot run/i)).toBeTruthy())
    const button = screen.getByRole('button', { name: 'Scan network' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('No networks configured — the sweep cannot run')
  })

  test('networks configured but none included in a sweep: disabled with a distinct reason', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: false }]) },
    })
    await waitFor(() => expect(screen.getByLabelText('Network 1 CIDR')).toBeTruthy())
    const button = screen.getByRole('button', { name: 'Scan network' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toMatch(/include in a sweep/i)
  })

  test('a scannable network enables the button; a successful scan renders the real counts, not a generic "done"', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
      '/api/devices/scan': {
        body: {
          networks: [{ cidr: '10.20.0.0/24', label: 'Chassis A', addresses: 256 }],
          scanned: 254,
          skipped: 2,
          answered: 3,
          connected: 3,
          identified: 3,
          adopted: ['SER1'],
          discovered: ['SER2'],
          conflicts: [],
          durationMs: 1200,
        },
      },
    })
    await waitFor(() => expect(screen.getByLabelText('Network 1 CIDR')).toBeTruthy())
    const button = screen.getByRole('button', { name: 'Scan network' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)

    fireEvent.click(button)
    await waitFor(() =>
      expect(screen.getByText('Swept 10.20.0.0/24 · 254 scanned · 3 answered · 1 reconnected · 1 newly discovered')).toBeTruthy(),
    )
  })

  test('E_SCAN_BUSY surfaces as "a scan is already running", not a generic failure', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
      '/api/devices/scan': { status: 409, body: { error: { code: 'E_SCAN_BUSY', message: 'a sweep is already running — wait for it to finish before starting another' } } },
    })
    const button = await screen.findByRole('button', { name: 'Scan network' })
    fireEvent.click(button)

    await waitFor(() => expect(toastErrorCalls.length).toBe(1))
    expect(toastErrorCalls[0]?.description).toBe('a sweep is already running — wait for it to finish before starting another')
    // The button returns to its idle label rather than sticking on "Scanning…".
    expect(screen.getByRole('button', { name: 'Scan network' })).toBeTruthy()
  })

  test('E_SCAN_UNAVAILABLE surfaces its own distinct wording, different from E_SCAN_BUSY', async () => {
    renderWithApi(<FarmNetworksEditor />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
      '/api/devices/scan': { status: 409, body: { error: { code: 'E_SCAN_UNAVAILABLE', message: 'network scanning is turned off (discovery.scan.mode) — turn it on in Settings to sweep' } } },
    })
    const button = await screen.findByRole('button', { name: 'Scan network' })
    fireEvent.click(button)

    await waitFor(() => expect(toastErrorCalls.length).toBe(1))
    expect(toastErrorCalls[0]?.description).toBe('network scanning is turned off (discovery.scan.mode) — turn it on in Settings to sweep')
  })
})
