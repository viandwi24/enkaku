import { z } from 'zod'
import { NotificationSchema } from '../messages/notify'

/** `GET /api/notifications?...`. */
export const NotificationsResponseSchema = z.object({
  items: z.array(NotificationSchema),
  unreadCount: z.number(),
})
