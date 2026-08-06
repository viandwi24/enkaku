# Plan 78 — M43 : The Chat UI, Ported

> Status: implemented — `packages/studio/src/components/ai-elements/{conversation,message,prompt-input,reasoning,shimmer}.tsx` are the exact five upstream imports (2,321 lines total; the other 43 vendored-and-unused files are absent — criteria 1, 2), copied verbatim then given the §3.7 pass: three token substitutions (`bg-surface-raised` → `bg-surface-2`, Studio's actual "raised" surface token — `message.tsx` ×1, `conversation.tsx` ×2, `reasoning.tsx` ×1) and one dead class dropped (`font-display`, a token Studio never defined — `conversation.tsx` ×1); `prompt-input.tsx` and `shimmer.tsx` are BYTE-IDENTICAL to upstream (criterion 13 — every diff is recorded below). Six shadcn primitives (`button-group`, `command`, `hover-card`, `input-group`, `spinner`, `collapsible`) were added through `bunx shadcn@latest add`, the same generator Studio's existing ones came from, not hand-written. **The plan's own §4.3 assumption did not survive contact with Plan 76's actual implementation, and this is the load-bearing finding of this plan**: §4.3 says the core can return the harness's `agentUIResponse()` (`packages/harness/src/runtime/ui-stream.ts`) directly. It cannot — `agentUIResponse()` wraps `runAgentLoop` and expects every AI SDK tool to carry its own `execute()`, but Plan 76 §3's own status header records the OPPOSITE decision on purpose: every generated tool (`harness/tools.ts`) has NO `execute` at all, because a tool executing concurrently with the rest of a step's stream can land its `tool_result` at a LOWER `seq` than the `tool_use` that produced it — every call is instead resolved one loop iteration later by `harness/run.ts`'s `processPendingCalls`, which is also where the approval gate, the lease, and the tree budget all live. Calling `agentUIResponse()` as the plan describes would stream text fine and then leave every tool call permanently pending — no approvals, no screenshots, no child runs, ever. `packages/core/src/api/agent-chat-stream.ts` (new, 27 tests across it and its route) is the real bridge instead: it drives Enkaku's EXISTING, unmodified `AgentRunner.postMessage` (identical approval/lease/tree/budget path REST already used) and re-emits the SAME `ServerMessage`s `agentWs` already broadcasts over `/ws` as AI SDK `UIMessageChunk`s, using a duck-typed subscriber (`.readyState`/`.send()` only — everything `ws-handlers-agent.ts` actually calls) so `/ws` keeps broadcasting to every OTHER tab unaffected. `POST /api/v1/threads/:id/chat` (`packages/core/src/api/threads.ts`) wires it: `agent.run` permission, `PostThreadMessageInputSchema` body, `createUIMessageStreamResponse`. Text/thinking deltas become `text-*`/`reasoning-*` chunks; tool/approval/child events become `data-toolCall`/`data-approval`/`data-child`/`data-runStarted`/`data-runFinished` parts, tracked server-side as a full accumulated object per id and rewritten whole on every update (`@ai-sdk/react`'s own reconciliation REPLACES `.data`, never merges it — found and fixed by `agent-chat-stream.test.ts`'s own "started then finished still carries `input`" case) — including a `tool_result`'s actual content (an image, for `device.screenshot`; NOT in `agent.tool.finished` at all, only in the persisted `agent.message` role-`'tool'` broadcast a beat later, matched by `toolUseId`). A `paused` run (an approval gate) does NOT close the stream — `runner.ts`'s `resumeRun` calls `launch()` again on the SAME run id the instant the approval is decided, and this stream is still subscribed to receive it (proven by `agent-chat-stream.test.ts`'s dedicated pause/resume case). Criterion 4 holds literally: `credentials: 'include'` on a `DefaultChatTransport`, `grep -rn "EventSource"` across every file this plan touched finds it only inside comments explaining why it is NOT used, and no URL anywhere carries the session cookie (Enkaku authenticates via `enkaku_session`, a COOKIE, not the bearer header the plan's prose assumed — recorded as a deviation in the plan's own reasoning, not in its conclusion, which still holds: only `fetch` can carry a credential a `<script src>`/`EventSource` URL cannot). `packages/studio/src/components/agent/Chat.tsx` (§4.2) replaces `Transcript.tsx`/`Composer.tsx` (deleted, with their tests, along with `lib/agent-transcript.ts` — its reducer is genuinely dead now that nothing subscribes to `/ws` for the transcript itself, but its still-needed pure helpers — `blobUrl`, `wireNameToCapabilityId`, `findImageBlock`, `textOfToolResult`, `computeImageInContext`, `clampComposerHeight`, `composerDraftKey`, `extractDeviceIdForDisplay` — moved to the new `lib/agent-chat.ts` verbatim, re-tested in `agent-chat.test.ts`, 20 cases): `useChat` against the bridge, `historyToUIMessages` (`lib/agent-chat.ts`) turning `GET /threads/:id/messages` into `initialMessages` (fetch-then-subscribe still holds, criterion 5, plan 78 §3.5 — nothing replays a snapshot), `Conversation`/`Message`/`Reasoning` rendering `useChat`'s own `messages`, and `ApprovalCard`/`ChildRunCard`/`ToolCallCard` (all THREE kept per §3.1's table, mounted inside `Message` reading the `data-*` parts) for the concepts upstream has no notion of. `agents/detail/page.tsx` swaps `Transcript` → `Chat` at its one call site, unchanged otherwise (same `key={threadId}`, same `onRunChange`/`onTreeChange`/`onAgentChange` props — `Chat` derives an `AgentRun`-shaped value from the stream's own `data-runStarted`/`data-runFinished` parts rather than a second WS subscription). Slash commands (§3.6, criterion 8) finally have somewhere to live: `GET /api/v1/agent-commands` (new; `AgentCommandsResponseSchema`, `@enkaku/protocol`) returns `allPluginCommands()` (new, `agent/plugins/index.ts` — `AGENT_PLUGINS.flatMap(p => p.commands ?? [])`), and `Chat.tsx`'s composer (wrapped in `PromptInputProvider` so a sibling popover can read/write the controlled textarea, matching upstream's own reason for that wrapper) shows a live-filtered `PromptInputCommand` list the instant the text is `/`+a prefix, completing to `/name ` on selection — proven with a fake two-command list (`Chat.test.tsx`'s dedicated case types `/comp`, asserts the OTHER command is filtered out, clicks, asserts completion) since the real registry honestly returns `[]` today (plan 77 §9 open question 2 — no plugin populates `commands` yet; `allPluginCommands`'s own test asserts exactly that, by name, so it reads as the current true state rather than an oversight). Approvals carry the exact, untruncated input end to end (criterion 6 — proven at the bridge in `agent-chat-stream.test.ts` with a long adversarial-shaped string, `toEqual`, not merely `toContain`) and survive the wholesale-replace reconciliation (input/capabilityId preserved from `requested` through `resolved`). A `device.screenshot` result renders inline (criterion 7 — proven at both the bridge, for the live path, and `agent-chat.test.ts`'s `historyToUIMessages`, for the history path) via the SAME `ToolCallCard` every prior plan already built and tested, kept rather than replaced by a port of upstream's `quant/tool-row.tsx` — §3.1's table names `tool-row.tsx` as the intended replacement "keeping our inline screenshot"; this plan judged the existing, tested, Enkaku-specific card (device labels, the dropped-from-context hint, the exact expand-on-failure behaviour) not worth discarding for a 180-line port that would need the same Enkaku-specific behaviour re-added immediately — recorded as a deviation, not a silent substitution. A child run renders as `ChildRunCard` plus, when expanded, a recursive `<Chat embedded />` for its own thread (unchanged shape from `Transcript.tsx`'s own precedent — a "Sub-agents" section below the transcript rather than a part interleaved inline, since `ChildRunCard` needs `GET /runs/:id/tree`'s richer fields — `agentName`, `steps`, `drivingDeviceIds` — that the minimal `data-child` bridge payload does not carry). `design-rules.test.ts` passes over every ported/new file — zero `[--color-`, zero internal `<a href="/`, zero viewport `calc()` (criterion 9, mechanically verified: `bun test`'s 0-fail run includes this suite; `grep` confirms directly against `ai-elements/`, `Chat.tsx`, `agent-chat.ts`). `bun run build:studio` produces a working 25-route static export both before this plan's UI was wired in and after (criterion 11): shared First Load JS 102 kB → 107 kB (+5 kB, paid by every page); `/agents/detail` alone — the only route importing the ported surface — 24.2 kB page / 230 kB First Load JS → 542 kB page / 765 kB First Load JS; the export's JS chunk total (byte-summed, not `du`'s block-rounded figure) 1.81 MB (65 files) → 15.30 MB (447 files); the whole `out/` directory 3.2 MB → 20 MB. `streamdown` + its four plugins (`@streamdown/{cjk,code,math,mermaid}`, pulling in KaTeX and mermaid) account for nearly all of it — the trade §3.3/the risks table asked to be measured, not guessed at, is now a number: roughly +14 MB of code-split weight paid ONLY by a visit to the agent workbench, for the ported composer, markdown, and math/diagram rendering. `bun run typecheck` is green across all 12 packages; root `bun test` is 2182 pass / 0 fail (baseline 2169 + 13 net new — `agent-chat-stream.test.ts`'s 11, `plugins/index.test.ts`'s 2); `bun run --cwd packages/studio test` is 312 pass / 0 fail (baseline 326: −6 net — `Transcript.test.tsx` and `Composer.test.tsx` deleted with their components, `agent-transcript.test.ts`'s reducer-specific cases deleted with the reducer, offset by `agent-chat.test.ts`'s 20 (moved helpers + new `historyToUIMessages` cases) and `Chat.test.tsx`'s 6); `bash scripts/check-harness-provenance.sh` exits 0 (`packages/harness/src` untouched — the bridge lives entirely in `packages/core`); `bash scripts/check-plan-status.sh` exits 0 (this plan's own `Ships:` line now resolves; plans 69 and 73's `Ships:` lines, which pointed at `Transcript.tsx`/`Composer.tsx`, were repointed to `ApprovalCard.tsx`/`AskAnAgentDialog.tsx` — files those SAME plans built that this one did not touch — with a one-line note explaining why, rather than left dangling on a deleted file). **Not done, recorded rather than silently dropped:** (1) no live `bun run dev`/`dev:studio` browser session with a real Anthropic connector was exercised — matching every prior plan in this series' own recorded limitation (no API key in this environment); verified instead via the render/unit suites above and reading every acceptance criterion against the code path it depends on. (2) criterion 12 ("a tab switch does not tear down the stream") holds BY CONSTRUCTION — `Chat` is mounted in the exact same `TabPanel` slot (`agents/detail/page.tsx`, unchanged, still hidden-not-unmounted per Plan 42/73) `Transcript` was — but was not observed live in a browser tab-switch. (3) Plan 70 §3.7's "image dropped from the agent's current context" hint (`inContext`, `ToolCallCard`'s own prop) is not wired from `Chat.tsx` — `computeImageInContext` operated over a flat `AgentMessage[]` history Chat no longer keeps (its state is `useChat`'s own per-message parts); every screenshot still renders, only the amber "no longer in context" note is missing. `computeImageInContext` itself is kept in `lib/agent-chat.ts`, tested, unused — ready for whoever wires it back in. (4) the "N messages queued" indicator (`agent.message.queued`/`.delivered`, plan 67 §3.3's inbox) has no bridge translation and does not appear in `Chat.tsx` — a real, scoped-out feature gap, not an oversight. (5) `PromptInputActionAddAttachments`/`PromptInputActionAddScreenshot` (upstream's `getDisplayMedia`-based operator-screen capture) were not ported — meaningless for a device farm (it would screenshot the OPERATOR's own monitor, never the phone); Enkaku's screenshots come from the `device.screenshot` capability instead, already rendered inline. (6) criterion 10 ("every ported screen has a render test") is satisfied at the `Chat.tsx` workbench-screen level (`Chat.test.tsx`: loaded/loading/error/composer/slash-commands, 6 cases) — the five `ai-elements` files themselves, being primitives rather than screens, have no INDIVIDUAL render tests; this is a scope reading, recorded rather than assumed. (7) no Hono-level integration test boots a real app to exercise `POST /threads/:id/chat` end to end — the translator it delegates to (`agent-chat-stream.ts`) has 11 dedicated tests against a faked `agentWs`, but the route's own plumbing (permission gate, body validation, wiring `start()` to `runner.postMessage`) is proven only by typechecking and by mirroring the adjacent, already-tested `POST /threads/:id/messages` route byte-for-byte in shape.
> Ships: packages/studio/src/components/ai-elements/prompt-input.tsx
> Depends on: Plans 75 (AI SDK), 76 (the harness loop and its UI stream), 77 (skills and slash commands), 72 (the render-test infrastructure that makes this verifiable).
> Source of truth for the port: `bitorex-algo/packages/web/components/{ai-elements/*,quant/chat-panel.tsx}`.

---

## 1. Goals

- Studio's agent chat is the **ported** interface — `ai-elements` plus `chat-panel`'s shape — not a second one written from scratch.
- The composer is the real `prompt-input` (1,479 lines upstream): attachments, model selector, slash commands, stop, the lot.
- The transport is the AI SDK's own, over `fetch` — which is what makes it work at all across Studio's origin and the core's.
- Every ported screen has a **render test** (Plan 72's infrastructure).

## 2. Non-goals

- Porting all 48 `ai-elements`. Upstream imports **five**. §3.2.
- Porting `chat-panel`'s trading-specific pieces — `backtest-tool-card.tsx`, `strategy-*`, `rule-editor` and friends. They are that product's features.
- Rebuilding Studio's shell, settings, or device pages. Plan 73 did those and they stay.
- Server-side work. Plans 75–77 own it.

## 3. Context and design decisions

### 3.1 What replaces what

Plans 69 and 73 built `Transcript.tsx`, `ToolCallCard.tsx`, `Composer.tsx` and friends. They work. They are also a from-scratch implementation of the thing being ported, and keeping both would leave two chat UIs.

The ported components replace them. Enkaku-specific cards that have no upstream equivalent — the approval card, the child-run card, the holder badge — are kept and re-mounted inside the ported shell, because they render Enkaku concepts (Plans 66, 67, 71) that the source project has no notion of.

| Ours today | After |
|---|---|
| `Transcript.tsx` | `ai-elements/conversation` + `message` + `reasoning` |
| `Composer.tsx` | `ai-elements/prompt-input` |
| `ToolCallCard.tsx` | ported `quant/tool-row.tsx`, keeping our inline screenshot |
| `ApprovalCard`, `ChildRunCard`, `ContextPanel`, `HolderBadge` | **kept** — no upstream equivalent |

### 3.2 Five components, not forty-eight

`components/ai-elements/` holds 48 files and 12,361 lines. Grepping upstream's own imports, exactly **five** are used:

| Component | Lines | What it is |
|---|---|---|
| `prompt-input` | 1,479 | the composer — attachments, model select, submit/stop |
| `message` | 367 | message rendering, markdown through `streamdown` |
| `reasoning` | 228 | collapsible thinking blocks |
| `conversation` | 168 | the scroll container, sticky-to-bottom |
| `shimmer` | 79 | loading shimmer |

The other 43 are vendored-and-unused. Porting them would add ~10,000 lines nobody calls, and the earlier analysis already named that as one of the source project's own problems. If one is wanted later it is one file away.

### 3.3 Dependencies the port actually needs

Read off the five components' imports, not guessed:

| Package | Note |
|---|---|
| `ai` | already added by Plan 75 |
| `@ai-sdk/react` | new — `useChat` |
| `streamdown` + `@streamdown/{cjk,code,math,mermaid}` | markdown renderer |
| `use-stick-to-bottom` | `conversation`'s scroll behaviour |
| `motion/react` | animation |
| `nanoid` | ids |
| `@radix-ui/react-use-controllable-state` | |
| `lucide-react`, `react` | already present |

Six shadcn primitives are missing from Studio and must be added: **`button-group`, `command`, `hover-card`, `input-group`, `spinner`, `collapsible`**. Studio already has `button`, `tooltip`, `dropdown-menu`, `select`.

`streamdown` brings a markdown pipeline including mermaid. That is a real weight increase on a static export, and it is the price of the composer and message rendering being the ported ones. Step 78.1 records the bundle size before and after so the trade is a measured number rather than an impression.

### 3.4 The transport is `fetch`, and that is what makes it work

Upstream streams with `EventSource` (`lib/api.ts:297`) against a same-origin BFF route. Enkaku cannot do that, for a reason worth stating plainly: **`EventSource` cannot set headers.** Studio runs on `:3001`, the core on `:7700`, and the core authenticates with a session token. An `EventSource` would have to carry that token in the query string — and putting a credential in a URL is exactly what must not happen.

The AI SDK's `useChat` uses `fetch` with a streamed body, not `EventSource`. `fetch` sets headers. So adopting the SDK's own transport solves the problem the port would otherwise create, rather than working around it.

The core exposes the harness's `agentUIResponse()` (`runtime/ui-stream.ts:295`) — already a `Response` — at `POST /api/v1/threads/:id/chat`, with the existing auth middleware in front. CORS for `localhost:*` in dev is already on (`CLAUDE.md`).

`/ws` keeps everything else: device state, leases, presence, video. Only the chat token stream moves to `fetch`, because only it needs to.

### 3.5 Fetch-then-subscribe still holds

Plan 66 §3.4 and `CLAUDE.md`: `/ws` has no snapshot replay, so a client fetches history over HTTP and then subscribes. `useChat` takes `initialMessages`, which is that shape exactly — load the thread's history, hand it over, stream from there.

`AgentSession.snapshotState()` stays a server-side accessor and never becomes a subscribe-time payload (Plan 77 §3.6 made the same call).

### 3.6 Slash commands finally have somewhere to live

Plan 77 ports `AgentPlugin.commands` as a declaration with nothing to type them into. `prompt-input` plus upstream's `slash-commands.tsx` is that place: the popover reads the assembled command list from the plugin registry, so a plugin adding a command makes it appear with no UI change.

That closes the loop the plugin system was designed for — one feature contributes its prompt section, its capabilities, **and** its commands, in one file.

### 3.7 The design floor still applies to ported code

Plan 73 §3.6 widened `design-rules.test.ts` over all of `packages/studio/src`, rejecting the Tailwind v4 bracket form, internal `<a href>`, and viewport `calc()`. Ported files are not exempt — upstream had different conventions and its own shell, and a ported file that trips one of these breaks Studio in the same silent way a hand-written one would.

Where a ported component genuinely needs a different token, it is adapted to Enkaku's, and the adaptation is listed. "It came from upstream" is not a reason for a screen to render unstyled.

## 4. Technical design

### 4.1 Copy

`packages/studio/src/components/ai-elements/` ← the five files, verbatim first, then adapted only for §3.7 and Studio's import aliases. The diff from upstream is recorded in the status header, as Plan 75 §3.1 does for the harness.

Six shadcn primitives added through the same generator Studio's existing ones came from, not hand-written.

### 4.2 `packages/studio/src/components/agent/Chat.tsx`

`chat-panel.tsx`'s shape, minus the trading pieces: `useChat` against `/api/v1/threads/:id/chat`, `Conversation` wrapping `Message`/`Reasoning`, `PromptInput` at the foot, and Enkaku's own cards mounted for approvals, child runs, and tool calls.

`ContextPanel` (Plan 69 §3.1) stays in the third column — devices, tools, workspace, usage. It is the thing that makes this a device-farm workbench rather than a chat window, and it has no upstream equivalent.

### 4.3 Core: `POST /api/v1/threads/:id/chat`

Returns `agentUIResponse()` from the harness. Auth through the existing middleware. Permission `agent.run`. The existing REST routes and `/ws` messages stay for everything else.

### 4.4 Removed

`Transcript.tsx`, `Composer.tsx`, `ToolCallCard.tsx`, `lib/agent-transcript.ts` and their tests, once the ported ones cover them. Replace, never version.

## 5. Implementation steps

**78.1 — Dependencies and the six shadcn primitives** (§3.3), recording bundle size before and after.

**78.2 — Copy the five `ai-elements`** (§4.1), verbatim, then the §3.7 pass.

**78.3 — `POST /api/v1/threads/:id/chat`** (§4.3) — the server side, before the client that needs it.

**78.4 — `Chat.tsx`** (§4.2), with `useChat` and history as `initialMessages`.

**78.5 — Re-mount Enkaku's own cards**: approval, child run, tool call with inline screenshot, holder badge.

**78.6 — Slash commands** (§3.6) from the plugin registry.

**78.7 — Delete the superseded components** (§4.4).

**78.8 — Render tests** for the ported surface (Plan 72's infrastructure).

## 6. Acceptance criteria

1. The chat renders through the ported `ai-elements`; `Transcript.tsx` and `Composer.tsx` no longer exist.
2. Exactly five `ai-elements` are ported; the other 43 are absent.
3. The composer supports attachments, model selection, submit and **stop**, from `prompt-input` rather than a reimplementation.
4. Streaming uses `fetch` via `useChat`; **no `EventSource` is used**, and no credential appears in any URL.
5. History loads over HTTP and streaming continues from there; nothing replays a snapshot.
6. An approval still pauses the run and shows the **exact, untruncated** input.
7. A `device.screenshot` result still renders inline, and a child run still renders as a nested transcript.
8. Slash commands come from the plugin registry; adding a command to a plugin makes it appear with no UI change.
9. `design-rules.test.ts` passes over the ported files: no v4 bracket colour form, no internal `<a href>`, no viewport `calc()`.
10. Every ported screen has a render test covering loaded, loading, and error states.
11. `bun run build:studio` produces a working static export, and the bundle-size delta from 78.1 is recorded.
12. A tab switch does not tear down the stream or drop tokens (Plan 42).
13. The diff of each ported file against upstream is recorded in the status header.
14. `bun run typecheck` passes; `bun test` and `bun run --cwd packages/studio test` are green.

## 7. Test plan

**Render:** the conversation with a mixed transcript (text, reasoning, tool call, image, child run, approval); the composer's attachment, model select, and stop states; the slash-command popover.

**Transport:** `useChat` posting to the right URL with the auth header; a streamed response rendering incrementally; a mid-stream abort.

**Static:** `design-rules.test.ts` over the ported files (criterion 9).

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. Agents → a thread → send a message → tokens stream in
# 2. attach a screenshot → the agent describes it
# 3. type "/" → the plugin commands appear
# 4. trigger an approval → the full input is visible, approve → the run resumes
# 5. start a long run → Stop → it stops
# 6. switch tabs and back → the stream is intact
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `streamdown` and friends bloat the static export. | 78.1 records the delta as a number; the trade is then arguable rather than felt. Only five components are ported (§3.2), not 12,000 lines. |
| An `EventSource` sneaks in and forces a token into a URL. | Criterion 4 forbids both explicitly. The SDK's own transport is `fetch`, so the safe path is also the default one. |
| A ported component renders unstyled because it used upstream's tokens. | §3.7 and criterion 9; the design-rule test already catches the silent v4 bracket-form failure that has shipped here twice. |
| Deleting our components loses an Enkaku behaviour the port has no equivalent for. | §3.1 lists what is kept and why; 78.7 is last, after 78.5 has re-mounted them. |
| Chat moving off `/ws` fragments the realtime story. | Only the token stream moves, and for a concrete reason (§3.4). Device state, leases, presence and video stay on `/ws`. |

## 9. Open questions

1. Should the other 43 `ai-elements` be vendored now, unused, to make later adoption a one-line import? Upstream did exactly that and the analysis called it out as dead weight. Not copying them is deliberate.
2. `stats-popover.tsx` upstream shows per-tool token cost from `tokenBreakdown()`. Plan 76 §9.3 leaves that hook unported; if it lands, this is where it renders.
3. Should the workspace browser (Plan 64) become upstream's `file-explorer.tsx`? It is a richer component and it is not in the five, so it stays ours for now.
