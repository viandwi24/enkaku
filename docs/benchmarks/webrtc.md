# WebRTC measurement notes

## Compatibility verification (done)

Tested on Bun 1.3.14, macOS arm64, werift 0.24.2:

| What was tested | Result |
|---|---|
| `RTCPeerConnection` plus `createOffer` plus `setLocalDescription` | ✅ |
| SDP: `m=video`, H.264, `packetization-mode=1`, `a=sendonly` | ✅ |
| DTLS fingerprint (runtime cryptography is sufficient) | ✅ |
| ICE candidate gathering, including server-reflexive via STUN | ✅ 9+ candidates |
| `nack` / `pli` feedback negotiated | ✅ |
| Raw RTP injection (`track.writeRtp`) | ✅ |
| H.264 packetizer → peer, one 4 KB access unit | ✅ 6 packets, no errors |
| End-to-end signalling through the control plane's WS | ✅ offer plus trickle ICE reach the client |

**Conclusion:** the Node sidecar backup plan is **not needed**. Bun runs werift directly.

## Not measured yet

These need real devices and a real network:

- [ ] A complete DTLS handshake with a browser (test through to `<video>` showing a picture)
- [ ] Glass-to-glass on a LAN, on clean internet, and on internet with 3% packet loss
- [ ] WS versus WebRTC under packet loss — this is the evidence for the spec §5.3 claim
- [ ] Keyframe recovery after packet loss (PLI → IDR)
- [ ] Control plane CPU use for 5 simultaneous streams
- [ ] Connecting through TURN from a network that blocks direct UDP

Procedure: `tc netem` to simulate packet loss, and a stopwatch on the device screen photographed alongside the browser screen for glass-to-glass.
