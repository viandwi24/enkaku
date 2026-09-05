'use client'

import { useEffect } from 'react'
import { cn } from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'

/** Where the menu was asked for, and what was under the cursor. */
export interface CanvasMenuRequest {
  x: number
  y: number
  /** The node right-clicked, or `null` for empty canvas. */
  nodeId: string | null
  /** How many nodes the copy rows will act on, resolved when the menu opened. */
  count: number
}

const MENU_W = 216
const MENU_H = 200
const EDGE = 8
const ROW = 'flex w-full items-center justify-between gap-3 rounded-button px-[10px] py-[7px] text-row text-text transition-colors hover:bg-muted disabled:pointer-events-none disabled:text-faint'

/**
 * The canvas right-click menu (owner, 2026-09-05).
 *
 * Every row here already existed as a keyboard shortcut and nothing else, so
 * the whole feature was invisible to anyone who had not been told about it —
 * copy, cut, paste and duplicate were real, tested and undiscoverable. The
 * chord is shown beside each row for the same reason: a menu that teaches its
 * own shortcut stops being needed.
 *
 * Paste is the row that matters on EMPTY canvas, and that is deliberate: it
 * is how a graph someone sent over chat gets in, and there is nothing
 * selected at that moment by definition.
 */
export function CanvasContextMenu({
  request,
  onClose,
  onCopy,
  onCut,
  onPaste,
  onDuplicate,
  onDelete,
}: {
  request: CanvasMenuRequest
  onClose: () => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  useOverlay('menu', true, onClose)

  // A right-click elsewhere, and scrolling — the two ways out a left-click
  // handler cannot see. Same reasoning as the device menu: a menu pinned to
  // viewport coordinates after the canvas has moved points at nothing.
  useEffect(() => {
    const onContextMenuOutside = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-menu-root]')) return
      onClose()
    }
    document.addEventListener('contextmenu', onContextMenuOutside, true)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('contextmenu', onContextMenuOutside, true)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  const meta = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  const flipUp = typeof window !== 'undefined' && request.y + MENU_H + EDGE > window.innerHeight
  const flipLeft = typeof window !== 'undefined' && request.x + MENU_W + EDGE > window.innerWidth
  const left = flipLeft ? Math.max(EDGE, request.x - MENU_W) : request.x
  const top = flipUp ? Math.max(EDGE, request.y - MENU_H) : request.y
  const has = request.count > 0

  const row = (label: string, chord: string, disabled: boolean, run: () => void, danger = false) => (
    <button
      type="button"
      disabled={disabled}
      className={cn(ROW, danger && !disabled && 'text-danger hover:bg-muted')}
      onClick={() => {
        run()
        onClose()
      }}
    >
      <span>{label}</span>
      <span className="text-meta text-faint">{chord}</span>
    </button>
  )

  return (
    <div
      data-menu-root="1"
      style={{ left, top, width: MENU_W }}
      className="fixed z-40 rounded-card border border-border bg-panel p-1 shadow-menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {row(request.count > 1 ? `Copy ${request.count} nodes` : 'Copy', `${meta}C`, !has, onCopy)}
      {row('Cut', `${meta}X`, !has, onCut)}
      {row('Paste', `${meta}V`, false, onPaste)}
      {row('Duplicate', `${meta}D`, !has, onDuplicate)}
      <div className="my-1 border-t border-line" />
      {row('Delete', 'Del', !has, onDelete, true)}
    </div>
  )
}
