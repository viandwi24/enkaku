import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * The chip itself is a trigger; the panel behind it (`AgentAlertDetail`) is
 * proven in its own file. What this file exists for is plan 124 §4.4 Group
 * B's one decision about the seam between them: `AgentAlertDetail`'s
 * `deviceLabel: string` prop is deliberately NOT widened into an object, so
 * the number has to be composed by the CALLER — and the caller is this chip,
 * exactly once, rather than each of its three callers (`DeviceCard`,
 * `DeviceHeader`, `DevicePopup`) writing its own `#${n} ${label}`.
 *
 * `AgentAlertDetail` is therefore stubbed down to the one prop under test.
 * Rendering the real panel here would pull in `usePreparation`, a fetch and a
 * stack trace to assert a string concatenation, and would fail for reasons
 * that have nothing to do with what this file is checking.
 */
mock.module('@/components/guest-agent/AgentAlertDetail', () => ({
  AgentAlertDetail: ({ deviceLabel }: { deviceLabel: string }) => <div data-testid="panel">{deviceLabel}</div>,
}))

const { AgentAlertChip } = await import('./AgentAlertChip')

afterEach(cleanup)

async function openPanel(node: ReactElement) {
  const r = renderWithApi(node)
  fireEvent.click(r.getByRole('button', { name: /Agent failed/ }))
  await waitFor(() => expect(r.getByTestId('panel')).toBeTruthy())
  return r
}

describe('AgentAlertChip — the number reaches the panel (plan 124 §4.4 Group B)', () => {
  test('composes `#7 moto g06` for the panel that writes the outcome sentences', async () => {
    const { getByTestId } = await openPanel(
      <AgentAlertChip agent="failed" deviceId="dev-1" deviceLabel="moto g06" deviceNumber={7} />,
    )
    expect(getByTestId('panel').textContent).toBe('#7 moto g06')
  })

  test('a device with no number passes the bare label — no `#`, no `#null` (criterion 7)', async () => {
    const { getByTestId } = await openPanel(
      <AgentAlertChip agent="failed" deviceId="dev-1" deviceLabel="moto g06" deviceNumber={null} />,
    )
    expect(getByTestId('panel').textContent).toBe('moto g06')
  })

  test('a caller that omits deviceNumber entirely still renders the bare label, never `#undefined`', async () => {
    // The prop is optional on purpose: `undefined` is a caller that predates
    // the field, and it must behave identically to an explicit `null`.
    const { getByTestId } = await openPanel(<AgentAlertChip agent="failed" deviceId="dev-1" deviceLabel="moto g06" />)
    expect(getByTestId('panel').textContent).toBe('moto g06')
  })
})
