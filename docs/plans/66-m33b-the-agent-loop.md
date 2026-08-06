# Plan 66 — M33b : The Agent Loop — Threads, Runs, and Streaming

> Status: implemented — threads/runs/append-only messages (`packages/core/src/agent/thread/store.ts`, migration `0028_gray_hydra.sql`, unique `(threadId, seq)`), approvals with a shared-reaper sweep (`agent/approval/store.ts`, `queue/expiry.ts`'s new `sweepApprovals` hook), and the loop itself (`agent/loop/{sanitize,detect-loop,errors,compaction,request,run,context}.ts`) — `run.ts`'s `executeRun` implements §3.2 exactly: budgets checked before every new step (never mid-step), `sanitizeMessages` applied on every request, three-consecutive-identical-calls loop detection, `invoke()` as the only door via `loop/context.ts`'s `createAgentCapabilityContext` (wires Plan 65's `effectivePermissions`/`agentCanReachDevice` into a live `CapabilityContext`, the deviation-7 wiring that plan asked for), a control lease acquired lazily per device and released on EVERY terminal path including pause (not just cancel). `agent/runner.ts` orchestrates concurrency (`maxConcurrentRuns` queues, never rejects), cancellation (an in-memory flag per run, since a "running" row's meaning IS "this process is executing it"), restart recovery (`recoverAfterRestart`: `running`→`failed`/`interrupted`, `paused` untouched), and approval-expiry resumption. Protocol messages in `packages/protocol/src/messages/agent.ts` (fetch-then-subscribe, no snapshot replay); `packages/core/server/ws-handlers-agent.ts` is the per-thread fan-out (wired into `ws-handlers.ts`'s existing switch as three new optional-dep cases) plus `packages/core/src/api/threads.ts` (`POST /api/v1/threads`, `GET/POST .../messages`, `GET /api/v1/runs/:id`, `POST .../cancel`, `POST /api/v1/approvals/:id`), both mounted in `daemon.ts`/`server/http.ts`. A minimal Studio thread view ships at `packages/studio/src/app/agents/thread/page.tsx` (streamed text, tool calls with input before they run, an approval card showing the exact input, cancel button, client-side seq-gap detection triggering a re-fetch) with a "Chat" link from `/agents`. `bun run typecheck` and `bun run build:studio` are both green; `bun test` is 1883 pass / 0 fail (baseline 1787 + 96 new, all in this plan's own eleven new test files; one pre-existing test in `auth/acl.test.ts` was edited because its own "invented permission" example happened to collide with the new `agent.run` permission name, not because its behaviour changed); a full `bun run dev` boot was smoke-tested end to end over real HTTP (create agent → create thread → post message → graceful `E_NO_CONNECTOR` failure, no crash) and via `bun run build:studio`'s static export (`/agents/thread` at 6.39 kB). No real Anthropic API call is made anywhere in the test suite — every provider-facing test uses `agent/provider/fake.ts`'s scripted `ProviderAdapter`, injected into `runner.ts` via a `createProvider` override seam. **Deviations, recorded rather than silent:** (1) the plan's Agent record (Plan 65) has no field for "capabilities that require approval beyond `effect: 'destructive'`", which §3.6 explicitly needs ("the agent's `requiresApproval` list") — added `requiresApproval: string[]` to `AgentSchema`/`ai_agents` (migration `0029_public_pestilence.sql`), validated against the registry exactly like `tools`. (2) `agent_approvals` gained a `toolCallId` column beyond §4.1's illustrative list (migration `0030_wealthy_tag.sql`) — without it, a step with TWO gated calls has no way to say which stored decision belongs to which call; resolution is now exact (`approvals.findByToolCallId`) rather than "assume the most recent approval," which breaks under more than one gated call per step. (3) Anthropic tool names must match `^[a-zA-Z0-9_-]{1,128}$` — dots (`device.tap`) are not legal — so `loop/request.ts`'s `buildToolDefs` sanitises `.`→`_` for the wire name and keeps a `capabilityIdForToolName` map to resolve a `tool_call` back to the real capability id before it ever reaches `invoke()`; this was not called out in the plan or in Plan 65's provider work. (4) `ProviderEvent`'s `error` variant gained an optional `raw?: unknown` field (Plan 65's `provider/types.ts`) so §3.8's `cause`-chain classification has something to walk — `loop/errors.ts` duck-types `.status`/`.type` (the shape of `@anthropic-ai/sdk`'s `APIError`) without importing the SDK, honouring "the loop never imports a provider SDK's types." (5) A paused run releases any control lease it acquired, not only a cancelled one (§3.7 step 4's reasoning applied one step further than the plan states it): nothing about sitting idle for a possibly-long approval wait justifies holding a device away from a human operator; `ensureControlLease` re-acquires on resume as needed. (6) `agent.run` is a new ACL permission (`auth/acl.ts`), parallel to `job.run`/`device.control` — operating an agent (chat, cancel, decide) is gated separately from `agent.manage` (editing the record), which the plan's §4.4 implies but never names. (7) Multiple `tool_result` blocks answering one assistant turn are appended as separate `role: 'tool'` messages (one per completed call) rather than batched into one — this is what makes pause-mid-step/resume-from-approval derivable purely from the append-only log (`extractPendingToolCalls`) with no separate resume state; not yet verified against a real multi-tool-call Anthropic turn (no API key in this environment). (8) No `ENKAKU_TEST_DEVICE`-gated smoke test was written: grepping the whole repo found zero prior examples of this convention actually implemented (only mentioned in docs), and building one from nothing without hardware to validate against risked shipping an untested, wrong-shaped harness — left undone rather than faked.
> Ships: packages/core/src/agent/thread/store.ts
> **Superseded (plan 76):** `packages/core/src/agent/loop/` — the hand-rolled provider-streaming loop this plan built — was deleted and replaced by the harness's `runAgentLoop` (`packages/core/src/agent/harness/`). Every criterion below still holds against the new loop (plan 76's own report verifies each one); only the "drive the model" internals moved.
> Depends on: Plan 63 (capabilities — the loop calls `invoke` and nothing else), Plan 65 (agent records, providers, budgets).
> Spec references: §10.1 (server-authoritative), §10.2 (leases), §11.3 (crash containment, not a sandbox).

---

## 1. Goals

- An agent **runs**: it receives a message, calls tools, and produces a result, bounded by every budget Plan 65 declared.
- A person watches it happen **live in Studio**, over the existing `/ws`.
- A run's messages are **persisted append-only**, so a run is legible after a restart, a reload, or a week later.
- **Cancelling actually stops it**, releases what it held, and says so.
- Capabilities marked `destructive` — and any others the agent's owner names — **pause for approval** rather than proceeding.

## 2. Non-goals

- Spawning sub-agents and inter-agent messages (Plan 67).
- Schedules and triggers (Plan 68).
- The Studio chat UI beyond what is needed to verify a run (Plan 68's workbench does the real interface).
- Any new device capability. The loop calls Plan 63's registry; it adds nothing to it.

## 3. Context and design decisions

### 3.1 Thread, run, message

| | Is | Lives |
|---|---|---|
| **thread** | a conversation with one agent | until deleted |
| **run** | one execution: a message in, work, a result out | one thread has many, ordered |
| **message** | one turn — user, assistant, tool result, or system note | append-only, belongs to a run |

Three levels rather than two because all four of the user's headline features need the same object. A chat turn is a run. A scheduled firing is a run in a thread nobody typed into. A sub-agent's work is a run whose parent is another run. A notification is a message appended to a thread that is not currently executing. One primitive, four features — and one audit trail rather than four.

Messages are **append-only**. Nothing is ever rewritten in place, including by compaction (§3.5). The harness this design learned from rewrote its whole message log on every turn, so a crash mid-write could truncate the history of a run that had already happened.

### 3.2 The loop, in full

```
append the user message
loop:
  if steps exhausted / seconds exhausted / tokens exhausted → stop, named reason
  build request: system, tools, history          (stable prefix — plan 65 §3.4)
  stream from the provider, emitting deltas over /ws as they arrive
  append the assistant message
  if no tool calls → done
  for each tool call:
    not in the agent's allowlist        → tool_result: error, keep going
    needs approval                      → pause the run; resume on a decision
    otherwise                           → invoke() (plan 63 §3.4)
  append tool results
  if the last 3 steps repeat one call with identical arguments → stop, 'loop-detected'
```

`invoke` is the only way the loop reaches anything. It cannot call a driver, a service, or adb directly. Every permission, grant, lease, deadline, and audit entry is therefore enforced without the loop containing a single check of its own — which is the property that makes the loop small enough to be read in one sitting.

A refused tool call comes back as a `tool_result` with an error, and the loop continues. The model must be able to see that it lacks a tool and choose another route; throwing away the run because the model guessed wrong once is worse for both cost and outcome.

### 3.3 The loop runs in-process, and executes no user code

Scripts run in an isolated subprocess because they are code somebody wrote. The agent loop is not: it makes HTTP calls to a provider and calls capability handlers that are ours. The only externally-authored thing in it is a prompt, and a prompt is data.

So the loop runs in the core process — and the boundary that keeps that true is stated as a rule with teeth: **the agent loop never executes user-authored code in its own process.** A script an agent writes goes through Plan 64's publish and Plan 63's `job.run`, landing in the existing isolated runner. There is no `eval`, no dynamic import of workspace content, and no in-process script execution. If a future capability wants one, it is a subprocess.

### 3.4 Streaming over `/ws`, and no snapshot replay

Studio is a static export: there are no route handlers, so the SSE-over-BFF transport used elsewhere cannot exist here. Agent events go on the `/ws` connection Studio already holds.

`CLAUDE.md` states the rule that shapes the client: **`/ws` has no snapshot replay** — a client fetches state over HTTP, then subscribes. So attaching to a run is:

```
GET /api/v1/threads/:id/messages?after=<cursor>   → history
ws: { t: 'agent.subscribe', threadId }            → live from here
```

and never a subscribe that replays. Messages carry a monotonic `seq` within their thread so the client can detect a gap between the fetch and the subscription and re-fetch, rather than rendering a hole.

New message types in `@enkaku/protocol` — declared as Zod, never hand-built objects (`CLAUDE.md`):

| Type | Direction | Carries |
|---|---|---|
| `agent.subscribe` / `.unsubscribe` | → core | threadId |
| `agent.run.started` / `.finished` | → client | runId, status, reason, usage |
| `agent.delta` | → client | text or thinking delta, runId, seq |
| `agent.message` | → client | a complete appended message |
| `agent.tool.started` / `.finished` | → client | capability id, input, outcome, duration |
| `agent.approval.requested` / `.resolved` | ↔ | approvalId, capability, input, decision |
| `agent.run.cancel` | → core | runId |

`agent.tool.started` carries the input because a person watching an agent tap a phone needs to see *what* it is about to tap, at the moment it happens, not afterwards in a log.

### 3.5 Compaction, and the part everyone gets wrong

When estimated tokens exceed `contextWindow × compactAtRatio` (Plan 65 §3.7), the older half is summarised by one model call and replaced, in the request, by a summary message. The stored history is untouched — compaction is a **view** for the provider, not an edit of the record. Reloading a compacted run shows the whole thing.

The hard part is not summarising. It is that every path which drops messages can leave a `tool_use` without its `tool_result`, or a `tool_result` without its `tool_use`, and providers reject both. So `sanitizeMessages` runs on the request immediately before it is sent, on every turn, not only after compaction:

- a `tool_use` whose result is not in the window → drop the `tool_use`
- a `tool_result` whose call is not in the window → drop the `tool_result`
- an assistant message left with no content → drop it

This is the one piece of the bitorex harness worth porting nearly as-is; it is also the piece nobody writes correctly the first time, which is why it is a named, separately-tested step here.

Token estimation for the threshold uses the provider's `countTokens` on a cadence, cached, **not** `JSON.stringify(...).length / 4` — the harness this learns from computed that twice per iteration over the full history, which is both wrong and quadratic.

### 3.6 Approval, and what it is actually for

A run pauses before invoking a capability when either is true:

- the capability's `effect` is `destructive` (Plan 63 §3.2), or
- the agent's `requiresApproval` list names it.

Pausing writes a row and emits `agent.approval.requested`; a decision resumes the run. Because it is a row, an approval survives a core restart: the run resumes where it paused rather than being lost or, worse, silently re-running the steps before it.

An approval expires (default 1 hour) into a denial, with a `tool_result` saying so. A run parked forever holds a thread, possibly a lease, and an operator's attention.

This is the structural half of the prompt-injection defence. An agent reads screenshots, UI dumps, and logcat — content an app under test controls, and any of which can carry text addressed to the model. Enkaku's rule is that tool output is data, never instructions; the system prompt says so, but a prompt is a request, not a boundary. The boundary is that the operations which would make a successful injection *matter* — installing an APK, deleting a script, publishing — cannot happen without a human clicking. What an injected instruction can achieve is then bounded by the agent's grants and its allowlist, both of which are declared, both of which are visible.

Approval requests display the capability, the device, and the **exact input**, because the input is where an injection becomes visible: an operator seeing an install of a package nobody mentioned is the detection mechanism, and a dialog that says only "the agent wants to install an APK" defeats it.

### 3.7 Cancellation that is not a lie

`agent.run.cancel` must, in order:

1. stop consuming the provider stream and close it;
2. start **no** further capability invocations;
3. let the one in flight finish — it is bounded by its Plan 63 deadline, so this is a wait of known length, not an indefinite one;
4. release any lease the run acquired;
5. append a system message recording who cancelled and when;
6. emit `agent.run.finished` with `status: 'cancelled'`.

Step 3 is a deliberate choice against interrupting: killing a capability mid-flight leaves a physical device in an undefined state — half a gesture, a partial push. Bounded waiting is better than an unknown phone. Steps 4 and 5 are what the bitorex `abort()` omitted; there it leaked tokens, here it would leak a device lease and block the farm.

Cancellation is idempotent, and cancelling an already-finished run is a no-op with a truthful response rather than an error.

### 3.8 Errors, reported as what they are

Provider errors are wrapped several `cause` layers deep, so the useful message — a 401, a rate limit, an overloaded model — is not the one at the top. The loop walks the `cause` chain (up to six) to find the informative error and classifies it:

| Class | Behaviour |
|---|---|
| `auth` | stop; mark the connector `unauthenticated` (Plan 65 §4.5) |
| `rate-limit` | retry with backoff, honouring `retry-after`; counts against `maxRunSeconds`, not against `maxSteps` |
| `overloaded` | retry with backoff |
| `context-overflow` | compact and retry once; if it recurs, stop |
| `invalid-request` | stop; this is our bug and it must be loud |
| `capability` | not an error of the run — a `tool_result` (§3.2) |

Every one is recorded on the run with its class, so a run that failed at 3 a.m. is diagnosable at 9 without reading a log file.

## 4. Technical design

### 4.1 Storage

```ts
export const agentThreads = sqliteTable('agent_threads', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  title: text('title'),
  /** 'chat' | 'schedule' | 'spawn' — how it began (plan 67, 68). */
  origin: text('origin').notNull().default('chat'),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull(),
  /** queued|running|paused|succeeded|failed|cancelled */
  status: text('status').notNull().default('queued'),
  /** Why it ended: 'done'|'max-steps'|'max-seconds'|'max-tokens'|'loop-detected'|'cancelled'|'error' */
  stopReason: text('stop_reason'),
  errorClass: text('error_class'),
  error: text('error'),
  steps: integer('steps').notNull().default(0),
  /** { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } */
  usage: text('usage', { mode: 'json' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
})

export const agentMessages = sqliteTable('agent_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull(),
  runId: text('run_id'),
  /** Monotonic within the thread; the client's gap detector (§3.4). */
  seq: integer('seq').notNull(),
  role: text('role').notNull(),                    // user|assistant|tool|system
  /** Content blocks — text, thinking, tool_use, tool_result. Zod on read. */
  content: text('content', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [uniqueIndex('idx_agent_messages_seq').on(t.threadId, t.seq)])

export const agentApprovals = sqliteTable('agent_approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  capabilityId: text('capability_id').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  status: text('status').notNull().default('pending'),   // pending|approved|denied|expired
  decidedBy: text('decided_by'),
  decidedAt: integer('decided_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
```

The unique index on `(threadId, seq)` makes gap detection reliable and makes a double-append impossible rather than merely unlikely — the harness this learns from had a double-submit race with no such guard.

### 4.2 `packages/core/src/agent/loop/`

- `run.ts` — §3.2, and nothing else. It should be readable end to end.
- `request.ts` — assembles system, tools, history; places the cache breakpoint after the tools (Plan 65 §3.4); calls `sanitizeMessages` last, always.
- `sanitize.ts` — §3.5. Pure, heavily tested.
- `compaction.ts` — threshold, summarisation, the view/record split.
- `detect-loop.ts` — three identical consecutive calls. Deterministic, no model call.
- `errors.ts` — §3.8's `cause` walk and classification.

### 4.3 Approval — `packages/core/src/agent/approval/`

Create, resolve, expire. A sweeper expires overdue approvals on the same timer the job reaper uses rather than adding a second scheduler.

On core start, runs left `running` are marked `failed` with `stopReason: 'interrupted'`. Runs left `paused` **stay paused** and resume when decided — that is exactly the state approvals exist to survive.

### 4.4 API

`POST /api/v1/threads`, `GET /api/v1/threads/:id/messages?after=`, `POST /api/v1/threads/:id/messages` (starts a run), `GET /api/v1/runs/:id`, `POST /api/v1/runs/:id/cancel`, `POST /api/v1/approvals/:id` (`{decision}`).

`maxConcurrentRuns` (Plan 65 §3.7) is enforced at enqueue: exceeding it queues rather than rejects, and the queue is visible.

### 4.5 Studio

Enough to see a run: a thread view with streamed text, tool calls shown as they start and finish with their inputs, an approval prompt showing the exact input, and a cancel button. The polished workbench is Plan 68.

## 5. Implementation steps

**66.1 — Tables and migration** (§4.1).

**66.2 — `sanitizeMessages`** (§3.5) and `detectLoop`. Pure, tested first, before anything can call a provider.

**66.3 — Request assembly** (§4.2), with the cache breakpoint asserted by test.

**66.4 — The loop** (§3.2), budgets failing closed, refusals as tool results.

**66.5 — Protocol messages and `/ws` handlers** (§3.4), fetch-then-subscribe with `seq` gaps.

**66.6 — Approval** (§3.6), including restart survival.

**66.7 — Cancellation** (§3.7), all six steps in order.

**66.8 — Compaction** (§3.5) and error classification (§3.8).

**66.9 — Minimal Studio thread view** (§4.5).

## 6. Acceptance criteria

1. A run with one tool call executes it through `invoke`, appends the result, and finishes.
2. A tool not in the agent's allowlist returns an error `tool_result` and the run **continues**.
3. Each of `maxSteps`, `maxRunSeconds`, `maxOutputTokens` stops the run with its own `stopReason`. **No error path anywhere increases any budget.**
4. Three consecutive identical tool calls stop the run with `loop-detected`.
5. Streaming: `agent.delta` arrives while the model is still generating, and `agent.tool.started` carries the input before the call runs.
6. Attaching is fetch-then-subscribe; a `seq` gap is detectable by the client. No message type replays a snapshot.
7. Cancelling performs §3.7's six steps in order; no lease is left held; the response is truthful; cancelling twice is a no-op.
8. A `destructive` capability pauses the run and shows the exact input; approving resumes from that call; denying returns an error `tool_result` and continues.
9. A paused run survives a core restart and resumes on decision; a `running` run is marked `interrupted`, never silently resumed.
10. An approval left undecided expires into a denial with a truthful `tool_result`.
11. Compaction never edits stored messages; reloading a compacted run shows the full history.
12. `sanitizeMessages` removes orphaned `tool_use` and `tool_result` blocks in both directions and is applied on every request, not only after compaction.
13. Cache read tokens are non-zero on the second turn of a run with a tool list large enough to exceed the caching minimum.
14. Every error class in §3.8 is recorded on the run and distinguishable.
15. `(threadId, seq)` is unique; a double submit cannot produce two messages at one seq.
16. The agent loop executes no user-authored code in its own process: no `eval`, no dynamic import of workspace content.
17. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit — `sanitizeMessages`:** orphaned `tool_use`, orphaned `tool_result`, both, an assistant message emptied by the removal, a well-formed history left byte-identical.

**Unit — `detectLoop`:** three identical → stop; three with differing arguments → continue; interleaved calls → continue.

**Unit — request assembly:** ordering; the breakpoint after tools; `thinking: {type: 'adaptive'}` and never `budget_tokens`; a stable tool order across two builds with a shuffled registry map.

**Unit — errors:** a six-deep `cause` chain resolves to the informative error; every class maps to its behaviour; a rate-limit retry consumes seconds and not steps.

**Integration (fake provider):** a scripted provider driving one tool call; a refusal; each budget stop; loop detection; cancellation mid-stream asserting no lease is held afterwards; approve and deny; a restart with a paused run.

**Device-gated (`ENKAKU_TEST_DEVICE=1`):** an agent told to open an app and report what is on screen — a real run, real capabilities, real hardware, watched live in Studio.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. Agents → a thread → "take a screenshot of device X and describe it"
# 2. text streams; the tool call appears with its input before it runs
# 3. ask it to install an APK → approval prompt shows the exact path → deny → it continues and says so
# 4. start a long run, hit Cancel → stops; the device lease is released (check /api/devices)
# 5. restart the core mid-approval → the run is still paused; approve → it resumes
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| An agent is talked into a destructive action by text on a device screen. | The `destructive` gate (§3.6) needs a human; the dialog shows the exact input so an unexpected package name is visible; the agent's grants and allowlist bound the reachable surface; every invocation is audited (Plan 63 §3.4). |
| Cancellation appears to work but the device stays held. | §3.7 orders lease release explicitly and criterion 7 tests for a held lease afterwards rather than trusting the code path. |
| A budget fails open and a run does hundreds of steps on physical phones. | Criterion 3 states it as a property of *every* error path, and §3.7's design has no auditor, no extension, and no path from failure to more steps. |
| Compaction corrupts a run's history. | Compaction is a view (§3.5), the store is append-only, and criterion 11 checks the full history is still readable. |
| Prompt caching silently stops working and costs rise. | Usage is recorded per run including cache reads, and criterion 13 asserts a non-zero cache read rather than assuming the design worked. |
| The loop grows checks of its own and diverges from `invoke`. | §3.2 makes `invoke` the only entrance and the loop contains no permission logic to diverge with. |

## 9. Open questions

1. Should an approval be grantable as a standing rule ("always allow `device.install` for this agent on these devices")? Convenient, and it removes exactly the human check the gate exists for. If it lands, it should be scoped to a device set and expire.
2. Should compaction summarise with the agent's own model or a cheaper one? A cheaper one is the obvious economy and risks losing detail the expensive model needed.
3. Should a run be resumable after `interrupted`? The messages are all there. Nothing is lost by deferring it, and resuming a run whose tool calls half-executed needs an idempotency story first (Plan 63 §9.1).
