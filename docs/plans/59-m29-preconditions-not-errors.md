# Plan 59 — M29 : A precondition is not a failure

> Status: implemented — steps 59.1–59.6. The manual smoke in §7 is the operator's and is not done; `bun run build:studio` is unverified — the guard refused while a dev server held :3001.
> Ships: packages/studio/src/components/InspectorPanel.test.tsx
> Depends on: Plan 56 (`56-m26-ui-inspector-devtools.md` — the inspector and its lease rule), Plan 57 (the screen card's `Live | Inspect` modes), Plan 42 (hidden, never unmounted).
> Spec references: §10.1 (server-authoritative), §10.2 (leases), `docs/design.md` (writing rules).

---

## 1. Goals

- A screen that needs something first **says what it needs**, and offers it, instead of reporting a red failure.
- Taking control makes the inspector work **immediately** — no tab-switch dance to unstick it.
- Switching `Live ⇄ Inspect` stops paying a cold start every time.
- A refresh that finds nothing changed costs nothing — no state write, no re-render.
- An **offline** device can still be opened and read. Only the things that genuinely need a live phone are disabled.

## 2. Non-goals

- Removing the inspector's lease requirement. §3.1 explains why it stays.
- Making a dump cheaper. It costs 334–584 ms measured on hardware; this plan stops paying it *unnecessarily*, it does not make it faster.
- Reworking the inspector's tree, selectors, or snapshot (plan 56 owns those).
- A general "offline mode". This is about not locking doors that were never locked for a reason.

## 3. Context and design decisions

### 3.1 The lease stays; the red box goes

Selecting `Inspect` without a lease renders:

> **Could not load** — take control (lease.acquire) before sending input

Nothing failed. The operator simply has not taken control yet, and the panel is describing an ordinary precondition in the vocabulary of a crash — warning icon, danger border, "Could not load". Worse, the message is the *server's* wording for the input path (`lease-manager.ts:150`), leaking `lease.acquire` — an internal message name — into an operator's face.

**The requirement itself is correct and stays.** Plan 56 §3.7: a dump carries whatever is on screen, *including text in input fields*, and it seizes the instrumentation lock. "Read-only" is misleading — reading someone's screen is not a passive act, and it is the same reasoning that stops the input log from storing typed text in the clear.

So the fix is presentational, and it is not a smaller red box: the panel shows a calm state that names the precondition and offers it — a **Take control** button in the panel itself. The operator's next action is one click away from where they discovered they needed it.

The same rule applies wherever else a precondition currently reads as a failure. A refusal from the server is still shown as an error; a precondition the operator can satisfy is not.

### 3.2 The panel does not notice that control was taken

`InspectorPanel` accepts only `deviceId`. Its attach effect is keyed on `[deviceId]`. Nothing in it observes the lease.

So after **Take control**, the panel keeps its stale error until something unmounts it — which is why switching tabs and coming back "fixes" it. That is not a workaround an operator should have to discover, and it makes a correct system look broken.

The panel takes the lease state as a prop and re-attaches when it becomes true. That is the whole fix; the confusing part was never the rule, it was that the screen stopped listening.

### 3.3 Keep-alive, and why holding the lock is free here

Plan 57 mounts the inspector as `{!liveVisible && visible && <InspectorPanel/>}` — deliberately, because keeping it mounted holds an instrumentation lock and an `adb.maxConcurrent` slot on a real phone (plan 56 §3.2, acceptance #8).

That reasoning has a gap. **The inspector requires a manual lease (§3.1). A manual lease already makes the device exclusively yours** — the scheduler will not pick it, and no other operator can take it. Holding the instrumentation lock for the duration of a lease you already hold costs nobody anything.

So the attachment follows the **lease**, not the mode:

| While | Attachment |
|---|---|
| Lease held, device page open | **attached** — flipping modes is instant |
| Lease released, or the page left | detached, engine released |

The server side already supports this: attach/detach is ref-counted per connection (`ws-handlers.ts`), so this is a question of when the client detaches, not new machinery.

And the panel keeps its last tree, so returning to `Inspect` shows the previous dump immediately while any re-attach happens behind it. It must never look like a cold start when it is not one — with §3.5's age line making clear what is being looked at.

### 3.4 A refresh that changed nothing must cost nothing

`refresh()` writes the parsed tree into state unconditionally, so every poll re-renders the tree, re-runs the flatten memo, and — because `refresh()` also resets `selectedPath` — throws away the node the operator had selected.

With auto-refresh on (§3.5) that happens every couple of seconds, on a screen someone is trying to read.

So a dump whose serialised tree is identical to the current one is **dropped**: no `setState`, no re-render, no lost selection. Only the age line updates, because "checked 1s ago, unchanged" is itself the useful fact.

When the tree *has* changed, the selection is preserved if the selected path still exists, and cleared only when the node genuinely went away.

### 3.5 Auto-refresh defaults to on

Plan 57 §3.5 made `follow` opt-in, reasoning from the cost of a dump. The operator's call is that an inspector which does not track the screen is not doing its job, and they are right that the default was timid.

It defaults **on**, and three things keep it honest:

- It polls only while the `Inspect` mode is actually visible — never behind another tab, never in `Live`.
- Each cycle is chained *after* the previous dump returns, never on a fixed `setInterval`, so a slow device stretches the gap instead of queueing dumps onto the adb queue.
- The age and duration stay visible ("taken 1s ago · 512 ms"), and §3.4 means an unchanged screen costs one dump and no render.

Turning it off stays one click, and that control keeps stating its interval.

### 3.6 Offline is not a locked door

From the fleet list, an offline device's only route to its own page is the **Control** button — and that button is correctly disabled when offline, so the page becomes unreachable without knowing the URL. The card title is not a link.

The intent was right ("a genuinely disabled button, not a link that looks dead but is still clickable") but it was applied one level too far: *you cannot control an offline phone* does not mean *you cannot read about it*. Its logs, jobs, crashes, settings, and past artifacts are exactly what an operator wants when a device has dropped off — that is usually **why** they are looking.

So: the card always offers a way in, and the device page keeps rendering every tab for an offline device. Only the actions that genuinely need a live phone are disabled, each saying which state it needs — the same rule as §3.1.

## 4. Technical design

### 4.1 `InspectorPanel`

```ts
export function InspectorPanel({
  deviceId,
  /** The manual lease this device requires (plan 56 §3.7). Attaching, dumping and finding all need it. */
  canUse,
  /** Offered inline when `canUse` is false, so the fix is where the problem is found (§3.1). */
  onTakeControl,
  /** False while the Live mode is showing: stay mounted and attached, stop polling (§3.3, §3.5). */
  visible,
}: { deviceId: string; canUse: boolean; onTakeControl: () => void; visible: boolean })
```

- The attach effect depends on `[deviceId, canUse]`. Losing the lease detaches; gaining it attaches.
- `follow` starts `true`; its loop runs only while `visible && canUse && state === 'ready'`.
- `refresh()` compares the serialised new tree with the current one and returns early when equal, updating only `lastDumpAt`/`lastDumpMs`.
- Selection survives a refresh when its path still resolves.

### 4.2 `ScreenCard`

`InspectorPanel` moves from a conditional render to the same `hidden` treatment `LiveView` already gets, and takes `visible={!liveVisible && visible}`. It unmounts only when the device page itself does.

### 4.3 The fleet card

`DeviceCard`'s offline branch keeps `Control` and `Run` disabled, and adds a plain route to the page — the device label becomes a link in every state, which is also where people already try to click.

### 4.4 Precondition states elsewhere

Audit the device page's panels for the §3.1 pattern — a precondition rendered through the error component. Known: the inspector. Fix what is found; report anything ambiguous rather than guessing at intent.

## 5. Implementation steps

### 59.1 Precondition state
- [x] `InspectorPanel` renders a calm "needs control" state with a `Take control` action; the red error path is kept for real failures only.

### 59.2 Lease reactivity
- [x] `canUse` prop; attach/detach follows it. Taking control unsticks the panel with no remount.

### 59.3 Keep-alive
- [x] `ScreenCard` stops unmounting the inspector; attachment follows the lease (§3.3).
- [x] The last tree survives a mode flip and is shown immediately on return.

### 59.4 Smart refresh
- [x] Identical dump → no state write, no re-render, selection preserved.

### 59.5 Auto-refresh on by default
- [x] `follow` starts on, polls only while visible, chains after each dump.

### 59.6 Offline access
- [x] Fleet card always offers a route to the device page.
- [x] Verify every tab renders for an offline device; disable only what needs a live phone, each naming the state it needs.

## 6. Acceptance criteria

1. Selecting `Inspect` without a lease shows no error styling and offers `Take control`.
2. Pressing that button makes the tree appear without switching tabs or reloading.
3. Flipping `Live → Inspect → Live` while holding a lease shows no "Starting the inspector…" after the first attach.
4. A refresh over an unchanged screen causes no re-render and does not clear the selected node.
5. Auto-refresh is on by default, stops while `Live` is showing or the page is on another tab, and never runs two dumps at once.
6. Releasing control detaches the inspector; the engine is not held by an operator without a lease.
7. An offline device can be opened from the fleet list, and every tab renders.
8. `bash scripts/typecheck.sh`, `bun test`, `bun run build:studio` green; `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

**Unit** — `packages/studio/src/components/InspectorPanel.test.tsx` (this plan's `Ships:` artefact, and the reason it is a test file: every change here is a behaviour of an existing component, so the only thing that can prove the plan shipped is the test that pins it). Covers the unchanged-dump short-circuit (identical tree → no state write); selection preserved across a changed dump when the path survives, cleared when it does not; `follow` does not tick while `visible` is false.

**Manual smoke** (one device attached)

```bash
bun run dev
# 1. Inspect without control      → calm precondition, Take control offered
# 2. press it                     → tree appears, no tab switch
# 3. Live ⇄ Inspect several times → no cold start after the first
# 4. leave the screen still       → age advances, tree does not flicker, selection holds
# 5. release control              → engine detaches
# 6. unplug the phone             → its page still opens from the fleet list, every tab renders
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Keep-alive holds a device engine indefinitely. | It follows the lease, and a lease already makes the device exclusive (§3.3). Releasing control detaches — acceptance 6. |
| Auto-refresh on by default disturbs the app under test. | Visible-only, chained not timed, and §3.4 makes an unchanged screen free. One click turns it off. |
| The unchanged-dump comparison is wrong and hides a real change. | Compare the serialised tree, not a hash of part of it; a false "unchanged" would be worse than a re-render, so the comparison must be total. |
| Making offline devices openable exposes actions that then fail. | §3.6 disables them explicitly and names the state each needs — the §3.1 rule again. |

## 9. Open questions

1. Should `follow` keep polling while the operator holds the lease but has the browser tab in the background? Proposed: **no** — `document.visibilityState` gates it, for the same reason mode visibility does.
2. Should a dump that fails while following back off, or keep trying at the same interval? Proposed: back off, and say so in the age line, rather than hammering a device that is already struggling.
3. Does the terminal have the same precondition-as-error problem? It disables the input and explains why, which is already the §3.1 shape — worth confirming, not changing on assumption.
