# Plan 35 — M17a : Session Hygiene Between Jobs

> Status: draft
> Depends on: Plans 22.1 (deadlines) and 18 (the device event log). Independent of the rest of M17.
> Spec references: §9 (scripts and jobs), §10.2 (leases), §11.3 (crash containment), §15 (device lifecycle).

---

## 1. Goals

- Two jobs running back-to-back on one device do not inherit each other's application state.
- Every job starts from a **declared, observable baseline**, and what was done to reach it is recorded.
- The reset policy is configurable farm-wide and overridable per script, because "wipe app data" is right for one team and unacceptable for another.
- A job that crashes or is killed cannot leave the next job dirty — the reset happens before a run, never only after.
- The reset is bounded in time and cannot itself stall the queue.

## 2. Non-goals

- Factory reset, user switching, or profile isolation. Out of scope; a device farm is not a hypervisor.
- Reverting system settings a script changed (wifi, locale, permissions) beyond what §4.2 lists. Recorded in §9.
- Reboot-between-jobs as a policy. Considered and rejected in §3.4.
- Cleaning up on the *cloud agent* differently — the same code path runs there, because reset happens through `DeviceSession`, which the agent already has.

## 3. Context and design decisions

### 3.1 The contamination is real and currently total

`packages/session/src/manager.ts` caches one `DeviceSession` per device (`entries`), created on first use and reused until the device goes away. `packages/core/src/jobs/executor-host.ts` starts and settles jobs against that session and does **nothing** between them: there is no `pm clear`, no `force-stop`, no return to home, no dismissal of whatever dialog the last job left on screen.

So a second job inherits: the foreground activity, the app's data and caches, granted runtime permissions, the clipboard, running background services, and any system dialog the previous run opened.

The failure mode is the worst kind — it is order-dependent and silent. A suite that passes in one order fails in another, and the failure looks like a flaky app rather than a dirty device.

### 3.2 Reset before, not after

The obvious placement is "clean up when a job finishes". It is the wrong one: a job that times out, crashes its child process, or has its device force-released never reaches its own cleanup, and the next job inherits the mess anyway.

Resetting **before** each run makes the guarantee unconditional and idempotent: whatever state the device is in — including the state left by a crash — the job starts from the declared baseline. The cost is one reset per job either way.

`finish()` in a script remains what it is (spec §11.3: stateless and idempotent, re-run after a timeout kill). This plan does not change it.

### 3.3 A declared policy, not a fixed behaviour

`pm clear <pkg>` wipes application data. For a QA team running install-then-test, that is exactly right. For a team whose devices hold a logged-in account that takes ten minutes to restore by hand, it is destructive and unacceptable.

So the reset is a **policy**, with four levels, defaulting to the middle:

| Policy | What it does | Default |
|---|---|---|
| `none` | nothing — today's behaviour | |
| `home` | dismiss dialogs, return to the launcher, close recents | **default** |
| `declared` | `home`, plus `force-stop` and optionally `pm clear` for the packages the script declares | |
| `aggressive` | `declared`, plus force-stop every non-system package with a foreground process | |

`aggressive` exists because some teams genuinely want it; it is never the default, and its description says plainly that it will kill background apps the farm relies on.

### 3.4 Why not reboot between jobs

A reboot is the only true reset, and it costs 30–90 seconds per job plus a re-probe, re-pair for adb-tcp devices, and a fresh scrcpy session. On a farm with 20 devices running short jobs it would dominate wall-clock. It is also unnecessary for the contamination that actually bites (§3.1), all of which is application-level.

Recorded here so the decision is not relitigated: reboot stays a manual action.

### 3.5 The reset is a job phase, and it is visible

The reset runs inside the job's own lease, before `prepare`, and appears as a phase in the job's log and in the Plan 17 session progress. A reset that fails does **not** fail the job by default — it records a warning and continues, because a device that cannot return to its launcher is usually still able to run the script. `job.reset.strict` flips that for teams who want the opposite.

Each reset records one `device_events` main-stream entry, `job.reset`, with the policy applied and the packages touched. Without that record, "why did this job behave differently" is unanswerable.

## 4. Technical design

### 4.1 Settings — `packages/protocol/src/settings.ts`

```ts
job: z.object({
  resetPolicy: z.enum(['none', 'home', 'declared', 'aggressive']).default('home')
    .describe('What to reset on a device before each job. "home" returns to the launcher; "declared" also stops the packages a script declares; "aggressive" stops every non-system app.')
    .meta({ title: 'Reset before each job' }),
  resetTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000)
    .describe('Budget for the pre-job reset. Exceeding it logs a warning and the job continues.')
    .meta({ title: 'Reset timeout (ms)' }),
  resetStrict: z.boolean().default(false)
    .describe('Fail the job when its pre-job reset fails, instead of warning and continuing.')
    .meta({ title: 'Fail on reset error' }),
}).default({}),
```

### 4.2 What each policy does — `packages/session/src/reset.ts` (new)

```ts
export interface ResetPlan {
  policy: 'none' | 'home' | 'declared' | 'aggressive'
  /** From ScriptDefinition.reset (§4.3). */
  packages?: string[]
  clearData?: boolean
}

export interface ResetOutcome {
  applied: string[]          // the steps that ran
  warnings: string[]         // steps that failed, never thrown
  durationMs: number
}

export function resetDevice(session: DeviceSession, plan: ResetPlan, opts: { timeoutMs: number }): Promise<ResetOutcome>
```

`home` performs, in order, each best-effort and each with a short profile:

1. `input keyevent KEYCODE_BACK` twice — dismisses most dialogs without leaving the app.
2. `am start -a android.intent.action.MAIN -c android.intent.category.HOME` — returns to the launcher. Preferred over `KEYCODE_HOME` because it works when a dialog is holding focus.
3. `input keyevent KEYCODE_APP_SWITCH` then `KEYCODE_BACK` is **not** done — closing recents varies too much per OEM to be reliable, and leaving them costs nothing.
4. `wm dismiss-keyguard` when `dumpsys window | grep isKeyguardShowing` reports a keyguard, reusing the check `session.ts:179-185` already performs.

`declared` adds, per declared package: `am force-stop <pkg>`, then `pm clear <pkg>` only when the script set `clearData`.

`aggressive` adds: parse `dumpsys activity processes` for non-system foreground packages and `force-stop` each, skipping a small allowlist (the launcher, the IME, `com.github.uiautomator*` — killing the inspector mid-farm would be self-defeating).

Every command goes through the per-device queue with the `appLifecycle` profile, and the whole plan is wrapped in `resetTimeoutMs`; exceeding it returns the partial outcome with a warning rather than throwing.

All package names pass through `shellQuote` (Plan 34 §4.3 moves it into `@enkaku/adb`). **This plan depends on that move**; if Plan 34 has not landed, add the helper here and let 34 dedupe.

### 4.3 Script declaration — `packages/sdk/src/types.ts`

```ts
export interface ScriptDefinition<S> {
  // … existing fields …
  /** Packages this script touches, so `declared` reset knows what to stop. */
  reset?: {
    packages: string[]
    /** `pm clear` as well as force-stop. Destructive — opt in per script. */
    clearData?: boolean
  }
}
```

The child already reports `timeout` and `retries` to the parent in its `ready` message (`runner/ipc.ts:44-49`); `reset` joins them, so the parent learns the declaration without importing the bundle.

**Ordering problem, and its answer:** the reset must run *before* the child starts, but the declaration lives *inside* the bundle. So the runner does the `home` portion first, starts the child, reads `ready`, and then applies the `declared`/`aggressive` portion before `prepare` begins. The child is told to hold via the existing `init` handshake — it does not begin `prepare` until the parent sends `init`, which the parent now sends after the reset completes.

### 4.4 Wiring

- `packages/session/src/runner/job-runner.ts`: run `resetDevice` between `ready` and `init`, emit a `reset` phase, and append the outcome to the job log.
- `packages/core/src/daemon.ts`: pass `resetPolicy: () => settingsStore.get().job` as a getter, so a settings change applies to the next job (the pattern Plan 23 established).
- `packages/core/src/jobs/executor-host.ts`: record the `job.reset` device event with `{ policy, packages, warnings, durationMs }`.
- Studio: the job detail page shows the reset as a step with its outcome; the Settings form picks the new fields up automatically.

## 5. Implementation steps

**35.1 — Settings and the reset module**
- Add the `job` settings block (§4.1) and `packages/session/src/reset.ts` (§4.2), with unit tests against a fake `DeviceSession` asserting the exact command sequence per policy.

**35.2 — Script declaration**
- `ScriptDefinition.reset` in the SDK; carry it on the `ready` IPC message; validate with Zod on receipt.

**35.3 — Runner integration**
- Reset between `ready` and `init`; the `reset` phase; the job log entry; `resetStrict` handling.

**35.4 — Event and UI**
- The `job.reset` main-stream event; the step in the job detail page.

**35.5 — Contamination regression test**
- A test that runs two jobs on one fake session and asserts the second sees a reset, including after the first was aborted mid-run.

## 6. Acceptance criteria

1. With the default policy, every job is preceded by a reset that dismisses dialogs and returns the device to its launcher.
2. A job that times out or is cancelled still leaves the **next** job with a clean start — verified by aborting mid-run and inspecting the next job's reset phase.
3. `declared` stops the packages a script declares, and only calls `pm clear` when the script asked for it.
4. `none` reproduces today's behaviour exactly.
5. A failing reset warns and the job continues; with `resetStrict: true` the job fails with a coded error.
6. The reset cannot exceed `resetTimeoutMs`, and exceeding it does not leave a command in flight.
7. Every reset produces one `job.reset` event carrying the policy, packages, warnings, and duration.
8. Changing the policy in Studio affects the next job with no restart.
9. Package names containing shell metacharacters cannot execute a second command.
10. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `reset.test.ts` (command sequence per policy, allowlist in `aggressive`, timeout returns a partial outcome, quoting); `job-runner.test.ts` (reset ordered between `ready` and `init`, phase emitted, `resetStrict`).

**Manual smoke (`ENKAKU_TEST_DEVICE=1`):**
```bash
# 1. run script A that leaves an app in the foreground with a dialog open
# 2. run script B that asserts the launcher is showing → passes
# 3. set resetPolicy=none, repeat → B now fails (contamination reproduced)
# 4. set declared + clearData on script A, run, then check the app's data is gone
# 5. cancel script A mid-run, then run B → B still starts clean
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The reset adds latency to every job. | `home` is three or four fast shell commands; measure it in the smoke test and report the figure. `none` remains available. |
| `aggressive` kills something the farm depends on (the inspector, the IME) and the device becomes unusable. | An explicit allowlist including `com.github.uiautomator*`, the active IME, and the launcher; the setting's own description warns; it is never the default. |
| `pm clear` destroys a logged-in account someone spent an hour setting up. | Only reachable when a script explicitly sets `clearData`, and only under the `declared` policy. Two opt-ins, both visible. |
| OEM differences make the HOME intent unreliable. | Best-effort by design: each step is independent, failures become warnings, and the job proceeds. The smoke test runs on the moto g06 power; other OEMs may need extra steps, which belong in §9 not in a silent retry loop. |
| The `ready`→reset→`init` reordering breaks the finish-only path. | The finish-only attempt starts a fresh child specifically to run `finish`; it must skip the reset entirely, or it would wipe the state `finish` needs. Covered by an explicit test. |

## 9. Open questions

1. Should the reset restore system settings a script changed (wifi, rotation, locale)? That needs a snapshot/restore mechanism and is a plan of its own.
2. Should `aggressive` be per-cluster rather than farm-wide? Plausible once clusters are used as regions (Plan 22.0).
3. Is there a case for a post-job reset *as well*, purely so a device left for manual use is clean? Cheap to add later; deliberately not now.
