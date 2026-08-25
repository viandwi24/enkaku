'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ListChecks, Search } from 'lucide-react'
import type { DeviceInfo, JobInfo, JobStatus } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { JobsList } from '@/components/JobsList'
import { type PaginatedTableHandle } from '@/components/PaginatedTable'
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, duration, matchesDeviceQuery, relativeTime } from '@enkaku/ui'
import { fetchDevices } from '@/lib/api'
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
  /**
   * Plan 124 §4.4 Group D, step 124.4 — the number stays SEPARATE from
   * `deviceName` above rather than being folded into it, for two reasons:
   * `JobsList`'s cell wants the two halves apart so the number can be dimmed
   * (§3.2), and the search filter below wants to match on the number exactly
   * (`7` finds `#7` and not `#17`) rather than as a substring of a composed
   * string. `null` for an id no loaded device answers to — a job whose device
   * has since been forgotten renders its bare truncated id, unchanged.
   */
  const deviceNumber = (id: string) => deviceOf(id)?.number ?? null
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
              placeholder="Search script, device number, label, or stable id…"
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
          deviceLabel={(id) => ({ number: deviceNumber(id), name: deviceName(id), ident: deviceIdent(id) })}
          resetKey={`${status}|${query}`}
          sort={(list: Job[]) => {
            let filtered = list
            if (status !== 'all') filtered = filtered.filter((j) => j.status === status)
            const q = query.trim().toLowerCase()
            if (q) {
              // Plan 124 §1 goal 3, §4.4 Group D, step 124.4 — the device
              // half of this filter is now `matchesDeviceQuery`, the single
              // definition of the four-way match (number / label / stableId /
              // tag) that `DevicePicker` has implemented since plan 19. Two
              // behaviours arrive with it that this box did not have: typing
              // `7` (or `#7`) finds `#7` and nothing else, and a tag matches.
              // The script half stays a plain substring test — a script name
              // is not a device and has no number.
              filtered = filtered.filter((j) => {
                if (scriptName(j).toLowerCase().includes(q)) return true
                // A job outlives the device it ran on (plan 47 §3.4), so the
                // lookup can miss. Falling back to the same strings the row
                // itself renders keeps a forgotten device's job findable by
                // the id fragment the operator can actually see.
                const d = deviceOf(j.deviceId)
                return matchesDeviceQuery(d ?? { number: null, label: deviceName(j.deviceId), stableId: deviceIdent(j.deviceId) }, query)
              })
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
