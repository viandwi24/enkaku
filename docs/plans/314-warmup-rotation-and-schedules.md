# Plan 314 — Warmup : the daily platform rotation, the coverage guarantee, and the one thing it must not be built on

> Status: implemented (software) — the owner approved the whole build on 2026-09-08 ("saya ingin anda kerjakan semuanya… hasil akhirnya semua fiturnya lengkap sesuai yang dimau user"). All six items of §10.13 shipped; §12 is the handoff.
> Ships: packages/core/src/registry/device-facts.ts
> Owner decisions so far (2026-09-08): **Q1 yes** — build the workflow work target. **Q5 deferred** — accounts are out of scope; the working assumption is *one device owns all three platforms, whatever the account*. A second brief the same day added **multiple warmup sessions per day at different hours**, which supersedes §3's single-run shape; the amendment is §10, and §3 must be read through it.
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

> **Amended by §10.** The reasoning below is intact and still decides the design; what changed is where the run boundary falls. The client's second brief (2–3 warmup sessions a day at different hours) makes a single run that walks all three platforms back-to-back both unwanted *and* unbuildable — `WORKFLOW_LIMITS.maxDelayMs` is **five minutes**, with the stated reason *"Longer waits are a schedule, not a workflow"* (plan 303 §3.4). §10 moves the phase boundary from a `delay` node to a schedule firing and shows what that costs.

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

## 10. Amendment — sessions: several warmups a day, at different hours (client brief 2, 2026-09-08)

> *"beberapa hal itu jalan di jam sekian sekian, berarti random dong? satu device atau satu grup device bisa jalan di jam tertentu. bisa aja di jam segini warmup, terus di jam berapa warmup lagi. jadi sehari bisa 2 kali atau 3 kali warmup per satu device."*

### 10.1 This forces the phase boundary out of the document, and the repo already decided that

§3–§4 put three platform phases inside **one run**, separated by `delay` nodes.
That is not buildable, and the reason is a decision already on the record:

| Fact | Where |
|---|---|
| `WORKFLOW_LIMITS.maxDelayMs` is **5 minutes**, documented as *"The largest a single `delay` node may declare. Longer waits are a schedule, not a workflow"* | `packages/protocol/src/workflow.ts:36`, plan 303 §3.4 |

So a five-hour gap between TikTok and Instagram was never a `delay`. Good — the
client's brief and the engine's own doctrine agree: **a gap measured in hours is
a schedule firing, not a node.** The phase boundary moves out of the document.

A run therefore becomes **one device, one session, one platform**. What §3
warned about now applies to us, and §10.3 is how it is paid for rather than
hand-waved.

### 10.2 The session model

One workflow document, `warmup`, whose single `switch` picks a platform. One
**schedule per session**, each carrying its slot as an ordinary parameter:

| Schedule | Cron (`Asia/Jakarta`) | `params` |
|---|---|---|
| Warmup pagi | `0 8 * * *` | `{ slot: 0 }` |
| Warmup siang | `0 13 * * *` | `{ slot: 1 }` |
| Warmup malam | `0 19 * * *` | `{ slot: 2 }` |

and the same Latin square as §4, with the slot supplied by the schedule instead
of by a loop counter:

```
platform = ($run.index + $params.slot) % 3
```

Three schedule rows rather than one is the right shape, not a cost. Each is
visible on the Schedules tab, each can be disabled alone, each carries its own
IANA timezone (`schedules.timezone`, never a UTC offset — offsets break on DST),
and — the answer to *"satu grup device bisa jalan di jam tertentu"* — **each can
target a different group or label**, because a schedule's device target is
already `{groupId} | {labelIds} | {deviceIds}` and is re-resolved at every firing
(E2). Group A at 08:00 and Group B at 10:00 is two schedule rows and no code.

**Deriving the slot from the clock instead was considered and rejected.**
`floor($now / 28800000) % 3` looks tempting and is stateless, but `$now` is
epoch milliseconds, so its 8-hour buckets are UTC buckets: 08:00 and 13:00 WIB
are 01:00 and 06:00 UTC, which land in the *same* bucket and would hand both
sessions the same platform. A slot that is a schedule parameter is timezone-safe
because the schedule already owns the timezone.

### 10.3 The honest cost: coverage is emergent again, and it self-heals

Under §3 a device either covered all three platforms or its run failed visibly.
Under §10.2 a device that is offline at 13:00 simply misses Instagram, and
nothing is in an error state — the exact failure the client named.

What saves it is that the rotation **keeps turning**. If the slot advances across
days (§10.4), a missed platform is *delayed, not lost*: the device meets it again
within one cycle. That is a strictly better property than §3 had, where a failed
run needed an operator to press "re-run failed".

It is not a substitute for being able to see it. Two things are needed, and
neither is large:

1. **A coverage view** — per device, the platforms covered over the last cycle,
   read from the runs that already exist. This is reporting over `workflow_steps`
   and the `set` node's recorded output, not new scheduling machinery. It is the
   thing that answers *"buktikan device #7 kebagian semua"*.
2. **`continueOnMemberFailure: true`** on every warmup `shuffle` (K1) — otherwise
   one unreadable screen still discards the whole session, as measured on
   2026-09-07.

### 10.4 Sessions per day vs platforms: the decision the client has not made

With three platforms, **daily coverage requires three sessions**. The client said
"2 kali atau 3 kali". Those are two different products:

| Sessions/day | Slot source | Coverage window | Verdict |
|---|---|---|---|
| **3** | `slot` fixed per schedule, `0..2` | **every calendar day** | simplest; recommended if "kebagian rata" means *per hari* |
| **2** | `slot` must advance across days, or the same two platforms repeat forever | **1.5 days** (any 3 consecutive sessions) | fine, but "rata" now means *per cycle*, not *per day* — the client must agree to that sentence |
| **N, varying** | a running ordinal | N/A | do not build; the guarantee stops being statable |

For the 2/day case the slot cannot stay a constant per schedule, or device #0
does TikTok every morning and Instagram every afternoon **and never opens
YouTube at all**. It needs a day component:

```
slot = ($params.slot + floor($now / 86400000)) % 3
```

`floor` is in the function table, and the UTC-bucket objection of §10.2 does not
apply here: this bucket is a whole day, and any Jakarta session between 07:00 and
23:59 WIB falls inside one UTC day. A session scheduled at 02:00 WIB would not,
and is the one case to refuse or special-case.

### 10.5 "Random jam" is two knobs, and one of them does not exist yet

The client's *"berarti random dong?"* is two separate things:

| Want | Mechanism | Status |
|---|---|---|
| The whole session drifts, so the farm never starts on the exact minute | `schedules.jitterSec` — a fresh draw per fire, shifts the WHOLE dispatch | **exists** (`runner.ts:146`) |
| **Each device starts at its own random time** inside a window | `pacing.deviceDelayMs` — an independent draw per member, *"start them together but not at the same instant"* | **exists on a manual run, MISSING on a schedule** |
| Devices start in a fixed ladder | `deviceIntervalMs` | exists on both |
| Which device leads changes daily | `order: 'random'` — Fisher-Yates over `crypto.getRandomValues` | exists on both |

**Gap 7.4 — `deviceDelayMs` on a schedule.** `schedules` carries `repeatCount`,
`intervalMinMs`, `intervalMaxMs` and `deviceIntervalMs`, and the runner builds
its `pacing` from exactly those four (`runner.ts:276-280`) — so `deviceDelayMs`
falls to its `[0, 0]` default on **every scheduled run**. A manual *Run workflow*
can stagger each phone by a random amount; a schedule cannot. This is the same
class of defect CLAUDE.md already names ("a constant nobody sends is a knob that
does not turn"), one level down: a column nobody has.

It matters here more than anywhere else, because *"tiap device jalan di jam yang
beda-beda"* is **exactly** `deviceDelayMs`, and the alternative reading — one
schedule per device — is 40 schedule rows and is not a design.

The mechanism behind it is sound at hour scale, which is what makes this worth
doing rather than working around: the pacer bakes the stagger into the member
run's own `notBefore` **column** (`pacer.ts:90`, plan 94 §3.8) rather than
holding an in-memory timer, so a two-hour spread survives a core restart, and
`rearm()` arms a single timer at the earliest future `notBefore` across the
whole farm. Two new columns and one line in the runner's `pacing` literal.

### 10.6 What NOT to use for this

`schedules.repeatCount` + `intervalMinMs`/`intervalMaxMs` looks like it answers
"2–3 warmups a day" in one row, and the interval is genuinely drawn per device
per repetition (`pacer.ts:128`). It is still the wrong tool: a repetition is
another **run of the same job with the same params** (plan 211 §3.2 decision 3),
so `$params.slot` is identical across all of them and every repetition picks the
**same platform**. It repeats a warmup; it does not rotate one. Use it if a
device should do TikTok twice; never to express the rotation.

### 10.7 Revised build list

7.1 (schedule → workflow) is unchanged and remains the blocker. Add:

- **7.4 — `deviceDelayMs` on a schedule** (§10.5). Two columns, one runner line,
  one Studio field. Small, and the client's "random jam" is unbuildable without it.
- **7.5 — the coverage view** (§10.3 item 1). Reporting only; no new scheduling.

7.2 (the `$run.index`-as-identity warning) survives Q5's deferral **unchanged and
still ships with 7.1**. Deferring accounts is precisely what makes the warning
urgent: the moment someone does add accounts, `at($params.accounts, $run.index)`
is the first thing they will write, and by then three schedules a day will be
reshuffling that index six ways. A guard rail is cheapest before the road opens.

### 10.8 Decisions this amendment adds

| # | Decision | Blocks |
|---|---|---|
| Q7 | **Two sessions a day or three?** Three gives daily coverage; two moves "rata" to a 1.5-day cycle and needs the day component of §10.4 | the slot formula, and the sentence we promise the client |
| Q8 | Do all devices share one session timetable, or do groups get their own hours? Groups cost nothing — one schedule row each | the number of schedule rows, not the design |
| Q9 | Build 7.4 (`deviceDelayMs` on a schedule)? Without it, "random jam per device" is not expressible on a schedule at all | §10.5 |
| Q10 | Is the coverage view (7.5) in the first delivery, or does the client accept the self-healing rotation of §10.3 without a report? | scope of the first release |

### 10.9 Owner decision, 2026-09-08: Q7 = three sessions, via three schedules

Recorded: *"warmup itu dijalankan 3 kali… berarti nanti pakai fitur schedule aja."*

Q7 is answered **3**, and Q8 follows it: the sessions are three ordinary
schedule rows, not a new concept. This is the right call and it simplifies the
design — with three sessions and three platforms, the day-component of §10.4 is
**not needed**, and `platform = ($run.index + $params.slot) % 3` gives coverage
every calendar day.

It also surfaces two defects that only exist *because* the rotation is now split
across three dispatches. Neither is a reason to change the decision; both must be
built with it.

### 10.10 The defect: `$run.index` cannot carry a rotation across three batches

§4 was safe because all three phases lived in **one** run, where `$run.index` is
read once and cannot move. Split across three firings, it moves — and when it
moves, coverage breaks silently, which is the exact outcome the client called
*bahaya*.

Two independent causes, both already documented in this repository:

1. **`order: 'random'` reshuffles the numbering on purpose** — the very control
   §10.5 recommends for looking human. Under it, a device is index 5 in the
   morning and index 8 at noon, so its three platforms are three independent
   draws. Coverage is not merely unguaranteed; TikTok three times in one day is
   an ordinary outcome.
2. **Only `resolved.usable` devices are numbered** (`dispatch.ts:189`), so **one
   offline phone shifts every device after it by one**, for that session only.

Worked, with four phones A B C D at indices 0–3, `as-listed`, and C offline at
the noon session only:

| | slot 0 (all up) | slot 1 (C down) | slot 2 (all up) | covered |
|---|---|---|---|---|
| A | `(0+0)%3` = TikTok | `(0+1)%3` = Instagram | `(0+2)%3` = YouTube | ✅ all three |
| B | `(1+0)%3` = Instagram | `(1+1)%3` = YouTube | `(1+2)%3` = TikTok | ✅ all three |
| C | `(2+0)%3` = YouTube | — offline — | `(2+2)%3` = Instagram | ⚠️ missed one, recovers next cycle |
| D | `(3+0)%3` = TikTok | `(2+1)%3` = **TikTok** | `(3+2)%3` = YouTube | ❌ **never opened Instagram** |

D is the finding. D was **online all day**, every one of its three runs
**succeeded**, no job is red, no batch is red — and D did not open Instagram.
Nothing in the product can currently tell anyone that. C, which actually was
offline, is the *harmless* case: it missed one slot and the rotation hands it
back next cycle.

So the collateral damage of one offline phone lands on a **different, healthy**
phone, and is invisible. This is plan 700 E10's warning arriving one category
early: it was written about identity, and it turns out to bite **coverage** the
moment the rotation spans more than one batch.

### 10.11 The fix: rotate on the device's own number, not its batch position

The offset must be a property **of the device**, stable across firings. The farm
already has exactly one: `device_numbers.number` — a unique integer keyed on
`stableId`, durable, operator-visible, and *literally the `#` written on the
phone's physical label* (spec §4.1, `schema.ts:364`).

```
platform = ($device.number + $params.slot) % 3
```

Every failure of §10.10 disappears:

| Property | `$run.index` | `$device.number` |
|---|---|---|
| Survives `order: 'random'` | ❌ that is what it shuffles | ✅ unaffected |
| Survives an offline phone | ❌ shifts everyone after it | ✅ nobody else moves |
| Stable across the day's three sessions | ❌ | ✅ |
| Stable across days | ❌ | ✅ |
| An operator can verify it by looking at the phone | ❌ | ✅ it is the label |
| Fleet split at one slot | exact 14/13/13 | **approximate** — see below |

**The one thing it costs**, stated plainly: device numbers are allocated
monotonically and deleted devices leave gaps, so `number % 3` over a real farm
is near-equal rather than exactly equal — 15/12/13 instead of 14/13/13 on an
unlucky numbering. That is the whole trade, and it goes the client's way: they
called the coverage failure *bahaya* and never asked for the split to be exact to
the device. **Guaranteed coverage with an approximate split beats an exact split
with silent gaps.**

This needs `$device` in the expression scope, which does not exist today
(plan 700 E11). It is **one read-only root, no grammar change** — plan 700 D-B
already lists it, and this is the use case that makes it urgent rather than
nice-to-have. Ship it with 7.1.

Note what this does *not* license: `$device.number` is safe as a **rotation
offset** because a wrong offset costs one mistimed platform. It is **not** an
account key — a stable number is necessary for identity but nowhere near
sufficient, and §5 and plan 700 D-B still own that question. 7.2's warning stands
unchanged.

### 10.12 The second defect: three schedules is a copy-paste trap

"Pakai fitur schedule aja" is right, and the obvious way an operator does it is
to create one schedule and duplicate it twice. If `slot` is a free-text parameter
they must remember to change, the duplicate carries `slot: 0` three times — and
the farm runs **TikTok three times a day, forever, covering nothing else**, with
three green batches and no error anywhere.

That is the client's stated fear, reintroduced by a UI being too generic. Two
guards, both small:

1. **A "Warmup" template that creates the three schedules together**, slots
   pre-filled 0/1/2, named *pagi / siang / malam*. One action, three rows. The
   operator edits times and targets, never the slot.
2. **A warning when two enabled schedules run the same workflow with the same
   `slot`** — the same class of guard as `checkWorkflow`'s existing warnings, on
   the Schedules tab rather than in the document.

### 10.13 Build list after Q7

| # | Item | Size | Why it cannot be dropped |
|---|---|---|---|
| 7.1 | Schedule → workflow work target | small | nothing runs daily without it |
| **7.6** | **`$device` root in the expression scope** (`number`, `stableId`, `label`) | **small — one root, no grammar change** | **without it the three-session rotation is provably wrong (§10.10), not merely imprecise** |
| 7.4 | `deviceDelayMs` on a schedule | small | "jam acak per device" is otherwise inexpressible |
| 7.2 | `$run.index`-as-identity warning | small | §5; unaffected by Q5's deferral |
| 7.7 | Warmup schedule template + duplicate-slot warning | small | §10.12 |
| 7.5 | Coverage view | medium | the client's proof; §10.3 |

7.6 is new and it outranks everything except 7.1. §10.10's table is the argument:
without it, we would ship a system that reports three green runs for a phone that
covered two platforms.

## 11. Handoff report

See §12 — this plan stopped being a decision document when the owner approved the build.

## 12. Handoff report

Executed 2026-09-08 on `claude/device-warmup-scheduling-ipmusm`, in the order
§10.13 ranks them. Every item shipped; nothing was descoped.

### 12.1 What shipped

| # | Item | Where |
|---|---|---|
| 7.6 | `$device` expression root (`number`, `stableId`, `label`, `group`, `labels`) | `packages/expr/src/{ast,eval}.ts`, `packages/protocol/src/workflow-resolve.ts`, `packages/core/src/registry/device-facts.ts`, the executor's six scopes, Studio's preview |
| 7.1 | A schedule may target a workflow | `schedule_workflow_targets` (migration `0083`), `ScheduleWorkTargetSchema`'s third member, `dispatchWorkflowFire` in `schedules/runner.ts`, `api/schedules.ts`, the dialog's third tab |
| 7.4 | `deviceDelayMs` on a schedule | `schedules.device_delay_{min,max}_ms` (same migration), `schedulePacing()`, the dialog's per-device window |
| 7.2 | `W_WORKFLOW_INDEX_AS_IDENTITY` | `packages/protocol/src/workflow-check.ts` |
| 7.5 | Rotation coverage | `GET /api/workflows/:name/coverage`, `packages/protocol/src/api/workflow-coverage.ts`, `components/scripts/CoverageDialog.tsx` |
| 7.7 | Rotation template + duplicate warning | `findRedundantSchedules` (protocol), `components/schedules/RotationDialog.tsx`, the badge in `SchedulesList.tsx` |

### 12.2 Deviations from the plan as written

1. **§10.11 said `$device` was needed for correctness; it also turned out to be
   needed for honesty.** A device whose number reservation was released reads
   `null`, and arithmetic on `null` throws `E_EXPR_TYPE`. The plan did not say
   what should happen there. Failing the step by name is the choice made,
   because the alternative — treating it as `0` — hands every numberless phone
   the same branch on every slot, forever, with nothing red to notice. That is
   the same failure class the whole plan exists to remove, so it would have
   been a strange thing to introduce while removing it.

2. **`ScheduleRow` had to be edited after all.** `db/schema.ts`'s
   `scheduleAgentTargets` comment records plan 68's acceptance criterion that
   two fully-typed `ScheduleRow` literals must keep compiling untouched. The
   workflow target honours it (a companion table). `deviceDelayMs` cannot: it
   is a pacing property of the schedule itself, and a companion table for two
   integers would be worse than the edit. Both literals were updated. That
   constraint was plan 68's own acceptance criterion, not a standing rule, and
   this is the first plan to need it relaxed — worth stating plainly rather
   than leaving the comment to imply it still holds absolutely.

3. **§10.12's duplicate warning is not keyed on a "slot".** The plan described
   it as "two enabled schedules with the same `slot`". Building that would put
   a warm-up-specific concept in the core, where a slot is really just a
   workflow's own parameter named by whoever authored it. `findRedundantSchedules`
   instead flags identical WORK — same workflow or script, same params, same
   devices, both enabled — which catches the slot case and every other
   copy-paste of the same shape, without the core learning a vocabulary that
   belongs to one workflow.

4. **A later fire re-snapshots the document.** Not specified either way in the
   plan. Without it, an operator edits a warm-up, sees it saved, and the farm
   keeps running the version from the schedule's first fire forever. Guarded on
   a settled latest run, because a run reads its document once at start.

5. **One unrelated fix rode along**: `webhook-service.test.ts` built its decoy
   as `` `x${secret.slice(1)}` `` and collided with the real secret on 1 run in
   64 (measured: 3 210 in 200 000). It turned this branch's CI red on a
   docs-only commit. Fixed rather than re-run, so the next person does not
   inherit it.

### 12.3 What is NOT built, and is the honest gap

- **No automatic catch-up for a device that failed a session** (§8 K4). The
  recovery is still an operator pressing "re-run failed", or the rotation
  turning again and handing the device the missed branch within one cycle. The
  coverage view (7.5) is what makes the gap visible; closing it is a feature
  nobody has asked for yet.
- **Accounts remain out of scope** (Q5, deferred by the owner). 7.2's warning
  shipped precisely because of that deferral, not despite it.
- **Selector fragility is untouched** and still dominates real-world success
  (plan 700 E7/E8, K6). Nothing here improves it.
- **No Studio tests**, per plan 200 §8.3. The three new components are covered
  only by `bun run typecheck` and the owner smoke.

### 12.6 Pre-release audit, 2026-09-08

The owner asked for a re-check before release. Four defects, found by reading
the diff adversarially rather than by re-running what had already passed. None
of them would have failed CI.

| # | Defect | Why the tests missed it |
|---|---|---|
| 1 | **`run-now` on a workflow schedule failed** while its cron firing worked. The daemon hands the workflow store to `createScheduleRunner`; `api/schedules.ts` builds its own `runnerDeps` for `run-now` and was not given one. | Every test called `fireOnce` directly with a fully-wired deps object. Nothing exercised the route's own closure. This is the worst asymmetry the feature could have: an operator builds a rotation, presses **Run now** to check it, sees `E_WORKFLOW_STORE_UNAVAILABLE`, and concludes the whole thing is broken — while the thing that runs every morning was fine. Now covered by a test that pins the parity. |
| 2 | **Deleting a workflow schedule orphaned its companion row.** `DELETE /:id` removed the agent companion and not the workflow one. | No test deletes a workflow schedule. Ids are UUIDs so nothing is mis-attributed, but the rows accumulate forever and the asymmetry invites the next person to trust the pattern. |
| 3 | **An `as`-cast**, which CLAUDE.md forbids outright. `paramsCompatibility` was handed `{} as ScheduleAgentTargetRow` for a workflow target. It worked only because the function tests that argument for truthiness and nothing else — a lie to the type system that becomes a real bug the first time the function reads a field. Replaced by the boolean it actually wanted. | Types cannot catch a cast; that is what a cast is for. |
| 4 | **The coverage endpoint had no bound.** It read every run the workflow had ever had and put all their ids into one `IN (...)`. Measured on this runtime's SQLite: 60 000 bound parameters are accepted, 100 000 throw `too many SQL variables`. At three sessions a day across forty phones that ceiling is roughly a year and a half out — far enough to ship, near enough to be certain of hitting, on the one screen an operator opens to be reassured. Rewritten as one bounded query per device, which removes the ceiling rather than raising it. | Tests run on a handful of rows. No fixture in this repo is large enough for an unbounded scan to look different from a bounded one. |

Also closed in the same pass: `docs/spec.md` §4.6/§4.7/§4.8 now describe the
workflow work target, the per-device pacing columns, the `$device` root and the
coverage read (`spec:check` listed the table and the route as gaps before this),
and CLAUDE.md/AGENTS.md gained the `$device.number` vs `$run.index` rule under
"Rules that get broken when you do not know them" — which is exactly what it is.

**What the audit did not change**: §12.3's gaps are all still open, and nothing
here has still met a phone. Four defects found by reading, in a diff whose tests
and gates were all green, is the argument for §12.5's owner smoke rather than
against it.

### 12.4 Verification

| Suite | Result |
|---|---|
| `bun test packages/expr/src/` | 188 pass |
| `bun test packages/protocol/src/` | 1 187 pass |
| `bun test packages/core/src/api/` | 587 pass |
| `bun test packages/core/src/jobs/` | 224 pass |
| `bun test packages/core/src/schedules/` | 24 pass |
| `bun test packages/core/src/groups/` | 46 pass |
| `bun test packages/core/src/workflows/` | 59 pass |
| `bun test packages/core/src/db/` | 69 pass |
| `bun test packages/core/src/queue/` | 34 pass |
| `bun run typecheck` | clean |
| `check-plan-status`, `check-agent-docs`, `check-routes`, `check-design-tokens`, `check-dead-code` | pass |

The full suite was not run — CLAUDE.md forbids it for an agent, and every
directory touched is listed above.

### 12.5 The owner smoke this still needs

Nothing here has met a phone. Before the client sees it:

1. Author a warm-up with a `slot` integer param and a `switch` on
   `($device.number + $params.slot) % 3`.
2. **New rotation** → three sessions → confirm three schedules appear, slots
   0/1/2, no `duplicate` badge.
3. Duplicate one by hand without changing its slot → the badge appears.
4. Let all three fire on a real group; confirm each phone's three runs took
   three different branches.
5. Open **Coverage** and confirm it says every device covered every branch.
6. Take one phone offline for the middle session and confirm the report names
   it — and that no OTHER phone's coverage moved, which is the property
   `$device.number` was introduced for.

