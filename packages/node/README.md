# @enkaku/node

The mini-core for **cloud mode** (spec §5.3): a lightweight node runs next to the devices and opens an **outbound WebSocket tunnel** to the control plane. Because the connection is outbound, no port forwarding is needed and NAT is a non-issue.

Renamed from `@enkaku/agent` in plan 61 — the word "agent" is reserved for the AI feature starting in plan 63; the cloud tunnel process is a **node** everywhere: package, table, routes, wire protocol, UI, docs.

## Implementation status

| Sub-phase | Contents | Status |
|---|---|---|
| **M8a** | State plus enrollment token, outbound tunnel (auth, keepalive, full-jitter backoff), multi-device binary frames, device reporting from `track-devices`; on the control plane side: node registry, router, `orchestrator` mode | ✅ |
| **M8b** | WebRTC signalling (protocol plus a Studio client with automatic fallback), H.264 → RTP packetizer (RFC 6184), ICE configuration | ⚠️ partial — the server-side WebRTC backend is not chosen yet |
| **M8c** | `IsolationProvider`: child-process (local) and container (`--network=none`, cap-drop, optional gVisor via `--runtime=runsc`); a `tenantId` column on devices and nodes | ✅ |
| **M8d** | Opt-in Appium engine, `scrcpy-aoa` (registered but `available: false`), redroid over the `adb-tcp` transport | ✅ |

The `session.start`, `session.stop`, and `job.dispatch` messages are defined in the protocol and accepted by the tunnel, but their node-side handlers are deliberately not implemented yet — they are logged rather than failing silently.

## What is left in M8b

`RtcPeerFactory` (in `packages/core/src/relay/rtc-peer.ts`) is deliberately left `available: false` until a server-side WebRTC backend is chosen. The plan recommends **werift** (pure TypeScript, in keeping with the self-contained principle), with a GStreamer sidecar as the backup if Bun verification fails. Until a backend exists the control plane answers `video.webrtc.failed` and Studio automatically uses WS + WebCodecs — workable, but prone to freezing over the internet.

The library-independent parts are finished and testable on their own: Annex-B splitting, FU-A fragmentation, SPS/PPS insertion before IDR, and timestamp conversion to the 90 kHz clock.

## Running it

```bash
ENKAKU_CP_URL=https://farm.example.com \
ENKAKU_ENROLL_TOKEN=<single-use token from Studio> \
ENKAKU_DATA_DIR=/var/lib/enkaku-node \
bun run packages/node/src/index.ts
```

The token is needed only once: the result (a `nodeId` plus a long-lived credential) is stored in `<data-dir>/node.json`. After that the node runs without a token. (Plan 61's one-release `agent.json` adoption was removed per the dated follow-up in `docs/plans/00-overview.md` §9 — a data directory that never saw a post-plan-61 node during that window now needs `ENKAKU_ENROLL_TOKEN` again.)

## Why video needs WebRTC in the cloud

The WebSocket tunnel runs over TCP. On the open internet a single lost packet makes TCP hold up the entire stream until it is retransmitted (head-of-line blocking) — during real-time remote control that shows up as frozen video. So the cloud video path is planned to move to WebRTC (UDP, congestion control, partial reliability) while control and queueing stay on WebSocket. On a LAN, WS + WebCodecs remains the choice because it is simpler and needs no STUN/TURN.
