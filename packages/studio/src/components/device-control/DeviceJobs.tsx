'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { JobInfo } from '@enkaku/protocol'
import { api, Badge, Button, CaretLeftIcon, Progress, StatusDot, type StatusDotState } from '@enkaku/ui'
import { JobResponseSchema, JobsPageResponseSchema, JobCancelResponseSchema, JobLogsResponseSchema } from '@enkaku/protocol'
import { runAction } from '@/lib/actions'
import { ws } from '@/lib/ws'

/**
 * The Device tab's Jobs section (design handoff README.md:281-283; plan 215
 * §4.12). Unfiltered — "that belongs on the Jobs page".
 *
 * **Discrepancy from the plan**: the plan assumed plan 211's job/run split
 * (a job with many runs, "Re-run adds a run") had already landed. It has
 * not — plan 211 is a sibling of this plan in round R5 and had not merged
 * at the time this plan executed. Against the CURRENT one-job-one-run
 * model, Stop/Cancel is `POST /api/jobs/:id/cancel` (unchanged) and Re-run
 * creates a NEW job with the same script and params (the closest existing
 * equivalent to "add a run"); when plan 211 lands, this file's Re-run
 * handler is the one call site to revisit.
 */

function dotFor(status: JobInfo['status']): StatusDotState {
  if (status === 'running') return 'job'
  if (status === 'failed' || status === 'expired' || status === 'cancelled') return 'unauthorized'
  return 'free'
}

function subLine(job: JobInfo): string {
  if (job.status === 'running') return job.startedAt ? `running since ${new Date(job.startedAt * 1000).toLocaleTimeString()}` : 'running'
  if (job.status === 'queued') return 'queued'
  if (job.finishedAt) return new Date(job.finishedAt * 1000).toLocaleTimeString()
  return job.status
}

export function DeviceJobs({ deviceId }: { deviceId: string }) {
  const [jobs, setJobs] = useState<JobInfo[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  async function load() {
    const res = await api(`/api/jobs?deviceId=${encodeURIComponent(deviceId)}&limit=20`, JobsPageResponseSchema)
    setJobs(res.items)
  }

  useEffect(() => {
    void load()
    const off = ws.on((msg) => {
      if (msg.type === 'job.status' && msg.payload.deviceId === deviceId) void load()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  if (openId) {
    return <JobDetail jobId={openId} onBack={() => setOpenId(null)} onChanged={() => void load()} />
  }

  if (!jobs) return <p className="text-meta text-faint">Loading…</p>
  if (jobs.length === 0) return <p className="text-meta text-faint">No jobs on this device.</p>

  return (
    <div className="flex flex-col gap-0.5">
      {jobs.map((j) => (
        <button
          key={j.jobId}
          type="button"
          className="flex flex-col items-start gap-0.5 rounded-button px-2 py-1.5 text-left hover:bg-muted"
          onClick={() => setOpenId(j.jobId)}
        >
          <span className="flex items-center gap-1.5 text-body">
            <StatusDot state={dotFor(j.status)} className="size-2" />
            <span className="font-mono">{j.scriptName ?? j.scriptId}</span>
          </span>
          <span className="pl-[14px] text-meta text-faint">{subLine(j)}</span>
        </button>
      ))}
    </div>
  )
}

function JobDetail({ jobId, onBack, onChanged }: { jobId: string; onBack: () => void; onChanged: () => void }) {
  const [job, setJob] = useState<JobInfo | null>(null)
  const [logs, setLogs] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api(`/api/jobs/${jobId}`, JobResponseSchema).then((res) => setJob(res.job))
  }, [jobId])

  async function stop() {
    setBusy(true)
    try {
      await api(`/api/jobs/${jobId}/cancel`, JobCancelResponseSchema, { method: 'POST' })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function rerun() {
    if (!job) return
    setBusy(true)
    try {
      if (job.scriptId) {
        await runAction('run-script', { deviceIds: [job.deviceId] }, { scriptId: job.scriptId, concurrency: 0, order: 'as-listed' })
      }
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function loadLogs() {
    const res = await api(`/api/jobs/${jobId}/logs`, JobLogsResponseSchema)
    setLogs(res.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))))
  }

  if (!job) return <p className="text-meta text-faint">Loading…</p>

  const running = job.status === 'running'
  const queued = job.status === 'queued'
  const settled = !running && !queued

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="flex items-center gap-1 text-meta text-faint hover:text-text" onClick={onBack}>
        <CaretLeftIcon className="size-3.5" aria-hidden /> Back
      </button>
      <div className="flex items-center gap-2">
        <Badge>{job.status}</Badge>
        <span className="font-mono text-body">{job.scriptName ?? job.scriptId}</span>
      </div>
      {running && <Progress value={undefined} />}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-meta">
        <dt className="text-faint">Job id</dt>
        <dd className="truncate font-mono">{job.jobId}</dd>
        <dt className="text-faint">Trigger</dt>
        <dd>{job.batchId ? 'batch' : 'manual'}</dd>
        <dt className="text-faint">Started</dt>
        <dd>{job.startedAt ? new Date(job.startedAt * 1000).toLocaleString() : '–'}</dd>
        <dt className="text-faint">Duration</dt>
        <dd>{job.startedAt && job.finishedAt ? `${job.finishedAt - job.startedAt}s` : '–'}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        {(running || queued) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void stop()}>
            {running ? 'Stop' : 'Cancel'}
          </Button>
        )}
        {settled && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void rerun()}>
            Re-run
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void loadLogs()}>
          Logs
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href={`/jobs/detail?id=${job.jobId}`}>Open full detail</Link>
        </Button>
      </div>
      {logs && (
        <pre className="max-h-[160px] overflow-y-auto rounded-inner border border-line bg-muted p-2 font-mono text-[11px]">{logs.join('\n')}</pre>
      )}
    </div>
  )
}
