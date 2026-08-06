'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import {
  BatchInfoSchema,
  ScheduleResponseSchema,
  ScheduleRunsPageResponseSchema,
  ValidateResponseSchema,
  type ClusterPreview,
  type DeviceInfo,
  type ScheduleInfo,
  type ScheduleRunInfo,
} from '@enkaku/protocol'
import { ScheduleEditorDialog, type ScheduleRow } from '@/components/ScheduleEditorDialog'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { TableCell, TableHead } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages, fetchDevices } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { ws } from '@/lib/ws'

const ONOVERLAP_SENTENCE: Record<string, string> = {
  skip: 'If the previous run is still going, this one is skipped.',
  queue: 'If the previous run is still going, this one still starts and waits its turn.',
  'cancel-previous': "If the previous run is still going, its queued devices are cancelled and this one starts.",
}

const CATCHUP_SENTENCE: Record<string, string> = {
  skip: 'If the core was off when this was due, nothing runs — the misses are recorded.',
  once: 'If the core was off when this was due, it runs once on startup, whatever was missed.',
}

const OUTCOME_LABEL: Record<string, string> = {
  dispatched: 'dispatched',
  'skipped-overlap': 'skipped — previous run still going',
  'skipped-missed': 'skipped — missed while the core was stopped',
  'no-targets': 'no usable devices',
  'spend-cap': 'refused — spend cap reached',
  error: 'error',
}

/** Plan 68 §3.5 — the interesting choice at 3 a.m., stated in plain words (same copy as the editor). */
const APPROVAL_SENTENCE: Record<string, string> = {
  deny: 'A destructive tool call is refused at once and the run continues — nobody is paged to decide.',
  pause: 'A destructive tool call waits for a human to approve, and expires unanswered like any other approval.',
}

const THREAD_MODE_SENTENCE: Record<string, string> = {
  new: 'Each firing gets its own thread.',
  continue: 'One thread carries across every firing.',
}

/**
 * `POST /api/schedules/:id/run-now` (`packages/core/src/api/schedules.ts`)
 * replies `{ run: { runId, threadId } }` for an agent-target schedule, or
 * `{ batch: BatchInfo }` for a script-target one — a genuine union no single
 * protocol export covers (plan 72 §3.4). Neither call site in this file
 * reads the result, but the body must still parse. Declared inline since it
 * does not fit `ScheduleResponseSchema`/`BatchResponseSchema` alone.
 */
const RunNowResponseSchema = z.union([
  z.object({ batch: BatchInfoSchema }),
  z.object({ run: z.object({ runId: z.string(), threadId: z.string().nullable() }) }),
])

function ScheduleDetail() {
  const scheduleId = useSearchParams().get('id')
  const tab = useSearchParams().get('tab') ?? 'overview'

  const [schedule, setSchedule] = useState<ScheduleInfo | null>(null)
  const [resolvesTo, setResolvesTo] = useState<{ scriptId: string; name: string; version: string } | null>(null)
  const [runsTotal, setRunsTotal] = useState<number | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [preview, setPreview] = useState<ClusterPreview | null>(null)
  const [nextFires, setNextFires] = useState<number[]>([])
  const [editing, setEditing] = useState<ScheduleRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  const runsRef = useRef<PaginatedTableHandle<ScheduleRunInfo>>(null)

  const load = () => {
    if (!scheduleId) return
    setError(null)
    void api(`/api/schedules/${scheduleId}`, ScheduleResponseSchema)
      .then((b) => {
        setSchedule(b.schedule)
        setResolvesTo(b.resolvesTo ?? null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(load, [scheduleId])

  useEffect(() => {
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!schedule) return
    if (schedule.clusterId) {
      // A saved cluster's members, resolved for display the same way the
      // device picker decides usability (plan 22.0 §3.5) — the cluster
      // preview endpoint itself now only previews an ad-hoc tag/id target,
      // since a saved cluster's membership is read directly from
      // `GET /api/clusters/:id/devices`.
      void fetchAllPages<DeviceInfo>(`/api/clusters/${schedule.clusterId}/devices`)
        .then((members) => {
          const usable = members.filter((d) => d.status !== 'offline' && d.status !== 'quarantined')
          const skipped = members
            .filter((d) => d.status === 'offline' || d.status === 'quarantined')
            .map((d) => ({ deviceId: d.id, reason: d.status }))
          setPreview({ usable: usable.map((d) => ({ deviceId: d.id, via: 'cluster' })), skipped })
        })
        .catch(() => setPreview(null))
    } else {
      setPreview(null)
    }
    void api('/api/schedules/validate', ValidateResponseSchema, {
      method: 'POST',
      json: { cron: schedule.cron, timezone: schedule.timezone },
    })
      .then((b) => setNextFires(b.valid ? b.nextFires : []))
      .catch(() => setNextFires([]))
  }, [schedule])

  useEffect(() => {
    if (!scheduleId) return
    const off = ws.on((m) => {
      if (m.type === 'schedule.fired' && m.payload.scheduleId === scheduleId) {
        load()
        // A fire adds a new run row at the top — simplest to reload the
        // runs page from the start, same as before this list paginated.
        runsRef.current?.reload()
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleId])

  if (!scheduleId) return <div className="px-5 py-4"><ErrorState message="The address is missing an id parameter." /></div>
  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (!schedule) return <div className="px-5 py-4"><LoadingRows rows={3} /></div>

  const clusterName = (id: string | null) => (id ? id.slice(0, 8) : null)
  const targetSummary = schedule.clusterId
    ? `cluster ${clusterName(schedule.clusterId)}`
    : `${schedule.deviceIds.length} explicit device${schedule.deviceIds.length === 1 ? '' : 's'}`

  const runNow = () =>
    run('run-now', () => api(`/api/schedules/${schedule.id}/run-now`, RunNowResponseSchema, { method: 'POST', json: {} }), {
      success: `${schedule.name} started`,
      failure: 'Could not run the schedule now',
      onSuccess: load,
    })

  return (
    <>
      <PageHeader
        title={schedule.name}
        description={`${schedule.cron} · ${schedule.timezone}`}
        meta={
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${
              schedule.enabled ? 'border-led-ok/35 bg-led-ok/10 text-led-ok' : 'border-line bg-transparent text-fg-subtle'
            }`}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {schedule.enabled ? 'enabled' : 'disabled'}
          </span>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/schedules">
                <ArrowLeft className="size-4" aria-hidden />
                All schedules
              </Link>
            </Button>
            <Button size="sm" disabled={isPending('run-now')} onClick={() => void runNow()}>
              Run now
            </Button>
          </>
        }
      />

      <EntityTabs
        active={tab}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'runs', label: 'Runs', count: runsTotal },
          { key: 'settings', label: 'Settings' },
        ]}
        hrefFor={(k) => `/schedules/detail?id=${encodeURIComponent(schedule.id)}${k === 'overview' ? '' : `&tab=${k}`}`}
      />

      {tab === 'overview' && (
        <div className="max-w-3xl space-y-4 px-5 py-4">
          {schedule.target.kind === 'agent' ? (
            <div className="rounded-lg border bg-surface p-4">
              <h2 className="text-[14px] font-semibold tracking-tight">Agent</h2>
              <p className="readout mt-1 text-[12.5px]">{schedule.target.agentId}</p>
              <p className="mt-2 whitespace-pre-wrap text-[12.5px] text-fg-muted">{schedule.target.prompt}</p>
              <ul className="mt-3 space-y-1 text-[12px] text-fg-muted">
                <li>{THREAD_MODE_SENTENCE[schedule.threadMode] ?? schedule.threadMode}</li>
                <li>{APPROVAL_SENTENCE[schedule.onApprovalRequired] ?? schedule.onApprovalRequired}</li>
              </ul>
            </div>
          ) : (
            <div className="rounded-lg border bg-surface p-4">
              <h2 className="text-[14px] font-semibold tracking-tight">Script</h2>
              {/* The raw reference is self-documenting (plan 62 §3.5, §4.6):
                  "checkout@latest" already says it floats, "checkout@1.0.1"
                  already says it is pinned — no separate staleness badge. */}
              <p className="readout mt-1 text-[12.5px]">{schedule.scriptRef}</p>
              <p className="mt-2 text-[12px] text-fg-muted">
                {resolvesTo ? (
                  <>→ resolves to <span className="readout text-fg">{resolvesTo.name}@{resolvesTo.version}</span> right now</>
                ) : (
                  <span className="text-led-warn">→ does not resolve right now — check that the script exists, is enabled, and (for @latest) has a non-prerelease version</span>
                )}
              </p>
            </div>
          )}

          <div className="rounded-lg border bg-surface p-4">
            <h2 className="text-[14px] font-semibold tracking-tight">Target</h2>
            <p className="mt-1 text-[12.5px] text-fg-muted">{targetSummary}</p>
            {preview && (
              <p className="mt-2 text-[12px] text-fg-muted">
                {preview.usable.length} device{preview.usable.length === 1 ? '' : 's'} match right now
                {preview.skipped.length > 0 && (
                  <> · {preview.skipped.length} skipped ({preview.skipped.map((s) => s.reason).join(', ')})</>
                )}
              </p>
            )}
            {!schedule.clusterId && (
              <p className="mt-2 text-[12px] text-fg-muted">
                {schedule.deviceIds.map((id) => devices.find((d) => d.id === id)?.label ?? id.slice(0, 8)).join(', ')}
              </p>
            )}
          </div>

          <div className="rounded-lg border bg-surface p-4">
            <h2 className="text-[14px] font-semibold tracking-tight">Policy</h2>
            <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-fg-muted">
              <li>{ONOVERLAP_SENTENCE[schedule.onOverlap]}</li>
              <li>
                {schedule.queueTimeoutSec != null
                  ? `A job waits at most ${schedule.queueTimeoutSec}s for a device before it expires.`
                  : 'A job waits as long as it takes for a device to free up.'}
              </li>
              <li>{CATCHUP_SENTENCE[schedule.catchUp]}</li>
              {schedule.jitterSec > 0 && <li>Dispatch is spread across up to {schedule.jitterSec}s of jitter.</li>}
              <li>Priority: {schedule.priority > 0 ? 'High' : schedule.priority < 0 ? 'Low' : 'Normal'}.</li>
            </ul>
          </div>

          <div className="rounded-lg border bg-surface p-4">
            <h2 className="text-[14px] font-semibold tracking-tight">Next five fires</h2>
            {nextFires.length === 0 ? (
              <p className="mt-1 text-[12.5px] text-fg-subtle">None — the cron expression may be invalid.</p>
            ) : (
              <ul className="readout mt-2 space-y-0.5 text-[12px] text-fg-muted">
                {nextFires.map((t) => (
                  <li key={t}>{new Date(t * 1000).toLocaleString(undefined, { timeZone: schedule.timezone })}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === 'runs' && (
        <div className="px-5 py-4">
          <PaginatedTable<ScheduleRunInfo>
            ref={runsRef}
            resetKey={scheduleId}
            fetchPage={(cursor) =>
              api(
                `/api/schedules/${scheduleId}/runs?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
                ScheduleRunsPageResponseSchema,
              ).then((page) => {
                setRunsTotal(page.total)
                return page
              })
            }
            rowKey={(r) => r.id}
            header={
              <>
                <TableHead>Due</TableHead>
                <TableHead>Fired</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Missed</TableHead>
                <TableHead className="text-right">Batch</TableHead>
              </>
            }
            renderRow={(r) => (
              <>
                <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(r.dueAt)}</TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(r.firedAt)}</TableCell>
                <TableCell className="text-[12px]">
                  {OUTCOME_LABEL[r.outcome] ?? r.outcome}
                  {r.detail && <p className="mt-0.5 line-clamp-1 text-[11px] text-fg-subtle">{r.detail}</p>}
                </TableCell>
                <TableCell className="readout text-[12px] text-fg-muted">{r.missedCount > 0 ? r.missedCount : '—'}</TableCell>
                <TableCell className="text-right">
                  {r.batchId ? (
                    <Button asChild variant="ghost" size="sm" className="h-7 text-[12px]">
                      <Link href={`/batches/detail?id=${r.batchId}`}>View</Link>
                    </Button>
                  ) : (
                    <span className="text-[12px] text-fg-subtle">—</span>
                  )}
                </TableCell>
              </>
            )}
            empty={{
              title: 'No runs yet',
              description: 'Every fire decision — including skipped ones — appears here, with its reason.',
            }}
          />
        </div>
      )}

      {tab === 'settings' && (
        <div className="max-w-2xl space-y-4 px-5 py-4">
          <div className="rounded-lg border bg-surface p-4">
            <p className="text-[13px] font-medium">Cron, timezone, target and policy</p>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              Opens the same editor used to create schedules, with a live preview of the next fires before you save.
            </p>
            <Button className="mt-3" size="sm" onClick={() => setEditing(schedule)}>
              Edit settings
            </Button>
          </div>
        </div>
      )}

      <ScheduleEditorDialog schedule={editing} devices={devices} onClose={() => setEditing(null)} onSaved={load} />
    </>
  )
}

export default function ScheduleDetailPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={3} /></div>}>
      <ScheduleDetail />
    </Suspense>
  )
}
