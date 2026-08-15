# Plan 98 — M63 : The Script Runtime Envelope

> Status: implemented — every step 98.1–98.9 implemented and tested (docs closed 2026-08-13, step
> 98.9). One item remains genuinely open, recorded rather than hidden: step 98.8's own gap —
> `POST /api/jobs`/`POST /api/batches` do not yet accept a `runtimeOverride` field, so Studio's Run
> form validates and sends an override that the core silently strips today (`EnqueueBody` is a
> plain, non-`.strict()` `z.object`) — the per-job override layer is fully real and tested at
> `JobService`'s own boundary but not yet reachable by an operator on a live farm. Two manual
> hardware smoke checks named in this plan's own §7 (an over-ceiling override refusing with 400;
> a `maxConcurrent: 1` fan-out across three devices) are correspondingly still **pending/blocked**
> — see 98.8's own status table below for the exact blocker. Everything else, including the
> `maxConcurrent` SQL-transaction gate itself (proven against 8 real racing OS processes) and the
> memory-kill path (proven end to end against a real spawned child), is implemented, tested, and
> not merely unit-tested — see each step's own paragraph below for its own proof.
>
> 98.1 implemented and tested: `packages/protocol/src/runtime-envelope.ts`
> (`SCRIPT_RUNTIME_MAJOR`/`SCRIPT_RUNTIME_MIN_MAJOR`, `RuntimeEnvelopeSchema`, `resolveRuntime`,
> `unknownRuntimeKeys`, `checkRuntimeMajor`), the `enforcement` hint on `ParamHints`/
> `ParamHintsSchema`, and `job.memory.*` on `JobSettingsSchema` — all re-exported from
> `packages/protocol/src/index.ts`. `bun test packages/protocol` covers it (698 tests, including
> the precedence-and-clamp table for `timeoutMs`/`maxRssBytes` and the unknown-key/never-fatal
> tests).
>
> **98.2 implemented and tested — "measure before limiting," and still NO limit exists anywhere.**
> The `rss` child→parent IPC message (`packages/session/src/runner/ipc.ts`) plus a required
> `init.rssSampleMs` (fixed at 10s in this step — no farm setting reads it yet, since no limit
> exists to make it adaptive); `child-entry.ts` reports `process.memoryUsage.rss()` once
> immediately when a 'full' or 'finish-only' attempt starts (so a job shorter than the sample
> interval still gets a reading) and again every `rssSampleMs`; `job-runner.ts` accumulates the
> MAX sample per attempt into `AttemptOutcome.peakRssBytes`, an `rss` message resets the silence
> timer but deliberately does NOT call `deps.heartbeat` (§4.7), and `JobRunner.execute()` returns
> the max across every attempt including a finish-only re-run's own fresh-process peak. The core
> side: `ExecutorContext.onPeakRss` (`jobs/executor.ts`), called by `executors/script.ts` right
> before the ok/fail branch so a peak lands whether the job succeeded or failed;
> `ExecutorHost.settle` (`jobs/executor-host.ts`) carries it into `JobStore.finish`
> (`queue/job-store.ts`); `jobs.peak_rss_bytes` (nullable integer, migration
> `0045_workable_venus.sql`, generated — never hand-written); `JobInfoSchema.peakRssBytes`
> (`packages/protocol/src/messages/job.ts`) carries it to Studio; the job Summary tab's timing
> card shows "Peak memory" (`packages/studio/src/app/jobs/detail/page.tsx`), formatted with the
> existing `fileSize()`, "not measured for this job" when null.
>
> **Proven end to end, not just unit-tested**: `packages/core/src/jobs/peak-rss.integration.test.ts`
> runs a REAL queued job through the REAL `ExecutorHost` → `createScriptExecutor` →
> `@enkaku/session`'s `JobRunner` with NO isolation override — the default
> `createChildProcessIsolation()`, exactly what a live core uses — which spawns a REAL
> `bun child-entry.ts <bundle>` child process against a REAL SQLite database migrated through the
> REAL generated migration; the settled row's `peakRssBytes` is read back non-null and compared
> against nothing the test shaped itself. `child-entry.test.ts` separately proves the child reports
> a real, positive `process.memoryUsage.rss()` sample over IPC, and that the immediate first sample
> (not the periodic tick) is what makes a fast job get a reading at all. Studio's own test
> (`app/jobs/detail/page.test.tsx`) proves the Summary tab renders the value AND the null case.
>
> **98.3 implemented and tested — the memory limit exists now, and it is the first thing in this
> plan that can kill a job.** `AbortReason` (`packages/session/src/runner/job-runner.ts`) gains
> `'memory'`; `abortErrorCode` maps it to `MEMORY_LIMIT`; `MEMORY_LIMIT` joins `SCRIPT_CODES`
> (`packages/core/src/jobs/failure-class.ts`) so it classifies `script`/`blameDevice: false`
> unconditionally, asserted rather than left to the default. `runAttempt` now resolves a per-attempt
> memory ceiling via `resolveRuntime({ farm: settings, script: null, override: null })` — `script`/
> `override` stay `null` until steps 98.4/98.7 persist those layers, so today this resolves to
> exactly `job.memory.defaultMaxRssBytes` clamped by `job.memory.maxRssBytes`, and the SAME line
> gains real values with no other change once those steps land. Every `rss` sample is checked
> against it (`checkMemoryBreach`): under `enforce: 'kill'`, one `warn` at 80% of the limit (once
> per attempt), then `doAbort('memory', …)` the moment a sample reaches it; under `doAbort`, the
> `'memory'` reason skips the `abort` IPC message and the `FINISH_GRACE_MS`/`SIGKILL_DELAY_MS` grace
> path ENTIRELY and SIGKILLs immediately — deliberately harsher than every other abort reason
> (§3.6), because a process already over its declared ceiling cannot be trusted to unwind politely.
> This does not skip `finish()`: the killed attempt's `finishRan` stays false, so `execute()`'s
> existing finish-only re-run (spec §11.2, F15) fires in a genuinely fresh process regardless. Under
> `enforce: 'warn'`, the job is never touched — exactly ONE warning the first time a sample reaches
> the limit, then silence for the rest of the attempt. Under `enforce: 'off'`, nothing is logged and
> nothing is killed; the peak is still recorded either way (98.2's accumulator is unconditional).
> Sampling cadence and the silence watchdog both tighten the moment a ceiling resolves to a real
> number, independent of `enforce` (accurate peak recording benefits even under `'off'`, and costs
> nothing extra): `init.rssSampleMs` becomes `job.memory.sampleIntervalMs` instead of the coarse 10s
> default, and the silence limit becomes `min(30_000, 3 × sampleIntervalMs)` — 750ms at this plan's
> own 256 MB / 250ms test fixture — narrowing (never closing) the one honest gap this design has
> (H2): a script that blocks its own event loop while allocating cannot report a sample at all, so
> the sampler cannot see it; the tightened silence watchdog is what still catches that shape.
> `ctx.error.phase` stays `'timeout'` for a memory kill (checked explicitly), so an existing
> `finish()` branching on `'timeout'` keeps matching. **No farm-wide default ceiling was invented**
> — `job.memory.defaultMaxRssBytes`/`maxRssBytes` stay `null` (98.1's own default); 256 MB appears
> only inside this step's own test fixtures, never as shipped code, per the plan's own H1/§9 Q3
> reasoning that the number belongs to whoever reads the distribution 98.2 now records.
>
> **Proven end to end, not just unit-tested.**
> `packages/core/src/jobs/memory-limit.integration.test.ts` runs the SAME real pipeline
> `peak-rss.integration.test.ts` established (real SQLite via the real migration, the real
> `ExecutorHost` → `createScriptExecutor` → `@enkaku/session`'s real `JobRunner`, default
> `createChildProcessIsolation()`, a REAL `bun child-entry.ts <bundle>` child that allocates and
> `.fill()`s memory across `await`s exactly like the plan's own H2/M3 findings describe) against a
> fixture script under a 256 MB `enforce: 'kill'` limit: the job settles `failed` /
> `failureClass: 'script'` / `errorPhase: 'timeout'`, is killed with a recorded peak between 0.7×
> and 1.5× the ceiling (proving it stopped early, not merely "eventually blamed"), never feeds the
> device health tracker, and — the bar this step's brief set highest — **`finish()` is proven to
> have run in a FRESH OS process, not just "no error was thrown"**: `run()` and `finish()` each
> write a JSON marker file tagged with their own `process.pid` (read back from outside both
> processes), and since `child-entry.ts`'s `finish-only` branch never calls `run()` at all, the two
> recorded pids can only differ if `finish()` genuinely executed in a separate process — the test
> asserts exactly that inequality, not an assumption. A second test proves `enforce: 'warn'`: the
> identical shape of script (same ceiling, same allocation pattern, more iterations so it actually
> finishes) completes successfully and the job log carries **exactly one** warning, counted, not
> merely "at least one". `packages/session/src/runner/job-runner.test.ts` adds the fast,
> deterministic counterpart with a scripted fake child (no real process, no timing dependency):
> no `abort` message is ever sent to a memory-killed attempt, no grace timer fires, the finish-only
> re-run's `init.priorError.code` is `MEMORY_LIMIT`, the 80% warning fires exactly once across many
> samples above it, `enforce: 'warn'`/`'off'` produce exactly one/zero warnings respectively, and
> the silence limit measurably tightens once a ceiling is configured.
>
> **Also landed in this step, outside this plan's own file list, self-detecting-gap style (a
> concurrent worker on plan 99 found the wiring missing while building the workflow executor and
> could not fix it themselves — `executor-host.ts` was this step's file to hold):**
> `ExecutorHostDeps` (`packages/core/src/jobs/executor-host.ts`) gains an optional
> `scriptKind?: (scriptId: string) => ScriptKind` accessor, and `start()`'s executor lookup becomes
> `deps.registry.get(job.scriptId, deps.scriptKind?.(job.scriptId) ?? 'script')` instead of the old
> single-argument `deps.registry.get(job.scriptId)`, which always resolved to the `'script'`
> fallback regardless of a job's real kind. This alone turned plan 99's own guard test,
> `packages/core/src/jobs/executor-kind-dispatch.test.ts`, from red to green — that test builds its
> own `ExecutorHostDeps` directly and does not depend on `daemon.ts`'s wiring, so the matching
> `daemon.ts` line (`scriptKind: (scriptId) => scriptRegistry.get(scriptId)?.kind ?? 'script'`,
> assigned to a different concurrent worker and NOT touched here) is what makes a real boot pass
> `kind` through end to end, but is not needed for this specific guard test to pass.
>
> **98.4 implemented and tested — "the envelope persists," and `resolveRuntime`'s `script` input
> now carries a real value everywhere it is called.** `ScriptDefinition.runtime?: RuntimeEnvelope`
> (`packages/sdk/src/types.ts`); `def.timeout`/`def.retries` stay (marked `@deprecated`, kept
> forever per 00-overview §4.3's own carve-out for a field a published script already used) and
> are folded into `runtime` by a new shared helper, `foldRuntimeEnvelope`
> (`packages/sdk/src/runtime-fold.ts`), called from both `defineScript` (a standalone script) and
> `definePlugin` (once per member — a plugin member never goes through `defineScript` itself, so
> the fold could not simply live there alone). Disagreeing values (`timeout: 30_000` alongside
> `runtime.timeoutMs: 60_000`) throw at author import time, naming both numbers, the same
> reasoning `definePlugin` already applies to a member's `version` diverging from the plugin's own.
> `enkaku publish` sends `def.runtime` verbatim as part of the existing `POST /api/scripts` body
> (`packages/sdk/src/cli/publish.ts`); `PublishBody` (`packages/core/src/scripts/routes.ts`) gains
> a loosely-typed `runtime` field, independently re-validated server-side via
> `RuntimeEnvelopeSchema` (`E_RUNTIME_ENVELOPE_INVALID`, 400, on a shape violation — never trusting
> the SDK's own checks alone) with `unknownRuntimeKeys` reported as one `warn` naming each dropped
> field, never a refusal (§3.3 S3); `scripts.runtime` (nullable JSON, migration `0048_tiny_magus.sql`,
> generated — never hand-written) is the new column, inserted by `publishScript()`
> (`packages/core/src/scripts/service.ts`) and read back through a new `parseScriptRuntime` helper
> in the same file — never an `as`-cast, degrading to `null` on a parse failure exactly like the
> `workflow` field's own precedent. `GET /api/scripts/:id` returns it (`ScriptRowSchema.runtime` in
> `packages/protocol/src/api/scripts.ts`; omitted from the list projection, matching `source`/
> `workflow`). The plugin paths: `verify-child-entry.ts` reads each member's own `runtime`,
> independently re-validates it (`E_RUNTIME_ENVELOPE_INVALID`, naming the member — a hand-crafted
> bundle can carry a `scripts` array that never called `definePlugin` at all, exactly the case
> `checkParamsSchema`'s own re-validation there already exists for), and reports it over IPC;
> `plugins/runtime.ts`'s `writeScriptRows` persists it onto each member's `scripts` row;
> `putDevSlotImpl` carries it into `DevSlotScript.runtime` (`plugins/dev-slots.ts`) — the in-memory
> dev-slot path plan 98 §3.1 names as the one legitimate case where the bundle IS the "row," since
> a dev slot has none. `ScriptRegistry.get`/`.resolve` (`packages/core/src/scripts/registry.ts`)
> now carry `ScriptEntry.runtime` through from both the persisted-row and dev-slot paths — this is
> what makes a node script's declared `timeoutMs` readable by a caller holding only a `scriptId`,
> with no `ready` message and no job ever having run, the exact shape plan 99 §3.11/§3.12/§4.3
> check 7 needs (see that paragraph below). `createScriptExecutor`
> (`packages/core/src/jobs/executors/script.ts`) threads `entry.runtime` into
> `JobRunner.execute()`'s new `JobSpec.runtime?: RuntimeEnvelope | null` field — always passed,
> `null` (never `undefined`) for a script that declared nothing, matching `resolveRuntime`'s own
> "declared nothing" convention. **`execute()`'s `resolveRuntime({ farm: settings, script: null,
> override: null })` call from step 98.3 is now `resolveRuntime({ farm: settings, script:
> job.runtime ?? null, override: null })` — the exact one-line change 98.3's own comment
> predicted, and no other change at that call site** — so a script's own `maxRssBytes` declaration
> now genuinely clamps or replaces the farm default wherever a job carries one.
> `child-entry.ts`'s `BundleDef` gains `runtime?: RuntimeEnvelope`, included in the `ready` message
> exactly when present; `ipc.ts`'s `ready` schema gains `runtime: RuntimeEnvelopeSchema.optional()`.
> **The reconciliation warning**, in `job-runner.ts`'s `ready` handler: a new `runtimeEnvelopesDiffer`
> helper compares `job.runtime` (the DB row this job was pinned to) against `msg.runtime` (what the
> running bundle just reported) field-by-field (never a JSON-string comparison, which would
> false-positive on nothing more than key order); a difference logs exactly one `warn` naming both
> full envelopes, and — this is the trust decision plan 98's own brief for this step calls out by
> name — **the DB row is what actually governs the attempt, never the bundle's own report, in
> BOTH directions**: a bundle cannot raise its own ceiling by claiming a looser one at `ready`, and
> a bundle cannot lower it either, since the operator's published row is the agreed contract.
> Proven with two direction tests in `packages/session/src/runner/job-runner.test.ts` (a scripted
> fake child, no real process): "bundle asks for MORE" — the row declares a 100 MB ceiling, the
> bundle's `ready` claims 900 MB, a 150 MB sample still gets `MEMORY_LIMIT`-killed, because the
> row's number is what `resolveRuntime` actually resolved against; "bundle asks for LESS" — the
> row declares 500 MB, the bundle's `ready` claims 70 MB, a 100 MB sample runs to completion
> unkilled, because the bundle's smaller, self-reported claim never had a say either. A separate,
> single-attempt test (`enforce: 'off'`, no kill in the way) pins "exactly one warning naming both
> values" precisely, without the kill machinery's own warning lines in the way. Backward
> compatibility: `JobSpec.runtime === undefined` (a caller that predates this field) skips the
> comparison entirely rather than warning about something nobody can act on; `null` (a pre-plan-98
> script, or a dev slot that declared nothing) compares cleanly against a bundle reporting nothing
> either, with zero warnings — F5's original defect (a script's first attempt only ever saw the
> farm default) is unaffected by this step for `timeoutMs` specifically: `meta.timeoutMs` still
> arms from the bundle's own `ready.timeoutMs`, exactly as before — this step's job was persistence
> and reconciliation, not the further `runAttempt`/`clampTimeoutMs` refactor §4.8 describes, which
> remains open for whichever step picks it up.
>
> **Downstream unblock, recorded because plan 98's own brief for this step names it explicitly:**
> plan 99 (M64, workflows) §3.11/§3.12/§4.3 check 7 needs a node script's declared `timeout`
> readable at publish time, without waiting for a child's `ready` message at run time. It now is:
> `ScriptRegistry.get(scriptId)?.runtime?.timeoutMs` (or `.resolve(ref)?.runtime?.timeoutMs`)
> answers from the `scripts.runtime` column alone, no job, no device, no child process. This step
> does not wire that value into plan 99's `checkWorkflow`/`ResolvedNodeScript` itself (that is
> 99's own file, `packages/protocol/src/workflow-check.ts`, not touched here) — only confirms the
> column and the read path both exist and are exercised by tests
> (`packages/core/src/scripts/registry.test.ts`'s "runtime" describe block).
>
> **Closed the loop, 2026-08-13, by the plan 99 worker this unblocked** (recorded here per this
> document's own established convention of noting where a forward reference actually landed —
> matching Plan 90's/99's/91's precedent rows in `00-overview.md` §9): `ResolvedNodeScript`
> (`packages/protocol/src/workflow-check.ts`) gained `timeoutMs: number | null`, and plan 99's
> `packages/core/src/api/workflows.ts` populates it via exactly the accessor this paragraph named,
> `entry.runtime?.timeoutMs ?? null`, off `ScriptRegistry.resolve()`'s own `ScriptEntry.runtime`. An
> undeclared timeout reads back `null` and is treated as UNKNOWN by `checkWorkflow` — not folded
> into the farm's `job.defaultTimeoutMs`, and never zero — see plan 99 §3.11/§4.3 check 7's own
> updated status paragraph for the full reasoning and the new `W_WORKFLOW_BUDGET_UNKNOWN` finding
> code that carries it. `E_WORKFLOW_BUDGET_IMPOSSIBLE` now fires for real.
>
> Tests added this step: `packages/sdk/src/define-script.test.ts` (new — the fold/disagreement
> table), `packages/sdk/src/plugin.test.ts` (per-member fold), `packages/core/src/scripts/routes.test.ts`
> (publish → GET round-trip, `E_RUNTIME_ENVELOPE_INVALID`, the unknown-key warning),
> `packages/core/src/scripts/registry.test.ts` (get/resolve carry `runtime` through, including the
> corrupt-column-degrades-to-null case), `packages/core/src/plugins/verify-child.test.ts` and
> `runtime.test.ts` (the plugin publish/dev-slot paths, end to end against a real spawned verify
> child), `packages/session/src/runner/ipc.test.ts` and `child-entry.test.ts` (the wire shape and a
> real spawned child reporting it), `packages/session/src/runner/job-runner.test.ts` (the
> reconciliation warning and both enforcement directions), and
> `packages/core/src/jobs/executors/script.test.ts` (the registry-to-runner handoff).
>
> **98.5 implemented and tested — `jobs.max_concurrent` resolved and pinned at enqueue, and the
> claim's fourth gate.** `jobs.max_concurrent` (nullable integer) plus a supporting
> `idx_jobs_script_running(status, script_name)` index (migration `0049_lovely_angel.sql`, generated —
> never hand-written); recorded in `docs/plans/00-overview.md` §9. Resolved via
> `resolveRuntime({ farm, script: entry.runtime, override: null })` — `override` stays `null` until
> step 98.7 — at every one of the THREE places a `jobs` row is created today:
> `services/job-service.ts`'s `enqueue()` (from `deps.scriptNameOf(scriptId)?.runtime`, a widened
> return type on the SAME accessor `daemon.ts` already wires for `scriptName`/`scriptVersion` —
> `scriptRegistry.get(scriptId)` already returns the full `ScriptEntry`, `runtime` included, so no
> `daemon.ts` edit was needed) and `resume()` (re-resolved from the ORIGINAL job's own pinned
> `scriptId`, so a resumed job of a capped script stays capped); `jobs/triggers.ts`'s `trigger()`
> (from the SAME `ScriptRegistry.resolve()` entry it already held, no second lookup). `maxConcurrent`
> has no farm layer or ceiling at all (`resolveRuntime`'s own doc comment) — proven, not merely
> asserted, by a dedicated test showing an unusual `farmJobSettings` object changes nothing — so a
> `farmJobSettings` getter is threaded through for shape-consistency with the fields that DO have one,
> but an omitted one (any caller built before this step, including every hand-written test fake)
> resolves identically via a `JobSettingsSchema.parse({})` default. **`daemon.ts` was not touched** —
> both properties above (the `scriptNameOf` widening and the farm-independence) made the wiring
> genuinely unnecessary rather than merely deferred; see this step's own report for the reasoning in
> full, since the brief's own instruction was to touch it only if unavoidable and to prove the gap
> otherwise.
>
> The claim (`queue/job-store.ts`'s `claimNext`): one clause added inside the same `BEGIN IMMEDIATE`
> transaction, immediately after the existing batch gate and in its identical style — a correlated
> `SELECT COUNT(*) FROM jobs r WHERE r.script_name = j.script_name AND r.status = 'running') <
> j.max_concurrent`, `OR`ed with `max_concurrent IS NULL OR max_concurrent = 0`. **Property 1 (no
> device famine)**: the clause narrows only the capped job's OWN eligibility inside the `WHERE` of a
> `LIMIT 1` `SELECT` — a blocked job is skipped, the next eligible one (any other script, any other
> device) is claimed, exactly the batch gate's own precedent. Proven by a test matching the plan's own
> verifiable-result wording verbatim: three jobs of a `maxConcurrent: 1` script on three idle devices
> → one `running`, two `queued`, and the freed devices immediately claim a DIFFERENT script's job.
> **Property 2 (enforced in SQL, not TypeScript)**: proven twice — a same-process sequential test
> against the clause's own semantics, and a GENUINELY parallel test
> (`queue/job-store.test.ts`'s "a real multi-process race" + the new `queue/claim-race-worker.ts`)
> spawning 8 real, separate OS PROCESSES via `Bun.spawn` (not sequential calls dressed up as
> parallel — a single Bun process cannot race its own synchronous `claimNext`), each opening its OWN
> `bun:sqlite` connection to the SAME on-disk database file and hammering `claimNext` 25 times each
> with no coordination. **Verified as meaningful, not vacuous**: both the sequential and the
> multi-process tests were run once against the SQL clause deliberately disabled (`AND (1 = 1)`) —
> the multi-process race admitted 8 of 8 jobs instead of 1, proving the harness genuinely detects
> over-admission — then the clause was restored and every test re-run green.
>
> Tests added this step: `packages/core/src/queue/job-store.test.ts` (the claim gate — six tests:
> the verifiable result, freeing the slot, `maxConcurrent=0`, `maxConcurrent=NULL`, keyed on
> `script_name` not `script_id`, and the multi-process race) plus the new, non-test companion script
> `packages/core/src/queue/claim-race-worker.ts`; `packages/core/src/services/job-service.test.ts`
> (five tests — enqueue and resume resolution, the no-`scriptNameOf`-wired default, and the
> farm-independence proof); `packages/core/src/jobs/triggers.test.ts` (three tests, against the REAL
> `ScriptRegistry`, not a mock). A ripple from the new NOT-NULL-shaped `JobRow.maxConcurrent` key
> (nullable value, but every Drizzle `$inferSelect` column is a required KEY) was fixed at every
> literal `JobRow` fixture the typechecker found across the tree, including `clusters/dispatch.ts`
> itself — see this plan's `00-overview.md` §9 row for the one gap left there, named rather than
> silently patched over: batch-dispatched jobs do not yet carry a resolved cap, because `createBatch`
> has no `ScriptRegistry` in its dependency graph at all (a pre-existing, deliberate omission, not
> something this step's file list authorised changing).
>
> **Addendum, 2026-08-13 — the batch-dispatch gap above is now closed.**
> `clusters/dispatch.ts`'s `BatchDispatchDeps` gained an optional
> `scriptNameOf`/`farmJobSettings` pair, the same accessor shape
> `services/job-service.ts`'s own `enqueue()`/`resume()` already use;
> `createBatch` resolves `scriptName`/`scriptVersion`/`maxConcurrent` ONCE
> per batch (every member shares one `scriptId`) via the same
> `resolveRuntime` call, duplicated rather than imported (`job-service.ts`
> keeps it module-private) but not a second algorithm — both call sites do
> nothing but forward into `@enkaku/protocol`'s `resolveRuntime`, the one
> place `maxConcurrent`'s precedence lives. `api/batches.ts` wires it by
> reusing the `scriptRegistry` dependency already threaded there for
> `rerun-failed`'s params-schema lookup. Closing `scriptName` alongside
> `maxConcurrent` turned out to be required, not optional: `claimNext`'s
> gate correlates running siblings with `r.script_name = j.script_name`,
> and SQL's `=` never matches `NULL = NULL` — writing a correct
> `maxConcurrent` while leaving `scriptName` null would have resolved the
> cap and then had the claim gate silently ignore it. Full writeup:
> `docs/plans/96-m61-hotfixes.md` §96.14.
>
> **98.6 implemented and tested — the version gate wired into enqueue.** `SCRIPT_RUNTIME_MAJOR`/
> `SCRIPT_RUNTIME_MIN_MAJOR`/`checkRuntimeMajor` already existed (step 98.1); this step is the
> wiring, at every write path onto `jobs` this plan's own file list reaches: `services/job-service.ts`'s
> `enqueue()` (checked against `scriptNameOf(...).runtime?.sdk`, before params validation and before
> any device is claimed — F4's reasoning applied to a new gate) and `resume()` (re-checked against
> the ORIGINAL job's own pinned script, since a resume creates a genuinely new job and the core may
> have been downgraded since); `jobs/triggers.ts`'s `trigger()` (checked against the SAME
> `ScriptRegistry` entry it already resolved, no second lookup — the third write path onto `jobs`).
> A refusal throws `E_RUNTIME_UNSUPPORTED`, naming the declared major and the supported range
> (`checkRuntimeMajor`'s own message); `packages/core/src/api/jobs.ts`'s `ERROR_STATUS` maps it (and
> `E_RUNTIME_ENVELOPE_INVALID`/`E_RUNTIME_OVER_CEILING`, step 98.7's own codes) to 400 — the one
> small, additive edit made outside this step's own file list, because leaving it unmapped would
> have made a genuine client error read back as a 500. **The property this plan's own brief calls
> out — a farm mid-upgrade never runs nothing** — holds because the gate is symmetric with every
> other refusal in this plan: `undefined` (every script published before this plan) never refuses,
> only an SDK major genuinely outside `[MIN, CURRENT]` does, and only the ONE script that declares
> it, never the farm. `validate-script.ts` (§4.5's original proposal) was deliberately NOT used —
> `clusters/dispatch.ts`'s batch dispatch has no `ScriptRegistry` in its dependency graph at all
> (98.5's own documented gap) and would not have reached it either way, so routing through the
> shared validator would have been a false sense of coverage; batch/schedule dispatch is left as
> the SAME documented, deliberate gap 98.5 already recorded for `maxConcurrent`, not a new one.
>
> **The S2 anti-rot guard**, modelled directly on plan 90's own `appVersion` precedent
> (`packages/drivers/src/network/guest-agent/version-skew-guard.test.ts`):
> `packages/core/src/jobs/runtime-sdk-comparison-guard.test.ts` walks every non-test `.ts` file
> under `packages/core/src` and `packages/session/src` (acceptance criterion 13's own wording) for a
> relational/equality operator or a string/semver-comparison method touching `.sdk` — the ONE
> sanctioned comparison, `checkRuntimeMajor`'s own range check, lives in `packages/protocol`,
> deliberately outside the walked scope. Two sanity tests prove the guard is not vacuous: one feeds
> it five genuinely offending lines and asserts each is caught; the other feeds it the REAL
> pass-through shapes this step's own wiring uses (`checkRuntimeMajor(entry.runtime?.sdk)`) plus the
> two unrelated `sdk` usages already in the tree that a naive bare-word pattern would have
> false-positived on — Android's own `ro.build.version.sdk` (`session/probe.ts`) and the `'sdk'`
> input-mode string literal (`session/types.ts`/`session.ts`) — and asserts none of them trip it.
>
> Tests added this step: `packages/core/src/jobs/runtime-sdk-comparison-guard.test.ts` (new — the S2
> guard, 3 tests); `packages/core/src/services/job-service.test.ts`'s new "the version gate" describe
> block (4 tests — refusal naming the major, an absent `runtime.sdk` unaffected, no `scriptNameOf`
> wired unaffected, and `resume()` re-checking); `packages/core/src/jobs/triggers.test.ts`'s new "the
> version gate" describe block (3 tests, against the REAL `ScriptRegistry`).
>
> **Audited 2026-08-13 (a separate worker, steps 98.6/98.7 only — this paragraph and 98.7's own
> "Audited" paragraph below are that audit's record).** Every claim above was independently re-verified
> against the tree rather than trusted: `bun test` on each file named above is green
> (`runtime-envelope.test.ts` 46/46, `job-service.test.ts` 48/48, `triggers.test.ts`/`job-store.test.ts`/
> `runtime-sdk-comparison-guard.test.ts`/`executors/script.test.ts` 76/76 combined), every test-count
> claimed in a "Tests added this step" line was counted against the actual `describe`/`test` blocks and
> matched exactly, `bunx drizzle-kit generate` reports "No schema changes, nothing to migrate" against
> `0050_narrow_champions.sql` (step 98.7's migration — confirming it is well-formed and generated, not
> hand-written), and the version-gate/farm-ceiling-wins properties are proven at the real `JobService
> .enqueue()`/`JobRunner.execute()` surfaces, never merely at `resolveRuntime` (`job-service.test.ts`'s
> "the version gate" describe block asserts `jobStore.enqueue` is never CALLED on a refusal, not just
> that an error is thrown; `job-runner.test.ts`'s "the per-job override" describe block asserts a real
> `runner.execute()` run is killed at the farm's ceiling — 200 MB — and not at the override's own
> (higher, fictitious) 900 MB ask).
>
> **One finding from that audit: this step's own reasoning above was stale in one place, and a real
> gap followed from the staleness — CLOSED, 2026-08-13, same audit.** The paragraph above states
> routing the version gate through a shared validator was skipped because "`clusters/dispatch.ts`'s
> batch dispatch has no `ScriptRegistry` in its dependency graph at all... so routing through the
> shared validator would have been a false sense of coverage." That was true when this paragraph was
> written, but the very next section of this document (98.5's own "Addendum, 2026-08-13 — the
> batch-dispatch gap above is now closed") records that `clusters/dispatch.ts`'s `BatchDispatchDeps`
> gained an optional `scriptNameOf` afterward, so `createBatch` resolves `named =
> deps.scriptNameOf?.(input.scriptId)` and reads `named?.runtime` on the very next line to resolve
> `maxConcurrent` — the identical `named` local every other write path (`job-service.ts`'s
> `enqueue()`/`resume()`, `triggers.ts`'s `trigger()`) feeds straight into `checkRuntimeMajor` the
> instant it resolves. `clusters/dispatch.ts` never did — confirmed by grep before the fix
> (`checkRuntimeMajor`/`E_RUNTIME_UNSUPPORTED` appeared nowhere in that file) and by a new test,
> `packages/core/src/jobs/batch-dispatch-version-gate.test.ts`, which dispatched a batch of a script
> declaring `runtime.sdk: 99` and asserted a refusal + zero job rows — it failed on first write
> (`caught` was `undefined`, every member job was created), proving the gap was real rather than
> theoretical, before the fix below landed and turned it green.
>
> **Ownership note, because the fix landed in a file this step's own file list originally excluded:**
> `clusters/dispatch.ts`/`dispatch.test.ts`/`api/batches.ts` were a concurrent worker's exclusive files
> when this audit began; that worker finished and the coordinator reassigned those files to this audit
> mid-task, specifically because this exact gap needed a fix in them. The change actually made
> (`clusters/dispatch.ts`, immediately after `const named = deps.scriptNameOf?.(input.scriptId) ?? null`,
> before `resolveBatchMemberMaxConcurrent`):
>
> ```ts
> import { checkRuntimeMajor, JobSettingsSchema, resolveRuntime } from '@enkaku/protocol' // checkRuntimeMajor added
> // ...
> const versionCheck = checkRuntimeMajor(named?.runtime?.sdk)
> if (versionCheck) throw new EnkakuError(versionCheck.code, versionCheck.message)
> ```
>
> `bash scripts/typecheck.sh` unaffected (still exactly the one pre-existing, unrelated
> `JobNodesResponseSchema` failure); `bun test packages/core/src/jobs/batch-dispatch-version-gate.test.ts
> packages/core/src/clusters` → 49/49; `bun test packages/core/src/api/batches.test.ts` → 12/12
> (no regression on the two already-fixed `maxConcurrent` call sites).
>
> **A SECOND, genuinely still-open gap surfaced while checking whether this fix had a hidden dependency
> of its own** — the coordinator's own instruction, prompted by the identical shape 96.14 hit for
> `maxConcurrent`/`scriptName`. It does: `packages/core/src/schedules/runner.ts`'s `fireOnce` — the
> function a firing SCHEDULE calls to dispatch its batch (`api/schedules.ts`'s own comment: a schedule
> "triggers a **batch** ... never a bare job") — builds its OWN `batchDeps: BatchDispatchDeps` literal
> with only `db`/`scheduler`/`audit`/`onJobStatus`/`validateScript`, never `scriptNameOf`. 96.14 wired
> `scriptNameOf` into `api/batches.ts`'s two `createBatch(...)` call sites only; this THIRD call site
> was never touched by that fix or by this one, even though `daemon.ts:1286` already wires a real
> `ScriptRegistry` onto `ScheduleRunnerDeps.registry` — used two lines later in the SAME function
> (`resolved = deps.registry.resolve(parsedRef.data)`) — so the data needed is already in hand and
> simply never reaches `batchDeps`. The consequence is the SAME pair of symptoms 96.14 closed
> everywhere else, reopened for exactly this one path: a schedule firing a script that declares an
> unsupported `runtime.sdk` still dispatches (never refused), and its member jobs still write
> `maxConcurrent: 0`/`scriptName: null` regardless of what the script declares. `packages/core/src/schedules/runner.ts`
> is outside every file list this audit was ever assigned, including the `clusters/**`/`api/batches.ts`
> reassignment, so — per this plan's own "make the gap self-detecting" instruction — it is reported and
> pinned rather than edited: `packages/core/src/jobs/scheduled-batch-version-gate.test.ts` calls the
> REAL, exported `fireOnce` against a real DB and a real `ScriptRegistry` (the exact `daemon.ts` wiring
> shape — `registry` IS supplied), seeds a schedule targeting a script declaring `runtime.sdk: 99`, and
> asserts the `scheduleRuns` row reads `outcome: 'error'` naming `E_RUNTIME_UNSUPPORTED` with zero job
> rows created. It fails today (`outcome` reads `'dispatched'`, a job row exists). THE FIX, verbatim
> (`packages/core/src/schedules/runner.ts`, inside the `batchDeps: BatchDispatchDeps = { ... }` literal
> `fireOnce` already builds, a few lines before its `createBatch(batchDeps, ...)` call):
>
> ```ts
> const batchDeps: BatchDispatchDeps = {
>   db: deps.db,
>   scheduler: deps.scheduler,
>   audit: deps.audit,
>   onJobStatus: deps.onJobStatus,
>   ...(deps.validateScript ? { validateScript: deps.validateScript } : {}),
>   ...(deps.registry ? { scriptNameOf: (scriptId: string) => deps.registry!.get(scriptId) } : {}),
> }
> ```
>
> — the identical `(scriptId) => deps.scriptRegistry?.get(scriptId) ?? null` shape `api/batches.ts`
> already uses at both of its own call sites, adapted to this file's own `registry` field name.
> `farmJobSettings` has no equivalent source on `ScheduleRunnerDeps` at all today; leaving it unwired is
> not a new gap — it resolves exactly like every other unwired `farmJobSettings` already does ("no
> ceiling", never a refusal an operator did not configure) — so only `scriptNameOf` is required to close
> this finding. No `ERROR_STATUS` change is needed either way — 98.6 already mapped
> `E_RUNTIME_UNSUPPORTED` to 400, and `fireOnce`'s own `catch` block already turns any thrown
> `EnkakuError` into a named `scheduleRuns.outcome: 'error'` row rather than letting it escape uncaught.
>
> **98.7 implemented and tested — the per-job override.** `jobs.runtime_override` (nullable JSON,
> migration `0050_narrow_champions.sql`, generated — never hand-written; recorded in
> `docs/plans/00-overview.md` §9 — see this report's own relay text for the exact row, since that
> file is held by the documentation worker). `JobService.enqueue()`'s new `runtimeOverride?: unknown`
> input is Zod-validated against `RuntimeEnvelopeSchema` (`E_RUNTIME_ENVELOPE_INVALID` on a shape
> violation — the SAME two-stage discipline `scripts/routes.ts`'s publish route already applies to
> `scripts.runtime`, since §3.1's own doc comment states the identical schema serves both layers),
> unknown keys stripped and warned rather than refused (§3.3 S3 applies here too), then resolved
> ALONGSIDE `maxConcurrent` through the ONE `resolveRuntime` call `resolveJobRuntime` wraps — a
> clamp attributed to the override (`RuntimeClamp.from === 'override'`) refuses outright with
> `E_RUNTIME_OVER_CEILING`, naming every offending field's requested value and the ceiling it
> exceeded, never merely clamped: **the farm ceiling still wins over the override** — proven by a
> dedicated test pairing an under-ceiling script declaration with an over-ceiling override and
> asserting the refusal still fires — which is the property this plan's own brief named as the one
> that would make the whole gate advisory if it did not hold. `resume()` carries the ORIGINAL job's
> own override FORWARD (an operator's instruction was for the whole pipeline, not just its first
> attempt), re-checked against whatever the farm ceiling is NOW, not what it was at the original
> enqueue — refusing if a farm that tightened its ceiling since would now refuse the same override
> fresh, never silently re-clamping a human's own typed number.
>
> **`resolveRuntime`'s `override` argument carries a real value for the first time**, closing the
> gap step 98.3's own comment at its call site predicted: `packages/session/src/runner/job-runner.ts`
> gains `JobSpec.runtimeOverride?: RuntimeEnvelope | null`, and `execute()`'s memory-ceiling
> `resolveRuntime({ farm: settings, script: job.runtime ?? null, override: null })` call is now
> `override: job.runtimeOverride ?? null` — the EXACT one-line change 98.3's and 98.4's own comments
> named, and no other line at that call site moved. `packages/core/src/jobs/executors/script.ts`
> threads it through via a new `parseJobRuntimeOverride` helper (`queue/job-store.ts`, exported,
> shared with `resume()`'s own forward-carry) — the same defensive, never-`as`-cast, degrade-to-null
> discipline `scripts/routes.ts`'s `parseScriptRuntime` already established for `scripts.runtime`.
> **The origin (script / farm / override / clamped), recorded in the job's own log**, this step's
> own brief's exact wording: a clamp — from EITHER a script's declaration or an override, `from`
> distinguishes them — logs one `warn` naming both numbers and the source, extending
> `clampTimeoutMs`'s existing "never silent" precedent to `maxRssBytes`, which `resolveRuntime` has
> always computed a clamp for but nothing consumed until this step; an override actually in effect
> (no clamp) logs one `info` line naming the resolved value and `(origin: override)` — the new thing
> this step introduces. A plain script-or-farm resolution, unchanged since before this step, stays
> silent, matching `clampTimeoutMs`'s own "only log what changed" philosophy — proven by a dedicated
> test asserting NO origin line and NO clamp line when no override is present at all.
>
> **What this step deliberately did NOT touch, and why, named rather than silently skipped:** the
> per-attempt `timeoutMs` this runner arms BEFORE a `ready` message arrives still comes from
> `meta.timeoutMs` (learned from a PRIOR attempt's `ready`) or the farm default only — never from
> `resolveRuntime`'s own resolved `timeoutMs` — exactly the gap step 98.4's own status paragraph
> named as open ("the further `runAttempt`/`clampTimeoutMs` refactor §4.8 describes... remains open
> for whichever step picks it up"). This step's own brief was explicit that the memory
> `resolveRuntime` call is "the surrounding line should need no other change", so
> `runtimeOverride.timeoutMs` is fully validated, ceiling-checked, and persisted — and DOES drive
> the `E_RUNTIME_OVER_CEILING` refusal at enqueue, which needs no runner involvement — but does not
> yet shorten or lengthen a job's first attempt the way `runtimeOverride.maxRssBytes` now genuinely
> does. Recorded
> here, explicitly, rather than silently narrowed: whichever step eventually does the §4.8 refactor
> inherits an `override` that is already real for every field `resolveRuntime` resolves, `timeoutMs`
> included — nothing about THAT refactor is blocked by this step.
>
> Also touched, minimally: `packages/core/src/api/jobs.ts`'s `ERROR_STATUS` map (three new entries,
> named in 98.6's own paragraph above) — the only file this step touched outside its own file list,
> chosen over leaving a real 400-shaped refusal reading back as a 500. The REST route's own
> `EnqueueBody`/`POST /api/jobs` body does NOT yet accept a `runtimeOverride` field (nor does the WS
> `job.enqueue` message, `packages/protocol/src/messages/job.ts` — left untouched, a contested file
> a second, uncoordinated session has already written a duplicate export into), so the layer this
> step ships is fully real and tested at `JobService`'s own boundary, exactly like 98.5's own
> `maxConcurrent` resolution was, but not yet reachable by an operator through Studio's Run form —
> that wiring, plus the Studio Runtime card's origin labels, is step 98.8's own job, named in its own
> plan text already.
>
> Tests added this step: `packages/session/src/runner/job-runner.test.ts`'s new "the per-job
> override" describe block (5 tests — override-wins-over-script, farm-ceiling-still-wins-clamped,
> the override origin line, silence with no override, and the script-clamp extension);
> `packages/core/src/services/job-service.test.ts`'s new "the per-job override" describe block (11
> tests — pinned verbatim, defaults to null, both ceiling refusals naming both numbers, the
> script-declaration/override distinction, the farm-ceiling-still-wins pairing, shape-invalid,
> unknown-key-warned, and `resume()`'s forward-carry plus its own re-refusal);
> `packages/core/src/jobs/executors/script.test.ts`'s new describe block (3 tests — threaded through
> unchanged, `null` default, corrupt-value-degrades-to-null); `packages/core/src/queue/job-store.test.ts`'s
> new "enqueue — runtimeOverride" and "parseJobRuntimeOverride" describe blocks (6 tests).
>
> **A ripple into a file outside this step's own list, self-detecting-gap style, exactly as this
> plan's own brief anticipated.** `jobs.runtime_override` is a new column on the Drizzle-inferred
> `JobRow` type, and every Drizzle `$inferSelect` column is a REQUIRED key on a hand-built literal
> regardless of its own nullability (98.5's own precedent, the identical ripple `jobs.max_concurrent`
> caused). Every literal `JobRow` fixture this ripple reaches inside this step's own file list was
> fixed (`jobs/executors/workflow-settings-wiring.test.ts`, `jobs/executors/workflow.test.ts`,
> `jobs/executor-kind-dispatch.test.ts`, `jobs/executor-host.test.ts`, `services/job-service.test.ts`
> — one `runtimeOverride: null,` line each) — but TWO literals live in `packages/core/src/clusters/`,
> a concurrent worker's exclusive file per this step's own brief, and were deliberately left broken
> rather than edited: `clusters/dispatch.ts:196` (right after `maxConcurrent: input.maxConcurrent,`)
> and `clusters/dispatch.test.ts:231` (right after `maxConcurrent: null,`) each need exactly one line,
> `runtimeOverride: null,`, added immediately after that line. `bash scripts/typecheck.sh` names both
> locations by file and line; this paragraph is the verbatim fix.
>
> **Closed — confirmed by the 2026-08-13 audit (98.6's own audit paragraph above).** Both lines are
> present in the tree today (`clusters/dispatch.ts:202`, `clusters/dispatch.test.ts:234`, each carrying
> a `runtimeOverride: null,` with its own doc comment referencing this step) and `bash scripts/typecheck.sh`
> reports exactly the one pre-existing, unrelated `JobNodesResponseSchema` failure this plan does not
> own — no `JobRow` literal ripple remains anywhere in the tree. This is a *different* gap from the
> version-gate one 98.6's own audit paragraph records: that ripple was a missing struct field (a
> typecheck error, self-announcing); the version gate's absence from `createBatch` is a missing runtime
> CHECK, which compiles cleanly and stays silent until a test asks for it — which is why it needed a
> dedicated test (`jobs/batch-dispatch-version-gate.test.ts`) rather than a typecheck pass to surface.
>
> **98.8 implemented and tested — Studio.** The four surfaces named in this step's own brief, all
> schema-driven, zero new control components registered (F22, F23):
>
> 1. **Settings → Jobs is genuinely automatic (F23).** `job.memory.*`'s four fields (98.1) already
>    sat under the `job` key `farmSections.ts`'s `{ id: 'job', ..., keys: ['job', 'workflow'] }`
>    entry claims — no edit to `farmSections.ts` was needed, or made; this step only confirmed it
>    (`app/settings/page.test.tsx`'s pre-existing suite, unchanged, still green).
> 2. **The Run form's collapsed Runtime section**
>    (`packages/studio/src/components/schema-form/RuntimeOverrideSection.tsx`, new) — a `Collapsible`
>    built on the exact `FarmVideoFields.tsx` precedent named in this step's own brief, wrapping
>    `SchemaForm` against `RUNTIME_OVERRIDE_SCHEMA`
>    (`packages/studio/src/components/schema-form/runtime-override-schema.ts`, new): `z.object({
>    timeoutMs: RuntimeEnvelopeSchema.shape.timeoutMs.meta(ui({...})), maxRssBytes: ...meta(ui({...
>    enforcement: 'sampled' })), retries: ..., maxConcurrent: ... })` — the SAME field validators
>    `@enkaku/protocol`'s `RuntimeEnvelopeSchema` already enforces, reused rather than re-typed, with
>    only `title`/`kind`/`group`/`enforcement` added via the same `ui()` helper every other annotated
>    schema in this codebase uses. `sdk` is deliberately not offered (the module's own doc comment:
>    an SDK-major override has no honest run-time use case, §3.3 S1 — "there is no repair"). Wired
>    into `RunScriptDialog.tsx`: a `runtimeOverride` state, reset on every script/version/kind switch
>    exactly like `params` already is, sent as `runtimeOverride` on both `POST /api/jobs` and `POST
>    /api/batches` bodies when non-empty (`undefined`, not `{}`, when the operator touched nothing —
>    `JSON.stringify` drops it).
> 3. **The Script-detail Runtime card, with origin labels**
>    (`app/scripts/detail/page.tsx`'s new `RuntimeCard`, backed by the pure
>    `app/scripts/runtime-readout.ts`'s `computeRuntimeReadout`) — the SAME honesty requirement the
>    video settings step shipped for `VideoQualityReadout`/`profileRows`: every field shows its
>    resolved value AND which layer produced it (`'declared by the script'` / `'farm default'` /
>    `'built-in default'` / `'clamped to the farm ceiling'`), read off `resolveRuntime`'s own
>    `resolved`/`clamps` output, never recomputed. **A clamp is not a rejection, rendered as the
>    distinct thing it is**: a script declaration over the farm ceiling reads `'clamped to the farm
>    ceiling'`, shows the CEILING as the effective value (not the ask), and a one-line detail names
>    both numbers — `runtime-readout.test.ts`'s "a script declaration OVER the farm ceiling" case
>    pins this exactly. The card computes against `override: null` always — it renders a script's own
>    declaration, never a per-job override, which stays the Run form's own concern.
> 4. **The Summary tab's peak line gains its "/ N limit" half**
>    (`app/jobs/detail/page.tsx`) — "Peak memory 200.0 MB / 512.0 MB limit", this step's own brief's
>    exact example, appearing only once both the script's declaration (piggybacked on the SAME `GET
>    /api/scripts/:id` call `source`/`workflowDoc` already make — `ScriptSourceResponseSchema` grew a
>    third field, no second round trip) and the farm's settings (`GET /api/settings`, fetched once)
>    have resolved AND a limit actually resolves — never "/ no limit" tacked onto a job with none
>    configured. **Known, stated limitation**: `JobInfo` carries no `runtimeOverride` field yet
>    (`packages/protocol/src/messages/job.ts` is the contested file 98.7's own status paragraph
>    named), so this always resolves against `override: null` — a job actually run under an operator
>    override would show the farm/script ceiling, not the override's own tighter or looser number.
>    Recorded here rather than silently narrowed.
> 5. **The `enforcement` badge** — `plan.ts`'s `FieldPlan`'s existing `'number'` variant gained an
>    `enforcement?: EnforcementLevel` field (forwarded from `hints.enforcement` in `planKindNumber`,
>    the row-3 declared-kind path — the only place a hint reaches a plan at all), and `NumberControl`
>    draws a small "sampled"/"advisory" marker next to the label via `FieldRow`'s new `badge` prop
>    (`shell.tsx`) — `undefined`/`'hard'` draw nothing, exactly as §3.5 specifies ("hard is the
>    default expectation"). Information about the field, never a control: no `onChange`, nothing to
>    flip. `SchemaForm.test.tsx`'s new "the enforcement badge" describe block proves both halves —
>    `maxRssBytes` (kind `bytes`, `enforcement: 'sampled'`) draws the badge, `timeoutMs` (no
>    enforcement hint) draws none.
>
> **The deliverable named verbatim in this step's own brief**:
> `packages/studio/src/components/schema-form/runtime-override-schema.test.ts` (new, 6 tests,
> deliberately PURE like `plan.ts`'s own test file — no React, no DOM) asserts `RUNTIME_OVERRIDE_SCHEMA`
> plans `maxRssBytes` to `{ control: 'number', kind: 'bytes', enforcement: 'sampled' }` and `timeoutMs`
> to `{ control: 'number', kind: 'duration', unit: 'ms' }`, then walks every planned control produced
> by this schema and asserts each is a member of `KNOWN_CONTROLS` — a hand-maintained closed list
> type-checked against `FieldPlan['control']` itself (`AssertComplete`/`AssertNoExtra`), so a future
> control variant added to `plan.ts` without a matching entry here is a `bash scripts/typecheck.sh`
> failure, not a silent gap. **Pinned exactly, not just "a subset"**: all four fields plan to
> `['number', 'number', 'number', 'number']` — the identical control every other bytes/duration/count
> field in this product already uses. No new control was registered anywhere in this step.
>
> **A genuine, load-bearing gap, stated rather than implied — the reason an operator's Runtime
> override does not yet DO anything on a live farm.** `packages/core/src/api/jobs.ts`'s `EnqueueBody`
> and `packages/core/src/api/batches.ts`'s own create-batch body do not accept a `runtimeOverride`
> field, and neither forwards one to `JobService.enqueue()`/`createBatch()` — both files sit outside
> this step's file ownership (`api/jobs.ts` also carries the separate, owner-arbitrated
> `JobNodesResponseSchema` typecheck failure this step's own brief named as pre-existing and
> untouchable). Because `EnqueueBody` is a plain `z.object` (no `.strict()`), Studio's own
> `runtimeOverride` key is silently STRIPPED by the server's Zod parse today, and `service.enqueue`'s
> call site never reads it even if it survived — so what Studio sends is well-formed and
> client-validated, but has zero effect until that route is extended. Per §3.4's own reasoning ("a
> declared limit that nothing checks is worse than no field, because it reads as a guarantee"),
> shipping this silently would be exactly the failure this plan's design principles forbid — so it is
> recorded here, by file and by mechanism, as the next owner's one remaining wiring task, not smoothed
> over. `RuntimeOverrideSection.tsx`'s own doc comment carries the identical note at the point of use.
>
> Tests added this step: `packages/studio/src/components/schema-form/runtime-override-schema.test.ts`
> (new, 6 tests — the step's own named deliverable); `packages/studio/src/app/scripts/runtime-readout.test.ts`
> (new, 5 tests — the Runtime card's pure origin-labelling logic); `packages/studio/src/components/schema-form/SchemaForm.test.tsx`'s
> new "the enforcement badge" describe block (1 test); `packages/studio/src/components/RunScriptDialog.test.tsx`'s
> new "the collapsed Runtime section" describe block (3 tests — untouched stays out of the POST body,
> a typed value travels in it, switching scripts clears it); `packages/studio/src/app/scripts/detail/page.test.tsx`'s
> new "the Runtime card" describe block (3 tests — no declaration, under-ceiling, over-ceiling/clamped);
> `packages/studio/src/app/jobs/detail/page.test.tsx`'s new "peak memory shows the resolved limit"
> describe block (3 tests — farm default, script declaration wins over farm default, no limit
> configured anywhere shows no "/ limit"). `bun run --cwd packages/studio test`: 990 pass / 0 fail
> across 122 files (up from the 946/0 baseline this plan's own brief cites — the difference is this
> step's own new tests plus other concurrent plans' work already merged). `bash scripts/typecheck.sh`
> unaffected — still exactly the one pre-existing, unrelated `packages/core/src/api/jobs.ts(213,49)`
> failure this step's brief named and explicitly excluded. `bun run --cwd packages/studio build`
> (run alone, per this step's own testing-discipline instruction) succeeds — static export, 32 routes,
> no dynamic segments.
>
> **Hardware honesty — nothing in this step needs a physical device.** Every surface built here is
> HTTP plus DOM rendering; the two things a real device would exercise (a genuinely killed job's peak
> vs. a real ceiling, and a real farm's `job.memory.*` reaching this card/row live) were already
> proven end to end by steps 98.2's and 98.3's own integration tests against a real child process.
> This step's own "pending — owner to run" table, therefore, is only the one manual smoke check its
> brief's §7 steps 6–7 already named as belonging here specifically (an override above the ceiling
> producing a 400; a `maxConcurrent: 1` script's three-device fan-out).
>
> **Unblocked 2026-08-13** (`docs/plans/96-m61-hotfixes.md` §96.18): `EnqueueBody` (`api/jobs.ts`)
> and the create-batch body (`api/batches.ts`) now accept `runtimeOverride`, forwarded into
> `JobService.enqueue()`/`clusters/dispatch.ts`'s `createBatch()`, both of which already validated
> and ceiling-checked it (98.7). Proven at the HTTP layer — real routes, a real `JobService`/
> `createBatch()`, a real in-memory DB, never a fake service — by
> `packages/core/src/api/runtime-override-wiring.test.ts` (new, 7 tests): an override inside the farm
> ceiling enqueues/dispatches and is pinned onto the row(s); the same over the ceiling refuses
> `E_RUNTIME_OVER_CEILING` as a real 400, naming both numbers, writing no row; a malformed override
> refuses `E_RUNTIME_ENVELOPE_INVALID` (400, never a 500); no override pins `null`, unchanged from
> before the field existed — each shape asserted for both a standalone job and every member of a
> multi-device batch. §96.18 also found and closed a related gap the smoke table below was silently
> exposed to even once unblocked: `api/batches.ts`'s own `ERROR_STATUS` map never mapped
> `E_RUNTIME_UNSUPPORTED`/`E_RUNTIME_ENVELOPE_INVALID`/`E_RUNTIME_OVER_CEILING` to 400 at all, so any
> of the three surfaced as an opaque 500 over a batch's own HTTP route regardless of whether the
> underlying refusal was correct — see that entry for the full account, including one dependency
> still missing (`daemon.ts` does not yet pass `farmJobSettings` to `createBatchRoutes`, so a batch's
> own ceiling check runs but cannot yet bind against a real farm — outside that pass's file
> ownership, reported there rather than fixed).
>
> This is HTTP-and-DB verification, not the browser-driven manual check itself — no physical device
> or browser session was involved in unblocking it, and none is claimed here. The row below is
> updated to reflect what unblocking actually means (the machinery no longer refuses the smoke check
> before it can even start), not to claim the smoke check itself was run.
>
> | Check | Expected | Status |
> |---|---|---|
> | Run form: a Runtime override above the farm ceiling refuses with 400, naming the ceiling, no job created (§7 step 6) | `E_RUNTIME_OVER_CEILING`, no job row | unblocked, pending — owner to run through the browser; `EnqueueBody`/`createBatch` accepting `runtimeOverride` (the reason this was blocked) is fixed and proven at the HTTP layer, see above |
> | Publish `runtime: { maxConcurrent: 1 }`, enqueue three jobs on three devices → one runs, two wait; a different script on a freed device runs immediately (§7 step 7) | one `running`, two `queued`, unrelated script unblocked | pending — owner to run (this path needs no Studio change; `maxConcurrent` already resolves end to end as of step 98.5) |
>
> **98.9 implemented — documentation, closing the plan.** `docs/spec.md` §11.1 rewrites the
> `runtime` paragraph (added ad hoc when 98.4 landed) into its final, complete form: the
> restriction-not-permission invariant stated explicitly with the `E_RUNTIME_OVER_CEILING`
> refused-not-clamped / clamped-not-refused asymmetry named by name, the DB-row-governs-both-directions
> reconciliation rule, the `timeout`/`retries` fold-and-throw-on-disagreement behaviour, and the
> per-job override layer — all cross-checked against the shipped code and tests rather than the
> plan text, since several of this plan's own early sections (§3.5, §3.9) predate steps that later
> changed the details. §11.2 gains a new bullet plus the hard-vs-sampled table this step's own brief
> asked for by name: `sdk`/`timeoutMs`/`retries`/`maxConcurrent` are `hard`, `maxRssBytes` is
> `sampled` with its exact promise spelled out (breach caught within one sample interval, not
> prevented; the immediate-SIGKILL-no-grace behaviour stated alongside, in the same breath, as **not**
> a contradiction of `finish` always running — both halves proven by two differing `process.pid`
> values in this plan's own integration test); zero fields ship `advisory`. The table also states
> plainly that no farm-wide memory default was invented (`job.memory.defaultMaxRssBytes`/
> `maxRssBytes` ship `null`; 256 MB is a test fixture, not a shipped number) and that
> `maxConcurrent` blocks only its own script's additional jobs, proven against 8 real racing OS
> processes, never every other script on the device or the farm.
>
> `packages/sdk/README.md` gains a new "Runtime envelope — a restriction, never a permission"
> section, addressed to the SDK reader in the SDK reader's own terms (second person, "your script",
> "your farm's administrator") rather than copied verbatim from the spec's third-person prose — it
> opens with the exact same invariant in its own words ("declaring `maxRssBytes: 4_000_000_000` does
> **not** grant your script four gigabytes"), names the failure mode a reader who misreads the
> envelope as an allowance will actually hit (a script that runs fine on its author's own farm and
> then fails confusingly, at enqueue, on a farm the author does not administer), and carries the same
> hard-vs-sampled table, restyled for an SDK audience.
>
> `docs/plans/00-overview.md` §2 needs one new row for this plan — **not added here**, because that
> file was held by a concurrent worker for the whole of this step (per this step's own brief); the
> exact row text is relayed in this worker's own report for whoever holds that file next to add
> verbatim.
>
> Verified against the tree rather than assumed: `scripts.runtime`/`jobs.runtime_override`/
> `jobs.max_concurrent`/`jobs.peak_rss_bytes` all read back exactly as described above
> (`packages/core/src/db/schema.ts`, `packages/protocol/src/runtime-envelope.ts`,
> `packages/protocol/src/settings.ts`'s `job.memory.*` block); `E_RUNTIME_OVER_CEILING`/
> `E_RUNTIME_UNSUPPORTED`/`E_RUNTIME_ENVELOPE_INVALID` all appear exactly where the spec text above
> says they do. No source file was edited by this step — `docs/spec.md`, `packages/sdk/README.md`,
> and this plan file are the only three files this step touched, matching its own file-ownership
> scope.
>
> This closes plan 98 (M63). Every step 98.1–98.9 is implemented and tested; the one still-open item
> is step 98.8's own recorded gap — `POST /api/jobs`/`POST /api/batches` do not yet accept a
> `runtimeOverride` field, so an operator's Run-form override is validated and rendered but has no
> effect on a live farm until that route is extended (named, not fixed, by 98.8's own status text;
> `api/jobs.ts`/`api/batches.ts` are outside every file list this plan was ever assigned).
>
> Depends on: Plan 74 (`job.defaultTimeoutMs` / `maxTimeoutMs` and the clamp-and-log rule — this plan generalises it), Plan 82 (plugins: the bundle/`ready` split and enqueue-time pinning), Plan 95 (the `x-enkaku` hint vocabulary and the one `SchemaForm` renderer), Plan 36 (failure classification and the two retry budgets). None of them changes first.
> Spec references: §10.3 (the per-device claim), §11.1 (`defineScript`'s shape), §11.2 (`finish` always runs; every job is a child process), §11.3 (crash containment is **not** a sandbox), §11.6 (a job pins its script at enqueue)
> Ships: packages/protocol/src/runtime-envelope.ts

---

## 0. Evidence

Written from the code. **CONFIRMED** means there is a file and a line, or a
measurement recorded in §0.3. **HYPOTHESIS** means it fits but has not been
observed, and §5 measures it before acting on it.

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | A script already declares three execution facts and nothing else: `timeout`, `retries`, `reset`. There is no field for memory, concurrency, SDK version, or network. | `packages/sdk/src/types.ts:277-307` (`timeout` `:289`, `retries` `:291`, `reset` `:302`) |
| **F2** | **None of the three is ever persisted.** `enkaku publish` sends exactly `{ name, version, bundle, source, paramsSchema }`; `PublishBody` accepts exactly those; the `scripts` table has exactly one metadata column, `params_schema`. | `packages/sdk/src/cli/publish.ts:195`; `packages/core/src/scripts/routes.ts:30-41`; `packages/core/src/db/schema.ts:428`; insert at `packages/core/src/scripts/service.ts:112-121` |
| **F3** | The only road a declaration travels is the child's `ready` IPC message, built **inside the spawned process after it has imported the bundle**. The wire schema says so in a comment: *"Metadata from ScriptDefinition — only the child can read it."* | built at `packages/session/src/runner/child-entry.ts:353-361`; wire shape `packages/session/src/runner/ipc.ts:148-176` (comment `:162`); consumed `packages/session/src/runner/job-runner.ts:455-461` |
| **F4** | Therefore **every declaration arrives after the device is already committed.** The session is acquired first, the child spawns second; and the queue flipped the device to `busy` in SQL before either. | acquire `packages/session/src/runner/job-runner.ts:715`; spawn `:746` → `:297`; SQL flip `packages/core/src/queue/job-store.ts:315` |
| **F5** | Consequently **the first attempt of every job is armed with the farm default, never the script's own number** — `meta.timeoutMs` is undefined until a prior attempt has seen `ready`. The script's number only re-arms the timer mid-attempt. | `job-runner.ts:739-744`, initial arm `:648`, mid-attempt re-arm `:465-476` |
| **F6** | Timeout enforcement itself is complete and correct: abort message → 30 s grace for `finish()` → SIGTERM → 5 s → SIGKILL. | `job-runner.ts:648` → `:344` → `FINISH_GRACE_MS` `:44` → `:348` → `SIGKILL_DELAY_MS` `:46` → `:354` |
| **F7** | A farm ceiling exists for timeout, defaults to *off*, and clamps **with a log line naming the script and both numbers** — never silently. | `clampTimeoutMs` `job-runner.ts:229-232`; `job.maxTimeoutMs` default `null` `packages/protocol/src/settings.ts:538-546`; `job.defaultTimeoutMs` default `3_600_000` `:506-513` |
| **F8** | **There is no memory setting anywhere in the farm schema.** The byte-sized knobs that exist are `shell.maxOutputBytes`, `transfer.maxPush/PullBytes`, `workspace.*`, `kv.maxValueBytes` — none of them bounds a job process. | `packages/protocol/src/settings.ts` (`job` group `:388-605`; no `job.memory*`) |
| **F9** | `Bun.spawn` in the shipping isolation mode passes **no resource limits at all** — command, ipc, stdout, stderr, env. Container mode *does* pass `--memory`/`--cpus`, but it is opt-in via `ENKAKU_JOB_ISOLATION=container` and is the multi-tenant path, not what ships. | `packages/session/src/runner/isolation.ts:61-68`; container `:110`; selection `:152` |
| **F10** | **`--smol` cannot reach the child on the shipping path.** Measured (§0.3 M1): a `bun build --compile` binary receives `--smol` as `process.argv[1]`, an application argument, not a runtime flag. The release binary is exactly that path — it re-executes itself with `--job-child`. | `isolation.ts:56-60`; measurement §0.3 M1 |
| **F11** | **The child can measure itself, and a parent kill on a self-reported breach is fast.** Measured (§0.3 M2): `process.memoryUsage.rss()` and `process.resourceUsage().maxRSS` both work on Bun 1.3.14; a breach at 306 MB against a 300 MB ceiling was SIGKILLed 736 ms after spawn. | measurement §0.3 M2 |
| **F12** | **RSS counts touched pages only.** Measured (§0.3 M3): allocating `new Uint8Array(1<<20)` without writing to it never moved RSS across 4 s; adding `.fill(1)` moved it ~20 MB per 50 ms tick. An RSS limit therefore measures *committed* memory and never fires on reserved-but-untouched address space. | measurement §0.3 M3 |
| **F13** | The child already heartbeats over IPC — but at **10 s**, which is far too coarse to be a memory sampler (M2 crossed 300 MB in 728 ms). | `packages/session/src/runner/child-entry.ts:16` (`HEARTBEAT_MS = 10_000`), used `:378` |
| **F14** | The runner already has a silence watchdog: **30 s with no IPC message at all** ⇒ `doAbort('hung')`. Every inbound message resets it *and* renews the lease. | `job-runner.ts:48` (`SILENCE_LIMIT_MS`), `:331-337`, reset-on-every-message `:443-444` |
| **F15** | **`finish()` is already re-run in a brand-new process after a kill**, with `priorError` populated and its own short budget. This is the mechanism that makes "kill hard, clean up elsewhere" available today. | `job-runner.ts:771-789`; `FINISH_ONLY_TIMEOUT_MS` `:45`; the rule it depends on, `packages/sdk/src/types.ts:295` and spec §11.2 (`docs/spec.md:566`) |
| **F16** | **Per-device job concurrency is already exactly 1 — in SQL, not by convention.** The claim requires `d.status='idle'` and flips it to `busy` in the same transaction. | `packages/core/src/queue/job-store.ts:297`, `:315`; spec §10.3 `docs/spec.md:490-509` |
| **F17** | A per-**group** concurrency gate already exists and is the precedent to copy: batches, as a correlated `COUNT(*)` inside the one claim statement, with an explicit warning against a TypeScript pre-filter *because anything outside the transaction can be raced*. | `job-store.ts:299-304`, rationale comment `:255-260` |
| **F18** | A job already pins and denormalises its script identity at enqueue, and the spec states that publishing a newer version never changes what a queued job runs. | `packages/core/src/db/schema.ts:320-321` (`scriptName`/`scriptVersion`, plan 82 §3.4); spec §11.6 `docs/spec.md:610` |
| **F19** | `jobs.device_id` is `notNull()`. There is no device-less job, and no code path that could produce one. | `packages/core/src/db/schema.ts:269` (table at `:264`) |
| **F20** | A script has **full fs and network access as the core's OS user**. Crash containment is not a sandbox, and the spec says so at length. Container mode's `--network=none` is unconditional and not per-script. | `docs/spec.md:576-582`; `packages/session/src/runner/isolation.ts:3-21`, `:105` |
| **F21** | Failure classification is a single exported table; an unknown code classifies as `script`, and `SCRIPT_CODES` exists **so that a classification is asserted rather than left to the default**. | `packages/core/src/jobs/failure-class.ts:73-82`, `:98-102` |
| **F22** | Studio already renders any Zod schema carrying `x-enkaku` hints, `kind:'duration'` and `kind:'bytes'` included — and **unknown hint keys are stripped, never rejected**, which is what makes the vocabulary safe to extend. | vocabulary `packages/protocol/src/params/vocabulary.ts:20-31`, `:66-83`, `ui()` `:158-172`, tolerant parse `:103-122` / `:130-136`; Studio planner `packages/studio/src/components/schema-form/plan.ts:20-60`, formatter `controls/format.ts:77-99`, renderer `SchemaForm.tsx:192` |
| **F23** | The Settings screen's Jobs tab is literally `keys: ['job']`. Any new field under `job.*` appears with **no new UI code**. | `packages/studio/src/components/settings/farmSections.ts:73` |
| **F24** | **The plan-92 trap, in the code.** `FarmSettings.defaults` is documented as *"Copied onto a device the first time it is enrolled"*; the copy happens at admission; and the read-back falls to **schema** defaults, never the farm's — the settings store is not even imported in the file that reads it. | declaration `packages/protocol/src/settings.ts:612-616`; copy `packages/core/src/registry/admission.ts:61`, `:113` and `packages/core/src/registry/device-registry.ts:324-343`; read-back `packages/core/src/session/adapters.ts:19-22` |
| **F25** | The runner already does the **correct opposite**: farm settings are read fresh per attempt through a getter, never captured at daemon start, so a Settings change reaches the very next job with no restart. | `job-runner.ts:237`, `:732`; wired `packages/core/src/daemon.ts:2050` |
| **F26** | Plan 90's R1–R4 are design-only for the guest agent, and **R3 contradicts its own schema**: a closed `z.enum` inside `z.array` makes an unknown future capability fatal to the whole `hello`, which is the opposite of what plan 90's own test row asks for. Plan 90 also states **no support window**. | `docs/plans/90-m55-unified-guest-agent.md:675-705` (R1–R4), `:1319` (the test row), `:798` (no window); the schema it contradicts `packages/protocol/src/guest-agent.ts:167`; implemented gate `packages/drivers/src/network/guest-agent/client.ts:272-280` |

### 0.2 Hypotheses (measure before acting)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | Operators want a memory limit but **nobody can currently choose a number**, because peak RSS has never been recorded anywhere. | F8 — there is no setting, no column, and no log line carrying a job's memory footprint. | 98.2 ships the *measurement* unconditionally and one step before any limit is enforceable. If the recorded distribution shows every job comfortably under a couple of hundred megabytes, the limit is decoration and §9 Q3 says so out loud. |
| **H2** | The runaway shape is **unbounded allocation across await points** (a growing array of dumps or screenshots), not a synchronous allocation loop. | `ctx.device.dump()` is documented at 334–584 ms and returns a whole tree (`packages/sdk/src/types.ts:64-76`); every device call is an `await`, so the event loop is free between allocations. | 98.3's sampler covers exactly the await-point shape. The synchronous shape is covered only by F14's existing 30 s watchdog, and §3.6 says so plainly rather than implying otherwise. §9 Q4 opens out-of-band sampling if field data contradicts this. |
| **H3** | `maxConcurrent` is wanted for **rate-limited external targets** ("one login at a time across the whole farm"), not for host resources. | F16 already makes per-device concurrency 1, so the only unanswered question is farm-wide. Host resources are bounded by device count, which is physical. | 98.5 ships it. If no shipped pack ever declares it, it is dead weight and should be deleted rather than kept — recorded as §9 Q5's tail. |

### 0.3 Measurements taken for this plan

Bun 1.3.14, macOS (darwin 25.4.0). Scripts were throwaway; the numbers are
what §3.5 and §3.6 are built on, so they are recorded rather than asserted.

- **M1 — `--smol` does not survive compilation.** `bun build --compile a.js --outfile a-bin`, then `./a-bin --smol x y` printed `argv: ["/$bunfs/root/a-bin","--smol","x","y"]`. Interpreted (`bun --smol a.js x y`) it is consumed as a runtime flag and never appears in argv. **The shipping path is the compiled one** (F10), so `--smol` is unavailable exactly where it would matter.
- **M2 — self-reported RSS plus a parent SIGKILL is fast and works.** A child allocating 20 MiB per 50 ms tick and reporting `process.memoryUsage.rss()` over IPC; the parent SIGKILLed on the first sample above 300 MB. Result: `BREACH rss=306MB` at `+728ms`, `sig=SIGKILL` at `736ms`. Eight milliseconds from decision to dead.
- **M3 — RSS ignores untouched pages.** The identical test using `new Uint8Array(1<<20)` **without** `.fill(1)` never breached across a full 4 s run: the pages were never faulted in. This is a feature, not a flaw (F12).
- **M4 — the process APIs exist.** `process.memoryUsage()` returns `{rss, heapTotal, heapUsed, external, arrayBuffers}`; `process.resourceUsage()` returns `maxRSS` among others. Both usable from the child with no flags.

---

## 1. Goals

- **A script can state what it needs to run**, in one place, as a sibling of
  `params` — and the core either honours it or refuses it by name. Today
  `timeout` and `retries` are that statement, they live nowhere but inside the
  bundle, and they arrive too late to influence anything but a timer (F2–F5).
- **Every field in the envelope is enforced, and the schema says how hard.**
  A new `enforcement` hint (`hard` | `sampled` | `advisory`) sits next to
  `kind` in the existing vocabulary, so **an unlabelled advisory field becomes
  impossible to add**. This plan ships zero advisory fields.
- **A job's memory footprint is a recorded number before it is ever a limit.**
  Peak RSS lands on the job row for every job, limit or no limit, one
  implementation step before the limit exists (H1).
- **A memory breach kills immediately and cleans up elsewhere.** No grace
  period spent letting a process at its ceiling allocate more; `finish()` runs
  in a fresh process, which is exactly what the stateless-and-idempotent rule
  was written for (F15) and the first time anything uses it deliberately.
- **A version gate exists before it is needed.** `runtime.sdk` ships inert at
  major 1. You cannot retrofit a version gate: an artefact that never declared
  a version can never be safely refused.
- **Precedence is resolved, never copied.** One pure resolver, three layers
  (farm → script → job override), one ceiling, every clamp logged by name.
  Nothing writes a resolved envelope into a row — the exact defect F24 records.
- **The UI costs no new form code.** The farm fields land on the Jobs tab
  because they are under `job.*` (F23); the per-job override renders through
  the same `SchemaForm` against a second schema (F22).

## 2. Non-goals

- **Not a sandbox, and no field may imply one.** Spec §11.3 and F20 are
  unchanged by this plan: a script has full fs and network access as the
  core's OS user. Nothing here is a security boundary and §3.4 rejects the
  fields that would read as one.
- **Not a device-less execution mode.** `needsDevice` is rejected in §3.4 —
  `jobs.device_id` is `notNull()` (F19) and the claim requires an idle device
  (F16). That is a new execution path, not an envelope field.
- **Not a change to container isolation.** `ENKAKU_JOB_ISOLATION=container`
  keeps its kernel-enforced `--memory`/`--cpus` (F9) untouched; §3.5 states how
  the two coexist and which one is reported.
- **Not the output contract.** Plan 97 owns what a script *returns*. §8.1
  states the seam and stops.
- **Not workflows.** Plan 99 owns pipelines. §8.2 hands it the resolver and
  states what is deliberately not offered.
- **Not a new job-log or artifact budget.** Out of scope; `transfer.*` and
  `kv.maxValueBytes` already bound their own surfaces.

## 3. Context and design decisions

### 3.1 The declaration arrives after the decision it should have informed

This is the root defect and it is worth stating as one sentence: **a script's
execution declaration is readable only by the process that was already spawned
to run it** (F3), and by then the device is claimed (F4) and the timer is armed
on the farm's number (F5).

Everything in this plan follows from splitting the envelope by *when its
consumer needs it*:

| Needed at | Fields | Source of truth |
|---|---|---|
| **enqueue** (before a device is claimed) | `sdk`, `maxConcurrent` | the DB — `scripts.runtime`, resolved onto `jobs.max_concurrent` |
| **claim** (inside the SQL transaction) | `maxConcurrent` | `jobs.max_concurrent`, an integer, nothing else |
| **spawn** (parent-side, before `init`) | `timeoutMs`, `retries`, `maxRssBytes` | the DB, resolved against live farm settings |
| **reconciliation only** | all of them | the child's `ready` message |

The `ready` message keeps carrying the envelope, but **it stops being the
source of truth and becomes a check**: when the bundle and the DB disagree,
the DB wins and the runner logs one `warn` naming both. That covers the one
real case where they legitimately differ — a plugin **dev slot**, which has no
`scripts` row at all and lives in memory (`packages/core/src/plugins/dev-slots.ts`,
surfaced at `plugins/runtime.ts:357`) — and it makes a stale bundle visible
instead of silently authoritative.

**Backward compatibility is total and costs nothing.** A script published
before this plan has `runtime = NULL`, and `NULL` resolves to the farm
defaults — which is precisely today's behaviour (F5).

### 3.2 The envelope is a restriction, never a permission — and that is load-bearing

Every field a script may declare **narrows what that script may consume**.
None of them grants access to anything.

This is not a stylistic preference; it is the invariant that makes §3.3's
forward-compatibility rule safe. If an older core silently ignores a field a
newer SDK added, and every field is a self-imposed restriction, the worst
outcome is that the script runs with the farm's looser numbers — visible,
bounded, and logged. If a field ever *granted* something ("may reach the
network", "may install APKs"), silently ignoring it would fail **open**, and
the whole tolerant-parsing design would become a hole.

**Rule, permanent:** any future field that grants rather than restricts may
not ride this channel. It needs its own, refusing-by-default mechanism.

### 3.3 Version compatibility: S1–S4, derived from plan 90's R1–R4

Plan 90 designed R1–R4 for the guest agent (F26). Scripts differ in three ways
that change the answer, and one way that does not:

- **The core cannot repair a script.** R1's whole improvement was that a
  protocol mismatch stops being a dead end because the core can reinstall the
  pinned APK. The core cannot rebuild an author's bundle. R1's *gate* transfers;
  R1's *repair* has no analogue.
- **The IPC never skews.** `child-entry.ts` ships **inside the core binary**
  (F9, `isolation.ts:56-60`); only the *bundle* is the author's. So there is no
  protocol-major negotiation to have — the skew surface is the shape of the
  bundle's default export, nothing else. This is why S1 versions the **SDK
  contract**, not a wire protocol.
- **A bundle is a long-lived artefact.** Plan 90 could state no support window
  (F26) because it freezes `GUEST_AGENT_PROTOCOL` at 1. A script bundle sits in
  a database for years, so a window is mandatory, not optional.
- **What does transfer unchanged:** R2's discipline. Nothing branches on a
  version except the gate.

**S1 — the SDK major gates the conversation; there is no repair.**
`runtime.sdk` is an integer major, never a semver. The core exports
`SCRIPT_RUNTIME_MAJOR` (ships as `1`) and `SCRIPT_RUNTIME_MIN_MAJOR`. A bundle
declaring a major outside `[MIN, CURRENT]` is refused **at enqueue** with
`E_RUNTIME_UNSUPPORTED`, before a device is claimed — refusing at `ready`
would have already burnt a session acquisition (F4). Absent ⇒ major `1`, so
every script published to date passes. The operator-facing message names the
declared major, the supported range, and the one action that exists: publish a
new version.

Refusing the *newer* direction is the safe one and needs saying: a bundle built
against a `ctx` this core does not implement will fail somewhere unpredictable
if allowed to run. Refusing it at enqueue is the honest, early failure.

**S2 — capabilities gate features; versions never.** No core source file
compares an SDK semver — not with `>=`, not with `startsWith`, not at all. The
mechanism already exists and runs the other direction from plan 90's: instead
of the caller checking a capability list, **the runtime refuses the call with a
code** — `E_KV_UNAVAILABLE`, `E_JOBS_UNAVAILABLE`, `E_TRANSFER_UNAVAILABLE`
(`job-runner.ts:163-179`). That is already capability gating, it already works
for an old bundle on a new core and vice versa, and it needs no list to keep in
sync. An anti-rot guard test enforces the "never compares a version" half,
exactly as plan 90 proposed for `appVersion`.

**S3 — envelope fields are append-only, and an unknown field is dropped with a
warning, never fatal.** This is where plan 90's R3 is deliberately *not*
followed: R3's closed enum makes an unknown value from a newer peer fatal to
the entire handshake (F26), which plan 90's own test row contradicts and which
would be actively wrong here, because a script author's SDK is upgraded
independently of the farm and routinely runs ahead of it. So:

- A field name, once shipped, is never removed and never repurposed.
- Parsing an envelope **strips** unknown keys (Zod object default) and a
  separate `unknownRuntimeKeys()` diff reports them, so the drop produces one
  `warn` naming each field instead of silence.
- This is safe **only** because of §3.2's invariant. The rule and its
  justification live together, permanently.

**S4 — the semver decides nothing.** The bundle's SDK semver is recorded on
the job row for diagnosis and is never read by a branch. Exactly R4's split
between "which build is this" and "may we talk".

### 3.4 What was considered and rejected

A declared limit that nothing checks is worse than no field, because it reads
as a guarantee. Four candidates fail that test and are not built.

**`needsDevice: false` — rejected.** Not because it is unenforceable, but
because it is not a limit at all: it is a second execution mode wearing an
envelope field's clothes. `jobs.device_id` is `notNull()` (F19), the claim
joins `devices` and requires `d.status='idle'` (F16), and the runner acquires a
session before it spawns (F4). Honouring it means a second queue, a second
claim path, a second lease model, and a Studio that can show a job with no
device. That is a plan, not a field. Recorded here so the next person does not
re-derive it.

**`network: 'none' | 'full'` — rejected as a lie.** In the shipping isolation
mode the child is an ordinary Bun process with the core's own network access
(F20), and there is no flag, no permission model, and no per-process firewall
this codebase can reach on macOS, Linux **and** Windows. Container mode already
sets `--network=none` unconditionally (F9) — a field would change nothing
there either. A `network` field would be believed and would be false.

**`capabilities: [...]` (which device methods the script will call) — rejected,
and this is the closest call.** It *is* enforceable: `DeviceCallSchema` is a
closed union and `createDeviceExecutor` is a single chokepoint
(`job-runner.ts:496`). Two reasons it is still wrong here:

1. **It buys no safety.** Given F20, a script that wanted to bypass the device
   API could; an allowlist over `ctx.device` while the process has full fs and
   network is theatre, and shipping theatre next to genuinely enforced fields
   devalues the genuine ones.
2. **It adds a mid-run failure mode with no upside.** A script that forgets to
   declare one method it calls fails at the worst possible moment — mid-run,
   on a device it holds.

What people actually want from this is *disclosure* — "what does this script
do before I run it on forty phones?" — and disclosure should be **derived**
from the bundle at publish, not declared by the author who is the least
reliable narrator of their own imports. That is a different feature with a
different design, and it is named here so it is not smuggled in as a field.

**CPU limit — rejected.** No cross-platform mechanism this codebase can reach:
`nice`/`cpulimit` are POSIX-only and advisory, `taskset` is Linux-only, and
Windows needs a Job Object via native code. And the constraint that matters is
the device, which is physical and already serialised (F16).

### 3.5 Memory: enforced by sampling, and the schema says so

Three mechanisms were considered and only one survives on all three platforms:

| Mechanism | Verdict |
|---|---|
| `bun --smol` | **Unavailable.** M1: the flag lands in `argv` on a compiled binary — and compiled is the shipping path (F10). It is also a GC heuristic, not a cap. |
| OS resource limits | **Not portable.** `setrlimit(RLIMIT_AS)` has no Bun API; macOS does not honour `RLIMIT_AS` the way Linux does; Windows has no rlimit at all and needs a Job Object through native code. Shipping a limit that only works on Linux is exactly the half-feature this repo forbids. |
| Container `--memory` | **Real, and already there** (F9) — kernel-enforced, opt-in, multi-tenant only. Untouched by this plan. |
| **Self-reported RSS + parent kill** | **Chosen.** M2/M4: works today, on every platform, with no new dependency; measured at 8 ms from breach decision to a dead child. |

So `maxRssBytes` is **enforced, by sampling** — and that phrase is not a
disclaimer buried in a doc comment, it is a machine-readable field:
`x-enkaku.enforcement: 'sampled'`, rendered by Studio as a badge with the
sample interval next to the input. What it promises precisely:

- A breach is killed within one sample interval (default 2 s), not prevented.
- The measurement is **committed** memory (F12/M3), which is the number that
  matters — a script that reserves 4 GB of address space and touches 40 MB is
  not a problem and is not treated as one.
- A single allocation large enough to exhaust the host between two samples is
  not caught by this. That is stated, not hidden.

The new `enforcement` hint takes three values — `hard`, `sampled`, `advisory`
— and every envelope field must carry one. **This plan ships zero `advisory`
fields**; the value exists so that adding one later is impossible to do
silently.

### 3.6 The memory kill is deliberately harsher than the timeout kill

The timeout path (F6) gives a 30 s grace so `finish()` can run in the doomed
process. Repeating that for memory would be wrong twice over: asking a process
at its ceiling to allocate for a cleanup screenshot is asking it to fail, and
the grace window is 30 s during which it keeps allocating against a host that
is already unhappy.

**Decision.** On a breach with `enforce: 'kill'`: **SIGKILL immediately**, no
abort message, no grace — then the *existing* finish-only attempt (F15) runs
`finish()` in a brand-new process with clean memory and `ctx.error` populated.

This is the first place the "`finish()` must be stateless and idempotent" rule
(`packages/sdk/src/types.ts:295`, spec §11.2) is *used* rather than merely
stated, and it is a better outcome than the timeout path's, not a worse one.

The surrounding behaviour:

- **A warning before the kill.** One `warn` at 80% of the limit, once per
  attempt, naming current and limit. A kill with no warning is a mystery; a
  kill with a warning 40 s earlier is a diagnosis.
- **`ctx.error.phase` stays `'timeout'`.** `ScriptError.phase` is a closed
  union in the SDK (`packages/sdk/src/types.ts:259`), and an existing
  `finish()` body branching on `'timeout'` must keep matching. The **code**
  carries the distinction — `MEMORY_LIMIT` vs `TIMEOUT` — and `code` was never
  constrained. The job row's `errorPhase` records the phase the child last
  reported, so "where" stays answerable.
- **Classified `script`, never `infra`.** `MEMORY_LIMIT` joins `SCRIPT_CODES`
  (F21) so the assertion is explicit rather than falling through the default:
  a script that blew its own declared budget is a result, not the farm's fault,
  and must never feed the device health tracker or spend the infra retry
  budget. It is retried only up to the script's own `retries`, which defaults
  to 0.
- **The honest gap, stated.** A script that blocks its own event loop while
  allocating cannot report, so the sampler cannot see it. That case is caught
  by F14's existing 30 s silence watchdog and surfaces as `TIMEOUT`. The
  memory limit's real coverage is allocation **across await points** — the
  overwhelmingly common shape (H2). To narrow the window, when a memory limit
  is in effect the silence limit tightens to
  `min(SILENCE_LIMIT_MS, 3 × sampleIntervalMs)` — 6 s at the default instead of
  30 s. Out-of-band `ps`-style polling was considered and rejected: a spawned
  process every 2 s per running job, with three platform implementations, to
  cover a shape the watchdog already covers 5× faster than before.

### 3.7 `maxConcurrent`, and the question that was actually being asked

"May two copies run on one device?" already has an answer, and it is **no**,
enforced in SQL (F16). Restating it as a field would be a no-op that reads as a
feature.

The unanswered question is **farm-wide**: may two copies of this script run at
once on *different* devices? For a rate-limited external target — a login flow,
an API-backed action — the answer is often no, and today there is no way to say
so except by hand-rolling a lock in `ctx.kv`.

**Decision.** `maxConcurrent` (0 = unlimited) is enforced **inside the claim
transaction**, as a correlated `COUNT(*)`, exactly like the batch gate that
already exists — including its comment's warning that a TypeScript pre-filter
can be raced (F17). Because the claim is SQL, the number must be an integer on
the row before the claim runs, so it is **resolved at enqueue and denormalised
onto `jobs.max_concurrent`**.

That denormalisation is not the F24 trap, and the distinction is exactly the
one worth writing down:

> **Fields the runner resolves are never copied. The one field the claim SQL
> needs is pinned at enqueue, on purpose, because a job already pins its script
> at enqueue** (F18, spec §11.6). Pinning what the job runs and pinning how many
> may run are the same decision made at the same moment.

Starvation is not a new risk: the gate lives in the `WHERE` of a `LIMIT 1`
`SELECT`, so a blocked job is *skipped* and the next eligible one is claimed —
the behaviour the batch gate has shipped since plan 20.

### 3.8 Precedence, and not repeating plan 92's defect

```
effective(field) = clamp( job override  ??  script declaration  ??  farm default ,  farm ceiling )
```

The defect to avoid (F24) has a precise shape: a value is **copied** from farm
settings into a row at one moment, and read back from a **third** source
(schema defaults) that is neither, so a later farm change reaches nothing. The
runner already demonstrates the cure (F25) — read the live settings through a
getter, fresh per attempt.

**Three rules, and a test for each:**

1. **One resolver, and it takes the farm settings as an argument.**
   `resolveRuntime({ farm, script, override })` is pure, lives in
   `@enkaku/protocol`, and is the only place precedence is expressed. There is
   no second resolution site to drift.
2. **Nothing writes a resolved envelope anywhere.** `scripts.runtime` stores
   the *declaration*; `jobs.runtime_override` stores the *override*. Neither
   ever stores the resolved result. The one exception is `jobs.max_concurrent`,
   which §3.7 justifies explicitly and which is the only exception permitted.
3. **A regression test asserts the cure directly**: change a farm default, then
   run an **already-published** script and an **already-queued** job, and the
   new default applies to both with no republish and no re-enqueue.

Ceiling behaviour is deliberately asymmetric, and it follows plan 74's
reasoning rather than contradicting it:

- **A script declaration over the ceiling is clamped and logged**, naming the
  script and both numbers — exactly `clampTimeoutMs`'s existing behaviour
  (F7). The artefact was published somewhere else, possibly long ago; killing
  its job outright over an operator setting it never saw is worse than running
  it shorter and saying so.
- **A job override over the ceiling is refused** at enqueue with
  `E_RUNTIME_OVER_CEILING`, naming the ceiling. A human is right there typing
  the number; silently clamping their input is the worse failure. And without
  this, the ceiling would be trivially bypassable by anyone able to enqueue,
  which would make it meaningless.

### 3.9 The UI reuses plan 95 entirely

Four surfaces, zero new form controls (F22, F23):

1. **Settings → Jobs.** `job.memory.*` is under `job.*`, so the tab picks it up
   with no code (F23). `kind:'bytes'` and `kind:'duration'` already format
   correctly (`controls/format.ts:77-99`).
2. **Run form → a collapsed "Runtime" section.** Rendered by the same
   `SchemaForm` (`SchemaForm.tsx:192`) against a **second** JSON Schema,
   `RUNTIME_OVERRIDE_SCHEMA`, derived from the same Zod via `z.toJSONSchema`.
   It is never merged into the params schema: params belong to the script
   author, the envelope belongs to the core, and merging them would corrupt an
   author's schema and collide with plan 97.
3. **Script detail → a read-only "Runtime" card.** Each field shows its
   effective value and **where it came from** — `script`, `farm`, or
   `clamped`. This is the answer to "where do the numbers come from", made
   visible instead of documented.
4. **Job Summary → `Peak memory 812 MB / 512 MB limit`.** Always present once
   98.2 lands, because you cannot choose a memory limit without ever having
   seen one (H1).

Each numeric field renders an `enforcement` badge from §3.5's new hint —
`hard` shows nothing (the default expectation), `sampled` shows the interval,
`advisory` (unused today) would show a distinct marker.

## 4. Technical design

### 4.1 `packages/protocol/src/runtime-envelope.ts` (new — the artefact this plan ships)

```ts
/** The current SDK contract major. Ships at 1; every pre-98 bundle is major 1 by omission. */
export const SCRIPT_RUNTIME_MAJOR = 1
/** The oldest major this core will run. See §3.3 S1 and §9 Q1 for the window. */
export const SCRIPT_RUNTIME_MIN_MAJOR = 1

/**
 * What a script declares about its own execution (plan 98 §3.2). EVERY field
 * is a restriction the script places on itself — never a permission it
 * requests. That invariant is what makes `unknownRuntimeKeys` safe to ignore
 * a field instead of refusing it (§3.3 S3).
 */
export const RuntimeEnvelopeSchema = z.object({
  sdk: z.number().int().min(1).max(999).optional(),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  maxRssBytes: z.number().int().min(64 * 1024 * 1024).max(16 * 1024 * 1024 * 1024).optional(),
  /** Farm-wide simultaneous running jobs of this script. 0 = unlimited. §3.7. */
  maxConcurrent: z.number().int().min(0).max(1_000).optional(),
})
export type RuntimeEnvelope = z.infer<typeof RuntimeEnvelopeSchema>

export interface ResolvedRuntime {
  timeoutMs: number
  retries: number
  maxRssBytes: number | null
  maxConcurrent: number
  sdk: number
}

export interface RuntimeClamp {
  field: 'timeoutMs' | 'maxRssBytes'
  requested: number
  ceiling: number
  from: 'script' | 'override'
}

/** The ONE place precedence is expressed (§3.8 rule 1). Pure; takes live farm settings. */
export function resolveRuntime(input: {
  farm: JobSettings
  script: RuntimeEnvelope | null
  override: RuntimeEnvelope | null
}): { resolved: ResolvedRuntime; clamps: RuntimeClamp[] }

/** Field names present in `raw` that this build does not know (§3.3 S3) — logged, never fatal. */
export function unknownRuntimeKeys(raw: unknown): string[]

/** S1's gate. `null` when acceptable; otherwise the operator-facing refusal. */
export function checkRuntimeMajor(sdk: number | undefined): { code: 'E_RUNTIME_UNSUPPORTED'; message: string } | null
```

### 4.2 SDK (`packages/sdk/src/types.ts`, `define-script.ts`)

`ScriptDefinition` gains `runtime?: RuntimeEnvelope`. `timeout` and `retries`
stay, are marked deprecated in their doc comments, and are folded into the
envelope by `defineScript` (`runtime.timeoutMs ?? timeout`), with a thrown
error if both are set and disagree — a silent divergence would be
unverifiable, the same reasoning `definePlugin` already applies to a member's
`version` (`packages/sdk/src/plugin.ts:103-107`).

`defineScript` keeps its contract exactly (`packages/sdk/src/define-script.ts:6-10`):
shape validation and a freeze, **no orchestration**. Validating the envelope's
shape is validation; honouring it stays entirely in the core's runner.

### 4.3 Settings (`packages/protocol/src/settings.ts`, under `job`)

```ts
memory: z.object({
  defaultMaxRssBytes: z.number().int().min(64<<20).max(16<<30).nullable().default(null)
    .meta(ui({ title: 'Default job memory limit', kind: 'bytes', group: 'Memory', enforcement: 'sampled' })),
  maxRssBytes: z.number().int().min(64<<20).max(16<<30).nullable().default(null)
    .meta(ui({ title: 'Maximum job memory limit', kind: 'bytes', group: 'Memory', enforcement: 'sampled' })),
  enforce: z.enum(['kill', 'warn', 'off']).default('kill')
    .meta(ui({ title: 'On a memory breach', group: 'Memory',
      labels: { kill: 'Kill the job', warn: 'Log a warning and continue', off: 'Do nothing' } })),
  sampleIntervalMs: z.number().int().min(250).max(30_000).default(2_000)
    .meta(ui({ title: 'Memory sample interval', kind: 'duration', unit: 'ms', group: 'Memory', advanced: true })),
})
```

Both byte fields default to `null` (off), matching `maxTimeoutMs`'s
"offered, and off" precedent (F7). `enforce: 'kill'` is the default only
because a limit is opt-in by declaration — a farm that has set no default and
runs scripts that declare nothing sees no change whatsoever.

`ParamHints` gains `enforcement?: 'hard' | 'sampled' | 'advisory'`
(`packages/protocol/src/params/vocabulary.ts:66-83`), append-only, and
`ParamHintsSchema` (`:103-122`) accepts it. Older Studio builds strip it (F22),
so this is forward-safe in both directions.

### 4.4 DB (`packages/core/src/db/schema.ts`) — four columns, one migration

| Table | Column | Why |
|---|---|---|
| `scripts` | `runtime` (json, null) | the declaration, readable before spawn (§3.1) |
| `jobs` | `runtime_override` (json, null) | the operator's per-job layer (§3.8) |
| `jobs` | `max_concurrent` (int, null) | the only resolved value ever written, and only because the claim is SQL (§3.7) |
| `jobs` | `peak_rss_bytes` (int, null) | always recorded (§3.9 item 4, H1) |

Generated with `bun run --cwd packages/core db:generate`. All nullable; every
existing row keeps reading.

### 4.5 Publish and enqueue

- `publish.ts:195`'s body gains `runtime`; `PublishBody`
  (`packages/core/src/scripts/routes.ts:30-41`) gains
  `RuntimeEnvelopeSchema.nullable().optional()`; `service.ts:112-121` inserts
  it — the exact three-point road `paramsSchema` already travels (F2), so no
  new pattern.
- Publish refuses an envelope that fails the schema with
  `E_RUNTIME_ENVELOPE_INVALID` (400), and **warns** (never refuses) on unknown
  keys, naming each (§3.3 S3).
- Enqueue (`packages/core/src/jobs/validate-script.ts`, alongside the existing
  params validation) runs `checkRuntimeMajor` → `E_RUNTIME_UNSUPPORTED`, then
  `resolveRuntime` → `E_RUNTIME_OVER_CEILING` if the *override* exceeds a
  ceiling, then writes `jobs.max_concurrent`. All three happen **before** a
  device is leased, which is the point (F4).

Line references in this section are against `packages/core/src/db/schema.ts` as
of writing: `jobs` at `:264`, `scripts` at `:413`, `params_schema` at `:428`.

### 4.6 The claim (`packages/core/src/queue/job-store.ts`)

One clause added to the existing statement, immediately after the batch gate
(`:299-304`), in the same style and inside the same transaction:

```sql
AND ( j.max_concurrent IS NULL OR j.max_concurrent = 0
      OR (SELECT COUNT(*) FROM jobs r
          WHERE r.script_name = j.script_name AND r.status = 'running') < j.max_concurrent )
```

Keyed on `script_name`, not `script_id` — a limit is standing intent about a
script, which must survive a version bump, the same reasoning
`script_param_sets` already uses (`packages/core/src/db/schema.ts:465-477`).
§9 Q5 puts that choice in front of the owner. A supporting index on
`(status, script_name)` keeps the correlated count cheap.

### 4.7 IPC (`packages/session/src/runner/ipc.ts`)

- `init` gains `rssSampleMs: number` — the **parent** dictates the cadence:
  `job.memory.sampleIntervalMs` when a limit is in effect, `10_000` otherwise
  (peak recording is always on, cheaply).
- New child→parent `{ t: 'rss', bytes: number }`.
- `ready` gains `runtime?: RuntimeEnvelope`, for the dev-slot path and the
  reconciliation warning (§3.1).

Two small parent-side rules that matter more than they look:

- An `rss` message resets the **silence** timer (it is proof of life) but does
  **not** call `deps.heartbeat` — at a 2 s cadence that would multiply lease-
  renewal writes fivefold for no benefit. A one-line exception at
  `job-runner.ts:443-444`.
- When a limit is in effect, `SILENCE_LIMIT_MS` tightens to
  `min(30_000, 3 × rssSampleMs)` (§3.6).

### 4.8 The runner (`packages/session/src/runner/job-runner.ts`)

- `AbortReason` gains `'memory'`; `abortErrorCode` returns `'MEMORY_LIMIT'`.
- `doAbort('memory')` skips the abort-message-and-grace path entirely and
  SIGKILLs, then falls into the existing finish-only attempt (F15, `:771-789`).
- A per-attempt `peakRssBytes` accumulator, reported to the host on settle;
  one `warn` at 80%; one `error` at the breach naming peak, limit and interval.
- `runAttempt` takes the whole `ResolvedRuntime` instead of loose
  `timeoutMs`/`maxTimeoutMs` arguments; `clampTimeoutMs` moves into
  `resolveRuntime` and keeps its log line verbatim.

### 4.9 Failure classification

`MEMORY_LIMIT` joins `SCRIPT_CODES`
(`packages/core/src/jobs/failure-class.ts:82`) — asserted, not defaulted, for
the reason that set exists (F21).

## 5. Implementation steps

### 98.1 — The envelope and the resolver

`packages/protocol/src/runtime-envelope.ts` (new), exported from the package
index; `enforcement` added to `ParamHints` and `ParamHintsSchema`;
`job.memory.*` added to `JobSettingsSchema`.

**Verifiable result:** `bun test packages/protocol` green, including a table
test walking every (farm, script, override, ceiling) combination for each
field, and a test proving an unknown envelope key is stripped, reported by
`unknownRuntimeKeys`, and never fatal.

### 98.2 — Measure before limiting — **DONE**

`rss` IPC message and `init.rssSampleMs` (cadence 10 s, no limit anywhere);
parent-side peak accumulator; `jobs.peak_rss_bytes` + migration; the Summary
tab line. **No limit is enforced in this step.**

**Verifiable result:** run any script; its job row has a non-null
`peak_rss_bytes` and Studio's Summary tab shows it. `bun test` and
`bun run --cwd packages/studio test` green.

**Verified.** `packages/core/src/jobs/peak-rss.integration.test.ts` runs a
real job through the real pipeline (real child process, real SQLite via the
real migration) and reads back a non-null `peakRssBytes` — the exact bar this
line asks for, proven from a real job row rather than a fixture. See the
plan's own status line above for the full file list and the rest of the test
evidence (`child-entry.test.ts`, `job-runner.test.ts`, `job-store.test.ts`,
`executor-host.test.ts`, `ipc.test.ts`, Studio's `page.test.tsx`).

**Pending — owner to run (hardware honesty).** The integration test above
fakes `SessionManager.acquire` (as `plugin-execution.integration.test.ts`
already does) — every OTHER part of the pipeline is real. The one thing that
genuinely needs a physical device is seeing it through the live browser UI:

```bash
bun run dev            # core on :7700
bun run dev:studio     # Studio on :3001
# publish any script, e.g. the sdk quickstart, and run it once against a real enrolled device
# open the job's detail page → Summary tab
```

Expected outcome: the "timing" card's "Peak memory" row shows a formatted
byte value (e.g. "38.4 MB"), not "—" / "not measured for this job".

| Check | Expected | Status |
|---|---|---|
| Peak memory row renders on a real, real-device job's Summary tab | a formatted, non-dash value | pending — owner to run |

### 98.3 — The memory limit — **DONE**

`AbortReason: 'memory'`, `MEMORY_LIMIT`, the immediate-SIGKILL path, the 80%
warning, the tightened silence limit, `SCRIPT_CODES`, and the three `enforce`
modes.

**Verifiable result:** a fixture script allocating across `await`s under a
256 MB limit is killed within one sample of the breach; the job settles
`failed` / `failureClass: 'script'` / `code: 'MEMORY_LIMIT'`; `finish()` is
proven to have run in a fresh process by asserting its side effect. With
`enforce: 'warn'` the identical script completes and the log carries exactly
one warning.

**Verified.** `packages/core/src/jobs/memory-limit.integration.test.ts` runs
the real pipeline end to end — real SQLite via the real migration, the real
`ExecutorHost`, the real `createScriptExecutor`, `@enkaku/session`'s real
`JobRunner` with no isolation override, a REAL `bun child-entry.ts <bundle>`
child that allocates and touches memory across `await` points — against a
fixture under a 256 MB `enforce: 'kill'` limit: killed with a recorded peak
between 0.7× and 1.5× the ceiling, `failed`/`script`/`errorPhase: 'timeout'`,
never blames the device, and `finish()`'s fresh-process claim is proven by two
REAL, DIFFERENT `process.pid` values recorded from two REAL child processes
(the killed `run()` and the separate finish-only re-run), read back from
outside both. A second test proves `enforce: 'warn'`: the identical shape of
script completes and the job log carries exactly one warning (counted).
`packages/session/src/runner/job-runner.test.ts` adds the fast,
deterministic mechanism-level counterpart (a scripted fake child, no real
process): no `abort` message ever reaches a memory-killed attempt, no grace
timer fires, the finish-only re-run's `priorError.code` is `MEMORY_LIMIT`,
the 80% warning fires exactly once across many samples above it, `'warn'`/
`'off'` produce exactly one/zero warnings, and the silence limit measurably
tightens to `3 × sampleIntervalMs` once a ceiling is configured. No
farm-wide default ceiling was invented — `job.memory.defaultMaxRssBytes`/
`maxRssBytes` stay `null`; 256 MB is this step's test fixture only (§9 Q3 is
still open for an owner to decide a real number from 98.2's recorded data).

**Also landed here, self-detecting-gap style**: `ExecutorHostDeps.scriptKind`
and `start()`'s kind-aware `deps.registry.get(job.scriptId, kind)` lookup
(`packages/core/src/jobs/executor-host.ts`) — flagged by a concurrent plan 99
worker as missing from this step's own file, fixed here, turning
`packages/core/src/jobs/executor-kind-dispatch.test.ts` green. `daemon.ts`'s
matching `scriptKind` wiring is a separate worker's assignment, untouched.

### 98.4 — The envelope persists — **DONE**

`def.runtime` in the SDK (with the `timeout`/`retries` fold and the
disagreement error); `publish.ts` sends it; `PublishBody` + validation +
`scripts.runtime` + `service.ts` insert; the plugin verify-child and dev-slot
in-memory paths; `ready` carries it, and the runner logs one `warn` when bundle
and DB disagree.

**Verifiable result:** publish a script declaring `runtime`; `GET
/api/scripts/:id` returns it; a doctored bundle whose `ready` envelope differs
from its row produces exactly one `warn` naming both values, and **the DB
value is the one used**.

**Verified.** See the plan's own status line above for the full file list and
test evidence. `packages/core/src/scripts/routes.test.ts`'s "POST / persists
runtime, GET /api/scripts/:id returns it" describe block is the literal
verifiable result, run end to end over the real Hono app; the "DB value is the
one used, both directions" claim is proven in
`packages/session/src/runner/job-runner.test.ts` against the memory ceiling —
the one field `resolveRuntime`'s result actually drives today (`timeoutMs`
re-arming still reads the bundle's own `ready.timeoutMs`, unchanged by this
step — see this step's own status paragraph above for why that refactor is
explicitly left open, not silently skipped).

**No physical-device verification is pending for this step** (hardware
honesty, stated rather than assumed) — everything this step touches is HTTP,
the DB, and the parent↔child IPC channel; `packages/session/src/runner/child-entry.test.ts`
already spawns a REAL `bun child-entry.ts` process importing a real bundle to
prove the wire mechanics, which is as close to "real" as this step's own
surface gets. The device-touching claim this step's persistence eventually
feeds — a script's `runtime.maxRssBytes` actually bounding a job on a live
farm — was already exercised end to end (real child, real SQLite, real
`ExecutorHost`) by step 98.3's own `memory-limit.integration.test.ts`, whose
"pending — owner to run" table (if any is added later) belongs to that step,
not this one. If a later step wires a per-job override or `maxConcurrent`
through Studio's run form, THAT step is where a browser-driven manual smoke
check belongs (§7's own manual smoke steps 6–7 already describe it).

**Downstream dependency, recorded here so whoever implements this step knows
it unblocks something outside this plan.** Plan 99 (M64, workflows) §3.11,
§3.12 and §4.3 check 7 need exactly what this step ships: a node script's
declared `timeout` readable at publish time, without waiting for the child's
own `ready` message at run time. Plan 99's `checkWorkflow`
(`packages/protocol/src/workflow-check.ts`) is written to refuse a workflow
whose nodes' summed declared timeouts cannot fit inside `workflow.maxTotalMs`
(`E_WORKFLOW_BUDGET_IMPOSSIBLE`) — but as of plan 99 step 99.6, that check is
a documented, reported gap rather than a faked pass, because nothing in
`ResolvedNodeScript` nor any `scripts` column carries a node's declared
timeout, and `checkWorkflow`'s own signature is never handed workflow
settings either. Once this step lands `scripts.runtime.timeoutMs` (persisted
by the `scripts.runtime` column and `service.ts` insert named above), plan
99's `ResolvedNodeScript` gains a `runtime.timeoutMs`-shaped field sourced
from that column, and check 7 becomes a one-field addition rather than a
redesign. This step does not need to do anything for plan 99's sake — the
column and the publish-time persistence are enough — but the two plans were
written concurrently (plan 99 §0) and neither originally stated this
dependency in the other's direction; this paragraph and plan 99 §3.11/§3.12
are that cross-reference, added 2026-08-13.

### 98.5 — `maxConcurrent` at the claim — **DONE**

`jobs.max_concurrent` resolved and written at enqueue; the claim SQL clause;
the supporting index.

**Verifiable result:** three jobs of a `maxConcurrent: 1` script on three idle
devices → exactly one `running`, two `queued`, and the third device is free to
claim a *different* script's job immediately. A concurrency test hammering
`claimNext` from parallel callers proves no over-admission.

**Verified.** `packages/core/src/queue/job-store.test.ts`'s "claimNext —
maxConcurrent gate" describe block reproduces the plan's own verifiable
result wording exactly — three devices, one `maxConcurrent: 1` script,
exactly one claim succeeds, the other two stay `queued`, and a DIFFERENT
script's job on a freed device claims immediately (device famine avoided,
the property the step's brief calls out as the one that "makes or breaks
this step"). The claim gate is proven to live inside the SQL transaction,
not application code, two ways: a sequential test against the clause's own
semantics, and a genuinely multi-process test (`claim-race-worker.ts`, 8
real OS processes via `Bun.spawn`, each with its own SQLite connection to
the same on-disk file, hammering `claimNext` with no coordination) that
admits exactly one job across every process and every attempt. Both were
run once against the clause deliberately disabled (`AND (1 = 1)`) first —
the multi-process race then admitted 8 of 8 instead of 1 — proving the
tests are not vacuous, before the clause was restored and everything
re-run green. `services/job-service.test.ts` and `jobs/triggers.test.ts`
cover the resolution side: `enqueue()`, `resume()` (re-resolved from the
original job's own pinned scriptId, not copied), and `ctx.jobs.trigger()`
(against the REAL `ScriptRegistry`) all pin the resolved cap via
`resolveRuntime`, never a raw column read. See this plan's own status
paragraph above for the full file list, the `daemon.ts`-not-touched
reasoning, and the one recorded gap (`clusters/dispatch.ts`'s batch
dispatch has no `ScriptRegistry` and does not yet resolve a cap —
`docs/plans/00-overview.md` §9's new row for this column names it).

**Addendum, 2026-08-13 — CLOSED.** The batch-dispatch gap above no longer
exists: `createBatch` now resolves and pins `maxConcurrent` (and
`scriptName`/`scriptVersion`) exactly like `enqueue()`/`resume()` do,
proven against the real claim path — a `maxConcurrent: 1` script dispatched
as ONE BATCH across three idle devices, then real, separate OS processes
hammering `claimNext` concurrently, admits exactly one. See
`docs/plans/96-m61-hotfixes.md` §96.14 for the full writeup and evidence,
including the non-vacuousness check (the same race admits 3 of 3 with the
fix reverted).

### 98.6 — The version gate — **DONE**

`SCRIPT_RUNTIME_MAJOR`/`MIN_MAJOR`, `checkRuntimeMajor` wired into enqueue,
`E_RUNTIME_UNSUPPORTED`, and the S2 anti-rot guard test.

**Verifiable result:** a script row declaring `runtime.sdk: 99` is refused at
enqueue with the coded error and its message names the supported range; no
device is ever claimed for it. The guard test fails if any core/session source
file compares an SDK version.

**Verified (audited 2026-08-13).** `services/job-service.test.ts`'s "the version
gate" describe block proves the refusal at the real `JobService.enqueue()`/
`resume()` surface — `jobStore.enqueue` (the row write itself) is asserted
never CALLED on a refusal, not merely that an error is thrown — and that an
absent `runtime.sdk` (every pre-plan-98 script) and an unwired `scriptNameOf`
both enqueue unaffected (acceptance criterion 2, and the property this plan's
own brief calls out: a farm mid-upgrade never runs nothing). `jobs/triggers.test.ts`'s
own "the version gate" describe block proves the identical refusal on the
THIRD write path against a REAL SQLite DB and a REAL `ScriptRegistry` — no
mock — asserting zero rows written on a refusal. `runtime-sdk-comparison-guard.test.ts`
walks every non-test file under `packages/core/src` and `packages/session/src`
and confirms none compares `.sdk`, with two sanity tests proving the pattern
both catches a real offense and passes this step's own real wiring shapes
through clean. All three files are green (`bun test`: job-service.test.ts
48/48, triggers.test.ts + job-store.test.ts + runtime-sdk-comparison-guard.test.ts
+ executors/script.test.ts 76/76 combined).

**One gap found by this audit, fixed in place once `clusters/dispatch.ts`
was reassigned mid-task** (its previous holder finished; the coordinator
lifted the exclusion specifically for this): `createBatch` is a FOURTH write
path onto `jobs`, resolved a script's `runtime` (`named =
deps.scriptNameOf?.(...)`, closed by 98.5's own 2026-08-13 addendum below)
but never called `checkRuntimeMajor` on it, so a batch dispatched directly
(`api/batches.ts`) of a script declaring an unsupported `runtime.sdk` was
never refused and every member job claimed a device. Fixed — the identical
`checkRuntimeMajor(named?.runtime?.sdk)` → throw shape every other write
path uses, added right after `named` resolves. See this step's own status
paragraph above (the "Audited 2026-08-13" entry) for the diff, the test
(`packages/core/src/jobs/batch-dispatch-version-gate.test.ts`, red before the
fix, green after), and — the part still open — a SECOND, sibling gap this
fix does not reach: `packages/core/src/schedules/runner.ts`'s `fireOnce`
(a firing SCHEDULE's own, separate `createBatch` call) never wires
`scriptNameOf` at all, so a schedule-fired batch of an unsupported-`sdk`
script still dispatches unrefused today. That file is outside every list
this audit was ever assigned; `packages/core/src/jobs/scheduled-batch-version-gate.test.ts`
pins it red, and the same status paragraph above carries the verbatim fix.

### 98.7 — The per-job override — **DONE**

`jobs.runtime_override`, enqueue validation, `E_RUNTIME_OVER_CEILING`, and the
origin (`script` / `farm` / `override` / `clamped`) recorded in the job log.

**Verifiable result:** enqueue with `runtimeOverride.timeoutMs` above
`job.maxTimeoutMs` → 400 naming both numbers, no job row created; below it →
the job runs with the override and the log names the origin.

**Verified (audited 2026-08-13).** `services/job-service.test.ts`'s "the
per-job override" describe block (11 tests) proves, at the real
`JobService.enqueue()`/`resume()` surface: an override pins verbatim onto the
row; `runtimeOverride.timeoutMs`/`maxRssBytes` above the farm ceiling refuse
with `E_RUNTIME_OVER_CEILING` naming both numbers and write no row; **the
farm ceiling still wins even when the override is paired with a script
declaration under it** — the property this plan's own brief names as the one
that would make the whole gate advisory if it did not hold, proven directly
rather than inferred; a shape violation refuses with
`E_RUNTIME_ENVELOPE_INVALID`; an unknown key is stripped and warned, never
fatal; and `resume()` carries the original override forward, re-checked
against the CURRENT farm ceiling, refusing if it has since tightened.
`packages/session/src/runner/job-runner.test.ts`'s "the per-job override"
describe block (5 tests) proves the SAME ceiling-wins property one layer
deeper, at the real `JobRunner.execute()` surface: a job whose override asks
for 900 MB is actually killed at the farm's 200 MB ceiling (not 900 MB), with
the clamp logged naming both numbers and `(origin: override)`; a job whose
override (100 MB) is tighter than its own script declaration (500 MB) is
killed at the override's number on the very FIRST attempt, no `ready` round
trip needed — closing the exact F5-shaped gap this plan exists to close, for
the override layer specifically. `queue/job-store.test.ts`'s "enqueue —
runtimeOverride" and "parseJobRuntimeOverride" describe blocks (6 tests) and
`jobs/executors/script.test.ts`'s own describe block (3 tests) cover the
storage/threading layer in between. `bunx drizzle-kit generate` against the
current `schema.ts` reports "No schema changes, nothing to migrate" —
`0050_narrow_champions.sql` (`ALTER TABLE jobs ADD runtime_override text;`)
is confirmed generated and in sync, not hand-written.

**The one ripple this step's own status paragraph flagged as open
(`clusters/dispatch.ts:196`/`dispatch.test.ts:231` each needing a
`runtimeOverride: null,` line) is CLOSED** — both lines are present in the
tree today and `bash scripts/typecheck.sh` shows only the one pre-existing,
unrelated `JobNodesResponseSchema` failure. See this step's own status
paragraph above for the confirmation in full.

### 98.8 — Studio — **DONE**

Settings Jobs tab (automatic, F23); the Script-detail Runtime card with origin
labels; the Run form's collapsed Runtime section via `SchemaForm` +
`RUNTIME_OVERRIDE_SCHEMA`; the Summary peak line; the `enforcement` badge.

**Verifiable result:** `bun run --cwd packages/studio test` green, including a
test asserting the planner produced `bytes` and `duration` fields for the
override schema **with no new control component registered**.

**Verified.** See the plan's own status line above ("98.8 implemented and
tested — Studio") for the full file list, the per-surface accounting, and the
one genuine gap left open (`EnqueueBody`/`createBatch` do not yet accept
`runtimeOverride`, both files outside this step's ownership).
`packages/studio/src/components/schema-form/runtime-override-schema.test.ts`
is this step's own named deliverable, run in full: 6/6, asserting
`maxRssBytes` plans to `{ control: 'number', kind: 'bytes', enforcement:
'sampled' }` and `timeoutMs` to `{ control: 'number', kind: 'duration', unit:
'ms' }`, with every planned control across the schema pinned to
`['number', 'number', 'number', 'number']` and checked against a
type-level-verified closed control list — no new control registered.
`bun run --cwd packages/studio test`: 990 pass / 0 fail across 122 files.
`bash scripts/typecheck.sh`: unaffected, still exactly the one pre-existing
`packages/core/src/api/jobs.ts(213,49)` failure this step's own brief named
and excluded. `bun run --cwd packages/studio build` (run alone): succeeds,
static export, no dynamic route segments.

### 98.9 — Documentation

`docs/spec.md` §11.1/§11.2 gain the envelope and the hard-vs-sampled table;
the SDK README documents `runtime` and restates §3.2's restriction-not-
permission invariant; `docs/plans/00-overview.md` §2 lists this plan.

**Verifiable result:** the spec names every shipped field with its enforcement
strength, and says in its own words that a memory limit is sampled, not
prevented.

## 6. Acceptance criteria

1. A script declaring `runtime.timeoutMs` runs to that budget on **its first
   attempt**, not only after `ready` — the F5 defect is gone.
2. A script published before this plan (`runtime = NULL`) behaves identically
   to today: farm defaults, no warnings, no refusals.
3. Every job records a non-null `peak_rss_bytes`, whether or not any memory
   limit is configured anywhere.
4. A script exceeding `maxRssBytes` under `enforce: 'kill'` is SIGKILLed within
   one sample interval, with **no** grace period, and its `finish()` runs in a
   fresh process.
5. That failure settles as `code: 'MEMORY_LIMIT'`, `failureClass: 'script'`,
   `blameDevice: false`, and never spends the infra retry budget.
6. A memory breach is preceded by exactly one 80%-of-limit warning in the job
   log, naming current and limit.
7. `enforce: 'warn'` lets the same script finish, logs one warning, and still
   records the peak. `enforce: 'off'` logs nothing and still records the peak.
8. `ctx.error.phase` is `'timeout'` for a memory kill; an existing `finish()`
   branching on `'timeout'` keeps matching.
9. Three queued jobs of a `maxConcurrent: 1` script on three idle devices
   produce exactly one running job, and the gate lives **inside** the claim
   transaction — no TypeScript pre-filter exists.
10. A blocked `maxConcurrent` job never starves the queue: another script's job
    on the same device claims normally.
11. A bundle declaring an unsupported `runtime.sdk` is refused at **enqueue**
    with `E_RUNTIME_UNSUPPORTED`, and never claims a device.
12. A bundle declaring an **unknown envelope field** runs, and the field is
    reported in one `warn` naming it — never fatal, in either version
    direction.
13. No core or session source file compares an SDK version; a guard test
    enforces it.
14. A **script** declaration above a farm ceiling is clamped and logged naming
    the script and both numbers; a **job override** above a ceiling is refused
    with `E_RUNTIME_OVER_CEILING`.
15. Changing a farm default changes the effective value for an
    **already-published** script and an **already-queued** job, with no
    republish and no re-enqueue — F24's defect is provably not repeated.
16. No resolved envelope is written to any row except `jobs.max_concurrent`,
    and a test asserts that column is the only one.
17. `job.memory.*` appears on Settings → Jobs with **no new Studio component**;
    the Run form's Runtime section renders through the existing `SchemaForm`.
18. Every envelope field carries an `enforcement` hint, and no shipped field
    carries `'advisory'`.
19. `bash scripts/typecheck.sh`, `bun test`, and
    `bun run --cwd packages/studio test` are all green.

## 7. Test plan

**Unit — `packages/protocol`**
- `resolveRuntime` precedence table: every field × {farm only, script only,
  override only, all three} × {ceiling set, ceiling null}.
- `unknownRuntimeKeys` reports extras and `RuntimeEnvelopeSchema` strips them.
- `checkRuntimeMajor` for below-floor, above-current, absent, and in-range.
- `ParamHintsSchema` accepts `enforcement` and still strips genuinely unknown
  keys.

**Unit — `packages/session`**
- Memory breach → SIGKILL with no `abort` message sent (assert the child never
  received one) and no grace timer armed.
- Finish-only attempt spawns after a memory kill, with `priorError.code ===
  'MEMORY_LIMIT'`.
- Exactly one 80% warning per attempt across many samples.
- `rss` resets the silence timer but does not call `deps.heartbeat`.
- Silence limit tightens to `3 × rssSampleMs` when a limit is in effect and
  stays 30 s when it is not.
- Timeout behaviour is byte-for-byte unchanged (the plan-74 suite passes with
  no edits).

**Unit — `packages/core`**
- Enqueue refusals: `E_RUNTIME_UNSUPPORTED`, `E_RUNTIME_OVER_CEILING`,
  `E_RUNTIME_ENVELOPE_INVALID`.
- `claimNext` with `max_concurrent`: single-claim, over-limit skip,
  no-starvation, and a parallel-callers race test.
- `MEMORY_LIMIT` classifies `script` / `blameDevice: false`.
- **The F24 regression test**: publish, change a farm default, enqueue and run
  — the new default applies without a republish; and the same for a job queued
  before the change.

**Unit — `packages/studio`** (`bun run --cwd packages/studio test`)
- The override schema plans to `bytes` / `duration` fields with no new control.
- The Runtime card renders origin labels for script / farm / clamped.
- The Summary tab renders peak-vs-limit.

**Manual smoke** (one physical device, `bun run dev` + `bun run dev:studio`)
1. Publish a script declaring `runtime: { maxRssBytes: 256MB, timeoutMs: 60_000 }`.
2. Run it clean → Summary shows a peak well under the limit; no warnings.
3. Run a variant that grows an array across `await`s → the log shows the 80%
   warning, then the kill; the job is `failed` / `MEMORY_LIMIT`; the `finish()`
   side effect is present, proving the fresh-process re-run.
4. Set `job.memory.enforce = 'warn'` in Settings → the same script now
   completes with one warning. No restart.
5. Set `job.memory.maxRssBytes = 128MB` → re-run: the declaration is clamped
   and the log names the script and both numbers.
6. On the Run form, set a Runtime override above the ceiling → a 400 naming the
   ceiling, no job created.
7. Publish with `runtime: { maxConcurrent: 1 }`, enqueue three jobs on three
   devices → one runs, two wait; enqueue a different script on a waiting
   device → it runs immediately.

## 8. Interfaces offered to concurrent plans

### 8.1 Plan 97 (typed output contract)

`def.runtime` is a **sibling** of `def.params`, and of whatever 97 names for
output. The envelope never describes data shape; 97 never describes execution
limits. Both travel the identical publish road (F2): a new `PublishBody` field,
a new column, a `service.ts` insert. **Offered:** that road is now walked twice,
so the pattern is proven. **Asked in return:** if 97 would rather have one
metadata JSON column than two, say so — §9 Q6 — because merging is cheap now
and expensive after both have shipped.

### 8.2 Plan 99 (workflows)

**Offered:** `resolveRuntime({ farm, script, override })` is pure, exported
from `@enkaku/protocol`, and has no core dependency. A pipeline node supplies
its own layer as `override` and inherits precedence, clamping, the log lines,
and the ceiling refusal for free.

**Not offered, deliberately:** a fourth precedence layer. A workflow that needs
node-over-run-over-script composes its own overrides *before* calling the
resolver; the resolver stays three-layer, because a four-layer precedence table
nobody can recite is how F24 happens again. Also not offered: a workflow-scoped
concurrency gate — §4.6's gate is per script name, and a per-workflow gate is
99's own SQL to write, next to the batch gate and this one.

## 9. Open questions (owner decisions)

1. **Support window for `runtime.sdk`.** Proposed: the core runs `[CURRENT-2,
   CURRENT]`, so a bundle stays runnable across two breaking SDK majors. Plan
   90 states no window at all (F26); scripts need one because a bundle is a
   long-lived database row. Is two majors the right generosity, or three?
2. **`job.memory.enforce` default.** Proposed `'kill'`. The conservative
   alternative is to ship `'warn'` for one release so the first farm to hit it
   learns rather than loses a job. Note that either way nothing changes for a
   farm that sets no default and runs scripts that declare nothing.
3. **Ship the limit at all?** 98.2 deliberately lands the measurement first
   (H1). If the recorded peaks show every job comfortably under a couple of
   hundred megabytes, `maxRssBytes` is decoration and 98.3 should be dropped
   rather than shipped for symmetry. Decide after 98.2 has run in the field,
   not before.
4. **Out-of-band sampling.** Rejected in §3.6 (three platform implementations,
   a spawned process per running job, covering a shape the tightened silence
   watchdog already catches in 6 s). Reopen only if the field shows the
   synchronous-allocation shape actually occurring.
5. **`maxConcurrent` keyed on script *name* or script *id*?** Proposed
   **name** — a limit is standing intent about a script and must survive a
   version bump, matching `script_param_sets` and `ScriptRef`. The counter-case
   is a farm deliberately running v1 and v2 side by side. And its tail: if no
   shipped pack ever declares `maxConcurrent`, delete the field rather than
   keep it (H3).
6. **One metadata column or two?** `scripts.runtime` is proposed as its own
   column. If plan 97 adds a third, a single `scripts.metadata` JSON blob may
   be tidier. Cheap to decide now, expensive later.
7. **Should `finish()` get a memory budget of its own?** Today the finish-only
   attempt inherits `FINISH_ONLY_TIMEOUT_MS` (30 s) and no memory limit. A
   `finish()` that itself leaks would not be caught. Proposed: leave it — the
   process is fresh and short-lived, and a second budget is a knob nobody would
   set. Recorded so the gap is known rather than discovered.
