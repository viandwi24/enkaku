# Plan 600 — Live picture : a tile that recovers, and words that are true

> Status: implemented (software) — G1-G9 done and verified by their own commands 2026-09-06. G10 (how it reads on a real farm) stays open: it is an owner row, and nothing in this repo can render a browser or unplug a phone.
> Ships: `packages/studio/src/components/device-control/cast-status.ts`
> Depends on: plan 206 (always-on sessions, the base/control encoder split and the rebuild ladder); plan 214 (the Screens grid and its tile budget); plan 215 (`useCast`, the one cast implementation); plan 85 (the discovery reconciler)
> Spec references: §5 (drivers), §13 (Studio)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A cast re-subscribes by itself after `stream.ended`, without a remount | 5-rung ladder, 1 s → 15 s, then 15 s forever | `rg -n "scheduleRestart" packages/studio/src/components/device-control/use-cast.ts` → the `stream.ended` branch plus its definition | [x] |
| G2 | Two timers can never put two `stream.start`s on the wire | 1 pending timer, 1 in-flight start | `rg -n "retryTimer\|starting = " packages/studio/src/components/device-control/use-cast.ts` → one timer variable, one guard | [x] |
| G3 | A frozen-but-live stream asks for a keyframe before anything more drastic | nudge at 6 s, repeat every 10 s | `rg -n "STALE_KEYFRAME" packages/studio/src/components/device-control/use-cast.ts` → 2 constants, both used in the watchdog | [x] |
| G4 | Exactly one function in Studio turns cast state into words | 1 file, 3 callers | `rg -ln "castStatusOf" packages/studio/src` → `cast-status.ts`, `LiveView.tsx`, `Cast.tsx` | [x] |
| G5 | "Disconnected" survives only where the device really is offline | 4 rendered occurrences, each gated on an offline fact | `rg -n "'Disconnected'\|>Disconnected<" packages/studio/src` → `cast-status.ts` (`noticeKind === 'offline'`), `DeviceScreenCard.tsx` (`status === 'offline'`), `DeviceLog.tsx` (`device.offline`), `DevicesToolbar.tsx` (the offline filter row) | [x] |
| G6 | The Screens card shows "Reconnecting · N" over a LIVE tile too | 1 overlay, owned by the card, suppressed in `LiveView` | `rg -n "overlay=" packages/studio/src/components/devices/DeviceScreenCard.tsx` → 1 match | [x] |
| G7 | A close the farm asked for is never reported as a session death | 1 guard | `rg -n "created !== null && current !== created" packages/session/src/manager.ts` → 1 match | [x] |
| G8 | An unplugged device's viewers are told exactly once | 1 call, only when something was open | `rg -n "onSessionEnded\?\.\(deviceId, 'device_gone'\)" packages/session/src/manager.ts` → 1 match, guarded by `keys.length > 0` | [x] |
| G9 | The reconciler repairs a row stuck `offline` while adb reports the device | 1 set, quarantine excluded | `rg -n "staleOfflineSerials" packages/core/src` → the interface, the implementation, the adopt condition | [x] |
| G10 | On a real farm, a phone whose session dies gets its picture back with no interaction, and no tile lies about a phone that is fine | owner judgement | owner smoke §7.4 | owner |

## 1. Goals

The owner's report, 2026-09-06:

> "terkadang di device list cards atau table itu dia disconnected, tapi pas di klik masuk device control popup dia tiba tiba connected lagi"

A screenshot came with it: a tile showing a perfectly readable home screen, frozen, with the word **Disconnected** across the middle. The phone was fine. Opening Device Control on the same device streamed immediately.

Both halves of that sentence were true, and both were defects:

1. **The tile never came back.** A cast subscribed once and, when the server said the picture was over, stopped — for good. The only thing that could ever make it ask again was a WebSocket reconnect or a React remount. Neither happens when a *session* dies, which is the case the always-on builder exists to recover from.
2. **The word was wrong.** Four different states — a session being built, a session being rebuilt, a stream stalled behind a congested socket, and a device that is genuinely gone — rendered as the same word, and that word names the only one of them that is about the phone.

The second is what turned a self-healing farm into a support question. `DeviceScreenCard`'s own `idleLabelOf` had already fixed exactly this misreading two days earlier for the tile-budget case; `LiveView`, three files away, had never heard about it.

## 2. Non-goals

- No new server message for "the session was rebuilt". The client asking again is enough, it is one small message, and it also covers the case where a browser missed the `stream.ended` entirely.
- No change to the encoder split, the tile budget, the ramp, or the video presets.
- No Studio tests (plan 200 §8.3). The logic that deserved one — `castStatusOf` — is a pure function, and the decision to keep Studio test-free stands; what it maps is verified by the greps in §0 and by the owner smoke.

## 3. Decisions

### 3.1 A viewer that is told the picture ended asks for it back (D1)

`use-cast.ts` gains `RESTART_BACKOFF_MS = [1, 2, 4, 8, 15]` seconds. `stream.ended` schedules the next rung; a successful `stream.start` resets the ladder to zero; the last rung repeats forever rather than giving up, because there is no state in which a viewer of a device that still exists should stop asking.

The alternative — re-attaching the old frame subscribers to the rebuilt entry, server-side — was rejected: it would have to survive a rebuild that changes the session object, the codec and the frame size, and it would still leave a browser that missed the message dark. The client is the party that knows whether it still wants a picture.

### 3.2 A stalled stream is nudged, not restarted (D2)

`ws-handlers.ts` stops forwarding H.264 deltas the moment the socket congests and resumes only at the next IDR, so a picture can freeze with the subscription perfectly healthy. Tearing that down and re-attaching would be the wrong reflex. After `STALE_KEYFRAME_AFTER_SEC` (6 s) with no frame the cast asks for a keyframe, and repeats every `STALE_KEYFRAME_EVERY_SEC` (10 s) while the silence lasts. scrcpy repeats the previous frame about ten times a second even on a static screen, so a healthy stream never reaches this at all.

### 3.3 One vocabulary, in one file (D3)

`components/device-control/cast-status.ts` is the only place in Studio that turns `CastStats` into words:

| Kind | Label | When |
|---|---|---|
| `live` | Streaming | streaming, last frame < 5 s ago |
| `stalled` | No frames · Ns | streaming, nothing arriving |
| `reconnecting` | Reconnecting | `stream.ended` seen, the ladder is climbing |
| `preparing` | Preparing | `E_SESSION_PREPARING` — the farm is building the session |
| `offline` | **Disconnected** | the server answered `device_offline` |
| `connecting` | Connecting | first attach, nothing back yet |
| `unauthorized` | Unauthorized | the USB debugging prompt is unanswered |
| `error` | Video error | anything else |

To make the `offline` row possible without matching on server prose, `CastStats` gains `noticeKind: 'preparing' | 'offline' | null`, set from the error code the retry path already switches on.

`busy` (preparing, reconnecting, connecting) renders a spinner in the accent colour; the rest render as text. That is the whole difference between "the farm is working on it" and "this is where it stopped".

### 3.4 The card owns the device's word; the cast owns the picture's (D4)

A device the always-on builder is rebuilding is a fact about the device, and it outranks anything the cast knows about its own subscription. So `DeviceScreenCard` renders "Reconnecting · N" (from the `prep` activity that was already on the wire) over a **live** tile as well as a dead one, and passes `overlay="none"` to `LiveView` while it does, because two labels stacked on one 9:19.5 tile is not a design.

### 3.5 The reconciler repairs a stuck status, not just an unknown serial (D5)

`knownSerials()` deliberately unions adb's live view with every serial in the `devices` table, so the reconciler's adopt path skipped any device it had a row for — including one whose row said `offline` while `host:devices-l` said `device`. The only way back was another tracker event, which is the very signal plan 85 built this reconciler because it may never come.

`DeviceRegistry` gains `staleOfflineSerials()` — serials whose stored status is `offline`, quarantined rows excluded (a quarantine is sticky in the state machine, so re-probing one every tick buys nothing and costs a shell round-trip per device per scan). The adopt condition becomes "unknown **or** stale-offline". `onOnline` is already idempotent and already short-circuits for blocked and unadmitted devices, so nothing else was needed.

### 3.6 A close we asked for is not a death (D6)

Closing a scrcpy session ends its video socket, and the socket's close event runs the same `onClose` chain a crash does. The guard in `manager.ts`'s `onDisplayError` let that through whenever the entry was already gone from the map — which is exactly the state `closeEntry` and `restartAt` are in when they call `close()`, since both delete the key first. Consequences, all invisible until now:

- applying video settings (`restartAt`) emitted `stream.ended` to every viewer and made the always-on builder schedule a rebuild of a session that had just been rebuilt on purpose;
- an unplugged device reported its end through the crash path, so the honest announcement could not be added without duplicating it.

The guard now ignores a display error unless the entry still holds *this* session, with one exception: `created === null`, the session that died during its own build, which no deliberate close can imitate. `closeDevice` then makes the announcement itself, once, and only when something was actually open.

## 4. Changes

| File | Change |
|---|---|
| `packages/studio/src/components/device-control/use-cast.ts` | the restart ladder (D1), the single retry timer and in-flight guard, the keyframe nudge (D2), `noticeKind` (D3) |
| `packages/studio/src/components/device-control/cast-status.ts` | **new** — `castStatusOf`, `isCastLive`, `LIVE_STALE_SEC` (D3) |
| `packages/studio/src/components/LiveView.tsx` | renders `castStatusOf` with a spinner for the busy states; new `overlay` prop (D4) |
| `packages/studio/src/components/device-control/Cast.tsx` | the status strip and the window overlay both read `castStatusOf` (D3) |
| `packages/studio/src/components/devices/DeviceScreenCard.tsx` | the reconnect overlay covers a live tile too, and suppresses `LiveView`'s own (D4) |
| `packages/session/src/manager.ts` | the deliberate-close guard, and `closeDevice`'s single announcement (D6) |
| `packages/core/src/registry/device-registry.ts` | `staleOfflineSerials()` on the interface and the implementation (D5) |
| `packages/core/src/registry/reconcile.ts` | the adopt condition and the dep it reads (D5) |
| `packages/session/src/manager.test.ts` | one test: `closeDevice` announces once, and says nothing when nothing was open |
| `packages/core/src/registry/reconcile.test.ts` | one test: a stuck-offline known serial is re-adopted, exactly once |

## 7. Verification

### 7.1 Typecheck and build

```
bun run typecheck      # all 20 packages OK
bun run build:studio   # exit 0, static export written
```

### 7.2 Scoped tests (CLAUDE.md: only what was touched, one invocation at a time)

```
bun test packages/session/src/manager.test.ts      # 39 pass, 0 fail
bun test packages/session/src/always-on.test.ts    # 21 pass, 0 fail
bun test packages/core/src/registry/               # 168 pass, 0 fail (9 files)
```

### 7.3 Greps

Every row of §0 carries its own command; all nine software rows were run and matched.

### 7.4 Owner smoke (G10 — needs a phone)

1. With the Screens grid open and a tile streaming, kill the encoder on that device: `adb shell pkill -f scrcpy`. Expect: "Reconnecting · 1" with a spinner over the frozen frame, then the picture back within a few seconds, with **no** click, no scroll and no reload.
2. Repeat with the Device Control window open on the same device. Same result; the strip's left chip narrates it.
3. Unplug the phone. Expect the tile to read "Disconnected" (it now is), and the window's overlay likewise. Plug it back in: the tile recovers on its own.
4. Change a video preset in Settings while tiles are streaming. Expect no "Reconnecting" flash on any tile and no rebuild in the log — only the encoder restart the change asked for.
5. Watch a wall of tiles for a few minutes on a busy farm. Expect "No frames · Ns" to appear and clear on its own during congestion, and never the word "Disconnected" for a phone that is plugged in.

## 10. Removed

| Removed | Where it was | Why |
|---|---|---|
| the bare `Disconnected` overlay in `LiveView` | `LiveView.tsx:24` | it named the device for a fact about the stream (D3) |
| the inline `stats.streaming && stats.staleSec < 5` in `LiveView` and `Cast` | both files | one `isCastLive` / `LIVE_STALE_SEC`, not two copies of a literal |
| the `No frames for Ns` / `Not streaming` ternary in the Cast strip | `Cast.tsx:38` | replaced by `castStatusOf(stats).label` |
| the `current !== undefined` half of the display-error guard | `manager.ts` | it is precisely the deliberate-close case (D6) |

Forbidden after this plan, in non-archived code: a second place that maps cast state to words; the word "Disconnected" on any surface not gated on a device being offline; a `stream.ended` handler that leaves the viewer with no way back.

## 11. Handoff

- **Observed, not done.** `state.nextStreamId++ & 0xff` in `ws-handlers.ts` wraps after 256 streams on one WebSocket connection. A long-lived tab that scrolls a large wall for hours will eventually reuse an id that another live binding still holds, and the client filters frames by that id alone. It has never been reported; the restart ladder makes stream churn slightly more common, not less, so this is now worth a look. Not touched here: it belongs to the protocol, not to this plan.
- **Observed, not done.** `attachViewer` never checks the device row's status — a base entry that exists is enough. That is what lets Device Control stream a device the list has marked offline. It is arguably correct (the picture is real), but it means two surfaces can honestly disagree; the answer is probably to make the registry status right (D5 is one step of that), not to refuse the picture.
- The `restartAt` path (video settings) was emitting a spurious `stream.ended` and a spurious always-on rebuild before D6. Nobody had reported it; it would have shown up as tiles flashing "Reconnecting" whenever anyone touched the capture settings. Worth remembering that it was found while fixing something else.
