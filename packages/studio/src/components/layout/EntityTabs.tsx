'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'

export interface EntityTab {
  key: string
  label: string
  /** Shown as a small count next to the label, like GitHub's issue counts. */
  count?: number | null
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
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
