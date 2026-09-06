'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { coreBase } from '@/lib/ws'
import { useShellHotkeys, useOutsideMenuClick } from '@/lib/overlays'
import { PagePanel } from './PagePanel'
import { PipHost } from './PipHost'
import { isPipFrame } from './pip-frame'
import { Rail } from './Rail'
import { SidePanel } from './SidePanel'
import { StatusBar } from './StatusBar'
import { PluginNavResponseSchema, activePluginView, pluginNavItems, type PluginNavGroup } from './nav'

/**
 * The app frame (design handoff, "Global shell"):
 *   Root: height: 100vh; display: flex; gap: 10px; padding: 10px;
 *         background: var(--bg).
 *   Two children: the icon rail, then a column holding the active page panel
 *   and the status bar.
 *
 * Mounted once, by `AuthGate`, around every authenticated route. It is the
 * only place the shell's three global behaviours are installed: the pushed
 * counters (`lib/shell-state.ts`, through `StatusBar`), the Escape tier stack
 * and the `[data-menu-root]` outside-click listener (`lib/overlays.ts`). A
 * screen registers into those; it never installs its own.
 *
 * Below 1024px the rail stays a rail. The handoff designed no mobile layout
 * ("desktop-first … usable down to ~960px; no mobile layout was designed"),
 * and the mobile sheet the old, deleted 14-item nav opened there existed to
 * hold fourteen labelled items. Five 36px icons need no sheet: the page
 * panel gets narrower, its own content scrolls, and nothing about the frame
 * changes.
 */
export function AppShell({ children }: { children: ReactNode }) {
  // Empty until it loads, empty forever if the read fails: a farm with no
  // plugins and a farm whose plugin list could not be read look the same here,
  // which is the point: neither is allowed to move a core nav item.
  const [pluginNav, setPluginNav] = useState<PluginNavGroup[]>([])
  const pathname = usePathname()
  // Safe here: `AppShell` only ever renders inside `AuthGate`'s `<Suspense>`
  // boundary, which is what a static export needs before it will prerender a
  // `useSearchParams()` caller at all.
  const searchParams = useSearchParams()

  useShellHotkeys()
  useOutsideMenuClick()

  // The document loaded INSIDE a picture-in-picture panel's iframe (§3.7,
  // G8): `?pip=1`, set only by `PipPanel`'s own `src`. No rail, no status
  // bar, no `PipHost` — a framed document must not be able to open a panel
  // of its own, which would make the "exactly one panel" guarantee (G2) a
  // per-document promise instead of a per-tab one.
  const framed = isPipFrame(searchParams)

  /**
   * `pathname` is the dependency, not a timer and not a WS event. The screens
   * a plugin declares cannot change because a job moved from `queued` to
   * `running`, and on a farm running batches `job.status` fires several times
   * a second. That is how this exact read became the most expensive request
   * in Studio once before (plan 126 §0.4). A client-side navigation is the
   * cheapest trigger that still covers the one flow that changes the answer:
   * installing, activating or disabling a plugin and then going elsewhere.
   */
  useEffect(() => {
    const ctrl = new AbortController()
    let disposed = false
    void (async () => {
      const body = await fetch(`${coreBase()}/api/plugins/ui`, { signal: ctrl.signal })
        .then((r) => r.json())
        .catch(() => null)
      if (disposed) return
      // Parsed, never `as`-cast: a 404 or 403 body is a perfectly valid JSON
      // document that simply is not this shape, and `safeParse` is what turns
      // that into "no plugin group" instead of a render-time throw.
      const parsed = PluginNavResponseSchema.safeParse(body)
      setPluginNav(parsed.success ? parsed.data.items : [])
    })()
    return () => {
      disposed = true
      ctrl.abort()
    }
  }, [pathname])

  if (framed) {
    // Fills the iframe exactly: no rail, no status bar, no outer padding —
    // the panel chrome around this document already belongs to `PipPanel`.
    return <PagePanel className="h-screen rounded-none border-0">{children}</PagePanel>
  }

  return (
    <div
      // `bg-bg` again, and it is correct again. Block D used to redeclare
      // `--color-bg` after block B had mapped it to the handoff's `var(--bg)`,
      // and the later declaration won, so this had to read the variable
      // directly through an inline style to get the theme's own page colour.
      // That redeclaration is deleted; the utility resolves to `var(--bg)`
      // like every other handoff name here.
      className="flex h-screen min-h-[460px] gap-[10px] overflow-hidden bg-bg p-[10px] font-sans text-row text-text"
    >
      <Rail
        pathname={pathname}
        pluginItems={pluginNavItems(pluginNav)}
        activeView={activePluginView(pathname, searchParams)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-[10px]">
        <PagePanel>{children}</PagePanel>
        <StatusBar />
      </div>
      {/* A sibling of the page COLUMN above, not a child of it (plan 501
          §3.4) — so the right panel spans the status bar's height too,
          rather than leaving a notch of background beside it. It reads the
          one panel store itself and renders nothing unless the current
          request is in `side` mode; the floating host below does the same
          for `pip` mode. */}
      <SidePanel />
      <PipHost />
    </div>
  )
}
