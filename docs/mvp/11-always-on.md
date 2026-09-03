# MVP 11 — Always on: a session lives as long as the device is online

> Status: decided in direction (CEO, 2026-09-03); model proposed here.
> As stated by the CEO: every device is awake by default, in the background, all of them, 100 if there are 100. The web UI only displays. Opening the web must never show "waking up the device"; the only acceptable loading is for a device that was just added. Learned from Panda, where this is our visible shortfall.
> Related: MVP 01 (video pipeline), MVP 02 (inspector prewarm), MVP 04 (activities), MVP 09 §2 and §7 (lifecycle targets, scale number), `packages/session/src/manager.ts`, `packages/session/src/wake.ts`, `packages/core/src/device/readiness.ts`, `packages/protocol/src/settings.ts` (sessions block).

---

## 0. Why the web shows "Waking"

A device session is created **when a browser sends `stream.start`**, not when the device connects (`packages/session/src/manager.ts:86`, `acquire`). Creating it means: push the scrcpy jar, forward a port, open the video socket (up to 40 attempts, about 22 s worst case, MVP 01 §1.1), open the control socket, run the wake sequence (`screen_off_timeout`, `svc power stayon` measured at 1 422 ms, `KEYCODE_WAKEUP`, the keyguard nudge, `wake.ts:70-84`), then wait for the first frame. Studio renders those phases as the "Waking" panel (`LiveView.tsx:132-154`).

The session is then **closed again** after `idleTtlSec` (default 300) with at most `maxIdleSessions` (default 8) held open farm-wide and `maxConcurrentBuilds` (default 2) starting at once (`settings.ts` sessions block). On a 100-device farm this means a session is almost always cold when a browser asks for it, and the farm builds them two at a time.

Readiness has the same shape: `desiredReadiness` defaulted to `asleep` until the 2026-08-28 migration (`0064_awake_on_connect.sql`) flipped new devices to awake; the wake is still executed lazily at session build.

The lazy design had a measured reason (MVP 02 §2.1: starting the inspector up front delayed the first frame by 50 s on one device). The fix chosen then was "start late"; the fix chosen now is "start at connect, staggered, and never stop".

## 1. The model

### 1.1 Session lifetime equals device lifetime

- When a device becomes online, the core builds its session in the background: forward, scrcpy server, control socket, wake, inspector prewarm (MVP 02 phase 1), guest agent hello. The device's activity list (MVP 04) shows `prep` while this runs, so the wall tile says "Preparing" only for a device that just arrived.
- The session stays up until the device goes offline or is forgotten. There is no idle TTL, no idle cap, and no per-view build. `idleTtlSec`, `maxIdleSessions`, and `maxConcurrentBuilds` are deleted; the only remaining knob is the connect-time stagger (§1.4).
- Readiness desired is `awake` by default and applied at connect. A device an operator explicitly puts to sleep stays asleep with its session up; its tile shows a dark screen, not a loading panel.

### 1.2 Video: one encoder always on, the second only when it is looked at

scrcpy encodes only when the display changes, so an idle phone with an encoder attached costs close to nothing on the phone and nothing on the host beyond an open socket.

- The **wall encoder** (the `wall` profile, 480 px, 18 fps, about 1.1 Mbit at most) runs for the whole session. The wall attaches to it instantly; there is nothing to build.
- The **control encoder** (the `control` profile) starts when a Device Control opens. Until its first keyframe arrives, Device Control **shows the wall stream upscaled**, then switches. The operator sees a picture within one frame and a sharp picture within a second or two; there is no panel in between. The control encoder stops when the last Device Control on that device closes, with a short linger so reopening is free.
- Both encoders are phone-side; the host still transcodes nothing (MVP 01 §5).

### 1.3 The browser is a viewer

- `stream.start` attaches to a running session and primes with the cached config and keyframe (MVP 01 §1.3); it never builds. If a device has no session, the answer is the device's activity (`prep` or `offline`), not a build.
- The "Waking" phase list in LiveView is deleted. What remains is one state for a tile with no frames yet: the activity sentence ("Preparing, step 3 of 5" for a new device; "Offline"; "Asleep").
- Opening the wall with 100 devices decodes only the visible tiles (the existing live-set gating stays); the other 90 sessions keep running on the phones unobserved.

### 1.4 Connect-time stagger

Building 100 sessions at once on plug-in or after a core restart would saturate USB (MVP 02 §2.7 H5). The core builds sessions with a concurrency per USB root (default 4) and a farm-wide ceiling (default 16), ordered by device number. A device waiting its turn shows "Preparing, queued" in its activity. On a 100-device farm at 5–8 s per build this is under two minutes to fully warm after a cold start, once, and never again per view.

### 1.5 Failure and recovery

- A session whose scrcpy process dies is rebuilt automatically with backoff; the tile shows "Recovering" from the activity list. No operator action, no browser involvement.
- USB unplug and replug: the device goes offline then online and the session is rebuilt; target under 5 s from replug to first frame (MVP 09 §2).
- A core restart rebuilds every session under §1.4. The web reconnects and attaches; nothing about it depends on the browser being open.

## 2. Cost on the host, to be measured

Per always-on device: one adb forward, two sockets, one demuxer, no decode. Memory is dominated by the demuxer buffer and the cached keyframe per device, on the order of a few hundred kilobytes each. CPU is the byte copy in the demuxer (MVP 01 §1.2, to be replaced by a ring buffer). 100 devices at 1.1 Mbit peak is 110 Mbit inbound over USB, well under one USB 3 host controller; the real limit is USB hub topology and adb's single server process, which is why §1.4 is per USB root. The measured number goes into MVP 09 §7.

## 3. Removed

Settings `idleTtlSec`, `maxIdleSessions`, `maxConcurrentBuilds` and their Studio rows; the lazy `acquire`-builds-a-session path in `SessionManager`; the screencap fallback as a first-frame substitute during a build (it stays as the fallback engine when scrcpy is unavailable); the "Waking" phase panel and `WAKE_OFFER_AFTER_SEC` in LiveView; the readiness `asleep` default.

## 4. Acceptance

- Open the wall on a warm 100-device farm: every visible tile paints within one keyframe interval, no tile shows a build phase.
- Open Device Control on any warm device: a picture within 100 ms (the wall stream), the sharp stream within 2 s.
- Plug in a new device: its tile shows "Preparing" with the step, then the picture, without anyone opening it.
- Stop and start the core on the owner's 20-device farm: all 20 tiles live within 60 s with no browser interaction.
