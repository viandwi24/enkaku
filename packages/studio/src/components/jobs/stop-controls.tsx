'use client'

import { useState, type ReactNode } from 'react'
import {
  BatchStopResponseSchema,
  JobBulkCancelResponseSchema,
  JobsPageResponseSchema,
  type JobBulkCancelFilter,
  type JobBulkCancelResponse,
} from '@enkaku/protocol'
import { ConfirmDialog, api, describeApiError } from '@enkaku/ui'
import { toast } from 'sonner'

/**
 * The stop controls every jobs surface shares: stop a batch, stop every
 * active job in a scope, cancel a selection. One file so the confirm copy and
 * the result toast read the same on the Jobs page, a batch, and a device.
 *
 * What a stop does, which every confirm below says in the operator's words:
 * a queued job is cancelled; a running one is asked to stop, its `finish()`
 * still runs, and if it has not stopped within the farm's force-stop window
 * its process is killed. A workflow job takes its steps with it.
 */

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const CLEANUP_NOTE = 'A running job gets a moment to clean up (its finish step still runs), then it is force stopped.'

/** The toast for `POST /api/jobs/cancel` — what stopped, and every job that did not, by reason. */
export function reportBulkCancel(r: JobBulkCancelResponse): void {
  const done: string[] = []
  if (r.aborted > 0) done.push(`${r.aborted} running`)
  if (r.cancelled > 0) done.push(`${r.cancelled} queued`)
  const notes: string[] = []
  if (r.descendants > 0) notes.push(`Includes ${plural(r.descendants, 'workflow step or triggered job', 'workflow steps or triggered jobs')}.`)
  if (r.refused > 0) notes.push(`${plural(r.refused, 'job was', 'jobs were')} refused: on a device you cannot use.`)
  if (r.notCancellable > 0) notes.push(`${plural(r.notCancellable, 'job had', 'jobs had')} already finished.`)
  if (r.truncated) notes.push(`${r.matched} jobs matched, more than one stop covers. Stop again for the rest.`)
  const options = notes.length > 0 ? { description: notes.join(' ') } : undefined
  if (done.length === 0) toast.warning('Nothing was stopped', options)
  else toast.success(`Stopped ${done.join(' and ')}`, options)
}

/** Queued and running totals for a `GET /api/jobs` scope — what a confirm states before anything is stopped. */
async function countActive(query: Record<string, string>): Promise<{ queued: number; running: number }> {
  const read = (status: 'queued' | 'running') =>
    api(`/api/jobs?${new URLSearchParams({ ...query, status, limit: '1', includeSimulate: '1' }).toString()}`, JobsPageResponseSchema).then(
      (p) => p.total ?? p.items.length,
    )
  const [queued, running] = await Promise.all([read('queued'), read('running')])
  return { queued, running }
}

/**
 * "Stop all active" for a scope: a confirm that states the count, then
 * `POST /api/jobs/cancel` with `filter`. `countQuery` is the SAME scope in
 * `GET /api/jobs`'s own terms, so the number in the dialog is the number the
 * stop acts on.
 */
export function StopActiveJobs({
  filter,
  countQuery,
  scope,
  trigger,
  onDone,
}: {
  filter: JobBulkCancelFilter
  countQuery: Record<string, string>
  /** Where, in words, ending the sentence "Stops 3 running jobs …": "on this device", "in this list". */
  scope: string
  trigger: ReactNode
  onDone?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState<{ queued: number; running: number } | null>(null)
  const [countFailed, setCountFailed] = useState(false)

  function onOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) return
    setCounts(null)
    setCountFailed(false)
    void countActive(countQuery)
      .then(setCounts)
      .catch(() => setCountFailed(true))
  }

  const running = counts && filter.status !== 'queued' ? counts.running : 0
  const queued = counts && filter.status !== 'running' ? counts.queued : 0
  const total = running + queued

  const description = countFailed
    ? `Every queued job ${scope} is cancelled and every running one stopped. A workflow's steps stop with it. ${CLEANUP_NOTE}`
    : !counts
      ? 'Counting the jobs this stops…'
      : total === 0
        ? `Nothing is queued or running ${scope} right now.`
        : `Stops ${plural(running, 'running job')} and cancels ${plural(queued, 'queued job')} ${scope}. A workflow's steps stop with it. ${CLEANUP_NOTE}`

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      title={`Stop all active jobs ${scope}?`}
      description={description}
      confirmLabel={counts && total > 0 ? `Stop ${total}` : 'Stop all'}
      onConfirm={async () => {
        try {
          reportBulkCancel(await api('/api/jobs/cancel', JobBulkCancelResponseSchema, { json: { filter } }))
          onDone?.()
        } catch (e) {
          toast.error('Could not stop the jobs', { description: describeApiError(e) })
        }
      }}
    />
  )
}

/** "Cancel selected": a confirm naming the count, then `POST /api/jobs/cancel` with the ids. */
export function CancelSelectedJobs({ jobIds, trigger, onDone }: { jobIds: string[]; trigger: ReactNode; onDone?: () => void }) {
  return (
    <ConfirmDialog
      trigger={trigger}
      title={`Cancel ${plural(jobIds.length, 'selected job')}?`}
      description={`Queued jobs are cancelled and running ones stopped. A workflow's steps stop with it. ${CLEANUP_NOTE}`}
      confirmLabel={`Cancel ${jobIds.length}`}
      onConfirm={async () => {
        try {
          reportBulkCancel(await api('/api/jobs/cancel', JobBulkCancelResponseSchema, { json: { jobIds } }))
          onDone?.()
        } catch (e) {
          toast.error('Could not cancel the jobs', { description: describeApiError(e) })
        }
      }}
    />
  )
}

/** The batch being stopped — only what the confirm needs to say. */
export interface StoppableBatch {
  id: string
  name: string
  counts: { queued: number; running: number }
}

/** Whether a batch still has anything a stop would act on. */
export function batchHasActiveMembers(batch: Pick<StoppableBatch, 'counts'>): boolean {
  return batch.counts.queued + batch.counts.running > 0
}

/**
 * "Stop batch" — `POST /api/batches/:id/stop`, which marks the batch
 * stopping FIRST so no further repetition starts, then cancels and stops its
 * members. Controlled, because both callers open it from a control that is
 * not a plain trigger (a header action, a row button inside a list).
 */
export function StopBatchConfirm({
  batch,
  open,
  onOpenChange,
  onStopped,
}: {
  batch: StoppableBatch | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onStopped?: () => void
}) {
  const running = batch?.counts.running ?? 0
  const queued = batch?.counts.queued ?? 0
  return (
    <ConfirmDialog
      open={open && batch !== null}
      onOpenChange={onOpenChange}
      trigger={<span className="hidden" aria-hidden />}
      title={`Stop batch ${batch?.name ?? ''}?`}
      description={`Stops ${plural(running, 'running member')} and cancels ${plural(queued, 'queued member')}; the next repetitions will not start. ${CLEANUP_NOTE}`}
      confirmLabel="Stop batch"
      onConfirm={async () => {
        if (!batch) return
        try {
          const r = await api(`/api/batches/${encodeURIComponent(batch.id)}/stop`, BatchStopResponseSchema, { method: 'POST' })
          const done: string[] = []
          if (r.aborted > 0) done.push(`${r.aborted} running`)
          if (r.cancelled > 0) done.push(`${r.cancelled} queued`)
          const options = r.refused > 0 ? { description: `${plural(r.refused, 'member was', 'members were')} refused: on a device you cannot use.` } : undefined
          if (done.length === 0 && r.refused > 0) toast.warning('Batch marked stopping, but no member was stopped', options)
          else toast.success(done.length > 0 ? `Batch stopped: ${done.join(' and ')}` : 'Batch stopped: no member was still active', options)
          onStopped?.()
        } catch (e) {
          toast.error('Could not stop the batch', { description: describeApiError(e) })
        }
      }}
    />
  )
}
