import { z } from 'zod'
import { ScheduleInfoSchema, ScheduleRunInfoSchema } from '../messages/schedule'
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

/** `GET /api/schedules/:id/runs` (keyset). */
export const ScheduleRunsPageResponseSchema = pageSchema(ScheduleRunInfoSchema)
