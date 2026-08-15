'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Circle, Loader2, MoonStar, Power, Square, Sun, Volume2, VolumeOff, VolumeX } from 'lucide-react'
import {
  decodeVideoFrame,
  KEYCODES,
  VIDEO_CODEC,
  type MirrorAction,
  type MirrorResult,
  type Quality,
  type SessionPhase,
} from '@enkaku/protocol'
import { createH264Renderer, isWebCodecsSupported, type H264Renderer } from '@/lib/h264-decoder'
import { ClipboardButton } from '@/components/device/ClipboardButton'
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
/**
 * Manual control sends the operator's REAL pointer trace, not a synthesised
 * curve (Plan 40 §4.6) — a human dragging in the browser already produces a
 * natural path. `onPointerMove` fires far faster than is useful to send, so
 * the trace is batched client-side to roughly this interval (the same
 * cadence the gesture engine itself samples at by default) before being sent
 * as one `input.gesture` message on pointer-up.
 */
const MANUAL_GESTURE_SAMPLE_MS = 8
/** Matches `InputGestureMessage`'s schema ceiling — a very long drag simply
 * stops adding new samples past this, rather than growing the payload unbounded. */
const MANUAL_GESTURE_MAX_SAMPLES = 300
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
/**
 * One word per phase, for the compact (Wall tile) panel (Plan 92 §4.7,
 * fixes F16): a 100 px column has room for a spinner and a word, not the
 * four-step breadcrumb the device page draws. Same phases, same order —
 * just named for a column instead of a page.
 */
const PHASE_COMPACT_LABEL: Record<SessionPhase, string> = {
  connecting: 'Connecting',
  waking: 'Waking',
  'starting-video': 'Video',
  'waiting-frame': 'Frame',
  ready: 'Loading',
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
  active = true,
  quality = 'control',
  compact = false,
  mirror,
  configuredDisplay,
}: {
  deviceId: string
  inputEnabled?: boolean
  /** Called on every input sent — the caller uses it to refresh the lease countdown. */
  onActivity?: () => void
  /** DeviceSettings.autoReconnect — one stream.stop + stream.start cycle when frames go stale (Plan 17 §4.8). */
  autoReconnect?: boolean
  /**
   * Whether this view is the one currently visible (Plan 42 §4.1) — the
   * Control tab stays mounted behind a hidden CSS panel now instead of
   * unmounting, so a hidden `<video>` a browser throttled can come back with
   * a stale first frame. On the false→true transition this asks the server
   * for a fresh keyframe (`stream.keyframe`) without restarting the stream.
   * Defaults to true: every pre-plan-42 caller renders exactly one always-visible view.
   */
  active?: boolean
  /** Video quality profile (Plan 42 §3.5, §4.5) — `wall` for a Wall tile, `control` everywhere else. */
  quality?: Quality
  /**
   * A small, read-only Wall tile (Plan 42 §4.6): no toolbar, no case-button
   * rails, no pointer/keyboard handling — just the picture and a status dot.
   * The SAME stream.start/decode path as the full Control view, only less
   * chrome around it.
   */
  compact?: boolean
  /**
   * Fan-out mode (plan 91 §3.8, §3.9, §5 step 91.9) — set only by the focus
   * overlay, and only while its own Mirror toggle is on. When present, every
   * pointer/key/text action this canvas would otherwise send as a
   * single-device `input.*` message is sent instead as ONE `input.mirror`
   * envelope naming `groupId`, exactly per §3.8's "the browser sends one
   * message regardless of member count." `clipboard.set` is deliberately
   * NOT routed here — §3.10 forbids mirroring it structurally, and
   * `pasteFromClipboard` below still calls it directly, unaffected by this
   * prop entirely.
   */
  mirror?: {
    groupId: string
    /** Alt held, or the rail's "Focused only" toggle (§3.9's "Solo") — narrows this ONE action to `deviceId` alone via `soloDeviceId`, without leaving mirror mode. */
    solo: boolean
    /** Every `input.mirror.result` for THIS group, forwarded up so the rail's per-action strip (`18/20`) can render it — this component owns sending, not displaying, the outcome. */
    onResult?: (results: MirrorResult[]) => void
  }
  /**
   * Plan 100 §3.7 item 1, §4.3, step 100.6 (closes G11/96.22) — the
   * CONFIGURED engine (`DeviceDetailInfo.display` from `GET /:id`), so this
   * component can tell a device deliberately set to `screencap-loop` apart
   * from one actually degraded onto it. Undefined (no caller wires it, e.g.
   * a Wall tile working from the fleet list, which does not carry this
   * field) means "unknown" — the badge below stays the neutral pre-100.6
   * wording rather than guessing degraded when it might not be.
   */
  configuredDisplay?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamIdRef = useRef<number | null>(null)
  const lastSeqRef = useRef(-1)
  const pointerDownRef = useRef<{ x: number; y: number; t: number } | null>(null)
  /** The real trace of the current drag (Plan 40 §4.6), normalised 0..1, batched to MANUAL_GESTURE_SAMPLE_MS. */
  const gestureSamplesRef = useRef<{ x: number; y: number; atMs: number }[]>([])
  const lastGestureSampleAtRef = useRef(0)
  const textBufferRef = useRef('')
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** `input.mirror`'s own sequence counter (plan 91 §4.4) — correlates each dispatch to its `input.mirror.result`, since that message carries no envelope `id`. */
  const mirrorSeqRef = useRef(0)
  /**
   * Read inside the persistent `ws.on` subscription below, which is set up
   * once per `[deviceId, retryTick]` (not on every `mirror` prop change) —
   * without this ref the handler would close over a stale `mirror` and keep
   * routing `input.mirror.result` to an old `onResult`/`groupId` after the
   * rail toggled Mirror off and back on. Mirrors `iHoldControlRef`'s own
   * reasoning in `app/device/page.tsx`.
   */
  const mirrorRef = useRef(mirror)
  mirrorRef.current = mirror

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
  /**
   * A named precondition from the text ladder (plan 90 §3.3, §5 step 90.5) — e.g. "this device's
   * input engine can only type ASCII; install the guest agent to type non-ASCII text". Its own
   * state, separate from `error` above: this is plan 59's "a precondition is not a failure",
   * shown inline like `degradedReason` rather than styled as a red error.
   */
  const [textInputNotice, setTextInputNotice] = useState<string | null>(null)
  // The wake-up progress panel (Plan 17 §4.7): the phase the core last
  // reported, and whether a real frame has actually been painted yet — the
  // panel goes away on the picture, not on the 'ready' message.
  const [phase, setPhase] = useState<SessionPhase | null>(null)
  /**
   * `session.progress`'s optional `detail` (plan 92 §3.8 rule 5, §4.5, §5
   * step 92.2 — fixes F17). Before this, `SessionProgressMessage` carried a
   * human-readable reason for a restart and `LiveView` read only `phase`,
   * so a session restarted by a video settings change looked identical to
   * an ordinary reconnect — no way to tell "someone changed a setting" from
   * "the phone glitched". Rendered under the phase headline below.
   */
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null)
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
    setPhaseDetail(null)
    phaseChangedAtRef.current = Date.now()

    async function startStream() {
      try {
        const res = await ws.request({ type: 'stream.start', id: newId(), payload: { deviceId, quality } })
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
        setPhaseDetail(msg.payload.detail ?? null)
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
      } else if (msg.type === 'input.mirror.result' && mirrorRef.current && msg.payload.groupId === mirrorRef.current.groupId) {
        // Unicast, correlated by `seq` rather than the envelope `id`
        // (`InputMirrorResultMessage`'s own doc comment) — this canvas does
        // not track which `seq` is "its own" beyond the groupId match,
        // since every dispatch here belongs to the SAME operator's own
        // mirror session; the rail (`FocusOverlay`) is what actually reads
        // `seq` if it ever needs to.
        mirrorRef.current.onResult?.(msg.payload.results)
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
        let renderer = rendererRef.current
        if (!renderer) {
          // Plan 100 §4.3, step 100.6: a session that opened on the
          // screencap-loop fallback and just recovered to scrcpy sends its
          // first h264 frame with no new `stream.started` — the SAME
          // subscription from open is still live, and `codec`/`rendererRef`
          // were set for 'png' at that time. Build the renderer lazily here
          // instead of silently dropping every h264 frame forever because
          // nothing ever re-created it.
          const canvas = canvasRef.current
          if (!canvas) return
          renderer = createH264Renderer(canvas, (m) => setError(m))
          if (!renderer) return
          rendererRef.current = renderer
          setCodec('h264')
        }
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

  // A hidden `<video>` becoming visible again (Plan 42 §4.1, §4.2 risks): the
  // Control tab stays mounted behind a CSS `hidden` panel now, and browsers
  // may throttle a hidden canvas, so the first frame after unhiding can be
  // stale. Ask for a fresh IDR on the false→true transition only — never on
  // the initial mount, which already gets a keyframe from stream.start itself.
  const wasActiveRef = useRef(active)
  useEffect(() => {
    if (active && !wasActiveRef.current && streamIdRef.current !== null) {
      ws.send({ type: 'stream.keyframe', payload: { streamId: streamIdRef.current } })
    }
    wasActiveRef.current = active
  }, [active])

  /** Normalised against the element's DISPLAYED size — CSS scaling never leaks to the server. */
  function normalize(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }

  /**
   * The one place a tap/swipe/gesture/key leaves this component (plan 91
   * §3.8, §5 step 91.9) — `text` is excluded (it stays request/reply via
   * `flushText`'s own `input.text`/`input.mirror` branch below, since only
   * the single-device path has a ladder result worth showing). While `mirror`
   * is set, this is the ENTIRE difference between driving one phone and
   * driving the whole group: same action, same normalised coordinates
   * (§3.7 — nothing here needs to know about any OTHER device's geometry),
   * just one `input.mirror` envelope instead of one `input.<verb>` message.
   */
  function sendInputAction(action: Exclude<MirrorAction, { verb: 'text' }>) {
    if (mirror) {
      const seq = ++mirrorSeqRef.current
      ws.send({
        type: 'input.mirror',
        payload: { groupId: mirror.groupId, seq, action, ...(mirror.solo ? { soloDeviceId: deviceId } : {}) },
      })
      return
    }
    switch (action.verb) {
      case 'tap':
        // `holdMs` (plan 94 §4.4, closes F4/F5) — the operator's real
        // pointer down→up duration, measured in `onPointerUp` below. A press
        // held past the recorder's own `longPressMs` setting is STILL sent
        // as `input.tap`: there is no separate long-press message, the
        // duration alone is what makes it one (plan 94 §3.4, §4.6).
        ws.send({ type: 'input.tap', payload: { deviceId, pos: action.pos, ...(action.holdMs !== undefined ? { holdMs: action.holdMs } : {}) } })
        return
      case 'swipe':
        ws.send({ type: 'input.swipe', payload: { deviceId, from: action.from, to: action.to, durationMs: action.durationMs } })
        return
      case 'gesture':
        ws.send({ type: 'input.gesture', payload: { deviceId, samples: action.samples } })
        return
      case 'key':
        ws.send({ type: 'input.key', payload: { deviceId, keycode: action.keycode } })
        return
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    const p = normalize(e)
    pointerDownRef.current = { ...p, t: Date.now() }
    gestureSamplesRef.current = [{ x: p.x, y: p.y, atMs: 0 }]
    lastGestureSampleAtRef.current = 0
    e.currentTarget.focus()
  }

  /** Batches the real trace while dragging (Plan 40 §4.6) — see MANUAL_GESTURE_SAMPLE_MS. */
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    const start = pointerDownRef.current
    if (!start) return
    const elapsed = Date.now() - start.t
    if (elapsed - lastGestureSampleAtRef.current < MANUAL_GESTURE_SAMPLE_MS) return
    if (gestureSamplesRef.current.length >= MANUAL_GESTURE_MAX_SAMPLES - 1) return
    const p = normalize(e)
    gestureSamplesRef.current.push({ x: p.x, y: p.y, atMs: elapsed })
    lastGestureSampleAtRef.current = elapsed
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    const start = pointerDownRef.current
    pointerDownRef.current = null
    if (!start) return
    const end = normalize(e)
    const elapsed = Date.now() - start.t
    const rect = e.currentTarget.getBoundingClientRect()
    const distPx = Math.hypot((end.x - start.x) * rect.width, (end.y - start.y) * rect.height)
    if (distPx < DRAG_THRESHOLD_PX) {
      // Pointer down→up, measured here (plan 94 §4.4, closes F4) — the core
      // uses it verbatim rather than sampling its own tapJitterMs range, the
      // same way a script's `tap({ holdMs })` override already can.
      sendInputAction({ verb: 'tap', pos: end, holdMs: elapsed })
    } else {
      // The operator's REAL pointer trace, not a synthesised curve (Plan 40
      // §4.6) — whatever `onPointerMove` batched, plus the exact release
      // point so the trace always ends precisely where the drag did.
      const samples = gestureSamplesRef.current
      const lastSample = samples[samples.length - 1]
      if (!lastSample || lastSample.atMs !== elapsed) samples.push({ x: end.x, y: end.y, atMs: elapsed })
      if (samples.length >= 2) {
        sendInputAction({ verb: 'gesture', samples })
      } else {
        // No intermediate move events were captured (a very fast drag) —
        // fall back to the two-point swipe exactly as before Plan 40.
        const durationMs = Math.min(10_000, Math.max(50, elapsed))
        sendInputAction({ verb: 'swipe', from: { x: start.x, y: start.y }, to: end, durationMs })
      }
    }
    gestureSamplesRef.current = []
    onActivity?.()
  }

  async function flushText() {
    const text = textBufferRef.current
    textBufferRef.current = ''
    if (text.length === 0) return
    onActivity?.()
    if (mirror) {
      // Fire-and-forget through the SAME `input.mirror` envelope every other
      // verb uses here (plan 91 §3.8) — deliberately skips the single-device
      // text ladder's request/reply (`via`, F23's precondition notice):
      // `mirror.dispatch`'s per-member try/catch already reports a per-device
      // outcome on the result strip, which is the honest answer for N
      // devices that may resolve to N different rungs, not one shared notice.
      const seq = ++mirrorSeqRef.current
      ws.send({
        type: 'input.mirror',
        payload: { groupId: mirror.groupId, seq, action: { verb: 'text', text }, ...(mirror.solo ? { soloDeviceId: deviceId } : {}) },
      })
      setTextInputNotice(null)
      return
    }
    try {
      // `input.text` is now request/reply (plan 90 §3.3, §4.5, §5 step 90.5) — `via` names the
      // rung the core actually used (`agent-ime` / `scrcpy-text` / `adb-ascii`), so a resolved
      // rung of `adb-ascii` never means "silently dropped" any more: a refusal comes back as a
      // rejected request instead (caught below), never a keystroke that just vanished.
      await ws.request({ type: 'input.text', id: newId(), payload: { deviceId, text } })
      setTextInputNotice(null)
    } catch (err) {
      // A precondition (plan 59), not necessarily a failure: the resolved rung could not carry
      // this text (e.g. only `adb-input` is available and the string is non-ASCII). Shown inline
      // instead of dropped silently (F23).
      setTextInputNotice(err instanceof Error ? err.message : String(err))
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
    sendInputAction({ verb: 'key', keycode: AKEYCODE.WAKEUP })
    onActivity?.()
  }

  /**
   * Pushes the OPERATOR's browser clipboard onto the device (plan 90 §3.3, §5 step 90.5) — the
   * paste chord (Cmd/Ctrl+V), let through instead of being caught by `onKeyDown`'s
   * modifier-early-return below (F23: "Cmd/Ctrl+V never reaches anything either"). Uses the SAME
   * `clipboard.set(..., { paste: true })` mechanism `ClipboardButton`'s manual popover already
   * calls, not the text ladder — an explicit paste is a deliberate operator choice, not a rung the
   * resolver should pick for them.
   */
  async function pasteFromClipboard(): Promise<void> {
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch (err) {
      setTextInputNotice(`could not read the browser clipboard: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (text.length === 0) return
    try {
      await ws.request({ type: 'clipboard.set', id: newId(), payload: { deviceId, text, paste: true } })
      setTextInputNotice(null)
      onActivity?.()
    } catch (err) {
      setTextInputNotice(err instanceof Error ? err.message : String(err))
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    // The paste chord is the one modifier combo with a real action on a canvas that owns no text
    // selection of its own — it pastes the operator's clipboard onto the device (F23's "modifier
    // chords return early" bug, fixed for this one chord only; every other Cmd/Ctrl/Alt combo
    // still has nothing to do here).
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      void pasteFromClipboard()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    const key = e.key
    // Any single PRINTABLE CODE POINT — not just ASCII (F23: a CJK character or an emoji matched
    // neither branch here and was dropped with no message, no error, no log). `[...key]` iterates
    // by code point, so an astral character (an emoji outside the Basic Multilingual Plane is a
    // UTF-16 SURROGATE PAIR) still counts as one element — `key.length` alone would wrongly
    // reject it, exactly as it wrongly rejected every non-ASCII `key` before this change.
    if ([...key].length === 1) {
      textBufferRef.current += key
      if (textTimerRef.current) clearTimeout(textTimerRef.current)
      textTimerRef.current = setTimeout(flushText, TEXT_DEBOUNCE_MS)
      return
    }
    flushText()
    const keycode =
      key === 'Enter' ? AKEYCODE.ENTER : key === 'Backspace' ? AKEYCODE.DEL : key === 'Escape' ? AKEYCODE.BACK : null
    if (keycode !== null) {
      sendInputAction({ verb: 'key', keycode })
      onActivity?.()
    }
  }

  const sendKey = (keycode: number) => {
    if (!inputEnabled) return
    sendInputAction({ verb: 'key', keycode })
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
    <div className={cn('overflow-hidden rounded-lg border bg-surface', compact && 'h-full')}>
      {/* Stream readouts: the numbers that describe the picture being watched.
          Skipped in compact (Wall tile) mode — a tile has room for a status
          dot, not a toolbar (Plan 42 §4.6). */}
      {!compact && (
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
            {(() => {
              // Plan 100 §3.7 item 1, step 100.6: degraded (configured for
              // scrcpy, actually serving screencap-loop) is a DIFFERENT,
              // more urgent fact than "deliberately configured for
              // screencap-loop" — §3.7's rule is that a degraded state is
              // never worded as an ordinary, expected mode. `configuredDisplay
              // === undefined` (unknown) falls back to the pre-100.6 neutral
              // wording rather than guessing.
              const degraded = codec === 'png' && configuredDisplay === 'scrcpy'
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        'cursor-help border-b border-dotted',
                        degraded ? 'border-led-warn text-led-warn' : 'border-fg-subtle',
                      )}
                    >
                      {codec === 'h264' ? 'H.264' : degraded ? 'Degraded — screencap fallback' : 'screencap'}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {codec === 'h264'
                      ? 'The scrcpy video is decoded in the browser via WebCodecs — smooth and light on bandwidth.'
                      : degraded
                        ? 'scrcpy could not be started for this device, so it is falling back to repeated screenshots (roughly 2–3 fps, heavy on device CPU) while it automatically retries in the background.'
                        : 'Fallback mode: repeated screenshots, roughly 2–3 frames per second. Enable scrcpy under Settings for full video.'}
                  </TooltipContent>
                </Tooltip>
              )
            })()}
            <span className="rack-label ml-auto">{transport === 'webrtc' ? 'webrtc' : 'websocket'}</span>
          </>
        )}
      </div>
      )}

      {!compact && error && (
        <p className="border-b border-led-danger/30 bg-led-danger/5 px-3 py-2 text-[12px] text-led-danger">
          {error}
        </p>
      )}
      {!compact && degradedReason && (
        <p className="border-b px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
          The WebRTC path is not in use ({degradedReason}). Video still runs over WebSocket, but it can stutter when
          the network drops packets.
        </p>
      )}
      {!compact && textInputNotice && (
        <p className="border-b px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">{textInputNotice}</p>
      )}

      <div className={cn('relative flex items-start justify-center gap-2 bg-bg', compact ? 'h-full p-0' : 'p-4')}>
        {/* Mirrors the button rail so the screen itself stays centred — omitted in compact mode, which has no rail. */}
        {!compact && <div className="w-10 shrink-0" aria-hidden />}
        <canvas
          ref={canvasRef}
          tabIndex={compact ? -1 : 0}
          onPointerDown={compact ? undefined : onPointerDown}
          onPointerMove={compact ? undefined : onPointerMove}
          onPointerUp={compact ? undefined : onPointerUp}
          onKeyDown={compact ? undefined : onKeyDown}
          aria-label="Device screen"
          className={cn(
            compact
              ? 'h-full w-full rounded-md bg-black object-contain pointer-events-none'
              // A plain viewport fraction (plan 73 §3.1), not an arithmetic guess at the
              // header/toolbar's own height subtracted from the full viewport — it does not need
              // to know that number, and does not go stale the moment it changes.
              : 'max-h-[70dvh] min-h-[18rem] rounded-md bg-black shadow-[0_0_0_1px_var(--color-border)] outline-none focus-visible:shadow-[0_0_0_2px_var(--color-led-active)]',
            stopped && 'opacity-40',
          )}
          style={{
            ...(size.width > 0 ? { aspectRatio: `${size.width} / ${size.height}` } : { aspectRatio: '9 / 16' }),
            ...(compact ? {} : { cursor: inputEnabled && !stopped ? 'crosshair' : 'not-allowed' }),
          }}
        />

        {/* Plan 100 §3.7 item 1, step 100.6 — compact mode (a Wall tile) has no
            toolbar for the badge above, so this is its own small, honest
            indicator: screencap fallback is never worded as an ordinary
            streaming state. Shown whenever the codec is 'png', regardless of
            whether that is a deliberate per-device configuration or a
            degrade — a Wall tile does not carry the configured engine
            (`DeviceInfo` has no `display` field; only `GET /:id` does), so
            unlike the full Control view's badge this cannot distinguish the
            two and does not claim to. */}
        {compact && streaming && codec === 'png' && (
          <span
            className="absolute right-1 top-1 rounded bg-led-warn/90 px-1 py-0.5 text-[9px] font-medium leading-none text-bg"
            title="Screencap fallback — roughly 2–3 fps"
          >
            fallback
          </span>
        )}

        {/* The case buttons, on the case — omitted in compact mode: a Wall tile is read-only, no controls to place. */}
        {!compact && <div className="flex w-10 shrink-0 flex-col items-center gap-1 pt-10">{hardware.map(keyButton)}</div>}

        {stopped &&
          (compact ? (
            // Compact sizing only (Plan 92 §4.7 row "Error — one tile's
            // stream failed"): the SAME translated reason and retry action,
            // just fitted to a tile instead of the device page.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-center">
              <p className="line-clamp-3 text-[10.5px] leading-snug text-fg-muted">{explain(stopped)}</p>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => setRetryTick((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-[13px] font-medium">Stream stopped</p>
              <p className="max-w-sm text-[12px] leading-relaxed text-fg-muted">{explain(stopped)}</p>
              <Button size="sm" variant="outline" className="mt-1" onClick={() => setRetryTick((n) => n + 1)}>
                Try connecting again
              </Button>
            </div>
          ))}

        {/* Wake-up progress (Plan 17 §4.7): what the core is doing, instead of a
            black rectangle, while a sleeping phone comes up. No fake percentage —
            just the static step list with the current one highlighted.
            Compact (Wall tile, Plan 92 §4.7, fixes F16): the same phase and
            the same slow-phase timer — the two things that answer "is this
            stuck" — as a spinner and one word, not the four-step breadcrumb,
            which is a wall of text at a 100 px column width. */}
        {showWakePanel &&
          !stopped &&
          (compact ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-bg/95 px-2 text-center">
              <Loader2 className="size-3.5 animate-spin text-fg-muted" aria-hidden />
              <p className="text-[11px] font-medium">
                {PHASE_COMPACT_LABEL[phase ?? 'connecting']}
                {phaseElapsedSec >= SLOW_PHASE_AFTER_SEC && (
                  <span className="readout ml-1 text-[10px] font-normal text-fg-subtle">{phaseElapsedSec}s</span>
                )}
              </p>
              {/* plan 92 §3.8 rule 5, fixes F17 — the reason THIS restart is
                  happening, e.g. "applying new video settings". Line-clamped:
                  a tile is narrow and this is explanatory, not load-bearing. */}
              {phaseDetail && <p className="line-clamp-2 text-[9.5px] leading-snug text-fg-subtle">{phaseDetail}</p>}
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg/95 px-6 text-center">
              <Loader2 className="size-5 animate-spin text-fg-muted" aria-hidden />
              <p className="text-[13px] font-medium">
                {PHASE_HEADLINE[phase ?? 'connecting']}…
                {phaseElapsedSec >= SLOW_PHASE_AFTER_SEC && (
                  <span className="readout ml-1.5 text-[11px] font-normal text-fg-subtle">{phaseElapsedSec}s</span>
                )}
              </p>
              {/* plan 92 §3.8 rule 5, fixes F17 — `session.progress.detail`,
                  finally rendered: before this it was parsed and dropped. */}
              {phaseDetail && <p className="max-w-sm text-[11.5px] leading-relaxed text-fg-muted">{phaseDetail}</p>}
              <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[11px] text-fg-subtle">
                {PHASE_STEPS.map((s, i) => (
                  <span key={s.key} className="flex items-center gap-1.5">
                    <span className={cn(s.key === phase && 'font-medium text-fg')}>{s.label}</span>
                    {i < PHASE_STEPS.length - 1 && <span aria-hidden>→</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
      </div>

      {/* Nav buttons below the canvas — the same place as the Android nav bar.
          Omitted in compact mode: a Wall tile is read-only, there is nothing here to press. */}
      {!compact && (
        <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2">
          {nav.map(keyButton)}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          {power.map(keyButton)}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          {/* The clipboard is an action on the device, not a fact about it
              (plan 57 §3.4) — so it belongs with the other things you press,
              not in a panel beside the screen. */}
          <ClipboardButton deviceId={deviceId} canSend={inputEnabled} />
          <p className="ml-2 text-[11.5px] text-fg-subtle">
            {inputEnabled
              ? 'Click to tap, drag to swipe, type while the canvas is focused. Esc sends Back.'
              : 'Input is off — watching only.'}
          </p>
        </div>
      )}
    </div>
  )
}
