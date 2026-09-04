'use client'

import { useSearchParams } from 'next/navigation'
import { EmptyState } from '@enkaku/ui'
import { useJobCounts } from '@/lib/use-job-counts'
import { BatchDetail } from './BatchDetail'
import { JobDetail } from './JobDetail'
import { JobsSidebar } from './JobsSidebar'
import { JobsTabStrip, type JobsTab } from './JobsTabStrip'

/**
 * Jobs (design handoff, "Screen: Jobs"): the tab strip that IS the page
 * header, a 268px left list, and a right detail — one panel, two tabs, no
 * second route (plan 218 §3.3).
 */
export function JobsScreen() {
  const params = useSearchParams()
  const tab: JobsTab = params.get('tab') === 'batches' ? 'batches' : 'jobs'
  const jobId = params.get('job')
  const counts = useJobCounts()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <JobsTabStrip tab={tab} jobCount={counts.jobs} batchCount={counts.batches} />
      <div className="flex min-h-0 flex-1">
        <JobsSidebar tab={tab} selectedId={jobId} counts={counts} />
        <div className="flex min-h-0 flex-1 flex-col">
          {!jobId ? (
            <div className="p-[14px]">
              <EmptyState
                title="Select a job"
                description="Pick a job from the list to read its inputs, output, logs, timeline and artifacts."
              />
            </div>
          ) : tab === 'batches' ? (
            <BatchDetail batchId={jobId} />
          ) : (
            <JobDetail jobId={jobId} />
          )}
        </div>
      </div>
    </div>
  )
}
