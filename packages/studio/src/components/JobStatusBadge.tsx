'use client'

import type { JobStatus } from '@enkaku/protocol'

const CLASS: Record<JobStatus, string> = {
  queued: 'offline',
  running: 'busy',
  success: 'idle',
  failed: 'quarantined',
  cancelled: 'unauthorized',
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge ${CLASS[status]}`}>{status}</span>
}
