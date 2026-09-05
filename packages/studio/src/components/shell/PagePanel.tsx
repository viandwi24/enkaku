import type { ReactNode } from 'react'
import { cn } from '@enkaku/ui'

/**
 * The one page panel (design handoff, "Global shell"): "Page panels all share:
 * `flex: 1; background: var(--panel); border: 1px solid var(--border);
 * border-radius: 16px; overflow: hidden`."
 *
 * `relative flex min-h-0 flex-col` is this plan's addition and is not
 * decoration: `overflow: hidden` on a flex child needs `min-h-0` to stop the
 * content forcing the panel taller than the viewport, and the column plus
 * `relative` are what the handoff's own screens assume (a 58px toolbar over a
 * scroller, with the bulk pill and Device Control positioned against the
 * panel). The prototype's root panel has all three.
 *
 * **`overflow-hidden` stays, and a page that does not scroll itself must say
 * so.** Hidden is right for the screens the handoff drew — Jobs and Devices
 * own their scrolling internally, a sidebar and a detail pane moving
 * independently — but it is a trap for every screen that does not: a plain
 * document page has nothing to scroll and its content is simply cut off. The
 * proxy-manager plugin view needed 737px in a 384px panel with not one
 * scrollable element anywhere on the page (measured, owner report
 * 2026-09-06).
 *
 * Turning this to `overflow-y-auto` was tried and reverted: it fixes the
 * document pages and breaks the self-scrolling ones, which then overflow the
 * panel by 200px ON TOP of their own two scrollers — a second scrollbar for
 * the same content. The screens that manage their own scrolling are the
 * reason this is hidden; the fix belongs in the pages that do not.
 *
 * There is NO page title here, deliberately. The handoff puts each screen's
 * header inside its own panel and says so for Jobs: "The tab strip **is** the
 * page header (no separate 'Jobs / N total' title above it)."
 */
export function PagePanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-border bg-panel',
        className,
      )}
    >
      {children}
    </div>
  )
}
