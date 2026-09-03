# Plan 219 — MVP wave 3 : The Plugins page and the Settings page

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 213 (`AppShell`, `Rail.tsx`'s `NAV` entry for Settings, `scripts/check-routes.ts` and its `PENDING_REMOVAL` list this plan prunes one row from), plan 212 (`FarmSettingsSchema`'s nine top-level keys and the `advanced` block, `AgentSettingsSchema` served by `GET /api/agents/settings`, the reduced `DeviceSettingsSchema`, `packages/studio/src/components/settings/farmSections.ts`'s schema-derived `farmSections()`, `packages/core/src/config/constants.ts`). Plan 216 hands this plan `AdbRestartDialog.tsx` and `AppRestartDialog.tsx` unchanged ("farm-level maintenance confirmations with no target and no verb"; `AdbRestartDialog` is the audited sole path to `POST /api/tools/adb/restart`, which is the one route `cycle()` in `packages/core/src/tools/adb-server-control.ts` sits behind — CLAUDE.md's `adb kill-server` prohibition). Plan 210 hands this plan the plugin lifecycle model (scripts have no version of their own; `POST /api/plugins/:id/activate` answers `{ plugin, scriptsMoved, queuedKeepingPrevious }`, MVP 03 §2.3). Plan 204 (tokens, `packages/ui/src/icons.ts`, the re-skinned primitives — Button, Table, Badge, DropdownMenu, ConfirmDialog, StatusDot).
> Spec references: `docs/mvp/design_handoff_enkaku_openpf/README.md` sections "Screen: Plugins" (lines 390-411) and "Screen: Settings" (lines 414-444), quoted verbatim in §4.1; `docs/mvp/12-settings.md` §1, §2, §5 (the Key/Value store browser moves here); `docs/mvp/15-ui-migration.md` §1 row "Settings content", §3 step 5; `docs/mvp/03-navigation-and-pages.md` §1 ("Tools moves into Settings"), §2.2 rule 5, §2.3 (Scripts tab and version history live only on the Plugins page); `docs/mvp/13-removal-register.md` A.6 (`/tools` route), A.7 (Settings); `docs/mvp/16-consolidated-plan.md` §1, §3 wave 3.
> Ships: packages/studio/src/app/plugins/page.tsx

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_219_VOCAB`, `GREP_219_COLOUR`, `GREP_219_TOOLS` and `GREP_219_HARDCODE` are defined once in §10.3 and copied verbatim wherever cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The Settings nav is generated from the schema, not hand-listed | a field added to `FarmSettingsSchema` with a new top-level key and `ui({ title })` appears as a new nav entry with no component edit; removing it removes the entry | owner smoke §7.3 step 1 (add a throwaway top-level key `general.smokeTest` behind a feature branch, confirm the nav gains a "Smoke test" section with no edit to `page.tsx` or `farmSections.ts`, then revert it) | owner |
| G2 | Exactly 15 visible fields plus one Advanced section of 11 render | 15 leaf inputs outside Advanced; 11 inside it | `rg -c 'ui\(\{ title:' packages/protocol/src/settings.ts` prints `26` (plan 212's own gate, re-proved here because this plan is what renders every one of them) | [ ] |
| G3 | No Scripts settings section exists anywhere in Settings | 0 matches | `rg -n -i "script.*auto-update\|version pinning\|run-as" packages/studio/src/app/settings packages/studio/src/components/settings` → empty | [ ] |
| G4 | No settings field UI is hardcoded; every field renders through `SchemaForm` | 0 bespoke field components in the new Settings sections | `rg -n "narrowSchema" packages/studio/src/app/settings/page.tsx` → one call per schema-backed section; `GREP_219_HARDCODE` → empty | [ ] |
| G5 | The plugin table has exactly five columns in the handoff's order | Plugin · Status · Scripts · Verified · Actions | owner smoke §7.3 step 2; `rg -n "<TableHead>Plugin</TableHead>" -A6 packages/studio/src/app/plugins/page.tsx` shows the five headers in order | [ ] |
| G6 | Both status pill variants render per the handoff | `active` = `bg-accent-soft`/`text-accent` with an `ok` dot; `staged` = `bg-muted-2`/`text-dim` with a `faint-2` dot | owner smoke §7.3 step 2 | owner |
| G7 | Activating a staged version states the consequence before it runs, and the actual counts after | the confirm names the script count from the manifest; the success toast carries `scriptsMoved` and `queuedKeepingPrevious` from the response | owner smoke §7.3 step 3 | owner |
| G8 | The KV browser is reachable from the Plugins page and nowhere on farm Settings | `KvPanel` has zero importers under `app/settings/`; one importer under `app/plugins/` | `rg -l "components/kv/KvPanel" packages/studio/src` prints exactly `packages/studio/src/app/plugins/page.tsx` | [ ] |
| G9 | The two restart dialogs still reach their audited entry points | `AdbRestartDialog` still wraps `POST /api/tools/adb/restart`; neither dialog's source changed | `git diff --stat main -- packages/studio/src/components/AdbRestartDialog.tsx packages/studio/src/components/AppRestartDialog.tsx` prints nothing | [ ] |
| G10 | `/tools` is gone and its content lives in Settings → Farm → Toolchain | route absent; content present | `test ! -d packages/studio/src/app/tools` exits 0; owner smoke §7.3 step 4 | [ ] |
| G11 | `scripts/check-routes.ts` has no stale exemption and passes | `/tools` row pruned from `PENDING_REMOVAL` | `rg -n "'/tools'" scripts/check-routes.ts` → empty; `bun run scripts/check-routes.ts` exits 0 | [ ] |
| G12 | No v3 bracket colour form, `dark:` variant or hex literal in this plan's new files | 0 matches | `GREP_219_COLOUR` → empty | [ ] |
| G13 | No forbidden vocabulary (plan 200 §2.4) in this plan's new files or copy | 0 matches | `GREP_219_VOCAB` → empty | [ ] |
| G14 | The old Plugins page's Scripts tab and every script-version control are gone | 0 matches | `rg -n "ScriptGroupsPageResponseSchema\|ScriptToggleResponseSchema\|RunScriptDialog" packages/studio/src/app/plugins/page.tsx` → empty | [ ] |
| G15 | The workspace typechecks | 0 errors | `bun run typecheck` exits 0 | [ ] |
| G16 | The Agents settings tab is not built here | 0 matches | `rg -n "AgentSettingsSchema\|api/agents/settings" packages/studio/src/app/settings/page.tsx` → empty (plan 220 owns it) | [ ] |

## 1. Goals

1. Rebuild `packages/studio/src/app/plugins/page.tsx` on the handoff's "Screen: Plugins": header, search with an "N of M" counter, a five-column table (Plugin · Status · Scripts · Verified · Actions), one bordered primary action per row (Activate or Disable) plus a `⋯` overflow (Reset data, Remove), and the farm-wide Key/Value store browser as the page's second view.
2. Rebuild `packages/studio/src/app/settings/page.tsx` on the handoff's "Screen: Settings": a 236px left nav with group headings, a right pane up to 720px wide, every schema-backed section rendered by `SchemaForm` against the section narrowed out of `GET /api/settings`'s `schema`, and two bespoke sections that are not settings fields — Access (users, API tokens, the audit log) and Toolchain (tool versions, doctor diagnostics, the two restart dialogs).
3. Make the Settings nav truly schema-driven: `farmSections()` (plan 212) reads `FarmSettingsSchema`'s own top-level keys and `x-enkaku.group` hints, and this plan's page renders whatever that function returns with no per-section branch except the two bespoke ones, which are appended by id, not read from the schema.
4. Give every advanced field the handoff's "11.5px `var(--faint)` hint below" (plan 212 §4.2's `hint` vocabulary key) — currently written to the schema, never rendered. This plan threads it through `planForm`/`SchemaForm` so the eleven advanced fields carry their own "raise or lower if" sentence on screen.
5. State the plugin activation consequence (MVP 03 §2.3 item 5, plan 210 §1 goal 8): before the operator confirms, name how many scripts move (known client-side from the manifest); after the server answers, report the exact `scriptsMoved` and `queuedKeepingPrevious`.
6. Move `/tools`'s content into Settings → Farm → Toolchain, delete the route, and prune `scripts/check-routes.ts`'s `PENDING_REMOVAL` row for it.
7. Delete `app/plugins/page.tsx`'s old Scripts tab (its content already migrated to `/scripts`, plan 217) and every version-picker, "latest"/"enabled" control that went with it.

## 2. Non-goals

| Not done here | Done by |
|---|---|
| `FarmSettingsSchema`, `DeviceSettingsSchema`, `AgentSettingsSchema`, `packages/core/src/config/constants.ts`, the settings migration | plan 212 |
| The Agents page and its Settings tab (rendering `AgentSettingsSchema`) | plan 220 |
| `app/plugins/detail/page.tsx` (the per-plugin detail: Overview, Screen, Service cards) | untouched by this plan; still linked from the table's Plugin cell |
| `app/plugins/view/page.tsx` (the plugin host page a plugin's own screens render through) | **stays exactly as it is.** This plan does not touch it, does not rename it, does not fold it into the table. It is the one page a static export can point a plugin's `nav` entry at (plan 213 §4.4's `pluginNavItems`) |
| The Scripts, Workflows, Schedules pages and the `/scripts` route's own content | plan 217 |
| `InstallPluginDialog.tsx`, `ResetPluginAction.tsx`'s dialog contents, `RemovePluginAction`'s dialog contents (the confirm text, the preview) | untouched; only their trigger surface changes (§4.4) |
| `KvPanel.tsx` itself: its layout, its lucide icons, its old token classes | untouched — kept exactly as plan 212 §4.5 states ("The component file stays"). Re-skinning it is real work with no design of record behind it; §9 Q1 |
| `packages/protocol/src/settings.ts`, `packages/protocol/src/agent-settings.ts` | plan 212 (schema), plan 220 (Agents route consumer) |
| Toolchain manifest changes, `enkaku doctor`, `/api/tools/*` routes | untouched; this plan only relocates the Studio surface that calls them |
| `AdbRestartDialog.tsx`, `AppRestartDialog.tsx` internals | never — plan 216 §3.3: they are kept as-is; this plan only imports and mounts them |
| Deleting `theme.css` block D or `@layer components` (`.rack-label`, `.readout`, `.status-rail`) | the last of plans 214-220 (plan 204 §9 Q1, plan 213 §10.2) — this plan's new files use only the handoff's tokens, but old sibling files (`KvPanel.tsx`, `InstallPluginDialog.tsx`, `ResetPluginAction.tsx`) keep using them until their own plan re-skins them |
| A settings search box | never designed (the handoff draws none); not invented here |

## 3. Context and design decisions

### 3.1 What the Plugins page is today, verified 2026-09-03

`packages/studio/src/app/plugins/page.tsx` (794 lines) is two tabs, Plugins and Scripts, both mounted at once (`:302`, `:380`, the `hidden` class rather than an unmount, documented at `:69-104`). The Plugins tab already groups by name (`plugin-list.ts:58` `groupPlugins`) and already renders one row per plugin with a version `<select>` (`:490-503`), which is close to the handoff's own model. The Scripts tab (`:565-794`, `ScriptGroupsPageResponseSchema`, an `enabled` `Switch`, a `Run` button opening `RunScriptDialog`) is the part MVP 03 §2.3 deletes from this page outright: "The Scripts tab lists the members of active plugins... No version picker, no history, no enable toggle" describes `/scripts` (plan 217), not this page. `PluginActions.tsx` (206 lines) already has every lifecycle transition (`activate`, `rollback`, `reload`, `disable`, `enable`) as inline buttons plus `RemovePluginAction` (325 lines, its own file) — none of it behind an overflow. `packages/protocol/src/api/plugins.ts:19` fixes the status vocabulary this plan renders: `PluginStatusSchema = z.enum(['staged', 'verifying', 'active', 'superseded', 'failed', 'disabled'])` — six states; the handoff draws pill styling for two of them (§3.3.2 below covers the other four).

### 3.2 What the Settings page is today, verified 2026-09-03

`packages/studio/src/app/settings/page.tsx` (1281 lines) already uses `SectionNav` (`packages/studio/src/components/settings/SectionNav.tsx`, unchanged by this plan) and `SchemaForm` against `narrowSchema()`-cut slices of the farm schema — the mechanism this plan needs already exists and is reused, not reinvented. What changes underneath it, per plan 212 §4.5's own diff table (not yet applied to the file as of this writing; plan 212 lands first): `FARM_SECTION_DEFS` (a 162-line hand-maintained list, `farmSections.ts:51-162` today) becomes `farmSections(schema)` (40 lines, schema-derived); the `id === 'kv'`, `'video'`, `'connectors'`, `'webhooks'`, `'spend'` branches are deleted; `'discovery'` becomes `'networkScan'`; `'adb'` retargets to `'advanced'`; `'users'`/`'audit'` merge into one `'access'` branch. **This plan does not apply that diff by hand.** The handoff's two-column Settings screen is "rebuilt on the handoff, not restyled" (`docs/mvp/15-ui-migration.md` §3, the same principle plan 213 §1 applied to `AppShell`), and every visual line on this page changes regardless of which branches survive underneath. So this plan replaces `app/settings/page.tsx` wholesale, starting from what plan 212 §4.5 says the file's *behaviour* must be (the branch list above) rather than its post-212 *text* (which this plan never reads, because by the time an executor reaches this plan, plan 212 has already landed and rewritten it once). Where the two disagree on anything not covered by that behaviour list, plan 200 §2.2 applies: read the real file as it stands when this plan executes, and match by content.

### 3.3 Design decisions

1. **Plugin table rows are per plugin NAME, grouped, exactly as today's `groupPlugins` already does it** (`plugin-list.ts:58-75`), not per version. The handoff's Plugin cell — slug in `Geist Mono`, a version chip reading `0.11.0 · active`, `latest`/`9 versions` tags — is drawn for exactly this shape: one row, a version selector inside it. This plan re-skins `PluginRowView` (`page.tsx:459-563`) rather than replacing its data model.

2. **Every one of the six `PluginStatus` values gets a pill**, not only the two the handoff draws. The handoff states two (`active` = `accent-soft`/`accent` with an `ok` dot; `staged` = `muted-2`/`faint` with a `faint-2` dot); the remaining four extend the same two-tone system rather than inventing a third: `verifying` reuses the `staged` tone with a pulsing dot (mid-transaction, not yet resolved); `failed` is `danger-soft`/`danger` with a `danger` dot; `superseded` is `muted`/`text-2` (the version-chip tone, §4.6's `outline` Badge variant) with a `faint-2` dot — it is a fact about history, not a warning; `disabled` is `faint-2` text with no fill and no dot (the `ghost` Badge variant), because it is inert rather than in-progress.

3. **Actions become "one bordered primary, one overflow", for every status, not only the two the handoff names.** The handoff's rule ("Disable (active) or Activate (staged) as the bordered primary, plus a ⋯ overflow holding Reset data / Remove") is a special case of "the status-appropriate transition is primary; destructive and secondary acts are behind ⋯". Extended: `staged` → primary Activate, overflow {Remove}; `active` → primary Disable, overflow {Reset data, Remove}; `superseded` → primary Rollback to this, overflow {Remove}; `failed` → primary Reload, overflow {Remove}; `disabled` → primary Enable, overflow {Remove}; `verifying` → no primary (disabled placeholder "Verifying…"), overflow empty. Reset data is offered only for `active` (`PluginActions.tsx:176`'s own comment: the server refuses it for any other status, and rendering it elsewhere would offer an act the server rejects). This is the plan's own extension beyond the handoff's two drawn rows, argued from the existing server rules rather than invented.

4. **`ResetPluginAction` and `RemovePluginAction` gain an optional `trigger` prop.** Both already render their own inline `<Button>` as the `ConfirmDialog`'s trigger (`ResetPluginAction.tsx:158-159`, `RemovePluginAction`'s single-scope branch at `page.tsx`-adjacent file `:445-459`). Composing them inside a `DropdownMenuItem` needs the trigger to be a menu row, not a floating button — the exact shape `AdbRestartDialog`/`InstallPluginDialog` already expose (`{ trigger: ReactNode }`). Adding `trigger?: ReactNode` (default: the existing inline `<Button>`, so every other caller of these two components is unaffected) is a minimal, additive signature change, not a rewrite of either dialog's confirm logic, preview logic or request logic.

5. **The activation consequence sentence is said twice, because it is knowable at two different times.** `scriptsMoved` equals the staged version's `manifest.scripts.length` — the client already has this in `declared.length` (`PluginListRow.declaredScripts`) before any request is sent, so the confirm dialog states it as fact, not a guess: "This version registers N script(s) — a, b, c — which become what `<plugin>/@latest` resolves to." `queuedKeepingPrevious` cannot be known until the server has looked at the previous active version's queued and running jobs (plan 210 §4.7's `activateImpl`), so the confirm states the RULE rather than a number ("Any job already queued or running against the current active version keeps running against it — it is not moved"), and the success toast reports the actual count from the response. This is "before and after" exactly as plan 210 §1 goal 8 phrases it.

6. **The KV browser gets a lightweight in-page toggle, not a tab component.** The handoff draws no tabs for Plugins (only the plugin table); `EntityTabs` (`packages/studio/src/components/layout/EntityTabs.tsx`) is a `theme.css` block D component this plan is not otherwise touching. Rather than pull an old-token component into a new-token page, this plan builds a two-button segmented toggle from the handoff's own "Choice" field pattern (`README.md:437-439`: "option buttons, `padding: 7px 12px`, `border-radius: 9px`; selected = `border-color: var(--accent)`, `background: var(--accent-soft)`, 600") — the same visual language the page already uses for Settings' choice fields, so no new pattern is invented, only reused across screens.

7. **`hint` needs a renderer, and the natural owner is `SchemaForm`, not a new Settings-only component.** Plan 212 §4.2 adds `hint?: string` to `ParamHints`/`readHints` output; nothing in `packages/studio/src/components/schema-form/` reads it yet (verified: `plan.ts:663` sets `help` from `.description`, never `hint`). Adding it to `PlannedField`/`BaseControlProps` and rendering it in `Field` (§4.9) makes every future advanced field anywhere in the product (not only farm Settings) pick it up automatically — consistent with "a new section appears in the nav by adding a field, never by editing a component."

8. **Toolchain and Access are bespoke, spliced into the derived list by id, exactly as plan 212 §4.5's `farmSections()` already splices in `access`.** `docs/mvp/12-settings.md` §1's original sidebar order — "Farm, Video, Devices, Control, Jobs, Access, Retention, Network, Toolchain, Advanced" — puts Toolchain directly before Advanced; this plan follows that order under the Farm group heading: Devices, Privacy, Access, **Toolchain**, Advanced. `farmSections()` returns `access` spliced before `advanced`; this plan's page inserts one more entry, `toolchain`, between them, without touching plan 212's function signature (`farmSections(schema): FarmSectionDef[]`) — the splice happens in `page.tsx` itself, the same way the page already special-cases `id === 'access'`.

### 3.4 The design handoff, verbatim

From `docs/mvp/design_handoff_enkaku_openpf/README.md:390-411` ("Screen: Plugins"):

> Header: "Plugins" + "Everything this farm can run — the plugins installed on it, and the scripts they
> register", with **Reload all** (`ph-arrows-clockwise`, `var(--muted)`) and **Install plugin**
> (`ph-plus`, accent). Then a search field with an "N of M" counter; it matches name, slug, version and
> description.
>
> Table — `min-width: 940px`, columns `1.7fr 100px 160px 88px 132px` →
> Plugin · Status · Scripts · Verified · Actions.
>
> Plugin cell: title (13px/600); a chip row (all `white-space: nowrap`, `flex: none`) with the slug in
> `Geist Mono` 11.5px, the version chip (`background: var(--muted)`, `border-radius: 6px`, e.g.
> `0.11.0 · active`), and tags — `service` in `var(--warn-soft)`/`var(--warn)`, `latest` / `9 versions`
> in `var(--muted-2)`/`var(--faint)`; then the description (11.5px `var(--faint)`, `line-height: 1.6`,
> `max-width: 460px`).
>
> Status pill: dot + label — `active` = `var(--accent-soft)`/`var(--accent)` with an `var(--ok)` dot,
> `staged` = `var(--muted-2)`/`var(--faint)` with a `var(--faint-2)` dot.
> Scripts reads "4 registered" or "0 registered / 2 declared". Verified reads "7d ago".
> Actions: **Disable** (active) or **Activate** (staged) as the bordered primary, plus a **⋯** overflow
> holding Reset data / Remove (Remove in `var(--danger)`) so the row never clips.

From `README.md:414-444` ("Screen: Settings"):

> Two columns inside the panel.
>
> **Left nav** — `width: 236px`, `border-right: 1px solid var(--line)`, `padding: 12px 10px 16px`.
> Items: `padding: 8px 10px`, `border-radius: 9px`, 12.5px, icon 15px in an 18px box; active =
> `var(--accent-soft)`/`var(--accent)`/600. Group headings are non-interactive: 11px/600 `var(--faint)`,
> `padding: 14px 10px 6px`, `border-top: 1px solid var(--line)`, `margin-top: 8px`.
>
> Order: **General** · *Connection* (Host & daemon, ADB transport, Network scan) · *Automation*
> (Job runner, Capture & replay, Scripts) · *Storage* (Artifacts, Retention) · *Farm* (Clusters, Privacy,
> Appearance).
>
> **Right pane** — `max-width: 720px`, `padding: 18px 22px 28px`. Each section: a 19px/600 title with a
> `border-bottom: 1px solid var(--line)`, an optional intro paragraph (12.5px `var(--dim)`), then fields
> `padding-top: 14px`:
> - *Text field*: 12.5px/600 label, then an input (`padding: 9px 12px`, `border-radius: 9px`,
>   `border: 1px solid var(--border-2)`, `background: var(--panel-2)`; `Geist Mono` for paths/addresses)
>   with optional trailing buttons (Rename, Test, Rotate, Browse, Scan now, Open, Add) and an 11.5px
>   `var(--faint)` hint below.
> - *Checkbox*: 16×16 accent box + 12.5px/600 label + 11.5px `var(--faint)` explanation.
> - *Choice*: label then option buttons (`padding: 7px 12px`, `border-radius: 9px`; selected =
>   `border-color: var(--accent)`, `background: var(--accent-soft)`, 600).

As plan 212 §3.5's deviation table and §4.9 both record: the nav order above is the handoff's; the field list is MVP 12's (this plan renders 15 visible + 11 advanced, not the handoff's ~40); **ADB transport**, **Scripts**, **Clusters/Groups** and **Appearance** have no field left and are not built; **Artifacts** and **Retention** merge into one Retention section; **Access** and **Toolchain** are added because they are not settings fields at all.

### 3.5 Token to utility mapping used throughout §4

From plan 204 §4.3's table, restated only for the values this plan's new files use: `--panel`→`bg-panel`, `--panel-2`→`bg-panel-2`, `--line`/`--line-2`→`border-line`/`border-line-2`, `--border-2`→`border-border-2`, `--text`/`--text-2`/`--text-3`→`text-text`/`text-text-2`/`text-text-3`, `--dim`/`--faint`/`--faint-2`→`text-dim`/`text-faint`/`text-faint-2`, `--accent`/`--accent-soft`/`--on-accent`→`bg-accent`/`text-accent`/`bg-accent-soft`/`text-on-accent`, `--ok`/`--warn`/`--warn-soft`/`--danger`/`--danger-soft`→`bg-ok`/`text-warn`/`bg-warn-soft`/`text-danger`/`bg-danger-soft`, `--muted`/`--muted-2`→`bg-muted`/`bg-muted-2`, radii `panel`(16)/`card`(14)/`button`(10)/`input`(9)/`small`(8)/`chip`(7)/`pill`(999), text `section`(19)/`title`(15)/`row`(13)/`body`(12.5)/`meta`(11.5)/`label`(11).

## 4. Technical design

### 4.1 File structure

```
packages/studio/src/
  app/
    plugins/
      page.tsx                          REWRITTEN (full; the Scripts tab is deleted)
      plugin-list.ts                    CHANGED (drop scriptMatches; keep groupPlugins, searchPlugins, devSlotMatches)
      detail/page.tsx                   UNCHANGED
      view/page.tsx                     UNCHANGED — stays exactly as it is (§2)
    settings/
      page.tsx                          REWRITTEN (full)
    tools/                              DELETED
  components/
    plugins/
      PluginActions.tsx                 CHANGED (overflow restructuring, §4.4)
      ResetPluginAction.tsx             CHANGED (adds `trigger?: ReactNode`, no other change)
      RemovePluginAction.tsx            split out of PluginActions.tsx unchanged in logic; adds `trigger?: ReactNode`
      PluginStatusPill.tsx              NEW (§4.5, the six-state Badge)
      InstallPluginDialog.tsx           UNCHANGED
    settings/
      farmSections.ts                   CHANGED (splice `toolchain` beside `access`, §4.6)
      SectionNav.tsx                    UNCHANGED
      AccessSection.tsx                 NEW (§4.7, extracted from today's page.tsx `id === 'access'` branch)
      ToolchainSection.tsx              NEW (§4.8, replaces app/tools/page.tsx's body)
      FarmNetworksEditor.tsx            UNCHANGED
    AdbRestartDialog.tsx                UNCHANGED (imported by ToolchainSection)
    AppRestartDialog.tsx                UNCHANGED (imported by ToolchainSection)
    AdbServerCard.tsx                   DELETED (content folded into ToolchainSection, §4.8)
    AppRestartCard.tsx                  DELETED (content folded into ToolchainSection, §4.8)
    schema-form/
      plan.ts                           CHANGED (thread `hint` onto `PlannedField`, §4.9)
      controls/types.ts                 CHANGED (`BaseControlProps.hint?: string`)
      SchemaForm.tsx                    CHANGED (`Field` renders the hint line)
scripts/
  check-routes.ts                       CHANGED (prune the `/tools` row, §4.10)
```

### 4.2 `packages/studio/src/components/plugins/PluginStatusPill.tsx` (new, complete)

```tsx
'use client'

import { Badge, CircleIcon, cn } from '@enkaku/ui'
import type { PluginStatus } from '@enkaku/protocol'

/**
 * The six-state pill (plan 219 §3.3.2). The handoff draws two — `active` and
 * `staged` — with a dot-plus-Badge shape; the other four extend the same
 * two-tone system rather than inventing a third. `PluginRowView` is the only
 * caller.
 */
const TONE: Record<PluginStatus, { badge: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost'; dot: string; pulse?: boolean; label: string }> = {
  active: { badge: 'default', dot: 'bg-ok', label: 'active' },
  staged: { badge: 'secondary', dot: 'bg-faint-2', label: 'staged' },
  verifying: { badge: 'secondary', dot: 'bg-faint-2', pulse: true, label: 'verifying' },
  superseded: { badge: 'outline', dot: 'bg-faint-2', label: 'superseded' },
  failed: { badge: 'destructive', dot: 'bg-danger', label: 'failed' },
  disabled: { badge: 'ghost', dot: '', label: 'disabled' },
}

export function PluginStatusPill({ status }: { status: PluginStatus }) {
  const t = TONE[status]
  return (
    <Badge variant={t.badge} className="gap-1.5">
      {t.dot && <span aria-hidden className={cn('size-[6px] rounded-pill', t.dot, t.pulse && 'animate-enkaku-pulse')} />}
      {t.label}
    </Badge>
  )
}
```

`CircleIcon` is imported but unused in this snippet on purpose — a plain dot span is lighter than an icon for a 6px mark; the import is dropped in the real file (kept here only to document that the icon barrel was considered and rejected for this one glyph). **Do not** import `CircleIcon` if it ends up unused; `bun run typecheck`'s `noUnusedLocals` would fail the build.

### 4.3 `packages/studio/src/app/plugins/page.tsx` (rewritten, complete)

```tsx
'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  PluginRestartResponseSchema,
  type DevSlotView,
} from '@enkaku/protocol'
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  cn,
  relativeTime,
  useAction,
  ArrowsClockwiseIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  WarningIcon,
  XIcon,
} from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { InstallPluginDialog } from '@/components/plugins/InstallPluginDialog'
import { PluginActions } from '@/components/plugins/PluginActions'
import { PluginStatusPill } from '@/components/plugins/PluginStatusPill'
import { KvPanel } from '@/components/kv/KvPanel'
import {
  PluginsListSchema,
  devSlotMatches,
  groupPlugins,
  searchPlugins,
  type PluginMatch,
  type PluginListRow,
} from './plugin-list'

/**
 * The Plugins page (design handoff, "Screen: Plugins"; plan 219). Its scope
 * is one thing narrower than the prototype's: lifecycle only. Running a
 * script is a Scripts & Workflows or Device Control action now (plan 217,
 * 216); this page lists what can run, activates and disables it, and holds
 * the farm-wide Key/Value store (MVP 12 §5).
 */

function isoTime(v: string | null): string {
  if (!v) return '—'
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? v : relativeTime(Math.floor(ms / 1000))
}

type PluginsView = 'plugins' | 'storage'

export default function PluginsPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <PluginsScreen />
    </Suspense>
  )
}

function PluginsScreen() {
  const [view, setView] = useState<PluginsView>('plugins')
  const [items, setItems] = useState<PluginListRow[] | null>(null)
  const [dev, setDev] = useState<DevSlotView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/plugins', PluginsListSchema)
      .then((b) => {
        setItems(b.items)
        setDev(b.dev)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const reloadAll = () =>
    run('restart', () => api('/api/plugins/restart', PluginRestartResponseSchema, { method: 'POST' }), {
      failure: 'Could not restart the plugin registry',
      onSuccess: (b) => {
        toast.success(`Reloaded: ${b.ok} ok, ${b.failed} failed`)
        load()
      },
    })

  const groups = groupPlugins(items ?? [])
  const matches = searchPlugins(groups, query)
  const shownDev = (dev ?? []).filter((s) => devSlotMatches(s, query))
  const failedCount = (items ?? []).filter((p) => p.status === 'failed').length

  return (
    <>
      <PageHeader
        title="Plugins"
        description="Everything this farm can run — the plugins installed on it, and the scripts they register"
        actions={
          <>
            <Button size="sm" variant="secondary" disabled={isPending('restart')} onClick={reloadAll}>
              <ArrowsClockwiseIcon className="size-3.5" aria-hidden />
              Reload all
            </Button>
            <InstallPluginDialog
              onInstalled={load}
              trigger={
                <Button size="sm">
                  <PlusIcon className="size-3.5" aria-hidden />
                  Install plugin
                </Button>
              }
            />
          </>
        }
      />

      {/* The two-way toggle standing in for tabs the handoff does not draw
          (plan 219 §3.3.6): the handoff's own "Choice" field visual —
          option buttons, selected = accent border + accent-soft fill. */}
      <div className="flex gap-1.5 px-5 pt-4" role="tablist" aria-label="Plugins view">
        {(['plugins', 'storage'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              'rounded-input border px-3 py-[7px] text-body font-medium transition-colors',
              view === v ? 'border-accent bg-accent-soft text-accent' : 'border-border-2 bg-panel-2 text-text-2 hover:bg-muted-2',
            )}
          >
            {v === 'plugins' ? 'Plugins' : 'Key/Value store'}
          </button>
        ))}
      </div>

      {view === 'plugins' ? (
        <div className="px-5 py-4">
          {failedCount > 0 && (
            <div className="mb-4 flex items-start gap-2.5 rounded-inner border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-body text-danger">
              <WarningIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {failedCount} plugin{failedCount === 1 ? '' : 's'} failed to register — every other plugin, and every script it registered, is
                unaffected. See the error below each one.
              </span>
            </div>
          )}

          <div className="@container mb-4">
            <div className="relative min-w-0 max-w-md">
              <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search plugins…"
                aria-label="Search plugins"
                className="h-8 pr-8 pl-8"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear the search"
                  onClick={() => setQuery('')}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-text"
                >
                  <XIcon className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
            {query && items !== null && (
              <p className="mt-1.5 text-meta text-faint">
                {matches.length + shownDev.length} of {groups.length + (dev?.length ?? 0)} match "{query}"
              </p>
            )}
          </div>

          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : items === null || dev === null ? (
            <LoadingRows rows={4} />
          ) : items.length === 0 && dev.length === 0 ? (
            <EmptyState
              title="No plugins yet"
              description="Install one with the button above, or publish it from the SDK (definePlugin) — one bundle, many scripts sharing helpers and a KV namespace."
            />
          ) : matches.length === 0 && shownDev.length === 0 ? (
            <EmptyState
              title={`No plugin matches "${query}"`}
              description={`${groups.length + (dev?.length ?? 0)} plugin${groups.length + (dev?.length ?? 0) === 1 ? ' is' : 's are'} installed on this farm — none of them by that name, slug, version, or description.`}
              action={<Button size="sm" variant="outline" onClick={() => setQuery('')}>Show all plugins</Button>}
            />
          ) : (
            // The horizontal-scroll container the handoff's `min-width: 940px` implies: a
            // window narrower than the table scrolls the TABLE, matching every other page.
            <div className="overflow-x-auto rounded-card border border-line-2">
              <Table className="min-w-[940px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {/* grid 1.7fr 100px 160px 88px 132px, expressed as column widths on TableHead. */}
                    <TableHead className="w-[38%]">Plugin</TableHead>
                    <TableHead className="w-[100px]">Status</TableHead>
                    <TableHead className="w-[160px]">Scripts</TableHead>
                    <TableHead className="w-[88px]">Verified</TableHead>
                    <TableHead className="w-[132px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matches.map((m) => (
                    <PluginRowView key={m.group.name} match={m} onChanged={load} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      ) : (
        <div className="px-5 py-4">
          <KvPanel scope={{ kind: 'global' }} />
        </div>
      )}
    </>
  )
}

/** One row per plugin NAME (plan 219 §3.3.1), pointed at its live version or the newest. */
function PluginRowView({ match, onChanged }: { match: PluginMatch; onChanged: () => void }) {
  const versions = match.group.versions
  const live = versions.find((v) => v.status === 'active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const p = versions.find((v) => v.id === selectedId) ?? live ?? (versions[0] as PluginListRow)
  const isNewest = versions[0]?.id === p.id
  const declared = p.declaredScripts
  const registered = p.scriptCount ?? 0
  const detailHref = `/plugins/detail?name=${encodeURIComponent(p.name)}${selectedId ? `&version=${encodeURIComponent(p.version)}` : ''}`

  return (
    <TableRow>
      <TableCell>
        <Link href={detailHref} className="text-row font-semibold hover:text-accent">
          {p.title?.trim() || p.name}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-meta text-faint">{p.name}</span>
          {versions.length > 1 ? (
            <select
              className="rounded-[6px] border border-border-2 bg-muted px-1.5 py-0.5 font-mono text-meta text-text-2"
              value={p.id}
              onChange={(e) => setSelectedId(e.target.value)}
              aria-label={`Version of ${p.name}`}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version} · {v.status}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-meta text-text-2">{p.version} · {p.status}</span>
          )}
          {isNewest && <span className="rounded-pill bg-muted-2 px-1.5 py-0.5 text-meta text-faint">latest</span>}
          {versions.length > 1 && <span className="rounded-pill bg-muted-2 px-1.5 py-0.5 text-meta text-faint">{versions.length} versions</span>}
          {p.hasService && <span className="rounded-pill bg-warn-soft px-1.5 py-0.5 text-meta text-warn">service</span>}
        </div>
        {p.description?.trim() && <p className="mt-1 max-w-[460px] text-meta leading-relaxed text-faint">{p.description}</p>}
        {p.status === 'failed' && (
          <div className="mt-1.5 max-w-[460px] rounded-inner border border-danger/30 bg-danger-soft px-2.5 py-1.5">
            <p className="font-mono text-meta text-danger">{p.verifyErrorCode ?? 'E_PLUGIN_VERIFY_FAILED'}</p>
            <p className="mt-0.5 text-meta text-danger">{p.verifyError}</p>
          </div>
        )}
      </TableCell>
      <TableCell><PluginStatusPill status={p.status} /></TableCell>
      <TableCell className="whitespace-nowrap text-body text-faint">
        {registered} registered{declared.length > 0 && declared.length !== registered ? ` / ${declared.length} declared` : ''}
      </TableCell>
      <TableCell className="whitespace-nowrap text-meta text-faint">{isoTime(p.verifiedAt)}</TableCell>
      <TableCell className="text-right">
        <PluginActions versions={versions} selected={p} onChanged={onChanged} />
      </TableCell>
    </TableRow>
  )
}
```

`ScriptsSection`, `ScriptGroupRow`, `DevSlotCard`'s scripts-tab-only rendering, and every `?device=`/`?cluster=` deep-link handling this file had are **deleted, not ported**: they belonged to the Scripts tab, which plan 217's `/scripts` page now owns (`docs/mvp/03-navigation-and-pages.md` §1's table already maps `/plugins?tab=scripts` onto `Scripts & Workflows`). Dev slot cards are kept (a dev slot is a plugin lifecycle concept, not a script one) but simplified to plain rows under the table when `shownDev.length > 0`, following the same pattern the old file used at `:338-347`; the code block above omits that block only for length — the executor restores it unchanged in shape, re-skinned to the new tokens the same way `PluginRowView` was.

### 4.4 `PluginActions.tsx`: overflow restructuring

The lifecycle logic (`activate`, `rollback`, `reload`, `disable`, `enable` — `PluginActions.tsx:64-114`) is **unchanged**. What changes is only which element renders which button, per plan 219 §3.3.3's table:

```tsx
// packages/studio/src/components/plugins/PluginActions.tsx — the return statement, rewritten
import { Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DotsThreeIcon } from '@enkaku/ui'
// ...activate/rollback/reload/disable/enable unchanged above this line...

const scriptsMoved = declared.length // plan 219 §3.3.5 — known before the request, from the manifest

return (
  <div className="flex items-center justify-end gap-1">
    {p.status === 'staged' && (
      <ConfirmDialog
        trigger={<Button size="sm" variant="outline" className="h-7" disabled={isPending('activate-' + p.id)}>Activate</Button>}
        title={`Activate ${p.name}@${p.version}?`}
        description={
          <>
            <p>
              This version registers {scriptsMoved} script{scriptsMoved === 1 ? '' : 's'}
              {declared.length > 0 ? ` — ${declared.map((s) => `${p.name}/${s.id}`).join(', ')}` : ''} — which become what{' '}
              <span className="font-mono">{p.name}/@latest</span> resolves to.
            </p>
            <p className="mt-2">
              Any job already queued or running against the current active version keeps running against it — it is not moved.
            </p>
          </>
        }
        confirmLabel="Activate"
        onConfirm={() =>
          activate().then?.() /* the existing `run()` call; on success the toast states the ACTUAL counts (below) */
        }
      />
    )}
    {p.status === 'superseded' && (
      <Button size="sm" variant="outline" className="h-7" disabled={isPending('rollback-' + p.id)} onClick={rollback}>Rollback to this</Button>
    )}
    {p.status === 'failed' && (
      <Button size="sm" variant="outline" className="h-7" disabled={isPending('reload-' + p.id)} onClick={reload}>Reload</Button>
    )}
    {p.status === 'disabled' && (
      <Button size="sm" variant="outline" className="h-7" disabled={isPending('enable-' + p.id)} onClick={enable}>Enable</Button>
    )}
    {p.status === 'active' && (
      <ConfirmDialog
        trigger={<Button size="sm" variant="outline" className="h-7" disabled={isPending('disable-' + p.id)}>Disable</Button>}
        title={`Disable ${p.name}@${p.version}?`}
        description={/* unchanged from today's file, :148-161 */ null}
        confirmLabel="Disable"
        onConfirm={disable}
      />
    )}
    {p.status === 'verifying' && (
      <Button size="sm" variant="outline" className="h-7" disabled>Verifying…</Button>
    )}

    {(p.status === 'active' || true) && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 w-7 px-0" aria-label={`More actions for ${p.name}@${p.version}`}>
            <DotsThreeIcon className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {p.status === 'active' && (
            <DropdownMenuItem asChild>
              <ResetPluginAction selected={p} onChanged={onChanged} dense trigger={<span className="w-full">Reset data</span>} />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild className="text-danger focus:text-danger">
            <RemovePluginAction
              versions={versions}
              selected={p}
              onChanged={onChanged}
              dense
              scopes={/* unchanged from today's file, :196-202 */ ['version']}
              trigger={<span className="w-full">Remove</span>}
            />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )}
  </div>
)
```

`activate`'s own `run()` call (`PluginActions.tsx:64-69`) is changed in exactly one place — its `onSuccess`:

```ts
const activate = () =>
  run('activate-' + p.id, () => api(`/api/plugins/${p.id}/activate`, PluginActivateResponseSchema, { method: 'POST' }), {
    failure: 'Could not activate this version',
    onSuccess: (b) => {
      // plan 219 §3.3.5 — the ACTUAL counts, known only now.
      toast.success(
        `${p.name}@${p.version} activated`,
        b.queuedKeepingPrevious > 0
          ? { description: `${b.scriptsMoved} script${b.scriptsMoved === 1 ? '' : 's'} moved; ${b.queuedKeepingPrevious} queued job${b.queuedKeepingPrevious === 1 ? '' : 's'} kept the previous version.` }
          : { description: `${b.scriptsMoved} script${b.scriptsMoved === 1 ? '' : 's'} moved.` },
      )
      onChanged()
    },
  })
```

The plain, non-`ConfirmDialog` `success:` string this call had before (`:66`) is deleted — the toast is now composed in `onSuccess` because it needs the response body, which `useAction`'s static `success` string cannot read.

`ResetPluginAction.tsx` and `RemovePluginAction` (moved out of `PluginActions.tsx` into their own file, `RemovePluginAction.tsx`, purely a file split with no logic change, so `rg -n "export function RemovePluginAction"` still finds exactly one definition) each gain:

```ts
export function ResetPluginAction({
  selected,
  onChanged,
  dense = true,
  trigger, // NEW — plan 219 §3.3.4
}: {
  selected: PluginListRow
  onChanged: () => void
  dense?: boolean
  trigger?: ReactNode
}) {
  // ...unchanged body...
  return (
    <ConfirmDialog
      trigger={trigger ?? <Button size="sm" variant="ghost" className={btn} disabled={isPending('reset-' + p.id)}>Reset data</Button>}
      // ...unchanged...
    />
  )
}
```

Same shape for `RemovePluginAction`'s `trigger` prop, default unchanged from today's `:445-459`.

### 4.5 `packages/studio/src/app/settings/page.tsx` (rewritten, complete outline)

```tsx
'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { SettingsResponseSchema, UpdateSettingsResponseSchema } from '@enkaku/protocol'
import { Button, LoadingRows, ErrorState, api, useAction } from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { farmSections } from '@/components/settings/farmSections'
import { AccessSection } from '@/components/settings/AccessSection'
import { ToolchainSection } from '@/components/settings/ToolchainSection'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <SettingsScreen />
    </Suspense>
  )
}

function SettingsScreen() {
  const router = useRouter()
  const params = useSearchParams()
  const tab = params.get('tab') ?? 'general' // plan 212 §4.5: the default tab id becomes 'general'
  const [data, setData] = useState<{ settings: unknown; schema: unknown } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<unknown>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setData(b)
        setDraft(b.settings)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const save = () =>
    run('save', () => api('/api/settings', UpdateSettingsResponseSchema, { method: 'PATCH', json: draft }), {
      success: 'Settings saved',
      failure: 'Could not save settings',
      onSuccess: (b) => {
        setData((d) => (d ? { ...d, settings: b.settings } : d))
        setDraft(b.settings)
        setServerErrors({})
      },
    })

  if (error) return <ErrorState message={error} onRetry={load} />
  if (data === null || draft === null) return <div className="px-5 py-4"><LoadingRows rows={4} /></div>

  // farmSections() (plan 212 §4.5) derives nine schema-backed sections from
  // FarmSettingsSchema's own top-level keys, and splices in `access` before
  // `advanced`. This plan splices in one more bespoke section, `toolchain`,
  // directly after `access` — the ONLY place this page names a section that
  // is not a schema key, alongside `access` itself (plan 219 §3.3.8).
  const derived = farmSections(data.schema as never)
  const advancedAt = derived.findIndex((s) => s.id === 'advanced')
  const toolchain = { id: 'toolchain', title: 'Toolchain', group: 'Farm', keys: [] }
  const sections = advancedAt === -1 ? [...derived, toolchain] : [...derived.slice(0, advancedAt), toolchain, ...derived.slice(advancedAt)]

  const settingsSections: SettingsSection[] = sections.map(({ id, title, group, keys }) => ({
    id,
    title,
    group,
    render: () => {
      if (id === 'access') return <AccessSection />
      if (id === 'toolchain') return <ToolchainSection />
      const scoped = narrowSchema(data.schema as never, keys)
      return (
        <SchemaForm
          schema={scoped}
          value={draft}
          onChange={setDraft}
          serverErrors={serverErrors}
          onSubmit={save}
          onReset={() => setDraft(data.settings)}
          busy={isPending('save')}
          dirty={JSON.stringify(draft) !== JSON.stringify(data.settings)}
        />
      )
    },
  }))

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-[236px_1fr] gap-0 border-t border-line">
        <div className="border-r border-line px-2.5 py-3 pb-4">
          <SectionNav sections={settingsSections} active={tab} onChange={(id) => router.push(id === 'general' ? '/settings' : `/settings?tab=${id}`)} />
        </div>
        <div className="max-w-[720px] px-[22px] pt-[18px] pb-7">
          {settingsSections.find((s) => s.id === tab)?.render() ?? settingsSections[0]?.render()}
        </div>
      </div>
    </>
  )
}
```

This diverges from `SectionNav`'s own two-column grid (`SectionNav.tsx:149`, `grid gap-4 sm:grid-cols-[200px_1fr]`) on purpose: the handoff's Settings screen is a fixed 236px nav with no responsive collapse (the handoff has no mobile layout, plan 213 §2's non-goal), so this page renders its own outer grid and passes `SectionNav` only the tab list and the active id, using `SectionNav`'s internal rendering for the tabs themselves but not its two-column wrapper. **Do not** widen `SectionNav`'s own grid to serve this one caller; the device Settings tab (`app/device/page.tsx`, deleted by plan 215 in this same wave) and the agent editor still use `SectionNav`'s existing 200px column, and changing it would move a value plan 219 does not own.

### 4.6 `farmSections.ts`: no change needed beyond plan 212's own

`farmSections()` (plan 212 §4.5) already returns the derived nine plus `access`, spliced before `advanced`. This plan's own splice (`toolchain`, §4.5 above) happens in `page.tsx`, not in `farmSections.ts` — the function's contract (`(schema) => FarmSectionDef[]`, driven only by schema keys plus the one hardcoded `access` id) stays exactly what plan 212 shipped, and no plan-219 file imports or edits `farmSections.ts`. This is why G1's proof (a planted schema field appearing with no component edit) still holds after this plan: the schema-to-nav path (`farmSections` → the nine derived rows) is never touched here, only two more static rows are unioned in above it.

### 4.7 `packages/studio/src/components/settings/AccessSection.tsx` (new)

Extracted verbatim from today's `app/settings/page.tsx`'s `id === 'users'`/`id === 'audit'` branches (the exact tables, dialogs and `useAction` calls against `/api/users`, `/api/tokens`, `/api/audit` this plan does not re-derive — they are moved, not rewritten), re-skinned onto the new tokens the same way `PluginRowView` was in §4.3: `rounded-lg border` → `rounded-card border border-line-2`, `text-fg-muted` → `text-faint`, `bg-surface` → `bg-panel-2`, table classes per plan 204 §4.6's Table re-skin. No schema is involved — this section is a bespoke screen, matching §3.4 quote's own "the existing 22 sections plus a Toolchain section" framing before MVP 12 cut it down; Access is the one bespoke row MVP 12 §1 explicitly keeps ("Users and API tokens | not a field, a table; lives here").

### 4.8 `packages/studio/src/components/settings/ToolchainSection.tsx` (new)

Replaces `app/tools/page.tsx` (414 lines) as a Settings section rather than a standalone page. Content, re-skinned:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { DoctorResponseSchema, ToolsResponseSchema } from '@enkaku/protocol'
import { Button, Progress, api, useAction, fileSize, cn } from '@enkaku/ui'
import { AdbRestartDialog } from '@/components/AdbRestartDialog'
import { AppRestartDialog } from '@/components/AppRestartDialog'
import { isAdmin, useAuth } from '@/lib/auth'
import { ws } from '@/lib/ws'

// ...ToolEntry, InstallProgress, DoctorRun types, DOCTOR_TONE map — copied
// from app/tools/page.tsx:19-69 unchanged except DOCTOR_TONE's classes move
// to the new tokens (ok→text-ok border-ok/35 bg-ok/10, etc.)...

export function ToolchainSection() {
  // ...tools/diagnostics state and load()/act() logic copied unchanged from
  // app/tools/page.tsx:72-138...
  return (
    <div className="space-y-4">
      <div>
        <h2 className="border-b border-line pb-3 text-section font-semibold text-text">Toolchain</h2>
        <p className="pt-3.5 text-meta text-dim">Binaries the core uses to talk to devices, and the two restarts that affect the whole farm.</p>
      </div>

      {/* Restart cards — folded from AdbServerCard.tsx and AppRestartCard.tsx
          (deleted, §10). AdbRestartDialog and AppRestartDialog are imported
          UNCHANGED (plan 216 §3.3); only the surrounding card is new. */}
      <div className="rounded-card border border-line-2 bg-panel-2 p-4">
        <h3 className="text-row font-semibold text-text">adb server</h3>
        <p className="mt-1 text-meta text-faint">Shared with every other program on this machine using adb. Restarting it disconnects them all for a few seconds.</p>
        <AdbRestartDialog trigger={<Button size="sm" variant="outline" className="mt-3">Restart adb server</Button>} />
      </div>
      <div className="rounded-card border border-danger/30 bg-panel-2 p-4">
        <h3 className="text-row font-semibold text-text">Enkaku itself</h3>
        <p className="mt-1 text-meta text-faint">Every live session and stream drops; every in-flight job is interrupted.</p>
        <AppRestartDialog trigger={<Button size="sm" variant="outline" className="mt-3 text-danger">Restart Enkaku</Button>} />
      </div>

      {/* Doctor diagnostics and per-tool version cards — copied from
          app/tools/page.tsx:177-399, re-skinned. */}
    </div>
  )
}
```

The elided bodies are a straight token substitution of `app/tools/page.tsx`'s existing, working logic (state, `useEffect` WS subscription for `tool.install.progress`/`tool.changed`, the `act()` helper, the swappable/pinned tool lists) — no route, no request shape, no permission check changes. `Lock`, `RefreshCw`, `Stethoscope` (lucide) become `LockIcon`... **there is no `LockIcon` or `StethoscopeIcon` in plan 204's icon barrel** (`packages/ui/src/icons.ts`, §4.5 of that plan lists 53 handoff names plus 9 primitive names; neither appears). This plan does not extend the barrel for two icons a bespoke, undesigned section needs — it drops them: the "pinned to the core version" badge and the "Run diagnostics" button render as text-only, matching the discipline plan 213 §3.4 set when it added exactly one icon (`RobotIcon`) for exactly one need and argued why. `ArrowsClockwiseIcon` (already in the barrel, used for "Reload all" on the Plugins page) covers "Refresh manifest" and "Reinstall missing" here.

### 4.9 Threading `hint` through the schema-form renderer

`packages/studio/src/components/schema-form/controls/types.ts`, `BaseControlProps` (plan 219 addition, one line):

```ts
export interface BaseControlProps {
  id: string
  path: string
  label: string
  help?: string
  /** plan 212 §4.2's `hint` vocabulary key — an advanced field's "raise or lower if" sentence, distinct from `help` (its description). Rendered BELOW the control, 11.5px faint (handoff, "Text field... an 11.5px `var(--faint)` hint below"). */
  hint?: string
  error?: string
  value: unknown
  required?: boolean
  onChange(path: string, value: unknown): void
}
```

`packages/studio/src/components/schema-form/plan.ts`, beside the existing `help` assignment (today's `:663`):

```ts
help: typeof resolved.description === 'string' ? resolved.description : undefined,
hint: typeof hints.hint === 'string' ? hints.hint : undefined, // NEW
```

`PlannedField` (the interface `plan.ts:232` extends) gains `hint?: string` alongside its existing `help?: string`.

`packages/studio/src/components/schema-form/SchemaForm.tsx`'s `Field` function (today's `:264-316`) passes it through to `renderControl` exactly as it already passes `help`:

```tsx
return renderControl(field.plan, {
  id, path, label: field.label, help: field.help, hint: field.hint, error: errors[path], value, required: field.required, onChange,
})
```

Rendering the hint text itself is centralised in `controls/index.tsx`'s `renderControl` — the one place every leaf control's output already passes through — as a trailing `<p>` appended after whatever the control returns, when `props.hint` is set:

```tsx
// controls/index.tsx, renderControl(plan, props) — wraps its existing return
const control = /* existing per-control switch, unchanged */
if (!props.hint) return control
return (
  <div className="space-y-1">
    {control}
    <p className="text-meta text-faint">{props.hint}</p>
  </div>
)
```

**Do not** render the hint inside each control's own JSX (`ChoiceControl`, `NumberControl`, etc.) — that would mean editing nine files for one line of text that means the same thing everywhere, and the wrapper above already sits at the one seam `SchemaForm.tsx`'s own doc comment calls out as "the ONLY place a control is chosen." A control rendered in "bare" mode (`BaseControlProps`'s own doc comment: "render the bare widget only... no help text", used by `ListControl`/`TableControl` for item rows) never receives a `hint` in the first place, because `plan.ts` only sets `hint` from a leaf's own `x-enkaku.hint`, never inherited into a list item's per-row plan — so the bare-mode exclusion needs no extra code.

### 4.10 `scripts/check-routes.ts`: prune the `/tools` row

Plan 213 §4.10 ships `PENDING_REMOVAL` with a `/tools` row: `'/tools': 'plan 219: Toolchain section of Settings (MVP 03 §1.1)'`. This plan's only edit to that file is deleting that one line, once `app/tools/` is deleted and `/settings` (already in `NOT_IN_NAV_BY_DESIGN`... no — `/settings` is a real rail entry, not exempt at all, so no row names it either way) covers the Toolchain content instead. No other row changes.

## 5. Implementation steps

### 219.1 `PluginStatusPill`

- Files created: `packages/studio/src/components/plugins/PluginStatusPill.tsx` (§4.2).
- Verifiable result: `bun run typecheck` clean; the six `PluginStatus` values are exhaustively handled (a `Record<PluginStatus, …>` with no default makes an unhandled status a compile error).
- Do not: import `CircleIcon` if the dot stays a plain `<span>`.

### 219.2 `PluginActions.tsx` and `RemovePluginAction.tsx`: overflow restructuring

- Files changed: `packages/studio/src/components/plugins/PluginActions.tsx` (§4.4: the return statement, `activate`'s `onSuccess`), `packages/studio/src/components/plugins/ResetPluginAction.tsx` (adds `trigger?`).
- Files created: `packages/studio/src/components/plugins/RemovePluginAction.tsx` (moved out of `PluginActions.tsx`, unchanged logic, adds `trigger?`), `packages/studio/src/components/plugins/RemovePluginAction` re-exported from `PluginActions.tsx` is deleted — every importer (`plugin-list.ts` has none; `page.tsx` imports only `PluginActions`) is checked with `rg -l "RemovePluginAction" packages/studio/src`.
- Verifiable result: `bun run typecheck` clean; `rg -n "export function RemovePluginAction" packages/studio/src` → exactly one line, in the new file.
- Do not: change what `describeRemoveScope`, `previewBulkRemoval`, `summariseBulkRemoval` say or compute — only where their trigger renders.

### 219.3 Rewrite the Plugins page

- Files changed: `packages/studio/src/app/plugins/page.tsx` (§4.3, full rewrite), `packages/studio/src/app/plugins/plugin-list.ts` (delete `scriptMatches` and any export used only by the deleted Scripts tab; keep `groupPlugins`, `searchPlugins`, `devSlotMatches`, `PluginsListSchema`, `PluginListRowSchema`).
- Files deleted: none in this step (the old page's Scripts-tab code is deleted by being overwritten, not moved).
- Verifiable result: G5, G6, G8, G14; `bun run typecheck` clean.
- Do not: delete `app/scripts/page.tsx`'s redirect (plan 217 owns it) or `RunScriptDialog.tsx` (still imported by `app/scripts/detail/page.tsx` and elsewhere until plan 217 lands).

### 219.4 The activation consequence

- Files changed: `packages/studio/src/components/plugins/PluginActions.tsx` (the `activate` `ConfirmDialog` and its `onSuccess`, §4.4, §3.3.5).
- Verifiable result: G7 (owner smoke); a code-level check that `scriptsMoved` in the confirm text equals `declared.length`, not a separate computation.
- Do not: call `POST /:id/activate` twice (once to preview, once to commit) — plan 210 ships no preview route; the "before" half is computed from data already on the client.

### 219.5 Thread `hint` through the schema-form

- Files changed: `packages/studio/src/components/schema-form/controls/types.ts`, `packages/studio/src/components/schema-form/plan.ts`, `packages/studio/src/components/schema-form/SchemaForm.tsx`, `packages/studio/src/components/schema-form/controls/index.tsx` (§4.9).
- Test file: none (Studio has zero tests, plan 200 §8.3). `packages/studio/src/components/schema-form/plan.test.ts` and `SchemaForm.test.tsx` are already deleted by plan 201; **do not** write a replacement.
- Verifiable result: `bun run typecheck` clean; owner smoke §7.3 step 5 (open Advanced, confirm every one of the eleven fields shows a faint hint line the schema's `.meta(ui({ hint }))` text matches).
- Do not: add a `hint` prop to any control's own file; the wrapper in `renderControl` is the one seam.

### 219.6 `AccessSection.tsx` and `ToolchainSection.tsx`

- Files created: `packages/studio/src/components/settings/AccessSection.tsx` (§4.7), `packages/studio/src/components/settings/ToolchainSection.tsx` (§4.8).
- Files deleted: `packages/studio/src/components/AdbServerCard.tsx`, `packages/studio/src/components/AppRestartCard.tsx` (their content folds into `ToolchainSection.tsx`).
- Verifiable result: `bun run typecheck` clean; `rg -n "AdbServerCard\|AppRestartCard" packages/studio/src` → empty.
- Do not: touch `AdbRestartDialog.tsx` or `AppRestartDialog.tsx` themselves (G9); import them, do not edit them.

### 219.7 Rewrite the Settings page; delete `/tools`

- Files changed: `packages/studio/src/app/settings/page.tsx` (§4.5, full rewrite), `scripts/check-routes.ts` (§4.10, prune `/tools`).
- Files deleted: `packages/studio/src/app/tools/` (the whole directory), `packages/studio/src/components/FarmVideoFields.tsx`/`DeviceVideoFields.tsx` if plan 212 has not already removed them (check first; do not double-delete).
- Verifiable result: G1 (owner), G2, G4, G10, G11, G16.
- Do not: build the Agents Settings tab (plan 220); do not leave a `tab=defaults` fallback (plan 212 already renamed the default id to `general`).

### 219.8 Vocabulary and colour sweep

- Files changed: any file the G12/G13 greps still name.
- Verifiable result: `GREP_219_VOCAB` and `GREP_219_COLOUR` (§10.3) print nothing.

### 219.9 Status line and report

- Files changed: this document's `> Status:` line, §11.
- Verifiable result: `bash scripts/check-plan-status.sh` passes; `ps -Ao pid=,command= | grep -i "[o]penpf"` prints nothing but the shell.

## 6. Acceptance criteria

1. Every §0 row is checked, by its own command.
2. The Plugins page renders the five-column table with a working search, a status pill for every one of the six `PluginStatus` values, and a bordered-primary-plus-overflow action set that never clips at 940px.
3. Activating a staged version shows the manifest-derived script count and the "queued jobs are not moved" sentence before the request is sent; the success toast names the response's actual `scriptsMoved` and `queuedKeepingPrevious`.
4. The Key/Value store is reachable from the Plugins page's toggle and from nowhere under `/settings`.
5. The Settings page renders exactly the sections `farmSections()` derives from `FarmSettingsSchema` plus `access` and `toolchain`, in that order, with no other branch.
6. Every one of the eleven Advanced fields shows its `hint` sentence below the control.
7. `/tools` no longer exists as a route; its content (tool versions, doctor, both restart dialogs) is reachable at `/settings?tab=toolchain`.
8. `bun run typecheck` is clean; `bun run scripts/check-routes.ts` exits 0; every §10 proof prints nothing.

## 7. Test plan

Studio and `@enkaku/ui` have zero tests (plan 200 §8.3) — no `*.test.tsx` is written or run for anything in this plan.

```bash
bun run typecheck
bun run scripts/check-routes.ts
bun run scripts/check-design-tokens.ts
```

Nothing in `packages/core` or `packages/protocol` is changed by this plan, so no backend `bun test` invocation is scoped to it. If a future edit under this plan does touch a backend file (it should not — see §2), scope a test to that one file and say so in §11.

### 7.3 Manual owner smoke (no device needed; the local core on a scratch data dir)

```bash
ENKAKU_DATA_DIR=.dev-data-219 bun run dev &
bun run dev:studio &
sleep 5
```

1. Add a throwaway top-level key to `FarmSettingsSchema` (e.g. `general.smokeTest: z.string().optional().meta(ui({ title: 'Smoke test' }))`) on a scratch branch, restart the core, open `/settings`, confirm a "Smoke test" entry appears in the nav under General's group with no edit to `page.tsx` or `farmSections.ts`. Revert the schema change.
2. Open `/plugins`. Confirm the table has exactly Plugin / Status / Scripts / Verified / Actions; confirm an `active` plugin shows the accent pill with an ok dot and a `staged` one (install a second version of a bundled plugin without activating it) shows the muted pill with a faint-2 dot.
3. Click Activate on a staged version. Confirm the confirm dialog states the script count from the manifest and the "queued jobs are not moved" sentence. Confirm. Confirm the success toast names the actual `scriptsMoved`/`queuedKeepingPrevious`.
4. Click the "Key/Value store" toggle. Confirm `KvPanel` renders in global scope. Switch to `/settings?tab=toolchain`. Confirm the tool version list, doctor diagnostics, and both "Restart adb server" / "Restart Enkaku" buttons render and open their existing dialogs.
5. Open `/settings?tab=advanced`. Confirm every one of the eleven fields shows a faint hint line below it.
6. `curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/tools` → confirm the static export has no such page (404 from the export, or the dev server's own 404).

```bash
kill %1 %2
ps -Ao pid=,command= | grep -i "[o]penpf"   # nothing
```

Device tests: none. `ENKAKU_TEST_DEVICE=1` is not needed.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plan 212 lands with a different `farmSections()` shape than §4.6 assumes (e.g. `access` spliced after, not before, `advanced`) | this plan's own splice reads `advancedAt` dynamically (`derived.findIndex(...)`) rather than assuming a fixed index, so it survives either order; if `access` itself is missing this plan's `toolchain` splice still lands correctly relative to `advanced` |
| `AdbRestartPreviewSchema`'s `leasesHeld` field (today's name, `AdbRestartDialog.tsx:26`) may already be renamed by plan 205's activity-vocabulary sweep by the time this plan executes | this plan does not edit `AdbRestartDialog.tsx` at all (G9); whatever field name the schema carries at execution time is what the dialog (already correct, maintained by an earlier plan) reads — nothing here can drift from it |
| `ToolchainSection.tsx`'s elided bodies (§4.8) are described, not fully inlined, to keep this document under a workable length | the source is `app/tools/page.tsx`, read in full on 2026-09-03 and cited by line range; the executor copies it verbatim before re-skinning, so no logic is invented from memory |
| The two-button toggle (§3.3.6) is this plan's own invention, not drawn by the handoff | it reuses the handoff's own documented "Choice" field visual rather than a new pattern; §9 Q1 flags it for design review |
| Deleting `AdbServerCard.tsx`/`AppRestartCard.tsx` removes a component plan 216 listed as "owed" to this plan without saying whether it should survive as a file | plan 216 §10.2 names the four files as a set whose "last consumer" is `app/tools/page.tsx`; folding the two cards' content inline (keeping only the two dialogs as named, audited entry points) is the reading that satisfies "must be rebuilt on the Settings Toolchain section, never simply removed" — the CONTENT is rebuilt; the CARD FILES are not load-bearing on their own |

## 9. Open questions

1. Whether `KvPanel.tsx` should be re-skinned onto the new tokens as part of this plan or left on `theme.css` block D until a later pass — this plan leaves it untouched (§2), because re-skinning it is real design work with nothing in the handoff to match against.
2. Whether the Plugins page's Installed/Key-Value toggle should instead be two rail-level entries or a URL parameter (`?tab=storage`) for deep-linking — this plan ships local component state only (no URL sync), matching the simplest reading of "the KV browser moves to the Plugins page" without inventing a URL contract the handoff never drew.
3. Whether `ToolchainSection`'s missing icons (`Lock`, `Stethoscope` — not in plan 204's barrel) should be added to `packages/ui/src/icons.ts` in a follow-up, the way plan 213 added `RobotIcon` for one named need — this plan ships text-only labels instead and defers the icon question.

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| The Scripts tab on the Plugins page, `ScriptGroupsPageResponseSchema`/`ScriptToggleResponseSchema` usage, `RunScriptDialog` import, `scriptMatches` | `packages/studio/src/app/plugins/page.tsx` (old, 794 lines), `plugin-list.ts` | G14; `rg -n "ScriptGroupsPageResponseSchema\|ScriptToggleResponseSchema" packages/studio/src/app/plugins` → empty |
| `/tools` route | `packages/studio/src/app/tools/page.tsx` (414 lines) | `test ! -d packages/studio/src/app/tools` exits 0 |
| `AdbServerCard.tsx`, `AppRestartCard.tsx` | `packages/studio/src/components/` | `rg -n "AdbServerCard\|AppRestartCard" packages/studio/src` → empty |
| The `/tools` row of `PENDING_REMOVAL` | `scripts/check-routes.ts` | `rg -n "'/tools'" scripts/check-routes.ts` → empty; `bun run scripts/check-routes.ts` exits 0 |
| `FARM_SECTION_DEFS` as a page-level import (already removed by plan 212; re-proved here) | `packages/studio/src/app/settings/page.tsx` | `rg -n "FARM_SECTION_DEFS" packages/studio/src` → empty |
| `KvPanel` importer on the Settings page | `app/settings/page.tsx`'s `id === 'kv'` branch (already removed by plan 212; re-proved here) | `rg -l "components/kv/KvPanel" packages/studio/src` → exactly `app/plugins/page.tsx` |
| Any hardcoded field control on the Settings page (no bespoke input JSX outside `AccessSection`/`ToolchainSection`) | — | `GREP_219_HARDCODE` (§10.3) → empty |

### 10.3 The greps

```bash
# GREP_219_VOCAB: plan 200 §2.4's forbidden words in this plan's new files
rg -n -i -e "\blease" -e "\bcluster" -e "\bholder" -e "\bassist" -e "co-control" -e "\bconsole\b" packages/studio/src/app/plugins packages/studio/src/app/settings packages/studio/src/components/plugins packages/studio/src/components/settings/AccessSection.tsx packages/studio/src/components/settings/ToolchainSection.tsx

# GREP_219_COLOUR: no v3 bracket colour form, no dark: variant, no hex literal, in the same files
rg -n -e "\[--color" -e "\bdark:" -e "#[0-9a-fA-F]{3,8}\b" packages/studio/src/app/plugins packages/studio/src/app/settings packages/studio/src/components/plugins packages/studio/src/components/settings/AccessSection.tsx packages/studio/src/components/settings/ToolchainSection.tsx packages/studio/src/components/plugins/PluginStatusPill.tsx

# GREP_219_TOOLS: the old tools route and its two cards
rg -n "app/tools\|AdbServerCard\|AppRestartCard" packages/studio/src

# GREP_219_HARDCODE: no bespoke field JSX outside the two bespoke sections
rg -n "type=\"checkbox\"\|type=\"radio\"\|<select" packages/studio/src/app/settings/page.tsx
```

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
