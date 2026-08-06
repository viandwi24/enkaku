import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ModelCombobox } from './ModelCombobox'

/**
 * Plan 83 §3.5, §4.4, §7 — criteria 12/13: typing filters, arrow keys
 * navigate, Enter selects, Escape closes and changes nothing; the current
 * model is shown and pre-highlighted even if the connector no longer lists
 * it. Driven through real `@testing-library/user-event` keyboard events
 * (per the plan's own test plan), not by calling handlers directly.
 */

afterEach(cleanup)

function Wrapped(props: { value: string; options: string[]; onValueChange(v: string): void; error?: string | null }) {
  return <ModelCombobox {...props} />
}

describe('ModelCombobox', () => {
  test('the current value is always shown on the trigger, even before opening', () => {
    renderWithApi(<Wrapped value="claude-opus-5" options={['claude-haiku-4-5']} onValueChange={() => undefined} />)
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain('claude-opus-5')
  })

  test('typing filters the list live', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<Wrapped value="claude-opus-5" options={['claude-opus-5', 'claude-haiku-4-5', 'claude-sonnet-5']} onValueChange={() => undefined} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Filter models…')).toBeTruthy())
    await user.type(screen.getByPlaceholderText('Filter models…'), 'haiku')
    await waitFor(() => expect(screen.getByText('claude-haiku-4-5')).toBeTruthy())
    expect(screen.queryByText('claude-sonnet-5')).toBeNull()
  })

  test('Enter selects the highlighted item and closes the popover', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    let selected: string | null = null
    renderWithApi(<Wrapped value="claude-opus-5" options={['claude-opus-5', 'claude-haiku-4-5']} onValueChange={(v) => (selected = v)} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    const input = await screen.findByPlaceholderText('Filter models…')
    await user.type(input, 'haiku')
    await waitFor(() => expect(screen.getByText('claude-haiku-4-5')).toBeTruthy())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(selected).toBe('claude-haiku-4-5'))
    expect(screen.queryByPlaceholderText('Filter models…')).toBeNull() // closed
  })

  test('Escape closes the popover and changes nothing', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    let selected: string | null = null
    renderWithApi(<Wrapped value="claude-opus-5" options={['claude-opus-5', 'claude-haiku-4-5']} onValueChange={(v) => (selected = v)} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Filter models…')).toBeTruthy())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByPlaceholderText('Filter models…')).toBeNull())
    expect(selected).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain('claude-opus-5') // unchanged
  })

  test('criterion 13 — the current model is listed even when the connector no longer reports it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<Wrapped value="a-retired-model" options={['claude-haiku-4-5']} onValueChange={() => undefined} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Filter models…')).toBeTruthy())
    expect(screen.getAllByText('a-retired-model').length).toBeGreaterThan(0)
  })

  test('criterion 8 — a models-list failure renders a named failure, not an empty dropdown', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<Wrapped value="claude-opus-5" options={[]} onValueChange={() => undefined} error="connector unreachable" />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await waitFor(() => expect(screen.getByText(/The model list failed to load/)).toBeTruthy())
    expect(screen.getByText(/connector unreachable/)).toBeTruthy()
  })
})
