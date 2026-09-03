# MVP 01 — Casting latency

> Status: researched 2026-09-03, plan proposed, no decision taken.
> Complaint as reported: "Android casting feels delayed compared with competitors, most visibly Panda."
> Related: `docs/spec.md` §16 NFR table (glass-to-glass < 150 ms), `docs/plans/08-m6-scrcpy.md`, `docs/plans/100-*.md` hypotheses H-8 and H-9, `docs/plans/125-*.md`, `docs/plans/13-m9-webrtc-backend.md`, `docs/benchmarks/webrtc.md`, `scripts/bench-device-nfrs.ts`.

---

## 0. The one fact that frames everything else

**Glass-to-glass latency has never been measured.** `docs/spec.md:1103` commits to under 150 ms for manual control. `docs/plans/100-*.md:529` (H-8) records that nobody has measured it, and H-9 (`:530`) records that we do not know whether the delay is dominated by encode and transport or by browser decode buffering. `docs/plans/125-*.md:119,127` shipped a click-to-first-paint timer and explicitly excluded glass-to-glass as needing a browser-driving harness that does not exist. `scripts/bench-device-nfrs.ts:31-51` measures on-socket FPS and time-to-first-packet only, the server-side leg.

So the honest position for investors is: we have a plausible pipeline and a target, and no number. Everything in §2 is a list of places where latency is being spent for no reason. §4 step 1 is the measurement that decides what the rest is worth.

## 1. The pipeline as it stands

Phone MediaCodec → scrcpy-server 3.3.1 over an adb forward → core demuxer → one WebSocket send per access unit → Studio WebCodecs `VideoDecoder` → 2D canvas.

### 1.1 Encoder launch (`packages/scrcpy/src/session.ts:196-210`)

```
video=true audio=false control=true tunnel_forward=true
video_codec=h264            (hardcoded; h265/av1 never requested)
max_size=1600 video_bit_rate=4000000 max_fps=30   (control preset "sharp", the shipped default)
cleanup=true raw_stream=false
```

Version pin: `packages/scrcpy/src/version.ts:11` (`3.3.1`). Nothing sets `video_encoder`, `display_id`, or an IDR interval; scrcpy exposes no interval, a fresh IDR is only obtainable through the `RESET_VIDEO` control message (`version.ts:38-57`).

Presets (`packages/session/src/video-profile.ts:13,48`):

| Preset | maxSize | maxFps | bitRate |
|---|---|---|---|
| control `sharp` (default) | 1600 | 30 | 4 000 000 |
| control `balanced` | 1080 | 30 | 2 500 000 |
| control `light` | 720 | 20 | 1 200 000 |
| wall `balanced` (default) | 480 | 18 | 1 100 000 |

Every one of these is a launch argument, so a change means an encoder teardown and rebuild (`POST /api/video/reprofile`, `packages/core/src/api/video.ts:32`).

The jar is pushed on every session start (`session.ts:187-193`, `:536-542`) because scrcpy unlinks itself. Video socket connect: up to 40 attempts of 400 ms wait plus 150 ms sleep, about 22 s worst case (`session.ts:742-794`).

### 1.2 Host demux (`packages/scrcpy/src/demuxer.ts`)

Wire format parsed correctly (`:18-20`). But `push()` (`:65-71`) allocates a new buffer and copies the entire pending buffer on **every TCP chunk**. There is no ring buffer and no high-water mark. At 4 Mbit/s per device this is an O(n) copy on the hot path, per device, per chunk.

The demuxer produces the device PTS. `packages/drivers/src/display/scrcpy.ts:68-77` **discards it**: `FrameMeta` carries only `capturedAt: Date.now()`. This single omission is why the pipeline delay cannot be measured in-band and why H-8 stayed open.

### 1.3 Core to browser (`packages/core/src/server/ws-handlers.ts:917-973`)

Raw Annex-B access units in an 11-byte binary frame (`packages/protocol/src/binary.ts`). One `ws.send` per access unit per viewer, immediately, no queue, no batching. Backpressure is drop-to-keyframe above `MAX_BUFFERED = 512 KiB` (`:73`): once congested, the binding freezes until the buffer drains and an IDR arrives, requested through `RESET_VIDEO`. `encodeVideoFrame` copies the payload once per viewer. WS server: `idleTimeout: 120`, `sendPings: true`, no compression (`packages/core/src/daemon.ts:3395-3404`).

Join priming (`ws-handlers.ts:1073-1099`): cached SPS/PPS, cached keyframe, then a keyframe request. Gated on a real measurement (moto g06 power) that `RESET_VIDEO` before the encoder runs kills the server.

### 1.4 Browser decode and paint (`packages/studio/src/lib/h264-decoder.ts`)

- WebCodecs `VideoDecoder`, `configure({ codec, optimizeForLatency: true })` (`:99-103`). **No `hardwareAcceleration` hint.**
- Decoder torn down and rebuilt on every SPS with new dimensions, i.e. every rotation (`:94-106`).
- Chunks timestamped with `performance.now() * 1000` (`:142`), not device PTS.
- Output callback paints **synchronously**: `ctx.drawImage(frame); frame.close()` (`:69-76`). No `requestAnimationFrame`, no `requestVideoFrameCallback`, `decodeQueueSize` never read, so a slow tab accumulates decode backlog instead of dropping to the newest frame.
- Canvas is plain `getContext('2d')`, no `desynchronized: true`, no `alpha: false`.
- No WebCodecs → LiveView says "use Chromium" (`LiveView.tsx:440-442`). The TinyH264 fallback in plan 08 was never built.

`LiveView.tsx` never drops H.264 frames on sequence (`:505`), computes FPS over a 3 s window (`:527-531`), requests a keyframe on hidden→visible (`:591-596`). Wall tiles are the same component at `quality="wall"` (`wall/WallTile.tsx:492`).

### 1.5 Input (the part users actually feel)

Browser → `input.tap | swipe | gesture | key | text` over WS, fire-and-forget (`LiveView.tsx:685-713`).

| Behaviour | Value | Where |
|---|---|---|
| Pointer-move sampling | 8 ms | `LiveView.tsx:36` |
| **A drag is buffered until pointer-up** and sent as one gesture | whole drag | `LiveView.tsx:39` and the gesture path |
| Typed text debounce | 500 ms | `LiveView.tsx:27,879` |
| Synthetic tap hold (down → sleep → up) | 40–120 ms | `packages/drivers/src/input/scrcpy-input.ts` |
| UHID first-use settle | 1500 ms | `scrcpy-input.ts` |
| Arbiter queue wait before `E_INPUT_BUSY` | 5 000 ms | `packages/session/src/session.ts:36` |

No `setNoDelay` is called on any Bun socket in the repo outside the proxy-manager pack, so the adb-forward control socket runs with whatever Nagle behaviour Bun defaults to.

**Assessment (opinion):** a drag with zero on-screen feedback until release, plus a 40–120 ms hold on every tap, is enough on its own to make a product "feel" slower than Panda's "millisecond-level" gestures, regardless of what the video pipeline measures.

### 1.6 Cloud mode

Phone → node (`packages/node/src/hosts.ts:236-241`) → tunnel frame `[0x02][u16 channel][payload]` (`packages/protocol/src/tunnel.ts:126`) → control plane `router.handleNodeFrame` (`packages/core/src/tunnel/router.ts:153-163`) → `device-proxy` → re-wrapped by `encodeVideoFrame` → browser. Two WebSocket hops with a re-frame between them, and:

- Frame metadata is lost across the tunnel; the control plane recovers the keyframe flag by **scanning every access unit's bytes** (`device-proxy.ts:80-88`, `binary.ts:60-71`).
- Quality is not negotiable remotely (`ws-handlers.ts:986-993`): every node device streams at the node's schema default whether it is a control view or a wall tile.
- Remote sessions have no config or keyframe priming on join and `stream.keyframe` is a no-op (`ws-handlers.ts:1120-1128`).
- Node-side video never checks `tunnel.bufferedAmount()`; only the shell host does.
- The node does not pass a `push` callback, so it still spawns adb processes for the jar push (`hosts.ts:104`).

### 1.7 WebRTC: built on the server, unreachable from the client

`packages/core/src/relay/{rtc-peer,werift-peer,webrtc-relay,rtp-h264}.ts` are complete (werift, H.264 PT 96, packetization-mode 1, NACK/PLI/REMB) and wired in `daemon.ts:2172-2186`. `packages/studio/src/lib/webrtc-player.ts` exports `createWebRtcPlayer` with **zero callers**; LiveView only listens for `video.webrtc.failed` (`LiveView.tsx:472`). Note also that the relay's `requestKeyframe` re-sends `session.start` rather than `RESET_VIDEO`, which looks wrong and is untested. `docs/benchmarks/webrtc.md` verified werift on Bun but never measured a painted frame in a browser.

## 2. Where latency is spent for no reason

Ranked by my estimate of impact on perceived latency (opinion, to be replaced by the measurement in §4 step 1):

1. Drag buffered to pointer-up; synthetic tap hold; 500 ms text debounce (§1.5).
2. Synchronous paint in the decoder callback with no newest-frame-wins policy (§1.4).
3. Default control profile 1600 px / 4 Mbit on farms fed through USB hubs (§1.1).
4. No hardware-acceleration hint to the decoder (§1.4).
5. Full-buffer copy per TCP chunk in the demuxer (§1.2).
6. Nagle on the control socket (§1.5).
7. Cloud: keyframe byte scan, no quality negotiation, no priming (§1.6).

## 3. What Panda does differently (as far as public information goes)

Native client, hardware decoder, window painted directly, 24 FPS thumbnails, one process per machine talking to adb. No web tier, no WebSocket, no browser. Nothing published suggests a different protocol from ours; the difference is fewer layers and, presumably, that they tuned the layers they have. Our Tauri desktop app (`apps/desktop`) wraps the same web stack, so it inherits every item in §2.

## 4. Proposed plan, cheapest first

### Step 1 — measure (one sprint, one device)

- Carry device PTS from the demuxer through `FrameMeta`, the binary frame header, and into the decoder's chunk timestamp. This is the in-band delay measurement that H-8 needs.
- Add a latency overlay to LiveView (device PTS vs paint time, decode queue depth, dropped frames).
- Run H-9: same device, `controlMaxFps` 30 vs 60. If 60 halves the delay, the encoder frame interval dominates; if not, the browser does.
- Run the camera-and-stopwatch procedure from `docs/plans/08-m6-scrcpy.md:541-548` once, so we have one number that is independent of our own instrumentation.
- Exit criterion: a median glass-to-glass figure on LAN, recorded in this document.

### Step 2 — input and paint quick wins (same sprint, no measurement dependency)

- Stream drag samples live instead of buffering to pointer-up; keep the batched gesture only for the recorder.
- Make the synthetic tap hold the minimum scrcpy accepts, and let the browser's measured hold override it.
- `hardwareAcceleration: 'prefer-hardware'` on the decoder, with fallback on configure failure.
- Paint via `requestAnimationFrame`, newest frame wins, close the others; read `decodeQueueSize` and drop to keyframe when it grows.
- `desynchronized: true, alpha: false` on the canvas context.
- Ring buffer in the demuxer.
- `setNoDelay(true)` on the scrcpy control socket.
- Consider `balanced` (1080 px, 2.5 Mbit) as the shipped control default; keep `sharp` selectable.

### Step 3 — cloud path (one sprint)

- Carry `FrameMeta` (keyframe flag, dimensions, PTS) inside the tunnel frame so the control plane stops scanning bytes.
- Negotiate a quality profile per remote binding.
- Prime remote joins with cached config and keyframe from the node.
- Check `bufferedAmount()` on the node's video path.

### Step 4 — WebRTC on the client, only if step 1 on WAN says so

Wire `createWebRtcPlayer` into LiveView behind a flag, fix the keyframe request to use `RESET_VIDEO`, and measure against WS under 3 % loss as `docs/benchmarks/webrtc.md` lists. On LAN, WS plus WebCodecs is simpler and probably sufficient.

## 5. What this does not propose

- Server-side transcoding or downscaling. Ruled out architecturally in `docs/plans/100-*.md:65` (zero codec dependencies) and still ruled out here.
- Forking scrcpy's Java side. `packages/scrcpy/src/version.ts` remains the only source of that version.
- A native desktop client. Every gain in §4 lands in the Tauri wrapper for free.

## 6. Decisions needed

1. Approve step 1 as a measurement sprint with no user-visible deliverable other than the overlay.
2. Provide one lab device (Android 16 preferred, any recent device acceptable for this document).
3. Confirm the target: keep the spec's 150 ms glass-to-glass, or restate it after step 1 produces a number.
