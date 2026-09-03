# MVP 14 — A job is an intent; a run is an execution

> Status: decided in direction (CEO, 2026-09-03); model proposed here. Amends MVP 05.
> As stated by the CEO: a job can be re-run, so one job may hold two or more results, keeping the previous result alongside the current one.
> Related: MVP 05 (script jobs and workflow jobs), MVP 07 (`run-script` / `run-workflow` verbs), MVP 09 §6 (retention), MVP 04 (activities), `packages/core/src/db/schema.ts` (`jobs`, `batches`, `schedules`, `schedule_runs`), `packages/core/src/api/jobs.ts`, `api/batches.ts`.

---

## 0. What exists today

- Re-running is creating a new job: `POST /api/jobs/:id/resume` "creates a new job, copies scriptId/deviceId/params, never mutates the original" (`api/jobs.ts:538-560`); `POST /api/batches/:id/rerun` and `/rerun-failed` (`api/batches.ts:829-889`) enqueue new jobs. History for one piece of work is spread across ids that nothing links.
- `infraAttempts` on `jobs` counts infrastructure retries inside one job (`schema.ts`), which is the right idea at the wrong level.
- Schedules keep their own `schedule_runs` table (`schema.ts`, modelled on by `jobNodes`), a second history shape for the same thing: an execution.
- Logs, traces, artifacts, and assists are keyed by `jobId`, so a re-run cannot be placed beside the run it repeats.

## 1. The model

```
jobs:      id, kind ('script' | 'workflow'), scriptRef | workflowName, params,
           deviceId, batchId?, scheduleId?, createdBy, createdAt,
           latestRunId, runCount            (denormalised for lists)
job_runs:  id, jobId, seq (1..n), trigger ('manual' | 'rerun' | 'schedule' | 'batch' | 'resume' | 'workflow-step'),
           status, startedAt, finishedAt, heartbeatExpiresAt,
           result, error, failureClass, errorPhase, infraAttempts, assistCount,
           resumedFromRunId?, resumedFromStep?
```

- **A job is the intent**: what to run, with which parameters, on which device, made by whom. Its id is stable for its whole life. Its displayed status is `latestRun.status`.
- **A run is one execution** of that intent. Re-running adds a run with `seq + 1`; nothing on earlier runs changes. Logs, trace frames, UI captures, artifacts, and assists are keyed by `runId`.
- **Infrastructure retries stay inside a run** (`infraAttempts`), so the run count reflects human or schedule decisions only.
- **Batches** are a set of jobs created together from one target (MVP 07). "Re-run" adds a run to every job in the batch; "re-run failed" only to jobs whose latest run failed. A batch's status is the projection of its jobs' latest runs, as today.
- **Schedules own one job per target device**; every fire adds a run with `trigger = 'schedule'`. `schedule_runs` is deleted; a schedule's history is its jobs' runs. `onOverlap` (skip, queue, cancel previous) applies to the job's running run.
- **Workflow jobs** (MVP 05) follow the same shape: `workflow_runs` per workflow job, `workflow_steps` per run, and a script step points at `(jobId, runId)` of its child script job. Resume is a run with `trigger = 'resume'`, `resumedFromRunId`, and `resumedFromStep`.
- **Activities** (MVP 04) reference the run, not the job.

## 2. What the user sees

- The Jobs page lists jobs, one row each: script or workflow, device, latest run status, run count, last finished. Re-running never adds a row.
- Job detail: the run list newest first, each with status, duration, trigger, and who or what started it. In the handoff's Jobs detail this is a run picker in the header's meta line ("run 3 of 3 ·"), to be drawn (MVP 15 §2). Selecting two runs shows their results side by side; structured results (`resultSchema`, plan 97) get a field-by-field diff, logs get a plain split view.
- "Run again" on a job, a batch, or a schedule is the same verb (`run-script` / `run-workflow`, MVP 07) with `jobId` set, which tells the core to add a run instead of creating a job. Changing parameters before running again creates a **new job**, because the intent changed; the dialog says so.
- A schedule's page shows its jobs and their runs, not a separate run table.

## 3. Migration

Every existing `jobs` row becomes a job with exactly one run (`seq = 1`, `trigger = 'manual'` or `'batch'`), and its logs, artifacts, traces, and assists are re-keyed to that run. `schedule_runs` rows become runs on synthesised jobs where the original job still exists, and are dropped with a one-time count in the log where it does not. Resume chains (`resumedFromJobId`) are folded into runs of the earliest job in the chain.

## 4. Removed

`POST /api/jobs/:id/resume` (becomes a run with `trigger = 'resume'`), `POST /api/batches/:id/rerun` and `/rerun-failed` as job-creating routes (become `run-script` with `batchId`), `schedule_runs`, `jobs.resumedFromJobId`, `jobs.infraAttempts` and the heartbeat and result columns at job level (they move to `job_runs`), the `runs` list on the schedule detail page.

## 5. Retention

MVP 09 §6 applies per run: old runs of a job expire individually; the job row stays while it has any run or while a schedule owns it. A job whose runs are all expired and that no schedule owns is deleted by the same sweeper.

## 6. Open points

1. Cap on runs per job (proposed: none; retention handles it).
2. Whether a run started with different params is a new job (proposed: yes) or a run with a params snapshot. The proposal keeps "job = intent" strict so comparisons across runs are like for like.
