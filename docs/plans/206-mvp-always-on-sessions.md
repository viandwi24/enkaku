# Plan 206 — MVP wave 1 : Always-on sessions and the encoder split

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 200 (the program: rules, format, references R1..R8), plan 205 (device activities: this plan emits `prep` and `wake` activities through the activity port §4.2 defines; if plan 205 has not landed, the port is wired to the no-op implementation this plan ships and §9 Q1 records it), plan 201 (housekeeping) for the tree it starts from.
> Spec references: `docs/mvp/11-always-on.md` (entire; the model), `docs/mvp/01-casting-latency.md` §1.1 and §1.3 (join priming, backpressure), `docs/mvp/02-inspector-readiness.md` §2.1 (the measured reason for the lazy inspector start), `docs/mvp/13-removal-register.md` A.3 (the rows §10 copies), `docs/mvp/16-consolidated-plan.md` §1 "Mechanisms" and §3 wave 1 acceptance ("no Waking anywhere; 20 devices warm within 60 s of a core restart"). `docs/spec.md` §7 and §10.1 are superseded by `docs/mvp/16` for this series (plan 200 header).
> Ships: packages/session/src/always-on.ts

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A session is built when a device comes online, not when a browser asks | `createAlwaysOn` enqueues a build from `onDeviceReady`; `SessionManager.acquire` never builds | `bun test packages/session/src/always-on.test.ts` → test `deviceOnline enqueues exactly one build` passes; `bun test packages/session/src/manager.test.ts` → test `acquire never builds: no base entry means device_not_ready` passes | [ ] |
| G2 | Builds are staggered per USB root and farm-wide, ordered by device number | per root default 4, farm ceiling 16, ascending device number | `bun test packages/session/src/always-on.test.ts` → tests `stagger: at most buildsPerUsbRoot builds per root run at once`, `stagger: the farm ceiling bounds the sum across roots`, `stagger: pending builds start in device-number order` pass | [ ] |
| G3 | A dead scrcpy session is rebuilt with backoff and a `recovering` meta | delays `[1000, 3000, 10000, 30000]` ms, then 30000 repeated; activity meta `{ recovering: true, attempt: n }` | `bun test packages/session/src/always-on.test.ts` → test `scrcpy death: rebuild after 1 s, 3 s, 10 s, 30 s, 30 s with a recovering meta` passes (fake transport, fake timers) | [ ] |
| G4 | The wall encoder starts at build and never stops; the control encoder starts on demand and stops after the linger | at most 2 encoders per device; `CONTROL_LINGER_MS = 15_000` | `bun test packages/session/src/manager.test.ts` → tests `encoder split: a device never holds more than two entries`, `encoder split: the control entry closes 15 s after the last control viewer detaches` pass | [ ] |
| G5 | `stream.start` at control quality paints from the wall encoder first, then switches | `stream.started.substitute === 'wall'`, then `stream.meta` with `quality: 'control'` after the control entry's first keyframe | `bun test packages/core/src/server/ws-handlers-video.test.ts` → tests `control attach: started carries substitute wall and primes from the wall entry`, `control attach: the binding switches on the control entry's first keyframe and sends stream.meta` pass | [ ] |
| G6 | Settings `idleTtlSec`, `maxIdleSessions`, `maxConcurrentBuilds` are gone; `session.buildsPerUsbRoot` is the one remaining knob | 0 matches; schema default `{ buildsPerUsbRoot: 4 }` | `rg -n "idleTtlSec|maxIdleSessions|maxConcurrentBuilds" packages apps plugins scripts` → empty; `bun test packages/protocol/src/settings.test.ts` passes | [ ] |
| G7 | No `Waking` string, no wake offer, no phase list in Studio | 0 matches | `rg -n "Waking|WAKE_OFFER_AFTER_SEC|PHASE_STEPS|PHASE_HEADLINE|PHASE_COMPACT_LABEL|session\.progress" packages/studio/src packages/protocol/src packages/core/src packages/session/src` → empty | [ ] |
| G8 | Readiness desired defaults to `awake` for every row, old and new | migration `0065` rewrites `devices.desired_readiness` NULL and `'asleep'` to `'awake'`; `readiness.ts` NULL fallback is `'awake'` | `bun test packages/core/src/db/desired-awake-migration.test.ts` passes; `rg -n "\?\? 'asleep'" packages/core/src/device/readiness.ts` → empty | [ ] |
| G9 | Backpressure resumes on `drain()` and a dropped `send()` is detected | `websocket.drain` wired; `ws.send() === 0` marks `awaitingKeyframe` (R8) | `bun test packages/core/src/server/ws-handlers-video.test.ts` → tests `backpressure: a send that returns 0 marks the binding awaiting a keyframe`, `backpressure: drain requests a keyframe for every binding that was waiting` pass | [ ] |
| G10 | Inspector prewarm starts only after the first frame, through one interface | `session.prewarmInspector()` called `INSPECTOR_PREWARM_DELAY_MS = 2000` after step 5 | `bun test packages/session/src/always-on.test.ts` → test `inspector prewarm is called 2 s after the first frame, never before` passes | [ ] |
| G11 | `GET /api/video/sessions` lists every device's encoder states and bytes/s | response validates against `VideoSessionsResponseSchema` | `bun test packages/core/src/api/video.test.ts` → test `GET /sessions answers the schema with one row per known device` passes | [ ] |
| G12 | The bench harness measures the warm-up | `bun run bench:device-nfrs -- --warmup --expect N` prints `warm: N/N in S s` | `bun run scripts/bench-device-nfrs.ts --help` lists `--warmup`, `--expect`, `--timeout-sec`, `--core-port`; the owner's run prints `warm: 20/20 in S s` with S ≤ 60 | owner |
| G13 | Wall attach paints within one keyframe interval on a warm farm | every visible Screens tile paints ≤ one IDR interval after `stream.started` | owner, on the 20-device farm with the plan 203 overlay | owner |
| G14 | Device Control shows a picture within 100 ms of open | click → first painted frame ≤ 100 ms while `substitute === 'wall'`, sharp picture ≤ 2 s | owner, measured with the plan 203 overlay (`click→paint` readout) | owner |
| G15 | `bun run typecheck` is clean | 0 errors | `bun run typecheck` → exit 0 | [ ] |

## 1. Goals

1. Every online device holds one session for as long as it is online: built from the registry's `onDeviceReady` hook, torn down only by `onDeviceGone` or forget, rebuilt automatically when scrcpy dies (MVP 11 §1.1, §1.5).
2. The wall-profile encoder runs for the whole session; the control-profile encoder runs only while a Device Control is attached, plus a 15 s linger (MVP 11 §1.2).
3. A browser is a viewer: `stream.start` attaches to a running encoder and primes from the cached config and keyframe (MVP 01 §1.3). It never builds. A control request is served by the wall encoder until the control encoder's first keyframe, then switched, and the wire says which one the viewer is looking at (MVP 11 §1.2).
4. Builds are staggered: at most `session.buildsPerUsbRoot` (default 4) per USB root and `SESSION_BUILD_FARM_CEILING` (16) farm-wide, in device-number order (MVP 11 §1.4). A core restart rebuilds every session under the same stagger with no browser involved.
5. The device's activity list carries the build: `prep` with "Preparing, step n of 5" while the session is built, `recovering` meta while a rebuild waits its backoff, `wake` while a readiness wake runs outside a build (MVP 04 §1.1, §1.4).
6. Readiness `desired` is `awake` for every device by default, including rows that predate this plan; an explicit Sleep keeps the session up and the tile shows the dark screen, not a loading panel (MVP 11 §1.1).
7. The inspector prewarm starts after the first frame, staggered by 2 s, through `session.prewarmInspector()` (MVP 02 §2.1: an eager start starved the screencap loop; this plan starts it late and plan 208 makes it fast).
8. The three session settings and every consumer of them are deleted; the "Waking" panel, the wake offer and `session.progress` are deleted; the screencap loop remains only as the engine fallback under the condition §3.6 states (MVP 11 §3, MVP 13 A.3).

## 2. Non-goals

| Not done here | Plan that does it |
|---|---|
| The activity registry, `device.activity` message, policy table, `devices.status` shrink | plan 205 (this plan consumes an `ActivityPort`, §4.2) |
| The inspector's own lifecycle: session-scoped ownership, fail-fast start, idle-wait, capability path | plan 208 (this plan calls `session.prewarmInspector()` and ships a no-op default) |
| PTS end to end, latency overlay, bench harness for glass-to-glass, H-9 | plan 203 |
| Ring buffer in the demuxer, decoder hints, live drag, `setNoDelay`, control default preset | plan 209 |
| The Screens view tile, activity strip, status dot, the Device Control window | plans 214, 215 (this plan makes the minimal `LiveView.tsx` change §4.9 so nothing shows "Waking" meanwhile) |
| Settings schema reduction to 26 fields, `farmSections.ts` regrouping | plan 212 (this plan only deletes its three fields and adds `buildsPerUsbRoot`) |
| Readiness `hot`/`maxHot` removal or redefinition | plan 212 §9 (this plan leaves the `hot` branch compiling; §9 Q3) |
| Cloud node parity (`packages/node`): staggered builds, quality negotiation, remote priming | post-MVP (MVP 16 §1); this plan keeps `packages/node/src/hosts.ts` compiling by calling `sessions.build()` directly, §5 step 206.5 |
| Narrating a reprofile restart on the tile ("applying new video settings") | plan 214 may add an activity; after this plan a reprofile is a brief dark tile that repaints |
| Scale runs, lifecycle targets, USB topology documentation | plan 223 |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03)

- A session is created by `SessionManager.acquire` (`packages/session/src/manager.ts:86`, `acquire(deviceId: string, onFrame: ..., quality?: Quality): Promise<DeviceSession>`), which queues `buildEntry` behind a farm-wide build lane (`:796`, `pending = buildLane.run(() => buildEntry(deviceId, quality))`). `createBuildLane` (`:375`) reads `maxConcurrentBuilds` fresh; `release` arms an idle timer (`:835`, `entry.closeTimer = setTimeout(() => void closeEntry(key, 'idle_timeout'), ttlSec * 1000)`) and `enforceIdleCap` (`:492`) evicts past `maxIdleSessions`. `closeIfIdle` (`:947`) and `idleSessions` (`:952`) exist only for that model.
- `createSession` (`packages/session/src/session.ts:449`) runs: `onPhase('connecting')` (`:461`), transport connect, `onPhase('waking')` (`:523`), `wakeDevice` unless `skipWake` (`:551`), rotation, farm tag, `onPhase('starting-video')` (`:679`), `makeScrcpy` with a silent fall back to the screencap loop (`:690-697`, the `log.warn` whose text begins `scrcpy cannot be used (` and ends `falling back to screencap-loop + adb-input`), a `requireScrcpy` bail-out that throws `E_CONTROL_SESSION_UNAVAILABLE` (`:707`, `:724-727`), and the first-frame hook (`:989-1003`, `if (!firstFrameSeen) { firstFrameSeen = true; onPhase('ready'); void startTextInput() }`). The inspector is lazy (`:473-509`, `const startInspector = (): Promise<void> => {` at `:495`), with the measured reason in the comment at `:477-482`: awaiting it up front delayed the first frame by about 50 s, starting it in the background starved the screencap loop (1 frame in 20 s versus 11).
- scrcpy launch (`packages/scrcpy/src/session.ts:193`, `await pushJar(adb, opts.jarPath)`; `:196-209`, the argument list with `max_size`, `video_bit_rate`, `max_fps`) pushes the jar on every session (`:536`, `async function pushJar`) and connects the video socket with up to 40 attempts of 400 ms silence (`:748-749`, `const ATTEMPTS = 40`, `const SILENCE_MS = 400`).
- `ScrcpyDisplay` caches the config and the last IDR (`packages/drivers/src/display/scrcpy.ts:16-17`, `private lastConfig`, `private lastKeyframe`; `:62-78` fills them from `onPacket`). `ScreencapLoop` (`packages/drivers/src/display/screencap-loop.ts:18`, `export class ScreencapLoop implements DisplaySource {`) is the PNG fallback.
- `ws-handlers.ts`: `MAX_BUFFERED = 512 * 1024` (`:73`); `stream.start` (`:917`) builds a `StreamBinding` whose `onFrame` reads `ws.getBufferedAmount()` (`:945`), drops to keyframe when `congested` (`:951-963`) and calls `ws.send(encoded)` without reading its return value (`:972`); it takes a readiness hold (`:1012`, `binding.readinessHold = await deps.readiness?.hold(msg.payload.deviceId, 'viewer')`), acquires (`:1018`), substitutes the wall entry on `E_CONTROL_SESSION_UNAVAILABLE` (`:1026-1033`), sends `stream.started` (`:1058-1071`) and primes config and keyframe (`:1088-1105`). `stream.stop` (`:1109-1118`) and `handleClose` (`:2555-2567`) release through `deps.sessions?.release(...)` and `binding.readinessHold?.release()`.
- `daemon.ts` wires the manager at `:3859` (`sessions = createSessionManager({`) with `idleTtlSec`/`maxIdleSessions` (`:3904-3905`) and `maxConcurrentBuilds` (`:3913`), `onSessionEnded` → `stream.ended` (`:3880-3881`), `onPhase` → `session.progress` (`:3885-3886`), `deviceIsAwake` (`:3929`). `closeIfIdle` is called on quarantine (`:1169`) and on job claim (`:1966`). The registry's hooks are `onDeviceGone` (`:4317`, `void sessions?.closeDevice(deviceId)`) and `onDeviceReady` (`:4355`), fired from `device-registry.ts:671` (`deps.onDeviceReady?.(row.id)`) after `DEVICE_CONNECTED` (`:646`) and from `:707` (`deps.onDeviceGone?.(row.id)`). `registry.start()` (`:4406`) re-probes every attached serial (`device-registry.ts:526`, `void onOnline(serial)`), so a core restart already fires `onDeviceReady` once per online device. The Bun websocket options are `idleTimeout: 120, sendPings: true` (`:3403-3404`), no `drain`, no `backpressureLimit`.
- Readiness (`packages/core/src/device/readiness.ts`): NULL falls back to `'asleep'` at `:153` (`const desired = (row.desiredReadiness as Readiness | null) ?? 'asleep'`) and `:225` (`return row ? ((row.desiredReadiness as Readiness | null) ?? 'asleep') : 'asleep'`); `rawActual` (`:254-260`) reads `hot` when `deps.sessions()?.get(deviceId)` is set; `ensureAwake` (`:349-379`) runs `wakeDevice` (`:366`); the `hot` branch acquires a wall session (`:448`, `await sessions.acquire(deviceId, sink, 'wall')`); the asleep branch releases the wake only when no session exists (`:476`). Migration `0064_awake_on_connect.sql` rewrote `prep.keepAwake` `'while-charging'` → `'always'` on `devices.settings` and `farm_settings`; it did NOT touch `desired_readiness`. The schema default `readiness.defaultDesired` is `'awake'` (`packages/protocol/src/settings.ts:2351`) for fresh farms only, as its own comment at `:2337-2349` says.
- Settings (`packages/protocol/src/settings.ts:2004-2046`): the `session` block holds `idleTtlSec` (`:2006`), `maxIdleSessions` (`:2014`), `maxConcurrentBuilds` (`:2033`), default `{ idleTtlSec: 300, maxIdleSessions: 8, maxConcurrentBuilds: 2 }` (`:2042`). Studio groups it under `farmSections.ts:98` (`{ id: 'sessions', title: 'Sessions & Wall', group: 'Devices', keys: ['session', 'wall', 'readiness', 'display'] }`).
- Protocol (`packages/protocol/src/messages/stream.ts`): `StreamStartMessage` (`:15-23`), `StreamStartedMessage` with `degradedReason: z.literal('control_session_unavailable').optional()` (`:57`), `StreamMetaMessage` (`:84-87`), `SessionPhaseSchema` (`:100-106`), `SessionProgressMessage` (`:109-117`). Exported from `packages/protocol/src/index.ts:447-460`; in `ServerMessageSchema` at `:1015-1018`.
- Studio `LiveView.tsx`: `STALE_AFTER_SEC = 5` (`:41`), `WAKE_OFFER_AFTER_SEC = 30` (`:43`), `SLOW_PHASE_AFTER_SEC = 10` (`:47`), `PHASE_STEPS` (`:133-138`, `{ key: 'waking', label: 'Waking' }` at `:135`), `PHASE_HEADLINE` (`:139-145`), `PHASE_COMPACT_LABEL` (`:152-158`), `phase`/`phaseDetail` state (`:359`, `:368`), the `session.progress` handler (`:468-471`), the auto-recover tick (`:815`, `if (autoReconnect && sec >= WAKE_OFFER_AFTER_SEC) {`), `showWakePanel` (`:944`), the wake offer (`:1015-1024`), the panel (`:1237-1274`), and the provisioning overlay's `!showWakePanel` guard (`:1287`). `WallTile.tsx:492` renders `<LiveView deviceId={device.id} inputEnabled={false} quality="wall" compact />`.
- `adb`: `TrackedDevice.usb` (`packages/adb/src/tracker.ts:15`, `usb?: string`, e.g. `3-1.4.3`) is filled only by `AdbClient.listDevices()` (`packages/adb/src/client.ts:701`, `host:devices-l`; `:148`, `if (key === 'usb') device.usb = value`). The registry stores nothing about it.
- `scripts/bench-device-nfrs.ts` drives one device directly (`:81-86` imports the packages by relative path, `:107` `function flag(args, name)`, `:140` `async function main()`, `:146` the `ENKAKU_TEST_DEVICE` gate, `:385` the results table).
- `GET /api/adb/stats` reports `idleSessions` (`packages/core/src/api/adb-stats.ts:162`, `:195`; schema `packages/protocol/src/api/adb.ts:70`) and a `video` block whose `maxConcurrentBuilds` comes from `daemon.ts:3108`.

### 3.2 The decision: a session lives as long as the device is online

MVP 11 §1.1 is binding: build at connect, staggered, never stop. The prototype's lazy model existed for battery and for the measured inspector starvation (§3.1, `session.ts:477-482`). Neither reason survives the product: the phones are racked and powered, scrcpy encodes only when the display changes, and the inspector is started after the first frame here, not before it.

The builder lives in a new module, `packages/session/src/always-on.ts`, and the manager keeps the entries. Splitting them keeps the manager's existing tests about entries, subscribers, `restartAt`, `reprofile` and `setRotation` valid, and makes the stagger and the backoff unit-testable with fake timers and a fake manager.

### 3.3 The five steps and why the order is the code's, not the brief's

The activity sentence is "Preparing, step n of 5". The steps are the session's own phases in the order `createSession` runs them, because that order is load-bearing: the wake (`session.ts:551`) runs before the video server so the first frame is a picture and not a black panel, and the inspector runs after the first frame so it cannot starve it (`:477-482`).

| Step | `SessionPhase` (`stream.ts:100-106`) | What runs |
|---|---|---|
| 1 | `connecting` | adb transport connect |
| 2 | `waking` | `wakeDevice` (skipped when the readiness manager already holds the screen; the step is still reported, instantly) |
| 3 | `starting-video` | jar push, port forward, scrcpy-server launch, video and control sockets |
| 4 | `waiting-frame` | sockets up, no picture yet |
| 5 | `ready` | first frame received; the `prep` activity ends here |

The inspector prewarm is the sixth thing that happens and is deliberately not a step: the tile has a picture by then, and `device.inspector.status` (an existing message) is where its progress is reported (plan 208). The guest agent hello that MVP 11 §1.1 lists is already started by the first-frame hook (`session.ts:1000`, `void startTextInput()`) and stays there.

### 3.4 Encoder split

Two `createSession` calls per device at most: the base entry at `wall` quality (built by the always-on builder; owns device prep) and the control entry at `control` quality (built on demand with the existing fast path `skipDevicePrep: true, requireScrcpy: true`, `manager.ts:679`). The control entry closes `CONTROL_LINGER_MS` after its last viewer detaches. The base entry never closes on its own.

A control viewer is attached to the base entry the instant it asks, so the first picture costs no build. When the control entry has a cached IDR (`session.videoKeyframe()` non-null, `session.ts:850`), the manager moves the viewer's subscriber to the control entry and calls the viewer's `onSwitched`; `ws-handlers.ts` then sends `stream.meta` with the control frame size and `quality: 'control'` and primes the control entry's config and keyframe. Nothing is transcoded, nothing is upscaled server-side: the browser draws the 480 px wall frame into the same canvas it will draw the 1600 px control frame into.

### 3.5 Stagger by USB root

`adb devices -l` carries `usb:3-1.4.3`: the bus number before the first `-` is the root hub, the dotted path the port chain. `AdbClient.listDevices()` already parses it (`client.ts:148`). The builder resolves a device's root once per pending build from a `listDevices()` result cached for `USB_ROOT_CACHE_MS = 5_000`; a device with no `usb:` field (a TCP transport) is grouped under `'network'`; a device whose serial is absent from the listing (adb's answer is stale for a moment after plug-in) is grouped under `'unknown'` and bounded by the farm ceiling only. `session.buildsPerUsbRoot` (default 4, MVP 12 §2) bounds each group; `SESSION_BUILD_FARM_CEILING = 16` bounds the sum, overridable by `ENKAKU_SESSION_BUILD_CEILING` (MVP 12 §3, support overrides). Pending builds start in ascending device number (`packages/core/src/registry/device-number.ts:78`, `lookupDeviceNumber`), so tile 01 paints before tile 20.

### 3.6 Failure, recovery, and the screencap loop's one remaining role

A build that rejects, or a session whose scrcpy process dies (`onDisplayError` → `closeEntry` → `deps.onSessionEnded`, `manager.ts:597-599`), schedules a rebuild after `REBUILD_BACKOFF_MS[attempt - 1]` (`[1_000, 3_000, 10_000, 30_000]`, then 30 s repeated). The `prep` activity carries `meta: { recovering: true, attempt, nextRetryAt }` and the label "Recovering, attempt n"; the attempt counter resets when a build reaches step 5. Going offline cancels the pending build, the retry timer and the activity.

The screencap loop is no longer a build-time substitute. The builder passes `requireScrcpy: true` to every base build, so a device whose scrcpy cannot start is a failed build that recovers under the backoff, honestly labelled, instead of a PNG session under a wall label. The engine stays as the fallback in exactly two cases, both explicit: (1) the device's own configured display engine is `screencap-loop` (`row.display === 'screencap-loop'`, the operator's choice, `session.ts:690`), and (2) `SCRCPY_FALLBACK_AFTER_FAILURES = 4` consecutive base builds have failed with `E_SCRCPY_UNAVAILABLE`, after which the builder drops `requireScrcpy` and the session opens on the screencap loop with the existing heal-back retry (`session.ts:1012-1083`, `armFallbackRetry`/`attemptFallbackRecovery`) still armed. Nothing else may instantiate `ScreencapLoop` at build time.

### 3.7 Readiness

`desired` is `awake` by default for every device, old and new. `0064` did not touch `desired_readiness` (§3.1), so the owner's farm still carries literal `'asleep'` rows written by the pre-plan-125 default and NULL rows that predate readiness. Migration `0065` rewrites both to `'awake'`, and `readiness.ts`'s two NULL fallbacks become `'awake'`. An operator who wants a device asleep sets it again after the upgrade; this is the same rule `normaliseLegacyAdb`/`normaliseLegacyWall` and `0064` already apply to a value that was a default nobody chose (`00-overview.md` §9, plan 85 and plan 92 rows).

The wake is executed by step 2 of the build (`createSession` → `wakeDevice`), not by a viewer hold: `ws-handlers.ts:1012`'s `readiness.hold(..., 'viewer')` is deleted. Readiness keeps `hold` for transfers and other non-viewer callers; `ensureAwake` gains a `wake` activity around its `wakeDevice` call. Sleep (`set(deviceId, 'asleep', ...)`) never closes a session: the asleep branch already leaves a live session alone (`:476`).

### 3.8 Backpressure

Drop-to-keyframe stays exactly as it is (`ws-handlers.ts:945-963`). Two additions from R8: `ws.send()` returns `0` when Bun dropped the message, so a `0` is treated like congestion (mark `awaitingKeyframe`, request an IDR); and Bun's `drain()` handler fires when a backpressured socket is writable again, so every binding on that connection that is `awaitingKeyframe` requests a keyframe at that moment instead of waiting for the encoder's next scheduled IDR. `MAX_BUFFERED` is already a named, exported constant (`:73`); this plan adds `BACKPRESSURE_LIMIT_BYTES = 4 * MAX_BUFFERED` and passes it to `Bun.serve`'s `websocket.backpressureLimit` with `closeOnBackpressureLimit: false`.

### 3.9 Inspector prewarm

`DeviceSession` gains `prewarmInspector(): Promise<void>`. This plan ships it as a no-op that resolves immediately and logs nothing; plan 208 replaces the body with the session-scoped, fail-fast start on the streaming lane. The builder calls it `INSPECTOR_PREWARM_DELAY_MS = 2_000` after step 5, once per build, never before a frame (MVP 02 §2.1). `whenInspectorReady()` is unchanged: a job that needs the inspector still gets it.

### 3.10 What the browser sees

`stream.start` on a device with no base entry is refused with `E_SESSION_PREPARING` (message: the activity sentence, e.g. `Preparing, step 3 of 5`) or `device_offline`; the client retries every `PREPARING_RETRY_MS = 3_000` and shows the sentence as the tile's only text while it has no frames. The "Waking" panel, the phase list, the wake offer and `session.progress` are deleted. The handoff's Screens card rule holds: "Center text **only when not live**: "Disconnected" or "Unauthorized" (11px; unauthorized in `var(--warn)`). A connected device shows no center text — the cast fills the box." (`docs/mvp/design_handoff_enkaku_openpf/README.md`, Screens view). This plan's sentence is the pre-plan-214 stand-in for that centre text; plan 214 rebuilds the card.

## 4. Technical design

### 4.1 File structure

```
packages/session/src/
  always-on.ts                 NEW   builder: queue, stagger, backoff, activities, prewarm
  always-on.test.ts            NEW
  manager.ts                   CHANGED  entries, build(), attachViewer/detachViewer, control linger, rates
  manager.test.ts              CHANGED
  session.ts                   CHANGED  prewarmInspector, E_SCRCPY_UNAVAILABLE, no silent screencap fallback under requireScrcpy
  session.test.ts              CHANGED
  errors.ts                    CHANGED  E_SCRCPY_UNAVAILABLE replaces E_CONTROL_SESSION_UNAVAILABLE
  index.ts                     CHANGED  exports
packages/protocol/src/
  messages/stream.ts           CHANGED  substitute, stream.meta quality/detail, SessionProgressMessage deleted
  messages/stream.test.ts      NEW
  api/video.ts                 CHANGED  VideoSessionsResponseSchema
  api/video.test.ts            CHANGED
  api/adb.ts                   CHANGED  idleSessions deleted, video block renamed fields
  settings.ts                  CHANGED  session block
  settings.test.ts             CHANGED
  index.ts                     CHANGED  exports and ServerMessageSchema
packages/core/src/
  api/video.ts                 CHANGED  GET /sessions
  api/video.test.ts            NEW
  api/adb-stats.ts             CHANGED
  api/adb-stats.test.ts        CHANGED
  server/ws-handlers.ts        CHANGED  stream.start/stop, handleDrain, handleClose
  server/ws-handlers-video.test.ts CHANGED
  daemon.ts                    CHANGED  wiring, websocket options
  device/readiness.ts          CHANGED  awake fallback, wake activity, acquire signature
  device/readiness.test.ts     CHANGED
  capability/context.ts        CHANGED  acquire signature
  db/desired-awake-migration.test.ts NEW
packages/core/drizzle/
  0065_desired_awake.sql       NEW   (data migration, §4.7)
  meta/_journal.json           CHANGED (generated)
packages/node/src/hosts.ts     CHANGED  build() before acquire()
packages/studio/src/
  components/LiveView.tsx      CHANGED  §4.9
  components/LiveView.test.tsx CHANGED
  components/settings/farmSections.ts   CHANGED (keys unchanged; the block's title/description come from the schema)
  app/settings/page.test.tsx, components/video/FarmVideoFields.test.tsx, components/video/useAdbVideoStatsPoll.test.ts, components/wall/Wall.test.tsx  CHANGED fixtures
scripts/bench-device-nfrs.ts   CHANGED  --warmup
.env.example                   CHANGED  ENKAKU_SESSION_BUILD_CEILING under a "Support overrides" heading
```

### 4.2 `packages/session/src/always-on.ts`

```ts
import type { TrackedDevice } from '@enkaku/adb'
import type { DeviceSession } from './session'
import type { SessionManager } from './manager'
import type { DeviceSnapshotSource } from './types'
import type { Logger } from './logger'

export type PrepStep = 1 | 2 | 3 | 4 | 5
export const PREP_STEP_COUNT = 5
export const REBUILD_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000] as const
export const DEFAULT_BUILDS_PER_USB_ROOT = 4
/** Farm-wide ceiling on concurrent builds; `ENKAKU_SESSION_BUILD_CEILING` overrides it (MVP 12 §3). */
export const SESSION_BUILD_FARM_CEILING = 16
export const SCRCPY_FALLBACK_AFTER_FAILURES = 4
export const INSPECTOR_PREWARM_DELAY_MS = 2_000
export const USB_ROOT_CACHE_MS = 5_000
export const NETWORK_ROOT = 'network'
export const UNKNOWN_ROOT = 'unknown'

export function prepLabel(step: PrepStep): string {
  return `Preparing, step ${step} of ${PREP_STEP_COUNT}`
}
export function recoveringLabel(attempt: number): string {
  return `Recovering, attempt ${attempt}`
}
export const PREP_QUEUED_LABEL = 'Preparing, queued'

/** `3-1.4.3` → `3`; undefined → `network`. Pure, exported for the test. */
export function usbRootOf(usb: string | undefined): string {
  if (!usb) return NETWORK_ROOT
  const dash = usb.indexOf('-')
  return dash < 0 ? usb : usb.slice(0, dash)
}

/** Backoff for the n-th consecutive failure (1-based); the last value repeats. */
export function rebuildDelayMs(attempt: number): number {
  return REBUILD_BACKOFF_MS[Math.min(attempt, REBUILD_BACKOFF_MS.length) - 1] ?? REBUILD_BACKOFF_MS[REBUILD_BACKOFF_MS.length - 1]
}

/**
 * The seam to plan 205's activity registry. One activity per device per build;
 * `start` returns the id the later calls address. The no-op below is what a
 * fixture, the node package, or a core without plan 205 wires.
 */
export interface ActivityPort {
  start(deviceId: string, input: {
    kind: 'prep' | 'wake'
    label: string
    actor: { kind: 'system'; id: string; label: string }
    meta?: Record<string, unknown>
  }): string
  update(deviceId: string, id: string, patch: { label?: string; meta?: Record<string, unknown> }): void
  end(deviceId: string, id: string): void
}
export const noopActivityPort: ActivityPort = { start: () => crypto.randomUUID(), update: () => {}, end: () => {} }
export const ALWAYS_ON_ACTOR = { kind: 'system', id: 'always-on', label: 'Enkaku' } as const

export type DeviceBuildState = 'none' | 'queued' | 'preparing' | 'ready' | 'recovering'

export interface AlwaysOnDeps {
  sessions: Pick<SessionManager, 'build' | 'closeDevice' | 'get'>
  devices: DeviceSnapshotSource
  /** `AdbClient.listDevices` (host:devices-l), the only source of `usb:`. */
  listDevices: () => Promise<TrackedDevice[]>
  /** `lookupDeviceNumber` by device id; null sorts last. */
  deviceNumber: (deviceId: string) => number | null
  activities: ActivityPort
  buildsPerUsbRoot: () => number
  farmCeiling?: () => number
  log: Logger
  /** Injectable for tests; default `setTimeout`/`clearTimeout`/`Date.now`. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void; now: () => number }
}

export interface AlwaysOn {
  /** Enable the pump. Calls before `start()` are queued, not dropped. */
  start(): void
  deviceOnline(deviceId: string): void
  deviceOffline(deviceId: string): void
  /** Wired to `SessionManagerDeps.onSessionEnded`; schedules a rebuild with backoff. */
  sessionEnded(deviceId: string, reason: string): void
  stateOf(deviceId: string): { state: DeviceBuildState; step: PrepStep | null; attempt: number; usbRoot: string | null }
  stats(): { running: number; queued: number; perRoot: Record<string, { running: number; queued: number }>; buildsPerUsbRoot: number; farmCeiling: number }
  /** Cancel every timer; resolves when no build is running. */
  stop(): Promise<void>
}

export function createAlwaysOn(deps: AlwaysOnDeps): AlwaysOn
```

Behaviour, in order:

1. `deviceOnline(id)`: if a record exists for `id` in `queued`/`preparing`/`ready`, no-op. Otherwise create `{ state: 'queued', attempt: 0, failures: 0, activityId: activities.start(id, { kind: 'prep', label: PREP_QUEUED_LABEL, actor }) }`, then `pump()`.
2. `pump()`: if not started, return. Refresh the USB root cache when older than `USB_ROOT_CACHE_MS` (one `listDevices()` per refresh; on rejection every root reads `UNKNOWN_ROOT` for this pass and the failure is logged at `debug`). Sort `queued` by `(deviceNumber ?? Infinity, deviceId)`. For each candidate: if `running.size >= farmCeiling()` stop; if the candidate's root is not `UNKNOWN_ROOT` and `runningPerRoot(root) >= buildsPerUsbRoot()` skip it; else move it to `preparing` and call `runBuild(id)`.
3. `runBuild(id)`: `await deps.sessions.build(id, { requireScrcpy: record.failures < SCRCPY_FALLBACK_AFTER_FAILURES, onStep: (step) => { record.step = step; activities.update(id, record.activityId, { label: prepLabel(step) }); if (step === 5) onFirstFrame(id) } })`. On resolve, nothing more (step 5 arrives through `onStep`). On reject: `record.failures++`, `record.attempt++`, `scheduleRebuild(id, err)`. In `finally`: remove from `running`, `pump()`.
4. `onFirstFrame(id)`: `record.state = 'ready'`, `record.failures = 0`, `record.attempt = 0`, `activities.end(id, record.activityId)`, then `timers.set(() => { const s = deps.sessions.get(id); if (s && record.state === 'ready') void s.prewarmInspector().catch(...) }, INSPECTOR_PREWARM_DELAY_MS)`.
5. `sessionEnded(id, reason)`: if `record.state !== 'ready'` return (a build that fails reports through `runBuild`'s reject, not twice). `record.attempt++`, `scheduleRebuild(id, reason)`.
6. `scheduleRebuild(id, why)`: `record.state = 'recovering'`; `const delay = rebuildDelayMs(record.attempt)`; if the record has no live activity, `activities.start` a new `prep` one; `activities.update(id, activityId, { label: recoveringLabel(record.attempt), meta: { recovering: true, attempt: record.attempt, nextRetryAt: now + delay, reason: String(why) } })`; `record.timer = timers.set(() => { record.state = 'queued'; activities.update(id, activityId, { label: PREP_QUEUED_LABEL, meta: { recovering: true, attempt: record.attempt } }); pump() }, delay)`.
7. `deviceOffline(id)`: clear the record's timer, `activities.end` its activity if live, delete the record. It does not call `closeDevice` (the registry's `onDeviceGone` already does, `daemon.ts:4318`).
8. `stop()`: clear every timer, mark stopped, await `Promise.allSettled` of the running builds.

The module never calls `acquire`, never touches a viewer, never reads settings itself (accessors only), and holds no adb client (only `listDevices`).

### 4.3 `SessionManager` after this plan

```ts
export type FrameSink = (chunk: Uint8Array, meta: FrameMeta) => void
export type SessionState = 'none' | 'building' | 'ready'

export interface ViewerAttach {
  /** The session the viewer is receiving frames from RIGHT NOW. */
  session: DeviceSession
  /** The quality of `session`. */
  quality: Quality
  /** Set when a `control` request is being served by the wall entry while the control entry starts. */
  substitute?: 'wall'
  /** Set when a `control` request cannot ever get a control entry on this device (display engine is not scrcpy). */
  degradedReason?: 'control_encoder_unavailable'
  degradedDetail?: string
}

export interface ViewerHooks {
  /** The control entry produced its first keyframe and this viewer now receives its frames. */
  onSwitched?: (session: DeviceSession) => void
  /** The control build failed after `substitute: 'wall'` was reported; the viewer stays on the wall entry. */
  onControlFailed?: (reason: string) => void
}

export interface SessionManager {
  /**
   * Attach a frame subscriber to the device's BASE (wall) entry. Never builds.
   * Awaits an in-flight base build (`whenReady`); throws `SessionError('device_not_ready')`
   * when there is none. Jobs, the readiness manager, and the capability path use this.
   */
  acquire(deviceId: string, onFrame: FrameSink): Promise<DeviceSession>
  release(deviceId: string, onFrame: FrameSink): void
  /** Viewer attach (ws-handlers only). Throws `device_not_ready` with `details: { state }` when there is no base entry. */
  attachViewer(deviceId: string, quality: Quality, onFrame: FrameSink, hooks?: ViewerHooks): Promise<ViewerAttach>
  detachViewer(onFrame: FrameSink): void
  /** Build the base entry. Called by the always-on builder (and the node's `startSession`); coalesced per device. */
  build(deviceId: string, opts: { requireScrcpy: boolean; onStep?: (step: PrepStep) => void }): Promise<void>
  /** Resolves with the base session once a build in flight finishes; rejects `device_not_ready` when none is in flight and none exists. */
  whenReady(deviceId: string, timeoutMs?: number): Promise<DeviceSession>
  state(deviceId: string): SessionState
  get(deviceId: string): DeviceSession | null           // base entry, else control entry, else null (unchanged resolution for input callers)
  getByQuality(deviceId: string, quality: Quality): DeviceSession | null
  closeDevice(deviceId: string): Promise<void>
  closeAll(reason?: string): Promise<number>
  restartAt?(deviceId: string, quality: Quality, detail?: string): Promise<void>
  setRotation?(deviceId: string, mode: RotationMode): Promise<RotationOutcome | null>
  reprofile?(reason: string): Promise<{ restarted: string[]; skippedBusy: string[]; unchanged: number }>
  activeDeviceIds?(): string[]
  /** Encoder states per device, for `GET /api/video/sessions` and `/api/adb/stats`. */
  encoders(): EncoderReport[]
}

export interface EncoderState {
  engine: 'scrcpy' | 'screencap-loop'
  maxSize: number
  maxFps: number
  bitRate: number
  viewers: number
  bytesPerSec: number
  framesPerSec: number
  sinceSec: number
  /** Unix seconds when the control linger closes the entry; null while it has viewers, and always null for `wall`. */
  lingerEndsAt: number | null
}
export interface EncoderReport { deviceId: string; wall: EncoderState | null; control: EncoderState | null }
```

Deleted from the interface and the implementation: `closeIfIdle`, `idleSessions`, `videoStats`, `SessionManagerDeps.idleTtlSec`, `.maxIdleSessions`, `.maxConcurrentBuilds`, `createBuildLane`, `enforceIdleCap`, `Entry.closeTimer`/`idleSince` (a `lingerTimer` exists on the control entry only), `DEFAULT_IDLE_TTL_SEC`. `Entry` gains `viewers: Set<FrameSink>` (viewer sinks, distinct from `frameSubscribers` which also holds job/readiness sinks), `pendingSwitch: Map<FrameSink, ViewerHooks>` (control entry only), `live: boolean` (control entry: first IDR cached), `rate: RateMeter`.

`RateMeter`: a 5 s sliding window of `(bytes, frames)` samples updated in `dispatchFrame`; `bytesPerSec()`/`framesPerSec()` read it. Pure, in `manager.ts`, exported for the test.

`build(deviceId, opts)`: coalesced through the existing `inFlight` map keyed `entryKey(deviceId, 'wall')`; runs `createEntry(deviceId, 'wall', undefined, { requireScrcpy: opts.requireScrcpy }, opts.onStep)`. `createEntry` maps `onPhase` to steps (`connecting` 1, `waking` 2, `starting-video` 3, `waiting-frame` 4, `ready` 5) and still forwards `deps.onPhase` for the device event log. A second `build` while one is in flight joins it. A `build` on a device that already has a base entry resolves immediately.

`attachViewer(deviceId, 'wall', onFrame)`: base entry must exist, else throw `SessionError('device_not_ready', ..., { state: this.state(deviceId) })`; attach; return `{ session, quality: 'wall' }`.

`attachViewer(deviceId, 'control', onFrame, hooks)`:
1. Base entry must exist (same throw).
2. If the base session's `displayEngineId !== 'scrcpy'` or the device row's `display === 'screencap-loop'`: attach to the base entry; return `{ session: base, quality: 'wall', degradedReason: 'control_encoder_unavailable', degradedDetail }`.
3. If a control entry exists and `live`: attach to it; cancel its linger; return `{ session: control, quality: 'control' }`.
4. Otherwise attach to the base entry, record `pendingSwitch.set(onFrame, hooks)` on the (existing or to-be-created) control record, ensure a control build is in flight (`createEntry(deviceId, 'control', undefined, { skipDevicePrep: true, requireScrcpy: true })`, coalesced), and return `{ session: base, quality: 'wall', substitute: 'wall' }`. When the control build rejects: for every pending sink call `hooks.onControlFailed(reason)`, clear `pendingSwitch`; the sinks stay on the base entry. When the control entry's `dispatchFrame` sees `meta.keyframe && entry.session.videoKeyframe?.()` non-null for the first time: set `live = true`; for every pending sink: remove it from the base entry's subscriber sets, add it to the control entry's, update `subscriberEntry`, call `hooks.onSwitched(controlSession)`; then dispatch the frame to the control entry's subscribers (the switched sink receives this very keyframe first).

`detachViewer(onFrame)`: find the entry through `subscriberEntry`; remove from `viewers`, `frameSubscribers`, and any `pendingSwitch`; if the entry is the control entry and `viewers.size === 0` and `pendingSwitch.size === 0`: arm `lingerTimer = setTimeout(() => closeEntry(controlKey, 'control_linger'), CONTROL_LINGER_MS)`; a later attach clears it. Base entries never arm anything.

`closeDevice(deviceId)`: closes both entries (unchanged). `restartAt`/`reprofile`: unchanged in mechanism; `restartAt` for the `wall` slot rebuilds with `requireScrcpy: true`; no build lane, so `reprofile` awaits its restarts directly.

`onDisplayError` (`manager.ts:584-600`): unchanged, except that closing the base entry also closes the control entry (a control entry without its base has no device prep owner), and `deps.onSessionEnded(deviceId, reason)` is called only for the base entry's death; a control entry's death calls `onControlFailed` for pending sinks and reattaches its live viewers to the base entry (they keep a picture) with `hooks`-less `onSwitched` not fired; ws-handlers learns through `detachViewer`'s absence of change and the next `stream.meta` from the base entry's frame size.

### 4.4 `DeviceSession` and `createSession`

```ts
export interface DeviceSession {
  // ... unchanged fields ...
  /**
   * Start the inspector in the background once the session has a picture (MVP 02 §2.1).
   * This plan: resolves immediately and starts nothing (plan 208 implements it).
   * Called by the always-on builder INSPECTOR_PREWARM_DELAY_MS after the first frame, once.
   */
  prewarmInspector(): Promise<void>
}
```

`session.ts` changes:

- `prewarmInspector: async () => {}` on the session object, right after `whenInspectorReady: startInspector,` (`:855`), with a comment naming plan 208.
- `requireScrcpy` applies to every build, not only the fast path: the bail-out at `:707` keeps its condition (`opts.requireScrcpy && opts.display !== 'screencap-loop' && !scrcpy`) and throws `SessionError('E_SCRCPY_UNAVAILABLE', scrcpyFailureReason ?? 'scrcpy-server could not be started on this device')`. The `log.warn` at `:694` becomes `log.info` and reads `scrcpy cannot be used (${reason}); this build ${opts.requireScrcpy ? 'fails' : 'falls back to screencap-loop + adb-input'}`.
- `errors.ts:29`: `'E_CONTROL_SESSION_UNAVAILABLE'` → `'E_SCRCPY_UNAVAILABLE'` with a rewritten comment (two callers: the base build under the always-on builder, the control build under `attachViewer`).

### 4.5 Protocol

`packages/protocol/src/messages/stream.ts` (Zod 4, the file's own style):

```ts
export const StreamStartedMessage = z.object({
  type: z.literal('stream.started'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    streamId: z.number().int().min(0).max(255),
    codec: z.enum(['png', 'h264']),
    width: z.number(),
    height: z.number(),
    /** The quality this viewer is receiving RIGHT NOW. `wall` for a `control` request while `substitute` is set. */
    quality: QualitySchema,
    /**
     * MVP 11 §1.2: a `control` request is served by the always-on wall encoder until the
     * control encoder's first keyframe; the switch is announced by `stream.meta` carrying
     * `quality: 'control'`. Absent for a `wall` request and once the switch has happened.
     */
    substitute: z.literal('wall').optional(),
    /** The device cannot run a second scrcpy encoder (its display engine is not scrcpy); the viewer stays on `wall`. */
    degradedReason: z.literal('control_encoder_unavailable').optional(),
    degradedDetail: z.string().optional(),
  }),
})

/** Rotation, resize, or the encoder switch (MVP 11 §1.2): `quality` is set only on a switch. */
export const StreamMetaMessage = z.object({
  type: z.literal('stream.meta'),
  payload: z.object({
    streamId: z.number().int(),
    width: z.number(),
    height: z.number(),
    quality: QualitySchema.optional(),
    /** Set with `quality: 'wall'` when the control encoder failed after `substitute` was reported. */
    detail: z.string().optional(),
  }),
})

/** Phases of one session build, in order (§3.3). Internal to `@enkaku/session`; no message carries it. */
export const SessionPhaseSchema = z.enum(['connecting', 'waking', 'starting-video', 'waiting-frame', 'ready'])
export type SessionPhase = z.infer<typeof SessionPhaseSchema>
```

Deleted: `SessionProgressMessage`, `SessionProgress` (from `stream.ts`, `index.ts:455,458`, and `ServerMessageSchema` at `index.ts:1018`). `StreamStartMessage`, `StreamStopMessage`, `StreamKeyframeMessage`, `StreamEndedMessage`: unchanged.

New WS error code sent by `stream.start`: `E_SESSION_PREPARING` (payload `message` is the activity sentence, or `Preparing` when the builder has no step yet). `device_offline` is the existing code for an offline row.

`packages/protocol/src/api/video.ts`:

```ts
export const EncoderStateSchema = z.object({
  engine: z.enum(['scrcpy', 'screencap-loop']),
  maxSize: z.number().int(),
  maxFps: z.number().int(),
  bitRate: z.number().int(),
  viewers: z.number().int().min(0),
  bytesPerSec: z.number().min(0),
  framesPerSec: z.number().min(0),
  sinceSec: z.number().int(),
  lingerEndsAt: z.number().int().nullable(),
})
export const VideoSessionsResponseSchema = z.object({
  devices: z.array(
    z.object({
      deviceId: z.string(),
      number: z.number().int().nullable(),
      state: z.enum(['none', 'queued', 'preparing', 'ready', 'recovering']),
      step: z.number().int().min(1).max(5).nullable(),
      attempt: z.number().int().min(0),
      usbRoot: z.string().nullable(),
      wall: EncoderStateSchema.nullable(),
      control: EncoderStateSchema.nullable(),
    }),
  ),
  builder: z.object({
    running: z.number().int().min(0),
    queued: z.number().int().min(0),
    perRoot: z.record(z.string(), z.object({ running: z.number().int().min(0), queued: z.number().int().min(0) })),
    buildsPerUsbRoot: z.number().int().min(1),
    farmCeiling: z.number().int().min(1),
  }),
  /** `process.memoryUsage().rss` at answer time, so a warm-up run can print the cost of N always-on sessions. */
  rssBytes: z.number().int().min(0),
})
export type VideoSessionsResponse = z.infer<typeof VideoSessionsResponseSchema>
```

`packages/protocol/src/api/adb.ts`: delete `idleSessions` (`:70`); in `video` (`:188-210`) replace `maxConcurrentBuilds: z.number().int()` with `buildsPerUsbRoot: z.number().int()` and `farmCeiling: z.number().int()`; keep the rest.

`packages/protocol/src/settings.ts` session block (`:2004-2046`) becomes:

```ts
  /**
   * Session builds (MVP 11 §1.4). A session is built when a device comes online and lives
   * as long as the device is online; the only knob is how many builds may run at once per
   * USB root hub. The farm-wide ceiling is a constant (`SESSION_BUILD_FARM_CEILING`, 16).
   */
  session: z
    .object({
      buildsPerUsbRoot: z
        .number()
        .int()
        .min(1)
        .max(16)
        .default(4)
        .describe('How many device sessions may be starting at the same time on one USB root hub. Raise if a cold start of many devices is too slow; lower if it saturates USB.')
        .meta(ui({ title: 'Session builds per USB root', kind: 'count' })),
    })
    .default({ buildsPerUsbRoot: 4 })
    .meta({
      title: 'Device sessions',
      description: 'How many device sessions may be starting at once on one USB root hub. Sessions themselves are always on.',
    }),
```

`normaliseLegacy*` preprocess functions are not touched. A stored `session` object with the three old keys parses because Zod strips unknown keys; nothing rewrites the row.

### 4.6 Routes

| Method | Path | Permission | Body | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/video/sessions` | `device.view` | none | `200` `VideoSessionsResponseSchema` | `501 E_NOT_SUPPORTED` when `sessions()` or `alwaysOn()` is null (orchestrator, or adb not up) |
| POST | `/api/video/reprofile` | `settings.manage` | none | unchanged | unchanged |

`createVideoRoutes` deps become `{ sessions: () => Pick<SessionManager, 'reprofile' | 'encoders'> | null; alwaysOn: () => Pick<AlwaysOn, 'stateOf' | 'stats'> | null; deviceIds: () => Array<{ deviceId: string; number: number | null }> }`. The route joins `deviceIds()` (every `devices` row, `loadDeviceNumbers` for the numbers, no N+1) with `sessions().encoders()` and `alwaysOn().stateOf(id)`.

### 4.7 Migration `0065_desired_awake`

Data only, no schema change (`devices.desired_readiness` exists, `schema.ts:55`). Generate the file and its journal entry with `bun run --cwd packages/core db:generate -- --custom --name desired_awake` (drizzle-kit's custom migration: an empty SQL file plus a journal row with a real `when`), then fill the SQL:

```sql
-- MVP 11 §1.1: desired readiness is `awake` by default for every device, old and new.
-- 0064 fixed `prep.keepAwake`; it did not touch this column. NULL predates readiness;
-- 'asleep' was the materialised default on every farm older than plan 125 §3.1 and
-- no surface ever distinguished a chosen 'asleep' from that default. An operator who
-- wants a device asleep sets it again (the same rule 0064 and normaliseLegacyWall apply).
UPDATE `devices` SET `desired_readiness` = 'awake'
WHERE `desired_readiness` IS NULL OR `desired_readiness` = 'asleep';
--> statement-breakpoint
UPDATE `farm_settings`
SET `value` = json_set(`value`, '$.readiness.defaultDesired', 'awake')
WHERE json_valid(`value`) AND json_extract(`value`, '$.readiness.defaultDesired') = 'asleep';
```

If the pinned drizzle-kit does not accept `--custom` (§9 Q4), follow `0064`'s precedent exactly: create `0065_desired_awake.sql` by hand and append a journal entry `{ "idx": 65, "version": "6", "when": <Date.now() at authoring>, "tag": "0065_desired_awake", "breakpoints": true }`, never a round synthetic `when` (`migration-watermark.test.ts:7-16` explains the poisoned-watermark incident).

### 4.8 `ws-handlers.ts` sequences

`stream.start`:

```
1. build StreamBinding (no readinessHold field any more)
2. if remote device: unchanged remote path
3. else if deps.sessions:
     try attach = await deps.sessions.attachViewer(deviceId, requestedQuality, binding.onFrame, {
           onSwitched: (control) => {
             binding.quality = 'control'
             binding.lastSize = control.frameSize
             send(ws, { type: 'stream.meta', payload: { streamId, width, height, quality: 'control' } })
             prime(control)             // config then keyframe, encodeVideoFrame with the primer meta (:1080-1092), no requestKeyframe
           },
           onControlFailed: (reason) => send(ws, { type: 'stream.meta', payload: { streamId, ...binding.lastSize, quality: 'wall', detail: reason } }),
         })
     catch SessionError code device_not_ready:
         row offline → sendError(ws, 'device_offline', ..., msg.id)
         else → sendError(ws, 'E_SESSION_PREPARING', <sentence from deps.alwaysOn?.stateOf(deviceId)>, msg.id); return
     binding.quality = attach.quality; localSession = attach.session
4. state.streams.set; broadcastViewers
5. send stream.started { ..., quality: attach.quality, substitute?, degradedReason?, degradedDetail? }
6. prime(localSession) exactly as today (:1088-1105), including the RESET_VIDEO gate on a cached keyframe
```

`stream.stop` and `handleClose`: `deps.sessions?.detachViewer(binding.onFrame)` replaces `release(...)`; the `readinessHold` lines are deleted.

`binding.onFrame` (`:924-973`): after `const encoded = encodeVideoFrame(...)`, `const sent = ws.send(encoded)`; `if (sent === 0 && meta.codec !== 'png' && !binding.awaitingKeyframe) { binding.awaitingKeyframe = true; sessionForBinding(binding)?.requestKeyframe?.() }` (R8: `0` means dropped). Add `handleDrain(ws)` to the handler object: `for (const b of stateOf(ws).streams.values()) if (b.awaitingKeyframe) sessionForBinding(b)?.requestKeyframe?.()`. Export `BACKPRESSURE_LIMIT_BYTES = 4 * MAX_BUFFERED` beside `MAX_BUFFERED` (`:73`).

`WsHandlerDeps` gains `alwaysOn?: Pick<AlwaysOn, 'stateOf'>` (for the `E_SESSION_PREPARING` sentence) and loses nothing else; `readiness?: Pick<ReadinessManager, 'hold' | 'set'>` (`:365`) becomes `Pick<ReadinessManager, 'set'>` once the viewer hold is gone (leave `hold` in the Pick if any other handler in the file still calls it; grep before narrowing).

### 4.9 `LiveView.tsx`, the minimal change

Delete: `WAKE_OFFER_AFTER_SEC` (`:43`), `SLOW_PHASE_AFTER_SEC` (`:47`), `PHASE_STEPS`/`PHASE_HEADLINE`/`PHASE_COMPACT_LABEL` (`:133-158`), `phase`/`phaseDetail` state and `phaseChangedAtRef` (`:359-371`), the `session.progress` branch (`:468-471`), the `autoReconnect && sec >= WAKE_OFFER_AFTER_SEC` block (`:815-821`) and the `autoReconnect` dependency it served if nothing else reads it, the `wakeDevice` const (`:826-829`) if its only use was the offer, `showWakePanel`/`phaseElapsedSec` (`:944-945`), the wake offer (`:1015-1024`, keep the `no new frames for {staleSec}s` tooltip at `:1002-1014`), the panel (`:1230-1274`), and `!showWakePanel` in the provisioning guard (`:1287`).

Add: `const PREPARING_RETRY_MS = 3_000`; state `const [noFrames, setNoFrames] = useState<string | null>(null)`. In `startStream`'s `catch`: if the error's `code` is `E_SESSION_PREPARING` or `device_offline`, `setNoFrames(err.message)` and arm one `setTimeout(startStream, PREPARING_RETRY_MS)` (cleared on dispose) instead of `setError`. On `stream.started`: `setNoFrames(null)`. Render, in place of the panel, only while `noFrames !== null && !painted && !stopped`:

```tsx
<div className="absolute inset-0 flex items-center justify-center bg-bg/95 px-2 text-center">
  <p className={compact ? 'text-[11px] text-fg-muted' : 'text-[13px] text-fg-muted'}>{noFrames}</p>
</div>
```

`stream.started.substitute`: no UI in this plan (plan 215 adds the sharpness readout); `setControlUnavailable` at `:452` compares against `'control_encoder_unavailable'`. `stream.meta` with `quality` is handled by the existing size update (`:466-467`); nothing else reads it yet.

Handoff measurement quoted for the tile text (`README.md`, Screens view): "Center text **only when not live**: "Disconnected" or "Unauthorized" (11px; unauthorized in `var(--warn)`)." The compact sentence is 11px for that reason.

### 4.10 `daemon.ts` wiring

```ts
// after `sessions = createSessionManager({...})` (:3859)
alwaysOn = createAlwaysOn({
  sessions,
  devices: deviceSource,
  listDevices: () => adb.listDevices(),
  deviceNumber: (deviceId) => { const row = deviceSource.get(deviceId); return row ? lookupDeviceNumber(db, row.stableId) : null },
  activities: activityPort,            // plan 205's registry adapter, or `noopActivityPort` (§9 Q1)
  buildsPerUsbRoot: () => settingsStore.get().session.buildsPerUsbRoot,
  farmCeiling: () => Number(process.env.ENKAKU_SESSION_BUILD_CEILING ?? SESSION_BUILD_FARM_CEILING),
  log: log.child('always-on'),
})
```

- `createSessionManager` deps: delete `idleTtlSec`, `maxIdleSessions` (`:3904-3905`), `maxConcurrentBuilds` (`:3913`); `onSessionEnded: (deviceId, reason) => { hub.broadcast({ type: 'stream.ended', ... }); alwaysOn?.sessionEnded(deviceId, reason) }`; `onPhase` (`:3885-3886`) deleted (no `session.progress`); the `recorder.record` for `session.opened`/`session.closed` stays.
- `onDeviceReady` (`:4355`): first line `alwaysOn?.deviceOnline(deviceId)`. `onDeviceGone` (`:4317`): first line `alwaysOn?.deviceOffline(deviceId)`, then the existing `void sessions?.closeDevice(deviceId)`.
- After `await registry.start()` (`:4406`): `alwaysOn?.start()`.
- Shutdown path (where `sessions.closeAll('shutdown')` is awaited): `await alwaysOn?.stop()` first.
- Delete `closeIfIdle` calls at `:1169` and `:1966`.
- `websocket` options (`:3395`): add `backpressureLimit: BACKPRESSURE_LIMIT_BYTES, closeOnBackpressureLimit: false, drain: (ws) => wsHandler.handleDrain(ws)` beside the existing `open`/`message`/`close` handlers.
- `adbStatsRoutes` `video` accessor (`:3102-3118`): `maxConcurrentBuilds` → `buildsPerUsbRoot: settingsStore.get().session.buildsPerUsbRoot, farmCeiling: <same expression as above>`.
- `videoRoutes` (`:3124`): `createVideoRoutes({ sessions: () => sessions, alwaysOn: () => alwaysOn, deviceIds: () => ... })`.
- `let alwaysOn: AlwaysOn | null = null` beside `let sessions` (`:339`).

### 4.11 Readiness

- `readiness.ts:153` and `:225`: `?? 'awake'`.
- `ReadinessManagerDeps` gains `activities?: ActivityPort`. In `ensureAwake` (`:349`), wrap the `wakeDevice` call (`:366-371`): `const id = deps.activities?.start(deviceId, { kind: 'wake', label: 'Waking the screen', actor: ALWAYS_ON_ACTOR })`; `finally { if (id) deps.activities?.end(deviceId, id) }`.
- `:448`: `await sessions.acquire(deviceId, sink)` (two arguments).
- Nothing else changes; `hold` stays for transfer/install callers.

### 4.12 `scripts/bench-device-nfrs.ts --warmup`

New flags: `--warmup` (mode switch; skips every existing stage), `--expect <N>` (default: the count of `adb devices` rows in state `device`), `--timeout-sec <N>` (default 120), `--core-port <N>` (default 7710), `--data-dir` (existing). Sequence:

1. `t0 = performance.now()`; spawn `Bun.spawn(['bun', 'run', join(ROOT, 'packages/core/src/index.ts')], { env: { ...process.env, ENKAKU_DATA_DIR: dataDir, ENKAKU_PORT: String(corePort), ENKAKU_NO_OPEN: '1' }, stdout: 'pipe', stderr: 'pipe' })`.
2. Poll `GET http://127.0.0.1:${corePort}/api/health` every 250 ms until `200`.
3. Poll `GET /api/video/sessions` every 500 ms; `ready = devices.filter(d => d.state === 'ready').length`; stop when `ready >= expect` or the timeout elapses.
4. Print exactly `warm: ${ready}/${expect} in ${((performance.now() - t0) / 1000).toFixed(1)} s` (append ` (timeout)` when the timeout hit), then `rss: ${(rssBytes / 1048576).toFixed(0)} MB for ${ready} sessions`, then one line per device: `#${number} ${state}${step ? ` step ${step}` : ''}${attempt ? ` attempt ${attempt}` : ''}`.
5. `proc.kill()`, await `proc.exited`, exit `0` when `ready === expect`, else `1`.

The `ENKAKU_TEST_DEVICE=1` gate (`:146`) stays in front of this mode.

### 4.13 Cost accounting, per always-on device (host side)

| Item | Where | Expected |
|---|---|---|
| adb forward | one per encoder | 1 (wall), 2 while control runs |
| sockets | video + control per encoder | 2 (wall), 4 while control runs |
| demuxer pending buffer | `packages/scrcpy/src/demuxer.ts` | ≤ one access unit, ≤ ~200 KB at 480 px (plan 209 replaces the copy with a ring buffer) |
| cached config + IDR | `ScrcpyDisplay.lastConfig`/`lastKeyframe` | ≤ ~100 KB at 480 px |
| host CPU, idle phone | demuxer copy only, no decode | negligible (scrcpy sends nothing while the display is static) |
| host CPU, animating phone | ≤ 1.1 Mbit/s copy per device | well under 1 % of a core per device |
| RSS per session | measured by `--warmup`'s `rss:` line | to record in MVP 09 §7 after the owner's run |

## 5. Implementation steps

### 206.1 Protocol: stream messages, video sessions schema, settings block

- Files changed: `packages/protocol/src/messages/stream.ts`, `packages/protocol/src/index.ts`, `packages/protocol/src/api/video.ts`, `packages/protocol/src/api/adb.ts`, `packages/protocol/src/settings.ts`, `packages/protocol/src/settings.test.ts`, `packages/protocol/src/api/adb.test.ts`, `packages/protocol/src/api/video.test.ts`
- Files created: `packages/protocol/src/messages/stream.test.ts`
- Files deleted: none
- Test file: `packages/protocol/src/messages/stream.test.ts` (asserts: `stream.started` accepts `substitute: 'wall'` and rejects `substitute: 'control'`; `stream.meta` accepts `quality`; `SessionProgressMessage` is not exported from `@enkaku/protocol`), `packages/protocol/src/settings.test.ts` (the `session` default is `{ buildsPerUsbRoot: 4 }`; a stored `{ idleTtlSec: 300, maxIdleSessions: 8, maxConcurrentBuilds: 2 }` parses to that default), `packages/protocol/src/api/video.test.ts` (a sample `VideoSessionsResponse` parses)
- Verifiable result: `bun test packages/protocol/src/messages/stream.test.ts packages/protocol/src/settings.test.ts packages/protocol/src/api/` green; `rg -n "SessionProgressMessage|session\.progress" packages/protocol/src` empty
- Do not: keep `SessionProgressMessage` "for the node"; the node never sent it. Do not add a `stream.substitute` message type; the switch rides on `stream.meta`.

### 206.2 Session package: errors, `prewarmInspector`, `requireScrcpy` on every build

- Files changed: `packages/session/src/errors.ts`, `packages/session/src/session.ts`, `packages/session/src/session.test.ts`, `packages/session/src/index.ts`
- Test file: `packages/session/src/session.test.ts` (new tests: `prewarmInspector resolves and starts nothing`; `requireScrcpy without skipDevicePrep throws E_SCRCPY_UNAVAILABLE and reverts stayon/rotation/tag`; `display: 'screencap-loop' with requireScrcpy still opens the screencap loop`)
- Verifiable result: `bun test packages/session/src/session.test.ts` green; `rg -n "E_CONTROL_SESSION_UNAVAILABLE" packages` empty
- Do not: make `prewarmInspector` call `whenInspectorReady()` (that is the eager start MVP 02 §2.1 measured; plan 208 owns the body).

### 206.3 Session manager: build, attachViewer, encoder split, rates; delete the idle model

- Files changed: `packages/session/src/manager.ts`, `packages/session/src/manager.test.ts`, `packages/session/src/index.ts`
- Test file: `packages/session/src/manager.test.ts`. Rewrite the tests that assert the idle TTL, the idle cap, the build lane and `acquire`-builds; add: `acquire never builds: no base entry means device_not_ready`; `acquire awaits a build in flight`; `build is coalesced per device`; `build maps phases to steps 1..5 in order`; `encoder split: a device never holds more than two entries`; `control attach before the base entry exists throws device_not_ready with state`; `control attach returns substitute wall and switches on the first cached keyframe`; `control attach on a screencap-loop device reports control_encoder_unavailable`; `encoder split: the control entry closes 15 s after the last control viewer detaches` (inject `timers`); `a job sink on the base entry survives a control switch`; `RateMeter reports bytes and frames per second over a 5 s window`; `closing the base entry closes the control entry and reports onSessionEnded once`
- Verifiable result: `bun test packages/session/src/manager.test.ts` green; `rg -n "idleTtlSec|maxIdleSessions|maxConcurrentBuilds|closeIfIdle|idleSessions|createBuildLane|enforceIdleCap" packages/session/src` empty
- Do not: keep `acquire(deviceId, onFrame, quality)`'s third parameter "for compatibility"; delete it and fix every caller in 136.5. Do not keep the idle TTL at `0` "in case"; the timer and its fields go.

### 206.4 `always-on.ts`

- Files created: `packages/session/src/always-on.ts`, `packages/session/src/always-on.test.ts`
- Files changed: `packages/session/src/index.ts` (export `createAlwaysOn`, `noopActivityPort`, `ALWAYS_ON_ACTOR`, `usbRootOf`, `rebuildDelayMs`, `prepLabel`, `recoveringLabel`, the constants, and the types)
- Test file: `packages/session/src/always-on.test.ts` with a fake `sessions` (`build` resolves after a controllable promise and calls `onStep` 1..5 on demand), a fake `listDevices` returning `usb` fields, injected `timers`, and a recording `ActivityPort`. Tests: `deviceOnline enqueues exactly one build`; `stagger: at most buildsPerUsbRoot builds per root run at once`; `stagger: the farm ceiling bounds the sum across roots`; `stagger: pending builds start in device-number order`; `a queued device carries the Preparing, queued label`; `steps update the label Preparing, step n of 5 and step 5 ends the activity`; `scrcpy death: rebuild after 1 s, 3 s, 10 s, 30 s, 30 s with a recovering meta`; `a build that reaches step 5 resets the attempt counter`; `the fifth consecutive failure builds without requireScrcpy`; `deviceOffline cancels the timer and ends the activity`; `inspector prewarm is called 2 s after the first frame, never before`; `calls before start() are queued and run at start()`; `usbRootOf: 3-1.4.3 is 3, undefined is network`; `a listDevices rejection groups every device under unknown and still builds`
- Verifiable result: `bun test packages/session/src/always-on.test.ts` green
- Do not: read `adb devices` per build (one cached listing per pump); do not call `closeDevice` from `deviceOffline`; do not start the control encoder here.

### 206.5 Core call sites: capability path, node, readiness

- Files changed: `packages/core/src/capability/context.ts` (`:503`, `const session = await sessions.acquire(deviceId, onFrame, quality)` → `await sessions.acquire(deviceId, onFrame)`; delete the `quality` variable if it has no other reader), `packages/node/src/hosts.ts` (`:219` `startSession`: insert `await sessions.build(deviceId, { requireScrcpy: false })` before `:222`'s `acquire`; `createSessionManager` at `:66` loses any of the three deleted accessors it passes), `packages/core/src/device/readiness.ts` (§4.11), `packages/core/src/device/readiness.test.ts` (fixture `fakeSessionManager()` drops `closeIfIdle`/`idleSessions`, adds `attachViewer`/`detachViewer`/`build`/`whenReady`/`state`/`encoders` stubs; new test `ensureAwake starts and ends a wake activity`; the NULL-fallback test asserts `awake`)
- Test file: `packages/core/src/device/readiness.test.ts`
- Verifiable result: `bun test packages/core/src/device/readiness.test.ts` green; `bun run typecheck` clean for `packages/core`, `packages/node`
- Do not: give the node its own always-on builder in this plan (cloud is post-MVP); `build()` before `acquire()` is the whole change.

### 206.6 Migration 0065 and the readiness fallbacks

- Files created: `packages/core/drizzle/0065_desired_awake.sql`, `packages/core/src/db/desired-awake-migration.test.ts`
- Files changed: `packages/core/drizzle/meta/_journal.json` (generated by `bun run --cwd packages/core db:generate -- --custom --name desired_awake`; see §4.7 for the fallback), `packages/core/src/device/readiness.ts:153,225`
- Test file: `packages/core/src/db/desired-awake-migration.test.ts`, modelled on `awake-migration.test.ts`: migrate to `0064`, insert rows with `desired_readiness` NULL, `'asleep'`, `'hot'`, and a `farm_settings` value with `readiness.defaultDesired: 'asleep'`, run the remainder, assert `'awake'`, `'awake'`, `'hot'`, and `'awake'`
- Verifiable result: `bun test packages/core/src/db/desired-awake-migration.test.ts packages/core/src/db/migration-watermark.test.ts` green
- Do not: hand-write the migration with a synthetic `when`; do not touch `'hot'` rows.

### 206.7 `ws-handlers.ts`: viewer attach, substitute, drain

- Files changed: `packages/core/src/server/ws-handlers.ts` (§4.8), `packages/core/src/server/ws-handlers-video.test.ts` (fixture `fakeSessionManager` gains `attachViewer`/`detachViewer`/`build`/`whenReady`/`state`/`encoders`; `fakeConn` gains a settable `sendReturn` and a `drain` trigger)
- Test file: `packages/core/src/server/ws-handlers-video.test.ts`. Keep the three RESET_VIDEO gate tests. Add: `control attach: started carries substitute wall and primes from the wall entry`; `control attach: the binding switches on the control entry's first keyframe and sends stream.meta`; `control attach: a failed control build sends stream.meta with quality wall and a detail`; `stream.start on a device with no base entry answers E_SESSION_PREPARING with the activity sentence`; `stream.start on an offline row answers device_offline`; `stream.stop detaches the viewer; no readiness hold exists`; `backpressure: a send that returns 0 marks the binding awaiting a keyframe`; `backpressure: drain requests a keyframe for every binding that was waiting`
- Verifiable result: `bun test packages/core/src/server/ws-handlers-video.test.ts` green; `rg -n "readinessHold|E_CONTROL_SESSION_UNAVAILABLE|sessions\.acquire\(.*'wall'\)" packages/core/src/server` empty
- Do not: `await` the control build inside `stream.start`; the reply goes out on the wall entry and the switch is asynchronous. Do not re-add the viewer readiness hold.

### 206.8 `daemon.ts`, `/api/video/sessions`, `/api/adb/stats`

- Files changed: `packages/core/src/daemon.ts` (§4.10), `packages/core/src/api/video.ts` (§4.6), `packages/core/src/api/adb-stats.ts` (delete `:162` and `:195`; `ZERO_VIDEO` and the `video` object use `buildsPerUsbRoot`/`farmCeiling`; `buildsRunning`/`buildQueueDepth` read `alwaysOn().stats()`), `packages/core/src/api/adb-stats.test.ts`, `packages/core/src/server/http.ts` (no route change; `videoRoutes` already mounted at `:447`)
- Files created: `packages/core/src/api/video.test.ts` (Hono app with fake `sessions`/`alwaysOn`/`deviceIds`; `GET /sessions answers the schema with one row per known device`; `GET /sessions answers 501 E_NOT_SUPPORTED with no session manager`)
- Test file: `packages/core/src/api/video.test.ts`, `packages/core/src/api/adb-stats.test.ts`
- Verifiable result: `bun test packages/core/src/api/video.test.ts packages/core/src/api/adb-stats.test.ts` green; `rg -n "closeIfIdle|idleTtlSec|maxIdleSessions|maxConcurrentBuilds|session\.progress|onPhase:" packages/core/src/daemon.ts` empty; `bun run dev` boots, and with one device attached the log shows `session opened: ... at wall` without any browser open
- Do not: build sessions from `readiness.start()`'s boot sweep; the registry's `onDeviceReady` is the one entry point. Do not put `alwaysOn.start()` before `registry.start()`.

### 206.9 Studio: `LiveView.tsx` minimal change and fixtures

- Files changed: `packages/studio/src/components/LiveView.tsx` (§4.9), `packages/studio/src/components/LiveView.test.tsx` (delete the wake-panel and `session.progress` tests; add `a stream.start refused with E_SESSION_PREPARING shows the sentence and retries after 3 s`; `a stream.started with substitute wall paints without any banner`), `packages/studio/src/components/settings/farmSections.ts` (keys stay `['session', 'wall', 'readiness', 'display']`; delete the comment lines `:85-97` that explain `maxIdleSessions`), `packages/studio/src/app/settings/page.test.tsx:167`, `packages/studio/src/components/video/FarmVideoFields.test.tsx:29`, `packages/studio/src/components/video/useAdbVideoStatsPoll.test.ts:32`, `packages/studio/src/components/wall/Wall.test.tsx:186` (fixtures: `maxConcurrentBuilds: 2` → `buildsPerUsbRoot: 4, farmCeiling: 16`), `packages/studio/src/components/wall/useLiveSet.ts:48` and `packages/studio/src/components/wall/Wall.tsx:19` (comments no longer name a deleted setting)
- Test file: `packages/studio/src/components/LiveView.test.tsx`
- Verifiable result: `bun test packages/studio/src/components/LiveView.test.tsx` green (one file, never the Studio suite); `rg -n "Waking|WAKE_OFFER_AFTER_SEC|PHASE_STEPS|PHASE_HEADLINE|PHASE_COMPACT_LABEL|session\.progress|control_session_unavailable" packages/studio/src` empty
- Do not: build the activity strip or the sharpness readout here (plans 214, 215). Do not keep `STALE_AFTER_SEC`'s tooltip wording about "the phone went to sleep" if it now contradicts always-on: change the sentence to `The picture is the last frame received. scrcpy sends nothing while the screen is static or off.`

### 206.10 Bench `--warmup`, `.env.example`, package README

- Files changed: `scripts/bench-device-nfrs.ts` (§4.12; `usage()` lists the four new flags), `.env.example` (a `# ── Support overrides ───` heading with `# ENKAKU_SESSION_BUILD_CEILING=16`), `packages/session/README.md` (a section "Always-on sessions" naming the builder, the stagger, the backoff, the linger, and the five steps; `00-overview.md` §7 item 4)
- Test file: none (the script drives hardware; `bun run scripts/bench-device-nfrs.ts --help` is the mechanical check)
- Verifiable result: `bun run scripts/bench-device-nfrs.ts --help` prints `--warmup`, `--expect`, `--timeout-sec`, `--core-port`; owner: `ENKAKU_TEST_DEVICE=1 bun run bench:device-nfrs -- --warmup --expect 20` prints `warm: 20/20 in S s`
- Do not: measure warm-up from the first `device.activity` message (the shape is plan 205's); `GET /api/video/sessions` is the source of truth.

### 206.11 Removal gate and status

- Files changed: this document (`> Status:` line, §11)
- Verifiable result: every §10 proof command answers as its row says; `bun run typecheck` clean; `bash scripts/check-plan-status.sh` passes
- Do not: write `implemented` while G12, G13, G14 are open; write `implemented (software)`.

## 6. Acceptance criteria

1. G1 to G11 and G15 of §0 pass by their named commands.
2. `bun run dev` with one attached device logs `session opened: <label> (<id>) at wall` and, 2 s after the first frame, nothing else (prewarm is a no-op); no browser was opened.
3. Opening the Screens view against that core paints the tile within one keyframe interval and shows no phase text at any point; `stream.started` carries `quality: 'wall'` and no `substitute`.
4. Opening Device Control on the same device: `stream.started` carries `quality: 'wall', substitute: 'wall'`, a frame is painted before the control encoder starts, then `stream.meta` with `quality: 'control'` arrives and the picture sharpens; closing it and reopening within 15 s reuses the control entry (`GET /api/video/sessions` shows `control.lingerEndsAt` non-null in between).
5. Killing scrcpy-server on the device (`adb shell pkill -f scrcpy`) produces `stream.ended`, then a `prep` activity labelled `Recovering, attempt 1`, then a new `session opened` within 1 s plus build time; a second kill within a minute waits 3 s.
6. Unplugging and replugging the device rebuilds the session with no browser interaction; the tile shows `Preparing, step n of 5` then the picture.
7. `PUT /api/devices/:id/readiness` `{ desired: 'asleep' }` (or the action that replaces it) keeps `GET /api/video/sessions` showing `state: 'ready'` for that device; the tile shows the last frame, not a loading panel.
8. Every §10 proof answers as its row says.
9. `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but the shell after the tests.

## 7. Test plan

Scoped commands only; one invocation at a time; never a suite.

```bash
bun test packages/protocol/src/messages/stream.test.ts
bun test packages/protocol/src/settings.test.ts
bun test packages/protocol/src/api/
bun test packages/session/src/session.test.ts
bun test packages/session/src/manager.test.ts
bun test packages/session/src/always-on.test.ts
bun test packages/core/src/device/readiness.test.ts
bun test packages/core/src/db/desired-awake-migration.test.ts
bun test packages/core/src/db/migration-watermark.test.ts
bun test packages/core/src/server/ws-handlers-video.test.ts
bun test packages/core/src/api/video.test.ts
bun test packages/core/src/api/adb-stats.test.ts
bun test packages/studio/src/components/LiveView.test.tsx
bun run typecheck
```

Manual smoke (one device, the author's machine):

```bash
bun run reset
bun run dev &                                   # note the pid; kill it at the end
sleep 20
curl -s http://127.0.0.1:7700/api/video/sessions | bun -e 'const r = await new Response(Bun.stdin).json(); console.log(r.devices.map(d => `${d.deviceId} ${d.state} step=${d.step} wall=${d.wall?.engine} control=${d.control?.engine}`).join("\n"))'
# expected: one line per attached device, state ready, wall=scrcpy, control=undefined
bun run dev:studio &                            # open http://localhost:3001, Screens view: the tile paints, no phase text
# open Device Control on the device: a picture immediately, sharper within 2 s
curl -s http://127.0.0.1:7700/api/video/sessions | grep -o '"control":{[^}]*}'   # control encoder present with viewers 1
# close Device Control, wait 16 s
curl -s http://127.0.0.1:7700/api/video/sessions | grep -c '"control":null'      # 1
adb shell pkill -f com.genymobile.scrcpy.Server                                   # the core log shows Recovering, attempt 1 then session opened
kill %1 %2; ps -Ao pid=,command= | grep -i "[o]penpf"                              # empty
```

Device-gated (owner, `ENKAKU_TEST_DEVICE=1`, the 20-device farm):

```bash
ENKAKU_TEST_DEVICE=1 bun run bench:device-nfrs -- --warmup --expect 20 --data-dir <farm data dir>
# expected: warm: 20/20 in S s, S ≤ 60; rss: <MB> for 20 sessions
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plan 205 has not landed when this plan executes; the `prep`/`wake` activities have no registry to land in | `ActivityPort` is this plan's seam; `noopActivityPort` is wired and §9 Q1 records the follow-up. The builder, the stagger and the split do not depend on the port. |
| 20 always-on scrcpy servers saturate a USB hub at boot | the per-root stagger (4) and the farm ceiling (16); both measurable in `GET /api/video/sessions.builder`; `buildsPerUsbRoot` is the one knob left |
| `adb devices -l` answers before a freshly plugged device carries `usb:` | the device is grouped `unknown`, bounded by the farm ceiling only, and the next pump re-resolves |
| A control encoder left running when a Device Control closes uncleanly | `handleClose` detaches every binding on the socket; the 15 s linger then closes the entry |
| A wall-quality frame drawn into the Device Control canvas is blurry for up to 2 s | expected and announced (`substitute: 'wall'`); plan 215 shows the sharpness state; never upscale server-side |
| Flipping stored `'asleep'` rows to `'awake'` wakes a device an operator deliberately put to sleep | the same rule 0064 applied; recorded in `00-overview.md` §9 by the executor; Sleep is one action away |
| `ws.send()` return values differ across Bun versions | R8 documents `-1` (enqueued under backpressure) and `0` (dropped); only `0` changes behaviour; the drop-to-keyframe path is unchanged |
| Deleting `session.progress` removes the only narration of a reprofile restart | §2 non-goal; the tile goes dark for one build and repaints; plan 214 may add an activity |
| Always-on sessions on a device with `display: 'screencap-loop'` poll `screencap` forever at 2.5 fps | that is the operator's configuration, unchanged; the builder never chooses it on its own except after four consecutive scrcpy failures, and the heal-back retry still runs |

## 9. Open questions

1. **Plan 205's activity registry API.** This plan defines `ActivityPort` (§4.2). If plan 205 lands first with different method names or an `actor` shape that differs from `{ kind: 'system', id, label }`, the executor adapts the daemon adapter, not the port. If plan 205 lands after this plan, the core runs with `noopActivityPort` until plan 205's executor wires the adapter; the tile then shows `Preparing` from `E_SESSION_PREPARING` alone (no step). Who owns the adapter commit: 135 or 136?
2. **USB-root grouping on Windows.** `adb devices -l` on Windows reports `usb:` in a different shape (to verify on the owner's Windows host); until verified, every device may group under one root and the farm ceiling alone bounds the stagger. Decide whether plan 223 verifies it or this plan's executor does with the owner.
3. **Readiness `hot` and `maxHot`.** With always-on, `rawActual` reads `hot` for every prepared device and the `hot` branch's `acquire` is a no-op attach. Delete `hot`/`maxHot` here, or leave it to plan 212's settings reduction? This plan leaves them compiling.
4. **`drizzle-kit generate --custom`** on the pinned version (to verify by running it once). If unsupported, §4.7's hand-written fallback applies.
5. **Quarantine.** MVP 11 says a session lives until offline or forgotten. A quarantined device (thermal) keeps its session under this plan. Confirm that is wanted, or that quarantine should stop the encoder to shed heat.
6. **Control linger length.** 15 s is the brief's default. The owner may want longer on a farm where operators tab between devices; a constant today, a setting never (MVP 12).

## 10. Removed

Forbidden words introduced by this area: `Waking`, `WAKE_OFFER`, `idleTtlSec`, `maxIdleSessions`, `maxConcurrentBuilds`, `closeIfIdle`, `idleSessions`, `session.progress`, `E_CONTROL_SESSION_UNAVAILABLE`, `readinessHold`, `control_session_unavailable`.

| What | Where it was | Proof |
|---|---|---|
| Lazy build on `acquire` / `stream.start` | `packages/session/src/manager.ts:86,771-810`, `ws-handlers.ts:1018-1034` | `rg -n "buildLane|buildEntry\(|createBuildLane" packages/session/src` → empty; `rg -n "sessions\.acquire\(" packages/core/src/server` → empty |
| `idleTtlSec`, `maxIdleSessions`, `maxConcurrentBuilds` (schema, manager deps, daemon, stats, Studio fixtures) | `settings.ts:2006-2042`, `manager.ts:267-269,322`, `daemon.ts:3904-3905,3913,3108`, `adb-stats.ts:70,175`, `protocol/api/adb.ts:194`, four Studio test fixtures | `rg -n "idleTtlSec|maxIdleSessions|maxConcurrentBuilds" packages apps plugins scripts` → empty |
| Idle model: `closeIfIdle`, `idleSessions`, `enforceIdleCap`, `Entry.closeTimer`, `Entry.idleSince`, `DEFAULT_IDLE_TTL_SEC` | `manager.ts:12,30-32,187-189,492-502,947-957`, `daemon.ts:1169,1966`, `adb-stats.ts:162,195`, `protocol/api/adb.ts:70` | `rg -n "closeIfIdle|idleSessions|enforceIdleCap|idleSince|DEFAULT_IDLE_TTL_SEC" packages` → empty |
| "Waking" phase panel, `WAKE_OFFER_AFTER_SEC`, wake-offer flow, phase tables | `LiveView.tsx:43,47,133-158,359-371,468-471,815-821,944-945,1015-1024,1237-1274` | `rg -n "Waking|WAKE_OFFER_AFTER_SEC|SLOW_PHASE_AFTER_SEC|PHASE_STEPS|PHASE_HEADLINE|PHASE_COMPACT_LABEL|showWakePanel" packages/studio/src` → empty |
| `session.progress` message, `SessionProgressMessage`, the daemon broadcast, the manager's `onPhase` dep | `protocol/messages/stream.ts:109-118`, `protocol/index.ts:455,458,1018`, `daemon.ts:3885-3886`, `manager.ts:263` | `rg -n "session\.progress|SessionProgressMessage|SessionProgress\b" packages` → empty |
| Readiness `asleep` NULL fallback | `readiness.ts:153,225` | `rg -n "\?\? 'asleep'" packages/core/src/device/readiness.ts` → empty |
| Viewer readiness hold | `ws-handlers.ts:207-208,1012-1015,1115,2565` | `rg -n "readinessHold|hold\(.*'viewer'\)" packages/core/src/server` → empty |
| Screencap loop as a build-time substitute (silent fall back under a wall build) | `session.ts:690-697` behaviour | `rg -n "falling back to screencap-loop" packages/session/src/session.ts` → empty (the fallback log line now names the condition); `bun test packages/session/src/session.test.ts` test `requireScrcpy without skipDevicePrep throws E_SCRCPY_UNAVAILABLE` passes |
| `E_CONTROL_SESSION_UNAVAILABLE`, `control_session_unavailable` | `errors.ts:29`, `session.ts:725`, `manager.ts:76`, `ws-handlers.ts:1026-1029`, `stream.ts:57`, `LiveView.tsx:452` | `rg -n "E_CONTROL_SESSION_UNAVAILABLE|control_session_unavailable" packages` → empty |
| `SessionManager.videoStats` | `manager.ts:230-235,974-997`, `adb-stats.ts:167` | `rg -n "videoStats" packages` → empty |

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


---

## 12. Amendment 2026-09-03 — testing policy (plan 200 §8.3)

Studio has zero tests. Overrides the Studio tests named above:

- **Dropped**: every change to `packages/studio/src/components/LiveView.test.tsx`, `app/settings/page.test.tsx`, `components/video/FarmVideoFields.test.tsx`, `components/video/useAdbVideoStatsPoll.test.ts`, `components/wall/Wall.test.tsx`. Do not edit them; if they still exist when this plan runs, leave them to plan 201, which deletes them. If a Studio test fails to compile because of this plan's protocol change and plan 201 has not merged yet, delete that test file in this plan and list it in §11 (not a stub, not a skip).
- **Replaced by**: `bun run typecheck` and the owner smoke already in §7 (no "Waking" panel anywhere; a tile with no frames shows the activity sentence; `E_SESSION_PREPARING` retry every 3 s observed in the network tab).
- **§0 amended**: G7's "Verified by" becomes the `rg` for the deleted identifiers plus the owner smoke; no Studio test command remains in §7.
