import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import {
  JobLogsResponseSchema,
  JobResponseSchema,
  RuntimeEnvelopeSchema,
  WorkflowDocSchema,
  type ArtifactInfo,
  type ParamIssue,
  type JsonSchemaNode as ProtocolJsonSchemaNode,
  type ResultStatus,
  type RuntimeEnvelope,
  type WorkflowDoc,
} from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { fetchAllPages, fetchDeviceRefs, type DeviceRef } from './api'
import { isRunnerLog, producedArtifacts, type JobWithPhase } from './jobs'
import { coreBase, ws } from './ws'

/**
 * The job-detail data layer — extracted from `app/jobs/detail/page.tsx`
 * (2026-08-16, closing plan 103 step 103.11's audit row 4: "the Jobs popup
 * lists jobs and stops there"). `/jobs/detail` is 1,570 lines and nothing in
 * it was ever a reusable unit before this pass — the standalone page and
 * `JobDetailPanel.tsx` (the device popup's in-place job detail, plan 103 §9
 * Q2) both call THIS hook now rather than one forking a thinner copy of the
 * other's fetch logic. §9 Q2's own instruction ("reuse what `/jobs/detail`
 * already renders … rather than writing thinner versions") applies to the
 * DATA layer exactly as much as the components built on top of it
 * (`JobResultSection`, `JobLogsPanel`, `JobArtifactsPanel`,
 * `JobFailureDetail`, all in `components/jobs/`) — a merge algorithm this
 * subtle (see `logs` below) is exactly the kind of thing a second,
 * "close enough" copy quietly drifts from.
 *
 * **What stayed on the page, deliberately not folded in here**: the
 * workflow node timeline (`nodes`/`workflowDoc`'s OWN gate-verdict
 * rendering), lineage (`chainNodes`/`rootInfo`), and the farm's
 * memory-limit setting (`farmJobSettings`).
 * None of those are among the four surfaces plan 103's own gap named
 * ("result, response, input params, logs, artifact") — they stay page-only,
 * a narrower scope named here rather than silently ported, the same
 * discipline `SettingsPopup.tsx` already uses for its own six-of-many
 * sections.
 */

export interface LogLine {
  ts: number
  level: string
  source: string
  msg: string
}

/**
 * Plan 97 §4.6, step 97.5's own note, carried over verbatim: `JobDetail`
 * does not yet carry these on the wire type, so they are declared locally,
 * all optional, and degrade to the `<pre>` fallback exactly like before the
 * day the server starts sending them.
 */
export interface JobWithResultInfo {
  resultStatus?: ResultStatus | null
  resultBytes?: number | null
  resultIssues?: ParamIssue[] | null
  resultSchema?: ProtocolJsonSchemaNode | null
}
/**
 * Plan 211 §3.2 decision 9 — `job.status` no longer carries a live `node`
 * block (`job_nodes`/the per-node counter are gone; a workflow step is now
 * a real job with its own row, read through `/api/workflow-jobs/:id/runs/
 * :runId/steps`). The type keeps its name (`JobWithNode`) rather than
 * churning every caller across the codebase for a rename with no behavior
 * change; it carries no `node` field any more.
 */
export type JobWithNode = JobWithPhase & JobWithResultInfo

/**
 * `GET /api/scripts/:id` returns a full `ScriptRowSchema`, but this hook
 * only reads `.script.source`/`.script.workflow`/`.script.runtime` — the
 * same narrower ad-hoc schema `/jobs/detail` always used (plan 72's own
 * brief allows it).
 */
const ScriptSourceResponseSchema = z.object({
  script: z.object({
    source: z.string().nullable().optional(),
    workflow: WorkflowDocSchema.nullable().optional(),
    runtime: RuntimeEnvelopeSchema.nullable().optional(),
  }),
})

export type LogsPhase = 'loading' | 'live' | 'saved'

export interface JobDetailState {
  job: JobWithNode | null
  deviceRef: DeviceRef | undefined
  source: string | null | undefined
  workflowDoc: WorkflowDoc | null
  scriptRuntime: RuntimeEnvelope | null
  artifacts: ArtifactInfo[]
  produced: ArtifactInfo[]
  images: ArtifactInfo[]
  files: ArtifactInfo[]
  crashTraceArtifact: ArtifactInfo | undefined
  logs: LogLine[]
  logsTruncated: boolean
  logsPhase: LogsPhase
  error: string | null
  /** Re-fetches job/source/deviceRef/artifacts/logs — the same set `load()` re-fetched on the page before this extraction. */
  load: () => void
}

/**
 * The four surfaces plan 103's audit named — job/result/params (`job`
 * itself, read through `ResultView`/`formatResult` by the caller), logs
 * (`logs`/`logsTruncated`/`logsPhase`), and artifacts
 * (`artifacts`/`produced`/`images`/`files`) — plus the script source and
 * device reference every one of those needs to render correctly. Used by
 * BOTH `/jobs/detail` (the full page) and `JobDetailPanel.tsx` (the device
 * popup's in-place Jobs tab).
 */
export function useJobDetail(jobId: string | null): JobDetailState {
  const [job, setJob] = useState<JobWithNode | null>(null)
  const [deviceRef, setDeviceRef] = useState<DeviceRef | undefined>(undefined)
  const [source, setSource] = useState<string | null | undefined>(undefined)
  const [workflowDoc, setWorkflowDoc] = useState<WorkflowDoc | null>(null)
  const [scriptRuntime, setScriptRuntime] = useState<RuntimeEnvelope | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [liveLogs, setLiveLogs] = useState<LogLine[]>([])
  const [savedLogs, setSavedLogs] = useState<LogLine[] | null>(null)
  const [backfillLogs, setBackfillLogs] = useState<LogLine[] | null>(null)
  const [logsTruncated, setLogsTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function load(): void {
    if (!jobId) return
    setError(null)
    void api(`/api/jobs/${jobId}`, JobResponseSchema)
      .then((b) => {
        setJob(b.job)
        // The script row is version-specific, so its source (and workflow
        // document, and declared runtime envelope) is exactly what ran.
        void api(`/api/scripts/${b.job.scriptId}`, ScriptSourceResponseSchema)
          .then((s) => {
            setSource(s.script.source ?? null)
            setWorkflowDoc(s.script.workflow ?? null)
            setScriptRuntime(s.script.runtime ?? null)
          })
          .catch(() => {
            setSource(null)
            setWorkflowDoc(null)
            setScriptRuntime(null)
          })
        void fetchDeviceRefs([b.job.deviceId])
          .then((refs) => setDeviceRef(refs[b.job.deviceId]))
          .catch(() => undefined)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    // A job's artifacts are usually a handful, but a script producing many
    // screenshots is not unbounded here (plan 30 §4.2) — every page is walked.
    void fetchAllPages<ArtifactInfo>('/api/artifacts', { jobId }).then(setArtifacts).catch(() => undefined)
    // What the job has ALREADY logged (`/ws` has no snapshot replay, so
    // without this a page opened mid-run showed nothing that happened
    // before it subscribed — the fetch half of fetch-then-subscribe).
    void api(`/api/jobs/${jobId}/logs`, JobLogsResponseSchema)
      .then((r) => {
        setBackfillLogs(r.lines)
        setLogsTruncated(r.truncated)
      })
      .catch(() => setBackfillLogs([]))
  }

  useEffect(() => {
    setJob(null)
    setDeviceRef(undefined)
    setSource(undefined)
    setWorkflowDoc(null)
    setScriptRuntime(null)
    setArtifacts([])
    setLiveLogs([])
    setSavedLogs(null)
    setBackfillLogs(null)
    setError(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  useEffect(() => {
    if (!jobId) return
    const off = ws.on((m) => {
      if (m.type === 'job.log' && m.payload.jobId === jobId) {
        setLiveLogs((p) => [...p.slice(-2000), m.payload])
      } else if (m.type === 'job.artifact' && m.payload.jobId === jobId) {
        setArtifacts((p) => [...p.filter((a) => a.id !== m.payload.artifact.id), m.payload.artifact])
      } else if (m.type === 'job.status' && m.payload.jobId === jobId) {
        setJob((p) => ({ ...(p ?? {}), ...m.payload }) as JobWithNode)
        if (['success', 'failed', 'cancelled', 'expired'].includes(m.payload.status)) load()
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // A finished job's log lives in its `job.log` artifact — matched by label
  // as well as kind (a crash trace is a `log` artifact too, and picking that
  // one would render a stack trace as the job's log).
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

  // The three sources are MERGED, not chosen between — see the long-standing
  // reasoning this carries over verbatim from `app/jobs/detail/page.tsx`: a
  // WS reconnect has no replay, and the runner writes its log file once, in
  // its `finally`, not progressively, so neither source alone is complete.
  const logs = useMemo(() => {
    const byKey = new Map<string, LogLine>()
    for (const line of [...(savedLogs ?? []), ...(backfillLogs ?? []), ...liveLogs]) {
      byKey.set(`${line.ts}|${line.level}|${line.msg}`, line)
    }
    return [...byKey.values()].sort((a, b) => a.ts - b.ts)
  }, [savedLogs, backfillLogs, liveLogs])

  const logsPhase: LogsPhase =
    liveLogs.length > 0 || (backfillLogs?.length ?? 0) > 0 ? 'live' : backfillLogs === null && savedLogs === null ? 'loading' : 'saved'

  const produced = useMemo(() => producedArtifacts(artifacts), [artifacts])
  const images = useMemo(() => produced.filter((a) => a.kind === 'screenshot'), [produced])
  const files = useMemo(() => produced.filter((a) => a.kind !== 'screenshot'), [produced])
  const crashTraceArtifact = useMemo(
    () => artifacts.find((a) => a.kind === 'log' && (a.label?.startsWith('crash-') || a.label?.startsWith('anr-'))),
    [artifacts],
  )

  return {
    job,
    deviceRef,
    source,
    workflowDoc,
    scriptRuntime,
    artifacts,
    produced,
    images,
    files,
    crashTraceArtifact,
    logs,
    logsTruncated,
    logsPhase,
    error,
    load,
  }
}
