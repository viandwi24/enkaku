'use client'

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, cn } from '@enkaku/ui'

export interface EntityTab {
  key: string
  label: string
  /** Shown as a small count next to the label, like GitHub's issue counts. */
  count?: number | null
  /**
   * When set, the tab renders disabled (not a dead-looking but still
   * clickable link — design.md's quality floor) with this text in a
   * tooltip explaining why (plan 56 §5.8 — a node-owned device has no
   * local inspector to attach to).
   */
  disabledReason?: string
  /**
   * A danger marker beside the label, with this text as its tooltip — for the
   * one thing a tab strip is otherwise bad at: a panel that is not on screen
   * and is in trouble. `/plugins` keeps BOTH of its panels mounted and loading
   * precisely so this can be true (a `/api/scripts` 500 behind a closed tab
   * would otherwise be silent), and this is where that fact surfaces.
   *
   * Distinct from `disabledReason`: an alerting tab is still fully reachable —
   * it is the tab you most want to click.
   */
  alert?: string
}

/**
 * Sub-navigation for one entity, in the pattern every tool with deep objects
 * settles on (GitHub's Code / Issues / Actions / Settings).
 *
 * The point is not decoration: a device carries live control, its job history,
 * and its configuration. Those are separate tasks with separate mental modes,
 * and stacking them on one page means the person doing one of them has to
 * scroll past the other two.
 *
 * The active tab lives in the URL (`?tab=`) rather than component state, so a
 * tab is linkable, survives a reload, and works with the back button. A query
 * param rather than a route segment because Studio is a static export.
 */
export function EntityTabs({
  tabs,
  active,
  hrefFor,
}: {
  tabs: EntityTab[]
  active: string
  hrefFor: (key: string) => string
}) {
  return (
    <div className="border-b px-5">
      <nav className="-mb-px flex gap-1" aria-label="Sections">
        {tabs.map((t) => {
          const isActive = t.key === active
          if (t.disabledReason) {
            return (
              <Tooltip key={t.key}>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    aria-disabled="true"
                    className="flex cursor-not-allowed items-center gap-2 border-b-2 border-transparent px-3 py-2.5 text-[13px] text-fg-subtle"
                  >
                    {t.label}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t.disabledReason}</TooltipContent>
              </Tooltip>
            )
          }
          return (
            <Link
              key={t.key}
              href={hrefFor(t.key)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] transition-colors',
                isActive
                  ? 'border-accent font-medium text-fg'
                  : 'border-transparent text-fg-muted hover:border-line-strong hover:text-fg',
              )}
            >
              {t.label}
              {t.count !== null && t.count !== undefined && (
                <span className="readout rounded-full bg-surface-2 px-1.5 text-[10.5px] text-fg-muted">{t.count}</span>
              )}
              {/* A native `title`, not a Radix `Tooltip`: this strip is rendered
                  by pages that are mounted without a `TooltipProvider` (the
                  `disabledReason` branch above is only used inside `AppShell`,
                  which supplies one), and a marker that throws is worse than a
                  marker with a plainer tooltip. */}
              {t.alert && (
                <span className="flex items-center text-led-danger" title={t.alert} aria-label={t.alert}>
                  <AlertTriangle className="size-3.5" aria-hidden />
                </span>
              )}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
