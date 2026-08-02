'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import type { BatchInfo, DeviceInfo, JobInfo } from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type Page, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { TableCell, TableHead } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'
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
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  const jobsRef = useRef<PaginatedTableHandle<JobInfo>>(null)

  // The batch header (status, counts, identity) is its own small fetch; the
  // jobs table below is fed by PaginatedTable's own fetchPage so there is
  // only one place holding that list (plan 30 §3.4 — one component owns it).
  const loadBatch = () => {
    if (!batchId) return
    setError(null)
    void api<{ batch: BatchInfo }>(`/api/batches/${batchId}`)
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
    const b = await api<{ batch: BatchInfo; jobs: JobInfo[] }>(`/api/batches/${batchId}`)
    setBatch(b.batch)
    const sorted = [...b.jobs].sort((a, z) => (a.batchSeq ?? 0) - (z.batchSeq ?? 0))
    return { items: sorted, nextCursor: null, total: sorted.length }
  }

  if (!batchId) return <div className="px-5 py-4"><ErrorState message="The address is missing an id parameter." /></div>
  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={loadBatch} /></div>
  if (!batch) return <div className="px-5 py-4"><LoadingRows rows={3} /></div>

  const deviceLabel = (id: string) => devices.find((d) => d.id === id)?.label ?? id.slice(0, 8)
  const scriptName = batch.scriptName ? `${batch.scriptName}${batch.scriptVersion ? `@${batch.scriptVersion}` : ''}` : batch.scriptId
  const done = batch.counts.success + batch.counts.failed + batch.counts.cancelled
  const pct = batch.counts.total > 0 ? Math.round((done / batch.counts.total) * 100) : 0
  const canCancel = batch.status === 'queued' || batch.status === 'running'
  const canRerun = batch.status !== 'queued' && batch.status !== 'running' && batch.counts.failed > 0

  const cancel = () =>
    run('cancel', () => api<{ cancelled: number }>(`/api/batches/${batchId}/cancel`, { method: 'POST' }), {
      failure: 'Could not cancel the batch',
      onSuccess: (b) => {
        toast.success(b.cancelled === 1 ? '1 queued job cancelled' : `${b.cancelled} queued jobs cancelled`)
        loadBatch()
        jobsRef.current?.reload()
      },
    })

  const rerunFailed = () =>
    run('rerun', () => api<{ batch: BatchInfo }>(`/api/batches/${batchId}/rerun-failed`, { method: 'POST' }), {
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
                {batch.counts.failed > 0 && <span className="text-led-danger"> · {batch.counts.failed} failed</span>}
              </span>
            </div>
            <Progress value={pct} className="mt-2 h-1.5" />
          </div>

          <PaginatedTable<JobInfo>
            ref={jobsRef}
            resetKey={batchId}
            fetchPage={fetchJobs}
            rowKey={(j) => j.jobId}
            header={
              <>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Job</TableHead>
              </>
            }
            renderRow={(j) => (
              <>
                <TableCell className="readout text-[11.5px] text-fg-subtle">{(j.batchSeq ?? 0) + 1}</TableCell>
                <TableCell className="text-[12.5px]">{deviceLabel(j.deviceId)}</TableCell>
                <TableCell>
                  <JobStatusBadge status={j.status} />
                  {j.status === 'failed' && j.error && (
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-led-danger">{j.error}</p>
                  )}
                </TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">
                  {j.startedAt ? duration(j.startedAt, j.finishedAt) : '—'}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="ghost" size="sm" className="h-7 text-[12px]">
                    <Link href={`/jobs/detail?id=${j.jobId}`}>Logs &amp; artifacts</Link>
                  </Button>
                </TableCell>
              </>
            )}
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
