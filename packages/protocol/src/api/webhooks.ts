import { z } from 'zod'
import { WebhookEndpointSchema } from '../messages/notify'

/** `GET /api/webhooks`. */
export const WebhooksResponseSchema = z.object({ endpoints: z.array(WebhookEndpointSchema) })
