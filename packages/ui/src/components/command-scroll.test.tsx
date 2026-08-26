import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Command, CommandItem, CommandList } from './command'

afterEach(cleanup)

/**
 * A `Combobox` opened inside a `Dialog` showed a scrollbar and could not be
 * scrolled with a mouse or trackpad — only with the arrow keys. Reported from
 * the owner's farm twice, on two different controls, both inside dialogs.
 *
 * The cause, read out of the pinned `@radix-ui/react-dialog@1.1.23` rather
 * than guessed: its modal content wraps the page in `RemoveScroll` with
 * `shards: [context.contentRef]` — one allowed scroll region, the dialog's own
 * content. `popover.tsx` portals to `document.body`, outside that shard, so
 * `react-remove-scroll` cancels the list's wheel events at the document level.
 * The scrollbar is honest; the wheel simply never arrives. Arrow keys keep
 * working because `cmdk` scrolls the active item programmatically.
 *
 * `CommandList` therefore scrolls itself. These tests pin that behaviour
 * WITHOUT a dialog, because the fix must hold in both places and because
 * neither happy-dom nor jsdom runs `react-remove-scroll`'s document listeners
 * — a test that mounted a real dialog would prove nothing about the thing
 * that was broken. What can be proved here is the contract: an overflowing
 * list takes the wheel and moves itself; a list with nothing to scroll does
 * not interfere.
 *
 * Neither engine lays out, so `scrollHeight`/`clientHeight` are stubbed. That
 * is the honest limit of this file: it proves the handler's logic, not that
 * the pixels move on a real screen.
 */

function renderList(opts: { scrollHeight: number; clientHeight: number; onWheel?: (e: React.WheelEvent<HTMLDivElement>) => void }) {
  render(
    <Command>
      <CommandList data-testid="list" {...(opts.onWheel ? { onWheel: opts.onWheel } : {})}>
        <CommandItem value="a">alpha</CommandItem>
        <CommandItem value="b">bravo</CommandItem>
      </CommandList>
    </Command>,
  )
  const el = screen.getByTestId('list')
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true })
  el.scrollTop = 0
  return el
}

describe('CommandList — it scrolls itself (farm report, 2026-08-26)', () => {
  test('an overflowing list moves its own scrollTop by the wheel delta', () => {
    const el = renderList({ scrollHeight: 900, clientHeight: 300 })
    fireEvent.wheel(el, { deltaY: 120 })
    expect(el.scrollTop).toBe(120)
    fireEvent.wheel(el, { deltaY: 80 })
    expect(el.scrollTop).toBe(200)
  })

  test('it cancels the default, so a browser that WOULD have scrolled natively cannot also scroll', () => {
    // Without this the fix would double-scroll outside a dialog, where nothing
    // was blocking the wheel in the first place.
    const el = renderList({ scrollHeight: 900, clientHeight: 300 })
    const event = new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true })
    el.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  test('a list with nothing to scroll does not interfere — the wheel passes through untouched', () => {
    const el = renderList({ scrollHeight: 200, clientHeight: 300 })
    const event = new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true })
    el.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(el.scrollTop).toBe(0)
  })

  test("a caller's own onWheel runs first and can opt out entirely", () => {
    const onWheel = mock((e: React.WheelEvent<HTMLDivElement>) => e.preventDefault())
    const el = renderList({ scrollHeight: 900, clientHeight: 300, onWheel })
    fireEvent.wheel(el, { deltaY: 120 })
    expect(onWheel).toHaveBeenCalledTimes(1)
    // It prevented the default itself, so the list left the gesture alone.
    expect(el.scrollTop).toBe(0)
  })

  test("a caller's onWheel that does NOT opt out still gets the scrolling", () => {
    const onWheel = mock(() => {})
    const el = renderList({ scrollHeight: 900, clientHeight: 300, onWheel })
    fireEvent.wheel(el, { deltaY: 60 })
    expect(onWheel).toHaveBeenCalledTimes(1)
    expect(el.scrollTop).toBe(60)
  })
})
