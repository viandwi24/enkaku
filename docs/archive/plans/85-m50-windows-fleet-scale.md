# Plan 85 — M50 : The Windows Fleet, 5 → 10 → 20 Devices

> Status: partial — steps 85.1–85.8 and 85.9 (documentation) are implemented and unit-tested (`bash scripts/typecheck.sh`, `bun test`, and `bun run --cwd packages/studio test` all green). 85.7b is intentionally not built — it is gated on the 10-device rung of the §7.3 ladder recording control-reply p95 above 500ms with a non-trivial `bufferedBytesP95`, and that rung has never been run. The §7.3 Windows ladder itself (5/10/20 real devices, the release binary) has not been run at all, so acceptance criteria 1–16's field behaviour and criterion 15 (the ladder filled in) are implemented-and-unit-tested but **not hardware-verified** — see §7.3 and the note at the end of §5 for detail.
> Depends on: Plan 23 (adb concurrency and the autoscaler), Plan 24 (the streaming lane), Plan 34 (the ui-server inspector), Plan 37 (the always-on crash watcher), Plan 42 (the Wall and idle sessions), Plan 43 (readiness). None of them needs to change first — this plan amends their budgets and adds the recovery paths they never had.
> Spec references: §7 (driver layers), §7.6 (version-locked scrcpy-server), §10.1 (video keeps running while a device is busy), §10.4 (adb serialisation and the global semaphore), §16 (NFR targets)
> Ships: packages/core/src/device/host-adb.ts

---

## 0. Evidence

This plan was written from the code, not from the symptoms. Every claim below
is either **CONFIRMED** (there is a file and a line that says so) or
**HYPOTHESIS** (a mechanism that fits the field report but has not been
observed directly, and which this plan therefore instruments before it
"fixes"). Nothing in §5 acts on a hypothesis without first adding the
measurement that would prove or kill it.

The field report this was written against: a Windows 11 host running the
`v0.1.6` release binary with five USB devices, plus two log screenshots and
one error string (`http://127.0.0.1:27100/jsonrpc/0 did not respond within
3000ms`).

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | `adb.maxStreams` — the **farm-wide** cap on concurrent adb streams — defaults to `4`, the same number as the **per-device** cap. It is a fixed constant: it does not scale with device count. | `packages/protocol/src/settings.ts:622-631` |
| **F2** | The autoscaler that exists for the exec semaphore (`computeAutoConcurrency`, 6 → 24 by device count) has **no stream-lane equivalent**. `recomputeAdbConcurrency` pushes `cfg.maxStreams` through unscaled. | `packages/core/src/device/adb-scaling.ts`; `packages/core/src/daemon.ts:299`, `:315` |
| **F3** | `StreamLane.acquire` never queues. Over budget it throws `E_ADB_STREAM_LIMIT` synchronously — by design (plan 24 §3.2), which makes the size of the budget the whole story. | `packages/adb/src/client.ts:65-88` |
| **F4** | The ui-server instrumentation holds **one stream slot for the entire life of the session**, both stream clocks deliberately disabled (`idleTimeoutMs: 0`, `absoluteTimeoutMs: 0`). | `packages/session/src/inspector-factory.ts:86-93` |
| **F5** | The always-on crash watcher holds **a second slot per device** (`logcat -b crash,main`), routed through `MonitorHub` → `ShellPort.stream` → `execStream` with **no clock overrides**, so it inherits the lane defaults: idle 60 s, absolute **600 s**, 5 MiB. | `packages/core/src/device/monitors.ts:63`; `packages/core/src/device/monitor-hub.ts:213`; `packages/core/src/device/shell-port.ts:58-66`; `packages/adb/src/timeouts.ts:19-22` |
| **F6** | When that crash stream hits any of those three limits, the watcher **deletes its bookkeeping and does not resubscribe**. Crash detection on a long-lived session is silently dead after at most ten minutes. | `packages/core/src/device/crash-watcher.ts:207-219` |
| **F7** | F1 + F4 + F5 together: at steady state a device with an open session and an attached inspector consumes **2 of 4 farm-wide slots**. Two devices exhaust the farm. This is exactly what the field log prints: `the farm already has 4 adb stream(s) running (max 4)` for the crash watch of devices 3, 4 and 5, and `ui-server cannot be used … — falling back to uiautomator-dump`. | field log; F1–F5 |
| **F8** | **There is no device reconcile of any kind.** `DeviceRegistry.start()` subscribes to `host:track-devices` and nothing else. The tracker only speaks on *change*. | `packages/core/src/registry/device-registry.ts:374` |
| **F9** | A device whose identity probe fails twice logs `probe of <serial> failed outright — waiting for the next event` and is then **invisible until it is physically unplugged and replugged**, because no next event is coming. | `packages/core/src/registry/device-registry.ts:213`, `:317` |
| **F10** | Any adb state that is not `device` or `unauthorized` — including `offline` and `authorizing`, the two states a Windows host most often shows for a phone that was plugged in **before** the adb server came up — is dropped with `device <serial> state=<x> — ignored in M0`. No recovery action is ever taken. | `packages/core/src/registry/device-registry.ts:361` |
| **F11** | `hostAdb` (the adb **CLI** helper, used for `install`, `push`, `forward`, and the long-lived scrcpy `shell`) pipes `stderr` and **never reads it**, has **no timeout**, has **no concurrency bound**, and throws an error containing **stdout only**. The field log's `exit 1: Performing Streamed Install` is that defect: the real reason was on stderr and was discarded. It is also **duplicated verbatim** in two places. | `packages/core/src/daemon.ts:1708-1714` and `:1775-1782`; `packages/drivers/src/inspector/ui-server/launcher.ts:107-111` |
| **F12** | The scrcpy server is started as a **long-lived child** through that same helper, fire-and-forget, and its entire stdout is accumulated in memory (`new Response(proc.stdout).text()`) for the life of the session. Nothing holds a handle to the child, so nothing kills it when the core exits. | `packages/scrcpy/src/session.ts:125-128` |
| **F13** | `doctor`'s "who holds this port" lookup **returns `null` on Windows** (`if (process.platform === 'win32') return null`). The one host where the user hit `Failed to start server. Is port 7700 in use?` is the one host where the tool cannot answer the question. | `packages/core/src/doctor/context.ts:78-79` |
| **F14** | The data-directory lock proves liveness with `process.kill(pid, 0)`, which answers "is *that pid* alive", never "is the *port* free". The field log shows the two disagreeing: `taking over a stale lock from pid 19964 (no such process)` immediately followed by `Failed to start server. Is port 7700 in use?` | `packages/core/src/util/data-dir-lock.ts:38-44`; field log |
| **F15** | Video frames and JSON control messages share **one WebSocket**, with no prioritisation. Video backs off at a 4 MB buffer, so a control reply can sit behind up to 4 MB of already-queued H.264. | `packages/core/src/server/ws-handlers.ts:51`, `:563`, `:582` |
| **F16** | Studio's WS client reconnects **only** on `onclose`. It has no read-timeout, no application heartbeat, and no way to notice a socket that is open but silent. The server sets neither `idleTimeout` nor `sendPings` explicitly (Bun defaults: 120 s / `true`). | `packages/studio/src/lib/ws.ts:71-76`; `packages/core/src/daemon.ts:1518-1543`; `bun-types/serve.d.ts:454`, `:468` |
| **F17** | The ui-server watchdog pings every 5 s per device and restarts after two consecutive failures. The attempt counter **resets on every successful restart**, so a device that keeps degrading churns forever with no circuit breaker — which is why the field log shows `restart attempt 1/2` at 10:14:22, 10:14:57 and 10:15:33 and never `gave up`. | `packages/drivers/src/inspector/ui-server/watchdog.ts:41-44`, `:99-113` |
| **F18** | The ui-server JSON-RPC client uses a **3000 ms** default timeout for every call including `dumpWindowHierarchy`, and 1000 ms for ping. `fetch` is used against a port that `adb forward` tears down and re-creates on every restart, so a pooled keep-alive connection outlives its forward — which produces exactly the reported error text, `The socket connection was closed unexpectedly`, rather than a timeout. | `packages/drivers/src/inspector/ui-server/client.ts:37-52` |
| **F19** | **Nothing in this codebase touches screen rotation.** There is no `accelerometer_rotation`, no `user_rotation`, no rotation lock, anywhere. Auto-rotate behaviour is the device's own; Enkaku neither sets nor clears it. | repo-wide search |
| **F20** | `adb forward` entries survive a core crash (they live in the adb server, not in the core). Nothing removes ours at boot. The ui-server port allocator bind-tests each port so it self-heals, but the leaked forwards accumulate. | `packages/session/src/port-allocator.ts:22-30`; `packages/scrcpy/src/session.ts:236-258` |

### 0.2 Hypotheses (instrument before fixing)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | The "page loads slowly, closing the tab and opening a new one fixes it" report is **head-of-line blocking on the shared WebSocket** (F15): control replies queue behind video, and a fresh tab has an empty buffer. | A new tab working means the server is not wedged; the old tab's socket state is the differing variable. `ws.request` has a 25 s timeout, so a stalled reply presents as an indefinite spinner. | 85.7 adds per-connection `bufferedAmount` and control-reply latency to `/api/adb/stats`, plus a slow-request log. The ladder in §7.3 reads them at 5, 10 and 20 devices. |
| **H2** | Alternatively (or additionally) the tab holds an **open-but-silent WebSocket** the client cannot detect (F16). | `onclose` is the only reconnect trigger; a half-open socket produces a permanently "connected" UI receiving nothing. | 85.7's heartbeat + client watchdog makes this self-healing *and* observable: the log names every watchdog-forced reconnect. |
| **H3** | Devices plugged in **before** Enkaku starts are missed because they present as `offline`/`authorizing` while the adb server finishes USB enumeration, and that transition is dropped (F10) or the first probe fails (F9). | Both code paths are terminal, so any device that misses its one event is invisible until replug — which is exactly the reported workaround. | 85.2's reconciler removes the dependency on catching the transition at all. `doctor` gains a check that prints adb's own view next to the registry's, so the two can be compared directly. |
| **H4** | The scrcpy child's undrained `stderr` pipe (F11/F12) can fill and block `adb.exe`, stalling that device's transport and freezing its picture. | The OS pipe buffer is finite; a blocked writer blocks the reader loop that also relays the video-bearing transport. | 85.3 drains both streams unconditionally. If a frozen tile is still reproducible afterwards, the hypothesis is dead and §9 Q2 takes over. |
| **H5** | The five-device "one tile always black" report is **session churn under the wall**, not a hard limit of four: five simultaneous `stream.start` calls each trigger a session build, and the first inspector attach fires **two unbounded `adb install` commands per device** (F11), which saturates USB and pushes ui-server past its 15 s start timeout → watchdog restart → more installs (F17). | Field log: four `session opened` in 4 s, then `installing the ui-server APKs` on four devices within 4 s, then RPC timeouts, then a 35-second restart cycle. No `wall.maxTiles`, `session.maxIdleSessions` or `readiness.maxHot` is 4 — all three default to 8, so no configured cap explains "four". | 85.3 bounds install/push concurrency; 85.5 stops the restart churn. The §7.3 ladder records tiles-live and time-to-first-frame at each rung, so "four" either disappears or becomes a number with a cause. |

### 0.3 What the field log maps to

```
crash watch failed to start … the farm already has 4 adb stream(s) running (max 4)   → F1, F4, F5, F7
ui-server cannot be used on … — falling back to uiautomator-dump                     → F7 (consequence)
ui-server cannot be used on … (adb -s … install -r -g … exit 1: Performing Streamed   → F11 (stderr discarded:
  Install)                                                                              the real reason is missing)
http://127.0.0.1:27100/jsonrpc/0 did not respond within 3000ms: … socket connection    → F18
  was closed unexpectedly
ui-server restart attempt 1/2: two consecutive ping failures  (×3, every ~35 s)        → F17
taking over a stale lock from pid 19964 … / Failed to start server. Is port 7700       → F13, F14
  in use?
```

---

## 1. Goals

- **The stream-lane budget scales with the fleet.** A farm of 20 devices never
  refuses a crash watch or a ui-server start because of a farm-wide cap that
  was sized for two devices. `adb.maxStreams: 0` means auto, exactly like
  `adb.maxConcurrent` already does.
- **Crash detection stays alive** for the life of a session instead of dying
  silently at ten minutes, and says so in the log when it cannot.
- **Device discovery is self-healing.** A phone plugged in before the core
  starts, a probe that failed once, an adb state the tracker only reported
  once — all recover on their own within one reconcile interval, with no
  replug and no restart. A device that adb can see and Enkaku cannot is a
  visible, explained condition, never silence.
- **Every adb CLI invocation is bounded**: both streams drained, a deadline, a
  concurrency limit, stderr in the error message, and one implementation
  instead of two.
- **No orphan `adb.exe` outlives the core**, and when a port really is taken,
  the core names the process holding it — on Windows too.
- **The Studio session survives a silent socket**: a heartbeat the client can
  miss, a watchdog that reconnects when it does.
- **The ui-server stops churning**: a circuit breaker, a real backoff, and
  timeouts that fit the operation instead of one 3-second number for
  everything.
- **Rotation is controllable** per device (lock portrait / lock landscape /
  leave the device alone), reverted on session close the same way `keepAwake`
  already is.
- **The farm is measurable at 5, 10 and 20 devices** — lane occupancy, session
  build time, control-reply latency, WS buffer depth — so the next report is a
  number, not an anecdote.

## 2. Non-goals

- **Not a video-transport rewrite.** Splitting video onto its own WebSocket is
  designed here (85.7b) but only *executed* if the 10-device rung proves H1;
  the cheap mitigation lands first.
- **Not WebRTC.** The cloud path (plan 61) is untouched.
- **Not a browser-side decoder redesign.** The per-tile binary fan-out
  (`packages/studio/src/lib/ws.ts:78-82`, O(tiles) per frame) is measured at
  the 20-device rung and, if it bites, gets its own plan.
- **Not a change to the admission flow** (plan 56). Discovery gets a
  reconciler; whether a discovered device is admitted stays a human decision.
- **Not Windows service / autostart packaging.** Separate concern.
- **Not `adb kill-server`.** Forbidden repo-wide except in the Toolchain
  Manager's swap flow, and this plan does not go near it.

## 3. Context and design decisions

### 3.1 Two budgets that look alike and are not

Plan 23 gave the **exec** semaphore an autoscaler. Plan 24 added a **separate
streaming lane** so that a `logcat` could not park an exec slot — and gave it a
farm-wide constant of 4, chosen when the plan's own worked example was a single
device with a Monitor tab open.

Since then, two subsystems started holding a stream slot *permanently* per
device: the ui-server instrumentation (plan 34) and the always-on crash watcher
(plan 37). Nobody re-derived the farm-wide number. Four slots is therefore not
a policy — it is a leftover, and it caps the farm at two fully-instrumented
devices (F7).

**Decision.** `adb.maxStreams` gains the `0 = auto` semantics
`adb.maxConcurrent` already has, and the auto formula is derived from what a
device actually holds rather than from a round number:

```
perDeviceSteadyState = 2      # ui-server instrumentation + crash logcat
headroom             = 0.5    # a Monitor tab, a transfer, an install, in flight somewhere
computeAutoStreams(n) = clamp(ceil(n * 2.5), 8, 64)
#  5 devices → 13     10 devices → 25     20 devices → 50
```

The floor of 8 keeps a one- or two-device desk farm strictly better off than
today. The ceiling of 64 is the schema's existing maximum and is where the adb
server, not this budget, becomes the constraint.

A stored `maxStreams: 4` — the old default, which no operator ever chose
deliberately because the setting had no visible effect until it started
refusing streams — is rewritten to `0` by a Zod `preprocess`, the same
mechanism `normaliseLegacyPrep` already uses for `stayAwake` → `keepAwake`
(`packages/protocol/src/settings.ts:106-112`). Tracked for removal per
00-overview §9.

### 3.2 A stream that dies quietly is worse than one that dies loudly

The crash watcher's feed inherits the lane's generic clocks (F5) and, on
expiry, drops its bookkeeping without a word (F6). The stream slot is released,
which is *why* the field log's stream-limit errors look intermittent and move
between devices: the farm is not stably over budget, it is oscillating.

**Decision.** The crash feed is an always-on internal stream and is declared as
one: `idleTimeoutMs: 0`, `absoluteTimeoutMs: 0`, byte cap raised to 32 MiB and
made a **restart trigger rather than a death**, with exponential backoff
(2 s → 60 s) and one `warn` per restart naming the reason. A new
`monitor.crashWatch: 'always' | 'off'` farm setting exists so a 20-device farm
can trade the detection for the bandwidth; the default stays `always`, because
turning detection off silently is what this plan is fixing.

### 3.3 Discovery must not depend on catching a single event

`host:track-devices` is an excellent primary signal and a terrible only signal.
The codebase already knows this in one narrow place — `DeviceRegistry.admitted`
carries the comment *"the tracker only speaks on change … which, for a phone
that never gets unplugged, may never come"* — and this plan generalises that
insight instead of re-discovering it a third time.

**Decision.** A `DeviceReconciler` runs every `discovery.scanIntervalSec`
(default 10 s):

1. `host:devices-l` → adb's own truth.
2. Diff against the registry's live view (`serialToStableId` plus the `devices`
   table).
3. `device` in adb but unknown to us → run the normal `onOnline` path.
4. Known to us but absent from adb → the normal `onRemove` path (the tracker
   usually gets there first; this is the safety net).
5. `offline` for longer than `discovery.offlineGraceSec` (default 20 s) → one
   `host:reconnect-offline`, at most once per serial per
   `discovery.recoveryCooldownSec` (default 120 s), logged at `warn`. This is a
   host-level adb command; it is **not** `kill-server` and touches no other
   tool's session.
6. `unauthorized` → keep broadcasting the existing `device.unauthorized` so
   Studio can keep saying "accept the prompt on the phone", but now on a
   repeating cadence rather than once.
7. A probe that failed gets a per-serial retry with backoff (1 s, 2 s, 5 s,
   15 s, 30 s, then every reconcile tick), replacing today's give-up.

Plus a manual escape hatch: `POST /api/devices/rescan` and a **Rescan** button
next to the Discovered tray, because the first thing a human does when a phone
is missing is look for that button.

### 3.4 One adb CLI helper, bounded

F11 and F12 are a single defect with four faces: undrained stderr, no
deadline, no bound, and a duplicated implementation. They are fixed together
because fixing any one alone leaves the failure mode intact.

**Decision.** `packages/core/src/device/host-adb.ts` exports one
`createHostAdb()` with two modes:

- **`run(args, opts)`** — a one-shot. Drains stdout **and** stderr
  concurrently, enforces a deadline (`opts.timeoutMs`, default 30 s; installs
  get 180 s), kills the child on expiry, and throws an `AdbError` carrying exit
  code, stdout tail, **and stderr tail**.
- **`spawnLongLived(args, opts)`** — for the scrcpy server. Returns a handle.
  Both streams are drained continuously into a bounded ring buffer (last 64 KB,
  for the error message) rather than an unbounded string. The child is
  registered in a process registry and killed on `daemon.stop()`.

Both go through a `Semaphore`: `adb.maxHostConcurrent` (default 4) farm-wide,
with `install`/`push` additionally limited to `adb.maxInstallConcurrent`
(default 2) and serialised per device. That second limit exists because a
20-device farm attaching inspectors at once would otherwise start 40
concurrent `pm install` sessions over one USB controller (H5).

The process registry also fixes F14's second half: an orphaned `adb.exe` that
inherited the listening socket is the most plausible reason a dead pid's port
stays bound on Windows, and killing our own children on shutdown removes the
mechanism rather than the symptom.

### 3.5 The ui-server should fail slowly, not repeatedly

**Decision.**
- The watchdog gains a **circuit breaker**: more than
  `maxRestartsPerWindow` (default 3) restart *cycles* within
  `restartWindowMs` (default 10 min) → `dead`, fall back to
  `uiautomator-dump`, one `warn` explaining it, and no further attempts for
  that session.
- Backoff between cycles becomes exponential (1 s, 3 s, 10 s, 30 s), not the
  current flat 1 s / 3 s.
- The JSON-RPC client separates its timeouts: `ping` 1 s (unchanged),
  ordinary RPC 5 s, `dumpWindowHierarchy` 20 s (matching the `inspectorDump`
  exec profile — a deep hierarchy legitimately takes longer than 3 s on a
  loaded phone), `screenshot` 15 s. Each is a named constant, not a literal.
- The specific "socket connection was closed unexpectedly" failure (F18) is
  retried **once** after re-establishing the forward, because a stale pooled
  connection to a torn-down `adb forward` is a known, benign, self-correcting
  condition and reporting it as a device fault is a lie.

### 3.6 Make the transport observable before reshaping it

H1 and H2 both explain the reported slowness; only measurement separates them,
and both are cheap to make self-healing.

**Decision — landing now (85.7a):**
- A `heartbeat` server message every 15 s; the Studio client resets a 45 s
  watchdog on **any** inbound message and force-closes the socket when it
  expires, letting the existing reconnect path run. Every forced reconnect is
  logged client-side and counted server-side.
- `MAX_BUFFERED` drops from 4 MB to 512 KB. Video already backs off correctly
  and asks for a keyframe; the only thing 4 MB buys is a deeper queue in front
  of every control reply.
- `Bun.serve`'s `websocket.idleTimeout` and `sendPings` are set **explicitly**
  (120 s / `true`) rather than inherited, so the values are reviewable.
- `/api/adb/stats` grows a `transport` block: connection count, per-connection
  `bufferedAmount` (max/p95), video bytes/s, and control-reply p50/p95.
- A slow-request logger: any HTTP request over 1 s or WS command over 2 s logs
  once at `warn` with its path and duration.

**Decision — designed, gated on evidence (85.7b):** if the 10-device rung shows
control-reply p95 above 500 ms while `bufferedAmount` is non-trivial, video
moves to a dedicated `/ws/video` socket. Not before: a second socket is real
complexity (two auth paths, two reconnects, two lifecycles) and must be bought
with data.

### 3.7 Rotation

F19 is not a bug, it is an absence. The fix belongs where `keepAwake` already
lives, because it has the identical shape: a device-scoped preference, applied
at session start, reverted at session close, expressed in one place.

**Decision.** `DeviceSettings.prep.rotation: 'device' | 'lock-portrait' |
'lock-landscape' | 'lock-current'`, default `'device'` (today's behaviour,
exactly). Anything else writes `settings put system accelerometer_rotation 0`
plus `settings put system user_rotation <0|1|3>`, and session close restores
`accelerometer_rotation` to whatever it was — read first, restored after, in
the same stateless-and-idempotent style `svc power stayon false` already uses
(`packages/session/src/session.ts:335`).

## 4. Technical design

### 4.1 Settings (`packages/protocol/src/settings.ts`)

```ts
adb: z.object({
  maxConcurrent: /* unchanged */,
  execTimeoutMs: /* unchanged */,
  maxQueueDepth: /* unchanged */,
  maxStreamsPerDevice: /* unchanged, stays 4 */,

  // CHANGED: 0 = auto (computeAutoStreams). A stored 4 is rewritten to 0 by
  // the preprocess below — tracked removal, 00-overview §9.
  maxStreams: z.number().int().min(0).max(64).default(0)
    .describe('Concurrent adb streams allowed across the whole farm. 0 scales it automatically with the number of connected devices.')
    .meta({ title: 'Max concurrent streams (farm-wide)' }),

  // NEW
  maxHostConcurrent: z.number().int().min(1).max(32).default(4)
    .describe('How many adb command-line processes (install, push, forward) may run at once.')
    .meta({ title: 'Max adb CLI processes' }),
  maxInstallConcurrent: z.number().int().min(1).max(16).default(2)
    .describe('How many APK installs or file pushes may run at once across the farm. USB bandwidth is shared.')
    .meta({ title: 'Max concurrent installs' }),
}),

// NEW top-level block
discovery: z.object({
  scanIntervalSec: z.number().int().min(0).max(300).default(10)
    .describe('How often adb is re-scanned for devices the live event stream may have missed. 0 disables the rescan.')
    .meta({ title: 'Device rescan interval (s)' }),
  offlineGraceSec: z.number().int().min(5).max(600).default(20)
    .describe('How long a device may sit in adb’s "offline" state before one automatic reconnect is attempted.')
    .meta({ title: 'Offline grace (s)' }),
  recoveryCooldownSec: z.number().int().min(30).max(3600).default(120)
    .describe('Minimum gap between automatic reconnect attempts for the same device.')
    .meta({ title: 'Recovery cooldown (s)' }),
}).default({ scanIntervalSec: 10, offlineGraceSec: 20, recoveryCooldownSec: 120 }),

monitor: z.object({
  crashWatch: z.enum(['always', 'off']).default('always')
    .describe('Keep a logcat crash feed open on every device with a live session.')
    .meta({ title: 'Always-on crash detection' }),
}).default({ crashWatch: 'always' }),
```

`DeviceSettings.prep` gains:

```ts
rotation: RotationModeSchema.default('device')
  .describe('Lock the screen orientation while a session is open')
  .meta({ title: 'Screen rotation' }),
// export const RotationModeSchema = z.enum(['device', 'lock-portrait', 'lock-landscape', 'lock-current'])
```

Legacy normalisation, alongside `normaliseLegacyPrep`:

```ts
/**
 * `adb.maxStreams` was a fixed 4 before plan 85 — a farm-wide cap identical
 * to the per-device one, which starved any farm past two instrumented
 * devices. Nobody chose it; it was the default. A stored 4 therefore reads
 * as "never configured" and is migrated to 0 (auto). Tracked removal:
 * 2027-02-01, after which a stored 4 means a deliberate 4.
 */
function normaliseLegacyAdb(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && (raw as { maxStreams?: unknown }).maxStreams === 4) {
    return { ...(raw as object), maxStreams: 0 }
  }
  return raw
}
```

### 4.2 Stream-lane autoscaling (`packages/core/src/device/adb-scaling.ts`)

```ts
/**
 * The streaming lane's farm-wide budget (plan 85 §3.1). Derived from what a
 * device actually holds at steady state — the ui-server instrumentation and
 * the crash feed, one slot each, both for the life of the session — plus
 * half a slot of headroom for the bursty users of the lane (a Monitor tab,
 * a file transfer, an APK install).
 *
 *  5 devices → 13    10 → 25    20 → 50    26+ → 64 (the adb server, not
 *  this budget, is the limit past there)
 */
export function computeAutoStreams(nonOfflineDeviceCount: number): number {
  return Math.min(64, Math.max(8, Math.ceil(nonOfflineDeviceCount * 2.5)))
}
```

`recomputeAdbConcurrency` (`packages/core/src/daemon.ts:293-316`) applies it
with the same "log only when the effective value changes" discipline as
`maxConcurrent`, and the same "a non-zero setting always wins" rule.

### 4.3 `AdbClient` additions (`packages/adb/src/client.ts`)

```ts
/** `host:devices-l` → adb's own view, for the reconciler (plan 85 §3.3). */
async listDevices(): Promise<TrackedDevice[]>

/**
 * `host:reconnect-offline` — asks the adb server to re-open its transports
 * for devices stuck in `offline`. NOT `kill-server`: no other tool's session
 * is disturbed, port 5037 keeps its owner.
 */
async reconnectOffline(): Promise<string>
```

### 4.4 The reconciler (`packages/core/src/registry/reconcile.ts`, new)

```ts
export interface DeviceReconcilerDeps {
  client: AdbClient
  registry: { onOnline(serial: string): Promise<void>; onRemove(serial: string): void; knownSerials(): Set<string> }
  settings: () => { scanIntervalSec: number; offlineGraceSec: number; recoveryCooldownSec: number }
  log: Logger
  broadcast: (msg: ServerMessage) => void
}

export interface DeviceReconciler {
  start(): void
  stop(): void
  /** One pass, now — `POST /api/devices/rescan` and the boot sequence both call this. */
  runOnce(): Promise<ReconcileReport>
}

export interface ReconcileReport {
  seen: number
  adopted: string[]        // in adb, missing from the registry → probed
  dropped: string[]        // in the registry, gone from adb
  offline: string[]        // stuck offline past the grace window
  unauthorized: string[]
  reconnectIssued: boolean
  retriesPending: number
}
```

`DeviceRegistry` exposes `onOnline`/`onRemove`/`knownSerials` (today both
handlers are module-private closures) and gains a `retryProbe(serial)` with the
backoff schedule from §3.3.

### 4.5 The host-adb helper (`packages/core/src/device/host-adb.ts`, new)

```ts
export interface HostAdbRunOptions {
  timeoutMs?: number            // default 30_000
  lane?: 'default' | 'install'  // 'install' also takes the install semaphore + the per-device chain
  serial?: string               // required for lane 'install'
}

export interface LongLivedChild {
  readonly pid: number | null
  /** The last 64 KB of stdout+stderr, for diagnostics. Bounded, never the whole session. */
  tail(): string
  kill(): void
  exited: Promise<number>
}

export interface HostAdb {
  run(args: string[], opts?: HostAdbRunOptions): Promise<string>
  spawnLongLived(args: string[], opts?: { onExit?: (code: number, tail: string) => void }): LongLivedChild
  /** Kills every child still running. Called from daemon.stop(). */
  killAll(): void
  stats(): { running: number; maxConcurrent: number; installsRunning: number; longLived: number }
}
```

Error shape on failure:

```
adb -s <serial> install -r -g <path> exited 1 after 4.2s
  stdout: Performing Streamed Install
  stderr: adb: failed to install <path>: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: ...]
```

`daemon.ts` keeps **one** instance and passes it to `makeScrcpy`,
`makeInspector`, the transfer service and the guest-agent routes; both inline
copies at `:1708` and `:1775` are deleted.

### 4.6 Protocol additions (`packages/protocol`)

```ts
// ServerMessage
| { type: 'heartbeat'; payload: { t: number } }          // every 15s, plan 85 §3.6

// ClientMessage — unchanged. The heartbeat is one-way by design: the browser
// cannot observe protocol-level pongs, and a client→server beat would only
// duplicate what every other command already proves.
```

New endpoints:

| Method | Path | Permission | Body / response |
|--------|------|-----------|-----------------|
| `POST` | `/api/devices/rescan` | `device.admin` | → `ReconcileReport` |
| `GET`  | `/api/adb/stats` | `device.view` | **extended** with `transport` and `hostAdb` blocks |

`AdbStatsResponseSchema` gains:

```ts
transport: z.object({
  connections: z.number(),
  bufferedBytesMax: z.number(),
  bufferedBytesP95: z.number(),
  videoBytesPerSec: z.number(),
  controlReplyMsP50: z.number(),
  controlReplyMsP95: z.number(),
  watchdogReconnects: z.number(),
}),
hostAdb: z.object({ running: z.number(), maxConcurrent: z.number(), installsRunning: z.number(), longLived: z.number() }),
```

### 4.7 Windows port-holder lookup (`packages/core/src/doctor/context.ts`)

```ts
// win32: `netstat -ano` gives pid-by-port, `tasklist /FI "PID eq <pid>"` names it.
// Both ship with every Windows install; neither needs elevation for a read.
// Read-only, exactly like the lsof path: no signal is ever sent.
async function findPortHolderWindows(port: number): Promise<PortHolder>
```

And `daemon.ts`'s listen failure stops re-throwing Bun's bare message: on
`EADDRINUSE` it runs the same lookup and reports

```
[error] main: port 7700 is already held by pid 21440 (adb.exe), which is not an Enkaku core.
        Stop it, or set ENKAKU_PORT to a free port. `enkaku doctor` explains more.
```

### 4.8 Boot-time forward cleanup

At startup, after `ensureServer()`: list `adb forward --list`, remove every
entry whose local port falls inside the configured ui-server range
(`ENKAKU_UI_SERVER_PORT_RANGE`, default 27100–27299) **and** whose remote is
`tcp:9008` (the ui-server device port) — ours by construction, nothing else
binds that pair. Logged once with a count. scrcpy forwards use `tcp:0` and
random ports, so they are left alone; they are harmless and indistinguishable
from another tool's.

## 5. Implementation steps

### 85.1 — Stream-lane budget (fixes F1, F2, F7)

- [x] `packages/core/src/device/adb-scaling.ts`: add `computeAutoStreams`, with
      the table from §4.2 in the doc comment. Unit tests for 0, 1, 4, 5, 10,
      20, 26, 100.
- [x] `packages/protocol/src/settings.ts`: `maxStreams` `min(0)`, `default(0)`,
      new description; add `normaliseLegacyAdb` preprocess; add
      `maxHostConcurrent` and `maxInstallConcurrent`.
- [x] `packages/core/src/daemon.ts:293-316`: apply
      `cfg.maxStreams > 0 ? cfg.maxStreams : computeAutoStreams(n)`, log on
      change only, mirroring the `maxConcurrent` branch verbatim.
- [x] `packages/adb/src/client.ts`: when `StreamLane.acquire` refuses, include
      current occupancy and the per-device breakdown in the error message, so
      the log line names which devices hold the slots.
- **Verifiable result:** with five devices connected and no settings row
  changed, `GET /api/adb/stats` reports `streams.maxStreams: 13`; every device
  has both its crash watch and its ui-server running; no
  `E_ADB_STREAM_LIMIT` in the log.

### 85.2 — Discovery that heals itself (fixes F8, F9, F10; tests H3)

- [x] `packages/adb/src/client.ts`: `listDevices()`, `reconnectOffline()`
      (+ unit tests against the existing socket fake).
- [x] `packages/core/src/registry/device-registry.ts`: expose
      `onOnline`/`onRemove`/`knownSerials`; replace the give-up at `:317` with
      `scheduleProbeRetry(serial)` (1 s, 2 s, 5 s, 15 s, 30 s, then per tick);
      replace the `ignored in M0` debug at `:361` with explicit `offline` /
      `authorizing` handling that feeds the reconciler.
- [x] `packages/core/src/registry/reconcile.ts`: new, per §4.4.
- [x] `packages/core/src/daemon.ts`: construct it, `runOnce()` once after the
      tracker starts, then `start()`.
- [x] `packages/core/src/api/devices.ts`: `POST /api/devices/rescan`.
- [x] `packages/studio/src/components/DiscoveredTray.tsx`: a **Rescan** button
      wired to it, with the report rendered as a one-line result
      ("Scanned 5 devices · adopted 1 · nothing else changed").
- [x] `packages/core/src/doctor/checks/devices.ts`: print adb's view **and**
      the registry's, side by side, and fail when they disagree.
- **Verifiable result:** start the core with five phones already plugged in;
  every one appears within one scan interval. Kill a probe artificially
  (unplug mid-probe): the device still appears once replugged *and* once the
  retry succeeds, without a replug.

### 85.3 — One bounded adb CLI helper (fixes F11, F12; tests H4, H5)

- [x] `packages/core/src/device/host-adb.ts`: new, per §4.5. Unit tests: both
      streams drained; stderr present in the thrown error; deadline kills the
      child; the semaphore serialises past its cap; `killAll` kills a
      long-lived child.
- [x] `packages/core/src/daemon.ts`: delete both inline copies (`:1708`,
      `:1775`); pass the single instance everywhere; call `killAll()` from
      `daemon.stop()`.
- [x] `packages/scrcpy/src/session.ts:125-128`: use `spawnLongLived`, keep the
      handle on the session, kill it in `close()`, and report the bounded tail
      when the server exits unexpectedly.
- [x] `packages/drivers/src/inspector/ui-server/launcher.ts:107-111`: installs
      declare `lane: 'install'` and `serial`.
- [x] `packages/core/src/index.ts`: on Windows also handle `SIGHUP` and
      `process.on('beforeExit')` best-effort, so a closed console window still
      reaches `killAll()`.
- **Verifiable result:** `hostAdb.stats().longLived` equals the number of open
  scrcpy sessions; after `Ctrl+C`, `Get-Process adb` shows only the adb server
  itself, no per-device `adb.exe` children; a deliberately broken install
  reports the real `INSTALL_FAILED_*` reason.

### 85.4 — Crash detection that stays alive (fixes F5, F6)

- [x] `packages/core/src/device/monitor-hub.ts`: allow a per-kind clock
      override; the `crash` kind passes `idleTimeoutMs: 0`,
      `absoluteTimeoutMs: 0`, `maxBytes: 32 MiB`.
- [x] `packages/core/src/device/crash-watcher.ts`: on an unexpected
      `handleStreamEnded`, resubscribe with backoff (2 s → 60 s) while the
      session is still open; one `warn` per restart naming the reason; stop
      when the session closes.
- [x] `packages/protocol/src/settings.ts`: `monitor.crashWatch`.
- **Verifiable result:** a device with an open session still has a live crash
  feed after 30 minutes (`/api/adb/stats` shows the slot held continuously),
  and a forced stream kill produces exactly one warn plus one resubscribe.

### 85.5 — ui-server: fail slowly (fixes F17, F18)

- [x] `packages/drivers/src/inspector/ui-server/watchdog.ts`: circuit breaker
      (`maxRestartsPerWindow`, `restartWindowMs`), exponential inter-cycle
      backoff, and a final `warn` that says how many cycles were spent.
- [x] `packages/drivers/src/inspector/ui-server/client.ts`: named per-operation
      timeouts (§3.5); retry once on `UI_SERVER_UNREACHABLE` whose cause is a
      closed socket, after asking the launcher to re-assert the forward.
- [x] Surface `device.inspector.status` transitions in the device Logs tab so a
      degraded inspector is visible in Studio, not only in the console.
- **Verifiable result:** a device whose ui-server cannot stay up degrades to
  `uiautomator-dump` within ~1 minute and then stays quiet; the log contains a
  bounded number of restart lines, never an endless 35-second cycle.

### 85.6 — Windows diagnosability (fixes F13, F14, F20)

- [x] `packages/core/src/doctor/context.ts`: `findPortHolderWindows`
      (`netstat -ano` + `tasklist`), wired into `findPortHolder`.
- [x] `packages/core/src/daemon.ts`: catch `EADDRINUSE` on listen and report
      per §4.7.
- [x] `packages/core/src/util/data-dir-lock.ts`: when a lock is taken over as
      stale, also probe the configured port; if something answers, say so
      instead of proceeding into an unexplained listen failure.
- [x] Boot-time forward cleanup per §4.8.
- [x] `packages/core/src/doctor/checks/`: new `streams` check (lane occupancy
      vs budget) and `host-adb` check (orphaned children, `adb.exe` count).
- **Verifiable result:** starting a second core on Windows prints the holder's
  pid and image name; `enkaku doctor` on Windows shows the same.

### 85.7a — Transport: measure and make it self-healing (tests H1, H2)

- [x] `packages/protocol`: `heartbeat` server message.
- [x] `packages/core/src/daemon.ts`: explicit `websocket: { idleTimeout: 120,
      sendPings: true, ... }`; a 15 s heartbeat broadcast.
- [x] `packages/studio/src/lib/ws.ts`: reset a 45 s watchdog on any inbound
      message; on expiry `console.warn` + `ws.close()` so the existing
      reconnect runs; count the reconnects and report them through
      `onStatus`.
- [x] `packages/core/src/server/ws-handlers.ts`: `MAX_BUFFERED` → 512 KB;
      record control-reply latency and buffered-bytes samples.
- [x] `packages/core/src/api/adb-stats.ts`: the `transport` and `hostAdb`
      blocks from §4.6.
- [x] Slow-request/slow-command logger (1 s HTTP, 2 s WS), one line each,
      rate-limited to once per path per 10 s.
- **Verifiable result:** the numbers exist and are read at every rung of §7.3.

### 85.7b — Split video onto its own socket (conditional)

Executed **only if** the 10-device rung records control-reply p95 > 500 ms with
non-trivial `bufferedBytesP95`. Design: `/ws/video` carries binary frames only,
authenticated by the same ticket/cookie path; `/ws` keeps JSON. Studio's
`WsClient` gains a second connection with the same reconnect logic; `LiveView`
subscribes to the video socket only. If the rung does not show it, this step is
recorded as "not needed, with the measurement that showed it" and skipped.

**Outcome, recorded at 85.9 (documentation close-out): not executed — the
gating measurement has not been taken.** The trigger is a specific number
read from a specific rung (10-device, real Windows hardware, the release
binary, §7.3) and that rung has never been run against this codebase's
current state. This is deliberately **not** the same claim as "not needed" —
"not needed" would mean the rung ran and showed p95 ≤ 500 ms with a trivial
buffer, which is itself a real, recorded outcome this plan anticipated
(previous paragraph). Neither happened. §8's own risk table names the exact
failure mode this note exists to prevent: *"85.7b never gets built because
the rungs never quite trigger it."* Writing "not executed — measurement not
taken" down here is what keeps that a decision someone can act on (run the
ladder, read the number, build or close this step) rather than a plan that
quietly stops mentioning an unbuilt step until nobody remembers it was
conditional at all.

### 85.8 — Rotation control (fixes F19)

- [x] `packages/protocol/src/settings.ts`: `RotationModeSchema`,
      `DeviceSettings.prep.rotation`.
- [x] `packages/session/src/wake.ts` (or a sibling `orientation.ts`): read the
      current `accelerometer_rotation`, apply the lock, and return a revert
      thunk; called from `createSession` next to `wakeDevice`.
- [x] `packages/session/src/session.ts:335`: revert on close, next to
      `svc power stayon false`, stateless and idempotent.
- [x] `packages/studio`: the device Settings panel exposes it; the device page
      gets a rotation quick-action reading the same setting.
- **Verifiable result:** with `lock-portrait`, rotating the physical device
  does not rotate the screen; closing the session restores the device's
  previous auto-rotate state exactly.

### 85.9 — Documentation

- [x] `packages/adb/README.md`: the two budgets, and the auto formulas for
      both.
- [x] `packages/core/README.md`: the reconciler, `host-adb`, and the new
      settings.
- [x] `docs/guide/install.md`: a Windows section — what "port already in use"
      now tells you, what Rescan does, and the fleet-size settings worth
      raising past 20 devices.
- [x] `docs/plans/00-overview.md` §9: the `maxStreams: 4 → 0` migration, with
      its removal date.

## 6. Acceptance criteria

**Hardware-verification status, recorded at 85.9 close-out.** Every criterion
below is implemented and covered by the unit tests in §7.1, and the full
suite (`bash scripts/typecheck.sh`, `bun test`, `bun run --cwd packages/studio
test`) is green. That is a different claim from "verified on hardware."
Criteria 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, and 16 each describe
field behaviour on a real multi-device Windows farm, and criterion 15
explicitly requires the §7.3 ladder to be filled in — none of that has been
run (see §7.3's own note). Read every one of those criteria as
**implemented-and-unit-tested, not hardware-verified**, until someone runs
the ladder against real devices and either confirms them or files what does
not hold.

1. With `adb.maxStreams` unset, `/api/adb/stats` reports a farm-wide budget of
   13 at 5 devices, 25 at 10, and 50 at 20. A stored `4` from an older install
   reads as `0` after one boot.
2. Twenty devices, each with a live session and an attached inspector, produce
   **zero** `E_ADB_STREAM_LIMIT` entries over a 30-minute run.
3. A device plugged in **before** the core starts is enrolled (or lands in the
   Discovered tray) within one `discovery.scanIntervalSec`, with no replug.
4. A device stuck `offline` in adb gets exactly one `reconnect-offline` per
   cooldown window, logged, and recovers without `kill-server`.
5. A probe that fails is retried on the documented backoff and succeeds without
   human action once the device is ready.
6. `POST /api/devices/rescan` and the Studio **Rescan** button both return a
   `ReconcileReport`, and the report is rendered.
7. Every adb CLI failure message contains the process's **stderr**. A
   deliberately failing `install` names its real `INSTALL_FAILED_*` reason.
8. No `adb.exe` child of the core survives `Ctrl+C` on Windows, verified with
   `Get-Process`.
9. Concurrent installs never exceed `adb.maxInstallConcurrent` farm-wide, and
   never two on one device.
10. A crash feed on a device with a 30-minute session is still open at the end
    of it; a forced kill produces one warn and one resubscribe, not silence.
11. The ui-server watchdog stops after its circuit breaker fires; the log
    contains a bounded, countable number of restart lines.
12. `dumpWindowHierarchy` on a content-heavy screen no longer fails at 3 s.
13. On Windows, a port conflict names the holding pid and image, both at
    startup and in `enkaku doctor`.
14. Studio recovers from a silent WebSocket within 45 s, without closing the
    tab, and says so in the console.
15. `/api/adb/stats` reports the `transport` and `hostAdb` blocks, and the
    §7.3 ladder is filled in for 5, 10 and 20 devices.
16. `prep.rotation: 'lock-portrait'` holds the orientation for the whole
    session and restores the device's prior setting on close.
17. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test`
    are green. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|------|------|--------------------|
| stream autoscale | `packages/core/src/device/adb-scaling.test.ts` | the table in §4.2, plus the floor and ceiling |
| settings migration | `packages/protocol/src/settings.test.ts` | stored `4` → `0`; stored `7` untouched; a fresh row is `0` |
| lane refusal message | `packages/adb/src/client.test.ts` | the error names occupancy and the holding serials |
| `listDevices` / `reconnectOffline` | `packages/adb/src/client.test.ts` | protocol framing, including the zero-length block |
| reconciler | `packages/core/src/registry/reconcile.test.ts` | adopts an unknown `device`; drops a vanished one; issues at most one reconnect per cooldown; honours `scanIntervalSec: 0` |
| probe retry | `packages/core/src/registry/device-registry.test.ts` | the backoff schedule; cancelled when the device disappears |
| host-adb | `packages/core/src/device/host-adb.test.ts` | stderr drained and reported; deadline kills; semaphore bounds; `killAll` |
| crash feed | `packages/core/src/device/crash-watcher.test.ts` | resubscribes with backoff; stops on session close; one warn per restart |
| watchdog | `packages/drivers/src/inspector/ui-server/watchdog.test.ts` | the breaker fires; backoff grows; `dead` is terminal |
| WS watchdog | `packages/studio/src/lib/ws.test.ts` | 45 s of silence forces a reconnect; any message resets it |
| rotation | `packages/session/src/orientation.test.ts` | applies, reverts, and is idempotent when called twice |

### 7.2 Local smoke (macOS / Linux dev box, 1–2 devices)

```bash
bun run typecheck
bun test
bun run --cwd packages/studio test
bun run dev                                     # core on :7700
curl -s localhost:7700/api/adb/stats | jq '.streams, .hostAdb, .transport'
curl -s -XPOST localhost:7700/api/devices/rescan | jq
bun run doctor
```

Then, with one device: open the Wall, attach the Inspector, leave it 15
minutes, and confirm the crash slot is still held and no restart storm appears.

### 7.3 The Windows ladder — 5 → 10 → 20

**Status, recorded at 85.9 close-out: outstanding — not run.** Everything
below needs the actual Windows client with the release binary and a real
multi-device farm; none of it can be produced from this development
environment, and none of it has been produced anywhere else either. The
table's blank cells are not a formatting placeholder — they are the honest
state: this ladder has not been executed at 5, 10, or 20 devices. Acceptance
criterion 15 ("the §7.3 ladder is filled in") is therefore not met, and
85.7b's gate (10-device rung, previous section) cannot be evaluated until
this is run. Whoever runs it next should treat every row here as still open.

Run on the actual Windows client, with the release binary, one rung at a time.
**Do not advance a rung until the previous one is green.** Record the table;
an empty cell is a failed rung, not a skipped one.

Per rung, boot the core with **every device already plugged in** (that is the
reported failure mode, so it is the default condition, not a variant), then:

| Measurement | How | 5 | 10 | 20 |
|-------------|-----|---|----|----|
| devices visible within 60 s | Studio device list | | | |
| devices needing a replug | count | **0** | **0** | **0** |
| `streams.maxStreams` | `/api/adb/stats` | 13 | 25 | 50 |
| `streams.active` at steady state | same | | | |
| `E_ADB_STREAM_LIMIT` count / 30 min | log grep | **0** | **0** | **0** |
| wall tiles showing a picture | Wall, `wall.maxTiles` raised to the rung size | all | all | all |
| time to first frame, last tile | stopwatch | | | |
| `hostAdb.installsRunning` peak | `/api/adb/stats` polled 1 Hz | ≤2 | ≤2 | ≤2 |
| ui-server restart lines / 30 min | log grep | | | |
| control-reply p95 | `/api/adb/stats` | | | |
| `bufferedBytesP95` | same | | | |
| slow-request warns / 30 min | log grep | | | |
| WS watchdog reconnects / 30 min | browser console | | | |
| page load, cold tab, while all tiles live | DevTools | | | |

Additional per-rung checks:

```powershell
# no orphans after a clean stop
Get-Process adb -ErrorAction SilentlyContinue | Select-Object Id, StartTime
# who holds the port, if the core refuses to start
netstat -ano | Select-String ":7700"
.\enkaku.exe doctor
```

Rung-specific probes:

- **5 devices** — the reported baseline. Reproduce the original complaint
  first (all five plugged in before boot, Wall open, Inspector attached to
  two) and confirm it no longer reproduces.
- **10 devices** — the rung that decides 85.7b. If control-reply p95 > 500 ms
  with a non-trivial buffer, execute the split; otherwise record the numbers
  and skip it, in writing.
- **20 devices** — the rung that stresses the browser: also record decoder
  count, tab CPU, and whether the per-tile binary fan-out
  (`packages/studio/src/lib/ws.ts:78-82`) shows up in a profile. If it does, it
  becomes its own plan rather than being patched here.

### 7.4 Regression watch

- A device farm with `adb.maxStreams` pinned to a number keeps using that
  number (the autoscaler must never override an explicit setting).
- `discovery.scanIntervalSec: 0` disables the reconciler entirely and the
  tracker-only behaviour is exactly as before this plan.
- `monitor.crashWatch: 'off'` frees one slot per device and breaks nothing
  else.

## 8. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| A larger stream budget shifts the bottleneck onto the adb server or the USB controller, trading a clear error for a slow one. | The budget is a ceiling, not a target; §7.3 records `streams.active` at every rung so the real steady state is known. The ceiling of 64 and `maxStreamsPerDevice: 4` both stay. |
| `reconnect-offline` disturbs another tool sharing port 5037. | It is a host-level re-open, not a server restart, and it is rate-limited per serial by `recoveryCooldownSec`. `kill-server` remains forbidden. |
| The reconciler double-probes a device the tracker is already probing. | `probesInFlight` already dedupes by serial; the reconciler goes through the same `onOnline`. |
| The settings migration rewrites a deliberate `maxStreams: 4`. | Documented as a tracked removal with a date; an operator who wants 4 sets it again after upgrading and it then survives (only the *first* boot after upgrade migrates). Called out in the release notes. |
| Bounding installs to 2 makes a 20-device inspector attach slow. | It is already slow — it is currently slow *and* failing. The bound is a setting; §7.3 records the real cost. |
| Killing child processes on shutdown kills something we did not start. | The registry only holds children this helper spawned; `killAll` never enumerates the system. |
| `MAX_BUFFERED` at 512 KB makes video stutter on a slow link. | Video already handles congestion correctly (stop, request a keyframe, resume). A stutter that reports itself is preferable to a UI that hangs. The rung measurements decide whether to tune it. |
| A 45 s client watchdog reconnects on a merely-idle link. | The 15 s heartbeat guarantees traffic; three missed beats is a dead link, not an idle one. |
| Rotation lock leaves a device stuck if the core dies mid-session. | The revert is idempotent and re-applied at the next session start; the reconciler's `onOnline` path is the natural place to normalise it, the same way `stayon` already is. |
| 85.7b never gets built because the rungs never quite trigger it. | The trigger is a written number, checked at a written rung, with the outcome recorded either way. |

## 9. Open questions

1. **Should the crash feed be per-session or per-device?** Today it starts on
   `session.opened` and stops on `session.closed`, so a device with no viewer
   has no crash detection at all. Making it per-device would detect crashes
   during unattended job runs that open no session — but costs one permanent
   stream slot per connected device regardless of use. This plan keeps the
   current lifetime and only stops it dying early; changing the lifetime is a
   product decision.
2. **If H4 is wrong and a tile still freezes after 85.3**, the next suspect is
   the scrcpy transport itself (one blocked adb stream stalling a device's USB
   transport). Confirming that needs a device-side capture and belongs in its
   own plan, not here.
3. **Is 20 devices on one Windows host the right target at all?** At that size
   the adb server, one USB controller tree, and one browser tab are each
   plausible ceilings before any Enkaku budget is. The §7.3 numbers should be
   read as "where does this host actually stop", and the answer may be "split
   into two hosts and use the node/cloud path (plan 61)" rather than "tune
   further".
4. **`prep.rotation: 'lock-current'`** needs a defined meaning when the device
   is asleep at session start and has no meaningful current orientation.
   Proposal: treat it as `lock-portrait` and log the substitution — but this is
   a UX call, not a technical one.
