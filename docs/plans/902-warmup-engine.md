# Plan 902 — Warm-up in SMM, wave 2 : the engine, in plugin code

> Status: implemented — the planner and the catalog; nothing dispatches them yet (wave 3).
> Ships: plugins/social-media-manager/src/warmup.ts
> Depends on: plan 900 (D1, D6), plan 901
> Spec references: §4.7, §12

## 1. Goals

- The nine warm-up styles exist as typed data this plugin can check, not as a
  graph document for an interpreter.
- A session's plan — who does what, on which platform, in what order, when — is
  a pure function of the fleet, the settings, `now` and `random`.
- All six behaviours in plan 900 §2 D6 survive the rebuild, each asserted by
  name.

## 2. Non-goals

- Dispatching (wave 3), any Studio surface (wave 4), removing
  `smm/warmup-rotation` (wave 5).

## 3. Design decisions

### 3.1 The catalog is data, the planner is a function

`warmup-catalog.ts` holds the nine styles and their activities;
`warmup.ts` plans. Split because the catalog is what changes when a pack gains
a member, and the planner is what changes when the rotation's rules change —
they have different reasons to be edited.

`planWarmup` mirrors `planDispatch` in `posts.ts`: pure, total, `now` and
`random` injected. Using the same shape twice is the point of plan 900 — the
composition is plugin code now.

### 3.2 A phone with no number is refused, never rotated as zero

`platformFor` returns `null` rather than defaulting. CLAUDE.md spends a
paragraph on why: a rotation keyed on anything but the durable device number
gives one phone the same platform twice and another none, with every run green
and nothing able to say so.

### 3.3 A style weight of 0 removes it from the draw, not from the catalog

So an operator can put it back. An unweighted style counts as 1, so a style
shipped after their settings were saved joins the draw instead of vanishing.
Every style weighted 0 returns `null` and the phone is given a sentence — a
deliberate choice reported, not silently worked around.

## 4. What the rebuild found

Checking every param in the catalog against the packs' own schemas —
mechanically, not on a phone — showed `tiktok/keyword-videos` declares
`keywordBoostFactor` and **not** `likeProbability`, while the catalog was
sending both. An undeclared param is refused at dispatch, so every TikTok phone
drawn into `tt-b` or `tt-c` would have failed in wave 3 with a validation error
naming the plugin rather than the line that caused it. Fixed with `boost()`,
and locked by a test.

Twenty script refs and every param name are now verified against the packs.

## 5. Acceptance criteria

| # | criterion | test |
|---|---|---|
| 1 | The fleet splits into equal platform groups | "a fleet splits into equal groups" |
| 2 | The split follows the NUMBER, not list position — through `planWarmup`, not only `platformFor` | "the plan itself follows the number…" |
| 3 | An unnumbered phone gets nothing and says why | "a phone with no number gets nothing…" |
| 4 | The rotation turns at local midnight, and `slot` shifts it | two tests in D6.2 |
| 5 | Phases cover every platform; more phases than platforms does not repeat one | D6.3 |
| 6 | Weighted draw: 0 excludes, unweighted joins, heavier is commoner, all-zero is reported | D6.4 |
| 7 | Start jitter, shuffled order, gaps drawn in range, every activity once | D6.1/D6.5 |
| 8 | Counts scale with `amount` and respect a member's own floor | D6.6 |
| 9 | `tiktok/keyword-videos` never receives `likeProbability` | "tiktok/keyword-videos is sent the keyword boost…" |
| 10 | The same seed plans the same session twice | "the plan itself" |

### 5.1 The acceptance test was itself tested

Keying the plan on list position instead of the device number was injected
deliberately. The first run of that mutation failed only the *no-number* test —
the "decisive" test called `platformFor` directly and so missed the wiring where
the defect would live. A second test was added through `planWarmup`; the
mutation now fails two.

## 6. Test plan

```bash
cd plugins/social-media-manager && bun test src/warmup.test.ts   # 30 tests
cd plugins/social-media-manager && bun test src/                 # 316 tests
bun run typecheck
```

No device: this wave dispatches nothing.

## 7. Risks

| risk | mitigation |
|---|---|
| A param name drifts when a pack changes its schema | Wave 3 surfaces a dispatch refusal per device with the script named; the mechanical check in §4 is repeatable |
| `warmup-rotation` and the new engine diverge while both ship | Nothing reads the workflow any more, and its title says "superseded" |

## 8. Open questions

None new. Plan 900 §6 Q1 still gates wave 5's removal of the workflow.
