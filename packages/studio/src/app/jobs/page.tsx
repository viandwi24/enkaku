'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ListChecks, Search } from 'lucide-react'
import type { DeviceInfo, JobInfo, JobStatus } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { JobsList } from '@/components/JobsList'
import { type PaginatedTableHandle } from '@/components/PaginatedTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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

        {/* One jobs table for the whole product (audit finding 1). This page,
            the device page, a script's history and a batch's members were four
            separate implementations, and only this one showed a failed job's
            error or offered cancel. */}
        <JobsList
          handleRef={tableRef}
          deviceLabel={(id) => ({ name: deviceName(id), ident: deviceIdent(id) })}
          resetKey={`${status}|${query}`}
          sort={(list: Job[]) => {
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
          empty={{
            icon: <ListChecks className="size-4" aria-hidden />,
            title: 'No jobs yet',
            description: 'Run a script from the Plugins & scripts page, or with the Run button on a device card.',
            action: (
              <Button asChild>
                <Link href="/plugins">Browse scripts</Link>
              </Button>
            ),
          }}
        />
      </div>
    </>
  )
}
