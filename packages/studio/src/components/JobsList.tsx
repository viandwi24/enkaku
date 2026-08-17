'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { JobCancelResponseSchema, JobsPageResponseSchema, type JobInfo } from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { Button } from '@/components/ui/button'
import { TableCell, TableHead } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, useAction } from '@/lib/actions'
import { duration, relativeTime } from '@/lib/format'
import { useNow } from '@/lib/useNow'

/**
 * ONE jobs table.
 *
 * There were four (`docs/ux-audit.md` finding 1): the Jobs page, the device
 * page's Jobs tab, a script's run history, and a batch's members — each with
 * its own `renderRow` over `PaginatedTable`, 9 to 13 cells apiece, and no two
 * agreeing on columns, ordering or affordances. The cost was not abstraction
 * debt, it was behaviour: only the Jobs page showed a failed job's error, and
 * only the Jobs page offered cancel, so the same failure read differently
 * depending on which screen you happened to open it from.
 *
 * Columns are opt-in rather than opt-out. A device page already knows which
 * device it is; repeating it in every row is noise, and a caller that has
 * pre-filtered says so by leaving `device` off.
 */
export interface JobsListFilter {
  deviceId?: string
  scriptId?: string
  batchId?: string
  status?: string
  rootJobId?: string
}

export interface JobsListColumns {
  /** Order within a batch. Only a batch view has one. */
  seq?: boolean
  /** The script that ran. Off when the caller IS a script. */
  script?: boolean
  /** Which phone. Off when the caller is already scoped to one. */
  device?: boolean
  /** `created` for a queue view, `started` for a history. Omitted entirely when unset. */
  time?: 'created' | 'started'
  /** Cancel, for a view where acting on a job makes sense. */
  actions?: boolean
  /**
   * Plan 94 §3.7, §4.8, §4.10, step 94.10 — repetition number and the delay
   * actually drawn, read straight off `JobInfo.batchRepeat`/`pacedDelayMs`/
   * `notBefore` (94.7's own wire additions, unrendered until this step —
   * "reaches the wire and nothing renders it"). Only meaningful for a paced
   * batch's own jobs list, so callers of an unpaced batch, the plain Jobs
   * page, or a device's Jobs tab leave it off.
   */
  pacing?: boolean
}

/**
 * Plan 94 §3.7, §4.10 — a plain millisecond duration, spelled out
 * ("4 min 12 s"), never an elapsed-since-now figure (that is `duration`'s
 * job, over `startedAt`/`finishedAt`). This is what makes `pacedDelayMs`
 * readable "without doing arithmetic against another column" (§3.7's own
 * phrase for why the column exists on the row at all).
 */
function formatDelayMs(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec} s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec === 0 ? `${min} min` : `${min} min ${sec} s`
}

export interface JobsListProps {
  filter?: JobsListFilter
  columns?: JobsListColumns
  /**
   * Resolves a device id to what to show for it. A callback rather than a
   * data shape, because that is what actually differs between the call sites:
   * the Jobs page holds `DeviceInfo[]`, the job detail page holds `DeviceRef`,
   * and a batch holds its own map. Defaults to the raw id.
   */
  deviceLabel?: (id: string) => { name: string; ident: string }
  empty: { icon?: React.ReactNode; title: string; description: string; action?: React.ReactNode }
  /** Re-fetches from the first page when this changes (a status filter, a search box). */
  resetKey?: unknown
  /** Presentation-only reordering/narrowing over what is already loaded (`PaginatedTable.sort`). */
  sort?: (rows: JobInfo[]) => JobInfo[]
  handleRef?: React.Ref<PaginatedTableHandle<JobInfo>>
  /** Called after a successful cancel, so a caller can refresh whatever else it shows. */
  onChanged?: () => void
  /**
   * Where the rows come from, when it is not `GET /api/jobs`. A batch reads
   * its members from `GET /api/batches/:id`, which returns them all at once
   * alongside the batch itself — a different source, but the SAME row, and the
   * row is where the four implementations had drifted apart.
   */
  fetchPage?: (cursor: string | null) => Promise<{ items: JobInfo[]; nextCursor: string | null; total: number | null }>
  /** The server's total on the FIRST page — a tab badge, a count in a heading. Null when the endpoint does not count. */
  onTotal?: (total: number | null) => void
  /**
   * Plan 103 §5 step 103.4 — `false` only from the device popup's own Jobs
   * read popup, whose own verifiable result is "a job row does not navigate
   * away from the Wall": the popup floats OVER the Wall (plan 103 §3.2's
   * whole point), and `/jobs/detail` is a different route entirely — a
   * `next/link` there would unmount the Wall (and this popup along with
   * it), which is exactly what a read popup must not do (§3.3: "you read
   * this, nothing needs touching on the phone meanwhile"). `true`
   * (default) everywhere else — the Jobs page, a script's run history, a
   * batch's members — is unchanged: the script name still links out.
   */
  linkToDetail?: boolean
  /**
   * Plan 103 §9 Q2 (answered 2026-08-16, closing step 103.11's audit row
   * 4) — the device popup's own Jobs tab renders a job's detail IN PLACE
   * (`JobDetailPanel`, `components/device-popup/`) rather than linking out,
   * so the row still needs to be a real control even with `linkToDetail`
   * `false`. Called with the job's id when the script-name cell is
   * activated; ignored unless `linkToDetail` is also `false` (a caller that
   * still links out has no use for this). Omitted everywhere else — the
   * Jobs page, a script's run history, a batch's members all keep linking
   * out.
   */
  onOpenDetail?: (jobId: string) => void
  /**
   * Plan 94 §4.9, §4.10, step 94.10 — the live `job.waiting` push (94.6's
   * own wire addition), keyed by jobId. `reason: 'paced'` is a job the
   * pacer is holding back for its next repetition (F25 — this plan's whole
   * complaint was that a paced farm sits idle with no explanation);
   * `'quiet'` is the pre-existing quiet-period hold. Absent (or missing a
   * key) renders a queued row's plain `notBefore`-derived fallback instead
   * of nothing — a caller that never wires the live push still gets an
   * honest, if less immediate, answer to "why is this not running yet".
   */
  waiting?: Record<string, { reason: 'quiet' | 'paced'; remainingSec: number }>
}

const DEFAULT_COLUMNS: JobsListColumns = { script: true, device: true, time: 'created', actions: true }

/**
 * `job.status`'s live `node` block (plan 99 §4.9, §4.11, step 99.10) —
 * present only on a row a live WS `job.status` push has touched, and only
 * for a `kind: 'workflow'` job. `GET /api/jobs`'s own REST response (what
 * every OTHER row here comes from) has no such field — `JobInfoSchema`
 * carries none — so this is read defensively off whatever `j` actually IS
 * at runtime rather than declared as a wider row TYPE for this whole file:
 * `app/jobs/page.tsx`'s `job.status` WS handler passes the message payload
 * straight to `pushLive` with no re-parse (`m.payload as Job`), so the
 * field really is there on a row that has received a live push, even
 * though `JobInfo` (the type every prop in this file is still declared
 * against) does not know it.
 */
interface JobNodeLive {
  id: string
  seq: number
  total: number
  kind: 'script' | 'gate'
  script: string | null
  status: string
}

function liveNode(j: JobInfo): JobNodeLive | null {
  return (j as JobInfo & { node?: JobNodeLive | null }).node ?? null
}

export function JobsList({
  filter,
  columns = DEFAULT_COLUMNS,
  deviceLabel,
  empty,
  resetKey,
  sort,
  handleRef,
  onChanged,
  onTotal,
  fetchPage,
  waiting,
  linkToDetail = true,
  onOpenDetail,
}: JobsListProps) {
  const now = useNow()
  const { run, isPending } = useAction()

  const query = useMemo(() => {
    const q: Record<string, string> = {}
    if (filter?.deviceId) q.deviceId = filter.deviceId
    if (filter?.status && filter.status !== 'all') q.status = filter.status
    if (filter?.batchId) q.batchId = filter.batchId
    if (filter?.rootJobId) q.rootJobId = filter.rootJobId
    return q
  }, [filter?.deviceId, filter?.status, filter?.batchId, filter?.rootJobId])

  const scriptLabel = (j: JobInfo) => (j.scriptName ? `${j.scriptName}@${j.scriptVersion ?? '?'}` : j.scriptId)

  function cancel(j: JobInfo) {
    return run(
      `cancel-${j.jobId}`,
      () => api(`/api/jobs/${j.jobId}/cancel`, JobCancelResponseSchema, { method: 'POST' }),
      { success: 'Job cancelled', failure: 'Could not cancel the job' },
    ).then(() => onChanged?.())
  }

  return (
    <PaginatedTable<JobInfo>
      {...(handleRef ? { ref: handleRef } : {})}
      fetchPage={(cursor) => {
        if (fetchPage) return fetchPage(cursor)
        const qs = new URLSearchParams({ ...query, limit: '50', ...(cursor ? { cursor } : {}) })
        return api(`/api/jobs?${qs}`, JobsPageResponseSchema).then((page) => {
          if (cursor === null) onTotal?.(page.total)
          return page
        })
      }}
      rowKey={(j) => j.jobId}
      resetKey={resetKey ?? JSON.stringify(query)}
      {...(sort ? { sort } : {})}
      empty={empty}
      header={
        <>
          {columns.seq && <TableHead className="w-10">#</TableHead>}
          {columns.script && <TableHead className="w-[32%]">Script</TableHead>}
          {columns.device && <TableHead>Device</TableHead>}
          <TableHead>Status</TableHead>
          <TableHead>Duration</TableHead>
          {columns.pacing && <TableHead>Pacing</TableHead>}
          {columns.time && <TableHead>{columns.time === 'created' ? 'Created' : 'Started'}</TableHead>}
          {columns.actions && <TableHead className="text-right">Actions</TableHead>}
          {!columns.actions && !columns.script && <TableHead className="text-right">Job</TableHead>}
        </>
      }
      renderRow={(j) => {
        const cancellable = j.status === 'queued' || j.status === 'running'
        const when = columns.time === 'started' ? (j.startedAt ?? j.createdAt) : j.createdAt
        return (
          <>
            {columns.seq && <TableCell className="readout text-[11.5px] text-fg-subtle">{(j.batchSeq ?? 0) + 1}</TableCell>}

            {columns.script && (
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  {linkToDetail ? (
                    <Link href={`/jobs/detail?id=${j.jobId}`} className="font-medium hover:text-accent">
                      {scriptLabel(j)}
                    </Link>
                  ) : onOpenDetail ? (
                    <button type="button" className="font-medium hover:text-accent hover:underline" onClick={() => onOpenDetail(j.jobId)}>
                      {scriptLabel(j)}
                    </button>
                  ) : (
                    <span className="font-medium">{scriptLabel(j)}</span>
                  )}
                  {j.assistCount > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex shrink-0 items-center rounded-full border border-led-warn/35 bg-led-warn/10 px-1.5 py-0.5 text-[10.5px] font-medium leading-none whitespace-nowrap text-led-warn">
                          assisted
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {j.assistCount === 1 ? 'An operator assisted this job once' : `An operator assisted this job ${j.assistCount} times`}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </span>
                {/* Plan 97 §4.8 — the one operator-legible line `buildResultSummary`
                    computed at settle. Absent whenever the script declared no
                    `summary` fields or the job has not settled `valid`. */}
                {j.resultSummary && <div className="truncate text-[11.5px] text-fg-muted">{j.resultSummary}</div>}
              </TableCell>
            )}

            {columns.device && (
              <TableCell className="text-[12.5px]">
                <Link
                  href={`/device?id=${encodeURIComponent(j.deviceId)}`}
                  className="group inline-flex flex-col leading-tight hover:text-accent"
                >
                  <span className="group-hover:underline">{(deviceLabel?.(j.deviceId) ?? { name: j.deviceId.slice(0, 8) }).name}</span>
                  <span className="readout text-[10.5px] text-fg-subtle">
                    {deviceLabel?.(j.deviceId).ident ?? j.deviceId}
                  </span>
                </Link>
              </TableCell>
            )}

            <TableCell>
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Every view shows WHY a job failed — but on the badge, not as
                    a line in the row. Inline it dominated the list for the one
                    row in a hundred that failed, and an error quoting a URL
                    with no spaces in it pushed every column off the right
                    edge. The badge is where the eye already is when a row
                    reads "failed", and the full text is a click away on the
                    job itself. */}
                <JobStatusBadge status={j.status} error={j.error} />
                {/* "node 2/4" (plan 99 §4.11) — a running workflow job only;
                    absent for every other row (an ordinary script, or a
                    workflow row that has not yet received a live push). */}
                {liveNode(j) && (
                  <span className="readout text-[10.5px] text-fg-subtle">
                    node {liveNode(j)!.seq + 1}/{liveNode(j)!.total}
                  </span>
                )}
              </div>
            </TableCell>

            <TableCell className="readout text-[11.5px] text-fg-muted">
              {j.startedAt ? duration(j.startedAt, j.finishedAt, now) : '—'}
            </TableCell>

            {/* Plan 94 §3.7, §4.9, §4.10, step 94.10 — the repetition
                number and either the live "waiting" reason (F25), the
                planned start, or the delay actually waited, in that order
                of preference: a live push beats a static read, and a
                settled repetition's own drawn delay beats a stale
                `notBefore` that no longer means anything once the job has
                already run. */}
            {columns.pacing && (
              <TableCell className="readout text-[11.5px] text-fg-muted">
                {j.batchRepeat !== null && <span className="text-fg-subtle">rep {j.batchRepeat + 1}</span>}
                {j.batchRepeat !== null && <span> · </span>}
                {(() => {
                  const w = waiting?.[j.jobId]
                  if (j.status === 'queued' && w) {
                    return w.reason === 'paced'
                      ? `waiting — next repetition in ${w.remainingSec}s`
                      : `waiting — quiet period, ${w.remainingSec}s`
                  }
                  if (j.status === 'queued' && j.notBefore !== null) {
                    const remaining = j.notBefore - Math.floor(now / 1000)
                    return remaining > 0 ? `starts in ~${remaining}s` : 'starting…'
                  }
                  if (j.pacedDelayMs !== null) return `waited ${formatDelayMs(j.pacedDelayMs)}`
                  return j.batchRepeat !== null ? 'no delay' : '—'
                })()}
              </TableCell>
            )}

            {columns.time && (
              <TableCell>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="readout text-[11.5px] text-fg-muted">{relativeTime(when, now)}</span>
                  </TooltipTrigger>
                  <TooltipContent>{new Date(when * 1000).toLocaleString()}</TooltipContent>
                </Tooltip>
              </TableCell>
            )}

            {columns.actions && (
              <TableCell className="text-right">
                {cancellable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[12px]"
                    disabled={isPending(`cancel-${j.jobId}`)}
                    onClick={() => void cancel(j)}
                  >
                    Cancel
                  </Button>
                )}
              </TableCell>
            )}

            {!columns.actions && !columns.script && (
              <TableCell className="text-right">
                <Button asChild variant="ghost" size="sm" className="h-7 text-[12px]">
                  <Link href={`/jobs/detail?id=${j.jobId}`}>Logs &amp; artifacts</Link>
                </Button>
              </TableCell>
            )}
          </>
        )
      }}
    />
  )
}
