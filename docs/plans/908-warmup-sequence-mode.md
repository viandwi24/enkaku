# Plan 908 — Warm-up: a phone's sequence as one job

> Status: implemented — verified on hardware (§5), including the defect that verification found.
> Ships: plugins/social-media-manager/src/warmup-workflow.ts
> Depends on: plan 907 (direct-run), plans 900–905
> Spec references: §4.7, §4.8

## 1. Goal

A warm-up phone may go out as ONE workflow job, with the gaps as `delay` nodes
inside it, instead of one job per activity paced by the router's tick.

## 2. A choice, not a replacement

`sequenceMode` defaults to `jobs` — the path verified in plans 903 and 904 — and
the trade is real in both directions:

| | `jobs` (default) | `workflow` |
|---|---|---|
| gaps | as fine as a 15 s router tick | exact, inside the job |
| the phone is claimed | once per activity | once per sequence |
| what the operator sees | a state and an error PER activity | one outcome, steps in the job's run view |

The last row is the cost, and it comes from a deliberate permission choice: this
plugin holds `job.get` and not `job.list`, so it cannot read a workflow's own
member jobs. The form says this in a sentence rather than leaving an operator to
discover it.

Nothing about who AUTHORS the composition changed (plan 900 D1). The document is
generated from the plan `warmup.ts` already drew, in TypeScript, and its gaps
are read off the ROW rather than re-drawn: a settings change made after a row was
planned must not silently re-pace work already scheduled.

## 3. Acceptance criteria

| # | criterion | test |
|---|---|---|
| 1 | The generated document is accepted by the real `WorkflowDocSchema` | `warmup-workflow.test.ts` |
| 2 | Every script the planner drew is in it, in order | same |
| 3 | The delays are the planner's own gaps, not a fresh draw | same |
| 4 | Params are wrapped as workflow values, never bare | same |
| 5 | A phone given nothing gets no document | same |
| 6 | A workflow row goes out whole, and offers nothing to `nextStep` | `warmup-runs.test.ts` |
| 7 | A retry sends only the failed activities, together | same |
| 8 | A failed sequence names the activity that failed | same (`sequenceOutcome`) |

## 4. What running it found

Two defects, neither visible from the tests that existed:

### 4.1 `actions.run` had never worked, on any host

The plugin called it and was refused `E_NOT_SUPPORTED`. `CapabilityContextDeps`
declares `actionsRun`, the capability is in the registry, the ACL and the docs —
and **no host ever supplied it**, so `ctx.actions` was always absent. A
capability that is declared, permissioned, documented and reachable, and cannot
work anywhere.

Found through the audit log, which is the one witness that sees a capability
nobody has ever successfully used: the broker writes a row on every path,
including its own refusals. Fixed in `daemon.ts` by wiring `runAction` through a
holder — `actionsDeps` is built two hundred lines after the capability context
that needs it.

### 4.2 "All 4 failed", when three had succeeded

A workflow row has every activity against one job, so a failed job first read as
every activity failing. On the run that found it, three of four had gone green
as the engine walked them and the fourth met a bad YouTube screen. That is not a
rounding error; it is the opposite of what happened, and an operator reading it
goes looking for four broken activities.

`sequenceOutcome` reads the failing node out of the engine's own message
(`step "s2" failed: …`) and credits what ran. Reading an index out of a message
is fragile, and it is deliberately the only thing that depends on it: an
unparseable message falls back to the blunt answer rather than guessing, because
a wrong guess is worse than a crude one.

## 5. Hardware verification

2026-09-20, local core, moto g06 power attached, `smm@0.55.0` installed as a real
`.enkaku` package and driven from Studio:

```
form                   "One workflow per phone" chosen
session created        2 waiting, 12 skipped of 14 phones
row                    seq=workflow, 4 steps, all queued against ONE job d6d80e34
job                    smm-warmup-sequence, kind: workflow
  step 0               youtube/check-profile    success
  step 2               youtube/search-channel   success
  step 4               youtube/download-home    success
  step 6               youtube/watch-video      failed (a known YouTube flake)
```

The odd step numbers are the `delay` nodes — the document's own structure. The
settle then wrote "all 4 failed", which is §4.2.

## 6. Open questions

Whether `workflow` should become the default. It needs a measurement nobody has
taken: the same fleet, the same session, both modes, compared on how many
activities actually complete.
