import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

const toastCalls: { success: string[]; errors: Array<{ title: string; description?: string }> } = { success: [], errors: [] }
mock.module('sonner', () => ({
  toast: {
    success: (title: string) => toastCalls.success.push(title),
    error: (title: string, opts?: { description?: string }) => toastCalls.errors.push({ title, description: opts?.description }),
    warning: () => {},
  },
  Toaster: () => null,
}))

const { ScanNetworkDialog } = await import('./ScanNetworkDialog')

afterEach(() => {
  cleanup()
  toastCalls.success.length = 0
  toastCalls.errors.length = 0
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

function settingsGet(networks: Array<{ cidr: string; label: string; medium: 'wired' | 'wireless'; scan: boolean }>, tcpPort = 5555, maxAddresses = 1024) {
  return {
    settings: { discovery: { ...DISCOVERY_BASE, tcpPort, networks, scan: { ...DISCOVERY_BASE.scan, maxAddresses } } },
    schema: {},
    deviceSchema: {},
  }
}

const SWEEP_BODY = {
  networks: [{ cidr: '10.20.0.0/24', label: 'Chassis A', addresses: 256, port: 5555 }],
  scanned: 254,
  skipped: 0,
  answered: 1,
  connected: 1,
  identified: 1,
  adopted: [],
  discovered: ['SER9'],
  conflicts: [],
  durationMs: 900,
}

describe('ScanNetworkDialog — loading and the port field', () => {
  test('the port field loads the real farm-wide discovery.tcpPort', async () => {
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': { body: settingsGet([], 6060) },
    })
    await waitFor(() => expect((screen.getByLabelText('adb TCP port') as HTMLInputElement).value).toBe('6060'))
  })

  test('empty state: "No ranges yet", with Add a range immediately visible — no navigation, no disabled dead end', async () => {
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, { '/api/settings': { body: settingsGet([]) } })
    await waitFor(() => expect(screen.getByText('No ranges yet')).toBeTruthy())
    expect(screen.getByRole('button', { name: /add a range/i })).toBeTruthy()
    // No Save/Scan all buttons yet — nothing to act on.
    expect(screen.queryByRole('button', { name: 'Scan all' })).toBeNull()
  })
})

describe('ScanNetworkDialog — adding, editing, removing a range and saving', () => {
  test('adding a range, filling it in, and saving PATCHes both networks and tcpPort', async () => {
    const { apiMock } = renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': ({ method }) => (method === 'PATCH' ? { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) } : { body: settingsGet([]) }),
    })
    await waitFor(() => expect(screen.getByText('No ranges yet')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add a range/i }))

    const startInput = await screen.findByLabelText('Range 1 start IP')
    fireEvent.change(startInput, { target: { value: '10.20.0.0' } })
    fireEvent.change(screen.getByLabelText('Range 1 end IP'), { target: { value: '10.20.0.255' } })
    fireEvent.change(screen.getByLabelText('Range 1 label'), { target: { value: 'Chassis A' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PATCH' && c.path === '/api/settings')).toBe(true))
    const patch = apiMock.calls.find((c) => c.method === 'PATCH' && c.path === '/api/settings')
    expect(patch?.body).toEqual({ discovery: { networks: [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }], tcpPort: 5555 } })
  })

  test('editing the port alone (no row changes) still saves, patching the new port with the unchanged networks', async () => {
    const existing = [{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired' as const, scan: true }]
    const { apiMock } = renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': ({ method }) => (method === 'PATCH' ? { body: settingsGet(existing, 6060) } : { body: settingsGet(existing, 5555) }),
    })
    await waitFor(() => expect((screen.getByLabelText('adb TCP port') as HTMLInputElement).value).toBe('5555'))
    fireEvent.change(screen.getByLabelText('adb TCP port'), { target: { value: '6060' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PATCH' && c.path === '/api/settings')).toBe(true))
    const patch = apiMock.calls.find((c) => c.method === 'PATCH' && c.path === '/api/settings')
    expect(patch?.body).toEqual({ discovery: { networks: existing, tcpPort: 6060 } })
  })

  test('an invalid port disables Save and Scan all, with a stated reason', async () => {
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'A', medium: 'wired', scan: true }]) },
    })
    await waitFor(() => expect(screen.getByLabelText('adb TCP port')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('adb TCP port'), { target: { value: '80' } })
    await waitFor(() => expect(screen.getByText(/must be a whole number between 1024 and 65535/)).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Scan all' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('a range spanning multiple stored CIDRs loads and edits as ONE row, rewriting exactly its own CIDR set', async () => {
    const networks = [
      { cidr: '10.20.0.10/31', label: 'Chassis B', medium: 'wireless' as const, scan: true },
      { cidr: '10.20.0.12/30', label: 'Chassis B', medium: 'wireless' as const, scan: true },
      { cidr: '10.20.0.16/32', label: 'Chassis B', medium: 'wireless' as const, scan: true },
    ]
    const { apiMock } = renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': ({ method }) => (method === 'PATCH' ? { body: settingsGet(networks) } : { body: settingsGet(networks) }),
    })
    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())
    expect(screen.queryByLabelText('Range 2 start IP')).toBeNull()
    expect((screen.getByLabelText('Range 1 start IP') as HTMLInputElement).value).toBe('10.20.0.10')
    expect((screen.getByLabelText('Range 1 end IP') as HTMLInputElement).value).toBe('10.20.0.16')

    fireEvent.change(screen.getByLabelText('Range 1 label'), { target: { value: 'Chassis B (relabelled)' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PATCH' && c.path === '/api/settings')).toBe(true))
    const patch = apiMock.calls.find((c) => c.method === 'PATCH' && c.path === '/api/settings')
    const patched = (patch?.body as { discovery: { networks: Array<{ cidr: string; label: string }> } }).discovery.networks
    expect(patched.map((n) => n.cidr).sort()).toEqual(networks.map((n) => n.cidr).sort())
    expect(patched.every((n) => n.label === 'Chassis B (relabelled)')).toBe(true)
  })

  test('removing the only row goes back to the empty state', async () => {
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: '', medium: 'wired', scan: true }]) },
    })
    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Remove range 1' }))
    await waitFor(() => expect(screen.getByText('No ranges yet')).toBeTruthy())
  })
})

describe('ScanNetworkDialog — the budget readout', () => {
  test('four /24-equivalent ranges ticked for scan sum to exactly 1,024', async () => {
    const networks = Array.from({ length: 4 }, (_, i) => ({ cidr: `10.${i}.0.0/24`, label: '', medium: 'wired' as const, scan: true }))
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, { '/api/settings': { body: settingsGet(networks) } })
    await waitFor(() => expect(screen.getByText(/1,024 \/ 1,024 addresses in the sweep/)).toBeTruthy())
  })

  test('over the ceiling disables Save and Scan all', async () => {
    const networks = Array.from({ length: 4 }, (_, i) => ({ cidr: `10.${i}.0.0/24`, label: '', medium: 'wired' as const, scan: true }))
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, { '/api/settings': { body: settingsGet(networks) } })
    await waitFor(() => expect(screen.getByText(/1,024 \/ 1,024 addresses in the sweep/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Add a range' }))
    const fifthStart = await screen.findByLabelText('Range 5 start IP')
    fireEvent.change(fifthStart, { target: { value: '10.4.0.0' } })
    fireEvent.change(screen.getByLabelText('Range 5 end IP'), { target: { value: '10.4.0.255' } })

    await waitFor(() => expect(screen.getByText(/1,280 \/ 1,024 addresses in the sweep/)).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Scan all' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ScanNetworkDialog — "Scan all" (the owner\'s own request: "ada tombol langsung scan all nya")', () => {
  test('nothing unsaved: "Scan all" scans directly, with no PATCH, and renders the real SweepReport counts', async () => {
    const { apiMock } = renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} onScanned={() => {}} />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
      '/api/devices/scan': { body: SWEEP_BODY },
    })
    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Scan all' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/devices/scan')).toBe(true))
    expect(apiMock.calls.some((c) => c.method === 'PATCH' && c.path === '/api/settings')).toBe(false)
    await waitFor(() => expect(screen.getByText('Swept 10.20.0.0/24 · 254 scanned · 1 answered · 1 newly discovered')).toBeTruthy())
  })

  test('unsaved edits: "Scan all" saves first, then scans, in one click', async () => {
    const { apiMock } = renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': ({ method }) => (method === 'PATCH' ? { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) } : { body: settingsGet([]) }),
      '/api/devices/scan': { body: SWEEP_BODY },
    })
    await waitFor(() => expect(screen.getByText('No ranges yet')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add a range/i }))
    fireEvent.change(await screen.findByLabelText('Range 1 start IP'), { target: { value: '10.20.0.0' } })
    fireEvent.change(screen.getByLabelText('Range 1 end IP'), { target: { value: '10.20.0.255' } })

    const scanAllButton = await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Scan all' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
      return btn
    })
    fireEvent.click(scanAllButton)

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PATCH' && c.path === '/api/settings')).toBe(true))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/devices/scan')).toBe(true))
    // Saved BEFORE scanned.
    const patchIdx = apiMock.calls.findIndex((c) => c.method === 'PATCH' && c.path === '/api/settings')
    const scanIdx = apiMock.calls.findIndex((c) => c.method === 'POST' && c.path === '/api/devices/scan')
    expect(patchIdx).toBeGreaterThanOrEqual(0)
    expect(scanIdx).toBeGreaterThan(patchIdx)
  })

  test('onScanned fires with the real report, for the caller\'s own refetch', async () => {
    let received: unknown = null
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} onScanned={(r) => (received = r)} />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
      '/api/devices/scan': { body: SWEEP_BODY },
    })
    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Scan all' }))
    await waitFor(() => expect(received).not.toBeNull())
    expect((received as { discovered: string[] }).discovered).toEqual(['SER9'])
  })

  test('no scannable range and nothing unsaved: "Scan all" is disabled with the same reason FarmNetworksEditor\'s button uses', async () => {
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: false }]) },
    })
    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())
    const button = screen.getByRole('button', { name: 'Scan all' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toMatch(/include in a sweep/i)
  })

  test('E_SCAN_BUSY surfaces the server\'s own message via the failure toast', async () => {
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
      '/api/devices/scan': { status: 409, body: { error: { code: 'E_SCAN_BUSY', message: 'a sweep is already running — wait for it to finish before starting another' } } },
    })
    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Scan all' }))
    await waitFor(() => expect(toastCalls.errors.length).toBe(1))
    expect(toastCalls.errors[0]?.description).toBe('a sweep is already running — wait for it to finish before starting another')
  })
})

/**
 * The dialog-overflow fix (owner-reported, verified this session by direct
 * in-browser measurement: `dialog clientWidth: 510px, scrollWidth: 795px`
 * with one range row added — the DIALOG ITSELF was overflowing, not just
 * its intended internal scroller).
 *
 * happy-dom (this test environment) does not run a real layout/paint
 * engine — `getBoundingClientRect()`/`scrollWidth`/`clientWidth` are not
 * meaningfully populated here, so a width-based assertion ("dialog.scrollWidth
 * === dialog.clientWidth") would not actually exercise the CSS Grid
 * min-content-bubbling bug this fix addresses; it would just always read
 * 0 === 0 and pass regardless of whether the fix is present. The real
 * verification for that (documented in this session's own report) was done
 * against the live dev server in a real browser, before and after the fix,
 * with the exact numbers above. What this test CAN meaningfully assert in
 * this environment: the specific CSS class that is the actual fix
 * (`min-w-0` on `DialogContent`'s direct grid-item child — see that div's
 * own header comment in `ScanNetworkDialog.tsx` for the full mechanism) is
 * present, and that the table still lives inside its own dedicated
 * `overflow-x-auto` scroll container (`RangeNetworksFields.tsx`) rather
 * than the fix having been "solved" by widening `DialogContent` instead
 * (which would leave this class absent).
 */
describe('ScanNetworkDialog — dialog-level overflow fix (min-w-0 on the grid-item ancestor)', () => {
  test('the direct child of DialogContent carries min-w-0, and the range table still has its own overflow-x-auto scroller, with 2+ rows and the new Port column present', async () => {
    const networks = [
      { cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired' as const, scan: true },
      { cidr: '10.21.0.0/24', label: 'Chassis B', medium: 'wireless' as const, scan: true },
    ]
    renderWithApi(<ScanNetworkDialog open onOpenChange={() => {}} />, { '/api/settings': { body: settingsGet(networks) } })
    await waitFor(() => expect(screen.getByLabelText('Range 2 start IP')).toBeTruthy())

    // The new Port column (plan 88 §9 Q7) is present — the exact thing that
    // makes the table wider and this bug worse, per the task's own note.
    expect(screen.getByLabelText('Range 1 port (optional override)')).toBeTruthy()
    expect(screen.getByLabelText('Range 2 port (optional override)')).toBeTruthy()

    // `getByRole('dialog')` returns `DialogContent` itself — Radix sets
    // `role="dialog"` directly on that element (confirmed by inspecting the
    // rendered markup), the same element `@enkaku/ui`'s `dialog.tsx` makes
    // `display: grid`.
    const content = screen.getByRole('dialog')
    expect(content.getAttribute('data-slot')).toBe('dialog-content')

    // Its direct child wrapping the port field + range table is the exact
    // grid item whose default `min-width: auto` was letting the table's
    // intrinsic width bubble up and grow the dialog itself — `:scope >`
    // requires it to be a DIRECT child, not merely a descendant, since only
    // a direct child of a grid container is a grid item at all.
    const gridItem = Array.from(content.children).find((el) => el.classList.contains('min-w-0'))
    expect(gridItem).toBeTruthy()

    // The table's own scroll container is still the ONE place horizontal
    // overflow is meant to live (docs/design.md) — untouched by this fix,
    // confirming the fix did not "solve" the bug by removing the intended
    // internal scroller or by widening DialogContent instead.
    const scroller = content.querySelector('.overflow-x-auto')
    expect(scroller).toBeTruthy()
    expect(scroller?.querySelector('table')).toBeTruthy()

    // `DialogContent` itself was NOT widened past its own `max-w-3xl` as a
    // substitute fix — the class is still exactly what it was.
    expect(content.className).toContain('max-w-3xl')
  })
})

describe('ScanNetworkDialog — Close', () => {
  test('Close calls onOpenChange(false) without saving or scanning', async () => {
    let openState = true
    const onOpenChange = (v: boolean) => {
      openState = v
    }
    const { apiMock } = renderWithApi(<ScanNetworkDialog open onOpenChange={onOpenChange} />, {
      '/api/settings': { body: settingsGet([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
    })
    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())
    // Two elements share the accessible name "Close": this dialog's own
    // footer button, and Radix's default top-right X (sr-only "Close" text)
    // — pick the footer one by excluding the dialog's built-in close control.
    const closeButtons = screen.getAllByRole('button', { name: 'Close' })
    const footerClose = closeButtons.find((b) => b.getAttribute('data-slot') !== 'dialog-close')!
    fireEvent.click(footerClose)
    expect(openState).toBe(false)
    expect(apiMock.calls.some((c) => c.method !== 'GET')).toBe(false)
  })
})
