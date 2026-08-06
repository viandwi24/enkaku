# Plan 81 — M46 : A Job Can Start a Job

> Status: implemented — `packages/core/src/jobs/triggers.ts`'s `createJobTrigger({db, registry, budgets, log})` is the whole mechanism: one `db.transaction()` per call that checks idempotency FIRST (a re-run must not be refused by a budget that changed since its first success), resolves and pins the reference through `ScriptRegistry.resolve(ref, {allowDev:true})`, checks the target device (`device_not_found`/`device_unavailable`), checks `depth`/`maxPerChain`/`maxPerJob` (`E_TRIGGER_TOO_DEEP`/`E_TRIGGER_CHAIN_FULL`/`E_TRIGGER_FAN_OUT`, all real throws), then inserts — the count and the insert share the one transaction. `rootJobId`/`depth` are computed from the CALLING job's own row (`from.rootJobId ?? from.id`, `(from.depth ?? 0) + 1`), never from caller input. Schema: four nullable/defaulted columns on `jobs` (`triggeredByJobId`, `rootJobId`, `depth` default 0, `triggerKey`) plus a partial unique index `(rootJobId, triggerKey) WHERE trigger_key IS NOT NULL` and two lookup indexes — migration `0040_misty_blade.sql`, hand-checked: pure `ALTER TABLE ... ADD` and `CREATE INDEX`, no rename, no rebuild. IPC: `trigger` added to plan 80's existing `JobsCallSchema` discriminated union (`packages/session/src/runner/ipc.ts`) — one more variant, not a second surface; `key` is REQUIRED at this wire boundary (never optional) because the default derivation happens CHILD-SIDE, in `jobs-client.ts`'s `createJobsApiFor(request, {id, attempt})`, which closes over an in-process call counter and computes `${jobId}:${attempt}:${callIndex}` before the IPC message is ever sent — the reason `child-entry.ts` now builds this client inside `runScript` (once `init.job` is known) rather than at module scope like `ctx.kv`. That client-side derivation is what makes idempotency actually work: a fresh process (`job-runner.ts`'s own existing finish-only fallback, spawned after ANY failed attempt, same attempt number) restarts the counter at 0 and reproduces the identical key sequence, so the SAME script code re-executed dedupes automatically, while a genuinely new attempt (a different `attempt` number) produces a different key and a different job — proven through the REAL `createJobRunner` (no mocked trigger mechanism) in `jobs/trigger-runner.integration.test.ts`, per the plan's own §7 reasoning that a unit test of the key function alone would pass while the runner interaction stayed broken. Parent-side wiring: `jobs-runner-port.ts` gained a `trigger` case beside `list`/`previous`/`queuedAfter`/`resultOf`, plus `JobsRunnerPortDeps.registry`/`.triggerBudgets`/`.onTriggered` (the last firing a `job.triggered` main-stream device event on the TARGET device, only for a non-deduped result) — `daemon.ts` wires `registry: scriptRegistry` (the same one every other trigger-shaped caller resolves through) and `triggerBudgets: () => settingsStore.get().job.trigger`. Settings: `JobSettingsSchema.trigger` (`maxDepth` 5, `maxPerChain` 200, `maxPerJob` 10), read fresh per call, the same freshness pattern `resetPolicy`/`adb.maxConcurrent` already use. SDK: `ctx.jobs.trigger(input): Promise<{jobId, deduped}>` (`packages/sdk/src/types.ts`'s `JobsApi`/`TriggerInput`/`TriggerResult`, re-exported from `index.ts`), documented in `packages/sdk/README.md`. `JobSummary.triggeredByJobId`/`.rootJobId`/`.depth` (plan 80's already-declared, previously-always-null fields) are now populated from the row (`jobs/script-jobs.ts`). Cancel-with-descendants (§4.4): `JobStore.cancelQueuedDescendants` walks `triggeredByJobId` transitively (a level-by-level BFS, not a `rootJobId` heuristic, so a job's siblings and their own descendants are left alone), wired as an opt-in `?cancelDescendants=1` on `POST /api/jobs/:id/cancel` (`JobCancelResponseSchema` gained an additive, defaulted `cancelledDescendants` field); the agent-facing `job.cancel` CAPABILITY (plan 63) deliberately was NOT extended with the option — out of this plan's scope, recorded as a deviation below. `bun run typecheck` is OK across all 12 packages. Root `bun test` is 2409 pass / 0 fail (baseline 2369 + 40 net new, all in this plan's own files: `jobs/triggers.test.ts` (17), `jobs/trigger-runner.integration.test.ts` (2), plus new `describe` blocks in `runner/jobs-client.test.ts`, `runner/ipc.test.ts`, `jobs/jobs-runner-port.test.ts`, `queue/job-store.test.ts`, `services/job-service.test.ts`, `api/jobs.test.ts`, and small fixture updates in `clusters/dispatch.ts`/`.test.ts` and `jobs/executor-host.test.ts` for the new columns). `packages/studio` unchanged at 312 pass / 0 fail — no Studio UI shipped this pass (see deviations). `bash scripts/check-harness-provenance.sh` and `bash scripts/check-plan-status.sh` both exit 0. **Deviations, recorded rather than silent:** (1) Criterion 5's "two concurrent triggers" is tested as two back-to-back calls at the exact boundary, not real OS-thread concurrency — `trigger()` is fully synchronous (one `db.transaction()`, no `await` inside it) and Bun/JS is single-threaded, so two JS-level calls cannot actually interleave within one process; the atomicity the criterion cares about (the count and the insert sharing one transaction) is what makes the sequential-call test meaningful at all. (2) The plan's `TriggerInput.key?: string` and the interface signature `trigger(from: JobRow, input: TriggerInput)` are followed, but `JobTriggerDeps` drops the plan's sketched `jobStore: JobStore` — nothing in the actual implementation needs it (the whole read/write path goes through `tx` directly, matching plan 79's own established discipline of threading the transaction handle explicitly rather than closing over an outer `db`). (3) `job.cancel`'s agent-facing capability (plan 63) was not extended with `cancelDescendants` — that surface belongs to a different plan's territory; only the REST route gained the opt-in. (4) Studio (lineage on the job detail page, `job.triggered` in the Monitor feed — step 8) was not built, the same scope cut plan 79 made for its KV panel: none of this plan's 13 acceptance criteria touch Studio, and the REST/event surface is real and ready for a panel to call. (5) A real-spawned-child (`Bun.spawn` against the actual `child-entry.ts`, the pattern `child-entry.test.ts` already uses for plugin-bundle selection) trigger-specific test was not added on top of the three layers that already exist (child-side key-derivation unit tests, a real-DB `createJobTrigger` unit suite, and a real-`createJobRunner`-against-real-DB integration suite) — judged sufficient coverage given the size of the rest of this plan.
> Ships: packages/core/src/jobs/triggers.ts
> Depends on: Plan 80 (the `jobs.call` IPC surface this extends, and `JobSummary`'s lineage fields), Plan 62 (pinned script refs — a trigger must pin, not resolve `@latest` at claim time).

---

## 1. Goals

- A running script can enqueue another job and keep going.
- The enqueue is **fire-and-forget**: it returns a job id, never a result, and never blocks. One device runs one job at a time, so awaiting would deadlock by construction.
- Every triggered job records who triggered it, what the root of the chain was, and how deep it is.
- A runaway chain is stopped by the system, not by the script author remembering to stop it.
- A retried or re-run phase does not enqueue the same job twice.

## 2. Non-goals

- Awaiting a triggered job, or receiving its result. If a script needs the answer, the two halves belong in one script.
- Cross-farm or cross-node triggering.
- Priority inheritance or queue jumping. A triggered job queues like any other.
- Replacing batches (plan 20) or schedules (plan 62). Those remain the way to fan out deliberately; this is for a script that discovers work mid-run.

## 3. Context and design decisions

### 3.1 Why this is the risky one

The other three plans add a store, a reader, and a build format. This one lets a script create work. Every failure mode is a multiplier:

- A script that triggers itself fills the queue forever, and because nothing awaits anything, **no error is raised anywhere**. The first symptom is a device that never goes idle.
- `finish()` is documented — in `ScriptDefinition` and in the SDK README — as *stateless and idempotent, because the core may run it again in a fresh process after a timeout kill*. A trigger in `finish()` is therefore a trigger that runs twice on exactly the runs that went wrong.
- `retries` re-runs `run()`. A trigger near the top of `run()` fires once per attempt.

None of these are hypothetical hazards to be documented; they are the default behaviour of the obvious implementation. So the containment is in the mechanism (§3.2, §3.3), not in the guidance.

### 3.2 Lineage is recorded, and it is what enforces the bound

Three columns on `jobs`:

- `triggered_by_job_id` — the job whose script called `trigger()`. Null for a job a human, schedule, or batch created.
- `root_job_id` — the origin of the chain. A job with no trigger is its own root.
- `depth` — 0 for a root, parent + 1 otherwise.

`depth` is what a cap can be enforced against, and `root_job_id` is what a fan-out budget can be counted against. Both are set by the parent at enqueue time from the *triggering job's own row*, never from anything the child sends — a child that could name its own depth could name zero.

Two bounds, both farm settings, both refusals rather than silent drops:

| bound | default | error |
|---|---|---|
| `jobs.trigger.maxDepth` | 5 | `E_TRIGGER_TOO_DEEP` |
| `jobs.trigger.maxPerChain` | 200 | `E_TRIGGER_CHAIN_FULL` |
| `jobs.trigger.maxPerJob` | 10 | `E_TRIGGER_FAN_OUT` |

`maxPerChain` counts every job sharing a `root_job_id`. It is the one that actually stops a runaway, because a self-triggering script at depth 1 that re-roots itself would otherwise never hit `maxDepth`. `maxPerJob` bounds a single job's own fan-out so one script cannot queue a thousand in a loop.

A refused trigger **throws in the script**. The alternative — returning null and logging — makes a script that depends on the chain continue silently as though it had not been cut off.

### 3.3 Idempotency is required, not optional

Every trigger carries a key. The script may supply one; if it does not, the runtime derives `${jobId}:${attempt}:${callIndex}` — the call index being the count of triggers already made in this attempt.

The key is stored in a unique index alongside `root_job_id`. A second trigger with the same key returns **the same job id** and enqueues nothing.

That default handles the two mechanical cases without the author thinking about it: a re-run `finish()` produces the same key and therefore the same job; a retry of `run()` produces a *different* key (the attempt differs) and therefore a new job — which is correct, because a retried run genuinely is a fresh attempt at the work.

The case the default cannot handle is deliberate and is why the parameter exists: "enqueue the follow-up for account X at most once, ever, across every attempt and every device". That needs `key: 'followup:accountX'`, and only the author knows it.

### 3.4 The reference is pinned at enqueue time

`trigger()` takes a script reference — `name`, or `name@version`, or `plugin/script@version` once Plan 82 lands. `@latest` is resolved **at trigger time** and the concrete `scripts.id` is written to the new row.

This is plan 62's lesson applied to a new caller: a schedule that stored `@latest` and resolved at fire time meant a job's identity depended on when the queue got to it. The same is true here and more sharply, because a chain can sit in the queue behind a long job while someone publishes.

Resolution goes through plan 82's `ScriptRegistry`, not `resolveScriptRef` directly, and the trigger path is one of only two callers that pass `allowDev: true` (the other being an ad-hoc run). A dev slot can therefore start a chain and continue one — a pack author testing "login then warmup" needs exactly that — while a schedule still cannot, because a schedule outlives the session that owns the slot. When a chain's job resolves to a dev entry, the pin recorded on the row is the dev entry's build-stamped version (`1.0.0+dev.7`), so the job history says which build ran even after the slot is gone.

### 3.5 The target device

`trigger()` defaults to **the current device**. A different device may be named, and then:

- the device must exist, not be blocked, and not be quarantined — checked at enqueue, refused with a typed error otherwise;
- the depth and chain budgets still apply, because the chain is the chain regardless of which phone continues it.

Targeting a whole cluster or tag is *not* in this plan. That is a fan-out, and fan-out already has a designed home in batches (plan 20) with its own ordering, cancellation, and status roll-up. Recreating a worse one behind `trigger()` would be the kind of parallel mechanism this codebase keeps getting bitten by. Recorded as open question 2.

### 3.6 What the script gets back

```ts
const { jobId, deduped } = await ctx.jobs.trigger({ script: 'tiktok/warmup@1.2.0', params: { … } })
```

`jobId` so the *next* job can find it through Plan 80's reader, and `deduped: true` when an existing job was returned instead of a new one — otherwise a script cannot tell "queued" from "already queued", and both look like success.

## 4. Technical design

### 4.1 Schema

```ts
// added to `jobs`
triggeredByJobId: text('triggered_by_job_id'),
rootJobId: text('root_job_id'),
depth: integer('depth').default(0),
triggerKey: text('trigger_key'),
```

plus

```ts
uniqueIndex('idx_jobs_trigger_key').on(t.rootJobId, t.triggerKey),   // partial: WHERE trigger_key IS NOT NULL
index('idx_jobs_root').on(t.rootJobId),
```

All nullable/defaulted, so every existing row keeps reading. A pre-existing job has `depth 0` and a null root, which is exactly true of it.

### 4.2 `packages/core/src/jobs/triggers.ts`

```ts
export interface TriggerInput {
  script: string                  // ref: name | name@version | plugin/script@version
  params?: unknown
  deviceId?: string               // defaults to the triggering job's device
  priority?: number
  key?: string
  expiresAt?: number | null
}

export function createJobTrigger(deps: { db: Db; jobStore: JobStore; log: Logger }): {
  trigger(from: JobRow, input: TriggerInput): { jobId: string; deduped: boolean }
}
```

One transaction: resolve the ref → check the device → count the chain → check the budgets → insert with lineage → return. The count and the insert must share the transaction, or two concurrent triggers both read 199 and both insert.

### 4.3 IPC and SDK

Extends Plan 80's `jobs.call` with a `trigger` method rather than adding a message type. `ctx.jobs.trigger(input)` on the SDK side.

### 4.4 Cancellation follows the chain

Cancelling a job offers "cancel N queued jobs triggered by this one" — the count comes from `root_job_id` and `depth >`, and it is opt-in on the cancel call, not automatic. Automatic would surprise; absent would leave an operator cancelling 40 rows by hand after one bad script.

### 4.5 Observability

- The job detail page shows `triggered by <job>` and, for a root, the chain size.
- One `job.triggered` device event, so the chain is visible in the Monitor feed as it grows.
- A refused trigger logs at `warn` on the parent with the bound that refused it and the chain's current size. A chain hitting its cap is an operational fact, not a script's private failure.

## 5. Implementation steps

1. Migration: four columns, two indexes.
2. `jobs/triggers.ts` — resolution, checks, transactional insert.
3. Farm settings `jobs.trigger.{maxDepth,maxPerChain,maxPerJob}` with defaults.
4. `trigger` on the `jobs.call` IPC method union + parent handler.
5. `ctx.jobs.trigger` in `runner/child-entry.ts` and `JobsApi` in the SDK.
6. `JobSummary` lineage fields populated (Plan 80 declared them null).
7. Cancel-with-descendants on the cancel path.
8. Studio: lineage on the job detail page; `job.triggered` in the Monitor feed.

## 6. Acceptance criteria

1. A script triggers a job on its own device; the job appears queued and the script continues without waiting.
2. The triggered job's row carries `triggeredByJobId`, `rootJobId`, and `depth = 1`.
3. A chain reaching `maxDepth` refuses with `E_TRIGGER_TOO_DEEP`, the script sees the throw, and no row is written.
4. A self-triggering script stops at `maxPerChain` — proven by running one and asserting the chain stops, not by asserting the counter alone.
5. Two concurrent triggers against a chain at `maxPerChain - 1` result in exactly one new job.
6. The same trigger key twice returns the same `jobId` with `deduped: true`, and the queue grows by one, not two.
7. A `finish()` that triggers, on a job killed by timeout and re-run, produces **one** job.
8. A `run()` that triggers, on a script with `retries: 2` that fails twice, produces **three** jobs — different attempts are different work.
9. `@latest` is resolved at trigger time: publishing a higher version after the trigger does not change what the queued job runs.
10. Triggering onto a blocked or quarantined device is refused with a typed error.
11. Cancelling a root with the descendants option cancels its queued descendants and leaves unrelated jobs alone.
12. A pre-existing job row (no lineage columns) still loads, lists, and runs.
13. A dev-slot script triggers a job, and the queued row records the build-stamped version (`…+dev.n`), so the chain is still readable after the slot is dropped.

## 7. Test plan

`jobs/triggers.test.ts` against an in-memory DB. Criteria 5 and the counting logic use real overlapping transactions. Criteria 7 and 8 run through the actual runner with a script bundle that triggers, because the whole point is the interaction between the phase lifecycle and the key derivation — a unit test of the key function would pass while the integration stayed broken. Criterion 4 runs a genuine self-triggering script to exhaustion against a low cap.

## 8. Risks and mitigations

- **A queue full of triggered jobs starves human work.** Mitigation: triggered jobs inherit priority 0 and do not jump; an operator can cancel the chain by root. Considered and rejected: a separate lower-priority lane, which would make a pack's own follow-up work arbitrarily late.
- **`deduped: true` is ignored by authors.** Mitigation: it is a required field of the return object, not an optional one, so destructuring shows it.
- **The bounds are wrong for a real pack.** Mitigation: farm settings, changeable without a release; the defaults are deliberately low, because a too-low cap fails loudly and a too-high one fails at 3am.
- **Chains outlive the intent that made them.** A chain triggered by a schedule at 02:00 can still be running at 06:00. Mitigation: `expiresAt` is inherited from the triggering job by default, so a chain cannot outlive its root's expiry window.

## 9. Open questions

1. **Should a chain have a wall-clock budget as well as a size?** `expiresAt` inheritance covers the common case; a genuine time budget on `root_job_id` may be wanted once a pack runs long chains.
2. **Fan-out to a cluster or tag.** Deliberately excluded (§3.5) in favour of batches. If a pack genuinely needs it, the right answer is likely `trigger` creating a *batch*, not N jobs.
3. **Should a triggered job be visible as a batch in Studio?** A chain and a batch look similar to an operator and are not the same thing. Naming them apart in the UI needs a decision before the chain view is built.
