'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Circle, Loader2, MoonStar, Power, Square, Sun, Volume2, VolumeOff, VolumeX } from 'lucide-react'
import { decodeVideoFrame, KEYCODES, VIDEO_CODEC, type SessionPhase } from '@enkaku/protocol'
import { createH264Renderer, isWebCodecsSupported, type H264Renderer } from '@/lib/h264-decoder'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/lib/useNow'
import { newId, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/**
 * Keycodes come from the protocol package — the same table scripts use, so a
 * button here and a script step mean exactly the same thing to the device.
 */
const AKEYCODE = KEYCODES

const DRAG_THRESHOLD_PX = 10
const TEXT_DEBOUNCE_MS = 500
/** Below this, a gap is just a static screen; above it, something is wrong. */
const STALE_AFTER_SEC = 5
/** Past this, staying quiet is no longer helpful — offer to wake the device. */
const WAKE_OFFER_AFTER_SEC = 30
/** Auto-recover fires at most once per this window (Plan 17 §4.8). */
const AUTO_RECOVER_COOLDOWN_MS = 60_000
/** A phase running longer than this looks slow, not merely in progress. */
const SLOW_PHASE_AFTER_SEC = 10

/** The static step list shown while a session wakes up (Plan 17 §4.7). No fake percentage — just where we are. */
const PHASE_STEPS: { key: SessionPhase; label: string }[] = [
  { key: 'connecting', label: 'Connecting' },
  { key: 'waking', label: 'Waking' },
  { key: 'starting-video', label: 'Starting video' },
  { key: 'waiting-frame', label: 'Waiting for the first frame' },
]
const PHASE_HEADLINE: Record<SessionPhase, string> = {
  connecting: 'Connecting to the device',
  waking: 'Waking the device',
  'starting-video': 'Starting video',
  'waiting-frame': 'Waiting for the first frame',
  ready: 'Loading the picture',
}

/** adb speaks to developers; turn its output into something actionable. */
function explain(reason: string): string {
  if (/not found/i.test(reason)) return 'adb can no longer see this device. Check the cable or the wireless connection.'
  if (/unauthorized/i.test(reason)) return 'The device has not allowed debugging yet. Accept the USB debugging prompt on its screen.'
  if (/offline/i.test(reason)) return 'The device answered but is not ready. Unplug and replug it, then try again.'
  return reason
}

export function LiveView({
  deviceId,
  inputEnabled = true,
  onActivity,
  autoReconnect = false,
}: {
  deviceId: string
  inputEnabled?: boolean
  /** Called on every input sent — the caller uses it to refresh the lease countdown. */
  onActivity?: () => void
  /** DeviceSettings.autoReconnect — one stream.stop + stream.start cycle when frames go stale (Plan 17 §4.8). */
  autoReconnect?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamIdRef = useRef<number | null>(null)
  const lastSeqRef = useRef(-1)
  const pointerDownRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const textBufferRef = useRef('')
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rendererRef = useRef<H264Renderer | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  /**
   * How long since a frame arrived.
   *
   * scrcpy sends nothing while the screen is off, so the canvas keeps showing
   * whatever it painted last — a picture of a phone that may have gone to sleep
   * minutes ago, with the badge still reading "streaming". Freshness has to be
   * stated, not implied.
   */
  const [staleSec, setStaleSec] = useState(0)
  const lastFrameRef = useRef(0)
  const lastAutoRecoverRef = useRef(0)
  const [retryTick, setRetryTick] = useState(0)
  const [codec, setCodec] = useState<'png' | 'h264'>('png')
  const [transport, setTransport] = useState<'ws' | 'webrtc'>('ws')
  const [degradedReason, setDegradedReason] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [fps, setFps] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  // The wake-up progress panel (Plan 17 §4.7): the phase the core last
  // reported, and whether a real frame has actually been painted yet — the
  // panel goes away on the picture, not on the 'ready' message.
  const [phase, setPhase] = useState<SessionPhase | null>(null)
  const [painted, setPainted] = useState(false)
  const paintedRef = useRef(false)
  const phaseChangedAtRef = useRef(Date.now())
  const now = useNow(1000)

  const markPainted = () => {
    if (paintedRef.current) return
    paintedRef.current = true
    setPainted(true)
  }

  // stream.start on mount, plus automatic resubscribe after a reconnect.
  useEffect(() => {
    let disposed = false
    const frameTimes: number[] = []
    // A fresh mount or a manual/auto retry is a new session from the viewer's
    // side — start the wake-up panel over instead of carrying stale state.
    paintedRef.current = false
    setPainted(false)
    setPhase(null)
    phaseChangedAtRef.current = Date.now()

    async function startStream() {
      try {
        const res = await ws.request({ type: 'stream.start', id: newId(), payload: { deviceId } })
        if (res.type !== 'stream.started' || disposed) return
        streamIdRef.current = res.payload.streamId
        lastSeqRef.current = -1
        setCodec(res.payload.codec)
        if (res.payload.codec === 'h264') {
          if (!isWebCodecsSupported()) {
            setError('This browser does not support WebCodecs — use Chromium for the H.264 stream.')
            return
          }
          const canvas = canvasRef.current
          if (canvas) rendererRef.current = createH264Renderer(canvas, (m) => setError(m))
        }
        if (res.payload.width > 0) setSize({ width: res.payload.width, height: res.payload.height })
        setError(null)
        setStopped(null)
        setStreaming(true)
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err))
      }
    }

    const offStatus = ws.onStatus(setConnected)
    const offReconnect = ws.onReconnected(() => void startStream())
    void startStream()

    const offMsg = ws.on((msg) => {
      if (msg.type === 'stream.meta' && msg.payload.streamId === streamIdRef.current) {
        setSize({ width: msg.payload.width, height: msg.payload.height })
      } else if (msg.type === 'session.progress' && msg.payload.deviceId === deviceId) {
        setPhase(msg.payload.phase)
        phaseChangedAtRef.current = Date.now()
      } else if (msg.type === 'video.webrtc.failed') {
        // The WebRTC path failed → stay on WS, but say why.
        setTransport('ws')
        setDegradedReason(msg.payload.reason)
      } else if (msg.type === 'stream.ended' && msg.payload.deviceId === deviceId) {
        // The session died server-side: stop the fps counter so a stale number
        // cannot masquerade as a live stream.
        streamIdRef.current = null
        setStreaming(false)
        setFps(0)
        setStopped(msg.payload.reason)
      } else if (msg.type === 'error') {
        setError(msg.payload.message)
      }
    })

    const offBinary = ws.onBinary((buf) => {
      let frame
      try {
        frame = decodeVideoFrame(buf)
      } catch {
        return
      }
      if (frame.streamId !== streamIdRef.current) return

      // H.264 (scrcpy): packet order matters, never drop based on seq.
      if (frame.codec === VIDEO_CODEC.H264) {
        const renderer = rendererRef.current
        if (!renderer) return
        // The keyframe flag rides in the header. It used to be inferred from
        // `seq === 0`, which only ever held for the very first packet.
        renderer.decode(frame.data, frame.keyframe, frame.width, frame.height)
        markPainted()
        const now = performance.now()
        lastFrameRef.current = now
        frameTimes.push(now)
        while (frameTimes.length > 0 && now - frameTimes[0]! > 3000) frameTimes.shift()
        setFps(Number((frameTimes.length / 3).toFixed(1)))
        return
      }

      if (frame.seq <= lastSeqRef.current) return // PNG: drop out-of-order frames
      lastSeqRef.current = frame.seq

      const now = performance.now()
      lastFrameRef.current = now
      frameTimes.push(now)
      while (frameTimes.length > 0 && now - frameTimes[0]! > 3000) frameTimes.shift()
      setFps(Number((frameTimes.length / 3).toFixed(1)))

      const canvas = canvasRef.current
      if (!canvas) return
      void createImageBitmap(new Blob([frame.data.slice() as unknown as BlobPart], { type: 'image/png' })).then(
        (bitmap) => {
          if (canvas.width !== frame.width || canvas.height !== frame.height) {
            canvas.width = frame.width
            canvas.height = frame.height
          }
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
          markPainted()
          bitmap.close()
        },
      )
    })

    return () => {
      disposed = true
      offMsg()
      offBinary()
      offStatus()
      offReconnect()
      rendererRef.current?.close()
      rendererRef.current = null
      if (streamIdRef.current !== null) {
        ws.send({ type: 'stream.stop', payload: { streamId: streamIdRef.current } })
        streamIdRef.current = null
      }
    }
  }, [deviceId, retryTick])

  /** Normalised against the element's DISPLAYED size — CSS scaling never leaks to the server. */
  function normalize(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    const p = normalize(e)
    pointerDownRef.current = { ...p, t: Date.now() }
    e.currentTarget.focus()
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    const start = pointerDownRef.current
    pointerDownRef.current = null
    if (!start) return
    const end = normalize(e)
    const rect = e.currentTarget.getBoundingClientRect()
    const distPx = Math.hypot((end.x - start.x) * rect.width, (end.y - start.y) * rect.height)
    if (distPx < DRAG_THRESHOLD_PX) {
      ws.send({ type: 'input.tap', payload: { deviceId, pos: end } })
    } else {
      const durationMs = Math.min(10_000, Math.max(50, Date.now() - start.t))
      ws.send({
        type: 'input.swipe',
        payload: { deviceId, from: { x: start.x, y: start.y }, to: end, durationMs },
      })
    }
    onActivity?.()
  }

  function flushText() {
    const text = textBufferRef.current
    textBufferRef.current = ''
    if (text.length > 0) {
      ws.send({ type: 'input.text', payload: { deviceId, text } })
      onActivity?.()
    }
  }

  // Poll rather than time each frame: at 0 fps there is no frame to hang a
  // timer off, and that is exactly the case worth reporting.
  useEffect(() => {
    const t = setInterval(() => {
      const last = lastFrameRef.current
      const sec = last === 0 ? 0 : Math.round((performance.now() - last) / 1000)
      setStaleSec(sec)
      // Opt-in auto-recover (§4.8): left off, nothing wakes a phone someone
      // deliberately put to sleep. On, one stop+start cycle at most per minute.
      if (autoReconnect && sec >= WAKE_OFFER_AFTER_SEC) {
        const nowMs = Date.now()
        if (nowMs - lastAutoRecoverRef.current >= AUTO_RECOVER_COOLDOWN_MS) {
          lastAutoRecoverRef.current = nowMs
          setRetryTick((n) => n + 1)
        }
      }
    }, 1000)
    return () => clearInterval(t)
  }, [autoReconnect])

  const wakeDevice = () => {
    ws.send({ type: 'input.key', payload: { deviceId, keycode: AKEYCODE.WAKEUP } })
    onActivity?.()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    const key = e.key
    if (key.length === 1 && key >= ' ' && key <= '~') {
      textBufferRef.current += key
      if (textTimerRef.current) clearTimeout(textTimerRef.current)
      textTimerRef.current = setTimeout(flushText, TEXT_DEBOUNCE_MS)
      return
    }
    flushText()
    const keycode =
      key === 'Enter' ? AKEYCODE.ENTER : key === 'Backspace' ? AKEYCODE.DEL : key === 'Escape' ? AKEYCODE.BACK : null
    if (keycode !== null) {
      ws.send({ type: 'input.key', payload: { deviceId, keycode } })
      onActivity?.()
    }
  }

  const sendKey = (keycode: number) => {
    if (!inputEnabled) return
    ws.send({ type: 'input.key', payload: { deviceId, keycode } })
    onActivity?.()
  }

  const nav = [
    { key: AKEYCODE.BACK, icon: ChevronLeft, label: 'Back', hint: 'Back — also sent by Esc' },
    { key: AKEYCODE.HOME, icon: Circle, label: 'Home', hint: 'Home' },
    { key: AKEYCODE.APP_SWITCH, icon: Square, label: 'Recents', hint: 'Recent apps' },
  ]

  /**
   * The buttons a phone has on its case, kept on the case: they sit beside the
   * screen rather than in the toolbar, in the order your thumb finds them.
   */
  const hardware = [
    { key: AKEYCODE.POWER, icon: Power, label: 'Power', hint: 'Power — toggles the screen, same as the side button' },
    { key: AKEYCODE.VOLUME_UP, icon: Volume2, label: 'Volume up', hint: 'Volume up' },
    { key: AKEYCODE.VOLUME_DOWN, icon: VolumeOff, label: 'Volume down', hint: 'Volume down' },
    { key: AKEYCODE.VOLUME_MUTE, icon: VolumeX, label: 'Mute', hint: 'Mute — silences the phone’s own speaker' },
  ]

  /**
   * Wake and Sleep instead of a second Power button: Power toggles, and over a
   * remote link you rarely know which state you are toggling from. These say
   * what they do.
   */
  const power = [
    { key: AKEYCODE.WAKEUP, icon: Sun, label: 'Wake', hint: 'Wake the screen — a session already does this on connect' },
    { key: AKEYCODE.SLEEP, icon: MoonStar, label: 'Sleep', hint: 'Put the screen to sleep' },
  ]

  const keyButton = (b: { key: number; icon: typeof Circle; label: string; hint: string }) => (
    <Tooltip key={b.label}>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-10"
          disabled={!inputEnabled}
          onClick={() => sendKey(b.key)}
          aria-label={b.label}
        >
          <b.icon className="size-4" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{b.hint}</TooltipContent>
    </Tooltip>
  )

  // Shown while the session wakes up: any known phase before a real frame has
  // been painted, not merely before the 'ready' message (§4.7).
  const showWakePanel = phase !== null && !painted
  const phaseElapsedSec = phase ? Math.max(0, Math.round((now - phaseChangedAtRef.current) / 1000)) : 0

  return (
    <div className="overflow-hidden rounded-lg border bg-surface">
      {/* Stream readouts: the numbers that describe the picture being watched. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-[11.5px] text-fg-muted">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'size-1.5 rounded-full',
              !connected ? 'bg-led-danger' : streaming ? 'bg-led-ok' : 'bg-led-off',
            )}
            aria-hidden
          />
          {!connected ? 'disconnected' : streaming ? 'streaming' : 'not streaming'}
        </span>
        {streaming && (
          <>
            {staleSec >= STALE_AFTER_SEC ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help border-b border-dotted border-led-warn text-led-warn">
                      no new frames for {staleSec}s
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    The picture below is the last frame received. scrcpy sends nothing while the device screen is off, so
                    this usually means the phone went to sleep.
                  </TooltipContent>
                </Tooltip>
                {staleSec >= WAKE_OFFER_AFTER_SEC &&
                  (inputEnabled ? (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={wakeDevice}>
                      The device screen looks off. Wake it
                    </Button>
                  ) : (
                    <span className="text-[11px] text-fg-subtle">
                      The device screen looks off — take control to wake it.
                    </span>
                  ))}
              </>
            ) : (
              <span className="readout">{fps} fps</span>
            )}
            <span className="readout">
              {size.width || '?'}×{size.height || '?'}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help border-b border-dotted border-fg-subtle">
                  {codec === 'h264' ? 'H.264' : 'screencap'}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {codec === 'h264'
                  ? 'The scrcpy video is decoded in the browser via WebCodecs — smooth and light on bandwidth.'
                  : 'Fallback mode: repeated screenshots, roughly 2–3 frames per second. Enable scrcpy under Settings for full video.'}
              </TooltipContent>
            </Tooltip>
            <span className="rack-label ml-auto">{transport === 'webrtc' ? 'webrtc' : 'websocket'}</span>
          </>
        )}
      </div>

      {error && (
        <p className="border-b border-led-danger/30 bg-led-danger/5 px-3 py-2 text-[12px] text-led-danger">
          {error}
        </p>
      )}
      {degradedReason && (
        <p className="border-b px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
          The WebRTC path is not in use ({degradedReason}). Video still runs over WebSocket, but it can stutter when
          the network drops packets.
        </p>
      )}

      <div className="relative flex items-start justify-center gap-2 bg-bg p-4">
        {/* Mirrors the button rail so the screen itself stays centred. */}
        <div className="w-10 shrink-0" aria-hidden />
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          aria-label="Device screen"
          className={cn(
            'max-h-[calc(100vh-19rem)] min-h-[18rem] rounded-md bg-black shadow-[0_0_0_1px_var(--color-border)]',
            'outline-none focus-visible:shadow-[0_0_0_2px_var(--color-led-active)]',
            stopped && 'opacity-40',
          )}
          style={{
            ...(size.width > 0 ? { aspectRatio: `${size.width} / ${size.height}` } : { aspectRatio: '9 / 16' }),
            cursor: inputEnabled && !stopped ? 'crosshair' : 'not-allowed',
          }}
        />

        {/* The case buttons, on the case. */}
        <div className="flex w-10 shrink-0 flex-col items-center gap-1 pt-10">{hardware.map(keyButton)}</div>

        {stopped && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[13px] font-medium">Stream stopped</p>
            <p className="max-w-sm text-[12px] leading-relaxed text-fg-muted">{explain(stopped)}</p>
            <Button size="sm" variant="outline" className="mt-1" onClick={() => setRetryTick((n) => n + 1)}>
              Try connecting again
            </Button>
          </div>
        )}

        {/* Wake-up progress (Plan 17 §4.7): what the core is doing, instead of a
            black rectangle, while a sleeping phone comes up. No fake percentage —
            just the static step list with the current one highlighted. */}
        {showWakePanel && !stopped && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg/95 px-6 text-center">
            <Loader2 className="size-5 animate-spin text-fg-muted" aria-hidden />
            <p className="text-[13px] font-medium">
              {PHASE_HEADLINE[phase ?? 'connecting']}…
              {phaseElapsedSec >= SLOW_PHASE_AFTER_SEC && (
                <span className="readout ml-1.5 text-[11px] font-normal text-fg-subtle">{phaseElapsedSec}s</span>
              )}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[11px] text-fg-subtle">
              {PHASE_STEPS.map((s, i) => (
                <span key={s.key} className="flex items-center gap-1.5">
                  <span className={cn(s.key === phase && 'font-medium text-fg')}>{s.label}</span>
                  {i < PHASE_STEPS.length - 1 && <span aria-hidden>→</span>}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Nav buttons below the canvas — the same place as the Android nav bar. */}
      <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2">
        {nav.map(keyButton)}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        {power.map(keyButton)}
        <p className="ml-2 text-[11.5px] text-fg-subtle">
          {inputEnabled
            ? 'Click to tap, drag to swipe, type while the canvas is focused. Esc sends Back.'
            : 'Input is off — watching only.'}
        </p>
      </div>
    </div>
  )
}
