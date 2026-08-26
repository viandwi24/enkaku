# Plan 132 — M97 : An assignment is a constraint, not a preference

> Status: implemented (software) — **132.1–132.4 all land.** Opened 2026-08-26 and **this reverses plan 122 §4.5**, on the farm owner's explicit, repeated instruction. An assignment onto a DOWN path is now **applied**, not skipped: *"sekalinya device ditentukan keluar lewat mana internetnya itu wajib dipatuhi … makanya ga boleh diskip wajib dipaksa"*. §4.5 had optimised for the wrong failure — it treated a device with no internet as the worst outcome, when on this farm the worst outcome is a device with the **wrong** internet, sharing an IP it must not be on. Of skip / apply / delete-the-old-rule, `skip` was the only one that leaked. Safe only because `MANAGED_RULE_ACTION = 'lookup-only-in-table'` was already right: a rule pointing at a dead table drops the traffic instead of falling through. `SkipReason` loses `'path-down'` entirely; `path-missing` and `duplicate` are untouched and still refuse, for reasons that are not about availability. Plan 131's "apply anyway" button is gone — nothing left to force. The warning survives and moves ABOVE the plan list in **both** dialogs, the second of which this plan had failed to name (§10 item 1). Ships as `mikrotik-routing@0.11.0`. **NOT verified on hardware**: §7's check — that a forced rule really drops traffic rather than leaking to another path — is the one that matters and is the only place §0.3's claim is proved rather than read.
> Depends on: plan 122 (M87 — §4.3 `resolveTarget`, §4.4 "plan, then apply — never write blind", §4.5 path health, the rule this plan reverses), plan 131 (M96 — §3.4 added the explicit override this plan promotes to the only behaviour).
> Spec references: §7.9 (driver layers), §11.6 (plugin screens).
> Ships: plugins/mikrotik-routing/src/service/planner.ts

---

## 0. Evidence

### 0.1 The owner's words, and the threat model they carry

> *"misal ada device1 saya arahkan ke path modem1, meski modem1 statusnya down saya gamau tahu intinya sama internet harus tetap dialihkan ke modem1 saya ga mau tau, karena apa? karena ini berhubungan sama traffic yang sangat krusial, sekalinya device ditentukan keluar lewat mana internetnya itu wajib dipatuhi, ini krusial dan efek sampingnya ga main main bisa kena banned resikonya, makanya ga boleh diskip wajib dipaksa"*

And earlier, on the same point:

> *"walau internet mati gamasalah karena memang dia saya paksa, ini mencegah adanya kebocoran, kalau device yang harusnya saya tetapkan dengan spesifik path tiba tiba ga keupdate ini bisa menimbulkan resiko banned"*

### 0.2 Plan 122 §4.5 optimised for the wrong failure

Its reasoning, verbatim: *"a rule pointing at a dead path is a device with no internet, and that should never be a surprise."* That treats **loss of connectivity** as the worst outcome.

On this farm the worst outcome is **the wrong connectivity**. Each device runs accounts that must egress through one specific modem. A device that keeps using its previous path is sharing an IP it should not be on — and that is what gets accounts banned. Downtime costs nothing comparable.

So the three possible outcomes rank the opposite way to how §4.5 assumed:

| Outcome | Connectivity | Isolation | Verdict on this farm |
|---|---|---|---|
| `skip` — old rule survives | device stays online **via the old path** | **violated** | the dangerous one |
| apply anyway | traffic dies at the dead table | held | correct |
| delete the old rule | device falls through to `main` | **violated** | worse |

`skip` — the current default — is the only one of the three that leaks. For a plugin whose entire purpose is per-device egress isolation, that is not a tuning preference; it is the mechanism failing at its one job.

### 0.3 The isolation actually holds, because the action is right

`router-driver.ts:136` — every managed rule carries `action=lookup-only-in-table`, never plain `lookup`. Its own comment says why: `lookup` *"would fall through to the routing table's own default rather than being confined to the assigned path's table."*

This is what makes forcing safe to do at all. With `lookup-only-in-table`, a rule pointing at a dead table drops the traffic. Had the plugin used `lookup`, forcing would have produced the leak it is meant to prevent, and this plan would be wrong.

### 0.4 And the current behaviour is quiet about it

`skip` rows render below a `max-h-72` scrolling plan list. An operator who applies a 22-row plan and closes the dialog leaves believing the fleet moved, while two devices are still on their old paths. The failure is silent in exactly the situation where silence is most expensive.

---

## 1. Goals

1. A `path-down` assignment is **applied**, not skipped — the assignment is obeyed.
2. `path-missing` and `duplicate` remain refusals, for reasons that are not about availability.
3. The plan still shows what will happen before it happens: a row written over a down path is visibly marked, and the operator is told which devices will lose connectivity.
4. Nothing about the write itself changes — same `action=lookup-only-in-table`, same marker, same `resolveTarget` decision.
5. The reversal is recorded where the old rule was stated, not only here.

## 2. Non-goals

- Making `path-missing` forceable. The routing table does not exist on the router; there is nothing to write to. Its old rule surviving is a real remaining leak — §9 Q1, not fixed here.
- Making `duplicate` forceable. Plan 122 §4.3 refuses rather than guessing which of two matching rules to keep; that is ambiguity, not caution.
- `failoverPolicy: 'substitute'`. Substituting a healthy path is precisely the leak this farm is avoiding.
- A setting. The owner's instruction is that the assignment is mandatory; an option to disobey it would be a switch whose wrong position is a silent ban risk. Pre-1.0, `00-overview.md` §4.3 — replace, never version.

## 3. Context and design decisions

### 3.1 The rule that changes, stated plainly

Plan 122 §4.5 said an assignment onto a down path is skipped and warned about. It is now **applied and warned about**. The warning survives; only the refusal goes.

`SkipReason` loses `'path-down'`. It is not kept as dead vocabulary: a reason nothing can produce is a trap for the next reader.

### 3.2 What replaces the warning

The plan row becomes a real `create`/`update` carrying `overDownPath: true` (plan 131 introduced `forcedOverDownPath` for the override; with forcing now unconditional, the flag means "this write lands on a path that is currently down"). The dialog states, above the plan and not below it, how many devices will lose connectivity and which paths are down — §0.4's complaint answered.

The operator is not being asked for permission. They are being told what is about to happen, which is what §4.4 has always required.

### 3.3 Plan 131's override collapses into the default

`forceDownPaths` (§4.1 of plan 131) becomes unnecessary: there is nothing left to force. The parameter, the second button, the `rowsStillUnwritten` note and `applyAnywayOffer` all go. Leaving a "force" affordance beside behaviour that is already forced would say that some other, safer default still existed.

### 3.4 What must keep working

- `action=lookup-only-in-table` on every managed rule (§0.3) — the property the whole plan rests on.
- `path-missing` and `duplicate` as skips, with their reasons.
- `resolveTarget`'s create-vs-update decision, the marker, and §3.2's local-exception refusal, which is a different check and still refuses an apply outright.
- The preview: every write is shown before it happens.

---

## 4. Technical design

### 4.1 `planner.ts`

```ts
export type SkipReason = 'path-missing' | 'duplicate'   // 'path-down' removed

// The health check no longer produces a row. It only annotates one:
const overDownPath = !(healthByPath.get(d.pathId) ?? false)
// …falls through to resolveTarget exactly as a healthy path does.
```

`BuildPlanInput.forceDownPaths` is removed; `PlanRow`'s `forcedOverDownPath` is renamed `overDownPath` on `create`/`update`.

`health` stays on the input — it is what sets the flag, and the UI needs it.

### 4.2 The plumbing plan 131 added, removed

`ApplyDeps.forceDownPaths`, the `/apply` body parse, `runApply(forceDownPaths)`, `applyAnywayOffer`, `rowsStillUnwritten`, and the second dialog button.

### 4.3 The warning, moved and reworded

Above the plan list. Names the count, the paths, and the consequence in the operator's own terms — that these devices will have **no internet** until the path returns, and that this is what keeps them off any other path.

---

## 5. Implementation steps

### 132.1 — The planner obeys the assignment
- `planner.ts` per §4.1, and its tests: a down path now yields `create`/`update` with `overDownPath: true`; a healthy path yields no flag; `path-missing` and `duplicate` still skip; the `SkipReason` union no longer admits `'path-down'`.
- **Result:** `cd plugins/mikrotik-routing && bun test src/` green.

### 132.2 — Remove the override that no longer has anything to override
- Per §4.2, across `apply.ts`, `apply-routes.ts`, `api.ts`, `assignments.tsx`.

### 132.3 — The warning moves above the plan and says what it costs
- Per §4.3.

### 132.4 — Record the reversal where the old rule lives
- `docs/plans/122-m87-mikrotik-routing.md` §4.5 gains a note that this plan reverses it, with the threat-model reason — a reader of 122 must not act on the superseded rule.
- `docs/spec.md` if it states the skip behaviour.
- `plugins/mikrotik-routing/src/index.ts`: bump **0.10.0 → 0.11.0**, changelog row, `bun run build:packs`. Minor: an operator meets a changed apply outcome.

## 6. Acceptance criteria

1. An assignment onto a down path produces `create`/`update`, never `skip`, and is written.
2. Such a row is marked in the preview, and the dialog states above the list how many devices will lose connectivity and which paths are down.
3. `path-missing` and `duplicate` still skip, with their reasons.
4. `SkipReason` no longer contains `'path-down'` anywhere in the codebase.
5. Every managed rule still carries `action=lookup-only-in-table`.
6. Plan 122 §4.5 records that it was reversed, and why.
7. `mikrotik-routing` is 0.11.0 in all three sites; `build:packs` emits it.
8. `bun run typecheck` passes; the plugin's tests pass; no process left running.

## 7. Test plan

Unit tests per step. **Needs the farm:** assign a device to a genuinely down modem, apply, and confirm on the router that the rule exists and points at the dead table — and that the device has no internet rather than falling through to another path. That last check is the one that matters, and it is the only place §0.3's `lookup-only-in-table` claim is proved rather than read.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | A momentary `check-gateway=ping` blip now writes a rule that takes a device offline. | It writes the rule the operator already asked for; the device returns the moment the path does. Under the old behaviour the same blip left the device on a path it must not use, which is the outcome this farm cannot afford. |
| R2 | An operator on a different farm loses the availability-first behaviour. | Deliberate (§2). Pre-1.0, one farm, one owner, and an option whose wrong position is a silent ban risk is worse than no option. |
| R3 | Someone reads plan 122 §4.5 later and reimplements the skip. | 132.4 writes the reversal into §4.5 itself, which is where they will be reading. |
| R4 | `path-missing` still leaks — the old rule survives a table that no longer exists. | Genuine and unfixed. §9 Q1. |

## 9. Open questions

1. **`path-missing` is the remaining leak.** The table is gone, so the correct rule cannot be written; the stale rule survives and the device keeps using it. Neither writing nor deleting is safe (deleting drops it to `main`). Closing it properly probably needs a blackhole route or a quarantine table — a real design question, not a tweak.
2. **A device with no assignment at all** egresses via `main`. Whether that should be prevented on a farm like this is the same question one level up.
3. **Should the reconcile loop enforce continuously**, rather than only on apply? If a rule is edited away on the router, the device leaks until someone opens the tab.

## 10. Notes recorded during execution

1. **The group activation preview was left out of the plan, and it mattered.** `groups.tsx` and `groups-service.ts` also run `buildPlan` and render its rows through their own local `PlanRowLine` — so after 132.1 that dialog correctly wrote the previously-skipped rules and said **nothing** about the devices going offline. That is §0.4's complaint one screen over, created by this plan rather than found in it. Reported by 132.1–132.3's worker, which correctly stayed inside its named scope and flagged it instead. The banner and the row mark were added there by the coordinator, reusing `summariseOverDownPath` rather than a second copy — the two dialogs must never disagree about which rows land on a down path.

2. **`lookup-only-in-table` already had an assertion.** `router-driver.test.ts:233` pins it on `createRule`'s PUT body, so no new guard was needed. Worth stating because the whole reversal rests on that one property: with plain `lookup` a rule pointing at a dead table falls through to the routing table's default, and forcing would produce the leak this plan exists to prevent.

3. **Both planner guards were mutation-tested.** Breaking the `overDownPath` computation failed 4 tests; breaking the `path-missing` check failed 5. Restored and re-verified.

4. **`SkipReason` no longer admits `'path-down'` anywhere in code.** Only the version-history prose in `src/index.ts` still names it, describing what was true at earlier bumps — left deliberately, since a changelog that edits its own past is worse than one that reads oddly.
