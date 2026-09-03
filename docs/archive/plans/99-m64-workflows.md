# Plan 99 — M64 : Workflows — a Pipeline of Scripts, on One Device, Under One Lease

> Status: partial — **99.1–99.10 and 99.12 are done and verified in software; 99.11 (the H1–H4
> hardware measurements) is the one remaining step, gathered into one consolidated table of exact
> commands with an empty outcome column, immediately above §6 Acceptance criteria.** Nothing else
> in this plan is a design question or an unbuilt mechanism. See 99.12's own status paragraph, near
> the end of this preamble, for the full documentation account, and the final paragraph before
> "Depends on:" for the closing verification run. The step-by-step account below is kept exactly as
> each step wrote it, cross-referenced rather than rewritten. 99.1, 99.2, 99.3, 99.4 implemented and tested (`packages/protocol/src/workflow.ts`,
> `workflow-params.ts`, `workflow-resolve.ts`, re-exported from `packages/protocol/src/index.ts`;
> `bun test` covers all three with 135 passing tests). **99.4 (the runner seam) is done**:
> `packages/session/src/runner/job-runner.ts` gained `JobSpec.reset`/`.nodeId`/`.retries`, the
> `job.reset === 'none'` branch in `afterReady` beside the existing finish-only branch, and the
> retry budget now reads `job.retries ?? meta.retries`; `ipc.ts`'s `init.job` gained an optional
> `nodeId`; `child-entry.ts` threads it into `createJobsApiFor`; `jobs-client.ts`'s default
> idempotency key is now `` `${job.id}:${job.nodeId ?? ''}:${job.attempt}:${idx}` ``, closing F20 —
> tested in `job-runner.test.ts`, `ipc.test.ts` and `jobs-client.test.ts` (89 passing tests across
> the four runner files), including a test that fails on the old key shape (two nodes sharing one
> `jobId`/`attempt` now derive different keys). **None of `reset`, `nodeId`, `retries` has a
> producer yet** — `packages/core/src/jobs/executors/script.ts` is the only caller of
> `runner.execute()` today and sets none of the three; they go live only once 99.7 (the workflow
> executor, §4.7) calls `runner.execute()` with them. **99.5 (the schema — `scripts.kind`,
> `job_nodes`, `artifacts.nodeId`) is done**: `packages/core/src/db/schema.ts` gained `scripts.kind`
> (`text NOT NULL DEFAULT 'script'`, `.$type<ScriptKind>()`), the `jobNodes` table (§4.6, no
> producer yet), and `artifacts.nodeId` (nullable, no producer yet), migrated by
> `bun run --cwd packages/core db:generate` into `drizzle/0044_huge_sandman.sql` with no TTY prompt
> (a pure addition, never a rename); `packages/core/src/jobs/executor.ts`'s `ExecutorRegistry` gained
> `get(scriptId, kind = 'script')` and a matching `setFallback(executor, kind = 'script')`, both
> backed by a `Map<ScriptKind, JobExecutor>` instead of one field; `packages/core/src/scripts/registry.ts`'s
> `ScriptEntry` gained `kind`, carried from the row (`kind: row.kind`, typed by the schema's own
> `.$type<ScriptKind>()` rather than an `as`-cast, so nothing in `registry.ts` compares against the
> literal `'workflow'`) — `resolve()` itself unchanged, exactly as specified. Tested in three files:
> `packages/core/src/db/scripts-kind-migration.test.ts` (new — proves the no-backfill claim against a
> row inserted via raw SQL before the column existed, plus that a fresh migration creates `job_nodes`
> and `artifacts.node_id`), `packages/core/src/jobs/executor.test.ts` (new — pins `get(id, 'script')`
> byte-identical to the old single-argument `get(id)` across every fallback/built-in combination), and
> three added cases in `packages/core/src/scripts/registry.test.ts`. Two pre-existing test files needed
> a one-line fix each because `scripts.kind` is `NOT NULL` (`bundle-cache.test.ts`'s `row()` helper,
> `jobs-runner-port.test.ts`'s `fakeRegistry`) — collateral, not logic changes; `bash scripts/typecheck.sh`
> was confirmed red before and green after. Containment held: a repo-wide search for the literal
> `kind === 'workflow'` comparison returns only `executor.ts`'s own doc comment. **99.8 (resume, and
> the node timeline API) is done — see its own paragraph further down** (one honest, unfixed gap in
> `jobs/executors/workflow.ts`, a file outside its scope, plus a protocol-schema collision with a
> concurrent session that the coordinator resolved by merging both designs). **99.9 (the editor) is
> done — see its own paragraph further down, after 99.8's.** **99.10 (the run dialog, the job page,
> and the wall) is done — see its own paragraph further down, after 99.9's** (one live-data gap in
> `packages/studio/src/app/page.tsx`, a file outside this step's scope, reported rather than worked
> around at the time — closed 2026-08-13 by a later pass, tests included; see that paragraph's own
> "Gap closed" note). Step 99.11 (the H1–H4 measurements) is **not started** — it needs real hardware and is
> the owner's own territory per this plan's own brief.
> 99.6 is done — see the paragraph below. **99.7 (the workflow executor) is done — see its own
> paragraph further down, after 99.6's.**
>
> **99.6 (static checking and the publish route) is done**, with one honest gap and one containment
> breach both flagged rather than hidden. `packages/protocol/src/workflow-check.ts` (new):
> `checkWorkflow(doc, resolved)` implements checks 1–6 and 8 of §4.3's eight exactly as specified —
> duplicate/unknown node ids; the graph-based forward-ref check that correctly treats a backward-`goto`
> target as a legitimate earlier execution rather than a positional one; `{param}` declared-ness plus
> type-compat against the target script's own `paramsSchema`; `{from,path}` resolved against a
> declared `outputSchema` when one exists, degrading to `W_WORKFLOW_UNCHECKED_BINDING` otherwise since
> no script anywhere declares one yet (§0.2 A1); nested-workflow refusal; unreachable-node detection;
> the `@latest` warning — plus two additive finding codes outside the plan's original eight
> (`E_WORKFLOW_SCRIPT_UNRESOLVED`, `E_WORKFLOW_INVALID`) so a reference-resolution failure and a
> `WorkflowDocSchema` parse failure report through the SAME `WorkflowFinding[]` shape the editor's
> Validate button and the publish gate share, rather than a differently-shaped error. **Check 7
> ("the timeout arithmetic of §3.11") is deliberately NOT implemented as an
> `E_WORKFLOW_BUDGET_IMPOSSIBLE` refusal** — a real gap against the plan's literal text, found and
> reported rather than faked: no node script's declared `timeout` is knowable anywhere short of the
> child's own `ready` message at run time (nothing in `ResolvedNodeScript`, nor any `scripts` column,
> carries it), and `checkWorkflow`'s own signature (`doc, resolved` — no settings) is never handed
> `workflow.maxTotalMs` either; `checkWorkflow`'s own doc comment states both blockers. What check 7
> CAN do without either fact — cycle detection over the reachable transition graph — is implemented as
> `W_WORKFLOW_LOOP`, a warning naming `maxSteps` as the only bound that currently applies.
> **A second, more structural finding — evidence against §3.1's design, surfaced rather than worked
> around, exactly as this step's brief asked: `checkWorkflow`'s nested-workflow check
> (`E_WORKFLOW_NESTED`) is an UNAVOIDABLE FOURTH reader of `kind === 'workflow'`, outside the three
> files §3.1 and acceptance criterion 3 name.** `checkWorkflow` is deliberately pure and database-free
> (its own doc comment: "never touches a database") specifically so the editor's Validate button and
> the publish gate "cannot disagree" — but detecting nesting requires comparing a resolved node's
> `kind` against `'workflow'` SOMEWHERE, and the plan's own §4.3 signature puts that data
> (`ResolvedNodeScript.kind: 'script' | 'workflow'`) inside this pure function, not inside the route.
> Hoisting the comparison into the route would either duplicate the check (Validate and publish could
> then disagree) or force `checkWorkflow` to accept a route-computed boolean instead of `kind` — a
> signature change purely to dodge a grep, rejected as gaming the check rather than fixing the design.
> The comparison is written plainly, with a doc comment pointing back to this note; a repo-wide
> `kind === 'workflow'` search now returns `executor.ts`'s doc comment (unchanged) plus this one real
> comparison. **§3.1 and acceptance criterion 3 (§6) were amended, 2026-08-13, to name this fourth
> file rather than leave the criterion falsified against its own original wording** — see §3.1's
> "why the fourth reader is legitimate" and §6 criterion 3's amended text; the criterion still fails
> if a fifth reader ever appears. `packages/core/src/api/workflows.ts` (new) — `POST /` (delegates the write to the
> existing `publishScript()`, extended with an optional `kind` input rather than a second writer),
> `POST /validate`, `GET /:name/versions` — resolves every node/`onFail` ref through
> `ScriptRegistry.resolve()` (collecting every resolution failure, never aborting on the first), runs
> `checkWorkflow`, then `checkParamsSchema` over `compileWorkflowParams(doc.params)`.
> `packages/core/src/scripts/routes.ts` gained `kind` on the list/group/detail projections, an optional
> `?kind=` filter (ignored rather than refused on an unrecognised value — a list query, not a publish
> gate), and a parsed `workflow` field beside `source` on `GET /:id` for a `kind: 'workflow'` row (a
> corrupt/unparseable bundle degrades to `workflow: null`, never a 500).
> `packages/core/src/scripts/service.ts`'s `PublishScriptInput`/`ScriptGroupInfo`/`ScriptDetail` and
> `packages/protocol/src/api/scripts.ts`'s `ScriptRowSchema`/`ScriptGroupRowSchema` (plus the new
> `ScriptKindSchema`) carry `kind` (and, on the detail schema only, `workflow`) end to end — this
> forced four PRE-EXISTING Studio test fixtures (`app/scripts/page.test.tsx`,
> `app/scripts/detail/page.test.tsx`, four inline fixtures in `components/ScheduleEditorDialog.test.tsx`)
> to add `kind: 'script'` to their mocked `/api/scripts*` responses, since the response schema is now
> genuinely stricter than before — collateral, not a logic change, and confirmed necessary by
> `bun run --cwd packages/studio test` going 649 pass/8 fail before the fixture fix and 657 pass/0 fail
> after. **`packages/core/src/server/http.ts`'s `workflowRoutes` is OPTIONAL** — `daemon.ts` was held
> by a concurrent worker for the whole of this step, so it was never edited here — and
> `packages/core/src/api/workflows-wiring.test.ts` (new) fails, by name, for as long as `daemon.ts` is
> missing the two-line fix (an import plus one key inside its `createApp({...})` call); the verbatim
> lines are in `docs/plans/96-m61-hotfixes.md` §96.11 and in this step's own report.
> **Closed 2026-08-13** by a later wiring pass on `daemon.ts` — see
> `docs/plans/96-m61-hotfixes.md` §96.11's own "Fixed" paragraph;
> `workflows-wiring.test.ts` now passes for the real reason.
> Tested in `packages/protocol/src/workflow-check.test.ts` (26 tests: the owner's own example produces
> zero errors, only the two expected unchecked-binding warnings plus the expected loop warning; one
> test per finding code except the two that cannot fire from `checkWorkflow` alone
> [`E_WORKFLOW_SCRIPT_UNRESOLVED`, `E_WORKFLOW_INVALID` — covered in `workflows.test.ts` instead] and
> the one that structurally never fires [`E_WORKFLOW_BUDGET_IMPOSSIBLE`, asserted absent]; the "every
> finding, not the first" rule proven with three unrelated problems in one document),
> `packages/core/src/api/workflows.test.ts` (11 tests against the real HTTP routes: the owner's
> four-node example publishes a `scripts` row indistinguishable from a hand-written one; a forward-ref
> document is refused naming both nodes; a nested-workflow document is refused; a duplicate
> `name@version` is `script_version_exists` from the existing writer; Validate writes nothing),
> `packages/core/src/scripts/kind-projection.test.ts` (10 tests, a NEW file rather than an edit to the
> already-being-concurrently-edited `scripts/routes.test.ts`, confirmed via `git status` mid-step), and
> `packages/core/src/api/workflows-wiring.test.ts` (2 tests, both failing on purpose until `daemon.ts`
> is wired). Verified 2026-08-13: `bash scripts/typecheck.sh` — every package OK. `bun test` — 3753
> pass / 2 fail (the 2 are this step's own self-detecting wiring tests, failing for the documented
> reason). `bun run --cwd packages/studio test` — 657 pass / 0 fail. `bun run --cwd packages/studio
> build`, run alone — succeeds, 28/28 static pages. `bun run spec:check` — GAP: 0 (added `docs/spec.md`
> §11.7 for workflows/`scripts.kind`/the three new routes, and a `job_nodes` bullet in §12.4 that step
> 99.5 had left undocumented — both short, terse entries in the established "added directly, date — new
> product surface" style, not the full write-up step 99.12 owns).
>
> **99.7 (the workflow executor) is done**, with one real, reported, unfixed gap in a file this
> step does not own — found and pinned rather than hidden — and two deliberate deviations from
> §4.7's literal pseudocode, both documented in the code and here.
> `packages/core/src/jobs/executors/workflow.ts` (new): `createWorkflowExecutor` — the interpreter
> (§4.7): one `sessions.acquire`/`release` pair for the whole pipeline (F11, H1's mechanism), every
> node run through the SAME `JobRunner.execute()` a standalone job uses (one call per node — the
> runner's own retry loop is untouched, called exactly once per node execution), every transition
> persisted to `job_nodes` before the cursor moves, a gate evaluated in-process with no child and no
> device call, `maxSteps` and `workflow.maxTotalMs` as two SEPARATE, distinctly-coded clocks
> (`E_WORKFLOW_STEP_BUDGET` / `E_WORKFLOW_BUDGET_EXCEEDED`, §3.11), `onFailure`/gate `then`/`else`
> branching (`continue`/`stop`/`fail`/`goto`), the `onFail` cleanup (best-effort, exactly once, never
> on a cancel), every unreached node written down `skipped` (H4), and output capping at
> `WORKFLOW_LIMITS.maxNodeOutputBytes`. `packages/core/src/daemon.ts`: `createJobNodeTracker()`
> constructed once alongside `runner`; `createWorkflowExecutor({...})` constructed right after the
> script fallback and registered via `executors.setFallback(workflowExecutor, 'workflow')`, pinned
> in `packages/core/src/daemon-wiring.test.ts` (new describe block, 4 tests, source-text assertions —
> the same pattern that file's own doc comment establishes for a file with no callable entry point).
> `packages/core/src/runner/artifact-store.ts`: `createArtifactStore` gained an optional
> `nodeId?: () => string | null` accessor, stamped into both the DB row and the returned
> `ArtifactInfo`; `createJobNodeTracker()` (new export) — a `Map`-backed `begin`/`end`/`current` per
> jobId, plus `noteAttempt`/`attempts` (fed by `JobRunnerDeps.onPhase`, which already fires the
> attempt number on every attempt of every execution — `job_nodes.attempts`'s only honest source,
> since `JobRunner.execute()`'s own return value carries none). `packages/core/src/session/adapters.ts`:
> `createDbArtifactSink` gained the matching pass-through `nodeId?` field (one line — it already
> forwards its whole `deps` object to `createArtifactStore`). `packages/protocol/src/messages/job.ts`:
> `JobNodeStatusSchema` (new, re-exported from `index.ts`); `job.status`'s payload gained the `node`
> block (§4.9: `id`/`seq`/`total`/`kind`/`script`/`status`, nullable+optional so every existing
> payload keeps parsing); `ArtifactInfoSchema` gained `nodeId` (nullable **and** `.optional()` —
> see below for why `.optional()` was load-bearing).
>
> **Two deviations from §4.7's literal interface, both because the seam the plan describes does not
> exist in a file this step does not own, and both documented in `workflow.ts`'s own module doc:**
> (1) `WorkflowExecutorDeps.artifacts: (jobId) => ArtifactSink` is not the real mechanism — `JobSpec`
> (`@enkaku/session`, out of scope) has no field a per-node sink could ride on, and `deps.artifacts`
> is a single factory built once in `daemon.ts` and shared by every job. The real seam is
> `nodeTracker: JobNodeTracker`: the SAME `artifacts` factory `daemon.ts` already hands
> `createJobRunner` reads `nodeTracker.current(jobId)` at save time, and this executor's whole job is
> to call `begin`/`end` around each node's `execute()` call. (2) `workflow.maxTotalMs` is a plain
> exported constant (`DEFAULT_WORKFLOW_MAX_TOTAL_MS`, 6h — §4.10's own default) rather than a new
> `settings.ts` block: `packages/protocol/src/settings.ts` carried a ~1,235-line in-flight diff from a
> concurrent worker at the time this step was built (device instrumentation, text input mode,
> co-control — nothing to do with workflows), and it is not a file this step owns. The seam §4.10
> asks for (`WorkflowExecutorDeps.settings: () => WorkflowSettings`, read fresh, never captured) is
> built and wired in `daemon.ts`; only the farm-setting wire itself is deferred — a one-line follow-up
> once the settings.ts churn settles. `WORKFLOW_LIMITS.maxNodeOutputBytes` needed no such deferral —
> it already existed (step 99.1) at exactly the number §4.10 names.
>
> **Also reported rather than silently unbuilt: a workflow job does not yet run on a node-owned
> (cloud) device.** Unlike the script fallback beside it, the workflow executor always calls the
> LOCAL `runner` — it does not branch on `remoteSessions?.nodeIdFor(job.deviceId)` the way
> `executors.setFallback({...})`'s script branch does. Nothing in §3–§5 asks for cloud-device
> workflow support in this step, and the remote-bridge equivalent (`jobs/executors/remote.ts` is a
> comparably sized subsystem) is a real follow-up, not attempted here.
>
> **The one real, unfixed gap — a fifth reader neither §3.1 nor acceptance criterion 3 needs to
> worry about, because it is not a `kind === 'workflow'` comparison, but a genuine wiring hole that
> makes the whole feature structurally unreachable in a live boot until it closes.**
> `packages/core/src/jobs/executor-host.ts` — held by a concurrent worker for this whole step, so
> never touched here — still calls the SINGLE-ARGUMENT `deps.registry.get(job.scriptId)` at
> `start()` (its own `kind` parameter defaults to `'script'`). §4.5's own text says "with
> `ExecutorHost` passing the kind it already read from the row" as though this were already true; it
> is not. Concretely: a `kind: 'workflow'` job reaching the REAL claim path today
> (`job-store.ts`'s `claimNext` → `ExecutorHost.start` → `ExecutorRegistry.get`) asks for the
> `'script'` fallback, never the `'workflow'` one `daemon.ts` now registers — so building the
> executor and wiring it into the registry (both done, both pinned) is NOT yet enough to make a
> workflow job actually run through a real boot. The verbatim two-line fix, and the one-line
> `daemon.ts` follow-up once it lands, are written out in full in
> `packages/core/src/jobs/executor-kind-dispatch.test.ts`'s own module doc comment (new file) —
> the fix is NOT applied here because `executor-host.ts` is outside this step's file list. That test
> is genuinely self-detecting in the direction this repo's convention asks for (fails while the fix
> is missing, would start passing the moment it lands with no edit to the test itself): it constructs
> a REAL `ExecutorHost` with an inert extra `scriptKind` accessor matching the prescribed fix's exact
> shape, currently ignored by `executor-host.ts` and therefore currently red.
>
> **The plan's own central verifiable result, proved against the REAL claim path, not a fake one**
> (`packages/core/src/jobs/executors/workflow-real-claim.integration.test.ts`, new): a three-node
> workflow, enqueued once and claimed once through the real `job-store.ts` `BEGIN IMMEDIATE` SQL,
> run through a real `ExecutorHost`/`LeaseManager`/`DeviceStateMachine` (the workflow's own scriptId
> registered via `ExecutorRegistry.register()` — the same door `internal:sleep` already uses —
> because the kind-dispatch gap above makes `.setFallback(..., 'workflow')` unreachable through
> `ExecutorHost` today; `daemon.ts`'s PRODUCTION wiring, which is the real fallback registration, is
> pinned separately in `daemon-wiring.test.ts`) and a real `JobRunner` spawning three real child
> processes from three real published bundles. While the pipeline's deliberately-slow middle node is
> still running: the device row reads `busy` (the exact column `GET /api/devices` serves), the real
> `LeaseManager.getLease('d1')` reports the workflow's own `jobId` unchanged, a SECOND job enqueued on
> the same device is refused by a REAL `claimNext()` call (returns `null`, the row stays `queued`),
> and exactly one real session BUILD has happened (a refcounting fake session manager distinguishes a
> real 0→1 build from the three per-node refcount bumps `JobRunner`'s own inner acquire/release
> already does — 4 total acquire calls, 1 build). After settle: exactly one `jobs` row, three
> `job_nodes` rows in order with real, distinguishable per-node outputs (node 3 reads node 2's output
> through a binding, proving data actually flowed along the edge), the device back to `idle`, the
> lease gone, and the previously-refused second job now claimable. `packages/core/src/jobs/executors/workflow.test.ts`
> (new, 19 tests, fast — a fake `JobRunner`/`SessionManager`, real DB/`ScriptRegistry`) covers the
> interpreter's own contract in isolation: linear run, both gate branches with the resolved
> values in the row, a backward `goto` bounded by `maxSteps` (naming the node and the per-node
> execution counts), `onFailure: 'continue'` letting the pipeline survive a failed node,
> `E_WORKFLOW_BUDGET_EXCEEDED` naming the node in flight, a cancel mid-node mapping to
> `job_cancelled` and skipping `onFail`, `E_WORKFLOW_BINDING_UNRESOLVED` naming the node/path/what
> was actually there, an optional binding's default, the `reset: 'farm'`-then-`'none'` default
> sequence, a `retries` override, output truncation over `WORKFLOW_LIMITS.maxNodeOutputBytes`, and
> the executor's own `validateParams`.
>
> Verified 2026-08-13: `bash scripts/typecheck.sh` — every package OK. `bun test` — 3801 pass / 2
> fail (one is this step's own self-detecting `executor-kind-dispatch.test.ts`, failing for the
> documented reason above; the other, `daemon-wiring.test.ts`'s `onAssist` block, is plan 91's own
> pre-existing self-detecting gap in a different concurrent file, present before this step touched
> anything and not this step's to close). `bun run --cwd packages/studio test` — 699 pass / 0 fail.
> `bun run --cwd packages/studio build`, run alone — succeeds, 28/28 static pages. `bun run
> spec:check` — GAP: 1, `GET /:id/assists` (plan 91's route, unrelated to workflows, warning-only).
> `bash scripts/check-plan-status.sh` — passes.
>
> **99.8 (resume, and the node timeline API) is done**, with one honest,
> unfixed gap in a file this step does not own — found and pinned rather
> than hidden, exactly like 99.6's and 99.7's own gaps above.
> `packages/core/src/api/jobs.ts`: `GET /:id/nodes` (`job.view`) and
> `POST /:id/resume` (`job.run` + the same `canCancelJob`-style
> device-ownership check `/:id/cancel` already uses). `packages/core/src/services/job-service.ts`
> gained `nodes(jobId)` (throws `job_not_found`, the `assists()` convention)
> and `resume(jobId, { fromNode? })`: `fromNode` omitted defaults to
> `defaultResumeNode` — the LAST node the job actually attempted (in seq
> order, `'skipped'`/`'skipped-on-resume'` rows filtered out first, so a
> `goto` loop that later succeeds is not mistaken for a standing failure),
> refusing `job_node_not_found` (400) only when that node already succeeded
> or none was ever attempted; naming a node explicitly always wins over the
> default. `job_not_terminal` (409) gates every resume on the SAME terminal
> check `nodes()`'s own `finalized` flag reports. `packages/core/src/queue/job-store.ts`
> gained `nodes(jobId)` (all `job_nodes` rows, seq order — **no delete path
> exists anywhere in this store for this table, on purpose**, which is the
> literal content of the boot-sweep checklist item), `recordResume`/`resumeInfo`
> (backed by a NEW side table, `job_resumes` — migration `0047_dear_quasar.sql`,
> generated, never hand-written), and `rowToJobNodeInfo`. `job_resumes` is a
> SIDE TABLE rather than two more columns on `jobs` deliberately: `JobRow`
> (`jobs.$inferSelect`) is built as a hand-written literal fixture in several
> files this step does not own (`jobs/executors/**`, `executor-host.test.ts`),
> and two more required keys there would have forced an edit to every one of
> them for no logic reason — a cost this step has no file-list permission to
> spend. For the SAME reason, `nodes`/`recordResume`/`resumeInfo` are declared
> OPTIONAL on the exported `JobStore` interface (so the many hand-written
> partial `JobStore` fakes across the tree keep compiling unchanged — `job-service.ts`
> treats an absent implementation as "no nodes", never as an error) while
> `createJobStore`'s own return type is narrowed back to a `ConcreteJobStore`
> (`JobStore & Required<Pick<..., 'nodes' | 'recordResume' | 'resumeInfo'>>`)
> so the real store's own tests call them directly, with no `?.`/`!` — a
> `?.()` there would have silently passed even if a future edit dropped the
> method, the opposite of what a test is for.
>
> **A genuine, live collision with a second, concurrent session — found,
> reported, and resolved by the coordinator, not decided unilaterally.**
> While this step was mid-build, `packages/protocol/src/messages/job.ts` and
> `index.ts` (files this step was granted access to only for this step, not
> owned outright) gained a SECOND, differently-shaped implementation of the
> same `GET /:id/nodes`/`POST /:id/resume` wire surface (`JobNodeSchema`,
> `JobNodesResponseSchema` shaped `{ jobId, nodes, finalized }`,
> `JobResumeRequestSchema`, `JobResumeResponseSchema`) from another session
> also working step 99.8. Per this step's own brief ("stop and report" on a
> file conflict), this was reported rather than silently merged around or
> overwritten. The coordinator's resolution, applied here: placement in
> `packages/protocol/src/api/jobs.ts` (HTTP request/response shapes belong in
> `api/`, matching all 27 other files there — the other session's placement
> in `messages/` was wrong by the repo's own structure regardless of
> quality); the envelope `{ items, finalized }` (matching `JobAssistsResponseSchema`'s
> sibling shape two lines above it, plus the other session's `finalized`
> flag, dropping its redundant `jobId` — the caller already has it, from the
> URL); the NODE ROW's richer structure adopted from the other session
> wholesale (`duration { startedAt, finishedAt, elapsedMs }`, `attempts
> { current, total, lastError }`, `output { value, truncated, error, verdict }`
> — `output.truncated` matters concretely, since 99.7 caps a node's output
> and a flat shape could not distinguish a capped value from a complete one);
> `JobNodeStatusSchema` reused unchanged from `messages/job.ts` (not
> redeclared — 99.7 built it for exactly this reuse); the RESUME RESPONSE
> kept as this step's own `JobCreateResponseSchema = { job: JobInfo }`
> (reuse over re-declaration, this plan's own rule since 99.1, and Studio
> already knows how to render a `JobInfo` — the other session's bespoke
> `{ newJobId, resumedFromJobId, resumedFromNode, status }` would have forced
> a second fetch to render anything); `fromNode` made OPTIONAL per the other
> session's instinct (the common case is "resume from wherever it stopped"),
> but with the exact rule specified and tested here (`defaultResumeNode`,
> above) rather than left as "roughly the first failure". **The other
> session's block in `messages/job.ts`/`index.ts`/`messages/job.test.ts` was
> deliberately NOT touched, deleted, or "tidied" here** — it is live,
> uncommitted work belonging to a session this step does not control, and
> the coordinator is resolving which session's block stays. Concretely, this
> means `packages/protocol/src/api/jobs.ts`'s `JobNodesResponseSchema` and
> `JobNodeErrorSchema` are, as of this report, SHADOWED at the `@enkaku/protocol`
> package boundary: `index.ts`'s explicit `export { JobNodesResponseSchema, ... } from './messages/job'`
> wins over this file's own `export * from './api'`, so `packages/core/src/api/jobs.ts`'s
> own `import { JobNodesResponseSchema } from '@enkaku/protocol'` resolves to
> the OTHER session's `{ jobId, nodes, finalized }` shape, not this step's
> `{ items, finalized }` one — the one confirmed, expected, and reported
> `bash scripts/typecheck.sh` failure below. This is intentionally left
> visible rather than worked around (no schema renamed to dodge the clash);
> resolving it is the coordinator's call, not this step's.
>
> **The gap this step cannot close, in a file it does not own.**
> `packages/core/src/jobs/executors/workflow.ts` never reads `job_resumes` —
> every workflow job, resumed or not, starts its interpreter at
> `doc.nodes[0]` with an empty `outputs` map, so "replays completed outputs
> into the scope" and "writes `resumedFromJobId`/`resumedFromNode` on seq 0"
> (this step's own checklist, §5) are NOT true yet. No change to
> `WorkflowExecutorDeps`'s signature is needed to fix it — `deps.db` already
> exists, and `jobResumes`/`jobNodes` are both already exported from
> `../../db/schema`, that file's own relative import path. The fix (verbatim,
> repeated in `jobs-workflow-resume.integration.test.ts`'s own doc comment):
> at the top of `run()`, after `doc` is parsed, query `job_resumes` for
> `job.id`; if a row exists, start `cursor` at its `resumedFromNode` instead
> of `doc.nodes[0].id`, and seed `outputs` from `resumedFromJobId`'s own
> `job_nodes` rows with `status: 'success'` (later `seq` overwrites earlier,
> the same rule `ResolveScope.outputs` already documents), writing
> `'skipped-on-resume'` rows for every node before the resume point with
> `resumedFromJobId`/`resumedFromNode` on the first one. Proved WITHOUT
> editing that file: `jobs-workflow-resume.integration.test.ts`'s last test
> runs the REAL, untouched `createWorkflowExecutor` against the REAL
> resumed job `POST /:id/resume` (a real HTTP call, in the same test) just
> created, and asserts the desired behaviour — only the un-succeeded node
> re-executes. It fails today (`['a','b','c']` runs, not `['c']`) and will
> pass with no edit to the test the day the fix above lands.
>
> **Closed 2026-08-13, by a follow-up session scoped to exactly this gap and
> this one file.** `run()` now reads `job_resumes` for `job.id` right after
> `doc` is parsed: `cursor` defaults to `resumeInfo.resumedFromNode` instead
> of `doc.nodes[0].id` (a runtime `E_WORKFLOW_INVALID` guard replaces the old
> `as WorkflowNode` cast on that same already-Zod-validated `.min(1)`
> invariant, rather than adding a second cast); `outputs` is seeded from
> `resumedFromJobId`'s own `'success'` `job_nodes` rows, later `seq`
> overwriting earlier, exactly as specified. Every node before the resume
> point in doc order gets a `'skipped-on-resume'` row (carrying over the
> original row's `scriptId`/`scriptName`/`scriptVersion`/`output`/
> `outputTruncated` when one succeeded there), with `resumedFromJobId`/
> `resumedFromNode` set on the FIRST `job_nodes` row this run writes — that
> skip row when there is one, otherwise the resumed node's own row when the
> resume point IS `doc.nodes[0]` (nothing to skip). A new `seqOffset`,
> deliberately kept separate from the interpreter's own `step` (which still
> starts at 0, so `reset: 'farm'` still fires on a resumed job's first real
> execution — nobody can vouch for the device's state in between, §3.5),
> keeps `job_nodes.seq` one continuous sequence instead of restarting at 0;
> the pre-existing 'skipped'-for-unreached-nodes bulk-write in `finally` now
> also excludes nodes already written as `'skipped-on-resume'`, so no node
> ever gets two rows. `jobs-workflow-resume.integration.test.ts`'s
> self-detecting case above now passes with NO edit to the test, exactly as
> designed; all 19 pre-existing cases in `workflow.test.ts` and every case in
> `workflow-real-claim.integration.test.ts` are unaffected. `bash
> scripts/typecheck.sh` still fails at the same pre-existing
> `api/jobs.ts(204,49)` line for the same reason (the unresolved
> `JobNodesResponseSchema` collision from the concurrent session, still the
> coordinator's call) — nothing else about it changed. `bun test`: 3880 pass
> / 0 fail (up from 3879/1 — this was the one).
>
> Tested in `packages/core/src/api/jobs-workflow-resume.integration.test.ts`
> (new, 6 tests — a real 3-node workflow run through the REAL workflow
> executor against a real DB, both routes hit through a REAL `Hono` app built
> from `createJobRoutes`/`createJobService`/`createJobStore`, never a
> hand-shaped `JobNodeInfo`/`JobRow` fixture: `GET /:id/nodes` reads back the
> real timeline including real bound output and a real structured error;
> `POST /:id/resume` with `fromNode` omitted defaults correctly, an explicit
> `fromNode` overrides it, an unknown node is 400, a non-terminal job is 409;
> the sixth is the SELF-DETECTING GAP above, the only intentional failure),
> `packages/core/src/queue/job-store.test.ts` (+9 tests: `nodes()` ordering
> and the empty case, `recordResume`/`resumeInfo` round-trip, and the
> boot-sweep test the checklist asks for — seeds a `running` workflow job
> with `job_nodes` rows, calls the EXISTING `failOrphanRunning()`, and
> asserts the rows are byte-identical afterward, written so it fails BY NAME
> the day a cascade delete is ever added), `packages/core/src/services/job-service.test.ts`
> (+14 tests: `nodes()`'s delegation and `finalized`; `resume()`'s terminal
> gate, node-ran gate for both an explicit and a defaulted `fromNode`, and —
> the one property that matters most — that the exact resolved `scriptId` is
> copied with no resolver ever consulted), `packages/core/src/api/jobs.test.ts`
> (+14 tests: permission gates, the device-ownership check, body validation,
> and every `ERROR_STATUS` mapping, against a fake `JobService`). Nine
> PRE-EXISTING test files outside this step's normal territory needed a
> trivial, zero-logic one-liner each to keep satisfying the now-larger
> `JobService`/`JobStore` interfaces (`nodes`/`resume` on the former, both
> required; the latter's three methods optional, as above) —
> `packages/core/src/server/{presence,ws-handlers-clipboard,ws-handlers-inspect,ws-handlers-job,ws-handlers-monitor,ws-handlers-shell,ws-handlers-text,ws-handlers.assist}.test.ts`
> (the last one four times) — collateral, not logic changes, the same
> category 99.5's status paragraph already established for `bundle-cache.test.ts`.
> `packages/core/src/jobs/executor-host.test.ts` and
> `packages/core/src/jobs/executor-kind-dispatch.test.ts` (the latter
> EXPLICITLY named in this step's brief as a to-do list to leave alone) were
> deliberately NOT touched for the same interface-widening reason — this is
> exactly why `JobStore`'s three new methods are optional rather than
> required: making them required would have forced an edit to both, and
> `executor-kind-dispatch.test.ts` in particular was off limits outright.
> Both now typecheck and pass regardless, because the OPTIONAL design costs
> them nothing.
>
> Verified 2026-08-13: `bash scripts/typecheck.sh` — every package OK
> EXCEPT core, which fails with EXACTLY one error, the reported and expected
> protocol collision above: `packages/core/src/api/jobs.ts(204,49): error
> TS2739: Type '{ items: ...; finalized: boolean }' is missing the following
> properties from type '{ jobId: string; nodes: ...; finalized: b...':
> jobId, nodes`. `bun test` — 3879 pass / 1 fail (the 1 is this step's own
> self-detecting gap test, above, failing for the documented reason; both of
> the two previously-open deliberately-red guard tests named in this step's
> brief — `daemon-wiring.test.ts`'s `onAssist` block and
> `executor-kind-dispatch.test.ts`'s `scriptKind` dispatch — are now GREEN,
> fixed by other concurrent workers during this step and not touched here;
> **zero deliberately-red guard tests from the brief remain**). `bun run
> --cwd packages/studio test` — 733 pass / 0 fail, confirmed on two
> consecutive runs. (One intermediate run this step took along the way read
> 727 pass / 6 fail, all six in `AdbServerCard.test.tsx` — `git status` shows
> `AdbServerCard.tsx`/`.test.tsx` themselves as `??` untracked, plan 88's
> in-flight adb-server-control UI work, nothing this step's diff reaches;
> re-running twice more came back 733/0 both times, confirming CLAUDE.md's
> own "concurrent workers cause occasional transient failures — re-run"
> warning rather than a real regression. Recorded here rather than silently
> dropped, since the brief asks for exactly this kind of anomaly to be
> accounted for, not just re-run until green and forgotten.) `bun run --cwd
> packages/studio build`, run alone — succeeds, 28/28 static pages. `bun run
> spec:check` — GAP: 0 (`docs/spec.md` §12.4 gained three bullets: `job_nodes`
> extended with `GET /:id/nodes`'s exact response shape, a new `job_resumes`
> bullet for `POST /:id/resume`, and a new Assist/co-control bullet closing
> plan 91's own pre-existing `GET /:id/assists` gap — undocumented until
> now). `bash scripts/check-plan-status.sh` — passes.
>
> **The two items step 99.6 and step 99.7 each deliberately left open are
> now closed** — both were blocked on things that no longer apply: check 7
> needed a node script's declared `timeout` readable at publish time, which
> plan 98 step 98.4 supplied (`scripts.runtime`); `workflow.maxTotalMs`
> needed `settings.ts` free of a ~1,235-line concurrent diff, which it now
> is.
>
> **Item 1 — `E_WORKFLOW_BUDGET_IMPOSSIBLE` (§4.3 check 7) is implemented.**
> `ResolvedNodeScript` (`packages/protocol/src/workflow-check.ts`) gains
> `timeoutMs: number | null`, populated by the ONE caller that resolves
> script refs, `packages/core/src/api/workflows.ts`'s `resolveDocRefs`, via
> `entry.runtime?.timeoutMs ?? null` (`ScriptEntry.runtime`, plan 98 step
> 98.4's own producer). **The explicit decision the brief asked for**: an
> undeclared timeout is UNKNOWN, not zero, and not silently treated as the
> farm's `job.defaultTimeoutMs` either — it makes the sum for that document
> uncheckable, reported once as a NEW finding code, `W_WORKFLOW_BUDGET_UNKNOWN`
> (added to `WorkflowFindingCode`, additive, matching the file's own
> precedent for `E_WORKFLOW_SCRIPT_UNRESOLVED`/`E_WORKFLOW_INVALID`), naming
> every node responsible. Reasoning, recorded in the code's own doc comments:
> (a) treating unknown as the farm default would make the check answer a
> question about `job.defaultTimeoutMs` at PUBLISH time when that setting
> could change by RUN time — two sources of truth for one number, the exact
> plan-92 trap named elsewhere in this codebase; (b) most scripts today
> declare no `runtime.timeoutMs` at all (it is optional metadata), so a
> "skip silently" design would make check 7 fire almost never — a warning
> that NAMES the reason is more honest and more useful than either silently
> passing or silently defaulting. `checkWorkflow`'s signature gained one
> optional third argument, `budget?: WorkflowBudget | null`
> (`{ maxTotalMs: number }`, also exported) — omitted, check 7 is skipped
> entirely, keeping the function's own "never touches a database, caller
> resolves and passes in" contract intact (the brief's own instruction).
> **The arithmetic itself, per §3.11's literal text**: over an ACYCLIC
> reachable graph (no `goto` loop), the worst case is deterministic — the
> longest node-timeout-weighted path from node 0 to a terminal outcome
> (`longestPathMs`, walking the SAME transition graph checks 2/6 already
> build, so both a node's success continuation AND its `onFailure` branch
> are explored, plus a gate's `then`/`else`; a gate itself costs nothing —
> evaluated in-process, §3.7); `onFail`'s own timeout, when declared, adds
> once. Exceeding `budget.maxTotalMs` is `E_WORKFLOW_BUDGET_IMPOSSIBLE`
> (error), naming the exact sum and the budget in the message. **A CYCLIC
> graph never gets the hard refusal** — per §3.11's own words ("a workflow
> that MIGHT not finish ... gets a warning, not a refusal"), a loop's total
> is bounded only by `maxSteps` and a gate might exit early, so promoting it
> to a certainty would be asserting something the design does not claim;
> the pre-existing `W_WORKFLOW_LOOP` warning already covers this case
> unchanged (its message now says explicitly that the budget check does not
> apply to it, so a reader is not left wondering why). Tested in
> `packages/protocol/src/workflow-check.test.ts` (+7 tests, 33 total in the
> file): budget omitted skips check 7 entirely; a deterministic sum over
> budget refuses, naming the arithmetic; a sum within budget is silent; an
> undeclared node timeout degrades to `W_WORKFLOW_BUDGET_UNKNOWN` naming the
> node, even under a budget a KNOWN sum would obviously have blown (proving
> this is not "unknown quietly treated as fitting"); a gate costs nothing; a
> cyclic document never promotes to the error however large the worst case;
> `onFail`'s own timeout is counted; and a regression guard against the
> owner's own fixture (cyclic, so still warning-only with real timeouts
> attached). `packages/core/src/api/workflows.ts` threads `entry.runtime?.timeoutMs`
> into `ResolvedNodeScript` and gained an optional `deps.settings` plus a
> `budgetFor()` helper passed into both `checkWorkflow` call sites
> (`/validate` and `POST /`) — covered by the pre-existing
> `packages/core/src/api/workflows.test.ts` (11 tests, unchanged, still
> green — the owner's four-node example produces no new findings).
>
> **Item 2 — `workflow.maxTotalMs` is now a real, Studio-editable farm
> setting**, per §3.11's "three clocks" model (node timeout —
> `job.maxTimeoutMs`, unchanged; workflow budget — this new field; step
> budget — `maxSteps`, on the document, unchanged). `packages/protocol/src/settings.ts`
> gains a top-level `workflow` group (one field today, `maxTotalMs`,
> `kind: 'duration'`, default `21_600_000` — 6h, byte-identical to the
> `DEFAULT_WORKFLOW_MAX_TOTAL_MS` constant step 99.7 shipped, so a farm that
> has never touched the setting sees no behaviour change), plus
> `WorkflowJobSettings = FarmSettings['workflow']`, both re-exported from
> `index.ts`. Registered in `packages/studio/src/components/settings/farmSections.ts`
> by adding `'workflow'` to the EXISTING `job` tab's `keys` (`['job',
> 'workflow']`) rather than a tab of its own — one field, answering a
> variant of the exact question its neighbour `job.maxTimeoutMs` already
> answers on that same tab. `farmSections.test.ts`'s existing exact-coverage
> assertion (every `FarmSettingsSchema` top-level key claimed by exactly one
> section) is what proves this is not a dead knob — it passed with no
> changes to the test itself, exactly as designed. **The one honest,
> reported gap**: `daemon.ts` is outside this step's file list (a
> concurrent worker holds it — evidenced by a 663-line in-flight diff
> present at the time of writing) and its existing `createWorkflowExecutor({...})`
> call still passes the literal `settings: () => ({ maxTotalMs:
> DEFAULT_WORKFLOW_MAX_TOTAL_MS })` closure step 99.7 wired in, not
> `settingsStore.get().workflow` — so an operator who customises the
> setting from Studio today sees the PUBLISH-time check (`api/workflows.ts`'s
> `budgetFor`, which reads `deps.settings` when `daemon.ts` passes one, and
> falls back to the schema default otherwise — see that function's own doc
> comment) honour their number, while the RUNTIME clock
> (`E_WORKFLOW_BUDGET_EXCEEDED`) keeps enforcing the old default until that
> one line changes. Made self-detecting rather than left silent:
> `packages/core/src/jobs/executors/workflow-settings-wiring.test.ts` (new)
> reads `daemon.ts`'s own source text (matching `daemon-wiring.test.ts`'s
> established pattern for a wiring fact with no testable entry point) and
> fails, by name, until that one line is swapped — the verbatim fix is in
> the test's own module doc and in `jobs/executors/workflow.ts`'s own
> updated doc comment.
>
> **Containment re-verified, not just assumed**: a repo-wide search for the
> literal `kind === 'workflow'` after this work still returns exactly the
> same two files as before — `packages/core/src/scripts/routes.ts` (the
> publish/detail-projection route, ×2) and `packages/protocol/src/workflow-check.ts`
> (the nested-workflow check, ×2, unchanged by this step). This step added
> no comparison of its own; the fourth reader named in §3.1's amendment is
> unchanged and no fifth exists.
>
> Verified 2026-08-13: `bash scripts/typecheck.sh` — every package OK
> EXCEPT core, at the SAME pre-existing single line as every prior status
> paragraph in this file, `packages/core/src/api/jobs.ts(204,49)` (a
> duplicate schema from a second, out-of-workspace Claude session, the
> repo owner's to arbitrate — untouched by this step, still present). `bun
> test` — 3954 pass / 1 fail (the 1 is this step's own self-detecting
> `workflow-settings-wiring.test.ts`, failing for the documented reason
> above; no other prior self-detecting gap regressed). `bun run --cwd
> packages/studio test` — 750 pass / 0 fail. `bun run --cwd packages/studio
> build`, run alone — succeeds. `bun run spec:check` — GAP: 0 (no new
> table/screen/route; `docs/spec.md` §11.7 already covers workflows at the
> level of detail the mechanical checker looks for, and neither a farm
> setting nor a finding code is a category it tracks). `bash
> scripts/check-plan-status.sh` — passes.
>
> **99.9 (the editor) is done.** `packages/studio/src/app/workflows/page.tsx`
> (the list — `GET /api/scripts?group=name&kind=workflow`, the same grouped
> shape the Scripts list already renders, plus a per-row node count — one
> lazy `GET /api/scripts/:id` fetch per row, not a new endpoint — and a
> "last run" column from a single bounded scan of `/api/jobs`, matched by
> `scriptName` so a run of an OLDER version still counts, not just the
> latest); `packages/studio/src/app/workflows/editor/page.tsx` (`?name=…`,
> never a dynamic route segment — the same reason the device page is
> `/device?id=...`; a "start from version" `Select` reusing
> `GET /api/workflows/:name/versions`, seeded to the newest version with its
> patch bumped by one as the suggested next version, never applied
> silently); and twelve new files under `packages/studio/src/components/workflow/`:
> `model.ts` (the draft type, node-list editing, and `toWorkflowDoc`/
> `zodIssuesToFindings` — the draft is never asked to prove itself valid by
> anything other than the REAL `WorkflowDocSchema`), `promote.ts` (pure:
> `inferWorkflowParamType`/`promoteNodeParam`), `edges.ts` (pure: the branch
> rail's own edge labels), `ValueExprEditor.tsx` (the bindings sub-form — a
> flat, closed 4-member union drawn with `Select`/`Input`, never JSON),
> `PredicateEditor.tsx`, `GateOutcomeEditor.tsx`, `ScriptPicker.tsx`,
> `ParamsEditor.tsx`, `BranchRail.tsx`, `scriptBindings.ts`, and
> `NodeCard.tsx`/`WorkflowBuilder.tsx` (the node list plus doc-level fields,
> Validate, and Publish). `packages/studio/src/lib/api.ts` gained
> `validateWorkflow`/`publishWorkflow`/`fetchWorkflowVersions` (additive
> only, per this step's file grant).
>
> **The one bespoke control is `PredicateEditor.tsx`, and only it** — its own
> module doc comment states why: a `Predicate` is a self-recursive union
> (`{left,op,right?} | {all} | {any} | {not}`) with no JSON-Schema
> representation at all, so `schema-form/plan.ts`'s resolver has nothing to
> plan it from, and even a hypothetical compilation would land on row 15's
> raw-JSON fallback the moment a real branch appeared — the exact outcome
> this step's brief names as disqualifying. Its own leaves still reuse
> `ValueExprEditor`; only the recursion and the combinator switch are
> hand-built. Everything else — the bindings sub-form, the script+version
> picker, the parameter editor, the branch rail — is ordinary product UI over
> `Select`/`Input`/`Switch`, the same category as `DevicePicker` or
> `ScheduleEditorDialog`, not a second entry in the schema-form control
> system. No second bespoke control was needed.
>
> **The verifiable result, proven literally, not approximately**:
> `WorkflowBuilder.test.tsx` drives the real `WorkflowBuilder` (real
> `ScriptPicker`, `ValueExprEditor`, `PredicateEditor`, `ParamsEditor`,
> Promote) through testing-library to build Scroll FYP → Search → Scroll FYP
> → Report with a gate before Report, asserts the exact `WorkflowDoc` JSON
> the UI produced (never hand-typed) parses through the REAL
> `WorkflowDocSchema`, and — this is the part worth being explicit about
> rather than gliding past — feeds that document to the REAL `checkWorkflow`
> (not a canned mock) inside the test's own `/api/workflows/validate` stub,
> the same function `packages/core/src/api/workflows.ts` calls in
> production. The result is exactly two `W_WORKFLOW_LATEST_REF` warnings and
> nothing else, matching the brief's literal words. **This required one
> deliberate, disclosed choice**, because it is impossible to satisfy
> literally against §0's own owner example otherwise: that example's gate
> loops back to `scroll1` on `else` (a `W_WORKFLOW_LOOP` warning, per
> `workflow-check.test.ts`'s own `ownerExampleDoc`) and reads an earlier
> node's OUTPUT (a `W_WORKFLOW_UNCHECKED_BINDING` warning, since no script
> anywhere declares one — plan 97/A1 has not landed) — together that is
> three warnings from ANY document built against today's real farm, not two,
> regardless of how it is built or by whom. The document this test builds is
> therefore linear (the gate's `then`/`else` are `continue`/`stop`, never a
> `goto`) and binds only to `{param}`/`{run: summary}`, never `{from}` — the
> report node reads the WHOLE run summary rather than one earlier node's
> field, and the gate evaluates the promoted `keyword` workflow parameter
> (`notEmpty`) rather than `search1`'s own output. This still exercises every
> piece the brief asks for (Promote, the bindings sub-form's four kinds
> including `{run: summary}`, the predicate editor, a pinned vs. an
> unpinned/`@latest` script version) — it is a genuine, no-JSON-typed build
> of the owner's pipeline, just not the exact byte-identical predicate
> `workflow-check.test.ts` uses one plan level down. Flagged here rather than
> silently chosen, per this step's own brief ("report anything that
> contradicts this brief"). Two more assertions close the loop: not one
> `<textarea>` in the whole editor holds anything but prose (asserted by
> value, not by absence — the workflow/parameter descriptions are legitimate
> free text), and a follow-up `POST /api/workflows` in the same test
> succeeds and is what `onPublished` receives.
>
> **Step 99.2's deferred half is closed, and it holds.**
> `workflow-params-form.test.tsx` compiles a six-parameter set (string,
> integer+`count`, number+`chance`, boolean, `stringList`, `numberPair`)
> through the REAL `compileWorkflowParams`, plans it through the REAL
> `planForm`, and asserts every field's `FieldPlan.control` is never `'json'`
> — then renders a REAL `SchemaForm` (a controlled wrapper, matching
> `RunScriptDialog.tsx`'s own usage, since an uncontrolled one would never
> observe `applyDefaults`' own seeded value) and confirms `videos` reads
> `"30"`, the `chance` slider's `aria-valuenow` reads `"50"`, and the
> `enabled` switch's `aria-checked` reads `"true"` — all three BEFORE any
> interaction. Nothing fell back to the raw-JSON control. Said plainly, as
> asked: **it holds.**
>
> **A live protocol-schema change landed mid-step, from a concurrent session
> closing steps 99.6/99.7's own previously-open budget-arithmetic gaps (the
> "Item 1"/"Item 2" paragraph immediately above this one)**:
> `ResolvedNodeScript` (`workflow-check.ts`) gained a
> required `timeoutMs: number | null`, and `checkWorkflow` gained an
> optional third `budget?` argument. Discovered by re-reading this file's own
> status block before writing this paragraph (not by a typecheck failure —
> `packages/studio/tsconfig.json` excludes `*.test.tsx` from
> `bash scripts/typecheck.sh`'s coverage, so a stale test fixture would not
> have been caught mechanically). `WorkflowBuilder.test.tsx`'s own
> `resolveRefs` stand-in was updated to pass `timeoutMs: null` (the file's
> own sanctioned reading for a caller not wiring plan 98's
> `runtime.timeoutMs` through) — inert here regardless, since no `budget` is
> passed to `checkWorkflow` and check 7 is skipped entirely either way. Every
> test in `packages/studio/src/components/workflow/` and
> `packages/studio/src/app/workflows/` was re-run after this landed and
> stayed green.
>
> **Two things this step did NOT do, both deliberate and both outside its
> file grant.** `AppShell.tsx`'s sidebar `NAV` array gains no "Workflows"
> entry — that file is not in this step's file list (`packages/studio/src/components/layout/**`
> is not `packages/studio/src/components/workflow/**`), and is not needed for
> the verifiable result (a direct link, e.g. from the Scripts list, or typing
> the URL, still reaches `/workflows`); a follow-up one-line addition for
> whoever next holds that file. **Nothing here touches a physical device** —
> this step is Studio-only UI over a mocked core; running a built workflow
> against real hardware is 99.10/99.11's own territory (the run dialog, the
> job page, and H1–H4), pending — owner to run, once those steps exist.
>
> Tested in nine new files, 47 new tests (`model.test.ts`, `promote.test.ts`,
> `edges.test.ts`, `PredicateEditor.test.tsx`, `ParamsEditor.test.tsx`,
> `WorkflowBuilder.test.tsx`, `workflow-params-form.test.tsx`,
> `app/workflows/page.test.tsx`, `app/workflows/editor/page.test.tsx`).
> Verified 2026-08-13: `bash scripts/typecheck.sh` — every package OK EXCEPT
> core, at the SAME pre-existing single line every prior status paragraph in
> this file reports, `packages/core/src/api/jobs.ts(204,49)` — untouched by
> this step, still present, still the coordinator's to arbitrate. `bun test`
> (root) — 3954 pass / 1 fail (the 1 is `workflow-settings-wiring.test.ts`,
> the concurrent session's own self-detecting gap for steps 99.6/99.7's
> budget-arithmetic closure documented above ("Item 2") — not this step's,
> not touched by this step). `bun run --cwd packages/studio test` — 804 pass / 0
> fail (up from the 750 the paragraph above this one reports; this step's own
> nine new files add 47 tests — see "Tested in" above — the remaining
> difference is other concurrent Studio work landing in the same window,
> outside this step's diff). `bun run --cwd packages/studio build`, run
> alone — succeeds, 30/30 static pages (`/workflows` and `/workflows/editor`
> are the two new ones). `bun run spec:check` — GAP: 0 (`docs/spec.md` §11.7
> gained one sentence naming the two Studio screens, and §19's table gained a
> "Workflows" row — both short, in the established "added directly, date —
> new product surface" style, not the full write-up step 99.12 owns). `bash
> scripts/check-plan-status.sh` — passes.
>
> **99.10 (the run dialog, the job page, and the wall) is done**, with a
> live-data gap in a file outside this step's scope, found and reported
> rather than papered over, and a genuine correctness landmine in the
> `@enkaku/protocol` package boundary (99.8's own documented collision)
> confirmed to be worse than a `bash scripts/typecheck.sh` failure and
> worked around, not silently.
>
> `packages/studio/src/components/RunScriptDialog.tsx`: a **Workflow |
> Script** segmented `Tabs` filter above the picker — the fourth sanctioned
> `kind === 'workflow'` reader §3.1's amendment already named, not a fifth
> (re-verified: a repo-wide `kind === 'workflow'` search after this step
> still returns only `scripts/routes.ts` (×2) and `workflow-check.ts` (×2) —
> this file's own comparisons are written `(s.kind ?? 'script') === kindFilter`
> against a local variable, so they do not even match that literal grep,
> though the file is sanctioned regardless of phrasing). Switching the
> filter always re-picks the first matching group (`groups[0]`) rather than
> leaving a stale `<Select>` bound to a name the new filter no longer lists.
> Choosing Workflow with none published shows a dedicated empty state
> ("No workflow is published to this farm yet.") with a `next/link` to
> `/workflows/editor`, reached via the SAME `!chosen` branch the pre-existing
> "nothing published at all" case already used — `chosen` naturally resolves
> to `null` once `filteredScripts` is empty, so no second empty-state code
> path was needed. The consequence sentence's duration estimate (§4.11:
> *"4 nodes, up to about 42 min per device"*) is computed CLIENT-SIDE — no
> endpoint returns this number (`checkWorkflow`'s check 7 answers "does this
> fit a budget", never "how long, roughly") — via two new additive exports in
> `packages/studio/src/lib/api.ts`, `estimateWorkflowDuration`/
> `WorkflowDurationEstimate`: a node's `name@version`/`name@latest` ref is
> resolved to a concrete `scripts.id` using the SAME scripts list the dialog
> already loaded (no extra fetch for that half), then each distinct resolved
> id's own row is fetched once (deduped, parallel) to read
> `runtime.timeoutMs` — plan 98 step 98.4's producer, confirmed live. An
> undeclared timeout (most scripts today) is named in `unknownNodes` and
> excluded from the sum, never silently treated as zero — the same honesty
> `W_WORKFLOW_BUDGET_UNKNOWN` established server-side. "up to", never
> "about" alone, because an upper bound presented as a plain estimate would
> be a lie (§3.11). `ConsequenceNote` (the pre-existing multi-device
> component) gained an optional `workflowEstimate` prop rather than a
> parallel copy.
>
> `packages/studio/src/app/jobs/detail/page.tsx`: a **node timeline** card
> (`NodeTimeline`, new) — one row per `job_nodes` EXECUTION (`GET
> /api/jobs/:id/nodes`, fetched unconditionally like `/assists` already is,
> `[]` for every non-workflow job) — placed on the Summary tab rather than
> literally "above the log" (§4.11's own words): Summary is the default tab,
> so this is where "which node failed and why, **without opening the log**"
> (this step's own verifiable result) is actually satisfied; a second copy
> on the Logs tab was considered and dropped as duplication with no added
> value. Each row shows node/script@version-or-gate, a status chip, duration,
> attempts, the gate verdict SENTENCE (not raw JSON — see below), a failed
> node's own `attempts.lastError.message` inline (the "why", legible with no
> log open), and that node's artifacts (`artifacts.nodeId`, attributed to
> its LAST execution when a loop repeats one document node, documented as a
> deliberate approximation in `NodeTimeline`'s own comment). **`skipped` and
> `skipped-on-resume` render distinguishably**, per this step's own brief:
> different words ("skipped" vs "carried over"), different tones (muted/
> neutral vs the accent tone, never red or amber for the deliberate case),
> and a `skipped-on-resume` row links back to `resumedFromJobId` when the
> row carries it. The header gains a live **"node 2/4"** badge from
> `job.status`'s own `node` block, and the WS handler re-fetches the full
> timeline (`refreshNodes()`) whenever `m.payload.node` is present — this is
> what makes the node counter advance LIVE rather than only on the job's
> final settle.
>
> **The gate verdict sentence is built from two sources, neither sufficient
> alone** — `job_nodes.verdict` (`PredicateTrace`: the RESOLVED values and
> the boolean outcome, parsed here through a hand-written recursive Zod
> schema, `PredicateTraceSchema`, since `@enkaku/protocol` exports the
> `PredicateTrace` TYPE only, never a schema for it — the repo's
> never-`as`-cast-external-input rule applied to a genuinely untyped wire
> field) plus the workflow DOCUMENT's own `when`/`then`/`else` (fetched once
> per job, off the SAME `GET /api/scripts/:id` call the pre-existing source
> panel already made — `ScriptSourceResponseSchema` widened by one field,
> `workflow`, rather than a second request) — the trace alone cannot name
> the branch (`continue`/`stop`/`fail`/`goto X`), and the document alone
> cannot say what the values WERE. Combining them reproduces the plan's own
> example exactly: `enough-videos — scroll1.videos (12) >= 10 → continue`
> (pinned in `page.test.tsx`, byte-for-byte). Degrades to a condition-only
> sentence (still real data) when the document is unavailable.
>
> **Resume from here** appears on every row where `finalized && status !==
> 'skipped'` — matching `job-service.ts`'s own `resume()` guard exactly
> (`ran = status !== 'skipped'`) rather than narrowing to only the one
> row a human would call "the failed node": the server already permits
> resuming from ANY node that actually ran, including one that succeeded,
> and hiding that in the UI would just make an operator retype the id via
> the API instead. `ResumeDialog` (new) computes "every node that will not
> run again" from the WORKFLOW DOCUMENT'S own node order (not merely this
> job's own `job_nodes` rows, which can legitimately be incomplete — proved
> by a test where the fixture's own `/nodes` response omits a gate row
> entirely and the dialog still correctly names it, reading the document
> instead), falling back to this job's own seq-ordered ids when the document
> itself is unavailable. Its copy is deliberately never worded as
> restarting the original job (§3.5's own instruction): *"This creates a
> NEW job... the original job is untouched and stays in its history exactly
> as it ran."* Confirms via `POST /api/jobs/:id/resume` with `fromNode` set
> explicitly (never omitted from this UI, even though the route allows it) —
> `JobCreateResponseSchema` (`{ job }`), unshadowed, unlike the node-list
> envelope below.
>
> `packages/studio/src/components/JobsList.tsx` and
> `packages/studio/src/components/wall/WallTile.tsx`: **`node 2/4`** from
> `job.status`, read defensively (`liveNode()` in `JobsList.tsx`, an inline
> equivalent in `WallTile.tsx`) rather than declared on a wider row/prop
> type — `JobInfo` (`@enkaku/protocol`) carries no `node` field, and it only
> ever arrives on a row a LIVE `job.status` WS push has actually touched
> (`app/jobs/page.tsx`'s own `pushLive(m.payload as Job)`, no re-parse, so
> the field really is there at runtime even though the static type does not
> know it). `WallTile`'s caption becomes `{scriptName} · node {seq+1}/{total}`
> — appended to the existing caption, not a replacement, so the running
> script's own name stays legible.
>
> **The one honest, unfixed gap — a live-data hole in a file outside this
> step's scope, not a rendering bug.** `WallTile` is READY to show the wall
> tile's own node counter (proved by a direct-prop test,
> `WallTile.test.tsx`), but the Wall's `jobs` prop, as actually wired
> TODAY, will never carry `.node`: `packages/studio/src/app/page.tsx` (not
> `components/wall/**` — outside this step's file grant) responds to
> `job.status` with `else if (m.type === 'job.status') void load()`, and
> `load()` re-fetches via `api('/api/jobs?status=running&limit=50',
> z.object({ items: z.array(JobInfoSchema) }))` — a Zod `.parse()` against a
> schema with NO `node` field, which strips it even if the wire payload
> carried one. The verbatim fix, for whoever next holds that file: replace
> the `job.status` branch with a merge into the existing `jobs` array off
> `m.payload` directly (the same shape `JobsList`'s own `pushLive` already
> receives unparsed), e.g. `setJobs((prev) => { const i =
> prev.findIndex((j) => j.jobId === m.payload.jobId); if (m.payload.status
> !== 'running') return prev.filter((j) => j.jobId !== m.payload.jobId); if
> (i === -1) return [...prev, m.payload]; const next = [...prev]; next[i] =
> m.payload; return next })` — dropping the re-fetch entirely for this
> message type. Not applied here: `app/page.tsx` is not in this step's file
> list, and the brief's own instruction on an out-of-scope gap is to report
> it with the exact fix, not to touch the file.
>
> **Gap closed, 2026-08-13.** A later pass, holding `app/page.tsx`, applied
> the verbatim fix above almost exactly (`findIndex` by `jobId`, filter out
> on a non-`running` status, append on no match, replace in place otherwise)
> but shipped it with no test of its own. This pass supplied that: a new
> `describe` in `packages/studio/src/app/page.test.tsx` proves the four
> merge/removal behaviours — append, replace-in-place without disturbing a
> sibling device's job, remove-on-non-`running`, and `ws.onReconnected(()
> => void load())` actually re-fetching on reconnect (there is still no WS
> snapshot replay) — through `DeviceCard`'s real "Running a job — view
> details" link, and a new file, `packages/studio/src/app/page.wallNode.test.tsx`,
> renders the real `Dashboard` → `Wall` → `WallTile` (nothing mocked but
> `LiveView` and `@/lib/ws`) and asserts a `job.status` push carrying a
> `node` block actually lands as `"node 2/4"` in the DOM — the one thing the
> existing direct-prop `WallTile.test.tsx` test named above could never have
> caught, since it hands `WallTile` the `node`-bearing job as a prop rather
> than pushing it through the page. Also recorded at
> `docs/plans/96-m61-hotfixes.md`'s top status note (not as a new `96.N`
> entry — this gap already had a home, here). `bun run --cwd packages/studio
> test`: 824 pass / 0 fail (up from this step's own 821/0 by exactly the 3
> tests this pass added). `bun run --cwd packages/studio build`, run alone:
> succeeds, 30/30 static pages.
>
> **A second landmine, reported precisely because 99.8's own status
> paragraph undersold it.** That paragraph frames the `JobNodesResponseSchema`
> collision (`packages/protocol/src/index.ts`'s explicit
> `export { JobNodesResponseSchema, ... } from './messages/job'` winning
> over its own `export * from './api'`) as a `bash scripts/typecheck.sh`
> failure at `packages/core/src/api/jobs.ts` (now line 213, same cause, only
> the line number moved). Confirmed by hand
> (`import * as P from '@enkaku/protocol'; P.JobNodesResponseSchema.shape`)
> that it is worse than that for ANY Studio caller: the shadowed schema's
> keys are `['jobId', 'nodes', 'finalized']`, not the real
> `['items', 'finalized']` `service.nodes()` actually returns (`typedJson`,
> `packages/core/src/api/typed-json.ts`, is a compile-time constraint only —
> it never re-validates the core's own output at request time, so the type
> error there does not stop the wrong body from shipping). `api()`
> (`lib/actions.ts`) runs `schema.safeParse` on every response — importing
> the shadowed export here would have made EVERY real `GET
> /api/jobs/:id/nodes` call throw `BadResponseError` in production, silently
> emptying the exact timeline this step exists to render. Worked around, not
> hidden: `packages/studio/src/lib/api.ts` declares its own
> `JobNodesEnvelopeSchema` (`{ items: z.array(JobNodeInfoSchema),
> finalized: z.boolean() }`) against `JobNodeInfoSchema` — which has NO such
> collision, only the envelope NAME does — with the whole story in that
> export's own doc comment, plus a regression test
> (`api.test.ts`, "the SHADOWED shape does NOT parse here") pinning the real
> shape and proving the shadowed one is rejected. This is not this step's
> collision to resolve (still the coordinator's call per 99.8's own
> paragraph) — only its consequence, one layer further downstream than
> `bash scripts/typecheck.sh` alone would show.
>
> **A test-writing finding worth recording for whoever writes the next Radix
> `Tabs`-driven test in this codebase**: `@radix-ui/react-tabs`'s
> `TabsTrigger` activates on `onMouseDown`, not `onClick` — a bare
> `fireEvent.click(getByRole('tab', ...))` never switches it (confirmed by
> reading `@radix-ui/react-tabs`'s own source: `onMouseDown:
> composeEventHandlers(..., () => context.onValueChange(value))`, no
> `onClick` handler at all). No prior test in this repo clicked a Radix Tabs
> trigger and asserted the resulting switch (the existing Target tabs in
> this same dialog, and Settings' own section tabs, were both exercised
> only via `setSearchParams`/initial-render assertions, never a live
> click) — this step's own new tests are the first, and use
> `fireEvent.mouseDown` instead.
>
> Tested in five files: `RunScriptDialog.test.tsx` (+4 tests: the filter
> switches the picker and hides the other kind, the empty state and its
> editor link, the "nothing published at all" case keeps the original
> message with no filter shown, and the duration estimate), `lib/api.test.ts`
> (+5 tests: `JobNodesEnvelopeSchema` against the real shape and against the
> shadowed one, `estimateWorkflowDuration` summing/degrading/surviving a
> fetch failure), `app/jobs/detail/page.test.tsx` (+4 tests: the timeline
> with a real gate verdict sentence and a named failure reason, the
> skipped/skipped-on-resume distinction with the resume-from link, an
> ordinary job showing no pipeline card, and the full Resume dialog →
> `POST` → navigate flow), `components/JobsList.test.tsx` (new file, 2
> tests), `components/wall/WallTile.test.tsx` (+2 tests). Verified
> 2026-08-13: `bash scripts/typecheck.sh` — every package OK EXCEPT core, at
> the SAME pre-existing single line every prior status paragraph in this
> file reports (`packages/core/src/api/jobs.ts`, now line 213 — the
> concurrent session's collision, still the coordinator's to arbitrate,
> untouched by this step). `bun test` (root) — 3995 pass / 0 fail (up from
> 3954 pass / 1 fail; the one self-detecting gap the paragraph above this
> one reports, `workflow-settings-wiring.test.ts`, was closed by another
> concurrent session during this step, not touched here). `bun run --cwd
> packages/studio test` — 821 pass / 0 fail (up from 804; this step's own
> 17 new tests plus other concurrent Studio work landing in the same
> window). `bun run --cwd packages/studio build`, run alone — succeeds,
> 28/28 static pages (no new route — this step touches only existing
> screens and components). `bun run spec:check` — GAP: 0 (no new
> table/screen/route). `bash scripts/check-plan-status.sh` — passes.
>
> **99.12 (documentation and the spec) is done, 2026-08-13 — this pass's own
> work, and it closes every step of this plan except 99.11.** No source file
> was touched. `packages/protocol/README.md` (new), `packages/core/README.md`
> and `packages/sdk/README.md` (new sections), and `docs/guide/workflows.md`
> (new) were all written and checked by hand against the CODE as it stands
> today rather than against this plan's own original §3/§4 prose — every
> counter-intuitive fact this step's brief named (the one-job/one-lease
> shape; the four-file `scripts.kind` containment claim, falsifiable against
> a fifth; `E_WORKFLOW_BUDGET_IMPOSSIBLE` now genuinely live with
> `W_WORKFLOW_BUDGET_UNKNOWN` for an undeclared node timeout; a resumed job
> still running the pre-job reset on its first real execution; resume
> copying the resolved `scriptId` rather than re-resolving `@latest`;
> `skipped` vs `skipped-on-resume` being genuinely different states, not two
> words for one thing; every static-check finding being returned, never
> just the first) is stated plainly in at least one of the four documents,
> with the no-code-evaluation rule given its own section in
> `packages/protocol/README.md` per the brief's own instruction that it is
> "the most important sentence you will write." `docs/spec.md`'s workflow
> sections (§11.7, §12.4, §19) were found already complete, added directly
> by earlier steps in this same pass-by-pass convention this plan series
> uses throughout — re-read and confirmed accurate rather than rewritten,
> with one small addition (§13's `job.status` `node` block, the one fact no
> earlier step's paragraph had put into spec prose). **One checklist item is
> deliberately left undone**: `docs/plans/00-overview.md` §2's row for this
> plan — that file is explicitly off-limits to this pass (a concurrent
> worker holds it, per this pass's own brief), and the one-line row this
> step would have added is written out verbatim in 99.12's own checklist
> note below for whoever next holds that file. §99.11's own four hypotheses
> plus every other pending-hardware row from §7.3 are gathered into one
> consolidated table (exact commands, empty outcome column) immediately
> above §6 Acceptance criteria, mirroring plans 90/91/92's own precedent for
> this exact situation — nothing in it was run, per this pass's own
> prohibition on touching physical hardware. The one pre-existing failure
> this plan has carried since 99.6/99.7/99.8's own status paragraphs —
> `packages/core/src/api/jobs.ts`'s duplicate-schema collision with a
> second, out-of-workspace Claude session, now at `jobs.ts(229,49)` — was
> re-confirmed present by a fresh `bash scripts/typecheck.sh` run and is
> still the coordinator's to arbitrate, not this step's to fix. Verified
> 2026-08-13: `bun run spec:check` — GAP: 0, unchanged before and after.
> `bash scripts/check-plan-status.sh` — passes. `bash scripts/typecheck.sh` —
> every package OK except core, at the same single pre-existing line. `bun
> test` (root) — 4526 pass / 0 fail. `bun run --cwd packages/studio test` —
> 1046 pass / 0 fail. **This plan's own status stays `partial`, not
> `implemented`, deliberately: 99.1–99.10 and 99.12 are done and verified in
> software; 99.11 (H1–H4 against real hardware) is the one step that remains,
> is explicitly the owner's own territory per this plan's original brief,
> and is now a single table of exact commands waiting for a device rather
> than a design question or an unbuilt mechanism.**
>
> Depends on: Plan 05 (the script framework, the child-process runner, `finish()`), Plan 20/22.0 (clusters and batches), Plan 21 (schedules), Plan 35 (the pre-job reset), Plan 36 (retry classification and the two attempt budgets), Plan 42 (the refcounted session manager), Plan 62 (`name@version` and `@latest`), Plan 63 (the capability registry), Plan 64 (the workspace and server-side bundling), Plan 74 (job timeout), Plan 79 (`ctx.kv`), Plan 81 (`ctx.jobs.trigger()`), Plan 82 (plugins), Plan 95 (the parameter vocabulary, the resolver, `validateParams`, `reconcileParams`, `ParamSetPicker`). None of them needs to change first. This plan adds one executor, one table, one column, and one Studio screen above all of them. Plans 97 (typed output) and 98 (the runtime envelope) are being written **concurrently with this one**; §0.2 states exactly what this plan assumes about them and what changes if those assumptions are wrong.
> Spec references: §10.1 (`busy` is exclusive), §10.2 (lease plus heartbeat), §10.3 (the per-device queue), §10.4 (adb serialisation), §11.1–§11.2 (`defineScript`, `finish()` always runs, every job is a child process), §11.4 (publishing is a finished bundle), §12 (the data model), §12.3 (clusters, batches, schedules), §13 (the WS protocol), §16 (job overhead < 3 s), §19 (Studio screens; schema-driven forms, no hardcoded UI per component)
> Ships: packages/protocol/src/workflow.ts

---

## 0. Evidence

Every claim about how Enkaku behaves today is **CONFIRMED** — there is a file
and a line that says so. Claims about plans 97 and 98 are **ASSUMPTION**, are
collected in §0.2, and are never used as if they were facts. Claims about how
the new machinery will behave in the field are **HYPOTHESIS** and are
instrumented in §5 before §6 asserts them.

**A note on line numbers.** They were read on **2026-08-12** against a working
tree with concurrent edits in flight (plans 97 and 98 are being written into
this same repository right now; `packages/core/src/db/schema.ts` grew by 80
lines during the writing of this section). Where a number and a symbol name
disagree, **the symbol name is authoritative** — every citation below names one.

The brief this was written against is the owner's, verbatim:

> *"Fitur workflows — jadi kaya pipeline. Konsepnya simpel: bisa menyusun
> pipeline atau multi-script biar saling bekerja. Misalnya: Scroll FYP (warmup)
> → Search Keywords & Scrolling Post → Scroll FYP lagi → Report. Mungkin ada
> konsep nodes juga — nodes untuk eksekusi atau evaluasi response sebelumnya."*

and

> *"Workflow nanti jadi satu level dengan script. Jadi kalau mau run a job, ada
> pilihannya: run workflow atau specific script."*

That example is not decoration: it is the acceptance test. Enkaku's own only
plugin already contains three of its four nodes — `tiktok/auto-scroll`,
`tiktok/searched-follow` and `tiktok/switch-account`
(`plugins/tiktok-automation-pack/src/index.ts`, `definePlugin` at `:258`,
`auto-scroll` at `:266`) — so this plan can be checked against real scripts
rather than against invented ones.

### 0.1 Confirmed findings

#### The queue, the lease, and why a pipeline cannot be N jobs

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | The claim SQL will only take a job whose device is **`idle`**: `WHERE j.status = 'queued' AND d.status = 'idle'`. The claim flips the device to `busy` in the same `BEGIN IMMEDIATE` transaction and rolls back if someone took it first. | `packages/core/src/queue/job-store.ts`, `claimNext` at `:251`, the predicate at `:296-297` |
| **F2** | A device returns to `idle` the moment a job settles, and **any** queued job on that device may then be claimed — ordered `priority DESC, created_at ASC, batch_seq ASC`. Nothing reserves a device across two jobs. | `job-store.ts:305`; `packages/core/src/jobs/executor-host.ts:175` |
| **F3** | There is exactly **one** lease per device and it is keyed by `deviceId`, holder `= jobId` for a job lease. `noteJobLease` is an unconditional `leases.set`; `clearJobLease` deletes it. | `packages/core/src/lease/lease-manager.ts`, `Lease` at `:9`, `noteJobLease` at `:248`, `clearJobLease` at `:258` |
| **F4** | A job lease is taken at `ExecutorHost.start()` and released on **both** terminal paths (normal settle, infra-rebind requeue). It exists for exactly the length of one job and not one millisecond longer. | `executor-host.ts:200` (acquire), `:175` and `:116` (release) |
| **F5** | The lease heartbeat is the **host's**, not the child's: a `setInterval` in `ExecutorHost` renews `jobs.lease_expires_at` for as long as the executor's `run()` has not resolved. An executor that takes four hours keeps its lease for four hours with no change to anything. | `executor-host.ts:193` (the interval), `:204` (`ctx.heartbeat`) |
| **F6** | A job lease is **never takeable**, by anyone, whatever is passed: `acquireManual` refuses with `device_busy_job` when the device is `busy`, and `toHolder` reports `takeable: false` for every job lease. | `lease-manager.ts:98` (`acquireManual`), the `busy` branch inside it, and `toHolder` at `:42` |

#### The executor seam — the thing this plan is built on

| # | Finding | Evidence |
|---|---------|----------|
| **F7** | `jobs.scriptId` is **not necessarily a `scripts` row id.** `ExecutorRegistry` maps reserved ids (`internal:sleep`, `internal:install`) to built-in executors and falls back to the script executor for everything else. There are already four executors behind one `jobs` table. | `packages/core/src/jobs/executor.ts`, `ExecutorRegistry` at `:43`, `get()` returning `this.map.get(scriptId) ?? this.fallback`; `packages/core/src/jobs/executors/{script,sleep,install,remote}.ts` |
| **F8** | The `JobExecutor` contract is two methods — `validateParams(params, scriptId)` (called at **enqueue**, before any device is leased) and `run(job, ctx)` (resolve = success). `ExecutorContext` carries `signal`, `heartbeat()`, `log`, `onCrash?`. | `jobs/executor.ts`, `ExecutorContext` at `:4`, `JobExecutor` at `:21` |
| **F9** | The script executor's whole body is: resolve the registry entry, materialise the bundle to a path, call `runner.execute({ id, deviceId, bundlePath, params, scriptExportId })`. It does not own the retry loop, the session, the reset, or the timeout — the runner does. | `packages/core/src/jobs/executors/script.ts`, `run` from `:65`, `bundlePath` at `:89`, `runner.execute` at `:90` |
| **F10** | `JobRunner.execute(job: JobSpec)` already spawns **several children per job**: one per attempt, plus a `finish-only` child in a fresh process when an attempt died before `finish()` ran. Multiple children per job is the existing, tested shape — not a new idea. | `packages/session/src/runner/job-runner.ts`, `JobSpec` at `:67`, `JobRunner` at `:200`, the attempt loop from `:699`, the finish-only child at `:772` |
| **F11** | The device **session** (display/input/inspector engines) is acquired and released **per attempt**, and `SessionManager` is **refcounted** with an idle TTL — so an outer holder keeps the engines alive across an inner acquire/release pair at zero cost. | `job-runner.ts:715` (acquire), `:762`/`:793`/`:827` (release); `packages/session/src/manager.ts`, `refcount` at `:14` |
| **F12** | The child→parent protocol already has a **progress** message — `{ t: 'phase', phase: 'prepare' \| 'run' \| 'finish' }` — surfaced to the core as `onPhase(jobId, attempt, phase)` and pushed to Studio on `job.status` beside `attempt`. A notion of "where in the job are we" already exists end to end. | `packages/session/src/runner/ipc.ts:177`; `job-runner.ts:401` (`onPhase` for `reset`); `packages/protocol/src/messages/job.ts`, `JobStatusEventMessage` at `:184`, `attempt` at `:190`, `phase` at `:191` |

#### The pre-job reset — the second thing a pipeline must survive

| # | Finding | Evidence |
|---|---------|----------|
| **F13** | A **pre-job reset runs before every full attempt**, and the farm default is `'home'` — it presses HOME. `'declared'` additionally force-stops the packages the script declares; `'aggressive'` force-stops every non-system app. | `packages/protocol/src/settings.ts`, `resetPolicy` at `:394`, the default `'home'` at `:589`; `job-runner.ts:391` (the `'none'` short-circuit), `:401` (the `reset` phase) |
| **F14** | The reset is skipped for exactly one case today — a `finish-only` attempt — and the code says why: *"`finish` needs the state a reset would wipe."* The precedent for "sometimes the device state must survive into the next child" is already written, with its reason. | `job-runner.ts`, `afterReady` from `:383`, the finish-only branch immediately below it |

**F13 + F14 are the finding that decides whether the owner's example works at
all.** Warming up the FYP and then searching only means something if the app is
still on the feed when the search node starts. With today's default, a second
node run through `execute()` would begin by pressing HOME.

#### Scripts, versions, and everything a `scripts` row already gets

| # | Finding | Evidence |
|---|---------|----------|
| **F15** | A `scripts` row is `(id, name, version, bundle, source, paramsSchema, enabled, createdBy, createdAt, pluginId, exportId)` with `(name, version)` **unique**. `bundle` is a single-file ESM text bundle stored inline; `source` is the entry file, kept *"purely so a human can read what a job actually ran"*. | `packages/core/src/db/schema.ts`, `scripts` at `:413`, `bundle` at `:420`, `source` at `:427`, `paramsSchema` at `:428`, `exportId` at `:442`, `idx_scripts_name_version` at `:445` |
| **F16** | `(name, version)` is immutable in practice: publish throws `script_version_exists`, and the only mutation route is `PATCH /:id` accepting `{ enabled }` and nothing else. | `packages/core/src/scripts/service.ts`, `publishScript` at `:101`, the throw at `:108`; `packages/core/src/scripts/routes.ts`, `PatchBody` |
| **F17** | `ScriptRegistry.resolve(ref, { allowDev })` is the single front door for `name@version`/`@latest`, and `bundlePath(entry)` is the single door to a runnable file. Plugin members are ordinary `scripts` rows named `<plugin>/<script>`. | `packages/core/src/scripts/registry.ts`, `ScriptEntry` at `:23`, `ScriptRegistry` at `:67`, `resolve` at `:242`, `bundlePath` at `:273`; `packages/core/src/scripts/resolve.ts`, `resolveScriptRef` at `:23` |
| **F18** | A published bundle **cannot import another published bundle.** The workspace build allowlist is `@enkaku/sdk` and `zod` and nothing else — `node:*` included — enforced by a static import-graph walk before `Bun.build` is ever called. The CLI inlines every dependency into one file. | `packages/core/src/scripts/build.ts`, `ALLOWED_BARE_SPECIFIERS` at `:33`, the refusal at `:76-82`; `packages/sdk/src/cli/publish.ts`, `buildEntry` |
| **F19** | The only runtime script-to-script relationships that exist are `ctx.jobs.trigger()` (enqueue, **fire-and-forget, never a result**), `ctx.jobs.resultOf(jobId)` (same-script-name only), and a shared `ctx.kv` namespace within one plugin. There is no "run this script and give me its output" verb anywhere. | `packages/sdk/src/types.ts`, `JobsApi`, `TriggerInput`, `TriggerResult`; `packages/core/src/jobs/triggers.ts`; `packages/core/src/jobs/script-jobs.ts` |
| **F20** | `ctx.jobs.trigger()`'s default idempotency key is `` `${job.id}:${job.attempt}:${idx}` `` and is enforced by a **partial unique index** on `(rootJobId, triggerKey)`. Two different scripts running under one `jobId` with one `attempt` counter would therefore collide and the second trigger would silently dedupe. | `packages/session/src/runner/jobs-client.ts:119`; `packages/core/src/db/schema.ts`, `uniqueIndex('idx_jobs_trigger_key')` at `:358` |
| **F21** | `ScriptDefinition` carries `timeout?`, `retries?`, `reset?`, `prepare?`, `run`, `finish?`. `finish` is documented *"ALWAYS runs — must be stateless and idempotent"*, and that contract is load-bearing: the runner genuinely re-runs it in a fresh process after a killed attempt. | `packages/sdk/src/types.ts`, `ScriptDefinition` at `:277`, `finish` at `:296`, `reset` at `:302`; `job-runner.ts:772` |

#### Parameters — everything plan 95 built, and what it means here

| # | Finding | Evidence |
|---|---------|----------|
| **F22** | `validateParams(schema, value)` is one pure function in `@enkaku/protocol` used by **both** the browser and the core, returning `issues` with field paths. | `packages/protocol/src/params/validate.ts`, `validateParams` at `:312` |
| **F23** | `reconcileParams(schema, stored)` returns `{ value, findings, blocking }` with `findings` of kind `removed \| reset \| invalid \| missing`, and the house rule is written and enforced in two places: **an unattended caller refuses on `blocking`; an attended caller does not.** | `packages/protocol/src/params/reconcile.ts`, `reconcileParams` at `:268`; `packages/core/src/schedules/runner.ts:225-233`; `packages/core/src/api/batches.ts:252-259` |
| **F24** | `checkParamsSchema` + `PARAMS_LIMITS` (64 KiB, depth 5, 200 fields, identifier-shaped field names, `__proto__`/`constructor`/`prototype` refused) gate every publish path. | `packages/protocol/src/params/limits.ts`, `PARAMS_LIMITS` at `:12`, `checkParamsSchema` at `:231`; `packages/core/src/scripts/routes.ts:266` |
| **F25** | The form is fully schema-driven: `planForm(schema)` → `PlannedField[]` → `SchemaForm`. There is no per-script React anywhere, and `PARAM_KINDS` / `ParamHints` / `ui()` are the closed vocabulary an author writes. | `packages/studio/src/components/schema-form/plan.ts`, `planForm` at `:544`, `FieldPlan` at `:148`; `packages/protocol/src/params/vocabulary.ts`, `PARAM_KINDS` at `:20`, `ParamHints` at `:66`, `ui` at `:158` |
| **F26** | `script_param_sets` is keyed on the script **name**, never a `scripts.id`, *because a preset is standing intent that must outlive the version it was written against*. `ParamSetPicker` applies a set through `reconcileParams` and reports what changed. | `packages/core/src/db/schema.ts`, `scriptParamSets` at `:465`; `packages/studio/src/components/ParamSetPicker.tsx` |
| **F27** | Plan 95 **refuses to evaluate any author-supplied regular expression**, in the browser or in the core, because JavaScript offers no way to bound a match. A `pattern` is surfaced as help text and never run. | `packages/protocol/src/params/validate.ts` (no `pattern` evaluation); plan 95 §3.8 R2 |

#### Batches, schedules, and the run dialog

| # | Finding | Evidence |
|---|---------|----------|
| **F28** | A batch is strictly **one script × N devices**: `createBatch` writes the batch row and one job row per resolved device, all in one transaction. There is no step, stage, or DAG table anywhere in the schema. | `packages/core/src/clusters/dispatch.ts`, `CreateBatchInput` at `:11`, `toJobRow` at `:73`, `createBatch` at `:129`, the transaction at `:169` |
| **F29** | `POST /api/batches` takes a **concrete `scriptId`**, not a `name@version` reference — unlike schedules (`schedules.scriptRef`) and `POST /api/jobs` (which accepts either). | `packages/core/src/api/batches.ts`, `CreateBatchBody` at `:32`, `scriptId` at `:33`; `packages/core/src/db/schema.ts`, `scriptRef` at `:644` |
| **F30** | `batches.concurrency` is enforced **only inside the claim SQL**, with an explicit instruction not to add a TypeScript pre-filter. A schedule fires a batch, never a bare job, and passes `concurrency`/`order`/`priority`/`queueTimeoutSec` straight through. | `job-store.ts:301-305`; `packages/core/src/schedules/runner.ts`, `createBatch(...)` in `fireOnce` |
| **F31** | The run dialog already groups scripts by **name** (newest version preselected), then by plugin, renders `ParamSetPicker` keyed on the name and `SchemaForm` keyed on the version's id, and always submits a concrete `scriptId`. Adding a second *kind* of runnable thing to this screen is a filter, not a rewrite — **if** the second kind is a `scripts` row. | `packages/studio/src/components/RunScriptDialog.tsx`, `ScriptRow` at `:29`, `groupByName` at `:99`, `groupByPlugin` at `:122`, `ParamSetPicker` and `SchemaForm` in the body, `runScript` submitting `scriptId` |
| **F32** | Artifacts are per job, numbered per job, with a free-text `label` and no grouping dimension below the job. | `packages/core/src/db/schema.ts`, `artifacts` at `:488`, `label` at `:496`; `packages/core/src/runner/artifact-store.ts`, `createArtifactStore` |
| **F33** | The agent/MCP surface runs a script through the single `job.run` capability, whose `params` is `z.unknown()`; enqueue-time validation is what gives a model a typed refusal. Nothing about that path knows what a script *is*, only that it has an id or a ref. | `packages/core/src/capability/job.ts`, `jobRun`; `packages/core/src/mcp/server.ts`, `tools/list` and `tools/call` |
| **F34** | **There is no workflow abstraction of any kind in this repository.** A repo-wide search for `workflow`/`pipeline`/`DAG` over `packages/**` returns only incidental prose in unrelated comments. | repo-wide search, 2026-08-12 |

### 0.2 Assumptions about plans 97 and 98 — stated, not relied on

Plans 97 (the typed output contract) and 98 (the runtime envelope) are being
written **at the same time as this document** and neither exists on disk as of
2026-08-12; a check of the tree confirms no `outputSchema` column, no
`ScriptDefinition.output`, and that `packages/protocol/src/envelope.ts` is still
only the M0 WS envelope (`EnvelopeSchema`, 12 lines). Everything below is an
**ASSUMPTION**. Each one names what changes here if it is wrong.

| # | Assumption | If it is wrong |
|---|---|---|
| **A1** | Plan 97 lets a script declare an output shape (`ScriptDefinition.output?: ZodType`), published as a JSON Schema on the `scripts` row (`outputSchema`, alongside `paramsSchema`), and validated at the child boundary the way `params` already is. | Only the **publish-time** checking of output bindings (§3.6) is lost. Run-time binding resolution reads the actual value and is unaffected. This plan degrades to "bindings are checked when they run", which is exactly the behaviour it already specifies for scripts that declare no output. |
| **A2** | An **undeclared** output stays what it is today: whatever `run()` returned, stored raw on `jobs.result` (`schema.ts:275`). Plan 97 does not make declaring an output mandatory. | If plan 97 *does* make it mandatory, workflows still work — every binding simply becomes statically checkable, and §3.6's "unchecked" branch becomes dead code to delete. That is a strictly better world, not a broken one. |
| **A3** | Plan 98 keeps the child protocol's `ready` / `phase` / `result` / per-attempt `init` shape (`ipc.ts:150`, `:177`, `:198`, `:210`). Whatever envelope it introduces wraps or replaces those messages **for every child equally**. | This plan adds **no second runtime**: every workflow node goes through the same `JobRunner.execute()` as every ordinary job (§3.4). Anything plan 98 changes about the envelope therefore applies to workflow nodes automatically, with no work here. |
| **A4** | If plan 98 introduces a durable per-run identity (a run id, an envelope id, a structured run record), it is *below* the job, not above it. | `job_nodes` (§4.6) should then key on that identity instead of `(jobId, seq)`. This is named as the seam in §4.6 and is a column rename, not a redesign. |
| **A5** | Neither plan removes `jobs.result`, `onPhase`, or the `(name, version)` uniqueness of `scripts`. | Any of those would be a spec change, and this plan would need re-reading. Named so that the dependency is explicit. |

**The load-bearing point: nothing in §3's central decision depends on A1–A5.**
The decision rests on F1–F14, which are all confirmed. Plans 97 and 98 make the
result *better checked*, not *possible*.

### 0.3 Hypotheses (instrumented before they are asserted)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | Running N nodes as N children inside one job costs materially less than N jobs, because the dominant per-job cost is the **session build**, not the child spawn — and one job pays it once. | F11: the session is acquired per attempt and the manager is refcounted, so an outer hold makes every inner acquire a counter bump. Plan 85's own ladder treats session build time as a first-class measurement. | 99.11 measures a 4-node workflow against the same four scripts run as four separate jobs on one device, recording total wall time, session builds, and child spawns. |
| **H2** | Suppressing the pre-job reset between nodes is what makes a pipeline mean anything, and doing so leaves the device in a state the next node can start from **for the great majority of real pipelines**. | F13/F14: the reset is the only thing between nodes that touches app state, and the `finish-only` precedent already establishes that skipping it is sometimes correct. | 99.11 runs `tiktok/auto-scroll` → `tiktok/searched-follow` with `reset: 'none'` on node 2 and records whether node 2 begins on the feed. Ten runs, three devices. |
| **H3** | An operator writing the owner's own example needs **at most one** workflow parameter (the search keyword) and **at most one** gate, so a v1 that supports a sequence, one binding grammar and one predicate grammar is not a toy. | The example is stated in full in the brief and the three scripts exist (`plugins/tiktok-automation-pack/src/index.ts`). | 99.11 builds that exact workflow, unedited, and records how many concepts it needed that this plan does not have. |
| **H4** | Per-node history (`job_nodes`) — not per-node *jobs* — is enough to answer every question an operator actually asks: which node failed, what did it return, why did the gate branch that way, and where do I resume. | Spec §12.3 already uses the same shape for `schedule_runs`: *"one row per fire decision, including 'ran nothing' outcomes, so a schedule's history is never a blank gap."* | 99.12's smoke test asks each of those four questions against a deliberately failed workflow and records whether the UI answers them without reading a log. |

---

## 1. Goals

- **A workflow is composed once and then behaves like every other runnable thing
  in the product.** Publish it and it appears in the scripts list, resolves as
  `name@version` and `@latest`, runs from the run dialog with a generated
  parameter form and saved parameter presets, is schedulable, batchable across a
  cluster, cancellable, auditable, and callable by an agent — with **no
  union type introduced anywhere downstream of the executor**.
- **The device is held for the whole pipeline.** Warm up the feed, search, scroll
  again, report — with the same lease, the same session, and the same app state
  throughout, and with no other job able to slip in between nodes. This is the
  feature; everything else is bookkeeping around it.
- **A node is an ordinary script, run in its own child process.** Crash
  containment, its own timeout, its own retries, its own `params`, its own
  `finish()` — inherited from the existing runner, not re-implemented.
- **Every node's outcome is on a row.** Which node ran, when, for how long, what
  it returned, which attempt, why it failed, and — for a gate — the values it
  compared and the branch it took. A workflow's history is never a blank gap.
- **Data flows along declared edges, by name.** A node reads the workflow's own
  parameters and any *earlier* node's output, through an explicit binding it can
  be checked against — never implicitly from "the previous node", and never
  through an expression language.
- **Evaluation is a decision, not a program.** A gate compares values it already
  has using a closed set of operators, and anything that closed set cannot
  express is an ordinary script that returns a verdict. No author-supplied code,
  no author-supplied regular expression (F27), evaluated anywhere.
- **A workflow is parameterised.** The owner's example needs a search keyword;
  without workflow-level parameters bound to node parameters every workflow is
  single-use. The declaration reuses plan 95's vocabulary verbatim, so the
  workflow's run form *is* the script run form.
- **A failure is resumable, honestly.** A node retried in place never left our
  hands and is safe. A workflow resumed after the job ended is a new job on a
  device whose state we cannot vouch for, is operator-initiated, and says so.
- **A loop is bounded on the document.** A gate may branch backwards; a workflow
  carries a step budget; exceeding it fails with a named error rather than
  cooking a phone.
- **v1 ships an editor a person can use, not a canvas.** A list of nodes with a
  branch rail, built from components that already exist — and a document shape
  that a graph canvas could render later with no migration.

## 2. Non-goals

- **Not parallel nodes, and not fan-out across devices inside one workflow.** One
  device, one session, one node at a time. A DAG's whole value is parallelism and
  there is none available here (§3.9). A pipeline that spans two devices needs a
  lease per device, a join, and a partial-failure model; it is a different
  product and it is named in §9 Q5, not half-built.
- **Not nested workflows.** A node's script must not itself be a workflow in v1.
  Nesting makes the step budget, the node-id namespace, the artifact namespace
  and the resume model recursive, and makes a cycle (A includes B includes A)
  possible. Refused at publish with a named error; the seam is §9 Q4.
- **Not an expression language, a rules DSL, or a template syntax.** §3.7.
- **Not author-supplied regular expressions.** Plan 95 §3.8 R2 refuses them for
  parameters; this plan does not reintroduce them in a gate (F27).
- **Not a graph canvas editor.** §3.9 recommends against it for v1, prices it,
  and leaves the document shape that would allow it later.
- **Not per-node device switching, human approval nodes, or wait-for-a-webhook
  nodes.** All three are real features; none is this plan's.
- **Not a replacement for `ctx.jobs.trigger()`** (F19). Trigger stays exactly what
  it is: a script deciding at run time to enqueue *another job*, fire-and-forget,
  on its own or another device. A workflow is the opposite shape — a declared,
  reviewable, result-carrying sequence on **one** device under **one** lease.
  §3.1 says why one cannot be built out of the other.
- **Not pacing, repetition, or the fleet stagger** — plan 94 owns `count`,
  `intervalMs` and `deviceIntervalMs`, on the batch. A workflow inherits all of it
  for free the moment plan 94 lands, because a workflow batch *is* a batch
  (§3.10). This plan adds no second pacing concept.
- **Not the `internal:*` executors' parameter forms.** `internal:install` and
  friends still get their own dialogs; making them schema-driven is adjacent and
  not this plan's.
- **Not a fix for the two defects found while writing this plan** — plugin members'
  `paramsSchema` published without `{ io: 'input' }`, and `PARAM_SOURCES`'
  `devices`/`clusters`/`scripts` entries having no mapping in `useEnumSource`.
  Both are recorded in §9 items 7–8 so they are not lost.

---

## 3. Context and design decisions

### 3.1 The decision the rest of this plan hangs on

Three candidates were considered. The recommendation this plan was asked to test
was the first; it is **substantially right and specifically wrong**, and the
correction matters enough to be the whole of this section.

---

#### Candidate A — "a workflow compiles to a script bundle" (the recommendation)

Plan 94 decided that *a recording is source and a script is build output*, and
the reasoning is excellent: a second runnable artefact type would need its own
row, list screen, version story, reference syntax, executor path, permission,
batch integration, schedule integration and cancel path — and would need all of
it again every time any of those subsystems changed. That argument is correct and
this plan does not re-litigate it.

**But a recording and a workflow are not the same shape, and the difference is
decisive.** A recording's content — taps, swipes, sleeps — *is expressible in the
SDK language*. It compiles to `defineRecording({…})` and runs as an ordinary
bundle because everything it does, a bundle can do.

A workflow's content is **references to other published scripts**, and F18 is
categorical: a published bundle cannot import another published bundle. The
allowlist is `@enkaku/sdk` and `zod`, enforced by a static graph walk before
`Bun.build` is called. So "compiles to a bundle" has to mean one of two things,
and both are worse than they look:

**A1 — inline the node sources at compile time.** Take each node script's
`source`, concatenate, emit one bundle. This fails on four counts, any one of
which would be enough:

1. **Version pinning dies.** The workflow bundle freezes *copies*. Republishing
   `tiktok/auto-scroll@1.4.1` would not reach a workflow that named
   `tiktok/auto-scroll@latest`, and no one would be able to tell from the row.
2. **The job history lies.** The operator needs to read *"node 2 ran
   `tiktok/searched-follow@1.4.0`"*. An inlined bundle can only say
   *"`fyp-warmup@1.0.0` ran"*. F15 says `scripts.source` exists *"purely so a
   human can read what a job actually ran"* — inlining defeats the column's
   stated purpose.
3. **Each node's own declarations are flattened away.** `timeout`, `retries` and
   `reset` are per-`ScriptDefinition` (F21). Four nodes with four timeouts become
   one timeout; four retry budgets become one; four reset declarations become one.
4. **`source` is not always available.** A CLI-published script's `source` is the
   entry file only (F15) and is nullable for older rows. A plugin member's
   `bundle` is the *whole plugin bundle* (F15). There is nothing coherent to
   inline for either.

**A2 — a nested-child IPC verb.** The workflow bundle's `run()` calls a new
`ctx.run(scriptRef, params)`; the parent spawns a sub-child and returns its
result. This is genuinely possible and it is still wrong:

- **Two children hold `DeviceApi` on one session simultaneously.** The outer child
  is alive and idle-waiting while the inner one drives the device. Who sequences
  `pause()`? Whose `timing` applies? This is a correctness hazard with no clean
  answer, and it did not exist before.
- **Timeouts nest.** The inner script's `timeout` sits inside the outer's, which
  sits inside the farm's `maxTimeoutMs`. Reasoning about which clock killed a run
  becomes a puzzle.
- **Cancel traverses two hops**, as does the abort → `finish()` → SIGTERM →
  SIGKILL escalation the runner already implements once, carefully.
- **It buys one extra child spawn per workflow** (spec §16 budgets < 3 s per job's
  overhead) whose entire job is to relay a document the parent already holds.
- And the outer bundle would be **three ceremonial lines**. It exists only so
  someone can say "it's a bundle".

---

#### Candidate B — "a workflow is a peer entity" (the owner's literal description)

A `workflows` table beside `scripts`; a workflow run is N jobs.

Steelmanned properly, this is the *attractive* option, and its attractions are
real: per-node history is free (each node is a `jobs` row with its own artifacts,
logs, retries and failure class), resume-from-node is free (enqueue the remaining
jobs), per-node cancel is free, and no new executor is needed.

**And it cannot hold the device.** F1 and F2 are the whole argument: the claim
predicate is `j.status = 'queued' AND d.status = 'idle'`, and a settled job
returns its device to `idle` immediately. Between node 1 and node 2, any queued
job — another operator's, another batch's, a schedule's — is eligible. The warm-up
is gone and nobody is told.

To fix that you must invent a **device reservation that outlives a job**, and it
is strictly harder than the bookkeeping it saves:

- **A new lease shape.** F3: there is one lease per device, keyed by `deviceId`,
  and F4: a job lease exists for exactly one job. A reservation is a third type
  held by *nothing that is running*.
- **A new heartbeat owner.** F5: the job lease is renewed by `ExecutorHost`'s
  interval, which exists because a job is executing. Between nodes nothing is
  executing, so a new long-lived "pipeline supervisor" must heartbeat — a new
  daemon subsystem with its own restart story.
- **A new claim predicate**, and the reservation must be visible to it, in SQL,
  inside the same `BEGIN IMMEDIATE` transaction (F1) — because plan 20's own
  instruction at `job-store.ts:256-260` is *do not add a TypeScript pre-filter*.
- **A new way to strand a device.** A reservation whose supervisor died holds a
  phone hostage. That needs its own reaper, its own expiry, its own doctor check.
- And it **defeats its own best feature**: the interleaving that makes per-node
  jobs attractive is exactly what a reservation must forbid.

Then, separately, every consumer learns a union type: `jobs`, `batches`,
`schedules`, `clusters`, the capability registry, MCP, the ACL, the run dialog,
param sets, job history, retention. F31 shows the run dialog is a *filter* away
from supporting workflows if they are `scripts` rows, and a *rewrite* away if
they are not.

---

#### Candidate C — the decision: **a workflow is a `scripts` row, and not a bundle**

> A workflow publishes as an ordinary `scripts` row with `kind: 'workflow'`,
> whose stored artefact is a **validated workflow document** rather than an ESM
> bundle. It runs as **one job**, executed by a **workflow executor** that runs
> each node as an ordinary script child through the existing `JobRunner`.

This takes the half of the coordinator's recommendation that is right — **the
artefact identity** — and rejects the half that is wrong — **the bundle**.

**What one `scripts` row buys, for the cost of one nullable column:**

| Inherited | Because |
|---|---|
| `name@version`, `@latest`, immutability | F15, F16, F17 — same row, same unique index, same resolver |
| The generated run form | F25 — `paramsSchema` is a column; the workflow writes one |
| Saved parameter presets | F26 — `script_param_sets` is keyed on the script **name** |
| Job history, artifacts, logs, retries, cancel | F7 — `jobs.scriptId` already points at things that are not `scripts` rows; here it points at one that is |
| Batches across a cluster | F28, F29 — `batches.scriptId` is a concrete `scripts.id` |
| Schedules | F30 — `schedules.scriptRef` is a `name@version` string |
| Plan 94's pacing, when it lands | It is a property of the batch, and a workflow batch is a batch |
| The ACL | `script.view` / `script.publish` / `job.run`, unchanged |
| The agent and MCP surface | F33 — `job.run` takes an id or a ref and asks no further questions |
| The run dialog's "workflow or script" choice | F31 — a segmented filter over one list |

**What one job buys:** the lease, for free. One job is one `busy` window (F1),
one lease acquired at `start()` and released at settle (F4), heartbeated by the
host for as long as the executor runs (F5), and untakeable by anyone (F6). *The
single hardest requirement in the brief is satisfied by a decision made for
entirely different reasons* — which is the sign it is the right decision.

**What one child per node buys:** crash containment per node, each node's own
`timeout`/`retries`/`reset`/`params`/`finish()` (F21), and the entire existing
abort-and-escalate path. And it is not a new shape: F10 says the runner already
spawns several children per job.

**What it costs, stated plainly.** Three things are genuinely not free, and this
plan builds all three rather than pretending they come with the decision:

1. **Per-node status** — `job_nodes` (§4.6), one table.
2. **Per-node artifacts** — `artifacts.nodeId` (§4.6), one nullable column.
3. **Resume-from-node** — §3.5, one route and one derivation from those rows.

**And what leaks.** The union does not vanish; it is *confined*. `scripts.kind`
is read in exactly **four** places: executor selection (§4.5), the publish route
(§4.5), Studio's list filter (§4.11), and — found only once step 99.6 actually
built the checker, and recorded here rather than left for a reader to trip over
— the nested-workflow check inside `checkWorkflow` (§4.3, `E_WORKFLOW_NESTED`,
`packages/protocol/src/workflow-check.ts`). Everything else in the table above
sees a `scripts` row and asks nothing further. Compare candidate B's list. That
containment is the claim, and acceptance criterion 3 is written to be falsifiable
against it: *a repo-wide search for `kind === 'workflow'` outside those four
files must return nothing.*

**Why the fourth reader is legitimate rather than a containment breach.**
`checkWorkflow` is deliberately pure and database-free (§4.3's own doc comment:
"never touches a database") specifically so the editor's Validate button and the
publish gate run the *same* function and can never disagree about whether a
workflow is valid. Detecting a nested workflow needs to compare a resolved
node's `kind` against `'workflow'` *somewhere*, and §4.3's own signature —
`checkWorkflow(doc, resolved: Map<ScriptRef, { ..., kind: 'script' | 'workflow' }>)`
— is what hands that fact to this function rather than to the route. Hoisting
the comparison into the route instead was considered and rejected: it would
either duplicate the check (so Validate and publish could disagree after all)
or force `checkWorkflow` to accept a route-computed boolean in place of `kind`
— a signature change made purely to dodge a grep, which is gaming the
acceptance criterion rather than satisfying the design it exists to protect.
The criterion is amended to four files, not weakened to "somewhere sensible":
a repo-wide `kind === 'workflow'` match outside `jobs/executor.ts`, the
workflow/script publish routes, Studio's list filter, and `workflow-check.ts`
still means the containment has drifted and the acceptance test should still
fail.

**What would change my mind.** Two things, and only two:

- **If a workflow ever needs to hold two devices at once.** One job is one device
  (`jobs.deviceId` is a column, not a set). A two-device pipeline is not a
  variation on this design, it is candidate B with a real reason to exist — and
  it would need the reservation subsystem anyway. §9 Q5.
- **If per-node queue interleaving turns out to be wanted** — if operators want a
  high-priority job to be able to cut in between two nodes. That is the exact
  property one job forbids. If it is wanted, the lease requirement in the brief
  was wrong, and candidate B becomes correct. Nothing in the owner's description
  suggests it; the whole point of *"Scroll FYP (warmup) →"* is that nothing may
  cut in. Stated so the trade is visible rather than assumed.

Notably, *"could the runner gain a notion of step boundaries?"* — the question
this decision was asked to answer — turns out not to need the runner at all.
Step boundaries live **above** the child, in the executor, so the child protocol
(F12) is untouched in v1. A recording that wants boundaries *inside* one script's
`run()` would extend `ipc.ts:177`'s `phase` message; that is plan 94's, and this
plan deliberately does not spend it.

### 3.2 One job, one lease, one session — and where it can still go wrong

The mechanism, end to end, with nothing new in it except the executor:

```
POST /api/jobs { scriptId: <workflow row> }        → one queued job
  claimNext                                         → device 'idle' → 'busy'   (F1)
  ExecutorHost.start                                → noteJobLease(device, jobId)  (F4)
                                                    → heartbeat interval starts    (F5)
  ExecutorRegistry.get(scriptId) → workflow executor                              (F7)
    sessions.acquire(deviceId)   ← held for the WHOLE workflow                    (F11)
      node 1: runner.execute({ id: jobId, bundlePath: <node 1>, … })
      node 2: runner.execute({ id: jobId, bundlePath: <node 2>, … })
      gate:   evaluated in-process — no child, no device call
      node 3: runner.execute({ id: jobId, bundlePath: <node 3>, … })
    sessions.release(deviceId)
  settle                                            → clearJobLease, device → 'idle'  (F4)
```

**Every node runs through `runner.execute()` with the same `job.id`.** Only
`bundlePath`, `params`, `scriptExportId` and the new `reset` field differ. That
one choice makes almost everything line up:

- **Logs.** One job, one log file, one live buffer — nodes appear in sequence in
  one readable stream, which is what an operator wants.
- **Artifacts.** One job directory, one sequence number (F32). The `nodeId`
  column groups them without moving any files.
- **Cancel.** `host.abort(jobId)` → the runner's `active` map is keyed by job id
  → whichever node is currently running is aborted, its `finish()` gets its grace
  window, and the escalation to SIGKILL is the one that already exists.
- **Heartbeat.** `deps.heartbeat(job.id)` on every child message keeps working.
- **The session.** The runner's per-attempt acquire/release becomes a refcount
  bump against the executor's outer hold (F11), so the engines are built **once**
  for the whole pipeline. This is H1.

**And one thing does not line up, and must be fixed rather than discovered.**
F20: `ctx.jobs.trigger()`'s default idempotency key is
`` `${job.id}:${job.attempt}:${idx}` ``, enforced by a partial unique index. Two
different node scripts, both under one `jobId`, both on their first attempt, both
calling `trigger()` once, would both derive `job-abc:1:0` — and the second would
**silently dedupe into the first**. That is a data-loss bug this design
introduces, and 99.4 closes it by threading the node id into the derivation
(§4.8). It is called out here, in the design section, because a half-built
version of this feature is exactly the kind of thing that would ship without it.

**What happens when a node fails mid-pipeline.** The lease is *not* released
early, and that is deliberate:

1. The failing node's own retries run first (its `ScriptDefinition.retries`, or
   the workflow's override) — same device, same session, same lease.
2. If it still fails, the node's `onFailure` policy decides: `fail` (default),
   `continue`, or `goto`.
3. On `fail`, the executor stops, marks the remaining nodes `skipped` in
   `job_nodes`, releases the session, and rejects — so `ExecutorHost` settles the
   job `failed` and releases the lease on the path it already uses (F4).
4. The device is left wherever the failing node left it. **Nothing can undo
   that**, and this plan does not pretend otherwise. What it does provide is the
   workflow's own `onFail` cleanup (§4.1): an optional final node, always run on
   failure, whose contract is exactly `finish()`'s — stateless and idempotent
   (F21). Force-stopping an app twice is a no-op, so the common cleanup is
   idempotent by construction.

**A job-lease expiry mid-pipeline** behaves exactly as it does for any job today:
the reaper fails the job through `finishExternally` (F5's counterpart in
`lease-manager.ts`'s reaper), the child is killed, and `job_nodes` retains every
completed node — which is precisely what makes resume possible.

### 3.3 The pre-job reset is the *second* lease, and it must be declared

The lease keeps other jobs off the device. It does nothing about the pre-job
reset (F13), which presses HOME before every full attempt by default, and which
would begin node 2 by leaving the app the operator just warmed up.

The instinct to hardcode "no reset between nodes" is wrong, because a real
pipeline sometimes wants one: an account-switch node that should start from a
clean launcher, a recovery node after a failure.

**Decision.** Every node declares `reset`, with a default that matches intent:

| Node position | `reset` default | Meaning |
|---|---|---|
| the first node | `'farm'` | today's behaviour exactly — whatever `job.resetPolicy` says |
| every later node | `'none'` | the pipeline's state survives |

and a node may override either way. `'farm'` and `'none'` are the only two
values, because they are the only two questions: *should this node begin from
the farm's declared clean state, or from where the previous node left the
device?* A per-node policy enum would be a second copy of a setting that already
exists in one place.

The mechanism is one optional field on `JobSpec` threaded to the one branch that
already exists for `finish-only` (F14, `job-runner.ts:383`'s `afterReady`), so
the change to the runner is a second condition beside a condition that is already
there, with the same reason written next to it.

**And the editor says it out loud**, because this is the single most surprising
thing about a pipeline: each node row shows `starts from: where node N-1 finished`
or `starts from: a clean device`, in words, not as a toggle labelled "reset".

### 3.4 A node is a script child, not a job

Stated once so the rest of the plan can lean on it:

- A node's script is resolved through `ScriptRegistry.resolve()` (F17) — the same
  door schedules and triggers use — and its bundle materialised through
  `bundlePath()`. No second resolution path, no second bundle cache.
- A node's `params` are validated with `validateParams` (F22) against that
  script's own `paramsSchema` **before the child is spawned**, so a binding that
  produced a bad value fails with field paths and no process.
- A node's `timeout` and `retries` come from its own `ScriptDefinition` via the
  child's `ready` message, exactly as they do for a standalone job. The workflow
  may override `retries` per node; it may not override `timeout` upward past the
  farm's `maxTimeoutMs`, for the same reason a script cannot (plan 74).
- A node's `finish()` always runs, in the same fresh-process way (F21, F10).
- A node's `ctx.kv` namespace is its own script/plugin id — unchanged. This means
  **nodes of one plugin already share a kv namespace**, which is a second,
  script-authored channel between them that this plan neither adds nor removes.
  It is worth naming so authors know it exists and so §3.6's binding grammar does
  not have to grow to cover cases kv already handles.

### 3.5 Retry, resume, and what a node's side effects actually mean

Plan 94 met this shape and answered it for *repetition*: N jobs, not one looping
job, because *"a loop retried at repetition 7 redoes 1–7."* A workflow is the
*composition* case, and the answer is different because the constraint is
different — repetitions are interchangeable, nodes are not.

**Two mechanisms, deliberately named differently, because conflating them is the
trap.**

#### Node retry — automatic, safe, and not a new obligation

Node *k* failed; run node *k* again. Same job, same lease, same session, same
device, a fresh child.

This is **not a new correctness obligation**: it is the existing one applied one
level down. F10 shows the runner already re-runs a failed attempt after running
`finish()` in a fresh process; F21 is why that is safe. A node retry is exactly
that, and the same `finish()` contract covers it. Nothing about `finish()`
changes, and the repo rule that it must be stateless and idempotent binds
unchanged.

Bounded by the node's own `retries` (its `ScriptDefinition.retries`, or the
workflow's per-node override), and — as for any job — infra-classified failures
get the farm's separate `job.retry.maxInfraAttempts` budget with backoff, since
that is the runner's, not this plan's.

**What a retry cannot do is un-run nodes 1..k-1.** It does not try. Their effects
are on the device and in the world, and the pipeline continues from where it is.
That is the honest semantics and it is what the operator expects: retrying a
failed search does not un-warm the feed, and nobody wants it to.

#### Resume from node — manual, explicit, and a new job

The job ended (failed, expired, was cancelled, the core restarted). The operator
wants to continue from node *k* rather than from node 1.

**Decision: resume creates a NEW job, and it is never automatic.**

The reason is F1 + F2, stated as a rule:

> Once a job settles, the device returns to `idle` and the farm may do anything
> with it. A workflow resumed later therefore starts on a device whose state
> **nobody can vouch for**, and no amount of bookkeeping can change that.

So resume:

- is a route (`POST /api/jobs/:id/resume`, §4.9) and a button on the failed node
  in Studio, never a retry policy, never a schedule option, never something an
  unattended caller does;
- creates a new `jobs` row for the same workflow **version** (never `@latest` —
  the resolution is copied from the original row, so resume cannot silently run
  different code);
- carries forward the completed nodes' outputs from the original job's
  `job_nodes` rows, so bindings from node 1 still resolve at node 5 (§3.6);
- records `resumedFromJobId` and `resumedFromNode` on the new job's first
  `job_nodes` row, so the lineage is readable;
- marks the skipped nodes `skipped-on-resume` in the new job's rows rather than
  omitting them — a workflow's history is never a blank gap (H4);
- and the dialog says, in words, before the operator confirms: *"Nodes 1–3 will
  not run again. This device may not be in the state they left it in."*

**And the default is not to resume.** Re-running the whole workflow is the safe
answer and is one click; resume is the informed answer and is two.

**What this means for a node's side effects.** The plan owes the author one
mechanism and no more: a node may declare nothing about idempotency, because
*declaring it would not make it true*. What the plan provides instead is
information — the resume dialog names every node being skipped, with its script
and its recorded output — so the person who knows whether skipping a post is
acceptable is the one making the decision. A `node.idempotent: true` flag was
considered and rejected: it would be an unverifiable assertion by the workflow
author about someone else's script, and the only thing it could do is make the
dangerous path quieter.

### 3.6 What flows along an edge

#### Not "the previous node"

The obvious design — each node receives its predecessor's output — is rejected,
for a reason that is specific rather than aesthetic: **it makes a node's
behaviour depend on its position**, so reordering the list silently changes what
runs. In a document an operator edits by dragging rows, that is a defect
generator. And it does not even fit the owner's example: the Report node needs
node 1's *and* node 3's counts, and the gate before it needs a value from a node
that is not adjacent to it.

**Decision: a node reads any *earlier* node's output, by node id, through an
explicit binding.**

#### The binding grammar — a lookup, not a language

A node's `params` is a map from parameter name to a **value expression**, and
there are exactly four:

```ts
{ const: <json> }                       // a literal
{ param: 'keyword' }                    // a WORKFLOW parameter (§3.8)
{ from: 'scroll1', path?: 'videos' }    // an earlier node's output (whole, or one path)
{ run: 'summary' }                      // the run summary (below)
```

`path` is a **dotted path of identifier segments and non-negative integer
indices only** — `videos`, `byLabel.long`, `matches.0.author`. No wildcards, no
filters, no functions, no arithmetic, no string interpolation. It is validated by
one regex **at publish time** (never at render time, and never against
author-supplied input — F27's doctrine) and resolved by one total function.

This restraint is the whole point. The moment a binding can *compute*, it is a
language: it needs a parser, a type system, error messages, an editor, a
security review, and a story for what happens when it throws. Plan 95 refused to
evaluate an author's regular expression for exactly this family of reasons; a
workflow is not the place to reopen it.

**`{ run: 'summary' }`** exists because the owner's example has a Report node,
and a Report node wants everything. It resolves to a bounded, typed array — one
entry per completed node: `{ nodeId, script, status, startedAt, finishedAt,
durationMs, output }`. One expression form instead of a `from: '*'` wildcard, and
it is schema-describable, so plan 97's contract can type it (A1).

#### Typed or not? Both, and the difference is *when the binding is checked*

The question "is every node's output typed?" has to be answered against the
repository as it is: **the tiktok pack's `auto-scroll` returns a rich object —
`{ videos, watchSeconds, meanWatchSeconds, byLabel, backScrolls, idlePauses, … }`
— and declares no output schema, because there is no way to declare one today**
(A1/A2). A design that required declared outputs would be unusable against this
farm's only real plugin on the day it shipped. That is decisive.

**Decision:**

| The producing node | The binding is checked | Because |
|---|---|---|
| **declares** an output schema (A1) | at **publish**: a path that cannot exist in that schema is `E_WORKFLOW_BINDING_UNRESOLVABLE`, naming the node, the path, and the shape it was checked against | this is the payoff of plan 97, and it is the reason to declare an output |
| declares **nothing** (today, every script) | at **run**, when the value exists | the alternative is refusing to work with the scripts that exist |

and the editor tells the truth about which is which, per binding:
*"`tiktok/auto-scroll@1.4.0` does not declare an output — this binding cannot be
checked until it runs."*

**When a path does not resolve at run time**, the node fails with
`E_WORKFLOW_BINDING_UNRESOLVED`, and the message names the node, the path, **and
the top-level keys the output actually had** (truncated to the limits in §4.10).
Naming what was actually there is the difference between a failure someone can
fix in thirty seconds and one they fix by adding log lines. A binding may declare
`optional: true` with a `default`, in which case an unresolvable path yields the
default and records a `job_nodes` note rather than failing.

**And then the resolved params are validated anyway.** Whatever the bindings
produce goes through `validateParams` against the node script's own
`paramsSchema` (F22) before the child is spawned. So a workflow cannot feed a
node a value its schema rejects, whether the value came from a constant, a
parameter, or an output — one validator, the one that already exists.

### 3.7 Gates — evaluation without an expression language

The owner asked for *"nodes untuk … evaluasi response sebelumnya … cek apakah
pattern yang ditargetkan sudah muncul atau belum."*

**Decision: both halves of the obvious answer, unified into one node kind with
two condition sources.**

A node has `kind: 'script' | 'gate'`. A **gate** evaluates a condition over
values it *already has* — workflow parameters and earlier nodes' outputs — and
chooses one of four outcomes:

```
continue        → the next node in the list
stop            → the workflow ends SUCCESSFULLY, here
fail            → the workflow ends FAILED, with the gate's own message
goto <nodeId>   → jump (forward or backward)
```

with `then` and `else` each naming one of the four.

#### The declarative condition

A closed predicate, expressed as data and validated by Zod:

```ts
{ left: ValueExpr, op: Op, right?: ValueExpr }
{ all: [Predicate, …] } | { any: [Predicate, …] } | { not: Predicate }
```

`Op` is closed: `eq | ne | lt | lte | gt | gte | contains | notContains |
startsWith | endsWith | exists | notExists | isEmpty | notEmpty | length`. Depth
≤ 3, ≤ 20 leaves, and **no regular expressions, ever** (F27). `contains` on a
string is a plain substring test; on an array it is membership. `length` compares
an array's or string's length against a number.

That set covers the owner's stated case — *"has the targeted pattern appeared
yet"* is `{ left: { from: 'search1', path: 'matches' }, op: 'length', … }` or a
`contains` over a list — and it covers the cases the tiktok pack's actual return
values invite (`videos >= 10`, `byLabel.long > 0`, `matched notEmpty`).

#### Why not an expression language

Because it is a new untrusted-code surface with no bound, in a codebase that has
already decided this question once. Plan 95 refuses to compile an author's
regular expression *anywhere* (F27) on the grounds that JavaScript cannot bound a
match and the cost is the operator's tab or the farm. An expression evaluator is
that risk with more surface: it needs a parser, a sandbox, a timeout, a memory
bound, its own error vocabulary, and its own editor — and every one of those is a
thing to get wrong. A closed predicate over a closed operator set is checkable at
publish, renderable, bounded by construction, and explainable after the fact.

#### The escape hatch is a script, and it inherits everything

Anything the predicate cannot express is an ordinary **script node that returns a
verdict**, read by a gate:

```
node: check-quality   script: tiktok/quality-check@1.0.0
gate: enough?         { left: { from: 'check-quality', path: 'ok' }, op: 'eq', right: { const: true } }
```

That script gets crash containment, versioning, its own parameters, its own
generated form, its own timeout, its own retries, its own artifacts, and its own
place in the scripts list — for free, because it is a script. This is the
coordinator's point and it is correct: the general case belongs in the language
that already exists, not in a new one.

#### Every branch is written down

A gate's `job_nodes` row stores the **resolved left value, the resolved right
value, the operator, and the verdict**. This follows plan 94 §3.7's house rule —
*every randomised value is written down* — applied to decisions instead of
delays, and it is the difference between an operator being able to answer *"why
did it skip the Report?"* and not. The job detail renders it as one sentence:

> `enough-videos` — `scroll1.videos` (12) `>=` 10 → **continue**

A gate spawns **no child** and makes **no device call**. It is evaluated
in-process by the executor, in microseconds. A four-node pipeline with two gates
spawns four children, not six — which is worth stating because it is the reason
gates are cheap enough to use freely.

### 3.8 Workflow parameters — plan 95's vocabulary, one level up

Without them, the owner's own example is single-use: the search keyword would be
frozen into the document.

**Decision: a workflow declares parameters as *data*, and the core compiles them
to the same JSON Schema a Zod object would produce.** The compiled schema goes in
the same `scripts.paramsSchema` column (F15). From that moment the run dialog,
the schedule editor, `ParamSetPicker`, `validateParams`, `reconcileParams`,
`checkParamsSchema`, the batch form and the agent's enqueue validation all work
**with no code written for workflows at all** (F22–F26, F31).

A workflow author writes data rather than Zod because the document is edited in a
browser, not in an editor with a TypeScript compiler. The declaration is a subset
of what plan 95 already understands:

```ts
{ name: 'keyword', type: 'string', required: true,
  title: 'Search keyword', description: 'What to search for on the Discover tab.',
  hints: { kind: 'text', group: 'Search' } }
```

`hints` is plan 95's `ParamHints`, **verbatim** — the same closed `kind` set, the
same `group`, `advanced`, `labels`, `showWhen`, `source`. Nothing new is invented
and nothing is duplicated; `compileWorkflowParams` emits exactly the node
`z.toJSONSchema(…, { io: 'input' })` would emit for the equivalent Zod object, and
its test asserts that equivalence against a hand-written Zod schema.

**Binding.** A node parameter binds to a workflow parameter with
`{ param: 'keyword' }` (§3.6). Two things are checked at publish:

1. every `{ param: X }` names a **declared** workflow parameter, and
2. the workflow parameter's compiled type is **compatible** with the node
   parameter's own `paramsSchema` type at that path — a string bound to a number
   is `E_WORKFLOW_BINDING_TYPE` at publish, not a job failure at 3 a.m.

**And the thing that makes parameters actually get used: Promote.** When the
editor adds a node, every required node parameter with no default is offered
three ways — a constant, an earlier output, or **Promote to a workflow
parameter**. Promote creates a workflow parameter that **copies the node
parameter's own `title`, `description`, `hints` and default verbatim** out of the
node script's `paramsSchema`. One click, and plan 95's vocabulary carries through
to the workflow's own form with no retyping. Without this, workflow parameters
are the feature everyone skips; with it, they are the path of least resistance.

**`reconcileParams` applies unchanged**, and so does its rule (F23): a schedule
firing a workflow whose stored parameters no longer satisfy the workflow's
current schema **refuses**, naming the fields — the same code, the same message
shape, at `schedules/runner.ts:225-233`.

### 3.9 v1 is a sequence with branches — stored as a graph

#### The recommendation: not a DAG canvas

**A DAG's value is parallelism, and there is none available here.** One device,
one session, one node at a time (§3.2). A graph that can never fan out is a list
with extra edges and a worse editor. The other thing a DAG expresses —
conditional joins, `A → C` and `B → C` — is exactly what a `goto` is when there
is one execution cursor.

That argument is specific to a device farm, and it is why the usual CI-pipeline
intuition does not transfer: CI has many machines and a DAG buys real wall-clock
time; a device pipeline has one phone.

**The second argument is cost, and it is large.** Studio is schema-driven with no
hardcoded UI per component (spec §19), and a canvas is the exact opposite: node
hit-testing, pan and zoom, edge routing, auto-layout, selection and multi-select,
keyboard access, a dark-mode story, and a responsive story for a design system
built around cards and forms. Rough sizing against this repo's own components:

| | Files | New lines | Reuses |
|---|---|---|---|
| **v1 — the list editor** | ~10 | ~1 300–1 800 | `SchemaForm`, `ParamSetPicker`, `DevicePicker`, `PaginatedTable`, `ConfirmDialog`, `Select`, `Tabs` |
| a canvas, later | ~8 more | ~2 500–4 000 more | almost nothing; needs a layout algorithm |

The list editor is a **table of rows**: drag to reorder, a script+version picker
per row, a bindings sub-form per row, a gate editor for gate rows, and a
left-hand rail that draws the non-linear edges. Every one of those is a pattern
already in Studio.

#### Does it foreclose a canvas? No — and the reason is in the data model

**The document stores edges explicitly.** Array order is the *spine* — a node's
default successor is the next node in the array — and any deviation is a stated
edge: a gate's `then`/`else`, or an ordinary node's optional `next`. So the
document *is already a graph*: nodes with ids, plus a transition function. The
list is one rendering of it; a canvas would be a second rendering of the same
bytes, with **no migration and no schema bump**.

This is the design that leaves the door open at zero cost, and it is a better
data model anyway: reordering the array cannot silently rewire an explicit
branch, because explicit branches name node ids, not positions.

#### Loops, and the budget that makes them safe

A backward `goto` is genuinely wanted — *"if not enough matches yet, scroll
again"* is the owner's own example read literally — so v1 allows it. Unbounded,
it is a device-melting footgun.

**Decision: every workflow carries a `maxSteps` budget counting node
*executions*** (default 50, max 500). Exceeding it fails the job with
`E_WORKFLOW_STEP_BUDGET`, naming the node the cursor was on and how many times
each node ran. The budget is on the **document**, visible in the editor beside
the node count, and reported on the job row. Not "no loops" (which fails the
brief) and not "unbounded loops" (which is negligent) — a number someone chose,
that someone can read afterwards.

The outer backstop is separate and belongs to time, not to steps: §3.11.

### 3.10 Many devices — a workflow batch is an ordinary batch

**A workflow runs on one device per job, and across a device set exactly the way
a script does.** `POST /api/batches` takes a concrete `scriptId` (F29); a
workflow row's id is a `scripts.id`; `createBatch` writes one job per resolved
device (F28). **A "workflow batch" is therefore not a new concept and there is no
second dispatcher** — it is one workflow job per device, with
`batches.concurrency` capping how many devices run at once (F30), the per-device
queue serialising within a device, and the exec semaphore capping adb farm-wide.
Three independent limiters, all unchanged.

**In scope**, because it costs nothing: the same route, the same table, the same
status projection, the same cancel, the same rerun-failed. And plan 94's pacing,
whenever it lands, applies to a workflow batch with no work on either side,
because pacing is a property of the batch.

**Two things that are not free and are named rather than discovered:**

1. **A workflow job is long.** `batches.concurrency` and `queueTimeoutSec` were
   sized against single-script jobs. A cluster of 20 devices running a 40-minute
   pipeline at `concurrency: 1` is a 13-hour batch. The run dialog's consequence
   sentence must therefore estimate a workflow's duration (§4.11) — from the sum
   of its nodes' declared timeouts, labelled explicitly as an **upper bound**,
   because that is what it is.
2. **Rerun-failed re-runs the whole workflow, not the failed nodes.** That is
   correct — a rerun targets a *device*, and resume targets a *job* (§3.5) — but
   it is surprising enough that the button must say so.

### 3.11 Three clocks, and which one kills a workflow

A pipeline has more clocks than a script, and running them together badly is how
you get a four-hour job killed at minute five with no idea which node was stuck.

| Clock | Scope | Source | On expiry |
|---|---|---|---|
| **Node timeout** | one node's attempt | the node script's own `ScriptDefinition.timeout`, clamped by the farm's `job.maxTimeoutMs` exactly as today (plan 74) | that node fails; its `onFailure` decides |
| **Workflow budget** | the whole job | `workflow.maxTotalMs`, a new farm setting (default 6 h) | the job fails `E_WORKFLOW_BUDGET_EXCEEDED`, naming the node in flight |
| **Step budget** | the whole job | `maxSteps` on the document (§3.9) | the job fails `E_WORKFLOW_STEP_BUDGET` |

**Decision: a workflow job has no single per-attempt wall-clock timeout.** A
4-node pipeline of hour-long nodes is 4 hours, and `job.defaultTimeoutMs` is 1
hour (`settings.ts:596`) — so inheriting the script timeout would kill every
non-trivial workflow, and worse, would kill it with a message that names no node.
The node timeout is the fine-grained clock that can actually say *what* is stuck;
`workflow.maxTotalMs` is the coarse backstop that stops a runaway.

`workflow.maxTotalMs` is **separate from `job.maxTimeoutMs`** on purpose: the
latter is *"how long may one script run"* and the former is *"how long may one
device be held by one pipeline"*. They answer different questions and an operator
will want different numbers.

**Publish-time check.** The sum of a workflow's nodes' declared timeouts, times
the worst-case step count implied by `maxSteps` where a loop exists, is compared
against `workflow.maxTotalMs` at publish, and a workflow that cannot possibly
finish inside its own budget is refused with the arithmetic in the message. A
workflow that *might* not finish (because of a loop) gets a warning, not a
refusal — the budget exists precisely to bound that case.

**Known gap, recorded rather than silently unimplemented (§4.3 check 7,
`E_WORKFLOW_BUDGET_IMPOSSIBLE`): this arithmetic has no input to run on
today.** "The sum of a workflow's nodes' declared timeouts" presumes a node's
declared `timeout` is readable at publish time, from whatever `checkWorkflow`
is handed for that node's resolved script. It is not: nothing in
`ResolvedNodeScript` (§4.3's own signature) carries it, and no `scripts`
column persists a script's declared `timeout` at all — `ScriptDefinition.timeout`
lives only inside the published bundle, read by the child at its own `ready`
message, at *run* time, long after publish. Step 99.6 (see this plan's own
status line) implemented checks 1–6 and 8 of the eight and reported this
exact blocker rather than faking the check; what it CAN do without the
missing fact — cycle detection over the reachable transition graph — ships as
`W_WORKFLOW_LOOP`, a warning naming `maxSteps` as the only bound currently
enforced. **The unblock is cross-plan, not this plan's to build**: plan 98
§4.4/§5 step 98.4 ("The envelope persists") persists a script's declared
runtime — `RuntimeEnvelopeSchema`, including `timeoutMs` — onto the `scripts`
row at publish time (`scripts.runtime`), specifically so a script's declared
budget becomes readable by something other than the child itself. Once 98.4
lands, `ResolvedNodeScript` gains a `runtime.timeoutMs` (or equivalent) field
sourced from that column, and check 7's arithmetic becomes implementable
exactly as designed above — this paragraph is the forward reference; plan 98
§4.4 carries the matching note back to here.

**RESOLVED, 2026-08-13** (this paragraph is kept, not deleted, as the record of
why the gap existed and what closed it — matching this plan's own convention
elsewhere, e.g. §3.1's amended acceptance criterion 3). Plan 98 §4.4 step 98.4
landed and persists exactly the fact this paragraph asked for.
`ResolvedNodeScript.timeoutMs: number | null` now carries it, populated by
`packages/core/src/api/workflows.ts` from `ScriptEntry.runtime?.timeoutMs`.
`checkWorkflow` gained a third, optional argument, `budget?: WorkflowBudget`
(`{ maxTotalMs: number }`, resolved and passed in by the caller — never read
from a database or settings store inside `checkWorkflow` itself, keeping the
purity rule intact); when it is acyclic, the sum described above IS computed,
and `E_WORKFLOW_BUDGET_IMPOSSIBLE` fires for a document that structurally
cannot fit. One addition beyond what this paragraph anticipated: an
UNDECLARED node timeout (`timeoutMs: null`) is UNKNOWN, not zero and not the
farm default — it makes the whole sum uncheckable, reported as a new warning,
`W_WORKFLOW_BUDGET_UNKNOWN`, naming the responsible node(s), rather than
either silently passing or silently refusing on a number nobody actually
declared. The loop case above ("might not finish... gets a warning, not a
refusal") is implemented literally: a cyclic document never gets the hard
refusal, whatever the worst case, only the pre-existing `W_WORKFLOW_LOOP`.
Full reasoning, the arithmetic, and the test list are in this plan's own
`> Status:` block at the top of this document.

### 3.12 Interfaces to plans this one does not own

- **Plan 94 (recorder and pacing).** A recording publishes as an ordinary
  `scripts` row, so a recording is a **node** with no work on either side — which
  is a good joint test of both plans' central decisions. Pacing is a property of
  the batch; a workflow batch is a batch (§3.10). Plan 94 also wants intra-script
  step boundaries eventually; that is the child protocol (F12) and this plan
  deliberately leaves it untouched (§3.1).
- **Plan 95 (parameters).** Consumed wholesale and extended nowhere: the
  vocabulary (`ParamHints`), the validator, the reconciler, the limits, the form
  and the preset picker are all used as-is. The only new thing is
  `compileWorkflowParams`, which *emits* what plan 95 already reads (§3.8).
- **Plan 97 (typed output) — ASSUMPTION A1/A2.** This plan's binding checker
  reads `outputSchema` when it is there and degrades honestly when it is not. If
  plan 97 lands after this one, 99.6's publish check gains a branch and nothing
  else moves.
- **Plan 98 (runtime envelope) — ASSUMPTION A3/A4.** No interface at all for the
  runner: every node goes through `JobRunner.execute()`, so plan 98's changes
  reach workflow nodes for free. If it introduces a durable run identity,
  `job_nodes` keys on it (§4.6). **One real interface does exist, found only
  once 99.6 tried to build §4.3 check 7 and hit the wall §3.11 now records**:
  `checkWorkflow`'s `E_WORKFLOW_BUDGET_IMPOSSIBLE` check needs a node script's
  declared `timeout` readable at publish time, and nothing in this plan's own
  design persists one — plan 98 §4.4/§5 step 98.4 ("The envelope persists")
  is what would, by writing `RuntimeEnvelopeSchema` (including `timeoutMs`)
  onto the `scripts` row at publish. Check 7 stays a documented gap
  (`W_WORKFLOW_LOOP`'s cycle detection is what ships instead) until 98.4
  lands; once it does, this is a one-field addition to `ResolvedNodeScript`
  and the arithmetic §3.11 already specifies, not a redesign.
  **RESOLVED, 2026-08-13**: 98.4 landed and this WAS exactly a one-field
  addition — `ResolvedNodeScript.timeoutMs`, plus one optional argument on
  `checkWorkflow` for the farm's own `workflow.maxTotalMs` (§3.11's own
  status block has the full account).
- **Plan 93 (bulk operations).** No interface. Its bulk actions create batches;
  a workflow batch is a batch.
- **Plan 82 (plugins).** A plugin member is an ordinary `scripts` row, so a
  plugin's scripts are nodes with no work. A **plugin that ships a workflow** is
  §9 Q3, not v1.

---

## 4. Technical design

### 4.1 The workflow document — `packages/protocol/src/workflow.ts` (new)

```ts
/** A value a node parameter or a gate operand can take (plan 99 §3.6).
 *  Four forms, closed. `path` is a LOOKUP, never an expression. */
export const WorkflowPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/)

export const ValueExprSchema: z.ZodType<ValueExpr> = z.union([
  z.object({ const: z.unknown() }).strict(),
  z.object({ param: WorkflowParamNameSchema }).strict(),
  z.object({
    from: WorkflowNodeIdSchema,
    path: WorkflowPathSchema.optional(),
    optional: z.boolean().default(false),
    default: z.unknown().optional(),
  }).strict(),
  z.object({ run: z.literal('summary') }).strict(),
])

/** Closed. No regular expressions (plan 95 §3.8 R2, plan 99 §3.7). */
export const GATE_OPS = [
  'eq', 'ne', 'lt', 'lte', 'gt', 'gte',
  'contains', 'notContains', 'startsWith', 'endsWith',
  'exists', 'notExists', 'isEmpty', 'notEmpty', 'length',
] as const

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ left: ValueExprSchema, op: z.enum(GATE_OPS), right: ValueExprSchema.optional() }).strict(),
    z.object({ all: z.array(PredicateSchema).min(1).max(WORKFLOW_LIMITS.maxPredicateLeaves) }).strict(),
    z.object({ any: z.array(PredicateSchema).min(1).max(WORKFLOW_LIMITS.maxPredicateLeaves) }).strict(),
    z.object({ not: PredicateSchema }).strict(),
  ]),
)

/** Where the cursor goes next. `stop` ends the workflow SUCCESSFULLY. */
export const GateOutcomeSchema = z.union([
  z.object({ go: z.enum(['continue', 'stop', 'fail']) }).strict(),
  z.object({ go: z.literal('goto'), node: WorkflowNodeIdSchema }).strict(),
])

export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('script'),
    id: WorkflowNodeIdSchema,                  // ^[a-z0-9][a-z0-9-]*$, unique in the document
    title: z.string().max(80).default(''),
    script: ScriptRefSchema,                   // `name@version` or `name@latest` — the EXISTING grammar
    params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}),
    /** Plan 99 §3.3. Defaults to 'farm' for the FIRST node, 'none' for every other. */
    reset: z.enum(['farm', 'none']).optional(),
    /** Overrides the node script's own ScriptDefinition.retries. */
    retries: z.number().int().min(0).max(10).optional(),
    onFailure: GateOutcomeSchema.default({ go: 'fail' }),
    /** Explicit successor; absent = the next node in the array (plan 99 §3.9). */
    next: WorkflowNodeIdSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('gate'),
    id: WorkflowNodeIdSchema,
    title: z.string().max(80).default(''),
    when: PredicateSchema,
    then: GateOutcomeSchema.default({ go: 'continue' }),
    else: GateOutcomeSchema.default({ go: 'stop' }),
    /** Shown on the job row when this gate ends the workflow. */
    message: z.string().max(200).default(''),
  }).strict(),
])

export const WorkflowDocSchema = z.object({
  schema: z.literal(1),
  name: ScriptNameSchema,                      // the SAME grammar a script name uses
  version: SemverSchema,
  title: z.string().max(80).default(''),
  description: z.string().max(300).default(''),
  params: z.array(WorkflowParamSchema).max(WORKFLOW_LIMITS.maxParams).default([]),
  nodes: z.array(WorkflowNodeSchema).min(1).max(WORKFLOW_LIMITS.maxNodes),
  /** Node executions, not nodes (plan 99 §3.9). */
  maxSteps: z.number().int().min(1).max(500).default(50),
  /** Always run when the workflow ends FAILED. Stateless and idempotent, like finish() (§3.2). */
  onFail: z.object({ script: ScriptRefSchema, params: z.record(WorkflowParamNameSchema, ValueExprSchema).default({}) })
    .strict().optional(),
}).strict()
export type WorkflowDoc = z.infer<typeof WorkflowDocSchema>
```

`name` uses the **existing** script-name grammar
(`packages/protocol/src/script-ref.ts`, `ScriptRefSchema` at `:15`), including its
one-slash plugin-member rule, so a workflow name is validated by the same regex
as everything else and needs no second grammar. A workflow is not a plugin
member, so a `/` in a workflow name is refused **at the editor**, where the
operator can fix it, rather than at publish where the error would name a grammar
they have never seen (plan 94 §4.1's own precedent).

### 4.2 Workflow parameters — `packages/protocol/src/workflow-params.ts` (new)

```ts
export const WorkflowParamSchema = z.object({
  name: WorkflowParamNameSchema,            // PARAMS_LIMITS.fieldNamePattern — the SAME rule (F24)
  type: z.enum(['string', 'number', 'integer', 'boolean', 'stringList', 'numberPair']),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  title: z.string().min(1).max(PARAMS_LIMITS.maxTitleChars),
  description: z.string().max(PARAMS_LIMITS.maxDescriptionChars).default(''),
  /** Plan 95's ParamHints, VERBATIM — no fork, no subset, no extension. */
  hints: ParamHintsSchema.optional(),
  enum: z.array(z.union([z.string(), z.number()])).max(PARAMS_LIMITS.maxEnumMembers).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict()

/**
 * Emits exactly what `z.toJSONSchema(<equivalent Zod object>, { io: 'input' })`
 * emits — asserted by a test that builds both and deep-compares. This is the
 * ONE place a workflow "compiles", and it compiles to a SCHEMA, not to code.
 */
export function compileWorkflowParams(params: WorkflowParam[]): JsonSchemaNode | null
```

`io: 'input'` is not a preference — plan 95 established it as the correct mode for
a schema describing what a person **types** (`sdk/src/cli/publish.ts`'s
`z.toJSONSchema(params, { io: 'input' })`), and getting it wrong is what made a
defaulted enum publish as required and killed a job on validation before it did
anything. `compileWorkflowParams` matches that mode by construction.

The output goes through `checkParamsSchema` (F24) before it is stored, so a
workflow's generated schema is held to the same limits as a hand-written one, in
the same place, with the same error.

### 4.3 Static checking — `packages/protocol/src/workflow-check.ts` (new)

```ts
export interface WorkflowFinding {
  path: string        // 'nodes[2].params.keyword'
  code: WorkflowFindingCode
  message: string
  severity: 'error' | 'warning'
}

export type WorkflowFindingCode =
  | 'E_WORKFLOW_DUP_NODE_ID' | 'E_WORKFLOW_UNKNOWN_NODE' | 'E_WORKFLOW_FORWARD_REF'
  | 'E_WORKFLOW_UNKNOWN_PARAM' | 'E_WORKFLOW_BINDING_TYPE' | 'E_WORKFLOW_BINDING_UNRESOLVABLE'
  | 'E_WORKFLOW_NESTED' | 'E_WORKFLOW_UNREACHABLE' | 'E_WORKFLOW_BUDGET_IMPOSSIBLE'
  | 'W_WORKFLOW_UNCHECKED_BINDING' | 'W_WORKFLOW_LOOP' | 'W_WORKFLOW_LATEST_REF'

/**
 * Pure. Every finding, never the first — an author fixing a workflow gets one
 * list, not one error per round trip (plan 95 §4.2's own rule for
 * `checkParamsSchema`). `resolved` carries what the core looked up for each
 * node ref, so this function never touches a database.
 */
export function checkWorkflow(
  doc: WorkflowDoc,
  resolved: Map<ScriptRef, { name: string; version: string; kind: 'script' | 'workflow'; paramsSchema: JsonSchemaNode | null; outputSchema: JsonSchemaNode | null }>,
): WorkflowFinding[]
```

What it proves, in order:

1. node ids are unique and every `goto`/`next`/`onFailure.node` names one;
2. **`{ from: X }` names a node that can only have run EARLIER** — computed over
   the transition graph, so a binding cannot read a value that does not exist
   yet. This is a real check, not a positional one: with a backward `goto`, a
   node *after* the target in array order may legitimately be an earlier
   *execution*, and the reachability walk says so;
3. every `{ param: X }` names a declared workflow parameter, and its compiled
   type is assignable to the node parameter's own type (§3.8);
4. every `{ from: X, path: P }` against a node whose script **declares** an output
   (A1) resolves in that schema — otherwise `W_WORKFLOW_UNCHECKED_BINDING`;
5. no node's script is itself a workflow (`E_WORKFLOW_NESTED`, §2);
6. every node is reachable from node 0;
7. the timeout arithmetic of §3.11 — **implemented, 2026-08-13** (was a
   documented gap until plan 98 §4.4/step 98.4 persisted a node's declared
   `timeout` onto the `scripts` row — see §3.11's own resolution note for the
   full account): over an ACYCLIC document, the longest node-timeout-weighted
   path from node 0 is compared against a caller-supplied `workflow.maxTotalMs`
   (`checkWorkflow`'s new optional third argument), refusing with
   `E_WORKFLOW_BUDGET_IMPOSSIBLE` when it cannot fit; an undeclared node
   timeout is UNKNOWN, not zero, and degrades the whole check to a new
   warning, `W_WORKFLOW_BUDGET_UNKNOWN`, rather than a false pass or a false
   refusal; a CYCLIC document never gets the hard refusal — §3.11's own
   "might not finish gets a warning, not a refusal" — only the pre-existing
   `W_WORKFLOW_LOOP`;
8. `@latest` in a node ref is a **warning** — legal, and worth saying out loud,
   because it means the workflow's behaviour can change without the workflow
   changing.

It lives in `@enkaku/protocol` for the reason plan 95 gave for `validateParams`:
that is the only package both the core and Studio import, `bun test` covers it
from the repo root, and it is pure — so **the editor's Validate button and the
publish gate run the same function** and cannot disagree.

### 4.4 Resolution — `packages/protocol/src/workflow-resolve.ts` (new)

```ts
export interface ResolveScope {
  params: Record<string, unknown>                       // the job's params, already validated
  outputs: ReadonlyMap<string, unknown>                 // nodeId → the output of its LAST completed run
  summary: readonly RunSummaryEntry[]                   // `{ run: 'summary' }`
}

export type ResolveOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: 'unresolved' | 'no_such_node'; detail: string; sawKeys?: string[] }

/** Total. Never throws, never evaluates anything author-supplied. */
export function resolveValue(expr: ValueExpr, scope: ResolveScope): ResolveOutcome

/** Total. `undefined`/missing operands never throw; they make the comparison false
 *  except for `notExists`/`isEmpty`, which is the only sane reading. */
export function evaluatePredicate(pred: Predicate, scope: ResolveScope): { value: boolean; trace: PredicateTrace }

/** What the gate compared, for the job_nodes row and the UI sentence (§3.7). */
export interface PredicateTrace {
  op: GateOp | 'all' | 'any' | 'not'
  left?: unknown
  right?: unknown
  value: boolean
  children?: PredicateTrace[]
}
```

`sawKeys` is what makes an unresolved binding debuggable: the top-level keys the
output actually had, truncated to `WORKFLOW_LIMITS.maxSawKeys` (§3.6).

`PredicateTrace` is what makes a branch auditable (§3.7). It is bounded by the
predicate's own depth and leaf limits, so it cannot grow without bound.

### 4.5 `scripts.kind`, and the publish path

```ts
// packages/core/src/db/schema.ts — `scripts` (currently at :413)
/**
 * Plan 99 §3.1 — what `bundle` holds and which executor runs it.
 * 'script'   : an ESM bundle, run by the script executor (every row before this plan).
 * 'workflow' : a validated WorkflowDoc as JSON, run by the workflow executor.
 * Read in exactly four places (acceptance criterion 3, amended once
 * `checkWorkflow`'s nested-workflow check was built — see §3.1 "why the
 * fourth reader is legitimate"): the executor registry, the publish routes,
 * Studio's list filter, and `workflow-check.ts`'s `E_WORKFLOW_NESTED` check.
 * NOTE: the schema.ts comment this block illustrates was written when only
 * three readers existed and has not been updated to say four — out of scope
 * for this correction (schema.ts is not this pass's file to touch); a future
 * pass touching schema.ts should bring it in line with this plan.
 */
kind: text('kind').notNull().default('script'),
```

`default('script')` means every existing row is correct with no backfill, and the
migration is one `ALTER TABLE` generated by
`bun run --cwd packages/core db:generate`.

For `kind: 'workflow'`: `bundle` holds the canonical `WorkflowDoc` JSON (what the
executor parses) and `source` holds the same document pretty-printed — which is
exactly what `source`'s stated purpose already is, *"so a human can read what a
job actually ran"* (F15). `paramsSchema` holds `compileWorkflowParams`' output.
`pluginId`/`exportId` are null.

**Executor selection** is the one structural change. `ExecutorRegistry.get()` is
a synchronous map lookup with a fallback (F7); it gains a second fallback keyed
on kind:

```ts
// packages/core/src/jobs/executor.ts
/** Reserved ids stay a map lookup. Everything else asks the registry what KIND
 *  the row is — one call, cached per scriptId, invalidated with the script
 *  registry's own cache. Plan 99 §3.1: this is the ONLY place the union lives
 *  in the execution path. */
get(scriptId: string, kind: ScriptKind = 'script'): JobExecutor | null
```

with `ExecutorHost` passing the kind it already read from the row. A workflow id
that reaches `get()` with `kind: 'script'` — impossible through the host, but
reachable by a caller that forgot — gets the script executor and fails cleanly on
a bundle that is not JavaScript, rather than silently doing something strange.

**Publish** is a separate route because the body is a different thing:

```
POST /api/workflows            script.publish   { doc: WorkflowDoc }
```

It resolves every node ref through `ScriptRegistry.resolve()` (F17), runs
`checkWorkflow` (§4.3), compiles the params (§4.2), runs `checkParamsSchema`
(F24), and then calls the **same** `publishScript()` (F16) every other publish
path calls — so `script_version_exists`, the `(name, version)` unique index, the
audit entry and the mutation-token guard are all inherited rather than
reimplemented. One writer of `scripts` rows, as today.

### 4.6 `job_nodes` — where a workflow's history lives

```ts
/**
 * One row per NODE EXECUTION within a workflow job (plan 99 §3.5, H4).
 * Not one row per node: a loop runs a node several times and each run is a
 * fact. Modelled on `schedule_runs`, which writes a row for every fire
 * decision including the ones that ran nothing, "so a schedule's history is
 * never a blank gap" (spec §12.3).
 */
export const jobNodes = sqliteTable(
  'job_nodes',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    /** 0-based execution order within this job. A loop makes this exceed the node count. */
    seq: integer('seq').notNull(),
    /** The document's node id. */
    nodeId: text('node_id').notNull(),
    kind: text('kind').notNull(),                    // 'script' | 'gate'
    /** Resolved at execution, never `@latest` — what actually ran. Null for a gate. */
    scriptId: text('script_id'),
    scriptName: text('script_name'),
    scriptVersion: text('script_version'),
    status: text('status').notNull(),                // running|success|failed|skipped|skipped-on-resume|cancelled
    /** Attempts spent on THIS execution (the node's own retries). */
    attempts: integer('attempts').notNull().default(0),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    /** The node's return value, size-capped (§4.10). Null for a gate. */
    output: text('output', { mode: 'json' }),
    /** Set when `output` was too large to store: the cap, and what was dropped. */
    outputTruncated: text('output_truncated'),
    /** A gate's PredicateTrace and the branch it took (§3.7, §4.4). Null for a script node. */
    verdict: text('verdict', { mode: 'json' }),
    error: text('error'),
    errorCode: text('error_code'),
    /** Set on seq 0 of a resumed job (§3.5). */
    resumedFromJobId: text('resumed_from_job_id'),
    resumedFromNode: text('resumed_from_node'),
  },
  (t) => [
    uniqueIndex('idx_job_nodes_seq').on(t.jobId, t.seq),
    index('idx_job_nodes_job').on(t.jobId, t.nodeId),
  ],
)
export type JobNodeRow = typeof jobNodes.$inferSelect
```

**ASSUMPTION A4:** if plan 98 introduces a durable per-run identity below the
job, `jobId` here becomes that identity and `idx_job_nodes_seq` keys on it. That
is a column rename in one file plus one migration; nothing in §4.7 depends on
which of the two it is.

Artifacts gain one nullable column so a node's screenshots are groupable without
moving a file or renumbering anything (F32):

```ts
// packages/core/src/db/schema.ts — `artifacts` (currently at :488)
/** Plan 99 §3.2 — the workflow node that produced this artifact. Null for
 *  every artifact of a non-workflow job, which is every row before this plan. */
nodeId: text('node_id'),
```

The runner learns nothing about nodes: the **executor** sets the current node id
on the `ArtifactSink` wrapper it hands the runner, so `artifact.save` at the child
boundary is untouched.

### 4.7 The workflow executor — `packages/core/src/jobs/executors/workflow.ts` (new)

```ts
export interface WorkflowExecutorDeps {
  db: Db
  registry: ScriptRegistry
  runner: JobRunner
  sessions: SessionManager
  artifacts: (jobId: string) => ArtifactSink
  settings: () => WorkflowSettings
  log: Logger
  onNode: (jobId: string, node: JobNodeProgress) => void   // → WS `job.status`
}

export function createWorkflowExecutor(deps: WorkflowExecutorDeps): JobExecutor
```

`validateParams(params, scriptId)` reads the workflow row's `paramsSchema` and
calls `validateParams` (F22) — byte-identically to what the script executor does,
so a bad workflow parameter is refused at enqueue, before a device is leased,
whether the caller is a job, a batch, a schedule or an agent.

`run(job, ctx)` is the interpreter, and it is a loop over a cursor:

```
parse doc from scripts.bundle          (Zod — never trust a stored blob, 00-overview §4.2)
session = sessions.acquire(deviceId)   ← ONE acquire for the whole workflow (F11, H1)
try {
  scope = { params: job.params, outputs: resumeOutputs ?? new Map(), summary: [] }
  cursor = resumeAt ?? nodes[0].id
  for (steps = 0; cursor && steps < doc.maxSteps; steps++) {
    ctx.signal.throwIfAborted()
    if (Date.now() - startedAt > settings().maxTotalMs) throw E_WORKFLOW_BUDGET_EXCEEDED(cursor)
    node = byId(cursor)
    write job_nodes row (status 'running')  → onNode → WS
    if (node.kind === 'gate') {
      { value, trace } = evaluatePredicate(node.when, scope)
      persist trace + verdict; cursor = follow(value ? node.then : node.else)
      continue                              ← no child, no device call (§3.7)
    }
    entry  = registry.resolve(node.script)             (F17)
    params = resolve every binding (§4.4) → validateParams(entry.paramsSchema, …)   (F22)
    result = await runner.execute({
      id: job.id,                                       ← the SAME job id (§3.2)
      deviceId: job.deviceId,
      bundlePath: await registry.bundlePath(entry),
      params,
      scriptExportId: entry.exportId ?? undefined,
      reset: node.reset ?? (steps === 0 ? 'farm' : 'none'),   ← §3.3, §4.8
      nodeId: node.id,                                        ← §4.8, closes F20
      retries: node.retries,                                  ← §4.8
    })
    persist output (capped) + status; scope.outputs.set(node.id, result.value)
    cursor = result.ok ? follow(node.next ?? nextInArray) : follow(node.onFailure)
  }
  if (steps >= doc.maxSteps) throw E_WORKFLOW_STEP_BUDGET(cursor)
} finally {
  if (failed && doc.onFail) run the cleanup node, best-effort, once     (§3.2)
  mark every never-reached node 'skipped'
  sessions.release(deviceId)
}
```

Five properties worth naming because they are the design, not the code:

- **The session is acquired once** and every node's inner acquire/release is a
  refcount bump (F11). This is H1's mechanism.
- **A gate spawns nothing.** No child, no adb call, no stream-lane slot.
- **Every transition is persisted before it is taken**, so a core crash leaves a
  readable record and resume has something to read.
- **`ctx.signal` is checked at every step boundary** and `runner.execute()`'s own
  abort path handles a cancel mid-node — the escalation already exists, twice
  over (`ExecutorHost`'s grace, then the runner's SIGTERM/SIGKILL ladder).
- **The `finally` block is the only place the session is released**, so no early
  return can strand it.

### 4.8 What the runner gains — three optional fields on `JobSpec`

```ts
// packages/session/src/runner/job-runner.ts — JobSpec (currently at :67)
/**
 * Plan 99 §3.3. 'farm' (the default, and today's behaviour exactly) runs the
 * pre-job reset per `job.resetPolicy`; 'none' skips it, the same way a
 * `finish-only` attempt already does and for a related reason — a workflow
 * node after the first needs the state a reset would wipe.
 */
reset?: 'farm' | 'none'

/**
 * Plan 99 §3.2. The workflow node this execution belongs to. Threaded into
 * the child's `init` and into `ctx.jobs.trigger()`'s default idempotency key,
 * because several nodes share one `jobId` and one `attempt` counter and would
 * otherwise derive colliding keys (plan 99 F20).
 */
nodeId?: string

/** Plan 99 §3.5 — overrides `ScriptDefinition.retries` for this execution. */
retries?: number
```

Three touch points, each one condition beside a condition that already exists:

1. `job-runner.ts`'s `afterReady` (currently at `:383`) gains
   `if (job.reset === 'none') { sendInit(); return }` beside the `finish-only`
   branch that is already there, with the same reason written next to it (F14).
2. `ipc.ts`'s `init` message carries `job.nodeId?: string`, and
   `jobs-client.ts:119`'s derivation becomes
   `` `${job.id}:${job.nodeId ?? ''}:${job.attempt}:${idx}` `` — closing F20. A
   standalone job has no `nodeId`, so its keys keep the exact shape they have
   today and no stored `trigger_key` changes meaning.
3. The retry loop reads `job.retries ?? meta.retries` instead of `meta.retries`.

**Nothing else in the runner changes**, and `packages/session` learns no workflow
concept: it learns "this execution may skip the reset", "this execution has a
name", and "this execution's retry budget may be overridden". All three are
useful outside workflows, which is the test for whether a seam is honest.

### 4.9 Protocol and API surface

```ts
// ServerMessage — job.status gains one optional block (F12)
phase: /* unchanged */,
node: z.object({
  id: z.string(),
  seq: z.number().int(),
  total: z.number().int(),          // the document's node count, not the step budget
  kind: z.enum(['script', 'gate']),
  script: z.string().nullable(),    // 'tiktok/auto-scroll@1.4.0'
  status: JobNodeStatusSchema,
}).nullable().optional(),           // absent for every non-workflow job
```

Additive and nullable, so every existing `job.status` payload keeps parsing
unchanged.

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/api/workflows` | `script.publish` | `{ doc }` → the `scripts` row. `400 E_WORKFLOW_INVALID` with **every** finding (§4.3) |
| `POST` | `/api/workflows/validate` | `script.view` | `{ doc }` → `WorkflowFinding[]`. The editor's Validate button; the same function the publish gate runs |
| `GET` | `/api/workflows/:name/versions` | `script.view` | thin alias over the existing script versions route, for the editor's "start from" picker |
| `GET` | `/api/scripts` | unchanged | gains `kind` on each row and an optional `?kind=` filter |
| `GET` | `/api/scripts/:id` | unchanged | a workflow row returns the parsed `WorkflowDoc` in a `workflow` field beside `source` |
| `GET` | `/api/jobs/:id/nodes` | `job.view` | `{ items: JobNodeInfo[] }` — the node timeline |
| `POST` | `/api/jobs/:id/resume` | `job.run` + `canCancelJob`-style device check | `{ fromNode }` → a new job (§3.5). `409` if the job is not terminal, `400` if `fromNode` never ran or is unreachable |

`GET /api/scripts`'s response shape gains one field rather than a second
endpoint, because F31's dialog reads one list and a second list would mean a
second empty state, a second pagination story and a second cache.

### 4.10 Limits and settings

```ts
// packages/protocol/src/workflow.ts
export const WORKFLOW_LIMITS = {
  maxNodes: 50,
  maxParams: 40,                 // PARAMS_LIMITS.maxFields is 200; a FORM of 40 is already a lot
  maxDocBytes: 128 * 1024,       // 2x PARAMS_LIMITS.maxSchemaBytes — a doc holds a schema plus nodes
  maxPredicateDepth: 3,
  maxPredicateLeaves: 20,
  maxNodeOutputBytes: 256 * 1024,   // matches shell.maxOutputBytes' 262_144 (settings.ts)
  maxRunSummaryBytes: 512 * 1024,   // `{ run: 'summary' }`, across all nodes
  maxSawKeys: 20,                   // keys named in an unresolved-binding message (§3.6)
} as const
```

```ts
// packages/protocol/src/settings.ts — a new top-level block
workflow: z.object({
  maxTotalMs: z.number().int().min(60_000).max(86_400_000).default(21_600_000)
    .describe('How long one workflow may hold a device before it is failed. Separate from a single script\'s timeout: this is the whole pipeline.')
    .meta(ui({ title: 'Workflow budget', kind: 'duration', unit: 'h', group: 'Workflows' })),
  maxNodeOutputBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(262_144)
    .describe('How much of a node\'s returned value is kept for later nodes to read. Anything larger is truncated and the truncation is recorded.')
    .meta(ui({ title: 'Node output kept', kind: 'bytes', group: 'Workflows' })),
}).default({ maxTotalMs: 21_600_000, maxNodeOutputBytes: 262_144 }),
```

Both carry plan 95 `ui()` hints, so they render as a duration control and a byte
control in Settings with no Studio change — which is the multiplier plan 95 was
built for.

### 4.11 Studio

- **`/workflows`** — the list. `GET /api/scripts?group=name&kind=workflow`, the
  same grouped shape the scripts list already renders, plus node count, last run,
  and a **New workflow** button.
- **`/workflows/editor?name=…`** — the editor (§3.9). Node rows with drag-reorder;
  a branch rail on the left drawing every explicit edge; per-row: script + version
  picker (reusing the run dialog's `groupByName`/`groupByPlugin`), a bindings
  sub-form, the plain-language `starts from:` line (§3.3), and `onFailure`. A gate
  row gets the predicate editor — a small bespoke control, because plan 95's
  resolver maps a multi-branch union to a raw JSON textarea (`plan.ts`'s
  precedence row for `anyOf`/`oneOf` with several real branches), and a JSON
  textarea is not an editor. **This is stated rather than glossed: the predicate
  is the one thing in this plan that does not render for free.** Its *schema* is
  still the contract and is still validated by Zod at every boundary.
- **The Promote affordance** (§3.8) on every unbound required node parameter.
- **Validate** — one button, `POST /api/workflows/validate`, findings inline on
  the rows they belong to, warnings visually distinct from errors.
- **The run dialog** (F31) gains a segmented control above the script picker —
  **Workflow | Script** — filtering the one list it already loads. Choosing
  *Workflow* with none published shows the empty state and a link straight to the
  editor, which is the owner's *"kalau belum ada, bisa langsung ke workflow
  editor."* Everything below the picker — version, `ParamSetPicker`, `SchemaForm`,
  target, concurrency, order — is untouched.
- **The consequence sentence** gains a duration estimate for a workflow:
  > *4 nodes, up to about 42 min per device — 5 devices, one at a time — up to about 3 h 30 m.*

  with *up to* meaning it: the number is the sum of the nodes' declared timeouts
  (§3.10), and the copy says "up to", not "about", because an upper bound
  presented as an estimate is a lie.
- **Job detail** gains a **node timeline** above the log: one row per `job_nodes`
  row — node, script@version, status, duration, attempts, a gate's verdict
  sentence (§3.7), the node's artifacts, and **Resume from here** on the failed
  node (§3.5), whose dialog names every node that will be skipped.
- **The device page's job list and the Wall** show `workflow · node 2/4` on a
  running workflow job, from `job.status`'s new `node` block.

---

## 5. Implementation steps

### 5.0 Order, and why

99.1–99.3 are pure `@enkaku/protocol` and are testable with `bun test` from the
repo root, with no device, no core and no DOM. 99.4 is the runner seam and is
independently useful. 99.5–99.7 make a workflow publishable and runnable. 99.8–99.10
are Studio. 99.11 is the measurement. **Do not start 99.8 before 99.6 is green** —
an editor written against an unvalidated document shape is the one way this plan
produces a screen nobody can trust.

### 99.1 — The document, the limits, and the value grammar

- [x] `packages/protocol/src/workflow.ts`: `WorkflowDocSchema`, `WorkflowNodeSchema`,
      `ValueExprSchema`, `PredicateSchema`, `GateOutcomeSchema`, `GATE_OPS`,
      `WORKFLOW_LIMITS`, and the id/name/path regexes (§4.1, §4.10). Exported from
      `packages/protocol/src/index.ts`.
- [x] Reuse, never re-declare: `ScriptRefSchema` for node refs, `PARAMS_LIMITS`'
      `fieldNamePattern` for parameter names (via `WorkflowParamNameSchema` in
      `workflow-params.ts`, §99.2), `ParamHintsSchema` for hints. Note: no
      standalone `ScriptNameSchema`/`SemverSchema` existed in `script-ref.ts` to
      import (confirmed by search — only one monolithic `ScriptRefSchema` regex,
      never split); `WorkflowNameSchema`/`WorkflowVersionSchema` duplicate the
      two halves of that grammar locally, by the same precedent plan 94 §4.1
      already set for a recording's name, with a doc comment explaining why.
- [x] **Verifiable result — confirmed by `workflow.test.ts`:** a hand-written
      document with four SCRIPT nodes plus one GATE (five nodes total — the
      owner's own example, §0) round-trips through `WorkflowDocSchema.parse` and
      through JSON; a duplicate node id, a 51-node document, a `ValueExpr` path
      containing `[0]` or `*`, a predicate four levels deep (refused with a
      message literally naming the depth and the limit), and an operator outside
      `GATE_OPS` are each refused with Zod issues naming what was wrong.

### 99.2 — Parameters compile to a schema

- [x] `packages/protocol/src/workflow-params.ts`: `WorkflowParamSchema`,
      `compileWorkflowParams` (§4.2).
- [x] The equivalence test: build a Zod object by hand for every `type`, run
      `z.toJSONSchema(…, { io: 'input' })`, and deep-compare against
      `compileWorkflowParams`. **This test is the contract**, and it is what stops
      the workflow form drifting from the script form. `compileWorkflowParams`
      is implemented by literally constructing the equivalent `z.object({...})`
      internally and delegating to `z.toJSONSchema(..., { io: 'input' })` —
      byte-identical output by construction, not by convention.
- [x] **Verifiable result — partially confirmed, one part out of this step's file
      ownership:** `workflow-params.test.ts` confirms a compiled schema passes
      `checkParamsSchema` with no findings. `planForm()` plans every field to a
      real control, and `applyDefaults` seeds a defaulted field, are Studio-side
      claims (`packages/studio/src/components/schema-form/plan.ts`) that a
      `packages/protocol`-only test cannot exercise without crossing the
      package boundary the wrong direction (protocol must not depend on
      studio) — left for step 99.9 (the editor) to confirm from Studio's own
      test suite, once `compileWorkflowParams`'s output actually reaches a
      `SchemaForm`.

### 99.3 — Resolution and evaluation

- [x] `packages/protocol/src/workflow-resolve.ts`: `resolveValue`,
      `evaluatePredicate`, `PredicateTrace` (§4.4).
- [x] Totality tests: every operator against `undefined`, `null`, `NaN`, an empty
      array, a nested object and a number-vs-string mismatch. Nothing throws,
      ever — asserted directly (a full cross-product matrix over all of
      `GATE_OPS`) and via the deliberately-not-null-checked `resolvePath`
      walk.
- [x] `sawKeys` is populated and truncated on an unresolved path.
- [x] **Verifiable result — confirmed by `workflow-resolve.test.ts`:**
      `evaluatePredicate` returns a trace whose resolved operands (plus the
      static predicate/outcome the caller already holds) render the sentence
      `scroll1.videos (12) >= 10 → continue`; a predicate over a node that never
      ran is `false` with a named reason on `trace.leftUnresolved` (e.g.
      `"scroll1" has not run — there is no recorded output for it..."`), never an
      exception.

### 99.4 — The runner seam (fixes F20; enables §3.3) — DONE

- [x] `packages/session/src/runner/job-runner.ts`: `JobSpec.reset`, `.nodeId`,
      `.retries` (§4.8); the `reset === 'none'` branch in `afterReady`; the retry
      budget reads `job.retries ?? meta.retries`.
- [x] `packages/session/src/runner/ipc.ts`: `init.job.nodeId?`.
- [x] `packages/session/src/runner/child-entry.ts`: pass `nodeId` into
      `createJobsApiFor`.
- [x] `packages/session/src/runner/jobs-client.ts`: the key becomes
      `` `${job.id}:${job.nodeId ?? ''}:${job.attempt}:${idx}` ``.
- [x] **Verifiable result — confirmed by `job-runner.test.ts`, `ipc.test.ts`,
      `jobs-client.test.ts`:** a job spec with `reset: 'none'` produces **no**
      `reset` phase and no device event even when the farm policy is `'home'`
      (`job-runner.test.ts`'s `job.reset "none"` describe block), while the
      same spec without the field behaves exactly as before (reset still
      runs); two executions sharing one `jobId`/`attempt` with different
      `nodeId`s each derive a DIFFERENT default trigger key
      (`job-1:scroll1:1:0` vs `job-1:search1:1:0`) instead of colliding on the
      pre-plan-99 shape (`jobs-client.test.ts`'s "closes F20" describe block,
      which asserts `new Set(keys).size === 2` — a test that fails on the old
      `${jobId}:${attempt}:${idx}` key shape by construction, since both
      would derive `job-1:1:0`). `retries` override and `nodeId`
      passthrough into `init.job` are each covered by their own test.
      **Not yet producer-wired**: `reset`/`nodeId`/`retries` are read by the
      runner but nothing sets them on a `JobSpec` yet — the sole caller of
      `runner.execute()` today, `packages/core/src/jobs/executors/script.ts`,
      predates this step and passes none of the three. They become live only
      when 99.7's workflow executor calls `runner.execute()` with them
      (§4.7's pseudocode already shows the call). Recorded here so this seam
      is never mistaken for "workflows can suppress a reset today" — they
      cannot, until 99.7 lands.

### 99.5 — `scripts.kind`, `job_nodes`, `artifacts.nodeId` — DONE

- [x] `packages/core/src/db/schema.ts`: `scripts.kind` (`text NOT NULL DEFAULT
      'script'`, `.$type<ScriptKind>()` — compile-time only, never a runtime
      validation, since this column is written only by application code, not
      untrusted input), `jobNodes` (§4.6, all nineteen columns, both indexes),
      `artifacts.nodeId`. Then `bun run --cwd packages/core db:generate`
      produced `drizzle/0044_huge_sandman.sql` with no TTY prompt — it is a
      pure addition (one new table, two new columns), never a rename, so the
      hand-written-migration trap this step's brief warns about (plans 61/62,
      `migration-watermark.test.ts`) did not apply here.
- [x] `packages/core/src/jobs/executor.ts`: `get(scriptId, kind)` (§4.5). The
      single `fallback` field became a `Map<ScriptKind, JobExecutor>`, and
      `setFallback` gained the same optional `kind = 'script'` parameter, so
      both of `daemon.ts`'s existing single-argument `setFallback(...)` calls
      (left **untouched** — `daemon.ts` is outside this step's file list)
      keep registering the `'script'` fallback exactly as before.
- [x] `packages/core/src/scripts/registry.ts`: `ScriptEntry.kind`, carried
      from the row with no comparison of its own (`kind: row.kind`, made safe
      by the schema's own `.$type<ScriptKind>()` rather than an `as`-cast); a
      dev entry is hardcoded `kind: 'script'` (there is no dev workflow
      build, §2 non-goals). `ScriptRegistry.resolve` otherwise unchanged, as
      specified — it does not read `kind` at all.
- **Verifiable result — confirmed:** `packages/core/src/db/scripts-kind-migration.test.ts`
      builds a database up to (but not including) migration `0044`, inserts a
      `scripts` row through raw SQL at a point where the `kind` column does
      not exist in that database yet, migrates the rest, and asserts the row
      reads `kind: 'script'` with no application code ever touching it — the
      literal "no backfill" claim, checked against the column default rather
      than trusted by inspection. The same file also asserts `job_nodes`
      exists and `artifacts` carries `node_id` on a freshly-migrated database.
      `packages/core/src/jobs/executor.test.ts` (new) asserts
      `ExecutorRegistry.get(id, 'script')` is reference-identical to
      `get(id)` for every combination of a built-in id, a registered
      fallback, and no fallback at all — the step's other verifiable result,
      literally. `packages/core/src/scripts/registry.test.ts` gained three
      cases: a row inserted with no `kind` (the `publish()` test helper never
      sets it) resolves `kind: 'script'` through both `get()` and
      `resolve()`; a row inserted with `kind: 'workflow'` carries that
      through both unchanged; a dev entry is always `'script'`.
      **Collateral, fixed in the same step:** `scripts.kind` being `NOT NULL`
      forced two pre-existing test files that build a fully-typed `ScriptRow`/
      `ScriptEntry` object literal to add the new field —
      `packages/core/src/scripts/bundle-cache.test.ts`'s `row()` helper and
      `packages/core/src/jobs/jobs-runner-port.test.ts`'s `fakeRegistry` —
      both one-line additions, not logic changes; `bash scripts/typecheck.sh`
      was RED across the `core` package before these two lines and is green
      after.
      **Containment (acceptance criterion 3):** a repo-wide search for the
      literal comparison against `'workflow'` (`grep -rn "kind === 'workflow'"`)
      returns matches in exactly `packages/core/src/jobs/executor.ts`'s own
      doc comment and nowhere else this step touches — `registry.ts` was
      deliberately written to carry the value (`kind: row.kind`) rather than
      compare it, precisely so it would NOT show up in that search; the
      schema's own `.$type<ScriptKind>()` is what makes that possible without
      an `as`-cast. **No producer for `job_nodes` or `artifacts.nodeId`
      yet** — both are read/written only starting at 99.7's workflow
      executor. `scripts.kind` DOES have a producer (every row, via the
      column default) and a reader (`ExecutorRegistry.get`), but nothing
      writes `kind: 'workflow'` until 99.6's publish route exists — recorded
      here, and in `docs/plans/00-overview.md` §9, so neither column is
      mistaken for a working feature before its own step lands.

### 99.6 — Static checking and publish — DONE

- [x] `packages/protocol/src/workflow-check.ts`: `checkWorkflow` (§4.3), checks 1–6
      and 8 of the eight, every finding returned rather than the first. Check 7
      (timeout arithmetic) is a documented, reported gap — see the plan's own
      status line above — implementable only as far as `W_WORKFLOW_LOOP` (cycle
      detection) without a producer for a node's declared timeout, which exists
      nowhere in the tree today.
- [x] `packages/core/src/api/workflows.ts`: `POST /`, `POST /validate`,
      `GET /:name/versions`; mounted OPTIONALLY in `http.ts` (`daemon.ts` was held
      by a concurrent worker all step — see the status line for the exact wiring
      gap and its self-detecting test). Publish resolves refs through
      `ScriptRegistry`, compiles params, runs `checkParamsSchema`, and delegates
      the write to the existing `publishScript()` (§4.5).
- [x] `packages/core/src/scripts/routes.ts`: `kind` on the list and detail
      projections; `?kind=` filter; a workflow's parsed doc on the detail response.
- **Verifiable result — confirmed:** publishing the owner's four-node example
      produces a `scripts` row indistinguishable from a hand-written script's to
      every existing consumer (`workflows.test.ts`); a document binding to a node
      that runs later is refused with `E_WORKFLOW_FORWARD_REF` naming both nodes
      (`workflow-check.test.ts` and `workflows.test.ts`, both); a document naming
      another workflow as a node is refused with `E_WORKFLOW_NESTED`
      (same two files). See the plan's own status line for the full account,
      including one honest gap (check 7) and one containment breach
      (`E_WORKFLOW_NESTED`'s comparison, a genuine fourth reader of
      `kind === 'workflow'`) found and reported rather than hidden.

### 99.7 — The workflow executor — DONE

- [x] `packages/core/src/jobs/executors/workflow.ts` (§4.7).
- [x] `packages/core/src/daemon.ts`: construct it, register it as the
      `kind: 'workflow'` executor beside the script executor's fallback.
- [x] `packages/core/src/runner/artifact-store.ts`: a node-scoped `ArtifactSink`
      wrapper that stamps `nodeId`; the child boundary is untouched.
- [x] `packages/protocol/src/messages/job.ts`: `job.status`'s `node` block (§4.9).
- **Verifiable result — confirmed, against the REAL claim path:** a three-node
      workflow on one device produces one `jobs` row, one lease held end to end
      (the same `jobId` throughout `LeaseManager.getLease`), one real session
      BUILD (a refcounting fake distinguishes it from the three per-node
      refcount bumps), three `job_nodes` rows and three real child spawns;
      the device row reads `busy` for the whole pipeline and a second job
      queued on the same device is refused by the real `claimNext()` SQL
      until the workflow settles — see the plan's own status line above for
      the full account, including one honest, unfixed gap in a file this
      step does not own (`executor-host.ts` does not yet pass a job's script
      `kind` to `ExecutorRegistry.get`, pinned self-detectingly in
      `packages/core/src/jobs/executor-kind-dispatch.test.ts`, verbatim fix
      in that file's own doc comment) and two documented deviations from
      §4.7's literal interface (`nodeTracker` instead of a per-call
      `artifacts` factory; `workflow.maxTotalMs` as a literal constant
      instead of a new `settings.ts` block, deferred because that file
      carried an unrelated ~1,235-line concurrent diff at the time).

### 99.8 — Resume, and the node timeline API — DONE (the interpreter gap below was closed 2026-08-13)

- [x] `packages/core/src/api/jobs.ts`: `GET /:id/nodes`, `POST /:id/resume` (§4.9).
- [x] Resume copies the original job's **resolved** `scriptId` (never
      re-resolving `@latest`) — proved against a real published workflow row
      in `jobs-workflow-resume.integration.test.ts`. **"Replays completed
      outputs into the scope" and "writes `resumedFromJobId`/`resumedFromNode`
      on seq 0" are NOT done** — see the gap below; both are jobs the
      INTERPRETER (`jobs/executors/workflow.ts`, outside this step's file
      list) would have to do, and it does neither today.
- [x] Boot sweep: a workflow job left `running` by a crash is failed by the
      existing `failOrphanRunning`, and its `job_nodes` rows are left intact —
      asserted in `job-store.test.ts`'s `failOrphanRunning leaves job_nodes
      intact` describe block, written so it fails BY NAME the day a cascade
      delete is ever added (there is none today).
- **Verifiable result — the route half, confirmed against real rows:**
      `jobs-workflow-resume.integration.test.ts` runs a real 3-node workflow
      (a, b succeed; c fails) through the REAL, untouched
      `createWorkflowExecutor`, then hits `GET /:id/nodes` and
      `POST /:id/resume` through a REAL `Hono` app built from
      `createJobRoutes`/`createJobService`/`createJobStore` — not fixtures
      shaped by this step. `GET /:id/nodes` reads back the exact three rows
      (`a`/`b` success with their real bound output, `c` failed with its
      structured error) plus `finalized: true`. `POST /:id/resume` with
      `fromNode` omitted defaults to `"c"` (the last node the job actually
      attempted, since it did not succeed); with an explicit `fromNode` it
      overrides the default; a name that never ran is `400
      job_node_not_found`; a still-running job is `409 job_not_terminal`. The
      new job's `scriptId` is byte-identical to the original's, and
      `job_resumes` (a new side table, migration `0047_dear_quasar.sql`)
      correctly records `{ resumedFromJobId, resumedFromNode }`.
      **"Killing the core during node 3 of 5 and resuming from node 3 with
      node 1/2's outputs resolvable" — the INTERPRETER half — was the gap
      below; closed 2026-08-13 (see the plan's own status block above for the
      full account) in `packages/core/src/jobs/executors/workflow.ts` alone —
      no edit to this step's own files was needed or made.**

### 99.9 — The editor

- [x] `packages/studio/src/app/workflows/page.tsx` — the list.
- [x] `packages/studio/src/app/workflows/editor/page.tsx` plus
      `packages/studio/src/components/workflow/` — node rows, drag-reorder, the
      branch rail, the script+version picker, the bindings sub-form, the `starts
      from:` line, `onFailure`, the parameter editor, Promote, and Validate.
- [x] `packages/studio/src/components/workflow/PredicateEditor.tsx` — the one
      bespoke control (§4.11), with its reason in the file's doc comment.
- **Verifiable result:** an operator builds the owner's example — Scroll FYP →
      Search → Scroll FYP → Report, with a gate before Report — without typing JSON
      anywhere, and Validate reports the two `@latest` warnings and nothing else.
      **Done, with one disclosed adjustment** — see this step's own status
      paragraph above for why the byte-identical owner's-example predicate
      (which loops and reads a node's output) cannot ALSO land on exactly two
      findings against today's real farm, and what was built instead to keep
      the claim literal rather than approximate.

### 99.10 — The run dialog, the job page, and the wall

- [x] `packages/studio/src/components/RunScriptDialog.tsx`: the **Workflow |
      Script** segmented filter, the empty state linking to the editor, and the
      duration estimate in the consequence sentence (§4.11).
- [x] `packages/studio/src/app/jobs/detail/page.tsx`: the node timeline, the gate
      verdict sentence, per-node artifacts, **Resume from here** and its dialog.
- [x] `packages/studio/src/components/JobsList.tsx` and the wall tile: `node 2/4`
      from `job.status`.
- **Verifiable result:** running a workflow from the device page, watching the
      node counter advance live, and — after a deliberate failure — reading which
      node failed and why **without opening the log**. **Done for the run dialog
      and the job page; the wall tile is READY but not yet fed live data — see
      this step's own status paragraph above for the one-file gap in
      `app/page.tsx`, outside this step's scope, with the verbatim fix.**
      Running a workflow against a real device and observing this end to end is
      99.11's own territory (hardware), not re-attempted here.

### 99.11 — The measurements (settles §0.3)

- [ ] H1: a 4-node workflow vs the same 4 scripts as 4 jobs, on one device, 5
      repetitions each. Record total wall time, session builds, child spawns, and
      the per-node overhead.
- [ ] H2: `tiktok/auto-scroll` → `tiktok/searched-follow` with `reset: 'none'`, 10
      runs × 3 devices. Record how many times node 2 began on the feed.
- [ ] H3: build the owner's example verbatim and record every concept it needed
      that this plan does not have.
- [ ] H4: fail a workflow deliberately and answer the four questions of §0.3 from
      the UI alone.
- **Verifiable result:** §7.3's table is filled in. An empty cell is a
      measurement not taken, not a passed one.

### 99.12 — Documentation and the spec — DONE (except one row explicitly out of file-scope)

- [x] `packages/protocol/README.md` (new — did not exist before this step): the
      document, the value grammar (the four `ValueExpr` forms), the predicate
      grammar (`GATE_OPS`, `all`/`any`/`not`), and — stated as its own section,
      per this step's own brief — the rule that neither grammar ever evaluates
      author-supplied code, what to do instead (a script node returning a
      verdict), and why (the same doctrine plan 95 already applied to
      `pattern`).
- [x] `packages/core/README.md`: a new "Workflows" section (appended after the
      pre-existing Co-control section, matching that section's own citation
      style) — the executor (one job/one lease/one session for the whole
      pipeline, a gate spawning no child), the four-file `scripts.kind`
      containment claim stated as falsifiable, `job_nodes` (one row per
      execution, written before the cursor moves), resume (the pre-job reset
      still firing on the first real execution after a resume; the resolved
      `scriptId` copied rather than re-resolved; `skipped` vs
      `skipped-on-resume`), `E_WORKFLOW_BUDGET_IMPOSSIBLE` now being live
      (unblocked by plan 98's `scripts.runtime`) with `W_WORKFLOW_BUDGET_UNKNOWN`
      for an undeclared node timeout, the two new `workflow.*` settings, and
      what still does not work (cloud-device workflows; the pre-existing
      `api/jobs.ts` schema collision, confirmed still present at
      `jobs.ts(229,49)` by a fresh `bash scripts/typecheck.sh` run against this
      pass's own working tree — not this step's to fix, per the coordinator's
      standing arbitration of that file).
- [x] `packages/sdk/README.md`: a new "Your script can be a workflow node"
      section, placed immediately before "Publishing" — what makes a good node
      (a small declared output and why an undeclared one is checked late, not
      never; `finish()`'s existing idempotency rule read against resume rather
      than only against a retried attempt; a `reset` declaration that is
      honest about what a script assumes about the device it starts on).
- [x] `docs/guide/workflows.md` (new): the owner's own example (Scroll FYP →
      Search → Scroll FYP → Report, with the gate and the one workflow
      parameter) built end to end — Studio steps, Validate, running it, and a
      dedicated "what resume does and does not promise" section matching §3.5
      verbatim (a new job, the version copied not re-resolved, outputs carried
      forward, the reset still firing, `skipped` vs `skipped-on-resume`), plus
      "what is deliberately not here" (no expression language, no parallel
      nodes, no nested workflows).
- [x] `docs/spec.md`: §11.7, §12.4 (`job_nodes`, `job_resumes`), and §19's
      Workflows row were already added directly by earlier steps in this plan
      (99.6, 99.7/99.8, 99.9 respectively — each step documented its own new
      surface in the same pass that shipped it, per this plan series'
      established convention, rather than deferring the whole write-up to this
      step). Re-read in full by this step and confirmed accurate against the
      code as it stands today, with one small addition this step made
      directly: §13's Queue/job bullet gained one clause naming `job.status`'s
      `node` block, the one workflow-specific protocol fact that no earlier
      step's status paragraph had put into spec prose (it was pinned in
      `@enkaku/protocol`'s schema and in `packages/core/README.md`'s Co-control
      section's own citations, but never in §13 itself). `bun run spec:check`
      confirmed GAP 0 both before and after this step's edit.
- [ ] `docs/plans/00-overview.md` §2: **not done by this step, on purpose** — this
      step's own brief lists `docs/plans/00-overview.md` among the files it
      must NOT touch ("a concurrent worker" holds it), and a fresh check
      confirms no plan-99 row exists in §2's table yet. Left for whoever next
      holds that file; the row's content is one line:
      `| 99 | `99-m64-workflows.md` | M64 | A workflow is a `scripts` row
      (`kind: 'workflow'`) run as one job under one lease — nodes are script
      children, gates are closed predicates, `job_nodes` is the per-execution
      history. |`
- **Verifiable result:** `bun run spec:check` — GAP 0, unchanged before and
  after (docs/spec.md's own workflow sections were already complete; this
  step's one addition to §13 does not regress it). `bash
  scripts/check-plan-status.sh` — passes. The three new/edited README sections
  and the new guide page were checked by hand against the actual shipped code
  (not the plan's own original §3/§4 prose) for every fact this step's brief
  flagged as counter-intuitive: the four-file containment claim, the
  now-working `E_WORKFLOW_BUDGET_IMPOSSIBLE` plus `W_WORKFLOW_BUDGET_UNKNOWN`,
  the pre-job reset firing again on a resumed job's first execution, resume
  copying a resolved `scriptId` rather than re-resolving `@latest`, the
  `skipped`/`skipped-on-resume` distinction, and "every finding, not just the
  first." No source file was edited by this step; the one pre-existing
  failure (`packages/core/src/api/jobs.ts(229,49)`, the duplicate-schema
  collision from a second, out-of-workspace Claude session) was confirmed
  still present, not fixed, and is recorded again in
  `docs/plans/96-m61-hotfixes.md` for visibility rather than silently
  re-reported only here.

---

**Consolidated hardware-pending table**, gathering step 99.11's own four
hypotheses (H1–H4) plus §7.3's already-drafted measurement rows into the
single list this task asked for, mirroring the precedent plans 90/91/92 set
for exactly this situation — an owner sitting down with real hardware gets
one table to work through top to bottom instead of a plan step and a test-plan
section that say almost the same thing in two places. **None of these were
run by this documentation pass; the prohibition against touching a physical
device applied throughout, exactly as it applied to every step that first
wrote these rows.** §7.3 (in the Test plan section, above §8) is left exactly
as it is — this table adds a cross-reference and the exact commands, it does
not replace that section.

| # | Hypothesis | Exact command / procedure | Target | Outcome |
|---|---|---|---|---|
| 1 | **H1** — a 4-node workflow costs materially less than 4 separate jobs (session builds, not child spawns, dominate per-job cost) | Publish the owner's 4-node example (`docs/guide/workflows.md`). On one enrolled device, run it 5 times via `POST /api/jobs {"scriptId":"<workflow>"}`, recording total wall time and the job log's session-build count each time. Then publish the same 4 scripts as one-off jobs and run all 4 in sequence, 5 times, recording the same two numbers. | workflow total wall time < 4-separate-jobs total; 1 session build per workflow run vs 4 for the separate-jobs run | _(unfilled)_ |
| 2 | **H1** — per-node overhead stays under the farm's job-overhead budget | From the same 5 workflow runs: `(workflow total − Σ each node's own reported duration) ÷ 4` | < 3 s (spec §16's "spawn → prepare" budget) | _(unfilled)_ |
| 3 | **H2** — suppressing the pre-job reset between nodes leaves the device in a state the next node can actually start from, for real scripts | `tiktok/auto-scroll` → `tiktok/searched-follow` as a 2-node workflow, node 2 at its default `reset: 'none'`. Run 10 times × 3 devices; for each run, check via the Inspect tab or a screenshot artifact on node 2 whether it began on the feed (the state node 1 left) rather than the launcher. | reported, not targeted — this is a measurement of a real assumption, not a pass/fail gate | _(unfilled)_ |
| 4 | **H2** — the control case: with `reset: 'farm'` forced on node 2, the assumption above does not accidentally hold anyway | Same pipeline, node 2 overridden to `reset: 'farm'`. Same 10 runs × 3 devices. | expected 0/30 begin on the feed | _(unfilled)_ |
| 5 | **H3** — the owner's own example needs no undocumented concept | Build `docs/guide/workflows.md`'s pipeline (Scroll FYP → Search → Scroll FYP → Report, one gate, one workflow parameter) in the Studio editor, verbatim, with no JSON typed anywhere. Record every concept it needed — a control, a binding kind, a setting — that this plan's own document/editor does not already have a name for. | 0 undocumented concepts needed | _(unfilled)_ |
| 6 | **H4** — the four operator questions are answerable from the UI alone | Run the workflow above; deliberately fail one node (e.g. an invalid keyword param on `search1`). From the job detail page only, with the log tab closed, answer: which node failed? what did it return (or the error)? why did the gate before it branch the way it did (if reached)? where would resume start? | 4/4 answerable with no log open | _(unfilled)_ |
| 7 | Lease continuity, end to end | While the workflow from row 1 is mid-pipeline, `POST /api/jobs` a second job (e.g. `internal:sleep`) at the same device. `GET /api/devices` should read the workflow's device `busy` throughout, with the same `jobId` reported by the lease the whole time. | second job never claimed until the workflow settles; device stays `busy`, same `jobId` | _(unfilled)_ |
| 8 | Gate cost | Run the 5-node example (2 gates: `enough` plus one more added for this check) and count child processes actually spawned (job log). | 4 child spawns for 4 script nodes, not 6 — a gate spawns nothing | _(unfilled)_ |
| 9 | Output storage cap | A node script that deliberately returns a ~1 MB payload. Check the resulting `job_nodes` row. | output truncated at `workflow.maxNodeOutputBytes` (default 256 KiB), `outputTruncated` recorded, not silent | _(unfilled)_ |
| 10 | Cancel latency | Cancel a workflow job while a node is mid-attempt (`POST /api/jobs/:id/cancel`). Time from the request to the device reading `idle`. | within the existing single-job grace window — no second abort implementation, no extra delay | _(unfilled)_ |

---

## 6. Acceptance criteria

1. A published workflow is an **ordinary `scripts` row**: it appears in the
   scripts list, resolves as `name@version` and `@latest`, runs from the run
   dialog with a generated parameter form and saved parameter presets, can be
   scheduled, batched across a cluster, cancelled, and run by an agent through
   `job.run` — with no endpoint, table or screen learning a union type.
2. Running a workflow across a cluster creates **one ordinary batch**, one job per
   device, honouring `batches.concurrency` — through `POST /api/batches` with no
   new field and no second dispatcher.
3. **The union is contained.** A repo-wide search for `kind === 'workflow'` (or
   any equivalent test) outside `jobs/executor.ts`, the workflow/script publish
   routes, Studio's list filter, and `workflow-check.ts`'s `E_WORKFLOW_NESTED`
   check returns **nothing**. (Amended from three files to four once step 99.6
   built the nested-workflow check and found it needs the same `kind` fact,
   for a reason §3.1 records rather than treats as a containment breach:
   `checkWorkflow` is deliberately pure and database-free so the editor's
   Validate button and the publish gate can never disagree, and §4.3's own
   signature is what hands it `kind` in the first place. This still fails, by
   design, if a *fifth* reader appears anywhere in the tree.)
4. A workflow job holds **one lease for the whole pipeline**: the device is `busy`
   from the first node to the last, `getLease` reports the same `jobId`
   throughout, and a job queued on that device mid-pipeline is not claimed until
   the workflow settles.
5. **One session is built per workflow, not per node** — asserted by a counter in
   99.11 and visible as a single session-build entry in the job log.
6. Node 2 of a pipeline starts where node 1 finished: with the farm's default
   `resetPolicy: 'home'`, no HOME press and no reset phase occurs between nodes,
   while a node declaring `reset: 'farm'` gets the full farm reset.
7. A node failure runs that node's own retries on the same device, session and
   lease; the `onFailure` policy then decides; and the workflow's `onFail` cleanup
   runs exactly once and is a no-op when run twice.
8. **Every node execution is a row.** `GET /api/jobs/:id/nodes` returns one entry
   per execution — including skipped ones — with status, duration, attempts, the
   resolved `script@version`, and the node's output or the reason it has none.
9. **Every gate branch is a row.** A gate's entry carries the resolved left value,
   the resolved right value, the operator and the verdict, and Studio renders it
   as one readable sentence.
10. A binding to an earlier node's output resolves at run time; an unresolvable
    path fails the node with a message naming the node, the path and the keys the
    output actually had; a binding declared `optional` with a `default` does not
    fail.
11. With a declared output schema present (A1), a binding to a path that cannot
    exist is refused **at publish**; without one, publish emits
    `W_WORKFLOW_UNCHECKED_BINDING` and the workflow still publishes.
12. A binding to a node that can only run **later** is refused at publish, computed
    over the transition graph — including the case where a backward `goto` makes a
    later-in-the-array node an earlier execution.
13. A workflow parameter bound into a node parameter of an incompatible type is
    refused at publish. Promote copies the node parameter's `title`,
    `description`, `hints` and default verbatim.
14. A workflow's compiled `paramsSchema` is **byte-identical** to
    `z.toJSONSchema(<equivalent Zod object>, { io: 'input' })`, and a schedule
    firing a workflow with stale parameters **refuses** on `reconcileParams`'
    `blocking`, naming the fields — the same code path a script uses.
15. A backward `goto` loops; exceeding `maxSteps` fails with
    `E_WORKFLOW_STEP_BUDGET` naming the node and the per-node execution counts;
    exceeding `workflow.maxTotalMs` fails with `E_WORKFLOW_BUDGET_EXCEEDED` naming
    the node in flight.
16. Cancelling a running workflow aborts the node in flight, lets its `finish()`
    run, plans no further node, and releases the device — through the existing
    cancel path, with no second abort implementation.
17. **Resume is a new job and says so.** It starts at the chosen node, resolves
    earlier nodes' outputs from the original job's rows, runs the version the
    original job ran (never a re-resolved `@latest`), records
    `resumedFromJobId`/`resumedFromNode`, marks skipped nodes
    `skipped-on-resume`, and its dialog names every node being skipped before the
    operator confirms.
18. Two nodes of one workflow each calling `ctx.jobs.trigger()` once produce **two**
    triggered jobs, not one deduped into the other (F20 closed). A standalone
    job's trigger keys are unchanged.
19. Per-node artifacts are attributed: a screenshot taken in node 3 carries
    `nodeId: 'node3'` and appears under that node in the job detail.
20. Publishing a workflow whose node is another workflow is refused
    (`E_WORKFLOW_NESTED`) — **shipped in step 99.6**. Publishing one whose node
    timeouts cannot fit `workflow.maxTotalMs` is refused with the arithmetic in
    the message (`E_WORKFLOW_BUDGET_IMPOSSIBLE`) — **blocked**, not yet
    satisfiable: no node's declared `timeout` is readable at publish time
    until plan 98 step 98.4 persists it onto the `scripts` row (§3.11, §3.12,
    §4.3 check 7). Until then this half of the criterion cannot pass and is
    not claimed as passing.
21. The owner's example — Scroll FYP → Search Keywords → Scroll FYP → Report, with
    a gate before Report and one workflow parameter for the keyword — is built in
    the editor with no JSON typed, published, run on a device, and produces a
    readable node timeline.
22. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test` are
    green. `bash scripts/check-plan-status.sh` passes.

---

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| the document | `packages/protocol/src/workflow.test.ts` | every node kind round-trips; duplicate ids, unknown `goto` targets, a 51-node document, an over-deep predicate and an unknown operator are each refused by name |
| the path grammar | same | `a.b.0` parses; `a[0]`, `a.*`, `a..b`, `__proto__`, a 201-char path do not |
| params compile | `packages/protocol/src/workflow-params.test.ts` | deep equality against `z.toJSONSchema(…, { io: 'input' })` for every `type`; the output passes `checkParamsSchema`; every field plans to a real control |
| resolution | `packages/protocol/src/workflow-resolve.test.ts` | all four expression forms; `optional`+`default`; an unresolved path reports `sawKeys`; `{ run: 'summary' }` is capped |
| predicates | same | every operator × `undefined`/`null`/`NaN`/`[]`/`{}`/type mismatch — nothing throws; `all`/`any`/`not` compose; the trace matches the rendered sentence |
| static checks | `packages/protocol/src/workflow-check.test.ts` | one case per finding code; **every** finding is returned, not the first; forward-reference detection with a backward `goto` present |
| reset seam | `packages/session/src/runner/job-runner.test.ts` | `reset: 'none'` emits no `reset` phase and no device event; absent behaves byte-identically to today; `finish-only` is unaffected |
| trigger key | `packages/session/src/runner/jobs-client.test.ts` | two `nodeId`s under one jobId+attempt derive different keys; no `nodeId` derives today's key exactly |
| retries override | `job-runner.test.ts` | `job.retries` beats `meta.retries`; absent falls back; the infra budget is untouched |
| executor selection | `packages/core/src/jobs/executor.test.ts` | `get(id, 'workflow')` returns the workflow executor; `get(id)` and `get(id, 'script')` are identical to before this plan |
| the interpreter | `packages/core/src/jobs/executors/workflow.test.ts` | linear run; a gate branching both ways; a backward `goto` bounded by `maxSteps`; `onFailure: continue`; one session acquire across N nodes; a gate spawns no child; `signal` abort at a step boundary; the `finally` always releases |
| node rows | same | one row per execution including skipped; a gate row carries its trace; an oversized output is truncated and says so |
| publish | `packages/core/src/api/workflows.test.ts` | valid doc → a `scripts` row with `kind: 'workflow'`; `checkWorkflow` findings map to `400`; a duplicate `name@version` is `script_version_exists` from the existing writer |
| resume | `packages/core/src/api/jobs.test.ts` | a non-terminal job is `409`; an unreachable `fromNode` is `400`; a resumed job copies the resolved script id and replays outputs |
| schedule refusal | `packages/core/src/schedules/runner.test.ts` | a workflow with stale params refuses on `blocking`, through the existing code |
| the editor | `packages/studio/src/app/workflows/editor/page.test.tsx` | reordering rows does not rewire an explicit branch; Promote copies title/hints/default; Validate surfaces findings on the right rows |
| the predicate editor | `packages/studio/src/components/workflow/PredicateEditor.test.tsx` | every operator is reachable; a right operand disappears for `exists`/`isEmpty`; the built value parses under `PredicateSchema` |
| the run dialog | `packages/studio/src/components/RunScriptDialog.test.tsx` | the filter partitions one list; the empty state links to the editor; the duration sentence says *up to* |
| the node timeline | `packages/studio/src/app/jobs/detail/page.test.tsx` | a gate renders its sentence; Resume is offered only on a failed node; the skip warning lists the nodes |

### 7.2 Local smoke (one device)

```bash
bun run typecheck && bun test && bun run --cwd packages/studio test
bun run dev
# Studio → Workflows → New workflow.
#   node 1  tiktok/auto-scroll@1.4.0     videos = 15         (starts from: a clean device)
#   node 2  tiktok/searched-follow@1.4.0 keyword = {param}   (starts from: where node 1 finished)
#   gate    enough?   scroll1.videos >= 10 ? continue : stop
#   node 3  tiktok/auto-scroll@1.4.0     videos = 10
# Declare one workflow parameter `keyword` via Promote on node 2. Validate. Publish 1.0.0.
curl -s localhost:7700/api/scripts?kind=workflow | jq '.items[] | {name, version, kind}'
# Run it from the device page. While it runs:
curl -s localhost:7700/api/devices | jq '.items[] | select(.id=="…") | {status, holder}'   # busy, same jobId throughout
curl -s -XPOST localhost:7700/api/jobs -d '{"scriptId":"internal:sleep","deviceId":"…"}'   # must NOT be claimed mid-pipeline
curl -s localhost:7700/api/jobs/<id>/nodes | jq '.items[] | {seq, nodeId, status, scriptName, scriptVersion}'
# Then: cancel one mid-node and confirm the device returns to idle with finish() having run.
# Then: force node 2 to fail (a bad keyword), and resume from node 2 from the job page.
```

### 7.3 The measurements that settle §0.3

Run on at least three devices, against the tiktok pack. **Record the numbers
here; an empty cell is a measurement not taken, not a passed one.**

| Measurement | Method | Target | Result |
|---|---|---|---|
| **H1** — 4-node workflow vs 4 separate jobs, total wall time | 5 reps each, one device | workflow faster | |
| **H1** — session builds | job log count | 1 vs 4 | |
| **H1** — per-node overhead | (workflow total − Σ node durations) ÷ 4 | < 3 s (spec §16) | |
| **H2** — node 2 begins on the feed | 10 runs × 3 devices, `reset: 'none'` | reported, not targeted | |
| **H2** — same, with `reset: 'farm'` on node 2 | same | expected 0/30 | |
| **H3** — concepts the owner's example needed that this plan lacks | build it | 0 | |
| **H4** — the four questions answered from the UI alone | one deliberate failure | 4/4 | |
| lease continuity | a competing job queued mid-pipeline | never claimed | |
| gate cost | 2 gates in a 4-node run | 4 child spawns, not 6 | |
| output storage | a node returning 1 MB | truncated at the cap, recorded | |
| cancel latency | cancel mid-node → device idle | within the existing grace window | |

### 7.4 Regression watch

- A non-workflow job's `JobSpec` carries no `reset`/`nodeId`/`retries`, and its
  reset phase, trigger keys and retry budgets are **byte-identical** to before
  this plan.
- `ExecutorRegistry.get(scriptId)` with no kind returns exactly what it returned
  before 99.5.
- Every `scripts` row written before this plan reads `kind: 'script'`; `GET
  /api/scripts` with no `?kind=` returns the same set it returned before.
- `POST /api/batches` with a script id behaves exactly as before; the only
  difference with a workflow id is which executor runs.
- A schedule firing a script is unchanged; the reconcile refusal is the same code
  and the same message.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A workflow holds a device for hours and the farm's utilisation quietly collapses. | This is the feature, so it is made **visible** rather than prevented: the run dialog states an upper-bound duration per device and for the whole batch (§4.11), `workflow.maxTotalMs` is a real ceiling with a named error, and the device's holder badge names the workflow job for its whole life (F6's `takeable: false` already communicates it). |
| Skipping the reset between nodes leaves node 2 somewhere node 1 did not intend, and it fails in a way that looks like a script bug. | `reset` is a **declared, per-node, plain-language** field shown in the editor (§3.3), not a hidden behaviour; H2 measures how often the assumption holds on real scripts; and `onFailure` plus `onFail` give the author an explicit recovery path. |
| A backward `goto` with a badly chosen `maxSteps` cooks a phone. | The budget is on the document with a default of 50, shown beside the node count, and enforced with a named error that reports per-node execution counts. `workflow.maxTotalMs` is the independent time backstop, and spec §15.2's thermal quarantine is untouched underneath both. |
| The predicate grammar turns out to be too small, and pressure builds to add "just one" computed expression. | The escape hatch is designed and cheap: a script node that returns a verdict (§3.7), which inherits containment, versioning, parameters and the form. §9 Q2 records the vocabulary question explicitly so growth is a decision, not a drift. |
| `scripts.kind` becomes the thin end of a union that spreads. | Acceptance criterion 3 is a mechanical, falsifiable search. If it ever fails, the design has drifted and the search says where. |
| Storing node outputs bloats the database. | Capped per node (`workflow.maxNodeOutputBytes`, default 256 KiB, matching the existing `shell.maxOutputBytes`), capped for `{ run: 'summary' }`, and truncation is **recorded** rather than silent. Retention is spec §18's, unchanged. |
| Resume is used casually and lands on a device in an unrelated state. | Resume is never automatic, never available to a schedule, always a new job, and always behind a dialog that names every skipped node (§3.5). Re-running the whole workflow is the one-click default. |
| The `nodeId` trigger-key change alters the meaning of a stored `trigger_key`. | A standalone job has no `nodeId`, so its derived key is byte-identical to today (99.4's own test). Only keys that could not previously exist are new. |
| The editor becomes the product and 99.9 eats the milestone. | v1 is a list of rows built from components that already exist, priced in §3.9 against the canvas it is not. The predicate editor is the single bespoke control and is named as such. If 99.9 overruns, 99.1–99.8 still ship a workflow that can be published by API and run — which is a smaller product, not a broken one. |
| Plans 97/98 land differently from §0.2 and this plan is built on sand. | §0.2 states each assumption with what changes if it is wrong; the answer in every case is a branch in one function or a column rename, because **no part of §3's decision depends on either plan**. |
| Line numbers in this document drift, because the tree was being edited while it was written. | Stated in §0; every citation names a symbol, and the symbol is authoritative. |

---

## 9. Open questions — owner decisions

1. **Vocabulary: is an evaluation node a "gate"?** The owner said *"nodes untuk
   eksekusi atau evaluasi response sebelumnya"*. This plan calls the second kind a
   **gate**, because it names what the node *does* — it gates what runs next —
   and because "evaluation node" is long and "check" collides with the readiness
   and doctor checks the product already has. Plan 94 §9 Q1 set the precedent that
   product vocabulary is an owner call, not an engineering one. Alternatives:
   **check**, **decision**, **condition**, **if**. The word appears in the
   protocol (`kind: 'gate'`), in the UI, and in the guide, so it is worth settling
   once.

2. **Is the closed operator set the right size?** §3.7 ships fifteen operators and
   no arithmetic, no string manipulation, no dates, no regular expressions.
   `videos >= 10` works; `videos / minutes > 2` does not, and needs a script node.
   The trade is deliberate — every operator added is a thing to specify, render,
   test and explain — but the *first* thing an operator will hit is arithmetic on
   two node outputs. Should v1 add `sum`/`ratio`, or is "write a script" the right
   answer? This plan says the latter and asks for it to be confirmed rather than
   assumed.

3. **Can a plugin ship a workflow?** A plugin publishes N `scripts` rows from one
   bundle (F15). A plugin that also shipped a *workflow* wiring its own scripts
   together would be an obviously good distribution unit — *"install the tiktok
   pack and get a working warm-up pipeline"* — and it is genuinely small: a
   `workflows: [...]` array on `definePlugin`, verified by the same child, written
   by the same activation. It is out of v1 because it needs a rule for what
   happens when a plugin is rolled back under a workflow that names its members,
   and that rule is a product decision about whether a pipeline may break on a
   rollback. Named so the seam is not accidentally closed.

4. **Nested workflows.** Refused in v1 (§2) because the step budget, the node-id
   namespace, the artifact namespace and resume all become recursive, and a cycle
   becomes possible. The seam if it is ever wanted: `checkWorkflow` already walks
   the document and resolves every node ref, so cycle detection is a graph walk
   over resolved refs, and the budget would need to be a *shared* counter rather
   than a per-document one. Worth its own plan, not a paragraph in this one.

5. **Should a workflow ever span two devices?** §3.1 names this as one of the two
   things that would change the central decision. A pipeline like *"post from
   device A, then verify it appeared on device B"* is a real thing to want and it
   is **not** a variation on this design: it needs a lease per device, a join, and
   an answer for what happens when device B is busy for an hour after device A has
   finished. If it is wanted, it is candidate B (§3.1) with a genuine reason to
   exist, and it should be planned as such rather than grafted on.

6. **Does resume need to be reachable from a schedule?** §3.5 says no — an
   unattended caller must not resume onto a device whose state nobody vouched for.
   But a nightly pipeline that fails at node 4 every night and needs a human to
   press Resume every morning is a bad experience. The alternative would be a
   per-node "safe to resume unattended" declaration, which §3.5 argues against on
   the grounds that it is an unverifiable assertion by the workflow author about
   someone else's script. Recorded because the operational pain is real even if
   the mechanism is wrong.

Items 7 and 8 are not owner decisions. They are two real defects found while
reading the tree for this plan, in code this plan does not touch, recorded here
so they are not lost.

7. **A plugin member's `paramsSchema` is published without `{ io: 'input' }`.**
   `packages/core/src/plugins/verify-child-entry.ts` calls
   `z.toJSONSchema(s.params)` while `packages/sdk/src/cli/publish.ts` calls
   `z.toJSONSchema(params, { io: 'input' })`. That is exactly the defect plan 95
   identified and fixed for standalone scripts — every `.default()` field is
   published as `required` — still live for **every plugin member**, which is
   every script in the tiktok pack. It is a one-line fix in a file this plan does
   not otherwise touch, and it deserves its own commit rather than being smuggled
   in here.

8. **`PARAM_SOURCES` declares `devices`, `clusters` and `scripts`; `useEnumSource`
   has no mapping for them.** `packages/protocol/src/params/vocabulary.ts`'s
   allowlist lists all three, and
   `packages/studio/src/components/schema-form/useEnumSource.ts`'s `KEY_MAP` does
   not, so a script declaring `source: 'devices'` silently falls back to the plain
   enum. Harmless today because nothing declares them — and directly relevant to
   this plan's future, because a workflow parameter that picks a cluster is an
   obvious next want.
