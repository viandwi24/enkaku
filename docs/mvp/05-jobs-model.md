# MVP 05 — Two job systems: script jobs and workflow jobs

> Status: decided in direction (CEO, 2026-09-03); model proposed here. **Amended by MVP 14**: every job (script or workflow) holds a list of runs; the tables in §1.2 gain a run level as MVP 14 §1 describes. **Amended by MVP 15**: one Jobs list with the kind visible per row, plus a Batches tab; no Script jobs / Workflow jobs split on the surface, and no Schedules tab under Jobs (Schedules is the third tab of Scripts & Workflows, MVP 15 §0.1).
> As stated by the CEO: a script is the automation; a job is a script being run; a workflow is a sequence of scripts; running a workflow produces a workflow job. Two job systems, because workflow jobs will become complex.
> Related: `docs/spec.md` §10, §11.7; `docs/plans/99-m64-workflows.md`; `packages/core/src/jobs/`, `packages/core/src/db/schema.ts` (`jobs`, `jobNodes`, `batches`, `schedules`).

---

## 0. What exists today

- `jobs` has no `kind` column. The kind lives on the script row (`scripts.kind`) and is read by `ExecutorRegistry.get(scriptId, kind)` (`packages/core/src/jobs/executor.ts`).
- **Live defect:** `daemon.ts`'s `createExecutorHost` call never passes `scriptKind`, so `deps.scriptKind?.(...) ?? 'script'` is always `'script'` and a workflow job is dispatched to the script executor in a real boot. `packages/core/src/jobs/executor-kind-dispatch.test.ts:13-60` documents this as the missing third step.
- A workflow node runs as a child process inside the one workflow job (`jobs/executors/workflow.ts`), recorded in `jobNodes` (one row per execution). A node is not a job: it has no history row of its own, no retry policy, no artifacts producer (`artifacts.nodeId` has "no producer yet").
- Batches and schedules are kind-agnostic: `batches.scriptId`, `schedules.scriptRef`, with agent schedules using a sibling table plus an empty sentinel.
- Studio's job detail decides it is looking at a workflow by whether `GET /api/jobs/:id/nodes` returned anything.

## 1. The model

### 1.1 Script job: the unit of execution

A script job is one plugin member script, one device, one child process, one result. It is what exists today minus the workflow branch. Table `jobs` keeps its shape; `scriptVersion` is displayed as the plugin version (MVP 03 §2).

### 1.2 Workflow job: an orchestrator of script jobs

A workflow job is one run of a workflow document on one device. It owns an ordered list of steps; each script step **is a real script job** with `parentWorkflowJobId` and `stepSeq`; each gate step is a row in the workflow job's own step table with its verdict. The workflow executor no longer spawns children itself: it enqueues script jobs one at a time and waits on their terminal status.

What this buys, compared with today's child-process nodes:

- History, logs, artifacts, retries, and the device activity entry (MVP 04) for every step, for free, through the script-job machinery that already exists.
- Resume is "enqueue from step N", not a bespoke copy of the original job.
- The Jobs page can show a step as a job because it is one.
- Crash containment is unchanged: a step is still a child process with a stateless `finish()`.

Tables:

```
workflow_jobs:  id, workflowName, doc (snapshot, MVP 03 §2.2), deviceId, params, status,
                createdBy, createdAt, startedAt, finishedAt, error, resumedFromId
workflow_steps: id, workflowJobId, seq, nodeId, kind ('script' | 'gate'),
                jobId (script step) | verdict (gate), status, startedAt, finishedAt, error
jobs:           + parentWorkflowJobId, + stepSeq   (nullable)
```

`jobNodes` is deleted; `workflow_steps` replaces it.

### 1.3 Dispatch

Two queues, one scheduler. A workflow job claims the device by creating a `workflow-job` activity (MVP 04); its script steps are allowed through the policy table because they carry the same parent. Nothing else may start a job on that device until the workflow job ends. The `scriptKind` wiring gap disappears because there is no kind-dispatch: `jobs` are always script jobs.

### 1.4 Batches and schedules

Both gain `target: { kind: 'script', ref } | { kind: 'workflow', name }`. A batch of a workflow fans out one workflow job per device. A schedule of a workflow enqueues one workflow job per device at fire time. The agent-schedule sibling table stays as it is.

### 1.5 Studio

Jobs page tabs: **Script jobs**, **Workflow jobs**, **Batches**, **Schedules** (this amends MVP 03 §1, which had three tabs). A workflow job detail shows the step timeline with each script step linking to its own script job detail. A script job detail shows "Step 3 of workflow job #91" when it has a parent.

## 2. Removed

- `scripts.kind` and every reader of it (MVP 03 moves workflows out of `scripts`).
- `ExecutorRegistry`'s `fallbackByKind` and `scriptKind` dependency; `executor-kind-dispatch.test.ts`.
- `jobs/executors/workflow.ts` as a child-spawning executor; replaced by the orchestrator in §1.2.
- `jobNodes`, `GET /api/jobs/:id/nodes`, `POST /api/jobs/:id/resume` (moves to `POST /api/workflow-jobs/:id/resume`), the `node` block on `job.status`.
- Spec §11.7's "one job, under one lease" sentence.

## 3. Cost

One migration (two new tables, two nullable columns on `jobs`, drop `jobNodes`), a rewrite of the workflow executor as an orchestrator, new `/api/workflow-jobs` routes, and the Jobs page tabs. About two sprints. The runner, the queue claim SQL, and the heartbeat are untouched.

## 4. Open points

1. Whether a workflow step may target a different device than the workflow job (multi-device workflows). Proposed: no for the MVP; one workflow job is one device, as today.
2. Concurrency inside a workflow (parallel steps). Proposed: sequential only for the MVP; the step table already has `seq`, parallel groups can be added later without a migration.
