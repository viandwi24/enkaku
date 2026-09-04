'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Circle, Loader2, MoonStar, Power, Square, Sun, Volume2, VolumeOff, VolumeX } from 'lucide-react'
import {
  createLatencyEstimator,
  decodeVideoFrame,
  KEYCODES,
  VIDEO_CODEC,
  type InputAction,
  type LatencySummary,
  type Quality,
  type SessionPhase,
} from '@enkaku/protocol'
import { createH264Renderer, isWebCodecsSupported, type H264Renderer } from '@/lib/h264-decoder'
import { LatencyOverlay } from '@/components/video/LatencyOverlay'
import { ClipboardButton } from '@/components/device/ClipboardButton'
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn, duration } from '@enkaku/ui'
import { readLocalPrefs, writeLocalPrefs } from '@/lib/prefs'
import { useNow } from '@/lib/useNow'
import { newId, ws } from '@/lib/ws'

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
/**
 * A floor on the `fitContainer` panel's computed width (plan 103 step
 * 103.9) — guards against a feedback loop, not a design choice about how
 * narrow a phone panel should look: at a very short popup height, a narrow
 * device's ratio-derived width can be small enough that the status/footer
 * rows (both `flex-wrap`) wrap onto an extra line, which shrinks the video
 * area's own remaining height, which shrinks the computed width further
 * still. This floor breaks that spiral rather than chasing it with more
 * measurement.
 */
const MIN_FIT_CONTAINER_WIDTH_PX = 240

/**
 * **Click → first paint (plan 125 §4.7, §5 step 125.11) — and what it is NOT.**
 *
 * This measures the BROWSER half of opening a device: the moment the operator
 * clicked (a Wall tile's double-click, or the device popup opening any other
 * way) to the moment this component painted its first real video frame
 * (`markPainted` below). Nothing else in the product measured that half at
 * all — `scripts/bench-device-nfrs.ts`'s own header says a real number
 * *"needs a browser-driving harness (Studio e2e, Playwright + WebCodecs),
 * which does not exist in this repo."* The SERVER half already has its own
 * instrumentation (`logSlowCommand`'s `ws command stream.start took Xms`,
 * `packages/core/src/server/ws-handlers.ts`, and `transport.controlReplyMsP95`
 * on `/api/adb/stats`), so this closes the one leg nobody could see.
 *
 * **It is not glass-to-glass.** Spec §16's < 150 ms NFR is measured from a
 * change on the phone's own panel to that change appearing on the operator's
 * monitor, which needs a camera pointed at both and an on-device stopwatch —
 * `docs/plans/08-m6-scrcpy.md:540-548` has the real procedure. Plan 125 §2
 * puts that measurement explicitly out of scope. So neither the readout below
 * nor the developer-tools log line may ever be worded as glass-to-glass, and neither is:
 * both say "click→paint" and the tooltip says what it excludes.
 *
 * The mark is a module-level map rather than a prop because the click and the
 * mount are in different components, with `<Wall>`/`app/page.tsx` in between
 * (a `WallTile` double-click sets `?focus=`, which is what mounts
 * `DevicePopup`, which is what renders this) — threading a timestamp through
 * two intermediate components that have no other use for it would be worse
 * for every reader of those files than one keyed handoff here.
 */
const clickIntentMarks = new Map<string, number>()
/**
 * Past this, a mark is stale and is discarded rather than reported. It exists
 * because a mark can survive its click without ever being consumed — a popup
 * closed before the first frame arrives hands its mark back (see the stream
 * effect's cleanup) so a React StrictMode double-mount still measures, and
 * without an upper bound that returned mark could later be picked up by an
 * unrelated mount for the same device and reported as a real, wildly inflated
 * reading. A wrong number is worse than no number for something whose whole
 * purpose is measurement.
 */
const CLICK_INTENT_TTL_MS = 30_000

/**
 * Record "the operator asked for this device's picture, now" (plan 125 §4.7).
 * Called by `wall/WallTile.tsx`'s double-click and by `device-popup/
 * DevicePopup.tsx` when it opens; the next `LiveView` that mounts for
 * `deviceId` consumes it exactly once.
 *
 * `onlyIfAbsent` is what keeps the two call sites from fighting: the popup
 * marks its own open, but when the popup was opened BY a tile double-click
 * that tile already recorded the earlier — and more truthful — timestamp, and
 * overwriting it would silently subtract the whole popup-mount leg from every
 * wall-originated measurement.
 */
export function markLiveViewIntent(deviceId: string, opts?: { onlyIfAbsent?: boolean }): void {
  if (opts?.onlyIfAbsent && clickIntentMarks.has(deviceId)) return
  clickIntentMarks.set(deviceId, performance.now())
}

/** Consumes the pending mark for `deviceId`, or `null` when there is none / it is stale. */
function takeClickIntentMark(deviceId: string): number | null {
  const at = clickIntentMarks.get(deviceId)
  if (at === undefined) return null
  clickIntentMarks.delete(deviceId)
  return performance.now() - at > CLICK_INTENT_TTL_MS ? null : at
}

/** Milliseconds under a second, one decimal of a second above it — a cold cast is seconds, a warm one is not. */
function formatClickToPaint(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

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
  rail = true,
  fitContainer = false,
  configuredDisplay,
  provisioning,
}: {
  deviceId: string
  inputEnabled?: boolean
  /** Called on every input sent — the caller refreshes its own idle clock. */
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
   * Suppresses this view's OWN case-button rail, bottom nav/power row, AND
   * clipboard button (plan 103 §4.1, §5 step 103.2, extended by the layout
   * restructure step) — the status line, the canvas (full pointer/keyboard
   * input), the wake panel and the hint line are all unaffected. `false`
   * only from the device popup's own screen panel, which renders
   * `HardwareRail` as its own independent left-hand panel per §4.1's
   * composition — `HardwareRail` draws Back/Home/Recents/Sleep/Wake AND the
   * clipboard button itself, so none of them may also be drawn a second
   * time inside this component (the "appears exactly once" rule). Every
   * other caller (the device page, the Wall's compact tiles) leaves this at
   * its default and is pixel-identical to before this prop existed.
   */
  rail?: boolean
  /**
   * Fits the canvas to whatever box its PARENT gives it, in both axes,
   * preserving the device's aspect ratio via `object-contain` letterboxing
   * — the same sizing mechanism `compact` (a Wall tile) already uses for
   * exactly this reason, reused here rather than inventing a second one
   * (plan 103's layout restructure, owner-specified: "the casting panel is
   * responsive in both axes … it is the panel that gives way when the
   * popup is resized"). `false` (default): the canvas sizes itself against
   * the VIEWPORT (`max-h-[70dvh]`, a `min-h-[18rem]` floor) — correct for
   * the device page, which has a whole scrollable page to grow into, but
   * wrong for a fixed, user-resizable popup panel, which has no viewport
   * relationship to size against at all. Deliberately independent of
   * `compact`: `compact` ALSO strips the toolbar, the footer, and all
   * pointer/keyboard handling (a read-only Wall tile) — this prop changes
   * only how the canvas is SIZED, so the device popup keeps its status
   * line, its footer hint, and full interactivity while still shrinking
   * and growing to fit its own panel. Every other caller leaves this at its
   * default and is pixel-identical to before this prop existed.
   */
  fitContainer?: boolean
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
  /**
   * Plan 106 §5 step 106.7 — the owner's own ask: *"bisa ngga kalau
   * preparation lagi diinstall itu ada loadingnya di screen castingnya?"*
   * Set ONLY by `DevicePopup.tsx`'s screen panel, never by a Wall tile or
   * `DeviceCard` — a per-tile version would be exactly the per-device
   * fan-out `docs/design.md`'s "nothing that scales with device count" rule
   * forbids, and this component has no way to enforce that itself beyond
   * the fact that no other caller passes it. `null`/`undefined` means "no
   * component on this device is currently installing" — the overlay below
   * renders nothing in that case. This is DELIBERATELY NON-BLOCKING (plan
   * 106 §2: preparation is a readiness signal, never a gate) — unlike
   * `showWakePanel` below, it never covers the picture opaquely, never
   * disables the canvas, and is `pointer-events-none` throughout, so an
   * operator watching the phone for exactly this reason keeps watching it.
   */
  provisioning?: { componentId: string; label: string; startedAt: number } | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** `fitContainer` only (plan 103 step 103.9) — this component's own outer
   * element, so the sizing effect below can set an explicit pixel width on
   * it directly, and its own video-area row, so that effect can measure the
   * height actually available to the picture. */
  const rootRef = useRef<HTMLDivElement>(null)
  const videoAreaRef = useRef<HTMLDivElement>(null)
  const streamIdRef = useRef<number | null>(null)
  const lastSeqRef = useRef(-1)
  const pointerDownRef = useRef<{ x: number; y: number; t: number } | null>(null)
  /** The real trace of the current drag (Plan 40 §4.6), normalised 0..1, batched to MANUAL_GESTURE_SAMPLE_MS. */
  const gestureSamplesRef = useRef<{ x: number; y: number; atMs: number }[]>([])
  const lastGestureSampleAtRef = useRef(0)
  const textBufferRef = useRef('')
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rendererRef = useRef<H264Renderer | null>(null)
  /**
   * Plan 203 §4.11 — the latency overlay's own state. `estimatorRef` is a
   * single long-lived estimator per mounted view (reset on a fresh
   * `stream.started`, never recreated), `latencySummary` is the 500ms-tick
   * snapshot the overlay renders, and `lastPtsSeqRef` tracks the `seq` of
   * the last device-clocked frame so a gap in it can be reported as dropped
   * frames.
   */
  const [latencyOverlay, setLatencyOverlay] = useState(() => readLocalPrefs().latencyOverlay)
  const estimatorRef = useRef(createLatencyEstimator())
  const [latencySummary, setLatencySummary] = useState<LatencySummary | null>(null)
  const lastPtsSeqRef = useRef<number | null>(null)
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
  /**
   * Plan 100 §3.2, §3.7 item 2, §4.4, §5 step 100.5 — set when a `control`
   * request's dedicated second scrcpy session could not be built and the
   * server substituted the device's already-open `wall` entry instead
   * (`stream.started.degradedReason`/`degradedDetail`,
   * `packages/protocol/src/messages/stream.ts`). Rendered with §4.4's exact
   * wording and a Retry action — never silently shown under the ordinary
   * Control label (§3.7's "two tiers, no silent fallback" rule). Holds the
   * reason text; null when not in this state.
   */
  const [controlUnavailable, setControlUnavailable] = useState<string | null>(null)
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
  /** `fitContainer` only (plan 103 step 103.9) — the panel's own computed
   * width, in pixels, or `null` before the first measurement. See the
   * sizing effect below for how it is derived. */
  const [idealWidthPx, setIdealWidthPx] = useState<number | null>(null)

  /**
   * The click that asked for this picture, claimed once per stream attempt by
   * the effect below (plan 125 §4.7, step 125.11). `null` means "nobody
   * clicked for this mount" — a Wall tile that came up on its own as the live
   * set grew, or a retry — and in that case nothing is reported at all rather
   * than a number measured from an arbitrary moment.
   */
  const clickIntentRef = useRef<number | null>(null)
  const [clickToPaintMs, setClickToPaintMs] = useState<number | null>(null)

  const markPainted = () => {
    if (paintedRef.current) return
    paintedRef.current = true
    setPainted(true)
    // Plan 125 §4.7, step 125.11 — the browser half of the cold cast path,
    // closed here because this is the single line in Studio that knows a real
    // frame reached the screen. Read the module header above for what this
    // number is and, more importantly, what it is not: it is click→first
    // paint in this browser, never glass-to-glass.
    const startedAt = clickIntentRef.current
    if (startedAt === null) return
    clickIntentRef.current = null
    const ms = Math.round(performance.now() - startedAt)
    setClickToPaintMs(ms)
    // Logged as well as rendered, because the readout below lives in a status
    // line the operator is not looking at while a device opens, and plan 125
    // criterion 14 asks for a number the owner can read off a real farm.
    console.info(`[enkaku] click→first paint ${ms} ms — ${deviceId} (${quality}); browser half only, not glass-to-glass`)
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
    // A fresh attempt starts with a clean slate on the fast-path banner too
    // — carrying a stale one across a retry would say "still unavailable"
    // before the new `stream.start` has even answered.
    setControlUnavailable(null)
    // Plan 125 §4.7, step 125.11 — claim the click that asked for this
    // picture, if there was one. A RETRY finds nothing here (the mark was
    // consumed by the first attempt) and so reports no number, which is
    // correct: the operator clicked once, and timing the second attempt from
    // that first click would report a figure nobody experienced. The previous
    // attempt's reading is cleared for the same reason.
    clickIntentRef.current = takeClickIntentMark(deviceId)
    setClickToPaintMs(null)

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
          if (canvas) rendererRef.current = createH264Renderer(canvas, (m) => setError(m), (e) => estimatorRef.current.push(e))
        }
        if (res.payload.width > 0) setSize({ width: res.payload.width, height: res.payload.height })
        // Plan 203 §4.11 — a fresh stream means a fresh device/browser clock
        // relationship; forget both offsets and every window rather than
        // mixing this stream's samples with the previous one's.
        estimatorRef.current.reset()
        lastPtsSeqRef.current = null
        // Plan 100 §3.2, §3.7 item 2, §4.4 — a `control` request that got the
        // wall entry's own frames instead, honestly labelled. `''` (not
        // `null`) when the server sent no `degradedDetail`, so the banner
        // below can tell "not degraded" from "degraded, no detail given".
        setControlUnavailable(res.payload.degradedReason === 'control_session_unavailable' ? (res.payload.degradedDetail ?? '') : null)
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
      // Plan 203 §4.11 — read as early as possible, so it reflects the
      // moment the WS message reached this browser, not the moment it was
      // finally processed.
      const browserReceivedAt = Date.now()
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
          renderer = createH264Renderer(canvas, (m) => setError(m), (e) => estimatorRef.current.push(e))
          if (!renderer) return
          rendererRef.current = renderer
          setCodec('h264')
        }
        // Plan 203 §4.11 — a gap in `seq` between two device-clocked frames
        // (`ptsUs > 0n`) is a frame that never reached this browser. Primer
        // frames (`ptsUs === 0n`, the join priming) never touch this chain:
        // they carry no device clock and are not part of the encoder's own
        // sequence.
        if (frame.ptsUs > BigInt(0)) {
          const last = lastPtsSeqRef.current
          if (last !== null && frame.seq > last + 1) estimatorRef.current.noteSeqGap(frame.seq - last - 1)
          lastPtsSeqRef.current = frame.seq
        }
        // The keyframe flag rides in the header. It used to be inferred from
        // `seq === 0`, which only ever held for the very first packet.
        renderer.decode(frame.data, frame.keyframe, frame.width, frame.height, {
          ptsUs: frame.ptsUs,
          hostReceivedAt: frame.hostReceivedAt,
          browserReceivedAt,
        })
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
      // Plan 125 §4.7, step 125.11 — an unconsumed mark goes back where it
      // came from. This mount never painted, so the click it belongs to has
      // still not been answered: React StrictMode's development
      // mount-unmount-remount (`reactStrictMode: true` in `next.config.ts`)
      // would otherwise swallow every measurement taken in `bun run
      // dev:studio`, which is exactly where they will be read. `CLICK_INTENT_TTL_MS`
      // bounds what a genuinely abandoned mark can later be reported as.
      if (clickIntentRef.current !== null) {
        clickIntentMarks.set(deviceId, clickIntentRef.current)
        clickIntentRef.current = null
      }
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
      estimatorRef.current.noteKeyframeRequest()
      ws.send({ type: 'stream.keyframe', payload: { streamId: streamIdRef.current } })
    }
    wasActiveRef.current = active
  }, [active])

  // Plan 203 §4.11 — the overlay's own 500ms tick, running only while it is
  // actually visible: off by default (`latencyOverlay` defaults to false),
  // and never in `compact` (a Wall tile never renders it, see the toggle and
  // the render below). Same start/stop discipline `useNow.ts` documents.
  useEffect(() => {
    if (!latencyOverlay || !streaming || compact) return
    const id = setInterval(() => setLatencySummary(estimatorRef.current.summary(performance.now())), 500)
    return () => clearInterval(id)
  }, [latencyOverlay, streaming, compact])

  /**
   * Plan 103 step 103.9 — the `fitContainer` panel takes the PICTURE's own
   * aspect ratio instead of whatever leftover width `flex-1` used to hand
   * it (owner-reported, with a before/after screenshot: a 736x1600 phone
   * inside a `flex-1` centre panel left wide black bars on both sides,
   * because the panel's WIDTH was authoritative and the canvas merely
   * `object-contain`ed inside it). This effect inverts that: the picture's
   * own aspect ratio and the height this panel is actually given decide its
   * WIDTH, computed here and applied as an explicit pixel style on this
   * component's own root below. `DevicePopup.tsx`'s centre wrapper and outer
   * container both dropped their own `flex-1` for exactly this reason — with
   * nothing forcing this panel wider, the popup's total width becomes
   * rail + this panel's own width + the actions panel, the same way a phone
   * emulator window behaves.
   *
   * **The aspect ratio comes from the live stream, never a stored column**
   * (§9's own requirement): `ratio` below is `size.width / size.height` —
   * the SAME `size` state `stream.started`/`stream.meta` already maintain
   * for the canvas's own `aspectRatio` style — never `DeviceDetailInfo`'s
   * `screenW`/`screenH`, which goes stale on rotation. Because it is the
   * identical state, **a rotation re-derives this within the same render as
   * the picture itself**, not a follow-up one: `stream.meta` fires whenever
   * the reported width/height changes (`ws-handlers.ts`), which is exactly
   * what a rotation does.
   *
   * **Measured, not hardcoded**: `videoArea` (the row holding the canvas,
   * `p-4` padded) and `canvas` (unpadded) are measured via
   * `getBoundingClientRect` at the same instant, so `videoArea.width -
   * canvas.width` IS this component's own padding, whatever it is today or
   * becomes later — no Tailwind spacing value is duplicated here. Likewise
   * `root.width - videoArea.width` is this component's own border. Neither
   * quantity depends on WIDTH (padding/border are fixed regardless of the
   * box they are on), so they stay correct across every later recompute,
   * including the ones this effect's own width changes trigger.
   *
   * A `ResizeObserver` on `videoArea` (rather than polling, or trusting only
   * the `size`-change dependency) is what makes this react to the operator
   * resizing the popup's HEIGHT (the native CSS `resize` handle mutates the
   * DOM directly — React never sees it) — the one input this effect cannot
   * discover any other way.
   */
  useEffect(() => {
    if (!fitContainer || compact) return
    const videoArea = videoAreaRef.current
    if (!videoArea) return

    function recompute() {
      const root = rootRef.current
      const canvas = canvasRef.current
      if (!root || !videoArea || !canvas) return
      const rootRect = root.getBoundingClientRect()
      const videoAreaRect = videoArea.getBoundingClientRect()
      const canvasRect = canvas.getBoundingClientRect()
      if (videoAreaRect.height <= 0) return
      const borderPx = Math.max(0, rootRect.width - videoAreaRect.width)
      const paddingPx = Math.max(0, videoAreaRect.width - canvasRect.width)
      const canvasHeight = Math.max(0, videoAreaRect.height - paddingPx)
      const ratio = size.width > 0 ? size.width / size.height : 9 / 16
      const next = Math.max(MIN_FIT_CONTAINER_WIDTH_PX, Math.round(canvasHeight * ratio + paddingPx + borderPx))
      setIdealWidthPx((prev) => (prev !== null && Math.abs(prev - next) < 1 ? prev : next))
    }

    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(videoArea)
    return () => observer.disconnect()
  }, [fitContainer, compact, size.width, size.height])

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
   * §3.8, §5 step 91.9; plan 205 §4.11 — fan-out mode was deleted along with
   * the rest of MVP 04's replaced subsystem, so this now only ever sends the
   * single-device path) — `text` is excluded (it stays request/reply via
   * `flushText`'s own `input.text` branch below, since only the single-device
   * path has a ladder result worth showing).
   */
  function sendInputAction(action: Exclude<InputAction, { verb: 'text' }>) {
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
    <div
      ref={rootRef}
      // Plan 103 step 103.9 — purely a hook for `LiveView.test.tsx` to find
      // this element and its video-area sibling without a fragile selector;
      // no production code reads either attribute.
      data-testid="live-view-root"
      className={cn(
        'overflow-hidden rounded-lg border bg-surface',
        compact && 'h-full',
        // `fitContainer` (never combined with `compact`, see that prop's own
        // doc comment): this wrapper becomes a flex COLUMN that (a) fills
        // whatever HEIGHT its own parent gives it (`flex-1 min-h-0` — the
        // device popup's centre panel is a plain `flex flex-col`, so this
        // is still the child that grows to fill it vertically) and (b) lays
        // out its own status line / video area / footer rows as fixed-height
        // siblings around the one row that is allowed to shrink (the video
        // area, below). Its WIDTH, unlike its height, is no longer handed
        // down by a `flex-1` in the parent's own main axis — the sizing
        // effect above sets an explicit pixel `width` below instead (plan
        // 103 step 103.9), and `flex-1` here stays purely a HEIGHT
        // instruction once that inline style is present (an explicit width
        // always wins over a flex-basis's own width contribution).
        fitContainer && !compact && 'flex flex-1 min-h-0 flex-col',
      )}
      // `maxWidth: '100%'` turns that explicit pixel width into a CEILING
      // rather than a floor (owner-reported 2026-08-17: a phone lying flat
      // streams 1600×720, this effect resolves ~1350 px from that ratio, and
      // the popup's rail + picture + actions then came to ~1720 px — the
      // actions panel was cut off by the viewport). The width above is what
      // the picture WANTS; this is what the space actually allows, and
      // `object-contain` on the canvas keeps the aspect ratio when the two
      // disagree. `DevicePopup.tsx`'s centre wrapper is `flex-1 min-w-0` for
      // the same reason — a cap does nothing unless something may give.
      style={fitContainer && !compact && idealWidthPx !== null ? { width: idealWidthPx, maxWidth: '100%' } : undefined}
    >
      {/* Stream readouts: the numbers that describe the picture being watched.
          Skipped in compact (Wall tile) mode — a tile has room for a status
          dot, not a toolbar (Plan 42 §4.6). `shrink-0`: harmless outside a
          flex-column parent, and load-bearing inside one (`fitContainer`) —
          this row must never be the one that shrinks. */}
      {!compact && (
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-[11.5px] text-fg-muted">
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
          </>
        )}
        {/* Click → first paint (plan 125 §4.7, §5 step 125.11).
            **Why it is here and not in the wake panel below**, which is what
            §4.7 calls "the existing `session.progress` readout": that panel's
            own visibility condition is `phase !== null && !painted`, so it is
            gone at the exact instant this number comes into existence — a
            reading rendered there could never be seen. This status line is the
            same readout family (fps, resolution, codec: the numbers that
            describe the picture being watched), it is the one surface that
            outlives the first frame, and it is where an operator already looks
            for how this stream is doing.
            Shown only when a click actually started this view, so a Wall tile
            that came up on its own never invents one. */}
        {clickToPaintMs !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help border-b border-dotted border-fg-subtle">
                click→paint <span className="readout">{formatClickToPaint(clickToPaintMs)}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              From your click to the first frame painted in this browser. This is the browser half only — it does not
              include the phone&rsquo;s own display, so it is not a glass-to-glass figure. Measuring that needs a camera
              pointed at the device and an on-device stopwatch.
            </TooltipContent>
          </Tooltip>
        )}
        {/* Plan 203 §4.11 — the latency overlay's own toggle. H.264 only:
            the estimator needs a device PTS, which PNG frames never carry.
            Always carries `ml-auto`: the badge that used to compete for the
            auto-margin push was the webrtc one, and plan 201 deleted it. */}
        {codec === 'h264' && (
          <button
            type="button"
            className="rack-label cursor-pointer ml-auto"
            aria-pressed={latencyOverlay}
            onClick={() => {
              const next = !latencyOverlay
              setLatencyOverlay(next)
              writeLocalPrefs({ latencyOverlay: next })
            }}
          >
            latency
          </button>
        )}
      </div>
      )}

      {!compact && error && (
        <p className="shrink-0 border-b border-led-danger/30 bg-led-danger/5 px-3 py-2 text-[12px] text-led-danger">
          {error}
        </p>
      )}
      {/* Plan 100 §3.2, §3.7 item 2, §4.4, §5 step 100.5 — a `control`
          request whose OWN dedicated second scrcpy session could not be
          built; this viewer is showing the wall entry's own frames instead.
          Never worded as ordinary Control (§3.7's "two tiers, no silent
          fallback"); this is about video QUALITY. */}
      {!compact && controlUnavailable !== null && (
        <p className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-led-warn/30 bg-led-warn/5 px-3 py-2 text-[11.5px] leading-relaxed text-led-warn">
          <span>
            A dedicated full-quality view could not be started for this device
            {controlUnavailable ? ` (${controlUnavailable})` : ''}. Showing the wall&rsquo;s own picture instead —
            lower resolution, lower frame rate.
          </span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10.5px]" onClick={() => setRetryTick((n) => n + 1)}>
            Retry
          </Button>
        </p>
      )}
      {!compact && textInputNotice && (
        <p className="shrink-0 border-b px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">{textInputNotice}</p>
      )}

      {/* The video area — the ONE row `fitContainer` allows to shrink
          (`min-h-0 flex-1`, replacing the default `items-start` with
          `items-center` so the letterboxed picture centres in whatever
          space is left, rather than pinning to the top). Never scrolls
          either way: `overflow` is never set here, and the canvas itself
          shrinks via `object-contain` instead of clipping. */}
      <div
        ref={videoAreaRef}
        data-testid="live-view-video-area"
        className={cn(
          'relative flex justify-center gap-2 bg-bg',
          compact ? 'h-full items-start p-0' : fitContainer ? 'min-h-0 flex-1 items-center p-4' : 'items-start p-4',
        )}
      >
        {/* A symmetric spacer matching the button rail's own width, so the screen itself stays centred — omitted in compact mode and whenever `rail` is suppressed, since there is then nothing to balance against. */}
        {!compact && rail && <div className="w-10 shrink-0" aria-hidden />}
        <canvas
          ref={canvasRef}
          tabIndex={compact ? -1 : 0}
          onPointerDown={compact ? undefined : onPointerDown}
          onPointerMove={compact ? undefined : onPointerMove}
          onPointerUp={compact ? undefined : onPointerUp}
          onKeyDown={compact ? undefined : onKeyDown}
          aria-label="Device screen"
          className={cn(
            compact || fitContainer
              ? // Fits whatever box the flex parent above gives it, in both
                // axes, preserving the device's aspect ratio via
                // `object-contain` letterboxing rather than a CSS
                // `aspect-ratio` box (which only affects a dimension left
                // `auto` — both are pinned to 100% here, so it is
                // `object-contain`, not `aspect-ratio`, doing the work).
                'h-full max-h-full w-full max-w-full rounded-md bg-black object-contain'
              : // A plain viewport fraction (plan 73 §3.1), not an arithmetic guess at the
                // header/toolbar's own height subtracted from the full viewport — it does not need
                // to know that number, and does not go stale the moment it changes. Only reachable
                // when neither `compact` nor `fitContainer` is set (the device page).
                'max-h-[70dvh] min-h-[18rem] rounded-md bg-black',
            compact
              ? 'pointer-events-none'
              : 'shadow-[0_0_0_1px_var(--color-border)] outline-none focus-visible:shadow-[0_0_0_2px_var(--color-led-active)]',
            stopped && 'opacity-40',
          )}
          style={{
            ...(size.width > 0 ? { aspectRatio: `${size.width} / ${size.height}` } : { aspectRatio: '9 / 16' }),
            ...(compact ? {} : { cursor: inputEnabled && !stopped ? 'crosshair' : 'not-allowed' }),
          }}
        />

        {/* Plan 203 §4.11 — the latency instrument itself. Never in `compact`
            (a Wall tile is read-only and never shows it, regardless of the
            stored preference), and only once the first summary exists. */}
        {!compact && latencyOverlay && latencySummary && <LatencyOverlay summary={latencySummary} />}

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

        {/* The case buttons, on the case — omitted in compact mode (a Wall tile is read-only, no controls to place) and whenever `rail` is suppressed (the device popup draws these itself, in `HardwareRail`, plan 103 §4.1). */}
        {!compact && rail && <div className="flex w-10 shrink-0 flex-col items-center gap-1 pt-10">{hardware.map(keyButton)}</div>}

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

        {/* Plan 106 §5 step 106.7 — a component is installing on this
            device right now. Deliberately NOT the wake panel's treatment
            above: no `bg-bg/95` cover, no centring over the whole area,
            `pointer-events-none` throughout — the picture stays fully
            visible and fully interactive, because the phone streams fine
            while this runs (plan 106 §2, "a readiness signal, never a
            gate") and an operator may be watching for exactly this
            reason. Suppressed while `stopped` or `showWakePanel` already
            own the area — a component installing on a device with no
            picture yet is a fact for the Preparation section, not a
            second overlay stacked on the wake panel's own. */}
        {!compact && provisioning && !stopped && !showWakePanel && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2"
            data-testid="live-view-provisioning-overlay"
          >
            <span className="inline-flex items-center gap-1.5 rounded-full border border-led-active/35 bg-bg/85 px-2.5 py-1 text-[11px] font-medium leading-none text-fg shadow-lg">
              <Loader2 className="size-3 shrink-0 animate-spin text-led-active" aria-hidden />
              Installing {provisioning.label}
              <span className="readout text-fg-subtle">{duration(provisioning.startedAt, null, now)}</span>
            </span>
          </div>
        )}
      </div>

      {/* Nav buttons below the canvas — the same place as the Android nav bar.
          Omitted in compact mode: a Wall tile is read-only, there is nothing here to press.
          The nav/power icons AND the clipboard button are suppressed
          whenever `rail` is — `HardwareRail` already draws Back/Home/
          Recents/Sleep/Wake/Clipboard for the device popup (plan 103 §4.1,
          §5 step 103's layout restructure), so this row would otherwise
          duplicate them (the "appears exactly once" rule that restructure
          names explicitly). The hint line stays either way — it is
          information, not a control. */}
      {!compact && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t px-3 py-2">
          {rail && (
            <>
              {nav.map(keyButton)}
              <span className="mx-1 h-5 w-px bg-line" aria-hidden />
              {power.map(keyButton)}
              <span className="mx-1 h-5 w-px bg-line" aria-hidden />
              {/* The clipboard is an action on the device, not a fact about it
                  (plan 57 §3.4) — so it belongs with the other things you press,
                  not in a panel beside the screen. */}
              <ClipboardButton deviceId={deviceId} canSend={inputEnabled} />
            </>
          )}
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
