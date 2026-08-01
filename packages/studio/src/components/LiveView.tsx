'use client'

import { useEffect, useRef, useState } from 'react'
import { decodeVideoFrame } from '@enkaku/protocol'
import { newId, ws } from '@/lib/ws'

/** Keycode Android yang dipakai tombol nav & keyboard. */
const AKEYCODE = { HOME: 3, BACK: 4, ENTER: 66, DEL: 67, APP_SWITCH: 187 } as const

const DRAG_THRESHOLD_PX = 10
const TEXT_DEBOUNCE_MS = 500

export function LiveView({ deviceId }: { deviceId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamIdRef = useRef<number | null>(null)
  const lastSeqRef = useRef(-1)
  const pointerDownRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const textBufferRef = useRef('')
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [size, setSize] = useState({ width: 0, height: 0 })
  const [fps, setFps] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

  // stream.start saat mount + resubscribe otomatis setelah reconnect.
  useEffect(() => {
    let disposed = false
    const frameTimes: number[] = []

    async function startStream() {
      try {
        const res = await ws.request({ type: 'stream.start', id: newId(), payload: { deviceId } })
        if (res.type !== 'stream.started' || disposed) return
        streamIdRef.current = res.payload.streamId
        lastSeqRef.current = -1
        if (res.payload.width > 0) setSize({ width: res.payload.width, height: res.payload.height })
        setError(null)
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
      if (frame.seq <= lastSeqRef.current) return // buang frame out-of-order
      lastSeqRef.current = frame.seq

      const now = performance.now()
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
      if (streamIdRef.current !== null) {
        ws.send({ type: 'stream.stop', payload: { streamId: streamIdRef.current } })
        streamIdRef.current = null
      }
    }
  }, [deviceId])

  /** Normalisasi terhadap ukuran TAMPILAN elemen — scaling CSS tidak bocor ke server. */
  function normalize(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = normalize(e)
    pointerDownRef.current = { ...p, t: Date.now() }
    e.currentTarget.focus()
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
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
  }

  function flushText() {
    const text = textBufferRef.current
    textBufferRef.current = ''
    if (text.length > 0) ws.send({ type: 'input.text', payload: { deviceId, text } })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
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
    if (keycode !== null) ws.send({ type: 'input.key', payload: { deviceId, keycode } })
  }

  const sendKey = (keycode: number) => ws.send({ type: 'input.key', payload: { deviceId, keycode } })

  return (
    <>
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <button onClick={() => sendKey(AKEYCODE.BACK)}>◀ Back</button>
        <button onClick={() => sendKey(AKEYCODE.HOME)}>● Home</button>
        <button onClick={() => sendKey(AKEYCODE.APP_SWITCH)}>■ Recents</button>
        <span className="hint">
          <span className={`dot ${connected ? 'on' : 'off'}`} /> {fps} fps · {size.width || '?'}×{size.height || '?'} ·
          fallback display: screencap-loop (~2–3 fps)
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      <canvas
        ref={canvasRef}
        className="live-canvas"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        style={size.width > 0 ? { aspectRatio: `${size.width} / ${size.height}` } : undefined}
      />
      <p className="hint">
        Klik = tap · drag = swipe · ketik saat kanvas fokus (hanya ASCII di mode fallback) · Esc = Back.
      </p>
    </>
  )
}
