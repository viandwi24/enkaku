import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import '../../../happydom'
import { useDragSelect } from './useDragSelect'

afterEach(cleanup)

/**
 * There is no real CSS layout engine under happy-dom — `getBoundingClientRect`
 * always reads a zero rect by default (the same limitation `WallTile.test.tsx`
 * documents and works around) — so every "card" here gets its rect assigned
 * directly rather than relying on any actual layout.
 */
function makeCard(id: string, box: { left: number; top: number; right: number; bottom: number }): HTMLDivElement {
  const el = document.createElement('div')
  el.dataset.deviceId = id
  el.getBoundingClientRect = () =>
    ({
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.right - box.left,
      height: box.bottom - box.top,
      x: box.left,
      y: box.top,
      toJSON() {
        return box
      },
    }) as DOMRect
  return el
}

function makeContainer(cards: HTMLDivElement[]): HTMLDivElement {
  const container = document.createElement('div')
  for (const c of cards) container.appendChild(c)
  document.body.appendChild(container)
  return container
}

/** A minimal stand-in for `React.MouseEvent` — `onGridMouseDown` is invoked directly rather than through a real DOM dispatch, so only the fields it actually reads need to exist. */
function mouseDownEvent(opts: { clientX: number; clientY: number; target: EventTarget; button?: number; metaKey?: boolean; ctrlKey?: boolean }): React.MouseEvent {
  return {
    button: opts.button ?? 0,
    clientX: opts.clientX,
    clientY: opts.clientY,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    target: opts.target,
  } as unknown as React.MouseEvent
}

describe('useDragSelect (plan 101 §3.9, §5 step 101.5, G15)', () => {
  test('dragging a rectangle over several cards selects exactly those covered — the same set clicking each of their checkboxes would produce from a cleared selection (this step\'s own acceptance criterion)', () => {
    const a = makeCard('a', { left: 0, top: 0, right: 50, bottom: 50 })
    const b = makeCard('b', { left: 60, top: 0, right: 110, bottom: 50 })
    const c = makeCard('c', { left: 200, top: 0, right: 250, bottom: 50 }) // outside the rectangle below
    const container = makeContainer([a, b, c])
    const containerRef = { current: container }
    let selected: string[] = ['stale'] // a pre-existing selection from a prior, unrelated action
    const onSelect = (ids: string[]) => {
      selected = ids
    }
    const { result } = renderHook(() => useDragSelect({ containerRef, selectedIds: selected, onSelect }))

    act(() => {
      result.current.onGridMouseDown(mouseDownEvent({ clientX: -10, clientY: -10, target: container }))
    })
    expect(result.current.dragging).toBe(true)
    // A plain (non-additive) drag clears the prior selection the instant it starts.
    expect(selected).toEqual([])

    act(() => {
      fireEvent.mouseMove(window, { clientX: 120, clientY: 60 })
    })
    expect(new Set(selected)).toEqual(new Set(['a', 'b']))
    expect(selected).not.toContain('c')

    act(() => {
      fireEvent.mouseUp(window)
    })
    expect(result.current.dragging).toBe(false)
    expect(result.current.rect).toBeNull()
  })

  test('a mousedown that originates ON a card does not start a rectangle — refs/ui\'s own choice, so a click reaches the card\'s own handler untouched', () => {
    const a = makeCard('a', { left: 0, top: 0, right: 50, bottom: 50 })
    const container = makeContainer([a])
    const containerRef = { current: container }
    let calls = 0
    const onSelect = () => {
      calls++
    }
    const { result } = renderHook(() => useDragSelect({ containerRef, selectedIds: [], onSelect }))

    act(() => {
      result.current.onGridMouseDown(mouseDownEvent({ clientX: 10, clientY: 10, target: a }))
    })
    expect(result.current.dragging).toBe(false)
    expect(calls).toBe(0)
  })

  test('ctrl/cmd-held drag EXTENDS the current selection instead of replacing it — the same modifier convention as the per-card click handler', () => {
    const a = makeCard('a', { left: 0, top: 0, right: 50, bottom: 50 })
    const container = makeContainer([a])
    const containerRef = { current: container }
    // 'existing' belongs to a device not rendered in this container right
    // now (e.g. scrolled out, or a different group) — extending must not
    // drop it just because it is not currently intersectable.
    let selected: string[] = ['existing']
    const onSelect = (ids: string[]) => {
      selected = ids
    }
    const { result } = renderHook(() => useDragSelect({ containerRef, selectedIds: selected, onSelect }))

    act(() => {
      result.current.onGridMouseDown(mouseDownEvent({ clientX: -10, clientY: -10, target: container, ctrlKey: true }))
    })
    // Additive mousedown never clears synchronously — unlike the plain case above.
    expect(selected).toEqual(['existing'])

    act(() => {
      fireEvent.mouseMove(window, { clientX: 60, clientY: 60 })
    })
    expect(new Set(selected)).toEqual(new Set(['existing', 'a']))
  })

  test('a click with no movement at all on empty grid space clears the selection, same as a background click in a file manager', () => {
    const container = makeContainer([])
    const containerRef = { current: container }
    let selected: string[] = ['a', 'b']
    const onSelect = (ids: string[]) => {
      selected = ids
    }
    const { result } = renderHook(() => useDragSelect({ containerRef, selectedIds: selected, onSelect }))

    act(() => {
      result.current.onGridMouseDown(mouseDownEvent({ clientX: 5, clientY: 5, target: container }))
    })
    act(() => {
      fireEvent.mouseUp(window)
    })
    expect(selected).toEqual([])
    expect(result.current.dragging).toBe(false)
  })

  test('onDragStart fires exactly once, at the moment the drag actually begins — not on every mousemove', () => {
    const a = makeCard('a', { left: 0, top: 0, right: 50, bottom: 50 })
    const container = makeContainer([a])
    const containerRef = { current: container }
    let starts = 0
    const { result } = renderHook(() =>
      useDragSelect({ containerRef, selectedIds: [], onSelect: () => undefined, onDragStart: () => starts++ }),
    )

    act(() => {
      result.current.onGridMouseDown(mouseDownEvent({ clientX: -10, clientY: -10, target: container }))
    })
    expect(starts).toBe(1)

    act(() => {
      fireEvent.mouseMove(window, { clientX: 10, clientY: 10 })
      fireEvent.mouseMove(window, { clientX: 20, clientY: 20 })
    })
    expect(starts).toBe(1)
  })

  test('a mousedown whose real target sits OUTSIDE the container (a portaled dropdown/dialog) does not start a drag, even though React still delivers the event here', () => {
    // A shadcn/Radix dropdown or dialog renders its open content in a real
    // DOM portal appended to `document.body` — nested in the REACT tree
    // (so this handler still receives the bubbled event) but not a DOM
    // descendant of `container` at all. `.closest('[data-device-id]')`
    // cannot see that ancestry; this is the check that has to catch it
    // instead, or opening "More actions" and picking an item would also
    // clear the selection and start a rectangle.
    const container = makeContainer([])
    const containerRef = { current: container }
    const portaled = document.createElement('button')
    document.body.appendChild(portaled) // NOT inside `container`
    let calls = 0
    const { result } = renderHook(() => useDragSelect({ containerRef, selectedIds: [], onSelect: () => calls++ }))

    act(() => {
      result.current.onGridMouseDown(mouseDownEvent({ clientX: 5, clientY: 5, target: portaled }))
    })
    expect(result.current.dragging).toBe(false)
    expect(calls).toBe(0)
  })

  test('only the primary mouse button starts a drag — a right-click is the context menu\'s job', () => {
    const container = makeContainer([])
    const containerRef = { current: container }
    const { result } = renderHook(() => useDragSelect({ containerRef, selectedIds: [], onSelect: () => undefined }))

    act(() => {
      result.current.onGridMouseDown(mouseDownEvent({ clientX: 5, clientY: 5, target: container, button: 2 }))
    })
    expect(result.current.dragging).toBe(false)
  })
})
