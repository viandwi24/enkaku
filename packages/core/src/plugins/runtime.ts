import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices, plugins, scripts, type PluginRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { changedRows } from '../db'
import type { KvStore } from '../kv/store'
import { materializeBundleText } from '../scripts/bundle-cache'
import type { ScriptRegistry } from '../scripts/registry'
import { verifyPluginBundle, type VerifyReport } from './verify-child'
import { createDevSlotStore, type DevSessionOwner, type DevSlot, type DevSlotStore } from './dev-slots'
import { buildScriptFromWorkspace } from '../scripts/build'
import type { WorkspaceStore } from '../workspace/store'

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Stage → verify → activate (plan 82 §3.7, §4.3) — everything that reads or
 * writes the `plugins` table plus the in-memory dev slot store, and the
 * ONE guarantee the whole plan hangs on (§3.8): assembling/operating on the
 * script registry never throws because one plugin is broken. Every public
 * method here either returns a `PluginRow`/`VerifyReport`/count, or throws
 * an `EnkakuError` about the CALLER's request (bad input, not-found, a lost
 * CAS race) — never an uncaught exception from a plugin's own code, which
 * cannot reach this file's process at all (`verify-child.ts` runs it in a
 * child).
 *
 * Written as a set of local functions closing over `deps`, THEN assembled
 * into the returned object — deliberately, so `reload`/`restart` can call
 * `verifyImpl`/`activateImpl` directly rather than through `this` (an
 * object-literal method detached from its owner, e.g. `const { reload } =
 * runtime`, would otherwise silently lose its receiver).
 */

export interface PluginView extends PluginRow {
  scriptCount: number
}

export interface DevSlotView extends DevSlot {
  kvNamespace: string
}

export interface RemovalSummary {
  removed: boolean
  kvDeleted: number
}

export interface StagePluginInput {
  name: string
  version: string
  bundle: string
  source?: string
  createdBy?: string | null
}

export interface PluginRuntimeDeps {
  db: Db
  dataDir: string
  registry: ScriptRegistry
  kv: KvStore
  devSlots?: DevSlotStore
  /** Verification is injected so tests can substitute a fast fake — the real one spawns a child (`verify-child.ts`), which is what production always uses. */
  verify?: (bundlePath: string, opts?: { expectedVersion?: string }) => Promise<VerifyReport>
}

export interface PluginRuntime {
  list(q?: { name?: string }): PluginView[]
  get(name: string, version: string): PluginRow | null
  active(name: string): PluginRow | null

  stage(input: StagePluginInput): Promise<PluginRow>
  verify(pluginId: string): Promise<VerifyReport>
  activate(pluginId: string, expectedStatus?: 'staged'): PluginRow
  rollback(name: string, toVersion: string): PluginRow
  disable(name: string): void
  remove(name: string, version: string, opts: { deleteKv: boolean }): RemovalSummary

  /**
   * Two front-ends, one slot (§3.5): `source.kind === 'workspace'` is front-end A —
   * `scripts/build.ts` bundles a workspace directory server-side, under its usual import
   * allowlist. `source.kind === 'bundle'` is front-end B — `enkaku dev` already bundled on the
   * author's own machine (`Bun.build`, the same code `publish` uses) and pushed the result;
   * the farm verifies what it was given exactly as it does for a publish, never trusting the
   * CLI's local build as a security boundary.
   */
  putDevSlot(input: {
    name: string
    owner: DevSessionOwner
    source: { kind: 'workspace'; entryPath: string; workspace: WorkspaceStore } | { kind: 'bundle'; bundle: string }
  }): Promise<VerifyReport & { slot?: DevSlot }>
  dropDevSlot(name: string): void
  devSlots(): DevSlotView[]

  reload(name: string): Promise<VerifyReport>
  restart(): Promise<{ ok: number; failed: number }>
}

function requireIdShape(name: string): void {
  if (!ID_SHAPE.test(name)) {
    throw new EnkakuError('E_BAD_REQUEST', `plugin name must match ${ID_SHAPE}, got "${name}"`)
  }
}

export function createPluginRuntime(deps: PluginRuntimeDeps): PluginRuntime {
  const { db, dataDir, registry, kv } = deps
  const devSlots = deps.devSlots ?? createDevSlotStore()
  const runVerify = deps.verify ?? ((bundlePath, opts) => verifyPluginBundle(bundlePath, opts))

  function findRow(name: string, version: string): PluginRow | null {
    return db.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.version, version))).get() ?? null
  }

  function scriptCountFor(pluginId: string): number {
    return db.select().from(scripts).where(eq(scripts.pluginId, pluginId)).all().length
  }

  /** Writes the N `scripts` rows a plugin version's manifest describes — never deletes an older version's rows (§3.9's "superseded still resolves pinned refs"). Idempotent: re-activating (or re-verifying then re-activating) the same version does not duplicate rows. */
  function writeScriptRows(p: PluginRow, manifest: NonNullable<PluginRow['manifest']>): void {
    const m = manifest as { scripts: { id: string; paramsSchema: unknown }[] }
    for (const s of m.scripts) {
      const scriptId = `${p.id}:${s.id}`
      const existing = db.select().from(scripts).where(eq(scripts.id, scriptId)).get()
      if (existing) continue
      db.insert(scripts)
        .values({
          id: scriptId,
          name: `${p.name}/${s.id}`,
          version: p.version,
          bundle: p.bundle,
          source: p.source,
          paramsSchema: s.paramsSchema,
          enabled: true,
          createdBy: p.createdBy,
          createdAt: new Date(),
          pluginId: p.id,
          exportId: s.id,
        })
        .run()
    }
  }

  const listImpl = (q?: { name?: string }): PluginView[] => {
    const rows = q?.name ? db.select().from(plugins).where(eq(plugins.name, q.name)).all() : db.select().from(plugins).all()
    return rows.map((r) => ({ ...r, scriptCount: scriptCountFor(r.id) }))
  }

  const getImpl = (name: string, version: string): PluginRow | null => findRow(name, version)

  const activeImpl = (name: string): PluginRow | null =>
    db.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.status, 'active'))).get() ?? null

  const stageImpl = async (input: StagePluginInput): Promise<PluginRow> => {
    requireIdShape(input.name)
    if (findRow(input.name, input.version)) {
      throw new EnkakuError('plugin_version_exists', `${input.name}@${input.version} already exists`)
    }
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(input.bundle)
    const bundleHash = hasher.digest('hex')
    const values: PluginRow = {
      id: crypto.randomUUID(),
      name: input.name,
      version: input.version,
      title: null,
      description: null,
      bundle: input.bundle,
      source: input.source ?? null,
      bundleHash,
      status: 'staged',
      verifiedAt: null,
      verifyError: null,
      verifyErrorCode: null,
      manifest: null,
      resetPackages: null,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
    }
    db.insert(plugins).values(values).run()
    return values
  }

  const verifyImpl = async (pluginId: string): Promise<VerifyReport> => {
    const p = db.select().from(plugins).where(eq(plugins.id, pluginId)).get()
    if (!p) throw new EnkakuError('plugin_not_found', `no such plugin: ${pluginId}`)
    db.update(plugins).set({ status: 'verifying' }).where(eq(plugins.id, pluginId)).run()

    const bundlePath = await materializeBundleText(dataDir, p.bundle)
    const report = await runVerify(bundlePath, { expectedVersion: p.version })

    if (!report.ok) {
      db.update(plugins)
        .set({ status: 'failed', verifyError: report.error ?? 'verification failed', verifyErrorCode: report.errorCode ?? 'E_PLUGIN_VERIFY_FAILED' })
        .where(eq(plugins.id, pluginId))
        .run()
      registry.invalidate(p.name)
      return report
    }

    // Two plugins claiming the same script NAME is a conflict, not a crash (§3.8) — the
    // already-active one keeps it, the newcomer is failed, naming both. Because a member's
    // name is always `<pluginName>/<scriptId>`, the only two ways this can happen are: (a) a
    // STANDALONE script already publishing under that exact literal name (nothing stops
    // `POST /api/scripts` from choosing a name with a slash in it), or (b) — kept as
    // defense in depth, since it cannot occur through this plan's own naming rule — a
    // `scripts` row whose OWNING PLUGIN has a different `name` than this one. A new VERSION
    // of the SAME plugin re-publishing `tiktok/login` is the normal case (an earlier
    // version's row still exists, pointing at a different `plugins.id`, same `name`) and is
    // never a conflict.
    for (const s of report.scripts) {
      const scriptName = `${p.name}/${s.id}`
      const existingRows = db.select().from(scripts).where(eq(scripts.name, scriptName)).all()
      for (const existing of existingRows) {
        const owner = existing.pluginId ? db.select().from(plugins).where(eq(plugins.id, existing.pluginId)).get() : null
        const ownerLabel = owner ? owner.name : 'a standalone script'
        const isConflict = owner ? owner.name !== p.name : true
        if (!isConflict) continue
        const err = `E_PLUGIN_NAME_CONFLICT: "${scriptName}" is already owned by ${owner ? `plugin "${ownerLabel}"` : ownerLabel} — "${p.name}" cannot also claim it`
        // The manifest is persisted here too (not just left null, the way the
        // other failure branches above have to) — a name conflict is the one
        // failure mode where the bundle DID finish importing and DID report
        // its full script list before the conflict check refused activation.
        // Keeping it lets the Plugins page say which scripts this version
        // would have registered, none of which actually did (§4.6: "which
        // scripts registered and which did not").
        db.update(plugins)
          .set({ status: 'failed', verifyError: err, verifyErrorCode: 'E_PLUGIN_NAME_CONFLICT', manifest: { scripts: report.scripts } })
          .where(eq(plugins.id, pluginId))
          .run()
        registry.invalidate(p.name)
        return { ok: false, error: err, errorCode: 'E_PLUGIN_NAME_CONFLICT', scripts: report.scripts, resetPackages: [] }
      }
    }

    db.update(plugins)
      .set({
        status: 'staged',
        verifiedAt: new Date(),
        verifyError: null,
        verifyErrorCode: null,
        manifest: { scripts: report.scripts },
        resetPackages: report.resetPackages.length > 0 ? { packages: report.resetPackages } : null,
        title: report.title ?? p.title,
        description: report.description ?? p.description,
      })
      .where(eq(plugins.id, pluginId))
      .run()
    registry.invalidate(p.name)
    return report
  }

  const activateImpl = (pluginId: string, expectedStatus: 'staged' = 'staged'): PluginRow => {
    return db.transaction((tx) => {
      const p = tx.select().from(plugins).where(eq(plugins.id, pluginId)).get()
      if (!p) throw new EnkakuError('plugin_not_found', `no such plugin: ${pluginId}`)
      if (!p.verifiedAt || !p.manifest) {
        throw new EnkakuError('plugin_not_verified', `${p.name}@${p.version} has not passed verification`)
      }
      // The CAS: only an UPDATE that matched a row still in `expectedStatus`
      // counts — two concurrent `activate` calls can both read `staged`, but
      // only one of the two `UPDATE ... WHERE status = 'staged'` calls
      // changes a row (criterion 9). bun:sqlite is a single synchronous
      // connection, so within one process this is already atomic; wrapped in
      // `db.transaction` so the guarantee holds even if that ever changes.
      const result = tx
        .update(plugins)
        .set({ status: 'active' })
        .where(and(eq(plugins.id, pluginId), eq(plugins.status, expectedStatus)))
        .run()
      if (changedRows(result) === 0) {
        const fresh = tx.select().from(plugins).where(eq(plugins.id, pluginId)).get()
        throw new EnkakuError(
          'plugin_activate_conflict',
          `${p.name}@${p.version} is "${fresh?.status ?? 'unknown'}", not "${expectedStatus}" — it may already be active, or another activation won the race`,
        )
      }
      const previous = tx
        .select()
        .from(plugins)
        .where(and(eq(plugins.name, p.name), eq(plugins.status, 'active')))
        .all()
        .filter((r) => r.id !== pluginId)
      for (const old of previous) {
        tx.update(plugins).set({ status: 'superseded' }).where(eq(plugins.id, old.id)).run()
      }
      writeScriptRows(p, p.manifest as NonNullable<PluginRow['manifest']>)
      registry.invalidate(p.name)
      return { ...p, status: 'active' }
    })
  }

  const rollbackImpl = (name: string, toVersion: string): PluginRow => {
    return db.transaction((tx) => {
      const target = tx.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.version, toVersion))).get()
      if (!target) throw new EnkakuError('plugin_not_found', `no such plugin version: ${name}@${toVersion}`)
      if (target.status !== 'superseded' && target.status !== 'active') {
        throw new EnkakuError('plugin_not_rollbackable', `${name}@${toVersion} is "${target.status}", not a previously active version`)
      }
      if (target.status === 'active') return target
      const current = tx.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.status, 'active'))).get()
      if (current) tx.update(plugins).set({ status: 'superseded' }).where(eq(plugins.id, current.id)).run()
      tx.update(plugins).set({ status: 'active' }).where(eq(plugins.id, target.id)).run()
      // No re-publish, no bundle upload (criterion 8) — the target's `scripts` rows were
      // already written when IT was first activated and were never deleted.
      registry.invalidate(name)
      return { ...target, status: 'active' }
    })
  }

  const disableImpl = (name: string): void => {
    db.transaction((tx) => {
      const activeRow = tx.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.status, 'active'))).get()
      if (!activeRow) throw new EnkakuError('plugin_not_found', `no active plugin named "${name}"`)
      tx.update(plugins).set({ status: 'disabled' }).where(eq(plugins.id, activeRow.id)).run()
      const rows = tx.select().from(scripts).where(eq(scripts.pluginId, activeRow.id)).all()
      for (const s of rows) tx.update(scripts).set({ enabled: false }).where(eq(scripts.id, s.id)).run()
    })
    registry.invalidate(name)
  }

  const removeImpl = (name: string, version: string, opts: { deleteKv: boolean }): RemovalSummary => {
    const target = findRow(name, version)
    if (!target) return { removed: false, kvDeleted: 0 }
    const rows = db.select().from(scripts).where(eq(scripts.pluginId, target.id)).all()
    db.delete(plugins).where(eq(plugins.id, target.id)).run()
    for (const s of rows) db.delete(scripts).where(eq(scripts.id, s.id)).run()
    registry.invalidate(name)

    let kvDeleted = 0
    if (opts.deleteKv) {
      kvDeleted += kv.deleteNamespace({ kind: 'global' }, name)
      const allDevices = db.select({ stableId: devices.stableId }).from(devices).all()
      for (const d of allDevices) kvDeleted += kv.deleteNamespace({ kind: 'device', stableId: d.stableId }, name)
    }
    return { removed: true, kvDeleted }
  }

  const putDevSlotImpl = async (input: {
    name: string
    owner: DevSessionOwner
    source: { kind: 'workspace'; entryPath: string; workspace: WorkspaceStore } | { kind: 'bundle'; bundle: string }
  }): Promise<VerifyReport & { slot?: DevSlot }> => {
    requireIdShape(input.name)
    const bundle =
      input.source.kind === 'workspace'
        ? (await buildScriptFromWorkspace(input.source.workspace, input.source.entryPath)).bundle
        : input.source.bundle
    const bundlePath = await materializeBundleText(dataDir, bundle)
    const report = await runVerify(bundlePath)
    if (!report.ok) {
      devSlots.putFailed(input.name, report.error ?? 'verification failed')
      registry.invalidate(input.name)
      return report
    }
    const slot = devSlots.put({
      pluginName: input.name,
      declaredVersion: report.version ?? '0.0.0',
      bundlePath,
      scripts: report.scripts.map((s) => ({ exportId: s.id, paramsSchema: s.paramsSchema })),
      owner: input.owner,
    })
    registry.invalidate(input.name)
    return { ...report, slot }
  }

  const dropDevSlotImpl = (name: string): void => {
    devSlots.drop(name)
    registry.invalidate(name)
  }

  const devSlotsImpl = (): DevSlotView[] => devSlots.list().map((s) => ({ ...s, kvNamespace: s.pluginName }))

  const reloadImpl = async (name: string): Promise<VerifyReport> => {
    const activeRow = activeImpl(name)
    const failedRows = db.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.status, 'failed'))).all()
    const target = failedRows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0] ?? activeRow
    if (!target) throw new EnkakuError('plugin_not_found', `no such plugin: ${name}`)
    const report = await verifyImpl(target.id)
    // criterion 25 — a `failed` plugin whose bundle has since been fixed reaches `active`
    // automatically on reload, without a separate explicit `activate` call.
    if (report.ok && target.status !== 'active') {
      try {
        activateImpl(target.id, 'staged')
      } catch {
        // Lost a race against a concurrent activation of the SAME row — fine, someone else did it.
      }
    }
    return report
  }

  const restartImpl = async (): Promise<{ ok: number; failed: number }> => {
    registry.invalidate()
    let ok = 0
    let failed = 0
    for (const p of db.select().from(plugins).where(eq(plugins.status, 'active')).all()) {
      const bundlePath = await materializeBundleText(dataDir, p.bundle)
      const report = await runVerify(bundlePath, { expectedVersion: p.version })
      if (report.ok) {
        ok++
      } else {
        // A restart never disturbs a running job and never demotes an already-`active`
        // plugin (§3.9's own table) — an active plugin that now fails re-verification is
        // recorded as a warning (`verifyError` updated) but keeps resolving until an
        // operator explicitly disables it.
        failed++
        db.update(plugins)
          .set({ verifyError: report.error ?? 'restart re-verify failed', verifyErrorCode: report.errorCode ?? 'E_PLUGIN_VERIFY_FAILED' })
          .where(eq(plugins.id, p.id))
          .run()
      }
    }
    for (const failedRow of db.select().from(plugins).where(eq(plugins.status, 'failed')).all()) {
      const report = await reloadImpl(failedRow.name)
      if (report.ok) ok++
      else failed++
    }
    devSlots.sweep()
    return { ok, failed }
  }

  return {
    list: listImpl,
    get: getImpl,
    active: activeImpl,
    stage: stageImpl,
    verify: verifyImpl,
    activate: activateImpl,
    rollback: rollbackImpl,
    disable: disableImpl,
    remove: removeImpl,
    putDevSlot: putDevSlotImpl,
    dropDevSlot: dropDevSlotImpl,
    devSlots: devSlotsImpl,
    reload: reloadImpl,
    restart: restartImpl,
  }
}
