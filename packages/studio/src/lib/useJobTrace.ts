import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { JobTraceEventSchema, type JobTraceEvent } from '@enkaku/protocol'
import { fetchPagesDetailed } from './api'
import { ws } from './ws'

/**
 * The Timeline tab's data layer (plan 128 §4.6, step 128.8) — fetch, then
 * subscribe, mirroring `use-job-detail.ts`: `/ws` has no snapshot replay, so
 * a tab opened mid-run would otherwise show only whatever happened after it
 * subscribed.
 *
 * **Everything here sorts by `(atMs, seq)`, never by `seq` alone** (plan
 * §4.3, and §10 item 4 — the hole step 128.4's worker found). `seq` is
 * arrival order at the recorder, and an `action` event is held until its
 * screenshot settles while a `log` line emits immediately: an action whose
 * capture took 200 ms reaches the recorder AFTER a log line that happened
 * during it, and is numbered accordingly. So `seq` is the pagination cursor
 * — unique per job, monotonic, stable across a concurrent insert, which is
 * exactly what a cursor must be — and `atMs`, stamped at `begin()`, is the
 * time axis. A timeline ordered by `seq` renders captured actions slightly
 * after their own logs, which is precisely the reading a debugger would draw
 * the wrong conclusion from.
 *
 * The pure helpers below are exported separately from the hook so the
 * ordering rule, the "nearest event" resolution and the capture-policy line
 * are testable without a DOM.
 */

/** `(atMs, seq)` — the display order. See this module's own doc for why `seq` alone is wrong. */
export function compareTraceEvents(a: JobTraceEvent, b: JobTraceEvent): number {
  return a.atMs - b.atMs || a.seq - b.seq
}

/** A stable copy of `events` in display order. Never mutates its argument. */
export function sortTraceEvents(events: readonly JobTraceEvent[]): JobTraceEvent[] {
  return [...events].sort(compareTraceEvents)
}

/**
 * What a `phase` `start` event's `meta` carries (plan 128 §3.4, §10 item 2)
 * — the ONLY honest source for the capture-policy line. It is deliberately
 * not derived from the events' own `frameStatus`: a job that failed in
 * `prepare` has zero action events, and that is exactly the timeline that
 * most needs explaining.
 *
 * `remote: true` is the remote-job bridge's own marker (`daemon.ts`'s three
 * `traceRecorder.record(...)` calls at `createRemoteJobBridge`'s hooks, plan
 * §10 item 6): a node-owned job records phase, log and artifact events and
 * no action events at all, because the tee lives in the local runner.
 *
 * Every field is optional — an older core, or a phase event written before
 * one of them existed, must degrade to a plainer sentence rather than
 * failing to parse.
 */
export const CapturePolicyMetaSchema = z.object({
  inspectorEngineId: z.string().nullable().optional(),
  framePolicy: z.enum(['per-action', 'on-failure', 'none']).optional(),
  remote: z.boolean().optional(),
})
export type CapturePolicyMeta = z.infer<typeof CapturePolicyMetaSchema>

/**
 * The capture policy in force at `index` — the most recent `phase` `start`
 * event at or before the playhead, per plan §3.4. Per phase and not per job
 * on purpose: the `ui-server` watchdog can declare the engine dead mid-run
 * and the session falls back to `uiautomator-dump`, so a single per-job
 * label would average two real policies into one wrong one.
 *
 * `null` when no phase start precedes the playhead (a trace that recorded
 * nothing, or one whose events all sit before its first phase boundary).
 */
export function capturePolicyAt(events: readonly JobTraceEvent[], index: number): CapturePolicyMeta | null {
  for (let i = Math.min(index, events.length - 1); i >= 0; i--) {
    const e = events[i]
    if (!e || e.kind !== 'phase' || e.name !== 'start') continue
    const parsed = CapturePolicyMetaSchema.safeParse(e.meta ?? {})
    return parsed.success ? parsed.data : {}
  }
  return null
}

/** The capture-policy line, in plan §3.4's own words (`Frames: per action (ui-server)`). */
export function describeCapturePolicy(policy: CapturePolicyMeta | null): string {
  if (!policy) return 'Frames: not recorded — this job logged no phase boundary.'
  if (policy.remote) return 'Frames: none — this job ran on a cloud node, which records no device actions here.'
  const engine = policy.inspectorEngineId
  if (policy.framePolicy === 'per-action') return `Frames: per action (${engine ?? 'unknown engine'})`
  if (policy.framePolicy === 'on-failure') return `Frames: on failure only (${engine ?? 'unknown engine'})`
  if (policy.framePolicy === 'none') return engine ? `Frames: off (${engine})` : 'Frames: off — no inspector was available.'
  return 'Frames: not recorded for this phase.'
}

/**
 * Why the action lane is empty, in words — never a blank box (plan §2's own
 * "the UI says so", goal 4, and the brief's item 4). `null` when the lane is
 * not empty and needs no explanation.
 */
export function explainEmptyActionLane(events: readonly JobTraceEvent[], policy: CapturePolicyMeta | null): string | null {
  if (events.some((e) => e.kind === 'action')) return null
  if (policy?.remote) {
    return 'No device actions — this job ran on a cloud node. Its phase, log and artifact events are all here; the action tee lives in the local runner, so a remote job records none.'
  }
  if (events.length === 0) return 'Nothing was recorded for this job.'
  return 'No device actions — this job never reached a script that called the device. Its phase and log events are below.'
}

/**
 * The event nearest `atMs` on the time axis — what a scrubber drag resolves
 * to. Ties go to the EARLIER event (the lower display index), so dragging
 * left and right across a tie is stable rather than flickering.
 */
export function nearestEventIndex(events: readonly JobTraceEvent[], atMs: number): number {
  if (events.length === 0) return -1
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < events.length; i++) {
    const d = Math.abs((events[i]?.atMs ?? 0) - atMs)
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  }
  return best
}

/**
 * The frame to show at the playhead: the selected event's own, or the most
 * recent one before it — a timeline scrubbed onto a log line still shows the
 * screen as it was at that instant, which is the whole point.
 */
export function frameEventAt(events: readonly JobTraceEvent[], index: number): JobTraceEvent | null {
  for (let i = Math.min(index, events.length - 1); i >= 0; i--) {
    const e = events[i]
    if (e?.frameHash) return e
  }
  return null
}

/** The frame BEFORE the one `frameEventAt` resolves to — the "before" half of the before/after toggle (plan §4.6). */
export function previousFrameEventAt(events: readonly JobTraceEvent[], index: number): JobTraceEvent | null {
  const current = frameEventAt(events, index)
  if (!current) return null
  const at = events.indexOf(current)
  return at <= 0 ? null : frameEventAt(events, at - 1)
}

/**
 * Where a failed job's playhead starts (plan §4.6): the first event that
 * actually failed — an `action` with `ok === false`, or an `error` event.
 * `null` when nothing in the trace failed, in which case the playhead starts
 * at the end (the most recent thing that happened).
 */
export function failingEventIndex(events: readonly JobTraceEvent[]): number | null {
  const at = events.findIndex((e) => e.ok === false || e.kind === 'error')
  return at === -1 ? null : at
}

/**
 * Goal 6 — the timeline never silently omits a frame. A capture that was
 * skipped or failed is counted here and stated in the header, so the gap
 * between two thumbnails is always accounted for by a number rather than
 * read as "nothing happened".
 */
export interface FrameStatusCounts {
  ok: number
  'skipped-policy': number
  'skipped-busy': number
  failed: number
}

export function frameStatusCounts(events: readonly JobTraceEvent[]): FrameStatusCounts {
  const counts: FrameStatusCounts = { ok: 0, 'skipped-policy': 0, 'skipped-busy': 0, failed: 0 }
  for (const e of events) {
    if (e.frameStatus) counts[e.frameStatus] += 1
  }
  return counts
}

export interface JobTraceState {
  /** Every recorded event, in `(atMs, seq)` order. */
  events: JobTraceEvent[]
  loading: boolean
  error: string | null
  /**
   * The fetch hit the page ceiling with more still to come, so `events` is a
   * PREFIX of the trace, not the whole of it (plan 128 §10 item 9). Plan goal
   * 6 is that a timeline never omits silently, and a truncated fetch is an
   * omission — so the tab says so rather than rendering a first stretch that
   * looks complete. This is not hypothetical for this feature specifically:
   * §3.4 captures one event per device call with no cap by design, which is
   * exactly the owner's requirement, so a long run genuinely exceeds it.
   */
  truncated: boolean
  reload: () => void
}

/**
 * Fetch-then-subscribe over `GET /api/jobs/:id/trace` + the `job.trace` WS
 * message. Every page is walked (`fetchAllPages`, the same helper the
 * artifacts fetch uses) — `?cursor=` is the opaque `nextCursor` from the
 * previous page, NEVER a bare `seq` integer, which the route refuses with a
 * 400.
 *
 * A failing fetch surfaces as `error`; a job whose core has no trace routes
 * at all answers `[]` rather than 404ing, so an older core degrades to an
 * empty timeline instead of an error banner.
 *
 * Run-scoped since plan 218 §4.3.2: the path and the `job.trace` filter are
 * keyed on `(jobId, runId)`, not `jobId` alone — a job with several runs has
 * a trace per run, and reading the wrong one would show one run's replay
 * under another's header.
 */
export function useJobTrace(jobId: string | null, runId: string | null): JobTraceState {
  const [fetched, setFetched] = useState<JobTraceEvent[] | null>(null)
  const [live, setLive] = useState<JobTraceEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  function load(): void {
    if (!jobId || !runId) return
    setError(null)
    void fetchPagesDetailed(`/api/jobs/${jobId}/runs/${runId}/trace`, undefined, JobTraceEventSchema)
      .then((page) => {
        setFetched(page.items)
        setTruncated(page.truncated)
      })
      .catch((e: unknown) => {
        setFetched([])
        setTruncated(false)
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  useEffect(() => {
    setFetched(null)
    setLive([])
    setError(null)
    setTruncated(false)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, runId])

  useEffect(() => {
    if (!jobId || !runId) return
    const off = ws.on((m) => {
      if (m.type === 'job.trace' && m.payload.runId === runId) {
        setLive((p) => [...p, m.payload.event])
      }
    })
    return off
  }, [jobId, runId])

  // The two sources are merged and de-duplicated by row id, not chosen
  // between: a live event can arrive before the fetch settles (the recorder
  // publishes to `/ws` BEFORE it writes the row, plan §3.6), and a reload
  // mid-run re-reads rows the live tail already delivered.
  const events = useMemo(() => {
    const byId = new Map<string, JobTraceEvent>()
    for (const e of [...(fetched ?? []), ...live]) byId.set(e.id, e)
    return sortTraceEvents([...byId.values()])
  }, [fetched, live])

  return { events, loading: fetched === null, error, truncated, reload: load }
}
