import { z } from 'zod'
import { GroupInfoSchema } from '../messages/batch'

/** `POST /api/groups`, `PATCH /api/groups/:id`. */
export const GroupResponseSchema = z.object({ group: GroupInfoSchema })

/**
 * `PUT /api/groups/order` — the farm's group order, as the COMPLETE list of
 * group ids, first tab first. Partial lists are refused rather than merged:
 * a client holding a stale list (a group created or deleted elsewhere since
 * it last read) must re-read, never silently drop a group to the end.
 */
export const GroupOrderBodySchema = z.object({ ids: z.array(z.string().min(1)).min(1) })
export type GroupOrderBody = z.infer<typeof GroupOrderBodySchema>

/** `PUT /api/groups/order`'s answer: every group, in the order just stored. */
export const GroupOrderResponseSchema = z.object({ groups: z.array(GroupInfoSchema) })
