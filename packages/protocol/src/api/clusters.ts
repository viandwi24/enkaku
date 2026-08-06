import { z } from 'zod'
import { ClusterInfoSchema } from '../messages/batch'

/** `POST /api/clusters`, `PATCH /api/clusters/:id`. */
export const ClusterResponseSchema = z.object({ cluster: ClusterInfoSchema })
