'use client'

import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { JobStatusBadge } from '@/components/StatusBadge'
import { JobArtifactsPanel } from '@/components/jobs/JobArtifactsPanel'
import Link from 'next/link'
import { JobLogsPanel } from '@/components/jobs/JobLogsPanel'
import { JobResultSection } from '@/components/jobs/JobResultSection'
import { ErrorState, LoadingRows, Button, Tabs, TabsContent, TabsList, TabsTrigger, duration, relativeTime } from '@enkaku/ui'
import { useJobDetail } from '@/lib/use-job-detail'
import { useNow } from '@/lib/useNow'

/**
 * The device popup's own job DETAIL — plan 103 §9 Q2, answered 2026-08-16,
 * closing step 103.11's audit row 4 ("the Jobs popup lists jobs and stops
 * there"). §9 Q2's own recommendation is what shipped: **in place, with a
 * back affordance** — never a link to `/jobs/detail`, which is a different
 * route and would unmount the Wall this whole popup floats over (plan 103
 * §3.2's own reasoning, already why `JobsList`'s `linkToDetail={false}`
 * exists here).
 *
 * Reuses exactly what `/jobs/detail` reuses now, through the SAME data hook
 * and the SAME four presentational pieces (`lib/use-job-detail.ts`,
 * `components/jobs/`) — result view (with its `invalid`/`partial`/
 * `oversize` banners), params, logs, and artifacts. Nothing here is a
 * thinner re-derivation: it is the identical `ResultView`/`planResult`
 * resolver, the identical three-way log merge, the identical artifact
 * split. What stays page-only (workflow node timeline, lineage, assist
 * history, the farm memory-limit row) is named, not silently dropped — a
 * device's own job history is short and mostly about what the run did, not
 * its place in a trigger chain.
 */
export function JobDetailPanel({
  jobId,
  onBack,
  backLabel = 'Back to jobs',
  /**
   * Offer a link out to `/jobs/detail`. **Default `false`, and that default is
   * load-bearing.**
   *
   * This panel's first home is the device popup, which floats OVER the Wall
   * (plan 103 §3.2). A `next/link` there is a route change that unmounts the
   * Wall and the popup with it — the one thing a read popup must not do (§3.3),
   * and `ReadPopups.test.tsx` asserts the popup contains no links at all. This
   * link was added unconditionally on 2026-08-28 and that test caught it
   * immediately.
   *
   * The batch sheet passes `true`: leaving a batch page for a job page is an
   * ordinary navigation, and there the link is the only route to what the panel
   * does not carry (the trace timeline, the params block, the crash view).
   */
  linkToFullPage = false,
}: {
  jobId: string
  onBack: () => void
  backLabel?: string
  linkToFullPage?: boolean
}) {
  const { job, produced, images, files, crashTraceArtifact, logs, logsTruncated, logsPhase, error, load } = useJobDetail(jobId)
  const [tab, setTab] = useState('summary')
  const now = useNow()

  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={onBack}>
        <ArrowLeft className="size-3.5" aria-hidden />
        {backLabel}
      </Button>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !job ? (
        <LoadingRows rows={3} />
      ) : (
        <>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium">
                {job.scriptName ? `${job.scriptName}@${job.scriptVersion ?? '?'}` : job.scriptId}
              </span>
              <JobStatusBadge status={job.status} />
            </div>
            {linkToFullPage && (
              <Link href={`/jobs/detail?id=${job.jobId}`} className="block text-[11.5px] text-fg-muted hover:text-accent hover:underline">
                Open the full job page
              </Link>
            )}
            <p className="readout text-[11px] text-fg-subtle">
              {relativeTime(job.createdAt, now)} queued
              {job.startedAt ? ` → ${relativeTime(job.startedAt, now)} started` : ''}
              {job.finishedAt ? ` → ${relativeTime(job.finishedAt, now)} finished` : ''}
              {job.startedAt && <> · ran {duration(job.startedAt, job.finishedAt, now)}</>}
            </p>
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="w-full">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="logs">{logs.length > 0 ? `Logs (${logs.length})` : 'Logs'}</TabsTrigger>
              <TabsTrigger value="artifacts">{produced.length > 0 ? `Artifacts (${produced.length})` : 'Artifacts'}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="pt-2">
              <JobResultSection
                job={job}
                finished={['success', 'failed', 'cancelled', 'expired'].includes(job.status)}
                crashTraceArtifact={crashTraceArtifact}
              />
            </TabsContent>
            <TabsContent value="logs" className="pt-2">
              <JobLogsPanel logs={logs} truncated={logsTruncated} phase={logsPhase} />
            </TabsContent>
            <TabsContent value="artifacts" className="pt-2">
              <JobArtifactsPanel images={images} files={files} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
