import { describe, expect, mock, test } from 'bun:test'
import { render } from '@testing-library/react'

// `AppRestartDialog` (rendered inside the card) reads `api()`, which reads
// `coreBase()` from `@/lib/ws` — mocked for the same reason every other
// component test touching a dialog that calls `api()` already documents.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://core.test',
  newId: () => 'test-id',
}))

const { AppRestartCard } = await import('./AppRestartCard')

/**
 * `AppRestartCard` (plan 120 §4) — proves the two things the plan's brief
 * calls out explicitly: the button is gated on `canManage` exactly like
 * every other `tool.manage` control on this page, and its label/description
 * never collide with `AdbServerCard`'s "Restart adb server" — an operator
 * must be able to tell the two apart without reading closely.
 */
describe('AppRestartCard', () => {
  test('renders a distinct heading and button label — never "adb"', () => {
    const { getByRole, queryByText } = render(<AppRestartCard canManage={true} />)
    expect(getByRole('heading', { name: 'Restart Enkaku' })).toBeTruthy()
    expect(getByRole('button', { name: /^Restart Enkaku$/ })).toBeTruthy()
    expect(queryByText(/Restart adb server/)).toBeNull()
    expect(queryByText(/^adb server$/)).toBeNull()
  })

  test('states plainly that this is bigger than the adb restart', () => {
    const { getByText } = render(<AppRestartCard canManage={true} />)
    expect(getByText(/whole application, not just the adb connection/)).toBeTruthy()
  })

  test('the button is disabled for a non-admin, with a reason', () => {
    const { getByRole } = render(<AppRestartCard canManage={false} />)
    const button = getByRole('button', { name: /^Restart Enkaku$/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.title).toBe('Only an admin can do this')
  })

  test('the button is enabled for an admin', () => {
    const { getByRole } = render(<AppRestartCard canManage={true} />)
    const button = getByRole('button', { name: /^Restart Enkaku$/ })
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })
})
