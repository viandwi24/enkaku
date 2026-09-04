import { useEffect, useState } from 'react'
import {
  JobLogsResponseSchema,
  JobResponseSchema,
  JobRunResponseSchema,
  RunArtifactsResponseSchema,
  WorkflowStepsResponseSchema,
  type ArtifactInfo,
  type JobDetail,
  type JobRunDetail,
  type JobRunInfo,
  type WorkflowStepInfo,
} from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { fetchDeviceRefs, type DeviceRef } from './api'
import { isRunnerLog } from './jobs'
import { coreBase, ws } from './ws'

/**
 * The job-detail data layer, rewritten for the run-scoped shape plan 211
 * landed (plan 218 §4.3.1). Replaces the pre-211 version, whose reads were
 * job-scoped only (`/api/jobs/:id/logs`, no `runId` anywhere) — the run
 * picker, run comparison and the Timeline tab all need a SPECIFIC run's
 * data, not just the job's.
 */

export interface LogLine {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  source: 'script' | 'stdout' | 'stderr' | 'runner'
  msg: string
}

export type LogsPhase = 'loading' | 'live' | 'saved'

export interface JobDetailState {
  /** `GET /api/jobs/:id`. Null while loading and when the read failed. */
  job: JobDetail | null
  /** `job.runs`, newest first, exactly as the route returns them (plan 211 §4.2.1). */
  runs: JobRunInfo[]
  /** The run named by `runId`, or the latest when `runId` is null. `GET /api/jobs/:id/runs/:runId`. */
  run: JobRunDetail | null
  /** Resolved for the meta line and the Open device button. `deleted` marks a forgotten device (plan 47 §3.4). */
  deviceRef: DeviceRef | undefined
  /** `GET /api/jobs/:id/runs/:runId/artifacts`, minus the runner's own `job.log` (`isRunnerLog`). */
  artifacts: ArtifactInfo[]
  /** The three-source merge, unchanged in algorithm from the file this replaces. */
  logs: LogLine[]
  logsTruncated: boolean
  logsPhase: LogsPhase
  /** `GET /api/workflow-jobs/:id/runs/:runId/steps`; always empty for `kind === 'script'`. */
  steps: WorkflowStepInfo[]
  stepsFinalized: boolean
  error: string | null
  reload: () => void
}

/** `runId` null means "the job's latest run" (`job.runId`). */
export function useJobDetail(jobId: string | null, runId: string | null): JobDetailState {
  const [job, setJob] = useState<JobDetail | null>(null)
  const [run, setRun] = useState<JobRunDetail | null>(null)
  const [deviceRef, setDeviceRef] = useState<DeviceRef | undefined>(undefined)
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [liveLogs, setLiveLogs] = useState<LogLine[]>([])
  const [savedLogs, setSavedLogs] = useState<LogLine[] | null>(null)
  const [backfillLogs, setBackfillLogs] = useState<LogLine[] | null>(null)
  const [logsTruncated, setLogsTruncated] = useState(false)
  const [steps, setSteps] = useState<WorkflowStepInfo[]>([])
  const [stepsFinalized, setStepsFinalized] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveRunId = runId ?? job?.runId ?? null

  function load(): void {
    if (!jobId) return
    setError(null)
    void api(`/api/jobs/${jobId}`, JobResponseSchema)
      .then((b) => {
        setJob(b.job)
        void fetchDeviceRefs([b.job.deviceId])
          .then((refs) => setDeviceRef(refs[b.job.deviceId]))
          .catch(() => undefined)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  // Job — fetch, then subscribe. Reset on job id change only: switching the
  // run does not re-read the job itself.
  useEffect(() => {
    setJob(null)
    setDeviceRef(undefined)
    setError(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  useEffect(() => {
    if (!jobId) return
    const off = ws.on((m) => {
      if (m.type === 'job.status' && m.payload.jobId === jobId) {
        setJob((p) => (p ? { ...p, ...m.payload } : p))
        // A terminal status settles the run list and the artifacts.
        if (['success', 'failed', 'cancelled', 'expired'].includes(m.payload.status)) load()
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // The specific run — a separate read, keyed on (jobId, effectiveRunId).
  useEffect(() => {
    setRun(null)
    setArtifacts([])
    setLiveLogs([])
    setSavedLogs(null)
    setBackfillLogs(null)
    setLogsTruncated(false)
    if (!jobId || !effectiveRunId) return
    let disposed = false
    void api(`/api/jobs/${jobId}/runs/${effectiveRunId}`, JobRunResponseSchema)
      .then((b) => {
        if (!disposed) setRun(b.run)
      })
      .catch((e) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      })
    void api(`/api/jobs/${jobId}/runs/${effectiveRunId}/artifacts`, RunArtifactsResponseSchema)
      .then((b) => {
        if (!disposed) setArtifacts(b.items)
      })
      .catch(() => undefined)
    void api(`/api/jobs/${jobId}/runs/${effectiveRunId}/logs`, JobLogsResponseSchema)
      .then((r) => {
        if (disposed) return
        setBackfillLogs(r.lines)
        setLogsTruncated(r.truncated)
      })
      .catch(() => {
        if (!disposed) setBackfillLogs([])
      })
    return () => {
      disposed = true
    }
  }, [jobId, effectiveRunId])

  useEffect(() => {
    if (!jobId || !effectiveRunId) return
    const off = ws.on((m) => {
      if (m.type === 'job.log' && m.payload.jobId === jobId && m.payload.runId === effectiveRunId) {
        setLiveLogs((p) => [...p.slice(-2000), m.payload])
      } else if (m.type === 'job.artifact' && m.payload.jobId === jobId && m.payload.runId === effectiveRunId) {
        setArtifacts((p) => [...p.filter((a) => a.id !== m.payload.artifact.id), m.payload.artifact])
      }
    })
    return off
  }, [jobId, effectiveRunId])

  // Steps — only for a workflow job, re-read on every `job.status` for this job.
  useEffect(() => {
    setSteps([])
    setStepsFinalized(false)
    if (!jobId || !effectiveRunId || job?.kind !== 'workflow') return
    let disposed = false
    void api(`/api/workflow-jobs/${jobId}/runs/${effectiveRunId}/steps`, WorkflowStepsResponseSchema)
      .then((b) => {
        if (disposed) return
        setSteps(b.items)
        setStepsFinalized(b.finalized)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [jobId, effectiveRunId, job?.kind, job?.status])

  // A finished run's log lives in its `job.log` artifact — matched by label
  // as well as kind (a crash trace is a `log` artifact too, and picking that
  // one would render a stack trace as the run's log).
  const logArtifact = artifacts.find(isRunnerLog)
  useEffect(() => {
    if (!logArtifact || savedLogs !== null) return
    void fetch(`${coreBase()}/api/artifacts/${logArtifact.id}/content`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) =>
        setSavedLogs(
          text
            .split('\n')
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line) as LogLine]
              } catch {
                return []
              }
            }),
        ),
      )
      .catch(() => setSavedLogs([]))
  }, [logArtifact, savedLogs])

  // The three sources are MERGED, not chosen between: a WS reconnect has no
  // replay, and the runner writes its log file once, in its `finally`, not
  // progressively, so neither source alone is complete.
  const byKey = new Map<string, LogLine>()
  for (const line of [...(savedLogs ?? []), ...(backfillLogs ?? []), ...liveLogs]) {
    byKey.set(`${line.ts}|${line.level}|${line.msg}`, line)
  }
  const logs = [...byKey.values()].sort((a, b) => a.ts - b.ts)

  const logsPhase: LogsPhase =
    liveLogs.length > 0 || (backfillLogs?.length ?? 0) > 0 ? 'live' : backfillLogs === null && savedLogs === null ? 'loading' : 'saved'

  return {
    job,
    runs: job?.runs ?? [],
    run,
    deviceRef,
    artifacts: artifacts.filter((a) => !isRunnerLog(a)),
    logs,
    logsTruncated,
    logsPhase,
    steps,
    stepsFinalized,
    error,
    reload: load,
  }
}
