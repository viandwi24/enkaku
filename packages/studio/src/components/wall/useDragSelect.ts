'use client'

import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface DragRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Drag-rectangle multi-select for the device grid (plan 101 §3.9, step
 * 101.5, G15 — `refs/ui`'s `dragSelecting`/`dragBox`). One instance, owned
 * by `app/page.tsx`, drives BOTH the List view's `DeviceCard` grid and the
 * Wall's tile grid, because both already read and write the same
 * `selectedIds` array the bulk-operations toolbar drives
 * (`useBulkSelection`) — this hook produces ids, it never owns a selection
 * of its own. Introducing a second selection set here is exactly the
 * failure this step's own brief calls out: an operator who drag-selects
 * eight devices and sees the toolbar act on three has been lied to.
 *
 * This hook is deliberately DOM-driven rather than list-driven: it reads
 * whichever elements carry `data-device-id` inside `containerRef` at drag
 * time, the same technique `refs/ui`'s own `handleGridMouseDown`/`_onMove`
 * use (`querySelectorAll('[data-id]')`). That means the caller never has to
 * keep a separate "what's currently visible" array in sync with what's
 * actually rendered — filtering, grouping, or switching between List and
 * Wall all just change which elements exist in the DOM, and this hook
 * follows along for free.
 *
 * Two interaction decisions are stated here, not defaulted into:
 *
 *  - **A drag starting ON a card is not a selection rectangle.** `refs/ui`'s
 *    own `handleGridMouseDown` bails via `e.target.closest('[data-id]')`
 *    before starting a drag at all, so a mousedown that begins on a device
 *    (its checkbox, its "Control" link, a wall tile's video, its own
 *    hover-overlay buttons) is left completely alone and reaches that
 *    element's own handler untouched — this mirrors that choice exactly,
 *    rather than inventing a different one. Only a mousedown on the grid's
 *    empty space (the gap between cards, a group heading, unused row space)
 *    starts a rectangle.
 *  - **Replace vs extend mirrors ctrl/cmd, matching `refs/ui` exactly.** A
 *    plain drag starts from an EMPTY base and replaces the selection with
 *    whatever the rectangle covers by the time the mouse comes up — so
 *    dragging over three cards produces the identical `selectedIds` array
 *    three individual clicks of their checkboxes would from a cleared
 *    selection, which is this step's own acceptance criterion ("drag-select
 *    and click-select produce the same selection set"). Holding ctrl/cmd
 *    merges into the CURRENT selection instead of clearing it first first —
 *    the same modifier `refs/ui`'s own per-card click handler uses to
 *    extend rather than replace, so a drag and a click never disagree about
 *    what the modifier key means on this one grid.
 */
export function useDragSelect({
  containerRef,
  selectedIds,
  onSelect,
  onDragStart,
}: {
  /** The element `data-device-id` wrappers are searched inside — an ancestor of every card/tile the grid renders, in ANY of its views (List, grouped List, Wall). */
  containerRef: RefObject<HTMLElement | null>
  /** The selection to extend when the drag is ctrl/cmd-held. Read once per drag, at mousedown — a drag does not chase a selection someone else changes mid-gesture. */
  selectedIds: readonly string[]
  /** Called with the full replacement array on every mouse move during a drag — the exact shape `setSelectedIds` already takes, so the caller can pass it directly. */
  onSelect: (ids: string[]) => void
  /**
   * Fires once, synchronously, the instant a drag actually starts (not on a
   * card, primary button). `app/page.tsx` uses this to auto-enter select
   * mode: a drag rectangle IS the operator declaring intent to multi-select,
   * so requiring a separate "Select devices" click first would make the
   * gesture this step exists to add undiscoverable behind another one.
   */
  onDragStart?: () => void
}): { dragging: boolean; rect: DragRect | null; onGridMouseDown: (e: React.MouseEvent) => void } {
  const [dragging, setDragging] = useState(false)
  const [rect, setRect] = useState<DragRect | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const baseRef = useRef<string[]>([])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const start = startRef.current
      if (!start) return
      const left = Math.min(start.x, e.clientX)
      const right = Math.max(start.x, e.clientX)
      const top = Math.min(start.y, e.clientY)
      const bottom = Math.max(start.y, e.clientY)
      setRect({ left, top, width: right - left, height: bottom - top })

      const container = containerRef.current
      const covered: string[] = []
      if (container) {
        container.querySelectorAll<HTMLElement>('[data-device-id]').forEach((el) => {
          const r = el.getBoundingClientRect()
          const intersects = !(r.left > right || r.right < left || r.top > bottom || r.bottom < top)
          if (intersects) {
            const id = el.dataset.deviceId
            if (id) covered.push(id)
          }
        })
      }
      onSelect(Array.from(new Set([...baseRef.current, ...covered])))
    }
    const onUp = () => {
      setDragging(false)
      setRect(null)
      startRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // Deliberately keyed on `dragging` alone: `containerRef` is a ref object
    // (stable identity, read fresh through `.current` on every move rather
    // than captured), and `onSelect` is expected to be a stable setState
    // function (`setSelectedIds` passed directly) per this hook's own doc
    // comment above — re-subscribing on every render would only cost a
    // needless remove+add of the same two window listeners.
  }, [dragging])

  const onGridMouseDown = (e: React.MouseEvent) => {
    // Only the primary button starts a rectangle. A right-click is the
    // context menu's job, handled per-card by the caller — never here.
    if (e.button !== 0) return
    // A `DeviceCard`'s own dropdown menu (shadcn's Radix-based
    // `DropdownMenu`) renders its open content in a PORTAL — a real DOM
    // child of `document.body`, not of this container, even though React's
    // synthetic event system still bubbles the mousedown here because
    // portals stay nested in the REACT tree (see React's own docs on
    // portals and event bubbling). `.closest('[data-device-id]')` below
    // walks the REAL DOM, so it cannot see that ancestry and would
    // otherwise treat "clicked inside the open dropdown" as "clicked on
    // empty grid space" — starting a rectangle and clearing the selection
    // the instant an operator opens "More actions" and picks an item. This
    // check catches that case (and any other portaled overlay — a dialog,
    // a tooltip, a popover) the general way, without knowing anything
    // about Radix: if the real click target is not actually contained in
    // this container's real DOM, it did not happen "in the grid" no matter
    // what the React tree says.
    const container = containerRef.current
    if (container && e.target instanceof Node && !container.contains(e.target)) return
    if ((e.target as HTMLElement).closest?.('[data-device-id]')) return
    const additive = e.metaKey || e.ctrlKey
    baseRef.current = additive ? [...selectedIds] : []
    startRef.current = { x: e.clientX, y: e.clientY }
    setRect({ left: e.clientX, top: e.clientY, width: 0, height: 0 })
    setDragging(true)
    // Matches `refs/ui`'s own `handleGridMouseDown`, which clears the
    // selection synchronously on mousedown for a non-additive drag rather
    // than waiting for the first `mousemove` — so a plain click on empty
    // grid space (mousedown + mouseup, no movement at all) also clears the
    // selection, the same as it would for a file manager's own background click.
    if (!additive) onSelect([])
    onDragStart?.()
  }

  return { dragging, rect, onGridMouseDown }
}
