'use client'

import { useEffect, useState } from 'react'
import { UiNodeSchema, type JobTraceEvent, type UiNode } from '@enkaku/protocol'
import { api, cn } from '@enkaku/ui'
import { formatOffset } from './TraceTimeline'

/**
 * The selected event in full (plan 128 §4.6, step 128.8): what it was, when,
 * how long it took, whether it succeeded, its error code, its **already
 * redacted** arguments (`meta.args` — `type` and `clipboard.set` store only a
 * length, plan §4.4), and the UI tree captured beside it.
 *
 * **The tree is rendered here rather than through `InspectorPanel`**, which
 * §4.6 named. That component is a LIVE panel: it attaches an inspector over
 * `/ws`, requires a manual lease on the device, polls, and proposes
 * selectors against a device that is still there. A stored snapshot from a
 * job that finished last week has none of those things, and the only pieces
 * of that file that are exported are pure helpers (`serialiseTree` is a
 * change-detection key, not a rendering). So this reuses `UiNodeSchema` —
 * the same shape a live dump produces, parsed rather than `as`-cast — and
 * draws it read-only. Flagged in the step's own report rather than papered
 * over.
 */

const KIND_TONE: Record<JobTraceEvent['kind'], string> = {
  phase: 'text-accent',
  action: 'text-fg',
  log: 'text-fg-muted',
  artifact: 'text-led-ok',
  progress: 'text-fg-muted',
  assist: 'text-led-warn',
  error: 'text-led-danger',
}

/** `meta.args` is always an object when present; anything else is rendered as-is rather than dropped. */
function argsOf(meta: JobTraceEvent['meta']): unknown {
  if (!meta || typeof meta !== 'object') return undefined
  return (meta as Record<string, unknown>).args
}

function messageOf(meta: JobTraceEvent['meta']): string | null {
  if (!meta || typeof meta !== 'object') return null
  const msg = (meta as Record<string, unknown>).message ?? (meta as Record<string, unknown>).msg
  return typeof msg === 'string' ? msg : null
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function TraceEventDetail({
  jobId,
  event,
  originMs,
}: {
  jobId: string
  event: JobTraceEvent | null
  originMs: number
}) {
  if (!event) {
    return (
      <div className="rounded-lg border bg-surface p-3">
        <h2 className="rack-label mb-2">event</h2>
        <p className="text-[12px] text-fg-subtle">Nothing selected.</p>
      </div>
    )
  }

  const args = argsOf(event.meta)
  const message = messageOf(event.meta)

  return (
    <div className="rounded-lg border bg-surface p-3">
      <h2 className="rack-label mb-2">event</h2>

      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={cn('readout text-[13px] font-medium', KIND_TONE[event.kind])}>
          {event.kind} {event.name}
        </span>
        {event.ok === false && (
          <span className="rounded-full border border-led-danger/40 bg-led-danger/10 px-2 py-0.5 text-[10.5px] text-led-danger">
            failed
          </span>
        )}
        {event.ok === true && (
          <span className="rounded-full border border-led-ok/35 bg-led-ok/10 px-2 py-0.5 text-[10.5px] text-led-ok">ok</span>
        )}
        <span className="readout text-[11px] text-fg-subtle">{formatOffset(event.atMs, originMs)}</span>
      </div>

      <dl className="mt-2.5 space-y-1.5">
        <Row label="phase" value={event.phase ?? '—'} />
        <Row label="attempt" value={String(event.attempt)} />
        <Row label="duration" value={event.durationMs === null ? '—' : `${event.durationMs} ms`} />
        {event.errorCode && <Row label="error code" value={event.errorCode} />}
        {event.nodeId && <Row label="workflow node" value={event.nodeId} />}
        <Row label="seq" value={String(event.seq)} />
      </dl>

      {message && <p className="mt-2 rounded-md border border-led-danger/35 bg-led-danger/5 px-2.5 py-1.5 text-[12px] text-led-danger">{message}</p>}

      {args !== undefined && (
        <div className="mt-2.5">
          <h3 className="rack-label mb-1">arguments</h3>
          <p className="mb-1 text-[11px] text-fg-subtle">
            Recorded already redacted — typed text and clipboard writes store only a length.
          </p>
          <pre className="readout max-h-56 overflow-auto rounded-md border bg-bg p-2 text-[11px] leading-relaxed">{pretty(args)}</pre>
        </div>
      )}

      {event.uiHash && <UiTree jobId={jobId} hash={event.uiHash} />}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className="readout min-w-0 truncate text-[12px]" title={value}>
        {value}
      </dd>
    </div>
  )
}

/**
 * `GET /api/jobs/:id/trace/ui/:hash` — gunzipped by the core and re-validated
 * here through the same `UiNodeSchema` a live dump uses. A snapshot the core
 * reports as CORRUPT (`E_TRACE_CORRUPT`, plan §10's eighth note) surfaces as
 * its own message rather than as "gone": a debugger sent hunting a retention
 * sweep that never ran is worse than being told the file is unreadable.
 */
function UiTree({ jobId, hash }: { jobId: string; hash: string }) {
  const [root, setRoot] = useState<UiNode | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRoot(null)
    setError(null)
    void api(`/api/jobs/${jobId}/trace/ui/${hash}`, UiNodeSchema)
      .then((node) => {
        if (!cancelled) setRoot(node)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [jobId, hash])

  return (
    <div className="mt-2.5">
      <h3 className="rack-label mb-1">ui tree</h3>
      {error ? (
        <p className="text-[11.5px] text-led-warn">{error}</p>
      ) : root ? (
        <div className="max-h-72 overflow-auto rounded-md border bg-bg p-2">
          <UiTreeNode node={root} depth={0} />
        </div>
      ) : (
        <p className="text-[11.5px] text-fg-subtle">Loading the snapshot…</p>
      )}
    </div>
  )
}

function shortClass(className: string): string {
  const idx = className.lastIndexOf('.')
  return idx === -1 ? className : className.slice(idx + 1)
}

function label(node: UiNode): string {
  return node.resourceId.trim() || node.text.trim() || node.desc.trim() || ''
}

function UiTreeNode({ node, depth }: { node: UiNode; depth: number }) {
  const text = label(node)
  return (
    <div style={{ paddingLeft: `${depth * 12}px` }}>
      <p className="readout truncate text-[11px] leading-5">
        <span className="text-fg">{shortClass(node.className) || 'node'}</span>
        {text && <span className="text-accent"> {text}</span>}
        <span className="text-fg-subtle">
          {' '}
          [{node.bounds.left},{node.bounds.top}–{node.bounds.right},{node.bounds.bottom}]
        </span>
      </p>
      {node.children.map((child, i) => (
        <UiTreeNode key={`${depth}-${i}`} node={child} depth={depth + 1} />
      ))}
    </div>
  )
}
