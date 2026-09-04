# Plan 303 — Flow : The node catalog — core control nodes, the plugin `node` descriptor, the registry

> Status: implemented (software) — G8 is the owner's row (a fresh-farm palette check). G9's `build:studio` half could not be run in this plan's own session (a concurrent Studio dev server held port 3001) and was verified afterwards on 2026-09-05: plans 305, 306 and 307 each built and exported Studio cleanly on trees containing this plan's changes.
> Ships: packages/core/src/workflows/registry.ts
> Depends on: plan 301 (doc v2); plan 300 D6, D7, D8
> Spec references: §4.5, §4.6, §10

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Two control node kinds are added: `switch` and `delay` | 6 kinds total: `start`, `script`, `gate`, `switch`, `delay`, `finish` | `bun test packages/protocol/src/workflow.test.ts` → `six kinds` passes | [x] |
| G2 | A `switch` picks the first matching case, else `default` | ≤ 10 cases, ordered, first match wins | `bun test packages/core/src/jobs/executors/workflow.test.ts` → `switch` group passes | [x] |
| G3 | A plugin member may declare `node`, and the declaration is validated on the author's machine | `definePlugin` throws on a bad descriptor | `bun test packages/sdk/src/plugin.test.ts` → `node descriptor` passes | [x] |
| G4 | `GET /api/node-types` returns core kinds plus every activated plugin's node members, each with title, description, icon, category, version and params schema | one response, both sources | `bun test packages/core/src/workflows/registry.test.ts` → `registry lists both` passes | [x] |
| G5 | A plugin node's control surface is exactly one success and one failure edge | no descriptor field can add an output | `rg -n "outputs" packages/sdk/src/plugin.ts packages/protocol/src/workflow-node-type.ts` → empty | [x] |
| G6 | A node type resolves to a pinned `plugin/script@version`, never to "whatever is installed" | the registry answers with the resolved version; the document stores it | `bun test packages/core/src/workflows/registry.test.ts` → `pins version` passes | [x] |
| G7 | The two shipped packs each declare at least one node and are version-bumped at all three sites | 3 sites per pack, changelog line present | `rg -n "version" plugins/*/package.json plugins/*/src/index.ts plugins/*/src/index.test.ts` agrees pairwise; `bun run build:packs` rebuilds | [x] |
| G8 | A fresh farm shows the new nodes in the palette | seeded-packs record contains the new versions | §7 smoke step 3, on a data directory created after the bump | owner |
| G9 | `bun run typecheck` and `bun run build:studio` clean | 0 errors each | both exit 0 | [x] typecheck; `build:studio` not run — see §11 |

## 1. Goals

- The owner's `conditions C -> 1 / 2 / 3` is **one node**, not a chain of
  gates.
- A plugin can contribute a node type without a new plugin surface, a second
  catalog, or a second execution path.
- Studio can render a palette and a node form from data the core hands it,
  with no per-node code in Studio.

## 2. Non-goals

| Not done here | Where |
|---|---|
| The palette UI, the canvas | plan 305 |
| The node panel and its forms | plan 306 |
| A `forEach` node | §9 Q1 — deliberately unanswered |
| Conditional field visibility (n8n's `displayOptions`, plan 300 R7) | §9 Q3 — not built |
| Any node with more than one success output | never (plan 300 D8) |

## 3. Context and design decisions

### 3.1 A node type is a script member with a descriptor (plan 300 D6)

A `PluginMemberScript` already carries a Zod params schema, a Zod result
schema, child-process execution, and a version stamped by `definePlugin`
([plugin.ts:33-58](../../packages/sdk/src/plugin.ts)). A node type needs
exactly two things more: **presentation** (what the palette shows) and
**category** (where the palette files it). So the descriptor is a field on the
member, and there is one catalog, one resolution path (`ScriptRefSchema`), and
one version discipline.

The consequence worth stating: **every plugin node is a script node.** In the
document it is `kind: 'script'` with a `script: 'plugin/member@1.2.0'`. The
descriptor changes how it is *presented*, never how it is *executed* (plan 300
D7). A workflow authored against a plugin node therefore runs on a farm whose
Studio has never heard of that node — it just looks generic.

### 3.2 Control flow stays core-owned, and here is the closed list

Core, and only core: `start`, `gate`, `switch`, `delay`, `finish`, plus the
failure edge every script node has. `checkWorkflow` proves reachability,
dangling edges, binding legality and the worst-case time budget
([workflow-check.ts:7-14](../../packages/protocol/src/workflow-check.ts)); none
of that survives a third party defining edge semantics. n8n reaches the same
place in practice: IF, Switch, Merge and Loop are core nodes there too.

### 3.3 `switch`, and why it is predicates rather than an expression returning an index

n8n's Switch has two modes: rules, and an expression returning an output
index. The second is refused here. An index is a number with no name, it
breaks silently when cases are reordered on the canvas, and it makes the graph
unreadable at a glance — the case that fires is not visible on the edge. So a
case is a **predicate plus a target**, evaluated in order, first match wins,
with an optional `default`. It reuses `PredicateSchema` unchanged, so the
existing predicate editor, its depth limit and its leaf limit all apply.

### 3.4 `delay`, and why it is a node rather than a script

Two lines of Kotlin-free work that every device automation needs, and making
it a script would mean spawning a child process to call `sleep`. It costs a
step, it touches no device, and its bound is the same `maxTotalMs` budget
`checkWorkflow` already computes — which is precisely why it must be core:
the budget walk has to know a delay's duration statically.

An expression-valued delay (`$nodes.x.result.waitMs`) is therefore bounded by
the **declared maximum**, not the expression: the document states
`maxMs`, the checker uses `maxMs` for the budget, and the executor clamps the
resolved value to it. A budget that cannot be computed statically is not a
budget.

### 3.5 The seeding trap, named before it bites

CLAUDE.md: bundled packs are seeded once, keyed `${name}@${version}`, recorded
in `<dataDir>/seeded-packs.json`, and a version already in that file is
**skipped on every later boot**. Plan 124 shipped this bug twice. A node
catalog changes far more often than a script did, so this plan makes the bump
a step with a grep (305.6) and a smoke on a **fresh data directory** (G8), and
says the thing that is easy to forget: a seeded version is *staged*, not
activated — the operator activates it on the Plugins page, so "bumped" and
"the operator sees it" remain two different events.

## 4. Technical design

### 4.1 `switch` and `delay` in `packages/protocol/src/workflow.ts`

```ts
export const WORKFLOW_LIMITS = {
  // ...unchanged...
  /** A switch with more than this many cases is a table, and a table is a script. */
  maxSwitchCases: 10,
  /** The largest a single `delay` node may declare. Longer waits are a schedule, not a workflow. */
  maxDelayMs: 5 * 60_000,
} as const

// added to the discriminated union:
z.object({
  ...nodeBase,
  kind: z.literal('switch'),
  cases: z
    .array(z.object({ when: PredicateSchema, to: WorkflowNodeIdSchema.optional(), label: z.string().max(40).default('') }).strict())
    .min(1)
    .max(WORKFLOW_LIMITS.maxSwitchCases),
  default: WorkflowNodeIdSchema.optional(),
}).strict(),

z.object({
  ...nodeBase,
  kind: z.literal('delay'),
  /** Resolved at run time and clamped to `maxMs`; `maxMs` is what the budget walk uses (§3.4). */
  ms: ValueExprSchema,
  maxMs: z.number().int().min(0).max(WORKFLOW_LIMITS.maxDelayMs),
  next: WorkflowNodeIdSchema.optional(),
}).strict(),
```

`checkWorkflow`: a `switch` contributes every case target and `default` as
successors; its budget contribution is the **maximum** over its branches, as
the gate's already is. A `delay` contributes `maxMs` to every path through it.

### 4.2 The node descriptor — `packages/protocol/src/workflow-node-type.ts` (new)

```ts
/**
 * How a script member presents itself in the flow editor's palette and on the
 * canvas (plan 303 §4.2). Presentation and filing ONLY: nothing here changes
 * how the member executes (plan 300 D7), and nothing here can add an output
 * (plan 300 D8, G5).
 */
export const NodeCategorySchema = z.enum(['device', 'inspect', 'input', 'data', 'network', 'other'])

export const WorkflowNodeDescriptorSchema = z
  .object({
    category: NodeCategorySchema.default('other'),
    /** One of `ICON_NAMES` (plugin-surface.ts:96) — the SAME allowlist a plugin nav entry uses, mapped in `packages/studio/src/lib/plugin-icons.ts`. No second icon vocabulary. */
    icon: IconNameSchema.default('box'),
    /** Up to 3 param names rendered under the node's title on the canvas, so a node reads without being opened. */
    summary: z.array(WorkflowParamNameSchema).max(3).default([]),
    /** Search terms beyond title and description (plan 300 P3). */
    keywords: z.array(z.string().max(24)).max(8).default([]),
  })
  .strict()
```

`packages/sdk/src/plugin.ts`: `PluginMemberScript` gains
`node?: z.input<typeof WorkflowNodeDescriptorSchema>`; `definePlugin`
validates it through the same schema on the author's machine, exactly as it
already does for `surface` ([plugin.ts:79](../../packages/sdk/src/plugin.ts)),
and the parsed form is what the verify child reports and the manifest stores.

### 4.3 The registry — `packages/core/src/workflows/registry.ts` (the artefact)

```ts
export interface NodeType {
  /** `core:switch`, or `plugin/member` for a plugin node. */
  id: string
  source: 'core' | 'plugin'
  kind: WorkflowNode['kind']
  /** Present only when `source === 'plugin'` — the pinned ref the document stores. */
  script?: ScriptRef
  title: string
  description: string
  category: NodeCategory
  icon: IconName
  summary: string[]
  keywords: string[]
  /** JSON Schema, the SAME shape `SchemaForm` already renders for a script's params. */
  paramsSchema?: JsonSchemaNode
  resultSchema?: JsonSchemaNode
}

export function listNodeTypes(deps: { plugins: PluginStore }): NodeType[]
```

Six core entries are constants in this file. Plugin entries come from the
manifests of **activated** plugins only — a staged-but-not-activated version is
not in the palette, which is the same rule every other plugin surface follows.

Route: `GET /api/node-types`, permission `script.view`, response
`{ types: NodeType[] }`, validated by `NodeTypesResponseSchema` in
`@enkaku/protocol`. No pagination: the ceiling is a few hundred.

### 4.4 Version pinning

The palette offers `plugin/member@<the activated version>`, and inserting a
node writes that exact ref into the document. `@latest` is never written by
the editor (spec §4.5's grammar still permits it for a hand-authored
document). Consequence: activating a new plugin version does not silently
change an existing workflow, and plan 306 §4.7 owns the "a newer version of
this node exists" affordance.

### 4.5 The two shipped packs

Each existing member gains a descriptor — category, icon, a 2-to-3 field
summary, keywords — and each pack is bumped **minor** (an operator meets a new
control), at all three sites, with a changelog line in `src/index.ts` beside
the previous bumps, then `bun run build:packs`.

## 5. Implementation steps

**303.1 — Protocol: `switch` and `delay`.** Per §4.1, plus the two new
`WORKFLOW_LIMITS` entries. *Result*:
`bun test packages/protocol/src/workflow.test.ts` green with cases for case
ordering, the 10-case ceiling, and `maxMs` bounds.

**303.2 — Protocol: the checker.** Successors and budget for both kinds per
§4.1. *Result*: `bun test packages/protocol/src/workflow-check.test.ts` green,
including a switch whose longest branch dominates the budget.

**303.3 — Executor.** `packages/core/src/jobs/executors/workflow.ts`: evaluate
switch cases in order (first match wins, `default` otherwise, dangling ⇒ end
the run succeeded per plan 301 §3.2); implement `delay` with a clamped,
cancellable wait that respects the run's cancel signal. *Result*:
`bun test packages/core/src/jobs/executors/workflow.test.ts` → G2, plus a
delay cancelled mid-wait ending the run promptly.

**303.4 — The descriptor.** New `packages/protocol/src/workflow-node-type.ts`
per §4.2; export from the package index; add `node?` to `PluginMemberScript`
and validate it in `definePlugin`. *Result*:
`bun test packages/sdk/src/plugin.test.ts` → G3.

**303.5 — Manifest and verify.** The descriptor rides with the member metadata
the verify child already reports (`title`, `description`,
[plugin.ts:38-48](../../packages/sdk/src/plugin.ts)) and is persisted into the
manifest. *Result*: `bun test packages/core/src/plugins/` (the directory only)
green.

**303.6 — The registry and the route.** New
`packages/core/src/workflows/registry.ts` and
`GET /api/node-types` per §4.3. *Result*:
`bun test packages/core/src/workflows/registry.test.ts` → G4, G6.

**303.7 — The packs, and the bump.** Descriptors for every member of both
shipped packs; bump all three sites per pack; changelog lines;
`bun run build:packs`. *Result*: G7's greps agree, and the rebuilt bundle
carries the new version.

**303.8 — Status and report.** `> Status:`, §11,
`bash scripts/check-plan-status.sh`.

## 6. Acceptance criteria

- G1–G7, G9 pass; G8 is the owner's row.
- `rg -n "kind: z.literal\('" packages/protocol/src/workflow.ts` → exactly 6.
- `rg -n "'core:" packages/core/src/workflows/registry.ts` → 6 core ids.
- A document referencing an uninstalled plugin node still parses, still fails
  `checkWorkflow` with the existing `script-unknown` code, and does not crash
  the registry.

## 7. Test plan

| File | Covers |
|---|---|
| `packages/protocol/src/workflow.test.ts` | switch case bounds and ordering; delay bounds; six kinds |
| `packages/protocol/src/workflow-check.test.ts` | successors and budget for both kinds |
| `packages/core/src/jobs/executors/workflow.test.ts` | first-match-wins; default; dangling case; delay clamp; delay cancellation |
| `packages/sdk/src/plugin.test.ts` | descriptor accepted, bad icon refused, bad category refused |
| `packages/core/src/workflows/registry.test.ts` | core + plugin entries; activated-only; version pinned |

Manual smoke (owner, 10 minutes):
1. `bun run dev` on a **fresh** data directory; `GET /api/node-types` lists 6
   core types and the two packs' members.
2. Publish a workflow with a 3-case switch through the API; run it; the step
   list shows exactly one case fired.
3. Bump one pack by a patch, `bun run build:packs`, restart on the **same**
   data directory: the new version is staged; activate it on the Plugins page;
   the palette shows the change. This step is the seeding trap of §3.5, run
   once, on purpose.

## 9. Open questions

| # | Question | Held by | Current answer |
|---|---|---|---|
| Q1 | Does a `forEach` node over an array belong in the core catalog? | this plan | **No, for now.** A script returns the array, a gate plus a backward edge walks it — which already works. Revisit when the owner has a real workflow that needs it; the trigger is plan 300 D3's falsification test, not a hunch. |
| Q2 | Should a pure data-shaping node (no device, no child process) exist? | this plan | If it is needed, it is a **core** node (D8-adjacent: it defines no edges but it also spawns nothing). Not built until an author asks twice. |
| Q3 | Conditional parameter visibility (n8n `displayOptions`, plan 300 R7) | this plan | Not built. `SchemaForm` renders every declared field; a member that needs modes declares a discriminated union and lets the schema do it. |
| Q4 | Should the registry expose deactivated plugins so a document referencing one renders with its real title? | plan 306 | Yes, but as a separate lookup (`GET /api/node-types?include=inactive`), not in the palette. Deferred until 306 needs it. |

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| Nothing | — | This plan is additive; the removals it enables (chained gates in the shipped packs' example workflows) belong to the pack that owns them |

## 11. Handoff report

- **Checklist**: G1 ✅ G2 ✅ G3 ✅ G4 ✅ G5 ✅ G6 ✅ G7 ✅ G8 owner (not run) G9 ✅ typecheck / not run `build:studio` (see below).

- **Scope executed**: all eight implementation steps (303.1–303.8).

- **Files created**:
  - `packages/protocol/src/workflow-node-type.ts` — `NodeCategorySchema`, `WorkflowNodeDescriptorSchema`, `WorkflowNodeDescriptor`, `WorkflowNodeDescriptorInput`.
  - `packages/protocol/src/api/node-types.ts` — `NodeTypeSchema`, `NodeTypesResponseSchema`.
  - `packages/core/src/workflows/registry.ts` — the plan's own named artefact: `listNodeTypes`, the 6 `core:<kind>` constants, the manifest projection.
  - `packages/core/src/workflows/registry.test.ts` — G4/G6.
  - `packages/core/src/api/node-types.ts` — `GET /api/node-types`, mounted at `/api/node-types`.

- **Files changed** (protocol/executor, step 303.1–303.3): `packages/protocol/src/workflow.ts` (`switch`/`delay` node kinds, `WORKFLOW_NODE_KINDS`, `maxSwitchCases`/`maxDelayMs`), `packages/protocol/src/workflow.test.ts` (six-kinds, switch/delay bound tests), `packages/protocol/src/workflow-check.ts` (successors + budget for both kinds, binding sites for a case's `when` and a delay's `ms`), `packages/protocol/src/workflow-check.test.ts` (successor/budget/dangling-edge tests), `packages/protocol/src/api/workflow-jobs.ts` (`WorkflowStepInfoSchema.kind` widened to include `switch`/`delay`), `packages/core/src/db/schema.ts` (`workflowSteps.kind`'s TS union widened — no DDL change, still `text('kind')`, so **no migration was generated or needed**), `packages/core/src/jobs/executors/workflow.ts` (switch evaluation, first-match-wins; `cancellableDelay` — a cancellable, clamped wait), `packages/core/src/jobs/executors/workflow.test.ts` (G2, delay clamp, delay cancellation).

- **Files changed** (descriptor + verify, step 303.4–303.5): `packages/sdk/src/plugin.ts` (`PluginMemberScript.node?`, validated by `definePlugin` through `WorkflowNodeDescriptorSchema`), `packages/sdk/src/plugin.test.ts` (G3), `packages/core/src/plugins/verify-child-entry.ts` (reports `node`, JSON round-tripped, alongside `title`/`description`), `packages/core/src/plugins/verify-child.ts` (`VerifiedScript.node?`, independent re-validation in `finalizeReport`, new `E_PLUGIN_NODE_INVALID` code), `packages/core/src/plugins/verify-child.test.ts` (healthy + hostile node-descriptor bundle fixtures).

- **Files changed** (wiring, step 303.6): `packages/core/src/server/http.ts` (`HttpDeps.nodeTypeRoutes`, mounted at `/api/node-types`), `packages/core/src/server/http.test.ts` (fixture updated), `packages/core/src/daemon.ts` (constructs `createNodeTypeRoutes({ plugins: pluginRuntime })`), `packages/protocol/src/index.ts` / `packages/protocol/src/api/index.ts` (new exports).

- **Files changed** (packs, step 303.7): all 11 tiktok members (`switch-account.ts`, `search-follow.ts`, `list-accounts.ts`, `post-video.ts`, `enqueue-video.ts`, `search-keyword.ts`, `keyword-videos.ts`, `live-browse.ts`, `shop-browse.ts`, `notification-activity.ts`, `index.ts`'s `auto-scroll`) and all 5 youtube members (`search-channel.ts`, `scroll-shorts.ts`, `scroll-live.ts`, `download-home.ts`, `search-play.ts`) gained a `node` descriptor; both packs' `package.json`, `src/index.ts`'s `version:`, and `src/index.test.ts`'s assertion bumped **minor** (tiktok 1.16.0 → 1.17.0, youtube 0.11.0 → 0.12.0) with a changelog line each; `bun run build:packs` rebuilt all 6 packs (the other four — `networking`, `proxy-manager`, `mikrotik-routing`, `google` — untouched, unchanged versions, rebuilt byte-identically aside from the timestamp).

- **Discrepancy — "the two shipped packs" (§4.5, G7) is not stated by name anywhere in plan 303 or 300.** The repo currently ships six packs (`tiktok-automation-pack`, `youtube-automation-pack`, `google-automation-pack`, `mikrotik-routing`, `networking`, `proxy-manager`) plus an `instagram-automation-pack` directory `build-packs.ts` does not yet register. This session read "the two shipped packs" as `tiktok-automation-pack` and `youtube-automation-pack` — they are the two the owner's own examples cite throughout plan 300 (`tiktok/auto-scroll`, `tiktok-search-pipeline`) and the two most recently touched (`d96d2be`/`dc2948a`, the two commits immediately preceding this branch's starting point). If the owner meant a different pair (or all of them), the remaining packs need the same three-step treatment `switch-account.ts` through `search-play.ts` above already show the pattern for.

- **Discrepancy — no DB migration was generated.** §5 does not say whether `workflow_steps.kind` needs one; `workflowSteps.kind` is `text('kind').$type<'script' | 'gate'>()` — a Drizzle `$type<>()` annotation is TypeScript-only, not a column constraint, so widening the union to include `'switch' | 'delay'` changes zero DDL. `bun run --cwd packages/core db:generate` was not run because there is genuinely nothing for it to generate; running it produces an empty migration, which this session chose not to add. If a reviewer wants to confirm, running the generator and observing no new file is the check.

- **Discrepancy — G4's own wording ("... version and params schema") vs. the actual `NodeType` shape.** §4.3's own `NodeType` interface (which this plan's own code block declares) has no top-level `version` field — the version is folded into `script` (`plugin/member@version`), matching plan 303 §4.4's own "the palette offers `plugin/member@<the activated version>`". G4's prose and G4's own cited interface disagree on this one word; the interface (which is also what `NodeTypeSchema` and the tests assert against) is what shipped.

- **Design decision recorded — dev slots are excluded from the palette.** §4.3 says "Plugin entries come from the manifests of **activated** plugins only". A dev slot (`enkaku dev`) is a separate, unpublished thing, and G4/G8's own wording never mentions it; `listNodeTypes` reads `runtime.list()` + `runtime.active(name)`, never `runtime.devSlots()`. If a future plan wants dev-slot nodes in the palette (useful for iterating on a node locally), that is a new row, not an oversight here — recorded because `surface-registry.ts`'s `ui()` DOES include dev slots for the SAME kind of question ("what nav is live right now"), and this plan deliberately does not follow that precedent.

- **Design decision recorded — `switch`'s step output shape.** Neither §4.1 nor §5 states what a `switch` step's `workflow_steps.output` column should hold. This session used `{ case: number | null, branch: string | null }` — `case` is the index of the fired case (`null` when `default` fired or nothing did), `branch` is the target node id — mirroring the gate's existing `{ value, branch }` shape as closely as the two control surfaces allow.

- **Design decision recorded — a delay's `ms` resolution failure degrades to `0`, not a step failure.** Neither §4.1 nor §3.4 states what happens when `ms` (any `ValueExpr`, including `{ expr }`) fails to resolve. This session treats an unresolved/non-numeric `ms` as `0` (an instant, clamped, no-op wait) rather than failing the step — a delay is advisory pacing, not a binding whose absence should abort a run the way an unresolved script param does.

- **Typecheck**: clean. `bash scripts/typecheck.sh` → `OK` for all 21 workspace targets (protocol, expr, ui, adb, toolchain, drivers, scrcpy, sdk, session, harness, core, node, studio, probe-server, networking, proxy-manager, tiktok-automation-pack, mikrotik-routing, google-automation-pack, youtube-automation-pack, examples).

- **Tests run** (one invocation at a time, never concurrently):
  - `bun test packages/protocol/src/workflow.test.ts` → 80 pass, 0 fail
  - `bun test packages/protocol/src/workflow-check.test.ts` → 46 pass, 0 fail
  - `bun test packages/core/src/jobs/executors/workflow.test.ts` → 14 pass, 0 fail
  - `bun test packages/sdk/src/plugin.test.ts` → 41 pass, 0 fail
  - `bun test packages/core/src/workflows/registry.test.ts` → 8 pass, 0 fail
  - `bun test packages/core/src/plugins/verify-child.test.ts` → 32 pass, 0 fail (the node-descriptor bundle fixtures added by step 303.5)
  - `bun test packages/core/src/plugins/` (the directory step 303.5 names, one final sweep) → 311 pass, 1 skip, 0 fail (one `webhook-service.test.ts` case was independently observed flaky on a decoy-secret collision, unrelated to this plan, and passed on re-run)
  - `bun test packages/core/src/server/http.test.ts` → 14 pass, 0 fail (fixture updated for `nodeTypeRoutes`)
  - `bun test packages/protocol/src/workflow-resolve.test.ts` → 55 pass, 0 fail (untouched by 303, re-run as a sanity check since 302's session also touched `workflow-resolve.ts`)
  - `bun test ./plugins/tiktok-automation-pack/src/index.test.ts` → 35 pass, 0 fail
  - `bun test ./plugins/youtube-automation-pack/src/index.test.ts` → 5 pass, 0 fail
  - `bun run build:packs` → rebuilt 6 packs, `tiktok@1.17.0`, `youtube@0.12.0` among them, output pasted below.

  ```
  $ bun run build:packs
  $ bun scripts/build-packs.ts
    networking@3.0.0 → packs/networking.mjs (808 KB, 1 script(s))
    proxy-manager@0.11.2 → packs/proxy-manager.mjs (1055 KB, 1 script(s), 2 ui asset(s))
    tiktok@1.17.0 → packs/tiktok.mjs (918 KB, 11 script(s))
    mikrotik-routing@0.14.0 → packs/mikrotik-routing.mjs (873 KB, 4 script(s), 1 ui asset(s))
    google@0.2.0 → packs/google.mjs (794 KB, 2 script(s))
    youtube@0.12.0 → packs/youtube.mjs (841 KB, 5 script(s))
  built 6 pack(s) into packages/core/packs
  ```

- **`bun run build:studio`**: **not run**. `bash scripts/build-studio.sh` was invoked directly and confirmed the refusal (its own guard message, quoted verbatim): *"The Studio dev server is running on :3001. Building now would corrupt it... Stop it first, then build."* Per the launch instructions, neither job in this launch edits `packages/studio`, and this plan's own steps never touched it either — so there is no reason to expect the build to fail, but it is genuinely unverified this session. This is the ONE reason `> Status:` reads `partial` rather than `implemented (software)`.

- **§6 acceptance criteria, checked**:
  - `rg -n "kind: z.literal\('" packages/protocol/src/workflow.ts` → 6 matches (`start`, `script`, `gate`, `switch`, `delay`, `finish`).
  - `rg -n "'core:" packages/core/src/workflows/registry.ts` → 6 matches (one per `core:<kind>` id).
  - "A document referencing an uninstalled plugin node still parses, still fails `checkWorkflow` with the existing script-unknown code, and does not crash the registry" — structurally true rather than newly tested: a workflow document only ever stores `kind: 'script', script: <ref>` (unchanged by this plan — nothing about `WorkflowNodeSchema`'s `script` kind changed), so `checkWorkflow`'s existing `E_WORKFLOW_SCRIPT_UNRESOLVED`/publish-route resolution path (`packages/core/src/api/workflows.ts`, untouched by this plan) is exactly what an uninstalled reference already hits, unrelated to whether that script happens to declare a `node`. `listNodeTypes` never reads a workflow document at all — it only enumerates `runtime.list()`/`runtime.active()` — so there is no code path by which a document could reach it, let alone crash it; `registry.test.ts`'s "a farm with no plugins at all" case is the closest direct proof (`listNodeTypes` never throws with zero plugins installed).

- **`rg -n "outputs" packages/sdk/src/plugin.ts packages/protocol/src/workflow-node-type.ts`** → empty (G5).

- **Removed (§10)**: nothing — this plan is additive, as §10's own row already states. No proof command changed.

- **Observed, not done**:
  - `bun run build:studio` — blocked by the concurrent Studio session, as above.
  - The §7 manual owner smoke (3 steps, 10 minutes) — needs a real farm and an operator; not run by an agent, matching plan 200 §8.3's division of labour. G8 is that smoke's step 3.
  - The other four packs (`google-automation-pack`, `mikrotik-routing`, `networking`, `proxy-manager`) and `instagram-automation-pack` were left untouched — see the "two shipped packs" discrepancy above for why, and what to do if that reading was wrong.
  - No dedicated `packages/protocol/src/workflow-node-type.test.ts` was written. G3/G4's own test files already exercise `WorkflowNodeDescriptorSchema` end-to-end (through `definePlugin` and through the registry), and plan 303 §7's table does not name a file for the schema in isolation.
  - No `daemon-wiring.test.ts`-style guard was added for `nodeTypeRoutes` (unlike `workflowRoutes`'s own `workflows-wiring.test.ts`, referenced in that field's doc comment). This plan wires the route directly and fully in `daemon.ts` in the same session, so there is no gap-in-progress for a guard test to protect against; not adding one is a scope choice, not an oversight.

- **Open questions hit**: none of §9's four questions blocked any step. Q1 (`forEach`) and Q3 (`displayOptions`) were left exactly as answered — not built. Q2 (a pure data-shaping node) was not needed. Q4 (deactivated plugins in the registry) is explicitly deferred to plan 306 by its own answer; not built here.

- **Processes**: no process was started by this session that is still running. A final `ps` check (below) shows two processes matching `openpf`, both under the MAIN checkout path (`/Users/solpochi/Projects/oss/openpf/...`, not this worktree's `.claude/worktrees/agent-ae064af92de9ca9e9/...`) — a `scrcpy` server and a `next dev` on `:3001` — belonging to the concurrently running session the launch instructions named as working in the main worktree. Neither was started, stopped, or otherwise touched by this session; this worktree started no process of its own that outlived its test/build commands.

  ```
  $ ps -Ao pid=,command= | grep -i "[o]penpf"
  45634 /Users/solpochi/Projects/oss/openpf/.dev-data/tools/adb/36.0.0/platform-tools/adb -s ZP2222RMBS shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 3.3.1 scid=7f5c95c3 log_level=info video=true audio=false control=true tunnel_forward=true video_codec=h264 max_size=480 video_bit_rate=1100000 max_fps=18 cleanup=true raw_stream=false
  18668 node /Users/solpochi/Projects/oss/openpf/packages/studio/node_modules/.bin/next dev -p 3001
  ```
