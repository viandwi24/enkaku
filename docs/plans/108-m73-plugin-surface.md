# Plan 108 — M73 : A plugin owns a screen, not just a script

> Status: implemented — designed and built 2026-08-17 with the owner across one conversation; every decision in §3 is theirs, recorded with its reasoning. All twelve steps (108.1–108.12) are done and green: `bun test` 5172 pass / 0 fail, `bun run --cwd packages/studio test` 1576 pass / 0 fail, `bun run typecheck` clean in every package except one pre-existing failure a concurrent builder owns (`api/jobs.ts:229`, a `JobService.nodes()` shape change in `packages/session/src/manager.ts` — untouched here). **Five corrections the build made to this document, each because implementing it proved the plan wrong:** (1) §4.2's binding union listed `z.record` before `z.array`, and `z.record` accepts an array and returns it keyed by index — a list binding would have silently become a map; the union is now ordered `array` first. (2) `views['constructor']` answered with a function for a view nobody declared; surface ids now refuse `__proto__`/`constructor`/`prototype` through the `DANGEROUS_FIELD_NAMES` set the protocol already had. (3) §4.3's `Last synced` column named `kind: 'timestamp'`, which did not exist — `PARAM_KINDS` had `duration` for a span and **nothing for an instant**, so `checkDeclaredSchema` would have failed the pack at verify; step 108.7 added the kind, with an absolute UTC formatter server-side (a result summary is frozen at settle and must never read "2 minutes ago" forever) and `relativeTime` in the browser. (4) §4.3's `confirm` used `{{username}}`, which §3.4 forbids and which would have rendered literally; `confirm` is a plain sentence and `ActionRunner` names the target from the view's own `rowKey`. (5) `data` beside `frame` was refused, which left tier B unable to read anything at all (`connect-src 'none'` gives the frame no fetch of its own, so a frame with no declared source could only hold static markup); the rule is now "exactly one *renderer*", with `data` legal beside either — see §9 Q4. **Three things shipped beyond the plan, all owner-directed mid-build:** `POST /api/plugins/:name/enable` (plan 82 made `disable` a one-way door — `activate` CASes on `staged`, `rollback` needs `superseded`, `reload` needs an active or failed row, so a disabled plugin had no path back; enable also restores the member `scripts` rows, which activation alone never would); the Scripts list merged into `/plugins` as a second stacked section with `/scripts` left as a query-preserving redirect; and `tiktok/syncOne`, a per-device job action, because the toolbar's `sync` is a batch and plan 82 §3.5 refuses a dev-slot script as a batch target — without it `enkaku dev` had no working loop on this pack. **Not done, and why:** the manual hardware smoke in §7 (owner to run — no test in this repo touches a physical device), and `bun run build:studio` proven only against an rsync'd copy of the package, because the guard script refuses while a `next dev` is bound to :3001. **Out of scope by construction, not forgotten:** two decisions from the same design conversation — plugin as the only publish unit, and target-app compatibility metadata — were answered in discussion and never written into this plan or 109; they belong to a plan of their own.
> **Superseded in part, 2026-08-17 (same day), by plan 111 (M76): tier B — the sandboxed iframe — was REMOVED from the code, not deprecated.** Everything else in this plan stands: tier A, the surface manifest, the binding language, the action executor, the `.enkaku` package and its `ui/` directory, the asset route, and the plugin-view page are all live and unchanged. What went is the *renderer*: `FrameView.tsx`, `frame-rpc.ts`, `ViewSpecSchema.frame`, and the strict CSP on `GET /api/plugins/:name/ui/*`. In their place a view states `react: { entry, apiVersion }` and Studio mounts the plugin's own React component inside its own tree, with the host's live `@enkaku/ui` components and the operator's session — plan 108 §3.2's "tier C", which this plan refused. Two reasons it went rather than staying beside the new tier: once React with full page access exists nobody would choose a frame that cannot even `fetch`, and `docs/plans/00-overview.md` §4.3 forbids keeping a weaker parallel path "for one release". The `ui/` directory survives the change and is now how *every* tier-C plugin ships its module. **Everything below this line is left as it was written** — §3.2's comparison table, §4.4, and the §5 file list describe tier B accurately as of the day it was built, and that is the record they exist to be. Read them as history; read `docs/spec.md` §11.6 and plan 111 for what runs today.
> Depends on: Plan 82 (M47) — the plugin registry, dev slots, and the stage→verify→activate pipeline this extends. Plan 79 (M44) — the KV store this plan makes a plugin's storage. Plan 95 (M60) — `planField`/`SchemaForm`, the resolver this plan reuses rather than duplicating. Plan 97 (M62) — `planResult`, its read-side sibling.
> Blocks: Plan 109 (M74) — the plugin runtime, handlers, listeners, and device reachability build on this plan's manifest, package format, and permissions.
> Spec references: §11.6 (plugins), §12 (data model — `kv_entries`), §19 (Studio screens)
> Ships: packages/studio/src/app/plugins/view/page.tsx

---

## 0. Evidence

The owner's ask: a plugin should be able to contribute a screen to Studio (their example: *"plugin membuat ui berupa Tiktok Accounts"*), with a sidebar entry, backed by storage a script in the same plugin can write. Plus a standing rule for the pass: *"jangan sampai ada plot hole, atau ada fiturnya di server atau core tapi kok di ui ga ada."*

### 0.1 Confirmed findings — what already exists

| # | Finding | Evidence |
|---|---|---|
| **G1** | **The storage is already built.** `kv_entries` is namespaced, scoped `global` or `device`, with CAS, TTL, per-namespace and per-device quotas, and AEAD-encrypted secrets. | `packages/core/src/kv/store.ts:25` (`KvScope`), `:74-89` |
| **G2** | **A plugin's KV namespace is its plugin id, shared by every member.** The runner prefers `ready.pluginId` over `ready.scriptId` precisely so two members see the same namespace. | `packages/session/src/runner/job-runner.ts:915`; plan 82 §3.10 |
| **G3** | **The device scope is keyed on `stableId`** — not the adb serial — and a forgotten device's entries are deleted in the same transaction that removes it. | `packages/core/src/kv/store.ts:25`, `:88` |
| **G4** | **A script can only ever write its own device's scope.** The child sends `kv.call` with no scope id; the parent resolves `stableId` from the job. | `packages/session/src/runner/job-runner.ts:909-918` |
| **G5** | **The TikTok pack already navigates the switch-account sheet and parses its rows** — reading the account list is a refactor of code that exists, not new device work. | `plugins/tiktok-automation-pack/src/switch-account.ts`, `src/tree.ts` |
| **G6** | **Studio owns one total, pure schema→widget resolver** (`planField`) and its read-side sibling (`planResult`), with a closed `x-enkaku` vocabulary in `@enkaku/protocol` that structurally cannot name a control. | `packages/studio/src/components/schema-form/plan.ts`; `components/result-view/plan-result.ts`; `docs/design.md` |
| **G7** | **`POST /api/jobs` accepts a `scriptRef`** (`name@latest`), resolved and pinned server-side; `POST /api/batches` requires a concrete `scriptId`. The asymmetry is real. | `packages/core/src/api/jobs.ts:26-51`; `api/batches.ts:45-48` |
| **G8** | **`AppShell` already fetches `/api/plugins`** on every load for the `failedPlugins` badge. Nav injection extends a call that is already made. | `packages/studio/src/components/layout/AppShell.tsx:139` |
| **G9** | **A nested route under an existing top-level directory needs no nav entry.** The orphan check reads only the top level of `src/app/`, and `/plugins` is already in the nav. `scripts/detail` is the precedent under static export. | `packages/studio/src/components/layout/AppShell.test.tsx:105-137` |
| **G10** | **A dependency-free tar+gzip writer AND reader already exist**, hand-rolled specifically so the release binary needs no system `tar` on any platform. | `packages/core/src/backup/tar.ts:77-113` (`createTar`, `createTarGz`, `readTar`, `readTarGz`) |

### 0.2 Confirmed findings — the parity gaps

| # | Server capability | UI path | Verdict |
|---|---|---|---|
| **P1** | `POST /api/plugins` — publish/upload a bundle | none | **gap.** A plugin can only arrive by CLI or as an embedded pack |
| **P2** | `POST /api/plugins/:name/disable` | none | **gap.** The row offers Activate / Rollback / Reload / Remove only |
| **P3** | `DELETE /api/plugins/dev/:name` | none | **gap.** Dev slots render and cannot be dropped |
| **P4** | `DELETE /api/plugins/:name/:version?deleteKv=1` | **unreachable** — the page hardcodes `remove(false)`, and its dialog points at a KV settings panel that cannot do the job (`KvPanel` deletes one key at a time and requires the namespace typed from memory; `GET /api/kv` has no namespace listing) | **gap, compounded.** `KvStore.deleteNamespace` has no UI anywhere |
| **P5** | `GET /api/kv` requires `kv.manage`, deliberately **admin-only** | — | **blocker.** An operator viewing a plugin's own table would need admin |
| **P6** | `GET /api/kv` requires exactly one `stableId`; no cross-device scan | — | **blocker.** A per-device table would be N requests |
| **P7** | `VerifiedScriptSchema` (protocol) declares only `{ id, paramsSchema }`; the core's own `VerifiedScript` also carries `resultSchema` and `runtime` | — | wire schema behind the manifest |
| **P8** | `PluginMemberScript.title`/`description` are typed and both shipped packs write them, but the verify child reports neither | `packages/core/src/plugins/verify-child-entry.ts:97` | **gap.** No human name for a script anywhere |

P1–P4 are pre-existing. They are in this plan because the moment a plugin owns a sidebar entry, "how do I install one" and "how do I turn one off" stop being tolerable omissions.

---

## 1. Goals

1. **A plugin can own a screen in Studio** — sidebar entry, page, tables, forms, actions — with **no browser JavaScript of its own** in the default path.
2. **That screen uses Studio's own components**, through the resolver Studio already has. Not "styled consistently" — the same components.
3. **A plugin has storage an operator can see and use**, with the global/device distinction made explicit rather than implied.
4. **A script and a plugin screen share one store**, so a script's scrape shows on the screen and the screen's write is readable by the next script.
5. **Every server capability the plugin subsystem has is reachable from Studio**, including the four that are not today.
6. **A surface is verified before activation**, in a child process, exactly as its scripts are.
7. The TikTok Accounts screen works end to end.

## 2. Non-goals

- **Any plugin runtime**: no handlers, no listeners, no HTTP endpoints, no events. That is Plan 109, and this plan is shippable and useful without it.
- **Charts, canvases, free-form layout.** The layout vocabulary is a table and a form.
- **A marketplace, signing, or a trust boundary against a hostile plugin author.** Spec §11.3's trust model is unchanged.
- **Relational plugin storage.** §3.1 names the tripwire and refuses to pre-build it. (Plan 109 §3 revisits it as an opt-in per-plugin SQLite file.)
- **Triggers that run a script from an event.** Explicitly refused by the owner: a plugin listening to events is a runtime feature and belongs entirely to Plan 109.

## 3. Context and design decisions

### 3.1 Storage: KV *is* the plugin store — and the two scopes mean different things

No new storage engine. A plugin-owned table would mean plugin-authored migrations, arbitrary SQL, the farm schema becoming a public API, and quota/backup/teardown all reinvented. `kv_entries` answers what both known use cases need.

| | `global` | `device` |
|---|---|---|
| `scope_id` | `''` | the device's **`stableId`** |
| Written by a script | `ctx.kv.global` | `ctx.kv.device` — **always its own device**, resolved parent-side (G4) |
| Written by a screen | a `kv.set` action, scope `global` | a `kv.set` action, scope `device`, device from the row |
| Deleted when | the plugin is removed with `deleteKv`, or the key is deleted | ...and also when the device is forgotten (`deleteDevice`) |
| Quota | `kv.maxEntriesPerNamespace` (1000) | that, plus `kv.maxEntriesPerDevice` (5000, across all namespaces) |
| Use for | a catalogue, a farm-wide setting | a fact about one phone |

The rule an author can hold in their head: **if forgetting the device should forget the fact, it is device-scoped.**

**The tripwire, named now so it is recognised later:** KV answers *"what does device X have"* and cannot answer *"which devices have Y"* without a scan. The moment a plugin needs the second as a query — or ordering by value, or a join — that is the case for real relational storage, and Plan 109 §3.6 carries it as an opt-in.

### 3.2 The UI is declarative by default, with an iframe escape hatch (owner-approved)

> **Row C's "refused permanently" did not last the day** — the owner reversed it the same afternoon, row B was deleted, and row C is what a plugin UI is now (plan 111 §0.1, §3.6; `docs/spec.md` §11.6 records the reversal and its reasoning). The table below is left exactly as the decision was taken, because a plan that silently repaints its own comparison after the fact stops being a record of anything.

| | Styling | Studio's own components? | Plugin JS in the operator's session? |
|---|---|---|---|
| **A. Declared view spec, Studio renders** | identical by construction | **yes — the real ones** | none |
| **B. iframe + postMessage** | consistent (design tokens injected as CSS custom properties) | **no** — `Table`/`Button` are React in the parent document and cannot cross the frame boundary | sandboxed |
| **C. Module federation into the Studio bundle** | identical | yes | **full session authority** — refused |

This is the direct answer to the owner's question, *"bisa kah ui web ini mendapatkan style atau component dari parent web studio"*: **only under A.** Under B a plugin inherits colours, spacing, radius and typography, and none of the components.

**Both A and B are built** (owner approved B), because they share roughly 70% of their backend — nav injection, the view registry, data routes, the action executor, permissions, verification. Only the renderer differs. **A is the default** and covers both known use cases; **B is the escape hatch** for a layout the vocabulary cannot say. C is refused permanently: Studio is a static export served same-origin by the core, so third-party JS in that page can call any API as the operator.

### 3.3 One resolver, not two

`docs/design.md` states the rule this plan must not break: one vocabulary (`@enkaku/protocol`'s `x-enkaku`) and one resolver (`planField`), with the protocol package structurally unable to name a control.

So a view spec's **columns and forms are JSON Schema nodes**. A column renders through `planField` + `formatValue`; a form renders through `SchemaForm`. This plan adds a *layout* vocabulary and **no field vocabulary at all**.

Two things fall out for free: a plugin's form gets every control the run dialog has (enums with labels, ordered ranges, durations, `showWhen`, secrets) on day one; and `planResult`'s R3 — *a key present in the value but absent from the schema renders below the declared fields, never dropped* — already handles a stored shape that drifted from its declared columns.

### 3.4 Bindings are closed and non-Turing

An action needs to say "use this row's username" and must not be able to say anything else. The precedent is plan 99's workflow gates: *"a closed, non-Turing predicate... no author-supplied code, no regular expressions."*

A `Binding` is one of: a JSON literal; `$row.<dot.path>`; `$form.<dot.path>`; `$device.<field>`; `$entry.<field>`; or an object/array whose leaves are bindings. Nothing else — no operators, no string interpolation, no calls. Evaluated by a pure, depth-capped function, unit-tested with no DOM.

### 3.5 Routing, under a static export

Studio is `output: 'export'`, so a plugin screen is one page taking query parameters, as `/device?id=…` established:

```
/plugins/view?name=<pluginName>&view=<viewId>
```

`app/plugins/view/page.tsx` nests under the existing `app/plugins/`, so the orphan check does not see a new top-level route (G9) — no nav entry is owed, because the real entry is the dynamic one the plugin declares. Navigation uses `next/link` (a plain `<a>` remounts React and kills the WS and video).

**A plugin that stops being active while its page is open** answers 404 on the view fetch, and the page renders `ErrorState` naming what happened. The nav entry disappears on the next `/api/plugins/ui` read.

### 3.6 Which core fields a view may see (owner-decided)

The owner's ruling: *"kalau kv storage per device atau per global, ketika plugin akses api kv storage seperti list/get all ya mau gamau pasti kelihatan dan itu gapapa."*

So `kv.scan` joins a **fixed, small allowlist** of device fields — `id`, `stableId`, `label`, `status`, `clusterId`, `number` — because a table of raw `stableId`s is unreadable. Anything richer than that list is not a data-source feature; it is a handler, and handlers are Plan 109.

`number` joined the original five later, on the owner's ruling that a plugin screen must be able to show *Device ID, Device Number and Device Name* together: those are the three things an operator matches a row to a phone by, and the number — printed on the phone's own screen and usually on a sticker on its case (Plan 89 §3.1) — was the only one of the three the allowlist could not reach. It rides the SAME single statement, as a second LEFT JOIN of `device_numbers` on `stableId`, so the N+1 the scan's shape exists to prevent stays prevented; a device with no reservation reports `null`, which is a normal state and not an error.

### 3.7 Permissions — reuse the matrix, add exactly one

| Action | Permission |
|---|---|
| See a plugin's nav entry, open its view | `script.view` (operator) |
| Read a plugin's own KV namespace through a declared data source | **`plugin.data`** (new, operator) |
| Write/delete through a declared `kv.set`/`kv.delete` action | `plugin.data` |
| Run a `job`/`batch` action | `job.run` (unchanged) |
| Install, activate, disable, rollback, reload | `script.publish` (unchanged) |
| Remove a version | `script.delete` (unchanged) |
| Browse arbitrary KV namespaces (`/api/kv`) | `kv.manage` — **still admin-only, untouched** |

`plugin.data` exists because `kv.manage` is admin-only by deliberate design (`acl.ts:147`) and must stay so: `/api/kv/entry` can return a non-secret plaintext for *any* namespace. The new permission is narrower in a way the old one structurally cannot be:

> **The namespace is never supplied by the caller.** It is the `:name` path segment of `/api/plugins/:name/data/*`, and the route refuses unless a plugin of that name is currently `active` or holds a dev slot.

An operator can still reach another plugin's namespace by typing its name. Accepted and stated rather than papered over: an operator can already publish and run a script inside any plugin, which reaches the same data. The boundary bought here is between **plugin data and the rest of the database**, and between **a declared data source and anything outside its own plugin** — not between operators.

### 3.8 The package format is `.tar.gz` (owner: "yang paling bagus, aman, efisien")

Because the iframe tier is approved, a plugin will ship HTML/CSS/JS and images. A JSON envelope with base64 assets costs +33% and forces a whole-file parse into memory. A real archive is the right answer, and **the reader and writer already exist** (G10) — hand-rolled, dependency-free, gzip via `Bun.gzipSync`, written precisely so the release binary needs no system `tar`.

```
<plugin>.enkaku   (tar.gz)
  plugin.json        the manifest
  scripts.mjs        the script bundle
  ui/                iframe assets (tier B only)
```

Entries outside that allowlist are **refused at verify**, which closes path traversal by construction rather than by sanitising. No new dependency, no base64 bloat, no parser to write.

### 3.9 What gets verified, and where

The surface is verified in the **same child process** that already imports the bundle, under the same 15 s bound. It reports the parsed surface; the parent re-validates independently, as it already does for member ids and versions:

- the whole block against `PluginSurfaceSchema`;
- every embedded JSON Schema through `checkDeclaredSchema` (the same gate a params schema passes);
- every action reference in a view exists in `surface.actions`;
- every `script` named by a `job`/`batch` action parses as a `ScriptRef` (existence is **not** checked — a pack may reference a script published separately; the action reports `script_not_found` at click time, the same failure the run dialog already gives);
- every icon name is in the allowlist; nav ids unique; every archive entry inside the §3.8 allowlist.

Any failure is `E_PLUGIN_SURFACE_INVALID`: the plugin is recorded `failed`, contributes nothing, and disturbs nothing (plan 82 §3.8, unchanged).

### 3.10 Consent at install (owner-decided)

*"boleh saat install plugin di awal bisa dikasih deskripsi, permission dll."*

The install dialog shows the plugin's title, description, its declared scripts (with the titles P8 unlocks), and — once Plan 109 lands — its declared permissions, listeners, and events. It is an explicit confirmation, not a notice. Plan 109 widens the content; this plan builds the step so it does not have to be redesigned later.

---

## 4. Technical design

### 4.1 Authoring

```ts
export interface PluginDefinition {
  id: string
  version: string
  title?: string
  description?: string
  scripts: PluginMemberScript[]
  reset?: { packages?: string[] }
  /** Plan 108 — the screens this plugin contributes. */
  surface?: PluginSurface
}

export interface PluginSurface {
  nav: Array<{ id: string; label: string; icon: IconName; view: string }>
  views: Record<string, ViewSpec>
  actions: Record<string, ActionSpec>
}
```

A plugin omitting `surface` is unaffected in every way. `definePlugin` validates it at import time on the author's machine — unknown keys, a nav entry naming a missing view, an action reference naming a missing action, a duplicate nav id, an unknown icon, every cap exceeded.

### 4.2 The vocabulary — `@enkaku/protocol/src/plugin-surface.ts` (new)

```ts
export const IconNameSchema = z.enum([ /* ~40 lucide names Studio already bundles */ ])

/** Namespace is NEVER declared — it is always the owning plugin's. */
export const DataSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('kv.scan'),
    key: z.string().min(1),
    /** `entry` = one row per device. `items` = flatten `itemsAt` into one row per element, each carrying `$device`. */
    rows: z.enum(['entry', 'items']).default('entry'),
    itemsAt: z.string().default(''),
    /** Include devices with no entry, so "never synced" is visible rather than absent. */
    includeMissing: z.boolean().default(true),
  }),
  z.object({ kind: z.literal('kv.list'), scope: z.literal('global'), prefix: z.string().default('') }),
])

export const BindingSchema: z.ZodType<Binding> = z.lazy(() =>
  z.union([
    z.object({ $row: z.string() }),
    z.object({ $form: z.string() }),
    z.object({ $device: z.enum(['id', 'stableId', 'label', 'status', 'clusterId', 'number']) }),
    z.object({ $entry: z.enum(['key', 'version', 'updatedAt']) }),
    z.object({ $literal: z.unknown() }),
    z.record(z.string(), BindingSchema),
    z.array(BindingSchema),
  ]),
)

export const ActionSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('job'),   label: z.string(), script: ScriptRefSchema,
             params: BindingSchema.optional(), device: z.enum(['row', 'picker']).default('row'),
             confirm: z.string().optional() }),
  z.object({ kind: z.literal('batch'), label: z.string(), script: ScriptRefSchema,
             params: BindingSchema.optional(), target: z.enum(['selection', 'picker', 'all']).default('picker'),
             confirm: z.string().optional() }),
  z.object({ kind: z.literal('kv.set'), label: z.string(), scope: z.enum(['global', 'device']),
             key: BindingSchema, value: BindingSchema, secret: z.boolean().default(false) }),
  z.object({ kind: z.literal('kv.delete'), label: z.string(), scope: z.enum(['global', 'device']),
             key: BindingSchema, confirm: z.string().optional() }),
  /** Opens `SchemaForm` on `schema`, then runs `then` with `$form.*` bound. This is what makes CRUD free. */
  z.object({ kind: z.literal('form'), label: z.string(), schema: JsonSchemaNodeSchema,
             prefill: BindingSchema.optional(), submitLabel: z.string().default('Save'),
             then: z.lazy(() => ActionSpecSchema) }),
])

export const ViewSpecSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  /** Tier A. Tier B (iframe) sets `frame` instead — see §4.4. */
  data: DataSourceSchema.optional(),
  table: z.object({
    rowKey: z.string(),
    columns: z.array(z.object({
      field: z.string(),
      header: z.string(),
      /** Rendered by `planField`/`formatValue`. Absent = plain text. No new field vocabulary. */
      schema: JsonSchemaNodeSchema.optional(),
      width: z.enum(['auto', 'narrow', 'wide']).default('auto'),
    })).min(1).max(12),
    selectable: z.boolean().default(false),
  }).optional(),
  /** Tier B — an entry file inside the package's `ui/` directory. Mutually exclusive with `data`/`table`. */
  frame: z.object({ entry: z.string(), height: z.enum(['fill', 'auto']).default('fill') }).optional(),
  toolbar: z.array(z.string()).default([]),
  rowActions: z.array(z.string()).default([]),
  empty: z.object({ title: z.string(), hint: z.string().optional() }).optional(),
})
```

Caps: ≤ 8 nav entries, ≤ 16 views, ≤ 32 actions, ≤ 12 columns, whole `surface` ≤ 256 KiB serialised, `ui/` ≤ 8 MiB. Named limits, refused at verify with the limit in the message.

### 4.3 Worked example — the TikTok Accounts view

```ts
surface: {
  nav: [{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }],
  views: {
    accounts: {
      title: 'TikTok accounts',
      description: 'Which accounts are signed in on each device, as last read from the switch-account sheet.',
      data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts', includeMissing: true },
      table: {
        rowKey: 'username',
        selectable: true,
        columns: [
          { field: '$device.label',    header: 'Device' },
          { field: 'username',         header: 'Account' },
          { field: 'position',         header: 'Slot', width: 'narrow' },
          { field: 'current',          header: 'Signed in', schema: { type: 'boolean' }, width: 'narrow' },
          { field: '$entry.updatedAt', header: 'Last synced',
            schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
          // NOTE (found while building 108.11): `timestamp` is NOT in
          // `PARAM_KINDS` today — the vocabulary has `duration` for a span and
          // nothing for an instant, so `checkDeclaredSchema` would fail this
          // column at verify. Step 108.7 adds the kind and its formatter; until
          // it lands the pack ships a bare `{ type: 'number' }`.
        ],
      },
      toolbar: ['sync'],
      rowActions: ['switchTo'],
      empty: { title: 'No accounts read yet', hint: 'Run “Sync accounts” to read the switch-account sheet on each device.' },
    },
  },
  actions: {
    sync:     { kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest', target: 'picker' },
    switchTo: { kind: 'job',   label: 'Switch to this account', script: 'tiktok/switch-account@latest',
                device: 'row', params: { target: { $row: 'username' } },
                confirm: 'Switch this device to the selected account?' },
    // `confirm` is a plain sentence, NEVER a template. An earlier draft of this
    // example wrote `@{{username}}`, which §3.4 forbids — bindings are the one
    // way a declared value reaches an action, and a second, weaker interpolation
    // path for one field would undo that. `ActionRunner` (108.7) names the target
    // itself, from the view's own `rowKey`, so the operator still sees which
    // account and which device they are confirming.
  },
}
```

### 4.4 Tier B — the iframe

> **Removed by plan 111 §3.6 on 2026-08-17, hours after it shipped — see the note at the top of this plan.** Nothing described in this section exists in the code: no `frame` member on `ViewSpecSchema`, no `FrameView`, no `frame-rpc`, no CSP on the asset route. It is kept verbatim because it is an accurate record of what was built and of the reasoning that was then overturned, and because §9 Q4 below only makes sense beside it. The asset route and the package's `ui/` directory it describes did survive, and now carry a tier-C React module instead.

A `frame` view renders `<iframe sandbox="allow-scripts" srcdoc=…>` served from `GET /api/plugins/:name/ui/*` with a strict CSP (no external hosts, no `allow-same-origin`). Studio injects its design tokens as CSS custom properties on the frame's root, plus a minimal reset — so colours, spacing, radius, and typography match. Components do not cross; that is the stated cost (§3.2).

The frame talks to the host only through a typed `postMessage` RPC mapping **exactly onto the same declared actions and data sources** a tier-A view uses (`data.query`, `action.run`). It gets no ambient fetch, no cookies, and no token. A plugin cannot reach anything through the frame that it could not have declared in tier A — the frame changes the *rendering*, never the *authority*.

### 4.5 REST

| Method + path | Permission | Returns |
|---|---|---|
| `GET /api/plugins/ui` | `script.view` | `{ items: [{ plugin, version, origin, nav }] }` for active plugins + dev slots (flagged) |
| `GET /api/plugins/:name/view/:viewId` | `script.view` | `{ view, actions }` — only the actions this view references |
| `GET /api/plugins/:name/ui/*` | `script.view` | tier-B assets from the package's `ui/`, strict CSP, no directory traversal |
| `GET /api/plugins/:name/data/scan?key=…` | `plugin.data` | one row per device (`stableId`, the six allowlisted fields, `entry \| null`), secrets redacted, keyset-paged |
| `GET /api/plugins/:name/data?scope=…&prefix=…` | `plugin.data` | the plugin's own namespace, paged |
| `PUT /api/plugins/:name/data/entry` | `plugin.data` | write; namespace forced |
| `DELETE /api/plugins/:name/data/entry` | `plugin.data` | delete; namespace forced |
| `GET /api/plugins/:name/data/count` | `plugin.data` | `{ global, device }` — what the Remove dialog needs (P4) |
| `POST /api/plugins/:name/action/:actionId` | per action kind (§3.7) | executes a declared action server-side |

**Why actions execute server-side.** Three reasons, each otherwise a hole: a `batch` needs a concrete `scripts.id` while a `job` takes a ref (G7) — resolving that in the browser would duplicate `registry.resolve`; the binding evaluation must be identical to what was verified; and the audit entry should name the plugin and action, not just "a job was created". The browser sends `{ actionId, row?, form?, deviceIds? }`.

### 4.6 Files

```
packages/protocol/src/
  plugin-surface.ts              NEW — the vocabulary
  api/plugins.ts                 + PluginUi/PluginView/PluginDataScan responses
                                 + VerifiedScriptSchema gains resultSchema/runtime/title/description (P7, P8)
packages/sdk/src/plugin.ts       + `surface`, + author-time validation
packages/core/src/
  plugins/package.ts             NEW — read/write the .enkaku tar.gz, entry allowlist (reuses backup/tar.ts)
  plugins/verify-child-entry.ts  + report `surface`; + member title/description (P8)
  plugins/verify-child.ts        + independent re-validation; E_PLUGIN_SURFACE_INVALID
  plugins/runtime.ts             + surface persisted in `plugins.manifest`; + `surface(name)`
  plugins/surface-registry.ts    NEW — merge active plugins' + dev slots' nav; resolve a view
  plugins/action-executor.ts     NEW — evaluate bindings, dispatch, audit
  plugins/binding.ts             NEW — the closed evaluator (pure, DOM-free, depth-capped)
  api/plugins.ts                 + the nine routes
  auth/acl.ts                    + `plugin.data` (OPERATOR)
packages/studio/src/
  app/plugins/view/page.tsx      NEW — the one page every plugin view renders through
  app/plugins/page.tsx           + Install dialog (P1), Disable (P2), Drop dev slot (P3), delete-data checkbox (P4)
  components/plugin-view/ViewRenderer.tsx   NEW — table + toolbar + row actions
  components/plugin-view/FrameView.tsx      NEW — tier B: sandboxed iframe + postMessage RPC
  components/plugin-view/ActionRunner.tsx   NEW — confirm → form → POST → toast → refresh
  components/plugin-view/planColumn.ts      NEW — adapter onto planField/formatValue only
  components/layout/AppShell.tsx            + the plugin nav group
plugins/tiktok-automation-pack/src/
  sheet.ts                       NEW — sheet navigation, extracted from switch-account.ts
  list-accounts.ts               NEW — the scrape member
  switch-account.ts              resolve a username through the stored list; use sheet.ts
  index.ts                       + the member, + the `surface` block
```

### 4.7 The end-to-end flow

```
sidebar “TikTok accounts”   (GET /api/plugins/ui, injected by AppShell)
  → /plugins/view?name=tiktok&view=accounts
  → GET /api/plugins/tiktok/view/accounts          ViewSpec + its two actions
  → GET /api/plugins/tiktok/data/scan?key=accounts one SQL: kv_entries ⋈ devices
  → ViewRenderer flattens itemsAt, plans each column via planField, renders Studio's own <Table>

“Sync accounts” → TargetPicker → POST /api/plugins/tiktok/action/sync
  → registry.resolve('tiktok/list-accounts@latest') → scriptId → createBatch()   ← existing path
  → each job: navigate the sheet, parse rows, ctx.kv.device.set('accounts', …)

row “Switch to this account” → POST /api/plugins/tiktok/action/switchTo
  → binding { target: $row.username } → JobService.enqueue({ scriptRef, deviceId, params })
  → the script reads ctx.kv.device.get('accounts', schema) to resolve username → slot
```

Five of the eight hops are existing, unmodified code paths.

---

## 5. Implementation steps

**108.1 — The vocabulary and the author-time contract.** `plugin-surface.ts`; `surface` on `PluginDefinition` with `definePlugin`'s validation. *Result:* a bad surface throws on the author's machine before any network call.

**108.2 — The `.enkaku` package.** `plugins/package.ts` over `backup/tar.ts`; entry allowlist; `POST /api/plugins` accepts either a raw bundle (unchanged) or a package. *Result:* one file installs a plugin with its UI assets.

**108.3 — Verify, and the two schema gaps.** Report and re-validate `surface`; `checkDeclaredSchema` on every embedded schema; `E_PLUGIN_SURFACE_INVALID`; persist into `plugins.manifest`; `VerifiedScriptSchema` gains `resultSchema`/`runtime`/`title`/`description` (P7, P8). *Result:* a broken surface reaches `failed` and registers nothing; existing packs verify byte-identically.

**108.4 — `plugin.data` and the data routes.** The permission; `/data`, `/data/entry`, `/data/count`, `/data/scan` with the namespace forced from `:name` and refused unless the plugin is active or has a dev slot; `redactEntry` on every response; `/data/scan` as one left-joined statement, keyset-paged. *Result:* an operator, not an admin, can read and write one plugin's namespace and nothing else.

**108.5 — Bindings and the action executor.** `binding.ts` (pure, total, depth-capped); `action-executor.ts` calling `JobService.enqueue`/`createBatch`/`KvStore` — never its own SQL; `POST .../action/:actionId`, gated per kind, audited as `plugin.action`.

**108.6 — The surface registry and the read routes.** Merge active + dev nav (dev flagged; a dev slot shadowing an active plugin of the same name wins, matching plan 82's own precedent); `GET /api/plugins/ui`; `GET .../view/:viewId`.

**108.7 — Tier A renderer.** `planColumn.ts` (adapter only); `ViewRenderer`; `ActionRunner` (`ConfirmDialog`, `SchemaForm`, `TargetPicker`, `useAction`); `app/plugins/view/page.tsx` with all three states plus the inactive-plugin error.

**108.8 — Sidebar injection.** `AppShell` fetches `/api/plugins/ui` alongside the count it already fetches (G8); a separate labelled group below the static nav; icons from the allowlist; a `DEV` chip on a dev-slot entry; collapsed mode shows the icon with a tooltip. The existing orphan test stays untouched.

**108.9 — Close the four parity gaps.** Install dialog with the §3.10 consent step (P1); Disable/Enable (P2); Drop dev slot (P3); the Remove dialog fetches `/data/count` first and offers an explicit "also delete this plugin's stored data (N global, M device entries)" checkbox wired to `deleteKv=1`, replacing the current copy that points at a panel which cannot do the job (P4).

**108.10 — Tier B, the iframe.** `GET .../ui/*` with the strict CSP; `FrameView` with the typed postMessage RPC mapping onto the same declared actions and data sources; token injection.

**108.11 — The TikTok Accounts pack.** Extract `sheet.ts`; add `list-accounts` writing `ctx.kv.device.set('accounts', { version: 1, accounts, readAt })`; teach `switch-account` to resolve a username through the stored list, falling back to today's behaviour when there is none; register the surface from §4.3.

**108.12 — The parity guard, docs, spec.** A test reading `api/plugins.ts`'s registered routes and asserting each has a Studio call site (opt-out only with a named reason) — the same "read the source and fail on a gap" shape the orphan check already uses. `docs/spec.md` §11.6/§12/§19; `docs/design.md` gains "Plugin views" with the one-resolver rule; `packages/sdk/README.md`.

---

## 6. Acceptance criteria

1. A plugin declaring no `surface` verifies, activates, and runs byte-identically to before this plan.
2. `definePlugin` throws on the author's machine for: a nav entry naming a missing view; an action reference naming a missing action; a duplicate nav id; an unknown icon; any cap exceeded.
3. A plugin whose surface fails verification is `failed` with `E_PLUGIN_SURFACE_INVALID` and its verbatim message, registers **zero** scripts, and changes nothing about any other plugin.
4. An embedded JSON Schema violating `checkDeclaredSchema` fails verification, naming the limit.
5. A `.enkaku` archive with an entry outside the allowlist is refused at verify, naming the entry.
6. `GET /api/plugins/ui` lists active plugins and dev slots only — never staged/failed/superseded/disabled.
7. The sidebar shows the plugin's entry in its own group; collapsed it is an icon with a tooltip; a dev-slot entry carries a `DEV` chip.
8. `/plugins/view?...` renders through Studio's own `Table`, and handles loading, empty, and error.
9. A plugin disabled while its view is open renders an error naming the plugin, not an empty table, and its nav entry disappears.
10. `GET .../data/scan` returns one row per device including devices with no entry, exposes exactly the six allowlisted device fields, redacts secrets, and pages.
11. A caller with `plugin.data` but not `kv.manage` can use every `/api/plugins/:name/data/*` route and is refused by every `/api/kv` route.
12. No request shape reaches a namespace other than the `:name` in the path — tested with `../`, an absolute value, and a non-existent plugin.
13. A binding evaluates every declared form, refuses depth beyond the cap, and is tested with no DOM and no React import.
14. A `batch` action resolves `name@latest` to a concrete `scripts.id` server-side; a `job` action passes the ref through.
15. Every action execution writes one audit row naming the plugin, the action id, and the resolved target.
16. A tier-B frame cannot reach any API the plugin did not declare: it has no same-origin access, no token, and its RPC maps only onto declared actions and data sources.
17. Install (P1), Disable (P2), Drop dev slot (P3), and delete-stored-data-on-remove (P4) are all reachable, and the Remove dialog states the real entry count before asking.
18. The install dialog shows title, description, and declared scripts, and requires an explicit confirmation.
19. The route-parity test passes.
20. `tiktok/list-accounts` writes a device-scoped entry readable by `tiktok/switch-account` in a later job (G2, asserted directly), and `switch-account` still accepts a bare position with no stored list.
21. `bun run typecheck`, `bun test`, `bun run --cwd packages/studio test` green; `bash scripts/check-plan-status.sh` exits 0.

## 7. Test plan

**Unit (pure, no DOM)** — `binding.test.ts` (every form, nesting, depth cap, unknown key refused); `plugin-surface.test.ts` (every schema and cap); `plugin.test.ts` (the five author-time refusals); `package.test.ts` (round-trip, allowlist, traversal attempt); `surface-registry.test.ts` (active only, dev flagged, dev shadows active).

**Core integration (real DB, real registry)** — `verify-child.test.ts` (a surface fixture verifies; four malformed ones fail with the right code; a no-surface fixture unchanged); `api/plugins-surface.test.ts` (all nine routes, the permission split of criterion 11, the namespace-forcing of criterion 12); `action-executor.test.ts` (job vs batch resolution, audit rows, a refused permission); `data-scan.test.ts` (`includeMissing`, redaction, paging, a 200-device timing assertion).

**Studio** — `ViewRenderer.test.tsx`, `FrameView.test.tsx` (sandbox attributes, RPC refuses an undeclared action), `ActionRunner.test.tsx`, `app/plugins/view/page.test.tsx`, `AppShell.test.tsx` (plugin group; unknown icon falls back; orphan test unchanged), `app/plugins/page.test.tsx` (Install, Disable, Drop, remove-with-data).

**Manual smoke (`ENKAKU_TEST_DEVICE=1`)**
```bash
bun run dev ; bun run dev:studio
bun run --cwd packages/sdk dev plugins/tiktok-automation-pack/src/index.ts --farm http://localhost:7700
# → sidebar shows “TikTok accounts” with a DEV chip
# → open it: empty state → row → “Sync this device” → rows appear
# → row → Switch to this account → confirm → the phone switches
ps -Ao pid=,command= | grep -i "[o]penpf"    # DoD item 7

# NOTE (found while building 108.5): the toolbar's “Sync accounts” is a BATCH,
# and plan 82 §3.5 refuses a dev-slot script as a batch target — a batch pins a
# reference and must survive the laptop closing, while a dev slot expires after
# 30 idle minutes, so a paced batch can outlive the entry it was enqueued
# against and die mid-run. An earlier version of this smoke test used it and
# would have failed with `script_is_dev`. The per-device `syncOne` row action
# (a job, which takes `allowDev: true`) is what makes the dev loop work; the
# batch is exercised against a PUBLISHED pack:
#   bun run --cwd packages/sdk publish plugins/tiktok-automation-pack/src/index.ts
#   # activate on /plugins → Sync accounts → pick devices → rows appear
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The vocabulary is too small for the first real plugin. | The TikTok pack is built in this same plan (108.11), so the vocabulary is proven against a real case before it is frozen — and tier B is the escape hatch, built here rather than promised. |
| The vocabulary grows unboundedly as plugins ask for one more field type. | The one-resolver rule (§3.3) routes field-level requests to `x-enkaku`, which has its own review discipline. Layout requests must displace something or wait. |
| `kv.scan` is slow on a large fleet. | One left-joined statement, keyset-paged, indexed on `(scope, scope_id, namespace, key)`; a 200-device timing assertion is in the test plan. |
| An operator reaches another plugin's namespace. | Accepted and documented (§3.7) — an operator can already run a script in that plugin. Written into the route's doc comment and the spec. |
| A stored shape drifts from its declared columns. | `planResult`'s R3 is reused; a row failing its column schema renders raw rather than disappearing. |
| The action executor drifts from `POST /api/jobs`. | It calls the same functions those routes call; a test asserts both paths produce identical rows for identical input. |
| Two renderers (A and B) is twice the maintenance. | They share ~70% of the backend; only the renderer differs. Tier A is the default and tier B is documented as the exception, so B does not accrete features A should have. |

## 9. Open questions

**Q1 — Should a plugin be able to declare a panel on an existing screen (a tab on the device page)?**
Deferred by the owner for MVP (*"nanti boleh tapi untuk MVP sekarang sementara sidebar dulu"*). Recorded so a plugin author does not assume it exists. Worth revisiting once two or more plugins want a per-device view.

**Q2 — When is tier B the right choice rather than tier A?**
Both are built, so the risk is no longer "can we", it is "which". Proposed rule, to be agreed: **tier A unless the layout genuinely cannot be a table or a form.** Without a written rule, tier B becomes the default by convenience and Studio slowly stops looking like one product. *(Recorded, 2026-08-17, step 108.12: written into `docs/design.md`'s new "Plugin views" section and `packages/sdk/README.md` as the rule of record, with the cost that motivates it stated beside it — a frame inherits tokens and no components. Still open as a decision the owner may revise; it is now at least written down rather than assumed.)*

---

*The two entries below are not design questions from the planning conversation — they are **findings from the build**, recorded here on 2026-08-17 (step 108.12) so the next person meets them as known state rather than as a surprise.*

**Q3 — A tier-B screen cannot be iterated with `enkaku dev`.**
A dev slot is built from a **bundle**: `enkaku dev` (`packages/sdk/src/cli/dev.ts`) posts `{ name, bundle }` to `POST /api/plugins/dev`, and `POST /api/plugins` is the only route that accepts a `.enkaku` archive at all. So a dev slot structurally carries no `ui/` payload, and `runtime.uiAsset` compounds it from the other side — it resolves through `activeImpl(name)`, the ACTIVE published row, and never consults the dev slots. The result: a `frame` view under `enkaku dev` resolves its view spec fine (the surface registry does merge dev slots) and then answers `ui_asset_not_found` for every asset it asks for.

Tier A is unaffected and iterates normally — this is a tier-B-only gap. **A tier-B view must be exercised against a published package**, which is the same shape the batch-vs-dev-slot note in §7's smoke test already describes for `sync`:

```bash
bun run --cwd packages/sdk publish plugins/<pack>/src/index.ts   # then activate on /plugins
```

Fixing it means teaching `enkaku dev` to build and push a **package** rather than a bundle — `POST /api/plugins/dev` gaining the same `content-type` branch `POST /api/plugins` already has, `putDevSlot` carrying a `ui` payload into the asset store under the slot's own key, and `uiAsset` falling back to a dev slot when one shadows the active row (the shadowing precedent already exists in the surface registry). Named here, not built: it is a self-contained change and nothing in this plan depends on it.

**Q4 — `data` beside `frame` was refused, and is now allowed. This was a design correction, not a relaxation.**
An earlier reading of §4.2's *"Mutually exclusive with `data`/`table`"* put `data` in the tier-A half and refused it beside a `frame`. That reading was wrong, and it was wrong in a way that made tier B useless rather than merely strict: a frame with no declared source had nothing the RPC could legally read, so `data.query` answered `no_data_source` forever — and since the frame's own CSP sets `connect-src 'none'`, it has no fetch of its own to fall back on. Tier B could therefore only ever hold static markup, which defeats the entire reason §3.2 approved it (a *layout* the vocabulary cannot draw, never a plugin with nothing to show).

`validatePluginSurface` now requires exactly one **renderer** — `table` or `frame`, never both and never neither — while allowing `data` with either, and `table` still requires `data` (a table with no rows to draw is an authoring mistake, not a design). The authority story is unchanged, which is what makes this safe rather than a widening: a frame reads through the **same** declared source a table would, over the same RPC, and can reach nothing else. Declaring a source widens what a frame may READ to exactly what the author wrote down — which is the whole contract §4.4 claims for it.

§4.2's inline comment above still carries the old wording; it is left as written (this document records the design conversation as it happened) and this entry is the correction of record. `packages/protocol/src/plugin-surface.ts` carries the same reasoning at the line that enforces it.
