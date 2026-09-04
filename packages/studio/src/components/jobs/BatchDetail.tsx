'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { BatchResponseSchema, BatchWithJobsResponseSchema, type BatchInfo, type JobInfo } from '@enkaku/protocol'
import { ArrowsClockwiseIcon, EmptyState, ErrorState, ExportIcon, ListDashesIcon, LoadingRows, PlayIcon, SignInIcon, api, cn, duration } from '@enkaku/ui'
import { toast } from 'sonner'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'
import { STATE_DOT, batchState, clockTime, jobHref, jobSubLine } from './job-view'
import { JsonSnapshot } from './JsonSnapshot'
import { DetailHeader, type HeaderAction } from './DetailHeader'
import { SubTabs, type SubTab } from './SubTabs'

/**
 * The Batches tab's own detail (plan 218 §3.10) — the same chrome as the job
 * detail, deliberately smaller: a batch has no logs, trace or artifacts of
 * its own; every one of those belongs to a member job, one click away.
 * "Jobs and batches share one page — same shape, different scope"
 * (design handoff, "Screen: Jobs").
 */
export function BatchDetail({ batchId }: { batchId: string }) {
  const [batch, setBatch] = useState<BatchInfo | null>(null)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const now = useNow()
  const params = useSearchParams()
  const view = params.get('view') === 'members' ? 'members' : 'inputs'

  function load(): void {
    setError(null)
    void api(`/api/batches/${batchId}`, BatchWithJobsResponseSchema)
      .then((b) => {
        setBatch(b.batch)
        setJobs(b.jobs)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    setBatch(null)
    setJobs([])
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId])

  useEffect(() => {
    const off = ws.on((m) => {
      if (m.type === 'batch.status' && m.payload.batchId === batchId) {
        setBatch((p) => (p ? { ...p, status: m.payload.status, counts: m.payload.counts } : p))
      } else if (m.type === 'job.status' && jobs.some((j) => j.jobId === m.payload.jobId)) {
        setJobs((p) => p.map((j) => (j.jobId === m.payload.jobId ? { ...j, ...m.payload } : j)))
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, jobs])

  if (error) return <ErrorState message={error} onRetry={load} />
  if (!batch) {
    return (
      <div className="p-[14px]">
        <LoadingRows rows={4} />
      </div>
    )
  }

  const done = batch.counts.success + batch.counts.failed + batch.counts.cancelled
  const actions: HeaderAction[] = [
    {
      key: 'rerun',
      label: 'Re-run',
      icon: <PlayIcon className="size-[13px]" />,
      primary: true,
      onClick: () => {
        void api(`/api/batches/${batchId}/rerun`, BatchResponseSchema, { method: 'POST' })
          .then(() => {
            toast.success('Added a run to every member job')
            load()
          })
          .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      },
    },
    {
      key: 'rerun-failed',
      label: 'Re-run failed',
      icon: <ArrowsClockwiseIcon className="size-[13px]" />,
      disabled: batch.counts.failed === 0,
      disabledReason: batch.counts.failed === 0 ? 'No member failed' : undefined,
      onClick: () => {
        void api(`/api/batches/${batchId}/rerun-failed`, BatchResponseSchema, { method: 'POST' })
          .then(() => {
            toast.success('Added a run to every member whose latest run failed')
            load()
          })
          .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      },
    },
    {
      key: 'export',
      label: 'Export',
      icon: <ExportIcon className="size-[13px]" />,
      onClick: () => {
        const blob = new Blob([JSON.stringify({ batch, jobs }, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${batch.scriptName ?? 'batch'}-${batch.id.slice(0, 8)}.json`
        a.click()
        URL.revokeObjectURL(url)
      },
    },
  ]

  const tabs: SubTab[] = [
    { key: 'inputs', label: 'Inputs', icon: <SignInIcon className="size-[14px]" />, href: `/jobs?tab=batches&job=${batchId}` },
    {
      key: 'members',
      label: 'Members',
      icon: <ListDashesIcon className="size-[14px]" />,
      href: `/jobs?tab=batches&job=${batchId}&view=members`,
    },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader
        name={batch.scriptName ?? batch.id}
        state={batchState(batch.status)}
        meta={
          <>
            <span className="flex-none font-mono">{batch.id.slice(0, 12)}</span>
            <span className="flex-none">·</span>
            <span className="flex-none">
              {batch.counts.total} device{batch.counts.total === 1 ? '' : 's'} · {done}/{batch.counts.total}
              {batch.counts.failed ? ` · ${batch.counts.failed} failed` : ''}
            </span>
            <span className="flex-none">·</span>
            <span className="flex-none">{clockTime(batch.createdAt)}</span>
            <span className="flex-none">·</span>
            <span className="flex-none">{duration(batch.createdAt, batch.finishedAt, now)}</span>
          </>
        }
        actions={actions}
      />
      <SubTabs tabs={tabs} active={view} />
      <div className="min-h-0 flex-1 overflow-auto">
        {view === 'inputs' ? (
          <JsonSnapshot title="Input snapshot" moment="captured at dispatch" value={batch.params} />
        ) : jobs.length === 0 ? (
          <div className="p-[14px]">
            <EmptyState title="No members" description="This batch dispatched to no device." />
          </div>
        ) : (
          <div className="px-2 pt-2 pb-3">
            {jobs.map((j) => (
              <Link key={j.jobId} href={jobHref(j.jobId)} className="flex items-center gap-[10px] rounded-button px-2 py-[9px] hover:bg-muted">
                <span className={cn('size-[7px] flex-none rounded-pill', STATE_DOT[j.status])} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px]">{j.deviceId.slice(0, 12)}</div>
                  <div className="mt-1 truncate pl-[14px] text-label text-faint">{jobSubLine(j, now)}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
