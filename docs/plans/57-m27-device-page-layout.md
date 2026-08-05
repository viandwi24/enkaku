# Plan 57 — M27 : The device page earns its space back

> Status: implemented — steps 57.1–57.4. Step 57.5 (verify on hardware) is the operator's and is not done; `bun run build:studio` is unverified — the guard refused while a dev server held :3001.
> Ships: packages/studio/src/components/device/DeviceHeader.tsx
> Depends on: Plan 56 (`56-m26-ui-inspector-devtools.md` — the inspector this plan relocates, not rebuilds), Plan 42 (the tab lifecycle: hidden, never unmounted), Plan 31 (viewer presence).
> Spec references: `docs/design.md` (the quality floor), §10.2 (leases), §7.4 (inspection layer).

---

## 1. Goals

- Inspecting is done **without leaving the screen you are inspecting**: `Inspect` becomes a mode of the screen card, not a separate tab.
- The Control tab shows the screen and the things an operator actually watches while working — nothing else.
- Every fact that is *looked up* rather than *watched* moves out of permanent space and into the header.
- A destructive action stops sitting in the toolbar with the same weight as everyday ones.

## 2. Non-goals

- Rebuilding the inspector. Plan 56 (`ui-inspector-devtools`) owns the tree, the snapshot, node highlighting, and selector proposals. This plan moves where it lives and deletes the tab it used to occupy.
- Changing what the inspector costs. A dump is a dump (measured: 334–584 ms on a moto g06 power); §3.5 only makes that cost visible.
- Touching the other tabs (Jobs, Monitor, Crashes, Terminal, Files, Network, Logs, Settings).
- A general collapsible-panel system. §3.3 explains why the answer is fewer panels rather than foldable ones.

## 3. Context and design decisions

### 3.1 The screen card gets modes, because the inspector was never a separate place

`Inspect` is a top-level tab today, so inspecting means leaving the live screen, looking at a still of it, and coming back. The two things it puts side by side — a picture and a tree — are *about* the screen the operator just navigated away from.

So `Inspect` becomes a mode of the screen card: **`Live | Inspect`**, switched where the screen already is.

**The snapshot stays frozen, and that is not a compromise.** An earlier draft of this plan proposed overlaying the tree on the live video instead. That is wrong, and plan 56's own goal 2 already says why: the tree and the picture must come from the same instant, "so a node's highlight lands where the node actually was". A dump takes up to 584 ms; the video has moved on by then, and a highlight drawn on a frame that no longer matches is a lie that looks precise. The still was never the problem — having to leave the tab to reach it was.

### 3.2 The banner is deleted, not shrunk

The Control tab opens with a status banner. In its most common state it reads: *"Take control before sending input. The core rejects taps and typing without a lease."*

`LiveView.tsx:607` already renders **"Input is off — watching only."** in the video's own footer — attached to the thing it describes, where the operator is already looking. The banner repeats it, in more words, one screen region further away. That is duplication, not emphasis, and the fix is to remove the copy that is further from the subject.

One state is genuinely different and is kept: **a job is running**. That explains why input is dead even for the lease holder, which nothing else says. It becomes a badge on the screen card rather than a banner above it.

### 3.3 The right column is removed, not made collapsible

Four stacked panels (hardware, viewers, active engines, clipboard) hold an 18rem column open at all times. A collapse control was considered and rejected: it adds state to remember and a decision to make, and it is the standard remedy for a panel holding more than it should. That is the problem to fix, not to fold.

Each item is placed by **how it is used**, not by how much room is left:

| Item | Used how | Lands |
|---|---|---|
| Battery, temperature | Watched passively — "is it overheating" | Header, inline readout |
| Viewers | Watched — who else is here | Header, count; hover for the list |
| Active engines | Only interesting **when degraded** | Header; loud only on fallback |
| Stable id, serial, api level, density, screen | Looked up, rarely | Header, `ⓘ` popover |
| Clipboard | An **action on** the device | Screen card toolbar (§3.4) |

Battery and temperature deliberately do **not** go behind hover. They are the farm's early warning for a swelling battery or a phone cooking itself; behind a popover they are seen only when someone thinks to look, and by then the answer no longer helps. Two numbers on one line is a cheap price for that.

### 3.4 Clipboard belongs with the screen, not with the facts

Clipboard is not a property of the device — it is something you *do to* it, in the same family as back/home/recents, power, volume, and brightness. It sits in the screen card's toolbar as a popover button (it needs a text field, so it cannot be inline).

### 3.5 The inspector says how old it is

A dump costs 334–584 ms measured on hardware. Auto-refreshing every second would spend most of the device's time building trees, competing with whatever is being tested.

So: **manual by default**, an optional `follow` toggle that polls at a stated interval, and the dump's **age and duration always visible** — "taken 4s ago · 581 ms". An inspector that quietly shows a ten-second-old tree is far more dangerous than one that admits its age, because every conclusion drawn from it is wrong in a way nothing on screen contradicts.

### 3.6 Destructive actions move behind an overflow menu

`Remove device` sits in the header as a permanent button, the same visual weight as `Run a script`. It is not reversible in the same way and should not read as though it is.

It moves into a `⋮` menu at the far right — which is also what the fleet list's device card already uses, so the affordance is consistent rather than merely tidier.

`All devices` is removed outright: the left sidebar's **Devices** entry already goes there, and a second route to the same place costs header space for nothing.

## 4. Technical design

### 4.1 The header

`packages/studio/src/components/device/DeviceHeader.tsx` (the artefact this plan ships), replacing the inline header in `device/page.tsx`:

```
moto g06 — rak 1          ● ready   100% · 29.0°C   👁 2   ⓘ   [Run a script] [Take control]  ⋮
ZP2222RMBS · Android 15
```

- **Battery / temperature** — live, from the same `device.battery` broadcast the panel used.
- **Viewers** — count always; the list (with "this tab" and hover-linking, plan 31 §4.3) in a popover.
- **`ⓘ`** — the static identity facts.
- **Engines** — inside the `ⓘ` popover when nominal; promoted to a visible warning chip when a session has fallen back (plan 34 §3.1 — an operator who cannot see the fallback has no way to know the slow path is running).
- **`⋮`** — Remove device, and a link to Settings.

### 4.2 The screen card

`LiveView` gains a mode switch above it and a toolbar below it:

- Modes: `Live` (today's video) and `Inspect` (plan 56's `InspectorPanel`, unchanged).
- Toolbar: back / home / recents, brightness, power, volume, **clipboard**.
- A `job running` badge on the card, replacing §3.2's deleted banner state.

`TabPanel`'s hidden-not-unmounted rule (plan 42 §3.1) applies to the modes too: switching to `Inspect` must not tear the video session down and rebuild it on the way back.

### 4.3 What is deleted

- The status banner (`device/page.tsx`), except the job-running state, which moves.
- The entire right `<aside>` and its four panels.
- The `Inspect` top-level tab and its entry in the tab list.
- The `All devices` button.

## 5. Implementation steps

### 57.1 Header
- [x] `DeviceHeader.tsx` with the readout, viewer popover, `ⓘ` popover, and `⋮` menu.
- Result: every fact the aside held has a home before the aside is removed.

### 57.2 Screen card modes
- [x] `Live | Inspect` switch; mount `InspectorPanel` in the `Inspect` mode without unmounting the video.
- [x] Toolbar with the existing key buttons plus clipboard.
- Result: inspecting no longer leaves the Control tab.

### 57.3 Remove
- [x] Delete the banner (keeping the job-running badge), the aside, the `Inspect` tab, and `All devices`.
- Result: the Control tab is the screen and its controls.

### 57.4 Inspector freshness
- [x] Age + duration always shown; `follow` toggle with a stated interval.
- Result: a stale tree can never be mistaken for a current one.

### 57.5 Verify on hardware
- [ ] Switch modes while streaming: video must survive the round trip, no re-wake.
- [ ] Confirm the inspector still highlights correctly, and that a `follow` cycle does not visibly disturb what is being tested.

## 6. Acceptance criteria

1. `Inspect` is reachable from the Control tab and no longer exists as a top-level tab.
2. Switching `Live ⇄ Inspect` does not restart the video session.
3. Battery and temperature are visible without hovering, clicking, or opening anything.
4. Static identity facts are reachable in at most one interaction.
5. An inspector dump always displays its age and how long it took.
6. `Remove device` is not reachable without opening a menu.
7. The Control tab contains no element that duplicates what the video footer already says.
8. `bash scripts/typecheck.sh`, `bun test`, and `bun run build:studio` are green; `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

**Unit** — the header's derived states: fallback engine promotes to a warning chip; viewer count matches the list; battery absent renders no readout rather than a placeholder.

**Manual smoke** (one device attached)

```bash
bun run dev
# 1. Control tab, streaming        → switch to Inspect and back; fps recovers without a re-wake
# 2. Inspect                       → dump shows age and duration; `follow` visibly polls
# 3. Take control, clipboard        → set and read text from the screen card toolbar
# 4. Overheat threshold in Settings → the header readout is where an operator notices it
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Switching modes tears down the video session. | Modes follow plan 42 §3.1: hidden, never unmounted. Acceptance 2 tests exactly this. |
| The header becomes a second cramped panel. | Only four things are permanent (status, battery/temp, viewers, actions). Everything else is behind `ⓘ` or `⋮`. If the header starts growing, the answer is another popover, not a smaller font. |
| `follow` polling competes with the thing under test. | Off by default, interval stated on the control, and the dump duration is displayed so the cost is never hidden. |
| Hiding `Remove device` makes it hard to find. | It matches the fleet card's existing `⋮`, so it is where an operator already looks for it. |

## 9. Open questions

1. Should `follow` survive a tab switch, or reset to off? Proposed: **reset**. A poll left running against a device someone walked away from is a cost with no reader.
2. Does the `ⓘ` popover want a copy button per row (serial, stable id)? Proposed: yes for `stableId` and `serial` — they are pasted into commands often enough to earn it.
3. Should the screen card's mode be remembered per device, or reset to `Live`? Proposed: reset. `Live` is what a device page is for; `Inspect` is a deliberate act.
