'use client'

import { StatusDot, Tooltip, TooltipContent, TooltipTrigger, cn } from '@enkaku/ui'
import { LatencyOverlay } from '@/components/video/LatencyOverlay'
import { castWidthPx } from './geometry'
import type { UseCast } from './use-cast'

/**
 * The cast column (design handoff README.md:255-259, plan 215 §4.8): a 40px
 * stats strip on `bg-panel`, and below it the cast surface at the device's
 * exact aspect ratio. No instructional caption anywhere under the cast.
 */
export function Cast({
  cast,
  ratio,
  latencyOverlay,
  onStartDrag,
}: {
  cast: UseCast
  ratio: number
  latencyOverlay: boolean
  onStartDrag: (e: React.MouseEvent) => void
}) {
  const { stats, focused, canvasRef, canvasProps } = cast
  const live = stats.streaming && stats.staleSec < 5

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-muted">
      <div
        className="flex h-10 shrink-0 cursor-grab items-center gap-3 border-b border-line bg-panel px-3 text-meta text-dim [&>*]:shrink-0 [&>*]:whitespace-nowrap"
        onMouseDown={onStartDrag}
        data-drag-handle="1"
        title="Drag to move. Double-click another device to switch this window to it."
      >
        <span className="pointer-events-none flex items-center gap-1.5">
          <StatusDot state={live ? 'free' : 'offline'} className="size-2" />
          {live ? 'Streaming' : stats.staleSec >= 5 ? `No frames for ${stats.staleSec}s` : 'Not streaming'}
        </span>
        <span className="pointer-events-none">{stats.fps.toFixed(1)} fps</span>
        <span className="pointer-events-none font-mono">{stats.width && stats.height ? `${stats.width}x${stats.height}` : '–'}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help border-b border-dotted border-line-2">
              {stats.codec === 'png' ? 'screencap' : stats.substitute || stats.encoderUnavailable ? 'H.264 · wall' : 'H.264'}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {stats.encoderUnavailable
              ? 'This device cannot run a second encoder, so Device Control shows the Screens stream.'
              : stats.substitute
                ? 'A sharper picture is starting. This is the Screens stream meanwhile.'
                : 'The scrcpy video, decoded in the browser via WebCodecs.'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-auto cursor-help border-b border-dotted border-line-2">{stats.latencyMs === null ? '–' : `${Math.round(stats.latencyMs)} ms`}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            device→host and host→browser are relative to the fastest frame seen, not absolute. Glass-to-glass needs a camera.
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
        <div
          className="relative overflow-hidden rounded-window border border-border-2 shadow-cast"
          style={{ aspectRatio: `${stats.width || 9} / ${stats.height || 19.5}`, maxWidth: castWidthPx(ratio) - 36, maxHeight: '100%' }}
        >
          {!live && (
            <div
              className="absolute inset-0 opacity-70"
              style={{ backgroundImage: 'repeating-linear-gradient(135deg, var(--muted-2) 0 3px, var(--panel-2) 3px 6px)' }}
            />
          )}
          <canvas ref={canvasRef} {...canvasProps} className={cn('h-full w-full bg-black object-contain outline-none', focused && 'ring-2 ring-accent')} />
          {!live && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="text-label text-dim">Disconnected</span>
            </div>
          )}
          {latencyOverlay && stats.summary && <LatencyOverlay summary={stats.summary} inputHost={stats.inputHost} />}
        </div>
      </div>
    </div>
  )
}
