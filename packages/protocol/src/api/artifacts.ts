import { z } from 'zod'
import { ArtifactInfoSchema } from '../messages/job'
import { pageSchema } from './pagination'

/**
 * `GET /api/artifacts` (plan 24 §4.6, widened by plan 93 §3.13, §4.4, §4.7,
 * step 93.10's `?kind=upload` — closing F14: an upload has BOTH `jobId` and
 * `deviceId` null, so it was unreachable through the existing `?jobId=` /
 * `?deviceId=` query modes). One envelope for all three query modes:
 * `items` is the current key, `artifacts` is kept alongside it, unchanged,
 * for whatever already reads the pre-plan-72 name (plan 72 §3.2's additive
 * rule for an existing response shape).
 */
export const ArtifactsPageResponseSchema = pageSchema(ArtifactInfoSchema).extend({
  artifacts: z.array(ArtifactInfoSchema),
})
