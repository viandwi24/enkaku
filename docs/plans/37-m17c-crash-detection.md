# Plan 37 — M17c : Application Crash Detection

> Status: draft
> Depends on: Plan 24 (the streaming lane and the monitor builder pattern — this is a new monitor kind) and Plan 18 (the device event log).
> Spec references: §9 (scripts and jobs), §13 (protocol), §15 (device lifecycle).

---

## 1. Goals

- An application crash or ANR on a device is detected, attributed, and recorded — whether or not a job was running.
- A job whose target application crashed can **fail on that basis**, instead of reporting a confusing downstream symptom like "element not found".
- The crash's stack trace is captured as an artifact, so the report is actionable.
- Detection runs on the streaming lane and costs one adb stream per device, shared by every viewer, exactly like the Plan 24 monitors.
- Works identically for local and agent-owned devices, with no new transport.

## 2. Non-goals

- Symbolicating native crashes or parsing tombstones. Java/Kotlin stack traces from the crash buffer only.
- Uploading crashes anywhere (Sentry, Crashlytics). Detection and local capture only.
- Detecting crashes of the farm's own components (`ui-server`, scrcpy). Plan 23's health tracker owns device-level health.
- Retrying a job because of a crash. Plan 36 owns retry policy; a crash is a script-class failure.

## 3. Context and design decisions

### 3.1 Why this is nearly free now

Before Plan 24, watching for crashes meant either polling `logcat -d` (racy, misses everything between polls) or holding a long-lived adb command in the per-device queue (the exact hazard `packages/scrcpy/src/session.ts:90-98` documents).

Plan 24 built the streaming lane, the fan-out registry, the ring buffer, and the WS protocol. A crash watcher is one more monitor kind plus a parser — the infrastructure already exists and is already proven on hardware.

### 3.2 `logcat -b crash`, not `am monitor`

`am monitor` prints `** ERROR: PROCESS CRASHED` and is simple to parse, but it is an interactive debugging tool: it *pauses the crashing process* waiting for input on some builds, it reports one event at a time, and it gives no stack trace.

Android maintains a dedicated **crash buffer** that contains exactly what we want, with the full trace and the offending package:

```
logcat -b crash -v threadtime
```

It fits the Plan 24 builder pattern unchanged, it never interferes with the app under test, and it is the same mechanism Android's own tooling reads. ANRs land in the `main`/`system` buffers instead, so the watcher reads `-b crash,main` and filters (§4.2).

### 3.3 A crash is an event first, a job failure second

Crashes happen when no job is running — during manual control, or while a device sits idle after someone left an app open. Those are worth recording: a device that crashes an app every ten minutes is telling you something.

So detection is **always on** for any device with an active session, independent of jobs, and always produces a `device_events` main-stream entry (`app.crashed`). Job attribution is a second step: if a job holds the device's lease when the crash arrives, the crash is attached to that job.

### 3.4 Failing the job is opt-in, and defaults to the target package only

Blanket "any crash fails the job" is wrong — Android devices crash background apps routinely, and a farm phone with a flaky OEM service would fail every job forever.

Three levels, defaulting to the middle:

| `job.crashPolicy` | Behaviour |
|---|---|
| `ignore` | record the event, never affect the job |
| `declared` | fail the job when a declared package crashes | **default** |
| `any` | fail the job on any non-system crash |

`declared` reuses `ScriptDefinition.reset.packages` from Plan 35 when present, and falls back to any package the script launched via `app.launch` during the run — which the executor already sees (`device-executor.ts:110-115`) and can record without a new declaration.

### 3.5 Failing cleanly, mid-run

When a crash matches, the job must fail with a clear cause rather than limping to a confusing `WAITFOR_TIMEOUT` thirty seconds later.

The runner aborts the attempt with code `APP_CRASHED`, and the message names the package and the exception line. The existing abort path (`runner/ipc.ts` `abort`, and `raceAbort` in `child-entry.ts:115`) already stops a phase promptly; this adds one more abort reason alongside `timeout`/`cancelled`/`hung`.

`finish()` still runs, per spec §11.3 — a crash is exactly when cleanup matters.

### 3.6 The trace is an artifact, not a log line

A stack trace in a log line is unreadable and gets truncated. The watcher buffers the lines belonging to one crash (they are contiguous in the crash buffer) and writes them as a `.txt` artifact via Plan 24's `saveForDevice`, or attaches it to the job when one is running.

## 4. Technical design

### 4.1 Monitor kind — `packages/protocol/src/messages/monitor.ts`

```ts
export const MonitorKindSchema = z.enum(['logcat', 'top', 'thermal', 'ps', 'meminfo', 'df', 'crash'])
```

Command builder in `packages/core/src/device/monitors.ts`:

```
logcat -b crash,main -v threadtime -T 1
```

`-T 1` starts from the tail, so a session does not replay every crash since boot on connect.

### 4.2 Parser — `packages/core/src/device/crash-parser.ts` (new)

```ts
export interface CrashEvent {
  kind: 'crash' | 'anr'
  package: string
  process: string
  exception: string        // e.g. 'java.lang.NullPointerException'
  message: string          // the first line after the exception
  trace: string            // the full contiguous block
  at: number
}

export function createCrashParser(onCrash: (e: CrashEvent) => void): (line: string) => void
```

Recognises:
- **Crash** — `E AndroidRuntime: FATAL EXCEPTION: <thread>` followed by `Process: <pkg>, PID: <n>`, then the exception line, then the trace until a line that is not a continuation.
- **ANR** — `E ActivityManager: ANR in <pkg>` plus the reason line.

A crash block is closed by the first line that does not continue it, or by a 2-second idle gap, whichever comes first — a trace that arrives split across chunks must not be dropped, and one that never terminates must not buffer forever (cap: 200 lines).

System packages (`android`, `com.android.*`, the launcher) are tagged `system: true` so the `any` policy can exclude them.

### 4.3 The watcher — `packages/core/src/device/crash-watcher.ts` (new)

```ts
export interface CrashWatcher {
  /** Subscribes the shared crash stream for a device (idempotent). */
  watch(deviceId: string): Promise<void>
  unwatch(deviceId: string): void
  /** Jobs register interest; the watcher calls back when a matching crash lands. */
  onJobCrash(cb: (deviceId: string, jobId: string, e: CrashEvent) => void): void
}
```

- Subscribes through `MonitorHub` as an internal client id (`internal:crash`), so it shares the same stream a human viewer would open and costs nothing extra when both are watching.
- Started when a session starts (`onSessionStarted`) and stopped by `stopForDevice`, reusing the hooks Plan 24 already wired in `daemon.ts`.
- On each `CrashEvent`: record `app.crashed` on the main stream, write the trace artifact, and — if a job lease is held and the policy matches — invoke the callback.

**Stream budget:** this takes a per-device stream slot. Plan 24 defaults `adb.maxStreamsPerDevice` to 1, and Plan 34 already needs to raise it for the ui-server. This plan requires **at least 3** (ui-server, crash watcher, one human monitor) and must set the default accordingly, with the reasoning in the setting's description.

### 4.4 Job integration

- `packages/core/src/jobs/executor-host.ts` subscribes `onJobCrash`, and aborts the running executor with reason `crashed`.
- `packages/session/src/runner/ipc.ts`: the `abort` reason enum gains `'crashed'`.
- `packages/session/src/runner/job-runner.ts`: maps it to `{ code: 'APP_CRASHED', phase: 'run', message: '<pkg> crashed: <exception>' }`, attaches the trace artifact, and lets `finish` run.
- Plan 36 classifies `APP_CRASHED` as **script** class — it is a result, not a farm fault.

### 4.5 Studio

- A **Crashes** panel on the device page (beside Monitor), listing recent crashes with package, exception, time, and a link to the trace artifact.
- The job detail page shows the crash as the failure cause, with the trace inline behind a disclosure.
- A crash badge on the device card when one occurred in the last hour — a device crashing repeatedly should be visible without opening it.

## 5. Implementation steps

**37.1 — Parser.** `crash-parser.ts` with fixture-driven tests using real captured `logcat -b crash` output for a crash, an ANR, a split trace, and a truncated one.

**37.2 — Monitor kind.** Add `crash` to the enum and the builder; raise `adb.maxStreamsPerDevice` to 3 with its justification.

**37.3 — Watcher.** `crash-watcher.ts` subscribing through `MonitorHub`; wire start/stop into the session hooks in `daemon.ts`; record the event and the artifact.

**37.4 — Policy and job abort.** The `job.crashPolicy` setting, the `crashed` abort reason, the `APP_CRASHED` mapping, target-package tracking from `app.launch`.

**37.5 — Studio.** The Crashes panel, the job detail cause, the device card badge.

## 6. Acceptance criteria

1. Crashing an app on a device with an active session produces an `app.crashed` event within a few seconds, naming the package and exception.
2. The full stack trace is stored as an artifact and reachable from the UI.
3. An ANR is detected and recorded with kind `anr`.
4. With `declared` (the default), a crash of the script's target package fails the running job with `APP_CRASHED`, naming the package; `finish()` still runs.
5. A crash of an unrelated background app does **not** fail the job under `declared`, and does under `any`.
6. With `ignore`, no job is ever failed, and events are still recorded.
7. Crashes are detected when no job is running.
8. The watcher shares one adb stream with a human viewer of the same device — two watchers, one `logcat` process on the device.
9. A trace split across socket chunks is captured whole; a runaway block is capped at 200 lines.
10. `APP_CRASHED` is classified script-class by Plan 36 and does not blame the device.
11. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `crash-parser.test.ts` (real fixtures: FATAL EXCEPTION, ANR, split chunks, cap, system-package tagging); `crash-watcher.test.ts` (against a fake `MonitorHub`: event recorded, artifact written, job callback only under a matching policy).

**Manual smoke (`ENKAKU_TEST_DEVICE=1`):**
```bash
# force a crash on the device:
adb -s <serial> shell am crash com.example.target      # API 26+
# 1. with no job running → app.crashed event + trace artifact appear
# 2. run a script targeting that package, crash it mid-run
#    → job fails APP_CRASHED, finish() ran, trace attached
# 3. crash an unrelated app during a job → job unaffected (declared)
# 4. open the Monitor tab and confirm one logcat process on the device (ps -A)
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A chatty device fills the crash buffer with noise and floods events. | The crash buffer is low-volume by nature; the parser only emits on FATAL EXCEPTION / ANR markers, and system packages are tagged so `any` can exclude them. A per-device rate cap logs and drops beyond 20 crashes/minute. |
| Aborting a job on a crash makes results *less* reproducible if the crash is incidental. | `declared` is the default and matches only the script's own target; `ignore` restores today's behaviour exactly. |
| The watcher consumes the single stream slot and the Monitor tab stops working. | Raising `adb.maxStreamsPerDevice` to 3 is part of step 37.2, with an acceptance criterion (§6.8) that both coexist. |
| Crash parsing differs across OEM/Android versions. | Fixtures come from the real test devices; the markers used (`FATAL EXCEPTION`, `Process:`, `ANR in`) are AOSP-stable. Unrecognised output is ignored rather than guessed at. |
| Attributing a crash to the wrong job under concurrent manual control. | Attribution requires a **job** lease on that device at the moment the crash arrives; a manual lease means the event is recorded without job attribution. |

## 9. Open questions

1. Should a crash also be surfaced to the script itself (`ctx.device.crashes()`), so an author can assert on it deliberately? Attractive, but it changes the SDK surface; deferred.
2. Should native crashes (tombstones) be captured too? They need `/data/tombstones` access, which is often root-only.
3. Should repeated crashes of the *same* package across jobs raise a device-level signal, or is that purely an app problem? Currently the latter.
