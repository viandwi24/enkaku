# Plan 308 — Flow : Per-node device targets and fan-out across devices

> Status: draft — **blocked on an owner decision** (plan 300 D5). Do not execute.
> Ships: none — this plan is a decision document until the decision is made.
> Depends on: plan 307
> Spec references: §4.6 (as rewritten by plan 307), §11 (Actions API targets)

## 1. Why this plan exists as a stub

Plan 300 D5 deferred fan-out rather than refusing it, and a deferral that is
not written down becomes a refusal by forgetting. This document holds the
question open, states what would have to change, and names what it would cost —
so the decision is made with the price visible.

Today, and after plans 301–307: **one run, one device**. Every step inherits
`job.deviceId` ([workflow.ts:215, :470](../../packages/core/src/jobs/executors/workflow.ts)),
and spec §4.6 states the restriction explicitly with the CEO decision recorded
in `docs/mvp/README.md` Open decisions 4.

## 2. The two things people mean by "parallel", and only one of them is sane here

**Parallel branches on one device.** Two branches of one workflow running at
once against one phone. This is what n8n does and it is **wrong here**: both
branches would drive the same screen. The screen is a single mutable resource;
two cursors on it produce interleaved gestures and a result nobody can explain.
If this is ever wanted, it needs a lock on the device that serialises the
branches — at which point they are not parallel.

**Fan-out across devices.** One workflow, N phones, the same steps. This is
what a device farm is for, and it is what the Actions API already does for a
single verb (spec §11: a target resolves to many devices and the response
carries one result per device). A workflow is a sequence of verbs; fanning it
out is the same idea one level up.

So if fan-out happens, it is the second kind, and the question is not "should
branches run in parallel" but "should a workflow job resolve a **target**
instead of a device".

## 3. What would change

| Area | Change | Difficulty |
|---|---|---|
| Job model | A workflow job takes a `target` (spec §11's resolver) and creates one **child run per device**, as a batch already does | moderate — the batch machinery exists |
| Document | Nothing, if the whole workflow fans out. A **per-node** target (node 3 runs on a different phone) is a much larger change and is a separate question | small vs large |
| Expressions | `$nodes` becomes ambiguous across devices unless each device's run has its own scope. It should: one run per device, one scope per run | small if fan-out is per-run |
| `$input` | Plan 302 §9 Q2 flagged this: with one cursor `$input` is unambiguous. Per-run fan-out keeps it unambiguous. Per-node targets do not | the reason to prefer per-run |
| Merge | Only now becomes meaningful: "wait for all devices, then continue once". That is a **join across runs**, not an edge on a canvas | large |
| UI | The run overlay (plan 307) shows one run at a time and already has a picker; N runs need a device switcher, not a redesign | small |
| Retention, jobs list, budgets | N× the rows; `checkWorkflow`'s budget is per run and unchanged | small |

## 4. The recommendation, if asked today

Do the **cheap half** and refuse the expensive half:

- **Yes** to fan-out at the job level: a workflow job accepts a target and
  produces one independent run per device. It reuses the batch path, needs no
  document change, keeps every expression scope unambiguous, and delivers what
  a farm actually wants — "run this on all twenty phones".
- **No** to per-node device targets and to a cross-run merge, until a real
  workflow needs them. Both add a coordination model (a join, a barrier, a
  failure policy when device 7 dies) whose complexity is not repaid by any use
  case named so far.

Under that split there is still **no Merge node**, and plan 300 D5's
consequence stands.

## 5. What must be true before this plan is written properly

1. The owner has decided, on the record, that fan-out is wanted.
2. Spec §4.6's single-device sentence is amended in the same change, not
   afterwards.
3. Plans 301–307 are `implemented` and the P1–P12 sitting has passed —
   fan-out on top of an editor nobody has validated would be building the
   second floor first.

## 9. Open questions

| # | Question | Held by |
|---|---|---|
| Q1 | Fan-out: yes or no? | owner |
| Q2 | If yes: what happens when 3 of 20 devices fail — does the batch fail, or report per device? | owner; the Actions API's per-device result shape (spec §11) is the precedent and the likely answer |
| Q3 | Does a fanned-out run share pins? | this plan — likely yes, since pins are per workflow+node and device-independent |

## 11. Handoff report

_Not applicable: this plan is not executed._
