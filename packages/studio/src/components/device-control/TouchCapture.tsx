'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Hand, Square, Trash2 } from 'lucide-react'
import type { TouchCaptureSource, TouchCaptureState, TouchStroke } from '@enkaku/protocol'
import { Button, cn } from '@enkaku/ui'
import { newId, ws } from '@/lib/ws'

/**
 * Touch capture (plan 1000 §4.8) — what a REAL finger did on the glass,
 * read back off the phone's own evdev stream.
 *
 * It is the Inspector's sibling, and behaves like it on purpose: opening the
 * section attaches, leaving it detaches, and the phone is left exactly as it
 * was either way. What it shows is the one thing the rest of Studio cannot —
 * the operator's own touches, with millisecond intervals, whether or not
 * anyone remembered to press Record first.
 *
 * Two labels here are load-bearing and must not be quietly "tidied":
 *
 * - **Panel coordinates.** Every position is normalised against the touch
 *   panel's own axis maximum, in the panel's natural orientation, NOT the
 *   display's. On a rotated screen they will not line up with the mirror,
 *   and the header says so rather than the table silently lying.
 * - **Injected.** A capture also sees the farm's own UHID pointer, which is
 *   what a tap made in this very window arrives as. Those rows are marked,
 *   and can be hidden — but they are never dropped, because "did my injected
 *   tap actually land, and where" is the second question this panel answers.
 */

const MAX_ROWS = 300

export function TouchCapture({ deviceId, nodeOwned }: { deviceId: string; nodeOwned: boolean }) {
  const [state, setState] = useState<TouchCaptureState>('starting')
  const [reason, setReason] = useState<string | null>(null)
  const [sources, setSources] = useState<TouchCaptureSource[]>([])
  const [strokes, setStrokes] = useState<TouchStroke[]>([])
  const [hideInjected, setHideInjected] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef(false)

  const apply = useCallback((payload: { state: TouchCaptureState; reason?: string; sources: TouchCaptureSource[]; strokes?: TouchStroke[] }) => {
    setState(payload.state)
    setReason(payload.reason ?? null)
    setSources(payload.sources)
    // A pushed status carries no buffer (it would be a megabyte to say a
    // panel appeared) — keep what is on screen. Nothing is missed: every
    // stroke also arrives on its own message.
    if (payload.strokes) setStrokes(payload.strokes.slice(-MAX_ROWS))
  }, [])

  useEffect(() => {
    if (nodeOwned || startedRef.current) return
    startedRef.current = true
    let cancelled = false
    void (async () => {
      try {
        const res = await ws.request({ type: 'touch.capture.start', id: newId(), payload: { deviceId } }, 40_000)
        if (cancelled || res.type !== 'touch.capture.status') return
        apply(res.payload)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
      ws.send({ type: 'touch.capture.stop', payload: { deviceId } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, nodeOwned])

  useEffect(() => {
    return ws.on((msg) => {
      if (msg.type === 'touch.capture.stroke' && msg.payload.deviceId === deviceId) {
        setStrokes((prev) => [...prev, msg.payload.stroke].slice(-MAX_ROWS))
        return
      }
      if (msg.type === 'touch.capture.status' && msg.payload.deviceId === deviceId) apply(msg.payload)
    })
  }, [deviceId, apply])

  const visible = useMemo(() => (hideInjected ? strokes.filter((s) => !s.synthetic) : strokes), [strokes, hideInjected])

  /**
   * The export. Deliberately the WHOLE stroke — every sample, both clocks,
   * the panel it came off and that panel's maxima — not a prettified
   * summary: this is the copy an operator pastes into a script, an
   * analysis, or a model, and a field trimmed here is a field they cannot
   * get back without recapturing it on the phone.
   */
  const json = useMemo(
    () =>
      JSON.stringify(
        {
          deviceId,
          exportedAt: new Date().toISOString(),
          note: 'Coordinates are normalised 0..1 against the touch panel, in its natural orientation — not the display. Intervals are from the device monotonic clock; `at` is approximate wall clock.',
          sources,
          strokes: visible,
        },
        null,
        2,
      ),
    [deviceId, sources, visible],
  )

  function copy() {
    void navigator.clipboard.writeText(json).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => setError('The browser refused clipboard access.'),
    )
  }

  function clear() {
    ws.send({ type: 'touch.capture.clear', payload: { deviceId } })
    setStrokes([])
  }

  function stop() {
    ws.send({ type: 'touch.capture.stop', payload: { deviceId } })
    setState('stopped')
  }

  if (nodeOwned) return <p className="text-meta text-faint">Touch capture runs on the host that owns this device.</p>

  if (state === 'unavailable' || error) {
    return (
      <div className="flex flex-col gap-2 text-meta text-faint">
        <p className="text-danger">{error ?? reason ?? 'Touch capture is not available on this device.'}</p>
        <p>
          It reads the phone&apos;s own input devices over <code>getevent</code>. A device that exposes no touch panel there — an
          emulator with no touchscreen, a phone whose shell cannot read <code>/dev/input</code> — cannot be captured.
        </p>
      </div>
    )
  }

  const rotated = sources.some((s) => s.rotation !== null && s.rotation !== 0)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 text-[11px]',
            state === 'active' ? 'border-ok/35 bg-ok/10 text-ok' : 'border-line text-faint',
          )}
        >
          <Hand className="size-3" aria-hidden />
          {state === 'active' ? 'Capturing' : state === 'starting' ? 'Starting…' : 'Stopped'}
        </span>
        <span className="text-[11px] text-faint">{visible.length} stroke{visible.length === 1 ? '' : 's'}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={copy} disabled={visible.length === 0}>
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={clear} disabled={strokes.length === 0}>
            <Trash2 className="size-3.5" aria-hidden />
            Clear
          </Button>
          {state === 'active' && (
            <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={stop}>
              <Square className="size-3.5" aria-hidden />
              Stop
            </Button>
          )}
        </div>
      </div>

      <p className="text-[11px] text-faint">
        Touch the phone itself. Positions are the touch panel&apos;s own, normalised 0..1 in its natural orientation
        {rotated ? ' — this screen is rotated, so they will not line up with the mirror' : ''}. Intervals come from the device
        clock.
      </p>

      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sources.map((s) => (
            <span
              key={s.path}
              title={`${s.path} · ${s.protocol} · ${s.maxX}×${s.maxY}`}
              className={cn(
                'rounded-chip border px-1.5 py-0.5 text-[10px]',
                s.synthetic ? 'border-warn/35 bg-warn/10 text-warn' : 'border-line text-faint',
              )}
            >
              {s.name}
              {s.synthetic ? ' · injected' : ''}
            </span>
          ))}
        </div>
      )}

      {sources.some((s) => s.synthetic) && (
        <label className="flex items-center gap-1.5 text-[11px] text-faint">
          <input type="checkbox" checked={hideInjected} onChange={(e) => setHideInjected(e.target.checked)} />
          Hide the farm&apos;s own injected pointer
        </label>
      )}

      {visible.length === 0 ? (
        <p className="rounded-inner border border-line border-dashed p-3 text-center text-meta text-faint">
          Nothing captured yet. Tap the phone.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead className="text-faint">
              <tr className="border-line border-b">
                <th className="py-1 pr-2 text-left font-normal">#</th>
                <th className="py-1 pr-2 text-left font-normal">Kind</th>
                <th className="py-1 pr-2 text-right font-normal" title="Since the previous stroke on the same input device">
                  Interval
                </th>
                <th className="py-1 pr-2 text-right font-normal">Hold</th>
                <th className="py-1 pr-2 text-left font-normal">Position</th>
              </tr>
            </thead>
            <tbody>
              {[...visible].reverse().map((s) => (
                <tr key={s.id} className={cn('border-line/60 border-b', s.synthetic && 'text-warn')}>
                  <td className="py-1 pr-2 tabular-nums text-faint">{s.seq}</td>
                  <td className="py-1 pr-2">
                    {s.kind === 'longPress' ? 'Long press' : s.kind === 'swipe' ? 'Swipe' : 'Tap'}
                    {s.concurrent && <span className="ml-1 text-faint">multi</span>}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">{s.gapMs === null ? '—' : `${Math.round(s.gapMs)} ms`}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{Math.round(s.durationMs)} ms</td>
                  <td className="py-1 pr-2 tabular-nums">
                    {s.kind === 'swipe'
                      ? `(${s.from.x.toFixed(3)}, ${s.from.y.toFixed(3)}) → (${s.to.x.toFixed(3)}, ${s.to.y.toFixed(3)})`
                      : `(${s.from.x.toFixed(3)}, ${s.from.y.toFixed(3)})`}
                    <span className="ml-1 text-faint">
                      {s.kind === 'swipe' ? `${s.samples.length} samples` : `${s.fromRaw.x},${s.fromRaw.y}`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
