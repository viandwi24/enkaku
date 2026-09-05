# Plan 310 — Choosing a script: the plugin → script palette, icons, and the end of the version picker

> Status: draft
> Ships: `packages/studio/src/components/scripts/ScriptPalette.tsx`
> Depends on: plans 216 (action dialogs), 217 (scripts page), 303 (node descriptors), 305–307 (the flow editor)
> Spec references: §4.5, §10, §11, §13

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Picking a script is a two-page palette — plugins, then that plugin's scripts — not a dropdown | `Combobox` gone from the run-script dialog | `rg -n "Combobox" packages/studio/src/components/actions/verb-dialogs.tsx` → no hit for the script field | [ ] |
| G2 | Typing on the first page searches **scripts across every plugin**, not only plugin names | a 3-character query that matches no plugin name still finds the script | owner smoke §7 step 2 | owner |
| G3 | `Backspace` on an empty query pops back to the plugin page | cmdk `pages` stack | owner smoke §7 step 3 | owner |
| G4 | A plugin may declare an icon; a script may declare an icon; both fall back to a stated default | `icon?: IconName` on the plugin and on the member; defaults `puzzle` / `play` | `bun test packages/sdk/src/plugin.test.ts` → `icons` group passes | [ ] |
| G5 | No screen asks an operator to choose a **script version** | the version `Select` is gone | `rg -n "pickedVersion\|onValueChange=\{\(version\)" packages/studio/src` → empty | [ ] |
| G6 | A script reference is still pinned, and the pin is shown as a fact | `name@<activated plugin version>`, rendered read-only | `bun test packages/core/src/workflows/registry.test.ts` → `pins version` still passes | [ ] |
| G7 | The jobs list no longer prints a script version | 0 matches | `rg -n "scriptVersion" packages/studio/src` → empty | [ ] |
| G8 | The palette is reachable from every place a script is chosen | 3 call sites: run-script dialog, schedule dialog, workflow node panel | `rg -n "ScriptPalette" packages/studio/src` → 3 importers | [ ] |
| G9 | `bun run typecheck` and `bun run build:studio` clean; no Studio test file added | 0 errors, 0 `*.test.tsx` | both exit 0; `rg --files packages/studio -g '*.test.tsx'` empty | [ ] |

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

_To be written by the executing agent._
