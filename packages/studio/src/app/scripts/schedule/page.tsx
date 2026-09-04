'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { BatchResponseSchema, BatchStopResponseSchema, JobsPageResponseSchema, ScheduleResponseSchema, type BatchInfo, type ScheduleInfo } from '@enkaku/protocol'
import { api, useAction, ConfirmDialog, Button, relativeTime } from '@enkaku/ui'
import { JobsList } from '@/components/JobsList'
import { ScheduleDialog, type ScheduleRow } from '@/components/schedules/ScheduleDialog'

const ACTIVE_BATCH_STATUS = new Set<BatchInfo['status']>(['queued', 'running'])

function workSummary(s: ScheduleInfo): string {
  return s.target.kind === 'agent' ? `agent · ${s.target.prompt}` : (s.scriptRef ?? '—')
}

function ScheduleDetail() {
  const scheduleId = useSearchParams().get('id')
  const tab = useSearchParams().get('tab') ?? 'overview'
  const [schedule, setSchedule] = useState<ScheduleInfo | null>(null)
  const [lastBatch, setLastBatch] = useState<BatchInfo | null>(null)
  const [editing, setEditing] = useState<ScheduleRow | null>(null)
  const { run, isPending } = useAction()

  const load = () => {
    if (!scheduleId) return
    void api(`/api/schedules/${scheduleId}`, ScheduleResponseSchema).then((b) => setSchedule(b.schedule))
  }
  useEffect(load, [scheduleId])

  useEffect(() => {
    // `schedules.batchId` (plan 211 §4.1, renamed from `lastBatchId`) is the
    // ONE batch this schedule owns — every fire adds runs to its member
    // jobs, it does not create a new batch (MVP 14 §1, plan 211 §3.2
    // decision 4). This is why there is one "Last run" card, not a growing
    // list of batches.
    if (!schedule?.batchId) {
      setLastBatch(null)
      return
    }
    void api(`/api/batches/${schedule.batchId}`, BatchResponseSchema)
      .then((b) => setLastBatch(b.batch))
      .catch(() => setLastBatch(null))
  }, [schedule?.batchId])

  if (!scheduleId || !schedule) return <div className="px-[14px] py-4" />

  const stopLastRun = () =>
    run('stop', () => api(`/api/batches/${schedule.batchId}/stop`, BatchStopResponseSchema, { method: 'POST' }), {
      failure: 'Could not stop the last run',
      onSuccess: () => {
        void api(`/api/batches/${schedule.batchId}`, BatchResponseSchema).then((b) => setLastBatch(b.batch))
      },
    })
  const lastRunActive = !!lastBatch && ACTIVE_BATCH_STATUS.has(lastBatch.status)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-[14px] pt-[14px]">
        <div>
          <h1 className="text-title font-semibold text-text">{schedule.name}</h1>
          <p className="text-meta text-dim">
            {schedule.cron} · {schedule.timezone}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/scripts?tab=schedules">All schedules</Link>
          </Button>
        </div>
      </div>
      <div className="mt-3 flex gap-1 border-b border-line px-[14px]">
        {(['overview', 'jobs', 'settings'] as const).map((k) => (
          <Link
            key={k}
            href={`/scripts/schedule?id=${scheduleId}&tab=${k}`}
            className={`rounded-t-[9px] px-[12px] py-[7px] text-row ${tab === k ? 'bg-accent-soft text-accent' : 'text-dim'}`}
          >
            {k === 'overview' ? 'Overview' : k === 'jobs' ? 'Jobs' : 'Settings'}
          </Link>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="max-w-3xl space-y-4 px-[14px] py-4">
          <div className="rounded-card border border-line bg-panel p-4">
            <h2 className="text-name font-semibold text-text">Runs</h2>
            <p className="mt-1 text-body text-dim">{workSummary(schedule)}</p>
          </div>
          <div className="rounded-card border border-line bg-panel p-4">
            <h2 className="text-name font-semibold text-text">Target</h2>
            <p className="mt-1 text-body text-dim">
              {schedule.groupId ? `Group ${schedule.groupId}` : `${schedule.deviceIds.length} device(s)`}
            </p>
          </div>
          <div className="rounded-card border border-line bg-panel p-4">
            <h2 className="text-name font-semibold text-text">Policy</h2>
            <p className="mt-1 text-body text-dim">
              Concurrency {schedule.concurrency === 0 ? 'unlimited' : schedule.concurrency} · {schedule.order} order · overlap: {schedule.onOverlap}
            </p>
          </div>
          {lastBatch && (
            <div className="rounded-card border border-line bg-panel p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-name font-semibold text-text">Last run</h2>
                {/* Plan 217 §4.9, §8: `/jobs/detail` has no `?batchId=` query
                    yet and `/jobs` has no Batches tab either — both are
                    plan 218's, not merged as of this plan's execution.
                    Falls back to the plain Jobs list until 218 lands and
                    can correct this link (§11 records the discrepancy). */}
                <Button asChild variant="ghost" size="sm">
                  <Link href="/jobs">View</Link>
                </Button>
              </div>
              <p className="mt-1 text-body text-dim">
                {lastBatch.counts.success + lastBatch.counts.failed + lastBatch.counts.cancelled}/{lastBatch.counts.total} finished ·{' '}
                {lastBatch.status}
              </p>
              {lastRunActive && (
                <ConfirmDialog
                  trigger={
                    <Button variant="outline" size="sm" className="mt-2" disabled={isPending('stop')}>
                      Stop last run
                    </Button>
                  }
                  title="Stop this schedule's last run?"
                  confirmLabel="Stop run"
                  description="Every queued job is cancelled and every running job is aborted."
                  onConfirm={stopLastRun}
                />
              )}
            </div>
          )}
          {!lastBatch && (
            <p className="text-meta text-faint">
              {schedule.lastFiredAt ? `Last fired ${relativeTime(schedule.lastFiredAt)}` : 'This schedule has not fired yet.'}
            </p>
          )}
        </div>
      )}

      {tab === 'jobs' && (
        <div className="px-[14px] py-4">
          {/* MVP 14 §2: the schedule's page shows its JOBS and their runs,
              not a separate run table. `JobsList` already accepts a
              `fetchPage` override
              (packages/studio/src/components/JobsList.tsx:108), so this is a
              plain wiring change, not a new list component. */}
          <JobsList
            fetchPage={(cursor) => api(`/api/schedules/${scheduleId}/jobs?limit=50${cursor ? `&cursor=${cursor}` : ''}`, JobsPageResponseSchema)}
            columns={{ device: true, time: 'created' }}
            empty={{ title: 'No jobs yet', description: 'A job is created the first time this schedule fires, or on Run now.' }}
          />
        </div>
      )}

      {tab === 'settings' && (
        <div className="max-w-2xl space-y-4 px-[14px] py-4">
          <div className="rounded-card border border-line bg-panel p-4">
            <p className="text-row font-medium text-text">Cron, timezone, target and policy</p>
            <p className="mt-1 text-body text-dim">
              Opens the same editor used to create schedules, with a live preview of the next fires before you save.
            </p>
            <Button className="mt-3" size="sm" onClick={() => setEditing(schedule)}>
              Edit settings
            </Button>
          </div>
        </div>
      )}

      <ScheduleDialog schedule={editing} onClose={() => setEditing(null)} onSaved={load} />
    </div>
  )
}

export default function ScheduleDetailPage() {
  return (
    <Suspense fallback={null}>
      <ScheduleDetail />
    </Suspense>
  )
}
