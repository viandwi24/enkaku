import { z } from 'zod'
import { ScheduleInfoSchema } from '../messages/schedule'
import { JobInfoSchema } from '../messages/job'
import { pageSchema } from './pagination'

/** `GET/POST/PATCH /api/schedules(/:id)` — `resolvesTo` is null for an agent-target schedule. */
export const ScheduleResponseSchema = z.object({
  schedule: ScheduleInfoSchema,
  resolvesTo: z.object({ scriptId: z.string(), name: z.string(), version: z.string() }).nullable().optional(),
})

/** `POST /api/schedules/validate`. */
export const ValidateResponseSchema = z.object({
  valid: z.boolean(),
  nextFires: z.array(z.number()),
  error: z.string().optional(),
})

/** `GET /api/schedules/:id/jobs` (keyset) — the schedule's member jobs (plan 211 §3.2 decision 4). */
export const ScheduleJobsPageResponseSchema = pageSchema(JobInfoSchema)
