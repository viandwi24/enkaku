# Plan 311 — Presets: saved parameter sets, wherever parameters are entered

> Status: draft
> Ships: `packages/studio/src/components/presets/PresetRow.tsx`
> Depends on: plan 310 (the palette and the dialog layout it lands in); plans 301–307 for workflow params
> Spec references: §4.5, §4.6, §4.7, §11, §13

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The Run script dialog offers presets, **above** the parameter form | 1 row, rendered before `SchemaForm` | `rg -n "PresetRow" packages/studio/src/components/actions/verb-dialogs.tsx` finds it above the `SchemaForm` line | [ ] |
| G2 | A preset can be saved, applied, updated and deleted from that row without leaving the dialog | 4 actions | owner smoke §7 step 2 | owner |
| G3 | Workflows have presets too, keyed by workflow name | `kind = 'workflow'` rows resolve | `bun test packages/core/src/scripts/param-sets.test.ts` → `workflow presets` passes | [ ] |
| G4 | One store, one component, one concept — not two parallel preset systems | 1 table, 1 route family, 1 component | `rg -n "ParamSetPicker\|PresetRow" packages/studio/src` → only `PresetRow` remains | [ ] |
| G5 | The migration is additive and renames one column without losing a row | 1 `ADD COLUMN` + 1 `RENAME COLUMN`; row count unchanged | `bun run --cwd packages/core db:generate`, then `bun test packages/core/src/db/` → `preset migration` passes | [ ] |
| G6 | A preset survives a plugin upgrade | presets are filed under the NAME, never a version | `bun test packages/core/src/scripts/param-sets.test.ts` → `survives a publish` passes | [ ] |
| G7 | Applying a preset whose fields no longer exist in the schema says so instead of failing | unknown keys reported, known keys applied | same file → `partial apply` passes | [ ] |
| G8 | `bun run typecheck` and `bun run build:studio` clean; no Studio test file added | 0 errors, 0 `*.test.tsx` | both exit 0 | [ ] |

## 1. Goals

The owner, 2026-09-05: *"terus jangan lupa fitur preset scriptnya mana? kan
sebelumnya ada fitur preset, fitur preset diatasnya form input setting script
ini sehingga enak uxnya."*

The feature is not missing. It is **built, tested, routed — and mounted in
exactly one place nobody looks**: the schedule dialog. The Run script dialog,
which is where an operator actually types parameters, has never had it.

So this plan is mostly plumbing an existing thing into the right place, plus
one extension the owner did not ask for and §3.3 argues for.

## 2. Non-goals

| Not done here | Where |
|---|---|
| The script palette | plan 310 |
| Sharing presets between farms, or exporting them | §9 Q2 |
| Per-device presets | §9 Q1 — a preset is parameters, and parameters are not device-specific |
| Presets for action verbs other than run-script / run-workflow | none — those dialogs have no parameter schema |

## 3. Context and design decisions

### 3.1 What exists today, cited

| Fact | Where |
|---|---|
| Table `script_param_sets` — `{ id, scriptName, name, params, createdBy, createdAt, updatedAt }`, unique on `(scriptName, name)` | `packages/core/src/db/schema.ts:813-825` |
| Store: `listParamSets`, `createParamSet`, `updateParamSet`, `deleteParamSet` | `packages/core/src/scripts/param-sets.ts` |
| Routes: `GET`/`POST` `/api/scripts/:name/param-sets`, `PATCH`/`DELETE` `.../:id` | `packages/core/src/scripts/routes.ts:75-104` |
| Component `ParamSetPicker({ scriptName, schema, value, onApply })` | `packages/studio/src/components/ParamSetPicker.tsx:35` |
| Mounted in **one** place | `packages/studio/src/components/schedules/ScheduleDialog.tsx:396` |
| Filed under the script NAME, never a version, "so a preset outlives every publish" | `ParamSetPicker.tsx:44` (the component's own doc comment) |

That last row is the design already being right: the reason presets survive a
plugin upgrade is that they were never keyed to one. G6 protects it.

### 3.2 Position is the feature

A preset row below the form is decoration. Above it, it is a shortcut: you
open the dialog, recognise "nightly, slow", click it, and the form fills. The
owner said this plainly and it is the whole of §4.2's layout rule — the row
sits between the chosen-script trigger (plan 310 §4.3) and the `SchemaForm`,
never after it, and never inside a collapsed section.

### 3.3 Workflows get presets too, and the table stops being script-only

Not asked for, and included anyway, with the reason: since plan 301 a
workflow document carries its own typed `params[]`, and plan 306 §4.5 renders
them in the Run dialog through the same `SchemaForm`. The moment an operator
runs a workflow twice with different parameters they want the same shortcut,
and building it later means either a second table or a migration done twice.

So the table generalises **now**, while it holds few rows:

- `script_name` → `owner_name` (SQLite `ALTER TABLE … RENAME COLUMN`).
- new `kind text NOT NULL DEFAULT 'script'`, values `'script' | 'workflow'`.
- unique index becomes `(kind, owner_name, name)`.

`GET /api/scripts/:name/param-sets` keeps working unchanged (it implies
`kind = 'script'`), and `/api/workflows/:name/presets` is added beside it.
Two route families over one store, because the two owners already live under
two route trees and inventing `/api/presets?kind=` would be a third address
for a thing that has two natural homes.

### 3.4 Applying a stale preset is a warning, not a failure

A preset saved a month ago may name a field the script's schema no longer
has, or miss one it gained. Refusing to apply it would strand the operator
with data they can see and cannot use. So: **apply what matches, list what
did not**, in one line under the row — "2 fields applied, 1 no longer exists
(`retries`)". Unknown keys are dropped from the applied value, never written
into the form (G7).

## 4. Technical design

### 4.1 Schema and migration

```ts
export const paramPresets = sqliteTable(
  'script_param_sets', // table NAME unchanged — renaming it would rewrite it for nothing
  {
    id: text('id').primaryKey(),
    /** 'script' | 'workflow' (plan 311 §3.3). */
    kind: text('kind').notNull().default('script'),
    /** A script's `plugin/script` name, or a workflow's `name`. Never a version (plan 311 §3.1). */
    ownerName: text('owner_name').notNull(),
    name: text('name').notNull(),
    params: text('params', { mode: 'json' }),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [uniqueIndex('idx_param_sets_owner').on(t.kind, t.ownerName, t.name)],
)
```

Read the generated SQL before trusting it (G5): it must be one
`ALTER TABLE … RENAME COLUMN`, one `ADD COLUMN` with a default, and an index
swap — no table rebuild, no `DROP`.

### 4.2 `packages/studio/src/components/presets/PresetRow.tsx` (the artefact)

```tsx
export function PresetRow({
  kind,
  ownerName,
  schema,
  value,
  onApply,
}: {
  kind: 'script' | 'workflow'
  ownerName: string
  schema: JsonSchemaNode | null
  value: unknown
  onApply(next: unknown, report: { applied: string[]; unknown: string[] }): void
}): JSX.Element | null
```

Renders as **one row**, not a section: a `Select` of saved presets on the
left, and on the right a small menu with **Save as…**, **Update "<name>"**
(only with a preset selected and the form dirty against it), and **Delete**.
Returns `null` when `schema` is null — a script with no parameters has
nothing to preset, and an empty row is a question the operator has to answer
("what is this for?") for no reason.

`ParamSetPicker.tsx` is **replaced**, not wrapped (§10): it is the same
feature and two components would drift.

### 4.3 Where it mounts

| Dialog | Position |
|---|---|
| Run script (`verb-dialogs.tsx`) | between the script trigger (plan 310) and `SchemaForm` |
| Run workflow (`verb-dialogs.tsx`) | between the workflow trigger and its params form |
| Schedule (`ScheduleDialog.tsx`) | where `ParamSetPicker` is today, swapped in place |

### 4.4 API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/scripts/:name/param-sets` | unchanged; implies `kind='script'` |
| `POST` / `PATCH` / `DELETE` | same family | unchanged |
| `GET` / `POST` | `/api/workflows/:name/presets` | new, `kind='workflow'` |
| `PATCH` / `DELETE` | `/api/workflows/:name/presets/:id` | new |

Permissions mirror the existing ones: `script.view` to read, `job.run` to
write — a preset is an operator convenience, not a publish.

## 5. Implementation steps

**311.1 — Schema and migration** per §4.1; read the generated SQL. *Result*: G5.

**311.2 — Store and routes.** Generalise `param-sets.ts` to take `kind`;
add the workflow route family. *Result*: G3, G6, and
`bun test packages/core/src/scripts/param-sets.test.ts` green.

**311.3 — Partial apply.** The reconciliation of §3.4, in the store's read
path or the component — decide once and put it where both dialogs get it for
free. *Result*: G7.

**311.4 — `PresetRow.tsx`**, replacing `ParamSetPicker`. *Result*: G4.

**311.5 — Three mounts** per §4.3. *Result*: G1, G2.

**311.6 — Status and report.**

## 6. Acceptance criteria

- G1, G3–G8 mechanically; G2 at the owner's sitting.
- `test ! -e packages/studio/src/components/ParamSetPicker.tsx`.
- `rg -n "script_param_sets" packages/core/src` → the table definition only.

## 7. Test plan

| File | Covers |
|---|---|
| `packages/core/src/scripts/param-sets.test.ts` | script and workflow kinds; uniqueness per kind; survives a publish; partial apply |
| `packages/core/src/db/` (directory) | the migration on a populated table |
| `packages/core/src/api/workflows.test.ts` | the new preset routes |

Owner smoke (5 minutes):
1. Run script on a device, pick a script with parameters. The preset row is
   **above** the form.
2. Fill the form, **Save as** "nightly". Reopen the dialog, pick "nightly" —
   the form fills. Change a field, **Update "nightly"**. **Delete** it.
3. Run a workflow with parameters — the same row, the same behaviour.
4. Save a preset, upgrade the plugin, reopen — the preset is still there.

## 9. Open questions

| # | Question | Current answer |
|---|---|---|
| Q1 | Per-device presets? | No. A preset is parameters; a device is a target. Mixing them makes a preset unusable on the device it was not saved on. |
| Q2 | Export/import presets between farms? | Not now. It needs a file format and a collision rule; nobody has asked. |
| Q3 | Should the palette (plan 310) offer "Scroll FYP · nightly" as a row? | Tempting and refused for now: it couples two features and doubles the palette's row count. Revisit once presets are actually in daily use. |
| Q4 | A default preset applied automatically when the dialog opens? | No. Silent pre-filling is how an operator runs last week's parameters without noticing. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| `ParamSetPicker` | `packages/studio/src/components/ParamSetPicker.tsx` | `test ! -e packages/studio/src/components/ParamSetPicker.tsx` |
| `scriptName` as the preset key | `packages/core/src/db/schema.ts` | `rg -n "scriptName" packages/core/src/scripts/param-sets.ts` → empty |

## 11. Handoff report

_To be written by the executing agent._
