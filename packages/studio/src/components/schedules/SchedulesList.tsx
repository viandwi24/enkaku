'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { z } from 'zod'
import { BatchInfoSchema, type ScheduleInfo } from '@enkaku/protocol'
import { api, useAction, Switch, Button, relativeTime } from '@enkaku/ui'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'
import { matchesSchedule } from '@/app/scripts/matchers'

const RunNowResponseSchema = z.union([
  z.object({ batch: BatchInfoSchema }),
  z.object({ run: z.object({ runId: z.string(), threadId: z.string().nullable() }) }),
])

function workSummary(s: ScheduleInfo): string {
  return s.target.kind === 'agent' ? `agent · ${s.target.prompt.slice(0, 40)}${s.target.prompt.length > 40 ? '…' : ''}` : (s.scriptRef ?? '—')
}
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
const OUTCOME_LABEL: Record<string, string> = {
  dispatched: 'dispatched',
  'skipped-overlap': 'skipped (previous run still going)',
  'skipped-missed': 'skipped (missed while stopped)',
  'no-targets': 'no usable devices',
  'spend-cap': 'refused (spend cap reached)',
  error: 'error',
}

/**
 * The Schedules tab's own list (plan 217 §3.7) — no handoff screen exists for
 * it (MVP 15 §0.1.1's post-design correction), so this mirrors the Scripts
 * table's row grammar on the same panel rather than inventing a third visual
 * language. Not paginated: a farm's schedule count is small, and the old
 * table already fetched every schedule the same way (§3.7).
 */
export function SchedulesList({
  items,
  query,
  onReload,
  onEdit,
}: {
  items: ScheduleInfo[] | null
  query: string
  onReload: () => void
  onEdit: (s: ScheduleInfo) => void
}) {
  const { run, isPending } = useAction()
  const now = useNow()

  useEffect(() => {
    return ws.on((m) => {
      if (m.type === 'schedule.fired') onReload()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (items === null) {
    return (
      <div className="space-y-2 py-6">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="h-[48px] animate-pulse rounded-input bg-muted" />
        ))}
      </div>
    )
  }
  const filtered = items.filter((s) => matchesSchedule(s, query))
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <p className="text-row font-medium text-text">No schedules yet</p>
        <p className="max-w-sm text-meta text-dim">A schedule runs a script or an agent against a group or device list on a cron expression.</p>
      </div>
    )
  }
  if (filtered.length === 0) return <p className="py-10 text-center text-body text-dim">No schedule matches &ldquo;{query}&rdquo;.</p>

  const toggle = (s: ScheduleInfo) =>
    run(`toggle-${s.id}`, () => api(`/api/schedules/${s.id}`, z.object({ schedule: z.unknown() }), { method: 'PATCH', json: { enabled: !s.enabled } }), {
      success: s.enabled ? `${s.name} disabled` : `${s.name} enabled`,
      failure: 'Could not change the schedule',
      onSuccess: onReload,
    })
  const runNow = (s: ScheduleInfo) =>
    run(`run-${s.id}`, () => api(`/api/schedules/${s.id}/run-now`, RunNowResponseSchema, { method: 'POST', json: {} }), {
      success: `${s.name} started`,
      failure: 'Could not run the schedule now',
      onSuccess: onReload,
    })

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[780px]">
        <div className="grid grid-cols-[1.4fr_1.2fr_1fr_100px_140px_78px_140px] border-b border-line px-2 py-2 text-label text-faint">
          <div>Name</div>
          <div>Runs</div>
          <div>Cron</div>
          <div>Next fire</div>
          <div>Last outcome</div>
          <div>Enabled</div>
          <div className="text-right">Actions</div>
        </div>
        {filtered.map((s) => (
          <div key={s.id} className="grid h-[48px] grid-cols-[1.4fr_1.2fr_1fr_100px_140px_78px_140px] items-center border-b border-muted-2 px-2">
            <Link href={`/scripts/schedule?id=${s.id}`} className="truncate text-body font-medium text-text hover:text-accent">
              {s.name}
            </Link>
            <div className="truncate font-mono text-[12px] text-dim">{workSummary(s)}</div>
            <div className="truncate text-body text-dim">{humanCron(s.cron, s.timezone)}</div>
            <div className="font-mono text-body">{s.enabled ? countdown(s.nextFireAt, now) : '—'}</div>
            <div className="truncate text-meta text-dim">
              {s.lastFireOutcome ? (OUTCOME_LABEL[s.lastFireOutcome] ?? s.lastFireOutcome) : s.lastFiredAt ? relativeTime(s.lastFiredAt, now) : '—'}
            </div>
            <Switch checked={s.enabled} disabled={isPending(`toggle-${s.id}`)} onCheckedChange={() => void toggle(s)} aria-label={`Enable ${s.name}`} />
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="secondary" className="h-7 text-[12px]" disabled={isPending(`run-${s.id}`)} onClick={() => void runNow(s)}>
                Run now
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => onEdit(s)}>
                Edit
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
