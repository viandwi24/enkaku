'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { ArtifactInfo, JobInfo } from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/JobStatusBadge'
import { coreBase, ws } from '@/lib/ws'

interface LogLine {
  ts: number
  level: string
  source: string
  msg: string
}

function JobDetail() {
  const jobId = useSearchParams().get('id')
  const [job, setJob] = useState<JobInfo | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!jobId) return
    void fetch(`${coreBase()}/api/jobs/${jobId}`)
      .then((r) => r.json() as Promise<{ job?: JobInfo; error?: { message: string } }>)
      .then((b) => (b.job ? setJob(b.job) : setError(b.error?.message ?? 'job tidak ada')))
      .catch((e) => setError(String(e)))

    const loadArtifacts = () =>
      fetch(`${coreBase()}/api/artifacts?jobId=${jobId}`)
        .then((r) => r.json() as Promise<{ artifacts: ArtifactInfo[] }>)
        .then((b) => setArtifacts(b.artifacts))
        .catch(() => undefined)
    void loadArtifacts()

    // Log & artifact realtime — tanpa polling.
    const off = ws.on((msg) => {
      if (msg.type === 'job.log' && msg.payload.jobId === jobId) {
        setLogs((prev) => [...prev.slice(-999), msg.payload])
      } else if (msg.type === 'job.artifact' && msg.payload.jobId === jobId) {
        setArtifacts((prev) => [...prev.filter((a) => a.id !== msg.payload.artifact.id), msg.payload.artifact])
      } else if (msg.type === 'job.status' && msg.payload.jobId === jobId) {
        setJob(msg.payload)
        if (['success', 'failed', 'cancelled'].includes(msg.payload.status)) void loadArtifacts()
      }
    })
    return off
  }, [jobId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  async function cancel() {
    if (!jobId) return
    await fetch(`${coreBase()}/api/jobs/${jobId}/cancel`, { method: 'POST' })
  }

  if (!jobId) return <p className="error">Parameter ?id= wajib.</p>
  if (error) return <p className="error">{error}</p>
  if (!job) return <p className="hint">Memuat job…</p>

  const cancellable = job.status === 'queued' || job.status === 'running'

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Job {job.jobId.slice(0, 8)}</h1>
          <div className="meta">
            {job.scriptId} · device {job.deviceId.slice(0, 8)} · prioritas {job.priority}
          </div>
        </div>
        <div className="row">
          <JobStatusBadge status={job.status} />
          {cancellable && <button onClick={() => void cancel()}>Cancel</button>}
        </div>
      </div>

      {job.error && <p className="error">{job.error}</p>}

      <div className="panel">
        <b>Log realtime</b>
        <pre className="out" ref={logRef} style={{ maxHeight: 320 }}>
          {logs.length === 0
            ? 'Menunggu log… (log yang sudah lewat tersimpan sebagai artifact job.log)'
            : logs
                .map((l) => `${new Date(l.ts).toLocaleTimeString()} [${l.level}] ${l.source}: ${l.msg}`)
                .join('\n')}
        </pre>
      </div>

      <div className="panel">
        <b>Artifacts ({artifacts.length})</b>
        {artifacts.length === 0 ? (
          <p className="hint" style={{ marginBottom: 0 }}>
            Belum ada artifact.
          </p>
        ) : (
          <div className="grid" style={{ marginTop: '0.75rem' }}>
            {artifacts.map((a) => (
              <div className="card" key={a.id}>
                <div className="card-title">
                  {a.label ?? a.kind} <span className="badge">{a.kind}</span>
                </div>
                {a.kind === 'screenshot' && (
                  <a href={`${coreBase()}/api/artifacts/${a.id}/content`} target="_blank" rel="noreferrer">
                    <img
                      src={`${coreBase()}/api/artifacts/${a.id}/content`}
                      alt={a.label ?? ''}
                      style={{ maxWidth: '100%', borderRadius: 6, marginBottom: '0.4rem' }}
                    />
                  </a>
                )}
                <div className="meta">{a.sizeBytes !== null ? `${(a.sizeBytes / 1024).toFixed(1)} KB` : ''}</div>
                <a className="hint" href={`${coreBase()}/api/artifacts/${a.id}/content`} target="_blank" rel="noreferrer">
                  Download
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

export default function JobDetailPage() {
  return (
    <Suspense fallback={<p className="hint">Memuat…</p>}>
      <JobDetail />
    </Suspense>
  )
}
