# Plan 40 — M17f : Input Realism — Gesture Kinematics and Typing Cadence

> Status: draft
> Depends on: **Plan 34** (which reconnects the Timing settings that are currently saved and never read — building on top of a dead setting would be building on sand). Plan 08 for the scrcpy input engines.
> Spec references: §9.3 (timing realism), §9 (script API), §13 (protocol).

---

## 1. Goals

- A swipe follows a realistic motion path — curved, eased, with a real release velocity — instead of a straight line at constant speed.
- `fling` and `scroll` become first-class actions, because "scroll a list" is what authors actually mean and a straight-line swipe does not reliably produce it.
- Typing enters text character by character with human-like cadence, so autocomplete, debounced validation, and per-keystroke listeners are actually exercised.
- Both are configurable through the existing Timing settings and overridable per call, with the current behaviour available as an explicit profile.
- The defaults are justified by what they exercise in the app, not by a claim about looking human.

## 2. Non-goals

- Evading bot detection. This plan is about **test fidelity**: exercising code paths that a straight line and a single `set_text` skip. Any resemblance to human input is a means, not the goal, and the plan does not tune against any detector.
- Multi-touch gestures (pinch, rotate). Recorded in §9.
- Recording and replaying real human traces.
- Changing the input engine selection or the degrade chain (Plan 08 owns that).

## 3. Context and design decisions

### 3.1 What a straight-line swipe fails to test

`InputSink.swipe(from, to, ms)` (`packages/protocol/src/driver.ts:69`) is the only gesture primitive. Under scrcpy it becomes a down, a small number of interpolated moves, and an up; under `adb-input` it is `input swipe`, which is linear by definition.

Android's scroll behaviour is velocity-driven. `VelocityTracker` computes a release velocity from the last few move events, and that velocity is what decides whether a list flings, how far it coasts, and whether `OverScroller` triggers an overscroll effect. A constant-velocity straight line produces a release velocity that is both unrealistic and, at short durations, sometimes zero — so the list stops dead where a real finger would have carried it hundreds of pixels.

The consequences for a test suite are concrete: infinite-scroll pagination never triggers, `onScrollStateChanged(SCROLL_STATE_FLING)` never fires, snapping carousels land differently, and pull-to-refresh thresholds behave differently. These are not cosmetic differences; they are code paths that never execute.

### 3.2 What a single `set_text` fails to test

`device-executor.ts:69-79` prefers `inspector.setText(...)` when the engine supports element actions, falling back to `input.text(s)`. Both deliver the whole string at once.

An app that filters a list as you type, debounces validation, enforces a maximum length per keystroke, or fires an autocomplete request per character sees exactly one event. A search box tested this way is not tested at all — the entire incremental path is skipped, and a bug in it ships.

So per-character typing is not decoration; it is the difference between exercising the feature and not.

### 3.3 Path shape: a cubic Bézier with eased time

Two independent things make a gesture realistic, and conflating them is the usual mistake:

- **Path** — a human finger does not travel in a straight line. A cubic Bézier with control points offset perpendicular to the straight path, by a small randomised fraction of its length, gives a natural arc.
- **Time** — a finger accelerates and decelerates. Sampling the path at eased time (`easeOutQuad` for a flick, `easeInOutCubic` for a deliberate drag) is what produces a realistic release velocity.

Sample count matters more than either: Android's `VelocityTracker` needs several events in its window to compute a velocity at all. Fewer than ~8 move events over a short gesture and the computed velocity is unreliable; the default is **one event per ~8 ms**, capped at 60 events, which comfortably satisfies it without flooding the control socket.

### 3.4 `fling` and `scroll` as their own verbs

An author who writes "scroll down" has to guess a duration that produces a fling. The relationship is not obvious, and it differs per device density.

So two derived actions with an explicit intent:

- `scroll(direction, distance)` — a controlled drag that ends at low velocity and stops where it is put.
- `fling(direction, strength)` — a short, fast gesture that ends at high velocity and lets the list coast.

Both are implemented on top of the gesture engine with different easing and duration, so the author states the intent and the engine produces the kinematics.

### 3.5 Timing settings: extend, do not replace

`TimingSettings` already carries `tapJitterMs`, `betweenActionMs`, and `coordJitterPx` (`device-executor.ts:7-14`). Plan 34 makes them actually reach the executor.

This plan adds gesture and typing fields to the same structure, so there is one place a user configures pacing. It also adds a `profile` — `instant` reproduces today's behaviour exactly (no curve, no per-character typing), which matters both as an escape hatch and as the control arm when comparing results.

### 3.6 Where the code goes

The gesture engine produces **points over time**; it does not know about scrcpy or adb. So it lives in `@enkaku/drivers` as a pure function, and each `InputSink` implementation consumes the sampled points:

- `ScrcpyUhidInput` / `ScrcpySdkInput` send one touch-move control message per sample — the control socket handles this easily.
- `AdbInput` **cannot**: `input swipe` accepts only two points. Its `swipe` stays linear, and it reports the degradation once per session rather than pretending. This is consistent with `adb-input` already being the crude fallback (spec §9).

Per-character typing has the same split: scrcpy engines send per-character `inject_text` (or key events) with delays; `AdbInput` can also do this, since `input text` per character works, just slowly.

## 4. Technical design

### 4.1 Gesture engine — `packages/drivers/src/input/gesture.ts` (new)

```ts
export interface GestureSample { x: number; y: number; atMs: number }

export interface GesturePathOpts {
  from: Point
  to: Point
  durationMs: number
  /** Perpendicular bow as a fraction of the straight-line distance. 0 = straight. */
  curvature?: number          // default 0.08
  easing?: 'linear' | 'easeOutQuad' | 'easeInOutCubic'   // default easeInOutCubic
  /** Target interval between samples; the count is clamped to [2, 60]. */
  sampleIntervalMs?: number   // default 8
  jitterPx?: number           // per-sample positional noise, default 1
  rng?: () => number          // injectable for deterministic tests
}

export function buildGesturePath(opts: GesturePathOpts): GestureSample[]
```

Pure, deterministic under an injected `rng`, and unit-testable without a device: assert monotonic time, endpoints exact, sample count bounded, curvature zero ⇒ collinear, and — the one that matters — that the mean velocity over the final three samples is high for `easeOutQuad` and low for `easeInOutCubic`.

### 4.2 `InputSink` gains a path method — `packages/protocol/src/driver.ts`

```ts
export interface InputSink {
  // … existing …
  /** Play a sampled gesture. Engines that cannot honour the path fall back to a linear swipe and report it once. */
  gesture?(samples: GestureSample[]): Promise<void>
  /** Type with a per-character delay. */
  typeText?(text: string, opts: { perCharMs: [number, number]; rng?: () => number }): Promise<void>
}
```

Optional members, so an engine that cannot do it says so by absence rather than by a runtime lie. `withAdbKeyFallback` passes both through to the primary engine.

### 4.3 Timing settings — `packages/protocol/src/settings.ts`

```ts
export const TimingSettingsSchema = z.object({
  // … existing tapJitterMs, betweenActionMs, coordJitterPx …
  profile: z.enum(['instant', 'natural']).default('natural')
    .describe('"instant" sends a straight-line swipe and types text in one go — the pre-M17f behaviour. "natural" curves gestures and types character by character, which exercises fling physics, autocomplete, and debounced validation.')
    .meta({ title: 'Input profile' }),
  gestureCurvature: z.number().min(0).max(0.5).default(0.08)
    .describe('How far a swipe bows away from a straight line, as a fraction of its length.')
    .meta({ title: 'Gesture curvature' }),
  gestureSampleIntervalMs: z.number().int().min(4).max(50).default(8)
    .describe('Interval between touch-move events. Android needs several to compute a release velocity.')
    .meta({ title: 'Gesture sample interval (ms)' }),
  perCharMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([40, 140])
    .describe('Delay range between characters when typing.').meta({ title: 'Typing cadence (ms)' }),
})
```

`instant` must reproduce today's behaviour byte-for-byte, so an A/B comparison against existing results is possible.

### 4.4 Script API — `packages/sdk/src/types.ts`

```ts
device: {
  // … existing …
  swipe(from: Point, to: Point, ms?: number, opts?: { curvature?: number; easing?: string }): Promise<void>
  scroll(opts: { direction: 'up'|'down'|'left'|'right'; distance?: number; from?: Point }): Promise<void>
  fling(opts: { direction: 'up'|'down'|'left'|'right'; strength?: 'soft'|'normal'|'hard' }): Promise<void>
  type(text: string, opts?: { perCharMs?: [number, number]; instant?: boolean }): Promise<void>
}
```

`scroll` and `fling` derive their geometry from `session.frameSize` — a distance in pixels, defaulting to 60% of the viewport for `scroll`, and a short high-velocity gesture for `fling`, with `strength` mapping to duration and distance.

`type` keeps its current signature; the options are additive. When the inspector supports `setText` **and** the caller passes `instant: true`, the existing fast path is used — some fields (a long token, a paste target) genuinely do not want per-character entry.

### 4.5 IPC and executor

`packages/session/src/runner/ipc.ts`: `DeviceCallSchema` gains `scroll`, `fling`, and options on `swipe`/`type`. `device-executor.ts` builds the path with the effective timing (from Plan 34's getter) and calls `session.input.gesture(...)` when available, falling back to `swipe` otherwise.

### 4.6 Manual control

Studio's live view drags currently map to `input.swipe` (`ws-handlers.ts:349-358`). They gain the same treatment: a drag becomes a sampled gesture. A human dragging in the browser already produces a natural path — so for manual control, the **actual pointer trace** is sent rather than a synthesised one, batched to the same sample interval. That is strictly better than synthesising a curve over a path the operator already drew.

## 5. Implementation steps

**40.1 — Gesture engine.** `gesture.ts` with the Bézier, easings, sampling, and clamps; deterministic tests with an injected `rng`, including the release-velocity assertions.

**40.2 — Engine support.** `gesture()` and `typeText()` on `ScrcpyUhidInput` and `ScrcpySdkInput`; `AdbInput` implements `typeText` but not `gesture`, and reports the degradation once per session through the existing `onInputDegraded` hook.

**40.3 — Settings.** Extend `TimingSettingsSchema` (§4.3); confirm Plan 34's wiring delivers the new fields to the executor.

**40.4 — Script API and IPC.** `scroll`, `fling`, swipe/type options; executor construction of paths.

**40.5 — Manual control.** Send the operator's real pointer trace as a gesture.

**40.6 — Verification.** A demo script that scrolls a long list and asserts it coasts (§7).

## 6. Acceptance criteria

1. A `fling` on a long list causes it to coast after release; the same gesture under `profile: 'instant'` stops dead — the difference is observable and is the plan's core claim.
2. `scroll(down, 800)` moves the list approximately 800 px and does not fling.
3. A swipe with `curvature: 0` is collinear; the default curvature bows and still starts and ends exactly on the requested points.
4. A gesture emits at least 8 move events for any duration ≥ 100 ms, and at most 60.
5. `type('hello')` under `natural` produces five separate input events with delays in the configured range; under `instant` it produces one.
6. A search field that filters per keystroke shows intermediate states under `natural` and does not under `instant`.
7. `profile: 'instant'` reproduces the pre-plan behaviour exactly.
8. `AdbInput` falls back to a linear swipe and reports the degradation once, rather than silently pretending.
9. A manual drag in Studio sends the operator's real trace, not a synthesised curve.
10. Timing changes in Studio affect the next job with no restart (via Plan 34's getter).
11. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `gesture.test.ts` (endpoints exact, monotonic time, sample bounds, curvature 0 ⇒ collinear, deterministic under a seeded rng, final-segment velocity higher for `easeOutQuad` than `easeInOutCubic`); `input-engines.test.ts` (per-sample control messages emitted; `AdbInput` reports degradation once).

**Manual smoke (`ENKAKU_TEST_DEVICE=1`):**
```bash
# 1. open a long scrollable list (Settings → Apps)
# 2. fling down → the list coasts after release
# 3. set profile=instant, fling again → it stops immediately  (the A/B)
# 4. scroll(down, 800) → moves roughly a screen, no coast
# 5. type into a search field with an autocomplete → intermediate results appear
# 6. drag in Studio's live view → the on-device motion follows your actual path
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Existing scripts change behaviour and previously-passing suites start failing. | `profile: 'instant'` reproduces the old behaviour exactly and is one setting away; the A/B in §7 makes the difference measurable rather than mysterious. |
| Per-sample control messages flood the scrcpy control socket. | **Measured after implementation, not estimated.** 8 ms interval with a hard 60-sample cap. A 300 ms swipe is 38 samples: **390 bytes** on `scrcpy-uhid` (10 B/message) or **1.2 KB** on `scrcpy-sdk` (32 B/message); at the cap, 610 B / 1.9 KB. The earlier ~7.5 KB estimate in this row was 4–20× too high. Two things close this: the cap bounds any gesture regardless of settings, and ~127 messages/second during a gesture is at or below what a real touch digitizer (60–120 Hz) already produces, so the device is consuming what it is built for. |
| Per-character typing makes long text entry slow enough to hit job timeouts. | `perCharMs` defaults to 40–140 ms (≈1.1 s for 12 characters); `instant: true` per call is available for long tokens, and `setText` remains the path when the inspector supports it and the author asks. |
| Someone reads this as anti-detection tooling. | §2 states the goal is test fidelity, the defaults are justified by what they exercise (`VelocityTracker`, debounced validation), and nothing here is tuned against a detector. |
| `AdbInput`'s inability to curve makes results differ by engine. | Reported explicitly through the existing degradation channel and shown in the device page's engine panel, so a difference is visible rather than silent. |

## 9. Open questions

1. Multi-touch (pinch, rotate) needs a second pointer id through the UHID/SDK engines — a natural follow-on, deliberately not here.
2. Should `fling` strength be calibrated per device density, so `hard` means the same thing on a 280 dpi and a 560 dpi screen? Currently distance is a fraction of the viewport, which approximates this.
3. Should the executor's existing `betweenActionMs` pause apply to `scroll`/`fling` as well, or are they usually issued in deliberate sequence? Currently it applies, matching `swipe`.
