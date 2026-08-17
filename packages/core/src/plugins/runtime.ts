import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { validatePluginSurface, type PluginSurface } from '@enkaku/protocol'
import type { Db } from '../db'
import { devices, plugins, scripts, type PluginRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { changedRows } from '../db'
import type { KvStore } from '../kv/store'
import { materializeBundleText } from '../scripts/bundle-cache'
import type { ScriptRegistry } from '../scripts/registry'
import { createPluginAssetStore, type StoredAsset } from './asset-store'
import type { PluginPackageAsset } from './package'
import { verifyPluginBundle, type VerifyReport } from './verify-child'
import { createDevSlotStore, type DevSessionOwner, type DevSlot, type DevSlotStore } from './dev-slots'
import { isSyntheticPluginName, reservedPluginNameError, syntheticPluginError } from './owner'
import { buildScriptFromWorkspace } from '../scripts/build'
import type { WorkspaceStore } from '../workspace/store'

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Just enough of the `plugins.manifest` JSON column to reach the surface out
 * of it (plan 108 §5 step 108.3). A Zod parse rather than a cast, because
 * `manifest` is a JSON column: whatever is in it was written by some earlier
 * version of this code, and "written by us once" is not the same guarantee as
 * "shaped the way today's code expects". A manifest written before the
 * surface existed simply has no `surface` key and reads back as `undefined`.
 */
const ManifestSurfaceEnvelopeSchema = z.object({ surface: z.unknown().optional() })

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
  /**
   * A `.enkaku` package's `ui/` payload (plan 108 §3.8, §5 step 108.10),
   * already read and allowlisted by `readPluginPackage`. Absent for the JSON
   * transport, which carries a bundle and nothing else — a plugin published
   * that way simply has no tier-B assets, exactly as before this step.
   *
   * Written to disk BEFORE the row is inserted, so a version that exists is a
   * version whose assets exist: `GET /:name/ui/*` reads them off the ACTIVE
   * row, and activation can only follow a stage that already finished.
   */
  ui?: readonly PluginPackageAsset[]
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
  /**
   * The ACTIVE version's verified surface (plan 108 §5 step 108.3), or `null`
   * — for a plugin that is not active, one that declared no surface, or one
   * whose stored manifest no longer parses as a surface today.
   *
   * `null` and never a throw, on the same discipline `parseScriptRuntime`
   * follows: this is read on the way to rendering a screen, and a manifest
   * written by an older shape must degrade to "this plugin contributes no
   * screen" rather than to a 500 on a page that has nothing to do with it
   * (§3.8, "assembling the script registry never throws").
   */
  surface(name: string): PluginSurface | null

  /**
   * One tier-B asset of the ACTIVE version of `name` (plan 108 §4.4, §5 step
   * 108.10), by its exact path relative to the package's `ui/` directory.
   *
   * `null` — never a throw — for every miss there is: a plugin that is not
   * active, an active version that shipped no `ui/`, and a path the package
   * did not declare. The caller turns all three into one 404, because telling
   * them apart would tell an unauthenticated prober which of the three it hit.
   *
   * A DEV SLOT has no assets and is not consulted: a slot is built from a
   * BUNDLE (`enkaku dev` pushes `scripts.mjs`, never an archive), so there is
   * no `ui/` payload for it to carry. A tier-B screen is exercised against a
   * published package.
   */
  uiAsset(name: string, path: string): Promise<StoredAsset | null>

  stage(input: StagePluginInput): Promise<PluginRow>
  verify(pluginId: string): Promise<VerifyReport>
  activate(pluginId: string, expectedStatus?: 'staged'): PluginRow
  rollback(name: string, toVersion: string): PluginRow
  disable(name: string): void
  /**
   * The way back from `disable` — `disabled` → `active`, plus the member
   * `scripts` rows `disable` switched off.
   *
   * It exists because none of the other three transitions can reach a
   * `disabled` row: `activate` CASes on `staged`, `rollback` requires
   * `superseded`/`active`, and `reload` looks only for a `failed` or the
   * `active` row. Without this method a disabled plugin is disabled forever.
   *
   * Refuses (`plugin_enable_conflict`) when a DIFFERENT version of the same
   * name is currently active: every `active`-based lookup in this file
   * (`activeImpl`, and so `surface`/`uiAsset`/the whole surface registry)
   * assumes at most one active row per name, and enabling would break that.
   * Switching between two versions is `rollback`'s job, not this one's.
   */
  enable(name: string): PluginRow
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

/**
 * Plan 110 §3.4, §4.3 — every lifecycle verb refuses a synthetic owner
 * (`recordings`). Enforced here, in the runtime, and not by omitting a button:
 * `api/plugins.ts`'s routes, the dev-slot path, `reload` and `restart` all
 * come through these same functions, so there is no second door.
 */
function refuseSynthetic(name: string, verb: string): void {
  if (isSyntheticPluginName(name)) throw syntheticPluginError(name, verb)
}

export function createPluginRuntime(deps: PluginRuntimeDeps): PluginRuntime {
  const { db, dataDir, registry, kv } = deps
  const devSlots = deps.devSlots ?? createDevSlotStore()
  const runVerify = deps.verify ?? ((bundlePath, opts) => verifyPluginBundle(bundlePath, opts))
  // Plan 108 §5 step 108.10 — `dataDir` was already here (it is what
  // `materializeBundleText` writes under); the tier-B payload lives beside the
  // bundle cache rather than in a new database column.
  const assets = createPluginAssetStore(dataDir)

  function findRow(name: string, version: string): PluginRow | null {
    return db.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.version, version))).get() ?? null
  }

  function scriptCountFor(pluginId: string): number {
    return db.select().from(scripts).where(eq(scripts.pluginId, pluginId)).all().length
  }

  /** Writes the N `scripts` rows a plugin version's manifest describes — never deletes an older version's rows (§3.9's "superseded still resolves pinned refs"). Idempotent: re-activating (or re-verifying then re-activating) the same version does not duplicate rows. */
  function writeScriptRows(p: PluginRow, manifest: NonNullable<PluginRow['manifest']>): void {
    const m = manifest as { scripts: { id: string; paramsSchema: unknown; resultSchema?: unknown; runtime?: unknown }[] }
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
          // Plan 97 §4.4, §4.7, §5 step 97.2 — already `checkDeclaredSchema`-gated
          // by the verify child; `?? null` only guards a MANIFEST written before
          // this field existed, never a fresh verify, mirroring `runtime` below.
          resultSchema: s.resultSchema ?? null,
          // Plan 98 §3.1, §4.4, §5 step 98.4 — already validated by the
          // verify child (`verify-child-entry.ts`); `?? null` only guards a
          // MANIFEST written before this field existed (plan 82's `manifest`
          // JSON column predates this plan), never a fresh verify.
          runtime: s.runtime ?? null,
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

  const surfaceImpl = (name: string): PluginSurface | null => {
    const row = activeImpl(name)
    if (!row?.manifest) return null
    const envelope = ManifestSurfaceEnvelopeSchema.safeParse(row.manifest)
    if (!envelope.success || envelope.data.surface === undefined) return null
    // Re-validated on READ, not trusted because it was validated on write:
    // the row may predate today's vocabulary, and `validatePluginSurface` is
    // the same single gate the verify parent, the verify child, and
    // `definePlugin` all run, so none of the four can disagree.
    const checked = validatePluginSurface(envelope.data.surface)
    return checked.ok ? checked.value : null
  }

  const uiAssetImpl = async (name: string, path: string): Promise<StoredAsset | null> => {
    const row = activeImpl(name)
    if (!row) return null
    return assets.read(row.id, path)
  }

  const stageImpl = async (input: StagePluginInput): Promise<PluginRow> => {
    requireIdShape(input.name)
    // Plan 110 §4.3 — refused here as well as at verify (below), so a reserved
    // name never reaches the database at all: `resolveRecordingsOwner` finds
    // the farm's own `recordings` row BY NAME, and a foreign staged row of that
    // name would be indistinguishable from it.
    if (isSyntheticPluginName(input.name)) throw reservedPluginNameError(input.name)
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
    // Assets first, row second (step 108.10): a `plugins` row that exists is
    // then always a row whose `ui/` payload is already on disk, so nothing
    // between here and activation has to cope with a half-staged version. A
    // failure writing them leaves no row at all, which is the state a retry
    // expects.
    if (input.ui && input.ui.length > 0) await assets.put(values.id, input.ui)
    db.insert(plugins).values(values).run()
    return values
  }

  const verifyImpl = async (pluginId: string): Promise<VerifyReport> => {
    const p = db.select().from(plugins).where(eq(plugins.id, pluginId)).get()
    if (!p) throw new EnkakuError('plugin_not_found', `no such plugin: ${pluginId}`)
    // Plan 110 §4.3, criterion 5 — a reserved name is refused AT VERIFY, and
    // the row is left exactly as it was: marking it `failed` the way a genuine
    // verification failure does would take every published recording offline
    // with it, since the synthetic owner is the row this would be run against.
    if (isSyntheticPluginName(p.name)) throw reservedPluginNameError(p.name)
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
    // row published before a script had to belong to a plugin (plan 110 §3.2) that chose that
    // exact literal name, slash and all — the farm no longer resolves such a row
    // (`isUnownedScriptRow`), but it still occupies its `(name, version)`, so claiming the name
    // over it would collide on the unique index rather than fail cleanly here — or (b) — kept as
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
        const ownerLabel = owner ? owner.name : 'a script published before a script had to belong to a plugin'
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
        // Plan 108 §5 step 108.3 — the verified surface rides alongside
        // `scripts` in the same JSON column, so the screen a plugin
        // contributes survives a core restart exactly as its script list
        // does, with no schema change (the column is already JSON). Spread
        // conditionally: a plugin that declared no surface writes the manifest
        // it wrote before this plan, key for key (acceptance criterion 1).
        manifest: { scripts: report.scripts, ...(report.surface !== undefined ? { surface: report.surface } : {}) },
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
      refuseSynthetic(p.name, 'activated')
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
    refuseSynthetic(name, 'rolled back')
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
    refuseSynthetic(name, 'disabled')
    db.transaction((tx) => {
      const activeRow = tx.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.status, 'active'))).get()
      if (!activeRow) throw new EnkakuError('plugin_not_found', `no active plugin named "${name}"`)
      tx.update(plugins).set({ status: 'disabled' }).where(eq(plugins.id, activeRow.id)).run()
      const rows = tx.select().from(scripts).where(eq(scripts.pluginId, activeRow.id)).all()
      for (const s of rows) tx.update(scripts).set({ enabled: false }).where(eq(scripts.id, s.id)).run()
    })
    registry.invalidate(name)
  }

  const enableImpl = (name: string): PluginRow => {
    refuseSynthetic(name, 'enabled')
    const row = db.transaction((tx) => {
      const target = tx.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.status, 'disabled'))).get()
      const current = tx.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.status, 'active'))).get()
      if (!target) {
        // Naming what was looked for, and — when there IS an active row — why
        // there is nothing to enable: that is the shape a second (double-click,
        // or lost-race) enable takes, and "no disabled plugin" alone would read
        // like the plugin had vanished.
        const alsoActive = current ? ` (${name}@${current.version} is already active)` : ''
        throw new EnkakuError('plugin_not_found', `no disabled plugin named "${name}" — nothing to enable${alsoActive}`)
      }
      if (current) {
        throw new EnkakuError(
          'plugin_enable_conflict',
          `${name}@${current.version} is active — enabling ${name}@${target.version} would leave two active versions of "${name}"; roll back to ${target.version} instead`,
        )
      }
      // The same CAS `activateImpl` uses, for the same reason (criterion 9):
      // only an UPDATE that matched a row STILL `disabled` counts, so two
      // concurrent enables cannot both win. Within one process bun:sqlite is a
      // single synchronous connection and the `disabled` lookup above already
      // refuses the loser, but the guarantee must not depend on that.
      const result = tx
        .update(plugins)
        .set({ status: 'active' })
        .where(and(eq(plugins.id, target.id), eq(plugins.status, 'disabled')))
        .run()
      if (changedRows(result) === 0) {
        const fresh = tx.select().from(plugins).where(eq(plugins.id, target.id)).get()
        throw new EnkakuError(
          'plugin_enable_conflict',
          `${name}@${target.version} is "${fresh?.status ?? 'unknown'}", not "disabled" — another enable won the race`,
        )
      }
      // `writeScriptRows` (what activation runs) deliberately skips rows that
      // already exist, so it would NOT undo what `disable` did to them —
      // re-enabling the member rows is this method's own job, and the half of
      // the round trip that is easy to forget: without it the row says
      // `active` while every one of its scripts still refuses to resolve.
      for (const s of tx.select().from(scripts).where(eq(scripts.pluginId, target.id)).all()) {
        tx.update(scripts).set({ enabled: true }).where(eq(scripts.id, s.id)).run()
      }
      return { ...target, status: 'active' as const }
    })
    registry.invalidate(name)
    return row
  }

  const removeImpl = (name: string, version: string, opts: { deleteKv: boolean }): RemovalSummary => {
    refuseSynthetic(name, 'removed')
    const target = findRow(name, version)
    if (!target) return { removed: false, kvDeleted: 0 }
    const rows = db.select().from(scripts).where(eq(scripts.pluginId, target.id)).all()
    db.delete(plugins).where(eq(plugins.id, target.id)).run()
    for (const s of rows) db.delete(scripts).where(eq(scripts.id, s.id)).run()
    // The removed version's tier-B payload goes with it (step 108.10). Done
    // AFTER the row is gone, so a crash in between leaves orphaned bytes
    // rather than a live row whose screen 404s.
    assets.remove(target.id)
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
    // A dev slot shadows a published plugin by NAME (`scripts/registry.ts`), so
    // one named `recordings` would shadow every published recording — the same
    // collision §4.3 reserves the name against, arriving by a different door.
    if (isSyntheticPluginName(input.name)) throw reservedPluginNameError(input.name)
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
      scripts: report.scripts.map((s) => ({ exportId: s.id, paramsSchema: s.paramsSchema, runtime: s.runtime })),
      // Plan 108 §5 step 108.6 — carried straight off the report the verify
      // child already re-validated (`verify-child.ts` runs the SAME
      // `validatePluginSurface` gate a published bundle passes), so a dev
      // build contributes its sidebar entry without ever becoming a row.
      surface: report.surface ?? null,
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
    refuseSynthetic(name, 'reloaded')
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
      // Plan 110 §3.4, §4.3 — a row that never passed verification is not
      // re-verified here. That is the synthetic `recordings` owner (whose
      // "bundle" is a comment) and any owner row created by a direct publish
      // (`plugins/owner.ts`), neither of which has a verify child to run:
      // handing either to one would record a `verifyError` about a bundle the
      // farm itself wrote and never intended to import. A real plugin always
      // has `verifiedAt` set — `activate` refuses without it — so nothing that
      // was re-verified before this rule stops being.
      if (p.verifiedAt === null) continue
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
    surface: surfaceImpl,
    uiAsset: uiAssetImpl,
    stage: stageImpl,
    verify: verifyImpl,
    activate: activateImpl,
    rollback: rollbackImpl,
    disable: disableImpl,
    enable: enableImpl,
    remove: removeImpl,
    putDevSlot: putDevSlotImpl,
    dropDevSlot: dropDevSlotImpl,
    devSlots: devSlotsImpl,
    reload: reloadImpl,
    restart: restartImpl,
  }
}
