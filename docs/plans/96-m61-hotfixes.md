# Plan 96 — M61 : Hotfix Register

> Status: partial — permanently, by design (§1.2). **96.1–96.4 are fixed and verified** as of 2026-08-12 (see below for that pass's counts). **96.5 was added and fixed 2026-08-13** — plan 88's own admit route, `DeviceRegistry`, and cluster-detail call sites were still missing the `discovery.networks`/declared-medium wiring 88.5 had claimed was "confirmed and fixed in the same pass"; see §96.5 for the full account. **96.6 was added and fixed, and 96.7 was added, investigated, and NOT fixed, 2026-08-13** — plan 90 §3.3/§4.5's text ladder: rung 1 (`agent-ime`) was unreachable in every build because `daemon.ts` never passed `withGuestAgentClient` into `createSessionManager` (96.6, fixed); rung 3 (`clipboard`) was confirmed architecturally dead code rather than merely dormant, with a recommendation to remove it and `clipboard.overwritten` left for whoever owns `ws-handlers.ts`/`device-executor.ts`/the protocol package next (96.7, not fixed — see that entry for why). See §96.6/§96.7 for the full accounts and `docs/plans/90-m55-unified-guest-agent.md`'s step 90.5 status note for the product-level framing. **96.8 was added and fixed 2026-08-13** — the removal 96.7 recommended and left undone (rung 3/`clipboard` from the text ladder, `clipboard.overwritten`, and their referrers across `packages/session`, `packages/core`, `packages/protocol`, `packages/sdk`, `packages/drivers`, `packages/studio`, and `docs/plans/90-m55-unified-guest-agent.md` §3.3), now that this pass held every file 96.7 named plus the ones a workspace-wide grep found beyond that list; see §96.8 for the full account. **96.9 was added and fixed 2026-08-13** — step 90.6's own two flagged, unclosed producer gaps: `DeviceInfoSchema.agent` had no producer (`rowToDeviceInfo` never read `devices.agent`, so every chip step 90.6 built read `absent` on every real device) and `GET /:id/guest-agent` was never wired to `AgentProvisioner.status()` (so `versionCode`/`checkedAt`/`attempts`/`nextAttemptAt` and the `outdated`/`failed` states had no producer through that endpoint); see §96.9 for the full account, including a `DELETE`-side follow-on (clearing the persisted row so it cannot go stale) and a workspace-wide R2 guard interaction (a null-check on `appVersion` trips the same guard a real version comparison would — fixed with `?? undefined` instead of `!==`). Verified 2026-08-13 at `bash scripts/typecheck.sh`, `bun test`, `bun run --cwd packages/studio test`, and `bun run --cwd packages/studio build` — see §96.6/§96.7/§96.8/§96.9 for this pass's exact results. **96.10 was added and fixed 2026-08-13** — step 91.4's own flagged gap: `assistedBy` (plan 91's Assist feature) was populated in `api/devices.ts` alone; `api/topology.ts`, `api/clusters.ts`, and `capability/context.ts` still reported `assistedBy: []` on a genuinely-assisted device, the identical defect class 96.5 already named for `heldBy`/`connection.medium`. All three now carry an optional `assistedByOf` accessor and override the field on the `DeviceInfo` `rowToDeviceInfo`/`listDevicesWithTags` already produced, rather than threading a new parameter through those two functions (`registry/device-registry.ts` was out of this pass's file-ownership list). `daemon.ts` itself — held by a concurrent worker at the time — was NOT wired by this pass; see §96.10 for the exact lines still needed and why `assistedByOf: (deviceId) => coControl.assistedBy(deviceId)` is inert-but-correct at `clusterRoutes`/`topologyRoutes`/`capContextDeps` until someone adds them. **96.11 was added 2026-08-13 and NOT fixed, for the identical reason as 96.10** (a different concurrent worker, a different feature, the same `daemon.ts` contention): plan 99 step 99.6's `createWorkflowRoutes` (`POST /api/workflows`, `/validate`, `GET /:name/versions`) exists and is fully tested, but `daemon.ts` never constructs or passes one, so `HttpDeps.workflowRoutes` (made optional for exactly this reason) is always absent in a real build and `/api/workflows/*` 404s through `server/http.ts`'s catch-all; see §96.11 for the two-line fix and `packages/core/src/api/workflows-wiring.test.ts`, which fails by name until it lands. **Both residuals were closed 2026-08-13** by a worker assigned a wiring pass on `daemon.ts` covering exactly the gaps 96.10 and 96.11 named: `assistedByOf: (deviceId) => coControl.assistedBy(deviceId)` now lands at `clusterRoutes`/`topologyRoutes`/`capContextDeps` (96.10), and `createWorkflowRoutes` is now imported and constructed inside `createApp({...})` (96.11) — see each entry's own "Residual closed"/"Fixed" paragraph for the exact verification. **96.12 was added and fixed 2026-08-13** — three Studio surfaces plan 91 step 91.6 either flagged and left (the devices list/Wall's missing `assist.changed` live-patch branch; `WallTile`'s nested `<Link>` inside its own `next/link` root for a `job`/`agent` `heldBy`/`assistedBy` holder) or missed outright (`DevicePicker.tsx` never rendered `assistedBy` at all, not previously named): `app/page.tsx` gained the `assist.changed` branch mirroring `lease.changed`; `HolderBadge` gained an `asLink` prop (default `true`, unaffected elsewhere) so `WallTile` can render a `job`/`agent` holder as a plain `<span>` instead of a nested link, and `WallTile.test.tsx`'s `user`-kind workaround test is joined by two new tests exercising real `job`/`agent` holders directly; `DevicePicker.tsx` gained the missing `assistedBy` badge. See §96.12 for the full account, including one pre-existing, unrelated, and still-open defect it found but did not fix: `DevicePicker.tsx`'s own row nests the same `job`/`agent` `<Link>` inside a `<button>`, which is invalid for the identical reason. `partial` is still the correct status: it means this register is open to the next orphaned defect, not that these entries are outstanding. When a new entry is appended, this line records what is open then — the count above is a snapshot, not a promise that nothing else will ever be found. **Not a new `96.N` entry, 2026-08-13:** plan 99 §4.9/§4.11's own step 99.10 status note had already named its own gap — `app/page.tsx`'s `job.status` WS handler fell back to a full `load()` refetch (`GET /api/jobs?status=running`, validated against `JobInfoSchema`, which carries no `node` field) on every push instead of trusting the pushed payload, silently stripping the exact `node.seq`/`node.total` counter the Wall's "node 2/4" caption needs — so per §2's rule it belongs to that plan, not this register. A prior pass had already fixed it (`page.tsx`'s `job.status` branch now merges `m.payload` in place: append a new running job, replace an existing one by `jobId`, drop one whose status leaves `running`, and resync via `ws.onReconnected(() => void load())` on reconnect, since `/ws` has no snapshot replay) but shipped with no test of its own. This pass added exactly that: `packages/studio/src/app/page.test.tsx` gained a `describe` proving the four merge/removal behaviours through `DeviceCard`'s real "Running a job — view details" link (append, replace-in-place without disturbing a sibling device, remove-on-non-running, and reconnect-refetches), and a new file, `packages/studio/src/app/page.wallNode.test.tsx`, renders the real `Dashboard` → `Wall` → `WallTile` (nothing mocked but `LiveView` and `@/lib/ws`) and asserts a `job.status` push carrying a `node` block actually lands as `"node 2/4"` in the DOM — the end-to-end path `WallTile.test.tsx`'s existing prop-driven unit test could not catch, since it hands `WallTile` the `node`-bearing job as a prop directly rather than pushing it through the page. See `docs/plans/99-m64-workflows.md` step 99.10's own status note for the gap marked closed there. `bun run --cwd packages/studio test`: 824 pass / 0 fail (1853 `expect()` calls, 109 files) — up from baseline 821/0 by exactly the 3 tests this pass added. `bun run --cwd packages/studio build`, run alone as required: succeeded cleanly (30/30 static pages). **96.18 was added and fixed 2026-08-13** — plan 98 step 98.7/98.8's own flagged gap: `runtimeOverride` was built end to end (validated, ceiling-checked, pinned at enqueue by 98.7; composed and sent by Studio's `RunScriptDialog` in 98.8) but `EnqueueBody` (`api/jobs.ts`) and the create-batch body (`api/batches.ts`) never declared the field, so it was silently stripped before `JobService.enqueue()`/`createBatch()` ever saw it — 98.8's own manual smoke check was marked **blocked** on exactly this. Also closed while there: `api/batches.ts`'s `ERROR_STATUS` map never mapped the three runtime error codes to 400 (they fell through to 500 on the batch path); `clusters/dispatch.ts`'s `createBatch()` had no `runtimeOverride` field to source a per-batch override from at all; and `BatchRoutesDeps` had no `farmJobSettings` hook, so even a wired ceiling check could never actually bind against a real farm. The last of those four is reported, not closed — it needs one line in `daemon.ts`, outside this pass's file ownership. See §96.18 for the full account. **96.17 was fixed 2026-08-13** — by a worker
assigned plan 93's step 93.7, as a second task alongside that step's own work
(the recordings review panel is outside step 93.7's own subject matter but
inside its file ownership). The recorded literal never needed inventing: it
still exists, briefly, in the browser tab's own memory between the moment an
operator types "Parameterise" and the moment local state overwrites it, and
is now retained there (never persisted, never sent anywhere) in a
`WeakMap<RecordingStep, string>` keyed on the step's own object identity, so
"Revert to literal" restores it verbatim within the same session. A step
that arrives from the server already parameterised has genuinely nothing to
restore — for that honest case the button is replaced with a separately
labelled "Clear and re-type as literal" action rather than pretending to
revert. See §96.17 for the full account and the two tests that pin both
paths. **96.23 was fixed 2026-08-14**, as plan 100's own step 100.1
(`docs/plans/100-m65-realtime-wall-and-session-parity.md` §3.5) — promoted
from an independent hotfix to that plan's hard prerequisite, since its
primary mechanism (a second concurrent scrcpy session per device) would
otherwise double the exposure of this exact leak. `close()` now sends a
best-effort, scid-scoped `pkill` to the device on every close, and a
boot-time sweep kills every device-side scrcpy process the core does not
recognise as its own before any session is built in that process. See
§96.23 for the full account, the two new exported functions
(`parseScrcpyServerList`/`sweepStrayScrcpyServers`), and this pass's test
coverage; real-hardware confirmation is deferred to the owner (plan 100 §7,
rows H-2 and H-5). **96.31 was fixed 2026-08-17** — Settings was unsavable:
`plan.ts`'s row 9 planned `step: undefined` for any numeric field with no
`.multipleOf()`, `NumberField` then omitted the HTML `step` attribute, and
`type="number"`'s own implicit default is `step="1"` — so `gestureCurvature`
(stored `0.08`, `min(0).max(0.5)`, no `.multipleOf()`) failed the browser's
own native validation on a form the operator had not even touched. The fix is
in the planner (plan 95's `numberBounds`), not the schema: `type: 'integer'`
now plans `step: 1`; `type: 'number'` plans `step: 'any'` unless
`multipleOf` says otherwise — and a NEW, separate `increment` field carries
the +/- stepper's button delta, because `step: 'any'` is a valid HTML
attribute but not a number `NumberField` could keep doing arithmetic with.
See §96.31 for the full blast radius (`lat`/`lng`, `accuracy`, and every
script author's own float parameters, since script forms share this same
planner) and the exact fix. **96.32–96.36 were added and fixed 2026-08-17**,
from `docs/settings-audit.md` (a workspace-wide dead-settings audit written
the same session): 96.32 deletes two farm-wide `adb.*` fields
(`execTimeoutMs`, `maxQueueDepth`) with no reader anywhere; 96.33 — the
audit's highest-severity finding — deletes the farm-wide `defaults.identity`
block, which did not merely sit inert but silently stamped byte-identical
fake GPS/timezone/locale onto every device admitted while it was set,
leaving per-device identity (plan 58) untouched; 96.34 and 96.35 correct two
stale schema doc comments (`video.controlPreset`/`wallPreset` falsely
claimed to override the farm setting; `job.memory.*` falsely claimed
enforcement had not landed) to match the code as it actually behaves; 96.36
fixes `workflow.maxTotalMs`'s publish-time preflight, which silently used
the hardcoded 6h default while the runtime executor enforced an operator's
real setting — the two doc comments describing this gap had it BACKWARDS,
and a routes-half regression guard was added alongside the executor's
pre-existing one. See §96.32–§96.36 for the full accounts.
>

> Two of the four widened once someone looked properly, which is the argument for writing them down rather than fixing them in passing. **96.3** was reported as "a `kind` hint is inert on a nullable field"; the real defect is that a nullable's `anyOf` wrapper carries no `type`/`enum`/`prefixItems`/`format`, so precedence rows 3–13 could never match it on **any** hint — `labels`, `source`, `ordered` and `multiline` were dead there too. **96.4** was reported as seven unreachable `FarmSettingsSchema` blocks; the guard test written to stop a recurrence found an **eighth** (`readiness`) the moment it ran.
> Depends on: none — a register has no build order of its own. Each entry below cites the plan(s) it relates to inline, and stands independently of every other entry.
> Spec references: none — every entry here is a defect in already-specified behavior, not new product surface. This document itself adds no table, endpoint, protocol message, screen, or engine, so plan 00 §7.8's "update `spec.md` or add a `DIV-` row" rule has nothing to trigger on here; an *entry* that did add surface would still owe that update at its own site, not this document's.
> Ships: packages/studio/src/components/schema-form/resolve.ts — carries the prototype-hijack guard recorded as 96.2 below; verified present in the working tree at the time this plan was written.

---

## 1. What this document is, and why it looks different from every other plan

Every other document in `docs/plans/` designs one coherent milestone: a goal, a
design, numbered implementation steps, acceptance criteria, and a status that
is expected to eventually read `implemented`. This one does not, because it
answers a different problem the product owner named directly:

> A bug goes into the plan it relates to and gets fixed there. If no related
> plan exists, make a hotfix plan.

Most defects found while doing other work already have a home — the plan
whose design they violate, or whose steps introduced them — and get fixed
there, never appearing here. §2 lists the recent ones that already have a
home, specifically so nobody "helpfully" duplicates them into this register.
This document collects only the **orphans**: defects with no plan to belong
to.

### 1.1 It accumulates. It is never rewritten from scratch.

New items are appended with the next number (`96.5`, `96.6`, ...), exactly
like `docs/spec-divergences.md`'s `DIV-` rows: never renumbered, never
deleted, never inserted into the middle of the existing sequence. A closed
item stays exactly as recorded rather than being removed once fixed — see the
note at the top of §3 on why an already-fixed item is still worth writing
down.

### 1.2 Why "partial" is this document's correct resting state, not a failure

`scripts/check-plan-status.sh` treats `partial` as a third state, distinct
from `implemented` (everything the plan describes has shipped) and `draft`
(nothing has). For an ordinary milestone plan, `partial` is a stop on the way
to `implemented`. For this one, it is the destination: a register that ever
legitimately claimed `implemented` would be asserting that no further
orphaned defect will ever be found in this codebase again, which is not a
claim anyone can make honestly about software under active development. As
long as this document exists, some fraction of its entries will be freshly
filed and not yet fixed — that is not drift for someone to correct later, it
is this document doing its job. Read the status line as "some entries are
currently open," permanently, rather than as a promise this register is
working toward closing out.

## 2. Already owned — do not duplicate here

The defects below were found recently, during the same stretch of work that
produced this document, and it would be easy for a future pass to see them
again and "helpfully" pull them in. They are not orphans: each already has a
plan whose job it is to fix them. Recording that fact here is the whole
point — a hotfix entry and an owned-defect table row look similar enough
from a distance that the distinction needs to be written down, not assumed.

| Defect | Already owned by |
|---|---|
| `internal:install` via batch bypasses `device.files` and the lease with only `job.run`; `POST /api/jobs` has no `requirePermission` | plan 93 §93.8 |
| Closing a wall tile disconnects a TCP device from adb (`session.ts:379`) | plan 88 (F12) |
| `drainSessions` unwired since M1 (`daemon.ts:278-288`) | plan 88 |
| `LiveView.tsx:389` drops CJK/emoji before any engine sees it | plan 90 |
| `audit.record`'s `meta` written but dropped by `AuditEntrySchema` | plan 91 |
| `POST /api/batches/:id/cancel` leaves running members running | plan 94 |
| Per-device Timing settings read by nothing (`daemon.ts:2087` reads the farm default) | plan 94 (F36) |
| `PATCH /api/settings` cannot clear an optional field | plan 92 (F22) — the renderer half was fixed by plan 95 step 95.2; the server half is still plan 92's |

If one of these turns out, on closer inspection, to actually be an orphan
after all, fix the table row (or remove it) rather than also adding a `96.N`
entry for the same defect — a defect should have exactly one home. The rule
cuts the other way too: an item found the same day as everything above does
not belong in this table just because of when it was found — it belongs
here only if a plan genuinely already owns it.

## 3. Register

Each entry below records what broke, the evidence, how it was found, and
its current status. **An item that is already fixed stays in the register
rather than being deleted once closed** — the entry's value to a future
reader is proof that the fix was deliberate and reasoned, not a guess that
it never happened at all.

### 96.1 — A migration-watermark test that fails on a date, not on a change. FIXED.

**What broke.** `packages/core/src/db/migration-watermark.test.ts` proves the
watermark-repair logic in `runMigrations` by poisoning
`__drizzle_migrations.created_at` above every later journal entry, then
checking the repair still finds and applies the hidden migrations. The
poison value used to be a hardcoded literal, `1786100000000` — a timestamp in
early August 2026, chosen because at the time the test was written it sat
above every migration's own generated timestamp. Drizzle stamps each
migration with `Date.now()` at `drizzle-kit generate` time, not a fixed
value, so that property was only ever true "for now." The first migration
generated after that date pushed the real journal watermark above the poison
literal, and the test's own assertion stopped holding — not because the
repair logic changed, but because the calendar did.

**Evidence.** `packages/core/src/db/migration-watermark.test.ts:44-64` (the
fix, described in full in the test file's own comment at lines 46-53). It
surfaced concretely when plan 95 step 95.8 (named parameter sets,
`script_param_sets`) generated migration `0041_colorful_nick_fury.sql`, whose
Drizzle-assigned timestamp landed past the old literal.

**How it was found.** By the worker whose migration (`0041`) triggered the
failure — worth recording as its own lesson, not just the fix. That worker's
first read of the failure was "unrelated transient, did not reproduce." It
did not reproduce on a retry only because the test had already been repaired
elsewhere in the same working tree by the time the retry ran — the original
failure was real and deterministic, not flaky. A "could not reproduce" report
against a test that was fixed in the meantime is not evidence the original
failure was spurious.

**Fixed.** Yes. The poison value is now derived from a real, fully-migrated
database rather than a literal: `POISON = fullWatermark + 1`, computed once
per test run against a fresh DB migrated to completion. This keeps the
property the test actually needs — "poisoned strictly above every entry that
follows it" — true regardless of what today's date happens to be.

### 96.2 — Prototype hijack through a schema-supplied field name. FIXED.

**What broke.** A script's parameter schema is untrusted input: whoever
publishes a shared script names every field in it, and that schema reaches
the client via `JSON.parse` off the database. `resolve.ts` wrote into the
params object being edited through computed keys — `base[key] = filled` in
`applyDefaults`, `cur[seg] = value` in `setAtPath` — with no check on what
`key`/`seg` was. A schema whose JSON literally contains `"__proto__": {...}`
parses into a real *own* property named `__proto__` (the detail that makes a
`JSON.parse`-built object different from an object literal — see the testing
lesson below). Assigning through a computed `__proto__` key does not create
an own property on the target; it reaches `Object.prototype`'s inherited
setter and replaces *that object's own prototype* with attacker-chosen data.

**Evidence.** `packages/studio/src/components/schema-form/resolve.ts:71`
(`applyDefaults`'s `if (UNSAFE_KEYS.has(key)) continue`), `:96` (the
`UNSAFE_KEYS` set: `__proto__`, `constructor`, `prototype`), and `:122`
(`setAtPath`'s `if (segs.some((seg) => UNSAFE_KEYS.has(seg))) return obj`) —
all three are the fix already in place. Verified narrowly: this is not
global `Object.prototype` pollution (a fresh `{}` created elsewhere in the
same process is unaffected) — it is scoped to the one params object being
written through, which is still enough to make every downstream reader of
that object (`getAtPath` included) answer with values nobody actually
stored.

**How it was found.** While reviewing `resolve.ts`'s computed-key writes as
untrusted-input handling, applying the same "a schema is authored by someone
else" framing plan 95 §3.7 already uses for its publish-time checks.

**Fixed.** Yes, with the `UNSAFE_KEYS` guard described above:
`applyDefaults` skips such a property when filling in defaults; `setAtPath`
refuses the *entire* write rather than silently applying every segment except
the unsafe one, since a half-applied edit would be its own kind of silent
corruption. `checkParamsSchema` also now refuses these names at publish time
(plan 95 §4.9), so a schema written today cannot carry the field at all —
this guard is what covers the schemas already sitting in the database that
were published before that gate existed, the same "reject at publish, clamp
at render" split plan 95 §3.7 uses elsewhere.

**The testing lesson, recorded because it generalizes beyond this bug.** The
first two attempts at a regression test for this passed even with both
guards removed — that is, they proved nothing. The first attempt disabled
only one of the two guards (`applyDefaults`'s), leaving `setAtPath`'s intact,
so the vulnerable path was never actually exercised. The second built its
fixture as a plain object literal, `{ __proto__: {...} }` — but `__proto__:`
inside an object literal is special syntax that *sets* the object's own
prototype at construction time rather than creating an own property named
`__proto__`; the key the guard checks for never existed on that fixture, so
removing the guard changed nothing observable. Only a fixture built with
`JSON.parse` (see `resolve.test.ts`) creates a real own `__proto__`
property, and only with *both* guards disabled does that version actually
fail. The general lesson: a guard that has never been watched fail with the
fix reverted has not been proven — a regression test that passes either way
is not a regression test.

### 96.3 — A `kind` hint on a `.nullable()` field is silently inert. BEING FIXED (another worker, concurrently).

**What broke.** `z.toJSONSchema` wraps a `.nullable()` field as
`anyOf: [{type, ...}, {type: 'null'}]` rather than putting `type` directly on
the node. The schema-form resolver's precedence row 3 (`x-enkaku.kind`
present and structurally valid for the node) calls `baseType()` on that
wrapper node to check the hint — but the wrapper has no `.type` of its own,
only `anyOf`, so row 3 never matches. The field falls through every
structural row to row 14's nullable-unwrap, which re-plans the inner
(non-null) branch on its own with no hints carried over, because `.meta()`
chained after `.nullable()` attaches to the *outer* wrapper and the inner
branch's own hint lookup finds nothing there. The result is not a crash and
not a wrong value — the field still renders, as a plain number box — it is an
author-written `kind` being silently discarded instead of honored or
rejected at publish time.

**Evidence.** Two live instances, both currently carrying an inline code
comment explaining why `kind` was deliberately left off rather than written
as decoration that would do nothing: `job.maxTimeoutMs`
(`packages/protocol/src/settings.ts:545-550`) and
`scheduledAgents.spendCapOutputTokensPer24h`
(`packages/protocol/src/settings.ts:1244-1249`). The resolver mechanism is
`packages/studio/src/components/schema-form/plan.ts` (row 3's `baseType()`
check; row 14's nullable-unwrap).

**How it was found.** While building and annotating the resolver itself,
during plan 95 step 95.4 (grouping/ordering) and step 95.5
(limits/annotations) — recorded in plan 95 §9 as item 7, one of two defects
that plan's own work found and deliberately left in place rather than
folding into an unrelated fix.

**Status.** Being fixed now, by another worker, concurrently with this
document. It lands here rather than staying inside plan 95 because plan 95
§9 explicitly declined to fold it into its own close-out ("recorded here
rather than folded into this plan's close-out... deserves its own
scrutiny") — plan 95's `partial` status is for unrelated reasons (steps
95.10/95.11), not because this item was left open inside it. Per the
owner's rule in §1, a bug with no owning plan gets a hotfix entry, and this
is the first one this defect has had.

### 96.4 — Seven `FarmSettingsSchema` blocks are unreachable from the Farm Settings UI. BEING FIXED (another worker, concurrently).

**What broke.** `discovery`, `monitor`, `shell`, `transfer`, `network`,
`workspace`, and the farm-wide `kv` quota block are real, validated
top-level keys on `FarmSettingsSchema` — an operator simply has no path in
Studio to any of them. `FARM_SECTION_DEFS` (the list `SectionNav` renders as
tabs) and `keysForSection` (which top-level schema keys a given tab's
`FarmForm` pulls and renders) have no entry for any of the seven, so they
are schema-valid and server-enforced but invisible in the UI that every
other farm setting is edited through.

**Evidence.** Schema keys, all real: `packages/protocol/src/settings.ts:804`
(`discovery`), `:840` (`monitor`), `:895` (`shell`), `:1057` (`transfer`),
`:1104` (`network`), `:1142` (`workspace`), `:1178` (`kv`, the farm-wide KV
quota block — distinct from the Studio settings tab also named `kv`, which
renders `KvPanel`, an unrelated feature, not this schema block). Missing
wiring: `packages/studio/src/app/settings/page.tsx:73-103`
(`FARM_SECTION_DEFS`, no `id` for any of the seven) and `:162-179`
(`keysForSection`, whose `if` chain never returns any of the seven keys and
falls through to the `defaults` catch-all).

**How it was found.** By checking `FARM_SECTION_DEFS`/`keysForSection`
against the full property list of `FarmSettingsSchema` while auditing
recently-shipped settings for reachability from Studio — the concrete
trigger being that plan 85's discovery/monitor settings (below) were
confirmed shipped and enforced in code but had never been seen rendered
anywhere.

**The concrete consequence worth stating plainly:** plan 85's
`discovery.scanIntervalSec`, `discovery.offlineGraceSec`,
`discovery.recoveryCooldownSec`, and `monitor.crashWatch` — all shipped in
v0.1.7 — are invisible in Studio today. They are settable only by editing
the config file or the database directly, never through the UI the rest of
farm settings uses. No plan owned this gap: plan 92 was explicitly told
`FARM_SECTION_DEFS` stays as-is, which is presumably how the list drifted
out of sync with the schema without anyone treating keeping them in sync as
that plan's job.

**Status.** Being fixed now, by another worker, concurrently with this
document.

### 96.5 — Plan 88's own "confirmed and fixed in the same pass" claim missed three call sites. FIXED.

**What broke.** Plan 88 step 88.5 found that `discovery.networks` and the
endpoint store's declared-medium map were real, unit-tested code that no
production call site threaded real data into, and its own status line
recorded the fix as "confirmed and fixed in the same pass." That claim was
accurate for the four call sites its own checklist entry actually named
(`daemon.ts:1455`, `capability/context.ts:340,353`, `api/topology.ts:54`,
`api/devices.ts:577`) and incomplete for three more, all computing the exact
`DeviceInfo`/`device.added` payload an operator watches: the admission
route's own broadcast and response body, `DeviceRegistry`'s internal
broadcast and `listDevices()`, and the cluster detail device list. Each one
called `rowToDeviceInfo`/`listDevicesWithTags` with an empty network list (or
no networks argument at all), so `deriveConnection` could only ever read
`mediumSource: 'unknown'`/`'declared'` there, never `'network'` — a device on
a configured wired network badged the honest-but-incomplete `TCP` through
these three paths specifically. The concrete, user-visible consequence: a
device admitted from the Discovered tray badged `TCP` on the `device.added`
broadcast every connected Studio tab renders immediately, then silently
flipped to `OTG`/`WI-FI` the next time Studio issued an ordinary `GET
/api/devices` (which, post-88.5, already read the network/declaration
correctly) — the exact moment an operator is most likely watching, and the
exact symptom 88.5's own "confirmed and fixed" line said could not happen
anymore.

**Evidence.** `packages/core/src/api/devices.ts:388` (the `device.added`
broadcast) and `:393` (the route's own response body) — both called bare
`rowToDeviceInfo(row)`, defaulting `networks` to `[]` and `declaredMedia` to
an empty map, unlike every other route in the same file (`infoWithTags`,
`:500-512`), which already threaded both through.
`packages/core/src/registry/device-registry.ts` — `DeviceRegistryDeps` (the
interface `createDeviceRegistry` takes) had no `networks` accessor at all, so
`onOnline`'s own "new device registered" `device.added` broadcast and the
registry's exported `listDevices()` were both hardcoded to `[]`.
`packages/core/src/api/clusters.ts:181` — `createClusterRoutes`'s deps had
neither `networks` nor `declaredMedia`, so `GET /:id/devices` could badge a
device differently from `GET /api/devices` for the identical row.

**How it was found.** The product owner re-read plan 88's own "confirmed and
fixed in the same pass" claim against the actual call sites 88.5's checklist
entry named, noticed the checklist only listed four, and asked for a targeted
audit of every remaining `rowToDeviceInfo`/`listDevicesWithTags` call site in
the workspace — which turned up these three.

**Fixed.** Yes. `api/devices.ts`'s admit route now calls the same
`infoWithTags(row.id)` helper every other route in the file already uses,
computed once and reused for both the broadcast and the response so neither
can disagree with the other or with a later `GET`. `DeviceRegistryDeps`
gained an optional `networks?: () => FarmNetwork[]` accessor (the same
"read settings live" shape `endpoints` already has), threaded into both the
`device.added` broadcast and `listDevices()`. `createClusterRoutes` gained
optional `networks?: () => FarmNetwork[]` and `declaredMedia?: () => Map<string,
ConnectionMedium | null> | undefined`, resolved once per request (not per
row — the existing N+1 rule at `device-registry.ts:171-175` extended, not
bent) and threaded into `GET /:id/devices`. Proven end to end through the
real HTTP routes and the real broadcast payload — never `deriveConnection` in
isolation — in `packages/core/src/api/devices.test.ts` ("POST
/discovered/:stableId/admit — connection.medium is correct on the FIRST
render"), `packages/core/src/api/clusters.test.ts` ("GET
/api/clusters/:id/devices — connection.medium"), and
`packages/core/src/registry/device-registry.test.ts` ("DeviceRegistry —
networks"). Scoped run of the three touched test files: 146 pass / 0 fail.
Full-workspace verification, 2026-08-13: `bash scripts/typecheck.sh` reports
`core` FAILED, but the four errors are all in `guest-agent.ts`,
`transfer.test.ts`, `daemon.ts`, and `install.test.ts` — a concurrent,
uncommitted `PushOpts`/`mediaScan` change already sitting in this shared
tree, not this entry's files; `bun test` runs 3223 pass / 2 fail (the two
failures are `packages/protocol/src/settings.test.ts`'s `prep.textInput`
case and `packages/core/src/api/transfer.test.ts`'s push-path case, both
read individually and confirmed unrelated — the former is a schema field
mismatch in an unrelated concurrent settings change, the latter is the same
`PushOpts`/`mediaScan` change typecheck already flagged); `bun run --cwd
packages/studio test` runs 624 pass / 0 fail.

One finding narrows the "user-visible symptom" above rather than confirming
all three sites caused it in practice: `DeviceRegistry`'s own "new device
registered" broadcast branch (the `else` of `onOnline`'s `if (existing) {...}
else {...}`) turns out to be unreachable under the current admission gate.
`classify()` (`registry/admission.ts`) only returns `'admitted'` when a
`devices` row for that `stableId` already exists, and `onOnline`'s own
`existing` lookup is the byte-identical query run with no `await` in between
— so `existing` can never be false when this branch runs, meaning it was
already dead code before this fix, not a live source of the badge-flip
symptom. It was still wired for correctness (in case a future change
reintroduces reachability, and for consistency with the reachable `listDevices()`
fix right beside it in the same deps object) and is called out here rather
than silently fixed, per this register's own "widened once someone looked
properly" pattern (96.3, 96.4 above).

**Residual, not closed by this entry.** `daemon.ts`'s own
`createDeviceRegistry(...)` and `createClusterRoutes(...)` call sites do not
yet pass the new `networks`/`declaredMedia` accessors — a one-line addition
at each, mechanically identical to what `daemon.ts` already does for
`deviceRoutes`/`topologyRoutes` a few lines away. Until that lands, the
`DeviceRegistry`/`clusters.ts` halves of this fix are correct but inert in
production (the accessors default to no network match, same as before this
entry); the `api/devices.ts` admit-route half is fully live today, since
`daemon.ts` already passes `endpoints`/`networks` into `createDeviceRoutes`.
`daemon.ts` was out of scope for the worker who fixed this entry (a
concurrent worker held that file); wiring those two call sites is the
mechanical follow-up.

**Residual closed 2026-08-13, by plan 90's step 90.3 worker** (who held
`daemon.ts` for that step's own reasons — the agent provisioner's four hooks
— and picked up these two one-line additions plus a third of the same shape
found alongside them). `createDeviceRegistry({...})` now passes `networks: ()
=> settingsStore.get().discovery.networks`; `createClusterRoutes({...})` now
passes that same `networks` accessor plus `declaredMedia: () =>
loadDeclaredMedia(endpoints)` — both mechanically identical to what
`deviceRoutes`/`topologyRoutes` already had, exactly as predicted above. The
third, found by the same worker while reading this exact entry (recorded here
because it is the identical defect class, not filed as a new `96.N` — it is
the same underlying finding, not a new one): `createGuestAgentRoutes({...})`
had carried an optional `guestAgentSettings` accessor since plan 90 step 90.4
(`FarmSettingsSchema.guestAgent`'s `maxRecoveryCyclesPerHour`/
`recoveryRearmSec`, deeply unit-tested in `api/guest-agent.test.ts`) but
`daemon.ts` never passed it, leaving those two settings correct-but-
unconfigurable in production exactly as 90.4's own status note flagged. Now
passes `guestAgentSettings: () => settingsStore.get().guestAgent`. Verified
by a NEW static-wiring test (`packages/core/src/daemon-wiring.test.ts`, the
same "read the real file, assert the real wiring is there" style
`tools/adb-server-control.test.ts` already uses for an identical class of
problem — daemon.ts has no exported entry point a unit test can drive
directly) asserting all three accessors are present in `daemon.ts`'s actual
source text, plus the pre-existing deep tests in
`registry/device-registry.test.ts`, `api/clusters.test.ts`, and
`api/guest-agent.test.ts` proving the mechanism itself is correct once
wired. `bash scripts/typecheck.sh`/`bun test` both green as of that step's
own pass (see `docs/plans/90-m55-unified-guest-agent.md`'s status line and
its 90.3 section for the full account).

### 96.6 — `SessionManagerDeps.withGuestAgentClient` was declared but never passed by `daemon.ts`, so rung 1 of the text ladder (`agent-ime`) was unreachable in every build. FIXED.

**What broke.** Plan 90 §3.3/§4.5 built a four-rung text-input ladder and an
on-device IME (`EnkakuIme`) specifically so a farm could type non-ASCII text
with no side effect. `resolveTextRoute` only ever returns rung 1
(`agent-ime`) when `agentCapabilities` is non-null, which `applyTextInput`
(`packages/session/src/text-input.ts`) can only learn by calling
`withGuestAgentClient((client) => client.hello())`.
`SessionManagerDeps.withGuestAgentClient` (`packages/session/src/manager.ts:77`)
was declared as an optional field, and `createEntry` (`:191`) forwarded it
correctly whenever present — but `packages/core/src/daemon.ts`'s own
`createSessionManager({...})` call (the core's LOCAL session manager — the
only one that could ever wire it, since a device's guest agent is
local-core-only by design, `packages/node/src/index.ts:221`; the workspace's
other `createSessionManager` call, `packages/node/src/hosts.ts:67`, correctly
has no `withGuestAgentClient` at all and is not this defect) never included
the field. Every session `createSession` ever built in a real deployment
therefore had
`deps.withGuestAgentClient === undefined`, so `applyTextInput` returned early
with `agentCapabilities: null`, and `resolveTextRoute` could never return
anything but rung 2 or below — the on-device IME step 90.5 built was
permanently dark in every build, despite being fully implemented and
unit-tested end to end against a fabricated runner. Exactly the defect class
this register already names five times over (§96.5, plan 90's own brief): a
mechanism proven correct in isolation, never reaching the one production
call site.

**Evidence.** `packages/core/src/daemon.ts` (before this fix) —
`createSessionManager({...})` had no `withGuestAgentClient` key, while
`guestAgent.withGuestAgentClient` (built earlier, `const guestAgent =
createGuestAgentRoutes({...})`) was already being passed into
`createDeviceIdentityRoutes` and used directly for the agent provisioner's
`hello`, proving the accessor existed and was reachable at that point in
boot — just never handed to the session manager. `packages/session/src/manager.ts:74`'s
own doc comment already named the gap explicitly: "Undefined (today, in
every wired build...)".

**How it was found.** Traced while scoping this M61 pass on plan 90
§3.3/§4.5's text ladder: cross-referencing `manager.ts`'s own doc comment
against every `createSessionManager` call site in the workspace (two exist —
`daemon.ts` and `packages/node/src/hosts.ts`; only the former should ever
supply `withGuestAgentClient`, per the node's own documented "guest agent is
local-core-only" boundary).

**Fixed.** Yes. `daemon.ts`'s `createSessionManager({...})` now passes
`withGuestAgentClient: (deviceId) => (fn) => guestAgent.withGuestAgentClient(deviceId, fn)`
— a curried adapter from `GuestAgentRoutesHandle.withGuestAgentClient`'s
`(deviceId, fn) => Promise<T>` shape to `SessionManagerDeps`'s `(deviceId) =>
GuestAgentClientRunner` shape, reusing the SAME per-device session
`guestAgent` already owns (plan 44 §8b's "Bug 1": a second, independent
bootstrap mints a second token and invalidates the first) — the identical
seam `deviceIdentity` and the agent provisioner's `hello` already share.
`packages/core/src/daemon-wiring.test.ts` gained a case
("`createSessionManager(...)` passes a live `withGuestAgentClient`
accessor") asserting the real production object literal contains both the
key and the exact adapter expression, in the file's own established style of
proving production wiring from the actual source text rather than from a
helper's own unit tests — which already passed before this fix (`resolveTextRoute`
returning `agent-ime` when handed a runner directly is not new) and could
never have caught a missing call site. That new test's marker string needed
one extra guard the pre-existing three did not: a plain
`'createSessionManager({'` marker matches a COMMENT above the real call
first (`daemon.ts:538`, `// \`sessions = createSessionManager({ onEvent, ...
})\` below, well` — its own braces balance on one line), so `extractCall`
would have silently handed back the comment's fake object literal instead of
throwing; the test anchors on the real call's actual leading newline plus
indentation instead.

Full-workspace verification, 2026-08-13: `bash scripts/typecheck.sh` — every
package OK (`protocol` and `studio` each showed one unrelated, transient
failure on an earlier run in this same pass, both in files this entry never
touched — `packages/protocol/src/api/devices.test.ts` and
`packages/studio/src/app/device/page.tsx` — and both cleared on the very next
run with no change from this entry, confirming a concurrent worker's
in-flight edit elsewhere in this shared tree, not a regression here). `bun
test`: 3363 pass / 0 fail (11926 `expect()` calls, 259 files) — includes both
this entry's new `daemon-wiring.test.ts` case and §96.7's new
`text-input.test.ts` exhaustive pin. `bun run --cwd packages/studio test`:
655 pass / 0 fail (one run mid-pass briefly showed 4 failures, all in
`DeviceHeader.test.tsx` — a file this entry never touched, and confirmed by
its own mtime to have been mid-edit by a concurrent worker at that exact
moment; re-run clean seconds later). `bun run --cwd packages/studio build`,
run alone as required: succeeded (one earlier attempt failed on a stale
`.next/server/pages-manifest.json` during the same window other build/test
processes in this shared tree were active; re-run alone with nothing else
running succeeded cleanly).

### 96.7 — Investigated: rung 3 (`clipboard`) of the text ladder is not "dormant pending a future engine" — it is architecturally unreachable in this codebase, full stop. NOT FIXED (recommendation only; the files that would need to change belong to a concurrent worker).

**What was investigated.** Step 90.5's own status note recorded, honestly,
that `resolveTextRoute` never selects rung 3 (`clipboard`) under its current
5-field signature, attributing this to rung 2 and rung 3 sharing an
identical structural precondition (`hasScrcpyControl`) plus rung 2 having no
side effect. This M61 pass was asked to determine which of three
explanations is correct: (a) the resolver's signature cannot express the
distinction rung 3 exists for, and should be widened so the rung becomes
reachable; (b) the distinction is expressible but no current engine happens
to have that shape, so rung 3 is correct and merely dormant; or (c) rung 3
is genuinely redundant and should be removed along with
`clipboard.overwritten`.

**Finding: (c) — and a stronger claim than "no engine happens to have that
shape today."** `hasScrcpyControl` is computed identically at both call
sites (`ws-handlers.ts`, `device-executor.ts`) as `session.inputEngineId !==
'adb-input'`. `packages/session/src/session.ts` proves this is EXACTLY
`scrcpy !== null`: `inputEngineId` is only ever set to `'adb-input'` in the
`else` branch that runs when `scrcpy` is null, and `selectInputEngine` never
degrades all the way down to `adb-input` while `scrcpy` is non-null (only
UHID→SDK). The clipboard `paste`-capable branch (`session.clipboard`) is
gated on that SAME `scrcpy` value. Both scrcpy input engines (`scrcpy-uhid`,
`scrcpy-sdk` — `packages/drivers/src/descriptors.ts`) declare
`text-unicode`, and `ScrcpyUhidInput` does not even implement its own
`text()` — it inherits the SDK engine's `INJECT_TEXT` verbatim, since
unicode-cleanliness there is a fact of the version-locked scrcpy-server wire
protocol (CLAUDE.md: "never fork the Java side"), not a per-engine choice
this repo makes. So "a scrcpy control socket whose text injection is
ASCII-only" — the exact shape rung 3's table row (§3.3) exists for — cannot
occur in this codebase's architecture, not merely "does not happen to occur
today." Widening the resolver's signature to carry that distinction (option
(a)) would add a parameter no real caller could ever supply `true` for.
Rung 3's OTHER stated precondition, "a paste-capable focused field," is a
per-field runtime fact the resolver could never observe regardless:
`resolveTextRoute` is deliberately pure (no I/O, no live probe — its own
file-level doc comment says so), and no per-field feedback loop exists or is
planned anywhere in this codebase.

**Evidence.** `packages/session/src/text-input.ts`'s `resolveTextRoute`, the
`if (hasScrcpyControl)` branch, now carries the full derivation inline, and
`TextRung`'s own doc comment at the top of the file states the finding.
`packages/session/src/text-input.test.ts` gained an exhaustive test ("rung 3
(clipboard) is never selected, for ANY combination of inputs") iterating
every `text`/`agentCapabilities`/`imeCurrent`/`hasScrcpyControl`/`prefer`
combination this test file exercises elsewhere and asserting
`resolveTextRoute` never returns `rung: 'clipboard'` for any of them — a
mechanical pin, not a prose claim.

**Not fixed.** The `'clipboard'` value in `TextRung`, the real branches in
`ws-handlers.ts`/`device-executor.ts`, `clipboard.overwritten` in
`packages/protocol/src/messages/device-event.ts`'s `MAIN_EVENT_KINDS`, and
the clipboard-precondition surfacing in `LiveView.tsx` are all still present
and all still 100% dead in every wired build — reachable-looking but never
reached. Removing them is the recommended follow-up (nothing in this
codebase should claim a capability — or, here, a code path — it cannot
deliver, the same rule CLAUDE.md states for `vpn-helper`'s `probe`), but
every one of those files was held by a concurrent worker during this pass
(this worker's file list was `daemon.ts`, `daemon-wiring.test.ts`,
`text-input.ts`, `manager.ts`, `descriptors.ts`, and test files) —
implementing the removal is out of scope here and left for whoever owns
those files next.

Full-workspace verification, 2026-08-13 (shared with §96.6's pass, since both
entries came out of the same investigation): `bash scripts/typecheck.sh` all
OK, `bun test` 3363 pass / 0 fail (including the new exhaustive
`text-input.test.ts` pin — 192 checked combinations, none returning
`rung: 'clipboard'`), `bun run --cwd packages/studio test` 655 pass / 0 fail,
`bun run --cwd packages/studio build` succeeds run alone. See §96.6's own
verification paragraph for the two transient, unrelated failures observed
mid-pass and their resolution.

### 96.8 — Rung 3 (`clipboard`) removed from the text ladder, together with `clipboard.overwritten` and every other referrer §96.7 could not reach. FIXED.

**What broke.** Nothing new here — this entry is §96.7's own recommendation,
acted on by a later pass that held the files §96.7 could not touch. §96.7
proved rung 3 (clipboard-paste) was not "dormant pending a future engine" but
architecturally impossible in this codebase: `hasScrcpyControl` is exactly
`scrcpy !== null` at both call sites, which is the SAME boolean rung 2's
unicode-clean `INJECT_TEXT` is gated on, and every engine that boolean can be
true for already declares `text-unicode`. A dead rung, a dead device-event
kind, and their branches were therefore left sitting in five files, all
reachable-looking and all 100% dead in every wired build — exactly the class
of lie CLAUDE.md's `vpn-helper`/`probe` rule warns against ("nothing in this
codebase should claim a capability it cannot deliver"), just running the
other direction: code claiming a *path* that could never be taken, rather
than a capability that could never be verified.

**Evidence.** §96.7's own account, re-checked rather than taken on trust
before any removal: `packages/session/src/text-input.ts`'s `resolveTextRoute`
never returned `rung: 'clipboard'` in any of the 192 combinations
`text-input.test.ts`'s exhaustive pin checked; `hasScrcpyControl` at both
`packages/core/src/server/ws-handlers.ts` and
`packages/session/src/device-executor.ts` was `session.inputEngineId !==
'adb-input'`, and `packages/session/src/session.ts` sets `inputEngineId =
'adb-input'` in exactly one branch, the `else` that runs only when `scrcpy`
is `null` — so the boolean is provably `scrcpy !== null`, the identical
condition gating `session.clipboard`'s own `paste`-capable branch two lines
away in the same file. `packages/drivers/src/descriptors.ts` — both scrcpy
input engines (`scrcpy-uhid`, `scrcpy-sdk`) declare `text-unicode`, and
`ScrcpyUhidInput` has no `text()` override of its own, inheriting the SDK
engine's `INJECT_TEXT` verbatim (a fact of the version-locked scrcpy-server
protocol, CLAUDE.md §3: never fork the Java side).

**How it was found.** Not found — assigned. §96.7 already did the
investigation and named exactly what to remove and why removing it was safe;
this entry is the mechanical follow-through, done by a worker who was handed
the files §96.7 could not touch (`ws-handlers.ts`, `device-executor.ts`,
`packages/protocol/src/messages/device-event.ts`, `LiveView.tsx`) plus a
fresh workspace-wide grep for `clipboard.overwritten` and the `'clipboard'`
route-value literal, which turned up three more referrers §96.7's own file
list did not name: `packages/protocol/src/messages/input.ts` (the
`InputTextResultMessage.payload.via` wire enum), `packages/sdk/src/types.ts`
(`ScriptTypeResult.via`, the public script-facing type), and
`packages/drivers/src/descriptors.ts`'s own comment describing the finding.

**Fixed.** Yes, across every file the grep and §96.7's own list named:

- `packages/session/src/text-input.ts` — `'clipboard'` removed from the
  `TextRung` union (now `'agent-ime' | 'scrcpy-text' | 'adb-ascii'`);
  `resolveTextRoute`'s body no longer has anything to say about a rung that
  cannot occur (the long inline investigation comment moved to a permanent
  design note on `TextRung` itself, explaining what was designed, why it was
  removed, and citing this entry so nobody re-adds it without first solving
  the actual blocker: no fact in this codebase can tell "ASCII-only control
  socket" apart from "unicode control socket"). `TextRouteDecision
  .clobbersClipboard` is kept, not deleted (always `false` now — removing it
  would be a breaking type change for every existing caller that destructures
  it, and no file in this pass's list asked for that).
- `packages/session/src/text-input.test.ts` — the exhaustive 192-combination
  pin ("rung 3 is never selected") is converted, not deleted, into a pin that
  the ladder's three rungs are exhaustive: for every combination in the same
  input space, `resolveTextRoute`'s `rung` is always one of `'agent-ime'` /
  `'scrcpy-text'` / `'adb-ascii'`, never anything else. This keeps the
  original pin's actual value — it would still catch a stray `'clipboard'`
  string reappearing at runtime despite the type change — while stating what
  the ladder IS rather than what one specific dead value ISN'T.
- `packages/protocol/src/messages/device-event.ts` — `'clipboard.overwritten'`
  removed from `MAIN_EVENT_KINDS`, replaced with a comment naming why and
  pointing here so it is not silently re-added.
  `packages/protocol/src/device.test.ts` — its "recognised main-stream kind"
  test inverted to a "NOT a recognised kind" pin instead of being deleted.
- `packages/core/src/server/ws-handlers.ts` and
  `packages/session/src/device-executor.ts` — the `decision.rung ===
  'clipboard'` branch removed from both `input.text`'s WS handler and the
  script executor's `type()`; each falls straight through to the remaining
  `InputSink.text()` path exactly as it already did for `'scrcpy-text'`/
  `'adb-ascii'`. `packages/core/src/server/ws-handlers-text.test.ts` — its
  "rung 4" test renamed "rung 3" (there is no rung 4 anymore), and the
  assertion that used to check `events.some(kind === 'clipboard.overwritten')
  === false` (proving an absence by naming a string that can no longer exist
  as a kind at all) replaced with an assertion that the ONLY event recorded
  for a refused `input.text` is the redacted `input.text` entry itself.
- `packages/studio/src/components/LiveView.tsx` — only the doc comment
  listing possible `via` values (`'agent-ime' / 'scrcpy-text' / 'clipboard' /
  'adb-ascii'`) touched, `'clipboard'` dropped from the list.
  **`pasteFromClipboard()`, the Cmd/Ctrl+V paste chord, and its
  `ws.request({ type: 'clipboard.set', payload: { ..., paste: true } })` call
  are UNCHANGED** — that is a real, separate, operator-facing feature step
  90.5 deliberately unblocked (F23: "Cmd/Ctrl+V never reaches anything
  either"), reached over the `clipboard.set` message type, not `input.text`,
  and gated on nothing this entry removed. Confirmed by re-reading the code
  before cutting anything, exactly as instructed.
- `packages/protocol/src/messages/input.ts` — `InputTextResultMessage`'s
  `via` enum narrowed to `['agent-ime', 'scrcpy-text', 'adb-ascii']`;
  `clobberedClipboard`'s doc comment rewritten to say it is always `false`
  today rather than "rung 3 only" (a rung that no longer exists).
- `packages/sdk/src/types.ts` — `ScriptTypeResult.via`'s union narrowed the
  same way; its own doc comment and `DeviceApi.type()`'s doc comment (which
  used to describe the ladder as "the guest agent's keyboard, then scrcpy's
  unicode-clean `INJECT_TEXT`, then (rarely) a clipboard paste, then plain
  ASCII") both updated to describe the real three-step ladder.
- `packages/drivers/src/descriptors.ts` — the `scrcpy-uhid` descriptor's
  comment, which explained why "rung 3 (clipboard) can never fire," rewritten
  to explain why a clipboard-paste rung was designed and then removed (the
  underlying architectural fact — `hasScrcpyControl` and `text-unicode` are
  gated on the same `scrcpy` value — is unchanged and still the reason the
  comment exists at all).
- `packages/session/src/session.ts` — a separate, unrelated stale doc comment
  on `CreateSessionDeps.withGuestAgentClient` (flagged directly in this
  pass's brief) claiming "nothing in `daemon.ts` constructs a real value for
  it yet ... in every build today" — false since §96.6 wired it. Corrected to
  describe the real, current state: `daemon.ts` constructs a live value in
  production; `undefined` is still the honest reading for a fixture/test
  `SessionManager` or a session on a device with no reachable agent.
- `docs/plans/90-m55-unified-guest-agent.md` — §3.3 rewritten to describe the
  shipped three-rung ladder, with the original four-rung design kept
  underneath as an explicit historical record (not edited away) plus the same
  derivation this entry's evidence section gives for why the fourth rung
  cannot exist, so a future reader hits the explanation before reaching for
  the `'clipboard'` string again. The §4.5 technical-design code snippet and
  the §7.1 test-plan row for `text-input.test.ts` (both of which showed the
  now-wrong four-value union / rung-4 ASCII floor) updated to match. The
  plan's own top status block gets a short "done 2026-08-13" pointer to this
  entry, rather than continuing to read as though the recommendation were
  still open.

**Not touched, on purpose.** `packages/scrcpy/src/control/device-messages.ts`'s
own `{ type: 'clipboard'; text: string }` device-message shape — the real
scrcpy `GET_CLIPBOARD`/device-initiated clipboard-change message the control
protocol defines — is a different, unrelated `'clipboard'` string in a
different subsystem (the scrcpy wire protocol's own message-type tag, not a
`TextRung` value) and was correctly left alone; conflating the two would have
been the wrong grep result acted on without reading it.

Full-workspace verification, 2026-08-13 (this entry's own pass): `bash
scripts/typecheck.sh` — every package OK (`protocol`, `adb`, `toolchain`,
`drivers`, `scrcpy`, `sdk`, `session`, `harness`, `core`, `node`, `studio`,
`probe-server`, `networking`, `tiktok-automation-pack`, `examples`), including
every file this entry touched. `bun test`: 3372 pass / 1 fail (11954
`expect()` calls, 259 files). The one failure —
`packages/drivers/src/network/guest-agent/version-skew-guard.test.ts`
("workspace guard — R2 (plan 90 §3.9): no source file in packages/core or
packages/drivers compares appVersion"), which found `appVersion !==` inside
`packages/core/src/api/guest-agent.ts` — is not this entry's: neither file is
in this entry's list above, `guest-agent.ts`'s own mtime is LATER than every
file this entry edited (confirming a concurrent worker wrote to it during
this same pass, consistent with the huge, unrelated `git status` diff already
present in this shared tree — auth/ACL, batches, adb-metrics, doctor, and
dozens more files this entry never touched), and the flagged line itself
(`...(status.appVersion !== null ? { appVersion: status.appVersion } : {})`)
is a null-check having nothing to do with the text ladder, rung 3, or
`clipboard.overwritten`. `bun run --cwd packages/studio test`: 655 pass / 0
fail (1388 `expect()` calls, 90 files). `bun run --cwd packages/studio
build`, run alone as required: succeeded cleanly (28/28 static pages,
exporting 2/2).

### 96.9 — `DeviceInfoSchema.agent` and `GET /:id/guest-agent` had no producer, so the whole plan 90 §3.8/§3.9 provisioning surface reported `absent`/pre-plan-90 states on every real device. FIXED.

**What broke.** Two separate producer gaps, both already flagged honestly by
the steps that found them but left for a later pass because the files
involved were held by concurrent workers at the time — exactly the pattern
this register's own framing names ("a value computed correctly, stored
correctly, and never read out to the surface").

1. `packages/core/src/registry/device-registry.ts`'s `rowToDeviceInfo()`
   never read `row.agent` (the `devices.agent` JSON column `AgentProvisioner`
   writes to, plan 90 §4.3) and never set `agent` on the object handed to
   `DeviceInfoSchema.parse()`, so `agent: AgentStateSchema.default('absent')`
   fired on every row, on every request, regardless of what the provisioner
   had actually computed. Step 90.6's own status note named this exactly and
   said "the fix is one line" — it was, but nobody had yet threaded it.
2. `GET /api/devices/:id/guest-agent` (`packages/core/src/api/guest-agent.ts`)
   still answered from `statusOf()`, the pre-plan-90 live presence+`hello()`
   probe, never from `AgentProvisioner.status()` — so `versionCode`,
   `checkedAt`, `attempts`, `nextAttemptAt` (all declared on
   `GuestAgentStatusResponseSchema` by step 90.6, additively, specifically so
   this could land later without a breaking change) had no producer, and the
   `outdated`/`failed` states the provisioner computes and persists were
   unreachable through that one endpoint.

The concrete, user-visible consequence: every chip step 90.6 built —
`AgentAlertChip` on the device header, the fleet card, the wall tile, plus
the Agent tab's own `versionCode`/`checkedAt`/`attempts`/`nextAttemptAt`
rendering — was correctly wired end to end and stayed dark on every real
device, because both ends of the pipe it read from were unwired. Step 90.6's
own status note flagged gap 1 explicitly ("An honest, load-bearing gap this
step found and could not close") and gap 2 implicitly (the widened schema's
own doc comment, "no producer yet on this endpoint"); this entry closes both.

**Evidence.** `packages/core/src/registry/device-registry.ts` (before this
fix) — `rowToDeviceInfo()`'s `DeviceInfoSchema.parse({...})` call had no
`agent` key at all. `packages/core/src/api/guest-agent.ts` (before this fix)
— `app.get('/:id/guest-agent', ...)` called `statusOf(row)` unconditionally,
with no reference to `deps.agentProvisioner` at all (that dep object only
carried `ensure`, used by `POST`).

**How it was found.** Assigned directly — step 90.6's own status note named
both gaps by file and by the one-line fix each needed; this entry is the
mechanical follow-through, matching this register's own §96.8 precedent
("not found — assigned").

**Fixed.** Yes, both gaps, plus one necessary follow-on found while fixing
gap 2 (below).

*Gap 1 — `packages/core/src/registry/device-registry.ts`.* A new exported
`deriveAgentState(row: Pick<DeviceRow, 'agent'>): AgentState` reads
`row.agent` through the SAME `AgentStatusSchema.safeParse` that
`agent-provisioner.ts`'s own `readCached` already validates that column
with, defaulting to `'absent'` on `null`/`undefined`/a value that fails
validation — never an `as`-cast, never a 500 on a corrupt or pre-migration
row. `rowToDeviceInfo()` now sets `agent: deriveAgentState(row)`.
Deliberately **not** a new function parameter threaded by each caller (unlike
`readiness`/`heldBy`/`networks`, which come from managers external to the
row, and which is why 96.5 needed three separate call-site fixes): `agent`
is a column already present on every `DeviceRow` this file's callers select
in full (`db.select().from(devices)`, confirmed — grepped the whole workspace
for a partial `db.select({...})` projection feeding `rowToDeviceInfo`/
`listDevicesWithTags`; none exists), so reading it once, inside the one
function every list/broadcast/detail response already funnels through,
reaches `listDevicesWithTags`, `daemon.ts`'s `listDevices` closure,
`capability/context.ts`'s `listDevices()`/`getDevice()`, `api/topology.ts`'s
`buildTopology`, `api/clusters.ts`'s `GET /:id/devices`, and every
`api/devices.ts` route (`/`, `/:id`, the admit route's `infoWithTags`)
automatically — with zero risk of a fourth call site being missed the way
`networks`/`declaredMedia` were three times over (96.5). `rowToDeviceInfo`'s
signature is unchanged; no call site needed editing.

*Gap 2 — `packages/core/src/api/guest-agent.ts`.* `GuestAgentRoutesDeps.agentProvisioner`
gained two new optional methods beside the existing `ensure`: `status?:
(deviceId: string) => Promise<AgentStatus>` and `remove?: (deviceId: string,
actor: string | null) => Promise<unknown>`. `GET /:id/guest-agent` now calls
`deps.agentProvisioner.status(row.id)` when wired, mapped through a new
`agentStatusToResult()` onto the endpoint's existing response shape —
additive, never narrowed, per §4.7's own instruction and step 90.6's own
"do not narrow" schema: `GuestAgentState` widened to the SAME seven values
`GuestAgentStatusResponseSchema` already declared (`not-installed | installed
| ready | unreachable | unsupported | outdated | failed`), and
`GuestAgentStatusResult` gained the same `versionCode`/`checkedAt`/
`attempts`/`nextAttemptAt` fields the schema already carried with no
producer. `AgentState`'s `absent`/`provisioning` (which have no analogue in
the pre-plan-90 five) map onto `not-installed`/`installed` respectively —
`provisioning` is never actually produced by `agent-provisioner.ts`'s
`ensureImpl` today (there is no in-flight marker written mid-pass), so that
branch is defensive, not exercised by a real device yet. When `status` is
absent (every pre-existing test/call site), `GET` falls back to the exact
pre-plan-90 `statusOf()` live probe, unchanged — proven by the fact that
every existing GET test in `guest-agent.test.ts` (the "state machine"
describe block) passes with zero edits.

*The follow-on.* Once `GET` reads from the persisted row, an operator's
`DELETE` (uninstall) had to clear that SAME row, or a `GET` right after would
keep reporting a stale `ready`/`outdated`/`failed` for a package that was
just removed — the provisioner would have silently stopped being the one
source of truth the moment it disagreed with reality, which is exactly what
this brief's "do not add a second source of truth" instruction rules out.
`DELETE /:id/guest-agent` now also fires `deps.agentProvisioner?.remove?.(row.id,
actor)`, fire-and-forget and tolerant (the same idiom `POST`'s `ensure` call
already uses), after its own existing uninstall. `daemon.ts`'s
`createGuestAgentRoutes({...})` call wires both new methods through the same
`agentProvisionerRef` forward-ref `ensure` already used (`status: (deviceId)
=> agentProvisionerRef?.status(deviceId) ?? Promise.resolve(DEFAULT_AGENT_STATUS)`;
`remove: (deviceId, actor) => agentProvisionerRef?.remove(deviceId, actor) ??
Promise.resolve(undefined)`), proven present in the real source text by two
new assertions in `packages/core/src/daemon-wiring.test.ts`, the same "read
the real file" style §96.5/§96.6 already established for this exact class of
bug (a mechanism proven correct in isolation, never reaching the one
production call site).

**A subtlety the workspace-wide R2 guard caught, worth recording.** The
first draft of `agentStatusToResult()` conditionally omitted `appVersion`
with `status.appVersion !== null ? {...} : {}`, which tripped
`packages/drivers/src/network/guest-agent/version-skew-guard.test.ts` (plan
90 §3.9 rule 2's workspace-wide guard: no source file may compare
`appVersion` against anything, not even a bare null check — that guard's own
doc comment says a presence check trips it exactly the same as a real
version-gating comparison, deliberately, because "not at all" is R2's actual
wording). The fix uses `status.appVersion ?? undefined` instead — nullish
coalescing, not a comparison operator, so the guard's regex has nothing to
match — which both satisfies R2 and reads better. Left here because §96.8's
own verification paragraph (written by a concurrent worker mid-pass, before
this fix landed) correctly caught and correctly attributed this exact
transient failure to "a concurrent worker," without knowing which one; this
entry is that worker, and the failure is now closed.

**Tests — proven from the surface, not the helper.**
`packages/core/src/api/devices.test.ts` gained a new describe block ("GET
/api/devices — agent") with four tests against the real HTTP routes: a
device whose `devices.agent` column says `ready` carries `agent: 'ready'` on
both `GET /` and `GET /:id`; a device whose column is `NULL` reads `'absent'`
on both; a corrupt (schema-invalid) column value reads `'absent'` rather than
500ing. `packages/core/src/api/guest-agent.test.ts` gained a new describe
block ("GET /api/devices/:id/guest-agent — wired to AgentProvisioner.status()")
with five tests: `outdated` with `versionCode`/`checkedAt`/`attempts`/
`nextAttemptAt` all populated; `failed` with a verbatim reason and a nonzero
`attempts`/`nextAttemptAt`; the provisioner's `absent`→`not-installed` and
`ready`'s `appVersion`/`androidSdkInt`/`capabilities` mapping; and `DELETE`
clearing the row through `agentProvisioner.remove()` so an immediate `GET`
after does not keep reporting a stale `ready`. `daemon-wiring.test.ts` gained
one new case asserting `status:`/`remove:` are present in `daemon.ts`'s real
`createGuestAgentRoutes({...})` call, wired to `agentProvisionerRef`.

**Hardware honesty.** Nothing in this entry needed a physical device to
build or verify — every test above drives the real HTTP routes against an
in-memory SQLite DB and a fabricated `AgentProvisioner`/launcher, never a
real `adb`. One item genuinely needs a phone and is recorded as
**pending — owner to run**, continuing plan 90's own H-90.3/H-90.6 tables
rather than duplicating them here:

| # | Claim | Exact command | What confirms it |
|---|---|---|---|
| H-96.9a | A real device the operator provisions end to end shows the correct chip on the fleet card, the wall tile, and the device header popover — not just the mocked `AgentStatus` fixtures this entry's tests use — and `GET /api/devices/:id/guest-agent` on that same device reports `ready` with a real `versionCode`/`checkedAt` once installed | `bun run dev` and `bun run dev:studio`, enrol a phone with `guestAgent.provision: 'auto'`, open `/device?id=<id>` and watch the header chip go from (quiet) to `ready`, then `curl -s localhost:7700/api/devices/<id>/guest-agent \| jq` | The chip renders `ready`/quiet correctly (not permanently `absent`); the endpoint's JSON carries a real `versionCode`/`checkedAt`, not `undefined` |
| H-96.9b | The toolchain manifest's `guest-agent` entry still carries placeholder `sha256`/`versionCode` (plan 90 §4.8), so tier-3 resolution fails closed with `E_CHECKSUM_MISSING` until the owner publishes a signed release — a device in that state must read as a named `failed`, never `absent` and never a crash | Same dev boot with no `ENKAKU_GUEST_AGENT_PATH` set and no local Gradle build present, enrol a phone, open the Agent tab | `state` reads `failed` with the verbatim `E_CHECKSUM_MISSING` reason (never `absent`, never a 500); the device still streams video, takes input, and runs a job (plan 90 §3.8's load-bearing decision) |

**Verification.** Scoped run first:
`bun test packages/core/src/api/devices.test.ts
packages/core/src/api/guest-agent.test.ts packages/core/src/daemon-wiring.test.ts
packages/core/src/registry/device-registry.test.ts` → 232 pass / 0 fail (652
`expect()` calls). Full workspace, 2026-08-13, run in the order this
document's own brief requires (`typecheck.sh` and the Studio build never
concurrently — the build is flagged to fail spuriously otherwise):
`bash scripts/typecheck.sh` — every package OK (`protocol`, `adb`,
`toolchain`, `drivers`, `scrcpy`, `sdk`, `session`, `harness`, `core`,
`node`, `studio`, `probe-server`, `networking`, `tiktok-automation-pack`,
`examples`). `bun test`: 3373 pass / 0 fail (11954 `expect()` calls, 259
files) — this run includes the R2 guard test passing clean, confirming the
`?? undefined` fix above; the ONE failure §96.8's own verification paragraph
observed and correctly attributed to a concurrent worker (this entry) is
gone. `bun run --cwd packages/studio test`: 655 pass / 0 fail (1392
`expect()` calls, 90 files) — unchanged from §96.6/§96.8's own baseline,
since this entry touches no Studio file (out of scope per this task's own
file allowlist — a concurrent worker holds `packages/studio/**`). `bun run
--cwd packages/studio build`, run alone as required: succeeded cleanly
(28/28 static pages, exporting 2/2).

### 96.10 — `assistedBy` (plan 91's Assist feature) was populated in `api/devices.ts` alone; `api/topology.ts`, `api/clusters.ts`, and `capability/context.ts` still read `[]` on a genuinely-assisted device. FIXED (residual `daemon.ts` wiring closed 2026-08-13 — see below).

**What broke.** Plan 91 step 91.4 added `DeviceInfo.assistedBy` (who currently
holds a co-control assist grant on a device, alongside `heldBy`) and
populated it in the one router it owned, `packages/core/src/api/devices.ts`
(`infoWithTags`, `GET /`, `GET /:id`). Its own status note named the gap
directly and by file: `topology.ts`/`clusters.ts`/`capability/context.ts`
also build `DeviceInfo` from `rowToDeviceInfo`/`listDevicesWithTags` with
their own `heldByOf` accessor, but were outside that step's file-ownership
list and were NOT touched — so a device's `assistedBy` kept reading `[]` on
the Topology view, a cluster's device list, and the capability layer
(`ctx.listDevices()`/`ctx.getDevice()`, an agent script's own fleet view)
even while genuinely being assisted. This is the identical defect class
§96.5 already named for `heldBy`/`connection.medium`: a value computed
correctly, stored correctly by the co-control manager
(`lease/co-control.ts`'s `assistedBy`), and never read out to three of the
four surfaces that build the same response shape.

**Evidence.** `packages/core/src/api/topology.ts`'s `buildTopology` called
`listDevicesWithTags(db, readinessOf, heldByOf, networks, declaredMedia)`
with no `assistedBy` parameter or override at all — every `DeviceInfo` it
returned relied on `DeviceInfoSchema.assistedBy`'s own default (`[]`).
`packages/core/src/api/clusters.ts`'s `GET /:id/devices` called
`rowToDeviceInfo(r, tagMap.get(r.id) ?? [], cluster, null, null,
deps.heldByOf?.(r.id) ?? null, networks, media)` — same story.
`packages/core/src/capability/context.ts`'s `listDevices()`/`getDevice()`
called `listDevicesWithTags(...)`/`rowToDeviceInfo(...)` directly with no
`assistedBy` handling at all; `CapabilityContextDeps` had no `assistedByOf`
field to even accept one.

**How it was found.** Assigned directly — step 91.4's own status note named
all three files and the exact shape of the gap, matching this register's
§96.9 precedent ("not found — assigned").

**Fixed.** Yes, in `topology.ts`, `clusters.ts`, and `capability/context.ts`
— `daemon.ts`'s own wiring is the one piece NOT fixed by this entry (see
below).

Deliberately **not** a new parameter threaded through
`rowToDeviceInfo`/`listDevicesWithTags` (`registry/device-registry.ts`),
unlike `heldByOf` itself: that file was outside this pass's file-ownership
list (a concurrent worker's territory at the time), and `assistedBy` is live
runtime state from the co-control manager, not a database column — it has
no `agent`-style zero-call-site-change trick available (see §96.9's Gap 1
for why `agent` COULD skip threading and why `assistedBy` cannot; the
brief that produced this entry states the same distinction directly). So
each of the three functions instead calls the existing helper unchanged,
then maps over (or spreads) the result and OVERRIDES `assistedBy` with a new
optional `assistedByOf?: (deviceId: string) => LeaseHolder[]` accessor,
resolved from `lease/co-control.ts`'s `assistedBy(deviceId)` — the same
per-device-function shape `heldByOf` already has, and the same
override-after-build pattern `api/devices.ts` itself already used for this
exact field (its `infoWithTags`/`GET /`/`GET /:id` spread `rowToDeviceInfo`'s
result and override `assistedBy: deps.assistedByOf?.(id) ?? []`, rather than
extending `rowToDeviceInfo`'s own parameter list, for the identical reason).
`buildTopology`'s new parameter is appended LAST in its positional list
(after `declaredMedia`), not beside `heldByOf` where it conceptually
belongs, so every `buildTopology(db)`-style positional call in
`topology.test.ts` keeps compiling unedited. Omitted (or no active grant)
falls back to `[]` in every case — an unknown assist state is "nobody is
assisting", never a guess, per this task's own explicit constraint.
Accessors are resolved once per list and invoked once per device (the same
per-row-function-call shape `heldByOf` already has at
`device-registry.ts`'s `listDevicesWithTags`) — never re-derived per row
from a query, which is what the N+1 rule at `device-registry.ts:171-175`
(now the `networks`/`declaredMedia` doc comments further down the same
file, line numbers having drifted since §96.5 cited them) actually guards
against.

**Residual — `daemon.ts`'s own wiring, NOT done by this entry.** `daemon.ts`
was held by a concurrent worker for the whole duration of this pass (per
this task's own explicit instruction not to touch it, `ws-handlers.ts`, or
`packages/core/src/mirror/**`), so none of the three new `assistedByOf`
parameters above are wired to a real `coControl` instance in production yet
— exactly the same "correct but inert until daemon.ts passes it"
residual §96.5 recorded for `networks`/`declaredMedia` on
`DeviceRegistry`/`createClusterRoutes`, later closed by a different
worker who happened to hold `daemon.ts` for an unrelated reason. The three
lines needed, verbatim and copy-pasteable, mirroring the shape `daemon.ts`
already uses for `heldByOf` and for `devices.ts`'s own already-wired
`assistedByOf: (deviceId) => coControl.assistedBy(deviceId)` (line ~1683):

```ts
// inside createClusterRoutes({ ... }) around daemon.ts:1738-1751, beside the existing heldByOf:
assistedByOf: (deviceId) => coControl.assistedBy(deviceId),

// inside createTopologyRoutes({ ... }) around daemon.ts:1752-1760, beside the existing heldByOf:
assistedByOf: (deviceId) => coControl.assistedBy(deviceId),

// inside the capContextDeps object around daemon.ts:1493-1515, beside networks/declaredMedia:
assistedByOf: (deviceId) => coControl.assistedBy(deviceId),
```

`coControl` is constructed synchronously at `daemon.ts:1064`, well before all
three of these object literals (`capContextDeps` at `:1493`, `clusterRoutes`
at `:1738`, `topologyRoutes` at `:1752`), so no forward-ref is needed — a
direct closure over `coControl`, exactly like `devices.ts`'s own
`assistedByOf` already does two hundred lines above `clusterRoutes` in the
same function. `packages/core/src/daemon-wiring.test.ts` was also held by
the same concurrent worker, so no pinning test for these three lines exists
yet either — the same situation §96.5's `networks`/`declaredMedia` residual
was in until a later worker who already held `daemon.ts` picked it up. This
paragraph is that assignment, made explicit rather than hoped for.

**Tests — proven from the surface, not the helper.**
`packages/core/src/api/devices.test.ts` gained a new describe block ("GET
/api/devices — assistedBy") with three tests against the real HTTP routes:
an assisted device carries `assistedBy` on both the list and single-device
endpoint; an unassisted one carries `[]`; an omitted `assistedByOf` dep
falls back to `[]` rather than throwing (closing devices.ts's own
until-now-untested wiring from step 91.4, alongside the three new gaps).
`packages/core/src/api/topology.test.ts` gained the same three-shape
coverage against `GET /api/topology`. `packages/core/src/api/clusters.test.ts`
gained the same against `GET /api/clusters/:id/devices`.
`packages/core/src/capability/context.test.ts` gained the same against
`ctx.listDevices()`/`ctx.getDevice()` directly. None of these tests call
`rowToDeviceInfo`/`listDevicesWithTags` in isolation — every assertion reads
the field back off the real route or the real `CapabilityContext`, the same
"prove it from the surface" discipline §96.9 and this task's own brief both
insist on, precisely because a helper-level test would have passed the
entire time this defect existed.

**Verification.** Scoped run first: `bun test
packages/core/src/api/devices.test.ts packages/core/src/api/topology.test.ts
packages/core/src/api/clusters.test.ts
packages/core/src/capability/context.test.ts` → 160 pass / 0 fail (387
`expect()` calls). Full workspace, 2026-08-13: `bash scripts/typecheck.sh` —
every package OK (`protocol`, `adb`, `toolchain`, `drivers`, `scrcpy`, `sdk`,
`session`, `harness`, `core`, `node`, `studio`, `probe-server`, `networking`,
`tiktok-automation-pack`, `examples`). `bun test`: 3672 pass / 0 fail (14511
`expect()` calls, 269 files) — no failures anywhere in the shared tree at the
time of this run. `bun run --cwd packages/studio test`: 655 pass / 0 fail
(1394 `expect()` calls, 90 files) — unchanged, since this entry touches no
Studio file (out of scope per this task's own file allowlist — a concurrent
worker holds `packages/studio/**`). Studio's own build was NOT run separately
by this pass (not requested by this task's brief, unlike §96.9's).

**Residual closed 2026-08-13**, by the worker who held `daemon.ts` for this
exact assignment (a wiring pass on `daemon.ts` naming this entry's three
verbatim lines directly). All three land exactly as specified above:
`createClusterRoutes({...})` and `createTopologyRoutes({...})` each gained
`assistedByOf: (deviceId) => coControl.assistedBy(deviceId)` beside their
existing `heldByOf`, and `capContextDeps` gained the same accessor beside
`networks`/`declaredMedia` — `coControl` was already in scope at every site,
constructed synchronously earlier in the same function, exactly as predicted.
`packages/core/src/daemon-wiring.test.ts` gained three new cases (a new
`describe('assistedBy ...')` block) pinning all three call sites' real source
text, the same "read the real file" style this register's own §96.5/§96.6/
§96.9 already established. Proven from the surface, not only the wiring text,
per this pass's own instruction: `packages/core/src/api/topology.test.ts`,
`packages/core/src/api/clusters.test.ts`, and
`packages/core/src/capability/context.test.ts` each gained a test that builds
a REAL `CoControlManager` (the same `leases`-then-`coControl` construction
order `daemon.ts` uses), grants a real assist through it, wires the route
with the identical `(deviceId) => coControl.assistedBy(deviceId)` expression
`daemon.ts` now contains, and asserts the granted holder comes back through
the real HTTP route / `CapabilityContext` — not a hand-injected fake array,
which is what the pre-existing tests in those files already proved and is not
by itself proof that the production expression is correct. Verification
below, alongside §96.11's.

### 96.11 — `daemon.ts` does not yet construct `createWorkflowRoutes`, so `POST /api/workflows` 404s in every real build. FIXED 2026-08-13 (was: NOT FIXED — the file was held by a concurrent worker; the gap was self-detecting).

**What broke, or rather what has not yet been connected.** Plan 99 step 99.6
built `packages/core/src/api/workflows.ts`'s `createWorkflowRoutes` (`POST /`,
`POST /validate`, `GET /:name/versions`) and made `HttpDeps.workflowRoutes`
(`packages/core/src/server/http.ts`) OPTIONAL — the same pattern `audit`/
`adbControl` already use — specifically because `daemon.ts` was held by a
concurrent worker for this step's entire duration and could not be edited to
construct a real instance. `server/http.ts` mounts the route only
`if (deps.workflowRoutes)`, so an unwired build never fails to boot — it
simply never serves `/api/workflows/*`, falling through to the catch-all 404
exactly like any other unmounted path. This is the exact defect class this
register already names repeatedly (§96.5, §96.6, §96.9): a mechanism proven
correct in isolation, never reaching its one production call site.

**Evidence.** `packages/core/src/server/http.ts`'s `workflowRoutes?:
Hono<AuthEnv>` field and its own doc comment; `packages/core/src/api/workflows.ts`
exports `createWorkflowRoutes`; `packages/core/src/daemon.ts` (as of this
entry) has no `import { createWorkflowRoutes }` anywhere and no
`workflowRoutes:` key inside its one real `createApp({...})` call.

**How it was found.** Not found by accident — declared up front by step
99.6's own brief, which named `daemon.ts` as off-limits for this step and
required either a self-detecting test or a hotfixes-register entry (or both)
naming the exact fix. `packages/core/src/api/workflows-wiring.test.ts` (new)
is the self-detecting half — it reads `daemon.ts`'s own source text and fails
by name for as long as the two lines below are missing, the same
"read the real file" style `daemon-wiring.test.ts`/`tools/adb-server-control.test.ts`
already established for this identical class of problem. This entry is the
belt-and-suspenders half, since this register's own `git status` at the time
of writing showed `daemon-wiring.test.ts` and `daemon.ts` both under active,
concurrent edit by other workers — a wiring test in a shared file carries
some merge risk even when it is correct, and this register is where a
future reader who is NOT running the test suite would look first.

**The exact fix, verbatim.** One import, near `daemon.ts`'s other `./api/*`
route imports (e.g. beside `import { createScriptRoutes } from './scripts/routes'`):

```ts
import { createWorkflowRoutes } from './api/workflows'
```

and, inside the one real `const app = createApp({ ... })` call, beside
`scriptRoutes: createScriptRoutes({ ... })` (`scriptRegistry` is already
constructed earlier in the same function, at `const scriptRegistry =
createScriptRegistry({ ... })`):

```ts
workflowRoutes: createWorkflowRoutes({ db, registry: scriptRegistry, audit }),
```

**Not fixed.** Left for whoever holds `daemon.ts` next — the two lines above
are the entire fix; `packages/core/src/api/workflows-wiring.test.ts` will go
from 2 failing to 2 passing the moment they land, with no other change
required anywhere.

**Fixed 2026-08-13**, by the worker assigned exactly this — a wiring pass on
`daemon.ts` that collected this entry's, §96.10's, and three other workers'
self-detecting gaps in one pass. Both lines landed verbatim: the import
beside `createScriptRoutes`'s, and `workflowRoutes: createWorkflowRoutes({
db, registry: scriptRegistry, audit })` beside `scriptRoutes:` inside the real
`createApp({...})` call — `scriptRegistry` and `audit` were both already in
scope, no new construction needed.
`packages/core/src/api/workflows-wiring.test.ts` went from 2 failing to 2
passing with no other change, exactly as predicted; no edit to that file was
needed or made.

**Verification (shared for §96.10's residual and this entry, 2026-08-13).**
Scoped run first: `bun test packages/core/src/daemon-wiring.test.ts
packages/core/src/api/workflows-wiring.test.ts
packages/core/src/api/topology.test.ts packages/core/src/api/clusters.test.ts
packages/core/src/capability/context.test.ts` → 70 pass / 0 fail (178
`expect()` calls). Full workspace: `bash scripts/typecheck.sh`, `bun test`,
`bun run --cwd packages/studio test`, `bun run --cwd packages/studio build`
(run alone), `bun run spec:check`, and `bash scripts/check-plan-status.sh` —
see this pass's own report for the exact, verbatim output of each.

### 96.12 — Three Studio surfaces step 91.6 either flagged and left, or missed outright, for `DeviceInfo.assistedBy`. FIXED.

**What broke, or rather what step 91.6 built the surface for but three
places still did not show.** Plan 91's Assist feature (§3.4 item 4, F25)
publishes `DeviceInfo.assistedBy` live over `assist.changed`, exactly
mirroring how `heldBy`/`lease.changed` already worked — but three Studio
spots did not carry it through, two of them named honestly in step 91.6's own
status note rather than silently patched, one found only while auditing every
`HolderBadge` call site for this pass:

1. `packages/studio/src/app/page.tsx` (the devices list, which also feeds the
   Wall — plan 91's own default view for a farm owner) had a `lease.changed`
   branch patching `heldBy` live but no `assist.changed` branch at all, so a
   device being assisted right now showed nothing there until the next full
   `/api/devices` fetch or an unrelated `device.added`/`device.status`
   refresh.
2. `packages/studio/src/components/DevicePicker.tsx` rendered `heldBy` via
   `HolderBadge` but never `assistedBy` — not named in step 91.6's own status
   note (unlike the two below), found by grepping every `HolderBadge` call
   site in the workspace for this pass and checking each against `DeviceCard`
   /`WallTile`, which already had the block.
3. `packages/studio/src/components/wall/WallTile.tsx`'s root element is
   itself a `next/link`, and `HolderBadge` rendered a `job`/`agent` holder as
   its own nested `<Link>` — invalid HTML (an `<a>` inside an `<a>`, and per
   the HTML spec a nested `<button>` would be no better, since `<a>` may not
   contain other interactive content). Step 91.6's own `WallTile.test.tsx`
   addition sidestepped this with a `user`-kind holder specifically to avoid
   asserting through the resulting React hydration warning, and left
   `WallTile.tsx` itself unchanged — the first time any `WallTile` test ever
   exercised a `job`/`agent` `heldBy` at all.

**Evidence.** `packages/studio/src/app/page.tsx` (before this fix) — the
`ws.on` callback's `if (m.type === 'lease.changed') {...}` branch had no
`else if (m.type === 'assist.changed')` sibling. `DevicePicker.tsx` (before
this fix) — `renderDeviceRow`'s only holder line was `{d.heldBy &&
<HolderBadge holder={d.heldBy} />}`, no `d.assistedBy` reference anywhere in
the file. `WallTile.tsx` (before this fix) — `<Link href={...}
className={...}>` wraps the whole tile, and both the `heldBy` and
`assistedBy` blocks inside it called `<HolderBadge holder={...} />` with no
way to suppress the `job`/`agent` branch's own `<Link>`; `WallTile.test.tsx`'s
own comment on the pre-existing test said so explicitly: "`HolderBadge`
renders a `job`/`agent` holder as a NESTED `<Link>`... a `user` holder
renders as a plain `<span>`, so this proves the two badges coexist without
tripping that unrelated defect" — an admission the defect existed and was
being routed around, not fixed.

**How it was found.** Not found — assigned. Plan 91 step 91.6's own status
note named gaps 1 and 3 explicitly and by file:line; gap 2 was found during
this pass by checking `DevicePicker.tsx` (which the assignment's file list
already included) against the two components step 91.6's own checklist DID
name (`DeviceCard`, `WallTile`) for the identical `assistedBy` block, per
this register's own "widened once someone looked properly" pattern (96.3,
96.4, 96.5).

**Fixed.** Yes, all three, plus the coverage gap the workaround left behind:

- `packages/studio/src/app/page.tsx` — a new `else if (m.type ===
  'assist.changed')` branch, placed directly after the existing
  `lease.changed` one, patches `d.assistedBy` for the matching `deviceId`
  the exact same way `lease.changed` patches `d.heldBy` — same `prev ?
  prev.map(...) : prev` shape, no new state, no polling.
- `packages/studio/src/components/DevicePicker.tsx` — `renderDeviceRow`
  gains `{(d.assistedBy ?? []).map((a) => <HolderBadge key={a.id} holder={a}
  variant="assists" />)}` beside the existing `heldBy` line, matching
  `DeviceCard`'s/`WallTile`'s own `assistedBy` block verbatim in shape.
- `packages/studio/src/components/HolderBadge.tsx` — gained an `asLink`
  prop, defaulting to `true` (every pre-existing caller — `DeviceCard`,
  `DeviceHeader`, `DevicePicker` — has no enclosing link of its own, so
  nothing changes for them). `asLink={false}` renders a `job`/`agent` holder
  as a plain `<span>` carrying the same title text minus the "— open the
  X" suffix (which would otherwise describe a click that no longer does
  anything), instead of a `<Link>`. `variant`'s colours and the `user`-kind
  branch (already a `<span>`, never a `<Link>`) are unaffected either way.
  **Decision, stated per this task's own brief: the INNER element (the
  badge) stops being a link inside `WallTile`, not the tile's own root.**
  The tile's root `Link` is the primary navigation for the whole card — the
  entire picture, the label, and every chip already route through it — and
  demoting it to a plain `<a>` (or a `<div onClick={...}>` faking one) was
  explicitly ruled out: either would either break the CLAUDE.md rule against
  a plain anchor (which remounts React and kills the WS/video) or lose
  `next/link`'s prefetch/middle-click/keyboard semantics for what is, in
  practice, most of what an operator clicks on the Wall. The badge, by
  contrast, is a small enhancement on ONE tile among many — the operator can
  still reach the job/agent detail page by opening the device first, exactly
  as they would for a `user`-kind holder today, which was never a link
  either.
- `packages/studio/src/components/wall/WallTile.tsx` — both `HolderBadge`
  calls (`heldBy` and `assistedBy`) now pass `asLink={false}`; the
  now-unneeded `onClick={(e) => e.stopPropagation()}` wrapper divs (there
  specifically to let the nested `Link`'s own click win over the tile's) are
  removed, since nothing inside is interactive any more and a click on the
  badge now simply falls through to the tile's own navigation, same as
  clicking any other chrome on the card.
- `packages/studio/src/components/wall/WallTile.test.tsx` — the pre-existing
  `user`-kind workaround test is kept (still a real scenario: `heldBy` and
  `assistedBy` coexisting), and two NEW tests replace the avoidance: one
  renders a real `kind: 'job'` `heldBy` and asserts the badge is a `<span>`
  (`tagName === 'SPAN'`) with exactly one `<a>` on the whole page (the tile's
  own root), the other does the identical proof for `kind: 'agent'` — the
  missing coverage this register's own brief named as "why this survived" is
  now closed by exercising the exact case that used to be routed around.
  `packages/studio/src/components/HolderBadge.test.tsx` gained its own
  direct `asLink={false}` coverage (job, agent, user-is-unaffected, and
  default-stays-`true`) rather than relying on `WallTile`'s tests alone to
  prove the mechanism. `packages/studio/src/components/DevicePicker.test.tsx`
  is a new file (none existed before this pass) covering: no badge with no
  `assistedBy`, the badge beside `heldBy` when assisted, and the `?? []`
  guard for a caller that predates the field. `packages/studio/src/app/page.test.tsx`
  gained a captured-listener helper (`emit`, wrapped in `act(...)`, the same
  pattern `DeviceLog.test.tsx` already established for this exact "deliver a
  fake `ws` message" shape) and three new cases: a same-device broadcast
  adds the badge with no refetch, a different-device broadcast is ignored,
  and an empty `assistedBy` clears a previously-shown badge (covering `ttl`/
  `primary_ended`/`released` alike, since the branch does not distinguish
  reasons — it just mirrors whatever the server published, exactly like
  `lease.changed` already does for `heldBy`).

**Not touched, flagged rather than fixed.** `DevicePicker.tsx`'s own row is
a `<button type="button" role="option">`, and `HolderBadge`'s `heldBy` line
there (pre-existing, unrelated to gap 2 above) already rendered a `job`/
`agent` holder as a `<Link>` nested inside that button — the identical class
of invalid-HTML defect as gap 3, one level removed (a `<button>` may not
contain another focusable/interactive descendant either). This pass's own
new `assistedBy` line repeats the same pattern rather than introducing a new
one. It was not named by plan 91 step 91.6, not named by this task's own
three-gap brief (scoped explicitly to `WallTile`), and fixing it would mean
deciding whether `DevicePicker`'s row should stop being a `<button>` — a
larger, unrelated interaction-model question (keyboard `role="option"`
semantics) this pass was not asked to open. Left for whoever next touches
`DevicePicker.tsx`, recorded here so it is not mistaken for something this
entry already covers.

**Verification.** Scoped run first: `bun run --cwd packages/studio test
src/components/HolderBadge.test.tsx src/components/DevicePicker.test.tsx
src/components/wall/WallTile.test.tsx src/app/page.test.tsx` → 31 pass / 0
fail (53 `expect()` calls). Full workspace, 2026-08-13: `bash
scripts/typecheck.sh` — every package OK. `bun test`: 3802 pass / 1 fail
(14938 `expect()` calls, 278 files) — the one failure is
`daemon-wiring.test.ts`'s own pre-existing, deliberately-red
`onAssist`/`ExecutorHost.notifyAssist` guard (step 91.5's own flagged gap,
named "SELF-DETECTING, currently fails on purpose" in its own test name and
in this document's §1 framing — left alone per this pass's own instructions;
the second guard this pass started with, `jobs/executor-kind-dispatch.test.ts`,
had already gone green by the time this pass ran, closed by a concurrent
worker's landed wiring, not by this entry). `bun run --cwd packages/studio
test`: 711 pass / 0 fail (up from 699 — the 12 new cases listed above), 1511
`expect()` calls, 94 files. `bun run --cwd packages/studio build`, run
alone: succeeded cleanly (28/28 static pages, exporting 2/2). `ps -Ao
pid=,command= | grep -i "[o]penpf"` — nothing but this pass's own shell.

### 96.13 — `coControl.queueWaitMs`/`coControl.maxQueueDepth` never reached the real input arbiter (13th instance of this defect class); `onAction`, a related seam, turned out to have no producer and no consumer at all and was removed. FIXED.

**What broke.** Plan 91 step 91.1 built `packages/session/src/input-arbiter.ts` —
three lanes, a bounded queue governed by `queueWaitMs`/`maxQueueDepth`, both
read fresh on every submission through callbacks (never captured once). Step
91.3 shipped `coControl.queueWaitMs`/`coControl.maxQueueDepth` as real farm
settings — registered in the Farm Settings UI, validated, persisted, changeable
by an operator today. They never reached the arbiter:
`packages/session/src/manager.ts`'s `SessionManagerDeps` had no field to
receive them at all, so `packages/session/src/session.ts`'s own
`createSession` call built every arbiter with this file's hardcoded stand-in
defaults (`DEFAULT_ARBITER_QUEUE_WAIT_MS = 5_000`,
`DEFAULT_ARBITER_MAX_QUEUE_DEPTH = 32`) — `session.ts`'s own header comment
said outright these were "stand-in defaults... used until a later step threads
the real farm setting through `SessionManagerDeps` → `CreateSessionDeps`", and
no step ever had. An operator could change either value in Studio and nothing
happened, with no error and no log line — step 91.10's own status note found
and flagged this exact gap, by file, rather than silently leaving it. This is
the same defect class this register already names a dozen times over
(§96.5/§96.6/§96.9/§96.10/§96.11): a mechanism proven correct in isolation,
never reaching the one production call site — the thirteenth instance found in
this repo, and among the most operator-visible, since the two settings render
fully configured in Farm Settings and silently do nothing.

**A related, second gap in the same area, investigated per this pass's own
brief rather than assumed.** Step 91.1 also built `onAction`, an optional
callback on `createInputArbiter`'s options, describing it as "one callback per
completed action — the attribution feed (§3.5)", explicitly meant to feed step
91.5's `jobs.assistCount`/`device_events`/audit attribution work. Grepping the
whole workspace for `onAction`/`onInputAction` (its name at the
`CreateSessionDeps`/`SessionManagerDeps` layer) found exactly three files: the
declaration and the two call sites inside `input-arbiter.ts` itself
(`opts.onAction?.(...)`, fired from `runNow`'s two resolution branches), and
one test file (`input-arbiter.test.ts`) exercising it directly. Nothing in
`packages/session/src/manager.ts` ever declared a field to receive it from a
caller, and nothing in `packages/core` (or `packages/node`) ever read a
`SessionManager`-level equivalent — there was no way for a production caller
to supply an `onAction` even if one had wanted to. Reading how step 91.5
actually shipped attribution confirms it never needed to: `ws-handlers.ts`'s
`input.*` branch resolves `assistJobId` and calls `deps.recorder.record(...)`
directly, inline, at the same call site that already knows the verb-specific
payload (tap position, swipe endpoints, keycode, redacted text) — data
`onAction`'s generic `{lane, source, verb, waitedMs, ranMs}` event never
carried and could not have carried without a redesign. `mirror/group.ts`'s
`dispatch` does the identical thing independently for the mirror path. So
`onAction` had **no producer** (no field existed above `input-arbiter.ts` to
wire one) **and no consumer** (attribution took a different, richer path that
was never going to read a generic completion event) — not merely unwired, but
architecturally superseded before it was ever connected. Per this pass's own
instruction and the same rule CLAUDE.md states for `vpn-helper`'s `probe`
("nothing in this codebase should claim a capability it does not deliver"):
wiring a producer for a callback nothing consumes would have made the seam
look used without it being used by anything, so it was removed instead.

**Evidence.** `packages/session/src/manager.ts` (before this fix) —
`SessionManagerDeps` had no `arbiterQueueWaitMs`/`arbiterMaxQueueDepth` fields,
and `createEntry`'s deps object passed to `createSession` had nothing named
`arbiter*` at all. `packages/core/src/daemon.ts` (before this fix) — the one
real `createSessionManager({...})` call (`daemon.ts:2315`) passed `client`,
`devices`, `log`, `withGuestAgentClient`, `onSessionEnded`, `onPhase`,
`onEvent`, `idleTtlSec`, `maxIdleSessions`, `makeScrcpy`, `makeInspector` — no
`arbiterQueueWaitMs`/`arbiterMaxQueueDepth`. `onAction`: `grep -rn
"onInputAction\|onAction" packages --include="*.ts"` (excluding tests) matched
only `session.ts`'s declaration/forwarding and `input-arbiter.ts`'s own
declaration and two call sites — zero matches in `manager.ts`, `daemon.ts`,
`hosts.ts`, `ws-handlers.ts`, or `mirror/group.ts`.

**A correction to this entry's own assignment, recorded rather than silently
acted around.** The task that produced this entry named the two settings to
thread as `coControl.queueWaitMs` and `coControl.maxConcurrentPerDevice`.
Reading `input-arbiter.ts`'s actual `CreateInputArbiterOpts` (`queueWaitMs`,
`maxQueueDepth` — no concept of "concurrent" anything) and
`packages/protocol/src/settings.ts`'s `coControl` schema (which declares
`queueWaitMs`, `maxQueueDepth`, AND a separate `maxConcurrentPerDevice`) showed
`maxConcurrentPerDevice` has nothing to do with the arbiter: it bounds how many
simultaneous assist GRANTS `CoControlManager` allows on one device
(`packages/core/src/lease/co-control.ts:213`), a completely different
mechanism, and it was already fully wired — `daemon.ts:1090`'s
`createCoControlManager({...})` call has passed `maxConcurrentPerDevice: () =>
settingsStore.get().coControl.maxConcurrentPerDevice` since steps 91.2/91.4,
long before this pass, pinned by `daemon-wiring.test.ts`'s pre-existing
"co-control" describe block. Plan 91's own step 91.10 status note — the
primary source, re-read directly rather than trusted from the task's
paraphrase — names the real gap correctly as `queueWaitMs`/`maxQueueDepth`
twice, unambiguously. This entry threads `queueWaitMs`/`maxQueueDepth` (the
real, confirmed gap) and leaves `maxConcurrentPerDevice` untouched (already
correct); see `docs/plans/91-m56-co-control-and-mirror-input.md`'s own closure
note on its "Known gap" paragraph for the same correction made in-context.

**Fixed.** `packages/session/src/manager.ts` — `SessionManagerDeps` gains
`arbiterQueueWaitMs?: () => number` / `arbiterMaxQueueDepth?: () => number`
(doc comment explains the "forwarded unresolved, never captured" contract);
`createEntry`'s deps object passed to `createSession` spreads them through
optionally, the same `...(deps.xxx ? { xxx: deps.xxx } : {})` idiom
`withGuestAgentClient` already uses two lines above. `packages/session/src/session.ts`
needed no behavioural change at all — `CreateSessionDeps.arbiterQueueWaitMs`/
`arbiterMaxQueueDepth` and their wiring into `createInputArbiter(...)` were
already correct since step 91.1; only its doc comments (and the
`DEFAULT_ARBITER_*` header comment) were updated to stop describing a
"not threaded yet" state that is no longer true, and the now-dead
`onInputAction` field, its type imports (`InputLane`/`InputSource`, now
unused in this file), and its `...(deps.onInputAction ? {...} : {})` spread
were removed. `packages/session/src/input-arbiter.ts` — `onAction` removed
from `CreateInputArbiterOpts` and both call sites in `runNow` (the
now-unused `startedAt` timestamp removed alongside its only reader); a
permanent design note added to the file's own header comment explaining what
`onAction` was for, why 91.5 did not end up needing it, and pointing here so a
future reader does not re-add an unconsumed seam under the same name.
`packages/session/src/input-arbiter.test.ts` — the "onAction attribution
(§3.5)" describe block removed, replaced with a comment recording the same
finding (this file, uniquely among the ones touched, needed a source change
just to keep compiling once the type shrank). `packages/core/src/daemon.ts` —
the real `createSessionManager({...})` call gains
`arbiterQueueWaitMs: () => settingsStore.get().coControl.queueWaitMs` /
`arbiterMaxQueueDepth: () => settingsStore.get().coControl.maxQueueDepth`,
beside the existing `idleTtlSec`/`maxIdleSessions` accessors, matching their
exact "read fresh via a settings-store closure" shape.

**Tests — proven from the surface, not the helper.** A test that
`createInputArbiter` honours a `queueWaitMs`/`maxQueueDepth` it is directly
handed already existed (`input-arbiter.test.ts`) and had passed throughout
this defect's entire lifetime — proof it could never have caught "the one
production call site never passed the accessor," since it never goes near
`SessionManagerDeps` at all. `packages/core/src/daemon-wiring.test.ts` gains a
new "input arbiter settings" describe block with three cases: (1) a static pin
(the same `extractCall`-based style every other case in this file uses) that
`daemon.ts`'s real `createSessionManager({...})` call contains both new
accessor expressions verbatim; (2) a behavioural test that builds a REAL
`SessionManager` (`createSessionManager` from `@enkaku/session`, unmodified)
wired with the identical accessor SHAPE `daemon.ts` uses — a closure reading a
mutable settings-like object, never a captured number — acquires a real
session against a fake `AdbClient` (the same `fakeClient`/`DeviceSnapshot`
fixture shape `manager.test.ts`/`session.test.ts` already use, no scrcpy, the
plain `adb-input` fallback path), and proves that mutating
`farmSettings.coControl.maxQueueDepth` AFTER that session is already open and
already has one action running changes whether the SAME session's arbiter
refuses or queues the next action on the SAME already-open session — never
merely on a session built fresh after the change; (3) a second behavioural
test proving `queueWaitMs` is independently read fresh at the moment a NEW
action is submitted (not polled continuously during an existing wait):
lowering it while one action is already running and BEFORE a second one is
submitted causes that second action to be refused close to the new, short
budget rather than the original ten-second one. Together, (2) and (3) are the
assertion this pass's own brief asked for directly: proof that changing the
farm setting changes the behaviour of a session built the way `daemon.ts`
builds it, which a helper-level arbiter test could never have caught.

**Hardware honesty.** Nothing in this entry needed a physical device to build
or verify — every new test drives the real `SessionManager`/`createSession`
production code path against an in-memory fake `AdbClient`, never a real
`adb`. **Pending — owner to run**, the one part that genuinely benefits from a
real device (never attempted by this pass, per this plan series' own
hardware-honesty rule — this is an incremental extension of plan 91 step
91.10's own H-91.10 tables above, not a duplicate of them):

| # | Claim | Exact command | What confirms it |
|---|---|---|---|
| H-96.13a | Lowering `coControl.queueWaitMs`/`coControl.maxQueueDepth` in Studio's Farm Settings while a real device session is already open changes that device's real input-refusal behaviour immediately, with no reconnect and no session restart | `bun run dev`, `bun run dev:studio`, enrol a phone, open its device page (a session opens), in a second tab open Settings → Farm → Assisting and set "Max queued input actions" to `0`, then rapidly send two taps on the device page while a script or a second assisting tab holds the pointer lane busy | The second tap is refused with a message naming the blocker (`E_INPUT_BUSY`), without needing to reload the device page or reopen the session |
| H-96.13b | `GET /api/adb/stats \| jq '.input.queueWaitMs'` (step 91.10's own field) matches whatever `coControl.queueWaitMs` is currently set to in Farm Settings, live, no restart | Same boot, change the setting, `curl -s localhost:7700/api/adb/stats \| jq '.input.queueWaitMs'` before and after | The reported value tracks the setting change immediately |

**Verification.** Scoped run first: `bun test packages/session/src/manager.test.ts
packages/session/src/session.test.ts packages/session/src/input-arbiter.test.ts
packages/core/src/daemon-wiring.test.ts` → 65 pass / 0 fail (198 `expect()`
calls). Full workspace, 2026-08-13: `bash scripts/typecheck.sh` — every
package OK except `core`, which carries exactly the one pre-existing,
unrelated error this pass was told about up front and told not to touch —
`packages/core/src/api/jobs.ts(204,49)` (a duplicate `JobNodesResponseSchema`
shadowing the correct one, `packages/protocol/src/messages/job.ts`, under
active arbitration by the repo owner). An EARLIER run in this same pass also
showed five additional, different `runtime`-property errors in
`packages/core/src/plugins/**`/`packages/core/src/scripts/**`/
`packages/core/src/schedules/runner.test.ts` — confirmed, by `git status`
showing every one of those files uncommitted and by two of their mtimes being
minutes old at the time, to be a concurrent worker's in-flight, unrelated
script-runtime change; a second run minutes later showed only the one
documented `jobs.ts` failure, confirming the `runtime` errors were transient
and not this entry's. `bun test`: 3888 pass / 0 fail (15209 `expect()` calls,
283 files) — up from the 3879/1–2-known-failure baseline this pass started
from; no failures anywhere in the tree at the time of this run, including the
plan-99 workflow resume-replay guard this pass was told was another worker's
in-flight self-detecting gap and to leave alone (it was green on this run,
closed by that other worker during the same window, not by this entry). `bun
run --cwd packages/studio test`: 733 pass / 0 fail (1567 `expect()` calls, 95
files) — unchanged from baseline, since this entry touches no Studio file.
`bun run --cwd packages/studio build`, run alone as required: succeeded
cleanly (28/28 static pages, exporting 2/2). `ps -Ao pid=,command= | grep -i
"[o]penpf"` — nothing but this pass's own shell.

### 96.14 — Plan 98 §3.7/§4.6 step 98.5's own recorded gap: `jobs.max_concurrent` was resolved and enforced for a standalone `enqueue()`/`resume()` and a triggered job, but silently `null` ("unlimited") for every batch-dispatched job — the ordinary way an operator runs a script across a farm. FIXED.

**What broke.** Plan 98 step 98.5 shipped `jobs.max_concurrent`: resolved via
`resolveRuntime({ farm, script: entry.runtime, override: null })` at every
place a `jobs` row is created, and enforced inside `claimNext`'s `BEGIN
IMMEDIATE` transaction as a correlated `COUNT(*)` keyed on `script_name`.
That step's own status paragraph and its `00-overview.md` §9 row both
recorded, by name, that it covered only THREE of the places a `jobs` row is
created — `services/job-service.ts`'s `enqueue()`/`resume()` and
`jobs/triggers.ts`'s `trigger()` — and explicitly did not cover the fourth:
`clusters/dispatch.ts`'s `createBatch`, whose `toJobRow` wrote every batch
member with `maxConcurrent: null` unconditionally, because the file had no
`ScriptRegistry` in its dependency graph at all to resolve a cap from. This
was a known, recorded gap, not a silent one — but a script author declaring
`maxConcurrent: 1` on their script had every reason to believe it was
honoured everywhere, and it visibly was not the moment the SAME script ran
as a batch across several devices at once, which is how an operator
actually exercises a farm of many phones (as opposed to one device at a
time). A second, undocumented consequence made simply "resolving the
number" insufficient on its own: `claimNext`'s gate correlates running
siblings with `r.script_name = j.script_name`, and SQL's `=` never matches
`NULL = NULL` — a batch member's `script_name` was ALSO always `null`
(plan 82 §3.4's own, separately recorded gap, sharing the identical root
cause). Writing a correct `maxConcurrent` while leaving `scriptName` null
would have resolved the cap and then had the claim gate silently never see
it — the same "the fix makes the inconsistency worse, not better" shape
this same pass's `workflow.maxTotalMs` gap hit on the very same day
(`packages/core/src/jobs/executors/workflow.ts`'s own doc comment) — so
both had to close together, not one at a time.

**Evidence.** `packages/core/src/clusters/dispatch.ts` (before this fix) —
`toJobRow` wrote `scriptName: null, scriptVersion: null, maxConcurrent:
null` unconditionally, with its own comment naming the missing
`ScriptRegistry` as the reason; `BatchDispatchDeps` had no accessor to
supply one. `packages/core/src/queue/job-store.ts`'s `claimNext` (read, not
edited — a second worker owns this file): `r.script_name = j.script_name`
in the correlated `COUNT(*)` subquery, confirmed by direct SQL reasoning
(and reproduced live, see the non-vacuousness check below) to admit
unconditionally whenever `j.script_name IS NULL`, regardless of how many
siblings are actually running.

**Fixed.** `packages/core/src/clusters/dispatch.ts` — `BatchDispatchDeps`
gains two optional accessors, `scriptNameOf?: (scriptId) => { name,
version, runtime? } | null` and `farmJobSettings?: () => JobSettings`, the
IDENTICAL shape `services/job-service.ts`'s own `enqueue()`/`resume()`
already use (that file was not edited — a second worker owns it; the shape
was copied, not imported). A new `resolveBatchMemberMaxConcurrent` helper
mirrors `job-service.ts`'s own module-private `resolveJobMaxConcurrent`
exactly — both do nothing but forward into `resolveRuntime` from
`@enkaku/protocol`, the one place `maxConcurrent`'s precedence
(`override ?? script ?? 0`) actually lives, so the two cannot diverge on
the decision itself even though the thin wrapper text is duplicated.
`createBatch` now resolves `scriptName`/`scriptVersion`/`maxConcurrent`
ONCE per batch (every member shares one `scriptId` — not once per device)
and threads all three into `toJobRow`. `packages/core/src/api/batches.ts`
wires `scriptNameOf` at both `createBatch(...)` call sites (`POST /` and
`POST /:id/rerun-failed`) by reusing the `scriptRegistry` dependency
already threaded into `BatchRoutesDeps` for `rerun-failed`'s params-schema
lookup — no new dependency, no new field on that interface. Both new
accessors are optional, so every pre-existing caller/test keeps compiling
unedited; omitted, a batch member resolves exactly as before this fix
(`scriptName: null`, `maxConcurrent: 0` — "unlimited", the same fallback
shape `job-service.ts`'s own `enqueue()` has when ITS `scriptNameOf` is
unwired; previously a literal `null`, but `queue/job-store.ts`'s own
comment states `0`/`NULL` are equivalent to the claim gate, so this is not
a behaviour change).

**Tests — the real claim path, not the helper.** New file
`packages/core/src/clusters/dispatch-batch-max-concurrent.integration.test.ts`
(4 tests), reusing `job-store.test.ts`'s own established pattern rather than
inventing a weaker one: (1) dispatching a `maxConcurrent: 1` script as a
batch across three idle devices pins `maxConcurrent: 1` and `scriptName` on
all three rows — the gate's own precondition; (2) with `scriptNameOf`
unwired, a batch member still resolves to unlimited (`0`) — no regression
for a caller with no interest in the cap; (3) the plan's own verifiable
result reproduced for a BATCH: one `running`, two `queued`, same-process
sequential `claimNext` calls; (4) **the genuine article** — `claim-race-worker.ts`
(existing, UNMODIFIED — reused exactly as `job-store.test.ts`'s own
multi-process race already does, not duplicated), spawned as 8 real,
separate OS processes via `Bun.spawn`, each with its own SQLite connection
to the same on-disk database `createBatch` just populated, hammering
`claimNext` 25 times each with no coordination — admits exactly one of the
three batch members, across every process and every attempt.

**Verified as meaningful, not vacuous**, matching step 98.5's own worker's
check on the underlying SQL gate, but pointed at THIS fix instead (the
underlying gate itself is already proven separately and exhaustively in
`job-store.test.ts` — not re-proven here): `createBatch`'s own
`maxConcurrent` resolution was temporarily forced back to the pre-fix
constant (`0`, i.e. "unlimited," simulating the exact state before this
entry), and the SAME multi-process race — 8 real OS processes, 25 attempts
each, zero code changes to the test — then admitted all 3 of 3 batch
members instead of 1, and the sequential same-process test (2) above failed
at its very first assertion (`maxConcurrent` read back `0`, not `1`). The
fix was then restored and every test re-run green. This confirms the
harness genuinely detects the regression this entry closes, not merely
exercising a path that always happens to pass.

**A note on scope.** `docs/plans/98-m63-script-runtime-envelope.md`'s own
status paragraph and its `98.5` step section both carry an addendum dated
alongside this entry, pointing back here; `docs/plans/00-overview.md` §9's
row for this gap should be updated to mark it closed by whichever pass next
holds that file (this pass was told not to touch it directly).

**Hardware honesty.** Nothing in this entry needed a physical device —
`createBatch` and `claimNext` are both pure-SQLite production code paths,
exercised here against a real on-disk `bun:sqlite` file (not `:memory:`,
for the multi-process test — separate OS processes cannot share an
in-memory database) but never against a real `adb`/device. Nothing to add
to a hardware-pending table for this entry: dispatching a batch and
claiming jobs off it involves no device-side behaviour at all until AFTER
a claim succeeds, which is unchanged by this fix.

**Verification.** Scoped run: `bun test
packages/core/src/clusters/dispatch-batch-max-concurrent.integration.test.ts
packages/core/src/clusters/dispatch.test.ts packages/core/src/api/batches.test.ts
packages/core/src/jobs/executors/workflow-settings-wiring.test.ts
packages/core/src/daemon-wiring.test.ts` → 56 pass / 0 fail (184 `expect()`
calls). Full workspace, 2026-08-13: `bash scripts/typecheck.sh` — every
package OK except `core`, which carries exactly the one pre-existing,
unrelated error this pass was told about up front and told not to touch —
`packages/core/src/api/jobs.ts(204,49)` (a duplicate `JobNodesResponseSchema`
shadowing the correct one, under active arbitration by the repo owner, per
`docs/plans/96-m61-hotfixes.md`'s own §96.13 entry which hit the identical
line). `bun test`: two consecutive full runs, 3981 pass / 0 fail and 3989
pass / 0 fail (287 files both times) — an earlier run in the same session
showed a handful of unrelated transient failures (`EPERM: operation not
permitted, rename adb`/`rename ui-server` inside `tools/provision.test.ts`,
and a couple of timing-sensitive network-reconcile tests), consistent with
this document's own standing warning that concurrent workers sharing this
tree produce occasional transient `EPERM`/`ENOENT` noise; two clean re-runs
back to back confirm it was not this entry's. No deliberate-guard failures
remain anywhere in the tree at the time of this run. `bun run --cwd
packages/studio test`: 809 pass / 0 fail (1802 `expect()` calls, 107
files) — unchanged in substance from baseline (804/0), since this entry
touches no Studio file; the small count drift is pre-existing test growth
elsewhere in the tree, not this entry's. `bun run --cwd packages/studio
build`, run alone as required: succeeded cleanly (28/28 static pages).

### 96.15 — §96.14's "closed" claim was incomplete: `schedules/runner.ts`'s `fireOnce` builds its own `BatchDispatchDeps` literal with no `scriptNameOf`, so a schedule-fired batch bypassed both the version gate and the `maxConcurrent` gate 96.14 believed it had closed for every batch path. FIXED.

**What broke.** §96.14 wired `scriptNameOf` (and the `maxConcurrent`/
`scriptName` resolution it unlocks) into `clusters/dispatch.ts`'s
`createBatch`, and into both of `api/batches.ts`'s call sites — but there is
a THIRD, and in production the only automatically-firing, call site:
`packages/core/src/schedules/runner.ts`'s `fireOnce`, which builds its own
local `batchDeps: BatchDispatchDeps` object a few lines before its own
`createBatch(batchDeps, ...)` call. That literal carried `db`/`scheduler`/
`audit`/`onJobStatus`/`validateScript` and nothing else, even though
`ScheduleRunnerDeps.registry` (a real `ScriptRegistry`, wired in production
by `daemon.ts`'s `createScheduleRunner({ ..., registry: scriptRegistry })`
call) was already sitting on `deps` and already used a few lines further
down in the SAME function to resolve `deps.registry.resolve(parsedRef.data)`
before dispatch. With `scriptNameOf` unset, `createBatch`'s `named` local
resolved to `null` for every schedule-fired batch, which had two
consequences, not one: plan 98 §3.3 S1's `checkRuntimeMajor(named?.runtime
?.sdk)` version gate (added by the SAME audit that produced §96.14) received
`undefined` and never refused, so a schedule firing a script whose
`runtime.sdk` this core does not support still dispatched a batch and every
member claimed a device — exactly what plan 98's acceptance criterion 11
("never claims a device") forbids; and `resolveBatchMemberMaxConcurrent`
resolved `0` ("unlimited") with `scriptName` written `null` on every job row,
the identical pre-96.14 defect that entry believed it had closed everywhere
— `api/schedules.ts`'s own documented behaviour is that a schedule "triggers
a batch... never a bare job", so this is the ordinary way an operator's
`maxConcurrent: 1` script actually runs unattended, not an edge case.

**Evidence.** `packages/core/src/schedules/runner.ts` (before this fix),
inside `fireOnce`'s script branch — the `batchDeps: BatchDispatchDeps`
literal had five keys, none of them `scriptNameOf`. `daemon.ts`'s
`createScheduleRunner({...})` call (around the schedule-runner construction
site, alongside the queue scheduler/expiry reaper wiring) already supplies
`registry: scriptRegistry` — confirmed by reading that call site directly
before applying the fix, exactly as instructed, rather than assuming the
worker who found this gap had verified it. `packages/core/src/jobs/scheduled-batch-version-gate.test.ts`
(pre-existing in the tree, written by the auditing worker who found this gap
and correctly left it unedited per this repo's own "make the gap
self-detecting, then hand it to whoever owns the file" convention) called
the real `fireOnce` against a real SQLite DB and a real `ScriptRegistry`
with a script row declaring `runtime.sdk: 99`, and failed before this fix:
`outcome` read `'dispatched'`, not `'error'`, and a job row existed for the
refused script.

**Fixed.** `packages/core/src/schedules/runner.ts` — `fireOnce`'s
`batchDeps` literal gains one line, the exact fix handed over by the
auditing worker, verified against the live file before applying:

```ts
...(deps.registry ? { scriptNameOf: (scriptId: string) => deps.registry!.get(scriptId) } : {}),
```

— the identical shape `api/batches.ts`'s two call sites already use
(`scriptNameOf: (scriptId) => deps.scriptRegistry?.get(scriptId) ?? null`),
adapted to this file's own `registry` field name; `ScriptRegistry.get`
already returns `ScriptEntry | null`, which is directly assignable to
`BatchDispatchDeps.scriptNameOf`'s `{ name, version, runtime? } | null`
return type with no extra coercion needed. `farmJobSettings` has no
equivalent source on `ScheduleRunnerDeps` today; per plan 98 §3.7's own
design this is not a new gap — it resolves exactly like every other unwired
`farmJobSettings` call site already does (no farm-wide ceiling on
`maxConcurrent` exists yet to read), so only `scriptNameOf` was required to
close this finding. No other `BatchDispatchDeps` literal or `createBatch(`
call site exists in the workspace beyond these three (`clusters/dispatch.ts`'s
own definition/export aside) — a workspace grep for both found nothing
`api/batches.ts` and this file didn't already cover, so this closes the
gap for every write path, not just the one the test named.

**Tests.** `packages/core/src/jobs/scheduled-batch-version-gate.test.ts`
required no edit — it went green from the `runner.ts` fix alone, exactly as
its own doc comment predicted. A second, new test was added for the
`maxConcurrent` half of the same gap (the brief's own point: closing the
version gate without also proving the concurrency cap would repeat 96.14's
mistake at one remove) — `packages/core/src/schedules/runner.test.ts` gained
`fireOnce — a scheduled batch member carries the SAME runtime.maxConcurrent
cap and scriptName a standalone enqueue() applies`: a `maxConcurrent: 1`
script fired by a schedule across three idle devices, asserting every one of
the three resulting job rows carries `maxConcurrent: 1` and a non-null
`scriptName`/`scriptVersion`, then proving the claim gate actually honours
it — sequential `claimNext` calls admit exactly one job, not three — the
same non-vacuous proof `dispatch-batch-max-concurrent.integration.test.ts`
already established for the two direct `createBatch` call sites, reproduced
here through the real `fireOnce`.

**Hardware honesty.** Nothing here needed a physical device — `fireOnce`,
`createBatch`, and `claimNext` are pure-SQLite production code paths,
exercised here against `:memory:` SQLite. Nothing to add to a
hardware-pending table.

**Verification, full workspace, 2026-08-13.** `bash scripts/typecheck.sh`:
every package OK except `core`, which carries exactly the one pre-existing,
unrelated error this pass was told about up front and told not to touch —
`packages/core/src/api/jobs.ts(213,49)` (the duplicate-schema collision
under active arbitration, the same line §96.13/§96.14 both already named,
now at a shifted line number from concurrent edits elsewhere in that file).
`bun test`: **3999 pass / 0 fail** (15469 `expect()` calls, 289 files) — up
from the stated baseline of 3997 pass / 1 fail by exactly one (the
version-gate guard, now passing) plus one (the new `maxConcurrent` test
this entry added); no other failure appeared, and `memory-limit.integration
.test.ts`'s known-flaky `enforce: "kill"` case (called out up front as not
this pass's to fix) did not flake in this run. `bun run --cwd packages/studio
test`: 816 pass / 10 fail — **not this entry's**: this pass touched no file
under `packages/studio/**` (explicitly out of scope, held by a concurrent
worker per this session's own file-ownership list) or anything Studio
imports from at build time, and every failing test is a `Dashboard`
rendering/interaction test (`"Return to queue"`, `assist.changed` badges,
`job.status` live merge, Wall selection) unrelated to schedules or batch
dispatch; the stated baseline for this pass was 824/0, so this is a
regression already present in the shared tree from other agents'
uncommitted, in-progress work (`packages/studio/src/components/DeviceLog.tsx`
and others were already modified, uncommitted, before this pass started) —
recorded here for the next reader rather than silently worked around, since
this document's own §2 rule is that an orphan gets written down, not
absorbed into an unrelated entry's numbers.

### 96.16 — Plan 94 step 94.3's action recorder was fully built and tested, but `daemon.ts` never constructed it — the fifteenth instance of this repo's "correct, tested code, unreachable production call site" defect class. FIXED.

**What broke.** Step 94.3 built the action recorder end to end and
unit/integration-tested every piece of it: `packages/core/src/recording/{anchors,session,service}.ts`
(43 passing tests), the WS tee and the three `recording.*` cases in
`packages/core/src/server/ws-handlers.ts` (8 more, `ws-handlers-recording.test.ts`),
a six-key `recording` farm-settings block each genuinely read, and a Studio
settings tab. The step's own report (preserved in plan 94's decision 6,
above) named the gap explicitly: `daemon.ts` never called
`createRecordingService`, so `WsHandlerDeps.recording` was `undefined` in
every real boot — `recording.start` refused `E_NOT_SUPPORTED` on a live
core, the `input.*` tee was a permanent no-op, and the Studio recording tab
had nothing behind it. `RecordingService` was fully exercised through a test
harness that builds its own `WsHandlerDeps` (`ws-handlers-recording.test.ts`)
but structurally unreachable from a real `bun run dev`. A second, narrower
gap sat inside `ws-handlers.ts` itself: `createWsMessageHandler`'s returned
object already exported a `stopRecordingForLeaseLost(deviceId)` forward-ref
(added by step 94.3 for exactly this purpose, mirroring `releaseLeaseHold`/
`releaseShellSession`), but nothing in `daemon.ts` called it — so even once
wired, an automatic lease revocation (idle timeout, quarantine, a takeover)
would have left a recording running under the NEXT holder, capturing
whatever they did with no record of where the handover happened.

**Evidence.** `grep -n recording packages/core/src/daemon.ts` returned zero
matches before this fix. `packages/core/src/daemon-wiring.test.ts` — the
file this repo added specifically because this defect class had already
recurred five times inside a single earlier gap (`createSessionManager`'s
`withGuestAgentClient`, §96.6) — carried no pin for the recorder at all.

**Fixed.** `packages/core/src/daemon.ts`:
- Imports `createRecordingService` from `./recording/service`.
- Constructs `const recordingService = createRecordingService({ settings: () => settingsStore.get().recording, blobs: agentBlobStore, log: log.child('recording') })` immediately after `agentBlobStore` is built (the SAME content-addressed blob store the agent loop already shares — F16, never a second store).
- Passes `recording: recordingService` to the `createWsMessageHandler(...)` call inside `attachWsRouter`.
- Declares `let stopRecordingForLeaseLost: ((deviceId: string) => void) | null = null` alongside the file's other forward-refs (`releaseShellSession`, `releaseLeaseReadinessHold`), and assigns `stopRecordingForLeaseLost = handler.stopRecordingForLeaseLost` once the handler exists — the exact pattern `releaseLeaseHold` already established.
- Calls `stopRecordingForLeaseLost?.(deviceId)` from BOTH `onManualRevoked` (idle timeout, quarantine, forced disconnect) and `onManualTakenOver` (a takeover). The task handoff named only `onManualRevoked`, but `onManualTakenOver` is a genuinely separate hook — a takeover revokes and acquires atomically without ever calling `release()`, so `onManualRevoked` never fires for it (the exact same reasoning `onManualTakenOver`'s own pre-existing comment already gives for why it separately re-runs `releaseShellSession`/`releaseLeaseReadinessHold`/`coControlRef.onPrimaryEnded` instead of relying on `onManualRevoked` to cover it). Wiring only the first hook would have left a takeover — one of the three routes the task description itself named as broken — still capturing the new holder's actions; both hooks call `RecordingService.stopForLeaseLost`, which is idempotent (a no-op when nothing is open on that device), so calling it from two independent hooks is safe.

**Tests.** `packages/core/src/daemon-wiring.test.ts` gained six pins under a
new `'the action recorder ...'` describe block: (1) `createRecordingService(...)`
is actually constructed from `settingsStore.get().recording`/`agentBlobStore`/
`log.child('recording')`; (2) `createWsMessageHandler(...)` passes
`recording: recordingService`; (3) the `stopRecordingForLeaseLost` forward-ref
is declared and assigned inside `attachWsRouter`; (4) `onManualRevoked` calls
it; (5) `onManualTakenOver` calls it too; and (6) an end-to-end behavioural
test — the "surface, not the helper" standard this file's own
`withGuestAgentClient` test already holds itself to — that builds a real
`LeaseManager` wired with the identical forward-ref shape `daemon.ts` uses, a
real `RecordingService`, and a real `createWsMessageHandler`, starts a
recording over the actual WS surface (`recording.start`), then ends the
lease through `leases.releaseDevice('dev-1', 'quarantined')` — deliberately
NOT `lease.release`, which already worked before this fix and would prove
nothing about the gap being closed — and asserts the recording actually
stopped and produced a finished document. Two pre-existing tests in the same
file needed their fixed-offset brace-slice windows widened (`2500`→`2900` for
the `onManualTakenOver` block, `6900`→`7200` for the `attachWsRouter` body)
because this fix's own lines land inside the exact text ranges those tests
slice — both were re-verified to still catch a regression at the new
offsets, not just widened to make the failure go away.

**Hardware honesty.** Nothing here needed a physical device — the recorder
observes taps/swipes/gestures/keys/text already flowing through the WS
router and a `LeaseManager`'s revoke paths, all exercised here against
`:memory:` SQLite and fake input sinks. Nothing to add to a hardware-pending
table.

**Verification, full workspace, 2026-08-13.** `bash scripts/typecheck.sh`:
every package OK except `core`, which carries exactly the one pre-existing,
unrelated error this pass was told about up front and told not to touch —
`packages/core/src/api/jobs.ts(213,49)` (the duplicate-schema collision
under active arbitration, the same line §96.13/§96.14/§96.15 all already
named). `bun test`: **4316 pass / 0 fail** (16102 `expect()` calls, 304
files) — up from the stated baseline of 4310 pass / 0 fail by exactly six,
the six pins this entry added; `memory-limit.integration.test.ts`'s
known-flaky `enforce: "kill"` case (called out up front as not this pass's
to fix) did not flake in this run (one `bun test` run earlier in this same
pass DID show the known flake — 4315/1 — reproducing exactly the symptom
this task was told about up front; re-running immediately after, unchanged,
came back 4316/0). `bun run --cwd packages/studio test`: 917 pass / 0 fail —
above the stated baseline of 886/0 and rising run to run (899 earlier in
this same pass) purely from concurrent, uncommitted work by other agents
already in the tree before this pass started, per `git status`'s snapshot at
the start of this session (`packages/studio/src/components/DeviceLog.tsx`
among others) — 0 fail on every run regardless, and this pass touched no
file under `packages/studio/**`. A `bash scripts/typecheck.sh` run mid-pass
also caught a MOMENTARY unrelated failure at
`packages/studio/src/app/settings/page.tsx(222,9)` (`Cannot find name
'ReactNode'`) — the same file plan 92 step 92.8's concurrent worker owns,
mid-edit at that exact instant; a re-run 5 seconds later was clean, and this
pass made no edit anywhere under `packages/studio/src/app/settings/**`.
`bun run --cwd packages/studio build`: succeeds, run alone as required.
`bash scripts/check-plan-status.sh`: clean, every plan's
declared artefact still agrees with the code.

### 96.17 — A recording's "Revert to literal" button does not restore the original typed text — it silently blanks it. FIXED.

**What broke.** Found while independently verifying plan 94 step 94.5's own
report against the code for this document's own step 98.9/spec-relay pass
(a documentation task, not a code-fixing one — recorded here rather than
patched, per that task's own instruction). `packages/studio/src/app/recordings/detail/page.tsx`'s
`StepRow` component has an `onLiteralise: (text: string) => void` prop whose
name and signature imply it restores a parameterised text step back to its
original literal value. It does not: the button's handler
(`detail/page.tsx:151`, `onClick={() => onLiteralise(paramName)}`) passes
`paramName` — the row's own *parameterise-input* `useState('')` at line 89,
which is never populated when a step is already parameterised, so it is
always the empty string in exactly the case this button exists to handle.
The parent's own handler (`detail/page.tsx:340-343`) additionally ignores
whatever argument it receives:

```ts
onLiteralise={() => {
  if (step.kind !== 'text') return
  updateStep(i, { ...step, value: '' })
}}
```

So clicking "Revert to literal" always sets the step's `value` to `''`,
never the text that was there before parameterising. This may be
unavoidable rather than a pure oversight — plan 94's own decision 4 (its
status header, and this document's own §96.16 entry) states a parameterised
step's original literal is deleted from the document the moment it is
parameterised, specifically so the sensitive value stops existing on disk —
in which case there may be nothing left to "revert" to, and the button's
own name/signature are simply wrong for what the feature can honestly do.
Either way, an operator clicking it today gets a silently emptied text
step, not the reverted value the label promises, and has to retype it.

**Evidence.** `packages/studio/src/app/recordings/detail/page.tsx:89`
(`const [paramName, setParamName] = useState('')`, shared by both the
parameterise input and the revert call), `:151` (the button's `onClick`),
`:340-343` (`onLiteralise`'s actual body, which drops its own parameter).
No existing test in `packages/studio/src/app/recordings/detail/page.test.tsx`
asserts what value a step holds after "Revert to literal" is clicked — the
gap was invisible to the test suite the same way the class of defect this
register exists for usually is.

**Fixed, 2026-08-13, by a worker assigned plan 93's step 93.7** (which owns
`packages/studio/src/app/recordings/**` in its own file list, as a second,
unrelated task alongside that step's real work — recorded here rather than
folded silently into 93's own status line). This entry's own two options
were both live candidates; the fix taken is **(b) with a scope narrower than
either option as originally written**, and the distinction matters enough to
spell out:

`RecordingStepSchema`'s `text` variant (`packages/protocol/src/recording.ts`)
was re-read before touching anything, and confirmed unchanged by this fix: a
`text` step's `value` is still EITHER a literal string OR `{ param }`, never
both, on the wire and at rest — there is still no field that retains a
literal alongside its parameterised replacement once a document is loaded
from or saved to the server. So option (b)'s literal reading — "thread the
step's own pre-parameterise literal through" as if it were recoverable from
the document itself — was still not available, and inventing a value where
none exists was explicitly out of bounds (this document's own framing: "say
so plainly rather than inventing a plausible-looking value").

What made a real, non-inventing fix possible: the literal is not ONLY ever
on the server-persisted document — for the few seconds between an operator
typing "Parameterise" and the value being replaced in local React state, the
literal still exists, in this one browser tab, in memory. `page.tsx` now
keeps a `WeakMap<RecordingStep, string>` (`priorLiteralRef`, keyed on the
step object's own identity so it survives a step being moved up/down but
not surviving past a page reload or a step that arrived from the server
already parameterised) populated at the exact moment `onParameterise` swaps
a step's `value` from a string to `{ param }`. "Revert to literal" now
looks up that map: when the browser genuinely still knows the value (the
operator parameterised it THIS session), it is restored byte-for-byte and
the button says "Revert to literal"; when it does not (a step loaded already
parameterised, or after a reload), the button is replaced with an honestly
different, separately labelled action, "Clear and re-type as literal," with
inline text explaining why nothing can be restored — never the old silent
`value: ''`. This is closer to option (a)'s honesty (the button never claims
a restoration it cannot deliver) while still delivering option (b)'s actual
behaviour whenever the data to do so honestly exists. Nothing new is
persisted to the server or the document to make this work — the privacy
reasoning in plan 94 decision 4 / spec §11.8 is completely unaffected, since
the map holds only what was already sitting in this tab's own memory a
moment earlier, and is discarded (never sent anywhere) the instant the step
is reverted, cleared, or the value is otherwise changed.

**Evidence of the fix.** `packages/studio/src/app/recordings/detail/page.tsx`
— `priorLiteralRef` (a `useRef(new WeakMap<RecordingStep, string>())` in
`RecordingDetailInner`), `onParameterise` (captures the literal into the map
before building the `{ param }` replacement), `onRevertLiteral` (new — looks
up and restores, replacing the old `onLiteralise`), `onClearLiteral` (new —
the honest fallback). `StepRow`'s `onLiteralise: (text: string) => void`
prop (which never actually received a usable `text`, per this entry's
original finding) is replaced with `priorLiteral: string | undefined`,
`onRevertLiteral: () => void` and `onClearLiteral: () => void` — the render
branch shows "Revert to literal" (with a `title` previewing what it
restores) when `priorLiteral !== undefined`, and "original text not kept —
nothing to revert to" plus "Clear and re-type as literal" otherwise.

**Tests.** Two added to `packages/studio/src/app/recordings/detail/page.test.tsx`:
"Revert to literal restores the exact text a step held before parameterising,
in the same session (96.17)" — parameterises `"hunter2"`, clicks Revert, and
asserts the literal (not an empty string) is back, which is exactly the
assertion this entry's own "Evidence" section noted no existing test made;
and "a step already parameterised on load has nothing to revert to, and says
so honestly instead of offering a fake revert" — loads a document whose only
step is already `{ param: 'password' }`, and asserts there is no "Revert to
literal" button at all, only the honest message and "Clear and re-type as
literal". Both pass; `bun run --cwd packages/studio test
src/app/recordings/detail/page.test.tsx` — 14 pass / 0 fail (the 12
pre-existing plus these 2), and the full `bun run --cwd packages/studio test`
run this same pass performed shows 0 fail workspace-wide (see plan 93's own
status line, step 93.7, for the exact totals — this fix's 2 tests are
included in that count, not a separate one).

**Hardware honesty.** N/A — a pure Studio DOM/state defect, no device
involved.

### 96.18 — `runtimeOverride` was built end to end on both sides of the wire and dropped in the middle: `EnqueueBody`/the create-batch body never declared it, so Zod silently stripped it before `JobService.enqueue()`/`createBatch()` ever saw it. FIXED.

**What broke.** Plan 98 step 98.7 built the per-job runtime override —
`jobs.runtime_override`, validated against `RuntimeEnvelopeSchema`, checked
against the farm ceiling before the row is written (`E_RUNTIME_OVER_CEILING`,
refused outright rather than clamped), pinned once at enqueue in
`packages/core/src/services/job-service.ts`, carried forward by `resume()`.
Step 98.8 then built the Studio surface: a collapsed Runtime section in
`RunScriptDialog` rendered from `RUNTIME_OVERRIDE_SCHEMA`, client-validated,
sent as `runtimeOverride` on both `POST /api/jobs` and `POST /api/batches`
bodies. But `EnqueueBody` (`packages/core/src/api/jobs.ts`) and the
create-batch body (`packages/core/src/api/batches.ts`) were plain
`z.object`s with no `.strict()` and no `runtimeOverride` key — so the field
was silently STRIPPED by each route's own parse before the service layer
ever saw it. An operator typed a memory ceiling for one job, pressed Run,
and nothing happened, with no error. 98.8's own status paragraph named this
gap explicitly and marked its manual smoke check **blocked** rather than
pending (`docs/plans/98-m63-script-runtime-envelope.md` §98.8).

A second, related gap surfaced while closing the first: `api/batches.ts`'s
own `ERROR_STATUS` map never listed `E_RUNTIME_UNSUPPORTED`,
`E_RUNTIME_ENVELOPE_INVALID`, or `E_RUNTIME_OVER_CEILING` — all three of
which `clusters/dispatch.ts`'s `createBatch()` can throw (the version gate
already did, closed per this document's own 2026-08-13 audit referenced in
`packages/core/src/jobs/batch-dispatch-version-gate.test.ts`, whose own
docstring incorrectly claimed "no `jobs.ts` `ERROR_STATUS` change was
needed... `api/batches.ts` already funnels a thrown `EnkakuError` through
the same handler `api/jobs.ts` uses" — the two files hold two SEPARATE
`ERROR_STATUS` maps and `app.onError`s, not a shared handler). Any of these
three codes thrown on the batch path fell through to `ERROR_STATUS[err.code]
?? 500` — an opaque 500, not the coded 400 an operator (and Studio's own
error handling) expects. This meant the version gate closed in this
document's own prior pass was still surfacing as a 500 over HTTP for a
batch, even though the underlying refusal was correct.

A third gap, found auditing the same code path: `clusters/dispatch.ts`'s
`createBatch()` never accepted a `runtimeOverride` at all — `toJobRow`'s own
comment said so outright ("a batch member has no per-job runtime override
today; `CreateBatchInput` carries no field to source one from"). Even once
the HTTP body carried the field, there was nowhere in the batch dispatch
path for it to land.

A fourth, adjacent gap found while wiring the third: `BatchRoutesDeps`
(`api/batches.ts`) had no `farmJobSettings` hook at all, and
`createBatch()`'s two call sites in that file never passed one — so even
with a ceiling CHECK now wired for a batch's override, the ceiling itself
always resolved to "none" (`JobSettingsSchema`'s own defaults: `maxTimeoutMs:
null`, `memory.maxRssBytes: null`), because no live farm settings ever
reached it. This is the same class `clusters/dispatch.ts`'s own comments
already flagged for `maxConcurrent` ("a future farm ceiling ... needs no
further change here" — true only once something calls the getter with a
real function) — just newly consequential now that a per-batch override
ceiling check exists to be starved.

**Evidence.** `grep -n runtimeOverride packages/core/src/api/jobs.ts
packages/core/src/api/batches.ts` returned zero matches before this fix.
`grep -n E_RUNTIME packages/core/src/api/batches.ts` likewise returned zero
matches in the `ERROR_STATUS` map. `clusters/dispatch.ts`'s `toJobRow` wrote
`runtimeOverride: null` unconditionally, with a comment stating there was no
field to source one from.

**Fixed.**
- `packages/core/src/api/jobs.ts`: `EnqueueBody` gains `runtimeOverride:
  z.unknown().optional()` — `unknown` deliberately, matching
  `JobService.enqueue()`'s own `input.runtimeOverride?: unknown`: the ONE
  validation against `RuntimeEnvelopeSchema` stays inside `enqueue()`
  (`E_RUNTIME_ENVELOPE_INVALID`/`E_RUNTIME_OVER_CEILING`, both already
  mapped to 400 in this file's `ERROR_STATUS`), so this body declares no
  second shape. `POST /` forwards `runtimeOverride: body.data.runtimeOverride`
  into `service.enqueue({...})`.
- `packages/core/src/api/batches.ts`: `CreateBatchBody` gains the identical
  `runtimeOverride: z.unknown().optional()`, flowing through automatically
  on `POST /` via the existing `{ ...body.data, createdBy: ... }` spread.
  `ERROR_STATUS` gains the same three entries `api/jobs.ts` already carries
  (`E_RUNTIME_UNSUPPORTED`/`E_RUNTIME_ENVELOPE_INVALID`/`E_RUNTIME_OVER_CEILING`,
  all 400) — closing the second gap above. `BatchRoutesDeps` gains an
  optional `farmJobSettings?: () => JobSettings`, threaded into BOTH
  `createBatch()` call sites (plain create and `rerun-failed`) — closing the
  fourth gap's WIRING HOOK; see "Not fixed" below for what still needs
  `daemon.ts`.
- `packages/core/src/clusters/dispatch.ts`: `CreateBatchInput` gains
  `runtimeOverride?: unknown`. `createBatch()` validates it against
  `RuntimeEnvelopeSchema` (`parseBatchRuntimeOverride`, new — shape failure
  throws `E_RUNTIME_ENVELOPE_INVALID`), resolves it alongside
  `maxConcurrent` through the SAME `resolveRuntime` call
  (`resolveBatchRuntime`, replacing the narrower `resolveBatchMemberMaxConcurrent`
  it supersedes), and refuses with `E_RUNTIME_OVER_CEILING`
  (`overBatchCeilingError`, new) before a single row is written whenever the
  override itself exceeds the farm's ceiling — never clamped, the same §3.8
  asymmetric rule `services/job-service.ts`'s own `enqueue()` already
  applies. The validated, resolved override is pinned onto every member row
  via `toJobRow`'s new `runtimeOverride` field — one operator instruction
  for the whole batch, exactly like `params`/`scriptId` already are, never
  re-resolved per device.

**Not fixed — reported, not mine to close.** `daemon.ts`'s own
`createBatchRoutes({...})` call site does not pass `farmJobSettings` (that
file is outside this fix's ownership — reassigned to a concurrent worker for
plan 97 step 97.4 for the duration of this pass). Until it does, a batch's
own `runtimeOverride` ceiling check runs but can never actually refuse
anything on a real farm — the SAME dormant-ceiling shape `maxConcurrent` has
had since step 98.5, just newly load-bearing now that a real refusal path
exists to be starved. The one remaining line is `farmJobSettings: () =>
settingsStore.get().job` added to that call site, the identical accessor
`daemon.ts` already builds for `services/job-service.ts`'s own
`createJobService({...})` call a few hundred lines earlier in the same file.
`BatchRoutesDeps.farmJobSettings`'s own doc comment carries this note at the
point of use. No other body-field gap was found: `JobService.enqueue()`'s
full input (`scriptId`, `deviceId`, `params`, `priority`, `actor`,
`runtimeOverride`) is fully covered by `EnqueueBody` plus the
auth-middleware-derived `actor`; `resume()`'s `{ fromNode? }` matches
`ResumeBody` exactly; `CreateBatchInput.expiresAt` is deliberately
schedule-only (`schedules/runner.ts`'s own `queueTimeoutSec` derivation) —
Studio's only batch-create surface (`RunScriptDialog.tsx`) has no expiry
control and none was expected to reach `POST /api/batches`; `rerun-failed`
parses no request body at all — every field it passes to `createBatch()`
comes from the stored batch row, by design (a rerun replays the original's
own settings, never a fresh one a caller could smuggle a value through).

**Tests.** `packages/core/src/api/runtime-override-wiring.test.ts` (new, 7
tests) — deliberately through the REAL HTTP routes (`app.request(...)`), a
real in-memory DB, a real `JobService`/`createBatch()`, never a fake service
standing in for the route: `services/job-service.test.ts`'s own
"an override under both ceilings enqueues normally, pinned verbatim" already
proved the SERVICE layer honours an override it is handed, and that is
exactly what let this gap slip past that suite — so this new file asserts
the WIRE, not the layer underneath it. `POST /api/jobs`: an override inside
the farm ceiling enqueues and is pinned onto the row (queried straight off
the `jobs` table, not the response body); an override over the ceiling
refuses `E_RUNTIME_OVER_CEILING` as a real HTTP 400 naming both numbers and
writes no row; a malformed override refuses `E_RUNTIME_ENVELOPE_INVALID`
(400, never a silent drop or a 500); no override at all pins `null`, unchanged
from before this field existed. `POST /api/batches`: the same four shapes,
asserted across every member job row of a multi-device batch (both rows
carry the identical pinned override; over-ceiling writes neither a batch nor
a job row).

**Hardware honesty.** Nothing here touches a phone — this is HTTP request
bodies, Zod validation, and SQLite rows. No pending hardware row to add.

**Verification, full workspace, 2026-08-13.** `bash scripts/typecheck.sh`:
every package OK except `core`, which carries exactly the one pre-existing,
unrelated, owner-arbitrated error this pass was told about up front and told
not to touch — `packages/core/src/api/jobs.ts`'s `JobNodesResponseSchema`
collision (now at line 229, shifted down from 213 purely by this pass's own
added lines earlier in the same file; the flagged line's own content,
`return typedJson(c, JobNodesResponseSchema, result)`, is untouched). `bun
test`: **4518 pass / 4 fail** (16656 `expect()` calls, 315 files) — the 4
fails are the pre-existing, deliberate `saved-commands-mount.test.ts`
self-detecting guard this pass was told to leave alone; up from the stated
4486/4 baseline by exactly the 7 tests this pass added, plus any concurrent
workers' own additions already in the tree. One earlier `bun test` run
during this pass showed a transient 5th failure that did not reproduce on
immediate re-run and was not among this pass's own files by mtime —
consistent with the two other concurrent workers' own in-flight edits, not
a regression this pass introduced. `bun run --cwd packages/studio test`:
**990 pass / 0 fail**, matching the stated baseline exactly — this pass
touched no file under `packages/studio/**`. `bun run --cwd packages/studio
build` (run alone): succeeds, static export, 30 routes, no dynamic segments.
`bun run spec:check`: 0 GAPs at the time of this run (the plan 94
`/recordings` GAPs this pass was told about had already been closed by a
concurrent worker by the time this check ran).

### 96.19 — Six Studio tests hand-built `ScriptListItemSchema` fixtures that predate `hasResult`, timing out on a `waitFor` that never resolves because the parse silently failed. FIXED.

**Found by:** two concurrent workers each checked "did I touch this file"
against a file-ownership list, found no, and stopped — the right check was
"what consumes what," not "who last edited it." Reassigned as an unclaimed
defect.

**Symptom.** `bun run --cwd packages/studio test` reported 1070 pass / 6
fail: four cases in `packages/studio/src/components/ScheduleEditorDialog.test.tsx`
(the reconciliation-findings and named-parameter-set blocks) and two smoke-
render cases in `packages/studio/src/app/workflows/editor/page.test.tsx`.
Every failure took ~1000–1080ms and died inside `waitFor` — the shape of an
element that never renders, not an assertion mismatch.

**Root cause.** Plan 97 step 97.2 added `hasResult: z.boolean()` (required,
no default) to `ScriptListItemSchema` (`packages/protocol/src/api/scripts.ts`)
alongside `resultSchema` on the detail-only `ScriptRowSchema`. Studio's
`api()`/`fetchAllPages()` run every response through `.safeParse()`
(`packages/studio/src/lib/api.ts`) — a required field a fixture omits fails
the parse, the promise this pass's `void fetchAllPages(...).then(...)`
callers await never resolves the state the component renders from, and
every `waitFor` in the file times out. Both failing components
(`ScheduleEditorDialog`, the workflow editor's script picker) build their
`/api/scripts*` fixtures by hand and neither one had been touched since
before plan 97 landed.

**Direction decided by reading the producer, not guessing from the plan-97
convention used elsewhere the same day.** `packages/core/src/scripts/routes.ts`'s
`GET /` handler (lines 224–262) selects `resultSchema` into every row
scanned and then, unconditionally, `rows.map(({ resultSchema, ...r }) => ({
...r, hasResult: resultSchema != null }))` — a JS-computed boolean, not a
raw DB column value forwarded verbatim. There is no code path where a row
(including one published before the `scripts.result_schema` column existed,
which just reads back `null` from SQLite) leaves this handler without the
key: `resultSchema != null` on a `null` column simply evaluates to `false`
and is still sent. This differs from plan 97 step 97.5's `JobInfo`/
`JobDetail`/`JobSummary` fields, which forward possibly-`NULL` columns
straight through and rightly went `.nullable().default(null)` — `hasResult`
is not that shape, so widening the schema instead would have hidden a real
producer/fixture mismatch behind a default that real traffic never needs.
Fixtures were the honest fix; the schema stays required.

**Fixed** — `hasResult: false` added to every hand-built `ScriptListItemSchema`-
shaped fixture object missing it:
- `packages/studio/src/components/ScheduleEditorDialog.test.tsx` — 4 fixture
  objects (2 multi-line, 2 single-line) across the reconciliation-findings
  and named-parameter-set describe blocks.
- `packages/studio/src/app/workflows/editor/page.test.tsx` — the shared
  `scriptRow` fixture used by both smoke-render cases.

**Checked, not changed.** Grepped every Studio consumer of `/api/scripts`'s
list and detail responses (`packages/studio/src/app/workflows/page.tsx`,
`scripts/detail/page.tsx`, `scripts/page.tsx`, `device/page.tsx`,
`jobs/detail/page.tsx`, `components/ScheduleEditorDialog.tsx`,
`components/layout/AppShell.tsx`, `components/workflow/ScriptPicker.tsx`,
`components/RunScriptDialog.tsx`, `components/ParamSetPicker.tsx`,
`lib/api.ts`). Only two call sites parse the ungrouped, `hasResult`-bearing
`ScriptListItemSchema` shape at all: the two files fixed above, and
`app/device/page.tsx`'s own `fetchAllPages('/api/scripts', undefined,
ScriptListItemSchema)` — which has no test coverage (`device/page.test.tsx`
mocks no `/api/scripts` path for it), so a hand-built fixture was never at
risk there, and its call already ends in `.catch(() => setScripts([]))`, so
even an unmocked/failing request in a test degrades safely rather than
throwing unhandled. Everything else (`?group=name` → `ScriptGroupRowSchema`,
`/:id` → `ScriptRowSchema` with `resultSchema` already `.nullable().optional()`)
never touches the new required field and needed no fixture change. A second,
unrelated set of edits to `app/device/page.test.tsx`, `app/jobs/detail/page.test.tsx`,
`app/scripts/detail/page.test.tsx`, `app/scripts/page.test.tsx`,
`components/RunScriptDialog.test.tsx`, `app/workflows/page.test.tsx`, and
`components/ParamSetPicker.test.tsx` was already present in the tree from a
concurrent worker's plan 91/98 work by the time this pass started — left
untouched, not this defect, not this pass's to merge around.

**Tests.** No new test file — the six pre-existing cases are the coverage;
they now exercise the real failure mode (a fixture missing a since-added
required field) the way a hand-typed body always risks, per plan 95 F8's own
"a bare `as` cast" lesson this schema was introduced to close.

**Hardware honesty.** Nothing here touches a phone — Zod parsing of mocked
HTTP bodies only.

**Verification, Studio + full workspace, 2026-08-13.** `bash
scripts/typecheck.sh`: every package OK except `core`, carrying exactly the
one pre-existing, unrelated, owner-arbitrated `packages/core/src/api/jobs.ts`
TS2739 error this pass was told about up front and told not to touch. `bun
test`: **4596 pass / 0 fail** (16849 `expect()` calls, 319 files), matching
the stated baseline. `bun run --cwd packages/studio test`: **1076 pass / 0
fail** (2601 `expect()` calls, 132 files) — the six named failures are gone;
the count sits above the stated 1070/6 baseline because of the concurrent
worker's own additions already in the tree at the time this pass ran, not
because this pass added tests. `bun run --cwd packages/studio build` (run
alone): succeeds, static export, 30 routes, no dynamic segments. `bun run
spec:check`: 0 GAPs.

### 96.20 — `enkaku publish`'s refinement warning names "the run form" even when it is warning about a `result` schema, which has no form. NOT FIXED.

**Found by:** plan 97 step 97.9 (documentation), reading `packages/sdk/src/cli/publish.ts`
to describe the `.refine()` gap accurately in `packages/sdk/README.md` rather
than inventing plausible-sounding warning text.

**What's wrong.** `warnAboutRefinements(params: unknown)`
(`packages/sdk/src/cli/publish.ts:108-114`) has one hardcoded message:

```
warning: params carries ${n} refinement${...} that the run form cannot evaluate (${paths}). Operators will see it as a job failure, not a form error. Consider an ordered range, showWhen, or a per-field bound.
```

It is called twice — once on `params` (`:202`, correct) and once on `result`
(`:222`, added by plan 97 step 97.2 for the result half of the same gate,
`checkAndReportResultSchema`'s own doc comment at `:139-144` even says "checked
at its OWN call site... the two messages below name which one failed", but
`warnAboutRefinements` itself is not one of "the two messages" that was split
— only `checkAndReportParamsSchema`/`checkAndReportResultSchema` were). So an
author who declares a refined `result` schema sees: *"warning: params carries
1 refinement that the run form cannot evaluate (matchRate)..."* — wrong on
three counts for that call: it says `params` when the field is on `result`, it
says "the run form cannot evaluate" when a result has no run form at all (the
form only ever renders `params`), and its remediation advice ("an ordered
range, showWhen, or a per-field bound") is form vocabulary that has no
result-side equivalent. The underlying behaviour is correct — the refinement
really is invisible on the published `resultSchema`, and `result_issues`
really does carry the real reason at settle (§3.8 F26) — only the printed
sentence is wrong.

**Evidence.** `packages/sdk/src/cli/publish.ts:108-114` (the one shared
message), `:202` (the correct `params` call), `:222` (the mislabeled `result`
call), `:139-144` (`checkAndReportResultSchema`'s own doc comment, which
describes exactly the split that `warnAboutRefinements` itself never got).

**Not fixed.** This step's file-ownership list is documentation only
(`packages/sdk/README.md`, `docs/design.md`, `docs/spec.md`,
`docs/spec-divergences.md`, `docs/guide/**`, `packages/protocol/README.md`,
`packages/core/README.md`, `docs/plans/97-m62-script-output-contract.md`) —
explicitly not `packages/sdk/src/**`. The fix is small (split
`warnAboutRefinements` into a `subject: 'params' | 'result'` parameter, or two
named wrappers around one shared finder) and belongs to whoever next touches
`packages/sdk/src/cli/publish.ts`. `packages/sdk/README.md`'s own new
"The `.refine()` gap" section (added by this same step) describes the warning
without quoting the mislabeled text as if it were correct, and points here.

**Tests.** None added — this is a documentation-only pass and the defect is
cosmetic (the message text), not a behavioural one; `publish.test.ts`'s
existing refinement-warning assertions (plan 97 step 97.2/97.8) already pass
because they check that a warning fires and what it names, not its exact
prose.

**Hardware honesty.** Nothing here touches a phone — a CLI console-output
string only.

This register has no implementation steps of its own to complete — the
"process" is the same four questions §3 already answers for each existing
entry:

1. Append it as `96.N`, the next unused number. Never reuse or renumber an
   existing one, even if an entry above is later found to be wrong or
   superseded — supersede it with a new entry that says so, the same way
   `docs/spec-divergences.md`'s `DIV-` rows never get edited out from under
   a decision already made.
2. Record what broke, the file:line evidence, how it was found, and whether
   it is fixed — with what the fix was, if so. "Not yet fixed" is a valid
   answer; a silently-abandoned entry is not.
3. If it turns out a plan already owns the defect, it belongs in §2's table
   instead — move it there rather than leaving a duplicate in both places.
4. If the fix itself adds a table, endpoint, protocol message, screen, or
   engine (unusual for a hotfix, but not impossible), plan 00 §7.8 still
   applies at the entry's own site: update `docs/spec.md` in the same
   change, or add a `DIV-` row explaining why not. This document's own
   `Ships:` line does not need to change when a new entry is added — it
   only has to keep pointing at one artefact that proves this register is
   not purely aspirational.

### 96.21 — A cloud-node device is never allocated a device number, because `syncDevices` creates its `devices` row directly instead of through `admitDevice`. NOT FIXED.

Found by the worker on plan 89 step 89.2 while threading `DeviceInfo.number`
through every producer, and deliberately left alone: the defect is real but
sits outside that step's scope, and papering over it there would have hidden
it behind a route that looked correct.

Plan 89 §3.1 settles that a number is allocated **at admission**, because
`admitDevice()` is the only creator of a `devices` row — finding F2 proves
`device-registry.ts`'s own insert branch is unreachable in local mode. That
proof does not hold in cloud mode. `packages/node/src/tunnel/registry.ts`'s
`syncDevices` inserts device rows itself, never calling `admitDevice`, so no
`device_numbers` reservation is ever made and the node's hand-built
`DeviceInfo` literal in `packages/node/src/index.ts` can only set
`number: null`.

The symptom an operator sees is the feature simply not existing on a cloud
node — every phone shows no number, while the same build shows numbers
correctly when run locally. There is no error and no log line, which is what
makes this worth a register entry rather than a code comment alone.

Two candidate fixes, neither chosen here:

1. Route `syncDevices` through `admitDevice`, so one creator remains and
   §3.1's reasoning stays true everywhere. Cleanest, but `syncDevices`
   reconciles a whole remote fleet in one pass and `admitDevice` is written
   for one device at a time — the transaction shape has to be reconsidered,
   not just the call.
2. Allocate lazily wherever a `devices` row appears without a reservation.
   Smaller, but it re-introduces the second creation path that F2 spent its
   evidence establishing does not exist, and the next person to read §3.1
   will be misled by it.

The choice belongs with the owner, because it decides whether cloud and local
device numbering share one seam or two. Recorded in code at both sites and in
`docs/spec.md` §12.4 so it cannot be rediscovered as a surprise.

### 96.22 — The screencap-loop fallback is chosen once, never re-tried, and never shown. FIXED by plan 100 step 100.6.

**Header corrected 2026-08-17.** This entry read `NOT FIXED` long after the work
landed — the register said a device could still be pinned to the fallback,
invisibly, when both halves had been closed. A stale `NOT FIXED` is worse than
a stale `FIXED`: it sends the next reader to re-solve a solved problem, and it
was found only because someone audited the register against the tree.

What actually closed it, both verifiable in the code:

- **The retry.** `packages/session/src/session.ts` now re-attempts `makeScrcpy`
  on a bounded schedule (10s/30s/60s, then 300s), capped by
  `FarmSettings.display.fallbackRetryCount` (default 6) and read fresh on every
  attempt. A successful retry swaps the display source in place, without
  rebuilding the session, so frame subscribers keep flowing. Scope was
  deliberately limited to *display* — not input or clipboard — and that limit
  is stated at the code.
- **The honesty.** `DeviceDetailSchema` gained `liveDisplay` (`api/devices.ts:29`),
  sourced live from the open session and free to disagree with the stored
  `display` column: a device on the fallback now reports `display: 'scrcpy'`
  (nothing rewrote the setting) alongside `liveDisplay: 'screencap-loop'`.
  `LiveView` renders a "Degraded — screencap fallback" badge from that
  disagreement, distinguishing a deliberate configuration from a real degrade.

That pass also found and fixed a real bug this entry never predicted: the H.264
renderer was built once, at `stream.started`, so a fallback that recovered
*mid-stream* would have had its `h264` frames silently discarded forever. It is
built lazily on the first `h264` frame now. Without that, the retry would have
passed its own tests and still shown nothing on the owner's screen.

Found on real hardware (moto g06 power, Android 15, mt6768) while the owner
was asking why one device streamed at 0.7 fps and another was fine.

`packages/session/src/session.ts:387` decides the display engine exactly once,
at session open: if `makeScrcpy` rejects, the session runs `screencap-loop`
for its whole life. There is no later re-attempt. A single transient failure
at boot therefore pins that device to the fallback until the core is
restarted — reloading the browser is not enough, because the browser does not
rebuild the core-side session.

Two things make this much worse than "a slower path":

1. **It is invisible.** `GET /api/devices/:id` reports `display: "scrcpy"` and
   `engines.display: "scrcpy"` — the CONFIGURED engine — while the session is
   actually serving PNG screencaps. Nothing in Studio says the device is
   degraded. The owner had to ask why it was slow. `session.ts:312`'s own
   comment warns about precisely this shape ("the UI cheerfully reported
   `streaming · H.264` — the failure was invisible because every step
   succeeded"); this is the same class in a different place.
2. **It is expensive on the phone.** `screencap -p` was measured at **87% CPU**
   on the device. The fallback does not just look bad, it consumes the device
   it is supposed to be showing.

Measured on the affected device *after* the failure: a standalone scrcpy
server started cleanly, detected the phone, and completed its handshake. So
the fallback was not describing a device that cannot run scrcpy — it was
describing one moment that failed, forever.

What a fix needs: report the ENGINE THAT IS ACTUALLY RUNNING (not the
configured one) so the operator can see the degrade, and re-attempt scrcpy
rather than pinning the session. The trigger for the original failure is
recorded in §96.24 and is not yet understood.

### 96.23 — `close()` kills the local adb client, leaving the scrcpy server alive on the phone. FIXED.

`packages/scrcpy/src/session.ts:261`'s `close()` calls `serverChild?.kill()`,
which terminates the `adb` process on the host. It does not terminate
`app_process` on the device. Normally scrcpy's server exits when its sockets
close, so this is usually invisible — but when the core abandons a session
whose sockets it never successfully read, the remote server survives.

Observed directly: a core-spawned server (`log_level=info`, the core's own
argument set) running **7 minutes 42 seconds** after the core had given up on
it, with its `com.genymobile.scrcpy.CleanUp` companion process alive too. The
`CleanUp` process is only created once the server has accepted a connection,
so this orphan was not idle — it was encoding video into a socket nobody was
reading, on a device that was simultaneously burning 87% CPU on the
screencap fallback (§96.22).

They accumulate: every failed session leaves another. Nothing in the codebase
sweeps them, and `pkill -f com.genymobile.scrcpy` was needed by hand.

A fix should kill the device-side server for the session's own `scid` on
close, and sweep strays before starting a new session. Note the orphan is a
SIBLING of §96.22, not its cause — the 0.7 fps was the screencap fallback,
and an early diagnosis blaming the orphan for it was wrong.

**Fixed 2026-08-14, as plan 100's own step 100.1** (`docs/plans/100-m65-realtime-wall-and-session-parity.md`
§3.5, §5 step 100.1) — promoted from an independent hotfix to plan 100's hard
prerequisite, because that plan's own primary mechanism (a SECOND concurrent
scrcpy session per device) doubles the exposure of this exact leak if it
ships first. `packages/scrcpy/src/session.ts`'s `close()` now calls a new,
module-private `stopDeviceSide(adb, scid)` right after `serverChild?.kill()`
and before the `forward --remove`: a best-effort `pkill -f 'scid=<scid>'`,
`.catch()`-swallowed exactly like `packages/core/src/device/transfer.ts`'s
`install()` `finally` block documents for a staged APK it could not delete —
never allowed to fail or meaningfully delay `close()` itself. The command is
not a guess: it is the literal one plan 100's own G12 hardware probe used by
hand to kill one of three concurrent servers on the owner's phone (moto g06
power), confirmed to leave the other two running undisturbed — the "target
this session's own process, never every scrcpy process on the device"
property a two-session design depends on. `scid` is this codebase's own
random 8 hex-digit token, never user input, so no shell-quoting concern
beyond the surrounding single quotes.

A startup sweep closes the "every failed session leaves another"
accumulation directly: `parseScrcpyServerList(psOutput)` (new, exported)
reads `ps -A -o pid,args` and pulls every `{pid, scid}` pair whose command
line carries a `scid=<hex>` token — deliberately not filtered by process
name, since `ps` truncates/renames comm strings inconsistently across
Android OEMs/API levels, while the `scid=` token is this codebase's own value
and the one thing every process it spawned is guaranteed to carry.
`sweepStrayScrcpyServers(exec, knownScids)` (new, exported) kills every
process whose scid is NOT in the caller's known set with one batched
`kill -9`, and never touches a recognised one. `packages/core/src/daemon.ts`
calls it once per currently-attached device, via `adbClient.listDevices()`,
right before `sessions = createSessionManager({...})` is built, with an
EMPTY known-scid set — nothing in a fresh process has opened a session yet,
so every scrcpy process `ps` still finds at boot is, by construction, an
orphan from a prior crash or an ungraceful shutdown. One device's sweep
failing is caught and logged, never allowed to abort boot.

A mid-run sweep before starting a NEW session (as opposed to the boot-time
sweep) was considered and deliberately left for plan 100's own step 100.4:
`sweepStrayScrcpyServers`'s signature already supports it (a `knownScids` set
drawn from the manager's live open entries), but wiring it into the
per-acquire path is `SessionManager`-shaped work that belongs beside that
step's `entryKey`/two-slot changes, not this cleanup-only step — the boot
sweep alone already closes this entry's own "nothing sweeps them" complaint.

No hardware is available in this pass (two physical phones were in active
use by the owner throughout); every assertion is against a fake/mock adb
executor recording the exact shell command sent, per this entry's own
already-written test-plan wording. `packages/scrcpy/src/session.test.ts`
(new) drives a REAL `startScrcpySession()` end to end against a fake local
TCP server standing in for the device (genuine `openForward`/
`connectVideoSocket`/`connectWithRetry` handshake, no real `adb`), asserting
the exact `pkill -f 'scid=<scid>'` command `close()` sends and that a
throwing `exec` still lets `close()` resolve rather than reject; separate
cases pin `parseScrcpyServerList`/`sweepStrayScrcpyServers` directly.
`packages/core/src/daemon-wiring.test.ts` gained a case proving the real
`daemon.ts` wiring itself (the sweep call precedes `sessions =
createSessionManager(...)`, is scoped through `adbClient.exec(tracked.serial,
...)`, passes an empty known-scid set, filters non-`'device'`-state serials,
and is wrapped in a per-device `try`/`catch`) — the same "read the real file"
style this file already uses for the identical defect class (§96.5/§96.6).
Real-hardware confirmation is deferred to the owner: see plan 100 §7's H-5
row (`adb shell ps | grep scrcpy` before/after a forced-failure `close()`)
and H-2 (the shipped two-session code path, once 100.4/100.5 land).

Verified 2026-08-14: `bash scripts/typecheck.sh` — every package OK except
`core`'s pre-existing, owner-arbitrated `api/jobs.ts(229,49)` TS2739
(unrelated to this fix, left untouched); `bun test` — 4780 pass / 0 fail
workspace-wide, including this fix's 11 new `scrcpy/session.test.ts` cases
and 1 new `daemon-wiring.test.ts` case; `bun run --cwd packages/studio test`
— 1159 pass / 4 fail, the same 4 pre-existing `SettingsPage`/`FarmVideoFields`
failures from plan 100 step 100.2's concurrent, unrelated work.

### 96.24 — A quality upgrade re-runs the entire wake path on a device that is already awake. PARTIALLY FIXED.

Opening a wall tile into Control restarts the session, because scrcpy's
`max_size`/`video_bit_rate`/`max_fps` are LAUNCH arguments — they cannot be
changed on a running server. That restart is unavoidable. Re-running the wake
path is not.

`upgradeToControl` → `restartAt` → `createEntry` → the full `openSession`,
including `wakeDevice`, `applyRotation`, `applyTextInput` and `applyFarmTag`
— on a device that was streaming video a moment earlier, so it is
demonstrably awake, already rotated, and already tagged.

Measured per-command on the affected phone:

| command | cost |
|---|---|
| `input keyevent KEYCODE_WAKEUP` | 125 ms |
| **`svc power stayon true`** | **1422 ms** |
| `dumpsys window \| grep -m1 isKeyguardShowing` | 98 ms |
| `settings get system user_rotation` | 102 ms |
| `settings get secure default_input_method` | 90 ms |

`svc` costs ten times everything else combined, because it starts a whole
`app_process` JVM to reach the power service. It is the single largest item
in the ~4.3 s `stream.start` the owner's log recorded, and a quality upgrade
pays all of it a second time for no benefit.

**Fixed here:** the upgrade now passes a `detail` to `restartAt`, so the
second "Waking the device" explains itself. `reprofile` (the settings path)
has passed one since plan 92 §3.8 rule 5; `upgradeToControl` — the call site
an operator crosses every time they click a wall tile open — did not, so F17
was closed for the rare path and left open for the common one. This is the
same "built, tested, threaded, and never passed at the one real call site"
class this register keeps recording.

**Not fixed:** the redundant work itself. A restart of an already-open session
should skip the wake path, or at minimum skip `svc power stayon` when the
device already holds it. The care needed is deciding what happens if the
device genuinely slept between the two sessions — which is why this is
recorded rather than guessed at.

### 96.25 — Guest-agent provisioning spends its three attempts on a CORE-side error, pins `failed` in a persisted column, and never re-evaluates it — including after later proof the agent is alive. FIXED.

Found on the owner's own farm. They asked what the red **"Agent failed"** badge on
a device card meant; it turned out to be reporting a state that had been wrong
for half an hour.

#### What was observed

`GET /api/devices/<id>/guest-agent`, live, on a working device:

```json
{"state":"failed","appVersion":"1.0","androidSdkInt":35,"capabilities":[],
 "reason":"adb is not ready yet","versionCode":null,
 "checkedAt":1786679458,"attempts":3,"nextAttemptAt":null}
```

`checkedAt` was **1614 seconds (27 minutes) old** at the time of reading, and
`nextAttemptAt: null` means nothing will ever look again. Both attached
devices reported `"agent":"failed"` in `GET /api/devices`.

The reason string is not a device fault. `"adb is not ready yet"` is
`E_ADB_UNAVAILABLE`, raised by **this codebase about itself** at
`packages/core/src/daemon.ts:471` and `:1663` when the `adb` handle is still
null. The owner's boot log shows the race directly:

```
02:33:24.218  core: enkaku core v0.1.7 listen http://127.0.0.1:7700
02:33:27.891  core: adb server ok (version 0029)
02:33:27.927  core: adb subsystem ready (devices registered: 1)
```

Three and a half seconds separate the core accepting work from adb being
usable. `DEFAULT_RETRY_BACKOFF_S = [5, 20, 60]`
(`packages/core/src/device/agent-provisioner.ts:55`) gives three attempts
across roughly 85 seconds — comfortably inside the window in which a slow adb
provision, a toolchain download, or a cold `adb server` start can still be
running.

#### Why the state then sticks forever

`:315` — `nextAttemptAt = attempts < retryBackoffS.length ? checkedAt + backoff : null`.
On the third failure `nextAttemptAt` becomes `null`.

`:289-292` — with `prior.state === 'failed'` and `prior.attempts >= 3`, the
provisioner returns `prior` unchanged and logs *"has exhausted its 3 automatic
attempts — waiting for an explicit retry"*.

`packages/core/src/db/schema.ts:76` — `agent` is a **persisted JSON column** on
`devices`. So `attempts: 3` is read back as `prior.attempts` on the next boot
too: the give-up is not merely for the life of the process, it survives
restarts. A farm can carry a red badge indefinitely from one unlucky startup.

The bounded retry itself is deliberate and its reasoning at `:283-287` is
sound — twenty phones with a bad APK path must not produce an install storm.
The defect is not the bound. It is that the bound does not distinguish
**"this device cannot run the agent"** from **"we asked before we were
ready."**

#### The state is provably wrong, not merely stale

Seconds after the third failure, the same log shows the core talking to that
very agent:

```
02:33:44.687  core.guest-agent: network reconcile: device ... reports up=false via proxy.soax.com:1337
02:33:47.876  core.guest-agent: network restore: device ... recovered on attempt 1
```

The route was applied **through the guest agent**. So evidence that the agent
was alive arrived, was acted on successfully, and did not disturb the `failed`
record — because the session/route path resolves its own capabilities and
never writes back to the provisioner's column. That separation is also why the
device kept working while its badge said otherwise.

#### What this entry does NOT claim

An earlier reading of this asserted that `capabilities: []` disables
`vpn-helper`, UHID and the `agent-ime` text rung. **That was wrong and is
recorded here so it is not repeated.** The live consumers read
`session.textInput.agentCapabilities` and the guest-agent route entries, not
`devices.agent.capabilities`, and `packages/core/src/api/guest-agent.ts:409`
treats `null` as *unknown* while `[]` means *known and empty* — two different
things. What is established is that the **reported** state is wrong; what is
not established is the full set of surfaces that read it. That inventory is
the first task of any fix.

#### Three fixes, in the order they matter

1. **Do not start provisioning before the adb subsystem is ready.** This is a
   boot-ordering problem. Fixing the retry without fixing the ordering hides
   the race instead of removing it.
2. **A core-side error must not consume a device's attempt budget.**
   `E_ADB_UNAVAILABLE` says something about us, not about the phone. It should
   defer, not count. This is the smallest change with the largest effect, and
   it is worth distinguishing the two error classes explicitly in the code
   rather than special-casing one string.
3. **A successful interaction with the agent should clear a stale `failed`.**
   Once `network restore` has spoken to the agent, `failed` is disproven; a
   status nobody re-examines in the face of contrary evidence is the same
   defect as §96.22.

#### Same disease as §96.22

§96.22 pins a session to the screencap-loop fallback at open and never
re-tries, while the REST snapshot keeps reporting the configured engine. This
entry pins a guest agent to `failed` and keeps reporting it while the agent
demonstrably works. **A status written once, never reviewed, and unmoved by
later contrary evidence** is now a recognised pattern in this codebase rather
than an isolated bug, and a fix for either should be written with the other in
view.

#### Fixed 2026-08-14, in the order given above

1. **Boot ordering.** The provisioner's boot-time `ensureAll()` sweep used to
   fire the moment `agentProvisioner` was constructed (`daemon.ts`, right
   after `agentProvisionerRef = agentProvisioner`) — well before `adb = new
   AdbClient(...)` is ever assigned later in the same function, which is
   exactly the race this entry's own boot log demonstrated. The call is now
   made right after `adbState = 'ready'` and `"adb subsystem ready"` are
   logged, once `adb` is genuinely non-null and the device registry has
   finished its initial admission pass.
2. **A core-side error no longer spends a device's attempt budget.**
   `agent-provisioner.ts`'s `runOnePass` now rethrows an `EnkakuError` coded
   `E_ADB_UNAVAILABLE` (from both the `ensureInstalled()` and `hello()` call
   sites) instead of folding it into the ordinary `state: 'failed'` path;
   `ensureImpl` catches that rethrow specifically and returns `prior`
   completely unchanged — no write, no attempt consumed, no transition
   event. A genuine device-side failure is untouched by this and still
   counts exactly as before.
3. **A successful interaction with the agent clears a stale `failed`.**
   `guest-agent.ts` gained `clearStaleAgentFailure(deviceId)`, called from
   both places `maybeRecoverRoute` logs a recovery (the "already carries its
   route" fast path and the "recovered on attempt N" path) — proof the
   route is live through the guest agent. It reads the provisioner's cached
   status first and only forces a real `ensure(deviceId, { force: true })`
   when that status is actually `failed`, so an ordinary recovery tick on a
   healthy device costs nothing extra.

None of these fixes touch `devices.agent.capabilities` semantics — the
"`capabilities: []` does not mean disabled" correction two sections above
still stands; live consumers still read `session.textInput.agentCapabilities`
and the guest-agent route entries, never the persisted column, and that is
unchanged here.

Verified: `bash scripts/typecheck.sh` (pre-existing, unrelated failure in
`packages/core/src/api/jobs.ts` only — not touched by this fix), `bun test`
(4781 pass / 0 fail), `bun run --cwd packages/studio test` (1163 pass / 0
fail).

### 96.26 — The `scid` namespace marker (`0xec`, from §96.23's own hardening) broke scrcpy on every real device. FIXED.

Found on the owner's hardware minutes after it shipped: `bun dev`'s log showed
every scrcpy start failing with `java.lang.NumberFormatException: For input
string: "ec8c10dc"` (and five more, all with an `ec` top byte), every session
on both attached phones falling back to `screencap-loop`.

`packages/scrcpy/src/session.ts`'s `SCID_MARKER_BYTE` was set to `0xec` to
namespace this codebase's `scid` values, so `sweepStrayScrcpyServers`'s
boot-time pass (which runs with an empty `knownScids`) can tell an orphan of
its own prior session apart from any other process merely carrying a
`scid=<hex>` token — the fix that closed the "kill anything unrecognised,
ours or not" hazard recorded in this register's own earlier note on §96.23.

The reasoning behind namespacing was correct; the byte value chosen was not.
scrcpy's server parses `scid` with Java's **signed** `Integer.parseInt(scid,
16)`, not `parseUnsignedInt`. Any top byte with its high bit set
(`>= 0x80`) pushes every `scid` this process mints past `Integer.MAX_VALUE`
(`0x7fffffff`) — `0xec8c10dc` is 3,969,539,292, roughly 1.8 billion over the
signed 32-bit ceiling. The server throws before it starts, every time,
because the marker is a fixed prefix: this was not a rare edge case, it was
**100% of sessions**, on both of the owner's phones simultaneously, the
moment the change landed.

Fixed: `SCID_MARKER_BYTE` changed from `0xec` to `0x7f` (packages/scrcpy/src/session.ts),
the highest byte value that stays inside the signed range regardless of the
other 6 hex digits. A new test asserts this arithmetically —
`Number.parseInt(`${SCID_MARKER_PREFIX}ffffff`, 16) <= 0x7fffffff` — so the
same mistake cannot ship silently again.

**Why the existing test suite did not catch this, and why that is not a
process failure to "fix" by adding more mocks:** every scid-related test in
`packages/scrcpy/src/session.test.ts` drives a fake `ps` output and a fake
`AdbExecutor` — by design, since no hardware is available in CI. None of them
run real Java, so none of them could observe `Integer.parseInt` rejecting an
out-of-range value. The failure is only observable against a real device,
which is exactly where the owner found it. The regression test added here
checks the marker's arithmetic property instead (fits in signed 31 bits for
any suffix), which is the cheapest thing that generalizes: it protects
against every future marker choice, not just `0xec` specifically.

### 96.27 — Studio refused to enqueue a job for an offline device, though the core would have queued and run it. FIXED (single-device path).

The owner asked whether running a script could stay queued until the device
comes back up. The answer was that the core had always done exactly that —
Studio was the only thing preventing it.

**What the core actually does**, and both halves matter:

- `createJobStore.enqueue` (`packages/core/src/queue/job-store.ts`) rejects
  exactly ONE status: `quarantined` (`device_unavailable`). `offline` is not
  checked at all.
- `claimNext`'s single SQL predicate carries `AND d.status = 'idle'`, so a
  queued job simply waits until its device reaches `idle` — which an offline
  phone does by itself on reconnect, through the ordinary registry path.
- Nothing expires it while it waits: the enqueue path sets no default
  `expiresAt`, and there is no farm setting that supplies one, so
  `expireQueued`'s reaper never touches such a job.

**What Studio did — in THREE separate places, which is the part worth
recording.** The same wrong premise was written out independently in each:

1. `DevicePicker.tsx`'s `cannotTakeJob` returned true for `offline` as well as
   `quarantined`, disabling the row. Its own comment stated the premise
   plainly — *"Only these two truly cannot accept a new job — a busy or
   manual device still queues one"* — and it was half wrong: an offline
   device queues one too, on exactly the same mechanism as `busy` and
   `manual`, which the same comment already recognised.
2. `RunScriptDialog.tsx`'s `usable` filtered `offline` out of both the default
   preselection and the fleet-wide-confirmation denominator.
3. `device/DeviceHeader.tsx`'s **Run a script** button hard-disabled on
   `status === 'offline' || status === 'quarantined'` — the entry point an
   operator is most likely to use, since it sits on the offline device's own
   page. Unlike the `Take control` button directly beneath it, this branch
   carried no tooltip at all: the button simply went grey with no reason
   given.

The first two were fixed, verified green, and reported as complete — and the
third was still there, found only when the owner pressed the actual button.
This is the register's most-recorded shape (see §96.10, §96.15, §96.16): the
reported instance gets fixed and a sibling call site keeps the old behaviour.
A sweep of every remaining `'offline'` comparison in `packages/studio/src`
was done after the third fix rather than before, and confirmed the rest are
correct: streaming and control surfaces (`WallTile`, `DeviceCard`,
`DeviceTile`, `useLiveSet`, `ReadinessControl`) genuinely cannot work
offline, the adb console (`command/target-preview.ts`) runs commands
immediately rather than queueing them, and `schedules/detail`'s target
preview deliberately matches the batch path left unchanged below.

**Fixed:**
- `cannotTakeJob` now returns true only for `quarantined`, the one status the
  core genuinely rejects.
- An offline row carries **"Queues until this device reconnects"** beside the
  status word. Without it the badge reads as "this will not run", and the
  operator would have to know `claimNext`'s predicate to trust the choice
  being offered.
- `RunScriptDialog` splits one set into two, because they answered two
  different questions that had been conflated: `usable` (can be GIVEN a job —
  everything but `quarantined`, the honest denominator for "this targets every
  usable device on the farm") and `readyNow` (could start IMMEDIATELY — used
  only to choose the dialog's default, since opening on a phone that cannot
  start for hours is a worse default than one that starts at once).
- A device the operator arrived from explicitly is still honoured even when
  offline; silently swapping their choice would be the surprise. The fallback
  prefers `readyNow`, dropping to `usable` so an all-asleep farm still opens
  on a real pick rather than a blank.
- `DeviceHeader`'s button now blocks only `quarantined`, and says why through
  the same tooltip shape `Take control` already uses — an improvement on the
  silent grey it replaced.
- Three tests in `DevicePicker.test.tsx` and three in `DeviceHeader.test.tsx`.
  Note that only the `quarantined` picker case needs a `TooltipProvider`
  wrapper — that the offline cases do not is itself the assertion, since the
  tooltip only wraps the refused path. `canRunScript: false` (a farm with no
  scripts at all) is asserted to still disable the header button, so the fix
  cannot be read as "always enabled".

**Deliberately NOT changed: the cluster/batch path.**
`packages/core/src/clusters/resolve.ts:19-23`'s `unavailableReason` still
skips `offline`, so a batch across a cluster reports those phones under
`skipped` rather than queueing them. That is not an oversight left unmentioned
— it is a different contract with real dependents: plan 20 §3.1's "3 of 5
devices were offline" reporting, the persisted `batches.skipped` column, and
plan 93 §3.12 step 93.8's `POST /:id/rerun?only=skipped`, which retargets
exactly the devices that column names. Making offline members queue would
change what a batch IS at dispatch time, and what `skipped` means afterwards.
That is a design decision for the owner, not a bug fix, and it is recorded
here so the asymmetry between the single-device and batch paths is visible
rather than discovered later.

### 96.28 — `bun run dev:studio` always redirected to `/login`, in local mode, where no credentials exist. FIXED.

The owner ran `bun dev` plus `bun dev:studio`, opened `:3001`, and was sent to
`/login?next=%2F` with nothing to log in with. In local mode there is nothing
to log in with — that is correct, and the redirect was the bug.

**The chain, and every link was individually reasonable:**

1. Studio fetches with `credentials: 'include'`
   (`packages/studio/src/lib/auth.ts:47`, `:62`, `:91`, `lib/ws.ts:375`). It
   must: server mode carries the session in a cookie.
2. The core's local-mode CORS grant (`packages/core/src/server/http.ts`)
   deliberately did **not** set `credentials: true`. Its comment gave the
   reason — "a cross-origin page cannot ride the session cookie this way" —
   and `http.test.ts` pinned the absence with a test whose name asserted "the
   impact stays bounded even in local mode".
3. The CORS spec makes a `credentials: 'include'` request whose response lacks
   `Access-Control-Allow-Credentials: true` fail **in the browser**. The core
   answered 200; the tab saw a rejected promise.
4. `AuthGate` (`packages/studio/src/components/layout/AuthGate.tsx:56-62`)
   catches an unreachable core and sets `status: 'unauthenticated'` on
   purpose, so a dead core does not strand the tab on a spinner. It cannot
   distinguish "blocked by CORS" from "no session".
5. So the operator was redirected to a login screen that, in local mode, has
   no credentials to accept. The symptom pointed at auth; the cause was CORS.

Verified against the running core before changing anything:
`curl -H 'Origin: http://127.0.0.1:3001' .../api/auth/me` returned
`Access-Control-Allow-Origin: http://127.0.0.1:3001` and no
`Access-Control-Allow-Credentials` — while the same endpoint served
`{"user":{"id":"local-admin",...},"authMode":"local"}` to a plain `curl`.

**Fixed** by setting `credentials: true` on that one `cors()` call, which sits
inside `if (deps.authMode === 'local')` and therefore cannot affect server
mode at all.

**Why this grants nothing**, which is the part worth being precise about,
since it overrides a deliberate earlier decision: `authMiddleware`'s
`mode === 'local'` branch (`packages/core/src/auth/middleware.ts:26-29`) sets
an implicit admin and returns **before it reads any cookie**. There is no
session cookie in local mode for a cross-origin page to ride. Any loopback
origin this block admits already has full admin access without sending one —
so the flag adds no capability. The bounds that do the real work are
unchanged and still tested: server mode grants no CORS to a loopback origin,
and local mode still refuses a non-loopback origin.

The old test was replaced rather than deleted, with its own reasoning
recorded in the new one's doc comment, plus a second assertion proving the
cookieless request is already admin — so the claim "this grants nothing" is
asserted in the suite rather than argued in a comment.

### 96.29 — Three shipped top-level screens had no sidebar entry; two of their list pages were unreachable by any route. FIXED.

The owner asked why Workflows was missing from the sidebar. It was not the
only one.

Comparing every `page.tsx` under `packages/studio/src/app` against `AppShell`'s
`NAV` array found three top-level routes built, tested and shipped with no nav
entry: **`/workflows`** (plan 99 §5 step 99.9), **`/recordings`** (plan 94 §5
step 94.5) and **`/topology`**.

Missing from the nav understates it, because for two of them the only route in
was a deep link that appears *after* you have already done something else:

- `/workflows` — reachable only through `RunScriptDialog`'s "Open the workflow
  editor" link, which goes to `/workflows/editor`. A workflow could be created
  and edited; the LIST could not be opened at all, so nothing made yesterday
  could be found again.
- `/recordings` — reachable only through `RecordPanel`'s
  `/recordings/detail?slug=…` link, shown right after a capture. You could
  review the recording you had just made and never find an older one.
- ~~`/topology` — no nav entry **and no link from anywhere in Studio**. Only a
  typed URL reached it.~~ **WRONG, corrected 2026-08-16.** `/topology` is not
  a page. It is a 22-line `router.replace('/?view=wall&group=cluster')` — a
  compatibility redirect kept so an old bookmark still resolves (plan 47
  §3.6). Its former content is now a *view of the device grid*, and that view
  already has a front door: the grid's own `GroupBy` control
  (`app/page.tsx`'s `'none' | 'cluster' | 'status' | 'tag'`).
  `components/topology/DeviceTile.tsx` and `ClusterSection.tsx` are dead code
  left behind by the same move, referenced now only in other files' comments.

  So the nav entry this entry added was wrong twice: it pointed at a
  redirect, and it created a second front door onto a screen the operator is
  usually already looking at — the exact thing plan 101 §2 declined to build
  for the reference design's separate Dashboard. **The same reasoning was
  applied to the Dashboard and violated here, in the same session.** The
  entry has been removed and `/topology` added to `AppShell.test.tsx`'s
  `NOT_IN_NAV_BY_DESIGN` set with the reasoning inline, so the guard stops
  treating a redirect as a page needing a door.

  Found by the agent implementing plan 101 step 101.5 and reported as an
  incidental out-of-scope observation rather than acted on — which is why it
  surfaced at all. **Workflows and Recordings are unaffected**: both are real
  pages with real content, and their list views genuinely had no route in.

Every other page without a nav entry is legitimately excluded: detail pages
(`/jobs/detail`, `/batches/detail`, `/scripts/detail`, `/schedules/detail`,
`/recordings/detail`, `/workflows/editor`, `/agents/*`) are reached from their
lists, `/device` from the device list and the wall, `/login` and `/setup` are
auth routes, `/dev/tools` is development-only.

**Fixed:** all three added to `NAV`, each placed for a reason rather than
appended — Workflows directly after Scripts, because the owner's own ruling is
that a workflow sits at the SAME level as a script (which is why
`RunScriptDialog` offers a Workflow | Script choice instead of nesting one
inside the other); Recordings beside them, because publishing a recording is
how a script gets made here; Topology next to Clusters, being the same data
seen spatially.

**The guard matters more than the three entries.** `AppShell.test.tsx` now
reads the router's own directory listing and `AppShell.tsx`'s own `href:`
literals, and asserts no top-level route is missing from the nav, with an
explicit allow-list for the by-design exclusions above. A future page shipped
without a front door fails this test instead of waiting to be noticed by an
operator. It was verified to actually detect the condition — temporarily
breaking one `href` made it fail — rather than being assumed to work because
it passed once, which is how the three orphans survived their own plans'
green test runs in the first place.

### 96.30 — A batch with zero jobs could never leave `stopping` — the owner's own operation tray, stuck forever. FIXED.

The owner's report: the tray showed one entry, permanently — `chrome-open-url`,
`no device · stopping · 16s`, a full-width progress bar reading `(0/0)`, the
duration ticking every second with nothing ever changing. Their own words:
*"harusnya kan ga muncul kaya gini, minimal yang lagi progress gitu yang
muncul, ini kan ga progress, atau pas sukses/fail tapi beberapa detik
setelahnya otomatis hilang"* — only what is actually progressing should show;
a success/failure may appear, but should auto-dismiss a few seconds later.

**The core bug.** `clusters/status.ts`'s `computeBatchStatus` reads
`if (counts.total === 0) return 'queued'` — a fallback meant for a batch
before it has any jobs. `api/batches.ts`'s `statusOf` then holds `row.status`
at `'stopping'` for as long as the computed status is not terminal, and
`'queued'` never is, so a zero-job `stopping` batch was held there forever.

**The ambiguity, resolved rather than guessed at.** `counts.total === 0`
looks like it could mean either "created, not dispatched yet" or "dispatched,
matched no device" — but investigation found `clusters/dispatch.ts`'s
`createBatch` is the ONLY writer of a `batches` row, and it always inserts
that row together with at least one job row, in the SAME transaction
(`E_NO_TARGETS` refuses before anything is persisted when no device
matches). So the first reading is impossible for any row that actually
exists in the database — a batch is never persisted "before" its jobs. The
ONLY way an existing row reads `counts.total === 0` is that every one of its
job rows was deleted AFTER creation. The one path found: `device/
lifecycle.ts`'s `forget({ deleteHistory: true })` deletes `jobs` rows by
`deviceId` but never touches `batches` — forgetting a batch's only device
(with history) leaves an orphaned batch row behind, whatever status it was
in. This is reachable in production, not just in theory: `stopBatch`
(`api/batches.ts`) calls `recomputeBatchStatus` unconditionally as its own
last step, including when the batch's only device was already forgotten
before the operator hit Stop — before this fix, that call was a silent
no-op (the function's own pre-existing `if (rows.length === 0) return null`),
leaving the row `stopping` forever. That is almost certainly how the owner's
own farm reached this state.

**Fixed, on both the write side and the read side — a fix that only landed
on one leaves the other still broken:**

- `clusters/status.ts`'s `recomputeBatchStatus` (write time): a batch with
  zero job rows now resolves straight to `cancelled` — terminal, `finishedAt`
  set, broadcast — unless it is ALREADY terminal (never re-broadcasts or
  disturbs `finishedAt` for a batch that finished normally long before its
  history was deleted).
- `api/batches.ts`'s `statusOf` (read time): `counts.total === 0` is handled
  FIRST, before the `stopping` hold ever applies, resolving to `cancelled`
  for the identical reason. **This is what actually heals the owner's
  farm**: `statusOf` runs on every `GET /api/batches` and `GET /api/batches/
  :id`, so the already-stuck row in `.dev-data/` reads `cancelled` on the
  very next request — no migration, no backfill script, no DB write at all
  from this function.

**Studio (`packages/studio/src/lib/operations.ts`, `components/bulk/
OutcomeSummary.tsx`) — the tray's own visibility rule was wrong at both
ends, fixed separately from the core bug so hiding it in one UI would never
have left it live everywhere else:**

- **Auto-dismiss, built for the first time.** `buildOperations` no longer
  drops every terminal operation instantly — a batch/job/command-run/
  transfer that just reached a terminal state (`success`/`ok`/`state: 'done'`
  and true, vs. anything else) is shown for `SUCCESS_GRACE_MS` (5s) or
  `SETTLED_GRACE_MS` (15s, three times longer — a failure needs more time to
  actually be read than a success needs to be noticed), then filtered out.
  No new timer: `withinGrace` recomputes from `finishedAt` and `nowMs` every
  time `buildOperations` runs (the store's own bounded poll and WS-triggered
  refresh), so there is nothing per-entry to leak or forget to clear on
  unmount.
- **`queued` batches no longer appear at all** (`batchBelongsInTray`) — the
  owner's own "minimal yang lagi progress" taken as the default. Scoped to
  batches, not standalone jobs (plan 107 step 107.4's own deliberate choice,
  still pinned by its own test) — a queued batch is the one shape proven
  above to be able to get stuck non-terminal forever; a standalone job's
  whole row is deleted by `forget`, never orphaned, so it carries no
  equivalent risk.
- **A batch operation with zero device ids never renders**, whatever its
  status — belt-and-suspenders for the exact defect above, and the direct
  fix for the screenshot's `"no device"` label.
- **`OutcomeSummary` renders no `<Progress>` at all when `counts.total ===
  0`** — `value={0}` already rendered its indicator fully hidden, but the
  track underneath (`bg-primary/20`, a full-width, always-visible pill) still
  read as a bar with something to show. Zero total now renders no bar,
  matching the screenshot's own complaint.
- **The other operation kinds were checked for the same "immortal
  non-terminal" shape and found clean**: transfers already carry a bounded
  30s server-side retention sweep (`transfer-registry.ts`); standalone jobs
  are deleted WHOLE by `forget`, never left as an orphaned parent; command
  runs have no deletion path that removes a member out from under a still-
  live run. Batches are the one kind with both a parent/child split AND a
  deletion path that touches only the child.

**Proven, not just described**: `clusters/status.test.ts` (4 new tests) —
a `stopping`/zero-jobs batch reaches `cancelled` (the owner's own state,
reproduced directly); a stale `running`/zero-jobs batch does too (the bug is
not `stopping`-specific); an already-terminal/zero-jobs batch is left alone;
an unknown batch id is unaffected. `api/batches.test.ts` (3 new tests) —
`GET /:id` and `GET /` both heal an already-stuck `stopping` row with no DB
write; `POST /:id/stop` on a batch whose only device was already forgotten
reaches `cancelled` rather than getting stuck, through the real HTTP route
with a real job store. `packages/studio/src/lib/operations.test.ts` (9 new
tests) and `components/operations/OperationTray.test.tsx` (3 new tests) —
the exact stuck shape renders nothing; the grace window for each terminal
kind, both within and past it; a `queued` batch with real jobs still never
appears; a still-progressing operation is immune to an arbitrarily large
clock. `components/bulk/OutcomeSummary.test.tsx` (new file, 2 tests) — zero
total renders no `[role="progressbar"]`; a real total still does.

`bash scripts/typecheck.sh`, `bun test` (5205 tests), and
`bun run --cwd packages/studio test` (1590 tests) all green. `bun run
build:studio` was refused by its own dev-server guard (`:3001` was live at
verification time) — the guard's own job, not a defect; not run.

Recorded as `docs/plans/107-m72-long-running-operations.md` §5 step 107.7,
where the tray's own behaviour is owned.

### 96.31 — Settings was unsavable: every non-integer numeric field failed the browser's own native validation on its OWN stored value. FIXED.

The owner opened `http://127.0.0.1:3001/settings`, changed nothing, clicked
Save, and the browser refused with focus jumping to the Gesture curvature
input: *"Please enter a valid value. The nearest valid value is 0."* That is
the browser's **native** `type="number"` validation, not a server rejection —
the form was refusing the value it had just loaded.

**What broke.** `packages/studio/src/components/schema-form/plan.ts`'s row 9
(`numberBounds`) derived the planned `step` **only** from JSON Schema's own
`multipleOf`: `step: numOrUndefined((node as Record<string,
unknown>).multipleOf)`. Zod only emits `multipleOf` for an explicit
`.multipleOf()` call — never for a plain `.number()` — so every field without
one planned `step: undefined`. `NumberField` (`controls/NumberField.tsx`) then
omitted the HTML `step` attribute entirely when it was `undefined`. HTML's own
default for an `<input type="number">` with no `step` attribute is
`step="1"`, so with `min="0"` the only values that pass native validation are
0, 1, 2, … — and `gestureCurvature`
(`packages/protocol/src/settings.ts:91-97`, `min(0).max(0.5).default(0.08)`,
deliberately left with no `.multipleOf()` per that field's own inline
comment) had its own stored `0.08` rejected the instant Save was clicked, with
no edit required to trigger it.

**The blast radius, confirmed wider than the one field the owner hit:**

- `gestureCurvature` — the field that blocked Save, confirmed as the exact
  reported symptom.
- `lat`/`lng` (`settings.ts:198-199`, `DeviceGpsSchema`) — decimal degrees.
  Every real-world coordinate is fractional, so before this fix these fields
  could never hold a real GPS fix at all, not just an edited one.
- `accuracy` (`settings.ts:200-206`, same schema) — `positive().max(10_000)`,
  no `.int()`, no `.multipleOf()`. Found during this pass's own sweep, not
  named in the original report: its `default(100)` happens to be a whole
  number, which is why nobody had hit this one yet, but `55.5` metres would
  have failed the identical way.
- `tempThresholdC`, `maxTotalGb` (`settings.ts:950,968`) — checked and
  confirmed NOT broken today only because both defaults happen to be whole
  numbers (`45`, `20`); neither carries `.int()`, so a user typing `45.5`
  would already have hit this bug before today's fix, and after it both
  correctly plan `step: 'any'`.
- **Every script author's own float parameter, farm-wide.** Script parameter
  forms (`RunScriptDialog`, `ScheduleEditorDialog`) are planned through this
  exact same `plan.ts` (plan 95's whole point: one resolver, four call
  sites — settings, farm settings, and both script-parameter dialogs). Any
  published script declaring `z.number().min(0).max(1)` for anything other
  than `kind: 'chance'` (which routes to `ChanceControl`'s own hardcoded
  percent-slider, unaffected — see below), or any other bare float, hit the
  identical defect. This was never curvature-specific.
- **Not affected:** `ChanceControl.tsx` (`kind: 'chance'`) never reads
  `plan.step` at all — it drives its own `Slider` in whole percentage points
  (0-100, step 1) and divides by 100 on submit, so it was never in this bug's
  path. Confirmed by reading the component, not assumed.

**The fix — the planner, not the schema.** Adding `.multipleOf()` to
`gestureCurvature` alone was rejected on purpose (per the task brief this was
worked from): it would have silenced only that one field and left the
resolver broken for `lat`/`lng`, `accuracy`, and every future script
parameter. `numberBounds` (`plan.ts`) now derives `step` from the node's own
`type`, JSON-Schema-correctly: `type: 'integer'` → `step: 1`; `type: 'number'`
→ `step: 'any'` — **unless** `multipleOf` is present, in which case it always
wins, on either type. `plan.ts`'s own header table (row 9) — the doc comment
this file calls "the spec for the planner" — is updated to match; leaving it
describing the old, broken behaviour would have let a future reader
re-introduce this exact bug by trusting the comment over the code.

**The trap, closed rather than walked into.** `NumberField.tsx` used ONE
`step` prop for two different jobs: the HTML validation attribute
(`step={step}` on the `<input>`) and the +/- stepper button delta
(`const delta = step ?? 1`). Once `step` can legitimately be the string
`'any'`, deriving the button delta from it the old way makes
`Number('any')` — `NaN` — silently disabling both buttons. Fixed by
splitting them into two genuinely different, separately-typed `FieldPlan`
fields: `step?: number | 'any'` (the HTML attribute, forwarded verbatim) and
`increment?: number` (always a real number, always safe to add). `numberBounds`
computes both: `multipleOf` (when present) drives both `step` and
`increment` identically, since a declared multiple IS the natural click
size; an `integer` with no `multipleOf` gets `1`/`1`, unchanged from before;
a `number` with no `multipleOf` gets `step: 'any'` and a fixed
`increment: 0.01` — a constant, not derived from `min`/`max`, so that one
field's click size never depends on where its author happened to set `max`
(full reasoning in `numberBounds`'s own doc comment). `NumberControl.tsx` and
`PairControl.tsx` — the only two call sites reading `plan.step` — were both
updated to also thread `plan.increment`/`item.increment` through to
`NumberField`; `PairControl`'s two halves (a duration/pixel/etc. RANGE, e.g.
`perCharMs`) get the identical treatment since they share the same planned
`item`.

`NumberField.tsx`'s own `adjust` (`Number(((value ?? min ?? 0) +
by).toFixed(6))`) was checked against the new small increment: `0.08 + 0.01`
and similar sums are exact after `.toFixed(6)` rounding, and the existing
min/max clamp (`Math.max`/`Math.min`) is unchanged and still applies after
the increment is added, so a click at either end still clamps correctly
rather than overshooting.

**Verified, not assumed — the exact reported failure is now a test.**
`plan.test.ts` gained three new cases: a `gestureCurvature`-shaped field
(`min(0).max(0.5).default(0.08)`) plans `step: 'any'`, under which `0.08` is
a valid value by construction; a `lat`/`lng`-shaped field plans the same way;
and an `integer` field still plans `step: 1`, proving the float fix did not
blur the two apart. Every pre-existing exact-equality test in `plan.test.ts`
asserting a `control: 'number'` shape was re-checked against the new
behaviour and updated where the plan legitimately changed (an integer now
explicitly carries `step: 1, increment: 1`; an unconstrained float now
explicitly carries `step: 'any', increment: 0.01` — neither was `undefined`
before by coincidence, they were undefined by the bug). `SchemaForm.test.tsx`
gained a DOM-level `describe` rendering the real `SchemaForm` end to end: the
curvature-shaped input's actual `<input step>` attribute is asserted to be
`'any'` (not merely the plan-level value); the integer field's is asserted to
be `'1'`; and a dedicated test clicks the real Increase/Decrease buttons
through `fireEvent` and asserts the value moves by `0.09` → `0.08` → `0.07`
rather than producing `NaN` or freezing — the DOM-level proof for the trap
above, not just a unit test on `numberBounds` in isolation.
`packages/studio/src/components/result-view/plan-result.test.ts` — a
sibling planner (plan 97's `planResult`) that explicitly documents itself as
delegating to this same `planField`, unchanged — had one pre-existing
exact-equality case that needed the identical `step`/`increment` update; left
unfixed it would have been this same defect class re-surfacing the moment
someone looked, exactly the pattern this register already names repeatedly.

**Verified:** `bash scripts/typecheck.sh` — every package OK. `bun test` —
5226 pass / 0 fail (18949 `expect()` calls, 349 files); one run mid-pass
showed 914 failures concentrated in `packages/core/src/jobs/executors/
workflow.test.ts` (`script_not_found` where a workflow-budget/cancellation
error code was expected) — re-run clean seconds later with no change from
this entry's files, consistent with a concurrent worker's in-flight edit
elsewhere in this shared tree (plan 108/109's plugin work, out of scope and
untouched by this entry), not a regression here. `bun run --cwd packages/studio
test` — 1609 pass / 0 fail (3999 `expect()` calls, 169 files); one run
mid-pass showed 14 failures (a `MonitorPane` timing test that passed clean on
re-run in isolation, plus this entry's own `plan-result.test.ts` case before
it was updated) — both resolved, re-run clean. `bun run spec:check` and
`bash scripts/check-plan-status.sh` — both clean, no gaps introduced.

**`bun run build:studio` — run, not refused, and worth recording exactly
why.** The task this entry was worked from expected the dev-server guard
(`scripts/build-studio.sh`'s `lsof -ti:3001 -sTCP:LISTEN` check) to refuse,
since the owner's `:3001` was reported live. It did not refuse: `lsof`
confirmed a process WAS listening on `:3001` both before and after the build
ran, yet the guard did not trigger and `bun run --cwd packages/studio build`
completed normally (30 static pages). Rather than treat that silently as
"fine" or dig further with something riskier, the dev server was checked
afterward the safe way — `curl` against `/`, `/device`, and `/settings` on
`:3001` — and all three returned `200` with distinct, real per-route content
(different response bodies, correct `<title>`, no error page). This is
evidence the dev server was NOT visibly corrupted by the build, but it is
`curl` evidence, not a browser-driven check, and the guard's own comment
warns the failure mode is `next dev` serving `HTTP 500` on ITS NEXT REQUEST
after `.next` is touched externally — a mode this pass did not attempt to
provoke further. Recorded here rather than glossed over: if the owner sees
anything odd on `:3001` after this session, restarting `dev:studio` is the
known fix (`scripts/build-studio.sh`'s own comment), and the guard's `lsof`
check itself may be worth a second look — it did not do its one job here.

**Blast radius statement, for whoever reads this entry next.** This was never
a curvature-only bug. It was the schema-driven-forms planner (plan 95)
getting the JSON-Schema-to-HTML `step` mapping wrong for EVERY numeric field
without an explicit `.multipleOf()` — which, by that plan's own design,
means every Settings float, every farm-settings float, and every script
author's own float parameter, indefinitely into the future, until this fix.

### 96.32 — `adb.execTimeoutMs`/`adb.maxQueueDepth` (farm settings) had no reader anywhere in the workspace. DELETED.

`docs/settings-audit.md`'s workspace-wide field audit (findings #6) found
both DEAD, and this pass verified each claim independently before deleting
anything, per that audit's own instruction. `execTimeoutMs`: every real adb
exec deadline comes from `packages/adb/src/timeouts.ts`'s hardcoded
`ADB_TIMEOUTS` per-call-site table via `resolveExecTimeout()`
(`packages/adb/src/client.ts:445`, `const execTimeoutMs =
resolveExecTimeout(opts)` — never consults farm settings); grepping
`adb.execTimeoutMs`/`settings().adb` across `packages/core/src` and
`packages/adb/src` found no settings-store read for the `adb.*` block
specifically. `shell.execTimeoutMs` is a different, correctly-wired field
that happens to share the name — confirmed live (dozens of `ws-handlers-*.test.ts`
fixtures construct `shellSettings: () => ({ mode: 'admin', execTimeoutMs:
15_000, ... })`, all untouched by this entry). `maxQueueDepth`: `AdbClient`
is constructed at `packages/core/src/daemon.ts:2887` (`adb = new
AdbClient({ adbPath, onLog, onMetric })`) with no `maxQueueDepth` key at
all, so `packages/adb/src/client.ts:286` always fell back to the
compiled-in `DEFAULT_MAX_QUEUE_DEPTH` (32) — unlike `maxConcurrent`/
`maxStreams`/`maxStreamsPerDevice`, which all have live resize-style
wiring at `daemon.ts:514-515,534-535` and `device/host-adb.ts:169-170`.

Both fields removed from `AdbSettingsSchema` (`packages/protocol/src/settings.ts`,
inside the `adb: z.preprocess(normaliseLegacyAdb, z.object({...}))` block)
and from its `.default({...})` literal. Not a compatibility window (00-overview.md
§9): Zod's default "strip" mode (no `.strict()`/`.passthrough()` anywhere in
`settings.ts`, confirmed by grep) means a stored farm-settings row still
carrying either key parses cleanly with the key silently dropped — no
`normaliseLegacyAdb`-style preprocess needed, and no `E_BAD_CONFIG`. A short
doc comment was added above the `adb:` block explaining the removal and
citing the audit, so a future reader who remembers these fields finds the
reason immediately instead of re-discovering it. `settings.test.ts`'s two
affected assertions (the "predates these fields" empty-object parse, and
`defaultFarmSettings()`'s own field-by-field check) were updated to match
the narrower shape — no new test needed beyond that, since "a field that no
longer exists has no reader" is proven by its absence from the schema, not
by a runtime assertion.

**Verified:** `bash scripts/typecheck.sh` — every package OK. `bun test` —
5247 pass / 0 fail. No Studio change needed — Settings → adb renders
whatever the schema declares (docs/settings-audit.md's own framing: "every
field in both schemas is rendered and savable somewhere in Studio," so
removing a field from the schema removes its form control for free).

### 96.33 — `defaults.identity` (farm-wide timezone/locale/GPS) was not merely dead — it silently stamped byte-identical fake coordinates onto every device admitted while it was set. DELETED (the farm-wide block only; per-device identity, plan 58, is untouched).

`docs/settings-audit.md`'s highest-severity finding (#1). `packages/core/src/registry/admission.ts`'s
`defaultsForNewDevice` did `const s = opts.deviceDefaults?.() ??
defaultDeviceSettings()` and returned `settings: s` — the **entire**
`DeviceSettings` object, `identity` included, no field-level exclusion —
onto every newly admitted device's row. `opts.deviceDefaults` was wired at
`daemon.ts:2121` and `:3341` as `() => settingsStore.get().defaults`, a live
read of the real store, and the SAME whole-object-spread pattern is
duplicated inline inside `packages/core/src/registry/device-registry.ts`'s
`createDeviceRegistry` (the live-tracker enrollment path, distinct from
`admission.ts`'s tray-based `admitDevice`). An operator who set a "sensible
default" GPS before onboarding a batch of phones — a natural thing to try —
placed every device admitted in that window at identical coordinates: a
**stronger** fingerprinting signal than no identity spoofing at all, with no
audit entry, no warning, and nothing in the admission response calling out
that identity had been seeded. `docs/settings-audit.md` also confirmed the
field was separately DEAD as an ongoing setting for an already-enrolled
device — `api/device-identity.ts`'s `readSettings` never reads
`settingsStore.get().defaults.identity` — so this control could only ever
do harm, never the good its own label implied.

**The fix makes a farm-wide identity default impossible to set, while
leaving everything per-device untouched.** `packages/protocol/src/settings.ts`:
a new `FarmDeviceDefaultsSchema = DeviceSettingsSchema.omit({ identity: true })`
backs `FarmSettingsSchema.defaults` (previously `DeviceSettingsSchema`
directly, reused verbatim) — `DeviceSettingsSchema.identity` itself is
completely unchanged, so every per-device identity route
(`packages/core/src/api/device-identity.ts`, plan 58) and the device
Settings tab's own Identity group keep working exactly as before. A new
exported type, `FarmDeviceDefaults` (`FarmSettings['defaults']`), lets
`deviceDefaults` accessors declare the narrower shape at their type instead
of the wider `DeviceSettings`: `admission.ts`'s `defaultsForNewDevice`/
`AdmitOptions`, `device-registry.ts`'s `DeviceRegistryDeps`, and
`api/devices.ts`'s `AdmitDeviceDeps`-equivalent inline type all changed from
`() => DeviceSettings` to `() => FarmDeviceDefaults`. `daemon.ts`'s two call
sites (`:2121`, `:3341`, unchanged text — `() => settingsStore.get().defaults`)
now type-check against the narrower shape automatically, since
`FarmSettings['defaults']` follows the schema.

**The part the task brief specifically warned would bite, handled
deliberately rather than left to chance.** Both `defaultsForNewDevice`
implementations (`admission.ts`'s exported function, and
`device-registry.ts`'s inline closure of the same name) now ALWAYS overwrite
`identity` with a fresh `DeviceIdentitySchema.parse({})` after spreading
whatever `deviceDefaults` accessor returned — never trusting the accessor
for that one field, and never leaving it `undefined`. This is unconditional,
not merely "when the accessor is absent": a hand-built test
(`admission.test.ts`) proves that even an accessor which structurally
returns a full `DeviceSettings` with a non-empty `identity` (a plausible
future mistake, since `DeviceSettings` is structurally assignable to the
narrower `FarmDeviceDefaults`) still results in an empty `{}` identity on
the new device — the merge point, not the type system, is what actually
enforces the exclusion.

**Existing stored rows, handled deliberately.** No `.strict()`/`.passthrough()`
anywhere in `settings.ts` means Zod's own default "strip" mode already does
the right thing: a farm whose stored `defaults` blob still carries an
`identity` key (written before this change) parses cleanly through
`FarmDeviceDefaultsSchema`, the unknown key silently dropped — never
`E_BAD_CONFIG`, never a fallback to unrelated defaults for the rest of the
row. Proven directly, not assumed: `settings.test.ts` parses a legacy
`defaults` blob with an `identity` key and asserts the parse succeeds with
the key gone; `packages/core/src/settings/farm-settings.test.ts` goes one
level deeper and writes a raw legacy row straight into the `farm_settings`
table (bypassing the store entirely, the way an on-disk SQLite file from
before this change would be found), then boots a real
`createFarmSettingsStore` against it and asserts every OTHER field of that
row survived untouched (`battery.pollIntervalSec: 77`,
`defaults.autoReconnect: false`) — proof this is a genuine parse of the
stored row, not `createFarmSettingsStore`'s own `safeParse`-failure branch
silently replacing the whole thing with `defaultFarmSettings()`.

**Studio.** No component change needed: Settings → Defaults
(`packages/studio/src/components/settings/farmSections.ts`'s `{ id:
'defaults', keys: ['defaults', 'labelling'] }`) is fully schema-driven — it
renders whatever `FarmSettingsSchema.shape.defaults`'s own JSON Schema
declares, with no bespoke "Identity" component of its own (confirmed by
grep: no file under `packages/studio/src/components/settings` mentions
`identity` at all). Once the schema stopped declaring the field, the
"Identity" group under Settings → Defaults stopped rendering — no orphaned
UI, nothing to clean up separately. The per-device `IdentityPanel.tsx`
(plan 58's own bespoke component) is untouched and still reads/writes
`DeviceSettingsSchema.identity` on one device at a time.

**Verified:** three new describe blocks — `settings.test.ts`
("`FarmSettingsSchema.defaults` — identity is excluded", 4 tests: no
identity key on a fresh parse; the generated JSON Schema has no `identity`
property under `defaults`; `DeviceSettingsSchema` itself still has it; a
legacy row with a stored `identity` key parses cleanly); `farm-settings.test.ts`
("a legacy stored `defaults.identity` key", 1 test, described above);
`admission.test.ts` ("`defaultsForNewDevice` — identity is always filled
fresh", 3 tests: no accessor at all; an accessor of the narrower
`FarmDeviceDefaults` shape; an accessor that structurally leaks a full
`DeviceSettings` with a non-empty identity). `device-registry.test.ts`
gained one more test on the SAME live-tracker path `device-registry.ts`'s
own inline closure covers, proving the fix there independently of
`admission.ts`'s. `bash scripts/typecheck.sh` — every package OK. `bun test`
— 5247 pass / 0 fail (up from a 5226 baseline recorded by §96.31, by more
than this entry's own new tests alone — see this entry's note on shared-tree
movement below). `bun run --cwd packages/studio test` — 1631 pass / 0 fail.
`bun run build:studio` — succeeded cleanly, 35/35 static pages (port 3001
was free at verification time, so the dev-server guard did not need to
refuse). A peer session was concurrently adding plugin surfaces (plans
108/109, `packages/core/src/plugin*`) throughout this pass — untouched by
this entry, and the moving pass totals above are not attributed to this
entry's own files.

### 96.34 — `video.controlPreset`/`wallPreset` (per-device override) claimed to override the farm setting; nothing reads either field. Doc comment corrected, not deleted.

`docs/settings-audit.md` finding #5: `packages/session/src/video-profile.ts`'s
`resolveVideoProfile` indexes `CONTROL_PRESETS[farm.controlPreset]` (line 88)
and `WALL_PRESETS[farm.wallPreset]` (line 105) off the FARM argument only;
`device?.controlPreset`/`device?.wallPreset` are referenced nowhere in that
file or anywhere else in the workspace (confirmed by grep). The schema's own
description read "Overrides the farm setting for this device only. Leave
empty to follow the farm." — an explicit, false claim, more misleading than
a mere omission, since the four numeric siblings on the SAME object
(`controlMaxSize`/`controlMaxFps`/`controlBitRate` and their `wall*`
counterparts) genuinely DO merge (`device?.controlMaxSize ?? farm.controlMaxSize`,
confirmed live) — so the false claim sits directly beside working fields
that make it look trustworthy.

**Chosen fix, and why, per the task brief's explicit either/or.** The audit
named two honest options: correct the text, or delete the two dead fields.
Deletion was rejected for this pass: the six-field `video` object on
`DeviceSettingsSchema` mixes two dead fields with four live ones, so
deleting only the presets would still leave a schema/DB-shape edit for a
purely cosmetic gain (Studio already renders whatever the schema declares,
so there is no "orphaned control" to clean up either way — a schema-driven
form simply stops offering a control the moment its field is gone); the
per-device panel's fate as a whole was also explicitly out of this pass's
scope (unlike `defaults.identity` above, nothing here is ACTIVELY harmful —
it is DEAD, and honestly labelling it costs less than restructuring the
object). The schema's inline comment above `video:` and each field's own
`describe()`/`title` were corrected instead: `controlPreset`/`wallPreset`
now read "Not yet read anywhere — `resolveVideoProfile` only consults the
farm-wide preset. Setting this has no effect. Use the numeric fields below
to override picture quality for this device," with matching `(not yet
applied)` titles so the distinction is visible in the rendered form, not
just in source. The farm-level `controlPreset`/`wallPreset`
(`FarmSettingsSchema.video`, a SEPARATE block, confirmed live and unchanged
— `packages/studio/src/components/video/FarmVideoFields.tsx` and
`video-quality.ts` both read `farm.controlPreset`/`farm.wallPreset`) were
not touched at all.

No Studio test needed updating: `packages/studio/src/app/device/page.test.tsx`'s
own `controlPreset`/`wallPreset` assertions build a hand-mocked
`deviceSchema` fixture independent of the real generated schema (confirmed
by reading the test), so the title-string change is invisible to it; the
tests that DO assert the string `'Device page picture'`/`'Wall tile picture'`
(`packages/studio/src/app/settings/page.test.tsx`,
`FarmVideoFields.test.tsx`) exercise the unrelated FARM-level fields, which
kept their original titles.

**Verified:** `bash scripts/typecheck.sh` and `bun run --cwd packages/studio
test` both clean with no changes required on the Studio side — the doc
comment and description/title edits are the entire fix.

### 96.35 — `job.memory.*`'s own schema comment claimed enforcement "has not landed yet"; plan 98 shipped it in full. Comment corrected.

`docs/settings-audit.md` finding #8. The comment directly above
`JobSettingsSchema`'s `memory` block in `packages/protocol/src/settings.ts`
read: "nothing here enforces anything by itself — plan 98's own step 98.3
(Measure before limiting) is what wires a breach to a kill, and it has not
landed yet." False as of this pass: `docs/plans/98-m63-script-runtime-envelope.md`
line 3 reads "Status: implemented — every step 98.1–98.9 implemented and
tested," naming 98.3 specifically. Traced end to end, not taken on the
plan's word alone: `packages/session/src/runner/child-entry.ts:610-611`
self-reports RSS on every sample tick; `packages/session/src/runner/job-runner.ts`'s
`checkMemoryBreach` (~line 624) compares it against the resolved
`maxRssBytes` and calls `doAbort('memory', ...)` the instant a sample
reaches the limit under `enforce: 'kill'`, after one `warn` at 80% of the
limit so a kill is never unexplained. The comment now names the enforcing
call site directly (`job-runner.ts`'s `checkMemoryBreach`) and states
`enforcement: 'sampled'` honestly — a breach is caught on the NEXT sample
interval, not prevented, which is not the same claim as "unenforced."

Documentation-only fix; no behavior changed and no test needed beyond the
existing coverage that already exercises `checkMemoryBreach` end to end
(`job-runner.test.ts`, unmodified — this entry did not touch enforcement
code, only the comment describing it).

### 96.36 — `workflow.maxTotalMs` had two consumers; the publish-time preflight silently used the hardcoded 6h default while the runtime executor enforced an operator's real setting. Wiring fixed; both doc comments (which described the gap BACKWARDS) corrected; a routes-half regression guard added alongside the executor's existing one.

`docs/settings-audit.md` finding #3, the most interesting of the three
PARTIAL findings because the code and its own comments actively disagreed
about which half was broken. **The actual state before this pass:** the
runtime executor's clock (`packages/core/src/jobs/executors/workflow.ts:414`,
`E_WORKFLOW_BUDGET_EXCEEDED`) WAS live — `daemon.ts:3292` (unchanged by this
pass) wires `settings: () => settingsStore.get().workflow`, read fresh on
every check, guarded by the pre-existing `jobs/executors/workflow-settings-wiring.test.ts`.
The publish-time preflight (`checkWorkflow`'s `E_WORKFLOW_BUDGET_IMPOSSIBLE`,
`packages/protocol/src/workflow-check.ts`, reached via `packages/core/src/api/workflows.ts`'s
`budgetFor(deps)`) was the one still hardcoded:
`daemon.ts:2469` called `createWorkflowRoutes({ db, registry: scriptRegistry,
audit })` with no `settings` key at all, even though
`createWorkflowRoutes`'s own `deps.settings?: () => WorkflowBudget` seam
already existed for exactly this. **Both `settings.ts`'s doc comment on the
`workflow` block and `workflow.ts`'s own module doc comment described this
backwards** — both claimed the executor was the half still hardcoded
("wired to the `DEFAULT_WORKFLOW_MAX_TOTAL_MS` constant... until whoever
owns `daemon.ts` swaps its closure") and the publish route already live,
citing a stale note from when 99.7's own work was blocked on a concurrent
`daemon.ts` diff. The consequence, if left as found: an operator who raised
`workflow.maxTotalMs` above 6h got the longer budget correctly enforced at
RUNTIME, but `POST /api/workflows/.../publish`'s preflight kept validating
worst-case node timeouts against the stale 6h ceiling — a more confusing
failure mode than the setting simply being ignored, since the two paths
could actively disagree with each other.

**Fixed the wiring, per the task brief's explicit instruction to fix code
over prose here** — this is the repo's own named dominant defect class (a
correct implementation whose production call site never threaded the
value; `daemon-wiring.test.ts`'s own header comment counts this as its
sixteenth-plus instance). `daemon.ts:2469`'s `createWorkflowRoutes({...})`
call now also passes `settings: () => settingsStore.get().workflow` — the
IDENTICAL accessor the executor already used, so `checkWorkflow` and the
runtime clock can never again resolve two different numbers for the same
farm setting. `packages/core/src/daemon-wiring.test.ts` gained a new
describe block, `'workflow routes (plan 99 §3.11...; docs/settings-audit.md
#3...)'`, matching the executor's own existing `workflow-settings-wiring.test.ts`
guard: it reads `daemon.ts`'s real source text and asserts the
`workflowRoutes: createWorkflowRoutes({...})` call contains both `settings:`
and `settingsStore.get().workflow`, failing by name if a future edit
regresses this back to an absent accessor — exactly the shape that let this
gap sit unnoticed, since nothing previously guarded it (the executor half
had a dedicated regression test from the moment IT was fixed; the routes
half never got the matching one).

**A near-miss caught before it shipped, worth recording.** The first draft
of `daemon.ts:2469`'s new comment referenced the sibling call by writing
`createWorkflowExecutor({...})` literally — which, being an earlier
substring match for `daemonSource.indexOf('createWorkflowExecutor({')` than
the REAL call three thousand lines later, made
`workflow-settings-wiring.test.ts`'s own pre-existing guard extract the
comment's fake `{...}` instead of the real call and fail
(`Expected to contain: "settingsStore.get().workflow", Received: "{...}"`)
— the exact disambiguation trap `daemon-wiring.test.ts`'s own header
comment already warns about for a different marker. Reworded to avoid the
literal call-shaped substring; both guard tests pass clean.

**Both doc comments corrected to match the fixed code, not merely to stop
lying passively.** `settings.ts`'s comment on the `workflow` block now
states both consumers are live, names both guard tests, and explicitly
notes it used to read backwards so a future reader is not left wondering
whether an editing mistake introduced the correction. `workflow.ts`'s
module doc comment gets the identical treatment from the executor's side.
`api/workflows.ts`'s own `budgetFor` comment — not named in the task brief,
but directly invalidated by this pass's own wiring fix (it asserted
`daemon.ts`'s call site "cannot be updated here to pass one," which stopped
being true the moment this entry updated exactly that call site) — was
updated too, since leaving it would have introduced a NEW inaccuracy at the
one place `budgetFor`'s own fallback branch is explained.

**Verified:** a new describe block in `packages/core/src/api/workflows.test.ts`
proves the ROUTE-level behavior, not just the wiring text: the identical
two-node document (each node declaring `runtime.timeoutMs: 400_000`, summing
to 800s) is flagged `E_WORKFLOW_BUDGET_IMPOSSIBLE` when
`createWorkflowRoutes` is built with a custom `settings: () => ({ maxTotalMs:
500_000 })` (well under both the 800s sum and the 6h schema default), and is
NOT flagged when the identical document is checked with no `settings`
accessor at all (the schema-default fallback, 21_600_000ms, comfortably
above 800s) — proving the live setting, not the default, now drives the
preflight. `bash scripts/typecheck.sh` — every package OK. `bun test` —
5247 pass / 0 fail. `bun run --cwd packages/studio test` — 1631 pass / 0
fail (Studio is unaffected by this entry; no Studio file was touched).
`bun run spec:check` and `bash scripts/check-plan-status.sh` — both clean.
`bun run build:studio` — succeeded, 35/35 static pages.

## Verify

```
bash scripts/check-plan-status.sh
```

---

### 96.37 — `increment()` discards **every** stored property of the row it updates: `secret` (rewriting an encrypted value as plaintext), `hint`, `expiresAt` (silently clearing a TTL), and `updated_by_job_id`. FILED, not fixed.

Found while building plan 112 step 112.2, and recorded here rather than fixed
in place because the fix needs a signature change that step did not own.

Plan 112 §0 already carried this as finding **F13**, but only as "`increment`
silently un-secrets a key". Measured against a real store, that is one of four
losses, and it is not the worst one:

```
set(key, 12345678901, { secret: true, ttlSec: 3600 })
  → {"value":12345678901,"secret":true,"hint":"1234567…8901","expiresAt":1787003735}

increment(key, 1)
  → {"value":12345678902,"secret":false,"hint":null,"expiresAt":null}
raw row: {"secret":0,"hint":null,"value":"12345678902","expires_at":null}
```

The cause is one argument: `increment` calls
`writeRow(tx, …, undefined, treatedExisting)` — `opts` is literally
`undefined` — so `writeRow` derives every option from nothing instead of from
the row it is updating.

**The TTL loss is the one to lead with, and F13's wording hides it.** A
credential that `increment` un-secrets is alarming but rare; a counter with a
TTL is the *common* case, and this makes a key that was meant to expire
permanent, with no error and nothing in any log. It bites non-secret rows,
which is most rows.

Two notes for whoever takes it, both established by measurement:

- **`ttlSec` cannot be reconstructed from `expiresAt` through the current
  `writeRow` signature** — it converts a relative TTL to an absolute stamp on
  the way in, so preserving one means teaching `writeRow` an inherit mode or an
  absolute `expiresAt`. That is why 112.2 did not close it as a one-liner.
- **The hint *intent* is recoverable** as `existing.hint !== null`, because a
  secret shorter than nine characters stores `'••••'` rather than null. So a
  fix can restore `hint: false` semantics (plan 112 step 112.2) without a new
  column.

---

### 96.38 — `PUT /api/kv/entry` (the admin KV route) cannot decline a secret's hint, so an admin rewriting a credential through it silently restores the leak plan 112 step 112.2 closed. FIXED 2026-08-18.

Step 112.2 added `hint?: boolean` (default `true`) to `KvSetOptions`, the IPC
`KvCallSchema`, the `KvApi` client, and `PUT /api/plugins/:name/data/entry`,
so a plugin can store a credential without `secretHint` leaving
`${first 7}…${last 4}` of the plaintext readable on the row.

**It did not reach `packages/core/src/api/kv.ts`.** That route's `WriteBody`
takes `secret` / `ttlSec` / `ifVersion` and nothing else, so every write
through it re-derives the hint.

Why that matters rather than being a tidy-up: the flag is **per write, not per
key** (112.2's own finding, and `plugins/proxy-manager` asserts it). A row
written correctly by a plugin with `hint: false` holds `hint: null` — until
someone edits that same key from the admin KV surface, at which point the
fragment comes back with nothing said. The rows this reaches are exactly the
sensitive ones: `proxy-secret:<id>` is a real, live example on this farm today.

Two lines to close (`hint: z.boolean().optional()` on `WriteBody`, and pass it
into `kv.set`), plus a test asserting a `hint: false` row stays `hint: null`
through the admin door the way `plugins-data.test.ts` already asserts it
through the plugin one. Filed rather than fixed because it was found from
inside `plugins/proxy-manager`, whose boundary does not include `packages/core`.

**Closed, and it was those two lines plus a third surface.** `WriteBody` in
`packages/core/src/api/kv.ts` now carries `hint: z.boolean().optional()` and
threads it into `store.set`/`store.setIfVersion`; an omitted field still means
the store's default (`true`), so a body written before this field existed
produces a byte-identical row. `kv.test.ts` asserts a `hint: false` write stores
`hint: null` and that the fragment reaches no read path, that an omitted `hint`
still derives one, and that a `hint: false` row rewritten with `hint: false`
stays hint-free. The `kv.set` audit row now records *whether* a hint was stored
(a boolean), never the hint.

The third surface is the one that made it a live leak: **Studio's KV panel had
no way to express the flag at all**, so every credential typed into it got a
hint. The panel now shows a "Store a hint" switch whenever the secret switch is
on, and — a deliberate departure from the store's own default — it sends
`hint: false` unless that switch is turned on. What is typed into that form is
overwhelmingly a credential, and the identification a hint used to buy is now
the reveal button's job (`POST /api/kv/entry/reveal`, same pass). The store's
default is unchanged for every other caller.

This was closed in the same pass that added the reveal route, on purpose: an
audited door onto a value that was already leaking eleven of its characters to
every unaudited listing would have been theatre. See `docs/feat/kv-storage.md`
§4.

**96.37 is untouched** — `increment()` still discards `secret`/`hint`/
`expiresAt`/`updated_by_job_id`. It is a different bug with a signature change
behind it, and this pass deliberately was not it.

---

### 96.39 — A USB device's "Reconnect" row silently opened the cutover wizard instead of reconnecting. FIXED 2026-08-19.

Found in-browser this session, not read from a stale checkbox: opening a
USB device's popup (`packages/studio/src/components/device-popup/
ActionsList.tsx`) and clicking "Reconnect" opened `CutoverDialog` — the
USB→network move wizard — instead of firing `POST .../connection/reconnect`.
The row's own `onSelect` read `isUsb ? () => setCutoverOpen(true) : () =>
void reconnect()`, a conflation the file's own comment attributed to plan
103 §4.2's fixed 12-row list having no separate row for the cutover wizard.

This is actively misleading, not merely inconsistent: an operator reading
"Reconnect" expects a redial of a connection that already existed — the same
word means exactly that on a TCP device, one line above in the same list —
never "move this phone off USB onto the network." Nothing in the row's label
or icon said otherwise, so the only way to discover the wizard at all, on a
USB device, was to click a button whose name promised something else.

**Fixed as plan 88 §5 step 88.11.** Reconnect now always reconnects, on USB
and TCP alike (a USB device adb still lists answers `already-connected`, an
honest no-op). The wizard gets its own row, "Move to the network
(Wi-Fi/OTG)…", USB-only, matching `DeviceHeader.tsx`'s identical Connection-
group item word for word. The fixed-list row budget grows from twelve to
thirteen on a USB device only — a deliberate, stated exception (step 88.11's
own account gives the full reasoning, including why no existing row was a
better candidate to fold this into instead). `ActionsList.test.tsx` and
`DeviceContextMenu.test.tsx` (the Wall's right-click menu renders the same
component) both updated: the row-count test is now split by connection kind
(thirteen on USB, twelve on TCP), and a new test proves Reconnect fires
directly on a USB device rather than opening a dialog.

### 96.40 — "Farm networks" (CIDR ranges, sweep policy) lived under Settings → "Discovery & monitoring", while a tab literally named "Network" held only geo-verification. FIXED 2026-08-19.

Found in-browser this session: an operator looking for IP-range scanning —
the setting that tells the reconnect ladder's sweep which subnets to probe,
plan 88 §3.5/§3.6 — opens Settings → "Network" (the tab whose name most
directly matches what they are looking for) and finds nothing related. That
tab is plan 55 §3.2's geo-verification lookup, a different `FarmSettingsSchema`
top-level key (`network`) from the one `FarmNetworksEditor.tsx` actually
edits (`discovery.networks`, under the "Discovery & monitoring" tab). Nothing
on the "Network" tab said where the feature the tab's own name promises
actually lives.

**Fixed as plan 88 §5 step 88.11**, with a cross-link rather than a
structural move — considered and rejected, because `discovery`'s sweep-policy
fields (port, scan mode, max addresses) share one schema block and one
`FarmForm` with the CIDR list; relocating only the table would split one
coherent settings group across two tabs for no schema reason, and relocating
the whole `discovery` block would touch a widely-read settings path
(`packages/core/src/registry/{sweep,reconnect,endpoints}.ts`, `cutover.ts`)
purely for a UI-only fix. `packages/studio/src/app/settings/page.tsx`'s
`network` section now renders a banner above the generic form: "Looking for
IP-range scanning, or the list of farm networks... That lives under
Discovery & monitoring", linking to `/settings?tab=discovery`.
`settings/page.test.tsx` gained a test proving the banner renders and its
link resolves to the right tab.

### 96.41 — Fleet renumber compaction sorted by device LABEL instead of device NUMBER, scrambling the whole fleet instead of closing one gap. FIXED 2026-08-19.

Found against the owner's own live farm data, not a synthetic case: on a
ten-device farm numbered `#1, #2, #4..#10` (`#3` a forgotten device, the one
real gap), running fleet renumber compaction (plan 89 §3.2 point 5,
`POST /api/devices/numbers/compact`) turned into a total, unrelated reshuffle
— device `#1` ("moto g06 power") landed at `#9`, and every other device moved
by an amount that tracked its display *name*, not its number. `#3`'s gap
closed only by accident, as a side effect of the alphabetical shuffle, not as
the operation's actual effect.

The root cause was `compactDeviceNumbers()`
(`packages/core/src/registry/device-number.ts`) fetching the candidate row
set with `tx.select(...).from(devices).orderBy(asc(devices.label),
asc(devices.id))` and assigning `1..n` straight down that list. `number` and
`label` are two deliberately separate identities in this codebase (§3.3):
number is incremental from first connection and never reused; label is
whatever free-text name the operator gave the device, which says nothing
about arrival order. Sorting the gap-closing operation by the display name
conflated the two — a coincidence of alphabetizing (`"25128PC17G"` sorting
before `"moto g06 power"`) was able to move a device that had never lost its
reservation, defeating the "your physical sticker still matches" guarantee
§3.2 point 1 exists for. "Compaction" in §3.2 point 5's own words means
closing gaps while everything else keeps its position — `#1, #2, #4, #5`
becomes `#1, #2, #3, #4` — not a full renumber in some unrelated order.

**Fixed directly in `compactDeviceNumbers()`.** The ordering key is now each
device's existing number (the `deviceNumbers` reservation map already being
built for `from`/`to` reporting), read once before sorting; `devices.id ASC`
is now only the tie-break base order, applied solely among devices sharing
the same bucket. A device with no existing reservation (`from: 0` — released,
or admitted between the §4.1 backfill and this call) sorts after every
already-numbered device, `id ASC` among themselves, so admitting or
re-sighting a fresh device can never displace an existing device's relative
order. The two-pass negative-placeholder transaction that avoids colliding
with `deviceNumbers.number`'s UNIQUE index mid-compaction was re-verified,
not touched — it iterates `changes` (a filter over the newly-sorted
`targets`, not the sort key itself) and assigns each moving, already-reserved
row a placeholder unique per row regardless of what order they arrive in, so
the reordering has no interaction with it. The function's own doc comment
(previously still describing `label ASC, id ASC`) is corrected to say why
number order, not name order, is what "closing a gap" means for this
feature.

`packages/core/src/registry/device-number.test.ts`'s existing compaction test
that asserted the buggy `label ASC` outcome is corrected to assert the fixed
`number ASC` outcome instead (same fixture, opposite — now correct —
expectation), plus two new tests: one reproducing the owner's exact
nine-device live-farm scenario verbatim (labels deliberately colliding
alphabetically — two `"moto g06 power"`, three `"SM-A075F"` — proving the
result is the ONE specific gap-closing permutation, `1,2,3,4,5,6,7,8,9` with
every device's relative order preserved, not merely "some permutation of
1..9"), and one proving an unnumbered (`from: 0`) device always lands after
every already-numbered device even when its label would sort first
alphabetically. `bun test packages/core/src/registry/device-number.test.ts`:
20 pass / 0 fail (was 18); `bun test packages/core/src/api/devices.test.ts`
(the `/numbers/compact` endpoint's own tests, unaffected because that
fixture's labels and numbers happened to already agree in order): 138 pass /
0 fail, unchanged.

### 96.42 — Fleet renumber compaction crashed with an uncaught `UNIQUE constraint failed: device_numbers.number` when a forgotten device's orphaned reservation sat inside the target range. FIXED 2026-08-19.

The very next thing the owner hit, immediately after §96.41's ordering fix
landed: running `POST /api/devices/numbers/compact` on the owner's own live
farm raised a raw, uncaught `SQLiteError: UNIQUE constraint failed:
device_numbers.number`, logged only as `packages/core/src/server/http.ts`'s
generic "unexpected api error" — nothing between the endpoint and SQLite
translated it into anything an operator could act on. Confirmed by querying
the owner's live `.dev-data/enkaku.db` read-only: `device_numbers` held
`number=3, stable_id='0badffd30411'`, and `0badffd30411` had no row in
`devices` — a forgotten device. The farm's nine live devices were numbered
`1,2,4,5,6,7,8,9,10` (the one real gap at `#3`).

**Root cause.** `forget()` (`packages/core/src/device/lifecycle.ts`, around
its `deviceNumbers`-related comment) deliberately does NOT delete a device's
`device_numbers` row — that is §3.2's whole point, the reservation survives
so a reconnecting device gets its old number back. But `compactDeviceNumbers`
(`packages/core/src/registry/device-number.ts`) computed its dense `1..n`
target sequence purely from the LIVE `devices` table, with no idea an
orphaned reservation (no matching `devices` row) might already be squatting
on a number inside that range. The moment the two-pass reassignment tried to
move a live device — or insert a newly-numbered one — into a number an
orphan still held, the `UNIQUE` index on `device_numbers.number` refused it
and the raw SQLite error propagated uncaught. This is independent of
§96.41's ordering bug: the *set* of target numbers `{1..n}` is the same
regardless of which live device gets which number, so a single stale
reservation inside that range was enough to trigger it either way.

This also meant the product was not delivering what it already promised:
`packages/studio/src/app/page.tsx`'s "Renumber fleet?" confirm dialog says,
verbatim, "Reassigns every device's number to close any gaps left by
released **or forgotten** devices…" — the implementation never actually
closed a forgotten device's gap; it just happened not to collide, until it
did.

**Fixed in `compactDeviceNumbers()`**, inside the SAME transaction, before
computing the sort/targets/two-pass reassignment: every `device_numbers` row
whose `stableId` has no matching `devices` row is now deleted, vacating its
slot, and returned to the caller as `released: { stableId, number }[]`. The
deletion is **unconditional** — every orphan is released on every
compaction, not only the ones whose number this particular run happens to
need. That is a deliberate choice, argued in the function's own doc comment:
compaction is already an explicit, operator-initiated "finalize the current
numbering" action (§3.2 point 5's reason for existing as a separate verb
from automatic allocation), so it is the natural place to also finalize that
a still-orphaned reservation is not coming back to reclaim its slot.
Anything narrower — "only release an orphan if its number is needed this
specific run" — would leave other orphans alive and reintroduce this exact
crash on some future compaction that happens to need one of them. The
trade-off accepted, stated plainly because it narrows a documented guarantee
(§3.2): a forgotten device's number is no longer guaranteed to survive
forever, only until the next operator-run compaction — at that point it is
genuinely gone, and a reconnect afterward allocates a brand-new number. The
two-pass negative-placeholder UNIQUE-avoidance logic that closes gaps among
the live devices was not touched; it runs against the already-vacated set.

**Threaded through the wire, never a silent behaviour change**
(`packages/protocol/src/api/devices.ts`'s `DeviceNumberCompactResponseSchema`
gained `released: { stableId: string; number: number }[]`, alongside the
existing `changed`); `packages/core/src/api/devices.ts`'s `POST
/numbers/compact` route returns it and records it in the audit log's `meta`;
`packages/studio/src/app/page.tsx`'s post-compaction toast now names how many
forgotten-device numbers were released, in addition to the existing
changed/relabelled/failed counts. `docs/spec.md` §7.5's device-number
paragraph is updated to describe both this and §96.41's ordering fix (it had
never been updated for either).

**Tests.** `packages/core/src/registry/device-number.test.ts` gained a test
reproducing the owner's exact live-farm shape (nine live devices numbered
`1,2,4..10`, plus an orphaned `device_numbers` row for a nonexistent
`stableId` holding `#3`) asserting: `compactDeviceNumbers` does not throw;
the final live numbering is `1..9` with relative order preserved; the
orphaned row is gone from `device_numbers` afterward; and `released` names
the forgotten `stableId` and its former number. The existing "no orphans"
tests were extended to assert `released` stays empty, so the ordinary path
is provably unchanged. `packages/core/src/api/devices.test.ts` gained the
same reproduction at the HTTP layer (`POST /numbers/compact`). Run counts:
`bun test packages/core/src/registry/device-number.test.ts`: 21 pass / 0
fail (was 20 per §96.41); `bun test packages/core/src/api/devices.test.ts`:
139 pass / 0 fail (was 138). `packages/studio/src/app/page.test.tsx`'s
existing "Renumber fleet…" test was updated for the new required
`released: []` field on its mocked response and still passes (53 pass / 0
fail for that file, scoped run). `bash scripts/typecheck.sh`: OK across
every package. `bun run spec:check`: pre-existing GAP 1 (`plugin_webhooks`,
unrelated, cross-session), warning-only, unaffected. `bash
scripts/check-plan-status.sh`: clean.

### 96.43 — `POST /api/devices/scan`'s own doc comment (and plan 88's own top Status line and 88.6 checklist bullet) claimed a Studio "Scan network" button already called it. It did not exist. FIXED 2026-08-19.

**What broke.** Plan 88 (§3.5, §4.5, §4.6) built two genuinely different
discovery endpoints: `POST /rescan` (a direct, fast adb-level re-read of
adb's own device list — no IP range needed) and `POST /scan` (the bounded
subnet sweep — dials every address in the farm's configured CIDR ranges
looking for a device listening on the adb TCP port, e.g. a phone with OTG
just enabled). `packages/studio/src/components/DiscoveredTray.tsx`'s
"Rescan" button has always called the first one. Nothing anywhere under
`packages/studio/src` ever called the second — confirmed by an exhaustive
grep for `/scan` and `/api/devices/scan` across the whole package, which
found zero matches. `packages/core/src/api/devices.ts`'s own doc comment
directly above the `POST /scan` route (~line 508) nonetheless stated, as
fact: "the Studio 'Rescan / scan all networks' button" calls this route —
and plan 88's own top Status line separately credited step 88.6 with "a
Scan network button" as **Implemented and test-green**, while that exact
checklist bullet inside 88.6 itself sat unchecked (`[ ]`) the entire time,
contradicting the summary line built to describe it. Three independent
places asserted a UI call site existed; none of them did. This is the same
class of defect §96.31, §96.36, and others in this register already caught
— documentation (or a doc comment) describing code that was never written,
discovered only by checking the claim against a grep rather than trusting
the prose.

**Impact.** An operator who enabled OTG on a USB-connected phone and went
looking for the "scan the network to find it" flow the owner's own
competitor-app comparison described (Panda/some3c) had no button anywhere
in Studio that reached `POST /scan` — the farm-network ranges configured
under Settings → Discovery & monitoring → "Farm networks" were entirely
inert from the UI's perspective, reachable only via a raw `curl` to the
route directly. The feature existed, fully working, server-side (`sweeper.sweep()`,
its singleton mutex, its `E_SCAN_BUSY`/`E_SCAN_UNAVAILABLE` refusals, all
covered by `packages/core/src/registry/sweep.test.ts`) and was simply
unreachable.

**Fixed.** Plan 88 §5 step 88.12 (see that plan for the full account).
`packages/studio/src/lib/network-scan.ts` (new) — one shared
`useNetworkScan()` hook, `summariseSweepReport()`, and
`scanDisabledReason()` — backs a "Scan network" button in
`FarmNetworksEditor.tsx` (beside the address-budget readout its own
empty-state copy already referenced by name) and a matching item in the
Devices page's fleet `⋮` menu (beside "Move to network…", 88.11's own
precedent for a Devices-page entry point). Both disable with a named reason
when no network is configured for a sweep, both render the real
`SweepReport` counts on success, and both let `E_SCAN_BUSY`/
`E_SCAN_UNAVAILABLE`/`E_NOT_SUPPORTED` surface as the server's own message
through `useAction`'s existing failure toast — no new error-mapping
convention invented. The false doc comment in `devices.ts` is corrected to
name the two real call sites; plan 88's top Status line and 88.6's checklist
bullet are both corrected to stop claiming this was already done, and now
point to 88.12.

**Tests.** `packages/studio/src/lib/network-scan.test.ts` (new, pure
functions), `packages/studio/src/components/settings/FarmNetworksEditor.test.tsx`
(new describe block — disabled-with-reason, a successful scan's real
counts, and `E_SCAN_BUSY`/`E_SCAN_UNAVAILABLE` captured with a distinct,
correct message each via a local `mock.module('sonner', …)`), and
`packages/studio/src/app/page.test.tsx` (new describe block — the fleet
menu item's disabled state, a successful scan's refetch, and both refusal
codes leaving the item back at its idle label). `bun run --cwd packages/studio
test` scoped to those three files: 83 pass / 0 fail. `bash
scripts/typecheck.sh`: OK across every package.

### 96.44 — `ScanNetworkDialog`'s port field is farm-wide, not per-range, even though the owner's own sketch showed one per row. A real, named limitation, not a silent omission. NOT A BUG at the time — logged for visibility. **RESOLVED 2026-08-19 — see the follow-up note at the end of this entry.**

**What the owner asked for.** After seeing §96.43's "disabled item navigates
to Settings" fallback live, the owner asked for a real, self-contained
scan-configuration modal instead (plan 88 §5 step 88.13), sketching the row
shape directly: *"input dinamis untuk range ip dan port: 1. [ip start] -
[ip end] [port]... bisa dinamis gitu."* Read literally, that sketch shows a
port PER ROW.

**What the backend actually has.** `discovery.tcpPort`
(`packages/protocol/src/settings.ts`) is a single farm-wide integer.
`packages/core/src/registry/sweep.ts` has no per-network port field, and
`SweepReport`/`Sweeper.sweep()` take no per-range port argument — the
bounded sweep probes every configured, ticked network on the ONE configured
port. Building a per-row port input in `ScanNetworkDialog.tsx` would have
been exactly the defect class this whole session was hunting: a UI control
that promises something the backend does not deliver (the false "released
or forgotten" claim, the phantom "Scan network" button §96.43 itself just
fixed, the label-vs-number compaction bug — all the same shape).

**What was built instead.** `ScanNetworkDialog.tsx` shows the port field
exactly ONCE, above the range table, editing the real
`discovery.tcpPort` setting — and states the limitation in its own copy,
plainly, rather than letting an operator infer it from an absent column:
*"One port for every range — a device listens for adb on its own local
network stack, so this applies farm-wide. Per-range ports are not supported
yet."* `FarmNetworksEditor.tsx` (Settings → Discovery & monitoring) does not
duplicate this control — `discovery.tcpPort` is already editable one
component up on the same Settings page via the generic schema form, so a
second port input there would be two controls for one setting on one
screen, not a fix for anything.

**Disposition.** Not treated as a defect to silently work around (a fake
per-row field that only writes into the single farm-wide value, discarding
N-1 of the operator's own inputs, would have been worse than the plain
single field this shipped with). Left as an open, named gap — a genuine
per-range port would need `discovery.networks[]` itself to carry a port
per row, `sweep.ts`'s probe loop to read it per network, and `SweepReport`
to report per-range results, none of which this step's own scope permitted
touching (plan 88 §5 step 88.13's own constraint: `discovery.networks[]`
and the sweep's address enumeration/cost-ceiling math stay CIDR-native and
unchanged). See plan 88 §5 step 88.13 and §9 for the fuller account; a
future plan is where a real per-range port would land, if the owner asks
for it once they see this modal.

**RESOLVED, 2026-08-19 — the same day, once the owner actually saw the
modal.** The "future plan, if asked" framing above did not last a day: the
owner asked, and the three touch points this entry named turned out to be
exactly right and genuinely contained, not a re-architecture. Built in full:
`discovery.networks[].port` (`packages/protocol/src/settings.ts`, an
optional integer with the same 1024–65535 bounds as `discovery.tcpPort`,
absent meaning "inherit the farm default" — the same convention this file's
own `video` fields already established for a per-device override);
`packages/core/src/registry/sweep.ts`'s probe loop reads `net.port ??
cfg.tcpPort` instead of always `cfg.tcpPort`; `SweepReportSchema.networks[]`
gained its own `port` field so a `Swept ...` summary and the raw report both
name which port was actually probed per range, not just farm-wide.
`packages/studio/src/lib/ip-range.ts`'s `NetworkCidrRow`/`RangeRow` carry
`port` losslessly through `networksToRanges`/`rangeRowsToNetworks` (new
round-trip tests: create with an override, edit it, remove it, and confirm
it never bleeds into an adjacent or unrelated row); `RangeNetworksFields.tsx`
gained a Port column (shared by both `FarmNetworksEditor.tsx` and
`ScanNetworkDialog.tsx`, per this file's own "one implementation, not two
vocabularies" precedent already governing that component), with the live
farm default shown as each blank cell's placeholder so an operator can tell
an inherited port from an overridden one at a glance. `ScanNetworkDialog.tsx`'s
false "Per-range ports are not supported yet" copy is corrected to describe
the field as the farm default and fallback. See plan 88's own top status
line (the "88.13 follow-up" paragraph) and §9 Q7 (now marked resolved, not
open) for the full account, including the second bug fixed in the same
pass (a dialog-overflow regression this new column would otherwise have
made worse).

### 96.45 — `createSweeper` was fully built and unit-tested, but `daemon.ts` never constructed or wired it in: `POST /api/devices/scan` and the reconnect ladder's sweep fallback both failed/no-opped on the real running server despite every unit test passing

**Found while fixing an unrelated Studio bug (§96.44), the same discovery
path §96.16 named for the action recorder** — a textbook instance of this
whole session's dominant defect class ("correct code, unreachable
production call site"), and by count the largest one yet: this single gap
broke TWO independent surfaces at once. `grep -n "createSweeper"
packages/core/src -r --include='*.ts'` found the function defined only in
`packages/core/src/registry/sweep.ts` — zero production call sites anywhere
in `daemon.ts`. Two consequences, both silent on a real boot:

1. `POST /api/devices/scan` (plan 88 §3.5/§4.5/§4.6, `api/devices.ts` ~line
   537) always threw `E_NOT_SUPPORTED` — `createDeviceRoutes({...})`'s
   optional `sweeper` key was simply never passed at its one production call
   site (`daemon.ts`, `deviceRoutes: createDeviceRoutes({...})`). This is
   the backend for §96.43's "Scan network" fleet-menu item and §96.44's
   `ScanNetworkDialog` "Scan all" button, both shipped and, by every
   account on record, believed working — **the entire "Scan network"
   feature (button, modal, IP-range editor, per-range port) was
   non-functional on a real server the moment an operator actually clicked
   it**, despite `network-scan.test.ts`, `FarmNetworksEditor.test.tsx`, and
   `page.test.tsx`'s new describe block all passing, because none of those
   tests go through `daemon.ts` — they exercise the route/hook layer
   directly, against a hand-built `sweeper` stub.
2. `registry/reconnect.ts`'s reconnect ladder (plan 88 §3.3/§4.4) has its
   own optional `sweeper` dependency, gating step 4 (`opts.allowSweep`) —
   also never passed. `daemon.ts`'s own comment at the ladder's construction
   site said so explicitly: *"Only the ladder through remembered addresses
   (step 88.2's own deliverable): no sweep branch yet (step 88.3's), so an
   exhausted ladder always reports `not-found` rather than ever scanning a
   subnet."* Plan 88's own top status line nonetheless listed 88.3 under
   "Implemented and test-green" and 88.2 as "now including the sweep branch
   88.3 added" — true only for `sweep.ts`'s own unit tests
   (`registry/sweep.test.ts`), not for either production path that was
   supposed to reach it. That status line is corrected alongside this entry.

**The fix.** One `Sweeper` is constructed in `daemon.ts` via `createSweeper`,
right before the reconnect ladder (same scope, same moment as `reconnector`
— both need the exact same instance, not two independent sweepers racing
two singleton mutexes), reading `settingsStore.get().discovery` directly for
`SweeperSettings` (a structural subset, so nothing here re-lists field names
and risks drifting from `packages/protocol/src/settings.ts`'s schema).
Threading it into the two broken paths needed two different techniques,
because `createDeviceRoutes` is called (`daemon.ts`, `deviceRoutes:
createDeviceRoutes({...})`) long before the adb subsystem — and therefore
this sweeper — exists in boot order, the identical ordering problem
`agentProvisionerRef`/`labellingRef`/`preparationRunnerRef` already solve
elsewhere in this file:

- `createDeviceReconnector({..., sweeper})` — passed directly. Both are
  built in the same later-boot scope, so no forward-ref is needed here;
  this alone closes gap 2 (the ladder's `allowSweep` step).
- `createDeviceRoutes({..., sweeper: { sweep: (opts) => sweeperRef?.sweep(opts)
  ?? Promise.reject(new EnkakuError('E_NOT_SUPPORTED', ...)) }})` — a
  forward-ref closure over a new `let sweeperRef: Sweeper | null = null`
  (declared beside `reconnector`, assigned once the real sweeper is built,
  cleared in `stop()`). `DeviceRoutesDeps.sweeper` is declared as a plain
  value (`{ sweep(...): Promise<SweepReport> }`), not an accessor function
  like `connection.reconnector`/`rescan`, so the forward-ref has to live
  inside the wrapper's own `sweep` method — the same shape
  `agentProvisionerRef`'s `ensure`/`status`/`remove` wrappers already use a
  few hundred lines above for an identical "field wants a value, subsystem
  exists later" mismatch. This closes gap 1: orchestrator mode and "adb not
  ready yet" both still resolve `sweeperRef` to `null` and reject with the
  exact `E_NOT_SUPPORTED` message the route used to throw for a missing
  dep — `POST /scan`'s own `if (!deps.sweeper)` guard is now dead in
  production (kept for the unit tests that build `createDeviceRoutes`
  directly without this wrapper).

**Verification.** `bash scripts/typecheck.sh`: every package OK. `bun test
packages/core/src/daemon-wiring.test.ts packages/core/src/registry/sweep.test.ts
packages/core/src/registry/reconnect.test.ts`: 127 pass / 0 fail (includes a
new "the bounded subnet sweep" describe block in `daemon-wiring.test.ts`,
this repo's established house style for this exact defect class — it reads
`daemon.ts`'s own source text and asserts the real construction, the
construction ORDER relative to the reconnect ladder, both wiring sites, and
that the stale "no sweep branch yet" comment is gone). `bun run spec:check`:
unchanged, GAP 1 (`plugin_webhooks`, unrelated to this change — see that
table's own history). `bash scripts/check-plan-status.sh`: passes; plan 88's
status line is updated to describe this fix rather than continue the false
"test-green" claim. End-to-end confirmation against the owner's own live
`:7700` dev server (`POST /api/devices/scan` with a real `discovery.networks`
entry) is left to the owner: this pass did not fabricate a network entry to
test against one that was not already configured with intent.

---

### 96.46 — Uploading an APK larger than 128 MB failed with an empty-bodied 413 that reads as 403, because `Bun.serve` was never given a `maxRequestBodySize` and `api/artifacts.ts`'s declared 1 GB cap was dead above Bun's default. FIXED 2026-08-26.

**Reported from the owner's farm, 2026-08-26.** Installing
`com.google.android.googlequicksearchbox_17.52.15.sa.arm64-301797095_minAPI30(arm64-v8a)(nodpi)_apkmirror.com.apk`
(~210 MB) through the APK-install dialog failed. DevTools showed one red row —
`POST /api/artifacts` — and its Response tab said **"Failed to load response
data / No data found for resource with given identifier"**, because there was
no response body to find. The status was read as **403**, which sent the whole
investigation at permissions: roles, `shell.mode`, `transfer.enabled`,
`canUseFiles`, four separate `auth.forbidden` gates. None of them was involved.

**It was 413, and the limit was not one this repo had chosen.**
`packages/core/src/daemon.ts`'s `Bun.serve({ ... })` never set
`maxRequestBodySize`, so Bun's own default of **128 MB** applied. Bun enforces
it in the transport, *before* `fetch` runs — so Hono never sees the request,
no route can refuse it in words, and the client receives a 413 with an empty
body. Reproduced directly against the owner's running core with a 210 MB
multipart POST: `HTTP 413`, zero-length body.

The consequence worth naming: `api/artifacts.ts`'s own
`MAX_UPLOAD_BYTES = 1024 * 1024 * 1024` and both of its checks
(`content-length` pre-flight, then `file.size`) were **unreachable for anything
over 128 MB**. The file read as a 1 GB limit, documented as a 1 GB limit, and
behaved as a 128 MB one. Its tests passed, because they exercise the route
directly and never cross a real socket.

**Fixed.** `MAX_UPLOAD_BYTES` is now exported alongside a new
`MAX_REQUEST_BODY_BYTES` (`MAX_UPLOAD_BYTES + 16 MB`), and `daemon.ts` passes
the latter to `Bun.serve`. The transport cap sits deliberately **above** the
route cap rather than equal to it: the transport cap is a blunt backstop, the
route's check is the one that produces a message an operator can read, and
whenever both could fire the legible one must win. No limit was raised — 1 GB
was always the intended number; it simply was not the number being enforced.

**Guards** (`packages/core/src/api/artifacts.test.ts`, 3 new tests). This is
the "registered but not wired" shape this register has now recorded five times
(96.5, 96.6, 96.9, 96.11, 96.45), and it cannot be observed from inside the
Hono app: by the time a route runs, the request already got past the transport.
So the guard asserts `daemon.ts`'s **source** contains
`maxRequestBodySize: MAX_REQUEST_BODY_BYTES` — the same discipline
`tools/adb-server-control.test.ts` uses for `adb kill-server` — plus that the
transport cap exceeds the route cap, plus that the route cap is still exactly
1 GB so this can never quietly become permissive.

**Two message losses fixed alongside, because they are why this cost a
session rather than a minute:**

1. `InstallBatchDialog.submitBatch` replaced every server error with
   `new Error('Could not create the batch')`, discarding status, code and
   message. It now uses `api()`, which carries the server's own `code` and
   `message` into `useAction`'s toast. Six new tests
   (`InstallBatchDialog.test.tsx`) pin that each of the three hand-written
   `auth.forbidden` sentences reaches the operator verbatim.
2. `describeApiError` (`packages/ui/src/lib/actions.ts`) rewrote **every**
   `auth.forbidden` into "Your role does not allow this — ask an admin." That
   was written for `requirePermission`'s template — a bare permission NAME,
   not a sentence anyone chose — but it also swallowed the hand-written ones,
   and of the four refusals `POST /api/batches` can produce, only one is
   something an admin can grant (the others need `shell.mode` changed,
   `transfer.enabled` turned on, or a different device). The rewrite is now
   scoped to `/^requires the [\w.]+ permission$/`; everything else passes
   through. Four new tests, including that a message-less 403 still gets the
   generic line rather than an empty toast.

`ArtifactPicker.uploadArtifactSource` also now explains a body-less 413 in its
own words, naming the file's real size — "rare" is exactly when a message has
to stand on its own.

**Verification.** `bash scripts/typecheck.sh` clean.
`bun test packages/core/src/api/artifacts.test.ts`: 14 pass / 0 fail.
`bun test src/components/ArtifactPicker.test.tsx src/components/InstallBatchDialog.test.tsx`
(cwd `packages/studio`): 12 pass / 0 fail.
`bun test src/lib/actions.test.ts` (cwd `packages/ui`): 22 pass / 0 fail.

**Not verified, and it matters:** the transport fix lives in the CORE, not in
Studio. It takes effect only when the core binary is rebuilt and restarted —
rebuilding Studio alone changes nothing about this failure. The owner's running
core was deliberately left untouched (its farm reaches devices over OTG and a
restart is not free).

**One leftover.** Diagnosis uploaded a 9-byte `probe.apk`
(`1abe6308-c3ad-47a2-85df-e2a2cdfc78b4`) to the owner's artifact store while
reproducing the multipart path. There is no `DELETE /api/artifacts/:id` route,
so it could not be removed; it is inert and can be ignored.

---

### 96.47 — `tapNorm`/`swipeNorm`/`longPress`/`gesture` were declared on `DeviceApi`, implemented by the executor, and never forwarded by the IPC bridge a script actually calls through. Every recording containing a point tap failed on its first replay. FIXED 2026-08-27.

**Found on hardware, 2026-08-27**, by the first run of a new plugin member
(`plugins/youtube-automation-pack`'s `search-channel`) against a real device.
The call `ctx.device.tapNorm(...)` failed with:

```
ctx.device.tapNorm is not a function
```

after typechecking cleanly, publishing cleanly, and passing `enkaku publish`'s
own verification.

**The device API a script calls is spelled out in three places**, and nothing
made them agree:

1. `packages/sdk/src/types.ts` — `DeviceApi`, what an author's editor checks;
2. `packages/session/src/device-executor.ts` — the `switch` that performs the
   call, with a `case` for each of the four (plan 94 step 94.2);
3. `packages/session/src/runner/child-entry.ts` — the `deviceApi` object the
   script literally holds and forwards over IPC.

All four verbs were in 1 and 2. **None was in 3.** The wire schema
(`runner/ipc.ts`'s `DEVICE_CALL_ARGS`) accepted them too, and both the schema
(`ipc.test.ts`) and the executor (`device-executor.test.ts`) had their own
tests — so every link in the chain was covered EXCEPT the one that was missing.

**This was not a latent defect waiting for someone to try it.**
`packages/sdk/src/define-recording.ts` calls `device.tapNorm(target.pos, ...)`
for every point tap it replays — the exact call plan 94 §3.4 added `tapNorm`
to make possible. So **every recording containing a point tap threw on its
first replay**, in every build since step 94.2 landed.

**Fixed** by forwarding all four from `child-entry.ts`'s `deviceApi`, with the
argument names taken from their schemas (`tapNorm: { pos, holdMs? }`,
`swipeNorm: { from, to, ms }`, `longPress: { target, ms }`,
`gesture: { samples }`).

**Guard** — `packages/session/src/runner/child-entry-surface.test.ts`, 27 tests.
`child-entry.ts` cannot be imported (it runs `process.on(...)` and `send()` at
module scope, being a child-process entry point), so the guard reads its
SOURCE — the same discipline `packages/core/src/tools/adb-server-control.test.ts`
uses for `adb kill-server`, and the one 96.46 used for `Bun.serve`'s
`maxRequestBodySize`. It enumerates `DEVICE_CALL_ARGS` rather than a hand-written
list, so a verb added to the protocol tomorrow joins the test without anyone
remembering to; a verb may only be skipped by being named in an explicit
`NOT_FOR_SCRIPTS` map with its reason, so "missing" has to be a decision rather
than an oversight. A second block asserts each of the four forwards the fields
its schema requires — the subtler drift, and one this exact file has already
suffered: its own comment records `app.launch`'s `url` being declared on the
interface and on the wire and dropped here, so a script asked Chrome to open a
page and the executor received a bare launch. *"A field list spelled out in
three places will drift; this is the one that decides."* A method list drifts
the same way.

**Mutation-tested.** Deleting the `tapNorm` line fails 3 of the 27 tests by
name; restoring it returns them to green.

**Verification.** `bash scripts/typecheck.sh` clean.
`bun test packages/session/src/runner/`: 243 pass / 0 fail.
`child-entry.ts` is on EVERY script's path, so the pack that found the bug was
re-run on real hardware against the patched runner — searched a channel, opened
it, opened its newest video, watched, and closed, all green.
