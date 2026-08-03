# Plan 21 — M11e : Schedules and Queue Policy

> Status: implemented (2026-08-02) — see the "Corrected against croner" note in §3.1
> Ships: packages/core/src/schedules/runner.ts
> Depends on: **Plan 20** (batches). A schedule triggers a batch, not a bare job.
> Spec references: §10.2 (leases and the queue), §10.3 (claim atomicity), §12 (entities), §15 (retention).

---

## 1. Goals

- A schedule runs a script against a cluster (or a device list) on a cron expression, in a stated timezone.
- Every question the operator asked is an explicit setting rather than an emergent behaviour: what happens when the previous run is still going, how long a job may wait in the queue, what happens if the core was down when the schedule was due, and how load is spread.
- Priority is a first-class field on schedules, batches and jobs, and one documented rule decides the order.
- A queued job can expire instead of waiting forever, and expiry is visible as a distinct outcome rather than a failure.
- The schedules screen shows the next fire time and the recent run history, live.

## 2. Non-goals

- Distributed scheduling across multiple cores. One core owns the schedule table; the cloud control plane (Plan 11) is still a single process.
- Calendar UI, blackout windows, or "run only on weekdays between 9 and 5" beyond what cron already expresses. Recorded as an open question.
- Chaining schedules or batches — see Plan 20's open questions.
- Changing how jobs execute. This plan only decides **when** they are created and **whether** they are allowed to wait.

## 3. Context and design decisions

### 3.1 Cron parsing: croner

The core needs cron parsing with correct timezone and DST handling, and it must run on Bun. [croner](https://github.com/hexagon/croner) is TypeScript-native, has zero dependencies, explicitly supports Bun, resolves timezones through the built-in `Intl` API, and defines DST behaviour.

**Corrected against croner 10.0.1 during implementation.** An earlier draft of this section claimed a fire time inside a DST *gap* is skipped entirely. It is not: croner resolves that instant forward to the next valid wall-clock moment, so a 02:00 job fires once at 03:00 on the spring-forward day rather than being dropped. The *fall-back* case is as described — one fire, not two. The guarantee the product actually needs, and the one the unit tests assert, is **exactly one fire per nominal slot — never zero, never two — with no drift on the following days**. `cron-parser` is the main alternative but pulls Luxon in for timezones.

Only the **parsing and next-occurrence** part of croner is used. The firing loop is ours, because a library timer that lives in memory cannot answer "what should have fired while the process was down" (§3.4).

### 3.2 Overlap: three honest choices

A schedule due while its previous run is still going has exactly three sensible outcomes, and picking silently for the user is how surprises happen:

| `onOverlap` | Behaviour | When it is right |
|---|---|---|
| `skip` | Do nothing; record a skipped run with the reason. | Periodic health checks — a late one is worthless. |
| `queue` | Create the batch anyway; it waits behind the current one. | Work that must happen N times, whatever the pace. |
| `cancel-previous` | Cancel the queued remainder of the running batch, then start. | "Latest state only" jobs where the newest run supersedes the old. |

Default `skip`: it is the only one that cannot pile up unboundedly while nobody is watching.

### 3.3 Queue timeout belongs on the job, not the schedule

"Should a job wait forever?" is not specific to schedules — a manually dispatched batch has the same question. So the deadline lives on the job row (`expiresAt`), is set from whatever created the job, and is enforced by one reaper for every job in the system.

An expired job gets its own terminal status, `expired`, rather than `failed`. They mean different things: `failed` says the script ran and did not work, `expired` says it never got a device. Collapsing them makes a farm capacity problem look like a script bug.

### 3.4 Missed fires: the core is not always running

A desktop-hosted core is closed at night. When it starts, some schedules were due while it was down. Two policies:

- `catchUp: 'skip'` (default) — record the misses, run nothing. Correct for anything periodic.
- `catchUp: 'once'` — if one or more fires were missed, run **once**, immediately, and record how many were collapsed into it.

There is deliberately no "run all missed occurrences": a core that was off for a weekend would stampede the farm on Monday.

This requires persisting `lastFiredAt` and computing missed occurrences from it at startup — which is why the firing loop is ours rather than croner's in-memory timer.

### 3.5 One ordering rule

With schedules, batches and standalone jobs all producing work, the ordering rule must be stated once and be true everywhere:

> **`priority DESC`, then batch order (`batchSeq ASC`), then `createdAt ASC`.**

This is exactly the claim query from Plan 20 §4.2; this plan adds no new ordering, only a `priority` field on schedules that is copied onto the jobs they create. Priority is a small signed integer, default `0`, and the UI offers `-10 / 0 / 10` as *Low / Normal / High* rather than a free number field, because a free number invites an arms race.

### 3.6 Jitter

Ten schedules at `0 * * * *` all fire at the top of the hour and contend for the same devices. `jitterSec` delays each dispatch by a random amount in `[0, jitterSec]`, drawn per fire. It shifts the batch creation time, never the cron evaluation, so the schedule does not drift.

## 4. Technical design

### 4.1 Schema

```ts
export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    /** Standard 5-field cron, or 6 fields with seconds (croner syntax). */
    cron: text('cron').notNull(),
    /** IANA zone, e.g. 'Asia/Jakarta'. Never a UTC offset — offsets break on DST. */
    timezone: text('timezone').notNull(),

    scriptId: text('script_id').notNull(),
    params: text('params', { mode: 'json' }),
    /** Exactly one of these is set. */
    clusterId: text('cluster_id'),
    deviceIds: text('device_ids', { mode: 'json' }),

    // Batch shape, passed straight through to Plan 20's dispatcher.
    concurrency: integer('concurrency').notNull().default(0),
    order: text('order').notNull().default('as-listed'),

    // Policy (§3.2–§3.6)
    onOverlap: text('on_overlap').notNull().default('skip'),
    queueTimeoutSec: integer('queue_timeout_sec'),      // null = wait forever
    catchUp: text('catch_up').notNull().default('skip'),
    jitterSec: integer('jitter_sec').notNull().default(0),
    priority: integer('priority').notNull().default(0),

    lastFiredAt: integer('last_fired_at', { mode: 'timestamp' }),
    lastBatchId: text('last_batch_id'),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('idx_schedules_enabled').on(t.enabled)],
)

/** One row per fire decision, including the ones that ran nothing. */
export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    id: text('id').primaryKey(),
    scheduleId: text('schedule_id').notNull(),
    /** When it was due, not when it ran — jitter separates the two. */
    dueAt: integer('due_at', { mode: 'timestamp' }).notNull(),
    firedAt: integer('fired_at', { mode: 'timestamp' }),
    outcome: text('outcome').notNull(),   // 'dispatched'|'skipped-overlap'|'skipped-missed'|'no-targets'|'error'
    batchId: text('batch_id'),
    detail: text('detail'),
    missedCount: integer('missed_count').notNull().default(0),
  },
  (t) => [index('idx_schedule_runs_sched').on(t.scheduleId, t.dueAt)],
)
```

`jobs` gains:

```ts
/** Unix seconds; the reaper expires the job if it has not started by then (§3.3). */
expiresAt: integer('expires_at'),
```

and `JobStatusSchema` in `packages/protocol` gains `'expired'`.

### 4.2 The scheduler loop

New file `packages/core/src/schedules/runner.ts`. It is separate from `packages/core/src/queue/scheduler.ts` — that one dispatches queued jobs to devices; this one decides when work is created. Conflating them would put cron parsing in the hot path of every device claim.

```ts
export interface ScheduleRunner {
  start(): void
  stop(): void
  /** Re-read the table after a create/update/delete. */
  reload(): void
  /** Next fire time per enabled schedule, for the UI. */
  nextFires(): Map<string, number>
}
```

Behaviour:

- A single timer wakes on the earliest next fire across all enabled schedules, recomputed on every change. No per-schedule timers.
- On wake, for each due schedule: evaluate `onOverlap` against `lastBatchId`'s current status, apply `jitterSec`, dispatch through Plan 20's `createBatch` with `priority` and `expiresAt = now + queueTimeoutSec`, then write a `schedule_runs` row and update `lastFiredAt`.
- **At startup**, before the first wake: for each enabled schedule with a `lastFiredAt`, count occurrences between then and now. If any, apply `catchUp` and record a `schedule_runs` row with `missedCount` — even when the outcome is `skipped-missed`, because "nothing ran last night" must be visible without reading process logs.
- Every fire decision writes a `schedule_runs` row. A schedule that has been quietly skipping for a week should be obvious from its history.

### 4.3 The expiry reaper

`packages/core/src/queue/expiry.ts`, run on the existing lease-reaper interval:

```sql
UPDATE jobs SET status = 'expired', finished_at = :now
WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at <= :now
```

Then recompute the status of any affected batch (Plan 20 §4.5) and broadcast `job.status`. Expiry only ever applies to `queued` jobs; a running job is governed by the job lease, which already exists.

### 4.4 API

```
GET    /api/schedules                 → { schedules: ScheduleInfo[] }   (each with nextFireAt)
POST   /api/schedules                 → { schedule }
PATCH  /api/schedules/:id             → { schedule }        (also enable/disable)
DELETE /api/schedules/:id             → 204
POST   /api/schedules/:id/run-now     → { batch }           (ignores cron, honours onOverlap)
GET    /api/schedules/:id/runs?limit= → { runs: ScheduleRunInfo[] }
POST   /api/schedules/validate        → { valid, nextFires: number[], error? }
```

`validate` powers the editor: paste a cron expression, see the next five fire times **in the chosen timezone**, before saving. A cron field with no preview is a trap.

All mutations write `audit_log`.

### 4.5 WS

`schedule.fired` — `{ scheduleId, outcome, batchId?, dueAt }`, broadcast on every fire decision, so the schedules screen updates without polling.

### 4.6 Studio

- **`/schedules`** — a table: name, cron in human form (`Every day at 02:00 Asia/Jakarta`), next fire as a live countdown (`useNow`, Plan 17), last outcome, enabled switch, and a **Run now** action.
- **`/schedules/detail?id=…`** — tabs Overview / Runs / Settings, matching the pattern used by scripts and devices.
  - Overview: target preview (Plan 20's cluster preview), the policy summary in plain words, next five fires.
  - Runs: the `schedule_runs` history, including skipped ones with their reason. This is the screen that answers "why didn't it run".
  - Settings: cron plus timezone with the live preview, batch shape, and the four policy fields, each with one sentence of consequence rather than a bare label.
- The editor states policy in words as they are chosen, for example: *"If the previous run is still going, this one is skipped."*

## 5. Implementation steps

### 21.1 Dependency and protocol
- [ ] `bun add croner --cwd packages/core`; pin the version.
- [ ] Add `'expired'` to `JobStatusSchema`; add `ScheduleInfoSchema`, `ScheduleRunInfoSchema`, `ScheduleFiredMessage` in `packages/protocol/src/messages/schedule.ts`; register in the unions.
- [ ] Update `packages/studio/src/components/StatusBadge.tsx` so `expired` renders distinctly from `failed`.
- Result: typecheck green; an expired job is visually distinct in the jobs list.

### 21.2 Schema and migration
- [ ] Add `schedules` and `scheduleRuns`; add `expiresAt` to `jobs`.
- [ ] `bun run --cwd packages/core db:generate`; commit the SQL.
- Result: an existing dev DB migrates cleanly.

### 21.3 Cron evaluation
- [ ] `packages/core/src/schedules/cron.ts` — a thin wrapper over croner: `nextFires(expr, tz, count, from)` and `occurrencesBetween(expr, tz, from, to)`.
- [ ] Unit tests: a DST spring-forward gap is skipped; a fall-back overlap fires once; `Asia/Jakarta` (no DST) is stable; an invalid expression returns a typed error rather than throwing.
- Result: the DST tests pass with fixed input timestamps (no `Date.now()` in tests).

### 21.4 Expiry reaper
- [ ] `packages/core/src/queue/expiry.ts`; wire into the existing reaper interval; recompute batch status; broadcast.
- [ ] Unit test: a queued job past `expiresAt` becomes `expired`; a running one is untouched; a batch with one expired job reports correctly.
- Result: `queueTimeoutSec: 60` on a busy farm produces `expired`, never `failed`.

### 21.5 The runner
- [ ] `packages/core/src/schedules/runner.ts` per §4.2, including the startup catch-up pass.
- [ ] Unit tests with an injected clock: `skip` vs `queue` vs `cancel-previous`; `catchUp: 'once'` collapses three missed fires into one run with `missedCount: 3`; `jitterSec` shifts `firedAt` but not `dueAt`.
- Result: every fire decision leaves a `schedule_runs` row.

### 21.6 API and wiring
- [ ] Schedule CRUD, `run-now`, `runs`, `validate`; mount in `server/http.ts`; audit mutations.
- [ ] Start and stop the runner in `daemon.ts` alongside the other subsystems; `reload()` after any mutation.
- Result: the smoke test in §7 runs end to end.

### 21.7 Studio
- [ ] `/schedules` and `/schedules/detail` per §4.6; sidebar entry.
- [ ] Cron editor with the live next-fires preview.
- Result: creating a schedule for one minute ahead fires once and shows the batch in its Runs tab.

## 6. Acceptance criteria

1. A schedule can be created, validated with a live preview of its next fires in the chosen timezone, enabled, disabled and deleted.
2. On its cron time, the schedule creates a batch with the configured concurrency, order and priority.
3. `onOverlap` behaves as specified in all three modes, and the skipped case is recorded with its reason.
4. `queueTimeoutSec` produces jobs with status `expired`, distinct from `failed`, and the batch status reflects that.
5. With the core stopped across two fire times and `catchUp: 'once'`, exactly one run happens at startup with `missedCount: 2`; with `catchUp: 'skip'`, none runs and the misses are still recorded.
6. `jitterSec: 60` spreads dispatches across the minute without moving the schedule's due times.
7. A high-priority standalone job is claimed ahead of a low-priority scheduled batch.
8. The schedules list shows a live countdown to the next fire with no polling.
9. The Runs tab explains why a run did not dispatch.
10. `bash scripts/typecheck.sh` and `bun test` are green.

## 7. Test plan

**Unit**
- `packages/core/src/schedules/cron.test.ts` — DST gap and overlap, invalid expressions, fixed clock.
- `packages/core/src/schedules/runner.test.ts` — the three overlap modes, catch-up collapsing, jitter bounds, one `schedule_runs` row per decision.
- `packages/core/src/queue/expiry.test.ts` — expiry only touches queued jobs; batch status recomputes.
- `packages/core/src/queue/job-store.test.ts` — extend Plan 20's ordering test with a scheduled batch versus a high-priority standalone job.

**Manual smoke** (`ENKAKU_TEST_DEVICE=1`)

```bash
bun run dev
curl -s -X POST 127.0.0.1:7700/api/schedules/validate -H 'content-type: application/json' \
  -d '{"cron":"*/2 * * * *","timezone":"Asia/Jakarta"}' | jq
curl -s -X POST 127.0.0.1:7700/api/schedules -H 'content-type: application/json' -d '{
  "name":"Smoke every 2 min","cron":"*/2 * * * *","timezone":"Asia/Jakarta",
  "scriptId":"<sid>","clusterId":"<cid>","concurrency":1,"order":"random",
  "onOverlap":"skip","queueTimeoutSec":120,"catchUp":"skip","jitterSec":15,"priority":0 }'
# watch /schedules: the countdown ticks, then a batch appears
# stop the core for ~5 minutes, restart with catchUp:'once' → exactly one run, missedCount 2
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A misconfigured schedule floods the queue. | `onOverlap: 'skip'` by default, and `queueTimeoutSec` bounds how long anything waits. The Runs tab makes a schedule that fires constantly obvious. |
| Timezone handling is wrong twice a year. | croner resolves zones through `Intl`; the DST gap and overlap cases are unit tests with fixed timestamps, not assumptions. |
| Catch-up stampedes the farm after downtime. | Only `once` exists — never "all missed". The collapsed count is recorded so the operator can see what was skipped. |
| Two core processes both fire the same schedule. | One core owns the table. This is already a documented constraint, but this plan makes the consequence worse, so the daemon must fail to start if the data directory is already locked — add that check here if it does not exist. |
| `expired` is treated as a failure by existing UI or reports. | Plan step 21.1 updates the badge; the acceptance criteria check the batch projection explicitly. |

## 9. Open questions

1. Blackout windows ("never run between 08:00 and 10:00") — a schedule field, or a farm-wide setting? Proposed: farm-wide, in a later plan; cron can approximate it today.
2. Should `run-now` respect `onOverlap`? Proposed: yes, with an override checkbox, so the button behaves like the schedule unless the operator says otherwise.
3. Should a schedule be able to target *all* devices with no cluster? Proposed: no — require an explicit cluster or device list, so "everything" is always something someone wrote down.
4. Retention for `schedule_runs`: reuse the Plan 18 event budgets, or its own? Proposed: its own, defaulting to 90 days — the rows are small and the history is the audit trail for why automation did or did not run.
