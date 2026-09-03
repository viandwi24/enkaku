# Plan 49 — M23 : Readiness and Wall Corrections

> Status: implemented — sleep now checked against the manual lease instead of viewers, the button reads `actual`, the overlay was recentred (per the note in §3.3), and the Topology nav entry is gone.
> Ships: packages/core/src/device/readiness.ts
> Depends on: Plans 45 (readiness), 47 (merged fleet view), 48 (tile density). All landed.
> **Amends Plan 45 §3.4** — the sleep rule stated there is wrong and is corrected here.
> Spec references: §10.1 (server-authoritative control), §10.2 (leases).

---

## 1. Goals

- Sleeping a device is refused **only** when a job is running or another operator holds the lease. Watching never blocks it.
- The Wake / Sleep button says what pressing it will actually do, reflecting the device's real state — including when something else woke it.
- The action overlay is **horizontally centred and floated at the bottom edge**, not tucked into a corner. (Revised during implementation — see §3.3.)
- **Topology disappears from the sidebar.** One entry, Devices, as Plan 47 intended.
- A busy tile shows its running-job caption **and** its action; they no longer compete for one slot.

## 2. Non-goals

- Revisiting the three readiness levels, the hot budget, or the hold model (Plan 45 §3.2, §3.5, §3.6). Only the sleep refusal rule changes.
- Changing what a tile reports (Plan 48 §4.3 still holds).
- Bringing back `/topology` as a route. It stays a redirect; only the nav entry goes.

## 3. Context and design decisions

### 3.1 The sleep rule was wrong, and wrong in a self-defeating way

Plan 45 §3.4 said sleep requires *"either you hold the lease or nobody is viewing"*. `packages/core/src/device/readiness.ts:345` implements exactly that:

```ts
const viewers = deps.viewersOf(deviceId)
if (viewers.length > 0) { /* refuse */ }
```

The Wall tile is itself a viewer. So opening the Wall — the one screen whose entire purpose is to let an operator manage many devices at once — makes every Sleep button on it fail, reporting that *"a person is watching this device"* about the person pressing the button. A rule that forbids the action from the place the action lives is not a safeguard; it is a defect.

The reasoning behind it was also wrong on its own terms. Watching is passive. Being interrupted while watching costs a viewer a black rectangle they can wake again in one click. **Controlling** is different: someone mid-gesture, mid-command, or mid-transfer would lose real work.

Corrected rule:

| Sleep is refused when | Why |
|---|---|
| a job is running on the device | it would break the job |
| **another operator holds the manual lease** | they are actively using it |

Everything else is allowed. Watchers — including the operator's own Wall tile, and colleagues' — are simply dropped back to a sleeping tile, which is the honest consequence of somebody choosing to sleep the device.

Holding the lease **yourself** does not block your own sleep: you are the one using it, and you are the one asking.

Wake is unchanged: refused only for `offline` and `quarantined`.

### 3.2 The button read intent, not reality

`ReadinessControl.tsx:29`:

```ts
const wantsAsleep = device.readiness.desired === 'asleep'
const label = wantsAsleep ? 'Wake' : 'Sleep'
```

It reads **`desired`**, which is the operator's standing intent — not what is true. Two visible consequences, both reported:

- Press Wake and `desired` flips to `hot` immediately, so the button says "Sleep" while the device may still be asleep, still transitioning, or blocked by the hot budget.
- A device woken by a **hold** (a job, a viewer, a transfer) keeps `desired: asleep` by design (Plan 45 §3.6), so its button still says "Wake" while the device is plainly awake.

A button labels the action it performs, so it must be derived from `actual`: asleep → **Wake**; anything else → **Sleep**. `desired` continues to drive the badge, which is where intent belongs — that is exactly why Plan 45 split the two, and the button simply read the wrong half.

While a transition is in flight (`desired ≠ actual`) the button shows a pending state rather than flipping early, so it never claims a change that has not happened.

### 3.3 Centre, not corner

`WallTile.tsx:117` places the action strip at `inset-x-0 bottom-0` with `ml-auto`, putting it bottom-right. On a small tile that is a corner target, and it shares the strip with the running-job caption — which is why `showControl = !showCaption` exists, silently hiding the action on any busy tile.

Giving the control its own layer fixes both, and `showControl = !showCaption` goes away: a busy tile shows both, because they no longer occupy the same space.

**Revised during implementation.** This section originally specified centring the control in the middle of the tile (`inset-0`, `items-center`). The user asked mid-implementation for it to be *horizontally* centred but still floated at the bottom edge, and that is what shipped: its own `absolute inset-x-0 bottom-0 flex justify-center` layer, separate from the caption's strip. Recorded here rather than left as a plan that describes something the code does not do.

### 3.4 One entry in the sidebar

Plan 47 merged the pages but left `AppShell.tsx:17` pointing a **Topology** nav item at `/?view=wall&group=cluster`. That reintroduces the thing the merge removed: two entries for one page, and a question about which to click.

The entry goes. `/topology` keeps redirecting, so bookmarks survive. The grouping is a control on the Devices page, discoverable where it applies.

## 4. Technical design

### 4.1 `packages/core/src/device/readiness.ts`

Replace the viewer check with a lease check:

```ts
// Watching never blocks sleep (plan 49 §3.1) — the Wall tile is itself a
// viewer, so a viewer check made Sleep impossible from the one screen it
// belongs on. Only ACTIVE USE blocks: a running job, or someone else's
// manual lease.
const lease = deps.leaseOf(deviceId)
if (lease && lease.type === 'manual' && lease.holder !== actor.clientId) {
  refuse('device_controlled', `${holderLabel} is controlling this device`)
}
```

`viewersOf` is no longer needed by this path; remove the dependency if nothing else uses it, rather than leaving a misleading wire in place.

The job check is unchanged. Both remain server-authoritative (spec §10.1).

### 4.2 `packages/studio/src/components/ReadinessControl.tsx`

```ts
const isAsleep = device.readiness.actual === 'asleep'
const label = isAsleep ? 'Wake' : 'Sleep'
const target: Readiness = isAsleep ? 'hot' : 'asleep'
const transitioning = device.readiness.desired !== device.readiness.actual
```

`transitioning` renders the pending state; the label never flips ahead of `actual`.

### 4.3 `packages/studio/src/components/wall/WallTile.tsx`

- The action wrapper becomes `absolute inset-0 flex items-center justify-center`, still `pointer-events-none` with the control re-enabling them.
- The caption keeps its own `inset-x-0 bottom-0` strip.
- `showControl = !showCaption` is deleted; both render.
- Plan 48's three visibility rules (hover, `focus-within`, `hover: none`, plus persistent when there is no picture) are unchanged — only the position moves.
- The scrim stays confined to the control's own bounds (Plan 48 §3.4).

### 4.4 `packages/studio/src/components/layout/AppShell.tsx`

Remove the Topology nav entry and its now-stale comment.

### 4.5 Amend Plan 45

`docs/plans/45-m19-device-readiness.md` §3.4's table and acceptance criterion 5 state the superseded rule. Correct them in place with a note that Plan 49 changed it and why — a plan left describing behaviour the code no longer has is worse than no plan.

## 5. Implementation steps

**49.1 — The sleep rule** (§4.1), with tests replacing the viewer-based ones: sleep succeeds with watchers present, succeeds while you hold the lease yourself, is refused for a job, is refused for another holder's lease.

**49.2 — Button label from `actual`** (§4.2), including the pending state.

**49.3 — Centre the overlay, keep both caption and control** (§4.3).

**49.4 — Remove the sidebar entry** (§4.4).

**49.5 — Amend Plan 45's §3.4 and acceptance criterion 5** (§4.5).

## 6. Acceptance criteria

1. Sleeping a device succeeds while one or more viewers are watching it, including from a Wall tile the actor is looking at.
2. Sleeping succeeds while the actor holds the manual lease themselves.
3. Sleeping is refused while a job is running, and while **another** operator holds the manual lease, each naming the reason.
4. Waking is unchanged: refused only for offline and quarantined.
5. The button reads **Wake** whenever `actual` is `asleep` and **Sleep** otherwise, including for a device woken by a job or viewer hold while `desired` is still `asleep`.
6. The button does not flip label before `actual` changes; a transition shows a pending state.
7. The action overlay is centred on the tile.
8. A busy tile shows both its running-job caption and its action.
9. Plan 48's visibility rules still hold: hover, keyboard focus, always-visible under `hover: none`, and persistent when there is no picture.
10. The sidebar has no Topology entry; `/topology` still redirects.
11. Plan 45's §3.4 and its acceptance criterion 5 describe the implemented rule.
12. Refusals stay server-authoritative — calling the API directly is refused exactly as the UI is.
13. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `readiness.test.ts` — the four §6.1–6.3 cases; the previous viewer-based tests are replaced, not merely deleted, so the new rule is pinned. `ReadinessControl` label derivation: asleep→Wake, awake→Sleep, hot→Sleep, hold-woken (desired asleep, actual awake)→Sleep, transitioning→pending.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. Wall → Wake a device → button becomes Sleep only once it is actually awake
# 2. press Sleep on that same tile, while looking at it → succeeds (this is the reported bug)
# 3. take control from a second browser → Sleep from the first is refused, naming the holder
# 4. run a job → Sleep refused, naming the job
# 5. hover a tile → the control is centred; a busy tile shows caption and control together
# 6. sidebar has Devices and no Topology; /topology still lands on the grouped wall
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Someone sleeps a device a colleague is watching, and the colleague is surprised. | That is the intended trade (§3.1): watching is passive and recoverable in one click. The event is recorded with the actor (Plan 45 §4.5), so it is answerable. Active use — a lease or a job — is still protected. |
| Reading `actual` makes the button feel laggy on a slow wake. | The pending state (§4.2) is the honest signal, and it beats a label that lies. Plan 45's `set()` already awaits reconciliation, so `actual` lands with the response. |
| Centring the overlay covers the picture more than a corner did. | It appears only on hover/focus (Plan 48 §3.3) and its scrim stays confined to its own bounds; the picture behind it is otherwise untouched. |
| Removing the nav entry makes grouped-by-cluster hard to find. | The grouping control sits on the Devices page where it applies, and `/topology` still redirects for anyone with a bookmark or a habit. |

## 9. Open questions

1. Should sleeping a device notify the viewers who lose the picture? A toast on their side would be kind; deferred until someone hits it in practice.
2. Should the Wall offer "Sleep all idle devices"? The bulk actions from Plan 45 §4.6 already cover the selection case on the list.
