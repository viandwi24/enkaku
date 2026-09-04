# @enkaku/session

`DeviceSession` — the driver layers assembled for one device (transport,
display, input, inspector, and — when configured — network; spec §7.9),
shared and refcounted across every viewer, plus the per-job subprocess
runner (`runner/`) that turns a published script into a running job.

## `plugin-context.ts` — the one `PluginContext` builder (plan 109 §3.1, step 109.1)

A surprising thing to find in this package, so the reason is written on the file itself and repeated here: `buildPluginContext` is the single function that assembles the context **every** plugin entry point receives — a script handler, and (once the host lands in 109.2) an HTTP, WebSocket, event or query handler. Two builders would agree today and disagree in three months, which is why plan 109's acceptance criterion 2 is a fixture called from both ends rather than a promise.

It lives here because this is the only package both hosts can reach:

- the job **child** process is `runner/child-entry.ts`, in this package;
- the **core** depends on `@enkaku/session`, and `@enkaku/session` must never depend on `@enkaku/core` — so a builder in `packages/core` (where plan 109 §4.8 first put it) is unreachable from the child;
- `@enkaku/sdk` cannot host it either: `ctx.storage`'s client (`createKvApiFor`) and the `KvCall` wire schema are both here, and moving them would split a Zod schema from the type it generates.

`packages/core/src/plugins/plugin-context.ts` is the core's port bindings and its single door onto this function — not a second builder. Each host supplies three primitive ports (emit one log line, make one KV round trip, invoke one capability) and this file owns the shape, the scoping rules and the coded refusals. Passing only functions is also what makes plan 109's criterion 11 — *no `Db`, `KvStore` or capability registry reachable from `ctx`* — true by construction: there is nothing here to leak.

## The input arbiter: three lanes, not one mutex (plan 91 §3.3, §4.1)

`createInputArbiter` (`src/input-arbiter.ts`) sits between every caller of a
device's `InputSink` and the sink itself. It exists because the sink has
**no serialisation of any kind** — a tap is `write(down)` → `await` →
`write(up)`, a swipe is `write(down)` → N × `write(move)` → `write(up)`, and
both run against one shared virtual pointer with one position and one touch
bit. Two overlapping callers writing to it directly do not produce two taps;
they produce one incoherent gesture, because nothing in the byte stream
identifies which caller a given `write()` belongs to. Plan 91 (letting a
human reach into a device a job is driving — since superseded by plan 205's
activity model) made two callers possible for the first time, so an arbiter
had to exist before authorisation did — shipping the grant without it would
have shipped the feature and a silent input-corruption defect in the same
commit.

**Why three lanes, and not one queue.** The obvious fix — a single per-device
mutex around all input — is correct and badly wrong for the product: a
script's `typeText` of 200 characters at 80 ms/char holds the mutex for 16
seconds, during which a human trying to press volume-up (one of the two
motivating examples for this whole feature) would simply wait. The lanes are
split on what the wire protocol actually allows to be separable, not on
convenience:

| Lane | Verbs | Why it must be its own lane |
|---|---|---|
| `pointer` | `tap`, `swipe`, `gesture` | Stateful: down/move/up against `UHID_POINTER_ID`, the one shared virtual pointer. Must be atomic against every other pointer action, or the two interleave into one bad gesture. |
| `keys` | `key` | `injectKeycode` down+up is ~30 ms and does **not** touch the pointer's state — only `ScrcpyUhidInput` overrides the pointer path; a key never goes near it. A key pressed mid-drag is exactly what a real phone sees when someone presses volume while dragging, and Android already handles that fine. |
| `text` | `text`, `typeText` | `injectText` is a single stateless control message per call — nothing about it can straddle another action the way a pointer sequence can. |

The consequence the owner's own example depends on: a human's volume-up
keypress costs **zero wait**, even while a job's 16-second `typeText` is
running, because they are different lanes.

**Rules inside each lane:**

- **FIFO, non-preemptive, priority by source.** A `user` (the operator
  actually driving the device — plan 205 §5 step 205.10 reworked this from
  the old three-way split) jumps ahead of *queued* `job`/`agent` actions, but
  never interrupts one already running — preempting mid-gesture would
  reintroduce exactly the corruption the arbiter exists to prevent. `job` and
  `agent` share a priority and settle by arrival order.
- **Bounded, and every refusal names what it waited for.** `queueWaitMs`
  (read fresh on every submission, so a farm setting change takes effect on
  the very next action) and `maxQueueDepth` cap how long and how deep a lane
  may queue; past either, the arbiter throws `SessionError('E_INPUT_BUSY', …)`
  with a message like *"the job's swipe is still running (waited 5.0 s)"* —
  never silently dropped, never queued forever.
- **`for(source): InputSink`** returns a façade bound to one `InputSource`
  (`{ kind: 'user' | 'job' | 'agent', id, userId }`, `id` matching the
  activity registry's own marker id — plan 205 §4.2) — every existing
  production caller of the raw sink migrated to
  `session.arbiter.for(source).*` in the same commit that added the arbiter
  (per `00-overview.md` §4.3, "replace, never version"); `session.input`
  remains the raw sink, touched only by the arbiter itself.
- **`stats()`** reports `{ depth, running, waitMsP50, waitMsP95, refusals }`
  per lane, the source `GET /api/adb/stats`'s `input` block reads from
  (`packages/core/README.md`).

**No `onAction` callback.** The arbiter's constructor originally sketched an
`onAction` hook meant to feed the attribution work — a subordinate-grant
mechanism plan 205 §3.2 item 8 deleted outright rather than renamed. It
shipped with no producer wired to it and nothing reading its output:
attribution instead goes through `ws-handlers.ts`'s own `input.*` branch,
which records the control marker directly, inline, at the exact call site
that already has the verb-specific payload (tap position, swipe endpoints,
redacted text) a generic completion event never carried. The dead callback
was found and removed 2026-08-13
(`docs/plans/96-m61-hotfixes.md` §96.13) rather than left wired to nothing —
see `src/input-arbiter.ts`'s own header comment for the full account.
`adb-input` (the crude fallback engine) needs no lane logic of its own: it is
already serialised by `@enkaku/adb`'s per-device command queue, so the
arbiter is a redundant safety net there, not a second queue.

## `DeviceSession.arbiter`

`DeviceSession` (`src/session.ts`) carries `arbiter: InputArbiter` beside its
existing `input: InputSink`. The arbiter's `queueWaitMs`/`maxQueueDepth` are
threaded through from `SessionManagerDeps.arbiterQueueWaitMs`/
`arbiterMaxQueueDepth` (both `() => number`, optional — omitted falls back to
`DEFAULT_ARBITER_QUEUE_WAIT_MS` = 5000 / `DEFAULT_ARBITER_MAX_QUEUE_DEPTH` =
32) down through `CreateSessionDeps`, read fresh on every submission so a farm
setting edited mid-session would take effect for that same session
immediately, with no restart and no re-open — **but there is no such farm
setting any more**: the old second-operator-grant subsystem these two
accessors were fed from is gone (plan 205 §2.4), and nothing replaced it, so
`daemon.ts` now leaves both accessors unset and every session runs on the two
hardcoded defaults above regardless of farm size (`daemon.ts`'s own comment
beside `deviceIsAwake` has the full account).

## Video profiles: two quality profiles, one resolver (plan 92 §3.5, §3.6, §4.2)

Every session encodes at one of exactly two profiles, named by `Quality`
(`'control' | 'wall'`) — the device page is *driven*, the wall is *watched*,
and the two are tuned separately rather than sharing one set of numbers.
Each profile is three numbers: `maxSize` (longest edge, px), `maxFps`, and
`bitRate` (bits/sec). Nothing else reaches scrcpy's `max_size`/`max_fps`/
`video_bit_rate` arguments.

### The preset tables

`CONTROL_PRESETS` and `WALL_PRESETS` (`src/video-profile.ts`) are the named
presets an operator picks from — a preset is a sentence ("Balanced"), not a
set of numbers an operator has to already know:

| Control preset | `maxSize` | `maxFps` | `bitRate` |
|---|---|---|---|
| `sharp` (default) | 1600 | 30 | 4 Mbit/s |
| `balanced` | 1080 | 30 | 2.5 Mbit/s |
| `light` | 720 | 20 | 1.2 Mbit/s |

| Wall preset | `maxSize` | `maxFps` | `bitRate` |
|---|---|---|---|
| `detailed` | 720 | 8 | 1.5 Mbit/s |
| `balanced` (default) | 480 | 5 | 800 kbit/s |
| `light` | 320 | 3 | 400 kbit/s |
| `minimal` | 240 | 2 | 200 kbit/s |

`control.sharp` and `wall.balanced` are **pinned to the pre-plan-92
constants** (the old `QUALITY_PROFILES` this file replaced), on purpose: a
farm that changes nothing gets byte-identical scrcpy arguments to before
this existed, proven by `video-profile.test.ts` pinning these exact numbers
rather than only asserting internal consistency — a typo in either table
fails that test, not just drifts silently.

### Resolution precedence

`resolveVideoProfile(farm, device, quality)` is the **one** place a farm's
video settings and a device's own override combine into the numbers a
session actually starts its encoder with. Precedence, most specific first:

```
device field (DeviceSettings.video, all-optional) →
farm field (FarmSettings.video, fully populated, no optional fields) →
preset table (CONTROL_PRESETS / WALL_PRESETS)
```

`FarmSettings.video` is deliberately **not** folded into
`FarmSettings.defaults` (the `DeviceSettings` shape copied into a device row
at admission) — that seam is applied once, at admission, and never read
again (spec: farm defaults are a template, not a live fallback), so a
farm-wide video setting expressed that way would reach devices enrolled
after the change and nothing else. `FarmSettings.video` is read **live**,
at session-build time and on every `reprofile` pass, from `settingsStore` —
the same freshness discipline every other per-session accessor here uses.

The function is pure (no clock, no I/O, no settings-store read inside it),
so `reprofile`'s own comparison and every Studio readout can call it and
can never disagree with each other or with what actually reached scrcpy.
It also reports, per field, where the resolved number came from
(`VideoSource`: `'preset' | 'farm' | 'device'`) — rendered, never
recomputed, by the settings screens (`packages/studio/src/components/video/`).

`wall.maxTiles: 0` means **auto**, not zero — read literally it would cap
the wall at zero tiles, which is exactly the bug `computeAutoTiles` exists
to prevent being read that way anywhere downstream. `0` divides a fixed
20 Mbit/s per-tab video budget (`WALL_VIDEO_BUDGET_BPS`) by the farm's
*resolved* wall bitrate, clamped to `[4, 32]`:

```
computeAutoTiles(wallBitRate) = clamp(floor(20_000_000 / wallBitRate), 4, 32)
//   800 kbit/s (balanced, default) → 25 tiles
//   1.5 Mbit/s (detailed)          → 13 tiles
//   400 kbit/s (light)             → 32 tiles (ceiling)
//   4 Mbit/s (control numbers put into the wall profile) → 5 tiles
```

Raising wall picture quality therefore **lowers the live-tile count
automatically** — the two knobs draw from one budget, so no combination of
settings can ask a browser tab for more video than it was ever sized for. A
*non-zero* `wall.maxTiles` always wins over the derived number (the same
"a pinned setting always wins" convention `adb.maxConcurrent`/
`adb.maxStreams` already use) — an operator on an unusually fast or slow
link pins the number instead of fighting the formula. `GET /api/adb/stats`
reports `video.maxTiles`/`video.maxTilesAuto` as the number **actually
applied** (already resolved server-side), never the raw stored `0` — a
client reading the raw setting directly would see auto's `0` and cap itself
at zero tiles, which is exactly the trap `packages/studio/src/components/
wall/Wall.tsx` was written to avoid (see that package's own README).

### What a re-profile does to a live session

Nothing re-reads a profile after a session starts by default — the numbers
above are resolved once, at `createEntry` time, and baked into the encoder
`scrcpy-server` was launched with. Changing a farm or device video setting
after that point does nothing to sessions already open **unless** something
explicitly restarts them, which is `reprofile`'s entire job (plan 92 §3.8):

```ts
reprofile(reason: string): Promise<{
  restarted: string[]
  skippedBusy: string[]
  unchanged: number
}>
```

Five rules, in order:

1. **Compares resolved numbers, not settings identity.** Every open
   session's `videoProfile` (the numbers it was actually built with) is
   compared against a freshly-resolved profile via `sameVideoNumbers` — a
   settings save that changes an unrelated field (or changes a field back
   to the value that produces the same numbers) restarts nothing.
2. **Debounced and coalesced**, driven from `settingsStore.onChange` (a
   farm-settings PATCH can fire the same callback several times as an
   operator edits a form field by field) and from the per-device PATCH
   route when `changedKeys` includes `video`. The core wires a 500ms
   debounce around this — see `packages/core/README.md`.
3. **Every restart goes through `restartAt`**, coalesced per `(deviceId,
   quality)` the same way a fresh build is — two reprofile passes racing
   the same entry restart it exactly once.
4. **Never mid-job.** A device whose `status` is `busy` is collected into
   `skippedBusy` and its session object is left completely untouched — not
   even a phase event. **This is a deliberate blast-radius bound, not an
   oversight**: video keeps running while a device is busy, and a settings
   save must never be the thing that interrupts a script mid-gesture. A
   busy device picks up the new profile the next time its session is
   built from scratch (its next `stream.start` after the job releases it),
   not before.
5. **It is silent on the wire, and that is deliberate.** Plan 206 §2 retired
   the phase-progress message this restart used to narrate through — after
   that plan a reprofile is a brief dark tile that repaints, with the
   `'video_reprofile'` reason still recorded to the device event log for an
   operator who goes looking, but no longer announced live on the tile
   itself. A later plan may add an activity for it.

`restartAt(deviceId, quality, detail?)` is the mechanism underneath — the
generalisation of what used to be a `wall → control` upgrade special case
only (`upgradeToControl`). It keeps its `upgrading` coalescing map and its
subscriber/refcount carry-over verbatim: a restart is invisible to a viewer
already watching (the same `<video>`/canvas element goes dark and comes
back, no re-subscribe), which is what makes rule 4's "picture never
breaks" claim true for the devices that *aren't* skipped too.

## Rotation control (`src/orientation.ts`, plan 85 §3.7)

`applyRotation`/`DeviceSettings.prep.rotation` (`'device' | 'lock-portrait' |
'lock-landscape' | 'lock-current'`, default `'device'`) is applied at session
start and reverted on close, restoring both `accelerometer_rotation` and
`user_rotation` to whatever they were before the session touched them — not
only the auto-rotate flag, since a device already manually locked to
landscape before the session started needs that put back too. `'lock-current'`
reads the live `SurfaceOrientation` and falls back to `lock-portrait` (logged)
when the device has none to read, e.g. asleep at session start — see
`docs/plans/85-m50-windows-fleet-scale.md` §9 Q4, an unratified proposal, not
a settled product decision.

## The job-trace tee at the `device.call` boundary (plan 128, M93)

`src/runner/trace.ts` is the same tee `packages/core/src/recording/session.ts`
already runs for the *manual* input path (plan 94), moved one boundary over:
from `ws-handlers.ts`'s `input.*` branch to `job-runner.ts`'s `device.call`
branch. The child process never opens adb itself — every action a script takes
crosses that one boundary, in order, with its arguments already Zod-parsed by
`DeviceCallSchema` — so one wrap of `execDevice` sees the whole run.

**The tee must observe, never alter.** `begin()` is synchronous and returns a
token; `end()` is synchronous, returns `void`, and neither ever throws. Every
genuinely async consequence — a screenshot, a UI-tree snapshot, the host's own
database write — is started inside `end()` and is never on the critical path
the real device call sits on, including the host's `emit` callback, which is
wrapped so a trace consumer that throws cannot take the job with it. A host
that wires no `onTraceEvent` gets `createNoopTraceTee()` instead, so the call
sites in `job-runner.ts` are unconditional and there is no `if (tracing)`
anywhere on the hot path. `ScriptContext` gains nothing and `DeviceCallSchema`
is not extended: the tee consumes them, it does not change them.

This module does **no I/O**. It owns exactly three things — argument redaction,
capture-policy resolution, and the bounded capture ceiling — and takes
`emit(event)`, `capture(request)` and an `engineId()` accessor injected. It
also does **not** assign `id` or `seq`: it emits `TraceEventInput`
(`Omit<JobTraceEvent, 'id' | 'seq'>`) and the core's recorder is the single
`seq` authority, because `job_events` carries `uniqueIndex(jobId, seq)` and a
job that infra-retries would otherwise build a second tee with a second
counter, both starting at 1 for one job id. The tee's contract is **order**;
numbering is the recorder's.

**The capture policy is derived from the resolved inspector engine, never
configured** — `resolveFramePolicy(session.inspectorEngineId)`, read per
attempt and re-stated on every `phase` `start` event's `meta`:

| `inspectorEngineId` | Frame policy | Why |
|---|---|---|
| `ui-server` | `per-action` — one frame beside every device call, no sampling, no cap | JSON-RPC over an `adb forward` socket; it never acquires the per-device adb semaphore, so it cannot queue ahead of or behind a script's own call |
| anything else (`uiautomator-dump`, and any engine added later) | `on-failure` — the failing action only | `screencap` goes through the per-device queue, which is plain FIFO with no priority: a background capture inserted between two script calls adds its full duration to the script's next one. A job that has already failed has nothing left to slow down. An unmeasured engine is assumed to contend — that is the safe assumption for the script |
| `null` (no inspector) | `none` | there is nothing to capture with |

UI trees are free wherever the call already produced one (`dump`, `find`,
`waitFor` are requested as `'reuse'`, so the host never goes back to the
device for them) and captured for the failing action. `screenshot` and the
`artifact.save` screenshot path reuse the script's own bytes rather than
taking a second picture.

Captures are bounded at `MAX_CONCURRENT_CAPTURES` (4) outstanding per job, not
serialised behind a single slot. One slot was tried first and was wrong: a
script is quicker than a screenshot, so most actions recorded `skipped-busy`
and no frame at all — quietly defeating the one-action-one-frame rule the
feature exists for. It is bounded rather than unlimited because on `ui-server`
a screenshot travels the **same** on-device RPC channel as the script's own
`find` and `click`, and uiautomator serves that channel one call at a time;
captures allowed to pile up there put the script behind its own debugging.
At the ceiling a capture is **dropped, never queued**.

A dropped frame never costs the tree. A `dump`/`find`/`waitFor` already
returned its tree, so storing it touches no device: the saturated path stores
it anyway and marks the event `meta.frameDropped: 'busy'`. Statuses stay
honest — `'skipped-busy'` when the ceiling was saturated (never `'skipped-policy'`,
which would claim the engine was never going to take a picture), `'failed'` when
a capture threw or timed out, `'skipped-policy'` when the policy genuinely
declined. A timeline never omits a frame silently, and no capture can fail a
job.

The number 4 is **not measured on hardware** — see plan 128 §9b.

Arguments reach `meta.args` redacted (`ARG_REDACTION`, one entry per
`DeviceCallMethod` so a new verb is a compile error until somebody decides):
`type` and `clipboard.set` store `{ length: n }` and never the text, and any
single value whose JSON exceeds 512 bytes is replaced by a truncation marker
naming its size — the rest of the object survives, so a `find` keeps the
selector that makes it worth reading.

An action event is emitted when its **capture** settles, not when the call
does, but its `atMs` is stamped at `begin()` — so it lands on the axis at the
instant the action really started. Log lines are never held behind a capture.
That is why `seq` (arrival order at the recorder) is the right keyset cursor
and the wrong display axis; see `packages/core/README.md`'s companion section.

## Always-on sessions (`src/always-on.ts`, `src/manager.ts`, plan 206)

A session is built the instant a device comes online and lives until it goes
offline — never built lazily by a browser's `stream.start`, never torn down
by an idle timer (MVP 11 §1.1). Two modules split the responsibility:

- **`manager.ts`'s `SessionManager`** owns the entries themselves: `build()`
  constructs the one BASE (`wall`) entry a device holds for as long as it is
  online; `acquire()`/`release()` are for job/readiness callers that only
  ever want that base entry and never build one; `attachViewer()`/
  `detachViewer()` are for WS viewers (`ws-handlers.ts`), which may ask for
  `control` quality.
- **`always-on.ts`'s `createAlwaysOn`** is the builder: it queues a build the
  moment `deviceOnline(id)` fires, staggers pending builds by USB root
  (`buildsPerUsbRoot`, default 4) and a farm-wide ceiling
  (`SESSION_BUILD_FARM_CEILING`, 16, overridable by
  `ENKAKU_SESSION_BUILD_CEILING`), retries a dead or failed build under a
  fixed backoff (`REBUILD_BACKOFF_MS`: 1s, 3s, 10s, 30s, then 30s
  repeated), and starts the inspector prewarm
  (`INSPECTOR_PREWARM_DELAY_MS`, 2s after the first frame — plan 208 fills
  in the body) once per successful build.

### The five steps

The activity sentence a device shows while it has no picture yet
("Preparing, step 3 of 5") names the session's own build phases, in the
order `createSession` actually runs them — the order is load-bearing, not
cosmetic (MVP 02 §2.1):

| Step | Phase | What runs |
|---|---|---|
| 1 | `connecting` | adb transport connect |
| 2 | `waking` | `wakeDevice`, skipped (but still reported) when the readiness manager already holds the screen |
| 3 | `starting-video` | jar push, port forward, scrcpy-server launch, video and control sockets |
| 4 | `waiting-frame` | sockets up, no picture yet |
| 5 | `ready` | first frame received — the `prep` activity ends here, and the inspector prewarm timer starts |

### The encoder split

At most **two** encoders per device, ever: the BASE (`wall`) entry, built by
the always-on builder and running for the whole time the device is online,
and the CONTROL entry, built on demand the instant a `control`-quality
viewer attaches and closed `CONTROL_LINGER_MS` (15s) after its last viewer
detaches. A `control` attach never waits on a build: it is served by the
already-running wall entry first (`ViewerAttach.substitute: 'wall'`) and
switched onto the control entry the moment its first real keyframe arrives
(`ViewerHooks.onSwitched`) — nothing is transcoded or upscaled server-side,
the browser simply draws a sharper frame into the same canvas. A control
build that cannot produce a real second scrcpy session calls
`ViewerHooks.onControlFailed` instead; the viewer stays on the wall entry.

### The activity port

`always-on.ts` cannot import plan 205's real `ActivityRegistry` directly —
`@enkaku/core` depends on `@enkaku/session`, never the other way around
(`00-overview.md` §4.1). `ActivityPort` is the seam: a core wires a real
adapter over the registry (`daemon.ts`); a test, or a core built without
plan 205, gets `noopActivityPort`.
