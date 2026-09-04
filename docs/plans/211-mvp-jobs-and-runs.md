# Plan 211 — MVP wave 2 : Jobs and runs; the workflow orchestrator; schedules fire runs

> Status: implemented (software) — G1–G14 done and verified by the commands in §7.1/§10; G15 is the owner's farm smoke and is not run by an agent. See §11 for the scoped test-file replacements (plan 200 §8.3) and the GREP_211 false positives (unrelated `nodeId`/`onNode` matches and historical migration-file/comment references), both recorded honestly rather than glossed over.
> Depends on: plan 210 (the `workflows` table, `WorkflowStore.snapshotForJob`, `jobs.workflow_doc`, `scripts.kind` removed, `ExecutorRegistry` reduced to one fallback, `jobs/executors/workflow.ts` left in the tree unregistered), which depends on plan 207 (`POST /api/actions/run-script` always creates a batch; `run-workflow` answers `E_NOT_SUPPORTED` naming **this** plan), which depends on plan 205 (activities and the policy table; `jobs.lease_expires_at` already renamed `heartbeat_expires_at`; `jobs.assist_count` already deleted; `renewLease` already renamed `renewHeartbeat`; `claimNext` already reads `d.status = 'online'` plus `NOT EXISTS (running job on this device)`; the scheduler already starts a `job:<id>` activity after a claim). Plan 200 is the rules and format.
> Spec references: `docs/mvp/14-jobs-and-runs.md` (entire: §0 what exists today, §1 the model, §2 what the user sees, §3 migration, §4 removed, §5 retention, §6 open points), `docs/mvp/05-jobs-model.md` as amended by 14 and 15 (§1.2 the workflow job as an orchestrator of script jobs, §1.3 dispatch, §1.4 batches and schedules, §2 removed, §4 open points 1 and 2), `docs/mvp/13-removal-register.md` A.4 (the six rows plan 210 left: `jobNodes`, `GET /api/jobs/:id/nodes`, `POST /api/jobs/:id/resume`, the `node` block on `job.status`, `artifacts.nodeId`, the child-spawning workflow executor), `docs/mvp/09-additional-scope.md` §6 (retention), `docs/mvp/15-ui-migration.md` §1 rows "Job kinds", "Schedules", "Runs of one job" and §2 (the run picker is undrawn; plan 218 draws it), `docs/mvp/16-consolidated-plan.md` §1 (nouns), §2 (the Jobs row), §3 wave 2. Where `docs/spec.md` §10, §11.7 or §12.3 still describe one job per execution, `schedule_runs`, or "one job under one lease", `docs/mvp/16` wins (plan 200 header) and plan 202/224 rewrite them.
> Ships: packages/core/src/jobs/runs/store.ts

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_211` is defined once in §10 and copied verbatim wherever it is cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | `job_runs` and `workflow_steps` exist with the §4.1 columns; `jobs` has lost every execution column | fresh database: `PRAGMA table_info(jobs)` has none of `status`, `heartbeat_expires_at`, `result`, `error`, `started_at`, `finished_at`, `expires_at`, `not_before`, `batch_repeat`, `paced_delay_ms`, `failure_class`, `error_phase`, `infra_attempts`, `peak_rss_bytes`, `max_concurrent`, `runtime_override`, `result_status`, `result_bytes`, `result_summary`, `result_issues`, `priority` | `bun test packages/core/src/jobs/runs/store.test.ts` passes, including the test named `a fresh database has job_runs, workflow_steps and a jobs table with no execution columns` | [x] |
| G2 | A database with pre-existing jobs migrates: one run each, `seq = 1`, logs, trace rows, trace directories and artifacts re-keyed to the run | 3 jobs in, 3 jobs + 3 runs out; `job_events.run_id` and `artifacts.run_id` non-null for every migrated row; `<dataDir>/traces/<runId>/` holds the frames that were under `<jobId>/` | `bun test packages/core/src/db/migrations/jobs-to-runs.test.ts` passes, including the test named `every existing job becomes one run at seq 1 with its history re-keyed` | [x] |
| G3 | The workflow orchestrator runs three steps, a gate, a failure and a resume without spawning a child process of its own | 3 script steps become 3 `jobs` rows with `parent_workflow_job_id` set; the gate step has a `verdict` and no job; the failed step ends the run; a resume adds a run with `trigger = 'resume'` that carries over the successful steps | `bun test packages/core/src/jobs/executors/workflow.test.ts` passes, including the tests named `three script steps become three child script jobs, in order`, `a gate step records its verdict and branches`, `a failing step ends the workflow run at that step` and `resume adds a run that carries over the successful steps and restarts at step N` | [x] |
| G4 | `claimNext` claims runs, keeps its five gates, and lets a workflow job's own step run on the device it holds | two queued runs on one online device claim one at a time; a step run whose `parent_workflow_job_id` matches the device's running workflow job IS claimed; any other run is not | `bun test packages/core/src/queue/job-store.test.ts` passes, including the tests named `claims one run at a time per device`, `a workflow step run is claimed while its own parent workflow job is running on that device` and `an unrelated run is not claimed while a workflow job runs on that device` | [x] |
| G5 | `jobs.latest_run_id` and `jobs.run_count` are maintained in the same transaction as every run write | after 1 add, 1 settle, 1 re-run, 1 run delete: `run_count` is 1, 1, 2, 1 and `latest_run_id` is the highest-`seq` surviving run | `bun test packages/core/src/jobs/runs/store.test.ts` passes, including the test named `run_count and latest_run_id follow every add, settle and delete` | [x] |
| G6 | Nothing in `packages/` names a job node, a resumed-from job, or a schedule run any more | 0 matches | `rg -n "jobNodes\|job_nodes\|:id/nodes\|resumedFromJobId\|resumed_from_job_id\|schedule_runs\|scheduleRuns" packages --glob '!packages/core/drizzle/**' --glob '!**/out/**' --glob '!**/*.tsbuildinfo' --glob '!packages/core/packs/**'` prints nothing. (A bare `/nodes` is **not** the pattern: `/api/nodes` is the live cloud-node enrolment router, `packages/core/src/api/nodes.ts`, and the `/nodes` Studio page is plan 213's row. Only the job route `/:id/nodes` goes here.) | [x] |
| G7 | `POST /api/actions/run-script` with `jobId` adds a run; with `jobId` and different params it creates a new job | same params: `runCount` 1 to 2, same `jobId` in the result; different params: a new `jobId`, the old job's `runCount` unchanged | `bun test packages/core/src/api/actions-runs.test.ts` passes, including the tests named `run-script with jobId adds a run to that job` and `run-script with jobId and different params creates a new job` | [x] |
| G8 | `POST /api/actions/run-workflow` no longer answers `E_NOT_SUPPORTED` | `202` with one result per device, each carrying `jobId` and `batchId` | `bun test packages/core/src/api/actions-runs.test.ts` passes, including the test named `run-workflow creates one workflow job per device in a batch` | [x] |
| G9 | Batch re-run and re-run-failed add runs instead of creating jobs | a batch of 3 with 1 failed: `/rerun-failed` leaves 3 jobs and gives the failed one a second run | `bun test packages/core/src/api/batches-runs.test.ts` passes, including the tests named `rerun adds a run to every member job` and `rerun-failed adds a run only to jobs whose latest run failed` | [x] |
| G10 | A schedule owns one job per target device and each fire adds a run with `trigger = 'schedule'` | 2 devices, 3 fires: 2 jobs, 6 runs, every run `trigger = 'schedule'`; `onOverlap: 'skip'` while a run is live adds none | `bun test packages/core/src/schedules/runner.test.ts` passes, including the tests named `each fire adds one run with trigger schedule to every member job` and `onOverlap skip adds no run while a previous run is live` | [x] |
| G11 | `POST /api/workflow-jobs/:id/resume` exists and `POST /api/jobs/:id/resume` does not | `404` for the old path, `201` for the new one | `bun test packages/core/src/api/workflow-jobs.test.ts` passes, including the test named `resume adds a run with trigger resume and answers 201` ; `rg -n "'/:id/resume'" packages/core/src/api/jobs.ts` prints nothing | [x] |
| G12 | The retention sweeper's interface exists and nothing implements a policy in this plan | one exported interface, one exported `NO_OP_RUN_SWEEPER`, zero callers in `daemon.ts` | `rg -n "createRunRetentionSweeper\|RunRetentionPolicy" packages/core/src` prints only lines inside `packages/core/src/jobs/runs/sweeper.ts` | [x] |
| G13 | The forbidden vocabulary of this area is gone | 0 matches | `GREP_211` (§10) prints nothing | [x] |
| G14 | The old Studio still compiles against the new job, run, batch and schedule shapes | 0 errors | `bun run typecheck` exits 0 | [x] |
| G15 | Owner smoke on the farm: re-running a job keeps both results and the job list does not grow a row | 1 job row, 2 runs, 2 distinct results readable | §7.3 manual smoke, owner's farm | owner |

## 1. Goals

1. **A job is an intent; a run is an execution** (MVP 14 §1). `jobs` keeps what to run, with which parameters, on which device, made by whom, and two denormalised fields for lists (`latest_run_id`, `run_count`). `job_runs` keeps every execution: its status, its clock, its heartbeat, its result and its failure. A job's displayed status is its latest run's status; `jobs.status` no longer exists.
2. **Re-running never creates a second job.** `POST /api/actions/run-script` and `run-workflow` (plan 207) accept `jobId` and add a run at `seq + 1`. Changing the parameters creates a new job instead, because the intent changed (MVP 14 §2 and §6 item 2).
3. **Everything a run produces is keyed by the run**: logs, trace events, trace frames and UI captures, artifacts. A re-run's output sits beside the run it repeats instead of on top of it.
4. **A workflow job orchestrates real script jobs** (MVP 05 §1.2). `jobs/executors/workflow.ts` stops spawning child processes: it enqueues one script job per script step, waits for that job's run to reach a terminal status, and records the step in `workflow_steps` pointing at the child's `(jobId, runId)`. Gates evaluate exactly as they do today and carry their verdict on the step row. Resume is a new run with `trigger = 'resume'` that starts at step N.
5. **The queue claims runs.** `claimNext` keeps every gate it has (device online, one execution per device, batch concurrency, `maxConcurrent`, `notBefore`, priority ordering, plan 205's control-marker wait) and gains one exemption: a device that is held by a workflow job admits that workflow job's own step runs.
6. **Schedules fire runs.** A schedule owns one batch whose member jobs are one per target device; every fire adds a run with `trigger = 'schedule'` to every member. `schedule_runs` is deleted; `onOverlap` (skip, queue, cancel-previous) applies to the member jobs' live runs.
7. **`jobNodes`, `job_resumes`, `artifacts.nodeId`, `job_events.nodeId`, `GET /api/jobs/:id/nodes`, `POST /api/jobs/:id/resume` and the `node` block on `job.status` are deleted** (MVP 13 A.4, MVP 05 §2, MVP 14 §4).
8. **Retention gets a seam, not a policy** (MVP 09 §6, MVP 14 §5): an interface for a sweeper that expires runs individually and deletes a job with no runs that no schedule owns. Plan 224 writes the policy and wires it.
9. The old Studio keeps compiling and running on the `mvp` branch for the post-wave-2 alpha (MVP 16 §5 item 5). `JobInfo` stays a flat projection of "the job plus its latest run", so the pages plan 218 replaces need only small edits.

## 2. Non-goals

| Not done here | Done by |
|---|---|
| The Jobs list, the Jobs detail, the run picker in the header meta line, the Timeline replay, the Artifacts tab in the handoff's design | plan 218 (MVP 15 §2: the run picker "is to be drawn") |
| The Scripts, Workflows and Schedules pages, including the workflow editor | plan 217 |
| The retention policy, defaults, the nightly sweep and the Storage row in Settings | plan 224 (MVP 09 §6); this plan ships only the interface in §4.9 |
| The settings reduction, including whether `workflow.maxTotalMs` survives as a titled field | plan 212 (MVP 12) |
| Parallel steps inside one workflow run, and a step targeting a different device than its workflow job | after the MVP (MVP 05 §4 items 1 and 2); `workflow_steps.seq` already admits parallel groups without a migration |
| Any change to `packages/session`'s child protocol, the retry loop, the reset policy, or crash containment | nothing; §4.7 threads one new field (`runId`) through `JobSpec` and changes no behaviour |
| Renaming `batches` or its columns, and the groups rename | plan 207 (already landed: `batches.group_id`) |
| Agent runs, agent schedules and `schedule_agent_targets` | unchanged by this plan; §4.8 keeps the agent branch of `fireOnce` writing its own history to the agent tables, not to `schedule_runs` (which is deleted, so §5 step 211.9 moves those three writes) |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03, after plans 205, 207 and 210 land)

- **One table for both intent and execution.** `packages/core/src/db/schema.ts:394` `export const jobs = sqliteTable(`; the row carries `status`, `leaseExpiresAt` (plan 205 renames it `heartbeatExpiresAt`), `result`, `error`, `startedAt`, `finishedAt`, `expiresAt`, `notBefore`, `batchRepeat`, `pacedDelayMs`, `failureClass`, `errorPhase`, `infraAttempts`, `peakRssBytes`, `maxConcurrent`, `runtimeOverride`, `resultStatus`, `resultBytes`, `resultSummary`, `resultIssues` beside `scriptId`, `deviceId`, `params`, `priority`, `batchId`, `batchSeq`, `scriptName`, `scriptVersion` and the plan 81 lineage columns. `packages/core/src/db/schema.ts:646` `export type JobRow = typeof jobs.$inferSelect`.
- **Re-running creates a new job.** `packages/core/src/api/jobs.ts:549` `app.post('/:id/resume', requirePermission('job.run'), async (c) => {`; `packages/core/src/services/job-service.ts`'s `resume(jobId, input)` calls `deps.jobStore.enqueue({ scriptId: original.scriptId, ... })` and then `deps.jobStore.recordResume?.(row.id, { resumedFromJobId: jobId, resumedFromNode: fromNode })`. `packages/core/src/api/batches.ts:829` `app.post('/:id/rerun-failed', requirePermission('job.run'), (c) => {` and `:889` `app.post('/:id/rerun', requirePermission('job.run'), (c) => {` both end in `createBatch(dispatchDepsFor(c.get('user')), { ... target: { deviceIds: ... } })`, so a re-run is a new batch of new jobs and nothing links the two.
- **Resume lineage lives in a side table.** `packages/core/src/db/schema.ts:1164` `export const jobResumes = sqliteTable('job_resumes', {` with `resumedFromJobId` and `resumedFromNode`.
- **Workflow nodes are child processes inside one job.** `packages/core/src/db/schema.ts:1003` `export const jobNodes = sqliteTable(`; `packages/core/src/jobs/executors/workflow.ts` acquires the session once (`await deps.sessions.acquire(job.deviceId, noopFrame)`), loops the document, and for a script node calls `deps.runner.execute({ id: job.id, deviceId: job.deviceId, bundlePath, params: resolvedParams, ... nodeId: node.id })`, writing one `job_nodes` row per execution. Plan 210 has already unregistered this executor (`daemon.ts`'s `executors.setFallback(workflowExecutor, 'workflow')` deleted) and left the file compiling.
- **The node axis is stamped onto two other tables.** `packages/core/src/runner/artifact-store.ts:93` `nodeId: deps.nodeId?.() ?? null,`, fed by `packages/core/src/runner/artifact-store.ts:145` `export interface JobNodeTracker {`; `packages/core/src/db/schema.ts:1091` `export const jobEvents = sqliteTable(` carries `nodeId: text('node_id'),` with the comment "Plan 99's workflow node axis, mirroring `artifacts.nodeId`".
- **Schedules keep a second history shape.** `packages/core/src/db/schema.ts:1382` `export const scheduleRuns = sqliteTable(`; `packages/core/src/schedules/runner.ts:171` `export async function fireOnce(rawDeps: ScheduleRunnerDeps, schedule: ScheduleRow, dueAt: Date, missedCount = 0): Promise<void> {` dispatches a whole new batch per fire (`const { batch } = createBatch(batchDeps, { ... })`), inserts a `schedule_runs` row and writes `schedules.lastBatchId`. `packages/core/src/api/schedules.ts:636` `app.get('/:id/runs', (c) => {` pages that table.
- **The claim is one statement over `jobs`.** `packages/core/src/queue/job-store.ts:480` `claimNext(jobTtlSec, excludeDeviceIds) {`; the SQL is quoted in full in §4.6. Its interface is `packages/core/src/queue/job-store.ts:239` `claimNext(jobTtlSec: number, excludeDeviceIds?: string[]): ClaimedJob | null`. The heartbeat is `:296` `renewLease(jobId: string, ttlSec: number): boolean` (plan 205 renames it `renewHeartbeat`), the reaper reads `:297` `expiredRunning(): JobRow[]`, boot recovery is `:307` `failOrphanRunning(): number`, and the infra rebind is `:282` `requeueForRebind(jobId: string, newDeviceId: string): JobRow | null`.
- **Four writers insert a `jobs` row**: `packages/core/src/queue/job-store.ts` (`db.insert(jobs).values(row).run()` inside `enqueue`), `packages/core/src/clusters/dispatch.ts:311` `export function createBatch(deps: BatchDispatchDeps, input: CreateBatchInput): { batch: BatchRow; jobs: JobRow[] }` (`for (const row of jobRows) tx.insert(jobs).values(row).run()`), `packages/core/src/clusters/pacer.ts:176` `deps.db.insert(jobs).values(row).run()` (one job row per paced repetition), and `packages/core/src/jobs/triggers.ts:235` `tx.insert(jobs).values(row).run()` (`ctx.jobs.trigger()`).
- **The batch status is already a projection of its members.** `packages/core/src/clusters/status.ts:78` `export function recomputeBatchStatus(` reads `deps.jobStore.listByBatch(batchId)` and derives the batch status from the member rows.
- **The runner keys everything on one id.** `packages/session/src/runner/job-runner.ts` `export interface JobSpec { id: string; deviceId: string; ... }`; `deps.artifacts(job.id)`, `deps.onPhase(job.id, ...)`, `deps.heartbeat(job.id)`, `deps.onTraceEvent(job.id, ...)`, `putFrame(job.id, ...)`, `active.set(job.id, { ... })` and `ENKAKU_JOB_ID: job.id` all use it. `packages/core/src/jobs/trace/frame-store.ts:89` `return join(deps.dataDir, 'traces', jobId)`; `packages/core/src/runner/artifact-store.ts` builds `join(deps.dataDir, 'artifacts', deps.jobId)`.
- **Purge already knows every table.** `packages/core/src/jobs/purge.ts:72` `export function deleteJobsWithHistory(db: Db, jobIds: string[], deps: JobPurgeDeps = {}): JobPurgeCounts` deletes `job_events`, artifact files, `artifacts` rows, `job_nodes` rows, the trace directory and the `jobs` row.
- **The wire shapes.** `packages/protocol/src/messages/job.ts:73` `export const JobInfoSchema = z.object({`; `:184` `export const JobDetailSchema = JobInfoSchema.extend({`; `:276` `export const JobNodeStatusSchema = z.enum(['running', 'success', 'failed', 'skipped', 'skipped-on-resume', 'cancelled'])`; `:279` `export const JobStatusEventMessage = z.object({` with the `node` block inside its payload; `:311` `export const JobLogMessage = z.object({`; `:331` `export const ArtifactInfoSchema = z.object({` (carrying `nodeId`); `:438` `export const JobWaitingMessage = z.object({`; `:465` `export const JobResumeRequestSchema = z.object({`; `:476` `export const JobResumeResponseSchema = z.object({`. The REST envelopes are `packages/protocol/src/api/jobs.ts` (`JobResponseSchema`, `JobsPageResponseSchema`, `JobLogsResponseSchema`, `JobNodeInfoSchema`, `JobNodesResponseSchema`, `JobTraceResponseSchema`, `JobDeleteResponseSchema`).
- **The old Studio reads these shapes** at `packages/studio/src/app/jobs/page.tsx`, `packages/studio/src/app/jobs/detail/page.tsx` (the node timeline and the resume dialog, `void api(\`/api/jobs/${jobId}/nodes\`, JobNodesResponseSchema)` and `api(\`/api/jobs/${jobId}/resume\`, JobCreateResponseSchema, { ... })`), `packages/studio/src/components/JobsList.tsx`, `packages/studio/src/app/batches/page.tsx`, `packages/studio/src/app/batches/detail/page.tsx` (`/rerun-failed`, `/rerun?only=skipped`, `/artifacts`), `packages/studio/src/app/schedules/detail/page.tsx` (`/api/schedules/${scheduleId}/runs`, `schedule.lastBatchId`), `packages/studio/src/lib/use-job-detail.ts` and `packages/studio/src/components/RunScriptDialog.tsx`.
- **The design of record for the surface**: `docs/mvp/design_handoff_enkaku_openpf/README.md:324-346`, "Screen: Jobs": the detail header's meta line is quoted verbatim as `"job_8f21c4 · dev-011 · schedule · 20:40 · running 3m 08s"`, which is why `trigger` has to be on the run and on the wire; MVP 15 §1 adds `("run 3 of 3 ·")` to that same line, and §2 lists "The run picker on the Jobs detail (MVP 14)" as undrawn. Plan 218 draws it; this plan only has to make the data exist.

### 3.2 Decisions

1. **A run row exists from the moment an execution is requested, not from the moment it is claimed.** A run is created `queued` and `claimNext` flips it to `running`. MVP 14 §1 puts `status` on the run and says a job's displayed status is `latestRun.status`; a job whose only run has not started would otherwise have no status at all, a queued re-run would be invisible, and a paced repetition (which must carry a future `notBefore`) could not be scheduled ahead of time. So the claim **writes** the run row it selects; it does not create one.
2. **`workflow_runs` is `job_runs`, not a second table.** MVP 14 §1 says workflow jobs "follow the same shape", and MVP 05 §1.2's `workflow_jobs` table predates that amendment. A separate run table for workflow jobs would mean two queues, two heartbeats, two reapers, two retention sweeps and a `claimNext` that reads two tables; there is nothing on MVP 14's run list a workflow run does not need. So a workflow job is a `jobs` row with `kind = 'workflow'`, its runs are `job_runs` rows, and only `workflow_steps` is new. Wherever MVP 14 says "workflow_runs", read "the runs of a job whose `kind` is `workflow`".
3. **A batch's members are jobs; a fire or a re-run is a new generation of runs across those jobs.** MVP 14 §1: "Batches are a set of jobs created together from one target"; "Re-run adds a run to every job in the batch"; "a batch's status is the projection of its jobs' latest runs". `batches` keeps `concurrency`, `order` and the four pacing columns, and they now govern each generation of runs rather than a one-shot set of jobs. `recomputeBatchStatus` changes from "count member jobs' statuses" to "count member jobs' **latest run** statuses", which is the same query with one join.
4. **A schedule owns one batch.** MVP 14 §1: "Schedules own one job per target device; every fire adds a run with `trigger = 'schedule'`." Combined with decision 3 that is exactly "a schedule owns a batch and each fire re-runs it", which keeps `concurrency`, `order`, `priority`, `queueTimeoutSec` and `pacing` working with no new mechanism. `schedules.lastBatchId` becomes `schedules.batchId` (the batch this schedule owns, created on the first fire). A device that joins the target between fires gains a member job on the next fire; a device that leaves keeps its job and its history and gets no new run.
5. **The fire decision is not a table.** `schedule_runs` recorded one row per fire including the ones that ran nothing. MVP 14 §4 deletes it, and MVP 14 §1 says a schedule's history is its jobs' runs, which cannot record "skipped, the previous run was still going". That loss is not acceptable silently, so three scalar columns on `schedules` keep the **last** decision (`lastFiredAt` already exists; `lastFireOutcome` and `lastFireDetail` are added) and every non-dispatching outcome is logged at `warn` with the schedule's name. A per-fire ledger is not reintroduced.
6. **Infrastructure retries stay inside a run** (MVP 14 §1). `requeueForRebind` keeps the same run, increments `job_runs.infra_attempts`, clears `started_at`/`heartbeat_expires_at`, sets the run back to `queued`, and writes the new device onto **both** `jobs.device_id` and `job_runs.device_id`, exactly as it mutates `jobs.deviceId` today. A rebind is the farm's own recovery, not a human decision, so it must not consume a run number.
7. **`job_runs` carries two denormalised columns, `device_id` and `script_name`.** Both are copies of the owning job's, written when the run is created (and, for `device_id`, by the rebind above). They exist so `claimNext`'s five gates and its correlated `COUNT(*)`s stay single-table scans on `job_runs` indexes, which is what makes the claim race-safe inside one transaction without a wider lock (the reasoning `job-store.ts` already gives for `jobs.max_concurrent`). Nothing else may read them; the job row is the truth for display.
8. **A workflow job holds the device; its steps are exempted in SQL and in the policy table.** The workflow job's run is claimed like any run and the scheduler starts a `workflow-job:<runId>` activity (plan 205). Its step jobs carry `jobs.parent_workflow_job_id` and `jobs.step_seq`; `claimNext`'s one-execution-per-device gate ignores a running run that belongs to the candidate's own parent workflow job (§4.6). Where an activity decision is evaluated for a step (`packages/core/src/activity/admission.ts`'s `requireAdmission`, plan 205 §4.9), the caller passes `selfIds: ['workflow-job:<parentRunId>']`, the same escape hatch plan 205 §4.3 defines for a client's own control marker. `claimNext` itself never consults the policy table; the queue's gates are SQL, as they are today.
9. **Activity ids move to the run.** Plan 205 §4.10 has the scheduler start `job:<jobId>`. A job now has several executions, so the id becomes `job:<runId>` (or `workflow-job:<runId>` when `jobs.kind = 'workflow'`) and the `href` becomes `/jobs/detail?id=<jobId>&run=<runId>`. This is a refinement of plan 205, not a contradiction: the id has always been "the thing that is running", and that is now the run.
10. **`JobSpec` gains `runId`; `JobSpec.id` keeps every author-facing meaning.** In `packages/session`, storage and liveness key on the run (`deps.artifacts`, `deps.onArtifact`, `deps.onPhase`, `deps.heartbeat`, `deps.onTraceEvent`, `deps.onProgress`, `deps.onRetry`, `putFrame`, `putUiTree`, the `active` map and therefore `abort()`); `ENKAKU_JOB_ID`, the KV namespace fallback, `ctx.jobs`'s `jobId` and `InputSource.id` keep the JOB id, so a script's own view of "which job am I" does not change and `ctx.jobs.resultOf(jobId)` keeps working. `JobSpec.nodeId` is deleted: a workflow step is a job of its own, so it derives an idempotency key like any other job.
11. **A re-run with different parameters is a new job** (MVP 14 §6 item 2, proposal accepted). The comparison is a stable JSON serialisation of the params object; scriptId, deviceId and kind must also match. This keeps "job = intent" strict so a run picker compares like with like.
12. **`JobInfo` stays a flat projection of "job plus latest run".** MVP 14 puts the columns on two tables, but the wire shape the old Studio reads does not have to split with them, and plan 218 replaces every consumer anyway. `JobInfoSchema` keeps every field it has (minus `assistCount`, already deleted by plan 205) and gains `kind`, `runId`, `runSeq`, `runCount`, `trigger`, `parentWorkflowJobId` and `stepSeq`. `JobDetailSchema` gains `runs: JobRunInfo[]`. This is the smallest wire change that carries the new model, and it is what keeps §5 step 211.13's Studio edits to a page count instead of a rewrite.
13. **The migration is a boot data step, not SQL.** The generated migration only changes shape. Copying every job's execution columns into a run row, re-keying `job_events` and `artifacts`, and renaming the trace and artifact directories on disk all need TypeScript (a filesystem rename cannot be expressed in SQLite, and the log line naming what could not be moved needs a logger). It runs once under a `migration_markers` guard, in `daemon.ts`, in the same place plan 210 put its two steps.
14. **The orchestrator waits on an event, never a poll.** `packages/core/src/jobs/runs/watcher.ts` exposes `waitForTerminal(runId, signal)`; the executor host's settle path is its one producer. On subscription the watcher re-reads the run row first, so a run that settled between the enqueue and the subscribe resolves immediately rather than hanging.
15. **A step job is a first-class job.** It appears in `GET /api/jobs`, has its own logs, trace, artifacts and history, can be cancelled on its own, and shows `parentWorkflowJobId`/`stepSeq` so a client can say "step 3 of workflow job #91" (MVP 05 §1.5). This is the whole point of the rewrite: history, artifacts, retries and the device activity entry come for free from machinery that already exists.

## 4. Technical design

### 4.1 Database (`packages/core/src/db/schema.ts`)

#### 4.1.1 Where every existing `jobs` column goes

This is the table the executor implements against. "Job" means the column stays on `jobs`; "Run" means it moves to `job_runs`; "Both" means the value is written to both, with the job's copy being the one anything displays.

| Column today (`schema.ts:394-645`) | Goes to | Column name after | Why |
|---|---|---|---|
| `id` | Job | `jobs.id` | the intent's id, stable for its whole life (MVP 14 §1) |
| `scriptId` | Job | `jobs.script_id` (now nullable) | the resolved script row, pinned at creation; MVP 14's `scriptRef`. Null exactly when `kind = 'workflow'` |
| `deviceId` | Both | `jobs.device_id`, `job_runs.device_id` | the run's copy is decision 7's claim column; the rebind writes both (decision 6) |
| `params` | Job | `jobs.params` | the intent. Different params means a different job (decision 11) |
| `priority` | Run | `job_runs.priority` | how urgently THIS execution should be claimed; a batch re-run may carry a different one forward (`carryForwardShape`) |
| `status` | Run | `job_runs.status` | MVP 14 §1. `jobs.status` is deleted; the job's status is `latestRun.status` |
| `leaseExpiresAt` (plan 205: `heartbeatExpiresAt`) | Run | `job_runs.heartbeat_expires_at` | MVP 14 §1 and §4 |
| `result` | Run | `job_runs.result` | one job holds several results, which is the whole reason for this plan |
| `error` | Run | `job_runs.error` | as above |
| `createdAt` | Both | `jobs.created_at`, `job_runs.created_at` | the job's is when the intent was made; the run's is when this execution was requested, and it is the claim's ordering key |
| `startedAt` | Run | `job_runs.started_at` | MVP 14 §1 |
| `finishedAt` | Run | `job_runs.finished_at` | MVP 14 §1 |
| `batchId` | Job | `jobs.batch_id` | MVP 14 §1 puts it on the job; a batch's members are jobs (decision 3) |
| `batchSeq` | Job | `jobs.batch_seq` | the member's position in the batch, fixed for the batch's life |
| `expiresAt` | Run | `job_runs.expires_at` | the queue deadline of one execution; a re-run gets a fresh one |
| `notBefore` | Run | `job_runs.not_before` | the pacer plans a repetition as a future run (decision 3) |
| `batchRepeat` | Run | `job_runs.batch_repeat` | the repetition index of this run for this device |
| `pacedDelayMs` | Run | `job_runs.paced_delay_ms` | the delay this repetition actually waited |
| `failureClass` | Run | `job_runs.failure_class` | set on the final settle of a failed run |
| `errorPhase` | Run | `job_runs.error_phase` | as above |
| `infraAttempts` | Run | `job_runs.infra_attempts` | MVP 14 §1: infrastructure retries stay inside a run |
| `scriptName` | Both | `jobs.script_name`, `job_runs.script_name` | the job's is the denormalised display name (plan 82); the run's is decision 7's `maxConcurrent` key |
| `scriptVersion` | Job | `jobs.script_version` | `script_id` is pinned, so every run of a job runs the same version. A schedule that resolves `@latest` to a new version creates a NEW job (§4.8) |
| `triggeredByJobId` | Job | `jobs.triggered_by_job_id` | lineage between intents, not between executions |
| `rootJobId` | Job | `jobs.root_job_id` | as above; the partial unique index on `(root_job_id, trigger_key)` is unchanged |
| `depth` | Job | `jobs.depth` | as above |
| `triggerKey` | Job | `jobs.trigger_key` | as above; dedupe is per intent, so a second trigger with the same key still returns the existing job |
| `peakRssBytes` | Run | `job_runs.peak_rss_bytes` | measured per execution |
| `assistCount` | (gone) | none | already deleted by plan 205 §4.6; not carried forward under any name |
| `maxConcurrent` | Run | `job_runs.max_concurrent` | resolved fresh when the run is created (the "re-resolve, never copy blind" rule `job-service.ts`'s `resume()` already applies), and read by the claim's correlated `COUNT(*)` |
| `runtimeOverride` | Run | `job_runs.runtime_override` | the operator's per-execution layer; a re-run copies the previous run's value unless the caller sends a new one |
| `resultStatus` | Run | `job_runs.result_status` | written by the settle path together with the next three |
| `resultBytes` | Run | `job_runs.result_bytes` | as above |
| `resultSummary` | Run | `job_runs.result_summary` | as above |
| `resultIssues` | Run | `job_runs.result_issues` | as above |
| `workflowDoc` (added by plan 210) | Job | `jobs.workflow_doc` | the snapshot of the intent; every run of a workflow job runs the same document |

New on `jobs`: `kind`, `workflow_name`, `schedule_id`, `latest_run_id`, `run_count`, `parent_workflow_job_id`, `step_seq`.

#### 4.1.2 `jobs`, after

```ts
/**
 * A job is an INTENT (MVP 14 §1, plan 211): what to run, with which
 * parameters, on which device, made by whom. Its id is stable for its whole
 * life and it holds no execution state at all: every execution is a
 * `job_runs` row, and a job's displayed status is `latestRun.status`.
 * Re-running adds a run; changing the parameters creates a new job.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** 'script' | 'workflow' (MVP 05 §1.2). A workflow job orchestrates script jobs as steps; it never runs a bundle itself. */
    kind: text('kind').notNull().default('script').$type<JobKind>(),
    /** The RESOLVED `scripts.id`, pinned at creation. Null exactly when `kind = 'workflow'`. */
    scriptId: text('script_id'),
    /** The `workflows.name` this job was created from. Null exactly when `kind = 'script'`. */
    workflowName: text('workflow_name'),
    /** Plan 210: the workflow document, copied at creation so a later edit never changes a queued or running job. Null for a script job. Written by `runs/store.ts`'s `createJob` through `WorkflowStore.snapshotForJob`. */
    workflowDoc: text('workflow_doc', { mode: 'json' }),
    deviceId: text('device_id').notNull(),
    params: text('params', { mode: 'json' }),
    /** Null for a standalone job (plan 20 §4.1). A batch's members are jobs; a re-run adds a run to each (MVP 14 §1). */
    batchId: text('batch_id'),
    batchSeq: integer('batch_seq'),
    /** The schedule that owns this job (MVP 14 §1). Null for a job nothing schedules. */
    scheduleId: text('schedule_id'),
    /** The workflow job this job is a step of (MVP 05 §1.2). Null for every ordinary job. */
    parentWorkflowJobId: text('parent_workflow_job_id'),
    /** 0-based position in the parent workflow run's step list. Null when `parentWorkflowJobId` is null. */
    stepSeq: integer('step_seq'),
    /** Denormalised at creation (plan 82 §3.4): the name survives the `scripts` row disappearing. For a workflow job it is `workflowName`. */
    scriptName: text('script_name'),
    scriptVersion: text('script_version'),
    /** Plan 81 §3.2, §4.1: lineage between INTENTS, unchanged in meaning. */
    triggeredByJobId: text('triggered_by_job_id'),
    rootJobId: text('root_job_id'),
    depth: integer('depth').default(0),
    triggerKey: text('trigger_key'),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    /**
     * Denormalised for lists (MVP 14 §1): the `job_runs.id` with the highest
     * `seq` that still exists, and how many runs exist. Both are written in
     * the SAME transaction as every run insert, settle and delete
     * (`runs/store.ts`); nothing else may write them, and nothing may read
     * a job's status from anywhere else.
     */
    latestRunId: text('latest_run_id'),
    runCount: integer('run_count').notNull().default(0),
  },
  (t) => [
    index('idx_jobs_device').on(t.deviceId, t.createdAt),
    index('idx_jobs_batch').on(t.batchId, t.batchSeq),
    index('idx_jobs_created').on(t.createdAt, t.id),
    index('idx_jobs_schedule').on(t.scheduleId, t.deviceId),
    index('idx_jobs_parent').on(t.parentWorkflowJobId, t.stepSeq),
    uniqueIndex('idx_jobs_trigger_key').on(t.rootJobId, t.triggerKey).where(sql`${t.triggerKey} is not null`),
    index('idx_jobs_root').on(t.rootJobId),
    index('idx_jobs_triggered_by').on(t.triggeredByJobId),
  ],
)

export type JobKind = 'script' | 'workflow'
export type JobRow = typeof jobs.$inferSelect
```

`idx_jobs_claim` (`schema.ts:623` `index('idx_jobs_claim').on(t.status, t.deviceId, t.priority, t.createdAt),`) and `idx_jobs_script_running` (`:642` `index('idx_jobs_script_running').on(t.status, t.scriptName),`) are deleted from `jobs` and recreated on `job_runs` below; both index columns that no longer live on `jobs`.

#### 4.1.3 `job_runs`

```ts
/**
 * One EXECUTION of a job (MVP 14 §1, plan 211). Created `queued` the moment
 * an execution is requested (a manual run, a re-run, a schedule fire, a batch
 * generation, a resume, a workflow step), flipped to `running` by
 * `claimNext`, settled by `executor-host.ts`. Logs, trace events, trace
 * frames, UI captures and artifacts are all keyed by `id`, so a re-run's
 * output sits beside the run it repeats instead of on top of it.
 *
 * `deviceId` and `scriptName` are DENORMALISED copies of the owning job's
 * (plan 211 §3.2 decision 7): they exist only so `claimNext`'s gates and its
 * two correlated `COUNT(*)`s stay single-table scans inside one transaction.
 * Nothing that displays a run may read them; read the job.
 */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    /** 1..n, dense per job, assigned inside the same transaction as the insert. */
    seq: integer('seq').notNull(),
    /** Why this execution exists (MVP 14 §1). Shown in the Jobs detail meta line (design handoff, "Screen: Jobs"). */
    trigger: text('trigger').notNull().$type<RunTrigger>(),
    /** 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'expired'. The same domain `jobs.status` had. */
    status: text('status').notNull().default('queued'),
    /** Denormalised from `jobs.device_id`; rewritten by `requeueForRebind` together with the job's own. */
    deviceId: text('device_id').notNull(),
    /** Denormalised from `jobs.script_name`; the key of the `maxConcurrent` gate. */
    scriptName: text('script_name'),
    priority: integer('priority').notNull().default(0),
    /** Unix seconds; the claim's ordering key and the "queued at" a client shows. */
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    /** Epoch seconds; the job heartbeat (plan 205 §4.4), extended by the runner. */
    heartbeatExpiresAt: integer('heartbeat_expires_at'),
    /** Unix seconds; the reaper expires the run if it has not started by then. Null = wait forever. */
    expiresAt: integer('expires_at'),
    /** Unix seconds; the claim will not take this run before this instant (the pacer's own column). */
    notBefore: integer('not_before'),
    batchRepeat: integer('batch_repeat'),
    pacedDelayMs: integer('paced_delay_ms'),
    result: text('result', { mode: 'json' }),
    error: text('error'),
    failureClass: text('failure_class'),
    errorPhase: text('error_phase'),
    /** How many times THIS run was requeued for an infrastructure failure (MVP 14 §1: infra retries never consume a run number). */
    infraAttempts: integer('infra_attempts').notNull().default(0),
    peakRssBytes: integer('peak_rss_bytes'),
    /** Resolved when the run is created, never re-derived; 0/null both mean unlimited to the claim. */
    maxConcurrent: integer('max_concurrent'),
    runtimeOverride: text('runtime_override', { mode: 'json' }),
    resultStatus: text('result_status'),
    resultBytes: integer('result_bytes'),
    resultSummary: text('result_summary'),
    resultIssues: text('result_issues', { mode: 'json' }),
    /** Set only when `trigger = 'resume'`: the run this one continues, and the `workflow_steps.seq` it restarts at. */
    resumedFromRunId: text('resumed_from_run_id'),
    resumedFromStep: integer('resumed_from_step'),
  },
  (t) => [
    uniqueIndex('idx_job_runs_seq').on(t.jobId, t.seq),
    index('idx_job_runs_job').on(t.jobId, t.seq),
    /** The claim: status first, then the device and the ordering columns. */
    index('idx_job_runs_claim').on(t.status, t.deviceId, t.priority, t.createdAt),
    /** The `maxConcurrent` gate's correlated COUNT (replaces `idx_jobs_script_running`). */
    index('idx_job_runs_script_running').on(t.status, t.scriptName),
  ],
)

export type RunTrigger = 'manual' | 'rerun' | 'schedule' | 'batch' | 'resume' | 'workflow-step'
export type JobRunRow = typeof jobRuns.$inferSelect
```

#### 4.1.4 `workflow_steps`

```ts
/**
 * One step of one workflow RUN (MVP 05 §1.2 as amended by MVP 14). A script
 * step points at the child script job it enqueued and that job's own run; a
 * gate step carries its verdict and owns no job. `jobNodes` is deleted: a
 * step is not a node, it is a job.
 */
export const workflowSteps = sqliteTable(
  'workflow_steps',
  {
    id: text('id').primaryKey(),
    /** The `job_runs.id` of the WORKFLOW job's run this step belongs to. */
    runId: text('run_id').notNull(),
    /** 0-based execution order within this run. A loop makes this exceed the document's step count. */
    seq: integer('seq').notNull(),
    /** The document's step id (`WorkflowDoc.nodes[].id`). `_on_fail` for the document's cleanup step. */
    stepId: text('step_id').notNull(),
    kind: text('kind').notNull().$type<'script' | 'gate'>(),
    /** The child script job and the run of it this step waited on. Both null for a gate and until the job is created. */
    jobId: text('job_id'),
    jobRunId: text('job_run_id'),
    /** 'running' | 'success' | 'failed' | 'skipped' | 'carried-over' | 'cancelled'. */
    status: text('status').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    /** The step's output, size-capped by `WORKFLOW_LIMITS.maxNodeOutputBytes`. For a script step this is the child run's `result`. */
    output: text('output', { mode: 'json' }),
    outputTruncated: text('output_truncated'),
    /** A gate's `PredicateTrace` and the branch it took. Null for a script step. */
    verdict: text('verdict', { mode: 'json' }),
    error: text('error'),
    errorCode: text('error_code'),
  },
  (t) => [uniqueIndex('idx_workflow_steps_seq').on(t.runId, t.seq), index('idx_workflow_steps_run').on(t.runId, t.stepId)],
)

export type WorkflowStepRow = typeof workflowSteps.$inferSelect
```

#### 4.1.5 Edits to other tables

```ts
// `artifacts` (schema.ts:1049): DELETE `nodeId` entirely; RENAME `jobId` to `runId`.
    /** The RUN that produced this artifact (plan 211). Null for a device-scoped artifact. */
    runId: text('run_id'),
    /** Set only for a device-scoped artifact (plan 24 §4.6); null for a run artifact. */
    deviceId: text('device_id'),
// indexes: index('idx_artifacts_run').on(t.runId, t.createdAt) replaces idx_artifacts_job; idx_artifacts_device unchanged.

// `jobEvents` (schema.ts:1091): DELETE `nodeId`; RENAME `jobId` to `runId`; the unique index becomes (runId, seq).
    runId: text('run_id').notNull(),
// indexes: uniqueIndex('idx_job_events_seq').on(t.runId, t.seq), index('idx_job_events_at').on(t.atMs).

// `schedules` (schema.ts:1303):
//   RENAME `lastBatchId` to `batchId` and change the comment to "the batch this schedule OWNS (plan 211 §3.2 decision 4); its member jobs are one per target device".
//   ADD, after `lastFiredAt`:
    /** The last fire's decision (plan 211 §3.2 decision 5), replacing the deleted `schedule_runs` ledger. */
    lastFireOutcome: text('last_fire_outcome'),
    lastFireDetail: text('last_fire_detail'),

// DELETE the tables `jobNodes` (schema.ts:1003), `jobResumes` (:1164) and `scheduleRuns` (:1382) and their exported row types.
```

Migration: exactly one file, generated by `bun run --cwd packages/core db:generate` after every schema edit above, never hand-written. drizzle-kit prompts on a TTY for the renames (`artifacts.job_id` to `run_id`, `job_events.job_id` to `run_id`, `schedules.last_batch_id` to `batch_id`); answer **rename** for all three. Without a TTY the step is blocked, not hand-written. The generated tag (the next free number after plans 205, 207 and 210 have merged; `packages/core/drizzle/meta/_journal.json` ends at `0064_awake_on_connect` before this wave) is copied into `JOBS_TO_RUNS_TAG` (§4.10).

### 4.2 Protocol

#### 4.2.1 `packages/protocol/src/messages/job.ts`

```ts
/** Why an execution exists (MVP 14 §1). Shown in the Jobs detail meta line. */
export const RunTriggerSchema = z.enum(['manual', 'rerun', 'schedule', 'batch', 'resume', 'workflow-step'])
export type RunTrigger = z.infer<typeof RunTriggerSchema>

/** 'script' or 'workflow' (MVP 05 §1.2), visible per row in the one Jobs list (MVP 15 §1). */
export const JobKindSchema = z.enum(['script', 'workflow'])
export type JobKind = z.infer<typeof JobKindSchema>

/**
 * One execution of a job (MVP 14 §1). The list projection deliberately omits
 * `result` and `params`, exactly as `JobInfo` always has (F18): a result can
 * be large and a run list is not the place for it.
 */
export const JobRunInfoSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  seq: z.number().int().min(1),
  trigger: RunTriggerSchema,
  status: JobStatusSchema,
  deviceId: z.string(),
  priority: z.number().int(),
  /** Unix seconds. */
  createdAt: z.number().int(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  expiresAt: z.number().nullable().default(null),
  notBefore: z.number().int().nullable().default(null),
  batchRepeat: z.number().int().nullable().default(null),
  pacedDelayMs: z.number().int().nullable().default(null),
  error: z.string().nullable(),
  failureClass: z.string().nullable().default(null),
  errorPhase: z.string().nullable().default(null),
  infraAttempts: z.number().int().min(0).default(0),
  peakRssBytes: z.number().int().nullable().default(null),
  resultStatus: ResultStatusSchema.nullable().default(null),
  resultSummary: z.string().max(RESULT_LIMITS.maxSummaryChars).nullable().default(null),
  resumedFromRunId: z.string().nullable().default(null),
  resumedFromStep: z.number().int().nullable().default(null),
})
export type JobRunInfo = z.infer<typeof JobRunInfoSchema>

/** One run in full (the detail read): the run plus what it produced. */
export const JobRunDetailSchema = JobRunInfoSchema.extend({
  result: z.unknown(),
  resultBytes: z.number().int().nullable().default(null),
  resultIssues: z.array(ParamIssueSchema).nullable().default(null),
  resultSchema: JsonSchemaNodeSchema.nullable().default(null),
})
export type JobRunDetail = z.infer<typeof JobRunDetailSchema>
```

`JobInfoSchema` (`:73`) keeps every field it has today and gains, with the fields that moved to the run now read from the latest run (plan 211 §3.2 decision 12):

```ts
  /** 'script' | 'workflow' (MVP 05 §1.5: one Jobs list, kind visible per row). */
  kind: JobKindSchema.default('script'),
  /** The latest run's id, and how many runs this job has. Null/0 only for a job whose runs were all swept (MVP 14 §5). */
  runId: z.string().nullable().default(null),
  runSeq: z.number().int().nullable().default(null),
  runCount: z.number().int().min(0).default(0),
  /** The latest run's trigger; null when there is no run. */
  trigger: RunTriggerSchema.nullable().default(null),
  /** MVP 05 §1.5, "step 3 of workflow job #91". Null for every ordinary job. */
  parentWorkflowJobId: z.string().nullable().default(null),
  stepSeq: z.number().int().nullable().default(null),
```

Deleted from this file: the `node` block inside `JobStatusEventMessage`'s payload (`:279-307`), `JobNodeStatusSchema` (`:276`), `JobResumeRequestSchema` (`:465`), `JobResumeResponseSchema` (`:476`), and `ArtifactInfoSchema.nodeId` (`:331`, the field with the comment "Plan 99 §3.2, §4.6" naming the workflow node that produced the artifact). `ArtifactInfoSchema.jobId` becomes `runId`. `JobLogMessage` (`:311`), `JobArtifactMessage`, `JobProgressEventMessage` and `JobTraceMessage` payloads gain `runId: z.string()` beside the existing `jobId`, because a client subscribes per job and renders per run. `JobWaitingMessage` (`:438`) gains `runId: z.string()`.

`JobDetailSchema` (`:184`) gains `runs: z.array(JobRunInfoSchema)` (newest first) beside `result` and `params`, which stay and describe the latest run.

#### 4.2.2 `packages/protocol/src/api/jobs.ts`

```ts
/** `GET /api/jobs/:id`: the job, its latest run flattened, and every run it still has. */
export const JobResponseSchema = z.object({ job: JobDetailSchema })
/** `GET /api/jobs/:id/runs/:runId`. */
export const JobRunResponseSchema = z.object({ run: JobRunDetailSchema })
/** `GET /api/jobs/:id/runs`. */
export const JobRunsResponseSchema = z.object({ items: z.array(JobRunInfoSchema), total: z.number().int() })
/** `GET /api/jobs/:id/runs/:runId/artifacts`. */
export const RunArtifactsResponseSchema = z.object({ items: z.array(ArtifactInfoSchema) })
```

Deleted: `JobNodeErrorSchema` (`:77`), `JobNodeInfoSchema` (`:106`), `JobNodesResponseSchema` (`:168`) and `JobPurgeCountsSchema.nodes`. `JobLogsResponseSchema` and `JobTraceResponseSchema` are unchanged in shape (they are now read under a run path).

#### 4.2.3 `packages/protocol/src/api/workflow-jobs.ts` (new)

```ts
import { z } from 'zod'
import { JobInfoSchema } from '../messages/job'

/** One step of one workflow run (MVP 05 §1.2). */
export const WorkflowStepInfoSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().min(0),
  stepId: z.string(),
  kind: z.enum(['script', 'gate']),
  /** The child script job and the run of it this step waited on; both null for a gate. */
  jobId: z.string().nullable(),
  jobRunId: z.string().nullable(),
  status: z.enum(['running', 'success', 'failed', 'skipped', 'carried-over', 'cancelled']),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  output: z.unknown(),
  outputTruncated: z.string().nullable(),
  /** A gate's `PredicateTrace` and the branch it chose. */
  verdict: z.unknown(),
  error: z.string().nullable(),
  errorCode: z.string().nullable(),
})
export type WorkflowStepInfo = z.infer<typeof WorkflowStepInfoSchema>

/** `GET /api/workflow-jobs/:id/runs/:runId/steps`. `finalized` says whether the workflow RUN has settled. */
export const WorkflowStepsResponseSchema = z.object({ items: z.array(WorkflowStepInfoSchema), finalized: z.boolean() })

/** `POST /api/workflow-jobs/:id/resume`. `fromStep` omitted means "the first step that did not succeed in the latest run". */
export const WorkflowResumeRequestSchema = z.object({ fromStep: z.number().int().min(0).optional() })
/** The new RUN, on the same job. */
export const WorkflowResumeResponseSchema = z.object({
  job: JobInfoSchema,
  runId: z.string(),
  resumedFromRunId: z.string(),
  resumedFromStep: z.number().int(),
})
```

`packages/protocol/src/index.ts` drops every deleted name and exports the new file beside `./api/jobs`.

### 4.3 `packages/core/src/jobs/runs/store.ts` (the shipped artefact)

```ts
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { JobKind, RunTrigger } from '@enkaku/protocol'
import { changedRows, type Db } from '../../db'
import { jobRuns, jobs, type JobRow, type JobRunRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'

export interface CreateJobInput {
  kind: JobKind
  /** Required for `kind: 'script'`, refused for `kind: 'workflow'`. */
  scriptId?: string
  /** Required for `kind: 'workflow'`, refused for `kind: 'script'`. */
  workflowName?: string
  /** The snapshot (`WorkflowStore.snapshotForJob`, plan 210 §4.4). Required with `workflowName`. */
  workflowDoc?: unknown
  deviceId: string
  params: unknown
  scriptName: string | null
  scriptVersion: string | null
  batchId?: string | null
  batchSeq?: number | null
  scheduleId?: string | null
  parentWorkflowJobId?: string | null
  stepSeq?: number | null
  triggeredByJobId?: string | null
  rootJobId?: string | null
  depth?: number
  triggerKey?: string | null
  createdBy?: string | null
}

export interface AddRunInput {
  trigger: RunTrigger
  priority?: number
  expiresAt?: number | null
  notBefore?: number | null
  batchRepeat?: number | null
  pacedDelayMs?: number | null
  maxConcurrent?: number | null
  /** Omitted carries the previous run's value forward (plan 211 §3.2 decision 12 mirrors `job-service.ts`'s old `resume()`). */
  runtimeOverride?: unknown
  resumedFromRunId?: string | null
  resumedFromStep?: number | null
}

export interface SettleRunInput {
  status: 'success' | 'failed' | 'cancelled'
  result?: unknown
  error?: string
  failureClass?: string | null
  errorPhase?: string | null
  peakRssBytes?: number | null
  resultStatus?: string | null
  resultBytes?: number | null
  resultSummary?: string | null
  resultIssues?: unknown
}

export interface RunStore {
  /** Inserts the job row only. A job with no run is legal and invisible to the queue. */
  createJob(input: CreateJobInput): JobRow
  /**
   * Inserts a run at `seq = job.run_count + 1`, status `queued`, and updates
   * `latest_run_id`/`run_count` in the SAME transaction. Throws
   * `job_not_found`. `deviceId` and `scriptName` are copied from the job.
   */
  addRun(jobId: string, input: AddRunInput): JobRunRow
  /**
   * MVP 14 §2 and §6 item 2: adds a run when `params`, `scriptId`/
   * `workflowName`, `deviceId` and `kind` all match the job; otherwise
   * creates a NEW job (copying `batchId`, `batchSeq`, `scheduleId`,
   * `createdBy`) and adds its first run. `sameJob` says which happened.
   */
  addRunOrNewJob(jobId: string, params: unknown, input: AddRunInput): { job: JobRow; run: JobRunRow; sameJob: boolean }
  getJob(jobId: string): JobRow | null
  getRun(runId: string): JobRunRow | null
  latestRun(jobId: string): JobRunRow | null
  runs(jobId: string): JobRunRow[]
  /** The latest run of each of these jobs, in one statement (the list projection and `recomputeBatchStatus`). */
  latestRuns(jobIds: string[]): Map<string, JobRunRow>
  /** Terminal settle. Only ever touches a `running` row, mirroring today's `finish()`. Returns null when it did not. */
  settle(runId: string, input: SettleRunInput): JobRunRow | null
  /** `queued` to `cancelled`. */
  cancelQueuedRun(runId: string): JobRunRow | null
  /** Every run of every member job of a batch, newest generation first. */
  runsByBatch(batchId: string): JobRunRow[]
  /**
   * Deletes runs and recomputes `latest_run_id`/`run_count` for every job
   * they belonged to, in one transaction. The ONLY delete path for a run;
   * `purge.ts` and the retention sweeper both go through it.
   */
  deleteRuns(runIds: string[]): { runs: number; jobsTouched: string[] }
}

export function createRunStore(db: Db): RunStore
```

Rules the implementation must follow:

- `addRun` runs `db.transaction(..., { behavior: 'immediate' })` and reads `run_count` inside it, so two concurrent adds cannot claim the same `seq` (`uniqueIndex('idx_job_runs_seq')` is the backstop, not the mechanism).
- `latest_run_id` is always the surviving run with the highest `seq`, and `run_count` is always `SELECT count(*) FROM job_runs WHERE job_id = ?`. Both are recomputed, never incremented, inside `deleteRuns`.
- A settle never writes a column its input omitted (the "never overwrite a real value with undefined" rule `jobStore.finish` already follows).
- `addRunOrNewJob` compares params through `JSON.stringify` of a key-sorted clone, never `===` on the parsed objects.
- Nothing in this file broadcasts, audits or kicks the scheduler; that is the caller's job, as it is for `jobStore.enqueue` today.

### 4.4 `packages/core/src/jobs/runs/watcher.ts` (new)

```ts
import type { JobRunRow } from '../../db/schema'

/**
 * How the workflow orchestrator waits on a step's child run without polling
 * (plan 211 §3.2 decision 14). `executor-host.ts`'s settle path, the expiry
 * reaper and `JobService.cancel` are its producers.
 */
export interface RunWatcher {
  /**
   * Resolves with the run row the moment its status is terminal. Re-reads
   * the row on subscription first, so a run that settled between the
   * enqueue and this call resolves immediately. Rejects with
   * `EnkakuError('job_cancelled')` when `signal` aborts.
   */
  waitForTerminal(runId: string, signal: AbortSignal): Promise<JobRunRow>
  /** Called by every producer with the settled row. Unknown ids are ignored. */
  notify(run: JobRunRow): void
}

export function createRunWatcher(deps: { getRun: (runId: string) => JobRunRow | null }): RunWatcher
```

### 4.5 The workflow orchestrator (`packages/core/src/jobs/executors/workflow.ts`, rewritten)

```ts
export interface WorkflowOrchestratorDeps {
  db: Db
  runs: RunStore
  watcher: RunWatcher
  registry: ScriptRegistry
  /** Enqueue one step job and its first run, then kick the scheduler. `services/job-service.ts`'s `enqueueStep`. */
  enqueueStep: (input: {
    parentWorkflowJobId: string
    stepSeq: number
    scriptId: string
    deviceId: string
    params: Record<string, unknown>
    scriptName: string
    scriptVersion: string
    priority: number
  }) => { job: JobRow; run: JobRunRow }
  /** Cancels a step's run when the workflow run is cancelled (`JobService.cancel`). */
  cancelRun: (runId: string) => void
  /** Read fresh on every check (`workflow.maxTotalMs`). */
  settings: () => { maxTotalMs: number }
  log: Logger
}

export function createWorkflowOrchestrator(deps: WorkflowOrchestratorDeps): JobExecutor
```

`run(job, ctx)`, where `ctx` now carries `runId` (§4.7):

1. `const doc = parseWorkflowDoc(job.workflowDoc)` (plan 210's reader). `null` throws `EnkakuError('E_WORKFLOW_INVALID', ...)`. The `workflows` table is never read at run time; the snapshot is the truth.
2. If this run's `trigger` is `'resume'`: read `workflow_steps` of `resumedFromRunId`; every step with `status = 'success'` before `resumedFromStep` is inserted into THIS run as a `carried-over` step (same `stepId`, same `jobId`/`jobRunId`, same `output`), and its output is seeded into `outputs`. The cursor starts at the document step named by the carried-over run's step at `resumedFromStep`.
3. Loop, exactly the cursor machinery the current file has (`followOutcome`, `followSuccess`, `nextInArray`, `maxSteps`, `maxTotalMs`, `runCounts`), with these two step bodies:
   - **gate**: `evaluatePredicate(node.when, scope)` unchanged; write the `workflow_steps` row with `verdict: trace`, `status: 'success'`, `output: { value, branch }`; follow the outcome.
   - **script**: resolve `node.script` through the registry and resolve `node.params` through `resolveValue` exactly as today; insert the `workflow_steps` row `status: 'running'`; call `deps.enqueueStep(...)`; write `jobId`/`jobRunId` onto the step row; `const settled = await deps.watcher.waitForTerminal(run.id, ctx.signal)`; on `success` set `output` (through the existing `capOutput`) and `outputs.set(node.id, settled.result)`; on `failed`/`cancelled`/`expired` set `error`/`errorCode` from the child run and follow `node.onFailure` (a cancel ends the workflow run regardless, as today).
4. `doc.onFail`: the same cleanup, as one more step job at `stepId = '_on_fail'`, best effort, only on a genuine failure and never on a cancel.
5. Every document step the cursor never reached is written as `status: 'skipped'` in the `finally`, as today.
6. `ctx.signal` aborting calls `deps.cancelRun(currentChildRunId)` before rethrowing, so a cancelled workflow does not leave its step running.
7. The return value is the same `RunSummaryEntry[]` shape the current executor returns, built from the step rows.

**Not** in this file any more: `deps.runner`, `deps.sessions`, `deps.nodeTracker`, `deps.onNode`, `jobNodes`, `jobResumes`, `ON_FAIL_NODE_ID` as a `job_nodes` id, and the `sessions.acquire`/`release` pair. The orchestrator holds the device through its own `workflow-job:<runId>` activity (plan 205) and nothing else; each step job acquires and releases the session itself, exactly as an ordinary script job does.

### 4.6 The claim (`packages/core/src/queue/job-store.ts`)

The statement today (`packages/core/src/queue/job-store.ts:480` `claimNext(jobTtlSec, excludeDeviceIds) {`), after plan 205 has renamed the column and replaced the device predicate:

```sql
UPDATE jobs
SET status = 'running',
    heartbeat_expires_at = strftime('%s','now') + ${jobTtlSec},
    started_at = strftime('%s','now')
WHERE id = (
  SELECT j.id FROM jobs j
  JOIN devices d ON d.id = j.device_id
  LEFT JOIN batches b ON b.id = j.batch_id
  WHERE j.status = 'queued'
    AND d.status = 'online'
    AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.device_id = j.device_id AND r.status = 'running')
    ${excludeClause}
    AND (
      j.batch_id IS NULL
      OR b.concurrency = 0
      OR (SELECT COUNT(*) FROM jobs r
          WHERE r.batch_id = j.batch_id AND r.status = 'running') < b.concurrency
    )
    AND (
      j.max_concurrent IS NULL
      OR j.max_concurrent = 0
      OR (SELECT COUNT(*) FROM jobs r
          WHERE r.script_name = j.script_name AND r.status = 'running') < j.max_concurrent
    )
    AND (j.not_before IS NULL OR j.not_before <= strftime('%s','now'))
  ORDER BY j.priority DESC, j.created_at ASC, j.batch_seq ASC
  LIMIT 1
)
RETURNING *
```

The statement after this plan, in full:

```sql
UPDATE job_runs
SET status = 'running',
    heartbeat_expires_at = strftime('%s','now') + ${jobTtlSec},
    started_at = strftime('%s','now')
WHERE id = (
  SELECT r.id FROM job_runs r
  JOIN jobs j ON j.id = r.job_id
  JOIN devices d ON d.id = r.device_id
  LEFT JOIN batches b ON b.id = j.batch_id
  WHERE r.status = 'queued'
    AND d.status = 'online'
    -- One execution per device, with ONE exemption: a device held by a
    -- workflow job admits that workflow job's own step runs (plan 211 §3.2
    -- decision 8). `x.job_id <> j.parent_workflow_job_id` is false exactly
    -- for the parent's own run, so a sibling step, an unrelated job and a
    -- second workflow all still block.
    AND NOT EXISTS (
      SELECT 1 FROM job_runs x
      WHERE x.device_id = r.device_id
        AND x.status = 'running'
        AND (j.parent_workflow_job_id IS NULL OR x.job_id <> j.parent_workflow_job_id)
    )
    ${excludeClause}
    AND (
      j.batch_id IS NULL
      OR b.concurrency = 0
      OR (SELECT COUNT(*) FROM job_runs r2
          JOIN jobs j2 ON j2.id = r2.job_id
          WHERE j2.batch_id = j.batch_id AND r2.status = 'running') < b.concurrency
    )
    AND (
      r.max_concurrent IS NULL
      OR r.max_concurrent = 0
      OR (SELECT COUNT(*) FROM job_runs r3
          WHERE r3.script_name = r.script_name AND r3.status = 'running') < r.max_concurrent
    )
    AND (r.not_before IS NULL OR r.not_before <= strftime('%s','now'))
  ORDER BY r.priority DESC, r.created_at ASC, j.batch_seq ASC
  LIMIT 1
)
RETURNING *
```

`${excludeClause}` becomes `AND r.device_id NOT IN (...)` (the same builder, one column name changed). The transaction still runs `{ behavior: 'immediate' }` and still returns `{ job, run, deviceId }` after re-reading both rows; plan 205 has already deleted the `UPDATE devices SET status = 'busy'` statement that followed it.

Interface changes on `JobStore` (`packages/core/src/queue/job-store.ts:239` onward):

| Today | After |
|---|---|
| `claimNext(jobTtlSec, excludeDeviceIds?): ClaimedJob \| null` | same signature; `ClaimedJob` becomes `{ job: JobRow; run: JobRunRow; deviceId: string }` |
| `renewHeartbeat(jobId, ttlSec): boolean` (plan 205's rename) | `renewHeartbeat(runId, ttlSec): boolean` |
| `expiredRunning(): JobRow[]` (`:297`) | `expiredRunning(): JobRunRow[]` |
| `expireQueued(): JobRow[]` | `expireQueued(): JobRunRow[]`, one `UPDATE job_runs ... RETURNING *` |
| `failOrphanRunning(): number` (`:307`) | unchanged in name; updates `job_runs` |
| `runningByDevice(deviceId): JobRow \| null` | `runningByDevice(deviceId): JobRunRow \| null` |
| `requeueForRebind(jobId, newDeviceId): JobRow \| null` (`:282`) | `requeueForRebind(runId, newDeviceId): JobRunRow \| null`; writes `job_runs.device_id`, `jobs.device_id`, `infra_attempts + 1`, `status: 'queued'`, `started_at: null`, `heartbeat_expires_at: null` in one transaction |
| `listByBatch(batchId): JobRow[]` (`:284`) | stays (member JOBS); `latestRuns(...)` from the run store supplies their statuses |
| `nodes?(jobId)`, `recordResume?(...)`, `resumeInfo?(...)`, `assists(jobId)` | deleted (`assists` is already deleted by plan 205) |
| `nextQueuedJobId(deviceId): string \| null` | `nextQueuedRunId(deviceId): string \| null` |
| `enqueue(input)` | deleted; `runs/store.ts`'s `createJob` + `addRun` replace it, and `services/job-service.ts` is the only caller that composes them |

`rowToJobInfo(row, script)` becomes `rowToJobInfo(job: JobRow, run: JobRunRow | null, script?)`, flattening the latest run per decision 12. `rowToJobDetail` gains `runs`. `rowToJobNodeInfo` is deleted.

### 4.7 The runner seam (`packages/session`)

```ts
// packages/session/src/runner/job-runner.ts, `JobSpec`:
export interface JobSpec {
  /** The JOB id. Author-facing: `ENKAKU_JOB_ID`, the KV namespace fallback, `ctx.jobs`'s `jobId`, `InputSource.id`. */
  id: string
  /**
   * The RUN id (plan 211). Everything this execution STORES or that tracks
   * its liveness keys on it: artifacts, trace events, trace frames and UI
   * captures, the phase/heartbeat/progress/retry callbacks, and the
   * runner's own `active` map (so `abort()` takes a run id).
   */
  runId: string
  deviceId: string
  bundlePath: string
  params: unknown
  scriptExportId?: string
  reset?: 'farm' | 'none'
  retries?: number
  // `nodeId` DELETED: a workflow step is a job of its own.
}
```

Edits inside `job-runner.ts`, all mechanical: `deps.artifacts(job.runId)`, `deps.onArtifact(job.runId, ...)`, `deps.onPhase(job.runId, ...)`, `deps.heartbeat(job.runId)`, `deps.onTraceEvent(job.runId, ...)`, `deps.onProgress(job.runId, ...)`, `deps.onReset(job.runId, ...)`, `deps.onRetry(job.runId, ...)`, `deps.onTargetPackages(job.runId, ...)`, `putFrame(job.runId, ...)`, `putUiTree(job.runId, ...)`, `active.set(job.runId, ...)`, `active.delete(job.runId)`. Unchanged and deliberately still `job.id`: `ENKAKU_JOB_ID`, the child `init` payload's `job.id`, `kv.call({ jobId: job.id, ... })`, `jobs.call({ jobId: job.id, ... })`, `farm.call({ jobId: job.id, ... })`, `const source: InputSource = { kind: 'job', id: job.id, userId: null }`. The child `init` payload's `job.nodeId` field is deleted.

`ExecutorContext` (`packages/core/src/jobs/executor.ts`) gains `runId: string` beside `heartbeat()`, and `heartbeat()` renews the run. `ExecutorHost.start(job)` becomes `start(job: JobRow, run: JobRunRow)`; `abort(runId)`; `finishExternally(runId, status, error, code?)`; `notifyCrash(runId, e)`; `progress(runId, value)`. `settle` writes through `runs.settle(run.id, ...)`, ends the `job:<runId>` (or `workflow-job:<runId>`) activity, and calls `deps.watcher.notify(settled)`. `requeueForRebind` keeps the same run (decision 6) and does **not** notify the watcher.

### 4.8 Routes

Whole-request refusals use `{ error: { code, message } }` as everywhere else. `job.view` and `job.run` are the existing permissions; nothing new is invented.

| Method | Path | Permission | Body / query | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/jobs` | none (unchanged) | `?deviceId`, `?status` (matches the LATEST run), `?kind`, `?rootJobId`, `?parentWorkflowJobId`, `?cursor`, `?limit` | `200 JobsPageResponseSchema` (`JobInfo` = job + latest run) | none |
| GET | `/api/jobs/:id` | none | none | `200 JobResponseSchema` (`JobDetail` with `runs` newest first) | `404 job_not_found` |
| GET | `/api/jobs/:id/runs` | none | `?limit` | `200 JobRunsResponseSchema` | `404 job_not_found` |
| GET | `/api/jobs/:id/runs/:runId` | none | none | `200 JobRunResponseSchema` | `404 job_not_found`, `404 run_not_found` (also when the run belongs to another job) |
| GET | `/api/jobs/:id/runs/:runId/logs` | none | none | `200 JobLogsResponseSchema` | `404 job_not_found`, `404 run_not_found` |
| GET | `/api/jobs/:id/runs/:runId/trace` | `job.view` | `?after`/`?cursor`, `?limit`, repeatable `?kind` | `200 JobTraceResponseSchema` | as above |
| GET | `/api/jobs/:id/runs/:runId/trace/frames/:hash` | `job.view` | none | `200` image bytes | as above, `404 frame_not_found` |
| GET | `/api/jobs/:id/runs/:runId/trace/ui/:hash` | `job.view` | none | `200` JSON | as above, `404 ui_not_found` |
| GET | `/api/jobs/:id/runs/:runId/artifacts` | `job.view` | none | `200 RunArtifactsResponseSchema` | as above |
| POST | `/api/jobs/:id/cancel` | none (ownership via `canCancelJob`, unchanged) | `?cancelDescendants=1` | `200 JobCancelResponseSchema` | `404 job_not_found`, `409 job_not_cancellable`, `403 auth.forbidden` |
| DELETE | `/api/jobs/:id` | `job.run` | none | `200 JobDeleteResponseSchema` | `404 job_not_found`, `409 job_not_settled`, `403 auth.forbidden` |
| POST | `/api/jobs/history/clear` | `job.history.purge` | unchanged | unchanged | unchanged |
| GET | `/api/workflow-jobs/:id/runs/:runId/steps` | `job.view` | none | `200 WorkflowStepsResponseSchema` | `404 job_not_found` (also when `kind != 'workflow'`), `404 run_not_found` |
| POST | `/api/workflow-jobs/:id/resume` | `job.run` | `{ fromStep?: number }` | `201 WorkflowResumeResponseSchema` | `404 job_not_found`, `409 job_not_terminal` (the latest run has not settled), `400 step_not_found` (`fromStep` never ran in that run), `403 auth.forbidden` |
| POST | `/api/actions/run-script` | `job.run` (plan 207) | plan 207's body **plus** `jobId?: string` | `202 ActionResponseSchema`; each result carries `jobId`, `batchId` and, new, `runId` | plan 207's set plus `404 job_not_found` |
| POST | `/api/actions/run-workflow` | `job.run` | `{ target, workflowName, params?, jobId? }` | `202 ActionResponseSchema` | plan 207's set plus `404 workflow_not_found`, `400 invalid_job_params` |
| POST | `/api/batches/:id/rerun-failed` | `job.run` | none | `201 BatchResponseSchema` | `404 batch_not_found`, `409 E_NO_TARGETS`, `409 params_incompatible` |
| POST | `/api/batches/:id/rerun` | `job.run` | `?only=failed\|skipped` | `201 BatchResponseSchema` | as above, `400 E_BAD_REQUEST` |
| GET | `/api/schedules/:id/jobs` | none | `?limit` | `200 JobsPageResponseSchema` | `404 schedule_not_found` |
| POST | `/api/schedules/:id/run-now` | `job.run` | `{}` | `200` unchanged shape, `batchId` is the schedule's own batch | unchanged |

Deleted routes: `GET /api/jobs/:id/nodes` (`api/jobs.ts:384`), `POST /api/jobs/:id/resume` (`:549`), `GET /api/jobs/:id/logs` (`:351`, replaced by the run path), `GET /api/jobs/:id/trace` and the two hash reads (`:412`, `:467`, `:483`, replaced by the run paths), `GET /api/schedules/:id/runs` (`api/schedules.ts:636`). `GET /api/jobs/:id/assists` (`:368`) is already deleted by plan 205.

`POST /api/actions/run-script` and `run-workflow` with `jobId` (plan 207 §4.3 step 6, `run-script`'s row in the implementation table):

1. Load the job; `404 job_not_found` when absent.
2. `runs.addRunOrNewJob(jobId, params, { trigger: 'rerun', priority, expiresAt, runtimeOverride })`.
3. The target is ignored: a job names its own device. A request that sends both `jobId` and a target naming a different device is `400 E_BAD_REQUEST` with the message `` `job ${jobId} runs on ${job.deviceId}; drop the target or drop jobId` ``.
4. The single result carries `{ deviceId, status: 'accepted', jobId: result.job.id, runId: result.run.id }` and, when `sameJob` is false, the message `parameters differ from the job's, so this is a new job`.

Without `jobId`, both verbs behave as plan 207 specifies (always a batch), with `run-workflow` no longer throwing `E_NOT_SUPPORTED`: it snapshots the document through `WorkflowStore.snapshotForJob(workflowName)` and creates one `kind: 'workflow'` job per accepted device inside the same `createBatch` transaction.

### 4.9 Retention (`packages/core/src/jobs/runs/sweeper.ts`, interface only)

```ts
import type { Db } from '../../db'
import type { RunStore } from './store'

/**
 * The seam MVP 09 §6 and MVP 14 §5 need: runs expire individually, and a job
 * with no runs that no schedule owns is swept with them. Plan 224 writes the
 * policy (the defaults, the nightly cadence, the Storage row in Settings) and
 * wires this into `maintenance/retention.ts`. Plan 211 ships the interface and
 * nothing else: there is no implementation, no caller, and no setting.
 */
export interface RunRetentionPolicy {
  /** Runs finished longer ago than this are candidates. */
  runDays: number
  /** Never sweep the latest run of a job, whatever its age. */
  keepLatest: boolean
  /** Rows per transaction, so a first sweep after an upgrade cannot hold the write lock. */
  chunk: number
}

export interface RunRetentionSweeper {
  /**
   * One pass. Deletes candidate runs through `RunStore.deleteRuns` (the one
   * delete path, so `latest_run_id`/`run_count` stay honest), then deletes
   * every job it touched that has `run_count = 0` AND `schedule_id IS NULL`
   * AND `parent_workflow_job_id IS NULL`. Returns what it removed.
   */
  sweepOnce(): { runs: number; jobs: number }
}

/** Plan 211 ships this and only this: a sweeper that removes nothing. */
export const NO_OP_RUN_SWEEPER: RunRetentionSweeper = { sweepOnce: () => ({ runs: 0, jobs: 0 }) }

export type CreateRunRetentionSweeper = (deps: { db: Db; runs: RunStore; policy: RunRetentionPolicy }) => RunRetentionSweeper
```

### 4.10 The migration boot step (`packages/core/src/db/migrations/jobs-to-runs.ts`)

```ts
export const JOBS_TO_RUNS_TAG = '00XX_<the tag db:generate produced for this plan>'
export const MARKER_ID = 'jobs-to-runs-211'

export interface JobsToRunsReport {
  ranAt: string
  jobs: number
  runs: number
  events: number
  artifacts: number
  traceDirs: number
  artifactDirs: number
  /** `<jobId>` of every resume chain folded into the earliest job of the chain (MVP 14 §3). */
  resumeChainsFolded: string[]
  /** `schedule_runs` rows dropped because their batch or job no longer exists (MVP 14 §3). */
  scheduleRunsDropped: number
  /** Directories that could not be renamed; their rows still point at the run. */
  unmovedDirs: string[]
}

export function migrateJobsToRuns(db: Db, deps: { log: Logger; dataDir: string }): JobsToRunsReport | null
```

Algorithm. Everything except the two directory renames runs inside one `db.transaction`; the renames run after the commit, and a failure is logged, never thrown (a leaked directory is strictly better than an aborted migration, the same rule `maintenance/retention.ts`'s trace sweep already states).

1. Return `null` if the marker exists.
2. For every `jobs` row, in `created_at` order, insert one `job_runs` row: `id = crypto.randomUUID()`, `job_id`, `seq = 1`, `trigger = job.batch_id ? 'batch' : 'manual'` (MVP 14 §3), and every execution column copied verbatim from the job row (`status`, `heartbeat_expires_at`, `result`, `error`, `started_at`, `finished_at`, `expires_at`, `not_before`, `batch_repeat`, `paced_delay_ms`, `failure_class`, `error_phase`, `infra_attempts`, `peak_rss_bytes`, `max_concurrent`, `runtime_override`, `result_status`, `result_bytes`, `result_summary`, `result_issues`, `priority`), `created_at = job.created_at`, `device_id = job.device_id`, `script_name = job.script_name`. Set `jobs.latest_run_id` and `jobs.run_count = 1`. Build `runIdByJobId`.
3. **Resume chains** (MVP 14 §3): read `job_resumes`; for each chain, walk `resumed_from_job_id` to the earliest job; move every later job's run onto that job with `seq` in chain order, `trigger = 'resume'`, `resumed_from_run_id` = the previous run in the chain, `resumed_from_step = null` (the old `resumed_from_node` was a document node id, and there is no step table for a pre-migration run); delete the now-empty later `jobs` rows; recompute `latest_run_id`/`run_count`. Every folded chain's root id goes into the report.
4. **Workflow rows**: every `jobs` row whose `workflow_doc` is non-null gets `kind = 'workflow'`, `workflow_name = script_name`, `script_id = NULL`. `job_nodes` rows are **not** converted into `workflow_steps`: the two tables mean different things (a node execution inside one process versus a step that owns a job), and inventing job ids for steps that never had one would be fabrication. They are counted and named in one `warn` line, then dropped with the table.
5. `UPDATE job_events SET run_id = <run of its job_id>`, `UPDATE artifacts SET run_id = <run of its job_id> WHERE job_id IS NOT NULL`. A row whose job no longer exists (an orphan) is deleted and counted.
6. `schedule_runs`: for every row with `outcome = 'dispatched'` and a `batch_id` that still exists, set that batch's `schedules.batch_id` if the schedule has none, and copy the newest row's `outcome`/`detail` onto `schedules.last_fire_outcome`/`last_fire_detail`. Everything else is counted into `scheduleRunsDropped`. The table is then dropped by the generated migration.
7. Insert the marker; commit.
8. After the commit, for each `(jobId, runId)`: `rename(<dataDir>/traces/<jobId>, <dataDir>/traces/<runId>)` and `rename(<dataDir>/artifacts/<jobId>, <dataDir>/artifacts/<runId>)` when the source exists; `UPDATE artifacts SET path = replace(path, 'artifacts/<jobId>/', 'artifacts/<runId>/')` for the rows of that job. A rename failure adds the directory to `unmovedDirs`.
9. Log once, at `info`: `` `jobs-to-runs: ${jobs} job(s) now hold ${runs} run(s); re-keyed ${events} trace event(s) and ${artifacts} artifact(s); moved ${traceDirs} trace and ${artifactDirs} artifact directories` ``; at `warn` when `resumeChainsFolded` is non-empty, naming the roots; at `warn` when `scheduleRunsDropped > 0` with the sentence `` `${n} schedule fire record(s) were dropped: a schedule's history is now its jobs' runs (docs/mvp/14-jobs-and-runs.md §3)` ``; at `warn` when `unmovedDirs` is non-empty, naming them and saying the rows already point at the run.

Called in `daemon.ts` directly after plan 210's `migrateWorkflowsFromScripts(...)`, before `createScriptRegistry`.

### 4.11 File structure after this plan

```
packages/core/src/
  jobs/runs/store.ts, store.test.ts              NEW  (§4.3, the shipped artefact)
  jobs/runs/watcher.ts, watcher.test.ts          NEW  (§4.4)
  jobs/runs/sweeper.ts                           NEW  (§4.9, interface only, no test)
  jobs/executors/workflow.ts                     REWRITTEN (§4.5)
  jobs/executors/workflow.test.ts                NEW  (G3)
  jobs/executor.ts, executor-host.ts             EDITED (§4.7)
  jobs/purge.ts                                  EDITED (runs, no nodes)
  queue/job-store.ts                             EDITED (§4.6)
  queue/scheduler.ts, queue/expiry.ts            EDITED (runs)
  clusters/dispatch.ts, pacer.ts, status.ts      EDITED (§3.2 decision 3)
  schedules/runner.ts                            EDITED (§3.2 decision 4)
  services/job-service.ts                        EDITED (enqueue/enqueueStep/cancel; resume deleted)
  api/jobs.ts                                    EDITED (§4.8)
  api/workflow-jobs.ts, workflow-jobs.test.ts    NEW  (§4.8)
  api/batches.ts, api/schedules.ts, api/actions.ts  EDITED (§4.8)
  api/actions-runs.test.ts, api/batches-runs.test.ts  NEW
  runner/artifact-store.ts                       EDITED (runId; JobNodeTracker deleted)
  jobs/trace/recorder.ts, trace/frame-store.ts   EDITED (runId)
  db/migrations/jobs-to-runs.ts, .test.ts        NEW  (§4.10)
packages/core/drizzle/00XX_<name>.sql            GENERATED
packages/protocol/src/messages/job.ts            EDITED (§4.2.1)
packages/protocol/src/api/jobs.ts                EDITED (§4.2.2)
packages/protocol/src/api/workflow-jobs.ts       NEW  (§4.2.3)
packages/session/src/runner/job-runner.ts        EDITED (§4.7)
```

## 5. Implementation steps

Read plan 200 §2 and `CLAUDE.md` before the first edit. Every `path:line` was read on 2026-09-03; match on the quoted content when a line has moved. Commit per step as `feat(mvp-211): …` or `chore(mvp-211): …`.

### 211.1 Schema and migration shape

- Files changed: `packages/core/src/db/schema.ts` (§4.1: rewrite `jobs` at `:394`; add `jobRuns` and `workflowSteps` after it; edit `artifacts` at `:1049` and `jobEvents` at `:1091`; edit `schedules` at `:1303`; delete `jobNodes` at `:1003`, `jobResumes` at `:1164`, `scheduleRuns` at `:1382` and their row types).
- Files created: `packages/core/drizzle/00XX_<name>.sql` and its `meta/` entries, by running `bun run --cwd packages/core db:generate` exactly once after every schema edit. Never hand-write the SQL. Answer **rename** to all three prompts (§4.1.5).
- Test file: `packages/core/src/jobs/runs/store.test.ts` (written in 211.2) carries the `PRAGMA table_info` assertions.
- Verifiable result: a second `db:generate` prints `No schema changes, nothing to migrate`; G1.
- Do not: keep `jobs.status` "so the list query stays simple", and do not add a `jobs.latest_run_status` column. The list joins `latest_run_id`; a second cached status is a second truth.

### 211.2 The run store

- Files created: `packages/core/src/jobs/runs/store.ts` (§4.3), `packages/core/src/jobs/runs/store.test.ts`.
- Test file: `store.test.ts`: `a fresh database has job_runs, workflow_steps and a jobs table with no execution columns` (the G1 PRAGMA list, plus `SELECT sql FROM sqlite_master WHERE name = 'idx_job_runs_seq'` contains `UNIQUE`); `run_count and latest_run_id follow every add, settle and delete` (G5); `addRun assigns dense seq under two concurrent callers` (two `addRun` calls inside `Promise.all`, seqs `1` and `2`, no unique-index error); `addRunOrNewJob adds a run for identical params and creates a job for different ones`; `settle only ever touches a running run`; `deleteRuns recomputes both denormalised fields for every job it touched`; `createJob refuses a script job with workflowName and a workflow job with scriptId`.
- Verifiable result: `bun test packages/core/src/jobs/runs/store.test.ts` passes; G1, G5.
- Do not: increment `run_count` with `run_count + 1`. Recompute it from `count(*)` inside the same transaction, so a delete and an add can never disagree.

### 211.3 Protocol

- Files changed: `packages/protocol/src/messages/job.ts` (§4.2.1: add `RunTriggerSchema`, `JobKindSchema`, `JobRunInfoSchema`, `JobRunDetailSchema`; extend `JobInfoSchema` at `:73` and `JobDetailSchema` at `:184`; delete `JobNodeStatusSchema` at `:276`, the `node` block inside `JobStatusEventMessage` at `:279`, `JobResumeRequestSchema` at `:465`, `JobResumeResponseSchema` at `:476`, `ArtifactInfoSchema.nodeId` at `:331`; rename `ArtifactInfoSchema.jobId` to `runId`; add `runId` to `JobLogMessage` at `:311`, `JobArtifactMessage`, `JobProgressEventMessage`, `JobTraceMessage` and `JobWaitingMessage` at `:438`), `packages/protocol/src/api/jobs.ts` (§4.2.2), `packages/protocol/src/index.ts` (barrel), `packages/protocol/README.md` (the job paragraph: a job is an intent, a run is an execution).
- Files created: `packages/protocol/src/api/workflow-jobs.ts` (§4.2.3).
- Files deleted: `packages/protocol/src/messages/job.test.ts`'s node and resume describes if the file exists (delete the whole file only if every test in it is about them; say which in §11).
- Test file: `packages/protocol/src/api/jobs.test.ts` (rewrite the node-shape tests as run-shape tests: a `JobRunInfo` parses, a `JobInfo` with `runCount: 0` and `runId: null` parses, an unknown `trigger` fails, `JobStatusEventMessage` refuses an extra `node` key).
- Verifiable result: `bun test packages/protocol/src/api/jobs.test.ts` passes; `rg -n "JobNodeStatusSchema\|JobNodesResponseSchema\|JobResumeRequestSchema" packages/protocol` prints nothing.
- Do not: keep `JobResumeRequestSchema` "for the workflow route"; the workflow resume body is `WorkflowResumeRequestSchema` and takes a step index, not a node id.

### 211.4 The claim, the heartbeat and the reapers

- Files changed: `packages/core/src/queue/job-store.ts` (§4.6: `claimNext` at `:480`, `renewHeartbeat` at `:720`, `expiredRunning` at `:732`, `expireQueued`, `failOrphanRunning` at `:757`, `requeueForRebind` at `:641`, `runningByDevice`, `nextQueuedRunId`, `rowToJobInfo`, `rowToJobDetail`; delete `enqueue`, `nodes`, `recordResume`, `resumeInfo`, `rowToJobNodeInfo` and the `jobNodes`/`jobResumes` imports), `packages/core/src/queue/scheduler.ts` (claim the run: `deps.host.start(claimed.job, claimed.run)`; the activity id becomes `job:<runId>`/`workflow-job:<runId>` with `href` `/jobs/detail?id=<jobId>&run=<runId>`, §3.2 decision 9; `computeControlBlocked` and `computePacedBlocked` read `job_runs`), `packages/core/src/queue/expiry.ts` (`expireQueued` returns runs; `onJobStatus` is built from the job plus the run).
- Test file: `packages/core/src/queue/job-store.test.ts` (rewrite the claim describes: `claims one run at a time per device`, `a workflow step run is claimed while its own parent workflow job is running on that device`, `an unrelated run is not claimed while a workflow job runs on that device`, `a second step of the same workflow is not claimed while the first step runs`, `batch concurrency counts running runs across member jobs`, `maxConcurrent counts running runs by script name`, `not_before is respected`, `heartbeat_expires_at is written on claim`, `requeueForRebind keeps the run and increments infra_attempts`), `packages/core/src/queue/expiry.test.ts` (an expired queued run becomes `expired`; a heartbeat-expired running run is failed with `HEARTBEAT_EXPIRED`).
- Verifiable result: `bun test packages/core/src/queue/` passes; G4.
- Do not: pre-filter the workflow-parent exemption in TypeScript. It is a claim gate and belongs in the one SQL statement, for the reason this file's own opening comment gives about race safety.

### 211.5 The executor host and the runner seam

- Files changed: `packages/session/src/runner/job-runner.ts` (§4.7), `packages/session/src/runner/child-entry.ts` (drop `job.nodeId` from the init payload), `packages/session/src/runner/jobs-client.ts` (the default idempotency key no longer folds in `nodeId`), `packages/core/src/jobs/executor.ts` (`ExecutorContext.runId`; `heartbeat()` renews the run), `packages/core/src/jobs/executor-host.ts` (`start(job, run)`, `abort(runId)`, `finishExternally(runId, ...)`, `notifyCrash(runId, ...)`, `progress(runId, ...)`; `settle` writes through `runs.settle`, ends the activity by run id, and calls `watcher.notify`; `requeueForRebind` keeps the run), `packages/core/src/jobs/executors/script.ts`, `remote.ts`, `sleep.ts`, `install.ts` (pass `runId` into `runner.execute`), `packages/core/src/jobs/failure-class.ts` (comment only), `packages/core/src/jobs/log-buffer.ts` (key on runId), `packages/core/src/jobs/trace/recorder.ts` and `trace/frame-store.ts` (`runId` instead of `jobId`, including the `<dataDir>/traces/<runId>` path), `packages/core/src/runner/artifact-store.ts` (`deps.runId`; `artifacts.runId`; delete `JobNodeTracker`, `createJobNodeTracker` and the `nodeId` accessor at `:93`; `registerDeviceArtifact` at `:265` unchanged apart from the renamed column), `packages/core/src/daemon.ts` (wire `runs`, `watcher`, the artifact factory by run id, and delete the `jobNodeTracker` construction plan 210 left in place).
- Files created: `packages/core/src/jobs/runs/watcher.ts`, `packages/core/src/jobs/runs/watcher.test.ts` (a run that is already terminal resolves immediately; a later `notify` resolves a waiter; an aborted signal rejects with `job_cancelled`; a `notify` for an unknown id is ignored).
- Test file: `packages/core/src/jobs/executor-host.test.ts` (settle writes the run and ends `job:<runId>`; the heartbeat touches the activity; `finishExternally` takes a run id), `packages/core/src/jobs/runs/watcher.test.ts`.
- Verifiable result: `bun test packages/core/src/jobs/executor-host.test.ts` and `bun test packages/core/src/jobs/runs/watcher.test.ts` pass.
- Do not: pass the run id as `JobSpec.id`. `ENKAKU_JOB_ID` and `ctx.jobs` are author-facing and must keep naming the job (§3.2 decision 10).

### 211.6 The workflow orchestrator

- Files changed: `packages/core/src/jobs/executors/workflow.ts` (rewritten to §4.5), `packages/core/src/services/job-service.ts` (add `enqueueStep`; `enqueue` composes `runs.createJob` + `runs.addRun`; delete `resume`, `nodes`, `assists`, `defaultResumeNode` and `TERMINAL_JOB_STATUSES`'s resume use), `packages/core/src/services/job-service.test.ts` (delete the `resume` and `nodes` describes; add `enqueueStep writes parentWorkflowJobId and stepSeq`), `packages/core/src/daemon-wiring.test.ts` (delete the node-aware artifacts describe plan 210 left at `:459`), `packages/core/src/daemon.ts` (construct the orchestrator and register it as the executor for `kind: 'workflow'` jobs, through a `jobs.kind` lookup on `ExecutorHost.start`, not through a `ScriptKind` fallback: plan 210 reduced `ExecutorRegistry` to one fallback and this plan keeps it that way).
- Files created: `packages/core/src/jobs/executors/workflow.test.ts`.
- Test file: `workflow.test.ts`, built on an in-memory database with a fake `enqueueStep` that records calls and a real `RunWatcher`: `three script steps become three child script jobs, in order` (three `jobs` rows with `parent_workflow_job_id` and `step_seq` 0,1,2, each with one run at `trigger: 'workflow-step'`, and three `workflow_steps` rows pointing at them); `a gate step records its verdict and branches` (the `verdict` column holds the `PredicateTrace`, `job_id` is null, the cursor follows `then`/`else`); `a failing step ends the workflow run at that step` (`onFailure: { go: 'fail' }`; the workflow run settles `failed` with the child's error code; every unreached step is `skipped`); `resume adds a run that carries over the successful steps and restarts at step N`; `a cancelled workflow run cancels the step run it was waiting on`; `the step budget and maxTotalMs still refuse`.
- Verifiable result: `bun test packages/core/src/jobs/executors/workflow.test.ts` passes; G3.
- Do not: call `deps.runner.execute` or `sessions.acquire` anywhere in this file. A step is a job; the queue and the executor host run it.

### 211.7 Batches

- Files changed: `packages/core/src/clusters/dispatch.ts` (`createBatch` at `:311` creates member JOBS and their first runs with `trigger: 'batch'`; add `addRunsToBatch(deps, batchId, { deviceIds, trigger, priority, expiresAt, pacing })` which creates member jobs for devices that have none and adds a run to each named member), `packages/core/src/clusters/pacer.ts` (`:176`'s `db.insert(jobs)` becomes `runs.addRun(memberJobId, { trigger: 'batch', notBefore, batchRepeat, pacedDelayMs })`), `packages/core/src/clusters/status.ts` (`recomputeBatchStatus` at `:78` counts the member jobs' LATEST runs through `runs.latestRuns`), `packages/core/src/api/batches.ts` (`:766` `POST /` unchanged in body, now creating jobs plus first runs; `:829` `/rerun-failed` and `:889` `/rerun` call `addRunsToBatch` with `trigger: 'rerun'` on the failed or skipped members instead of `createBatch`; `:978` `/results` and `:1051` `/artifacts` read the latest run of each member; `carryForwardShape` now feeds the run, not a new batch).
- Files created: `packages/core/src/api/batches-runs.test.ts`.
- Test file: `batches-runs.test.ts`: `rerun adds a run to every member job`, `rerun-failed adds a run only to jobs whose latest run failed`, `rerun of a batch keeps the batch id and the member job ids`, `a paced repetition is a run, not a job`, `batch status projects the members' latest runs`.
- Verifiable result: `bun test packages/core/src/api/batches-runs.test.ts` passes; G9.
- Do not: create a second batch for a re-run. The batch is the set of jobs; a re-run is a generation of runs inside it (§3.2 decision 3).

### 211.8 Schedules

- Files changed: `packages/core/src/schedules/runner.ts` (`fireOnce` at `:171`: resolve the target; on the first fire `createBatch`, afterwards `addRunsToBatch(..., { trigger: 'schedule' })`; overlap is "any member job has a non-terminal latest run" instead of `isBatchActive`; `cancel-previous` cancels those runs through the same `stopBatch` path; delete the `scheduleRuns` inserts at `:315`, `:478` and `:526` and write `lastFiredAt`/`lastFireOutcome`/`lastFireDetail` instead; the agent branch writes its outcome to the same three columns), `packages/core/src/api/schedules.ts` (delete `GET /:id/runs` at `:636` and the `scheduleRuns` keyset helper; add `GET /:id/jobs`; `rowToScheduleRunInfo` deleted; `POST /:id/run-now` at `:646` unchanged in shape), `packages/protocol/src/api/schedules.ts` (delete `ScheduleRunsPageResponseSchema`), `packages/protocol/src/messages/schedule.ts` (delete `ScheduleRunInfoSchema`; `schedule.fired`'s payload keeps `outcome` and `batchId` and gains `runIds: string[]`), `packages/core/src/db/schema.ts` (already done in 211.1).
- Files deleted: `packages/core/src/jobs/scheduled-batch-version-gate.test.ts`'s `scheduleRuns` assertion (rewrite it to assert the schedule's member job's run instead; delete the file only if every test in it is about the deleted table, and say which in §11).
- Test file: `packages/core/src/schedules/runner.test.ts` (rewrite every `scheduleRuns` assertion): `each fire adds one run with trigger schedule to every member job`, `onOverlap skip adds no run while a previous run is live`, `onOverlap cancel-previous cancels the live runs then adds new ones`, `a device that joins the target gains a member job on the next fire`, `a device that leaves the target keeps its job and gets no new run`, `a resolved script version change creates a new member job`, `a fire that resolves nothing writes last_fire_outcome no-targets and adds no run`.
- Verifiable result: `bun test packages/core/src/schedules/runner.test.ts` passes; G10.
- Do not: keep `schedule_runs` "for history". MVP 14 §4 deletes it; the three scalar columns and the log line are the whole replacement (§3.2 decision 5).

### 211.9 Routes

- Files changed: `packages/core/src/api/jobs.ts` (§4.8: rewrite `GET /` at `:305` and `GET /:id` at `:331`; move `:351` `/logs`, `:412` `/trace`, `:467` and `:483` under `/:id/runs/:runId/`; add `/:id/runs` and `/:id/runs/:runId` and `/:id/runs/:runId/artifacts`; delete `/:id/nodes` at `:384` and `/:id/resume` at `:549`; `/:id/cancel` at `:593` cancels the latest non-terminal run; `DELETE /:id` at `:507` requires every run settled), `packages/core/src/api/actions.ts` (plan 207's file: `run-script` gains `jobId`; `run-workflow` stops throwing `E_NOT_SUPPORTED` and snapshots the document), `packages/core/src/jobs/purge.ts` (`deleteJobsWithHistory` at `:72` deletes runs through `RunStore.deleteRuns`, `job_events` by `run_id`, artifacts by `run_id`, the trace directory per run; the `nodes` counter is deleted from `JobPurgeCounts`), `packages/core/src/jobs/purge.test.ts` (the counts assertion loses `nodes` and gains `runs`), `packages/core/src/device/lifecycle.ts` (the `forget({ deleteHistory: true })` block at `:302`: delete runs before jobs, and reword the comment that still names `job_nodes`), `packages/core/src/server/http.ts` (mount `/api/workflow-jobs`), `packages/core/src/daemon.ts` (wire the new router).
- Files created: `packages/core/src/api/workflow-jobs.ts`, `packages/core/src/api/workflow-jobs.test.ts`, `packages/core/src/api/actions-runs.test.ts`.
- Test file: `workflow-jobs.test.ts` (`steps lists the workflow run's steps in seq order`, `steps 404s for a script job`, `resume adds a run with trigger resume and answers 201`, `resume refuses while the latest run is still running`, `resume with an unknown fromStep is 400`), `actions-runs.test.ts` (G7 and G8's four tests plus `run-script with jobId and a target naming another device is 400`).
- Verifiable result: `bun test packages/core/src/api/workflow-jobs.test.ts` and `bun test packages/core/src/api/actions-runs.test.ts` pass; G7, G8, G11.
- Do not: leave `POST /api/jobs/:id/resume` mounted as an alias. MVP 14 §4 removes it; plan 200 §2.1 forbids the alias.

### 211.10 The migration boot step

- Files created: `packages/core/src/db/migrations/jobs-to-runs.ts` (§4.10), `packages/core/src/db/migrations/jobs-to-runs.test.ts`.
- Files changed: `packages/core/src/daemon.ts` (the call, after plan 210's `migrateWorkflowsFromScripts`), `jobs-to-runs.ts`'s `JOBS_TO_RUNS_TAG` (the tag from 211.1).
- Test file: `jobs-to-runs.test.ts`: open a temp database, `runMigrationsUpTo(db, JOBS_TO_RUNS_TAG)`, insert through raw SQL (the old columns still exist at that point) three jobs (one `success` standalone with two `job_events` rows and one `artifacts` row, one `queued` batch member, one `failed` job with a `job_resumes` row pointing at it from a fourth job), one `schedule_runs` row with `outcome = 'dispatched'`, and create `<dataDir>/traces/<jobId>/abc.png` for the first job; `runMigrations(db, sqlite)`; run the step with a capturing logger and a temp `dataDir`. Assert: `every existing job becomes one run at seq 1 with its history re-keyed` (three surviving jobs, each `run_count = 1`, `latest_run_id` set, `job_events.run_id` and `artifacts.run_id` matching, `<dataDir>/traces/<runId>/abc.png` present and the old directory gone, the artifact's `path` rewritten), `a resume chain is folded into the earliest job` (the fourth job is gone, the third has two runs, seq 2 is `trigger: 'resume'` with `resumed_from_run_id` set), `the schedule adopts its batch and its last outcome`, and `a second run of the step returns null`.
- Verifiable result: `bun test packages/core/src/db/migrations/jobs-to-runs.test.ts` passes; G2.
- Do not: convert `job_nodes` rows into `workflow_steps`. They record node executions inside one process and have no job to point at; count them, name them in the log, and drop them (§4.10 step 4).

### 211.11 The retention seam

- Files created: `packages/core/src/jobs/runs/sweeper.ts` (§4.9 verbatim).
- Files changed: none. Nothing imports it in this plan.
- Test file: none (an interface and a constant; `bun run typecheck` is the check, per plan 200 §8.3's "not tested: anything a typecheck already proves").
- Verifiable result: G12.
- Do not: wire it into `maintenance/retention.ts` or add a setting. Plan 224 owns the policy.

### 211.12 Vocabulary and the removal greps

- Files changed: any file G6 or `GREP_211` still names, including comments and log strings in `packages/core/README.md`, `packages/sdk/README.md` (the workflow node paragraph becomes a workflow step paragraph) and `packages/protocol/README.md`.
- Verifiable result: G6 and G13 print nothing.
- Do not: rename `infraAttempts`; plan 200 §2.4 exempts it by name.

### 211.13 Studio: the smallest edits that compile (plan 218 replaces every page below)

- Files changed:

| File | Edit |
|---|---|
| `packages/studio/src/app/jobs/detail/page.tsx` | delete the node timeline (the `JobNodeInfo` list, `docNodeById`, the `skipped-on-resume` legend and the resume confirmation dialog, roughly `:72-500`), delete the `void api(\`/api/jobs/${jobId}/nodes\`, JobNodesResponseSchema)` effect and the `api(\`/api/jobs/${jobId}/resume\`, ...)` call; the logs and trace effects read `/api/jobs/${jobId}/runs/${job.runId}/logs` and `/trace`; add a plain `<select>` over `job.runs` that sets the run id used by those effects (a placeholder, not the handoff's picker: plan 218 draws it) |
| `packages/studio/src/lib/use-job-detail.ts` | `/api/jobs/${jobId}/logs` becomes `/api/jobs/${jobId}/runs/${runId}/logs`; the hook takes `runId` |
| `packages/studio/src/components/JobsList.tsx` | the row sub-line reads `job.runCount > 1 ? \`run ${job.runSeq} of ${job.runCount}\` : job.trigger`; the workflow branch keys on `job.kind === 'workflow'` instead of "did `/nodes` return anything" |
| `packages/studio/src/app/batches/detail/page.tsx` | `/rerun-failed` and `/rerun?only=skipped` keep their paths and now answer with the same batch; the "N jobs" caption stays |
| `packages/studio/src/app/schedules/detail/page.tsx` | delete the `/api/schedules/${scheduleId}/runs` pager and its `ScheduleRunInfo` table; replace it with a `JobsList` fed by `/api/schedules/${scheduleId}/jobs`; `schedule.lastBatchId` becomes `schedule.batchId`; show `lastFireOutcome`/`lastFireDetail` beside `lastFiredAt` |
| `packages/studio/src/components/RunScriptDialog.tsx` | the submit path is unchanged (it posts an action); the result toast names `runId` when the response carries one |
| `packages/studio/src/lib/api.ts` | drop `JobNodesResponseSchema`, `ScheduleRunsPageResponseSchema` and the resume helper from the imports and helpers |

- Test file: none. Studio and `@enkaku/ui` have zero tests (plan 200 §8.3). If a Studio test file that plan 201 has not yet deleted fails to compile because of these shapes, delete that file in this plan and list it in §11.
- Verifiable result: `bun run typecheck` exits 0; G14.
- Do not: rebuild any of these pages to the handoff. Plan 218 does that with the design of record, and MVP 15 §2 says the run picker is still undrawn.

### 211.14 Core README and spec

- Files changed: `packages/core/README.md` (the jobs section: a job is an intent and a run is an execution; the claim claims runs; the workflow orchestrator enqueues step jobs; delete the `job_nodes` section entirely), `docs/spec.md` (if plan 202's MVP spec is live, put its jobs-and-runs paragraphs in the present tense; otherwise edit §10.2, §11.7's "one job, under one lease" sentence and §12.3's schedule-history paragraph, and append a `DIV-` row to `docs/spec-divergences.md` naming plan 202 as the rewriter).
- Verifiable result: `rg -n "job_nodes\|one job under one lease\|schedule_runs" packages/core/README.md docs/spec.md` prints nothing.
- Do not: rewrite §19; plan 218 owns the Jobs screen list.

### 211.15 Status line and report

- Files changed: this document's `> Status:` line and §11.
- Verifiable result: `bash scripts/check-plan-status.sh` passes; `ps -Ao pid=,command= | grep -i "[o]penpf"` prints nothing but the shell.

## 6. Acceptance criteria

1. Every §0 row is checked, by its own command.
2. `rg -n "jobs\.status\b" packages/core/src --glob '!**/*.test.ts'` prints nothing: a job's status is only ever read from its latest run.
3. A database holding three jobs (one settled with two trace events, one artifact and a trace directory; one queued batch member; one failed job with a resume chain of two) boots into three jobs, four runs, every trace event and artifact keyed by run, and the frames present under `traces/<runId>/`.
4. Running the same script twice from the Jobs page leaves one job row with `runCount: 2` and two distinct `result` values, each readable at `GET /api/jobs/:id/runs/:runId`.
5. A workflow of three script steps and one gate produces one workflow job, three step jobs with `parentWorkflowJobId` set, and four `workflow_steps` rows; the workflow job's device shows a `workflow-job` activity for the whole run and a `job` activity per step.
6. Two queued runs on one online device claim strictly one at a time; a step run of the workflow holding that device claims while the workflow's own run is `running`; an unrelated queued run does not.
7. A schedule firing three times over two devices leaves two jobs, six runs, all with `trigger: 'schedule'`, and no `schedule_runs` table.
8. `POST /api/actions/run-script` with `jobId` and changed parameters answers a different `jobId` and leaves the original job's `runCount` untouched.
9. `POST /api/jobs/:id/resume` is a 404 and `POST /api/workflow-jobs/:id/resume` answers `201` with a run whose `trigger` is `resume`.
10. `bun run typecheck` is clean; every §7 command passes; every §10 proof prints nothing.

## 7. Test plan

### 7.1 Scoped runs, one at a time, in this order

```bash
bun run typecheck
bun test packages/core/src/jobs/runs/store.test.ts
bun test packages/core/src/jobs/runs/watcher.test.ts
bun test packages/protocol/src/api/jobs.test.ts
bun test packages/core/src/queue/
bun test packages/core/src/jobs/executor-host.test.ts
bun test packages/core/src/jobs/executors/workflow.test.ts
bun test packages/core/src/db/migrations/jobs-to-runs.test.ts
bun test packages/core/src/api/workflow-jobs.test.ts
bun test packages/core/src/api/actions-runs.test.ts
bun test packages/core/src/api/batches-runs.test.ts
bun test packages/core/src/schedules/runner.test.ts
bun test packages/core/src/clusters/status.test.ts
bun test packages/core/src/jobs/purge.test.ts
```

Never `bun test`, never `bun run --cwd packages/studio test`, never two runs at once (`CLAUDE.md`). No Studio or `@enkaku/ui` test is written or run (plan 200 §8.3).

### 7.2 Manual smoke (no device needed; local core on a scratch data dir)

```bash
ENKAKU_DATA_DIR=.dev-data-211 bun run dev &
sleep 5
# 1. one job, two runs
JOB=$(curl -s -X POST localhost:7700/api/actions/run-script -H 'content-type: application/json' \
  -d '{"target":{"deviceIds":["<a device id>"]},"scriptRef":"<plugin>/<script>@latest","params":{}}' | jq -r '.results[0].jobId')
curl -s -X POST localhost:7700/api/actions/run-script -H 'content-type: application/json' \
  -d "{\"jobId\":\"$JOB\",\"target\":{\"deviceIds\":[\"<the same device id>\"]},\"scriptRef\":\"<plugin>/<script>@latest\",\"params\":{}}" | jq '.results[0]'
curl -s localhost:7700/api/jobs/$JOB | jq '{runCount: .job.runCount, runs: [.job.runs[] | {seq, trigger, status}]}'   # runCount 2
curl -s "localhost:7700/api/jobs" | jq '[.items[] | select(.jobId=="'$JOB'")] | length'                                # 1 row, not 2
# 2. changed params make a new job
curl -s -X POST localhost:7700/api/actions/run-script -H 'content-type: application/json' \
  -d "{\"jobId\":\"$JOB\",\"target\":{\"deviceIds\":[\"<the same device id>\"]},\"scriptRef\":\"<plugin>/<script>@latest\",\"params\":{\"changed\":true}}" | jq '.results[0].jobId'   # a different id
# 3. the old paths are gone
curl -s -o /dev/null -w '%{http_code}\n' localhost:7700/api/jobs/$JOB/nodes        # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:7700/api/jobs/$JOB/resume   # 404
# 4. per-run reads
RUN=$(curl -s localhost:7700/api/jobs/$JOB | jq -r '.job.runs[-1].runId')
curl -s localhost:7700/api/jobs/$JOB/runs/$RUN/logs | jq '.lines | length'
curl -s localhost:7700/api/jobs/$JOB/runs/$RUN/artifacts | jq '.items | length'
kill %1
ps -Ao pid=,command= | grep -i "[o]penpf"   # nothing
```

### 7.3 Owner smoke at the wave gate (G15, owner's farm)

1. Run one script on one device; note the job id and that the Jobs list has one row.
2. Re-run it from the job detail; the list still has one row, the detail's run selector offers two runs, and each run's Output differs.
3. Run a three-step workflow on one device; the Jobs list shows the workflow job and three step jobs, each step job naming its parent; the device's activity strip shows the workflow for the whole duration.
4. Resume the workflow from step 2 after forcing step 2 to fail; a third run appears with trigger `resume` and the first step reads `carried over`.
5. Let a schedule fire twice; its page lists the member jobs, each with two runs, and no separate run table.

### 7.4 Device tests

None. Nothing in this plan touches a device path; `ENKAKU_TEST_DEVICE=1` is not needed. The device-dependent parts (a real script running under a run id, a real workflow holding a device) are §7.3's owner smoke.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| drizzle-kit emits table recreates for `jobs`, `artifacts` and `job_events` and loses an index or a row | 211.10's migration test runs `runMigrations` against a database that already holds rows and asserts `PRAGMA index_list` for all three tables plus a row count before and after |
| The renames are answered as "drop and create" at the drizzle-kit prompt, silently emptying `artifacts` and `job_events` | 211.1's step says answer **rename** and forbids a non-TTY run; the migration test's row counts fail loudly if it was answered wrong |
| The claim's new `NOT EXISTS` subquery slows every claim on a farm with a long `job_runs` table | `idx_job_runs_claim(status, device_id, priority, created_at)` covers it (`status = 'running'` first); if the report measures more than 5 ms per claim on the owner's farm, add `index('idx_job_runs_device_running').on(t.deviceId, t.status)` and say so |
| The workflow parent exemption lets two step jobs of the same workflow run at once | impossible by the SQL (a sibling's `job_id` is not the parent's) and by the orchestrator (it awaits each step); both are asserted by name in `job-store.test.ts` |
| The orchestrator deadlocks: the step run is never claimed because the device looks busy | the exemption test in G4 is the guard; on top of it, the orchestrator's `waitForTerminal` is bounded by `workflow.maxTotalMs`, so a stuck step fails the workflow run rather than holding the device forever |
| A workflow job's step job outlives its parent (the parent was cancelled, the step keeps running) | `ctx.signal` aborting calls `deps.cancelRun(currentChildRunId)` before rethrowing (§4.5 item 6), asserted by `a cancelled workflow run cancels the step run it was waiting on` |
| Trace and artifact directories are renamed after the transaction commits, so a crash between them leaves rows pointing at a directory that has not moved | the report's `unmovedDirs` names them and the log says the rows already point at the run; a second boot does not retry (the marker is set), so the operator moves them or loses only the frames, never a row |
| `schedule_runs` deletion loses the "why did this schedule not fire" answer | §3.2 decision 5: the last outcome lives on `schedules`, and every non-dispatching fire is logged at `warn` with the schedule's name; recorded in §9 as the one place the MVP knowingly loses history |
| The old Studio's job detail is left with a `<select>` instead of the handoff's run picker for a whole wave | deliberate (MVP 15 §2 lists the picker as undrawn); plan 218 replaces the page, and §5 step 211.13 says so |
| Plan 212 (settings) lands beside this plan and both edit `packages/protocol/src/settings.ts` | this plan does not edit that file; `workflow.maxTotalMs` is read through the existing accessor and its fate is plan 212's |

## 9. Open questions

1. **A cap on runs per job** (MVP 14 §6 item 1). The document proposes none, and this plan implements none: retention (plan 224) is the only limit. A human decides later whether a farm that re-runs a job hundreds of times needs a hard cap, and if so where the refusal is worded.
2. **A run started with different parameters** (MVP 14 §6 item 2). The document proposes "a new job", and this plan implements exactly that (§3.2 decision 11, `addRunOrNewJob`). The alternative (one job with a params snapshot per run) would make cross-run comparison unlike-for-unlike, which is the reason the proposal was made; reversing it is a product decision, not an implementation one.
3. **Whether a schedule fire that resolves a different script version should create a new job or re-point the existing one.** This plan creates a new job (§4.1.1, `scriptVersion` row), because a job pins `script_id` and a run must be comparable with its siblings. The consequence an operator sees is that a schedule on `@latest` grows a new member job per version. Whether that is the wanted behaviour, or whether such a schedule should keep one job per device forever and accept mixed versions across runs, is for the CEO.
4. **Whether the fire-decision history really can be one row on `schedules`** (§3.2 decision 5). MVP 14 §4 deletes `schedule_runs` outright; this plan keeps the last outcome only. If an operator needs "this schedule has been silently skipping for a week" as a queryable fact rather than a log line, a small ledger has to come back, and that is a product call.

## 10. Removed

`GREP_211` (the vocabulary this plan's area forbids in live code and copy): `rg -n -i "job node\|jobNode\|workflow node\|resume chain\|schedule run\b\|resumedFrom\(Job\|Node\)\|one job under one lease" packages plugins examples scripts apps --glob '!**/out/**' --glob '!**/*.tsbuildinfo' --glob '!packages/core/packs/**' --glob '!packages/core/drizzle/**'` prints nothing.

| What | Where it was | Proof |
|---|---|---|
| `jobNodes` table and `JobNodeRow` | `packages/core/src/db/schema.ts:1003` | `rg -n "jobNodes\|job_nodes" packages --glob '!packages/core/drizzle/**'` empty |
| `jobResumes` table and `JobResumeRow` | `packages/core/src/db/schema.ts:1164` | `rg -n "jobResumes\|job_resumes\|resumedFromJobId\|resumed_from_job_id" packages --glob '!packages/core/drizzle/**'` empty |
| `scheduleRuns` table, `ScheduleRunRow`, `ScheduleRunInfoSchema`, `ScheduleRunsPageResponseSchema` | `packages/core/src/db/schema.ts:1382`; `packages/protocol/src/api/schedules.ts:19`; `packages/protocol/src/messages/schedule.ts` | `rg -n "scheduleRuns\|schedule_runs\|ScheduleRunInfo\|ScheduleRunsPage" packages --glob '!packages/core/drizzle/**'` empty |
| `artifacts.nodeId` and `job_events.nodeId` | `packages/core/src/db/schema.ts:1049`, `:1091` | `rg -n "nodeId" packages/core/src/db/schema.ts` empty |
| `GET /api/jobs/:id/nodes` | `packages/core/src/api/jobs.ts:384` `app.get('/:id/nodes', requirePermission('job.view'), (c) => {` | `rg -n "'/:id/nodes'" packages/core/src` empty |
| `POST /api/jobs/:id/resume`, `ResumeBody`, `JobService.resume`, `defaultResumeNode` | `packages/core/src/api/jobs.ts:549` `app.post('/:id/resume', requirePermission('job.run'), async (c) => {`; `packages/core/src/services/job-service.ts`'s `resume(jobId, input)` | `rg -n "'/:id/resume'\|defaultResumeNode\|\.resume\(" packages/core/src` empty |
| `GET /api/schedules/:id/runs` and its keyset helper | `packages/core/src/api/schedules.ts:636` `app.get('/:id/runs', (c) => {` | `rg -n "'/:id/runs'" packages/core/src/api/schedules.ts` empty |
| The `node` block on `job.status`, `JobNodeStatusSchema` | `packages/protocol/src/messages/job.ts:276`, `:279-307` | `rg -n "JobNodeStatus\|node: z$\|JobNodeProgress" packages/protocol packages/core/src` empty |
| `JobNodeInfoSchema`, `JobNodesResponseSchema`, `JobNodeErrorSchema`, `JobPurgeCounts.nodes` | `packages/protocol/src/api/jobs.ts:77`, `:106`, `:168`, `:205` | `rg -n "JobNodeInfo\|JobNodesResponse\|JobNodeError" packages` empty |
| `JobResumeRequestSchema`, `JobResumeResponseSchema` | `packages/protocol/src/messages/job.ts:465`, `:476` | `rg -n "JobResumeRequest\|JobResumeResponse" packages` empty |
| The child-spawning workflow executor (`WorkflowExecutorDeps.runner`/`sessions`/`nodeTracker`/`onNode`, `DEFAULT_WORKFLOW_MAX_TOTAL_MS` as a module default, `ON_FAIL_NODE_ID` as a `job_nodes` id) | `packages/core/src/jobs/executors/workflow.ts` | `rg -n "createWorkflowExecutor\|nodeTracker\|onNode" packages/core/src` empty |
| `JobNodeTracker`, `createJobNodeTracker`, the `nodeId` accessor on the artifact store | `packages/core/src/runner/artifact-store.ts:145`, `:93` `nodeId: deps.nodeId?.() ?? null,` | `rg -n "JobNodeTracker\|createJobNodeTracker" packages` empty |
| `JobSpec.nodeId` and its thread through the child init payload and the trigger key | `packages/session/src/runner/job-runner.ts` `nodeId?: string`, `child-entry.ts`, `jobs-client.ts` | `rg -n "nodeId" packages/session/src` empty |
| `jobs.status`, `jobs.priority` and every execution column on `jobs` | `packages/core/src/db/schema.ts:394-645` | G1's PRAGMA assertion |
| `JobStore.enqueue`, `.nodes`, `.recordResume`, `.resumeInfo`, `ConcreteJobStore` | `packages/core/src/queue/job-store.ts:239-345` | `rg -n "ConcreteJobStore\|recordResume\|resumeInfo" packages` empty |
| `POST /api/batches/:id/rerun` and `/rerun-failed` as JOB-creating routes | `packages/core/src/api/batches.ts:829`, `:889` (both ending in `createBatch(dispatchDepsFor(c.get('user')), { ... })`) | `rg -n "createBatch\(" packages/core/src/api/batches.ts` prints one line, in `POST /` |
| `schedules.lastBatchId` | `packages/core/src/db/schema.ts:1303` | `rg -n "lastBatchId\|last_batch_id" packages --glob '!packages/core/drizzle/**'` empty |
| Studio: the node timeline, the resume dialog, the schedule runs table | `packages/studio/src/app/jobs/detail/page.tsx`, `packages/studio/src/app/schedules/detail/page.tsx` | `rg -n "JobNodeInfo\|skipped-on-resume\|ScheduleRunInfo" packages/studio/src` empty |

**MVP 13 A.4 rows this plan closes**: `jobNodes` table, `GET /api/jobs/:id/nodes`, `POST /api/jobs/:id/resume`, the `node` block on `job.status`, `artifacts.nodeId`, the child-spawning workflow executor. **MVP 14 §4 rows this plan closes**: all of them.

**MVP 13 A.4 rows this plan does not own** (named so the wave-2 removal gate knows who closes them): the `/scripts` redirect and `/plugins?tab=scripts` (plans 213 and 217); spec §19's screen list (plan 218).

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:
