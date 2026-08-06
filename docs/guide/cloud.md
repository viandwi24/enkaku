# Cloud mode

The control plane lives on a server while the devices stay where you are. The node opens an **outbound** connection to the control plane, so no port forwarding is needed and NAT is a non-issue.

```
phone ──USB/WiFi── Node ──outbound tunnel (WSS)──► Control plane ◄──browser
     (office or home, behind NAT)                       (VPS)
```

## Running the control plane

```bash
ENKAKU_MODE=orchestrator ENKAKU_BIND=0.0.0.0 ENKAKU_TLS_MODE=external bun run dev
```

Orchestrator mode never touches adb — every device arrives from a node.

## Registering a node

1. On the control plane: `POST /api/nodes` with `{ "name": "lab-jakarta" }` → this returns a **single-use token** (shown only once).
2. On the machine next to the devices:

```bash
ENKAKU_CP_URL=https://farm.example.com \
ENKAKU_ENROLL_TOKEN=<token> \
ENKAKU_DATA_DIR=/var/lib/enkaku-node \
bun run packages/node/src/index.ts
```

The token is exchanged for a long-lived credential stored in `<data-dir>/node.json`. From then on the node runs without a token.

## What works

Node-owned devices behave exactly like local ones in Studio: they show up on the dashboard, their screens can be watched and touched, and scripts can run on them. Jobs **execute on the node** — right next to the device, so inspector queries never cross the internet repeatedly; only logs, artifacts, and the final result travel through the tunnel.

The decisions stay in the control plane: leases, queueing, rejecting input while a device is busy. The node only executes.

## When the tunnel drops

That node's devices are marked offline, its sessions are cancelled, and any running job fails through the ordinary lease-expiry mechanism. Later requests get a clear error (`node_offline`) rather than hanging. The node reconnects on its own with a gradually increasing delay.

## Current limitation

Video travels through the WebSocket tunnel. For a node on a healthy network that is fine, but on the internet with packet loss TCP holds the whole stream until the packet is retransmitted — the screen can freeze for a moment. The WebRTC path addresses this (see `docs/plans/13-m9-webrtc-backend.md`).

## The adb endpoint on a cloud device

The same lease-scoped `adb connect` endpoint described in `docs/guide/install.md` works for a node-owned device too (plan 28, `docs/plans/28-m12g-cloud-adb-endpoint.md`). Nothing about the workflow changes: enable `shell.endpointEnabled`, hold the device's manual lease, open the endpoint from the device page, then run `adb connect <control-plane-host>:<port>` from your own machine.

The path is longer than the local case — every byte of `shell`, `logcat`, `install`, and `push`/`pull` traffic now relays through the control plane to the node and back:

```
your adb ⇄ the endpoint (control plane) ⇄ tunnel channel ⇄ node ⇄ node's adb server ⇄ device
```

Flow control survives that extra hop: the control plane's shim never tells your adb client "written" for a `push` until the node confirms the bytes actually reached its own adb server (`adb.ack`, plan 28 §3.3). That is what keeps a large `push` over a slow link from silently filling the control plane's memory — the worst case is a slow transfer, not an out-of-memory control plane.

### Measured throughput and latency

**Not yet measured in this environment.** Plan 28 step 28.5 calls for real numbers from a real node over a real link (LAN and a representative WAN/relay path), and this repository currently has no live cloud node to measure against — inventing numbers here would be worse than leaving the gap explicit. Whoever runs the first real cloud deployment should capture this before relying on the feature for anything time-sensitive, and fill in the table below.

To take the measurement, run the manual smoke test from plan 28 §7 and time each step:

```bash
bun run dev:cloud
ENKAKU_CP_URL=... bun run dev:node
# take control of the node's device, open the endpoint, then from a third
# machine (or the same host, for a same-LAN baseline):
adb connect <control-plane>:<port>

# round-trip latency: a trivial shell command, timed
time adb -s <cp:port> shell true

# logcat: does it keep up, or does it visibly lag?
adb -s <cp:port> logcat

# throughput: push and pull a large file, timed, and verify the checksum
dd if=/dev/urandom of=big.bin bs=1M count=50
time adb -s <cp:port> push big.bin /data/local/tmp/
time adb -s <cp:port> pull /data/local/tmp/big.bin out.bin
shasum big.bin out.bin   # must match

# install: a realistic APK size
time adb -s <cp:port> install ./test.apk
```

| Link | `shell true` RTT | `push` throughput | `pull` throughput | `install` (typical APK) | Notes |
|---|---|---|---|---|---|
| same LAN as the control plane | _unmeasured_ | _unmeasured_ | _unmeasured_ | _unmeasured_ | |
| representative WAN/relay | _unmeasured_ | _unmeasured_ | _unmeasured_ | _unmeasured_ | |

If the WAN numbers turn out to make `sync:` (`push`/`pull`/`install`) impractical, the honest response is to document that plainly here — not to hide it — and revisit plan 28 §9's open question about gating `sync:` behind a size warning.
