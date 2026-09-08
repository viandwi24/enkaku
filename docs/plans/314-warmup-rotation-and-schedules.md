# Plan 314 — Warmup : the daily platform rotation, the coverage guarantee, and the one thing it must not be built on

> Status: draft — a decision document answering the client brief of 2026-09-08. Nothing here is executed; §9 names what the owner must decide first.
> Ships: none — this is a decision document, not a milestone plan.
> Depends on: plans 210, 211, 217 (implemented), 300–307 and 309–313 (implemented), 700 (review; F1 and E10 are load-bearing here)
> Spec references: §4.6 (workflow document), §4.7 (schedule), §4.8 (job, run, batch), §11 (Actions API targets)

## 0. The verdict, before the evidence

The client asked for one feature. It is three, and they have three different
answers:

| # | What the client said | What it actually is | Answer |
|---|---|---|---|
| A | "every day the warmup system turns on" | a schedule whose work target is a **workflow** | **build it** — §7.1. It is the only genuine blocker, and it is small |
| B | "40 devices split three ways, then rolling, and every device must get all three platforms" | a **per-device sequence**, not a fleet-scheduling problem | **buildable today, zero new code** — §3, §4 |
| C | "each device behaves differently, to raise its uniqueness" | four separate levers, three of which already exist | **three exist, one is a trap** — §6 |

And the answer to the question actually asked — *one workflow, or a plugin that
injects/generates workflows?* — is:

> **One workflow document. Never a workflow generator.**
>
> A plugin's job here is to supply **nodes and per-device state**, never to
> author or emit documents. A generated document cannot be reviewed, cannot be
> replayed against what an operator saw, and moves the client's guarantee out of
> a property anyone can point at on a canvas and into a code path someone must
> keep correct forever. Plan 300 D6/D7 already settled this for the engine
> ("a plugin may never define control flow"); this is the same rule one level up.

The single most important thing in this document is §5: **the client's request
contains, one hop away from itself, the exact account-loss bug plan 700 F1
describes.** Rotation is safe. Per-device *identity* built the same way is not.

---

## 1. The brief, in the client's words

> setiap hari sistem warmup itu nyala, dan setiap devices itu bisa berbeda-beda,
> dibagi tugas misalnya ada 40 devices, maka dibagi 3, 13 buka tiktok, 13 buka
> instagram, sisanya buka youtube. lalu masing-masing devices akan menjalankan
> script/workflow warmup, setelah selesai itu rolling lagi […] tapi harus benar-benar
> dipastikan bukanya masing-masing platform. jangan sampai dari 13 hanya 10 yang
> buka instagram, nah 3 nya ini ga kebagian, nah ini bahaya.

The fear is precise and correct: **silent partial coverage**. Three phones miss
a platform, nothing errors, nobody notices for a week. Everything below is
organised around making that outcome *impossible by construction* rather than
*unlikely by supervision*.

## 2. What already exists (read on `main`, 2026-09-08)

| # | Fact | Where |
|---|---|---|
| E1 | A schedule already has cron, IANA timezone, `onOverlap` (skip/queue/cancel-previous), `queueTimeoutSec`, `catchUp`, `jitterSec`, `priority`, and batch pacing | `packages/core/src/db/schema.ts:1201` |
| E2 | A schedule's device target is re-resolved at **every** firing, never frozen — a phone that joins the group or gains the label is in the next run | spec §4.7; `schedules/runner.ts` |
| E3 | A schedule's work target is `script` or `agent`. **There is no workflow target.** Spec §4.7 claims one; the code has none | `packages/core/src/api/schedules.ts:266`, `:459`; `schedules.scriptRef` |
| E4 | Plan 217 named this gap and left it: *"A schedule targeting a workflow — not built by any plan read for this one"* | `docs/plans/217-mvp-scripts-workflows-schedules.md:57` |
| E5 | `$run.index` / `$run.count` exist, and the executor's own comment states their purpose: *"the fact that lets a workflow divide a fleet into EQUAL shares"* — added by owner decision, 2026-09-05, precisely because `$random` cannot split 20 devices exactly 5/5/5/5 | `packages/core/src/jobs/executors/workflow.ts:139-155` |
| E6 | `$run.index` is `jobs.batchSeq`, assigned 0-based in final dispatch order | `packages/core/src/groups/dispatch.ts:189`, `:320` |
| E7 | The expression language has `%`, comparison, `&&`/`||`, a conditional, and 44 functions, over a closed AST with a hard fuel budget — no `eval`, no `new Function` | `packages/expr/src/ast.ts:9`, `functions.ts` |
| E8 | `switch` (up to `maxSwitchCases`) and `set` are core-owned nodes; two edges into one node merge, because a run has one cursor | spec §4.6; `packages/protocol/src/workflow.ts` |
| E9 | `shuffle` runs each member exactly once in a per-device random order, with `between`/`betweenMaxMs` gaps and `continueOnMemberFailure` | `packages/protocol/src/workflow.ts:383-460` |
| E10 | Per-run randomness is `deriveRandom(job_runs.seed, seq)` — different per device, **reproducible on replay and on resume** | `schema.ts:559`; `workflow.ts:339` |
| E11 | `run-workflow` is a real action verb with `target`, `concurrency`, `order: as-listed \| random`, `priority` and `pacing` | `packages/protocol/src/actions.ts:184-201` |
| E12 | A workflow batch gives **every job the same `params` blob** | `packages/core/src/groups/dispatch.ts:294`, `:316` (plan 700 E9) |
| E13 | The expression scope roots are `$params $nodes $input $run $now $random`. There is **no `$device`** | `packages/expr/src/ast.ts:14` (plan 700 E11) |
| E14 | Per-device durable state exists: `ctx.kv.device`, keyed on **stableId**, not on the row that changes on re-enrolment | `packages/sdk/src/types.ts:309`; `kv_entries.scope = 'device'` |
| E15 | Document ceilings: 50 nodes, 500 step executions, 6 h default total budget (`ENKAKU_WORKFLOW_MAX_TOTAL_MS`) | `workflow.ts:20`; `config/constants.ts:169` |
| E16 | The packs exist: tiktok `1.22.0`, youtube `0.18.0`, instagram `0.2.0` | `plugins/*/src/index.ts` |
| E17 | A four-behaviour warm-up on five devices already ran on the owner's 66-device farm, 2026-09-07 — and all five runs were recorded `failed` for one unreadable screen each, which is why `continueOnMemberFailure` exists | `workflow.ts:443-455` |

**Read E5, E9 and E10 together and the client's requirement B is already
shipped.** What is missing is only E3.

## 3. The guarantee is a property of the document, not an outcome of the scheduler

This is the whole design, and it is one sentence:

> **Do not model this as three cohorts that rotate. Model it as one run per
> device that contains all three platforms.**

The difference is not stylistic; it is the difference between the client's fear
being impossible and being likely.

**The wrong shape — three batches that rotate.** Batch 1: 13 phones on TikTok.
When it finishes, batch 2 re-targets those 13 to Instagram. Now coverage is an
*emergent* property of a chain of dispatches. Every one of these breaks it, and
breaks it silently:

- a phone goes offline between batch 1 and batch 2 — `createBatch` numbers only
  `resolved.usable` devices (E6), so the fleet quietly shrinks;
- `onOverlap: 'skip'` fires because batch 1 overran — the whole second leg
  never happens;
- `queueTimeoutSec` expires for the three slowest phones;
- someone re-runs one leg and not the others.

In every case the fleet ends the day with three phones short and **nothing in
the product is in an error state**. That is exactly the "3 nya ga kebagian" the
client is afraid of, and no amount of scheduler polish removes it, because the
guarantee is spread across three independent dispatches.

**The right shape — one run, three phases.** Device #7's run either walked
TikTok → Instagram → YouTube, or it is a **failed job with a named step**, on
the Jobs screen, in a batch whose status is the projection of its members. There
is no third outcome. Coverage stops being something to supervise and becomes
something to read off one row.

The consequences are all in our favour:

- **"Re-run failed"** already exists on a batch and is exactly the right
  recovery verb — it re-runs the phones that did not complete, and only those.
- The run's `workflow_steps` rows *are* the audit the client wants ("prove
  device #7 opened all three").
- `maxTotalMs` (E15, 6 h) bounds the day.
- Nothing new has to be invented to make it true.

## 4. The rotation: a Latin square over `$run.index`

`$run.index` is a device's 0-based position in its batch and `$run.count` is the
batch size (E5, E6). With three platforms and three phases, the platform for a
device at phase `p` is:

```
platform(index, p) = (index + p) % 3
```

That is a Latin square, and it gives the client both properties they asked for,
provably:

- **Exact shares at every phase.** At any phase, the fleet is split
  `⌈n/3⌉ / ⌊n/3⌋ / ⌊n/3⌋` — for 40 phones, 14/13/13, at phase 0, phase 1 and
  phase 2 alike. This is what `$random` cannot do: twenty independent draws land
  an exact 5/5/5/5 about 1% of the time (E5's own comment), and "roughly 13" is
  a different promise from 13.
- **Full coverage per device.** Over `p = 0,1,2`, `(index + p) % 3` visits every
  residue exactly once — **for every index, with no exceptions and no
  scheduling assumptions**. A device cannot miss a platform without its own run
  failing at a named step.

Concretely, as a document (about 20 of the 50 permitted nodes, E15):

```
start
  → set   { phase0 = ($run.index + 0) % 3 }
  → switch on phase0 → case 0: tiktok/warmup   ┐
                       case 1: instagram/warmup ├→ delay (jitter) →
                       case 2: youtube/warmup   ┘
  → set   { phase1 = ($run.index + 1) % 3 }
  → switch … (same three script nodes' siblings) → delay →
  → set   { phase2 = ($run.index + 2) % 3 }
  → switch … → finish
```

Unrolled rather than looped, deliberately: a loop makes the reachable graph
cyclic, which fires `W_WORKFLOW_LOOP` and makes `checkWorkflow` **give up on the
budget entirely** (`workflow-check.ts:821-835`). Unrolled, the checker can prove
the whole day's worst-case duration at publish time. Three phases is also the
honest limit of `maxNodes: 50`; five platforms × five phases is not a document,
it is the signal to build a real cohort object.

**Daily variation comes free.** Dispatch the batch with `order: 'random'` (E11)
and `batchSeq` — and therefore `$run.index` — is drawn fresh each day by
Fisher-Yates over `crypto.getRandomValues` (`dispatch.ts:79`). The split stays
exactly 14/13/13; *which* phone opens TikTok first changes every day. The exact
share and the daily variation are not in tension.

## 5. The trap, and why it is worth a section of its own

Plan 700 F1 is the most important finding in this repository, and the client's
brief walks straight past it.

The next sentence after "each device gets all three platforms" is always **"and
each device uses its own account"**. Written the obvious way —
`at($params.accounts, $run.index)` — that is a silent account-loss bug, for
three reasons plan 700 E10 already documents:

- `order: 'random'` **shuffles the numbering on purpose** — the very control §4
  recommends for daily variation;
- only `resolved.usable` devices are numbered, so **one offline phone shifts
  every assignment after it by one**;
- a batch position is not stable across runs at all.

Account A posts from phone 1 on Monday and phone 7 on Tuesday. That is the exact
signal the platforms these packs drive use to ban.

So the line is:

| Use of `$run.index` | Verdict |
|---|---|
| Splitting the fleet into equal platform shares (§4) | **Safe and intended** — this is the documented purpose it was added for (E5) |
| Selecting which account, persona, proxy or SIM a device uses | **Unsafe** — plan 700 F1; needs the identity object of plan 700 D-B |

Per-device identity must come from something keyed on **stableId**, not on batch
position: `ctx.kv.device` today (E14), a first-class `account` object when plan
700 D-B is funded. Plan 700 D-B's last bullet — a `checkWorkflow` warning for any
expression indexing a parameter array by `$run.index` — should ship **with this
feature, in the same change**, not after it. Shipping the rotation without that
warning is shipping the footgun with a loaded example next to it.

## 6. The four levers of per-device uniqueness

The client's "meninggikan keunikan masing-masing devices" is four different
things. Three have a home today; one does not.

| Lever | Mechanism | Status |
|---|---|---|
| **Order of behaviours** | `shuffle` node — each member exactly once, a different order per device, reproducible on replay via `job_runs.seed` (E9, E10) | exists |
| **Timing** | `shuffle.between` / `delay` with `{ expr: '1000 + $random * 9000' }`; batch `pacing.deviceDelayMs`; `jitterSec` on the schedule | exists |
| **Which platform, when** | the Latin square of §4 | exists |
| **Persona / content / account** | `ctx.kv.device` (E14) — and **only** that. Not `$run.index` (§5) | exists as storage; has **no product surface, no `$device` expression root (E13), and no per-member params (E12)** |

The fourth is where a plugin genuinely belongs — and note what kind of plugin:
one that **supplies a node and owns device-scoped state**, e.g. a `warmup/persona`
script node returning `{ persona, minutesToday, lastPlatform }` read from
`ctx.kv.device`, which downstream `gate`/`switch` nodes branch on. That is a
capability provider. It is not a document generator, and the distinction is the
answer to the CEO's question.

## 7. What must actually be built

Three items, in strict order of value. Only the first is a blocker.

### 7.1 A schedule may target a workflow (the only real gap)

`schedules` gains a workflow work target, following **exactly** the precedent
plan 68 set for agent schedules: a companion table keyed on `scheduleId`, not
new columns on `schedules` — because `ScheduleRow` is built as a fully-typed
literal in two test files that may not be edited (`schema.ts:1291-1309` records
the reasoning). The runner branches to `createWorkflowBatch` instead of
`createBatch`, passing the `concurrency` / `order` / `priority` / `pacing` it
already stores through unchanged.

Everything else a daily warmup needs — cron, timezone, `onOverlap: 'skip'`,
`queueTimeoutSec`, `catchUp`, target re-resolution at every firing (E2) — is
already there and needs no change. Estimated shape: one migration, one companion
table, one branch in `schedules/runner.ts`, one branch in `api/schedules.ts`,
one Studio field on the Schedules tab.

### 7.2 The `$run.index`-as-identity warning (plan 700 D-B, last bullet)

Ships with 7.1, not after it. §5 is the reason.

### 7.3 A warmup pack that owns per-device persona state

A plugin exposing a `persona` node over `ctx.kv.device`, plus the three
platform warmup scripts as node-capable members. Not a document generator.
Remember the seeding rule: editing anything under `plugins/*/src/` requires
bumping the version in all three sites, or the change never reaches a farm that
has already booted.

## 8. Risks, stated with numbers

| # | Risk | Mitigation |
|---|---|---|
| K1 | **A member failure kills the day's coverage.** Measured, not hypothetical: five devices, four behaviours, 2026-09-07 — 7 of 12 scripts succeeded and **all five runs were recorded `failed`**, six minutes of real work discarded (E17) | `continueOnMemberFailure: true` on every warmup `shuffle`. For the phase switches, an `onFailure` edge to the next phase's `set` — a device that cannot open Instagram should still get YouTube |
| K2 | **The day does not fit.** 40 devices × 3 phases × ~15 min ≈ 45 min per device if the fleet runs fully parallel; at `concurrency: 10` it is four waves and ~3 h | Size `concurrency` against the measured per-platform duration before the first schedule is created; the 6 h `maxTotalMs` (E15) is a ceiling, not a plan |
| K3 | **`onOverlap: 'skip'` silently skips a whole day** if yesterday overran | `lastFireOutcome`/`lastFireDetail` already record the decision (`schema.ts:1276`); this must be surfaced on the schedule row, or the client's exact fear returns one level up |
| K4 | **No automatic catch-up for *failed devices*.** `catchUp` covers a missed cron fire, not three phones that failed | Today: "re-run failed" on the batch, by an operator. If that is not acceptable, a second schedule later in the day targeting only-failed jobs is a real feature and does not exist |
| K5 | **`maxNodes: 50` binds at 3 platforms × 3 phases (~20 nodes)** | Fine now. Four platforms × four phases (~34) still fits; five × five does not. That ceiling is the trigger to build a cohort object, not to raise the limit |
| K6 | **Selector fragility dominates everything above.** Plan 700 E7/E8: the six most recent non-release commits are one bug class, and the owner's first two-device warm-up scored 0 of 6 | Nothing in this plan improves it. Plan 700 D-C is the fix, and it outranks this plan on value |

## 9. What the owner must decide

| # | Decision | Blocks |
|---|---|---|
| Q1 | Build 7.1 (schedule → workflow)? | Everything. Without it "setiap hari nyala" is a person pressing Run |
| Q2 | Confirm the §3 shape: **one run per device containing all three platforms**, not three rotating cohorts. This is the guarantee the client is buying | §4, and the whole recovery story |
| Q3 | Confirm §0's rejection of a workflow-generating plugin | 7.3's scope |
| Q4 | Ship 7.2's warning with 7.1? Recommended **yes** — it is a day of work against a class of silent account loss | §5 |
| Q5 | Is per-device *identity* (accounts/personas) in scope for this client? If yes, plan 700 D-B is a prerequisite, not a follow-up — and this plan should wait behind it | 7.3, and the honest answer to "keunikan tiap device" |
| Q6 | K4: is operator-driven "re-run failed" acceptable recovery, or is an automatic catch-up fire required? | A feature that does not exist today |

## 11. Handoff report

_Not applicable: this plan is a decision document and is not executed._
