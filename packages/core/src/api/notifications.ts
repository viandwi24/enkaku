import { Hono } from 'hono'
import { NotificationsResponseSchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { NotificationStore } from '../notify/store'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/**
 * `GET /api/notifications` and friends (plan 68 §4.5) — the bell's data
 * source. Every authenticated caller sees every notification: this plan has
 * no per-user scoping (a farm-wide bell, matching §4.5's "a bell in the app
 * shell shows unread notifications").
 */
export interface NotificationRoutesDeps {
  store: NotificationStore
}

export function createNotificationRoutes(deps: NotificationRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { store } = deps

  app.get('/', (c) => {
    const unreadOnly = c.req.query('unreadOnly') === 'true'
    const limitParam = c.req.query('limit')
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined
    return typedJson(c, NotificationsResponseSchema, { items: store.list({ unreadOnly, ...(limit && Number.isFinite(limit) ? { limit } : {}) }), unreadCount: store.unreadCount() })
  })

  app.get('/unread-count', (c) => c.json({ unreadCount: store.unreadCount() }))

  app.post('/:id/read', (c) => c.json({ notification: store.markRead(c.req.param('id')) }))

  app.post('/read-all', (c) => c.json({ count: store.markAllRead() }))

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), err.code === 'notification_not_found' ? 404 : 500)
    throw err
  })

  return app
}
