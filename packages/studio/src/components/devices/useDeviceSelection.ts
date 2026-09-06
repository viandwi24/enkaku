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
 * How long a COLLAPSE waits to see whether a second click is coming.
 *
 * This used to gate every click on every row, so selecting a device the
 * operator had not selected yet — the common gesture, and the one with
 * nothing to disambiguate — cost 200ms of visible lag (owner, 2026-09-06).
 * Now it gates only the one gesture that genuinely cannot be told apart from
 * the start of a double-click: a plain click on a device that is ALREADY in
 * the selection, whose meaning is "drop the other members".
 *
 * That distinction is what fixes retargeting the control window. With three
 * devices selected and the window on one of them, double-clicking a second
 * one used to fire this timer first: the selection collapsed to that single
 * device, and the double-click then retargeted against a mirror that no
 * longer existed — so the host appeared not to change at all when the
 * operator double-clicked the device the window was already on. The collapse
 * is now pending when `onItemDoubleClick` cancels it, so the mirror survives
 * and `retargetSelection` sees the set the operator actually has.
 */
export const CLICK_DEFER_MS = 200
/** "A 5px threshold distinguishes a drag from a click." */
export const DRAG_THRESHOLD_PX = 5

export interface DeviceSelection {
  selected: ReadonlySet<string>
  /** Replaces the whole set. */
  set: (ids: string[]) => void
  clear: () => void
  /** A direct, immediate toggle — the table's own checkbox, never the deferred row click. */
  toggle: (id: string) => void
  /** Row/card `onMouseDown`: applies the selection (immediately, unless the gesture could still be a double-click) and starts the potential marquee. */
  onItemMouseDown: (id: string, e: React.MouseEvent) => void
  /** Row/card `onDoubleClick`: cancels a pending collapse and calls `onOpenControl` with the selection as it stands. */
  onItemDoubleClick: (id: string) => void
  /** The scroller's `onMouseDown`: starts a marquee when the target is not inside a `[data-device-id]`. */
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

  const pendingRef = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const dragRef = useRef<{
    origin: { x: number; y: number }
    base: string[]
    additive: boolean
    started: boolean
  } | null>(null)

  const set = useCallback((ids: string[]) => setSelected(new Set(ids)), [])
  const clear = useCallback(() => setSelected(new Set()), [])
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearPending = useCallback(() => {
    if (pendingRef.current) {
      clearTimeout(pendingRef.current.timer)
      pendingRef.current = null
    }
  }, [])

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
      if (e.button !== 0) return
      clearPending()
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      const x = e.clientX
      const y = e.clientY

      /**
       * Two gestures, only one of which is ambiguous.
       *
       * A click that ADDS (shift/cmd/ctrl, or a plain click on a device not
       * currently selected) can only mean one thing, so it applies now — that
       * is the gesture an operator makes constantly, and deferring it was the
       * whole of the felt lag.
       *
       * A plain click on a device already in the selection means "drop the
       * others", and is indistinguishable from the first half of a
       * double-click, whose meaning is the opposite: keep the others and move
       * the window here (`retargetSelection`). Only that one waits.
       */
      const collapses = !additive && selectedRef.current.has(id)

      if (!collapses) {
        setSelected((prev) => {
          if (!additive) return new Set([id])
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        // Still tracked below, so a drag started from this row promotes to a
        // marquee exactly as before.
        pendingRef.current = null
      }

      const timer = collapses
        ? setTimeout(() => {
            pendingRef.current = null
            // `size === 1` and already holding this id: the click is a
            // deselect, unchanged from before.
            setSelected((prev) => (prev.has(id) && prev.size === 1 ? new Set() : new Set([id])))
          }, CLICK_DEFER_MS)
        : null
      if (timer) pendingRef.current = { id, x, y, timer }

      // A move past the threshold before the timer fires promotes this
      // gesture to a marquee instead (rule 1).
      // One subscription, torn down by whichever of the three exits comes
      // first — the same reason `startDrag` uses one (see `dragListenersRef`).
      const ac = new AbortController()
      const onMoveCheck = (ev: MouseEvent) => {
        const dx = ev.clientX - x
        const dy = ev.clientY - y
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return
        clearPending()
        ac.abort()
        startDrag(e)
      }
      document.addEventListener('mousemove', onMoveCheck, { signal: ac.signal })
      document.addEventListener('mouseup', () => ac.abort(), { signal: ac.signal, once: true })
    },
    [clearPending, startDrag],
  )

  const onItemDoubleClick = useCallback(
    (id: string) => {
      // Cancels the pending collapse FIRST, so the set handed over is the one
      // the operator built, not the single device the collapse was about to
      // leave behind.
      clearPending()
      onOpenControl?.(id, [...selectedRef.current])
    },
    [clearPending, onOpenControl],
  )

  const onMarqueeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target
      if (target instanceof Element && target.closest('[data-device-id]')) return
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
      clearPending()
      // Same fix as `endDrag`: the two `removeEventListener` calls that used
      // to live here named render-0's functions and removed nothing, so a
      // screen unmounted mid-drag left its listeners on `document` forever.
      dragListenersRef.current?.abort()
      dragListenersRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useMemo(
    () => ({ selected, set, clear, toggle, onItemMouseDown, onItemDoubleClick, onMarqueeMouseDown, rect }),
    [selected, set, clear, toggle, onItemMouseDown, onItemDoubleClick, onMarqueeMouseDown, rect],
  )
}
