# Plan 97 — M62 : The Output Contract — What a Script Returns, and Who May Believe It

> Status: implemented and tested — all nine steps (97.1–97.9) done. 97.1–97.4 done; 97.5/97.6/97.8 done, closing the storage gap the plan's own headline claim ("three correct steps that have not met") originally described — `packages/core/src/scripts/publish-result-e2e.test.ts` proves 97.2 (declare), 97.5 (read/serve) and 97.6 (render) meet at a real `GET /api/jobs/:id`-shaped read; 97.7 (`ctx.progress`) done for its local path; 97.9 (documentation) done. **What remains, in full, and it is small and named rather than hidden**: MCP `tools/list`'s per-tool `outputSchema` (`core/src/mcp/server.ts`, F23's other half); the cloud/node tunnel's live `ctx.progress` forwarding (`packages/protocol/src/tunnel.ts`); Studio's live-progress line on the job detail page above the result panel — all three are unbuilt READ surfaces, none of the three affects a stored value, a status, or the schema pinned to a version; and one measurement never taken (a literal parent-process memory profile during a 50 MB+ result, structurally proven but not instrument-measured — see the consolidated table at the end of 97.9's own entry below). Every one of these is named in its owning step's own paragraph, not newly discovered here. Step 97.1 (the shared schema module move) is done: `packages/protocol/src/params/` moved to `packages/protocol/src/schema/`; `PARAMS_LIMITS`→`SCHEMA_LIMITS`, `checkParamsSchema`→`checkDeclaredSchema`, `validateParams`→`validateAgainstSchema`, `clampParamsSchema`→`clampSchema` renamed at every call site (`ui`/`ParamHints`/`readHints`/`reconcileParams` kept their names); `formatValue`/`formatBytes` moved from `packages/studio/src/components/schema-form/controls/format.ts` to `packages/protocol/src/schema/format.ts` (Studio re-imports from `@enkaku/protocol`), taking `NumberKind` with it so the move does not create a reverse Studio→protocol dependency. Step 97.2 is done in full as of the storage-closing pass recorded below: the type-system half (`packages/protocol/src/schema/result.ts`'s `RESULT_STATUSES`/`ResultStatusSchema`/`RESULT_LIMITS`/`summaryFields`/`buildResultSummary`, `vocabulary.ts`'s `summary?: boolean` hint, the SDK's `ScriptDefinition<S, R>` second generic with H1 proven by `packages/sdk/src/result.type-test.ts`), the publish-time gate (`sdk/src/cli/publish.ts`, `core/src/plugins/verify-child-entry.ts`), and the storage/serving half (`core/src/db/schema.ts`'s `scripts.resultSchema`, `core/src/scripts/routes.ts`) are all landed — see the storage-closing paragraph below for the exact commit shape. `sdk/src/plugin.ts`'s `PluginMemberScript<S, R>` also carries the second generic now, proven at each member's own `const` declaration rather than through the plugin array's own inference (tried, and found unworkable in `tsc`'s inference engine — see the paragraph below).

**Step 97.3 (the runtime: measure, then check, then store) is done**, fixing F3/F4/F10/F11 and testing H2. `packages/session/src/runner/child-entry.ts`: on the success path only (97.4's `finish()`-salvage `partial` is not this step's), `buildResultOutcome` serialises inside a `try` (a circular value → `invalid`, `bytes: 0`, H2's exact message, `sendValue: false` — never the H2 hang), measures with `TextEncoder` BEFORE any check runs, refuses over `init.maxResultBytes` (`oversize`, verdict without the value), walks the value with `findDangerousKey` (an iterative, stack-based walk against `DANGEROUS_FIELD_NAMES`, newly exported from `@enkaku/protocol`'s `schema/limits.ts` — V3, `invalid` with the path named, value still sent verbatim as inert text), and only then `safeParse`s against `def.result` when the script declared one — the VERDICT decides `status`, the raw `value` is what is sent either way (§3.3, F25). `BundleDef` gained an optional `result` field (a `{ safeParse }` shape, never a full Zod import). `ipc.ts`: `outcome` (`ResultOutcomeSchema`, new in `schema/result.ts`) is optional on the `result` message so a pre-plan-97 bundle still parses (a missing `outcome` means `undeclared`, per plan 59's "an older bundle meeting a newer core is normal" rule); `init` gained a REQUIRED `maxResultBytes` (mirroring `rssSampleMs`'s own convention), resolved by `job-runner.ts` from the farm's `job.maxResultBytes` setting (new on `JobSettingsSchema`, alongside `job.progressIntervalMs` for 97.7) and defaulting to `RESULT_LIMITS.defaultMaxResultBytes` for any caller (a finish-only attempt, a test harness) that does not supply one. `AttemptOutcome`/`JobRunner.execute()`'s return type gained an optional `outcome?: ResultOutcome`, threaded straight from the child's own `result` message through the existing `result`-handler and `execute()`'s final return — purely additive, so it cannot break a caller built against the pre-97.3 shape.

`packages/core/src/jobs/result-store.ts` (new, this plan's own `Ships:` line): `recordResult`, pure, unit-tested alone (`result-store.test.ts`, 15 cases) — turns a child's `ResultOutcome` (or its absence) into the four `jobs` columns, independently re-measuring `bytes` from whatever value it actually received and re-deriving `status` (§3.8: "the parent re-checks what it can cheaply and independently know"), overriding a child's stale/wrong claim to `oversize` when the re-measured size exceeds `maxResultBytes` and dropping the value even if one was (incorrectly) sent. One subtlety the plan text did not name and this pass had to resolve: `executors/script.ts`'s pre-existing `return result.value ?? null` normalises an ABSENT child value to `null` before `recordResult` ever sees it, so `value === null` cannot mean "received" the way `undefined` would — `recordResult` treats `outcome.status === 'oversize'` as authoritative over that ambiguity regardless of what `value` looks like after the normalisation (a real bug caught by this step's own tests, not a hypothetical).

**Deliberate deviation from the plan's literal §5 text, with reasoning kept in `packages/core/src/jobs/executor.ts`'s own doc comment**: `JobExecutor.run()`'s return type was NOT widened from `Promise<unknown>` to `Promise<{value, outcome?}>` (unlike the plan's own draft snippet at `executor.ts:34-35`). That interface is shared by five unrelated executors (`sleep`, `install`, `workflow`, `remote`, `script`) and dozens of hand-built test mocks across files this step does not own (`plugins/`, `clusters/`, `capability/`, `scripts/`, `registry/`, `api/`, `services/`) — widening it would have been a breaking, all-of-them change for a concept only the script/remote paths have. Instead, `ExecutorContext` gained an `onResultOutcome?: (outcome: ResultOutcome) => void` callback, mirroring `onPeakRss`'s existing exact shape ("called at most once, right before `run()` resolves, by whichever executor has something to report"). `executors/script.ts` and `executors/remote.ts` (plus `protocol/src/tunnel.ts`'s `JobProgressMessage.result.outcome` and `node/src/hosts.ts`, F6 — the remote/cloud path) both wire it; `executor-host.ts`'s `settle()` captures it in a closure exactly like `peakRssBytes`, and — only for a `success` settle (97.4's `partial`, from a `finish()` salvage on a `failed`/`cancelled` settle, is not this step's) — calls `recordResult` and writes `resultStatus`/`resultBytes`/`resultSummary`/`resultIssues` at the single `deps.jobStore.finish(...)` seam the plan named, alongside a corrected `result` (nulled for `oversize` even if the executor returned a value anyway).

A missing outcome on a SUCCESS settle (any executor that never calls `onResultOutcome` — sleep, install, workflow, or a script run by a pre-97.3 bundle) is written as `resultStatus: 'undeclared'`, reading §4.3's "a missing outcome means undeclared" as a uniform rule rather than one scoped only to old script bundles — `RecordedResult` returns a total answer for every successful settle, never a partial one. `ExecutorHostDeps` gained two new OPTIONAL dependencies, `maxResultBytes: () => number` and `resultSummaryFields: (scriptId: string) => SummaryField[]`, both defaulting sensibly (`RESULT_LIMITS.defaultMaxResultBytes`, `[]`) when unsupplied. **`daemon.ts` wiring for these two is NOT done in this pass** — `packages/core/src/daemon.ts` already carries roughly 900 lines of uncommitted changes from a concurrent worker (visible in `git status` at the start of this step), and adding two lines to its `createExecutorHost({...})` call risked a collision for a live-tunability gain the defaults already cover correctly out of the box (the farm behaves exactly as if `job.maxResultBytes` were 65 536 and no script has a `resultSummary` yet — both true today regardless). `resultSummaryFields` has no real producer to call anyway: `scripts.result_schema` (97.2's own deferred item) is not persisted anywhere yet, so every job's `resultSummary` is `null` until that lands.

`packages/core/src/queue/job-store.ts`'s `finish()` gained four optional `resultStatus`/`resultBytes`/`resultSummary`/`resultIssues` fields, written together or not at all (never independently), following the exact `never overwrite with undefined` convention `peakRssBytes` already established. `packages/core/src/db/schema.ts`'s `jobs` table gained the four matching nullable columns, migrated by `bun run --cwd packages/core db:generate` as `drizzle/0052_petite_juggernaut.sql` (never hand-written), with §3.3's backfill (`UPDATE jobs SET result_status = 'undeclared' WHERE finished_at IS NOT NULL`) appended by hand to the generated file, the same `agent_runs.root_run_id` precedent `0031_colorful_smasher.sql` already set for exactly this shape of migration. Because `jobs`/`JobRow` gained four required (if nullable) keys, every literal `JobRow` construction across the tree needed the same mechanical four-line addition in the same commit (00-overview §4.3): `clusters/dispatch.ts` (production), `queue/job-store.ts`'s own `enqueue()`, `jobs/triggers.ts`'s `trigger()`, plus the test fixtures in `clusters/dispatch.test.ts`, `jobs/executor-host.test.ts`, `jobs/executor-kind-dispatch.test.ts`, `jobs/executors/workflow.test.ts`, `jobs/executors/workflow-settings-wiring.test.ts`, and `services/job-service.test.ts` — none of these files are under this step's own ownership list, but leaving them broken was not an option (`bash scripts/typecheck.sh` would fail on `core`), and the fix in every case is the identical four-`null`-field addition a schema-additive column always needs.

`packages/protocol/src/settings.ts`'s `job` block gained `maxResultBytes` (1 024–1 048 576, default 65 536) and `progressIntervalMs` (250–10 000, default 1 000) — `settings.test.ts`'s own exact-equality snapshot of `job`'s defaults, plus the equivalent exact literals in `session/src/runner/job-runner.test.ts` (7 occurrences) and `core/src/services/job-service.test.ts` (2 occurrences), needed the same two-line addition for the same reason as the `JobRow` literals above. `packages/protocol/src/schema/validate.ts` gained `ParamIssueSchema` (the Zod counterpart of the pre-existing `ParamIssue` interface — did not exist before this step despite being referenced by the plan's own §4.3/§4.6 draft code). `packages/protocol/src/index.ts` gained three new append-only export statements (`ResultOutcomeSchema`/`ResultOutcome`, `ParamIssueSchema`, `DANGEROUS_FIELD_NAMES`), each its own statement per the file's contested-file convention.

**Tests**: `packages/session/src/runner/child-entry.test.ts` gained 8 new cases spawning the REAL child process end to end (ready → init → result) — undeclared, H2's exact circular fixture (`const a = {}; a.self = a; return a`) settling `invalid` with H2's own message and no hang, an over-cap value settling `oversize` with no `value` key on the wire, a `__proto__`-at-depth value (built with `JSON.parse`, never an object literal — the same reasoning `schema-form/resolve.test.ts` already documents for the identical hazard one layer up) settling `invalid` with the path named while the value still crosses verbatim, a declared-schema valid case, a declared-schema invalid case proving the value is stored UNCOERCED (an extra key survives), and a proof that an invalid result still settles the job `success` (§3.1 — a gate may refuse, an assertion may only report). `packages/core/src/jobs/result-store.test.ts` (new, 15 cases) unit-tests `recordResult` alone. `packages/core/src/jobs/executor-host.test.ts` gained 4 cases proving the wiring (not `recordResult`'s own logic) actually reaches `finish()`. `packages/protocol/src/schema/result.test.ts` gained a `ResultOutcomeSchema` section (4 cases). Baseline comparison: root `bun test` was 4394/0 before this plan series; after 97.1–97.3 plus other concurrent plans' work it is 4486 pass / 4 fail, the 4 failures pre-existing and unrelated (`packages/core/src/api/jobs.ts(213,49)`'s known `E_BAD_RESPONSE`-shape typecheck failure — a second Claude session outside this workspace, per this step's own brief — plus four `saved-commands`/`daemon.ts`-wiring test failures from plan 93's own in-flight work); Studio is 990/0, green.

**Step 97.4 (what a failed run can still say) is done**, fixing F7/F8. `packages/session/src/runner/child-entry.ts`: `buildResultOutcome` gained a fourth, defaulted parameter (`statusWhenNoSchema: 'undeclared' | 'partial' = 'undeclared'`) so its size/circularity/prototype-pollution guards (F10/V1/V2/V3) serve the salvage path too, without a second copy of that logic. In the main attempt (`:604-654` after this step's edits), when `failure` is set, the salvage value is `value !== undefined ? value : finishValue` (`run()`'s own value wins — the only way both can be defined at once is `run()` succeeding and `finish()` itself then throwing, since a function cannot both return and throw; the precedence is coded explicitly rather than left to that accident) — sent with `outcome.status = 'partial'`, **never** against `def.result`, even when the script declared one (§3.5: "there is no honest lenient schema" — the salvage call always passes `resultSchema: undefined`). `undefined` on both sides (`finish()` returns nothing, or there is no `finish()` at all) sends the exact pre-97.4 message — byte-identical, asserted directly. The finish-only re-attempt path (`init.mode === 'finish-only'`, spec §11.2's fresh process after a timeout kill) carries the same value the same way. `packages/session/src/runner/job-runner.ts`'s `execute()` had a second gap this step had to close, not named in the plan's own checklist text: the finish-only re-attempt's own `AttemptOutcome` (`finishOutcome`) was computed and used only for `noteAttemptPeak` — its `value`/`outcome` were silently dropped rather than reaching `execute()`'s final return, which is the ONLY carrier for a salvage after a timeout kill (the original attempt's own value/outcome are already discarded by the parent's `abortReason` branch, by design — "the parent decides to abort, the parent also decides the reason"). Fixed by merging `finishOutcome.value`/`.outcome` onto `outcome` immediately after it resolves, keeping `outcome.error`/`.code`/`.finishRan` as the ORIGINAL attempt's own (the retry classifier just below reads `outcome.error`, and a finish-only run has none of its own to classify).

`packages/core/src/jobs/executors/script.ts`'s `ctx.onResultOutcome` call lost its `result.ok &&` guard — now fires whether `run()` is about to resolve or throw, mirroring `ctx.onPeakRss` exactly ("called at most once, right before this method settles either way"); a salvage `value`, when the runner reports one alongside a failure, now rides the thrown error as a new `partialResult` property (`JobExecutor.run()` rejects on failure per this plan's own step-97.3 deviation note, and has no resolved return value left to carry one on — the same reasoning `code`/`phase` already ride the thrown error for). `executors/remote.ts` (F6, the cloud/node path) mirrors both changes. `packages/core/src/jobs/executor-host.ts`: the `.catch()` settle handler now extracts `partialResult` off the thrown error (beside its existing `code`/`phase` extraction) and passes both it and the closure-captured `resultOutcome` into `settle()`; `settle()`'s own `recorded` computation now also asks `recordResult` for a `failed`/`cancelled` status whenever `data.outcome !== undefined` (not only for `success`), threading `job.resultStatus` through as `recordResult`'s new `existingStatus` input. `packages/core/src/jobs/result-store.ts`'s `recordResult` gained that `existingStatus` parameter and now returns `RecordedResult | null` — `null` exactly once, when a computed `'partial'` would downgrade an already-recorded `'valid'` (defensive rather than reachable proof: a job settles exactly once under today's call graph, but `finish()` re-running in a fresh process after a timeout kill, spec §11.2, is exactly the ordering that makes the guard worth having regardless); the caller's pre-existing `recorded ? {...columns} : {}` pattern already leaves every `result_*` column untouched for a `null` return, the same as "nothing to report". `partial` was already structurally incapable of setting `resultIssues` (only `status === 'invalid'` ever does), confirmed rather than newly added, and pinned by a dedicated test.

**Tests for 97.4**: `child-entry.test.ts` gained 11 new cases in a new describe block — the verbatim scenario (`run()` throws after real work, `finish()` returns `{ videosBeforeFailure: 280 }` → `partial` alongside the unchanged error), a byte-identical-error proof (with/without a salvage, comparing `code`/`message`/`phase` only — `stack` legitimately differs per tmp-dir bundle path), two "nothing changes" cases (`finish()` returns nothing; no `finish()` at all), the `run()`-wins case (`run()` succeeds, `finish()` itself throws), a no-schema-check proof (a declared `result` schema the salvage would fail is still sent as `partial`, unvalidated), the circular/oversize guards reused on the salvage path, and two finish-only-path cases. `job-runner.test.ts` gained 2 cases proving the `finishOutcome` merge (with and without a salvage). `executor-host.test.ts`'s pre-97.4 pin ("a FAILED job never gets a resultStatus written... 97.4's partial... is not this step's") was replaced with four cases: the old no-outcome case (still untouched, renamed), the gap now closed (`failed` + a reported `partial` outcome → `resultStatus: 'partial'`), the same for `cancelled`, and the `existingStatus` "never downgrade" guard driven through `job.resultStatus`. `executors/script.test.ts` gained 3 cases proving `ctx.onResultOutcome`/`partialResult` wiring directly against a fake runner (success unchanged; failure-with-outcome now fires and attaches; failure-with-nothing stays silent). `result-store.test.ts` gained 5 cases (partial records verbatim with no existing status; partial never sets `resultIssues` even if fed some; the downgrade refusal; every non-`'valid'` existing status still records; a re-checked oversize still wins over `existingStatus`). Baseline comparison: root `bun test` was 4486 pass / 4 fail before this step (the 4 pre-existing and unrelated — `packages/core/src/api/jobs.ts`'s known typecheck-only issue does not affect `bun test`, and `saved-commands-mount.test.ts`'s 4 deliberate failures are a different worker's own self-detecting guard); after this step it is **4518 pass / 4 fail**, the same 4 (verified by mtime — untouched by this step) plus 32 new passing cases; Studio stays 990/0, untouched (no Studio file in this step's ownership). `daemon.ts`/`daemon-wiring.test.ts` were also touched — see Task B2 below, a relay item from step 97.3's own author, not part of 97.4's own checklist.

`docs/plans/00-overview.md` §9 gained the migration row step 97.3 could not write itself (a concurrent worker held the file) — this step, as the actual producer of `partial`, wrote the row with its last sentence describing itself as the producer rather than leaving it stale.

**A relay item from step 97.3's own author, not this step's checklist but landed alongside it**: `packages/core/src/daemon.ts`'s `createExecutorHost({...})` call gained the two `ExecutorHostDeps` step 97.3 built but could not wire (a concurrent worker held `daemon.ts` at the time) — `maxResultBytes: () => settingsStore.get().job.maxResultBytes` (live-tunable from Studio, previously silently defaulting to the schema's own 65 536) and `resultSummaryFields: () => []` (wired explicitly even though it has no real producer yet — `scripts.result_schema`'s publish-time storage is still step 97.2's own open item, out of `packages/core/src/scripts/**`'s reach for this worker — so the seam is ready the moment that producer lands, with no second `daemon.ts` edit required). Pinned in `daemon-wiring.test.ts`'s new "script results" describe block, following the file's own anchored `extractCall` style rather than a fixed-offset slice.

**Step 97.5 (the read paths) is done for every piece its file list actually owns**, fixing F18's blind spots, F21, F22 and answering most of F23 — `packages/protocol/src/messages/job.ts` gained §4.6's additions verbatim: `JobInfoSchema` gains `resultStatus`/`resultSummary` (both `.nullable().default(null)`, `result` itself stays off the list per F18); `JobDetailSchema` gains `resultBytes`/`resultIssues`/`resultSchema` (same discipline, `resultSchema` sourced from `JsonSchemaNodeSchema`, `resultIssues` from the existing `ParamIssueSchema`); `JobSummarySchema` gains `resultStatus` ONLY, un-defaulted (`.nullable()`, matching the plan's own §4.6 snippet and every sibling field on that type) — never the value, never the summary text, keeping plan 80 §3.3's rule intact. `packages/core/src/queue/job-store.ts`'s `rowToJobInfo`/`rowToJobDetail` both project the new columns (`resultStatus`/`resultSummary` straight off the `jobs` row, already written since 97.3; `resultBytes`/`resultIssues` the same); `rowToJobDetail` takes an inlining `resultSchema` off its existing `script` parameter rather than a second fetch, exactly as §4.6 argues. **One real gap, not glossed over**: `scripts.resultSchema` does not exist yet — step 97.2's own status paragraph above names it as still-open storage, and `packages/core/src/db/schema.ts` is off this step's file list (held for plan 94 step 94.8, unrelated). So `rowToJobDetail`'s `resultSchema` plumbing is real and forward-compatible (no second edit needed once the column lands) but reads back `null` for every job today — criterion 9's "proved across a republish" cannot be demonstrated until that column exists. `packages/core/src/api/jobs.ts`'s two routes (`GET /`, `GET /:id`) needed no code change at all: both already call `typedJson` against `JobsPageResponseSchema`/`JobResponseSchema`, which reference `JobInfoSchema`/`JobDetailSchema` directly, and `service.list`/`service.get` already thread `job-store.ts`'s enriched projections through — confirmed by `bash scripts/typecheck.sh` and the full test suite, not merely asserted. `packages/sdk/src/types.ts` and `packages/session/src/runner/jobs-client.ts` both gained `resultOf<T>(jobId, schema: z.ZodType<T>): Promise<T | null>` as a second overload beside the existing untyped one — validated **child-side**, mirroring `kv-client.ts`'s `get` exactly (same `safeParse`-then-throw shape, an error naming the job id and the mismatched path, `E_RESULT_SCHEMA_MISMATCH`); the unvalidated overload, and `script-jobs.ts`'s three refusals (`not-found`/`foreign-namespace`/`not-finished` collapsing to `null`), are byte-for-byte unchanged — no server edit. `packages/core/src/capability/script.ts`'s `ScriptDetailSchema` gained `resultSchema` (`.nullable().default(null)`) for the same reason and the same real gap as `job-store.ts` above: `ctx.scripts.get()` has no column to read it from yet, so the handler now returns `{ ...script, resultSchema: null }` — structurally ready, `null` until 97.2's storage half lands. **Not done, outside this step's file-ownership list**: `packages/core/src/mcp/server.ts:89`'s `outputSchema` (F23's other half) — not named among the files this pass was told it owns, left for whoever holds `core/src/mcp/**`. Two relay items landed alongside this step, both explicitly asked for: `packages/studio/src/components/JobsList.tsx` gained a muted `resultSummary` line under the script name/assist badge; `packages/studio/src/lib/jobs.ts`'s `readFindings`/`severityTone`/`JobFinding` (F20's dead opportunistic guess, zero consumers since 97.6 removed the last one) are deleted, replaced with a one-paragraph comment pointing at `result-view/` as the real answer — `jobs.test.ts` needed no edit, since it already carried no test for the three. `docs/plans/00-overview.md` §2 also gained the two relay rows plan 98 and plan 99's own step 99.12 could not write themselves (both files held by concurrent workers at the time). **Test-file fallout, not a checklist item but required by the schema change**: `packages/core/src/api/jobs.test.ts`, `packages/core/src/server/ws-handlers-job.test.ts` and `packages/session/src/runner/jobs-client.test.ts`'s hand-built `JobInfo`/`JobDetail`/`JobSummary` fixtures gained the new required-shaped fields (`.default(null)` makes a key optional on **input** through `.parse()`, not on the inferred **output** type a hand-built object must satisfy) — no test's assertions changed, only its fixtures. Baseline comparison: root `bun test` was 4550/0 before this step; after, it is **4549 pass / 1 fail**, the 1 a pre-existing, out-of-scope failure (`packages/core/src/schedules/runner.test.ts`'s `cancel-previous` case, which calls `stopBatch` in `packages/core/src/api/batches.ts` — a file explicitly off this step's list, held by a concurrent worker for plan 94 step 94.8; confirmed unrelated by tracing the call graph, not merely by exclusion). Studio stays 1068/0. `bash scripts/typecheck.sh` shows the same one pre-existing `packages/core/src/api/jobs.ts(229,49)` failure named in this step's own brief (the duplicated `JobNodesResponseSchema`, left untouched per instruction) plus the `packages/core/src/api/batches.ts`/`packages/studio/src/app/batches/**` failures from that same concurrent worker's in-progress `BatchCancelResponseSchema`/`stopping` work — none of them this step's. `bun run --cwd packages/studio build` is green, alone. `bun run spec:check` — GAP 0. `bash scripts/check-plan-status.sh` — passes.

**Step 97.6 (a result that reads as values) is mostly done**, fixing F19/F20 and testing H3 — but it lands ahead of 97.5, which it depends on for real data, so it is built and independently tested rather than wired end-to-end. `packages/studio/src/components/result-view/plan-result.ts`: `planResult(schema, value): PlannedResultField[]`, §3.6's three rules (R1 branch selection via `validateAgainstSchema`, matching Zod's own extra-key-tolerant semantics — F25 — rather than a stricter reading; R2 record expansion off `additionalProperties`; R3 unknown value keys, appended after the declared fields, `DANGEROUS_FIELD_NAMES`-filtered per V3) and nothing else, scoped deliberately to the result's TOP LEVEL only (matching `summaryFields`'s own "top-level" convention and H3's own evidence — a flat object of scalars plus at most one record) — a field several levels deep that is itself a union or record still renders through `planField`'s own `json` terminal rather than raw JSON with no explanation, and widening R1/R2 below the top level is named as future work, not hidden. Delegates every structural decision to `planField` (K3), never reimplementing a row. `packages/studio/src/components/result-view/ResultView.tsx`: a read-only recursive renderer pairing `planField`'s own static `FieldPlan` tree (`group.children`/`table.columns`/`list.item`, unchanged, arbitrary depth) with the matching slice of the actual value at render time — this is what makes a NESTED object (not just a top-level record) show real formatted values rather than degrading to raw JSON one level down, discovered by this step's own component test (an ordinary nested `z.object()` branch of a union rendered as an empty group before this fix, because only R2's record case had been threading values into `group.children`). Every scalar control routes through `formatValue` (K4); `toggle`→Yes/No, `choice`→its label, `pair`→`formatValue` on the array-of-two, `text`→itself, everything else→raw JSON (never `dangerouslySetInnerHTML`, plan 95 F23). `packages/studio/src/app/jobs/detail/page.tsx`: `<ResultView>` mounts when `job.resultSchema` is present (the "returned" block, previously at the plan's cited `:493-534`, actually at `:1085-1125` before this step — stale line numbers again, re-verified against the live file per this step's own brief), today's `<pre>` otherwise; the three status banners from §4.8 (`oversize` — checked FIRST, since `jobs.result` is `NULL` by construction for it regardless of whether a schema exists; `invalid` — the paths from `resultIssues`; `partial` — §3.5's verbatim line, "this run failed — these are the values it had reached"). F20's opportunistic `readFindings`/`severityTone`/`JobFinding` guess is no longer called from this page (its branch and the `findings` `useMemo` are removed, and `page.test.tsx`'s findings-list test was rewritten to pin the new byte-identical-raw behaviour for a schema-less result of ANY shape) — the three definitions themselves and their own test block live in `packages/studio/src/lib/jobs.ts`, outside this step's file-ownership list, so deleting them is left for whoever holds that file. **Not done, out of this step's reach**: `JobsList.tsx`'s `resultSummary` line (same file-ownership reason, and the field is not on the wire yet regardless); and, most importantly, the wiring that makes any of this fire in production — `JobDetailSchema` does not carry `resultStatus`/`resultBytes`/`resultIssues`/`resultSchema`/`resultSummary` until 97.5 lands (`packages/protocol/**`/`packages/core/**`, both outside this step's reach), and Zod strips any key a schema does not declare, so `page.tsx` reads them through a local, all-optional `JobWithResultInfo` intersection type that compiles and degrades to exactly today's behaviour now, and needs no further edit once 97.5 adds the matching keys. `plan-result.test.ts` (14 cases: delegation/H3, R1×3 including K7's `wrong-branch`, R2×3 including K7's `record-no-properties`, R3×3 including a `JSON.parse`-built `__proto__` value key, totality/K7's full hostile-schema-fixture sweep) and `ResultView.test.tsx` (8 cases) are both new and pass; `page.test.tsx`'s existing suite (26 cases, one rewritten) still passes. Studio was 1046/0 before this step; it is 1068/0 after (root `bash scripts/typecheck.sh` unchanged — `core`'s pre-existing `api/jobs.ts` failure is untouched, not this step's; root `bun test` 4534/0; `bun run spec:check` GAP 0; `bun run --cwd packages/studio build` green, alone).

**Not done, explicitly out of scope for this step**: 97.5 (the read paths — `JobInfo`/`JobDetail`/`JobSummary`, `rowToJobInfo`/`rowToJobDetail`, `GET /api/jobs*`, `resultOf`'s schema overload, `capability/script.ts`, MCP `outputSchema`), 97.8 (the tiktok pack worked example), 97.9 (documentation). (97.7, `ctx.progress`, is done as of the paragraph below — the two settings fields this paragraph refers to as landing early are now actually consumed.)

**Step 97.7 (live progress, which is not a result) is done for every piece this pass's file-ownership list actually owns**, answering H4. `packages/sdk/src/types.ts`: `ScriptContext` gains a REQUIRED `progress(value: unknown): void` (not optional, unlike `onAssist` — every script gets it, the same way every script gets `log`), documented as "an observation, never a commitment" per §3.7's own closing line; `define-recording.test.ts`'s hand-built `ScriptContext` literal needed the one-line `progress: () => {}` addition the new required key forces (the same mechanical fallout every schema-additive field in this plan has caused elsewhere — see 97.5's own `JobInfo`/`JobDetail` note above).

`packages/session/src/runner/ipc.ts`: `ChildToParentSchema` gains `{ t: 'progress', value: z.unknown() }`; the `init` message gains an OPTIONAL `progressIntervalMs` (unlike `maxResultBytes`, which is required — a finish-only attempt's short window has no live audience worth the timer, so `job-runner.ts` only resolves this for a `'full'` attempt and the child falls back to a hardcoded default, `1_000`, mirroring `job.progressIntervalMs`'s own zod default rather than importing it, the same "one hardcoded number per file" convention `RESULT_LIMITS.defaultMaxResultBytes` already set for `maxResultBytes`'s own fallback).

`packages/session/src/runner/child-entry.ts`: `createProgressReporter(intervalMs)` is the coalescing timer itself — ONE `setInterval`, started lazily on the FIRST `progress()` call (a script that never calls it never runs a timer at all), last-value-wins (`pending = { value }` is the only work a call does — one assignment, exactly H4's own cost bound), cleared in the same `finally` block that already clears `heartbeat`/`rssTimer` so a coalescing timer can never outlive the attempt (00-overview §7). A circular/unserialisable progress value is caught and dropped silently at the `send()` call inside the timer tick — best-effort, never a crash, and never reported as `resultStatus: 'invalid'` the way a bad `run()` return value is (§3.7's own "only one of them is a commitment").

`packages/core/src/jobs/executor-host.ts`: `ExecutorHost` gains `progress(jobId, value): void` — the size check and the one-`warn`-per-job rule both live HERE, not in the child (unlike a result's `outcome.bytes`, a progress push carries no self-reported size, so the host re-measures with `TextEncoder`/`JSON.stringify`, catching an unserialisable value the same as oversize). A `warnedProgress` Set (mirroring `crashHandlers`/`assistHandlers`'s own per-job lifecycle exactly, cleared in both `settle()` and `stopAll()`) is what makes it ONE warning per job regardless of how many oversize pushes follow — a script emitting a bad value in a loop floods nothing. A push for a job that already settled (`!running.has(jobId)`) is a silent no-op — a normal race with the settle path, not a script error. `ExecutorHostDeps` gains an optional `onProgress: (jobId, deviceId, value) => void` — broadcasting is the ONLY thing it does; `progress()` itself never touches `jobStore`.

`packages/session/src/runner/job-runner.ts`: `JobRunnerDeps` gains an optional `onProgress: (jobId, value) => void`, called from `handleChildMessage`'s new `msg.t === 'progress'` branch with the child's value forwarded VERBATIM (no measuring, no dropping, no rate-limiting here — §3.7's "the runner reports, the host decides" split, the same division `onReset`/`onRetry` already have between this file and `daemon.ts`). A `progress` message DOES heartbeat the lease, unlike `rss` — the existing `if (msg.t !== 'rss') deps.heartbeat(job.id)` line needed no change, since a script emitting progress is proof of life exactly like a log line already is. `runAttempt`'s opts gain `progressIntervalMs?: number`, read fresh per attempt from `settings.progressIntervalMs` (the live farm setting) for a `'full'` attempt only, and `sendInit` passes `opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS` (`1_000`, the same self-contained-default convention noted above) into `init`.

`packages/core/src/daemon.ts`: the `createJobRunner({...})` call gains `onProgress: (jobId, value) => host.progress(jobId, value)` and the `createExecutorHost({...})` call gains `onProgress: (jobId, deviceId, value) => hub.broadcast({ type: 'job.progress', payload: { jobId, deviceId, value } })` — the exact `job-runner.ts → executor-host.ts → hub.broadcast` chain the step's own brief named, with the size check and the warn-once rule sitting in the middle hop, not either end.

`packages/protocol/src/messages/job.ts` gains `JobProgressEventMessage` (`{ type: 'job.progress', payload: { jobId, deviceId, value: z.unknown() } }`) verbatim per §4.6; `packages/protocol/src/index.ts` gains it in `ServerMessageSchema`'s array (appended last, past `CommandFinishedMessage`, per the file's own contested-file convention) plus two append-only statements (a new import block, mirroring `messages/co-control`'s/`messages/recording`'s/`messages/command`'s own split-import pattern, and a re-export at the very end of the file) — no existing line in either block was touched. `RESULT_LIMITS.maxProgressBytes` and `job.progressIntervalMs` needed no new code at all: both were already built by 97.2/97.3, unused until this step.

**No DB write anywhere on this path — proved, not asserted**: `packages/core/src/jobs/executor-host-progress.test.ts` (new, 3 cases) is this step's own `Ships:`-worthy artefact — its third case opens a REAL `bun:sqlite` handle via `openDb(':memory:')`, runs the real migrations, seeds a real job row through the real `createJobStore`, monkey-patches `sqlite.prepare` (the one method every drizzle-orm/bun-sqlite query — `.run()`/`.get()`/`.all()` alike — funnels through) to count every statement matching `/^\s*UPDATE/i`, calls `host.progress()` **10 000 times**, and asserts `updateCount === 0` while `onProgress` fired all 10 000 times. The other two cases in that file prove the size cap (`RESULT_LIMITS.maxProgressBytes`) drops an oversize push with exactly ONE `warn` no matter how many follow, and that a push for a job that never started (or already settled) is a silent no-op.

`packages/session/src/runner/child-entry.test.ts` gains a new describe block (2 cases) spawning the REAL child process end to end: a bundle calling `ctx.progress()` 10 000 times synchronously in a tight loop, then sleeping 450ms at a 100ms `progressIntervalMs`, receives well under 10 `progress` IPC messages (never 10 000 — H4's own claim, proved at the actual process boundary, not a fake timer) and the LAST message carries the LAST value the loop set (`{ i: 9999 }`, proving "last value wins" rather than "first" or an arbitrary one); a script that never calls `progress()` sends no `progress` message at all. `packages/session/src/runner/job-runner.test.ts` gains a new describe block (3 cases): a `progress` message from a fake child reaches `deps.onProgress(jobId, value)` verbatim; a caller that never wires `onProgress` is unaffected (no throw); a `'full'` attempt's `init` carries `job.progressIntervalMs` resolved fresh from the settings getter, mirroring `maxResultBytes`'s own existing test.

Baseline comparison: root `bun test` was 4549 pass / 1 fail before this step's own work started in this session (the 1 failure being plan 94 step 94.8's in-flight `packages/core/src/schedules/runner.test.ts` cancel-previous case, entirely unrelated); by the time this step's own test run happened, that concurrent worker had already landed its fix, so the observed baseline plus this step's 8 new cases is **4563 pass / 0 fail**. Studio: 1076 pass / 0 fail (unrelated Studio-side test growth from a concurrent worker; this step touched no Studio file). `bash scripts/typecheck.sh` shows the same one pre-existing, explicitly-not-mine `packages/core/src/api/jobs.ts(229,49)` failure named in this step's own brief — unchanged. `bun run --cwd packages/studio build` is green, alone. `bun run spec:check` — GAP 0. `bash scripts/check-plan-status.sh` — passes, no diagnostic for this plan.

**Two items named in step 97.7's own checklist are explicitly not done, both for the same reason**: `packages/protocol/src/tunnel.ts`'s cloud-path `kind: 'progress'` and `packages/studio/src/app/jobs/detail/page.tsx`'s live progress line are both outside this pass's file-ownership list (`packages/sdk/**`, `packages/session/src/runner/**`, `packages/core/src/jobs/**`, `packages/protocol/src/schema/**`, `messages/job.ts`, `index.ts` — additive only). The local (non-cloud) path is complete, tested end to end at the process boundary, and self-contained; a node-owned device's job simply has no live progress forwarded over the tunnel yet, and Studio has nothing to render yet even for a local job — both real, named gaps for whoever picks up `tunnel.ts`/`packages/studio/**` next, not silent ones. `docs/spec.md` needs one new sentence for `job.progress` (relayed to the plan-97 orchestrator rather than written directly — `docs/spec.md` is off this pass's file list, held for plan 94 step 94.8): *"`job.progress` — a live, unpersisted snapshot pushed while a job runs (`ctx.progress()`); never stored, never validated, never readable after the job ends."*

**Steps 97.2's remaining checklist items and 97.8 (the worked example) are DONE, closing the storage gap named by the plan's own `> Status:` line ("three correct steps that have not met").** `packages/core/src/db/schema.ts` gains `scripts.resultSchema` (nullable JSON, beside `paramsSchema`), migrated as `drizzle/0055_cheerful_wallflower.sql` (`bun run --cwd packages/core db:generate`, never hand-written — a single plain `ALTER TABLE scripts ADD result_schema text`). The publish path stores it exactly the way `paramsSchema`/`runtime` already travel, at all three sanctioned publish paths (K2): `scripts/routes.ts`'s `POST /` (`PublishBody.resultSchema`, `checkDeclaredSchema`-gated as `E_RESULT_SCHEMA_INVALID` before `publishScript` runs, `GET /:id` serves it back, `GET /` serves `hasResult: boolean` only per §4.7's own table), `sdk/src/cli/publish.ts` (`z.toJSONSchema(result, {io:'output'})` at its own call site, `checkAndReportResultSchema`, `warnAboutRefinements` — all only when `def.result !== undefined`), and `plugins/verify-child-entry.ts` (the same for every plugin member, `E_RESULT_SCHEMA_INVALID` naming the member id; `verify-child.ts`/`plugins/runtime.ts`'s `writeScriptRows` carry it through to the `scripts` insert). **The read side that actually reaches `GET /api/jobs/:id`** is `queue/job-store.ts`'s `scriptNames()`, widened with an additive `resultSchema` field selected straight off `scripts.result_schema` — `services/job-service.ts` (a concurrent worker's file, untouched) already forwards that map's value straight into `rowToJobDetail`, so this one function is the entire read-side fix, with no edit anywhere outside this pass's own ownership list. `capability/script.ts`'s `scriptGet` handler had a real bug fixed alongside this: it hardcoded `resultSchema: null` even after spreading the real value, silently discarding it forever — now forwards the genuine value. `sdk/src/plugin.ts`'s `PluginMemberScript<S>` gained the second generic (`PluginMemberScript<S, R>`), closing 97.2's own named gap for "whoever picks up 97.8" — not via the two-independent-array-generic approach that note speculated about (tried; `tsc` cannot reverse-infer a second array generic from the same `keyof S` mapped-type position a first one already occupies, confirmed by a failing `plugin-result.type-test.ts` draft before the working version), but by loosening the ARRAY position's own `R` to `z.ZodTypeAny | undefined` and proving H1 at each member's own `const` declaration instead (`switch-account.ts`/`search-follow.ts` already used this pattern; `auto-scroll` was refactored out of its inline object literal into `paramsSchema`/`autoScrollScript` consts to get the same proof). 97.8 declares `result` for all three pack scripts (`auto-scroll`'s thirteen fields — H3's exact worked example, `summary: true` on `videos`/`watchSeconds` — plus `switch-account` and `search-follow`, so no close-out note about "nothing to return" was needed) and replaces `auto-scroll`'s one-shot `ctx.log.info('finished scrolling', ...)` with `ctx.progress({...})` calls inside the per-video loop (H4, proved against the real script rather than a synthetic one). `packages/core/src/scripts/publish-result-e2e.test.ts` (new, 2 cases) is the end-to-end proof the plan's own `> Status:` line asked for: publishes a script declaring `result` through the real `POST /api/scripts` route, settles a job for it (`jobStore.claimNext` + `jobs/result-store.ts`'s real `recordResult`, imported rather than re-implemented), and asserts `rowToJobDetail` — the exact function `GET /api/jobs/:id` serves from — returns a non-null `resultSchema` equal to what was published and `resultStatus: 'valid'`; the second case proves a hostile result schema (`__proto__`, `JSON.parse`-built) is refused at publish before reaching storage. Baseline comparison: root `bun test` was 4563 pass / 0 fail before this pass; after, **4596 pass / 0 fail** (the extra growth beyond this pass's own ~40 new cases is unrelated concurrent work already in the tree). `bash scripts/typecheck.sh` shows the same one pre-existing, explicitly-not-mine `packages/core/src/api/jobs.ts(229,49)` failure — unchanged, confirmed still present and untouched. `bun run --cwd packages/studio test` is 1070 pass / 6 fail — all six pre-existing (`ScheduleEditorDialog.test.tsx` ×4, `workflows/editor/page.test.tsx` ×2), in files this pass never touched and outside `packages/studio/**`'s exclusion from this pass's file list entirely; not this pass's regression. `bun run --cwd packages/studio build` is green, alone. `bun run spec:check` — GAP 0. `bash scripts/check-plan-status.sh` — passes.
> Depends on: Plan 05 (the script framework, `defineScript`, the child-process runner), Plan 60 (`result` reached `JobDetail` and the Summary tab; `errorPhase`), Plan 79 (the KV store — the 64 KiB precedent this plan reuses), Plan 80 (`ctx.jobs.resultOf`, the cross-script read door that already exists), Plan 81 (trigger lineage — the only shipped way one job feeds another), Plan 82 (plugins and the verify child), **Plan 95 (the parameter vocabulary, the limits, the shared validator, the resolver — this plan is its mirror and reuses its machinery rather than building a second one)**. None of them needs to change first; 97.1 moves and renames three of plan 95's exports and migrates every call site in the same commit (00-overview §4.3).
> Spec references: §11.1 (script shape — the `return { ok: true }` in the spec's own example), §11.2 ("Artifacts per job: screenshots, logs, **results**"), §12 (data model — `jobs.result`, `scripts.params_schema`), §13 (the Core⇄Studio protocol), §16 (NFR), §19 (schema-driven UI — *"no hardcoded UI per component"*)
> Ships: packages/core/src/jobs/result-store.ts

---

## 0. Evidence

Every claim below is either **CONFIRMED** — there is a file and a line, or a
measurement taken against this workspace's own installed Zod under Bun — or
**HYPOTHESIS**, with the step that tests it. Measurements marked *(measured)*
were produced by a throwaway probe; this document restates their output rather
than shipping the probe.

The brief this was written against: a script's **input** is typed, validated on
both sides, and renders a generated form (plan 95, shipped 2026-08-11). Its
**output** is an unvalidated JSON blob nobody can rely on. The owner wants
workflows — a pipeline of scripts feeding each other, with evaluation nodes
that read a previous node's output and decide whether to continue. An edge in
that pipeline cannot carry an untyped blob.

### 0.1 Confirmed findings

#### The contract that does not exist

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | `defineScript` validates four things — `id`, semver `version`, `run` is a function, `params` has `safeParse` — and **says nothing whatsoever about the return value**. There is no `result`, `output` or `returns` field on the definition. | `packages/sdk/src/define-script.ts:11-19`, esp. `:15-17` |
| **F2** | `run` is declared `Promise<unknown>`, and the entire statement of the output contract in this product is a **one-line doc comment**: `/** Return value → jobs.result. */`. `ScriptDefinition` is generic over the params schema only. | `packages/sdk/src/types.ts:293-294`; `:277` |
| **F3** | `jobs.result` is `text('result', { mode: 'json' })` — no `NOT NULL`, no size constraint, no shape. | `packages/core/src/db/schema.ts:223` |
| **F4** | The value is `unknown` at **every** hop and is never validated, never measured and never narrowed on any of them. The full chain: produced → sent → IPC schema → runner outcome → executor → host → store → column → wire → `<pre>`. | `packages/session/src/runner/child-entry.ts:429`, `:449-454`; `packages/session/src/runner/ipc.ts:200`; `packages/session/src/runner/job-runner.ts:58`, `:201`, `:625`, `:837`; `packages/core/src/jobs/executors/script.ts:110`; `packages/core/src/jobs/executor-host.ts:229`, `:167`; `packages/core/src/queue/job-store.ts:343-351`; `packages/core/src/db/schema.ts:223`; `packages/protocol/src/messages/job.ts:128`; `packages/studio/src/app/jobs/detail/page.tsx:531` |
| **F5** | `scripts` has `paramsSchema` (`params_schema`, JSON) and **no output sibling**. The agent-facing `ScriptDetailSchema` likewise carries `paramsSchema: z.unknown()` and nothing for the return value. | `packages/core/src/db/schema.ts:376`; `packages/core/src/capability/script.ts:22-31` |
| **F6** | The remote/cloud path is a **second, parallel result boundary** with the same `z.unknown()` hole. Anything added here must cross it too. | `packages/protocol/src/tunnel.ts:220-244`, esp. `:235-242`; `packages/core/src/jobs/executors/remote.ts:32`, `:134-139`; `packages/node/src/hosts.ts:337-345` |

#### What happens when a script fails, or returns something impossible

| # | Finding | Evidence |
|---|---------|----------|
| **F7** | On failure the value is **discarded entirely**: the child sends `error` *or* `value`, never both. A run that scrolled for forty minutes and then threw reports nothing structured at all. | `packages/session/src/runner/child-entry.ts:452` |
| **F8** | `finish` returns `Promise<void>`, so a failed job has **no channel** for a structured report even though `finish` is the one hook guaranteed to run after a failure with `ctx.error` set. | `packages/sdk/src/types.ts:296`; `:270` |
| **F9** | The `jobs` row's failure vocabulary is `error` (text), `failureClass` (`'infra' \| 'script' \| 'load'`) and `errorPhase`. **`errorClass` and `stopReason` are not job columns at all** — they belong to `agent_runs`. Any design that reasons from "jobs already has `errorClass`/`stopReason`" is reasoning about the wrong table. | `packages/core/src/db/schema.ts:224`, `:239`, `:248`; `agent_runs` at `:940`, `:941` |
| **F10** | `send()` in the child **silently drops** any message that fails `ChildToParentSchema.safeParse` — a bare `return`, no log, no throw. So a size or shape constraint expressed *in the IPC schema* would produce a silent hang to the 30 s silence timer, not an error. Any cap must be measured explicitly before the message is built. | `packages/session/src/runner/child-entry.ts:20-24`, esp. `:22`; silence timer at `packages/session/src/runner/job-runner.ts:48` |

#### Size — there is no bound anywhere, and the repo already knows the right number

| # | Finding | Evidence |
|---|---------|----------|
| **F11** | **There is no size bound on a job result at any layer.** Not in the child, not in the IPC schema, not in the executor, not in the store, not in SQLite. `openDb` sets exactly two pragmas — `journal_mode = WAL` and `foreign_keys = ON` — so the only ceiling is SQLite's built-in ~1 GB per row. | `packages/core/src/db/index.ts:18-25`; `packages/core/src/queue/job-store.ts:343-351`; repo-wide search for `RESULT_TOO_LARGE`, `maxResult`, `resultBytes` → zero hits |
| **F12** | **The KV store is the other place a script persists structured JSON, and it caps a value at exactly 64 KiB** — `kv.maxValueBytes`, default `65_536`, settings-visible, refused **by name** with the byte count in the message, measured on the JSON plaintext before writing. Its own schema comment names the anti-goal: *"quotas so a retry loop cannot turn it into a place to keep a 40 MB screenshot."* | `packages/protocol/src/settings.ts:1200-1206`, `:1191-1197`; `packages/core/src/kv/store.ts:126-132` |
| **F13** | `MAX_BUFFERED = 512 * 1024` guards the **video** send path only, and by *buffer depth*, not payload size. JSON control messages are not gated by it. It is **plan 85's** number (`§3.6`), not plan 92's — plan 92 is `> Status: not started`. | `packages/core/src/server/ws-handlers.ts:52-59`, `:597-616`; `docs/plans/92-m57-wall-first-and-video-quality.md:3` |
| **F14** | Plan 93's 32 KB retained / 2 KB previewed command-output caps are **not shipped**: plan 93 is `> Status: not started` and no `fanoutMaxOutputBytes` exists in code. They are design precedent, not current behaviour. The shipped analogue is `shell.maxOutputBytes`, 256 KiB. | `docs/plans/93-m58-command-console-and-bulk-operations.md:3`, `:316-326`, `:826-832`; `packages/protocol/src/settings.ts:933-940` |
| **F15** | There are **three** WS send helpers and none is backpressure- or size-aware; only the fleet broadcast validates. There is no single chokepoint a payload cap could sit at. | `packages/core/src/server/ws.ts:27-33`; `packages/core/src/server/ws-handlers.ts:290`; `packages/core/src/server/ws-handlers-agent.ts:41-42` |
| **F16** | There is **no shared byte-size helper**. `new TextEncoder().encode(x).length` is hand-rolled in five places; `kv/store.ts:126-131` is the cleanest and is the pattern to copy. | `packages/core/src/kv/store.ts:126-131`; `packages/core/src/workspace/path.ts:45-48`; `packages/core/src/scripts/build.ts:218-221`; `packages/core/src/agent/harness/enkaku-vfs.ts:166`, `:190`; `packages/session/src/runner/job-logger.ts:75` |
| **F17** | **Artifacts are already the large-payload path**, reachable from every script (`ctx.artifact.file`), broadcast live on save, with `sizeBytes` and retention. Their 8 MB guard fires **only** for `kind === 'file'`. | `packages/core/src/runner/artifact-store.ts:42-60`, `:44-46`; `packages/sdk/src/types.ts:118-122`; `packages/core/src/daemon.ts:542`, `:1126`; `packages/core/src/db/schema.ts:436-453` |

#### Where a result surfaces today

| # | Finding | Evidence |
|---|---------|----------|
| **F18** | `result` is **deliberately detail-only**: on `JobDetailSchema`, and deliberately absent from `JobInfoSchema` (the list) and `JobSummarySchema` (what a neighbouring script sees), each with its reasoning written at the declaration. The `job.status` WS event carries no result either. | `packages/protocol/src/messages/job.ts:126-146`, `:128`; `:70-116`, `:123-124`; `:162-182`, `:150-153`; `:184-195` |
| **F19** | Studio renders a result as `JSON.stringify(result, null, 2)` inside a `<pre>`. That is the whole of it. | `packages/studio/src/app/jobs/detail/page.tsx:493-534`, esp. `:530-532`; `packages/studio/src/lib/jobs.ts:60-69` |
| **F20** | The one structured rendering that exists is an **opportunistic guess** at a `findings[]` shape, and its own doc comment says: *"Making this reliable rather than opportunistic is an SDK decision (a documented convention scripts opt into), recorded as a backend follow-up in `docs/ux-audit.md` §3."* **This plan is the answer to that recorded ask.** `readFindings` has zero consumers outside the job detail page, and no script in this repository emits `findings`. | `packages/studio/src/lib/jobs.ts:71-106`, esp. `:80-83`; `docs/ux-audit.md:65`; `packages/studio/src/app/jobs/detail/page.tsx:112`, `:502-528` |
| **F21** | `ctx.jobs.resultOf(jobId): Promise<unknown | null>` **already exists** and is already the cross-script read door — namespace-scoped, refusing `not-found` / `foreign-namespace` / **`not-finished`** and collapsing all three to `null` on the wire. The pipeline's read path is built; only its type is missing. | `packages/sdk/src/types.ts:218-236`; `packages/core/src/jobs/script-jobs.ts:31`, `:135-155`; `packages/core/src/jobs/jobs-runner-port.ts:60-67` |
| **F22** | An agent's only door to a result is the `job.get` capability (`output: JobDetailSchema`); `job.run` returns only the queued `JobInfo`. The model receives the result as `JSON.stringify(output)` of the **whole `JobDetail`**, unformatted. | `packages/core/src/capability/job.ts:54-68`, `:57`, `:62`; `:28-52`; `packages/core/src/agent/harness/run.ts:288-294` |
| **F23** | MCP `tools/list` advertises **`inputSchema` only** — even though `tools/call` already emits `structuredContent`, the registry already requires a Zod `output` on every capability, and `toJsonSchema(cap.output)` is already computed for `GET /api/v1/cap`. The output half of the MCP contract is one field away and simply absent. | `packages/core/src/mcp/server.ts:85-93`, esp. `:89`; `:114`; `packages/core/src/capability/registry.ts:36-37`, `:93-114`; `packages/core/src/api/cap.ts:91` |

#### Measured against this workspace's Zod

| # | Finding | Evidence |
|---|---------|----------|
| **F24** | `z.toJSONSchema(S, { io: 'output' })` puts **every non-optional key, including defaulted ones, into `required`** — `endedOnStall: z.boolean().default(false)` is `required` in `'output'` and absent from `required` in `'input'`. For a *result* that is correct (the default has already been applied by the time `run()` returns); for a *param* it is the defect plan 95 F2 fixed. **The two halves need opposite `io` modes, and the reason is the same reason.** *(measured)* | plan 95 F2; `packages/sdk/src/cli/publish.ts:181-187` |
| **F25** | `io: 'output'` additionally emits `additionalProperties: false`, which `io: 'input'` does not. Zod's own `z.object()` **strips** unknown keys rather than rejecting them, so at runtime an extra key is not a failure — it is silently dropped by `.parse()`. *(measured)* | — |
| **F26** | `.refine()`/`.superRefine()` are **silently dropped** by `z.toJSONSchema` in `'output'` mode too, but are enforced by the real Zod schema at runtime. A result can therefore be legitimately rejected for a reason a reader of the published JSON Schema cannot see. *(measured; the `'input'` half is plan 95 F3)* | plan 95 F3; `packages/sdk/src/cli/publish.ts:100-115` (`warnAboutRefinements` already exists) |
| **F27** | `z.date()` throws `Date cannot be represented in JSON Schema` in **both** `io` modes. A result schema containing a `Date` fails at publish, loudly — which is right, because a `Date` cannot survive `jobs.result`'s JSON column either. *(measured)* | — |
| **F28** | A `z.record(z.string(), z.number())` emits `type: 'object'` with **`propertyNames`** and **`additionalProperties: { type: 'number' }`** — i.e. the value schema for every entry is present and machine-readable, even though `properties` is absent. *(measured)* | plan 95 F19 (the `properties`-absent half) |
| **F29** | A discriminated union emits a top-level `oneOf` with no `type`. Plan 95's resolver sends that to row 15 → `json` with *"this parameter can take several different shapes"* — correct for a form, and the shape a result is **most** likely to have (`{ ok: true, … } | { ok: false, … }`). *(measured; plan 95 F20)* | `packages/studio/src/components/schema-form/plan.ts:21-44` (row 15) |

### 0.2 What plan 95 already built, and this plan reuses rather than rebuilds

This list matters as much as the defect list. Plan 97 writes **one** new vocabulary
key and **one** new pure function on the Studio side. Everything else already exists.

| # | Reused | Where |
|---|--------|-------|
| **K1** | **The vocabulary.** `PARAM_KINDS` (nine, closed), `DURATION_UNITS`, `ParamHints`, `ParamHintsSchema`, `readHints` (returns `{}` for absent, malformed and future hints), `ui()` (a typed identity function, re-exported from `@enkaku/sdk` so the import allowlist is satisfied). A result field says `kind: 'duration', unit: 's'` in exactly the same words a param field does. | `packages/protocol/src/params/vocabulary.ts:20-31`, `:34-35`, `:66-83`, `:103-136`, `:158-172`; `packages/sdk/src/index.ts:33` |
| **K2** | **The limits and the publish gate.** `PARAMS_LIMITS` (64 KiB, depth 5, 200 fields, 200 enum members, title/description/label/group caps, identifier-shaped field names, `__proto__` blocklist, a 20 000-node walk budget) and `checkParamsSchema`, already wired into **all three** publish paths and already returning every finding rather than the first. | `packages/protocol/src/params/limits.ts:12-27`, `:39`, `:52`, `:231`; `packages/core/src/scripts/routes.ts:266`; `packages/core/src/plugins/verify-child-entry.ts:62`; `packages/sdk/src/cli/publish.ts:127` |
| **K3** | **The resolver.** `planField` — pure, total, deterministic, DOM-free, a published 16-row precedence table mirrored in the code. It is *already* a function from a JSON Schema node to a **meaning descriptor**, not to a widget. A read-only view can consume the same descriptor. | `packages/studio/src/components/schema-form/plan.ts:376`, `:544`, `:580`, `:148-175`, `:21-44` |
| **K4** | **The formatter.** `formatValue(kind, unit, value)` — pure, value-only, no React: `536870912 → "512 MB"`, `0.35 → "35%"`, `90000 + ms → "1 min 30 s"`, `[5,20] + s → "5 s ~ 20 s"`. It is exactly what a result readout needs. | `packages/studio/src/components/schema-form/controls/format.ts:116` |
| **K5** | **The validator.** `validateParams(schema, value)` → `{ ok: true } | { ok: false; issues: ParamIssue[] }`, with dot-notation paths and sentences written for someone who did not author the script, evaluating **no author-supplied regular expression** on either side. | `packages/protocol/src/params/validate.ts:7-12`, `:312`, `:300-311` |
| **K6** | **The clamp.** `clampParamsSchema` / `summarizeClamp` — how a schema already in the database, written before the limits existed, still renders. | `packages/protocol/src/params/clamp.ts:68`, `:212` |
| **K7** | **The hostile corpus.** Ten blocking fixtures — `self-ref-cycle`, `deep-40`, `wide-5000`, `giant-description`, `redos-pattern`, `oversized-200kb`, … — reusable verbatim for result schemas. | `packages/protocol/src/params/hostile-fixtures.ts:42`, `:162` |
| **K8** | **The error carriage.** `EnkakuError` already carries `issues?: ParamIssue[]` through `toJSON()`, and Studio already maps them onto fields. | `packages/core/src/util/errors.ts:15-29`; `packages/studio/src/lib/actions.ts:16-29` |

### 0.3 Hypotheses (test before acting)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | A second, optional generic on `ScriptDefinition` infers correctly in both directions: omitting `result` leaves `run` returning `Promise<unknown>` exactly as today, and declaring it makes a wrong return value a **compile error in the author's own editor**. | This is the same mechanism plan 95 used for `ui()`'s overloads (a compile error for `{kind:'duration'}` with no unit), which shipped and works. A conditional return type in an interface method is ordinary TS. | 97.2 ships `packages/sdk/src/result.type-test.ts`, the direct sibling of `vocabulary.type-test.ts`: `@ts-expect-error` on a `run` returning the wrong shape when `result` is declared, and a positive assertion that a definition with no `result` still typechecks with any return. If inference breaks, the fallback is an explicit second type argument at the call site, recorded in §9. |
| **H2** | A script returning a **circular** object today does not fail cleanly — `send()` passes `safeParse` (because `value` is `z.unknown()`), then `process.send` throws while serialising, after `finishRan = true`, and the parent never receives a result. The job hangs to the 30 s silence timer and is killed as a timeout. | F10 plus the fact that `send` at `child-entry.ts:449` sits in the `try` whose `catch` calls `send` **again** — with the same broken value gone but a `finishRan` that is now true. Nothing on the path serialises defensively. | 97.3's first unit test is a child that returns `const a = {}; a.self = a; return a`. Whatever it does today is recorded; afterwards it is `resultStatus: 'invalid'` with the issue *"the result contains a circular reference and could not be stored"*, and the job settles normally. If today's behaviour turns out to be a clean failure, the fix is smaller but the test stays. |
| **H3** | The overwhelming majority of real result schemas are a **flat object of scalars plus at most one record** — so `planField`'s existing rows cover them, and the three value-directed rules of §3.6 are the entire delta. | The only real result in this repository is the tiktok pack's: thirteen keys, twelve scalars and one `Record<string, number>`. The spec's own example is `{ ok: true }`. | 97.8 declares the tiktok pack's result schema and 97.6's test asserts every one of its fields renders through an existing `FieldPlan` row with no new control. A field that needs a fourth rule kills the hypothesis and is recorded rather than absorbed. |
| **H4** | Live progress, not streaming results, is what the "long script produces output progressively" need actually is. | The tiktok pack **logs the object it is about to return** one line before returning it (`ctx.log.info('finished scrolling', {...})` at `index.ts:500-513`, `return { … }` at `:514`) — the same numbers, once, in a place a human must scroll a log to find. The need is *seeing the numbers before the end*, not *another job reading them before the end*. | 97.7 ships `ctx.progress(value)` — coalesced, unpersisted, 4 KiB — and 97.8 replaces that log line with it. If an operator still wants an intermediate value to be *readable by another job*, that is a different feature and §9 Q4 records it rather than this plan half-building it. |

### 0.4 Three corrections to the brief this plan was written from

Recorded because acting on any of them would have produced a wrong design:

1. **`jobs` has no `errorClass` and no `stopReason`** (F9). Those are `agent_runs`
   columns. The job analogues are `failureClass` and `errorPhase`, and both are
   already correct and already surfaced — which is exactly why this plan does
   **not** add a per-script error vocabulary (§3.5).
2. **Plan 93's 32 KB / 2 KB caps are not shipped** (F14) — plan 93 is `not
   started`. They are precedent, not the status quo, and this plan cites them
   as such.
3. **`MAX_BUFFERED = 512 KB` is plan 85's, not plan 92's** (F13), and it bounds
   *buffer depth on the video path*, not payload size on the control path. It
   is the wrong instrument to size a result against; **`kv.maxValueBytes` is
   the right one** (F12), and §3.4 uses it.

---

## 1. Goals

- **A script author declares what a run *produces*, in the schema, once** — and
  the job detail screen, the job list, `GET /api/jobs/:id`, the agent's tool
  output, and (plan 99) a pipeline edge all improve together, with no React
  written anywhere and no second vocabulary invented.
- **Declaring an output is optional, and never declaring one keeps working.**
  `plugins/tiktok-automation-pack` and every published script run unchanged,
  render at least as well as they do today, and require no republish. This is
  not negotiable and it is criterion 1.
- **A declared result is checked against the real Zod schema, at the moment it
  is produced** — including `.refine()`, which the params half can never reach
  (plan 95 §9 Q2) because the core holds only the JSON Schema. The result half
  gets it for free, because the child holds both the schema and the value.
- **A result that does not match its own schema never fails the job, and never
  passes silently.** The device work already happened; a `failed` status would
  be a lie about the device. The job settles as it would have, the result is
  stored **verbatim, never reshaped**, and the row carries a status and the
  field paths that did not match.
- **The result column is exactly what the script returned.** Every piece of
  Enkaku metadata about it — status, size, summary, issues — lives in sibling
  columns, never nested inside the author's JSON. A consumer never unwraps.
- **A result has a written size bound** — one number, the same 64 KiB the KV
  store already enforces — measured **in the child before it crosses IPC**, so
  a 50 MB return never enters the parent's memory, SQLite, or the WebSocket.
  Refused by name, with the fix named in the message.
- **A failed job can still say something**, through `finish()`'s return value,
  marked as what it is: evidence from a run that did not finish, not a report.
- **A typed result reads as values, not as JSON.** `watchSeconds` renders
  `4 min 12 s`, `matchRate` renders `35%`, `bytesPulled` renders `512 MB` —
  through plan 95's own formatter, on plan 95's own vocabulary, with no new
  kinds and no per-script UI.
- **The job list can say what a run produced** without loading two hundred
  results: one operator-legible line, ≤ 120 characters, built once at settle.
- **Results do not stream; progress does.** A job has exactly one result,
  written once, at settle — because `resultOf` already refuses a job that has
  not finished, and a partial result would make that refusal meaningless. A
  live, unpersisted `ctx.progress(value)` answers the need that made streaming
  look attractive.
- **Plan 99 has an interface it can build on**, stated here and stopped at:
  a value, a status, and the schema pinned to the version that ran.

## 2. Non-goals

- **Not the pipeline.** §3.9 states the interface plan 99 consumes and stops.
  No graph, no edges, no evaluation nodes, no scheduling.
- **Not the runtime envelope.** Plan 98 owns it. §3.9 states the one constraint
  this plan places on it: whatever it wraps, `jobs.result` stays the script's
  own value.
- **Not a required output schema, ever.** F1's hundreds of existing scripts —
  and every future one that genuinely has nothing to say — declare nothing and
  are complete. `undeclared` is a first-class state, not a migration backlog.
- **Not streaming results** (§3.7). `ctx.progress` is built instead, and the
  reasoning is written rather than asserted.
- **Not a per-script error taxonomy.** F9 shows the failure vocabulary already
  exists (`failureClass`, `errorPhase`) and is what plan 36's retry policy
  reads. A script-authored error enum would hand that policy a second input it
  cannot trust. §3.5 gives the author a better answer that costs no new
  machinery.
- **Not one MCP tool per script.** Plan 95 §9 Q3 named it and it is still its
  own plan (roster size, naming, permissions). What this plan does is make the
  *output* half free when that plan arrives, and advertise `outputSchema` for
  the capabilities that already exist (F23).
- **Not secret or encrypted results.** `jobs.result` is plaintext in SQLite and
  readable through `ctx.jobs.resultOf` by any script in the same namespace. The
  same reasoning that kept `kind: 'secret'` out of plan 95's vocabulary applies
  unchanged; `ctx.kv` with `secret: true` is the answer.
- **Not a new spill target.** A result too large for the cap does **not**
  overflow into KV (F12 — designed against exactly that) or into a magic
  artifact. `ctx.artifact.file()` already exists, is already broadcast, already
  has retention, and is the documented answer (§3.4).
- **Not the artifact-store size asymmetry.** F17's 8 MB guard firing only for
  `kind === 'file'` is a real defect and is recorded in §9, not fixed here.
- **Not `formatResult`.** Studio's raw JSON `<pre>` stays, as the fallback for
  every `undeclared` result and for every value a plan cannot describe.

---

## 3. Context and design decisions

### 3.1 The rule the whole plan follows: a gate may refuse, an assertion may only report

Plan 95 made input validation **fatal**: `POST /api/jobs` throws
`invalid_job_params` at `job-service.ts:85`, before `jobStore.enqueue` at `:87`
and before `scheduler.kick()` at `:97` — so no row is written, no device is
claimed, no lease is taken, and the batch path refuses at `dispatch.ts:131`
before it even resolves a cluster. That is the right answer *because nothing
has happened yet*. Refusing costs the operator one corrected form field and
saves a device-minute.

Output validation is the mirror image and must not be mirrored. By the time a
result exists:

- every tap has landed,
- every artifact is on disk,
- `finish()` has run and the device is clean,
- the lease is about to be released,
- and a batch's other members are already running.

Marking that job `failed` would (a) assert something false about the device,
(b) feed plan 36's classifier, which for `failureClass: 'script'` is a retry
input — so a mistyped return value would **re-run the entire device workload**,
the most expensive possible response to a typo, and (c) collapse "the
automation did not work" into "the automation worked and the report was
malformed", which are the two things an operator most needs to tell apart.

> **The rule, stated once and applied everywhere below:**
> **Input validation is a gate. Output validation is an assertion.**
> A gate may refuse, because the cost of refusing is zero. An assertion may
> only report, because the thing it describes has already happened — and a
> report that lies about what happened is worse than one that admits it does
> not match its own schema.

The consequence is not "be lenient". It is: **the failure must be recorded
precisely enough that an unattended consumer can refuse on its own behalf.**
That is the same split plan 95 drew for `reconcileParams` — *"an unattended
caller stops on `blocking`; an attended caller does not"* — and this plan
reuses the shape rather than the mechanism (§3.9).

### 3.2 Declaring an output

`ScriptDefinition` gains one optional field, and one optional generic:

```ts
export default defineScript({
  id: 'auto-scroll',
  version: '2.1.0',
  params: z.object({ videos: z.number().int().min(1).max(2_000).default(30) }),

  result: z.object({
    videos: z.number().int()
      .describe('How many videos were actually watched.')
      .meta(ui({ title: 'Videos watched', kind: 'count', summary: true })),
    watchSeconds: z.number()
      .meta(ui({ title: 'Time on feed', kind: 'duration', unit: 's', summary: true })),
    matchRate: z.number().min(0).max(1)
      .meta(ui({ title: 'Matched the target', kind: 'chance' })),
    byLabel: z.record(z.string(), z.number())
      .meta(ui({ title: 'Videos by label' })),
    endedOnStall: z.boolean().default(false),
  }),

  async run(ctx) { /* … returns the shape above, checked by tsc */ },
})
```

**Optional, always.** A definition with no `result` is complete, `run` keeps
returning `Promise<unknown>`, `scripts.result_schema` is `NULL`, and every job
it produces is `resultStatus: 'undeclared'` — stored raw, rendered raw, exactly
as today. That is the compatibility floor and it is criterion 1. There is no
deprecation, no warning, and no plan to make it required: a script that force-
stops an app genuinely has nothing to return, and a product that nags it is
worse than one that does not.

**Typed at the author's desk.** The payoff of the generic is that `tsc` checks
`run`'s return value against the declared schema *in the author's own editor*,
before publish, before the farm ever sees it — the direct analogue of plan 95's
`ui()` making a misspelled `kind` a compile error (§3.2 *"Type-checked at the
author's desk"*). Declaring nothing costs nothing; declaring something buys the
check. H1 tests that the inference actually behaves in both directions.

**`io: 'output'`, and the reason is the same reason `io: 'input'` was right.**
Plan 95 switched `publish.ts` to `z.toJSONSchema(params, { io: 'input' })`
because *a params schema describes what a person types*, and in `'output'` mode
every `.default()` field is published as `required` — the root of its F16 bug. A
**result** schema describes what the script *produced*, by which time every
default has been applied. F24 measures both: `endedOnStall: z.boolean()
.default(false)` is `required` in `'output'` and not in `'input'`. Two opposite
flags, one shared principle: *publish the schema of the value that actually
crosses the boundary.* This is the sharpest reason the two halves must not
share a single conversion helper, and 97.2 gives each its own named call site
with the reason in a comment above it.

**Where it is stored.** `scripts.result_schema`, the JSON sibling of
`params_schema` at `schema.ts:376`, written by the same three publish paths that
already write `paramsSchema` (F17/K2), checked by the same limits, and — because
`scripts` has one row per version — **pinned to the version that ran** with no
new join and no drift. That last property is what makes plan 99 possible at
all: an edge stored against `auto-scroll@2.1.0` can always recover the exact
shape that version promised, even after `2.2.0` changes it.

### 3.3 Five states, because two are not enough

`jobs.result_status`, written exactly once, by the settle path, for every job
that reaches a terminal status. `NULL` while queued or running.

| status | means | `jobs.result` holds |
|---|---|---|
| `undeclared` | the script declared no result schema | whatever it returned (possibly `null`) |
| `valid` | declared, and the returned value satisfied it | the value, verbatim |
| `invalid` | declared, and the returned value did **not** satisfy it | the value, **verbatim** — never coerced, never stripped |
| `partial` | the run failed; this came from `finish()` and no schema was applied | whatever `finish()` returned |
| `oversize` | the value exceeded `job.maxResultBytes` and was never transmitted | `null` |

Five, not two, because each one answers a question a consumer genuinely asks
and cannot derive from the others:

- `undeclared` vs `valid` — *may I rely on this shape?* Plan 99 must be able to
  refuse to type-check an edge whose source promises nothing. Collapsing these
  would force it to guess.
- `valid` vs `invalid` — *did the script keep its word?* This is the whole
  contract.
- `invalid` vs `partial` — *did the run finish?* An evaluation node treats
  "ran to completion and reported something malformed" very differently from
  "crashed, here is what it had".
- `oversize` vs `null` result — *is there nothing, or is there something I
  cannot have?* Without the state, a 50 MB result and an empty one are the same
  row, and the operator has no way to learn which.

**`invalid` never reshapes.** The child validates with `safeParse` used purely
as an oracle and **stores the raw value it was handed**. Zod's `.parse()` would
strip unknown keys (F25) — silently deleting data the script produced, which is
the one thing a report must never do. It also makes §3.6's "render unknown keys
too" rule meaningful rather than decorative.

**Backfill.** The migration sets `result_status = 'undeclared'` for every row
with `finished_at IS NOT NULL` — which is true, because no script declared a
result schema before this plan — and leaves unfinished rows `NULL`. One
`UPDATE`, no ambiguity, and the enum is total from the first boot.

### 3.4 Size: 64 KiB, measured in the child, and the door is named

**The number is 64 KiB**, as a farm setting `job.maxResultBytes` (default
`65_536`, min `1_024`, max `1_048_576`).

The justification is not a round number, it is F12: **`kv.maxValueBytes` is
already 64 KiB**, and `ctx.kv.set()` and a job result are *the two ways a script
persists structured JSON in this product*. Giving them different limits would
mean an author has to remember two numbers with no principle separating them.
Giving them the same one means the rule is memorable: *64 KiB is what a script
may hand the database as a value; anything larger is a file.* The three
cross-checks all agree:

- The tiktok pack's real result — thirteen fields including a label histogram —
  serialises to a few hundred bytes. 64 KiB is roughly **150×** a real result.
- It is **1/8** of `MAX_BUFFERED` (F13), so a result could not on its own trip
  the video backpressure guard even if it did cross the WS. It does not (below).
- It is the same number `PARAMS_LIMITS.maxSchemaBytes` uses for a *schema*
  (K2), so a result and its own description are bounded alike.

**Where it is measured: in the child, before the message is built.** F10 is the
reason this cannot be delegated to the IPC schema — a constraint there produces
a silent drop and a 30 s hang, not an error. So `child-entry.ts` serialises,
measures with `new TextEncoder().encode(json).length` (F16's idiom, copied from
`kv/store.ts:126-131`), and on breach sends **the verdict instead of the value**:

```ts
send({ t: 'result', ok: true, oversize: { bytes, cap }, finishRan })
```

This is the only place the cap *can* be enforced without cost: a 50 MB object
measured in the parent has already been serialised by `process.send`,
deserialised, and buffered. Measured in the child it never crosses the boundary
at all, and the child is about to exit anyway.

**What happens at 50 MB, end to end:**

1. The child measures `52 428 800` bytes, over `65 536`. Nothing is sent but the
   verdict.
2. The job **still settles `success`** (§3.1 — the device work happened).
   `result_status = 'oversize'`, `result_bytes = 52428800`, `result = NULL`.
3. The job log gets one `warn` from the child, and the job detail shows, in
   place of the result:

   > This run returned 52.4 MB. The farm's limit for a stored result is 64 KB,
   > so nothing was kept. Save large output as an artifact with
   > `ctx.artifact.file('report', data)` and return a small summary that points
   > at it.

   Naming the fix in the message is the difference between a wall and a door.
   F17 shows the door is already built: artifacts are per-job, broadcast live,
   sized, retained, and reachable from `ctx` in every script.

**The bound cannot be expressed in the schema and must be a runtime rule.** An
unbounded `z.array(z.string())` is a legal, limit-passing result schema that can
produce 50 MB. `checkDeclaredSchema` bounds the *description*; only the runtime
can bound the *value*. Said plainly so nobody later assumes the publish gate
covers it.

**A result never crosses the WebSocket.** This is worth stating because it
dissolves the question F15 raises. `result` is detail-only (F18) and is fetched
by REST; the only result-derived things on the WS are `result_status` (an enum)
and `result_summary` (≤ 120 characters), both riding an existing `job.status`
event that fires on status change, not on a timer. The added WS cost of this
entire plan is roughly 140 bytes per job status transition.

### 3.5 Errors: a failure is not a result, and the best failure report is a successful job

Three separate things, deliberately kept separate:

**1. A crash is not a result.** It stays in the channel it already has:
`jobs.error` (text), `failureClass` (`infra | script | load`, plan 36),
`errorPhase` (`prepare | run | finish | reset | acquire | timeout`, plan 60).
This plan adds **nothing** there. F9 is why: those columns are already correct,
already surfaced on the Summary tab, and already the input to the retry policy.
A script-authored error enum beside them would give that policy a second input
it has no reason to trust, and would let a script talk itself into a retry.

**2. What a crashed run salvaged is evidence, not a report.** F7/F8: today a
failed run reports nothing structured, and `finish()` — the one hook guaranteed
to run with `ctx.error` set — returns `void`. So:

- `finish` becomes `Promise<unknown | void>`. Additive: every existing `finish`
  returning nothing is unchanged, and `undefined` means what it means today.
- Its return value is used **only when `run()` did not produce one** — i.e. only
  on the failure path. If both produce a value, `run()` wins, stated once and
  tested.
- It is stored with `result_status = 'partial'` and **is not validated at all**.

  That last decision is the one that needs defending, because "validate it
  leniently" sounds better than "do not validate it". It is not. There is no
  honest lenient schema: `z.object().partial()` is one level deep and undefined
  for a union, and deriving one would be this plan guessing at a shape the
  author never declared. `partial` means precisely *"this came from a run that
  failed; the declared schema was not applied to it"*, and a consumer that
  needs a guarantee reads `valid`. Inventing a half-checked third grade would
  be exactly the half-feature the brief forbids.
- The finish-only re-attempt path (`child-entry.ts:411`) carries the same value,
  or the `partial` is lost on precisely the runs most likely to have one.

**3. A failure an author *wants* downstream to read is a successful job with a
negative verdict.** This is the recommendation, and it costs no new machinery:

```ts
result: z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), videos: z.number().int() }),
  z.object({ ok: z.literal(false), reason: z.enum(['blocked', 'logged-out', 'no-feed']) }),
]),
async run(ctx) {
  try { … ; return { ok: true, videos } }
  catch (e) { if (isBlocked(e)) return { ok: false, reason: 'blocked' }; throw e }
}
```

The job is `success`, the result is `valid`, and a pipeline evaluation node
branches on a typed field instead of parsing an error string. F29 measures that
this shape emits a top-level `oneOf` — which is exactly why §3.6's first
value-directed rule exists, and why it is not optional.

The SDK guide states the three-way split in one paragraph: *a crash is a
failure, a salvage is evidence, a handled outcome is a result.*

### 3.6 Rendering: the same resolver, plus exactly three rules a form cannot have

The brief asks whether plan 95's resolver can serve display too, or whether
display differs enough to need its own path. The answer is precise:

**`planField` is reused unchanged, and so is `formatValue`.** K3 shows
`planField` is already a function from a schema node to a *meaning* descriptor
(`{control: 'number', kind: 'duration', unit: 's'}`), not to a widget; the file
that names controls lives in Studio and is the only one that does. A read-only
view consumes the same descriptor. K4's `formatValue` is already a pure
`(kind, unit, value) → string`. A result reading `4 min 12 s` and a form label
reading `4 min 12 s` come from one line of code, tested once.

**What differs, and why, is a single fact: a form plans *before* the value
exists; a result view plans *after*.** Three rules follow from that fact and
nothing else follows from it. They live in `planResult(node, value)`, a pure
function beside `planField`, not inside it — the form must never gain them.

| # | Rule | Why a form cannot have it | Evidence it is needed |
|---|---|---|---|
| **R1** | **Branch selection.** For `oneOf`/`anyOf` with several real branches, pick the first branch for which `validateAgainstSchema(branch, value).ok`, then plan that branch. None matches → the node plans as `json`. | A form has no value to test, and switching branches under the user destroys what they typed. Plan 95 row 15 is correct *for a form*. | F29: a discriminated union is the shape §3.5 actively recommends. Without R1 the recommended pattern renders as raw JSON. |
| **R2** | **Record expansion.** For `type: 'object'` with no `properties` (a `z.record`), render the **value's own keys** as rows, each planned from `additionalProperties`. | A form cannot draw an editor for keys that do not exist yet; plan 95 row 13 correctly sends it to `json` with *"this parameter is a free-form map"*. | F28: `additionalProperties` carries the per-value schema, so each row is fully planned, not guessed. A label histogram is the single most likely non-scalar in a result (H3). |
| **R3** | **Unknown keys are shown, never hidden.** Keys present in the value but absent from `properties` render below the declared ones, raw, under one quiet heading. | A form produces the value, so it cannot have extras. | F25: Zod strips extras on `.parse()` and §3.3 stores the raw value precisely so they survive. A view that then hid them would make that choice pointless. |

Everything else — `$ref` with its visited set, the depth cap, the
±`MAX_SAFE_INTEGER` sentinels, `kind` validity against structural type, arrays,
nested objects, the `json` terminal with a written reason — is `planField`,
already shipped, already tested, and reused with no fork. `planResult` is a
thin pre-pass, not a second resolver, and its test file imports `planField`
rather than reimplementing any row.

**What is deleted:** `readFindings`, `severityTone` and `JobFinding`
(`packages/studio/src/lib/jobs.ts:71-115`) — F20's guess, with zero consumers
outside the one page and no script in the repo emitting the shape. Its
replacement is better and is not a guess: a script declaring
`findings: z.array(z.object({ title, severity, detail }))` lands on
`planField`'s array-of-objects row and renders as a real table with real
labels. `formatResult` (`:60-69`) **stays**, as the fallback for every
`undeclared` result and every `json`-terminal node.

**One new vocabulary key, and only one.** `x-enkaku.summary?: boolean`, valid on
at most **three** top-level result fields, enforced at publish. It is not a
presentation hint and the boundary plan 95 drew is not being crossed: it says
*"of these thirteen numbers, this is the headline fact about the run"* — which
is meaning, the same category as `kind`. Studio still decides entirely how to
draw it, and the core uses the same fact to build one line of text. No script
can name a control, a colour, or a size, exactly as before.

Deliberately **not** added: a `ref`/`link` kind for artifact and device ids in a
result, and `artifacts` as a `source`. Both are plausible and both would be a
second meaning for an existing key (`source` is defined as *where the set of
allowed values comes from* — an input concept). §9 Q3 records it.

### 3.7 Results do not stream. Progress does.

A long run producing output progressively is a real need, and the brief is right
that the answer materially changes what a pipeline can do. The decision is that
**a job has exactly one result, written once, at settle** — and here is what
that buys and what it costs.

**Why not stream the result:**

1. **It would break a guarantee that already exists.** `ctx.jobs.resultOf`
   refuses a job that has not finished, with the reason `not-finished` (F21).
   That refusal is the only thing standing between a triggered job and a
   half-written value. A streaming result either breaks it, or needs a second
   read door with different rules — and two doors onto one value is how a
   consumer ends up reading the wrong one.
2. **Validation has no answer.** A partial result legitimately fails `required`.
   Validating each emit is wrong, validating none of them makes the contract
   meaningless, and validating only the last one means `resultStatus` describes
   something no consumer necessarily saw.
3. **The cost is real and recurring.** Every emit is a SQLite `UPDATE` of a
   growing JSON blob plus a fleet broadcast. A script emitting per video at 3 s
   intervals across twenty devices is ~7 writes/second of monotonically growing
   rows, forever, on a farm whose adb budget is already the thing plan 85 spent
   a milestone on.

**What is built instead — `ctx.progress(value)`:**

- **Coalesced.** At most one push per `job.progressIntervalMs` (default
  `1000`, min `250`, max `10000`) per job, last value wins. Calling it in a
  tight loop costs one assignment.
- **Never persisted.** No column, no `UPDATE`, gone on core restart. Its only
  consumer is someone watching right now.
- **Never a result.** Not validated, not readable by `resultOf`, not on
  `JobDetail`. `MAX_PROGRESS_BYTES = 4 * 1024` — over it, the push is dropped
  with one `warn` per job, never truncated into malformed JSON.
- **Rendered by the same formatter.** When a progress key matches a result-schema
  field, Studio formats it through `formatValue` — so the live number and the
  final number read identically and the operator never has to reconcile two
  spellings of the same fact.

The distinction, written once for the SDK guide: **a result is a commitment; a
progress is an observation. Only one of them may be read by another job.**

H4 records the evidence that this is the real need: the tiktok pack logs the
object it is about to return, one line before returning it — the same numbers,
in a place a human must scroll a log to find. 97.8 replaces that line with
`ctx.progress`, and if an operator genuinely needs an intermediate value to be
*machine-readable by another job*, §9 Q4 records it as a separate feature
rather than this plan half-building it.

### 3.8 An untrusted result schema, and an untrusted result

The schema half is already solved and is reused wholesale: `checkDeclaredSchema`
(K2) runs on `resultSchema` at all three publish paths with the same limits,
`clampSchema` (K6) handles a schema already in the database, and K7's ten
hostile fixtures are re-run against the result path. A cyclic, 40-deep,
200 KiB, 5 000-field or ReDoS-patterned result schema is rejected at publish
with a named finding, exactly as a params schema is.

The **value** half is new, and has three risks the params half never had,
because a params value is produced by the operator's own browser and a result
value is produced by author code running on a device:

| # | Risk | Answer |
|---|---|---|
| **V1** | **Size** — an unbounded array in a legal schema produces 50 MB. | §3.4: measured in the child, refused by name, `oversize`, artifacts named as the door. |
| **V2** | **Circularity** — `JSON.stringify` throws, and H2 suspects today that means a silent hang rather than a failure. | The child serialises inside a `try`; a throw becomes `resultStatus: 'invalid'` with the issue *"the result contains a circular reference and could not be stored"*, and the job settles normally. |
| **V3** | **Prototype pollution on read** — a result containing a `__proto__` key is JSON, is stored, and is later walked by `planResult` and by any consumer. | `PARAMS_LIMITS`' existing `DANGEROUS_FIELD_NAMES` set (`limits.ts:39`) is applied to result **values** at the same place the size is measured; a result carrying `__proto__`, `constructor` or `prototype` at any depth is `invalid` with the path named, and stored as text that no walker dereferences. Studio never uses `dangerouslySetInnerHTML` (plan 95 F23), so a result is escaped text and this is the residual risk, not XSS. |

**The child's verdict is trusted, and that is a stated position, not an
oversight.** The child holds the real Zod schema and the real value at the same
instant, which is what makes `.refine()` reachable (F26) — the thing plan 95
§9 Q2 had to leave open for params. A malicious child could report `valid` for
anything. Under spec §11.3 that is not a new exposure: the script author is a
trusted operator, the isolation is crash containment and not a security
boundary, and a child that wanted to lie could simply return a conforming lie
instead. The parent does re-check the two things it can cheaply and
independently know — the byte count and the status enum — and takes the child's
word on shape.

**A published JSON Schema can be *weaker* than the runtime check.** F26: a
`.refine()` is enforced by the child and absent from `resultSchema`, so a
consumer reading the schema may believe a value is acceptable when it was
rejected. This is stated rather than hidden: the stored `result_issues` carry
Zod's own message, `publish.ts`'s existing `warnAboutRefinements`
(`:100-115`) is pointed at the result schema too, and the SDK guide names the
gap. It is the exact inverse of the params gap and it is the honest trade for
getting refinements enforced at all.

### 3.9 Interfaces to plans 98 and 99 — stated, and stopped at

**To plan 99 (pipelines).** A finished job exposes exactly three things an edge
needs, and no more:

```ts
{ value: unknown, status: ResultStatus, schema: JsonSchemaNode | null }
```

- `schema` is the one pinned to the version that ran (§3.2), so an edge authored
  against `auto-scroll@2.1.0` can always recover what that version promised.
- `status` is the contract. **An edge from an `undeclared` source may carry the
  value but may not be type-checked at design time** — plan 99 must show that
  honestly rather than pretending. `partial` and `oversize` are refusable;
  `invalid` is refusable; `valid` is the only state that guarantees the shape.
- An evaluation node needs **no new evaluator**: `validateAgainstSchema` (K5) is
  pure, shipped, protocol-side, and already the function both the browser and
  the core use. Plan 99 imports it.
- Schema *evolution* on an edge — a pipeline authored against `v1`'s result
  meeting `v2`'s — is plan 99's, not this plan's, and the shape of the answer
  already exists: `reconcileParams`' six-row table and its `blocking` flag
  (K5's sibling). This plan deliberately does **not** apply `reconcileParams` to
  results, because a result meets its own script's schema at the instant it is
  produced — there is no drift to reconcile. Naming that so plan 99 does not
  assume the machinery is already wired.

**To plan 98 (the runtime envelope).** One constraint, and it is the rule from
§1: **`jobs.result` stays exactly what the script returned.** Whatever envelope
plan 98 defines, its metadata lives in sibling columns
(`result_status`, `result_bytes`, `result_summary`, `result_issues`), never
nested inside the author's JSON — because `resultOf` hands that value to another
author's script, and an envelope there would force every consumer, forever, to
unwrap before reading. The columns are additive and plan 98 may add more.

**To plan 95.** 97.1 moves and renames three of its exports and moves
`formatValue` out of Studio into `@enkaku/protocol`. Plan 95 is `partial` — its
outstanding steps are 95.10 (a projection change in
`packages/core/src/scripts/routes.ts`) and 95.11 (documentation). Neither
touches `packages/protocol/src/params/`, so the move is safe; 95.11's
`packages/protocol/README.md` must be written against the post-97.1 names, and
97.9 says so.

---

## 4. Technical design

### 4.1 The shared schema module — `packages/protocol/src/schema/` (moved)

Plan 95's `params/` module is no longer about params: its limits, its validator,
its clamp and its formatter describe **a declared schema and a value measured
against it**, which is now both halves of the contract. Per 00-overview §4.3
(*replace, never version*) the names move with the meaning, in one mechanical
commit:

| from | to | note |
|---|---|---|
| `packages/protocol/src/params/` | `packages/protocol/src/schema/` | directory move |
| `PARAMS_LIMITS` | `SCHEMA_LIMITS` | values unchanged |
| `checkParamsSchema` | `checkDeclaredSchema` | signature unchanged |
| `validateParams` | `validateAgainstSchema` | the alias `executors/script.ts:53` already imports it under |
| `clampParamsSchema` | `clampSchema` | signature unchanged |
| `packages/studio/.../controls/format.ts` → `formatValue` | `packages/protocol/src/schema/format.ts` | **moved package**, see below |
| `ui`, `ParamHints`, `ParamKind`, `readHints`, `reconcileParams` | **unchanged** | `ui()` is a shipped public SDK export and `reconcileParams` genuinely is about params |

`formatValue` must move because the **core** now needs it (it builds
`result_summary` at settle, §4.5) and cannot import from `packages/studio`. This
does not cross plan 95's boundary — that boundary is *"`@enkaku/protocol`
contains no word that names a control"*, and `formatValue` names none: it is
`(kind, unit, value) → string`, meaning to text. `formatBytes` and its siblings
move with it, and Studio imports them back, which also removes the second
`humanBytes` copy noted in F16's neighbourhood.

New file, the only result-specific one:

```ts
// packages/protocol/src/schema/result.ts

export const RESULT_STATUSES = ['undeclared', 'valid', 'invalid', 'partial', 'oversize'] as const
export type ResultStatus = (typeof RESULT_STATUSES)[number]
export const ResultStatusSchema = z.enum(RESULT_STATUSES)

export const RESULT_LIMITS = {
  /** Matches `kv.maxValueBytes` (plan 79) — the other place a script persists
   *  structured JSON. One number for "what a script may hand the database". */
  defaultMaxResultBytes: 64 * 1024,
  /** At most three fields may claim the headline. */
  maxSummaryFields: 3,
  maxSummaryChars: 120,
  maxIssues: 20,
  maxIssueMessageChars: 200,
  /** Live progress only. Not a setting: no operator will tune it. */
  maxProgressBytes: 4 * 1024,
} as const

/** Declaration-ordered paths of the fields marked `summary: true`, capped and
 *  validated. Computed ONCE per script version, cached on the registry entry. */
export function summaryFields(schema: JsonSchemaNode | null): SummaryField[]

/** `[{ videos: 312 }, { watchSeconds: 2520 }] → "312 videos · 42 min"`.
 *  Pure; uses `formatValue`; returns `null` when nothing is marked. */
export function buildResultSummary(fields: SummaryField[], value: unknown): string | null
```

### 4.2 The SDK — `packages/sdk/src/types.ts`, `define-script.ts`

```ts
/** `unknown` when no result schema is declared — today's behaviour, unchanged. */
export type ResultValue<R> = R extends z.ZodTypeAny ? z.infer<R> : unknown

export interface ScriptDefinition<
  S extends z.ZodTypeAny = z.ZodTypeAny,
  R extends z.ZodTypeAny | undefined = undefined,
> {
  id: string
  version: string
  params: S
  /**
   * What a successful run produces. OPTIONAL and always optional — a script
   * that declares nothing keeps `Promise<unknown>` and stores its return value
   * exactly as before (plan 97 §3.2).
   *
   * Declaring it buys three things: `tsc` checks `run`'s return value here in
   * your editor; the farm records whether the value kept the promise; and the
   * job screen renders values instead of JSON.
   */
  result?: R
  timeout?: number
  retries?: number
  prepare?(ctx: ScriptContext<z.infer<S>>): Promise<void>
  run(ctx: ScriptContext<z.infer<S>>): Promise<ResultValue<R>>
  /**
   * ALWAYS runs — must be stateless and idempotent. Its return value is used
   * ONLY when `run()` did not produce one (i.e. the run failed): it is stored
   * as the job's result with `resultStatus: 'partial'` and is NOT validated
   * (plan 97 §3.5). Returning nothing is exactly today's behaviour.
   */
  finish?(ctx: ScriptContext<z.infer<S>>): Promise<unknown | void>
  reset?: { packages: string[]; clearData?: boolean }
}
```

`defineScript` gains one check beside its four existing ones — *if* `result` is
present it must be a Zod schema — with the same message shape as the `params`
check at `define-script.ts:15-17`. Absent is not an error and never becomes one.

`ScriptContext` gains one method:

```ts
/**
 * A live, unpersisted snapshot of how the run is going (plan 97 §3.7).
 * Coalesced to at most one push per `job.progressIntervalMs`, last value wins;
 * over 4 KiB it is dropped with a warning. It is NOT the result: it is never
 * stored, never validated, and never readable by another job.
 */
progress(value: unknown): void
```

And `JobsApi.resultOf` gains a schema overload, modelled directly on `KvApi.get`
(`types.ts:155-172`), which already solves this exact problem for stored JSON:

```ts
resultOf(jobId: string): Promise<unknown | null>
/** Validates against `schema` before returning — throws, naming the job and the
 *  paths, when the shape does not match. The consumer declares what it expects;
 *  the producer declared what it emits; the farm recorded whether they agreed. */
resultOf<T>(jobId: string, schema: z.ZodType<T>): Promise<T | null>
```

No server change: the overload validates child-side, exactly where `kv.get`
does. The narrow, namespace-scoped, `not-finished`-refusing door of F21 is
untouched.

### 4.3 The two process boundaries

**Child → parent** (`packages/session/src/runner/ipc.ts:197-204`):

```ts
z.object({
  t: z.literal('result'),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: ScriptErrorSchema.optional(),
  finishRan: z.boolean(),
  /** plan 97 — the child's own verdict; the parent takes its word on shape
   *  (§3.8) and re-checks only bytes and enum membership. */
  outcome: z.object({
    status: ResultStatusSchema,
    bytes: z.number().int().nonnegative(),
    issues: z.array(ParamIssueSchema).max(RESULT_LIMITS.maxIssues).optional(),
  }).optional(),
}),
z.object({ t: z.literal('progress'), value: z.unknown() }),   // new, §3.7
```

`outcome` is optional so a bundle built before this plan — a real case, bundles
are stored in the DB — still parses; a missing `outcome` means `undeclared`.

**Node → control plane** (`packages/protocol/src/tunnel.ts:220-244`): the
existing `JobProgressMessage.result` object gains the same `outcome`, and
`kind` gains `'progress'` carrying the §3.7 snapshot. F6: without this the
cloud path silently keeps the old, untyped behaviour.

### 4.4 Database — one migration, `0042_*.sql`

```ts
// packages/core/src/db/schema.ts — scripts
resultSchema: text('result_schema', { mode: 'json' }),   // beside paramsSchema at :376

// packages/core/src/db/schema.ts — jobs, beside result at :223
/** plan 97 §3.3 — five states; NULL while queued or running. */
resultStatus: text('result_status'),
/** Serialised UTF-8 bytes of what the script returned, including a value too
 *  large to store — which is the only record that it existed. */
resultBytes: integer('result_bytes'),
/** ≤ 120 chars, built at settle from the schema's `summary` fields. NULL when
 *  the schema marks none. The list needs this precisely BECAUSE `result` is
 *  deliberately not in the list (F18): computing it on read would mean loading
 *  two hundred results to render two hundred lines. */
resultSummary: text('result_summary'),
/** ParamIssue[] — only for `invalid` and only from the child's real Zod run.
 *  NOT recomputed on read: the read side has the JSON Schema, the child had
 *  the Zod schema, and F26 means they can legitimately disagree. */
resultIssues: text('result_issues', { mode: 'json' }),
```

Backfill in the same migration (§3.3):
`UPDATE jobs SET result_status = 'undeclared' WHERE finished_at IS NOT NULL;`

No new index: every read is either by job id (primary key) or part of an
existing list projection.

### 4.5 The core — `packages/core/src/jobs/result-store.ts` (new)

The one place the parent turns a child's verdict into columns:

```ts
export interface RecordedResult {
  result: unknown
  resultStatus: ResultStatus
  resultBytes: number | null
  resultSummary: string | null
  resultIssues: ParamIssue[] | null
}

/** Pure. `outcome` is what the child reported (§4.3); `summary` is the cached
 *  `summaryFields()` for the script version that ran. */
export function recordResult(input: {
  value: unknown
  outcome: ChildResultOutcome | undefined
  summary: SummaryField[]
  maxResultBytes: number
}): RecordedResult
```

- Re-checks `bytes` against `maxResultBytes` and the status against
  `RESULT_STATUSES`; a child claiming `valid` for an over-cap value is
  overridden to `oversize` (§3.8: bytes and enum are the two things the parent
  can know independently).
- Builds `resultSummary` with `buildResultSummary`, capped at 120 chars.
- Truncates `issues` to 20, each message to 200 chars.

`summaryFields(resultSchema)` is computed **once per script version** and cached
on the `ScriptRegistry` entry beside `paramsSchema`, not once per job — the walk
is O(fields) and a farm settles thousands of jobs.

Wired at the single existing seam: `executor-host.ts:166-174`'s
`deps.jobStore.finish(...)` call, whose `data` object grows the five fields, and
`job-store.ts:343-355`'s `.set({...})`, which writes them.

### 4.6 Protocol shapes

```ts
// packages/protocol/src/messages/job.ts

// JobInfoSchema (the LIST shape) — two additions, ~140 bytes/row.
// `result` itself stays off the list, unchanged (F18).
resultStatus: ResultStatusSchema.nullable().default(null),
resultSummary: z.string().max(RESULT_LIMITS.maxSummaryChars).nullable().default(null),

// JobDetailSchema — three more. All `.nullable().default(null)`: a bare
// `z.unknown()` is a REQUIRED key under Zod 4 and a response missing it throws
// E_BAD_RESPONSE (`packages/protocol/src/api/jobs.ts:12-19`).
resultBytes: z.number().int().nullable().default(null),
resultIssues: z.array(ParamIssueSchema).nullable().default(null),
/** The result schema of the script VERSION that ran — inlined rather than left
 *  to a second fetch, because a second fetch could resolve to a different
 *  version after a rollback, and the screen would then render one version's
 *  value through another's schema. */
resultSchema: JsonSchemaNodeSchema.nullable().default(null),

// JobSummarySchema (what ctx.jobs sees) — gains resultStatus ONLY.
// Never the value, never the summary text: plan 80 §3.3's rule that a
// neighbouring script reads a result through `resultOf` and nowhere else
// stands. The status is metadata about the contract, not the payload.
resultStatus: ResultStatusSchema.nullable(),

// New server→client message (§3.7)
export const JobProgressEventMessage = z.object({
  type: z.literal('job.progress'),
  payload: z.object({ jobId: z.string(), deviceId: z.string(), value: z.unknown() }),
})
```

### 4.7 API and the agent surface

| Method | Path | Change |
|---|---|---|
| `GET` | `/api/jobs/:id` | `JobDetail` gains `resultStatus`, `resultBytes`, `resultIssues`, `resultSchema` |
| `GET` | `/api/jobs` | each row gains `resultStatus`, `resultSummary`; **`result` still absent** |
| `GET` | `/api/scripts/:id` | gains `resultSchema` (already `typedJson`-validated since 95.5) |
| `GET` | `/api/scripts` | gains `hasResult: boolean` only — the schema itself would repeat plan 95 F30's mistake in a second column |
| `POST` | `/api/scripts` | body accepts `resultSchema`; `checkDeclaredSchema` rejects with `E_RESULT_SCHEMA_INVALID` listing every finding |

Agent and MCP:

- `capability/script.ts`'s `ScriptDetailSchema` gains `resultSchema` — so a
  model can read what a script promises **before** running it, which is the
  cheap half of plan 95 §9 Q3 and needs no tool roster change.
- `capability/job.ts`'s `jobGet` output already is `JobDetailSchema`, so it
  inherits everything above with **no capability edit at all** — the payoff of
  F22's shape.
- `mcp/server.ts:89` gains `outputSchema: toJsonSchema(cap.output)` beside
  `inputSchema`. F23: the registry already validates a Zod `output`, the
  conversion already exists at `api/cap.ts:91`, and `tools/call` already emits
  `structuredContent` at `:114` — the field's absence is the only reason an MCP
  client cannot interpret what it is already being sent. Two lines.

### 4.8 Studio — `packages/studio/src/components/result-view/`

```
plan-result.ts      // planResult(node, value): PlannedResultField[] — §3.6's R1/R2/R3,
                    // delegating every structural decision to planField. Pure, no React.
plan-result.test.ts // one case per rule + the hostile corpus + "undeclared renders raw"
ResultView.tsx      // renders a PlannedResultField tree read-only, via formatValue
ResultView.test.tsx
```

`packages/studio/src/app/jobs/detail/page.tsx:493-534` renders `<ResultView>`
when `job.resultSchema` is present and today's `<pre>` when it is not.
`resultStatus: 'invalid'` shows one line above the values naming the paths from
`resultIssues`; `'oversize'` shows §3.4's message; `'partial'` shows *"this run
failed — these are the values it had reached"*. `JobsList.tsx` gains one muted
line under the script name carrying `resultSummary`.

### 4.9 Settings — `packages/protocol/src/settings.ts`, the existing `job` block

```ts
maxResultBytes: z.number().int().min(1_024).max(1_048_576).default(65_536)
  .describe('Largest result a script may return, in bytes. Larger output belongs in an artifact.')
  .meta(ui({ title: 'Max result size', kind: 'bytes', group: 'Jobs' })),
progressIntervalMs: z.number().int().min(250).max(10_000).default(1_000)
  .describe('How often a running job may push a live progress snapshot.')
  .meta(ui({ title: 'Progress interval', kind: 'duration', unit: 'ms', group: 'Jobs' })),
```

Both render with the right control and readout and **zero Studio edits** — plan
95 F33's multiplier, collected rather than described.

---

## 5. Implementation steps

### 97.1 — One schema module, shared by both halves (mechanical)

- [x] Move `packages/protocol/src/params/` → `packages/protocol/src/schema/`;
      rename `PARAMS_LIMITS` → `SCHEMA_LIMITS`, `checkParamsSchema` →
      `checkDeclaredSchema`, `validateParams` → `validateAgainstSchema`,
      `clampParamsSchema` → `clampSchema`. `ui`, `ParamHints`, `readHints` and
      `reconcileParams` keep their names (§4.1).
- [x] Move `formatValue`, `formatBytes` and their siblings from
      `packages/studio/src/components/schema-form/controls/format.ts` to
      `packages/protocol/src/schema/format.ts`; Studio re-imports them.
      (`NumberKind` — `formatValue`'s own parameter type — moved with it: it
      was previously defined in Studio's `plan.ts` and imported backwards
      into `format.ts`, which would have made the new `@enkaku/protocol`
      location depend on `packages/studio`. It is now defined in
      `schema/format.ts` from `ParamKind`, re-exported from the package root,
      and `plan.ts` imports it back like every other vocabulary type.)
- [x] Migrate **every** call site in the same commit (00-overview §4.3). The
      plan's own list above was stale — re-grepped rather than trusted, per
      this step's brief. Actual set: `core/src/scripts/routes.ts`,
      `core/src/plugins/verify-child-entry.ts`, `core/src/plugins/verify-child.ts`
      (comment only), `core/src/api/workflows.ts`, `sdk/src/cli/publish.ts`,
      `core/src/jobs/executors/script.ts`, `core/src/jobs/executors/workflow.ts`
      (both already aliased their import as `validateAgainstSchema` — the
      alias is now redundant and was removed), `studio/.../SchemaForm.tsx`,
      `SchemaForm.test.tsx`, `RunScriptDialog.tsx`, `ScheduleEditorDialog.tsx`,
      `schema-form/plan.ts`, `schema-form/plan.test.ts`, `schema-form/resolve.ts`,
      `schema-form/controls/{ChanceControl,PairControl,NumberControl}.tsx`,
      `protocol/src/{workflow.ts,workflow-check.ts,workflow-params.ts,
      workflow-params.test.ts,settings.ts,runtime-envelope.ts}` (relative
      `./params/*` imports), plus every test file under the moved directory.
      `core/src/schedules/runner.ts`, `core/src/api/schedules.ts` and
      `core/src/api/batches.ts` — named in the plan's stale list — no longer
      reference this vocabulary directly (they go through
      `validateScriptForRun`/the executor now) and needed no edit.
      `ParamSetPicker.tsx` only imports `reconcileParams`/`summarizeApply`,
      neither renamed, and needed no edit either. The `Executor` interface's
      OWN `validateParams(params, scriptId)` method (`core/src/jobs/executor.ts`
      and every executor/mock that implements it — `sleep.ts`, `install.ts`,
      `remote.ts`, `daemon.ts`, every `executor-host.test.ts`-style mock) is a
      same-named but unrelated concept and was deliberately left untouched.
- [x] `packages/protocol/src/index.ts` — re-export from the new path, plus a
      new `formatValue`/`NumberKind` export (`format.ts` was not exported
      from the package at all before this step, since it lived in Studio).
- **Verifiable result:** `git diff --stat` is imports, identifiers and file
  paths only — no logic line changes. `bun run typecheck`, `bun test` and
  `bun run --cwd packages/studio test` are green with **zero** test-body edits
  beyond the renames. Plan 95's own test files pass unmodified in substance.

### 97.2 — Declaring an output (fixes F1, F2, F5; tests H1) — DONE

- [x] `packages/protocol/src/schema/result.ts` — §4.1 in full:
      `RESULT_STATUSES`, `ResultStatusSchema`, `RESULT_LIMITS`,
      `summaryFields`, `buildResultSummary`. `SummaryField` (`{path, title,
      kind, unit}`) is the type the plan's own snippet left implicit;
      `buildResultSummary` renders a numeric `kind` through `formatValue`
      directly (`chance`/`duration`/`bytes`/`bitrate`/`pixels`/`temperature`
      already carry their own unit) and appends the field's own title for
      `count`/no-kind numbers, since a bare number alone names nothing —
      `312` + title "Videos watched" → `"312 videos"`, joined with
      `watchSeconds` → `"312 videos · 42 min"`, the exact worked example the
      plan's own doc comment names. Unit-tested in `result.test.ts`
      (protocol) — 26 new cases covering the five states, every limit, the
      declaration-order/cap/malformed-hint paths of `summaryFields`, and
      `buildResultSummary`'s null/missing-field/truncation/every-kind paths.
- [x] `packages/protocol/src/schema/vocabulary.ts` — add `summary?: boolean` to
      `ParamHints`, `ParamHintsSchema` and `ui()`'s overloads. One key, nothing
      else (§3.6). `ui()`'s two overloads both spread `Omit<ParamHints, 'kind'
      | 'unit'>`, so `summary` flows through them with no separate edit to the
      overload signatures themselves — verified by a new `ui()` test case.
- [x] `packages/sdk/src/types.ts` — `ResultValue<R>`, the second generic,
      `result?: R`, `run`'s conditional return, `finish`'s widened return
      (`Promise<unknown | void>`, plan §3.5/§4.2 — used ONLY on the failure
      path, never validated; that wiring is step 97.4's, not this step's).
- [x] `packages/sdk/src/define-script.ts` — validate `result` **only when
      present**, same message shape as `:15-17`. The second generic `R` is
      also added to `defineScript`'s OWN signature (`ScriptDefinition` alone
      only carries the default with a single explicit type argument) —
      required for H1: without it, `R` cannot be inferred from the `def`
      argument at the author's call site and always resolves to its default.
- [x] `packages/sdk/src/result.type-test.ts` — H1: `@ts-expect-error` on a wrong
      return with `result` declared; a positive case with no `result` returning
      an arbitrary value; a positive case returning the declared shape. Named
      `.type-test.ts` (not `.test.ts`) deliberately — it sits outside `bun
      test`'s default `*.test.ts` discovery glob, so it is exercised by
      `bash scripts/typecheck.sh`'s real `tsc --noEmit -p packages/sdk` only;
      it can still be run explicitly with `bun test
      packages/sdk/src/result.type-test.ts`. A companion positive/negative
      pair was also added to `define-script.test.ts` for the runtime half
      (a non-Zod `result` throws, a Zod one is kept intact).
- [x] `packages/sdk/src/cli/publish.ts` — emits
      `z.toJSONSchema(result, { io: 'output' })` at its own call site
      (`checkAndReportResultSchema`, a sibling of `checkAndReportParamsSchema`,
      never sharing its call), runs `checkDeclaredSchema` locally before the
      network call, and points the existing `warnAboutRefinements` at the
      result schema too — all three, only when `def.result !== undefined`.
- [x] `packages/core/src/plugins/verify-child-entry.ts` — the same for plugin
      members: `s.result`, when present, is `z.toJSONSchema(..., { io:
      'output' })`'d and `checkDeclaredSchema`-gated (`E_RESULT_SCHEMA_INVALID`,
      naming the member id), independently of `paramsSchema`'s own check just
      above it. `verify-child.ts`'s `VerifiedScript` and `plugins/runtime.ts`'s
      `writeScriptRows` carry `resultSchema` through to the `scripts` insert,
      mirroring `paramsSchema` exactly (`resultSchema` is optional on the wire
      types, unlike `paramsSchema`, purely so a hand-built `VerifiedScript`
      fixture elsewhere in the tree — several outside this pass's own
      ownership list — keeps compiling with no edit of its own; every REAL
      verify-child report always sets it).
- [x] `packages/core/src/db/schema.ts` — `scripts.resultSchema` (nullable JSON,
      beside `paramsSchema`), migrated by `bun run --cwd packages/core
      db:generate` as `drizzle/0055_cheerful_wallflower.sql` (a single plain
      `ALTER TABLE scripts ADD result_schema text`, never hand-written).
      `packages/core/src/scripts/routes.ts` — `PublishBody.resultSchema`
      (same `JsonSchemaNodeSchema.nullable().optional()` shape as
      `paramsSchema`), gated by `checkDeclaredSchema`
      (`E_RESULT_SCHEMA_INVALID`, the exact `blockingFindings` treatment
      `paramsSchema` gets) before `publishScript` ever runs; `GET /:id`
      returns it (same `JsonSchemaNode | null` reconciliation `paramsSchema`
      already has); `GET /` returns `hasResult: boolean` only, per §4.7's own
      table (`ScriptListItemSchema` in `@enkaku/protocol` omits `resultSchema`
      and adds `hasResult`). `scripts/service.ts`'s `ScriptDetail`/
      `PublishScriptInput`/`getScriptDetail`/`publishScript` all carry it
      the same way they already carry `paramsSchema`.
  > **The read side that actually reaches `GET /api/jobs/:id` — the whole
  > point of closing this gap — is `packages/core/src/queue/job-store.ts`'s
  > `scriptNames()`, not `scripts/routes.ts`.** `services/job-service.ts`
  > (off this pass's file list; a concurrent worker holds it for plan 93 step
  > 93.8) already calls `rowToJobDetail(row,
  > deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId))` — so
  > widening `scriptNames()`'s return value with an ADDITIVE `resultSchema`
  > field (selected straight off `scripts.result_schema` in the same query)
  > reaches `JobDetail.resultSchema` with **no edit to `job-service.ts` at
  > all** — the exact kind of forward-compatible seam 97.5's own author
  > described and this pass only had to fill in. `capability/script.ts`'s
  > `scriptGet` handler had a real latent bug fixed alongside this: it spread
  > `{ ...script, resultSchema: null }`, which — once `ScriptDetail` actually
  > carried a real value — would have SILENTLY OVERWRITTEN it back to `null`
  > on every read; now it forwards `script.resultSchema` (reconciled the same
  > way `routes.ts`'s own `GET /:id` is).
  > **`sdk/src/plugin.ts`'s `PluginMemberScript<S>` now carries the second
  > generic** (`PluginMemberScript<S, R>`), closing the exact gap this
  > checklist named ("left for whoever picks up 97.8"). The mechanism is NOT
  > the two-independent-array-generic approach this note originally
  > speculated about — tried, and confirmed unworkable: `tsc` cannot
  > reverse-infer a SECOND array generic from the same `keyof S` mapped-type
  > position a first one already occupies; every member's `result` silently
  > collapsed back to `undefined` (see `plugin-result.type-test.ts`'s own
  > header for the two failed attempts and why). What actually works:
  > `PluginMemberScripts<S>`'s per-element `R` is loosened to
  > `z.ZodTypeAny | undefined` (accepts anything at the ARRAY position), and
  > H1 for a plugin member is instead proven at the member's own `const`
  > DECLARATION — `const foo: PluginMemberScript<typeof params, typeof
  > result> = {...}` — exactly the pattern `switch-account.ts`/
  > `search-follow.ts` already used before this plan. `definePlugin`'s
  > runtime validation loop also gained the same `result`-is-a-Zod-schema
  > check `defineScript` already has, for a member that skips explicit
  > typing entirely.
  > **A new end-to-end proof**, `packages/core/src/scripts/publish-result-e2e.test.ts`
  > (2 cases): publishes a script through the real `POST /api/scripts` route
  > with a declared `result`, settles a job for it (via `jobStore.claimNext`
  > + `jobs/result-store.ts`'s real `recordResult` — the same pure function
  > `executor-host.ts`'s settle seam calls in production, imported rather
  > than re-implemented) and asserts the job read back through
  > `rowToJobDetail` — the exact function `GET /api/jobs/:id` serves from —
  > carries a non-null `resultSchema` equal to what was published and
  > `resultStatus: 'valid'`; the second case proves a hostile result schema
  > (`__proto__`, built with `JSON.parse`, never an object literal) is
  > refused at publish with `E_RESULT_SCHEMA_INVALID`, never reaching
  > storage. This does not spawn a real child process — that boundary is
  > already end-to-end tested by `child-entry.test.ts` (H2) — it proves the
  > STORAGE half: a schema published today is the schema a job detail reads
  > back tomorrow, pinned to the version that actually ran.
- **Verifiable result:** a script declaring `result` with a wrong `run` return
  fails `bun run typecheck` in its own project; one declaring nothing compiles
  and publishes exactly as before; `z.date()` in a result schema is rejected at
  publish with F27's message rather than at runtime; each of K7's ten hostile
  fixtures is rejected as a result schema with a named finding — proved for
  the standalone SDK path already (97.2's own H1 type-tests) and now also for
  the `POST /api/scripts` route and the plugin verify child
  (`publish-result-e2e.test.ts`).

### 97.3 — The runtime: measure, then check, then store (fixes F3, F4, F10, F11; tests H2) — DONE

- [x] `packages/session/src/runner/child-entry.ts` — `buildResultOutcome`
      (called on the success path, right before the final `send`): serialise
      inside a `try`, measure with `TextEncoder`, walk for
      `DANGEROUS_FIELD_NAMES` (V3, exported from `@enkaku/protocol`'s
      `schema/limits.ts`), and only then `safeParse` against `def.result`
      **using the verdict, never the parsed value** (§3.3, F25). Builds
      `outcome`. Over cap → send the verdict without the value (§3.4).
      Circular → `invalid` with V2's message, `bytes: 0`.
- [x] `packages/session/src/runner/ipc.ts` — `outcome` (`ResultOutcomeSchema`,
      new in `schema/result.ts`) on the `result` message (§4.3), optional so
      pre-plan bundles still parse. `init` gained a REQUIRED `maxResultBytes`
      (mirrors `rssSampleMs`'s own convention).
- [x] `packages/session/src/runner/job-runner.ts` — carries `outcome` through
      `AttemptOutcome`, the `JobRunner.execute()` return type, the `result`
      handler and `execute`'s final return (all additive/optional — line
      numbers in this checklist were stale, per this step's own brief).
      `maxResultBytes` threaded from the farm's `job.maxResultBytes` setting
      into `init` via `sendInit`, defaulting to
      `RESULT_LIMITS.defaultMaxResultBytes` when the caller supplies none.
- [x] **Deviated from the literal text** — `packages/core/src/jobs/executor.ts`
      gained `ExecutorContext.onResultOutcome` (mirroring `onPeakRss` exactly)
      rather than widening `JobExecutor.run()`'s return type to
      `{value, outcome?}`: that interface is shared by five unrelated
      executors and dozens of test mocks this step does not own, and would
      have been a breaking change for a concept only the script/remote paths
      have. Full reasoning in the `> Status:` line above and in
      `executor.ts`'s own doc comment. `executors/script.ts` and
      `executors/remote.ts` both wire it.
- [x] `packages/core/src/jobs/result-store.ts` — §4.5, pure, unit-tested alone
      (`result-store.test.ts`, 15 cases).
- [x] `packages/core/src/jobs/executor-host.ts` and
      `packages/core/src/queue/job-store.ts` — write the four result columns
      (not five — `peakRssBytes` already exists from plan 98) at the single
      `deps.jobStore.finish(...)` seam, only for a `success` settle.
- [x] `packages/core/src/db/schema.ts` + `drizzle/0052_petite_juggernaut.sql`
      (generated by `bun run --cwd packages/core db:generate`, never
      hand-written — `0042` in this checklist was stale, confirmed by this
      step's own brief) — the four `jobs` columns and §4.4's backfill,
      appended by hand to the generated file per the `0031_colorful_smasher.sql`
      precedent. See the `docs/plans/00-overview.md` §9 row this step could
      not write itself (that file is held by a concurrent worker) — its exact
      text is in this worker's own final report for the human to relay.
- [x] `packages/protocol/src/settings.ts` — `job.maxResultBytes`,
      `job.progressIntervalMs` (§4.9).
- [x] The remote path (F6): `tunnel.ts`'s `JobProgressMessage.result` gained
      `outcome`; `executors/remote.ts`'s `PendingJob` carries
      `onResultOutcome` through the tunnel round-trip; `node/src/hosts.ts`
      forwards `result.outcome` over the wire.
- **Verifiable result:** a script returning 50 MB settles `success` with
  `resultStatus: 'oversize'`, `result_bytes` exact, `result` `NULL`, in under
  the time an ordinary job takes — and a memory profile of the **parent** shows
  no allocation proportional to the returned size. **Proven, with one caveat**:
  `child-entry.test.ts`'s oversize test spawns the real child and asserts no
  `value` key ever appears on the wire message (a 2 KB fixture over a 1 KB
  cap, chosen for test speed — the real 50 MB scenario the acceptance
  criterion names would take the design's OWN mechanism, unchanged, since the
  cap check happens before serialisation size matters at all). No literal
  memory PROFILE (a heap snapshot or RSS diff of the parent process) was
  taken — that is a manual/tooling step, not a `bun test` assertion, and is
  left as *pending — owner to run* if a numeric profile is wanted beyond the
  structural proof ("the value never crosses IPC" already given above). A
  circular result settles
  `invalid` with V2's message instead of H2's hang. A result with `__proto__` at
  any depth settles `invalid` with the path named. A script that declares no
  result schema produces a row byte-identical to today's plus
  `result_status = 'undeclared'`.

### 97.4 — What a failed run can still say (fixes F7, F8) — DONE

- [x] `packages/session/src/runner/child-entry.ts:448-457` — when `failure` is
      set and `finish()` returned a value, send **both** the error and the value
      with `outcome.status = 'partial'` and no validation (§3.5).
- [x] `:411` — the finish-only re-attempt path carries it too. (`job-runner.ts`'s
      `execute()` needed its own fix beside this one — the finish-only
      attempt's own `value`/`outcome` were computed but never merged onto the
      job's final return; see the `> Status:` paragraph above.)
- [x] `run()`'s value wins when both exist; one test asserts it (`run()`
      succeeds, `finish()` itself then throws).
- [x] `packages/core/src/jobs/result-store.ts` — `partial` never overwrites a
      `valid`; `partial` never sets `result_issues`.
- **Verifiable result — confirmed by test**: a script whose `run()` throws
  after doing real work, whose `finish()` returns
  `{ videosBeforeFailure: 280 }`, produces a `failed` job whose `error`,
  `failureClass` and `errorPhase` are unchanged from today **and** whose
  result is `{ videosBeforeFailure: 280 }` at `resultStatus: 'partial'`
  (`child-entry.test.ts`'s "salvage" case plus `executor-host.test.ts`'s
  "97.4 closes the gap" case). A `finish()` returning nothing produces a row
  identical to today's (asserted directly, both for the in-attempt failure
  path and the finish-only re-attempt path).

### 97.5 — The read paths (fixes F18's blind spots, F21, F22, F23)

- [x] `packages/protocol/src/messages/job.ts` — §4.6's additions to `JobInfo`,
      `JobDetail` and `JobSummary`, every one `.nullable().default(null)`
      (`JobSummary`'s `resultStatus` un-defaulted, matching the plan's own
      §4.6 snippet and its sibling fields).
- [x] `packages/core/src/queue/job-store.ts` — `rowToJobInfo` and
      `rowToJobDetail` project them; `rowToJobDetail` inlines `resultSchema`
      from the pinned script row (§4.6's reasoning). **Reads back `null`
      today** — `scripts.resultSchema` (97.2's still-open storage half) does
      not exist yet and `db/schema.ts` was off this step's file list; the
      plumbing is forward-compatible and needs no further edit once that
      column lands.
- [x] `packages/core/src/api/jobs.ts` — both routes, needing **no code
      change**: `typedJson` already validates against `JobsPageResponseSchema`/
      `JobResponseSchema`, which reference the edited schemas directly, and
      `service.list`/`service.get` already thread `job-store.ts`'s projections
      through.
- [x] `packages/sdk/src/types.ts` + `packages/session/src/runner/jobs-client.ts`
      — `resultOf`'s schema overload, validating child-side exactly as
      `kv.get` does. **No server change**; `script-jobs.ts`'s three refusals are
      untouched.
- [x] `packages/core/src/capability/script.ts` — `resultSchema` on
      `ScriptDetailSchema` (same `null`-until-97.2's-column caveat as
      `job-store.ts` above).
- [ ] `packages/core/src/mcp/server.ts:89` — `outputSchema` beside
      `inputSchema`. **Not done** — `core/src/mcp/**` was not in this step's
      own file-ownership list; left for whoever holds it.
- **Verifiable result:** `GET /api/jobs` returns `resultSummary` for a declared
  script and `null` for an undeclared one, with **no** `result` field on any
  row — **done**. `GET /api/jobs/:id` carries the schema of the version that
  ran, proved by publishing `2.0.0`, running a job, publishing `2.1.0` with a
  different result shape, and re-reading the first job — **cannot be
  demonstrated yet**: `scripts.resultSchema` has no column to publish into
  until 97.2's storage half lands. `ctx.jobs.resultOf(id, Schema)` throws
  naming the job and the path when a neighbour's shape changed — **done**,
  mirroring `kv.get`. MCP `tools/list` advertises `outputSchema` for every
  capability and `mcp/server.test.ts` asserts it against `job.get` — **not
  done**, out of this step's file list (see above).

### 97.6 — A result that reads as values (fixes F19, F20; tests H3)

- [x] `packages/studio/src/components/result-view/plan-result.ts` — §3.6's three
      rules and nothing else, delegating every structural decision to
      `planField`. Pure; its test imports no React.
- [x] `packages/studio/src/components/result-view/ResultView.tsx` — read-only
      render through `formatValue`, K7's nesting rule, `humanize` as the
      last-resort label.
- [x] `packages/studio/src/app/jobs/detail/page.tsx` (line numbers were stale,
      as the plan warned — the block was at `:1085-1125` before this step) —
      `<ResultView>` when a schema exists, today's `<pre>` when it does not;
      the three status banners (§4.8).
- [x] `packages/studio/src/components/JobsList.tsx` — one muted
      `resultSummary` line. **Done by step 97.5** (that step owned the file
      and landed `resultSummary` on the wire in the same pass).
- [x] **Delete** `readFindings`, `severityTone`, `JobFinding`
      (`packages/studio/src/lib/jobs.ts:71-115`) and their tests
      (`jobs.test.ts:63-76`); keep `formatResult`. **Done by step 97.5** —
      `jobs.test.ts` already carried no test for the three (verified before
      deleting, not assumed), so no test file needed a matching edit.
- [ ] **Not done, out of this step's reach: the wiring that makes any of the
      above actually fire in production.** `JobDetailSchema`
      (`packages/protocol/src/messages/job.ts`) does not yet carry
      `resultStatus`/`resultBytes`/`resultIssues`/`resultSchema`/
      `resultSummary` — that is step 97.5 (§4.6, "the read paths"), explicitly
      **not started** as of this step (see 97.4's own status line above),
      and `packages/protocol/**`/`packages/core/**` are both outside this
      step's file list. `page.tsx` reads these five fields through a locally
      declared `JobWithResultInfo` intersection type (all-optional, field
      names copied verbatim from §4.6's own draft) so it compiles against
      today's `JobDetail` and degrades to exactly today's `<pre>` — `zod`
      strips any key `JobDetailSchema` does not declare, so even a core that
      already computed these values would have them silently dropped by
      `JobResponseSchema.safeParse` before `page.tsx` ever saw them. This
      step's own components (`planResult`, `ResultView`) are fully built and
      independently tested against direct schema+value props; the banners and
      `<ResultView>` mount are wired and typecheck against the forward-compat
      type; none of it can be exercised end-to-end, and none of `page.test.tsx`
      claims otherwise, until 97.5 adds the five fields to `JobDetailSchema`
      and `rowToJobDetail` — at which point `page.tsx` needs no further edit,
      only 97.5's own file list to gain the matching keys.
- **Verifiable result:** the tiktok pack's own result renders every field
  through an existing `FieldPlan` row with **no new control** (H3); a
  discriminated-union result renders the branch the value took, not raw JSON
  (R1); a `z.record` renders its actual keys as rows (R2); a value with a key
  the schema never declared shows that key rather than hiding it (R3); an
  `undeclared` result renders byte-identically to today.

### 97.7 — Live progress, which is not a result (answers H4)

- [x] `packages/sdk/src/types.ts` — `ScriptContext.progress(value)`.
- [x] `packages/session/src/runner/ipc.ts` + `child-entry.ts` — the `progress`
      message; coalescing lives in the **child** (one timer, last value wins) so
      an emit loop costs one assignment and the IPC channel sees one message per
      interval.
- [x] `job-runner.ts` → `executor-host.ts` → `hub.broadcast` — `job.progress`,
      dropped over `RESULT_LIMITS.maxProgressBytes` with one `warn` per job.
      **No DB write anywhere on this path**, asserted by a test that counts
      `UPDATE`s.
- [ ] `packages/protocol/src/tunnel.ts` — `kind: 'progress'` for the cloud path.
      **Not done** — `tunnel.ts` is not in this pass's file-ownership list
      (only `messages/job.ts`/`index.ts`/`schema/**` are); the local path is
      complete and self-contained (`RESULT_LIMITS.maxProgressBytes` and
      `job.progressIntervalMs` both already existed before this step, per
      97.2/97.3's own status paragraphs above), so a node-owned/cloud job
      simply has no live progress yet — a real, named gap, not a silent one.
- [ ] `packages/studio/src/app/jobs/detail/page.tsx` — a live line above the
      result panel, formatted through `formatValue` when the key matches a
      result-schema field. **Not done** — `packages/studio/**` is not in this
      pass's file-ownership list either. The wire message
      (`JobProgressEventMessage`, `type: 'job.progress'`) is shipped and
      broadcast for whoever picks up the Studio half; no server-side edit is
      needed once that lands.
- **Verifiable result:** a script calling `ctx.progress()` 10 000 times in a
  tight loop produces at most one WS message per `progressIntervalMs`, **zero**
  DB writes, and no measurable slowdown; the value is never visible to
  `ctx.jobs.resultOf`; a 5 KiB progress value is dropped with one warning and
  the job is otherwise unaffected. **Verified** — see the status paragraph
  below for exactly which tests prove each clause.

### 97.8 — The worked example (proves H3, H4) — DONE

- [x] `plugins/tiktok-automation-pack/src/index.ts` — declares `result` for
      `auto-scroll`: all thirteen fields it already returned (now a named
      `resultSchema` const, `kind`/`unit` on every numeric one — `kind:
      'count'` for a plain tally, `kind: 'duration', unit: 's'` for the two
      watch-time fields), `summary: true` on exactly two
      (`videos`/`watchSeconds` — H3's own worked example, `"312 videos · 42
      min"`). Both `paramsSchema` and the member object itself moved to
      named top-level `const`s (`paramsSchema`, `autoScrollScript`) out of
      the inline object literal `scripts: [...]` used to hold — required for
      H1 to actually apply here (see 97.2's checklist note above on why
      `definePlugin`'s own array-position inference cannot carry a second,
      per-element generic; H1 is proven at THIS declaration instead).
- [x] Replaced the `ctx.log.info('finished scrolling', {...})` one-shot with
      `ctx.progress({...})` calls inside the per-video loop (right after
      `watched.push`) — the same numbers (`videos`, `watchSeconds`, `matched`,
      `commentVisits`, `backScrolls`, `idlePauses`, `recoveries`), live,
      proving H4 against the real script rather than a synthetic one. The
      final log line is gone outright, not merely duplicated — the numbers
      now live in `ctx.progress` while running and in the declared `result`
      once settled.
- [x] Declared `result` for the pack's other two scripts too — `switch-account`
      (`from`/`to`/`position`/`accounts`/`verified`, `summary: true` on
      `to`/`verified`) and `search-follow` (thirteen fields spanning both
      branches `run()` can return — already-following vs. freshly-followed —
      via optional `followButtonBefore`/`followButtonAfter` rather than a
      discriminated union, since every other field is shared and
      `alreadyFollowing` already names which branch a reader is looking at).
      Neither script "has nothing to return" — no close-out note needed.
- [x] `plugins/tiktok-automation-pack/src/index.test.ts` — a new describe
      block (3 cases) `safeParse`s each declared `result` schema against a
      value shaped exactly like what that script's own `run()` constructs,
      including both of `search-follow`'s branches.
- **Verifiable result:** `bun run typecheck`, `bunx tsc --noEmit -p
  plugins/tiktok-automation-pack` and `bun test
  ./plugins/tiktok-automation-pack` are all green (21/21, up from 18/18).
  The job-LIST/job-DETAIL rendering half of this criterion (`"312 videos ·
  42 min"` on a list row, formatted values instead of `<pre>` on the detail
  page, a live-climbing video count) is `packages/studio/**` — explicitly
  off this pass's file-ownership list — and was already built, independently
  tested, by 97.6; it was blocked only on `scripts.resultSchema` existing
  (this plan's own storage half, closed above) and on this step's own
  worked example actually declaring one. Nothing further is needed from
  Studio's own code for the owner to see it: the wiring is real end to end
  now, proved by `publish-result-e2e.test.ts` above rather than by a
  screenshot, since a screenshot needs a running farm and a device this
  pass has no access to (hardware honesty).

### 97.9 — Documentation — DONE

- [x] `packages/sdk/README.md` — a new "Declaring a result" section: the
      optional `result` field and its worked example, why declaring nothing
      stays the compatibility floor, the compile-time payoff, `io: 'output'`
      vs `io: 'input'` at two named call sites, §3.5's three-way split (*a
      crash is a failure, a salvage is evidence, a handled outcome is a
      result*) with the `finish()` salvage and discriminated-union examples,
      the 64 KiB rule with `ctx.artifact.file` named as the door, `ctx.progress`
      vs the result, and the `.refine()` gap of §3.8 — including the real,
      not-yet-fixed rough edge that `enkaku publish`'s refinement warning
      still says "params"/"the run form" even when it fires for `result`
      (found while writing this section; not fabricated as fixed — see
      `docs/plans/96-m61-hotfixes.md` §96.20).
- [x] `docs/design.md` — a new "Result views" section beside "Schema-driven
      forms": R1/R2/R3 in a table, the "a form plans before, a result view
      plans after" framing, the five `resultStatus` banners and which two
      never reach `ResultView`. The `summary` key is added to the vocabulary
      prose (it is not a `kind`, so not a table row) with its real, honest
      enforcement — capped at three top-level fields, a fourth silently
      excluded from the summary line rather than refused at publish, checked
      against the actual code in `schema/result.ts` rather than assumed from
      the plan's own draft text. The stale `params/vocabulary.ts` path
      reference is corrected to `schema/vocabulary.ts` (97.1's rename).
- [x] `docs/spec.md` — a new §11.9 "The output contract" (the five states,
      the gate-vs-assertion rule, the crash/salvage/handled split, why
      `ctx.progress` is not a result, and the three honestly-named remaining
      gaps: MCP `outputSchema`, the cloud tunnel progress path, Studio's live
      progress line); §11.1's `defineScript` example gains `result`; §11.2
      gains one rule bullet; §12's `jobs` and `scripts` blocks gain the five
      columns as inline `NEW` comments, matching the file's own established
      convention rather than only the DIV-029 prose note; §19's "Job / run
      detail" row gains the three-banner behaviour. §13 already carried the
      `job.progress` sentence (landed by 97.7's own relay) — confirmed
      accurate against the shipped code, not re-written.
- [x] `docs/ux-audit.md:65` — the structured-job-results backend follow-up
      marked **ANSWERED — plan 97 (M62)**, naming what replaced the
      opportunistic `findings[]` guess and why the replacement is a real
      convention rather than another guess.
- [x] `packages/protocol/README.md` — a new `schema/` section (95.11 never
      wrote this file — confirmed by reading plan 95's own status line, not
      assumed): every export in the moved-and-renamed module in one table,
      the `formatValue` move explained (the core needs it too, and cannot
      import Studio), `schema/result.ts`'s new exports, and the `io`
      call-site split with F24's measured evidence. The existing Workflows
      section (plan 99) is untouched.
- [x] `packages/core/README.md` — a new "The output contract" section:
      `result-store.ts`'s `recordResult` (independent re-measurement,
      re-derivation, the `existingStatus` downgrade refusal), the
      `onResultOutcome`/`partialResult` wiring and why `JobExecutor.run()`'s
      return type was deliberately not widened, the publish-time storage
      path and `publish-result-e2e.test.ts` as the proof it reaches
      `GET /api/jobs/:id`, and the named MCP `outputSchema` gap. Not asked
      for by this step's own checklist text, but is one of this pass's
      six owned files and was materially stale (silent on this plan
      entirely) without it.
- [x] **Consolidated the pending hardware/manual-tooling** from this plan's
      own §5 status notes and §7.3 into one ordered table below, mirroring
      plans 90/91/92/99. Every per-step note stays exactly where it was
      written — the table adds a cross-reference and the exact commands.
      **Nothing in it was run** — this step never touched a physical device,
      per this repo's standing rule.
- **Verifiable result:** `bun run spec:check` reports no new GAP;
  `bash scripts/check-plan-status.sh` passes. Both confirmed after every edit
  above — see the final verification block at the end of this status pass.

**Consolidated pending-hardware/manual-tooling table.** Plan 97 is almost
entirely a software contract with no on-device behaviour of its own (a
script runs the same automation either way; only what the farm does with its
return value changed) — so, unlike plans 90–92/99, this table is short: one
row is a genuine manual/tooling step (a heap/RSS profile, not a device
command), and the rest are §7.3's manual-smoke walkthrough, which exercises
the feature against a real published script on a real device the way an
owner would actually first see it working.

| # | Source | Claim | Exact command / procedure | Outcome |
|---|---|---|---|---|
| 1 | Step 97.3's own entry (§5, acceptance criterion 6) | The **parent** process allocates no memory proportional to a 50 MB+ returned value — proven structurally (no `value` key ever crosses IPC for an over-cap result) but never measured as a literal heap/RSS number | Publish a script whose `run()` returns `{ junk: 'x'.repeat(50_000_000) }`; while the job runs, sample the core process with `ps -o rss= -p <core-pid>` (or Activity Monitor) before and during the run; separately, run the same job with `--inspect` and take a heap snapshot around the `result` IPC message | _(unfilled)_ |
| 2 | §7.3 step 1 | While `auto-scroll` runs, `jobs.result` stays `NULL` in the database for the whole run — nothing appears mid-flight, only `ctx.progress` is live | `bun run dev` (core on :7700), `bun run dev:studio` (:3001), `cd plugins/tiktok-automation-pack && bunx enkaku publish`; run auto-scroll from Studio; mid-run, `sqlite3 .dev-data/enkaku.db "select result from jobs where id = '<jobId>'"` | _(unfilled)_ |
| 3 | §7.3 step 2 | On finish, every declared field reads as a value (`312`, `42 min`, `35%`), and the jobs list row reads `"312 videos · 42 min"` | Same run as row 2, read to completion; open the job detail page and the jobs list | _(unfilled)_ |
| 4 | §7.3 step 3 | Breaking the contract on purpose (a schema-violating return) still settles `success`; the panel shows the raw value with the mismatch named; `failureClass` stays `NULL` | Publish `auto-scroll@2.1.1` whose `run` returns `{ videos: 'many' }` (a deliberately wrong type); run it; read the job detail page and `failureClass` | _(unfilled)_ |
| 5 | §7.3 step 4 | A 50 MB return settles `success` with the oversize banner naming `ctx.artifact.file`, `result` `NULL`, and no visible parent-process spike | Publish a script returning `{ junk: 'x'.repeat(50_000_000) }`; run it; read the job detail page; watch `ps`/Activity Monitor during the run (same procedure as row 1) | _(unfilled)_ |
| 6 | §7.3 step 5 | A script whose `run` throws and whose `finish` returns a salvage value settles `failed`, with `error`/`failureClass`/`errorPhase` unaffected and the panel's `partial` banner reading *"this run failed — these are the values it had reached"* | A script with `async run(ctx) { throw new Error('boom') }` and `async finish(ctx) { return { videosBeforeFailure: 280 } }`; run it; read the job detail page | _(unfilled)_ |
| 7 | §7.3 step 6 | An old script that declares no `result` renders byte-identically to before this plan | Run `examples/open-settings.ts` (declares no `result`); read the job detail page and the jobs list row | _(unfilled)_ |
| 8 | §7.3 step 7 | `ctx.jobs.resultOf(id, schema)` from a second script returns a typed object for a matching job, and throws naming the path for a job whose script declared a different shape | A second published script calling `ctx.jobs.resultOf(<auto-scroll jobId>, ResultSchema)`, run twice — once against a matching job, once against a job of a script with an incompatible declared shape | _(unfilled)_ |

None of the eight branches on its outcome — every one is a confirmation of
behaviour already proven against real child processes and fakes in the test
suite (child-entry.test.ts spawns the real process for the oversize/circular/
`__proto__` cases; result-store.test.ts and executor-host.test.ts prove the
settle-time wiring; publish-result-e2e.test.ts proves the publish→read path
end to end). This table exists so an owner sitting down with a real farm and
a real device can walk it top to bottom and see the same claims land in a
browser, not because any of them is still an open design question.

---

## 6. Acceptance criteria

1. **A script that declares no `result` keeps working, unchanged and
   unrepublished.** `plugins/tiktok-automation-pack` at its current version, and
   every bundle already in a farm's database, runs, stores, and renders exactly
   as before, plus `result_status = 'undeclared'`. No warning, no nag, no
   migration.
2. Declaring `result` makes a wrong `run` return value a **compile error in the
   author's own project**; omitting it leaves `run` returning `Promise<unknown>`
   (H1, `packages/sdk/src/result.type-test.ts`).
3. A result schema is published with `io: 'output'` and a params schema with
   `io: 'input'`, at two separate call sites, each carrying the reason. A
   defaulted result field is `required`; a defaulted param field is not (F24).
4. **A result that does not match its own schema never fails the job.** The job's
   `status`, `failureClass` and `errorPhase` are byte-identical to what they
   would have been without a schema; `result_status = 'invalid'`; the value is
   stored **verbatim**, with no key stripped, coerced or reordered.
5. `result_issues` carries paths and sentences from the **real Zod schema**,
   including a `.refine()` that the published JSON Schema does not contain
   (F26), and is never recomputed on read.
6. A script returning 50 MB settles `success` with `result_status = 'oversize'`,
   an exact `result_bytes`, `result = NULL`, and a job-detail message naming
   `ctx.artifact.file` as the fix. **The parent process never allocates memory
   proportional to the returned size** (the cap is enforced in the child).
7. A circular result and a result containing `__proto__` each settle `invalid`
   with a named reason. Neither hangs, neither crashes the runner, neither
   reaches SQLite.
8. `jobs.result` is exactly what the script returned. Every piece of Enkaku
   metadata about it lives in a sibling column, and a repo grep proves no
   envelope key is written inside the value.
9. `GET /api/jobs` carries `resultStatus` and `resultSummary` and **still
   carries no `result`**. `GET /api/jobs/:id` carries the result schema **of the
   version that ran**, proved across a republish.
10. `ctx.jobs.resultOf(jobId)` behaves exactly as it does today;
    `ctx.jobs.resultOf(jobId, schema)` throws naming the job and the path when
    the shape does not match. `script-jobs.ts`'s three refusals are unchanged
    and `not-finished` still refuses.
11. **No streaming result exists.** `ctx.progress` writes nothing to the
    database (asserted by counting `UPDATE`s), is never returned by `resultOf`,
    is never on `JobDetail`, is coalesced to at most one push per configured
    interval regardless of call rate, and is dropped over 4 KiB with one warning.
12. A failed run whose `finish()` returns a value stores it at
    `result_status = 'partial'`, unvalidated, without touching `error`,
    `failureClass` or `errorPhase`. A `finish()` returning nothing produces
    today's row.
13. `planResult` adds exactly three rules to `planField` and forks none of it: a
    discriminated union renders its taken branch, a `z.record` renders its
    actual keys, a key absent from the schema is shown rather than hidden. Its
    test file imports no React.
14. A result renders as values, not JSON: a duration reads `4 min 12 s`, a
    chance reads `35%`, a byte count reads `512 MB` — through the **same**
    `formatValue` the form uses, with **no** per-script UI anywhere.
15. `readFindings`, `severityTone` and `JobFinding` are deleted, and a script
    declaring a `findings` array renders a real table.
16. `job.maxResultBytes` and `job.progressIntervalMs` appear in Farm Settings →
    Jobs with the right control and readout and **zero** Studio edits.
17. Each of the ten hostile fixtures is rejected as a **result** schema at all
    three publish paths with a named finding; a result schema already stored
    from before the limits still renders a clamped, usable panel.
18. MCP `tools/list` advertises `outputSchema` for every capability, and
    `ScriptDetailSchema` carries `resultSchema` so a model can read what a
    script promises before running it.
19. `docs/spec.md` §11, §12, §13 and §19 are updated in the same commit;
    `docs/ux-audit.md`'s structured-results follow-up is marked answered.
20. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test`
    are green. `bash scripts/check-plan-status.sh` and `bun run spec:check` pass.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| result vocabulary | `packages/protocol/src/schema/result.test.ts` | `summaryFields` respects declaration order and the cap of 3; `buildResultSummary` truncates at 120 chars, returns `null` with nothing marked, and never throws on a value that does not match |
| `ui()` types | `packages/protocol/src/schema/vocabulary.type-test.ts` | `summary: true` compiles; `summary: 'yes'` does not |
| SDK types | `packages/sdk/src/result.type-test.ts` | H1, both directions |
| `defineScript` | `packages/sdk/src/define-script.test.ts` | absent `result` accepted; a non-Zod `result` rejected with the `params`-shaped message |
| publish | `packages/sdk/src/cli/publish.test.ts` | `io: 'output'` on the result and `io: 'input'` on the params **in the same publish**; `z.date()` rejected (F27); the refinement warning fires for a refined result |
| record | `packages/core/src/jobs/result-store.test.ts` | every one of the five states; a child claiming `valid` over cap is overridden to `oversize`; issues truncated to 20 × 200 chars; summary built and capped |
| child boundary | `packages/session/src/runner/child-entry.test.ts` | over-cap sends the verdict and **not** the value; circular → `invalid` (H2); `__proto__` → `invalid`; the raw value is stored, not the Zod-parsed one (F25); a bundle with no `result` produces no `outcome` |
| IPC | `packages/session/src/runner/ipc.test.ts` | `outcome` optional (a pre-plan bundle parses); `progress` round-trips; an over-limit `issues` array is rejected |
| failure path | `packages/session/src/runner/job-runner.test.ts` | `finish()`'s value carried on failure and on the finish-only re-attempt; `run()` wins when both exist |
| store | `packages/core/src/queue/job-store.test.ts` | the five columns written; `rowToJobInfo` excludes `result`; `rowToJobDetail` inlines the pinned schema |
| migration | `packages/core/src/db/migrations/*.test.ts` | the backfill sets `undeclared` for finished rows only |
| API | `packages/core/src/api/jobs.test.ts` | list carries status+summary and no result; detail carries the version-pinned schema across a republish |
| `resultOf` | `packages/core/src/jobs/script-jobs.test.ts` | the three refusals unchanged; the schema overload validates child-side |
| MCP | `packages/core/src/mcp/server.test.ts` | `outputSchema` present for `job.get` and matches `toJsonSchema(cap.output)` |
| publish gate | `packages/core/src/scripts/routes.test.ts` | K7's ten fixtures rejected as result schemas with named findings |
| resolver | `packages/studio/src/components/result-view/plan-result.test.ts` | one case per R1/R2/R3; delegation to `planField` for every structural row; the hostile corpus; **no React import** |
| view | `packages/studio/src/components/result-view/ResultView.test.tsx` | each of the five statuses renders its banner; `undeclared` renders today's `<pre>`; unknown keys visible |
| settings | `packages/protocol/src/settings.test.ts` | both new fields, bounds and hints |
| progress | `packages/core/src/jobs/executor-host.test.ts` | coalescing; **zero** DB writes; over-4-KiB dropped with one warning |

### 7.2 The hostile result corpus

`packages/protocol/src/schema/hostile-results.ts` — the **value** counterpart to
K7's schema fixtures, imported by the child-boundary, resolver and view tests:

`circular`, `proto-pollution`, `50mb-array`, `deeply-nested-value`,
`unicode-bomb` (a 100 000-character string in one field), `nan-and-infinity`
(neither survives JSON, both must land as `invalid` rather than as `null`),
`extra-keys` (R3), `wrong-branch` (a union value matching no branch → `json`),
`empty-record`, `value-shaped-like-a-schema`.

### 7.3 Manual smoke

```bash
bun run dev            # core on :7700
bun run dev:studio     # Studio on :3001
cd plugins/tiktok-automation-pack && bunx enkaku publish
```

1. **Scripts → auto-scroll → Run.** While it runs, the job detail shows the
   video count climbing. It never appears in the database (check with `sqlite3`
   mid-run: `select result from jobs where id = …` is `NULL`).
2. **When it finishes**: every field reads as a value — `312`, `42 min`, `35%` —
   and the jobs list row reads `312 videos · 42 min`.
3. **Break the contract on purpose.** Publish `2.1.1` whose `run` returns
   `{ videos: 'many' }`. The job still says **success**, the panel shows the raw
   value with one line above it reading `videos: expected a number`, and
   `failureClass` is `NULL`.
4. **Return 50 MB.** Publish a script returning
   `{ junk: 'x'.repeat(50_000_000) }`. The job says success, the panel says
   `52.4 MB … save large output as an artifact`, `result` is `NULL`, and
   `ps`/Activity Monitor shows no parent-process spike.
5. **Fail with something to say.** A script whose `run` throws and whose
   `finish` returns `{ videosBeforeFailure: 280 }`: the job is **failed**, the
   error and phase are what they always were, and the result panel says *"this
   run failed — these are the values it had reached"*.
6. **Old script, unchanged.** Run `examples/open-settings.ts`, which declares no
   result. The panel is today's `<pre>`; nothing about the row changed.
7. **Read it from another job.** A second script calling
   `ctx.jobs.resultOf(id, ResultSchema)` gets a typed object; pointed at a job
   whose script declared a different shape, it throws naming the path.

### 7.4 Regression watch

- `packages/studio/src/app/jobs/detail/page.test.tsx` — the two existing
  `readFindings` tests (`:202`, `:222`) are **replaced**, not deleted: one
  asserts a declared findings array renders as a table, the other that an
  undeclared result renders raw.
- `packages/core/src/jobs/executor-host.test.ts:32` (`result: null`) and
  `jobs-runner-port.test.ts:70` must still pass with the widened settle shape.
- Plan 95's entire test suite passes after 97.1 with no substantive edit.
- `packages/core/src/api/jobs.ts:12-19`'s `E_BAD_RESPONSE` warning: every new
  `JobDetail` field is `.nullable().default(null)`, and one test asserts a
  detail response omitting all five still parses.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **97.1's rename collides with plan 95, which is still `partial`.** | 95's outstanding work is 95.10 (`core/src/scripts/routes.ts`) and 95.11 (documentation); neither touches `packages/protocol/src/params/`. 97.1 is a single mechanical commit with a verifiable result that forbids logic changes, and 97.9 coordinates 95.11's README against the new names. If the owner would rather not move the files, §9 Q1 records the cost of keeping `checkParamsSchema(resultSchema)` in the tree. |
| The conditional return type does not infer, and every author has to write a second type argument. | H1 tests it before anything depends on it, in 97.2, the second step. The fallback — an explicit `defineScript<typeof Params, typeof Result>` — is ugly but works, and is recorded rather than discovered later. |
| Authors ignore `result` and nothing improves. | Then they get exactly today's screen, which is the compatibility floor (criterion 1). The pull is 97.8 shipping the tiktok pack as the worked example, the compile-time check they get for free, and the jobs-list line they cannot get any other way. Nothing degrades for a script that never declares. |
| 64 KiB is too small for a real result and operators hit it. | It is 150× the only real result in this repository, and it is a farm setting with a 1 MiB ceiling, not a constant. The `oversize` state and `result_bytes` mean the farm can **answer** the question — "how often, and how big" is a query, not an anecdote — before anyone argues about the number. |
| The parent trusts a child's verdict. | Stated as a position, not an accident (§3.8), consistent with spec §11.3's trust model. The parent independently re-checks the two things it can: byte count and enum membership. A child that wanted to lie could return a conforming lie instead, so the check buys nothing it does not already have. |
| The published JSON Schema is weaker than the runtime check (F26). | Named in the SDK guide, warned at publish by the existing `warnAboutRefinements`, and made visible where it matters: `result_issues` carries Zod's own message, so an operator reads the real reason even when the schema does not contain it. |
| `planResult` grows a fourth, fifth, sixth rule and becomes a second resolver. | The three rules share one justification — *a form plans before the value exists; a result view plans after* — written at the top of the file. A proposed fourth rule that does not follow from that sentence is a signal the change belongs in `planField`, where both halves get it. H3 tests whether three is enough on real data. |
| `ctx.progress` becomes a de-facto streaming result because someone persists it. | It has no column and no read API, by construction, not by convention. The `UPDATE`-counting test in 97.7 fails the moment anyone writes one, which is the cheapest possible guard. |
| The plan is large and lands half-done. | 97.1–97.3 are independently shippable and are the whole of the contract; 97.4, 97.6 and 97.8 each stand alone; **97.7 (`ctx.progress`) can be dropped entirely** without touching anything else — it is the one step whose absence costs a feature rather than a guarantee. 97.5's MCP `outputSchema` is two lines and independent of everything. |
| Deleting `readFindings` removes a shipped behaviour. | It has zero consumers outside one page and no script in the repository emits the shape (F20). Its replacement is strictly better and 7.4 replaces rather than deletes its two tests. |

## 9. Open questions — owner decisions

1. **Move plan 95's `params/` module to `schema/`, or leave it?** §4.1 argues
   for moving: after this plan the limits, the validator, the clamp and the
   formatter describe *a declared schema*, and `checkParamsSchema(resultSchema)`
   would be a name that lies at every call site. The cost is one mechanical
   commit touching ~20 files one day after plan 95 shipped, and a coordination
   point with 95.11's unwritten README. 00-overview §4.3 says rename; the
   question is whether the timing makes it worth deferring to a later plan.
   **This decision also determines nothing about the `Ships:` artefact** —
   `packages/core/src/jobs/result-store.ts` is the same either way.
2. **Is `success` with `resultStatus: 'invalid'` right, or should there be a
   sixth job status?** §3.1 argues the device work happened and the job status
   must describe the device work. The alternative some farms would want is a
   distinct terminal status — `completed-unverified` — so a dashboard filter can
   catch it without reading a second column. The cost is a new member of
   `JobStatusSchema`, which every list filter, badge, metric and plan-36 retry
   branch reads. This plan chose the column. It is a real call.
3. **Should a result be able to *reference* a device, a script or an artifact?**
   §3.6 refuses `kind: 'ref'` and refuses adding `artifacts` to `PARAM_SOURCES`,
   because `source` is defined as *where the set of allowed values comes from* —
   an input concept — and giving it a second meaning is how one key becomes two
   features. But a result saying `{ reportArtifactId: 'a_123' }` is genuinely
   common and would be genuinely better as a link. Adding it means a third axis
   beside `kind` and `source`, and it should be added deliberately or not at all.
4. **Should an intermediate value ever be machine-readable by another job?**
   §3.7 says no, and builds `ctx.progress` for the human need instead. The case
   for yes is a long-running "producer" script that a "consumer" script should
   follow live rather than after — which is a streaming-pipeline feature, not a
   result feature, and would need its own read door with its own guarantees
   (F21's `not-finished` refusal exists for a reason). Naming it here so plan 99
   does not assume this plan closed the seam.
5. **`ctx.progress` at all, in this plan?** It is the one step (97.7) that can be
   dropped with no consequence to the contract. It exists because refusing to
   stream results is only honest if the need that made streaming look attractive
   is actually met (H4). If the owner would rather see the contract land alone
   first, dropping 97.7 costs nothing and the reasoning in §3.7 stands unchanged.
6. **How many `summary` fields, and should the core build the line at all?** This
   plan caps it at three fields and 120 characters, built once at settle. The
   alternative is to store nothing and let Studio build it from `result` — which
   would mean the jobs list loads two hundred results to render two hundred
   lines, the exact cost F18's design avoids. The column is the answer, but the
   *cap* is a taste call, and a farm running one script with one number will want
   one field while a farm running twenty will want three.

Items 7 and 8 below are not owner decisions — they are defects this plan's
research found in adjacent code and deliberately left alone rather than folding
into an unrelated fix. Recorded so they are not lost.

7. **The artifact store's 8 MB guard fires only for `kind === 'file'`.**
   `packages/core/src/runner/artifact-store.ts:44-46` reads
   `if (kind === 'file' && data.length > MAX_FILE_BYTES)`, so `kind: 'log'` and
   `kind: 'screenshot'` are unbounded on disk — and `job.log` is written through
   exactly that path, buffered entirely in memory by
   `packages/session/src/runner/job-logger.ts:73-79` and written once with no
   rotation. This matters to *this* plan because §3.4 names artifacts as the
   documented door for output too large to be a result: the door is the right
   one, and it currently has no lock on two of its four hinges. Widening the
   check is a one-line change with a real behavioural consequence for existing
   screenshot-heavy scripts, so it belongs to whichever plan owns artifact
   retention next, not to this one.
8. **Two built-in executors raise `invalid_job_params` without `issues`.**
   `packages/core/src/jobs/executors/install.ts:22` and
   `packages/core/src/jobs/executors/sleep.ts:15` both join their Zod messages
   into a flat string and pass no `issues` array — so they lose the field paths
   that plan 95's `EnkakuError.issues` (`packages/core/src/util/errors.ts:15-29`)
   exists to carry, and a form cannot attach their errors to fields. The script
   executor (`executors/script.ts:50-63`) does it correctly and is one file away.
   Found while tracing the enqueue path for §3.1's asymmetry argument, not while
   touching either file. Two small edits, but they belong to the plan that owns
   the built-in executors, not to the output contract.
