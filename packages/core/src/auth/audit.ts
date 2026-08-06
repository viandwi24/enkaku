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
  // Admission (plan 56 §4.4) — letting a phone into a shared farm is exactly
  // the kind of act that should be answerable later, the same argument plan 47
  // makes for block.
  | 'device.admit'
  | 'device.dismiss'
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
  // A schedule's reference could not resolve at firing time (plan 62 §4.5,
  // acceptance #12) — distinct from `E_NO_TARGETS` (no usable devices right
  // now), which is not a schedule malfunction and is not audited.
  | 'schedule.failed'
  | 'artifact.upload'
  // Every capability invocation, refusals included (plan 63 §3.4 step 7,
  // acceptance #7) — one action for the whole registry rather than one per
  // capability id, since the id itself already rides along as `target`.
  | 'capability.invoke'
  | 'tool.install'
  | 'tool.activate'
  | 'tool.delete'
  | 'settings.update'
  | 'retention.gc'
  // AI agent records (plan 65 §4.5, §5.5) — creating/editing/deleting the
  // record itself, distinct from `capability.invoke` (what the agent DOES
  // once it runs, which Plan 66 adds).
  | 'agent.create'
  | 'agent.update'
  | 'agent.delete'
  // Connectors (plan 65 §3.6, §4.4) — never carries the credential in `meta`.
  | 'connector.create'
  | 'connector.update'
  | 'connector.delete'
  | 'connector.test'
  // The agent loop (plan 66 §4.4) — talking to an agent, distinct from
  // `agent.create`/`.update`/`.delete` above (editing the RECORD).
  | 'agent.thread.create'
  | 'agent.thread.message'
  | 'agent.run.cancel'
  | 'agent.approval.decide'
  // Plan 68 §3.5 — a destructive call auto-denied because its thread's
  // `onApprovalRequired === 'deny'`, distinct from `agent.approval.decide`
  // (a HUMAN deciding a paused one).
  | 'agent.approval.auto-denied'
  // The run tree (plan 67 §3.4, §4.1) — who may spawn whom, editable the
  // same way as any other agent-record field (`agent.manage`).
  | 'agent.spawn-grant.create'
  | 'agent.spawn-grant.delete'
  // Content-addressed image blobs (plan 70 §4.6) — an upload, the only write path outside the loop's own storage step.
  | 'agent.blob.upload'
  // Webhook endpoints (plan 68 §4.1) — farm-level, admin-managed; never carries the secret in `meta`.
  | 'webhook.create'
  | 'webhook.update'
  | 'webhook.delete'
  // The durable KV store's admin surface (plan 79 §4.3, step 4) — never carries a secret's plaintext in `meta`.
  | 'kv.set'
  | 'kv.delete'
  // Plugins (plan 82 §5 step 11) — publish/stage, the explicit activate/rollback/reload/restart
  // that §3.9 keeps separate from any bundle upload, delete, and the dev slot lifecycle.
  | 'plugin.publish'
  | 'plugin.activate'
  | 'plugin.rollback'
  | 'plugin.disable'
  | 'plugin.reload'
  | 'plugin.restart'
  | 'plugin.delete'
  | 'plugin.dev'

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
