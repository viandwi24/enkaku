# Scripts and Plugins — how the subsystem actually works

> An as-built analysis, read off the code on `main` (2026-08-17), not a plan. Where the code and a
> plan disagree, this document follows the code and says so. Plans 62, 64, 79, 80, 81, 82, 94, 95,
> 97, 98 and 99 are the design record; `docs/archive/spec-prototype.md` §11 was the product statement; the MVP spec covers it in `docs/spec.md` §4.4 to §4.6 and §10.

---

## 1. Vocabulary — two unrelated things called "plugin"

| term | package | who authors it | what it is |
|---|---|---|---|
| `definePlugin` | `@enkaku/sdk` (public) | a script author, in their own repo | **the subject of this document** — one TypeScript project that publishes N scripts as one bundle |
| `defineAgentPlugin` | `packages/core/src/agent/plugins/` (core-internal) | an Enkaku contributor | grouping of the AI agent's own built-in capabilities into named system-prompt sections; compiled into the binary |

They never meet. `defineAgentPlugin` is never exported from `@enkaku/sdk`, so a script author has no
way to reach it; `definePlugin` never appears in the agent code. The two registries even have
**opposite failure policies**, deliberately:

- `agent/plugins/index.ts` merges **fail-fast at module load** — a duplicate capability id throws at
  boot. Right for first-party code compiled into the binary.
- `plugins/runtime.ts` **never throws because a plugin is broken** — a bad plugin is recorded
  `failed`, contributes zero scripts, and changes nothing about any other plugin. Right for
  user-supplied code (§8).

Everything below is about the first row unless it says otherwise.

Related-but-distinct concepts sharing the `scripts` table:

- **workflow** (`scripts.kind = 'workflow'`, plan 99) — the `bundle` column holds a `WorkflowDoc`
  JSON instead of ESM; a different executor runs it, but it resolves through the same registry.
- **action recording** (plan 94) — a workspace `.recording.json` that *compiles* to an ordinary
  `defineRecording` entry and publishes as a plain `kind: 'script'` row. There is no third artefact
  type.

---

## 2. The one decision the rest follows from

> **A plugin is a grouping and build concept, not an execution concept.**

Publishing a plugin writes **one `plugins` row** and **N ordinary `scripts` rows**, one per member,
all pointing at the *same* bundle text. Nothing about the queue, the lease, the executor, the runner,
job pinning, batches, or schedules learns what a plugin is. `jobs.scriptId` still points at a
concrete script entry, and a queued job still runs exactly the bytes it was enqueued against.

Two consequences that carry the whole design:

1. **One bundle, N entries.** A single published script bundle measures ~674 KB, almost all of it
   inlined `zod` + `@enkaku/sdk`. Twenty scripts published individually ≈ 13 MB of duplicated
   dependency graph. As one plugin it is ~700 KB plus the members' own code — one bundle, one cache
   file, one publish, one version.
2. **The child needs to know *which* member to run.** That is `ENKAKU_SCRIPT_EXPORT_ID` (§7).

---

## 3. Files and layout

### 3.1 Authoring side — `packages/sdk`

```
packages/sdk/src/
  plugin.ts            definePlugin(), isPlugin(), PluginMemberScript, Plugin
  define-recording.ts  defineRecording() — the compiled form of an action recording
  runtime-fold.ts      folds deprecated timeout/retries into `runtime` (plan 98)
  types.ts             ScriptDefinition, ScriptContext, DeviceApi, KvApi, JobsApi …
  index.ts             the public surface (definePlugin + isPlugin are exported here)
  cli/
    index.ts           `enkaku init` / `publish` / `dev` argument parsing
    init.ts            init() — scaffolds a publishable one-member plugin project
    publish.ts         buildEntry(), publishPlugin(), NOT_A_PLUGIN_MESSAGE
    dev.ts             devCommand() — local build + push + fs.watch loop

There is no `define-script.ts`. Plan 110 (§3.1, decision A, answered **Hard**) removed
`defineScript` outright: a script cannot exist outside a plugin, so the only authoring entry point
is `definePlugin` and the only script shape an author writes is a `PluginMemberScript`.
```

### 3.2 Farm side — `packages/core`

```
packages/core/src/
  plugins/
    runtime.ts             PluginRuntime — stage/verify/activate/rollback/disable/remove
                           /reload/restart + dev-slot lifecycle. THE guarantee lives here.
    verify-child.ts        spawns the bounded (15s) verification child, re-validates its report
    verify-child-entry.ts  the child itself: imports the bundle, reports id/version/members
    dev-slots.ts           in-memory dev-slot store (never a DB row — that is the feature)
    auto-rebuild.ts        withAutoRebuild(WorkspaceStore) — "the store is the file watcher"
    seed-embedded.ts       stages packs carried inside a compiled binary, once, never activates
  scripts/
    registry.ts        ScriptRegistry — the merge point (DB rows + dev slots). §6
    resolve.ts         resolveScriptRef() — semver/@latest/enabled rules (plan 62, untouched)
    service.ts         publishScript(), listScriptGroups(), parseScriptRuntime()
    routes.ts          /api/scripts CRUD + param-sets
    build.ts           buildScriptFromWorkspace() — server-side bundler + import allowlist
    bundle-cache.ts    materializeBundle(Text) — content-addressed sha256 file cache
    param-sets.ts      named parameter presets, keyed on script NAME
  api/plugins.ts       /api/plugins routes
  jobs/executors/
    script.ts          the local script executor
    remote.ts          the same, for a node-owned device
    workflow.ts        the workflow executor (also threads scriptExportId per node)
  capability/script.ts script.list / script.get / script.publish for the agent + MCP
  db/schema.ts         `plugins` (:1770), `scripts` (:827), `script_param_sets` (:932)
  embedded.ts          EmbeddedPack registry for `bun build --compile` assets
  index.ts             dispatches `--job-child` and `--plugin-verify` re-execs
```

### 3.3 Execution side — `packages/session`

```
packages/session/src/runner/
  job-runner.ts   spawns the child, owns timeouts/retries/abort, resolves the kv namespace
  isolation.ts    the spawn shapes (dev: `bun child-entry.ts`, compiled: `<bin> --job-child`)
  child-entry.ts  THE loader: import(bundle) → isPluginBundle? → pick member by exportId
  ipc.ts          the parent↔child message schemas (`ready` carries `pluginId`)
  kv-client.ts / jobs-client.ts   ctx.kv and ctx.jobs over IPC
```

### 3.4 Shipped packs and examples

```
plugins/tiktok-automation-pack/   product — embedded in the release binary, typechecked, CI-tested
plugins/networking/               product — same
examples/*.ts                     reference material an author reads and copies (NOT embedded)
scripts/build-packs.ts            bundles plugins/* → packages/core/packs/<id>.mjs + index.json
```

The `plugins/` vs `examples/` split is not tidiness: a pack listed in `PACK_ENTRIES` ships in every
download and is staged on first boot, so it carries a `package.json` and its own CI invocation.

### 3.5 Studio

```
packages/studio/src/app/plugins/page.tsx    the Plugins screen (failed-first)
packages/studio/src/app/scripts/page.tsx    a redirect to /plugins, query intact
packages/studio/src/app/scripts/detail/…    version picker, source preview, param sets
packages/studio/src/app/workspace/…         the in-browser authoring workspace
packages/studio/src/components/RunScriptDialog.tsx  picker grouped by plugin, DEV chip
packages/protocol/src/api/plugins.ts        the wire schemas every one of those api() calls uses
```

---

## 4. The authoring API

### 4.1 A script cannot exist outside a plugin

Plan 110 §3.1 (decision A, answered **Hard**) removed `defineScript`. A script is authored as a
member of a plugin and nothing else:

```ts
// one element of definePlugin's `scripts` array — a PluginMemberScript
{
  id: 'post-content',            // required; unique within the plugin
  title: 'Post content',         // optional, surfaced by the farm
  description: '…',              // optional, surfaced by the farm
  params: z.object({ … }),       // required, a Zod schema
  result: z.object({ ok: z.boolean() }),   // optional (plan 97)
  runtime: { timeoutMs, retries, maxRssBytes, maxConcurrent, sdk },  // optional (plan 98)
  async prepare(ctx) {}, async run(ctx) {}, async finish(ctx) {},
}
```

`version` is the plugin's, never a member's (§4.2). `enkaku publish` refuses an entry whose default
export is not a `definePlugin()` result, printing the wrapper; `enkaku init <name>` scaffolds a
one-member project that publishes with no edits. Still no side effects: shape validation, a
`timeout`/`retries` → `runtime` fold, and `Object.freeze`. Everything else (phases, timeouts,
retries, isolation) belongs to the core's runner, so a plugin published with an older SDK keeps
working on a newer core.

### 4.2 `definePlugin` — many members, one bundle, optionally one service

```ts
export default definePlugin({
  id: 'tiktok',                  // [a-z0-9][a-z0-9-]* — this is ALSO the KV namespace
  version: '1.9.0',              // stamped onto every member
  title, description,
  reset: { packages: ['com.ss.android.ugc.trill'] },   // merged with each member's own
  scripts: [switchAccount, searchFollow, listAccounts, postVideo, enqueueVideo, autoScroll],  // PluginMemberScript[]
  // OPTIONAL (plan 109 §4.2) — a long-lived handler that runs inside the core process for as long
  // as the plugin is active. `permissions` is what a script's own `ctx.farm.call(...)` (§4.3) is
  // allowed to reach, and what the operator is shown and consents to at install.
  service: defineService({ permissions: ['fs.read', 'job.run', 'device.list'], setup(ctx) { /* … */ } }),
  // OPTIONAL (plan 108 §3.2) — the Studio screen(s) this plugin contributes; see `@enkaku/sdk`'s
  // own README, "A plugin can own a screen — `surface`".
  surface: { nav: [/* … */], views: { /* … */ }, actions: { /* … */ } },
})
```

Both `service` and `surface` are additive: a plugin that declares neither is exactly the plugin
this section already described. This example is the real, current shape of
`plugins/tiktok-automation-pack/src/index.ts` — plan 113 (M78) added `postVideo`, `enqueueVideo`,
the `service` block, and its `content` view; the other four members and the `accounts` view predate
it (plan 86, plan 108).

Validated at import time, on the author's machine: id shape, semver, non-empty `scripts`, unique
member ids, `run` is a function, `params`/`result` are Zod schemas, and a member declaring its own
`version` must match the plugin's exactly. Each member gets the `timeout`/`retries` → `runtime` fold
— `definePlugin` is the *only* place that fold happens for any script at all.

`PluginMemberScript` = `Omit<ScriptDefinition, 'version'> & { version?: string; title?; description? }`.
A member does not carry its own version — two scripts in one bundle claiming different versions would
be unverifiable (same bytes, same instant, same source tree).

`isPlugin(def)` — `Array.isArray(def.scripts)` — is the single structural test, used by the CLI, the
verify child, and `child-entry.ts`'s loader. One definition of "is this a plugin", not three.

**Known limitation:** a member's `title`/`description` are typed and both shipped packs write them,
but the verify child reports only `{ id, paramsSchema, resultSchema, runtime }` per member, so they
never leave the bundle. Plugin-level `title`/`description` *do* reach the `plugins` row.

### 4.3 `ScriptContext` — what a script can reach

Since plan 109 step 109.1, `ScriptContext` **extends `PluginContext`** (`packages/sdk/src/types.ts`)
rather than re-declaring its own `log`/`kv` — a plugin helper typed `(ctx: PluginContext) => …`
therefore accepts a script's context by construction, not by two interfaces being kept in step by
hand. Its own members: `device`, `params` (already `params.parse`d), `artifact`, `job`, `error`
(finish-after-failure only), `kv` (`device` + `global`), `jobs` (the queue on its own device — plan
80/81), `onAssist` (plan 91), `progress` (plan 97 — coalesced, never persisted, never a result).
Inherited from `PluginContext` (`packages/sdk/src/runtime.ts`): `storage` (`device`/`global`/
`forDevice(id)` — the *same* KV store `kv` above exposes, under plan 79's older name; both names
work and neither is going away, because a bundle already published against `ctx.kv` cannot be
rewritten), `log`, and **`farm`** — the capability broker (plan 109 §3.1, §4.3) a script reaches
through `ctx.farm.call(capability, input, outputSchema)`. A call is refused *before* it runs
(`E_FARM_UNDECLARED`) unless the OWNING PLUGIN named that capability in its own
`defineService({ permissions })` (§4.2) — and refused again, live, if the publishing user's role
does not hold it (C4/C5 in plan 113's own evidence section). `plugins/tiktok-automation-pack/src/
captions.ts`'s `readCaptionsFile` is a real, worked example: `ctx.farm.call('fs.read', { path }, …)`,
behind `permissions: ['fs.read', 'job.run', 'device.list']` on the pack's own `service`.

---

## 5. Data model

### 5.1 `plugins` (schema.ts:1770)

| column | notes |
|---|---|
| `id` | uuid |
| `name`, `version` | `(name, version)` unique; `name` alone is not |
| `title`, `description` | filled from the verify report |
| `bundle` | the single bundle every member row points at |
| `source` | entry-file source, or `'bundled'` for an embedded pack |
| `bundle_hash` | sha256 of `bundle` — what the file cache keys on |
| `status` | `staged \| verifying \| active \| superseded \| failed \| disabled` |
| `verified_at`, `verify_error`, `verify_error_code` | verbatim from the child; rendered as-is |
| `manifest` | `{ scripts: VerifiedScript[] }` — null until verified |
| `reset_packages` | `{ packages: string[] }` or null |
| `created_by`, `created_at` | |

Indexes: `(name, version)` unique, `(name, status)`.

### 5.2 `scripts` (schema.ts:827) — the plugin-relevant columns

| column | notes |
|---|---|
| `kind` | `'script' \| 'workflow'`, default `'script'`. Compared against `'workflow'` in exactly three sanctioned files |
| `name` | `checkout`, or `tiktok/login` for a plugin member |
| `bundle` | for a plugin member this is the **full plugin bundle**, byte-identical across members |
| `params_schema`, `result_schema`, `runtime` | JSON columns, Zod-validated on read |
| `plugin_id`, `export_id` | **set together, both null or both non-null.** `export_id` is the member id inside the bundle |
| `enabled` | flipped to false for every member when a plugin is disabled |

`(name, version)` is unique, so older jobs stay reproducible.

### 5.3 Adjacent tables

- **`script_param_sets`** — named parameter presets keyed on script **name** (never a `scripts.id`),
  because a preset is standing intent that must outlive the version it was written against.
- **`jobs.script_name` / `script_version`** — denormalised at enqueue from the registry entry. A dev
  script has no row, so without this every job it ran would list as "unknown script" the moment the
  dev session ended. It also closes a pre-existing latent bug: a deleted published script used to
  make its old jobs lose their names.
- **`kv_entries`** — namespaced; a plugin's namespace is its `id`, shared by every member (§7.3).
- **`workspace_files`** — the DB-backed workspace a dev slot can be built from (front-end A).

---

## 6. `ScriptRegistry` — the merge point

`packages/core/src/scripts/registry.ts`. This exists because there are now **two** places a script
can come from: a persisted `scripts` row, and an unpublished plugin **dev slot** held in memory.

Before it, there were 15 direct reads of the `scripts` table across 9 files and 8 call sites of
`resolveScriptRef` across 6 files. Without a merge point, every one of those would have to learn
about dev slots — and the ones that were missed would not fail loudly; they would simply not see dev
scripts. "Run a script" would not list it, triggers would not resolve it, topology would show it as
unknown: three separate bugs found months apart.

```ts
type ScriptOrigin = 'plugin' | 'dev'

interface ScriptEntry {
  id            // `scripts.id`, or `dev:<plugin>/<script>`
  name          // `tiktok/login`, or a workflow's own name
  version       // a dev entry's is `<declared>+dev.<n>`
  kind          // carried through, never branched on here
  origin        // a persisted row is always 'plugin'; a dev slot is 'dev'
  pluginName    // null for a workflow
  exportId      // the member id INSIDE the bundle; null for a workflow
  enabled
  paramsSchema
  runtime       // pinned exactly like paramsSchema
  bundle: { kind: 'db'; scriptId } | { kind: 'file'; path }
  ephemeral     // true for a dev entry
  devOwner?     // for the "which build actually ran" log line
}
```

Surface: `list()`, `groups()`, `get(id)`, `resolve(ref, { allowDev })`, `bundlePath(entry)`,
`invalidate(pluginName?)`.

Four behaviours worth knowing:

0. **A `kind: 'script'` row with no owning plugin is IGNORED.** A farm that upgraded past plan 110
   §3.2 still has rows published before a script had to be a plugin member. They do not `list`, do
   not appear in `groups`, do not `resolve`, and `get()` returns null for them — nothing can run
   one. They are not deleted (that is the operator's call, §3.5) and job history is unaffected
   (`jobs.script_name`/`script_version` are denormalised for exactly this). `createScriptRegistry`
   counts them ONCE at construction and emits ONE `warn` naming the count and the names, so a farm
   never silently stops running something. A `kind: 'workflow'` row also carries no `pluginId`
   (§3.3) and is *not* one of these — the predicate lives in one place, `scripts/service.ts`'s
   `isUnownedScriptRow`/`ownedScriptsWhere`, which `GET /api/scripts` and `listScriptGroups` apply
   too so the HTTP lists and the registry can never disagree.
1. **`resolveScriptRef` keeps its body and its four errors.** The registry calls it for the
   persisted half and merges the dev half on top. Semver ordering, prerelease exclusion, and the
   disabled rule are not reimplemented.
2. **A plugin-scoped `@latest` means "the ACTIVE plugin version", not "the highest enabled semver".**
   Several versions' `scripts` rows are alive at once (active plus every superseded one, kept so
   pinned refs still resolve), so the raw `@latest` rule would silently pick a superseded version's
   number after a rollback. `resolve()` translates a plugin `@latest` into a concrete pinned lookup
   *before* calling `resolveScriptRef`. An exact pinned ref is untouched.
3. **A dev entry needs `allowDev: true`.** Only the ad-hoc run and trigger paths pass it. A schedule
   or a batch gets `script_is_dev`, naming the plugin and the slot owner — those pin a reference and
   must survive a laptop closing.

`invalidate()` is today a deliberate no-op: nothing caches beyond the dev-slot store and the file
cache, both of which re-read fresh. It is kept as the single seam a future caching layer would use.

`findShadowedPublished(registry, entry)` is the companion that makes §9.3's dev-shadow log line
possible.

---

## 7. Execution — what actually happens when a plugin script runs

### 7.1 The chain

```
enqueue                       jobs/validate-script.ts → registry.resolve/get → job row
                              (structural param check against the PUBLISHED schema, before a lease)
   │
claim → executor host → jobs/executors/script.ts
   │      registry.get(job.scriptId)          ← works for a row id OR `dev:<plugin>/<script>`
   │      entry.enabled?                      ← script_disabled
   │      findShadowedPublished()             ← the dev-shadow log line, first line of the job log
   │      registry.bundlePath(entry)          ← content-addressed sha256 file in dataDir/cache/bundles
   │
   └──→ JobRunner.execute({ bundlePath, params, scriptExportId, runtime, runtimeOverride })
            │  isolation.ts spawns:
            │     dev      : bun child-entry.ts <bundlePath>
            │     compiled : <enkaku-binary> --job-child <bundlePath>
            │  env: ENKAKU_SCRIPT_EXPORT_ID = entry.exportId   ← the whole link
            │
            └──→ child-entry.ts
                    const mod = await import(bundlePath)
                    isPluginBundle(mod.default)
                      ? mod.default.scripts.find(s => s.id === process.env.ENKAKU_SCRIPT_EXPORT_ID)
                      : mod.default                    ← a pre-plugin bundle, unchanged
                    send({ t:'ready', scriptId, version, pluginId, runtime, reset, assist })
                    ← parent runs the pre-job reset, then sends `init`
                    prepare → run → finish, each phase racing the abort signal
```

A bundle with no `scripts` array of its own sets no `scriptExportId`, so the child takes the second
branch exactly as it did before plugins existed.

### 7.2 The node (cloud) path

`jobs/executors/remote.ts` does the identical thing over the tunnel: `scriptExportId` is an optional
field on `JobDispatchMessage` (`@enkaku/protocol`'s `tunnel.ts`), and `packages/node/src/hosts.ts`'s
`job.dispatch` handler threads it into its own `runner.execute()`. A plugin script runs correctly on
a cloud node, not only locally. `jobs/executors/workflow.ts` threads it per node too.

### 7.3 KV namespace — the subtle one

`ctx.kv`'s namespace is resolved by the **parent**, from the child's `ready` message:

```ts
const namespace = opts.meta?.pluginId ?? opts.meta?.scriptId ?? job.id
```

`pluginId` (`tiktok`) is preferred over `scriptId` (`login`). This is what makes a login script's
session readable by a warmup script in the same pack. It was a genuine bug found by wiring
end-to-end execution: keying off `ready.scriptId` alone meant two members of one plugin would *not*
have shared a namespace. `pluginId` was added to the `ready` IPC message for exactly this, and it is
also what the log redactor keys on.

Removing a plugin with `?deleteKv=1` deletes that namespace globally **and** under every device.

### 7.4 Reset packages

`child-entry.ts` merges the plugin's own `reset.packages` with the selected member's, deduplicated,
plugin-level first, and reports the union in `ready` so the parent can run the pre-job reset.

### 7.5 What is pinned, and when

Everything a job runs against is pinned **at enqueue**: the concrete script entry, its
`paramsSchema`, its `runtime` envelope, its `resultSchema`, and the operator's per-job
`runtime_override`. Activating a new plugin version changes what `@latest` resolves to **for future
enqueues only**. If activation changed what queued jobs run, queueing 200 warmups and pushing a fix
would produce a run where some ran old and some ran new, with nothing in any log saying which.

---

## 8. Lifecycle A — publishing a plugin (stage → verify → activate)

One bundle holding twenty scripts means one syntax error can take out twenty scripts. So publication
is three separate states, not one.

| step | what happens | where |
|---|---|---|
| **1. staged** | bundle stored, row written `status: 'staged'`, `bundle_hash` computed. Nothing resolves to it | `runtime.stage()` |
| **2. verified** | a throwaway child imports the bundle and reports plugin id/version/title/description, every member's id + JSON-Schema params + result + runtime envelope, and `reset.packages`. Bounded at **15s**; the child is killed, not waited on | `verify-child.ts` + `verify-child-entry.ts` |
| **3. activated** | explicit, separate call. CAS on `status = 'staged'`; the previous active version becomes `superseded`; N `scripts` rows are written | `runtime.activate()` |

**The import happens in a child, never in the core's process** — the same reason `scripts/build.ts`
refuses to execute what it bundles: a publish must not be able to run code in the core. Two launch
shapes mirror the job child exactly (`bun verify-child-entry.ts <path>` / `<binary> --plugin-verify
<path>`).

**The parent never trusts the child's report.** `finalizeReport()` independently re-checks member id
shape (`[a-z0-9][a-z0-9-]*`), uniqueness, and that the declared version matches the staged row — a
hand-crafted bundle can carry a `scripts` array that never went through `definePlugin` at all. The
child likewise re-runs `checkDeclaredSchema` on every member's params and result schema, so neither
publish route can take a path the other refuses.

**`writeScriptRows` never deletes an older version's rows** and is idempotent (`id` is
`<pluginId>:<memberId>`, skipped if it exists). That is what keeps a pinned reference to a
superseded version resolvable, and what makes rollback a pure status flip with **no re-publish and
no bundle upload**.

### 8.1 Name conflicts are a conflict, not a crash

Two plugins claiming the same script name: the already-active one keeps it, the newcomer is `failed`
with `E_PLUGIN_NAME_CONFLICT` naming both. Because a member's name is always `<plugin>/<member>`,
this can only happen when (a) a row published before a script had to belong to a plugin took a
literal name containing a slash — the farm no longer resolves such a row, but it still occupies its
`(name, version)` — or (b) — defence in depth — a `scripts` row whose owning plugin has a different
name. A new
*version* of the same plugin re-publishing `tiktok/login` is the normal case and is never a conflict.

The manifest is persisted **even on this failure** — it is the one failure mode where the bundle did
finish importing and did report its full member list, so the Plugins page can say "N declared, 0
registered".

### 8.2 Operations

| operation | what it does | effect on a running job |
|---|---|---|
| `reload(name)` | re-verify the newest failed row (or the active one); auto-activates if it now passes | none — it holds its own bundle file |
| `restart()` | invalidate, re-verify every active plugin, retry every failed one, sweep expired dev slots | none |
| `disable(name)` | the row goes `disabled` and every member row is `enabled = false` | none |
| `rollback(name, toVersion)` | a superseded version becomes active again; the current one becomes superseded | none |
| `remove(name, version)` | deletes the row and its member rows; optionally the KV namespace | none |
| activating a new version | changes what `@latest` resolves to, for **future enqueues only** | none |

`restart()` deliberately **never demotes an already-active plugin**: an active plugin that now fails
re-verification gets its `verify_error` updated as a warning but keeps resolving until an operator
explicitly disables it.

### 8.3 Why nothing needs "unloading"

There is no long-lived plugin instance in the core. Scripts run in a separate child process per job.
Nothing is loaded, so nothing needs unloading — "restart" means *re-derive*, not tear down.

---

## 9. Lifecycle B — dev slots (running unpublished code)

A published-only pipeline means the author's loop is `publish → run job → look`. A **dev slot** is
the shortcut: at most one per plugin name, holding a built bundle plus its verify report, owned by a
session, and **never a database row** — so a dev build cannot survive a core restart. An operator
restarting the farm gets the published state back, never a half-finished pack from yesterday.

### 9.1 Two front-ends, one slot

**A — from the workspace.** `POST /api/plugins/dev { name, entryPath }`. `scripts/build.ts` bundles
the workspace directory server-side under its import allowlist. **There is no file watcher:** every
workspace write goes through the store, so `withAutoRebuild()` wraps the `WorkspaceStore` and
re-calls `putDevSlot()` on any write/move/delete under the slot's own directory
(`/scripts/tiktok/index.ts` → anything under `/scripts/tiktok/`). Exact rather than
eventually-consistent. The rebuild is best-effort and asynchronous — the write has already succeeded
by the time it runs, and a failure lands on the slot (`lastBuildOk`, `lastError`), never thrown back
at whoever triggered it.

**B — from the author's machine.** `enkaku dev <entry.ts>` bundles locally with the same
`buildEntry()` `publish` uses, POSTs `{ name, bundle }` with an `x-enkaku-dev-owner: user@host`
header, and re-pushes on every change (`fs.watch` recursive, 150 ms debounce; a watch-triggered
build failure prints and keeps watching, but a non-plugin entry on the *first* build exits non-zero
pointing at `enkaku publish`).

Both land in the same slot and go through the **same verification**. The CLI's local build is a fast
feedback loop for the author, never a trust boundary.

### 9.2 Slot semantics

- Hot reload **is** slot replacement — overwrite, invalidate, next job resolves the new entry.
- `buildVersion` is `<declaredVersion>+dev.<n>`, `n` incrementing per rebuild, so a job's recorded
  version says exactly which build ran and no dev build can be mistaken for a released one.
- A failed rebuild calls `putFailed()` — the **last good build stays runnable**.
- TTL 30 min idle (`touch()` extends, `sweep()` drops; `restart()` sweeps).
- `kvNamespace` is the plugin name, same as a published plugin — a dev build reads the published
  build's KV.

### 9.3 The guard rails

- Dev slots require the **same permission as publishing** (`script.publish`).
- A dev script may be run manually and triggered, but may **not** be scheduled or batched
  (`script_is_dev`).
- **A dev entry never shadows a published one silently.** When both exist the dev entry wins *and*
  the job's very first log line names the published version it shadowed and the slot's owner. A run
  that silently used unreviewed code would be the worst outcome this design could produce.

---

## 10. Lifecycle C — embedded packs

`bun run build:packs` bundles each entry in `PACK_ENTRIES` with `Bun.build`, imports the built file
once to read the `id`/`version` `definePlugin` stamped on it (never the filename), and writes
`packages/core/packs/<id>.mjs` + `index.json`. The release entrypoint embeds those with
`with { type: 'file' }` and registers them via `registerEmbeddedAssets()`.

At boot, `seedEmbeddedPacks()` runs **fire-and-forget** (`void`, never awaited) and:

- stages + verifies each pack, **never activates it** — activation puts `tiktok/auto-scroll` in front
  of every operator on the farm, and that is a one-click operator decision, not a fresh-install one;
- records what it seeded in `<dataDir>/seeded-packs.json`, keyed `name@version`, so **removing a pack
  is permanent** (without the marker, the next boot would find no row and helpfully resurrect what
  the operator just deleted). A core upgrade that bumps a pack's version is a new key, so it does
  arrive as a new staged version;
- treats every failure as non-fatal — a `failed` row plus a log line, and the farm carries on.

---

## 11. Isolation and trust boundaries

There are **three** distinct boundaries; they are easy to conflate and they protect different things.

| boundary | mechanism | protects against | what it is NOT |
|---|---|---|---|
| **build** (`scripts/build.ts`) | static walk of the import graph *before* `Bun.build` is called; bare specifiers limited to `@enkaku/sdk` and `zod`; every `node:*` refused; relative/absolute imports resolved against the workspace, never disk; 30 s / 20 MiB / 500 files | a workspace-authored script pulling in arbitrary code or reading real disk at build time | not a runtime sandbox — the built bundle still runs with full authority |
| **verify** (`verify-child.ts`) | separate process, 15 s hard kill, IPC-only report, parent re-validates | a publish executing code in the core; a module-scope `throw`, infinite loop, or OOM taking the farm down | not a check that the script *behaves* — only that it declares a valid shape |
| **run** (`child-entry.ts`) | one child process per job; every device access over IPC; abort → SIGTERM → SIGKILL | a crashing/hanging script taking the core with it | **crash containment, not a security sandbox** — the bundle has full fs and network access as the core's OS user |

The build boundary has one subtlety worth preserving: Bun's bundler auto-externalises recognised
`node:*` builtins under `target: 'bun'` **without ever invoking a plugin's `onResolve`**, so a plugin
that only rejects imports it is asked to resolve would silently let `node:fs` through. That is why
the whole graph is pre-validated by hand first.

---

## 12. The failure model

> **Assembling the script registry never throws.** A plugin that fails to build, fails to verify,
> declares duplicate ids, or throws on import is recorded `failed` with its error, contributes zero
> scripts, and changes nothing about any other plugin.

Enforced structurally, not by discipline: plugin code is never imported into the core process;
registry assembly wraps each plugin individually; name collisions are conflicts; boot never blocks
on verification (seeding is fire-and-forget, and until a plugin is verified its scripts are simply
absent).

### 12.1 Error codes

| code | raised by | meaning |
|---|---|---|
| `E_PLUGIN_VERIFY_FAILED` | verify child | the bundle threw, or is not a `definePlugin` result |
| `E_PLUGIN_VERIFY_TIMEOUT` | `verify-child.ts` | exceeded the 15 s budget; SIGKILLed |
| `E_PLUGIN_VERIFY_CRASHED` | `verify-child.ts` | the child exited without reporting anything |
| `E_PLUGIN_BAD_SCRIPT_ID` | parent re-validation | a member id fails `[a-z0-9][a-z0-9-]*` |
| `E_PLUGIN_DUPLICATE_SCRIPT_ID` | parent re-validation | two members share an id |
| `E_PLUGIN_VERSION_MISMATCH` | parent re-validation | bundle version ≠ staged version |
| `E_PLUGIN_NAME_CONFLICT` | `runtime.verify()` | another owner already holds `<plugin>/<member>` |
| `E_PLUGIN_UI_UNSUPPORTED` | `verify-child.ts` (`finalizeReport`) | a tier-C view's `react.apiVersion` ≠ the farm's `PLUGIN_UI_API_VERSION`. Deliberately not `E_PLUGIN_SURFACE_INVALID` — the surface is well formed, this farm just does not ship that `@enkaku/ui` major. Exact equality, not a range: a stable component API is an explicit non-goal (plan 111 §2), so a range would be a promise nothing keeps. |
| `E_PARAMS_SCHEMA_INVALID` / `E_RESULT_SCHEMA_INVALID` | verify child, `POST /api/scripts`, and the CLI | `checkDeclaredSchema` limits exceeded |
| `E_RUNTIME_ENVELOPE_INVALID` | verify child, `POST /api/scripts` | the runtime envelope's shape is wrong |
| `E_BUILD_FAILED` / `E_BUILD_TIMEOUT` | `scripts/build.ts` | disallowed import, unresolvable path, oversize, 30 s |
| `plugin_version_exists` (409) | `stage()` | `(name, version)` already staged |
| `plugin_not_verified` (409) | `activate()` | no `verifiedAt`/`manifest` |
| `plugin_activate_conflict` (409) | `activate()` | lost the CAS — already active, or another activation won |
| `plugin_not_rollbackable` (409) | `rollback()` | the target was never active |
| `script_is_dev` | `registry.resolve()` | a schedule/batch tried to pin a dev build |
| `script_not_found` / `script_version_not_found` / `script_ref_unresolved` / `script_disabled` | `resolveScriptRef` | plan 62's four distinguishable ref failures |

Note the three-way split of "invalid schema" checks — the **same** `checkDeclaredSchema` gate runs in
three places (the CLI locally, over every member, before any network call; `POST /api/scripts` on
the writer; and the verify child for every plugin member) precisely so a hand-crafted request cannot
take a path the CLI would have refused.

---

## 13. HTTP surface

### 13.1 `/api/plugins` (`packages/core/src/api/plugins.ts`, mounted in `server/http.ts:367`)

| method + path | permission | notes |
|---|---|---|
| `GET /` | — | `{ items: PluginView[], dev: DevSlotView[] }`; `?name=` filter |
| `GET /dev` | — | dev slots only |
| `GET /:name/:version` | — | one row |
| `POST /` | `script.publish` | stage **and** verify in one call; `{ stageOnly: true }` skips the verify |
| `POST /:id/verify` | `script.publish` | re-verify a staged row |
| `POST /:id/activate` | `script.publish` | explicit, separate from publish |
| `POST /:name/rollback` | `script.publish` | `{ toVersion }` |
| `POST /:name/disable` | `script.publish` | |
| `POST /:name/reload` | `script.publish` | re-verify + auto-activate if it now passes |
| `POST /restart` | `script.publish` | `{ ok, failed }` |
| `POST /dev` | `script.publish` | exactly one of `entryPath` \| `bundle` |
| `DELETE /dev/:name` | `script.publish` | |
| `DELETE /:name/:version` | `script.delete` | `?deleteKv=1` also drops the KV namespace |

Two details that are easy to break:

- `/dev` and `/dev/:name` are registered **before** `/:name/:version`. Hono matches in registration
  order, and `DELETE /dev/tiktok` would otherwise be swallowed as `name='dev', version='tiktok'`.
- There is no `plugin.*` permission. The routes deliberately reuse `script.publish` / `script.delete`
  rather than inventing one the ACL matrix was never asked for. Every mutation is audited
  (`plugin.publish`, `plugin.activate`, `plugin.rollback`, `plugin.disable`, `plugin.reload`,
  `plugin.restart`, `plugin.dev`, `plugin.delete`).

### 13.2 `/api/scripts` (`packages/core/src/scripts/routes.ts`)

`GET /` (keyset-paginated; `?group=name` for one row per name; `?kind=` filter), `GET /:id`
(`?bundle=1`), `GET /:name/versions`, `POST /`, `PATCH /:id` (enable/disable), `DELETE /:id`
(refused with `script_in_use` while a queued/running job references it), plus
`GET/POST/PATCH/DELETE /:name/param-sets[/:id]` (gated on `job.run`, not `script.publish` — a preset
is a convenience for someone about to *run* a script).

`scripts/routes.ts` was **not** modified for plugins. The Scripts page's Plugin column and origin
filter are derived client-side from the `<plugin>/<script>` naming rule.

### 13.3 Agent / MCP

`capability/script.ts` exposes `script.list`, `script.get`, `script.publish` — the publish accepts
either a pre-built `bundle` or a workspace `path`, and the path form goes through the exact same
`buildScriptFromWorkspace`. There is no second bundling path anywhere in the system.

---

## 14. Studio surfaces

| screen | what it shows |
|---|---|
| `/plugins` | **one row per plugin, not per version** (versions live in an in-row picker). Failed plugins sort first; a failed row renders `verifyErrorCode` + `verifyError` **verbatim** plus "N declared vs `scriptCount` registered". Dev slots get a DEV badge, owner, last-build result, and KV namespace. Per-row Activate / Rollback / Reload / Remove, plus "Reload all" → `POST /restart` |
| sidebar | the Plugins nav badge is a **danger-toned warning** (`role="status"`) while any plugin is `failed` — the badge already links to `/plugins`, so it *is* the farm-health warning |
| `/plugins` (Scripts section) | one row per script NAME — the members of the plugins above it. No origin filter and no Plugin column: every name is already `<plugin>/<script>`, so both would only repeat the Name beside them |
| `RunScriptDialog` | the script picker groups by plugin (`SelectGroup`/`SelectLabel`) and marks a dev entry with a `DEV` chip |
| device page | merges `GET /api/plugins/dev` into its script list, so a dev script is pickable for an ad-hoc run |

Every Studio `api()` call takes a schema from `packages/protocol/src/api/plugins.ts`, verified against
the real routes in `packages/core/src/api/plugins-kv-protocol.test.ts`.

---

## 15. Test map

| file | covers |
|---|---|
| `plugins/runtime.test.ts` (449 L) | stage/verify/activate CAS/rollback/disable/remove + the fault-isolation block (a throwing bundle, a hanging one, a duplicate-id one, a name-conflict one) |
| `plugins/verify-child.test.ts` | the real spawned child, timeout kill, crash-without-report |
| `plugins/dev-slots.test.ts` | build counter, TTL sweep, `putFailed` keeps the last good build |
| `plugins/auto-rebuild.test.ts` | editing a **shared helper** (not the entry) bumps `buildN` with no second `/api/plugins/dev` call |
| `plugins/seed-embedded.test.ts` | seeded-once marker, corrupt marker, never auto-activates |
| `scripts/registry.test.ts` (373 L) | the merge, plugin `@latest` vs superseded, `allowDev` |
| `scripts/routes.test.ts` (703 L) | script CRUD, param sets, schema gates |
| `scripts/build.test.ts` | the import allowlist, `node:*` refusal, timeout |
| `jobs/plugin-execution.integration.test.ts` | **real** DB rows, real shared bundle, real `Bun.spawn` of `child-entry.ts`: two members of one bundle claim correctly; a job pinned to `v1.0.0` still produces `v1.0.0`'s bytes after `v1.1.0` is activated; a job survives `runtime.restart()` mid-run |
| `jobs/executors/script.test.ts` | the dev-shadow log line; two members of one plugin land in the **same** KV namespace |
| `sdk/cli/publish.test.ts` | spawns the **real** CLI as a subprocess against a `Bun.serve` fake farm |
| `api/plugins-kv-protocol.test.ts` | the protocol schemas against the real routes |

Remember the two-command rule: `bun test` from the root does **not** run Studio's tests —
`bun run --cwd packages/studio test` is a separate, required invocation.

---

## 16. Rough edges, stated rather than hidden

1. **`/api/plugins` does not use `typedJson`.** It sends `PluginRow` straight through `c.json()`, so
   `createdAt`/`verifiedAt` are **ISO 8601 strings** on the wire, not the unix-seconds numbers every
   other route produces. Documented in `protocol/src/api/plugins.ts` rather than silently changed;
   the Studio page has its own `isoTime()` because of it.
2. **`VerifiedScriptSchema` (protocol) carries only `{ id, paramsSchema }`** while the core's
   `VerifiedScript` also has `resultSchema` and `runtime`. The manifest's extra fields exist in the
   DB but are not described on the wire.
3. **Member `title`/`description` never leave the bundle** (§4.2).
4. **`registry.invalidate()` is a no-op.** Correct today, but it means "invalidate" is not currently
   proof of anything — it is a seam.
5. **No boot-time proof of §12's guarantee.** The guarantee is tested thoroughly at component level
   and live for the healthy case, but there is no `createDaemon().start()` test asserting
   `/api/health` still answers beside a deliberately broken plugin fixture.
6. **`GET /api/plugins` has no permission gate** while every mutation does. Consistent with the rest
   of the read surface, but worth knowing.
7. **No distribution channel.** Plugins arrive by CLI push, workspace authoring, or an embedded pack.
   There is no marketplace, no registry fetch, no signature verification of third-party bundles — the
   trust model is "whoever can publish is a trusted operator" (spec §11.3). A marketplace is deferred
   to spec §22.
8. **Dev slots are single-tenant per plugin name.** Two authors iterating on `tiktok` on the same
   farm overwrite each other's slot; the only signal is the owner label on the Plugins page.
9. **A plugin contributes scripts and nothing else** — no hooks, no middleware, no services, no
   inter-plugin dependency resolution. A plugin is self-contained by design.
