'use client'

import { useEffect } from 'react'
import type { DeviceInfo, Target } from '@enkaku/protocol'
import { useOverlay } from '@/lib/overlays'
import { DeviceActionMenu } from '@/components/device-actions/DeviceActionList'
import type { DeviceActionContext } from '@/lib/device-actions'

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
/** The header plus the top-level rows (two inline, nine groups, Forget); only used to decide which way to open. */
const MENU_H = 520
const EDGE = 8

/**
 * The right-click menu on a device (owner, 2026-09-05).
 *
 * Its rows are `DeviceActionMenu` — the SAME list the floating bulk pill and
 * Device Control's Actions tab draw from `lib/device-actions.ts`, including
 * Open Device Control and Labels, which used to be rows only this menu had.
 * The owner's rule (2026-09-15) is that the three surfaces are identical;
 * a row one of them lacked was exactly the inconsistency it rules out.
 *
 * Everything acts on the SELECTION, which is why the header says how many
 * devices that is. Right-clicking a device outside the current selection
 * replaces it with that one (`DevicesScreen`), the way a file manager does;
 * right-clicking inside a selection keeps all of it. Open Device Control
 * opens the device under the cursor and mirrors the rest of the selection.
 */
export function DeviceContextMenu({
  request,
  target,
  targetDevices,
  onLabelsChanged,
  onClose,
  onOpenControl,
}: {
  request: DeviceContextMenuRequest
  /** What the action rows act on — the resolved selection, built by `DevicesScreen`. */
  target: Target
  /**
   * The same devices `target` names, as live rows (plan 225 §4.6). The label
   * panel needs more than their ids: it shows which labels the selection
   * already carries, and across a mixed selection that is a three-state
   * answer per label, not a boolean.
   */
  targetDevices: DeviceInfo[]
  /** The farm's label list changed (a label was created from inside the panel) — refresh the counts. */
  onLabelsChanged: () => void
  onClose: () => void
  /** Opens Device Control on this device; the caller keeps the rest of the selection as its mirror. */
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
  const submenuSide = left + MENU_W + 236 + EDGE > (typeof window !== 'undefined' ? window.innerWidth : 0) ? 'left' : 'right'

  const ctx: DeviceActionContext = {
    deviceIds: 'deviceIds' in target ? target.deviceIds : [],
    subjectId: request.deviceId,
    surface: 'context',
    openControl: (hostId) => onOpenControl(hostId),
  }

  return (
    <div
      data-menu-root="1"
      style={{ left, top, width: MENU_W }}
      className="fixed z-40 rounded-card border border-border bg-panel shadow-menu"
      // A right-click INSIDE the menu must not open a second one behind it.
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="border-b border-line px-[10px] py-1.5">
        <span className="text-label text-faint">
          {request.count === 1 ? 'Actions for this device' : `Actions for ${request.count} selected`}
        </span>
      </div>

      <DeviceActionMenu
        ctx={ctx}
        devices={targetDevices}
        onLabelsChanged={onLabelsChanged}
        onDone={onClose}
        submenuSide={submenuSide}
        submenuAlign={flipUp ? 'bottom' : 'top'}
      />
    </div>
  )
}
