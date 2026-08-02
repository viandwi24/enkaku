# Cloud mode

The control plane lives on a server while the devices stay where you are. The agent opens an **outbound** connection to the control plane, so no port forwarding is needed and NAT is a non-issue.

```
phone ──USB/WiFi── Agent ──outbound tunnel (WSS)──► Control plane ◄──browser
     (office or home, behind NAT)                       (VPS)
```

## Running the control plane

```bash
ENKAKU_MODE=orchestrator ENKAKU_BIND=0.0.0.0 ENKAKU_TLS_MODE=external bun run dev
```

Orchestrator mode never touches adb — every device arrives from an agent.

## Registering an agent

1. On the control plane: `POST /api/agents` with `{ "name": "lab-jakarta" }` → this returns a **single-use token** (shown only once).
2. On the machine next to the devices:

```bash
ENKAKU_CP_URL=https://farm.example.com \
ENKAKU_ENROLL_TOKEN=<token> \
ENKAKU_DATA_DIR=/var/lib/enkaku-agent \
bun run packages/agent/src/index.ts
```

The token is exchanged for a long-lived credential stored in `<data-dir>/agent.json`. From then on the agent runs without a token.

## What works

Agent-owned devices behave exactly like local ones in Studio: they show up on the dashboard, their screens can be watched and touched, and scripts can run on them. Jobs **execute on the agent** — right next to the device, so inspector queries never cross the internet repeatedly; only logs, artifacts, and the final result travel through the tunnel.

The decisions stay in the control plane: leases, queueing, rejecting input while a device is busy. The agent only executes.

## When the tunnel drops

That agent's devices are marked offline, its sessions are cancelled, and any running job fails through the ordinary lease-expiry mechanism. Later requests get a clear error (`agent_offline`) rather than hanging. The agent reconnects on its own with a gradually increasing delay.

## Current limitation

Video travels through the WebSocket tunnel. For an agent on a healthy network that is fine, but on the internet with packet loss TCP holds the whole stream until the packet is retransmitted — the screen can freeze for a moment. The WebRTC path addresses this (see `docs/plans/13-m9-webrtc-backend.md`).
