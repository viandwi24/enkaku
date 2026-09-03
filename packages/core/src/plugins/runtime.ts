import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  planPluginVersionRemoval,
  PluginServiceDeclarationSchema,
  unsupportedIsolationMessage,
  validatePluginSurface,
  type PluginServiceDeclaration,
  type PluginSurface,
  type PluginVersionRemovalResult,
  type PluginVersionRemovalScope,
} from '@enkaku/protocol'
import type { Db } from '../db'
import { devices, jobs, plugins, scripts, type PluginRow } from '../db/schema'
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
 * The same discipline for plan 109's `service` block (§4.1, step 109.2): a
 * manifest written before services existed simply has no `service` key and
 * reads back as `undefined`, which is exactly "this plugin has no long-lived
 * half" — never an error, and never a reason a Plugins page fails to render.
 */
const ManifestServiceEnvelopeSchema = z.object({ service: z.unknown().optional() })

/**
 * Plan 126 §3.2 — the ONLY two things `GET /api/plugins` reads out of a
 * version's `manifest`: each declared member's id and human title, and whether
 * a service was declared at all.
 *
 * A Zod parse and not a cast, for the reason the two envelopes above are: this
 * is a JSON column written by whatever version of the core published the row. A
 * `z.object` also STRIPS what it does not name, which is doing real work here
 * rather than being incidental — `paramsSchema`/`resultSchema`/`runtime` are a
 * full JSON Schema per member per version, and this is the boundary that leaves
 * them behind instead of carrying them to a screen that reads neither.
 *
 * `.optional()` on `scripts` rather than a required array: a `failed` version
 * whose bundle never got far enough to report a manifest has no member list at
 * all, and that must read as "declared nothing", never as a parse failure on
 * the way to rendering the Plugins page.
 */
const ManifestListProjectionSchema = z.object({
  scripts: z.array(z.object({ id: z.string(), title: z.string().optional() })).optional(),
  service: z.unknown().optional(),
})

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

/**
 * The identity columns every read of the `plugins` table hands OUT of this
 * module — plan 126 §3.1.
 *
 * Stated as a type, and selected column-by-column by the two queries below,
 * because the alternative is what this plan exists to undo: `db.select()` with
 * no argument is `SELECT *`, `PluginRow` is `typeof plugins.$inferSelect`, and
 * a spread of that carries `bundle` — the complete built JavaScript pack, ~1 MB
 * per version row — onto the wire for a screen that renders none of it. Four
 * columns are absent here **by construction**: `bundle`, `source`, `bundleHash`
 * and `resetPackages`. A fifth one added to the table tomorrow is absent too,
 * until someone deliberately names it, which is the whole difference between a
 * projection and a post-filter (`api/plugins.ts`'s `data/scan` states the same
 * rule: *"Selected narrowly rather than filtered later, so a seventh field
 * cannot arrive by accident."*).
 *
 * `Date` and not a number: `mode: 'timestamp'` columns come back as `Date`s and
 * `api/plugins.ts` sends them straight through `c.json()`, so they reach the
 * wire as ISO strings. That is the existing format `PluginRowSchema` and
 * `PluginListItemSchema` both declare; see the protocol file's header note.
 */
export interface PluginIdentity {
  id: string
  name: string
  version: string
  title: string | null
  description: string | null
  status: string
  verifiedAt: Date | null
  verifyError: string | null
  verifyErrorCode: string | null
  createdBy: string | null
  createdAt: Date
}

/**
 * One row of `runtime.list()` — the wire shape of `GET /api/plugins`'s `items`
 * (`PluginListItemSchema` in `@enkaku/protocol`).
 *
 * No `manifest`. The two things the list renders out of one are projected here
 * instead (§3.2), so a version's declared JSON Schemas and its whole declared
 * SCREEN stop riding along on every row of a history twenty versions deep. A
 * caller that needs the manifest itself asks for one version — `runtime.get`,
 * `GET /api/plugins/:name/:version` — which is the read that is scoped to a row
 * someone actually opened.
 */
export interface PluginView extends PluginIdentity {
  scriptCount: number
  /** `manifest.scripts` projected to what the list reads: id and title, never a schema. */
  declaredScripts: { id: string; title?: string }[]
  /** Whether `manifest.service` is present at all — the "service" chip, and nothing more. */
  hasService: boolean
}

/**
 * **One version, and the ONLY plugin-row shape this module hands to a route**
 * — `PluginRowSchema`'s counterpart on the core side (plan 126 §3.3, §126.6).
 *
 * The home of `manifest`, which is why the detail page reads
 * `manifest.surface`/`manifest.service` from here and not from the list.
 *
 * Still no `bundle`/`source`/`bundleHash`/`resetPackages`: no route renders any
 * of them, `PluginRowSchema` never declared any of them, so the same projection
 * §3.1 applies to the reads applies here. Code that needs a version's actual
 * bundle reads the row inside this module (`findRow`, `activeImpl`), where it
 * never crosses a wire.
 *
 * ## Why it is called `Wire` and not `Detail` (step 126.6)
 *
 * It began as the detail route's shape alone. Step 126.1 fixed the two READ
 * routes and left the write ones — `POST /api/plugins`, `POST /:id/activate`,
 * `POST /:name/rollback`, `POST /:name/enable` — each answering `{ plugin }`
 * with a raw `PluginRow` straight out of the table, **so a publish sent the
 * ~1 MB bundle up and got the same ~1 MB straight back down**, and every
 * activate/rollback/enable paid it too. The client discarded all of it, exactly
 * as the list's copy was discarded, because `PluginRowSchema` declares none of
 * those columns.
 *
 * That fix could not be a query projection the way §3.1's was: those handlers
 * legitimately hold the complete row (activation writes `p.bundle` into every
 * member's `scripts` row). So it is a projection at the module boundary, and
 * the choice that matters is *where* it is applied. A `toPluginWire(row)` that
 * `api/plugins.ts` had to remember to call at each `c.json({ plugin })` is a
 * post-filter with extra steps — the seventh route added next year forgets it,
 * silently, and nobody notices until a farm feels it. Instead the four
 * transition methods RETURN this type: `api/plugins.ts` does not import
 * `PluginRow`, cannot name it, and never holds an object that has a `bundle` on
 * it to echo. Forgetting is not a thing a future route can do here.
 */
export interface PluginWireRow extends PluginIdentity {
  manifest: unknown
  scriptCount: number
}

export interface DevSlotView extends DevSlot {
  kvNamespace: string
}

export interface RemovalSummary {
  removed: boolean
  kvDeleted: number
}

/**
 * What `deleteData` deleted, split the way an operator reads it back: *"12
 * entries — 4 farm-wide and 8 across 3 devices."*
 *
 * The split is not decoration. `docs/feat/kv-storage.md` §1 is explicit that
 * global and device rows are one table on two axes, and an operator who is told
 * only a total cannot tell "this plugin kept one catalogue" from "this plugin
 * had written something onto thirty of my phones" — which is exactly the fact
 * Reset data exists to make visible.
 */
export interface DataDeletionSummary {
  entries: number
  global: number
  device: number
  /** How many devices held at least one row under this namespace. */
  devices: number
}

/**
 * What `removeVersions` reports (plan 82 §3.4's denormalised job history, plus
 * plan 114 §3.9's bulk-report grain). One entry per version the plugin HAD when
 * the request was planned — a kept row is a result, never an omission, which is
 * what lets the caller state "nine went, two stayed" from one array.
 */
export interface BulkRemovalReport {
  plugin: string
  scope: PluginVersionRemovalScope
  total: number
  results: PluginVersionRemovalResult[]
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
  /**
   * Plan 109 §4.2's Load/Unload rows, step 109.2 — "on activate", "on disable,
   * remove, reload". Called AFTER the transition has committed, never inside
   * the transaction that made it: the listener loads plugin code into the
   * core's process, and doing that with a write transaction open would hold a
   * database lock across an arbitrary `setup()`.
   *
   * Fire-and-forget from this file's point of view. A listener that throws is
   * swallowed here, because §3.8's one guarantee — operating on the plugin
   * registry never throws because one plugin is broken — must not be weakened
   * by the thing that exists to contain broken plugins.
   *
   * Optional: absent in every test and in orchestrator mode, where no host
   * exists to load anything.
   */
  onLifecycle?: (event: PluginLifecycleEvent) => void
}

/**
 * What `onLifecycle` reports. `activated` means "this name's active version is
 * now `name@version`" — it covers a first activation, a rollback to an older
 * version, a re-enable, and a reload that re-activated a fixed bundle, because
 * the host's response to all four is identical: unload whatever is loaded
 * under that name and load what is active now.
 */
export interface PluginLifecycleEvent {
  kind: 'activated' | 'deactivated'
  name: string
  version: string
}

export interface PluginRuntime {
  list(q?: { name?: string }): PluginView[]
  get(name: string, version: string): PluginWireRow | null
  /**
   * The ACTIVE row, **complete** — the one method here that still hands out
   * `bundle`, `source`, `bundleHash` and `resetPackages`, because its callers
   * are the ones that genuinely need them: `runtime-host.ts` materialises
   * `row.bundle` to a file to load the service, and `surface-registry.ts`
   * re-parses `row.manifest`.
   *
   * **Never `c.json()` this row** (plan 126 §126.6). Every route that reports a
   * plugin either goes through `get` or through one of the four transitions
   * below, all of which answer `PluginWireRow`; the three routes in
   * `api/plugins.ts` that call this one read a field off it (`.version`, or its
   * mere existence) and serialise nothing. A route that needs to ANSWER with
   * the active row should call `get(name, row.version)`, not send this.
   */
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
   * The ACTIVE version's verified SERVICE declaration (plan 109 §4.1, step
   * 109.2), or `null` — for a plugin that is not active, one that declared no
   * service, one whose stored declaration no longer parses today, and one that
   * asks for an isolation mode this build cannot provide.
   *
   * `null` and never a throw, exactly as `surface` above: this is read on the
   * way to deciding whether to load something, and every one of those four
   * cases means the same thing to the caller — there is nothing here to load.
   */
  service(name: string): PluginServiceDeclaration | null

  /**
   * One tier-B asset of the ACTIVE version of `name` (plan 108 §4.4, §5 step
   * 108.10), by its exact path relative to the package's `ui/` directory.
   *
   * `null` — never a throw — for every miss there is: a plugin that is not
   * active, an active version that shipped no `ui/`, and a path the package
   * did not declare. The caller turns all three into one 404, because telling
   * them apart would tell an unauthenticated prober which of the three it hit.
   *
   * **A DEV SLOT SHADOWS THE ACTIVE ROW** (plan 111 §4.4, §5 step 111.6).
   * Plan 108 §9 Q3 recorded the opposite — a slot was built from a bundle and
   * structurally carried no assets, so a UI could not be iterated with
   * `enkaku dev` at all. `enkaku dev` now pushes a `.enkaku` package, the slot
   * stores its `ui/` under its own key, and this lookup consults the slot
   * FIRST — the same shadowing `scripts/registry.ts` and the surface registry
   * already apply, so a dev build's screen and its scripts never come from two
   * different versions.
   */
  uiAsset(name: string, path: string): Promise<StoredAsset | null>

  /**
   * Stage one version — the row is written in FULL (the bundle is the whole
   * point of staging it), and what comes back is the projection, because the
   * only caller that wants a row back is `POST /api/plugins` answering
   * `{ plugin }` (step 126.6 — see `PluginWireRow`). The two in-process callers
   * (`seed-embedded.ts`, `runtime-host.rejection-child.ts`) read `.id` and hand
   * it to `verify`, which they can still do.
   */
  stage(input: StagePluginInput): Promise<PluginWireRow>
  verify(pluginId: string): Promise<VerifyReport>
  activate(pluginId: string, expectedStatus?: 'staged'): PluginWireRow
  rollback(name: string, toVersion: string): PluginWireRow
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
  enable(name: string): PluginWireRow
  /**
   * One version. Throws `script_in_use` when a queued or running job still
   * names one of that version's scripts — see `removeImpl`.
   */
  remove(name: string, version: string, opts: { deleteKv: boolean }): RemovalSummary

  /**
   * **Everything one plugin has stored, in both scopes** — the sweep behind
   * `?deleteKv=1` and behind `POST /:name/reset`, named once so the two cannot
   * come to mean different sets of rows.
   *
   * `namespace` is the plugin NAME and is taken from the caller's already-
   * resolved path segment, never from a request body: `docs/feat/kv-storage.md`
   * §3 is the rule, and it is what makes the operator-level `plugin.data`
   * permission defensible instead of a way to reach any namespace on the farm.
   *
   * It does NOT touch `plugin_webhooks`. A webhook's secret is farm-minted, has
   * to keep verifying while the plugin is stopped, and is not the plugin's data
   * to lose (`kv-storage.md` §6) — which is why `?deleteKv=1` never swept it
   * either, and why a reset that left a plugin installed and active must not.
   */
  deleteData(name: string): DataDeletionSummary

  /**
   * Many versions, through the SAME door `remove` uses (`removeOne` below) —
   * the farm owner's "remove all version" and "remove all except latest
   * version".
   *
   * There is deliberately no second removal implementation and no direct DB
   * write here: the `script_in_use` guard, the asset cleanup, the registry
   * invalidation and the `deactivated` notification are all `removeOne`'s, so a
   * bulk call cannot skip one of them. What this method adds is the PLAN (which
   * versions are in scope, from `planPluginVersionRemoval` in `@enkaku/protocol`
   * — the same function Studio's confirm dialog calls, so the dialog's promise
   * and the server's behaviour cannot diverge) and the per-version REPORT.
   *
   * **It never throws for a version-level refusal.** Partial success is the
   * normal case: nine removed and two refused is a completed request, and a
   * throw would lose the nine. It still throws for a request-level refusal — a
   * synthetic plugin name, or a name with no versions at all — because those are
   * facts about the request rather than about a row.
   */
  removeVersions(name: string, opts: { scope: PluginVersionRemovalScope; deleteKv: boolean }): BulkRemovalReport

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
    /**
     * The slot's `ui/` payload (plan 111 §4.4) — already allowlisted by
     * `readPluginPackage` when it arrived as a `.enkaku` archive. Absent means
     * "this build declares no assets", and an EMPTY array means the same
     * thing: either way whatever the previous build stored is deleted, so a
     * rebuild that removed the `ui/` directory cannot keep serving yesterday's
     * screen.
     */
    ui?: readonly PluginPackageAsset[]
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

  /**
   * How many `scripts` rows this version registered — plan 126 §0.5, §4.2.
   *
   * A real `COUNT(*)`, and the difference is not academic. This used to be
   * `db.select().from(scripts).where(...).all().length` — a full materialisation
   * of every matching row to produce one integer — over a table whose every row
   * carries the FULL plugin bundle, identical across every member of a version
   * (`db/schema.ts`: *"the row's own `bundle` column holds the FULL plugin
   * bundle, identical across every member"*). Counting tiktok's six scripts read
   * and allocated six copies of a ~900 KB string; across twenty published
   * versions that is ~110 MB read and thrown away to produce twenty integers,
   * on every single request to `GET /api/plugins`.
   *
   * The predicate is unchanged from the query it replaces — `pluginId` and
   * nothing else — so the count it returns is the same one, including for the
   * `disabled`/`superseded` rows whose members stay registered on purpose
   * (§3.9's "superseded still resolves pinned refs"). `api/plugins.ts`'s
   * `data/count` uses this same shape.
   */
  function scriptCountFor(pluginId: string): number {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(scripts)
      .where(eq(scripts.pluginId, pluginId))
      .get()
    return row?.n ?? 0
  }

  /**
   * The columns every row this module hands out is built from — see
   * `PluginIdentity`. One object literal, shared by the list query and the
   * single-version one, so the two cannot come to disagree about what a plugin
   * looks like from outside this file, and so adding a field to the wire is one
   * edit in one place rather than a hunt for every `db.select()`.
   */
  const identityColumns = {
    id: plugins.id,
    name: plugins.name,
    version: plugins.version,
    title: plugins.title,
    description: plugins.description,
    status: plugins.status,
    verifiedAt: plugins.verifiedAt,
    verifyError: plugins.verifyError,
    verifyErrorCode: plugins.verifyErrorCode,
    createdBy: plugins.createdBy,
    createdAt: plugins.createdAt,
  }

  /**
   * A complete `PluginRow` → the only shape this module lets past its edge —
   * plan 126 §126.6.
   *
   * The two READ paths never load the heavy columns at all (§3.1: `listImpl`
   * and `getImpl` name their columns, so `bundle`/`source`/`bundleHash`/
   * `resetPackages` are absent by construction). The four TRANSITION paths
   * cannot do that — `stage` writes the bundle, `activate` copies `p.bundle`
   * into every member's `scripts` row — so they hold the full row for real
   * reasons and project it on the way out, here.
   *
   * **Named keys, not `delete row.bundle` or a rest-spread**, for exactly the
   * reason `api/plugins.ts`'s `data/scan` gives — *"Selected narrowly rather
   * than filtered later, so a seventh field cannot arrive by accident"*. A
   * column added to `plugins` tomorrow is invisible to every route until
   * someone deliberately writes its name on this list; an omission-based filter
   * would have shipped it the day it landed.
   *
   * `scriptCount` costs one `COUNT(*)` (see `scriptCountFor` — a real count
   * since §4.2, not a materialised scan), and it is included so that every
   * `{ plugin }` response on this router has ONE shape, whichever route
   * produced it. `PluginRowSchema` declares it optional, so no client that
   * predates this is affected.
   */
  const toPluginWire = (row: PluginRow): PluginWireRow => ({
    id: row.id,
    name: row.name,
    version: row.version,
    title: row.title,
    description: row.description,
    status: row.status,
    verifiedAt: row.verifiedAt,
    verifyError: row.verifyError,
    verifyErrorCode: row.verifyErrorCode,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    manifest: row.manifest,
    scriptCount: scriptCountFor(row.id),
  })

  /** `manifest` → the two fields the list carries in its place (§3.2). A manifest this build cannot read degrades to "declared nothing", never to a throw on the way to a page. */
  function projectManifest(manifest: unknown): { declaredScripts: { id: string; title?: string }[]; hasService: boolean } {
    const parsed = ManifestListProjectionSchema.safeParse(manifest)
    if (!parsed.success) return { declaredScripts: [], hasService: false }
    return { declaredScripts: parsed.data.scripts ?? [], hasService: parsed.data.service !== undefined }
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

  /**
   * Every version this farm carries — plan 126 §3.1, the line the whole plan is
   * about.
   *
   * `manifest` is selected because the two projected fields below are derived
   * from it; it is NOT part of what comes back out (`PluginView` has no such
   * member), so it never reaches `c.json()`. The four heavy columns are not
   * selected at all.
   *
   * **This is a list of VERSIONS, not of plugins**, and that is what makes the
   * projection load-bearing rather than tidy: a farm that has published
   * repeatedly holds 20+ rows for one name, every one of which used to carry its
   * own ~1 MB copy of the bundle to draw a single `<option>` in a version picker.
   */
  const listImpl = (q?: { name?: string }): PluginView[] => {
    const columns = { ...identityColumns, manifest: plugins.manifest }
    const rows = q?.name
      ? db.select(columns).from(plugins).where(eq(plugins.name, q.name)).all()
      : db.select(columns).from(plugins).all()
    return rows.map(({ manifest, ...identity }) => ({
      ...identity,
      scriptCount: scriptCountFor(identity.id),
      ...projectManifest(manifest),
    }))
  }

  /**
   * ONE version, with its manifest — `GET /api/plugins/:name/:version`.
   *
   * Narrow for the same reason `listImpl` is (§0.1, step 126.1): the detail
   * route renders neither `bundle` nor `source`, and `PluginRowSchema` never
   * declared either, so both were downloaded and discarded. `findRow` — the
   * unprojected read — stays exactly as it was for this module's own callers,
   * which genuinely need the bundle to verify and to write script rows; the
   * difference is that its result now stops at this file's edge.
   */
  const getImpl = (name: string, version: string): PluginWireRow | null => {
    const row = db
      .select({ ...identityColumns, manifest: plugins.manifest })
      .from(plugins)
      .where(and(eq(plugins.name, name), eq(plugins.version, version)))
      .get()
    return row ? { ...row, scriptCount: scriptCountFor(row.id) } : null
  }

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

  const serviceImpl = (name: string): PluginServiceDeclaration | null => {
    const row = activeImpl(name)
    if (!row?.manifest) return null
    const envelope = ManifestServiceEnvelopeSchema.safeParse(row.manifest)
    if (!envelope.success || envelope.data.service === undefined) return null
    // Re-validated on READ for the same reason `surfaceImpl` re-validates a
    // surface, and with more at stake: this is the value that decides whether
    // a bundle's code is imported into the CORE's own process. A row written
    // by an older shape degrades to `null` — "this plugin contributes no
    // service" — rather than to a throw on the way to rendering a page.
    const parsed = PluginServiceDeclarationSchema.safeParse(envelope.data.service)
    if (!parsed.success) return null
    // And the reserved-mode refusal holds on READ too, not only at verify
    // (criterion 7): a row could have been written by a build that had a
    // process host, and this one does not.
    if (unsupportedIsolationMessage(parsed.data.isolation)) return null
    return parsed.data
  }

  const uiAssetImpl = async (name: string, path: string): Promise<StoredAsset | null> => {
    // The dev slot wins when there is one — see `PluginRuntime.uiAsset`.
    const slot = devSlots.get(name)
    if (slot) return assets.read(slot.assetKey, path)
    const row = activeImpl(name)
    if (!row) return null
    return assets.read(row.id, path)
  }

  const stageImpl = async (input: StagePluginInput): Promise<PluginWireRow> => {
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
    // `values` still holds the bundle the caller just uploaded; the projection
    // is what leaves. Without it `POST /api/plugins` echoed the whole upload
    // back in its own 201 (step 126.6).
    return toPluginWire(values)
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
        // Plan 109 §4.1, §5 step 109.2 — the SERVICE declaration rides in the
        // same JSON column for the same reason `surface` does: the host must
        // be able to decide, at boot, whether an already-active plugin has a
        // service to load, WITHOUT importing its bundle into the core's
        // process first. Deciding from the manifest is what keeps "a bad
        // plugin can never block boot" (§4.2) true for the decision itself and
        // not only for the load.
        manifest: {
          scripts: report.scripts,
          ...(report.surface !== undefined ? { surface: report.surface } : {}),
          ...(report.service !== undefined ? { service: report.service } : {}),
        },
        resetPackages: report.resetPackages.length > 0 ? { packages: report.resetPackages } : null,
        title: report.title ?? p.title,
        description: report.description ?? p.description,
      })
      .where(eq(plugins.id, pluginId))
      .run()
    registry.invalidate(p.name)
    return report
  }

  const activateImpl = (pluginId: string, expectedStatus: 'staged' = 'staged'): PluginWireRow => {
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
      // `p` is the full row on purpose — `writeScriptRows` above copies
      // `p.bundle` into each member — and the projection is what the caller
      // gets, so `POST /:id/activate` cannot echo it (step 126.6). The
      // `scriptCount` inside is read AFTER `writeScriptRows`, so it reports the
      // members this activation just registered rather than the previous zero.
      return toPluginWire({ ...p, status: 'active' })
    })
  }

  const rollbackImpl = (name: string, toVersion: string): PluginWireRow => {
    refuseSynthetic(name, 'rolled back')
    return db.transaction((tx) => {
      const target = tx.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.version, toVersion))).get()
      if (!target) throw new EnkakuError('plugin_not_found', `no such plugin version: ${name}@${toVersion}`)
      if (target.status !== 'superseded' && target.status !== 'active') {
        throw new EnkakuError('plugin_not_rollbackable', `${name}@${toVersion} is "${target.status}", not a previously active version`)
      }
      if (target.status === 'active') return toPluginWire(target)
      const current = tx.select().from(plugins).where(and(eq(plugins.name, name), eq(plugins.status, 'active'))).get()
      if (current) tx.update(plugins).set({ status: 'superseded' }).where(eq(plugins.id, current.id)).run()
      tx.update(plugins).set({ status: 'active' }).where(eq(plugins.id, target.id)).run()
      // No re-publish, no bundle upload (criterion 8) — the target's `scripts` rows were
      // already written when IT was first activated and were never deleted.
      registry.invalidate(name)
      return toPluginWire({ ...target, status: 'active' })
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

  const enableImpl = (name: string): PluginWireRow => {
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
      return toPluginWire({ ...target, status: 'active' as const })
    })
    registry.invalidate(name)
    return row
  }

  const removeImpl = (name: string, version: string, opts: { deleteKv: boolean }): RemovalSummary => {
    refuseSynthetic(name, 'removed')
    const target = findRow(name, version)
    if (!target) return { removed: false, kvDeleted: 0 }
    const rows = db.select().from(scripts).where(eq(scripts.pluginId, target.id)).all()

    /**
     * **The same refusal `DELETE /api/scripts/:id` has always given**
     * (`scripts/routes.ts`), applied here because this path deletes the very
     * same `scripts` rows and did not check.
     *
     * That was a real hole, not a theoretical one: `jobs.script_id` carries no
     * foreign key, so removing a plugin version out from under a queued or
     * running job left the job pointing at a row that no longer exists — while
     * `DELETE /api/scripts/:id` refused the identical deletion one route over.
     * Job HISTORY survives either way (plan 82 §3.4 denormalises
     * `jobs.script_name`/`script_version` at enqueue precisely so a deletion
     * cannot erase what already ran), but a job that has not finished yet still
     * needs its bundle.
     *
     * It belongs in the runtime rather than in the route because bulk removal
     * goes through this same function: a guard on the route would protect one
     * deletion and miss eleven, which is the wrong way round.
     */
    if (rows.length > 0) {
      const blocking = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            inArray(
              jobs.scriptId,
              rows.map((s) => s.id),
            ),
            inArray(jobs.status, ['queued', 'running']),
          ),
        )
        .all()
      if (blocking.length > 0) {
        throw new EnkakuError(
          'script_in_use',
          `${blocking.length} queued or running job(s) still use ${name}@${version} — cancel or wait for them before removing this version`,
        )
      }
    }

    db.delete(plugins).where(eq(plugins.id, target.id)).run()
    for (const s of rows) db.delete(scripts).where(eq(scripts.id, s.id)).run()
    // The removed version's tier-B payload goes with it (step 108.10). Done
    // AFTER the row is gone, so a crash in between leaves orphaned bytes
    // rather than a live row whose screen 404s.
    //
    // And for exactly that reason the cleanup cannot be allowed to THROW: the
    // row is already deleted by this line, so a failure here would report a
    // completed removal as a failure — a 500 on the single-version route for a
    // version that is gone, and, worse, a `script_in_use`-shaped refusal entry
    // in a bulk report for a version the same report should say was removed.
    // Orphaned bytes are the accepted outcome of a crash in this window; a lie
    // about what happened is not.
    try {
      assets.remove(target.id)
    } catch {
      // Deliberately swallowed — see above. `restart()`'s dev-slot sweep is the
      // other place stale asset directories are noticed.
    }
    registry.invalidate(name)

    // One sweep, shared with `POST /:name/reset` — see `deleteDataImpl`.
    const kvDeleted = opts.deleteKv ? deleteDataImpl(name).entries : 0
    return { removed: true, kvDeleted }
  }

  const deleteDataImpl = (name: string): DataDeletionSummary => {
    const global = kv.deleteNamespace({ kind: 'global' }, name)
    let device = 0
    let touched = 0
    // Every device row, not only the connected ones: a phone that is offline —
    // or that has been offline for a week — still holds whatever this plugin
    // wrote against its `stableId`, and skipping it would leave the namespace
    // half-deleted with nothing saying so.
    for (const d of db.select({ stableId: devices.stableId }).from(devices).all()) {
      const n = kv.deleteNamespace({ kind: 'device', stableId: d.stableId }, name)
      if (n === 0) continue
      device += n
      touched++
    }
    return { entries: global + device, global, device, devices: touched }
  }

  const putDevSlotImpl = async (input: {
    name: string
    owner: DevSessionOwner
    source: { kind: 'workspace'; entryPath: string; workspace: WorkspaceStore } | { kind: 'bundle'; bundle: string }
    ui?: readonly PluginPackageAsset[]
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
    // Assets before the slot, for the same reason `stage` writes them before
    // the row: a slot that exists is a slot whose screen is already on disk.
    // The key is read off the CURRENT slot so a rebuild replaces what it
    // stored rather than accumulating one index file per keystroke.
    const assetKey = devSlots.get(input.name)?.assetKey ?? crypto.randomUUID()
    if (input.ui && input.ui.length > 0) await assets.put(assetKey, input.ui)
    else assets.remove(assetKey)

    const slot = devSlots.put({
      pluginName: input.name,
      declaredVersion: report.version ?? '0.0.0',
      bundlePath,
      assetKey,
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
    // Read the key BEFORE dropping: once the slot is gone nothing else knows
    // where its bytes live, and a dev slot's assets must not outlive it (plan
    // 111 §5 step 111.6 — "make sure dropping or expiring a slot cleans up").
    const slot = devSlots.get(name)
    devSlots.drop(name)
    if (slot) assets.remove(slot.assetKey)
    registry.invalidate(name)
  }

  /**
   * `devSlots.sweep()` plus the asset cleanup an expiry owes (step 111.6).
   *
   * The store is a plain in-memory map that knows nothing about the
   * filesystem, and `daemon.ts` constructs it and passes it in — so there is
   * no callback to hang this on. Instead the surviving keys are diffed against
   * the ones held a moment ago, which needs no new store API and cannot drift
   * the way a stored reference count could.
   */
  const sweepDevSlotAssets = (): number => {
    const before = devSlots.list()
    const dropped = devSlots.sweep()
    if (dropped === 0) return 0
    const alive = new Set(devSlots.list().map((s) => s.assetKey))
    for (const slot of before) {
      if (!alive.has(slot.assetKey)) assets.remove(slot.assetKey)
    }
    return dropped
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
    //
    // The condition must NOT test `target.status`. That value was read before
    // `verifyImpl` ran, and `verifyImpl` sets EVERY row it verifies to `staged`
    // — an `active` one included. So for the common case (reloading a healthy,
    // active plugin) the stale value still said `active`, the branch was
    // skipped, and the row was left sitting at `staged`: **reloading a working
    // plugin turned it off.** Observed live on `proxy-manager@0.3.1` — one
    // `POST /:name/reload` took its screen and its service down, with a 200 and
    // an `ok: true` report, which is the worst possible way for it to fail.
    //
    // Re-reading after the verify is what makes this correct, and it keeps
    // criterion 25 working unchanged: a `failed` row that now verifies is also
    // `staged` by this point, so both paths take the same branch.
    if (report.ok) {
      const after = db.select().from(plugins).where(eq(plugins.id, target.id)).get()
      if (after?.status === 'staged') {
        try {
          activateImpl(target.id, 'staged')
        } catch {
          // Lost a race against a concurrent activation of the SAME row — fine, someone else did it.
        }
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
    sweepDevSlotAssets()
    return { ok, failed }
  }

  /**
   * Plan 109 §4.2, step 109.2. Wrapped around the lifecycle verbs rather than
   * fired from inside their `Impl` bodies, for two reasons: `activateImpl`
   * runs inside `db.transaction`, and `reloadImpl`/`restartImpl` deliberately
   * call `activateImpl` DIRECTLY (see this file's header) — so a notification
   * placed inside would either hold a write lock across a `setup()` or fire
   * twice for one reload.
   *
   * Never allowed to fail a lifecycle verb. An operator pressing Disable gets
   * a disabled plugin whatever the host does with the news.
   */
  const notify = (event: PluginLifecycleEvent): void => {
    if (!deps.onLifecycle) return
    try {
      deps.onLifecycle(event)
    } catch {
      // Deliberately swallowed — see `PluginRuntimeDeps.onLifecycle`.
    }
  }

  /**
   * **The one door every removal goes through** — the single version route, and
   * every version a bulk request touches.
   *
   * Named and hoisted rather than left as an inline method on the returned
   * object (where it used to live) precisely so `removeVersionsImpl` below can
   * call it directly. A bulk path that called `removeImpl` instead would quietly
   * lose the `deactivated` notification, and the farm would keep a service
   * loaded for a version that no longer exists.
   */
  const removeOne = (name: string, version: string, opts: { deleteKv: boolean }): RemovalSummary => {
    // Only a removal that actually removed the ACTIVE row deactivates
    // anything — deleting a superseded version leaves what is loaded alone,
    // and telling the host otherwise would tear down a working service.
    const wasActive = activeImpl(name)?.version === version
    const summary = removeImpl(name, version, opts)
    if (summary.removed && wasActive) notify({ kind: 'deactivated', name, version })
    return summary
  }

  const removeVersionsImpl = (name: string, opts: { scope: PluginVersionRemovalScope; deleteKv: boolean }): BulkRemovalReport => {
    // Request-level refusals throw; version-level ones are reported. A synthetic
    // owner is refused here as well as inside `removeOne`, so the answer is one
    // coded error about the request rather than N identical row failures.
    refuseSynthetic(name, 'removed')

    /**
     * **Read every row of this name, unfiltered.** `listImpl` is the same
     * unfiltered `SELECT ... WHERE name = ?` the Plugins page reads, and that is
     * deliberate: a one-off plan 110 migration script (since deleted) recorded
     * the mistake its own first version made — deriving a delete list from a
     * FILTERED listing that hides exactly the rows it means to act on, and then
     * reporting "nothing to delete" on a farm holding five. A bulk remove that
     * skipped, say, `failed` rows would leave behind precisely the junk an
     * operator ran it to clear.
     */
    const candidates = listImpl({ name })
    if (candidates.length === 0) throw new EnkakuError('plugin_not_found', `no plugin named "${name}"`)

    const plan = planPluginVersionRemoval(candidates, opts.scope)
    const results: PluginVersionRemovalResult[] = plan.keep.map((k) => ({
      id: k.candidate.id,
      version: k.candidate.version,
      status: k.candidate.status,
      kvDeleted: 0,
      skip: { code: k.code, message: k.message },
      error: null,
    }))

    /**
     * The KV namespace belongs to the NAME, not to any one version (every
     * version shares it — that is what the single-version dialog already tells
     * the operator), so it is dropped exactly ONCE: on the first removal that
     * actually succeeds. Passing `deleteKv` to all eleven would call
     * `deleteNamespace` eleven times and report a total eleven times too large,
     * ten of them counting nothing.
     *
     * Gated on a success rather than fired up front, because "delete everything
     * and its data" that removed nothing must not still have deleted the data.
     */
    let kvPending = opts.deleteKv
    for (const target of plan.remove) {
      try {
        const summary = removeOne(name, target.version, { deleteKv: kvPending })
        if (!summary.removed) {
          // The row vanished between the plan and the attempt — another
          // operator, or another tab. Reported as a keep rather than a failure:
          // the outcome the caller asked for is the outcome they got.
          results.push({
            id: target.id,
            version: target.version,
            status: target.status,
            kvDeleted: 0,
            skip: { code: 'plugin_not_found', message: `${name}@${target.version} was already gone` },
            error: null,
          })
          continue
        }
        // Cleared on the removal that CARRIED the flag, not on a non-zero count:
        // a plugin with an empty namespace deletes nothing and must still not
        // have the sweep re-run on the next ten versions.
        kvPending = false
        results.push({ id: target.id, version: target.version, status: target.status, kvDeleted: summary.kvDeleted, skip: null, error: null })
      } catch (err) {
        // Per-version and never swallowed — chiefly `script_in_use`. The loop
        // continues: one version a running job holds must not stop the other ten
        // from being pruned, and an operator who is told which two were refused
        // and why can act on that.
        const code = err instanceof EnkakuError ? err.code : 'E_PLUGIN_REMOVE_FAILED'
        const message = err instanceof Error ? err.message : String(err)
        results.push({ id: target.id, version: target.version, status: target.status, kvDeleted: 0, skip: null, error: { code, message } })
        // `kvPending` is deliberately left alone: a removal that threw did not
        // reach the namespace sweep, so the flag passes to the next version that
        // does succeed.
      }
    }

    return { plugin: name, scope: opts.scope, total: candidates.length, results }
  }

  return {
    list: listImpl,
    get: getImpl,
    active: activeImpl,
    surface: surfaceImpl,
    service: serviceImpl,
    uiAsset: uiAssetImpl,
    stage: stageImpl,
    verify: verifyImpl,
    activate: (pluginId, expectedStatus) => {
      const row = activateImpl(pluginId, expectedStatus)
      notify({ kind: 'activated', name: row.name, version: row.version })
      return row
    },
    rollback: (name, toVersion) => {
      const row = rollbackImpl(name, toVersion)
      notify({ kind: 'activated', name: row.name, version: row.version })
      return row
    },
    disable: (name) => {
      // The version is read BEFORE the transition, since after it there is no
      // active row left to read one from.
      const version = activeImpl(name)?.version ?? ''
      disableImpl(name)
      notify({ kind: 'deactivated', name, version })
    },
    enable: (name) => {
      const row = enableImpl(name)
      notify({ kind: 'activated', name: row.name, version: row.version })
      return row
    },
    remove: removeOne,
    removeVersions: removeVersionsImpl,
    deleteData: deleteDataImpl,
    putDevSlot: putDevSlotImpl,
    dropDevSlot: dropDevSlotImpl,
    devSlots: devSlotsImpl,
    reload: async (name) => {
      const report = await reloadImpl(name)
      // A reload always re-imports: the bundle may be byte-identical and the
      // service still has to be restarted, because a reload is exactly the
      // operation an author performs after changing code.
      if (report.ok) notify({ kind: 'activated', name, version: report.version ?? '' })
      return report
    },
    restart: restartImpl,
  }
}
