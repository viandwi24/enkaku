'use client'

import { cn } from '@enkaku/ui'
import { useCast } from '@/components/device-control/use-cast'

/**
 * The Screens tile (design handoff; MVP 15 §1): a small, read-only cast —
 * no toolbar, no case-button rail, no pointer/keyboard handling. Rewritten
 * by plan 215 step 215.10 onto `useCast`, the same hook Device Control uses,
 * so there is exactly one cast implementation in Studio (plan 215 §3.2 D8).
 * Its only callers are `components/wall/WallTile.tsx` and
 * `components/devices/DeviceScreenCard.tsx`, both already read-only.
 */
export function LiveView({ deviceId, active = true, className }: { deviceId: string; active?: boolean; className?: string }) {
  const { stats, canvasRef } = useCast({ deviceId, quality: 'wall', interactive: false, targets: [deviceId], active })
  const live = stats.streaming && stats.staleSec < 5

  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <canvas ref={canvasRef} tabIndex={-1} aria-label="Device screen" className="h-full w-full object-contain" />
      {!live && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className={cn('text-label', stats.error && stats.error.toLowerCase().includes('unauthor') ? 'text-warn' : 'text-faint-2')}>
            {stats.error && stats.error.toLowerCase().includes('unauthor') ? 'Unauthorized' : 'Disconnected'}
          </span>
        </div>
      )}
    </div>
  )
}
