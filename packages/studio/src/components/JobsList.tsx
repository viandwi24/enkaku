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
}

const DEFAULT_COLUMNS: JobsListColumns = { script: true, device: true, time: 'created', actions: true }

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
                <Link href={`/jobs/detail?id=${j.jobId}`} className="font-medium hover:text-accent">
                  {scriptLabel(j)}
                </Link>
                <FailureLine job={j} />
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
              <JobStatusBadge status={j.status} />
              {/* Every view shows why a job failed. Three of the four tables
                  this replaces did not, so the same failure read differently
                  depending on where you opened it. Shown here rather than
                  under the script name when there is no script column. */}
              {!columns.script && <FailureLine job={j} />}
            </TableCell>

            <TableCell className="readout text-[11.5px] text-fg-muted">
              {j.startedAt ? duration(j.startedAt, j.finishedAt, now) : '—'}
            </TableCell>

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

/**
 * Why a job failed, wherever a job is listed.
 *
 * `wrap-anywhere`, not `line-clamp-1`: three of the four tables this replaces
 * used the clamp, and under the old `whitespace-nowrap` cell it did nothing at
 * all — clamping needs text that may wrap. An error quoting a long URL then
 * pushed every column to its right off the screen.
 */
function FailureLine({ job }: { job: JobInfo }) {
  if (job.status !== 'failed' || !job.error) return null
  return <p className="mt-0.5 text-[11.5px] wrap-anywhere text-led-danger">{job.error}</p>
}
