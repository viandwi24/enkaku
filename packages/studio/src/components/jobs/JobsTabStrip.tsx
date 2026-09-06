'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '@/lib/tab-href'
import { Button, PlayIcon, cn } from '@enkaku/ui'

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
export type JobsTab = 'jobs' | 'batches' | 'workflows'

export function JobsTabStrip({
  tab,
  jobCount,
  batchCount,
  workflowCount,
  onRun,
}: {
  tab: JobsTab
  jobCount: number | null
  batchCount: number | null
  workflowCount: number | null
  /** Starts whatever the ACTIVE tab lists — a script, a workflow, or a batch. */
  onRun: (tab: JobsTab) => void
}) {
  /*
   * Three, not two. A workflow run is not a script job with a different name
   * — it is a pipeline over several of them, it fails in ways a script
   * cannot, and reading its history means reading its graph. Mixing the two
   * lists made a farm's job list mostly noise and gave pipelines nowhere of
   * their own (owner, 2026-09-05). The Jobs tab now excludes them; the
   * scripts a workflow ran stay there, which is right — those really are
   * ordinary jobs, and that is where an operator looks for one.
   */
  const params = useSearchParams()
  const hrefFor = (key: JobsTab) => tabHref('/jobs', params, key)

  const tabs: ReadonlyArray<{ key: JobsTab; label: string; count: number | null; href: string }> = [
    { key: 'jobs', label: 'Jobs', count: jobCount, href: hrefFor('jobs') },
    { key: 'workflows', label: 'Workflows', count: workflowCount, href: hrefFor('workflows') },
    { key: 'batches', label: 'Batches', count: batchCount, href: hrefFor('batches') },
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
      {/*
        The way IN, on the screen that lists what came out. Every one of these
        three could only be started from somewhere else — the Devices screen,
        or a script's own row — so an operator reading a job list had to leave
        it to run another one (owner, 2026-09-06).

        Right-aligned on the tab row rather than a header of its own, because
        the tab strip IS this page's header (design handoff, "Screen: Jobs":
        no separate title above it) — the same shape Scripts & workflows
        already uses for New workflow. The label names the ACTIVE tab, so the
        button always starts the kind of thing the list below it holds.
      */}
      <div className="flex-1" />
      <Button size="sm" onClick={() => onRun(tab)}>
        <PlayIcon className="size-3.5" aria-hidden />
        {RUN_LABEL[tab]}
      </Button>
    </div>
  )
}

const RUN_LABEL: Record<JobsTab, string> = {
  jobs: 'Run script',
  workflows: 'Run workflow',
  batches: 'Run batch',
}
