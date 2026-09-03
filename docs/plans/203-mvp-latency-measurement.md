# Plan 203 — MVP wave 0 : Latency measurement — device PTS end to end, the overlay, the H-9 experiment, the bench harness

> Status: implemented (software) — 2026-09-03. Every G1-G11, G15, G16 row in §0 is checked by a command that was run and read. G4, G6, G7, G12, G13, G14 stay `owner`: G4/G6/G7 are implemented in code but need a real h264 stream (a lab device) to render or exercise at all, and G12-G14 are the explicitly hardware-gated rows (bench numbers, the H-9 experiment, the camera glass-to-glass measurement) — there is no lab device in this environment. No number was written into `docs/mvp/01-casting-latency.md` or `docs/spec.md`; see §11.
> Depends on: nothing (wave 0, `docs/plans/200-mvp-program.md` §4). Reads `docs/mvp/01-casting-latency.md` (all of it; §1.2, §1.3, §1.4 and §4 step 1 are the source of every step below), `docs/mvp/09-additional-scope.md` §7, `docs/mvp/16-consolidated-plan.md` §2 (Video row) and §3 (wave 0). External facts: R1 and R3 from plan 200 §5.
> Spec references: `docs/spec.md` §16 line 1103 (`| Glass-to-glass latency (manual control) | < 150 ms | scrcpy H.264 plus WebCodecs |`), §7.6 (vanilla scrcpy-server, never forked), §13 (binary WS streams). Until plan 202 rewrites the spec, `docs/mvp/16` wins where they disagree (plan 200 header).
> Ships: packages/studio/src/components/video/LatencyOverlay.tsx
> **Testing override, read before §5 and §7:** §12 supersedes every Studio and `@enkaku/ui` test named anywhere below. Create no test and run no test under `packages/studio` or `packages/ui`; delete a surviving one that breaks and list it in §11. Verification for UI is `bun run typecheck`, the design-token and route scripts, and the owner smoke.

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The binary video frame header carries the device PTS and the host receive time | header length 27 bytes; bytes 11..18 u64BE `ptsUs`, bytes 19..26 u64BE `hostReceivedAt` (unix ms); `VIDEO_HEADER_LEN === 27` | `bun test packages/protocol/src/binary.test.ts` → the test `round-trips ptsUs and hostReceivedAt through the 27-byte header` passes | [x] |
| G2 | The demuxer stamps every packet with the moment its bytes reached the host | `ScrcpyPacket.receivedAt` (unix ms) present on `config`, `keyframe` and `frame`; `ptsUs` unchanged | `bun test packages/scrcpy/src/demuxer.test.ts` → 4 tests pass | [x] |
| G3 | `FrameMeta.capturedAt` no longer exists; `ptsUs` and `hostReceivedAt` replace it at every producer | 0 matches | `rg -n "capturedAt" packages/protocol/src/driver.ts packages/drivers/src packages/session/src packages/core/src/server packages/core/src/tunnel packages/studio/src` → empty | [x] |
| G4 | The browser decoder timestamps chunks with the device PTS, not the wall clock | `EncodedVideoChunk.timestamp === Number(ptsUs)` for `ptsUs > 0n`; `lastTimestampUs + 1` for `ptsUs === 0n` | amended §12: implemented in `packages/studio/src/lib/h264-decoder.ts`, no Studio test exists for it (plan 200 §8.3); verified by owner smoke on the lab device | owner |
| G5 | The latency estimator is pure and deterministic | offset = min over the first 60 samples with `ptsUs > 0n` of `hostReceivedAt - Number(ptsUs) / 1000`; window 120 samples; median and p95 | amended §12: moved to `packages/protocol/src/video-latency.ts` — `bun test packages/protocol/src/video-latency.test.ts` → 5 tests pass | [x] |
| G6 | `LatencyOverlay` renders the eight rows from a summary | rows `device→host`, `host→browser`, `decode`, `decode→paint`, `queue`, `fps`, `dropped`, `keyframe requests` | amended §12: implemented in `packages/studio/src/components/video/LatencyOverlay.tsx`, no Studio test exists for it; verified by owner smoke on the lab device | owner |
| G7 | The overlay toggle persists per browser | `LocalPrefs.latencyOverlay: boolean`, default `false` | amended §12: implemented in `packages/studio/src/lib/prefs.ts` (`bun run typecheck` clean); verified by reloading the page and observing the toggle state — needs an h264 stream (a real device) to render the toggle at all, so this is an owner check | owner |
| G8 | The core exposes per-device server-side latency numbers | `GET /api/video/latency?deviceId=<id>` → `VideoLatencyResponseSchema`; `400 E_BAD_REQUEST` without `deviceId`; `501 E_NOT_SUPPORTED` without sessions | `bun test packages/core/src/api/video.test.ts` → 5 new tests pass (400, 501, join, zero-counters, permission) | [x] |
| G9 | The session manager tracks per-entry PTS statistics | `SessionManager.videoLatency(deviceId)` returns one row per open `(deviceId, quality)` entry | `bun test packages/session/src/video-latency.test.ts` → 4 tests pass | [x] |
| G10 | Every `TODO-verify` marker in `packages/scrcpy` is replaced by a dated verification line | 0 matches | `rg -n "TODO-verify" packages/scrcpy` → empty; `rg -n "verified against v3.3.1" packages/scrcpy/src` → 5 matches (`version.ts` ×2, `demuxer.ts`, `control/messages.ts`, `session.ts`) | [x] |
| G11 | The bench script has a `--latency` mode and a `--warmup` placeholder | `--latency` prints one line starting `latency:`; `--warmup` prints `warmup: not implemented in plan 203 - plan 206 (always-on sessions) fills this mode` and exits 2 | `bun run scripts/bench-device-nfrs.ts --warmup; echo $?` → the line above, then `2` (no device needed: the check runs before the `ENKAKU_TEST_DEVICE` gate) | [x] |
| G12 | Server-side leg numbers exist for the lab device | `ENKAKU_TEST_DEVICE=1 bun run bench:device-nfrs -- --serial <S> --latency --skip-inspector` prints `latency: ttfp=<N> ms ...` | owner, lab device attached; the line is pasted into §11 | owner |
| G13 | The H-9 experiment has been run and its table is filled | §5 step 203.13's table has six numbers (30 fps and 60 fps columns, three rows) | owner, lab device; the table in §5 step 203.13 is filled in this document | owner |
| G14 | A median glass-to-glass number exists | §5 step 203.14's table has ≥ 10 samples, a median and a p95 | owner, lab device, camera; the number is written into `docs/mvp/01-casting-latency.md` §4 step 1 by the owner after measurement. The threshold (`< 150 ms`, spec §16) is NOT a goal of this plan; a median number existing is | owner |
| G15 | Workspace typechecks | 0 errors | `bun run typecheck` → clean | [x] |
| G16 | The cloud path still compiles and still relays frames, with zeroed timing | `device-proxy.ts` sets `ptsUs: 0n, hostReceivedAt: Date.now()` | `bun run typecheck` → clean; `rg -n "ptsUs: 0n" packages/core/src/tunnel/device-proxy.ts` → 1 match | [x] |

## 1. Goals

1. The device presentation timestamp scrcpy already sends (`packages/scrcpy/src/demuxer.ts:123`, `const ptsUs = ptsAndFlags & PTS_MASK`) reaches the browser inside every video frame, together with the unix millisecond at which the host parsed that access unit. Today the display driver discards it (`packages/drivers/src/display/scrcpy.ts:73`, `capturedAt: Date.now(),`), which is why H-8 (`docs/plans/100-*.md` line 529) has stayed open (MVP 01 §1.2).
2. The WebCodecs decoder is fed the device PTS as the chunk timestamp instead of `performance.now() * 1000` (`packages/studio/src/lib/h264-decoder.ts:142`), so the decoder's output frame can be paired with the input chunk and every leg after the socket can be timed.
3. Studio has a latency overlay an operator can toggle on any Device Control cast (never on a Screens tile), showing per-leg medians and p95s, decode queue depth, fps, dropped frames and keyframe requests. Its numbers feed the "524 ms" readout the design handoff places in the Device Control stats strip (`docs/mvp/design_handoff_enkaku_openpf/README.md:254-256`), which plan 215 builds; this plan ships the overlay, not the strip.
4. The core exposes the server-side leg per device (`GET /api/video/latency?deviceId=`): time to first frame, PTS interval, arrival jitter, keyframe requests, congestion drops.
5. The two hardware measurements MVP 01 §4 step 1 asks for are written as scripted procedures with result tables the owner fills: the H-9 experiment (30 fps against 60 fps) and the camera-and-stopwatch glass-to-glass procedure from `docs/plans/08-m6-scrcpy.md:539-548`.
6. The four `TODO-verify` markers in `packages/scrcpy` (`version.ts:18`, `version.ts:29`, `demuxer.ts:6`, `control/messages.ts:5`, `session.ts:154`) are closed against the pinned scrcpy v3.3.1 Java source, as plan 200 R1 requires.
7. `scripts/bench-device-nfrs.ts` gains a `--latency` mode (server-side leg numbers) and a `--warmup` placeholder that plan 206 fills.

## 2. Non-goals

- **Changing any encoder preset, bitrate, size or fps default.** `packages/session/src/video-profile.ts:14-16` and `:49-52` stay byte-identical. Plan 209 (MVP 01 step 2) decides presets after this plan's numbers exist.
- **Any paint-policy change**: no `requestAnimationFrame` newest-frame-wins, no `desynchronized: true`, no `hardwareAcceleration` hint, no ring buffer in the demuxer, no `setNoDelay`. All of MVP 01 §4 step 2 is plan 209. The overlay observes the existing synchronous paint (`h264-decoder.ts:74-75`, `ctx?.drawImage(frame, 0, 0)` then `frame.close()`); it does not move it.
- **WebRTC on the client** (MVP 01 §4 step 4). `packages/studio/src/lib/webrtc-player.ts` is not touched; its deletion is plan 201's (MVP 13 B.2).
- **The cloud path** (MVP 01 §4 step 3, post-MVP per MVP 16 §1). `packages/core/src/tunnel/device-proxy.ts` and `packages/node/src/hosts.ts` are edited only as far as keeping them compiling; the tunnel frame `[0x02][u16 channel][payload]` (`packages/protocol/src/tunnel.ts:126`) is unchanged and still carries no metadata.
- **The Device Control stats strip** (handoff README line 254-256; MVP 15 §3 step 4). Plan 215.
- **Always-on sessions and warm-up timing** (MVP 11). Plan 206; the `--warmup` flag here is a placeholder that says so.
- **Input-leg measurement** (MVP 08 §4 last bullet: "measured on the lab device with the MVP 01 latency overlay, so the input leg has a number too"). Plan 209 and plan 215 use this overlay for that; this plan measures video only.
- **Upgrading the scrcpy pin** from 3.3.1 (plan 200 R1: "a decision for plan 209 §9, not a side effect").

## 3. Context and design decisions

### 3.1 What exists, verified 2026-09-03

**The device PTS is produced and then dropped.** `packages/scrcpy/src/demuxer.ts:111-129` parses the 12-byte frame header (`const ptsAndFlags = header.getBigUint64(0, false)`, `const size = header.getUint32(8, false)`) and emits `{ kind: 'keyframe' | 'frame', ptsUs, data }` (`:29-32`). `packages/drivers/src/display/scrcpy.ts:62-78` receives it and builds a `FrameMeta` with `capturedAt: Date.now()` (`:73`) and no PTS. `FrameMeta` itself (`packages/protocol/src/driver.ts:24-36`) has `capturedAt: number` (`:29`) and nothing else about time.

**The wire header is 11 bytes with no timing.** `packages/protocol/src/binary.ts:36` `const VIDEO_HEADER_LEN = 11`; `encodeVideoFrame` (`:38-51`) writes channel, streamId, codec|keyframe, u16 width, u16 height, u32 seq. `decodeVideoFrame` (`:108-128`) reads the same. Readers: `packages/core/src/server/ws-handlers.ts:970` (`const encoded = encodeVideoFrame(streamId, meta, chunk)`) and `:1089`/`:1092` (join priming with a hand-built `primer: FrameMeta` at `:1080-1087` whose `capturedAt: Date.now()` is at `:1085`); `packages/studio/src/components/LiveView.tsx:499` (`frame = decodeVideoFrame(buf)`); `packages/protocol/src/binary.test.ts:28`; `packages/studio/src/components/LiveView.test.tsx:636`.

**The dispatch path passes `FrameMeta` through untouched.** `packages/session/src/session.ts:990-1003` (`session.display.onFrame((chunk, meta) => { ... deps.onFrame?.(chunk, meta) })`) and `packages/session/src/manager.ts:452-456`:

```ts
const dispatchFrame = (key: string) => (chunk: Uint8Array, meta: FrameMeta) => {
  const entry = entries.get(key)
  if (!entry) return
  for (const cb of entry.frameSubscribers) cb(chunk, meta)
}
```

wired at `manager.ts:583` (`onFrame: dispatchFrame(key),`). This is the one place every frame of every open entry passes, which makes it the right place for the server-side tracker.

**The decoder timestamps with the wall clock.** `packages/studio/src/lib/h264-decoder.ts:139-145`:

```ts
decoder.decode(
  new EncodedVideoChunk({
    type: keyframe ? 'key' : 'delta',
    timestamp: performance.now() * 1000,
    data: payload,
  }),
)
```

Its output callback (`:67-78`) paints synchronously and never reads `decodeQueueSize`. `H264Renderer.decode(data, keyframe, width, height)` (`:14-18`) has no timing argument.

**LiveView measures one thing.** `packages/studio/src/components/LiveView.tsx:114` (`export function markLiveViewIntent`) and `:388-405` (`const markPainted = () => { ... }`) time click-to-first-paint, and its own header (`:65-78`) is explicit that this "is not glass-to-glass". The fps counter is a 3 s window (`:527-531`), the binary handler is `:497-556`, keyframe-on-visibility is `:591-596`, the status line renders `{fps} fps` at `:1027` and `click→paint` at `:1089-1100`.

**The bench script measures the socket only.** `scripts/bench-device-nfrs.ts:31-36` counts frame packets and time-to-first-packet; its header `:38-50` says glass-to-glass "is NOT measured here and cannot be, by any headless script". Its video stage is `:375-414`.

**The cloud path loses metadata.** `packages/core/src/tunnel/device-proxy.ts:80-90` rebuilds a `FrameMeta` with `capturedAt: Date.now()` (`:86`) and recovers the keyframe flag by scanning bytes (`isH264Keyframe`, `binary.ts:61-71`). `packages/node/src/hosts.ts:236-241` sends `chunk` alone into the tunnel. `packages/core/src/daemon.ts:2175-2176` feeds the WebRTC relay with `BigInt(Date.now()) * 1000n` as a fake PTS; that code is deleted by plan 201 and is not touched here.

**The scrcpy byte layouts carry `TODO-verify`.** `packages/scrcpy/src/version.ts:18` (`* TODO-verify against the pinned version's limits during device testing.` on `UHID_MIN_API`), `:29` (`/** host→device control message types (TODO-verify the ordering against the pinned version). */`), `demuxer.ts:6-7` (`Byte order on the video socket (tunnel_forward mode, TODO-verify against` / `source versi pinned):`), `control/messages.ts:5` (`* Byte layout is TODO-verify against the pinned version's source.`), `session.ts:154` (`is control (this ordering is part of the internal protocol` followed by `TODO-verify on` / `a real device).`). Plan 200 R1's caveat assigns closing them to this plan. The pinned jar is `enkaku-tools.json:78` (`https://github.com/Genymobile/scrcpy/releases/download/v3.3.1/scrcpy-server-v3.3.1`).

### 3.2 Decisions

**D1. Replace `capturedAt`, do not add beside it.** `capturedAt` has always been `Date.now()` at host parse time, misnamed. It becomes `hostReceivedAt` (unix ms) and `ptsUs: bigint` is added. `00-overview.md` §4.3 applies: no alias, no optional field kept "for one release". Every producer and every test literal moves in the same commit (§5 step 203.2).

**D2. The header grows from 11 to 27 bytes and nothing is versioned.** No header version byte, no length-prefixed header, no branch that accepts an 11-byte frame. The only client ships in this repository. Per-frame cost is 16 bytes on a payload that averages 16 KB at 4 Mbit/s and 30 fps; the ws-handlers backpressure limit (`MAX_BUFFERED = 512 * 1024`, `ws-handlers.ts:73`) is unaffected.

**D3. `ptsUs === 0n` means "no device clock".** PNG frames (`screencap-loop.ts:60`), the join primer (`ws-handlers.ts:1080-1087`), the config packet (SPS/PPS carries no PTS: `demuxer.ts:120-121`), and every frame relayed from a node (`device-proxy.ts`) carry `0n`. Every consumer that estimates time skips `0n` samples; every consumer that timestamps a decoder chunk substitutes `lastTimestampUs + 1` so WebCodecs still sees a monotonic sequence.

**D4. The device→host leg is min-anchored, and the overlay says so.** The device PTS is on the device's clock; `hostReceivedAt` is on the host's. The per-session offset is the minimum over the first 60 samples of `hostReceivedAt - Number(ptsUs) / 1000`, so `device→host` reads as transit relative to the fastest frame in the window, never as an absolute figure. The same rule applies to `host→browser` (`browserReceivedAt - hostReceivedAt`, min-anchored over the first 60 samples) because the browser may be on another machine. `decode` (submit→output) and `decode→paint` (output→next animation frame) are on one clock and absolute. The only absolute end-to-end number is the camera's (§5 step 203.14), exactly as `docs/plans/08-m6-scrcpy.md:546` item 5 already ruled: "angka acceptance tetap dari metode kamera" (the acceptance number still comes from the camera method).

**D5. The overlay reuses today's classes; it does not wait for plan 204.** Plan 204 (tokens, fonts) runs in the same wave. The overlay uses the `readout` and `rack-label` classes Studio already has (`packages/studio/src/app/globals.css:160-176`) and Tailwind v4 token classes (`bg-surface`, `text-fg-muted`); plan 204 restyles it with everything else. The handoff's own measurements for numeric readouts are quoted here so plan 215 can lift the numbers straight into the strip: "`Geist Mono` (400/500) for serials, endpoints, paths, versions, script names, timestamps and numeric readouts" and "11px column labels and hints, 10.5px badges, 10px tooltips and frame captions" (README lines 513-517).

**D6. Server-side numbers come from two places, joined by one route.** PTS statistics are computed where every frame passes (`dispatchFrame`, one tracker per `Entry`), and keyframe-request and congestion-drop counters are kept where those decisions are made (`ws-handlers.ts`), exposed through the same forward-ref pattern `transportStats` already uses (`ws-handlers.ts:2744-2746`, wired at `daemon.ts:3064`). `GET /api/video/latency` joins them per `(deviceId, quality)`.

**D7. Plan number.** This document is `203-mvp-latency-measurement.md`; `133-m98-a-down-path-says-why.md` exists from the previous series. Plan 200 set the precedent (`200-mvp-program.md` beside `130-m95-*.md`); the MVP series is addressed by title slug, not by number alone.

## 4. Technical design

### 4.1 `FrameMeta` (`packages/protocol/src/driver.ts`)

Replace lines 24-36 with:

```ts
export interface FrameMeta {
  width: number
  height: number
  codec: 'png' | 'h264'
  seq: number
  /**
   * The device's presentation timestamp for this access unit, in
   * microseconds on the device's own clock (scrcpy's PTS, bits 0..61 of the
   * 12-byte frame header, `packages/scrcpy/src/demuxer.ts`). `0n` means the
   * source has no device clock: a PNG screencap frame, an H.264 config
   * packet (SPS/PPS carries no PTS), the cached keyframe a joining viewer
   * is primed with, or a frame relayed from a node (the tunnel carries no
   * metadata). Consumers that estimate time skip `0n` samples.
   */
  ptsUs: bigint
  /**
   * Unix milliseconds (`Date.now()`) at the moment the host parsed this
   * access unit off the device socket. This is what `capturedAt` always
   * was, under its honest name.
   */
  hostReceivedAt: number
  /**
   * Whether this chunk can start a decode. Left undefined it means "PNG, so
   * yes"; H.264 sources must set it, because a decoder handed a delta frame
   * right after `configure()` fails outright instead of catching up.
   */
  keyframe?: boolean
}
```

### 4.2 Binary frame header (`packages/protocol/src/binary.ts`)

New layout, replacing the 11-byte one. Bytes 0..1 keep their meaning (the file's own rule, `binary.ts:5`).

```
byte 0       u8    channel   0x01 VIDEO
byte 1       u8    streamId
byte 2       u8    codec (0x01 PNG, 0x02 H264) | VIDEO_FLAG_KEYFRAME (0x80)
byte 3..4    u16BE width
byte 5..6    u16BE height
byte 7..10   u32BE seq
byte 11..18  u64BE ptsUs          device PTS, microseconds; 0 = no device clock
byte 19..26  u64BE hostReceivedAt unix milliseconds at host parse time
byte 27..    payload (Annex-B access unit, or a whole PNG)
```

```ts
const VIDEO_HEADER_LEN = 27

export function encodeVideoFrame(streamId: number, meta: FrameMeta, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(VIDEO_HEADER_LEN + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint8(0, CHANNEL.VIDEO)
  dv.setUint8(1, streamId & 0xff)
  const codec = meta.codec === 'png' ? VIDEO_CODEC.PNG : VIDEO_CODEC.H264
  const isKeyframe = meta.keyframe ?? meta.codec === 'png'
  dv.setUint8(2, codec | (isKeyframe ? VIDEO_FLAG_KEYFRAME : 0))
  dv.setUint16(3, meta.width, false)
  dv.setUint16(5, meta.height, false)
  dv.setUint32(7, meta.seq >>> 0, false)
  dv.setBigUint64(11, meta.ptsUs, false)
  dv.setBigUint64(19, BigInt(Math.max(0, Math.floor(meta.hostReceivedAt))), false)
  out.set(data, VIDEO_HEADER_LEN)
  return out
}

export interface DecodedVideoFrame {
  channel: number
  streamId: number
  codec: number
  width: number
  height: number
  seq: number
  /** True for a PNG frame, an H.264 config packet (SPS/PPS), or an IDR. */
  keyframe: boolean
  /** Device PTS in microseconds; `0n` when the source had no device clock (see `FrameMeta.ptsUs`). */
  ptsUs: bigint
  /** Unix milliseconds at host parse time (see `FrameMeta.hostReceivedAt`). */
  hostReceivedAt: number
  data: Uint8Array
}

export function decodeVideoFrame(buf: Uint8Array): DecodedVideoFrame {
  if (buf.length < VIDEO_HEADER_LEN) throw new Error(`frame too short: ${buf.length} bytes`)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const channel = dv.getUint8(0)
  if (channel !== CHANNEL.VIDEO) throw new Error(`channel is not VIDEO: 0x${channel.toString(16)}`)
  const codecByte = dv.getUint8(2)
  const codec = codecByte & ~VIDEO_FLAG_KEYFRAME
  if (codec !== VIDEO_CODEC.PNG && codec !== VIDEO_CODEC.H264) {
    throw new Error(`unknown codec: 0x${codec.toString(16)}`)
  }
  return {
    channel,
    streamId: dv.getUint8(1),
    codec,
    width: dv.getUint16(3, false),
    height: dv.getUint16(5, false),
    seq: dv.getUint32(7, false),
    keyframe: (codecByte & VIDEO_FLAG_KEYFRAME) !== 0,
    ptsUs: dv.getBigUint64(11, false),
    hostReceivedAt: Number(dv.getBigUint64(19, false)),
    data: buf.subarray(VIDEO_HEADER_LEN),
  }
}
```

No Zod here: this is byte code on a hot path, exactly as the file is today. The doc comment at `binary.ts:11-16` is rewritten to the layout above.

### 4.3 Demuxer packets (`packages/scrcpy/src/demuxer.ts`)

```ts
export type ScrcpyPacket =
  | { kind: 'config'; receivedAt: number; data: Uint8Array }
  | { kind: 'keyframe'; ptsUs: bigint; receivedAt: number; data: Uint8Array }
  | { kind: 'frame'; ptsUs: bigint; receivedAt: number; data: Uint8Array }
```

`receivedAt` is `now()` taken once at the top of `push(chunk)` (`demuxer.ts:65`) and stamped on every packet that `drain()` completes from that chunk; `now` is a constructor option defaulting to `Date.now` so the test can inject a clock:

```ts
constructor(
  private opts: {
    expectDummyByte: boolean
    onMeta: (meta: VideoMeta) => void
    onPacket: (packet: ScrcpyPacket) => void
    /** Clock for `receivedAt`; tests inject one. Defaults to `Date.now`. */
    now?: () => number
  },
)
```

`push` becomes `const receivedAt = (this.opts.now ?? Date.now)(); ...; this.drain(receivedAt)`, and `drain(receivedAt: number)` passes it into both `onPacket` calls at `:121` and `:124-128`.

### 4.4 Producers

- `packages/drivers/src/display/scrcpy.ts:68-77`: `ptsUs: packet.kind === 'config' ? 0n : packet.ptsUs, hostReceivedAt: packet.receivedAt,` replacing `capturedAt: Date.now(),`.
- `packages/drivers/src/display/screencap-loop.ts:60`: `{ width, height, codec: 'png', seq: this.seq++, ptsUs: 0n, hostReceivedAt: t0 }`.
- `packages/core/src/server/ws-handlers.ts:1080-1087` (primer): `ptsUs: 0n, hostReceivedAt: Date.now(),`.
- `packages/core/src/tunnel/device-proxy.ts:81-88`: `ptsUs: 0n, hostReceivedAt: Date.now(),` with the comment "the tunnel carries no metadata (MVP 01 §1.6); cloud is post-MVP".

### 4.5 Server-side tracker (`packages/session/src/video-latency.ts`, new)

```ts
import type { FrameMeta } from '@enkaku/protocol'

/** Mirrors `packages/core/src/server/transport-metrics.ts`'s ring size. */
const RING_SIZE = 128

export interface VideoLatencySnapshot {
  /** Frames dispatched since the entry was created (config packets included). */
  frames: number
  /** Entry creation → first dispatched frame, ms; null until one arrived. */
  firstFrameMs: number | null
  /** Consecutive device PTS deltas, ms (the encoder's real frame interval). 0 until two `ptsUs > 0n` frames exist. */
  ptsIntervalMsP50: number
  ptsIntervalMsP95: number
  /** |Δ hostReceivedAt − Δ pts| between consecutive `ptsUs > 0n` frames, ms: how unevenly the host receives an evenly-timed stream. */
  arrivalJitterMsP95: number
  /** `now - hostReceivedAt` of the last frame, ms; null before the first frame. */
  lastFrameAgeMs: number | null
}

export interface VideoLatencyTracker {
  record(meta: FrameMeta): void
  snapshot(): VideoLatencySnapshot
}

export function createVideoLatencyTracker(opts: { startedAt: number; now?: () => number }): VideoLatencyTracker
```

Rules: `record` increments `frames`, sets `firstFrameMs` once, and for `meta.ptsUs > 0n` pushes `Number(meta.ptsUs - lastPtsUs) / 1000` and `Math.abs((meta.hostReceivedAt - lastHostReceivedAt) - Number(meta.ptsUs - lastPtsUs) / 1000)` into two rings when a previous `ptsUs > 0n` sample exists; a PTS that goes backwards resets `lastPtsUs` (the encoder restarted) without pushing a sample. Percentile is the same `floor(p * n)` index used by `transport-metrics.ts:51-55`.

`Entry` (`manager.ts:14-56`) gains `latency: VideoLatencyTracker`, created in `createEntry` with `startedAt: Date.now()`; `dispatchFrame` calls `entry.latency.record(meta)` before the fan-out loop. `SessionManager` gains:

```ts
/**
 * Plan 203 §4.5: per-entry PTS statistics for `GET /api/video/latency`.
 * Optional for the same fixture-compatibility reason `videoStats` is.
 */
videoLatency?(deviceId: string): Array<{ quality: Quality; viewers: number } & VideoLatencySnapshot>
```

implemented as: for every entry with `entry.deviceId === deviceId`, `{ quality: entry.quality, viewers: entry.refcount, ...entry.latency.snapshot() }`.

### 4.6 Stream counters (`packages/core/src/server/ws-handlers.ts`)

```ts
interface StreamCounters { keyframeRequests: number; congestionDrops: number }
/** Keyed `${deviceId}:${quality}`; in-memory, cleared on restart, like `transportMetrics`. */
const streamCounters = new Map<string, StreamCounters>()
function countersFor(binding: StreamBinding): StreamCounters
```

Increments:

- `keyframeRequests`: at the congestion request (`ws-handlers.ts:955-958`, `sessionForBinding(binding)?.requestKeyframe?.()` at `:957`), at the join request (`:1104`, `localSession?.requestKeyframe?.()`), and at `case 'stream.keyframe'` (`:1120-1128`, `requestKeyframe` at `:1127`).
- `congestionDrops`: at `if (congested) return` (`:953`, PNG) and at `if (congested || !meta.keyframe) return` (`:961`, H.264).

Exposed from the router's return object next to `transportStats` (`:2744-2746`):

```ts
/** Plan 203 §4.6: `GET /api/video/latency`'s per-stream counters. */
videoStreamStats(deviceId: string): Array<{ quality: Quality; keyframeRequests: number; congestionDrops: number }>
```

`quality` comes from `binding.quality ?? 'control'` (`StreamBinding.quality`, `:203`). The `binding.quality` is set before the binding is stored (`:194-202`), so `countersFor` is only called after it.

### 4.7 Route: `GET /api/video/latency?deviceId=<id>`

Schema in `packages/protocol/src/api/video.ts`, beside `VideoReprofileResponseSchema` (`:13-20`); exported through `packages/protocol/src/api/index.ts:30` (`export * from './video'`), so no `index.ts` edit is needed. Name must be unique across the package (`export-uniqueness.test.ts`).

```ts
/**
 * `GET /api/video/latency?deviceId=<id>` (plan 203 §4.7): the server-side
 * leg of the latency picture, per open `(deviceId, quality)` entry. Nothing
 * here is persisted; a core restart clears it. `streams` is empty for a
 * device with no open session, never a 404: the question "what is open" has
 * an answer either way.
 */
export const VideoLatencyStreamSchema = z.object({
  quality: QualitySchema,
  /** Subscribers on this entry (the entry's refcount). */
  viewers: z.number().int(),
  frames: z.number().int(),
  firstFrameMs: z.number().nullable(),
  ptsIntervalMsP50: z.number(),
  ptsIntervalMsP95: z.number(),
  arrivalJitterMsP95: z.number(),
  lastFrameAgeMs: z.number().nullable(),
  /** `RESET_VIDEO` requests sent for this stream: congestion recoveries, joins, and visibility keyframes. */
  keyframeRequests: z.number().int(),
  /** Frames dropped by the drop-to-keyframe backpressure rule. */
  congestionDrops: z.number().int(),
})
export const VideoLatencyResponseSchema = z.object({
  deviceId: z.string(),
  /** Unix ms at which the snapshot was taken. */
  at: z.number().int(),
  streams: z.array(VideoLatencyStreamSchema),
})
export type VideoLatencyResponse = z.infer<typeof VideoLatencyResponseSchema>
```

`QualitySchema` is imported from `../messages/stream` (it is defined at `packages/protocol/src/messages/stream.ts:12`).

Route, in `createVideoRoutes` (`packages/core/src/api/video.ts`):

| Method | Path | Query | Permission | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/video/latency` | `deviceId` (required, non-empty) | `device.view` | `200` `VideoLatencyResponseSchema` | `400 E_BAD_REQUEST` when `deviceId` is missing or empty; `501 E_NOT_SUPPORTED` when `sessions()` is null or has no `videoLatency` (orchestrator mode, adb not up) |

```ts
export function createVideoRoutes(deps: {
  sessions: () => Pick<SessionManager, 'reprofile' | 'videoLatency'> | null
  /** `ws-handlers.ts`'s `videoStreamStats` (plan 203 §4.6), forward-ref like `adb-stats.ts`'s `transport`. Absent → zero counters. */
  streamStats?: (deviceId: string) => Array<{ quality: Quality; keyframeRequests: number; congestionDrops: number }> | null
}): Hono<AuthEnv>
```

```ts
app.get('/latency', requirePermission('device.view'), (c) => {
  const deviceId = c.req.query('deviceId')?.trim() ?? ''
  if (!deviceId) throw new EnkakuError('E_BAD_REQUEST', 'deviceId is required')
  const videoLatency = deps.sessions()?.videoLatency
  if (!videoLatency) {
    throw new EnkakuError('E_NOT_SUPPORTED', 'video sessions are not available (orchestrator mode, or the adb subsystem is not ready yet)')
  }
  const counters = deps.streamStats?.(deviceId) ?? []
  const streams = videoLatency(deviceId).map((s) => {
    const c2 = counters.find((x) => x.quality === s.quality)
    return { ...s, keyframeRequests: c2?.keyframeRequests ?? 0, congestionDrops: c2?.congestionDrops ?? 0 }
  })
  return typedJson(c, VideoLatencyResponseSchema, { deviceId, at: Date.now(), streams })
})
```

`ERROR_STATUS` (`video.ts:9`) becomes `{ E_NOT_SUPPORTED: 501, E_BAD_REQUEST: 400 }`. Wiring in `daemon.ts:3124`: `videoRoutes: createVideoRoutes({ sessions: () => sessions, streamStats: (id) => videoStreamStats?.(id) ?? null })`, where `videoStreamStats` is a forward-ref resolved when `attachWsRouter` runs, declared beside `transportStats` (same pattern, `daemon.ts:3064`).

### 4.8 Decoder (`packages/studio/src/lib/h264-decoder.ts`)

```ts
export interface FrameTiming {
  ptsUs: bigint
  hostReceivedAt: number
  /** `Date.now()` when the WS binary message reached this browser. */
  browserReceivedAt: number
}

export type DecodeEvent =
  | {
      kind: 'decoded'
      ptsUs: bigint
      hostReceivedAt: number
      browserReceivedAt: number
      /** `performance.now()` just before `decoder.decode()`. */
      submittedAt: number
      /** `decoder.decodeQueueSize` read just before `decoder.decode()`. */
      queueSize: number
      /** `performance.now()` inside the output callback, before `drawImage`. */
      outputAt: number
      /** The `requestAnimationFrame` timestamp of the first animation frame after `drawImage`. */
      paintedAt: number
    }
  | { kind: 'dropped'; reason: 'awaiting-keyframe' | 'no-decoder' }

export interface H264Renderer {
  decode(data: Uint8Array, keyframe: boolean, width: number, height: number, timing: FrameTiming): void
  close(): void
}

export function createH264Renderer(
  canvas: HTMLCanvasElement,
  onError: (msg: string) => void,
  onEvent?: (event: DecodeEvent) => void,
): H264Renderer | null
```

Rules inside `decode`:

1. `timestamp`: `timing.ptsUs > 0n ? Number(timing.ptsUs) : lastTimestampUs + 1`; then `lastTimestampUs = timestamp`. This replaces `performance.now() * 1000` (`:142`).
2. Before `decoder.decode(...)`: `pending.set(timestamp, { ...timing, submittedAt: performance.now(), queueSize: decoder.decodeQueueSize })`. `pending` is a `Map<number, ...>`; when its size exceeds 300, delete the oldest key (a decoder that never outputs a chunk must not leak).
3. In the output callback (`:69-76`), after `ctx?.drawImage(frame, 0, 0)` and before `frame.close()`: `const p = pending.get(frame.timestamp)`; if found, delete it and push `{ ...p, outputAt }` onto `paintQueue`; if no `requestAnimationFrame` is scheduled, schedule one; its callback `(t) => { for (const s of paintQueue) onEvent?.({ kind: 'decoded', ...s, paintedAt: t }); paintQueue = []; rafId = 0 }`.
4. The two early returns at `:117` (`if (!decoder || !configured) return`) and `:122` (`if (!keyframe) return`) emit `{ kind: 'dropped', reason: 'no-decoder' }` and `{ kind: 'dropped', reason: 'awaiting-keyframe' }` respectively.
5. `close()` cancels a scheduled animation frame and clears `pending`.

Nothing else in the file changes: `configure({ codec, optimizeForLatency: true })` (`:99-103`) stays exactly as it is (R3's `hardwareAcceleration` is plan 209's).

### 4.9 Estimator (`packages/studio/src/lib/latency-stats.ts`, new, pure)

```ts
import type { DecodeEvent } from './h264-decoder'

export const OFFSET_WINDOW = 60
export const SUMMARY_WINDOW = 120

export interface LegSummary { median: number; p95: number; n: number }

export interface LatencySummary {
  /** null until OFFSET_WINDOW samples with ptsUs > 0n have been seen. */
  deviceToHost: LegSummary | null
  /** null until OFFSET_WINDOW samples have been seen. */
  hostToBrowser: LegSummary | null
  decode: LegSummary
  decodeToPaint: LegSummary
  queue: LegSummary
  fps: number
  dropped: number
  keyframeRequests: number
  /** Samples seen towards the two offsets, for the "estimating (n/60)" caption. */
  offsetSamples: number
}

export interface LatencyEstimator {
  push(event: DecodeEvent): void
  /** A `stream.keyframe` this view sent. */
  noteKeyframeRequest(): void
  /** A gap in `seq` between two `ptsUs > 0n` frames: `gap` frames never reached this browser. */
  noteSeqGap(gap: number): void
  /** New stream (`stream.started`) or the PTS went backwards by more than 1 s: forget both offsets and every window. */
  reset(): void
  summary(now: number): LatencySummary
}

export function createLatencyEstimator(): LatencyEstimator
```

Exact estimator:

- `deviceOffsetMs = min over the first OFFSET_WINDOW events with ptsUs > 0n of (hostReceivedAt - Number(ptsUs) / 1000)`. After the window closes the offset is frozen. Per event: `deviceToHost = (hostReceivedAt - Number(ptsUs) / 1000) - deviceOffsetMs`, clamped at 0.
- `hostOffsetMs = min over the first OFFSET_WINDOW events of (browserReceivedAt - hostReceivedAt)`. Per event: `hostToBrowser = (browserReceivedAt - hostReceivedAt) - hostOffsetMs`, clamped at 0.
- `decode = outputAt - submittedAt`; `decodeToPaint = paintedAt - outputAt`; `queue = queueSize`.
- Each leg keeps the last `SUMMARY_WINDOW` samples; `median` is the `floor(0.5 * n)` element of the sorted copy and `p95` the `floor(0.95 * n)` element, the same index rule as `transport-metrics.ts:51-55`.
- `fps` is the count of `decoded` events whose `paintedAt` lies within the last 3000 ms of `now` divided by 3 (LiveView's own window, `:527-531`), computed from `performance.now()`-based `paintedAt` values; `now` is `performance.now()`.
- `dropped` = count of `dropped` events + the sum of `noteSeqGap` gaps since the last `reset`. `keyframeRequests` = count since the last `reset`.
- `push` detects a backwards PTS (`ptsUs > 0n && ptsUs + 1_000_000n < lastPtsUs`) and calls `reset()` first.

### 4.10 `LatencyOverlay` (`packages/studio/src/components/video/LatencyOverlay.tsx`, new, presentational)

```tsx
'use client'
import type { LatencySummary } from '@/lib/latency-stats'

export function LatencyOverlay({ summary }: { summary: LatencySummary }): JSX.Element
```

Renders a `<dl data-testid="latency-overlay">` absolutely positioned at the top-left of the video area (`absolute left-2 top-2 z-10 rounded-md bg-surface/90 px-2 py-1.5 text-[11px] leading-tight text-fg-muted shadow`), eight rows in this order, one `<div>` per row with `<dt>` label and `<dd className="readout">` value:

| Row label | Value format | When null |
|---|---|---|
| `device→host` | `${median} / ${p95} ms` | `estimating (${offsetSamples}/60)` |
| `host→browser` | `${median} / ${p95} ms` | `estimating (${offsetSamples}/60)` |
| `decode` | `${median} / ${p95} ms` | `–` when `n === 0` |
| `decode→paint` | `${median} / ${p95} ms` | `–` when `n === 0` |
| `queue` | `${median} / ${p95}` (frames) | `–` when `n === 0` |
| `fps` | `${fps.toFixed(1)}` | never |
| `dropped` | `${dropped}` | never |
| `keyframe requests` | `${keyframeRequests}` | never |

Below the rows, one caption line `text-[10px] text-fg-subtle`: `device→host and host→browser are relative to the fastest frame seen, not absolute. Glass-to-glass needs a camera.` Numbers are rounded with `Math.round`. No `@enkaku/ui` primitive is needed; `Tooltip` is not used (the caption is always visible, because a tooltip on a diagnostic overlay hides the one sentence that keeps its numbers honest).

### 4.11 LiveView wiring (`packages/studio/src/components/LiveView.tsx`)

- State: `const [latencyOverlay, setLatencyOverlay] = useState(() => readLocalPrefs().latencyOverlay)`; `const estimatorRef = useRef(createLatencyEstimator())`; `const [latencySummary, setLatencySummary] = useState<LatencySummary | null>(null)`.
- The renderer is created with the event callback at both creation sites (`:445` and `:518`): `createH264Renderer(canvas, (m) => setError(m), (e) => estimatorRef.current.push(e))`.
- The binary handler (`:497-532`): `const browserReceivedAt = Date.now()` first; the H.264 branch calls `renderer.decode(frame.data, frame.keyframe, frame.width, frame.height, { ptsUs: frame.ptsUs, hostReceivedAt: frame.hostReceivedAt, browserReceivedAt })`; a `lastPtsSeqRef` tracks the `seq` of the last frame with `ptsUs > 0n`, and when the next `ptsUs > 0n` frame has `seq > last + 1` the estimator gets `noteSeqGap(seq - last - 1)`. Primer frames (`ptsUs === 0n`) never touch `lastPtsSeqRef`.
- `startStream` (`:432`) calls `estimatorRef.current.reset()` after `stream.started` resolves and resets `lastPtsSeqRef`.
- The visibility keyframe (`:591-596`) calls `estimatorRef.current.noteKeyframeRequest()` beside the `ws.send`.
- A 500 ms interval, running only while `latencyOverlay && streaming && !compact`, calls `setLatencySummary(estimatorRef.current.summary(performance.now()))`; cleared on unmount and when the toggle goes off (the same start/stop discipline `useNow.ts` documents).
- Toggle: in the status line, immediately after the `click→paint` block (`:1089-1100`), `!compact && codec === 'h264'` renders `<button type="button" className="rack-label ml-auto cursor-pointer" aria-pressed={latencyOverlay} onClick={() => { const next = !latencyOverlay; setLatencyOverlay(next); writeLocalPrefs({ latencyOverlay: next }) }}>latency</button>`. If `transport === 'webrtc'` already rendered its own `ml-auto` span (`:1074`), the button drops `ml-auto`; plan 201 deletes that span anyway.
- Render: inside the video area `<div ref={videoAreaRef} ...>` (`:1145-1152`), after the `<canvas>` (`:1155`), `{!compact && latencyOverlay && latencySummary && <LatencyOverlay summary={latencySummary} />}`.
- Compact (Screens tile) never renders the overlay or the toggle; `WallTile.tsx:10` passes `compact` and is not edited.

### 4.12 Preference (`packages/studio/src/lib/prefs.ts`)

In `LocalPrefsSchema` (`prefs.ts:59`), after `pageSize` (the last field, ending at `.default(20),`, `:118`):

```ts
  /**
   * Plan 203 §4.12: whether the Device Control cast shows the latency
   * overlay. A property of the screen an operator is sitting in front of,
   * like `tileSize`, so it lives in `localStorage` and survives a new tab.
   * Off by default: it is a diagnostic, not a status readout.
   */
  latencyOverlay: z.boolean().default(false),
```

### 4.13 Bench script (`scripts/bench-device-nfrs.ts`)

Two flags added to `usage()` (`:90-104`):

```
  --latency              server-side latency leg: time to first packet, first keyframe, PTS interval, arrival jitter (needs --serial)
  --warmup               reserved for plan 206 (always-on sessions); prints a placeholder and exits 2
```

`--warmup` is checked immediately after `--help` (`:142-215`) and before the `ENKAKU_TEST_DEVICE` gate (`:146`): `console.log('warmup: not implemented in plan 203 - plan 206 (always-on sessions) fills this mode'); process.exit(2)`.

`--latency` runs inside the existing video stage (`:375-414`), using the same `session.onPacket` subscription: it records, per packet, `performance.now()` and (for `frame`/`keyframe`) `ptsUs`, then after the window prints one line, with every number an integer in ms:

```
latency: ttfp=<N> ms  first-keyframe=<N> ms  pts-interval p50=<N> ms p95=<N> ms  arrival-jitter p95=<N> ms  frames=<N>
```

where `ttfp` is session start → first packet of any kind (the existing measurement, `:407-409`), `first-keyframe` is session start → first `keyframe` packet, `pts-interval` is the distribution of consecutive PTS deltas, and `arrival-jitter` is `|Δ arrival − Δ pts|` over consecutive frames, using the file's own `percentile()` (`:123-127`). The same four numbers are pushed as rows into the results table (`:420-428`). `--latency` never changes the exit code; there is no regression bound for it yet because no baseline exists (plan 200 §3.0: a threshold is not invented).

### 4.14 File structure

```
packages/protocol/src/driver.ts                         changed  FrameMeta
packages/protocol/src/binary.ts                         changed  27-byte header
packages/protocol/src/binary.test.ts                    changed  round-trip test
packages/protocol/src/api/video.ts                      changed  VideoLatencyResponseSchema
packages/scrcpy/src/demuxer.ts                          changed  receivedAt, verified comment
packages/scrcpy/src/demuxer.test.ts                     created
packages/scrcpy/src/version.ts                          changed  verified comments
packages/scrcpy/src/control/messages.ts                 changed  verified comment
packages/scrcpy/src/session.ts                          changed  verified comment
packages/drivers/src/display/scrcpy.ts                  changed  ptsUs, hostReceivedAt
packages/drivers/src/display/screencap-loop.ts          changed  ptsUs: 0n, hostReceivedAt
packages/session/src/video-latency.ts                   created
packages/session/src/video-latency.test.ts              created
packages/session/src/manager.ts                         changed  Entry.latency, videoLatency()
packages/core/src/server/ws-handlers.ts                 changed  primer meta, counters, videoStreamStats
packages/core/src/tunnel/device-proxy.ts                changed  ptsUs: 0n, hostReceivedAt
packages/core/src/api/video.ts                          changed  GET /latency
packages/core/src/api/video.test.ts                     changed  4 tests
packages/core/src/daemon.ts                             changed  streamStats wiring
packages/studio/src/lib/h264-decoder.ts                 changed  timing, events
packages/studio/src/lib/h264-decoder.test.ts            created
packages/studio/src/lib/latency-stats.ts                created
packages/studio/src/lib/latency-stats.test.ts           created
packages/studio/src/lib/prefs.ts                        changed  latencyOverlay
packages/studio/src/lib/prefs.test.ts                   changed  1 test
packages/studio/src/components/video/LatencyOverlay.tsx created
packages/studio/src/components/video/LatencyOverlay.test.tsx created
packages/studio/src/components/LiveView.tsx             changed  wiring, toggle
packages/studio/src/components/LiveView.test.tsx        changed  frame literal, decoder mock
scripts/bench-device-nfrs.ts                            changed  --latency, --warmup
```

### 4.15 Sequence: one H.264 frame, instrumented

```
phone MediaCodec ──pts──▶ scrcpy-server 3.3.1 ──adb forward──▶ demuxer.push(chunk)      receivedAt = Date.now()
  ▶ onPacket({ kind, ptsUs, receivedAt, data })
  ▶ ScrcpyDisplay.cb(data, { ..., ptsUs, hostReceivedAt: receivedAt })
  ▶ session.display.onFrame → deps.onFrame → dispatchFrame(key): entry.latency.record(meta); fan-out
  ▶ ws-handlers binding.onFrame: backpressure (counters) → encodeVideoFrame (27-byte header) → ws.send
  ▶ browser ws.onBinary: browserReceivedAt = Date.now(); decodeVideoFrame → renderer.decode(..., timing)
      submittedAt = performance.now(); queueSize = decoder.decodeQueueSize; chunk.timestamp = Number(ptsUs)
  ▶ VideoDecoder.output(frame): outputAt; drawImage; frame.close(); rAF → paintedAt
  ▶ onEvent({ kind: 'decoded', ... }) → estimator.push → overlay (500 ms tick)
```

## 5. Implementation steps

Every step: read the cited lines first, match on content (line numbers are as of 2026-09-03), and run only the test file the step names.

### 203.1 Verify the scrcpy byte layouts against the pinned source

- **Files created**: none in the repo. Download to the scratchpad only.
- **Files changed**: `packages/scrcpy/src/version.ts`, `packages/scrcpy/src/demuxer.ts`, `packages/scrcpy/src/control/messages.ts`, `packages/scrcpy/src/session.ts` (comments only).
- **Files deleted**: none.
- **Test file**: none (comments). `bun test packages/scrcpy/src/session.test.ts` afterwards, because `session.ts` is touched.
- **Procedure**:
  1. `curl -L -o "$SCRATCH/scrcpy-v3.3.1.tar.gz" https://github.com/Genymobile/scrcpy/archive/refs/tags/v3.3.1.tar.gz && tar -xzf "$SCRATCH/scrcpy-v3.3.1.tar.gz" -C "$SCRATCH"` where `$SCRATCH` is the session scratchpad directory. The tree root is `scrcpy-3.3.1/`, the Java sources under `server/src/main/java/com/genymobile/scrcpy/`.
  2. Read `control/ControlMessage.java`: the `TYPE_*` constants must equal `CONTROL_MSG` in `version.ts:30-49` in name and value, 0 through 17 (`INJECT_KEYCODE` = 0 … `RESET_VIDEO` = 17). Any other value, missing name, or extra name below 17 is a mismatch.
  3. Read `control/ControlMessageReader.java`: the byte layouts of `parseInjectKeycode` (u8 action, u32 keycode, u32 repeat, u32 metaState: 14 bytes with the type byte), `parseInjectText` (u32 length, UTF-8), `parseInjectTouchEvent`, `parseUhidCreate`, `parseUhidInput`, `parseSetClipboard`, `parseGetClipboard` must match the encoders in `control/messages.ts` (`encodeInjectKeycode` at `:10-19`, `encodeInjectText` `:21-29`, `encodeInjectTouch` `:41`, `encodeUhidCreate` `:80`, `encodeResetVideo` `:121-123`, `encodeGetClipboard` `:134-136`, `encodeSetClipboard` `:147`). Compare field by field and width by width.
  4. Read `device/DeviceMessage.java`: `TYPE_CLIPBOARD` = 0, `TYPE_ACK_CLIPBOARD` = 1, `TYPE_UHID_OUTPUT` = 2 must match `DEVICE_MSG_TYPE` in `control/device-messages.ts:26` and the layouts documented at `:12-19`.
  5. Read `device/Streamer.java` (if the file is elsewhere, `grep -rn "PACKET_FLAG_CONFIG" scrcpy-3.3.1/server/src`): `PACKET_FLAG_CONFIG = 1L << 63`, `PACKET_FLAG_KEY_FRAME = 1L << 62`, the 12-byte frame header (u64 pts-and-flags, u32 size) and the 12-byte codec metadata (u32 codec id, u32 width, u32 height) must match `demuxer.ts:11-15` and `:18-20`. Also record whether the PTS written is the raw MediaCodec `presentationTimeUs` or is rebased to an origin at the first packet (search for `ptsOrigin`): write the finding into the demuxer comment (§4.3), because §4.9's estimator does not care which, but the next reader will.
  6. Read `device/DesktopConnection.java` (`grep -rn "DEVICE_NAME_FIELD_LENGTH" scrcpy-3.3.1/server/src`): the dummy byte on `tunnel_forward`, the 64-byte NUL-padded device name, and the socket connect order (video, then audio if enabled, then control) must match `demuxer.ts:8-9` and `session.ts:151-155`.
  7. Read `video/VideoCodec.java` (or wherever `grep -rn "0x68323634"` lands): the codec ids must match `CODEC_ID` in `version.ts:23-27`.
  8. Find the API guard for UHID (`grep -rn "UHID" scrcpy-3.3.1/server/src/main/java/com/genymobile/scrcpy/control/*.java | grep -i "VERSION\|SDK_INT\|Build"`): the minimum must be API 29 (`Build.VERSION_CODES.Q`), matching `UHID_MIN_API = 29` (`version.ts:20`, plan 200 R2).
  9. For each confirmed item, replace the marker text with `verified against v3.3.1 <file> on 2026-09-DD` (the real date), keeping the rest of the comment: `version.ts:18` and `:29`, `demuxer.ts:6-7`, `control/messages.ts:5`, `session.ts:154-155`. The `TODO-verify` in `version.ts:8` is prose about the rule itself ("every TODO-verify assumption in this package must be re-checked"); reword it to "every `verified against` line in this package must be re-checked against the new release's source" so the grep in §0 G10 reaches zero.
- **Verifiable result**: `rg -n "TODO-verify" packages/scrcpy` → empty; `rg -n "verified against v3.3.1" packages/scrcpy/src` → 5 matches; `bun test packages/scrcpy/src/session.test.ts` passes.
- **Do not**: change any constant to "fix" a mismatch. If any item in steps 2 to 8 does not match, stop this step, leave the marker in place, and report the exact file, line, expected value and found value under §9 Q1 in the handoff. Do not read the jar, only the source tag; do not upgrade the pin.

### 203.2 `FrameMeta`: `ptsUs` and `hostReceivedAt` replace `capturedAt`

- **Files changed**: `packages/protocol/src/driver.ts` (§4.1), `packages/drivers/src/display/scrcpy.ts:68-77`, `packages/drivers/src/display/screencap-loop.ts:60`, `packages/core/src/server/ws-handlers.ts:1080-1087`, `packages/core/src/tunnel/device-proxy.ts:81-88`, `packages/protocol/src/binary.test.ts:28`, `packages/studio/src/components/LiveView.test.tsx:636`.
- **Files deleted**: none.
- **Test file**: `bun test packages/protocol/src/binary.test.ts` (it will fail until 203.4; run it after 203.4).
- **Detail**: the `scrcpy.ts` producer cannot be completed until 203.3 gives packets a `receivedAt`; do 203.3 in the same commit. The `LiveView.test.tsx:636` literal (`{ codec: 'h264', keyframe: true, width: 1080, height: 2400, seq: 0 }`) has no `capturedAt` today and still runs; after 203.4 `encodeVideoFrame` calls `setBigUint64(11, meta.ptsUs)` and an `undefined` there throws at runtime, so add `ptsUs: 0n, hostReceivedAt: 0` to it.
- **Verifiable result**: `rg -n "capturedAt" packages/protocol/src/driver.ts packages/drivers/src packages/session/src packages/core/src/server packages/core/src/tunnel packages/studio/src` → empty. (`packages/core/src/device/awake-policy.ts` and `packages/protocol/src/power.ts` have their own unrelated `capturedAt`; they are outside this grep on purpose and must not be touched.)
- **Do not**: keep `capturedAt` as an optional alias; add a `hostReceivedAt ?? capturedAt` fallback anywhere.

### 203.3 Demuxer stamps `receivedAt`

- **Files changed**: `packages/scrcpy/src/demuxer.ts` (§4.3).
- **Files created**: `packages/scrcpy/src/demuxer.test.ts`.
- **Test file**: `bun test packages/scrcpy/src/demuxer.test.ts`.
- **Tests** (build the bytes by hand: one dummy byte, a 64-byte name, the 12-byte meta, then frames; use `now: () => clock` with a mutable `clock`):
  1. `parses the meta header and reports codec, width and height` (`h264`, 1080, 2400).
  2. `a config packet carries receivedAt and no ptsUs` (flags bit 63 set).
  3. `a keyframe and a delta carry ptsUs and the receivedAt of the push that completed them` (bit 62 set / clear; push the header in one chunk and the payload in a second chunk with `clock` advanced; `receivedAt` must equal the second push's clock).
  4. `frames split across three chunks are reassembled unchanged` (byte-equal payload).
- **Verifiable result**: 4 tests pass; `bun run typecheck` clean (the session file's `onPacket` consumers compile because the new field is additive on the packet type).
- **Do not**: replace the buffer-copy in `push()` (`:65-71`) with a ring buffer; that is plan 209.

### 203.4 The 27-byte header

- **Files changed**: `packages/protocol/src/binary.ts` (§4.2), `packages/protocol/src/binary.test.ts`.
- **Test file**: `bun test packages/protocol/src/binary.test.ts`.
- **Tests added**:
  1. `round-trips ptsUs and hostReceivedAt through the 27-byte header`: encode `{ codec: 'h264', keyframe: true, width: 1080, height: 2400, seq: 7, ptsUs: 123_456_789_012n, hostReceivedAt: 1_756_900_000_123 }` with a 5-byte payload; assert `frame.length === 32`, and every decoded field equals its input, `data` byte-equal.
  2. `a frame of exactly 27 bytes decodes with an empty payload; 26 throws`.
  3. `a PNG frame with ptsUs 0n decodes to 0n` (the no-device-clock rule of §3.2 D3).
- **Verifiable result**: `bun test packages/protocol/src/binary.test.ts` → all pass, including the existing snapshot tests.
- **Do not**: add a header version byte; accept an 11-byte frame; move the new fields anywhere but bytes 11..26.

### 203.5 Session-side tracker and `videoLatency()`

- **Files created**: `packages/session/src/video-latency.ts`, `packages/session/src/video-latency.test.ts` (§4.5).
- **Files changed**: `packages/session/src/manager.ts` (`Entry` at `:14-56`, `createEntry` where the entry literal is built after `:535`, `dispatchFrame` `:452-456`, the `SessionManager` interface after `videoStats?()` `:230-235`, the implementation after `videoStats()` `:974-999`).
- **Test file**: `bun test packages/session/src/video-latency.test.ts`.
- **Tests**:
  1. `firstFrameMs is measured from startedAt to the first record`.
  2. `PTS interval and arrival jitter are computed only between ptsUs > 0n frames` (three frames at pts 0n, 33_333n, 66_666n with hostReceivedAt 1000, 1033, 1070 → interval p50 33, jitter p95 4).
  3. `a backwards PTS resets the chain without pushing a sample`.
  4. `the ring holds at most 128 samples`.
- **Verifiable result**: 4 tests pass; `bun test packages/session/src/manager.test.ts` still passes (its fixtures build `SessionManager`-shaped objects and the new method is optional).
- **Do not**: make `videoLatency` required on `SessionManager`; the fixtures across `packages/core` do not implement it (the same reason `videoStats` is optional, `manager.ts:225-229`).

### 203.6 Stream counters and the route

- **Files changed**: `packages/core/src/server/ws-handlers.ts` (§4.6), `packages/core/src/api/video.ts` (§4.7), `packages/core/src/api/video.test.ts`, `packages/core/src/daemon.ts:3124` and the forward-ref declaration beside `transportStats`, `packages/protocol/src/api/video.ts`.
- **Test file**: `bun test packages/core/src/api/video.test.ts`, then `bun test packages/core/src/server/` (the directory touched; expect it to take a few minutes, run it once).
- **Tests added to `video.test.ts`** (reuse its `withUser` helper, `:7-15`):
  1. `GET /latency without deviceId is 400 E_BAD_REQUEST`.
  2. `GET /latency with no sessions is 501 E_NOT_SUPPORTED`.
  3. `GET /latency joins the session snapshot with the stream counters per quality` (fixture `videoLatency: () => [{ quality: 'control', viewers: 1, frames: 10, firstFrameMs: 120, ptsIntervalMsP50: 33, ptsIntervalMsP95: 40, arrivalJitterMsP95: 3, lastFrameAgeMs: 12 }]`, `streamStats: () => [{ quality: 'control', keyframeRequests: 2, congestionDrops: 5 }]`; assert the merged row and `VideoLatencyResponseSchema.parse(body)` succeeds).
  4. `an operator may read it (device.view), unauthenticated is 403`.
- **Verifiable result**: 4 new tests pass; existing 5 pass; `curl -s 'localhost:7700/api/video/latency?deviceId=x'` on a running `bun run dev` returns `{"deviceId":"x","at":<ms>,"streams":[]}`.
- **Do not**: add the numbers to `GET /api/adb/stats` (`adb-stats.ts`) as well; one route owns them. Do not persist anything.

### 203.7 Decoder timing and events

- **Files changed**: `packages/studio/src/lib/h264-decoder.ts` (§4.8), `packages/studio/src/components/LiveView.test.tsx:73-76` (the `createH264Renderer` mock keeps its shape: the third argument is optional, so no change is required unless the executor asserts on it).
- **Files created**: `packages/studio/src/lib/h264-decoder.test.ts`.
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Test harness**: `import '../../happydom'` first (the file sits in `src/lib/`, so two levels up). Define on `globalThis` a `VideoDecoder` stub class recording `configure()` calls, storing the `output` callback, exposing `decodeQueueSize = 0`, and pushing every `decode(chunk)` into a `chunks` array; and an `EncodedVideoChunk` stub that keeps `{ type, timestamp, data }`. Use a real `document.createElement('canvas')` (happy-dom's `getContext('2d')` may return null; `ctx?.drawImage` is already guarded). Feed an SPS+PPS config packet (`[0,0,0,1,0x67,0x42,0xe0,0x1e, 0,0,0,1,0x68,0xce]`) then an IDR (`[0,0,0,1,0x65,1,2,3]`).
- **Tests**:
  1. `a chunk is timestamped with Number(ptsUs)` (pts 33_333n → `chunks[0].timestamp === 33333`).
  2. `ptsUs 0n gets lastTimestampUs + 1` (after the first, a second IDR with `0n` → `33334`).
  3. `a decoded event pairs output with its submission and reports paintedAt from requestAnimationFrame` (call the stored `output` with `{ displayWidth: 2, displayHeight: 2, timestamp: 33333, close() {} }`; await one animation frame via `await new Promise((r) => requestAnimationFrame(r))`; assert one `decoded` event with `ptsUs === 33333n`, `outputAt >= submittedAt`, `paintedAt >= outputAt`). A delta before any keyframe yields `{ kind: 'dropped', reason: 'awaiting-keyframe' }`.
- **Verifiable result**: 3 tests pass; `bun test packages/studio/src/components/LiveView.test.tsx` still passes.
- **Do not**: add `hardwareAcceleration`, change `optimizeForLatency`, move `drawImage` into the animation frame, or read `decodeQueueSize` to drop frames. Observe only.

### 203.8 Estimator

- **Files created**: `packages/studio/src/lib/latency-stats.ts`, `packages/studio/src/lib/latency-stats.test.ts` (§4.9; no DOM needed, no happydom import).
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Tests**:
  1. `deviceToHost is null until 60 ptsUs > 0n samples, then min-anchored` (feed 60 events with `hostReceivedAt - pts/1000` varying between 100 and 120 → after the 60th, median of the window ≤ 20 and the fastest sample reads 0).
  2. `hostToBrowser is min-anchored over the first 60 samples`.
  3. `decode and decodeToPaint are absolute` (one event with submittedAt 10, outputAt 14, paintedAt 30 → decode median 4, decodeToPaint median 16).
  4. `dropped counts dropped events plus seq gaps; keyframeRequests counts notes; reset clears all`.
  5. `a PTS that goes back by more than one second resets the offsets`.
- **Verifiable result**: 5 tests pass.
- **Do not**: use a mean where the plan says median; use `Date.now()` for `fps` (it is `performance.now()`-based like `paintedAt`).

### 203.9 `LatencyOverlay`

- **Files created**: `packages/studio/src/components/video/LatencyOverlay.tsx`, `packages/studio/src/components/video/LatencyOverlay.test.tsx` (§4.10; `import '../../../happydom'` first, `afterEach(cleanup)` as `DeviceVideoFields.test.tsx:1-10` does).
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Tests**:
  1. `renders all eight rows in order with formatted values` (a full summary; assert `screen.getByText('device→host')`, and the `dd` for `decode` reads `4 / 9 ms`).
  2. `shows "estimating (12/60)" while an offset is null`.
  3. `always shows the caption that the two network legs are relative`.
- **Verifiable result**: 3 tests pass.
- **Do not**: fetch anything, subscribe to the WS, or import `LiveView`. The component takes a summary and renders it.

### 203.10 Preference

- **Files changed**: `packages/studio/src/lib/prefs.ts` (§4.12), `packages/studio/src/lib/prefs.test.ts` (one test: `round-trips latencyOverlay` and `defaults to false`).
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Verifiable result**: the new test passes; `readLocalPrefs().latencyOverlay === false` on an empty store.
- **Do not**: put it in `SessionPrefsSchema`; the module's own comment (`prefs.ts:3-25`) explains why that store is per tab.

### 203.11 LiveView wiring and toggle

- **Files changed**: `packages/studio/src/components/LiveView.tsx` (§4.11).
- **Test file**: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- **Verifiable result**: the existing tests and the new one pass; with `bun run dev` and `bun run dev:studio`, opening a device's control view and clicking `latency` shows the overlay, a reload keeps it, and a Screens tile never shows it.
- **Do not**: add a keyboard shortcut (MVP 08's hotkey table belongs to plan 215); render the overlay in `compact`; poll `/api/video/latency` from LiveView (the route is for curl and the bench, not the browser, in this plan).

### 203.12 Bench script flags

- **Files changed**: `scripts/bench-device-nfrs.ts` (§4.13).
- **Test file**: none (no test covers this script today; say so in the report). Verification is by running it.
- **Verifiable result**: `bun run scripts/bench-device-nfrs.ts --warmup; echo $?` prints the placeholder line and `2` without touching adb; `bun run scripts/bench-device-nfrs.ts --help` lists both flags; with the lab device, `ENKAKU_TEST_DEVICE=1 bun run bench:device-nfrs -- --serial <S> --latency --skip-inspector` prints the `latency:` line (owner, G12).
- **Do not**: implement warm-up timing; add a regression bound for the latency numbers.

### 203.13 The H-9 experiment (owner, lab device)

Procedure, run on one device on a LAN, Studio in Chromium, the device showing a running millisecond stopwatch (continuous motion keeps the encoder producing frames at its cap):

```bash
# 1. shipped default: 30 fps (packages/session/src/video-profile.ts:14, `sharp`)
curl -s -X PATCH localhost:7700/api/settings -H 'content-type: application/json' -d '{"video":{"controlMaxFps":30}}' >/dev/null
curl -s -X POST localhost:7700/api/video/reprofile
# 2. open the device's control view, click `latency`, wait until both network rows stop saying "estimating", then wait 60 s more
# 3. read the overlay; also:
curl -s 'localhost:7700/api/video/latency?deviceId=<id>'
# 4. repeat at 60 fps
curl -s -X PATCH localhost:7700/api/settings -H 'content-type: application/json' -d '{"video":{"controlMaxFps":60}}' >/dev/null
curl -s -X POST localhost:7700/api/video/reprofile
# 5. restore
curl -s -X PATCH localhost:7700/api/settings -H 'content-type: application/json' -d '{"video":{"controlMaxFps":30}}' >/dev/null
curl -s -X POST localhost:7700/api/video/reprofile
```

`PATCH /api/settings` shallow-merges the `video` section (`packages/core/src/settings/farm-settings.ts:47-63`); `controlMaxFps` accepts 5..60 (`packages/protocol/src/settings.ts:2121-2128`). In `local` auth mode (a loopback bind, `docs/guide/install.md:50`) no token is needed. The reprofile restarts the control session (`packages/core/src/api/video.ts:32-39`); the overlay resets on the new `stream.started`.

Results (owner fills; medians from the overlay, `ptsIntervalMsP50` from the route):

| Row | 30 fps | 60 fps | Delta |
|---|---|---|---|
| overlay `device→host` median (ms) | | | |
| overlay `decode→paint` median (ms) | | | |
| route `ptsIntervalMsP50` (ms) | | | |
| overlay `fps` | | | |
| overlay `queue` median (frames) | | | |
| device model / Android / host / browser | | | |

Reading, per plan 100 H-9 (`docs/plans/100-*.md` line 530): if the sum of the overlay medians falls by roughly one frame interval (about 17 ms) when the interval halves, the encoder frame interval dominates; if it barely moves, the browser does. Write the reading as one sentence under the table.

### 203.14 Camera-and-stopwatch glass-to-glass (owner, lab device, camera)

The procedure, quoted from `docs/plans/08-m6-scrcpy.md:541-546` (Indonesian in the original; the one dash in item 3 is rendered as a hyphen here):

> **Glass-to-glass < 150 ms (LAN):**
> 1. Di device, tampilkan stopwatch milidetik (app clock dengan centiseconds, atau halaman web `requestAnimationFrame` timer di Chrome Android).
> 2. Letakkan device fisik bersebelahan dengan monitor yang menampilkan Studio device-view.
> 3. Foto keduanya dalam SATU frame kamera (mode shutter cepat, atau video 240 fps lalu ambil frame) - selisih angka stopwatch device vs stopwatch di video Studio = glass-to-glass.
> 4. Ambil ≥ 10 sampel, laporkan median + p95. Lulus: median < 150 ms.
> 5. Pelengkap (bukan pengganti): stats-overlay menampilkan `t_core→render` (timestamp core saat kirim, disinkronkan kasar via WS ping, vs `performance.now()` render) untuk debugging regresi - angka acceptance tetap dari metode kamera.

In English: show a millisecond stopwatch on the device (a clock app with centiseconds, or a web page with a `requestAnimationFrame` timer in Chrome Android); put the device beside the monitor showing the Studio control view; photograph both in ONE camera frame (fast shutter, or 240 fps video and pick a frame); the device's stopwatch value minus the value visible in the Studio picture is glass-to-glass; take at least 10 samples, report median and p95; the overlay is a complement for regression debugging, never the acceptance number.

Results (owner fills, milliseconds):

| # | Device reads | Studio reads | Glass-to-glass |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |
| median | | | |
| p95 | | | |
| device model / Android / host / browser / camera fps | | | |

Rule: the median goes into `docs/mvp/01-casting-latency.md` §4 step 1 ("Exit criterion: a median glass-to-glass figure on LAN, recorded in this document") and, if the owner keeps the target, into `docs/spec.md:1103`'s Notes column, **only after it is measured**, and only by the owner. The executing agent writes no number anywhere. Whether `< 150 ms` stays the target is §9 Q2.

## 6. Acceptance criteria

1. G1 to G11, G15 and G16 in §0 are checked with the exact commands shown.
2. `rg -n "performance.now\(\) \* 1000" packages/studio/src/lib/h264-decoder.ts` → empty.
3. `rg -n "VIDEO_HEADER_LEN = 11" packages/protocol/src/binary.ts` → empty; `rg -n "VIDEO_HEADER_LEN = 27" packages/protocol/src/binary.ts` → 1 match.
4. A frame sent by the core decodes in Studio: on `bun run dev` plus `bun run dev:studio` with any device, a control view paints, the fps readout moves, and the browser console shows no `frame too short` error.
5. The overlay's two network rows show `estimating (n/60)` for the first 60 device-clocked frames and numbers afterwards; `decode` and `decode→paint` show numbers from the first paint.
6. `curl -s 'localhost:7700/api/video/latency?deviceId=<id>'` while a control view is open returns one `streams` row with `quality: "control"`, `frames > 0`, `firstFrameMs` not null.
7. `docs/plans/203-mvp-latency-measurement.md` §5 step 203.13 and 203.14 hold tables the owner can fill without reading any code.
8. G12, G13, G14 are `owner` rows; the plan's status may be `implemented (software)` with them open (plan 200 §3.0).
9. `bash scripts/check-plan-status.sh` passes with this plan's status line updated.

## 7. Test plan

Unit, one invocation at a time, never concurrently, never a bare `bun test`:

Amended by §12 (this line corrects §7 itself, which the amendment did not edit in place): the five `bun test packages/studio/...` lines below are removed — Studio has zero tests (plan 200 §8.3) — and `bun test packages/protocol/src/video-latency.test.ts` is added for the estimator, moved there by §12.

```bash
bun test packages/protocol/src/binary.test.ts
bun test packages/protocol/src/video-latency.test.ts
bun test packages/scrcpy/src/demuxer.test.ts
bun test packages/scrcpy/src/session.test.ts
bun test packages/session/src/video-latency.test.ts
bun test packages/session/src/manager.test.ts
bun test packages/core/src/api/video.test.ts
bun test packages/core/src/server/                       # the directory ws-handlers.ts lives in; once
bun test packages/protocol/src/video-latency.test.ts
bun run typecheck
```

Manual smoke, no device:

```bash
bun run scripts/bench-device-nfrs.ts --warmup; echo "exit=$?"     # placeholder line, exit=2
bun run dev &                                                     # then:
curl -s 'localhost:7700/api/video/latency'                        # 400 E_BAD_REQUEST
curl -s 'localhost:7700/api/video/latency?deviceId=nope'          # {"deviceId":"nope","at":...,"streams":[]}
kill %1
ps -Ao pid=,command= | grep -i "[o]penpf"                          # nothing
```

Device tests (`ENKAKU_TEST_DEVICE=1`, owner):

```bash
ENKAKU_TEST_DEVICE=1 bun run bench:device-nfrs -- --serial <S> --latency --skip-inspector
```

then §5 step 203.13 and 203.14.

## 8. Risks and mitigations

- **A byte-layout mismatch found in 203.1.** The plan stops that step and reports (§9 Q1). Nothing in 203.2 onward depends on 203.1, so the rest still lands; the marker stays until the owner decides.
- **The 16 extra header bytes on the wall path.** At `wall balanced` (18 fps) that is 288 B/s per tile, against a 1.1 Mbit/s stream. Negligible; `MAX_BUFFERED` is unchanged.
- **`setBigUint64` with a non-bigint.** Any producer that forgets `ptsUs` throws at encode time, loudly, in the first frame. The `LiveView.test.tsx:636` literal is the known case and 203.2 fixes it; `bun run typecheck` catches the rest because `ptsUs` is required on `FrameMeta`.
- **WebCodecs rejects a non-monotonic timestamp.** The `lastTimestampUs + 1` substitution for `0n` keeps the sequence monotonic; a backwards device PTS (encoder restart) is possible only across a `stream.started`, which recreates the decoder.
- **The `pending` map in the decoder leaks when the decoder drops output.** Bounded at 300 entries (§4.8 rule 2).
- **Min-anchoring is misread as an absolute number.** The overlay's caption states it on every render (§4.10), and G14's camera number is the only absolute figure the plan admits.
- **The per-500 ms `setState` on LiveView adds render work to the control view.** Only while the overlay is on, which defaults to off; a Screens tile never runs it.
- **`bun test packages/core/src/server/` is slow.** Run once, alone, after the ws-handlers edit; it is the directory touched, which CLAUDE.md permits.

## 9. Open questions

1. **If 203.1 finds a constant or layout that disagrees with v3.3.1's source, what is the fix?** The executor stops and reports the exact mismatch; the owner decides whether the encoder, the pin, or the comment is wrong. (Plan 200 R1's caveat.)
2. **Does the spec's `< 150 ms` glass-to-glass target stay after G14 produces a number?** `docs/mvp/01` §6 item 3 leaves this to the owner; plan 202 (spec rewrite) needs the answer.
3. **Which device is the lab device for G12 to G14?** `docs/mvp/16` §4 item 3: an Android 16 device is preferred and not yet in hand.

## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| `FrameMeta.capturedAt` | `packages/protocol/src/driver.ts:29` and its five producers (`drivers/src/display/scrcpy.ts:73`, `drivers/src/display/screencap-loop.ts:60`, `core/src/server/ws-handlers.ts:1085`, `core/src/tunnel/device-proxy.ts:86`, `protocol/src/binary.test.ts:28`) | `rg -n "capturedAt" packages/protocol/src/driver.ts packages/drivers/src packages/session/src packages/core/src/server packages/core/src/tunnel packages/studio/src` → empty |
| The 11-byte video header | `packages/protocol/src/binary.ts:36` | `rg -n "VIDEO_HEADER_LEN = 11" packages/protocol/src` → empty |
| Wall-clock chunk timestamps | `packages/studio/src/lib/h264-decoder.ts:142` | `rg -n "performance.now\(\) \* 1000" packages/studio/src/lib` → empty |
| `TODO-verify` markers (MVP 13 B.1 "Small items": "closed by MVP 01 step 1") | `packages/scrcpy/src/version.ts:8,18,29`, `demuxer.ts:6`, `control/messages.ts:5`, `session.ts:154` | `rg -n "TODO-verify" packages/scrcpy` → empty |
| Vocabulary (plan 200 §2.4) in the files this plan creates: `device page`, `popup`, `modal`, `lease`, `wall` in UI copy | new files only | `rg -n -i "device page\|popup\|modal\|lease" packages/studio/src/components/video/LatencyOverlay.tsx packages/studio/src/lib/latency-stats.ts packages/session/src/video-latency.ts` → empty |

No MVP 13 Part A row belongs to this plan.

## 11. Handoff report

- **Branch**: `worktree-agent-a0fa701d0fd700f3a` (this worktree's own branch; not `mvp` — merge into `mvp` from here). Started at `d96d2be` (`feat(tiktok-pack): search-keyword, keyword-videos, live-browse, shop-browse, notification-activity; verified jittered gestures; v1.15.0`).
- **Checklist**: G1 ✅ G2 ✅ G3 ✅ G4 ⏳ owner (implemented, needs a lab device to exercise) G5 ✅ G6 ⏳ owner (implemented, needs a lab device to exercise) G7 ⏳ owner (implemented, needs a lab device — the toggle only renders once codec is h264) G8 ✅ G9 ✅ G10 ✅ G11 ✅ G12 ⏳ owner (lab device) G13 ⏳ owner (lab device) G14 ⏳ owner (lab device, camera) G15 ✅ G16 ✅
- **Commits**: `df47b3b` — `feat(mvp-203): device PTS end to end, the latency overlay, server-side stats, bench --latency/--warmup`; `5b153a6` — `docs(mvp-203): status implemented (software), §0/§7 corrected, §11 handoff report` (this plan's own status-line/§0/§7 edits and this report).
- **Typecheck**: clean — `bun run typecheck` (`bash scripts/typecheck.sh`), all 20 packages/plugins/examples report `OK`.
- **Tests run**:
  - `bun test packages/protocol/src/binary.test.ts` → 9 pass, 0 fail (includes the 3 new 27-byte-header tests from step 203.4).
  - `bun test packages/protocol/src/video-latency.test.ts` → 5 pass, 0 fail (the estimator, moved here by §12).
  - `bun test packages/protocol/src/export-uniqueness.test.ts` → 3 pass, 0 fail (no name collision from the new export).
  - `bun test packages/scrcpy/src/demuxer.test.ts` → 4 pass, 0 fail (new).
  - `bun test packages/scrcpy/src/session.test.ts` → 21 pass, 0 fail (re-run after the verified-comment edits touched this file).
  - `bun test packages/session/src/video-latency.test.ts` → 4 pass, 0 fail (new).
  - `bun test packages/session/src/manager.test.ts` → 49 pass, 0 fail (existing fixtures still satisfy the required `Entry.latency` field and optional `videoLatency`).
  - `bun test packages/core/src/api/video.test.ts` → 10 pass, 0 fail (5 new: 400, 501, join, zero-counters, permission; 5 pre-existing `/reprofile` tests untouched).
  - `bun test packages/core/src/server/` → 155 pass, 0 fail across 18 files, run once, alone (the directory `ws-handlers.ts` lives in).
  - Manual smoke: `bun run scripts/bench-device-nfrs.ts --warmup; echo $?` → prints the placeholder line, then `2`, with no adb touched. `bun run scripts/bench-device-nfrs.ts --help` lists both new flags. A core started on a scratch data dir (port 7799, to avoid a port already held by another agent's worktree on 7700) answered `GET /api/video/latency` (no `deviceId`) with `400 E_BAD_REQUEST`, and `GET /api/video/latency?deviceId=nope` with `{"deviceId":"nope","at":<ms>,"streams":[]}` once adb finished provisioning — exactly the plan's own expected output. The core was killed and its scratch data dir removed afterward.
  - Not run: `bun test` (bare, forbidden); anything under `packages/studio` or `packages/ui` (zero tests by decision, plan 200 §8.3); the `ENKAKU_TEST_DEVICE=1` device tests (no lab device in this environment).
- **Removed, proven**:
  - `rg -n "capturedAt" packages/protocol/src/driver.ts packages/drivers/src packages/session/src packages/core/src/server packages/core/src/tunnel packages/studio/src` → empty (the one hit found mid-work was a doc comment naming the old field historically; reworded so the grep is genuinely empty, not just "no live reference").
  - `rg -n "VIDEO_HEADER_LEN = 11" packages/protocol/src` → empty.
  - `rg -n "performance.now\(\) \* 1000" packages/studio/src/lib` → empty.
  - `rg -n "TODO-verify" packages/scrcpy` → empty; `rg -n "verified against v3.3.1" packages/scrcpy/src` → 5 matches (`version.ts` ×2, `demuxer.ts`, `control/messages.ts`, `session.ts`).
  - Vocabulary check (new files only): `rg -n -i "device page|popup|modal|lease" packages/studio/src/components/video/LatencyOverlay.tsx packages/protocol/src/video-latency.ts packages/session/src/video-latency.ts` → empty.
- **Discrepancies between plan and code**:
  - **Two files share the name `video-latency.ts` on purpose, in two different packages, for two different things.** `packages/session/src/video-latency.ts` is the §4.5 session-side PTS tracker (frames/firstFrameMs/PTS-interval/jitter, fed by `manager.ts`'s `dispatchFrame`, exposed as `SessionManager.videoLatency()`). `packages/protocol/src/video-latency.ts` is the §4.9/§12 pure browser-side estimator (`createLatencyEstimator`/`LatencySummary`, exported from `@enkaku/protocol`). Neither the original §4.5/§4.9 text nor §12's amendment says this explicitly — §12 only says the estimator moves "from `packages/studio/src/lib/latency-stats.ts`", without naming the session-side file's own path as a potential point of confusion — so it is recorded here for the next reader. No collision: different packages, different exports, `export-uniqueness.test.ts` passes.
  - **BigInt literal syntax is unusable in `packages/protocol` and `packages/studio`.** Not stated anywhere in the plan. Studio's standalone tsconfig targets ES2017 (Next's own requirement) and `@enkaku/protocol`'s `package.json` `exports` points straight at `src/index.ts` — so Studio's own `bunx tsc -p packages/studio` typechecks `packages/protocol`'s source directly, and a bare `0n`/`1_000_000n` literal in that source fails with `TS2737: BigInt literals are not available when targeting lower than ES2020`. `packages/protocol/src/video-latency.ts` and `packages/studio/src/lib/h264-decoder.ts` both write `BigInt(0)` instead of `0n` for this reason; `packages/session`, `packages/scrcpy`, `packages/core` (not reachable from Studio's typecheck) keep ordinary bigint literals, matching the existing style in those packages (`demuxer.ts`'s `1n << 63n`, `version.ts`'s `-1n`).
  - **§7's own test list disagreed with §12's amendment** (five `bun test packages/studio/...` lines never removed, the moved estimator's test never added). Corrected in this same handoff, in §7 itself, since a reader following §7 verbatim would have tried to run five files plan 200 §8.3 forbids writing at all.
  - **`packages/core/src/api/video.test.ts`'s new-test count**: the plan's own §0 G8 row says "4 new tests"; 5 were written (400, 501, join, a `zero counters — never undefined` case the plan's step 203.6 test list did not itemize but which the response schema's `.int()` fields make worth asserting directly, and the permission/auth pair). Recorded here per §2.2's "the file wins for facts" rule.
- **Observed, not done** (deliberately left, not built):
  - The `owner` rows: G12 (bench `--latency` server-side numbers on a lab device), G13 (the H-9 30-vs-60fps experiment, §5 step 203.13's table), G14 (the camera-and-stopwatch glass-to-glass procedure, §5 step 203.14's table). No lab device exists in this environment; the instruments (the bench flag, the overlay, the route) are built and the tables in §5 are left blank for the owner to fill, exactly as the plan requires. No number was written into `docs/mvp/01-casting-latency.md` or `docs/spec.md` — both are untouched (`git diff --stat` confirms).
  - An owner smoke on the lab device (per §12's replacement for the dropped Studio tests: "open Device Control, toggle the overlay, confirm all eight rows show numbers within 5s, confirm device→host stays within ±20ms of its own median over 60s on a static screen, confirm decode→paint is below 16ms at 30fps") was not run, for the same no-device reason.
- **Open questions hit**: none. §9's three questions (a byte-layout mismatch's fix, whether the `< 150ms` target survives G14's number, which device is the lab device) were none of them reached — step 203.1 found no mismatch against the pinned v3.3.1 source, and G14/the target question are explicitly the owner's to decide after a measurement that has not happened yet.
- **Processes**: `ps -Ao pid=,command= | grep -i "[o]penpf"` → no output (nothing running). The scratch-port core (port 7799, `.dev-data-plan203`) used for the manual smoke test was killed and its data dir removed before this check.


---

## 12. Amendment 2026-09-03 — testing policy (plan 200 §8.3)

Studio has zero tests. This amendment overrides every Studio test named above; the executor follows it instead of the original step text where they differ.

- **Moves**: the pure estimator `latency-stats.ts` (§4.9) is created at `packages/protocol/src/video-latency.ts` instead of `packages/studio/src/lib/latency-stats.ts`, exported from `@enkaku/protocol`, and imported by the overlay. Its test is `packages/protocol/src/video-latency.test.ts` (same cases as §4.9). This is on plan 200 §8.3's critical list (protocol contract) and is the only browser-side logic this plan tests.
- **Dropped**: `packages/studio/src/lib/h264-decoder.test.ts`, `packages/studio/src/components/video/LatencyOverlay.test.tsx`, the `prefs.test.ts` change, and every `LiveView.test.tsx` change. Do not create or edit them. If `LiveView.test.tsx` still exists when this plan runs (plan 201 not yet merged), do not touch it; plan 201 deletes it.
- **Replaced by**: `bun run typecheck` clean, and an owner smoke on the lab device added to §7: open Device Control, toggle the overlay, confirm all eight rows show numbers within 5 s, confirm `device→host` stays within ±20 ms of its own median over 60 s on a static screen, confirm `decode→paint` is below 16 ms at 30 fps.
- **§0 rows amended**: G4 and G6 are verified by the owner smoke, not by a Studio test; G5 is verified by `bun test packages/protocol/src/video-latency.test.ts`; G7 is verified by reloading the page and observing the toggle state.
- **§7 amended**: remove the five `bun test packages/studio/...` lines; add `bun test packages/protocol/src/video-latency.test.ts`. The `happydom` note (§7, "Studio test files import happydom") no longer applies.
