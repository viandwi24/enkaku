# Plan 17 — M11a : Realtime UI Contract and Device Wake-up UX

> Status: implemented (2026-08-02) — see the "Corrected during implementation" note in §4.2
> Ships: packages/studio/src/lib/useNow.ts
> Depends on: Plans 01–16 complete.
> Spec references: §7.1 (display engines), §10.1 (device states), §13 (core⇄studio protocol), §16 (NFR).

---

## 1. Goals

- Every elapsed time and relative timestamp on screen advances on its own. A running job shows its duration counting up without a refresh.
- Opening a device page while the phone is asleep shows **what the core is doing** (connecting, waking, starting video) instead of a black rectangle.
- The live view states the freshness of the picture. When frames stop, the UI says so rather than leaving a stale image looking live.
- Keep-awake is a real setting with three honest modes, and it works on wireless devices — not only USB.
- A "standby" mode exists: the phone's physical panel is off while mirroring keeps running.
- A viewer joining an existing stream gets a fresh keyframe on request rather than waiting for the encoder's next IDR.

## 2. Non-goals

- Device event logging and the Logs tab — Plan 18.
- Tags, clusters, batch runs, schedules — Plans 19–21.
- Audio capture and playback — not planned yet; see Open questions.
- Replacing the WS transport with SSE or long-polling. The WS already exists and reconnects.

## 3. Context and design decisions

### 3.1 Why times freeze today

`packages/studio/src/lib/format.ts` already computes `duration(startedAt, finishedAt)` against `Date.now()` when a job has not finished. The value is correct at render time and then never recomputed, because nothing re-renders between server events. A running job therefore displays the elapsed time as of the last `job.status` message.

The fix is one shared ticking hook rather than per-page `setInterval`s. A single interval per page, feeding a `now` value into pure formatters, keeps the formatters pure and stops each screen inventing its own timer.

### 3.2 Why the screen looks frozen when a phone sleeps

scrcpy emits nothing while the device display is off. The canvas keeps the last decoded frame, and the readout keeps saying `streaming`. Nothing is technically wrong — there simply are no frames — but the interface asserts something false. Freshness has to be stated.

A partial fix already landed (a `no new frames for Ns` readout). This plan completes it: the same signal drives an optional auto-recover, and the wake-up path below removes most of the cases where it appears at all.

### 3.3 Session start is slow and silent

`createSession` in `packages/session/src/session.ts` runs a sequence that takes seconds on a sleeping phone: connect the transport, wake the screen, check the keyguard, push and launch scrcpy-server, open the video and control sockets, wait for the first frame. Studio shows nothing for that whole window.

The core knows exactly which step it is on. It should say so. A `session.progress` message per phase turns dead time into visible progress, and it costs one broadcast per phase.

### 3.4 Keep-awake is currently wrong for wireless devices

The session hardcodes `svc power stayon usb`. Per the Android `svc` command, the accepted values are `true|false|usb|ac|wireless`, where `usb` only holds the screen awake **while plugged into USB**. A device attached over `adb-tcp` is not plugged in, so the setting does nothing for it.

`DeviceSettings.prep.stayAwake` is a boolean, which cannot express the difference. It becomes an enum:

| Mode | `svc power stayon` | When to use |
|---|---|---|
| `off` | `false` | Let the device follow its own timeout. |
| `while-charging` | `usb` | Wired farm devices — today's behaviour. |
| `always` | `true` | Wireless devices, and any device that must never sleep. |

### 3.5 Standby: screen off, mirroring alive

For a farm, the phone's panel being lit is pure cost — battery, heat, burn-in — while the video stream is what people actually watch. scrcpy supports exactly this: the upstream client exposes `--turn-screen-off`, and the control protocol carries `SET_DISPLAY_POWER` (type `10`, followed by one boolean byte). The encoder keeps producing frames with the panel dark.

`CONTROL_MSG.SET_DISPLAY_POWER` is already declared in `packages/scrcpy/src/version.ts`; no encoder exists for it yet.

This is opt-in per device, off by default: a dark phone on a rack is confusing until you know why it is dark.

### 3.6 A joining viewer should ask for a keyframe

Today the core replays a cached config packet and the last cached IDR to a new viewer. That works, but the cached IDR can be seconds old, so the first thing a viewer sees is a stale frame that then jumps.

scrcpy 3.x has `RESET_VIDEO` (type `17`, one byte, no payload), which forces the encoder to emit a fresh keyframe. Sending it on subscribe replaces "show something old" with "ask for something current". The cached-keyframe path stays as the fallback for the moment before the new IDR arrives.

## 4. Technical design

### 4.1 New protocol messages

`packages/protocol/src/messages/stream.ts`:

```ts
/** Phases a session goes through before the first frame (Plan 17 §3.3). */
export const SessionPhaseSchema = z.enum([
  'connecting',      // opening the adb transport
  'waking',          // wake + keyguard + keep-awake
  'starting-video',  // push jar, launch server, connect sockets
  'waiting-frame',   // sockets up, no picture yet
  'ready',           // first frame delivered
])

export const SessionProgressMessage = z.object({
  type: z.literal('session.progress'),
  payload: z.object({
    deviceId: z.string(),
    phase: SessionPhaseSchema,
    /** Optional human-readable detail, e.g. 'ui-server fell back to dump'. */
    detail: z.string().optional(),
  }),
})
```

Register it in `packages/protocol/src/index.ts` inside `ServerMessageSchema`, next to `StreamStartedMessage`.

### 4.2 DeviceSettings changes

`packages/protocol/src/settings.ts`, inside `DeviceSettingsSchema.prep`:

```ts
prep: z.object({
  disableAnimations: z.boolean().default(true),
  /** Replaces the old `stayAwake` boolean (Plan 17 §3.4). */
  keepAwake: z.enum(['off', 'while-charging', 'always'])
    .default('while-charging')
    .meta({ title: 'Keep the screen awake' }),
  /**
   * Blank the device's physical panel while mirroring continues (§3.5).
   * The video stream is unaffected.
   */
  standbyScreenOff: z.boolean().default(false)
    .meta({ title: 'Turn the device screen off while streaming' }),
})
```

Migration: a Drizzle migration is **not** required — `settings` is a JSON column. Reading code must tolerate the old boolean, mapping a legacy `stayAwake: true` to `keepAwake: 'while-charging'` and `false` to `'off'`, so rows written before this plan keep working. Cover it with a unit test.

**Corrected during implementation.** An earlier draft said to use `.transform()`. Do not: Zod 4's `z.toJSONSchema()` throws `Transforms cannot be represented in JSON Schema`, and this very schema is what `GET /api/settings` generates the settings form from — so a transform here silently takes out both settings screens. Use `z.preprocess()`, which parses identically and leaves JSON Schema generation working. Verified directly against Zod 4.

Because the farm defaults and per-device settings share one schema (§ Plan 07), both screens pick the new fields up with no extra UI work.

### 4.3 Core: emitting progress

`packages/session/src/session.ts` — `CreateSessionDeps` gains:

```ts
/** Report which start-up phase this session is in (Plan 17 §3.3). */
onPhase?: (phase: SessionPhase, detail?: string) => void
```

Call sites, in order: `connecting` before `transport.connect()`; `waking` before the keep-awake block; `starting-video` before `deps.makeScrcpy`; `waiting-frame` after `display.start()`; `ready` from the first `onFrame`.

`packages/session/src/manager.ts` passes `onPhase` through, tagging it with the deviceId. `packages/core/src/daemon.ts` wires it to `hub.broadcast({ type: 'session.progress', ... })`.

### 4.4 Core: keep-awake and standby

`packages/session/src/session.ts`, replacing the current hardcoded block:

```ts
const STAYON: Record<KeepAwakeMode, string> = {
  off: 'false',
  'while-charging': 'usb',
  always: 'true',
}
```

`close()` resets with `svc power stayon false` only when the mode was not `off`.

Standby uses the control socket, not adb: after the scrcpy session is up and `standbyScreenOff` is true, send `SET_DISPLAY_POWER(false)`. On session close, send `SET_DISPLAY_POWER(true)` so the phone is not left dark for the next person.

New encoder in `packages/scrcpy/src/control/messages.ts`:

```ts
export function encodeSetDisplayPower(on: boolean): Uint8Array {
  return new Uint8Array([CONTROL_MSG.SET_DISPLAY_POWER, on ? 1 : 0])
}
```

Add `setDisplayPower(on: boolean): void` to `ScrcpyControl` in `packages/scrcpy/src/session.ts`.

### 4.5 Core: keyframe on subscribe

`packages/scrcpy/src/control/messages.ts`:

```ts
export function encodeResetVideo(): Uint8Array {
  return new Uint8Array([CONTROL_MSG.RESET_VIDEO])
}
```

`packages/core/src/server/ws-handlers.ts`, in `stream.start`: after sending the cached config and keyframe primers, call `session.requestKeyframe?.()`. Add that optional method to `DeviceSession`, implemented only when scrcpy is the display engine.

### 4.6 Studio: the ticking clock

New file `packages/studio/src/lib/useNow.ts`:

```ts
/**
 * A timestamp that advances, for anything showing elapsed or relative time.
 *
 * Formatters stay pure; this is the only thing that makes them re-run. One
 * interval per component beats a timer inside every row.
 */
export function useNow(intervalMs = 1000): number
```

It must stop ticking when the document is hidden (`visibilitychange`) and resync on wake, so a backgrounded tab does not burn a timer per second and does not show a stale value the moment it is focused again.

`packages/studio/src/lib/format.ts`: `duration()` and `relativeTime()` gain an optional trailing `now?: number` parameter defaulting to `Date.now()`. No call site breaks; live call sites pass `useNow()`.

Call sites to convert (each must show a live value while the entity is unfinished):

| File | What ticks |
|---|---|
| `app/jobs/page.tsx` | duration of running jobs, relative "started" |
| `app/jobs/detail/page.tsx` | run time, total time, queue wait |
| `app/device/page.tsx` | lease countdown (already ticks — switch it to `useNow`), job rows |
| `app/scripts/detail/page.tsx` | runs table durations |
| `app/agents/page.tsx` | last seen |

### 4.7 Studio: wake-up progress

`packages/studio/src/components/LiveView.tsx` gains a `phase` state fed by `session.progress`. While the phase is anything other than `ready` **and** no frame has arrived, the canvas area shows a progress panel instead of black:

```
  ⟳  Waking the device…
     connecting → waking → starting video → waiting for the first frame
```

Rules:
- The step list is static; the current step is highlighted. No fake percentage.
- If a phase lasts more than 10 s, add the elapsed seconds after the label — a slow step should look slow, not stuck.
- On `ready`, the panel disappears on the first painted frame, not on the message, so there is never a gap between "ready" and a picture.

### 4.8 Studio: stale frames and recovery

Extend the existing `staleSec` handling:
- `>= 5 s` — the readout shows `no new frames for Ns` (already implemented).
- `>= 30 s` — additionally show an inline action: `The device screen looks off. Wake it` which sends `input.key KEYCODE_WAKEUP` if the viewer holds the lease, otherwise explains that control is needed.
- Auto-recover stays **off by default** and is a per-device setting (`autoReconnect`, which already exists in `DeviceSettings`): when set, a stale stream past 30 s triggers one `stream.stop` + `stream.start` cycle, at most once per minute. Left off, nothing wakes a phone that someone deliberately put to sleep.

## 5. Implementation steps

### 17.1 Protocol
- [ ] Add `SessionPhaseSchema` and `SessionProgressMessage` to `packages/protocol/src/messages/stream.ts`; export from `index.ts`; add to `ServerMessageSchema`.
- [ ] Change `prep.stayAwake` to `prep.keepAwake` and add `prep.standbyScreenOff` in `packages/protocol/src/settings.ts`, with the legacy-boolean transform.
- [ ] Unit test: legacy `{ stayAwake: true }` parses to `keepAwake: 'while-charging'`; `{ stayAwake: false }` to `'off'`; absent parses to the default.
- Result: `bun run typecheck` passes; the new fields appear in `GET /api/settings`'s generated schema.

### 17.2 scrcpy control additions
- [ ] `encodeSetDisplayPower` and `encodeResetVideo` in `packages/scrcpy/src/control/messages.ts`.
- [ ] Extend `ScrcpyControl` with `setDisplayPower` and `resetVideo` in `packages/scrcpy/src/session.ts`.
- [ ] Unit test the byte layouts: `[10, 0|1]` and `[17]`.
- Result: byte-exact tests pass against the layouts in §3.5 and §3.6.

### 17.3 Session: keep-awake, standby, phases
- [ ] Replace the hardcoded `svc power stayon usb` with the `STAYON` mapping in `packages/session/src/session.ts`.
- [ ] Apply `standbyScreenOff` after scrcpy comes up; restore power on `close()`.
- [ ] Add `onPhase` to `CreateSessionDeps` and emit the five phases.
- [ ] Add `requestKeyframe?()` to `DeviceSession`, wired to `control.resetVideo()`.
- [ ] Thread `keepAwake` / `standbyScreenOff` through `CreateSessionOpts`, `packages/session/src/manager.ts`, and `packages/core/src/session/adapters.ts` (the DB row → opts mapping).
- Result: with `keepAwake: 'always'`, `adb shell dumpsys power | grep mStayOn` reports `true`.

### 17.4 Core wiring
- [ ] Broadcast `session.progress` from `daemon.ts`.
- [ ] Call `requestKeyframe()` in the `stream.start` handler after the primers.
- Result: a second `stream.start` on a live session produces a fresh IDR within ~1 s (measure with the flags probe from Plan 08's test notes).

### 17.5 Studio: ticking time
- [ ] Add `packages/studio/src/lib/useNow.ts` with the visibility handling from §4.6.
- [ ] Add the optional `now` parameter to `duration()` and `relativeTime()`.
- [ ] Convert the five call sites in the §4.6 table.
- Result: open a job while it runs — the duration increments once per second with no network traffic.

### 17.6 Studio: wake-up panel and stale handling
- [ ] Subscribe to `session.progress` in `LiveView`; render the progress panel per §4.7.
- [ ] Add the 30 s inline wake action and the opt-in auto-recover per §4.8.
- Result: putting the phone to sleep and reloading the device page shows the phase list advancing, then the picture.

### 17.7 Settings UI
- [ ] Confirm the schema-driven form renders `keepAwake` as a select and `standbyScreenOff` as a switch, on both Settings → Device defaults and the per-device Settings tab. No bespoke UI should be needed; if it is, the schema is wrong — fix the schema.
- Result: both screens show identical controls (the Plan 07 parity rule).

## 6. Acceptance criteria

1. A running job's duration advances every second on `/jobs` and `/jobs/detail` without a refresh.
2. Opening a device page on a sleeping phone shows the phase list, and the panel is replaced by the picture on the first frame — never a black rectangle with no explanation.
3. `keepAwake: 'always'` holds a wireless (`adb-tcp`) device awake; `'off'` leaves the device's own timeout alone.
4. `standbyScreenOff: true` leaves the phone's panel dark while the live view keeps updating.
5. A device row written before this plan (with the boolean `stayAwake`) still loads, and its behaviour is unchanged.
6. Joining an existing stream paints a current frame, not one from seconds earlier.
7. With frames stopped for 30 s the UI offers to wake the device; with `autoReconnect` on, the stream restarts by itself at most once a minute.
8. `bash scripts/typecheck.sh` and `bun test` are green.

## 7. Test plan

**Unit**
- `packages/protocol/src/settings.test.ts` — the legacy `stayAwake` transform, all three branches.
- `packages/scrcpy/src/control/messages.test.ts` — `encodeSetDisplayPower`, `encodeResetVideo` byte layouts.
- `packages/studio` has no test runner configured; `useNow` is covered by the manual smoke test.

**Manual smoke** (needs a device; gate with `ENKAKU_TEST_DEVICE=1`)

```bash
bun run dev                       # core on :7700
adb -s <serial> shell input keyevent KEYCODE_SLEEP     # put the phone to sleep
# open http://127.0.0.1:7700/device?id=<id>
#   expect: phase list advances, then a picture
adb -s <serial> shell dumpsys power | grep -o 'mStayOn=[a-z]*'   # after setting keepAwake: always
# set standbyScreenOff, reload:
#   expect: the phone's panel is dark, the browser keeps updating
# start a job, watch /jobs: the duration must tick without refreshing
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `SET_DISPLAY_POWER` behaves differently across OEMs (some panels wake on any input). | Treat it as best-effort: the setting's help text says so, and the video stream never depends on it. Verify on the two Motorola units before shipping. |
| `keepAwake: 'always'` drains an unplugged device. | The setting's description states it; battery monitoring and auto-quarantine (Plan 07) already exist as the backstop. |
| A per-second interval on every page costs CPU on a large farm view. | One interval per page, paused when the tab is hidden. Rows read a value, they do not own timers. |
| `RESET_VIDEO` is not honoured by an older pinned scrcpy. | The version is pinned to 3.3.1 where it exists; the cached-keyframe path stays as the fallback, so a no-op degrades to today's behaviour. |
| The legacy `stayAwake` transform is forgotten in a later refactor. | The unit test in 17.1 fails loudly if the boolean stops being handled. |

## 9. Open questions

1. Should `standbyScreenOff` also apply during **job** sessions, or only manual control? Running automation on a dark panel is cheaper, but some apps behave differently with the display off. Proposed default: manual sessions only, with a separate setting later if jobs need it.
2. Audio forwarding was raised by the product owner and is still unplanned. It needs its own plan (scrcpy audio socket → `CHANNEL.AUDIO` → WebCodecs `AudioDecoder`). Not scheduled here.
3. When auto-recover restarts a stream, should it also re-acquire a lease the viewer previously held? Proposed: no — silently regaining control is worse than asking.
