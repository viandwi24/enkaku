import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
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

  /**
   * The floor is TWO, not one (owner's call, 2026-08-16). One selected
   * device is already legible on the grid — its own tile carries the accent
   * tint and border — so a cursor badge reading "1 selected" restates what
   * the operator can see, in the exact place they are looking while working.
   */
  test('renders nothing for a single selected device — the tile already shows that', () => {
    const { queryByText } = renderWithApi(<SelectionCursorBadge active count={1} />)
    fireEvent.mouseMove(window, { clientX: 100, clientY: 200 })
    expect(queryByText('1 selected')).toBeNull()
  })

  test('appears at two, the first count a glance cannot verify', () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={2} />)
    fireEvent.mouseMove(window, { clientX: 100, clientY: 200 })
    expect(getByText('2 selected')).toBeTruthy()
  })

  /**
   * Behaviour change, plan 101 §5 step 101.8's follow-up: the badge is now
   * MOUNTED before the first move and merely transparent, rather than
   * unmounted. Mounting mid-drag cost a commit at the worst moment, and
   * rendering at `translate3d(0,0,0)` for one frame flashed it in the
   * top-left corner. `data-ready` is the flag; `opacity-0` is the effect.
   */
  test('is mounted but not yet visible before the first mouse move', () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={5} />)
    const badge = getByText('5 selected')
    expect(badge.hasAttribute('data-ready')).toBe(false)
    expect(badge.className).toContain('opacity-0')
  })

  /**
   * Position lives in the DOM node's `transform`, not in React state, and is
   * written once per animation frame — see the component's own note for why
   * (`left`/`top` forces layout; a state update per pointer event re-renders
   * a page that may be decoding 24-40 video streams). So these assertions
   * wait for the frame rather than reading synchronously.
   */
  test('follows the cursor, offset from (never under) it, once active and moved', async () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={5} />)
    fireEvent.mouseMove(window, { clientX: 100, clientY: 200 })
    const badge = getByText('5 selected')
    await waitFor(() => expect(badge.style.transform).toBe('translate3d(116px, 216px, 0)'))
    expect(badge.hasAttribute('data-ready')).toBe(true)
  })

  test('never covers the pointer target: pointer-events-none, always offset off the raw cursor position', async () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={2} />)
    fireEvent.mouseMove(window, { clientX: 50, clientY: 60 })
    const badge = getByText('2 selected')
    expect(badge.className).toContain('pointer-events-none')
    await waitFor(() => expect(badge.style.transform).toBe('translate3d(66px, 76px, 0)'))
  })

  test('tracks the cursor across multiple moves', async () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={6} />)
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 300, clientY: 400 })
    const badge = getByText('6 selected')
    await waitFor(() => expect(badge.style.transform).toBe('translate3d(316px, 416px, 0)'))
  })

  /**
   * The reason the position is never animated: a follower that eases toward
   * the pointer is late, not smooth. The owner reported the transitioned
   * version as "patah patah" / "lompat lompat" — every pointer event
   * restarted a 100ms ease toward a target that had already moved, so it
   * chased permanently and never arrived.
   */
  test('carries no CSS transition on its position — a cursor follower must be exact, not eased', () => {
    const { getByText } = renderWithApi(<SelectionCursorBadge active count={3} />)
    const badge = getByText('3 selected')
    expect(badge.className).not.toContain('transition-all')
    expect(badge.className).not.toMatch(/\btransition-\[?(left|top|transform)/)
  })

  test('going inactive hides it again (a later re-activation stays hidden until the next move)', () => {
    const { rerender, getByText, queryByText } = renderWithApi(<SelectionCursorBadge active count={4} />)
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 })
    expect(getByText('4 selected').hasAttribute('data-ready')).toBe(true)

    rerender(<SelectionCursorBadge active={false} count={4} />)
    expect(queryByText('4 selected')).toBeNull()

    rerender(<SelectionCursorBadge active count={4} />)
    expect(getByText('4 selected').hasAttribute('data-ready')).toBe(false)
  })
})
