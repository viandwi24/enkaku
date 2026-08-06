# Plan 83 — M48 : The Chat Has to Actually Work

> Status: draft
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

1. **Why the stream did not reach the browser.** Deliberately unresolved — the core was not running while this plan was written, and naming a cause without reproducing it is how the wrong thing gets fixed. Step 1 answers it and this line gets replaced with the answer.
2. **Should a failed stream auto-retry once?** A transient provider hiccup is common and a silent single retry would hide it. Left manual until the failure rate is known.
3. **Should deleting a thread be soft?** Runs carry usage and cost history that an operator may want after the conversation is gone. A `deleted_at` instead of a hard delete is plausible; not chosen here because nothing yet reports on historical spend per thread.
4. **Does anything else in Studio consume a stream over HTTP?** If not, the HTTP-level test pattern from §4.1 has exactly one caller and stays a one-off; if the workbench grows another, it should become a shared helper.
