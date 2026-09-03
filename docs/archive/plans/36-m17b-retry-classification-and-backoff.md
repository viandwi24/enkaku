# Plan 36 — M17b : Retry Classification and Backoff

> Status: implemented — verified by the presence of the artefact below
> Ships: packages/core/src/jobs/failure-class.ts
> Depends on: Plan 22.1 (the coded errors that make classification possible) and Plan 23 (the device health tracker this feeds). Plan 35 is independent.
> Spec references: §9 (jobs), §10.2 (leases and heartbeats), §15 (device lifecycle).

---

## 1. Goals

- A job that fails because **the device went away** is treated differently from one that fails because **the script found a bug**.
- Infrastructure failures retry with exponential backoff and jitter; script failures do not silently burn attempts against a broken device.
- A device that keeps causing infrastructure failures is surfaced through the Plan 23 health tracker instead of quietly consuming every job's retry budget.
- Within a batch, an infrastructure failure can move the job to **another eligible device** rather than retrying against the one that is failing.
- Every retry records why it happened, so "this suite is flaky" becomes an answerable question.

## 2. Non-goals

- Changing `ScriptDefinition.retries` semantics for script-level failures. Authors keep the control they have.
- Automatic quarantine decisions. Plan 23 owns that; this plan only feeds it better signal.
- Reordering or re-prioritising the queue. Plan 21 owns scheduling policy.
- Retrying *within* a script (a flaky `waitFor`). That is the script's own concern.

## 3. Context and design decisions

### 3.1 Today every failure is the same failure

`packages/session/src/runner/job-runner.ts` loops attempts up to `meta.retries` (read from the child's `ready` message, `job-runner.ts:173`), with no delay between them and no inspection of *why* the previous attempt failed. `packages/core/src/jobs/executor-host.ts` settles the job on whatever comes back.

So these are handled identically:

- the phone was unplugged mid-run,
- adb timed out because the device is wedged,
- the scrcpy session died,
- `waitFor` did not find a button because the app genuinely regressed.

The first three are the farm's problem and are worth retrying, ideally elsewhere. The fourth is the *result* — retrying it three times just delays the report and, worse, can turn a real failure into a pass if the app is nondeterministic.

There is a second, quieter cost. A device with a failing USB cable produces infrastructure failures on every job it touches. Each job burns its full retry budget against that device before failing, so one bad cable multiplies into hours of wasted farm time — and nothing points at the cable.

### 3.2 Three classes, derived from codes we already have

Plan 22.1 gave every adb failure a code, and the session and runner layers have their own. Classification is therefore a lookup, not a heuristic:

| Class | Sources | Retry? |
|---|---|---|
| `infra` | `E_ADB_TIMEOUT`, `E_ADB_CONNECT_TIMEOUT`, `E_ADB_HANDSHAKE_TIMEOUT`, `E_ADB_UNAVAILABLE`, `E_DEVICE_NOT_READY`, `agent_offline`, session died, lease force-released, child killed by the OS | yes, with backoff, and prefer another device |
| `script` | `SCRIPT_ERROR`, `PARAMS_INVALID`, `WAITFOR_TIMEOUT`, `element_not_found`, `BAD_BUNDLE`, any error thrown by the bundle | only up to `ScriptDefinition.retries`, no backoff change |
| `timeout` | the job's own per-attempt timeout | script-class by default; see §3.3 |

`E_ADB_BUSY` is **not** infra — it means the queue was saturated, which is load. It retries immediately (short backoff) and never counts toward device health, exactly as Plan 23 §3.6 established.

Anything unrecognised is classified `script`. Defaulting an unknown failure to "retry as infra" would let a novel bug loop; defaulting to "report it" is the honest failure mode.

### 3.3 The job timeout is ambiguous, so it is configurable

A script that exceeds its timeout may be stuck on a broken device (infra) or genuinely slow/hung (script). Nothing in the signal distinguishes them.

Default: **script**. A timeout is the most common way a real regression shows up, and retrying it against a healthy device three times with backoff wastes ten minutes to report the same thing. `job.retry.timeoutIsInfra` flips it for teams whose devices are the usual culprit.

### 3.4 Two budgets, not one

`ScriptDefinition.retries` is the author's statement about their script. It must not be spent on the farm's problems.

So infra retries draw from a **separate** farm-level budget, `job.retry.maxInfraAttempts` (default 2). A job can therefore fail over twice for infrastructure reasons and still have its full script-level retry budget intact when it finally runs somewhere healthy.

The total is capped so a pathological device cannot loop forever: `attempts ≤ retries + maxInfraAttempts + 1`.

### 3.5 Backoff exists to let the device recover, not to be polite

A device that just dropped off USB needs seconds, not milliseconds, to re-enumerate. Retrying instantly guarantees a second failure and wastes an attempt.

Exponential with full jitter, which is what stops twenty batch members from retrying in lockstep:

```
delay = min(backoffMaxMs, backoffBaseMs * 2^(infraAttempt - 1))
actual = random(0, delay)      // full jitter
```

Defaults: base 2 000 ms, max 30 000 ms. The delay is spent **without holding the device lease**, so a waiting job does not block the device it is about to retry on — and, critically, does not block the device it may be about to *leave*.

### 3.6 Moving to another device, only where that is meaningful

For a job targeted at one specific device, "retry elsewhere" is not a thing the operator asked for — they picked that phone.

For a **batch member** (Plan 20), the target was a cluster, and any eligible device satisfies the intent. So on an infra failure a batch member is returned to the queue with its device binding cleared, and the batch's normal dispatch picks the next eligible device. If none is available it retries on the same device after the backoff.

`job.retry.rebindOnInfra` (default true) controls this, because a team pinning members to devices for comparison would want it off.

## 4. Technical design

### 4.1 Classification — `packages/core/src/jobs/failure-class.ts` (new)

```ts
export type FailureClass = 'infra' | 'script' | 'load'

export interface ClassifiedFailure {
  class: FailureClass
  code: string
  message: string
  /** True when this device should be blamed (feeds Plan 23 health). */
  blameDevice: boolean
}

export function classifyFailure(err: unknown, opts: { timeoutIsInfra: boolean }): ClassifiedFailure
```

A single exported table maps code → class, so adding a code is a one-line change with a test, never a scattered `if`. `load` is `E_ADB_BUSY` and friends: retried, never blamed.

### 4.2 Settings — `packages/protocol/src/settings.ts`

```ts
job: z.object({
  // … Plan 35's reset fields …
  retry: z.object({
    maxInfraAttempts: z.number().int().min(0).max(10).default(2)
      .describe('Extra attempts allowed when a job fails for infrastructure reasons (device lost, adb timeout). Separate from a script\'s own retries.')
      .meta({ title: 'Infrastructure retries' }),
    backoffBaseMs: z.number().int().min(100).max(60_000).default(2_000)
      .describe('First backoff delay; it doubles each infrastructure retry, with jitter.')
      .meta({ title: 'Retry backoff base (ms)' }),
    backoffMaxMs: z.number().int().min(1_000).max(300_000).default(30_000)
      .describe('Upper bound on the backoff delay.').meta({ title: 'Retry backoff cap (ms)' }),
    timeoutIsInfra: z.boolean().default(false)
      .describe('Treat a job timeout as an infrastructure failure rather than a script failure.')
      .meta({ title: 'Timeouts count as infrastructure' }),
    rebindOnInfra: z.boolean().default(true)
      .describe('On an infrastructure failure, let a batch member move to another eligible device.')
      .meta({ title: 'Move batch members after infrastructure failures' }),
  }).default({}),
}).default({}),
```

### 4.3 Runner and host changes

`packages/session/src/runner/job-runner.ts`:
- The attempt loop consults `classifyFailure` and keeps two counters (`scriptAttempts`, `infraAttempts`).
- Between attempts it awaits the jittered backoff for infra failures only.
- Each retry appends a log line naming the class, the code, and the delay.

`packages/core/src/jobs/executor-host.ts`:
- Reports the classification on the final settle: `jobs.error` keeps the message, and a new `jobs.failureClass` column records the class (one migration, nullable text).
- Calls `deps.health.note(serial, 'timeout', code)` for `blameDevice` failures, so Plan 23's circuit breaker sees them. `load` and `script` failures never do.
- When `rebindOnInfra` and the job has a `batchId`, requeues instead of settling: clears `deviceId`, sets status back to `queued`, increments a new `jobs.infraAttempts` column, and kicks the scheduler.

### 4.4 Reporting

- Job detail: the failure class as a badge beside the error, and each attempt listed with its class and backoff.
- Batch report (Plan 20): counts split into "failed (script)" and "failed (infrastructure)", so a batch that fell over because of a bad hub does not read as twenty broken tests.
- A `job.retry` device event on the `main` stream: `{ attempt, class, code, delayMs, rebound }`.

## 5. Implementation steps

**36.1 — Classifier.** `failure-class.ts` plus an exhaustive table test covering every code the codebase can emit today.

**36.2 — Settings.** The `job.retry` block (§4.2).

**36.3 — Migration.** `jobs.failureClass` (nullable text) and `jobs.infraAttempts` (integer, default 0); `bun run --cwd packages/core db:generate`.

**36.4 — Runner.** Two counters, classified retries, jittered backoff, log lines (§4.3).

**36.5 — Host, health, and rebinding.** Feed Plan 23's tracker; requeue batch members; record the `job.retry` event.

**36.6 — Reporting.** Job detail badges, batch split counts, event rendering.

## 6. Acceptance criteria

1. A job failing with `E_ADB_TIMEOUT` retries after a jittered backoff; one failing with `WAITFOR_TIMEOUT` does not consume the infrastructure budget.
2. Total attempts never exceed `retries + maxInfraAttempts + 1`.
3. Backoff doubles per infra attempt, is capped at `backoffMaxMs`, and is jittered — twenty simultaneous retries do not fire in lockstep (verified statistically in a unit test).
4. The device lease is **not** held during a backoff delay.
5. `E_ADB_BUSY` retries but never contributes to device health.
6. Infra failures reach Plan 23's health tracker; script failures never do.
7. A batch member failing for infra reasons is requeued and may run on another eligible device; with `rebindOnInfra: false` it retries in place.
8. `jobs.failureClass` is populated for every failed job, and the batch report splits script from infrastructure failures.
9. An unknown error code classifies as `script` (fails loudly, does not loop).
10. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `failure-class.test.ts` (every known code, unknown default, `timeoutIsInfra` both ways); `backoff.test.ts` (doubling, cap, jitter distribution); `job-runner.test.ts` (two budgets, no lease held during backoff, attempt cap); `executor-host.test.ts` (health fed only for `blameDevice`, requeue path clears `deviceId`).

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, two devices):**
```bash
# 1. start a long job, then physically unplug the device mid-run
#    → classified infra, backoff visible in the job log, retried
# 2. with a batch across both devices, unplug one
#    → its member requeues and completes on the other device
# 3. run a script whose assertion genuinely fails
#    → classified script, no infra retries, no health blame
# 4. check /api/adb/stats and the device's health after step 1
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Misclassifying a script bug as infra hides a real regression behind retries. | Unknown codes default to `script` (§3.2); the table is explicit and tested; the class is shown in the UI so a wrong call is visible rather than silent. |
| Rebinding makes a batch's results non-comparable across devices. | Only batch members rebind, only on infra failures, and `rebindOnInfra: false` turns it off. The batch report names which device each member ran on. |
| Backoff makes a farm-wide outage take much longer to report. | The cap is 30 s and the infra budget defaults to 2, so worst case adds about a minute per job, not an open-ended wait. |
| Requeuing loses the job's place and it starves behind newer work. | It keeps its original priority and `createdAt`, so Plan 21's ordering treats it as the old job it is. Covered by a test. |
| The new columns break existing job queries. | Both are nullable/defaulted and additive; a migration test reads pre-existing rows. |

## 9. Open questions

1. Should a device that causes an infra failure be excluded from *that batch's* remaining dispatch, even before Plan 23 quarantines it? Probably yes; deferred until the health signal is observed in practice.
2. Should script-class retries also get a small backoff? Some flakiness is genuinely time-dependent. Currently they do not.
3. Should `finish`-only attempts be classified at all? They currently inherit the prior failure's class.
