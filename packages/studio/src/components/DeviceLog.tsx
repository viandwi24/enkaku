'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Pause, Play } from 'lucide-react'
import { DeviceEventsResponseSchema, type DeviceEvent, type DeviceEventStream } from '@enkaku/protocol'
import { api } from '@/lib/actions'
import { ws } from '@/lib/ws'
import { relativeTime } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { cn } from '@/lib/utils'

/**
 * A bounded window per stream (plan 18 §8 risks table): a tab left open for
 * hours must not grow without bound just because it kept receiving events —
 * history is a scroll (and a query) away.
 */
const MAX_ROWS = 500
const PAGE_SIZE = 100

const STREAMS: Array<{ key: DeviceEventStream; label: string }> = [
  { key: 'main', label: 'Main' },
  { key: 'input', label: 'Input' },
]

const KIND_LABEL: Record<string, string> = {
  'device.online': 'Connected',
  'device.offline': 'Disconnected',
  'device.unauthorized': 'Unauthorized',
  'control.acquired': 'Control taken',
  'control.released': 'Control released',
  'control.revoked': 'Control revoked',
  'session.opened': 'Session opened',
  'session.closed': 'Session closed',
  'session.degraded': 'Session degraded',
  'job.started': 'Job started',
  'job.finished': 'Job finished',
  'job.retry': 'Job retry',
  'job.triggered': 'Job triggered',
  'settings.changed': 'Settings changed',
  'battery.warning': 'Battery warning',
  'input.tap': 'Tap',
  'input.swipe': 'Swipe',
  'input.key': 'Key',
  'input.text': 'Typed text',
  'adb.endpoint.opened': 'adb endpoint opened',
  'adb.endpoint.closed': 'adb endpoint closed',
  'adb.open': 'adb stream',
  'app.crashed': 'App crashed',
}

const KIND_TONE: Record<string, string> = {
  'device.online': 'text-led-ok border-led-ok/35 bg-led-ok/10',
  'device.offline': 'text-fg-subtle border-line bg-transparent',
  'device.unauthorized': 'text-led-warn border-led-warn/35 bg-led-warn/10',
  'control.acquired': 'text-led-active border-led-active/35 bg-led-active/10',
  'control.released': 'text-fg-subtle border-line bg-transparent',
  'control.revoked': 'text-led-warn border-led-warn/35 bg-led-warn/10',
  'session.degraded': 'text-led-warn border-led-warn/35 bg-led-warn/10',
  'job.finished': 'text-led-ok border-led-ok/35 bg-led-ok/10',
  'job.retry': 'text-led-warn border-led-warn/35 bg-led-warn/10',
  'job.triggered': 'text-led-active border-led-active/35 bg-led-active/10',
  'battery.warning': 'text-led-danger border-led-danger/40 bg-led-danger/10',
  'adb.endpoint.opened': 'text-led-active border-led-active/35 bg-led-active/10',
  'adb.endpoint.closed': 'text-fg-subtle border-line bg-transparent',
  'app.crashed': 'text-led-danger border-led-danger/40 bg-led-danger/10',
}
const DEFAULT_TONE = 'text-fg-muted border-line bg-transparent'

function summarize(ev: DeviceEvent): string {
  const meta = (ev.meta ?? {}) as Record<string, unknown>
  switch (ev.kind) {
    case 'device.online':
      return `via ${String(meta.serial ?? 'unknown')} (${String(meta.transport ?? 'adb-usb')})`
    case 'device.offline':
      return meta.reason ? `Reason: ${String(meta.reason)}` : 'The device went offline'
    case 'device.unauthorized':
      return 'Waiting for the USB debugging prompt to be accepted on the device'
    case 'control.acquired':
      return 'Manual control was taken'
    case 'control.released':
      return 'Manual control was released'
    case 'control.revoked':
      return `Released automatically${meta.reason ? ` (${String(meta.reason)})` : ''}`
    case 'session.opened':
      return `${String(meta.display ?? '?')} / ${String(meta.input ?? '?')} / ${String(meta.inspection ?? '?')}`
    case 'session.closed':
      return meta.reason ? `Reason: ${String(meta.reason)}` : 'Session closed'
    case 'session.degraded':
      return `${String(meta.from ?? '?')} → ${String(meta.to ?? '?')}${meta.reason ? `: ${String(meta.reason)}` : ''}`
    case 'job.started':
      return `Script ${String(meta.scriptId ?? '?')}`
    case 'job.finished': {
      const ms = typeof meta.durationMs === 'number' ? meta.durationMs : null
      return `${String(meta.status ?? '?')}${ms !== null ? ` in ${(ms / 1000).toFixed(1)}s` : ''}`
    }
    case 'job.retry': {
      // Plan 36 §4.4: attempt, class, code, backoff delay, and whether this
      // was a batch member moving to another device rather than an in-place retry.
      const delayMs = typeof meta.delayMs === 'number' ? meta.delayMs : 0
      const rebound = meta.rebound === true
      const parts = [`${String(meta.class ?? '?')}:${String(meta.code ?? '?')}`]
      if (delayMs > 0) parts.push(`after ${delayMs}ms`)
      if (rebound) parts.push(`→ moved to another device`)
      return parts.join(' ')
    }
    case 'job.triggered': {
      // plan 81 §4.5 — `jobs/jobs-runner-port.ts`'s `onTriggered` meta shape.
      // This device is the TARGET (where `toJobId` will run); `fromJobId` is
      // the triggering job, which may be running on a different device.
      const fromId = typeof meta.fromJobId === 'string' ? meta.fromJobId.slice(0, 8) : '?'
      const toId = typeof meta.toJobId === 'string' ? meta.toJobId.slice(0, 8) : '?'
      const depth = typeof meta.depth === 'number' ? meta.depth : null
      return `job ${fromId} queued job ${toId}${depth !== null ? ` (depth ${depth})` : ''}`
    }
    case 'settings.changed':
      return Array.isArray(meta.keys) && meta.keys.length > 0 ? `Changed: ${meta.keys.join(', ')}` : 'Settings changed'
    case 'battery.warning':
      return `${String(meta.temperatureC ?? '?')}°C at ${String(meta.level ?? '?')}%`
    case 'input.tap':
      return `at (${String(meta.x ?? '?')}, ${String(meta.y ?? '?')})`
    case 'input.swipe': {
      const from = meta.from as { x?: number; y?: number } | undefined
      const to = meta.to as { x?: number; y?: number } | undefined
      return `(${from?.x ?? '?'}, ${from?.y ?? '?'}) → (${to?.x ?? '?'}, ${to?.y ?? '?'})`
    }
    case 'input.key':
      return meta.name ? `${String(meta.name)} (${String(meta.keycode)})` : `keycode ${String(meta.keycode ?? '?')}`
    case 'input.text':
      // Never renders the literal text unless the device opted in — the
      // server already redacted it by default (plan 18 §3.4).
      return meta.text !== undefined ? `"${String(meta.text)}"` : `text (${String(meta.length ?? '?')} chars)`
    case 'adb.endpoint.opened':
      return `Port ${String(meta.port ?? '?')}`
    case 'adb.endpoint.closed':
      return meta.reason ? `Reason: ${String(meta.reason)}` : 'Endpoint closed'
    case 'adb.open':
      // Already redacted server-side (plan 27 §3.6) — same log-hygiene pass
      // as `shell.exec` (plan 26 §3.3), never a security control.
      return String(meta.service ?? '?')
    case 'app.crashed': {
      // plan 37 §4.2, §4.5 — the parser's CrashEvent shape, mirrored in the meta.
      const label = meta.kind === 'anr' ? 'ANR' : String(meta.exception ?? 'crash')
      const suffix = meta.jobId ? ` (job ${String(meta.jobId).slice(0, 8)})` : ''
      return `${String(meta.package ?? '?')} — ${label}${suffix}`
    }
    default:
      return ev.kind
  }
}

interface Slot {
  events: DeviceEvent[]
  nextCursor: string | null
  loaded: boolean
  loadingMore: boolean
  error: string | null
  paused: boolean
  pending: DeviceEvent[]
}

const emptySlot = (): Slot => ({ events: [], nextCursor: null, loaded: false, loadingMore: false, error: null, paused: false, pending: [] })

function EventRow({ ev, now }: { ev: DeviceEvent; now: number }) {
  const [open, setOpen] = useState(false)
  const hasMeta = ev.meta !== null && Object.keys(ev.meta).length > 0
  return (
    <div className="border-b px-3.5 py-2 text-[12.5px] last:border-b-0">
      <div className="flex items-start gap-2.5">
        <span className="readout mt-0.5 w-14 shrink-0 text-[11px] text-fg-subtle">{relativeTime(ev.at, now)}</span>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium leading-none whitespace-nowrap',
            KIND_TONE[ev.kind] ?? DEFAULT_TONE,
          )}
        >
          {KIND_LABEL[ev.kind] ?? ev.kind}
        </span>
        <span className="min-w-0 flex-1 truncate">{summarize(ev)}</span>
        {ev.actor && <span className="readout shrink-0 text-[11px] text-fg-subtle">{ev.actor}</span>}
        {hasMeta && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-fg-subtle hover:text-fg"
            aria-label={open ? 'Hide details' : 'Show details'}
          >
            {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          </button>
        )}
      </div>
      {open && hasMeta && (
        <pre className="readout mt-2 ml-[4.5rem] overflow-x-auto rounded-md bg-surface-2 p-2 text-[11px] leading-relaxed text-fg-muted">
          {JSON.stringify(ev.meta, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function DeviceLog({ deviceId, deviceOffline }: { deviceId: string; deviceOffline: boolean }) {
  const [active, setActive] = useState<DeviceEventStream>('main')
  const [slots, setSlots] = useState<Record<DeviceEventStream, Slot>>({ main: emptySlot(), input: emptySlot() })
  const now = useNow()
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadPage = useCallback((stream: DeviceEventStream, cursor: string | null) => {
    setSlots((s) => ({ ...s, [stream]: { ...s[stream], loadingMore: cursor !== null, error: null } }))
    const qs = new URLSearchParams({ stream, limit: String(PAGE_SIZE) })
    if (cursor !== null) qs.set('cursor', cursor)
    // Adopts the plan 30 §3.3 envelope (`items`/`nextCursor`) — this view
    // keeps its own scroll-triggered paging rather than PaginatedTable's
    // load-more button, since a log is read top-to-bottom, not paged.
    void api(`/api/devices/${deviceId}/events?${qs.toString()}`, DeviceEventsResponseSchema)
      .then((body) => {
        setSlots((s) => {
          const prev = s[stream]
          const merged = cursor === null ? body.items : [...prev.events, ...body.items]
          return { ...s, [stream]: { ...prev, events: merged.slice(0, MAX_ROWS), nextCursor: body.nextCursor, loaded: true, loadingMore: false } }
        })
      })
      .catch((err) => {
        setSlots((s) => ({
          ...s,
          [stream]: { ...s[stream], loaded: true, loadingMore: false, error: err instanceof Error ? err.message : String(err) },
        }))
      })
  }, [deviceId])

  // Both streams subscribe and load on mount, so switching the segmented
  // control is instant and neither one misses a live event while unselected
  // (plan 18 §4.7).
  useEffect(() => {
    setSlots({ main: emptySlot(), input: emptySlot() })
    loadPage('main', null)
    loadPage('input', null)

    const subscribe = () => ws.send({ type: 'log.subscribe', payload: { deviceId, streams: ['main', 'input'] } })
    subscribe()
    const offReconnect = ws.onReconnected(subscribe)

    const off = ws.on((msg) => {
      if (msg.type !== 'device.event' || msg.payload.deviceId !== deviceId) return
      const ev = msg.payload
      setSlots((s) => {
        const slot = s[ev.stream]
        if (slot.paused) return { ...s, [ev.stream]: { ...slot, pending: [ev, ...slot.pending] } }
        return { ...s, [ev.stream]: { ...slot, events: [ev, ...slot.events].slice(0, MAX_ROWS) } }
      })
    })

    return () => {
      off()
      offReconnect()
      ws.send({ type: 'log.unsubscribe', payload: { deviceId } })
    }
  }, [deviceId, loadPage])

  const slot = slots[active]

  function togglePause() {
    setSlots((s) => {
      const cur = s[active]
      if (cur.paused) {
        // Resuming: fold whatever arrived while paused back into the top.
        return { ...s, [active]: { ...cur, paused: false, pending: [], events: [...cur.pending, ...cur.events].slice(0, MAX_ROWS) } }
      }
      return { ...s, [active]: { ...cur, paused: true } }
    })
  }

  function onScroll() {
    const el = scrollRef.current
    if (!el || slot.loadingMore || slot.nextCursor === null) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) loadPage(active, slot.nextCursor)
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="Log stream">
          {STREAMS.map((s) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={active === s.key}
              onClick={() => setActive(s.key)}
              className={cn(
                'rounded-[5px] px-3 py-1 text-[12.5px] font-medium transition-colors',
                active === s.key ? 'bg-surface-2 text-fg shadow-xs' : 'text-fg-muted hover:text-fg',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {slot.paused && slot.pending.length > 0 && (
            <button
              type="button"
              onClick={togglePause}
              className="readout rounded-full border border-led-active/35 bg-led-active/10 px-2 py-0.5 text-[11px] text-led-active"
            >
              {slot.pending.length} new event{slot.pending.length === 1 ? '' : 's'}
            </button>
          )}
          <Button variant="outline" size="sm" onClick={togglePause}>
            {slot.paused ? (
              <>
                <Play className="size-3.5" aria-hidden />
                Resume
              </>
            ) : (
              <>
                <Pause className="size-3.5" aria-hidden />
                Pause
              </>
            )}
          </Button>
        </div>
      </div>

      {!slot.loaded ? (
        <LoadingRows rows={5} />
      ) : slot.error ? (
        <ErrorState message={slot.error} onRetry={() => loadPage(active, null)} />
      ) : slot.events.length === 0 ? (
        <EmptyState
          title={`No ${active} events yet`}
          description={
            active === 'main'
              ? deviceOffline
                ? 'This device has no recorded lifecycle history — connect it to start one.'
                : 'Connecting, taking control, and running jobs will appear here as they happen.'
              : 'Taps, swipes, key presses, and typed text will appear here as they are sent to the device.'
          }
        />
      ) : (
        <div ref={scrollRef} onScroll={onScroll} className="max-h-[32rem] overflow-y-auto rounded-lg border">
          {slot.events.map((ev) => (
            <EventRow key={ev.id} ev={ev} now={now} />
          ))}
          {slot.loadingMore && (
            <div className="px-3.5 py-2">
              <LoadingRows rows={1} />
            </div>
          )}
          {slot.nextCursor === null && (
            <div className="px-3.5 py-2 text-center text-[11px] text-fg-subtle">Beginning of the log</div>
          )}
        </div>
      )}
    </div>
  )
}
