# Plan 95 — M60 : The Parameter Schema, and a Form Renderer Worth Sharing a Script Through

> Status: partial — steps 95.1–95.9 are implemented and unit-tested (`bash scripts/typecheck.sh`, `bun test`, and `bun run --cwd packages/studio test` all green). 95.10 (dropping `paramsSchema` from `GET /api/scripts`'s list projection) is gated on §0.3 H4's own measurement — record the `GET /api/scripts` response-size delta with the tiktok pack published at three versions, and revert the step, in writing, if the delta is under 50 KB, per plan 85 §85.7b's precedent — and that measurement has never been taken. It is therefore **not done and not skipped: it is un-triggered**, exactly as its own gate in §5 step 95.10 describes. 95.11 (documentation) is partial: `docs/design.md`'s "Schema-driven forms" section and `packages/sdk/README.md`'s authoring guide are rewritten and match the shipped code; `packages/protocol/README.md`, `docs/spec.md` §19's second sentence, and `docs/plans/00-overview.md` §9's `io: 'input'` note are not yet written. `docs/spec.md` §12 already documents `script_param_sets` (closing `bun run spec:check`'s GAP). §9 below records two defects steps 95.4 and 95.5 found and deliberately left in place, for a later plan to pick up.
> Depends on: Plan 05 (the script framework and `defineScript`), Plan 46 (the device Settings tab and `narrowSchema`), Plan 62 (`name@version` — a schedule stores the reference, a job stores the resolution), Plan 63 (the capability registry and its one `toJsonSchema` wrapper), Plan 64 (workspace publish and its import allowlist), Plan 82 (plugins, dev slots, the `ScriptRegistry`). None of them needs to change first; this plan adds a layer above all of them.
> Spec references: §12 (scripts and jobs), §19 (Studio screen spec — *"every config panel is rendered from a schema through the schema-driven form renderer — no hardcoded UI per component"*), §16 (NFR), §22 (a script marketplace, listed as future)
> Ships: packages/protocol/src/params/vocabulary.ts

---

## 0. Evidence

Every claim below is either **CONFIRMED** — there is a file and a line, or a
measurement taken against this repo's own installed Zod — or **HYPOTHESIS**,
with the step that tests it. Measurements marked *(measured)* were produced by
running `z.toJSONSchema` against this workspace's Zod under Bun; the probe
scripts are throwaway and the plan restates their output rather than shipping
them.

The brief this was written against: the parameter form is *"kurang
interaktif"*, and the owner wants script sharing — one script, many variations,
driven entirely by parameters — to be the product's differentiator.

### 0.1 Confirmed findings

#### How a params schema is produced and stored

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | Script params are converted Zod → JSON Schema in exactly **two** places, and **neither passes any options**. A third wrapper that *does* pass options exists but is capability-only and never sees a script. | `packages/sdk/src/cli/publish.ts:90`; `packages/core/src/plugins/verify-child-entry.ts:53`; `packages/protocol/src/capability/to-json-schema.ts:16-22` |
| **F2** | Zod 4's default `io` is `'output'`, which puts **every `.default()` field into `required`**. With `io: 'input'` the same schema emits `required: ['name']` only. So today every defaulted parameter is published as mandatory. *(measured)* | F1's two call sites; `packages/studio/src/components/schema-form/validate.ts:20-24` consumes `required` |
| **F3** | **`.refine()` and `.superRefine()` are silently dropped** by `z.toJSONSchema` — not "unrepresentable", so `unrepresentable: 'throw'` does not fire either. `.transform()` *does* throw, which the repo already knows. *(measured)* | `packages/protocol/src/settings.ts:101-104` (the `.transform()` half, documented); `packages/protocol/src/settings.test.ts:77-89` |
| **F4** | `.meta()` passes **arbitrary keys through verbatim**, including a nested object, straight onto the JSON Schema node. This is the whole mechanism this plan needs, and it is already there. *(measured)* | `packages/protocol/src/settings.ts:243-258` uses it today for `enumSource` |
| **F5** | `z.number().int()` with no explicit bounds emits `minimum: -9007199254740991, maximum: 9007199254740991`. Any control that derives a range from `minimum`/`maximum` must treat those as *unbounded*, not as a slider's ends. *(measured)* | — |
| **F6** | Only **three** `.meta()` keys are used anywhere in the repo: `title` (146 sites), `description` (object-level only — field-level help uses `.describe()`), and `enumSource` (**4** sites, all in one file). Script and plugin authors use `title` and nothing else. | `packages/protocol/src/settings.ts:243,248,253,258`; `plugins/tiktok-automation-pack/src/index.ts:292,299,306` |
| **F7** | `paramsSchema` crosses the publish boundary as `z.unknown().optional()`, is stored as a raw JSON column, and is served back **unvalidated** — the detail route's own comment says it deliberately bypasses `typedJson` because the column does not satisfy the response schema. | `packages/core/src/scripts/routes.ts:21`; `packages/core/src/db/schema.ts:376`; `packages/core/src/scripts/routes.ts:126-148` |
| **F8** | Studio then reads it through a bare `as` cast — `fetchAllPages` never parses. So an author-controlled blob reaches the renderer with **no** validation on any hop. | `packages/studio/src/lib/api.ts:17-30`; `packages/studio/src/app/device/page.tsx:192`; `packages/studio/src/components/RunScriptDialog.tsx:29` |
| **F9** | A script may import **only** `@enkaku/sdk` and `zod`; every other bare specifier is a build failure, `node:*` included. Any authoring helper this plan adds must therefore be reachable from `@enkaku/sdk`. | `packages/core/src/scripts/build.ts:33`, `:75-82` |

#### Validation

| # | Finding | Evidence |
|---|---------|----------|
| **F10** | **There is no server-side param validation at all.** The script executor's `validateParams` returns `params ?? {}`, and says so in its own comment. The only real parse happens in the child, after the device is leased. | `packages/core/src/jobs/executors/script.ts:12-13`, `:26-28`; `packages/core/src/jobs/validate-script.ts:11-24`; `packages/session/src/runner/child-entry.ts:416`, `:418` |
| **F11** | A batch validates the params blob **once** and fans the same object into every child job row. So a bad blob becomes N failing jobs, each of which leases a device first. | `packages/core/src/clusters/dispatch.ts:131`, `:87`, `:165-167` |
| **F12** | `SchemaForm`'s `serverErrors` prop is **dead across the whole repo** — declared, consumed internally, passed by nobody. Both param dialogs route a failure to a toast instead. | `packages/studio/src/components/schema-form/SchemaForm.tsx:37`, `:53`; `packages/studio/src/components/RunScriptDialog.tsx:258-291` |
| **F13** | API errors are `{ error: { code, message } }` with the message a **flat joined string and no field paths** — even where the paths existed and were joined away one line earlier. | `packages/core/src/util/errors.ts:18-20`; `packages/core/src/settings/farm-settings.ts:56-59` |
| **F14** | `SchemaForm` only blocks submission when `onSubmit` is wired. Neither `RunScriptDialog` nor `ScheduleEditorDialog` passes it, so **a form showing red fields submits anyway** — the external Run/Save button never consults `hasErrors`. | `packages/studio/src/components/schema-form/SchemaForm.tsx:54`, `:60-64`; `RunScriptDialog.tsx:499-501`; `ScheduleEditorDialog.tsx:415-416` |
| **F15** | The client validator compiles an **author-controlled regular expression on every keystroke**, inside a `useMemo` keyed on the whole value, and reports failure by printing the raw pattern at the user. | `packages/studio/src/components/schema-form/validate.ts:42`; `SchemaForm.tsx:52` |
| **F16** | The tiktok pack's own source records a **shipped instance** of exactly the failure this plan exists to prevent: a defaulted enum whose default the run form failed to apply, so pressing Run with nothing touched submitted `''` and the job died on validation before doing anything. The author's fix was to delete the parameter. | `plugins/tiktok-automation-pack/src/index.ts:271-283` |

#### Rendering

| # | Finding | Evidence |
|---|---------|----------|
| **F17** | `getNodeKind` recognises 8 kinds, and **every number renders as one bare number box** — `type="number"`, `max-w-40`, nothing else. There is no slider primitive anywhere in Studio. | `packages/studio/src/components/schema-form/resolve.ts:18-36`; `SchemaForm.tsx:192-205`; `docs/plans/92-m57-wall-first-and-video-quality.md:40` (F20) |
| **F18** | An **array of objects** renders each element through `String(item ?? '')` into a text input — i.e. `[object Object]`, and editing it destroys the row. | `SchemaForm.tsx:233-260` |
| **F19** | A `z.record(...)` emits `type: 'object'` with **no `properties`**, which `getNodeKind` calls `'object'` and the renderer draws as a **card with a heading and nothing inside it**. *(measured)* | `resolve.ts:26`; `SchemaForm.tsx:108-165` |
| **F20** | A discriminated union emits a top-level `oneOf` with no `type`, which falls through to `'unsupported'` → a raw JSON textarea. So conditional shapes are unsupported today, visibly. *(measured)* | `resolve.ts:31-35`; `SchemaForm.tsx:275-292` |
| **F21** | A **self-referential `$ref` is representable** (`z.lazy` emits `$defs.__schema0.properties.next → #/$defs/__schema0`) and `deref` recurses with **no visited set**. `applyDefaults`, `validateAgainstSchema` and `SchemaField` all recurse over `properties` unbounded as well. A published script can therefore hang the operator's tab. *(measured)* | `resolve.ts:4-13`, `:39-54`; `validate.ts:8-52`; `SchemaForm.tsx:108-165` |
| **F22** | `setAtPath` **assigns `undefined`**, which `JSON.stringify` then drops — so clearing an optional field is silently a no-op end to end. Already recorded against the settings PATCH merge; the renderer half lives in a file this plan owns. | `resolve.ts:74-87`; `docs/plans/92-m57-wall-first-and-video-quality.md:42` (F22); `packages/core/src/settings/farm-settings.ts:47-55` |
| **F23** | Studio contains **no `dangerouslySetInnerHTML` at all**, so an author's `title`/`description` is escaped text. The untrusted-schema risk is layout destruction, denial of service and social engineering — **not** script injection. | repo-wide search of `packages/studio/src` |

#### Grouping and ordering

| # | Finding | Evidence |
|---|---------|----------|
| **F24** | **`properties` order is declaration order, end to end.** Zod emits keys in declaration order, `JSON.stringify`/`JSON.parse` preserve it for identifier-shaped keys, and the renderer already walks `Object.entries(schema.properties)`. Field order is therefore already correct today and needs no new key. *(measured)* | `SchemaForm.tsx:109`, `:133` |
| **F25** | Grouping, by contrast, is a **hand-maintained parallel list in Studio — twice**: the device tab's `NAMED_GROUPS`, and the farm page's `FARM_SECTION_DEFS`. A third copy duplicates `narrowSchema`'s body minus its `child ?` guard, which is the crash its own test documents. | `packages/studio/src/components/settings/deviceSections.ts:16-26`; `packages/studio/src/app/settings/page.tsx:72-102`, `:186-189`; `packages/studio/src/app/settings/page.test.tsx:16` |

#### Reach, reuse, and cost

| # | Finding | Evidence |
|---|---------|----------|
| **F26** | There are **four** `SchemaForm` call sites and **one** `narrowSchema` call site. Two of the four are script params; two are settings. Anything done to the renderer lands on all four. | `settings/page.tsx:224`; `device/page.tsx:405-406`; `ScheduleEditorDialog.tsx:416`; `RunScriptDialog.tsx:482-489`; `narrowSchema.ts:10` |
| **F27** | **Nothing resembling a saved parameter set exists anywhere** — no preset, template, favourite, `savedParams`, or `defaultParams` in any package, and no `localStorage` in Studio. The only "remembered" value is the schema's own per-property `default`. | repo-wide search of `packages/**` |
| **F28** | The agent's only way to run a script is `job.run`, whose `params` is **`z.unknown()`** — the model gets no per-script schema at all. The same JSON Schema dialect (`draft-2020-12`) already feeds MCP `tools/list` and the harness ToolSet, so a stored `paramsSchema` would need **no conversion** to travel that path. | `packages/core/src/capability/job.ts:21`; `packages/core/src/mcp/server.ts:86-90`; `packages/core/src/agent/harness/tools.ts:71`; `packages/protocol/src/capability/to-json-schema.ts:3-14` |
| **F29** | A schedule stores `scriptRef` **plus** a `params` blob, resolved once per firing; the resulting batch and its jobs store the resolution. So a `@latest` schedule's params outlive every version bump of the script they were written for, with nothing checking them. | `packages/core/src/db/schema.ts:564-565`; `packages/core/src/schedules/runner.ts:205-217`; `docs/plans/62-m31b-script-references.md:51-62` |
| **F30** | `GET /api/scripts` returns the **full `paramsSchema` for every row** — one row per published version — and Studio's device page walks that list through `fetchAllPages` (200 per page, up to 25 pages). A pack published a dozen times ships a dozen copies of its schemas on every device-page load. | `packages/core/src/scripts/routes.ts:100-108`; `packages/studio/src/lib/api.ts:17-30`; `packages/studio/src/app/device/page.tsx:192` |
| **F31** | **No new dependency is needed for any control this plan adds.** `radix-ui@1.6.7` already carries `@radix-ui/react-slider`, `-checkbox`, `-radio-group` and `-toggle-group` as dependencies and re-exports them, and `InputGroup` + `InputGroupAddon` + `InputGroupButton` is already exactly the stepper anatomy (a control with a button at either end). | `packages/studio/package.json:28`; `packages/studio/node_modules/radix-ui/dist/slider.*`; `packages/studio/src/components/ui/input-group.tsx:11,69,109` |
| **F32** | Plan 94 §4.9 already proposes a script-adjacent params object with `.refine((p) => p.intervalMs[0] <= p.intervalMs[1], …)` — a constraint F3 shows would be silently absent from the generated schema. | `docs/plans/94-m59-action-recorder-and-task-scheduling.md:817` |
| **F33** | Plan 92's new video fields (`controlBitRate`, `wallMaxSize`, …) are declared **only** in `settings.ts` and appear in Settings with no Studio change, because the form is schema-driven. That is the multiplier: `bitrate` and `pixels` semantics would improve those fields for free. | `docs/plans/92-m57-wall-first-and-video-quality.md:39` (F19), `:448-514` |

### 0.2 What today's `SchemaForm` already does well — and is kept

This matters as much as the defect list: the parts below are not accidents,
they are the right instincts, and the redesign is an extension of them rather
than a replacement.

| # | Kept | Where |
|---|------|-------|
| **K1** | **`$ref`/`$defs` resolution.** Zod emits `$ref` for reused and recursive schemas; handling it is not optional, and it is already handled. This plan only adds the visited set F21 shows is missing. | `resolve.ts:4-13` |
| **K2** | **Defaults are seeded from the schema before first paint**, recursively. It is why a form opens filled in rather than empty, and it is the single biggest reason today's forms are usable at all. | `resolve.ts:39-54`; `SchemaForm.tsx:46-50` |
| **K3** | **Structure already chooses arity.** `prefixItems: [number, number]` is already recognised as one field with two inputs, not two fields. That instinct — *structure decides arity* — is the backbone of the resolver in §3.3, and it was here first. | `resolve.ts:22`; `SchemaForm.tsx:207-231` |
| **K4** | **`enumSource` is the best-designed thing in the subsystem** and is the model for everything added here: a **closed allowlist** of source names (an unknown value is ignored, not fetched), display names and availability pulled from `/api/registry`, an unavailable option shown *disabled with its reason* rather than hidden, and graceful degradation to the plain enum when the registry cannot be reached — *"the improvement does not depend on the most fragile part."* | `useEnumSource.ts:22-26`, `:42-48`, `:50-92`; `SchemaForm.tsx:332-357` |
| **K5** | **`narrowSchema`** — one schema, many visible slices, no change to the underlying value. It is what lets a 40-field settings object become six readable sections without a second data model. | `narrowSchema.ts:10` |
| **K6** | **`humanize`** as the last-resort label. A field never renders blank; the worst case is `Tap Jitter Ms`, which is ugly and *legible*. Totality by construction — the property §3.3 generalises. | `resolve.ts:57-62` |
| **K7** | **The nesting rule**: a top-level group is a card, a nested one gets only a left rule, *"cards inside cards add borders without adding clarity."* | `SchemaForm.tsx:128-131`, `:148-164` |
| **K8** | **The remount discipline in the run dialog.** `key={chosen.id}` guarantees one version's answers cannot leak into another's, and the comment at `:316-322` records *why* the reset happens in the handler and not in an effect (a child effect runs before its parent's, so a parent-effect reset would wipe the defaults `SchemaForm` had just seeded). That is a hard-won bug fix and the redesign must not regress it. | `RunScriptDialog.tsx:316-322`, `:484-487` |
| **K9** | **`deviceSections()` derives "General" as whatever the named groups did not claim**, so a new schema key can never silently appear nowhere. The named list is replaced in §3.5; this property is not. | `deviceSections.ts:38-44` |

### 0.3 Hypotheses (test before acting)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | *"Kurang interaktif"* is **F17**, not spacing or typography: every number is the same 10rem box, so a chance, a count, a duration and a byte size are visually indistinguishable and none shows its consequence. | The reference UI the owner showed differs from ours in exactly three ways — semantic widget, live value in the label row, behavioural help — and only the first requires new code. | 95.3 rebuilds the tiktok pack's own `auto-scroll` form (`index.ts:284-307`) plus one `chance` and one range under the new renderer, side by side with today's. The owner compares. If the complaint survives, §9 Q1 takes over rather than more controls being added on a guess. |
| **H2** | Declaration order survives the DB round-trip for **every** schema this product will see, so ordering needs no vocabulary at all (F24). | Key order is preserved by V8 and by `JSON.parse` for every non-integer-like key; every field name in this repo is identifier-shaped. | 95.2's test asserts order through `JSON.parse(JSON.stringify(z.toJSONSchema(...)))` for `DeviceSettingsSchema`, `FarmSettingsSchema` and the tiktok pack. 95.5's publish check makes identifier-shaped names a **rule**, which converts the observation into a guarantee. |
| **H3** | A stored parameter set will most often break by a **tightened bound or a removed enum member**, not by a removed field. | Authors add and constrain far more often than they delete; F16 is an instance (a parameter deleted *because* its value was invalid). | 95.7's `reconcileParams` reports `removed` / `reset` / `missing` / `invalid` as **separate** findings and the schedule pre-flight counts them per farm. After one release the counts say which, and the UI copy can be written to the real case instead of a guessed one. |
| **H4** | Moving `paramsSchema` out of the list response is a measurable page-load win (F30), not a micro-optimisation. | The tiktok pack alone declares three scripts; a 50-field settings-sized schema measured 12.5 KB serialised, and the list returns one row **per version**. | 95.10 records the `GET /api/scripts` response size with the pack published at three versions, before and after. If the delta is under 50 KB the step is recorded as not worth it, in writing, and reverted. |

---

## 1. Goals

- **A script author declares what a parameter *means*, in the schema, once** —
  and the run form, the schedule editor, the batch dialog, the device settings
  tab, the farm settings page and the agent's tool surface all improve
  together, with no React written anywhere.
- **The resolver is a designed artefact, not a `switch` inside a component.**
  A pure, total, deterministic function: JSON Schema node in, widget
  descriptor out. Testable with no DOM, with a published precedence table a
  reader can check by hand.
- **No schema can produce a blank field, a `[object Object]`, an empty card, or
  a hung tab.** Every input — including one written before this plan, and one
  written by someone hostile — renders as something a person can use or as an
  explicit, labelled escape hatch.
- **Bad parameters are refused before a device is leased.** The core validates
  against the published schema at enqueue, and the failure comes back as
  field-level messages the form can attach to the fields that caused them.
- **A parameter set survives the script being updated, or fails legibly.** Never
  silently reshaped, never silently dropped; an unattended caller (a schedule, a
  batch) stops rather than running a half-understood configuration.
- **Named parameter sets exist**, belong to the script *name* rather than a
  version, and reconcile through the same rule.
- **Grouping and ordering come from the schema alone.** No parallel list in
  Studio that can drift from it.
- **An untrusted schema has written limits** — size, depth, field count, string
  lengths, no author-controlled regular expression evaluated anywhere — and the
  operator can see who published the thing they are about to run.
- **The vocabulary names meaning, never pixels**, and the boundary is enforced
  by the package graph rather than by discipline: `@enkaku/protocol` contains
  no word that names a control.

## 2. Non-goals

- **Not a form builder or a visual schema editor.** Authors write Zod. Spec §19
  forbids per-component UI and this plan keeps it that way.
- **Not per-member parameters.** A different value per device in one batch is
  `batch_member_params`, named as out of scope by **plan 93 §2** and **plan 94
  §9 Q3**. This plan defines the parameter *contract*; distributing different
  values across a fan-out is a dispatch feature and belongs with plan 93.
- **Not the repeat/pacing controls.** `count`, the `[min,max]` interval and
  `deviceInterval` are **plan 94** (§4.9). This plan gives plan 94 the range
  control it needs, and takes nothing else from it — §3.9 states the interface.
- **Not bulk or fan-out execution.** **Plan 93** owns it.
- **Not one MCP tool per script.** F28 shows the schema would travel for free,
  but a dynamic tool roster is an agent-surface design question (naming,
  permissions, roster size) and gets its own plan. What this plan *does* give
  the agent is a real validation error instead of a runtime job failure (§3.7).
- **Not credential parameters.** `kind: 'secret'` is deliberately **not** in the
  vocabulary — §3.2 explains why masking a field that is then written in
  plaintext to four tables is theatre, and what to use instead.
- **Not a general expression language for conditional fields.** `showWhen` is
  one sibling field, one comparison, no boolean algebra (§3.6).
- **Not a general cross-field constraint DSL.** §3.6 solves the case that
  exists and says plainly what is left to the child process.
- **Not the settings PATCH merge.** F22's server half is plan 92's recorded
  defect; this plan fixes the renderer half only and says so.
- **Not `FARM_SECTION_DEFS`.** That list mixes schema-driven sections with
  screens that are not schemas at all (Users, Audit log, Connectors, KV). It is
  a page manifest, not a parallel copy of a schema, and it stays (§3.5).

## 3. Context and design decisions

### 3.1 Two halves, and both have to be good

The owner put it exactly right: a good schema **and** a good parser on the form
side, *"karena bertindak menampilkan component input yang tepat untuk schema
input parameter yang di-define."* They fail independently. A rich vocabulary
read by a naive renderer produces the same number box it does today; a clever
renderer with nothing to read has to guess, and a confident wrong guess is
worse than a plain box.

So this plan has two artefacts of equal weight:

1. **The vocabulary** — `@enkaku/protocol/src/params/`. What an author may say,
   as a closed, versioned, type-checked set. It contains no word that names a
   control.
2. **The resolver** — `packages/studio/src/components/schema-form/plan.ts`. A
   pure function from a schema node to a widget descriptor. It is the **only**
   place in the product where a control is chosen.

The line between semantics and pixels is therefore not a convention anyone has
to remember. It is the boundary between two packages, and `@enkaku/protocol`
does not depend on Studio.

### 3.2 The vocabulary

`.meta()` passes arbitrary keys straight through (F4), including nested
objects, so the mechanism costs nothing. Everything this plan adds lives under
**one** key, `x-enkaku`:

```ts
z.number().min(0).max(1).default(0)
  .describe('Save the video to a collection. Skipped if the Save button is not present.')
  .meta({ title: 'Save chance', 'x-enkaku': { kind: 'chance', group: 'Interaction' } })
```

One key rather than seven, for four reasons: one thing to size-limit, one thing
to validate, one thing to strip before handing a schema to an external
consumer, and zero collision surface with a future JSON Schema keyword. The
existing bare `enumSource` moves inside it as `source` — a rename, migrated at
all four call sites in the same commit, per 00-overview §4.3.

#### `kind` — the meaning of a value

Closed, nine entries, each earning its place against fields that exist today:

| `kind` | value | means | fields it already fits |
|---|---|---|---|
| `count` | integer ≥ 0 | a number of things | `videos`, `wall.maxTiles`, `maxIdleSessions` |
| `chance` | number in **[0,1]** | a probability evaluated at runtime | the reference UI's Like / Save / Save-sound |
| `duration` | number + `unit` | elapsed time | `execTimeoutMs`, `quietPeriodSec`, `idleTtlSec`, `perCharMs` |
| `bytes` | integer | a size in bytes | `maxPushBytes` (536 870 912), `maxValueBytes`, `maxOutputBytes` |
| `bitrate` | integer | bits per second | `controlBitRate`, `wallBitRate` (plan 92) |
| `pixels` | integer | a length on screen | `controlMaxSize`, `wallMaxSize`, `coordJitterPx` |
| `temperature` | number | degrees Celsius | `tempThresholdC` |
| `text` | string | free text | script params generally |
| `packageName` | string | an Android package id | plan 94's `reset.packages`, the tiktok pack's deleted `package` |

`unit` is `'ms' | 's' | 'min' | 'h'`, **required by and only valid for**
`duration`.

**`chance`, not `percent`.** The owner's reference UI shows `0%`, but the value
a script uses is a probability: `rng() < ctx.params.saveChance`, with no
division by 100 anywhere. Naming it `chance` and fixing its domain to `[0,1]`
kills the 0–100 / 0–1 confusion at the point of declaration rather than at the
point of a bug report, and the percentage stays where it belongs — in the
rendering. The resolver *requires* `minimum: 0` and `maximum: 1`; a `chance`
outside that domain is a publish-time error and, at render, degrades to a plain
number box.

#### What is deliberately **not** in the vocabulary

- **`range`.** The brief names it, and it is the one entry that has to be argued
  out rather than in. A `[min, max]` interval is already stated by the
  *structure* — `prefixItems` of length two — and K3 shows the renderer already
  reads it. A `kind: 'range'` would be a second statement of a fact the schema
  already carries, which means it can disagree with it. Instead: **structure
  decides arity, `kind` decides meaning.** A 2-number tuple with
  `kind: 'duration', unit: 's'` is *a pair of durations in seconds* — which is
  a range, rendered as a range, with `5s ~ 20s` in its label row. What the
  vocabulary *does* add is `ordered`, below, because "low end first" is genuine
  semantics that the structure does not carry.
- **`slider`, `stepper`, `dropdown`, and every other control name.** A schema
  that names a widget freezes the design system at the moment the script was
  published, and breaks the day Studio restyles. It is also unenforceable
  across a marketplace: a shared script cannot ship React (spec §19), so a
  widget name in its schema is a request Studio may not be able to honour.
- **The coloured dot** beside each chance in the reference UI, and the section
  header colours. Pure decoration; Studio may derive a group's accent from its
  index. Nothing in a schema should be able to pick a colour.
- **`secret`.** A masked input over `jobs.params` would be theatre: the value is
  written in the clear to `jobs.params`, `batches.params`, `schedules.params`
  and any saved parameter set (`schema.ts:218,346,565`). Masking the keystrokes
  and persisting the plaintext four times over is worse than not offering it,
  because it *looks* handled. Credentials belong in `ctx.kv` (plan 79), which is
  scoped, and the SDK guide will say so. Reconsidering this needs an encrypted
  column and a key, which is its own plan.

#### The rest of `x-enkaku`

| key | type | meaning |
|---|---|---|
| `ordered` | boolean | on a 2-number tuple: the pair is an interval, low end first. Default **`true`** — see below |
| `multiline` | boolean | on a string: the value is expected to be prose, not a token |
| `group` | string ≤ 40 chars | the section this field belongs to (§3.5) |
| `advanced` | boolean | a parameter most operators never change. Studio may collapse it; the schema does not say how |
| `source` | closed enum | where the set of allowed values comes from, when it is not literally in the schema (§3.4) |
| `labels` | `Record<string,string>` | human names for enum members, ≤ 60 chars each |
| `showWhen` | `{ field, is }` or `{ field, in }` | this parameter only applies when a sibling has a given value (§3.6) |

**`ordered` defaults to `true`**, which needs defending because it is an
inference. The rule this plan uses for whether a guess is allowed is:

> **A wrong inference must not make a valid value unreachable, and must not
> make an invalid value easy to enter.**

A textarea instead of an input passes (same values reachable, same values
rejected). A slider instead of a number box **fails** — a slider quantises and
hides precision, so the wrong guess costs the operator values they are entitled
to. Ordering a pair also fails that test on its face… except that `ordered:
false` exists, so the value is one word away, and *every* 2-number tuple in this
repository and in the reference UI is an interval (`tapJitterMs`,
`betweenActionMs`, `perCharMs`, plan 94's `intervalMs`, the reference UI's watch
time). A default with a written escape hatch is a different thing from an
unescapable guess, and choosing the other default would silently *remove*
validation that `validate.ts:45-50` performs correctly today.

#### Type-checked at the author's desk

The keys above are declared once and exported as a helper that scripts may
reach — which, by F9, means it must come out of `@enkaku/sdk`:

```ts
import { ui } from '@enkaku/sdk'

videos: z.number().int().min(1).max(2_000).default(30)
  .describe('How many videos to watch before stopping. The real count varies ±30%.')
  .meta(ui({ title: 'Number of videos', kind: 'count', group: 'Core settings' })),
```

`ui()` is a typed identity function returning
`{ title, description?, 'x-enkaku': {...} }`. It is where the vocabulary is
enforced for the 95% case: a misspelled `kind`, a `unit` on a non-duration, a
`labels` map on a non-enum are all **compile errors in the author's own
editor**. It is declared in `@enkaku/protocol` and re-exported from
`@enkaku/sdk` so a script's import allowlist is satisfied without widening it.

For authors not using TypeScript, and for anything that slips past, the same
rules run again at publish (§3.8).

### 3.3 The resolver

The second artefact, and the one the owner singled out. Its contract:

```ts
export function planField(node: JsonSchemaNode, ctx: PlanContext): FieldPlan
```

**Total.** Every input returns a `FieldPlan`. There is no `undefined`, no
`null`, and no throw. The terminal case is
`{ control: 'json', reason: '<one sentence>' }` — today's escape hatch (F20's
textarea), kept, but now carrying *why* instead of the generic *"No dedicated
editor for this type yet"*.

**Deterministic.** Same node, same plan. No fetching, no time, no randomness,
no DOM. `source`-driven option enrichment happens *after* planning, in the
control, exactly as `useEnumOptions` does today (K4) — so the plan is stable
even when `/api/registry` is down.

**Pure, and tested without React.** `plan.test.ts` is a plain `.ts` test that
imports no component. This is the property that makes the design system
replaceable: when Studio restyles, `plan.ts`'s tests still describe what the
form must express, and only the control files change.

#### The precedence table

Checked top to bottom; the first row that matches wins.

| # | Condition | Result | Kind of decision |
|---|---|---|---|
| 1 | `$ref` present | resolve against the root **with a visited set**; a cycle → `json` with *"this parameter refers to itself"* | structural |
| 2 | node depth > `LIMITS.maxDepth` | `json` with *"too deeply nested to render"* | safety |
| 3 | `x-enkaku.kind` present **and valid for this node's structural type** | the control for that kind | **declared** |
| 4 | `enum` or `const` present | `choice` (decorated by `labels`, then by `source`) | structural |
| 5 | `type: 'boolean'` | `toggle` | structural |
| 6 | `prefixItems` of length 2, both numeric | `pair` — `ordered` from `x-enkaku`, default `true`; each half planned by rows 3/9 | structural |
| 7 | `type: 'string'` and `format` in `{date-time, uri, email}` | the matching control | **JSON Schema's own semantics** |
| 8 | `type: 'string'` | `text` (`multiline` from `x-enkaku`, else from `maxLength > 200`) | structural |
| 9 | `type: 'number' \| 'integer'` | `number` — bounds from `minimum`/`maximum` **unless they are the `±MAX_SAFE_INTEGER` sentinels** (F5), step from `multipleOf` | structural |
| 10 | `type: 'array'` with object `items` | `table` — one planned column per property | structural |
| 11 | `type: 'array'` with scalar `items` | `list` of the planned item | structural |
| 12 | `type: 'object'` with a non-empty `properties` | `group`, children planned in declaration order | structural |
| 13 | `type: 'object'` with **no** `properties` (a `z.record`) | `json` with *"this parameter is a free-form map"* — **never the empty card of F19** | structural |
| 14 | `anyOf`/`oneOf` where exactly one branch is non-`null` | plan that branch (nullable unwrapping, as today) | structural |
| 15 | `anyOf`/`oneOf` with several real branches | `json` with *"this parameter can take several different shapes"* | structural |
| 16 | anything else | `json` with *"this parameter's type is not one the form can draw"* | terminal |

Two properties fall straight out of the table and are asserted as tests:
**row 16 is unreachable-by-failure** (it is a result, not an error), and
**every row above it degrades downward** — an invalid row-3 hint simply does not
match, so the node falls through to its structural row. An older script with a
bare `z.number()` therefore lands on row 9 and renders exactly as well as it
does today, which is the compatibility floor.

#### Where the resolver refuses to infer

The rule from §3.2 (*a wrong guess must not cost the operator a valid value*),
applied:

- **A `number` with `min 0, max 1` is not a chance.** `gestureCurvature` is
  `min(0).max(0.5)` and is not a probability; guessing would give it a
  percentage readout that is simply false. Requires `kind: 'chance'`.
- **A `number` with `min 0, max 100` is not a percentage.** It is at least as
  likely to be a count or a temperature.
- **A field named `*Ms` or `*Sec` is not a duration.** Inferring meaning from an
  identifier is the `humanize()` mistake one level deeper: it works until
  someone writes `timeoutMsOverride`, and then it is confidently wrong. The
  answer is not to sniff `settings.ts` — it is to **annotate** `settings.ts`,
  which is one package away and is step 95.4.
- **A `string` with a `pattern` is not validated by that pattern** — §3.8.

And where it does infer, with the reason:

- **Arity from structure** (row 6) — the schema literally says two.
- **`format`** (row 7) — JSON Schema's own semantic vocabulary, standardised
  and unambiguous; honouring it is reading, not guessing.
- **`multiline` from `maxLength > 200`** (row 8) — a textarea and an input
  accept exactly the same strings, so a wrong guess costs nothing but taste.

### 3.4 `source` — the second axis

`kind` says what a value *means*. `source` says where the *set of allowed
values* comes from when the schema cannot list it. Two axes, both with
precedent: `kind` is new, `source` is `enumSource` renamed, and `useEnumSource`
(K4) already implements it correctly.

The allowlist grows from four entries to seven:
`registry.transports | registry.displays | registry.inputs |
registry.inspectors | registry.networks | devices | clusters | scripts`.

It stays a **closed allowlist keyed in Studio** (`KEY_MAP`,
`useEnumSource.ts:42-48`): an unrecognised `source` is ignored and the plain
enum is used, so a script cannot name an arbitrary URL or an arbitrary endpoint.

**Does a device picker in a shared script's form leak the farm?** No, and the
reason is worth writing down rather than assuming: the fetch happens in the
operator's own browser, over the operator's own session, against an endpoint
the operator is already authorised for. The script's schema chose *which
picker*, not *what the picker may see*. It discloses nothing the operator could
not read by opening the devices page — and it is the operator, not the script,
who decides whether to submit the form.

This is also what replaces `kind: 'deviceRef'` from the brief: a device
reference is a **string whose allowed values come from the farm**, which is
exactly what `source` already expresses. Adding a parallel `kind` for it would
give two ways to say one thing.

### 3.5 Grouping and ordering, without a parallel document

**Ordering is already solved and needs no key at all.** F24: Zod emits
declaration order, JSON preserves it, and the renderer already walks it. The
brief's premise — *"Zod objects are unordered in JSON Schema terms"* — is true
of the *specification* and false of every implementation in this pipeline. The
honest engineering move is to write the guarantee down and then **enforce its
precondition**: 95.5's publish check requires identifier-shaped field names
(`/^[A-Za-z_][A-Za-z0-9_]*$/`), which is the exact condition under which
JavaScript preserves insertion order. One rule, and ordering becomes a
guarantee instead of an observation.

**Grouping is `x-enkaku.group`, and sections are consecutive runs.**

```ts
z.object({
  videos:   …ui({ title: 'Number of videos',    kind: 'count',    group: 'Core settings' }),
  watch:    …ui({ title: 'Watch time per video', kind: 'duration', unit: 's', group: 'Core settings' }),
  like:     …ui({ title: 'Like chance',          kind: 'chance',   group: 'Interaction' }),
  save:     …ui({ title: 'Save chance',          kind: 'chance',   group: 'Interaction' }),
})
```

A section is a **maximal run of adjacent fields sharing a `group`** — the same
"consecutive run" trick `groupByPlugin` (`RunScriptDialog.tsx:118-126`) and
`SectionNav` already use. Consequences, all deliberate:

- **No separate ordered list of groups.** A group's position is where its fields
  are, so the two can never disagree. This is the whole point: the brief asks
  for grouping *"without a second parallel document that drifts"*, and any
  `groups: [...]` array on the object node would be exactly that document.
- **Fields with no `group` render before the first heading**, ungrouped —
  exactly as `groupByPlugin` handles a script with no plugin.
- **`A, A, B, A` produces three sections, not two.** It is the legible reading
  of the author's own declaration order, and 95.5's publish check warns about
  the non-consecutive repeat so the author can reorder or accept it.

**Why not nested `z.object()`?** It already works (K7) and it stays supported —
but it changes the *data shape*: `params.core.videos` instead of
`params.videos`, which the author then lives with in `ctx.params` forever, and
which breaks every stored parameter set when a field moves between sections.
`group` keeps grouping a presentation concern, where it belongs.

**This deletes one of the two parallel lists (F25).** `deviceSections.ts`'s
`NAMED_GROUPS` becomes derivable once `DeviceSettingsSchema`'s top-level keys
carry `group`, and 95.4 does exactly that — keeping K9's property (a new key
lands in "General" automatically) by making "General" the run of fields with no
`group`. `FARM_SECTION_DEFS` stays, on purpose: it lists *screens*, several of
which (Users, Audit log, Connectors, KV store) are not schema fields at all. It
is a page manifest, not a shadow copy of a schema, and the distinction is the
test for whether a list is drift-prone.

### 3.6 Conditional fields, and the cross-field problem

#### `showWhen` — the part that is solved

```ts
'x-enkaku': { showWhen: { field: 'mode', is: 'advanced' } }
'x-enkaku': { showWhen: { field: 'mode', in: ['advanced', 'expert'] } }
```

Sibling key only, one comparison, no boolean algebra, no paths. A `field` that
does not exist among the siblings is a **publish-time error**; at render, an
unresolvable condition means the field is **shown** (never hidden by a
mistake).

A hidden field **still submits its value** — its default, or whatever it held
before it was hidden. Hiding is presentation; it must not change what runs. If
a hidden field is required and has no default, the form treats it as an error
on the *controlling* field, because that is where the operator can act.

This is semantics, not pixels: *"this parameter only applies when mode is
advanced"* is a fact about the parameter. It says nothing about how either field
looks.

#### The general case — solved where it exists, named where it does not

**The `[min,max]` case, which is the one that actually occurs, is not
cross-field at all.** It is a constraint on one value that happens to be a pair,
and `ordered` (§3.2) states it declaratively. The pair control clamps on edit,
enforces `a ≤ b`, and attaches its message to that one field — so plan 94's
`.refine((p) => p.intervalMs[0] <= p.intervalMs[1], …)` (F32) becomes
`ui({ kind: 'duration', unit: 'ms' })` on an ordered tuple, checked by the form,
by the core, and by the child, all from one declaration.

**Everything else is out of scope, and here is the honest mechanism.** F3 is
the hard constraint: a `.refine()` does not survive `z.toJSONSchema` at all, so
the core — which holds only the JSON Schema, never the live Zod object — cannot
evaluate it, and running the bundle on the core's own process to find out is
exactly what `build.ts`'s doctrine forbids. Rather than invent a rules DSL that
duplicates the `.refine()` the author must write anyway (and can drift from
it), this plan does two things:

1. **Tells the author, at publish, exactly what the form cannot check.** The CLI
   holds the *live* Zod schema and can see its checks, so
   `enkaku publish` prints:
   > `warning: params carries 1 refinement that the run form cannot evaluate. Operators will see it as a job failure, not a form error. Consider an ordered range, showWhen, or a per-field bound.`
   This is the difference between a limitation and a trap.
2. **Makes the backstop cheap and legible.** The child already parses with the
   real schema (`child-entry.ts:416`) and throws `PARAMS_INVALID` — but today
   that happens *after* the device is leased and the run has begun. 95.6 moves
   every constraint that *is* representable (types, bounds, enums, required,
   range order) to enqueue time, so the only failures left in the child are
   genuine refinements, and the error names the fields.

An enqueue-time round trip through a real child process — spawn, `params.parse`,
exit — would close the gap completely and is genuinely tempting. It is a job
runner and IPC change, one process spawn per Run click, and it is **§9 Q2**, not
a paragraph in this plan.

### 3.7 Validation, and the lie in the current comment

`validate.ts:5-6` says *"The server stays authoritative — this only exists for
fast feedback."* For script parameters that is false (F10): the server validates
nothing, and the first authority is a child process on a leased device.

**Decision.** One validator, in `@enkaku/protocol`, used by **both** the browser
and the core:

```ts
export function validateParams(
  schema: JsonSchemaNode,
  value: unknown,
): { ok: true } | { ok: false; issues: ParamIssue[] }

export interface ParamIssue { path: string; message: string }
```

- It lives in protocol because that is the only package both the core and Studio
  import, because `bun test` covers it from the repo root (Studio's tests need a
  separate invocation), and because it is pure.
- It is the **same** function Studio runs on change and the core runs at
  `POST /api/jobs`, `POST /api/batches` and `POST/PATCH /api/schedules` — so the
  form and the server can never disagree about what is acceptable. Today they
  cannot agree because only one of them has an opinion.
- It replaces `packages/studio/src/components/schema-form/validate.ts` entirely.
- Its `issues` are **paths**, not a joined string. `EnkakuError` grows an
  optional `issues` field so `{ error: { code, message, issues } }` reaches the
  browser (F13 shows the paths already exist server-side and are thrown away one
  line before the response).
- Studio maps `issues` straight onto `SchemaForm`'s `serverErrors` — the prop
  that has existed and been dead since it was written (F12).
- `SchemaForm` gains a `canSubmit` callback so the *external* Run and Save
  buttons can be disabled, closing F14.

What it deliberately does **not** check: `pattern` (§3.8), and anything a
`.refine()` expressed (§3.6). Both are stated in the SDK guide rather than left
to be discovered.

**The agent gets this for free.** `job.run`'s `params` stays `z.unknown()` (F28)
— but the enqueue path it calls now validates, so a model that guesses a
parameter gets `invalid_job_params` with field paths *before* a device is
leased, instead of a job that fails minutes later. That is the whole of the
agent-surface improvement in this plan; one tool per script is §9 Q3.

### 3.8 An untrusted schema

A shared script's schema is author-controlled input rendered in the operator's
browser and stored in the operator's database. F23 establishes that it is not an
XSS surface (no `dangerouslySetInnerHTML` anywhere in Studio, so every string is
escaped text). What remains is real anyway:

| # | Risk | Evidence | Answer |
|---|---|---|---|
| **R1** | **Unbounded `$ref` recursion hangs the tab.** A self-referential `$defs` entry is representable, and `deref` has no visited set — nor do `applyDefaults`, `validateAgainstSchema` or `SchemaField` | F21 | A visited set in the resolver (row 1 of the table); a depth cap (row 2); the same cap in the validator and in default-seeding |
| **R2** | **ReDoS.** An author's `pattern` is compiled and run on every keystroke | F15 | **No author-supplied regular expression is ever evaluated — in the browser or in the core.** See below |
| **R3** | **Size.** `paramsSchema` is `z.unknown()` with no cap, stored raw and served raw | F7 | 64 KiB serialised, enforced at publish and clamped at render |
| **R4** | **Text bombs.** A 100 000-character `description` destroys the page | F23 | `title` ≤ 80, `description` ≤ 300, label ≤ 60, group ≤ 40 — truncated with an ellipsis at render, rejected at publish |
| **R5** | **Field-count explosion** | F7 | ≤ 200 fields, ≤ 200 enum members per field, depth ≤ 5 |
| **R6** | **Social engineering.** *"Paste your farm token here"* is valid, escaped, well-formed text | — | Not a sanitisation problem. The run dialog shows **provenance**: who published this version and when (`scripts.createdBy`/`createdAt` exist and are already returned by the list route; the dialog does not show them) |
| **R7** | **`source` as a capability leak** | §3.4 | Closed allowlist, fetched with the operator's own session, against endpoints the operator already reads |

**On `pattern`, in full**, because it is the one place this plan removes a
feature rather than adding one. A regular expression from an untrusted author
is the single JSON Schema keyword that can hang whichever process evaluates it,
and JavaScript offers no way to bound a match. In the browser it costs the
operator their tab; in the core it costs the farm. It is not worth taking that
risk for a check the child re-runs anyway with the real Zod schema. So:

- The shared validator **does not evaluate `pattern`**, on either side.
- A `pattern` present in a schema is **surfaced as help text** when the field
  has no `description`, so the constraint is at least visible.
- The constraints that *were* being expressed as patterns get first-class,
  Enkaku-owned validators instead: `kind: 'packageName'` is checked by
  **our** code, `format: 'uri'`/`'email'`/`'date-time'` by ours. That is a real
  payoff of a semantic vocabulary rather than a syntactic one: **naming the
  meaning lets us validate safely where a raw regex cannot.**

Limits live in one exported constant, `PARAMS_LIMITS`, and are enforced in three
places so no path is privileged: `POST /api/scripts` (standalone publish), the
plugin verify child (`verify-child-entry.ts`), and the resolver itself (a schema
already in the database from before this plan must still render). Publish
rejects with `E_PARAMS_SCHEMA_INVALID` naming the limit and the offending path;
render clamps and shows one line at the top of the form.

### 3.9 Interfaces to plans 93 and 94

- **Plan 94 gets the `pair` control** — `ordered: true`, a live `3 min ~ 8 min`
  summary in the label row, clamping. Its `pacing` block (94 §4.9) declares
  `intervalMs` as an ordered 2-tuple with `ui({ kind: 'duration', unit: 'ms' })`
  and **drops its `.refine()`**, which F32 shows would have been silently absent
  anyway. Plan 94's `count` and `deviceIntervalMs` take `kind: 'count'` and
  `kind: 'duration'`. This plan builds the control and the vocabulary; plan 94
  builds the pacer, the schema, and the consequence sentence.
- **Plan 93 gets nothing it must wait for.** Its bulk actions are batches, and
  batches gain enqueue-time param validation (§3.7) with no work on its side.
  Its `internal:push`/`internal:pull` executors already parse their own params
  with real Zod schemas server-side, which is the shape this plan is generalising
  toward.
- **Per-member parameters** (`batch_member_params`) are neither plan's, and not
  this one's (§2). What this plan owes that feature when it arrives is a
  well-defined per-field identity — a stable path, a plan, and a validator — so
  the distribution layer can key on it. All three exist after 95.2 and 95.6.

---

## 4. Technical design

### 4.1 The vocabulary — `packages/protocol/src/params/vocabulary.ts` (new)

```ts
/** The value's meaning. Closed and versioned: adding an entry is a protocol
 *  change, and the resolver must degrade gracefully on one it does not know
 *  (a schema published by a newer core, rendered by an older Studio). */
export const PARAM_KINDS = [
  'count', 'chance', 'duration', 'bytes', 'bitrate',
  'pixels', 'temperature', 'text', 'packageName',
] as const
export type ParamKind = (typeof PARAM_KINDS)[number]

export const DURATION_UNITS = ['ms', 's', 'min', 'h'] as const
export type DurationUnit = (typeof DURATION_UNITS)[number]

/** Where the set of ALLOWED VALUES comes from, when the schema cannot list it.
 *  A closed allowlist — an unrecognised value is ignored, never fetched. */
export const PARAM_SOURCES = [
  'registry.transports', 'registry.displays', 'registry.inputs',
  'registry.inspectors', 'registry.networks',
  'devices', 'clusters', 'scripts',
] as const
export type ParamSource = (typeof PARAM_SOURCES)[number]

export type ShowWhen =
  | { field: string; is: string | number | boolean }
  | { field: string; in: Array<string | number | boolean> }

/** Everything an author may say about a parameter, beyond `title` and
 *  `.describe()`. Nothing here names a control — see plan 95 §3.1. */
export interface ParamHints {
  kind?: ParamKind
  /** Required by, and valid only for, `kind: 'duration'`. */
  unit?: DurationUnit
  /** 2-number tuples only: the pair is an interval, low end first. Default true. */
  ordered?: boolean
  /** Strings only: the value is prose, not a token. */
  multiline?: boolean
  /** Section heading. Adjacent fields sharing a value form one section. */
  group?: string
  /** A parameter most operators never change. */
  advanced?: boolean
  source?: ParamSource
  /** Human names for enum members. */
  labels?: Record<string, string>
  showWhen?: ShowWhen
}

export const ENKAKU_META_KEY = 'x-enkaku' as const

/** The Zod schema every hint object is checked against — at publish, and when
 *  a stored schema is read. Unknown keys are STRIPPED, not rejected: a schema
 *  published by a newer core must still render on an older Studio. */
export const ParamHintsSchema: z.ZodType<ParamHints>

/** Read the hints off a JSON Schema node, safely. Returns `{}` for a node with
 *  no hints, malformed hints, or hints from a newer vocabulary. Never throws. */
export function readHints(node: JsonSchemaNode): ParamHints
```

The authoring helper, same file, re-exported from `@enkaku/sdk`:

```ts
export type UiSpec = { title: string; description?: string } & ParamHints

/** `.meta(ui({ title: 'Save chance', kind: 'chance' }))` — a typed identity
 *  function. Its whole value is the compile error an author gets for a
 *  misspelled kind, a `unit` on a non-duration, or a `labels` map on a
 *  non-enum. */
export function ui(spec: UiSpec): Record<string, unknown>
```

Overloads make the invalid combinations unrepresentable rather than merely
documented:

```ts
export function ui(spec: { title: string; description?: string; kind: 'duration'; unit: DurationUnit } & Omit<ParamHints,'kind'|'unit'>): Record<string, unknown>
export function ui(spec: { title: string; description?: string; kind?: Exclude<ParamKind,'duration'>; unit?: never } & Omit<ParamHints,'kind'|'unit'>): Record<string, unknown>
```

### 4.2 Limits — `packages/protocol/src/params/limits.ts` (new)

```ts
export const PARAMS_LIMITS = {
  /** Serialised bytes. A 50-field schema with 200-character descriptions
   *  measures ~12.5 KB, so this is ~5x a generous real schema. */
  maxSchemaBytes: 64 * 1024,
  /** Device settings' deepest real nesting is 3 (`job.retry.backoffBaseMs`). */
  maxDepth: 5,
  maxFields: 200,
  maxEnumMembers: 200,
  maxTitleChars: 80,
  maxDescriptionChars: 300,
  maxLabelChars: 60,
  maxGroupChars: 40,
  /** Field names must be identifier-shaped — this is what makes declaration
   *  order a guarantee rather than an observation (plan 95 §3.5). */
  fieldNamePattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
} as const

export interface SchemaCheckFinding { path: string; limit: keyof typeof PARAMS_LIMITS | 'hints' | 'showWhen'; message: string }

/** Publish-time gate. Returns every finding, not the first — an author fixing
 *  a schema should get one list, not one error per round trip. */
export function checkParamsSchema(schema: unknown): SchemaCheckFinding[]
```

### 4.3 The shared validator — `packages/protocol/src/params/validate.ts` (new)

Replaces `packages/studio/src/components/schema-form/validate.ts`.

```ts
export interface ParamIssue { path: string; message: string }

export function validateParams(schema: JsonSchemaNode, value: unknown): { ok: true } | { ok: false; issues: ParamIssue[] }
```

What it checks: `required`, type, `minimum`/`maximum` (ignoring the F5
sentinels), `multipleOf`, `minLength`/`maxLength`, `enum` membership,
`prefixItems` arity and element types, `ordered` pairs (`a ≤ b`), array
`minItems`/`maxItems`, `format` for `uri`/`email`/`date-time` using
Enkaku-owned parsers, `kind: 'packageName'`, and `kind: 'chance'`'s `[0,1]`
domain. Recursion is bounded by `PARAMS_LIMITS.maxDepth` and a `$ref` visited
set.

What it does **not** check, by design: `pattern` (§3.8), and anything a
`.refine()` expressed (§3.6).

Messages are written for a person who did not author the script: `"must be at
most 2000"`, `"the earliest time cannot be later than the latest"`, `"choose one
of: as-listed, random"`.

### 4.4 Reconciliation — `packages/protocol/src/params/reconcile.ts` (new)

The schema-evolution rule, in one pure function, used by presets, schedules,
batch rerun, and the run dialog.

```ts
export type FindingKind =
  | 'removed'   // stored key the schema no longer declares — dropped
  | 'reset'     // stored value no longer valid; the schema has a default — reset to it
  | 'invalid'   // stored value no longer valid and there is no default
  | 'missing'   // schema requires it, the stored set has it not, and there is no default

export interface ReconcileFinding { path: string; kind: FindingKind; detail: string }

export interface ReconcileResult {
  value: unknown
  findings: ReconcileFinding[]
  /** `invalid` or `missing` present — an unattended caller must refuse. */
  blocking: boolean
}

export function reconcileParams(schema: JsonSchemaNode, stored: unknown): ReconcileResult
```

**The rule, stated once and applied everywhere:**

> A stored parameter object is never silently reshaped and never silently
> rejected. At the moment it meets a schema it is reconciled, and the
> reconciliation is reported.
>
> | stored | schema | outcome |
> |---|---|---|
> | present, valid | declares it | kept |
> | absent | declares it, has a `default` | filled from the default |
> | absent | declares it, **no** default | **`missing`** |
> | present, now invalid | has a `default` | reset to the default, **`reset`** |
> | present, now invalid | **no** default | **`invalid`** |
> | present | does not declare it | dropped, **`removed`** |
>
> **An unattended caller stops on `blocking`.** A schedule firing, a batch, a
> rerun-failed: the run does not happen, and the failure names the fields —
> exactly as plan 62 §4.5 already refuses to enqueue a partial batch when a
> reference cannot resolve, for the same reason (*"half a batch is worse than
> none, because half a batch looks like it worked"*).
>
> **An attended caller does not stop.** The run dialog opens with those fields
> highlighted and focused, because a human is right there and can answer.

### 4.5 The resolver — `packages/studio/src/components/schema-form/plan.ts` (new)

```ts
export type FieldPlan =
  | { control: 'toggle' }
  | { control: 'choice'; options: PlannedOption[]; source?: ParamSource }
  | { control: 'number'; kind: NumberKind; unit?: DurationUnit; min?: number; max?: number; step?: number }
  | { control: 'pair'; ordered: boolean; item: Extract<FieldPlan, { control: 'number' }> }
  | { control: 'text'; multiline: boolean; format?: 'uri' | 'email' | 'date-time'; maxLength?: number }
  | { control: 'list'; item: FieldPlan }
  | { control: 'table'; columns: { key: string; label: string; plan: FieldPlan }[] }
  | { control: 'group'; heading?: string; children: PlannedField[] }
  | { control: 'json'; reason: string }

export interface PlannedField {
  path: string
  label: string
  help?: string
  /** Section heading, from a run of equal `group` values (plan 95 §3.5). */
  group?: string
  advanced: boolean
  required: boolean
  showWhen?: ShowWhen
  plan: FieldPlan
}

export interface PlanContext { root: JsonSchemaNode; depth: number; seen: ReadonlySet<string> }

/** Total, deterministic, DOM-free. Plan 95 §3.3's table, in order. */
export function planField(node: JsonSchemaNode, ctx: PlanContext): FieldPlan

/** The whole form: declaration order preserved, groups formed from
 *  consecutive runs, defaults seeded. One call per schema, memoised on the
 *  schema's identity — never per render, never per keystroke. */
export function planForm(schema: JsonSchemaNode): PlannedField[]
```

`packages/protocol` never mentions `control`. That is the semantics/pixels line,
enforced by the package graph.

### 4.6 Controls — `packages/studio/src/components/schema-form/controls/` (new)

One file per control, each ~40–90 lines, each taking a `FieldPlan` and a value.
Every one of them renders **the current value, right-aligned in the label row**
(the reference UI's second property), formatted by `kind`:

| control | built from | label-row readout |
|---|---|---|
| `NumberControl` | `InputGroup` + two `InputGroupButton`s (F31 — the stepper anatomy already exists) | `30`, `20 s`, `512 MB`, `6 Mbps`, `1080 px`, `45 °C` |
| `ChanceControl` | `Slider` from `radix-ui` (F31 — already a dependency) + the same readout | `35%` |
| `PairControl` | two `NumberControl`s separated by `~`, clamped when `ordered` | `5 s ~ 20 s` |
| `ToggleControl` | today's `Switch`, unchanged | — |
| `ChoiceControl` | today's `EnumField`, plus `labels` (K4 kept whole) | the selected label |
| `TextControl` | `Input` or `Textarea` per `multiline` | character count when `maxLength` is set |
| `ListControl` | today's array editor, with the item planned rather than stringified | `4 items` |
| `TableControl` | a real row editor — one planned control per column (closes F18) | `3 rows` |
| `JsonControl` | today's textarea, plus `plan.reason` (closes F19, F20 legibly) | — |

`bytes` and `bitrate` are **displayed** humanised and **stored** as the raw
integer — no unit conversion on input, so no rounding subsystem and no value
the schema's bounds would reject.

### 4.7 Storage — parameter sets

```ts
/** A named parameter set for a script NAME (plan 95 §3.x). Keyed on the name,
 *  not a `scripts.id`: a preset is standing intent about a script, exactly as
 *  a schedule's `scriptRef` is (plan 62 §3.3) — it must outlive the version it
 *  was written against, and be reconciled when it meets a new one. */
export const scriptParamSets = sqliteTable('script_param_sets', {
  id: text('id').primaryKey(),
  scriptName: text('script_name').notNull(),
  name: text('name').notNull(),
  params: text('params', { mode: 'json' }),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => [uniqueIndex('idx_param_sets_script_name').on(t.scriptName, t.name)])
```

One Drizzle migration, generated with `bun run --cwd packages/core db:generate`
(the next number after `0040_misty_blade.sql`). No backfill — the table starts
empty, because F27 says nothing like it exists to migrate.

### 4.8 API

| Method | Path | Permission | Body / response |
|---|---|---|---|
| `GET` | `/api/scripts/:name/param-sets` | `script.view` | `{ items: ParamSetInfo[] }` |
| `POST` | `/api/scripts/:name/param-sets` | `job.run` | `{ name, params }` → the row; `409` on a duplicate name |
| `PATCH` | `/api/scripts/:name/param-sets/:id` | `job.run` | `{ name?, params? }` |
| `DELETE` | `/api/scripts/:name/param-sets/:id` | `job.run` | |
| `GET` | `/api/scripts/:id` | `script.view` | **now `typedJson`-validated**, `paramsSchema` parsed and limit-clamped (closes F7's own admission) |
| `GET` | `/api/scripts` | `script.view` | **`paramsSchema` removed**; gains `hasParams: boolean` (95.10, gated on H4) |
| `POST` | `/api/jobs`, `/api/batches` | unchanged | **now validate params**; `400 invalid_job_params` with `issues` |
| `POST`/`PATCH` | `/api/schedules` | unchanged | same, plus `paramsFindings` on the response |
| `GET` | `/api/schedules` | `schedule.view` | each row gains `paramsCompatible: boolean` and `paramsFindingCount: number`, computed against what `scriptRef` resolves to **right now** |

`EnkakuError` gains an optional `issues?: ParamIssue[]`, carried through
`toJSON()` — the one change in `util/errors.ts:18-20`, and the reason field-level
errors can reach a form at all.

### 4.9 Publish-time checks

Three call sites, one implementation (`checkParamsSchema`):

- `POST /api/scripts` — `paramsSchema` stops being `z.unknown()`
  (`routes.ts:21`) and becomes a checked value. A failing schema is a `400
  E_PARAMS_SCHEMA_INVALID` listing every finding.
- `verify-child-entry.ts:53` — plugin members, same check, so a plugin cannot
  take the path a standalone script cannot.
- `enkaku publish` (`publish.ts:90`) — runs the check **locally, before the
  network call**, so the author sees it in their own terminal. It also switches
  to `z.toJSONSchema(params, { io: 'input' })` (F2) and prints the `.refine()`
  warning from §3.6.

`io: 'input'` is the correct mode and today's is a defect, not a preference: a
params schema describes what a person **types**, and in `'output'` mode every
defaulted field is published as required (F2). This is the root of F16's shipped
bug.

---

## 5. Implementation steps

### 95.1 — The vocabulary (fixes F6's poverty; enables everything else)

- [x] `packages/protocol/src/params/vocabulary.ts` — §4.1 in full:
      `PARAM_KINDS`, `DURATION_UNITS`, `PARAM_SOURCES`, `ParamHints`,
      `ParamHintsSchema`, `readHints`, `ui()` with its overloads.
- [x] `packages/protocol/src/params/limits.ts` — §4.2.
- [x] `packages/protocol/src/index.ts` — export the module.
- [x] `packages/sdk/src/index.ts` — re-export `ui` and the hint types **only**
      (F9: a script may not import `@enkaku/protocol` directly).
- [x] Migrate the four `enumSource` sites to `'x-enkaku': { source: … }`
      (`settings.ts:243,248,253,258`), and `types.ts:18-19` with them.
      Replace, do not alias (00-overview §4.3).
- **Verifiable result:** `readHints` returns `{}` for a node with no hints,
  malformed hints, and hints naming a kind that does not exist yet; `ui()` fails
  to compile for `{ kind: 'duration' }` with no unit, for
  `{ kind: 'count', unit: 'ms' }`, and for a misspelled kind. `bun test` green.

### 95.2 — The resolver (fixes F17, F19, F20, F21; tests H2)

- [x] `packages/studio/src/components/schema-form/plan.ts` — §4.5. Implements
      §3.3's precedence table **in that order**, with the table reproduced in
      the doc comment so code and document can be diffed by eye.
- [x] `packages/studio/src/components/schema-form/plan.test.ts` — a **pure**
      test file, no React, no `@testing-library`. One case per table row, plus:
      every kind on the wrong structural type falls through to its structural
      row; a `$ref` cycle yields `json` with a reason; depth over the cap yields
      `json`; `±MAX_SAFE_INTEGER` bounds are treated as unbounded (F5); a bare
      `z.number()` plans identically before and after this plan.
- [x] The order test for H2: `JSON.parse(JSON.stringify(z.toJSONSchema(S)))`
      preserves declaration order for `DeviceSettingsSchema`,
      `FarmSettingsSchema`, and the tiktok pack's `auto-scroll` params.
- [x] `resolve.ts` — add the visited set to `deref` and a depth bound to
      `applyDefaults` (K1, K2 kept; F21 closed). `setAtPath` **deletes** a key
      rather than assigning `undefined` (F22's renderer half).
- **Verifiable result:** `planField` is called with every JSON Schema this
  repository can produce — every `z.toJSONSchema` output from `settings.ts` plus
  a fixture set of hostile schemas — and returns a `FieldPlan` for all of them,
  never throwing, never recursing without bound.

### 95.3 — The controls (fixes F17, F18; tests H1)

- [x] `packages/studio/src/components/ui/slider.tsx` — the standard shadcn
      wrapper over `radix-ui`'s `Slider` (F31: already a dependency; **no
      `package.json` change**).
- [x] `packages/studio/src/components/schema-form/controls/` — the nine files
      of §4.6. Every one renders its current value right-aligned in the label
      row.
- [x] `SchemaForm.tsx` — rewritten to walk `planForm()` output. K7's nesting
      rule, K6's `humanize` fallback, and K8's remount contract preserved
      verbatim; `plan.tsx`'s output memoised on the schema's identity so it is
      computed once per schema, never per keystroke.
- [x] `formatValue(kind, unit, value)` — one formatter, unit-tested:
      `536870912 → "512 MB"`, `6000000 → "6 Mbps"`, `0.35 → "35%"`,
      `[5,20] + s → "5 s ~ 20 s"`, `90000 + ms → "1 min 30 s"`.
- [x] Rebuild the tiktok pack's `auto-scroll` params with `ui()` and add one
      `chance` and one ordered range, for H1's comparison.
- **Verifiable result:** the reference UI's three properties are present —
  semantic control, live value in the label row, behavioural help — on a form
  built from a schema, with no per-script React anywhere. The owner compares it
  with the current form and H1 resolves.

### 95.4 — Grouping, ordering, and the multiplier (fixes F25; proves F33)

- [x] `plan.ts` — `planForm` forms sections from consecutive runs of `group`;
      ungrouped fields render first.
- [x] `packages/protocol/src/settings.ts` — annotate `DeviceSettingsSchema` and
      `FarmSettingsSchema` with `group`, `kind`, and `unit`. This is the
      mechanical edit that replaces name-sniffing (§3.3) and it is where the
      multiplier is paid: every `*Ms`/`*Sec`/`*Bytes` field in the farm and
      device panels gains a readable readout with no Studio change.
- [x] `packages/studio/src/components/settings/deviceSections.ts` — delete
      `NAMED_GROUPS`; derive sections from the schema's own `group` runs,
      keeping K9 (an unclaimed key lands in "General").
- [x] `packages/studio/src/app/settings/page.tsx:186-189` — use `narrowSchema`
      instead of its inline copy (F25's third copy, and the crash its own test
      documents). `FARM_SECTION_DEFS` stays (§3.5).
- **Verifiable result:** adding a field to `DeviceSettingsSchema` with a
  `group` puts it in that section of the device Settings tab with **zero**
  Studio edits; `deviceSections.test.ts` asserts a new ungrouped key still lands
  in General.

### 95.5 — Limits and provenance (fixes F7; answers R1–R7)

- [x] `checkParamsSchema` wired into all three publish paths (§4.9), including
      the identifier-shaped field-name rule that makes H2 a guarantee, and the
      non-consecutive-`group` warning.
- [x] `packages/core/src/scripts/routes.ts:21` — `paramsSchema` stops being
      `z.unknown()`; `:126-148` — the detail route goes back through `typedJson`
      now that the value has a shape.
- [x] Render-side clamping for schemas already in the database: truncate over-long
      strings, stop at the depth cap, and show one line at the top of the form
      naming what was clamped.
- [x] `RunScriptDialog` header — publisher and publish date beside
      `name@version` (R6). The data is already in the list response.
- [x] `packages/studio/src/lib/api.ts` — `fetchAllPages` gains an optional
      parser so the scripts list is validated rather than cast (F8).
- **Verifiable result:** each of a 200 KiB schema, a 40-deep schema, a
  self-referential `$ref`, a 50 000-character description, a 5 000-field object
  and a catastrophic-backtracking `pattern` is rejected at publish with a named
  finding — and, when already stored, renders a clamped, usable form in under
  200 ms with no hang.

### 95.6 — One validator, both sides (fixes F10, F11, F12, F13, F14, F15)

- [x] `packages/protocol/src/params/validate.ts` — §4.3. Delete
      `packages/studio/src/components/schema-form/validate.ts`.
- [x] `packages/core/src/util/errors.ts:18-20` — `EnkakuError` carries optional
      `issues`, echoed by `toJSON()`.
- [x] `packages/core/src/jobs/executors/script.ts:26-28` — `validateParams`
      validates against the registry entry's `paramsSchema` instead of returning
      the input. `packages/core/src/clusters/dispatch.ts:131` already routes
      through it, so batches are covered by the same edit (F11).
- [x] `packages/core/src/api/schedules.ts` — the same validation on create and
      patch.
- [x] `RunScriptDialog` and `ScheduleEditorDialog` — map `issues` onto
      `serverErrors` (F12), and consume `SchemaForm`'s new `canSubmit` to
      disable their own submit buttons (F14).
- [x] `packages/sdk/src/cli/publish.ts:90` — `io: 'input'` (F2), plus the
      `.refine()` warning (§3.6).
- **Verifiable result:** `POST /api/jobs` with `{ videos: 9999 }` against a
  `max(2000)` schema returns `400 invalid_job_params` with
  `issues: [{ path: 'videos', message: 'must be at most 2000' }]`, **no device
  is leased**, and the dialog shows the message under the Videos field. A form
  with a red field cannot be submitted.

### 95.7 — Reconciliation (tests H3)

- [x] `packages/protocol/src/params/reconcile.ts` — §4.4, with the table from
      §4.4 in its doc comment.
- [x] `packages/core/src/schedules/runner.ts:205-217` — after the ref resolves,
      reconcile `schedule.params` against the resolved version's schema. On
      `blocking`, record `schedule.failed` with code `params_incompatible`
      naming the fields and enqueue **nothing** — the same discipline plan 62
      §4.5 applies to an unresolvable reference.
- [x] `GET /api/schedules` — `paramsCompatible` and `paramsFindingCount`, so a
      schedule that *will* fail is visible before 3 a.m. rather than after.
- [x] `packages/core/src/api/batches.ts` — rerun-failed reconciles before
      re-enqueuing.
- [x] Studio: the schedules list badges an incompatible schedule; the editor
      lists the findings and offers "fill from the new version's defaults" for
      the non-blocking ones.
- **Verifiable result:** publish `s@1.0.0` with `{ videos }`, create a
  `s@latest` schedule, publish `s@1.1.0` adding a required `region` with no
  default → the next firing enqueues nothing, records `params_incompatible`
  naming `region`, and the schedules list has said so since the moment `1.1.0`
  was published.

### 95.8 — Named parameter sets (fixes F27)

- [x] `packages/core/src/db/schema.ts` — `scriptParamSets` (§4.7);
      `bun run --cwd packages/core db:generate`.
- [x] `packages/core/src/scripts/param-sets.ts` + routes (§4.8), with audit
      entries alongside the existing `script.*` verbs.
- [x] `RunScriptDialog` — a preset row above the form: pick one, **Save as…**,
      **Update**, **Delete**. Applying one runs `reconcileParams` and reports in
      one line: *"Applied 'Aggressive' — 1 setting reset to its new default, 1
      no longer exists."*
- [x] `ScheduleEditorDialog` — the same picker, so a schedule can be created
      from a preset. It stores the **resolved params**, not a reference to the
      set: a preset edited later must not silently change what a schedule runs
      (the same reasoning that keeps `jobs.scriptId` concrete in plan 62 §3.3).
- **Verifiable result:** a set saved against `s@1.0.0` applies cleanly to
  `s@1.1.0`, reporting exactly what changed; a schedule built from a set keeps
  running its own copy after the set is edited.

### 95.9 — Conditional fields (`showWhen`)

- [x] `plan.ts` — `showWhen` carried onto `PlannedField`; `checkParamsSchema`
      rejects a `field` that is not a sibling.
- [x] `SchemaForm` — hidden fields are not rendered and **their values are still
      submitted** (§3.6); a required-and-hidden field with no default reports its
      error on the controlling field.
- **Verifiable result:** a schema with `mode: 'simple' | 'advanced'` and three
  `showWhen: { field: 'mode', is: 'advanced' }` fields shows four controls in
  simple mode and seven in advanced, submits all seven values in both, and
  validates identically in the browser and in the core.

### 95.10 — Payload (tests H4)

- [ ] `packages/core/src/scripts/routes.ts:100-108` — drop `paramsSchema` from
      the list projection; add `hasParams: boolean`.
- [ ] `RunScriptDialog` / `ScheduleEditorDialog` — fetch the chosen version's
      schema from `GET /api/scripts/:id` when the pick changes, keeping K8's
      remount contract (the fetch is keyed the same way the remount is).
- [ ] Record the `GET /api/scripts` response size before and after, with the
      tiktok pack published at three versions.
- **Verifiable result:** the measurement is written into this plan. **If the
  delta is under 50 KB, this step is reverted and recorded as not worth it** —
  in writing, with the number, per plan 85 §85.7b's precedent.

### 95.11 — Documentation

- [x] `docs/design.md` — rewrite "Schema-driven forms": the two artefacts, the
      vocabulary table, the precedence table, and the writing rule the reference
      UI taught us, stated as a rule:
      > **A parameter's description says what the script will DO with it, including when it will do nothing.** *"Tap the sound disc, save the sound to Favourites, return to the feed. Skipped if no save button is found."* — not *"whether to save the sound."*
- [x] `packages/sdk/README.md` — the authoring guide: `ui()`, the nine kinds,
      grouping, what `.refine()` will and will not do, why credentials belong in
      `ctx.kv`.
- [ ] `packages/protocol/README.md` — the vocabulary, the limits, and the
      reconciliation rule.
- [ ] `docs/spec.md` §19 — the rendering principle gains its second sentence:
      *the schema declares meaning, Studio decides presentation*; §12 gains
      parameter sets. Per 00-overview §7.8, in the same commit.
- [ ] `docs/plans/00-overview.md` §9 — the `enumSource` → `x-enkaku.source`
      rename is **not** a tracked removal (nothing is kept), but the `io:
      'output'` → `'input'` switch means schemas published before 95.6 have
      defaulted fields marked required; note it with its behaviour (they render
      and validate the same, because `applyDefaults` fills them) and no removal
      date needed.

---

## 6. Acceptance criteria

1. A script author can express the reference UI's entire form — a count with a
   stepper, an ordered duration range with a live `5 s ~ 20 s` summary, three
   chances with sliders and percentage readouts, and two coloured section
   headings — using **only** `z`, `.describe()` and `ui()`, with **no React
   written anywhere**.
2. `planField` is total: every JSON Schema produced by every `z.toJSONSchema`
   call in this repository, plus the hostile fixture set, returns a `FieldPlan`.
   It never throws and never recurses without bound.
3. `planField` is deterministic and DOM-free: `plan.test.ts` imports no React
   and no `@testing-library`, and covers every row of §3.3's table.
4. A schema written before this plan (`z.number()`, `z.string()`,
   `z.tuple([z.number(), z.number()])`, `z.enum([...])`) renders at least as
   well as it does today. No published script needs republishing to keep working.
5. An unknown `kind`, an unknown `source`, a `unit` on a non-duration and a
   `labels` map on a non-enum all degrade to the structural default. None
   produces a blank field or an error.
6. `z.record` renders a labelled JSON editor with a reason, not an empty card
   (F19). A discriminated union renders a labelled JSON editor with a reason,
   not a bare textarea (F20). An array of objects renders an editable row table,
   not `[object Object]` (F18).
7. A self-referential `$ref`, a 40-deep schema, a 200 KiB schema, a 5 000-field
   object and a 50 000-character description are each **rejected at publish**
   with a named finding, and each **renders a clamped, usable form in under
   200 ms** when already stored.
8. **No author-supplied regular expression is compiled or evaluated** in Studio
   or in the core. `packages/protocol/src/params/validate.ts` contains no
   `new RegExp` over a schema-derived string, and a repo grep proves it.
9. `POST /api/jobs` and `POST /api/batches` reject invalid params with
   `400 invalid_job_params` carrying `issues: [{path, message}]`, **before any
   device is leased**, and the dialog attaches each message to its field.
10. A form showing a validation error cannot be submitted, from either dialog
    (F14).
11. Field order is declaration order for every schema in the repository, proved
    through a `JSON.stringify`/`JSON.parse` round trip; a non-identifier field
    name is rejected at publish.
12. Sections come from `x-enkaku.group` alone. `NAMED_GROUPS` is deleted, a new
    ungrouped key still lands in "General", and no Studio file lists device
    settings sections.
13. A field added to `DeviceSettingsSchema` or `FarmSettingsSchema` with a
    `group`, a `kind` and a `unit` appears in the right section with the right
    control and the right readout, with **zero** Studio edits.
14. `reconcileParams` implements §4.4's table exactly, one test per row.
15. A schedule on `@latest` whose script gains a required field with no default
    **enqueues nothing**, records `params_incompatible` naming the field, and is
    flagged in `GET /api/schedules` from the moment the new version is published.
16. A named parameter set saved against `1.0.0` applies to `1.1.0` with a
    one-line report of what was reset, dropped or is missing; a schedule created
    from a set stores its own copy and is unaffected when the set is edited.
17. `showWhen` hides and shows fields, submits hidden values, and validates
    identically in the browser and in the core.
18. The run dialog names who published the version being run.
19. `docs/design.md` carries the vocabulary table, the precedence table and the
    behavioural-help writing rule; `packages/sdk/README.md` carries the
    authoring guide; `docs/spec.md` §19 is amended in the same commit
    (00-overview §7.8).
20. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test`
    are green. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| vocabulary | `packages/protocol/src/params/vocabulary.test.ts` | `readHints` returns `{}` for absent, malformed, and future-vocabulary hints; unknown keys stripped not rejected; `ui()`'s runtime shape |
| `ui()` types | `packages/protocol/src/params/vocabulary.type-test.ts` | `// @ts-expect-error` on `{kind:'duration'}` with no unit, `{kind:'count', unit:'ms'}`, and a misspelled kind |
| limits | `packages/protocol/src/params/limits.test.ts` | every limit fires; findings name a path; the check returns **all** findings, not the first |
| validator | `packages/protocol/src/params/validate.test.ts` | each keyword; `±MAX_SAFE_INTEGER` treated as unbounded (F5); ordered-pair inversion; `packageName`; `chance` domain; **`pattern` is not evaluated**; depth bound; `$ref` cycle terminates |
| reconcile | `packages/protocol/src/params/reconcile.test.ts` | one case per row of §4.4; `blocking` exactly on `invalid`/`missing`; idempotent when run twice |
| resolver | `packages/studio/src/components/schema-form/plan.test.ts` | every row of §3.3 in order; wrong-type hints fall through; totality over the hostile fixture set; **no React import** |
| declaration order | same file | round-trip order for `DeviceSettingsSchema`, `FarmSettingsSchema`, the tiktok pack (H2) |
| formatting | `packages/studio/src/components/schema-form/format.test.ts` | bytes, bitrate, chance, duration, ordered pair |
| controls | `packages/studio/src/components/schema-form/controls/*.test.tsx` | stepper bounds and step; slider keyboard access; pair clamping; table add/remove/edit; every control shows its value in the label row |
| sections | `packages/studio/src/components/settings/deviceSections.test.ts` | consecutive runs; an ungrouped key lands in General (K9) |
| enqueue validation | `packages/core/src/jobs/executors/script.test.ts` | invalid params rejected with paths, **no lease taken** |
| schedule pre-flight | `packages/core/src/schedules/runner.test.ts` | blocking findings enqueue nothing and record `params_incompatible` |
| param sets | `packages/core/src/scripts/param-sets.test.ts` | CRUD, the unique index, apply-with-reconcile |
| publish gate | `packages/core/src/scripts/routes.test.ts` | oversized / too-deep / cyclic / bad-name schemas rejected with named findings |
| CLI | `packages/sdk/src/cli/publish.test.ts` | `io: 'input'` output; the `.refine()` warning fires for a refined params object and not for a plain one |

### 7.2 The hostile fixture set

One file, `packages/studio/src/components/schema-form/fixtures/hostile.ts`,
used by both the resolver and validator tests and by 95.5's manual check. Each
entry is a real JSON Schema, not a mock:

```
self-ref-cycle          $defs.A.properties.next → #/$defs/A
mutual-ref-cycle        A → B → A
deep-40                 40 nested objects
wide-5000               5 000 sibling scalars
giant-description       one field, 50 000-character description
giant-title             one field, 5 000-character title
enum-10000              one enum with 10 000 members
redos-pattern           (a+)+$  — must never be compiled
non-identifier-keys     { "1": …, "a-b": …, "__proto__": … }
record-no-properties    type: object, additionalProperties: {type:'number'}
oneOf-many              a 5-branch discriminated union
array-of-objects        rows: [{ name, n }]
bare-legacy             { videos: {type:'integer'} } — no hints at all
future-vocabulary       x-enkaku: { kind: 'colour', mood: 'calm' }
```

`__proto__` is in the list on purpose: `setAtPath` and `applyDefaults` both
build objects from schema-derived keys, and a key named `__proto__` must land as
an own property, not on a prototype. The test asserts
`Object.getPrototypeOf(result) === Object.prototype`.

### 7.3 Manual smoke

```bash
bun run typecheck
bun test
bun run --cwd packages/studio test
bun run dev            # core on :7700
bun run dev:studio     # Studio on :3001

# publish the reference form
bun run --cwd plugins/tiktok-automation-pack build
bunx enkaku publish plugins/tiktok-automation-pack/src/index.ts

# 1. Scripts → auto-scroll → Run: a stepper, an ordered range with `5 s ~ 20 s`,
#    three sliders reading `0%`, under two section headings. Every value visible
#    without focusing anything.
# 2. Set a chance to 35%, Run, and confirm the job's params carry 0.35 exactly.
# 3. Force an invalid value past the form with curl:
curl -s -XPOST localhost:7700/api/jobs \
  -H 'content-type: application/json' \
  -d '{"scriptId":"<id>","deviceId":"<dev>","params":{"videos":9999}}' | jq
#    → 400 invalid_job_params with issues[0].path == "videos"; no lease taken.
# 4. Settings → Devices → Timing: `tapJitterMs` is one ordered range reading
#    `40 ms ~ 120 ms`; Storage's `maxPushBytes` reads `512 MB`. No Studio edit
#    was made for either.
# 5. Save a parameter set, publish 1.1.0 tightening `videos` to max(100), reopen
#    the dialog, apply the set → one line naming what was reset.
# 6. Publish a hostile fixture → rejected at publish, with the finding named.
```

### 7.4 Regression watch

- A script published before this plan runs unchanged, with no republish.
- `narrowSchema` still produces the device Settings tab's sections.
- `RunScriptDialog`'s version switch still clears params in the handler, not in
  an effect (K8) — the existing `RunScriptDialog.test.tsx` must stay green
  untouched.
- `useEnumOptions` still degrades to the plain enum when `/api/registry` is
  unreachable (K4), and an unavailable engine is still listed, disabled, with
  its reason.
- `bun test` from the root still does not run Studio's tests, and both commands
  are still required.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The vocabulary is wrong and needs a tenth kind next month. | `PARAM_KINDS` is a closed array and `readHints` is written so an unknown kind degrades to the structural default (criterion 5). Adding one is a protocol change plus one control; an **older** Studio rendering a **newer** schema is already the tested path. |
| Authors ignore `ui()` and keep writing bare `z.number()`. | Then they get exactly today's form, which is the compatibility floor (criterion 4). The pull is the SDK guide, the publish-time warning for a field with no `description`, and the tiktok pack shipping as the worked example. |
| `x-enkaku` keys leak into MCP `inputSchema` and confuse a model. | They are extra keys on a `draft-2020-12` object, which every consumer ignores — and `kind: 'chance'` beside a description arguably *helps* a model with units. If it ever hurts, `toJsonSchema` already has one place to strip a key (`to-json-schema.ts:20` does exactly this for `$schema`). |
| Enqueue-time validation rejects a job that would have run before. | It only rejects what the **published schema** already forbade — the child would have failed it anyway (F10), later and more expensively. The one real change is F2: schemas published before 95.6 mark defaulted fields required, and `applyDefaults` fills them, so the outcome is identical. Covered by criterion 4. |
| Two validators drift — the JSON Schema one and the child's Zod one. | They cannot fully converge (F3) and the plan says so rather than pretending. What it does is name the gap, warn the author at publish, and shrink it to refinements only. |
| Sections built from consecutive runs surprise an author who repeats a group name. | It is warned at publish and it is the legible reading of their own file. The alternative — reordering fields to merge sections — would break the declaration-order guarantee that makes ordering free. |
| The parameter-set table becomes a second, worse settings store. | It holds one thing: a named blob for a script name. It has no scopes, no TTL, no CAS. If it starts growing axes, that is the signal it wanted to be `kv_entries` (plan 79) and the reasoning in plan 93 §3 applies. |
| The renderer rewrite regresses the settings pages, which are not what this plan is about. | The settings pages are two of the four call sites (F26) and their existing tests (`settings/page.test.tsx`, `deviceSections.test.ts`) run unchanged. §7.4 names them. |
| Slider precision loses a value a number box could reach. | Every `chance` control pairs the slider with the numeric readout as an editable field, so the exact value is always reachable. This is the §3.2 inference rule applied to our own design, not only to authors'. |
| The plan is large and lands half-done. | 95.1–95.3 are independently shippable and are the whole of H1's answer; 95.6 is independently shippable and is the whole of F10's. 95.8, 95.9 and 95.10 can each be dropped without touching the rest — and 95.10 is explicitly gated on a measurement that may kill it. |

## 9. Open questions — owner decisions

1. **Does the new form actually answer *"kurang interaktif"*?** H1 says the gap
   is semantic controls plus a visible current value plus behavioural help.
   95.3 builds it against the tiktok pack's own parameters so the comparison is
   concrete rather than a mockup. **If it still feels flat, the next lever is
   layout density and section styling, not more controls** — and that is a
   design decision, not an engineering one. Please look at 95.3 before 95.4
   starts.
2. **Should a Run click be able to validate against the *real* Zod schema?**
   §3.6 stops at what JSON Schema can express, because the core holds only the
   JSON Schema and executing a bundle on the core's own process is forbidden by
   `build.ts`'s doctrine. The complete answer is a short-lived child process —
   spawn, `params.parse`, exit — costing one spawn per Run click and a new IPC
   verb. That closes the `.refine()` gap entirely. It is a real feature with a
   real cost, and it is a call about how much a Run click may cost.
3. **One MCP tool per script?** F28 shows the stored schema would feed
   `inputSchema` with no conversion, so a model could call a script with typed,
   documented parameters instead of the untyped `job.run` it has today. The
   question is not feasibility, it is roster size and naming: a farm with forty
   published scripts would add forty tools to every agent's context, and
   `registry.visibleTo` filters by permission only. Worth its own plan; naming
   it here so the seam is not accidentally closed.
4. **Should a parameter set be shareable with the script?** Today a set is farm-
   local (§4.7). A shared script could ship *recommended* sets in its bundle —
   *"Conservative", "Aggressive"* — which is a genuinely good marketplace
   feature and also means a third party's values arrive pre-filled in an
   operator's form. That is a trust decision (§3.8's R6 with the volume turned
   up), not a technical one.
5. **`kind: 'secret'` and encrypted params.** §3.2 refuses it because
   `jobs.params`, `batches.params`, `schedules.params` and any set store it in
   plaintext. If scripts genuinely need credentials as *parameters* rather than
   through `ctx.kv`, that is an encrypted-column plan with a key, and the answer
   changes. Which is it?
6. **Is `chance` in `[0,1]` right, or should it be `[0,100]`?** §3.2 argues for
   `[0,1]` because that is what a script compares against `rng()`. The cost is
   that an author writing `.default(30)` meaning "30%" gets a publish error
   instead of a working form. That error is the feature, but it is worth
   agreeing to on purpose.

Items 7 and 8 below are not owner decisions — they are two real defects steps
95.4 and 95.5 found while building the resolver and the settings annotations,
and correctly left alone rather than folded into an unrelated fix. Recorded
here so they are not lost.

7. **A `kind` hint on a `.nullable()` field is silently inert — a gap in this
   plan's own resolver, not fixed.** `z.toJSONSchema` wraps a `.nullable()`
   field as `anyOf: [{type, …}, {type: 'null'}]`. `planField`'s row 3 reads
   `hints.kind` off that OUTER `anyOf` node and checks it with
   `kindStructurallyValid`, which calls `baseType(node)` — but the wrapper
   node has no `.type` of its own (only `anyOf`), so the check never passes
   and the field falls through every structural row to row 14's
   nullable-unwrap. Row 14 recurses with `planField(real[0], ctx)` on the
   INNER branch, which calls `readHints` again — on the inner node, where no
   hint was ever attached, because `.meta()` chained after `.nullable()`
   lands the meta on the OUTER wrapper. The field still renders correctly (a
   plain number box, row 9 on the inner branch) — it is not a crash and not a
   wrong value — but a `kind` an author wrote is silently ignored rather than
   honoured or rejected. This affects two real fields today, both already
   carrying a code comment at the point of omission rather than a hint that
   would silently do nothing: `job.maxTimeoutMs`
   (`packages/protocol/src/settings.ts:545-550`) and
   `scheduledAgents.spendCapOutputTokensPer24h`
   (`packages/protocol/src/settings.ts:1244-1249`). Closing it means either
   teaching row 3 to look inside a single-non-null `anyOf` before falling
   through, or teaching row 14 to carry the wrapper's own hints into its
   recursive call — either is a real change to `planField`
   (`packages/studio/src/components/schema-form/plan.ts`) that deserves its
   own scrutiny, so it is recorded here rather than folded into this plan's
   close-out.
8. **Most of `FarmSettingsSchema` is unreachable from the Farm Settings UI —
   a Settings-surface gap, not this plan's to fix.** Seven top-level blocks
   are declared on `FarmSettingsSchema` and have no entry in either
   `FARM_SECTION_DEFS` or `keysForSection`
   (`packages/studio/src/app/settings/page.tsx:73-103`, `:162-179`):
   `discovery` (`settings.ts:804`), `monitor` (`:840`), `shell` (`:895`),
   `transfer` (`:1057`), `network` (`:1104`), `workspace` (`:1142`), and the
   `kv` quota block (`:1178`). §3.5 keeps `FARM_SECTION_DEFS` on purpose,
   calling it "a page manifest, not a shadow copy of a schema" — but a page
   manifest that never names a real schema block means `narrowSchema` (95.4's
   own replacement for the third copy of this list) is never asked to render
   these seven, and no tab on the Farm Settings page can reach them no matter
   how an operator navigates. Concretely: **plan 85's `discovery.*` settings
   and `monitor.crashWatch` are invisible in Studio today**, despite existing
   and working server-side. Found while checking 95.4's "zero Studio edits"
   claim against every top-level `FarmSettingsSchema` key, not only the ones
   this plan's own steps touched. Adding seven more sections to
   `FARM_SECTION_DEFS` is a Settings-surface layout-and-copy decision, not a
   schema-vocabulary one — **it is not this plan's to fix**, and is recorded
   here as a finding for whichever plan owns the Farm Settings screen next.
