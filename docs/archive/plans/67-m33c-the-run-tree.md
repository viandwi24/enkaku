# Plan 67 — M33c : The Run Tree — Spawning, Messages, and Cascading Cancellation

> Status: implemented — authority intersection (`packages/core/src/agent/tree/authority.ts`, pure, tested first per step 67.2: `intersectCapabilities`/`intersectDeviceGrants`/`intersectPermissions`/`intersectWorkspaceScope`/`intersectAuthority`, plus `effectiveAuthorityForRun` which walks the live `parentRunId` chain — no caching, so criterion 4's "narrows at the next invoke, not only at spawn" holds by construction); the three caps (`agent/tree/caps.ts`: `checkDepthCap`/`checkTreeSizeCap` enforced in `agent.spawn`'s handler, failing the CALL; `treeTokenBudgetExhausted` enforced in `loop/run.ts`'s `runProviderStep`, failing the RUN with `stopReason: 'max-tokens'`); the inbox and spawn grants (`agent/tree/store.ts`, migration `0031_colorful_smasher.sql`'s `agent_inbox`/`agent_spawn_grants` tables, plus `agentRuns.parentRunId/rootRunId/depth/awaited/deviceGrantsOverride` and `aiAgents.wakeOnMessage`, migrations `0032_public_agent_brand.sql`/`0033_wild_blindfold.sql`); the five capabilities (`capability/agent.ts` — `agent.spawn/.send/.reply/.status/.cancel`, all `permission: 'agent.run'`, delegating one-line to `ctx.agentTree`); and the orchestration (`agent/runner.ts`, by far the largest change — cascading cancellation depth-first via `cancelRun`, the tree's shared device lock with ancestor/descendant sharing and sibling refusal, `wakeIdleThread`/`maybeWakeIfIdle` for §3.3, `awaitRunTerminal` for a parked `waitFor: true` spawn that consumes no steps, `getTree` for the Studio view). Protocol additions in `packages/protocol/src/messages/agent.ts` (`AgentRunSchema`'s four new fields, `AgentTreeNodeSchema`/`AgentTreeResponseSchema`, `agent.child.started`/`.finished`, `agent.message.queued`/`.delivered`) and `packages/protocol/src/agent.ts` (`Agent.wakeOnMessage`). REST: `GET /api/v1/runs/:id/tree` (`api/threads.ts`) and `GET/POST/DELETE /api/agents/:id/spawn-grants` (`api/agents.ts`, since the plan's own manual smoke test presumes an operator can grant `canSpawn` and nothing before this plan could). Studio: `agents/thread/page.tsx` gained a direct-children panel (agent, status, steps, elapsed; click navigates to the child's thread), a "queued message" counter driven by `agent.message.queued`/`.delivered`, and a Cancel confirmation naming the subtree size before acting (§4.5). `bun run typecheck` and `bun run build:studio` are both green; `bun test` is 1943 pass / 0 fail (baseline 1883 + 60 new, zero regressions) — the new coverage is `agent/tree/{authority,caps,store}.test.ts` (pure/store-level), `agent/tree.integration.test.ts` (15 end-to-end scenarios through the real capability registry and `invoke()`, fake provider only, covering every numbered criterion below), plus incidental additions to `api/agents.test.ts` for the spawn-grants endpoints. A live `bun run` boot (real HTTP, no mocks) confirmed the five capabilities are registered, an agent persists `wakeOnMessage`, spawn grants round-trip, and `GET /api/v1/runs/:id/tree` returns a well-formed node. **Three real bugs were found and fixed while writing the integration tests, recorded because each would have silently defeated a core claim of this plan:** (1) `cancelRun`'s early-return for an already-terminal run skipped cascading to its descendants entirely — a root that finishes normally after spawning a detached child could never have that child reached by "cancel the root" (contradicts the plan's own manual smoke test step 5); fixed by cascading unconditionally and only gating the "handle myself" half on terminality. (2) The tree-aware `controlLeaseBlockedBy` originally delegated to the base check's `holderUserId === actor.id` comparison, which is a per-AGENT identity — since a parent and its spawned child are never the same agent, this wrongly treated every ancestor/descendant pair as blocking each other, breaking §3.7's "a child may use a device its parent holds" before the sibling-exclusion logic was ever reached; fixed by comparing against the tree's own `leaseClientId` directly. (3) A message enqueued for a run that later gets "woken" (§3.3) had no path to ever be delivered, since draining is per-run-id and the woken run has a different id; fixed by `TreeStore.retarget()`, called by `wakeIdleThread` before launching the new run. **Deviations, recorded rather than silent:** (a) all five new capabilities share the EXISTING `agent.run` permission (Plan 66) rather than a new one — spawning/messaging/cancelling within a tree is the same class of "operating an agent" action that permission already gates. (b) `agent.spawn`'s `deadline` is 86,400,000 ms (24h), not a typical device-operation deadline, because `invoke()`'s own deadline wrapper must never fire before a `waitFor: true` call's actual bound — the PARENT's `maxRunSeconds` — does; this is a deliberate, documented exception to "deadlines are short." (c) `agentRuns.deviceGrantsOverride` (§4.2's `deviceIds` narrowing) is a column the plan's §4.1 schema does not list, added because the narrowing must be read LIVE on every `canReachDevice` check (the same "no caching" requirement authority intersection has), which requires it to be queryable, not just applied once at spawn. (d) `Agent.wakeOnMessage` (§3.3) has no home in Plan 65's schema either — added as `'on-child-result' | 'always' | 'never'` (default `'on-child-result'`, matching the plan's stated per-kind default) since no earlier plan defined this field and 67 is where it is first needed. (e) `agent.cancel`'s sibling-exclusion and cascading-cancel machinery lives entirely in `agent/runner.ts` (in-memory `deviceHolders`/`active`/`queueWaiters` maps) rather than `agent/tree/*`, because only `runner.ts` has the machinery to launch/await/cancel a run — `agent/tree/*` holds everything that is reusable without that machinery (pure authority/caps, and the DB-backed inbox/grants). (f) No Studio UI for editing `canSpawn` itself (only the REST API) — the plan's §4.5 asks only for the tree VIEW, and "no orchestrator UI" is explicit; an operator configures spawn grants via `/api/agents/:id/spawn-grants` today. (g) The Studio tree view shows only DIRECT children inline (not the full multi-level tree) — the "polished workbench" with deep nesting is explicitly Plan 69's job, matching Plan 66's own precedent of shipping a minimal view here. **Not done:** the full manual smoke test script (§7) was not run against a live `bun run dev` + `bun run dev:studio` browser session with a real Anthropic connector — verified instead via the live-boot REST smoke test above (agent creation, spawn grants, thread/run/tree endpoints) plus 15 automated integration tests exercising the exact same code paths a live run would.
> Ships: packages/core/src/agent/tree/authority.ts
> Depends on: Plan 66 (runs, messages, cancellation — this extends all three), Plan 65 (grants and budgets), Plan 63 (`agent.*` are registry entries).
> Spec references: §10.2 (leases).

---

## 1. Goals

- An agent can **spawn another agent**, wait for its result or leave it running, and receive its output.
- A parent can **send a message to a child that is still working**, and a child can send one back — both delivered at a safe moment, never mid-action.
- Cancelling a run **cancels its descendants**, and every one of them releases what it held.
- A tree cannot grow without bound: depth, run count, and token spend are all capped, and every cap fails closed.
- A child can **never** be more privileged than its parent.

## 2. Non-goals

- A general agent-to-agent mailbox. Messaging is scoped to the parent/child edge of a tree. Arbitrary agents messaging arbitrary agents is a much larger surface — routing, delivery, authority — and nothing yet needs it.
- An "orchestrator" agent type. There is none, and §3.1 explains why that is the right outcome rather than an omission.
- Schedules (Plan 68).
- Sub-agents on other machines. A tree runs in one core.

### 3.1 An orchestrator is an agent with one extra tool

The user's own reading, and it is correct: an orchestrator differs from any other agent only in its tool list, its prompt, and its permissions — all of which are already per-agent fields from Plan 65. So there is no orchestrator type, no orchestrator table, and no orchestrator UI. An agent that has `agent.spawn` in its allowlist orchestrates; one that does not, does not.

What this plan actually builds is the thing an orchestrator needs and that does not exist: the **run tree** and the channel along its edges.

## 3. Context and design decisions

### 3.2 Spawning, in two shapes

```
agent.spawn({ agent: 'inspector', prompt: '…', waitFor: true })
```

| `waitFor` | Behaviour |
|---|---|
| `true` (default) | The tool call does not return until the child finishes; its final output **is** the tool result. The parent consumes wall-clock but **no steps** while waiting. |
| `false` | Returns `{ runId }` at once. The child's completion arrives later as an injected message (§3.3). |

`true` is the default because it is what a delegating agent almost always means, and because it is the shape that cannot leak: a parent that finishes while its children run is the case that needs the machinery in §3.3, and most callers should never reach it.

A parked parent is genuinely parked — no polling, no step consumed per check. `maxRunSeconds` still applies to the parent, and the parent's expiry cancels the child (§3.5), because a parent that has given up should not leave work running on twenty phones.

### 3.3 Messages arrive at turn boundaries, and never mid-action

Three edges, one mechanism:

- `agent.send({ runId, message })` — parent → a running child
- `agent.reply({ message })` — child → its parent, while the child still runs
- child completion → parent, when `waitFor: false`

All three **append to the target thread and enqueue for injection**. The target's loop drains its queue at the top of each iteration — that is, **between model turns** — and never inside a tool call.

This is the single most important constraint in the plan, and it exists because Enkaku drives physical hardware. If a child is thirty seconds into an APK install, a gesture sequence, or a file push, there is no correct way to insert a message into that. Interrupting leaves the phone in an undefined state; the harness this design learned from had exactly this defect in the opposite direction — its `abort()` cancelled the model stream but let tools run on regardless, so "stop" was a statement about the wrong half of the system.

So a message waits for the boundary. Worst-case latency is one capability deadline, which Plan 63 declares per capability and which is therefore a known number rather than an open question.

If the target run has already finished, the message still appends to the thread. Whether it starts a **new** run is `wakeOnMessage` on the agent (default **on** for a spawn result, **off** for a plain message) — because a completion the parent asked for is exactly the notification the parent wanted, while an unsolicited message waking an idle agent is how a farm develops perpetual motion.

### 3.4 A child is never more privileged than its parent

The authority of a spawned run is the **intersection** of the child agent's own configuration and the running parent's:

| | Child's effective authority |
|---|---|
| capabilities | child's allowlist ∩ parent's allowlist |
| devices | child's grants ∩ parent's grants (Plan 65 §3.5: empty = all, so intersecting with an empty set yields the other side) |
| permissions | child's set ∩ parent's set |
| workspace | child's scope ∩ parent's scope |

Without this, spawning is a privilege-escalation primitive: a read-only triage agent spawns the admin agent and does anything. Since a low-privilege agent is exactly the kind most likely to be reading attacker-controllable device text, that would place the escalation at the end of the shortest injection path in the system.

An agent additionally declares `canSpawn` — which agents it may spawn — defaulting to **none**. Spawning is opt-in per pair, so a new agent cannot spawn anything at all until someone says which.

The intersection is computed at spawn and **re-checked at each `invoke`**, so demoting a parent mid-run does not leave a child running with yesterday's authority.

### 3.5 Cancellation cascades, depth-first

Cancelling a run cancels every descendant first, then itself. Each performs Plan 66 §3.7's six steps in full — including releasing leases — so a cancelled tree leaves no device held.

Depth-first matters: cancelling the parent first would let a child finish and try to deliver a result to a run that no longer exists, and the handling of *that* is a state nobody wants to reason about.

A parent that fails, is interrupted by a restart, or exceeds a budget cancels its children the same way. The rule is that **a run never outlives its parent** — there is no orphan state, so there is no orphan-reaping problem.

### 3.6 Three caps, all failing closed

| Cap | Default | Scope |
|---|---|---|
| depth | 3 | root = 1; so a root, its children, and their children |
| runs per tree | 25 | the whole tree, for its lifetime |
| tokens per tree | inherited from the root's `maxOutputTokens` | shared across every run in the tree |

The token budget is **shared, not per-run**, which is the whole point: twenty children each with the root's budget is twenty times the spend the operator authorised. Each run checks the tree's remaining budget before its next model call and stops with `max-tokens` when it is gone.

Exceeding a cap fails the `agent.spawn` call with a named error and a `tool_result` the model can act on — it does not fail the run. A parent told "depth limit reached" can do the work itself; a parent whose run is destroyed learns nothing.

Every cap fails closed. There is no path — no parse failure, no timeout, no provider error — by which a failure produces more depth, more runs, or more tokens.

### 3.7 One device, one run in a tree

Plan 63 gives a `lease: 'control'` capability its lease check, and Plan 66's runs acquire leases. Within a tree this creates two problems the naive design gets wrong in opposite directions:

- If each run were its own lease holder, a child needing a device the parent holds would **deadlock against its own tree**.
- If the tree simply shared one holder, two siblings could drive one phone at once. The per-device queue keeps the adb calls from corrupting each other, but interleaved taps from two agents are still nonsense, and the resulting screenshots would be nonsense in a way that looks like a device fault.

So: **the tree is one lease holder — the root run's id — and at most one run in the tree may hold control of a given device at a time.** A sibling asking for control of a device another sibling holds is refused, naming the sibling and its capability. That is a legible message, and it fails fast rather than producing a phone with two drivers.

Other actors see the tree as a single holder, which is what they already understand.

## 4. Technical design

### 4.1 Storage

Extend `agent_runs` (Plan 66 §4.1):

```ts
parentRunId: text('parent_run_id'),
/** The root's id; equals `id` for a root. Makes the whole tree one indexed query. */
rootRunId: text('root_run_id').notNull(),
depth: integer('depth').notNull().default(1),
/** True when the parent is parked on this child's result (§3.2). */
awaited: integer('awaited', { mode: 'boolean' }).notNull().default(false),
```

plus an index on `rootRunId`, and:

```ts
export const agentInbox = sqliteTable('agent_inbox', {
  id: text('id').primaryKey(),
  targetRunId: text('target_run_id').notNull(),
  fromRunId: text('from_run_id'),
  kind: text('kind').notNull(),                    // 'message' | 'child-result'
  body: text('body', { mode: 'json' }).notNull(),
  /** Null until drained at a turn boundary (§3.3). */
  deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('idx_inbox_target').on(t.targetRunId, t.deliveredAt)])

export const agentSpawnGrants = sqliteTable('agent_spawn_grants', {
  parentAgentId: text('parent_agent_id').notNull(),
  childAgentId: text('child_agent_id').notNull(),
}, (t) => [primaryKey({ columns: [t.parentAgentId, t.childAgentId] })])
```

The inbox is a table and not an in-memory queue so a message survives a restart, and so an undelivered message is inspectable when an agent appears stuck. `agentSpawnGrants` is a table rather than a JSON column because "which agents may spawn this one" is a question worth asking in both directions.

### 4.2 Capabilities — `packages/core/src/capability/agent.ts`

| id | effect | Notes |
|---|---|---|
| `agent.spawn` | write | `{agent, prompt, waitFor?, deviceIds?}`; enforces §3.4 and §3.6 |
| `agent.send` | write | to a **descendant** run only; refuses anything else |
| `agent.reply` | write | to the **parent** run only |
| `agent.status` | read | a descendant's status, steps, and last message |
| `agent.cancel` | destructive | cancels a descendant subtree; `destructive`, so Plan 66's approval gate applies unless the owner allowlists it |

`agent.send` and `agent.reply` are restricted to the tree's own edges. Addressing an arbitrary run is not expressible — not merely refused — because a capability whose input can name any run in the farm is one injection away from being a farm-wide message bus.

`deviceIds` on spawn narrows a child below the intersection but can never widen it (§3.4). Narrowing is the useful direction: a parent with twenty devices spawning twenty children, one device each, is the fan-out this feature exists for, and each child should see only its own phone.

### 4.3 Loop changes — `packages/core/src/agent/loop/run.ts`

Two additions at the top of each iteration, before the budget checks:

```
drain the inbox for this run:
  append each undelivered message, mark it delivered
  (this is the ONLY place messages enter a run — plan 67 §3.3)
```

and, when parked on an awaited child, park on a signal rather than a poll. The parked parent consumes no steps and makes no provider calls.

### 4.4 Protocol

`agent.tree` (the shape, for the UI), `agent.child.started`, `agent.child.finished`, `agent.message.queued`, `agent.message.delivered`. The last two are what make "sent but not yet delivered" visible instead of looking like a lost message.

### 4.5 Studio

The thread view gains a tree: children inline and collapsed, each showing agent, status, steps, and elapsed time; expanding opens the child's thread. A queued message shows as queued until delivered, so the boundary rule is visible rather than mysterious. Cancel on any node cancels its subtree, and says how many runs that is before doing it.

## 5. Implementation steps

**67.1 — Schema: tree columns, inbox, spawn grants** (§4.1).

**67.2 — Authority intersection** (§3.4). Pure, tested first — it is the security property of this plan, and everything else assumes it holds.

**67.3 — Caps** (§3.6): depth, run count, shared token budget.

**67.4 — `agent.spawn`** (§4.2), both `waitFor` shapes.

**67.5 — Inbox and turn-boundary drain** (§3.3, §4.3), with `agent.send` and `agent.reply`.

**67.6 — Cascading cancellation** (§3.5), depth-first, leases released at every node.

**67.7 — Tree lease holder and the one-run-per-device rule** (§3.7).

**67.8 — Protocol and the Studio tree** (§4.4, §4.5).

## 6. Acceptance criteria

1. `agent.spawn` with `waitFor: true` returns the child's final output as the tool result; the parent consumes **no steps** while parked.
2. `agent.spawn` with `waitFor: false` returns a `runId` at once, and the completion arrives later as an injected message.
3. A child's effective authority is the intersection of its own and its parent's, for all four scopes; a child whose agent has broader grants cannot use them.
4. Demoting a parent mid-run narrows the child's authority at its next `invoke`, not only at the next spawn.
5. An agent may spawn only agents named in `canSpawn`; the default is none, and a non-granted spawn is refused naming both agents.
6. `agent.send` to a **running** child is delivered at the child's next turn boundary — never during a tool call. Tested with a deliberately slow capability: delivery is observed strictly after it completes.
7. `agent.reply` reaches the parent the same way.
8. A message to a finished run appends to the thread; it starts a new run only when `wakeOnMessage` allows it.
9. Depth beyond the cap fails the spawn with a named error as a `tool_result`; the parent's run continues.
10. Runs beyond the tree cap fail the same way.
11. The token budget is shared across the tree: children's spend counts against the root's, and exhaustion stops runs with `max-tokens`.
12. Cancelling a run cancels every descendant depth-first; afterwards **no device in the tree is leased**.
13. A parent that fails, is interrupted, or exceeds a budget cancels its children. No run outlives its parent.
14. The tree is one lease holder: a child may use a device its parent holds. A **sibling** asking for control of a device another sibling holds is refused, naming the sibling.
15. `agent.send` and `agent.reply` cannot address a run outside the tree — the refusal is at input validation, not at delivery.
16. `agent.cancel` is `destructive` and therefore passes through Plan 66's approval gate unless allowlisted.
17. An undelivered message is visible in Studio as queued.
18. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit — intersection:** all four scopes; the empty-means-all device rule intersected against a restricted parent (this is the subtle one and must be a named case); a permission the child has and the parent does not.

**Unit — caps:** each at its boundary; a shared token budget consumed by three children; each cap asserted to fail closed under a forced parse error and a forced timeout.

**Integration (fake provider):**
- parent spawns, waits, receives output; the parent's step count is unchanged by the wait;
- parent spawns detached, finishes, and the child's completion wakes it;
- `agent.send` mid-run delivered at the boundary, using a capability with a long deadline so "after, not during" is unambiguous;
- cascade cancel over depth 3 with leases held at each level, asserting all released;
- two siblings contending for one device: one wins, one is refused naming the winner;
- a parent killed by `maxRunSeconds` with two children running, asserting both are cancelled.

**Restart:** a tree mid-flight with queued inbox rows — after restart, `running` runs are `interrupted`, their children cancelled, and undelivered messages remain visible rather than vanishing.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. an orchestrator agent with agent.spawn, granted to spawn 'inspector'
# 2. "check the home screen on all three devices" → three children, one device each
# 3. the tree renders; each child shows its own device
# 4. send a message to one running child → shows queued, then delivered at its next turn
# 5. cancel the root → all four runs stop; /api/devices shows no lease held
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Spawning becomes a privilege-escalation path. | §3.4's intersection, `canSpawn` defaulting to none, re-checked at every `invoke`, and criteria 3–5. |
| A tree fans out and floods the farm. | Three caps (§3.6), all failing closed, plus the per-device rule in §3.7 and the existing per-device queue underneath. |
| A message interrupts a device mid-action. | Not expressible: delivery happens only in the loop's drain step (§4.3), and criterion 6 tests it against a slow capability rather than assuming it. |
| A cancelled tree leaves a phone leased. | Depth-first cascade (§3.5), and criterion 12 asserts the absence of leases after the fact rather than trusting the ordering. |
| A parked parent holds resources for a long time. | It consumes no steps and makes no provider calls; `maxRunSeconds` still bounds it, and its expiry cancels the child rather than abandoning it. |
| An agent spams its parent with `agent.reply`. | Each reply appends a message and counts against the tree's token budget, so it is self-limiting, visible in the thread, and bounded by a cap that already exists. |

## 9. Open questions

1. Should a child be able to spawn a sibling rather than a descendant? It would flatten some workflows and it breaks the tree invariant that makes cancellation and authority tractable. Not without a strong case.
2. Should `waitFor: true` have its own timeout, distinct from the parent's `maxRunSeconds`? Today the parent's budget bounds it, which conflates "this child is slow" with "this run is long".
3. Should a tree be visible on the Devices page — "this phone is being driven by agent X under root run Y"? Almost certainly yes, and it belongs with Plan 68's workbench.
