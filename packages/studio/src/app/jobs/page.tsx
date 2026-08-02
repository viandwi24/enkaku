'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ListChecks, Search } from 'lucide-react'
import type { DeviceInfo, JobInfo, JobStatus } from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, useAction } from '@/lib/actions'
import { relativeTime } from '@/lib/format'
import { ws } from '@/lib/ws'

type Job = JobInfo

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [status, setStatus] = useState<JobStatus | 'all'>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()

  const load = async () => {
    setError(null)
    try {
      const [j, d] = await Promise.all([
        api<{ jobs: Job[] }>('/api/jobs?limit=200'),
        api<{ devices: DeviceInfo[] }>('/api/devices'),
      ])
      setJobs(j.jobs)
      setDevices(d.devices)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
    // Rows update in place rather than reloading the whole list.
    const off = ws.on((m) => {
      if (m.type !== 'job.status') return
      setJobs((prev) => {
        if (!prev) return prev
        const i = prev.findIndex((j) => j.jobId === m.payload.jobId)
        if (i === -1) return [m.payload as Job, ...prev]
        const next = [...prev]
        next[i] = { ...next[i], ...m.payload } as Job
        return next
      })
    })
    return off
  }, [])

  const deviceName = (id: string) => devices.find((d) => d.id === id)?.label ?? id.slice(0, 8)
  const scriptName = (j: Job) =>
    j.scriptName ? `${j.scriptName}${j.scriptVersion ? `@${j.scriptVersion}` : ''}` : j.scriptId

  const filtered = useMemo(() => {
    let list = jobs ?? []
    if (status !== 'all') list = list.filter((j) => j.status === status)
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (j) => scriptName(j).toLowerCase().includes(q) || deviceName(j.deviceId).toLowerCase().includes(q),
      )
    }
    // Running and queued jobs sit on top — those are the ones being watched.
    return [...list].sort((a, b) => {
      const rank = (j: Job) => (j.status === 'running' ? 0 : j.status === 'queued' ? 1 : 2)
      return rank(a) - rank(b) || b.createdAt - a.createdAt
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, devices, status, query])

  // The actions column only appears when something can be acted on. A history
  // of finished jobs does not need an empty column eating table width.
  const hasCancellable = filtered.some((j) => j.status === 'queued' || j.status === 'running')

  const cancel = (j: Job) =>
    run('cancel-' + j.jobId, () => api(`/api/jobs/${j.jobId}/cancel`, { method: 'POST' }), {
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
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : jobs === null ? (
          <LoadingRows rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ListChecks className="size-4" aria-hidden />}
            title={jobs.length === 0 ? 'No jobs yet' : 'Nothing matches'}
            description={
              jobs.length === 0
                ? 'Run a script from the Scripts page, or with the Run button on a device card.'
                : 'Change the search or pick a different status.'
            }
            action={
              jobs.length === 0 ? (
                <Button asChild>
                  <Link href="/scripts">Open Scripts</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[38%]">Script</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  {hasCancellable && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((j) => {
                  const cancellable = j.status === 'queued' || j.status === 'running'
                  return (
                    <TableRow key={j.jobId}>
                      <TableCell>
                        <Link href={`/jobs/detail?id=${j.jobId}`} className="font-medium hover:text-accent">
                          {scriptName(j)}
                        </Link>
                        {j.status === 'failed' && j.error && (
                          <p className="mt-0.5 line-clamp-1 text-[11.5px] text-led-danger">{j.error}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-[12.5px]">{deviceName(j.deviceId)}</TableCell>
                      <TableCell>
                        <JobStatusBadge status={j.status} />
                      </TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="readout text-[11.5px] text-fg-muted">
                              {relativeTime(j.createdAt)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{new Date(j.createdAt * 1000).toLocaleString()}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      {hasCancellable && (
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
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  )
}
