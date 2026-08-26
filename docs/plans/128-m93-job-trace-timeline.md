# Plan 128 — M93 : Job Trace — a timeline you can scrub, for every run

> Status: implemented (software) — steps 128.1–128.9 land, 2026-08-26, opened the same day from the owner's own request: *"daripada cuman logs aja gimana kalau dilengkapi lebih detail lagi? termasuk snapshot screen nya, ui server untuk get nodes ui nya, dan logsnya… ada timeline gitu kaya editor video jadi kita tahu kapan kapan aja gitu terjadi event."* Every job now carries an append-only, **millisecond-resolution** `job_events` stream: one `action` row per device call with its redacted arguments, its duration and its outcome, beside every log line, phase boundary, artifact, progress push and human assist, on one axis. **Frames are captured per action on a `ui-server` session and on the failing action everywhere else** — a policy derived from the resolved inspector engine, with no setting anywhere — behind a single in-flight capture slot, and every event the policy wanted a frame for and did not get one carries `skipped-policy`/`skipped-busy`/`failed` rather than a silent gap. Frames and UI trees are content-addressed under `traces/<jobId>/`, so two actions on an unchanged screen write one file and produce two distinct events. `GET /:id/trace` (keyset on `seq`, which is arrival order — clients sort by `(atMs, seq)` to render), `/trace/frames/:hash`, `/trace/ui/:hash`, `DELETE /:id` and `POST /history/clear` all ship; the last behind a **new admin-only `job.history.purge` permission** (decided, not asked — §9 Q4), and one `deleteJobsWithHistory` cascade is shared by all three destructive callers including device removal, whose inline deletes were *replaced*. `retention.traceDays` (30, ungated by `retention.enabled`) sweeps whole traces per job on `MAX(at_ms)`. `ScriptContext` is untouched and `packages/sdk/src/types.ts` has no diff. **Seven defects in this plan's own design were found by the workers implementing it, not by its author, plus an eighth deliberate strengthening** — §10 records each: the severe one is `seq` having two authorities, which would have violated `uniqueIndex(jobId, seq)` on every event of a rebound job's second attempt; the most expensive is that nothing carried the frame **bytes** out of `@enkaku/session`, which would have left every frame lane silently empty while events flowed correctly and nothing anywhere threw. **NOT verified on hardware.** No device was attached at any point in this plan's execution: §7's manual smoke test has never been run, so nothing here has been seen end to end against a real phone. **Acceptance criterion 2 — the "does tracing slow the script" wall-clock comparison against a pre-plan baseline — is therefore UNMEASURED, on both engines.** The design bounds the cost by construction (one outstanding capture, `ui-server` off the per-device adb queue, every async consequence fire-and-forget) and the unit tests prove the tee never awaits and never throws out of `end()` — but a bound argued from the code is not a measurement, and §8's R1 (per-action capture slowing scripts even on `ui-server`) and R2 (disk growth, estimated at 10–40 GB/day for a 200-device farm and never observed) both stand open. §9's four open questions stand.
> Depends on: plan 05 (M4, the subprocess runner and the `device.call` IPC boundary this plan tees), plan 06 (M4.5, the `ui-server` inspector whose off-queue transport is what makes per-action capture affordable), plan 18 (M11b, `device_events` — the buffer-and-flush recorder pattern this plan copies), plan 60 (M35, `jobs.errorPhase`), plan 70 (M65, the content-addressed blob store whose hashing this plan reuses without reusing its table), plan 91 (M56, `ctx.onAssist`), plan 94 (M59, the action recorder — the tee doctrine and the "observe, never alter" rule this plan inherits verbatim), plan 99 (M64, `artifacts.nodeId` and the workflow node axis).
> Spec references: §7.9 (driver layers — the inspector layer is the capture source), §11.2 (artifacts and app-data paths), §12 (data model), §18 (retention), §19 (Job detail).
> Ships: packages/core/src/jobs/trace/recorder.ts

---

## 0. Evidence

### 0.1 The request, and what is missing today

The owner debugs failed automation runs by reading a log. The log says `find refused: not-found (sel={"text":"Post"})`. It does not say what was on the screen. Reconstructing that means re-running the script on the same device and watching — which is exactly the loop this plan removes.

Everything needed to answer the question is already produced and then thrown away:

| Fact | Where it exists today | Where it goes |
|---|---|---|
| Every device action a script takes | `packages/session/src/runner/ipc.ts` `DeviceCallSchema` — 21 verbs, all crossing `device.call` at `job-runner.ts:895` | Executed and discarded. Only `find` refusals reach the log (plan 74 §3.5). |
| How long each one took | `execDevice(call.data)`'s own promise | Never measured. |
| The screen at that instant | `session.inspector.screenshot()` | Taken only when a script explicitly calls `ctx.artifact.screenshot(label)`. |
| The UI tree at that instant | `session.inspector.dump()` | Taken only when a script explicitly calls `ctx.device.dump()`; never stored. |
| The phase boundary | `msg.t === 'phase'` at `job-runner.ts:884` | Broadcast, then only the *failing* phase is persisted (`jobs.errorPhase`). |
| A human touching the device mid-run | `ctx.onAssist` (plan 91 §3.6) | Delivered to the script; visible in `GET /api/jobs/:id/assists`, on no shared time axis. |

### 0.2 The tee already exists — for manual input, not for scripts

`packages/core/src/recording/session.ts` (plan 94) already does the hard half of this plan for the *manual* input path: it observes every input, captures a step screenshot and a UI anchor dump in the background, tracks the in-flight work so the recording can wait for it, and never sits on the critical path. Its module doc states the rule this plan inherits without amendment:

> **The tee must observe, never alter** — `observe()` is synchronous and returns `void`. Every genuinely async piece of work it starts runs in the background and is never on the critical path the real device call sits on.

This plan is that same tee, moved one boundary over: from `ws-handlers.ts`'s `input.*` branch to `job-runner.ts`'s `device.call` branch.

### 0.3 The capture cost is not uniform — it depends on the inspector engine

This is the measurement that decides the whole design. A screenshot's cost, and whether it steals a slot from the running script, depends entirely on which inspector engine the session resolved:

| Engine | Screenshot path | Contends with the script? |
|---|---|---|
| `ui-server` (`drivers/src/inspector/ui-server/index.ts:189`) | JSON-RPC over HTTP through an `adb forward` TCP socket. `private call()` (`index.ts:91`) adds a watchdog, **no serialisation**. | **No.** It never acquires the per-device adb semaphore (`packages/adb/src/queue.ts`), so it cannot queue ahead of or behind a script's device call at the host layer. |
| `uiautomator-dump` (`drivers/src/inspector/uiautomator-dump.ts:113`) | `transport.execOut('screencap -p')` | **Yes.** Every `execOut` passes through the per-device `Semaphore`, which is plain FIFO with no priority. A background capture inserted between two script calls adds its full duration to the script's next call. |

The owner's requirement is explicit and it is a hard constraint: *"async aja intinya jangan sampai mengganggu script nya jalan."* On `uiautomator-dump` there is no way to capture per action and honour that. §3.4 resolves the collision.

### 0.4 Why the agent blob store is NOT reused for this

`packages/core/src/agent/blob/gc.ts:51`'s `referencedBlobIds()` scans `agent_messages` and nothing else. Any blob that table does not reference becomes an orphan and is swept once it clears `retention.blobOrphanGraceHours`. Storing trace frames there would mean every trace screenshot disappearing 24 hours later — not a bug in that GC, which is behaving exactly as documented, but a wrong home.

The owner's own model is the correct one and it removes the problem entirely: *"ini masuk ke penyimpanan khusus untuk job history… kecuali jobnya dihapus, otomatis history dan debug ini juga ikut kehapus."* One directory per job, one lifetime, one cascade. §3.5.

---

## 1. Goals

1. Every job — successful or failed — has an append-only, millisecond-resolution event stream in `job_events`, written without the running script ever awaiting a database.
2. Every device call a script makes appears as one `action` event carrying its method, arguments, duration, and outcome (ok, or an error code and message).
3. **One action, one screenshot.** On a session whose inspector engine is `ui-server`, every device action gets a frame captured next to it — no sampling, no per-job cap. A frame is addressed by the SHA-256 of its bytes, so two actions on an unchanged screen point at one file on disk while remaining two distinct events.
4. On a session that fell back to `uiautomator-dump`, per-action capture is off and only the failing action's frame is captured; the timeline says so in words rather than showing gaps.
5. A UI tree snapshot is stored for every action that already produced one (`dump`, `find`, `waitFor` — the tree is a by-product of the call the script already paid for) and for the failing action.
6. A capture that fails, times out, or is skipped is recorded as such on its event. The timeline never omits silently.
7. `GET /api/jobs/:id/trace` serves the stream; `GET /api/jobs/:id/trace/frames/:hash` serves a frame. A running job's timeline updates live over `/ws`.
8. The job detail page gains a **Timeline** tab: a time axis with lanes (phase, action, log density, film-strip), a scrubber that resolves to the frame and log window at that instant, and a detail panel per action showing arguments, duration, outcome, before/after frames, and the UI tree.
9. `DELETE /api/jobs/:id` and a "Clear history" action exist, and both cascade: the job row, its artifacts, its `job_events`, and its trace directory all go together.
10. The script-facing API is **byte-identical**. `ScriptContext` gains no member; no published bundle changes behaviour; no setting has to be switched on.

## 2. Non-goals

- **Video.** `artifacts.kind` has carried `'video'` since M4 with no producer, and decoding the scrcpy H.264 stream host-side needs a codec dependency this repo deliberately does not have (`agent/blob/store.ts`: *"no decoding and no image-codec dependency"*). A film-strip of PNG frames is the deliverable here. A real recording is a later plan.
- **Re-encoding or downscaling frames.** Same reason. Frames are stored as the inspector hands them over.
- **Replaying a trace as an executable script.** That is the action recorder's job (plan 94, `recording/compile.ts`). A trace is a record, not a program.
- **Tracing manual (non-job) device control.** `device_events` already covers that stream (plan 18).
- **Cross-job frame dedupe.** Deliberately given up in exchange for a cascade that cannot be got wrong (§3.5).
- **Tracing node-owned (cloud) jobs' device calls.** The tee lives in `@enkaku/session`'s local runner, so a remote job's **action lane** is empty and the UI says so. Its phase, log and artifact events *are* recorded — but not for free, as this plan's first draft asserted: `createRemoteJobBridge`'s `hooks` only ever broadcast over `/ws`, and wrote no rows anywhere. Three `traceRecorder.record(...)` calls were added at those hooks (daemon.ts) to make the claim true. Teeing the remote **device calls** themselves is the follow-up, and §9 Q1 asks where that tee should live.

## 3. Context and design decisions

### 3.1 One tee, at one boundary

The child process never opens adb itself — `ipc.ts`'s own module doc states it: *"The child NEVER opens adb itself — every device action travels as a `device.call` to the parent."* That makes `job-runner.ts:895` the single place where every action a script takes is visible, in order, with its arguments already Zod-parsed by `DeviceCallSchema`.

The tracer wraps `execDevice`, nothing more:

```ts
// packages/session/src/runner/trace.ts — pure, no I/O, fully unit-testable
export interface TraceTee {
  /** Called with the parsed call the instant before it is executed. Returns the token to close with. */
  begin(call: DeviceCall): TraceToken
  /** Called when the call settles. NEVER throws, NEVER returns a promise the caller awaits. */
  end(token: TraceToken, outcome: { ok: true; value: unknown } | { ok: false; code: string; message: string }): void
}
```

`begin` is synchronous and returns a token. `end` is synchronous, returns `void`, and every genuinely async consequence (a capture, a flush) is started inside it and never awaited by the call site. The `.then`/`.catch` at `job-runner.ts:902-934` gain one `tee.end(...)` line each and are otherwise untouched.

### 3.2 What counts as an action, and what a script asked for itself

Every `DeviceCall` method is an action, including the read-only ones — the owner asked for this explicitly: *"misal ada action listen ui atau get nodes, yah disitu di screenshot."* A `find` that returns nothing is exactly the moment a debugger wants a picture of.

Two exclusions, both to avoid recursion rather than to save cost:

- `method: 'screenshot'` — the script is already taking a picture; the trace records the event and reuses the script's own bytes as the frame rather than taking a second one.
- The `artifact.save` path with `kind: 'screenshot'` (`job-runner.ts:1039`) — same reasoning, recorded as an `artifact` event whose frame hash is the artifact's own bytes.

### 3.3 Timestamps are milliseconds, and they are their own column

`00-overview.md` §4.2 fixes DB timestamps at integer unix **seconds**, and every existing table obeys it. A timeline cannot: two taps 180 ms apart are the whole point. `job_events.at_ms` is therefore an `integer` holding unix **milliseconds**, deliberately **not** `{ mode: 'timestamp' }`, and its column comment says why and points here.

The nearest precedent is `agent_approvals.expiresAt` (schema.ts:1787), which departs from `{ mode: 'timestamp' }` with its reason written at the column. That is a precedent for *documenting a departure*, not for milliseconds — no column in this schema has ever held milliseconds, so this one is genuinely first and its comment carries the whole justification rather than leaning on a neighbour.

`seq` (a per-job monotonic integer assigned by the recorder, not by the clock) is the tiebreaker and the sort key. Two events in the same millisecond must still order deterministically, and a keyset page must be stable.

**The recorder is the single `seq` authority, and this plan's first draft got it wrong.** §4.1 and step 128.3 between them gave the number two owners: the recorder, and the pure per-attempt tee inside `@enkaku/session`. A job that infra-retries builds a **second** tee for the **same** job id — two independent counters both starting at 1 — and every event of attempt 2 then violates `uniqueIndex('idx_job_events_seq')`. Found by step 128.5's worker before either side shipped.

The tee therefore emits an **input-shaped** event carrying neither `id` nor `seq` (`TraceRecordInput = Omit<JobTraceEvent, 'id' | 'seq'>`), and `onTraceEvent` is typed to that shape so the two sides cannot drift back apart. The recorder seeds its counter lazily from the highest `seq` already stored for that job, so attempt 2 continues attempt 1's sequence rather than restarting it — which is also what makes a rebound job read as one continuous timeline instead of two overlapping ones. Ordering is the tee's contract; numbering is the recorder's.

### 3.4 The capture policy is derived, never configured

`session.inspectorEngineId` (`packages/session/src/session.ts:178`) is already exposed on the live session. The tracer reads it per attempt:

| `inspectorEngineId` | Per-action frame | Frame on the failing action | UI tree |
|---|---|---|---|
| `ui-server` | **yes** — off the adb queue (§0.3) | yes, plus the frame before it | stored for `dump`/`find`/`waitFor` (free — the call already produced it) and captured for the failing action |
| `uiautomator-dump` | **no** — it would steal adb slots from the running script | yes (the job has already failed; nothing is left to slow down) | failing action only |
| inspector not ready / null | no | no | no |

There is no setting. The owner's requirement was *"udah otomatis aktif yah ga harus ada inputnya"*, and an engine-derived policy needs no operator to understand it. The Timeline tab shows the resolved policy as one line (`Frames: per action (ui-server)` / `Frames: on failure only (uiautomator-dump)`) so an empty action lane is never mistaken for a bug.

**Where that line's data comes from** (raised by step 128.1's worker, and a real hole in this plan's first draft): it is **not** derived from the events' `frameStatus`. A job that failed in `prepare` has zero action events, so there would be nothing to derive it from — precisely the case where an empty timeline most needs explaining. Instead, every `phase` `start` event carries `meta: { inspectorEngineId: string | null, framePolicy: 'per-action' | 'on-failure' | 'none' }`, resolved at that moment. This needs no new column and no new event kind — `meta` is already `z.record(z.string(), z.unknown())`.

Per-phase rather than per-job is deliberate: the `ui-server` watchdog can declare the engine dead mid-run (`drivers/src/inspector/ui-server/index.ts:87`'s `isDead()`) and the session falls back to `uiautomator-dump`. A job really can change policy while running, and the timeline shows where it happened rather than averaging it into one wrong label. The tab reads the most recent `phase` start event at or before the playhead.

**Every capture is fire-and-forget, bounded at `MAX_CONCURRENT_CAPTURES` (4) outstanding per job.** A capture that throws or times out records `frame: 'failed'` with the reason; one that arrives at a saturated ceiling records `frame: 'skipped-busy'`. Neither can fail the job: the capture promise is `.catch()`-ed at its origin and its result only ever mutates a trace row.

**This was a single slot, and the owner corrected it after implementation.** Their words: *"satu action satu screenshot… screenshotnya di async, ada kemungkinan screenshot baru selesai pas ui berubah yah gapapa itu udah resiko"* — a late, slightly stale frame is what was asked for; no frame is not. One slot meant that on any script quicker than a screenshot — which is most of them — the majority of actions recorded `skipped-busy` and nothing else, quietly defeating the "one action, one screenshot" rule the whole feature is built on.

It is bounded rather than unlimited for one specific reason, and it is not host CPU: on `ui-server` a screenshot travels the **same** on-device RPC channel as the script's own `find` and `click`, and uiautomator serves that channel one call at a time. Captures allowed to pile up there put the script behind its own debugging. So the shape is: enough concurrency that a normal script gets a frame per action, a ceiling so a pathological one cannot bury the channel, and a **drop, never a queue**, at that ceiling — the owner's "fail-drop". The number 4 is unmeasured (§9b item 1) and is the first thing to revisit once §7's smoke test has run on hardware.

**A saturated ceiling drops the frame and never the tree.** A `dump`/`find`/`waitFor` has already returned its tree — *"pas snapshot ui nodes itu kan udah sekalian ngambil data ui, nah itu kan bisa sekalian datanya dari situ"* — so storing it costs the device nothing at all. The original single-slot code returned early on a busy slot and threw that free tree away because a *screenshot* slot was occupied, which is the one thing this design must not do. The saturated path now stores the tree and marks the event `meta.frameDropped: 'busy'`.

### 3.5 Storage: one directory per job, one lifetime

```
<dataDir>/traces/<jobId>/<sha256>.png     # frames — filename IS the content hash
<dataDir>/traces/<jobId>/<sha256>.json.gz # UI tree snapshots, gzipped
```

Two actions on an unchanged screen write one file and produce two events both naming that hash. The owner's model is preserved exactly — every action has its own screenshot — while the bytes are stored once.

Deleting a job is `rm -rf traces/<jobId>` plus one `DELETE FROM job_events WHERE job_id = ?`. There is no reference counting, no orphan sweep, and no query anywhere that has to be kept in step — which is precisely what §0.4 says went wrong with the alternative.

`sha256Hex`/`blobIdFor` are imported from `agent/blob/store.ts` and reused as pure functions. The `agent_blobs` **table** is not touched.

**The hash is untrusted input on the read path.** `GET /api/jobs/:id/trace/frames/:hash` takes `:hash` straight from a URL and this store turns it into a filesystem path — the classic traversal shape. Both `readFrame` and `readUiTree` validate against `/^[0-9a-f]{64}$/` and refuse anything else before a path is built at all, rather than sanitising after the fact. `:id` is equally untrusted and is resolved through the job row (a 404 for an unknown job) before the directory name is used.

### 3.6 Writes never touch the hot path

`packages/core/src/events/recorder.ts` already solved this for `device_events` and its module doc states the rule: *"`record()` never awaits the database"* — buffer in memory, flush one transaction per 250 ms or when the buffer fills, publish to WS synchronously before the row is written. The trace recorder is the same shape, with the same defaults, and a `flush()` forced on job settle so a finished job's timeline is complete the instant its status changes.

### 3.7 Retention still has to exist

The owner's lifetime rule — a trace lives as long as its job's history — is the *correctness* rule. It is not a *bound*: nothing deletes finished jobs today except the device-removal cascade, so without a second lever a farm accumulates traces forever.

`retention.traceDays` (default 30) sweeps `job_events` and trace directories by age. Like `eventMainDays`/`commandRunDays` and unlike the artifact policy, it is **not** gated by `retention.enabled` — settings.ts already states the distinction and it applies unchanged here: an unbounded append-only per-action table is a disk-filling bug, not an opt-in convenience.

**A trace is swept whole, per job — never per row** (raised by step 128.7's worker; this plan's step 128.7 said "rows older than `traceDays` **and** the corresponding directories", which is wrong if read literally). A job's events can span an arbitrary stretch of time: a long-running job, or — by §3.3's own design — a job rebound weeks later, whose attempt 2 continues attempt 1's sequence in the same stream. Deleting rows by row age would strand the surviving recent rows pointing at frames in the directory the same sweep just removed: a torn timeline with 404ing thumbnails, which is worse than keeping the whole thing a few hours longer. The sweep therefore groups by `job_id`, takes `MAX(at_ms)` as the trace's age, and deletes rows and directory together or neither.

### 3.8 What must keep working

- `ScriptContext` gains nothing. `packages/sdk/src/types.ts` is not edited by this plan at all.
- `DeviceCallSchema` is not edited. The tracer consumes it; it does not extend it.
- A job whose session has no inspector, or whose device drops mid-run, produces a trace with an empty frame lane and a complete event lane.
- `GET /api/jobs/:id/logs` and the `job.log` WS message keep their exact shapes. The trace *tees* the logger; it does not replace it.

---

## 4. Technical design

### 4.1 `job_events` (new table, `packages/core/src/db/schema.ts`)

```ts
export const jobEvents = sqliteTable(
  'job_events',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    /** Per-job monotonic. The sort key and the keyset cursor — never the clock (§3.3). */
    seq: integer('seq').notNull(),
    /** Unix MILLISECONDS, deliberately not `{ mode: 'timestamp' }` — see §3.3. */
    atMs: integer('at_ms').notNull(),
    /** 1-based attempt this event belongs to; a rebound job has more than one. */
    attempt: integer('attempt').notNull().default(1),
    /** 'reset' | 'prepare' | 'run' | 'finish', or null for an event outside a phase. */
    phase: text('phase'),
    /** Plan 99's workflow node axis, mirroring `artifacts.nodeId`. Null for every non-workflow job. */
    nodeId: text('node_id'),
    /** 'phase' | 'action' | 'log' | 'artifact' | 'progress' | 'assist' | 'error' */
    kind: text('kind').notNull(),
    /** For kind 'action': the DeviceCall method. For 'log': the level. For 'phase': 'start' | 'end'. */
    name: text('name').notNull(),
    /** Milliseconds the action took. Null for instantaneous events. */
    durationMs: integer('duration_ms'),
    /** 1 = succeeded, 0 = failed, null = not applicable. */
    ok: integer('ok', { mode: 'boolean' }),
    errorCode: text('error_code'),
    /** Kind-specific detail; always an object. Args are redacted per §4.4. */
    meta: text('meta', { mode: 'json' }),
    /** SHA-256 hex of the frame in `traces/<jobId>/`, or null. */
    frameHash: text('frame_hash'),
    /** 'ok' | 'skipped-policy' | 'skipped-busy' | 'failed' — never null when the policy wanted a frame. */
    frameStatus: text('frame_status'),
    /** SHA-256 hex of the gzipped UI tree, or null. */
    uiHash: text('ui_hash'),
  },
  (t) => [
    uniqueIndex('idx_job_events_seq').on(t.jobId, t.seq),
    index('idx_job_events_at').on(t.atMs),
  ],
)
```

### 4.2 Protocol (`packages/protocol/src/messages/job.ts`, `packages/protocol/src/api/jobs.ts`)

```ts
export const JobTraceEventSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  seq: z.number().int(),
  atMs: z.number().int(),
  attempt: z.number().int(),
  phase: z.enum(['reset', 'prepare', 'run', 'finish']).nullable(),
  nodeId: z.string().nullable(),
  kind: z.enum(['phase', 'action', 'log', 'artifact', 'progress', 'assist', 'error']),
  name: z.string(),
  durationMs: z.number().int().nullable(),
  ok: z.boolean().nullable(),
  errorCode: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  frameHash: z.string().nullable(),
  frameStatus: z.enum(['ok', 'skipped-policy', 'skipped-busy', 'failed']).nullable(),
  uiHash: z.string().nullable(),
})

/** Live tail, mirroring `job.log`'s shape and placement. */
export const JobTraceMessage = z.object({
  type: z.literal('job.trace'),
  payload: z.object({ jobId: z.string(), event: JobTraceEventSchema }),
})
```

`JobTraceMessage` joins the `/ws` discriminated union beside `JobLogMessage`. The `/ws` contract is unchanged: no snapshot replay, so the Timeline tab fetches then subscribes, exactly as the Logs tab already does.

### 4.3 Endpoints (`packages/core/src/api/jobs.ts`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/jobs/:id/trace` | Keyset on `seq`, following `api/pagination.ts`. Query: `after`, `limit`, `kind` (repeatable filter). `requirePermission('job.view')`, matching `/:id/nodes`. **`seq` is the cursor, `atMs` is the axis** — see below. |

**`seq` order is arrival order, not event order** (found by step 128.4's worker). An `action` event is held until its capture settles, because the frame hash has to be on the row; a `log` line emits synchronously. So an action whose screenshot took 200 ms reaches the recorder *after* a log line that happened during it, and — since the recorder numbers on arrival — gets a higher `seq` despite an earlier `atMs`.

Buffering to fix this was considered and rejected: it would put log lines behind a stuck capture, which is a worse failure than a slightly late tick. `atMs` is stamped at `begin()` and is the true axis. Therefore: **`seq` is the pagination cursor** (unique, monotonic, stable across inserts — a correct cursor is exactly what it is good for), and **every consumer sorts by `(atMs, seq)` for display**. A Timeline that sorts by `seq` alone renders captured actions slightly after their own log lines. The skew is bounded by capture latency, so this is local reordering, never a scrambled trace.
| `GET` | `/api/jobs/:id/trace/frames/:hash` | `image/png`, `Cache-Control: private, immutable` — the URL is content-addressed, so it can never go stale. 404 when the file is gone (swept, or never captured). |
| `GET` | `/api/jobs/:id/trace/ui/:hash` | The UI tree, `application/json`, decompressed on the way out. |
| `DELETE` | `/api/jobs/:id` | `requirePermission('job.run')`. Refuses a job in `queued`/`running` with `job_not_settled` — cancel it first. Cascades per §4.5. |
| `POST` | `/api/jobs/history/clear` | Body `{ before?: number; deviceId?: string; status?: JobStatus[] }`. Same cascade, in one transaction per batch. **`requirePermission('job.history.purge')` — a NEW admin-only permission, not `job.run`.** |

**The two destructive routes deliberately sit at different heights.** `DELETE /:id` keeps the per-job ownership gate `POST /:id/cancel` already uses: erasing one run cannot be a stricter check than stopping it, and the job is one an operator can already see and cancel. `POST /history/clear` selects by **filter**, not by a device the caller owns — on `job.run` it would have let any operator erase every run on every device in the farm, including runs owned by someone else and the trace frames that are the only record of what they did. It therefore gets `job.history.purge`, deliberately outside the `OPERATOR` set on the `kv.manage` precedent. A test asserts an operator is refused *and* that nothing was deleted on the way to being refused, so widening it later has to be a decision rather than a refactor.

### 4.4 Redaction

`meta.args` carries the action's arguments, which is the point — a `find` is useless without its selector. Two rules, both mirroring `device_events`' own input-stream redaction:

- `type` and `clipboard.set` store `{ length: n }`, never the text. A script types passwords.
- Any arg value over 512 bytes is truncated with an explicit `{ truncated: true }` marker.

### 4.5 The cascade

One function, `deleteJobsWithHistory(db, dataDir, jobIds)` in `packages/core/src/jobs/purge.ts`, used by all three callers so the cascade cannot drift:

1. `DELETE FROM job_events WHERE job_id IN (...)`
2. `rm -rf <dataDir>/traces/<jobId>` for each
3. Unlink each artifact file, then `DELETE FROM artifacts WHERE job_id IN (...)`
4. `DELETE FROM job_nodes WHERE job_id IN (...)`
5. `DELETE FROM jobs WHERE id IN (...)`

Callers: `DELETE /api/jobs/:id`, `POST /api/jobs/history/clear`, and `device/lifecycle.ts`'s existing `deleteHistory` block (schema.ts:279-291), which today does steps 3 and 5 inline and must be replaced by a call to this function.

### 4.6 Studio — the Timeline tab

`packages/studio/src/app/jobs/detail/page.tsx` gains one `EntityTabs` entry (`{ key: 'trace', label: 'Timeline' }`) and one render branch. Everything else lives in new components under `packages/studio/src/components/jobs/trace/`:

- `TraceTimeline.tsx` — the ruler and the lanes. Phase lane (four coloured bands), action lane (one tick per action, red when `ok === false`), log-density lane, film-strip lane (thumbnails at their true time positions). Horizontal scroll in its own `overflow-x-auto` container.
- `TraceScrubber.tsx` — a draggable playhead. Keyboard: `←`/`→` step one event, `Home`/`End` jump to the ends.
- `TraceFrame.tsx` — the frame at the playhead, with the previous frame available as a before/after toggle.
- `TraceEventDetail.tsx` — the selected event: method, redacted args, duration, outcome, error code, and the UI tree rendered by reusing `components/InspectorPanel.tsx`.
- `useJobTrace.ts` in `packages/studio/src/lib/` — fetch-then-subscribe, mirroring `use-job-detail.ts`.

A failed job opens the Timeline tab with the playhead already on the failing event.

---

## 5. Implementation steps

### 128.1 — Protocol and settings

- `packages/protocol/src/messages/job.ts`: add `JobTraceEventSchema`, `JobTraceMessage`; register the message in the `/ws` union.
- `packages/protocol/src/api/jobs.ts`: add `JobTraceResponseSchema` (keyset page), `JobDeleteResponseSchema`, `JobHistoryClearRequestSchema`/`ResponseSchema`.
- `packages/protocol/src/settings.ts`: add `retention.traceDays` (int, min 1, default 30), **not** gated by `enabled`; copy the reasoning comment pattern from `commandRunDays`.
- Tests: schema round-trips; the default appears when `retention` is absent; a legacy settings row without `traceDays` still parses.
- **Result:** `bun test packages/protocol/src/` green; nothing else in the repo has changed yet.

### 128.2 — Table and migration

- `packages/core/src/db/schema.ts`: add `jobEvents` per §4.1, with the `at_ms` comment explaining the seconds carve-out and pointing at this plan §3.3.
- `bun run --cwd packages/core db:generate`, commit the generated migration.
- **Result:** a fresh `.dev-data` boots with the table; an existing one migrates.

### 128.3 — The tee (pure)

- New `packages/session/src/runner/trace.ts`: `createTraceTee(...)` per §3.1 — `begin`/`end`, seq assignment, redaction (§4.4), capture-policy resolution from an injected `engineId` accessor, single-slot capture gating.
- No I/O in this module: it takes an `emit(event)` callback and a `capture()` thunk, both injected.
- Tests (`trace.test.ts`): seq monotonicity; duration measured; error outcome carries code and message; `type`/`clipboard.set` args redacted; oversized args truncated; a second `begin` while a capture is in flight yields `skipped-busy`; `uiautomator-dump` yields `skipped-policy` for a successful action and `ok` for a failing one; a `capture()` that rejects yields `failed` and never throws out of `end`.
- **Result:** `bun test packages/session/src/runner/trace.test.ts` green.

### 128.4 — Wiring the tee into the runner

- `packages/session/src/runner/job-runner.ts`: build the tee per attempt; read `session.inspectorEngineId`; add `tee.begin(call.data)` before `execDevice`, `tee.end(...)` in both `.then` and `.catch` (lines 902-934); emit `phase` events at `msg.t === 'phase'`; tee `logger.append` into `log` events; emit an `artifact` event beside `deps.onArtifact`; emit `assist` and `progress` events at their existing call sites.
- Add `onTraceEvent?: (jobId: string, event: JobTraceEvent) => void` to `JobRunnerDeps`, optional exactly like `transfer`/`timing` — a host that does not wire it loses tracing and nothing else.
- The capture thunk calls `session.inspector?.screenshot()`; the UI-tree snapshot reuses the tree the call already returned for `dump`/`find`/`waitFor`.
- Tests: extend `job-runner.test.ts` — a traced run emits action events in order with durations; a run whose `onTraceEvent` is undefined behaves identically to today; a capture that rejects does not fail the job; the script-visible `device.result` payloads are byte-identical with and without the tee.
- **Result:** `bun test packages/session/src/runner/` green.

### 128.5 — The recorder and the frame store (core)

- New `packages/core/src/jobs/trace/recorder.ts`: buffer-and-flush per §3.6, modelled on `events/recorder.ts` — `record()` never awaits the DB, `publish` fires first, `flush()` forced on job settle, `stop()` on shutdown.
- New `packages/core/src/jobs/trace/frame-store.ts`: `putFrame(jobId, bytes)` → hash, write `traces/<jobId>/<hash>.png` if absent, return the hash. `putUiTree(jobId, node)` → gzip, same shape. `readFrame`/`readUiTree`. `removeJob(jobId)`.
- `packages/core/src/daemon.ts`: construct both; pass `onTraceEvent` into the local runner deps beside the existing `hooks`; broadcast `job.trace`; call `flush(jobId)` where `jobLogBuffer.release(jobId)` is already called (line 1318).
- Tests: recorder buffers and flushes in one transaction; publish precedes the write; frame store dedupes identical bytes to one file and two hashes match; `removeJob` deletes the directory.
- **Result:** `bun test packages/core/src/jobs/trace/` green.

### 128.6 — Endpoints

- `packages/core/src/api/jobs.ts`: the five routes in §4.3, keyset via `api/pagination.ts`, permissions matching the neighbouring routes.
- New `packages/core/src/jobs/purge.ts` with `deleteJobsWithHistory` per §4.5; **replace** the inline deletes in `device/lifecycle.ts`'s `deleteHistory` block with a call to it.
- Tests: keyset paging is stable across an insert; `kind` filter; a frame 404s when absent; `DELETE` refuses a running job; a deleted job leaves no `job_events` rows and no trace directory; the device-removal cascade still deletes what it deleted before, plus the new rows.
- **Result:** `bun test packages/core/src/api/jobs.test.ts packages/core/src/jobs/purge.test.ts` green.

### 128.7 — Retention

- `packages/core/src/maintenance/retention.ts`: `sweepTraces()` beside `sweepEvents`/`sweepCommandRuns` — delete `job_events` older than `retention.traceDays` and remove the matching trace directories; not gated by `enabled`; include the count in the sweep result and the log line.
- Tests: a trace past the window is swept, one inside it is not; `enabled: false` does not stop it.
- **Result:** `bun test packages/core/src/maintenance/` green.

### 128.8 — Studio: the Timeline tab

- The components and hook in §4.6; the `EntityTabs` entry and render branch in `jobs/detail/page.tsx`.
- `Delete job` in the job detail header (with an `AlertDialog` confirm, matching `Cancel job`'s existing pattern) and `Clear history` on `jobs/page.tsx`.
- Tailwind v4 colour classes only (`bg-surface`, `text-fg-muted` — never the v3 bracket form); wide lanes scroll inside their own container; internal links use `next/link`.
- Tests: the tab renders from a fixture trace; the scrubber selects the nearest event; a failed job opens on the failing event; the policy line reads correctly for both engines; a job with an empty action lane shows the explanation, not a blank box.
- **Result:** `bun test packages/studio/src/components/jobs/trace/ packages/studio/src/app/jobs/` green (scoped — never the full Studio suite).

### 128.9 — Docs

- `docs/spec.md`: `job_events` in §12, the five endpoints in the API section, `job.trace` in the WS section, the Timeline tab in §19, `retention.traceDays` in §18. Required by DoD item 8.
- `packages/core/README.md` and `packages/session/README.md`: a paragraph each on the tee and the capture policy.
- Update this plan's `> Status:` line and confirm `bash scripts/check-plan-status.sh` passes.

---

## 6. Acceptance criteria

1. A script running on a `ui-server` session produces one `action` event per device call, each with a duration and a frame, with no sampling and no cap.
2. The same script on a `uiautomator-dump` session produces the same `action` events with `frameStatus: 'skipped-policy'`, and its measured wall-clock runtime is within noise of the same script run with tracing disabled.
3. A failing action carries: its own frame, the frame before it, its UI tree, its error code, and its arguments.
4. `ScriptContext` is unchanged — `packages/sdk/src/types.ts` has no diff in this plan — and a bundle published before it runs with identical observable behaviour.
5. A capture that throws, times out, or is skipped is visible as `frameStatus` on its event; no event is silently missing a frame.
6. Two actions on an unchanged screen produce two events and exactly one file in `traces/<jobId>/`.
7. The Timeline tab renders for a running job (fetch-then-subscribe) and for a finished one, and opens a failed job on its failing event.
8. `DELETE /api/jobs/:id` leaves no `job_events` row, no artifact row, no artifact file, and no `traces/<jobId>` directory. Device removal with `deleteHistory` does the same for every job of that device.
9. `retention.traceDays` sweeps old traces with `retention.enabled: false`.
10. `bun run typecheck` passes; every test file touched by these steps passes.
11. `docs/spec.md` is updated in the same commit (DoD 8); `bash scripts/check-plan-status.sh` passes (DoD 6).
12. No process is left running (DoD 7): `ps -Ao pid=,command= | grep -i "[o]penpf"` is clean.

## 7. Test plan

Unit tests are named per step above. The manual smoke test, on a real device:

```bash
bun run dev                       # core on :7700, data in .dev-data/
bun run dev:studio                # Studio on :3001
# publish and run examples/ against one attached device, then:
curl -s localhost:7700/api/jobs/<id>/trace | jq '.items | length'
ls .dev-data/traces/<id>/ | wc -l   # fewer files than events — dedupe is working
```

Then, in Studio: open the job, the Timeline tab, drag the scrubber, click an action, confirm the frame and UI tree match the action's moment. Delete the job; confirm `.dev-data/traces/<id>/` is gone.

A second run with the ui-server killed (forcing the `uiautomator-dump` fallback) confirms criterion 2 — compare `finishedAt - startedAt` against a pre-plan baseline for the same script.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Per-action capture slows scripts even on `ui-server`, because the on-device uiautomator service serialises a screenshot RPC against a concurrent `objInfo`. | Single in-flight slot with `skipped-busy` (§3.4) bounds it to one outstanding capture. Criterion 2's timing comparison is run on `ui-server` too, not only on the fallback. If it regresses, the fallback rule extends to both engines and the owner is told plainly. |
| R2 | Disk growth. Per-action frames with no cap is the owner's explicit decision, taken after the 10–40 GB/day estimate for a 200-device farm was put to them. | Content-hash dedupe cuts the common case hard (a script tapping through a static screen). `retention.traceDays` bounds the tail and is on by default. The Settings page shows current trace usage so it is observable rather than discovered when the disk fills. |
| R3 | The tee alters behaviour it was supposed to observe. | `begin`/`end` are synchronous and return `void`/a token; every async consequence is `.catch()`-ed at its origin. Criterion 4 is a byte-identical `device.result` assertion, not a code review. |
| R4 | `at_ms` in milliseconds drifts against §4.2's seconds convention and someone "fixes" it. | The column comment states the exception and points at §3.3; a test asserts a sub-second ordering that seconds could not represent. |
| R5 | The cascade drifts as callers are added. | One `deleteJobsWithHistory` used by all three call sites (§4.5), and `device/lifecycle.ts`'s inline deletes are *replaced*, not duplicated. |
| R6 | Redaction misses a secret-bearing arg. | `type` and `clipboard.set` are redacted by construction; a test enumerates `DEVICE_CALL_ARGS` keys and fails when a new method is added without a redaction decision. |

## 9. Open questions

1. **Remote (node-owned) jobs.** §2 defers their action lane. Should the `device.call` tee move into `@enkaku/node`'s runner in a follow-up, or should the node ship trace events over the tunnel to the control plane?
2. **Trace on a workflow job.** `nodeId` is carried on every event, but the Timeline tab renders one flat axis. Does a workflow want a lane per node?
3. **`retention.traceDays` default of 30.** Matches `maxAgeDays`; unverified against a real farm's disk. Revisit once §8 R2's usage figure has been observed.

4. **`job.history.purge` was decided, not asked** — flagged here because it is an ACL change and the owner should see it. Step 128.6's worker correctly refused to improvise a permission and recorded the gap (§4.3 had specified none); the coordinator then chose admin-only rather than leaving a farm-wide erase on `job.run`, on the grounds that the restrictive default is reversible and the permissive one is not — once history is gone it is gone. If a single-operator farm finds this annoying, widening it is a one-line change to the `OPERATOR` set plus the guard test above. The related sub-question stands: `JobHistoryClearResponseSchema` reports `skipped` only for "queued or running", so a future per-device ownership filter would have nowhere honest to report "left alone because it wasn't yours" without a schema change.

## 9b. Left open at the end of execution — read before calling this done

1. **Two tests fail, and they are PRE-EXISTING — measured, not assumed.** `packages/core/src/jobs/memory-limit.integration.test.ts` (plan 98) fails both of its cases: `enforce: 'kill'` settles `success` instead of `failed`, and `enforce: 'warn'` reports a peak RSS of 120 MB against an expected 256 MB.

   Established by building a clean `git worktree` at HEAD (`14c9690`, no plan-128 code at all) with its own `bun install`, and running that one file there: **the same two tests fail identically, 0 pass / 2 fail.** So this plan did not cause them. Two earlier attempts at a baseline were rightly blocked and are recorded so the method is not repeated: symlinking `node_modules` into a worktree resolves `@enkaku/*` back to the *modified* main tree and proves nothing, and restoring `job-runner.ts` from HEAD in place was refused as destructive — correctly, since it would have destroyed 212 lines of uncommitted work.

   Consistent with that measurement: the test never passes `onTraceEvent`, and `job-runner.ts` builds `createNoopTraceTee()` in exactly that case, so the tee does not execute there at all. **This is still a real failure in the repo** — it belongs to plan 98, not to this plan, and it wants an owner.

   **Why it fails, measured on this machine (macOS 25.4, Bun 1.3.14).** The child reports `process.memoryUsage.rss()` (`child-entry.ts:643`), and that number is not wrong — it agrees with the OS to within 1 MB. What it does is **fall over time**. Holding 120 × 4 MiB retained and touched:

   | Loop delay per chunk | Total runtime | Reported RSS |
   |---|---|---|
   | 2 ms | ~0.25 s | **323 MB** (`ps` says 324 MB) |
   | 5 ms | ~0.6 s | 60–69 MB |
   | 50 ms — *the test's own setting* | ~6 s | **36–46 MB** |

   Same allocation, same retention, same process: only the elapsed time differs. macOS reclaims large allocations that are held but not recently touched, so the resident set collapses while the memory is still very much owned. The 50 ms delay the test uses to give its sampler room to fire is precisely what gives the OS room to reclaim.

   **The consequence is not confined to the test.** Plan 98's memory ceiling is enforced against RSS, so on macOS it under-measures any script that allocates and then waits — which describes most automation. A runaway script may never trip the limit there. Whether the answer is a different metric, a documented Linux-only enforcement guarantee, or accepting it, is plan 98's decision and is **not** taken here.

2. **`§4.6`'s "reuse `InspectorPanel.tsx`" was wrong** and step 128.8's worker correctly refused it. That component is a *live* panel: it attaches an inspector over `/ws`, needs a manual lease on a device that still exists, polls at 2 s, and proposes selectors against the running screen. A stored snapshot from a job that finished last week has none of those. `TraceEventDetail` parses the snapshot through `UiNodeSchema` and draws it read-only instead. Extracting a shared read-only tree renderer out of `InspectorPanel` is real, larger work and is not done.

3. **A timeline position cannot be deep-linked.** `?tab=trace` reaches the tab but not a moment in it, so a finding cannot be sent to someone else — which is half of what a shared timeline is for. An `&at=<seq>` param is the fix.

4. **No zoom.** The film-strip places thumbnails at their true time positions, but the lane's inner width is capped at 6000 px (14 px/event), so past roughly 430 events thumbnails overlap and stay overlapped. "Like a video editor" eventually means a zoom control; there is none.

5. **A failed job does not auto-open the Timeline tab.** The playhead starts on the failing event once you are on the tab; the default tab is still Summary. Auto-switching would fight `?tab=` (the URL owns the active tab) and break the back button. If the wider reading was intended, it is a one-line default change.

6. **`Clear history` cannot honour the jobs page's search box.** `JobHistoryClearRequestSchema` has `before`/`deviceId`/`status` and no text filter, so the dialog states plainly that it acts on every device regardless of what the search box shows — per `docs/design.md`'s "a filter must not lie about its scope".

## 10. Notes recorded during execution

**Seven holes in this plan were found by the workers implementing it, not by its author.** Each is fixed in the section named, and recorded here so the fix is not mistaken for the original design. *(This sentence said "Four" while the list below grew to seven; corrected in step 128.9.)*

1. **§3.3's precedent was wrong.** The draft cited `licensing`'s expiry column at schema.ts:1717 as the precedent for departing from `{ mode: 'timestamp' }`. The column there is `agent_approvals.expiresAt` (schema.ts:1787), and it is a *seconds* carve-out, not a milliseconds one. No column in this schema has ever held milliseconds; `job_events.at_ms` is the first, and its comment now carries the whole justification instead of leaning on a neighbour that does not support it. — step 128.2's worker.

2. **§3.4's policy line had no data source for a job with zero actions.** A job that fails in `prepare` has no `action` events, so the resolved capture policy could not be derived from `frameStatus` — exactly the case where an empty timeline most needs explaining. Every `phase` `start` event now carries `meta: { inspectorEngineId, framePolicy }`, per phase rather than per job, because the `ui-server` watchdog can force a mid-run fallback. — step 128.1's worker.

3. **`seq` had two authorities (§3.3).** The severe one: a rebound job would have violated the unique index on every event of its second attempt. Resolved in favour of the recorder; the tee emits `TraceRecordInput` without `id`/`seq`. — step 128.5's worker, before either side shipped.

4. **§3.5's traversal guard was half a guard.** The draft (and step 128.5's brief) required validating `:hash`, having noticed it reaches a filesystem path from a URL — and missed that `:id` does exactly the same thing one path segment earlier. Both are now validated before any path is built.

5. **Nothing carried the frame BYTES out of `@enkaku/session`.** The most expensive of the four, because it fails silently: `putFrame`/`putUiTree` live in `packages/core`, and step 128.4's brief added only `onTraceEvent` to `JobRunnerDeps` — so `session.inspector.screenshot()`'s bytes had no route to become the `frameHash` the schema requires. Nothing would have thrown; the frame lane would simply have been empty on every job while events flowed correctly. A second optional dep, `traceStore?: { putFrame, putUiTree }`, closes it, and `daemon-wiring.test.ts` now asserts **both** deps are passed, because passing one without the other is exactly the shape of this bug. — step 128.4's worker.

6. **§2 claimed remote jobs already got phase/log/artifact events "through the existing `hooks` path".** They did not: `createRemoteJobBridge`'s hooks only broadcast over `/ws` and wrote no rows, so a cloud job's Timeline would have been wholly blank rather than "action lane empty, everything else present". Three `record(...)` calls at those hooks make the claim true. — step 128.5b's worker.

7. **Step 128.7's sweep, read literally, would tear traces.** "Delete rows older than `traceDays` and the corresponding directories" strands a straddling job's surviving rows in front of a directory the same sweep deleted. Now grouped by job, aged on `MAX(at_ms)`, all-or-nothing — see §3.7. — step 128.7's worker, who also mutation-tested the millisecond cutoff by breaking it two ways and confirming the guard test caught both.

9. **The Timeline could render a silent prefix.** `fetchAllPages` stops after 25 pages and returns what it has — harmless for a device list of tens, not harmless for a feature whose whole design is one event per device call with no cap: a long run would have rendered its first 5,000 events and stopped, looking exactly like a job that ended there. That is goal 6 ("never omits silently") broken at the UI layer rather than the capture layer. `fetchPagesDetailed` now reports `truncated`, and the tab says the timeline is incomplete and that this is not where the job stopped. `fetchAllPages` itself is untouched, so no other caller changes. — raised by step 128.8's worker, fixed by the coordinator.

A tenth item, not a hole but a deliberate strengthening: `readUiTree` raises `E_TRACE_CORRUPT` for a truncated or unparseable snapshot rather than returning `null`. `null` means "gone", and a corrupt snapshot reported as gone would send a debugger hunting a retention sweep that never ran.
