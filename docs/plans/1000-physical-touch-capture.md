# Plan 1000 — Physical touch capture : the finger on the glass, in milliseconds

> Status: implemented (software) — G1-G9 done and verified by their own commands 2026-09-21. G10 (a real finger on a real phone) stays open: it is an owner row, and nothing in this repo can touch a screen.
> Ships: packages/core/src/device/touch-capture/service.ts
> Depends on: plan 24 (the streaming lane and the shared-stream shape this borrows); plan 25 (`ShellPort`, local vs node-owned); plan 94 (the action recorder, whose §3.3 declined exactly this and is reopened here); plan 205 (the admission gate); plan 215 (Device Control's Device tab)
> Spec references: §5 (drivers), §9 (input), §13 (Studio)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A real finger on the glass reaches the core as a structured stroke | 1 stream per device, `getevent -lt` | `bun test packages/core/src/device/touch-capture/` → 33 pass | [x] |
| G2 | One sample per `SYN_REPORT`, never one per axis line | 3 lines (X, Y, SYN) → 1 position | `strokes.test.ts` "one sample per SYN_REPORT" | [x] |
| G3 | A second finger is its own stroke, and the sticky slot is honoured | 2 strokes, both `concurrent` | `strokes.test.ts` "the current slot is sticky across frames" | [x] |
| G4 | Intervals are the device's own monotonic clock, not a host timestamp | `gapMs`/`durationMs`/`atMs` from evdev, `at` derived once per stream | `service.test.ts` "the interval is the gap since the previous down" | [x] |
| G5 | The farm's own injected pointer is reported, marked, and never mixed into a human interval | `synthetic: true`, `gapMs` per input device | `service.test.ts` same test; `probe.test.ts` "the farm's own UHID pointer" | [x] |
| G6 | A phone with no touch panel says so, and no stream is opened on it | `state: 'unavailable'`, 1 exec, 0 streams | `service.test.ts` "a phone with no touch panel" | [x] |
| G7 | The stream stops when the last viewer leaves, on a disconnect, and when the device goes away | 3 paths, 1 stop each | `service.test.ts` "a second viewer joins…", "a dropped connection releases…", "the device going away…" | [x] |
| G8 | Nothing is written to the database | 0 `device_events` rows per stroke | `rg -n "recorder.record" packages/core/src/device/touch-capture/` → no matches; the one recorded row is the capture STARTING, in `ws-handlers.ts` | [x] |
| G9 | An operator can copy the whole capture as JSON | 1 button, whole strokes, both clocks | `rg -n "Copy JSON" packages/studio/src/components/device-control/TouchCapture.tsx` → 1 match | [x] |
| G10 | On a real phone, tapping the glass fills the table, and the numbers match what the operator did | owner judgement | owner smoke §7.4 | owner |

## 1. Goals

The owner's request, 2026-09-21:

> "saya pingin bikin fitur tap/swipe history bisa ngga? jadi device yang sudah terkoneksi saya mau tap atau swipe nah nanti kebaca disistem kita dan bisa kita lihat historynya, waktunya, interval, lokasi dll akurat. jadi ini bisa jadi alat debugging juga nantinya misalnya system mau meniru behaviour tap/swipe nya"

Asked which finger, the answer was the PHYSICAL one, through the guest agent or anything else, "mirip ui inspector aja" — attach it and it records, with JSON to copy out for analysis or a model.

Three things the farm already had, none of which answers that:

1. **The input event log** (`stream: 'input'`, plan 18) records every tap the farm SENDS, at `device_events.at` — unix **seconds**. An interval read off it is rounded to the nearest second, which for tap timing is no interval at all.
2. **The action recorder** (plan 94) has millisecond `gapMs` and a real sampled path — but only while a human is holding Record, and only for input passing through the browser.
3. **Neither sees a finger.** Plan 94 §3.3 says so in as many words and declines it: "This plan records the *operator's* input as it passes through the core."

That decision was right for a recorder whose product is a replayable script. It is the wrong one for the question asked here, which is not "what did I click in the mirror" but "what does a person actually do to this phone, and how long do they wait between doing it".

## 2. Non-goals

- **Not a replay format.** A captured stroke's `samples` are shaped so `input.gesture` can take them (normalised 0..1, `atMs` from 0), but nothing in this plan replays anything. Turning a capture into a script is the recorder's job and stays there.
- **Not persisted.** No table, no migration, no retention row. See D3.
- **Not rotation-corrected.** See D4.
- **Not multi-touch reconstruction on protocol-A hardware.** One contact is captured honestly; the rest would be guesswork (`strokes.ts` header).
- **Not a guest-agent capability.** See D1.

## 3. Decisions

### 3.1 `getevent` over adb, not the guest agent (D1)

The request offered the guest agent as the likely road. It cannot be:

- An installed APK runs in the app sandbox. `/dev/input/event*` is `root:input 0660`, and an ordinary app is not in the `input` group — the guest agent cannot read it at all, at any API level, without root.
- `AccessibilityService` is the other thing an app could use, and it does not carry raw touch coordinates. Observing the touchscreen means `FLAG_REQUEST_TOUCH_EXPLORATION_MODE`, which does not observe touches, it **takes them over** — the phone would stop behaving like a phone while capture was on, which is the one thing a behaviour capture must not do.
- The adb `shell` user *is* in the `input` group, and `getevent` is the stock binary for exactly this. It needs no APK, no permission grant, and no toolchain download — it works on a phone the farm has only just enrolled.

So the capture is one `getevent -lt` stream on the existing streaming lane, plus one `getevent -pl` probe for the axis maxima.

### 3.2 A service, not a `MonitorKind` (D2)

`MonitorHub` already runs shared, ref-counted shell streams and was the obvious host. It is not one: a monitor's product is LINES, and this one's is a stroke assembled across hundreds of lines against per-device axis state. The service borrows the hub's shape — one entry per device, viewers counted, stopped on the last leave, a readiness hold for its lifetime — and keeps its own parser (`service.ts` header).

### 3.3 In memory, bounded, never written to the database (D3)

A stroke is worth about 1 KB with its samples, and a minute of dragging is hundreds of them. Writing that to `device_events` would be thousands of rows an hour, at one-second resolution, for data whose entire value is millisecond resolution — the row would be a worse copy of what the operator is looking at. The buffer is `TOUCH_CAPTURE_MAX_STROKES` (500) per device, dies with the capture, and leaves by the Copy JSON button. The one thing that IS recorded is that a capture started, once, on the `main` stream: an operator reading a device's history should see that someone was watching this phone's touches.

### 3.4 Panel coordinates, never silently rotated (D4)

A touch panel reports in its own natural orientation and knows nothing about the display's rotation. Correcting for rotation means reading it, trusting it, and being wrong whenever it changed mid-capture — so the capture reports what the panel said, `TouchCaptureSource.rotation` carries what the display was doing when known, and Studio's header says the coordinates are the panel's. An honest number a consumer can transform beats a transformed number nobody can check.

### 3.5 The farm's own pointer is data, not noise (D5)

`ScrcpyUhidInput` creates "Enkaku Pointer" over UHID; the kernel binds it through `hid-multitouch`, so it appears in `/dev/input/` as an ordinary protocol-B panel. Hiding it would be easy and wrong: comparing an injected tap against a human one — same screen, same units, same clock — is the second thing this feature is for. It is reported with `synthetic: true`, rendered in the warn colour, hideable with a checkbox, and **excluded from human intervals** by keying `gapMs` on the input device rather than the phone.

### 3.6 Control-grade, like the inspector (D6)

A stream of touch positions is the screen's content for anything typed on a keypad: a PIN is four positions and three intervals. So `touch.capture.*` goes through the same server-authoritative `admit(deviceId, state, 'control')` gate as `inspect.*` (plan 56 §3.7, plan 205 §4.8), never a hidden tab.

## 4. Changes

| # | File | What |
|---|---|---|
| 4.1 | `packages/protocol/src/messages/touch-capture.ts` | New. `TouchStroke`, `TouchCaptureSource`, the three client messages and the two server ones. Registered in `index.ts`'s two unions, append-only. |
| 4.2 | `packages/core/src/device/touch-capture/probe.ts` | New. `getevent -pl` → touch panels with axis maxima, protocol and synthetic flag. |
| 4.3 | `packages/core/src/device/touch-capture/evdev.ts` | New. One `getevent -lt` line → one normalised event. Handles half-labelled lines, `DOWN`/`UP` key values and the signed `ffffffff`. |
| 4.4 | `packages/core/src/device/touch-capture/strokes.ts` | New. Slots, frames and `BTN_TOUCH` → contacts, with the sample cap thinning the middle of a path. |
| 4.5 | `packages/core/src/device/touch-capture/service.ts` | New. Per-device capture: probe, stream, ring buffer, viewers, re-probe when an unknown touch path appears. |
| 4.6 | `packages/core/src/server/ws-handlers.ts` | The three message cases behind the control gate, `touchCaptures` on `ConnState`, fan-out to viewers, release on WS close and on the device going away. |
| 4.7 | `packages/core/src/config/constants.ts`, `.env.example` | Seven `ENKAKU_TOUCH_CAPTURE_*` support overrides. |
| 4.8 | `packages/studio/src/components/device-control/TouchCapture.tsx`, `DeviceTab.tsx` | The Touch chip in the Device tab: status, sources, the stroke table (interval, hold, position), Copy JSON, Clear, Stop. |
| 4.9 | `packages/studio/src/components/DeviceLog.tsx` | A label and a sentence for `touch.capture.started`. |

## 7. Verification

### 7.1 Typecheck

```bash
bun run typecheck
```

### 7.2 Scoped tests (CLAUDE.md: only what was touched, one invocation at a time)

```bash
bun test packages/core/src/device/touch-capture/          # the probe, the line parser, the assembler, the service
bun test packages/protocol/src/messages/touch-capture.test.ts
bun test packages/core/src/server/                        # the router the three cases were added to
```

### 7.3 Greps

```bash
rg -n "recorder.record" packages/core/src/device/touch-capture/   # G8: no rows per stroke
rg -n "admit\(deviceId, state, 'control'\)" packages/core/src/server/ws-handlers.ts   # D6
```

### 7.4 Owner smoke (G10 — needs a phone)

1. Open Device Control on a USB phone, Device tab → **Touch**.
2. Tap the phone itself three times, roughly a second apart; then swipe.
3. Expect three `Tap` rows with intervals near 1000 ms, then a `Swipe` with its sample count, positions matching where the finger landed (portrait).
4. Tap inside the mirror in the browser: a row marked `injected` appears from `Enkaku Pointer`, and the human rows' intervals do not count it.
5. **Copy JSON**, paste somewhere, confirm the samples and both clocks are there.

## 10. Removed

Nothing. This plan only adds; plan 94's recorder and the input event log are untouched.

## 11. Handoff

- **The open question is whether an operator wants this persisted.** D3 says no on purpose, and the buffer dies with the capture. If a farm ever wants "what did the human do on phone #27 last Tuesday", that is a new table with its own retention row, not a loosened constant.
- **Rotation (D4) is the most likely first complaint** from anyone capturing a landscape game. The fix is a transform in Studio, at render time, from `TouchCaptureSource.rotation` — never in the core, and never in the stored stroke.
- **A stroke is one contact.** A pinch is two strokes with `concurrent: true` and no higher-level gesture on top. Naming pinches would be a second pass over completed strokes, and nothing has asked for it yet.
