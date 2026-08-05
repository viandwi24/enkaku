# Plan 56 — M26 : The UI inspector, so a selector is discovered instead of guessed

> Status: implemented — manual smoke test (§7, a physical device) not verified in this session; see the implementation report for what could and could not be checked without hardware.
> Ships: packages/studio/src/components/InspectorPanel.tsx
> **Depends on:** Plan 06 (the `ui-server` inspector and its `dump`), Plan 05 (the script framework whose selectors this serves), Plan 42 (the device page's tab lifecycle).
> **Spec references:** §7.4 (inspection layer), §11.2 (selectors), §13 (WS contract), §21.
> **Unblocks:** the "recording → script generation" item listed as future work in spec §810.

---

## 0. The gap, as a script author hits it

A script's entire sense of the device is three calls — `find`, `waitFor`, `screenshot` (`packages/session/src/runner/ipc.ts:61-70`). All three take a `Selector`, and a `Selector` is exactly one of `{ id }`, `{ desc }`, `{ text }`, `{ point }`, strict, no combinations (`packages/protocol/src/ui-node.ts:13-17`).

Nothing in the product ever shows what those selectors could be. The device page offers a *choice of inspection engine* (`packages/studio/src/app/device/page.tsx:57`) and reports its status, but there is no view of the UI tree anywhere. So an author writes a selector by guessing at it, publishes a bundle, enqueues a job, and finds out from a `WAITFOR_TIMEOUT` fifteen seconds later — for one selector, on one screen.

Three properties of the matching rules make guessing worse than it sounds, and none of them are visible from the outside:

- `text` and `desc` compare **exactly** after trimming (`packages/drivers/src/inspector/selector.ts:12-13`). `{ text: 'Follow' }` never matches "Following", and nothing says so.
- `matchSelector` is depth-first **first match wins** (`selector.ts:36-42`). A selector matching eight rows silently binds to the topmost one forever.
- `{ point }` never touches the device — it fabricates a synthetic 1×1 node (`selector.ts:19-33`), so it is always truthy. Authors use it as an existence check and it always says yes.

Meanwhile the capability already exists on the device: both inspector engines implement `dump(): Promise<UiNode>` (`packages/protocol/src/driver.ts:114-119`, `packages/drivers/src/inspector/ui-server/index.ts:83`) and return a full tree. It is reachable from nowhere — not from a script, not from the API, not from Studio.

**This plan surfaces what the drivers already produce, and makes the three rules above visible at the moment a selector is chosen rather than discoverable only by failure.**

## 1. Goals

1. A device page tab named **Inspect** shows the UI tree of what the device is displaying, on demand.
2. The tree and the picture beside it come from the same instant — a node's highlight lands where the node actually was.
3. Selecting a node in the tree highlights it on the picture; clicking the picture selects the deepest node under the cursor.
4. For the selected node the panel proposes selectors in the layered order (`id` → `desc` → `text` → `point`) and states, for each, **how many nodes in this tree it matches**.
5. A proposed selector can be run against the live device (`Inspector.find`) before it is put in a script, and the result is shown.
6. A one-click copy produces a paste-ready SDK line (`await ctx.device.tap({ id: 'feed_action' })`).
7. Everything goes through the existing `Inspector` driver interface and the engine registry — an engine lacking a capability reports that fact; it never returns an empty tree that reads like an empty screen.
8. The inspector engine runs only while the tab is attached, and is released when it is not.

## 2. Non-goals

- **Recording gestures into a draft script.** That is the spec §810 item this plan unblocks, not this plan.
- **Acting on a node from the panel** (`setText`, `longClick`, `doubleClick` are already capabilities of `ui-server`). Read and choose here; act in the Control tab. Reconsider once the read path is proven — §9 Q2.
- **New selector kinds.** No xpath, no regex, no multi-key selectors, no `nth`. This plan makes the current rules legible; changing them is its own decision (§9 Q1).
- **Agent-owned (cloud) devices.** `RemoteSessions` exposes `frameSize` and `input` and nothing else (`packages/core/src/server/ws-handlers.ts:135-144`) — there is no remote inspector to call. The tab reports that honestly and stays disabled; the tunnel RPC path (Plan 25) is where it would later be added.
- **A live, continuously updating tree.** §3.3 explains why it is a snapshot.

## 3. Context and design decisions

### 3.1 The tree comes from the driver layer, not from a new device channel

`Inspector.dump()` exists on both shipped engines and is already how the tree is produced. Nothing new goes on the device, no adb command is issued behind the driver's back, and `uiautomator-dump` keeps working exactly as it does for scripts.

That also means the **engine registry decides what is possible**, not this feature: `dump` is a declared capability (`packages/drivers/src/descriptors.ts:45` for `ui-server`, `:77` for `uiautomator-dump`). If a session's engine does not declare it, the panel says which engine is active and what it cannot do — the same honest-degradation rule the network layer follows when it refuses to claim `probe` (`descriptors.ts:92`).

### 3.2 The inspector attaches only while the tab is open

Today the inspector is started lazily and *deliberately never for manual control*, so the adb queue stays free for video (`packages/session/src/session.ts:147-157`). Opening a tree viewer changes that, and the cost has to be paid consciously:

- `ui-server` holds the `instrumentation` lock, and `uiautomator-dump` holds it too and cannot coexist with another instrumentation engine (`descriptors.ts:78`).
- Each engine occupies a slot against `adb.maxConcurrent`, which was already raised to 4 partly for the ui-server inspector (`packages/protocol/src/settings.ts:426`).

So the lifecycle is explicit and ref-counted: `inspect.attach` starts (or joins) the engine, `inspect.detach` releases it when the last viewer leaves, and closing the session releases it regardless. A tab left open in a background window keeps one engine alive — visible in the panel header, not a silent cost.

### 3.3 A snapshot, never a feed

A dump costs from ~100 ms (`ui-server`, the NFR target in spec §16 is under 200 ms for a find) to 1–2 s (`uiautomator-dump`, per its own display name). Polling it would compete with video for the per-device adb queue and would still be stale by the time it rendered.

So: an explicit **Refresh**, a tree stamped with `at` and `tookMs`, its age shown in the header, and any input sent from Studio marks the visible tree stale rather than pretending it still describes the screen. Freshness is stated, never implied.

### 3.4 The picture is the dump's own screenshot, not the live video

The obvious design puts the tree next to the Control tab's live canvas. It is the wrong one, twice over: two canvases decoding the same H.264 stream doubles the work for one picture, and the video is *newer than the tree* — so a highlight computed from `bounds` lands on whatever has scrolled into that rectangle since. That is worse than no highlight, because it looks right.

`screenshot` is a capability of both engines, so the snapshot is taken through the same inspector, next to the dump, and the two travel together. The picture is then frozen and correct, and the panel needs no video subscription at all — which also sidesteps the hidden-canvas throttling the tab lifecycle already has to manage for video (`packages/studio/src/app/device/page.tsx:650-660`).

### 3.5 Selector proposals are ranked, and their ambiguity is stated

Ranking follows the layering the codebase already declares — stable to fragile, `id` → `desc` → `text` → `point`. On top of that, each candidate is **counted against the tree that is on screen**, because the count is the part an author cannot see and cannot guess:

- `1 match` — safe to use.
- `n matches` — labelled as such, with the warning that `find` will always return the first in depth-first order.
- `0 matches` — only possible for a hand-edited selector; shown as a failure, not an empty result.

`{ point }` is offered last and always carries the note that it bypasses the inspector entirely and can never be used as an existence check. Counting happens in Studio from the dumped tree — no extra round trip per candidate.

The `id` candidate must be proposed in the form the engine will actually receive: a short name is expanded by `ui-server` to `resourceIdMatches: .*:id/<escaped>` (`packages/drivers/src/inspector/ui-server/selector.ts:20-25`), while a full `pkg:id/name` is passed through. Both are valid; the panel shows the short form and says what it expands to.

### 3.6 The matching helpers move to `@enkaku/protocol`

Studio has to count matches, and the logic that defines a match lives in `packages/drivers/src/inspector/selector.ts`. Studio must not import `@enkaku/drivers` — that package pulls adb and Bun-side transports into a browser bundle. Duplicating the comparison in Studio would be worse: the one thing this panel promises is that its answer equals what `find` will do.

So `matches`, `matchSelector`, and `centerOf` move into `@enkaku/protocol` (zod-only, no runtime deps, already the home of `SelectorSchema` and `UiNode`), and the drivers import them from there. Per overview §4.3 this is a move with every call site updated in the same commit — no re-export shim.

### 3.7 Reading the screen is a control action

A dump carries whatever is on screen, including text in input fields. It also seizes an instrumentation lock. Both make it a control-grade action, not a `device.view` one: it requires `device.control` and the same manual-lease check the input path performs server-side (`ws-handlers.ts:996-1000`), so the rule is enforced in the core rather than by a disabled button.

Attach and detach are recorded on the device event log's `main` stream (`inspect.attached` / `inspect.detached`) — they change engine state and take a lock, so they belong in the audit trail. Individual dumps are **not** recorded: they are reads, they can happen many times a minute, and the log would drown.

### 3.8 The screenshot rides the existing binary framing

An 1080p PNG base64'd into a JSON WS message is ~2 MB of string to parse on the UI thread, for a picture the browser then has to decode anyway. The binary framing already reserves byte 0 for a channel and states that bytes 0–1 never change meaning (`packages/protocol/src/binary.ts:1-25`), so a new channel is the intended extension point: `CHANNEL.SNAPSHOT = 0x04`, byte 1 carrying the request id that correlates it with the `inspect.tree` message. A REST endpoint was the alternative and was rejected because the whole surface is session-bound, lease-checked, and attach-scoped — splitting one flow across two transports to save a channel byte is not a saving.

## 4. Technical design

### 4.1 Protocol — `packages/protocol/src/messages/inspect.ts`

`UiNode` is currently a bare TypeScript interface (`ui-node.ts:27-39`), which cannot validate a tree arriving over the wire — and the rule is Zod at every boundary. It becomes a schema, with the type inferred from it (recursive, so the annotation is explicit):

```ts
export type UiNode = {
  resourceId: string
  text: string
  desc: string
  className: string
  packageName: string
  bounds: Bounds
  clickable: boolean
  enabled: boolean
  focused: boolean
  index: number
  children: UiNode[]
}

export const UiNodeSchema: z.ZodType<UiNode> = z.lazy(() =>
  z.object({
    resourceId: z.string(),
    text: z.string(),
    desc: z.string(),
    className: z.string(),
    packageName: z.string(),
    bounds: BoundsSchema,
    clickable: z.boolean(),
    enabled: z.boolean(),
    focused: z.boolean(),
    index: z.number().int(),
    children: z.array(UiNodeSchema),
  }),
)
```

Client → server:

```ts
{ type: 'inspect.attach', payload: { deviceId } }
{ type: 'inspect.detach', payload: { deviceId } }
{ type: 'inspect.dump',   payload: { deviceId, requestId: number, screenshot: boolean } }
{ type: 'inspect.find',   payload: { deviceId, requestId: number, selector: Selector } }
```

Server → client:

```ts
{ type: 'inspect.status', payload: {
    deviceId,
    state: 'detached' | 'starting' | 'ready' | 'unavailable',
    engineId: string,
    capabilities: string[],        // from the registry descriptor
    reason?: string,               // why 'unavailable' — always set when it is
} }
{ type: 'inspect.tree', payload: {
    deviceId, requestId, root: UiNode,
    frameSize: { width, height },  // the dump's own geometry, not the video's
    at: number, tookMs: number,
    snapshot: boolean,             // whether a PNG follows on CHANNEL.SNAPSHOT
} }
{ type: 'inspect.match', payload: { deviceId, requestId, node: UiNode | null, tookMs: number } }
```

Both unions in `packages/protocol/src/index.ts:455-536` gain the new members; no message string is written anywhere outside the protocol package.

### 4.2 Core — `packages/core/src/server/ws-handlers.ts`

One `case` block beside the input handlers, following their shape exactly:

1. `deps.leases.checkInputAllowed(deviceId, clientId)` → refuse with the existing coded error when it fails.
2. `deps.remote?.agentIdFor(deviceId)` → if it is an agent device, reply `inspect.status { state: 'unavailable', reason: 'inspection is not available for cloud devices yet' }`. Never a fabricated empty tree.
3. `deps.sessions.get(deviceId)` → `E_DEVICE_NOT_READY` when there is no session, with the same wording the input path uses ("start the stream first").
4. `attach`: `session.whenInspectorReady()`, then read the engine's descriptor from the registry and check `dump` is in its capabilities; broadcast `inspect.status`. Ref-count per device.
5. `dump`: `session.inspector.dump()` under a deadline (default 20 s, `E_INSPECT_TIMEOUT`), optionally `session.inspector.screenshot()`, then the `inspect.tree` message followed by the binary snapshot frame.
6. `find`: `session.inspector.find(selector)` → `inspect.match`.
7. `detach` / socket close / session close: decrement, release on zero.

Errors keep the `{ error: { code, message } }` shape via `sendError`; a driver error is translated, not forwarded raw (design.md, "Writing the words").

### 4.3 Session — `packages/session/src/session.ts`

`whenInspectorReady()` already builds the engine lazily; what is missing is a way to give it back. Add `releaseInspector(): Promise<void>` that calls the handle's existing `release()` and resets `inspector`/`inspectorPromise`, so a later attach starts a fresh one. The comment at `:147-157` is updated: manual control still never starts it *implicitly*; the Inspect tab starts it *explicitly*.

### 4.4 Studio — `packages/studio/src/components/InspectorPanel.tsx`

A new tab in the device page's tab list (`page.tsx:422-438`), keyed `inspect`, href `?tab=inspect`, rendered in a `TabPanel` like the rest.

Layout — two columns above 1024 px, stacked below:

- **Left: the tree.** Collapsible rows, one line each: `className` short name, then the first of `resourceId` / `text` / `desc` that is non-empty, in `.readout` when it is an id. Collapsed past depth 3 by default (a feed dump runs to hundreds of nodes), with a "leaf nodes with text only" filter for finding a label fast.
- **Right: the snapshot** at its natural aspect ratio, with an absolutely positioned highlight rectangle computed from the selected node's `bounds` divided by `frameSize` — the inverse of the normalisation the input path already uses (`packages/protocol/src/messages/input.ts:3-13`). Clicking the picture selects the deepest node whose bounds contain the point.
- **Below the picture: the selector card.** The ranked candidates from §3.5, each with its match count, a **Test on device** button (→ `inspect.find`, result shown as matched/not matched with the returned node's identity), and a copy button producing the SDK line.
- **Header:** engine id, tree age ("taken 12 s ago"), `Refresh`, and — when the tree is stale because input was sent — a marker saying so.

Design system: `PageHeader` is the page's, not the panel's; all three of `LoadingRows` / `EmptyState` / `ErrorState` are handled (`docs/design.md`, screen patterns); measurements use `.readout`; colours are token classes (`bg-surface`, `text-fg-muted`, `border-led-warn`), never the v3 bracket form.

### 4.5 What the panel must never do

- Never show a tree without its age.
- Never render an empty tree as "nothing on screen" — an empty root is an error state naming the engine.
- Never propose a selector without its match count.
- Never present `{ point }` without the note that it is not an existence check.

## 5. Implementation steps

**5.1 Protocol.** `UiNodeSchema` + `BoundsSchema` in `packages/protocol/src/ui-node.ts` (type inferred, old interface removed); `packages/protocol/src/messages/inspect.ts` per §4.1; both unions in `index.ts` extended; `CHANNEL.SNAPSHOT` in `binary.ts` with `encodeSnapshot`/`decodeSnapshot` and the header documented in the same comment block. Unit tests for the recursive schema (a 4-deep tree round-trips; a malformed node is rejected).

**5.2 Move the matchers.** `matches` / `matchSelector` / `centerOf` from `packages/drivers/src/inspector/selector.ts` into `@enkaku/protocol`; update `uiautomator-dump.ts`, `ui-server/index.ts`, and every other call site; delete the old file. Existing tests move with it and must stay green unchanged — that is the proof the behaviour did not shift.

**5.3 Session release.** `releaseInspector()` per §4.3, plus a test that a second `whenInspectorReady()` after a release builds a new engine rather than resolving against a dead handle.

**5.4 Core handler.** §4.2 in `ws-handlers.ts`, with the ref-count in the same module as the other per-device viewer bookkeeping. Tests: lease refusal, no-session refusal, agent-device refusal, capability-missing refusal, ref-count reaching zero releases exactly once, socket close releases.

**5.5 Event log.** `inspect.attached` / `inspect.detached` added to `MAIN_EVENT_KINDS` (`packages/protocol/src/messages/device-event.ts:15-40`) with their meta documented; recorded in the handler; never one per dump.

**5.6 Selector analysis.** A pure module (`packages/protocol/src/selector-analysis.ts`): `countMatches(root, sel)` and `proposeSelectors(root, node)` returning ranked candidates with counts and per-candidate notes. Heavily unit-tested — this is the module the whole feature's credibility rests on.

**5.7 Studio panel.** §4.4. The WS plumbing reuses the device page's existing socket; no second connection.

**5.8 Tab.** Register `inspect` in the tab list, keep `?tab=` routing, and disable the tab with a stated reason for agent-owned devices.

**5.9 Docs.** `packages/drivers/README.md` gains the inspection-capability note; `docs/guide/` gets a short "finding a selector" section that walks the loop dump → pick → test → copy → paste into `defineScript`. Overview DoD item 4 requires it.

## 6. Acceptance criteria

1. With a local device streaming and a manual lease held, the Inspect tab shows a tree of the current screen and a snapshot taken at the same moment.
2. Selecting a node highlights the correct region of the snapshot; clicking a region selects the deepest node containing it.
3. Every proposed selector carries a match count computed against the shown tree, and a selector matching more than one node says so.
4. **Test on device** runs a real `find` and reports the outcome, including the not-found case.
5. Copy produces a line that pastes into a script unchanged and works.
6. Without the lease, or on a device with no session, the tab refuses with a coded error explaining what to do — not an empty tree.
7. On an agent-owned device the tab is disabled and names the reason.
8. The inspector engine is running only while at least one Inspect tab is attached; `inspect.attached` / `inspect.detached` appear in the device event log; closing the browser tab releases the engine.
9. A dump that exceeds its deadline reports `E_INSPECT_TIMEOUT`; an engine without the `dump` capability reports unavailable naming the engine.
10. No message type string exists outside `packages/protocol`; nothing crossing the WS is `as`-cast; `bun run typecheck` clean and `bun test` green.

## 7. Test plan

**Unit**
- `UiNodeSchema` — deep tree round-trip, rejection of a node with a missing field, `children` defaulting behaviour.
- `countMatches` / `proposeSelectors` — a tree with eight identical `text` nodes proposes `text` with count 8; a node with a unique `resourceId` ranks `id` first with count 1; a node with nothing but bounds falls through to `{ point }` with its note; the short-id form is reported alongside its `resourceIdMatches` expansion.
- Moved matchers — the existing `selector` tests pass byte-identical after the move.
- Handler — the five refusal paths, ref-counting, release-on-close.
- Binary — `encodeSnapshot`/`decodeSnapshot` round-trip and a channel byte that never collides with VIDEO/AUDIO/CONTROL.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, one device connected)**

```bash
bun run dev                      # core on :7700
bun run dev:studio               # Studio on :3001
# 1. open http://localhost:3001/device?id=<id>, take control, start the stream
# 2. open the Inspect tab → tree + snapshot appear; header names the engine
# 3. on the device, open Settings → Apps; press Refresh → the tree changes
# 4. select a list row → highlight lands on that row
# 5. click a row on the snapshot → the same node is selected in the tree
# 6. Test on device on the ranked `id` candidate → matched
# 7. edit the device screen so the node disappears, Test again → not matched
# 8. close the tab → `inspect.detached` in the device event log
bash scripts/check-plan-status.sh
ps -Ao pid=,command= | grep -i "[o]penpf"   # nothing left behind (overview DoD 7)
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The instrumentation lock starves video or a queued job | Attach only while the tab is open, ref-counted, released on close (§3.2); the header shows the engine is running |
| A huge tree (1000+ nodes) freezes the panel | Collapsed past depth 3, text-leaf filter, rows rendered from a flattened list (§4.4) |
| Highlight drifts because the picture is newer than the tree | The picture comes from the same dump, not the video (§3.4) |
| The panel's match count disagrees with what `find` does | Studio and the drivers run the *same* moved matcher — divergence is impossible by construction (§3.6) |
| Compose / WebView screens expose no ids | Not a defect to hide: empty fields render as empty, and the ranking falls through to `desc`, then `text`, then `point` with its warning |
| Screen content (passwords, tokens) reaches a viewer who should not see it | `device.control` plus the manual-lease check, enforced server-side (§3.7) |
| The tab becomes a second, silent video subscription | It has no video subscription at all (§3.4) |

## 9. Open questions

1. **Should an `nth` / index selector exist?** It is the honest answer to "this matches eight nodes", and the panel will make that ambiguity visible many times a day. But it adds a selector kind to a union deliberately kept at four, and an index is the most fragile locator of all. Needs a decision before the panel starts recommending workarounds.
2. **Should the panel act on a node** (`setText`, `longClick`, `doubleClick` are already `ui-server` capabilities)? It would shorten the write-test loop considerably, and it would also turn a read-only tool into a control surface with its own permission story.
3. **Should the tree push on change rather than on Refresh?** The on-device ui-server could in principle emit accessibility events. That is a Plan 06 change with real cost, and §3.3's snapshot model exists precisely because nobody has measured it.
4. **Cloud parity.** Inspecting an agent-owned device means an `Inspector` RPC over the Plan 25 tunnel. Worth it now, or after the local loop has proven the design?
5. **Where does a discovered selector go?** Copy-paste is the honest MVP. A "selector library" per app, saved on the farm, is the obvious next thing to want — and the obvious thing to build badly if it is added as an afterthought here.
