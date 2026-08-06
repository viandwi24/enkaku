# Plan 80 — M45 : A Script Can See the Queue

> Status: draft
> Ships: packages/core/src/jobs/script-jobs.ts
> Depends on: Plan 30 (`JobStore.list`'s keyset paging, which this exposes), Plan 79 (the `kv.call` IPC precedent this copies).

---

## 1. Goals

- A running script can list the jobs of the device it is running on — queued, running, and finished — with pagination.
- It can ask what ran immediately before it, and what is waiting behind it.
- It can read its own job's lineage once Plan 81 adds one.
- No new query engine: this is the existing `JobStore.list` exposed over IPC.

## 2. Non-goals

- Listing jobs across the whole farm. A script sees its own device (§3.2).
- Reading another job's `result` payload in full. Metadata only, plus a bounded result (§3.3).
- Waiting on a job. Nothing here blocks; Plan 81 covers triggering, and it does not await either.
- Cancelling or mutating jobs.

## 3. Context and design decisions

### 3.1 Almost all of this already exists

`JobStore.list` (plan 30 §3.2, §4.2) already does keyset paging on `(createdAt DESC, id DESC)` with `deviceId` and `status` filters, returning `{ rows, nextCursor, total }`. `api/pagination.ts` already has `encodeCursor` / `decodeCursor` / `keysetWhere`.

So the honest scope of this plan is: a projection, a scope check, and an IPC message. It is small on purpose, and it is separated from Plan 81 because listing is safe and triggering is not — a plan that mixed them would hold the safe half hostage to the review of the dangerous half.

### 3.2 Scoped to the device, and why that is not merely a default

A script is authored by whoever can publish, and it runs on one phone. Letting it enumerate the farm's jobs turns every published script into a fleet-wide read: which devices exist, what runs on them, how often, under which script names. On a shared farm that is a disclosure, and the caller has no need for it — a warmup script wants to know what happened *on this phone*.

So `ctx.jobs.list()` is fixed to `job.deviceId`. There is no parameter to widen it. If a fleet-wide view is ever needed it belongs to an agent capability (Plan 63's registry, where authority is already modelled), not to `ScriptContext`.

### 3.3 What a listed job exposes

```ts
interface JobSummary {
  jobId: string
  /**
   * Read from the job row itself once plan 82 §3.4 denormalises it, falling
   * back to `scriptNames()` for rows written before that. A script deleted
   * since the job ran — or a dev slot that has since been dropped — leaves
   * the name resolvable either way, which is why the fallback is not enough
   * on its own.
   */
  scriptName: string | null
  scriptVersion: string | null
  /** 'standalone' | 'plugin' | 'dev' (plan 82 §3.3), null for a pre-existing row. */
  origin: string | null
  pluginName: string | null
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  failureClass: 'infra' | 'script' | 'load' | null
  errorPhase: string | null
  error: string | null
  /** Plan 81 — null until it lands. */
  triggeredByJobId: string | null
  rootJobId: string | null
  depth: number | null
}
```

Deliberately **not** `params` and **not** `result`. Both are script-authored JSON that can hold anything a previous script put there, including a value it took out of the KV store's secret scope. A script that wants to pass something forward has `ctx.kv`, which is namespaced and scoped; leaking it through a neighbouring job's result payload would route around that on the first use.

`result` is available separately and narrowly: `ctx.jobs.resultOf(jobId)` returns the result **only for a job whose script shares this job's namespace** (the same plugin, or the same script name for a standalone). Same-namespace means same author, so there is nothing to cross. A dev slot shares its published plugin's namespace (plan 79 §3.2), so a dev run reads the results of jobs the released pack produced — which is the point of developing against a device that has real history on it.

### 3.4 The two convenience reads, because they are what is actually wanted

`list` answers everything, and nobody will use it for the two common questions. Both are one query:

- `ctx.jobs.previous()` — the most recent job on this device that finished before this one started. This is how a warmup script knows whether a login already ran, and how a login script knows whether it is repeating itself.
- `ctx.jobs.queuedAfter()` — jobs queued on this device behind the current one, in claim order. This is how a script decides not to enqueue a duplicate.

`previous()` is defined on `finishedAt < this.startedAt`, not "the row before mine by createdAt" — a job created earlier can start later, and the question being asked is about what the phone was actually doing.

## 4. Technical design

### 4.1 `packages/core/src/jobs/script-jobs.ts`

```ts
export interface ScriptJobsDeps { jobStore: JobStore; db: Db }

export function createScriptJobsReader(deps: ScriptJobsDeps): {
  list(job: JobRow, q: { status?: JobStatus; limit: number; cursor?: string | null }): Page<JobSummary>
  previous(job: JobRow): JobSummary | null
  queuedAfter(job: JobRow, limit: number): JobSummary[]
  resultOf(job: JobRow, targetJobId: string): { ok: true; result: unknown } | { ok: false; reason: 'not-found' | 'foreign-namespace' | 'not-finished' }
}
```

Every method takes the **caller's own `JobRow`** as its first argument rather than a `deviceId`. The scope is then derived, never passed — a signature that cannot be called with someone else's device.

`limit` is clamped to 100. `scriptNames()` (already on `JobStore`) resolves names for a whole page in one query, so a 100-row page is two queries, not 101.

### 4.2 IPC

A `jobs.call` / `jobs.result` pair in `packages/session/src/runner/ipc.ts`, identical in shape to Plan 79's `kv.call`:

```ts
z.object({ t: z.literal('jobs.call'), callId: z.string(), method: z.enum(['list','previous','queuedAfter','resultOf']), args: … })
```

Handled in the script executor, which already holds `db` and can reach `jobStore`. The child gets a `ctx.jobs` object of thin `request()` wrappers, exactly like `deviceApi`.

### 4.3 SDK surface

```ts
interface JobsApi {
  list(opts?: { status?: JobStatus; limit?: number; cursor?: string }): Promise<{ items: JobSummary[]; nextCursor: string | null; total: number }>
  previous(): Promise<JobSummary | null>
  queuedAfter(opts?: { limit?: number }): Promise<JobSummary[]>
  resultOf(jobId: string): Promise<unknown | null>
}
ctx.jobs: JobsApi
```

`resultOf` returns null for every refusal rather than four error codes — a script cannot act differently on "foreign namespace" than on "not found", and telling it which would itself disclose that a job exists. The *reason* is logged on the parent side, where an operator can see it.

## 5. Implementation steps

1. `JobSummary` in `@enkaku/protocol`, with a Zod schema (it crosses the IPC boundary).
2. `jobs/script-jobs.ts` — the reader, scoped by `JobRow`.
3. `jobs.call` / `jobs.result` in `runner/ipc.ts`.
4. Parent handler in `jobs/executors/script.ts`.
5. `ctx.jobs` in `runner/child-entry.ts`.
6. `JobsApi` on `ScriptContext` in `packages/sdk/src/types.ts`.

## 6. Acceptance criteria

1. A script lists its device's jobs and sees its own job in the results.
2. Jobs belonging to another device never appear, and no argument can make them.
3. `list` pages: two pages of 2 over 5 jobs return disjoint sets and a working cursor.
4. `limit: 5000` is clamped to 100 rather than refused.
5. A listed job carries no `params` and no `result` field at all — asserted on the serialised payload, not on the type.
6. `previous()` returns the job that finished most recently before this one started, including one created *after* it.
7. `previous()` on a device's first-ever job returns null.
8. `queuedAfter()` returns queued jobs in claim order and excludes the caller.
9. `resultOf` returns the result for a same-namespace job and null for a foreign one, with the refusal logged on the parent.
10. A 100-row page issues one `scriptNames` query, not 100 (counted through `sqlite.prepare`, as `devices.test.ts` already does).

## 7. Test plan

`jobs/script-jobs.test.ts` against an in-memory DB seeded with jobs across two devices and two namespaces. Criterion 5 asserts on `JSON.stringify` of the payload, because a type-level omission is not a runtime guarantee. Criterion 10 reuses the `prepare`-counting technique already in `api/devices.test.ts`.

## 8. Risks and mitigations

- **`resultOf` becomes a side channel.** Mitigation: same-namespace only, null on every refusal, reason logged parent-side.
- **A script polls `list` in a loop.** Mitigation: it is a local SQLite read on an indexed keyset; no rate limit in this plan, but the query count is asserted (criterion 10) so a regression to N+1 fails a test.
- **`previous()` looks like a happens-before guarantee.** It is not — a job on another device could have run in between, and the device could have been driven manually. The SDK doc says so where the author reads it.

## 9. Open questions

1. **Should `list` see jobs from before the device was re-admitted?** Forget deletes jobs (plan 47), so today the question cannot arise. It will if Forget ever gains a "keep history" option.
2. **A namespace-wide view across devices** — "has this account been warmed on any phone today" is a plausible pack-level question that `ctx.kv.global` can answer instead. Left to KV until a case needs the job rows themselves.
