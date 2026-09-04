'use client'

import { useEffect, useState } from 'react'
import { StorageUsageResponseSchema, type StorageUsageKind } from '@enkaku/protocol'
import { api, relativeTime } from '@enkaku/ui'

const KIND_LABELS: Record<StorageUsageKind, string> = {
  jobsAndLogs: 'Jobs and logs',
  traceFrames: 'Trace frames',
  artifacts: 'Artifacts',
  audit: 'Audit log',
}

function humanBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`
}

/**
 * The Storage usage row (plan 224 §4.8): a per-kind usage readout, spliced
 * above the schema-driven `storage.*` fields the same way plan 219 splices
 * Access and Toolchain beside a farm-section id. Reads `GET
 * /api/storage/usage` — a cache the retention sweeper maintains, never a
 * live filesystem walk on this request path.
 */
export function StorageUsageRow() {
  const [rows, setRows] = useState<Array<{ kind: StorageUsageKind; bytes: number; rows: number; computedAt: number }> | null>(null)

  useEffect(() => {
    api('/api/storage/usage', StorageUsageResponseSchema)
      .then((res) => setRows(res.kinds))
      .catch(() => setRows(null))
  }, [])

  if (!rows || rows.length === 0) return null

  return (
    <div className="mb-4 rounded-card border border-line bg-muted-2 p-3">
      <p className="mb-2 text-meta font-medium text-faint">Storage usage</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        {rows.map((r) => (
          <div key={r.kind} className="flex flex-col">
            <span className="text-badge text-faint-2">{KIND_LABELS[r.kind]}</span>
            <span className="font-mono text-body text-text">{humanBytes(r.bytes)}</span>
            <span className="text-badge text-faint-2">as of {r.computedAt ? relativeTime(r.computedAt) : 'unknown'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
