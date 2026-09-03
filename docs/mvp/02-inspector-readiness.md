# MVP 02 — Inspector readiness (ui-server wake-up and timeouts)

> Status: researched 2026-09-03, plan proposed, no decision taken.
> Complaint as reported: "The ui-server / UI Automator side that fetches UI nodes is slow to wake up and often times out. Writing automation scripts is a bottleneck because the script waits for our system to see the UI."
> Related: `docs/spec.md` §7.4 and §16 NFRs, `docs/plans/06-m4.5-ui-server.md`, `docs/plans/85-m50-windows-fleet-scale.md`, `docs/plans/129-m94-inspector-truth-and-wall-picker.md` (§0 evidence, step 129.4 open), `docs/research/android-guest-agent.md:281`, `scripts/bench-device-nfrs.ts:213-291`.

---

## 0. The targets we are missing

`docs/spec.md:1106-1110`: inspector find under 200 ms, job overhead (spawn to prepare, "child process plus attaching ui-server") under **3 s**. Plan 129 §0.1 measured attach at **31 957 / 32 010 / 31 986 ms** on the owner's 20-device SM-F721U1 farm (Android 16 / API 36), after which every dump failed against a port nothing was listening on. Plan 129 fixed the lie (the failure now reports as a failure and the fallback engine is reachable) but not the cause: **step 129.4 is open and nobody knows why ui-server does not start on API 36.**

## 1. What the inspector is

Not first-party. It is the openatx `android-uiautomator-server` APK pair, version **2.3.3**, run as an AndroidJUnit instrumentation, speaking HTTP JSON-RPC on device port 9008.

- Pinned in `packages/toolchain/manifest/enkaku-tools.json:87-129` (`ui-server` with `deviceArtifact` versionCode 2003003; `ui-server-test` with no `deviceArtifact`, presence only). `compatibleCoreRange: "TODO-M4.5"`, `releasedAt: "unknown"`.
- Constants and the launch command in `packages/drivers/src/inspector/ui-server/launcher.ts:7-22, 388-424`:

```
am instrument -w -r -e debug false -e class com.github.uiautomator.stub.Stub \
  com.github.uiautomator.test/androidx.test.runner.AndroidJUnitRunner
```

- Runs on the plan-24 streaming lane with both stream clocks disabled (`inspector-factory.ts:102-108`), so it holds a stream slot for the whole session.
- Host port 27100–27299 (`packages/session/src/port-allocator.ts:91`), `adb forward` with a host-port ownership check (`launcher.ts:275-291`).
- Client (`client.ts`): `GET /ping`, `POST /jsonrpc/0` (`dumpWindowHierarchy`, `objInfo`, `setText`, `click`, `longClick`), `GET /screenshot/0`. Selectors must carry the openatx bitmask or the server returns the root node (`selector.ts:17-42`, a field incident).

Fallback engine: `uiautomator dump` to `/dev/tty` or `/sdcard` (`inspector/uiautomator-dump.ts:29-51`), 3 attempts, 500 ms apart, 20 s each. Cost per dump: **334–584 ms** measured, 0.5–2 s in the spec's wording, versus **~80 ms** per `objInfo` find on ui-server (`docs/spec.md:293-307`).

## 2. Why it is slow to wake and why it times out

### 2.1 Lifecycle: started lazily per session, torn down eagerly

`packages/session/src/session.ts:473-508`: the inspector is never started for manual control. It starts when a job calls `whenInspectorReady()` (`job-runner.ts:1381`) or when the Inspect tab attaches (`ws-handlers.ts:2198-2257`, ref-counted). It is **released when the Inspect ref-count hits zero** (`ws-handlers.ts:624-635`) and when the session idle-closes (default TTL 300 s, `packages/protocol/src/settings.ts:2006-2020`). Every reopen pays the full cold start again.

The lazy start was itself a measured decision: awaiting it up front delayed the first video frame by about 50 s, and starting it in the background starved screencap (1 frame in 20 s versus 11). Both numbers are in the comment at `session.ts:473-508`. The conclusion drawn was "start late"; the conclusion this document draws is "start after video is up, then never stop".

### 2.2 Cold start cost on a healthy device

`pm list packages` + `dumpsys package` (5 s budget each) + possibly two `pm install -r -g` + `am instrument` handshake + `adb forward` + `forward --list` + ping polling every 250 ms up to 15 s (`watchdog.ts:83,107`) + one `wm size`. On a device where the instrumentation never comes up: a flat 15 s, then the fallback engine. Before plan 129 it was 32 s because the 15 s was paid twice.

### 2.3 Every timeout on the path

| Value | Where | Meaning |
|---|---|---|
| 1 000 ms | `ui-server/client.ts:37` | ping |
| 5 000 ms | `client.ts:38` | default JSON-RPC (`objInfo`, `click`, `setText`) |
| 20 000 ms | `client.ts:40` | `dumpWindowHierarchy` |
| 15 000 ms | `client.ts:41` | screenshot |
| 15 000 ms, poll 250 ms | `watchdog.ts:83,107` | start readiness |
| 5 000 ms, 2 failures | `watchdog.ts:82,199` | idle ping, restart trigger |
| 1 s, 3 s, 10 s, 30 s | `watchdog.ts:18` | restart backoff |
| 3 per 600 000 ms | `watchdog.ts:84-85` | circuit breaker, then terminal fallback |
| 300 ms, once | `ui-server/index.ts:119` | dump retry after post-wake NPE |
| 80 ms | `ui-server/index.ts:49` | waitFor poll on ui-server |
| 500 ms | `inspector-factory.ts:53` | waitFor poll on the dump engine |
| 10 000 ms / 1 000 ms | `runner/child-entry.ts:182` | SDK `waitFor` default timeout and interval |
| 10 s / 15 s / 65 s / 10 s | `core/src/capability/device-inspect.ts:30,49,84,121` | find / dump / waitFor / screenshot for agents, REST, MCP |
| 20 000 ms | `ws-handlers.ts:76` | `inspect.dump` / `inspect.find` |
| 45 000 ms | `ws-handlers.ts:97` | `inspect.attach` |
| 30 000 ms | `job-runner.ts:67` | child silence watchdog |

### 2.4 No idle-wait configuration

UiAutomator waits for the screen to be "idle" before a dump. In an app with continuous animation that wait is the timeout. There is **no** `Configurator`, `setWaitForIdleTimeout`, or `waitForSelectorTimeout` anywhere in the repo (confirmed by grep). The only handling is reactive: the fallback engine matches the literal string `could not get idle state` and retries (`uiautomator-dump.ts:64-66`). `docs/plans/06-m4.5-ui-server.md:424` listed lowering the server-side selector timeout as an unbuilt mitigation.

### 2.5 The agent, REST, and MCP path silently uses the slow engine

`packages/core/src/capability/context.ts:497-515` `deviceCall()` acquires the session and builds an executor but never calls `whenInspectorReady()`. `packages/session/src/device-executor.ts:165` then falls back:

```ts
const inspector = deps.session.inspector ?? new UiautomatorDumpInspector(deps.session.transport)
```

So `device.find`, `device.dump`, and `device.waitFor` from an agent or MCP caller on a device with no open Inspect tab and no running job run on the 0.5–2 s engine. Worse, that engine takes the `instrumentation` lock (`packages/drivers/src/descriptors.ts:79,129`) and a `uiautomator dump` seizes UiAutomation, which kills a healthy ui-server if one is running in another session (`ui-server/README.md:23`, `selector.ts:29-30` records this cascade in the field).

### 2.6 No caching; every tick is a round trip

`waitFor` polls in the parent (`device-executor.ts:472-494`), clamping the interval to 80 ms on ui-server or 500 ms on the dump engine. Each tick is a fresh `objInfo` RPC or a fresh full dump. `dump()` always requests the uncompressed tree (`client.ts:165`). The only cached values are the viewport size and a tty probe. A failing traced action triggers an extra real dump (`job-runner.ts:1287-1288`).

### 2.7 Fleet-scale findings still open (plan 85)

F4: the instrumentation holds a stream slot for the whole session. F7: two of four farm-wide stream slots per device, so two devices exhaust the farm and the rest fall back. F17: restart counter reset per cycle so churn never gives up. F18: one flat timeout for every call (fixed since). H5: five simultaneous `stream.start` → two unbounded installs per device → USB saturated → 15 s start timeout blown → restart → more installs.

### 2.8 The guest agent has no inspector

`apps/guest-agent` declares capabilities `socks5-route, vpn-status, egress-probe, route-hold, mock-location, screen-label, text-input` (`Protocol.kt:52-53`). No `BIND_ACCESSIBILITY_SERVICE`, no `UiAutomation`, no `dumpWindowHierarchy` anywhere in its Kotlin sources. `docs/plans/90-m55-unified-guest-agent.md:258-259` deliberately did not absorb ui-server. `docs/research/android-guest-agent.md:281` leaves it as an open question: "Does the agent replace the ui-server inspector eventually, or coexist with it?" This document answers: replace.

## 3. Root causes, in one list

1. Inspector ownership is per tab, not per session, so the cold start is paid repeatedly (§2.1).
2. The pinned openatx 2.3.3 is suspected not to run on API 36; the 15 s wait is then pure loss and the farm runs on the slow engine (§0, plan 129 step 129.4).
3. Startup failure is detected by a 15 s timeout instead of by reading the instrumentation's own stdout (§2.2).
4. No idle-wait configuration (§2.4).
5. The capability path never asks for the fast engine and can kill it (§2.5).
6. No cache, no change notification; waitFor is polling all the way down (§2.6).
7. Farm-wide stream slot limits make the fast engine unavailable past two devices (§2.7).

## 4. Proposed plan

### Phase 1 — make the existing engine reliable (one to two sprints, no Android work)

- **Session-scoped inspector.** Start it in the background once the first video frame has painted (respecting the measured screencap starvation), keep it alive until session close, and only the session close tears it down. Inspect-tab attach becomes a no-op when it is already up.
- **Fail fast on start.** Read the `am instrument` stream: `INSTRUMENTATION_STATUS` and `ClassNotFoundException` lines arrive within 1–2 s and are definitive. Reserve the 15 s ceiling for the silent case only.
- **Fix the capability path** so `deviceCall()` awaits `whenInspectorReady()` and never instantiates the dump engine while a ui-server is alive in the same session.
- **Configure idle wait** via the openatx JSON-RPC configurator (verify the method name against 2.3.3 first, per the `TODO-verify` at `client.ts:9`); target a small `waitForIdleTimeout` and a small `waitForSelectorTimeout`.
- **Lift the farm-wide stream slot limit** or move the instrumentation off the counted lane (plan 85 F4/F7), and serialise installs per USB root (H5).
- **Verify 2.3.3 on API 36** on the lab device, and either upgrade the pin, patch the APK build, or document the ceiling. This closes plan 129 step 129.4 either way.
- **Cheap cache:** reuse the last dump for the trace capture of a failing action instead of issuing a second one.
- Exit criteria: attach under 3 s warm and under 8 s cold on the lab device; `find` p95 under 200 ms; zero fallbacks on a 20-device farm during a 10-minute job run. `scripts/bench-device-nfrs.ts` already measures the first two.

### Phase 2 — a first-party inspector inside the guest agent (two to three sprints of Android work)

Add an `AccessibilityService` to `apps/guest-agent` exposing the window tree over the agent's existing control socket, with a new capability (for example `ui-tree`) beside the seven listed in §2.8. Properties:

- Same data source as UiAutomator (`AccessibilityNodeInfo`), so selectors and the existing Zod node schema carry over.
- No `am instrument`, no instrumentation lock, no conflict with `uiautomator dump`, no per-session process. It is a bound service that lives as long as the agent.
- Enabled from adb without touching the screen: write `enabled_accessibility_services` and `accessibility_enabled` through `settings put secure`, which the shell user may do. Verify on Android 13+ where restricted-settings prompts exist for sideloaded apps; the agent is installed via adb, which is exempt, but this must be tested on the lab device.
- **Push, not poll.** `TYPE_WINDOW_CONTENT_CHANGED` events let `waitFor` subscribe to changes instead of polling every 80 ms. This is the structural fix for "the script waits for our system to see the UI".
- Keep ui-server as the fallback engine for devices where the agent cannot be installed, and demote `uiautomator dump` to last resort.

Spec impact: §7.9 (the inspector layer gains a first-party engine and an event-driven `waitFor`), §7.4 (the degradation ladder becomes agent → ui-server → dump). This document proposes that change; it is not yet in the spec.

## 5. Decisions needed

1. Approve phase 1 now. It needs no new hardware beyond the lab device and no product decision.
2. Decide on phase 2. The alternative is to keep maintaining a third-party instrumentation whose maintainer has not tagged a release for the current Android API and whose `compatibleCoreRange` has read `TODO` since M4.5.
3. Provide one Android 16 (API 36) device for the lab so step 129.4 and the accessibility-enablement check can be run on hardware instead of on the production farm.
