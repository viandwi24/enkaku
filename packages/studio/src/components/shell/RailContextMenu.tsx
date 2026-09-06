'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowSquareOutIcon, PictureInPictureIcon, SidebarSimpleIcon } from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'
import { usePip } from './pip-store'

/** Where the menu was asked for, and what it acts on. */
export interface RailContextMenuRequest {
  href: string
  label: string
  /** Whether this entry may be panelled at all (plan 500 §3.7 / 501 §3.5) — absent or `false` on Devices. */
  pip?: boolean
  /** Viewport coordinates of the right-click. */
  x: number
  y: number
}

const MENU_W = 220
/** Enough for all three rows; only used to decide which way to open. */
const MENU_H = 150
const EDGE = 8

/** Below this viewport width the side panel is not offered (plan 501 §3.5) — the handoff designed no layout under ~960px. */
const MIN_SIDE_VIEWPORT_PX = 900

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors text-text hover:bg-muted'

/**
 * The rail's right-click menu (plan 501 §3.2, §4.4): modelled on
 * `DeviceContextMenu` — fixed viewport-coordinate positioning, edge-flip,
 * closed through `useOverlay` and the same outside-contextmenu/scroll
 * listeners — because this repo opens a right-click menu exactly one way and
 * a third-party menu primitive here would make it a third way (§3.2).
 *
 * Rows: **Open** (what a left click already does, named), then **Open in
 * PiP** and **Open in side panel** when the entry allows it (`request.pip`)
 * and, for the side panel only, the viewport is wide enough (§3.5). An offer
 * that cannot be taken is hidden, not disabled — the same rule Devices'
 * missing rows already follow.
 */
export function RailContextMenu({ request, onClose }: { request: RailContextMenuRequest; onClose: () => void }) {
  const router = useRouter()
  const { open } = usePip()
  useOverlay('menu', true, onClose)

  const [canSide, setCanSide] = useState(false)
  useEffect(() => {
    setCanSide(window.innerWidth >= MIN_SIDE_VIEWPORT_PX)
  }, [])

  // Same two listeners `DeviceContextMenu` installs: a right-click elsewhere
  // fires `contextmenu`, not `click`, so the outside-click handler in
  // `lib/overlays.ts` cannot see it; and a scroll leaves this menu pinned to
  // viewport coordinates that no longer point at the row that opened it.
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

  const flipUp = typeof window !== 'undefined' && request.y + MENU_H + EDGE > window.innerHeight
  const flipLeft = typeof window !== 'undefined' && request.x + MENU_W + EDGE > window.innerWidth
  const left = flipLeft ? Math.max(EDGE, request.x - MENU_W) : request.x
  const top = flipUp ? Math.max(EDGE, request.y - MENU_H) : request.y

  const canPanel = request.pip === true

  return (
    <div
      data-menu-root="1"
      style={{ left, top, width: MENU_W }}
      className="fixed z-40 rounded-card border border-border bg-panel p-1 shadow-menu"
      // A right-click INSIDE the menu must not open a second one behind it.
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className={ROW}
        onClick={() => {
          router.push(request.href)
          onClose()
        }}
      >
        <ArrowSquareOutIcon className="size-4 text-faint" aria-hidden />
        Open
      </button>

      {canPanel && (
        <button
          type="button"
          className={ROW}
          onClick={() => {
            open(request.href, request.label, 'pip')
            onClose()
          }}
        >
          <PictureInPictureIcon className="size-4 text-faint" aria-hidden />
          Open in PiP
        </button>
      )}

      {canPanel && canSide && (
        <button
          type="button"
          className={ROW}
          onClick={() => {
            open(request.href, request.label, 'side')
            onClose()
          }}
        >
          <SidebarSimpleIcon className="size-4 text-faint" aria-hidden />
          Open in side panel
        </button>
      )}
    </div>
  )
}
