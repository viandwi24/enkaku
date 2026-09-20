# Plan 905 — Warm-up in SMM, wave 5 : schedules, docs, and retiring the workflow

> Status: implemented — except the removal of `smm/warmup-rotation`, which waits on plan 900 §6 Q1.
> Ships: plugins/social-media-manager/src/add-warmup.ts
> Depends on: plans 900–904
> Spec references: §4.7, §12

## 1. Goals

- A warm-up can be put on a schedule, the way the workflow could.
- Moving an existing schedule across cannot quietly create one session per
  phone.
- The docs an agent reads name this series and stop describing the warm-up
  rotation as a workflow.

## 2. The hazard this wave exists for

Not one the old design had — one the REPLACEMENT created.

`smm/warmup-rotation` was a workflow **dispatched to every phone**, so a
schedule for it naturally targeted the whole fleet. `add-warmup` plans the
whole fleet from **one run**. An operator moving their schedule across would
point it at the fleet exactly as before, and get eighty identical sessions,
each planning the same eighty phones. The farm would spend its day warming up
eighty times over, and every session would look correct on its own page.

A warning in a description does not prevent that; the operator is copying a
schedule, not reading a member's docs.

So `dedupeMinutes` (30 by default): a warm-up of the same title made inside the
window is USED rather than duplicated, and the run answers with its id and
`reused: true`. The first of eighty runs makes the session; the other
seventy-nine find it. `0` turns it off for someone who means it.

The decision is `reusableWarmup` in `groups.ts` — pure, with `now` and the
window as arguments, so the tests make the clock rather than wait for it.

## 3. How a warm-up is scheduled now

A farm schedule runs a `scriptRef`, so the replacement for scheduling the
workflow is a schedule on `smm/add-warmup@latest` with the session's settings
as params. Target ONE phone: the member reads the fleet itself and plans every
phone in it. Targeting more is safe now (§2) but wasteful.

Phases replace what plan 316 did with `$run.repeat`: `phases: 3` over three
platforms covers every phone on every platform in one session, rather than
three scheduled repetitions.

## 4. Retirement

`smm/warmup-rotation` still ships, titled **"superseded"**, and nothing
dispatches it. It is not deleted because a farm may hold a schedule pointing at
it and removing the document would break that schedule with nothing to explain
it — plan 900 §6 Q1, asked three times and still unanswered. The cost of
keeping it is one row in a list that says what it is; the cost of deleting it
wrongly is a silent broken schedule on someone's farm.

**When Q1 is answered "no farm runs it":** delete `src/workflows/`, drop
`workflows: [warmupRotation]` from the manifest, and bump a minor. The tests to
update are `index.test.ts`'s workflow assertions.

## 5. Docs

- `docs/spec.md` §on `$device.number` no longer implies the warm-up rotation is
  a workflow; the RULE is unchanged and still applies to any composition that
  outlives one batch.
- `CLAUDE.md` / `AGENTS.md` gained the 900 series, including that direct-run
  workflow is declined and plan 308's fan-out stays closed.

## 6. Acceptance criteria

| # | criterion | test |
|---|---|---|
| 1 | A same-title warm-up inside the window is reused | `groups.test.ts` |
| 2 | One outside the window, or of another title, is not | same |
| 3 | A POST session of the same name is never reused as a warm-up | same |
| 4 | Two runs a second apart agree on the same session | "the newest match wins" |
| 5 | `dedupeMinutes: 0` turns the guard off | same file |
| 6 | The agent docs name this series | `check-agent-docs.ts` |

## 7. Open questions

Plan 900 §6 Q1 remains, and is now the ONLY thing between this series and
deleting `smm/warmup-rotation`. It is recorded here rather than asked a fourth
time.
