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
  // record, tags, group, settings, job history and artifacts untouched.
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
  // `POST /api/devices/prep/apply` — one prep setting across a selection.
  // One row for the whole request, carrying the keys and the counts: forty
  // rows for one click would bury the trail the same way forty PATCH rows
  // already do, and the per-device outcomes live in each device's own event
  // log (`settings.changed`, `device.rotation`), which is where an answer to
  // "what happened to THIS phone" belongs.
  | 'device.prep.apply'
  | 'script.delete'
  // Plan 210 (MVP 03 §2.2 rule 4) — `script.toggle` and `script.publish`
  // (the direct-publish path) are gone: a script is a member of a plugin
  // (`plugin.activate`/`.disable`/`.enable` above cover it), and a workflow
  // is edited in place through its own table.
  | 'workflow.create'
  | 'workflow.update'
  | 'workflow.delete'
  // Named parameter sets (plan 95 §4.7, §4.8, §5 step 95.8) — a preset is
  // "standing intent" about a script the same way a schedule is, and gets
  // the same answerability its sibling `script.*` verbs already have.
  | 'script.param_set.create'
  | 'script.param_set.update'
  | 'script.param_set.delete'
  | 'job.run'
  | 'job.cancel'
  // Plan 128 §4.3, §4.5 — the two DESTRUCTIVE job verbs. Cancelling a job
  // stops it; these erase the record that it ever ran, together with its
  // artifacts, its trace and its frames, which is the one job operation
  // nothing else can undo. `meta` carries the cascade's own counts (and, for
  // the bulk form, the filter it ran with), so "who deleted this history, and
  // how much of it" is answerable afterwards rather than inferred from a gap.
  | 'job.delete'
  | 'job.history.clear'
  | 'group.create'
  | 'group.update'
  | 'group.delete'
  | 'group.assign'
  | 'group.unassign'
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
  // A browser upload into the workspace (plan 115 §4.3) — the ONE way bytes
  // enter the workspace from outside `fs.write`, gated and audited exactly
  // like `artifact.upload` above; `meta` carries the size and content type,
  // never the file's own name (already the destination path, `target`).
  | 'workspace.upload'
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
  // The operator-triggered WHOLE-CORE restart (plan 120 §4) — a distinct
  // action from `adb.restart` on purpose, never folded into it: this drops
  // every live session/stream farm-wide and interrupts every in-flight job,
  // a materially bigger blast radius than the adb server restart above,
  // which leaves the core process (and every job's queue state) untouched.
  | 'app.restart'
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
  // A stored KV secret read back in plaintext (`POST /api/kv/entry/reveal`,
  // `packages/core/src/api/kv.ts`). ONE row per request that reaches the
  // handler, whatever the outcome — a grant, a refusal, a key that does not
  // exist, a row that is not secret, a value that would not decrypt — because
  // the question this action exists to answer is "who read this secret", and a
  // log that only records the successes answers a different, easier one.
  //
  // `userId` is the operator, `target` the KEY, and `meta` carries the outcome,
  // the scope, the stableId and the namespace — the coordinates of the row and
  // nothing out of it. Never the value, and nothing derived from it: not a
  // hint, not a length, not a prefix. The same rule `kv.set` above and
  // `device.network.credential.reveal` below both state.
  //
  // It exists BECAUSE the alternative leaves no trace: `secrets.key` sits beside
  // `enkaku.db`, so anyone holding `kv.manage` can already open every secret in
  // the farm with `sqlite3`. This action is what makes the supported path the
  // recorded one.
  | 'kv.reveal'
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
  // The ENVELOPE row for one bulk version removal
  // (`POST /api/plugins/:name/versions/remove` — "remove all versions" / "remove
  // all except the latest"). It does NOT replace the per-version `plugin.delete`
  // rows above: that request still writes one of those per version it removed or
  // was refused, with the same `name@version` target the single-version route
  // uses, so a version's removal is findable the same way whichever route did
  // it. This row answers the other question — which single operator action, with
  // which scope, produced those eleven — and carries the counts plus the kept
  // versions, which have no row of their own because nothing was attempted on
  // them.
  | 'plugin.delete.bulk'
  /**
   * **Reset data** — `POST /api/plugins/:name/reset`: everything one plugin
   * stored, deleted, after its own cleanup handler was given one run to undo
   * what it did to the outside world.
   *
   * Its own action rather than a flag on `plugin.delete`, because nothing was
   * deleted from the `plugins` table: the plugin is still installed and still
   * active. Folding the two together would make "when did somebody remove this
   * plugin" answer for a request that removed no plugin.
   *
   * Written on EVERY path, including the ones where nothing was deleted —
   * `meta.status` is `reset`, `reset-with-debts` or `blocked`, and a blocked
   * pass is exactly the row an operator wants to find later. It carries the
   * entry counts, the per-outcome cleanup counts, and the ids of any device
   * still owed a teardown (`pendingIds`) or left uncleaned (`failedIds`) — the
   * one list that cannot be reconstructed from anywhere else once the plugin's
   * own data is gone. Never a plugin-authored `message`: that is prose, up to
   * six hundred characters of it, and the audit log is not where it belongs.
   */
  | 'plugin.reset'
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
  // A `ctx.farm` call the capability broker refused ITSELF, before `invoke()`
  // was entered (plan 109 §4.3, step 109.3) — an undeclared capability, an
  // unknown one, or a namespace that is not an active plugin at all. `userId`
  // is the `plugin:<name>` principal, `target` the capability id, and `meta`
  // carries what the manifest DID declare at that moment; the input is never
  // recorded, the same rule `kv.set` and `command.run` state above.
  //
  // An ACCEPTED call is deliberately absent from this action: it reaches
  // `invoke()`, which writes the one `capability.invoke` row it gets (criterion
  // 10 — exactly one row per accepted call) under the same `plugin:<name>`
  // principal. Filtering the log on that principal therefore returns both,
  // and plan 63's acceptance #7 ("every capability invocation, refusals
  // included") stays true of `capability.invoke` rather than acquiring a
  // plugin-shaped hole.
  | 'plugin.capability'
  // One invocation of a plugin's own `ctx.onRequest` handler (plan 109 §4.6,
  // step 109.6), and one WebSocket handshake accepted on a `ctx.onSocket` one.
  // `userId` is the REAL caller — the human whose session reached the route —
  // and `target` is `<plugin>/<handlerId>`.
  //
  // These exist because `plugin.capability`/`capability.invoke` name
  // `plugin:<name>` and nothing else: a plugin's HTTP handler that enqueues a
  // job is audited as the plugin, correctly (invoking a handler does not lend a
  // plugin the caller's authority, §9 Q14), but with no row here there is
  // nothing in the log tying that to the operator who pressed the button. One
  // query on `target` answers "who set this off"; one on `user_id` answers
  // "what did the plugin then do".
  //
  // Audited on EVERY method, GET included: the farm cannot know whether a
  // plugin's handler mutates — `GET /http/wipe` is legal plugin code — so
  // filtering by method would be a guess dressed as a policy. `meta` carries
  // the method, the response status and the permission that gated it; never the
  // body and never the query string, either of which can hold a secret (the
  // rule `kv.set`, `command.run` and `plugin.capability` already state).
  | 'plugin.http'
  | 'plugin.socket'
  // Start/stop/restart of a plugin's service (plan 109 §4.6, `plugin.runtime`).
  // Kept apart from `plugin.reload`/`plugin.restart` above, which are plan 82's
  // and re-VERIFY a bundle: this one changes nothing about which version is
  // live. `meta` carries the verb and the status the service landed in — never
  // "ok", because a restart that lands on `starting` has not started.
  | 'plugin.runtime'
  // An inbound webhook (plan 109 §3.7, step 109.7) — one row per request that
  // got past the rate limiter, whatever became of it, plus a row whenever a
  // plugin reads or rotates one of its own secrets.
  //
  // **`userId` is `webhook:<plugin>/<id>`, and that is a NAMED ABSENCE rather
  // than a principal.** Every other plugin row has a real actor behind it:
  // `plugin.http`/`plugin.socket` name the operator whose browser caused it,
  // `plugin.capability`/`capability.invoke` name `plugin:<name>`. A webhook has
  // neither — its caller is a third-party system with no farm account, and the
  // only thing the farm knows about it is that it held this webhook's secret.
  // `null` would have been the other option and it says less: it is the same
  // value a core-internal action carries, so "which of these rows had no human
  // behind them because they came in off the internet" would stop being a
  // query. This string says there was no operator AND says what stood in for
  // one.
  //
  // `meta` carries the outcome, which secret verified (`current`/`previous` —
  // the signal that a sender has not been updated since a rotation), the
  // response status and the body's size. Never the body, never the signature,
  // and never the secret.
  | 'plugin.webhook'
  // The fleet command surface (plan 93 §3.4, §4.5, §5 step 93.3) — one row per fan-out
  // run, the same "create the run, audit it once" shape `createBatch`'s own
  // `job.run` row already has (`groups/dispatch.ts`). `meta` carries the
  // redacted command text, the resolved device count, and the skipped list —
  // never the raw command (the same log-hygiene pass §3.9's history already applies).
  | 'command.run'
  // Named commands (plan 93 §3.10, §4.4, step 93.6) — create/update/delete
  // of a farm-scoped named command. `meta` carries `{ name }` only — never
  // the raw `cmd` text, the same log-hygiene reasoning `command.run` above
  // already applies.
  | 'command.saved.create'
  | 'command.saved.update'
  | 'command.saved.delete'
  // A device's stored upstream proxy password read back in plaintext
  // (`POST /api/devices/:id/network/credential/reveal`,
  // `packages/core/src/network/route-service.ts`). ONE row per request,
  // whatever the outcome — a grant, a refusal, a route with no credential, a
  // secret that would not decrypt — because the question this action exists to
  // answer is "who tried to read this password", and a log that only records
  // the successes answers a different, easier one.
  //
  // `userId` is the operator, `target` the device id, and `meta` carries the
  // outcome, the credential's NAME (`credentialRef`), whether it had a
  // username, and the role that was checked. It never carries the password, the
  // username's value, or anything derived from either — not a hint, not a
  // length, not a prefix. The rule `kv.set`, `command.run`, `connector.*` and
  // `plugin.webhook` above all state, applied to the one action in this list
  // whose entire purpose is to hand a secret to somebody.
  | 'device.network.credential.reveal'

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
