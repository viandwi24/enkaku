import { and, desc, eq, isNull } from 'drizzle-orm'
import { NotificationSchema, type Notification, type NotificationContext, type NotificationLevel } from '@enkaku/protocol'
import type { Db } from '../db'
import { notifications, type NotificationRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * In-app notifications (plan 68 §3.4, §4.4) — a row in `notifications`, a
 * bell in Studio, unread counts. Nothing to configure, works for everyone,
 * and is the record even when a webhook fails: `notify/service.ts` writes
 * one of these BEFORE it ever attempts a webhook delivery.
 */

function toSeconds(d: Date | null): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null
}

function rowToNotification(row: NotificationRow): Notification {
  return NotificationSchema.parse({
    id: row.id,
    level: row.level,
    title: row.title,
    body: row.body,
    context: row.context ?? null,
    source: row.source,
    readAt: toSeconds(row.readAt),
    createdAt: toSeconds(row.createdAt) ?? 0,
  })
}

export interface CreateNotificationInput {
  level: NotificationLevel
  title: string
  body?: string | null
  context?: NotificationContext
  source: string
}

export function createNotificationStore(db: Db) {
  function create(input: CreateNotificationInput): Notification {
    const row: NotificationRow = {
      id: crypto.randomUUID(),
      level: input.level,
      title: input.title,
      body: input.body ?? null,
      context: input.context ?? null,
      source: input.source,
      readAt: null,
      createdAt: new Date(),
    }
    db.insert(notifications).values(row).run()
    return rowToNotification(row)
  }

  function list(opts?: { unreadOnly?: boolean; limit?: number }): Notification[] {
    const limit = opts?.limit ?? 50
    const where = opts?.unreadOnly ? isNull(notifications.readAt) : undefined
    const rows = (where ? db.select().from(notifications).where(where) : db.select().from(notifications))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .all()
    return rows.map(rowToNotification)
  }

  function unreadCount(): number {
    return db.select().from(notifications).where(isNull(notifications.readAt)).all().length
  }

  function get(id: string): Notification | null {
    const row = db.select().from(notifications).where(eq(notifications.id, id)).get()
    return row ? rowToNotification(row) : null
  }

  function markRead(id: string): Notification {
    const row = db.select().from(notifications).where(eq(notifications.id, id)).get()
    if (!row) throw new EnkakuError('notification_not_found', `no such notification: ${id}`)
    if (!row.readAt) db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, id)).run()
    return get(id)!
  }

  /** Idempotent: an already-read notification is left as-is (its original `readAt` is not disturbed). */
  function markAllRead(): number {
    const unread = db.select().from(notifications).where(isNull(notifications.readAt)).all()
    const now = new Date()
    for (const row of unread) {
      db.update(notifications)
        .set({ readAt: now })
        .where(and(eq(notifications.id, row.id), isNull(notifications.readAt)))
        .run()
    }
    return unread.length
  }

  return { create, list, unreadCount, get, markRead, markAllRead }
}

export type NotificationStore = ReturnType<typeof createNotificationStore>
