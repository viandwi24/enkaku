# Plan 34 — M16 : Repairing Four Defects in Shipped Behaviour

> Status: draft
> Depends on: Plans 22.1 and 24 (the timeout profiles and the streaming lane are what §4.1's fix moves onto). Nothing depends on this plan, but everything is degraded until it lands.
> Spec references: §7.4 (persistent inspector), §9.3 (timing realism), §10.1 (server-authoritative control), §11.3 (crash containment, not a sandbox), §12 (`ownerId`).

---

## 1. Goals

- The `ui-server` inspector actually starts. Today it never has.
- Starting it does not park a per-device adb queue slot for 15 seconds, and does not log a misleading error every time.
- The farm's **Timing** settings reach the code that performs actions. Today the form saves values nothing reads.
- `app.launch` / `app.forceStop` cannot be turned into arbitrary shell by a job parameter.
- `requirePermission` and `canUseDevice` — both written, both dead — are called where they were meant to be.

Every item here reconnects something already built and already promised in the UI. None of it is a new feature.

## 2. Non-goals

- New inspector engines, new input engines, or changing the degrade chain.
- Full per-message WS authorization. Plan 26 added the first check (`device.shell`); widening that to every message is its own plan. §4.4 wires the HTTP side and the device-ownership rule only.
- Gesture kinematics or per-character typing cadence. Those are separate work; this plan only makes the existing jitter settings take effect.
- Anything about the ui-server APK's provenance or pinned version.

## 3. Context and design decisions

### 3.1 The ui-server has never started — measured, not inferred

`packages/drivers/src/inspector/ui-server/launcher.ts:53` runs:

```
am instrument -w -r -e debug false -e class com.github.uiautomator.test.Stub \
  com.github.uiautomator.test/androidx.test.runner.AndroidJUnitRunner
```

Run verbatim against a real moto g06 power (Android 15) with the toolchain's own APK (`com.github.uiautomator` v2.3.3):

```
INSTRUMENTATION_STATUS: stack=java.lang.ClassNotFoundException:
  com.github.uiautomator.test.Stub
```

It fails in ~1.3 s and the `.catch()` swallows it as a debug line. The inspector then falls back to `uiautomator dump` — silently, for every script, forever.

The class name is wrong. openatx puts the stub in the **app** package under `stub`, not in the **test** package:

```
com.github.uiautomator.stub.Stub        ← correct
com.github.uiautomator.test.Stub        ← what we send
```

Verified by running the corrected command on the same device: port 9008 begins listening, four `uiautomator` processes appear, and the command then hangs — which is the documented, intended behaviour (`launcher.ts:50-51` says so).

The impact is a whole milestone: spec §7.4 and Plan 06 exist to make `find`/`waitFor` fast, and the device page currently tells the operator `UI server (persistent on-device, <200 ms per find)` while the slow path is what actually runs.

### 3.2 Fixing the name alone would trade one bug for another

Once the class is right, `am instrument -w` never returns. It currently goes through `deps.exec`, which since Plan 22.1 carries the `default` 15 s budget. Measured on the same device with the corrected command:

```
instrument rejected after 15003ms: E_ADB_TIMEOUT
t+17s -> port 9008 listening: 1
t+20s -> port 9008 listening: 1
```

Two things follow, and they matter:

- **The server survives.** Unlike an ordinary shell child (a `sleep 60` in the same harness was killed by the socket termination), the instrumentation runs in the app's own process via the activity manager, so it outlives the `am` client. So the deadline does not break the inspector.
- **But it costs a queue slot for 15 s on every start, and logs a false error.** That is exactly the shape of work Plan 24 built the streaming lane for: a command that legitimately never returns must not sit in `PerDeviceQueue`.

So the fix is a pair: correct the class **and** move the call to `execStream`. Doing either alone leaves the system misleading.

### 3.3 Timing settings are saved and never read

`packages/session/src/runner/job-runner.ts:93`:

```ts
const execDevice = createDeviceExecutor({ session })   // no timing argument
```

`createDeviceExecutor` (`device-executor.ts:32-33`) accepts `timing?: TimingSettings` and falls back to `DEFAULT_TIMING`. Meanwhile `FarmSettingsSchema` stores `timing` (`settings.ts:131`) and the Studio form describes it as *"A little randomness in tap timing and position, so automation does not look mechanical"* (`settings.ts:51`).

So the control exists, persists, renders — and does nothing. A user who widens the jitter to make a flaky app behave sees no change and has no way to tell why.

The values must be read at dispatch time, not at daemon start, so a settings change applies to the next job without a restart — matching how Plan 23 made `adb.maxConcurrent` live.

### 3.4 Shell metacharacters in `app.launch`

`packages/session/src/device-executor.ts:111-113`:

```ts
const cmd = call.args.activity
  ? `am start -n ${call.args.pkg}/${call.args.activity}`
  : `monkey -p ${call.args.pkg} -c android.intent.category.LAUNCHER 1`
```

`pkg` and `activity` arrive from the child over IPC, validated as `z.string()` and nothing more (`runner/ipc.ts:30-31`). A value containing `;` or `$(…)` becomes a second command on the device.

**Severity, stated honestly:** a malicious *script author* gains nothing — scripts already run as the core's OS user with full filesystem and network access, and spec §11.3 is explicit that this is crash containment, not a sandbox. The real exposure is narrower and still real: a job enqueued through the API, with attacker-influenced parameters, against a script the operator trusts.

Plan 24 already produced a tested `shellQuote()`. It currently lives in `packages/core/src/device/monitors.ts`, which `@enkaku/session` must not import (core sits above session). So it moves down to `@enkaku/adb` — the package that owns "strings we send to a device shell" — and both callers import it from there.

### 3.5 Two authorization helpers that nothing calls

- `requirePermission(permission)` — `packages/core/src/auth/middleware.ts:51`, a working Hono middleware, **zero call sites**.
- `canUseDevice(user, device)` — `packages/core/src/auth/acl.ts:94`, implements the `ownerId` policy from spec §12, **zero call sites**.

So today an authenticated operator can act on any device regardless of `ownerId`, and route-level permissions are enforced by ad-hoc inline `can()` calls in some handlers and not at all in others.

This plan wires the HTTP surface, which is bounded and testable. Per-message WS authorization stays out of scope (§2) because it needs its own policy pass — Plan 26 established the first such check and the pattern to follow.

## 4. Technical design

### 4.1 ui-server: correct class, streaming lane

`packages/drivers/src/inspector/ui-server/launcher.ts`:

```ts
/**
 * The stub lives in the APP package under `stub` — NOT in the test package.
 * `com.github.uiautomator.test.Stub` throws ClassNotFoundException on the
 * pinned APK (v2.3.3), which is why this inspector silently fell back to
 * `uiautomator dump` from M4.5 until Plan 34 (§3.1).
 */
export const UI_SERVER_STUB_CLASS = `${UI_SERVER_PACKAGE}.stub.Stub`
```

`UiServerLauncherDeps` gains a streaming entry point beside `exec`:

```ts
/** Long-lived commands: the Plan 24 lane, never the per-device queue. */
execStream(cmd: string, opts: { onEnd(reason: string): void }): Promise<{ stop(): Promise<void> }>
```

`start()` then launches the instrumentation through `execStream` and keeps the handle; `stop()`/`release()` calls `handle.stop()` before the existing `am force-stop` pair. The wiring in `packages/session/src/inspector-factory.ts` and `packages/core/src/daemon.ts` passes `AdbClient.execStream` bound to the serial.

The lane's idle timeout must be disabled for this stream (the instrumentation is silent once it is up) — pass `idleTimeoutMs: 0`, and an absolute timeout of 0 as well, since the server is meant to live as long as the session. Both are already supported by `AdbStreamOptions`; if `0` is not currently accepted as "off", make it so and test it.

The launcher's watchdog keeps its existing retry behaviour; it now retries against a stream handle rather than a promise that resolves in 1.3 s.

### 4.2 Timing settings reach the executor

- `packages/session/src/runner/job-runner.ts`: `JobRunnerDeps` gains `timing?: () => TimingSettings` — a getter, not a value, so each job reads the current setting (§3.3).
- Line 93 becomes `createDeviceExecutor({ session, timing: deps.timing?.() })`.
- `packages/core/src/daemon.ts:883` passes `timing: () => settingsStore.get().timing`.

`TimingSettingsSchema` already matches the `TimingSettings` interface; if the tuple shapes differ, adapt in the core rather than loosening the schema.

### 4.3 `shellQuote` moves down, and both call sites use it

- Move `shellQuote` (and its tests) from `packages/core/src/device/monitors.ts` to `packages/adb/src/shell-quote.ts`; export from `@enkaku/adb`; `monitors.ts` re-imports it so Plan 24's behaviour is unchanged.
- `packages/session/src/device-executor.ts`:

```ts
const cmd = call.args.activity
  ? `am start -n ${shellQuote(`${call.args.pkg}/${call.args.activity}`)}`
  : `monkey -p ${shellQuote(call.args.pkg)} -c android.intent.category.LAUNCHER 1`
```

and `am force-stop ${shellQuote(call.args.pkg)}`.

- Tighten the IPC contract too, since a package name is not a free string (`packages/session/src/runner/ipc.ts:30-31`):

```ts
pkg: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/),
activity: z.string().regex(/^[a-zA-Z0-9_.$/]+$/).optional(),
```

Belt and braces on purpose: the regex rejects nonsense early with a clear error, the quoting is what actually guarantees safety.

### 4.4 Wire the two dead helpers

**`requirePermission`** on the HTTP routes that mutate state, replacing inline `can()` calls where they exist so there is one pattern:

| Route group | Permission |
|---|---|
| `POST`/`PATCH`/`DELETE` on `/api/scripts` | `script.manage` |
| `POST`/`DELETE` on `/api/clusters`, `/api/clusters/:id/devices` | `device.manage` |
| `PUT /api/devices/:id/tags`, `PUT /api/devices/:id/cluster` | `device.manage` |
| `POST`/`DELETE` on `/api/schedules`, `/api/batches` | `job.manage` |
| `PUT /api/settings` | `settings.manage` |

Use the permission names that already exist in `acl.ts`; add one only if a row above has no equivalent, and say so in the report rather than inventing a taxonomy.

**`canUseDevice`** at the points where a specific device is acted on: job enqueue, batch dispatch, lease acquire, and the Plan 27 endpoint. Refuse with `auth.forbidden` and the message "this device belongs to another user".

Because `devices.ownerId` is `null` for every device on a fresh install, this changes nothing for existing single-user setups — which is the point: it makes an unused policy real without changing default behaviour.

## 5. Implementation steps

**34.1 — ui-server stub class**
- Add `UI_SERVER_STUB_CLASS` and use it (§4.1).
- Result: on a real device the instrumentation starts and port 9008 listens. Without a device: a unit test asserts the command string contains `com.github.uiautomator.stub.Stub` and never `.test.Stub`.

**34.2 — ui-server on the streaming lane**
- Extend `UiServerLauncherDeps` with `execStream`; thread `AdbClient.execStream` through `inspector-factory.ts` and `daemon.ts`; support `0` = off for both stream clocks.
- Result: starting the inspector leaves `client.pending(serial) === 0`, and no `E_ADB_TIMEOUT` appears 15 s later.

**34.3 — Timing settings**
- `JobRunnerDeps.timing` getter; pass it at `job-runner.ts:93`; wire `settingsStore` in `daemon.ts` (§4.2).
- Result: a test asserts the executor receives the configured values, and that changing them between two jobs changes the second job's behaviour without a restart.

**34.4 — `shellQuote` and the IPC regexes**
- Move the helper into `@enkaku/adb`; apply it at the three call sites; tighten the Zod schemas (§4.3).
- Result: a test drives `app.launch` with `pkg: 'com.x; touch /data/local/tmp/pwned'` and asserts the built command cannot execute a second statement.

**34.5 — `requirePermission` and `canUseDevice`**
- Apply per §4.4, replacing inline `can()` calls in the same routes.
- Result: an operator is refused on an admin-only route, and refused on a device owned by another user, with the coded error.

**34.6 — Correct the inspector claim in Studio**
- The device page's engine panel should report the **effective** engine (`session.inspectorEngineId`, which already exists and already reflects fallbacks) rather than a hardcoded description. If it already reads the effective value, verify it renders `uiautomator-dump` when a fallback happens and leave it alone.

## 6. Acceptance criteria

1. On a physical device, starting a session and running a script that calls `find`/`waitFor` starts the ui-server: port 9008 listens and `inspectorEngineId` reports the ui-server engine, not `uiautomator-dump`.
2. While the ui-server runs, `client.pending(serial)` is 0 and no `E_ADB_TIMEOUT` is logged for the instrumentation.
3. Stopping the session stops the instrumentation and leaves no `uiautomator` process on the device.
4. Changing **Timing** in Studio changes the next job's pacing with no restart; the previous default is used when the setting is absent.
5. `app.launch` with a `pkg` containing `;`, `$(…)`, or backticks runs no second command; the tightened schema rejects an invalid package name with a clear error.
6. Plan 24's monitors still build identical command strings after `shellQuote` moves packages (its existing tests pass unchanged).
7. An operator hitting an admin-only route is refused by `requirePermission`, not by an inline check.
8. An operator acting on a device owned by another user is refused by `canUseDevice`; a device with `ownerId: null` is unaffected.
9. The device page reports the engine actually in use.
10. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit (no device):**
- `launcher.test.ts` — the command string uses `stub.Stub`; `start()` goes through `execStream` and never `exec`.
- `job-runner.test.ts` — the timing getter is called per job and its values reach the executor.
- `shell-quote.test.ts` — moved with the helper; add the `am start` injection cases.
- `ipc.test.ts` — package/activity regexes accept real names and reject metacharacters.
- `acl` / route tests — the refusal matrix for both helpers.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, a physical device):**
```bash
bun run dev && bun run dev:studio
# 1. run a script using waitFor → device page shows the ui-server engine
adb -s <serial> shell "netstat -ltn | grep 9008"     # listening
curl -s localhost:7700/api/adb/stats                 # queueDepth 0 for that device
# 2. wait 30s → no E_ADB_TIMEOUT for am instrument in the core log
# 3. stop the session → no uiautomator process remains
# 4. widen Timing in Settings, run the same script → pacing visibly changes, no restart
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The stub class differs on a future pinned APK and this breaks again, silently. | The failure must stop being silent: the launcher's `catch` currently logs at `debug`. Raise a failed instrumentation to `warn` with the class name, and let the existing fallback continue — a degraded engine should be visible, which §4.6 also addresses in the UI. |
| Disabling both stream clocks re-creates an unbounded resource. | It is bounded by the session: the handle is stopped in `release()`, and Plan 24's `stopForDevice` already fires when a device goes away. The lane's per-device cap still applies. |
| ui-server now occupies the single default stream slot, so a user cannot also watch logcat. | `adb.maxStreamsPerDevice` defaults to 1 (Plan 24 §3.2). This plan must raise that default to 2 and say why, or the inspector and the Monitor tab will fight. Verify on a real device. |
| Tightening the IPC regexes rejects a package name someone legitimately uses. | The regex mirrors Android's own package rules; the smoke test includes a real launch. A rejection produces a clear coded error rather than a silent no-op. |
| `requirePermission` on a route an existing UI flow depends on locks an operator out. | Every route in §4.4 keeps the permission it effectively had; only the enforcement point moves. Tested per route. |

## 9. Open questions

1. Should a failed inspector start surface as a device event (Plan 18 `main` stream) rather than only a log line? It is the kind of degradation an operator should see; deferred so this plan stays small.
2. `adb.maxStreamsPerDevice` may need to become "monitor streams" specifically, counted separately from infrastructure streams like the ui-server. If the risk-table bump to 2 proves awkward, that separation is the cleaner answer.
3. Should `canUseDevice` also gate *reading* a device (the list, the video), or only acting on it? This plan gates acting only.
