# Plan 310 — Choosing a script: the plugin → script palette, icons, and the end of the version picker

> Status: draft
> Ships: `packages/studio/src/components/scripts/ScriptPalette.tsx`
> Depends on: plans 216 (action dialogs), 217 (scripts page), 303 (node descriptors), 305–307 (the flow editor)
> Spec references: §4.5, §10, §11, §13

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Picking a script is a two-page palette — plugins, then that plugin's scripts — not a dropdown | `Combobox` gone from the run-script dialog | `rg -n "Combobox" packages/studio/src/components/actions/verb-dialogs.tsx` → no hit for the script field | [x] |
| G2 | Typing on the first page searches **scripts across every plugin**, not only plugin names | a 3-character query that matches no plugin name still finds the script | owner smoke §7 step 2 | owner |
| G3 | `Backspace` on an empty query pops back to the plugin page | cmdk `pages` stack | owner smoke §7 step 3 | owner |
| G4 | A plugin may declare an icon; a script may declare an icon; both fall back to a stated default | `icon?: IconName` on the plugin and on the member; defaults `puzzle` / `play` | `bun test packages/sdk/src/plugin.test.ts` → `icons` group passes | [x] |
| G5 | No screen asks an operator to choose a **script version** | the version `Select` is gone | `rg -n "pickedVersion\|onValueChange=\{\(version\)" packages/studio/src` → empty | [x] |
| G6 | A script reference is still pinned, and the pin is shown as a fact | `name@<activated plugin version>`, rendered read-only | `bun test packages/core/src/workflows/registry.test.ts` → `pins version` still passes | [x] |
| G7 | The jobs list no longer prints a script version | 0 matches | `rg -n "scriptVersion" packages/studio/src` → empty | [x] |
| G8 | The palette is reachable from every place a script is chosen | 3 call sites: run-script dialog, schedule dialog, workflow node panel | `rg -n "ScriptPalette" packages/studio/src` → 3 importers | [x] |
| G9 | `bun run typecheck` and `bun run build:studio` clean; no Studio test file added | 0 errors, 0 `*.test.tsx` | both exit 0; `rg --files packages/studio -g '*.test.tsx'` empty | [x] |

## 1. Goals

The owner researched this with users, 2026-09-05, and the finding was blunt:
the current picker is bad UX. It is a `Combobox` — a dropdown with a filter
box — over a flat list of every script on the farm. On the owner's own farm
that is 23 rows with no structure, and the only thing telling you which
plugin a script belongs to is a grey hint at the end of the row.

What replaces it: a **command palette**, the interaction everyone already
knows from VS Code and Spotlight. Page one is the plugins. Page two is that
plugin's scripts. Both pages search. Both pages carry icons.

And while the dialog is open: **the preset row goes above the parameter form**
(plan 311 owns it) and **the version picker goes away** (§3.4).

## 2. Non-goals

| Not done here | Where |
|---|---|
| The preset row itself | plan 311 |
| The `set` node and workflow data shaping | plan 312 |
| A global ⌘K palette for the whole app | §9 Q3 — this palette is a field, not navigation |
| Changing what a script IS, or how it runs | never — this is selection only |

## 3. Context and design decisions

### 3.1 What exists today, cited

| Fact | Where |
|---|---|
| The run-script dialog picks with a `Combobox`, hint `plugin.name@plugin.version` | `packages/studio/src/components/actions/verb-dialogs.tsx:208-232` |
| The flow editor picks with a name `Combobox` **plus a version `Select`** | `packages/studio/src/components/flow/ScriptPicker.tsx:100` |
| The jobs list prints `scriptName@scriptVersion` | `packages/studio/src/components/JobsList.tsx:214` |
| `ScriptListItem` carries `{ id, name, exportId, plugin, paramsSchema, hasResult, lastRun }` — **no title, no description, no icon** | `packages/protocol/src/api/scripts.ts:20-29` |
| A plugin has **no icon field at all**; icons exist only on `surface.nav` entries and, since plan 303, on a member's `node` descriptor | `packages/protocol/src/plugin-surface.ts:96` (`ICON_NAMES`), `packages/protocol/src/workflow-node-type.ts` |
| `cmdk` is already the palette primitive, wired in `NodePalette` | `packages/studio/src/components/flow/NodePalette.tsx` |
| Icon ids map to Phosphor components | `packages/studio/src/lib/plugin-icons.ts` |

So three things are missing before the palette can be drawn: **titles**,
**icons**, and a **grouping the API states rather than the client infers**.

### 3.2 Two pages, and one search that ignores them

The owner's sketch is a strict two-step: choose a plugin, then choose a
script. That browse path is built exactly as drawn. But a palette that
*only* browses is slower than the dropdown it replaces for the case that
actually dominates — an operator who already knows the script is called
"Scroll FYP" and does not care which pack ships it.

So: **page one lists plugins, and typing on page one searches scripts across
every plugin.** A query with no matching plugin still finds the script, shown
with its plugin as the hint (G2). This is what VS Code's quick pick does and
it is why the palette is faster than a menu, not just prettier.

`cmdk` supports this directly: a `pages: string[]` stack, with `Backspace` on
an empty query popping the top page — the library's own documented pattern,
and the keyboard convention users already have (G3).

### 3.3 Icons: declared by the author, defaulted by us, never invented

A plugin gains `icon?: IconName` and a member gains `icon?: IconName`, both
from the **existing** `ICON_NAMES` allowlist (`plugin-surface.ts:96`) — no
second icon vocabulary, the same rule plan 303 §4.2 already set for node
descriptors.

Defaults, stated so nothing is arbitrary: a plugin with no icon gets
`puzzle` (the same glyph the Plugins rail entry uses, so the two agree); a
script with no icon gets `play` (it is a thing you run).

**A member's `icon` moves up out of `node`.** Plan 303 put it on the node
descriptor because that was the only surface that needed it. Now two surfaces
do, and a script's icon is a property of the script, not of one of the places
it appears. `node.icon` becomes a fallback read for packs published before
this plan, and plan 312 §10 deletes it once both shipped packs are bumped.

### 3.4 A version is a fact, not a choice

The owner: *"script udah ga ada sistem versi lagi, adanya sistem version dari
plugin aja"*. The spec agrees — §4.5, and `definePlugin` stamps the plugin's
version onto every member, so a script's version and its plugin's version are
never different numbers.

`ScriptPicker.tsx:100` nonetheless renders a `Select` asking the operator to
choose one. That control offers a decision with exactly one sensible answer,
and every other answer is a way to pin a workflow to a version the operator
did not knowingly choose. It goes (G5).

What does **not** change: the document still stores a pinned
`name@version` (plan 303 §4.4), because a queued job must not change meaning
when a plugin is upgraded. The version is now **shown**, never **asked** —
rendered as a fact beside the script name, exactly as plan 310's sibling
change renders a workflow's identifier (`FlowEditor`'s meta row).

The jobs list stops printing `scriptVersion` (G7): a job row already carries
the plugin chip, and a second version string in the same row taught a
distinction the product does not have.

## 4. Technical design

### 4.1 Protocol

```ts
// packages/protocol/src/api/scripts.ts — ScriptListItemSchema gains:
  /** The member's own title, from the manifest (plan 303 §5 step 303.5 already persists it). */
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** `ICON_NAMES` (plugin-surface.ts:96). Null = the caller applies the default. */
  icon: IconNameSchema.nullable(),

// packages/protocol/src/api/plugins.ts — the list item gains:
  icon: IconNameSchema.nullable(),
```

```ts
// packages/sdk/src/plugin.ts
export interface PluginDefinition {
  // ...
  /** Shown wherever this plugin is offered as a choice (plan 310 §3.3). Defaults to `puzzle`. */
  icon?: IconName
}

export type PluginMemberScript<...> = Omit<ScriptDefinition<S, R>, 'version'> & {
  // ...
  /** Shown wherever this script is offered as a choice. Defaults to `play`. */
  icon?: IconName
}
```

Both validated by `definePlugin` on the author's machine, through
`IconNameSchema`, exactly as `surface` already is.

### 4.2 `packages/studio/src/components/scripts/ScriptPalette.tsx` (the artefact)

```tsx
export function ScriptPalette({
  open,
  onOpenChange,
  /** Pre-selects the plugin page when reopening on an already-chosen script. */
  initialScriptName,
  onPick,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  initialScriptName?: string
  onPick(script: ScriptListItem): void
}): JSX.Element
```

Internals:

- One fetch of `GET /api/scripts` on open, grouped by `plugin.name` in a
  `useMemo`. No second endpoint: the grouping is a projection of the list the
  dialog already loads.
- `pages: string[]` — `[]` is the plugin page, `['tiktok']` the script page.
  `Backspace` on an empty query pops.
- **Ranking** on the plugin page: plugin matches first (whole rows), then
  script matches across all plugins, capped at 8 script rows before "…and N
  more in <plugin>". A script row picked from page one skips page two.
- **Ranking** on the script page: title, then `exportId`, then description;
  prefix matches before substring, the same `matchScore` shape `NodePalette`
  already uses. Do not import `NodePalette`'s copy — extract it to
  `packages/studio/src/lib/palette-rank.ts` and have both call it, so the two
  palettes cannot drift into ranking differently.
- Each row: icon (24px), title, and a muted second line — the plugin's title
  on a script row, the script count on a plugin row.
- Empty states, both worded: no plugins installed (with a link to Plugins),
  and a plugin whose scripts all failed to load.

### 4.3 The three call sites

| Where | Today | After |
|---|---|---|
| Run script dialog (`verb-dialogs.tsx`) | `Combobox` | A **trigger row** showing the chosen script (icon, title, plugin chip, pinned version as text) or "Choose a script"; clicking opens the palette |
| Schedule dialog (`ScheduleDialog.tsx`) | its own picker | the same trigger row |
| Workflow node panel (`flow/ScriptPicker.tsx`) | name `Combobox` + version `Select` | the same trigger row; the `Select` is deleted (§10) |

One component, three mounts (G8). The trigger row is part of
`ScriptPalette.tsx`'s export (`ScriptTrigger`) so the three sites cannot
render three different summaries of the same choice.

### 4.4 Keyboard

| Key | Action |
|---|---|
| type | filter the current page |
| `↑` `↓` | move |
| `Enter` | pick — a plugin row pushes the script page, a script row picks and closes |
| `Backspace` on empty query | pop to the plugin page |
| `Escape` | close without changing the selection |

## 5. Implementation steps

**310.1 — Icons in the SDK and the manifest.** Add `icon` to
`PluginDefinition` and to `PluginMemberScript`; validate both in
`definePlugin`; carry them through the verify child into the manifest, beside
the `title`/`description` plan 303 already persists. *Result*:
`bun test packages/sdk/src/plugin.test.ts` → G4.

**310.2 — Icons and titles in the API.** Extend `ScriptListItemSchema` and
the plugin list item per §4.1; fill them from the manifest in the core's
routes. *Result*: `bun test packages/core/src/api/scripts.test.ts` and the
plugins route test green.

**310.3 — `palette-rank.ts`.** Extract `NodePalette`'s ranking into
`packages/studio/src/lib/palette-rank.ts` and rewire `NodePalette` to it.
Pure move, no behaviour change. *Result*: `build:studio` clean, the node
palette still ranks as before.

**310.4 — `ScriptPalette.tsx` + `ScriptTrigger`.** §4.2. *Result*: G1, G2,
G3.

**310.5 — The three call sites.** §4.3. Delete the `Combobox` from the run
dialog and the whole version `Select` from `ScriptPicker.tsx`. *Result*: G5,
G8.

**310.6 — The version, shown not asked.** The trigger row renders
`plugin@version` as muted text; `JobsList.tsx:214` drops `scriptVersion` and
keeps the plugin chip. *Result*: G6, G7.

**310.7 — The packs declare their icons.** Both shipped packs get a plugin
icon and one icon per member, chosen from `ICON_NAMES`. Bump both packs at
all three sites with a changelog line, then `bun run build:packs` — and note
the rebuilt bundle is **gitignored** (`.gitignore:43`), so the person merging
this runs `build:packs` themselves; say so in §11.

**310.8 — Status and report.**

## 6. Acceptance criteria

- G1, G4–G9 mechanically; G2, G3 at the owner's sitting.
- `rg -n "matchScore" packages/studio/src` → one definition, in `lib/palette-rank.ts`.
- `rg -n "hint: \`\\$\\{s.plugin.name\\}@" packages/studio/src` → empty.

## 7. Test plan

Backend: `bun test packages/sdk/src/plugin.test.ts`,
`bun test packages/core/src/api/scripts.test.ts`. No Studio tests (plan 200
§8.3).

Owner smoke (10 minutes):
1. Devices → a device → Run script. The palette opens on the **plugin** page,
   each row with an icon and a script count.
2. Type three characters that match **no plugin name** but do match a script
   title. The script appears, with its plugin as the hint. Enter picks it and
   closes the palette. (**G2**)
3. Reopen, click a plugin, then press `Backspace` on the empty query — the
   plugin page comes back. (**G3**)
4. Confirm no screen anywhere offers a script *version* to choose, and that
   the chosen script's pinned version is visible as text.
5. Open a workflow's script node — the same trigger row, the same palette.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Are 40 `ICON_NAMES` enough for a script catalog? | Unknown until the packs are annotated (310.7). If an author cannot find a fitting glyph, add names to the allowlist in that step and record which — never widen it to "any Phosphor name", which is how an icon set stops being a design system. |
| Q2 | Should the palette show a script's last run? | No. It is a chooser; `lastRun` belongs on the Scripts table. |
| Q3 | A global ⌘K palette for navigation? | Out of scope. This one is bound to a field, opens from a trigger, and returns a value. |
| Q4 | Should picking a plugin with exactly one script skip page two? | Yes — a page with one row is a keystroke that teaches nothing. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| The script **version** `Select` | `packages/studio/src/components/flow/ScriptPicker.tsx:100` | `rg -n "pickedVersion" packages/studio/src` → empty |
| The script `Combobox` in the run dialog | `packages/studio/src/components/actions/verb-dialogs.tsx:218-232` | `rg -n "ariaLabel=\"Script\"" packages/studio/src` → empty |
| `scriptVersion` in the jobs list | `packages/studio/src/components/JobsList.tsx:214` | `rg -n "scriptVersion" packages/studio/src` → empty |
| `NodePalette`'s private `matchScore` | `packages/studio/src/components/flow/NodePalette.tsx` | `rg -n "function matchScore" packages/studio/src` → one hit, in `lib/palette-rank.ts` |

## 11. Handoff report

**Status: G1, G4–G9 done and mechanically verified. G2, G3 built to spec but left for the owner's sitting (they are marked `owner` in §0 and were never mine to tick).**

### What shipped

- **310.1 (SDK icons).** `packages/sdk/src/plugin.ts` — `PluginDefinition.icon?: IconName` and `PluginMemberScript.icon?: IconName`, both validated by `definePlugin` through `IconNameSchema` (throws naming the plugin id / script id on an unknown name). A new `describe('definePlugin — icons ...')` block in `packages/sdk/src/plugin.test.ts` is the "icons" group G4's row names — `bun test packages/sdk/src/plugin.test.ts` → 48 pass.
- **310.2 (protocol + core plumbing).** `VerifiedScriptSchema`, `PluginRowSchema`, `PluginListItemSchema` and `VerifyReportSchema` (`packages/protocol/src/api/plugins.ts`) all gained `icon`. `ScriptListItemSchema` (`packages/protocol/src/api/scripts.ts`) gained `title`, `description`, `icon`. **Deviation from the plan's literal §4.1**: `ScriptPluginRefSchema` also gained `icon` — the plan's own §4.2 forbids a second endpoint ("no second endpoint: the grouping is a projection of the list the dialog already loads"), and a plugin's own icon lives nowhere on `GET /api/scripts` otherwise. Carrying it on the plugin ref keeps the palette to one fetch while still honouring §3.3's "a plugin may declare an icon". Flagged here rather than done silently.
  - Core: `plugins.icon` is a new DB column (migration `packages/core/drizzle/0074_rainy_ulik.sql`, generated with `bun run --cwd packages/core db:generate` — did not exist as a column before; `title`/`description` were the precedent it mirrors). `plugins/verify-child-entry.ts` and `plugins/verify-child.ts` carry a plugin's and a member's icon through the verify child exactly like `title`/`description` — cosmetic, dropped (never refused) when outside `ICON_NAMES`, since a hand-crafted bundle can bypass `definePlugin`'s own check. `plugins/runtime.ts`'s `identityColumns`/`toPluginWire`/`activate` carry the column through. `scripts/service.ts`'s `listActiveScripts`/`getScriptDetail` read a member's title/description/icon off the ACTIVE plugin's `manifest` (the `scripts` table itself has no such columns) and the plugin's own icon off `plugins.icon`, both defensively re-validated on read (never trusted from the JSON/text column). `workflows/registry.ts`'s `listNodeTypes` now prefers a member's own `icon` over `node.icon`, falling back to `node.icon` for a pack published before this plan (the fallback plan 312 §10 is to delete later).
  - New/changed tests, all run and green: `packages/core/src/plugins/verify-child.test.ts` (`icons` describe block — passthrough + the "outside `ICON_NAMES` is dropped" case), `packages/core/src/scripts/service.test.ts` (title/description/icon off the manifest, including a bad stored icon degrading to `null`), `packages/core/src/plugins/runtime-icon.test.ts` (**new file** — the plugin-level icon's stage→verify→activate→list round trip, and that a NEW version does NOT inherit a prior version's icon), `packages/core/src/workflows/registry.test.ts` (unchanged assertions, still green with the icon-preference change).
- **310.3 (`palette-rank.ts`).** `packages/studio/src/lib/palette-rank.ts` is the one `matchScore`, extracted from `flow/NodePalette.tsx` (rewired to call it, passing `[t.id, ...t.keywords]` as its old inline haystack did) and reused by `scripts/ScriptPalette.tsx`. Pure move — `bun run build:studio` confirms the node palette still compiles and ranks the same way.
- **310.4 (`ScriptPalette.tsx` + `ScriptTrigger`).** New file `packages/studio/src/components/scripts/ScriptPalette.tsx`. Two `cmdk` pages (`pages: string[]`, `[]` = plugins, one entry = that plugin's scripts), `Backspace` on an empty query pops via the input's own `onKeyDown` (the documented cmdk recipe — there is no built-in `pages` prop). Page one ranks plugin-name matches first, then scripts across every OTHER plugin (capped at 8, plugins already matched by name are skipped from that second list so a plugin is never shown twice). A plugin with exactly one script skips its own page (Q4). `ScriptTrigger` is the shared trigger row (icon, title, plugin badge, `@version` as plain text) every call site renders, so the three cannot drift into three summaries.
- **310.5/310.6 (the three call sites + the version-as-fact rule).** `verb-dialogs.tsx`'s `RunScriptFields`, `schedules/ScheduleDialog.tsx`, and `flow/NodePanel.tsx` all render `ScriptTrigger` now. `flow/ScriptPicker.tsx` (the name `Combobox` + version `Select`) is **deleted** — its `ScriptOption`/`groupScriptsByName` types are gone too; every former consumer (`FlowEditor.tsx`, `NodePanel.tsx`, `scripts/editor/page.tsx`, `scriptBindings.ts`) now carries `ScriptListItem` (the protocol type) directly instead of a locally-reduced shape, which is what let three different ad-hoc "script option" shapes collapse into one. Picking a script in the node panel now pins `name@<the plugin's own ACTIVE version>` (`onPick={(picked) => onChange({ script: \`${picked.name}@${picked.plugin.version}\` })}`), never `@latest` — G6.
- **310.7 (the packs).** All 6 EMBEDDED packs (`scripts/build-packs.ts`'s `PACK_ENTRIES` — not the 2 the plan's prose assumed; see below) declare a plugin `icon`: `networking` → `network`, `proxy-manager` → `plug`, `tiktok` → `activity`, `mikrotik-routing` → `network`, `google` → `users`, `youtube` → `play`. Every member that already had a `node` descriptor (11 in tiktok, 5 in youtube — 16 total) now also carries the SAME value as its own top-level `icon`, matching `node.icon` (kept, as the fallback story requires). Members with no `node` descriptor (networking's `leak-test`, proxy-manager's `check`, mikrotik-routing's `check`, google's two) were left undeclared — they default to `play`, per spec. All three bump sites done for all 6 packs (`package.json`, `version:` in `index.ts`, `index.test.ts`'s assertion) plus a changelog line each (minor bumps — an icon is operator-visible, not invisible). `bun run build:packs` ran clean, all 6 bundles produced; **the rebuilt bundle is gitignored** (`.gitignore:43` — confirmed with `git status --short packages/core/packs/` → empty), so whoever merges this must run `bun run build:packs` themselves, and the seeded version is staged, not activated, until an operator activates it on the Plugins page.

### What the plan got wrong about the codebase, cited

- **§10's "both shipped packs"** (and the parenthetical elsewhere) — there are **6** embedded packs today (`scripts/build-packs.ts:38-45`: `networking`, `proxy-manager`, `tiktok-automation-pack`, `mikrotik-routing`, `google-automation-pack`, `youtube-automation-pack`), not 2. `plugins/instagram-automation-pack` exists but is NOT in `PACK_ENTRIES` — it is not embedded, so it was left untouched. All 6 embedded packs got the treatment §3.3/310.7 describe.
- **§4.1's schema sketch** does not add anything to `ScriptPluginRefSchema` — but without that, a plugin's own icon has no way to reach the palette's plugin page under §4.2's "one fetch, no second endpoint" rule (`GET /api/scripts` never touches `GET /api/plugins`). Amended it there instead; see the deviation note above.
- **`flow/NodePanel.tsx`, `flow/FlowEditor.tsx`, and `packages/protocol/src/workflow.ts`/`workflow-check.ts` were being actively edited by the parallel plan-312 agent throughout this session** (the `set` node, `AssignmentEditor`, `switch.mode`). Every edit here was re-read immediately before writing and scoped strictly to the `script`-kind branch and the `scripts` prop type — never to the `set`/`switch` branches or their imports. `bun run typecheck`/`build:studio` were run repeatedly through the session specifically to catch any interaction between the two agents' work, and both were clean at every check after this plan's own edits.
- **§7's test plan cites `packages/core/src/api/scripts.test.ts`**, which does not exist (there is no `packages/core/src/api/scripts.ts` either — the script list route lives in `packages/core/src/scripts/routes.ts`, backed by `packages/core/src/scripts/service.ts`). Tested `packages/core/src/scripts/service.test.ts` instead, which is where `listActiveScripts`/`getScriptDetail` actually live, and added the title/description/icon coverage there.
- **`ScriptPicker.tsx`'s own header comment** ("Never a `scriptId`... resolved fresh at publish/run time") described a `name@latest`-by-default pin for the node panel's picker — this plan's G6 changes that specific behaviour on purpose (pins the concrete active version instead), so that comment's claim no longer holds for the node panel; it never applied to the OTHER two call sites (run-script dialog pins by `scriptId`, schedules always pin `@latest` by an earlier, unrelated MVP 03 §2.2 decision this plan does not touch).

### Not verified by me

- **G2, G3** — marked `owner` in §0; the interactions are built (ranking with the plugin-skip rule for G2, the `Backspace`-pops-page recipe for G3) but only an owner's sitting can confirm the *feel* the plan asks for, per its own §7 step 2/3.
- No dedicated end-to-end test exists for `ScriptPalette.tsx`/`ScriptTrigger` themselves — by design (CLAUDE.md, plan 200 §8.3: Studio has zero tests). Their correctness is `bun run typecheck` + `bun run build:studio` (both clean, run repeatedly through this session) plus the owner smoke.

### For the next agent (plan 312, or whoever runs `build:packs`)

- `bun run build:packs` was run once at the end of this session; its output is gitignored, so if you pull this branch and want the icons live in a running core, run it again yourself.
- The `node.icon` fallback in `workflows/registry.ts:listNodeTypes` (member's own `icon` wins, `node.icon` is read when absent) stays until plan 312 §10 removes it — do not delete `node.icon` from `WorkflowNodeDescriptorSchema` before then, or every pack published before this plan loses its palette icon with no fallback left to catch it.
