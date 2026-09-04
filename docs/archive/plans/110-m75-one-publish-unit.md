# Plan 110 — M75 : One publish unit, and a script that knows what app it was written for

> Status: partial — **decision A is shipped in full; decision B is not started.** Written 2026-08-17 to close two decisions the owner made during plan 108/109's design conversation that were never written into either plan, then implemented the same day. `bun test` 5211 pass / 0 fail, `bun run --cwd packages/studio test` 1602 pass / 0 fail, `bun run typecheck` 15/15 OK.
>
> **Done (A): 110.1–110.5**, plus one step this plan did not anticipate. `defineScript` is deleted from `@enkaku/sdk`; `enkaku publish` refuses a non-plugin entry with a message carrying the four-line wrapper; `enkaku init` scaffolds a publishable project; all four `examples/` are one-member plugins; `publishScript()` refuses a plugin-less `kind: 'script'` row at the one writer, and a sweep proved there are exactly **two** writers of a `scripts` row workspace-wide and no fifth caller; recordings publish as `recordings/<slug>` under a synthetic owner that is immune to activate/rollback/disable/remove and whose name is reserved at verify.
>
> **Beyond the plan, owner-directed mid-build: the `standalone` CONCEPT is gone**, not merely unreachable. `ScriptOrigin` is `'plugin' | 'dev'`; an unowned `kind: 'script'` row does not list, group, `get`, or resolve; Studio's origin filter and Plugin column are deleted. Two things made this safe and neither was obvious: the rule is scoped to `kind: 'script'` because **a workflow row also has `plugin_id IS NULL`** (§3.3 makes `publishScript` refuse a workflow that carries one), so a blanket rule would have taken every workflow on every farm offline; and the ignoring is announced by exactly **one** startup warn naming the affected script names and the two commands to delete them, because a farm that silently stops running five scripts is the worst possible outcome.
>
> **Corrections this build made to the plan itself:** §3.5 was wrong twice — first "no migration, orphans stay", then an adoption migration that was **built, tested at 14 cases, and deleted unshipped** because it renamed where the owner wanted removal and would have invented five plugins nobody authored. §3.5 now records both drafts and keeps adoption's one durable finding: the three name-keyed references any future rename must handle, the third of which (**a workflow document's node refs, in two copies**) was missing from the table until the implementation found it. §9 Q1 is answered Hard and marked as a question that should never have been asked — the owner had already said it twice.
>
> **Not done (B): 110.6–110.9** — target-app compatibility metadata, and its prerequisite `device.app.info`. B2 stands: nothing in this repo can read an installed app's version, so the consumer cannot be built before the producer. **110.10** is partly done (spec §11.4, `docs/feat/plugin-and-script.md`, `docs/guide/scripts.md`, `packages/sdk/README.md` all carry the shipped rule); what remains is spec §11.1, which still documents the removed `defineScript`.
>
> **Two follow-ups blocked on files a concurrent builder holds:** `script.publish` creates its owner row directly instead of going through `PluginRuntime.stage/verify/activate` (the capability context has no runtime without `daemon.ts`) — it is guarded, refusing to touch a verified owner, but it is not the right pipeline; and `POST /api/scripts` is still mounted (`server/http.ts`), though it now enforces the same rule and no CLI calls it.
> Depends on: Plan 82 (M47) — the plugin registry and the stage→verify→activate pipeline. Plan 108 (M73) — the `.enkaku` package, the surface, and the merged Plugins screen this extends.
> Spec references: §11.4 (dependencies and publishing), §11.5 (lifecycle), §11.6 (plugins), §11.7 (workflows), §11.8 (action recordings), §12 (data model)
> Ships: packages/sdk/src/cli/init.ts

---

## 0. Evidence

### 0.1 The two decisions, and how they were lost

Both come from the same design conversation that produced plans 108 and 109. Both were answered in discussion and neither reached a plan.

**Decision A**, the owner's own words: *"script kayanya mending dihapus yang sistem script independent, menurut saya script keknya lebih baik tidak ada yang independent, wajib berdiri dari plugins, jadi script itu define dan declare nya di plugins, jadi tidak ada script yang define independen berdiri sendiri."*

**Decision B**, the owner's own words: *"script dan plugins memang bisa punya sistem version, ini karena terkadang script kan menjalankan automation, dan biasanya automation itu berdasarkan ui structure dari app di android, sedangkan app android bisa aja berbeda beda versi atau bisa update cepat."*

Why they were lost, recorded so the same failure is recognisable next time: plans 108 and 109 were scoped from the two **use cases** the conversation moved on to (a TikTok accounts screen, a proxy manager), not from the decision list that preceded them. A and B were answers to the owner's opening framing questions and had no use case attached, so neither had a natural home when the plans were written. A grep of both plans for `only publish unit`, `auto-wrap`, `targets:`, and `compatibilit` returns zero matches.

### 0.2 Confirmed findings — decision A

| # | Finding | Evidence |
|---|---|---|
| **A1** | **`enkaku publish` still branches on the entry's default export**: a `definePlugin()` result posts to `/api/plugins`, a `defineScript()` result posts to `/api/scripts`, exactly as before plan 108. The standalone publish path is fully alive. | `packages/sdk/src/cli/publish.ts` — `isPlugin(built.default) ? publishPlugin : publishScript` |
| **A2** | **There is exactly ONE writer** — `publishScript()` in `scripts/service.ts` — and **four** callers. Any rule about "what may be published" has one place to be enforced and four places to be routed through it. | `scripts/routes.ts:397` (`POST /api/scripts`), `capability/context.ts:278` (the `script.publish` capability, used by the agent and MCP), `api/workflows.ts:221` (workflow publish), `api/recordings.ts` (`POST /:slug/publish`) |
| **A3** | **A workflow is not an ESM bundle at all** — its `bundle` column holds a validated `WorkflowDoc` JSON, and it is selected by `scripts.kind = 'workflow'`. "Everything goes through a plugin" has to say something about it, or it silently becomes an exception. | `docs/spec.md` §11.7; `packages/core/src/db/schema.ts:847` |
| **A4** | **A recording publishes as an ordinary `kind: 'script'` row**, deliberately indistinguishable from a hand-written script on every surface that reads it. | `packages/core/src/api/recordings.ts:26-31` |
| **A5** | **Every file in `examples/` is a standalone `defineScript`** — four of them, the reference material an author reads and copies. | `examples/{hello-no-device,open-settings,scroll-fling-demo,debug-node}.ts` |
| **A6** | **A plugin member is NOT authored through `defineScript` today.** Members are plain objects typed `PluginMemberScript` (`Omit<ScriptDefinition,'version'>`), because a member carries no version of its own. So `defineScript`'s only real job today *is* the standalone case. | `packages/sdk/src/plugin.ts` |
| **A7** | Existing standalone rows already resolve correctly through the registry as `origin: 'standalone'`, and pinned jobs reference them by concrete id. Nothing about this plan needs to touch them. | `packages/core/src/scripts/registry.ts` |

### 0.3 Confirmed findings — decision B

| # | Finding | Evidence |
|---|---|---|
| **B1** | **Nothing in this repo can read an installed app's version.** No `dumpsys package`, no `versionName`, no `cmd package` version read anywhere in `packages/core`, `packages/session`, or `packages/adb`. The only app capabilities are `device.app.launch` and `device.app.forceStop`. | grep, 2026-08-17; `packages/core/src/capability/device-app.ts` |
| **B2** | So decision B has a **prerequisite that does not exist**: the comparison it asks for ("does this script support the TikTok on this phone") needs a producer before it needs a consumer. This is the single biggest thing the original discussion missed. | B1 |
| **B3** | Member versions are stamped from the plugin and are deliberately lockstep — two members of one bundle cannot honestly claim different versions, because the bytes, the instant, and the source tree are the same. **B is therefore not a versioning change at all**; it is metadata on a different axis. | plan 82 §3.6; `packages/sdk/src/plugin.ts` |
| **B4** | The pinning machinery decision B would use **already exists in full**: `name@version` refs pinned at enqueue, `superseded` rows kept resolvable, rollback, and per-job pinning. What is missing is only the information to choose with. | plan 62; `packages/core/src/scripts/registry.ts` |
| **B5** | The farm already has a place to put a per-device observation about an app, and a precedent for the honesty rules around it: the network layer's `deriveHealth` refuses to word `unverified` as success. A version reading that failed must not read as "compatible". | `packages/protocol/src/network.ts`; `CLAUDE.md` |

---

## 1. Goals

1. **A script cannot be published to the farm outside a plugin.** Whatever an author types, what the farm accepts is a plugin.
2. **Every one of the four publish paths lands on the same rule** — no path is an exception, and none is left to be discovered later.
3. **Nothing already published breaks.** Existing standalone rows resolve, run, and are pinned exactly as they are today. This is a rule for new publishes, not a data migration.
4. **A script can declare which app versions it was written for**, and the farm warns **before a device is leased** when it is about to run one against something else.
5. **The farm can read an installed app's version at all** — the prerequisite goal 4 is otherwise built on nothing.
6. A failed or absent version reading is worded as *unknown*, never as compatible.

## 2. Non-goals

- **Per-member semver.** Refused, with the reasoning in B3: members share one bundle and one instant. Decision B is metadata, not versioning.
- **Migrating existing standalone rows into synthetic plugins.** Goal 3 — they stay as they are, forever.
- **Refusing to run a script whose target does not match.** A warning, not a gate (§3.6). The farm does not know the author's intent well enough to be right about a refusal.
- **A compatibility database, an app catalogue, or version discovery across the fleet.** One reading, on demand, for the device a job is about to touch.
- **Anything about plugin runtime** — that is plan 109 and is untouched here.

## 3. Context and design decisions

### 3.1 What "no independent script" can mean — two readings, and they differ only in ceremony

The owner's words point at authoring (*"define dan declare nya di plugins"*), so both readings below deliver goal 1; they differ in what a twenty-line script costs to write.

| | **Hard** | **Wrapped** |
|---|---|---|
| `defineScript` | removed from `@enkaku/sdk` | stays, as authoring sugar |
| A standalone entry | will not compile | compiles; the CLI wraps it into a one-member plugin whose id is the script's id |
| What the farm receives | a plugin | a plugin |
| `POST /api/scripts` | removed | internal only, not reachable from the CLI |
| A twenty-line script | must write `definePlugin({ id, version, scripts: [ … ] })` | writes what it writes today |
| `examples/` (A5) | all four rewritten | all four keep working |
| Honesty | the author sees the model the farm actually has | the author sees a shorthand; the model is one layer below |

**Recommendation: Hard.** Not for purity — for the reason the owner gave. The wrapped reading leaves every author still writing a standalone script and learning the plugin model only when they need a second script or a screen, which is exactly the split brain decision A exists to remove. And the ceremony argument is weaker than it looks: the difference is four lines, and it can be removed entirely by `enkaku init` scaffolding a plugin (§4.2) rather than by keeping a second authoring shape alive.

**This is §9 Q1 and it is blocking.** Every step below is written for Hard; the deltas for Wrapped are called out where they differ, so switching is a scoping change rather than a rewrite.

### 3.2 One rule, enforced at the writer, not at four routes

A2 is the gift here: `publishScript()` is the only writer. So the rule — *a `kind: 'script'` row is only ever written with a `pluginId`* — is enforced in one function, and the four callers are routed through it rather than each learning the rule:

| caller | today | after |
|---|---|---|
| `POST /api/scripts` (`scripts/routes.ts`) | the CLI's standalone path | **removed from the public surface.** Kept as an internal writer the three below call |
| `script.publish` capability (`capability/context.ts`) | bundle or workspace path → a standalone row | publishes a **plugin**; the `{ path }` form builds through `buildScriptFromWorkspace` as it already does |
| workflow publish (`api/workflows.ts`) | a `kind: 'workflow'` row, no plugin | **stays as it is** — see §3.3 |
| recording publish (`api/recordings.ts`) | a `kind: 'script'` row, no plugin | publishes into a **synthetic `recordings` plugin**, so a recording becomes `recordings/<slug>` |

### 3.3 A workflow is the one honest exception, and it is named rather than hidden

A workflow's `bundle` is a `WorkflowDoc`, not ESM (A3). It has no `run()`, no members, and nothing to share by import — the entire argument for plugins (one bundle, many scripts, shared helpers) does not apply to it. Forcing it into a plugin would be ceremony with no payoff, and would make `kind` mean less than it does now.

So: **a workflow is published as a workflow, and `scripts.kind` is what says so.** The rule in §3.2 is written as *"a `kind: 'script'` row is only ever written with a `pluginId`"* — precisely so this exception is a consequence of the rule's own wording rather than a carve-out bolted on beside it.

### 3.4 A recording becomes `recordings/<slug>`

A4 says a recording deliberately publishes as an ordinary script row. Under decision A that means it needs an owner, and the natural one is a single synthetic plugin named `recordings` whose members are the published recordings.

This is better than a plugin per recording (`<slug>/<slug>` reads badly, and twenty recordings would mean twenty plugin rows on the Plugins screen). It also gives recordings one KV namespace, which they do not have today and which is a real gain rather than an accident of the design.

The synthetic plugin is created on first publish and never shown as installable — an operator cannot activate, roll back, or remove it independently of the recordings it holds. That constraint has to be real in the runtime, not just a UI omission.

### 3.5 Existing rows are DELETED BY THE OPERATOR — not adopted, and never by a silent migration

> **SUPERSEDED IN PART, 2026-08-17** — by the owner's follow-up (*"sistem standalone dihapus dari ui
> dan dari sistem core juga"*). Points 1 and 3 below stand: no migration, nothing deleted without the
> operator, job history survives regardless. Point 2 does **not**: an orphan no longer resolves. The
> registry ignores a `kind: 'script'` row with no owning plugin entirely — it does not `list`, does
> not appear in `groups`, does not `resolve`, and `get()` returns null for it — and `ScriptOrigin` is
> now `'plugin' | 'dev'`, with no third value. The rows stay on disk; the core emits exactly one
> `warn` at startup naming how many there are and which, since they are no longer findable in any
> list (the origin filter this section relied on for that is gone with the category). See
> `docs/spec.md` §11.4 for the shipped rule.

**This section was wrong twice before it was right, and both drafts are recorded so the reasoning is not re-litigated.**

*Draft 1* said "there is no migration" and left every orphan standing. The owner rejected it: a farm still listing `chrome-open-url`, `network-test`, `debug-node`, `hello-no-device` and `test-chrome` as standalone has not delivered *"tidak ada script yang define independen berdiri sendiri"*, it has only stopped adding more.

*Draft 2* — below, kept for its analysis — adopted each orphan into a one-member plugin. It was **built and fully tested, then scrapped unshipped**, because the owner's actual requirement is *"script yang ada sekarang akan hilang semua kecuali 2 aja karena memang dari 2 plugin"*. Adoption does not make anything disappear; it **renames**. `chrome-open-url` would have become `chrome-open-url/main` and the list would still hold nine names — five of them plugins nobody authored, each needing a collision rule to avoid colliding with a real project of the same name later. That the implementation needed such a rule at all was the smell.

**The decision: no migration, of any kind.** An orphan is deleted by an operator, deliberately, from the UI that already does it (`DELETE /api/scripts/:id`, which already refuses while a queued or running job references the row). Three reasons this is the only defensible shape:

1. **A silent boot migration must never destroy published work.** This one would run on every farm, including ones whose standalone scripts are real, current, and depended on. "It cleaned my dev farm" is not a licence to delete someone else's.
2. **Orphans must keep resolving until they are removed.** `jobs.script_id` pins them and a farm's history has to keep answering. They stay in `ScriptRegistry` as `origin: 'standalone'` — which is exactly why that value exists.
3. **Job history survives deletion anyway.** `jobs.script_name`/`script_version` were denormalised at enqueue precisely so a deleted script does not erase what already ran (plan 82 §3.4).

So the rule and the state converge by operator action, not by magic: nothing new can be published standalone (§3.2), what is already there keeps working, and the merged Plugins screen's origin filter is what makes the remaining ones findable so an operator can clear them.

<details>
<summary>Draft 2's analysis, kept because the three name-keyed references it uncovered are real and any future migration must handle them</summary>

Adoption would have renamed `<name>` → `<name>/main`. Three things key on the script **name** and break silently on a rename:

| keyed on | effect |
|---|---|
| `jobs.script_id` | a concrete id — unaffected |
| `jobs.script_name`/`script_version` | denormalised history — must be left as written |
| `schedules.script_ref` | **`name@version` — breaks** |
| `script_param_sets.script_name` | **breaks** |
| **a workflow document's node refs** | **`WorkflowNodeSchema.script` and `onFail.script` are `ScriptRef`s resolved at RUN time — break, and fail far from their cause.** Two writes, not one: the published row's `bundle` (a workflow row's bundle IS the `WorkflowDoc`) *and* the workspace copy the editor re-publishes from |

The third was missing from this table until the implementation found it. Anything that ever renames a script must handle all three.
</details>

An earlier draft of this section said "there is no migration" and left every existing standalone row exactly as it was. That was wrong, and the owner caught it: a farm that still lists `chrome-open-url`, `debug-node`, `hello-no-device`, and `network-test` as standalone scripts has not delivered *"tidak ada script yang define independen berdiri sendiri"* — it has only stopped adding more. The rule and the state have to agree.

Deleting them is not the answer either: `jobs.script_id` pins them, and a farm's history must keep resolving.

So each orphan standalone row is **adopted** into a plugin named after the script itself — `chrome-open-url` becomes plugin `chrome-open-url` with one member, renamed `chrome-open-url/chrome-open-url`… which reads badly. The better shape, and the one this plan takes: **one plugin per script name, member id `main`**, so the reference becomes `chrome-open-url/main`. Every version of that name joins the same plugin, so the 17 versions of `chrome-open-url` stay one thing with a history rather than 17 plugins.

**What a rename actually touches — this is the load-bearing part, because two of these are not obvious:**

| keyed on | effect | action |
|---|---|---|
| `jobs.script_id` | a concrete id, unchanged by a rename | nothing |
| `jobs.script_name`/`script_version` | denormalised history of what ran | left as written — it is a record of the past, not a reference |
| `schedules.script_ref` | **`name@version` — breaks on rename** | migrated in the same transaction |
| `script_param_sets.script_name` | **breaks on rename** | migrated in the same transaction |
| **a workflow document's node refs** | **`WorkflowNodeSchema.script` and `onFail.script` are `ScriptRef`s resolved at run time — break on rename** | migrated in the same transaction, in BOTH copies (below) |
| `batches` | resolve through `scripts.id` | nothing |

A migration that renames without those three is a migration that silently breaks every schedule, every saved parameter set, and every workflow on the farm. They move together or not at all.

**The third row was missing from this table until the migration was built, and it is the most dangerous of the three** — a workflow fails at *run* time with `script_not_found`, on whichever node happens to reference an adopted script, long after the upgrade that caused it. It is also the only one needing **two** writes rather than one: the published row's `bundle` (a `kind: 'workflow'` row's bundle IS the `WorkflowDoc` JSON) **and** the workspace copy the editor re-publishes from — rewrite only the first and the next publish from the editor silently re-breaks it.

The adoption runs once, guarded by `migration_markers` the way the cluster materialisation already is, so a restart cannot run it twice.

`ScriptRegistry.origin` keeps `'standalone'` as a value — a row can still be found in that state by a farm mid-upgrade — but after adoption no farm has one.

### 3.6 Decision B is compatibility metadata, and it needs a producer first

The owner's problem — an automation is written against a screen layout, and the app changes underneath it — is real and is **not** solved by a version number on the script. It is solved by the script saying what it was written against, and the farm comparing that with what is actually installed.

```ts
{
  id: 'search-follow',
  targets: [{ package: 'com.ss.android.ugc.trill', versions: '>=32.0.0 <34.0.0' }],
}
```

Three properties this must have, each of which is a decision:

1. **A warning, not a gate** (§2). The farm knows the declared range and the installed version; it does not know whether the author's range is conservative, stale, or exact. Refusing a run on that basis would be the farm being confidently wrong. It warns at enqueue — **before a lease is taken** — so the cost of being wrong is a dialog, not a burned device slot.
2. **Unknown is not compatible** (B5). A version that could not be read, a device that has never been checked, and a script that declares no `targets` are three different states and must read as three different things. The precedent is the network layer's `unverified`, which the repo already refuses to word as success.
3. **It is not a version number.** B3 — members share a bundle. `targets` sits beside `params`/`result`/`runtime` as another thing a member declares, and rides the same verify → manifest → row path all three already use.

**The prerequisite (B2):** none of this can be built before the farm can read an installed package's version, which today it cannot (B1). That is step 110.6 and it comes first among the B steps.

---

## 4. Technical design

### 4.1 The writer's rule

```ts
// packages/core/src/scripts/service.ts
export interface PublishScriptInput {
  // … existing fields
  /** Plan 110 §3.2 — a `kind: 'script'` row is only ever written with an owning plugin. */
  pluginId?: string
  exportId?: string
}
```

`publishScript()` throws `E_SCRIPT_NEEDS_PLUGIN` when `kind === 'script'` and `pluginId` is absent, naming the rule and pointing at `definePlugin`. A `kind: 'workflow'` row is unaffected (§3.3).

This is the whole enforcement. The four callers either supply a plugin or are a workflow.

### 4.2 The authoring side (Hard)

- `defineScript` is removed from `@enkaku/sdk`'s exports and its file deleted. `ScriptDefinition` stays — it is what a member becomes after `definePlugin` stamps it.
- `PluginMemberScript` is unchanged (A6 — members never used `defineScript` anyway), so **no existing plugin needs an edit**.
- `enkaku publish` loses its branch: a non-plugin entry is refused with a message showing the four-line wrapper and pointing at `enkaku init`.
- **`enkaku init <name>`** scaffolds a plugin project — `package.json`, `tsconfig.json`, and an `index.ts` with one member — so the ceremony argument against Hard is answered with a command rather than with a second authoring shape. This is `Ships:`.
- `examples/` (A5): all four rewritten as one-member plugins. They are reference material an author copies, so they must show the model that actually exists.

*Wrapped delta:* `defineScript` and `POST /api/scripts` stay; `publish.ts` gains a `wrapStandalone()` that turns a `ScriptDefinition` into a one-member `Plugin` before posting to `/api/plugins`; `examples/` is untouched; `enkaku init` is optional rather than load-bearing.

### 4.3 The synthetic `recordings` plugin

`api/recordings.ts`'s publish path resolves-or-creates a plugin row named `recordings`, then publishes the compiled entry as a member. `PluginRuntime` gains a `synthetic` marker (a column-free flag derived from the reserved name) so activate/rollback/remove refuse it with a message pointing at the recording itself.

Reserved names — `recordings`, and any future synthetic owner — are refused to a real `definePlugin({ id })` at verify, or two owners collide over one namespace.

### 4.4 Reading an installed app's version (B2, the prerequisite)

A new capability `device.app.info`, input `{ deviceId, package }`, output `{ installed: boolean, versionName: string | null, versionCode: number | null, readAt: number }`. Implemented over the one bounded adb CLI helper (`device/host-adb.ts`) — a `cmd package` / `dumpsys package` read, parsed defensively, with **a failed parse answering `null`, never a guess** (B5).

It is a capability rather than a bare helper because the agent, MCP, and a plugin's `ctx.farm` all want it, and because it then arrives permission-gated and audited for free.

### 4.5 `targets` on a member

- `PluginMemberScript.targets?: Array<{ package: string; versions: string }>`, validated by `definePlugin` at import time (a real package name shape; a parseable semver range).
- Reported by the verify child alongside `paramsSchema`/`resultSchema`/`runtime`, re-validated by the parent, persisted in the manifest and on the `scripts` row — the same path those three already take.
- Carried on `ScriptEntry` by `ScriptRegistry`, pinned at enqueue like everything else.

### 4.6 Where the comparison happens

`jobs/validate-script.ts` already runs a structural params check at enqueue, **before a device is leased** — the natural home. It gains a compatibility check producing one of four states, which the run dialog and the batch preview render:

| state | when |
|---|---|
| `ok` | a version was read and falls inside a declared range |
| `mismatch` | a version was read and falls outside — **the warning** |
| `unknown` | the version could not be read, or the device has never been checked |
| `undeclared` | the script declares no `targets` — the compatibility floor, and every script today |

`undeclared` and `unknown` never render as `ok`. `mismatch` never blocks; it names the installed version, the declared range, and offers the versions of that script whose ranges do contain it — which is the "pilih mau jalankan versi yang mana" the owner asked for, answered with information rather than a picker on its own.

---

## 5. Implementation steps

**110.1 — The writer's rule.** `publishScript()` refuses a plugin-less `kind: 'script'` row (`E_SCRIPT_NEEDS_PLUGIN`). Every existing caller updated in the same change (00-overview §4.3). *Result:* the rule exists in one place and nothing can write around it.

**110.2 — The recordings owner.** The synthetic `recordings` plugin, reserved names refused at verify, activate/rollback/remove refused on it with a message pointing at the recording. *Result:* recordings publish as `recordings/<slug>` and gain one KV namespace.

**110.3 — The capability publish path.** `script.publish` publishes a plugin; the `{ path }` form keeps building through `buildScriptFromWorkspace`.

**110.4 — The CLI (Hard).** `defineScript` removed; `enkaku publish` refuses a non-plugin entry with a message showing the wrapper; `enkaku init` scaffolds a plugin. *Result:* nothing an author can type produces a standalone publish.

**110.5 — `examples/` rewritten** as one-member plugins, and the guides that quote them updated in the same change.

**110.5b — ~~Adopt every existing standalone row~~ WITHDRAWN** (§3.5). Built, tested at 14 cases against a real `Db`, then deleted unshipped — it renamed where the requirement was removal, and a migration that destroys published work must never run silently on every farm. No step replaces it: an orphan is deleted by an operator through the UI that already does it. What the merged Plugins screen owes instead is only that orphans stay **findable** — its origin filter already provides that, so there is nothing to build.

**110.6 — `device.app.info`** (B2's prerequisite). The adb read, the defensive parse, the capability, its tests. **Nothing in B works before this.**

**110.7 — `targets` end to end.** Author-time validation → verify child → manifest → row → `ScriptEntry`.

**110.8 — The enqueue check** and its four states, in `validate-script.ts`.

**110.9 — Studio.** The four states in the run dialog and the batch preview, with `mismatch` naming installed version, declared range, and the versions that would fit. `unknown`/`undeclared` visibly distinct from `ok`.

**110.10 — Docs and spec.** §11.4 (publishing is a plugin), §11.6 (the rule and the workflow exception), §11.8 (recordings own a plugin), §12; `packages/sdk/README.md`; the `docs/guide/` pages that show a standalone script.

---

## 6. Acceptance criteria

1. `publishScript()` refuses a `kind: 'script'` row with no `pluginId`, naming the rule.
2. A `kind: 'workflow'` row still publishes with no plugin (§3.3), and the refusal message explains why a workflow is not an exception to the rule but a consequence of its wording.
3. Every existing standalone row still resolves, runs, and stays pinned — asserted against real rows written before this plan.
4. A recording publishes as `recordings/<slug>`; the synthetic plugin cannot be activated, rolled back, or removed on its own.
5. `definePlugin({ id: 'recordings' })` is refused at verify as a reserved name.
6. **Hard only:** `defineScript` is gone from `@enkaku/sdk`; `enkaku publish` refuses a non-plugin entry with a message showing the wrapper; `enkaku init` produces a project that publishes with no edits.
7. Every file in `examples/` publishes under the new rule.
8. `device.app.info` returns a real version for an installed package, `installed: false` for an absent one, and `null` — never a guess — when the output cannot be parsed.
9. `targets` survives author-time validation → verify → manifest → row → `ScriptEntry`, and is pinned at enqueue.
10. The enqueue check produces all four states, and `mismatch` **does not block the run**.
11. `unknown` and `undeclared` are worded distinctly from `ok` on every surface that shows them (the grep that plan 51 criterion 8 applies to credentials, applied here to compatibility wording).
12. A script declaring no `targets` behaves exactly as it does today, everywhere.
13. `bun run typecheck`, `bun test`, `bun run --cwd packages/studio test` green; `bash scripts/check-plan-status.sh` exits 0.

## 7. Test plan

**Unit** — `publishScript` refusals and the workflow carve-out; reserved-name refusal; `targets` validation at `definePlugin`; the `dumpsys`/`cmd package` parser against real captured output including a malformed sample and an absent package; the four-state comparison as a pure function.

**Core integration** — all four publish paths land under the rule; a pre-plan standalone row resolves and runs unchanged; a recording round-trips to `recordings/<slug>`; `targets` reaches `ScriptEntry`; the enqueue check runs **before** a lease is taken (assert lease state, not just call order).

**Studio** — the four states render distinctly; `mismatch` names installed, declared, and the fitting versions; a run with `mismatch` can still be started.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`)** — `enkaku init` → publish → run; `device.app.info` against a real TikTok install, then against an uninstalled package.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hard breaks every author's muscle memory at once. | `enkaku init` (110.4) plus rewritten `examples/` (110.5) land in the same change, so the first thing an author meets is the new shape. And §9 Q1 makes this the owner's call, not a default. |
| The rule leaks: some fifth writer appears later and bypasses it. | It is enforced **in the writer**, not at the routes (§3.2, A2). A new caller gets the refusal for free. |
| The `dumpsys` parse is brittle across Android versions. | It answers `null` rather than guessing (B5, criterion 8), and `unknown` is a first-class state rather than an error — a brittle parse degrades the feature, never the run. |
| `targets` becomes a de-facto gate because operators treat a warning as a refusal. | Criterion 10 pins it as non-blocking, and the wording names what is actually known rather than issuing a verdict. |
| The synthetic `recordings` plugin becomes a special case nobody remembers. | Reserved names are refused at verify (criterion 5), so the collision is impossible rather than merely unlikely. |

## 9. Open questions

**Q1 — Hard or Wrapped (§3.1)? ANSWERED: Hard.**
Answered 2026-08-17, and it should never have been asked: the owner had already said it twice, in the words quoted at §0.1 — *"tidak ada script yang define independen berdiri sendiri"* — and then said to proceed. Asking a third time was the plan's error, not an open question. Every step is written for Hard; the Wrapped deltas above are retained only as a record of what was rejected and why.

**Q2 — Should `targets` also be declarable at the plugin level?**
A pack whose members all drive one app would otherwise repeat the same range on every member. Plugin-level as the default, member-level as the override, is the obvious shape — and it is exactly how `reset.packages` already merges (plan 82 §3.10), so there is a precedent to copy rather than a pattern to invent. Not built above; worth deciding before 110.7 freezes the manifest shape.

**Q3 — Where does the installed-version reading live between jobs?**
110.8 compares at enqueue, which means a read per enqueue unless something caches it. Options: read every time (simple, an adb round trip per enqueue), cache on the device row with a TTL, or refresh it during device preparation (plan 106) where a device is already being inspected. **Recommendation: the third** — preparation already touches the device and already has a state machine to hang it on — but it couples this plan to that one, which is why it is a question rather than a step.
