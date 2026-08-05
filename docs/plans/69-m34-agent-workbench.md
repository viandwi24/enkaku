# Plan 69 — M34 : The Agent Workbench

> Status: not started
> Ships: `packages/studio/src/app/agents/`, `packages/studio/src/components/agent/*`, small additions to the device page and wall
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
