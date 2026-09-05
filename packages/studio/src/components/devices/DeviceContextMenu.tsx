'use client'

import { useEffect } from 'react'
import type { Target } from '@enkaku/protocol'
import { DeviceMobileIcon, cn } from '@enkaku/ui'
import type { ActionDialogVerb } from '@/components/actions/ActionDialogHost'
import { useOverlay } from '@/lib/overlays'
import { ActionMenu } from './ActionMenu'

/** Where the menu was asked for, and what it acts on. */
export interface DeviceContextMenuRequest {
  /** The device under the cursor. Device Control opens THIS one, whatever else is selected. */
  deviceId: string
  /** Viewport coordinates of the right-click. */
  x: number
  y: number
  /** How many devices the action rows will actually act on — the selection, after the right-click resolved it. */
  count: number
}

const MENU_W = 232
/** Enough for the seven top-level rows plus the header; only used to decide which way to open. */
const MENU_H = 330
const EDGE = 8

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors text-text hover:bg-muted'

/**
 * The right-click menu on a device (owner, 2026-09-05).
 *
 * Deliberately the SAME `ActionMenu` the floating bulk pill renders, not a
 * second list beside it: the handoff's rule is that selecting one device and
 * selecting twenty behave identically, and a right-click menu that offered a
 * different set — or the same set in a different order — would be the third
 * place this product describes the same nineteen actions.
 *
 * One row it adds that the bulk pill cannot have: **Open Device Control**.
 * The pill acts on a selection of any size and there is no such thing as
 * casting twenty phones into one window; a right-click always has exactly one
 * device under the cursor, so this is the one surface where that action has
 * an unambiguous subject. It sits above the rule, alone, because it is the
 * reason most right-clicks happen.
 *
 * Everything below the rule acts on the SELECTION, which is why the header
 * says how many devices that is. Right-clicking a device outside the current
 * selection replaces it with that one (`DevicesScreen`), the way a file
 * manager does; right-clicking inside a selection keeps all of it.
 */
export function DeviceContextMenu({
  request,
  target,
  onClose,
  onOpenControl,
}: {
  request: DeviceContextMenuRequest
  /** What the action rows act on — the resolved selection, built by `DevicesScreen`. */
  target: Target
  onClose: () => void
  onOpenControl: (deviceId: string) => void
}) {
  useOverlay('menu', true, onClose)

  /*
   * `useOutsideMenuClick` (lib/overlays.ts) closes menus on a LEFT click
   * outside them, which covers most of the ways out of here. Two it cannot:
   *
   *  - a right-click on empty space, because a secondary button fires
   *    `contextmenu`, not `click`;
   *  - scrolling the list, after which this menu is still pinned to viewport
   *    coordinates while the row it belongs to has moved out from under it.
   *
   * Both are what a native context menu does, and both leave a menu that
   * looks attached to whatever row happens to be beneath it now — which is a
   * menu pointing at the wrong device.
   */
  useEffect(() => {
    const onContextMenuOutside = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-menu-root]')) return
      onClose()
    }
    // Capture, so a scroller that stops propagation cannot keep this open.
    document.addEventListener('contextmenu', onContextMenuOutside, true)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('contextmenu', onContextMenuOutside, true)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  // Flip rather than clamp when there is no room: a menu shoved back inside
  // the viewport would sit UNDER the cursor and swallow the click that opened
  // it. Opening the other way keeps the cursor on the menu's corner, which is
  // what every native context menu does.
  const flipUp = typeof window !== 'undefined' && request.y + MENU_H + EDGE > window.innerHeight
  const flipLeft = typeof window !== 'undefined' && request.x + MENU_W + EDGE > window.innerWidth
  const left = flipLeft ? Math.max(EDGE, request.x - MENU_W) : request.x
  const top = flipUp ? Math.max(EDGE, request.y - MENU_H) : request.y

  // A submenu opens away from the window edge the parent is nearest. The
  // parent is MENU_W wide, so the room a submenu needs on the right is
  // measured from the parent's right edge, not from the cursor.
  const submenuSide = left + MENU_W + 212 + EDGE > (typeof window !== 'undefined' ? window.innerWidth : 0) ? 'left' : 'right'

  return (
    <div
      data-menu-root="1"
      style={{ left, top, width: MENU_W }}
      className="fixed z-40 rounded-card border border-border bg-panel shadow-menu"
      // A right-click INSIDE the menu must not open a second one behind it.
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="p-1">
        <button
          type="button"
          className={cn(ROW, 'font-medium')}
          onClick={() => {
            onOpenControl(request.deviceId)
            onClose()
          }}
        >
          <DeviceMobileIcon className="size-4 text-accent" aria-hidden />
          Open Device Control
        </button>
      </div>

      <div className="border-t border-line px-[10px] py-1.5">
        <span className="text-label text-faint">
          {request.count === 1 ? 'Actions for this device' : `Actions for ${request.count} selected`}
        </span>
      </div>

      <ActionMenu
        target={target}
        onDone={onClose}
        submenuSide={submenuSide}
        submenuAlign={flipUp ? 'bottom' : 'top'}
      />
    </div>
  )
}
