# 316 — Sub-groups and phases that run one after another

> Status: partial — the software is built and verified (scoped tests, typecheck, a scripted 80-device simulation); the owner smoke on real phones (G7, G8 on hardware) is still open. Decided by the CTO on the owner's instruction, 2026-09-14.
> Ships: `packages/core/src/groups/pacer.ts` (sequential mode), `$run.repeat`, batch order `number`
> Depends on: 94 (batch pacing), 211 (runs), 313 (batch pacing on run-workflow), 314 (warm-up rotation), 315 (plugin workflows)
> Spec references: §4.6 (workflows), §10 (queue)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A batch can run its sub-groups one after another: sub-group N+1 is released only when every member of sub-group N has settled | `pacing.sequential: true` with `waveSize` | `pacer.test.ts` planSequentialStep 9/9; `job-store.test.ts` held claim; `dispatch.test.ts` real pacer | yes |
| G2 | In the same mode a repetition (a **phase**) starts only when the whole previous phase has settled, and its sub-groups are released in order again | `repeatCount > 1` | `pacer.test.ts` (80 phones, sub-groups of 27, 3 phases → 9 releases and 2 phase starts in order); `dispatch.test.ts` | yes |
| G3 | A batch with repetitions left is never reported finished between phases | pacer runs before the status is recomputed | `status.test.ts` phase-boundary test | yes |
| G4 | A core restart mid-batch releases what is due instead of leaving runs held forever | boot sweep re-evaluates every sequential batch | `replanAfterRestart` calls `pacer.advance`, the planner the tests pin | yes (by construction) |
| G5 | A workflow knows which phase it is in | `$run.repeat` (0-based `job_runs.batch_repeat`) | `workflow-resolve.test.ts` `$run.repeat` | yes |
| G6 | A batch can be ordered by device number, so consecutive sub-groups mix the platforms evenly | `order: 'number'` | `dispatch.test.ts` order by number | yes |
| G7 | Schedules and Run workflow expose all of it | Studio schedule dialog: sub-group size, one-after-another switch, order by number | typecheck; owner smoke pending | software yes, smoke pending |
| G8 | `smm/warmup-rotation` follows the owner's model and its pace is configurable | platform = `($device.number + slot + $run.repeat + day) % 3`; gap, amount and start delay are parameters | scripted simulation: every sub-group 9/9/9 (8 in the last), 80/80 devices meet all three platforms in 3 phases; slow and fast pace stay inside every script's limits | software yes, hardware pending |

## 1. The owner's model

Eighty phones, one daily run. Split into three platform groups (TikTok, Instagram, YouTube), each split into three sub-groups. Session 1 runs sub-group 1 of every platform; then session 2; then session 3. That is one phase: every phone ran one platform. Then the platform groups swap and the three sessions run again, and again — so in one day every phone warms up every platform, and at no moment are all phones doing the same thing. Inside a session each phone's activities are shuffled with random gaps. The pace (gaps, how much each activity does) is the operator's choice.

## 2. What was missing

- Sub-groups were waves in TIME (`deviceIntervalMs` ladder), not barriers, and only for the first repetition.
- A repetition was planned per device the moment that device settled, so a phone in session 1 started phase 2 while sessions 2 and 3 of phase 1 were still running.
- A workflow could not see the repetition, so the platform could not rotate between phases.
- Batch order was resolution order, so a sub-group of 27 did not hold 9 phones of each platform.
- A batch whose last member settled was marked finished BEFORE the pacer planned the next repetition, and the pacer then refused to plan on a finished batch.

## 3. Decisions

1. **One flag, `sequential`, on batches and schedules** (default false; every existing batch unchanged). When true, `waveSize` groups the members in batch order, `deviceIntervalMs` is the wait after a sub-group finishes, `intervalMs` is the wait after a phase finishes, and `deviceDelayMs` still jitters each device inside its sub-group.
2. **A held run is an ordinary queued run with `job_runs.held = 1`** and its sub-group in `job_runs.batch_wave`. The claim skips held runs. Nothing else in the queue changes, and a held run is visible as queued.
3. **One pure planner** (`planSequentialStep`) decides, from the members' runs, what to release next: nothing, the next sub-group of this phase, or the next phase. `onMemberSettled` and the boot sweep both call it, so restart safety is the same code as normal operation (actions.ts's own objection to a barrier — "a core that restarts mid-batch would leave them held" — is answered by the sweep).
4. **The pacer runs before the batch status is recomputed**, so a phase boundary produces the next phase's queued runs before the status is derived. This also fixes the same latent bug for non-sequential repetitions.
5. **`$run.repeat`** is the run's `batch_repeat` (0 for a run outside a paced batch).
6. **`order: 'number'`** sorts members by device number ascending; unnumbered devices keep resolution order after them.
7. **A queue timeout applies to the first sub-group only.** A held run is created with no expiry: its release time is not known, and expiring a run that was never allowed to start would fail a phone for waiting its turn.

## 9. Open questions

None blocking. Studio does not yet label a held run "waiting for its sub-group" (it shows queued).

## 11. Handoff

### 11.1 What changed

| Layer | File | Change |
|---|---|---|
| protocol | `src/messages/batch.ts` | `BatchOrderSchema` adds `number` |
| protocol | `src/actions.ts`, `src/messages/schedule.ts` | `pacing.sequential`, `ScheduleInfo.sequential` |
| protocol / expr | `src/workflow-resolve.ts`, `expr/src/eval.ts` | `ResolveScope.runRepeat` → `$run.repeat` |
| core | `db/schema.ts`, `drizzle/0087_careless_bucky.sql` (index **87**) | `job_runs.held`, `job_runs.batch_wave`, `batches.sequential`, `schedules.sequential` |
| core | `groups/pacer.ts` | `planSequentialStep` (pure), sequential `planFirst`, `advance`, boot sweep |
| core | `groups/status.ts` | pacer before status (decision 4) |
| core | `groups/dispatch.ts` | `orderMembers` (`number`), `sequential` on the batch row |
| core | `queue/job-store.ts` | claim skips `held` |
| core | `jobs/runs/store.ts`, `jobs/executors/workflow.ts` | `AddRunInput.held/batchWave`; `runRepeat` into every scope |
| core | `api/schedules.ts`, `schedules/runner.ts` | `sequential` stored, patched, dispatched |
| studio | `components/schedules/ScheduleDialog.tsx` | sub-group size, "One after another", order "By device number" |
| smm 0.16.0 | `workflows/warmup-rotation.ts` | platform by `$run.repeat`; `gapMinSec`, `gapMaxSec`, `amount`, `startDelayMaxSec` |

### 11.2 Verification

- `bun test` scoped: `groups/pacer`, `groups/dispatch`, `groups/status`, `queue/job-store`, `protocol/workflow-resolve`, `smm/index` — 139 pass; the fixtures the new columns touched (`executors/install`, `executors/push`, `runs/watcher`, `schedules/runner`) — 48 pass.
- `bun run typecheck` clean; `check-plan-status`, `check-design-tokens`, `check-routes` pass; `build:packs` bundles smm 0.16.0.

### 11.3 Open

The owner smoke: a schedule with 3 repetitions, sub-groups of 27, order by device number and One after another, on a small label first (e.g. 6 phones, sub-groups of 2).
