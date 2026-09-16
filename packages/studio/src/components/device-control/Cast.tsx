'use client'

import { Spinner, StatusDot, Tooltip, TooltipContent, TooltipTrigger, cn } from '@enkaku/ui'
import { LatencyOverlay } from '@/components/video/LatencyOverlay'
import { castStatusOf } from './cast-status'
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
  height,
  latencyOverlay,
  onStartDrag,
}: {
  cast: UseCast
  ratio: number
  /**
   * The window's own height, the one size the operator drags (plan 228 §3.6).
   *
   * `castWidthPx` was called here with no height at all, so it fell back to
   * `DEFAULT_WINDOW_HEIGHT_PX` and the cast surface was capped at the width
   * that suits a 640px window however tall the operator had actually made it.
   * A resized window therefore letterboxed its own picture: the column had
   * the room, and the `maxWidth` would not let the phone grow into it. The
   * window's width already comes from this height through `windowWidthPx`, so
   * passing it keeps the two halves of the same formula in agreement.
   */
  height: number
  latencyOverlay: boolean
  onStartDrag: (e: React.MouseEvent) => void
}) {
  const { stats, focused, canvasRef, canvasProps } = cast
  // One vocabulary for every cast surface in Studio (plan 600 §3.3): this
  // strip, this window's own overlay, and the Screens tile all read the
  // same function, so a phone can never be "Disconnected" in one and
  // "Reconnecting" in the other.
  const status = castStatusOf(stats)
  const live = status.kind === 'live'
  /**
   * The cast surface's width ceiling, and — divided by the ratio — its height
   * ceiling. Both are needed, or the box stops being the device's shape.
   *
   * `maxWidth` alone caps the width while the height stays at the full column,
   * so the moment the cap binds the box is no longer at `ratio` and the canvas
   * letterboxes itself inside it. Capping the height by the same formula keeps
   * the aspect instead: the box shrinks in both axes together.
   */
  const maxWidth = castWidthPx(ratio, height) - 36

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
          {status.label}
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
          /*
            `ratio`, not `stats.width / stats.height` (plan 228 §3.6).

            The two used to disagree, and that disagreement was visible: the
            aspect ratio came from whatever stream was on screen while the
            `maxWidth` beside it came from `ratio`, which the window itself is
            sized from. So while the always-on wall stream stood in for the
            control encoder, the surface was shaped for the stand-in inside a
            column shaped for the device — and the picture moved when the two
            reconciled at the switch. `DeviceControl` owns that decision now
            (see its `ratio`); this reads the one number so the surface, the
            column and the window can never be sized from different answers.
          */
          /*
            A DEFINITE height, so the box is never sized from the picture
            inside it (owner, 2026-09-16: the cast opens small and blurry and
            "suddenly jumps to full size" a second or two later).

            `aspectRatio` with `maxWidth`/`maxHeight` and no definite size of
            its own leaves this box shrink-to-fit, and its only in-flow content
            was the canvas — whose INTRINSIC size is the bitmap the renderer
            last painted (`h264-decoder.ts` sets `canvas.width/height` to the
            frame's own size, and the PNG path in `use-cast.ts` does the same).
            So while the always-on wall encoder stood in for the control one,
            the surface was literally 216x480 CSS pixels, and the switch to the
            720x1600 control stream resized the box under the operator's mouse.
            `DeviceControl` had already frozen the WINDOW's geometry against
            exactly this (its `ratio`); the jump that survived was inside the
            column, one element down.

            With the height definite the geometry is the DEVICE's at every
            moment and the stand-in is simply upscaled into the same box, so
            the only thing the switch changes is sharpness — which is the one
            thing it is for. No transition: a fade would put an animation on
            top of a change of sharpness and make the sharp picture arrive
            later, which is the opposite of the ask.
          */
          style={{ aspectRatio: String(ratio), height: '100%', maxWidth, maxHeight: maxWidth / ratio }}
        >
          {!live && (
            <div
              className="absolute inset-0 opacity-70"
              style={{ backgroundImage: 'repeating-linear-gradient(135deg, var(--muted-2) 0 3px, var(--panel-2) 3px 6px)' }}
            />
          )}
          {/*
            Absolutely positioned, so the canvas can never contribute its
            bitmap size back to the box above — the box decides, the picture
            fills it. `object-contain` stays as the safety net for the frames
            whose ratio does not match `ratio` exactly (scrcpy rounds both
            encoders to multiples of 8): better a hairline of black than a
            stretched phone.
          */}
          <canvas ref={canvasRef} {...canvasProps} className={cn('absolute inset-0 h-full w-full bg-black object-contain outline-none', focused && 'ring-2 ring-accent')} />
          {!live && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5">
              {status.busy && <Spinner className="size-4 text-accent" />}
              <span className={cn('text-label', status.kind === 'unauthorized' ? 'text-warn' : status.busy ? 'text-accent' : 'text-dim')}>
                {status.label}
              </span>
            </div>
          )}
          {latencyOverlay && stats.summary && <LatencyOverlay summary={stats.summary} inputHost={stats.inputHost} />}
        </div>
      </div>
    </div>
  )
}
