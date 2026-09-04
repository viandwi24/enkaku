import { z } from 'zod'
import { GroupInfoSchema } from '../messages/batch'

/** `POST /api/groups`, `PATCH /api/groups/:id`. */
export const GroupResponseSchema = z.object({ group: GroupInfoSchema })
