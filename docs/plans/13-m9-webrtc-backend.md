# Plan 13 — M9b : The WebRTC backend (cloud video without freezing)

> **Status:** ready to work on. **Depends on:** Plan 12 (cloud mode working) — WebRTC replaces its video path rather than adding one from scratch.
> **Spec references:** §5.3 (cloud video needs a different transport), §16 (latency and fps NFRs).

---

## 1. Goals

- Device video in cloud mode flows over **WebRTC (UDP)**, so packet loss **no longer freezes the screen**.
- Path selection is automatic and honest: WebRTC when possible, WebSocket otherwise, with a clear indicator in Studio — the user always knows which path they are on.
- Keyframes recover automatically after packet loss (the browser sends a PLI → the relay asks the device for a fresh IDR).
- LAN and local mode are **completely unchanged** — they stay on the proven, simpler WS + WebCodecs.

The closing demo: an agent and a phone behind home NAT, a control plane on a VPS, a browser on a third network. With `tc netem` simulating 3% packet loss, the WS path visibly freezes repeatedly while the WebRTC path keeps flowing.

## 2. Non-goals

- **Audio** — scrcpy supports it, but a QA farm does not need it. The `audio` channel is already reserved in the protocol.
- **Two-way video / camera** — not relevant.
- **A multi-viewer SFU** — one device, one viewer (the Plan 08 §3.7 policy) still applies.
- **Replacing the LAN path** — WS + WebCodecs stays the LAN default; adding WebRTC there only adds TURN/STUN with no benefit.

## 3. Context and design decisions

### 3.1 Why WebSocket is not enough on the internet

WebSocket runs over TCP, which guarantees **ordering**. When one packet is lost, everything after it is held in the receiver's buffer until that packet is successfully retransmitted — *head-of-line blocking*. For a file transfer that is correct; for live video it is a disaster: the screen freezes for 1–2 seconds, then jumps.

WebRTC uses UDP: a lost frame is simply lost and the stream continues. For remote control, a stale frame is worthless anyway.

On a LAN packet loss is effectively zero, so WS is perfectly fine — and far simpler (no STUN/TURN, no DTLS). That is why both exist.

### 3.2 Library decision: **werift** — already verified to run on Bun

Plan 11 flagged the library choice as an open question because Bun compatibility was unproven. **That question has now been answered with a real test** (werift 0.24.2, Bun 1.3.14, macOS arm64):

| What was tested | Result |
|---|---|
| `new RTCPeerConnection` plus `createOffer` plus `setLocalDescription` | ✅ works |
| SDP contains `m=video` with the H.264 codec | ✅ |
| A DTLS fingerprint is produced (meaning `node:crypto` is sufficient) | ✅ |
| ICE candidate gathering | ✅ 9 candidates (meaning `node:dgram`/UDP works) |
| `nack`/`pli` feedback negotiated | ✅ |
| `MediaStreamTrack.writeRtp` for raw RTP injection | ✅ available |
| `RtpPacket.serialize()` | ✅ a 12-byte header plus payload |

This matters because the two riskiest primitives — **UDP sockets** and **DTLS cryptography** — are exactly the ones proven to work.

What is **not** yet verified and must be proven in this plan: a complete DTLS handshake with a real browser, a sustained SRTP flow, and CPU use across several simultaneous streams.

### 3.3 On "Bun is Node-compatible, can it not just fall back to Node?"

A fair question, and the answer determines the backup plan.

**Bun delegates nothing to Node.** Bun **reimplements** Node's APIs (`fs`, `net`, `dgram`, `crypto`, …) in Zig inside its own runtime. Node does not need to be installed, and there is no "if it fails, run it under Node" mechanism. If Bun has not implemented an API, that code fails — there is no automatic safety net.

For **native** modules (like `node-webrtc`/`wrtc`, which wraps libwebrtc C++), Bun supports N-API but not completely — which is why a native candidate carries more risk than pure-TypeScript werift.

**But the idea still works — as an explicit sidecar.** If werift turns out to fail at the DTLS/SRTP stage with a real browser, the video relay runs as a **separate process under Node**, with the core (Bun) talking to it over a unix socket. The architecture is exactly the shape of the GStreamer backup already in Plan 11, only the contents differ. What makes it cheap: `RtcPeerFactory` is already an interface, so swapping the implementation never touches the relay code.

The plan order:

| Order | Approach | When it is used |
|---|---|---|
| 1 | werift in-process (Bun) | The default — already proven through SDP and ICE |
| 2 | werift as a Node sidecar | If DTLS/SRTP fails specifically on Bun |
| 3 | A GStreamer `webrtcbin` sidecar | If werift is not strong enough for many streams |

### 3.4 What is already done and need not be redone

The library-independent parts exist and their logic is verified:

- Splitting Annex-B into NAL units.
- FU-A fragmentation for large NALs (tested: 3000 bytes → packets ≤ 1200 bytes with correct S/E bits).
- Automatic SPS/PPS insertion before every IDR.
- Timestamp conversion to the 90 kHz clock (1 second → 90000).
- The marker bit only on the last packet of each access unit.
- Signalling messages, the ICE configuration endpoint, and the Studio client with fallback.

This plan connects that packetizer's output to a real WebRTC peer.

### 3.5 STUN and TURN

STUN alone is enough for most home NATs. For symmetric NAT and office networks that block UDP, **TURN is mandatory** — without it the connection fails and the user drops to WS.

Decision: **self-hosted coturn** as a container alongside the control plane, with time-limited credentials (not static credentials that leak forever). That fits the self-hosted principle of spec §5.3.

## 4. Technical design

### 4.1 File structure

```
packages/core/src/relay/
  rtp-h264.ts              # EXISTS — the packetizer (unchanged)
  rtc-peer.ts              # EXISTS — the RtcPeer interface (unchanged)
  werift-peer.ts           # NEW — an RtcPeerFactory implementation using werift
  webrtc-relay.ts          # NEW — orchestration: frame source → packetizer → peer
  ice-credentials.ts       # NEW — time-limited TURN credentials
  sidecar/                 # NEW (only if plan 2 is used)
    protocol.ts            # unix-socket messages between core and sidecar
    server.mjs             # the Node relay running separately
deploy/
  coturn/turnserver.conf   # NEW — TURN configuration
  docker-compose.cloud.yml # NEW — control plane plus coturn
packages/studio/src/lib/
  webrtc-player.ts         # EXISTS — add a path indicator and statistics
```

### 4.2 Peer implementation

```ts
// packages/core/src/relay/werift-peer.ts
export function createWeriftFactory(): RtcPeerFactory {
  return {
    available: true,
    async create({ iceServers }) {
      const pc = new RTCPeerConnection({
        iceServers,
        codecs: { video: [ /* H.264 packetization-mode=1, nack + pli feedback */ ] },
      })
      const track = new MediaStreamTrack({ kind: 'video' })
      pc.addTransceiver(track, { direction: 'sendonly' })
      let seq = 0
      return {
        // Packets from our packetizer are wrapped in an RtpPacket and written to the track.
        sendRtp: (p) => track.writeRtp(new RtpPacket(
          new RtpHeader({ payloadType: 96, sequenceNumber: seq++ & 0xffff,
                          timestamp: p.timestamp, marker: p.marker, ssrc }),
          Buffer.from(p.payload))),
        onKeyframeRequest: (cb) => { /* RTCP PLI/NACK from the browser */ },
        // createOffer / setRemoteAnswer / addIceCandidate / onIceCandidate / close
      }
    },
  }
}
```

The RTP sequence number lives in the relay (not the packetizer) because one peer has one sequence-number space.

### 4.3 Relay flow

```
agent → the tunnel's video channel (H.264 Annex-B)
  → WebRtcRelay.push(chunk, ptsUs)
      → createH264Packetizer().push()   # already exists, tested
      → peer.sendRtp(packet)            # werift → SRTP/UDP → browser
browser <video>  ← ontrack

The browser loses frames → RTCP PLI
  → peer.onKeyframeRequest()
  → the relay asks for an IDR: a scrcpy control message to the agent
     (TODO-verify the exact mechanism in scrcpy 3.3.1; fallback: restart the stream)
```

### 4.4 Path selection in Studio

```
start → local/LAN mode?  ─yes→  WS + WebCodecs (done, nothing changes)
                          └no→  request WebRTC
                                  ├ success → "WebRTC" badge
                                  └ failure → WS + WebCodecs, "degraded" badge plus the reason
```

Fallback triggers: `video.webrtc.failed` from the server, an ICE state of `failed`, or no frames for 10 seconds. All of them are already implemented in the client; this plan adds a **visible path indicator** so nobody has to guess why the video is stuttering.

### 4.5 Time-limited TURN credentials

```ts
// username = "<expiry-unix>:<userId>", password = base64(HMAC-SHA1(secret, username))
```

Valid for 12 hours. A leaked credential is only useful until it expires, and it never exposes the server's secret.

## 5. Implementation steps

### Stage 1 — The werift peer and end-to-end proof

- [ ] Add `werift` as a core dependency; write `werift-peer.ts` (§4.2).
- [ ] Test the backbone: server peer ↔ a real browser, sending RTP from a synthetic test pattern (not a device), and confirm `<video>` shows a picture.
- **Verification:** this is the **decision gate**. If DTLS/SRTP fails on Bun, stop and move to Stage 1b before writing any other code.

### Stage 1b — (conditional) the Node sidecar

- [ ] Only if Stage 1 fails: move `werift-peer.ts` into a separate Node process, communicating over a unix socket (`sidecar/protocol.ts`).
- [ ] The sidecar is managed by the Toolchain Manager as an optional tool (the same pattern as every other tool).
- **Verification:** the end result is identical from the core's point of view — `RtcPeerFactory` does not change.

### Stage 2 — Relay and signalling

- [ ] `webrtc-relay.ts`: connect the tunnel's video channel → packetizer → `peer.sendRtp`.
- [ ] Signalling handlers in the control plane: `video.webrtc.request` → create a peer → send the offer; receive the answer and ICE candidates.
- [ ] `video.webrtc.failed` for every failure (including when `RtcPeerFactory.available === false`).
- **Verification:** an agent device's video appears in the browser over WebRTC.

### Stage 3 — Keyframe recovery

- [ ] Translate RTCP PLI into an IDR request to the device through the tunnel.
- [ ] Verify the IDR request mechanism in scrcpy 3.3.1; if there is none, restart the stream instead (and note that in the code).
- **Verification:** deliberately drop packets with `tc netem` at 5%; the picture recovers on its own within 2 seconds and does not stay stuck.

### Stage 4 — TURN and deployment

- [ ] `deploy/coturn/turnserver.conf` plus `docker-compose.cloud.yml`.
- [ ] `ice-credentials.ts` (§4.5); `GET /api/agents/ice-config` returns time-limited credentials.
- **Verification:** a browser on a network that blocks direct UDP (only TCP/443) still connects through TURN.

### Stage 5 — Indicators and statistics in Studio

- [ ] A path badge: `WebRTC` / `WS (degraded)` plus the fallback reason.
- [ ] A statistics panel: fps, bitrate, packet loss, RTT (from `getStats()`).
- **Verification:** when the network is disrupted, the numbers in the panel change to match reality.

### Stage 6 — NFR measurement

- [ ] Measure glass-to-glass and fps under three conditions: LAN, clean internet, internet with 3% loss.
- [ ] Compare WS against WebRTC under the third condition — this is the evidence for the spec §5.3 claim.
- **Verification:** the numbers are recorded in `docs/benchmarks/webrtc.md`.

## 6. Acceptance criteria

1. [ ] An agent device's video appears over WebRTC in a Chromium browser.
2. [ ] At 3% packet loss, WebRTC keeps flowing while WS demonstrably freezes — with comparative numbers.
3. [ ] A lost keyframe recovers automatically in under 2 seconds.
4. [ ] A network without direct UDP still connects through TURN.
5. [ ] Every failure falls back to WS **with a reason the user can see** — never a black screen with no explanation.
6. [ ] LAN and local mode are completely unchanged (retested).
7. [ ] Control plane CPU use for 5 simultaneous streams is recorded.
8. [ ] `RtcPeerFactory` remains the only place the library is touched — swapping the backend does not touch the relay.

## 7. Test plan

**Without a real network:** the packetizer already has test cases (Annex-B, FU-A, SPS/PPS, timestamps). Add: RTP sequence numbers wrapping at 65535, and a PLI triggering an IDR request.

**With a browser, one machine:** the server peer plus local Chrome, fed by a synthetic test pattern. This proves DTLS/SRTP without device variables.

**End to end:** device → agent → control plane → browser, across three different networks.

**Controlled degradation:** `tc netem` at 1%/3%/5% loss and 50/150 ms delay; record fps, freezes, and RTT for WS and WebRTC side by side.

**Deliberate failures:** stop coturn mid-session; block UDP on the client; stop the agent mid-stream.

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| werift DTLS/SRTP fails specifically on Bun | The main plan collapses | A decision gate in Stage 1 before other code is written; the Node sidecar is already designed |
| High CPU across many streams | The control plane becomes the bottleneck | Measure early; a separate SFU or relay if needed (out of scope, but the design does not block it) |
| Wrong RTP sequence numbers or timestamps | Choppy video with no clear error | Unit tests plus browser `getStats()` as a cross-check |
| TURN operations (ports, bandwidth) | Cost and complexity | Document it; TURN is only used when the direct path fails |
| scrcpy has no explicit IDR request | Slow keyframe recovery | Fall back to restarting the stream, documented as a limitation |

## 9. Open questions

1. **The Node sidecar, if needed**: managed by the Toolchain Manager, or treated as a system prerequisite?
2. **Multi-viewer** becomes relevant again with WebRTC (an SFU) — still deferred, or opened now?
3. **The fallback threshold**: 10 seconds without frames feels long; would 5 seconds be better?
4. **Session recording** (spec §22) is cheaper on the RTP path — include it now?
5. **Codec**: scrcpy supports the more efficient H.265 and AV1, but their WebCodecs and WebRTC support is uneven. Stay on H.264 only?
