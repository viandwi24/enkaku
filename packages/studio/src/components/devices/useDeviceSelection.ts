'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hasOverlay, useOverlay } from '@/lib/overlays'

/**
 * The handoff's selection model (README, Selection), identical in both views.
 * One hook, because the table and the grid must produce the same set from the
 * same gestures, and the old screen's split between a click handler in
 * `app/page.tsx` and a drag hook in the deleted `useDragSelect.ts` is what
 * let a plain drag clear the selection on mousedown before it had moved at all
 * (`useDragSelect.ts:158` `if (!additive) onSelect([])`).
 */

/**
 * Clicking an item TOGGLES it, and nothing else on the surface does
 * (owner, 2026-09-17).
 *
 * The row and the card used to behave like a file manager: a plain click
 * replaced the whole selection, and building a multi-select meant either
 * holding a modifier or finding the table's checkbox column. So an operator
 * who clicked one phone and then another was left holding the second one
 * alone — the first selection gone, with nothing on screen saying why — and
 * the only reliable way to pick five phones was five checkboxes, a control
 * the Screens grid never had at all.
 *
 * Now the whole item IS the checkbox: a click adds a device that is not in
 * the selection and removes one that is, in both views, with or without a
 * modifier. The table's per-row checkbox column is gone with it (plan 214's
 * grid, minus its first column), because a checkbox inside a surface that
 * already toggles is a second control for the same act.
 *
 * Two gestures are left untouched and must stay that way: a marquee still
 * REPLACES the selection with what it covers (shift keeps the base), and a
 * double-click still opens Device Control without disturbing the selection
 * at all — see `lastToggleRef`.
 */
/** "A 5px threshold distinguishes a drag from a click." */
export const DRAG_THRESHOLD_PX = 5

/**
 * Controls that own their own mousedown. A press on one of these is never a
 * row/card click and never the start of a marquee: the table header's
 * select-all checkbox, a card's agent chip, any link or field. Without this,
 * a press on that checkbox started a marquee that cleared the selection on
 * mouseup, a moment before the checkbox's own click re-applied it.
 */
const INTERACTIVE_SELECTOR =
  'button, a[href], input, textarea, select, label, [role="checkbox"], [role="button"], [role="menuitem"], [contenteditable=""], [contenteditable="true"], [data-no-marquee]'

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null
}

/**
 * Whether a press landed on the scroller's own scrollbar. The scrollbar is
 * part of the element, so `e.target` is the scroller itself and nothing else
 * can tell a scrollbar drag from a marquee — which would select every row the
 * pointer swept past while the operator was only scrolling.
 */
function onScrollbar(e: React.MouseEvent): boolean {
  const el = e.currentTarget
  if (!(el instanceof HTMLElement) || e.target !== el) return false
  const r = el.getBoundingClientRect()
  return e.clientX >= r.left + el.clientLeft + el.clientWidth || e.clientY >= r.top + el.clientTop + el.clientHeight
}

export interface DeviceSelection {
  selected: ReadonlySet<string>
  /** Replaces the whole set. */
  set: (ids: string[]) => void
  clear: () => void
  /** Row/card `onMouseDown`: toggles the device in or out of the selection, and starts the potential marquee. */
  onItemMouseDown: (id: string, e: React.MouseEvent) => void
  /** Row/card `onDoubleClick`: undoes the toggle its own first click applied, then calls `onOpenControl` with the selection the operator actually had. */
  onItemDoubleClick: (id: string) => void
  /**
   * The scroller's `onMouseDown` — the table's and the Screens grid's alike:
   * starts a marquee when the target is not inside a `[data-device-id]`, not
   * an interactive control, and not the scroller's own scrollbar.
   */
  onMarqueeMouseDown: (e: React.MouseEvent) => void
  /** The overlay rectangle, or null. */
  rect: { left: number; top: number; width: number; height: number } | null
}

export function useDeviceSelection(opts: {
  /** The filtered ids, in view order. Ctrl/Cmd+A selects exactly this. */
  filteredIds: readonly string[]
  /** The element `[data-device-id]` wrappers are searched inside. */
  containerRef: React.RefObject<HTMLElement | null>
  /**
   * Double-click target. Undefined until plan 215 supplies the window.
   *
   * `selectedNow` is handed over rather than left for the caller to read back
   * off this hook: the Devices screen used to pass an `onOpenControl` that
   * closed over the very `selection` object this hook was returning, which
   * made "which devices are mirrored" depend on render timing at the exact
   * moment a pending collapse might have just fired.
   */
  onOpenControl?: (deviceId: string, selectedNow: readonly string[]) => void
}): DeviceSelection {
  const { filteredIds, containerRef, onOpenControl } = opts
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  /**
   * The live selection, readable from a handler that must not be re-created
   * every time it changes. `onItemMouseDown` is attached to every row and
   * card; making it depend on `selected` would hand all of them a new
   * callback on each selection change, which on a large farm is exactly the
   * re-render this screen is trying to avoid.
   */
  const selectedRef = useRef<ReadonlySet<string>>(selected)
  selectedRef.current = selected

  /**
   * What the last item click did, so a double-click can put it back.
   *
   * A double-click is two clicks, and the first one has already toggled the
   * device by the time the second arrives — a device the operator
   * double-clicks to OPEN would otherwise land in the selection (or drop out
   * of it) as a side effect. `onItemDoubleClick` reverts exactly this entry,
   * which is why the mirror it hands to Device Control is the selection as it
   * stood before the gesture: `retargetSelection` can then keep a
   * multi-select the device belonged to, and collapse to the one device when
   * it did not (design handoff README:243-245, unchanged by this rewrite).
   */
  const lastToggleRef = useRef<{ id: string; added: boolean } | null>(null)
  const dragRef = useRef<{
    origin: { x: number; y: number }
    base: string[]
    additive: boolean
    started: boolean
  } | null>(null)

  const set = useCallback((ids: string[]) => setSelected(new Set(ids)), [])
  const clear = useCallback(() => setSelected(new Set()), [])

  /**
   * The live drag's listener subscription.
   *
   * `endDrag` used to call `document.removeEventListener` with
   * `onDocMouseMove`/`onDocMouseUp` — plain function declarations, so a NEW
   * identity on every render — while `endDrag` itself was memoised with `[]`
   * and `startDrag` with `[selected]`. The functions being removed were
   * therefore render-0's, and the ones actually registered were the current
   * render's: `removeEventListener` matched nothing and silently did nothing.
   * Every marquee after the first selection change leaked a `mousemove`
   * listener that stayed on `document` for the life of the page, and each one
   * re-ran the O(tiles) `querySelectorAll` + `getBoundingClientRect` sweep
   * below on every mouse move. The fifth drag of a session did that work five
   * times over.
   *
   * An `AbortController` cannot get this wrong: the subscription is the
   * object, not the function identity, so aborting it removes exactly what it
   * added no matter which render created either.
   */
  const dragListenersRef = useRef<AbortController | null>(null)

  const endDrag = useCallback(() => {
    dragRef.current = null
    setRect(null)
    dragListenersRef.current?.abort()
    dragListenersRef.current = null
  }, [])

  function onDocMouseMove(e: MouseEvent) {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.origin.x
    const dy = e.clientY - drag.origin.y
    if (!drag.started && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    drag.started = true

    const left = Math.min(drag.origin.x, e.clientX)
    const top = Math.min(drag.origin.y, e.clientY)
    const width = Math.abs(dx)
    const height = Math.abs(dy)
    setRect({ left, top, width, height })

    const container = containerRef.current
    const covered: string[] = []
    if (container) {
      for (const el of container.querySelectorAll<HTMLElement>('[data-device-id]')) {
        const r = el.getBoundingClientRect()
        const intersects = r.left < left + width && r.left + r.width > left && r.top < top + height && r.top + r.height > top
        if (intersects) {
          const id = el.getAttribute('data-device-id')
          if (id) covered.push(id)
        }
      }
    }
    setSelected(new Set(drag.additive ? [...drag.base, ...covered] : covered))
  }

  function onDocMouseUp() {
    /**
     * A click on empty space clears the selection, the way it does on a
     * desktop.
     *
     * The marquee only writes a selection once the pointer has moved past its
     * threshold, so a bare click started a drag that never started and left
     * everything selected — the only way out was Escape, which an operator
     * mid-marquee does not think to reach for (owner, 2026-09-04). A modified
     * click is left alone: shift/cmd on empty space is the start of an
     * additive gesture, not a request to drop what is already held.
     */
    const drag = dragRef.current
    if (drag && !drag.started && !drag.additive) setSelected(new Set())
    endDrag()
  }

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      // Read through the ref, not a captured `selected`: this callback stays
      // identity-stable that way, so `onItemMouseDown` (which depends on it,
      // and is attached to every row and card) is not rebuilt on every
      // selection change. It is also the more correct value — `startDrag` is
      // reached from a mousemove, after any selection this gesture already
      // applied has landed.
      dragRef.current = { origin: { x: e.clientX, y: e.clientY }, base: [...selectedRef.current], additive, started: false }
      // A drag already in flight (a second mousedown before the first
      // mouseup) drops its own listeners first, so at most one subscription
      // is ever live.
      dragListenersRef.current?.abort()
      const ac = new AbortController()
      dragListenersRef.current = ac
      document.addEventListener('mousemove', onDocMouseMove, { signal: ac.signal })
      document.addEventListener('mouseup', onDocMouseUp, { signal: ac.signal })
    },
    // `onDocMouseMove`/`onDocMouseUp` are plain declarations, re-created each
    // render; that is exactly why the listeners are torn down by signal
    // rather than by identity, and why this stays `[]`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const onItemMouseDown = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.button !== 0 || isInteractiveTarget(e.target)) return
      const x = e.clientX
      const y = e.clientY

      /**
       * One rule for every click: toggle. No modifier changes it, because
       * the surface itself is the checkbox now (see the header of this file),
       * and there is nothing left for a modifier to mean on an item.
       *
       * `e.detail` is the click count the browser has already worked out for
       * this mousedown, so the SECOND press of a double-click is skipped here
       * rather than deferred: the 200ms `CLICK_DEFER_MS` timer this replaces
       * had to guess, and made every ambiguous click feel slow. The first
       * press still toggles — `onItemDoubleClick` puts that back.
       */
      if (e.detail < 2) {
        const added = !selectedRef.current.has(id)
        lastToggleRef.current = { id, added }
        setSelected((prev) => {
          const next = new Set(prev)
          if (added) next.add(id)
          else next.delete(id)
          return next
        })
      }

      // A move past the threshold promotes this gesture to a marquee. The
      // toggle above stands (it is already in `base`), but it is no longer
      // revertible: a drag is not the first half of a double-click.
      // One subscription, torn down by whichever of the two exits comes
      // first — the same reason `startDrag` uses one (see `dragListenersRef`).
      const ac = new AbortController()
      const onMoveCheck = (ev: MouseEvent) => {
        const dx = ev.clientX - x
        const dy = ev.clientY - y
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return
        lastToggleRef.current = null
        ac.abort()
        startDrag(e)
      }
      document.addEventListener('mousemove', onMoveCheck, { signal: ac.signal })
      document.addEventListener('mouseup', () => ac.abort(), { signal: ac.signal, once: true })
    },
    [startDrag],
  )

  const onItemDoubleClick = useCallback(
    (id: string) => {
      // Reverts this gesture's own first click, so opening the window leaves
      // the selection exactly as the operator built it — and so the set
      // handed over is the one `retargetSelection` has to read to tell
      // "already part of the selection" from "not".
      const last = lastToggleRef.current
      lastToggleRef.current = null
      let before = selectedRef.current
      if (last && last.id === id) {
        const reverted = new Set(before)
        if (last.added) reverted.delete(id)
        else reverted.add(id)
        before = reverted
        setSelected(reverted)
      }
      onOpenControl?.(id, [...before])
    },
    [onOpenControl],
  )

  const onMarqueeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target
      if (target instanceof Element && target.closest('[data-device-id]')) return
      if (isInteractiveTarget(target) || onScrollbar(e)) return
      startDrag(e)
    },
    [startDrag],
  )

  // Ctrl/Cmd+A, suspended while an editable field has focus or a `window`
  // overlay is registered (rule 4).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return
      const active = document.activeElement
      const isEditable = active instanceof HTMLElement && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
      if (isEditable || hasOverlay('window')) return
      e.preventDefault()
      setSelected(new Set(filteredIds))
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [filteredIds])

  useOverlay('selection', selected.size > 0, clear)

  useEffect(() => {
    return () => {
      // Same fix as `endDrag`: the two `removeEventListener` calls that used
      // to live here named render-0's functions and removed nothing, so a
      // screen unmounted mid-drag left its listeners on `document` forever.
      dragListenersRef.current?.abort()
      dragListenersRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useMemo(
    () => ({ selected, set, clear, onItemMouseDown, onItemDoubleClick, onMarqueeMouseDown, rect }),
    [selected, set, clear, onItemMouseDown, onItemDoubleClick, onMarqueeMouseDown, rect],
  )
}
