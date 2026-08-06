# Plan 74 — M39 : A Job Timeout You Can Set, and a `find` That Says Why

> Status: implemented — `FarmSettings.job` gains `defaultTimeoutMs` (default 3_600_000), `startupTimeoutMs` (default 60_000), `maxTimeoutMs` (default `null`, no ceiling) (`packages/protocol/src/settings.ts`); `DEFAULT_TIMEOUT_MS` deleted from `job-runner.ts` with no fallback constant left anywhere. `AbortReason` gains `'startup-timeout'`, armed at spawn alongside the run timer and cleared the moment `ready` arrives — a child that never starts now fails in `startupTimeoutMs`, not the (now 12x longer) run timeout; `STARTUP_TIMEOUT` is added to `packages/core/src/jobs/failure-class.ts`'s `INFRA_CODES`, unconditionally infra (never gated on `timeoutIsInfra`), proven by a test where a script-budget of zero still recovers via the infra budget. `clampTimeoutMs()` (`job-runner.ts`) applies `maxTimeoutMs` only to a value the SCRIPT actually declared (via its `ready` message, on this attempt or a prior one) — never to the bare farm default — logging the script's `name@version` and both numbers whenever it changes the value; never silent. `FindOutcomeSchema` (`packages/protocol/src/find-outcome.ts`, the discriminated union `{ok:true,node} | {ok:false,reason:'not-found'|'rejected-oversized'|'ambiguous',matches}`) is produced by `device-executor.ts`'s `findOutcome()` helper, which prefers a new optional `Inspector.findDetailed()` (`packages/protocol/src/driver.ts`) and falls back to a plain not-found/ok shape built from `find()` for an engine that has none (Appium). `find()` itself is UNCHANGED on every engine — `UiServerInspector.find()` is refactored to a thin narrowing over its own `findDetailed()` (behaviour-identical, same warn-once log, proven by the pre-existing `find-guard.test.ts` suite passing unedited) and `UiautomatorDumpInspector.find()` is left untouched, with `findDetailed()` added as a SEPARATE method using `countMatches` — deliberately not a refactor, because unifying them would make an ambiguous selector start returning `null` from plain `find()` where it used to return the first match, breaking a published bundle (criterion 10, proven in `uiautomator-dump.test.ts` by asserting `find()` still returns the first hit on a selector `findDetailed()` calls ambiguous). The IPC `find` device.call now carries the full outcome; `child-entry.ts`'s `find()` narrows it to `node | null`, and a new `findDetailed()` returns it whole — both `FindOutcomeSchema.parse`d at the process boundary. `DeviceApi.findDetailed` added to the SDK type (`packages/sdk/src/types.ts`), and `ScriptDefinition.timeout`'s doc comment no longer names a hard-coded default. `device.find`'s capability output (`packages/core/src/capability/device-inspect.ts`) is the full `FindOutcomeSchema`, replacing plan 63's narrowed `{ok:false,reason:'not-found'}` placeholder; `device.waitFor`'s output gains an optional `lastReason`/`matches`, read off a new `SessionError.details` field (`packages/session/src/errors.ts`) that `device-executor.ts`'s `waitFor` case populates from the last polled outcome before it throws — so a wait that only ever saw a rejected-oversized container says that, not a bare timeout. `job-runner.ts`'s `device.call` handler inspects every `find` result and logs a `warn` job-log line naming the reason and selector on a refusal, regardless of whether the script called `find()` or `findDetailed()` — the same IPC value either way. **Deviations, recorded rather than silent:** (1) the clamp is applied ONLY to a script-declared value, never to the bare farm default reached before any `ready` — clamping the operator's own `defaultTimeoutMs` against their own `maxTimeoutMs` produced a confusing "job job-1 requested 3600000ms" log line with no script to name, caught by this plan's own test; §3.3's "clamps a script's request" is followed literally. (2) `ambiguous` is producible only by `UiautomatorDumpInspector` (which already holds the whole tree for `dump()`); `UiServerInspector`'s `objInfo` RPC only ever resolves the first match with no on-device "how many" query, so it can report `not-found`/`rejected-oversized`/`ok` but never honestly claim `ambiguous` — recorded in both the driver comment and a test that pins the gap rather than faking a count. `bun run typecheck` is clean on all 10 non-Studio packages (Studio is mid-edit by the concurrent Plan 72 agent and out of scope here). `bun test`: 2039 pass / 0 fail across every package this plan touched (baseline 2175 + 22 new, zero regressions); the full-workspace run additionally shows Plan 72's own in-flight Studio test failures, in files this plan never opened. **Not done:** the device-gated `ENKAKU_TEST_DEVICE=1` case (a selector matching a viewport-sized container on real hardware, through `/api/v1/cap/device.find`) and the manual smoke test (§7) — no physical device or Studio session in this environment, matching every prior plan in this series.
> Ships: packages/protocol/src/find-outcome.ts
> Depends on: Plan 63 (`device.find`'s capability output is what gains the reason). Independent of 70–73; it can land in any order relative to them.
> **Completes Plan 60**, whose find guard knows why it refused and has never been able to say.
> Spec references: §12 (jobs), §7.4 (inspector).

---

## 1. Goals

- A job's default timeout is a **farm setting**, defaulting to **60 minutes**, changeable without a rebuild.
- A script's own `timeout` still **wins** over the farm default.
- `device.find` reports **why** it found nothing — not found, refused as an oversized container, or ambiguous — instead of collapsing all three into `null`.
- No existing script changes behaviour or breaks.

## 2. Non-goals

- Per-device or per-cluster timeouts. One farm default plus a per-script override is the whole model.
- Changing retry classification or backoff (Plan 36).
- Changing what the find guard refuses (Plan 60 §4.1). Only its ability to report the refusal changes.
- Changing the SDK's `device.find()` signature. §3.4.

## 3. Context and design decisions

### 3.1 The default is five minutes, and it is hard-coded

`packages/session/src/runner/job-runner.ts:35`:

```ts
const DEFAULT_TIMEOUT_MS = 300_000
```

used at `:533` as `meta.timeoutMs ?? DEFAULT_TIMEOUT_MS`. It appears in no settings screen, no config file, and no environment variable. An operator whose scripts legitimately take twenty minutes has one option: edit the source and rebuild.

It becomes `FarmSettings.job.defaultTimeoutMs`, default **3,600,000** (60 minutes), min 30 s, max 24 h, rendered by the existing schema-driven settings form so it appears without new UI code.

The doc comment on `ScriptDefinition.timeout` (`packages/sdk/src/types.ts:127`) currently reads *"ms per attempt; default 300_000"*. That becomes wrong the moment this lands, so it is corrected in the same change — a stale doc comment on a public SDK type is worse than none, because it is believed.

### 3.2 Precedence, and the window before the script has spoken

The order the user asked for, and it is already half-built:

```
script's `timeout`   →  wins whenever declared
farm default         →  used when the script declares none
```

The mechanism exists. A script's `timeout` reaches the parent in the child's `ready` message (`job-runner.ts:359`), and the parent re-arms the timer when the value differs (`:363-365`).

But note the ordering: the timer is armed at `:466` **before** `ready` arrives. So for the few milliseconds until the child reports, the farm default applies. That is correct and worth stating rather than leaving to be rediscovered — the initial arm is a safety net for a child that never becomes ready at all, and the re-arm is the real budget. Raising the default from 5 to 60 minutes makes that net looser, so a child that hangs *before* `ready` now hangs for up to an hour.

That is a real regression, and it gets its own bound: **`startupTimeoutMs`, default 60 s**, covering process spawn to `ready`. A child that has not reported in a minute is not slow, it is broken. Without this, moving the default to 60 minutes would make a common failure twelve times slower to surface.

### 3.3 A cap on what a script may ask for — offered, and off

A script can declare any `timeout` it likes. `timeout: 86_400_000` parks a device for a day, and nothing refuses it.

The user's instruction is explicit: the script has priority. So `maxTimeoutMs` ships **defaulting to null — no cap** — and is available for an operator who wants one. Setting it clamps a script's request and **logs the clamp naming the script and both numbers**; it never silently shortens a run, because a job that dies early for an unexplained reason is worse than one that runs long.

Recording the trade rather than deciding it quietly: the risk of no cap is one bad script holding a phone for a day; the risk of a cap is a legitimate long script being cut off. The second is worse and less visible, which is why the default is off.

### 3.4 `find` knows why it refused and has never been able to say

Plan 60 added a guard: `find` must not answer with a viewport-sized container when a selector matches one, because that made scripts report success having done nothing. The guard works and is tested.

But `device-executor.ts` collapses everything to `null`. So a caller cannot distinguish:

- **not found** — the element is not on screen; wait, or navigate;
- **refused as oversized** — the selector matched, but it matched a container filling the screen, so the selector is wrong; retrying will never help;
- **ambiguous** — several matches; the selector needs narrowing.

Three different problems with three different responses, reported identically. For a script author it is an annoyance. For an **agent** it is a loop: told only "not found", a model retries the same selector until its step budget runs out. Plan 63 was forced to narrow `device.find`'s capability output to `{ok: false, reason: 'not-found'}` because that is all the driver could honestly report, and recorded it as a deviation. This closes it.

### 3.5 Scripts keep the signature they have

`device.find()` returns `UiNode | null` to a script today. Changing that would break every published script, and Plan 62 made versions immutable — an old bundle must keep working.

So the reason travels **beside** the result, not inside it:

- the executor returns `{ node: UiNode | null, reason?: 'not-found' | 'rejected-oversized' | 'ambiguous', matches?: number }` internally;
- the SDK's `find()` returns `node` — **unchanged**;
- the SDK gains `findDetailed()` for an author who wants the reason;
- the **capability** `device.find` returns the full discriminated union, which is what an agent sees;
- a refusal is also written to the job log naming the reason, so the Plan 60 case is diagnosable from a job that used plain `find()`.

`waitFor` benefits the same way: a wait that timed out because every match was refused as oversized reports that instead of a bare timeout.

## 4. Technical design

### 4.1 Settings

`FarmSettings.job` gains:

```ts
defaultTimeoutMs: z.number().int().min(30_000).max(86_400_000).default(3_600_000)
  .describe('How long a job may run before it is killed, when its script does not declare its own timeout. A script\'s own `timeout` always wins.')
  .meta({ title: 'Default job timeout (ms)' }),

startupTimeoutMs: z.number().int().min(5_000).max(600_000).default(60_000)
  .describe('How long a job\'s process has to start and report ready before it is treated as broken. Separate from the run timeout.')
  .meta({ title: 'Job startup timeout (ms)' }),

maxTimeoutMs: z.number().int().min(30_000).max(86_400_000).nullable().default(null)
  .describe('An optional ceiling on what a script may request. Null means no ceiling — a script\'s own timeout is honoured however long. A clamp is logged, never silent.')
  .meta({ title: 'Maximum job timeout (ms)' }),
```

### 4.2 `job-runner.ts`

- `DEFAULT_TIMEOUT_MS` deleted; the value is read from settings and threaded to the runner. There is no fallback constant left to drift.
- `startupTimeoutMs` armed at spawn, cleared on `ready`; expiry fails the job with `startup-timeout`, classified as **infrastructure** (Plan 36) — a child that never started is a farm problem, not a script's fault, and must not spend the author's retry budget.
- `maxTimeoutMs` clamping with its log line (§3.3).
- The re-arm at `:363-365` is unchanged.

### 4.3 The find result

`FindOutcomeSchema` in `@enkaku/protocol`:

```ts
z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), node: UiNodeSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(['not-found', 'rejected-oversized', 'ambiguous']), matches: z.number().int() }),
])
```

`device-executor.ts` produces it; `find()` narrows to `node | null` for compatibility; `findDetailed()` returns it whole; the `device.find` capability's output becomes it, replacing Plan 63's narrowed placeholder. `waitFor` carries the last outcome into its timeout error.

The IPC `device.call` result shape (`packages/session/src/runner/ipc.ts`) carries the outcome, so the reason survives the process boundary — otherwise the child knows and the parent does not.

### 4.4 Studio

The Jobs settings section picks up all three fields automatically from the schema. A job that failed on `startup-timeout` says so on its Summary rather than reading as a generic timeout (Plan 60 §4's error-phase work already has the slot).

## 5. Implementation steps

**74.1 — The three settings** (§4.1).

**74.2 — Read the default from settings; delete the constant** (§4.2).

**74.3 — `startupTimeoutMs`** (§3.2, §4.2), classified as infra.

**74.4 — `maxTimeoutMs` clamping with its log** (§3.3).

**74.5 — `FindOutcomeSchema` through the executor, IPC, SDK, and capability** (§4.3).

**74.6 — `findDetailed()` and the job-log line for a refusal** (§3.5).

**74.7 — Correct the SDK doc comment** (§3.1).

## 6. Acceptance criteria

1. A job whose script declares no timeout is killed after `defaultTimeoutMs`, which defaults to 60 minutes and is changeable in Settings → Jobs.
2. A script declaring `timeout` gets exactly that, above or below the farm default.
3. `DEFAULT_TIMEOUT_MS` no longer exists anywhere; there is no constant to fall back to.
4. A child that never reports `ready` fails after `startupTimeoutMs` (default 60 s), **not** after the run timeout.
5. A `startup-timeout` failure is classified as **infrastructure** and does not spend the script's own retry budget.
6. With `maxTimeoutMs` null (the default), a script requesting 24 hours gets 24 hours.
7. With `maxTimeoutMs` set, a larger request is clamped and the clamp is **logged naming the script and both values** — never silent.
8. `device.find` reports `rejected-oversized` distinctly from `not-found`, through the capability, and an agent receives the distinction.
9. `waitFor` timing out because every match was refused says so, rather than reporting a bare timeout.
10. **A previously published script bundle runs unchanged**, and `find()` still returns `UiNode | null`.
11. `findDetailed()` returns the full outcome.
12. A `find` refusal appears in the job log with its reason, even for a script that used plain `find()`.
13. The SDK doc comment on `timeout` no longer names a hard-coded default.
14. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** precedence — script value wins, absent value inherits, the clamp applies only when set; the startup timer clears on `ready` and fires when it never comes; `startup-timeout` classified as infra.

**Unit — find:** each of the three outcomes from the executor; `find()` narrowing to `node | null` for all three; `findDetailed()` returning the reason; `waitFor` carrying the last outcome.

**Compatibility:** a bundle built before this plan, run through the current runner, producing identical results — this is criterion 10 and the reason immutable versions matter (Plan 62 §3.1).

**Device-gated (`ENKAKU_TEST_DEVICE=1`):** a selector matching a viewport-sized container on real hardware returns `rejected-oversized` through `/api/v1/cap/device.find` — the case Plan 60 found by hand and could never report.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. Settings → Jobs → the default timeout reads 60 minutes
# 2. run a script with no timeout → the job's deadline is 60 minutes
# 3. run one declaring 30_000 → killed at 30s
# 4. run a script whose selector hits a full-screen container → the log names rejected-oversized
# 5. ask an agent to tap that selector → it reports the selector is wrong, and does not retry it
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Raising 5 → 60 minutes makes a hung job hold a device far longer. | `startupTimeoutMs` (§3.2) catches the common case — a child that never starts — in 60 s. Beyond that, a long default is what the operator asked for, and it is now visible and changeable rather than compiled in. |
| An unbounded script timeout parks a phone for a day. | `maxTimeoutMs` exists and is documented; it defaults off because the user's instruction is that the script has priority, and a silent early kill is the worse failure (§3.3). |
| Changing the find result breaks published scripts. | `find()`'s signature is untouched (§3.5); the reason travels beside it. Criterion 10 tests a pre-plan bundle rather than assuming. |
| Three outcomes are still not enough. | The union is extensible and its consumers switch exhaustively, so adding a fourth is a typecheck failure at every call site rather than a silent fallthrough. |

## 9. Open questions

1. Should `defaultTimeoutMs` be overridable per cluster? Plausible once one farm runs both quick smoke scripts and long soak tests. Not until someone has both.
2. Should a job warn as it approaches its timeout, so a long run is visible before it is killed? Cheap, and it needs a place to put the warning.
3. Should `ambiguous` carry the candidate nodes, so an agent can pick? Useful, and it risks handing a model a large payload on exactly the path that is already going wrong.
