# Plan 82 — M47 : Plugins, the Script Registry, and Dev Loading

> Status: partial — a second pass, with the two fences that blocked live execution (`packages/core/src/jobs/`, `packages/session/src/runner/job-runner.ts`) now gone, closed every item the first pass's own status header listed as "Not done" except one (a real `createDaemon().start()` boot test — see below). **What this pass added, on top of the first pass's registry/publish/verify/activate/fault-isolation work (unchanged, still real and tested):**
>
> **(1) End-to-end execution.** `executors/script.ts` no longer reads the `scripts` table directly — it resolves `job.scriptId` through `ScriptRegistry.get()` (works for a persisted row OR a `dev:<plugin>/<script>` id, which has no row at all), materialises the bundle through `registry.bundlePath()`, and threads the entry's `exportId` through a NEW `JobSpec.scriptExportId` field (`@enkaku/session`) into the spawned child's `ENKAKU_SCRIPT_EXPORT_ID` env var — the exact link `child-entry.ts`'s already-tested selection logic was waiting for. `executors/remote.ts` (the node-owned-device path) got the identical treatment plus a new optional `scriptExportId` field on `JobDispatchMessage` (`@enkaku/protocol`) and `packages/node/src/hosts.ts`'s `job.dispatch` handler threading it into its own `runner.execute()` call — a plugin script now runs correctly on a cloud node, not just locally. Proven by `packages/core/src/jobs/plugin-execution.integration.test.ts`: real DB rows, a real shared bundle, `createJobStore`+`createExecutorHost`+`@enkaku/session`'s real `createJobRunner` with its DEFAULT isolation (an actual `Bun.spawn` of `child-entry.ts`, no fakes) — one test claims `tiktok/login`, another claims `tiktok/warmup` out of the SAME bundle row and gets the right result back (criterion 3); a second test pins a job to `v1.0.0`, activates `v1.1.0` on top, and lets the pinned job actually RUN — it produces `v1.0.0`'s bytes (criterion 6's "let it run" half, previously unprovable). A third test starts a slow (800ms) job, calls `runtime.restart()` mid-run, and confirms the job still settles successfully with its original result (criterion 26's real-runner half). **A genuine gap this wiring found, fixed in the same pass:** `ctx.kv`'s namespace resolution (`job-runner.ts`) keyed off the child's `ready.scriptId`, which for a plugin member is the EXPORT id (`login`), not the plugin id (`tiktok`) — meaning two scripts in one plugin would NOT have shared a kv namespace, contradicting plan 79 §3.2 and this plan's own §3.10. Fixed by adding `pluginId` to the `ready` IPC message (`ipc.ts`, `child-entry.ts`) and preferring it over `scriptId` for both the kv namespace and log redaction; regression-tested in `executors/script.test.ts` by running two different members of one plugin and asserting both `kv.call`s land under the SAME namespace (`'tiktok'`, not `'login'`/`'warmup'`).
>
> **(2) Dev-shadow logging (criterion 16).** `executors/script.ts` now calls a new `findShadowedPublished()` (`scripts/registry.ts`) before running: when the resolved entry is a dev build and an enabled published entry of the same name also exists, the job's very first log line names the published version it shadows and the dev slot's owner. Tested in `executors/script.test.ts` with a real dev-slot bundle and a real published row; a second test proves an ordinary published run logs nothing about a dev build.
>
> **(3) Auto-rebuild on workspace write (front-end A's "no file watcher").** New `packages/core/src/plugins/auto-rebuild.ts`'s `withAutoRebuild()` wraps the `WorkspaceStore` daemon.ts constructs: a write/move/delete under a workspace-owned dev slot's own directory (the one containing its `entryPath`) calls `PluginRuntime.putDevSlot()` again, best-effort — a rebuild failure lands on the slot itself (`lastBuildOk`/`lastError`), never thrown back at the write that triggered it. `plugins/auto-rebuild.test.ts`: editing a SHARED HELPER (not the entry file) through the wrapped store increments the slot's `buildN` automatically, with no second `/api/plugins/dev` call anywhere in the test; a write outside the slot's directory does not trigger; no dev slot at all is a no-op.
>
> **(4) The CLI (step 12).** `enkaku publish <entry.ts>` now detects a `definePlugin()` entry via `isPlugin()` (the SAME check `child-entry.ts` uses) and posts to `POST /api/plugins` instead of `/api/scripts` — no `paramsSchema` computed client-side (a plugin publish needs none; the farm's own verify child reports each member's schema). `--stage-only` maps to `{stageOnly: true}`. A NEW `enkaku dev <entry.ts>` command bundles locally (the same `buildEntry()` `publish` uses, now shared), pushes to `POST /api/plugins/dev`, and watches its directory (`node:fs.watch`, recursive, debounced 150ms) for a re-push on every change; `--no-watch` for a one-shot push, `--name` to override the dev-slot name. `daemon.ts`'s plugin routes gained an optional `devOwnerFromRequest` reading a new `x-enkaku-dev-owner` header (`user@host`, set by the CLI) so the Plugins page can show who actually owns a dev slot rather than falling back to a bare user id. `packages/sdk/src/cli/publish.test.ts` spawns the REAL CLI as a subprocess (`Bun.spawn`, mirroring `child-entry.test.ts`'s own "spawn the real thing" philosophy — bundling a fixture that imports `@enkaku/sdk` from INSIDE the same `bun test` process that is compiling this very package hits a real Bun quirk, "Unseekable reading file" on `zod`'s module, that a genuine separate process does not) against a real `Bun.serve` fake farm: a plugin entry posts to `/api/plugins`, a script entry still posts to `/api/scripts` unchanged, `--stage-only` is threaded through, a failed verify exits non-zero with the error printed, and `enkaku dev --no-watch` posts to `/api/plugins/dev`; a `defineScript` entry given to `enkaku dev` is refused by name, pointing at `enkaku publish` instead.
>
> **(5) Studio (criteria 11's UI half, 29, 30, and step 13's rest) — no Studio UI shipped last pass; all of it shipped this pass.** New `/plugins` page (`packages/studio/src/app/plugins/page.tsx`): failed plugins sort first, a failed row shows its `verifyErrorCode`/`verifyError` VERBATIM plus which scripts were declared (`manifest.scripts`, newly persisted even on an `E_PLUGIN_NAME_CONFLICT` failure — previously discarded as `scripts: []`, now kept precisely so this page can say "N declared, 0 registered") versus registered (`scriptCount`); dev slots render with a DEV badge, owner, last-build result, and their shared kv namespace; "Reload all" calls `restart()`; per-row Activate/Rollback/Reload/Remove. `AppShell`'s sidebar gained a "Plugins" nav entry whose count badge is a WARNING (danger tone + `role="status"`, not the neutral grey every other badge uses) while any plugin is `status: 'failed'` — the badge already links to `/plugins`, so it IS the farm-health warning (criterion 30), not a second component elsewhere. The Scripts page gained a Plugin column and an origin filter (All/Standalone/Plugin), derived CLIENT-SIDE from the `<plugin>/<script>` naming rule (§4.2) rather than a core change — `scripts/routes.ts` stays untouched, exactly as the first pass's own reasoning said it should. `RunScriptDialog` now groups its script picker by plugin (`SelectGroup`/`SelectLabel`, consecutive-run bucketing over the already-alphabetical list) and marks a dev entry with a `DEV` chip; the device page merges `GET /api/plugins/dev` into its script list so a dev script is pickable there (an ad-hoc run, per §3.5's own carve-out) — the Scripts page's own dialog usage (a single pre-chosen script) needs no grouping. New `packages/protocol/src/api/plugins.ts`/`kv.ts` declare every schema these calls use (Plan 72's rule: every Studio `api()` call takes one), verified against the REAL routes in `packages/core/src/api/plugins-kv-protocol.test.ts` (not a mocked fetch) — including the one real wire-format wrinkle found and documented rather than silently "fixed": `api/plugins.ts` sends `createdAt`/`verifiedAt` as ISO strings (`Date` through bare `c.json()`), not the unix-seconds numbers every other route's `typedJson` produces. Every new page/component has a render test covering loaded, loading, and error (`plugins/page.test.tsx`, `AppShell.test.tsx`, `RunScriptDialog.test.tsx`'s new grouping describe block, `scripts/page.test.tsx`'s new Plugin-column/filter tests).
>
> **(6) Plan 79 §5.9's KV panel (also shipped this pass — see plan 79's own status).** `packages/studio/src/components/kv/KvPanel.tsx`, mounted on the device page's new "Storage" tab (device scope, keyed on `stableId` not the row id) and Settings' new "Key/Value store" section (global scope) — see plan 79 for the detail; noted here because it shares this pass's `plugins.ts`/`kv.ts` protocol work and its own render tests.
>
> `bun run typecheck` is OK across all 12 packages. Root `bun test` is 2438 pass / 0 fail (baseline 2420 + 18 net new: `jobs/plugin-execution.integration.test.ts` (3), `jobs/executors/script.test.ts` (3), `plugins/auto-rebuild.test.ts` (3), `api/plugins-kv-protocol.test.ts` (3), `sdk/cli/publish.test.ts` (6)). `packages/studio` is 352 pass / 0 fail (baseline 334 + 18 net new). `scripts/check-harness-provenance.sh` and `scripts/check-plan-status.sh` both exit 0.
>
> **Not done, and why — one item only, everything else the first pass listed is closed above:** a real `createDaemon().start()` boot test (criteria 20, 21, 24's own wording, and 26's "counts" half) asserting `/api/health` answers beside a deliberately broken plugin fixture. The GUARANTEE itself (`PluginRuntime`/`verify-child.ts` structurally never throwing into the core process — §3.8) is tested thoroughly at the component level (`runtime.test.ts`'s fault-isolation describe block: a throwing bundle, a hanging one, a duplicate-id one, a name-conflict one, all recorded `failed` with nothing else disturbed) and is now ALSO proven live end-to-end for the ordinary case (a healthy plugin really runs, really surviving a `restart()` mid-job, per (1) above) — what remains unproven is specifically "the core process itself keeps accepting HTTP requests while a plugin fails to boot," which needs a real `createDaemon()` (adb toolchain discovery and all) that no test in this codebase has attempted yet even for unrelated failure modes. Judged out of scope for this pass's assigned priorities (execution wiring, the KV panel, and the Studio surface) rather than attempted and cut.
> Ships: packages/core/src/plugins/runtime.ts
> Depends on: Plan 62 (`scripts/resolve.ts` — reference resolution and pinning), Plan 64 (`scripts/build.ts` and the workspace store — the server-side bundler, its import allowlist, and the dev source of truth), Plan 79 (the KV namespace a plugin owns).

---

## 1. Goals

- One TypeScript project — an `index.ts` calling `definePlugin` — publishes **many** scripts that share helpers, types, and constants by ordinary import.
- One bundle per plugin instead of one per script.
- **One registry** answers "what scripts exist" and "resolve this reference" for every consumer — the Scripts page, Run a script, jobs, schedules, triggers, agent capabilities — regardless of where the script came from.
- A plugin under development loads **without being published**, rebuilds when its source changes, and its scripts are runnable immediately.
- A broken plugin never becomes active, and **never stops the farm from starting or running anything else**.
- An operator can see every plugin, whether it registered, what failed, and can reload or restart it without restarting the core.
- Publishing a new version does not change what an already-queued job runs.

## 2. Non-goals

- A new execution path. A plugin's scripts run through the existing executor, runner, and bundle cache (§3.1).
- Plugins that contribute anything other than scripts. No hooks, no middleware, no services.
- Dependency resolution between plugins. A plugin is self-contained.
- Replacing `defineScript`. A standalone script keeps working exactly as it does today.
- Anything to do with `agent/plugins/` (§3.8).
- Scheduling a dev script (§3.6) — a schedule must pin, and a dev reference cannot be pinned.

## 3. Context and design decisions

### 3.1 The decision the rest of the plan follows from

A plugin is a **grouping and build** concept, not an execution concept. Publishing a plugin writes one `plugins` row and **N ordinary `scripts` rows**, one per script it defines, each pointing at the same bundle blob.

The alternative — a plugin as a first-class runtime entity that jobs reference — would require touching the executor, the bundle cache, `jobs.scriptId`, batches, schedules, and the pinning rules, all of which work today and several of which were hard-won (plan 62's ref pinning, plan 36's rebind, plan 20's batch sequencing). None of that changes here. `jobs.scriptId` still points at a concrete script; a job still runs exactly the bytes it was enqueued against.

### 3.2 One bundle, N entries — and what it saves

Measured today, on this repo: a single published script bundle is **674.5 KB**, almost all of it inlined `zod` and `@enkaku/sdk`. A twenty-script TikTok pack published as twenty scripts is roughly **13 MB** in the `scripts.bundle` column, twenty copies of the same dependency graph, twenty cache entries, twenty publishes to keep in step.

As one plugin it is one bundle of roughly 700 KB plus the scripts' own code, one cache entry, one publish, one version.

The child process already `import()`s a bundle and reads `mod.default`. For a plugin bundle the default export is the plugin, so the child needs to know **which** script to take:

```ts
// packages/session/src/runner/child-entry.ts — the loader, after this plan
const mod = await import(bundlePath)
const def = mod.default
const script = isPlugin(def)
  ? def.scripts.find((s) => s.id === init.scriptExportId)
  : def                                    // a standalone bundle, exactly as before
```

`init.scriptExportId` comes from the registry entry. A pre-plan bundle has no `scripts` array, takes the second branch, and behaves identically — criterion 16.

### 3.3 `ScriptRegistry` — why it is a real component and not a rename

Today there is exactly **one** source of scripts: the `scripts` table. Consumers read it directly, and that is fine while there is one source.

Counted in this repo right now: **15 direct reads of the `scripts` table across 9 files** (`daemon.ts`, `scripts/routes.ts`, `scripts/service.ts`, `scripts/resolve.ts`, `queue/job-store.ts`, `api/topology.ts`, `jobs/executors/script.ts`, `jobs/executors/remote.ts`, a migration), and **8 call sites of `resolveScriptRef` across 6 files** (`daemon.ts`, `capability/context.ts`, `schedules/runner.ts`, `api/schedules.ts`, `api/jobs.ts`).

Dev loading (§3.5) introduces a **second** source: scripts that exist in memory, from a plugin that was never published. Without a registry, every one of those 23 call sites has to learn about it — and the ones that get missed do not fail loudly. They just do not see dev scripts. "Run a script" would not list it; the trigger path would not resolve it; the topology view would show it as unknown. Each of those is a separate bug, discovered separately, months apart.

So the registry is the merge point, and its existence is justified by there being two sources to merge, not by tidiness:

```ts
export type ScriptOrigin = 'standalone' | 'plugin' | 'dev'

export interface ScriptEntry {
  /** `scripts.id` for a persisted script; `dev:<plugin>/<script>` for a dev one. */
  id: string
  /** `login` for a standalone script, `tiktok/login` for a plugin member. */
  name: string
  version: string
  origin: ScriptOrigin
  pluginName: string | null
  /** The script's id INSIDE its plugin bundle; null for a standalone script. */
  exportId: string | null
  enabled: boolean
  paramsSchema: unknown
  /** Where the bundle comes from — the executor asks for this, never for a column. */
  bundle: { kind: 'db'; scriptId: string } | { kind: 'file'; path: string }
  /** A dev entry disappears when its session ends; a persisted one does not. */
  ephemeral: boolean
}

export interface ScriptRegistry {
  list(q: { name?: string; pluginName?: string; origin?: ScriptOrigin; limit: number; cursor?: string | null }): Page<ScriptEntry>
  /** Grouped by name, versions descending — what the Scripts page and Run a script need. */
  groups(q?: { pluginName?: string }): ScriptGroup[]
  get(id: string): ScriptEntry | null
  /** Replaces every `resolveScriptRef` call site. Same four errors, plus `script_is_dev`. */
  resolve(ref: ScriptRef, opts?: { allowDev?: boolean }): ScriptEntry
  /** Materialise the bundle to a path the child can import. */
  bundlePath(entry: ScriptEntry): Promise<string>
  /** Drop cached state for one plugin, or all of it. */
  invalidate(pluginName?: string): void
}
```

**`resolveScriptRef` keeps its body and its four errors.** The registry calls it for the persisted half and merges the dev half on top; it does not reimplement semver ordering, prerelease exclusion, or the disabled rule. Rewriting that is exactly the kind of subtle regression this plan is trying not to introduce, and plan 62 already paid for getting it right.

The migration is mechanical and each step is separately testable: the 8 `resolveScriptRef` call sites take `registry.resolve` instead (they already receive it injected in most cases — `api/jobs.ts` and `capability/context.ts` take it as a dependency function today). The 15 table reads split into three groups: listing (`scripts/service.ts`, `scripts/routes.ts`) → `list`/`groups`; single lookup by id (`daemon.ts`, `job-store.ts`, `api/topology.ts`, both executors) → `get`; and the migration file, which stays on raw SQL because a migration must not depend on a runtime.

### 3.4 A job's script name is denormalised onto the job

`JobStore.scriptNames()` resolves a job's script name by looking up `jobs.scriptId` in the table. A dev script has no row, so every job it ran would list as an unknown script the moment the dev session ended.

The same hole already exists for a deleted published script, quietly: delete a script and its old jobs lose their names.

So `jobs` gains `script_name` and `script_version`, filled at enqueue from the registry entry. Both nullable, so pre-existing rows keep reading (and keep resolving through `scriptNames()` as they do today). This is a small fix that closes an existing latent bug and is a precondition for dev jobs being honest.

### 3.5 Dev loading: one slot, two front-ends, no file watcher

A published-only pipeline means the TikTok pack author's loop stays `publish → run job → look`. That is the loop they have today, and making it faster is a stated reason for wanting plugins at all.

So a plugin may occupy a **dev slot**: at most one per plugin name, holding a built bundle plus its verification report, owned by a session, and **not** a `plugins` row version. Its scripts enter the registry with `origin: 'dev'` and `ephemeral: true`.

Two ways to fill the slot, one mechanism behind them:

**A — from the workspace.** Plan 64's `WorkspaceStore` already holds files in the database, with path validation, quotas, and compare-and-swap; `scripts/build.ts` already bundles from it under an import allowlist (`@enkaku/sdk`, `zod`, no `node:*`, no filesystem resolution, 30 s, 20 MiB). A dev plugin is a workspace directory with an `index.ts`.

**There is no file watcher.** Every workspace write goes through the store, so the store itself signals the change — the rebuild is triggered by the write, not discovered by polling. That is exact rather than eventually-consistent, and it is one of the reasons to prefer the workspace path.

**B — from the author's machine.** `enkaku dev <entry.ts> --farm <url>` bundles locally with `Bun.build` (the same code `publish` uses), pushes to `POST /api/plugins/dev`, and re-pushes on every change. The farm holds the bundle in the slot. The session ends when the CLI disconnects or after an idle TTL (default 30 min), and the slot is released.

Both paths land in the same slot and go through the same verification (§3.7). The CLI's local build is a fast feedback loop for the author, not a trust boundary — the farm verifies what it was given, exactly as it does for a publish.

**Hot reload is slot replacement.** A new build overwrites the slot; the registry is invalidated for that plugin; the next job resolves the new entry. There is nothing to unload, because — as §3.9 explains — nothing was ever loaded into the core.

Guard rails, because a dev slot is unreviewed code that is nonetheless runnable:

- Dev slots require the same permission as publishing.
- A dev script may be **run manually and triggered** (plan 81), but may **not** be the target of a schedule or a batch: those pin a reference and must survive a laptop closing. `resolve()` refuses a dev entry unless the caller passes `allowDev: true`, which only the ad-hoc run and trigger paths do.
- A dev entry never shadows a published one silently. When both `tiktok/login@1.0.0` exist, the dev entry wins **and the job log says so on its first line**, along with the session that owns it. A run that silently used unreviewed code would be the worst outcome this plan could produce.

### 3.6 Versions, dev and published

Inside a plugin, a script does not carry its own version — `definePlugin({ version })` stamps every member. Two scripts in one bundle claiming different versions would be unverifiable: same bytes, same instant, same source tree.

`ScriptDefinition.version` therefore becomes optional. `defineScript` still validates it as semver when present; publishing a standalone script without one is an error naming the field; a member declaring a version different from its plugin's is a publish error, not a silent overwrite.

A dev slot's version is whatever its source declares, suffixed `+dev.<n>` where `n` increments per rebuild — so a job's recorded version says exactly which build ran, and no dev build can ever be mistaken for a released one.

### 3.7 Staged, verified, then activated — in a child, never in the core

One bundle holding twenty scripts means one syntax error can take out twenty scripts. Today that risk is per-script and self-limiting; here it is not.

1. **Staged.** The bundle is stored, the row is written `status: 'staged'`, nothing resolves to it.
2. **Verified.** A throwaway child process — the same isolation a job uses — imports the bundle and reports: the plugin id and version, every script id, and every params schema. The parent checks ids are unique, match `[a-z0-9][a-z0-9-]*`, every schema converts to JSON Schema, and the declared version matches. Verification is bounded (15 s, and the child is killed if it exceeds it).
3. **Activated.** Only then, and only by an explicit call.

The import happens **in a child**, never in the core's process, for the same reason `scripts/build.ts` refuses to execute what it bundles: a publish must not be able to run code in the core.

### 3.8 A failing plugin fails alone — the opposite of the agent registry, deliberately

`packages/core/src/agent/plugins/index.ts` merges its ten plugins **fail-fast at module load**: a duplicate capability id throws at boot. That is right for first-party code compiled into the binary — the error is a bug, and a farm that boots with a broken tool registry is worse than one that does not boot.

It would be catastrophic here. These plugins are user-supplied. One malformed TikTok pack must not stop a farm from starting, or stop the other nineteen plugins, or stop standalone scripts.

So the rule is inverted and stated as a guarantee:

> **Assembling the script registry never throws.** A plugin that fails to build, fails to verify, declares duplicate ids, or throws on import is recorded `failed` with its error, contributes zero scripts, and changes nothing about any other plugin or any standalone script.

That is enforced structurally, not by discipline:

- Plugin code is never imported into the core process — only into a verification child or a job child. A `throw` at module scope, an infinite loop, or an OOM kills that child and is reported as a verification failure.
- Registry assembly wraps each plugin individually; a `failed` plugin is skipped.
- Two plugins claiming the same script name is a **conflict**, not a crash: the already-active one keeps the name, the newcomer is `failed` with `E_PLUGIN_NAME_CONFLICT` naming both.
- Boot never blocks on verification. Plugins verify asynchronously after the HTTP server is listening; until a plugin is verified its scripts are simply absent, and the Plugins page says `verifying`.

**The name is `definePlugin`, and `defineAgentPlugin` keeps its own — decided, not deferred.** They live in different packages, serve different audiences, and never meet: `defineAgentPlugin` is core-internal, never exported from `@enkaku/sdk`, and a script author has no way to reach it; `definePlugin` is the public authoring API and is the only one that appears in `@enkaku/sdk`, in the guides, or in a plugin project's `index.ts`. Renaming ten finished files from plan 77 to remove an ambiguity that no user can encounter would be churn charged to first-party code for the benefit of nobody. The residual cost is documentation, so documentation is the fix: `docs/spec.md` gets a paragraph naming both and saying which is which, and each `defineAgentPlugin` file already carries the "agent" prefix in its own name.

### 3.9 Restart means re-derive, not tear down

There is no long-lived plugin instance in the core to restart — scripts run in a **separate child process per job** (crash containment). Nothing is loaded, so nothing needs unloading. What an operator actually needs is a way to make a `failed` plugin try again, and a way to rebuild the whole registry after something environmental went wrong.

| operation | what it does | effect on a running job |
|---|---|---|
| `reload(name)` | re-build (dev) or re-verify (published) one plugin, then re-register it | none — it holds its own bundle file |
| `restart()` | drop all caches, re-derive every plugin from the database and every dev slot, re-verify | none |
| `disable(name)` | its scripts stop resolving; queued jobs against them fail at claim with a named error | none |
| activating a new version | changes what `@latest` resolves to **for future enqueues only** | none |

The last row is the one that must not be lost. If activation changed what queued jobs run, then queueing 200 warmup jobs and pushing a fix would produce a run where some ran old and some ran new, with nothing in any log saying which. A queued job was pinned to a concrete entry at enqueue (plan 62, plan 81 §3.4) and keeps it.

`restart()` is an admin action on the Plugins page. It does not restart the core, does not drop connections, and does not touch jobs.

### 3.10 What a plugin owns beyond its scripts

- **The KV namespace** (plan 79 §3.2) — a plugin's scripts share one, which is what lets a login script's session be read by a warmup script in the same pack. **A dev slot uses the same namespace as its published counterpart**, so developing against real stored state works; the Plugins page says so, because it also means a dev run can overwrite production state.
- **A default `reset.packages`**, merged with each script's own.

Removing a plugin does not delete its KV values by default — a pack removed and reinstalled should find its sessions. The confirmation offers it, with the count.

## 4. Technical design

### 4.1 SDK

```ts
export interface PluginDefinition {
  id: string                       // `[a-z0-9][a-z0-9-]*` — the KV namespace and half of every script ref
  version: string                  // semver; stamped onto every member (§3.6)
  title?: string
  description?: string
  scripts: ScriptDefinition[]
  reset?: { packages?: string[] }
}

export function definePlugin(def: PluginDefinition): PluginDefinition
```

Validates id shape, semver, at least one script, unique script ids, no conflicting member version; stamps `version`. Throws on the author's machine, at import time.

```ts
// tiktok-pack/index.ts
import { definePlugin } from '@enkaku/sdk'
import { login } from './scripts/login'
import { switchAccount } from './scripts/switch-account'
import { warmup } from './scripts/warmup'

export default definePlugin({
  id: 'tiktok',
  version: '1.0.0',
  reset: { packages: ['com.zhiliaoapp.musically'] },
  scripts: [login, switchAccount, warmup],
})
```

`./lib/omnibox.ts` and friends are ordinary relative imports shared by all three — the entire point of the feature.

### 4.2 Schema

```ts
export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),                    // `tiktok` — stable across versions
  version: text('version').notNull(),
  title: text('title'),
  description: text('description'),
  bundle: text('bundle').notNull(),
  source: text('source'),
  bundleHash: text('bundle_hash').notNull(),       // sha256 — what the cache keys on
  /** staged | verifying | active | superseded | failed | disabled (§3.7, §3.8). */
  status: text('status').notNull().default('staged'),
  verifiedAt: integer('verified_at', { mode: 'timestamp' }),
  /** Human-readable, verbatim from the verification child. Shown in the UI (§4.6). */
  verifyError: text('verify_error'),
  verifyErrorCode: text('verify_error_code'),
  /** What the bundle declared: script ids and their schemas. Null until verified. */
  manifest: text('manifest', { mode: 'json' }),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [
  uniqueIndex('idx_plugins_name_version').on(t.name, t.version),
  index('idx_plugins_status').on(t.name, t.status),
])
```

On `scripts`: `pluginId` and `exportId`, both nullable.
On `jobs`: `scriptName` and `scriptVersion`, both nullable (§3.4).

A plugin's scripts are written with `name = '<plugin>/<script>'` — `tiktok/login` — so `scripts/resolve.ts` works on them unmodified: `tiktok/login@1.0.0`, `@latest`, the four distinct failures, the prerelease and disabled rules.

Dev slots are **not** rows. They live in `plugins/dev-slots.ts` in memory, because a dev build must not survive a core restart — an operator restarting the farm should get the published state back, not a half-finished pack from yesterday.

### 4.3 `packages/core/src/plugins/runtime.ts`

```ts
export interface PluginRuntime {
  list(q): Page<PluginView>                        // includes dev slots, marked
  get(name: string, version: string): PluginRow | null
  active(name: string): PluginRow | null

  stage(input: { name; version; bundle; source?; createdBy }): PluginRow
  verify(pluginId: string): Promise<VerifyReport>  // in a child; never throws into the core
  /** One transaction: supersede the previous active, write this version's `scripts` rows, mark active. */
  activate(pluginId: string, expectedStatus: 'staged'): PluginRow
  rollback(name: string, toVersion: string): PluginRow
  disable(name: string): void
  remove(name: string, version: string, opts: { deleteKv: boolean }): RemovalSummary

  // Dev (§3.5)
  putDevSlot(input: { name; bundle; source?; owner: DevSessionOwner }): Promise<VerifyReport>
  dropDevSlot(name: string): void
  devSlots(): DevSlotView[]

  // Restart (§3.9)
  reload(name: string): Promise<VerifyReport>
  restart(): Promise<{ ok: number; failed: number }>
}
```

`activate` takes `expectedStatus` as a compare-and-swap guard, so two concurrent activations cannot interleave. **Rollback works without re-publishing**, because the older version's bundle is still in its own row — the concrete benefit of storing the bundle per plugin version.

### 4.4 What resolves

| status | `@latest` | a pinned ref |
|---|---|---|
| `staged` / `verifying` / `failed` | no | no |
| `active` | yes | yes |
| `superseded` | no | **yes** |
| `disabled` | no | no |
| dev slot | yes, and wins over `active` — logged (§3.5) | yes, with `allowDev` |

`superseded` resolving a pinned reference is what keeps queued jobs correct.

### 4.5 The bundle cache

`materializeBundle` is keyed on `(script.id, script.version, sha256(bundle)[0:12])`, so twenty scripts sharing one bundle would write twenty identical 700 KB files. Re-key on the **content hash alone** — `<sha256>.mjs` — which it already computes. One file per distinct bundle. A dev slot writes its bundle to the same cache, so the child import path is identical for dev and published.

### 4.6 UI — the Plugins page

A plugin that fails must be findable without reading a log file. `/plugins`:

- **List**: name, version, a status badge (`active` / `dev` / `verifying` / `failed` / `disabled` / `superseded`), script count, last verified, and the first line of the error when failed. Failed plugins sort first — the page's job is to surface what is wrong.
- **Detail**: every script the plugin registered, with its params schema; the verify error **verbatim**, with its code; the version list with Activate / Rollback per row; actions Reload, Disable, Remove.
- **A partially-registered plugin is shown as such**: which scripts registered and which did not, rather than a single red badge that hides that eighteen of twenty are fine.
- **Dev slots** carry a `DEV` badge, their owner (workspace path, or the `enkaku dev` session and host), the last rebuild time and result, and an explicit note that they share the published plugin's KV namespace (§3.10).
- **Reload all** performs `restart()` and reports `ok`/`failed` counts.
- A farm-health warning when any plugin is `failed`, linking here — so it is visible from the dashboard without going looking.

Elsewhere: the Scripts page gains a **Plugin** column and an origin filter; `RunScriptDialog` groups scripts by plugin and marks dev entries.

## 5. Implementation steps

1. `PluginDefinition` / `definePlugin` in `@enkaku/sdk`; `ScriptDefinition.version` becomes optional.
2. `plugins` table; `plugin_id`/`export_id` on `scripts`; `script_name`/`script_version` on `jobs`; migration.
3. `scripts/registry.ts` — `ScriptRegistry` over the table plus dev slots, delegating to `resolveScriptRef`.
4. Migrate the 8 `resolveScriptRef` call sites and the 15 table reads (§3.3), one file per commit.
5. `plugins/runtime.ts` — stage, verify, activate, rollback, disable, remove, reload, restart.
6. `plugins/verify-child.ts` — the bounded throwaway importer.
7. `plugins/dev-slots.ts` — the in-memory slot, TTL, owner tracking.
8. `child-entry.ts` — select by `scriptExportId`, standalone branch untouched.
9. `bundle-cache.ts` — re-key on content hash.
10. Workspace-backed dev: rebuild on `WorkspaceStore` write under a registered plugin directory.
11. `api/plugins.ts` — CRUD, activate, rollback, reload, restart, dev slot; audit actions `plugin.publish` / `.activate` / `.rollback` / `.reload` / `.delete` / `.dev`.
12. `publish.ts` — detect a plugin entry; `--stage-only`. New `enkaku dev` command.
13. Studio: the Plugins page (§4.6); Plugin column and origin filter on Scripts; `RunScriptDialog` grouping. Plus the `docs/spec.md` paragraph distinguishing `definePlugin` from `defineAgentPlugin` (§3.8).

## 6. Acceptance criteria

**Plugins and bundling**
1. A plugin with three scripts publishes as one `plugins` row, one bundle, and three `scripts` rows named `<plugin>/<script>`.
2. All three import a shared `./lib/` helper, and the helper appears once in the bundle.
3. A job on `tiktok/login@1.0.0` runs the right script out of the shared bundle.
4. Twenty scripts sharing one bundle produce **one** file in the bundle cache.
5. A plugin's `reset.packages` reaches the runner merged with each script's own.

**Pinning and versions**
6. Publishing and activating `1.1.0` does not change what an already-queued `1.0.0` job runs — asserted by queueing, activating, then letting it run.
7. `tiktok/login@latest` resolves to the active version, and to nothing while only `staged` versions exist.
8. Rollback to a previous version works without re-publishing and without any bundle upload.
9. `activate` called twice concurrently results in exactly one active version.
10. A member declaring a version different from the plugin's is refused, naming it.

**The registry**
11. `registry.groups()` returns standalone, plugin, and dev scripts together, and `RunScriptDialog` lists all three.
12. `registry.resolve()` refuses a dev entry by default and returns it with `allowDev: true`.
13. A job that ran a dev script still shows its script name **after the dev slot is dropped** (§3.4).
14. Every one of the 8 former `resolveScriptRef` call sites resolves plugin scripts — asserted per call site, not once.

**Dev loading and hot reload**
15. A plugin in the workspace is runnable **without publishing**; editing a shared helper and running again uses the new code, with no publish and no core restart.
16. A dev entry shadowing a published one logs which was used, with the owning session, on the job's first log line.
17. Dropping a dev slot makes its scripts vanish from `list`, `groups`, and `resolve`.
18. A dev slot is refused as a schedule target with a named error.
19. Dev slots do not survive a core restart.

**Fault isolation — the guarantee in §3.8**
20. A plugin whose bundle throws on import is recorded `failed` with its error, and **the core keeps running**; standalone scripts and other plugins still list, resolve, and run.
21. A plugin that never returns from module scope is killed at the verification timeout and recorded `failed`; the core is unaffected.
22. A plugin declaring two scripts with the same id is refused at publish, naming both.
23. Two plugins claiming the same script name: the active one keeps it, the newcomer is `failed` with `E_PLUGIN_NAME_CONFLICT` naming both, and **neither the core nor the first plugin is disturbed**.
24. The core **boots** with a `failed` plugin present, serves `/api/health`, and lists its other scripts.
25. `reload(name)` on a `failed` plugin whose bundle has since been fixed brings it to `active` without a core restart.
26. `restart()` re-derives every plugin, reports `ok`/`failed` counts, and does not disturb a running job.

**Compatibility**
27. A script published before this plan resolves, runs, and caches — no re-publish needed.
28. Removing a plugin with `deleteKv: false` leaves its KV values; with `true`, deletes them and reports the count.

**UI**
29. The Plugins page shows a failed plugin, its verbatim error, and which of its scripts did and did not register.
30. A farm-health warning appears while any plugin is `failed` and links to the page.

## 7. Test plan

`plugins/runtime.test.ts` for staging, verification, the activation CAS (criterion 9 with real overlapping transactions), rollback, reload, and restart. `plugins/verify-child.test.ts` for a bundle that throws, one that hangs, one with duplicate ids, one healthy. `scripts/registry.test.ts` for the merge, dev shadowing, and `allowDev`.

Criteria 3, 4, 5, 6, 15, 16, 19 and 27 need the **real runner** with real bundles, not a stub — the design rests on the loader picking the right member and on pinning surviving an activation, and neither is provable at the store layer. Criterion 27 runs against a bundle built in today's format, kept as a fixture, so the compatibility claim is tested rather than asserted.

Criteria 20, 21, 23 and 24 are the fault-isolation guarantee and are tested by **booting a core** with deliberately broken plugin fixtures and asserting `/api/health` answers and unrelated scripts still resolve. A guarantee about not crashing cannot be tested by a unit test that never starts the thing.

Criterion 14 is a table-driven test over the call sites, so a future call site added without going through the registry fails it.

## 8. Risks and mitigations

- **One broken plugin takes out twenty scripts.** Mitigation: staged-then-verified in a child; partial registration shown per script in the UI.
- **A user plugin stops the farm.** The failure this plan most needs to prevent. Mitigation: §3.8's structural rules — never imported into the core, per-plugin isolation, async verification after listening — plus criteria 20–24 tested against a real boot.
- **Activation silently changes what runs.** Mitigation: `superseded` still resolves pinned refs; criterion 6 tests exactly that sequence.
- **A dev slot silently runs unreviewed code in production.** Mitigation: dev requires publish permission, is logged on the job's first line with its owner, is refused for schedules and batches, is visible on the Plugins page, and does not survive a restart.
- **A dev run corrupts production KV.** Real, and not fully mitigated: the shared namespace is what makes dev useful. Mitigation is disclosure — the Plugins page states it — plus open question 3.
- **The registry migration misses a call site.** Mitigation: criterion 14 is table-driven over all 8; the table reads are migrated one file per commit.
- **Two things called "plugin".** Settled in §3.8: both names stay, because the two never meet — `defineAgentPlugin` is core-internal and unreachable from a script. Mitigation: a paragraph in `docs/spec.md` naming both, and step 13 adds it.

## 9. Open questions

*(Naming was open question 1 and is now decided — `definePlugin`, with `defineAgentPlugin` unchanged. Recorded in §3.8 rather than deleted, so the reasoning survives the decision.)*

1. **Per-script versions inside a plugin.** Ruled out in §3.6 as unverifiable. Rollback already covers the case that motivates it.
2. **A dev KV namespace.** Sharing production state is what makes dev useful and is also how a dev run overwrites a real session. A `--kv-isolate` flag giving the dev slot its own namespace is the obvious answer; deferred until someone has been bitten, because guessing which default they want is how it gets the wrong one.
3. **Plugins contributing more than scripts.** No caller exists; the shape would be guessed.
4. **Cross-plugin KV grants.** Inherited from plan 79 open question 1; this plan makes it likelier to be wanted.
