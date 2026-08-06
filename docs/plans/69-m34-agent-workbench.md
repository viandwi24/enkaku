# Plan 69 — M34 : The Agent Workbench

> Status: implemented — `packages/studio/src/components/agent/{Transcript,ToolCallCard,ChildRunCard,ApprovalCard,ContextPanel,ThreadList,UsageBadge,UsageSparkline,AgentAvatar,AgentHolderBadge}.tsx` are the eight-plus-two components step 69.1–69.4 asked for. `Transcript`'s hard part (step 69.1) is a pure, exported reducer (`packages/studio/src/lib/agent-transcript.ts`'s `transcriptReducer`) wrapped in `useReducer`: history (`GET /threads/:id/messages`) then `agent.subscribe` (plan 66 §3.4, no snapshot replay), a `seq` gap sets `gapFrom` rather than rendering a hole and a plain effect re-fetches from it, a `delta` action never touches `state.messages`'s array reference (proved by `agent-transcript.test.ts`, so a `React.memo`'d `MessageList` cannot re-render for one — criterion 2), and scroll position is preserved via a `stickToBottomRef` set on every scroll and read by a `useLayoutEffect` (`shouldStickToBottom`, criterion 3). `ToolCallCard` shows the full untruncated input, auto-expands on failure, and renders `device.screenshot`'s base64 PNG inline (criteria 4–5); `ChildRunCard` (step 69.3) is a collapsed summary row that `Transcript` expands into a NESTED, RECURSIVE `<Transcript embedded />` for the child's own thread (a plain self-reference within one file, not a second implementation — criterion 6), plus a separate `next/link` to the child's own full workbench tab. The workbench itself (step 69.5) replaces `agents/detail/page.tsx`'s content with a `Workbench`/`Settings` `EntityTabs` pair over the SAME `TabPanel`-hidden-not-unmounted pattern `device/page.tsx` already uses (Plan 42 — criterion 10): Settings is Plan 65's seven-section editor, byte-for-byte relocated, not rewritten; Workbench is `ThreadList | Transcript | ContextPanel` keyed on `?thread=`. `agents/thread/page.tsx` (Plan 66/67's minimal view) is now a `router.replace` shim into the workbench (`CLAUDE.md` §4.3 "replace, never version" — no second implementation kept alive), and every internal link that pointed at it (`agents/page.tsx`'s "Chat", `NotificationBell.tsx`) now points at `/agents/detail`. `/agents/approvals` (step 69.6) and `/agents/runs?agent=` (§4.1's route table) are new pages. Usage (step 69.7) is per-run (`UsageBadge`, cache reads as their own figure — criterion 8) directly from `AgentRun.usage`, plus a per-agent 14-day sparkline (`ContextPanel`, `agents/page.tsx`'s spend column) and a farm-wide observed figure beside Plan 68's cap (`settings/page.tsx`'s new `ObservedSpendPanel`). Step 69.8: `AgentHolderBadge` names an agent on `DeviceHeader`, `DeviceCard`, and `WallTile` when its lease-holding run is found (criterion 9). Step 69.9 (design pass): `packages/studio/src/components/agent/design-rules.test.ts` greps every new component for `\[--color-` and `<a href="/` per §7's own instruction, and the same two patterns were checked by hand across every EXISTING file this plan edited (`DeviceCard.tsx`, `WallTile.tsx`, `Wall.tsx`, `DeviceHeader.tsx`, `agents/page.tsx`, `settings/page.tsx`, `device/page.tsx`, `app/page.tsx`, `NotificationBell.tsx`) — zero hits (criteria 11–12). `bun run typecheck` is clean across all 11 packages; `bun test` is 2091 pass / 0 fail (baseline 2056 + 35 new — 19 in `agent-transcript.test.ts`, 8 in `ToolCallCard.test.tsx`, 5 in `ApprovalCard.test.tsx`, 3 in `design-rules.test.ts` — zero regressions); `bun run build:studio` was NOT run as the literal command — a `next dev` server was live on :3001 for the whole session (started by someone else in this shared tree) and its own guard (`scripts/build-studio.sh`) correctly refuses to build in place because doing so corrupts that server. Verified instead via an isolated copy: the entire uncommitted working tree (excluding `.git`/`node_modules`/`apps`) was `rsync`'d to a scratch directory, `bun install`ed there (fast — same global cache), and `bun run --cwd packages/studio build` (the exact command the guarded script execs) succeeded twice — full static export, all 22 routes including `/agents/detail`, `/agents/approvals`, `/agents/runs`, `/agents/thread`, `out/agents/detail.html` present on disk. The original working tree was never touched (no `git stash`, no in-place build) — the other agent's concurrent uncommitted work in `apps/guest-agent/`, `packages/core/src/api/guest-agent.ts`, `packages/drivers/src/network/` was neither read nor written. **THREE BACKEND GAPS, FOUND AND WORKED AROUND RATHER THAN FILLED (plan 69 §2's own instruction — "if this plan needs a new endpoint, that is a signal the earlier plan was incomplete" — recorded here, not added quietly):** (1) no endpoint lists pending approvals farm-wide (`GET /runs/:id/approvals` needs a run id you already have; `agent.approval.requested` is a per-thread-subscriber WS broadcast, never global) — `/agents/approvals` composes it client-side (`lib/agent-approvals.ts`: agent → threads → latest run id (from a message's own `runId` field, since no endpoint lists a thread's runs either) → that run's approvals), bounded and polled every 20s rather than live; a `pendingApprovals()` query plus a farm-wide broadcast belongs in a future plan. (2) no endpoint reports OBSERVED usage/spend, only `FarmSettings.scheduledAgents`'s cap — `lib/agent-usage.ts` composes a per-agent 14-day figure and a farm-wide scheduled-runs-last-24h figure (the same metric the cap limits) the same way, bounded to each agent's most recently active threads; an aggregate endpoint would make both exact and cheap instead of O(threads) HTTP calls. (3) an agent's device lease (`agent-run:<rootRunId>`, `agent/runner.ts`) is invisible to every existing endpoint — `DeviceInfo.status` never carries a holder id, and `GET /devices/:id/viewers` is built entirely from live WS connections (`server/ws-handlers.ts`'s `viewersOf`), which a server-side agent run is not — `lib/agent-holders.ts` composes it (agent → recent threads → latest run → `GET /runs/:id/tree`'s `drivingDeviceIds`, the one place this data IS exposed, plan 67 §4.4), polled every 15s; a `heldBy` field on `DeviceInfo` (or the lease manager itself) would make this exact and event-driven. **Deviations, recorded rather than silent:** (a) `lib/agents.ts`'s `Agent` interface gained `requiresApproval`/`wakeOnMessage` — present on the real `AgentSchema` (plans 66/67) since before this plan but never mirrored into Studio's hand-kept type; `ContextPanel` needed the first, so both were added together. (b) criterion 6's "nested, collapsed transcript" is a genuine recursive `<Transcript>` (see above), a stronger reading than Plan 67's own precedent of a flat, link-only direct-children list — chosen because the plan's own words ("so the tree IS the transcript") read as a stronger claim than a link, and the pieces needed (a self-contained `Transcript` that cleanly subscribes on mount and unsubscribes on unmount) already existed. (c) `ToolCallCard` is split into a hookless `ToolCallCardView` (props only, `expanded` lifted out of `useState`) wrapped by a thin stateful `ToolCallCard` — the same split `DeviceHeader` already uses — purely so it is callable directly in a test with no DOM renderer (this workspace has none; see `TileChips.test.tsx`). **Not done:** the manual smoke test script (§7) was not run against a live `bun run dev` + `bun run dev:studio` browser session with a real Anthropic connector — no API key in this environment, matching every prior plan in this series' own note; verified instead via the automated suite above, the two isolated static-export builds, and reading every acceptance criterion against the actual code path it depends on.
> Ships: packages/studio/src/components/agent/ApprovalCard.tsx
> Note (plan 78): `Transcript.tsx` (this line's original artefact) and `Composer.tsx` were superseded by the ported `ai-elements` shell (`components/agent/Chat.tsx`) — "replace, never version" (`CLAUDE.md` §4.3). `ApprovalCard.tsx`/`ChildRunCard.tsx`/`ContextPanel.tsx` (also built by this plan) were KEPT and re-mounted inside `Chat.tsx`, unchanged, so this line now points at one of those instead.
> Depends on: Plans 65 (settings UI), 66 (thread view, approvals), 67 (trees), 68 (notifications). This is the plan that turns four partial interfaces into one.
> Spec references: `docs/design.md` (the design system and its quality floor).

---

## 1. Goals

- One place to work with agents: threads on the left, the conversation in the middle, what the agent can see and touch on the right.
- **Approvals have a home.** A pending approval is findable without knowing which thread it is in.
- An agent's **cost and history** are visible per run and per agent, not only in the database.
- A device driven by an agent **says so**, on the device page and on the wall.
- Every screen meets `docs/design.md`'s floor rather than being a functional draft.

## 2. Non-goals

- New backend capability. Everything here reads APIs that Plans 63–68 already ship. If this plan needs a new endpoint, that is a signal the earlier plan was incomplete and the endpoint belongs there.
- Rich text, markdown extensions, or an editor beyond Plan 64's.
- Mobile layouts beyond what the existing responsive rules already give.

## 3. Context and design decisions

### 3.1 Three columns, and what each is for

```
┌──────────┬───────────────────────────┬──────────────┐
│ Threads  │ Conversation              │ Context      │
│          │  · streamed text          │  · devices   │
│ + New    │  · tool calls, inline     │  · tools     │
│          │  · child runs, collapsed  │  · workspace │
│          │  · approvals, inline      │  · usage     │
│          ├───────────────────────────┤              │
│          │ input                     │              │
└──────────┴───────────────────────────┴──────────────┘
```

The right column is the part that distinguishes this from a chat window: it answers *which phones can this agent touch, which tools does it have, what has it written, and what has it cost* — the four questions someone actually has while watching an agent work, and each of which is otherwise a trip to a settings page and back.

It collapses below the design system's medium breakpoint; the conversation never does.

### 3.2 A tool call is the interesting part of the transcript, not a footnote

An agent driving phones produces a transcript where the tool calls matter more than the prose. Each renders as a card: capability id, target device, the **input**, a status, and the duration. Collapsed by default, expanded on click, and expanded automatically on failure — a failure nobody expanded is a failure nobody read.

`device.screenshot` renders its image inline. This is the single highest-value affordance on the screen: the whole point of an agent driving a phone is seeing what it saw, and a base64 blob in a JSON viewer is not that.

`agent.spawn` renders as a nested run — the child's own transcript, collapsed, with its status and elapsed time — so the tree is the transcript rather than a separate diagram to correlate by hand.

### 3.3 Approvals get their own inbox

Plan 66 renders an approval inline in its thread, which is right when you are watching. It is useless when three agents paused an hour ago in threads you have not opened.

So: `/agents/approvals`, a list of everything pending across every agent, each showing agent, capability, **exact input**, device, age, and time to expiry, approvable in place. The bell from Plan 68 links here.

The exact input is displayed at full width and never truncated. It is the detection mechanism for prompt injection — an operator noticing an install of a package nobody mentioned — and a truncated input defeats it. If it is long, it scrolls; it does not elide.

### 3.4 Cost is per run, and it is not hidden

Plan 66 records usage per run: input, output, cache reads, cache writes, and a computed cost. Studio shows it in three places:

- **per run** — a line in the transcript footer;
- **per agent** — a fourteen-day sparkline with a total, on the agent card;
- **farm-wide** — a Spend section in settings, beside Plan 68's cap, so a cap can be set against an observed number rather than a guess.

Cache read tokens are shown as their own figure rather than folded into input. Plan 65 §3.4 designed for caching and Plan 66 §6.13 tests it; a number that regresses silently would waste the design. Displaying it is how anyone would notice.

### 3.5 A phone driven by an agent says so

Plan 67 §9.3 raised it and it belongs here. The device page header and the wall tile show, when a run holds the device: the agent's name and colour, the root run, and a link to the transcript.

This is a lease-holder rendering, not a new concept — the lease already knows the holder. What changes is that a holder of the shape `agent:<id>` renders as an agent rather than as an opaque client id. Anyone looking at a phone doing something unexpected should be one click from the reason.

### 3.6 The design system, applied rather than assumed

`docs/design.md` sets the floor, and two rules have already caused silent breakage in this codebase and will again:

- **Tailwind v4 colour tokens** are written `bg-surface`, `text-fg-muted`. The v3 bracket form `bg-[--color-surface]` **compiles to nothing and fails silently** — no error, no style, and it looks like a spacing bug for an hour.
- **Internal links use `next/link`.** A plain `<a>` remounts React, which kills the WebSocket and the video stream. On this screen it would also kill a live agent transcript mid-run.

Both are acceptance criteria rather than advice (§6.11, §6.12), because both have shipped before.

## 4. Technical design

### 4.1 Routes

Static export, so query parameters and not dynamic segments (`CLAUDE.md`):

| Route | |
|---|---|
| `/agents` | list: name, model, enabled, device grants, last run, 14-day spend |
| `/agents/detail?id=` | the workbench (§3.1), with the Plan 65 settings sections behind a tab |
| `/agents/approvals` | the inbox (§3.3) |
| `/agents/runs?agent=` | run history: status, stop reason, steps, duration, cost |

### 4.2 Components — `packages/studio/src/components/agent/`

`ThreadList`, `Transcript`, `ToolCallCard`, `ChildRunCard`, `ApprovalCard`, `ContextPanel`, `UsageBadge`, `AgentAvatar`.

`Transcript` is the one with real complexity: it merges a fetched history with a live `/ws` subscription, keyed by `seq`, detecting gaps and re-fetching (Plan 66 §3.4). Two properties it must have, because both are the difference between a usable transcript and an irritating one:

- **Streaming deltas do not re-render the whole list.** Only the tail message updates.
- **Scroll position is preserved unless the user is already at the bottom.** An agent that appends while someone is reading further up must not yank them away.

### 4.3 State

The `/ws` connection Studio already holds; agent events are additional message types (Plan 66 §3.4), not a second socket. Subscription follows the open thread: opening subscribes, leaving unsubscribes, and a background thread does not stream into an invisible component.

Plan 42's view-lifecycle lesson applies directly — a tab switch must not tear down and rebuild the subscription, because here that would drop deltas mid-run.

## 5. Implementation steps

**69.1 — `Transcript`** (§4.2), including gap detection, tail-only re-render, and scroll behaviour. It is the hardest component; build it first while there is room to get it right.

**69.2 — `ToolCallCard`** (§3.2), with inline screenshots and auto-expansion on failure.

**69.3 — `ChildRunCard`** (§3.2), nested transcripts.

**69.4 — `ContextPanel`** (§3.1).

**69.5 — The workbench layout** (§3.1) and the settings tab.

**69.6 — Approvals inbox** (§3.3).

**69.7 — Usage: per run, per agent, farm-wide** (§3.4).

**69.8 — Agent-held devices on the device page and wall** (§3.5).

**69.9 — Design pass** against `docs/design.md`, including §3.6's two rules.

## 6. Acceptance criteria

1. Opening a thread fetches history then subscribes; a `seq` gap triggers a re-fetch and no hole is rendered.
2. Streaming deltas update only the tail message; the transcript does not re-render whole.
3. Scrolling up during a live run keeps position; a user at the bottom keeps following.
4. A tool call shows capability, device, full input, status, and duration; failures are expanded by default.
5. `device.screenshot` renders its image inline.
6. A spawned child renders as a nested, collapsed transcript with status and elapsed time.
7. `/agents/approvals` lists every pending approval across agents with its **complete, untruncated** input, and approving there resumes the run.
8. Usage appears per run, per agent over fourteen days, and farm-wide — with cache reads as their own figure.
9. A device held by an agent names it on the device page and the wall tile, linking to the run.
10. Switching tabs does not tear down the subscription or drop deltas (Plan 42).
11. No Tailwind v4 colour class uses the v3 bracket form anywhere in the new components.
12. Every internal link is `next/link`; no `<a href>` to an internal route.
13. `bun run build:studio` produces a working static export.
14. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Component:** `Transcript` merge — history plus live, out-of-order arrival, a gap, a duplicate `seq`. `ToolCallCard` for each outcome shape. `ApprovalCard` decisions.

**Static analysis:** a test that greps the new components for `\[--color-` and for `<a href="/`, failing on either. Both rules have been broken before; a lint is cheaper than another hour.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. /agents → a thread → ask it to screenshot a device
# 2. the tool card appears with its input, then the image inline
# 3. scroll up mid-run → position holds; scroll to bottom → follows again
# 4. trigger an approval, leave the thread, open /agents/approvals → it is there with the full input
# 5. approve → the run resumes in the thread
# 6. while it drives the phone, open the device page → it names the agent and links back
# 7. switch tabs and back → the transcript is intact, no gap
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A long transcript becomes slow. | Tail-only re-render (§4.2, criterion 2), collapsed tool cards by default, and history paged by cursor. |
| The three-column layout is cramped on a laptop. | The context panel collapses below the medium breakpoint; the conversation never does (§3.1). |
| A truncated approval input hides the thing an operator needed to see. | Criterion 7 requires the complete input; long inputs scroll rather than elide (§3.3). |
| Silent Tailwind v4 breakage. | Criterion 11 plus the grep test in §7 — this has shipped before and will not be caught by review attention alone. |
| A `<a>` link kills a live run's socket. | Criterion 12 and the same grep test. |
| The workbench duplicates the settings editor from Plan 65. | It embeds those sections as a tab (§4.1); no settings UI is rewritten here. |

## 9. Open questions

1. Should a person be able to interject into a running thread — typing while the agent works, delivered at the next turn boundary? Plan 67 built exactly that mechanism for agents. Extending it to people is small and probably wanted; left out to keep this plan to rendering.
2. Should the transcript offer "re-run from here"? Useful for iterating on a prompt, and it needs Plan 66 §9.3's resumption story first.
3. Should the wall offer an agent-driven filter — show only phones an agent is currently using? Cheap once §3.5 lands.
