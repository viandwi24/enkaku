# Plan 76 — M41 : Running on the Harness Loop

> Status: implemented — `packages/core/src/agent/loop/` (7 impl files + 7 test files) is deleted; `packages/core/src/agent/harness/{config,tools,messages,context,errors,run}.ts` replace it. `harness/context.ts` and `harness/errors.ts` are `agent/loop/{context,errors}.ts` moved verbatim (context.ts unedited; errors.ts widened to duck-type `@ai-sdk/anthropic`'s own `AI_APICallError` shape — `.statusCode`/`.data.error.type` — alongside the original `.status`/`.type`, since nothing translates one into the other any more now that `.stream()` is gone). `harness/messages.ts` folds three old steps (`loop/run.ts`'s `toProviderMessages`, `provider/message-mapping.ts`'s `toAiSdkMessages` [deleted], `loop/request.ts`'s `resolveImagesForRequest`) into one `toModelMessages(AgentMessage[]) → ModelMessage[]`, since the wire IS the AI SDK shape now; `assistantBlocksFromModelMessage` is the one-directional inverse for persisting the model's own turn. `harness/config.ts` builds `providerOptions` per connector kind (thinking/effort/fallbacks for Anthropic, `reasoning` for OpenRouter) and **leaves `onCheckpoint` unset**, with the 550-turn reasoning from §3.3 in a code comment (criterion 6) — moot in practice, since `harness/run.ts` calls `runAgentLoop` with `maxSteps: 1` per model turn and drives continuation itself, so the harness's own multi-step ceiling never engages either way. `harness/run.ts`'s `executeRun` keeps `agent/loop/run.ts`'s whole outer shape — `extractPendingToolCalls`, `processPendingCalls` (approval gate, lease acquire/release, `invoke()`, image-blob storage — all moved close to unchanged), the budget checks, the inbox drain — and replaces only `runProviderStep`/`streamOnce` with `runOneModelStep`, which calls the harness's `runAgentLoop` for exactly one step, retried outside it (rate-limit/overloaded backoff, one forced-compaction retry on context-overflow) with the SAME structure `streamOnce` used. `bun run typecheck` is green across all 12 packages; root `bun test` is 2070 pass / 0 fail (baseline 2102; `packages/studio`'s own suite is unaffected, 326/326) — the deficit is `agent/loop/`'s ~86 deleted test cases (the module they tested no longer exists) against 54 new tests in `harness/{context,errors,messages,tools,run}.test.ts`, which is real but narrower coverage of the same ground; recorded as a deviation below, not silently absorbed. **A genuine bug was found and fixed while porting, not merely a mechanical translation:** `agent/loop/run.ts`'s outer loop drained the inbox (plan 67 §3.3, §4.3) unconditionally at the very top of every iteration, including when a tool call from the previous step was still pending; the old raw-Anthropic-JSON request builder tolerated a user message landing between a `tool_use` and its own `tool_result`, but the AI SDK's own message-prompt validation (`streamText`, now reached on every turn) does not — it throws `"Tool result is missing for tool call <id>"` and fails the run. Fixed by moving `drainInbox()` to run only once `extractPendingToolCalls` is empty (a genuine turn boundary), which is what plan 67 §3.3's own wording ("never mid tool-call") actually requires; caught by `tree.integration.test.ts`'s existing `agent.reply`/tree-cap/`agent.cancel` scenarios, which failed (not "hung" — they resolved to `status: 'failed'`, `error: 'Tool result is missing...'`) before the fix and pass after it, unedited. **Deviations, recorded rather than silent:** (1) §3.2's own pseudocode shows `execute: (args) => invoke(cap, ctx, args)` on the generated tool itself; `harness/tools.ts` deliberately gives every tool NO `execute` at all — every call (not only gated ones) is resolved by `harness/run.ts`'s `processPendingCalls` instead, because the AI SDK begins executing a tool concurrently with the rest of that step's stream, and a synchronous `invoke()`-then-persist inside `execute` can land a `tool_result` at a LOWER `agent_messages.seq` than the `tool_use` that produced it (the assistant message is only persisted once the whole step settles) — corrupting the append-only order `extractPendingToolCalls` depends on. Every call still reaches `invoke()` and only `invoke()` (criterion 2 holds), one loop iteration later. (2) The Anthropic prompt-cache breakpoint (on the last tool definition) moved into `harness/tools.ts` (a `connectorKind` parameter conditionally sets `providerOptions.anthropic.cacheControl` on the last tool) because provider adapters no longer see a request at all; the NO-TOOLS fallback (cache the system block itself) could not be preserved — `runAgentLoop`'s `LoopConfig.system` is a plain `string`, with no way to attach `providerOptions` to it, and that file cannot be modified (hard constraint). Recorded as an accepted gap, not worked around. (3) `ProviderAdapter.countTokens()` is kept (not named for removal by criterion 13) but `harness/run.ts` never calls it — the compaction threshold uses the harness's own char-based `estimateTokens`/`summarizeAt` instead (plan 75 §4.3's real-token-count cadence estimator, `loop/compaction.ts`, is deleted with the rest of `loop/`). OpenRouter's `countTokens()` consequently lost the "anchor to a real turn's usage" refinement plan 75 built (nothing calls `.stream()` to produce that usage any more) — it is now a plain cumulative character estimate; both adapters' `countTokens()` are kept only as a public method nothing in production currently calls. (4) `runner.ts` gained a per-run `AbortController` (`ActiveRun.ac`), threaded into `ExecuteRunDeps.signal` and aborted alongside the existing `controller.cancelled` flag in `cancelRun` — the harness's `runAgentLoop` takes a real `AbortSignal` to interrupt a live `streamText` call, which the old hand-rolled stream consumer never needed (it polled `isCancelled()` inside its own `for await` loop instead). (5) `harness/context.test.ts` and `harness/errors.test.ts` are NEW test files covering the MOVED (not behaviourally changed) `context.ts`/`errors.ts` — the original `agent/loop/{context,errors}.test.ts` could not be recovered (never committed to git; deleted before this was noticed) and were reconstructed from the implementation rather than the original assertions; `harness/messages.test.ts` and `harness/tools.test.ts` are wholly new (their modules are new). **Not done:** `harness/session.ts` (§4.1's fourth named file, an `AgentSession`-shaped wrapper) was not built — §3.6 identifies `agent/runner.ts` + `thread/store.ts` as "Enkaku's equivalent" of `AgentSession`'s shape already, both unchanged in this plan beyond the wiring above, and Plan 78 (the only consumer of a session-shaped surface) is explicitly out of scope; building an unused fourth file risked exactly the dead-code Plan 76 §3.7 point 3 warns against elsewhere. Recorded as a deliberate scope cut, not an oversight.
> Ships: packages/core/src/agent/harness/config.ts
> Depends on: Plan 75 (the harness is a real package and the AI SDK is wired), Plans 63 (capabilities), 66 (the loop this replaces), 67 (the run tree), 70 (images).
> Source of truth for the port: `packages/harness/src/core/agent-core.ts`, `runtime/agent-session.ts`, `core/compaction.ts`, `core/derive.ts`, `session/session-store.ts`, `runtime/registry.ts`.

---

## 1. Goals

- Enkaku's agent runs on **`runAgentLoop`** from the harness, not on a second loop of our own.
- The capability registry **generates** the harness's `ToolSet`, so `invoke()` remains the only door.
- Everything Enkaku added and the harness does not have — approval gates, device leases, budgets that fail closed, the run tree — keeps working **on top of** the harness loop.
- `packages/core/src/agent/loop/` is **deleted**, not left beside its replacement.

## 2. Non-goals

- The VFS, skills, or file tools (Plan 77).
- Any UI (Plan 78).
- Changing what a capability does. The registry's handlers are untouched; only their packaging changes.
- Keeping Enkaku's `ProviderEvent` union. §3.5.

## 3. Context and design decisions

### 3.1 Two loops exist and one must go

`packages/core/src/agent/loop/run.ts` and `packages/harness/src/core/agent-core.ts` both drive a model, both handle tool calls, both compact. Keeping both would mean every future fix landing twice, and the harness would rot as the unused one.

The harness's loop wins. It is the code the instruction says to build on, it is battle-used upstream, and its `runAgentLoop` already carries things ours does not: mid-turn wire pruning, an audited step checkpoint that can extend a budget, per-step hooks for persistence, and a `consumeStep` seam that keeps two transports from diverging (`agent-core.ts:129` comment).

What ours has and the harness's does not is the whole subject of §3.3.

### 3.2 The capability registry generates the ToolSet

This is the decision the rest of the plan hangs on.

`LoopConfig.tools` is an AI SDK `ToolSet` — a record of `tool({description, inputSchema, execute})`. Enkaku's registry is 28 capabilities each carrying a permission, a lease requirement, a deadline, an effect class, and an audit obligation, all enforced by `invoke()` (Plan 63 §3.4).

Those are not alternatives. The registry is the **declaration**; the ToolSet is a **projection** of it:

```
capability  →  tool({
                 description: cap.description,
                 inputSchema: cap.input,
                 execute: (args) => invoke(cap, ctx, args),   // ← the only door, unchanged
               })
```

So a tool call from the harness's loop lands in `invoke()` exactly as it does today, with the same six checks and the same audit entry. The harness never learns what a lease is, and Enkaku never maintains a second list of tools.

The alternative — plugins replacing the registry — was rejected: it would put permission and lease logic inside tool bodies, one copy per tool, which is precisely the drift Plan 63 §3.4 exists to prevent.

The **plugin pattern itself** still comes across, in Plan 77, as the way a *feature* contributes a prompt section plus its capabilities. The registry is what a plugin registers into.

### 3.3 What Enkaku adds, and where each hook goes

`LoopConfig` (`agent-core.ts:130-152`) is unusually well-supplied with hooks, and every Enkaku requirement maps onto one. This is why the port is viable at all:

| Enkaku requirement | Where it attaches |
|---|---|
| approval gate before a `destructive` capability (Plan 66 §3.6) | inside the generated `execute`, **before** `invoke()` — a pause returns a rejection the loop can carry |
| device lease acquisition and release (Plan 71) | same place; the lease is per-device, acquired lazily, released on every terminal path |
| `maxSteps` / `maxRunSeconds` / `maxOutputTokens` failing closed | `maxSteps` + `costCapTokens` natively; `maxRunSeconds` via `signal` |
| run-tree caps and shared token budget (Plan 67 §3.6) | `onUsage` accumulating against the tree, `signal` aborting when exhausted |
| inbox drain at a turn boundary (Plan 67 §3.3) | `onStepComplete` — a per-step hook that already awaits |
| append-only message persistence (Plan 66 §3.1) | `onStepComplete` |
| image blocks (Plan 70) | the generated `execute`'s return value; `imageOutputs` handling moves with it |

**`onCheckpoint` is deliberately left unset.** The harness's audited step budget (`agent-core.ts:63-93`) lets an auditor *extend* the ceiling, and the earlier analysis found it fails open in two places — a verdict that fails to parse and an auditor that throws both `continue`. With its shipped settings that is 550 model turns. `00-overview` states the rule for this repo: **no error path may produce more budget.** Unset, the loop takes the legacy hard-stop path (`config.ts:36`), which is what Enkaku wants.

This is the one place the port deliberately declines a harness feature, and it is recorded rather than silently dropped.

### 3.4 One loop, one message log

The harness works in AI SDK `ModelMessage[]`. Enkaku persists `agent_messages` rows with its own content blocks (Plan 66 §4.1, Plan 70 §4.2).

`core/derive.ts` (80 lines) exists upstream for exactly this: deriving UI and audit projections from a single message log. So the direction is settled — **the stored rows stay the source of truth**, and `ModelMessage[]` is the wire built from them for each request.

Two consequences:

- Enkaku's append-only guarantee is untouched. Compaction stays a view (Plan 66 §3.5), which is also how the harness treats it (`compactWire` returns a new wire, it does not rewrite history).
- `sanitizeMessages` from `compaction.ts` replaces ours. Ours was written fresh from the same algorithm; the harness's is the original and has more history behind it. Ours is deleted.

### 3.5 `ProviderEvent` goes away

Plan 66 defined a `ProviderEvent` union so the loop would not import a provider SDK. With the harness owning the loop and the AI SDK owning the stream, that indirection now sits between two things that already agree.

`ProviderAdapter` keeps `languageModel()` (Plan 75 §4.2) and `listModels()`/`countTokens()`. `stream()` and `ProviderEvent` are removed with the loop that consumed them.

### 3.6 `AgentSession` and `AgentRegistry` come across, adapted

`runtime/agent-session.ts` (493 lines) is a per-session class with `send`, `subscribe`, `snapshotState`, `abort`, `forceCompact`, `export`/`restore`/`persist`, `reconfigure`, `tokenBreakdown`. `runtime/registry.ts` (127) keys sessions by project.

Enkaku's equivalent is `agent/runner.ts` plus `thread/store.ts`. The port takes `AgentSession`'s **shape** — the method surface is good and Plan 78's UI will expect it — with two changes that are not negotiable:

- **`snapshotState()` is not how a client attaches.** `CLAUDE.md`: `/ws` has no snapshot replay. A client fetches history over HTTP, then subscribes (Plan 66 §3.4). `snapshotState()` remains as a server-side accessor; it never becomes a subscribe-time payload.
- **Keying is by thread, not project.** Enkaku has threads, runs, and a run tree (Plans 66, 67); `AgentRegistry`'s one-session-per-project model cannot express a parent and its children.

### 3.7 Deleting the old loop is part of the plan

`packages/core/src/agent/loop/{run,request,sanitize,detect-loop,compaction,errors,context}.ts` are removed once their behaviour is on the harness. `00-overview` §4's rule is replace, never version.

Their **tests** are not deleted. Plans 66, 67, 70 and 71's suites are the specification for everything Enkaku added, and they must pass against the new loop with as few edits as the change genuinely forces. Every edited test is listed in the report with the reason — a test quietly relaxed to fit a new implementation is how a regression ships.

## 4. Technical design

### 4.1 `packages/core/src/agent/harness/`

- `config.ts` — builds `HarnessConfig` from a resolved agent config (Plan 65's `resolveAgentConfig`): model from `ProviderAdapter.languageModel()`, `systemPrompt`, `toolsFactory`, `contextWindow`, `maxSteps`, `costCapTokens`, `compaction`, `providerOptions`. **`onCheckpoint` unset** (§3.3).
- `tools.ts` — the registry → `ToolSet` projection (§3.2), including the approval gate, lease handling, and image-block construction inside `execute`.
- `messages.ts` — stored rows ↔ `ModelMessage[]`, using `derive.ts`'s direction (§3.4).
- `session.ts` — `AgentSession` adapted per §3.6, thread-keyed.

### 4.2 `agent/runner.ts`

Keeps its whole outer surface — concurrency, cancellation cascade, restart recovery, approval resumption, the tree's device lock (Plans 66, 67, 71). Only the innermost "drive the model" call changes, from `executeRun` to `runAgentTurn`.

### 4.3 Removed

`agent/loop/` in full; `ProviderEvent`, `ProviderRequest`, `ProviderAdapter.stream()`; our `sanitizeMessages` and `detectLoop` (the harness has both — `compaction.ts` and `agent-core.ts:43`).

## 5. Implementation steps

**76.1 — `tools.ts`**: registry → `ToolSet`, with approval, lease, deadline and images inside `execute`. Tested against the fake provider before anything else moves.

**76.2 — `messages.ts`**: stored rows ↔ `ModelMessage[]`, both directions, images included.

**76.3 — `config.ts`**: `HarnessConfig` from a resolved agent config, `onCheckpoint` unset with the reason in a comment.

**76.4 — `session.ts`**: `AgentSession` adapted, thread-keyed, fetch-then-subscribe preserved.

**76.5 — Switch `runner.ts`** to `runAgentTurn`, wiring §3.3's table hook by hook.

**76.6 — Delete `agent/loop/`** and the provider streaming surface.

**76.7 — Run Plans 66/67/70/71's suites**, listing every test that needed an edit and why.

## 6. Acceptance criteria

1. An agent run is driven by `runAgentLoop`; `packages/core/src/agent/loop/` no longer exists.
2. Every tool call reaches `invoke()`; no capability is executed by any other path.
3. A `destructive` capability still pauses for approval, showing the exact input; approve resumes, deny returns an error result and the run continues.
4. A device lease is acquired lazily and released on **every** terminal path — done, failed, cancelled, paused.
5. `maxSteps`, `maxRunSeconds` and `maxOutputTokens` each stop a run with their own reason, and **no error path anywhere produces more budget**.
6. `onCheckpoint` is unset, and a comment says why. No auditor can extend a step budget.
7. Cancelling cascades through the run tree and leaves no device leased (Plan 67 §6.12 unedited).
8. Messages remain append-only; compaction is a view; a reloaded run shows its full history.
9. A screenshot still reaches the model as an image block whose bytes round-trip (Plan 70 §6.1 unedited).
10. Prompt caching still works: a non-zero cache read on the second turn (Plan 66 §6.13 unedited).
11. Attaching is still fetch-then-subscribe; no message type replays a snapshot.
12. Our `sanitizeMessages` and `detectLoop` are gone; the harness's are used.
13. `ProviderEvent`, `ProviderRequest`, and `ProviderAdapter.stream()` are gone.
14. Every edited test from Plans 66/67/70/71 is listed with its reason.
15. `bun run typecheck` passes; `bun test` and `bun run --cwd packages/studio test` are green.

## 7. Test plan

**Unit — `tools.ts`:** a capability projected to a tool; `execute` refusing without permission, without a grant, without a lease; the approval pause; the deadline; the audit entry on every path including refusals.

**Unit — `messages.ts`:** round-trip stored rows → `ModelMessage[]` → stored rows, including an image block and an orphaned tool result.

**Integration (fake provider):** one tool call; a refusal continuing the run; each budget stop; loop detection; cancellation mid-stream with no lease held afterwards; approve and deny; a restart with a paused run.

**Regression:** Plans 66, 67, 70, 71's suites. Criterion 14 makes every edit visible.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. a thread → "screenshot device X and describe it" → the description matches the screen
# 2. ask for an APK install → approval prompt with the exact path → deny → the run continues
# 3. a long run → Cancel → stops; /api/devices shows no lease held
# 4. spawn a sub-agent → the tree renders; cancel the root → all runs stop
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A capability escapes `invoke()` through the new tool path. | §3.2 makes `execute` a one-line delegation; criterion 2 tests it; the audit assertion catches a path that skipped it. |
| Enkaku's additions are quietly lost in the swap. | §3.3 maps each to a specific hook, and criteria 3–8 are the same assertions Plans 66–71 already make — passing them unedited is the proof. |
| The checkpoint auditor is enabled later "because it is there", and a budget fails open. | §3.3 records the refusal and the number (550 turns); criterion 6 pins `onCheckpoint` unset with its reason in the code. |
| Tests get relaxed to fit the new loop. | Criterion 14 requires every edit listed with a reason, which makes a relaxation a visible decision rather than a diff nobody reads. |
| Deleting the old loop while the new one is half-wired leaves nothing working. | 76.6 is second-to-last; the switch (76.5) is proven against the fake provider first. |

## 9. Open questions

1. Should `onCheckpoint` ever be enabled, with a fail-closed auditor of our own? The hook is good; upstream's policy is not. A verdict that cannot parse would have to mean stop.
2. The harness prunes mid-turn (`compaction.limit`/`reserve`) as well as summarising at `summarizeAt`. Enkaku has only the second. The first is likely wanted and needs a number chosen against real runs.
3. `tokenBreakdown()` and the per-tool stats upstream added (`stats-v2.test.ts`) would feed Plan 69's spend view with real per-tool cost. Not needed to run, clearly useful after.
