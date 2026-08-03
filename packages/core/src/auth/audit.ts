import { desc } from 'drizzle-orm'
import type { Db } from '../db'
import { auditLog } from '../db/schema'

/** The actions that get recorded (spec §14). */
export type AuditAction =
  | 'user.login'
  | 'user.logout'
  | 'user.setup'
  | 'user.create'
  | 'user.delete'
  | 'user.password_change'
  | 'device.enroll'
  | 'device.settings'
  | 'device.drivers'
  | 'device.quarantine'
  | 'device.unquarantine'
  | 'device.control'
  // Device lifecycle (plan 47 §3.5, §4.4) — Forget, Block, Unblock.
  | 'device.forget'
  | 'device.block'
  | 'device.unblock'
  | 'script.publish'
  | 'script.delete'
  | 'script.toggle'
  | 'job.run'
  | 'job.cancel'
  | 'cluster.create'
  | 'cluster.update'
  | 'cluster.delete'
  | 'cluster.assign'
  | 'cluster.unassign'
  | 'batch.cancel'
  | 'schedule.create'
  | 'schedule.update'
  | 'schedule.delete'
  | 'schedule.run-now'
  | 'artifact.upload'
  | 'tool.install'
  | 'tool.activate'
  | 'tool.delete'
  | 'settings.update'
  | 'retention.gc'

export interface AuditLogger {
  record(input: { userId: string | null; action: AuditAction; target?: string; meta?: unknown }): void
  list(limit: number): Array<{
    id: string
    userId: string | null
    action: string
    target: string | null
    meta: unknown
    at: number | null
  }>
}

export function createAuditLogger(db: Db): AuditLogger {
  return {
    record({ userId, action, target, meta }) {
      db.insert(auditLog)
        .values({
          id: crypto.randomUUID(),
          userId,
          action,
          target: target ?? null,
          meta: meta ?? null,
          at: new Date(),
        })
        .run()
    },

    list(limit) {
      return db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.at))
        .limit(limit)
        .all()
        .map((r) => ({
          id: r.id,
          userId: r.userId,
          action: r.action,
          target: r.target,
          meta: r.meta,
          at: r.at ? Math.floor(r.at.getTime() / 1000) : null,
        }))
    },
  }
}
