'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, ChevronDown, ChevronRight, Download } from 'lucide-react'
import type { ArtifactInfo } from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/StatusBadge'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, useAction } from '@/lib/actions'
import { deviceRefLabel, fetchAllPages, fetchDeviceRefs, type DeviceRef } from '@/lib/api'
import { duration, fileSize, relativeTime } from '@/lib/format'
import { formatResult, isRunnerLog, outcomeLine, producedArtifacts, type JobWithPhase } from '@/lib/jobs'
import { useNow } from '@/lib/useNow'
import { coreBase, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

interface LogLine {
  ts: number
  level: string
  source: string
  msg: string
}

/** `reset` (plan 35 §3.5) is the pre-job device reset — it always runs before `prepare`. */
const PHASES = ['reset', 'prepare', 'run', 'finish'] as const

/** Absolute time, because "5h ago" is useless when comparing two runs. */
function absolute(epochSeconds: number | null): string {
  if (!epochSeconds) return '—'
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function JobDetail() {
  const params = useSearchParams()
  const jobId = params.get('id')
  const tab = params.get('tab') ?? 'summary'

  const [job, setJob] = useState<JobWithPhase | null>(null)
  // The device a job ran on may have been forgotten since (plan 47 §3.4) —
  // resolved once the job itself loads, live or deleted either way.
  const [deviceRef, setDeviceRef] = useState<DeviceRef | undefined>(undefined)
  const [liveLogs, setLiveLogs] = useState<LogLine[]>([])
  const [savedLogs, setSavedLogs] = useState<LogLine[] | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [source, setSource] = useState<string | null | undefined>(undefined)
  const [followLog, setFollowLog] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The crash trace disclosure (plan 37 §4.5) — collapsed by default, fetched lazily on first open.
  const [traceOpen, setTraceOpen] = useState(false)
  const [traceText, setTraceText] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const { run, isPending } = useAction()
  // Run time and total-time tick without a refresh while a job is running.
  const now = useNow()

  const load = () => {
    if (!jobId) return
    setError(null)
    void api<{ job: JobWithPhase }>(`/api/jobs/${jobId}`)
      .then((b) => {
        setJob(b.job)
        // The script row is version-specific, so its source is exactly what ran.
        void api<{ script: { source?: string | null } }>(`/api/scripts/${b.job.scriptId}`)
          .then((s) => setSource(s.script.source ?? null))
          .catch(() => setSource(null))
        void fetchDeviceRefs([b.job.deviceId])
          .then((refs) => setDeviceRef(refs[b.job.deviceId]))
          .catch(() => undefined)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    // A job's artifacts are usually a handful, but a script producing many
    // screenshots is not unbounded here — this walks every page rather than
    // trusting the endpoint's default limit (plan 30 §4.2).
    void fetchAllPages<ArtifactInfo>('/api/artifacts', { jobId })
      .then(setArtifacts)
      .catch(() => undefined)
  }

  useEffect(load, [jobId])

  useEffect(() => {
    if (!jobId) return
    const off = ws.on((m) => {
      if (m.type === 'job.log' && m.payload.jobId === jobId) {
        setLiveLogs((p) => [...p.slice(-2000), m.payload])
      } else if (m.type === 'job.artifact' && m.payload.jobId === jobId) {
        setArtifacts((p) => [...p.filter((a) => a.id !== m.payload.artifact.id), m.payload.artifact])
      } else if (m.type === 'job.status' && m.payload.jobId === jobId) {
        setJob((p) => ({ ...(p ?? {}), ...m.payload }) as JobWithPhase)
        if (['success', 'failed', 'cancelled', 'expired'].includes(m.payload.status)) load()
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // A finished job's log lives in its job.log artifact. Without loading it, an
  // old job showed an empty panel even though every line had been kept.
  // Matched by label, not merely by kind: a crash trace (plan 37) is a `log`
  // artifact too, and picking that one would render a stack trace as the job's
  // log.
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

  // Live lines win while a job runs; the saved file is the record afterwards.
  const logs = liveLogs.length > 0 ? liveLogs : (savedLogs ?? [])

  useEffect(() => {
    if (followLog) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs, followLog])

  /**
   * What the RUN produced (plan 60 §3.5). The runner's own `job` log is
   * filtered out here and here only: the API still returns it, because the
   * Logs tab above downloads that exact artefact to render a finished job's
   * log. Listing it as a script output as well is what made every job look
   * like it had saved a file nobody asked for.
   */
  const produced = useMemo(() => producedArtifacts(artifacts), [artifacts])
  const images = useMemo(() => produced.filter((a) => a.kind === 'screenshot'), [produced])
  const files = useMemo(() => produced.filter((a) => a.kind !== 'screenshot'), [produced])
  // `crash-<pkg>`/`anr-<pkg>` is the exact label `saveCrashTrace` in daemon.ts
  // gives the artifact when a job lease was held (plan 37 §3.6) — found
  // among the job's own artifacts, no separate device_events query needed.
  const crashTraceArtifact = useMemo(
    () => artifacts.find((a) => a.kind === 'log' && (a.label?.startsWith('crash-') || a.label?.startsWith('anr-'))),
    [artifacts],
  )

  useEffect(() => {
    if (!traceOpen || !crashTraceArtifact || traceText !== null) return
    void fetch(`${coreBase()}/api/artifacts/${crashTraceArtifact.id}/content`)
      .then((r) => (r.ok ? r.text() : 'Could not load the trace.'))
      .then(setTraceText)
      .catch(() => setTraceText('Could not load the trace.'))
  }, [traceOpen, crashTraceArtifact, traceText])

  if (!jobId) return <div className="px-5 py-4"><ErrorState message="The address is missing an id parameter." /></div>
  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (!job) return <div className="px-5 py-4"><LoadingRows rows={3} /></div>

  const cancellable = job.status === 'queued' || job.status === 'running'
  const scriptName = job.scriptName ? `${job.scriptName}@${job.scriptVersion ?? '?'}` : job.scriptId
  // How long it waited for a free device, separate from how long it ran.
  const waited = job.startedAt ? job.startedAt - job.createdAt : null
  const finished = ['success', 'failed', 'cancelled', 'expired'].includes(job.status)

  /**
   * Why it failed, with the failing line shown rather than described (plan 60
   * §3.4). One definition, rendered in one place at a time: inside the
   * Summary outcome card when that tab is open, above the tabs otherwise —
   * so a failure is never more than a glance away and never printed twice.
   */
  const failureDetail =
    job.status === 'failed' && job.error ? (
      <div className="rounded-lg border border-led-danger/40 bg-led-danger/5 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="rack-label text-led-danger">
            failure reason{job.errorPhase ? ` — during ${job.errorPhase}` : ''}
          </p>
          {/* Plan 36 §4.4 — infra vs script vs load, so "this suite is flaky" becomes an answerable question. */}
          {job.failureClass && (
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                job.failureClass === 'infra' && 'border-led-warn/40 bg-led-warn/10 text-led-warn',
                job.failureClass === 'load' && 'border-line bg-transparent text-fg-muted',
                job.failureClass === 'script' && 'border-led-danger/40 bg-led-danger/10 text-led-danger',
              )}
            >
              {job.failureClass}
            </span>
          )}
        </div>
        <p className="mt-1 break-words text-[13px]">{job.error}</p>
        {crashTraceArtifact && (
          <div className="mt-2.5 border-t border-led-danger/20 pt-2.5">
            <button
              type="button"
              onClick={() => setTraceOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-led-danger hover:underline"
            >
              {traceOpen ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              {traceOpen ? 'Hide crash trace' : 'Show crash trace'}
            </button>
            {traceOpen && (
              <pre className="readout mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-led-danger/20 bg-surface p-2.5 text-[11px] leading-relaxed">
                {traceText ?? 'Loading…'}
              </pre>
            )}
          </div>
        )}
      </div>
    ) : null

  return (
    <>
      <PageHeader
        title={scriptName}
        description={`Job ${job.jobId.slice(0, 8)}`}
        meta={<JobStatusBadge status={job.status} />}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/jobs">
                <ArrowLeft className="size-4" aria-hidden />
                All jobs
              </Link>
            </Button>
            {cancellable && (
              <Button
                variant="outline"
                size="sm"
                disabled={isPending('cancel')}
                onClick={() =>
                  void run('cancel', () => api(`/api/jobs/${jobId}/cancel`, { method: 'POST' }), {
                    success: 'Job cancelled',
                    failure: 'Could not cancel the job',
                  })
                }
              >
                Cancel job
              </Button>
            )}
          </>
        }
      />

      <EntityTabs
        active={tab}
        tabs={[
          { key: 'summary', label: 'Summary' },
          { key: 'logs', label: 'Logs', count: logs.length || null },
          { key: 'artifacts', label: 'Artifacts', count: produced.length || null },
          { key: 'script', label: 'Script' },
        ]}
        hrefFor={(k) => `/jobs/detail?id=${jobId}${k === 'summary' ? '' : `&tab=${k}`}`}
      />

      {/* On every tab but Summary, where it has a card of its own. */}
      {tab !== 'summary' && failureDetail && <div className="mx-5 mt-4">{failureDetail}</div>}

      {tab === 'summary' && (
        <div className="grid gap-4 px-5 py-4 xl:grid-cols-[1fr_20rem]">
          <div className="space-y-4">
            {/* What happened, and what the script reported (plan 60 §3.3, §3.4) —
                the two things the person who ran it came here for. */}
            <div className="rounded-lg border bg-surface p-4">
              <h2 className="rack-label mb-3">outcome</h2>
              <p
                className={cn(
                  'text-[13.5px]',
                  job.status === 'success' && 'text-led-ok',
                  job.status === 'failed' && 'text-led-danger',
                  job.status === 'expired' && 'text-led-warn',
                )}
              >
                {outcomeLine(job)}
              </p>
              {failureDetail && <div className="mt-3">{failureDetail}</div>}

              <div className="mt-4 border-t pt-3">
                <h3 className="rack-label mb-2">returned</h3>
                {!finished ? (
                  <p className="text-[12.5px] text-fg-subtle">A script reports its result when it finishes.</p>
                ) : job.result === null || job.result === undefined ? (
                  <p className="text-[12.5px] text-fg-subtle">
                    This script returned nothing. A script that should report something — an exit IP, a version,
                    whether an element was there — returns it from <span className="readout">run()</span>.
                  </p>
                ) : (
                  <pre className="readout max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-bg p-2.5 text-[11.5px] leading-relaxed">
                    {formatResult(job.result)}
                  </pre>
                )}
              </div>
            </div>

            <div className="rounded-lg border bg-surface p-4">
              <h2 className="rack-label mb-3">phases</h2>
              <div className="flex flex-wrap items-center gap-2">
                {PHASES.map((f, i) => {
                  const active = job.phase === f && job.status === 'running'
                  const done =
                    job.status !== 'queued' && (PHASES.indexOf(job.phase ?? 'prepare') > i || job.status === 'success')
                  return (
                    <div key={f} className="flex items-center gap-2">
                      <span
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[11.5px]',
                          active
                            ? 'border-led-active/40 bg-led-active/10 text-led-active'
                            : done
                              ? 'border-led-ok/35 text-led-ok'
                              : 'text-fg-subtle',
                        )}
                      >
                        {f}
                      </span>
                      {i < PHASES.length - 1 && <span className="text-fg-subtle">→</span>}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="rounded-lg border bg-surface p-4">
              <h2 className="rack-label mb-3">timing</h2>
              <dl className="space-y-2.5">
                <Row label="Queued" value={absolute(job.createdAt)} note={relativeTime(job.createdAt, now)} />
                <Row
                  label="Started"
                  value={absolute(job.startedAt)}
                  note={waited !== null ? `waited ${duration(job.createdAt, job.startedAt, now)} for a device` : undefined}
                />
                <Row label="Finished" value={absolute(job.finishedAt)} />
                <Row
                  label="Run time"
                  value={job.startedAt ? duration(job.startedAt, job.finishedAt, now) : '—'}
                  note={job.status === 'running' ? 'still running' : undefined}
                />
                <Row label="Total, queue to finish" value={duration(job.createdAt, job.finishedAt, now)} />
              </dl>
            </div>
          </div>

          <aside>
            <div className="rounded-lg border bg-surface p-3.5">
              <h2 className="rack-label mb-2.5">identity</h2>
              <dl className="space-y-1.5">
                {[
                  ['job id', job.jobId],
                  ['script', scriptName],
                  ['device', deviceRefLabel(deviceRef, job.deviceId)],
                  ['priority', String(job.priority)],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3">
                    <dt className="text-[12px] text-fg-muted">{k}</dt>
                    <dd className="readout min-w-0 truncate text-[12px]" title={v}>{v}</dd>
                  </div>
                ))}
              </dl>
              {/* A forgotten device (plan 47 §3.4) has no page to open — the
                  link is dropped rather than pointing at a 404. */}
              {!deviceRef?.deleted && (
                <Button asChild variant="ghost" size="sm" className="mt-2 h-7 w-full text-[12px]">
                  <Link href={`/device?id=${encodeURIComponent(job.deviceId)}`}>Open device</Link>
                </Button>
              )}
            </div>
          </aside>
        </div>
      )}

      {tab === 'logs' && (
        <div className="px-5 py-4">
          <div className="overflow-hidden rounded-lg border bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <h2 className="rack-label">
                {liveLogs.length > 0 ? 'live' : savedLogs === null ? 'loading' : 'saved to job.log'}
              </h2>
              <label className="flex items-center gap-2 text-[11.5px] text-fg-muted">
                Follow latest
                <Switch checked={followLog} onCheckedChange={setFollowLog} aria-label="Follow latest lines" />
              </label>
            </div>
            <pre
              ref={logRef}
              className="readout max-h-[32rem] overflow-auto whitespace-pre-wrap p-3 text-[11.5px] leading-relaxed"
            >
              {savedLogs === null && liveLogs.length === 0
                ? 'Loading…'
                : logs.length === 0
                  ? 'This job produced no log lines.'
                  : logs
                      .map(
                        (l) =>
                          `${new Date(l.ts).toLocaleTimeString()}  ${l.level.padEnd(5)} ${l.source.padEnd(6)} ${l.msg}`,
                      )
                      .join('\n')}
            </pre>
          </div>
          <p className="mt-2 text-[11.5px] text-fg-subtle">
            Logs stream live while a job runs and are kept afterwards as the <span className="readout">job.log</span>{' '}
            artifact, so this panel works for old jobs too.
          </p>
        </div>
      )}

      {tab === 'artifacts' && (
        <div className="px-5 py-4">
          {produced.length === 0 ? (
            <EmptyState
              title="No artifacts"
              description="Screenshots and files a script saves with ctx.artifact appear here. The run's own log is on the Logs tab."
            />
          ) : (
            <div className="space-y-4">
              {images.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
                  {images.map((a) => (
                    <a
                      key={a.id}
                      href={`${coreBase()}/api/artifacts/${a.id}/content`}
                      target="_blank"
                      rel="noreferrer"
                      className="group overflow-hidden rounded border hover:border-accent"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${coreBase()}/api/artifacts/${a.id}/content`}
                        alt={a.label ?? 'screenshot'}
                        className="aspect-[9/16] w-full object-cover"
                      />
                      <span className="block truncate px-1.5 py-1 text-[10.5px] text-fg-muted">{a.label}</span>
                    </a>
                  ))}
                </div>
              )}
              {files.length > 0 && (
                <div className="divide-y overflow-hidden rounded-lg border">
                  {files.map((a) => (
                    <a
                      key={a.id}
                      href={`${coreBase()}/api/artifacts/${a.id}/content`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-surface-2"
                    >
                      <Download className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{fileName(a)}</span>
                      <span className="readout shrink-0 text-[11px] text-fg-subtle">{fileSize(a.sizeBytes)}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'script' && (
        <div className="px-5 py-4">
          {source === undefined ? (
            <LoadingRows rows={4} />
          ) : source === null ? (
            <EmptyState
              title="No source stored for this script"
              description={
                <>
                  Only the bundle was kept when this version was published. Publishing again with a newer CLI stores the
                  entry source alongside it, and it will show up here.
                </>
              }
            />
          ) : (
            <>
              <p className="mb-2 text-[12px] text-fg-muted">
                The exact source of <span className="readout">{scriptName}</span> — jobs record a specific script
                version, so this is what ran, not whatever is published now.
              </p>
              <pre className="readout max-h-[36rem] overflow-auto whitespace-pre rounded-lg border bg-surface p-3 text-[11.5px] leading-relaxed">
                {source}
              </pre>
            </>
          )}
        </div>
      )}
    </>
  )
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-[12.5px] text-fg-muted">{label}</dt>
      <dd className="readout text-[12.5px]">{value}</dd>
      {note && <span className="w-full text-right text-[11px] text-fg-subtle">{note}</span>}
    </div>
  )
}

/**
 * The name the file actually downloads as, rather than its internal label —
 * "job.log" says what is inside, "job" does not.
 */
function fileName(a: ArtifactInfo): string {
  const base = a.path.split('/').pop() ?? ''
  const stripped = base.replace(/^\d+-/, '')
  return stripped || a.label || a.kind
}

export default function JobDetailPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={3} /></div>}>
      <JobDetail />
    </Suspense>
  )
}
