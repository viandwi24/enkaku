import { afterEach, describe, expect, test } from 'bun:test'
import type { DeviceConnection } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ConnectionBadge } from './ConnectionBadge'

afterEach(cleanup)

function connection(overrides: Partial<DeviceConnection> = {}): DeviceConnection {
  return {
    kind: 'usb',
    medium: null,
    mediumSource: 'unknown',
    address: null,
    port: null,
    networkLabel: null,
    ...overrides,
  }
}

/**
 * The badge matrix is `connectionBadge()`'s job (`packages/protocol/src/device.test.ts`
 * already proves it); these tests are about what reaches the screen — the
 * word rendered, and that the TCP row never quietly becomes "WI-FI" (plan 88
 * §3.1, the exact bug this plan fixes in `descriptors.ts`).
 */
describe('ConnectionBadge — reads correctly without a tooltip', () => {
  test('usb reads USB', () => {
    const { container } = renderWithApi(<ConnectionBadge connection={connection({ kind: 'usb' })} />)
    expect(container.textContent).toBe('USB')
  })

  test('tcp + wired reads OTG', () => {
    const { container } = renderWithApi(
      <ConnectionBadge connection={connection({ kind: 'tcp', medium: 'wired', mediumSource: 'network' })} />,
    )
    expect(container.textContent).toBe('OTG')
  })

  test('tcp + wireless reads WI-FI', () => {
    const { container } = renderWithApi(
      <ConnectionBadge connection={connection({ kind: 'tcp', medium: 'wireless', mediumSource: 'declared' })} />,
    )
    expect(container.textContent).toBe('WI-FI')
  })

  test('tcp with no known medium reads TCP — never a guessed WI-FI', () => {
    const { container } = renderWithApi(
      <ConnectionBadge connection={connection({ kind: 'tcp', medium: null, mediumSource: 'unknown' })} />,
    )
    expect(container.textContent).toBe('TCP')
  })

  test('the tooltip carries the address; the visible word does not depend on it', () => {
    const { container } = renderWithApi(
      <ConnectionBadge
        connection={connection({ kind: 'tcp', medium: 'wired', mediumSource: 'network', address: '10.20.0.37', port: 5555 })}
      />,
    )
    const el = container.querySelector('[title]')
    expect(el).not.toBeNull()
    expect(el?.getAttribute('title')).toContain('10.20.0.37:5555')
    expect(container.textContent).toBe('OTG')
  })

  test('an unresolved medium explains itself as uncertainty, not as a claim', () => {
    const { container } = renderWithApi(
      <ConnectionBadge connection={connection({ kind: 'tcp', medium: null, mediumSource: 'unknown', address: '192.168.1.51' })} />,
    )
    const title = container.querySelector('[title]')?.getAttribute('title')
    expect(title).toContain('does not know whether this is wired or Wi-Fi')
  })
})
