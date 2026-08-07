'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import {
  BatchCancelResponseSchema,
  BatchResponseSchema,
  BatchWithJobsResponseSchema,
  type BatchInfo,
  type DeviceInfo,
  type JobInfo,
} from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { JobsList } from '@/components/JobsList'
import { PaginatedTable, type Page, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { TableCell, TableHead } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { deviceRefLabel, fetchDeviceRefs, fetchDevices, type DeviceRef } from '@/lib/api'
import { duration, relativeTime } from '@/lib/format'
import { ws } from '@/lib/ws'

const STATUS_TONE: Record<BatchInfo['status'], string> = {
  queued: 'text-fg-muted border-line bg-transparent',
  running: 'text-led-active border-led-active/35 bg-led-active/10',
  success: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  failed: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  cancelled: 'text-led-warn border-led-warn/35 bg-led-warn/10',
}

function BatchStatusBadge({ status }: { status: BatchInfo['status'] }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap ${STATUS_TONE[status]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {status}
    </span>
  )
}

function BatchDetail() {
  const batchId = useSearchParams().get('id')
  const router = useRouter()
  const [batch, setBatch] = useState<BatchInfo | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  // A batch member's device may have since been forgotten (plan 47 §3.4) —
  // resolved lazily, only for ids the live list does not have, and cached
  // here so a re-render never re-fetches the same id.
  const [refs, setRefs] = useState<Record<string, DeviceRef>>({})
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  const jobsRef = useRef<PaginatedTableHandle<JobInfo>>(null)

  // The batch header (status, counts, identity) is its own small fetch; the
  // jobs table below is fed by PaginatedTable's own fetchPage so there is
  // only one place holding that list (plan 30 §3.4 — one component owns it).
  const loadBatch = () => {
    if (!batchId) return
    setError(null)
    void api(`/api/batches/${batchId}`, BatchResponseSchema)
      .then((b) => setBatch(b.batch))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(loadBatch, [batchId])

  useEffect(() => {
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!batchId) return
    const off = ws.on((m) => {
      if (m.type === 'batch.status' && m.payload.batchId === batchId) {
        setBatch((prev) => (prev ? { ...prev, status: m.payload.status, counts: m.payload.counts } : prev))
      } else if (m.type === 'job.status' && m.payload.batchId === batchId) {
        // Every job in a batch is created upfront (plan 20 §4.4) — an update
        // always matches an already-loaded row, so this is a merge, never a
        // prepend (plan 30 §3.5).
        jobsRef.current?.mergeLive(m.payload.jobId, m.payload as Partial<JobInfo>)
      }
    })
    return off
  }, [batchId])

  const fetchJobs = async (): Promise<Page<JobInfo>> => {
    if (!batchId) return { items: [], nextCursor: null, total: 0 }
    const b = await api(`/api/batches/${batchId}`, BatchWithJobsResponseSchema)
    setBatch(b.batch)
    const sorted = [...b.jobs].sort((a, z) => (a.batchSeq ?? 0) - (z.batchSeq ?? 0))
    // A member's device may have been forgotten since this batch ran (plan
    // 47 §3.4) — resolve only the ids the live list does not already have.
    const missing = [...new Set(sorted.map((j) => j.deviceId))].filter((id) => !devices.some((d) => d.id === id) && !(id in refs))
    if (missing.length > 0) {
      void fetchDeviceRefs(missing)
        .then((r) => setRefs((prev) => ({ ...prev, ...r })))
        .catch(() => undefined)
    }
    return { items: sorted, nextCursor: null, total: sorted.length }
  }

  if (!batchId) return <div className="px-5 py-4"><ErrorState message="The address is missing an id parameter." /></div>
  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={loadBatch} /></div>
  if (!batch) return <div className="px-5 py-4"><LoadingRows rows={3} /></div>

  const deviceLabel = (id: string) => devices.find((d) => d.id === id)?.label ?? deviceRefLabel(refs[id], id)
  const scriptName = batch.scriptName ? `${batch.scriptName}${batch.scriptVersion ? `@${batch.scriptVersion}` : ''}` : batch.scriptId
  const done = batch.counts.success + batch.counts.failed + batch.counts.cancelled
  const pct = batch.counts.total > 0 ? Math.round((done / batch.counts.total) * 100) : 0
  const canCancel = batch.status === 'queued' || batch.status === 'running'
  const canRerun = batch.status !== 'queued' && batch.status !== 'running' && batch.counts.failed > 0

  const cancel = () =>
    run('cancel', () => api(`/api/batches/${batchId}/cancel`, BatchCancelResponseSchema, { method: 'POST' }), {
      failure: 'Could not cancel the batch',
      onSuccess: (b) => {
        toast.success(b.cancelled === 1 ? '1 queued job cancelled' : `${b.cancelled} queued jobs cancelled`)
        loadBatch()
        jobsRef.current?.reload()
      },
    })

  const rerunFailed = () =>
    run('rerun', () => api(`/api/batches/${batchId}/rerun-failed`, BatchResponseSchema, { method: 'POST' }), {
      success: 'A new batch was created over the failed devices',
      failure: 'Could not re-run the failed devices',
      onSuccess: (b) => router.push(`/batches/detail?id=${b.batch.id}`),
    })

  return (
    <>
      <PageHeader
        title={scriptName}
        description={`Batch ${batch.id.slice(0, 8)}`}
        meta={<BatchStatusBadge status={batch.status} />}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/batches">
                <ArrowLeft className="size-4" aria-hidden />
                All batches
              </Link>
            </Button>
            {canRerun && (
              <Button variant="outline" size="sm" disabled={isPending('rerun')} onClick={() => void rerunFailed()}>
                Re-run failed ({batch.counts.failed})
              </Button>
            )}
            {canCancel && (
              <Button variant="outline" size="sm" disabled={isPending('cancel')} onClick={() => void cancel()}>
                Cancel batch
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 px-5 py-4 xl:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <div className="rounded-lg border bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="rack-label">progress</h2>
              <span className="readout text-[12px] text-fg-muted">
                {done}/{batch.counts.total} finished
                {batch.counts.failed > 0 && (
                  <span className="text-led-danger">
                    {' '}
                    · {batch.counts.failed} failed
                    {/* Plan 36 §4.4 — a batch that fell over because of one bad hub should not read as N broken tests. */}
                    {(batch.counts.failedInfra > 0 || batch.counts.failedScript > 0) &&
                      ` (${batch.counts.failedScript} script, ${batch.counts.failedInfra} infra)`}
                  </span>
                )}
              </span>
            </div>
            <Progress value={pct} className="mt-2 h-1.5" />
          </div>

          {/* Shared jobs table (audit finding 1) over this batch's OWN source:
              members come back with the batch itself, not from a jobs query.
              The row is what matters — this table used to hide a failed
              member's error behind a `line-clamp-1` that could not work. */}
          <JobsList
            handleRef={jobsRef}
            fetchPage={fetchJobs}
            resetKey={batchId}
            columns={{ seq: true, device: true }}
            deviceLabel={(id) => ({ name: deviceLabel(id), ident: id })}
            empty={{
              title: 'No jobs in this batch',
              description: 'This batch has no member jobs — its target selector resolved to nothing at dispatch time.',
            }}
          />
        </div>

        <aside>
          <div className="rounded-lg border bg-surface p-3.5">
            <h2 className="rack-label mb-2.5">identity</h2>
            <dl className="space-y-1.5">
              {[
                ['batch id', batch.id],
                ['cluster', batch.clusterId ?? '(ad-hoc list)'],
                ['concurrency', batch.concurrency === 0 ? 'unlimited' : String(batch.concurrency)],
                ['order', batch.order],
                ['created', relativeTime(batch.createdAt)],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[12px] text-fg-muted">{k}</dt>
                  <dd className="readout min-w-0 truncate text-[12px]" title={v}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </aside>
      </div>
    </>
  )
}

export default function BatchDetailPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={3} /></div>}>
      <BatchDetail />
    </Suspense>
  )
}
