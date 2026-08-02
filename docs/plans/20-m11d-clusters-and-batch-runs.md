# Plan 20 — M11d : Clusters and Batch Runs

> Status: implemented (2026-08-02) — see the "Corrected during implementation" note in §4.2
> Depends on: **Plan 19** (tags). Blocks Plan 21 (schedules trigger batches).
> Spec references: §10.2 (leases and the queue), §10.3 (claim atomicity), §11 (job execution), §12 (entities).

---

## 1. Goals

- A **cluster** is a named, saved way of selecting devices: tags plus an optional explicit device list.
- One action runs a script across a cluster and produces a single **batch** with one job per device.
- The batch supports four execution shapes: all at once, one at a time in a given order, one at a time in a shuffled order, and N at a time.
- The batch has an aggregate report: overall status, per-device outcome, durations, and links to each job's logs and artifacts.
- Cancelling a batch cancels the jobs that have not started and leaves finished ones alone.
- Per-device concurrency stays at exactly one — a batch never puts two jobs on the same phone at the same time.

## 2. Non-goals

- Schedules and recurrence — Plan 21. This plan builds the thing a schedule triggers.
- Cross-cluster dependencies ("run batch B after batch A"). Recorded as an open question.
- Distributing a batch across cloud agents differently from local devices; a batch targets devices, and where a device lives is already abstracted by Plan 12.
- Retrying failed devices automatically. Manual re-run of the failed subset is in scope; automatic retry is not.

## 3. Context and design decisions

### 3.1 A cluster is a selector, not a container

> **Superseded by Plan 22.0.** A cluster is now a **container**: every device carries a `cluster` field pointing at exactly one cluster (or none), assigned and unassigned as a container membership change rather than resolved from tags at dispatch time. `clusters.tags` and `clusters.device_ids` no longer exist. The rest of this plan — batches, concurrency, ordering, the aggregate report, cancel and re-run-failed — is unchanged; only *how a cluster resolves to devices* changed, from a saved tag/id selector to a plain `SELECT * FROM devices WHERE cluster_id = ?`. See `docs/plans/22.0-clusters-as-device-field.md`.

Devices are not moved into a cluster. A cluster stores **how to find devices** — a tag set plus optional explicit ids — and resolves at dispatch time. Consequences worth stating plainly:

- A phone plugged in this morning and tagged `pool:smoke` joins every future run of that cluster with no further action.
- The cluster's membership at 09:00 and at 17:00 may differ, so the **batch records the devices it actually resolved**. The report must never be reconstructed from the cluster definition later — by then it may say something else.

### 3.2 Execution modes, expressed as one number plus an order

Four requested behaviours reduce to two independent parameters:

| Requested | `concurrency` | `order` |
|---|---|---|
| all devices at once | `0` (unlimited) | irrelevant |
| one device at a time, chosen order | `1` | `as-listed` |
| one device at a time, random | `1` | `random` |
| N at a time | `N` | either |

Modelling it as `(concurrency, order)` rather than four enum values means the scheduler has one code path, and "3 at a time in a fixed order" costs nothing extra.

**Randomness is resolved once, at dispatch.** The shuffle happens when the batch is created and is written into each job's `seq`. The report then shows the order that actually ran, the same order is visible while it runs, and nothing depends on a random number that no longer exists.

### 3.3 The claim query is the only place ordering can be enforced

`claimNext` in `packages/core/src/queue/job-store.ts` is a single SQL transaction that atomically picks a queued job for an idle device and flips that device to busy (spec §10.3). Every scheduling rule must live there, because anything enforced outside it can be raced.

Two additions:

1. **Batch concurrency** — a job whose batch already has `concurrency` jobs running is not claimable.
2. **Batch order** — within a batch, lower `seq` is claimed first.

Both fold into the existing statement rather than becoming a second pass in TypeScript. The existing global ordering (`priority DESC, created_at`) still decides between different batches and standalone jobs.

### 3.4 Why jobs stay `queued` rather than a new `pending` state

The alternative is to create only the first job of a sequential batch and add the next when it finishes. That is more code, it loses the ability to show the whole plan up front, and a crash between "job finished" and "next job created" silently truncates the batch.

Creating every job as `queued` immediately and gating the claim keeps one source of truth: the queue. The UI can show all ten devices and their positions from the first second, and a core restart resumes correctly because the state is entirely in the table.

### 3.5 Batch status is derived, not stored twice

`batches.status` is a cached projection of its jobs, recomputed whenever a member job changes state:

- any job `running` (or claimable) → `running`
- all jobs terminal, none failed → `success`
- all jobs terminal, at least one failed → `failed`
- all jobs `cancelled` → `cancelled`
- otherwise → `queued`

It is stored so the batches list is one query, and it is always recomputed from the jobs — never incremented. A recompute function that reads the jobs is the only writer.

## 4. Technical design

### 4.1 Schema

```ts
export const clusters = sqliteTable('clusters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** Devices must carry ALL of these (Plan 19 §4.3 semantics). */
  tags: text('tags', { mode: 'json' }).notNull(),          // string[]
  /** Always included regardless of tags. */
  deviceIds: text('device_ids', { mode: 'json' }).notNull(), // string[]
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const batches = sqliteTable(
  'batches',
  {
    id: text('id').primaryKey(),
    /** Null when the batch targeted an ad-hoc device list. */
    clusterId: text('cluster_id'),
    scriptId: text('script_id').notNull(),
    params: text('params', { mode: 'json' }),
    /** 0 = unlimited, else the max jobs running at once (§3.2). */
    concurrency: integer('concurrency').notNull().default(0),
    order: text('order').notNull().default('as-listed'),   // 'as-listed' | 'random'
    status: text('status').notNull().default('queued'),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
  },
  (t) => [index('idx_batches_created').on(t.createdAt)],
)
```

`jobs` gains two nullable columns (a Drizzle migration; existing rows get `NULL`):

```ts
batchId: text('batch_id'),
/** Position within the batch; the shuffle for `random` is baked in here. */
batchSeq: integer('batch_seq'),
```

and one index: `index('idx_jobs_batch').on(t.batchId, t.batchSeq)`.

### 4.2 The claim query

`claimNext` currently orders by `j.priority DESC, j.created_at`. The new statement adds a batch gate and batch ordering:

```sql
SELECT j.* FROM jobs j
JOIN devices d ON d.id = j.device_id
LEFT JOIN batches b ON b.id = j.batch_id
WHERE j.status = 'queued'
  AND d.status = 'idle'
  AND (
    j.batch_id IS NULL
    OR b.concurrency = 0
    OR (SELECT COUNT(*) FROM jobs r
        WHERE r.batch_id = j.batch_id AND r.status = 'running') < b.concurrency
  )
ORDER BY j.priority DESC, j.created_at ASC, j.batch_seq ASC
LIMIT 1
```

Notes for the implementer:

- **Corrected during implementation.** An earlier draft of this plan ordered by `batch_seq` before `created_at`, with `NULLS LAST`. That is wrong: standalone jobs have a `NULL` `batch_seq`, so `NULLS LAST` pushes every standalone job behind every batched one — the opposite of the rule stated two lines below it. Age comes first. Batch order still holds because `createBatch` stamps one `now` for the whole batch (§4.4), so every job in a batch ties on `created_at` and `batch_seq` breaks the tie.
- The correlated `COUNT(*)` runs inside the same transaction as the status flip, so two concurrent claims cannot both see a free slot. This is the property the whole design rests on — the unit test in §7 must exercise it.
- Keep the statement in one place. Do not add a TypeScript pre-filter "for clarity"; that reintroduces the race.

### 4.3 Cluster resolution

`packages/core/src/clusters/resolve.ts`:

```ts
export interface ResolvedTarget {
  deviceId: string
  /** Why it was picked, for the batch report. */
  via: 'tag' | 'explicit'
}

/**
 * Resolve a cluster to devices, right now.
 *
 * Returns every match including unusable ones, each with a reason, so the
 * caller can report "3 of 5 devices were offline" instead of quietly running
 * on a smaller set than the operator expected (§3.1).
 */
export function resolveCluster(db: Db, cluster: ClusterRow): {
  usable: ResolvedTarget[]
  skipped: { deviceId: string; reason: string }[]
}
```

A cluster resolving to zero usable devices is an **error at dispatch**, not an empty batch: silently doing nothing is the failure mode people notice last.

### 4.4 Batch dispatch

`packages/core/src/clusters/dispatch.ts`:

```ts
export function createBatch(deps: { db: Db; scheduler: Scheduler; audit: AuditLogger }, input: {
  scriptId: string
  params: unknown
  target: { clusterId: string } | { deviceIds: string[] }
  concurrency: number
  order: 'as-listed' | 'random'
  priority?: number
  createdBy?: string
}): BatchInfo
```

In one transaction: resolve targets → insert the batch → insert one job per device with `batchSeq` assigned in the final order (shuffled for `random`) → `audit_log` (`job.run`, target the batch) → `scheduler.kick()`.

The shuffle uses `crypto.getRandomValues`, not `Math.random()`.

### 4.5 Status recomputation

`packages/core/src/clusters/status.ts` exports `recomputeBatchStatus(db, batchId)`, called from the one place a job reaches a terminal state — `packages/core/src/jobs/executor-host.ts` — and from the job-cancel path. It sets `finishedAt` when the batch first reaches a terminal status and broadcasts `batch.status`.

### 4.6 API

```
GET    /api/clusters                → { clusters: ClusterInfo[] }   (each with a live resolved count)
POST   /api/clusters                → { cluster }
PATCH  /api/clusters/:id            → { cluster }
DELETE /api/clusters/:id            → 204   (batches keep their clusterId; the report stands alone)
POST   /api/clusters/:id/preview    → { usable, skipped }  — resolve without dispatching

POST   /api/batches                 → { batch }            — body per §4.4 input
GET    /api/batches?limit=&before=  → { batches: BatchInfo[] }
GET    /api/batches/:id             → { batch, jobs: JobInfo[] }
POST   /api/batches/:id/cancel      → { cancelled: number } — queued jobs only
POST   /api/batches/:id/rerun-failed→ { batch }             — a new batch over the failed devices
```

`preview` matters: dispatching to a cluster whose membership you cannot see first is how people run scripts on the wrong phones.

### 4.7 WS

`packages/protocol/src/messages/batch.ts`:

```ts
export const BatchStatusMessage = z.object({
  type: z.literal('batch.status'),
  payload: z.object({
    batchId: z.string(),
    status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled']),
    counts: z.object({
      total: z.number().int(), queued: z.number().int(), running: z.number().int(),
      success: z.number().int(), failed: z.number().int(), cancelled: z.number().int(),
    }),
  }),
})
```

Existing `job.status` events already carry per-job progress; the batch page listens to both.

### 4.8 Studio

- **`/clusters`** — list, create, edit. The editor shows a live preview of matched devices as tags are typed, using `POST /api/clusters/:id/preview` (and an unsaved-cluster variant of it).
- **`/batches`** — history with a progress bar per row (`7/10 · 1 failed`), live over `batch.status`.
- **`/batches/detail?id=…`** — the report: header status and counts, a per-device table (device, order index, status, duration, links to job logs and artifacts), and actions Cancel and Re-run failed. Durations tick live via `useNow` (Plan 17).
- **Run dialog** — gains a target switch: a single device (Plan 19's picker) or a cluster / ad-hoc multi-select, plus the concurrency and order controls. Copy states the consequence plainly: *"One device at a time, in random order — 5 devices, about 5× one run."*

## 5. Implementation steps

### 20.1 Schema and migration
- [ ] Add `clusters`, `batches`; add `batchId` and `batchSeq` plus the index to `jobs`.
- [ ] `bun run --cwd packages/core db:generate`; commit the SQL; verify existing jobs survive with `NULL`.
- Result: an existing dev DB migrates and old jobs still list.

### 20.2 Claim query
- [ ] Rewrite the `claimNext` statement per §4.2.
- [ ] Unit tests **first**: standalone jobs unaffected; `concurrency=1` never yields two running jobs in one batch; `as-listed` claims ascending `batchSeq`; a batch cannot starve a higher-priority standalone job.
- Result: the concurrency test fails against the old statement and passes against the new one.

### 20.3 Resolution and dispatch
- [ ] `clusters/resolve.ts` and `clusters/dispatch.ts` per §4.3–§4.4.
- [ ] Zero usable devices → a coded error (`E_NO_TARGETS`), not an empty batch.
- Result: dispatching to a 3-device cluster creates 3 jobs with `batchSeq` 0,1,2.

### 20.4 Status projection
- [ ] `clusters/status.ts`; call it from `executor-host.ts` and the cancel path; broadcast `batch.status`.
- Result: finishing the last job flips the batch to `success` and sets `finishedAt` once.

### 20.5 API
- [ ] Cluster CRUD plus `preview`; batch create, list, detail, cancel, rerun-failed.
- [ ] Mount in `server/http.ts`; audit cluster mutations and batch creation.
- Result: the smoke test in §7 runs end to end with curl.

### 20.6 Studio
- [ ] `/clusters` list and editor with live preview.
- [ ] `/batches` and `/batches/detail`.
- [ ] Extend the run dialog with cluster targeting and the mode controls.
- [ ] Add both to the sidebar.
- Result: a cluster of two phones runs a script one at a time, visibly, with a report at the end.

## 6. Acceptance criteria

1. A cluster can be created from tags, previewed, edited and deleted.
2. `concurrency=0` starts every device at once; `concurrency=1` never has two jobs running in the same batch; `concurrency=2` never has three.
3. `order: as-listed` runs in the given order; `order: random` runs in a shuffled order that is fixed at dispatch and visible in the report before it finishes.
4. A batch report shows every device, its outcome, its duration, and links to its job's logs and artifacts.
5. Deleting a cluster leaves past batch reports intact and readable.
6. Cancelling a batch cancels queued jobs, leaves running ones to finish, and reports how many were cancelled.
7. A standalone job with higher priority is not blocked behind a running batch.
8. A core restart mid-batch resumes the remaining jobs with no duplicates and no gaps.
9. Dispatching to a cluster with no usable devices fails with a clear message.
10. `bash scripts/typecheck.sh` and `bun test` are green.

## 7. Test plan

**Unit** (`packages/core/src/queue/job-store.test.ts` and new files)
- Concurrency gate: seed a batch of 5 with `concurrency=1`; call `claimNext` repeatedly with all devices idle; exactly one claim succeeds until the running job finishes.
- Ordering: `batchSeq` ascending within a batch; `NULL` (standalone) not pushed to the back.
- Priority: a standalone job at priority 10 wins over a batched job at 0.
- Resolution: tags AND semantics; explicit ids always included; unusable devices reported in `skipped`.
- Status projection: every combination in §3.5, including all-cancelled.
- Restart: with jobs half-finished, a fresh `claimNext` continues at the right `batchSeq`.

**Manual smoke** (two devices; `ENKAKU_TEST_DEVICE=1`)

```bash
bun run dev
curl -s -X PUT 127.0.0.1:7700/api/devices/<idA>/tags -d '{"tags":["pool:smoke"]}' -H 'content-type: application/json'
curl -s -X PUT 127.0.0.1:7700/api/devices/<idB>/tags -d '{"tags":["pool:smoke"]}' -H 'content-type: application/json'
curl -s -X POST 127.0.0.1:7700/api/clusters -H 'content-type: application/json' \
  -d '{"name":"Smoke","tags":["pool:smoke"],"deviceIds":[]}'
curl -s -X POST 127.0.0.1:7700/api/clusters/<cid>/preview | jq
curl -s -X POST 127.0.0.1:7700/api/batches -H 'content-type: application/json' \
  -d '{"scriptId":"<sid>","params":{},"target":{"clusterId":"<cid>"},"concurrency":1,"order":"random"}'
# watch /batches/detail?id=… : one device runs, then the other; durations tick
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The rewritten claim query races and double-books a device. | The gate lives inside the existing single transaction; the concurrency unit test is an acceptance criterion, not a nicety. |
| A long batch starves interactive work. | Priority still dominates the ordering, and manual control takes a device through the lease path, not the queue. Document that a batch does not block someone taking manual control of an idle device. |
| A renamed or deleted tag makes a cluster resolve to nothing. | `preview` before dispatch, and a zero-target dispatch is a loud error (§4.3). |
| Cluster membership changes between preview and dispatch. | The batch records resolved devices at creation; the report is built from the batch, never re-resolved. |
| `batchSeq` ordering surprises when mixed with priority. | One documented rule: priority first, then batch order, then age. Stated in the plan and asserted by a test. |

## 9. Open questions

1. Should a batch stop on first failure (`failFast`)? Proposed: add the flag but default it off — a smoke run across a farm usually wants full coverage even after one device fails.
2. Batch-level artifacts (one combined report file) in addition to per-job artifacts? Proposed: defer; the detail page already aggregates, and a downloadable summary can be added without schema change.
3. Chaining ("run batch B when A succeeds") — a scheduling concern, a batch concern, or neither yet? Proposed: not in this plan; revisit after Plan 21 exists, since a schedule may be the natural place for it.
4. Should `rerun-failed` copy the original `params` verbatim, or re-prompt? Proposed: copy verbatim and say so on the button, since the common case is a flaky device rather than wrong parameters.
