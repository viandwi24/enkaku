# Plan 72 — M37 : Studio Stops Guessing What the Core Returns

> Status: implemented — `packages/protocol/src/api/` (21 new files: `pagination.ts`'s `pageSchema()`, `json-schema.ts`, and one file per route group — `agents`, `connectors`, `threads`, `blobs`, `capabilities`, `devices`, `jobs`, `scripts`, `batches`, `schedules`, `clusters`, `notifications`, `webhooks`, `settings`, `adb`, `auth`, `tools`, `transfer`, `tags`, `monitor`, `workspace`) declares every response envelope Studio reads, built from the entity schemas already in `@enkaku/protocol` rather than duplicating them, and re-exported through the package barrel. `packages/studio/src/lib/actions.ts`'s `api<S extends z.ZodType>(path, schema, init)` makes the schema a required positional argument — `return body as T` is gone (`grep -rn "as T" packages/studio/src/lib/actions.ts` finds nothing but a doc comment describing the OLD behaviour) — and a mismatch throws `BadResponseError` (`code: 'E_BAD_RESPONSE'`, naming the path and `z.prettifyError`'s issues), unwrapped by `useAction` exactly like any other action failure so it reads as a page bug, never a network error. Plan 42's POST-when-`json` default, explicit-method precedence, and `{error}` unwrapping are unchanged and re-asserted in `actions.test.ts` (9 tests). All 99 original `api<T>()` call sites were migrated in one pass across ~45 files (two coordinated background agents plus the primary session), and two MORE untyped call sites the initial 99-site survey had missed (`BulkForgetDialog.tsx`, `DiscoveredTray.tsx` — neither was in any agent's assigned list) were found only because the new signature turns a forgotten schema into a `tsc` error, not a silent pass: `bash scripts/typecheck.sh` was the mechanism that caught them, fixed in final reconciliation. `packages/core/src/api/cap.ts`'s `GET /` returns `{capabilities: [...]}` instead of a bare array (the plan's own motivating bug), proven end-to-end by `cap.test.ts`'s new integration test — boots the real Hono route, no mocked `fetch` anywhere, parses the actual response through `ListCapabilitiesResponseSchema` — verified BY HAND to go 5 pass/4 fail when `cap.ts` is reverted to `c.json(items)` and back to 9 pass/0 fail restored (criterion 9). A same-purpose Studio-side component test (`agents/detail/page.test.tsx`) exists too, but on its own does NOT prove criterion 9 — it mocks `fetch`, so it never touches the real route at all; the `cap.test.ts` integration test is what actually closes that loop, and is the one to trust.
>
> **Criterion 6 (core routes typed by their envelopes, so drift is a typecheck failure): `packages/core/src/api/typed-json.ts`** — `typedJson(c, schema, data, status?)` is a TYPE-ONLY tie (`schema` is never called at runtime; `data: z.output<typeof schema>` is what does the work) wired into every core route whose response has a matching protocol envelope: `agents.ts`, `threads.ts`, `cap.ts`, `blobs.ts`, `connectors.ts`, `devices.ts` (partial — see below), `jobs.ts`, `batches.ts`, `schedules.ts`, `clusters.ts`, `notifications.ts`, `webhooks.ts`, `settings.ts`, `adb-stats.ts`, `adb-endpoint.ts`, `doctor.ts`, `tags.ts`, `transfer.ts`, `nodes.ts`, `scripts/routes.ts`, `tools/routes.ts`, `auth/routes.ts`, `server/http.ts`'s `/api/health`. Proven the same way as `cap.ts`: reverting a wired route to its bare pre-envelope shape produces a real `tsc` error ("Property 'X' is missing..."), not just a runtime surprise. Routes left UNWIRED, and why: several have no Studio-facing envelope at all (`devices.ts`'s `/refs`, `/discovered`, list, `/:id/drivers`, `/:id/cluster`, delete, block; `schedules.ts`/`clusters.ts` list routes — no `SchedulesPageResponseSchema`/`ClustersPageResponseSchema` exists in protocol, Studio composed them locally with `pageSchema()` instead; several `{ok:true}`-only routes needing no schema at all) — deliberately not invented mid-pass, consistent with "derived from what the routes actually return today, not assumed." `device-events.ts` was left entirely alone: its keyset envelope is spread together with legacy `events`/`nextBefore` compat keys ("kept for one release" per an old note, arguably stale — out of scope here). `packages/core/src/api/guest-agent.ts` and `packages/core/src/jobs/` were correctly never touched (Plan 74's territory).
>
> **THE FULL LIST OF RESPONSE SHAPES THAT TURNED OUT WRONG (criterion 3) — not just the one `cap` case the plan opened with:**
> 1. `GET /api/v1/cap` — bare array vs. the `{capabilities: [...]}` every other envelope in the app uses. The plan's own motivating example. Fixed both sides.
> 2. `POST /api/jobs/:id/cancel` — `service.cancel()` returns a bare `JobInfo` (no `result` field); Studio's own migrated call site had claimed the full-`JobDetail` `JobResponseSchema` (an easy mistake — "cancel" reads like "fetch the detail back"). Under Zod 4, `result: z.unknown()` is a REQUIRED key, not an optional one — so this was a live bug that would have thrown `E_BAD_RESPONSE` on every job cancel in production, caught only by hand-testing `z.unknown()`'s runtime behaviour during final reconciliation (no existing test exercised the real endpoint). Fixed: new `JobCancelResponseSchema = {job: JobInfo}` in protocol, both the core route and the Studio call site now point at it, `typedJson`-wired.
> 3. `PATCH /api/scripts/:id` replies `{script: {id, enabled}}`, never a full script row — two Studio call sites (`scripts/page.tsx`, `scripts/detail/page.tsx`) had each independently declared it returns a full row. Found by an agent, fixed with a narrow schema (initially declared twice locally, deduplicated into protocol's `ScriptToggleResponseSchema` during reconciliation and wired core-side too).
> 4. `DELETE /api/scripts/:id` replies `{ok: true}`, not an empty 204. Same treatment — `ScriptDeleteResponseSchema`, centralised and wired.
> 5. `POST /api/schedules/:id/run-now` returns a UNION depending on the schedule's target kind: `{run: {runId, threadId}}` for an agent target, `{batch: BatchInfo}` for a script target. Found and handled with `z.union([...])` at the two Studio call sites (`schedules/page.tsx`, `schedules/detail/page.tsx`).
> 6. `PATCH /api/devices/:id` — the ORIGINAL (pre-plan) call site was `api(path, {method: 'PATCH', json: {...}})`; under the new signature that object was landing in the `schema` parameter position, not `init` — a real bug the type system now catches (any call written this way is a `tsc` error, not a silent miscompile), found and fixed.
> 7. A cluster of call sites had NO type claim at all pre-plan (fully untyped `api(path, init)`): `POST /api/devices/:id/unquarantine`, `FilesPanel`'s push, `AdmitDeviceDialog`'s dismiss, `ForgetDeviceDialog`'s forget and block, `AdbEndpointCard`'s DELETE, `NetworkPanel`'s uninstall, plus (found only in final reconciliation, missed by every agent's assigned file list) `BulkForgetDialog.tsx`'s forget and `DiscoveredTray.tsx`'s dismiss. Not "wrong shape" so much as "no claim ever existed" — the same class of gap the plan exists to close, just never even attempted before.
> 8. `AdmitDeviceDialog`'s tags `PUT` — THIS PLAN'S OWN WRITTEN GUIDANCE to the migrating agent said `z.void()` ("no type argument at all today" ⇒ "pass `z.void()`"); the route actually returns `{tags: [...]}`, and `z.void()` only accepts `undefined` — following the plan's own instruction literally would have turned every SUCCESSFUL tag save into a spurious failure toast. The agent caught this and used `DeviceTagsResponseSchema` instead, correctly deviating from its own brief. Recorded here because the plan itself was wrong, not the implementer.
> 9. `GET /api/devices/:id` (the rich device-detail route) — `battery` is set from `rowToDeviceInfo`'s correctly-typed value and then IMMEDIATELY RE-OVERRIDDEN with the raw `unknown`-typed DB json column a few lines later, so it doesn't structurally satisfy `DeviceDetailSchema`. A pre-existing latent bug this pass's compile-time tie surfaced (the route could not be wired to `typedJson` as a result) but did NOT fix — the fix belongs to whoever owns `devices.ts` next, flagged here rather than silently patched mid-pass.
> 10. `GET /api/scripts/:id` — `row.paramsSchema` is the raw `unknown`-typed json DB column; it does not structurally satisfy `JsonSchemaNodeSchema.nullable()` without a cast. Compile-time friction only (the actual runtime values ARE JSON-Schema-shaped) — left unwired rather than casting.
> 11. `GET /api/health` — `adb.serverVersion` resolves `string | null`; the protocol schema had been written as `z.string().optional()` (no `null`). This one WAS a mistake in the schema itself, not the route — fixed by widening to `.nullable().optional()`, then wired.
>
> **Test infrastructure (§4.4, criteria 7, 8, 10, 11) — and a real deviation from the plan's own described mechanism, found empirically, not assumed:** `happy-dom`, `@testing-library/react`, `@testing-library/user-event` are Studio `devDependencies` only (criterion 11); `zod` was added as a real Studio dependency (`actions.ts` uses it at runtime — the plan's "no new dependency" claim covered `@enkaku/protocol`, not `zod` itself, worth being explicit about). `packages/studio/happydom.ts` registers the DOM; `packages/studio/src/lib/test/render.tsx` (`renderWithApi`/`installApiMock`) and `packages/studio/src/lib/test/nav.ts` (a `next/navigation` stand-in via `mock.module`) are the shared helpers every smoke render and component test uses. The plan's §4.4 says "`bunfig.toml` preloading it for that package only" as if this were simply a matter of scoping a preload array — **reproduced by hand that this does not work**: (a) a nested `packages/studio/bunfig.toml` is NEVER read when `bun test` is invoked from the repo root (verified: added a `console.log` preload probe, ran full and filtered scans from root, it never fired; it DOES fire when the invocation's cwd is `packages/studio`); (b) even a same-file `import '../../../happydom'` at the top of a test file is NOT early enough — `@testing-library/dom`'s `screen` export is a CJS binding computed ONCE at first module evaluation (`typeof document !== 'undefined' ? getQueriesForElement(...) : <a permanently-throwing fallback>`), and reproduced that this fallback wins even for the FIRST, purely synchronous test in a file, regardless of import order, unless happy-dom is a genuine Bun `--preload`; (c) preloading happy-dom GLOBALLY (root `bunfig.toml`) was then tried as the fix and it BROKE 13 existing core tests (`connectors`/`webhooks`/model-cache tests that stub `globalThis.fetch` themselves) — happy-dom's registration installs its own `fetch`/`WebSocket`/etc. and collided with them. The resolution: root `bunfig.toml` now has `[test].pathIgnorePatterns = ["packages/studio/**"]` (matched from the repo root, NOT from `[test].root` — a second thing worth knowing, the pattern base and the scan root are different settings), so `bun test` from the repo root never touches Studio at all; `packages/studio/bunfig.toml`'s own `[test].preload = ["./happydom.ts"]` is what actually works, in a genuinely separate invocation (`bun run --cwd packages/studio test`, added to `packages/studio/package.json` as `"test": "bun test --isolate"`). `--isolate` is ALSO required, not cosmetic: 15+ component test files each call `mock.module('@/lib/ws', ...)` with their own (often incomplete) shape, and Bun's `mock.module` leaks across test FILES within one process by default — without `--isolate` this manifested as `DeviceHeader.test.tsx` (a file that mocks nothing itself) failing with `Export named 'WsRequestError' not found`, entirely dependent on file execution order. `.github/workflows/ci.yml` and `CLAUDE.md`'s Commands section both now state the two-command split explicitly. Verified counts: root `bun test` → 2040 pass / 0 fail across 178 files (core/protocol/adb/toolchain/drivers/scrcpy/sdk/session/node/probe-server); `bun run --cwd packages/studio test` → 302 pass / 0 fail across 56 files (up from 14 pre-existing files, none of which rendered a component — criterion 7 is met by, among many others, `agents/detail/page.test.tsx` and the two dozen new page/component tests the migrating agents and final reconciliation added). Combined: 2342 pass / 0 fail, zero regressions against either sub-suite's own prior state.
>
> **Not done / explicitly out of scope, recorded rather than silently skipped:** items 9 and 10 above (pre-existing/latent, not caused by this plan, need their own fix); the several core routes with no Studio-facing envelope (item list in the criterion-6 paragraph above) were left as plain `c.json` rather than inventing schemas Studio never asked for; `packages/studio/src/lib/api.ts`'s OWN separate raw-`fetch`-plus-`as`-cast helpers (`fetchDevices`, `fetchAllPages`, `fetchTopology`, the guest-agent/network/identity functions) are a related but DISTINCT violation of the same rule this plan is about — they never call `api<T>()` at all, so they were never part of "the 99 call sites," and migrating them is real, valuable, future work this plan did not attempt (§3.4 scope was `api()` call sites specifically). `ScriptToggleResponseSchema`'s two independent local declarations were the only duplicate-schema case found; both are now the same protocol import.
>
> Ships: packages/protocol/src/api/agents.ts
> Depends on: nothing. Land it **before** Plan 73, because 73 is a large UI change and this is what makes a UI change verifiable.
> Spec references: `docs/plans/00-overview.md` §4 (conventions — validate at every boundary, never `as`-cast).

---

## 1. Goals

- Every response Studio reads is **parsed against a Zod schema shared with the core**, so a shape mismatch is impossible rather than merely unlikely.
- The response envelope for each endpoint is declared **once**, in `@enkaku/protocol`, and both sides use it.
- Studio has a **DOM renderer**, so a component that crashes on render is caught by `bun test` instead of by a person opening the page.
- The Tools tab crash is fixed as a **consequence** of the above, not as a patch.

## 2. Non-goals

- Redesigning any screen. That is Plan 73. This plan changes how data arrives and how tests run, and should produce no visible difference except that the Tools tab stops crashing.
- Adding schema validation to the core's *request* handling — it already has it, everywhere, through Zod.
- End-to-end browser tests (Playwright and similar). §9.1.

## 3. Context and design decisions

### 3.1 `api<T>()` is an `as`-cast wearing a generic

`packages/studio/src/lib/actions.ts:44`:

```ts
return body as T
```

The generic parameter is a **claim by the caller**, checked by nothing. There are **99 call sites**. `CLAUDE.md` requires external input to be validated through Zod and forbids `as`-casts; this is the largest single violation in the repo, and it sits exactly at the boundary the rule exists for.

It has already cost something concrete. `GET /api/v1/cap` returns a bare array (`packages/core/src/api/cap.ts:96` — `return c.json(items)`), and the agent settings page asks for an object:

```ts
api<{ capabilities: CapabilityInfo[] }>('/api/v1/cap').then((b) => setCapabilities(b.capabilities))
```

`b.capabilities` is `undefined` on every load, and the Tools section crashes. TypeScript reported nothing, because the claim type-checks against itself. The suite reported nothing, because nothing renders. A person found it.

That is one instance of a class, and patching the one line would leave the class.

### 3.2 The envelope is declared once, and the core uses it too

Fixing only Studio would leave the core free to change a response shape and break Studio silently again. So the envelope moves into `@enkaku/protocol`, where both sides read it:

```ts
// packages/protocol/src/api/agents.ts
export const ListAgentsResponse = z.object({ agents: z.array(AgentSchema) })
export const GetAgentResponse = z.object({ agent: AgentSchema })
```

The core's route returns a value **typed by** that schema, and Studio parses with the same one. A change to either side that the other does not follow becomes a typecheck failure in the same run.

Studio already imports protocol at runtime (`DeviceSettingsSchema` in `settings/deviceSections.test.ts`, `compareSemver` in `ScheduleEditorDialog.tsx`) and `@enkaku/protocol` is already in `transpilePackages`, so this needs no new dependency and no build change. The two-TypeScript rule is untouched: protocol is compiled by the root TS 7 and consumed by Studio's TS 5 exactly as it is today.

`GET /api/v1/cap`'s bare array becomes `{ capabilities: [...] }` — the envelope everything else in the codebase already uses. That is a wire change, and it is safe to make now because the only consumer is Studio's own broken call.

### 3.3 The new `api()` requires a schema

```ts
export async function api<S extends z.ZodType>(
  path: string,
  schema: S,
  init?: RequestInit & { json?: unknown },
): Promise<z.infer<S>>
```

The schema is a **required positional argument**, not an option. An optional one is one a caller forgets, and a forgotten one is exactly today's behaviour with extra ceremony. `z.void()` is the explicit way to say a response has no body, so "I do not care" has to be written down rather than defaulted into.

A parse failure throws `E_BAD_RESPONSE` carrying the path and the Zod issues, and is surfaced to the operator as *"The server returned something this page did not understand"* with the path. That is unambiguous — it is a bug report, not a network error, and it must not be presentable as one.

`api()`'s existing behaviours are preserved exactly: the POST-when-`json`-is-present default from Plan 42 §4.3 (with an explicit `method` still winning), the `{error: {code, message}}` unwrapping, and the toast/pending integration. This is a signature change, not a rewrite — Plan 42 fixed a real bug in that function and none of it is being undone.

### 3.4 Migration is mechanical, and it is done in one pass

99 call sites, one per line, each already naming the shape it wants — the shape simply moves from a type parameter to a value. Doing it incrementally would mean two `api` functions coexisting, and `00-overview` §4's rule is replace, never version.

Where an envelope schema does not exist yet, it is added to protocol. Where a call site's claimed shape turns out to be **wrong** — as the `cap` one is — that is a defect this plan found; it is fixed and listed in the report. §6.3 requires that list, because "we migrated 99 call sites and found exactly one bug" and "we found six" are very different facts about the codebase and both are worth knowing.

### 3.5 A test suite that cannot render is not testing the UI

Studio has fourteen test files and **not one renders a component**. `ToolCallCard.test.tsx` and `ApprovalCard.test.tsx` call a hookless `…View` function directly and inspect the returned element tree, because there is no DOM. That is why `ToolCallCard` was split into a view and a wrapper in the first place — the test shape dictated the component shape, which is backwards.

So the entire class of defect the user found — a crash on render, a double scrollbar, a button that does not exist — is invisible to `bun test`. 2091 passing tests said nothing about any of it, and treating that number as verification was wrong.

`happy-dom` plus `@testing-library/react`, registered through Bun's preload, fixes it:

```jsonc
// packages/studio/package.json → devDependencies
"@happy-dom/global-registrator": "^15",
"@testing-library/react": "^16",
"@testing-library/user-event": "^14"
```

This is a **test-only** addition. It does not touch `00-overview` §3's immutable stack decisions — nothing about Bun, Hono, Next, SQLite, Zod, or the two-TypeScript split changes, and no runtime dependency is added. It is recorded here as a deliberate, argued addition rather than slipped in.

The existing hookless-view split is left alone rather than unwound; it works, and unwinding it is churn for no gain. New tests render.

### 3.6 One test that would have caught the crash

The minimum bar is a **smoke render** per page and per non-trivial component: mount it with a mocked `api`, assert it does not throw and that a known element is present.

That is a low bar deliberately. It is also the bar the Tools crash would have failed, and the whole reason for this plan.

## 4. Technical design

### 4.1 `packages/protocol/src/api/`

One file per route group — `agents.ts`, `connectors.ts`, `threads.ts`, `capabilities.ts`, `devices.ts`, `jobs.ts`, `scripts.ts`, `schedules.ts`, `notifications.ts`, `webhooks.ts`, `workspace.ts` — each exporting the request and response envelopes for that group, built from the entity schemas that already exist. No entity schema is duplicated.

### 4.2 `packages/core/src/api/cap.ts`

`return c.json(items)` → `return c.json({ capabilities: items })`. The one wire change in this plan, and the direct fix for the crash.

### 4.3 `packages/studio/src/lib/actions.ts`

§3.3's signature. `E_BAD_RESPONSE` and its operator-facing copy. Everything else preserved.

### 4.4 Test infrastructure

`packages/studio/happydom.ts` registering the global DOM; `bunfig.toml` preloading it for that package only, so core and protocol tests keep running without a DOM they do not need. A `renderWithApi(ui, {responses})` helper so a component test declares what the core returns rather than mocking `fetch` by hand in every file.

### 4.5 Smoke renders

One per route under `app/` and per component with meaningful branching. Each asserts: it renders without throwing, a known element is present, and the loading and error states render too — a component that crashes only when its fetch fails is the same bug one step later.

## 5. Implementation steps

**72.1 — Envelope schemas in protocol** (§4.1). Derived from what the routes actually return today — read each route, do not assume.

**72.2 — Fix `cap.ts`'s envelope** (§4.2).

**72.3 — New `api()` signature** (§3.3), with Plan 42's behaviours preserved and tested.

**72.4 — Migrate all 99 call sites** (§3.4), recording every shape mismatch found.

**72.5 — Core routes typed by the envelopes** (§3.2), so drift becomes a typecheck failure.

**72.6 — Test infrastructure** (§4.4).

**72.7 — Smoke renders** (§4.5), starting with the agent settings page's Tools section — the one that crashed.

## 6. Acceptance criteria

1. `api()` cannot be called without a schema; the old generic form does not compile.
2. `grep -rn "as T" packages/studio/src/lib/actions.ts` returns nothing.
3. All 99 call sites are migrated in one pass, and the report **lists every response shape that turned out to be wrong**, not only the known one.
4. `GET /api/v1/cap` returns `{ capabilities: [...] }`, and the agent settings **Tools** section renders its capability list.
5. A response that does not match its schema produces `E_BAD_RESPONSE` naming the path, surfaced as a page bug and never as a network error.
6. Each envelope is declared once in `@enkaku/protocol`; changing a core response without changing the schema **fails typecheck**.
7. `bun test` renders real components: at least one test mounts a component through `@testing-library/react` and asserts on the DOM.
8. Every page under `app/` has a smoke render covering its loaded, loading, and error states.
9. Reverting 72.2 makes a test **fail** — the crash is genuinely caught now, not merely fixed.
10. Core and protocol tests still run without a DOM; the preload is scoped to Studio.
11. No runtime dependency is added to Studio; the three additions are `devDependencies`.
12. Plan 42's POST-when-`json` behaviour, explicit-method precedence, and error unwrapping are unchanged, and still tested.
13. `bun run typecheck` passes; `bun test` is green; `bun run build:studio` still produces a working static export.

## 7. Test plan

**Unit — `api()`:** a matching response parses; a mismatch throws `E_BAD_RESPONSE` with the path and issues; `z.void()` for an empty body; Plan 42's cases re-asserted (`json` implies POST, explicit method wins, `{error}` unwrapping).

**Unit — envelopes:** each parses a fixture captured from the real route.

**Component:** the Tools section with a valid list; with an empty list; with a **bare array** (the pre-fix shape) — which must produce a visible, named error rather than a crash. That third case is the regression pin for criterion 9.

**Smoke renders:** every `app/` route, three states each.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. Agents → detail → Settings → Tools → the capability list renders
# 2. temporarily change cap.ts back to a bare array → the page shows a named error, not a blank crash
# 3. every other page still loads unchanged
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migrating 99 call sites in one pass breaks something quietly. | Each site already declares its shape, so the change is mechanical; parsing makes any wrong claim **loud** rather than quiet — the migration's whole effect is to convert silent breakage into named errors. Smoke renders (§4.5) cover every page afterwards. |
| Strict parsing rejects a response an older core sends. | Envelopes are permissive where the entity schemas already are, and the core and Studio ship together as one binary. A field added by a newer core is ignored, not rejected. |
| The test dependencies bloat Studio's build. | They are `devDependencies`; `bun run build:studio` does not include them, and criterion 11 checks it. |
| Smoke renders become a chore that gets skipped. | The bar is one assertion plus "does not throw" (§3.6). It is deliberately low, because low and present beats thorough and absent — which is what exists today. |
| `E_BAD_RESPONSE` reads as a scary error to an operator. | Its copy names it as a page problem with the path, so it routes to a bug report rather than to a retry. It is strictly better than the current silent `undefined`. |

## 9. Open questions

1. Full browser end-to-end tests. They would catch layout and navigation defects that a JSDOM-alike cannot. Much heavier, and this plan's floor should exist first.
2. Should the envelopes be **generated** from the core routes rather than hand-declared? Attractive, and it needs a route-introspection layer the Hono setup does not have.
3. `@enkaku/protocol` currently mixes entities, WS messages, and now REST envelopes. If it keeps growing, splitting it is worth a look — not now.
