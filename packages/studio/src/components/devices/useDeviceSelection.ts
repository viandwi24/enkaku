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

/** "The click handler is deferred 200ms and cancelled by a double-click." */
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
  /** Row/card `onMouseDown`: starts the deferred toggle and the potential marquee. */
  onItemMouseDown: (id: string, e: React.MouseEvent) => void
  /** Row/card `onDoubleClick`: cancels the pending toggle and calls `onOpenControl`. */
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
  /** Double-click target. Undefined until plan 215 supplies the window. */
  onOpenControl?: (deviceId: string) => void
}): DeviceSelection {
  const { filteredIds, containerRef, onOpenControl } = opts
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

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

  const endDrag = useCallback(() => {
    dragRef.current = null
    setRect(null)
    document.removeEventListener('mousemove', onDocMouseMove)
    document.removeEventListener('mouseup', onDocMouseUp)
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
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
      dragRef.current = { origin: { x: e.clientX, y: e.clientY }, base: [...selected], additive, started: false }
      document.addEventListener('mousemove', onDocMouseMove)
      document.addEventListener('mouseup', onDocMouseUp)
    },
    [selected],
  )

  const onItemMouseDown = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.button !== 0) return
      clearPending()
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      const x = e.clientX
      const y = e.clientY
      const timer = setTimeout(() => {
        pendingRef.current = null
        setSelected((prev) => {
          if (additive) {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          }
          return prev.has(id) && prev.size === 1 ? new Set() : new Set([id])
        })
      }, CLICK_DEFER_MS)
      pendingRef.current = { id, x, y, timer }

      // A move past the threshold before the timer fires promotes this
      // gesture to a marquee instead (rule 1).
      const onMoveCheck = (ev: MouseEvent) => {
        if (!pendingRef.current) {
          document.removeEventListener('mousemove', onMoveCheck)
          return
        }
        const dx = ev.clientX - x
        const dy = ev.clientY - y
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
          clearPending()
          document.removeEventListener('mousemove', onMoveCheck)
          startDrag(e)
        }
      }
      document.addEventListener('mousemove', onMoveCheck)
      const cleanup = () => document.removeEventListener('mousemove', onMoveCheck)
      document.addEventListener('mouseup', cleanup, { once: true })
    },
    [clearPending, startDrag],
  )

  const onItemDoubleClick = useCallback(
    (id: string) => {
      clearPending()
      onOpenControl?.(id)
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
      document.removeEventListener('mousemove', onDocMouseMove)
      document.removeEventListener('mouseup', onDocMouseUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useMemo(
    () => ({ selected, set, clear, toggle, onItemMouseDown, onItemDoubleClick, onMarqueeMouseDown, rect }),
    [selected, set, clear, toggle, onItemMouseDown, onItemDoubleClick, onMarqueeMouseDown, rect],
  )
}
