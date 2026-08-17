# Plan 105 — M70 : One control state, not two competing buttons

> Status: partial — steps 105.1 through 105.3, 105.5, and 105.6 are implemented and unit-tested. `packages/studio/src/components/device-popup/ControlState.tsx` (new) is the one place `free | held-by-job | held-by-human | i-hold | i-assist` is derived (`computeControlState`, wrapped as `useControlState`), the activity/authorization badge split lives (`deriveAssistActivity` — derived from `LeaseHolder.expiresAt` plus the configured TTL, no new field and no core/protocol change needed), and every `AssistEndReason` gets its own wording (`assistEndCopy`). `DevicePopup.tsx` is the primary consumer: it now renders exactly one primary action per state (Take control / Assist / Release control / Stop assisting), reaches `TakeControlDialog` from a state where someone else holds (closing plan 103 step 103.11's audit row 26), and sends `lease.release` for the first time (closing row 27). `TakeControlDialog.tsx` gained a `nonModal` prop (mirroring `AssistDialog`'s own) rather than being duplicated, per this plan's own instruction. `HolderBadge.tsx` — read by `DeviceCard`, `WallTile`, `DevicePicker`, and the legacy device page's `DeviceHeader` — now renders "Assisting" only within `ASSIST_ACTIVITY_WINDOW_SEC` of the last accepted input and "May assist" otherwise, computed once in `deriveAssistActivity` so no caller invented its own definition; `app/device/page.tsx`'s own `assist.stopped` notice was switched to the same `assistEndCopy` helper for the same reason (wording parity only — that legacy page's `notice` is a plain string shared with an unrelated `lease.revoked` message, so `primary_ended`'s inline "Take control" button is `DevicePopup`-only, not backported there). `105.4` (H1, the TTL measured on a real session) is owner-run and not started — `coControl.grantTtlSec`'s shipped default (300) is unchanged, per this plan's own instruction not to move it on a guess.
>
> **105.5/105.6 (2026-08-17), closing §0.4's two new owner-reported defects.** `free` now renders its own session-state block ("Nobody holds this device." + "Take control") — before this pass it rendered nothing, so release → re-take had no visible path back except the Inspector tab's inline prompt. "Release control" no longer sends `lease.release` immediately: it starts a 4-second (`RELEASE_UNDO_MS`) undo window during which the lease has not moved, deliberately NOT a `ConfirmDialog` (`docs/design.md`'s rule is aimed at instant-irreversible actions; a confirm on every ordinary release would have been its own annoyance, the task's own explicit warning). `leaseOrigin` (`'auto-claim' | 'explicit' | null`) tracks WHY this client holds the lease, and only an `'auto-claim'` hold is released when the popup unmounts or on a `pagehide`/`beforeunload` — an explicit Take-control or a pre-existing hold survives closing the popup, per the owner's own narrower framing ("reasonnya karena buka popup"). A real bug was found and fixed by this same pass's own tests: a pending undo timer was a bare `setTimeout`, uncancelled on unmount, which leaked into and corrupted a later test's assertions before a dedicated cleanup effect was added.
>
> **§9 Q1 (`held-by-human`) is still open** — implemented as designed-undecided: both Assist and Take control… are offered, weighted equally, with an explicit caption ("Join them, or take over — not decided which should be the default here") rather than a silently guessed primary. This is why acceptance criterion 1 below is left unticked rather than claimed on a technicality (see its own note).
>
> **Every surface enumerated (per this pass's own audit obligation):** `DevicePopup.tsx` reads the full `useControlState` hook, including its actions. `DeviceCard.tsx`, `WallTile.tsx`, `DevicePicker.tsx` and `DeviceHeader.tsx` (the legacy device page) all render a holder/assist badge through `HolderBadge`, which shares `deriveAssistActivity` — the one thing §3.2 actually requires to be shared — but none of them calls the full discriminated hook, each with a doc-comment explaining why: none of the three list/tile surfaces tracks a per-client "do I hold this device" fact of its own (only the popup ever acquires a lease or an assist grant), so there is nothing for the rest of `ControlState` to compute there beyond what `heldBy`/`assistedBy` already say. This is a deliberate, documented exclusion, not an oversight — recorded here so acceptance criterion 5 can be evaluated honestly rather than assumed. 105.5/105.6 do not change this: `free`'s new block and `leaseOrigin` both live only in `DevicePopup.tsx`, the one surface that ever tracks "do I personally hold this."
>
> `bash scripts/typecheck.sh`: 14/15 packages OK, the one pre-existing `packages/core/src/api/jobs.ts(229,49)` TS2739 failure unchanged (untouched by this pass, and by 105.5/105.6's own pass — both were `packages/studio/**`-only). `bun test`: 4873 pass / 0 fail. `bun run --cwd packages/studio test`: 1386 pass / 0 fail (10 new this pass: 7 in `DevicePopup.test.tsx`'s "release, re-take, and auto-claim origin" block, 3 in `LiveView.test.tsx` for plan 103 step 103.9, done in the same session — see that plan's own status line). `bun run spec:check`: GAP 0. `bash scripts/check-plan-status.sh`: clean once this status line lands. `bun run build:studio` was **not** run for the 105.5/105.6 pass — the guard correctly refused because the owner's dev server held :3001, and per this repo's own hard-learned lesson it was not bypassed; typecheck already proves `DevicePopup.tsx` compiles. The earlier 105.1–105.3 pass's own build DID run clean, per the sentence this replaces.
>
> Depends on: Plan 91 (M56) — co-control/assist ships there; this plan does not replace it, it fixes how it is offered and how it ends. Plan 103 (M68) — the popup is where both actions now live.
> Spec references: §9.5 (leases), §11 (device control)
> Ships: packages/studio/src/components/device-popup/ControlState.tsx

---

## 0. Evidence

The owner's report, verbatim: *"kok saya sering dapat tabrakan antara take control dan assist, terus kadang assist selalu muncul terus labelnya padahal saya sudah ga melakukan hal apapun lagi."* Both halves are reproducible from the code.

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **G1** | **An assist grant lives 300 seconds by default**, and **every input refreshes it**. So the grant — and anything rendered from it — outlives the operator's last touch by up to five minutes. | `packages/protocol/src/settings.ts` (`coControl` defaults: `grantTtlSec: 300`); `packages/core/src/server/ws-handlers.ts:1595` |
| **G2** | **`assistedBy` is an authorization, and the UI renders it as an activity.** One badge carries both "has permission for the next N minutes" and "is touching this device now". They are different facts with different lifetimes. | `packages/protocol/src/device.ts:193`; `HolderBadge` usage across `DeviceCard`/`WallTile`/`DevicePicker` |
| **G3** | **Assist is structurally dependent on someone else's hold.** `grant()` throws `device_not_held` — *"the device is not held by anyone — take control instead of assisting"* — so it is only ever valid in exactly the state Take control is not. | `packages/core/src/lease/co-control.ts:194` |
| **G4** | **The UI nevertheless offers both as peers.** `assistState` is `available` whenever `deviceDetail.heldBy` is set, and Take control is rendered beside it, unconditionally. | `packages/studio/src/components/device-popup/DevicePopup.tsx:341-347` |
| **G5** | **Whether either is valid is owned by a third party and can flip mid-click.** `heldBy` is another operator's or a job's lease; it can be released between the render and the click, turning Assist into `device_not_held` or Take control into a contended acquire. | G3 + `lease-manager.ts`'s own `acquireManual` error codes |
| **G6** | **A grant dies at the exact moment the device becomes free.** When the primary hold ends, every grant on that device is released with `primary_ended`. | `packages/core/src/lease/co-control.ts:258-261` |
| **G7** | `maxConcurrentPerDevice` defaults to **1** — one assistant per device, so a second operator gets `assist_taken`. | `packages/protocol/src/settings.ts` (`coControl` defaults) |
| **G8** | **The feature was designed for a different case than the one that collides.** The owner's original ruling was about a JOB holding the device while a human wants to touch it: the lease stays with the job, and the human gets concurrent input after a **warning, not a permission request**. Nothing in that ruling covers a HUMAN holding the device. | plan 91's own §0.3/§3 record of the owner's decision |

### 0.2 Hypotheses

| # | Hypothesis | Probe |
|---|-----------|-------|
| **H1** | A much shorter grant TTL (or an activity-derived badge) removes the "still says I am assisting" complaint without causing the opposite one — a grant that expires while the operator is still working. | Set the TTL low, work normally for ten minutes, count how often the grant lapses mid-task. |
| **H2** | Operators want "join them" and "take it from them" as visibly different acts when a HUMAN holds the device — rather than one action that picks for them. | Owner's judgement; §9 Q1 asks it directly rather than assuming. |

### 0.3 Scope expansion: plan 103 step 103.11's audit, rows 26 and 27

Plan 103's own parity audit (§5 step 103.11, run 2026-08-16 against `app/device/page.tsx` versus the popup) found two more rows in the exact same shape as this plan's own subject — "what can an operator do about who holds a device":

- **Row 26 — no way to take over a stuck device.** `DevicePopup.tsx`'s own doc comment recorded it as deliberate: *"A device already held by a job or another person is never auto-claimed or taken over from here; Assist is the only way in."* Assist only ever adds a subordinate grant; it never displaces the holder, so a device held by something that has gone away had no way back.
- **Row 27 — no way to release control voluntarily.** No button, row, or affordance anywhere in the popup sent `lease.release` (confirmed by search at the time of that audit). A lease the popup claimed on open was given up only by the server's idle timeout.

Both are folded into this plan rather than left for a separate pass, because they are the same subject as §3.1's own redesign — fixing the button arrangement without them would have left the actual deadlock shape in place: a device held by someone who has gone away could not be reclaimed, and the holder had no way to hand it back.

**Both are closed by step 105.1.** Row 26: every state where someone else holds (`held-by-job`, `held-by-human`) carries a reachable `take-over` action that opens `TakeControlDialog` (reused unchanged, given a `nonModal` prop) — for a job this correctly shows "View job"/"Close" rather than an actual takeover button (a job's hold is still never takeable), and for a person or an agent it is a real forced takeover with confirmation, exactly like the legacy page already offered. Row 27: `i-hold`'s primary action is "Release control", and `DevicePopup.tsx`'s new `releaseControl()` sends `lease.release` — the first time this popup has ever done so.

### 0.4 Scope expansion: two more owner-reported defects (2026-08-17), folded in the same way §0.3 was

The owner reported two more problems in the exact same shape as this plan's own subject — "a hold ends, and the operator is left with no way back or no way to know" — after 105.1–105.3 shipped. Both are folded in here rather than left for a separate pass, for the same reason §0.3 gives: they are the same subject as this plan's own redesign, and leaving them open would have left the actual deadlock/leak shapes in place.

- **Defect 1 (the owner, verbatim): *"ada tombol relases nya dan waktu, tapi kalau sudah direlease gimana cara take contorlnya lagi? kalau ga sengaja ke klik releasenya misalnya?"*** Two different problems: (a) after `i-hold`'s "Release control" (row 27, step 105.1) fires, the device becomes `free` — and `free` rendered NOTHING in the popup's own session-state panel (§4, `DevicePopup.tsx`'s cross-cutting session block), so the operator was left with no visible way back short of switching to the Inspector tab's own inline prompt. (b) Release is one click away from a live session, and its consequence (another operator or a queued job can immediately claim the device) was not obviously reversible, nor was it questioned at all. **Closed by step 105.5.**
- **Defect 2 (the owner, verbatim): *"sistem release otomatis nya kan ada pakai waktu, saran saya ada pakai on popup close juga, jadi otomatis ke release kalau take contorlnya itu reasonnya karena buka popup."*** `DevicePopup` auto-claims an idle device on open ("Quick control, not a takeover — auto-claim only", its own file header) and, before this step, gave that lease up only via the server's idle timeout — never on close. The owner's own suggested rule is narrower than "release on close": only when opening the popup is the REASON the lease exists. An operator who pressed Take control, or who already held the device before opening the popup, must not lose it just because they closed a panel — they may be about to run something. **Closed by step 105.6.**

---

## 1. Goals

1. **One control state per device, rendered once** — not two buttons whose validity is mutually exclusive (G3, G4).
2. A badge that means **one thing**: separate "is touching this now" from "may touch for the next N minutes" (G2).
3. `primary_ended` becomes an **opportunity, not a silent loss** (G6).

## 2. Non-goals

- Not changing the lease or grant mechanics in the core. G1–G7 are all correct as mechanisms; this plan changes how they are *offered* and *reported*.
- Not removing assist. The owner's original case (G8 — a job holds, a human touches) is exactly what it is for.

## 3. Context and design decisions

### 3.1 The two buttons are one decision

G3 and G4 together are the bug. Assist is only offered when someone holds; Take control is offered always. So in every state, one of the two is either invalid or means something the operator did not intend — and G5 means the state can change between reading and clicking.

Replace both with **one primary action, named for the current state**:

| state | primary action | secondary |
|---|---|---|
| nobody holds | **Take control** | — |
| **a job** holds | **Assist** — the owner's ruling: a warning, not a permission request (G8) | — |
| **another human** holds | *see §9 Q1* | *see §9 Q1* |

The third row is deliberately unfilled. G8 records that the original decision covered the job case only, and "join them" versus "take it from them" carry different social consequences. Guessing here is how the current collision was built in the first place.

### 3.2 A badge must mean one thing

G2: `assistedBy` is a 300-second authorization (G1) rendered as present tense.

Split it:

- **"assisting"** — there has been input within a short, visible window. Present tense, because it is.
- **"may assist"** — holds a grant, idle. Quieter, or not shown at all outside the device's own popup.

If only one can be shown, show the first. G1's five minutes is far too long for anything an operator reads as "right now" — and lowering the TTL alone does not fix it, because the badge would still be claiming activity from an authorization. H1 measures the TTL question separately.

### 3.3 `primary_ended` is the moment to offer control, not to go quiet

G6: the holder releases, and every assist grant on that device dies. From the assisting operator's side, input simply stops working, with no stated cause.

But the device is now **free** — which is precisely when Take control would succeed. The system withdraws access at the instant access became available.

So: when a grant ends with `primary_ended`, say so, and offer Take control in place. The reason code already travels to the client (`assist.stopped`/`assist.changed` carry `AssistEndReason`), so this is a UI change, not a protocol one.

### 3.4 Every ending reason should be legible, not just this one

`AssistEndReason` is `released | ttl | disconnected | primary_ended | mode_off`. Four of the five happen *to* the operator rather than because of them. Each deserves distinct wording:

| reason | what the operator should read |
|---|---|
| `released` | they stopped — no message needed |
| `ttl` | the grant lapsed after N minutes idle; re-assist is one click |
| `disconnected` | their own connection dropped |
| `primary_ended` | the holder released — the device is free, take it (§3.3) |
| `mode_off` | the farm turned co-control off; nothing they can do |

---

## 4. Technical design

One `useControlState(device)` hook returns a single discriminated state — `free | held-by-job | held-by-human | i-hold | i-assist` — plus the one primary action for it. `ControlState.tsx` renders it. The popup, the wall tile and the device card all read the same hook, so no two surfaces can disagree about what is being offered.

The activity/authorization split (§3.2) is derived here too, from the same grant data plus a last-input timestamp, so no component invents its own definition of "assisting".

---

## 5. Implementation steps

### 105.1 — `useControlState`, and one rendered primary action (§3.1)
The `held-by-human` branch stays behind §9 Q1 — implement the other four, and make that one state say plainly that it is undecided rather than guessing.

### 105.2 — The badge split (§3.2)
Activity versus authorization, with the wording rule from `docs/design.md`: a degraded or partial state is never worded as the full one.

### 105.3 — Ending reasons, worded per §3.4
Including `primary_ended` offering Take control in place.

### 105.4 — H1: the TTL, measured rather than guessed
Owner-run. The default moves only after it.

### 105.5 — Defect 1: a round trip after Release, and release stops being one click from irreversible (§0.4) — DONE
Two independent fixes, both in `DevicePopup.tsx`:

1. **The round trip.** `free`'s own session-state block was missing entirely — every OTHER state (`held-by-job`, `held-by-human`, `i-hold`, `i-assist`) rendered its own primary action there, but `free` rendered nothing, so `useControlState`'s `free` branch (which already had a correct `ControlAction`) was never surfaced except via the Inspector tab's own inline prompt. `free` now renders "Nobody holds this device." plus a "Take control" button (`claimControl`), so release → re-take is one click, in the same place Release control itself lives.
2. **The accidental click.** Clicking "Release control" no longer sends `lease.release` immediately — it starts a `RELEASE_UNDO_MS` (4 s) countdown (`requestReleaseControl`/`commitRelease`/`undoRelease`), during which the lease has NOT moved (nobody else can claim the device while this client still holds it), and the button relabels to "Releasing… Undo". Deliberately **not** a `ConfirmDialog`: `docs/design.md`'s own rule ("name the thing at stake, never ask 'are you sure'") is aimed at actions that ARE irreversible the instant they are clicked — this one is not, once the undo window exists, and a confirm on every ordinary, intentional release would have been its own annoyance (the task's own warning, borne out by how often "Release control" is a routine action, not a rare one). A found-in-passing bug this step also fixed: a pending undo timer was a plain `setTimeout` not tied to any `useEffect`'s own cleanup, so closing the popup mid-countdown left it running in the background — harmless server-side (`lease.release` is a no-op for a client that no longer holds the lease) but a real leak; a dedicated unmount cleanup now cancels it.

Verifiable result: `DevicePopup.test.tsx`'s new "release, re-take, and auto-claim origin" describe block — clicking Release does not send `lease.release` immediately; Undo cancels it (and a leaked, uncancelled timer from an earlier unmounted popup does not corrupt a later test's `wsSendCalls`, which is exactly the bug the unmount-cancel fix above closes); once the window elapses, `lease.release` IS sent and `free`'s own "Take control" appears right back.

### 105.6 — Defect 2: release-on-close, but only for the lease THIS popup claimed for itself (§0.4) — DONE
`leaseOrigin` (`DevicePopup.tsx`, `'auto-claim' | 'explicit' | null`) tracks WHY this client holds the manual lease, not just whether it does: `'auto-claim'` only for the initial idle-device claim the popup makes on open (`useEffect` on mount); `'explicit'` for every operator-initiated acquire — `claimControl()` (the free-state "Take control" row this same pass added, and the pre-existing Inspector-tab inline prompt) and `TakeControlDialog`'s `onTaken` (a forced takeover, audit row 26). **The rule is deliberately narrower than "release on close"**, per the owner's own framing: an operator who pressed Take control, or who already held the device before this popup opened (in which case `leaseOrigin` stays `null` — this popup never tracked itself as the acquirer, the same reason `UseControlStateInput`'s own doc comment gives for never deriving "do I hold this" by comparing IDs), must not lose the device just because they closed a panel.

Two release paths, both auto-claim-only:

1. **Component unmount** (closing the popup, or navigating away within Studio without a full page reload — both are an ordinary React unmount). A cleanup effect reads `leaseOriginRef`/`controlExpiresAtRef` (mirroring the mirror-group-cleanup pattern already in this file) and sends `lease.release` only when this popup auto-claimed AND still holds the lease.
2. **`pagehide`/`beforeunload`** (tab close, hard navigation) — the same check, best-effort. The server's own `handleClose` (WS-disconnect teardown) already releases every lease that client holds, regardless of origin, as part of its existing disconnect path; this listener is one more best-effort attempt layered on top of that, not a replacement for it — and the real backstop, for every path, remains the server's own idle timeout, exactly as the task's own instruction insists ("do not build something that only works when the browser cooperates").

A future reader who "simplifies" this into an unconditional release-on-close will silently break the explicit-hold case — recorded as a doc comment at both the state declaration and the cleanup effect itself, not only here.

Verifiable result: `DevicePopup.test.tsx`'s new tests — an auto-claimed lease sends `lease.release` on unmount and on a dispatched `pagehide`; a lease taken via the free-state "Take control" button does NOT send `lease.release` on unmount.

---

## 6. Acceptance criteria

- [ ] Exactly one primary control action is rendered per device state (§3.1). **Not ticked, honestly**: true for `free`/`held-by-job`/`i-hold`/`i-assist` (each resolves exactly one `ControlAction`, proven by `ControlState.test.ts`'s own precedence tests), but `held-by-human` deliberately renders ZERO primaries — two co-equal options with a caption saying the choice is undecided — rather than picking one. That satisfies the criterion's actual purpose (no state ever offers two *competing* primaries) but not its literal wording, and §9 Q1 is what would resolve it either way.
- [x] No surface renders "assisting" from an idle grant (§3.2). `HolderBadge.tsx`'s `deriveAssistActivity` (`ControlState.tsx`) computes "Assisting" only within `ASSIST_ACTIVITY_WINDOW_SEC` of the grant's last touch, derived from `LeaseHolder.expiresAt` — no core/protocol change needed. Every caller (`DeviceCard`, `WallTile`, `DevicePicker`, `DeviceHeader`) shares it; proven in `HolderBadge.test.tsx` and `ControlState.test.ts`.
- [x] Every `AssistEndReason` produces its own wording; none is silent (§3.4). `assistEndCopy` — `released` is the one deliberately silent case (§3.4's own words: "they stopped — no message needed"), the other four each read distinctly, proven in `ControlState.test.ts` including a test that every non-`released` message is textually distinct from every other.
- [x] `primary_ended` offers Take control in the same place the assist ended (§3.3) — in `DevicePopup.tsx`, the notice that reports it carries a real "Take control" button, proven in `DevicePopup.test.tsx`. **Not backported to the legacy `app/device/page.tsx`**: that page's `notice` is a plain string shared with an unrelated `lease.revoked` message; only the wording (`assistEndCopy`'s `.message`) was reused there, not the actionable button — the header's own Take control button already appears the moment the device becomes free, one click away rather than inline. Recorded rather than silently left, since the page is still live pending plan 103's own deletion condition.
- [ ] The popup, the wall tile and the device card all read one hook (§4). **Not ticked, honestly**: the popup reads the full `useControlState` hook, including its actions. The wall tile, the device card and the device picker read only the shared `deriveAssistActivity` derivation (via `HolderBadge`), not the full discriminated hook — each has a doc comment explaining why (no per-client "do I hold this" fact of their own to build a `ControlState` from). This is the deliberate exclusion the plan's own defect-class warning asks to be named rather than silently done; whether "reads the shared derivation" satisfies "reads one hook" is left for a reader to judge rather than claimed as ticked.
- [x] `grantTtlSec`'s shipped default is either unchanged or changed on H1's evidence — not on a guess. Unchanged (`packages/protocol/src/settings.ts`'s `coControl.grantTtlSec` default is still `300`) — H1 (105.4) has not run.
- [x] `free` renders its own primary action, so release → re-take is one click (§0.4 defect 1, step 105.5). `DevicePopup.tsx`'s session-state panel now has a `free` block ("Nobody holds this device." + "Take control"), proven in `DevicePopup.test.tsx`.
- [x] Release control is reversible for a short window rather than instantaneous, without a confirm dialog on every ordinary release (§0.4 defect 1, step 105.5). `RELEASE_UNDO_MS`, proven for both halves (does-not-send-immediately, Undo-actually-cancels) plus the commit-after-elapse round trip in `DevicePopup.test.tsx`.
- [x] A lease this popup auto-claimed on open is released when the popup closes; a lease the operator explicitly took or already held is not (§0.4 defect 2, step 105.6). `leaseOrigin`, proven for unmount (both cases) and for a `pagehide` dispatch in `DevicePopup.test.tsx`.

## 7. Test plan

### Unit / component
- `ControlState.test.ts` (new, 28 tests): each of the five states resolves one action (or, for `held-by-human`, deliberately none); a precedence test proves a device that is (in stale local state) somehow both `i-assist` and `i-hold` still resolves to exactly one state, never two; `deriveAssistActivity` proven at the exact activity-window boundary and past it; `assistEndCopy` proven for all five reasons, including that `released` returns `null` and the other four are textually distinct from each other.
- `HolderBadge.test.tsx`: an idle grant reads "May assist", never "Assisting"; a grant just touched reads "Assisting"; a grant with no `expiresAt` at all (a defensive fixture) reads "May assist" rather than overclaiming.
- `DevicePopup.test.tsx`: `assist.stopped` with each reason shows the right wording (or none, for `released`); `primary_ended` renders a real "Take control" button in the notice; the `held-by-job`/`i-hold` states render their own action correctly through the popup's live UI.
- `DevicePopup.test.tsx`'s "release, re-take, and auto-claim origin" describe block (steps 105.5/105.6, new, 7 tests): Release control does not send `lease.release` immediately and shows the undo affordance; Undo cancels it with no send, ever; once `RELEASE_UNDO_MS` elapses `lease.release` IS sent and `free`'s own Take control appears right back; `free` (reached by the primary releasing, not this client) offers Take control and clicking it sends `lease.acquire`; an auto-claimed lease is released on unmount; a lease taken via `free`'s own Take control is NOT released on unmount; a `pagehide` releases an auto-claimed lease too.

### Owner-run
| # | What | How | Outcome |
|---|---|---|---|
| H-1 | The TTL, measured (§H1). | Lower it, work ten minutes, count mid-task lapses. | *(owner to fill in)* |
| H-2 | The `held-by-human` decision (§9 Q1, H2). | Judgement. | *(owner to fill in)* |

## 8. Risks and mitigations

- **Collapsing two buttons into one hides an action an operator wanted.** Mitigated by §3.1's table being explicit per state, and by the `held-by-human` row staying open rather than being decided here.
- **A shorter TTL lapses mid-task**, trading one complaint for its opposite. Mitigated by H1 measuring before the default moves.
- **The activity window becomes its own guess.** State the number where it lives and let H1's session inform it.
- **"Release on close" gets simplified into an unconditional rule later**, silently breaking the explicit-hold case §0.4 defect 2 exists to protect. Mitigated by naming the rule (`leaseOrigin`) at both the state declaration and the cleanup effect, and by a negative test (`DevicePopup.test.tsx`) that fails the moment that simplification happens.
- **A pending release-undo timer outlives the popup that started it.** Mitigated by a dedicated unmount cleanup (step 105.5) that cancels it — found in passing by the SAME test suite, which is the risk actually materialising rather than staying hypothetical (a leaked timer from one test corrupted a later, unrelated test's `wsSendCalls` before the fix landed).

## 9. Open questions

1. **When another HUMAN holds a device, what is the primary action?** Take control (displacing them), Assist (joining them), or both with one clearly primary? G8 records that the original ruling covered only the job case. This is the decision that produces the collision the owner reported, and it is theirs. **Still open** — step 105.1 implements the state as designed-undecided (`held-by-human`, `ControlState.tsx`): both actions offered, weighted equally, with an explicit caption saying the choice is not yet made. Answering this question changes that state's shape, not this plan's other four.
2. **Should `maxConcurrentPerDevice` stay 1?** (G7.) A second assistant currently gets `assist_taken`; nobody has said whether two is wanted.
