# Plan 83 — M48 : The Chat Has to Actually Work

> Status: implemented — **§9 Q1 answered, and it is NOT any of the four ranked candidates**: `packages/core/src/api/agent-chat-stream.http.test.ts` boots a REAL `Bun.serve` on an ephemeral port over the real, unmodified `createThreadRoutes`/`createAgentRunner`/`createAgentWsHandler` (the fake-provider seam, per the hard constraint — no real Anthropic/OpenRouter call anywhere in this plan), and reads the response with a genuine `fetch()` + `ReadableStream` reader. Two independent reproductions (this test file, and a second, throwaway one during investigation that drove the ACTUAL `DefaultChatTransport.sendMessages()` + `readUIMessageStream()` — the exact functions `useChat` calls internally — against the same live server) both show: `data-runStarted` arrives in single-digit-to-low-double-digit milliseconds; a tool call's `started`/`finished` `data-toolCall` chunks are separated by exactly the REAL multi-second `setTimeout` inside the capability handler (not a scripted delay — genuine wall-clock proof nothing buffers until the run ends); zero dropped chunks; zero client-side parse errors. Candidates 1 (never flushes), 3 (relay never receives), and 4 (schema rejection drops chunks) are FALSIFIED outright. Candidate 2 ("`useChat` errors discarded") is also not the literal cause — nothing errors in a healthy run — but investigating it surfaced a REAL, narrower defect at the same layer: `createUIMessageStream`'s default `onError` (`() => 'An error occurred.'`, a deliberate redaction) swallowed the ONE case this bridge can throw before any run exists — `opts.start()` (`runner.postMessage`) rejecting synchronously (`E_AGENT_DISABLED`, `agent_not_found`, `E_BAD_REQUEST`; connector/credential failures are async inside `launch()` and already surface via `run.errorClass`, untouched) — turning an already-safe, actionable `EnkakuError` message into a useless generic string. Fixed with `agent-chat-stream.ts`'s new `chatStreamErrorText` (wired as `onError`), which passes an `EnkakuError`'s own `.message` through unchanged and keeps the generic redaction for anything else (nothing new leaked). This is the plan's genuine RED→GREEN pair, verified BY HAND (`git stash` the fix, rerun, watch it fail with `Received: "An error occurred."` against `Expected: "this agent is disabled"`; `git stash pop`, rerun, green) — recorded in the test file's own comment rather than only here. **The real, demonstrated cause of "the chat looks dead" is exactly §3.2 + §3.3, both already correctly diagnosed from code alone before any HTTP reproduction**: the composer held the typed text hostage for the WHOLE turn (`await sendMessage(...)`), and a transport-level failure (bad URL, network drop, non-2xx, the redacted error above) had zero visible surface — together, a user who hit either one saw a frozen textbox and nothing else, which reads as "dead" even though the wire protocol itself streams correctly.
>
> **Streaming (criteria 1-5), all proven at `agent-chat-stream.http.test.ts`**: criterion 1 (TTFB <1s) PASS; criteria 2-4 (text/thinking/tool-call visible before the run ends) PASS — asserted with a REAL 2.5s capability delay, not a scripted one, so the test cannot pass by accident; criterion 5 (live stream matches the persisted `GET .../messages` transcript byte-for-byte) PASS.
>
> **Failure is visible (criteria 6-8)**: `Chat.tsx` gained `onError` (writes `streamError`), a `ChatError` banner above the composer naming the failure with a **Retry** that re-sends `lastUserMessage` through the same non-awaited `sendMessage` path (criteria 6, 7 — PASS, `Chat.test.tsx`'s new case drives a real failed POST through `renderWithApi`'s `raw` Response extension — see below — and clicks Retry, asserting a second POST). The four `.catch(() => undefined)` swallows (slash commands, farm defaults, the model list, the run tree) are unswallowed: three surface through a shared low-emphasis `backgroundError` note, and the model list gets its OWN `modelsError` state (criterion 8 — PASS, `ModelCombobox.test.tsx`'s dedicated case) because an empty dropdown and a FAILED fetch are different, false-if-conflated claims.
>
> **Composer (criteria 9-11)**: `submit` now awaits only the attachment upload, then fires `sendMessage` without awaiting it (criterion 9 — PASS, proven with a chat POST mock that NEVER resolves: the composer still clears, because clearing was never waiting on it). Criterion 10 (an upload failure keeps the text) PASS by construction — `PromptInput`'s own async-path `catch` (`prompt-input.tsx`, unedited) already does not clear on a thrown `onSubmit`, and `submit`'s upload loop was already un-caught; a new `Chat.test.tsx` case exercises this through a real `user.upload()` + failed `POST /api/v1/blobs` mock. Criterion 11 (placeholder top-left, stays there as the box grows) — the fix is `className="min-h-11 items-start"` on `Chat.tsx`'s OWN `<PromptInputTextarea>` call site (NOT `textarea.tsx`, NOT `prompt-input.tsx` — §3.4's own scoping), `cn`/`tailwind-merge` overriding the shared `min-h-16`; **visual, verified by reading the resulting computed classes and the CSS (`items-start` un-centres a `display:flex` textarea's content, a real, documented cross-browser quirk), NOT by a live screenshot** — no live `bun run dev`/`dev:studio` browser session was run (see "not done" below), recorded as the plan's own §7 anticipated this exact limitation.
>
> **Model selector (criteria 12-13)**: `components/agent/ModelCombobox.tsx`, new — `Popover` + `components/ui/command` (both already in the repo, plan 78), NOT a hand-rolled dropdown. `ModelCombobox.test.tsx` (6 cases) drives real `@testing-library/user-event` keyboard events (typing, Enter, Escape) against the rendered `cmdk` list, per the plan's own test-plan instruction not to call handlers directly — PASS on both criteria, including the retired-model case (13).
>
> **Threads (criteria 14-17)**: `ThreadStore.deleteThread` (new) — one `db.transaction()` deleting `agentApprovals`/`agentInbox` (by run id) then `agentMessages`/`agentRuns`/`agentThreads`, refusing (`E_THREAD_RUN_ACTIVE`, mapped to HTTP 409) while any run is `queued`/`running`/`paused`; blobs untouched (§3.6). `DELETE /api/v1/threads/:id` and a new read-only `GET .../delete-preview` (so the confirm dialog can name real counts BEFORE the operator commits, criterion 16) — both new protocol schemas (`ThreadCountsSchema`, `ThreadDeletePreviewResponseSchema`, `ThreadDeleteResponseSchema`) and a new audit action `agent.thread.delete`. `ThreadList.tsx` gained a per-row overflow menu (`components/ui/dropdown-menu`, new to this file) wired to a CONTROLLED `ConfirmDialog` (that component gained optional `open`/`onOpenChange` props, backward-compatible for its 9 other call sites) — controlled, rather than `ConfirmDialog`'s own `trigger`-nested `AlertDialogTrigger`, because Radix closes a `DropdownMenu` the instant an item is selected, which would unmount a trigger-nested dialog before it ever showed (found the hard way, by a failing render test, not assumed). `thread/store.test.ts` (+3: cascade, active-run refusal, `countsForThread`), `api/threads.test.ts` (new file, 4 cases: preview counts, delete + audit, 409 refusal + survives, 404), `ThreadList.test.tsx` (new, 3 cases). All 17-14 PASS.
>
> **Bulk selection (criteria 18-20)**: `hooks/use-bulk-selection.ts` — `{allChecked, someChecked, groupState, toggleAll, toggleGroup}`, deliberately not a hook that owns state (no `useState` inside it — `selected`/`setSelected` stay wherever the caller's draft already lives), so `toggleAll`/`toggleGroup` each call `setSelected` exactly ONCE (criterion 20 — proven in `use-bulk-selection.test.ts`, 7 cases, by counting `setSelected` calls, not just checking the final value). Wired into `agents/detail/page.tsx`'s `ToolsSection` (a tri-state `TriStateCheckbox`, new, per group — the registry's own prefix grouping — plus a section-level Select all/Clear all) and `AccessSection`'s device-grants list (Select all/Clear all; devices have no natural grouping) and permissions list (grouped by the SAME dot-prefix `capabilityGroup` tools already use). `TriStateCheckbox` sets the native `.indeterminate` DOM PROPERTY via a ref (no HTML attribute exists for it). 3 new render cases in `agents/detail/page.test.tsx` drive real clicks against the tri-state header and the section button. All 18-20 PASS.
>
> **`ai-elements` files touched: NONE.** `grep -rn` across every file this plan changed confirms `packages/studio/src/components/ai-elements/{conversation,message,prompt-input,reasoning,shimmer}.tsx` are byte-identical to their plan-78 state — every composer fix (placeholder alignment, the model selector swap) lives in `Chat.tsx`'s own call sites and a new sibling component, exactly as §2/§3.4's own scoping required.
>
> **Test infrastructure changed (Enkaku's own, not `ai-elements`)**: `lib/test/render.tsx`'s `MockResult` gained an optional `raw?: Response` — the only way to mock a non-JSON body (a failed/never-resolving chat POST); a genuine SSE-`ReadableStream`-bodied mock `Response` was ATTEMPTED for a criterion-9 test and hit a real happy-dom/Bun stream-interop wall ("readable should be ReadableStream" — happy-dom's own `Response`/`ReadableStream` do not interoperate with Bun's native `TextDecoderStream`/`pipeThrough`), so that specific case was redesigned around a never-resolving `Promise` mock instead, which proves the same claim (clearing does not wait on the network call) without needing a working streamed body — recorded as a real, hit environment limitation, not silently worked around.
>
> `bun run typecheck` — OK across all 12 packages. Root `bun test` — 2420 pass / 0 fail (baseline 2409 + 11 net new: `agent-chat-stream.http.test.ts` ×4, `api/threads.test.ts` ×4 new file, `agent/thread/store.test.ts` ×3). `bun run --cwd packages/studio test` — 334 pass / 0 fail (baseline 312 + 22 net new: `Chat.test.tsx` ×3, `ModelCombobox.test.tsx` ×6 new file, `hooks/use-bulk-selection.test.ts` ×7 new file, `ThreadList.test.tsx` ×3 new file, `agents/detail/page.test.tsx` ×3). `bash scripts/check-harness-provenance.sh` exits 0 (`packages/harness/src` untouched). `bash scripts/check-plan-status.sh` exits 0 once this line moved off `draft`.
>
> **Not done, recorded rather than silently dropped**: (1) No live `bun run dev`/`dev:studio` browser session — matching every prior plan in this series' own recorded limitation (no Anthropic/OpenRouter credential in this environment, and the hard constraint forbids a real provider call even with one). Criterion 11 (the visual placeholder fix) is therefore verified by reading the resulting CSS/classes, not a screenshot, exactly as §7 anticipated. (2) A genuine SSE-streamed-body Chat.tsx render test (criterion 9 as LITERALLY "while the reply is still streaming") — replaced with an equally-valid never-resolving-Promise variant per the happy-dom/Bun stream limitation above. (3) §9 Q2 (auto-retry) and Q3 (soft-delete) were left open, as the plan's own §9 already flags them as human decisions, not something this pass should decide unilaterally.
> Ships: packages/core/src/api/agent-chat-stream.http.test.ts
> Depends on: Plan 76 (the harness loop that emits the events), Plan 78 (the `ai-elements` composer and the `useChat` transport this repairs).

---

## 1. Goals

- A message sent in the agent chat produces a visibly streaming reply — text and thinking appearing as they arrive, not after a page refresh.
- When the stream fails, the operator is told, in the chat, immediately.
- The composer clears when the message is sent, not when the agent has finished answering.
- The placeholder sits where a placeholder sits.
- The model selector is searchable and keyboard-navigable.
- A thread can be deleted.
- A list of tools, devices, or permissions can be selected and cleared in bulk.

## 2. Non-goals

- Redesigning the transport. `useChat` over `fetch` against `/threads/:id/chat` is the Plan 78 decision and stands; this plan makes it deliver.
- Changing the run machinery. `runner.postMessage`, approvals, the lease, the tree budget are all correct and untouched — the reply *is* produced and persisted today.
- Rewriting the ported `ai-elements`. Fixes go in Enkaku's own wrappers and styles wherever possible, so a later re-port does not collide.
- New agent features.

## 3. Context and design decisions

### 3.1 The suite is green and the feature is dead — that is the finding

`bun test packages/core/src/agent packages/core/src/api/threads.test.ts` is **291 pass / 0 fail**, and `agent-chat-stream.test.ts` alone is **11 pass / 0 fail** covering exactly the bridge that is not working. The server chain reads correctly end to end: `streamText` → `fullStream` → `deps.emit({type:'delta'})` (`harness/run.ts:473`) → `agentWs.publish` → the relay socket (`agent-chat-stream.ts`'s `createRelayWs`) → `writer.write({type:'text-delta'})`.

So the defect is in a layer **no test exercises**: the real HTTP response — a genuine `POST`, over a socket, through `createUIMessageStreamResponse`, consumed by a real `DefaultChatTransport`. Every existing test calls `createAgentChatStream` as a function and reads the stream object in-process. That proves the mapping from events to chunks. It cannot prove that a single byte reaches a client before the run ends, which is precisely what is failing.

That gap is why this plan **Ships** an HTTP-level test rather than a fix: the fix is worthless if the same class of bug can return unseen.

The live reproduction could not be completed while writing this plan — the core was not running (`nothing listening on 7700`), and the browser extension was disconnected. The candidate causes below are therefore ranked from code, and **step 1 is to reproduce over real HTTP and identify which**, rather than to guess:

1. **The response never flushes incrementally.** `data-runStarted` is written synchronously, before any provider call (`agent-chat-stream.ts:278`). If a client does not see that chunk within milliseconds of the POST, nothing downstream matters and the cause is transport-side.
2. **`useChat` errors and the error is discarded.** See §3.3 — nothing in `Chat.tsx` reads `chat.error` or sets `onError`, so a rejected stream is indistinguishable from a slow one.
3. **The relay subscription never receives.** `subscribe(relayWs, threadId)` takes a duck-typed socket; if `publish` ever filters by something a real connection has and the relay does not, events go nowhere. The unit test would not catch it because it uses the same duck type.
4. **A schema rejection drops the chunks silently.** `ws.ts` already logs dropped `ServerMessage`s in dev; the relay path parses the same JSON and has no such log.

Whichever it is, the test in §7 must fail before the fix and pass after — asserted on **time-to-first-byte**, not only on final content, because "the reply arrived eventually" is exactly what already happens.

### 3.2 The composer's stuck text is the same bug wearing a different hat

This one is provable from code alone, and it is not a styling slip.

`PromptInput` clears its input **only after `onSubmit` resolves** (`prompt-input.tsx:885–904`: on the async path it awaits, then `clear()`, and the `catch` deliberately does not clear so a user can retry). `Chat.tsx`'s `submit` is:

```ts
const submit = async (message: PromptInputMessage) => {
  …upload attachments…
  await sendMessage({ text: message.text }, { body: { attachments: attachmentIds } })
}
```

`sendMessage` resolves when the **stream completes** — that is, when the agent has finished its whole turn. So even on a fully healthy run the typed text sits in the box for the entire reply, and on a failed stream it never clears at all.

The decision: `submit` awaits only what must happen before the send — the attachment uploads — and then fires the send without awaiting it. The composer clears immediately, which is what every chat interface does and what the user is comparing against. Errors surface through §3.3, which is the right channel for them; keeping the text hostage is not an error-reporting mechanism.

This also means the "input did not clear" symptom stops being a diagnostic. That is a real loss, and §3.3 is what replaces it with something better.

### 3.3 A failed stream currently says nothing at all

`Chat.tsx` never sets `useChat`'s `onError` and never renders `chat.error`. A stream that rejects therefore leaves the UI in exactly the state a slow one does: no reply, no spinner change, no message. Everything else in this plan is cosmetic next to that, because it is what turned "the stream is broken" into "I waited, I don't know how long, and then I refreshed".

The chat gains, at the bottom of the conversation and above the composer:

- a **failed** state carrying the error text and a **Retry** that re-sends the last user message;
- a distinction between *submitted* (request sent, nothing back yet), *streaming* (bytes arriving), and *failed*, since the first two are what the user could not tell apart.

The same treatment applies to the four `.catch(() => undefined)` swallows in `Chat.tsx` (commands, farm defaults, models): a model list that failed to load should not present as an empty dropdown.

### 3.4 The placeholder is centred because the textarea is a flex box

`components/ui/textarea.tsx` sets `flex field-sizing-content min-h-16 … py-2`; `InputGroupTextarea` adds `py-3`. A single line of placeholder text inside a `min-h-16` (4 rem) box renders vertically centred rather than at the top, which is what makes the composer look wrong before anything is typed.

The fix belongs in the composer's own wrapper, not in the shared `Textarea` — that base is used by other forms where a taller default is fine, and changing it would move text in screens nobody complained about. `PromptInputTextarea` gets an explicit top alignment and a min height chosen for one line of text.

### 3.5 The model selector is a plain `<Select>` over a `.map()`

`Chat.tsx:369–381` renders `PromptInputSelect` with `[...new Set([resolved.model, ...models])].map(...)`. A connector can return dozens of model ids; a native select over that is a scroll hunt, and typing does nothing useful.

It becomes a combobox: a text filter, arrow-key navigation, Enter to choose, Escape to dismiss, filtering on the id. `components/ui/command` is already in the repo and is the right primitive. The **effort** selector beside it stays a plain select — three options do not need a search box, and giving them one would be worse.

### 3.6 Deleting a thread does not exist anywhere

`api/threads.ts` has no `DELETE` route, and `ThreadList.tsx` has no delete affordance. This is not a UI omission; the capability was never built.

Deleting a thread must take its runs, its messages, its approvals, and its tree nodes with it, in one transaction — the same discipline `device/lifecycle.ts` already applies to a forgotten device, and for the same reason: a half-deleted thread leaves rows pointing at a parent that is gone.

Two decisions worth stating:

- **A thread with a running run is refused**, not force-killed. Cancel first, then delete. A delete that silently aborts an agent mid-tool-call is the kind of surprise that costs an operator a device left in a strange state.
- **Blobs are not deleted.** Plan 70's blobs are content-addressed and can be shared across threads; deleting them here would break another thread's transcript. They are the retention GC's problem, not this one.

### 3.7 Bulk selection, where lists are long enough to need it

`ToolsSection` (`agents/detail/page.tsx:611–660`) renders one raw `<input type="checkbox">` per capability with a per-id `toggle`. The registry is already **grouped by prefix**, so the natural unit is the group. Device grants and permissions have the same shape and the same absence.

Each group header gets a tri-state checkbox — checked, unchecked, or indeterminate when partially selected — that selects or clears the whole group, plus a **Select all** / **Clear all** for the section. Nothing else in Studio has a select-all today, so this plan sets the pattern: a small `useBulkSelection` helper rather than three hand-rolled copies that drift.

## 4. Technical design

### 4.1 `packages/core/src/api/agent-chat-stream.http.test.ts`

The artefact that proves the plan. It boots a real core over an ephemeral port with the **fake provider** (`agent/provider/fake.ts` already drives the same `streamText` path, so no credits are spent), POSTs to `/api/v1/threads/:id/chat`, and reads the response body as a stream:

```ts
const res = await fetch(url, { method: 'POST', body: JSON.stringify({ text: 'hi', attachments: [] }) })
const reader = res.body!.getReader()
const t0 = performance.now()
const first = await reader.read()          // must not wait for the run
expect(performance.now() - t0).toBeLessThan(1_000)
expect(decode(first.value)).toContain('data-runStarted')
```

Time-to-first-byte is the assertion that matters. A test that only checks the final transcript passes today.

### 4.2 Client changes (`packages/studio/src/components/agent/Chat.tsx`)

```ts
const chat = useChat<AgentChatUIMessage>({
  transport,
  onError: (err) => setStreamError(err instanceof Error ? err.message : String(err)),
})

const submit = async (message: PromptInputMessage) => {
  const attachmentIds = await uploadAll(message.files)   // must finish before the send
  setStreamError(null)
  void sendMessage({ text: message.text }, { body: { attachments: attachmentIds } })
}                                                        // NOT awaited — §3.2
```

`lastUserMessage` is retained so Retry can re-send it.

### 4.3 `DELETE /api/v1/threads/:id`

```ts
app.delete('/threads/:id', requirePermission('agent.run'), (c) => {
  const id = c.req.param('id')
  const summary = threads.deleteThread(id)     // refuses while a run is active
  audit.record({ userId, action: 'agent.thread.delete', target: id, meta: summary })
  return typedJson(c, ThreadDeleteResponseSchema, summary)
})
```

`deleteThread` runs one transaction over runs, messages, approvals, and tree nodes, returning the counts so the confirm dialog can state them. New audit action `agent.thread.delete` in `auth/audit.ts`.

### 4.4 Studio pieces

- `components/agent/ModelCombobox.tsx` — search + keyboard, over `components/ui/command`.
- `components/agent/ThreadList.tsx` — a per-row menu with Delete and a confirm naming the counts.
- `hooks/use-bulk-selection.ts` — `{ allChecked, someChecked, toggleAll, toggleGroup }`, used by tools, devices, and permissions.
- `PromptInputTextarea` wrapper — top-aligned, one-line min height.
- A `ChatError` block above the composer.

## 5. Implementation steps

1. **Reproduce over real HTTP** with the core running and the fake provider; record which of §3.1's four causes it is, in this plan's status line. Nothing else starts until this is known.
2. `agent-chat-stream.http.test.ts` — failing first.
3. Fix the cause found in step 1.
4. `onError` + `chat.error` rendering + Retry; unswallow the four `.catch(() => undefined)`.
5. `submit` stops awaiting `sendMessage`.
6. Placeholder alignment in the composer wrapper.
7. `ModelCombobox`.
8. `deleteThread` + route + audit action + `ThreadDeleteResponseSchema`.
9. `ThreadList` delete affordance and confirm.
10. `use-bulk-selection` + wire into Tools, Devices, Permissions.

## 6. Acceptance criteria

**Streaming**
1. A POST to `/threads/:id/chat` returns its first chunk in under a second, before the model has answered — asserted on time-to-first-byte against a real HTTP server.
2. Text deltas reach the client while the run is still in progress; the transcript grows without a refresh.
3. Thinking deltas stream the same way and are visibly distinct from text.
4. A tool call appears as it starts, not only when it finishes.
5. After the run finishes, a manual refresh shows the same transcript the stream produced — no divergence between live and persisted.

**Failure is visible**
6. A stream that fails mid-run shows an error in the chat naming the failure, within a second of the failure.
7. Retry re-sends the last user message and succeeds where the original failed.
8. A models fetch that fails shows that it failed, rather than an empty dropdown.

**Composer**
9. The composer clears the instant a message is sent, while the reply is still streaming.
10. Sending with an attachment clears only after the upload has succeeded, and keeps the text if the upload fails.
11. The placeholder renders at the top-left of the composer, and stays there as the box grows.

**Model selector**
12. Typing filters the model list; ArrowUp/ArrowDown move the highlight; Enter selects; Escape closes and changes nothing.
13. The current model is shown and pre-highlighted when the list opens, even if the connector no longer lists it.

**Threads**
14. A thread can be deleted; it disappears from the list and its messages, runs, approvals, and tree nodes are gone.
15. Deleting a thread with an active run is refused with a named error, and the thread survives intact.
16. The confirm names how many messages and runs will be deleted.
17. Blobs referenced by a deleted thread survive (§3.6).

**Bulk selection**
18. A group header selects and clears its whole group.
19. A partially selected group renders indeterminate, not unchecked.
20. Select all / Clear all covers the section, and the change is one draft update, not N.

## 7. Test plan

The centrepiece is §4.1's HTTP test, which **must be demonstrated failing before the fix**. A fix without that demonstration has not been shown to address the reported problem — the existing 11 in-process tests already pass while the feature is broken, and this plan exists because of that.

Criteria 2–4 extend it: drive the fake provider to emit text, thinking, and a tool call, and assert each reaches the reader **before** the response closes.

Studio: `Chat.test.tsx` gains cases for the error surface (6, 7), for clearing on send while `status === 'streaming'` (9), and for the failed-upload path (10). `ModelCombobox.test.tsx` covers filtering and keyboard (12, 13) through `@testing-library` keyboard events, not by calling handlers directly. `use-bulk-selection.test.ts` covers the indeterminate rule (19).

Thread deletion gets `thread/store.test.ts` cases for the cascade and the active-run refusal, plus an `api/threads.test.ts` case for the route.

Criterion 11 is visual and cannot be asserted in `happy-dom`; it is verified by screenshot against a running Studio and recorded in the status line.

## 8. Risks and mitigations

- **Step 1 finds a cause outside this plan's scope** (a Bun or AI SDK bug). Mitigation: the plan's shape survives it — the HTTP test, the error surface, and every UI item stand regardless; the status line records what was actually found rather than being edited to match.
- **Not awaiting `sendMessage` hides a real failure.** Mitigation: §3.3 lands *before* §3.2 in the implementation order, so the error surface exists before the diagnostic it replaces is removed.
- **Fixing the shared `Textarea` moves text elsewhere.** Mitigation: the change is scoped to the composer's own wrapper (§3.4).
- **Thread deletion loses work an operator wanted.** Mitigation: counts in the confirm; refusal while running; blobs preserved. No undo, consistent with Forget.
- **A re-port of `ai-elements` overwrites these fixes.** Mitigation: every change lives in Enkaku wrappers or Enkaku files; `prompt-input.tsx` itself is not edited.

## 9. Open questions

1. ~~**Why the stream did not reach the browser.**~~ **Answered.** It does — the byte-level and AI-SDK-client-level pipeline both stream correctly and quickly, proven twice over real HTTP (§4.1's shipped test, plus a second throwaway reproduction using the real client transport during investigation). None of the four ranked candidates is the cause. The actual, demonstrated defect is exactly §3.2 (the composer holds text hostage for the whole turn) plus §3.3 (a transport failure has zero visible surface) — both already correctly diagnosed from code alone before any HTTP work started. See the status line for the full account, including the one real bridge-layer bug (a redacted error message) found while investigating candidate 2.
2. **Should a failed stream auto-retry once?** A transient provider hiccup is common and a silent single retry would hide it. Left manual until the failure rate is known.
3. **Should deleting a thread be soft?** Runs carry usage and cost history that an operator may want after the conversation is gone. A `deleted_at` instead of a hard delete is plausible; not chosen here because nothing yet reports on historical spend per thread.
4. **Does anything else in Studio consume a stream over HTTP?** If not, the HTTP-level test pattern from §4.1 has exactly one caller and stays a one-off; if the workbench grows another, it should become a shared helper.
