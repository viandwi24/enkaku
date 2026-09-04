# Plan 126 — M91 : The plugins list stops shipping every plugin's source code

> Status: implemented — steps 126.1–126.4 all land, 2026-08-26, opened the same day from a field report. **Measured, not estimated: at twenty versions of one plugin the `GET /api/plugins` items payload went from 37,863,310 bytes to 6,790 — a 5,576× reduction**, with a committed test pinning it under 50 KB and a marker-string guard proving no bundle or source text reaches the wire on either read route. The sidebar no longer fetches the plugin list on any WebSocket event (`job.status` included), the Plugins page no longer walks up to 25 device pages on mount, and `GET /` is permission-gated on `script.view` after all four callers were enumerated and confirmed.
> Depends on: plans 108–111 (M73–M76, the plugin series) for the runtime, the manifest and the UI surface; plan 82 (M47) for this route's own history.
> Spec references: §19 (Plugins screen), spec's plugin section for `/api/plugins`.
> Ships: packages/protocol/src/api/plugins.ts

The owner: *"The Plugins menu is very heavy when I open it. It looks like a lot of data is being streamed by the API — it shouldn't all be needed. Manifest, settings schema and so on all at once makes no sense."*

They are right, and the cause is one line. `GET /api/plugins` returns every column of every plugin row — **including `bundle`, the complete built JavaScript pack, ~1 MB per version row.** The protocol schema it answers never declared that column, so Zod strips it on arrival: the browser downloads megabytes and discards them on the next line.

---

## 0. Evidence

### 0.1 The line

`packages/core/src/plugins/runtime.ts:379`:

```ts
const rows = q?.name ? db.select().from(plugins).where(eq(plugins.name, q.name)).all() : db.select().from(plugins).all()
return rows.map((r) => ({ ...r, scriptCount: scriptCountFor(r.id) }))
```

`db.select()` with no argument is `SELECT *`. `PluginView extends PluginRow = typeof plugins.$inferSelect`, the spread carries every column, and `api/plugins.ts:327` serialises the lot. Columns that ride along and are never rendered: **`bundle`** (`db/schema.ts:1865` — *"The single bundle every one of this version's scripts rows points at"*), `source`, `bundleHash`, `resetPackages`.

### 0.2 The wire contract never asked for it

`PluginRowSchema` (`packages/protocol/src/api/plugins.ts:73-89`) declares thirteen fields. `bundle`, `source`, `bundleHash` and `resetPackages` are **not among them**. Zod strips unknown keys silently, so the payload is downloaded, parsed on the main thread, and thrown away. **The protocol already says the bundle is not part of the list; the route simply never applied a projection.**

### 0.3 The size, measured

Built packs, from `bun run build:packs`: `proxy-manager.mjs` 1065 KB, `tiktok.mjs` 899 KB, `mikrotik-routing.mjs` 876 KB, `networking.mjs` 818 KB — **3.6 MB for one version each**, before JSON-escaping (`\n`, `\"`), which grows JS text rather than shrinking it. There is no HTTP compression on this path.

And version history is never collected. From this codebase's own protocol file (`protocol/src/api/plugins.ts:265-268`):

> *"**Why version history needs pruning at all.** It accumulates per publish and nothing ever collects it: the farm this was written for carries **20+ `tiktok` rows and a dozen `networking` ones**."*

20 × 899 KB + 12 × 818 KB ≈ **28 MB of bundle text in one response**, before the other two plugins' versions. Every one of those rows renders as a single `<option>` in a version `<select>`.

### 0.4 It is fetched twice per page open, and again on every job event

- `app/plugins/page.tsx:168` — the page's own load.
- `components/layout/AppShell.tsx:242` — a **second, parallel** fetch of the same route, on every Studio page, to compute one integer: `failedPlugins` (`AppShell.tsx:265`).
- `AppShell.tsx:277` re-fires that load on `device.added`, `device.removed` **and `job.status`**, with no debounce and no `AbortController`. **On a farm running batches this is the full payload re-downloaded several times a second.** Not a timer poll — an event poll, which on a busy farm is worse.

### 0.5 A second `SELECT *`, on the counting path

`runtime.ts:340-341`:

```ts
function scriptCountFor(pluginId: string): number {
  return db.select().from(scripts).where(eq(scripts.pluginId, pluginId)).all().length
}
```

A `SELECT COUNT(*)` written as a full table scan — and `db/schema.ts:942-947` records why that is expensive here: *"the row's own `bundle` column holds the FULL plugin bundle, **identical across every member**"*. Counting tiktok's six scripts reads and allocates 6 × 899 KB. Across twenty versions that is **~110 MB read and discarded to produce twenty integers**, per request. It also runs from `surface-registry.ts:119` on `/api/plugins/ui`, so the **sidebar pays it on every page in Studio**.

### 0.6 The pattern is already in this repo, one directory away

`packages/core/src/scripts/routes.ts:245-254` is an explicit narrow `db.select({ ... })`, with `hasResult: boolean` standing in for a full schema. Its protocol comment (`protocol/src/api/scripts.ts:26-34`) states the rule outright:

> *"a list payload has no business paying for every row's own schema"*

and again at `:53-55` for `workflow`: *"a workflow's full document has no business in a list payload every row of which pays for it."* `api/plugins.ts:607-609` states the same discipline for the `data/scan` route: *"Selected narrowly rather than filtered later, so a seventh field cannot arrive by accident."*

**`/api/plugins` is the one list route in the codebase that never got this treatment.**

### 0.7 The route has no permission gate

`app.get('/')` (`api/plugins.ts:323`) carries no `requirePermission`, unlike its neighbours at `:361`, `:363`, `:409`. Today **any authenticated session can read every plugin's full source.** Not a performance finding, but it is the same line, and §3.4 decides it.

### 0.8 Nothing locks the current shape

- `plugins-kv-protocol.test.ts:56-86` parses through `PluginsListResponseSchema` — Zod strips unknown keys, so **removing them passes unchanged**.
- `plugins.test.ts:169-171, 611-613` asserts only `status` and `length`.
- `app/plugins/page.test.tsx:12-51`'s fixtures **already carry exactly the narrow set**, with no `bundle`. The tests are already written against the payload this plan wants.

## 1. Goals

1. `GET /api/plugins` returns no plugin bundle, source, hash, or reset list — on any row, ever.
2. One list row is a few hundred bytes; a farm with twenty versions of a plugin gets a response measured in kilobytes.
3. The list is fetched **once** per page open, not twice, and is not re-fetched on every `job.status`.
4. `scriptCount` is a `COUNT(*)`, not a materialised scan.
5. The detail page keeps everything it renders today.
6. The route is permission-gated.

## 2. Non-goals

- **Pruning version history.** Real (§0.3) and the protocol file already flags it, but a collector that deletes published versions is its own plan with its own consent questions. This plan makes the history cheap to *list*; it does not delete anything.
- **HTTP compression.** Worth doing farm-wide, not as a workaround for sending data nobody wants.
- **Pagination of the plugins list.** Once a row is ~300 bytes, a farm's whole plugin list is smaller than one of today's rows. Revisit only if a farm ever carries hundreds.
- **Touching the plugin runtime, verification, or the pack format.** Nothing here changes what a plugin *is*.

## 3. Context and design decisions

### 3.1 Project in the query, never filter after

The fix is a narrow `db.select({...})`, not a `delete row.bundle` before `c.json`. The reason is `api/plugins.ts:607`'s own: a filter after the fact means a new column arrives on the wire by accident the day someone adds one, and nobody notices until a farm feels it. A projection fails closed — a new column is invisible until someone deliberately adds it to the list.

### 3.2 `manifest` gets projected too, but stays a manifest

The list renders exactly two things out of `manifest`: `scripts[].id`/`.title` (the declared-count and the search index) and one boolean derived from `service` (`page.tsx:509`'s chip). It renders **nothing** from `surface`, and nothing from `scripts[].paramsSchema`/`resultSchema` — which are full JSON Schemas, per script, per version.

So the list carries `declaredScripts: { id, title }[]` and `hasService: boolean`, mirroring `ScriptListItemSchema`'s `hasResult` exactly. `manifest` itself stays on the detail route.

### 3.3 The detail page moves to the detail route

`app/plugins/detail/page.tsx:119` fetches `GET /api/plugins?name=<name>` — the list route — and reads `manifest.surface`/`manifest.service` from it. That is why the list carries them at all. `GET /api/plugins/:name/:version` already exists (`api/plugins.ts:899`) and returns one row; detail moves there. **This must land in the same step as §3.2**, or the detail page silently loses its surface panel.

### 3.4 The permission gate is `script.view`, and it is a fix not a feature

Reading a plugin's identity is reading what can run on the farm. `script.view` is the permission the scripts list already uses for the equivalent question. It is added here because §0.7's hole is real and this plan is already editing the line — but the worker must **enumerate every caller first** (`AppShell`, the plugins page, detail, the surface registry, any plugin-host code) and confirm each one holds it, because a gate that breaks the sidebar for a viewer-role operator is a worse bug than the one being fixed.

### 3.5 The sidebar should not download the plugin list to count failures

`AppShell` needs one integer. Options: add `failedPlugins` to `GET /api/health` (which the shell already polls), or gate the existing fetch to `device.added`/`device.removed` only. **Prefer the health field** — it removes the fetch rather than making it rarer, and the `job.status` re-fetch is the unbounded one. If the health route turns out to be the wrong home, narrowing the event list is the acceptable fallback, and the reason must be written down.

## 4. Technical design

### 4.1 `PluginListItemSchema` (new, `packages/protocol/src/api/plugins.ts`)

Beside `PluginRowSchema` — not replacing it; the detail route keeps the full shape. Mirrors `ScriptListItemSchema`'s relationship to `ScriptResponseSchema`.

```ts
export const PluginListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string(),
  status: PluginStatusSchema,
  verifiedAt: z.number().nullable(),
  verifyError: z.string().nullable(),
  verifyErrorCode: z.string().nullable(),
  scriptCount: z.number().int(),
  /** What the list renders out of `manifest.scripts` — id and title, never a params or result schema (§3.2). */
  declaredScripts: z.array(z.object({ id: z.string(), title: z.string() })),
  /** The one bit `manifest.service` contributes to this screen: the "service" chip. */
  hasService: z.boolean(),
  createdAt: z.number(),
  createdBy: z.string().nullable(),
})
```

### 4.2 The two queries

`runtime.ts:379` — an explicit column list; `bundle`, `source`, `bundleHash`, `resetPackages` are absent by construction.
`runtime.ts:340` — `db.select({ n: sql\`count(*)\` }).from(scripts).where(...).get()`, the pattern `api/plugins.ts:578-581` already uses.

`listImpl`'s other consumer, `surface-registry.ts:119`, reads only `.status`/`.name`/`.version` — verify before changing, and say so.

## 5. Implementation steps

**126.1 — Stop shipping the bundle (the whole win, smallest diff).**
- [ ] `runtime.ts:379` narrow projection; `runtime.ts:340` `COUNT(*)`.
- [ ] Confirm `surface-registry.ts:119` still gets what it reads.
- [ ] `api/plugins.ts:899`'s detail route sheds `bundle`/`source` too (it renders neither).
- [ ] A test asserting `bundle` is absent from the list response — the guard that stops it coming back.

**126.2 — The list item shape (§3.2 + §3.3, together).**
- [ ] `PluginListItemSchema`; the route answers it; `declaredScripts`/`hasService` replace the manifest projection.
- [ ] `detail/page.tsx:119` repointed at `GET /:name/:version`.
- [ ] `plugin-list.ts`'s shared `PluginRowWithServiceSchema` split so list and detail stop sharing one type.

**126.3 — Fetch it once.**
- [ ] `AppShell.tsx:242`/`:277` per §3.5.
- [ ] `app/plugins/page.tsx:602`'s `fetchDevices()` becomes lazy — it is up to 25 sequential round trips for a dialog the operator may never open.

**126.4 — The gate.**
- [ ] `requirePermission('script.view')` on `api/plugins.ts:323`, after enumerating callers (§3.4).

### 126.5 — `failedPlugins` on `/api/health`, and the sidebar's plugin fetch goes away

§3.5's preferred answer, deferred during the first pass only because the files belonged to another worker. `AppShell` polls `/api/health` already; with `failedPlugins` on it, the shell's `/api/plugins` fetch is **deleted**, not merely made rarer.

- [x] `failedPlugins: number` on `HealthResponseSchema` (`packages/protocol/src/api/tools.ts`) and on the handler (`packages/core/src/server/http.ts:301`), counted with `COUNT(*)`, never a list-and-length.
- [x] `AppShell` drops the `/api/plugins` request entirely and reads the integer off the poll it already makes. `/api/plugins/ui` stays — it is the nav, it is genuinely needed, and it is small (nav entries only, `surface-registry.ts:112-124`).
- [x] A test that the shell issues **no** `/api/plugins` request at all.

**Landed as `failedPlugins?: number` — OPTIONAL on the schema, and that is a decision, not a shortcut.** Every field on `HealthResponseSchema` is optional for one reason: `app/nodes/page.tsx` parses this document through it, and a Studio bundle newer than the core it is talking to must not lose a whole page over one absent field. `HttpDeps.failedPluginCount` is optional for the matching reason on the producing side (several tests build a minimal `HttpDeps` with no database behind it), and when it is absent the handler **omits** the field rather than sending `0` — "nobody counted" and "counted, none failed" are different answers, and a confident zero would silently suppress a farm-health warning. Studio treats absent as "leave the badge where it was".

The count is `db.select({ n: sql\`count(*)\` }).from(plugins).where(eq(plugins.status, 'failed')).get()?.n ?? 0`, wired in `daemon.ts`'s `createApp({...})`. Verified with `EXPLAIN QUERY PLAN` against the real migrated schema, not assumed: SQLite answers it with `SCAN plugins USING COVERING INDEX idx_plugins_status` — the index (`db/schema.ts:1884`, `(name, status)`) carries `status` and the query needs no other column, so the table rows, and the overflow pages holding their ~1 MB bundles, are never visited. Health is polled, which is why this mattered enough to check. Because the dep is optional, `daemon-wiring.test.ts` pins both the wiring and the `count(*)` — an unwired accessor would otherwise mean a badge that is silently absent forever, with no `/api/plugins` fetch left to fall back on.

### 126.6 — the write routes stop echoing the bundle

`POST /api/plugins` (stage), `POST /:id/verify`, `POST /:id/activate`, `POST /:name/rollback` and `POST /:name/enable` each answer `c.json({ plugin: row })` with a full `PluginRow` — **so publishing sends the ~1 MB bundle up and gets the same ~1 MB straight back down**, and every activate/rollback/enable pays it too. `PluginRowSchema` declares none of those columns, so the client discards them exactly as the list's were discarded.

This cannot be a query projection the way §3.1's was: these handlers legitimately hold the full row (verification needs the bundle). It is a **serialisation-layer projection** — one shared `toPluginWire(row)` applied at every `c.json({ plugin: … })` site, so a new write route cannot forget it by accident.

- [ ] One shared projection helper, used by every route that returns a plugin row.
- [ ] The marker-string guard from 126.1 extended to cover the write routes — the same test shape, because the same class of regression applies.

### 126.7 — splitting further: measured, and NOT warranted

The owner asked whether the plugins API should be split so that "not everything is in one endpoint". Measured against the real packs rather than argued:

| Pack | manifest total | `scripts[]` (the JSON Schemas) | `surface` | `service` |
|---|---|---|---|---|
| tiktok | 22,116 B | 17,392 B | 4,567 B | 157 B |
| mikrotik-routing | 5,506 B | 4,817 B | 538 B | 151 B |
| proxy-manager | 2,495 B | 1,243 B | 528 B | 724 B |

The list route no longer carries `manifest` at all (126.2), so the fleet-scaling problem is already solved. What remains is the **detail** route at 2–22 KB for one plugin, on a page that renders exactly that plugin — that is a correctly-sized response, and splitting it into `/manifest`, `/surface` and `/service` sub-reads would add three round trips and three loading states to save a few kilobytes on one page open.

`GET /api/plugins/ui`, fetched on every Studio page, returns nav entries only and nothing else (`surface-registry.ts:112-124`) — already the narrow shape the spec describes.

**So: no further splitting.** Recorded here with the numbers rather than left as an opinion, so the next person asking the same reasonable question can see what was measured instead of re-deriving it. If a farm ever publishes a plugin with a genuinely huge surface spec, this is the row to revisit.

## 6. Acceptance criteria

1. No response from `GET /api/plugins` contains a plugin bundle, source, hash, or reset list, at any version count — asserted by a test, not by inspection.
2. A farm with twenty versions of one plugin returns a list response in the tens of kilobytes.
3. Opening the Plugins page issues **one** request for the list, not two.
4. A `job.status` message does not re-fetch the plugin list.
5. `scriptCount` is correct and is produced by a `COUNT(*)`.
6. The detail page renders exactly what it renders today, surface panel included.
7. The list route requires a permission, and every existing caller still works — named, not assumed.
8. `bun run typecheck` passes; scoped tests pass for every directory touched.

## 7. Test plan

- A core test that stages a plugin with a large bundle and asserts the list response does not contain it (search the serialised body for a marker string inside the bundle — the honest check, since a shape assertion cannot catch a column added later).
- A test that `scriptCount` still matches a known fixture after the `COUNT(*)` change.
- Studio: the existing `page.test.tsx` fixtures already match the target shape; detail's test updated for the new route.
- Manual: open Studio's Plugins page with the network panel open and read the transferred size before and after. **That number is the acceptance criterion an operator actually feels**, and it is the one the owner should check on their own farm, where the version history is deep.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Detail page loses `surface`/`service` when the list sheds them | §3.3 — same step, not a follow-up. Criterion 6 |
| The permission gate locks out a legitimate caller (the sidebar, the surface registry) | §3.4 — enumerate callers first; criterion 7 names them |
| A future column silently rejoins the payload | §3.1 — projection, not post-filter; plus the marker-string test |
| `COUNT(*)` disagrees with the old `.length` on some edge (soft-deleted rows?) | Check the old query's predicate exactly; a test pins the count against a fixture |

## 9. Open questions

1. **Should version history be pruned?** Out of scope (§2) but the protocol file already calls it out, and a farm carrying 20+ versions of one plugin is carrying 18 MB of dead bundles in SQLite. Worth its own plan, with a consent question: a published version is something an operator may have deliberately kept.
2. **Should the core compress HTTP responses farm-wide?** Not needed for this route once the payload is right, but Studio has other large reads.
3. **Is `script.view` the right permission**, or does plugin listing deserve its own? The scripts list is the closest analogue; a farm that wants operators to run scripts without seeing which plugins exist would need a separate one, and nobody has asked for that.


---

## 10. Notes recorded during execution

**The projection keeps `manifest` in the QUERY and drops it before `c.json()`.** `listImpl` selects the identity columns plus `manifest`, then destructures it away and emits `scriptCount`, `declaredScripts` and `hasService` derived from it. `bundle`/`source`/`bundleHash`/`resetPackages` are absent by construction from both reads, which is §3.1's actual requirement — the expensive columns never leave SQLite, and the one cheap column that feeds three derived fields is read and discarded server-side.

**One deviation from §4.1:** `createdAt`/`verifiedAt` stay ISO strings, not unix seconds. The plan's sketch would have made this a wire-format change to a route this plan only slims down, and `protocol/src/api/plugins.ts`'s own header records that the ISO wrinkle on this route is deliberate (plan 82 §13). Out of remit.

**`AppShell`'s plugin fetch lost its WebSocket subscription entirely**, not just its `job.status` trigger. `device.added`/`device.removed` went too, on the same argument: plugging a phone in cannot make a plugin verify or fail. It now refreshes on `pathname` — human-paced, bounded by clicks, and it still covers the only flow that changes these answers (install/publish/disable on `/plugins`, then navigate away). A comment at the call site says restoring the `job.status` trigger would be a regression, not a fix.

**~~Still owed~~ — done in step 126.5:** `failedPlugins` on `GET /api/health`. `AppShell` polls health already, so with that field the shell's `/api/plugins` fetch is gone entirely rather than merely rarer; `/api/plugins/ui` (the nav) is the only plugin request the sidebar still makes, and `AppShell.test.tsx` asserts the list route is requested zero times, in any spelling. See step 126.5's own notes for the optional-field decision and the query plan.

**Found and deliberately left (§2 boundary):** `POST /api/plugins` (stage), `POST /:id/activate`, `POST /:name/rollback` and `POST /:name/enable` each `c.json()` a full `PluginRow`, so a publish sends the ~1 MB bundle up and gets it straight back down. `PluginRowSchema` declares none of it, so it is discarded on arrival exactly as the list's was. These rows are legitimately loaded in full for other reasons, so the fix is a shared wire projection rather than a query projection — a small follow-up, not this plan.

**A test-harness failure that is NOT a product defect, diagnosed to avoid a false alarm.** `packages/core/src/plugins/verify-child.test.ts` fails 26 of 30 here. The first read of it — including one worker's own report — was that zod's `toJSONSchema` throws and "plugin verification is broken in this working tree". It is not. The tests write synthetic bundles into an OS temp directory (`mkdtempSync(join(tmpdir(), …))`, `:17-23`) and those bundles `import { z } from 'zod'`, which cannot resolve from `/var/folders/…` because there is no `node_modules` above it. The real error is `ResolveMessage: Cannot find package 'zod'`, reduced to `E_PLUGIN_VERIFY_FAILED` by the time it reaches the assertion.

Verified against reality rather than argued: `verifyPluginBundle()` run directly against the two real built packs returns `ok=true` for both, because `bun build` inlines zod into a pack. Plugin verification works; **activating a newly bumped pack on a live farm is safe.** The test needs its fixtures written somewhere module resolution reaches, or its bundles need zod stubbed — worth fixing, unrelated to this plan, and the three files involved are untouched by it.
