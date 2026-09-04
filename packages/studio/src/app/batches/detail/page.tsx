'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Download } from 'lucide-react'
import { toast } from 'sonner'
import {
  BatchArtifactsResponseSchema,
  BatchResponseSchema,
  BatchStopResponseSchema,
  BatchWithJobsResponseSchema,
  type BatchArtifactInfo,
  type BatchInfo,
  type DeviceInfo,
  type JobInfo,
} from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import {
  Button,
  ConfirmDialog,
  DeviceName,
  ErrorState,
  LoadingRows,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  duration,
  fileSize,
  relativeTime,
  useAction,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { JobsList } from '@/components/JobsList'
import { JobDetailPanel } from '@/components/device-popup/JobDetailPanel'
import { BatchResults } from '@/components/bulk/BatchResults'
import { OutcomeSummary } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups } from '@/components/bulk/SkippedGroups'
import { batchOutcomeCounts, batchOutcomeGroups } from '@/components/bulk/use-batch-report'
import { PaginatedTable, type Page, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { deviceRefLabel, fetchDeviceRefs, fetchDevices, type DeviceRef } from '@/lib/api'
import { useNow } from '@/lib/useNow'
import { coreBase, ws } from '@/lib/ws'

/**
 * Plan 94 §3.6, §3.7, formatting for the "Repeat pacing" aside — a plain
 * millisecond span ("3–8 min"), matching the same compact style
 * `RunScriptDialog`'s own Repeat section already uses for its consequence
 * sentence, so an operator reading a batch's pacing here and its origin
 * form there sees the same vocabulary.
 */
function formatMsSpan(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const sec = ms / 1000
  if (sec < 60) return `${Number.isInteger(sec) ? sec : Math.round(sec * 10) / 10} s`
  const min = sec / 60
  return `${Number.isInteger(min) ? min : Math.round(min * 10) / 10} min`
}

/** Same "say the unit once" rule `RunScriptDialog`'s own `formatSecRange`
 *  uses (plan 94 §4.10) — `3–8 min`, not `3 min–8 min` — so an operator
 *  reading a batch's pacing here and its origin form there sees the exact
 *  same vocabulary for the exact same numbers. */
function formatMsRangeSpan(minMs: number, maxMs: number): string {
  if (minMs === maxMs) return formatMsSpan(minMs)
  const sameUnit = (minMs < 60_000) === (maxMs < 60_000)
  if (!sameUnit) return `${formatMsSpan(minMs)}–${formatMsSpan(maxMs)}`
  const [minText, unit] = formatMsSpan(minMs).split(' ')
  const [maxText] = formatMsSpan(maxMs).split(' ')
  return unit ? `${minText}–${maxText} ${unit}` : `${minText}–${maxText}`
}

const STATUS_TONE: Record<BatchInfo['status'], string> = {
  queued: 'text-fg-muted border-line bg-transparent',
  running: 'text-led-active border-led-active/35 bg-led-active/10',
  // Plan 94 §3.9, §4.9, step 94.8 — a stop was requested; running members
  // are still finishing their abort. Not `cancelled` yet — that is only
  // reached once every member has actually settled.
  stopping: 'text-led-warn border-led-warn/35 bg-led-warn/10',
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
  const now = useNow()
  // Plan 94 §4.10, step 94.10 — a second, small copy of the batch's own
  // jobs, held ONLY for the "Repeat pacing" aside's per-device next-start
  // math (§4.9's own note: `BatchDeviceRepeatSchema` carries no next-start
  // field, so it is derived here from the already-loaded `jobs` array
  // rather than a second endpoint). `JobsList`'s own `PaginatedTable` is
  // still the single owner of the RENDERED rows (plan 30 §3.4) — this is a
  // read-only copy, never written back into.
  const [jobs, setJobs] = useState<JobInfo[]>([])
  // Plan 94 §4.9, §4.10, F25 — `job.waiting`'s `reason`/`remainingSec`
  // (94.6's own wire addition), keyed by jobId, for whichever of THIS
  // batch's jobs a push has touched. `job.waiting` carries no `batchId`, so
  // membership is checked against `jobs` (above) rather than the message
  // itself.
  const [waiting, setWaiting] = useState<Record<string, { reason: 'control' | 'paced'; remainingSec: number }>>({})
  /**
   * The member whose result is open in the sheet, or `null`.
   *
   * Reading a batch used to mean leaving it: every member's only control was a
   * `next/link` to `/jobs/detail`, so checking forty members cost forty
   * navigations out and back, and the batch's own progress was unmounted each
   * time. The panel this opens is `JobDetailPanel` — the SAME component the
   * device popup already uses for this exact purpose (plan 103 §9 Q2), over
   * the same `useJobDetail` hook and the same result/logs/artifacts views the
   * full page renders. Nothing here is a second implementation of any of them,
   * and the panel carries its own link out for the parts it does not show.
   */
  const [openJobId, setOpenJobId] = useState<string | null>(null)

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

  // Membership for `job.waiting` (below) — a ref, not a dependency on `jobs`
  // itself, so the WS subscription effect does not have to re-subscribe on
  // every jobs refresh (matching the existing `jobsRef.current?.mergeLive`
  // pattern right below it, which reaches into a ref rather than closing
  // over state).
  const jobIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    jobIdsRef.current = new Set(jobs.map((j) => j.jobId))
  }, [jobs])

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
      } else if (m.type === 'job.waiting' && jobIdsRef.current.has(m.payload.jobId)) {
        // Plan 94 §4.9, F25, step 94.10 — the whole reason this push
        // carries a `reason` at all: rendering it is what turns an idle,
        // unexplained gap into "waiting — next repetition in 4 s".
        setWaiting((prev) => {
          if (!m.payload.waiting) {
            const { [m.payload.jobId]: _drop, ...rest } = prev
            return rest
          }
          return { ...prev, [m.payload.jobId]: { reason: m.payload.reason, remainingSec: m.payload.remainingSec } }
        })
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
    // Plan 94 §4.10 — the "Repeat pacing" aside's own read-only copy (see
    // the `jobs` state's own doc comment above).
    setJobs(sorted)
    return { items: sorted, nextCursor: null, total: sorted.length }
  }

  if (!batchId) return <div className="px-5 py-4"><ErrorState message="The address is missing an id parameter." /></div>
  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={loadBatch} /></div>
  if (!batch) return <div className="px-5 py-4"><LoadingRows rows={3} /></div>

  /**
   * The two halves of a device's name, kept apart (plan 124 §3.1, §4.4 Group
   * D, step 124.4). Every consumer below needs a different form of it — the
   * jobs table wants `<DeviceName>`'s two spans, `batchOutcomeGroups` wants
   * `{ number, label }` because `NamedOutcome` now carries them apart too
   * (step 124.3), and the progress rail wants one composed line — so this
   * resolves once and each site composes what it needs.
   *
   * Two sources, in order, both already present before this plan: a live
   * `DeviceInfo` from `GET /api/devices`, or a `DeviceRef` for a device the
   * batch outlived (plan 47 §3.4). `deviceRefLabel` composes the number
   * itself, so the ref branch hands back a name that is ALREADY composed and
   * a `number` of `null` — never re-wrapped, which would read `#7 #7 …`.
   */
  const deviceNameOf = (id: string): { number: number | null; label: string } => {
    const d = devices.find((dev) => dev.id === id)
    if (d) return { number: d.number, label: d.label }
    return { number: null, label: deviceRefLabel(refs[id], id) }
  }
  const scriptName = batch.scriptName ? `${batch.scriptName}${batch.scriptVersion ? `@${batch.scriptVersion}` : ''}` : batch.scriptId
  const done = batch.counts.success + batch.counts.failed + batch.counts.cancelled
  const pct = batch.counts.total > 0 ? Math.round((done / batch.counts.total) * 100) : 0
  const canStop = batch.status === 'queued' || batch.status === 'running'
  const canRerun = batch.status !== 'queued' && batch.status !== 'running' && batch.status !== 'stopping' && batch.counts.failed > 0
  // Plan 93 §3.12, §3.15, §4.8, F11, H3, step 93.11 — "Retry skipped", the
  // one retry action nothing in the product offered before this plan for
  // any bulk operation: a device that was offline at dispatch time and has
  // since come back is retargeted with one click, through the SAME
  // `?only=skipped` route `RunReport`'s own "Retry skipped" already uses
  // for a command run (§3.8, step 93.8) — one shared server-side mechanism,
  // two client surfaces.
  const canRetrySkipped = batch.status !== 'queued' && batch.status !== 'running' && batch.status !== 'stopping' && batch.skipped.length > 0
  const isPaced = batch.pacing !== null
  const isPullBatch = batch.scriptId === 'internal:pull'

  const stop = () =>
    run('stop', () => api(`/api/batches/${batchId}/stop`, BatchStopResponseSchema, { method: 'POST' }), {
      failure: 'Could not stop the batch',
      onSuccess: (b) => {
        const parts = [`${b.cancelled} queued job${b.cancelled === 1 ? '' : 's'} cancelled`, `${b.aborted} running job${b.aborted === 1 ? '' : 's'} aborted`]
        if (b.refused > 0) parts.push(`${b.refused} refused (you do not own ${b.refused === 1 ? 'that device' : 'those devices'})`)
        toast.success(parts.join(' · '))
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

  const retrySkipped = () =>
    run('retry-skipped', () => api(`/api/batches/${batchId}/rerun?only=skipped`, BatchResponseSchema, { method: 'POST' }), {
      success: 'A new batch was created over the skipped devices',
      failure: 'Could not re-run the skipped devices',
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
            {canRetrySkipped && (
              <Button variant="outline" size="sm" disabled={isPending('retry-skipped')} onClick={() => void retrySkipped()}>
                Retry skipped ({batch.skipped.length})
              </Button>
            )}
            {canStop && (
              <ConfirmDialog
                trigger={
                  <Button variant="outline" size="sm" disabled={isPending('stop')}>
                    Stop batch
                  </Button>
                }
                title={`Stop this batch?`}
                confirmLabel="Stop batch"
                description={
                  <div className="space-y-1.5">
                    <p>
                      Every queued job is cancelled and every running job is aborted — its script&apos;s cleanup runs, force-stopping the
                      recording&apos;s declared packages on that device.
                    </p>
                    {isPaced && <p>No further repetition is planned after this — the batch&apos;s pacing stops too, not just its current jobs.</p>}
                    <p className="text-fg-subtle">A device you do not have rights to is refused, counted, and reported — not silently skipped.</p>
                  </div>
                }
                onConfirm={stop}
              />
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

          {/* Plan 93 §3.12, §3.15, §4.8, F11, F15, H3, step 93.11 — the same
              three-part `OutcomeSummary`/`SkippedGroups` report every other
              bulk surface in this plan shows (the console's `RunReport`,
              `InstallBatchDialog`, `BulkTransferDialog`, wake/sleep), so a
              batch's own detail page converges on the same shape rather
              than inventing a fifth. `SkippedGroups` is what makes F11's
              own fix ("a batch silently forgets the devices it did not
              target") actually VISIBLE here — every skipped device, named,
              grouped by the exact reason `groups/dispatch.ts` recorded at
              dispatch time. */}
          <div className="rounded-lg border bg-surface p-4">
            <h2 className="rack-label mb-2.5">outcome</h2>
            <OutcomeSummary counts={batchOutcomeCounts(batch)} label="Batch outcome" />
            <div className="mt-3">
              <SkippedGroups {...batchOutcomeGroups(batch, jobs, deviceNameOf)} />
            </div>
          </div>

          {isPullBatch && <CollectedFiles batchId={batch.id} />}

          {/*
            Every member's result, side by side (2026-08-28). Placed ABOVE the
            members table on purpose: "what did this batch return" is the
            question a batch page is opened to answer, and until now the answer
            was forty visits to `/jobs/detail`. The members table below still
            owns status, timing, pacing and cancellation — this owns values.
          */}
          <BatchResults
            batchId={batch.id}
            deviceLabel={(id) => {
              const n = deviceNameOf(id)
              return { number: n.number, label: n.label }
            }}
            onOpenMember={setOpenJobId}
          />

          {/* Shared jobs table (audit finding 1) over this batch's OWN source:
              members come back with the batch itself, not from a jobs query.
              The row is what matters — this table used to hide a failed
              member's error behind a `line-clamp-1` that could not work. */}
          <JobsList
            handleRef={jobsRef}
            fetchPage={fetchJobs}
            resetKey={batchId}
            columns={{ seq: true, device: true, pacing: isPaced }}
            deviceLabel={(id) => {
              const n = deviceNameOf(id)
              return { number: n.number, name: n.label, ident: id }
            }}
            onOpenDetail={setOpenJobId}
            waiting={waiting}
            empty={{
              title: 'No jobs in this batch',
              description: 'This batch has no member jobs — its target selector resolved to nothing at dispatch time.',
            }}
          />
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border bg-surface p-3.5">
            <h2 className="rack-label mb-2.5">identity</h2>
            <dl className="space-y-1.5">
              {[
                ['batch id', batch.id],
                ['group', batch.groupId ?? '(ad-hoc list)'],
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

          {/* Plan 94 §3.7, §4.10, step 94.10 — "makes §3.7's promise visible
              rather than merely true": the pacing config this batch was
              created with, and per-device repetition progress + the next
              planned start, derived from `jobs` (the same rows `JobsList`
              renders) since `BatchDeviceRepeatSchema` itself carries no
              next-start field (§4.9's own note). */}
          {isPaced && batch.pacing && (
            <div className="rounded-lg border bg-surface p-3.5">
              <h2 className="rack-label mb-2.5">repeat pacing</h2>
              <dl className="mb-3 space-y-1.5">
                {[
                  ['repetitions', String(batch.pacing.repeatCount)],
                  ['interval', formatMsRangeSpan(batch.pacing.intervalMinMs, batch.pacing.intervalMaxMs)],
                  ['stagger', formatMsSpan(batch.pacing.deviceIntervalMs)],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3">
                    <dt className="text-[12px] text-fg-muted">{k}</dt>
                    <dd className="readout min-w-0 truncate text-[12px]">{v}</dd>
                  </div>
                ))}
              </dl>
              <ul className="space-y-2 border-t pt-2.5">
                {batch.repeats.map((r) => {
                  // The next QUEUED job for this device, if any — its
                  // `notBefore` (or a live `job.waiting` push naming the
                  // same job) is "the next planned start" §4.10 asks for.
                  const deviceJobs = jobs.filter((j) => j.deviceId === r.deviceId)
                  const next = deviceJobs
                    .filter((j) => j.status === 'queued')
                    .sort((a, z) => (a.notBefore ?? 0) - (z.notBefore ?? 0))[0]
                  const lastSettled = [...deviceJobs].reverse().find((j) => j.pacedDelayMs !== null)
                  const w = next ? waiting[next.jobId] : undefined
                  const nextText = !next
                    ? null
                    : w
                      ? w.reason === 'paced'
                        ? `next repetition in ${w.remainingSec}s`
                        : `waiting — device is controlled, ${w.remainingSec}s`
                      : next.notBefore !== null
                        ? next.notBefore - Math.floor(now / 1000) > 0
                          ? `starts in ~${next.notBefore - Math.floor(now / 1000)}s`
                          : 'starting…'
                        : null
                  return (
                    <li key={r.deviceId} className="text-[12px]">
                      <div className="flex items-baseline justify-between gap-3">
                        <DeviceName {...deviceNameOf(r.deviceId)} className="min-w-0" />
                        <span className="readout shrink-0 text-fg-muted">
                          {r.completed}/{r.planned}
                        </span>
                      </div>
                      {(nextText || (lastSettled && lastSettled.pacedDelayMs !== null)) && (
                        <p className="text-[11px] text-fg-subtle">
                          {nextText}
                          {nextText && lastSettled?.pacedDelayMs != null ? ' · ' : ''}
                          {lastSettled?.pacedDelayMs != null && `last delay ${formatMsSpan(lastSettled.pacedDelayMs)}`}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </aside>
      </div>

      {/*
        A sheet rather than the `20rem` aside beside it: a job's logs and
        artifacts are not readable in a column that narrow. A sheet is also what
        this app already uses for a read-only side surface
        (`components/DiscoveredTray.tsx`), so this is the established shape
        rather than a new one.

        Keyed on the job id so switching members REMOUNTS the panel. Without
        that, `useJobDetail` holds the previous member's result on screen while
        the next one loads — the single most misleading state a results view can
        have on a batch of forty near-identical devices.
      */}
      <Sheet open={openJobId !== null} onOpenChange={(next) => !next && setOpenJobId(null)}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Member result</SheetTitle>
            <SheetDescription>This member&apos;s own result, logs and artifacts — read here, without leaving the batch.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {openJobId && <JobDetailPanel key={openJobId} jobId={openJobId} onBack={() => setOpenJobId(null)} backLabel="Back to the batch" linkToFullPage />}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

/**
 * The collected-files table + "Download all" (plan 93 §3.13, §4.4, §4.8,
 * step 93.11 — depends on step 93.10's `GET /:id/artifacts` /
 * `.../artifacts.zip`, both landed in this tree by the time this component
 * was built; `src/lib/dependency-gaps.test.ts` is this plan's own
 * self-detecting guard for that dependency, kept as a regression check
 * rather than removed now that it passes). One row per pulled file — device
 * label, stableId (two phones are often both labelled the same, §3.13),
 * filename, size, and a per-file download link — plus one zip covering the
 * whole batch, streamed directly from the browser (no JSON envelope: it is
 * a raw file download, exactly like `FilesPanel.tsx`'s own single-pull
 * download link).
 */
function CollectedFiles({ batchId }: { batchId: string }) {
  const [items, setItems] = useState<BatchArtifactInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    void api(`/api/batches/${batchId}/artifacts`, BatchArtifactsResponseSchema)
      .then((b) => {
        if (!cancelled) setItems(b.items)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [batchId])

  return (
    <div className="rounded-lg border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="rack-label">collected files</h2>
        {items && items.length > 0 && (
          <Button asChild variant="outline" size="sm">
            <a href={`${coreBase()}/api/batches/${batchId}/artifacts.zip`} download>
              <Download className="size-3.5" aria-hidden />
              Download all
            </a>
          </Button>
        )}
      </div>
      {error ? (
        <p className="mt-2 text-[12px] text-led-danger">{error}</p>
      ) : items === null ? (
        <p className="mt-2 text-[12px] text-fg-subtle">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-[12px] text-fg-muted">No files collected yet.</p>
      ) : (
        <Table className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead>Device</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Size</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((it) => (
              <TableRow key={it.artifactId}>
                <TableCell>
                  {/* Plan 124 §3.7, §4.4 Group D — `deviceLabel` arrives
                      ALREADY COMPOSED (`api/batches.ts` wraps it in the core's
                      `formatDeviceLabel` before it reaches the wire, step
                      124.5). Rendered verbatim on purpose: wrapping it again
                      would print `#7 #7 Galaxy A15`. Note this is the
                      METADATA path only — the ZIP entry names built from the
                      same artifact use a separate `rawDeviceLabel` precisely
                      so a `#` never lands in a filename (§3.7). */}
                  {it.deviceLabel} <span className="readout text-fg-subtle">{it.stableId}</span>
                </TableCell>
                <TableCell className="readout">{it.filename}</TableCell>
                <TableCell className="readout">{fileSize(it.sizeBytes)}</TableCell>
                <TableCell>
                  <a className="text-accent underline" href={`${coreBase()}${it.contentUrl}`} target="_blank" rel="noreferrer">
                    download
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

export default function BatchDetailPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={3} /></div>}>
      <BatchDetail />
    </Suspense>
  )
}
