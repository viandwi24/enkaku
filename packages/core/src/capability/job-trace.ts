import { z } from 'zod'
import { JobTraceEventSchema, UiNodeSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { decodeCursor, encodeCursor } from '../api/pagination'
import type { CapabilityContext } from './context'
import { defineCapability } from './types'

/**
 * `job.trace`, `job.trace.ui`, `job.trace.frame` (plan 130 §4.1, step 130.1) — the agent- and
 * MCP-facing read side of the job trace timeline (plan 128). Every handler is a one-line
 * delegation to `ctx.jobTrace` (`context.ts`'s `buildJobTraceService`) — the SAME `job_events`
 * table and the SAME `TraceFrameStore` (`jobs/trace/frame-store.ts`) the REST routes in
 * `api/jobs.ts` already serve this data from. No second implementation of the hash/jobId
 * path-traversal guards, no second permission model: `mcp/server.ts` reads this registry through
 * the same `invoke()` door REST does (plan 63 §4.4's "the third surface reading the one door"),
 * so registering these three here is what makes them reachable from an MCP client too.
 *
 * **§3.2's hard boundary: never more than one frame — or one UI tree — per call.** A capability
 * that returned every frame would put ~8.5 MB of base64 into an agent's context for a single job,
 * which is not debugging, it is a denial of service against the agent's own attention. There is no
 * plural "frames" input anywhere below, on purpose.
 *
 * §9 Q1 (open in the plan) — how `job.trace.frame` hands back an image: it returns the same
 * `{ image: base64, format: 'png' }` shape `device.screenshot` already does
 * (`capability/device-inspect.ts`), and declares the same `imageOutputs` (plan 70 §4.3). That
 * declaration is not decorative — `agent/harness/run.ts`'s `buildToolResultContent` reads it to
 * store the bytes once in the agent blob store and hand the model a real image content block
 * instead of a wall of base64 text, and `registry.ts`'s boot-time check asserts the declared field
 * actually exists on this capability's own output schema. This is the most conservative option
 * available: it reuses a mechanism the codebase already built and already tests, rather than
 * inventing a URL scheme or a second blob API for one new capability.
 */

function assertJobExists(ctx: CapabilityContext, jobId: string): void {
  if (!ctx.jobService.get(jobId)) {
    throw new EnkakuError('job_not_found', `no such job: ${jobId}`)
  }
}

/** `ctx.jobTrace` is optional only so a pre-plan-130 test fixture keeps compiling unedited
 * (`context.ts`'s own comment on the field) — a real host always sets it. Refused by name rather
 * than a bare crash on the rare fixture that omits it, the same `E_NOT_SUPPORTED` pattern
 * `capability/device-network.ts`/`device-state.ts` already use for their own optional deps. */
function requireJobTrace(ctx: CapabilityContext): NonNullable<CapabilityContext['jobTrace']> {
  if (!ctx.jobTrace) throw new EnkakuError('E_NOT_SUPPORTED', 'job trace is not available on this host')
  return ctx.jobTrace
}

export const jobTrace = defineCapability({
  id: 'job.trace',
  input: z.object({
    jobId: z.string(),
    kind: z.array(JobTraceEventSchema.shape.kind).optional(),
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.string().nullable().optional(),
  }),
  output: z.object({ items: z.array(JobTraceEventSchema), nextCursor: z.string().nullable(), total: z.number().int().nonnegative() }),
  permission: 'job.view',
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description:
    "Read one job's timeline: every device action with its arguments, duration and outcome, plus log lines, " +
    'phase boundaries and artifacts, ordered oldest first. Optionally filtered by kind (repeatable — any of ' +
    "the given kinds match). Keyset-paginated via cursor/nextCursor, same convention as job.list. Events carry " +
    'frameHash/uiHash — read those one at a time with job.trace.frame and job.trace.ui. Use this to see WHAT a ' +
    'job did, not just whether it succeeded.',
  handler: (ctx, { jobId, kind, limit, cursor }) => {
    assertJobExists(ctx, jobId)
    const decoded = decodeCursor(cursor ?? null)
    const result = requireJobTrace(ctx).list({ jobId, ...(kind ? { kind } : {}), limit: limit ?? 50, cursor: decoded })
    return Promise.resolve({
      items: result.items,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor.sortValue, result.nextCursor.id) : null,
      total: result.total,
    })
  },
})

export const jobTraceUi = defineCapability({
  id: 'job.trace.ui',
  input: z.object({ jobId: z.string(), uiHash: z.string() }),
  output: UiNodeSchema,
  permission: 'job.view',
  lease: 'none',
  deadline: 10_000,
  effect: 'read',
  description:
    "Read one UI-tree snapshot captured during a job's run, named by the uiHash a job.trace event carries. " +
    'Structured JSON — the same tree the Inspect panel and device.dump return. This is the high-value read for ' +
    'explaining what was actually on screen at that moment, and it is text, so prefer it over job.trace.frame ' +
    'when the question is "what element was there" rather than "what did the screen look like". One tree per call.',
  handler: async (ctx, { jobId, uiHash }) => {
    assertJobExists(ctx, jobId)
    const node = await requireJobTrace(ctx).readUiTree(jobId, uiHash)
    if (!node) throw new EnkakuError('ui_snapshot_not_found', `no such ui snapshot: ${uiHash}`)
    return node
  },
})

const FrameOutput = z.object({ image: z.string(), format: z.literal('png') })

export const jobTraceFrame = defineCapability({
  id: 'job.trace.frame',
  input: z.object({ jobId: z.string(), frameHash: z.string() }),
  output: FrameOutput,
  permission: 'job.view',
  lease: 'none',
  deadline: 10_000,
  effect: 'read',
  description:
    'Read ONE trace frame captured during a job, named by the frameHash a job.trace event carries, as a ' +
    'base64-encoded PNG. Never a list or a range — call this once per screenshot you actually need to see; a ' +
    'trace can hold roughly a hundred frames and reading them all would flood your own context for no benefit. ' +
    'Prefer job.trace.ui when you only need to know what element was on screen.',
  // Plan 70 §4.3 — a DECLARATION, not the loop pattern-matching on a field called "image": mirrors
  // `device.screenshot` (`capability/device-inspect.ts`) exactly. The boot-time registry check
  // asserts "image" actually exists on `FrameOutput` above.
  imageOutputs: [{ dataField: 'image', mediaType: 'image/png' }],
  handler: async (ctx, { jobId, frameHash }) => {
    assertJobExists(ctx, jobId)
    const bytes = await requireJobTrace(ctx).readFrame(jobId, frameHash)
    if (!bytes) throw new EnkakuError('frame_not_found', `no such trace frame: ${frameHash}`)
    return { image: Buffer.from(bytes).toString('base64'), format: 'png' as const }
  },
})

export const JOB_TRACE_CAPABILITIES = [jobTrace, jobTraceUi, jobTraceFrame]
