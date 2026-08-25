'use client'

import { Loader2, Moon, Sun } from 'lucide-react'
import type { DeviceInfo, DeviceReadiness, Readiness } from '@enkaku/protocol'
import { Button, cn, formatDeviceName, useAction } from '@enkaku/ui'
import { setDeviceReadiness } from '@/lib/readiness'

/**
 * The label is derived from `actual`, never `desired` (plan 49 §3.2, §4.2):
 * a button names the action it performs, and `desired` is standing intent,
 * not present fact. Reading `desired` produced two reported bugs — the label
 * flipping to "Sleep" the instant Wake is pressed, before the device is
 * actually awake, and a device woken by a hold (job/viewer/transfer) keeping
 * `desired: asleep` by design (plan 45 §3.6) while its button still claimed
 * "Wake". While `desired !== actual` the button shows a pending state
 * instead, so it never claims a change that has not happened yet.
 *
 * Pulled out as a pure function (no hooks, no JSX) so it can be unit tested
 * directly — `ReadinessControl` itself calls `useAction`, and this workspace
 * has no DOM renderer to mount a component that uses hooks (see
 * `TileChips.test.tsx`'s note on this).
 */
export function deriveReadinessAction(readiness: Pick<DeviceReadiness, 'desired' | 'actual'>): {
  isAsleep: boolean
  label: 'Wake' | 'Sleep'
  target: Readiness
  transitioning: boolean
} {
  const isAsleep = readiness.actual === 'asleep'
  return {
    isAsleep,
    label: isAsleep ? 'Wake' : 'Sleep',
    target: isAsleep ? 'hot' : 'asleep',
    transitioning: readiness.desired !== readiness.actual,
  }
}

/**
 * Wake / Sleep, without opening the device's video (plan 43 §1, §4.6). The
 * server is the ONLY gate (acceptance #7) — this component never disables
 * itself on a guess; it always tries and shows whatever reason the server
 * gives back (`useAction`'s toast), except for `offline`/`quarantined`,
 * which are refused unconditionally server-side too and disabled here purely
 * so the button is not a dead click for the single most common case.
 */
export function ReadinessControl({
  device,
  size = 'sm',
  className,
}: {
  device: DeviceInfo
  size?: 'sm' | 'default'
  className?: string
}) {
  const { run, isPending } = useAction()
  const unreachable = device.status === 'offline' || device.status === 'quarantined'
  const { isAsleep, label, target, transitioning } = deriveReadinessAction(device.readiness)
  const key = `readiness-${device.id}`

  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      className={cn('text-[12px]', className)}
      /**
       * `transitioning` deliberately does NOT disable this button.
       *
       * `actual` is derived from whether a live session exists, not from a
       * converging state machine (core `readiness.ts`: a session means `hot`).
       * So `desired !== actual` is a perfectly normal steady state for as long
       * as anyone is watching the device — the Wall included. Treating it as
       * "a change is in flight" left Sleep permanently disabled, showing a
       * spinner and an ellipsis on every streaming tile, which is exactly the
       * dead end an operator reported. It also contradicted this component's
       * own rule below: the server is the only gate.
       */
      disabled={unreachable || isPending(key)}
      title={
        unreachable
          ? `Device is ${device.status} — readiness cannot be changed`
          : transitioning
            ? `${label} — ${device.readiness.desired} was requested and has not taken effect`
            : undefined
      }
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void run(key, () => setDeviceReadiness(device.id, target), {
          // Plan 124 §1 goal 1, §4.4 Group F — this control renders on every
          // tile and every card, so its failure toast is one of the most
          // frequently seen device names in the product. A rack of
          // identically-labelled phones makes "Could not sleep moto g06"
          // useless; the number is what makes it actionable.
          failure: `Could not ${label.toLowerCase()} ${formatDeviceName(device.number, device.label)}`,
        })
      }}
    >
      {isPending(key) ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : isAsleep ? (
        <Sun className="size-3.5" aria-hidden />
      ) : (
        <Moon className="size-3.5" aria-hidden />
      )}
      {label}
    </Button>
  )
}
