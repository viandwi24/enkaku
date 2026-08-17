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
  // Co-control — Assist (plan 91 §3.5, §4.2, §4.6) — one row per grant,
  // whether it started or ended; `meta` always carries `{ jobId, primaryKind
  // }` and, on an end row, `reason` (an `AssistEndReason`). Distinct from
  // `device.control` (`acquired`/`released`), which is about the LEASE —
  // assisting never touches the lease at all (§3.2's table).
  | 'device.assist'
  // `PATCH /:id`'s `ownerId` transition (plan 09 §4.4's `device.owner.set`,
  // `api/devices.ts`) — separate from `device.settings` (label/settings)
  // because reassigning ownership changes who `canUseDevice` admits, not a
  // device attribute; `meta` always carries `{ from, to }`.
  | 'device.owner'
  // Device lifecycle (plan 47 §3.5, §4.4) — Forget, Block, Unblock.
  | 'device.forget'
  | 'device.block'
  | 'device.unblock'
  // Admission (plan 56 §4.4) — letting a phone into a shared farm is exactly
  // the kind of act that should be answerable later, the same argument plan 47
  // makes for block.
  | 'device.admit'
  | 'device.dismiss'
  // The manual discovery reconciler escape hatch (plan 85 §4.6, §5 step 85.2).
  | 'device.rescan'
  // The bounded subnet sweep's manual trigger (plan 88 §3.5, §4.5, §4.6, §5
  // step 88.3, dedicated by step 88.4) — `POST /api/devices/scan` audited
  // under `device.rescan` with `meta.via: 'scan'` as a stopgap while this
  // file was held by a concurrent step; now its own action.
  | 'device.scan'
  // Per-device disconnect/reconnect (plan 88 §3.7, §3.8, §4.6, §5 step 88.4)
  // — distinct from `device.forget`/`device.block`, which un-enrol a device:
  // these only drop or restore the adb transport and leave the device's
  // record, tags, cluster, settings, job history and artifacts untouched.
  | 'device.disconnect'
  | 'device.reconnect'
  // `PATCH /:id/connection`'s declared medium (plan 88 §3.1, §4.6, §5 step
  // 88.4) — an operator declaring/correcting wired vs wireless, e.g. after a
  // cutover that happened outside Enkaku.
  | 'device.medium'
  // The USB → network cutover wizard (plan 88 §3.4, §4.6, §5 step 88.5) —
  // `.start` covers the arm/enable step (`meta` carries port/medium/step);
  // `.cancel` is the operator backing out mid-window (§3.4: "reverts
  // nothing", but the ATTEMPT itself is still answerable later).
  | 'device.cutover.start'
  | 'device.cutover.cancel'
  // The device number (plan 89 §3.2 point 5, §4.2, §4.3): a manual
  // reassignment is audited under the existing `device.settings` (it rides
  // `PATCH /:id`, same as `label`); these two are the number's OWN verbs —
  // `POST /numbers/compact` (the fleet-wide renumber) and `DELETE
  // /numbers/:stableId` (the explicit release), neither of which is a
  // `PATCH /:id` at all.
  | 'device.numbers.compact'
  | 'device.numbers.release'
  // Physical labelling (plan 89 §4.3, §4.6, §5 step 89.6/89.9's own gap) —
  // the three mutating label endpoints `packages/core/src/api/devices.ts`
  // adds: a single device's explicit re-apply, its clear (with or without
  // restoring the captured original), and the fleet-wide switch-on.
  | 'device.label.apply'
  | 'device.label.clear'
  | 'device.labels.apply'
  | 'script.publish'
  | 'script.delete'
  | 'script.toggle'
  // Named parameter sets (plan 95 §4.7, §4.8, §5 step 95.8) — a preset is
  // "standing intent" about a script the same way a schedule is, and gets
  // the same answerability its sibling `script.*` verbs already have.
  | 'script.param_set.create'
  | 'script.param_set.update'
  | 'script.param_set.delete'
  | 'job.run'
  | 'job.cancel'
  | 'cluster.create'
  | 'cluster.update'
  | 'cluster.delete'
  | 'cluster.assign'
  | 'cluster.unassign'
  // Plan 94 §3.9, §4.9, step 94.8 — `POST /:id/stop` REPLACES `/:id/cancel`
  // (00-overview §4.3), so this action name replaces `'batch.cancel'`
  // rather than sitting beside it.
  | 'batch.stop'
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
  // Bulk re-provisioning of the required tools (`POST /api/tools/repair`) and a manual manifest
  // refresh (`POST /api/tools/manifest/refresh`) — both `tool.manage` (plan 09 §4.4's table names
  // this exact route set: "install/activate/delete/check/manifest-refresh"), both previously
  // ungated and unaudited (a security-sweep finding, `tools/routes.ts`). `tool.manifest.refresh`
  // is the literal name plan 09 §4.5's audit table already gives this action.
  | 'tool.repair'
  | 'tool.manifest.refresh'
  // The operator-triggered adb server restart (plan 88 §3.10, §4.8, §5 step
  // 88.8) — `tool.manage`, same as every other row in this group, but its
  // own action rather than folded into `tool.repair`: it drops every other
  // program's adb connection on this machine too (Android Studio, a `adb
  // logcat` in a terminal), which is a materially different blast radius
  // from re-provisioning one of Enkaku's own tools.
  | 'adb.restart'
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
  | 'agent.thread.delete'
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
  // The way back from `plugin.disable` (`POST /api/plugins/:name/enable`) —
  // its own action rather than a `meta` flag on `plugin.disable`, so "who
  // brought this plugin back, and when" is as answerable as who took it down.
  | 'plugin.enable'
  | 'plugin.reload'
  | 'plugin.restart'
  | 'plugin.delete'
  | 'plugin.dev'
  // A write/delete through a plugin's own data routes (plan 108 §4.5, step 108.4) — kept apart
  // from `kv.set`/`kv.delete` above so the log says WHICH plugin's namespace was touched and by
  // which surface. `meta` names the plugin, scope, and stableId; never the value, the same rule
  // the `kv.*` pair states.
  | 'plugin.data.set'
  | 'plugin.data.delete'
  // One DECLARED action executed from a plugin's screen (plan 108 §4.5, step
  // 108.5) — one row per execution, whatever the action's kind. `meta` names
  // the plugin, the action id, the kind, and the RESOLVED target (the device
  // a job was enqueued on, the batch a fan-out created, the namespaced key a
  // write touched). Kept apart from the `job.run`/`plugin.data.*` row the
  // dispatch itself may also write: those say WHAT happened, this says which
  // screen's button asked for it.
  | 'plugin.action'
  // The command console (plan 93 §3.4, §4.5, §5 step 93.3) — one row per fan-out
  // run, the same "create the run, audit it once" shape `createBatch`'s own
  // `job.run` row already has (`clusters/dispatch.ts`). `meta` carries the
  // redacted command text, the resolved device count, and the skipped list —
  // never the raw command (the same log-hygiene pass §3.9's history already applies).
  | 'command.run'
  // Saved commands (plan 93 §3.10, §4.4, step 93.6) — create/update/delete
  // of a farm-scoped saved command. `meta` carries `{ name }` only — never
  // the raw `cmd` text, the same log-hygiene reasoning `command.run` above
  // already applies.
  | 'command.saved.create'
  | 'command.saved.update'
  | 'command.saved.delete'

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
