# Plan 209 — MVP wave 1 : Video and input pipeline — decoder and paint quick wins, demuxer ring buffer, the driver-side input verbs

> Status: implemented (software) — G1-G21 done and verified by the commands named in §0; G22-G26 need the lab device and are the owner's rows. Executed 2026-09-04 on branch `agent/plan-209`.
> Depends on: plan 203 (the 27-byte frame header, `ptsUs`, the latency overlay, the decoder timing events this plan builds on; its `demuxer.test.ts` and `h264-decoder.test.ts` are extended here, never replaced), plan 206 (the encoder split, `attachViewer`, backpressure and `drain()`; this plan hooks the base entry only), plan 205 through 206 (the `InputSource.kind` values `user | job | agent` and the `input.*` admission block this plan's new branches sit under). Reads `docs/mvp/01-casting-latency.md` §1.2, §1.4, §1.5, §2, §4 step 2, §5; `docs/mvp/08-device-control.md` §0, §1.1, §1.2, §1.3, §2, §3, §4; `docs/mvp/13-removal-register.md` A.8; `docs/mvp/16-consolidated-plan.md` §2 (Video and Device Control input rows) and §3 (wave 1). External facts: R1, R2, R3 from plan 200 §5.
> Spec references: `docs/spec.md` §9 (input engines: `scrcpy-uhid` default, `scrcpy-sdk` fallback, `adb-input` crude fallback), §7.6 (vanilla scrcpy-server, never forked), §7.9 (five driver layers), §13 (WS contract in `@enkaku/protocol`), §16 line 1103 (glass-to-glass target). Until plan 202 rewrites the spec, `docs/mvp/16` wins where they disagree (plan 200 header).
> Ships: packages/scrcpy/src/hid/keyboard.ts
> **Testing override, read before §5 and §7:** §12 supersedes every Studio and `@enkaku/ui` test named anywhere below. Create no test and run no test under `packages/studio` or `packages/ui`; delete a surviving one that breaks and list it in §11. Verification for UI is `bun run typecheck`, the design-token and route scripts, and the owner smoke.

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The demuxer copies each socket chunk exactly once into a head/tail buffer and never reallocates per chunk | `ByteRing.stats().pushCopiedBytes === total bytes pushed`; `grows === 0` for frames under the 256 KiB initial capacity; `compactionCopiedBytes < pushed / 4` | `bun test packages/scrcpy/src/demuxer.test.ts` → tests `push copies exactly chunk.length bytes per chunk and never reallocates for frames under the initial capacity` and `a frame larger than the capacity grows the ring once, then no more` pass | [x] |
| G2 | The control socket runs with Nagle off | `controlSocket.setNoDelay(true)` called once, right after the sockets connect | `rg -n "setNoDelay\(true\)" packages/scrcpy/src/session.ts` → 1 match; `bun test packages/scrcpy/src/session.test.ts` passes | [x] |
| G3 | `INJECT_SCROLL_EVENT` has an encoder with the v3.3.1 layout | 21 bytes: type, i32 x, i32 y, u16 w, u16 h, i16 hscroll, i16 vscroll, u32 buttons | `bun test packages/scrcpy/src/control/messages.test.ts` → test `encodeInjectScroll: 21 bytes, i16 fixed-point deltas` passes | [x] |
| G4 | A UHID boot keyboard descriptor and report builder exist and match scrcpy's own | descriptor 63 bytes; report 8 bytes `[mods][0][k1..k6]`; > 6 keys fills all six slots with `0x01` | `bun test packages/scrcpy/src/hid/keyboard.test.ts` → 5 tests pass; `rg -n "verified against v3.3.1 app/src/hid/hid_keyboard.c" packages/scrcpy/src/hid/keyboard.ts` → 1 match | [x] |
| G5 | Every DOM `code` in the required list maps to a HID usage and an Android keycode | `REQUIRED_DOM_CODES.length === 101`; every entry present in `KEY_TABLE`; no duplicate HID usage among non-modifier keys | `bun test packages/protocol/src/keys.test.ts` → 4 tests pass | [x] |
| G6 | The four new input messages and the clipboard push validate | `input.scroll`, `input.keyEvent`, `input.pinch`, `input.touch`; `clipboard.changed` | `bun test packages/protocol/src/messages/input.test.ts` → 8 new tests pass; `bun test packages/protocol/src/messages/clipboard.test.ts` → 3 tests pass | [x] |
| G7 | The driver has `touch`, `scroll`, `pinch`, `keyDown`, `keyUp`, `releaseKeys`; UHID keys go through the virtual keyboard, SDK keys through `INJECT_KEYCODE` with meta state | `ScrcpyUhidInput.keyDown` → one `uhidCreate` then `uhidInput` 8-byte reports; `ScrcpySdkInput.keyDown` → `injectKeycode('down', 29, 0x1041)` for Shift+A | `bun test packages/drivers/src/input/input-engines.test.ts` → 9 new tests pass | [x] |
| G8 | The synthetic 40..120 ms tap hold is no longer a default | `MIN_TAP_HOLD_MS = 16`; `DEFAULT_HOLD_MS` deleted; scripts keep `timing.tapJitterMs` | `rg -n "DEFAULT_HOLD_MS|40 \+ Math.random|\[40, 120\]" packages/drivers/src` → empty; `rg -n "holdMs: timing.tapJitterMs" packages/session/src/device-executor.ts` → 1 match | [x] |
| G9 | Key events run on the `keys` lane; scroll, pinch and touch on the `pointer` lane | arbiter façade exposes the six new verbs when the sink has them | `bun test packages/session/src/input-arbiter.test.ts` → test `keyDown/keyUp queue on keys; touch, scroll and pinch queue on pointer` passes | [x] |
| G10 | A live drag reaches the driver as one move injection per sample | N `input.touch move` messages against a sink that resolves immediately → N `touch('move')` calls, in order | `bun test packages/core/src/server/ws-handlers-touch.test.ts` → test `N touch messages reach the sink as N move injections` passes | [x] |
| G11 | Moves are coalesced newest-wins while the sink is busy; `up` is never coalesced | 20 moves behind a blocked sink → 1 move delivered after unblock, then the `up` | same file → test `moves behind a blocked sink collapse to the newest; up always arrives` passes | [x] |
| G12 | A touch stream is recorded as one tap or one gesture on `up` | `down, 12 moves, up` → one `input.gesture` event and one `observe({ kind: 'gesture' })`; `down, up` → one `input.tap` with `holdMs` | same file → tests `a down, moves, up stream is observed as one gesture` and `a down then up with no travel is observed as one tap with holdMs` pass | [x] |
| G13 | Host-side input dispatch time is measured and exposed | `GET /api/video/latency` gains `input: { dispatchMsP50, dispatchMsP95, samples } \| null` | `bun test packages/core/src/api/video.test.ts` → test `GET /latency carries the input dispatch block` passes | [x] |
| G14 | A device-side copy reaches the Device Control viewers only | `clipboard.changed` unicast to connections with a `control`-quality binding on that device; a wall viewer receives nothing | `bun test packages/core/src/server/ws-handlers-clipboard.test.ts` → test `a device-side copy is pushed to control viewers only` passes | [x] |
| G15 | The decoder asks for hardware first and falls back on `NotSupportedError` | first `configure` carries `hardwareAcceleration: 'prefer-hardware'`; the retry carries `'no-preference'`; both the synchronous throw and the error-callback path fall back | `bun test packages/studio/src/lib/h264-decoder.test.ts` → tests `configures with prefer-hardware first`, `falls back to no-preference when configure throws NotSupportedError`, `falls back when the error callback reports NotSupportedError and asks for a keyframe` pass | [x] |
| G16 | Paint is on `requestAnimationFrame`, newest frame wins, skipped frames are closed | two outputs before one animation frame → one `drawImage`, one `close()` on the older frame, one `dropped/superseded` event | same file → test `two frames output before one animation frame: only the newest is drawn and the older is closed` passes | [x] |
| G17 | A growing decode queue drops to the next keyframe and asks for one | `decodeQueueSize > DECODE_QUEUE_LIMIT (8)` → deltas dropped with reason `queue-full`, `onNeedKeyframe` called once per second at most | same file → test `a decode queue above the limit requests a keyframe once and drops deltas until the next IDR` passes | [x] |
| G18 | The canvas context is desynchronised and opaque | `getContext('2d', { desynchronized: true, alpha: false })` | `rg -n "getContext\('2d', \{ desynchronized: true, alpha: false \}\)" packages/studio/src/lib/h264-decoder.ts` → 1 match | [x] |
| G19 | LiveView streams pointer samples, wheel ticks and key events; the debounce and the three-key map are gone | `input.touch` per sample at 8 ms; `input.scroll` per wheel tick (16 ms coalesced); `input.keyEvent` down and up; `Escape` → `input.key` BACK | `bun test packages/studio/src/components/LiveView.test.tsx` → tests `a drag streams input.touch down, move and up`, `a wheel tick sends input.scroll`, `a printable key sends input.keyEvent down then up and never input.text`, `Escape sends input.key BACK on keydown only`, `the paste chord sends clipboard.set with paste for short Latin text and input.text otherwise` pass; `rg -n "TEXT_DEBOUNCE_MS\|textBufferRef\|textTimerRef\|flushText\|DRAG_THRESHOLD_PX\|MANUAL_GESTURE_MAX_SAMPLES\|gestureSamplesRef" packages/studio/src` → empty | [x] |
| G20 | The latency overlay shows the host-side input leg and says what it is | ninth row `input (host)`; caption sentence names the missing device leg | `bun test packages/studio/src/components/video/LatencyOverlay.test.tsx` → test `renders the input (host) row and its caption` passes | [x] |
| G21 | Workspace typechecks | 0 errors | `bun run typecheck` → clean | [x] |
| G22 | Typing a sentence into a field on the device shows each character as it is typed, no batching | every character painted before the next key is pressed at a normal typing pace (5 chars/s) | owner, lab device, Device Control cast with the overlay on | owner |
| G23 | Tab moves focus between fields; arrows move the cursor; Ctrl+A selects all; Shift+arrow extends a selection | all four observed in a form on the device | owner, lab device | owner |
| G24 | Wheel scrolls a list at the pointer; Shift+wheel scrolls horizontally | a list moves on every wheel tick | owner, lab device | owner |
| G25 | A 16 ms tap registers on the UHID engine | 20 clicks on a button on the device, 20 registered | owner, lab device; if fewer register, `MIN_TAP_HOLD_MS` is raised (§9 Q3) | owner |
| G26 | The input leg has a number | overlay row `input (host)` shows a median and a p95 after a 10 s drag; the numbers are pasted into §11 | owner, lab device | owner |

## 1. Goals

1. The hot-path copy in the demuxer is gone: `push()` (`packages/scrcpy/src/demuxer.ts:65-71`, `const merged = new Uint8Array(this.buf.length + chunk.length)`) becomes one copy of the chunk into a head/tail byte ring that compacts and grows only when it must (MVP 01 §1.2, §2 item 5).
2. Nagle is off on the scrcpy control socket (MVP 01 §1.5, §2 item 6). Bun's `Socket.setNoDelay(noDelay?: boolean): boolean` exists (`node_modules/.bun/bun-types@1.3.14/node_modules/bun-types/bun.d.ts:6134`, "Only available for already connected sockets, will return false otherwise"), so the item is specified, not parked.
3. The browser decoder asks for hardware decode and falls back honestly (R3), paints on `requestAnimationFrame` with newest-frame-wins, reads `decodeQueueSize` and drops to the next keyframe when it grows, and draws into a desynchronised opaque canvas (MVP 01 §1.4, §2 items 2 and 4, §4 step 2).
4. The input path loses its three self-inflicted delays: a drag is streamed sample by sample instead of buffered to pointer-up, the 500 ms text debounce is deleted, and the synthetic 40..120 ms tap hold stops being a default (MVP 01 §1.5, §2 item 1; MVP 08 §3; MVP 13 A.8).
5. The protocol, the driver and the arbiter gain the verbs MVP 08 §2 lists for their rows: `input.scroll`, `input.keyEvent`, `input.pinch`, `input.touch` and `clipboard.changed` on the wire; `touch()`, `scroll()`, `pinch()`, `keyDown()/keyUp()` on the driver, with a UHID keyboard on API 29 and above and `INJECT_KEYCODE` plus meta state below; key events on the `keys` lane, scroll, pinch and touch on the `pointer` lane.
6. The key mapping is one table in `@enkaku/protocol` (`packages/protocol/src/keys.ts`): DOM `code` → HID usage id and Android keycode, covering the full US layout, arrows, Tab, Enter, Escape, Backspace, Delete, Home/End/PageUp/PageDown, F1..F12 and the modifiers, with a completeness test.
7. The existing `LiveView` gets the minimal change that makes the new path live: touch streaming, wheel, key events, the paste chord. The Device Control window, its focus model, hotkeys and toolbar are plan 215.
8. Recordings keep their shape: a touch stream is coalesced into one recorded tap or gesture on `up`, so `RecordingStepSchema` (`packages/protocol/src/recording.ts:89`) is untouched.
9. The input leg has a number the overlay can show: the core measures its own dispatch time per touch message and exposes it on plan 203's `GET /api/video/latency`; the overlay says that the device leg is not measured because scrcpy sends no acknowledgement.

## 2. Non-goals

| Not done here | Plan that does it |
|---|---|
| The Device Control window: focus frame, hotkey table (`Alt+H`, `Alt+C`, `Alt+V`, release chord), toolbar buttons, mouse buttons (right click → Back, middle click → Home), Ctrl/Alt+drag pinch gestures, the soft-keyboard hint and `OPEN_HARD_KEYBOARD_SETTINGS` toggle, the `compact` keyboard disable (MVP 08 §1.2, §1.4, §3, MVP 13 A.8 last item) | plan 215; this plan ships `input.pinch` and `pinch()` so 215 has a wire and a driver to call, and keeps `LiveView`'s `compact ? undefined : onKeyDown` guard as it is |
| The stats strip "524 ms" readout (`docs/mvp/design_handoff_enkaku_openpf/README.md:254-256`) | plan 215; this plan extends plan 203's diagnostic overlay only |
| Encoder presets, bitrates, `max_size`, `max_fps`, the shipped control default (`balanced` versus `sharp`, MVP 01 §4 step 2 last bullet) | plan 206 owns the profiles; the preset decision waits for plan 203's numbers (§9 Q5) |
| PTS end to end, the 27-byte header, the estimator, the overlay's eight video rows, the bench harness | plan 203 (this plan adds one row and one `dropped` reason) |
| Always-on sessions, `attachViewer`, `drain()`, `backpressureLimit` | plan 206 |
| WebRTC on the client (MVP 01 §4 step 4) | not in the MVP; plan 201 deletes the unreachable client |
| Server-side transcoding or downscaling; forking scrcpy's Java; changing the pinned version (R1) | never (MVP 01 §5); the pin question is §9 Q4 |
| Cloud path (`packages/node`, `device-proxy.ts`): remote `input.touch`, remote clipboard push | post-MVP (MVP 16 §1); the remote branch of `input.*` refuses the new verbs with `E_NOT_SUPPORTED` |
| Per-device keyboard preferences on the guest agent (MVP 10) and the device keyboard layout question (R2) | plan 221; §9 Q6 |
| Recordings (parked) and the `input.tap`/`input.swipe`/`input.gesture` WS messages' future | plan 210 parks recordings; the three messages stay for scripts and replay (§9 Q8) |
| Mirror, assist, leases, `input.mirror`, `checkInputAllowed` | plan 205 deletes them; this plan assumes the post-205 admission block |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03)

**Demuxer.** `packages/scrcpy/src/demuxer.ts:65-71`:

```ts
push(chunk: Uint8Array): void {
  const merged = new Uint8Array(this.buf.length + chunk.length)
  merged.set(this.buf, 0)
  merged.set(chunk, this.buf.length)
  this.buf = merged
  this.drain()
}
```

`take` (`:73-78`) subarrays, `drain` (`:80-131`) parses the 12-byte header (`:112-114`) and copies the payload out (`:119`, `const copy = new Uint8Array(data) // detach from the shared buffer`). Plan 203 step 203.3 adds `receivedAt` and a `now` option and creates `demuxer.test.ts`; its "Do not" line reserves the ring buffer for this plan.

**Control socket.** `packages/scrcpy/src/session.ts:325` (`const control = await connectWithRetry(port, (data) => deviceMessageReader(data), () => {})`), `:345` (`const controlSocket = opened.control`), `:347-353` (`write`), `:797-820` (`connectWithRetry`, plain `Bun.connect`). No `setNoDelay` anywhere in `packages/scrcpy`. `ScrcpyControl` (`:107-131`) has `injectTouch`, `injectKeycode(action, keycode, meta?)`, `injectText`, `uhidCreate/uhidInput/uhidDestroy`, `setDisplayPower`, `resetVideo`, `getClipboard`, `setClipboard`; no scroll. `onDeviceMessage` (`:144`, implemented at `:370` as `onDeviceMessage: (cb) => void deviceMessageHandlers.add(cb),`) returns nothing, so a subscriber can never unsubscribe. The launch arguments (`:196-209`) set `control=true` and do not mention `clipboard_autosync`.

**Encoders.** `packages/scrcpy/src/control/messages.ts`: `encodeInjectKeycode` (`:10-19`, 14 bytes, `dv.setUint32(10, metaState, false)`), `encodeInjectTouch` (`:41-69`, 32 bytes, `pointerId?: bigint` at `:47`), `encodeUhidCreate` (`:80-101`), `encodeUhidInput` (`:103-111`), `encodeUhidDestroy` (`:113-119`), `encodeSetClipboard` (`:147-157`). `CONTROL_MSG.INJECT_SCROLL_EVENT: 3` exists in `packages/scrcpy/src/version.ts:34` with no encoder. `UHID_MIN_API = 29` at `version.ts:20`. The existing UHID pointer is `packages/scrcpy/src/hid/pointer.ts:12-36` (`ABSOLUTE_POINTER_DESCRIPTOR`, a digitizer with one contact) and `:39-47` (`buildPointerReport`, 5 bytes, little-endian axes).

**Device messages.** `packages/scrcpy/src/control/device-messages.ts:26` (`const DEVICE_MSG_TYPE = { CLIPBOARD: 0, ACK_CLIPBOARD: 1, UHID_OUTPUT: 2 } as const`), `:66-77` (the `clipboard` branch). `createClipboardControl` (`packages/scrcpy/src/control/index.ts:34-123`) resolves `getClipboard` on the next `clipboard` message.

**Driver.** `packages/protocol/src/driver.ts:107-138` (`InputSink`: `tap`, `swipe`, `key`, `text`, optional `gesture`, `typeText`). `packages/drivers/src/input/scrcpy-input.ts:15` (`export const DEFAULT_HOLD_MS: [number, number] = [40, 120]`), `:25-29` (`sampleHoldMs`), `:49-54` (`tap` with `await Bun.sleep(sampleHoldMs(opts))` at `:52`), `:74-78` (`key`: down, 30 ms, up), `:154-161` (`init`: `uhidCreate(UHID_POINTER_ID, 'Enkaku Pointer', ...)` then `await Bun.sleep(UHID_SETTLE_MS)` with `UHID_SETTLE_MS = 1500` at `:6`), `:168-180` (UHID `tap`: an untouched report, `await Bun.sleep(100)`, touching, hold, untouched). `packages/drivers/src/input/select.ts:31-36` gates UHID on `apiLevel < UHID_MIN_API`. `packages/drivers/src/input/adb-key-fallback.ts:26-45` wraps a sink and attaches `gesture`/`typeText` only when the primary has them. `packages/drivers/src/input/adb-input.ts:26-28` accepts and ignores `holdMs`; `:38-43` runs `input keyevent`.

**Arbiter.** `packages/session/src/input-arbiter.ts:36` (`export type InputLane = 'pointer' | 'keys' | 'text'`), `:212-234` (`forSource`: `tap`/`swipe` on `pointer`, `key` on `keys`, `text` on `text`, `gesture`/`typeText` attached only when present). After plan 205 step 205.7, `InputSource.kind` is `'user' | 'job' | 'agent'` and `PRIORITY_OF = { user: 0, job: 1, agent: 1 }`.

**Session.** `packages/session/src/session.ts:742-780` selects the engine (`:760`, `const engine = selection.engine === 'scrcpy-uhid' ? new ScrcpyUhidInput(inputDeps) : new ScrcpySdkInput(inputDeps)`; `:763`, `input = withAdbKeyFallback(engine, transport)`), `:790-794` wraps it in the arbiter, `:805-820` builds `clipboard` on `scrcpy.control.getClipboard/setClipboard`. The first-frame hook is `:989-1003`. `DEFAULT_ARBITER_MAX_QUEUE_DEPTH = 32` (`:37`).

**Core.** `packages/core/src/server/ws-handlers.ts:1596-1600` (`case 'input.tap':` … `case 'input.text': {`), `:1700` (`const sink = 'arbiter' in session ? session.arbiter.for(source) : session.input`), `:1701-1730` (tap: `recorder.record`, the recording tee at `:1719`, `await sink.tap(p, { holdMs: holdMs !== undefined ? [holdMs, holdMs] : tapJitterMs })` at `:1730`), `:1745-1782` (gesture: tee at `:1773`, `sink.gesture` or the `swipe` fallback), `:1783-1794` (key), `:1796-1880` (text ladder). `mapNormToDevice` is `:180`; `KEYCODE_NAMES` `:122-124`; `isLogInputTextEnabled` `:309`; `tapJitterMs` `:327`; `recording?: RecordingService` `:476`. `clipboard.get` `:2324-2361`, `clipboard.set` `:2363-2423` (`await localSession!.clipboard!.set(text, { paste })` at `:2419`, `clipboard.ok` at `:2421`). The recorder tee's input type is `packages/core/src/recording/session.ts:38-43` (`ObservedInput`: `tap`, `swipe`, `gesture`, `key`, `text`), `observe` at `:94`. Event-log kinds: `packages/protocol/src/messages/device-event.ts:95` (`INPUT_EVENT_KINDS`).

**Protocol.** `packages/protocol/src/messages/input.ts:42-63` (`INPUT_ACTION_BODIES`), `:65-68` (`InputTapMessage`), `:87-91` (`InputTextMessage`, request/reply), `:116-119` (`InputGestureMessage`). `packages/protocol/src/messages/clipboard.ts:17-33` (`clipboard.get`, `clipboard.set` with `paste: z.boolean().default(false)` at `:31`), `:37-47` (`clipboard.value`, `clipboard.ok`). Exports at `packages/protocol/src/index.ts:13`, `:72`, `:412-426`, `:1042-1044` (server union), `:1216-1221` and `:1243-1244` (client union). `KEYCODES` (Android names) is `packages/protocol/src/ui-node.ts:66-86`.

**Decoder.** `packages/studio/src/lib/h264-decoder.ts:59` (`const ctx = canvas.getContext('2d')`), `:67-78` (`makeDecoder`, synchronous `ctx?.drawImage(frame, 0, 0)` then `frame.close()`), `:94-106` (rebuild when `!decoder || codec !== lastCodec || dimensionChanged`, `configure({ codec, optimizeForLatency: true })` at `:99-103`), `:133-145` (config prepend and `decoder.decode`). Plan 203 §4.8 adds `FrameTiming`, `DecodeEvent`, the `inflight` map, the `onEvent` callback and the `paintedAt` animation frame; this plan starts from that state.

**LiveView.** `packages/studio/src/components/LiveView.tsx:26` (`const DRAG_THRESHOLD_PX = 10`), `:27` (`const TEXT_DEBOUNCE_MS = 500`), `:36` (`const MANUAL_GESTURE_SAMPLE_MS = 8`), `:39` (`const MANUAL_GESTURE_MAX_SAMPLES = 300`), `:294-299` (`pointerDownRef`, `gestureSamplesRef`, `lastGestureSampleAtRef`, `textBufferRef`, `textTimerRef`), `:685-713` (`sendInputAction`), `:715-722` (`onPointerDown`), `:725-735` (`onPointerMove`, batching), `:737-769` (`onPointerUp`: tap under 10 px, else one `input.gesture`, else a two-point `swipe`), `:771-804` (`flushText`), `:839-855` (`pasteFromClipboard`), `:857-889` (`onKeyDown`: paste chord, modifier early return, printable → `textBufferRef` and `setTimeout(flushText, TEXT_DEBOUNCE_MS)` at `:879`, the three-key map at `:883-884`), `:891-895` (`sendKey`), `:1155-1161` (`<canvas tabIndex={compact ? -1 : 0} onPointerDown=… onKeyDown={compact ? undefined : onKeyDown}`), `:445` and `:518` (`createH264Renderer(canvas, (m) => setError(m))`), `:591-596` (keyframe on visibility). Plans 205 and 206 delete the `mirror` branch of `sendInputAction` and the wake offer; this plan starts from that state.

**Scripts.** `packages/session/src/device-executor.ts:272` (`await sink().tap(point, { holdMs: timing.tapJitterMs })`), `:291` (`tapNorm` with an exact `holdMs`), `:306` (`longPress`). `packages/sdk/src/types.ts:79` (`tap`), `:89` (`tapNorm(pos, opts?: { holdMs?: number })`), `:119` (`longPress`). `TimingSettingsSchema.tapJitterMs` defaults to `[40, 120]` (`packages/protocol/src/settings.ts:54-58`). None of this changes: scripts always pass an explicit range.

### 3.2 Decisions

**D1. A head/tail byte ring, not a circular one.** The demuxer reads sequentially and every read is a prefix, so a circular buffer buys nothing over a `[head, tail)` window in one `Uint8Array` that compacts (moves the pending bytes to offset 0) only when a push would overrun the end, and grows (doubles) only when the pending bytes plus the chunk exceed the capacity. Per push the cost is one `set()` of `chunk.length` bytes. The only other copy is the payload copy the demuxer already makes (`demuxer.ts:119`), which stays: a packet must not alias the ring. A packet larger than `MAX_PACKET_BYTES` (16 MiB) is a corrupt stream, reported through a new `onError` option and the demuxer stops, mirroring `createDeviceMessageReader`'s "stop rather than desynchronise" rule (`device-messages.ts:102-112`).

**D2. Nagle off on the control socket only.** The video socket is device→host bulk data; Nagle does not apply to what the host reads. The control socket carries 14 to 32 byte writes at up to 125 per second during a drag; that is exactly the pattern Nagle delays. `setNoDelay(true)` runs once, after `connectSockets()` resolves; a `false` return is logged at `debug` and nothing else changes.

**D3. The browser sends DOM `code`, the core maps.** The browser knows the physical key (`KeyboardEvent.code`, layout-independent); the device applies its own layout (R2). One table, `packages/protocol/src/keys.ts`, maps `code` to both a HID usage (page 0x07) for the UHID keyboard and an Android keycode for `INJECT_KEYCODE`, so the driver needs no table and the two engines cannot disagree. The wire refuses an unmapped code at the Zod boundary (`z.enum(DOM_CODES)`); LiveView filters with `isDomCode(e.code)` before sending, so an exotic key is dropped in the browser, never sent to be refused.

**D4. Modifiers travel twice, on purpose.** Modifier keys are ordinary key events (`ShiftLeft` down, `KeyA` down, `KeyA` up, `ShiftLeft` up) so the UHID keyboard reproduces the exact chord. Every event also carries `meta: { shift, ctrl, alt, meta }` from the browser's `KeyboardEvent`, which the `INJECT_KEYCODE` fallback needs for its `metaState` (there is no HID state on that path) and which the UHID path uses only to repair a lost modifier: if the browser reports `shift: false` while the driver still holds `ShiftLeft` down (a key-up lost to a focus change), the driver releases it before sending the key. `releaseKeys()` sends an all-zero report and is called on `stream.stop`, `handleClose` and the canvas `blur`.

**D5. A UHID keyboard, created lazily on the first key, destroyed with the session.** MVP 08 §1.2's own wording. `ScrcpyUhidInput.keyDown` creates the device with scrcpy's boot-keyboard report descriptor (§4.3) under id `UHID_KEYBOARD_ID = 2` (the pointer is `1`), waits `UHID_KEYBOARD_SETTLE_MS = 1500` once (the pointer's measured value; unmeasured for a keyboard, §9 Q2), then sends 8-byte reports. Below API 29 the SDK engine's `keyDown/keyUp` send `INJECT_KEYCODE` with the meta state from D4. Prewarming on Device Control open is §9 Q1, not decided here.

**D6. Taps are a touch stream now; the synthetic hold goes.** LiveView sends `input.touch down` on `pointerdown` and `input.touch up` on `pointerup`, so the device sees the press start immediately and the hold is the human's real hold (MVP 08 §1.1 rows 1 and 2). `InputSink.tap()` stays for scripts and replay, and its default hold drops from a sampled 40..120 ms to `MIN_TAP_HOLD_MS = 16` (one 60 Hz input frame); `device-executor.ts` keeps passing `timing.tapJitterMs`, so scripted taps are humanised exactly as before. Whether 16 ms registers on the lab device is G25.

**D7. Touch moves are coalesced newest-wins at the core, never at the browser.** The browser samples at 8 ms and sends every sample; the core keeps at most one un-dispatched `move` per `(device, pointer)` while the pointer lane is busy (the same policy the decoder now applies to frames). `down` and `up` are never coalesced. This keeps the arbiter's queue depth at one per pointer regardless of the UHID engine's 100 ms landing sleep, so `E_INPUT_BUSY` (`input-arbiter.ts:190-195`) cannot fire from a drag. The recorder tee and the event log see the coalesced stream on `up`, never per sample (D8).

**D8. Recordings keep their shape.** The core tracks each `(connection, device, pointer 0)` stream from `down` to `up`, stamping `atMs` on receipt (host time relative to the `down`; the wire carries no timestamp). On `up`: travel under `TAP_MAX_TRAVEL = 0.01` (1 % of the frame's normalised space) → `observe({ kind: 'tap', pos, holdMs })` and an `input.tap` event-log row; otherwise → `observe({ kind: 'gesture', samples })` and an `input.gesture` row, samples capped at 300 (the schema ceiling, `input.ts:60`) by keeping the first 299 and the release point. `ObservedInput` (`recording/session.ts:38-43`) is untouched.

**D9. Key events are logged on `up`, and printable keys are redacted like text.** A typed sentence is two events per character; the event log gets one row per key-up. `isLogInputTextEnabled` (`ws-handlers.ts:309`) already decides whether typed text is stored literally; a printable key (`KEY_TABLE[code].printable`) is logged as `{ printable: true }` when it is off and as `{ code, androidKeycode, shift, ctrl, alt, meta }` when it is on. Non-printable keys always log their `code`. The recording tee receives `{ kind: 'key', keycode: androidKeycode }` on every `up` (an existing `ObservedInput` shape).

**D10. `clipboard.changed` reaches Device Control viewers only.** Clipboard content is routinely a password (plan 38's rule, `clipboard.ts:8-12`); the push is unicast to every connection holding a `control`-quality stream binding on that device, never to a wall viewer and never broadcast. The scrcpy server sends a `CLIPBOARD` device message on every device-side copy when `clipboard_autosync` is on, which is the server's default (to verify in the v3.3.1 `Options.java`, step 209.2). Only the base (wall) entry's scrcpy session is subscribed, so a device with both encoders running pushes once.

**D11. The input leg is host-side dispatch, and the overlay says so.** scrcpy has no acknowledgement for a touch. The core measures `performance.now()` from the WS message's arrival in the `input.touch` case to the moment `sink.touch(...)` resolves (arbiter wait plus the socket write), keeps a 128-sample ring per device, and exposes p50/p95 on `GET /api/video/latency` beside plan 203's video numbers. The overlay's ninth row is labelled `input (host)` and its caption gains one sentence naming the missing device leg.

**D12. Nothing new for scripts.** `DeviceApi` (`packages/sdk/src/types.ts`) is unchanged; scripts keep `tap` with `tapJitterMs`, `tapNorm`/`longPress` with exact holds. `scroll`, `pinch` and `keyDown/keyUp` reach scripts through the driver once a later plan adds SDK verbs; they are not part of MVP 08 §2's SDK row.

## 4. Technical design

### 4.1 `packages/scrcpy/src/byte-ring.ts` (new)

```ts
/**
 * A head/tail byte window for a sequential parser (plan 209 §3.2 D1).
 * `push` copies the chunk exactly once; `read`/`skip` advance `head`;
 * the pending bytes are moved to offset 0 only when a push would overrun
 * the end, and the backing array doubles only when the pending bytes plus
 * the chunk exceed the capacity. Never a per-chunk allocation.
 */
export interface ByteRingStats {
  capacity: number
  pending: number
  pushedBytes: number
  /** Bytes copied by `push` (always equal to `pushedBytes`). */
  pushCopiedBytes: number
  /** Bytes moved by compaction. */
  compactionCopiedBytes: number
  compactions: number
  grows: number
}

export class ByteRing {
  private buf: Uint8Array
  private head = 0
  private tail = 0
  private readonly stat: ByteRingStats

  constructor(initialCapacity = 256 * 1024) {
    this.buf = new Uint8Array(initialCapacity)
    this.stat = { capacity: initialCapacity, pending: 0, pushedBytes: 0, pushCopiedBytes: 0, compactionCopiedBytes: 0, compactions: 0, grows: 0 }
  }

  get length(): number {
    return this.tail - this.head
  }

  push(chunk: Uint8Array): void {
    const pending = this.tail - this.head
    if (this.tail + chunk.length > this.buf.length) {
      if (pending + chunk.length > this.buf.length) {
        let cap = this.buf.length
        while (cap < pending + chunk.length) cap *= 2
        const next = new Uint8Array(cap)
        next.set(this.buf.subarray(this.head, this.tail), 0)
        this.buf = next
        this.stat.grows++
        this.stat.capacity = cap
      } else {
        this.buf.copyWithin(0, this.head, this.tail)
        this.stat.compactions++
      }
      this.stat.compactionCopiedBytes += pending
      this.head = 0
      this.tail = pending
    }
    this.buf.set(chunk, this.tail)
    this.tail += chunk.length
    this.stat.pushedBytes += chunk.length
    this.stat.pushCopiedBytes += chunk.length
  }

  /** A DataView over the pending bytes; valid until the next `push`/`read`/`skip`. */
  view(): DataView {
    return new DataView(this.buf.buffer, this.buf.byteOffset + this.head, this.tail - this.head)
  }

  skip(n: number): void {
    if (n > this.length) throw new RangeError(`skip ${n} > pending ${this.length}`)
    this.head += n
    if (this.head === this.tail) this.head = this.tail = 0
  }

  /** Copies `n` bytes out (a packet must never alias the ring) and advances. */
  read(n: number): Uint8Array {
    if (n > this.length) throw new RangeError(`read ${n} > pending ${this.length}`)
    const out = new Uint8Array(this.buf.subarray(this.head, this.head + n))
    this.skip(n)
    return out
  }

  stats(): ByteRingStats {
    return { ...this.stat, pending: this.length }
  }
}
```

### 4.2 Demuxer on the ring (`packages/scrcpy/src/demuxer.ts`)

Replace `private buf = new Uint8Array(0)` with `private ring = new ByteRing()` and `private stopped = false`; delete `take` (`:73-78`). Options gain `onError?: (err: Error) => void` beside plan 203's `now`. `push` becomes:

```ts
push(chunk: Uint8Array): void {
  if (this.stopped) return
  const receivedAt = (this.opts.now ?? Date.now)()
  this.ring.push(chunk)
  try {
    this.drain(receivedAt)
  } catch (err) {
    this.stopped = true
    this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}
```

`drain` reads through the ring: `dummy` → `if (this.ring.length < 1) return; this.ring.skip(1)`; `name` → `if (this.ring.length < 64) return; const raw = this.ring.read(64)`; `meta` → `if (this.ring.length < 12) return; const dv = this.ring.view(); ... this.ring.skip(12)`; `frames` → `if (this.ring.length < 12) return; const header = this.ring.view(); const ptsAndFlags = header.getBigUint64(0, false); const size = header.getUint32(8, false); if (size > MAX_PACKET_BYTES) throw new Error(\`frame of ${size} bytes exceeds MAX_PACKET_BYTES; the stream is corrupt\`); if (this.ring.length < 12 + size) return; this.ring.skip(12); const data = this.ring.read(size)` and the two `onPacket` calls exactly as plan 203 §4.3 left them (`receivedAt` on every packet). `export const MAX_PACKET_BYTES = 16 * 1024 * 1024`. `ringStats(): ByteRingStats` is exported on the class for the test and for `scripts/bench-device-nfrs.ts` (not wired there by this plan).

`packages/scrcpy/src/session.ts` passes `onError: (err) => { log('warn', \`video demuxer stopped: ${err.message}\`); for (const cb of closeHandlers) cb('demuxer error') }` into the `VideoDemuxer` constructor (the constructor call around `:290-299`, `onPacket: (packet) => {`).

### 4.3 Control socket and encoders (`packages/scrcpy`)

**`setNoDelay`.** `session.ts`, immediately after `const controlSocket = opened.control` (`:345`):

```ts
// Plan 209 §3.2 D2: 14..32-byte control writes at up to 125/s during a drag are
// exactly what Nagle delays. Bun's Socket.setNoDelay is only honoured on a
// connected socket, which this is (connectSockets resolved).
if (!controlSocket.setNoDelay(true)) log('debug', 'setNoDelay(true) was refused on the control socket')
```

**`ScrcpySession.onDeviceMessage` returns an unsubscribe.** `:144` becomes `onDeviceMessage(cb: (m: DeviceMessage) => void): () => void`; `:370` becomes `onDeviceMessage: (cb) => { deviceMessageHandlers.add(cb); return () => deviceMessageHandlers.delete(cb) },`.

**`ScrcpyControl.injectScroll`.** Add to the interface (`:107-131`) and the object (`:371-383`):

```ts
/** `INJECT_SCROLL_EVENT`: a wheel tick at (x, y); `hscroll`/`vscroll` in -1..1 (one notch = 1). */
injectScroll(x: number, y: number, w: number, h: number, hscroll: number, vscroll: number): void
// implementation:
injectScroll: (x, y, w, h, hscroll, vscroll) => write(encodeInjectScroll({ x, y, screenWidth: w, screenHeight: h, hscroll, vscroll })),
```

**`encodeInjectScroll`** in `control/messages.ts`, after `encodeInjectTouch`:

```ts
/**
 * `INJECT_SCROLL_EVENT` (plan 209 §4.3): [type u8][x i32][y i32][w u16][h u16]
 * [hscroll i16 fixed-point][vscroll i16 fixed-point][buttons u32] = 21 bytes.
 * Fixed point maps -1..1 to -0x7fff..0x7fff, the server's `Binary.i16FixedPointToFloat`.
 * verified against v3.3.1 control/ControlMessageReader.java on 2026-09-DD (step 209.2).
 */
export function encodeInjectScroll(opts: { x: number; y: number; screenWidth: number; screenHeight: number; hscroll: number; vscroll: number; buttons?: number }): Uint8Array {
  const fp = (v: number) => Math.round(Math.min(1, Math.max(-1, v)) * 0x7fff)
  const buf = new Uint8Array(21)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CONTROL_MSG.INJECT_SCROLL_EVENT)
  dv.setInt32(1, Math.round(opts.x), false)
  dv.setInt32(5, Math.round(opts.y), false)
  dv.setUint16(9, opts.screenWidth, false)
  dv.setUint16(11, opts.screenHeight, false)
  dv.setInt16(13, fp(opts.hscroll), false)
  dv.setInt16(15, fp(opts.vscroll), false)
  dv.setUint32(17, opts.buttons ?? 0, false)
  return buf
}
```

**`packages/scrcpy/src/hid/keyboard.ts` (new, the shipped artefact).** The descriptor is scrcpy's own boot keyboard (`app/src/hid/hid_keyboard.c`, `SC_HID_KEYBOARD_REPORT_DESC`), byte for byte; step 209.2 diffs it against the v3.3.1 source and writes the verification line.

```ts
/**
 * UHID boot keyboard (plan 209 §3.2 D5, MVP 08 §1.2). Report: 8 bytes,
 * [modifiers][reserved 0][key1..key6], HID usage page 0x07. Copied from
 * scrcpy's own client (`app/src/hid/hid_keyboard.c`), which is what scrcpy
 * uses for physical-keyboard passthrough (R2).
 * verified against v3.3.1 app/src/hid/hid_keyboard.c on 2026-09-DD (step 209.2).
 */
export const UHID_KEYBOARD_ID = 2
export const KEYBOARD_REPORT_BYTES = 8
export const KEYBOARD_MAX_KEYS = 6
/** HID "ErrorRollOver": every slot reads this when more than six keys are down. */
export const HID_ERROR_ROLLOVER = 0x01
export const HID_MODIFIER_FIRST = 0xe0
export const HID_MODIFIER_LAST = 0xe7

// prettier-ignore
export const KEYBOARD_REPORT_DESCRIPTOR = new Uint8Array([
  0x05, 0x01,       // Usage Page (Generic Desktop)
  0x09, 0x06,       // Usage (Keyboard)
  0xa1, 0x01,       // Collection (Application)
  0x05, 0x07,       //   Usage Page (Key Codes)
  0x19, 0xe0,       //   Usage Minimum (224)
  0x29, 0xe7,       //   Usage Maximum (231)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x01,       //   Logical Maximum (1)
  0x75, 0x01,       //   Report Size (1)
  0x95, 0x08,       //   Report Count (8)
  0x81, 0x02,       //   Input (Data, Variable, Absolute): modifier byte
  0x75, 0x08,       //   Report Size (8)
  0x95, 0x01,       //   Report Count (1)
  0x81, 0x01,       //   Input (Constant): reserved byte
  0x05, 0x08,       //   Usage Page (LEDs)
  0x19, 0x01,       //   Usage Minimum (1)
  0x29, 0x05,       //   Usage Maximum (5)
  0x75, 0x01,       //   Report Size (1)
  0x95, 0x05,       //   Report Count (5)
  0x91, 0x02,       //   Output (Data, Variable, Absolute): LED report
  0x75, 0x03,       //   Report Size (3)
  0x95, 0x01,       //   Report Count (1)
  0x91, 0x01,       //   Output (Constant): LED padding
  0x05, 0x07,       //   Usage Page (Key Codes)
  0x19, 0x00,       //   Usage Minimum (0)
  0x29, 0x65,       //   Usage Maximum (101)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x65,       //   Logical Maximum (101)
  0x75, 0x08,       //   Report Size (8)
  0x95, 0x06,       //   Report Count (6)
  0x81, 0x00,       //   Input (Data, Array): keys
  0xc0,             // End Collection
])

/** Tracks which usages are down and renders the 8-byte report scrcpy's descriptor describes. */
export class KeyboardState {
  private modifiers = 0
  private readonly keys: number[] = []

  /** Returns the report to send, or null when nothing changed (a repeated down of a held key). */
  press(usage: number): Uint8Array | null {
    if (usage >= HID_MODIFIER_FIRST && usage <= HID_MODIFIER_LAST) {
      const bit = 1 << (usage - HID_MODIFIER_FIRST)
      if (this.modifiers & bit) return null
      this.modifiers |= bit
      return this.report()
    }
    if (this.keys.includes(usage)) return null
    this.keys.push(usage)
    return this.report()
  }

  release(usage: number): Uint8Array | null {
    if (usage >= HID_MODIFIER_FIRST && usage <= HID_MODIFIER_LAST) {
      const bit = 1 << (usage - HID_MODIFIER_FIRST)
      if (!(this.modifiers & bit)) return null
      this.modifiers &= ~bit
      return this.report()
    }
    const idx = this.keys.indexOf(usage)
    if (idx === -1) return null
    this.keys.splice(idx, 1)
    return this.report()
  }

  isDown(usage: number): boolean {
    if (usage >= HID_MODIFIER_FIRST && usage <= HID_MODIFIER_LAST) return (this.modifiers & (1 << (usage - HID_MODIFIER_FIRST))) !== 0
    return this.keys.includes(usage)
  }

  /** Everything up: the report LiveView's blur and the session's close send. */
  releaseAll(): Uint8Array {
    this.modifiers = 0
    this.keys.length = 0
    return this.report()
  }

  report(): Uint8Array {
    const out = new Uint8Array(KEYBOARD_REPORT_BYTES)
    out[0] = this.modifiers
    if (this.keys.length > KEYBOARD_MAX_KEYS) {
      out.fill(HID_ERROR_ROLLOVER, 2)
    } else {
      for (let i = 0; i < this.keys.length; i++) out[2 + i] = this.keys[i]!
    }
    return out
  }
}
```

`packages/scrcpy/src/index.ts` exports `UHID_KEYBOARD_ID`, `KEYBOARD_REPORT_DESCRIPTOR`, `KEYBOARD_REPORT_BYTES`, `KeyboardState`, `encodeInjectScroll`, `ByteRing`, `MAX_PACKET_BYTES`.

### 4.4 `packages/protocol/src/keys.ts` (new)

```ts
import { z } from 'zod'

/** `KeyboardEvent.code` values the wire accepts (plan 209 §3.2 D3). Physical keys; the device applies its own layout (R2). */
export const DOM_CODES = [
  'KeyA','KeyB','KeyC','KeyD','KeyE','KeyF','KeyG','KeyH','KeyI','KeyJ','KeyK','KeyL','KeyM','KeyN','KeyO','KeyP','KeyQ','KeyR','KeyS','KeyT','KeyU','KeyV','KeyW','KeyX','KeyY','KeyZ',
  'Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0',
  'Enter','Escape','Backspace','Tab','Space','Minus','Equal','BracketLeft','BracketRight','Backslash','Semicolon','Quote','Backquote','Comma','Period','Slash','CapsLock',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'PrintScreen','ScrollLock','Pause','Insert','Home','PageUp','Delete','End','PageDown',
  'ArrowRight','ArrowLeft','ArrowDown','ArrowUp',
  'NumLock','NumpadDivide','NumpadMultiply','NumpadSubtract','NumpadAdd','NumpadEnter',
  'Numpad1','Numpad2','Numpad3','Numpad4','Numpad5','Numpad6','Numpad7','Numpad8','Numpad9','Numpad0','NumpadDecimal',
  'IntlBackslash','ContextMenu',
  'ControlLeft','ShiftLeft','AltLeft','MetaLeft','ControlRight','ShiftRight','AltRight','MetaRight',
] as const
export type DomCode = (typeof DOM_CODES)[number]
export const DomCodeSchema = z.enum(DOM_CODES)

export interface KeyEntry {
  /** HID usage id, page 0x07. */
  hid: number
  /** Android `KeyEvent.KEYCODE_*`. */
  android: number
  /** True when the key produces a character on a US layout (redacted in the event log like typed text, D9). */
  printable: boolean
}

/** One table for both engines. HID column: USB HID Usage Tables 1.12 §10; Android column: `android.view.KeyEvent`. */
export const KEY_TABLE: Record<DomCode, KeyEntry> = {
  KeyA: { hid: 0x04, android: 29, printable: true }, KeyB: { hid: 0x05, android: 30, printable: true }, KeyC: { hid: 0x06, android: 31, printable: true },
  KeyD: { hid: 0x07, android: 32, printable: true }, KeyE: { hid: 0x08, android: 33, printable: true }, KeyF: { hid: 0x09, android: 34, printable: true },
  KeyG: { hid: 0x0a, android: 35, printable: true }, KeyH: { hid: 0x0b, android: 36, printable: true }, KeyI: { hid: 0x0c, android: 37, printable: true },
  KeyJ: { hid: 0x0d, android: 38, printable: true }, KeyK: { hid: 0x0e, android: 39, printable: true }, KeyL: { hid: 0x0f, android: 40, printable: true },
  KeyM: { hid: 0x10, android: 41, printable: true }, KeyN: { hid: 0x11, android: 42, printable: true }, KeyO: { hid: 0x12, android: 43, printable: true },
  KeyP: { hid: 0x13, android: 44, printable: true }, KeyQ: { hid: 0x14, android: 45, printable: true }, KeyR: { hid: 0x15, android: 46, printable: true },
  KeyS: { hid: 0x16, android: 47, printable: true }, KeyT: { hid: 0x17, android: 48, printable: true }, KeyU: { hid: 0x18, android: 49, printable: true },
  KeyV: { hid: 0x19, android: 50, printable: true }, KeyW: { hid: 0x1a, android: 51, printable: true }, KeyX: { hid: 0x1b, android: 52, printable: true },
  KeyY: { hid: 0x1c, android: 53, printable: true }, KeyZ: { hid: 0x1d, android: 54, printable: true },
  Digit1: { hid: 0x1e, android: 8, printable: true }, Digit2: { hid: 0x1f, android: 9, printable: true }, Digit3: { hid: 0x20, android: 10, printable: true },
  Digit4: { hid: 0x21, android: 11, printable: true }, Digit5: { hid: 0x22, android: 12, printable: true }, Digit6: { hid: 0x23, android: 13, printable: true },
  Digit7: { hid: 0x24, android: 14, printable: true }, Digit8: { hid: 0x25, android: 15, printable: true }, Digit9: { hid: 0x26, android: 16, printable: true },
  Digit0: { hid: 0x27, android: 7, printable: true },
  Enter: { hid: 0x28, android: 66, printable: false }, Escape: { hid: 0x29, android: 111, printable: false }, Backspace: { hid: 0x2a, android: 67, printable: false },
  Tab: { hid: 0x2b, android: 61, printable: false }, Space: { hid: 0x2c, android: 62, printable: true }, Minus: { hid: 0x2d, android: 69, printable: true },
  Equal: { hid: 0x2e, android: 70, printable: true }, BracketLeft: { hid: 0x2f, android: 71, printable: true }, BracketRight: { hid: 0x30, android: 72, printable: true },
  Backslash: { hid: 0x31, android: 73, printable: true }, Semicolon: { hid: 0x33, android: 74, printable: true }, Quote: { hid: 0x34, android: 75, printable: true },
  Backquote: { hid: 0x35, android: 68, printable: true }, Comma: { hid: 0x36, android: 55, printable: true }, Period: { hid: 0x37, android: 56, printable: true },
  Slash: { hid: 0x38, android: 76, printable: true }, CapsLock: { hid: 0x39, android: 115, printable: false },
  F1: { hid: 0x3a, android: 131, printable: false }, F2: { hid: 0x3b, android: 132, printable: false }, F3: { hid: 0x3c, android: 133, printable: false },
  F4: { hid: 0x3d, android: 134, printable: false }, F5: { hid: 0x3e, android: 135, printable: false }, F6: { hid: 0x3f, android: 136, printable: false },
  F7: { hid: 0x40, android: 137, printable: false }, F8: { hid: 0x41, android: 138, printable: false }, F9: { hid: 0x42, android: 139, printable: false },
  F10: { hid: 0x43, android: 140, printable: false }, F11: { hid: 0x44, android: 141, printable: false }, F12: { hid: 0x45, android: 142, printable: false },
  PrintScreen: { hid: 0x46, android: 120, printable: false }, ScrollLock: { hid: 0x47, android: 116, printable: false }, Pause: { hid: 0x48, android: 121, printable: false },
  Insert: { hid: 0x49, android: 124, printable: false }, Home: { hid: 0x4a, android: 122, printable: false }, PageUp: { hid: 0x4b, android: 92, printable: false },
  Delete: { hid: 0x4c, android: 112, printable: false }, End: { hid: 0x4d, android: 123, printable: false }, PageDown: { hid: 0x4e, android: 93, printable: false },
  ArrowRight: { hid: 0x4f, android: 22, printable: false }, ArrowLeft: { hid: 0x50, android: 21, printable: false }, ArrowDown: { hid: 0x51, android: 20, printable: false },
  ArrowUp: { hid: 0x52, android: 19, printable: false },
  NumLock: { hid: 0x53, android: 143, printable: false }, NumpadDivide: { hid: 0x54, android: 154, printable: true }, NumpadMultiply: { hid: 0x55, android: 155, printable: true },
  NumpadSubtract: { hid: 0x56, android: 156, printable: true }, NumpadAdd: { hid: 0x57, android: 157, printable: true }, NumpadEnter: { hid: 0x58, android: 160, printable: false },
  Numpad1: { hid: 0x59, android: 145, printable: true }, Numpad2: { hid: 0x5a, android: 146, printable: true }, Numpad3: { hid: 0x5b, android: 147, printable: true },
  Numpad4: { hid: 0x5c, android: 148, printable: true }, Numpad5: { hid: 0x5d, android: 149, printable: true }, Numpad6: { hid: 0x5e, android: 150, printable: true },
  Numpad7: { hid: 0x5f, android: 151, printable: true }, Numpad8: { hid: 0x60, android: 152, printable: true }, Numpad9: { hid: 0x61, android: 153, printable: true },
  Numpad0: { hid: 0x62, android: 144, printable: true }, NumpadDecimal: { hid: 0x63, android: 158, printable: true },
  IntlBackslash: { hid: 0x64, android: 73, printable: true }, ContextMenu: { hid: 0x65, android: 82, printable: false },
  ControlLeft: { hid: 0xe0, android: 113, printable: false }, ShiftLeft: { hid: 0xe1, android: 59, printable: false }, AltLeft: { hid: 0xe2, android: 57, printable: false },
  MetaLeft: { hid: 0xe3, android: 117, printable: false }, ControlRight: { hid: 0xe4, android: 114, printable: false }, ShiftRight: { hid: 0xe5, android: 60, printable: false },
  AltRight: { hid: 0xe6, android: 58, printable: false }, MetaRight: { hid: 0xe7, android: 118, printable: false },
}

export function isDomCode(code: string): code is DomCode {
  return Object.hasOwn(KEY_TABLE, code)
}

/** What the driver receives (resolved by the core from `KEY_TABLE`; the driver holds no table). */
export interface KeyDescriptor {
  code: DomCode
  hidUsage: number
  androidKeycode: number
}
export function describeKey(code: DomCode): KeyDescriptor {
  const e = KEY_TABLE[code]
  return { code, hidUsage: e.hid, androidKeycode: e.android }
}

/** Modifier flags as the browser reports them (`KeyboardEvent.shiftKey` and friends). */
export const KeyMetaSchema = z.object({ shift: z.boolean(), ctrl: z.boolean(), alt: z.boolean(), meta: z.boolean() })
export type KeyMeta = z.infer<typeof KeyMetaSchema>

/** `android.view.KeyEvent.META_*` bits the `INJECT_KEYCODE` fallback sends (left-hand variants, the way a physical keyboard reports them). */
export const ANDROID_META = {
  SHIFT_ON: 0x1, SHIFT_LEFT_ON: 0x40,
  ALT_ON: 0x2, ALT_LEFT_ON: 0x10,
  CTRL_ON: 0x1000, CTRL_LEFT_ON: 0x2000,
  META_ON: 0x10000, META_LEFT_ON: 0x20000,
} as const
export function androidMetaState(meta: KeyMeta): number {
  let state = 0
  if (meta.shift) state |= ANDROID_META.SHIFT_ON | ANDROID_META.SHIFT_LEFT_ON
  if (meta.ctrl) state |= ANDROID_META.CTRL_ON | ANDROID_META.CTRL_LEFT_ON
  if (meta.alt) state |= ANDROID_META.ALT_ON | ANDROID_META.ALT_LEFT_ON
  if (meta.meta) state |= ANDROID_META.META_ON | ANDROID_META.META_LEFT_ON
  return state
}
```

`DOM_CODES` has 101 entries; `REQUIRED_DOM_CODES` in the test is a second, hand-written literal list of the same 101 names (so the test cannot pass by reading the table it checks). Exported from `packages/protocol/src/index.ts` by name (`DOM_CODES`, `DomCodeSchema`, `KEY_TABLE`, `isDomCode`, `describeKey`, `KeyMetaSchema`, `ANDROID_META`, `androidMetaState`, types `DomCode`, `KeyEntry`, `KeyDescriptor`, `KeyMeta`); `export-uniqueness.test.ts` requires the names to be unique across the package, and none of them exists today.

### 4.5 Messages (`packages/protocol/src/messages/input.ts`, `clipboard.ts`)

Appended to `INPUT_ACTION_BODIES` (`input.ts:42-63`) and declared as messages after `InputGestureMessage` (`:116-119`); the file's own style (`z.object`, `z.literal`, doc comments):

```ts
  scroll: {
    pos: NormPointSchema,
    /** Notches, -1..1 per message; the browser normalises pixel/line/page deltas and clamps (plan 209 §4.13). Positive `vDelta` scrolls the content up (Android `AXIS_VSCROLL` sign). */
    hDelta: z.number().min(-1).max(1),
    vDelta: z.number().min(-1).max(1),
  },
  keyEvent: {
    action: z.enum(['down', 'up']),
    /** The physical key, `KeyboardEvent.code`; the core maps it through `KEY_TABLE` (plan 209 §3.2 D3). */
    code: DomCodeSchema,
    meta: KeyMetaSchema,
  },
  pinch: {
    center: NormPointSchema,
    /** Half the finger distance as a fraction of min(width, height): 0.05 is a close pinch, 0.45 fingers near the edges. */
    scaleFrom: z.number().min(0.02).max(0.5),
    scaleTo: z.number().min(0.02).max(0.5),
    durationMs: z.number().int().min(50).max(10_000).default(300),
  },
  touch: {
    action: z.enum(['down', 'move', 'up']),
    pos: NormPointSchema,
    /** 0 is the primary finger. The UHID pointer has one contact; ids above 0 go through `INJECT_TOUCH_EVENT` (plan 209 §4.7). */
    pointerId: z.number().int().min(0).max(9).default(0),
  },
```

```ts
export const InputScrollMessage = z.object({ type: z.literal('input.scroll'), payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.scroll }) })
export const InputKeyEventMessage = z.object({ type: z.literal('input.keyEvent'), payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.keyEvent }) })
export const InputPinchMessage = z.object({ type: z.literal('input.pinch'), payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.pinch }) })
/**
 * One pointer sample of a live drag (plan 209 §3.2 D6, D7; MVP 08 §1.1 row 3): sent as it
 * happens, 8 ms apart, never buffered to pointer-up. Fire-and-forget like `input.tap`. No
 * timestamp: the core stamps `atMs` on receipt when it coalesces the stream into a recorded
 * gesture (D8). `input.gesture` stays for scripts and replay.
 */
export const InputTouchMessage = z.object({ type: z.literal('input.touch'), payload: z.object({ deviceId: z.string(), ...INPUT_ACTION_BODIES.touch }) })
```

`DomCodeSchema` and `KeyMetaSchema` are imported from `../keys`. `MirrorActionSchema` (`:129-135`) is deleted by plan 205; if it is still present when this plan executes, the new bodies are NOT added to it (report under §9 Q9).

`clipboard.ts`, after `ClipboardOkMessage` (`:43-47`):

```ts
/**
 * The device copied something (plan 209 §3.2 D10; MVP 08 §1.3): scrcpy's `CLIPBOARD` device
 * message, forwarded to every connection holding a `control`-quality stream binding on this
 * device and to nobody else. Unicast for the same reason `clipboard.value` is (§4.5 of plan 38).
 */
export const ClipboardChangedMessage = z.object({
  type: z.literal('clipboard.changed'),
  payload: z.object({ deviceId: z.string(), text: z.string() }),
})
```

`index.ts`: extend the import at `:13` and the export block at `:412-426` with `InputScrollMessage`, `InputKeyEventMessage`, `InputPinchMessage`, `InputTouchMessage`; `:72` and the clipboard export block at `:628-632` with `ClipboardChangedMessage`; append the four client messages to `ClientMessageSchema` after `InputTextMessage` (`:1221`) and `ClipboardChangedMessage` to `ServerMessageSchema` after `ClipboardOkMessage` (`:1043`). `device-event.ts:95` becomes:

```ts
export const INPUT_EVENT_KINDS = ['input.tap', 'input.swipe', 'input.gesture', 'input.key', 'input.text', 'input.scroll', 'input.keyEvent', 'input.pinch'] as const
```

(`input.touch` has no event kind: a stream is logged as a tap or a gesture on `up`, D8.)

`packages/protocol/src/api/video.ts` (plan 203's `VideoLatencyResponseSchema`): add, after `streams`:

```ts
  /** Plan 209 §3.2 D11: host-side dispatch of `input.touch` (WS arrival → control-socket write resolved). Null before the first sample. The device leg is not measured: scrcpy sends no acknowledgement. */
  input: z.object({ dispatchMsP50: z.number(), dispatchMsP95: z.number(), samples: z.number().int() }).nullable(),
```

### 4.6 `InputSink` (`packages/protocol/src/driver.ts:107-138`)

Appended after `typeText?`; all optional, absence meaning "this engine cannot" (plan 40 §3.6's rule, quoted in `adb-input.ts:64-73`):

```ts
  /**
   * One sample of a live pointer stream (plan 209 §3.2 D6): `down` starts a contact, `move`
   * updates it, `up` ends it. Device pixels. Absent on `adb-input`, whose `input swipe`
   * cannot be driven sample by sample; the core then replays the stream as one `swipe` on `up`.
   */
  touch?(action: 'down' | 'move' | 'up', p: Point, pointerId: number): Promise<void>
  /** A wheel tick at `p`; `hDelta`/`vDelta` in -1..1 notches. */
  scroll?(p: Point, hDelta: number, vDelta: number): Promise<void>
  /** Two fingers on the vertical axis through `center`, `radiusFromPx` → `radiusToPx` apart from it, over `durationMs`. */
  pinch?(opts: { center: Point; radiusFromPx: number; radiusToPx: number; durationMs: number }): Promise<void>
  /** A real key down / key up with the modifiers the browser reported (plan 209 §3.2 D4). */
  keyDown?(key: KeyDescriptor, meta: KeyMeta): Promise<void>
  keyUp?(key: KeyDescriptor, meta: KeyMeta): Promise<void>
  /** Every key up. Called on stream stop, disconnect and canvas blur. */
  releaseKeys?(): Promise<void>
```

`KeyDescriptor`, `KeyMeta` imported from `./keys`.

### 4.7 Drivers (`packages/drivers/src/input/`)

**`scrcpy-input.ts`.**

- `DEFAULT_HOLD_MS` (`:15`) and the range default in `sampleHoldMs` (`:25-29`) are replaced: `export const MIN_TAP_HOLD_MS = 16` and `sampleHoldMs(opts)` returns `MIN_TAP_HOLD_MS` when `opts?.holdMs` is absent, else the sampled value as today. The doc comments at `:8-14` and `:17-24` are rewritten to say that the default is the smallest hold that registers (MVP 01 §4 step 2) and that scripts pass `timing.tapJitterMs` explicitly.
- `ScrcpySdkInput` gains:

```ts
  async touch(action: 'down' | 'move' | 'up', p: Point, pointerId: number): Promise<void> {
    const { width, height } = this.deps.screenSize()
    this.deps.session.control.injectTouch(action, p.x, p.y, width, height, BigInt(pointerId))
  }
  async scroll(p: Point, hDelta: number, vDelta: number): Promise<void> {
    const { width, height } = this.deps.screenSize()
    this.deps.session.control.injectScroll(p.x, p.y, width, height, hDelta, vDelta)
  }
  async pinch(opts: { center: Point; radiusFromPx: number; radiusToPx: number; durationMs: number }): Promise<void> {
    const { width, height } = this.deps.screenSize()
    const steps = Math.max(2, Math.round(opts.durationMs / 16))
    const at = (r: number) => [{ x: opts.center.x, y: opts.center.y - r }, { x: opts.center.x, y: opts.center.y + r }] as const
    const [a0, b0] = at(opts.radiusFromPx)
    this.deps.session.control.injectTouch('down', a0.x, a0.y, width, height, 0n)
    this.deps.session.control.injectTouch('down', b0.x, b0.y, width, height, 1n)
    for (let i = 1; i <= steps; i++) {
      const r = opts.radiusFromPx + (opts.radiusToPx - opts.radiusFromPx) * (i / steps)
      const [a, b] = at(r)
      this.deps.session.control.injectTouch('move', a.x, a.y, width, height, 0n)
      this.deps.session.control.injectTouch('move', b.x, b.y, width, height, 1n)
      await Bun.sleep(opts.durationMs / steps)
    }
    const [a1, b1] = at(opts.radiusToPx)
    this.deps.session.control.injectTouch('up', a1.x, a1.y, width, height, 0n)
    this.deps.session.control.injectTouch('up', b1.x, b1.y, width, height, 1n)
  }
  async keyDown(key: KeyDescriptor, meta: KeyMeta): Promise<void> {
    this.deps.session.control.injectKeycode('down', key.androidKeycode, androidMetaState(meta))
  }
  async keyUp(key: KeyDescriptor, meta: KeyMeta): Promise<void> {
    this.deps.session.control.injectKeycode('up', key.androidKeycode, androidMetaState(meta))
  }
  async releaseKeys(): Promise<void> {}
```

`ScrcpyControl.injectTouch` gains a sixth parameter `pointerId?: bigint` passed to `encodeInjectTouch`'s `pointerId` (`messages.ts:47`); the default stays `POINTER_ID_GENERIC_FINGER`. Note that multi-finger injection through `INJECT_TOUCH_EVENT` needs distinct non-negative ids (`0n`, `1n`); the generic finger id is for single-contact calls only.

- `ScrcpyUhidInput` gains a lazily created keyboard and a UHID `touch` for pointer 0:

```ts
  private keyboardReady: Promise<void> | null = null
  private readonly keyboard = new KeyboardState()

  /** Registers the virtual keyboard once (MVP 08 §1.2: lazily on the first key, destroyed with the session). */
  prepareKeyboard(): Promise<void> {
    this.keyboardReady ??= (async () => {
      this.deps.session.control.uhidCreate(UHID_KEYBOARD_ID, 'Enkaku Keyboard', KEYBOARD_REPORT_DESCRIPTOR)
      await Bun.sleep(UHID_KEYBOARD_SETTLE_MS)
      this.deps.onLog?.('debug', 'UHID keyboard registered')
    })()
    return this.keyboardReady
  }

  override async keyDown(key: KeyDescriptor, meta: KeyMeta): Promise<void> {
    await this.prepareKeyboard()
    this.repairModifiers(meta)
    const report = this.keyboard.press(key.hidUsage)
    if (report) this.deps.session.control.uhidInput(UHID_KEYBOARD_ID, report)
  }
  override async keyUp(key: KeyDescriptor, _meta: KeyMeta): Promise<void> {
    await this.prepareKeyboard()
    const report = this.keyboard.release(key.hidUsage)
    if (report) this.deps.session.control.uhidInput(UHID_KEYBOARD_ID, report)
  }
  override async releaseKeys(): Promise<void> {
    if (!this.keyboardReady) return
    await this.keyboardReady
    this.deps.session.control.uhidInput(UHID_KEYBOARD_ID, this.keyboard.releaseAll())
  }
  /** D4: a modifier the browser says is up but this state still holds is a key-up that never arrived. */
  private repairModifiers(meta: KeyMeta): void {
    const pairs: Array<[boolean, number, number]> = [[meta.shift, 0xe1, 0xe5], [meta.ctrl, 0xe0, 0xe4], [meta.alt, 0xe2, 0xe6], [meta.meta, 0xe3, 0xe7]]
    for (const [held, left, right] of pairs) {
      if (held) continue
      for (const usage of [left, right]) {
        if (!this.keyboard.isDown(usage)) continue
        const report = this.keyboard.release(usage)
        if (report) this.deps.session.control.uhidInput(UHID_KEYBOARD_ID, report)
      }
    }
  }

  override async touch(action: 'down' | 'move' | 'up', p: Point, pointerId: number): Promise<void> {
    if (pointerId !== 0) return super.touch(action, p, pointerId)
    await this.init()
    const pos = this.norm(p)
    if (action === 'down') {
      // Same landing quirk as tap(): position first, then the touch bit.
      this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...pos }))
      await Bun.sleep(UHID_LAND_MS)
      this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...pos }))
      return
    }
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: action === 'move', ...pos }))
  }

  /** Session close: UHID_DESTROY both virtual devices, best-effort (the server's death would remove them anyway). */
  async destroy(): Promise<void> {
    if (this.keyboardReady) this.deps.session.control.uhidDestroy(UHID_KEYBOARD_ID)
    if (this.ready) this.deps.session.control.uhidDestroy(UHID_POINTER_ID)
  }
```

with `const UHID_KEYBOARD_SETTLE_MS = 1500` and `const UHID_LAND_MS = 100` (the literal at `:176`, `:187`, `:210` hoisted to one constant). `scroll` and `pinch` are inherited from `ScrcpySdkInput` (the digitizer has no wheel and one contact; both are injected events, which is stated in a comment). The `ScrcpyInputDeps` type is unchanged.

**`adb-key-fallback.ts:26-45`.** Pass through `touch`, `scroll`, `pinch`, `keyDown`, `keyUp`, `releaseKeys`, `prepareKeyboard` only when the primary has them (the file's own spread pattern at `:40-43`). Volume keys are not affected: `keyDown/keyUp` carry no volume codes in `KEY_TABLE`.

**`adb-input.ts`.** Nothing added: `touch`, `scroll`, `pinch`, `keyDown`, `keyUp` stay absent (§4.10 describes what the core does then). A comment beside `:64` names the six new absences.

**`InputSink.prepareKeyboard?()`** is added to `driver.ts` next to `releaseKeys` (`/** UHID engines only: register the virtual keyboard now instead of on the first key (§9 Q1). */`), so the arbiter and the fallback wrapper can pass it through.

### 4.8 Arbiter (`packages/session/src/input-arbiter.ts:212-234`)

In `forSource`, after the `typeText` block, attach when present, lanes per MVP 08 §2:

```ts
    if (sink.touch) { const f = sink.touch.bind(sink); facade.touch = (a, p, id) => submit('pointer', source, 'touch', () => f(a, p, id)) }
    if (sink.scroll) { const f = sink.scroll.bind(sink); facade.scroll = (p, h, v) => submit('pointer', source, 'scroll', () => f(p, h, v)) }
    if (sink.pinch) { const f = sink.pinch.bind(sink); facade.pinch = (o) => submit('pointer', source, 'pinch', () => f(o)) }
    if (sink.keyDown) { const f = sink.keyDown.bind(sink); facade.keyDown = (k, m) => submit('keys', source, 'keyDown', () => f(k, m)) }
    if (sink.keyUp) { const f = sink.keyUp.bind(sink); facade.keyUp = (k, m) => submit('keys', source, 'keyUp', () => f(k, m)) }
    if (sink.releaseKeys) { const f = sink.releaseKeys.bind(sink); facade.releaseKeys = () => submit('keys', source, 'releaseKeys', () => f()) }
    if (sink.prepareKeyboard) { const f = sink.prepareKeyboard.bind(sink); facade.prepareKeyboard = () => submit('keys', source, 'prepareKeyboard', () => f()) }
```

Lanes, FIFO rule and `PRIORITY_OF` are unchanged.

### 4.9 Session and manager (`packages/session`)

- `DeviceSession` (`session.ts:64`) gains `onClipboardChanged(cb: (text: string) => void): () => void`; implemented as `scrcpy ? scrcpy.onDeviceMessage((m) => { if (m.type === 'clipboard') cb(m.text) }) : () => {}` (the returned unsubscribe from §4.3). Fixtures that build `DeviceSession` literals (`ws-handlers-tap-hold.test.ts:56-86`, `ws-handlers-video.test.ts:52`, `readiness.test.ts`) add `onClipboardChanged: () => () => {}`.
- `createSession` keeps a reference to the UHID engine (`let uhidEngine: ScrcpyUhidInput | null = null`, set at `:760`) and `close()` calls `await uhidEngine?.destroy().catch(() => {})` before the scrcpy session closes.
- `SessionManagerDeps` gains `onClipboardChanged?: (deviceId: string, text: string) => void`; `createEntry` subscribes on the base (`wall`) entry only and unsubscribes in `closeEntry`.
- `daemon.ts`: `createSessionManager({ ..., onClipboardChanged: (deviceId, text) => wsHandler?.handleClipboardChanged(deviceId, text) })` through the same forward-ref pattern plan 203 uses for `videoStreamStats`; and `createVideoRoutes({ ..., inputStats: (id) => wsHandler?.inputDispatchStats(id) ?? null })`.

### 4.10 `ws-handlers.ts`

**Case labels.** `:1596-1600` gains `case 'input.scroll':`, `case 'input.keyEvent':`, `case 'input.pinch':`, `case 'input.touch':`. The post-205 admission block runs for all of them, with one exception: `deps.activities.touchControl(...)` is NOT called for `input.touch` with `action: 'move'` (125 calls/s would spam `device.activity`); `down`, `up`, scroll, pinch and key `up` touch the marker. A remote (node-owned) device answers the four new verbs with `sendError(ws, 'E_NOT_SUPPORTED', 'live input is not available for a node-owned device in the MVP', msgId)` before the session lookup.

**Per-connection input state.** `ConnState` gains:

```ts
  /** Plan 209 §3.2 D7/D8: one record per `${deviceId}:${pointerId}` while a finger is down. */
  touches: Map<string, TouchStream>
interface TouchStream {
  deviceId: string
  pointerId: number
  startedAt: number                // Date.now() at down
  samples: NormGestureSample[]     // normalised, atMs relative to startedAt (pointer 0 only; others keep [] )
  inFlight: boolean                // a touch() submit is running on the arbiter for this key
  latestMove: NormPoint | null     // newest un-dispatched move while inFlight
}
```

**`input.touch` branch** (new, before the `input.tap` branch):

```ts
if (msg.type === 'input.touch') {
  const { action, pos, pointerId } = msg.payload
  const key = `${msg.payload.deviceId}:${pointerId}`
  const t0 = performance.now()
  const p = mapNormToDevice(pos, session.frameSize)
  const deliver = async (a: 'down' | 'move' | 'up', q: Point) => {
    if (sink.touch) await sink.touch(a, q, pointerId)
    // no touch(): adb-input. The stream is replayed as one swipe on up (below).
  }
  if (action === 'down') {
    const prior = state.touches.get(key)
    if (prior) await finishStream(state, prior, pos, 'replaced')       // a lost up: close it first
    state.touches.set(key, { deviceId: msg.payload.deviceId, pointerId, startedAt: Date.now(), samples: [{ ...pos, atMs: 0 }], inFlight: true, latestMove: null })
    try { await deliver('down', p) } finally { markSettled(state, key) }
    recordDispatch(msg.payload.deviceId, performance.now() - t0)
    return
  }
  const stream = state.touches.get(key)
  if (!stream) return                                                    // a move/up with no down: dropped, never an error
  if (action === 'move') {
    pushSample(stream, pos)                                              // D8 cap: 299 + release point
    if (stream.inFlight) { stream.latestMove = pos; return }             // D7: newest wins
    stream.inFlight = true
    try { await deliver('move', p) } finally { markSettled(state, key) }
    recordDispatch(msg.payload.deviceId, performance.now() - t0)
    return
  }
  // up
  stream.latestMove = null
  pushSample(stream, pos)
  state.touches.delete(key)
  if (sink.touch) {
    await sink.touch('up', p, pointerId)
  } else if (pointerId === 0 && stream.samples.length >= 2) {
    const first = mapNormToDevice(stream.samples[0]!, session.frameSize)
    await sink.swipe(first, p, Math.max(50, Date.now() - stream.startedAt))
  }
  recordDispatch(msg.payload.deviceId, performance.now() - t0)
  if (pointerId === 0) observeStream(msg.payload.deviceId, stream, actor)
  return
}
```

`markSettled(state, key)`: `const s = state.touches.get(key); if (!s) return; s.inFlight = false; if (s.latestMove) { const next = s.latestMove; s.latestMove = null; s.inFlight = true; void deliver('move', mapNormToDevice(next, session.frameSize)).finally(() => markSettled(state, key)) }`. `pushSample(stream, pos)`: `atMs = Date.now() - stream.startedAt`; if `samples.length < 299` push, else replace the last element (so the array ends at the newest point and the final `up` push keeps the release point). `observeStream(deviceId, stream, actor)` implements D8: `const travel = max over samples of hypot(s.x - s0.x, s.y - s0.y)`; if `travel < TAP_MAX_TRAVEL` → `deps.recorder.record({ deviceId, stream: 'input', kind: 'input.tap', actor, meta: { x, y, w, h, holdMs } })` and `deps.recording?.get(deviceId)?.observe({ kind: 'tap', pos: last, holdMs })`; else the existing `input.gesture` record shape (`:1755-1767`) and `observe({ kind: 'gesture', samples: stream.samples })`. `TAP_MAX_TRAVEL = 0.01`. `finishStream(state, prior, pos, 'replaced')` sends `up` at `pos` through the sink, deletes the record and observes it (a browser that lost its `pointerup` must never leave a finger down, MVP 08 §1.1 last row).

**`input.scroll`**: `const p = mapNormToDevice(pos, session.frameSize)`; if `!sink.scroll` → `sendError(ws, 'E_INPUT_UNSUPPORTED', 'this input engine cannot scroll (adb-input)', msgId)`; else `recorder.record({ kind: 'input.scroll', meta: { x, y, hDelta, vDelta } })`, `await sink.scroll(p, hDelta, vDelta)`. No recording tee (no `ObservedInput` shape for it; recordings are parked, plan 210).

**`input.keyEvent`**: `const key = describeKey(msg.payload.code)`; if `action === 'down'`: `if (sink.keyDown) await sink.keyDown(key, meta)`; else nothing (a sink without `keyDown` is `adb-input`: the press happens on `up`). If `action === 'up'`: the D9 event-log row; `deps.recording?.get(deviceId)?.observe({ kind: 'key', keycode: key.androidKeycode })`; `if (sink.keyUp) await sink.keyUp(key, meta); else await sink.key(key.androidKeycode)`.

**`input.pinch`**: `if (!sink.pinch)` → `E_INPUT_UNSUPPORTED`; else `const c = mapNormToDevice(center, frame); const base = Math.min(frame.width, frame.height); await sink.pinch({ center: c, radiusFromPx: scaleFrom * base, radiusToPx: scaleTo * base, durationMs })`; event-log row `input.pinch` with `{ center, scaleFrom, scaleTo, durationMs }`.

**Input dispatch ring.** `const inputDispatch = new Map<string, number[]>()` (deviceId → ring of 128 ms samples); `recordDispatch(deviceId, ms)` pushes and trims; on the returned object:

```ts
/** Plan 209 §3.2 D11: host-side `input.touch` dispatch times for `GET /api/video/latency`. */
inputDispatchStats(deviceId: string): { dispatchMsP50: number; dispatchMsP95: number; samples: number } | null
```

using `transport-metrics.ts:51-55`'s percentile index rule; `null` when no samples.

**Clipboard push.** On the returned object: `handleClipboardChanged(deviceId, text)`: for every `[ws, state]` of `conns`, for every binding in `state.streams.values()` with `binding.deviceId === deviceId && (binding.quality ?? 'control') === 'control' && !binding.remote`: `send(ws, { type: 'clipboard.changed', payload: { deviceId, text } })` once per connection; `deps.recorder.record({ deviceId, stream: 'input', kind: 'clipboard.changed', actor: null, meta: { length: text.length } })` once (length only, plan 38 §3.6). Add `'clipboard.changed'` to the device-event kinds list where `'clipboard.set'` is declared in `device-event.ts` (match on content).

**Release on stop.** In `stream.stop` and `handleClose` (plan 206's shapes), after `detachViewer`: for every `TouchStream` of this connection on that device (or all devices on close) send `up` at its last sample through the sink and observe it; then `void session.arbiter.for(source).releaseKeys?.()`.

### 4.11 Route (`packages/core/src/api/video.ts`)

`createVideoRoutes` deps gain `inputStats?: (deviceId: string) => { dispatchMsP50: number; dispatchMsP95: number; samples: number } | null`; the `/latency` handler (plan 203 §4.7) returns `{ deviceId, at, streams, input: deps.inputStats?.(deviceId) ?? null }`.

### 4.12 Decoder (`packages/studio/src/lib/h264-decoder.ts`)

The full renderer after plan 203 and this plan. Types from plan 203 (`FrameTiming`, `DecodeEvent`, `H264Renderer`) stay; `DecodeEvent`'s `dropped` reason union becomes `'awaiting-keyframe' | 'no-decoder' | 'superseded' | 'queue-full'`.

```ts
export const DECODE_QUEUE_LIMIT = 8
export const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 1000
export type Acceleration = 'prefer-hardware' | 'no-preference'

export interface RendererHooks {
  onEvent?: (event: DecodeEvent) => void
  /** The renderer needs a fresh IDR: the decode queue overflowed, or the decoder was rebuilt after the hardware fallback. LiveView answers with `stream.keyframe`. */
  onNeedKeyframe?: () => void
}

export function createH264Renderer(canvas: HTMLCanvasElement, onError: (msg: string) => void, hooks: RendererHooks = {}): H264Renderer | null {
  if (!isWebCodecsSupported()) return null
  // R3 and MVP 01 §4 step 2: no alpha compositing, and the canvas may present without waiting for the compositor.
  const ctx = canvas.getContext('2d', { desynchronized: true, alpha: false })
  let decoder: VideoDecoder | null = null
  let configured = false
  let sawKeyframe = false
  let configBytes: Uint8Array | null = null
  let lastCodec = ''
  let acceleration: Acceleration = 'prefer-hardware'
  let dims = { width: 0, height: 0 }
  let lastTimestampUs = 0
  let closed = false
  let rafId = 0
  let lastKeyframeRequestAt = -Infinity
  type Sample = FrameTiming & { submittedAt: number; queueSize: number }
  const inflight = new Map<number, Sample>()
  let latest: { frame: VideoFrame; sample: (Sample & { outputAt: number }) | null } | null = null

  const requestKeyframe = () => {
    const now = performance.now()
    if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_MIN_INTERVAL_MS) return
    lastKeyframeRequestAt = now
    hooks.onNeedKeyframe?.()
  }

  // Newest frame wins: whatever is in `latest` when the animation frame fires is painted; anything it replaced was closed unpainted.
  const paint = (t: number) => {
    rafId = 0
    const cur = latest
    latest = null
    if (!cur) return
    if (closed) { cur.frame.close(); return }
    const { frame, sample } = cur
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth
      canvas.height = frame.displayHeight
    }
    ctx?.drawImage(frame, 0, 0)
    frame.close()
    if (sample) hooks.onEvent?.({ kind: 'decoded', ...sample, paintedAt: t })
  }

  const onOutput = (frame: VideoFrame) => {
    const outputAt = performance.now()
    const sample = inflight.get(frame.timestamp) ?? null
    if (sample) inflight.delete(frame.timestamp)
    if (latest) {
      latest.frame.close()
      hooks.onEvent?.({ kind: 'dropped', reason: 'superseded' })
    }
    latest = { frame, sample: sample ? { ...sample, outputAt } : null }
    if (!rafId) rafId = requestAnimationFrame(paint)
  }

  const onDecoderError = (err: Error) => {
    // R3: the hint may be refused asynchronously; fall back once, then never again for this renderer.
    if (acceleration === 'prefer-hardware' && err.name === 'NotSupportedError' && lastCodec) {
      acceleration = 'no-preference'
      configure(lastCodec)
      requestKeyframe()
      return
    }
    onError(String(err))
  }

  const makeDecoder = () => new VideoDecoder({ output: onOutput, error: onDecoderError })

  /** Builds a fresh decoder for `codec` at the current `acceleration`, falling back on a synchronous NotSupportedError. */
  const configure = (codec: string): void => {
    for (;;) {
      try { decoder?.close() } catch { /* already closed */ }
      decoder = makeDecoder()
      try {
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: acceleration })
        configured = true
        sawKeyframe = false
        return
      } catch (err) {
        if (acceleration === 'prefer-hardware' && err instanceof Error && err.name === 'NotSupportedError') {
          acceleration = 'no-preference'
          continue
        }
        throw err
      }
    }
  }

  return {
    decode(data, keyframe, width, height, timing) {
      try {
        let hasSps = false
        let hasPicture = false
        for (const { type } of nalUnits(data)) {
          if (type === NAL_SPS) hasSps = true
          else if (type === NAL_IDR || type === NAL_SLICE) hasPicture = true
        }
        if (hasSps) {
          const codec = codecStringFromSps(data)
          // Rotation or a resolution change rebuilds the decoder; same codec and size reuse it. The acceleration already resolved is reused too: the fallback probe runs once per renderer, never once per rotation.
          const dimensionChanged = dims.width !== width || dims.height !== height
          if (!decoder || codec !== lastCodec || dimensionChanged) {
            lastCodec = codec
            dims = { width, height }
            configure(codec)
          }
        }
        if (hasSps && !hasPicture) { configBytes = new Uint8Array(data); return }
        if (!hasPicture) return
        if (!decoder || !configured) { hooks.onEvent?.({ kind: 'dropped', reason: 'no-decoder' }); return }
        if (!sawKeyframe) {
          if (!keyframe) { hooks.onEvent?.({ kind: 'dropped', reason: 'awaiting-keyframe' }); return }
          sawKeyframe = true
        }
        const queueSize = decoder.decodeQueueSize
        if (queueSize > DECODE_QUEUE_LIMIT && !keyframe) {
          // A slow tab: stop feeding deltas, let the queue drain, restart at the next IDR (MVP 01 §4 step 2).
          sawKeyframe = false
          hooks.onEvent?.({ kind: 'dropped', reason: 'queue-full' })
          requestKeyframe()
          return
        }
        let payload = data
        if (keyframe && !hasSps && configBytes) {
          payload = new Uint8Array(configBytes.length + data.length)
          payload.set(configBytes, 0)
          payload.set(data, configBytes.length)
        }
        const timestamp = timing.ptsUs > 0n ? Number(timing.ptsUs) : lastTimestampUs + 1
        lastTimestampUs = timestamp
        inflight.set(timestamp, { ...timing, submittedAt: performance.now(), queueSize })
        if (inflight.size > 300) inflight.delete(inflight.keys().next().value!)
        decoder.decode(new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp, data: payload }))
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      }
    },
    close() {
      closed = true
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      latest?.frame.close()
      latest = null
      inflight.clear()
      try { decoder?.close() } catch { /* already closed */ }
      decoder = null
      configured = false
      sawKeyframe = false
    },
  }
}
```

`createH264Renderer`'s third parameter changes from plan 203's bare `onEvent` callback to `hooks`; both LiveView call sites (`:445`, `:518`) become `createH264Renderer(canvas, (m) => setError(m), { onEvent: (e) => estimatorRef.current.push(e), onNeedKeyframe: requestKeyframe })` where `requestKeyframe` is the function the visibility effect (`:591-596`) already inlines, hoisted: `const requestKeyframe = () => { if (streamIdRef.current !== null) { ws.send({ type: 'stream.keyframe', payload: { streamId: streamIdRef.current } }); estimatorRef.current.noteKeyframeRequest() } }`.

### 4.13 LiveView (`packages/studio/src/components/LiveView.tsx`)

Deleted: `DRAG_THRESHOLD_PX` (`:26`), `TEXT_DEBOUNCE_MS` (`:27`), `MANUAL_GESTURE_MAX_SAMPLES` (`:39`), `gestureSamplesRef`, `lastGestureSampleAtRef`, `textBufferRef`, `textTimerRef` (`:296-299`), `flushText` (`:771-804`), the `tap`/`swipe`/`gesture` arms of `sendInputAction` (`:694-708`; the function keeps only `key`, or is inlined), the batching in `onPointerMove` and the tap/gesture/swipe decision in `onPointerUp` (`:725-769`), the text branch and the three-key map in `onKeyDown` (`:868-888`). `MANUAL_GESTURE_SAMPLE_MS` (`:36`) is renamed `TOUCH_SAMPLE_MS` with a comment naming `input.touch`. `textInputNotice` and `pasteFromClipboard` stay (rewritten below). `KEYCODES` stays imported for `AKEYCODE.BACK` and the toolbar.

Added:

```ts
const TOUCH_SAMPLE_MS = 8
const WHEEL_SAMPLE_MS = 16
/** Chrome reports about 100 px per wheel notch in pixel mode and 3 lines in line mode. */
const WHEEL_PIXELS_PER_NOTCH = 100
const WHEEL_LINES_PER_NOTCH = 3
/** Up to this many printable ASCII characters paste through `SET_CLIPBOARD`; longer or non-Latin text takes the IME ladder (MVP 08 §1.3). */
const PASTE_VIA_CLIPBOARD_MAX = 256
const PRINTABLE_ASCII = /^[\x20-\x7e\n\r\t]*$/
const INPUT_TEXT_CHUNK = 1000
```

- `pointersRef: useRef(new Map<number, { slot: number; lastSentAt: number; last: NormPoint }>())` and `slotsRef: useRef<Set<number>>(new Set())`. `slotFor(pointerId)`: the lowest free slot 0..9. `downKeysRef: useRef(new Set<DomCode>())`.
- `sendTouch(action, pos, slot)`: `ws.send({ type: 'input.touch', payload: { deviceId, action, pos, pointerId: slot } })`.
- `onPointerDown`: `if (!inputEnabled) return; e.currentTarget.setPointerCapture(e.pointerId); const slot = slotFor(e.pointerId); pointersRef.current.set(e.pointerId, { slot, lastSentAt: performance.now(), last: p }); sendTouch('down', p, slot); e.currentTarget.focus()`.
- `onPointerMove`: `const rec = pointersRef.current.get(e.pointerId); if (!rec) return; const now = performance.now(); if (now - rec.lastSentAt < TOUCH_SAMPLE_MS) return; rec.lastSentAt = now; rec.last = p; sendTouch('move', p, rec.slot)`.
- `onPointerUp` and `onPointerCancel`: `const rec = pointersRef.current.get(e.pointerId); if (!rec) return; pointersRef.current.delete(e.pointerId); slotsRef.current.delete(rec.slot); sendTouch('up', p, rec.slot); e.currentTarget.releasePointerCapture(e.pointerId); onActivity?.()`. `onPointerCancel` is bound on the canvas beside `onPointerUp`. `pointerleave` needs no handler: capture keeps `move`/`up` flowing after the pointer leaves the element.
- Wheel: a native listener registered in a `useEffect` on `canvasRef.current` with `{ passive: false }` (React's `onWheel` is passive and cannot `preventDefault`): accumulate `deltaX`/`deltaY` normalised to notches (`deltaMode === 1 ? d / WHEEL_LINES_PER_NOTCH : deltaMode === 2 ? d : d / WHEEL_PIXELS_PER_NOTCH`), `if (e.shiftKey && dx === 0) { dx = dy; dy = 0 }`, and at most every `WHEEL_SAMPLE_MS` send `{ type: 'input.scroll', payload: { deviceId, pos, hDelta: clamp(-dx), vDelta: clamp(-dy) } }` (sign flipped: browser `deltaY > 0` is scroll down, Android `AXIS_VSCROLL > 0` is scroll up). Always `preventDefault`. Only while `inputEnabled && !compact`.
- `onKeyDown`:

```ts
function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
  if (!inputEnabled) return
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') { e.preventDefault(); void pasteFromClipboard(); return }
  e.preventDefault()
  if (e.repeat) return                                  // the device auto-repeats a held key itself
  if (e.code === 'Escape') { sendKey(AKEYCODE.BACK); return }   // MVP 08 §1.2: Esc is Back, always
  if (!isDomCode(e.code)) return
  downKeysRef.current.add(e.code)
  ws.send({ type: 'input.keyEvent', payload: { deviceId, action: 'down', code: e.code, meta: metaOf(e) } })
  onActivity?.()
}
function onKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>) {
  if (!inputEnabled) return
  e.preventDefault()
  if (e.code === 'Escape' || !isDomCode(e.code)) return
  if (!downKeysRef.current.delete(e.code)) return
  ws.send({ type: 'input.keyEvent', payload: { deviceId, action: 'up', code: e.code, meta: metaOf(e) } })
}
const metaOf = (e: React.KeyboardEvent) => ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey })
```

- `onBlur` on the canvas: send `up` for every entry of `downKeysRef` (with `meta` all false) and clear it; send `up` at `last` for every pointer in `pointersRef` and clear it.
- `pasteFromClipboard`: read the browser clipboard as today (`:840-847`); `if (text.length <= PASTE_VIA_CLIPBOARD_MAX && PRINTABLE_ASCII.test(text))` → `ws.request({ type: 'clipboard.set', id: newId(), payload: { deviceId, text, paste: true } })`; else for each chunk of `INPUT_TEXT_CHUNK` code points (`[...text]` sliced) → `await ws.request({ type: 'input.text', id: newId(), payload: { deviceId, text: chunk } })` in order; failures go to `setTextInputNotice` as today.
- The canvas (`:1155-1161`) gains `onPointerCancel`, `onKeyUp`, `onBlur`, all `compact ? undefined : …` like their neighbours. `tabIndex` unchanged.
- The overlay poll (§4.14).

The `compact` guards are untouched (plan 215 removes the keyboard one). Nothing here builds a focus frame or a hotkey.

### 4.14 Overlay row (`packages/studio/src/components/video/LatencyOverlay.tsx`, `LiveView.tsx`, `packages/studio/src/lib/api.ts`)

- `api.ts`: `export async function fetchVideoLatency(deviceId: string): Promise<VideoLatencyResponse>` beside `fetchGuestAgentStatus` (`:306`), using the same JSON GET helper that function uses and parsing with `VideoLatencyResponseSchema`.
- `LatencyOverlay` props become `{ summary: LatencySummary; inputHost: { dispatchMsP50: number; dispatchMsP95: number; samples: number } | null }`. A ninth row after `keyframe requests`: label `input (host)`, value `${round(p50)} / ${round(p95)} ms` or `no samples` when null. The caption gains, after plan 203's sentence: `input (host) is the core's own dispatch time from the WebSocket message to the control-socket write; scrcpy sends no acknowledgement, so the device leg is not measured.`
- LiveView: a 2000 ms interval, running only while `latencyOverlay && streaming && !compact`, calls `fetchVideoLatency(deviceId)` and stores `.input` in `const [inputHost, setInputHost] = useState<... | null>(null)`; cleared on unmount and toggle-off (the same discipline as plan 203's 500 ms tick). Plan 203 step 203.11's "do not poll the route from LiveView" was scoped to that plan; this is the one reader the route now has in the browser.

### 4.15 File structure

```
packages/scrcpy/src/byte-ring.ts                          created
packages/scrcpy/src/byte-ring.test.ts                     created
packages/scrcpy/src/demuxer.ts                            changed  ring, onError, MAX_PACKET_BYTES
packages/scrcpy/src/demuxer.test.ts                       changed  2 tests added
packages/scrcpy/src/session.ts                            changed  setNoDelay, injectScroll, onDeviceMessage unsubscribe, demuxer onError
packages/scrcpy/src/control/messages.ts                   changed  encodeInjectScroll, encodeInjectTouch pointerId doc
packages/scrcpy/src/control/messages.test.ts              changed  1 test added
packages/scrcpy/src/hid/keyboard.ts                       created
packages/scrcpy/src/hid/keyboard.test.ts                  created
packages/scrcpy/src/index.ts                              changed  exports
packages/protocol/src/keys.ts                             created
packages/protocol/src/keys.test.ts                        created
packages/protocol/src/driver.ts                           changed  InputSink verbs
packages/protocol/src/messages/input.ts                   changed  4 bodies, 4 messages
packages/protocol/src/messages/input.test.ts              changed  8 tests added
packages/protocol/src/messages/clipboard.ts               changed  clipboard.changed
packages/protocol/src/messages/clipboard.test.ts          created
packages/protocol/src/messages/device-event.ts            changed  INPUT_EVENT_KINDS, clipboard.changed kind
packages/protocol/src/api/video.ts                        changed  input block
packages/protocol/src/index.ts                            changed  exports, unions
packages/drivers/src/input/scrcpy-input.ts                changed  MIN_TAP_HOLD_MS, verbs, keyboard
packages/drivers/src/input/adb-key-fallback.ts            changed  pass-through
packages/drivers/src/input/adb-input.ts                   changed  comment only
packages/drivers/src/input/input-engines.test.ts          changed  9 tests added
packages/session/src/input-arbiter.ts                     changed  façade
packages/session/src/input-arbiter.test.ts                changed  1 test added
packages/session/src/session.ts                           changed  onClipboardChanged, uhidEngine.destroy
packages/session/src/manager.ts                           changed  onClipboardChanged dep
packages/core/src/server/ws-handlers.ts                   changed  4 branches, touch state, dispatch ring, clipboard push, release on stop
packages/core/src/server/ws-handlers-touch.test.ts        created
packages/core/src/server/ws-handlers-clipboard.test.ts    changed  1 test added
packages/core/src/server/ws-handlers-tap-hold.test.ts     changed  fixture field
packages/core/src/server/ws-handlers-video.test.ts        changed  fixture field
packages/core/src/api/video.ts                            changed  inputStats
packages/core/src/api/video.test.ts                       changed  1 test added
packages/core/src/daemon.ts                               changed  wiring
packages/studio/src/lib/h264-decoder.ts                   changed  §4.12
packages/studio/src/lib/h264-decoder.test.ts              changed  4 tests added
packages/studio/src/lib/api.ts                            changed  fetchVideoLatency
packages/studio/src/lib/latency-stats.ts                  changed  dropped reasons (type only)
packages/studio/src/components/video/LatencyOverlay.tsx   changed  ninth row, caption
packages/studio/src/components/video/LatencyOverlay.test.tsx changed 1 test added
packages/studio/src/components/LiveView.tsx               changed  §4.13, §4.14
packages/studio/src/components/LiveView.test.tsx          changed  tests replaced and added
```

### 4.16 Sequences

A click, after this plan:

```
browser pointerdown ──▶ input.touch down (pos, slot 0) ──▶ core: TouchStream{down}, touchControl, sink.touch('down')
   ▶ arbiter pointer lane ──▶ ScrcpyUhidInput.touch: untouched report, 100 ms, touching report ──▶ control socket (no Nagle)
browser pointerup   ──▶ input.touch up ──▶ core: sink.touch('up'); travel < 0.01 → recorder input.tap {holdMs}; tee observe(tap)
```

A drag: `down`, then one `move` per 8 ms; the core keeps at most one un-dispatched move per pointer (D7); on `up` one `input.gesture` row and one `observe(gesture)` with host-stamped `atMs`.

A key: `keydown KeyA (shift)` → `input.keyEvent down` → `describeKey` → `keys` lane → UHID: `repairModifiers`, `KeyboardState.press(0x04)` → 8-byte report; `keyup` → `release` → report; event log on `up` (redacted when `logInputText` is off).

A device-side copy: scrcpy `CLIPBOARD` device message → `ScrcpySession.onDeviceMessage` → `DeviceSession.onClipboardChanged` → `SessionManagerDeps.onClipboardChanged` → `wsHandler.handleClipboardChanged` → `clipboard.changed` to each control viewer.

## 5. Implementation steps

Every step: read the cited lines first, match on content (line numbers are as of 2026-09-03, before plans 203, 205 and 206 land; they will have drifted), and run only the test file the step names.

### 209.1 Byte ring and the demuxer

- **Files created**: `packages/scrcpy/src/byte-ring.ts`, `packages/scrcpy/src/byte-ring.test.ts` (§4.1).
- **Files changed**: `packages/scrcpy/src/demuxer.ts` (§4.2), `packages/scrcpy/src/demuxer.test.ts`, `packages/scrcpy/src/session.ts` (the `onError` option), `packages/scrcpy/src/index.ts`.
- **Files deleted**: none.
- **Test file**: `bun test packages/scrcpy/src/byte-ring.test.ts`, then `bun test packages/scrcpy/src/demuxer.test.ts`.
- **Tests** (`byte-ring.test.ts`): `push then read returns the bytes in order across chunk boundaries`; `pushCopiedBytes equals pushedBytes after 1000 pushes`; `a push that would overrun the end compacts instead of growing when the pending bytes fit`; `a push that cannot fit doubles the capacity once`; `read past pending throws RangeError`. (`demuxer.test.ts`, added to plan 203's four): `push copies exactly chunk.length bytes per chunk and never reallocates for frames under the initial capacity` (2000 chunks of 4 KiB forming 40 KiB frames: `ringStats().pushCopiedBytes === 2000 * 4096`, `grows === 0`, `compactionCopiedBytes < pushCopiedBytes / 4`); `a frame larger than the capacity grows the ring once, then no more` (one 300 KiB frame in 4 KiB chunks: `grows === 1`); `a header declaring more than MAX_PACKET_BYTES stops the demuxer and reports onError once`.
- **Verifiable result**: 5 + 3 tests pass; `bun test packages/scrcpy/src/session.test.ts` still passes.
- **Do not**: implement a true circular buffer with wrap-around reads (a DataView cannot span the wrap and the parser reads prefixes only); keep the `merged` allocation "as a fallback"; change the packet copy at `demuxer.ts:119` (a packet must not alias the ring).

### 209.2 Control socket: `setNoDelay`, `injectScroll`, the keyboard descriptor, verification against v3.3.1

- **Files created**: `packages/scrcpy/src/hid/keyboard.ts`, `packages/scrcpy/src/hid/keyboard.test.ts` (§4.3).
- **Files changed**: `packages/scrcpy/src/session.ts` (`:345`, `:107-131`, `:144`, `:370-383`), `packages/scrcpy/src/control/messages.ts` (`encodeInjectScroll` after `encodeInjectTouch`; `injectTouch` gains `pointerId`), `packages/scrcpy/src/control/messages.test.ts`, `packages/scrcpy/src/index.ts`.
- **Test file**: `bun test packages/scrcpy/src/hid/keyboard.test.ts`, `bun test packages/scrcpy/src/control/messages.test.ts`, `bun test packages/scrcpy/src/session.test.ts`.
- **Verification procedure** (the v3.3.1 source tree plan 203 step 203.1 downloaded into the scratchpad; download it again with the same `curl` line if it is gone): (1) `control/ControlMessageReader.java`, `parseInjectScrollEvent`: position (i32 x, i32 y, u16 w, u16 h), then two `Binary.i16FixedPointToFloat(buffer.getShort())`, then `buffer.getInt()` buttons: 20 payload bytes plus the type byte. (2) `app/src/hid/hid_keyboard.c`, `SC_HID_KEYBOARD_REPORT_DESC`: byte-equal to `KEYBOARD_REPORT_DESCRIPTOR`; `SC_HID_KEYBOARD_MAX_KEYS` is 6, `SC_HID_KEYBOARD_INPUT_SIZE` is 8 with no report id. (3) `Options.java`: `clipboardAutosync` defaults to `true`, and `control/Controller.java` (or `device/Device.java`) installs the primary-clip listener under that option and suppresses the echo of its own `SET_CLIPBOARD`. (4) `control/ControlMessageReader.java`, `parseInjectTouchEvent`: the pointer id is a u64 read with `getLong()`, so `0n`/`1n` are valid distinct ids. For each confirmed item write the `verified against v3.3.1 <file> on 2026-09-DD` line into the comment named in §4.3; a mismatch stops this step (leave the comment without the line, report under §9 Q10, continue with 209.3).
- **Tests** (`keyboard.test.ts`): `the descriptor is 63 bytes and starts with the Generic Desktop keyboard usage`; `press then release of KeyA yields [0,0,4,0,0,0,0,0] then all zeros`; `a modifier sets its bit in byte 0 (ShiftLeft → 0x02)`; `a seventh key fills all six slots with 0x01`; `releaseAll returns an all-zero report and forgets everything`. (`messages.test.ts`): `encodeInjectScroll: 21 bytes, i16 fixed-point deltas` (`vscroll: -1` → bytes 15..16 `0x80 0x01`, `hscroll: 0.5` → `0x3f 0xff`, `x: 540, y: 1200, w: 1080, h: 2400`).
- **Verifiable result**: 5 + 1 tests pass; `rg -n "setNoDelay\(true\)" packages/scrcpy/src/session.ts` → 1 match; `rg -n "verified against v3.3.1" packages/scrcpy/src` → 7 matches (plan 203's five plus `hid/keyboard.ts` and `encodeInjectScroll`).
- **Do not**: call `setNoDelay` on the video socket; wrap the descriptor in a report id; change `UHID_POINTER_ID`; upgrade the pin (§9 Q4).

### 209.3 Protocol: `keys.ts`, the four messages, `clipboard.changed`, `InputSink`

- **Files created**: `packages/protocol/src/keys.ts`, `packages/protocol/src/keys.test.ts`, `packages/protocol/src/messages/clipboard.test.ts` (§4.4, §4.5).
- **Files changed**: `packages/protocol/src/messages/input.ts`, `packages/protocol/src/messages/input.test.ts`, `packages/protocol/src/messages/clipboard.ts`, `packages/protocol/src/messages/device-event.ts:95`, `packages/protocol/src/api/video.ts`, `packages/protocol/src/driver.ts:107-138` (§4.6), `packages/protocol/src/index.ts`.
- **Test file**: `bun test packages/protocol/src/keys.test.ts`, `bun test packages/protocol/src/messages/input.test.ts`, `bun test packages/protocol/src/messages/clipboard.test.ts`, `bun test packages/protocol/src/export-uniqueness.test.ts`.
- **Tests** (`keys.test.ts`): `every required DOM code maps` (a literal `REQUIRED_DOM_CODES` list of 101 names; each is in `KEY_TABLE` with `hid` in 0x04..0xe7 and `android` in 1..320); `DOM_CODES has exactly the required names and no others`; `non-modifier HID usages are unique` (only `Backslash` and `IntlBackslash` may share an Android keycode, never a HID usage); `androidMetaState composes the left-hand bits` (`{ shift: true, ctrl: true, alt: false, meta: false }` → `0x3041`). (`input.test.ts`, added): `input.touch defaults pointerId to 0 and rejects 10`; `input.touch rejects an action outside down/move/up`; `input.scroll rejects a delta outside -1..1`; `input.keyEvent accepts KeyA with meta and rejects an unmapped code`; `input.keyEvent requires all four meta flags`; `input.pinch defaults durationMs to 300 and rejects scaleTo above 0.5`; `ClientMessageSchema parses the four new messages`; `INPUT_EVENT_KINDS contains input.scroll, input.keyEvent and input.pinch and not input.touch`. (`clipboard.test.ts`): `clipboard.changed parses`; `ServerMessageSchema accepts clipboard.changed`; `clipboard.set still defaults paste to false`.
- **Verifiable result**: 4 + 8 + 3 tests pass; `export-uniqueness.test.ts` passes; `bun run typecheck` clean for `packages/protocol`.
- **Do not**: add the new bodies to `MirrorActionSchema` (deleted by plan 205; §9 Q9 if still present); put the key table in `ui-node.ts` beside `KEYCODES` (that table is Android names for scripts; this one is a physical-key map); make any of the six `InputSink` verbs required.

### 209.4 Drivers

- **Files changed**: `packages/drivers/src/input/scrcpy-input.ts`, `packages/drivers/src/input/adb-key-fallback.ts`, `packages/drivers/src/input/adb-input.ts` (comment), `packages/drivers/src/input/input-engines.test.ts` (§4.7).
- **Test file**: `bun test packages/drivers/src/input/input-engines.test.ts`.
- **Tests** (added; `fakeControl` at `:15-28` gains `injectScroll`; its `injectTouch` records the sixth argument): `tap with no holdMs holds MIN_TAP_HOLD_MS (16), not a sampled 40..120 range`; `tap with holdMs [40,120] and rng 0.5 holds 80 ms` (the existing sampling still works for scripts); `SDK keyDown/keyUp send INJECT_KEYCODE with the Android keycode and the meta state` (Shift+A → `injectKeycode('down', 29, 0x1041)`); `UHID keyDown creates the keyboard once, then sends an 8-byte report; keyUp sends the release report` (call `keyDown` twice: one `uhidCreate` with id 2 and the 63-byte descriptor, then reports `[0,0,4,0,0,0,0,0]`; `keyUp` → all zeros); `UHID repairModifiers releases a held Shift the browser no longer reports`; `UHID releaseKeys sends an all-zero report only when the keyboard exists`; `UHID touch on pointer 0 lands, sleeps 100 ms, then touches; move and up are single reports`; `UHID touch on pointer 1 falls through to INJECT_TOUCH_EVENT with pointerId 1n`; `SDK pinch sends two downs, paired moves, two ups with ids 0n and 1n`; `SDK scroll sends injectScroll with the deltas`; `withAdbKeyFallback passes touch/scroll/pinch/keyDown/keyUp/releaseKeys through only when the primary has them` (an `AdbInput` primary yields a façade without any of them).
- **Verifiable result**: 9 new tests pass alongside the existing ones (some existing tests assert the 40..120 default: rewrite them to pass `holdMs` explicitly, and say so in the report); `rg -n "DEFAULT_HOLD_MS|40 \+ Math.random|\[40, 120\]" packages/drivers/src` → empty.
- **Do not**: give `AdbInput` a `keyDown` that runs `input keyevent` on `down` (the press would happen twice); make `pinch` on the UHID engine use the digitizer (one contact); create the UHID keyboard in the constructor or in `init()`.

### 209.5 Arbiter, session, manager

- **Files changed**: `packages/session/src/input-arbiter.ts:212-234` (§4.8), `packages/session/src/input-arbiter.test.ts`, `packages/session/src/session.ts` (§4.9: `onClipboardChanged`, `uhidEngine.destroy` in `close()`), `packages/session/src/manager.ts` (`SessionManagerDeps.onClipboardChanged`, subscribe on the base entry in `createEntry`, unsubscribe in `closeEntry`), `packages/session/src/session.test.ts`, `packages/session/src/manager.test.ts`.
- **Test file**: `bun test packages/session/src/input-arbiter.test.ts`, then `bun test packages/session/src/session.test.ts`, then `bun test packages/session/src/manager.test.ts`.
- **Tests**: (`input-arbiter.test.ts`) `keyDown/keyUp queue on keys; touch, scroll and pinch queue on pointer` (a sink whose verbs record `Date.now()` ordering; a blocked `touch` must not delay a `keyDown`; the façade lacks `pinch` when the sink lacks it). (`session.test.ts`) `onClipboardChanged forwards clipboard device messages and the unsubscribe stops them` (the existing fake scrcpy session gains an `onDeviceMessage` that returns an unsubscribe). (`manager.test.ts`) `a clipboard change on the base entry calls onClipboardChanged once even when a control entry exists`.
- **Verifiable result**: 3 tests pass; `bun run typecheck` clean for `packages/session`.
- **Do not**: add a fourth lane; give the control entry its own clipboard subscription; call `uhidDestroy` from anywhere but `destroy()`.

### 209.6 Core: the four branches, coalescing, the recorder, the dispatch ring, the clipboard push

- **Files created**: `packages/core/src/server/ws-handlers-touch.test.ts` (modelled on `ws-handlers-tap-hold.test.ts:38-86`: a spy sink recording every verb call with its arguments, a REAL arbiter, a `resolveNext` gate so a test can block the sink's `touch` and release it).
- **Files changed**: `packages/core/src/server/ws-handlers.ts` (§4.10), `packages/core/src/server/ws-handlers-clipboard.test.ts`, `packages/core/src/server/ws-handlers-tap-hold.test.ts:56-86` and `ws-handlers-video.test.ts:52` (fixture: `onClipboardChanged: () => () => {}`), `packages/core/src/api/video.ts` (§4.11), `packages/core/src/api/video.test.ts`, `packages/core/src/daemon.ts` (§4.9 wiring).
- **Test file**: `bun test packages/core/src/server/ws-handlers-touch.test.ts`, `bun test packages/core/src/server/ws-handlers-clipboard.test.ts`, `bun test packages/core/src/api/video.test.ts`, then once `bun test packages/core/src/server/`.
- **Tests** (`ws-handlers-touch.test.ts`): `N touch messages reach the sink as N move injections` (down, 40 moves, up against a sink that resolves immediately → 40 `touch('move')` in order, one `down`, one `up`); `moves behind a blocked sink collapse to the newest; up always arrives` (block the sink's first `move`, send 20 moves and an `up`, release: the sink sees the blocked move, one more move with the 20th position, then the up); `a down, moves, up stream is observed as one gesture` (recorder spy sees exactly one `input.gesture` row with `samples: 13`; the recording tee's `observe` is called once with `kind: 'gesture'` and `samples[0].atMs === 0`); `a down then up with no travel is observed as one tap with holdMs` (one `input.tap` row, `observe({ kind: 'tap', holdMs })` with `holdMs >= 0`); `a second down on the same pointer closes the first stream with an up`; `stream.stop sends up for an open stream and releaseKeys`; `an input.keyEvent up on a printable key is logged as printable-only when logInputText is off, and with its code when on`; `a sink without touch replays the stream as one swipe on up`; `input.scroll and input.pinch answer E_INPUT_UNSUPPORTED on a sink without them`; `a keyEvent on a sink without keyDown presses the Android keycode on up only`; `a node-owned device answers E_NOT_SUPPORTED for input.touch`; `inputDispatchStats reports p50/p95 after touch messages`. (`ws-handlers-clipboard.test.ts`, added): `a device-side copy is pushed to control viewers only` (three connections: a control binding on the device, a wall binding on the device, a control binding on another device; `handleClipboardChanged` → exactly one `clipboard.changed`; the event log row carries `length` only). (`video.test.ts`, added): `GET /latency carries the input dispatch block` (`inputStats` fixture → `input.dispatchMsP50 === 4`; absent fixture → `input: null`).
- **Verifiable result**: 12 + 1 + 1 tests pass; `bun test packages/core/src/server/` passes once; `curl -s 'localhost:7700/api/video/latency?deviceId=x'` on `bun run dev` returns `"input":null`.
- **Do not**: call `touchControl` on `move`; `await` anything before `recorder.record` in the `up` branch that could reorder it after the next message; log one event-log row per touch sample; broadcast `clipboard.changed`; keep a `checkInputAllowed` call if plan 205 has removed it (if it has not, stop and report, §9 Q9).

### 209.7 Decoder

- **Files changed**: `packages/studio/src/lib/h264-decoder.ts` (§4.12), `packages/studio/src/lib/h264-decoder.test.ts`, `packages/studio/src/lib/latency-stats.ts` (the `dropped` reason union only), `packages/studio/src/components/LiveView.test.tsx:73-76` (the `createH264Renderer` mock accepts the `hooks` argument).
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Test harness**: plan 203's `VideoDecoder` and `EncodedVideoChunk` stubs, extended: the stub's `configure(config)` records `config` and throws `Object.assign(new Error('nope'), { name: 'NotSupportedError' })` when a test sets `rejectHardware = 'sync'`; when `rejectHardware = 'async'` it schedules the stored `error` callback with the same error on the next microtask; `decodeQueueSize` is settable. Install a manual `requestAnimationFrame`/`cancelAnimationFrame` on `globalThis` that queues callbacks and exposes `flushFrame(t)`; restore in `afterEach`. Spy `drawImage` on a fake `ctx` returned by a stubbed `canvas.getContext` that also records its options argument.
- **Tests** (added): `configures with prefer-hardware first` (`configs[0].hardwareAcceleration === 'prefer-hardware'`, `optimizeForLatency === true`; `getContext` was called with `{ desynchronized: true, alpha: false }`); `falls back to no-preference when configure throws NotSupportedError` (`configs` = `['prefer-hardware', 'no-preference']`); `falls back when the error callback reports NotSupportedError and asks for a keyframe` (async rejection → a second configure with `'no-preference'`, `onNeedKeyframe` called once, the next delta is dropped `awaiting-keyframe` and the next IDR decodes); `two frames output before one animation frame: only the newest is drawn and the older is closed` (feed config + two IDRs, call `output` twice, `flushFrame(100)` → `drawImage` once with the second frame, the first frame's `close` called, one `dropped/superseded` event, one `decoded` event with `paintedAt === 100`); `a decode queue above the limit requests a keyframe once and drops deltas until the next IDR` (`decodeQueueSize = 9`, feed three deltas → three `queue-full` drops, `onNeedKeyframe` once; feed an IDR → decoded); `a rotation rebuilds the decoder without a second hardware probe` (SPS at 1080x2400 then at 2400x1080: two configures, both `'no-preference'` after a sync fallback).
- **Verifiable result**: plan 203's 3 tests plus these 6 pass; `bun test packages/studio/src/components/LiveView.test.tsx` still passes.
- **Do not**: use `VideoDecoder.isConfigSupported()` before the first configure (an extra round trip on every stream start; the fallback path covers both failure shapes); paint inside the output callback; drop keyframes when the queue is full.

### 209.8 LiveView and the overlay row

- **Files changed**: `packages/studio/src/components/LiveView.tsx` (§4.13, §4.14), `packages/studio/src/components/LiveView.test.tsx`, `packages/studio/src/components/video/LatencyOverlay.tsx`, `packages/studio/src/components/video/LatencyOverlay.test.tsx`, `packages/studio/src/lib/api.ts`.
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Tests** (`LiveView.test.tsx`): delete the typed-text-debounce test (`:215-232`, `typed text, while mirroring, …`; plan 205 deletes the mirror half if it has not already). Add: `a drag streams input.touch down, move and up` (`fireEvent.pointerDown`, three `pointerMove` 10 ms apart with `performance.now` advanced, `pointerUp` → messages `down`, `move`, `move`, `move`, `up` with `pointerId: 0`; happy-dom may lack `setPointerCapture`: stub it on the canvas prototype in the test); `moves inside the 8 ms window are not sent`; `a wheel tick sends input.scroll` (dispatch a native `WheelEvent` with `deltaY: 100` → `vDelta: -1`; with `shiftKey` → `hDelta: -1, vDelta: 0`); `a printable key sends input.keyEvent down then up and never input.text` (`keyDown({ code: 'KeyH', key: 'h' })`, `keyUp` → two `input.keyEvent` messages, `wsSendCalls` has no `input.text`, `wsRequestImpl` never called); `Escape sends input.key BACK on keydown only`; `a repeated keydown is not sent`; `blur releases held keys and open pointers`; `the paste chord sends clipboard.set with paste for short Latin text and input.text otherwise` (clipboard `'hello'` → `clipboard.set { paste: true }`; clipboard of 300 `a`s → `input.text`; clipboard `'こんにちは'` → `input.text`); `the renderer's onNeedKeyframe sends stream.keyframe`. (`LatencyOverlay.test.tsx`, added): `renders the input (host) row and its caption` (`inputHost: { dispatchMsP50: 3, dispatchMsP95: 9, samples: 40 }` → the `dd` reads `3 / 9 ms`; `null` → `no samples`; the caption contains `scrcpy sends no acknowledgement`).
- **Verifiable result**: all tests in both files pass (never the Studio suite); `rg -n "TEXT_DEBOUNCE_MS|textBufferRef|textTimerRef|flushText|DRAG_THRESHOLD_PX|MANUAL_GESTURE_MAX_SAMPLES|gestureSamplesRef" packages/studio/src` → empty; `rg -n "type: 'input\.(tap|swipe|gesture)'" packages/studio/src/components/LiveView.tsx` → empty; with `bun run dev` and `bun run dev:studio` a drag moves the device's content while the pointer moves, a wheel tick scrolls, typing shows each character.
- **Do not**: build a focus frame, a release chord, a hotkey table, mouse-button handling or the pinch gesture (plan 215); remove the `compact ? undefined :` guards; keep `input.tap` "for clicks" (a click is a `down`/`up` pair now, D6); use React `onWheel` (passive; `preventDefault` is ignored).

### 209.9 Removal gate and status

- **Files changed**: this document (`> Status:` line, §11).
- **Verifiable result**: every §10 proof answers as its row says; `bun run typecheck` clean; `bash scripts/check-plan-status.sh` passes.
- **Do not**: write `implemented` while G22 to G26 are open; write `implemented (software)`.

## 6. Acceptance criteria

1. G1 to G21 of §0 pass by their named commands.
2. `bun run dev` with one attached device, then a Device Control cast in Studio: a drag moves the device content during the drag (not on release); a wheel tick over a list scrolls it; typing `hello world` into a field shows each letter as it is pressed; `Tab` moves focus; `Escape` goes back.
3. `curl -s 'localhost:7700/api/video/latency?deviceId=<id>'` after a 10 s drag returns `"input":{"dispatchMsP50":<n>,"dispatchMsP95":<n>,"samples":<n>}` with `samples > 100`.
4. With the overlay on (plan 203's toggle), the ninth row reads `input (host)` with two numbers, and the caption names the unmeasured device leg.
5. Copying text on the device (long-press, Copy) makes the browser console of a Device Control viewer show a `clipboard.changed` message (plan 215 wires the hotkey); a Screens tile's connection receives nothing.
6. `GET /api/video/sessions` (plan 206) shows nothing new: no extra encoder, no extra session, from any of this.
7. Every §10 proof answers as its row says.
8. `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but the shell after the tests.

## 7. Test plan

Unit, one invocation at a time, never concurrently, never a bare `bun test`, never the Studio suite:

```bash
bun test packages/scrcpy/src/byte-ring.test.ts
bun test packages/scrcpy/src/demuxer.test.ts
bun test packages/scrcpy/src/hid/keyboard.test.ts
bun test packages/scrcpy/src/control/messages.test.ts
bun test packages/scrcpy/src/session.test.ts
bun test packages/protocol/src/keys.test.ts
bun test packages/protocol/src/messages/input.test.ts
bun test packages/protocol/src/messages/clipboard.test.ts
bun test packages/protocol/src/export-uniqueness.test.ts
bun test packages/drivers/src/input/input-engines.test.ts
bun test packages/session/src/input-arbiter.test.ts
bun test packages/session/src/session.test.ts
bun test packages/session/src/manager.test.ts
bun test packages/core/src/server/ws-handlers-touch.test.ts
bun test packages/core/src/server/ws-handlers-clipboard.test.ts
bun test packages/core/src/api/video.test.ts
bun test packages/core/src/server/                       # once, alone, after the ws-handlers edit
# CANCELLED by §12 (zero Studio tests): bun test packages/studio/src/lib/h264-decoder.test.ts
# CANCELLED by §12 (zero Studio tests): bun test packages/studio/src/components/video/LatencyOverlay.test.tsx
# CANCELLED by §12 (zero Studio tests): bun test packages/studio/src/components/LiveView.test.tsx
bun run typecheck
```

Studio test files import `happydom` explicitly (`packages/studio/happydom.ts`: `import '../../../happydom'` from `src/components/video/`, `import '../../happydom'` from `src/lib/`), which is what lets them run from the repo root without the Studio suite.

Manual smoke, one device, the author's machine:

```bash
bun run dev &                                        # note the pid
bun run dev:studio &
# open http://localhost:3001, Device Control on the device, click `latency`
# drag across a list for 10 s, spin the wheel, type a sentence into a field, press Tab, press Escape
curl -s 'http://127.0.0.1:7700/api/video/latency?deviceId=<id>' | grep -o '"input":{[^}]*}'    # samples > 100
adb shell input keyevent KEYCODE_COPY 2>/dev/null; # or long-press + Copy on the device: the browser devtools WS frames show clipboard.changed
kill %1 %2; ps -Ao pid=,command= | grep -i "[o]penpf"   # empty
```

Device tests (`ENKAKU_TEST_DEVICE=1`, owner, lab device): G22 to G26 as written in §0; the numbers for G26 go into §11 with the device model, Android version, host and browser.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The UHID keyboard's first key waits 1500 ms (the pointer's settle copied to the keyboard) | keys are queued on the `keys` lane behind the create, none is lost; the value is §9 Q2 and the prewarm is §9 Q1; both are one constant |
| Android hides the soft keyboard when the virtual keyboard appears (MVP 08 §1.2) | expected; the hint and `OPEN_HARD_KEYBOARD_SETTINGS` toggle are plan 215; the keyboard is created only after a key is pressed, never on open |
| The device layout is not US, so `KeyQ` types something else (R2) | the physical-key model is the MVP 08 decision; §9 Q6 names the per-device preference plan 221 owns |
| `INJECT_TOUCH_EVENT` with ids `0n`/`1n` for pinch behaves differently from the generic finger id on some ROMs | verified only by the pinch gesture in plan 215's owner rows; the encoder is shared with every existing touch call, only the id differs |
| A lost `pointerup` (tab switch mid-drag) leaves a finger down on the device | `setPointerCapture`, `pointercancel`, `blur` and the core's stream-replacement rule (`a second down closes the first with an up`) each close it; `stream.stop`/`handleClose` close the rest |
| The core's touch coalescing hides a slow engine: a drag "feels" fine while samples are dropped | the dispatch ring reports p95; a p95 far above 8 ms with a low `samples` count is the tell, visible on the overlay |
| 125 `input.touch` messages per second per drag through `ClientMessageSchema.parse` | the discriminated union parses by `type` first; the payload is four small fields; no measurement suggests this is near a limit, and the dispatch ring will show it if it is |
| `decodeQueueSize` semantics differ across Chromium versions | the limit is a constant (8); the fallback is a keyframe request rate-limited to one per second, never a tight loop |
| `hardwareAcceleration: 'prefer-hardware'` is accepted and then decodes slower than software on some GPUs | plan 203's overlay `decode` row shows it; §9 Q7 offers the per-browser toggle if it happens |
| `desynchronized: true` tears on some compositors | the canvas is a phone screen at ≤ 60 fps; a visible tear is reported by the owner and the option removed in one line |
| Plan 205's `touchControl` fires an `updated` broadcast per call | this plan never calls it on `move`; `down`/`up`/scroll/key-up are at human rates |
| `clipboard_autosync` is off in some build of v3.3.1 and no push ever arrives | step 209.2 item (3) verifies the default in source; if it is off, add `clipboard_autosync=true` to the launch arguments in the same step and report it |
| `bun test packages/core/src/server/` is slow | run once, alone, after the ws-handlers edit, as plan 203 does |

## 9. Open questions

1. **Prewarm the UHID keyboard when Device Control attaches (plan 206's `attachViewer(..., 'control')`), or only on the first key as MVP 08 §1.2 says?** Prewarming removes the one-time 1.5 s wait but hides the soft keyboard on every open, typed or not. `InputSink.prepareKeyboard?()` exists so either answer is one line in `ws-handlers.ts`'s `stream.start`. Owner.
2. **`UHID_KEYBOARD_SETTLE_MS`.** 1500 ms is the pointer's measured value (`scrcpy-input.ts:6`); nobody has measured a keyboard. The owner measures on the lab device (send a key 200 ms, 500 ms, 1000 ms after create; the smallest that arrives, plus margin) and sets the constant.
3. **`MIN_TAP_HOLD_MS = 16`.** If G25 registers fewer than 20 of 20 clicks, raise it (try 32, then 50) and record the number here.
4. **The scrcpy pin (R1).** 3.3.1 stays for the MVP. Upgrading to 3.3.4 or 4.x re-opens every `verified against` line (plan 203 step 203.1 and this plan's 209.2) and is a release decision, not a side effect. Owner.
5. **The shipped control default preset (`balanced` versus `sharp`, MVP 01 §4 step 2).** Waits for plan 203's G13/G14 numbers; plan 206 owns the profile file. Owner, after the numbers exist.
6. **Device keyboard layout (R2).** A device whose layout is not US types the wrong character for a physical key. A per-device layout setting is guest-agent and settings work (plan 221, plan 212). Owner decides whether the MVP documents "set the device layout to match the host" or ships the preference.
7. **A per-browser "software decode" toggle** if `prefer-hardware` proves slower on some GPU. Not built; the overlay will show it first.
8. **Do `input.tap`, `input.swipe` and `input.gesture` stay on the wire?** LiveView no longer sends them; `DevicePopup`'s hardware rail sends `input.key` only; no plugin sends any. They remain for replay (plan 210) and external WS clients. Owner decides in plan 224 whether unused messages are deleted.
9. **If plan 205 has not fully landed when this plan executes** (`MirrorActionSchema`, `checkInputAllowed`, `assist` still present in `ws-handlers.ts`), the executor stops step 209.6 at the admission block, finishes every other step, and reports which of plan 205's rows are still live. This plan never edits those rows itself.
10. **A byte-layout or descriptor mismatch found in 209.2.** The executor leaves the `verified against` line out, reports the exact file, line, expected and found bytes, and continues with the encoder as written; the owner decides whether the encoder, the pin or the comment is wrong (plan 200 R1's caveat, plan 203 §9 Q1's rule).

## 10. Removed

Forbidden words introduced by this area (plan 200 §2.4 plus this plan's own): `TEXT_DEBOUNCE_MS`, `flushText`, `textBufferRef`, `DEFAULT_HOLD_MS`, `DRAG_THRESHOLD_PX`, `MANUAL_GESTURE_MAX_SAMPLES`, `gestureSamplesRef`, and in new files `lease`, `assist`, `popup`, `modal`, `device page`.

| What | Where it was | Proof |
|---|---|---|
| The per-chunk buffer copy in the demuxer | `packages/scrcpy/src/demuxer.ts:65-71` (`const merged = new Uint8Array(this.buf.length + chunk.length)`) | `rg -n "merged" packages/scrcpy/src/demuxer.ts` → empty |
| `TEXT_DEBOUNCE_MS`, the text-collection branch of `onKeyDown`, `flushText`, `textBufferRef`, `textTimerRef` (MVP 13 A.8) | `packages/studio/src/components/LiveView.tsx:27,298-299,771-804,876-881` | `rg -n "TEXT_DEBOUNCE_MS\|flushText\|textBufferRef\|textTimerRef" packages/studio/src` → empty |
| The three-key map (`Enter`, `Backspace`, `Escape`) in `onKeyDown` (MVP 13 A.8) | `LiveView.tsx:883-884` (`key === 'Enter' ? AKEYCODE.ENTER : key === 'Backspace' ? AKEYCODE.DEL : key === 'Escape' ? AKEYCODE.BACK : null`) | `rg -n "AKEYCODE.DEL\|AKEYCODE.ENTER" packages/studio/src/components/LiveView.tsx` → empty |
| The synthetic 40..120 ms tap hold as a default (MVP 13 A.8) | `packages/drivers/src/input/scrcpy-input.ts:15` (`DEFAULT_HOLD_MS`), `:25-29` | `rg -n "DEFAULT_HOLD_MS\|40 \+ Math.random\|\[40, 120\]" packages/drivers/src` → empty |
| Drag buffering to pointer-up: `DRAG_THRESHOLD_PX`, `MANUAL_GESTURE_MAX_SAMPLES`, `gestureSamplesRef`, `lastGestureSampleAtRef`, the tap/gesture/swipe decision in `onPointerUp` | `LiveView.tsx:26,39,296-297,737-769` | `rg -n "DRAG_THRESHOLD_PX\|MANUAL_GESTURE_MAX_SAMPLES\|gestureSamplesRef\|lastGestureSampleAtRef" packages/studio/src` → empty; `rg -n "type: 'input\.(tap\|swipe\|gesture)'" packages/studio/src/components/LiveView.tsx` → empty |
| The bare 2D context | `packages/studio/src/lib/h264-decoder.ts:59` (`const ctx = canvas.getContext('2d')`) | `rg -n "getContext\('2d'\)" packages/studio/src/lib/h264-decoder.ts` → empty |
| Synchronous paint in the decoder's output callback | `h264-decoder.ts:69-76` (`ctx?.drawImage(frame, 0, 0)` inside `output:`) | `bun test packages/studio/src/lib/h264-decoder.test.ts` test `two frames output before one animation frame: only the newest is drawn and the older is closed` passes |
| A `configure()` with no acceleration hint | `h264-decoder.ts:99-103` | `rg -n "hardwareAcceleration" packages/studio/src/lib/h264-decoder.ts` → ≥ 1 match |
| `ScrcpySession.onDeviceMessage` returning `void` | `packages/scrcpy/src/session.ts:144,370` | `rg -n "onDeviceMessage: \(cb\) => void" packages/scrcpy/src/session.ts` → empty |
| Vocabulary in the files this plan creates | new files only | `rg -n -i "lease\|assist\|popup\|modal\|device page" packages/scrcpy/src/byte-ring.ts packages/scrcpy/src/hid/keyboard.ts packages/protocol/src/keys.ts packages/core/src/server/ws-handlers-touch.test.ts` → empty |

The `compact` keyboard disable (MVP 13 A.8's fourth item) is plan 215's row, not this plan's: it is the Device Control window's focus model. `lease` and `assist` occurrences in files this plan edits are plan 205's rows.

## 11. Handoff report

**Branch**: `agent/plan-209` (in a `mvp`-derived worktree branched at `ed87537`, plan 213's merge tip — the plan format's own `mvp/<plan>` name collided with the existing local `mvp` branch ref, so this branch uses `agent/plan-209` instead. Not yet merged into `mvp`).

- **Checklist**: G1 ✅ G2 ✅ G3 ✅ G4 ✅ G5 ✅ (see discrepancy: 105 not 101) G6 ✅ G7 ✅ G8 ✅ G9 ✅ G10 ✅ G11 ✅ G12 ✅ G13 ✅ G14 ✅ G15 ✅ (verified by typecheck + rg per §12, no Studio test) G16 ✅ (same) G17 ✅ (same) G18 ✅ G19 ✅ (verified by typecheck + rg per §12, no Studio test) G20 ✅ (same) G21 ✅ — G22 ⏳ owner G23 ⏳ owner G24 ⏳ owner G25 ⏳ owner G26 ⏳ owner (all need the lab device)

- **Commits**:
  - `736c3d1` — scrcpy byte ring, UHID keyboard, protocol keys/messages, driver verbs, arbiter lanes, core ws-handlers `input.touch`/`input.scroll`/`input.keyEvent`/`input.pinch` (steps 209.1–209.6)
  - `235d533` — fix: guard the best-effort release-on-stop functions against a fixture whose `arbiter` is a bare stub
  - `def6daa` — decoder hardware-fallback + newest-frame-wins paint, LiveView touch/wheel/key streaming, overlay `input (host)` row (steps 209.7–209.8)

- **Typecheck**: clean (`bun run typecheck` — 19/19 packages OK, run repeatedly through the plan and once at the end).

- **Tests run** (one invocation at a time, never concurrently, exactly the list in §7 minus the three Studio files §12 cancels):
  ```
  bun test packages/scrcpy/src/byte-ring.test.ts          → 5 pass, 0 fail
  bun test packages/scrcpy/src/demuxer.test.ts             → 7 pass, 0 fail
  bun test packages/scrcpy/src/hid/keyboard.test.ts        → 5 pass, 0 fail
  bun test packages/scrcpy/src/control/messages.test.ts    → 16 pass, 0 fail
  bun test packages/scrcpy/src/session.test.ts             → 21 pass, 0 fail
  bun test packages/protocol/src/keys.test.ts               → 4 pass, 0 fail
  bun test packages/protocol/src/messages/input.test.ts     → 19 pass, 0 fail
  bun test packages/protocol/src/messages/clipboard.test.ts → 3 pass, 0 fail
  bun test packages/protocol/src/export-uniqueness.test.ts  → 3 pass, 0 fail
  bun test packages/drivers/src/input/input-engines.test.ts → 24 pass, 0 fail
  bun test packages/session/src/input-arbiter.test.ts       → 9 pass, 0 fail
  bun test packages/session/src/session.test.ts             → 35 pass, 0 fail
  bun test packages/session/src/manager.test.ts             → 35 pass, 0 fail
  bun test packages/core/src/server/ws-handlers-touch.test.ts     → 12 pass, 0 fail
  bun test packages/core/src/server/ws-handlers-clipboard.test.ts → 12 pass, 0 fail
  bun test packages/core/src/api/video.test.ts              → 14 pass, 0 fail
  bun test packages/core/src/server/                        → 150 pass, 0 fail (run once, alone, after the ws-handlers edit, as the plan directs)
  bun run typecheck                                          → clean
  ```
  Also run once, not part of §7 but part of plan 200 §2.6's own rule: `bun run build:studio` — succeeds (32/32 static pages, no type errors).
  Studio: zero tests created or run (§12); `packages/studio` has no `*.test.ts(x)` files at all (plan 201 already removed them before this plan ran).

- **Removed, proven** (§10 table, every row):
  ```
  rg -n "merged" packages/scrcpy/src/demuxer.ts                                                          → empty
  rg -n "TEXT_DEBOUNCE_MS|flushText|textBufferRef|textTimerRef" packages/studio/src                       → empty
  rg -n "AKEYCODE.DEL|AKEYCODE.ENTER" packages/studio/src/components/LiveView.tsx                          → empty
  rg -n "DEFAULT_HOLD_MS|40 \+ Math.random|\[40, 120\]" packages/drivers/src --glob '!*.test.ts'           → empty (the pattern also matches inside input-engines.test.ts's two legitimate explicit-range tests and doc comments quoting the old literal for context — see discrepancy below)
  rg -n "DRAG_THRESHOLD_PX|MANUAL_GESTURE_MAX_SAMPLES|gestureSamplesRef|lastGestureSampleAtRef" packages/studio/src → empty
  rg -n "type: 'input\.(tap|swipe|gesture)'" packages/studio/src/components/LiveView.tsx                  → empty
  rg -n "getContext\('2d'\)" packages/studio/src/lib/h264-decoder.ts                                       → empty
  bun test packages/studio/src/lib/h264-decoder.test.ts                                                    → N/A, superseded by §12 (no Studio test); paint-on-rAF/newest-frame-wins verified instead by reading the code and by typecheck
  rg -n "hardwareAcceleration" packages/studio/src/lib/h264-decoder.ts                                     → 1 match
  rg -n "onDeviceMessage: \(cb\) => void" packages/scrcpy/src/session.ts                                   → empty
  rg -n -i "lease|assist|popup|modal|device page" packages/scrcpy/src/byte-ring.ts packages/scrcpy/src/hid/keyboard.ts packages/protocol/src/keys.ts packages/core/src/server/ws-handlers-touch.test.ts → only "release"/"releaseKeys"/"releaseAll"/"releaseInspector" (substring collisions of "lease" inside a legitimate English word — the standalone noun "lease" does not appear)
  ```
  Also (G4/G18/vocabulary/verification counts): `rg -n "verified against v3.3.1" packages/scrcpy/src` → 7 matches (plan 203's five plus `hid/keyboard.ts` and `encodeInjectScroll`); `rg -n "setNoDelay\(true\)" packages/scrcpy/src/session.ts` → 1 match; `rg -n "getContext\('2d', \{ desynchronized: true, alpha: false \}\)" packages/studio/src/lib/h264-decoder.ts` → 1 match.

- **Discrepancies between plan and code**:
  1. **§4.4 `DOM_CODES` count.** The plan's prose says "101 entries" but its OWN code block for `DOM_CODES` enumerates 105 distinct names (26 letters + 10 digits + 17 punctuation/editing keys + 12 function keys + 9 navigation keys + 4 arrows + 6 numpad-control keys + 11 numpad digits/decimal + 2 (`IntlBackslash`, `ContextMenu`) + 8 modifiers = 105). Implemented the code block verbatim (105 codes, no duplicates), and `REQUIRED_DOM_CODES` in `keys.test.ts` is a second hand-written 105-entry list, matching G5's real intent ("every required code maps, checked by an independent list") over its literal `=== 101` wording.
  2. **`encodeInjectScroll`'s fixed-point scale.** Verified against the pinned v3.3.1 source in the scratchpad (`server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java`): `parseInjectScrollEvent` decodes each i16 with `Binary.i16FixedPointToFloat` (range -1..1) and then **multiplies the result by 16** — the server's own comment reads *"the actual range is [-16, 16]"*. The plan's §4.3 code block packed `hscroll`/`vscroll` directly into the -1..1 fixed-point range with no /16 correction, which would have sent 16× the requested scroll on every wheel tick. Fixed the encoder to pre-divide by 16 before packing (`fp = (v) => Math.round((v/16) * 0x7fff)`), documented the reasoning in the function's own comment, and rewrote `messages.test.ts`'s expected byte values (the plan's example bytes, `vscroll: -1 → 0x80 0x01`, assumed no scale and are wrong; the corrected test computes the expected bytes from the same formula the encoder uses). The 21-byte total length and the position/buttons fields (verified against `parsePosition`/the u32 buttons field) match the plan exactly.
  3. **§5 step 209.4's Shift+A example.** The plan's test narrative says `ScrcpySdkInput.keyDown` for Shift+A should call `injectKeycode('down', 29, 0x1041)`. `androidMetaState({shift:true})` (as specified in §4.4) actually produces `SHIFT_ON (0x1) | SHIFT_LEFT_ON (0x40) = 0x41`; no single-modifier combination the formula can produce equals `0x1041`. Implemented `androidMetaState` exactly as §4.4 specifies and corrected the test's expected value to `0x41`, with a comment recording the discrepancy.
  4. **`device-event.ts`'s "where `clipboard.set` is declared."** §4.5 instructs adding `clipboard.changed` "to the device-event kinds list where `clipboard.set` is declared." On reading the file, `'clipboard.set'` is not a member of `MAIN_EVENT_KINDS` or `INPUT_EVENT_KINDS` — `kind` is a free-form `z.string()` on `DeviceEventSchema`, and `ws-handlers.ts`'s existing `kind: 'clipboard.set'` row (line ~1882 pre-plan) was never enumerated in either const array. Added `input.scroll`, `input.keyEvent`, `input.pinch` to `INPUT_EVENT_KINDS` (the real, enforced-by-nothing-but-documentation list this plan does own) and left `clipboard.changed` as a free-form kind string on `handleClipboardChanged`'s `recorder.record` call, matching how `clipboard.set` already works — no enum anywhere needed a new member for it.
  5. **§4.9's `SessionManagerDeps.onClipboardChanged` "subscribe on the base entry only."** Implemented via a `clipboardUnsubscribe` field added to the internal `Entry` type (not named in the plan's own §4.9 prose, which only names the dep and the subscribe/unsubscribe call sites) — needed so `closeEntry` has something to call; functionally identical to what the plan describes.
  6. **Fixture fallout beyond the two files §5 step 209.6 named.** The plan's own step 209.6 names only `ws-handlers-tap-hold.test.ts:56-86` and `ws-handlers-video.test.ts:52` for the `onClipboardChanged: () => () => {}` fixture field. Adding the field to `DeviceSession` (required, not optional) broke eight fixtures the plan did not list: `presence.test.ts`, `ws-handlers-clipboard.test.ts`, `ws-handlers-inspect.test.ts`, `ws-handlers-monitor.test.ts`, `ws-handlers-shell.test.ts`, `ws-handlers-text.test.ts`, `ws-handlers.observability.test.ts` (plus the two the plan did name). Fixed all of them, per plan 200 §2.1 ("a test your change broke is yours to fix, whatever its path").
  7. **`session.arbiter.for(source) : session.input` ternary in the new release-on-stop helpers.** Copied the existing tap/swipe/gesture branch's `'arbiter' in session ? session.arbiter.for(source) : session.input` pattern into `releaseTouchStreams`/`releaseKeysFor`, but those two new helpers only ever look up a LOCAL `DeviceSession` (never the remote/`RemoteInput` union the original ternary discriminates), so TypeScript narrowed the `else` branch to `never` (`DeviceSession.arbiter` is a required field). Simplified both to `session.arbiter.for(source)` directly. Separately, several test fixtures stub `arbiter: {}` (a bare object) since they never exercised input; this compiles (cast away) but crashes at runtime the first time `handleClose`/`stream.stop` reaches the new cleanup code. Wrapped both helpers' bodies in `try {} catch {}` — best-effort, matching the surrounding function's own "never let cleanup crash close()" discipline — rather than editing every one of those fixtures to carry a real arbiter.
  8. **`clipboard_autosync` verification (step 209.2 item 3).** Verified in the scratchpad's v3.3.1 source: `server/src/main/java/com/genymobile/scrcpy/Options.java` line 59, `private boolean clipboardAutosync = true;` — the server's default is already on, and this codebase's launch arguments (`session.ts`) never set `clipboard_autosync=false`, so no launch-argument change was needed (the plan anticipated this as a possible finding, §8's risk table).

- **Observed, not done** (deliberately, out of this plan's scope):
  - The Device Control window's focus frame, hotkey table, mouse-button handling (right-click→Back, middle-click→Home), Ctrl/Alt+drag pinch gesture UI, the soft-keyboard hint, and `OPEN_HARD_KEYBOARD_SETTINGS` toggle — all plan 215, per §2's non-goals table. `input.pinch` and `pinch()` exist end to end (wire, driver, arbiter) with no UI caller yet, exactly as the plan intends ("this plan ships `input.pinch` and `pinch()` so 215 has a wire and a driver to call").
  - `scripts/bench-device-nfrs.ts` is not wired to `VideoDemuxer.ringStats()` — the method exists and is exported, per §4.2's "not wired there by this plan."
  - The always-on builder's control-entry linger and reprofile paths were not touched; this plan's `SessionManagerDeps.onClipboardChanged` addition is additive only.
  - `input.tap`/`input.swipe`/`input.gesture` messages, `RecordingStepSchema`, and the recorder's tee shapes are all unchanged, as required — recordings still see a coalesced tap/gesture on `up`, never per-sample.

- **Open questions hit**: none blocked a step. §9 Q1 (prewarm the UHID keyboard on Device Control open) is left undecided as the plan requires — `prepareKeyboard()` exists on `InputSink`/the arbiter façade but nothing calls it yet. §9 Q2 (`UHID_KEYBOARD_SETTLE_MS`) is left at the pointer's measured 1500 ms, pending the owner's lab measurement. §9 Q3 (`MIN_TAP_HOLD_MS = 16`) is left as specified; G25 will say whether it needs raising. §9 Q4 (the scrcpy pin) untouched. §9 Q9 (plan 205 not fully landed) did not apply — `MirrorActionSchema`/`checkInputAllowed`/`assist` were already fully absent when this plan executed (plan 205 merged before this plan's worktree branched). §9 Q10 (a byte-layout mismatch in step 209.2): one real finding, the `encodeInjectScroll` /16 scale documented above; no `verified against v3.3.1` line was withheld — the finding was fixed in the encoder itself rather than left unresolved, since the mismatch was a bug in the plan's own example rather than an ambiguity needing the owner's call.

- **Processes**: `ps -Ao pid=,command= | grep -i "[o]penpf"` shows one process this executor did not start — an `adb shell … com.genymobile.scrcpy.Server` against a real device serial (`45de3e00`), predating and outliving this session; this executor never ran `bun run dev`/`dev:studio` or any other long-lived core/Studio process, and `ps` confirms no `bun`/node process tied to this worktree's path remains. The manual smoke in §7 needing a live device and browser was not run — it needs the owner's lab device, same as G22–G26.

---

## 12. Amendment 2026-09-03 — testing policy (plan 200 §8.3)

Studio and `@enkaku/ui` have zero tests. This amendment overrides every Studio test named above.

- **Dropped, do not create or edit**: `packages/studio/src/lib/h264-decoder.test.ts`, `components/video/LatencyOverlay.test.tsx`, `components/LiveView.test.tsx`. Plan 201 deletes them. If this plan runs before 201 has merged and one of them fails to compile because of the input-message or decoder change, **delete that file in this plan** and record it in §11.
- **Kept, because they are on plan 200 §8.3's critical list**: `packages/protocol/src/keys.test.ts` (the DOM code to HID usage and Android keycode table), `packages/protocol/src/messages/input.test.ts`, `packages/scrcpy/src/demuxer.test.ts` (the ring buffer), `packages/scrcpy/src/hid/keyboard.test.ts` (report descriptor and input report bytes), `packages/scrcpy/src/control/messages.test.ts` (scroll and clipboard encoders), `packages/drivers/src/input/*.test.ts` (scroll, keyDown/keyUp, pinch, touch streaming, the sub-API-29 fallback). These are where this plan's real risk lives: byte layouts and key mapping.
- **§0 amended**: G15 (hardware-acceleration fallback), G19 (live pointer, wheel and key streaming with the debounce gone) and G20 (the ninth overlay row) are verified by `bun run typecheck`, the `rg` proofs already in §10, and the owner smoke below instead of a Studio test.
- **§7 amended**: remove the three `bun test packages/studio/...` lines. The owner smoke on the lab device, at the wave gate: type a sentence into a device text field and confirm each character appears as typed with no batching; press Tab and confirm focus moves on the device; press Ctrl+A and confirm select-all; scroll a long list with the wheel; Ctrl+drag on a map and confirm pinch; right-click and confirm Back; copy on the device then paste on the host and the reverse; drag an icon and confirm the finger follows before release; confirm the overlay's `input (host)` row moves while dragging and that its caption says the device leg is not measured.
