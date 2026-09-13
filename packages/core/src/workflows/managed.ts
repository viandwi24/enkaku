import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { WorkflowDocSchema, type WorkflowDoc } from '@enkaku/protocol'
import type { Db } from '../db'
import { plugins, workflows } from '../db/schema'

/**
 * Plan 315 — keeping a plugin's shipped workflows in step with that plugin.
 *
 * ## The one rule
 *
 * **The `workflows` rows owned by plugin P are exactly the workflows declared
 * by P's ACTIVE version** — no more, no fewer, and none at all when no version
 * of P is active. Every lifecycle verb that can change which version is active
 * (activate, rollback, enable, disable, remove, and the boot restart) calls
 * `syncPluginWorkflows` afterwards, so the rule holds without any verb having
 * to know what the others did.
 *
 * It is a SYNC rather than a set of per-verb inserts and deletes because a
 * workflow has no version (MVP 03 §2.2 rule 4) while a plugin keeps every
 * version it ever had. Script rows can simply accumulate per version and let
 * the registry pick; a workflow row is unique by `name`, so it has to be
 * rewritten to whatever the active version says — and "compute the desired set,
 * make the table match" is the only shape of that which is idempotent, which
 * matters because the boot restart calls it for every plugin every time.
 *
 * ## What it never does
 *
 * - **It never touches an operator's workflow.** A row with `plugin_name`
 *   null is left exactly as it is, even if a plugin declares the same name.
 *   That collision cannot happen through the API (an operator's name may not
 *   contain `/`, and every plugin workflow's does), but a row written before
 *   plan 315 could hold one, and silently replacing an operator's work with a
 *   plugin's is the one outcome this module exists to rule out. It is reported
 *   as `skipped` instead.
 * - **It never takes another plugin's row.** Same reasoning, one plugin over.
 * - **It never interrupts a job.** A job runs from its own snapshot
 *   (`jobs.workflow_doc`), so removing or replacing a row changes what the NEXT
 *   run gets and nothing about a run already queued or running.
 *
 * ## What it deliberately does not check
 *
 * Script refs. A shipped workflow may call another plugin's scripts
 * (`smm/warmup-rotation` calls `tiktok/…`, `instagram/…`, `youtube/…`), and
 * whether those resolve depends on what else this farm has installed — which
 * can change in either order, at any time, without this plugin's version
 * changing at all. Refusing to register until they resolve would make the
 * outcome depend on the order packs were activated in. So the row is
 * registered, and the same `POST /api/workflows/validate` every operator
 * workflow goes through says what does not resolve when anyone looks; the run
 * itself fails by name if it still does not. The plugin's refs to ITS OWN
 * scripts are different — those are checked at verify
 * (`verify-child.ts`'s `finalizeReport`), where they cannot be wrong later.
 */

export interface ManagedSyncResult {
  /** Names inserted or rewritten because the declared document changed. */
  registered: string[]
  /** Names this plugin no longer declares (or no version is active), deleted. */
  removed: string[]
  /** Declared names that were NOT registered, and why — never silent. */
  skipped: { name: string; reason: string }[]
}

/** Only the part of a stored manifest this module reads. Parsed, never cast: the column is JSON written by an older build too. */
const ManifestWorkflowsSchema = z.object({ workflows: z.array(z.unknown()).optional() }).passthrough().nullable()

/**
 * The workflows plugin `pluginName`'s active version declares, already
 * prefixed (`finalizeReport` rewrote each name before the manifest was
 * stored). Empty when no version is active — which is precisely what makes
 * disable and remove "delete them all" without a branch of their own.
 */
export function declaredWorkflows(db: Db, pluginName: string): { docs: WorkflowDoc[]; skipped: ManagedSyncResult['skipped'] } {
  const active = db
    .select({ manifest: plugins.manifest })
    .from(plugins)
    .where(and(eq(plugins.name, pluginName), eq(plugins.status, 'active')))
    .get()
  if (!active) return { docs: [], skipped: [] }
  const manifest = ManifestWorkflowsSchema.safeParse(active.manifest)
  const raw = manifest.success ? (manifest.data?.workflows ?? []) : []
  const docs: WorkflowDoc[] = []
  const skipped: ManagedSyncResult['skipped'] = []
  for (const item of raw) {
    const parsed = WorkflowDocSchema.safeParse(item)
    if (!parsed.success) {
      // Verify already refused an invalid document, so this is a manifest
      // written by a build whose workflow schema this one no longer accepts.
      // Named, not dropped: an operator looking for a workflow that vanished
      // after an upgrade needs a reason, not an absence.
      const name = z.object({ name: z.string() }).safeParse(item)
      skipped.push({ name: name.success ? name.data.name : '(unnamed)', reason: `this build cannot read the declared document — ${parsed.error.issues[0]?.message ?? 'invalid'}` })
      continue
    }
    if (!parsed.data.name.startsWith(`${pluginName}/`)) {
      skipped.push({ name: parsed.data.name, reason: `a plugin workflow's name must start with "${pluginName}/"` })
      continue
    }
    docs.push(parsed.data)
  }
  return { docs, skipped }
}

/** Make the rows owned by `pluginName` equal to what its active version declares. Idempotent. */
export function syncPluginWorkflows(db: Db, pluginName: string, now: Date = new Date()): ManagedSyncResult {
  const { docs, skipped } = declaredWorkflows(db, pluginName)
  const result: ManagedSyncResult = { registered: [], removed: [], skipped: [...skipped] }
  const wanted = new Set(docs.map((d) => d.name))

  for (const doc of docs) {
    const row = db.select().from(workflows).where(eq(workflows.name, doc.name)).get()
    if (!row) {
      db.insert(workflows).values({ id: crypto.randomUUID(), name: doc.name, doc, createdBy: null, createdAt: now, updatedAt: now, pluginName }).run()
      result.registered.push(doc.name)
      continue
    }
    if (row.pluginName !== pluginName) {
      result.skipped.push({
        name: doc.name,
        reason: row.pluginName === null ? 'an operator already has a workflow with this name, and it is never replaced' : `plugin "${row.pluginName}" already provides a workflow with this name`,
      })
      continue
    }
    // Rewritten only when the document actually changed, so a boot that
    // re-syncs every plugin does not bump `updatedAt` on rows nothing touched.
    if (JSON.stringify(row.doc) !== JSON.stringify(doc)) {
      db.update(workflows).set({ doc, updatedAt: now }).where(eq(workflows.id, row.id)).run()
      result.registered.push(doc.name)
    }
  }

  for (const row of db.select({ id: workflows.id, name: workflows.name }).from(workflows).where(eq(workflows.pluginName, pluginName)).all()) {
    if (wanted.has(row.name)) continue
    db.delete(workflows).where(eq(workflows.id, row.id)).run()
    result.removed.push(row.name)
  }
  return result
}

/**
 * Every plugin at once — the boot path. Covers the plugins in the `plugins`
 * table AND any name still owning rows with no plugin row left at all (a
 * version removed by a build that predates plan 315's sync), so orphans are
 * cleaned rather than kept forever.
 */
export function syncAllPluginWorkflows(db: Db): Map<string, ManagedSyncResult> {
  const names = new Set<string>()
  for (const r of db.select({ name: plugins.name }).from(plugins).all()) names.add(r.name)
  for (const r of db.select({ name: workflows.pluginName }).from(workflows).all()) if (r.name !== null) names.add(r.name)
  const out = new Map<string, ManagedSyncResult>()
  for (const name of names) out.set(name, syncPluginWorkflows(db, name))
  return out
}
