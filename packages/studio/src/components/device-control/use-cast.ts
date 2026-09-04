'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  createLatencyEstimator,
  decodeVideoFrame,
  hotkeyFor,
  isDomCode,
  KEYCODES,
  VIDEO_CODEC,
  type ClientMessage,
  type DomCode,
  type LatencySummary,
  type Quality,
} from '@enkaku/protocol'
import { createH264Renderer, isWebCodecsSupported, type H264Renderer } from '@/lib/h264-decoder'
import { fetchVideoLatency } from '@/lib/api'
import type { InputHostLatency } from '@/components/video/LatencyOverlay'
import { runOnDevice } from '@/lib/actions'
import { newId, ws, WsRequestError } from '@/lib/ws'

/**
 * `LiveView`'s stream, decode, input, focus and clipboard machinery, moved
 * into one hook (plan 215 §3.2 D8, §4.5) so this window and the Screens
 * tile (`LiveView.tsx`, rewritten by step 215.10) share exactly one cast
 * implementation. The fps window, staleness watchdog, latency estimator,
 * and plan 209's pointer/wheel/key handlers move VERBATIM; the fan-out, the
 * focus model, the hotkey dispatch and the three new pointer-table rows
 * (right click, middle click, Ctrl/Alt-drag pinch) are new here.
 */

const TOUCH_SAMPLE_MS = 8
const WHEEL_SAMPLE_MS = 16
const WHEEL_PIXELS_PER_NOTCH = 100
const WHEEL_LINES_PER_NOTCH = 3
const PASTE_VIA_CLIPBOARD_MAX = 256
const PRINTABLE_ASCII = /^[\x20-\x7e\n\r\t]*$/
const INPUT_TEXT_CHUNK = 1000
const PREPARING_RETRY_MS = 3_000

export interface CastStats {
  streaming: boolean
  connected: boolean
  fps: number
  width: number
  height: number
  codec: 'png' | 'h264'
  /** Plan 206: the wall encoder is standing in while the control encoder starts. */
  substitute: boolean
  /** Plan 206: this device cannot run a second encoder; `substitute` is permanent. */
  encoderUnavailable: boolean
  /** Seconds since the last frame; the staleness watchdog. */
  staleSec: number
  /** Sum of plan 203's four medians, or null while either offset is estimating (plan 215 §3.2 D7). */
  latencyMs: number | null
  summary: LatencySummary | null
  inputHost: InputHostLatency | null
  /** `stream.ended`'s reason, or null. */
  stopped: string | null
  error: string | null
  notice: string | null
}

export interface UseCastOptions {
  deviceId: string
  quality: Quality
  /** `false` for the Screens tile: no pointer, no wheel, no keyboard, no focus. */
  interactive: boolean
  /**
   * Every device this canvas drives. `[deviceId]` for one device; the host
   * first followed by every other selected device for the mirror fan-out
   * (plan 215 §3.2 D11). `clipboard.set` never uses it.
   */
  targets: readonly string[]
  /** Ask for a fresh keyframe on a false→true transition. */
  active?: boolean
  latencyOverlay?: boolean
  /** The window's own rotate action, so the `rotate` hotkey and the rail button run one code path. */
  onRotate?: () => void
}

export interface UseCast {
  canvasRef: RefObject<HTMLCanvasElement | null>
  stats: CastStats
  focused: boolean
  /** Bind onto the `<canvas>`: pointer, key and focus/blur. Wheel and contextmenu are bound imperatively (native listeners). */
  canvasProps: {
    tabIndex: number
    onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void
    onPointerCancel: (e: React.PointerEvent<HTMLCanvasElement>) => void
    onKeyDown: (e: React.KeyboardEvent<HTMLCanvasElement>) => void
    onKeyUp: (e: React.KeyboardEvent<HTMLCanvasElement>) => void
    onFocus: () => void
    onBlur: () => void
    onContextMenu: (e: React.MouseEvent) => void
  }
  /** `input.key` to every target. Used by the rail and by the hotkey table. */
  sendKey: (keycode: number) => void
  /** Reads the browser clipboard and pastes it to the HOST device only. */
  pasteFromClipboard: () => Promise<void>
  /** The last `clipboard.changed` this device pushed, for Alt+C. */
  deviceClipboard: string | null
  /** Everything this device has copied while the window has been open, newest first (plan 209 §3.2 D10's push, kept instead of discarded). */
  deviceClipboardHistory: ClipboardEntry[]
  /** Drops the remembered history. The device's own clipboard is untouched — this only forgets what Studio saw. */
  clearDeviceClipboardHistory: () => void
  /** One `clipboard.get`, folded into the same history the pushes feed. Throws so the caller can show the failure. */
  readDeviceClipboard: () => Promise<void>
  copyDeviceClipboard: () => Promise<void>
  releaseFocus: () => void
  requestFullscreen: () => void
  retry: () => void
}

/**
 * One thing the device copied. `at` is the browser's clock, not the device's:
 * the wire message (`clipboard.changed`) carries no timestamp, and inventing
 * a device-side one out of arrival time would be a measurement nobody made.
 */
export interface ClipboardEntry {
  text: string
  at: number
}

/**
 * How many copies are remembered per device-control window. Clipboard content
 * is very often a password or a one-time token — plan 38 §4.5 is explicit
 * about that, which is why `clipboard.value` is unicast in the first place —
 * so this is deliberately a short, in-memory, per-window list: it dies with
 * the window, never reaches the DB, and never reaches another viewer.
 */
const CLIPBOARD_HISTORY_MAX = 20

function metaOf(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }
}

/** How often the fps readout may re-render Device Control. The value behind it is a 3-second rolling average, so anything faster is noise. */
const FPS_PUBLISH_MS = 500

export function useCast(opts: UseCastOptions): UseCast {
  const { deviceId, quality, interactive, targets, active = true, latencyOverlay = false, onRotate } = opts

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamIdRef = useRef<number | null>(null)
  const lastSeqRef = useRef(-1)
  const pointersRef = useRef(new Map<number, { slot: number; lastSentAt: number; last: { x: number; y: number } }>())
  const slotsRef = useRef(new Set<number>())
  const downKeysRef = useRef(new Set<DomCode>())
  const rendererRef = useRef<H264Renderer | null>(null)
  const estimatorRef = useRef(createLatencyEstimator())
  const lastPtsSeqRef = useRef<number | null>(null)
  const lastFrameRef = useRef(0)

  const [streaming, setStreaming] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  const [staleSec, setStaleSec] = useState(0)
  const [retryTick, setRetryTick] = useState(0)
  const [codec, setCodec] = useState<'png' | 'h264'>('png')
  const [substitute, setSubstitute] = useState(false)
  const [encoderUnavailable, setEncoderUnavailable] = useState(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [fps, setFps] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [summary, setSummary] = useState<LatencySummary | null>(null)
  const [inputHost, setInputHost] = useState<InputHostLatency | null>(null)
  const [focused, setFocused] = useState(false)
  const [deviceClipboard, setDeviceClipboard] = useState<string | null>(null)
  const [deviceClipboardHistory, setDeviceClipboardHistory] = useState<ClipboardEntry[]>([])

  function requestKeyframe() {
    if (streamIdRef.current === null) return
    ws.send({ type: 'stream.keyframe', payload: { streamId: streamIdRef.current } })
    estimatorRef.current.noteKeyframeRequest()
  }

  // stream.start on mount, plus resubscribe on reconnect and manual retry.
  useEffect(() => {
    let disposed = false
    let preparingRetryTimer: ReturnType<typeof setTimeout> | null = null
    const frameTimes: number[] = []

    /**
     * Publish the frame rate at most `FPS_PUBLISH_MS` apart, and only when the
     * displayed value actually changes.
     *
     * This used to be a bare `setFps(...)` on EVERY decoded frame — 17 to 60
     * React renders a second, each one re-rendering the whole Device Control
     * subtree: the shortcut rail, the Actions tab, the Inspector, every
     * tooltip and popover inside them. The owner reported it as controls
     * flickering and state resetting "whenever the fps changes" (field
     * report, 2026-09-04), which is exactly what a 60 Hz re-render of an
     * interactive tree looks like.
     *
     * Nothing is lost by throttling: the number is already a 3-second rolling
     * average, so publishing it sixty times a second showed sixty samples of
     * the same window — and an fps counter that changes every 16 ms is
     * unreadable anyway.
     */
    let lastFpsAt = 0
    let lastFpsValue = -1
    const publishFps = (now: number) => {
      const value = Number((frameTimes.length / 3).toFixed(1))
      if (value === lastFpsValue) return
      if (now - lastFpsAt < FPS_PUBLISH_MS) return
      lastFpsAt = now
      lastFpsValue = value
      setFps(value)
    }

    async function startStream() {
      try {
        const res = await ws.request({ type: 'stream.start', id: newId(), payload: { deviceId, quality } })
        if (res.type !== 'stream.started' || disposed) return
        streamIdRef.current = res.payload.streamId
        lastSeqRef.current = -1
        setCodec(res.payload.codec)
        setSubstitute(res.payload.substitute === 'wall')
        if (res.payload.codec === 'h264') {
          if (!isWebCodecsSupported()) {
            setError('This browser does not support WebCodecs — use Chromium for the H.264 stream.')
            return
          }
          const canvas = canvasRef.current
          if (canvas) rendererRef.current = createH264Renderer(canvas, (m) => setError(m), { onEvent: (e) => estimatorRef.current.push(e), onNeedKeyframe: requestKeyframe })
        }
        if (res.payload.width > 0) setSize({ width: res.payload.width, height: res.payload.height })
        estimatorRef.current.reset()
        lastPtsSeqRef.current = null
        setEncoderUnavailable(res.payload.degradedReason === 'control_encoder_unavailable')
        setNotice(null)
        setError(null)
        setStopped(null)
        setStreaming(true)
      } catch (err) {
        if (disposed) return
        const code = err instanceof WsRequestError ? err.code : null
        if (code === 'E_SESSION_PREPARING' || code === 'device_offline') {
          setNotice(err instanceof Error ? err.message : String(err))
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
        if ('quality' in msg.payload) setSubstitute(msg.payload.quality === 'wall')
      } else if (msg.type === 'stream.ended' && msg.payload.deviceId === deviceId) {
        streamIdRef.current = null
        setStreaming(false)
        setFps(0)
        setStopped(msg.payload.reason)
      } else if (msg.type === 'clipboard.changed' && msg.payload.deviceId === deviceId) {
        setDeviceClipboard(msg.payload.text)
        recordClipboard(msg.payload.text)
      } else if (msg.type === 'error') {
        setError(msg.payload.message)
      }
    })

    const offBinary = ws.onBinary((buf) => {
      const browserReceivedAt = Date.now()
      let frame
      try {
        frame = decodeVideoFrame(buf)
      } catch {
        return
      }
      if (frame.streamId !== streamIdRef.current) return

      if (frame.codec === VIDEO_CODEC.H264) {
        let renderer = rendererRef.current
        if (!renderer) {
          const canvas = canvasRef.current
          if (!canvas) return
          renderer = createH264Renderer(canvas, (m) => setError(m), { onEvent: (e) => estimatorRef.current.push(e), onNeedKeyframe: requestKeyframe })
          if (!renderer) return
          rendererRef.current = renderer
          setCodec('h264')
        }
        if (frame.ptsUs > BigInt(0)) {
          const last = lastPtsSeqRef.current
          if (last !== null && frame.seq > last + 1) estimatorRef.current.noteSeqGap(frame.seq - last - 1)
          lastPtsSeqRef.current = frame.seq
        }
        renderer.decode(frame.data, frame.keyframe, frame.width, frame.height, {
          ptsUs: frame.ptsUs,
          hostReceivedAt: frame.hostReceivedAt,
          browserReceivedAt,
        })
        const now = performance.now()
        lastFrameRef.current = now
        frameTimes.push(now)
        while (frameTimes.length > 0 && now - frameTimes[0]! > 3000) frameTimes.shift()
        publishFps(now)
        return
      }

      if (frame.seq <= lastSeqRef.current) return
      lastSeqRef.current = frame.seq

      const now = performance.now()
      lastFrameRef.current = now
      frameTimes.push(now)
      while (frameTimes.length > 0 && now - frameTimes[0]! > 3000) frameTimes.shift()
      publishFps(now)

      const canvas = canvasRef.current
      if (!canvas) return
      void createImageBitmap(new Blob([frame.data.slice() as unknown as BlobPart], { type: 'image/png' })).then((bitmap) => {
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width
          canvas.height = frame.height
        }
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        bitmap.close()
      })
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
      if (streamIdRef.current !== null) {
        ws.send({ type: 'stream.stop', payload: { streamId: streamIdRef.current } })
        streamIdRef.current = null
      }
    }
  }, [deviceId, quality, retryTick])

  const wasActiveRef = useRef(active)
  useEffect(() => {
    if (active && !wasActiveRef.current && streamIdRef.current !== null) requestKeyframe()
    wasActiveRef.current = active
  }, [active])

  useEffect(() => {
    if (!latencyOverlay || !streaming) return
    const id = setInterval(() => setSummary(estimatorRef.current.summary(performance.now())), 500)
    return () => clearInterval(id)
  }, [latencyOverlay, streaming])

  useEffect(() => {
    if (!latencyOverlay || !streaming) return
    let disposed = false
    const poll = () => {
      void fetchVideoLatency(deviceId)
        .then((res) => {
          if (!disposed) setInputHost(res.input)
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => {
      disposed = true
      clearInterval(id)
      setInputHost(null)
    }
  }, [latencyOverlay, streaming, deviceId])

  useEffect(() => {
    const t = setInterval(() => {
      const last = lastFrameRef.current
      const sec = last === 0 ? 0 : Math.round((performance.now() - last) / 1000)
      setStaleSec(sec)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // Fan-out: one `input.*` per target, host first (plan 215 §3.2 D11).
  function sendInput(build: (target: string) => ClientMessage) {
    for (const id of targets) ws.send(build(id))
  }

  function normalize(e: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }

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

  function sendTouch(action: 'down' | 'move' | 'up', pos: { x: number; y: number }, slot: number) {
    sendInput((id) => ({ type: 'input.touch', payload: { deviceId: id, action, pos, pointerId: slot } }))
  }

  const sendKey = (keycode: number) => {
    if (!interactive) return
    sendInput((id) => ({ type: 'input.key', payload: { deviceId: id, keycode } }))
  }

  // Ctrl/Cmd/Alt + left-button drag: a pinch, not a touch stream (§4.5 item 4).
  const pinchRef = useRef<{ originX: number; originY: number; startedAt: number; startRadius: number } | null>(null)

  function radiusFrom(cx: number, cy: number, x: number, y: number, w: number, h: number): number {
    const m = Math.min(w, h) || 1
    return Math.min(0.5, Math.max(0.02, Math.hypot(x - cx, y - cy) / m))
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!interactive) return
    if (e.button === 2) {
      sendKey(KEYCODES.BACK)
      return
    }
    if (e.button === 1) {
      sendKey(KEYCODES.HOME)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    if ((e.ctrlKey || e.metaKey || e.altKey) && e.button === 0) {
      const p = normalize(e)
      const originX = e.ctrlKey || e.metaKey ? 0.5 : p.x
      const originY = e.ctrlKey || e.metaKey ? 0.5 : p.y
      const startRadius = radiusFrom(originX, originY, p.x, p.y, 1, 1)
      pinchRef.current = { originX, originY, startedAt: performance.now(), startRadius }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    void rect
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = normalize(e)
    const slot = slotFor(e.pointerId)
    pointersRef.current.set(e.pointerId, { slot, lastSentAt: performance.now(), last: p })
    sendTouch('down', p, slot)
    e.currentTarget.focus()
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!interactive) return
    if (pinchRef.current) return
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
    if (!interactive) return
    const pinch = pinchRef.current
    if (pinch) {
      pinchRef.current = null
      const p = normalize(e)
      const scaleTo = radiusFrom(pinch.originX, pinch.originY, p.x, p.y, 1, 1)
      const durationMs = Math.min(10_000, Math.max(50, Math.round(performance.now() - pinch.startedAt)))
      sendInput((id) => ({
        type: 'input.pinch',
        payload: { deviceId: id, center: { x: pinch.originX, y: pinch.originY }, scaleFrom: pinch.startRadius, scaleTo, durationMs },
      }))
      e.currentTarget.releasePointerCapture(e.pointerId)
      return
    }
    const rec = pointersRef.current.get(e.pointerId)
    if (!rec) return
    pointersRef.current.delete(e.pointerId)
    slotsRef.current.delete(rec.slot)
    const p = normalize(e)
    sendTouch('up', p, rec.slot)
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    endPointer(e)
  }
  function onPointerCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    endPointer(e)
  }

  // Wheel (native listener: React's onWheel is passive and cannot preventDefault).
  useEffect(() => {
    if (!interactive) return
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
      const clamp = (v: number) => Math.min(1, Math.max(-1, -v))
      sendInput((id) => ({ type: 'input.scroll', payload: { deviceId: id, pos, hDelta: clamp(accX), vDelta: clamp(accY) } }))
      accX = 0
      accY = 0
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [interactive, targets.join(',')])

  async function pasteFromClipboard(): Promise<void> {
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch (err) {
      setNotice(`could not read the browser clipboard: ${err instanceof Error ? err.message : String(err)}`)
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
      setNotice(null)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Empty copies are ignored, and a repeat of what is already at the top is
   * not a second entry: some devices re-announce the same clipboard on every
   * focus change, and a history that fills with twenty copies of one string
   * is not a history. A repeat further down the list DOES move back to the
   * top — copying something again is a real event, and its position is the
   * only thing that says which one is current.
   */
  function recordClipboard(text: string): void {
    if (text.length === 0) return
    setDeviceClipboardHistory((prev) => {
      if (prev[0]?.text === text) return prev
      return [{ text, at: Date.now() }, ...prev.filter((e) => e.text !== text)].slice(0, CLIPBOARD_HISTORY_MAX)
    })
  }

  function clearDeviceClipboardHistory(): void {
    setDeviceClipboardHistory([])
  }

  /**
   * The one thing `clipboard.changed` cannot do: read what was already on
   * the device's clipboard BEFORE this window opened. Its answer joins the
   * same list the pushes feed, so the popover has one place to look rather
   * than a live list beside a separate one-shot readout.
   */
  async function readDeviceClipboard(): Promise<void> {
    const res = await ws.request({ type: 'clipboard.get', id: newId(), payload: { deviceId } })
    if (res.type === 'clipboard.value') {
      setDeviceClipboard(res.payload.text)
      recordClipboard(res.payload.text)
    }
  }

  async function copyDeviceClipboard(): Promise<void> {
    let text = deviceClipboard
    if (text === null) {
      try {
        const res = await ws.request({ type: 'clipboard.get', id: newId(), payload: { deviceId } })
        if (res.type === 'clipboard.value') text = res.payload.text
      } catch {
        return
      }
    }
    if (text === null) return
    recordClipboard(text)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Best-effort: some browsers refuse without a fresh gesture.
    }
  }

  function releaseFocus() {
    canvasRef.current?.blur()
  }

  function requestFullscreen() {
    void canvasRef.current?.parentElement?.requestFullscreen?.()
  }

  function retry() {
    setRetryTick((n) => n + 1)
  }

  function runHotkey(id: string) {
    switch (id) {
      case 'back':
        sendKey(KEYCODES.BACK)
        return
      case 'home':
        sendKey(KEYCODES.HOME)
        return
      case 'recents':
        sendKey(KEYCODES.APP_SWITCH)
        return
      case 'power':
        sendKey(KEYCODES.POWER)
        return
      case 'rotate':
        onRotate?.()
        return
      case 'notifications':
        for (const id2 of targets) void runOnDevice('adb', id2, { cmd: 'cmd statusbar expand-notifications' })
        return
      case 'settings-panel':
        for (const id2 of targets) void runOnDevice('adb', id2, { cmd: 'cmd statusbar expand-settings' })
        return
      case 'collapse-panels':
        for (const id2 of targets) void runOnDevice('adb', id2, { cmd: 'cmd statusbar collapse' })
        return
      case 'fullscreen':
        requestFullscreen()
        return
      case 'clipboard-copy':
        void copyDeviceClipboard()
        return
      case 'clipboard-paste':
        void pasteFromClipboard()
        return
      case 'release-focus':
        releaseFocus()
        return
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!interactive) return
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') {
      e.preventDefault()
      e.stopPropagation()
      void pasteFromClipboard()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    const hk = hotkeyFor({ code: e.code, altKey: e.altKey, shiftKey: e.shiftKey })
    if (hk) {
      runHotkey(hk.id)
      return
    }
    if (!isDomCode(e.code)) return
    downKeysRef.current.add(e.code)
    sendInput((id) => ({ type: 'input.keyEvent', payload: { deviceId: id, action: 'down', code: e.code as DomCode, meta: metaOf(e) } }))
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!interactive) return
    e.preventDefault()
    e.stopPropagation()
    if (!isDomCode(e.code)) return
    if (!downKeysRef.current.delete(e.code)) return
    sendInput((id) => ({ type: 'input.keyEvent', payload: { deviceId: id, action: 'up', code: e.code as DomCode, meta: metaOf(e) } }))
  }

  function onFocus() {
    setFocused(true)
  }

  function onBlur() {
    setFocused(false)
    for (const code of downKeysRef.current) {
      sendInput((id) => ({ type: 'input.keyEvent', payload: { deviceId: id, action: 'up', code, meta: { shift: false, ctrl: false, alt: false, meta: false } } }))
    }
    downKeysRef.current.clear()
    for (const [pointerId, rec] of pointersRef.current) {
      sendTouch('up', rec.last, rec.slot)
      slotsRef.current.delete(rec.slot)
      pointersRef.current.delete(pointerId)
    }
  }

  // An outside click blurs the canvas (D4): capture phase so it runs before a
  // click on another element steals focus in some other way.
  useEffect(() => {
    if (!interactive) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (document.activeElement !== canvasRef.current) return
      if (e.target === canvasRef.current) return
      canvasRef.current?.blur()
    }
    document.addEventListener('mousedown', onDocMouseDown, true)
    return () => document.removeEventListener('mousedown', onDocMouseDown, true)
  }, [interactive])

  useEffect(() => () => {
    if (interactive) onBlur()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const latencyMs =
    summary && summary.deviceToHost && summary.hostToBrowser
      ? summary.deviceToHost.median + summary.hostToBrowser.median + summary.decode.median + summary.decodeToPaint.median
      : null

  return {
    canvasRef,
    stats: {
      streaming,
      connected,
      fps,
      width: size.width,
      height: size.height,
      codec,
      substitute,
      encoderUnavailable,
      staleSec,
      latencyMs,
      summary,
      inputHost,
      stopped,
      error,
      notice,
    },
    focused,
    canvasProps: {
      tabIndex: interactive ? 0 : -1,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onKeyDown,
      onKeyUp,
      onFocus,
      onBlur,
      onContextMenu: (e) => e.preventDefault(),
    },
    sendKey,
    pasteFromClipboard,
    deviceClipboard,
    deviceClipboardHistory,
    clearDeviceClipboardHistory,
    readDeviceClipboard,
    copyDeviceClipboard,
    releaseFocus,
    requestFullscreen,
    retry,
  }
}
