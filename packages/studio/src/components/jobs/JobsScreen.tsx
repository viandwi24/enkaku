'use client'

import { useSearchParams } from 'next/navigation'
import { EmptyState } from '@enkaku/ui'
import { useJobCounts } from '@/lib/use-job-counts'
import { BatchDetail } from './BatchDetail'
import { JobDetail } from './JobDetail'
import { JobsSidebar } from './JobsSidebar'
import { JobsTabStrip, type JobsTab } from './JobsTabStrip'
import { useActionDialogs } from '@/components/actions/ActionDialogHost'

/**
 * Jobs (design handoff, "Screen: Jobs"): the tab strip that IS the page
 * header, a 268px left list, and a right detail — one panel, two tabs, no
 * second route (plan 218 §3.3).
 */
export function JobsScreen() {
  const params = useSearchParams()
  const raw = params.get('tab')
  const tab: JobsTab = raw === 'batches' ? 'batches' : raw === 'workflows' ? 'workflows' : 'jobs'
  const jobId = params.get('job')
  const counts = useJobCounts()
  const { open } = useActionDialogs()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <JobsTabStrip
        tab={tab}
        jobCount={counts.jobs}
        batchCount={counts.batches}
        workflowCount={counts.workflows}
        /*
          A batch is a script run across several devices — the run-script
          dialog's own Concurrency and Order fields ARE the batch controls, so
          there is no second dialog to build and no second door to keep in
          step. The target starts empty and the dialog's device picker is
          where it gets chosen, which is the only sensible answer on a screen
          that lists runs rather than devices.
        */
        onRun={(t) =>
          // `explicit` on the Batches tab: the operator asked for a batch by
          // name, so a one-device run still lands on this tab rather than
          // vanishing into Jobs (`batches.explicit`).
          open(t === 'workflows' ? 'run-workflow' : 'run-script', { deviceIds: [] }, t === 'batches' ? { explicit: true } : undefined)
        }
      />
      <div className="flex min-h-0 flex-1">
        <JobsSidebar tab={tab} selectedId={jobId} counts={counts} />
        {/*
          `min-w-0`: a flex item defaults to `min-width: auto`, so it refuses
          to shrink below its content — the timeline's wide strip pushed this
          whole pane past the viewport instead of scrolling inside it, and no
          `overflow-x` further in could ever fire (owner, 2026-09-05).
        */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!jobId ? (
            <div className="p-[14px]">
              <EmptyState
                title={tab === 'workflows' ? 'Select a workflow run' : 'Select a job'}
                description={
                  tab === 'workflows'
                    ? 'Pick a run to replay its pipeline: the graph it took, every step in order, and what each one produced.'
                    : 'Pick a job from the list to read its inputs, output, logs, timeline and artifacts.'
                }
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
