# MVP 03 — Navigation and pages

> Status: proposal under discussion, 2026-09-03. §2 carries one decision taken by the CEO the same day (scripts are not versioned; plugins are).
> **Amended by MVP 15 (design handoff):** the Jobs page has two tabs, Jobs and Batches; Schedules is not a page but an attribute of a workflow or a script's Run dialog. The device page is deleted; Device Control is the device surface. The status-bar Console is the log stream, and Adb command is an action.
> Complaint as reported: "The current UI is fairly confusing. Users often want to be direct and straightforward." The CEO proposed a six-item menu: Devices, Scripts & Workflows, Jobs, Agents, Plugins, Settings, plus dynamic plugin entries.
> Related: `docs/spec.md` §19 (screen list), §11.4 (a script cannot exist outside a plugin), §11.6 (plugin surface), `docs/design.md:91-134` (screen patterns), `docs/ux-audit.md`, `packages/studio/src/components/layout/AppShell.tsx`.

---

## 0. What the sidebar is today

`AppShell.tsx:30-110` renders **14 flat items with no grouping**, in this order: Devices, Workflows, Recordings, Plugins & scripts, Workspace, Jobs, Console, Clusters, Batches, Schedules, Tools, Nodes, Agents, Settings. Below them, one labelled group "Plugin views" built from `GET /api/plugins/ui` (`AppShell.tsx:114-176, 664-710`), only for active plugins.

Three route directories are live redirects kept for compatibility: `/scripts` → `/plugins?tab=scripts`, `/topology` → `/?view=wall&group=cluster`, `/agents/thread` → `/agents/detail`. `/dev/tools` is reachable by URL only (ux-audit finding 6).

`AppShell.test.tsx:449-463` fails the build when a top-level `src/app` directory has no `href:` in the nav. Any consolidation must move or delete route directories, not just hide items.

### 0.1 The same entity on several screens

This, not the item count, is the confusion:

| Entity | Screens that list it |
|---|---|
| `scripts` rows | `/plugins?tab=scripts` (list), `/scripts/detail` (detail, different route tree), `/workflows` (rows with `kind='workflow'`), `/recordings` (source that publishes into a row) |
| `jobs` rows | `/jobs`, `/batches` (a batch is a grouping row over jobs; `/batches/detail` renders the same `JobsList`), `/schedules` (jobs that have not happened yet), device page Jobs tab |
| clusters | `/clusters` (membership), `/` with `group=cluster` (the view), `/topology` (redirect) |
| "run an adb command" | `/console`, device page Terminal tab, `AdbCommandDialog` |
| agent state | `/agents`, `/agents/approvals`, `/agents/runs`, `/workspace` |

`RunScriptDialog.tsx:478-481` already hides the job/batch split at the point of use: one device posts a job, more than one posts a batch. The split is only visible in the navigation and in two separate histories.

## 1. Proposed top-level navigation

| Menu | Tabs or sections | Absorbs |
|---|---|---|
| **Devices** (landing page, unchanged) | Table / Screens toggle; **group** strip (All, one tab per group, "+"); Discovered sheet; Nodes only after the MVP (cloud mode) | `/`, `/clusters` (renamed groups), `/nodes`, `/console` (deleted), `/topology` |
| **Scripts & Workflows** | Scripts, Workflows, **Schedules** (CEO, 2026-09-03; recordings deferred) | `/plugins?tab=scripts`, `/scripts/detail`, `/workflows`, `/workflows/editor`, `/schedules`, `/schedules/detail` |
| **Jobs** | Jobs, Batches (MVP 15) | `/jobs`, `/jobs/detail`, `/batches`, `/batches/detail` |
| **Agents** | Roster, Runs, Approvals, **Files** (Workspace renamed; CEO, 2026-09-03) | `/agents`, `/agents/detail`, `/agents/approvals`, `/agents/runs`, `/workspace` |
| **Plugins** | Installed (versions, activate, rollback, disable), Dev slots | `/plugins?tab=plugins`, `/plugins/detail` |
| **Settings** | The existing 22 sections plus a Toolchain section | `/settings`, `/tools` |
| *Plugin views* | Labelled group below the static nav, exactly as now (spec §19 requires this so installing a plugin never moves core items) | `/plugins/view` |

Fourteen items become six plus the plugin group. Every page keeps its content; only the address and the entry point change.

### 1.1 Differences from the CEO's proposal, with reasons

- **Schedules is a third tab under Jobs.** A schedule is a job that has not run yet, and the schedule detail already shows Runs. Without a home it would be a seventh item.
- **Schedules is the third tab under Scripts & Workflows** (CEO, 2026-09-03; replaces the earlier Recordings bullet, recordings being deferred). A schedule names a script or workflow, a target, and a cron; its fires are runs (MVP 14).
- **Console is removed** (CEO, 2026-09-03, after MVP 15). "Adb command" stays as an action in the generic action set; there is no console page, no log console, no saved commands, no command history.
- **Tools moves into Settings.** Toolchain versions and `doctor` are configuration, not daily work.
- **Nodes is a tab on Devices**, shown only when the core runs as orchestrator. Nodes are where devices live.
- **Workspace is a tab on Agents.** It is the agents' virtual file system and has no other consumer.

### 1.2 Dashboard

The CEO's phrase "the user enters the dashboard" means the landing page. `docs/design.md` records the decision not to build a dashboard; the landing page stays Devices (Wall). This document does not reopen that.

## 2. Scripts have no version of their own; only plugins do

> **Decision (CEO, 2026-09-03):** a script is never versioned on its own and can only be registered through a plugin. This section replaces the earlier ownership-rule proposal in this document.

### 2.1 How far the code already is

- A plugin stamps its own version on every member script; a member carries no independent version (`packages/sdk/src/plugin.ts:36`). `@latest` for `<plugin>/<script>` resolves to the plugin's active version (`packages/core/src/scripts/registry.ts:349-360`). Activation and rollback move every member together and never delete older rows, so pinned jobs keep running (`plugins/runtime.ts:570, 830-875`). **This is already the decided model.**
- A direct publish (`POST /api/scripts`, `enkaku publish`, the `script.publish` capability) does not bypass it: `resolveDirectPublishOwner` (`packages/core/src/plugins/owner.ts`) creates an ordinary plugin row on the fly, versioned in lockstep with the script. The plugin exists; it is just invisible to the user.
- **Exception 1, recordings:** every published recording is owned by one synthetic plugin named `recordings`, fixed at version `0.0.0`, while each member row carries its own version (`owner.ts`, `SYNTHETIC_OWNER_VERSION`). It is the only reserved plugin name in the system.
- **Exception 2, workflows:** a workflow is a `scripts` row with `kind='workflow'`, no owning plugin, its own version, published by `POST /api/workflows` with `pluginId` null (`packages/core/src/api/workflows.ts:215-225`). Spec §11.4 explicitly exempts it.

The two exceptions are why the product feels like it has two version systems.

### 2.2 The model after the decision

| Thing | Owner | Versioned? | Registered by |
|---|---|---|---|
| Script | A plugin, always | Only through the plugin | Plugin stage → verify → activate |
| Recording (published) | A plugin of its own, id = recording slug | Only through that plugin; each re-publish bumps it | The same pipeline, driven by the Recordings tab |
| Workflow | The farm (Studio-authored) | No. A job snapshots the document at enqueue | Workflow editor |
| Plugin | Itself | Yes: staged, active, superseded, disabled | Install, dev slot, recording publish |

Rules that follow:

1. `scripts.version` stays as an internal denormalisation equal to the owning plugin's version. Rollback and pinned jobs need the row-per-plugin-version to exist. It is never shown in Studio, never listed by `GET /api/scripts`, and never documented as a script property. Jobs display `plugin@1.2.0 / login`.
2. The direct-publish owner path is removed: `POST /api/scripts` (publish), the non-plugin branch of `enkaku publish`, and the `script.publish` capability go away. Agents that need to publish do so as a plugin through the existing `POST /api/plugins` stage route.
3. The synthetic `recordings` plugin and the reserved-name list are removed. A recording publishes as a real plugin with one member (`<slug>/run`), through the ordinary pipeline. The Plugins page gains an origin filter: installed, recorded, dev.
4. Workflows leave the `scripts` table. A `workflows` table holds `name` (unique), `doc`, `createdBy`, `updatedAt`. Enqueuing a workflow job copies the validated document onto the job, so editing never changes a queued or running job. `jobNodes` is unchanged. A plugin may ship workflows as members later; that is an extension, not part of this decision.
5. One word for state, everywhere: a plugin is **active** or not. "latest" and "enabled" disappear from the UI vocabulary. `scripts.enabled` remains the storage that plugin disable already writes.
6. `scriptParamSets` stay keyed on script name, as today, so presets survive plugin upgrades.

### 2.3 What changes in Studio

- The Scripts tab lists the members of active plugins: name, owning plugin and its version, params, last run, Run, param sets. No version picker, no history, no enable toggle.
- The script detail page keeps Overview, Source, Runs, Settings, drops the version dropdown, and shows a badge linking to the plugin.
- Version history, activate, rollback, disable, and remove live only on the Plugins page.
- The Workflows tab is the editor's list; a workflow has Save, Run, Delete, and Runs. No publish step, no version.
- The Recordings tab keeps review, trim, and parameterise; Publish stages and activates a plugin named after the recording and reports it as such.

### 2.4 Migration

- Existing rows with no owning plugin are already ignored farm-wide with a one-time startup warning (spec §11.4). Workflow rows migrate into the new table by a Drizzle migration; recordings under the synthetic owner are re-published as per-recording plugins by a one-time boot task, or left ignored under the same warning if the compiled bundle is missing.
- `docs/spec.md` §11.4, §11.5, §11.7, §11.8 and §19 are rewritten together. §11.5's "create, edit, version, enable/disable" sentence is deleted.

## 3. Cost and risks

- **Spec §19 must be rewritten.** Its screen list has separate rows for Scripts, Workflows, Recordings, and a combined "Clusters, batches, schedules" row that already contradicts the sidebar. This proposal makes the spec and the sidebar agree.
- **Route consolidation is real work**, not a config change: `AppShell.test.tsx` enforces one nav entry per route directory, so directories move. Estimate: two sprints for the nav and tab shells, using the existing `EntityTabs`, `JobsList`, and `SectionNav` components; screens themselves are reused.
- **Old routes become redirects for one release**, then are deleted. Plugins that link into Studio (`DeviceWallWithPicker`, host links) must be checked for hardcoded routes.
- **Cluster strip overflow**: a farm with many clusters cannot show one chip each. Cap at a small number plus an overflow menu; the Manage dialog stays as is.
- **Mobile** (below 1024 px the sidebar is a sheet): six items fit; fourteen did not.

## 4. Decisions needed

1. Confirm the six-item menu with the three adjustments in §1.1.
2. Decided: scripts have no version and register only through plugins (§2). Still open within it: whether workflows get their own table (§2.2 rule 4) or stay in `scripts` with a hidden internal version; this document recommends the table.
3. Approve the spec rewrite (§11.4, §11.5, §11.7, §11.8, §19) as part of the same plan.
