'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import { JobStatusBadge } from '@/components/JobStatusBadge'
import { fetchDevices } from '@/lib/api'
import { coreBase, ws } from '@/lib/ws'

const fmtTime = (sec: number | null): string => (sec ? new Date(sec * 1000).toLocaleTimeString() : '—')

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [durationMs, setDurationMs] = useState('3000')
  const [priority, setPriority] = useState('0')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  async function loadJobs() {
    const res = await fetch(`${coreBase()}/api/jobs?limit=50`)
    const body = (await res.json()) as { jobs: JobInfo[] }
    setJobs(body.jobs)
  }

  useEffect(() => {
    void loadJobs().catch((err) => setError(String(err)))
    void fetchDevices()
      .then((d) => {
        setDevices(d)
        setDeviceId((prev) => prev || (d[0]?.id ?? ''))
      })
      .catch((err) => setError(String(err)))

    // Realtime: update row in-place, tanpa polling.
    const off = ws.on((msg) => {
      if (msg.type !== 'job.status') return
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.jobId === msg.payload.jobId)
        if (idx === -1) return [msg.payload, ...prev]
        const next = [...prev]
        next[idx] = msg.payload
        return next
      })
    })
    return off
  }, [])

  async function enqueue() {
    setError(null)
    try {
      const res = await fetch(`${coreBase()}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scriptId: 'internal:sleep',
          deviceId,
          params: { durationMs: Number.parseInt(durationMs, 10) },
          priority: Number.parseInt(priority, 10) || 0,
        }),
      })
      const body = (await res.json()) as { job?: JobInfo; error?: { message: string } }
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function cancel(jobId: string) {
    const res = await fetch(`${coreBase()}/api/jobs/${jobId}/cancel`, { method: 'POST' })
    if (!res.ok) {
      const body = (await res.json()) as { error?: { message: string } }
      setError(body.error?.message ?? `HTTP ${res.status}`)
    }
  }

  const deviceLabel = (id: string) => devices.find((d) => d.id === id)?.label ?? id.slice(0, 8)

  return (
    <>
      <h1>Jobs</h1>

      <div className="panel">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label>
            Device
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.length === 0 && <option value="">(belum ada device)</option>}
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} — {d.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            durationMs
            <input value={durationMs} onChange={(e) => setDurationMs(e.target.value)} />
          </label>
          <label>
            Priority
            <input value={priority} onChange={(e) => setPriority(e.target.value)} />
          </label>
          <button className="primary" onClick={() => void enqueue()} disabled={!deviceId}>
            Enqueue internal:sleep
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          Dummy job untuk memvalidasi antrian: job berjalan satu per satu per device, urut prioritas lalu waktu buat.
        </p>
      </div>

      {error && <p className="error">{error}</p>}

      {jobs.length === 0 ? (
        <p className="hint">Belum ada job.</p>
      ) : (
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 12 }}>
                <th style={{ padding: '0.6rem' }}>Job</th>
                <th>Script</th>
                <th>Device</th>
                <th>Status</th>
                <th>Prio</th>
                <th>Dibuat</th>
                <th>Mulai</th>
                <th>Selesai</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr
                  key={j.jobId}
                  style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => setExpanded(expanded === j.jobId ? null : j.jobId)}
                >
                  <td style={{ padding: '0.6rem' }} className="meta">
                    <Link href={`/jobs/detail?id=${j.jobId}`} onClick={(e) => e.stopPropagation()}>
                      {j.jobId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="meta">{j.scriptId}</td>
                  <td>{deviceLabel(j.deviceId)}</td>
                  <td>
                    <JobStatusBadge status={j.status} />
                    {expanded === j.jobId && j.error && <div className="error">{j.error}</div>}
                  </td>
                  <td>{j.priority}</td>
                  <td className="meta">{fmtTime(j.createdAt)}</td>
                  <td className="meta">{fmtTime(j.startedAt)}</td>
                  <td className="meta">{fmtTime(j.finishedAt)}</td>
                  <td>
                    {(j.status === 'queued' || j.status === 'running') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void cancel(j.jobId)
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
