import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import '@/lib/test/nav'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { DeviceCard } from './DeviceCard'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const BASE_DEVICE: DeviceInfo = {
  id: 'd1',
  stableId: 'stable-1',
  serial: 'emulator-5554',
  label: 'moto g06 power',
  androidVersion: '14',
  apiLevel: 34,
  screenW: 1080,
  screenH: 2400,
  density: 420,
  status: 'quarantined',
  lastSeen: 1_700_000_000,
  battery: null,
  quarantineReason: 'thermal:49.8C',
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 1_700_000_000 },
  connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
}

/**
 * `canReleaseQuarantine` (`device.quarantine`, admin-only in
 * `packages/core/src/auth/acl.ts`) — the fleet card keeps "Return to queue"
 * on screen either way (so an operator can see the way out exists) and only
 * disables it, with a reason, when the caller says the signed-in user is
 * not allowed to use it. The server refuses the same call regardless of
 * what this prop is — see the prop's own doc comment.
 */
describe('DeviceCard — quarantine release', () => {
  test('canReleaseQuarantine omitted (every caller before this task) defaults to enabled', () => {
    const onReleaseQuarantine = mock(() => {})
    renderWithApi(<DeviceCard device={BASE_DEVICE} onReleaseQuarantine={onReleaseQuarantine} />)
    const button = screen.getByRole('button', { name: /return to queue/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onReleaseQuarantine).toHaveBeenCalledTimes(1)
  })

  test('canReleaseQuarantine=true (admin): the button is enabled and clickable', () => {
    const onReleaseQuarantine = mock(() => {})
    renderWithApi(<DeviceCard device={BASE_DEVICE} onReleaseQuarantine={onReleaseQuarantine} canReleaseQuarantine={true} />)
    const button = screen.getByRole('button', { name: /return to queue/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  test('canReleaseQuarantine=false (operator): the button stays on screen, disabled, with a reason — not hidden', () => {
    const onReleaseQuarantine = mock(() => {})
    renderWithApi(<DeviceCard device={BASE_DEVICE} onReleaseQuarantine={onReleaseQuarantine} canReleaseQuarantine={false} />)
    const button = screen.getByRole('button', { name: /return to queue/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title.length).toBeGreaterThan(0)
    fireEvent.click(button)
    expect(onReleaseQuarantine).not.toHaveBeenCalled()
  })

  test('the reason text and quarantine explanation are shown regardless of role', () => {
    renderWithApi(<DeviceCard device={BASE_DEVICE} onReleaseQuarantine={() => {}} canReleaseQuarantine={false} />)
    expect(screen.getByText(/temperature reached 49.8°C/i)).toBeTruthy()
  })
})

/**
 * F27: the card used to print the raw adb `serial` unlabelled — for a TCP
 * device that happened to look like an address, for USB like nothing anyone
 * but adb could read. It is now a badge plus the real address (plan 88 §3.1,
 * §4.1, §4.9).
 */
describe('DeviceCard — connection (plan 88 §3.1, §4.1, F27)', () => {
  test('a usb device shows the USB badge and falls back to the adb serial (no network address exists)', () => {
    const { container } = renderWithApi(<DeviceCard device={BASE_DEVICE} />)
    expect(container.textContent).toContain('USB')
    expect(screen.getByText('emulator-5554')).toBeTruthy()
  })

  test('a tcp device shows its badge and the real address, not the raw host:port serial', () => {
    const tcpDevice: DeviceInfo = {
      ...BASE_DEVICE,
      serial: '10.20.0.37:5555',
      connection: { kind: 'tcp', medium: 'wired', mediumSource: 'network', address: '10.20.0.37', port: 5555, networkLabel: 'Chassis A' },
    }
    const { container } = renderWithApi(<DeviceCard device={tcpDevice} />)
    expect(container.textContent).toContain('OTG')
    expect(screen.getByText('10.20.0.37')).toBeTruthy()
    // The port and the raw host:port serial are in the tooltip, not printed twice on the card.
    expect(screen.queryByText('10.20.0.37:5555')).toBeNull()
  })

  test('a tcp device with an unresolved medium reads TCP, never a guessed WI-FI', () => {
    const unknownDevice: DeviceInfo = {
      ...BASE_DEVICE,
      serial: '192.168.1.51:5555',
      connection: { kind: 'tcp', medium: null, mediumSource: 'unknown', address: '192.168.1.51', port: 5555, networkLabel: null },
    }
    const { container } = renderWithApi(<DeviceCard device={unknownDevice} />)
    expect(container.textContent).toContain('TCP')
    expect(container.textContent).not.toContain('WI-FI')
  })
})

/**
 * The guest-agent alert chip (plan 90 §5 step 90.6, fixes F10) — quiet for
 * the common case, since a farm of 20 healthy phones must not grow 20
 * chips. `BASE_DEVICE` predates `DeviceInfo.agent` (the field defaults to
 * `'absent'` server-side) and constructs no `agent` key at all — proving
 * the chip handles that the same as an explicit `'absent'`, never a crash.
 */
describe('DeviceCard — the guest-agent alert chip (plan 90 §5 step 90.6, fixes F10)', () => {
  test('no chip for a device that predates the field (reads as absent)', () => {
    const { queryByText } = renderWithApi(<DeviceCard device={BASE_DEVICE} />)
    expect(queryByText(/Agent failed/)).toBeNull()
    expect(queryByText(/Agent outdated/)).toBeNull()
  })

  test('no chip for ready — a healthy agent is not news', () => {
    const { queryByText } = renderWithApi(<DeviceCard device={{ ...BASE_DEVICE, agent: 'ready' }} />)
    expect(queryByText(/Agent /)).toBeNull()
  })

  test('a chip for failed', () => {
    const { getByText } = renderWithApi(<DeviceCard device={{ ...BASE_DEVICE, agent: 'failed' }} />)
    expect(getByText('Agent failed')).toBeTruthy()
  })

  test('a chip for outdated', () => {
    const { getByText } = renderWithApi(<DeviceCard device={{ ...BASE_DEVICE, agent: 'outdated' }} />)
    expect(getByText('Agent outdated')).toBeTruthy()
  })
})

/**
 * The overflow menu's Connection group (plan 88 §3.7, §3.8, §4.6, §5 step
 * 88.4) — the SAME words `DeviceHeader`'s own Connection group uses (a verb
 * keeps its name through the whole flow, `DeviceHeader.tsx`'s own rule).
 */
describe('DeviceCard — the Connection menu group', () => {
  const tcpDevice: DeviceInfo = {
    ...BASE_DEVICE,
    status: 'idle',
    serial: '10.20.0.37:5555',
    connection: { kind: 'tcp', medium: 'wired', mediumSource: 'network', address: '10.20.0.37', port: 5555, networkLabel: 'Chassis A' },
  }

  test('a tcp device: Disconnect is enabled and fires onRequestDisconnect', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const onRequestDisconnect = mock(() => {})
    renderWithApi(<DeviceCard device={tcpDevice} onRequestDisconnect={onRequestDisconnect} onReconnect={() => {}} />)
    await user.click(screen.getByRole('button', { name: /more actions for/i }))
    const item = await screen.findByText('Disconnect from the network')
    await user.click(item)
    expect(onRequestDisconnect).toHaveBeenCalledTimes(1)
  })

  test('a usb device: Disconnect is present but disabled — never fires onRequestDisconnect, and explains why', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const onRequestDisconnect = mock(() => {})
    // The disabled USB item wraps in a `<Tooltip>`, which needs the app-wide
    // `<TooltipProvider>` from `app/layout.tsx` — absent here since this test
    // mounts the card in isolation, so it is supplied locally (same pattern
    // `jobs/page.test.tsx` already uses).
    renderWithApi(
      <TooltipProvider>
        <DeviceCard device={BASE_DEVICE} onRequestDisconnect={onRequestDisconnect} onReconnect={() => {}} />
      </TooltipProvider>,
    )
    await user.click(screen.getByRole('button', { name: /more actions for/i }))
    const item = await screen.findByText('Disconnect from the network')
    // Hover, not click, is what shows a Radix Tooltip's content.
    await user.hover(item)
    await waitFor(() => expect(document.body.textContent).toContain('Unplug the cable'))
    await user.click(item)
    expect(onRequestDisconnect).not.toHaveBeenCalled()
  })

  test('Reconnect fires onReconnect', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const onReconnect = mock(() => {})
    renderWithApi(<DeviceCard device={tcpDevice} onRequestDisconnect={() => {}} onReconnect={onReconnect} />)
    await user.click(screen.getByRole('button', { name: /more actions for/i }))
    const item = await screen.findByText('Reconnect')
    await user.click(item)
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  test('with no onRequestForget, the overflow menu still appears when Connection actions are present', () => {
    renderWithApi(<DeviceCard device={tcpDevice} onReconnect={() => {}} />)
    expect(screen.getByRole('button', { name: /more actions for/i })).toBeTruthy()
  })
})

/**
 * `assistedBy` (plan 91 §3.4 item 4, §4.4, F25) — beside `heldBy`, never
 * replacing it: a device can be job-held AND assisted at the same time, and
 * both badges must render together.
 */
/**
 * The device number (plan 89 §3.1-§3.3, §5 step 89.3), shown on line 1 the
 * same way `WallTile` shows it (plan 92 §4.8, plan 48 §9 Q1) — so a device
 * reads identically on the fleet list and on the Wall. Read through the SAME
 * `tileIdentityOf` adapter, proven directly in `wall/tile-identity.test.ts`;
 * this only proves `DeviceCard` renders it.
 */
describe('DeviceCard — the device number (plan 89 §3.3, plan 92 §4.8, plan 48 §9 Q1)', () => {
  test('renders a dash for a device with no number (an explicitly released reservation)', () => {
    const { container } = renderWithApi(<DeviceCard device={BASE_DEVICE} />)
    const h3 = container.querySelector('h3')
    expect(h3?.textContent).toContain('—')
  })

  test('renders `#7` when the device carries one, never bare `7`', () => {
    const numberedDevice = { ...BASE_DEVICE, number: 7 }
    const { container } = renderWithApi(<DeviceCard device={numberedDevice} />)
    const h3 = container.querySelector('h3')
    expect(h3?.textContent).toContain('#7')
  })
})

describe('DeviceCard — assistedBy (plan 91 §3.4 item 4, §4.4, F25)', () => {
  test('a device that predates the field (no assistedBy at all) renders no assist badge', () => {
    const { queryByTitle } = renderWithApi(<DeviceCard device={BASE_DEVICE} />)
    expect(queryByTitle(/Assisting/)).toBeNull()
  })

  test('an empty assistedBy renders no assist badge', () => {
    const { queryByTitle } = renderWithApi(<DeviceCard device={{ ...BASE_DEVICE, assistedBy: [] }} />)
    expect(queryByTitle(/Assisting/)).toBeNull()
  })

  test('a device being assisted while a job holds it shows both badges', () => {
    const device: DeviceInfo = {
      ...BASE_DEVICE,
      status: 'busy',
      heldBy: { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null },
      assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }],
    }
    const { getByTitle } = renderWithApi(<DeviceCard device={device} />)
    expect(getByTitle('Running checkout@1.4.2 — open the job')).toBeTruthy()
    expect(getByTitle('Assisting — Alice')).toBeTruthy()
  })
})
