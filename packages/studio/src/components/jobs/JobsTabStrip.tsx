'use client'

import Link from 'next/link'
import { cn } from '@enkaku/ui'

/**
 * The tab strip IS the page header (design handoff, "Screen: Jobs": "The tab
 * strip **is** the page header (no separate 'Jobs / N total' title above
 * it): `padding: 10px 14px`, `border-bottom: 1px solid var(--line)`, tabs
 * **Jobs** (63) and **Batches** (21) with counts"). There is deliberately no
 * <h1> here and none in the page panel above it.
 *
 * A `next/link` per tab, not a button: the tab is the address (plan 218
 * §3.3), and a plain <a> would remount React (`CLAUDE.md`).
 */
export type JobsTab = 'jobs' | 'batches'

export function JobsTabStrip({ tab, jobCount, batchCount }: { tab: JobsTab; jobCount: number | null; batchCount: number | null }) {
  const tabs: ReadonlyArray<{ key: JobsTab; label: string; count: number | null; href: string }> = [
    { key: 'jobs', label: 'Jobs', count: jobCount, href: '/jobs' },
    { key: 'batches', label: 'Batches', count: batchCount, href: '/jobs?tab=batches' },
  ]
  return (
    <div className="flex flex-none items-center gap-[3px] border-b border-line px-[14px] py-[10px]">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === tab ? 'page' : undefined}
          className={cn(
            'flex flex-none items-center gap-[7px] rounded-input px-3 py-[7px] text-row transition-colors',
            t.key === tab ? 'bg-accent-soft font-semibold text-accent' : 'font-medium text-faint hover:text-text',
          )}
        >
          {t.label}
          {/* Null, not zero, while the count has not settled or its read failed:
              a farm with no jobs and a farm whose count could not be read must
              not look the same (plan 218 §4.3.3). */}
          {t.count !== null && <span className="text-label font-normal opacity-65">{t.count}</span>}
        </Link>
      ))}
    </div>
  )
}
