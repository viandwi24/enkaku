'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { DeviceEventsResponseSchema, type DeviceEvent } from '@enkaku/protocol'
import { api, relativeTime, EmptyState, ErrorState, LoadingRows, cn } from '@enkaku/ui'
import { jobHref } from '@/components/jobs/job-view'
import { ws, coreBase } from '@/lib/ws'
import { useNow } from '@/lib/useNow'

/** A bounded window, same reasoning as `DeviceLog` (plan 18 §8 risks). */
const MAX_ROWS = 200

interface CrashMeta {
  kind: 'crash' | 'anr'
  package: string
  process: string
  exception: string
  message: string
  system: boolean
  truncated: boolean
  artifactId?: string
  jobId?: string
}

function metaOf(ev: DeviceEvent): CrashMeta | null {
  const m = ev.meta as Partial<CrashMeta> | null
  if (!m || typeof m.package !== 'string') return null
  return {
    kind: m.kind === 'anr' ? 'anr' : 'crash',
    package: m.package,
    process: typeof m.process === 'string' ? m.process : m.package,
    exception: typeof m.exception === 'string' ? m.exception : '',
    message: typeof m.message === 'string' ? m.message : '',
    system: m.system === true,
    truncated: m.truncated === true,
    ...(typeof m.artifactId === 'string' ? { artifactId: m.artifactId } : {}),
    ...(typeof m.jobId === 'string' ? { jobId: m.jobId } : {}),
  }
}

function CrashRow({ ev, now }: { ev: DeviceEvent; now: number }) {
  const [open, setOpen] = useState(false)
  const meta = metaOf(ev)
  if (!meta) return null

  return (
    <div className="border-b px-3.5 py-2.5 text-[12.5px] last:border-b-0">
      <div className="flex items-start gap-2.5">
        <span className="readout mt-0.5 w-14 shrink-0 text-[11px] text-fg-subtle">{relativeTime(ev.at, now)}</span>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium uppercase leading-none',
            meta.kind === 'anr' ? 'border-led-warn/40 bg-led-warn/10 text-led-warn' : 'border-led-danger/40 bg-led-danger/10 text-led-danger',
          )}
        >
          {meta.kind}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{meta.package}</p>
          <p className="truncate text-fg-muted">{meta.kind === 'anr' ? meta.message : meta.exception}</p>
        </div>
        {meta.system && (
          <span className="readout shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-subtle">system</span>
        )}
        {meta.jobId && (
          <Link href={jobHref(meta.jobId)} className="readout shrink-0 text-[11px] text-accent hover:underline">
            job {meta.jobId.slice(0, 8)}
          </Link>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-fg-subtle hover:text-fg"
          aria-label={open ? 'Hide details' : 'Show details'}
        >
          {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        </button>
      </div>
      {open && (
        <div className="mt-2 ml-[4.5rem] space-y-1.5">
          <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-[11.5px]">
            <dt className="text-fg-subtle">Process</dt>
            <dd className="readout truncate">{meta.process}</dd>
            {meta.kind === 'crash' && (
              <>
                <dt className="text-fg-subtle">Exception</dt>
                <dd className="readout truncate">{meta.exception}</dd>
                <dt className="text-fg-subtle">Message</dt>
                <dd className="break-words">{meta.message || '—'}</dd>
              </>
            )}
            {meta.kind === 'anr' && (
              <>
                <dt className="text-fg-subtle">Reason</dt>
                <dd className="break-words">{meta.message || '—'}</dd>
              </>
            )}
          </dl>
          {meta.truncated && (
            <p className="text-[11px] text-led-warn">The trace was capped at 200 lines — it never found a natural end.</p>
          )}
          {meta.artifactId && (
            <a
              href={`${coreBase()}/api/artifacts/${meta.artifactId}/content`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
            >
              <ExternalLink className="size-3" aria-hidden />
              View full trace
            </a>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The Crashes panel (plan 37 §4.5) — recent `app.crashed` main-stream device
 * events, live-updated. Beside the Monitor tab: the crash watcher is always
 * on (plan 37 §3.3), so this is the record of what it caught, not another
 * raw log feed.
 */
export function CrashesPanel({ deviceId }: { deviceId: string }) {
  const [events, setEvents] = useState<DeviceEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()

  const load = () => {
    setError(null)
    void api(`/api/devices/${deviceId}/events?stream=main&kind=app.crashed&limit=${MAX_ROWS}`, DeviceEventsResponseSchema)
      .then((body) => setEvents(body.items))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(() => {
    setEvents(null)
    load()

    // Reuses the SAME subscription channel the Logs tab uses (plan 18
    // §3.6) — the server has no separate "crashes only" subscription, so
    // this just filters the main stream client-side for one kind.
    const subscribe = () => ws.send({ type: 'log.subscribe', payload: { deviceId, streams: ['main'] } })
    subscribe()
    const offReconnect = ws.onReconnected(subscribe)
    const off = ws.on((msg) => {
      if (msg.type !== 'device.event' || msg.payload.deviceId !== deviceId) return
      if (msg.payload.stream !== 'main' || msg.payload.kind !== 'app.crashed') return
      setEvents((prev) => [msg.payload, ...(prev ?? [])].slice(0, MAX_ROWS))
    })

    return () => {
      off()
      offReconnect()
      ws.send({ type: 'log.unsubscribe', payload: { deviceId } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  return (
    <div className="px-5 py-4">
      {events === null ? (
        <LoadingRows rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : events.length === 0 ? (
        <EmptyState
          title="No crashes recorded"
          description="Detection runs whenever this device has an active session, independent of jobs — an app crash or ANR will show up here within a few seconds, whether or not a job is running."
        />
      ) : (
        <div className="max-h-[32rem] overflow-y-auto rounded-lg border">
          {events.map((ev) => (
            <CrashRow key={ev.id} ev={ev} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
