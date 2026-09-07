import type { ArtifactInfo, JobDetail, JobRunInfo, JobTraceEvent, UiNode } from '@enkaku/protocol'
import type { ZipEntryInput } from '../../api/zip-stream'

/**
 * The debug bundle (`GET /api/jobs/:id/runs/:runId/export.zip`) — one run's
 * whole story as a zip somebody who was never near this farm can open and
 * read.
 *
 * The Timeline tab already answers "what did this run do", but only to a
 * person sitting in front of it: the frames are behind authenticated URLs,
 * the UI trees are gzipped under `<dataDir>/traces/`, and the events are a
 * paginated table. Handing that to a colleague, a bug report or an issue
 * tracker meant screenshotting a screen. This module turns the same three
 * sources — `job_events`, the trace file store, and the `artifacts` rows —
 * into a directory tree:
 *
 * ```
 * README.md          what this is and how to read it, in prose
 * manifest.json      the machine-readable index (job, run, counts, hash → path)
 * timeline.md        every event as one line of text, oldest first
 * timeline.json      the same events verbatim, as `job_events` stored them
 * logs.txt           the run's log lines
 * params.json        the input snapshot
 * result.json        what the run returned, with its result status
 * frames/0007-tap.png        the screenshot captured for event 7
 * ui/0007-tap.json           the UI tree captured for event 7, gunzipped
 * artifacts/0001-shot.png    the files the run itself saved
 * ```
 *
 * Three rules this file exists to hold:
 *
 * 1. **A bundle is never a lie by omission.** Every gap is written down where
 *    the reader will be: a frame the policy skipped, an event page that hit
 *    the ceiling, an artifact whose file is gone, a UI snapshot too corrupt
 *    to parse. A missing file that is not mentioned reads as "nothing
 *    happened here", which is the one thing a debugging artefact must not
 *    say — the same rule `JobTraceEventSchema.frameStatus` already states for
 *    the live timeline.
 * 2. **The store's de-duplication survives the export.** Frames are
 *    content-addressed (`frame-store.ts`), so two actions on an unchanged
 *    screen name ONE file. The bundle keeps that: the file is named after the
 *    first event that referenced it, and `manifest.json`'s `frames` map plus
 *    `timeline.md`'s own column resolve any later event onto the same path.
 *    Copying the bytes per event would multiply a hundred-action run's
 *    archive for no information.
 * 3. **Nothing is read eagerly.** Every entry's `open()` is called by the zip
 *    writer one at a time, in order, so a run with 200 frames costs one frame
 *    of memory rather than 200 — `zip-stream.ts` is built around exactly that
 *    and this module must not undo it.
 *
 * On secrets: the timeline is already redacted at the point it was WRITTEN —
 * `type`/`clipboard.set` arguments are replaced wholesale by `{ length: n }`
 * (`@enkaku/session`'s `ARG_REDACTION`, plan 128 §4.4) and log lines pass the
 * kv secret redactor (plan 79 §4.7). `params.json` and `result.json` are not:
 * they are the job's own input and output, verbatim, exactly as the Inputs
 * and Output tabs already show them. The README says so in as many words,
 * because a bundle is made to be sent to somebody.
 */

/** Bumped when the LAYOUT changes — a reader (or a future importer) checks this, not the farm's version. */
export const RUN_EXPORT_VERSION = 1

/**
 * The ceiling on how many trace events one bundle carries. A run cannot
 * normally approach it (a long script records a few thousand), but
 * `job_events` is append-only and unbounded by design, and an export that
 * tried to hold every row of a pathological run would build its whole
 * timeline in memory. Truncation is recorded in the manifest AND at the top
 * of both timeline files, per rule 1 above.
 */
export const MAX_EXPORT_EVENTS = 50_000

/**
 * UI trees are stored gzipped and shipped plain, so their declared size —
 * which feeds `createZipStream`'s pre-flight `maxArchiveBytes` refusal — has
 * to be guessed from the compressed size. Gzipped JSON of a UI tree runs
 * roughly 10× smaller than its source; guessing HIGH is the safe direction
 * (the archive is refused before the first byte rather than overrunning the
 * cap mid-stream), which is why this is an over-estimate and not an average.
 */
export const UI_TREE_INFLATION = 10

const encoder = new TextEncoder()

/** One artifact row, with its on-disk location already resolved and traversal-checked by the caller. */
export interface ExportArtifact {
  info: ArtifactInfo
  /** Absolute path, or null when the row points outside app-data or the file is gone — recorded as missing rather than dropped. */
  abs: string | null
  /** Real on-disk size; 0 when `abs` is null. */
  sizeBytes: number
}

export interface RunExportSources {
  job: JobDetail
  run: JobRunInfo
  /** The run's returned value and its verdict — `GET /:id/runs/:runId`'s own three extra fields. */
  result: { value: unknown; bytes: number | null; status: string | null; issues: unknown }
  /** Every trace event for this run, oldest first, already capped at {@link MAX_EXPORT_EVENTS}. */
  events: JobTraceEvent[]
  /** True when the run recorded more events than `events` holds. */
  eventsTruncated: boolean
  artifacts: ExportArtifact[]
  /** Log lines, and where they came from — the trace is the persisted record; the live buffer is the fallback for a run whose trace holds none. */
  logs: { lines: Array<{ ts: number; level: string; source: string; msg: string; fields?: unknown }>; source: 'trace' | 'buffer' | 'none' }
  /** The device's operator-facing name, when it is still known. */
  deviceLabel: string | null
  /** Opens one frame by content hash — `null` when the file is gone. */
  openFrame: (hash: string) => { size: number; stream: () => ReadableStream<Uint8Array> } | null
  /** Reads and gunzips one UI tree by content hash. Rejects, or resolves null, for a snapshot that is gone or unreadable. */
  readUiTree: (hash: string) => Promise<UiNode | null>
  /** The compressed on-disk size of one UI snapshot, for the pre-flight estimate only. 0 when unknown. */
  uiTreeSize: (hash: string) => number
  /** Injectable for tests; the moment the bundle was built. */
  now?: () => number
}

/**
 * A capture the timeline expected and did not get, resolved to one sentence
 * (rule 1). The last case is the one that is easy to miss: an event whose
 * frame was captured perfectly well — `frameStatus: 'ok'` — but whose file
 * the retention sweep has since removed. Saying nothing there would print a
 * successful action with no screenshot and no reason, which reads as a bug in
 * the exporter rather than as a swept file.
 */
function frameNote(event: JobTraceEvent): string | null {
  switch (event.frameStatus) {
    case 'skipped-policy':
      return 'no frame — the capture policy did not ask for one here'
    case 'skipped-busy':
      return 'no frame — a capture was already in flight'
    case 'failed':
      return 'no frame — the capture was attempted and failed'
    default:
      return event.frameHash ? 'no frame — it was captured, but is no longer on disk' : null
  }
}

/** `1 234 ms` after the run's first event, as `m:ss.mmm` — the axis `timeline.md` reads on. */
export function offsetLabel(atMs: number, originMs: number): string {
  const delta = Math.max(0, atMs - originMs)
  const ms = delta % 1000
  const totalSec = Math.floor(delta / 1000)
  const sec = totalSec % 60
  const min = Math.floor(totalSec / 60)
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/**
 * A trace event's own name turned into a filename fragment: lowercase, no
 * separator, no dot. `zip-stream.ts` sanitises entry names again on the way
 * in — this is not the security boundary, it is what keeps `app.launch` from
 * reading as a file extension.
 */
export function safeNamePart(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return cleaned.length > 0 ? cleaned : 'event'
}

/** A stream of already-known bytes — for the text files this module composes itself. */
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

/**
 * A stream whose bytes are produced when the writer asks for them (rule 3),
 * and which NEVER errors: a read that throws becomes a JSON placeholder in
 * the bundle instead. Erroring here would abort the zip mid-download and cost
 * the reader every entry after this one — a corrupt UI snapshot must cost its
 * own file, not the bundle.
 */
function lazyStream(load: () => Promise<Uint8Array | null>, whenMissing: (err: string | null) => Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(c) {
      let bytes: Uint8Array | null = null
      let failure: string | null = null
      try {
        bytes = await load()
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
      }
      c.enqueue(bytes ?? whenMissing(failure))
      c.close()
    },
  })
}

function json(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
}

/** What one event contributes to the bundle's file tree, resolved once and reused by every writer below. */
interface ResolvedEvent {
  event: JobTraceEvent
  /** The frame's path in the bundle, or null when this event has none. Shared with any earlier event of the same hash. */
  framePath: string | null
  uiPath: string | null
}

/** One frame's place in the bundle, plus the handle that was opened to prove it exists — opened ONCE per hash, not once per event naming it. */
interface ResolvedFrame {
  path: string
  handle: { size: number; stream: () => ReadableStream<Uint8Array> }
}

/**
 * Walks the events once and decides every path in the bundle. The Map keyed
 * on content hash is rule 2: the FIRST event to name a hash owns the file,
 * and every later event pointing at the same screen resolves to that same
 * path rather than a copy of it.
 */
function resolveEvents(events: JobTraceEvent[], sources: RunExportSources): { resolved: ResolvedEvent[]; frames: Map<string, ResolvedFrame>; uiTrees: Map<string, string> } {
  const frames = new Map<string, ResolvedFrame>()
  const uiTrees = new Map<string, string>()
  const resolved: ResolvedEvent[] = []

  for (const event of events) {
    const stem = `${String(event.seq).padStart(5, '0')}-${safeNamePart(event.name)}`
    let framePath: string | null = null
    if (event.frameHash) {
      const known = frames.get(event.frameHash)
      if (known) framePath = known.path
      else {
        // The one `openFrame` call per HASH — a hundred taps on one unchanged
        // screen must cost one stat, not a hundred (and the handle it returns
        // is what the entry below streams, so it is never opened twice).
        const handle = sources.openFrame(event.frameHash)
        if (handle) {
          framePath = `frames/${stem}.png`
          frames.set(event.frameHash, { path: framePath, handle })
        }
      }
    }
    let uiPath: string | null = null
    if (event.uiHash) {
      const known = uiTrees.get(event.uiHash)
      if (known) uiPath = known
      else {
        uiPath = `ui/${stem}.json`
        uiTrees.set(event.uiHash, uiPath)
      }
    }
    resolved.push({ event, framePath, uiPath })
  }

  return { resolved, frames, uiTrees }
}

/** One event as a line of `timeline.md`. */
function timelineLine(item: ResolvedEvent, originMs: number): string {
  const { event } = item
  const parts = [offsetLabel(event.atMs, originMs), event.kind.padEnd(8), event.name]
  if (event.durationMs !== null) parts.push(`${event.durationMs} ms`)
  if (event.ok === true) parts.push('ok')
  if (event.ok === false) parts.push(`FAILED${event.errorCode ? ` ${event.errorCode}` : ''}`)
  if (event.phase) parts.push(`phase=${event.phase}`)
  if (event.kind === 'log' && typeof event.meta?.msg === 'string') parts.push(JSON.stringify(event.meta.msg))
  if (event.kind === 'action' && event.meta?.args !== undefined) parts.push(`args=${JSON.stringify(event.meta.args)}`)
  if (item.framePath) parts.push(`→ ${item.framePath}`)
  else {
    const note = frameNote(event)
    if (note) parts.push(`(${note})`)
  }
  if (item.uiPath) parts.push(`→ ${item.uiPath}`)
  return `- ${parts.join('  ')}`
}

function buildTimelineMarkdown(sources: RunExportSources, resolved: ResolvedEvent[], originMs: number): Uint8Array {
  const { job, run } = sources
  const head = [
    `# Timeline — ${job.scriptName ?? job.jobId} · run ${run.seq}`,
    '',
    `Status: **${run.status}**${run.error ? ` — ${run.error}` : ''}`,
    `Device: ${sources.deviceLabel ?? run.deviceId}`,
    `Events: ${resolved.length}${sources.eventsTruncated ? ` (TRUNCATED at ${MAX_EXPORT_EVENTS} — the run recorded more)` : ''}`,
    '',
    'Times are offsets from the first recorded event, as `mm:ss.mmm`.',
    '',
  ]
  if (resolved.length === 0) {
    head.push(
      'Nothing was recorded for this run. A run from before job tracing existed, a workflow job (whose steps',
      'each have their own trace), or a run whose trace the retention window has already swept, has no timeline.',
    )
    return encoder.encode(`${head.join('\n')}\n`)
  }
  const lines = resolved.map((item) => timelineLine(item, originMs))
  return encoder.encode(`${[...head, ...lines].join('\n')}\n`)
}

function buildLogsText(sources: RunExportSources): Uint8Array {
  const { lines, source } = sources.logs
  if (lines.length === 0) {
    const why =
      source === 'none'
        ? 'This run recorded no log lines. A script that never calls ctx.log has none; so does a run whose\ntrace and log buffer have both been swept by the retention window.'
        : 'No log lines were available when this bundle was built.'
    return encoder.encode(`${why}\n`)
  }
  const header = source === 'buffer' ? '# Source: the live log buffer (this run has no log lines in its trace).\n' : '# Source: the run trace.\n'
  const body = lines
    .map((l) => {
      const at = new Date(l.ts).toISOString()
      const fields = l.fields && Object.keys(l.fields as Record<string, unknown>).length > 0 ? ` ${JSON.stringify(l.fields)}` : ''
      return `${at}  ${l.level.padEnd(5)} ${l.source.padEnd(8)} ${l.msg}${fields}`
    })
    .join('\n')
  return encoder.encode(`${header}${body}\n`)
}

function buildReadme(sources: RunExportSources, resolved: ResolvedEvent[], frameCount: number, uiCount: number): Uint8Array {
  const { job, run } = sources
  const missingArtifacts = sources.artifacts.filter((a) => a.abs === null).length
  const lines = [
    `# Debug bundle — ${job.scriptName ?? job.jobId}, run ${run.seq}`,
    '',
    `Exported from Enkaku on ${new Date((sources.now ?? Date.now)()).toISOString()}. Bundle layout version ${RUN_EXPORT_VERSION}.`,
    '',
    'This is one run of one job, packaged so somebody without access to the farm can read it.',
    '',
    '## Start here',
    '',
    '- **`timeline.md`** — every recorded event on one time axis, oldest first. Each line points at the',
    '  screenshot and UI tree captured for it, so you can follow a run the way the operator would.',
    '- **`manifest.json`** — the same thing for a machine: the job, the run, every count, and the map from a',
    '  content hash to the file it was written to.',
    '',
    '## Everything in here',
    '',
    '| Path | What it is |',
    '| --- | --- |',
    '| `timeline.md` | The run as prose lines. Start here. |',
    '| `timeline.json` | The same events, verbatim, exactly as they were stored. |',
    '| `logs.txt` | The run\'s log lines. |',
    '| `params.json` | The input the job was created with. |',
    '| `result.json` | What the run returned, plus whether it satisfied the script\'s result schema. |',
    '| `frames/` | Screenshots captured during the run, named `<event seq>-<action>.png`. |',
    '| `ui/` | UI tree snapshots, gunzipped to plain JSON, named to match the frame beside them. |',
    '| `artifacts/` | The files the run itself saved — including its own full `job.log`. |',
    '',
    '## What this bundle does not have',
    '',
    `- Screenshots exist only where the capture policy asked for one. ${frameCount} frame${frameCount === 1 ? '' : 's'} and ${uiCount} UI tree${uiCount === 1 ? '' : 's'} are included; every event without one says why on its own line in \`timeline.md\`.`,
    '- Frames are de-duplicated by content: two actions on an unchanged screen point at the same file. That is',
    '  the store\'s own behaviour, kept rather than undone.',
  ]
  if (sources.eventsTruncated) {
    lines.push(
      `- **This timeline is incomplete.** Only the first ${resolved.length.toLocaleString()} events were exported; the run recorded more than one`,
      '  bundle carries. What you see ends early, and it is not where the run stopped.',
    )
  }
  if (missingArtifacts > 0) {
    lines.push(
      `- ${missingArtifacts} artifact${missingArtifacts === 1 ? ' is' : 's are'} listed in \`manifest.json\` but not in \`artifacts/\`: the file is no longer on disk.`,
    )
  }
  if (run.status === 'running' || run.status === 'queued') {
    lines.push(`- **This run was still ${run.status} when the bundle was built.** It is a snapshot of an unfinished run.`)
  }
  lines.push(
    '',
    '## Before you send this on',
    '',
    'Typed text and clipboard writes were already redacted when the timeline was recorded — they appear as a',
    'length, never as characters — and log lines went through the farm\'s secret redactor. `params.json` and',
    '`result.json` were not: they are this job\'s own input and output, verbatim. Read them before sharing a',
    'bundle from a job whose parameters carry a credential.',
    '',
  )
  return encoder.encode(`${lines.join('\n')}\n`)
}

/**
 * Every file the bundle holds, in the order a reader meets them: the prose
 * first, then the data, then the captures. `open()` is lazy throughout — see
 * rule 3 on this module.
 */
export function buildRunExportEntries(sources: RunExportSources): ZipEntryInput[] {
  const { resolved, frames, uiTrees } = resolveEvents(sources.events, sources)
  const originMs = sources.events[0]?.atMs ?? 0
  const now = (sources.now ?? Date.now)()

  const manifest = {
    bundleVersion: RUN_EXPORT_VERSION,
    exportedAt: Math.floor(now / 1000),
    job: sources.job,
    run: sources.run,
    device: { id: sources.run.deviceId, label: sources.deviceLabel },
    result: { value: sources.result.value, bytes: sources.result.bytes, status: sources.result.status, issues: sources.result.issues },
    counts: {
      events: sources.events.length,
      eventsTruncated: sources.eventsTruncated,
      maxEvents: MAX_EXPORT_EVENTS,
      frames: frames.size,
      uiTrees: uiTrees.size,
      artifacts: sources.artifacts.length,
      artifactsMissing: sources.artifacts.filter((a) => a.abs === null).length,
      logLines: sources.logs.lines.length,
    },
    logs: { source: sources.logs.source },
    // Rule 2 — how any event's `frameHash`/`uiHash` resolves onto a path in
    // this bundle, including the later events that share an earlier one's file.
    frames: Object.fromEntries([...frames].map(([hash, f]) => [hash, f.path])),
    uiTrees: Object.fromEntries(uiTrees),
    artifacts: sources.artifacts.map((a) => ({
      id: a.info.id,
      kind: a.info.kind,
      label: a.info.label,
      sizeBytes: a.sizeBytes,
      createdAt: a.info.createdAt,
      path: a.abs ? `artifacts/${a.info.path.split('/').pop()}` : null,
      missing: a.abs === null,
    })),
  }

  const readme = buildReadme(sources, resolved, frames.size, uiTrees.size)
  const timelineMd = buildTimelineMarkdown(sources, resolved, originMs)
  const timelineJson = json({
    bundleVersion: RUN_EXPORT_VERSION,
    runId: sources.run.runId,
    jobId: sources.run.jobId,
    originMs,
    truncated: sources.eventsTruncated,
    events: sources.events,
  })
  const logsTxt = buildLogsText(sources)
  // Serialised now, not inside `open()`, so every text entry DECLARES its real
  // length: `createZipStream`'s pre-flight `maxArchiveBytes` refusal reads
  // these, and a `size: 0` here would quietly exempt the bundle's own prose
  // from the cap it is supposed to be checked against. These are values
  // already in memory (the job row, its params, the run's result), so this
  // buys accuracy at no cost — unlike the frames and UI trees below, which is
  // exactly why those stay lazy (rule 3).
  const manifestJson = json(manifest)
  const paramsJson = json(sources.job.params)
  const resultJson = json({ status: sources.result.status, bytes: sources.result.bytes, issues: sources.result.issues, value: sources.result.value })

  const entries: ZipEntryInput[] = [
    { name: 'README.md', size: readme.length, open: () => bytesStream(readme) },
    { name: 'manifest.json', size: manifestJson.length, open: () => bytesStream(manifestJson) },
    { name: 'timeline.md', size: timelineMd.length, open: () => bytesStream(timelineMd) },
    { name: 'timeline.json', size: timelineJson.length, open: () => bytesStream(timelineJson) },
    { name: 'logs.txt', size: logsTxt.length, open: () => bytesStream(logsTxt) },
    { name: 'params.json', size: paramsJson.length, open: () => bytesStream(paramsJson) },
    { name: 'result.json', size: resultJson.length, open: () => bytesStream(resultJson) },
  ]

  for (const { path, handle } of frames.values()) {
    entries.push({ name: path, size: handle.size, open: () => handle.stream() })
  }

  for (const [hash, path] of uiTrees) {
    entries.push({
      name: path,
      // A gunzipped tree, declared from its compressed size — see UI_TREE_INFLATION.
      size: sources.uiTreeSize(hash) * UI_TREE_INFLATION,
      open: () =>
        lazyStream(
          async () => {
            const node = await sources.readUiTree(hash)
            return node ? json(node) : null
          },
          (err) => json({ error: err ?? 'this ui snapshot is no longer on disk', uiHash: hash }),
        ),
    })
  }

  for (const artifact of sources.artifacts) {
    if (!artifact.abs) continue
    const abs = artifact.abs
    entries.push({
      name: `artifacts/${artifact.info.path.split('/').pop() ?? artifact.info.id}`,
      size: artifact.sizeBytes,
      open: () => Bun.file(abs).stream(),
    })
  }

  return entries
}

/** `enkaku-<script>-<job8>-run<seq>.zip` — what the browser saves it as. */
export function exportFileName(job: JobDetail, run: JobRunInfo): string {
  return `enkaku-${safeNamePart(job.scriptName ?? 'job')}-${job.jobId.slice(0, 8)}-run${run.seq}.zip`
}
