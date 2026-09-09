'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { z } from 'zod'
import { BatchInfoSchema, findRedundantSchedules, type ScheduleInfo } from '@enkaku/protocol'
import { api, useAction, Switch, Button, relativeTime } from '@enkaku/ui'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'
import { matchesSchedule } from '@/app/scripts/matchers'

const RunNowResponseSchema = z.union([
  z.object({ batch: BatchInfoSchema }),
  z.object({ run: z.object({ runId: z.string(), threadId: z.string().nullable() }) }),
])

/**
 * What this schedule runs, for the list's one narrow column.
 *
 * A workflow target needs its PARAMETERS in the summary, not just its name.
 * A rotation is three rows that run the same workflow and differ only in a
 * slot number, so three rows reading `workflow · warmup` are indistinguishable
 * — and telling them apart is the whole point of the screen: it is where an
 * operator notices that the copy they made still carries the original's slot.
 * `workflow · warmup · slot 0` says it at a glance.
 *
 * Bounded on purpose: a handful of short scalars, then an ellipsis. This is a
 * 1.2fr column, not a parameter viewer — the dialog is where the full set is
 * read and edited.
 */
function workSummary(s: ScheduleInfo): string {
  if (s.target.kind === 'agent') return `agent · ${s.target.prompt.slice(0, 40)}${s.target.prompt.length > 40 ? '…' : ''}`
  if (s.target.kind === 'workflow') {
    const params = s.target.params
    const pairs =
      params !== null && typeof params === 'object' && !Array.isArray(params)
        ? Object.entries(params as Record<string, unknown>)
            .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
            .slice(0, 3)
            .map(([k, v]) => `${k} ${String(v)}`)
        : []
    return `workflow · ${s.target.workflowName}${pairs.length > 0 ? ` · ${pairs.join(', ')}` : ''}`
  }
  return s.scriptRef ?? '—'
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
        <p className="max-w-sm text-meta text-dim">A schedule runs a script, a workflow or an agent against a group or device list on a cron expression.</p>
      </div>
    )
  }
  if (filtered.length === 0) return <p className="py-10 text-center text-body text-dim">No schedule matches &ldquo;{query}&rdquo;.</p>

  /*
   * Plan 314 §10.12 — schedules that would do exactly the same work.
   *
   * Computed over ALL items, not the filtered view: a duplicate hidden by the
   * search box is still a duplicate, and a warning that appears and disappears
   * with a query is one nobody trusts.
   *
   * The mistake it catches is the ordinary one. Three warm-up sessions a day
   * is three rows, and three rows get made by duplicating the first twice; if
   * the slot that distinguishes them is a parameter someone must remember to
   * change, the copies run the first platform three times a day, forever,
   * with three green batches and nothing red to notice.
   */
  const redundant = findRedundantSchedules(items)
  const duplicateOf = new Map<string, number>()
  redundant.forEach((ids, groupIndex) => ids.forEach((id) => duplicateOf.set(id, groupIndex + 1)))

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
            <div className="flex min-w-0 items-center gap-1.5">
              <Link href={`/scripts/schedule?id=${s.id}`} className="truncate text-body font-medium text-text hover:text-accent">
                {s.name}
              </Link>
              {duplicateOf.has(s.id) && (
                <span
                  className="shrink-0 rounded-chip bg-warn-soft px-1.5 py-0.5 text-[10.5px] text-warn"
                  title="Another enabled schedule runs the same thing, with the same parameters, on the same devices. If these are meant to be different sessions of one rotation, one of them still has the first one's parameters."
                >
                  duplicate
                </span>
              )}
            </div>
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
