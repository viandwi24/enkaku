# Plan 210 — MVP wave 2 : Scripts only through plugins; workflows in their own table; recordings parked

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 207 (actions API: `run-script` and `run-workflow` always create a batch; `run-workflow` answers `E_NOT_SUPPORTED` until plan 211), which itself depends on plan 205 (capabilities declare `activity`, not a lease). Plan 201 (housekeeping) has deleted `scripts/delete-unowned-scripts.ts` and the two unused recording response schemas before this plan starts. Plan 211 (jobs and runs) reads the `workflows` table and the `jobs.workflow_doc` column this plan creates.
> Spec references: `docs/mvp/03-navigation-and-pages.md` §2 (entire: §2.1 facts, §2.2 rules 1 to 6, §2.3, §2.4 migration), `docs/mvp/06-feature-scope.md` §2 (recordings deferred: parked, not deleted) and §4 item 3, `docs/mvp/15-ui-migration.md` §0.1 items 1 and 5 and the §1 row "Script versions and Enabled switch", `docs/mvp/13-removal-register.md` A.4 (the rows this plan owns are copied into §10; the rows plan 211 owns are named there and left), `docs/mvp/14-jobs-and-runs.md` §1 (jobs reference `scriptRef` or `workflowName`; runs are plan 211's), `docs/mvp/16-consolidated-plan.md` §1 (nouns), §2 (Scripts row), §3 (wave 2). Where `docs/spec.md` still says a workflow is a `scripts` row (§11.7) or that recordings publish under a synthetic owner (§11.8), `docs/mvp/16` wins (plan 200 header).
> Ships: packages/core/src/workflows/store.ts

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | `scripts.kind` and every reader of it are gone from live code and package docs | 0 matches | `rg -n "scripts\.kind\|ScriptKind\|kind: 'workflow'\|kind === 'workflow'" packages plugins examples scripts apps --glob '!packages/core/drizzle/**' --glob '!**/out/**' --glob '!**/*.tsbuildinfo' --glob '!packages/core/packs/**'` prints nothing | [ ] |
| G2 | The direct-publish owner and the synthetic recordings owner no longer exist | file absent, 0 matches | `test ! -e packages/core/src/plugins/owner.ts` and `rg -n "resolveDirectPublishOwner\|resolveRecordingsOwner\|isSyntheticPluginName\|syntheticPluginError\|reservedPluginNameError\|RECORDINGS_PLUGIN_NAME\|SYNTHETIC_OWNER\|RESERVED_PLUGIN_NAMES" packages plugins examples scripts apps --glob '!**/out/**' --glob '!**/*.tsbuildinfo' --glob '!packages/core/packs/**'` prints nothing | [ ] |
| G3 | `POST /api/scripts`, `PATCH /api/scripts/:id` and the two `/:name/versions` routes are gone | 0 matches | `rg -n "app\.post\('/'\|app\.patch\('/:id'\|/versions" packages/core/src/scripts/routes.ts packages/core/src/api/workflows.ts` prints nothing | [ ] |
| G4 | The `script.publish` capability is replaced by `plugin.stage` | 0 matches for the old id, the new test passes | `rg -n "id: 'script\.publish'\|scriptPublish\|PublishScriptCapabilityInput" packages` prints nothing; `bun test packages/core/src/capability/plugin.test.ts` passes | [ ] |
| G5 | `GET /api/scripts` lists members of active plugins only, grouped by name, in the §4.2 shape | one row per member of an active plugin; a disabled plugin's members absent | `bun test packages/core/src/scripts/routes.test.ts` passes, including the test named `lists one row per member of an ACTIVE plugin, with plugin, exportId, paramsSchema and lastRun` and the test named `a disabled plugin's members are absent from the list` | [ ] |
| G6 | The `workflows` table exists with a unique `name` and no version, and `jobs.workflow_doc` exists | table + column present in a fresh database | `bun test packages/core/src/workflows/store.test.ts` passes, including the test named `a fresh database has workflows(name unique) and jobs.workflow_doc` | [ ] |
| G7 | `workflows/store.ts` CRUD and the five `/api/workflows` routes work | create, get, list, update, delete, validate | `bun test packages/core/src/workflows/store.test.ts` and `bun test packages/core/src/api/workflows.test.ts` pass | [ ] |
| G8 | A farm with workflow rows in `scripts` migrates them: newest version copied, older versions dropped and named in one log line, `scripts.kind` gone | 1 `workflows` row per name; 0 workflow rows left in `scripts`; log line names `a@1.0.0` | `bun test packages/core/src/db/migrations/workflows-from-scripts.test.ts` passes | [ ] |
| G9 | Rows under the old synthetic `recordings` owner are counted and logged once at boot, not listed, not runnable | the owner `plugins` row is deleted; its member rows have `plugin_id = NULL`; the registry's own unowned warning names them | `bun test packages/core/src/db/migrations/park-synthetic-recordings.test.ts` passes | [ ] |
| G10 | `POST /api/plugins/:id/activate` answers `{ plugin, scriptsMoved, queuedKeepingPrevious }` | two integers beside the row | `bun test packages/core/src/api/plugins.test.ts` passes, including the test named `activate answers scriptsMoved and queuedKeepingPrevious` | [ ] |
| G11 | `POST /api/recordings/:slug/publish` answers `410 E_RECORDINGS_PARKED` and writes nothing | 410, 0 `scripts` rows written, 0 `plugins` rows named `recordings` | `bun test packages/core/src/api/recordings.test.ts` passes, including the test named `publish is parked: 410 E_RECORDINGS_PARKED, nothing written` | [ ] |
| G12 | A workflow document carries no version | 0 matches | `rg -n "WorkflowVersionSchema\|bumpPatchVersion\|fetchWorkflowVersions\|WorkflowVersionOption" packages --glob '!**/out/**' --glob '!**/*.tsbuildinfo'` prints nothing | [ ] |
| G13 | The executor registry has one fallback and no kind dispatch | 0 matches, file absent | `rg -n "fallbackByKind\|scriptKind\|setFallback\([^)]*'workflow'" packages` prints nothing; `test ! -e packages/core/src/jobs/executor-kind-dispatch.test.ts` | [ ] |
| G14 | No script UI copy says "latest" or "enabled"; the Scripts tab has no version columns | 0 matches | `rg -n -i "\blatest\b\|\benabled\b" packages/studio/src/app/scripts packages/studio/src/app/workflows packages/studio/src/components/workflow` prints nothing; `rg -n "ScriptToggleResponseSchema\|toggleEnabled\|latestVersion\|versionCount" packages/studio/src/app/plugins` prints nothing | [ ] |
| G15 | `scriptParamSets` is untouched | 0 diff | `git diff --stat main -- packages/core/src/scripts/param-sets.ts packages/core/src/scripts/param-sets.test.ts` prints nothing | [ ] |
| G16 | The old Studio still compiles against the new list and detail shapes | 0 errors | `bun run typecheck` exits 0 | [ ] |
| G17 | The docs no longer describe the removed model | 0 matches | `rg -n "scripts\.kind\|kind: 'workflow'\|synthetic \`recordings\`\|resolveDirectPublishOwner\|ctx\.scripts\.publish" packages/core/README.md packages/sdk/README.md packages/protocol/README.md docs/spec.md` prints nothing | [ ] |

## 1. Goals

1. A script exists only as a member of a plugin, and the only writer of a `scripts` row is the plugin runtime's `writeScriptRows` (`packages/core/src/plugins/runtime.ts:571`). The direct publish path (`POST /api/scripts`, `resolveDirectPublishOwner`, the `script.publish` capability) is gone.
2. A script has no version and no enabled switch in the product. `scripts.version` and `scripts.enabled` stay as storage (MVP 03 §2.2 rules 1 and 5): the first is the owning plugin's version, the second is what plugin `disable` writes. Neither is on the wire.
3. `GET /api/scripts` answers one row per member of an active plugin: `{ id, name, exportId, plugin: { name, version }, paramsSchema, hasResult, lastRun }`.
4. Workflows live in their own `workflows` table (`name` unique, `doc`, `createdBy`, `createdAt`, `updatedAt`), have no version, and are edited in place through `GET/POST/PUT/DELETE /api/workflows`. `POST /api/workflows/validate` stays.
5. A job created from a workflow snapshots the document: `jobs.workflow_doc` exists (nullable JSON) and `workflows/store.ts` exports the reader and the snapshot helper plan 211 calls at enqueue. Nothing in this plan writes the column.
6. Recordings are parked: every `/api/recordings/*` route stays mounted, `POST /:slug/publish` answers `410 E_RECORDINGS_PARKED`, `recording/compile.ts` and the Studio recording pages are untouched beyond compiling.
7. The synthetic `recordings` owner and the reserved-name list are gone. Rows that were under it become ordinary unowned rows at boot (once, marker-guarded), so the existing unowned-row rule (`scripts/service.ts:28-35`, spec §11.4) already keeps them out of every list and refuses every run.
8. `POST /api/plugins/:id/activate` reports the activation's consequence: `scriptsMoved` and `queuedKeepingPrevious`, so Studio (plan 219) can state before and after (MVP 03 §2.3 item 5).
9. A `plugin.stage` capability replaces `script.publish` for agents and the Workspace page: it accepts a plugin package (bundle, or a workspace path the core bundles) and returns the staged id, verifying in the same call unless asked not to.
10. Plan 211's path stays compilable: `jobs/executors/workflow.ts` remains in the tree, unregistered; `run-workflow` (plan 207) keeps answering `E_NOT_SUPPORTED` until plan 211 retargets the executor at the `workflows` table.

## 2. Non-goals

| Not done here | Done by |
|---|---|
| `jobNodes`, `GET /api/jobs/:id/nodes`, `POST /api/jobs/:id/resume`, the `node` block on `job.status`, `artifacts.nodeId`, the child-spawning workflow executor rewritten as an orchestrator, `schedule_runs`, `jobs.kind`/`workflowName`/`scriptRef` | plan 211 (MVP 05, MVP 14, MVP 13 A.4 rows 5 and 6) |
| Writing `jobs.workflow_doc` at enqueue and reading it in the orchestrator | plan 211 |
| Schedules gaining `target: { kind: 'workflow', name }` | plan 211 |
| Removing `/recordings`, `/scripts` (redirect), `/plugins?tab=scripts`, `/workflows` (as top level) from the Studio nav and route tree | plan 213 (shell) and plan 217 (Scripts, Workflows, Schedules pages) |
| The new Scripts table, Workflows cards, workflow editor and Schedules tab in the handoff's design | plan 217 |
| The Plugins page (origin filter installed / recorded / dev, activation consequence sentence) | plan 219 |
| Re-publishing parked recordings as one plugin per recording (MVP 03 §2.2 rule 3, §2.4) | after the MVP (MVP 15 §0.1 item 5: "waits with it") |
| Renaming the `script.view` / `script.publish` / `script.delete` permissions | plan 212 (settings) or plan 219; this plan reuses them exactly as `api/plugins.ts:36-40` already does |
| Spec rewrite beyond the four paragraphs §5 step 210.16 names | plan 202 and plan 224 |
| The non-plugin branch of `enkaku publish` and `defineScript` | already removed by plan 110: `packages/sdk/src/cli/publish.ts:232-241` has one path, `if (!isPlugin(built.default)) throw new Error(NOT_A_PLUGIN_MESSAGE)`; `packages/sdk/src/cli/publish.test.ts:583-600` proves `defineScript` is not exported. §5 step 210.14 only updates the README paragraphs and adds no code |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03)

- **`scripts.kind` exists and is read in six places.** `packages/core/src/db/schema.ts:867` `export type ScriptKind = 'script' | 'workflow'`; `:890` `kind: text('kind').notNull().default('script').$type<ScriptKind>()`. Readers: `scripts/routes.ts:221` (`const kindFilter = ScriptKindSchema.safeParse(c.req.query('kind'))`), `:250`, `:263`, `:275`, `:298` (`if (row.kind === 'workflow') {`), `:342`; `scripts/service.ts:29` (`return row.kind === 'script' && row.pluginId == null`), `:34` (`return or(isNotNull(scripts.pluginId), eq(scripts.kind, 'workflow'))`), `:255-273`; `scripts/registry.ts:46`, `:125`, `:158`, `:193`; `jobs/executor.ts:112` (`private fallbackByKind = new Map<ScriptKind, JobExecutor>()`), `:119-125`; `jobs/executor-host.ts:77` (`scriptKind?: (scriptId: string) => import('../db/schema').ScriptKind`), `:330` (`const kind = deps.scriptKind?.(job.scriptId) ?? 'script'`); `api/workflows.ts:223` (`kind: 'workflow',`); `packages/protocol/src/api/scripts.ts:16` (`export const ScriptKindSchema = z.enum(['script', 'workflow'])`), `:24`, `:93`; `packages/protocol/src/workflow-check.ts:78` (`kind: 'script' | 'workflow'`), `:582`, `:591`.
- **`daemon.ts` never passes `scriptKind`** to `createExecutorHost` (`daemon.ts:1345-1362`; MVP 13 B.1 "Built but not wired"), so the workflow executor registered at `daemon.ts:4260` (`executors.setFallback(workflowExecutor, 'workflow')`) is unreachable in production. Deleting the registration changes no production behaviour.
- **Direct publish creates plugins on the fly.** `packages/core/src/plugins/owner.ts:190-254` `resolveDirectPublishOwner` inserts an unverified `plugins` row with `status: 'active'` (`:238`), called from `scripts/routes.ts:428` and `capability/context.ts:437`. The synthetic owner `resolveRecordingsOwner` (`owner.ts:136-159`) is one row named `recordings` at version `0.0.0` (`:43`, `:51`), `verifiedAt: null`, `manifest: null`, created on the first recording publish (`api/recordings.ts:343`). `RESERVED_PLUGIN_NAMES` (`owner.ts:67`) is enforced in `plugins/runtime.ts:458` (`if (isSyntheticPluginName(name)) throw syntheticPluginError(name, verb)`), `:699`, `:744`, `:1056`, and read by `scripts/registry.ts:256` (`return !isSyntheticPluginName(pluginName)`).
- **Workflows are `scripts` rows.** `api/workflows.ts:217-224` calls `publishScript(db, { name: doc.name, version: doc.version, bundle: JSON.stringify(doc), source: JSON.stringify(doc, null, 2), paramsSchema, kind: 'workflow' })`; `:165-172` serves `GET /:name/versions` off the same table. `packages/protocol/src/workflow.ts:247` `version: WorkflowVersionSchema,` is a required field of the document itself.
- **The list and detail carry versions and the switch.** `packages/protocol/src/api/scripts.ts:19-58` `ScriptRowSchema` has `kind`, `enabled`, `workflow`; `:70-73` `ScriptListItemSchema`; `:76-82` `VersionOptionSchema`/`ScriptVersionsResponseSchema`; `:85-95` `ScriptGroupRowSchema` with `latestVersion`, `versionCount`, `enabled`; `:104` `ScriptToggleResponseSchema`. `scripts/routes.ts:155-167` `GET /:name/versions`; `:440-448` `PATCH /:id` flips `enabled`; `:214-284` the list with `?group=name` and `?kind=`.
- **Unowned rows are already ignored.** `scripts/service.ts:28-35` `isUnownedScriptRow`/`ownedScriptsWhere`; `scripts/registry.ts:192-204` `warnUnownedRows` logs one line per boot naming them; `:336-343` `served()` refuses them with `script_not_found`. This is the rule spec §11.4 (`docs/spec.md:730`) describes.
- **Plugin activation moves members together.** `plugins/runtime.ts:830-874` `activateImpl` supersedes the previous active version (`:856-864`) and writes member rows (`:865`, `writeScriptRows`, which never deletes an older version's rows, `:570`); `:895-905` `disableImpl` sets `status: 'disabled'` and `scripts.enabled = false` on every member; `:907-955` `enableImpl` reverses it. `api/plugins.ts:1061-1065` answers `{ plugin: row }`.
- **The registry's plugin-scoped `@latest` already means "the active version"** (`registry.ts:349-368`: `if (split && version === 'latest' && pluginScopedLatest(split.pluginName))` translates to `activePluginVersion`). The only exception is the synthetic owner (`pluginScopedLatest`, `:255-257`), which this plan removes, so the exception goes with it.
- **The recording publish path** is `api/recordings.ts:317-357`; `:141-143` `publishedName(slug)` builds `recordings/<slug>`; `:146-150` `latestPublishedVersion` reads `scripts` by that name for the list's `publishedVersion` badge; `recording/compile.ts` is the pure compiler (`emitRecordingEntry`, `emitDetachedScript`).
- **The `script.publish` capability** is `capability/script.ts:117-143`, registered through `capability/index.ts:15` and `:27`, listed for agents in `agent/plugins/automation.ts:3` and `:31` (`tools: () => [scriptList, scriptGet, scriptPublish, ...]`), invoked by Studio's Workspace page through `packages/studio/src/lib/workspace.ts:208-210` (`invokeCap('script.publish', { path, name, version }, ...)`). `buildScriptService` (`capability/context.ts:423-446`) is the service behind it.
- **Boot data steps** run in `daemon.ts:470-490`: `runMigrations(opened.db, opened.sqlite)` at `:470`, then three marker-guarded TypeScript steps (`backfillScheduleScriptRefs` `:478`, `backfillScheduleTargets` `:483`, `migrateToolResultContentBlocks` `:489`), then `log.info('db ready (migrations applied)')` at `:490`. The script registry (which logs unowned rows) is built later at `:1307`. The marker table is `db/schema.ts:374-377` `migrationMarkers`. The precedent for a step that needs a migration tag is `db/migrations/cluster-materialise.ts:16` `export const DROP_CLUSTER_SELECTOR_COLUMNS_TAG = '0014_long_human_fly'`. The last generated migration is `0064_awake_on_connect` (`packages/core/drizzle/meta/_journal.json`).
- **The old Studio reads the old shapes** at `app/device/page.tsx:278-279`, `app/plugins/detail/page.tsx:184`, `app/plugins/page.tsx:655-660`, `:692-698`, `:717-766`, `app/scripts/detail/page.tsx:103-113`, `:169-194`, `:206`, `:264-267`, `:315-337`, `app/workflows/page.tsx:79`, `:102-106`, `app/workflows/editor/page.tsx:38-45`, `:51-89`, `:114-130`, `lib/api.ts:690-723`, `components/workflow/model.ts:41`, `:55`, `:195-213`, `components/workflow/WorkflowBuilder.tsx:140-161`, `:199-201`, `components/workflow/ScriptPicker.tsx:8-14`, `:116`, `components/RunScriptDialog.tsx:95-98`, `:539-546`, `:635`, `:708-730`, `:755-787`, `:921-928`, `:1022-1030`, `:1107`, `:1178`, `components/ScheduleEditorDialog.tsx:70`, `:181`, `components/device-popup/ActionsList.tsx:346`, `lib/workspace.ts:153-210`, `app/workspace/page.tsx:116-117`, `:329-335`, `:345`.

### 3.2 Decisions

1. **One writer of `scripts` rows.** After this plan the only `INSERT INTO scripts` in the core is `plugins/runtime.ts`'s `writeScriptRows`. `publishScript` and `PublishScriptInput` (`scripts/service.ts:102-141`, `:254-302`) are deleted with their last callers; the rule "a script cannot exist outside a plugin" is then true by construction, not by a refusal message. `scriptNeedsPluginMessage` (`service.ts:155-165`) goes with it.
2. **`GET /api/scripts` is one shape.** The keyset list, `?group=name` and `?kind=` are replaced by one grouped list (§4.2). The number of members across active plugins is small (the reasoning `routes.ts:224-229` already gives for the grouped form), so the response carries every row with `nextCursor: null` inside the existing page envelope, which keeps Studio's `fetchAllPages` (`lib/api.ts:39-60`) working unchanged.
3. **`lastRun` comes from `jobs.script_name`**, never from `scriptId`: a run of an older plugin version is still the script's last run (the same reasoning `app/workflows/page.tsx:33-36` gives). One SQL statement per list call (§4.5).
4. **`DELETE /api/scripts/:id` stays, restricted to unowned rows.** It is the only cleanup door for rows the boot warning names (`registry.ts:187-190` says so explicitly), and plan 201 has deleted the one-off script. A row that has an owning plugin is refused with `409 E_SCRIPT_OWNED` naming the plugin version to remove instead. The route stays admin-only (`script.delete`).
5. **Workflows have no version, anywhere.** `WorkflowDocSchema` drops `version` and `WorkflowVersionSchema` is deleted; the `workflows` table has no version column; the editor saves in place. A queued or running job is unaffected by an edit because it holds a snapshot (`jobs.workflow_doc`, written by plan 211 through `WorkflowStore.snapshotForJob`).
6. **`jobs.workflow_doc` is added now.** MVP 14 §1 puts `workflowName` on `jobs`; the snapshot rule (MVP 03 §2.2 rule 4) is this plan's, so the column that holds the snapshot is this plan's too. It has no writer until plan 211, and this plan says so in the column comment. If plan 211 chooses a `workflow_jobs` table instead (MVP 05 §1.2), plan 211's migration moves the column; nothing here depends on where it ends up.
7. **The data migration is a boot step, not SQL.** The generated migration only changes shape (create `workflows`, add `jobs.workflow_doc`, drop `scripts.kind`). Picking the newest version needs `compareSemver` (a string `max()` in SQL orders `1.10.0` below `1.9.0`), and the one-time log line naming dropped versions needs a logger, so the copy runs in TypeScript at boot under a `migration_markers` guard, exactly like the three steps before it. Because the SQL migration has already dropped `kind` by then, a workflow row is recognised structurally: `plugin_id IS NULL` and `bundle` parses as a `WorkflowDoc` once its `version` key is removed (`api/workflows.ts:220` wrote `JSON.stringify(doc)`, and an ESM bundle never parses as JSON). A row that is neither stays where it is and is named by the existing unowned warning.
8. **Parking the synthetic owner means making its rows unowned.** The one-time boot step deletes the `plugins` row named `recordings` at version `0.0.0` with `verified_at IS NULL AND manifest IS NULL` (the exact shape `owner.ts:139-156` wrote) and sets `plugin_id = NULL, export_id = NULL` on its member rows. From then on they are ordinary unowned rows: not listed, not resolvable, refused with `script_not_found`, and named once per boot by `warnUnownedRows`. No new predicate, no new status.
9. **Activation counts are computed inside the activation transaction.** `scriptsMoved` is the number of members the activated version's manifest declares; `queuedKeepingPrevious` is the number of `jobs` rows with status `queued` or `running` whose `script_id` belongs to the previously active version's member rows, counted before those rows are superseded. Both ride on the row `activate()` already returns (an intersection type, so no existing caller changes).
10. **`plugin.stage` mirrors `POST /api/plugins`** (`api/plugins.ts:1004-1040`): stage, then verify unless `stageOnly`. It takes the `{ path }` form `script.publish` had (`capability/script.ts:112-115`) so the Workspace page keeps its one flow, and the same `buildScriptFromWorkspace` (`scripts/build.ts`) does the bundling. The entry must be a `definePlugin()` entry; the verify child refuses anything else, so this capability adds no second refusal.
11. **The old Studio gets the smallest edit that compiles**, with one adapter, `lib/script-row.ts`'s `toScriptRow`, that turns a list item into the `ScriptRow` shape `RunScriptDialog` (1 200 lines, version-shaped throughout) still expects. The adapter is Studio-internal, ships no old wire field, and is deleted together with the dialog by plan 217. Every Studio page this plan touches is replaced by plan 213, 217 or 219; nothing here is a design.
12. **The four workflow-executor test files are deleted, the executor is not.** They insert `kind: 'workflow'` rows into `scripts` (`jobs/executors/workflow.test.ts:50`, `workflow-real-claim.integration.test.ts:90`, `workflow-settings-wiring.test.ts:130`, `api/jobs-workflow-resume.integration.test.ts:63`), a fixture that cannot exist after this plan. `jobs/executors/workflow.ts` stays in the tree for plan 211 to rewrite against `workflows`; it is unregistered here and reachable from nothing. `describe.skip` is not an option (plan 200 §2.1: no kept-for-later paths).
13. **Permissions are reused, not invented.** `GET` routes need `script.view`; `POST`/`PUT`/`DELETE /api/workflows` and `plugin.stage` need `script.publish`, the same reuse `api/plugins.ts:36-40` chose and documents.

## 4. Technical design

### 4.1 Database (Drizzle, `packages/core/src/db/schema.ts`)

Edits to `scripts` (`:866-974`):

```ts
// DELETE :866-867 (`ScriptKind`) and :870-890 (the `kind` column and its comment).
// KEEP `version`, `enabled`, `pluginId`, `exportId` and every index. Replace the
// comment above `enabled` with:
    /**
     * Plan 210 (MVP 03 §2.2 rule 5) — storage for plugin `disable`/`enable`
     * (`plugins/runtime.ts`'s `disableImpl`/`enableImpl`) and nothing else. It
     * is never on the wire, never toggled per script, and never shown: a
     * plugin is active or it is not. `resolve.ts` still refuses a disabled
     * row with `script_disabled` so a pinned reference to a disabled plugin's
     * member fails by name.
     */
    enabled: integer('enabled', { mode: 'boolean' }).default(true),
```

New table, placed directly after `scriptParamSets` (`:975-1000`):

```ts
/**
 * A workflow document (plan 210, MVP 03 §2.2 rule 4): owned by the farm,
 * authored in Studio, no version. `name` is unique. `doc` is the validated
 * `WorkflowDoc` as JSON, re-validated through `WorkflowDocSchema` on every
 * read (`workflows/store.ts`'s `parseWorkflowDoc`), never `as`-cast. Editing
 * a workflow never changes a queued or running job: a job holds its own
 * snapshot in `jobs.workflow_doc`.
 */
export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    doc: text('doc', { mode: 'json' }).notNull(),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [uniqueIndex('idx_workflows_name').on(t.name)],
)

export type WorkflowRow = typeof workflows.$inferSelect
```

New column on `jobs` (`:394`), placed after `scriptVersion` (`:479`):

```ts
    /**
     * Plan 210 (MVP 03 §2.2 rule 4) — the workflow document this job was
     * created from, copied at enqueue so a later edit of the workflow never
     * changes what a queued or running job does. Null for a script job and
     * for every row written before this column existed. NO WRITER YET: plan
     * 211's enqueue calls `WorkflowStore.snapshotForJob(name)` and stores the
     * result here; plan 211's orchestrator reads it back through
     * `parseWorkflowDoc`, never an `as`-cast.
     */
    workflowDoc: text('workflow_doc', { mode: 'json' }),
```

Migration: exactly one file, generated by `bun run --cwd packages/core db:generate` after all three edits, never hand-written. Expected content: `CREATE TABLE workflows (...)`, `CREATE UNIQUE INDEX idx_workflows_name ...`, `ALTER TABLE jobs ADD workflow_doc text`, and either `ALTER TABLE scripts DROP COLUMN kind` or drizzle-kit's table-recreate form for the same drop. The generated tag (`0065_<name>`) is copied into `WORKFLOWS_TABLE_TAG` (§4.6).

### 4.2 Protocol (`packages/protocol/src/api/scripts.ts`, rewritten)

```ts
import { z } from 'zod'
import { JsonSchemaNodeSchema } from './json-schema'
import { pageSchema } from './pagination'
import { RuntimeEnvelopeSchema } from '../runtime-envelope'

/** The owning plugin, as a script is displayed: `plugin@1.2.0 / login` (MVP 03 §2.2 rule 1). */
export const ScriptPluginRefSchema = z.object({ name: z.string(), version: z.string() })
export type ScriptPluginRef = z.infer<typeof ScriptPluginRefSchema>

/** The most recent job of this script NAME, whichever plugin version it ran (`jobs.script_name`), or null. */
export const ScriptLastRunSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled']),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
})

/** One row of `GET /api/scripts`: a member of an ACTIVE plugin. `id` is the member row of the active version. */
export const ScriptListItemSchema = z.object({
  id: z.string(),
  /** `<plugin>/<script>`. */
  name: z.string(),
  exportId: z.string(),
  plugin: ScriptPluginRefSchema,
  paramsSchema: JsonSchemaNodeSchema.nullable(),
  hasResult: z.boolean(),
  lastRun: ScriptLastRunSchema.nullable(),
})
export type ScriptListItem = z.infer<typeof ScriptListItemSchema>
/** Every member in one page; `nextCursor` is always null (the set is small, see plan 210 §3.2 item 2). */
export const ScriptsListResponseSchema = pageSchema(ScriptListItemSchema)

/** `GET /api/scripts/:id`: any owned row, active or superseded (job history reads pinned rows here). */
export const ScriptRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  exportId: z.string(),
  plugin: ScriptPluginRefSchema,
  paramsSchema: JsonSchemaNodeSchema.nullable(),
  resultSchema: JsonSchemaNodeSchema.nullable().optional(),
  createdBy: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  createdAt: z.number().nullable(),
  runtime: RuntimeEnvelopeSchema.nullable().optional(),
  /** Only with `?bundle=1`. */
  bundle: z.string().optional(),
})
export const ScriptResponseSchema = z.object({ script: ScriptRowSchema })

/** `DELETE /api/scripts/:id` (unowned rows only). */
export const ScriptDeleteResponseSchema = z.object({ ok: z.literal(true) })

// ParamSetInfoSchema, ParamSetListResponseSchema, ParamSetResponseSchema,
// ParamSetDeleteResponseSchema: UNCHANGED, copied verbatim from :109-136.
```

Deleted from this file: `ScriptKindSchema`, `VersionOptionSchema`, `ScriptVersionsResponseSchema`, `ScriptGroupRowSchema`, `ScriptGroupsPageResponseSchema`, `ScriptToggleResponseSchema`, and the `kind`, `enabled`, `workflow` fields. `packages/protocol/src/index.ts` re-exports whatever this file exports; remove the six deleted names from the barrel and add `ScriptPluginRefSchema`, `ScriptLastRunSchema`, `ScriptsListResponseSchema`, `ScriptListItem`, `ScriptPluginRef`.

New file `packages/protocol/src/api/workflows.ts`, exported from the barrel beside the scripts API:

```ts
import { z } from 'zod'
import { WorkflowDocSchema } from '../workflow'

export const WorkflowInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  doc: WorkflowDocSchema,
  createdBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type WorkflowInfo = z.infer<typeof WorkflowInfoSchema>

/** `GET /api/workflows`: every workflow, sorted by name; small enough to carry the documents. */
export const WorkflowsListResponseSchema = z.object({ items: z.array(WorkflowInfoSchema), total: z.number().int() })
/** `GET /api/workflows/:name`, `POST /api/workflows`, `PUT /api/workflows/:name`. */
export const WorkflowResponseSchema = z.object({ workflow: WorkflowInfoSchema })
/** `DELETE /api/workflows/:name`. */
export const WorkflowDeleteResponseSchema = z.object({ ok: z.literal(true) })
```

`packages/protocol/src/workflow.ts`: delete `:86-89` (`WorkflowVersionSchema`) and `:247` (`version: WorkflowVersionSchema,`). Rewrite the doc comment at `:262-271` so it no longer says the document is what `scripts.bundle` holds: it is what `workflows.doc` and `jobs.workflow_doc` hold. `packages/protocol/src/workflow-check.ts`: delete `:78` (`kind: 'script' | 'workflow'`) from `ResolvedNodeScript`, the two `E_WORKFLOW_NESTED` blocks at `:582-584` and `:591-593`, the `'E_WORKFLOW_NESTED'` member at `:32`, and the sentence at `:88-89` that mentions it. A workflow node's reference can only resolve to a plugin member now, so nesting cannot be expressed.

`packages/protocol/src/api/plugins.ts:286`:

```ts
/**
 * `POST /api/plugins/:id/activate` (plan 210 §4.7, MVP 03 §2.3 item 5): the
 * activated row plus the consequence, so a client can say what just moved.
 * `scriptsMoved`: members this version registers (its manifest's script
 * count). `queuedKeepingPrevious`: queued or running jobs pinned to the
 * previously active version's members; they keep it (MVP 03 §2.1).
 */
export const PluginActivateResponseSchema = z.object({
  plugin: PluginRowSchema,
  scriptsMoved: z.number().int().nonnegative(),
  queuedKeepingPrevious: z.number().int().nonnegative(),
})
/** `POST /api/plugins/:name/rollback` and `POST /api/plugins/:name/enable`: unchanged. */
export const PluginRowResponseSchema = z.object({ plugin: PluginRowSchema })
```

Studio's `PluginActions.tsx` parses activate, rollback and enable through `PluginActivateResponseSchema` today; point rollback and enable at `PluginRowResponseSchema`.

### 4.3 Routes

| Method | Path | Permission | Body | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/scripts` | none (unchanged: `routes.ts:214`) | none; `?group`, `?kind`, `?cursor`, `?limit` are ignored | `200` `ScriptsListResponseSchema` `{ items, nextCursor: null, total }` | none |
| GET | `/api/scripts/:id` | none (unchanged) | `?bundle=1` optional | `200` `ScriptResponseSchema` | `404 script_not_found` (missing, unowned, or its plugin row missing) |
| DELETE | `/api/scripts/:id` | `script.delete` | none | `200 { ok: true }` | `404 script_not_found`; `409 E_SCRIPT_OWNED` (`"tiktok/login@1.2.0 is a member of plugin tiktok@1.2.0; remove that plugin version instead: DELETE /api/plugins/tiktok/1.2.0"`); `409 script_in_use` (unchanged) |
| GET/POST/PATCH/DELETE | `/api/scripts/:name/param-sets(/:id)` | unchanged (`routes.ts:175-212`) | unchanged | unchanged | unchanged |
| GET | `/api/workflows` | `script.view` | none | `200 WorkflowsListResponseSchema` | none |
| GET | `/api/workflows/:name` | `script.view` | none | `200 WorkflowResponseSchema` | `404 workflow_not_found`; `500 workflow_corrupt` (a stored doc that no longer parses; message names the id and says `DELETE /api/workflows/:name` removes it) |
| POST | `/api/workflows/validate` | `script.view` (unchanged) | `{ doc: unknown }` | `200 WorkflowFinding[]` (unchanged) | `400 E_BAD_REQUEST` |
| POST | `/api/workflows` | `script.publish` | `{ doc: unknown }`; name is `doc.name` | `201 WorkflowResponseSchema` | `400 E_BAD_REQUEST`; `400 E_WORKFLOW_INVALID` `{ error: { code, message, findings } }`; `400 E_PARAMS_SCHEMA_INVALID`; `409 workflow_name_exists` |
| PUT | `/api/workflows/:name` | `script.publish` | `{ doc: unknown }`; `doc.name` must equal `:name` | `200 WorkflowResponseSchema` | `400 E_BAD_REQUEST` (name mismatch: `"the document names \"a\" but the route names \"b\"; rename by deleting and creating"`); the same validation errors as POST; `404 workflow_not_found` |
| DELETE | `/api/workflows/:name` | `script.publish` | none | `200 { ok: true }` | `404 workflow_not_found` |
| POST | `/api/recordings/:slug/publish` | `script.publish` (unchanged) | ignored | none | `410 E_RECORDINGS_PARKED`, message: `Publishing a recording is parked for the MVP (docs/mvp/06-feature-scope.md §2 and §4 item 3, decided 2026-09-03): recordings are outside the MVP navigation and cannot be published until the plugin-per-recording rework (docs/mvp/03-navigation-and-pages.md §2.2 rule 3) lands. Review, trim, parameterise and detach still work.` |
| POST | `/api/plugins/:id/activate` | `script.publish` (unchanged) | none | `200 PluginActivateResponseSchema` | unchanged |

Validation for `POST` and `PUT /api/workflows`, in this order, identical to today's `api/workflows.ts:178-211` minus the write: `WorkflowDocSchema.safeParse` (parse issues become `E_WORKFLOW_INVALID` findings), `resolveDocRefs` (unchanged apart from dropping `kind`), `checkWorkflow`, blocking `severity === 'error'` findings refuse, then `compileWorkflowParams` + `checkDeclaredSchema` (`E_PARAMS_SCHEMA_INVALID`). Audit actions: `workflow.create`, `workflow.update`, `workflow.delete` (`auth/audit.ts:84-86`, replacing `script.toggle`), `target` = the workflow id, `meta: { name }`.

`ERROR_STATUS` in `api/workflows.ts` becomes `{ workflow_not_found: 404, workflow_name_exists: 409, workflow_corrupt: 500, script_not_found: 404, script_version_not_found: 404, script_ref_unresolved: 400, script_disabled: 400, script_is_dev: 400, E_BAD_REQUEST: 400, E_WORKFLOW_INVALID: 400, E_PARAMS_SCHEMA_INVALID: 400 }`. In `scripts/routes.ts` it becomes `{ script_not_found: 404, script_in_use: 409, E_SCRIPT_OWNED: 409, param_set_not_found: 404, param_set_name_exists: 409, unauthorized: 401, E_BAD_REQUEST: 400 }`. In `api/recordings.ts` add `E_RECORDINGS_PARKED: 410`.

### 4.4 `packages/core/src/workflows/store.ts` (the shipped artefact)

```ts
import { asc, eq } from 'drizzle-orm'
import { WorkflowDocSchema, type WorkflowDoc } from '@enkaku/protocol'
import type { Db } from '../db'
import { workflows, type WorkflowRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

export interface WorkflowRecord {
  id: string
  name: string
  doc: WorkflowDoc
  createdBy: string | null
  /** Unix seconds. */
  createdAt: number
  updatedAt: number
}

export interface WorkflowStore {
  /** Every workflow, by name ascending. A row whose `doc` no longer parses is left out (see `get`). */
  list(): WorkflowRecord[]
  /** `null` when absent. Throws `workflow_corrupt` for a row whose `doc` no longer parses. */
  get(name: string): WorkflowRecord | null
  /** Throws `workflow_name_exists`. `doc` is already validated by the route (schema, refs, checks). */
  create(input: { doc: WorkflowDoc; createdBy: string | null }): WorkflowRecord
  /** Replaces `doc`, bumps `updatedAt`. Throws `workflow_not_found`. */
  update(name: string, input: { doc: WorkflowDoc }): WorkflowRecord
  /** `false` when absent. */
  remove(name: string): boolean
  /**
   * The document a job copies onto `jobs.workflow_doc` at enqueue (MVP 03
   * §2.2 rule 4). A fresh parse of the stored row, never a shared object, so
   * nothing the caller does to it reaches the table. Throws
   * `workflow_not_found`. Called by plan 211's enqueue; no caller in plan 210.
   */
  snapshotForJob(name: string): WorkflowDoc
}

/**
 * The one reader of a stored workflow document (`workflows.doc`,
 * `jobs.workflow_doc`): Zod-validated, never an `as`-cast (00-overview §4.2),
 * `null` on a parse failure so a caller decides between "skip" (`list`) and
 * "name it" (`get`).
 */
export function parseWorkflowDoc(value: unknown): WorkflowDoc | null {
  const parsed = WorkflowDocSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const toSec = (d: Date): number => Math.floor(d.getTime() / 1000)

function toRecord(row: WorkflowRow): WorkflowRecord | null {
  const doc = parseWorkflowDoc(row.doc)
  if (!doc) return null
  return { id: row.id, name: row.name, doc, createdBy: row.createdBy, createdAt: toSec(row.createdAt), updatedAt: toSec(row.updatedAt) }
}

export function createWorkflowStore(db: Db): WorkflowStore {
  const rowByName = (name: string): WorkflowRow | undefined => db.select().from(workflows).where(eq(workflows.name, name)).get()
  const getOrThrow = (name: string): WorkflowRecord => {
    const rec = store.get(name)
    if (!rec) throw new EnkakuError('workflow_not_found', `no workflow named "${name}"`)
    return rec
  }
  const store: WorkflowStore = {
    list: () => db.select().from(workflows).orderBy(asc(workflows.name)).all().map(toRecord).filter((r): r is WorkflowRecord => r !== null),
    get(name) {
      const row = rowByName(name)
      if (!row) return null
      const rec = toRecord(row)
      if (!rec) throw new EnkakuError('workflow_corrupt', `workflow "${name}" (id ${row.id}) holds a document this build cannot read; DELETE /api/workflows/${name} removes it`)
      return rec
    },
    create({ doc, createdBy }) {
      if (rowByName(doc.name)) throw new EnkakuError('workflow_name_exists', `a workflow named "${doc.name}" already exists; edit it with PUT /api/workflows/${doc.name}`)
      const now = new Date()
      const row: WorkflowRow = { id: crypto.randomUUID(), name: doc.name, doc, createdBy, createdAt: now, updatedAt: now }
      db.insert(workflows).values(row).run()
      return getOrThrow(doc.name)
    },
    update(name, { doc }) {
      getOrThrow(name)
      db.update(workflows).set({ doc, updatedAt: new Date() }).where(eq(workflows.name, name)).run()
      return getOrThrow(name)
    },
    remove(name) {
      const row = rowByName(name)
      if (!row) return false
      db.delete(workflows).where(eq(workflows.id, row.id)).run()
      return true
    },
    snapshotForJob: (name) => WorkflowDocSchema.parse(JSON.parse(JSON.stringify(getOrThrow(name).doc))),
  }
  return store
}
```

`api/workflows.ts` takes `deps: { db: Db; registry: ScriptRegistry; store: WorkflowStore; audit?: AuditLogger; settings?: () => WorkflowBudget }`; `daemon.ts:3171` passes `store: workflowStore`, a `createWorkflowStore(db)` built once beside `scriptRegistry` (`:1307`).

### 4.5 `scripts/service.ts` (rewritten) and `scripts/routes.ts`

```ts
export function isUnownedScriptRow(row: Pick<ScriptRow, 'pluginId'>): boolean {
  return row.pluginId == null
}
export function ownedScriptsWhere(): SQL {
  return isNotNull(scripts.pluginId)
}
export function parseScriptRuntime(value: unknown): RuntimeEnvelope | null   // unchanged (:47-50)

/** One row per member of an ACTIVE plugin (plan 210 §4.2). */
export function listActiveScripts(db: Db): ScriptListItem[]
/** Any owned row, or null. The plugin ref comes from the owning `plugins` row by id. */
export function getScriptDetail(db: Db, id: string): ScriptDetail | null
```

`listActiveScripts`:

```ts
const rows = db
  .select({ s: scripts, pluginName: plugins.name, pluginVersion: plugins.version })
  .from(scripts)
  .innerJoin(plugins, eq(plugins.id, scripts.pluginId))
  .where(eq(plugins.status, 'active'))
  .orderBy(asc(scripts.name))
  .all()
const names = rows.map((r) => r.s.name)
const lastByName = new Map<string, ScriptLastRun>()
if (names.length > 0) {
  const last = db.all<{ id: string; script_name: string; status: string; created_at: number; finished_at: number | null }>(sql`
    SELECT j.id, j.script_name, j.status, j.created_at, j.finished_at
    FROM jobs j
    WHERE j.script_name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
      AND j.created_at = (SELECT max(j2.created_at) FROM jobs j2 WHERE j2.script_name = j.script_name)
    ORDER BY j.created_at DESC`)
  for (const j of last) if (!lastByName.has(j.script_name)) lastByName.set(j.script_name, /* parse status through ScriptLastRunSchema.shape.status, skip the row on failure */)
}
return rows.map(({ s, pluginName, pluginVersion }) => ({
  id: s.id,
  name: s.name,
  exportId: s.exportId ?? s.name.slice(s.name.indexOf('/') + 1),
  plugin: { name: pluginName, version: pluginVersion },
  paramsSchema: s.paramsSchema as JsonSchemaNode | null,   // the same reconciliation routes.ts:310-328 documents
  hasResult: s.resultSchema != null,
  lastRun: lastByName.get(s.name) ?? null,
}))
```

`ScriptDetail` is `z.infer<typeof ScriptRowSchema>` minus `bundle`. `routes.ts`'s `GET /` becomes `typedJson(c, ScriptsListResponseSchema, { items, nextCursor: null, total: items.length })`; `GET /:id` calls `getScriptDetail` and appends `bundle` when `?bundle=1`; `DELETE /:id` adds the owned check before the in-use check. Deleted from `service.ts`: `ScriptGroupInfo`, `groupScriptsByName`, `listScriptGroups`, `PublishScriptInput`, `publishScript`, `scriptNeedsPluginMessage`. Deleted from `routes.ts`: `PublishBody`, `blockingFindings`, `PatchBody`, `GET /:name/versions`, `POST /`, `PATCH /:id`, the `resolveDirectPublishOwner` import, `ScriptKindSchema`/`ScriptGroupsPageResponseSchema`/`ScriptToggleResponseSchema`/`ScriptVersionsResponseSchema`/`WorkflowDocSchema` imports.

`scripts/registry.ts`: delete `kind` from `ScriptEntry` (`:40-46`), `:125`, `:154-158`; delete `ScriptGroupVersion`, `ScriptGroup`, `groups()` (`:70-86`, `:96`, `:279-311`; zero consumers outside tests); delete `pluginScopedLatest` (`:243-257`) and the `isSyntheticPluginName` import (`:7`); at `:353` the condition becomes `if (split && version === 'latest')`; `:298-301` goes with `groups()`. `warnUnownedRows` (`:192-204`) selects `{ id, name, version, pluginId }`, filters with `isUnownedScriptRow`, and logs:

`${rows.length} script row(s) across ${names.length} name(s) have no owning plugin and are ignored: ${shown}${rest}. A script is a member of a plugin and nothing else, so these are not listed and a job, schedule or batch that names one is refused. Nothing was deleted and job history still reads back. Republish them inside a plugin, or delete them: DELETE /api/scripts/<id>.`

where `shown` lists up to ten entries formatted `name@version (id)`.

### 4.6 Boot data steps (`packages/core/src/db/migrations/`)

`workflows-from-scripts.ts`:

```ts
export const WORKFLOWS_TABLE_TAG = '0065_<generated name>'   // the tag db:generate produced for this plan's migration
export const MARKER_ID = 'workflows-from-scripts-210'

export interface WorkflowsFromScriptsReport {
  ranAt: string
  migrated: string[]              // one name per workflow copied
  droppedVersions: string[]       // `name@version` of every older version not carried
  unreadable: string[]            // `name@version (id)` rows that looked like workflows but did not parse; left in place
  jobsPinnedToDropped: number     // jobs (any status) whose script_id named a deleted row
  schedulesNamingWorkflow: string[] // schedule names whose script_ref names a migrated workflow
}

export function migrateWorkflowsFromScripts(db: Db, deps: { log: Logger }): WorkflowsFromScriptsReport | null
```

Algorithm, all inside one `db.transaction`:

1. Return `null` if the marker exists.
2. Select every `scripts` row with `plugin_id IS NULL`. For each, `JSON.parse(bundle)` inside `try`; on success and when the value is an object, remove its `version` key and run `WorkflowDocSchema.safeParse`. Success marks it a workflow row; a JSON object that fails the schema is `unreadable`; a `JSON.parse` failure is an ordinary unowned row (ignored here).
3. Group workflow rows by `name`; sort each group with `compareSemver(b.version, a.version)` on the `scripts.version` column; the first is the winner.
4. For a name already present in `workflows` (a re-run after a crash), skip the insert but still delete the rows. Otherwise insert `{ id: crypto.randomUUID(), name, doc: <the parsed doc without version>, createdBy: winner.createdBy, createdAt: winner.createdAt ?? now, updatedAt: winner.createdAt ?? now }`.
5. `jobsPinnedToDropped` = `SELECT count(*) FROM jobs WHERE script_id IN (<every workflow row id>)`; `schedulesNamingWorkflow` = names of `schedules` whose `script_ref` starts with `<name>@` for a migrated name.
6. Delete every workflow row (all versions) from `scripts`.
7. Insert the marker.
8. Log, once: `info` `workflows-from-scripts: moved N workflow(s) into the workflows table: a, b; dropped M older version(s): a@1.0.0, a@1.1.0` (omit the second clause when M is 0); `warn` when `unreadable` is non-empty naming them; `warn` when `jobsPinnedToDropped > 0`: `K job(s) reference a workflow row that no longer exists; their history reads back through jobs.script_name and they cannot be re-run until plan 211 lands`; `warn` naming `schedulesNamingWorkflow` with the sentence `these schedules fire against a script reference that no longer resolves and will record a failed fire until plan 211 retargets them`.

`park-synthetic-recordings.ts`:

```ts
export const MARKER_ID = 'park-synthetic-recordings-210'
export interface ParkSyntheticRecordingsReport { ranAt: string; ownerFound: boolean; rowsUnowned: number }
export function parkSyntheticRecordingsOwner(db: Db, deps: { log: Logger }): ParkSyntheticRecordingsReport | null
```

Inside one transaction: return `null` on the marker; find `plugins` rows where `name = 'recordings' AND version = '0.0.0' AND verified_at IS NULL AND manifest IS NULL`; for each, `UPDATE scripts SET plugin_id = NULL, export_id = NULL WHERE plugin_id = <owner id>` (count the changes) and delete the owner row; insert the marker; log `info` `park-synthetic-recordings: the farm-owned "recordings" plugin is gone; N published recording row(s) are now unowned and ignored (see the script registry's own warning for their names). Recordings are parked for the MVP (docs/mvp/06-feature-scope.md §2).` Log nothing when no owner existed.

Both are called in `daemon.ts` directly after `migrateToolResultContentBlocks(...)` (`:489`), in this order: `parkSyntheticRecordingsOwner(opened.db, { log: log.child('park-synthetic-recordings') })`, then `migrateWorkflowsFromScripts(opened.db, { log: log.child('workflows-from-scripts') })`. Both run before `createScriptRegistry` (`:1307`), so its unowned warning already sees the result.

### 4.7 Activation consequence (`plugins/runtime.ts`)

```ts
export type PluginActivationRow = PluginWireRow & { scriptsMoved: number; queuedKeepingPrevious: number }
// PluginRuntime.activate(pluginId: string, expectedStatus?: 'staged'): PluginActivationRow
```

In `activateImpl` (`:830-874`), after `previous` is computed (`:856-861`) and before the supersede loop (`:862`):

```ts
const manifest = p.manifest as { scripts: { id: string }[] }
const scriptsMoved = manifest.scripts.length
const previousMemberIds = previous.length === 0
  ? []
  : tx.select({ id: scripts.id }).from(scripts).where(inArray(scripts.pluginId, previous.map((r) => r.id))).all().map((r) => r.id)
const queuedKeepingPrevious = previousMemberIds.length === 0
  ? 0
  : tx.select({ id: jobs.id }).from(jobs).where(and(inArray(jobs.scriptId, previousMemberIds), inArray(jobs.status, ['queued', 'running']))).all().length
```

and the return at `:872` becomes `return { ...toPluginWire({ ...p, status: 'active' }), scriptsMoved, queuedKeepingPrevious }`. `api/plugins.ts:1061-1065`:

```ts
app.post('/:id/activate', requirePermission('script.publish'), (c) => {
  const { scriptsMoved, queuedKeepingPrevious, ...plugin } = runtime.activate(c.req.param('id'))
  audit.record({ userId: actorId(c), action: 'plugin.activate', target: plugin.id, meta: { name: plugin.name, version: plugin.version, scriptsMoved, queuedKeepingPrevious } })
  return typedJson(c, PluginActivateResponseSchema, { plugin, scriptsMoved, queuedKeepingPrevious })
})
```

Delete `refuseSynthetic` (`:451-459`) and its five call sites (`:834`, `:877`, `:896`, `:908`, `:958`), the reserved-name checks at `:695-699`, `:740-744`, `:1053-1056`, and the `owner` import at `:24`.

### 4.8 The `plugin.stage` capability (`packages/core/src/capability/plugin.ts`, new)

```ts
import { PluginStatusSchema, VerifyReportSchema } from '@enkaku/protocol'
import { z } from 'zod'
import { buildScriptFromWorkspace } from '../scripts/build'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

const StageFields = {
  /** `definePlugin({ id })`'s own shape; the verify child checks the bundle declares the same id. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a plugin id is lowercase letters, digits and dashes, starting with a letter or a digit'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
  /** Stage without verifying in the same call (`POST /api/plugins`'s `stageOnly`). Default false. */
  stageOnly: z.boolean().default(false),
}
const StageInput = z.union([
  z.object({ ...StageFields, bundle: z.string().min(1), source: z.string().optional() }),
  z.object({ ...StageFields, path: z.string() }),
])

export const pluginStage = defineCapability({
  id: 'plugin.stage',
  input: StageInput,
  output: z.object({ id: z.string(), name: z.string(), version: z.string(), status: PluginStatusSchema, verify: VerifyReportSchema.optional() }),
  permission: 'script.publish',
  activity: null,        // plan 205 §4.4: a capability that touches no device
  deadline: 120_000,     // 30 s bundling (scripts/build.ts) plus the verify child (plugins/verify-child.ts)
  effect: 'write',
  description:
    'Stage a plugin package on the farm and verify it, the same as POST /api/plugins. `name` is the plugin id and `version` its semver; send a pre-built `bundle` (with optional `source`) or a workspace `path` to an entry whose default export is definePlugin({ id, version, scripts: [ … ] }), which the core bundles itself under the same limits as a dev slot. Returns the staged id and status, plus the verify report unless stageOnly is true. Activation is a separate step (POST /api/plugins/:id/activate). A script cannot be published on its own: this is the only way code reaches the farm.',
  handler: async (ctx, input) => {
    const port = ctx.plugins()
    if (!port) throw new EnkakuError('E_NOT_SUPPORTED', 'this host cannot stage plugins (orchestrator mode)')
    const built = 'path' in input ? await buildScriptFromWorkspace(ctx.workspace, input.path) : { bundle: input.bundle, source: input.source }
    const staged = await port.stage({ name: input.name, version: input.version, bundle: built.bundle, source: built.source, createdBy: ctx.actor?.id ?? null })
    if (input.stageOnly) return { id: staged.id, name: staged.name, version: staged.version, status: staged.status }
    const verify = await port.verify(staged.id)
    const fresh = port.get(staged.id)
    return { id: staged.id, name: staged.name, version: staged.version, status: fresh?.status ?? staged.status, verify }
  },
})

export const PLUGIN_CAPABILITIES = [pluginStage]
```

`capability/context.ts`: add `export type PluginStagePort = Pick<PluginRuntime, 'stage' | 'verify' | 'get'>`; `CapabilityContextDeps.plugins?: () => PluginStagePort | null` (a thunk, matching `sessions`/`readiness` at `daemon.ts:2498-2499`); `CapabilityContext.plugins: () => PluginStagePort | null`, wired as `plugins: deps.plugins ?? (() => null)`. Delete `PublishScriptCapabilityInput` (`:37-48`), `ScriptCapabilityService.publish` (`:53-54`), the `publish` member of `buildScriptService` (`:427-444`) and the `owner` import (`:18`). `daemon.ts:2494` gains `plugins: () => pluginRuntime,` (the same instance `createPluginRoutes` receives at `:3177`; a thunk because it may be constructed after this literal). `capability/index.ts`: import `PLUGIN_CAPABILITIES` and add `{ file: 'capability/plugin.ts', caps: PLUGIN_CAPABILITIES }` after the `script.ts` entry. `capability/script.ts`: delete `:76-143`, `SCRIPT_CAPABILITIES = [scriptList, scriptGet]`, `ScriptGroupSchema` becomes `ScriptListItemSchema` from `@enkaku/protocol` (`script.list` output `{ items: ScriptListItem[] }`, handler `ctx.scripts.list()`), `ScriptDetailSchema` becomes `ScriptRowSchema` minus `bundle`. `ScriptCapabilityService` becomes `{ list(): ScriptListItem[]; get(id: string): ScriptDetail | null }`. `agent/plugins/automation.ts:3` and `:31`: replace `scriptPublish` with `pluginStage` from `'../../capability/plugin'`.

### 4.9 Studio: the smallest edits that compile (plan 217 replaces every page below)

New file `packages/studio/src/lib/script-row.ts`:

```ts
import type { ScriptListItem } from '@enkaku/protocol'
import type { ScriptRow } from '@/components/RunScriptDialog'

/**
 * Plan 210 §3.2 item 11: the run dialog still thinks in versions; the wire no
 * longer carries one. A list item becomes a dialog row with the plugin's
 * version. Deleted with the dialog by plan 217.
 */
export function toScriptRow(item: ScriptListItem): ScriptRow {
  return { id: item.id, name: item.name, version: item.plugin.version, paramsSchema: item.paramsSchema, enabled: true, createdAt: null, pluginName: item.plugin.name }
}
```

| File | Edit |
|---|---|
| `components/RunScriptDialog.tsx` | delete `:82-95` (`kind?`), `:98` (`type Kind`), `:539` and `:546`'s filter (use `scripts ?? []`), the effect at `:635` that depends on `kindFilter`, `:708-730` (workflow doc and estimate), the `kindFilter` branches at `:755-757` and `:760-787` (keep the script sentence), `:915-928` (the Tabs), `:1022-1030`, at `:1107` pass `workflowEstimate={null}`, at `:1178` the literal `This script takes no parameters.`; remove the `WorkflowDoc`, `WorkflowDurationEstimate`, `ScriptResponseSchema`, `Tabs*` imports that become unused |
| `components/RunScriptDialog.test.tsx` | delete the describe at `:277` (`Workflow \| Script filter`) and its four tests |
| `app/device/page.tsx:278-279` | `fetchAllPages('/api/scripts', undefined, ScriptListItemSchema).then((items) => setScripts(items.map(toScriptRow)))` |
| `components/ScheduleEditorDialog.tsx:70`, `:180-181` | same mapping; drop the `.enabled` filters |
| `components/device-popup/ActionsList.tsx:344-346` | same mapping; drop the `.enabled` filter |
| `app/plugins/detail/page.tsx:184` | `api('/api/scripts', ScriptsListResponseSchema)`; the map is unchanged (`s.name → s.id`) |
| `app/plugins/page.tsx` | `:566-570` `ScriptGroupRow` becomes `ScriptListItem`; delete `toggleEnabled` (`:655-660`) and the `ScriptToggleResponseSchema` import; `:692` fetches `/api/scripts` with `ScriptsListResponseSchema`; `:695-697` `setFirstScript(toScriptRow(page.items[0]))`; `openRun` (`:665-674`) becomes `setRunTarget(toScriptRow(s))` with no fetch; header `:719-724` becomes `Name · Plugin · Params · Last run · Actions`; rows: Name link unchanged, Plugin cell `{s.plugin.name}@{s.plugin.version}` linking to `/plugins/detail?name=${s.plugin.name}`, Params cell the count of `paramsSchema.properties` keys (reuse `paramCount` from `plugins/detail/page.tsx:88` by moving it to `plugin-list.ts`), Last run cell `s.lastRun ? relativeTime(s.lastRun.createdAt) : 'never'`, delete the Switch cell, Run button `disabled={isPending('run-' + s.id)}` only; `:682` subtitle `Every script the active plugins register.`; `plugin-list.ts:167` matches on `row.name` and `row.plugin.name` |
| `app/scripts/detail/page.tsx` | delete `versions` state, the effect at `:103-113`, the Select at `:169-191` (keep the readout span with `{script.plugin.name}@{script.plugin.version}` as a `next/link` to `/plugins/detail?name=`), `:206` `disabled` prop, `:264-267` identity rows become `['script id', script.id], ['plugin', \`${script.plugin.name}@${script.plugin.version}\`], ['published by', script.createdBy ?? '—']`, the Enabled block `:315-337`; `RunScriptDialog` receives `toScriptRow`-shaped data built from the detail (`version: script.plugin.version`, `enabled: true`); imports pruned (`Select*`, `Switch`, `ScriptToggleResponseSchema`, `ScriptVersionsResponseSchema`) |
| `app/scripts/detail/page.test.tsx` | the fixture row gains `plugin: { name, version }` and `exportId`, loses `kind`, `enabled`, `version` |
| `lib/api.ts:690-723` | delete `publishWorkflow`, `WorkflowVersionOption`, `fetchWorkflowVersions`; add `listWorkflows(): Promise<WorkflowInfo[]>` (`GET /api/workflows`), `fetchWorkflow(name)` (`GET /api/workflows/:name`), `saveWorkflow(doc, mode: 'create' \| 'update')` (`POST` or `PUT /api/workflows/:name`, throwing `WorkflowPublishError` on `E_WORKFLOW_INVALID`/`E_PARAMS_SCHEMA_INVALID` exactly as `:698-706` does today), `deleteWorkflow(name)`; the doc comment at `:673` no longer says "publish gate" |
| `components/workflow/model.ts` | delete `:41` (`version: string`), `:55`, `:209-213` (`bumpPatchVersion`); `docToDraft(doc)` takes one argument; `toWorkflowDoc` produces no `version` |
| `components/workflow/model.test.ts:116-117` | delete the `bumpPatchVersion` test |
| `components/workflow/WorkflowBuilder.tsx` | `:7` import `saveWorkflow`; prop `onPublished` becomes `onSaved(workflow: WorkflowInfo)`; add prop `mode: 'create' \| 'update'`; `handlePublish` becomes `handleSave` calling `saveWorkflow(parsed.data, mode)`, toasts `Workflow saved` / `Could not save the workflow`; delete the version input `:197-202`; button copy `:476-477` `Saving…` / `Save` |
| `components/workflow/WorkflowBuilder.test.tsx:81` | the mocked response becomes `{ status: 201, body: { workflow: { id: 'wf-1', name: doc.name, doc, createdBy: null, createdAt: 0, updatedAt: 0 } } }` |
| `components/workflow/ScriptPicker.tsx` | `:8-14` `ScriptOption` loses `enabled`; delete `:116`; a group's `versions` is always one entry now, the sort at `:30` is harmless and stays |
| `app/workflows/editor/page.tsx` | `:38-45` map list items to `{ id, name, version: r.plugin.version, paramsSchema }`; delete `versions`/`selectedVersionId` state, `loadVersion`, `fetchWorkflowVersions`, the Select at `:114-130`; the effect at `:68-89` calls `fetchWorkflow(name)` and `setInitialDraft(docToDraft(w.doc))`, `docError` on 404; `WorkflowBuilder` gets `mode={name ? 'update' : 'create'}` and `onSaved={() => router.push('/workflows')}`; description `:112` becomes `A pipeline of scripts on one device` |
| `app/workflows/editor/page.test.tsx:49-64` | mocks become `'/api/workflows/tiktok-search-pipeline': { body: { workflow } }` and a 404 for the missing one |
| `app/workflows/page.tsx` | fetch through `listWorkflows()`; rows `{ id, name, doc }`; columns `Name · Steps · Last run · Updated · Actions`; Steps is `w.doc.nodes.length` (no lazy detail fetch, delete `loadNodeCount` and `nodeCounts`); Updated is `relativeTime(w.updatedAt)`; delete the `enabled` badge at `:102`; description `:66` becomes `Pipelines of scripts on one device`; `lastRun` keeps matching on `job.scriptName === w.name` |
| `app/workflows/page.test.tsx` | fixtures become one `WorkflowInfo`; the mocked path is `'/api/workflows'` |
| `lib/workspace.ts:153-210` | delete `SCRIPT_MEMBER_NAME_SHAPE`, `PublishName.script`, and `publishScriptFromWorkspace`; `defaultPublishName(path)` returns `{ plugin }` only; add `stagePluginFromWorkspace(path, name, version)` calling `invokeCap('plugin.stage', { path, name, version }, StageFromPathResultSchema)` where the schema is `{ id, name, version, status, verify? }` |
| `app/workspace/page.tsx` | delete the member field state (`:117`), its hint (`:329-333`), and its input; `:345` calls `stagePluginFromWorkspace(selectedPath, trimmedPlugin, trimmedVersion)`; the success toast names `staged <plugin>@<version>` and, when `verify` is present and not ok, shows `verify.error` |
| `app/workspace/page.test.tsx` | `'/api/v1/cap/script.publish'` becomes `'/api/v1/cap/plugin.stage'` at `:94`, `:144`, `:163`, `:174`, `:184`, `:194`, `:201`; the test at `:129` sends `{ path, name: 'tiktok', version }`; delete the member-half assertions |
| `components/plugins/PluginActions.tsx` | parse rollback and enable through `PluginRowResponseSchema`; activate keeps `PluginActivateResponseSchema` and the toast becomes `` `${name}@${version} active: ${scriptsMoved} script(s) moved${queuedKeepingPrevious > 0 ? `, ${queuedKeepingPrevious} queued job(s) keep the previous version` : ''}` `` |
| `lib/use-job-detail.ts:143` | unchanged: `GET /api/scripts/:id` still serves a pinned row's `source` |
| `components/layout/AppShell.tsx:258` | unchanged: the new list carries `total` |
| `app/recordings/**`, `components/recording/**` | unchanged; a publish click now shows the existing failure toast (`recordings/detail/page.tsx:294`) with the 410 message |

No `next/link` becomes a plain `<a>`; no Tailwind bracket colour classes are introduced (`docs/design.md`).

### 4.10 File structure after this plan

```
packages/core/src/
  workflows/store.ts                      NEW  (§4.4)
  workflows/store.test.ts                 NEW
  api/workflows.ts                        REWRITTEN (§4.3)
  api/workflows.test.ts                   REWRITTEN
  scripts/routes.ts, service.ts, registry.ts   EDITED (§4.5)
  scripts/kind-projection.test.ts         DELETED
  plugins/owner.ts                        DELETED
  plugins/runtime.ts                      EDITED (§4.7)
  capability/plugin.ts, plugin.test.ts    NEW (§4.8)
  capability/script.ts, script.test.ts    EDITED
  db/migrations/workflows-from-scripts.ts, .test.ts        NEW (§4.6)
  db/migrations/park-synthetic-recordings.ts, .test.ts     NEW (§4.6)
  db/scripts-kind-migration.test.ts       DELETED
  jobs/executor.ts, executor-host.ts      EDITED (one fallback)
  jobs/executor-kind-dispatch.test.ts     DELETED
  jobs/executors/workflow.ts              UNCHANGED, unregistered (plan 211)
packages/core/drizzle/0065_<name>.sql     GENERATED
packages/protocol/src/api/scripts.ts      REWRITTEN (§4.2)
packages/protocol/src/api/workflows.ts    NEW (§4.2)
packages/studio/src/lib/script-row.ts     NEW (§4.9)
```

## 5. Implementation steps

Read plan 200 §2 and `CLAUDE.md` before the first edit. Every `path:line` below was read on 2026-09-03; match on the quoted content when a line has moved. Commit per step as `feat(mvp-210): …` or `chore(mvp-210): …`.

### 210.1 Schema and migration

- Files changed: `packages/core/src/db/schema.ts` (§4.1: delete `:866-890`'s `ScriptKind` and `kind`; rewrite the `enabled` comment; add `workflows` after `:1000`; add `jobs.workflowDoc` after `:479`).
- Files created: `packages/core/drizzle/0065_<name>.sql` and its `meta/` entries, by running `bun run --cwd packages/core db:generate` exactly once after all three schema edits. Never hand-write the SQL (`db/migration-watermark.test.ts` header).
- Files deleted: `packages/core/src/db/scripts-kind-migration.test.ts` (it asserts the column exists).
- Test file: `packages/core/src/workflows/store.test.ts` (written in 210.2) carries the `PRAGMA table_info` assertions for `workflows` and `jobs.workflow_doc`.
- Verifiable result: `bun run --cwd packages/core db:generate` run a second time prints `No schema changes, nothing to migrate`; the generated file contains `workflows`, `workflow_doc`, and a drop of `kind`.
- Do not: keep `kind` "for the migration step to read". The boot step recognises workflow rows structurally (§3.2 item 7). Do not add a `version` column to `workflows`.

### 210.2 `workflows/store.ts`

- Files created: `packages/core/src/workflows/store.ts` (§4.4 verbatim), `packages/core/src/workflows/store.test.ts`.
- Test file: `store.test.ts`: `a fresh database has workflows(name unique) and jobs.workflow_doc` (PRAGMA over both tables and `SELECT sql FROM sqlite_master WHERE name = 'idx_workflows_name'` contains `UNIQUE`); create then get; create twice refuses `workflow_name_exists`; update bumps `updatedAt` and replaces `doc`; remove returns true then false; `list` is name-ascending; a hand-corrupted row (`UPDATE workflows SET doc = '{"schema":2}'`) is skipped by `list` and thrown by `get` as `workflow_corrupt`; `snapshotForJob` returns an equal document that is not the same object and throws `workflow_not_found`.
- Verifiable result: `bun test packages/core/src/workflows/store.test.ts` passes.
- Do not: parse `doc` with an `as` cast anywhere; every read goes through `parseWorkflowDoc`.

### 210.3 Protocol

- Files changed: `packages/protocol/src/api/scripts.ts` (rewritten, §4.2), `packages/protocol/src/workflow.ts` (`:86-89`, `:247`, `:262-271`), `packages/protocol/src/workflow-check.ts` (`:32`, `:78`, `:88-89`, `:582-584`, `:591-593`), `packages/protocol/src/workflow-check.test.ts` (delete the nested-workflow tests at `:340-375`), `packages/protocol/src/api/plugins.ts:286` (§4.2), `packages/protocol/src/index.ts` (barrel), `packages/protocol/README.md:52-120` (the workflow example at `:64` loses `version: '1.0.0'`; the paragraph at `:117` no longer says "versioning" of a node script).
- Files created: `packages/protocol/src/api/workflows.ts`.
- Test file: `packages/protocol/src/workflow-check.test.ts` (scoped run), `packages/protocol/src/workflow.test.ts` if it exists (a document with a `version` key must now fail `.strict()`; add that test there or in `api/workflows.test.ts`).
- Verifiable result: `bun test packages/protocol/src/workflow-check.test.ts` passes; `rg -n "WorkflowVersionSchema" packages/protocol` prints nothing.
- Do not: keep `ScriptKindSchema` "for Studio"; Studio is edited in 210.12.

### 210.4 `scripts/service.ts`, `scripts/routes.ts`, `scripts/registry.ts`

- Files changed: the three files as §4.5 specifies; `packages/core/src/auth/audit.ts:84-86` (`script.toggle` replaced by `workflow.create | workflow.update | workflow.delete`).
- Files deleted: `packages/core/src/scripts/kind-projection.test.ts`.
- Test file: `packages/core/src/scripts/routes.test.ts` (rewrite: delete the describes at `:107-235` that exercise `POST /`, `PATCH /:id` and their audit rows, `:237-272` (`?group=name`), `:274-320` (owning-plugin rule on publish), `:321` (hostile paramsSchema on publish); keep `DELETE /:id` permission and audit tests, `GET /` needs no permission; add `lists one row per member of an ACTIVE plugin, with plugin, exportId, paramsSchema and lastRun` (two plugins, one active, one superseded, one job row with `script_name` set), `a disabled plugin's members are absent from the list`, `an unowned row is absent from the list and 404 on detail`, `DELETE refuses an owned row with E_SCRIPT_OWNED and deletes an unowned one`); `packages/core/src/scripts/service.test.ts` (delete `:38-117`, the publish describes; keep and update `:119-153` for the new `isUnownedScriptRow`); `packages/core/src/scripts/registry.test.ts` (delete `:249-290`, the `kind` describe, and any `groups()` test; the fixture helper `publish(db, ...)` inserts rows directly and keeps working once `kind` is removed from its insert).
- Verifiable result: `bun test packages/core/src/scripts/` passes; G3 and G5 greps.
- Do not: leave `?group=name` "because the plugin detail page reads it"; that page is edited in 210.12. Do not filter the list on `scripts.enabled`; `plugins.status = 'active'` is the truth.

### 210.5 `api/workflows.ts` and wiring

- Files changed: `packages/core/src/api/workflows.ts` (rewritten to §4.3 and §4.4's deps; `resolveDocRefs` loses `kind: entry.kind`), `packages/core/src/daemon.ts:1307` (build `const workflowStore = createWorkflowStore(db)` beside `scriptRegistry`) and `:3171` (`store: workflowStore`), `packages/core/src/api/workflows-wiring.test.ts` (the assertion at `:66` also expects `store: workflowStore`).
- Test file: `packages/core/src/api/workflows.test.ts` (rewritten: keep the `withUser` and `setUp` helpers; `publishScriptRow` drops `kind: 'script'`; delete `publishWorkflowRow` and the describe at `:352`; keep `/validate` describes `:249-350`; rewrite `:119-247` as `POST /api/workflows` creates a workflows row and answers 201 { workflow }`, `a second POST with the same name is 409 workflow_name_exists`, `PUT replaces the document and bumps updatedAt`, `PUT with a mismatched name is 400`, `GET list and GET one`, `DELETE then GET is 404`, `POST requires script.publish`, plus the three finding-mapping tests (`E_WORKFLOW_INVALID` for a forward binding, `E_WORKFLOW_SCRIPT_UNRESOLVED` for a missing script, a malformed document)).
- Verifiable result: `bun test packages/core/src/api/workflows.test.ts` and `bun test packages/core/src/api/workflows-wiring.test.ts` pass.
- Do not: write a `scripts` row from this router under any circumstance; `publishScript` no longer exists (210.6).

### 210.6 Delete the direct-publish owner and the synthetic owner

- Files deleted: `packages/core/src/plugins/owner.ts`.
- Files changed: `packages/core/src/plugins/runtime.ts` (§4.7's deletions and `PluginActivationRow`), `packages/core/src/capability/context.ts` (§4.8), `packages/core/src/scripts/service.ts` (`publishScript`, `PublishScriptInput`, `scriptNeedsPluginMessage` deleted; done in 210.4 if not already), `packages/core/src/api/plugins.ts:1061-1065` (§4.7), `packages/core/src/plugins/runtime.test.ts` (delete `:795-870`, the synthetic-owner describe; add `activate reports scriptsMoved and queuedKeepingPrevious` with two versions, two members, one queued job pinned to the first version's member), `packages/core/src/api/plugins.test.ts` (add `activate answers scriptsMoved and queuedKeepingPrevious` asserting the two integers through `PluginActivateResponseSchema`), `packages/core/src/scripts/routes.test.ts:307` (already deleted in 210.4).
- Test file: the two above plus `bun test packages/core/src/plugins/runtime.test.ts`.
- Verifiable result: G2 greps print nothing; G10 test passes.
- Do not: replace `RESERVED_PLUGIN_NAMES` with a different reserved list; no name is reserved after this plan.

### 210.7 `plugin.stage` capability

- Files created: `packages/core/src/capability/plugin.ts` (§4.8), `packages/core/src/capability/plugin.test.ts` (modelled on `capability/script.test.ts:1-60`'s `fakeCtx`, with a fake `PluginStagePort` recording calls: the `{ bundle }` form stages then verifies; `stageOnly: true` stages only; the `{ path }` form bundles through `buildScriptFromWorkspace` and refuses a `node:fs` import; a host with `plugins: () => null` refuses `E_NOT_SUPPORTED`).
- Files changed: `packages/core/src/capability/script.ts` (delete `:76-143`; `script.list`/`script.get` output schemas per §4.8), `packages/core/src/capability/index.ts` (register `PLUGIN_CAPABILITIES`), `packages/core/src/capability/index.test.ts:42` and `:67` (`'plugin.stage'`), `packages/core/src/api/openapi.test.ts:19` (`/api/v1/cap/plugin.stage`), `packages/core/src/agent/plugins/automation.ts:3`, `:31`, `packages/core/src/daemon.ts:2494` (`plugins: () => pluginRuntime`).
- Files deleted: `packages/core/src/capability/script.test.ts` (every test in it is about `script.publish`; the two remaining capabilities are covered by `capability/index.test.ts`).
- Test file: `packages/core/src/capability/plugin.test.ts`, `packages/core/src/capability/index.test.ts`, `packages/core/src/api/openapi.test.ts`.
- Verifiable result: G4.
- Do not: make `plugin.stage` activate the plugin; activation is the operator's step (MVP 03 §2.2 rule 2 names the stage route only).

### 210.8 Executor registry: one fallback

- Files changed: `packages/core/src/jobs/executor.ts:94-125` (`private fallback: JobExecutor | null = null`; `setFallback(executor: JobExecutor): void`; `get(scriptId: string): JobExecutor | null` returns `this.map.get(scriptId) ?? this.fallback`; rewrite the doc comment), `packages/core/src/jobs/executor-host.ts:71-77` (delete `scriptKind`) and `:330-331` (`const executor = deps.registry.get(job.scriptId)`), `packages/core/src/daemon.ts:4218-4260` (delete the comment, the `createWorkflowExecutor({...})` construction and `executors.setFallback(workflowExecutor, 'workflow')`; delete the `createWorkflowExecutor` import if nothing else uses it; keep `jobNodeTracker`, it feeds the runner's artifact factory), `packages/core/src/jobs/executor.test.ts:36-70` (delete the kind tests; keep `:27`), `packages/core/src/daemon-wiring.test.ts:436-457` (delete the describe; keep `:459`'s node-aware artifacts test).
- Files deleted: `packages/core/src/jobs/executor-kind-dispatch.test.ts`, `packages/core/src/jobs/executors/workflow.test.ts`, `packages/core/src/jobs/executors/workflow-real-claim.integration.test.ts`, `packages/core/src/jobs/executors/workflow-settings-wiring.test.ts`, `packages/core/src/api/jobs-workflow-resume.integration.test.ts` (§3.2 item 12).
- Test file: `packages/core/src/jobs/executor.test.ts`, `packages/core/src/daemon-wiring.test.ts`.
- Verifiable result: G13; `packages/core/src/jobs/executors/workflow.ts` still typechecks.
- Do not: delete `jobs/executors/workflow.ts`, `jobNodes`, `artifacts.nodeId`, `GET /api/jobs/:id/nodes` or `POST /api/jobs/:id/resume`; plan 211 owns them.

### 210.9 Boot data steps

- Files created: `packages/core/src/db/migrations/workflows-from-scripts.ts`, `workflows-from-scripts.test.ts`, `park-synthetic-recordings.ts`, `park-synthetic-recordings.test.ts` (§4.6).
- Files changed: `packages/core/src/daemon.ts:489-490` (the two calls, §4.6), `packages/core/src/db/migrations/workflows-from-scripts.ts`'s `WORKFLOWS_TABLE_TAG` (the tag from 210.1).
- Test file: `workflows-from-scripts.test.ts`: open a temp database, `runMigrationsUpTo(db, WORKFLOWS_TABLE_TAG)`, insert through raw SQL (the column still exists at that point) `checkout@1.0.0` and `checkout@1.1.0` with `kind = 'workflow'` and a `bundle` of `JSON.stringify({ schema: 1, name: 'checkout', version, title: '', description: '', params: [], maxSteps: 50, nodes: [{ kind: 'script', id: 'n0', title: '', script: 'tiktok/login@1.0.0', params: {}, onFailure: { go: 'fail' } }] })`, one plugin member row `tiktok/login@1.0.0` with `kind = 'script'` and a `plugin_id`, one unowned ESM row `old@1.0.0` (`bundle = 'export {}'`), one `jobs` row with `script_id` = the `1.0.0` workflow row, one `schedules` row with `script_ref = 'checkout@latest'`; `runMigrations(db, sqlite)`; run the step with a capturing logger; assert exactly one `workflows` row named `checkout` whose `doc.nodes[0].script` is `tiktok/login@1.0.0` and which has no `version` key, zero `scripts` rows named `checkout`, the member and the ESM rows untouched, the report `{ migrated: ['checkout'], droppedVersions: ['checkout@1.0.0'], jobsPinnedToDropped: 1, schedulesNamingWorkflow: [<name>] }`, the info line contains `checkout@1.0.0`, a second run returns `null`. `park-synthetic-recordings.test.ts`: insert the owner row exactly as `owner.ts:139-156` did (copy the literal into the test) plus two member rows and one unrelated plugin with a member; run; assert the owner row is gone, the two rows have `plugin_id IS NULL` and `export_id IS NULL`, the unrelated member is untouched, the report is `{ ownerFound: true, rowsUnowned: 2 }`, a second run returns `null`, and `createScriptRegistry` on that database logs a warning naming both `recordings/<slug>@<version>` entries.
- Verifiable result: G8, G9.
- Do not: delete the parked rows, or their job history; do not touch `schedules`.

### 210.10 Recordings parked

- Files changed: `packages/core/src/api/recordings.ts` (`:10` import removed; `:141-143` `publishedName` uses a file-local `const PARKED_PUBLISHED_PREFIX = 'recordings/'` with a comment saying it reads what the prototype published and writes nothing; `:317-357` replaced by the 410 handler in §4.3; `ERROR_STATUS` gains `E_RECORDINGS_PARKED: 410`; unused imports pruned: `publishScript`, `buildScriptFromWorkspace`, `emitRecordingEntry`, `paramsJsonSchemaFor` if they have no other use in the file), `packages/core/src/api/recordings.test.ts` (delete `:279-420`'s publish describe; add `publish is parked: 410 E_RECORDINGS_PARKED, nothing written` asserting the status, the code, that the message contains `docs/mvp/06-feature-scope.md`, `SELECT count(*) FROM scripts` unchanged, and no `plugins` row named `recordings`).
- Test file: `packages/core/src/api/recordings.test.ts`, `packages/core/src/api/recordings-wiring.test.ts`.
- Verifiable result: G11; `git diff --stat main -- packages/core/src/recording/` prints nothing.
- Do not: unmount the router, delete `recording/compile.ts`, or delete any Studio recording page; "parked" is defined in §10.

### 210.11 Core README

- Files changed: `packages/core/README.md:130` (the grouped-list bullet becomes the §4.2 shape), `:745-779` (the workflow section: a workflow is a `workflows` row, edited in place, no version, snapshotted onto `jobs.workflow_doc` at enqueue by plan 211; delete the "`scripts.kind` is read in exactly four places" paragraph; say the executor is unregistered until plan 211), plus a short "Plan 210" paragraph under the scripts section: one writer of `scripts` rows, the active-only list, `DELETE /api/scripts/:id` for unowned rows only, the two boot steps, the activation counts, `plugin.stage`.
- Verifiable result: G17's grep over `packages/core/README.md` prints nothing.
- Do not: leave the `job_nodes` section (`:780-`) unchanged if it claims the executor is registered; add one sentence that plan 211 replaces it.

### 210.12 Studio: compile against the new shapes

- Files created: `packages/studio/src/lib/script-row.ts`.
- Files changed: every row of the §4.9 table.
- Test file: `bun test packages/studio/src/app/workflows`, `bun test packages/studio/src/components/workflow`, `bun test packages/studio/src/app/workspace`, `bun test packages/studio/src/app/scripts`, `bun test packages/studio/src/components/RunScriptDialog.test.tsx`, `bun test packages/studio/src/app/plugins`, one invocation at a time.
- Verifiable result: `bun run typecheck` exits 0; G14.
- Do not: rebuild any of these pages to the handoff; plan 217 and 219 do that with the design of record. Do not run `bun run --cwd packages/studio test`.

### 210.13 Plugin activation copy in the old Studio

- Files changed: `packages/studio/src/components/plugins/PluginActions.tsx` (the last row of the §4.9 table).
- Test file: `bun test packages/studio/src/components/plugins` if a test exists there; otherwise typecheck only, and say so in the report.
- Verifiable result: the activate toast states the two numbers.
- Do not: word `queuedKeepingPrevious` as a problem; it is the designed behaviour (MVP 03 §2.1: pinned jobs keep running).

### 210.14 SDK README

- Files changed: `packages/sdk/README.md`: `:10-14` gains one sentence, `Publishing goes through POST /api/plugins (enkaku publish) or the plugin.stage capability; there is no per-script publish route and no script version: a script carries its plugin's version.`; `:246-256` (Recordings): the paragraph now says recordings are parked for the MVP (docs/mvp/06 §2) and that publishing answers 410; delete the sentence `that publish goes through the exact same ctx.scripts.publish every hand-written script does`; `:548-558` (workflow node): `run as one job on one device under one lease` becomes `run as one workflow job on one device`, and a sentence that a workflow has no version and is edited in place.
- Verifiable result: G17's grep over `packages/sdk/README.md` prints nothing.
- Do not: add code to the SDK; `defineScript` and the non-plugin publish branch are already gone (§2).

### 210.15 Vocabulary sweep

- Files changed: any file the G14 greps still name.
- Verifiable result: G14 prints nothing; §10's `GREP_210` prints nothing.
- Do not: rename `scripts.enabled` or `scripts.version` in the schema; they are storage (MVP 03 §2.2 rules 1 and 5).

### 210.16 Spec

- Files changed: if `docs/spec.md` is plan 202's MVP spec (its §4.5 begins `A script is a member of a plugin and has no version of its own`), rewrite the sentence `... are removed by plan 210 (MVP 03 §2.2, MVP 13 A.4)` in §4.5 and `Workflows leave the scripts table (plan 210)` in §4.6 into the present tense, and add the `workflows` table and `jobs.workflow_doc` to the table list in §4.8. Otherwise (the prototype spec is still live) edit `docs/spec.md:730` (delete the `kind: 'script'` phrasing: every row carries an owning plugin, full stop), `:734` (`CRUD through Studio: create, edit, version, enable/disable, delete, run with parameters.` becomes `A script is run with parameters from Studio; it is created, versioned and retired only through its plugin.`), `:776` (§11.7's first paragraph: a workflow is a `workflows` row, no version, snapshotted at enqueue), `:780-782` (§11.8: add the first sentence `Recordings are parked for the MVP (docs/mvp/06-feature-scope.md §2): the pages and routes stay, publishing answers 410.` and delete the synthetic-owner sentence).
- Verifiable result: G17's grep over `docs/spec.md` prints nothing.
- Do not: rewrite §19; plan 213 and 217 own the screen list.

### 210.17 Status line and report

- Files changed: this document's `> Status:` line and §11.
- Verifiable result: `bash scripts/check-plan-status.sh` passes; `ps -Ao pid=,command= | grep -i "[o]penpf"` prints nothing but the shell.

## 6. Acceptance criteria

1. Every §0 row is checked, by its own command.
2. `rg -n "INSERT INTO scripts\|db\.insert(scripts)" packages/core/src --glob '!**/*.test.ts'` prints exactly one line, in `packages/core/src/plugins/runtime.ts` (`writeScriptRows`).
3. `GET /api/scripts` on a farm with one active plugin of two members, one superseded version of the same plugin, one disabled plugin, and two unowned rows answers exactly two items, each with `plugin`, `exportId`, `paramsSchema`, `hasResult`, `lastRun`, and no `version`, `kind` or `enabled` key.
4. `POST /api/workflows` twice with the same name is `409 workflow_name_exists`; `PUT` on a queued job's workflow does not change `jobs.workflow_doc` (asserted in plan 211; here, the column is present and `snapshotForJob` returns a detached copy).
5. Booting a database that holds `checkout@1.0.0` and `checkout@1.1.0` as workflow rows leaves one `workflows` row holding the `1.1.0` document and logs one line containing `checkout@1.0.0`.
6. Booting a database that holds the synthetic `recordings@0.0.0` owner with two members leaves no `plugins` row named `recordings`, two unowned rows, and one registry warning naming both.
7. `POST /api/plugins/:id/activate` with one queued job pinned to the previous version answers `queuedKeepingPrevious: 1` and `scriptsMoved` equal to the manifest's script count, and the queued job's `script_id` is unchanged.
8. `POST /api/recordings/:slug/publish` is `410` and the `scripts` row count is unchanged.
9. `plugin.stage` with `{ path }` on a workspace entry that imports `node:fs` refuses before any `plugins` row is written.
10. `bun run typecheck` is clean; every §7 command passes; every §10 proof prints nothing.

## 7. Test plan

Scoped runs only, one at a time, in this order:

```bash
bun run typecheck
bun test packages/core/src/workflows/store.test.ts
bun test packages/protocol/src/workflow-check.test.ts
bun test packages/core/src/scripts/
bun test packages/core/src/api/workflows.test.ts
bun test packages/core/src/api/workflows-wiring.test.ts
bun test packages/core/src/plugins/runtime.test.ts
bun test packages/core/src/api/plugins.test.ts
bun test packages/core/src/capability/plugin.test.ts
bun test packages/core/src/capability/index.test.ts
bun test packages/core/src/api/openapi.test.ts
bun test packages/core/src/jobs/executor.test.ts
bun test packages/core/src/daemon-wiring.test.ts
bun test packages/core/src/db/migrations/workflows-from-scripts.test.ts
bun test packages/core/src/db/migrations/park-synthetic-recordings.test.ts
bun test packages/core/src/api/recordings.test.ts
bun test packages/core/src/api/recordings-wiring.test.ts
bun test packages/studio/src/app/workflows
bun test packages/studio/src/components/workflow
bun test packages/studio/src/app/workspace
bun test packages/studio/src/app/scripts
bun test packages/studio/src/components/RunScriptDialog.test.tsx
bun test packages/studio/src/app/plugins
```

Never `bun test`, never `bun run --cwd packages/studio test`, never two runs at once (CLAUDE.md).

Manual smoke (no device needed; the local core on a scratch data dir):

```bash
ENKAKU_DATA_DIR=.dev-data-210 bun run dev &
sleep 5
# 1. the list is active-only and versionless
curl -s localhost:7700/api/scripts | jq '.items[0] | keys'          # no "version", "kind", "enabled"
# 2. workflows CRUD, no version anywhere in the document
curl -s -X POST localhost:7700/api/workflows -H 'content-type: application/json' \
  -d '{"doc":{"schema":1,"name":"smoke","title":"","description":"","params":[],"maxSteps":50,"nodes":[{"kind":"script","id":"n0","title":"","script":"<an active plugin member>@latest","params":{},"onFailure":{"go":"fail"}}]}}' | jq .workflow.name
curl -s -X PUT localhost:7700/api/workflows/smoke -H 'content-type: application/json' -d '<the same body>' | jq .workflow.updatedAt
curl -s localhost:7700/api/workflows | jq '.items | length'
curl -s -X DELETE localhost:7700/api/workflows/smoke | jq .ok
# 3. recordings are parked
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:7700/api/recordings/nothing/publish   # 410 (or 404 before the slug exists: create one first through the Recordings page)
# 4. the old direct publish is gone
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:7700/api/scripts -H 'content-type: application/json' -d '{}'   # 404
# 5. activation counts (stage a bundled pack twice with a bumped version, activate the second)
curl -s -X POST localhost:7700/api/plugins/<id>/activate | jq '{scriptsMoved, queuedKeepingPrevious}'
kill %1
ps -Ao pid=,command= | grep -i "[o]penpf"   # nothing
```

Device tests: none. Nothing in this plan touches a device path; `ENKAKU_TEST_DEVICE=1` is not needed.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| drizzle-kit emits a table recreate for `DROP COLUMN kind` and the recreate loses an index | the migration test in 210.9 runs `runMigrations` on a database that already has rows and asserts the plugin member row still resolves; `PRAGMA index_list('scripts')` is asserted to contain `idx_scripts_name_version`, `idx_scripts_created`, `idx_scripts_plugin` |
| A queued job pinned to a deleted workflow row fails at claim with `unknown_script` | logged by the boot step with a count; plan 211 rebuilds jobs and `run-workflow`; nothing here can make such a job run correctly, so it is named rather than hidden |
| Schedules whose `scriptRef` names a migrated workflow record failed fires until plan 211 | named per schedule in the boot log; plan 211's schedule `target` migration retargets them |
| Plan 207 lands after this plan and its `run-workflow` verb needs a store | the store's `snapshotForJob` is the seam; plan 207's `E_NOT_SUPPORTED` answer needs nothing from this plan |
| Plan 211 puts the snapshot on a `workflow_jobs` table (MVP 05 §1.2) and `jobs.workflow_doc` becomes dead | plan 211's migration moves it; the column has one reader (`parseWorkflowDoc`) and no writer here, so moving it is one `ALTER` and one call site |
| `toScriptRow` outlives plan 217 | it is listed in §10 of plan 217 by name in this plan's handoff report; G14 keeps "latest"/"enabled" out of the copy meanwhile |
| The `lastRun` correlated subquery slows the list on a farm with hundreds of thousands of jobs | `idx_jobs_script_running(status, script_name)` covers `script_name`; the list is called by three Studio pages on open, not polled; if the report measures more than 50 ms on the owner's farm, add `idx_jobs_script_name_created(script_name, created_at)` in plan 211's migration and say so |
| A parked recording's Studio page offers Publish and every click fails | acceptable and deliberate (MVP 06 §2: "not in the nav, not in the definition of done"); plan 213 removes the route from the nav |
| The Workspace page's Publish flow now needs a `definePlugin` entry and most workspace files are not one | the verify child's own refusal names the wrapper (`NOT_A_PLUGIN_MESSAGE`'s text is what an author sees from `enkaku publish`; the verify report carries the equivalent); the Workspace page becomes Files under Agents in plan 220 |

## 9. Open questions

1. `docs/mvp/03` §2.2 rule 4 ends with "A plugin may ship workflows as members later; that is an extension, not part of this decision." Whether the `workflows` table should already carry a nullable `plugin_id` for that extension is a product decision (adding it now costs nothing; adding it later is one additive migration). This plan does not add it.
2. Whether `DELETE /api/workflows/:name` should be refused while a queued or running job snapshotted that workflow (the job keeps its snapshot, so nothing breaks; the question is whether an operator expects the refusal). This plan allows the delete.

## 10. Removed

`GREP_210` (the vocabulary this plan's area forbids in live code and copy): `rg -n -i "direct.publish\|synthetic owner\|reserved plugin name\|script version\b\|scriptKind\|kind: 'workflow'" packages plugins examples scripts apps --glob '!**/out/**' --glob '!**/*.tsbuildinfo' --glob '!packages/core/packs/**' --glob '!packages/core/drizzle/**'` prints nothing.

| What | Where it was | Proof |
|---|---|---|
| `packages/core/src/plugins/owner.ts` (`resolveDirectPublishOwner`, `resolveRecordingsOwner`, `isSyntheticPluginName`, `syntheticPluginError`, `reservedPluginNameError`, `RECORDINGS_PLUGIN_NAME`, `SYNTHETIC_OWNER_VERSION`, `SYNTHETIC_OWNER_BUNDLE`, `RESERVED_PLUGIN_NAMES`, `ScriptOwner`, `DirectPublishOwnerInput`) | file | `test ! -e packages/core/src/plugins/owner.ts`; `rg -n "plugins/owner'" packages` empty |
| `refuseSynthetic` and the reserved-name checks | `plugins/runtime.ts:451-459`, `:699`, `:744`, `:1056` | `rg -n "refuseSynthetic\|isSyntheticPluginName" packages` empty |
| `POST /api/scripts` (publish), `PublishBody`, `blockingFindings` | `scripts/routes.ts:37-82`, `:355-438` | `rg -n "app\.post\('/'" packages/core/src/scripts/routes.ts` empty |
| `PATCH /api/scripts/:id`, `PatchBody`, the audit action `script.toggle` | `scripts/routes.ts:84`, `:440-448`; `auth/audit.ts:86` | `rg -n "app\.patch\('/:id'\|script\.toggle" packages/core/src` empty |
| `GET /api/scripts/:name/versions`, `GET /api/workflows/:name/versions` | `scripts/routes.ts:155-167`; `api/workflows.ts:165-172` | `rg -n "/versions" packages/core/src/scripts/routes.ts packages/core/src/api/workflows.ts` empty |
| `?group=name`, `?kind=` on the scripts list; the keyset list | `scripts/routes.ts:214-284` | `rg -n "group=name\|kind=" packages/core/src/scripts packages/studio/src` empty |
| `publishScript`, `PublishScriptInput`, `scriptNeedsPluginMessage`, `groupScriptsByName`, `listScriptGroups`, `ScriptGroupInfo` | `scripts/service.ts:62-71`, `:102-165`, `:174-222`, `:254-302` | `rg -n "publishScript\b\|PublishScriptInput\|scriptNeedsPluginMessage\|groupScriptsByName\|listScriptGroups\|ScriptGroupInfo" packages` empty |
| `scripts.kind`, `ScriptKind`, `ScriptKindSchema` | `db/schema.ts:866-890`; `protocol/src/api/scripts.ts:16` | G1 |
| `ScriptEntry.kind`, `ScriptGroup`, `ScriptGroupVersion`, `ScriptRegistry.groups()`, `pluginScopedLatest` | `scripts/registry.ts:40-46`, `:70-86`, `:96`, `:243-257`, `:279-311` | `rg -n "pluginScopedLatest\|ScriptGroupVersion\|\.groups\(" packages/core/src` empty |
| `ExecutorRegistry.fallbackByKind`, `setFallback(executor, kind)`, `get(scriptId, kind)`, `ExecutorHostDeps.scriptKind` | `jobs/executor.ts:112-125`; `jobs/executor-host.ts:77`, `:330` | G13 |
| The workflow executor's construction and registration | `daemon.ts:4218-4260` | `rg -n "createWorkflowExecutor" packages/core/src/daemon.ts` empty |
| `jobs/executor-kind-dispatch.test.ts`, `jobs/executors/workflow.test.ts`, `workflow-real-claim.integration.test.ts`, `workflow-settings-wiring.test.ts`, `api/jobs-workflow-resume.integration.test.ts`, `db/scripts-kind-migration.test.ts`, `scripts/kind-projection.test.ts`, `capability/script.test.ts` | files | `test ! -e` on each of the eight paths |
| `POST /api/workflows` as a `scripts` publish; workflow rows in `scripts` | `api/workflows.ts:174-227` | `rg -n "publishScript" packages/core/src/api/workflows.ts` empty; migration test G8 |
| `WorkflowDocSchema.version`, `WorkflowVersionSchema` | `protocol/src/workflow.ts:86-89`, `:247` | G12 |
| `ResolvedNodeScript.kind`, `E_WORKFLOW_NESTED` | `protocol/src/workflow-check.ts:32`, `:78`, `:582-593` | `rg -n "E_WORKFLOW_NESTED" packages` empty |
| `VersionOptionSchema`, `ScriptVersionsResponseSchema`, `ScriptGroupRowSchema`, `ScriptGroupsPageResponseSchema`, `ScriptToggleResponseSchema`, `ScriptRowSchema.kind/enabled/workflow` | `protocol/src/api/scripts.ts:24`, `:35`, `:57`, `:76-95`, `:104` | `rg -n "VersionOptionSchema\|ScriptVersionsResponseSchema\|ScriptGroupRowSchema\|ScriptGroupsPageResponseSchema\|ScriptToggleResponseSchema" packages` empty |
| The `script.publish` capability, `PublishScriptCapabilityInput`, `ScriptCapabilityService.publish`, `buildScriptService().publish` | `capability/script.ts:76-143`; `capability/context.ts:37-55`, `:427-444` | G4 |
| Error codes `E_SCRIPT_NEEDS_PLUGIN`, `E_PLUGIN_VERIFIED_OWNER`, `E_PLUGIN_RESERVED_NAME`, `E_PLUGIN_SYNTHETIC` | `scripts/routes.ts:105-110`; `plugins/owner.ts` | `rg -n "E_SCRIPT_NEEDS_PLUGIN\|E_PLUGIN_VERIFIED_OWNER\|E_PLUGIN_RESERVED_NAME\|E_PLUGIN_SYNTHETIC" packages plugins` empty |
| The synthetic-owner tests | `plugins/runtime.test.ts:795-870`; `scripts/routes.test.ts:307` | `rg -n "synthetic\|reserved" packages/core/src/plugins/runtime.test.ts packages/core/src/scripts/routes.test.ts` empty |
| The recording publish body (build, owner, `publishScript`) | `api/recordings.ts:325-356` | `rg -n "publishScript\|resolveRecordingsOwner\|buildScriptFromWorkspace" packages/core/src/api/recordings.ts` empty |
| Studio: the version picker and Enabled switch on the script detail, the Enabled toggle and Latest/Versions columns on the Scripts tab | `app/scripts/detail/page.tsx:103-113`, `:169-191`, `:315-337`; `app/plugins/page.tsx:655-660`, `:719-753` | G14 |
| Studio: `publishWorkflow`, `fetchWorkflowVersions`, `WorkflowVersionOption`, `bumpPatchVersion`, `WorkflowDocDraft.version`, the "start from version" picker, the Workflow \| Script filter and the workflow estimate in the run dialog | `lib/api.ts:690-723`; `components/workflow/model.ts:41`, `:209-213`; `app/workflows/editor/page.tsx:114-130`; `components/RunScriptDialog.tsx:539-546`, `:708-730`, `:766-787`, `:921-928` | G12; `rg -n "kindFilter\|durationEstimate\|publishWorkflow" packages/studio/src` empty |
| Studio: `publishScriptFromWorkspace`, `SCRIPT_MEMBER_NAME_SHAPE`, the member half of the Workspace publish dialog | `lib/workspace.ts:164`, `:208-210`; `app/workspace/page.tsx:117`, `:329-333` | `rg -n "publishScriptFromWorkspace\|SCRIPT_MEMBER_NAME_SHAPE" packages/studio/src` empty |
| README and spec paragraphs describing `scripts.kind`, the synthetic owner, direct publish, `ctx.scripts.publish` | `packages/core/README.md:753-778`; `packages/sdk/README.md:250-252`; `docs/spec.md:730`, `:734`, `:776`, `:780` | G17 |

**Parked, deliberately not deleted** (MVP 06 §2, MVP 15 §0.1 item 5; the definition of "parked" for this plan): every `/api/recordings/*` route stays mounted with its permissions; `recording/compile.ts`, `recording/*` services, `api/recordings.ts`'s list, get, create, patch, delete and detach handlers, the Studio pages under `app/recordings/` and `components/recording/`, and `RecordingDocSchema` are unchanged; only the publish handler's body is replaced by the 410. Nothing under `packages/core/src/recording/` changes (`git diff --stat main -- packages/core/src/recording/` prints nothing).

**MVP 13 A.4 rows this plan does not own** (left in place, named so the wave-2 removal gate knows who closes them): `jobNodes`, `GET /api/jobs/:id/nodes`, `POST /api/jobs/:id/resume`, the `node` block on `job.status`, `artifacts.nodeId`, the child-spawning `jobs/executors/workflow.ts` (plan 211); the `/scripts` redirect and `/plugins?tab=scripts` (plan 213 and 217); spec §11.7's "one job under one lease" sentence beyond the first paragraph (plan 211).

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:

---

## 12. Amendment 2026-09-03 — testing policy (plan 200 §8.3)

Studio and `@enkaku/ui` have zero tests. This amendment overrides §4's Studio fixture table and every Studio test command above.

- **Dropped, do not edit**: `components/RunScriptDialog.test.tsx`, `app/scripts/detail/page.test.tsx`, `components/workflow/WorkflowBuilder.test.tsx`, `app/workflows/editor/page.test.tsx`, `app/workflows/page.test.tsx`, `app/workspace/page.test.tsx`, and every other Studio test in that table. Plan 201 deletes them. If this plan runs before 201 has merged and one of them fails to compile because of the `scripts.kind` removal, the list-shape change, or the `script.publish` to `plugin.stage` capability rename, **delete that file in this plan** and list it in §11. The *source* changes in the same table (the pages and components themselves) stand: the old Studio must still compile and run for the post-wave-2 alpha (MVP 16 §5).
- **Kept, because they are on plan 200 §8.3's critical list**: the `workflows` store CRUD tests, the migration test (a pre-existing workflow row with two versions), the script list shape test (members of active plugins only; a disabled plugin's members absent), the plugin activate response test, the `plugin.stage` capability test, and the recordings publish `410` test. All are in `packages/core` and stand as §7 lists them.
- **§0 amended**: any row whose "Verified by" was a `bun test packages/studio/...` command is verified by `bun run typecheck` plus the owner smoke.
- **§7 amended**: remove the `bun test packages/studio/...` lines. Owner smoke at the wave gate: the Scripts tab lists one row per active plugin member with its plugin and version and no version picker; running one still works; the Workflows tab lists workflows from the new table and the editor saves; publishing a recording answers with the message naming MVP 06; activating a new plugin version reports how many scripts moved and how many queued jobs keep the previous one.
