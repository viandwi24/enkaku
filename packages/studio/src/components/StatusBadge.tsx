import type { DeviceReadiness, DeviceStatus, JobStatus } from '@enkaku/protocol'
import { READINESS_BLOCKED_REASON } from '@/lib/readiness'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn } from '@enkaku/ui'

/**
 * The one place a status turns into a colour and a word.
 * Every screen uses this component instead of styling its own — that is what
 * keeps "busy" looking identical wherever it appears.
 */
/** Plan 205 §4.9 — `DeviceStatus` shrank to `offline`/`online`/`quarantined`; what used to be `idle`/`manual`/`busy` is now the live `activities` list (`ActivityBadge`), not this status word. */
const DEVICE_LABEL: Record<DeviceStatus, string> = {
  offline: 'offline',
  online: 'online',
  quarantined: 'quarantined',
}

const DEVICE_TONE: Record<DeviceStatus, string> = {
  online: 'text-led-ok border-led-ok/35 bg-led-ok/10',
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

export function JobStatusBadge({
  status,
  className,
  error,
}: {
  status: JobStatus
  className?: string
  /**
   * Why a job failed. Shown on the badge rather than as a line in the row:
   * an error is long, it is only interesting for the one row in a hundred
   * that failed, and inline it dominated every list it appeared in — and,
   * quoting a URL with no spaces, pushed every column off the screen. The
   * badge is where the eye already is when a row reads "failed".
   */
  error?: string | null
}) {
  const badge = (
    <span className={cn(base, JOB_TONE[status], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {JOB_LABEL[status]}
    </span>
  )
  if (status !== 'failed' || !error) return badge
  return (
    /* Its own provider: the app layout has one, but a shared badge that only
       works inside an ambient provider crashes the moment it is used anywhere
       else — including a test that renders it alone. Radix nests them. */
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        {/* `cursor-help` and a title so the affordance is discoverable without
            hovering first, and readable to anything that does not hover at all. */}
        <TooltipTrigger asChild>
          <span className="cursor-help" title={error}>
            {badge}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm wrap-anywhere text-[11.5px] leading-relaxed">{error}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Readiness — asleep|awake|hot (plan 43 §4.6). `desired` and `actual` are
 * shown SEPARATELY: mid-transition this reads e.g. "waking…" rather than
 * flickering between, or lying about, either value (acceptance #3). When
 * `actual` cannot reach `desired` at all, the specific reason is the
 * tooltip — a badge with no explanation is the thing operators file bugs
 * about (plan 43 §3.4).
 */
const READINESS_LABEL: Record<'asleep' | 'awake' | 'hot', string> = { asleep: 'asleep', awake: 'awake', hot: 'hot' }

const READINESS_TONE: Record<'asleep' | 'awake' | 'hot', string> = {
  asleep: 'text-fg-subtle border-line bg-transparent',
  awake: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  hot: 'text-led-ok border-led-ok/35 bg-led-ok/10',
}

/**
 * The badge states where the device IS, never where something wishes it were.
 *
 * It used to render `actual → desired` whenever the two disagreed. On a wall
 * that reads as a live transition, but nothing guarantees one is in flight:
 * observed on real hardware, two devices sat at `hot → asleep` for eight
 * minutes because the readiness manager never converged. Fifty tiles each
 * showing an arrow that means "at some point somebody asked for something
 * else" is noise, and worse, it is not true.
 *
 * The pending target is not thrown away — it moves to the tooltip, where it
 * costs no visual weight and can say plainly that the change never landed.
 */
export function ReadinessBadge({ readiness, className }: { readiness: DeviceReadiness; className?: string }) {
  const pending = readiness.actual !== readiness.desired && readiness.blocked === null
  const label = READINESS_LABEL[readiness.actual]
  const title = readiness.blocked
    ? `Waiting for ${READINESS_LABEL[readiness.desired]}: ${READINESS_BLOCKED_REASON[readiness.blocked] ?? readiness.blocked}`
    : pending
      ? `${READINESS_LABEL[readiness.desired]} was requested and has not taken effect`
      : undefined
  return (
    <span className={cn(base, READINESS_TONE[readiness.actual], className)} title={title}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  )
}

/** Plan 82 §4.6 — a plugin version's own status, one badge for the whole farm to read the same way. */
const PLUGIN_LABEL: Record<string, string> = {
  staged: 'staged',
  verifying: 'verifying',
  active: 'active',
  superseded: 'superseded',
  failed: 'failed',
  disabled: 'disabled',
}

const PLUGIN_TONE: Record<string, string> = {
  staged: 'text-fg-muted border-line bg-transparent',
  verifying: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  active: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  superseded: 'text-fg-subtle border-line bg-transparent',
  failed: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  disabled: 'text-led-off border-led-off/35 bg-led-off/10',
}

export function PluginStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn(base, PLUGIN_TONE[status] ?? PLUGIN_TONE.staged, className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {PLUGIN_LABEL[status] ?? status}
    </span>
  )
}

export { DEVICE_LABEL, JOB_LABEL }
