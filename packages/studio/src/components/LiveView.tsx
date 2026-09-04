'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Circle, Loader2, MoonStar, Power, Square, Sun, Volume2, VolumeOff, VolumeX } from 'lucide-react'
import {
  createLatencyEstimator,
  decodeVideoFrame,
  isDomCode,
  KEYCODES,
  VIDEO_CODEC,
  type DomCode,
  type LatencySummary,
  type Quality,
} from '@enkaku/protocol'
import { createH264Renderer, isWebCodecsSupported, type H264Renderer } from '@/lib/h264-decoder'
import { fetchVideoLatency } from '@/lib/api'
import { LatencyOverlay, type InputHostLatency } from '@/components/video/LatencyOverlay'
import { ClipboardButton } from '@/components/device/ClipboardButton'
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn, duration } from '@enkaku/ui'
import { readLocalPrefs, writeLocalPrefs } from '@/lib/prefs'
import { useNow } from '@/lib/useNow'
import { newId, ws, WsRequestError } from '@/lib/ws'

/**
 * Keycodes come from the protocol package — the same table scripts use, so a
 * button here and a script step mean exactly the same thing to the device.
 */
const AKEYCODE = KEYCODES

/** A live pointer sample is streamed at most this often (plan 209 §3.2 D6, D7; MVP 08 §1.1 row 3). */
const TOUCH_SAMPLE_MS = 8
/** A wheel tick is coalesced to at most this often. */
const WHEEL_SAMPLE_MS = 16
/** Chrome reports about 100 px per wheel notch in pixel mode and 3 lines in line mode. */
const WHEEL_PIXELS_PER_NOTCH = 100
const WHEEL_LINES_PER_NOTCH = 3
/** Up to this many printable ASCII characters paste through `SET_CLIPBOARD`; longer or non-Latin text takes the IME ladder (MVP 08 §1.3). */
const PASTE_VIA_CLIPBOARD_MAX = 256
const PRINTABLE_ASCII = /^[\x20-\x7e\n\r\t]*$/
const INPUT_TEXT_CHUNK = 1000
/** Below this, a gap is just a static screen; above it, something is wrong. */
const STALE_AFTER_SEC = 5
/** Past this, an opt-in auto-reconnect (§4.8) is worth trying — a session is always on now (plan 206), so this is a recovery nudge, never a "wake the device" offer. */
const AUTO_RECOVER_STALE_SEC = 30
/** Auto-recover fires at most once per this window (Plan 17 §4.8). */
const AUTO_RECOVER_COOLDOWN_MS = 60_000
/** Plan 206 §4.9 — how often a `stream.start` refused with `E_SESSION_PREPARING`/`device_offline` retries on its own. */
const PREPARING_RETRY_MS = 3_000
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
   * the no-frames panel below, it never covers the picture opaquely, never
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
  /**
   * Live pointer streaming (plan 209 §4.13, §3.2 D6/D7): every active
   * `PointerEvent.pointerId` maps to a small slot (the UHID pointer has one
   * contact; ids above 0 fall through to `INJECT_TOUCH_EVENT`), sampled at
   * `TOUCH_SAMPLE_MS`. `slotsRef` tracks which slots are currently taken.
   */
  const pointersRef = useRef(new Map<number, { slot: number; lastSentAt: number; last: { x: number; y: number } }>())
  const slotsRef = useRef(new Set<number>())
  /** Physical keys currently held (plan 209 §4.13) — used to send `up` for every held key on blur. */
  const downKeysRef = useRef(new Set<DomCode>())

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
  /** Plan 209 §4.14: the overlay's ninth row — polled separately from the video-only estimator above. */
  const [inputHost, setInputHost] = useState<InputHostLatency | null>(null)
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
  /**
   * Plan 206 §3.10, §4.9 — a device with no base entry yet (still preparing,
   * or offline). Replaces the old phase-by-phase wake panel: the always-on
   * builder's own activity sentence (`E_SESSION_PREPARING`'s message, e.g.
   * "Preparing, step 3 of 5") or `device_offline`'s, shown as the tile's
   * only text while it has no frames, cleared the moment `stream.started`
   * arrives.
   */
  const [noFrames, setNoFrames] = useState<string | null>(null)
  const [painted, setPainted] = useState(false)
  const paintedRef = useRef(false)
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

  /**
   * Ask the server for a fresh IDR without restarting the stream (Plan 17
   * §3.6, §4.5) — the visibility effect below calls this on a hidden→visible
   * transition, and the decoder's own `onNeedKeyframe` hook (plan 209 §4.12)
   * calls it when the decode queue overflows or the hardware-decode probe
   * falls back.
   */
  function requestKeyframe() {
    if (streamIdRef.current === null) return
    ws.send({ type: 'stream.keyframe', payload: { streamId: streamIdRef.current } })
    estimatorRef.current.noteKeyframeRequest()
  }

  // stream.start on mount, plus automatic resubscribe after a reconnect.
  useEffect(() => {
    let disposed = false
    let preparingRetryTimer: ReturnType<typeof setTimeout> | null = null
    const frameTimes: number[] = []
    // A fresh mount or a manual/auto retry is a new session from the viewer's
    // side — start the "no frames yet" state over instead of carrying stale state.
    paintedRef.current = false
    setPainted(false)
    setNoFrames(null)
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
          if (canvas) rendererRef.current = createH264Renderer(canvas, (m) => setError(m), { onEvent: (e) => estimatorRef.current.push(e), onNeedKeyframe: requestKeyframe })
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
        setControlUnavailable(res.payload.degradedReason === 'control_encoder_unavailable' ? (res.payload.degradedDetail ?? '') : null)
        setNoFrames(null)
        setError(null)
        setStopped(null)
        setStreaming(true)
      } catch (err) {
        if (disposed) return
        // Plan 206 §3.10, §4.9 — the device has no base entry yet (still
        // preparing) or is offline: neither is an error to show in red, both
        // retry on their own every `PREPARING_RETRY_MS` until the base entry
        // exists (or the effect is torn down).
        const code = err instanceof WsRequestError ? err.code : null
        if (code === 'E_SESSION_PREPARING' || code === 'device_offline') {
          setNoFrames(err instanceof Error ? err.message : String(err))
          preparingRetryTimer = setTimeout(() => void startStream(), PREPARING_RETRY_MS)
        } else {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    const offStatus = ws.onStatus(setConnected)
    const offReconnect = ws.onReconnected(() => void startStream())
    void startStream()

    const offMsg = ws.on((msg) => {
      if (msg.type === 'stream.meta' && msg.payload.streamId === streamIdRef.current) {
        setSize({ width: msg.payload.width, height: msg.payload.height })
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
          renderer = createH264Renderer(canvas, (m) => setError(m), { onEvent: (e) => estimatorRef.current.push(e), onNeedKeyframe: requestKeyframe })
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
      if (preparingRetryTimer !== null) clearTimeout(preparingRetryTimer)
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
    if (active && !wasActiveRef.current && streamIdRef.current !== null) requestKeyframe()
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
   * Plan 209 §4.14 — the overlay's ninth row (`input (host)`), on a 2000ms
   * tick of its own: `GET /api/video/latency`'s `input` block is the ONE
   * reader this route has in the browser (plan 203 step 203.11's "do not
   * poll the route from LiveView" was scoped to that plan, before this row
   * existed). Same start/stop discipline as the 500ms tick above.
   */
  useEffect(() => {
    if (!latencyOverlay || !streaming || compact) return
    let disposed = false
    const poll = () => {
      void fetchVideoLatency(deviceId)
        .then((res) => {
          if (!disposed) setInputHost(res.input)
        })
        .catch(() => {
          // Best-effort: a failed poll leaves the last known reading in place.
        })
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => {
      disposed = true
      clearInterval(id)
      setInputHost(null)
    }
  }, [latencyOverlay, streaming, compact, deviceId])

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
  function normalize(e: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }

  /** The lowest free slot 0..9 for a new `PointerEvent.pointerId` (plan 209 §4.13). */
  function slotFor(pointerId: number): number {
    const existing = pointersRef.current.get(pointerId)
    if (existing) return existing.slot
    for (let slot = 0; slot <= 9; slot++) {
      if (!slotsRef.current.has(slot)) {
        slotsRef.current.add(slot)
        return slot
      }
    }
    return 0
  }

  /** One `input.touch` sample (plan 209 §3.2 D6, D7; MVP 08 §1.1 row 3) — sent live, never buffered to pointer-up. */
  function sendTouch(action: 'down' | 'move' | 'up', pos: { x: number; y: number }, slot: number) {
    ws.send({ type: 'input.touch', payload: { deviceId, action, pos, pointerId: slot } })
  }

  const sendKey = (keycode: number) => {
    if (!inputEnabled) return
    ws.send({ type: 'input.key', payload: { deviceId, keycode } })
    onActivity?.()
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = normalize(e)
    const slot = slotFor(e.pointerId)
    pointersRef.current.set(e.pointerId, { slot, lastSentAt: performance.now(), last: p })
    sendTouch('down', p, slot)
    e.currentTarget.focus()
  }

  /** Streamed live at `TOUCH_SAMPLE_MS`, never buffered to pointer-up (plan 209 §3.2 D6). */
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    const rec = pointersRef.current.get(e.pointerId)
    if (!rec) return
    const now = performance.now()
    if (now - rec.lastSentAt < TOUCH_SAMPLE_MS) return
    const p = normalize(e)
    rec.lastSentAt = now
    rec.last = p
    sendTouch('move', p, rec.slot)
  }

  function endPointer(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    const rec = pointersRef.current.get(e.pointerId)
    if (!rec) return
    pointersRef.current.delete(e.pointerId)
    slotsRef.current.delete(rec.slot)
    const p = normalize(e)
    sendTouch('up', p, rec.slot)
    e.currentTarget.releasePointerCapture(e.pointerId)
    onActivity?.()
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    endPointer(e)
  }

  function onPointerCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    endPointer(e)
  }

  // Poll rather than time each frame: at 0 fps there is no frame to hang a
  // timer off, and that is exactly the case worth reporting.
  useEffect(() => {
    const t = setInterval(() => {
      const last = lastFrameRef.current
      const sec = last === 0 ? 0 : Math.round((performance.now() - last) / 1000)
      setStaleSec(sec)
      // Opt-in auto-recover (§4.8): left off, nothing disturbs a device
      // whose screen is merely static (always-on sessions never sleep on
      // their own, plan 206). On, one stop+start cycle at most per minute.
      if (autoReconnect && sec >= AUTO_RECOVER_STALE_SEC) {
        const nowMs = Date.now()
        if (nowMs - lastAutoRecoverRef.current >= AUTO_RECOVER_COOLDOWN_MS) {
          lastAutoRecoverRef.current = nowMs
          setRetryTick((n) => n + 1)
        }
      }
    }, 1000)
    return () => clearInterval(t)
  }, [autoReconnect])

  /**
   * Wheel scroll (plan 209 §4.13, §3.2 the `input.scroll` message) — a native
   * listener, not React's `onWheel`: React's synthetic wheel handler is
   * passive and `preventDefault()` is silently ignored on it, which would
   * leave the BROWSER page scrolling underneath the canvas on every tick.
   */
  useEffect(() => {
    if (!inputEnabled || compact) return
    const canvas = canvasRef.current
    if (!canvas) return
    let accX = 0
    let accY = 0
    let lastSentAt = 0
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const scale = e.deltaMode === 1 ? 1 / WHEEL_LINES_PER_NOTCH : e.deltaMode === 2 ? 1 : 1 / WHEEL_PIXELS_PER_NOTCH
      let dx = e.deltaX * scale
      let dy = e.deltaY * scale
      if (e.shiftKey && dx === 0) {
        dx = dy
        dy = 0
      }
      accX += dx
      accY += dy
      const now = performance.now()
      if (now - lastSentAt < WHEEL_SAMPLE_MS) return
      lastSentAt = now
      const rect = canvas.getBoundingClientRect()
      const pos = {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
      }
      // Browser `deltaY > 0` is scroll down; Android `AXIS_VSCROLL > 0` is scroll up — sign flipped.
      const clamp = (v: number) => Math.min(1, Math.max(-1, -v))
      ws.send({ type: 'input.scroll', payload: { deviceId, pos, hDelta: clamp(accX), vDelta: clamp(accY) } })
      accX = 0
      accY = 0
      onActivity?.()
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [inputEnabled, compact, deviceId, onActivity])

  const metaOf = (e: React.KeyboardEvent) => ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey })

  /**
   * Pushes the OPERATOR's browser clipboard onto the device (plan 90 §3.3, §5 step 90.5; plan 209
   * §4.13 splits it by length/script). Short, printable-ASCII text pastes through `SET_CLIPBOARD`
   * (the SAME `clipboard.set(..., { paste: true })` mechanism `ClipboardButton`'s manual popover
   * already calls); longer or non-Latin text takes the `input.text` ladder in chunks, in order —
   * an explicit paste is a deliberate operator choice, not a rung the resolver should pick for them.
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
      if (text.length <= PASTE_VIA_CLIPBOARD_MAX && PRINTABLE_ASCII.test(text)) {
        await ws.request({ type: 'clipboard.set', id: newId(), payload: { deviceId, text, paste: true } })
      } else {
        const codePoints = [...text]
        for (let i = 0; i < codePoints.length; i += INPUT_TEXT_CHUNK) {
          const chunk = codePoints.slice(i, i + INPUT_TEXT_CHUNK).join('')
          await ws.request({ type: 'input.text', id: newId(), payload: { deviceId, text: chunk } })
        }
      }
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
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') {
      e.preventDefault()
      void pasteFromClipboard()
      return
    }
    e.preventDefault()
    if (e.repeat) return // the device auto-repeats a held key itself
    if (e.code === 'Escape') {
      // MVP 08 §1.2: Esc is Back, always.
      sendKey(AKEYCODE.BACK)
      return
    }
    if (!isDomCode(e.code)) return
    downKeysRef.current.add(e.code)
    ws.send({ type: 'input.keyEvent', payload: { deviceId, action: 'down', code: e.code, meta: metaOf(e) } })
    onActivity?.()
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!inputEnabled) return
    e.preventDefault()
    if (e.code === 'Escape' || !isDomCode(e.code)) return
    if (!downKeysRef.current.delete(e.code)) return
    ws.send({ type: 'input.keyEvent', payload: { deviceId, action: 'up', code: e.code, meta: metaOf(e) } })
  }

  /** A closed tab or a focus change must not leave a finger down or a key held (MVP 08 §1.1 last row). */
  function onBlur() {
    for (const code of downKeysRef.current) {
      ws.send({ type: 'input.keyEvent', payload: { deviceId, action: 'up', code, meta: { shift: false, ctrl: false, alt: false, meta: false } } })
    }
    downKeysRef.current.clear()
    for (const [pointerId, rec] of pointersRef.current) {
      sendTouch('up', rec.last, rec.slot)
      slotsRef.current.delete(rec.slot)
      pointersRef.current.delete(pointerId)
    }
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help border-b border-dotted border-led-warn text-led-warn">
                    no new frames for {staleSec}s
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  The picture is the last frame received. scrcpy sends nothing while the screen is static or off.
                </TooltipContent>
              </Tooltip>
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
            **Why it is here and not in the no-frames panel above** (plan 206
            §4.9): that panel's own visibility condition is `noFrames !==
            null && !painted`, so it is gone at the exact instant this number
            comes into existence — a reading rendered there could never be
            seen. This status line is the
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
          onPointerCancel={compact ? undefined : onPointerCancel}
          onKeyDown={compact ? undefined : onKeyDown}
          onKeyUp={compact ? undefined : onKeyUp}
          onBlur={compact ? undefined : onBlur}
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
        {!compact && latencyOverlay && latencySummary && <LatencyOverlay summary={latencySummary} inputHost={inputHost} />}

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

        {/* Plan 206 §3.10, §4.9 — the tile's only text while it has no
            frames: the always-on builder's activity sentence ("Preparing,
            step 3 of 5", "Recovering, attempt 1") or "the device is
            offline", retried automatically every `PREPARING_RETRY_MS`. The
            handoff's Screens-card rule ("Center text only when not live")
            is what sizes this at 11px even outside compact mode — this is
            the pre-plan-214 stand-in for that centre text. */}
        {noFrames !== null && !painted && !stopped && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/95 px-2 text-center">
            <p className={compact ? 'text-[11px] text-fg-muted' : 'text-[13px] text-fg-muted'}>{noFrames}</p>
          </div>
        )}

        {/* Plan 106 §5 step 106.7 — a component is installing on this
            device right now. Deliberately NOT the no-frames panel's
            treatment above: no `bg-bg/95` cover, no centring over the whole
            area, `pointer-events-none` throughout — the picture stays fully
            visible and fully interactive, because the phone streams fine
            while this runs (plan 106 §2, "a readiness signal, never a
            gate") and an operator may be watching for exactly this
            reason. Suppressed while `stopped` or the no-frames panel
            already own the area — a component installing on a device with
            no picture yet is a fact for the Preparation section, not a
            second overlay stacked on that panel's own. */}
        {!compact && provisioning && !stopped && !(noFrames !== null && !painted) && (
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
