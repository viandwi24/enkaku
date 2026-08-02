'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CalendarClock, Plus } from 'lucide-react'
import type { DeviceInfo, ScheduleFiredEvent, ScheduleInfo } from '@enkaku/protocol'
import { ScheduleEditorDialog, type ScheduleRow } from '@/components/ScheduleEditorDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TableCell, TableHead } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'

const OUTCOME_LABEL: Record<string, string> = {
  dispatched: 'dispatched',
  'skipped-overlap': 'skipped (previous run still going)',
  'skipped-missed': 'skipped (missed while stopped)',
  'no-targets': 'no usable devices',
  error: 'error',
}

/** "Every day at 02:00 Asia/Jakarta" — good enough for the common cases without a full cron-to-English library. */
function humanCron(cron: string, timezone: string): string {
  const parts = cron.trim().split(/\s+/)
  const [min, hour, dom, month, dow] = parts.length === 6 ? parts.slice(1) : parts
  if (min !== undefined && hour !== undefined && /^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
    return `Every day at ${hour.padStart(2, '0')}:${min.padStart(2, '0')} ${timezone}`
  }
  return `${cron} (${timezone})`
}

function countdown(nextFireAt: number | null, now: number): string {
  if (nextFireAt === null) return '—'
  const delta = nextFireAt - Math.floor(now / 1000)
  if (delta <= 0) return 'due now'
  if (delta < 60) return `in ${delta}s`
  if (delta < 3600) return `in ${Math.floor(delta / 60)}m`
  if (delta < 86400) return `in ${Math.floor(delta / 3600)}h ${Math.floor((delta % 3600) / 60)}m`
  return `in ${Math.floor(delta / 86400)}d`
}

export default function SchedulesPage() {
  const tableRef = useRef<PaginatedTableHandle<ScheduleInfo>>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [lastOutcome, setLastOutcome] = useState<Map<string, ScheduleFiredEvent['payload']>>(new Map())
  const [editing, setEditing] = useState<ScheduleRow | 'new' | null>(null)
  const { run, isPending } = useAction()
  // Live countdown to the next fire, no polling (Plan 17 §4.6).
  const now = useNow()

  useEffect(() => {
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)

    // A fire moves nextFireAt/lastFiredAt on exactly one row — refetch that
    // row and replace it in place rather than reloading the whole page
    // (plan 30 §3.5: a live update must not duplicate an already-loaded row).
    const off = ws.on((m) => {
      if (m.type !== 'schedule.fired') return
      setLastOutcome((prev) => new Map(prev).set(m.payload.scheduleId, m.payload))
      void api<{ schedule: ScheduleInfo }>(`/api/schedules/${m.payload.scheduleId}`)
        .then((b) => tableRef.current?.pushLive(b.schedule))
        .catch(() => undefined)
    })
    return off
  }, [])

  const toggle = (s: ScheduleInfo) =>
    run('toggle-' + s.id, () => api(`/api/schedules/${s.id}`, { method: 'PATCH', json: { enabled: !s.enabled } }), {
      success: s.enabled ? `${s.name} disabled` : `${s.name} enabled`,
      failure: 'Could not change the schedule',
      onSuccess: () => tableRef.current?.reload(),
    })

  const runNow = (s: ScheduleInfo) =>
    run('run-' + s.id, () => api(`/api/schedules/${s.id}/run-now`, { method: 'POST', json: {} }), {
      success: `${s.name} started`,
      failure: 'Could not run the schedule now',
      onSuccess: () => tableRef.current?.reload(),
    })

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Recurring batches on a cron expression"
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-3.5" aria-hidden />
            New schedule
          </Button>
        }
      />

      <div className="space-y-4 px-5 py-4">
        <PaginatedTable<ScheduleInfo>
          ref={tableRef}
          fetchPage={(cursor) => api(`/api/schedules?limit=50${cursor ? `&cursor=${cursor}` : ''}`)}
          rowKey={(s) => s.id}
          header={
            <>
              <TableHead className="w-[26%]">Name</TableHead>
              <TableHead>Cron</TableHead>
              <TableHead>Next fire</TableHead>
              <TableHead>Last outcome</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </>
          }
          renderRow={(s) => {
            const fired = lastOutcome.get(s.id)
            return (
              <>
                <TableCell>
                  <Link href={`/schedules/detail?id=${s.id}`} className="font-medium hover:text-accent">
                    {s.name}
                  </Link>
                </TableCell>
                <TableCell className="text-[12px] text-fg-muted">{humanCron(s.cron, s.timezone)}</TableCell>
                <TableCell className="readout text-[12px]">{s.enabled ? countdown(s.nextFireAt, now) : '—'}</TableCell>
                <TableCell className="text-[12px] text-fg-muted">
                  {fired ? (OUTCOME_LABEL[fired.outcome] ?? fired.outcome) : s.lastFiredAt ? relativeTime(s.lastFiredAt, now) : '—'}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={s.enabled}
                    disabled={isPending('toggle-' + s.id)}
                    aria-label={`Enable ${s.name}`}
                    onCheckedChange={() => void toggle(s)}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 text-[12px]"
                      disabled={isPending('run-' + s.id)}
                      onClick={() => void runNow(s)}
                    >
                      Run now
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                  </div>
                </TableCell>
              </>
            )
          }}
          empty={{
            icon: <CalendarClock className="size-4" aria-hidden />,
            title: 'No schedules yet',
            description:
              'A schedule runs a script against a cluster or device list on a cron expression — the same batch you would run by hand, just recurring.',
            action: <Button onClick={() => setEditing('new')}>New schedule</Button>,
          }}
        />
      </div>

      <ScheduleEditorDialog
        schedule={editing}
        devices={devices}
        onClose={() => setEditing(null)}
        onSaved={() => tableRef.current?.reload()}
      />
    </>
  )
}
