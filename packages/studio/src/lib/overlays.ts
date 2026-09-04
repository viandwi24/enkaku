'use client'

import { useEffect } from 'react'

/**
 * Escape tiering and `[data-menu-root]` containment, installed ONCE by
 * `AppShell` (design handoff, Interactions: "Escape | Close popover/menu/
 * window if any; otherwise clear selection" and "Click outside a
 * `[data-menu-root]` | Close menus, the info popover, and the group form").
 *
 * Modelled on the prototype's own two document listeners
 * (`Enkaku Device List.dc.html:1015-1045`): one capture-phase `click` whose
 * test is `!e.target.closest('[data-menu-root]')`, and one `keydown` that
 * closes menus and windows first and only then clears the selection.
 */
export type OverlayTier = 'menu' | 'window' | 'selection'

interface Entry {
  id: number
  close: () => void
}

/** One module-level registry, insertion-ordered, ids monotonic. */
const registry: Record<OverlayTier, Entry[]> = { menu: [], window: [], selection: [] }
let nextId = 1

/**
 * Registers a closer. Highest tier present wins on Escape; within a tier the
 * most recently registered closes first (a menu opened over a menu). Returns
 * the deregistrar. Call it in the effect cleanup; never leave one behind.
 */
export function registerOverlay(tier: OverlayTier, close: () => void): () => void {
  const entry: Entry = { id: nextId++, close }
  registry[tier].push(entry)
  return () => {
    const list = registry[tier]
    const idx = list.indexOf(entry)
    if (idx >= 0) list.splice(idx, 1)
  }
}

/** `registerOverlay` as an effect: registers while `open`, deregisters when it closes or the component unmounts. */
export function useOverlay(tier: OverlayTier, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    return registerOverlay(tier, close)
    // `close` is intentionally read fresh on every registration: re-running
    // this effect on an identity change is the correct behaviour (the
    // registered closer must always be the latest one), not a bug to
    // suppress with a ref.
  }, [tier, open, close])
}

/**
 * Whether any overlay of this tier is registered. Read by the Devices screen
 * so Ctrl/Cmd+A can be "ignored while Device Control is open" (design
 * handoff, Selection) without this screen knowing that Device Control exists:
 * plan 215's window registers at tier `window` and the suspension starts
 * working with no edit here or there.
 */
export function hasOverlay(tier: OverlayTier): boolean {
  return registry[tier].length > 0
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/** Installed by `AppShell` only. Adds the one `keydown` listener. */
export function useShellHotkeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented) return

      const hasOverlay = registry.menu.length > 0 || registry.window.length > 0
      // A menu opened from inside a search field must still close on Escape
      // — only bail out of an EDITABLE target when there is no menu/window
      // registered to close, in which case the field's own native Escape
      // behaviour (if any) is left alone.
      if (isEditable(event.target) && !hasOverlay) return

      for (const tier of ['menu', 'window', 'selection'] as const) {
        const list = registry[tier]
        const last = list[list.length - 1]
        if (last) {
          last.close()
          return
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}

/** Installed by `AppShell` only. Adds the one capture-phase `click` listener. */
export function useOutsideMenuClick(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-menu-root]')) return
      // Snapshot first: a closer's own cleanup (its `useOverlay` effect
      // tearing down on the state change `close()` triggers) mutates
      // `registry.menu` via splice, and iterating the live array while that
      // happens would skip entries. Most recent first, matching the
      // prototype.
      const closers = [...registry.menu]
      for (let i = closers.length - 1; i >= 0; i--) {
        closers[i]?.close()
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
}
