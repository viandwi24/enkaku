import { z } from 'zod'
import { JobInfoSchema } from '../messages/job'

/** One step of one workflow run (MVP 05 §1.2). */
export const WorkflowStepInfoSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().min(0),
  stepId: z.string(),
  /** Plan 303 §5 step 303.3: `switch`/`delay` join `script`/`gate` as recorded step kinds. */
  kind: z.enum(['script', 'gate', 'switch', 'delay']),
  /** The child script job and the run of it this step waited on; both null for a gate. */
  jobId: z.string().nullable(),
  jobRunId: z.string().nullable(),
  status: z.enum(['running', 'success', 'failed', 'skipped', 'carried-over', 'cancelled']),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  /** `$input` this step received (plan 304 §3.1) — the previous step's own output, size-capped the same way `output` is. `null` for the first real step of a run. Added by plan 307 (§3.3: extending an existing message, not a new one) — the run view's node panel reads a SPECIFIC run's data through this field rather than always "the last run" (plan 306's `/last-run` route). */
  input: z.unknown(),
  output: z.unknown(),
  outputTruncated: z.string().nullable(),
  /** Which edge the step left by, or `null` when the run ended here (plan 304 §4.1). Added by plan 307 — the run overlay's edge highlight (P11) reads this. */
  takenEdge: z.string().nullable(),
  /** True when the step was satisfied from a pin instead of executed (plan 304 §3.3). Added by plan 307 — the run overlay draws a pinned node without a halo, since it did not run. */
  pinned: z.boolean(),
  /** A gate's resolved `PredicateTrace` and the branch it chose. */
  verdict: z.unknown(),
  error: z.string().nullable(),
  errorCode: z.string().nullable(),
})
export type WorkflowStepInfo = z.infer<typeof WorkflowStepInfoSchema>

/** `GET /api/workflow-jobs/:id/runs/:runId/steps`. `finalized` says whether the workflow RUN has settled. */
export const WorkflowStepsResponseSchema = z.object({ items: z.array(WorkflowStepInfoSchema), finalized: z.boolean() })
export type WorkflowStepsResponse = z.infer<typeof WorkflowStepsResponseSchema>

/** `POST /api/workflow-jobs/:id/resume`. `fromStep` omitted means "the first step that did not succeed in the latest run". */
export const WorkflowResumeRequestSchema = z.object({ fromStep: z.number().int().min(0).optional() })
export type WorkflowResumeRequest = z.infer<typeof WorkflowResumeRequestSchema>

/** The new RUN, on the same job. */
export const WorkflowResumeResponseSchema = z.object({
  job: JobInfoSchema,
  runId: z.string(),
  resumedFromRunId: z.string(),
  resumedFromStep: z.number().int(),
})
export type WorkflowResumeResponse = z.infer<typeof WorkflowResumeResponseSchema>
