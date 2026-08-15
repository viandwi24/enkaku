import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { SelectionCursorBadge } from './SelectionCursorBadge'

afterEach(cleanup)

/**
 * "mouse akan ada indikator device yang terseleksi berapa" (plan 91 §0.3,
 * §5 step 91.8, F11/F12) — the cursor-anchored count badge.
 */
describe('SelectionCursorBadge (plan 91 §5 step 91.8, F11/F12)', () => {
  test('renders nothing when inactive, even with a cursor position and a count', () => {
    const { queryByText } = renderWithApi(<SelectionCursorBadge active={false} count={3} />)
    fireEvent.mouseMove(window, { clientX: 100, clientY: 200 })
    expect(queryByText('3 selected')).toBeNull()
  })

  test('renders nothing when active but the count is zero', () => {
    const { queryByText } = renderWithApi(<SelectionCursorBadge active count={0} />)
    fireEvent.mouseMove(window, { clientX: 100, clientY: 200 })
    expect(queryByText('0 selected')).toBeNull()
  })

  test('renders nothing before the first mouse move (no position to anchor to)', () => {
    const { queryByText } = renderWithApi(<SelectionCursorBadge active count={5} />)
    expect(queryByText('5 selected')).toBeNull()
  })

  test('shows the count, offset from (never under) the cursor, once active and moved', () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={5} />)
    fireEvent.mouseMove(window, { clientX: 100, clientY: 200 })
    const badge = getByText('5 selected')
    expect(badge.style.left).toBe('116px')
    expect(badge.style.top).toBe('216px')
  })

  test('never covers the pointer target: pointer-events-none, always offset off the raw cursor position', () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={2} />)
    fireEvent.mouseMove(window, { clientX: 50, clientY: 60 })
    const badge = getByText('2 selected')
    expect(badge.className).toContain('pointer-events-none')
    expect(badge.style.left).not.toBe('50px')
    expect(badge.style.top).not.toBe('60px')
  })

  test('tracks the cursor across multiple moves', () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={1} />)
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 300, clientY: 400 })
    const badge = getByText('1 selected')
    expect(badge.style.left).toBe('316px')
    expect(badge.style.top).toBe('416px')
  })

  test('going inactive clears the position (a later re-activation starts blank until the next move)', () => {
    const { rerender, queryByText } = renderWithApi(<SelectionCursorBadge active count={4} />)
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 })
    expect(queryByText('4 selected')).toBeTruthy()

    rerender(<SelectionCursorBadge active={false} count={4} />)
    expect(queryByText('4 selected')).toBeNull()
  })
})
