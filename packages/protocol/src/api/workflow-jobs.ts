import { z } from 'zod'
import { JobInfoSchema } from '../messages/job'

/** One step of one workflow run (MVP 05 §1.2). */
export const WorkflowStepInfoSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().min(0),
  stepId: z.string(),
  kind: z.enum(['script', 'gate']),
  /** The child script job and the run of it this step waited on; both null for a gate. */
  jobId: z.string().nullable(),
  jobRunId: z.string().nullable(),
  status: z.enum(['running', 'success', 'failed', 'skipped', 'carried-over', 'cancelled']),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  output: z.unknown(),
  outputTruncated: z.string().nullable(),
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
