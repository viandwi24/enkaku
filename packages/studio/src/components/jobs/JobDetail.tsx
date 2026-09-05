'use client'

import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  DeviceMobileIcon,
  EmptyState,
  ErrorState,
  ExportIcon,
  FilmStripIcon,
  ImagesIcon,
  ListDashesIcon,
  LoadingRows,
  PlayIcon,
  SignInIcon,
  SignOutIcon,
  duration,
} from '@enkaku/ui'
import { toast } from 'sonner'
import { useNow } from '@/lib/useNow'
import { useJobDetail } from '@/lib/use-job-detail'
import { deviceRefLabel } from '@/lib/api'
import { ActionRefusedError, runOnDevice } from '@/lib/actions'
import { clockTime, jobHref } from './job-view'
import { DetailHeader, type HeaderAction } from './DetailHeader'
import { RunPicker } from './RunPicker'
import { SubTabs, type SubTab } from './SubTabs'
import { RunCompare } from './RunCompare'
import { JsonSnapshot } from './JsonSnapshot'
import { LogsTab } from './LogsTab'
import { ArtifactsTab } from './ArtifactsTab'
import { WorkflowSteps } from './WorkflowSteps'
import { Timeline } from './timeline/Timeline'

/**
 * The right detail for a JOB (design handoff, "Screen: Jobs", "Right
 * detail"). Composes, in order: the header (run picker, meta line, three
 * actions), the sub-tab strip, the failure line (this plan's own addition,
 * §3.11), and the body for the current `?view=` — or `RunCompare` when
 * `?compare=` is set.
 */
export function JobDetail({ jobId }: { jobId: string }) {
  const params = useSearchParams()
  const view = params.get('view') ?? 'inputs'
  const runId = params.get('run')
  const compareRunId = params.get('compare')
  const now = useNow()

  const { job, runs, run, deviceRef, artifacts, logs, logsTruncated, logsPhase, steps, stepsFinalized, error, reload } = useJobDetail(
    jobId,
    runId,
  )

  if (error) {
    return (
      <div className="p-[14px]">
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }
  if (!job) {
    return (
      <div className="p-[14px]">
        <LoadingRows rows={6} />
      </div>
    )
  }
  if (job.runCount === 0 || !run) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailHeader
          name={job.scriptName ?? job.jobId}
          state="queued"
          meta={<span className="truncate">{job.jobId.slice(0, 12)}</span>}
          actions={[]}
        />
        <div className="p-[14px]">
          <EmptyState
            title="This job has no runs"
            description="Every run of this job has been swept by the retention window. The job itself is kept because a schedule owns it or because it is a step of a workflow job."
          />
        </div>
      </div>
    )
  }

  async function rerun(): Promise<void> {
    if (!job) return
    try {
      if (job.kind === 'workflow') {
        await runOnDevice('run-workflow', job.deviceId, { workflowName: job.scriptName ?? '', params: job.params, jobId: job.jobId })
      } else {
        await runOnDevice('run-script', job.deviceId, {
          scriptId: job.scriptId,
          params: job.params,
          jobId: job.jobId,
          concurrency: 0,
          order: 'as-listed',
        })
      }
      toast.success('Run added', {
        description: `${job.scriptName ?? 'This job'} is queued as run ${runs.length + 1}. The job list does not gain a row.`,
      })
      reload()
    } catch (e) {
      if (e instanceof ActionRefusedError) toast.error(e.message)
      else toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  function exportJson(): void {
    if (!job) return
    const doc = { job, run, runs, logs, artifacts }
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${job.scriptName ?? 'job'}-${job.jobId.slice(0, 8)}-run${run?.seq ?? 0}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const runInFlight = run.status === 'running' || run.status === 'queued'
  const actions: HeaderAction[] = [
    {
      key: 'rerun',
      label: 'Re-run',
      icon: <PlayIcon className="size-[13px]" />,
      primary: true,
      disabled: runInFlight,
      disabledReason: runInFlight ? 'Cancel the running run first' : undefined,
      onClick: () => void rerun(),
    },
    {
      key: 'open-device',
      label: 'Open device',
      icon: <DeviceMobileIcon className="size-[13px]" />,
      disabled: deviceRef?.deleted ?? false,
      disabledReason: deviceRef?.deleted ? 'This device was forgotten' : undefined,
      href: `/?device=${encodeURIComponent(job.deviceId)}`,
    },
    { key: 'export', label: 'Export', icon: <ExportIcon className="size-[13px]" />, onClick: exportJson },
  ]

  const tabs: SubTab[] = [
    { key: 'inputs', label: 'Inputs', icon: <SignInIcon className="size-[14px]" />, href: jobHref(jobId, { view: 'inputs', run: runId ?? undefined }) },
    { key: 'output', label: 'Output', icon: <SignOutIcon className="size-[14px]" />, href: jobHref(jobId, { view: 'output', run: runId ?? undefined }) },
    { key: 'logs', label: 'Logs', icon: <ListDashesIcon className="size-[14px]" />, href: jobHref(jobId, { view: 'logs', run: runId ?? undefined }) },
    {
      key: 'timeline',
      label: 'Timeline',
      icon: <FilmStripIcon className="size-[14px]" />,
      href: jobHref(jobId, { view: 'timeline', run: runId ?? undefined }),
    },
    {
      key: 'artifacts',
      label: 'Artifacts',
      icon: <ImagesIcon className="size-[14px]" />,
      href: jobHref(jobId, { view: 'artifacts', run: runId ?? undefined }),
    },
  ]

  const meta = (
    <>
      <RunPicker jobId={job.jobId} runs={runs} currentRunId={run.runId} compareRunId={compareRunId} />
      <span>·</span>
      {job.parentWorkflowJobId !== null && (
        <>
          <Link href={jobHref(job.parentWorkflowJobId)} className="flex-none hover:underline">
            step {(job.stepSeq ?? 0) + 1} of workflow job {job.parentWorkflowJobId.slice(0, 8)}
          </Link>
          <span>·</span>
        </>
      )}
      <span className="flex-none font-mono">{job.jobId.slice(0, 12)}</span>
      <span>·</span>
      <span className="flex-none">{deviceRefLabel(deviceRef, job.deviceId)}</span>
      <span>·</span>
      <span className="flex-none">{run.trigger}</span>
      <span>·</span>
      <span className="flex-none">{clockTime(run.createdAt)}</span>
      <span>·</span>
      <span className="flex-none">{run.status === 'running' ? `running ${duration(run.startedAt, null, now)}` : duration(run.startedAt, run.finishedAt, now)}</span>
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader name={job.scriptName ?? job.jobId} state={run.status} meta={meta} actions={actions} />
      <SubTabs tabs={tabs} active={view} />
      {run.status === 'failed' && (
        <div className="flex flex-none flex-wrap items-baseline gap-x-2 border-b border-line bg-danger-soft px-[14px] py-2 text-meta text-danger">
          <span className="font-semibold">
            {run.errorPhase ? `Failed during ${run.errorPhase}` : 'Failed'}
            {run.failureClass ? ` · ${run.failureClass}` : ''}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono">{run.error ?? 'no message was recorded'}</span>
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {compareRunId ? (
          <RunCompare jobId={jobId} runId={run.runId} compareRunId={compareRunId} view={view} />
        ) : view === 'inputs' ? (
          <JsonSnapshot title="Input snapshot" moment="captured at start" value={job.params} />
        ) : view === 'output' ? (
          <JsonSnapshot
            title="Output snapshot"
            moment="captured at exit"
            value={run.result}
            bytes={run.resultBytes}
            status={run.resultStatus}
            issues={run.resultIssues}
          />
        ) : view === 'logs' ? (
          <LogsTab logs={logs} truncated={logsTruncated} phase={logsPhase} />
        ) : view === 'timeline' ? (
          job.kind === 'workflow' ? (
            <WorkflowSteps steps={steps} finalized={stepsFinalized} jobId={job.jobId} runId={run.runId} doc={job.workflowDoc} />
          ) : (
            <Timeline jobId={job.jobId} runId={run.runId} runStatus={run.status} />
          )
        ) : (
          <ArtifactsTab artifacts={artifacts} />
        )}
      </div>
    </div>
  )
}
