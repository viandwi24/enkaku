'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { BatchResponseSchema, BatchWithJobsResponseSchema, type BatchInfo, type JobInfo } from '@enkaku/protocol'
import { ArrowsClockwiseIcon, Button, DeviceName, EmptyState, ErrorState, ExportIcon, ListDashesIcon, LoadingRows, PlayIcon, SignInIcon, api, cn, duration } from '@enkaku/ui'
import { toast } from 'sonner'
import { fetchDevices } from '@/lib/api'
import { runOnDevice } from '@/lib/actions'
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
  /**
   * `deviceId` → the operator's own name for it.
   *
   * The members list showed `deviceId.slice(0, 12)` — the first twelve
   * characters of a UUID. Nobody has ever matched a phone on a rack to
   * `fcf03c6a-bf1`, and the number that IS on the rack was two fields away
   * the whole time. One read for the batch, never one per row.
   */
  const [deviceNames, setDeviceNames] = useState<Map<string, { number: number | null; label: string }>>(new Map())
  const [rerunning, setRerunning] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const now = useNow()
  const params = useSearchParams()
  const view = params.get('view') === 'members' ? 'members' : 'inputs'

  useEffect(() => {
    let cancelled = false
    void fetchDevices()
      .then((rows) => {
        if (!cancelled) setDeviceNames(new Map(rows.map((d) => [d.id, { number: d.number, label: d.label }])))
      })
      // A name is a courtesy: a batch whose device list cannot be read still
      // shows every member, by id, rather than showing nothing.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Re-run ONE member. The header's "Re-run failed" covers the whole batch in
   * one click, which is the right tool for eight failures out of twenty; this
   * is for the one device an operator wants to try again on its own, and it
   * goes through the same door a job's own Re-run button uses — a new RUN on
   * the existing job, never a new job row.
   */
  async function rerunOne(job: JobInfo, batchParams: unknown): Promise<void> {
    setRerunning((prev) => new Set(prev).add(job.jobId))
    try {
      // The BATCH's params, not the job's: a member of a batch ran with them
      // by construction, and `JobInfo` in this list does not carry its own
      // (the job detail fetches a fuller shape for exactly that reason).
      const params = (batchParams ?? {}) as Record<string, unknown>
      if (job.kind === 'workflow') {
        await runOnDevice('run-workflow', job.deviceId, { workflowName: job.scriptName ?? '', params, jobId: job.jobId })
      } else {
        await runOnDevice('run-script', job.deviceId, { scriptId: job.scriptId, params, jobId: job.jobId, concurrency: 0, order: 'as-listed' })
      }
      toast.success(`Queued again on ${deviceNames.get(job.deviceId)?.label ?? job.deviceId.slice(0, 8)}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setRerunning((prev) => {
        const next = new Set(prev)
        next.delete(job.jobId)
        return next
      })
    }
  }

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
          /*
            A table, because the question an operator brings to this screen is
            "which ones worked" — and a list of links answers it one row at a
            time. Device, outcome, how long, and what went wrong, side by side
            so twenty rows read at a glance (owner, 2026-09-06).
          */
          <div className="px-2 pt-2 pb-3">
            <div className="grid grid-cols-[16px_1.2fr_84px_84px_1.6fr_92px] items-center gap-x-2 border-b border-line px-2 pb-1.5 text-label font-medium text-faint">
              <span />
              <span>Device</span>
              <span>Status</span>
              <span>Duration</span>
              <span>Result</span>
              <span />
            </div>
            {jobs.map((j) => {
              const name = deviceNames.get(j.deviceId)
              const failed = j.status === 'failed'
              return (
                <div
                  key={j.jobId}
                  className="grid grid-cols-[16px_1.2fr_84px_84px_1.6fr_92px] items-center gap-x-2 border-b border-muted-2 px-2 py-[9px] transition-colors hover:bg-muted"
                >
                  <span className={cn('size-[7px] flex-none rounded-pill', STATE_DOT[j.status])} aria-hidden />
                  <Link href={jobHref(j.jobId)} className="min-w-0 truncate text-row text-text hover:underline">
                    {name ? <DeviceName number={name.number} label={name.label} /> : <span className="font-mono text-[12px]">{j.deviceId.slice(0, 12)}</span>}
                  </Link>
                  <span className="truncate text-body text-dim">{j.status}</span>
                  <span className="truncate text-body text-dim tabular-nums">{duration(j.startedAt ?? j.createdAt, j.finishedAt, now)}</span>
                  {/* The error verbatim, on one line — a batch screen is for
                      finding WHICH device broke, and the full text is one
                      click away on the job itself. */}
                  <span className={cn('min-w-0 truncate text-body', failed ? 'text-danger' : 'text-faint')} title={j.error ?? undefined}>
                    {j.error ?? jobSubLine(j, now)}
                  </span>
                  <span className="flex justify-end">
                    {failed && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rerunning.has(j.jobId)}
                        onClick={() => void rerunOne(j, batch.params)}
                      >
                        <ArrowsClockwiseIcon className="size-3.5" aria-hidden />
                        {rerunning.has(j.jobId) ? 'Queuing…' : 'Re-run'}
                      </Button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
