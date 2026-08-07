'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ListChecks, Search } from 'lucide-react'
import { JobResponseSchema, JobsPageResponseSchema, type DeviceInfo, type JobInfo, type JobStatus } from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableCell, TableHead } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'
import { duration, relativeTime } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'

type Job = JobInfo

export default function JobsPage() {
  const tableRef = useRef<PaginatedTableHandle<Job>>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [status, setStatus] = useState<JobStatus | 'all'>('all')
  const [query, setQuery] = useState('')
  const { run, isPending } = useAction()
  // A running job's duration ticks without a refresh (Plan 17 acceptance #1).
  const now = useNow()

  useEffect(() => {
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)

    // `job.status` carries a full JobInfo (plan 30 §3.5) — a live row is
    // prepended if new, or replaces its already-loaded row in place.
    const off = ws.on((m) => {
      if (m.type !== 'job.status') return
      tableRef.current?.pushLive(m.payload as Job)
    })
    return off
  }, [])

  const deviceOf = (id: string) => devices.find((d) => d.id === id) ?? null
  const deviceName = (id: string) => deviceOf(id)?.label ?? id.slice(0, 8)
  /** Two phones can carry the same label; the stableId is the real identity (spec §7.5). */
  const deviceIdent = (id: string) => deviceOf(id)?.stableId ?? id
  const scriptName = (j: Job) =>
    j.scriptName ? `${j.scriptName}${j.scriptVersion ? `@${j.scriptVersion}` : ''}` : j.scriptId

  const cancel = (j: Job) =>
    run('cancel-' + j.jobId, () => api(`/api/jobs/${j.jobId}/cancel`, JobResponseSchema, { method: 'POST' }), {
      success: 'Job cancelled',
      failure: 'Could not cancel the job',
    })

  return (
    <>
      <PageHeader title="Jobs" description="Script execution queue and history" />

      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Search
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search script or device…"
              aria-label="Search jobs"
              className="h-8 pl-8 text-[12.5px]"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as JobStatus | 'all')}>
            <SelectTrigger className="h-8 w-44 text-[12.5px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="queued">Queued</SelectItem>
              <SelectItem value="success">Succeeded</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <PaginatedTable<Job>
          ref={tableRef}
          fetchPage={(cursor) => api(`/api/jobs?limit=50${cursor ? `&cursor=${cursor}` : ''}`, JobsPageResponseSchema)}
          rowKey={(j) => j.jobId}
          sort={(list) => {
            let filtered = list
            if (status !== 'all') filtered = filtered.filter((j) => j.status === status)
            const q = query.trim().toLowerCase()
            if (q) {
              filtered = filtered.filter(
                (j) =>
                  scriptName(j).toLowerCase().includes(q) ||
                  deviceName(j.deviceId).toLowerCase().includes(q) ||
                  deviceIdent(j.deviceId).toLowerCase().includes(q),
              )
            }
            // Running and queued jobs sit on top — those are the ones being watched.
            return [...filtered].sort((a, b) => {
              const rank = (j: Job) => (j.status === 'running' ? 0 : j.status === 'queued' ? 1 : 2)
              return rank(a) - rank(b) || b.createdAt - a.createdAt
            })
          }}
          header={
            <>
              <TableHead className="w-[32%]">Script</TableHead>
              <TableHead>Device</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </>
          }
          renderRow={(j) => {
            const cancellable = j.status === 'queued' || j.status === 'running'
            return (
              <>
                <TableCell>
                  <Link href={`/jobs/detail?id=${j.jobId}`} className="font-medium hover:text-accent">
                    {scriptName(j)}
                  </Link>
                  {/* `line-clamp-1` used to be here and did nothing: clamping
                      needs text that is allowed to wrap, and the cell was
                      `whitespace-nowrap`, so a long error ran on forever and
                      pushed every column to its right off the screen. Cells
                      wrap now; the error is shown in full, over as many lines
                      as it needs, rather than truncated to a first fragment
                      that rarely says what went wrong. */}
                  {j.status === 'failed' && j.error && (
                    <p className="mt-0.5 text-[11.5px] wrap-anywhere text-led-danger">{j.error}</p>
                  )}
                </TableCell>
                <TableCell className="text-[12.5px]">
                  <Link
                    href={`/device?id=${encodeURIComponent(j.deviceId)}`}
                    className="group inline-flex flex-col leading-tight hover:text-accent"
                    title={`${deviceName(j.deviceId)} · ${deviceIdent(j.deviceId)}`}
                  >
                    <span className="group-hover:underline">{deviceName(j.deviceId)}</span>
                    <span className="readout text-[10.5px] text-fg-subtle">{deviceIdent(j.deviceId)}</span>
                  </Link>
                </TableCell>
                <TableCell>
                  <JobStatusBadge status={j.status} />
                </TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">
                  {duration(j.startedAt, j.finishedAt, now)}
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="readout text-[11.5px] text-fg-muted">{relativeTime(j.createdAt, now)}</span>
                    </TooltipTrigger>
                    <TooltipContent>{new Date(j.createdAt * 1000).toLocaleString()}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-right">
                  {cancellable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[12px]"
                      disabled={isPending('cancel-' + j.jobId)}
                      onClick={() => void cancel(j)}
                    >
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </>
            )
          }}
          empty={{
            icon: <ListChecks className="size-4" aria-hidden />,
            title: 'No jobs yet',
            description: 'Run a script from the Scripts page, or with the Run button on a device card.',
            action: (
              <Button asChild>
                <Link href="/scripts">Open Scripts</Link>
              </Button>
            ),
          }}
          emptyFiltered={{
            icon: <ListChecks className="size-4" aria-hidden />,
            title: 'Nothing matches',
            description: 'Change the search or pick a different status.',
          }}
        />
      </div>
    </>
  )
}
