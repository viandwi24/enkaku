# 315 — Workflows shipped by plugins

> Status: partial — the software is built and verified (scoped tests; on the owner's dev farm with smm 0.10.0); the one goal still open is G6's hardware walk, running `smm/warmup-rotation` on a real phone (§11.3). Decided by the CTO on the owner's instruction, 2026-09-14.
> Ships: `packages/core/src/workflows/managed.ts`
> Depends on: 210 (workflows as farm rows), 303 (plugin node descriptors), 314 (warm-up rotation)
> Spec references: §4.6 (workflows)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A plugin can declare workflow documents in `definePlugin({ workflows })` | shape refused on the author's machine AND at verify | `packages/sdk/src/plugin.ts` `checkWorkflows`; `verify-child.test.ts` "shipped workflows (plan 315)" 6/6 | yes |
| G2 | Activating a version registers its workflows as `plugin/name`; rollback, enable, disable, remove and boot keep the table equal to the active version's declaration | `syncPluginWorkflows` after every lifecycle verb, `syncAllPluginWorkflows` at restart | `workflows/managed.test.ts` 9/9 (driven through the real runtime verbs) | yes |
| G3 | A plugin workflow is read-only | `PUT`/`DELETE` → 409 `E_WORKFLOW_MANAGED`; an operator may not create a name containing `/` (400 `E_WORKFLOW_NAME_RESERVED`) | `api/workflows.test.ts` 53/53; and against the running farm | yes |
| G4 | An operator's workflow is never replaced by a plugin's | a colliding declared name is `skipped`, never written | `workflows/managed.test.ts`; on the farm the operator's own `warmup-rotation` stayed `pluginName: null` beside `smm/warmup-rotation` | yes |
| G5 | Studio shows who provides a workflow, opens a plugin one read-only, and offers **Duplicate to edit** | browser walk | §11.2 | yes |
| G6 | The warm-up rotation ships as `smm/warmup-rotation` | appears on a farm after activating smm | registered on the owner's dev farm by activating smm 0.10.0; not yet RUN on a phone | registered — run pending |

## 1. The question, and the answer

The owner asked whether workflows can be *injected by plugins* — shipped dynamically, not editable — while operators still author their own.

**Yes, as static documents. Never as a generator.**

Plan 314 §0 rejected "a plugin that injects/generates workflows" and asked the owner to confirm it (314 Q3). This plan answers Q3 by splitting the two things that sentence joined:

- **A generator** — code that emits a document at runtime — stays rejected, for 314's reasons: a generated document cannot be reviewed, cannot be replayed against what an operator saw, and moves the guarantee into a code path.
- **A shipped document** is none of those. It is data in the bundle, verified at install like a script's params schema, visible on the canvas exactly as it will run, and every job still snapshots it (`jobs.workflow_doc`). It is reviewable and replayable by construction. It also defines no control flow of its own — it uses the same closed node set as any operator's workflow (plan 300 D8, spec §4.6).

Plan 210 §9 Q1 (a nullable plugin column on `workflows`) is answered by the same decision: added (`plugin_name`, migration `0086`), by plugin **name**.

## 2. Decisions

1. **Naming.** A plugin workflow is registered as `<pluginId>/<local name>`, exactly like a script. The author writes the local name; `finalizeReport` rewrites it. `WorkflowNameSchema` already allowed one `/`; Studio's slug grammar never produced one; the API now refuses one from an operator. Collisions between an operator and a plugin are therefore impossible for anything written after this plan. A `/` name routes as one encoded path segment (`GET /api/workflows/smm%2Fwarmup-rotation`), verified against the running core.
2. **Ownership by plugin name, not version.** A workflow has no version. The row belongs to "whichever version of P is active", and the sync keeps it so.
3. **One sync, not per-verb bookkeeping** (`workflows/managed.ts`). Desired = the active version's declaration (empty if none active); the table's P-owned rows are made equal to it. Idempotent, so boot runs it for every plugin, and a no-change resync rewrites nothing.
4. **Disable and remove delete the rows.** A disabled plugin's scripts do not resolve, so a workflow that cannot run is not offered. A schedule pointing at it fails loudly at its next fire (the existing `workflow_not_found` path) — the same visibility a disabled script already has.
5. **Own-script refs are checked at verify; other plugins' refs are not checked at registration.** Whether `tiktok/…` resolves depends on what else the farm has active, in whatever order. The row is registered and `POST /api/workflows/validate` says what does not resolve; Studio shows those findings on the read-only page, errors always open.
6. **Read-only is enforced by the core**, not by Studio: `PUT`/`DELETE` refuse `E_WORKFLOW_MANAGED`. Running, presets, pins, simulate, coverage and history stay allowed — none of them change the document.
7. **Editing means duplicating.** Studio's **Duplicate to edit** creates an operator workflow from the plugin's document (name = the unprefixed name, `-copy`/`-copy-N` on collision; title + " (copy)"). The copy is the operator's and never changes when the plugin updates.
8. **Dev slots do not register workflows** in this plan. A dev slot's scripts are in memory only and `resolveDocRefs` refuses dev builds; registering rows that point at them would leave rows behind when the slot drops.
9. **The manifest carries the documents as `unknown[]` on the wire.** `PluginManifestSchema` parses every plugin row the Plugins page lists, including versions verified by older builds; a document an evolved workflow schema no longer accepts must not make a whole plugin row unreadable. Documents are parsed where they are used.

## 3. Limits

At most `PLUGIN_WORKFLOW_LIMIT` (20) workflows per plugin, shared by `definePlugin` and `finalizeReport`. Each document is the ordinary `WorkflowDocSchema` (≤50 nodes, ≤40 params).

## 11. Handoff

### 11.1 What changed

| Layer | File | Change |
|---|---|---|
| protocol | `src/workflow.ts`, `src/index.ts` | `PLUGIN_WORKFLOW_LIMIT`, `workflowScriptRefs`, `WorkflowDocInput` |
| protocol | `src/api/workflows.ts` | `WorkflowInfo.pluginName` (`.default(null)`) |
| protocol | `src/api/plugins.ts` | `PluginManifestSchema.workflows` (`unknown[]`, decision 9) |
| sdk | `src/plugin.ts` | `PluginDefinition.workflows`, `checkWorkflows` |
| core | `db/schema.ts`, `drizzle/0086_sleepy_black_bird.sql` | `workflows.plugin_name` + index |
| core | `workflows/managed.ts` (new) | `declaredWorkflows`, `syncPluginWorkflows`, `syncAllPluginWorkflows` |
| core | `plugins/verify-child-entry.ts`, `plugins/verify-child.ts` | carry and re-validate `workflows` (`E_PLUGIN_WORKFLOW_INVALID`) |
| core | `plugins/runtime.ts` | sync after activate, rollback, disable, enable, remove, restart; manifest stores `workflows` |
| core | `workflows/store.ts`, `api/workflows.ts` | `pluginName` on records; `E_WORKFLOW_MANAGED`, `E_WORKFLOW_NAME_RESERVED` |
| studio | `components/flow/PluginWorkflowView.tsx` (new), `app/scripts/editor/page.tsx`, `components/scripts/WorkflowsGrid.tsx`, `lib/api.ts` | read-only view, Duplicate to edit, "From plugin" badge, no Delete, server message on a refused delete |
| smm | `src/workflows/warmup-rotation.ts`, `src/index.ts` (0.10.0) | ships `smm/warmup-rotation` |
| docs | `docs/spec.md` §4.6 | two owners of a workflow |

### 11.2 Verified

- Scoped tests, one file at a time: `workflows/managed.test.ts` 9/9, `api/workflows.test.ts` 53/53, `verify-child.test.ts` plan-315 block 6/6, `runtime-script-rows.test.ts` 2/2, `packages/sdk` `plugin.test.ts` 48/48, smm plugin 98/98. `bun run typecheck` clean. `check-plan-status`, `check-dead-code`, `check-agent-docs`, `check-design-tokens`, `check-routes`, `check-release-packs` exit 0; `spec:check` warning-only, exit 0.
- On the owner's dev farm, after a core restart (migration 0086) and activating smm 0.10.0: `smm/warmup-rotation` listed with `pluginName: "smm"`, the operator's own `warmup-rotation` untouched (`null`); `PUT` and `DELETE` → 409 `E_WORKFLOW_MANAGED`; `POST` of an operator doc named `smm/mine` → 400 `E_WORKFLOW_NAME_RESERVED`; `/validate` on the shipped document → 0 errors, 16 warnings (8 `W_WORKFLOW_EDGE_DANGLING`, 7 `W_WORKFLOW_LATEST_REF`, 1 `W_WORKFLOW_SHUFFLE_EMPTY`).
- Studio, in the browser: the Workflows tab shows "From plugin smm" on the shipped card and 8 Delete buttons for the 8 operator workflows, none on the shipped one; the editor URL for `smm/warmup-rotation` renders the read-only view (13 nodes on the canvas, 0 draggable); **Duplicate to edit** created `warmup-rotation-copy` titled "Warmup rotation (copy)" and opened it in the ordinary editor (that test copy was then deleted).

### 11.3 Not done, and known

1. **G6 on hardware.** `smm/warmup-rotation` has not been run on a phone. The owner's moto has no Instagram installed, so the slot that sends it to Instagram fails until it is installed and signed in.
2. **`verify-child.test.ts` is environmentally red on the owner's Mac**: 32 of 36 pre-existing tests fail identically before and after this plan — fixture bundles written to the OS tmpdir cannot resolve `zod`. The plan-315 block writes its bundles inside the package and passes. A separate task was raised to fix the shared fixture helper.
3. **The 8 `W_WORKFLOW_EDGE_DANGLING` warnings on a shuffle's member scripts** are the checker flagging `onFailure` edges that a shuffle member does not use. Not changed here (the checker is shared by every workflow); Studio folds warnings so they no longer bury the canvas.
4. **Two cards read "Warmup rotation"** on the owner's farm: the shipped one and the owner's own original. Only the badge tells them apart. Whether to keep the original is the owner's call.
