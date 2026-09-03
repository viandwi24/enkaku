# Plan 208 — MVP wave 1 : Inspector phase 1 — session-scoped, fail-fast, idle-wait configured, capability path fixed

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 206 (always-on sessions: `DeviceSession.prewarmInspector()` and the builder's `INSPECTOR_PREWARM_DELAY_MS` call after the first frame; this plan replaces the no-op body 206 ships), plan 205 (device activities: nothing is consumed; the inspector is deliberately not an activity, plan 206 §3.3, and its progress rides on the existing `device.inspector.status` message), plan 200 (rules, format, references R1..R8).
> Spec references: `docs/mvp/02-inspector-readiness.md` (entire; §2.1 to §2.7 are the root causes, §4 phase 1 is the scope and the exit criteria), `docs/mvp/13-removal-register.md` A.9 (the two rows this plan owns; the third row, the `instrumentation` lock conflict, is plan 222's), `docs/mvp/16-consolidated-plan.md` §1 "Mechanisms", §2 Inspector row, §3 wave 1. `docs/mvp/10-guest-agent.md` §1.1 is read for §9 Q4 only. External facts: R5 (plan 200 §5). `docs/spec.md` §7.4, §7.9 and §16 are superseded by `docs/mvp/16` for this series (plan 200 header).
> Ships: packages/drivers/src/inspector/ui-server/lifecycle.ts

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_208` is the one gate grep, defined once in §10 and copied verbatim wherever it is cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The inspector is session-scoped: started by `prewarmInspector()`, joined by `whenInspectorReady()`, released only by `close()`; `releaseInspector` no longer exists | `DeviceSession` has no `releaseInspector`; `close()` calls the handle's `release()` exactly once | `bun test packages/session/src/session.test.ts` → tests `prewarmInspector starts the engine once and whenInspectorReady joins it`, `close releases the inspector handle exactly once` pass; `rg -n "releaseInspector" packages apps plugins scripts` → empty | [ ] |
| G2 | `inspect.attach` attaches to the running engine; the ref-counted teardown is gone | `inspectorRefCounts`, `detachInspector` deleted; `inspect.detach` and a WS close only record `inspect.detached` | `bun test packages/core/src/server/ws-handlers-inspect.test.ts` → tests `inspect.detach records the event and never touches the session`, `closing the WS records inspect.detached and never touches the session` pass; `rg -n "inspectorRefCounts|detachInspector" packages/core/src` → empty | [ ] |
| G3 | A definitive instrumentation failure fails the start within 2 s; only silence pays the 15 s ceiling | `INSTRUMENTATION_FATAL_PATTERNS` (§4.2); `INSTRUMENTATION_START_SILENCE_MS = 15_000` | `bun test packages/drivers/src/inspector/ui-server/lifecycle.test.ts` → tests `a fatal line 300 ms into the stream rejects start() in under 2 s`, `silence pays the ceiling and nothing less`, and the classification table test pass | [ ] |
| G4 | `setConfigurator` is called after every `healthy`, with the idle-wait timeouts at 0 | body `{ jsonrpc: '2.0', id, method: 'setConfigurator', params: [DEFAULT_CONFIGURATOR] }` | `bun test packages/drivers/src/inspector/ui-server/client.test.ts` → test `setConfigurator posts the ConfiguratorInfo as the single positional param` passes; `bun test packages/drivers/src/inspector/ui-server/lifecycle.test.ts` → test `the configurator is applied after start and after every restart` passes | [ ] |
| G5 | The capability path uses the session's engine: `deviceCall` awaits `whenInspectorReady()` for inspector methods and nothing outside the factory instantiates the dump engine | exactly one `new UiautomatorDumpInspector(` in non-test code, in `packages/session/src/inspector-factory.ts` | `rg -n "new UiautomatorDumpInspector\(" packages --glob '!**/*.test.ts'` → one line, path `packages/session/src/inspector-factory.ts`; `bun test packages/core/src/capability/context.test.ts` → test `deviceCall awaits whenInspectorReady for find and never builds a dump engine` passes; `bun test packages/session/src/device-executor.test.ts` → test `find, dump, waitFor, screenshot throw E_INSPECTOR_STARTING while the session has no inspector` passes | [ ] |
| G6 | The instrumentation stream holds no lane slot | `execStream(..., { pinned: true })` from the factory; `StreamLane` counts it in `pinned` only | `bun test packages/adb/src/client.test.ts` → test `a pinned stream takes neither a per-device nor a farm-wide slot` passes; `bun test packages/session/src/inspector-factory.test.ts` → test `the instrumentation stream is pinned with both clocks off` passes | [ ] |
| G7 | The failing-action trace capture reuses the last dump when it is fresh | `TRACE_TREE_REUSE_MS = 2_000` | `bun test packages/session/src/runner/trace.test.ts` → test `reusableTree returns the cached root within 2 s and null after` passes | [ ] |
| G8 | `E_INSPECTOR_STARTING` is a distinct code on the session error class and on the WS `inspect.dump`/`inspect.find` refusal | `SessionError` code union contains it; `ws-handlers.ts` sends it when `session.inspector === null && session.inspectorEngineId === 'starting'` | `rg -n "E_INSPECTOR_STARTING" packages/session/src/errors.ts packages/core/src/server/ws-handlers.ts` → at least one hit in each; `bun test packages/core/src/server/ws-handlers-inspect.test.ts` → test `a dump while the engine is still starting answers E_INSPECTOR_STARTING, not unavailable` passes | [ ] |
| G9 | The ui-server 2.4.0 evaluation is done on the lab device and the manifest says the outcome | either the pin is `2.4.0` with a computed sha256, a `versionCode` from the APK, a real `compatibleCoreRange`, and no `TODO-M4.5`; or the pin stays `2.3.3` and §9 Q1 plus §11 record why | `rg -n "TODO-M4.5" packages/toolchain/manifest/enkaku-tools.json` → empty, or §11 "Open questions hit" names Q1 with the measured reason | owner |
| G10 | Attach is fast on the lab device | warm (engine already ready): `inspect.attached` event `meta.tookMs ≤ 3000`; cold (prewarm from a fresh session): the `inspector ready:` log line reports `≤ 8000 ms` | owner, §7 device smoke | owner |
| G11 | `find` p95 under 200 ms on the lab device | `find() p95` row `< 200 ms` | owner: `ENKAKU_TEST_DEVICE=1 bun run scripts/bench-device-nfrs.ts --serial <serial> --skip-video` | owner |
| G12 | Zero fallbacks during a 10-minute 20-device job run | 0 `device.inspector.fallback` broadcasts and 0 `session.degraded` events with `to: 'uiautomator-dump'` in the window | owner, §7 farm smoke | owner |
| G13 | The bench prints the cold-attach rows | `--attach-cycles` flag; rows `ui-server attach cold p50`, `ui-server attach cold max` | `bun run scripts/bench-device-nfrs.ts --help` lists `--attach-cycles` | [ ] |
| G14 | `bun run typecheck` is clean | 0 errors | `bun run typecheck` → exit 0 | [ ] |
| G15 | The forbidden words of §10 are gone | 0 matches | `GREP_208` → empty | [ ] |

## 1. Goals

1. One inspector per session, for the life of the session: started in the background by `prewarmInspector()` 2 s after the first frame (plan 206 §3.9), joined by every later caller through `whenInspectorReady()`, torn down by `close()` and by nothing else (MVP 02 §4 phase 1, first bullet). The Inspect tab attaches to what is running; closing the tab keeps it running.
2. A start that cannot succeed fails in the time it takes the instrumentation to say so: the `am instrument -w -r` stream is read line by line, and a definitive failure line rejects the start within 2 s. The 15 s ceiling exists only for a server that says nothing (MVP 02 §4 phase 1, second bullet; the measured 1.3 s `ClassNotFoundException` at `launcher.ts:12-17`).
3. The idle wait is configured: after every `healthy`, the openatx configurator is set so a dump or a find never waits for an animating screen to settle (MVP 02 §2.4, §4 phase 1, fourth bullet; R5).
4. Agents, REST and MCP use the same engine a script does: `deviceCall` awaits the session's inspector for `find`, `dump`, `waitFor` and `screenshot`, and the only code that ever constructs `UiautomatorDumpInspector` is the factory's fallback (MVP 02 §2.5, §4 phase 1, third bullet).
5. The instrumentation no longer holds a counted stream slot (plan 85 F4/F7): it is a pinned stream, visible in the stats, and the lane's budget serves the bursty users it was sized for.
6. The failing-action trace capture reuses the dump the script just paid for when it is fresh, instead of a second round trip on the same RPC channel (MVP 02 §2.6, `job-runner.ts:1287-1288`).
7. Error wording keeps plan 129's refusal-versus-timeout distinction, and a caller that arrives before the first dump is possible gets `E_INSPECTOR_STARTING` ("starting, retry"), never "unreachable".
8. The open question of plan 129 step 129.4 is closed on the lab device: openatx 2.4.0 is installed and started on API 36, the bench is run, and the manifest pin either moves with a sha256 this plan computes or stays with the ceiling written down (R5).

## 2. Non-goals

| Not done here | Plan that does it |
|---|---|
| The first-party `AccessibilityService` (`ui-tree`, `ui.watch`, push-based `waitFor`) | plan 221 (guest agent) and plan 222 (inspector phase 2) |
| Deleting `UiautomatorDumpInspector`; it stays as the last-resort engine chosen by the factory | plan 222 demotes it further; nothing deletes it in the MVP |
| Changing the `instrumentation` lock semantics (`descriptors.ts:79`, `:129`) or the lock conflict row of MVP 13 A.9 | plan 222 (the conflict disappears when `ui-tree` is the default) |
| Swapping the engine at runtime when the watchdog trips its circuit breaker (`watchdog.ts:124-134`); the `dead` state still means `UI_SERVER_UNREACHABLE` until the session is rebuilt | plan 222 (the `ui-tree` engine has no process to die) |
| The always-on builder, the prewarm delay, the `prep` activity | plan 206 |
| Serialising installs per USB root and the 20-device scale run | plan 206 (`buildsPerUsbRoot`) and plan 223 |
| Studio: the Inspector tab inside Device Control, its engine badge and fallback copy | plan 215 (this plan changes no Studio file; `InspectorPanel.tsx` keeps sending `inspect.attach` and `inspect.detach`, both still accepted) |
| The `adb.maxStreams` formula (`computeAutoStreams`, `adb-scaling.ts:29-31`); this plan pins the instrumentation off the lane and rewrites the rationale comment, the number stays until plan 223 measures | plan 223 |
| A lease or activity gate on `inspect.*` (today `deps.leases.touchManual` at `ws-handlers.ts:2196`) | plan 205 |
| Cloud node parity (`packages/node/src/hosts.ts:70-89` keeps the same factory; the node has no always-on builder and therefore no prewarm) | post-MVP (MVP 16 §1) |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03)

The inspector is the openatx `android-uiautomator-server` 2.3.3 pair (`packages/toolchain/manifest/enkaku-tools.json:87-129`, `"version": "2.3.3"`, `"compatibleCoreRange": "TODO-M4.5"`, `"releasedAt": "unknown"`, `"versionCode": 2003003`), run as an instrumentation and reached over HTTP JSON-RPC on device port 9008 (`launcher.ts:22`, `export const UI_SERVER_DEVICE_PORT = 9008`).

- **Launch.** `packages/drivers/src/inspector/ui-server/launcher.ts:396`, `const cmd = \`am instrument -w -r -e debug false -e class ${UI_SERVER_STUB_CLASS} ${UI_SERVER_INSTRUMENTATION}\``; `:397`, `instrumentation = await deps.execStream(cmd, {` with only an `onEnd` hook (`:112-115`, `execStream: (cmd: string, opts: { onEnd: (reason: AdbStreamEndReason, err?: unknown) => void }) => Promise<{ stop: () => Promise<void> }>`). The stream's bytes are thrown away: `packages/session/src/inspector-factory.ts:104`, `onData: () => {},`. The launcher's own comment records the one measurement this plan builds on: `:15-17`, "the wrong class fails in ~1.3s with `INSTRUMENTATION_STATUS: stack=java.lang.ClassNotFoundException: com.github.uiautomator.test.Stub`". `start()` (`:388-424`) resolves after the shell handshake and `assertForward` (`:275-291`, the host-port ownership check); `stop()` (`:426-436`) kills the forward, the stream, and force-stops both packages. `pm list packages` runs at `:200` with `{ profile: 'probe' }`.
- **Readiness.** `watchdog.ts:103-110` polls `client.ping()` every 250 ms until `startTimeoutMs` (`:83`, `const startTimeoutMs = opts.startTimeoutMs ?? 15_000`); `start()` (`:163-203`) throws `ui-server was not ready within the start timeout` at `:180` and marks `dead` (plan 129 §4.1: no second cycle on the start path). Runtime: `idlePingMs` 5000 (`:82`), restart after two consecutive failures (`:199`), backoff `[1000, 3000, 10_000, 30_000]` (`:18`), breaker 3 cycles per 10 minutes (`:84-85`).
- **Client.** `client.ts:37-41` timeouts (`PING_TIMEOUT_MS = 1000`, `RPC_TIMEOUT_MS = 5000`, `DUMP_WINDOW_HIERARCHY_TIMEOUT_MS = 20_000`, `SCREENSHOT_TIMEOUT_MS = 15_000`); `:100-109` the plan 129 wording (`:106`, `const detail = timedOut ? \`did not respond within ${timeoutMs}ms\` : \`failed after ${Date.now() - startedAt}ms\``); `:118-126` the one stale-forward retry; methods `dumpWindowHierarchy` (`:165`), `objInfo` (`:170`), `screenshot` (`:179`), `setText` (`:185`), `longClick` (`:189`), `doubleClick` (`:194`). No configurator call exists anywhere (`rg -n "setConfigurator|waitForIdleTimeout" packages` is empty today).
- **Inspector.** `index.ts:49`, `readonly recommendedPollIntervalMs = 80`; `:79-81` `start()` delegates to the watchdog; `:92-101` `call()` reports `UI_SERVER_UNREACHABLE` to the watchdog; `:103-122` `dump()` retries once after 300 ms; `:129-139` the cached viewport. `selector.ts:35-42` carries the openatx bitmask (`resourceId: 0x200000`, ...). `verify.ts` compares `dumpsys package` against the manifest expectation.
- **Factory.** `packages/session/src/inspector-factory.ts:53`, `const DUMP_POLL_MS = 500`; `:66-71` `dumpHandle()`; `:102-108` the stream with both clocks off (`idleTimeoutMs: 0, absoluteTimeoutMs: 0`); `:129-130` `await inspector.start()` then `if (inspector.isDead()) throw ...`; `:142-148` the catch that logs `ui-server cannot be used on ${opts.deviceId} (${reason}) — falling back to uiautomator-dump`, calls `onFallback`, and returns the dump handle.
- **Session.** `packages/session/src/session.ts:473-492` the lazy-start comment with the two measurements (about 50 s to the first frame when awaited up front; 1 frame in 20 s when started in the background before video); `:495`, `const startInspector = (): Promise<void> => {`, start-once through `inspectorPromise`; `:505-507` the catch that logs `inspector could not start: ... — scripts will use an ad-hoc dump` and still resolves; `:510-517` `releaseInspector` resets the handle; `:852-857` the session fields (`inspector: null`, `inspectorEngineId: 'starting'`, `inspectorPollIntervalMs: 500`, `whenInspectorReady: startInspector`, `releaseInspector`); `:931`, `await inspectorHandle?.release()` inside `close()`. The interface: `:119-120` `inspector: Inspector | null`, `:128` `whenInspectorReady(): Promise<void>`, `:176` `releaseInspector(): Promise<void>`, `:178` `inspectorEngineId: string`. Plan 206 §4.4 adds `prewarmInspector(): Promise<void>` as a no-op beside `whenInspectorReady` and calls it from `always-on.ts` `INSPECTOR_PREWARM_DELAY_MS = 2_000` after step 5.
- **Executor.** `packages/session/src/device-executor.ts:165`, `const inspector: Inspector = deps.session.inspector ?? new UiautomatorDumpInspector(deps.session.transport)`; `:472-494` the `waitFor` loop (`:476`, `const interval = Math.min(call.args.intervalMs, deps.session.inspectorPollIntervalMs)`). A second ad-hoc instantiation: `packages/session/src/runner/job-runner.ts:1142`, `await (session.inspector ?? new UiautomatorDumpInspector(session.transport)).screenshot()`.
- **Capability path.** `packages/core/src/capability/context.ts:497-515` `deviceCall` acquires (`:503`), builds an executor (`:505-510`), runs, releases; it never calls `whenInspectorReady`. `device-inspect.ts:38`, `:55`, `:94`, `:128` pass `'wall'` as the quality. So an agent, `POST /api/v1/cap`, or an MCP caller on a device with no running job and no open Inspect tab lands on the ad-hoc dump engine, which takes the `instrumentation` lock (`packages/drivers/src/descriptors.ts:129`, `locks: ['instrumentation']`) and seizes UiAutomation from any healthy ui-server (`ui-server/README.md:23`).
- **WS.** `packages/core/src/server/ws-handlers.ts:76`, `const INSPECT_DEADLINE_MS = 20_000`; `:97`, `const INSPECT_ATTACH_DEADLINE_MS = 45_000`; `:117-119` `inspectorCapabilities`; `:238` `inspectAttached: Set<string>` on `ConnState`; `:621`, `const inspectorRefCounts = new Map<string, number>()`; `:624-635` `detachInspector` releases the engine at zero (`:633`, `await session?.releaseInspector().catch(...)`); `:2198-2257` `inspect.attach` (awaits `whenInspectorReady()` under the deadline at `:2204-2209`, counts at `:2242-2251`, records `inspect.attached` once per device at `:2249`); `:2260-2264` `if (!inspector) { sendError(ws, 'E_INSPECT_UNAVAILABLE', 'attach to the inspector first (inspect.attach)', msgId)`; `:2319-2322` `inspect.detach`; `:2627-2629` `handleClose` detaches every attached device; `:2688-2691` `resetInspectForDevice` clears the count and the sets.
- **Jobs.** `job-runner.ts:1377-1381`: `session = await deps.sessions.acquire(job.deviceId, noopFrame)` then `await session.whenInspectorReady()` per attempt (the word is the code's; plan 200 §2.4 keeps `attempt` inside this loop). `:1271-1294` `captureForTrace`: `:1287-1288`, `} else if (req.uiTree === 'capture' && inspector) { uiHash = await store.putUiTree(job.id, await inspector.dump()) }`. `trace.ts:139` `TREE_METHODS`, `:235-239` `resolveFramePolicy` (`'ui-server'` → `'per-action'`), `:310` `MAX_CONCURRENT_CAPTURES = 4`, `:495-499` `capturesTree = resolved !== 'none' && failing`.
- **Lane.** `packages/adb/src/client.ts:22-35` `AdbStreamOptions` (`onData`, `onEnd`, `idleTimeoutMs`, `absoluteTimeoutMs`, `maxBytes`, `signal`); `:50-100` `StreamLane` (`acquire(serial)` at `:80` throws `E_ADB_STREAM_LIMIT` per device at `:82-87` and farm-wide at `:88-93`); `:569`, `const releaseLane = this.streamLane.acquire(serial)`; `:631-650` `handleChunk` strips the PID line and forwards bytes to `opts.onData`. `packages/core/src/device/adb-scaling.ts:29-31`, `computeAutoStreams(n) = min(64, max(8, ceil(n * 2.5)))`, whose comment (`:20-27`) derives the 2.5 from "the ui-server instrumentation and the crash feed, one slot each". Settings: `packages/protocol/src/settings.ts:1228-1248` (`maxStreamsPerDevice` default 4, `maxStreams` default 0 = auto). Stats: `packages/protocol/src/api/adb.ts:64-69` (`streams: z.object({ maxStreams, maxStreamsPerDevice, active, perDevice })`), `packages/core/src/api/adb-stats.ts:150` and `:189-193`.
- **Timeouts and ports.** `packages/adb/src/timeouts.ts:30-44` (`probe: 5_000`, `appLifecycle: 15_000`, `inspectorDump: 20_000`); `packages/session/src/port-allocator.ts:91`, `const fallback = { rangeStart: 27100, rangeEnd: 27299 }`. The bench uses port 27510 (`scripts/bench-device-nfrs.ts:157`).
- **Bench.** `scripts/bench-device-nfrs.ts:215-293`: builds a launcher (`:217-233`, with `onData: () => {}` at `:227`) and an inspector (`:235-245`), measures `ui-server attach` (`:248-252`), `dump() latency` (`:254-258`), `find() p50/p95/max` (`:265-278`), fails past a 2000 ms p95 (`:283`).
- **Plan 129.** §0.1 (`docs/plans/129-...md:14-34`): three attaches of 31 957, 32 010 and 31 986 ms on the owner's API 36 farm, then dumps failing in 5 ms with `Unable to connect`. Step 129.4 (`:219-220`): "Why ui-server does not start on Android 16, diagnosis, owner-gated"; suspicion on record: 2.3.3 on API 36.
- **Protocol.** `packages/protocol/src/messages/inspect.ts:21-32` (`InspectAttachMessage` documented as "ref-counted per device", `InspectDetachMessage` as "released for real once the last one leaves"), `:50` `InspectStateSchema = z.enum(['detached', 'starting', 'ready', 'unavailable'])`; `packages/protocol/src/messages/enroll.ts:45-53` `DeviceInspectorStatusMessage` with `state: z.enum(['starting', 'healthy', 'restarting', 'dead'])`; `packages/protocol/src/driver.ts:141-156` the `Inspector` interface (`dump`, `find`, `screenshot`, optional `findDetailed`); `packages/session/src/errors.ts:2-44` the `SessionError` code union. Device event kinds `inspect.attached`/`inspect.detached` at `packages/protocol/src/messages/device-event.ts:43-46`.
- **Studio.** `InspectorPanel.tsx:461` sends `inspect.attach` with a 50 s budget and `:495` sends `inspect.detach` on unmount; `app/device/page.tsx:360-371` and `DeviceLog.tsx:292` consume `device.inspector.fallback`/`device.inspector.status`. None of these change.

### 3.2 Session scope, not tab scope

MVP 02 §2.1 names the cost: every reopen of the Inspect tab and every job on an idle session paid a full cold start, because the engine was released when the tab's ref count hit zero and when the session idle-closed. Plan 206 removed the second cause (a session lives while the device is online). This plan removes the first: the engine is owned by the session and the tab is a viewer of it. `prewarmInspector()` runs the start in the background 2 s after the first frame (plan 206's `onFirstFrame`), which respects the measured screencap starvation at `session.ts:477-482` without keeping the engine lazy for the rest of the session.

`whenInspectorReady()` keeps its contract (start-once, join, never rejects) so `job-runner.ts:1381` and `ws-handlers.ts:2205` need no change of shape. `releaseInspector` is deleted rather than kept as a no-op: a method that exists and does nothing is the compatibility shim plan 200 §2.1 forbids.

### 3.3 Fail fast: read the stream, keep the ceiling for silence only

`am instrument -r` prints its status as `INSTRUMENTATION_*` lines on the same stream the launcher already holds; the launcher discards them today (`inspector-factory.ts:104`). This plan feeds them to a line parser. The failure vocabulary is in two tiers:

1. **Definitive, from repo evidence**: `INSTRUMENTATION_STATUS: stack=` followed by `ClassNotFoundException` (`launcher.ts:16-17`, measured at about 1.3 s). Any `INSTRUMENTATION_STATUS: stack=` line during the start is a failure of the test that hosts the server.
2. **Definitive, from the platform's documented raw format, to be confirmed on the lab device (§9 Q3)**: `INSTRUMENTATION_STATUS: Error=`, `INSTRUMENTATION_RESULT: shortMsg=` (with `Process crashed` as its usual value), `INSTRUMENTATION_FAILED:`. The regex table (§4.2) lists them as data, so the executor extends it from the lab device's own output rather than editing a state machine.

The instrumentation exiting (`onEnd` with any reason but `stopped`) during the start is definitive too; the launcher reports it through the same hook. The watchdog's `waitReady` loop checks the hook's verdict on every 250 ms tick and returns the reason instead of waiting for the ceiling, which is how a 1.3 s line becomes a start that fails in under 2 s. The ceiling `INSTRUMENTATION_START_SILENCE_MS = 15_000` (the value of `startTimeoutMs` today) is now what it always claimed to be: the budget for a server that says nothing.

At runtime, the same exit hook feeds `watchdog.reportFailure`, so a server that dies is restarted on the next tick rather than after two 5 s pings.

### 3.4 Idle wait

UiAutomator waits for the window to be idle before a dump or an action; on a screen with continuous animation that wait is the whole timeout (MVP 02 §2.4). openatx exposes the `Configurator` through a JSON-RPC method that takes a `ConfiguratorInfo` (R5). This plan sends it after every `healthy` (start and restart; a restarted process has default values again):

| Field | Value | Why |
|---|---|---|
| `waitForIdleTimeout` | 0 | never wait for the window to settle before a dump or a find; the caller polls at 80 ms and decides for itself what "settled" means |
| `waitForSelectorTimeout` | 0 | `objInfo` answers "not found" immediately instead of blocking on the device; the `waitFor` loop in `device-executor.ts:482-494` is the wait |
| `actionAcknowledgmentTimeout` | 0 | `click`/`longClick`/`setText` return as soon as the injection is done instead of waiting up to the default acknowledgment window for an accessibility event; scripts inject input through scrcpy anyway (spec §9) and the element actions are the exception |
| `scrollAcknowledgmentTimeout` | 0 | same reason as the action acknowledgment; no scroll goes through ui-server today (`client.ts:137-198` has no scroll method), set for symmetry so a future scroll does not reintroduce the wait |
| `keyInjectionDelay` | 0 | the platform default, sent explicitly so the server never applies a stale value from a previous configurator |

`uiAutomationFlags` is not sent: it exists from 2.3.11 (R5), the pin is 2.3.3, and its one relevant bit is a plan 221 question (§9 Q4). The exact method and field names are verified against the pinned tag's source before the call is written (§5 step 208.4).

### 3.5 The capability path

`deviceCall` (`context.ts:497-515`) awaits `session.whenInspectorReady()` before an inspector method. Not before every method: a `tap` from an agent must not wait on an engine it does not use, and the prewarm has usually finished by the time an agent acts. The four inspector methods are named in one exported set in `device-executor.ts` (`INSPECTOR_METHODS`) so the context and the executor cannot disagree.

Inside the executor the session's inspector is read per call, never captured at construction (`:165` captured it once, which is why a `null` there became a fresh dump engine). A `null` inspector is now an error, `E_INSPECTOR_STARTING`, never a substitute engine: the substitute is exactly what killed the healthy ui-server in the other session (MVP 02 §2.5). The dump engine is created in one place, `inspector-factory.ts:66-71`, on the factory's own fallback path or when the device's configured engine is `uiautomator-dump`.

### 3.6 The stream slot

`computeAutoStreams` already budgets 2.5 slots per device (`adb-scaling.ts:29-31`), so plan 85 F7's "two devices exhaust the farm" is a fixed-budget farm's problem (`adb.maxStreams` pinned by an operator). What is still wrong is that a session-lifetime stream and a bursty stream compete for the same per-device cap of 4 (`settings.ts:1228-1237`): with the instrumentation now alive for the whole session, a device with the crash watcher, a transfer and a Monitor tab is at 4 and the next stream is refused. The instrumentation is therefore moved off the counted lane: `execStream` gains `pinned: true`, `StreamLane` counts it in a separate `pinned` figure that never gates anything, and the stats report it so the operator can see it. The formula's constant stays (non-goal; plan 223 measures) and its comment is rewritten to say the truth: one steady-state slot (the crash watcher), one and a half of headroom.

Serialising the installs behind the start is not this plan's: `launcher.ts:150-191` already routes them through `installWithGrantFallback` with `lane: 'install'` and the farm's `adb.maxInstallConcurrent` (plan 85 §3.4), and the per-USB-root stagger of the session build is plan 206 §3.5 (`buildsPerUsbRoot`), which the prewarm inherits because it runs after the build's first frame.

### 3.7 The cheap cache

`job-runner.ts:1287-1288` takes a real dump for the failing action's trace. The script has usually just paid for one (`find`/`waitFor`/`dump` are the actions that fail on an absent element). Every engine now remembers its last successful dump with a timestamp; the capture reuses it when it is at most `TRACE_TREE_REUSE_MS = 2_000` old and dumps otherwise. The window is short on purpose: a tree from thirty seconds ago is not the picture a debugger came for (`trace.ts:496-499`).

### 3.8 Error wording

Plan 129 §4.2's distinction stays exactly as written (`client.ts:100-109`). One code is added: `E_INSPECTOR_STARTING`, raised where a caller reaches the engine before it exists. It is a `SessionError` code so a script sees it as the `code` on the error the IPC bridge rebuilds (`child-entry.ts:245`, `Object.assign(new Error(...), { code: msg.error?.code })`), and it is the WS refusal for `inspect.dump`/`inspect.find` while `inspectorEngineId === 'starting'`. It is not an `inspect.status` state: `InspectStateSchema` already has `starting`, and the attach reply carries it.

### 3.9 Why `lifecycle.ts` and what it owns

Today the start is split across three files with no owner: the launcher spawns, the watchdog polls, the factory decides. `lifecycle.ts` is the one place that knows the state of one device's ui-server for one session: `idle → starting → ready → dead | failed → closed`. It owns the line parser, the configurator application, the timing of the start (for the `inspector ready` log line and the bench), and the mapping to `device.inspector.status`. `UiServerInspector` (`index.ts`) delegates `start`/`stop` to it instead of to the watchdog directly; the watchdog keeps the runtime restart and the circuit breaker unchanged.

## 4. Technical design

### 4.1 File structure

```
packages/drivers/src/inspector/ui-server/
  lifecycle.ts                 NEW   line parser, fatal patterns, session-scoped lifecycle, configurator application
  lifecycle.test.ts            NEW
  launcher.ts                  CHANGED  execStream gains onData; start(localPort, hooks) reports fatal lines and exits
  launcher.test.ts             CHANGED
  watchdog.ts                  CHANGED  waitReady consults the fatal verdict; onReady hook; DEFAULT_START_TIMEOUT_MS renamed
  watchdog.test.ts             CHANGED
  client.ts                    CHANGED  ConfiguratorInfoSchema, DEFAULT_CONFIGURATOR, setConfigurator, getConfigurator
  client.test.ts               CHANGED
  index.ts                     CHANGED  UiServerInspector uses the lifecycle; lastDump(); exports
  README.md                    CHANGED
packages/drivers/src/inspector/
  uiautomator-dump.ts          CHANGED  lastDump()
packages/drivers/src/index.ts  CHANGED  exports
packages/protocol/src/
  driver.ts                    CHANGED  Inspector.lastDump?()
  messages/inspect.ts          CHANGED  doc comments only (attach-to-running)
  messages/device-event.ts     CHANGED  doc comments only
  api/adb.ts                   CHANGED  streams.pinned
packages/adb/src/
  client.ts                    CHANGED  AdbStreamOptions.pinned; StreamLane pinned count; streamStats().pinned
  client.test.ts               CHANGED
packages/adb/README.md         CHANGED
packages/session/src/
  session.ts                   CHANGED  prewarmInspector body, releaseInspector deleted, timing log
  session.test.ts              CHANGED
  errors.ts                    CHANGED  E_INSPECTOR_STARTING
  device-executor.ts           CHANGED  INSPECTOR_METHODS, needsInspector, no dump engine
  device-executor.test.ts      CHANGED
  inspector-factory.ts         CHANGED  onData pass-through, pinned: true
  inspector-factory.test.ts    CHANGED
  index.ts                     CHANGED  exports
  runner/job-runner.ts         CHANGED  :1142 no dump engine; :1287 reusable tree
  runner/trace.ts              CHANGED  TRACE_TREE_REUSE_MS, reusableTree
  runner/trace.test.ts         CHANGED
packages/session/README.md     CHANGED
packages/core/src/
  capability/context.ts        CHANGED  deviceCall awaits whenInspectorReady for inspector methods
  capability/context.test.ts   CHANGED
  server/ws-handlers.ts        CHANGED  attach-to-running, refcount deleted, E_INSPECTOR_STARTING, tookMs
  server/ws-handlers-inspect.test.ts CHANGED
  api/adb-stats.ts             CHANGED  pinned
  api/adb-stats.test.ts        CHANGED
  device/adb-scaling.ts        CHANGED  comment only
  daemon.ts                    CHANGED  resetInspectForDevice comment; nothing else
packages/core/README.md        CHANGED  two sentences
packages/toolchain/manifest/enkaku-tools.json  CHANGED (owner-gated, §4.12)
scripts/bench-device-nfrs.ts   CHANGED  --attach-cycles, onData pass-through, pinned
docs/spec-divergences.md       CHANGED  one DIV row (or the spec section, §5 step 208.12)
```

Fixture-only edits (a `streams` block gains `pinned: 0`): `packages/core/src/doctor/checks/streams.test.ts:13,25,36`, `packages/core/src/doctor/render.test.ts:92`, `packages/studio/src/app/settings/page.test.tsx:161`, `packages/studio/src/components/AdbServerCard.test.tsx:73` (only where the fixture is typed against `AdbStatsResponse`; a fixture that compiles without the field is left alone).

### 4.2 `packages/drivers/src/inspector/ui-server/lifecycle.ts`

```ts
import type { UiServerClient, ConfiguratorInfo } from './client'
import type { UiServerLauncher } from './launcher'
import { createWatchdog, type UiServerStatus, type Watchdog, type WatchdogOptions } from './watchdog'

/**
 * A line of `am instrument -w -r` output, classified. `fatal` ends the start
 * at once; `started` is informational (the ping still decides readiness);
 * `noise` is every other line.
 */
export type InstrumentationLineKind = 'fatal' | 'started' | 'noise'

/**
 * Definitive failures, matched against one trimmed line. Ordered from the
 * repo's own measurement (launcher.ts:12-17, the ClassNotFoundException at
 * ~1.3 s) to the raw-mode vocabulary of the platform (§9 Q3 confirms each
 * on the lab device; add a row, never a branch).
 */
export const INSTRUMENTATION_FATAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^INSTRUMENTATION_STATUS: stack=/, label: 'the instrumentation reported a stack trace' },
  { pattern: /ClassNotFoundException/, label: 'the stub class was not found' },
  { pattern: /^INSTRUMENTATION_STATUS: Error=/, label: 'the instrumentation reported an error' },
  { pattern: /^INSTRUMENTATION_RESULT: shortMsg=/, label: 'the instrumentation finished before the server was up' },
  { pattern: /Process crashed/, label: 'the instrumentation process crashed' },
  { pattern: /^INSTRUMENTATION_FAILED:/, label: 'am instrument could not start the runner' },
]

/** The runner announces the hosting test; readiness is still the ping. */
const STARTED_PATTERN = /^INSTRUMENTATION_STATUS_CODE: 1$/

export function classifyInstrumentationLine(line: string): { kind: InstrumentationLineKind; label?: string } {
  const trimmed = line.trim()
  for (const { pattern, label } of INSTRUMENTATION_FATAL_PATTERNS) {
    if (pattern.test(trimmed)) return { kind: 'fatal', label }
  }
  if (STARTED_PATTERN.test(trimmed)) return { kind: 'started' }
  return { kind: 'noise' }
}

/** Never let a stream that prints no newline grow the buffer without bound. */
export const INSTRUMENTATION_LINE_BUFFER_MAX = 64 * 1024

export interface InstrumentationParser {
  /** Feed raw bytes; complete lines are classified, the remainder is kept. */
  feed(chunk: Uint8Array): void
  /** Flush the remainder as a final line (on stream end). */
  end(): void
}

/**
 * Splits chunks into lines and reports the first fatal line ONCE; `onLine`
 * receives every complete line for debug logging. Pure apart from the two
 * callbacks, so the test feeds byte slices that split lines in the middle.
 */
export function createInstrumentationParser(hooks: {
  onFatal: (reason: string, line: string) => void
  onStarted?: () => void
  onLine?: (line: string) => void
}): InstrumentationParser

/** The budget for a server that prints nothing; a fatal line never waits for it. */
export const INSTRUMENTATION_START_SILENCE_MS = 15_000

export type UiServerLifecycleState = 'idle' | 'starting' | 'ready' | 'dead' | 'failed' | 'closed'

export interface UiServerLifecycleOptions {
  serial: string
  client: UiServerClient
  launcher: UiServerLauncher
  localPort: number
  /** Sent after every `healthy` (start and restart). Default `DEFAULT_CONFIGURATOR`. */
  configurator?: ConfiguratorInfo
  onStatus?: (s: UiServerStatus) => void
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
  /** Forwarded to `createWatchdog` (tests shrink the real delays). */
  watchdog?: Pick<WatchdogOptions, 'idlePingMs' | 'startTimeoutMs' | 'maxRestartsPerWindow' | 'restartWindowMs' | 'restartBackoffMs'>
}

export interface UiServerLifecycle {
  /** Idempotent: a second call joins the first. Rejects with the fatal reason, the silence ceiling, or the launcher's own error. */
  start(): Promise<void>
  /** Resolves once `ready` (joins a start in flight); rejects when `failed`/`dead`/`closed`. */
  whenReady(): Promise<void>
  state(): UiServerLifecycleState
  /** Milliseconds from `start()` to `ready`, or null. The `inspector ready:` log line reads it. */
  startedInMs(): number | null
  /** The engine is done for this session: watchdog stopped, launcher stopped. Idempotent. */
  close(): Promise<void>
  /** Runtime failure report, forwarded to the watchdog (`UiServerInspector.call()`). */
  reportFailure(reason: string): void
  isDead(): boolean
}

export function createUiServerLifecycle(opts: UiServerLifecycleOptions): UiServerLifecycle
```

Behaviour of `createUiServerLifecycle`:

1. The constructor builds the watchdog with `client`, `launcher`, `localPort`, the forwarded options, `onStatus` (wrapped: every status is also mirrored into `state()`: `starting → starting`, `healthy → ready`, `restarting → starting`, `dead → dead`), `onLog`, and `onReady: applyConfigurator`.
2. `applyConfigurator()`: `await client.setConfigurator(configurator)`; then `const effective = await client.getConfigurator()` and one `info` log line `ui-server configurator on ${serial}: ${JSON.stringify(effective)}`; any failure is logged at `warn` (`could not set the ui-server configurator on ${serial}: ...`) and is not fatal: a server with the default idle wait is slow, not broken.
3. `start()`: start-once through a stored promise. Sets `state = 'starting'`, `t0 = Date.now()`, awaits `watchdog.start()` (which runs the launcher with the fatal hook, §4.4), then `state = 'ready'`, `startedIn = Date.now() - t0`. On rejection `state = 'failed'` and the rejection propagates. `whenReady()` returns the same promise.
4. `close()`: `state = 'closed'`, `await watchdog.stop()` (which stops the launcher). A `start()` after `close()` rejects with `Error('the ui-server lifecycle is closed')`.
5. `reportFailure`, `isDead`: delegate.

The launcher is constructed by the factory as today; the lifecycle only receives it. The line parser is constructed inside `launcher.start()` (§4.3) because the launcher is what owns the stream; `lifecycle.ts` exports it so the launcher imports it (a type-only import in the other direction keeps the module graph acyclic).

The state machine of one start, for the executor to implement literally:

```
idle ──start()──▶ starting
starting ──launcher.start resolved──▶ polling (inside watchdog.waitReady)
polling ──fatal line | onEnd(reason ≠ 'stopped')──▶ failed(reason)      ≤ 250 ms after the line
polling ──ping pong──▶ configuring ──setConfigurator (ok or warned)──▶ ready
polling ──INSTRUMENTATION_START_SILENCE_MS elapsed──▶ failed('the server was not ready within the start timeout')
ready ──two ping failures | reportFailure | onEnd──▶ restarting ──(same as starting, backoff first)──▶ ready | dead
any ──close()──▶ closed
```

### 4.3 `launcher.ts`

```ts
export interface UiServerLauncherDeps {
  // ...unchanged fields...
  /**
   * The Plan 24 streaming lane. `onData` receives the instrumentation's own
   * output (INSTRUMENTATION_* lines); `start()` reads it for the fail-fast
   * verdict (lifecycle.ts). The caller binds this to `AdbClient.execStream`
   * with BOTH clocks off and `pinned: true` (§4.9).
   */
  execStream: (
    cmd: string,
    opts: { onData: (chunk: Uint8Array) => void; onEnd: (reason: AdbStreamEndReason, err?: unknown) => void },
  ) => Promise<{ stop: () => Promise<void> }>
}

export interface UiServerStartHooks {
  /** Called at most once per `start()`: a definitive failure line, or the stream ending during the start. */
  onFatal?: (reason: string) => void
  /** Called when the stream ends after `start()` resolved (any reason but `stopped`); the watchdog restarts sooner than its ping would. */
  onExit?: (reason: string) => void
}

export interface UiServerLauncher {
  ensureInstalled(): Promise<void>
  start(localPort: number, hooks?: UiServerStartHooks): Promise<void>
  stop(localPort: number): Promise<void>
  isInstalled(): Promise<boolean>
  reassertForward(localPort: number): Promise<void>
}
```

`start(localPort, hooks)`:

1. `await this.ensureInstalled()` (unchanged).
2. `let fatalReported = false; let started = false` (the local `started` flips when `start()` resolves; it decides whether an `onEnd` is `onFatal` or `onExit`).
3. `const parser = createInstrumentationParser({ onFatal: (reason, line) => { if (fatalReported) return; fatalReported = true; deps.onLog?.('warn', \`ui-server instrumentation on ${deps.serial} failed to start: ${reason} (${line})\`); hooks?.onFatal?.(\`${reason}: ${line}\`) }, onLine: (line) => deps.onLog?.('debug', \`instrumentation: ${line}\`) })`.
4. `instrumentation = await deps.execStream(cmd, { onData: (chunk) => parser.feed(chunk), onEnd: (reason, err) => { instrumentation = null; parser.end(); if (reason === 'stopped') return; const why = \`the instrumentation ended: ${reason}${err ? \` (${String(err)})\` : ''}\`; deps.onLog?.('warn', \`ui-server instrumentation (class ${UI_SERVER_STUB_CLASS}) ended unexpectedly on ${deps.serial}: ${reason}...\`); if (started) hooks?.onExit?.(why); else if (!fatalReported) { fatalReported = true; hooks?.onFatal?.(why) } } })`.
5. `await assertForward(localPort)` with the existing cleanup on failure (`:412-423`); then `started = true`.

The `cmd` string (`:396`) is unchanged. `stop()` (`:426-436`) is unchanged.

### 4.4 `watchdog.ts`

```ts
export const DEFAULT_START_TIMEOUT_MS = INSTRUMENTATION_START_SILENCE_MS   // imported from ./lifecycle; 15_000

export interface WatchdogOptions {
  // ...unchanged...
  /** Awaited after every successful `waitReady` (start and restart), BEFORE `healthy` is reported. Errors are the hook's to log; they never fail the start. */
  onReady?: () => Promise<void>
}
```

- `waitReady(verdict: { fatal: string | null })` returns `{ ok: true } | { ok: false; reason: string }`: each tick checks `verdict.fatal` first and returns `{ ok: false, reason: verdict.fatal }`; on `pong` returns `{ ok: true }`; on the deadline returns `{ ok: false, reason: 'the server was not ready within the start timeout' }`.
- `start()`: `const verdict = { fatal: null as string | null }`; `await opts.launcher.start(opts.localPort, { onFatal: (r) => { verdict.fatal = r }, onExit: (r) => reportFailureFromExit(r) })`; `const ready = await waitReady(verdict)`; if `!ready.ok`: `dead = true; healthy = false; setStatus({ state: 'dead', reason: ready.reason }); throw new Error(\`ui-server did not start: ${ready.reason}\`)`; else `await opts.onReady?.().catch(() => undefined)`; `healthy = true; setStatus({ state: 'healthy' })`; the ping timer as today (`:189-202`).
- `restart(reason)`: the same `verdict`/hooks shape around `opts.launcher.start(...)` at `:146`, `waitReady(verdict)` at `:147`, and `await opts.onReady?.()` before `setStatus({ state: 'healthy' })` at `:150`.
- `reportFailureFromExit(reason)`: `if (dead || restarting || !healthy) return; void restart(reason)` (the same guard `reportFailure` has at `:212`).

The error message on the start path changes from `ui-server was not ready within the start timeout` (`:180`) to `ui-server did not start: <reason>`, where `<reason>` is the fatal line's label and text, or the silence sentence. Plan 129's test at `ws-handlers-inspect.test.ts:290` (`the inspector failing to start reports unavailable with the failure reason`) keeps passing because it asserts the reason is forwarded, not its text.

### 4.5 `client.ts`

```ts
/**
 * The openatx `ConfiguratorInfo` (R5): the JSON-RPC mirror of UiAutomator's
 * `Configurator`. Field names are verified against the pinned tag's source
 * in §5 step 208.4 before this ships; `uiAutomationFlags` exists from 2.3.11
 * only and is not sent on 2.3.3 (§9 Q4).
 */
export const ConfiguratorInfoSchema = z.object({
  waitForIdleTimeout: z.number().int().min(0),
  waitForSelectorTimeout: z.number().int().min(0),
  actionAcknowledgmentTimeout: z.number().int().min(0),
  scrollAcknowledgmentTimeout: z.number().int().min(0),
  keyInjectionDelay: z.number().int().min(0),
  uiAutomationFlags: z.number().int().min(0).optional(),
})
export type ConfiguratorInfo = z.infer<typeof ConfiguratorInfoSchema>

/** MVP 02 §4 phase 1: the caller polls; the server must never wait for idle on its behalf. */
export const DEFAULT_CONFIGURATOR: ConfiguratorInfo = {
  waitForIdleTimeout: 0,
  waitForSelectorTimeout: 0,
  actionAcknowledgmentTimeout: 0,
  scrollAcknowledgmentTimeout: 0,
  keyInjectionDelay: 0,
}

export class UiServerClient {
  // ...unchanged...
  /** Positional, as every other method on this surface: `params: [info]`. */
  setConfigurator(info: ConfiguratorInfo): Promise<void> {
    return this.rpc<void>('setConfigurator', [ConfiguratorInfoSchema.parse(info)])
  }
  /** Read back for the one `info` log line after every apply; the shape is the server's, validated loosely. */
  async getConfigurator(): Promise<Record<string, unknown>> {
    const raw = await this.rpc<unknown>('getConfigurator', [])
    return z.record(z.string(), z.unknown()).parse(raw)
  }
}
```

`PING_TIMEOUT_MS`, `RPC_TIMEOUT_MS`, `DUMP_WINDOW_HIERARCHY_TIMEOUT_MS`, `SCREENSHOT_TIMEOUT_MS`, `fetchWithTimeout` and `request` are untouched. The `TODO-verify` at `:9` is rewritten to name §5 step 208.4 as the verification that was done, with the tag and date.

### 4.6 `index.ts` (`UiServerInspector`)

- The constructor builds `this.lifecycle = createUiServerLifecycle({ serial, client, launcher, localPort, onStatus, onLog, ...(opts.configurator ? { configurator: opts.configurator } : {}), ...(opts.watchdog ? { watchdog: opts.watchdog } : {}) })` instead of `createWatchdog` (`:70-76`). `UiServerInspectorOptions` gains `configurator?: ConfiguratorInfo` and `watchdog?: UiServerLifecycleOptions['watchdog']`.
- `start()` → `this.lifecycle.start()`; `stop()` → `this.lifecycle.close()`; `isDead()` → `this.lifecycle.isDead()`; `call()`'s `this.watchdog.reportFailure(...)` (`:97`) → `this.lifecycle.reportFailure(...)`.
- `startedInMs(): number | null` → `this.lifecycle.startedInMs()` (the factory logs it; the session logs it again with the whole prewarm cost).
- `private last: { root: UiNode; at: number } | null = null`; `dump()` stores `this.last = { root, at: Date.now() }` on both success paths (`:105`, `:120`); `lastDump()` returns it.
- Exports at `:239-254` gain `createUiServerLifecycle`, `classifyInstrumentationLine`, `createInstrumentationParser`, `INSTRUMENTATION_FATAL_PATTERNS`, `INSTRUMENTATION_START_SILENCE_MS`, `ConfiguratorInfoSchema`, `DEFAULT_CONFIGURATOR`, and the types `ConfiguratorInfo`, `UiServerLifecycle`, `UiServerLifecycleOptions`, `UiServerLifecycleState`, `UiServerStartHooks`; `packages/drivers/src/index.ts:11-32` re-exports the same.

`UiautomatorDumpInspector.dump()` (`uiautomator-dump.ts:53-76`) stores `this.last` before `return parseUiDump(raw)` at `:70` and gains the same `lastDump()`.

### 4.7 `packages/protocol/src/driver.ts`

```ts
export interface Inspector {
  id: string
  dump(): Promise<UiNode>
  find(sel: Selector): Promise<UiNode | null>
  screenshot(): Promise<Uint8Array>
  findDetailed?(sel: Selector): Promise<FindOutcome>
  /**
   * The last tree `dump()` returned and when (unix ms), or null. MVP 02 §4
   * phase 1 "cheap cache": the failing-action trace capture reuses it while
   * it is fresh (`TRACE_TREE_REUSE_MS`) instead of a second round trip on
   * the channel the script's own calls share. Optional, like `findDetailed`.
   */
  lastDump?(): { root: UiNode; at: number } | null
}
```

### 4.8 `session.ts`

```ts
export interface DeviceSession {
  // ...
  inspector: Inspector | null
  /**
   * Starts the inspector if nothing has yet and resolves once it is ready or
   * has fallen back. Start-once; every caller joins. Never rejects.
   */
  whenInspectorReady(): Promise<void>
  /**
   * The same start, invoked by the always-on builder INSPECTOR_PREWARM_DELAY_MS
   * after the first frame (plan 206 §3.9). Identical to `whenInspectorReady`
   * on purpose: there is one engine per session and one way to start it.
   */
  prewarmInspector(): Promise<void>
  inspectorEngineId: string        // 'starting' until the start settles, then the engine id
  inspectorPollIntervalMs: number
  // `releaseInspector` is gone: `close()` is the only release (plan 208 §3.2).
}
```

`createSession`:

- The comment at `:473-492` is replaced by one that says: started by `prewarmInspector()` after the first frame (plan 206) or by the first `whenInspectorReady()`, whichever comes first; the two measurements at `:477-482` are kept verbatim as the reason the start is not before the first frame.
- `startInspector` (`:495-509`) gains timing: `const t0 = Date.now()` before `deps.makeInspector(...)`, and in `.then`: `log.info(\`inspector ready: ${h.engineId} on ${opts.deviceId} in ${Date.now() - t0} ms\`)`. The `.catch` wording at `:506` becomes `inspector could not start: ${String(err)}` (no "ad-hoc dump" promise; there is none any more).
- `releaseInspector` (`:510-517`) and its field (`:857`) are deleted. `prewarmInspector: startInspector` replaces plan 206's no-op. `close()` keeps `await inspectorHandle?.release()` (`:931`).

If plan 206 has not landed when this plan executes, `prewarmInspector` is added to the interface by this plan with the doc comment above, and §9 Q5 records that the builder call is still missing.

### 4.9 Lane: `packages/adb/src/client.ts`

```ts
export interface AdbStreamOptions {
  // ...unchanged...
  /**
   * A session-lifetime stream that takes NO lane slot (plan 208 §3.6): it is
   * counted in `pinned` for the stats and gates nothing. Only for a stream
   * whose lifetime is bounded by something else (a session); a bursty user
   * (logcat, transfer, install) never sets it.
   */
  pinned?: boolean
}

export class StreamLane {
  private pinnedCount = 0
  acquire(serial: string, opts?: { pinned?: boolean }): () => void {
    if (opts?.pinned) {
      this.pinnedCount++
      let released = false
      return () => { if (released) return; released = true; this.pinnedCount-- }
    }
    // ...the existing counted path, unchanged...
  }
  stats(): { maxStreams: number; maxStreamsPerDevice: number; streams: number; pinned: number; perDevice: Record<string, number> }
}
```

`execStream` (`:569`): `const releaseLane = this.streamLane.acquire(serial, { pinned: opts.pinned === true })`. `streamStats()` (`:343`) passes `pinned` through. `packages/protocol/src/api/adb.ts:64-69` gains `pinned: z.number()` inside `streams`; `adb-stats.ts:150`'s default object gains `pinned: 0` and `:189-193` adds `pinned: streamStats.pinned`.

`inspector-factory.ts:102-108` becomes:

```ts
execStream: (cmd, streamOpts) =>
  deps.execStream(opts.transport.serial, cmd, {
    onData: streamOpts.onData,
    onEnd: (reason, err) => streamOpts.onEnd(reason, err),
    idleTimeoutMs: 0,
    absoluteTimeoutMs: 0,
    pinned: true,
  }),
```

`adb-scaling.ts:20-27` comment: "Derived from what a device holds at steady state on the counted lane: the crash feed (one slot for the life of the session) plus one and a half slots of headroom for the bursty users (a Monitor tab, a file transfer, an APK install). The ui-server instrumentation is pinned since plan 208 and holds no slot." `packages/adb/README.md:51-66` and `packages/core/README.md:240,251` say the same in one sentence each.

### 4.10 Executor and capability path

`packages/session/src/device-executor.ts`:

```ts
import { /* no UiautomatorDumpInspector */ } from '@enkaku/drivers'

/** The methods that need the session's inspector; `deviceCall` awaits `whenInspectorReady()` for exactly these. */
export const INSPECTOR_METHODS: ReadonlySet<string> = new Set(['find', 'dump', 'waitFor', 'screenshot'])
export function needsInspector(call: DeviceCall): boolean {
  return INSPECTOR_METHODS.has(call.method)
}

// inside createDeviceExecutor, replacing :163-165:
/**
 * Read per call, never captured: the session's inspector is null until the
 * prewarm settles (session.ts). A null is an error, never a substitute
 * engine: the ad-hoc `uiautomator dump` took the instrumentation lock and
 * killed the healthy ui-server in the other session (MVP 02 §2.5).
 */
const inspectorOrThrow = (): Inspector => {
  const i = deps.session.inspector
  if (i) return i
  throw new SessionError(
    'E_INSPECTOR_STARTING',
    `the inspector on ${deps.session.deviceId} is still starting (engine: ${deps.session.inspectorEngineId}); retry in a moment`,
  )
}
```

`findOutcome` and the `find`, `dump`, `screenshot` cases call `inspectorOrThrow()`; the `waitFor` case calls it once before the loop (`:482`) so the loop's `.catch` at `:483` never swallows the starting error into `not-found`. `supportsElementActions` callers (`setText`, `longClick`, `doubleClick`) use the same accessor.

`packages/session/src/errors.ts:4-29`: add `| 'E_INSPECTOR_STARTING'` with the comment "plan 208 §3.8: the caller reached the inspector before the session's engine existed; retry, the prewarm is in flight. Distinct from `UI_SERVER_UNREACHABLE` (a running engine that stopped answering)".

`packages/session/src/runner/job-runner.ts:1142`: `const insp = session.inspector; if (!insp) throw new SessionError('E_INSPECTOR_STARTING', ...)` then `await insp.screenshot()`; the `UiautomatorDumpInspector` import at `:2` is deleted.

`packages/core/src/capability/context.ts:497-515`:

```ts
async deviceCall(deviceId, call, quality = 'control') {
  const sessions = deps.sessions()
  if (!sessions) throw new EnkakuError('E_DEVICE_OFFLINE', '...')
  const onFrame = () => {}
  const session = await sessions.acquire(deviceId, onFrame)          // plan 206's two-argument form; keep the third argument only if 206 has not landed
  try {
    // MVP 02 §2.5: an agent, REST or MCP read uses the session's engine, the
    // same one a script uses; it never lands on an ad-hoc dump.
    if (needsInspector(call)) await session.whenInspectorReady()
    const execute = createDeviceExecutor({ ... })
    return await execute(call)
  } finally {
    sessions.release(deviceId, onFrame)
  }
}
```

`needsInspector` is exported from `@enkaku/session` (`index.ts:19`).

### 4.11 `ws-handlers.ts`

Deleted: `inspectorRefCounts` (`:621`), `detachInspector` (`:623-635`), the count block inside `inspect.attach` (`:2240-2251`). `ConnState.inspectAttached` (`:238`) stays: it makes the `inspect.attached`/`inspect.detached` events idempotent per connection.

```
inspect.attach:
  1. send inspect.status { state: 'starting', engineId: session.inspectorEngineId, capabilities: [] }   (unchanged, :2199-2202)
  2. t0 = Date.now(); await withDeadline(session.whenInspectorReady(), INSPECT_ATTACH_DEADLINE_MS, 'E_INSPECT_TIMEOUT', ...)   (unchanged, :2204-2209)
     on error: inspect.status unavailable with the reason (unchanged, :2211-2222)
  3. engineId / capabilities / no-dump check (unchanged, :2224-2239)
  4. if (!state.inspectAttached.has(deviceId)) {
       state.inspectAttached.add(deviceId)
       deps.recorder.record({ deviceId, stream: 'main', kind: 'inspect.attached', actor: state.userId, meta: { engineId, tookMs: Date.now() - t0 } })
     }
  5. send inspect.status { state: 'ready', engineId, capabilities }   (unchanged, :2252-2256)

inspect.dump / inspect.find, the guard at :2260-2264:
  const inspector = session.inspector
  if (!inspector) {
    if (session.inspectorEngineId === 'starting') sendError(ws, 'E_INSPECTOR_STARTING', 'the inspector is still starting; retry in a moment', msgId)
    else sendError(ws, 'E_INSPECT_UNAVAILABLE', `the ${session.inspectorEngineId} engine is not available on this session`, msgId)
    return
  }

inspect.detach (:2319-2322) and handleClose (:2627-2629):
  noteInspectDetached(deviceId, state):
    if (!state.inspectAttached.delete(deviceId)) return
    deps.recorder.record({ deviceId, stream: 'main', kind: 'inspect.detached', actor: state.userId })
  (synchronous; nothing is awaited, nothing touches the session)

resetInspectForDevice (:2688-2691): only `for (const s of conns.values()) s.inspectAttached.delete(deviceId)`; the comment says the session's close() released the engine.
```

`INSPECT_ATTACH_DEADLINE_MS` (`:97`) stays 45 s: a first-ever start still installs two APKs over USB before the instrumentation runs; the comment is rewritten to say the deadline is a ceiling for that case and that a healthy prewarmed attach answers in milliseconds. `INSPECT_DEADLINE_MS` (`:76`) stays.

Protocol doc comments: `inspect.ts:21` becomes "Attach to the session's inspector (started by the session itself; plan 208 §3.2). The reply carries the engine and its capabilities; a tab is a viewer, never an owner."; `:28` becomes "This viewer left; recorded on the device's main stream, nothing is released (the engine lives with the session)."; `device-event.ts:43-46` say the same. The comment block at `ws-handlers.ts:1920-1930` that names `inspectorRefCounts` is reworded to "whatever inspector the session already has (`session.inspector`, started by the session itself)". `daemon.ts:4331-4333`'s comment ("stale Inspect tab ref count") becomes "stale Inspect tab bookkeeping".

### 4.12 The manifest pin (owner-gated, §5 step 208.11)

If 2.4.0 starts on the lab device, both entries of `packages/toolchain/manifest/enkaku-tools.json:86-129` are replaced by:

```json
{
  "version": "2.4.0",
  "releasedAt": "<the release's date on the GitHub releases page, ISO 8601>",
  "compatibleCoreRange": ">=<packages/core/package.json version at execution>",
  "deviceArtifact": { "packageName": "com.github.uiautomator", "versionCode": <from aapt or apkanalyzer> },
  "platforms": { "*": { "url": "https://github.com/openatx/android-uiautomator-server/releases/download/2.4.0/app-uiautomator.apk", "sha256": "<shasum -a 256>", "sizeBytes": <wc -c> } }
}
```

and the test entry likewise (no `deviceArtifact`, its own sha256 and size). `ToolVersionSchema` (`packages/toolchain/src/types.ts:43-51`) needs no change. `resolveLockedVersion` (`manifest.ts:88-98`) starts matching once the range is real, which is the intended effect; `bun test packages/toolchain/src/` is the scoped check. If the release's asset names differ from 2.3.3's, the `url` values follow the release page and the executor says so in §11.

### 4.13 `scripts/bench-device-nfrs.ts`

- `--attach-cycles <N>` (default 3): before each cycle `await exec(\`am force-stop ${UI_SERVER_PACKAGE}\`)` and `await exec(\`am force-stop ${UI_SERVER_TEST_PACKAGE}\`)`, then time `inspector.start()`, then `inspector.stop()`. Rows `ui-server attach cold p50` and `ui-server attach cold max` replace the single `ui-server attach` row at `:251`. The existing dump/find measurements run after the last cycle on a started inspector.
- The launcher's `execStream` at `:225-231` passes `onData: streamOpts.onData` and `pinned: true` (the bench uses a bare `AdbClient`, so pinning only keeps the stats honest).
- `usage()` lists `--attach-cycles`.

## 5. Implementation steps

### 208.1 Line parser and fatal patterns (`lifecycle.ts`, pure part)

- Files created: `packages/drivers/src/inspector/ui-server/lifecycle.ts` (the parser, patterns, constants and types of §4.2; `createUiServerLifecycle` may be a stub that throws until 208.5), `packages/drivers/src/inspector/ui-server/lifecycle.test.ts`
- Files changed: none
- Test file: `lifecycle.test.ts`: a table test over `classifyInstrumentationLine` (each pattern in `INSTRUMENTATION_FATAL_PATTERNS` classifies `fatal`; `INSTRUMENTATION_STATUS_CODE: 1` classifies `started`; `INSTRUMENTATION_STATUS: class=com.github.uiautomator.stub.Stub`, `INSTRUMENTATION_STATUS: numtests=1`, an empty line classify `noise`); the parser reports the first fatal line once when the bytes arrive split mid-line across three chunks; `end()` flushes a final unterminated line; a 70 KB chunk without a newline does not grow the buffer past `INSTRUMENTATION_LINE_BUFFER_MAX`
- Verifiable result: `bun test packages/drivers/src/inspector/ui-server/lifecycle.test.ts` green
- Do not: match `INSTRUMENTATION_STATUS_CODE: 1` as readiness anywhere; the ping decides. Do not put the patterns in `launcher.ts`; the launcher imports them.

### 208.2 Launcher: `onData`, start hooks, exit hook

- Files changed: `packages/drivers/src/inspector/ui-server/launcher.ts` (§4.3), `packages/drivers/src/inspector/ui-server/launcher.test.ts` (the `fakeDeps` `execStream` fake gains a way to push bytes and to end the stream)
- Test file: `launcher.test.ts`: `a fatal line delivered through onData calls hooks.onFatal once with the label and the line`; `the stream ending with reason closed before assertForward calls onFatal, not onExit`; `the stream ending after start() resolved calls onExit`; `a second fatal line is not reported twice`; the existing start/stop tests keep passing with the two-field `execStream` shape
- Verifiable result: `bun test packages/drivers/src/inspector/ui-server/launcher.test.ts` green
- Do not: make `start()` wait for a `started` line; it resolves after the forward as today, and the watchdog's poll is where the verdict is consumed.

### 208.3 Watchdog: verdict-aware `waitReady`, `onReady`

- Files changed: `packages/drivers/src/inspector/ui-server/watchdog.ts` (§4.4), `packages/drivers/src/inspector/ui-server/watchdog.test.ts` (the `fakeLauncher` gains a `start` that can invoke the hooks it receives)
- Test file: `watchdog.test.ts`: `a fatal verdict 300 ms after start rejects in under 2 s with startTimeoutMs left at 15 s` (real timers: the test measures elapsed ≤ 2000 ms); `silence alone waits for startTimeoutMs` (shrunk to 50 ms); `onReady is awaited before healthy on start and on every restart` (a counter, two cycles with millisecond backoff); `onExit from the launcher triggers a restart without waiting for two pings`
- Verifiable result: `bun test packages/drivers/src/inspector/ui-server/watchdog.test.ts` green
- Do not: spend a breaker cycle on the start path (plan 129 §4.1 stands); do not reset `dead`.

### 208.4 Client: verify the configurator surface, then add it

First, the verification (record the answers in §11 "Discrepancies" if any differ from §4.5):

```bash
cd "$SCRATCH"   # the session scratchpad, never the repo
curl -fL -o uiautomator-server-2.3.3.tar.gz https://github.com/openatx/android-uiautomator-server/archive/refs/tags/2.3.3.tar.gz
tar xzf uiautomator-server-2.3.3.tar.gz
rg -n "setConfigurator|getConfigurator|class ConfiguratorInfo" android-uiautomator-server-2.3.3/app/src
# expected: a `ConfiguratorInfo` class (path to confirm; look under app/src/androidTest/java/com/github/uiautomator/stub/) and
# `setConfigurator(ConfiguratorInfo ...)` / `getConfigurator()` on the AutomatorService interface and AutomatorServiceImpl
rg -n "waitForIdleTimeout|waitForSelectorTimeout|actionAcknowledgmentTimeout|scrollAcknowledgmentTimeout|keyInjectionDelay|uiAutomationFlags" android-uiautomator-server-2.3.3/app/src
# expected: the five fields on ConfiguratorInfo (uiAutomationFlags absent on 2.3.3 per R5)
```

If the method name or a field name differs, the schema and `DEFAULT_CONFIGURATOR` use the source's names and §11 records the difference; the plan's intent (all four waits at 0) is unchanged.

- Files changed: `packages/drivers/src/inspector/ui-server/client.ts` (§4.5; the `:9` comment), `packages/drivers/src/inspector/ui-server/client.test.ts`
- Test file: `client.test.ts` (against the same local `Bun.serve` echo server the file already uses, extended to capture the last `/jsonrpc/0` body): `setConfigurator posts the ConfiguratorInfo as the single positional param` (asserts `method: 'setConfigurator'` and `params[0]` deep-equals `DEFAULT_CONFIGURATOR`); `getConfigurator returns the server's object`; `setConfigurator rejects a negative timeout before any request is sent`
- Verifiable result: `bun test packages/drivers/src/inspector/ui-server/client.test.ts` green
- Do not: mock `fetch` (the file's own header says why); do not send `uiAutomationFlags`.

### 208.5 `createUiServerLifecycle` and `UiServerInspector` on top of it

- Files changed: `packages/drivers/src/inspector/ui-server/lifecycle.ts` (the lifecycle of §4.2), `lifecycle.test.ts`, `packages/drivers/src/inspector/ui-server/index.ts` (§4.6), `packages/drivers/src/inspector/uiautomator-dump.ts` (`lastDump`), `packages/protocol/src/driver.ts` (§4.7), `packages/drivers/src/index.ts` (exports)
- Test file: `lifecycle.test.ts` (fake client whose `ping` answers on demand and records `setConfigurator`/`getConfigurator` calls; fake launcher that invokes the hooks; millisecond backoff): `a fatal line 300 ms into the stream rejects start() in under 2 s`; `silence pays the ceiling and nothing less` (ceiling shrunk to 50 ms); `the configurator is applied after start and after every restart`; `a configurator failure is logged and the engine is still ready`; `state() walks idle, starting, ready, closed`; `start() after close() rejects`; `startedInMs is set on ready`. `packages/drivers/src/inspector/ui-server/dump-retry.test.ts` (existing) gains `dump() records lastDump on success`; `packages/drivers/src/inspector/uiautomator-dump.test.ts` gains the same
- Verifiable result: `bun test packages/drivers/src/inspector/` green (the directory, one invocation)
- Do not: give the lifecycle its own ping loop; the watchdog owns runtime. Do not make `lastDump` return a tree from a failed dump.

### 208.6 Lane: pinned streams

- Files changed: `packages/adb/src/client.ts` (§4.9), `packages/adb/src/client.test.ts`, `packages/protocol/src/api/adb.ts:64-69`, `packages/core/src/api/adb-stats.ts:150,189-193`, `packages/core/src/api/adb-stats.test.ts`, `packages/core/src/device/adb-scaling.ts:20-27` (comment), `packages/adb/README.md:51-66`, `packages/core/README.md:240,251`, the fixture files of §4.1
- Test file: `packages/adb/src/client.test.ts` (beside the two `E_ADB_STREAM_LIMIT` tests at `:794` and `:832`): `a pinned stream takes neither a per-device nor a farm-wide slot` (per-device cap 1, farm cap 1: a pinned acquire then a counted acquire both succeed; `stats().pinned === 1`; releasing the pinned one decrements `pinned` only); `packages/core/src/api/adb-stats.test.ts`: the `streams` block carries `pinned`
- Verifiable result: `bun test packages/adb/src/client.test.ts` green; `bun test packages/core/src/api/adb-stats.test.ts` green; `bun test packages/core/src/doctor/` green
- Do not: change `computeAutoStreams`'s numbers; do not let `pinned` count toward `maxStreamsPerDevice`.

### 208.7 Session: session-scoped start, `E_INSPECTOR_STARTING`, factory wiring

- Files changed: `packages/session/src/session.ts` (§4.8), `packages/session/src/session.test.ts` (the `releaseInspector` describe at `:35-85` is replaced), `packages/session/src/errors.ts`, `packages/session/src/inspector-factory.ts` (§4.9's stream options; log `ui-server ready on ${deviceId} in ${inspector.startedInMs()} ms` at `debug` after `:129`), `packages/session/src/inspector-factory.test.ts`, `packages/session/src/index.ts`
- Test file: `session.test.ts`: `prewarmInspector starts the engine once and whenInspectorReady joins it` (one `makeInspector` call for `prewarmInspector()` then `whenInspectorReady()` twice); `close releases the inspector handle exactly once`; `a failed makeInspector leaves inspector null and inspectorEngineId starting, and resolves`; `inspector-factory.test.ts`: `the instrumentation stream is pinned with both clocks off` (the fake `execStream` records `opts.pinned === true`, `idleTimeoutMs === 0`, `absoluteTimeoutMs === 0`, and `typeof opts.onData === 'function'`; reachable because the test's launcher passes `ensureInstalled`, i.e. the fake `dumpsys` matches the expectation and `pm list` shows both packages, and `start()` then rejects on a fatal line pushed through `onData`, which is how the fallback is reached without a TCP server)
- Verifiable result: `bun test packages/session/src/session.test.ts packages/session/src/inspector-factory.test.ts` green; `rg -n "releaseInspector" packages` → empty
- Do not: keep `releaseInspector` as an empty method; do not start the inspector inside `createSession` before the first frame (the measurements at `session.ts:477-482`).

### 208.8 Executor and capability path

- Files changed: `packages/session/src/device-executor.ts` (§4.10), `packages/session/src/device-executor.test.ts`, `packages/session/src/runner/job-runner.ts:2,1142` and the comment at `:1378-1380` (`// than the slower ad-hoc dump fallback.` becomes "than an engine that is still starting"), `packages/core/src/capability/context.ts:497-515`, `packages/core/src/capability/context.test.ts` (`fakeSession` at `:77-97` gains `whenInspectorReady: async () => {}` and `inspectorEngineId: 'ui-server'`; a new fixture variant whose `whenInspectorReady` sets `inspector` on first call), `packages/session/src/index.ts` (export `needsInspector`, `INSPECTOR_METHODS`)
- Test file: `device-executor.test.ts`: `find, dump, waitFor, screenshot throw E_INSPECTOR_STARTING while the session has no inspector` (`inspector: null`, `inspectorEngineId: 'starting'`; each rejects with `code === 'E_INSPECTOR_STARTING'`); `tap does not need the inspector` (the existing `inspector: null` fixtures at `:27-33` and `:137-141` keep passing unchanged); `needsInspector is true for exactly the four methods`. `context.test.ts`: `deviceCall awaits whenInspectorReady for find and never builds a dump engine` (fixture: `inspector: null`, `whenInspectorReady` sets a fake inspector and counts; `device.find` answers through that inspector; `transport.exec` is asserted never to receive `uiautomator dump`); `deviceCall does not await whenInspectorReady for tap` (the counter stays 0)
- Verifiable result: `bun test packages/session/src/device-executor.test.ts` green; `bun test packages/core/src/capability/context.test.ts` green; `rg -n "new UiautomatorDumpInspector\(" packages --glob '!**/*.test.ts'` → one line, `packages/session/src/inspector-factory.ts`
- Do not: await `whenInspectorReady()` for every method; do not add a "use the dump engine if starting takes too long" branch.

### 208.9 Trace: the cheap cache

- Files changed: `packages/session/src/runner/trace.ts` (`export const TRACE_TREE_REUSE_MS = 2_000`; `export function reusableTree(cached: { root: UiNode; at: number } | null | undefined, now: number): UiNode | null`), `packages/session/src/runner/job-runner.ts:1287-1288` (`uiHash = await store.putUiTree(job.id, reusableTree(inspector.lastDump?.(), Date.now()) ?? (await inspector.dump()))`), `packages/session/src/runner/trace.test.ts`, `packages/session/src/index.ts` (export both)
- Test file: `trace.test.ts`: `reusableTree returns the cached root within 2 s and null after` (at `now - 1999` returns the root; at `now - 2001` returns null; `null`/`undefined` return null)
- Verifiable result: `bun test packages/session/src/runner/trace.test.ts` green
- Do not: change `resolveFramePolicy` (`trace.ts:235-239`) or `MAX_CONCURRENT_CAPTURES`; do not cache `find` results.

### 208.10 WS: attach-to-running, refcount deleted, `E_INSPECTOR_STARTING`

- Files changed: `packages/core/src/server/ws-handlers.ts` (§4.11), `packages/core/src/server/ws-handlers-inspect.test.ts` (the `fakeSession` at `:63-110` loses `releaseInspector` and `calls.released`; the describe at `:306-387` is rewritten), `packages/protocol/src/messages/inspect.ts:21-32` and `packages/protocol/src/messages/device-event.ts:43-46` (comments), `packages/core/src/daemon.ts:4331-4333` (comment)
- Test file: `ws-handlers-inspect.test.ts`, the rewritten describe `inspect.attach attaches to the session's engine (plan 208 §3.2)`: `attach records inspect.attached once per connection with engineId and tookMs`; `inspect.detach records the event and never touches the session` (the fake session has no `releaseInspector`; `session.inspector` is still set afterwards); `closing the WS records inspect.detached and never touches the session`; `a second attach from the same connection records nothing new`; `a dump while the engine is still starting answers E_INSPECTOR_STARTING, not unavailable` (fixture `inspectorEngineId: 'starting'`, `inspector: null`, `whenInspectorReady` never called before the dump); the existing test at `:455` (`a dump attempted without attaching first is refused`) keeps its refusal with the code chosen by `inspectorEngineId` (set the fixture's engine to `'ui-server'` and `noDump: true` to keep `E_INSPECT_UNAVAILABLE`)
- Verifiable result: `bun test packages/core/src/server/ws-handlers-inspect.test.ts` green; `rg -n "inspectorRefCounts|detachInspector" packages/core/src` → empty
- Do not: delete `inspect.detach` from the protocol (Studio sends it, `InspectorPanel.tsx:495`); do not lower `INSPECT_ATTACH_DEADLINE_MS`.

### 208.11 ui-server 2.4.0 on the lab device (owner, `ENKAKU_TEST_DEVICE=1`)

Everything below runs by hand against the lab device (Android 16, API 36). Nothing is committed before the last command answers.

```bash
export SERIAL=<lab device serial>; export ADB="$(bun -e 'console.log(process.env.ENKAKU_DATA_DIR ?? ".dev-data")')/tools/adb/current/adb"   # or the path `bun run doctor` prints; never the system adb
cd "$SCRATCH"
curl -fL -o app-uiautomator-2.4.0.apk https://github.com/openatx/android-uiautomator-server/releases/download/2.4.0/app-uiautomator.apk
curl -fL -o app-uiautomator-test-2.4.0.apk https://github.com/openatx/android-uiautomator-server/releases/download/2.4.0/app-uiautomator-test.apk
shasum -a 256 app-uiautomator-2.4.0.apk app-uiautomator-test-2.4.0.apk        # the two sha256 values for the manifest
wc -c app-uiautomator-2.4.0.apk app-uiautomator-test-2.4.0.apk               # sizeBytes
aapt dump badging app-uiautomator-2.4.0.apk | grep -o "versionCode='[0-9]*'"  # versionCode (Android SDK build-tools)
apkanalyzer manifest version-code app-uiautomator-2.4.0.apk                   # the same number, cmdline-tools; either command suffices
# the stub class on 2.4.0 (UI_SERVER_STUB_CLASS is com.github.uiautomator.stub.Stub on 2.3.3):
curl -fL -o uiautomator-server-2.4.0.tar.gz https://github.com/openatx/android-uiautomator-server/archive/refs/tags/2.4.0.tar.gz && tar xzf uiautomator-server-2.4.0.tar.gz
find android-uiautomator-server-2.4.0 -name Stub.java      # expected under app/src/androidTest/java/com/github/uiautomator/stub/; if it moved, the class name in launcher.ts:20 moves with it
"$ADB" -s "$SERIAL" shell am force-stop com.github.uiautomator; "$ADB" -s "$SERIAL" shell am force-stop com.github.uiautomator.test
"$ADB" -s "$SERIAL" uninstall com.github.uiautomator.test; "$ADB" -s "$SERIAL" uninstall com.github.uiautomator
"$ADB" -s "$SERIAL" install -r -g app-uiautomator-2.4.0.apk && "$ADB" -s "$SERIAL" install -r -g app-uiautomator-test-2.4.0.apk
"$ADB" -s "$SERIAL" shell pm list packages com.github.uiautomator            # both package lines
"$ADB" -s "$SERIAL" shell am instrument -w -r -e debug false -e class com.github.uiautomator.stub.Stub com.github.uiautomator.test/androidx.test.runner.AndroidJUnitRunner &
sleep 3; "$ADB" -s "$SERIAL" forward tcp:27510 tcp:9008; curl -s --max-time 2 http://127.0.0.1:27510/ping   # expected: pong
# copy every INSTRUMENTATION_* line the command above printed into §11 (this is what §9 Q3 needs)
kill %1; "$ADB" -s "$SERIAL" forward --remove tcp:27510
```

Then, with the manifest still at 2.3.3, run the bench against the 2.4.0 APKs the device now carries (the launcher verifies `versionCode` only when the manifest carries an expectation; the bench passes none): `ENKAKU_TEST_DEVICE=1 bun run scripts/bench-device-nfrs.ts --serial "$SERIAL" --skip-video --attach-cycles 3`. Record the rows in §11.

- If `pong` answered and the bench's `find() p95` is under 200 ms: edit the manifest per §4.12 (both entries), `bun test packages/toolchain/src/`, then boot a fresh data dir (`ENKAKU_DATA_DIR=$SCRATCH/dd bun run dev`) and confirm the first-run download verifies (`ui-server` and `ui-server-test` reach `ready` in the log). Update `launcher.test.ts:17`'s `versionCode` fixture only if it asserts the manifest's number (it asserts its own 2003003 and is left alone). Delete the `TODO-M4.5` strings.
- If it did not: leave the manifest untouched, put the observed lines and the failure in §9 Q1's answer and in §11, and keep 2.3.3. Plan 129 step 129.4 is closed either way: the answer is measured, not suspected.
- Files changed: `packages/toolchain/manifest/enkaku-tools.json` (conditional), `packages/drivers/src/inspector/ui-server/launcher.ts:12-20` (comment and `UI_SERVER_STUB_CLASS`, only if the class moved)
- Test file: `packages/toolchain/src/` (the directory), `packages/drivers/src/inspector/ui-server/launcher.test.ts`
- Verifiable result: G9's grep or §11's record
- Do not: compute the sha256 from anything but the file you downloaded; do not copy a hash from a release page; do not install the 2.4.0 APKs on the production farm.

### 208.12 Bench, docs, divergence row, status

- Files changed: `scripts/bench-device-nfrs.ts` (§4.13), `packages/drivers/src/inspector/ui-server/README.md` (the Shape table gains a `Lifecycle | lifecycle.ts` row; a section "Start: fail fast, then configure" with the fatal table and the configurator values; the "Fallback" section says the engine is session-scoped and the tab is a viewer; the "Limits" bullet on method names cites step 208.4), `packages/session/README.md` (a paragraph "Inspector lifecycle" under the driver layers: prewarm, join, close, `E_INSPECTOR_STARTING`, the `inspector ready:` log line), `packages/adb/README.md`, `packages/core/README.md` (208.6 already), `docs/spec-divergences.md` (append the next free `DIV-` row: area §7.4/§7.9; spec says the Inspect tab owns the engine and `uiautomator dump` is the substitute when none is attached; code does a session-scoped engine with no ad-hoc substitute per MVP 02 §4 phase 1; severity medium; decision "superseded by plan 208, pending plan 202"; if `docs/spec.md` already has a section named "Inspector" written by plan 202, edit that section instead and say which in §11), this document (`> Status:` and §11)
- Test file: none for the bench (`--help` is the mechanical check)
- Verifiable result: `bun run scripts/bench-device-nfrs.ts --help` lists `--attach-cycles`; every §10 proof answers as its row says; `bun run typecheck` clean; `bash scripts/check-plan-status.sh` passes
- Do not: write `implemented` while G9 to G12 are open; write `implemented (software)`.

## 6. Acceptance criteria

1. G1 to G8, G13, G14 and G15 of §0 pass by their named commands.
2. `bun run dev` with one attached device: the log shows `session opened: ... at wall`, then about 2 s after the first frame `inspector ready: ui-server on <id> in <N> ms` with no browser open; `device.inspector.status` broadcasts `starting` then `healthy` and never `restarting` on a healthy device.
3. With the core still running, `adb shell am force-stop com.github.uiautomator.test` on that device: the log shows the instrumentation exit and a restart cycle within 2 s (not after two 5 s pings), then `healthy` and the configurator line again.
4. Opening the Inspect tab on that device answers `inspect.status ready` in under 100 ms (the `inspect.attached` event's `tookMs`); closing the tab records `inspect.detached` and the engine keeps answering `ping` (`curl http://127.0.0.1:<port>/ping` on the forwarded port prints `pong`).
5. `POST /api/v1/cap` with `device.find` on a device with no job and no Inspect tab answers through `ui-server` (the core log shows no `uiautomator dump` and the device's `dumpsys activity` shows no second UiAutomation client).
6. A device whose instrumentation cannot start (the executor simulates it by renaming the stub class in a scratch copy of the launcher, or the owner uses a device with the app APK only) reaches `uiautomator-dump` in under 3 s after `pm install` finishes, with a `device.inspector.fallback` whose reason names the fatal line.
7. Every §10 proof answers as its row says.
8. `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but the shell after the tests.

## 7. Test plan

Scoped commands only; one invocation at a time; never a suite.

```bash
bun test packages/drivers/src/inspector/ui-server/lifecycle.test.ts
bun test packages/drivers/src/inspector/ui-server/launcher.test.ts
bun test packages/drivers/src/inspector/ui-server/watchdog.test.ts
bun test packages/drivers/src/inspector/ui-server/client.test.ts
bun test packages/drivers/src/inspector/
bun test packages/adb/src/client.test.ts
bun test packages/session/src/session.test.ts
bun test packages/session/src/inspector-factory.test.ts
bun test packages/session/src/device-executor.test.ts
bun test packages/session/src/runner/trace.test.ts
bun test packages/core/src/capability/context.test.ts
bun test packages/core/src/server/ws-handlers-inspect.test.ts
bun test packages/core/src/api/adb-stats.test.ts
bun test packages/core/src/doctor/
bun test packages/toolchain/src/            # only after 208.11 changed the manifest
bun run typecheck
```

The Studio fixture edits of §4.1 (`page.test.tsx`, `AdbServerCard.test.tsx`) are verified one file at a time: `bun test packages/studio/src/components/AdbServerCard.test.tsx`, `bun test packages/studio/src/app/settings/page.test.tsx`. Never the Studio suite.

Manual smoke (one device, the executor's machine):

```bash
bun run reset
bun run dev &                                   # note the pid; kill it at the end
sleep 25
rg -n "inspector ready: ui-server" .dev-data/logs/* 2>/dev/null || true   # or read the console: one line per device, N ms
curl -s http://127.0.0.1:7700/api/adb/stats | bun -e 'const r = await new Response(Bun.stdin).json(); console.log(JSON.stringify(r.streams))'
# expected: {"maxStreams":..,"maxStreamsPerDevice":4,"active":<crash watcher count>,"pinned":<device count>,"perDevice":{...}}
adb shell am force-stop com.github.uiautomator.test          # the console shows the exit, a restart cycle, healthy, and the configurator line within ~3 s
bun run dev:studio &                            # open the device, open the Inspector tab: a tree in well under a second; close the tab
curl -s http://127.0.0.1:7700/api/adb/stats | grep -o '"pinned":[0-9]*'   # unchanged: the engine is still running
kill %1 %2; ps -Ao pid=,command= | grep -i "[o]penpf"                      # empty
```

Device-gated (owner, `ENKAKU_TEST_DEVICE=1`):

```bash
# lab device, cold attach and find latency (G10 cold, G11, G13)
ENKAKU_TEST_DEVICE=1 bun run scripts/bench-device-nfrs.ts --serial <serial> --skip-video --attach-cycles 3
# expected rows: ui-server attach cold p50 ≤ 8000 ms, find() p95 < 200 ms; the console shows the configurator line once per cycle

# lab device, warm attach (G10 warm): with the core running and the device prepared, open the Inspector tab three times, then
sqlite3 <dataDir>/enkaku.db "select meta from device_events where kind='inspect.attached' order by at desc limit 3"
# expected: every tookMs ≤ 3000 (a prewarmed engine answers in tens of ms)

# the 20-device farm, 10 minutes (G12): enqueue the owner's usual pack job on every device, wait 10 minutes, then
sqlite3 <dataDir>/enkaku.db "select count(*) from device_events where kind='session.degraded' and at > strftime('%s','now') - 600"
# expected: 0; and `rg -c "falling back to uiautomator-dump" <core log>` → 0 for the window
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A fatal pattern matches a benign line on some OEM's runner output and fails a start that would have succeeded | every pattern is anchored or names a Java exception; the debug log prints every line (`instrumentation: ...`), so a false positive is visible in the first field report; §9 Q3 confirms the table on the lab device before the wave closes |
| The instrumentation prints nothing on a device where it silently never binds the port | the 15 s ceiling still applies; nothing regressed relative to today |
| `waitForIdleTimeout: 0` returns a tree mid-animation | that is the chosen trade: a script polls at 80 ms and asserts what it needs; before this plan the same screen was a 20 s timeout (MVP 02 §2.4). The configurator values are one constant (`DEFAULT_CONFIGURATOR`) and one option on `UiServerInspectorOptions`, so a device-level override is a small later change |
| The configurator method name differs on 2.3.3 | step 208.4 verifies the source before the call is written; a failed `setConfigurator` at runtime is logged and never fatal |
| A session-lifetime instrumentation on 20 devices costs memory on the phones | it is the same process the Inspect tab already left running for the session's life whenever a tab was open; the pinned count in `/api/adb/stats` makes the number visible; plan 223's scale run measures it |
| `deviceCall` now waits for a cold start on the first agent read after connect | the prewarm starts 2 s after the first frame, so the wait is the remainder of an already-running start; the capability deadlines (`device-inspect.ts:30,49,84,121`) bound it and answer `E_DEADLINE` with the reason, never a wrong engine |
| Deleting the ref-count changes what `inspect.detached` means in the device log | the event doc comment and the DeviceLog copy already say "viewer left"; nothing consumed the count |
| The 2.4.0 release changed the JSON-RPC surface (`FastInputIME` replaced by `AdbKeyboard`, R5) | the client uses none of the IME methods; the bench's dump/find/objInfo run on the lab device is the compatibility check before the pin moves |
| `pinned` as a required field breaks a Studio fixture that types the stats response | §4.1 lists the four fixture files; each is run alone |

## 9. Open questions

1. **Does openatx 2.4.0 start on API 36?** Step 208.11 measures it. If not, the owner decides between keeping 2.3.3 with the dump engine as the effective engine on Android 16 until plan 222, and patching an APK build (out of this plan). Answer to be written here by the executor with the observed `INSTRUMENTATION_*` lines.
2. **`compatibleCoreRange` value.** §4.12 proposes `>=<current core version>`. The owner may prefer a caret range tied to the release in which the pin lands; the manifest's `resolveLockedVersion` accepts any valid semver range.
3. **Fatal pattern table.** Rows 3 to 6 of `INSTRUMENTATION_FATAL_PATTERNS` come from the platform's documented raw output, not from a measurement in this repo (only the `stack=`/`ClassNotFoundException` pair is measured, `launcher.ts:16-17`). Confirm each on the lab device with the wrong-class command (`-e class com.github.uiautomator.test.Stub`) and with the test package uninstalled; remove any row that never fires.
4. **`uiAutomationFlags` and plan 221.** UiAutomation suppresses other accessibility services while it is connected unless the connection carries the "do not suppress accessibility services" flag (to verify against the Android reference for `UiAutomation`; the value believed to be `0x2`). If plan 221's `AccessibilityService` must coexist with a running ui-server on the same device, the configurator must send `uiAutomationFlags` with that bit, which requires the 2.3.11+ field (R5) and therefore the 2.4.0 pin. Decide when plan 221 starts; this plan does not send the field.
5. **Plan 206 order.** If this plan executes before plan 206 has landed, `prewarmInspector` is added here (§4.8) and nothing calls it until 206's builder does; the inspector is then started by the first job or Inspect tab exactly as today, and the session scope still holds. Record which happened.
6. **Warm-attach threshold.** MVP 02 §4 says "under 3 s warm"; with attach-to-running the measured value should be tens of milliseconds. The owner may want the checklist row tightened to 500 ms once measured.

## 10. Removed

Forbidden words introduced by this area (in inspector code and comments, outside `docs/archive/` and the plan documents): `releaseInspector`, `inspectorRefCounts`, `detachInspector`, `ad-hoc dump`, `ref-counted` (inspector context), `TODO-M4.5` (if 208.11 moved the pin).

```
GREP_208 = rg -n "releaseInspector|inspectorRefCounts|detachInspector|ad-hoc dump|new UiautomatorDumpInspector\(" packages apps plugins scripts --glob '!**/*.test.ts' --glob '!packages/session/src/inspector-factory.ts'
```

Expected output: empty.

| What | Where it was | Proof |
|---|---|---|
| The ad-hoc `UiautomatorDumpInspector` instantiation on the executor path (MVP 13 A.9 row 1) | `packages/session/src/device-executor.ts:165`; `packages/session/src/runner/job-runner.ts:1142` and its import at `:2` | `rg -n "new UiautomatorDumpInspector\(" packages --glob '!**/*.test.ts'` → one line, `packages/session/src/inspector-factory.ts` |
| The Inspect-tab ref-counted teardown (MVP 13 A.9 row 2) | `packages/core/src/server/ws-handlers.ts:611-635` (`inspectorRefCounts`, `detachInspector`), `:2240-2251`, `:2627-2629`, `:2689` | `rg -n "inspectorRefCounts|detachInspector" packages/core/src` → empty |
| `DeviceSession.releaseInspector` and its implementation | `packages/session/src/session.ts:168-176`, `:510-517`, `:857`; the fixture at `ws-handlers-inspect.test.ts:99-102`; the describe at `session.test.ts:35-85` | `rg -n "releaseInspector" packages apps plugins scripts` → empty |
| The `onData: () => {}` discard of the instrumentation stream | `packages/session/src/inspector-factory.ts:104`; `scripts/bench-device-nfrs.ts:227` | `rg -n "onData: \(\) => \{\}" packages/session/src/inspector-factory.ts scripts/bench-device-nfrs.ts` → empty |
| The start-path message `ui-server was not ready within the start timeout` as the only start failure | `packages/drivers/src/inspector/ui-server/watchdog.ts:178-180` | `rg -n "was not ready within the start timeout" packages/drivers/src/inspector/ui-server/watchdog.ts` → empty (the silence reason is now one of several, produced by `waitReady`) |
| The "ref-counted per device" wording on the attach and detach messages | `packages/protocol/src/messages/inspect.ts:21`, `:28`; `packages/protocol/src/messages/device-event.ts:43-46` | `rg -n -i "ref-counted|last one leaves" packages/protocol/src/messages/inspect.ts packages/protocol/src/messages/device-event.ts` → empty |
| The `TODO-M4.5` placeholders (conditional on 208.11) | `packages/toolchain/manifest/enkaku-tools.json:95`, `:119` | `rg -n "TODO-M4.5" packages/toolchain/manifest/enkaku-tools.json` → empty, or §11 records the pin stayed |
| The `TODO-verify` on the JSON-RPC method names | `packages/drivers/src/inspector/ui-server/client.ts:9` | `rg -n "TODO-verify" packages/drivers/src/inspector/ui-server/client.ts` → empty |

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:
