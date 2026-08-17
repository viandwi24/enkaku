# Plan 104 — M69 : Selection is farm-wide, and every action inherits it

> Status: partial — 104.1–104.4 implemented and unit-tested; 104.5 (H1/H2) is owner-run and unstarted. H1 (§7 below) passed: `RunScriptDialog.test.tsx`'s 23 tests are unedited and green. 104.4 covers `RunScriptDialog`, `InstallBatchDialog`, `BulkTransferDialog`, `BulkForgetDialog`, and a `SingleDeviceNotice` on `AssistDialog`/`TakeControlDialog` — `ForgetDeviceDialog` (device-page/popup single-device path), `DisconnectDeviceDialog`, `CutoverDialog`, and `ScheduleEditorDialog`'s own separate `cluster`/`devices` target model were found but NOT migrated this pass (§10 below has the full audit and why). H2 (does mirror-from-selection surprise) is unrun.
> Depends on: Plan 101 (M66) step 101.5 — `useDragSelect` and the shared `selectedIds` state this plan promotes. Plan 103 (M68) — the device popup is where most of these actions are launched from. Plan 91 (M56) — mirror input, whose switch this plan removes.
> Spec references: §11 (device control), §19 (Studio screens)
> Ships: packages/studio/src/components/target/TargetPicker.tsx

---

## 0. Evidence

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **G1** | **`RunScriptDialog` already contains the target model everything else needs**: `type Target = 'single' \| 'cluster' \| 'devices'`, with `deviceIds`, `clusterId`, a `targetCount`, a fleet-wide confirmation threshold, and a `usable`/`readyNow` split. It is ~1,400 lines and none of it is reusable — every part is local state in one dialog. | `packages/studio/src/components/RunScriptDialog.tsx:80`, `:520`, `:773-789` |
| **G2** | **No other action-dialog offers a target at all.** `InstallBatchDialog`, `BulkTransferDialog`, `AdbRestartDialog`, `DisconnectDeviceDialog`, `ForgetDeviceDialog` each act on whatever device set their caller happened to hand them. | repo-wide `DialogContent` survey |
| **G3** | **Mirror requires an explicit start.** `DevicePopup.tsx:373` sends `mirror.start` only when a button is pressed (`:551`, gated on `mirrorStarting \|\| (!mirrorGroupId && !canStartMirror)`). Selecting devices does not arm it. | `packages/studio/src/components/device-popup/DevicePopup.tsx` |
| **G4** | Selection is already **one shared state across List and Wall** — `app/page.tsx`'s `selectedIds`/`useBulkSelection`, read by the bulk toolbar, the context menu, the floating selection bar, and `useDragSelect` (which finds targets through `[data-device-id]` in the DOM rather than a view-specific list). | `packages/studio/src/app/page.tsx`; `components/wall/useDragSelect.ts` |
| **G5** | The core already accepts a device set on the paths that matter: `POST /api/batches` takes `deviceIds`/`tags`/`clusterId`, and `resolveTarget`/`resolveCluster` resolve them server-side with a `usable`/`skipped` split. | `packages/core/src/clusters/resolve.ts`; `packages/core/src/api/batches.ts` |
| **G6** | Multi-device outcomes already have one house style — `OutcomeSummary`/`SkippedGroups`, "outcome first, grouped by reason, every count reachable to named devices". | `packages/studio/src/components/bulk/`; `docs/design.md` |

### 0.2 Hypotheses

| # | Hypothesis | Probe |
|---|-----------|-------|
| **H1** | Extracting the target model out of `RunScriptDialog` does not change that dialog's behaviour in any observable way. | Its existing test suite must pass unchanged, with no test edited to accommodate the refactor. If a test needs changing, the extraction changed behaviour and that must be reported, not absorbed. |
| **H2** | Auto-arming mirror on a multi-selection does not surprise an operator into broadcasting a tap they meant for one device. | Owner-run: select several, open one, tap. Report whether it felt expected or alarming. §3.3 argues it is expected *because the selection is visible*; that argument has not been tested. |

---

## 1. Goals

1. **One selection, farm-wide**, that every action inherits as its default target.
2. **One target picker**, extracted from `RunScriptDialog` and reused — not reimplemented per dialog (G1, G2).
3. **Mirror needs no switch** (G3): selecting more than one device and controlling one of them broadcasts to the selection.
4. Defaults are **filled from context, never locked**: opened from a single device, it targets that device; opened with a live multi-selection, it arrives pre-filled with it — and the operator can still change it.

## 2. Non-goals

- Not changing how the core resolves a target (G5 already does it).
- Not a new outcome-reporting style — G6's exists and every surface here uses it.

## 3. Context and design decisions

### 3.1 The target picker becomes a component, and `RunScriptDialog` becomes its first caller

G1: the model is already written, once, in the wrong place. Extract `Target`, the device/cluster/tag resolution, the count, and the fleet-wide confirmation into `components/target/TargetPicker.tsx` plus a `useTargetSelection` hook.

**`RunScriptDialog` must come out of this behaviourally identical** (H1). Its own tests are the proof, and none of them may be edited to make the refactor pass — a test changed to accommodate a refactor is a behaviour change wearing a refactor's clothes.

### 3.2 The default comes from context; the control stays live

The owner's own framing: *"pengaturan ini secara default akan menyesuaikan keadaan... jadi fill default value nya ada, tapi user juga masih bisa custom."*

So the picker takes a **context**, not a fixed value:

| opened from | default |
|---|---|
| a device popup, nothing else selected | that device, `single` |
| a device popup **while N devices are selected** | `devices`, pre-filled with the selection |
| the fleet toolbar with a selection | `devices`, pre-filled |
| a cluster screen | `cluster`, that cluster |

In every case the operator can switch mode and edit the set. **The default is a starting point, never a lock** — and the picker must show what it resolved to, so an operator who did not notice the pre-fill cannot act on a set they did not choose. That is the failure this convenience can cause, and it is the reason the resolved count is always visible rather than only on submit.

### 3.3 Mirror arms itself from the selection, and the selection is the consent

G3 makes mirroring a mode you enter. The owner's comparison: on the competitor you select several devices, double-click one, control it, and the input reaches all of them — no switch.

That is defensible **only because the selection is visible while you do it**. The selected tiles carry an accent border and tint, and the cursor badge names the count at two or more (plan 101). So the answer to "why did my tap go to six phones" is on screen before the tap.

The switch is therefore redundant with the selection — it asks a second time for something already stated. Remove it, and make the *selection* the thing an operator manages.

**H2 tests this**, because "the selection is visible" is an argument, not a measurement, and the cost of being wrong is an input broadcast nobody intended. If H2 says it surprises, the fallback is not to restore the switch but to make the broadcast state louder in the popup itself — a switch you must remember to turn off is the worse failure of the two.

### 3.4 Every action dialog gains the picker, and the defaults differ per action

G2: today each dialog silently acts on whatever it was handed. With the picker, each declares what it supports:

| action | targets |
|---|---|
| Install apk | single · devices · cluster |
| Run script | single · devices · cluster (already) |
| Adb command | single · devices · cluster |
| Push/Pull file | single · devices · cluster |
| Reconnect / Disconnect | single · devices |
| Forget | single · devices — with the fleet-wide confirmation, since it is irreversible |
| Assist / Take control | **single only** — a lease is one device by definition |

That last row matters: the picker must be able to say "this action is single-device, and here is why", rather than being omitted and leaving the operator to guess whether a multi-selection applied.

---

## 4. Technical design

```
useTargetSelection(context) → { target, deviceIds, clusterId, resolved, setTarget, … }
        │  context: { deviceId?, selectedIds?, clusterId?, allow: Target[] }
        ▼
<TargetPicker />   mode switch + device/cluster editor + a live resolved count
        ▼
each dialog posts the resolved set through the paths G5 already accepts
```

The resolved count is rendered by the picker itself, not by each dialog, so no dialog can show a number that disagrees with what it will submit.

---

## 5. Implementation steps

### 104.1 — Extract `TargetPicker`/`useTargetSelection`, `RunScriptDialog` as first caller
H1 is the acceptance: that dialog's tests pass unedited.

### 104.2 — Context-aware defaults (§3.2)
Including the always-visible resolved count.

### 104.3 — Mirror arms from the selection; remove the switch (§3.3)
Plus a visible statement in the popup of how many devices the current input reaches.

### 104.4 — The picker in every action dialog (§3.4)
Install apk, Adb command, Push/Pull, Reconnect, Disconnect, Forget — each declaring its allowed targets, single-device actions saying so explicitly.

### 104.5 — H2, and the decision it settles
Owner-run.

---

## 6. Acceptance criteria

- [x] `RunScriptDialog`'s existing tests pass **with no edits** (H1, §3.1). `RunScriptDialog.test.tsx` — 23/23 pass, zero lines changed.
- [x] No dialog computes its own target count — the picker owns it (§4). True for every dialog `useTargetSelection` reaches (§10's table); `resolvedCount`/`hasTarget`/`fleetWide`/`fleetConfirmed` live in the hook, read, never re-derived, by `RunScriptDialog`, `InstallBatchDialog`, `BulkTransferDialog`, `BulkForgetDialog`.
- [x] Opening an action from a popup with N devices selected pre-fills `devices` with those N, visibly, and still allows changing it (§3.2). Proven for Run script and Install apk from the device popup (`ActionsList.test.tsx`'s own "with a live Wall selection…" tests) — both read `ActionsList`'s new `selectedIds` prop, unioned with the focused device.
- [x] Controlling one device while N are selected reaches all N, with no switch, and the popup states the count (§3.3). `DevicePopup.tsx`'s Mirror switch is gone; the candidate set (focus device ∪ Wall selection) arms/disarms mirror automatically, and "Input reaches N device(s)" renders once the answer is not already obvious — never for the trivial one-device case the popup is already showing, always once two or more are actually reachable or arming is in progress (owner call, 2026-08-16, `DevicePopup.test.tsx`'s rewritten Mirror describe block).
- [x] A single-device-only action says so rather than omitting the picker (§3.4). `SingleDeviceNotice` (`components/target/TargetPicker.tsx`) renders in `AssistDialog` and `TakeControlDialog`.
- [x] Every multi-device result renders through `OutcomeSummary`/`SkippedGroups` (G6). Unchanged in every dialog touched — `InstallBatchDialog`/`BulkTransferDialog`/`BulkForgetDialog` already used this pair before this plan and still do; the picker sits above the report, never replacing it.

## 7. Test plan

### Component
- `useTargetSelection.test.ts`: each context's default; switching mode preserves an edited set where it makes sense and resets it where it does not.
- `TargetPicker.test.tsx`: the resolved count matches what a submit would send, under every mode.

### Owner-run
| # | What | How | Outcome |
|---|---|---|---|
| H-1 | Mirror-from-selection does not surprise (§3.3, H2). | Select several, open one, tap. Report whether it felt expected. | *(owner to fill in)* |
| H-2 | The pre-filled default is noticed. | Open Install apk with a selection live; report whether the target was obvious before pressing anything. | *(owner to fill in)* |

## 8. Risks and mitigations

- **An operator acts on a pre-filled set they did not notice.** The whole convenience creates this risk. Mitigated by the resolved count being always visible (§3.2), never revealed only at submit, and by irreversible actions keeping the fleet-wide confirmation (§3.4).
- **Extracting from a 1,400-line dialog changes it subtly.** Mitigated by H1's rule that its tests may not be edited.
- **Mirror with no switch broadcasts an unintended tap.** Mitigated by the selection being visible and by H2; §3.3 records why restoring the switch is the wrong fallback.

## 9. Open questions

1. **Does a selection survive closing the device popup?** If it does, an action opened later still inherits it — convenient, but the further from the selection moment, the less it is consent.
2. **Should mirror broadcast include the device you are looking at, or only the others?** The competitor's behaviour here was not observed closely enough to copy.

## 10. Enumeration — every dialog that takes a device set (2026-08-16 pass)

The plan's own instruction: a picker adopted by five of seven dialogs is the same defect as G2, one iteration later. This is the audit, not a claim of completeness elsewhere — walked by grepping every component with a `devices: DeviceInfo[]` or `device: DeviceInfo | null` prop.

| Dialog | Verdict | Detail |
|---|---|---|
| `RunScriptDialog.tsx` | **picker** | `single · cluster · devices`, context-aware default (`initialDevice`/`initialCluster`/`initialSelectedIds`), fleet-wide confirm. First caller (104.1). |
| `InstallBatchDialog.tsx` | **picker** | `single · cluster · devices`. `devices` prop is now the pre-filled default (not a lock); `allDevices` is the whole pool. Two call sites updated (`app/page.tsx` bulk toolbar, `ActionsList.tsx`'s popup row) to pass `allDevices`/`clusters` and a selection-aware default. |
| `BulkTransferDialog.tsx` (push/pull) | **picker** | Same shape as `InstallBatchDialog`. One call site (`app/page.tsx`) — there is no popup row for Push/Pull (`ActionsList`'s fixed 12 rows never had one). |
| `BulkForgetDialog.tsx` | **picker** | `single · devices` (no cluster mode, per §3.4's table), fleet-wide confirm reused from `TargetPicker` rather than a second one. One call site (`app/page.tsx` bulk toolbar). |
| `AssistDialog.tsx`, `TakeControlDialog.tsx` | **states single-device explicitly** | `SingleDeviceNotice` — a lease is one device by definition (plan 91 §3.2), so no picker, but no silent omission either. |
| `ForgetDeviceDialog.tsx` | **deliberately excluded — single-device only, unchanged** | Still `device: DeviceInfo \| null`. It has real per-device state `BulkForgetDialog` does not (a delete-history switch with live counts, a refusal→"Block instead" flow) that does not trivially generalize to N devices inside this pass's budget. `BulkForgetDialog` above is the multi-device answer for Forget; this file is the single-device one, reached from `app/device/page.tsx` (locked, the device's own page — the same "the screen already answered which device" reasoning `RunScriptDialog`'s own `lockedDevice` uses) and from `ActionsList.tsx`'s popup row (**not** updated to route through `BulkForgetDialog` — the popup's Forget row still loses the delete-history option it would gain by switching, which is why the swap was not made here). Reported, not hidden: the popup's Forget row is single-device-only today despite Forget being on §3.4's `single · devices` row. |
| `DisconnectDeviceDialog.tsx` | **not done** | Still `device: DeviceInfo \| null`, single-device only, three call sites (`app/device/page.tsx`, `app/page.tsx` row-level, `ActionsList.tsx`). No bulk-disconnect batch endpoint exists (`internal:install`/`push`/`pull` all go through `POST /api/batches`; disconnect is `POST /api/devices/:id/connection/disconnect`, a per-device REST call with a `job_running`/force-checkbox refusal flow). Building a `devices`-mode Disconnect would mean N parallel per-device calls aggregated through `OutcomeSummary`/`SkippedGroups` (the same shape `BulkForgetDialog` already uses) — a real, bounded piece of work that did not fit this pass. |
| `CutoverDialog.tsx` | **deliberately excluded** | The USB→network cutover wizard is about ONE device's own transport identity; there is no multi-device reading of "cut this device over" that means anything. |
| `ScheduleEditorDialog.tsx` | **found, not touched — a duplicate this plan's own evidence (G1) missed** | Has its OWN `type Target = 'cluster' \| 'devices'` (no `single`) and its own inline `DevicePicker`/cluster `Select`, structurally the same model `RunScriptDialog` had before 104.1 — G1's survey (§0.1) only looked at `RunScriptDialog`, `InstallBatchDialog`, `BulkTransferDialog`, `AdbRestartDialog`, `DisconnectDeviceDialog`, `ForgetDeviceDialog` and missed this file entirely. Not migrated this pass (schedules have no natural `single` mode reading, and the recurrence semantics deserved their own look rather than a rushed fit into `TARGET_ALLOW`) — flagged here so the next pass does not have to re-discover it. |
| `AdbRestartDialog.tsx` | **not a device-set action** | Restarts the shared adb SERVER (`adb-server-control.ts`'s `cycle()`), not a per-device operation — out of this plan's scope by definition, not an oversight. |
| "Adb command" (§3.4's own row) | ~~two pre-existing surfaces, neither touched~~ → **migrated, 2026-08-17** | **This row is superseded and kept only so the change of direction is visible.** It described the state at this pass's own end: `ActionsList.tsx`'s "Adb command" row switched the side panel to a Terminal tab (plan 103 §5 step 103.5), inherently one device; and the fleet console (`app/console/page.tsx`, plan 93) had its own separate, tags-capable target picker (`components/command/TargetPicker.tsx`) predating this plan, left unmigrated because it already satisfied §3.4's substance in a different shape. Both statements were true when written. Plan 103 §9 Q4 — Terminal-as-panel versus Terminal-as-modal — was then answered by the owner in favour of the modal, and plan 103's step 103.12 built `components/device-popup/AdbCommandDialog.tsx`: the Terminal tab is gone, "Adb command" opens a non-modal dialog carrying **this plan's** `TargetPicker`, `single` mode renders the existing `TerminalPane` unchanged, and `cluster`/`devices` mode reuses `/console`'s own `RunReport`/`ConfirmFanout` against the same `POST /api/command-runs`. So §3.4's row for this action is satisfied now, by plan 103's work rather than this plan's — which is why the audit row stays rather than being deleted: a reader comparing §3.4's table against the code needs to know where that satisfaction came from. The fleet console's own picker is still a second target model and still unmigrated; that half of the original finding stands. |
| Reconnect (§3.4's own row) | **not done — no dialog exists to put a picker in** | `ActionsList.tsx`'s Reconnect row fires `POST /:id/connection/reconnect` directly, one device, no dialog at all (the USB case opens `CutoverDialog` instead, itself single-device per above). A `devices`-mode bulk Reconnect would be new work, not an extension of an existing dialog — out of this pass's budget, named rather than silently skipped. |

**Net**: 4 of the table's 6 named actions (Install apk, Run script, Push/Pull, Forget) have a working multi-device picker somewhere in their call graph; Reconnect and Disconnect do not. ~~Forget's own device-popup path still bypasses the picker it has elsewhere.~~ **No longer true, 2026-08-17** — plan 103 step 103.10 made `ActionsList`'s Wake/Sleep and Forget rows candidate-set-aware (`deviceId` ∪ `selectedIds`), so Forget now routes through `BulkForgetDialog` once there is more than one candidate. That step also found the same gap was a latent bug in `DevicePopup` itself, not merely in the context menu it was building: those rows had been ignoring a live Wall selection even though Mirror already armed for one. `ScheduleEditorDialog`'s duplicate model is a new finding, not a regression — it was never migrated because G1 never found it.
