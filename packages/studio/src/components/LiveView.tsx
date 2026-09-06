'use client'

import { Spinner, cn } from '@enkaku/ui'
import { castStatusOf, isCastLive } from '@/components/device-control/cast-status'
import { useCast } from '@/components/device-control/use-cast'

/**
 * The Screens tile (design handoff; MVP 15 §1): a small, read-only cast —
 * no toolbar, no case-button rail, no pointer/keyboard handling. Rewritten
 * by plan 215 step 215.10 onto `useCast`, the same hook Device Control uses,
 * so there is exactly one cast implementation in Studio (plan 215 §3.2 D8).
 * Its only callers are `components/wall/WallTile.tsx` and
 * `components/devices/DeviceScreenCard.tsx`, both already read-only.
 */
export function LiveView({
  deviceId,
  active = true,
  className,
  overlay = 'auto',
}: {
  deviceId: string
  active?: boolean
  className?: string
  /**
   * `'none'` when the CALLER is already saying something about this device
   * over the same picture (plan 600 §3.4) — the Screens card does that while
   * the farm is rebuilding the session, because "Reconnecting · 2" is a fact
   * about the device that outranks anything this cast knows about its own
   * subscription. Two labels stacked on one 9:19.5 tile is not a design.
   */
  overlay?: 'auto' | 'none'
}) {
  const { stats, canvasRef } = useCast({ deviceId, quality: 'wall', interactive: false, targets: [deviceId], active })
  const status = castStatusOf(stats)

  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <canvas ref={canvasRef} tabIndex={-1} aria-label="Device screen" className="h-full w-full object-contain" />
      {overlay === 'auto' && !isCastLive(stats) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          {status.busy && <Spinner className="size-4 text-accent" />}
          <span className={cn('text-label', status.kind === 'unauthorized' ? 'text-warn' : status.busy ? 'text-accent' : 'text-faint-2')}>
            {status.label}
          </span>
        </div>
      )}
    </div>
  )
}
