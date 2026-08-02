import type { DeviceStatus, JobStatus } from '@enkaku/protocol'
import { cn } from '@/lib/utils'

/**
 * The one place a status turns into a colour and a word.
 * Every screen uses this component instead of styling its own — that is what
 * keeps "busy" looking identical wherever it appears.
 */
const DEVICE_LABEL: Record<DeviceStatus, string> = {
  idle: 'ready',
  manual: 'controlled',
  busy: 'running a job',
  offline: 'disconnected',
  quarantined: 'quarantined',
}

const DEVICE_TONE: Record<DeviceStatus, string> = {
  idle: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  manual: 'text-led-active border-led-active/35 bg-led-active/10',
  busy: 'text-led-active border-led-active/35 bg-led-active/10',
  offline: 'text-fg-subtle border-line bg-transparent',
  quarantined: 'text-led-danger border-led-danger/40 bg-led-danger/10',
}

const JOB_LABEL: Record<JobStatus, string> = {
  queued: 'queued',
  running: 'running',
  success: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  // Plan 21 §3.3 — distinct from `failed`: this job never got a device
  // before its queue deadline, it did not run and fail.
  expired: 'expired',
}

const JOB_TONE: Record<JobStatus, string> = {
  queued: 'text-fg-muted border-line bg-transparent',
  running: 'text-led-active border-led-active/35 bg-led-active/10',
  success: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  failed: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  cancelled: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  // A visually distinct tone from `failed` (plan 21 §21.1) — a muted slate
  // dot (`led-off`, otherwise unused by any status badge) rather than red,
  // since this is a capacity outcome, not a script bug.
  expired: 'text-led-off border-led-off/35 bg-led-off/10',
}

const base =
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap'

export function DeviceStatusBadge({ status, className }: { status: DeviceStatus; className?: string }) {
  return (
    <span className={cn(base, DEVICE_TONE[status], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {DEVICE_LABEL[status]}
    </span>
  )
}

export function JobStatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  return (
    <span className={cn(base, JOB_TONE[status], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {JOB_LABEL[status]}
    </span>
  )
}

export { DEVICE_LABEL, JOB_LABEL }
