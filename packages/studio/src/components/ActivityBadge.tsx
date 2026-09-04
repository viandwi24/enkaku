import Link from 'next/link'
import type { DeviceActivity, LastControl } from '@enkaku/protocol'
import { useNow } from '@/lib/useNow'

/** The tail window (seconds) `packages/core/src/activity/registry.ts`'s `LAST_CONTROL_TAIL_SEC` also uses — kept after a control marker ends. */
const LAST_CONTROL_TAIL_SEC = 120

/**
 * "A device says what is happening to it" (plan 205 §4.11) — one component,
 * replacing the two former exclusive/shared control-badge components (which
 * only ever knew about the two now-deleted per-owner fields). One chip per live
 * `DeviceActivity`; when none are live and the device was controlled within
 * the last `LAST_CONTROL_TAIL_SEC`, a muted "Last controlled Ns ago by X"
 * line instead of a blank space.
 *
 * `asLink: false` (the same escape hatch `HolderBadge` had) renders every
 * chip as a plain `<span>` instead of a `next/link` — for a caller whose own
 * root element is ALREADY a link (`WallTile`'s tile is the whole card); the
 * HTML spec forbids a nested interactive descendant.
 */
export function ActivityBadge({
  activities,
  lastControl,
  className,
  asLink = true,
}: {
  activities: DeviceActivity[]
  lastControl: LastControl | null
  className?: string
  asLink?: boolean
}) {
  const now = useNow(1000)

  if (activities.length === 0) {
    if (!lastControl) return null
    const elapsedSec = Math.max(0, Math.floor(now / 1000) - lastControl.endedAt)
    if (elapsedSec > LAST_CONTROL_TAIL_SEC) return null
    return <span className={`text-[11px] text-fg-muted ${className ?? ''}`}>Last controlled {elapsedSec}s ago by {lastControl.actor.label}</span>
  }

  return (
    <span className={`inline-flex max-w-full flex-wrap items-center gap-1 ${className ?? ''}`}>
      {activities.map((activity) => (
        <ActivityChip key={activity.id} activity={activity} asLink={asLink} />
      ))}
    </span>
  )
}

function ActivityChip({ activity, asLink }: { activity: DeviceActivity; asLink: boolean }) {
  const cls = 'inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3'
  if (asLink && activity.href) {
    return (
      <Link href={activity.href} className={cls} title={activity.label}>
        <span className="truncate">{activity.label}</span>
      </Link>
    )
  }
  return (
    <span className={cls} title={activity.label}>
      <span className="truncate">{activity.label}</span>
    </span>
  )
}
